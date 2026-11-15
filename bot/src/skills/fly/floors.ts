// Track F15 (docs/flight.md "Takeoff from a floor the walk reaches (Track F15)"; decisions/0087-takeoff-from-a-floor-the-walk-reaches.md):
//
//   When the takeoff from where the body stands is refused and the open-sky takeoff sites (sites.ts) give nothing, a
//   floor the walk reaches may still have a ledge to step off: the roof of a room in a building in the air, reached by
//   the ladder and the hatch the walk planner climbs and passes (the Realm, 2026-11-14: `unreachable` from inside such a
//   room, flown home from its roof the next day). This module finds those floors:
//
//   - `ledgeFloors`: the standable cells within FLOOR_RADIUS blocks and FLOOR_BELOW / FLOOR_ABOVE levels of the feet whose
//     side or corner opens onto a drop of LEDGE_MIN_DROP or more (glide.ts findLedges' own test of an edge), grouped into
//     floors (the standable cells at one height joined side by side); the start's own floor is left out (its ledges were
//     tried already). One cell stands for each floor: its edge cell nearest the feet.
//   - `searchFloors`: the walk probed to ALL of those cells at once (one planner search with an `any` goal: the floor the
//     walk reaches most cheaply comes first, whatever the walk climbs: ladders, hatches, doors, stairs), the takeoff from
//     the cell it reaches simulated (the caller's whole takeoff chain), that floor dropped from the goal and the probe run
//     again, at most FLOOR_PROBES probes, FLOOR_SIMS takeoffs and FLOOR_BUDGET_MS. The first floor whose takeoff clears and
//     whose walk is worth it (the caller's flyPreferRatio rule) is the site. None: the line says why, and the words for
//     the owner say it short (no floor with an edge, none the walk reaches, or each one reached and why its takeoff failed).
//
// Pure over the world model and the planner's probe: commands-fly.ts wires them (takeoffSite, after the open-sky sites).
import type { Vec3 } from '../../connection/types.ts';
import type { PathResult } from '../nav/astar.ts';
import type { NavGoal } from '../nav/goals.ts';
import { dropAt, LEDGE_MIN_DROP, standable } from './glide.ts';
import type { CellQuery } from './plan.ts';

/** Floors are looked for within this many blocks of the feet, horizontally ... */
export const FLOOR_RADIUS = 24;
/** ... from this many levels under the feet ... */
export const FLOOR_BELOW = 16;
/** ... to this many over them (a tower's top up its stair). */
export const FLOOR_ABOVE = 32;
/** The floors one probe is given at the most, the nearest first (the planner's `any` goal prices each node by all of them). */
export const FLOOR_MAX = 48;
/** Walk probes, takeoff simulations and the time budget (ms) of one search. */
export const FLOOR_PROBES = 4;
export const FLOOR_SIMS = 4;
export const FLOOR_BUDGET_MS = 3000;
/** One probe's node and time budget (the open-sky sites' probe is 6000 / 400 ms; a ladder and a hatch cost more nodes than a level walk). */
export const FLOOR_PROBE_NODES = 20_000;
export const FLOOR_PROBE_MS = 1000;
/** The scan yields to the event loop after this many columns. */
const SCAN_SLICE = 256;

/** A floor with a ledge: the cell standing for it (an edge cell, feet height) and what it is. */
export interface LedgeFloor {
  x: number;
  z: number;
  feet: number;
  /** The floor's id (its cells share it). */
  id: number;
  /** Standable cells of the floor, and of those the edge cells (a side or a corner onto LEDGE_MIN_DROP or more). */
  cells: number;
  edges: number;
  /** Straight-line distance from the feet to the cell (3D). */
  dist: number;
}

const key3 = (x: number, y: number, z: number): number => ((x + 32768) * 65536 + (z + 32768)) * 1024 + (y + 512);
const air = (q: CellQuery, x: number, y: number, z: number): boolean => q(x, y, z) === false;

