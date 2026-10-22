// PlaceSkill (skills/place/place.ts) and the face helpers (skills/place/face.ts), PLAN.md task 7.3,
// against a fake world, loop and server: face choice, refusals without a click, the exact click
// transaction (serialised with the real 1.26.60 serializer), accepted / rejected / timeout verdicts,
// the movement-model prediction, pillar-up (jump, click above the cell, land on the block), fetching
// an item from the main inventory with the inventory screen open, cancel.
import { describe, expect, it } from 'vitest';
import { createDeserializer, createSerializer } from '../../../src/connection/protocol.ts';
import type { BlockQuery } from '../../../src/skills/input/types.ts';
import {
  BLOCK_FACES,
  faceCenter,
  faceIndex,
  faceOf,
  faceOffset,
  facePoint,
  faceVisibleFrom,
  neighbour,
  oppositeFace,
  supportOf,
} from '../../../src/skills/place/face.ts';
import { cellInBody, cornerDistance, isInteractive, PlaceSkill, predictBlock, wireItemOf, type PlaceDeps } from '../../../src/skills/place/place.ts';
import { blockInfoOf } from '../../../src/skills/terrain/shapes.ts';
import { Inventory } from '../../../src/world/inventory.ts';
import type { ItemV4 } from '../../../src/world/packets.ts';
import type { BlockInfo, ItemStack, Vec3 } from '../../../src/world/types.ts';

const ITEMS: Record<number, { name: string; brid: number }> = { 4: { name: 'cobblestone', brid: 77 }, 3: { name: 'dirt', brid: 33 }, 280: { name: 'stick', brid: 0 } };
const toItem = (i: ItemV4): ItemStack | null =>
  i.network_id === 0
    ? null
    : {
        name: ITEMS[i.network_id]?.name ?? `unknown:${i.network_id}`,
        networkId: i.network_id,
        count: i.count,
        metadata: i.metadata,
        ...(i.stack_id !== undefined ? { stackId: i.stack_id } : {}),
        blockRuntimeId: i.block_runtime_id ?? 0,
      };
const v4 = (id: number, count: number, stackId: number): ItemV4 => ({ network_id: id, count, metadata: 0, has_stack_id: true, stack_id: stackId, block_runtime_id: ITEMS[id]?.brid ?? 0 });
const EMPTY: ItemV4 = { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0 };

const AIR = blockInfoOf('air');
const STONE = blockInfoOf('stone');
const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;

interface Env {
  skill: PlaceSkill;
  sent: { name: string; params: Record<string, unknown> }[];
  blocks: Map<string, BlockInfo>;
  inv: Inventory;
  loop: FakeLoop;
  server: { accept: boolean; delay: number; silent: boolean };
  selected: number[];
}

/** Minimal loop: 20 Hz ticks driven by waitTicks, a vertical jump model on top of `world`. */
class FakeLoop {
  state = { pos: { x: 0.5, y: 0, z: 0.5 }, vel: { x: 0, y: 0, z: 0 }, onGround: true, tick: 0n, ready: true };
  command = { yaw: 0, pitch: 0, jump: false };
  world: BlockQuery;
  onTick: (() => void)[] = [];
  /** World y of the feet at each tick, for the pillar test. */
  trace: { tick: bigint; y: number }[] = [];
  constructor(world: BlockQuery) {
    this.world = world;
  }
  setCommand(c: { yaw?: number; pitch?: number; jump?: boolean }): void {
    this.command = { ...this.command, ...c };
  }
  async waitTicks(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      this.step();
      for (const f of [...this.onTick]) f();
      await Promise.resolve();
    }
  }
  private step(): void {
    const s = this.state;
    if (s.onGround && this.command.jump) {
      s.vel.y = 0.42;
      s.onGround = false;
    } else if (!s.onGround) {
      s.vel.y = (s.vel.y - 0.08) * 0.98;
    }
    if (!s.onGround) {
      let y = s.pos.y + s.vel.y;
      const below = Math.floor(y);
      if (s.vel.y < 0 && this.world.solidAt(Math.floor(s.pos.x), below, Math.floor(s.pos.z)) && y < below + 1) {
        y = below + 1;
        s.onGround = true;
        s.vel.y = 0;
      }
      s.pos.y = y;
    }
    s.tick++;
    this.trace.push({ tick: s.tick, y: s.pos.y });
  }
}

