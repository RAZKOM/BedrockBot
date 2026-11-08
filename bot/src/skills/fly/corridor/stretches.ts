// Track F4b (docs/flight.md "Corridor flight"): a fly leg of a coarse corridor cut into what the flight
// does with it. A leg runs through sky volumes (the cruise flies there: FlyProcess, ADR 0055) and through
// volumes underground (caves, tunnels, overhangs: the route planner flies there from standing, a window
// at a time, ADR 0058). Where the two meet the flight changes how it flies:
//  - sky into a mouth (an x / z portal): the cruise lands on the cell just inside it (Track F1's corridor
//    brake under a 3-high roof, Track F3's route landing under a 2-high one), the bore is then flown from
//    standing (Track F3's room takeoff);
//  - sky into a shaft (a y portal, down): the cruise lands on the shaft's floor (the brake over the shaft,
//    then the hover's sink: Track F1 / F3);
//  - under into the sky (out of a mouth or up a shaft): the bore's flight lands on the cell just inside the
//    exit, the next cruise takes off from there (the route takeoff out of a room, the vertical takeoff up a
//    shaft: the takeoff chain of commands-fly.ts).
// Pure functions over the leg and a cell query; the executor (executor.ts) runs the stretches.
import type { RouteGoal } from '../route/types.ts';
import type { Vec3 } from '../../../world/types.ts';
import type { CorridorLeg, Portal } from './coarse-port.ts';
import type { FlightSpace } from './cost.ts';

/** A cell of the world: true solid, false air, undefined not known (not loaded). */
export type CellSolid = (x: number, y: number, z: number) => boolean | undefined;

/** One stretch of a fly leg flown one way. */
export interface Stretch {
  space: 'sky' | 'under';
  /** The leg's waypoints this stretch runs through, its start first. */
  points: Vec3[];
  /** The portals crossed inside the stretch (not the one it starts at). */
  portals: Portal[];
  /** The portal the stretch starts at (the change from the stretch before), undefined for the first. */
  enter?: Portal;
  /** The portal the stretch ends at (the change to the next), undefined for the last. */
  leave?: Portal;
  /** Where the stretch ends: the leg's `to`, or the leave portal's centre. */
  end: Vec3;
}

/** Blocks inside a mouth the landing cell lies (along the portal's axis). */
export const MOUTH_IN = 2;
/** The depth a shaft floor is looked for under its opening. */
export const SHAFT_SCAN = 96;
/** Blocks along the stretch between two waypoint boxes of a window at most (a straight bore gets boxes this far apart). */
export const WINDOW_STEP = 24;
/** How far along its waypoints a stretch is committed to at once (blocks): within the loaded chunks of a view radius of 10 (160 blocks) seen from the window's start, twice over. Each tracker of the chain plans only its own goals (its own snapshot, under the worker's 256 a side). */
export const WINDOW_BLOCKS = 320;
/** The margin round the gliding box in a bore by its narrower side (Track F2's tunnels: 0.3 in 3 x 3, 0.2 in 2 x 2, 0.12 one wide). */
export function boreMargin(width: number, height: number): number {
  const n = Math.min(width, height);
  return n >= 3 ? 0.3 : n >= 2 ? 0.2 : 0.12;
}

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * The leg's stretches. `classify` says what flight a body point asks for (the coarse layer's volumeAt and
 * FlightCost's `flightSpace`), undefined for a solid or unknown point. Every segment between two waypoints
 * is classified by points along it (the body 1 over the feet): its middle, then near its ends; a segment
 * whose points are all undefined keeps the class of the one before (the first: sky).
 */
