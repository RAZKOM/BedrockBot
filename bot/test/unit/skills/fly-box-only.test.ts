/* eslint-disable @typescript-eslint/require-await -- the fakes answer like the async skills they stand for */
// Track F13 (docs/flight.md "A flight from the box alone (Track F13)"): `!fly` with no loose rockets and only the
// fireworks box. The takeoff is simulated with the rockets the refill will give (kit.ts rocketsForFlight), never with
// the 0 loose ones; a refill that leaves the flight with nothing ends it with a line that names why; a box the refill
// did not carry again ends it with where the box is; a pre-emption after the box went down still picks it up.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RuntimeSettings } from '../../../src/config/settings.ts';
import type { FlightController } from '../../../src/skills/fly/controller.ts';
import { jumpTakeoff, type SimDeps } from '../../../src/skills/fly/glide.ts';
import { readKit, rocketsForFlight } from '../../../src/skills/fly/kit.ts';
import { boxLeftLine, FlightKitOps, refillEndLine, refillRoom, type KitOpsDeps, type RefillResult } from '../../../src/skills/fly/kitops.ts';
import { cruiseHeight, type CellQuery, type LandingTarget } from '../../../src/skills/fly/plan.ts';
import { flatWorld, type BlockQuery } from '../../../src/skills/input/index.ts';
import { FlyProcess, type FlyDeps, type FlyTarget } from '../../../src/tasks/process/fly.ts';
import { ProcessManager } from '../../../src/tasks/process/manager.ts';
import type { BlockInfo, ItemStack } from '../../../src/world/types.ts';

const FEET = -60;
const item = (name: string, count = 1): ItemStack => ({ name, count, networkId: 1, metadata: 0 });
/** A shulker box item's wire form with `Items` (the shape shulkerContents reads). */
const boxRaw = (items: Record<string, number>) => ({ extra: { nbt: { nbt: { value: { Items: { value: { value: Object.entries(items).map(([n, c]) => ({ Name: { value: `minecraft:${n}` }, Count: { value: c } })) } } } } } } });

/** An inventory of 36 slots with the fireworks box (its `rockets`) in `boxSlot`, an elytra in slot 9. */
function inventory(o: { loose?: number; box?: number; boxSlot?: number } = {}) {
  const slots: (ItemStack | null)[] = Array.from({ length: 36 }, () => null);
  slots[9] = item('elytra');
  if (o.loose) slots[0] = item('firework_rocket', o.loose);
  const at = o.boxSlot ?? 1;
  const raws = new Map<number, unknown>();
  if (o.box !== undefined) {
    slots[at] = item('undyed_shulker_box');
    raws.set(at, boxRaw({ firework_rocket: o.box }));
  }
  return {
    slots,
    selected: 0,
    rawItem: (_w: number, i: number) => raws.get(i),
    window: (id: number) => (id === 5 ? { slots: [item('firework_rocket', 64)] } : undefined),
    freeSlots: () => slots.map((s, i) => (s ? -1 : i)).filter((i) => i >= 0),
  };
}

describe('the rockets a flight is decided on (kit.ts rocketsForFlight)', () => {
  it('loose rockets: the hotbar first, else the inventory, whatever the box holds (a flight with loose rockets is decided as before)', () => {
    expect(rocketsForFlight({ rocketsHotbar: 8, rockets: 72, boxRockets: 64 })).toBe(8);
    expect(rocketsForFlight({ rocketsHotbar: 0, rockets: 40, boxRockets: 64 })).toBe(40);
    expect(rocketsForFlight({ rocketsHotbar: 1, rockets: 1, boxRockets: 64 })).toBe(1);
  });
  it('none loose: what the refill before the takeoff gives (a stack at most), from the box, else from the other carried boxes', () => {
    expect(rocketsForFlight({ rocketsHotbar: 0, rockets: 0, boxRockets: 64 })).toBe(64);
    expect(rocketsForFlight({ rocketsHotbar: 0, rockets: 0, boxRockets: 1728 })).toBe(64);
    expect(rocketsForFlight({ rocketsHotbar: 0, rockets: 0, boxRockets: 9 })).toBe(9);
    expect(rocketsForFlight({ rocketsHotbar: 0, rockets: 0, boxRockets: 0 }, 30)).toBe(30);
    expect(rocketsForFlight({ rocketsHotbar: 0, rockets: 0, boxRockets: 0 }, 500)).toBe(64);
    expect(rocketsForFlight({ rocketsHotbar: 0, rockets: 0, boxRockets: 0 })).toBe(0);
  });
  it('the kit as readKit reads it: the box alone gives 64', () => {
    expect(rocketsForFlight(readKit(inventory({ box: 64 })))).toBe(64);
    expect(rocketsForFlight(readKit(inventory({ loose: 3, box: 64 })))).toBe(3);
  });
});

