/* eslint-disable @typescript-eslint/require-await -- the fakes answer like the async skills they stand for */
// Track F16 (docs/flight.md "A window under a roof refills from the box (Track F16)"): a corridor window under a roof
// refills from the fireworks box before it flies when its loose rockets are low. The rules (kit.ts rocketsForWindow,
// windowRefillWanted; kitops.ts unsafeBoxCell, caveBoxSpots, refillCheck `under`; tasks/process/corridor.ts
// UnderFlyProcess; chat/commands-corridor.ts), and the trip offline: the corridor world's bore from 3 blocks inside the
// mouth to the chamber (runCorridorTrip with the real executor, the real FlightKitOps over a fake inventory and the
// world's blocks, a stub planner that needs NEED rockets for a window, the window's flight a stub that fires them).
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type * as Drive from '../../../src/skills/fly/corridor/drive.ts';
import type { StretchDeps, StretchOptions, StretchReport } from '../../../src/skills/fly/corridor/drive.ts';
import { legOf, corridorOf } from '../../../src/skills/fly/corridor/coarse-port.ts';
import { caveExecutorOptions, caveStretchOptions, CAVE_STYLE } from '../../../src/skills/fly/cave/style.ts';
import { readKit, rocketsForFlight, rocketsForWindow, WINDOW_ROCKET_RESERVE, WINDOW_ROCKETS_SURE, windowRefillWanted } from '../../../src/skills/fly/kit.ts';
import { caveBoxSpots, FlightKitOps, unsafeBoxCell, type KitOpsDeps } from '../../../src/skills/fly/kitops.ts';
import type { RoutePlan, RouteRequest } from '../../../src/skills/fly/route/types.ts';
import { UnderFlyProcess, type UnderFlyDeps } from '../../../src/tasks/process/corridor.ts';
import type { BlockInfo, ItemStack, Vec3 } from '../../../src/world/types.ts';
import { corridorWorld, F } from './fly-corridor-world.ts';

/** The window's flight (drive.ts flyStretch) as the test sets it. */
type FlyFake = (d: StretchDeps, o: StretchOptions) => { done: Promise<StretchReport>; stop(): void };
const fly: { fake?: FlyFake } = {};
vi.mock('../../../src/skills/fly/corridor/drive.ts', async (orig) => {
  const m = await orig<typeof Drive>();
  return { ...m, flyStretch: (d: StretchDeps, o: StretchOptions) => fly.fake!(d, o) };
});
// (imported after the mock is declared: vitest hoists vi.mock over the imports)
const { runCorridorTrip, windowRefillLine, REFILL_MOB_REACH } = await import('../../../src/chat/commands-corridor.ts');

const item = (name: string, count = 1): ItemStack => ({ name, count, networkId: 1, metadata: 0 });
const boxRaw = (items: Record<string, number>) => ({ extra: { nbt: { nbt: { value: { Items: { value: { value: Object.entries(items).map(([n, c]) => ({ Name: { value: `minecraft:${n}` }, Count: { value: c } })) } } } } } } });
const block = (name: string, top = 1): BlockInfo => ({ name, stateId: 1, states: {}, hardness: 1, solid: top > 0, boxes: top > 0 ? [[0, 0, 0, 1, top, 1]] : [] }) as unknown as BlockInfo;
const AIR = { name: 'air', stateId: 0, states: {}, hardness: 0, solid: false, boxes: [] } as unknown as BlockInfo;
const STONE = block('stone');
const WATER = { ...AIR, name: 'flowing_water' };