export function splitLeg(leg: CorridorLeg, classify: (p: Vec3) => FlightSpace | undefined): Stretch[] {
  const w = leg.waypoints.length >= 2 ? leg.waypoints : [leg.from, leg.to];
  // waypoints 1 .. n-2 are the centres of the portals crossed inside the leg (the layer's rule: `portals` also
  // lists the entry and the exit, whose switch points are the leg's ends); a leg without portals has only its ends
  const same = (a: Vec3, b: Vec3): boolean => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.z - b.z) < 1e-6;
  const portalAt = (i: number): Portal | undefined => (w === leg.waypoints && i >= 1 && i <= w.length - 2 ? leg.portals.find((q) => same(q.center, w[i]!)) : undefined);
  const classes: ('sky' | 'under')[] = [];
  for (let i = 0; i + 1 < w.length; i++) {
    const a = w[i]!;
    const b = w[i + 1]!;
    const len = Math.max(1e-6, dist(a, b));
    const at = (t: number): Vec3 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t + 1, z: a.z + (b.z - a.z) * t });
    const ts = [0.5, Math.min(0.5, 1.5 / len), Math.max(0.5, 1 - 1.5 / len), 0.25, 0.75];
    let c: 'sky' | 'under' | undefined;
    for (const t of ts) {
      const k = classify(at(t));
      if (k === 'sky' || k === 'under') {
        c = k;
        break;
      }
    }
    classes.push(c ?? classes[i - 1] ?? 'sky');
  }
  const out: Stretch[] = [];
  let start = 0;
  for (let i = 1; i <= classes.length; i++) {
    if (i < classes.length && classes[i] === classes[start]) continue;
    // segments start .. i-1 form a stretch from waypoint `start` to waypoint `i`
    const points = w.slice(start, i + 1).map((p) => ({ ...p }));
    const portals: Portal[] = [];
    for (let k = start + 1; k < i; k++) {
      const p = portalAt(k);
      if (p) portals.push(p);
    }
    const enter = start > 0 ? portalAt(start) : undefined;
    const leave = i < classes.length ? portalAt(i) : undefined;
    out.push({ space: classes[start]!, points, portals, ...(enter ? { enter } : {}), ...(leave ? { leave } : {}), end: { ...w[i]! } });
    start = i;
  }
  return out;
}

/**
 * A body can stand with its feet in this cell: solid under it, air at the feet and the head (unknown counts as not).
 * Track F6: `solid` is what the flight may not pass (water included: a glide ends in it, a body in it cannot take off,
 * ADR 0068), `floor` what it may stand on (the real solids; default `solid`): a cell over a pool is no landing.
 */
export function standable(solid: CellSolid, x: number, feet: number, z: number, floor: CellSolid = solid): boolean {
  return floor(x, feet - 1, z) === true && solid(x, feet, z) === false && solid(x, feet + 1, z) === false;
}

/** The sign along a portal's axis of a move from `from` to `to` (1: towards the higher coordinate). */
export function axisSign(p: Portal, from: Vec3, to: Vec3): number {
  const d = p.axis === 'x' ? to.x - from.x : p.axis === 'z' ? to.z - from.z : to.y - from.y;
  return d >= 0 ? 1 : -1;
}

/**
 * The feet cell just inside a mouth (an x / z portal) on the side `sign` points to: MOUTH_IN blocks along the axis
 * from the opening's centre at the floor (the portal's floorY, else its centre's y), the nearest standable cell
 * of the opening's cross-section there (the centre first), or the opening's own floor cell. Undefined for a y
 * portal or when no cell is standable.
 */
export function mouthCell(p: Portal, sign: number, solid: CellSolid, depth = MOUTH_IN, floor: CellSolid = solid): Vec3 | undefined {
  if (p.axis === 'y') return undefined;
  const feet = p.floorY ?? Math.floor(p.center.y);
  const tries: Vec3[] = [];
  for (const k of [depth, depth + 1, depth - 1, 1, 0]) {
    if (k < 0) continue;
    const along = p.axis === 'x' ? Math.floor(p.center.x) + sign * k : Math.floor(p.center.z) + sign * k;
    const across0 = p.axis === 'x' ? Math.floor(p.center.z) : Math.floor(p.center.x);
    const lo = p.axis === 'x' ? p.min.z : p.min.x;
    const hi = p.axis === 'x' ? p.max.z : p.max.x;
    const offsets = [0];
    for (let o = 1; o <= hi - lo; o++) offsets.push(o, -o);
    for (const o of offsets) {
      const across = across0 + o;
      if (across < lo || across > hi) continue;
      for (const dy of [0, 1, -1]) tries.push(p.axis === 'x' ? { x: along, y: feet + dy, z: across } : { x: across, y: feet + dy, z: along });
    }
  }
  for (const c of tries) if (standable(solid, c.x, c.y, c.z, floor)) return c;
  return undefined;
}

