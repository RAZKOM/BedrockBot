// Track AN (wave 9, docs/home.md "Walking distance"): which containers near home the bot can walk to,
// and how far. Every candidate within `homeChestRadius` gets a cheap bounded probe plan (the miner's
// pattern, skills/mine/wire.ts: a plan only, no walking) from home, or from the bot when it stands at
// home; its path length in blocks is the container's walking distance. The probe runs on the main
// thread in short slices with a yield to the event loop between them, so physics ticks never wait.
//
// Probes never dig or pillar (walking distance: what the bot can walk to without changing the owner's
// base), and use the same goal as the walk to a container (`chestGoal`): within reach 4, no face rule, from any of
// the 8 columns around it with the feet up to 3 blocks below it (stacked chests, shelves, pillars).
import type { Vec3 } from '../../world/types.ts';
import { locateNode, locateStart, PathSearch, type PathNode, type PathOptions, type PathResult } from '../nav/astar.ts';
import type { NavGoal } from '../nav/goals.ts';
import type { NavGrid } from '../nav/grid.ts';
import type { GotoOptions } from '../types.ts';

/** Node budget of one probe (the navigator's main plan in the worker allows 500 000). */
export const PROBE_NODES = 4000;
/** Search time budget of one probe (ms, summed over its slices). */
export const PROBE_MS = 300;
/** One slice of a probe (ms); the event loop runs between slices. */
export const PROBE_SLICE_MS = 8;

/** Track K2: the chests at home count as in reach this many blocks beyond `homeChestRadius` (across) from home ... */
export const HOME_REACH_EXTRA = 8;
/** ... and this many blocks above or below it. */
export const HOME_REACH_DY = 16;

/**
 * Track K2 (ADR 0096 addendum): are the chests at home in reach of the bot (`!milk`, the chore, the trip readiness; Track
 * K3: the room a take makes first)? The home logistics' own "at home" (8 blocks across, 4 up or down) left them out for
 * a bot idle in its shelter, a room or a floor away from the home point. The withdrawal walks to the chests itself
 * (`!bring` does it from anywhere); this only bounds the walk: within `chestRadius` + HOME_REACH_EXTRA of home across (the
 * containers are found within `chestRadius` of it) and HOME_REACH_DY up or down. `why` says why not.
 */
export function homeChestReach(home: Vec3 | undefined, feet: Vec3 | undefined, chestRadius: number): { inReach: boolean; why?: string } {
  if (!home) return { inReach: false, why: 'no home set' };
  if (!feet) return { inReach: false, why: 'my position is unknown' };
  const reach = Math.max(0, chestRadius) + HOME_REACH_EXTRA;
  const across = Math.hypot(feet.x - (home.x + 0.5), feet.z - (home.z + 0.5));
  if (across > reach) return { inReach: false, why: `I am ${Math.round(across)} blocks from home (they count within ${reach})` };
  const dy = feet.y - home.y;
  if (Math.abs(dy) > HOME_REACH_DY) return { inReach: false, why: `I am ${Math.round(Math.abs(dy))} blocks ${dy > 0 ? 'above' : 'below'} home (they count within ${HOME_REACH_DY} up or down)` };
  return { inReach: true };
}

/** The walk to a container: within reach 4, no face rule, feet at most 3 blocks below it in a side column. */
export function chestGoal(p: Vec3): NavGoal {
  // face: false (main's rule for every container goal): a chest inside a stack or a wall of chests has no face turned to any stand cell
  return { type: 'getToBlock', p: { x: p.x, y: p.y, z: p.z }, reach: 4, face: false, low: 3 };
}

/** Length of a path in blocks (cell centres at the feet height, start to end). */
export function pathBlocks(path: readonly Pick<PathNode, 'x' | 'z' | 'feet'>[]): number {
  let len = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    len += Math.hypot(b.x - a.x, b.feet - a.feet, b.z - a.z);
  }
  return len;
}

export type ProbeVerdict =
  /** A path to the container within the limit (blocks). */
  | { ok: true; blocks: number }
  | { ok: false; reason: string; blocks?: number };