describe('the rockets a window is proven with and when it refills (kit.ts, Track F16)', () => {
  it(`${WINDOW_ROCKETS_SURE} loose or more: the loose ones, no refill (a trip with enough loose is decided as before)`, () => {
    expect(rocketsForWindow({ rocketsHotbar: 8, rockets: 8, boxRockets: 64 }, true)).toBe(8);
    expect(rocketsForWindow({ rocketsHotbar: 0, rockets: 40, boxRockets: 64 }, true)).toBe(40);
    for (const plan of [0, 1, 3, 6, 20]) expect(windowRefillWanted(WINDOW_ROCKETS_SURE, plan)).toBe(false);
  });
  it('fewer loose and a refill possible here: what the hotbar holds after it (a stack at most); none loose: the F13 rule', () => {
    expect(rocketsForWindow({ rocketsHotbar: 3, rockets: 3, boxRockets: 64 }, true)).toBe(64);
    expect(rocketsForWindow({ rocketsHotbar: 3, rockets: 3, boxRockets: 10 }, true)).toBe(13);
    expect(rocketsForWindow({ rocketsHotbar: 0, rockets: 0, boxRockets: 64 }, true)).toBe(rocketsForFlight({ rocketsHotbar: 0, rockets: 0, boxRockets: 64 }));
  });
  it('no refill possible (no box, no cell, a hostile): the loose ones, as before', () => {
    expect(rocketsForWindow({ rocketsHotbar: 3, rockets: 3, boxRockets: 64 }, false)).toBe(3);
    expect(rocketsForWindow({ rocketsHotbar: 0, rockets: 0, boxRockets: 64 }, false)).toBe(0);
    expect(rocketsForWindow({ rocketsHotbar: 3, rockets: 3, boxRockets: 0 }, true)).toBe(3);
  });
  it(`a refill when the loose ones are fewer than the plan fires plus ${WINDOW_ROCKET_RESERVE}`, () => {
    expect(windowRefillWanted(0, 0)).toBe(true);
    expect(windowRefillWanted(1, 0)).toBe(true);
    expect(windowRefillWanted(2, 0)).toBe(false);
    expect(windowRefillWanted(4, 2)).toBe(false);
    expect(windowRefillWanted(4, 3)).toBe(true);
    expect(windowRefillWanted(3)).toBe(true);
  });
});

/** A world of blocks by cell key; anything else air over a stone floor at y < F. */
function cells(map: Record<string, BlockInfo>): (p: Vec3) => BlockInfo {
  return (p) => map[`${p.x},${p.y},${p.z}`] ?? (p.y < F ? STONE : AIR);
}
const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

describe('where the box may be set down under a roof (kitops.ts unsafeBoxCell, caveBoxSpots)', () => {
  const feet = { x: 0.5, y: F, z: 0.5 };
  const f = { x: 0, y: F, z: 0 };
  it('a cell on a floor with floor or wall on every side: allowed', () => {
    expect(unsafeBoxCell(cells({}), f, { x: 1, y: F, z: 0 })).toBeUndefined();
    expect(caveBoxSpots(cells({}), feet).spots[0]).toEqual({ x: 1, y: F, z: 0 });
  });
  it('a ledge beside it (the drop can slide off and fall): refused', () => {
    expect(unsafeBoxCell(cells({ [key(2, F - 1, 0)]: AIR }), f, { x: 1, y: F, z: 0 })).toBe('a ledge beside it');
  });
  it('water or lava beside it or over the lid: refused', () => {
    expect(unsafeBoxCell(cells({ [key(1, F, 1)]: WATER }), f, { x: 1, y: F, z: 0 })).toBe('water or lava beside it');
    expect(unsafeBoxCell(cells({ [key(2, F - 1, 0)]: { ...AIR, name: 'lava' } }), f, { x: 1, y: F, z: 0 })).toBe('water or lava beside it');
    expect(unsafeBoxCell(cells({ [key(1, F + 2, 0)]: WATER }), f, { x: 1, y: F, z: 0 })).toBe('water or lava over it');
  });
  it('sand or gravel over the lid (it falls into the cell once the box is gone): refused', () => {
    expect(unsafeBoxCell(cells({ [key(1, F + 2, 0)]: block('gravel') }), f, { x: 1, y: F, z: 0 })).toBe('gravel over it');
    expect(unsafeBoxCell(cells({ [key(1, F + 2, 0)]: block('red_concrete_powder') }), f, { x: 1, y: F, z: 0 })).toBe('red_concrete_powder over it');
  });
  it('a corner cell with both side cells walled, a cell two out with no floor between: no way to it', () => {
    const walled = cells({ [key(1, F, 0)]: STONE, [key(1, F + 1, 0)]: STONE, [key(0, F, 1)]: STONE, [key(0, F + 1, 1)]: STONE });
    expect(unsafeBoxCell(walled, f, { x: 1, y: F, z: 1 })).toBe('no way to it from where I stand');
    expect(unsafeBoxCell(cells({ [key(0, F + 1, 1)]: STONE }), f, { x: 1, y: F, z: 1 })).toBeUndefined();
    expect(unsafeBoxCell(cells({ [key(1, F, 0)]: STONE, [key(1, F + 1, 0)]: STONE }), f, { x: 2, y: F, z: 0 })).toBe('no way to it from where I stand');
  });
  it('no free cell at all: F13\'s reason; free cells all unsafe: the first one\'s reason', () => {
    const path = block('grass_path', 0.9375);
    const ring: Record<string, BlockInfo> = {};
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (dx || dz) ring[key(dx, F - 1, dz)] = path;
    expect(caveBoxSpots(cells(ring), feet)).toEqual({ spots: [], why: 'no free cell next to me for the box' });
    const pit: Record<string, BlockInfo> = {};
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) if (Math.max(Math.abs(dx), Math.abs(dz)) === 3) pit[key(dx, F - 1, dz)] = AIR;
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (Math.max(Math.abs(dx), Math.abs(dz)) === 2) pit[key(dx, F + 2, dz)] = block('sand');
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) pit[key(dx, F + 2, dz)] = block('gravel');
    const c = caveBoxSpots(cells(pit), feet);
    expect(c.spots).toEqual([]);
    expect(c.why).toMatch(/^no cell next to me where the box and its drop are safe \(gravel over it \(1 0\)\)$/);
  });
});