function setup(slots: (ItemV4 | undefined)[] = [v4(4, 10, 1)], opts: { containers?: boolean } = {}): Env {
  const blocks = new Map<string, BlockInfo>();
  // floor at y = -1 for x, z in -8..8
  for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) blocks.set(key({ x, y: -1, z }), STONE);
  const at = (p: Vec3) => blocks.get(key(p)) ?? AIR;
  const listeners = new Set<(p: Vec3, b: BlockInfo | undefined, a: BlockInfo) => void>();
  const update = (p: Vec3, after: BlockInfo) => {
    const before = at(p);
    blocks.set(key(p), after);
    for (const fn of [...listeners]) fn(p, before, after);
  };
  const query: BlockQuery = { solidAt: (x, y, z) => at({ x, y, z }).boxes.length > 0 };
  const loop = new FakeLoop(query);
  const inv = new Inventory(toItem, () => 1n);
  inv.handleInventoryContent({ window_id: 'inventory', input: Array.from({ length: 36 }, (_, i) => slots[i] ?? EMPTY) });
  const sent: Env['sent'] = [];
  const server = { accept: true, delay: 2, silent: false };
  const selected: number[] = [];
  const pending: { due: bigint; fn: () => void }[] = [];
  loop.onTick.push(() => {
    for (const p of pending.splice(0)) {
      if (p.due <= loop.state.tick) p.fn();
      else pending.push(p);
    }
  });
  const openFns = new Set<(c: { id: number; type: string }) => void>();
  const closeFns = new Set<(id: number, byServer: boolean) => void>();
  const containers = {
    open: undefined as { id: number; type: string } | undefined,
    move: (src: { window: number; slot: number }, dst: { window: number; slot: number }, count: number) => {
      sent.push({ name: 'move', params: { src, dst, count, inventoryOpen: containers.open?.type === 'inventory' } });
      if (containers.open?.type !== 'inventory') return Promise.resolve({ ok: false, reason: 'error' });
      const item = inv.slots[src.slot]!;
      inv.setItem(0, src.slot, null);
      inv.setItem(0, dst.slot, { ...item, count, stackId: 99 });
      return Promise.resolve({ ok: true });
    },
    onOpen: (fn: (c: { id: number; type: string }) => void) => {
      openFns.add(fn);
      return () => openFns.delete(fn);
    },
    onClose: (fn: (id: number, byServer: boolean) => void) => {
      closeFns.add(fn);
      return () => closeFns.delete(fn);
    },
    close: (id: number) => {
      sent.push({ name: 'container_close', params: { window_id: id } });
      pending.push({
        due: loop.state.tick + 1n,
        fn: () => {
          containers.open = undefined;
          for (const f of [...closeFns]) f(id, false);
        },
      });
    },
  };
  const source = {
    queue(name: string, params: object) {
      const p = params as Record<string, unknown>;
      sent.push({ name, params: p });
      if (name === 'interact') {
        pending.push({
          due: loop.state.tick + 2n,
          fn: () => {
            containers.open = { id: 2, type: 'inventory' };
            for (const f of [...openFns]) f(containers.open);
          },
        });
      }
      if (name !== 'inventory_transaction' || server.silent) return;
      const d = (p.transaction as { transaction_data: { block_position: Vec3; face: number; held_item: ItemV4 } }).transaction_data;
      const target = neighbour(d.block_position, faceOf(d.face)!);
      const accept = server.accept && !cellInBody(target, loop.state.pos);
      pending.push({
        due: loop.state.tick + BigInt(server.delay),
        fn: () => update(target, accept ? blockInfoOf(ITEMS[d.held_item.network_id]?.name ?? 'stone') : at(target)),
      });
    },
  };
  const hotbar = {
    select: (slot: number) => {
      selected.push(slot);
      inv.select(slot);
      return true;
    },
    rawItem: (slot: number) => inv.rawItem(0, slot),
    noteRaw: () => undefined,
  };
  const deps: PlaceDeps = {
    source,
    loop,
    world: { blockAt: at, onBlockUpdate: (fn) => (listeners.add(fn), () => listeners.delete(fn)), chunks: { runtimeIdAt: (x, y, z) => (at({ x, y, z }).name === 'stone' ? 1234 : 0) }, inventory: inv },
    hotbar,
    ...(opts.containers === false ? {} : { containers }),
    runtimeId: () => 7n,
  };
  return { skill: new PlaceSkill(deps), sent, blocks, inv, loop, server, selected };
}