/** The feet y of the floor under a y portal's centre column (the first solid below the opening), undefined when none is known within SHAFT_SCAN. */
export function shaftFloor(p: Portal, solid: CellSolid, scan = SHAFT_SCAN): number | undefined {
  const x = Math.floor(p.center.x);
  const z = Math.floor(p.center.z);
  const y0 = Math.floor(p.center.y);
  for (let y = y0; y > y0 - scan; y--) {
    const s = solid(x, y, z);
    if (s === undefined) return undefined;
    if (s) return y === y0 ? undefined : y + 1;
  }
  return undefined;
}

/**
 * Where the stretch before a change lands so the next one can start from standing:
 *  - into a mouth: the cell just inside (the side the leg goes on to);
 *  - down a shaft: the shaft's floor;
 *  - out of a mouth: the cell just inside it (on the side the leg comes from);
 *  - up a shaft: the floor under it.
 * Undefined when the cells are not known.
 */
export function changeCell(p: Portal, before: Vec3, after: Vec3, into: 'sky' | 'under', solid: CellSolid, floor: CellSolid = solid): Vec3 | undefined {
  if (p.axis === 'y') {
    // (Track F6: the shaft's floor is a real floor: scanned through water, as before water became an obstacle to `solid`)
    const y = shaftFloor(p, floor);
    return y === undefined ? undefined : { x: Math.floor(p.center.x), y, z: Math.floor(p.center.z) };
  }
  const sign = axisSign(p, before, after);
  // into the bore: inside is ahead; out of it: inside is behind
  return mouthCell(p, into === 'under' ? sign : -sign, solid, MOUTH_IN, floor);
}

/** The waypoint box of a portal crossed in a window: the opening's cells, one cell more each way along its axis (a fast body has a tick end inside). */
export function portalGoal(p: Portal): RouteGoal {
  const ex = p.axis === 'x' ? 1 : 0;
  const ey = p.axis === 'y' ? 1 : 0;
  const ez = p.axis === 'z' ? 1 : 0;
  return { kind: 'waypoint', box: { min: { x: p.min.x - ex, y: p.min.y - ey, z: p.min.z - ez }, max: { x: p.max.x + 1 + ex, y: p.max.y + 1 + ey, z: p.max.z + 1 + ez } } };
}

/** The cells within this many blocks of a window's landing cell (at its feet height, standable) a touchdown may end in: the leg's end is where the flight stops, the walk after it takes the rest. */
export const LANDING_REACH = 2;

/** The landing goal on a feet cell: the cell and the standable cells within LANDING_REACH at the same feet height (a touchdown in any lands). */
export function landingGoal(cell: Vec3, solid: CellSolid, reach = LANDING_REACH, floor: CellSolid = solid): RouteGoal {
  const cells: { x: number; z: number }[] = [{ x: cell.x, z: cell.z }];
  for (let dx = -reach; dx <= reach; dx++) {
    for (let dz = -reach; dz <= reach; dz++) {
      if ((dx || dz) && standable(solid, cell.x + dx, cell.y, cell.z + dz, floor)) cells.push({ x: cell.x + dx, z: cell.z + dz });
    }
  }
  return { kind: 'landing', cell: { x: cell.x, z: cell.z }, top: cell.y, cells };
}

/** The cells a bend's BFS may visit at most, and how far past the two ends' box it may go. */
export const BEND_CELLS = 40_000;
export const BEND_PAD = 8;

/** The line from `a` to `b` (feet positions) is air at the body's height (1 over the feet) every half block. */
export function lineClear(solid: CellSolid, a: Vec3, b: Vec3): boolean {
  const d = dist(a, b);
  const n = Math.max(1, Math.ceil(d / 0.5));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = Math.floor(a.x + (b.x - a.x) * t);
    const y = Math.floor(a.y + (b.y - a.y) * t + 1);
    const z = Math.floor(a.z + (b.z - a.z) * t);
    if (solid(x, y, z) !== false) return false;
  }
  return true;
}

const cellKey = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/**
 * A path of air cells from `a`'s cell to `b`'s (6-connected; the cells the body's height passes, 1 over the
 * feet), within the two ends' box padded by BEND_PAD, at most BEND_CELLS visited; undefined when none.
 */