/** An inventory of 36 slots: the elytra in 9, `loose` rockets in 0, the fireworks box in `boxSlot`. */
function inventory(o: { loose?: number; box?: number; boxSlot?: number; full?: boolean } = {}) {
  const slots: (ItemStack | null)[] = Array.from({ length: 36 }, () => null);
  slots[9] = item('elytra');
  if (o.loose) slots[0] = item('firework_rocket', o.loose);
  const at = o.boxSlot ?? 1;
  const raws = new Map<number, unknown>();
  if (o.box !== undefined) {
    slots[at] = item('undyed_shulker_box');
    raws.set(at, boxRaw({ firework_rocket: o.box }));
  }
  if (o.full) for (let i = 0; i < 36; i++) slots[i] ??= item('dirt', 16);
  const chest = { id: 5, slots: [item('firework_rocket', o.box ?? 0)] as (ItemStack | null)[] };
  const armour = { slots: [null, null, null, null] as (ItemStack | null)[] };
  return {
    slots,
    raws,
    selected: 0,
    worn: null as ItemStack | null,
    rawItem: (_w: number, i: number) => raws.get(i),
    window: (id: number) => (id === 5 ? chest : id === 120 ? armour : undefined),
    freeSlots: () => slots.map((s, i) => (s ? -1 : i)).filter((i) => i >= 0),
    chest,
  };
}
type Inv = ReturnType<typeof inventory>;
const rocketsIn = (inv: Inv) => inv.slots.reduce((a, s) => a + (s?.name === 'firework_rocket' ? s.count : 0), 0);
const boxRocketsOf = (inv: Inv) => readKit(inv).boxRockets;
const boxesIn = (inv: Inv) => inv.slots.filter((s) => s?.name.endsWith('shulker_box')).length;

/** The real FlightKitOps over the fake inventory: the box placed into the world, taken from, broken and picked up again. */
function kitOps(inv: Inv, blockAt: (p: Vec3) => BlockInfo, pos: () => Vec3, steps: string[], o: { collect?: boolean } = {}) {
  let placed: { at: Vec3; slot: number; raw: unknown } | undefined;
  const deps = {
    inventory: inv,
    armour: { wear: async () => true, worn: () => [] },
    requests: { withScreen: async <T>(fn: () => Promise<T>) => fn() },
    move: async (src: { slot: number }, dst: { slot: number }) => {
      inv.slots[dst.slot] = inv.slots[src.slot]!;
      inv.slots[src.slot] = null;
      return { ok: true };
    },
    skills: {
      place: async (p: Vec3) => {
        const slot = readKit(inv).boxSlot;
        steps.push(`place ${p.x - Math.floor(pos().x)} ${p.z - Math.floor(pos().z)}`);
        placed = { at: p, slot, raw: inv.raws.get(slot) };
        inv.slots[slot] = null;
        inv.raws.delete(slot);
        return { ok: true };
      },
      open: async () => {
        steps.push('open');
        return { ok: true, view: { id: 5, slots: inv.chest.slots } };
      },
      take: async (_v: unknown, s: number, n: number, prefer: readonly number[]) => {
        const st = inv.chest.slots[s]!;
        const moved = Math.min(n, st.count);
        steps.push(`take ${moved}`);
        const to = inv.slots.findIndex((x, i) => i < 9 && x?.name === 'firework_rocket');
        const free = to >= 0 ? to : (prefer[0] ?? inv.slots.findIndex((x) => !x));
        inv.slots[free] = item('firework_rocket', (inv.slots[free]?.count ?? 0) + moved);
        st.count -= moved;
        if (st.count <= 0) inv.chest.slots[s] = null;
        return { ok: true, moved };
      },
      closeContainer: async () => {
        steps.push('close');
        return true;
      },
      dig: async () => {
        steps.push('dig');
        return { ok: true };
      },
      collect: async () => {
        steps.push('collect');
        if (o.collect === false || !placed) return {};
        const free = inv.slots.findIndex((x) => !x);
        const left = inv.chest.slots.reduce((a, x) => a + (x?.count ?? 0), 0);
        inv.slots[free] = item('undyed_shulker_box');
        inv.raws.set(free, boxRaw(left ? { firework_rocket: left } : {}));
        placed = undefined;
        return {};
      },
    },
    blockAt,
    position: pos,
    waitTicks: async () => undefined,
  } as unknown as KitOpsDeps;
  return new FlightKitOps(deps);
}