/** What a probe result means for a walk limit (`walk` path blocks; 0 = no limit). */
/** The feet cell the probe's path ends in: the stand cell to walk to (the goal's own choice may be far: a cell on the other side of a wall). */
export function standOf(r: PathResult | undefined): Vec3 | undefined {
  if (r?.status !== 'found' || r.path.length === 0) return undefined;
  const n = r.path[r.path.length - 1]!;
  return { x: n.x, y: n.y, z: n.z };
}

export function verdict(r: PathResult, walk: number, nodes = PROBE_NODES): ProbeVerdict {
  if (r.status === 'found') {
    const blocks = pathBlocks(r.path);
    if (walk > 0 && blocks > walk) return { ok: false, reason: `path ${Math.round(blocks)} blocks`, blocks };
    return { ok: true, blocks };
  }
  if (r.status === 'none') return { ok: false, reason: 'no path' };
  if (r.limited) return { ok: false, reason: `no path within ${nodes} nodes` };
  return { ok: false, reason: 'no path in the loaded world' }; // partial without a limit: every loaded cell tried, unloaded ones at the edge
}

/** What a probe needs from the navigator (Navigator satisfies it). */
export interface ProbeNav {
  readonly grid: NavGrid;
  planOptions(options?: GotoOptions): PathOptions;
}

const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * One bounded probe plan from `from` (feet) to `goal`, sliced; undefined when `from` is no standable
 * node (then nothing can be said about any container). `noLongFalls` (Track BH): without Track BI's
 * planned long drops (a flight's landing must be walkable without fall damage).
 *
 * Track R6: `body` (the caller's `from` is the body's own feet, where it stands now: the mine's walk probe, the
 * guard's probe to a mob): a body resting on a top the stand rule has no node for (a fence's) starts from that perch
 * (astar `locateStart`), as the goto it stands for does (Track R5). Without it (the default) `from` is a cell the
 * caller only considers (a landing cell of the flight's site search, home's floor): `locateNode` only, so a fence's
 * top is never taken for a floor to walk from (Track F11: a floor on a fence, a wall or a post is no landing cell).
 */
export async function probePath(nav: ProbeNav, goal: NavGoal, from: Vec3, budget: { nodes?: number; ms?: number; noLongFalls?: boolean; body?: boolean } = {}): Promise<PathResult | undefined> {
  const start = budget.body ? locateStart(nav.grid, from) : locateNode(nav.grid, from);
  if (!start) return undefined;
  const opts: PathOptions = { ...nav.planOptions({ allowBreak: false, allowPlace: false, sprint: false }), maxNodes: budget.nodes ?? PROBE_NODES, maxMs: budget.ms ?? PROBE_MS };
  if (start.perch) opts.startFeet = start.feet; // Track R6: from the perch the body is on
  if (budget.noLongFalls) delete opts.falls;
  const search = new PathSearch(nav.grid, start, goal, opts);
  for (;;) {
    const r = search.step(PROBE_SLICE_MS);
    if (r) return r.path.length === 0 ? undefined : r; // an empty path: the start is not standable
    await yieldLoop();
  }
}

/** Track CA: budget of the nearest-open-sky probe (`probeOpenSky`): a mineshaft's top can be 100+ path blocks away. */
export const EXIT_PROBE_NODES = 40_000;
export const EXIT_PROBE_MS = 1500;

/**
 * Track CA: the nearest open sky the bot can walk to from `from` (the `surface` goal: sky over the head,
 * not in a pit), by path, never digging or pillaring and without long falls: the stand cell and its path
 * length in blocks, or why there is none. From the foot of a mineshaft this is the shaft's top, wherever
 * the straight line to the goal points (the walk out of commands-fly.ts used to take a cell on that line).
 */
export async function probeOpenSky(nav: ProbeNav, from: Vec3, budget: { nodes?: number; ms?: number } = {}): Promise<{ at: Vec3; blocks: number } | { why: string }> {
  const r = await probePath(nav, { type: 'surface' }, from, { nodes: budget.nodes ?? EXIT_PROBE_NODES, ms: budget.ms ?? EXIT_PROBE_MS, noLongFalls: true });
  const at = standOf(r);
  if (!r || !at) return { why: r ? `${r.status}${r.limited ? ', search limit hit' : ''}${r.unknown ? ', touched unloaded world' : ''}` : 'no standable start' };
  return { at, blocks: pathBlocks(r.path) };
}