/**
 * An edge cell: standable, and a side or a corner (both sides open for a corner, as the body's box passes it) opens onto a
 * cell with the feet, the head and the floor level open and LEDGE_MIN_DROP or more of drop under it (findLedges' rule).
 */
export function edgeCell(q: CellQuery, x: number, feet: number, z: number, minDrop = LEDGE_MIN_DROP): boolean {
  if (standable(q, x, feet, z) !== true) return false;
  const open = (cx: number, cz: number): boolean => air(q, cx, feet, cz) && air(q, cx, feet + 1, cz) && air(q, cx, feet - 1, cz);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue;
      if (!open(x + dx, z + dz)) continue;
      if (dx !== 0 && dz !== 0 && (!open(x + dx, z) || !open(x, z + dz))) continue;
      const d = dropAt(q, x + dx, feet, z + dz);
      if (d !== undefined && d >= minDrop) return true;
    }
  }
  return false;
}

/**
 * The floors with a ledge round `from` (see the file's head), the nearest cell first; `cells` the standable cells scanned.
 * The start's own floor (the standable cells at its feet joined to it) is left out.
 */
export async function ledgeFloors(
  q: CellQuery,
  from: Vec3,
  o: { radius?: number; below?: number; above?: number; minDrop?: number; max?: number; yieldNow?: () => Promise<void> } = {},
): Promise<{ floors: LedgeFloor[]; cells: number; edgeCells: number; ms: number }> {
  const t0 = performance.now();
  const radius = o.radius ?? FLOOR_RADIUS;
  const minDrop = o.minDrop ?? LEDGE_MIN_DROP;
  const fx = Math.floor(from.x);
  const fz = Math.floor(from.z);
  const fy = Math.floor(from.y + 1e-3);
  const lo = fy - (o.below ?? FLOOR_BELOW);
  const hi = fy + (o.above ?? FLOOR_ABOVE);
  // the standable cells (key -> feet), each column read once from the top down
  const stand = new Set<number>();
  const edges: { x: number; y: number; z: number }[] = [];
  let cols = 0;
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (dx * dx + dz * dz > radius * radius) continue;
      const x = fx + dx;
      const z = fz + dz;
      if (++cols % SCAN_SLICE === 0 && o.yieldNow) await o.yieldNow();
      let head = q(x, hi + 1, z);
      let feetC = q(x, hi, z);
      for (let y = hi; y >= lo; y--) {
        const under = q(x, y - 1, z);
        if (under === true && feetC === false && head === false) {
          stand.add(key3(x, y, z));
          if (edgeCell(q, x, y, z, minDrop)) edges.push({ x, y, z });
        }
        head = feetC;
        feetC = under;
      }
    }
  }
  // the floors: the standable cells at one height joined side by side, flooded from each edge cell not yet in one
  const floorOf = new Map<number, number>();
  const sizes: number[] = [];
  const flood = (sx: number, y: number, sz: number, id: number): void => {
    const queue: (readonly [number, number])[] = [[sx, sz]];
    floorOf.set(key3(sx, y, sz), id);
    // (a for-of over the queue sees the cells pushed while it runs: a breadth-first flood)
    for (const [cx, cz] of queue) {
      for (const [ddx, ddz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const k = key3(cx + ddx, y, cz + ddz);
        if (!stand.has(k) || floorOf.has(k)) continue;
        floorOf.set(k, id);
        queue.push([cx + ddx, cz + ddz]);
      }
    }
    sizes[id] = queue.length;
  };
  const startKey = key3(fx, fy, fz);
  if (stand.has(startKey)) flood(fx, fy, fz, 0);
  else sizes[0] = 0;
  let next = 1;
  const best = new Map<number, LedgeFloor>();
  for (const e of edges) {
    const k = key3(e.x, e.y, e.z);
    if (!floorOf.has(k)) flood(e.x, e.y, e.z, next++);
    const id = floorOf.get(k)!;
    if (id === 0) continue; // the start's own floor
    const dist = Math.hypot(e.x + 0.5 - from.x, e.y - from.y, e.z + 0.5 - from.z);
    const b = best.get(id);
    if (b) {
      b.edges++;
      if (dist < b.dist) Object.assign(b, { x: e.x, z: e.z, feet: e.y, dist });
    } else best.set(id, { x: e.x, z: e.z, feet: e.y, id, cells: sizes[id] ?? 0, edges: 1, dist });
  }
  const floors = [...best.values()].sort((a, b) => a.dist - b.dist).slice(0, o.max ?? FLOOR_MAX);
  return { floors, cells: stand.size, edgeCells: edges.length, ms: performance.now() - t0 };
}