describe('refillCheck under a roof (kitops.ts, Track F16)', () => {
  const pos = () => ({ x: 0.5, y: F, z: 0.5 });
  it('the open-air check is F13\'s; under a roof a ledge beside every free cell refuses', () => {
    // a ridge one block wide along x: the free cells beside the body on it, the floor gone on both sides of it
    const ledge: Record<string, BlockInfo> = {};
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) if (dz !== 0) ledge[key(dx, F - 1, dz)] = AIR;
    const ops = kitOps(inventory({ box: 64 }), cells(ledge), pos, []);
    expect(ops.refillCheck()).toBeUndefined();
    expect(ops.refillCheck({ under: true })).toMatch(/^no cell next to me where the box and its drop are safe \(a ledge beside it/);
  });
  it('a full inventory: F13\'s refusal, unchanged', () => {
    const ops = kitOps(inventory({ box: 64, full: true }), cells({}), pos, []);
    expect(ops.refillCheck({ under: true })).toBe('the inventory is full: no slot for the rockets that leaves one for the box');
  });
});

/** A process manager that starts what it is given at once (the corridor's windows run alone in these tests). */
const manager = { finished: () => undefined, yieldControl: () => undefined };
function run(p: UnderFlyProcess): void {
  p.attach(manager as never);
  p.start();
}

describe('the window\'s refill before its takeoff (tasks/process/corridor.ts UnderFlyProcess)', () => {
  const w = { goals: [], margin: 0.5, blocks: 40, end: { x: 10, y: F, z: 0 } } as never;
  const report: StretchReport = { end: 'done', bailed: false, ticks: 40, rockets: 1, hits: 0, corrections: 0, maxCorrection: 0, held: 0, minClearance: 1, reached: 1, goals: 1, windows: 1, stats: { plans: 1, replans: 0, partial: 0, planMs: 1 } as never, landedAt: { x: 10.5, y: F, z: 0.5 } };
  function rig(o: { loose?: number; refill?: boolean; hostile?: string; collect?: boolean }) {
    const inv = inventory({ box: 64, ...(o.loose ? { loose: o.loose } : {}) });
    const steps: string[] = [];
    const ops = kitOps(inv, cells({}), () => ({ x: 0.5, y: F, z: 0.5 }), steps, o.collect === false ? { collect: false } : {});
    const calls: string[] = [];
    const deps: UnderFlyDeps = {
      kitOps: {
        wearElytra: async () => {
          calls.push('elytra');
          inv.window(120)!.slots[1] = item('elytra');
          return { ok: true };
        },
        rocketsToHotbar: async () => {
          calls.push('hotbar');
          return readKit(inv).rocketsHotbar > 0 ? { ok: true } : { ok: false, reason: 'no rockets' };
        },
        refillFromBox: async (alive, where) => {
          calls.push(`refill ${where?.under === true ? 'under' : 'open'}`);
          return ops.refillFromBox(alive, where);
        },
      },
      inventory: inv,
      memory: () => ({}),
      fly: () => {
        calls.push(`fly ${readKit(inv).rocketsHotbar}`);
        return { done: Promise.resolve(report), stop: () => undefined };
      },
      airborne: () => false,
      ...(o.hostile ? { hostile: () => o.hostile } : {}),
      waitTicks: async () => undefined,
    };
    const p = new UnderFlyProcess(w, 'to 10 -60 0', deps, o.refill ? { refill: true } : {});
    return { p, calls, steps, inv };
  }
  it('no refill asked: the same steps as before the track (the hotbar, the elytra, the flight)', async () => {
    const r = rig({ loose: 20 });
    run(r.p);
    expect((await r.p.result).ok).toBe(true);
    expect(r.calls).toEqual(['elytra', 'fly 20']);
    expect(r.steps).toEqual([]);
  });
  it('nothing loose, the refill asked: the box down on a cave cell, 64 taken, picked up, then the flight', async () => {
    const r = rig({ refill: true });
    run(r.p);
    expect((await r.p.result).ok).toBe(true);
    expect(r.calls).toEqual(['refill under', 'elytra', 'fly 64']);
    expect(r.steps).toEqual(['place 1 0', 'open', 'take 64', 'close', 'dig', 'collect']);
    expect(boxesIn(r.inv)).toBe(1);
    expect(rocketsIn(r.inv) + boxRocketsOf(r.inv)).toBe(64);
  });
  it('a hostile in reach: no refill started, the window ends with why (the trip proves it again from there)', async () => {
    const r = rig({ refill: true, hostile: 'a zombie 5.0 blocks away' });
    run(r.p);
    const out = await r.p.result;
    expect(out).toMatchObject({ ok: false, reason: 'no refill with a zombie 5.0 blocks away' });
    expect(r.calls).toEqual([]);
    expect(r.steps).toEqual([]);
  });
  it('a box broken and not picked up: the window does not fly, the box\'s line', async () => {
    const r = rig({ refill: true, collect: false });
    run(r.p);
    const out = await r.p.result;
    expect(out.ok).toBe(false);
    expect(r.p.boxLeft).toMatch(/^fly: the fireworks box lies on the ground near 1 -60 0/);
    expect(r.calls).toEqual(['refill under']);
  });
});