describe('the cause: a takeoff simulated with 0 rockets falls short on the flat (the test server, 2026-11-13)', () => {
  const world: BlockQuery = flatWorld();
  const cell: CellQuery = (x, y, z) => world.solidAt(x, y, z);
  const skyTop = (x: number, z: number): number => {
    for (let y = 200; y >= -64; y--) if (world.solidAt(x, y, z)) return y;
    return -64;
  };
  const groundAt = (x: number, z: number, fromY = 200): number => {
    for (let y = Math.floor(fromY); y >= -64; y--) if (world.solidAt(x, y, z)) return y + 1;
    return -63;
  };
  const deps: SimDeps & { cell: CellQuery } = { world, cell, skyTop, groundAt };
  const from = { x: 0.5, y: FEET, z: 0.5 };
  const target: LandingTarget = { x: 0.5, z: 70.5, top: FEET, half: 1 };
  const cz = cruiseHeight(from, target, skyTop, {});
  it('0 rockets (the loose count of a kit of the box alone): every heading short of the landing; the box\'s 64: the first heading clears', async () => {
    const none = await jumpTakeoff(deps, from, target, { cruiseY: cz.y }, 0, [0, 30, -30]);
    expect(none.yaw).toBeUndefined();
    expect(none.line).toContain('it needs a rocket');
    const kit = readKit(inventory({ box: 64 }));
    const boxed = await jumpTakeoff(deps, from, target, { cruiseY: cz.y }, rocketsForFlight(kit), [0, 30, -30]);
    expect(boxed.yaw).toBe(0);
  });
});

describe('every takeoff the commands decide is simulated with rocketsForFlight (commands-fly.ts)', () => {
  const src = readFileSync(new URL('../../../src/chat/commands-fly.ts', import.meta.url), 'utf8');
  it('no takeoff, hop, exit piece or site search is given the loose count', () => {
    const calls = [...src.matchAll(/await (takeoffFor|hopFor|exitPieceFor|takeoffSite)\(([^;]*)\)/g)].filter((m) => !m[2]!.includes('rockets: number'));
    expect(calls.length).toBeGreaterThanOrEqual(9);
    for (const m of calls) expect(m[0], m[0]).not.toMatch(/rocketsHotbar \|\| k\.rockets/);
    // the glide down refills nothing: its own simulation keeps the loose count (one place, said so)
    expect([...src.matchAll(/rocketsHotbar \|\| k\.rockets/g)].length).toBe(1);
    expect(src).toMatch(/const rockets = k\.rocketsHotbar \|\| k\.rockets; \/\/ a glide down refills nothing/);
  });
});

describe('the refill\'s end lines (kitops.ts refillEndLine, boxLeftLine)', () => {
  const r = (o: Partial<RefillResult>): RefillResult => ({ ok: false, taken: 0, pickedUp: false, ...o });
  it('no cell for the box and nothing loose: the reason and what the owner can do', () => {
    expect(refillEndLine(r({ reason: 'no free cell next to me for the box' }), 0)).toBe(
      'fly: no rockets at hand and the refill from the fireworks box failed (no free cell next to me for the box); stand where the box can be set down beside me (a free cell with a solid floor), or give me loose rockets',
    );
    expect(refillEndLine(r({ reason: 'place: rejected' }), 0)).toMatch(/\(place: rejected\); stand where the box can be set down/);
    expect(refillEndLine(r({ reason: 'take: request_timeout', where: { x: 1, y: 2, z: 3 }, pickedUp: true }), 0)).toMatch(/\(take: request_timeout\); give me loose rockets, or !fly again$/);
  });
  it('a refill that failed with rockets still loose: the flight goes on', () => {
    expect(refillEndLine(r({ reason: 'no free cell next to me for the box' }), 1)).toBeUndefined();
    expect(refillEndLine(r({ ok: true, taken: 63, pickedUp: true, where: { x: 1, y: 2, z: 3 } }), 64)).toBeUndefined();
  });
  it('a box not carried again ends the flight, rockets or not, with where it is', () => {
    const standing = r({ taken: 64, where: { x: 1, y: 2, z: 3 }, left: 'standing', reason: 'break: timeout' });
    expect(refillEndLine(standing, 64)).toBe('fly: the fireworks box is still standing at 1 2 3 (break: timeout); break it and give it back to me, or !fly again next to it');
    const dropped = r({ taken: 64, where: { x: 1, y: 2, z: 3 }, left: 'dropped', reason: 'the box was broken but not picked up again (left at 1 2 3)' });
    expect(refillEndLine(dropped, 64)).toBe('fly: the fireworks box lies on the ground near 1 2 3 (the box was broken but not picked up again); walk me over it (!goto 1 2 3) or give it back to me');
    expect(boxLeftLine(dropped)).toBe(refillEndLine(dropped, 64));
  });
  it('every line fits a chat line (under 256 bytes)', () => {
    const long = r({ reason: 'no free cell next to me for the box' });
    for (const l of [refillEndLine(long, 0)!, boxLeftLine(r({ where: { x: -29999999, y: -64, z: -29999999 }, left: 'standing', reason: 'break: unreachable' }))]) expect(Buffer.byteLength(l)).toBeLessThan(256);
  });
});