export function airPath(solid: CellSolid, a: Vec3, b: Vec3, max = BEND_CELLS): Vec3[] | undefined {
  const s = { x: Math.floor(a.x), y: Math.floor(a.y) + 1, z: Math.floor(a.z) };
  const g = { x: Math.floor(b.x), y: Math.floor(b.y) + 1, z: Math.floor(b.z) };
  const lo = { x: Math.min(s.x, g.x) - BEND_PAD, y: Math.min(s.y, g.y) - BEND_PAD, z: Math.min(s.z, g.z) - BEND_PAD };
  const hi = { x: Math.max(s.x, g.x) + BEND_PAD, y: Math.max(s.y, g.y) + BEND_PAD, z: Math.max(s.z, g.z) + BEND_PAD };
  const prev = new Map<string, string | null>([[cellKey(s.x, s.y, s.z), null]]);
  const queue: Vec3[] = [s];
  for (let i = 0; i < queue.length && prev.size < max; i++) {
    const c = queue[i]!;
    if (c.x === g.x && c.y === g.y && c.z === g.z) {
      const out: Vec3[] = [];
      let k: string | null = cellKey(c.x, c.y, c.z);
      while (k) {
        const [x, y, z] = k.split(',').map(Number) as [number, number, number];
        out.push({ x, y: y - 1, z });
        k = prev.get(k) ?? null;
      }
      return out.reverse();
    }
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]] as const) {
      const n = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
      if (n.x < lo.x || n.x > hi.x || n.y < lo.y || n.y > hi.y || n.z < lo.z || n.z > hi.z) continue;
      const k = cellKey(n.x, n.y, n.z);
      if (prev.has(k) || solid(n.x, n.y, n.z) !== false) continue;
      prev.set(k, cellKey(c.x, c.y, c.z));
      queue.push(n);
    }
  }
  return undefined;
}

/** The cell recentred in the bore: along x and z, the middle of the air run through it (at most 2 each way) at the body's height. */
function recentre(solid: CellSolid, c: Vec3): Vec3 {
  const y = c.y + 1;
  const run = (dx: number, dz: number): number => {
    let n = 0;
    while (n < 2 && solid(c.x + dx * (n + 1), y, c.z + dz * (n + 1)) === false) n++;
    return n;
  };
  return { x: c.x + (run(1, 0) - run(-1, 0)) / 2, y: c.y, z: c.z + (run(0, 1) - run(0, -1)) / 2 };
}

/**
 * The bend points between `a` and `b` when the line between them is not clear: the air path pulled tight (from
 * each point the farthest path cell in clear line, at most `step` blocks on), each recentred in the bore. Empty when
 * the line is clear or no path is known.
 */
export function bendPoints(solid: CellSolid, a: Vec3, b: Vec3, step = WINDOW_STEP): Vec3[] {
  if (lineClear(solid, a, b)) return [];
  const path = airPath(solid, a, b);
  if (!path || path.length < 3) return [];
  const out: Vec3[] = [];
  let at = 0;
  let anchor: Vec3 = { ...a };
  while (at < path.length - 1) {
    let far = at + 1;
    for (let j = path.length - 1; j > at + 1; j--) {
      const q = path[j]!;
      if (dist(anchor, q) <= step && lineClear(solid, anchor, { x: q.x + 0.5, y: q.y, z: q.z + 0.5 })) {
        far = j;
        break;
      }
    }
    if (far >= path.length - 1) break;
    const c = recentre(solid, path[far]!);
    out.push(c);
    anchor = { x: c.x + 0.5, y: c.y, z: c.z + 0.5 };
    at = far;
  }
  return out;
}

/** A waypoint box round a bend point (cell coordinates, possibly .5): 3 x 3 cells horizontally (3 x 4 at a half), 3 high from its feet. */
export function bendGoal(c: Vec3): RouteGoal {
  const x0 = Math.floor(c.x - 1);
  const z0 = Math.floor(c.z - 1);
  const x1 = Math.ceil(c.x + 1) + 1;
  const z1 = Math.ceil(c.z + 1) + 1;
  return { kind: 'waypoint', box: { min: { x: x0, y: Math.floor(c.y), z: z0 }, max: { x: x1, y: Math.floor(c.y) + 3, z: z1 } } };
}

