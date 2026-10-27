/* eslint-disable @typescript-eslint/require-await -- the fakes answer like the async skills they stand for */
// Wave 8 Track AD: the stash step (skills/container/stash.ts) on fakes: chest, shulker box, drop
// junk, still full, interrupted, the free-cell choice, the slot-type switch, the stashChest setting.
import { describe, expect, it } from 'vitest';
import { parseSettingValue, RuntimeSettings, describeSetting } from '../../../src/config/settings.ts';
import { CONTAINER_BLOCKS } from '../../../src/skills/container/chest.ts';
import { boxSpots, depositable, isShulkerBox, MIN_FREE_SLOTS, parseChest, Stash, stepLine, withSlotType, type StashSkills } from '../../../src/skills/container/stash.ts';
import type { BlockInfo, ItemStack, Vec3 } from '../../../src/world/types.ts';

const item = (name: string, count = 64): ItemStack => ({ name, count, networkId: 1, metadata: 0 });
const AIR: BlockInfo = { name: 'air', stateId: 0, states: {}, hardness: 0, solid: false, boxes: [] };
const STONE: BlockInfo = { name: 'stone', stateId: 1, states: {}, hardness: 1.5, solid: true, boxes: [[0, 0, 0, 1, 1, 1]] };
const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;

/** Flat world: stone at y < 0, air above; `extra` overrides. */
function world(extra: Record<string, BlockInfo> = {}) {
  return (p: Vec3): BlockInfo => extra[key(p)] ?? (p.y < 0 ? STONE : AIR);
}

interface Opts {
  slots: (ItemStack | null)[];
  /** Stacks the chest / box take. */
  room?: number;
  settings?: Partial<{ stashChest: string; stashShulker: boolean }>;
  drop?: boolean;
  placeFails?: number;
  /** The skill call (by name) that answers 'interrupted' (a pre-emption). */
  interruptAt?: string;
  blocks?: Record<string, BlockInfo>;
}

function harness(o: Opts) {
  const slots: (ItemStack | null)[] = [...o.slots, ...Array.from({ length: 36 - o.slots.length }, () => null)];
  const inventory = {
    slots,
    freeSlots: () => slots.map((s, i) => (s ? -1 : i)).filter((i) => i >= 0),
  };
  const calls: string[] = [];
  const containers = { stats: { requests: 0 }, opts: { chestSlotType: 'container' } };
  const slotTypes: string[] = [];
  let placeFails = o.placeFails ?? 0;
  let box: string | undefined;
  const settings = new RuntimeSettings();
  if (o.settings?.stashChest) settings.applyStartup('stashChest', o.settings.stashChest);
  if (o.settings?.stashShulker !== undefined) settings.applyStartup('stashShulker', o.settings.stashShulker);
  const said: string[] = [];
  let pos: Vec3 = { x: 0.5, y: 0, z: 0.5 };
  const intr = (name: string) => o.interruptAt === name;
  const skills: StashSkills = {
    goto: async (g) => {
      calls.push(`goto ${JSON.stringify((g as { p?: Vec3 }).p)}`);
      if (intr('goto')) return { ok: false, reason: 'interrupted' };
      const p = (g as { p: Vec3 }).p;
      pos = { x: Math.floor(p.x) + 0.5, y: p.y, z: Math.floor(p.z) + 0.5 };
      return { ok: true };
    },
    open: async (p) => {
      calls.push(`open ${key(p)}`);
      return { ok: true, view: { id: 1, slots: [] }, open: { id: 1, type: 'container', pos: p, openedAt: 0 } };
    },
    deposit: async (_view, filter) => {
      calls.push('deposit');
      slotTypes.push(containers.opts.chestSlotType);
      if (intr('deposit')) return { ok: false, reason: 'interrupted', moved: {}, total: 0, requests: 0, errors: 0 };
      const moved: Record<string, number> = {};
      let total = 0;
      let requests = 0;
      let room = o.room ?? 27;
      for (let i = 0; i < 36; i++) {
        const s = slots[i];
        if (!s || !filter(s)) continue;
        if (room === 0) return { ok: false, reason: 'container_full', moved, total, requests, errors: 0 };
        room--;
        requests++;
        containers.stats.requests++;
        moved[s.name] = (moved[s.name] ?? 0) + s.count;
        total += s.count;
        slots[i] = null;
      }
      return { ok: true, moved, total, requests, errors: 0 };
    },
    closeContainer: async () => {
      calls.push('close');
      return true;
    },
    place: async (p, po) => {
      calls.push(`place ${key(p)} ${String(po?.face)} ${String(po?.item)}`);
      if (intr('place')) return { ok: false, reason: 'interrupted' };
      if (placeFails > 0) {
        placeFails--;
        return { ok: false, reason: 'rejected' };
      }
      const i = slots.findIndex((s) => s && isShulkerBox(s.name));
      box = slots[i]!.name;
      slots[i] = null;
      return { ok: true };
    },
    dig: async (p) => {
      calls.push(`dig ${key(p)}`);
      if (intr('dig')) return { ok: false, reason: 'interrupted' };
      return { ok: true };
    },
    collect: async () => {
      calls.push('collect');
      if (box) {
        slots[slots.findIndex((s) => !s)] = item(box, 1);
        box = undefined;
      }
      return { ok: true, gained: {}, pickedUp: 1, skipped: 0, ticks: 10, corrections: 0 };
    },
    cancel: () => calls.push('cancel'),
  };
  const dropped: string[] = [];
  const stash = new Stash({
    skills,
    inventory,
    blockAt: world(o.blocks),
    position: () => pos,
    settings,
    containers,
    ...(o.drop === false
      ? {}
      : {
          drop: async (name: string) => {
            dropped.push(name);
            let n = 0;
            for (let i = 0; i < 36; i++) {
              if (slots[i]?.name === name) {
                n += slots[i]!.count;
                slots[i] = null;
              }
            }
            return { ok: n > 0, dropped: n, ...(n > 0 ? {} : { reason: 'none' }) };
          },
        }),
    say: (m) => said.push(m),
  });
  return { stash, slots, calls, containers, slotTypes, dropped, said, settings };
}

