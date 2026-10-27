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
import { locateNode, PathSearch, type PathNode, type PathOptions, type PathResult } from '../nav/astar.ts';
import type { NavGoal } from '../nav/goals.ts';
import type { NavGrid } from '../nav/grid.ts';
import type { GotoOptions } from '../types.ts';

/** Node budget of one probe (the navigator's main plan in the worker allows 500 000). */
export const PROBE_NODES = 4000;
/** Search time budget of one probe (ms, summed over its slices). */
export const PROBE_MS = 300;
/** One slice of a probe (ms); the event loop runs between slices. */
export const PROBE_SLICE_MS = 8;

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
 * node (then nothing can be said about any container).
 */
export async function probePath(nav: ProbeNav, goal: NavGoal, from: Vec3, budget: { nodes?: number; ms?: number } = {}): Promise<PathResult | undefined> {
  const start = locateNode(nav.grid, from);
  if (!start) return undefined;
  const opts: PathOptions = { ...nav.planOptions({ allowBreak: false, allowPlace: false, sprint: false }), maxNodes: budget.nodes ?? PROBE_NODES, maxMs: budget.ms ?? PROBE_MS };
  const search = new PathSearch(nav.grid, start, goal, opts);
  for (;;) {
    const r = search.step(PROBE_SLICE_MS);
    if (r) return r.path.length === 0 ? undefined : r; // an empty path: the start is not standable
    await yieldLoop();
  }
}