/** One window of an underground stretch: the goals from standing at `from`, ending in a landing on `end`. */
export interface Window {
  from: Vec3;
  goals: RouteGoal[];
  /** The feet cell the window lands on. */
  end: Vec3;
  /** The stretch goes on after this window (the window was cut by the loaded chunks or WINDOW_BLOCKS). */
  cut: boolean;
  /** The portals the window passes (its waypoint boxes), in order. */
  portals: Portal[];
  /** The bore's narrowest opening along the window and the margin for it. */
  width: number;
  height: number;
  margin: number;
  blocks: number;
  /** Track F5b: the path length from the start to each goal (the landing last), so a window can be cut back to what a plan reached. */
  goalS: number[];
}

export interface WindowOptions {
  /** A column is loaded (the live model has its chunk). */
  loaded(x: number, z: number): boolean;
  solid: CellSolid;
  /** The stretch's final landing cell (its end on a standable cell: the leg's `to`, or the change cell before the next stretch). */
  endCell: Vec3;
  maxBlocks?: number;
  step?: number;
  /** A tail after the stretch's last bend shorter than this is walked: the window lands before the bend (default UNDER_TAIL_MIN). */
  tailMin?: number;
  /** Track F6: the standable cells within this of the landing cell a touchdown may end in (default LANDING_REACH; the cave style's landing zone is wider). */
  landReach?: number;
  /** Track F6: the cells a body may stand on (the real solids; `solid` has water as an obstacle too). Default `solid`. */
  floor?: CellSolid;
}

/**
 * A tail of a stretch after its last bend shorter than this (blocks) is walked, not flown: flying out of a bend at
 * cruise speed and landing within a few blocks of it failed 4 in 10 offline (the corridor world, the live budget),
 * while a straight bore of up to 96 lands every time.
 */
export const UNDER_TAIL_MIN = 40;
/** A landing before a bend lies at least this far before the bend point (the brake's 4.7 blocks and the slide). */
export const BEND_LAND_BEFORE = 6;

interface Anchor {
  kind: 'portal' | 'bend' | 'step' | 'via';
  goal: RouteGoal;
  point: Vec3;
  portal?: Portal;
  /** Path length from the window's start to this anchor. */
  s: number;
}

/** Track F5b: the waypoint box round a via point (a waypoint of the stretch that is no portal: the owner's `!fly via` hints): 3 x 3 cells, 3 high from its feet. */
export function viaGoal(c: Vec3): RouteGoal {
  const x = Math.floor(c.x);
  const z = Math.floor(c.z);
  const y = Math.floor(c.y);
  return { kind: 'waypoint', box: { min: { x: x - 1, y, z: z - 1 }, max: { x: x + 2, y: y + 3, z: z + 2 } } };
}

/** Track F5b: the standable cell nearest a point (its own cell, then the ring round it at the same feet height, a block up or down), undefined when none. */
export function standableNear(solid: CellSolid, p: Vec3, reach = 2, floor: CellSolid = solid): Vec3 | undefined {
  const x0 = Math.floor(p.x);
  const z0 = Math.floor(p.z);
  const y0 = Math.floor(p.y + 1e-6);
  for (let r = 0; r <= reach; r++) {
    for (let dy = 0; dy <= 2; dy++) {
      for (const y of dy === 0 ? [y0] : [y0 - dy, y0 + dy]) {
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
            if (standable(solid, x0 + dx, y, z0 + dz, floor)) return { x: x0 + dx, y, z: z0 + dz };
          }
        }
      }
    }
  }
  return undefined;
}

/**
 * The next window of an underground stretch from `from` (standing): the stretch's portals ahead of `from` as
 * waypoint boxes, a box every WINDOW_STEP along a long clear straight, and the bend points where the line between
 * two of them leaves the bore (bendPoints), up to the stretch's end. Cut at the first portal or point that is not
 * loaded or lies past WINDOW_BLOCKS, and before the last bend when the tail after it is under `tailMin`: a cut
 * window lands on the floor of its last portal (the opening's floor cell, or the nearest standable cell of it).
 * Undefined when nothing ahead is loaded or no landing is known.
 */