const full = (extra: (ItemStack | null)[] = [], fill = 'cobblestone') => [...extra, ...Array.from({ length: 36 - extra.length }, () => item(fill))];

describe('stash step', () => {
  it('does nothing while 2 or more slots are free', async () => {
    const h = harness({ slots: [item('stone_pickaxe', 1), item('cobblestone')] });
    expect(MIN_FREE_SLOTS).toBe(2);
    expect(h.stash.needed()).toBe(false);
    expect(await h.stash.ifFull({ label: 'mine' })).toBe(true);
    expect(h.calls).toEqual([]);
    expect(h.stash.stats.attempts).toBe(0);
  });

  it('shulker box: place on a free cell, deposit as `shulker` slots, close, break, pick up, walk back', async () => {
    const h = harness({ slots: full([item('stone_pickaxe', 1), item('undyed_shulker_box', 1)]) });
    expect(h.stash.needed()).toBe(true);
    expect(await h.stash.ifFull({ label: 'mine' })).toBe(true);
    expect(h.calls).toEqual(['place 1,0,0 up undyed_shulker_box', 'open 1,0,0', 'deposit', 'close', 'dig 1,0,0', 'collect']);
    expect(h.slotTypes).toEqual(['shulker']);
    expect(h.containers.opts.chestSlotType).toBe('container'); // restored
    const a = h.stash.attempts[0]!;
    expect(a).toMatchObject({ job: 'mine', freeBefore: 0, freeAfter: 27, ok: true, interrupted: false });
    expect(a.steps[0]).toMatchObject({ kind: 'shulker', ok: true, moved: { cobblestone: 27 * 64 }, requests: 27, shared: 27, pickedUp: true, where: { x: 1, y: 0, z: 0 } });
    expect(h.slots.filter((s) => s?.name === 'undyed_shulker_box')).toHaveLength(1);
    expect(stepLine(a.steps[0]!)).toBe('shulker box at 1 0 0: moved 1728 cobblestone in 27 requests (27 on the shared Containers), picked up again, box full');
  });

  it('chest: the stashChest setting wins over the shulker box; the bot walks there and back', async () => {
    const h = harness({ slots: full([item('stone_pickaxe', 1), item('undyed_shulker_box', 1)]), settings: { stashChest: '10 0 0' } });
    expect(await h.stash.ifFull({ label: 'mine', chest: { x: 99, y: 0, z: 0 } })).toBe(true);
    expect(h.calls).toEqual(['goto {"x":10.5,"y":0,"z":0.5}', 'open 10,0,0', 'deposit', 'close', 'goto {"x":0,"y":0,"z":0}']);
    expect(h.slotTypes).toEqual(['container']);
    expect(h.stash.attempts[0]!.steps.map((s) => s.kind)).toEqual(['chest']);
  });

  it("chest: the job's own chest when stashChest is none", async () => {
    const h = harness({ slots: full([item('iron_axe', 1)], 'stick'), settings: { stashShulker: false } });
    expect(await h.stash.ifFull({ label: 'gather', chest: { x: 5, y: 0, z: 5 } })).toBe(true);
    expect(h.calls[1]).toBe('open 5,0,5');
  });

  it('keeps what keepOnDropItems keeps (tools, food, armour, shulker boxes)', () => {
    for (const n of ['stone_pickaxe', 'bread', 'iron_helmet', 'undyed_shulker_box']) expect(depositable(n), n).toBe(false);
    for (const n of ['cobblestone', 'coal', 'oak_log', 'dirt', 'rotten_flesh']) expect(depositable(n), n).toBe(true);
  });

  it('no box and no chest: drops the junk, never what the job is getting', async () => {
    const slots = [item('stone_pickaxe', 1), item('coal', 10), ...Array.from({ length: 30 }, () => item('cobblestone')), ...Array.from({ length: 4 }, () => item('dirt'))];
    const h = harness({ slots });
    expect(await h.stash.ifFull({ label: 'mine', wanted: (n) => n === 'coal' })).toBe(true);
    expect(h.dropped).toEqual(['cobblestone', 'dirt']);
    expect(h.slots.filter((s) => s?.name === 'coal')).toHaveLength(1);
  });

  it('still full afterwards: false, the owner is told', async () => {
    const h = harness({ slots: Array.from({ length: 36 }, () => item('bread')) });
    expect(await h.stash.ifFull({ label: 'food' })).toBe(false);
    expect(h.stash.stats.full).toBe(1);
    expect(h.said).toEqual(['stash: inventory full (dropped junk: nothing (no junk))']);
  });

  it('a box that cannot take everything: the rest is dropped as junk', async () => {
    const h = harness({ slots: full([item('stone_pickaxe', 1), item('undyed_shulker_box', 1)]), room: 0 });
    expect(await h.stash.ifFull({ label: 'mine' })).toBe(true);
    expect(h.stash.attempts[0]!.steps.map((s) => s.kind)).toEqual(['shulker', 'drop']);
    expect(h.slots.filter((s) => s?.name === 'undyed_shulker_box')).toHaveLength(1);
  });

  it('a rejected place tries the next free cell', async () => {
    const h = harness({ slots: full([item('stone_pickaxe', 1), item('undyed_shulker_box', 1)]), placeFails: 1 });
    expect(await h.stash.ifFull({ label: 'mine' })).toBe(true);
    expect(h.calls.slice(0, 2)).toEqual(['place 1,0,0 up undyed_shulker_box', 'place -1,0,0 up undyed_shulker_box']);
  });

  it('interrupted (a pre-emption cancels the skills): true, nothing else runs', async () => {
    const h = harness({ slots: full([item('stone_pickaxe', 1), item('undyed_shulker_box', 1)]), interruptAt: 'place' });
    expect(await h.stash.ifFull({ label: 'mine' })).toBe(true);
    expect(h.calls).toEqual(['place 1,0,0 up undyed_shulker_box']);
    expect(h.stash.attempts[0]).toMatchObject({ interrupted: true });
    expect(h.stash.stats.interrupted).toBe(1);
  });

  it('cancel() during the step ends it (and cancels the skills)', async () => {
    const h = harness({ slots: full([item('stone_pickaxe', 1), item('undyed_shulker_box', 1)]) });
    const p = h.stash.ifFull({ label: 'mine' });
    expect(h.stash.busy).toBe(true);
    h.stash.cancel();
    expect(await p).toBe(true);
    expect(h.calls).toContain('cancel');
    expect(h.stash.busy).toBe(false);
  });

  it('one attempt at a time: a second caller shares the running one', async () => {
    const h = harness({ slots: full([item('stone_pickaxe', 1), item('undyed_shulker_box', 1)]) });
    const [a, b] = await Promise.all([h.stash.ifFull({ label: 'mine' }), h.stash.ifFull({ label: 'mine' })]);
    expect([a, b]).toEqual([true, true]);
    expect(h.stash.stats.attempts).toBe(1);
  });

  it('stashShulker off skips the box', async () => {
    const h = harness({ slots: full([item('stone_pickaxe', 1), item('undyed_shulker_box', 1)]), settings: { stashShulker: false } });
    expect(await h.stash.ifFull({ label: 'mine' })).toBe(true);
    expect(h.stash.attempts[0]!.steps.map((s) => s.kind)).toEqual(['drop']);
  });
});

