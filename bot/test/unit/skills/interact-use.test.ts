// UseSkill (skills/interact/use.ts) and the measured door shapes (skills/interact/shapes.ts), PLAN.md
// task 7.3, against a fake world, loop and server: kinds and states (the door's state in its lower
// half), want open / closed / toggle, refusals without a click, the click transaction, verdicts.
import { describe, expect, it } from 'vitest';
import { doorBoxes, doorEdge, doorPassable, edgeBox } from '../../../src/skills/interact/shapes.ts';
import { handUsable, openState, stateHolder, usableKind, UseSkill } from '../../../src/skills/interact/use.ts';
import { blockInfoOf } from '../../../src/skills/terrain/shapes.ts';
import { Inventory } from '../../../src/world/inventory.ts';
import type { BlockInfo, Vec3 } from '../../../src/world/types.ts';

const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;
const AIR = blockInfoOf('air');
const door = (open: 0 | 1, upper: 0 | 1, dir = 'west', hinge: 0 | 1 = 0) =>
  blockInfoOf('wooden_door', { open_bit: open, upper_block_bit: upper, 'minecraft:cardinal_direction': dir, door_hinge_bit: hinge });

/** A door at (2, 0, 0) / (2, 1, 0), a trapdoor, a gate, a button and a lever; a server that toggles. */
function setup() {
  const blocks = new Map<string, BlockInfo>();
  blocks.set('2,0,0', door(0, 0));
  blocks.set('2,1,0', door(0, 1));
  blocks.set('-2,0,0', blockInfoOf('trapdoor'));
  blocks.set('0,0,2', blockInfoOf('fence_gate'));
  blocks.set('0,0,-2', blockInfoOf('wooden_button'));
  blocks.set('1,0,-2', blockInfoOf('lever'));
  blocks.set('-2,0,2', blockInfoOf('iron_door'));
  blocks.set('0,-1,0', blockInfoOf('stone'));
  const at = (p: Vec3) => blocks.get(key(p)) ?? AIR;
  const listeners = new Set<(p: Vec3, b: BlockInfo | undefined, a: BlockInfo) => void>();
  const update = (p: Vec3, after: BlockInfo) => {
    const before = at(p);
    blocks.set(key(p), after);
    for (const fn of [...listeners]) fn(p, before, after);
  };
  const state = { pos: { x: 0.5, y: 0, z: 0.5 }, tick: 0n, ready: true };
  const pending: (() => void)[] = [];
  const server = { mode: 'toggle' as 'toggle' | 'restore' | 'silent' };
  const loop = {
    state,
    setCommand: () => undefined,
    async waitTicks(n: number) {
      for (let i = 0; i < n; i++) {
        state.tick++;
        for (const f of pending.splice(0)) f();
        await Promise.resolve();
      }
    },
  };
  const sent: { name: string; params: Record<string, unknown> }[] = [];
  const source = {
    queue(name: string, params: object) {
      sent.push({ name, params: params as Record<string, unknown> });
      const d = (params as { transaction: { transaction_data: { block_position: Vec3 } } }).transaction.transaction_data;
      const p = d.block_position;
      const b = at(p);
      const holder = stateHolder(p, b);
      const h = at(holder);
      if (server.mode === 'silent') return;
      if (server.mode === 'restore') {
        pending.push(() => update(holder, h));
        return;
      }
      const kind = usableKind(h.name)!;
      const s = { ...h.states } as Record<string, unknown>;
      if (kind === 'button') s.button_pressed_bit = 1;
      else s.open_bit = s.open_bit ? 0 : 1;
      pending.push(() => update(holder, blockInfoOf(h.name, s)));
    },
  };
  const inv = new Inventory(() => null, () => 1n);
  const skill = new UseSkill({
    source,
    loop,
    world: { blockAt: at, onBlockUpdate: (fn) => (listeners.add(fn), () => listeners.delete(fn)), chunks: { runtimeIdAt: () => 555 }, inventory: inv },
  });
  return { skill, blocks, sent, server, state };
}

describe('usable blocks', () => {
  it('kinds, hand use, state holder and open state', () => {
    expect(usableKind('wooden_door')).toBe('door');
    expect(usableKind('spruce_door')).toBe('door');
    expect(usableKind('trapdoor')).toBe('trapdoor');
    expect(usableKind('birch_trapdoor')).toBe('trapdoor');
    expect(usableKind('fence_gate')).toBe('fence_gate');
    expect(usableKind('acacia_fence_gate')).toBe('fence_gate');
    expect(usableKind('wooden_button')).toBe('button');
    expect(usableKind('stone_button')).toBe('button');
    expect(usableKind('lever')).toBe('lever');
    expect(usableKind('stone')).toBeUndefined();
    expect(handUsable('iron_door')).toBe(false);
    expect(handUsable('iron_trapdoor')).toBe(false);
    expect(handUsable('wooden_door')).toBe(true);
    expect(stateHolder({ x: 2, y: 1, z: 0 }, door(0, 1))).toEqual({ x: 2, y: 0, z: 0 });
    expect(stateHolder({ x: 2, y: 0, z: 0 }, door(0, 0))).toEqual({ x: 2, y: 0, z: 0 });
    expect(openState(door(1, 0))).toBe(true);
    expect(openState(blockInfoOf('wooden_button', { button_pressed_bit: 1 }))).toBe(true);
    expect(openState(blockInfoOf('lever'))).toBe(false);
    expect(openState(blockInfoOf('stone'))).toBeUndefined();
  });
});