export function nextWindow(s: Stretch, from: Vec3, o: WindowOptions): Window | undefined {
  const max = o.maxBlocks ?? WINDOW_BLOCKS;
  const step = o.step ?? WINDOW_STEP;
  const tailMin = o.tailMin ?? UNDER_TAIL_MIN;
  // the stops still ahead, in the stretch's order: its portals (the first whose plane the body has not passed along the
  // stretch's direction) and, Track F5b, its via points (waypoints that are no portal centre: `!fly via` hints), from the
  // first one still ahead of the body
  const ahead: ({ kind: 'portal'; portal: Portal; point: Vec3 } | { kind: 'via'; point: Vec3 })[] = [];
  {
    const portalOf = (q: Vec3): Portal | undefined => s.portals.find((p) => p.center.x === q.x && p.center.y === q.y && p.center.z === q.z);
    const inner = s.points.slice(1, -1);
    const vias = inner.length > 0 && inner.some((q) => !portalOf(q));
    const stops = vias ? inner.map((q) => ({ portal: portalOf(q), point: q })) : s.portals.map((p) => ({ portal: p, point: p.center }));
    const k = vias ? firstAhead(stops.map((q) => q.point), from, s.points[0]) : 0;
    let passed = true;
    for (const [i, q] of stops.entries()) {
      if (q.portal) {
        if (passed && (!portalAhead(q.portal, from, s) || i < k)) continue;
        passed = false;
        ahead.push({ kind: 'portal', portal: q.portal, point: q.portal.center });
      } else {
        if (passed && i < k) continue;
        passed = false;
        ahead.push({ kind: 'via', point: { x: Math.floor(q.point.x) + 0.5, y: Math.floor(q.point.y), z: Math.floor(q.point.z) + 0.5 } });
      }
    }
  }
  const anchors: Anchor[] = [];
  let at = { ...from };
  let total = 0;
  let cut = false;
  const loadedAt = (p: Vec3): boolean => o.loaded(Math.floor(p.x), Math.floor(p.z));
  /** The anchors between two points: the bend points where the line leaves the bore, else a box every `step` along the clear straight. */
  const between = (a: Vec3, b: Vec3, first: boolean): void => {
    const bends = bendPoints(o.solid, a, b, step);
    let prev = a;
    if (bends.length) {
      for (const q of bends) {
        total += dist(prev, q);
        anchors.push({ kind: 'bend', goal: bendGoal(q), point: q, s: total });
        prev = q;
      }
      total += dist(prev, b);
      return;
    }
    const n = Math.floor(dist(a, b) / step);
    for (let k = 1; k <= n && !first; k++) {
      const t = k / (n + 1);
      const q = { x: Math.floor(a.x + (b.x - a.x) * t), y: Math.floor(a.y + (b.y - a.y) * t), z: Math.floor(a.z + (b.z - a.z) * t) };
      if (o.solid(q.x, q.y, q.z) !== false || o.solid(q.x, q.y + 1, q.z) !== false) continue;
      total += dist(prev, q);
      anchors.push({ kind: 'step', goal: { kind: 'waypoint', box: { min: { x: q.x - 1, y: q.y, z: q.z - 1 }, max: { x: q.x + 2, y: q.y + 2, z: q.z + 2 } } }, point: q, s: total });
      prev = q;
    }
    total += dist(prev, b);
  };
  let firstPortal = true;
  for (const q of ahead) {
    const c = q.point;
    if (total + dist(at, c) > max || !loadedAt(c) || (q.kind === 'portal' && (!loadedAt(q.portal.min) || !loadedAt(q.portal.max)))) {
      cut = true;
      break;
    }
    between(at, c, firstPortal);
    firstPortal = false;
    if (q.kind === 'portal') anchors.push({ kind: 'portal', goal: portalGoal(q.portal), point: { ...c }, portal: q.portal, s: total });
    else anchors.push({ kind: 'via', goal: viaGoal(c), point: { ...c }, s: total });
    at = { ...c };
  }
  let end: Vec3 | undefined;
  let endS = 0;
  if (!cut && (total + dist(at, o.endCell) > max || !loadedAt(o.endCell))) cut = true;
  if (!cut) {
    between(at, o.endCell, firstPortal);
    // the tail rule: a short tail after the last bend is walked (the window lands before the bend)
    let lastBend = -1;
    for (let i = anchors.length - 1; i >= 0; i--) {
      if (anchors[i]!.kind === 'bend') {
        lastBend = i;
        break;
      }
    }
    if (lastBend >= 0 && total - anchors[lastBend]!.s < tailMin) {
      // back to before the bend's first point (its points in a row are one bend), BEND_LAND_BEFORE before it
      let bendS = anchors[lastBend]!.s;
      anchors.length = lastBend;
      for (let a = anchors[anchors.length - 1]; a; a = anchors[anchors.length - 1]) {
        if (a.kind === 'bend') bendS = a.s;
        else if (a.s <= bendS - BEND_LAND_BEFORE) break;
        anchors.pop();
      }
      cut = true;
    } else {
      end = o.endCell;
      endS = total;
    }
  }
  if (cut) {
    // land on the floor of the last portal (or via point) reached (dropping anchors until one has a standable floor); its box gives way to the landing.
    // Track F6: a y face (a sloping bore across a section border) and a step box land on the standable cell nearest them too: on the
    // server a long corridor is cut at the loaded chunks, where the last anchors are chunk-border faces, and with no landing among
    // them the whole stretch was walked (the replica: 0 windows, 361 ticks in water)
    while (anchors.length) {
      const a = anchors[anchors.length - 1]!;
      const c =
        a.kind === 'portal'
          ? a.portal!.axis !== 'y'
            ? mouthCell(a.portal!, 1, o.solid, 0, o.floor)
            : standableNear(o.solid, { x: a.point.x, y: a.portal!.floorY ?? a.point.y, z: a.point.z }, 2, o.floor)
          : a.kind === 'via' || a.kind === 'step'
            ? standableNear(o.solid, a.point, 2, o.floor)
            : undefined;
      anchors.pop();
      if (c) {
        end = c;
        endS = a.s;
        break;
      }
    }
    if (!end) return undefined;
  }
  const goals = [...anchors.map((a) => a.goal), landingGoal(end!, o.solid, o.landReach, o.floor)];
  const portals = anchors.filter((a) => a.kind === 'portal').map((a) => a.portal!);
  let width = Infinity;
  let height = Infinity;
  for (const p of portals) {
    width = Math.min(width, p.axis === 'y' ? Math.min(p.clearance.height, p.clearance.width) : p.clearance.width);
    if (p.axis !== 'y') height = Math.min(height, p.clearance.height);
  }
  if (!Number.isFinite(width)) width = 3;
  if (!Number.isFinite(height)) height = 3;
  return { from: { ...from }, goals, end: { ...end! }, cut, portals, width, height, margin: boreMargin(width, height), blocks: endS, goalS: [...anchors.map((a) => a.s), endS] };
}