/** A floor site: the cell to walk to (feet), the walk there (blocks of the probed path) and the takeoff the caller simulated from it. */
export interface FloorSite<T> {
  x: number;
  feet: number;
  z: number;
  walk: number;
  takeoff: T;
  /** The floor's size (cells) and edge cells, for the line. */
  cells: number;
  edges: number;
}

export interface FloorSearch<T> {
  site?: FloorSite<T>;
  /** The whole search for the log. */
  line: string;
  /** Why no floor gave a takeoff, short, for the owner (undefined with a site). */
  said?: string;
  floors: number;
  probes: number;
  reached: number;
  sims: number;
  ms: number;
  /** The last probe reached none of the floors left and searched all the walk reaches (no limit hit, no unloaded world): that many nodes. */
  closed?: number;
}

export interface FloorDeps<T> {
  q: CellQuery;
  /** One walk probe from the feet (the planner's search: no digging, no placing, no long falls), as commands-fly.ts runs it. */
  probe: (goal: NavGoal, from: Vec3, budget: { nodes: number; ms: number }) => Promise<PathResult | undefined>;
  /** The takeoff from a cell (feet), simulated with the flight's chain: the takeoff, or why not. */
  takeoff: (at: Vec3) => Promise<{ ok: true; takeoff: T; how: string } | { ok: false; why: string }>;
  /** The walk there (blocks) and the flight from there beat walking the whole way (sites.ts preferSite). */
  worth: (walk: number, at: Vec3) => boolean;
  now?: () => number;
  yieldNow?: () => Promise<void>;
}

const cellName = (f: { x: number; feet: number; z: number }): string => `${f.x} ${f.feet} ${f.z}`;

/**
 * The search for a floor the walk reaches with a takeoff (see the file's head). Bounded: FLOOR_PROBES probes, FLOOR_SIMS
 * takeoffs, FLOOR_BUDGET_MS (the scan included).
 */
