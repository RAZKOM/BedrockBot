// Track F15: the made-up building of the floor search's unit tests and bench (test/unit/skills/fly-floors.test.ts,
// scripts/floor-search-bench.ts; the e2e test/e2e/fly-floors.test.ts builds the same cells on the server). A room (11
// standable cells, 3 high) whose only way out is a ladder in a wall column up to a closed hatch in its ceiling, the ceiling
// a 9 x 8 roof platform; optionally a wider roof 19 over the platform. Plus the world, the probe and the takeoff wired as
// commands-fly.ts wires them.
import type { Vec3 } from '../../../src/connection/types.ts';
import type { FloorDeps } from '../../../src/skills/fly/floors.ts';
import { jumpTakeoff, ledgeTakeoff, type Ledge, type SimDeps } from '../../../src/skills/fly/glide.ts';
import { columnKey, cruiseHeight, type CellQuery, type LandingTarget } from '../../../src/skills/fly/plan.ts';
import { probePath, type ProbeNav } from '../../../src/skills/home/reach.ts';
import type { BlockQuery } from '../../../src/skills/input/index.ts';
import { NavGrid } from '../../../src/skills/nav/index.ts';
import { flatGen, type GenWorld } from './genworld.ts';

export const F = -60; // feet on the flat world's grass
export const R = F + 60; // the room's floor feet
export const START: Vec3 = { x: -0.5, y: R, z: -0.5 };

/** The building centred on (0, 0): the room's floor feet at `r`. */
export function building(o: { ladder?: boolean; wide?: boolean; r?: number; gen?: GenWorld } = {}): GenWorld {
  const r = o.r ?? R;
  const gen = o.gen ?? flatGen({ x: -64, y: -64, z: -64 }, { x: 128, y: 100, z: 128 });
  gen.fill({ x: -2, y: r - 1, z: -2 }, { x: 2, y: r + 2, z: 3 }, 'stone');
  gen.fill({ x: -1, y: r, z: -1 }, { x: 1, y: r + 2, z: 2 }, 'air');
  gen.fill({ x: -4, y: r + 3, z: -3 }, { x: 4, y: r + 3, z: 4 }, 'stone');
  if (o.ladder ?? true) {
    gen.put(1, r + 3, 2, 'air');
    for (let y = r; y <= r + 3; y++) gen.put(1, y, 2, 'ladder', { facing_direction: 4 });
    gen.put(1, r + 4, 2, 'spruce_trapdoor', { open_bit: 0, direction: 3, upside_down_bit: 0 });
  }
  if (o.wide ?? true) gen.fill({ x: -14, y: r + 23, z: -14 }, { x: 14, y: r + 23, z: 14 }, 'stone');
  return gen;
}

/** The world for the flight: the generated box, the flat ground beyond it (the goal is 300 blocks out). */
export function rig(gen: GenWorld) {
  const inBox = (x: number, y: number, z: number) => x >= gen.x0 && x < gen.x0 + gen.sx && z >= gen.z0 && z < gen.z0 + gen.sz && y >= gen.y0 && y < gen.y0 + gen.sy;
  const solid = (x: number, y: number, z: number): boolean => (inBox(x, y, z) ? gen.blockAt(x, y, z)!.solid : y <= -61);
  const world: BlockQuery = { solidAt: solid };
  const cell: CellQuery = (x, y, z) => solid(x, y, z);
  const skyTop = (x: number, z: number): number => {
    for (let y = 120; y >= -64; y--) if (solid(x, y, z)) return y;
    return -64;
  };
  const groundAt = (x: number, z: number, fromY = 120): number => {
    for (let y = Math.floor(fromY); y >= -64; y--) if (solid(x, y, z)) return y + 1;
    return -63;
  };
  const deps: SimDeps & { cell: CellQuery } = { world, cell, skyTop, groundAt, yieldNow: () => new Promise((r) => setImmediate(r)) };
  const nav: ProbeNav = { grid: new NavGrid(gen), planOptions: () => ({ allowOpen: true }) };
  return { cell, deps, nav, skyTop };
}

/** The goal: a walk landing on the ground 300 blocks out towards +z. */
export function goal(r = 3): LandingTarget {
  const cells = new Set<number>();
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) cells.add(columnKey(dx, 300 + dz));
  return { x: 0.5, z: 300.5, top: F, half: r + 0.5, cells, walk: true };
}

/** The takeoff as the flight chooses it there: a ledge (under a roof), else the jump on the headings 30 degrees apart. */
export interface Tk {
  ledge?: Ledge;
  takeoffYaw?: number;
}
export function takeoffOf(deps: SimDeps & { cell: CellQuery }, skyTop: (x: number, z: number) => number, wide: boolean) {
  return async (at: Vec3): Promise<{ ok: true; takeoff: Tk; how: string } | { ok: false; why: string }> => {
    const t = goal();
    const cz = cruiseHeight(at, t, skyTop, {});
    const l = await ledgeTakeoff(deps, at, t, { cruiseY: cz.y }, 64);
    if (l.ledge) return { ok: true, takeoff: { ledge: l.ledge }, how: l.line };
    if (wide) return { ok: false, why: l.line };
    const j = await jumpTakeoff(deps, at, t, { cruiseY: cz.y }, 64, [0, 30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180]);
    return j.yaw !== undefined ? { ok: true, takeoff: { takeoffYaw: j.yaw }, how: j.line } : { ok: false, why: `${l.line}; ${j.line}` };
  };
}

/** The search's ports over the generated world, counted. */
export function floorDeps(gen: GenWorld, o: { wide?: boolean; worth?: FloorDeps<Tk>['worth'] } = {}): FloorDeps<Tk> & { stats: { takeoffs: number; probes: number; probeMs: number; takeoffMs: number } } {
  const { cell, deps, nav, skyTop } = rig(gen);
  const stats = { takeoffs: 0, probes: 0, probeMs: 0, takeoffMs: 0 };
  const takeoff = takeoffOf(deps, skyTop, o.wide ?? true);
  return {
    q: cell,
    probe: async (g, from, b) => {
      stats.probes++;
      const t0 = performance.now();
      const r = await probePath(nav, g, from, { ...b, noLongFalls: true, body: true });
      stats.probeMs += performance.now() - t0;
      return r;
    },
    takeoff: async (at) => {
      stats.takeoffs++;
      const t0 = performance.now();
      const r = await takeoff(at);
      stats.takeoffMs += performance.now() - t0;
      return r;
    },
    worth: o.worth ?? (() => true),
    yieldNow: () => new Promise((r) => setImmediate(r)),
    stats,
  };
}