/**
 * Track F5b: the index of the first of `points` (in order) still ahead of `from`: the one nearest `from` counts as passed
 * when the body is within 2 blocks of it or beyond it along the line from the point before, else it is still ahead;
 * every point after the nearest is ahead. `points.length` when all are passed.
 */
export function firstAhead(points: readonly Vec3[], from: Vec3, before?: Vec3): number {
  if (!points.length) return 0;
  let k = 0;
  let bd = Infinity;
  for (const [i, q] of points.entries()) {
    const d = Math.hypot(q.x - from.x, q.z - from.z);
    if (d < bd) {
      bd = d;
      k = i;
    }
  }
  if (bd <= 2) return k + 1;
  const q = points[k]!;
  const prev = k > 0 ? points[k - 1]! : before;
  if (prev) {
    const ax = q.x - prev.x;
    const az = q.z - prev.z;
    const bx = from.x - q.x;
    const bz = from.z - q.z;
    if (ax * bx + az * bz > 0) return k + 1; // past it along the line in
  }
  return k;
}

/** The portal's plane is still ahead of `from` along the stretch (the stretch's direction across the portal). */
function portalAhead(p: Portal, from: Vec3, s: Stretch): boolean {
  const i = s.points.findIndex((q) => q.x === p.center.x && q.y === p.center.y && q.z === p.center.z);
  const before = i > 0 ? s.points[i - 1]! : s.points[0]!;
  const sign = axisSign(p, before, p.center);
  const plane = p.axis === 'x' ? p.min.x : p.axis === 'z' ? p.min.z : p.min.y;
  const v = p.axis === 'x' ? from.x : p.axis === 'z' ? from.z : from.y;
  return sign > 0 ? v < plane + 0.5 : v > plane + 0.5;
}