/** The refill's ports: the box placed, opened, taken from, broken, picked up; each step counted. */
function refillRig(o: { dig?: boolean; collect?: boolean; fill?: number[]; column?: boolean } = {}) {
  const inv = inventory({ box: 64 });
  for (const i of o.fill ?? []) inv.slots[i] = item('dirt', 16);
  const steps: string[] = [];
  const solid = { name: 'stone', solid: true, boxes: [[0, 0, 0, 1, 1, 1]] } as unknown as BlockInfo;
  const air = { name: 'air', solid: false, boxes: [] } as unknown as BlockInfo;
  const deps = {
    inventory: inv,
    armour: { wear: async () => true, worn: () => [] },
    requests: { withScreen: async <T>(fn: () => Promise<T>) => fn() },
    move: async () => ({ ok: true }),
    skills: {
      place: async () => {
        steps.push('place');
        inv.slots[1] = null;
        return { ok: true };
      },
      open: async () => {
        steps.push('open');
        return { ok: true, view: { id: 5, slots: [item('firework_rocket', 64)] } };
      },
      take: async (_v: unknown, _s: number, n: number) => {
        steps.push(`take ${n}`);
        return { ok: true, moved: 0 };
      },
      closeContainer: async () => {
        steps.push('close');
        return true;
      },
      dig: async () => {
        steps.push('dig');
        return o.dig === false ? { ok: false, reason: 'timeout' } : { ok: true };
      },
      collect: async () => {
        steps.push('collect');
        if (o.collect !== false) inv.slots[1] = item('undyed_shulker_box');
        return {};
      },
    },
    blockAt: (p: { x: number; y: number; z: number }) => (p.y < FEET && (!o.column || (p.x === 0 && p.z === 0)) ? solid : air),
    position: () => ({ x: 0.5, y: FEET, z: 0.5 }),
    waitTicks: async () => undefined,
  } as unknown as KitOpsDeps;
  return { ops: new FlightKitOps(deps), steps, inv };
}

describe('the refill never leaves the box behind (kitops.ts refillFromBox)', () => {
  it('a pre-emption right after the box went down: not opened, still broken and picked up (before: it returned and left the box placed)', async () => {
    let n = 0;
    const h = refillRig();
    const r = await h.ops.refillFromBox(() => n++ < 0);
    expect(h.steps).toEqual(['place', 'dig', 'collect']);
    expect(r.pickedUp).toBe(true);
    expect(r.ok).toBe(false);
  });
  it('a break that fails: the box still standing, said so', async () => {
    const h = refillRig({ dig: false });
    const r = await h.ops.refillFromBox();
    expect(r.left).toBe('standing');
    expect(r.where).toEqual({ x: 1, y: FEET, z: 0 });
    expect(refillEndLine(r, 0)).toMatch(/^fly: the fireworks box is still standing at 1 -60 0 \(break: timeout\)/);
  });
  it('every slot but the box\'s full: refused before the box goes down (before: the rockets took the box\'s slot and the box stayed on the ground)', async () => {
    const full = [...Array(36).keys()].filter((i) => i !== 1 && i !== 9);
    const h = refillRig({ fill: full });
    const r = await h.ops.refillFromBox();
    expect(h.steps).toEqual([]);
    expect(r.reason).toBe('the inventory is full: no slot for the rockets that leaves one for the box');
    expect(h.ops.refillCheck()).toBe(r.reason);
    expect(refillEndLine(r, 0)).toMatch(/; make room \(one free slot besides the box\), or give me loose rockets$/);
  });
  it('on a 1 x 1 column top: no cell for the box, refused before anything is placed', async () => {
    const h = refillRig({ column: true });
    expect(h.ops.refillCheck()).toBe('no free cell next to me for the box');
    const r = await h.ops.refillFromBox();
    expect(h.steps).toEqual([]);
    expect(r.reason).toBe('no free cell next to me for the box');
  });
  it('one free slot besides the box\'s: a stack is taken, the box has its own slot back', async () => {
    const h = refillRig({ fill: [...Array(36).keys()].filter((i) => i !== 1 && i !== 9 && i !== 20) });
    await h.ops.refillFromBox();
    expect(h.steps).toEqual(['place', 'open', 'take 64', 'close', 'dig', 'collect']);
  });
  it('the room the refill may fill (refillRoom): the rocket stacks\' room plus a stack a free slot, the box\'s own slot not counted', () => {
    const slots: (ItemStack | null)[] = Array.from({ length: 36 }, () => item('dirt', 16));
    slots[1] = item('undyed_shulker_box');
    expect(refillRoom(slots, 1)).toBe(0);
    slots[0] = item('firework_rocket', 40);
    expect(refillRoom(slots, 1)).toBe(24);
    slots[30] = null;
    expect(refillRoom(slots, 1)).toBe(88);
    slots[1] = null;
    expect(refillRoom(slots, 1)).toBe(88);
  });
  it('a box broken and not picked up: dropped, said so', async () => {
    const h = refillRig({ collect: false });
    const r = await h.ops.refillFromBox();
    expect(r.left).toBe('dropped');
    expect(h.steps.filter((s) => s === 'collect')).toHaveLength(2);
    expect(refillEndLine(r, 0)).toMatch(/^fly: the fireworks box lies on the ground near 1 -60 0/);
  });
});