describe('stash helpers', () => {
  it('free cells for the box: empty, empty above, full top below, not in the body, nearest first', () => {
    const at = { x: 0.5, y: 0, z: 0.5 };
    expect(boxSpots(world(), at).slice(0, 4)).toEqual([
      { x: 1, y: 0, z: 0 },
      { x: -1, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: -1 },
    ]);
    const blocked = world({ '1,0,0': STONE, '-1,1,0': STONE, '0,-1,1': AIR, '0,0,-1': { ...AIR, name: 'water' } });
    expect(boxSpots(blocked, at)[0]).toEqual({ x: 1, y: 0, z: 1 });
    // standing on the edge of a cell: the body reaches into the neighbour
    const edge = boxSpots(world(), { x: 0.85, y: 0, z: 0.5 });
    expect(edge).not.toContainEqual({ x: 1, y: 0, z: 0 });
    expect(edge[0]).toEqual({ x: 0, y: 0, z: 1 });
    // a chest below is no support (a click on it opens it)
    expect(boxSpots(world({ '1,-1,0': { ...STONE, name: 'chest' } }), at)[0]).toEqual({ x: -1, y: 0, z: 0 });
  });

  it('shulker boxes open like chests (all 17 names)', () => {
    for (const n of ['undyed_shulker_box', 'red_shulker_box', 'light_blue_shulker_box']) {
      expect(isShulkerBox(n)).toBe(true);
      expect(CONTAINER_BLOCKS.has(n)).toBe(true);
    }
    expect(isShulkerBox('minecraft:white_shulker_box')).toBe(true);
    expect(isShulkerBox('chest')).toBe(false);
  });

  it('withSlotType switches the Containers slot type and restores it, also on a throw', async () => {
    const c = { opts: { chestSlotType: 'container' } };
    await withSlotType(c, 'shulker', async () => {
      expect(c.opts.chestSlotType).toBe('shulker');
    });
    expect(c.opts.chestSlotType).toBe('container');
    await expect(
      withSlotType(c, 'shulker', async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(c.opts.chestSlotType).toBe('container');
  });

  it('the stashChest setting: x y z, x,y,z or none', () => {
    expect(parseSettingValue('stashChest', '10 -60 3')).toBe('10 -60 3');
    expect(parseSettingValue('stashChest', ' 10,-60,3 ')).toBe('10 -60 3');
    expect(parseSettingValue('stashChest', 'NONE')).toBe('none');
    expect(() => parseSettingValue('stashChest', '10 -60')).toThrow('stashChest must be x y z or none, got "10 -60"');
    expect(parseSettingValue('stashChest', '1.5 2 3')).toBe('1 2 3'); // a block position: decimals floor (merge with Track AF's chorePen)
    expect(parseChest('10 -60 3')).toEqual({ x: 10, y: -60, z: 3 });
    expect(parseChest('none')).toBeUndefined();
    const s = new RuntimeSettings();
    expect(s.get('stashChest')).toBe('none');
    expect(s.get('stashShulker')).toBe(true);
    expect(describeSetting('stashChest', 'none')).toMatch(/^stashChest none \(x y z\|none, default none\): stash step: /);
    s.set('stashChest', '1 2 3');
    expect(s.get('stashChest')).toBe('1 2 3');
  });
});