export async function searchFloors<T>(d: FloorDeps<T>, from: Vec3, o: { radius?: number; probes?: number; sims?: number; budgetMs?: number; nodes?: number; probeMs?: number } = {}): Promise<FloorSearch<T>> {
  const now = d.now ?? (() => performance.now());
  const t0 = now();
  const radius = o.radius ?? FLOOR_RADIUS;
  const budget = o.budgetMs ?? FLOOR_BUDGET_MS;
  const scan = await ledgeFloors(d.q, from, { radius, ...(d.yieldNow ? { yieldNow: d.yieldNow } : {}) });
  const head = `${scan.floors.length} other floor${scan.floors.length === 1 ? '' : 's'} with an edge of ${LEDGE_MIN_DROP}+ blocks of fall within ${radius} (${scan.cells} standable cells, ${scan.edgeCells} on an edge, scanned in ${Math.round(scan.ms)} ms)`;
  const out = (r: Omit<FloorSearch<T>, 'floors' | 'ms' | 'line'> & { tail: string }): FloorSearch<T> => {
    const { tail, ...rest } = r;
    const ms = now() - t0;
    return { ...rest, floors: scan.floors.length, ms, line: `${head}, ${r.probes} walk probe${r.probes === 1 ? '' : 's'}, ${r.reached} reached, ${r.sims} takeoff${r.sims === 1 ? '' : 's'} simulated in ${Math.round(ms)} ms: ${tail}` };
  };
  if (!scan.floors.length) return out({ probes: 0, reached: 0, sims: 0, tail: 'none', said: `none within ${radius} has an edge with ${LEDGE_MIN_DROP} blocks of fall` });
  let left = scan.floors;
  let probes = 0;
  let sims = 0;
  let closed: number | undefined;
  let stop = '';
  const reached: { f: LedgeFloor; walk: number; why: string }[] = [];
  while (left.length) {
    if (probes >= (o.probes ?? FLOOR_PROBES) || sims >= (o.sims ?? FLOOR_SIMS) || now() - t0 > budget) {
      stop = `the search's limit (${probes} probes, ${sims} takeoffs, ${Math.round(now() - t0)} ms)`;
      break;
    }
    probes++;
    const goal: NavGoal = { type: 'any', goals: left.map((f) => ({ type: 'block', p: { x: f.x, y: f.feet, z: f.z } })) };
    const r = await d.probe(goal, from, { nodes: o.nodes ?? FLOOR_PROBE_NODES, ms: o.probeMs ?? FLOOR_PROBE_MS });
    if (!r) {
      stop = 'no standable start for the walk';
      break;
    }
    if (r.status !== 'found') {
      if (r.status === 'none' && !r.limited && !r.unknown) closed = r.expanded;
      stop = `the walk reaches none of the ${left.length} left (${r.status}${r.limited ? ', the probe\'s limit' : ''}${r.unknown ? ', unloaded world' : ''}, ${r.expanded} nodes)`;
      break;
    }
    const end = r.path[r.path.length - 1]!;
    const f = left.find((g) => g.x === end.x && g.feet === end.y && g.z === end.z);
    if (!f) {
      stop = `the probe ended at ${end.x} ${end.y} ${end.z}, no floor's cell`;
      break;
    }
    left = left.filter((g) => g.id !== f.id);
    const walk = r.path.reduce((s, n, i) => (i ? s + Math.hypot(n.x - r.path[i - 1]!.x, n.feet - r.path[i - 1]!.feet, n.z - r.path[i - 1]!.z) : 0), 0);
    const at = { x: f.x + 0.5, y: f.feet, z: f.z + 0.5 };
    if (!d.worth(walk, at)) {
      reached.push({ f, walk, why: `a ${Math.round(walk)}-block walk, not worth it` });
      continue;
    }
    sims++;
    const tk = await d.takeoff(at);
    if (tk.ok) {
      return out({
        site: { x: f.x, feet: f.feet, z: f.z, walk, takeoff: tk.takeoff, cells: f.cells, edges: f.edges },
        probes,
        reached: reached.length + 1,
        sims,
        tail: `${cellName(f)} (a floor of ${f.cells} cells, ${f.edges} on an edge, ${Math.round(walk)} blocks of walk, ${f.feet - Math.floor(from.y + 1e-3)} levels up): ${tk.how}${reached.length ? `; before it ${reached.map((x) => `${cellName(x.f)}: ${x.why}`).join(', ')}` : ''}`,
      });
    }
    reached.push({ f, walk, why: tk.why });
  }
  const tail = `none${reached.length ? ` (${reached.map((x) => `${cellName(x.f)}, ${Math.round(x.walk)} blocks of walk: ${x.why}`).join('; ')})` : ''}${stop ? `; ${stop}` : ''}`;
  // (the owner's words: a reply is 256 characters, so the first floor's reason only, cut short; the log has the rest)
  const reach = closed !== undefined ? `, all it reaches is ${closed} cells` : '';
  const said = reached.length
    ? `${reached.length} reached, ${cellName(reached[0]!.f)}: ${reached[0]!.why.slice(0, 80)}`
    : `none of ${scan.floors.length} with an edge within ${radius}${reach}`;
  return out({ probes, reached: reached.length, sims, tail, said, ...(closed !== undefined ? { closed } : {}) });
}