describe('the corridor trip offline: the bore from inside its mouth to the chamber (commands-corridor.ts, Track F16)', () => {
  const W = corridorWorld({ x: 4000, z: 6000 });
  afterEach(() => {
    delete fly.fake;
  });

  /**
   * One trip. `need`: the rockets a window's plan fires (the stub planner needs this many; the stub flight fires them and,
   * with fewer in the hotbar, bails out where it took off). `shift`: the start this many blocks farther in than 3.
   * `before`: the kit ops of the tree before the track (no refillCheck, no refillFromBox): the proof is given the loose
   * count and no window refills, as on main.
   */
  function trip(o: { loose?: number; full?: boolean; noCell?: boolean; need?: number; shift?: number; before?: boolean }) {
    const need = o.need ?? 2;
    const inside: Vec3 = { x: W.mouthX + 3 + (o.shift ?? 0), y: F, z: W.start.z };
    const inv = inventory({ box: 64, ...(o.loose ? { loose: o.loose } : {}), ...(o.full ? { full: true } : {}) });
    const state = { pos: { x: inside.x + 0.5, y: F, z: inside.z + 0.5 }, vel: { x: 0, y: 0, z: 0 }, gliding: false, onGround: true, ready: true };
    const path = block('grass_path', 0.9375);
    // (no cell: the floor round the start a path block, the start's own cell kept)
    const noCellAt = (p: Vec3): boolean => o.noCell === true && p.y === F - 1 && Math.abs(p.x - inside.x) <= 3 && !(p.x === inside.x && p.z === inside.z);
    const blockAt = (p: Vec3): BlockInfo => (noCellAt(p) ? path : W.solidAt(p.x, p.y, p.z) ? STONE : AIR);
    const steps: string[] = [];
    const ops = kitOps(inv, blockAt, () => state.pos, steps);
    const log: string[] = [];
    const said: string[] = [];
    const flights: { from: Vec3; hotbar: number; ok: boolean }[] = [];
    fly.fake = (_d, so) => {
      const g = so.goals[so.goals.length - 1]!;
      const hotbar = readKit(inv).rocketsHotbar;
      const fired = Math.min(need, hotbar);
      let left = fired;
      for (let i = 0; i < 9 && left > 0; i++) {
        const s = inv.slots[i];
        if (s?.name !== 'firework_rocket') continue;
        const n = Math.min(left, s.count);
        s.count -= n;
        left -= n;
        if (s.count <= 0) inv.slots[i] = null;
      }
      const ok = hotbar >= need;
      flights.push({ from: { ...state.pos }, hotbar, ok });
      if (ok && g.kind === 'landing') state.pos = { x: g.cell.x + 0.5, y: g.top, z: g.cell.z + 0.5 };
      const r: StretchReport = { end: ok ? 'done' : 'failed', bailed: !ok, ticks: 100, rockets: fired, hits: 0, corrections: 0, maxCorrection: 0, held: 0, minClearance: 1, reached: ok ? so.goals.length : 0, goals: so.goals.length, windows: 1, stats: { plans: 1, replans: 0, partial: 0, planMs: 1 } as never, landedAt: { ...state.pos } };
      return { done: Promise.resolve(r), stop: () => undefined };
    };
    const plan = async (req: RouteRequest): Promise<RoutePlan> => {
      const complete = req.start.rockets >= need;
      return { controls: [], states: [], edges: [], ticks: 100, rockets: complete ? need : req.start.rockets, cost: 100, clearance: 1, complete, reached: complete ? req.goals.length : 0, robust: true, nodes: 10, expanded: 10, ms: 1, budget: 'none', ...(complete ? {} : { why: 'the goal is above what the rockets in the hand can buy' }) };
    };
    const corridor = corridorOf([legOf('fly', inside, W.flyEnd, W.tunnelPortals.filter((p) => p.axis !== 'x' || p.center.x > inside.x), ['0:cave:a', '0:cave:b']), W.corridor.legs[1]!]);
    const logger = { info: (m: string) => log.push(m), warn: (m: string) => log.push(m), error: (m: string) => log.push(m), debug: () => undefined, child: () => logger } as never;
    const wiring = {
      task: {},
      loop: { state, waitTicks: (_n: number) => new Promise<void>((r) => setImmediate(r)) },
      queue: () => undefined,
      inventory: inv,
      hotbar: {},
      entities: {},
      memory: () => ({}),
      kitOps: {
        wearElytra: async () => {
          inv.window(120)!.slots[1] = item('elytra');
          return { ok: true };
        },
        rocketsToHotbar: async () => (readKit(inv).rocketsHotbar > 0 ? { ok: true } : { ok: false, reason: 'no rockets' }),
        wearChestplate: async () => ({ ok: true }),
        ...(o.before
          ? {}
          : {
              refillFromBox: (alive: () => boolean, where?: { under?: boolean }) => ops.refillFromBox(alive, where),
              refillCheck: (where?: { under?: boolean }) => ops.refillCheck(where),
            }),
      },
      processes: { add: (p: UnderFlyProcess) => run(p) },
      solid: (x: number, y: number, z: number) => W.solidAt(x, y, z),
      loaded: () => true,
      dim: () => 0,
      grid: {},
      plan,
      flySky: async () => ({ ok: false, reason: 'no sky here' }),
      walk: async (cell: Vec3) => {
        state.pos = { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 };
        return { ok: true, at: { ...state.pos } };
      },
      say: (m: string) => said.push(m),
      log: logger,
    };
    const style = { executor: caveExecutorOptions(true), stretch: (x: { margin: number }) => caveStretchOptions(x), prove: { maxMs: CAVE_STYLE.proveMs, maxNodes: CAVE_STYLE.proveNodes } };
    const total0 = rocketsIn(inv) + boxRocketsOf(inv);
    return {
      inv,
      steps,
      log,
      said,
      flights,
      total0,
      go: () => runCorridorTrip(wiring as never, W.stub([corridor]), W.goal, 'the chamber', style),
    };
  }

  type Kase = 'boxonly' | 'runout' | 'nocell' | 'invfull' | 'enough';
  const CASES: Kase[] = ['boxonly', 'runout', 'nocell', 'invfull', 'enough'];
  const RUNS = 10;
  const setupOf = (k: Kase, i: number) => {
    const need = 1 + (i % 3);
    return { need, shift: i, ...(k === 'runout' ? { loose: need + WINDOW_ROCKET_RESERVE } : k === 'enough' ? { loose: 64 } : {}), ...(k === 'nocell' ? { noCell: true } : {}), ...(k === 'invfull' ? { full: true } : {}) };
  };
  const rows: string[] = [];
  afterAll(() => {
    const out = process.env.F16_OFFLINE_OUT;
    const text = ['case\tside\trun\tneed\tarrived\twindows\twalks\tunproven\tflown dry\trefills\tboxes after\trockets kept\tsaid', ...rows].join('\n');
    if (out) writeFileSync(out, `${text}\n`);
  });

  for (const k of CASES) {
    it(`${k}: ${RUNS} runs before (main's kit ops) and after`, async () => {
      for (let i = 0; i < RUNS; i++) {
        const o = setupOf(k, i);
        for (const before of [true, false]) {
          const t = trip({ ...o, before });
          const r = await t.go();
          const places = t.steps.filter((s) => s.startsWith('place')).length;
          const kept = rocketsIn(t.inv) + boxRocketsOf(t.inv) + r.rockets === t.total0;
          const dry = t.flights.filter((f) => !f.ok).length;
          rows.push([k, before ? 'before' : 'after', i, o.need, r.ok, r.windows, r.walks, r.unproven, dry, places, boxesIn(t.inv), kept, t.said.map((x) => x.slice(0, 60)).join(' / ')].join('\t'));
          const tag = `${k} #${i} ${before ? 'before' : 'after'}: ${r.reason ?? ''}`;
          expect(boxesIn(t.inv), tag).toBe(1);
          expect(kept, tag).toBe(true);
          expect(r.ok, tag).toBe(true);
          if (before) {
            expect(places, tag).toBe(0);
            if (k === 'boxonly' || k === 'nocell' || k === 'invfull') expect(r.windows, tag).toBe(0); // nothing flies on 0 loose
          } else {
            if (k === 'boxonly' || k === 'runout') {
              expect(r.windows, tag).toBeGreaterThanOrEqual(2);
              expect(dry, tag).toBe(0);
              expect(places, tag).toBeGreaterThanOrEqual(1);
              expect(t.log.some((l) => l.includes('refilling before the takeoff')), tag).toBe(true);
            }
            if (k === 'runout') expect(t.flights[0]!.hotbar, tag).toBe(o.need + WINDOW_ROCKET_RESERVE); // the first window flew on its loose ones
            if (k === 'nocell') {
              expect(t.said[0], tag).toBe(windowRefillLine('no free cell next to me for the box', 0));
              expect(r.unproven, tag).toBeGreaterThanOrEqual(1);
              expect(places, tag).toBeGreaterThanOrEqual(1);
              expect(r.windows, tag).toBeGreaterThanOrEqual(1);
            }
            if (k === 'invfull') {
              expect(t.said, tag).toEqual([windowRefillLine('the inventory is full: no slot for the rockets that leaves one for the box', 0)]);
              expect(t.steps, tag).toEqual([]);
              expect(r.windows, tag).toBe(0);
            }
            if (k === 'enough') {
              expect(t.steps, tag).toEqual([]);
              expect(t.said, tag).toEqual([]);
              expect(t.log.some((l) => l.includes('refill')), tag).toBe(false);
            }
          }
        }
      }
    });
  }
  it('enough loose: the windows, the walks and the rockets the same before and after (tick for tick in the stub)', async () => {
    for (let i = 0; i < RUNS; i++) {
      const o = setupOf('enough', i);
      const a = trip({ ...o, before: true });
      const ra = await a.go();
      const b = trip({ ...o });
      const rb = await b.go();
      expect([rb.windows, rb.walks, rb.rockets, rb.unproven, b.flights.map((f) => `${f.from.x} ${f.from.z} ${f.hotbar}`)]).toEqual([ra.windows, ra.walks, ra.rockets, ra.unproven, a.flights.map((f) => `${f.from.x} ${f.from.z} ${f.hotbar}`)]);
    }
  });
});

describe('the lines and the wiring (Track F16)', () => {
  it('the refusal lines fit a chat line and say what the trip does', () => {
    const long = windowRefillLine('no cell next to me where the box and its drop are safe (a cell beside it is not loaded (-2 -2))', 0);
    expect(Buffer.byteLength(long)).toBeLessThan(256);
    expect(windowRefillLine('no free cell next to me for the box', 3)).toMatch(/^fly: 3 rockets at hand .*; flying the windows on them and trying again further on$/);
    expect(REFILL_MOB_REACH).toBe(8);
  });
  it('the proof of a window is given rocketsForWindow, never the loose count alone', () => {
    const src = readFileSync(new URL('../../../src/chat/commands-corridor.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/const rockets = rocketsForWindow\(k, refillable\);/);
    expect(src).not.toMatch(/const rockets = readKit\(/);
    expect(src).toMatch(/refillCheck\(\{ under: true \}\)/);
  });
});