const clicks = (e: Env) => e.sent.filter((s) => s.name === 'inventory_transaction');
const data = (s: { params: Record<string, unknown> }) => (s.params.transaction as { transaction_data: Record<string, unknown> }).transaction_data;

describe('face helpers', () => {
  it('numbers, offsets, opposites and supports', () => {
    expect(BLOCK_FACES.map(faceIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(BLOCK_FACES.map((f) => faceOf(faceIndex(f)))).toEqual(BLOCK_FACES);
    expect(faceOf(6)).toBeUndefined();
    expect(faceOffset('north')).toEqual({ x: 0, y: 0, z: -1 });
    expect(faceOffset('east')).toEqual({ x: 1, y: 0, z: 0 });
    for (const f of BLOCK_FACES) {
      expect(oppositeFace(oppositeFace(f))).toBe(f);
      const p = { x: 3, y: -60, z: -7 };
      // clicking face f of supportOf(p, f) puts the block at p
      expect(neighbour(supportOf(p, f), f)).toEqual(p);
    }
    expect(supportOf({ x: 1, y: 5, z: 1 }, 'up')).toEqual({ x: 1, y: 4, z: 1 });
    expect(faceCenter('west')).toEqual({ x: 0, y: 0.5, z: 0.5 });
    expect(facePoint({ x: 2, y: 3, z: 4 }, 'up')).toEqual({ x: 2.5, y: 4, z: 4.5 });
  });

  it('a face is visible when the eye is on its outer side', () => {
    const s = { x: 0, y: 0, z: 0 };
    expect(faceVisibleFrom({ x: 0.5, y: 2.6, z: 0.5 }, s, 'up')).toBe(true);
    expect(faceVisibleFrom({ x: 0.5, y: 0.6, z: 0.5 }, s, 'up')).toBe(false);
    expect(faceVisibleFrom({ x: 2, y: 0.5, z: 0.5 }, s, 'east')).toBe(true);
    expect(faceVisibleFrom({ x: 0.5, y: 1.6, z: 0.5 }, s, 'east')).toBe(false); // standing on it
    expect(faceVisibleFrom({ x: 0.5, y: 0.5, z: -1 }, s, 'north')).toBe(true);
  });

  it('body overlap and the interactive-block list', () => {
    const feet = { x: 0.5, y: 0, z: 0.5 };
    expect(cellInBody({ x: 0, y: 0, z: 0 }, feet)).toBe(true);
    expect(cellInBody({ x: 0, y: 1, z: 0 }, feet)).toBe(true);
    expect(cellInBody({ x: 0, y: 2, z: 0 }, feet)).toBe(false);
    expect(cellInBody({ x: 1, y: 0, z: 0 }, feet)).toBe(false);
    expect(cellInBody({ x: 1, y: 0, z: 0 }, { x: 0.85, y: 0, z: 0.5 })).toBe(true);
    expect(cellInBody({ x: 0, y: -1, z: 0 }, feet)).toBe(false);
    for (const n of ['wooden_door', 'spruce_door', 'chest', 'fence_gate', 'birch_fence_gate', 'trapdoor', 'stone_button', 'lever', 'crafting_table', 'barrel', 'red_bed']) expect(isInteractive(n), n).toBe(true);
    for (const n of ['stone', 'dirt', 'oak_planks', 'oak_log', 'glass']) expect(isInteractive(n), n).toBe(false);
  });
});

describe('PlaceSkill', () => {
  it('places on the floor: chooses the top face, sends the click, resolves on the block update', async () => {
    const e = setup();
    const r = await e.skill.place({ x: 2, y: 0, z: 0 });
    expect(r).toMatchObject({ ok: true, block: 'cobblestone', face: 'up', support: { x: 2, y: -1, z: 0 }, slot: 0, item: 'cobblestone' });
    expect(r.clickTicks).toBe(2);
    expect(r.ticks).toBe(4); // 2 look ticks + 2 round trip
    expect(e.blocks.get('2,0,0')?.name).toBe('cobblestone');
    const c = clicks(e);
    expect(c.length).toBe(1);
    expect(data(c[0]!)).toMatchObject({
      action_type: 'click_block',
      trigger_type: 'player_input',
      block_position: { x: 2, y: -1, z: 0 },
      face: 1,
      hotbar_slot: 0,
      hand: 'main_hand',
      held_item: { network_id: 4, count: 10, stack_id: 1 },
      click_pos: { x: 0.5, y: 1, z: 0.5 },
      block_runtime_id: 1234,
      client_prediction: 'success',
    });
    expect(data(c[0]!).player_pos).toEqual({ x: 0.5, y: 1.62, z: 0.5 });
  });

  it('the click serialises with the 1.26.60 protocol and reads back unchanged', async () => {
    const e = setup();
    await e.skill.place({ x: 2, y: 0, z: 0 });
    const c = clicks(e)[0]!;
    const ser = createSerializer('1.26.60');
    const de = createDeserializer('1.26.60');
    const back = de.parsePacketBuffer(ser.createPacketBuffer({ name: c.name, params: c.params })) as unknown as { data: { name: string; params: { transaction: { transaction_data: Record<string, unknown> } } } };
    expect(back.data.name).toBe('inventory_transaction');
    const td = back.data.params.transaction.transaction_data;
    expect(td).toMatchObject({ action_type: 'click_block', face: 1, hotbar_slot: 0, block_runtime_id: 1234, client_prediction: 'success', client_cooldown_state: 'off' });
    expect(td.block_position).toEqual({ x: 2, y: -1, z: 0 });
  });

  it('uses a given face: against the side of a wall block', async () => {
    const e = setup();
    e.blocks.set('3,0,0', STONE);
    const r = await e.skill.place({ x: 2, y: 0, z: 0 }, { face: 'west' });
    expect(r).toMatchObject({ ok: true, face: 'west', support: { x: 3, y: 0, z: 0 } });
    expect(data(clicks(e)[0]!)).toMatchObject({ face: 4, block_position: { x: 3, y: 0, z: 0 }, click_pos: { x: 0, y: 0.5, z: 0.5 } });
  });

  it('prefers a visible face and never clicks an interactive block', async () => {
    const e = setup();
    // target at head height two blocks east; supports: the block below it (top face visible) and a chest beside it
    e.blocks.set('2,0,0', STONE);
    e.blocks.set('2,1,1', blockInfoOf('chest'));
    const r = await e.skill.place({ x: 2, y: 1, z: 0 });
    expect(r).toMatchObject({ ok: true, face: 'up', support: { x: 2, y: 0, z: 0 } });
    const only = setup();
    only.blocks.set('2,1,1', blockInfoOf('chest'));
    only.blocks.set('2,2,0', AIR);
    const r2 = await only.skill.place({ x: 2, y: 1, z: 0 });
    expect(r2).toMatchObject({ ok: false, reason: 'no_face' });
    expect(clicks(only).length).toBe(0);
  });

  it('refuses without a click: occupied, in the body, out of reach, no face, no item', async () => {
    const e = setup([v4(280, 1, 5)]);
    expect(await e.skill.place({ x: 2, y: -1, z: 0 })).toMatchObject({ ok: false, reason: 'occupied' });
    expect(await e.skill.place({ x: 0, y: 1, z: 0 })).toMatchObject({ ok: false, reason: 'in_body' });
    expect(await e.skill.place({ x: 0, y: 0, z: 0 }, { jump: false })).toMatchObject({ ok: false, reason: 'in_body' });
    expect(await e.skill.place({ x: 7, y: 0, z: 0 })).toMatchObject({ ok: false, reason: 'out_of_reach' });
    expect(await e.skill.place({ x: 7, y: 0, z: 0 }, { reach: 20 })).toMatchObject({ ok: false, reason: 'no_item' }); // in reach (corner 7.03), but only a stick
    expect(await e.skill.place({ x: 1, y: 3, z: 1 })).toMatchObject({ ok: false, reason: 'no_face' });
    expect(await e.skill.place({ x: 2, y: 0, z: 0 })).toMatchObject({ ok: false, reason: 'no_item' });
    expect(await e.skill.place({ x: 2, y: 0, z: 0 }, { item: 'cobblestone' })).toMatchObject({ ok: false, reason: 'no_item' });
    expect(clicks(e).length).toBe(0);
  });

  it('the server limit applies even with a large own reach', async () => {
    const e = setup();
    // eye (0.5, 1.62, 0.5) to the corner of (8, -1, 0) = 7.97 > 7.19
    expect(cornerDistance({ x: 0.5, y: 1.62, z: 0.5 }, { x: 8, y: -1, z: 0 })).toBeGreaterThan(7.19);
    expect(await e.skill.place({ x: 8, y: 0, z: 0 }, { reach: 20 })).toMatchObject({ ok: false, reason: 'out_of_reach' });
    expect(clicks(e).length).toBe(0);
  });

  it('rejected (the server resends the old block) and timeout (no answer)', async () => {
    const e = setup();
    e.server.accept = false;
    expect(await e.skill.place({ x: 2, y: 0, z: 0 })).toMatchObject({ ok: false, reason: 'rejected', block: 'air' });
    e.server.silent = true;
    expect(await e.skill.place({ x: 3, y: 0, z: 0 }, { timeoutTicks: 5 })).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('predicts the block in the movement model until the answer, then restores the real query', async () => {
    const e = setup();
    const real = e.loop.world;
    let seen: boolean | undefined;
    e.loop.onTick.push(() => {
      if (seen === undefined && clicks(e).length === 1) seen = e.loop.world.solidAt(2, 0, 0);
    });
    await e.skill.place({ x: 2, y: 0, z: 0 });
    expect(seen).toBe(true);
    expect(e.loop.world).toBe(real);
    const q = predictBlock({ solidAt: () => false, boxesAt: () => [], liquidAt: () => ({ liquid: 'water', height: 1 }) }, { x: 1, y: 2, z: 3 });
    expect(q.solidAt(1, 2, 3)).toBe(true);
    expect(q.solidAt(1, 2, 4)).toBe(false);
    expect(q.boxesAt!(1, 2, 3)).toEqual([[0, 0, 0, 1, 1, 1]]);
    expect(q.liquidAt!(1, 2, 3)).toBeNull();
  });

  it('pillar-up: jumps, clicks the top of the block below once the feet are above the cell, lands on the new block', async () => {
    const e = setup([v4(4, 10, 1)]);
    for (let i = 0; i < 3; i++) {
      const r = await e.skill.place({ x: 0, y: i, z: 0 });
      expect(r, JSON.stringify(r)).toMatchObject({ ok: true, face: 'up', support: { x: 0, y: i - 1, z: 0 }, jumped: true, landed: true });
      expect(e.loop.state.pos.y).toBe(i + 1);
      expect(e.loop.command.jump).toBe(false);
    }
    // every click went out with the feet at least PILLAR_CLEARANCE above the cell
    for (const [i, c] of clicks(e).entries()) expect((data(c).player_pos as Vec3).y - 1.62).toBeGreaterThanOrEqual(i + 1.05);
    expect(clicks(e).length).toBe(3);
  });

  it('pillar-up refused without head room', async () => {
    const e = setup();
    e.blocks.set('0,2,0', STONE);
    expect(await e.skill.place({ x: 0, y: 0, z: 0 })).toMatchObject({ ok: false, reason: 'no_headroom' });
    expect(clicks(e).length).toBe(0);
  });

  it('selects the item slot (mob_equipment through the hotbar) and picks the wanted item', async () => {
    const e = setup([v4(280, 1, 5), v4(3, 4, 6), v4(4, 9, 7)]);
    const r = await e.skill.place({ x: 2, y: 0, z: 0 }, { item: ['cobblestone', 'dirt'] });
    expect(r).toMatchObject({ ok: true, slot: 2, item: 'cobblestone' });
    expect(e.selected).toEqual([2]);
    expect(data(clicks(e)[0]!)).toMatchObject({ hotbar_slot: 2, held_item: { network_id: 4, count: 9, stack_id: 7 } });
    // default item: the first block item (the stick in slot 0 is not one)
    const d = setup([v4(280, 1, 5), v4(3, 4, 6)]);
    expect(await d.skill.place({ x: 2, y: 0, z: 0 })).toMatchObject({ ok: true, slot: 1, item: 'dirt' });
  });

  it('fetches the item from the main inventory with the inventory screen open', async () => {
    const slots: (ItemV4 | undefined)[] = [v4(280, 1, 1), v4(280, 1, 2), v4(280, 1, 3), v4(280, 1, 4), v4(280, 1, 5), v4(280, 1, 6), v4(280, 1, 7), v4(280, 1, 8), undefined, v4(4, 5, 9)];
    const e = setup(slots);
    const r = await e.skill.place({ x: 2, y: 0, z: 0 }, { item: 'cobblestone' });
    expect(r).toMatchObject({ ok: true, slot: 8, item: 'cobblestone' });
    const names = e.sent.map((s) => s.name);
    expect(names.slice(0, 3)).toEqual(['interact', 'move', 'container_close']);
    expect(e.sent[0]!.params).toMatchObject({ action_id: 'open_inventory', target_entity_id: 7n, has_position: false });
    expect(e.sent[1]!.params).toMatchObject({ src: { window: 0, slot: 9 }, dst: { window: 0, slot: 8 }, count: 5, inventoryOpen: true });
    expect(data(clicks(e)[0]!)).toMatchObject({ hotbar_slot: 8, held_item: { network_id: 4, count: 5, stack_id: 99 } });
    // without containers there is no way to fetch it
    const n = setup(slots, { containers: false });
    expect(await n.skill.place({ x: 2, y: 0, z: 0 }, { item: 'cobblestone' })).toMatchObject({ ok: false, reason: 'no_item' });
  });

  it('cancel ends a running placement with interrupted; the next one then starts', async () => {
    const e = setup();
    e.server.silent = true;
    const p = e.skill.place({ x: 2, y: 0, z: 0 });
    await e.loop.waitTicks(3);
    expect(e.skill.busy).toBe(true);
    expect(await e.skill.place({ x: 3, y: 0, z: 0 })).toMatchObject({ ok: false, reason: 'busy' });
    e.skill.cancel();
    const next = e.skill.place({ x: 3, y: 0, z: 0 }, { timeoutTicks: 2 });
    await e.loop.waitTicks(2);
    expect(await p).toMatchObject({ ok: false, reason: 'interrupted' });
    void e.loop.waitTicks(10);
    expect(await next).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('wireItemOf: the server item while it matches the model, else one built from the model', () => {
    const raw = v4(4, 10, 1);
    expect(wireItemOf(toItem(raw), raw)).toBe(raw);
    expect(wireItemOf({ ...toItem(raw)!, count: 9 }, raw)).toMatchObject({ network_id: 4, count: 9, stack_id: 1, has_stack_id: true, block_runtime_id: 77 });
    expect(wireItemOf(null, undefined)).toMatchObject({ network_id: 0, count: 0 });
  });
});