describe('UseSkill', () => {
  it('opens a door (click on the block, face seen from the eye), then closes it via the upper half', async () => {
    const e = setup();
    expect(e.skill.isOpen({ x: 2, y: 1, z: 0 })).toBe(false);
    const o = await e.skill.useBlock({ x: 2, y: 0, z: 0 }, { want: 'open' });
    expect(o).toMatchObject({ ok: true, kind: 'door', open: true, changed: true, face: 'west', clickTicks: 1 });
    expect(e.skill.isOpen({ x: 2, y: 0, z: 0 })).toBe(true);
    expect(e.skill.isOpen({ x: 2, y: 1, z: 0 })).toBe(true); // read from the lower half
    const td = (e.sent[0]!.params.transaction as { transaction_data: Record<string, unknown> }).transaction_data;
    expect(td).toMatchObject({ action_type: 'click_block', block_position: { x: 2, y: 0, z: 0 }, face: 4, block_runtime_id: 555, click_pos: { x: 0, y: 0.5, z: 0.5 } });
    // already open: no click
    expect(await e.skill.useBlock({ x: 2, y: 1, z: 0 }, { want: 'open' })).toMatchObject({ ok: true, changed: false, open: true });
    expect(e.sent.length).toBe(1);
    const c = await e.skill.useBlock({ x: 2, y: 1, z: 0 }, { want: 'closed' });
    expect(c).toMatchObject({ ok: true, open: false, changed: true });
    expect(e.sent.length).toBe(2);
    expect((e.sent[1]!.params.transaction as { transaction_data: { block_position: Vec3 } }).transaction_data.block_position).toEqual({ x: 2, y: 1, z: 0 });
  });

  it('toggles trapdoors, gates and levers; presses buttons once', async () => {
    const e = setup();
    expect(await e.skill.useBlock({ x: -2, y: 0, z: 0 })).toMatchObject({ ok: true, kind: 'trapdoor', open: true });
    expect(await e.skill.useBlock({ x: -2, y: 0, z: 0 })).toMatchObject({ ok: true, open: false });
    expect(await e.skill.useBlock({ x: 0, y: 0, z: 2 }, { want: 'open' })).toMatchObject({ ok: true, kind: 'fence_gate', open: true });
    expect(await e.skill.useBlock({ x: 1, y: 0, z: -2 })).toMatchObject({ ok: true, kind: 'lever', open: true });
    expect(await e.skill.useBlock({ x: 0, y: 0, z: -2 })).toMatchObject({ ok: true, kind: 'button', open: true });
    expect(await e.skill.useBlock({ x: 0, y: 0, z: -2 })).toMatchObject({ ok: false, reason: 'already_pressed' });
    expect(e.sent.length).toBe(5);
  });

  it('refuses without a click: open/closed on buttons and levers, iron doors, other blocks, out of reach', async () => {
    const e = setup();
    expect(await e.skill.useBlock({ x: 1, y: 0, z: -2 }, { want: 'open' })).toMatchObject({ ok: false, reason: 'toggle_only' });
    expect(await e.skill.useBlock({ x: 0, y: 0, z: -2 }, { want: 'closed' })).toMatchObject({ ok: false, reason: 'toggle_only' });
    expect(await e.skill.useBlock({ x: -2, y: 0, z: 2 })).toMatchObject({ ok: false, reason: 'not_usable' });
    expect(await e.skill.useBlock({ x: 0, y: -1, z: 0 })).toMatchObject({ ok: false, reason: 'not_usable' });
    expect(await e.skill.useBlock({ x: 0, y: 5, z: 40 })).toMatchObject({ ok: false, reason: 'not_usable' }); // air
    e.state.pos = { x: 9.5, y: 0, z: 0.5 };
    expect(await e.skill.useBlock({ x: 2, y: 0, z: 0 })).toMatchObject({ ok: false, reason: 'out_of_reach' });
    expect(e.sent.length).toBe(0);
  });

  it('rejected when the server resends the unchanged state, timeout when it says nothing', async () => {
    const e = setup();
    e.server.mode = 'restore';
    expect(await e.skill.useBlock({ x: 2, y: 0, z: 0 })).toMatchObject({ ok: false, reason: 'rejected', restores: 1, open: false });
    e.server.mode = 'silent';
    expect(await e.skill.useBlock({ x: 2, y: 0, z: 0 }, { timeoutTicks: 3 })).toMatchObject({ ok: false, reason: 'timeout' });
  });
});

describe('door shapes (measured on BDS 1.26.60)', () => {
  it('closed: the edge clockwise of the cardinal direction; open: opposite (hinge 0) or the same (hinge 1)', () => {
    const s = (dir: string, open: number, hinge = 0) => ({ 'minecraft:cardinal_direction': dir, open_bit: open, door_hinge_bit: hinge, upper_block_bit: 0 });
    expect(['north', 'east', 'south', 'west'].map((d) => doorEdge(s(d, 0)))).toEqual(['east', 'south', 'west', 'north']);
    expect(['north', 'east', 'south', 'west'].map((d) => doorEdge(s(d, 1)))).toEqual(['south', 'west', 'north', 'east']);
    expect(['north', 'east'].map((d) => doorEdge(s(d, 1, 1)))).toEqual(['north', 'east']);
    expect(doorPassable(s('west', 0), 'z')).toBe(false); // the e2e room door, closed
    expect(doorPassable(s('west', 1), 'z')).toBe(true); // ... open
    expect(edgeBox('south')).toEqual([0, 0, 0.8175, 1, 1, 1]);
  });

  it('the upper half takes the lower half state', () => {
    expect(doorBoxes(door(1, 1, 'west'), door(1, 0, 'west'))).toEqual([edgeBox('east')]);
    expect(doorBoxes(door(0, 1, 'west'), door(1, 0, 'west'))).toEqual([edgeBox('east')]);
    expect(doorBoxes(door(0, 1, 'west'))).toEqual([edgeBox('north')]);
    expect(doorBoxes(blockInfoOf('stone'))).toBeUndefined();
  });
});