describe('FlyProcess before the takeoff (tasks/process/fly.ts prepare)', () => {
  function rig(o: { refill: RefillResult; afterRefill?: (inv: ReturnType<typeof inventory>) => void; fireworksMin?: number }) {
    const inv = inventory({ box: 64 });
    const calls: string[] = [];
    const settings = new RuntimeSettings();
    if (o.fireworksMin !== undefined) settings.set('fireworksMin', o.fireworksMin);
    const controller = { active: false, flyTo: () => (calls.push('flyTo'), new Promise(() => undefined)), status: () => ({ active: false }) };
    const deps: FlyDeps = {
      controller: controller as unknown as FlightController,
      kitOps: {
        refillFromBox: async () => {
          calls.push('refill');
          o.afterRefill?.(inv);
          return o.refill;
        },
        rocketsToHotbar: async () => (calls.push('toHotbar'), { ok: true }),
        wearElytra: async () => (calls.push('wear'), { ok: false, reason: 'not in this test' }),
        wearChestplate: async () => ({ ok: true }),
      } as unknown as FlyDeps['kitOps'],
      inventory: inv,
      memory: () => ({}),
      settings,
      position: () => ({ x: 0.5, y: FEET, z: 0.5 }),
      skyTop: () => FEET - 1,
      cell: () => false,
      say: () => undefined,
      waitTicks: async () => undefined,
    };
    const target: FlyTarget = { x: 0.5, z: 70.5, top: FEET, half: 1, label: 'the goal' };
    const p = new FlyProcess(target, deps);
    const pm = new ProcessManager();
    pm.add(p);
    pm.tick();
    return { p, calls };
  }
  it('the box alone, no cell for it: the flight ends with the refill\'s reason (before: `fly: no firework rockets at hand`)', async () => {
    const { p, calls } = rig({ refill: { ok: false, taken: 0, pickedUp: false, reason: 'no free cell next to me for the box' } });
    const r = await p.result;
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^fly: no rockets at hand and the refill from the fireworks box failed \(no free cell next to me for the box\)/);
    expect(calls).toEqual(['refill']);
  });
  it('a box the refill left on the ground: no flight away from it, the line says where', async () => {
    const { p, calls } = rig({
      refill: { ok: false, taken: 64, pickedUp: false, where: { x: 1, y: FEET, z: 0 }, left: 'dropped', reason: 'the box was broken but not picked up again (left at 1 -60 0)' },
      afterRefill: (inv) => {
        inv.slots[1] = null;
        inv.slots[0] = item('firework_rocket', 64);
      },
    });
    const r = await p.result;
    expect(r.reason).toMatch(/^fly: the fireworks box lies on the ground near 1 -60 0/);
    expect(calls).toEqual(['refill']);
  });
  it('a refill that worked: on to the elytra (the takeoff\'s steps as before)', async () => {
    const { p, calls } = rig({
      refill: { ok: true, taken: 64, pickedUp: true, where: { x: 1, y: FEET, z: 0 } },
      afterRefill: (inv) => {
        inv.slots[0] = item('firework_rocket', 64);
      },
    });
    const r = await p.result;
    expect(calls).toEqual(['refill', 'wear']);
    expect(r.reason).toMatch(/not in this test/);
  });
  it('fireworksMin 0 and nothing loose: the refill still runs (the flight was decided on the box\'s rockets)', async () => {
    const { p, calls } = rig({ fireworksMin: 0, refill: { ok: false, taken: 0, pickedUp: false, reason: 'no free cell next to me for the box' } });
    await p.result;
    expect(calls[0]).toBe('refill');
  });
});
