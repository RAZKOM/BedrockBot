// Track F4a (docs/flight.md "Obstacle course (Track F4a)", decisions/0067): the obstacle courses of the flight
// benchmark as pure data. No @minecraft/server imports: the pack builds a layout with `truth:course` (course.ts),
// the bot flies the very same geometry offline (bot/src/skills/fly/route/courses.ts turns a layout into a world
// over the flat ground and the route goals) and on the server (bot/test/e2e/fly-course.test.ts).
//
// A layout is deterministic in (name, origin): its ops clear the volume first (air from the feet height up, the
// flat world's dirt and grass under it), then build the stations in order. The origin is the feet height of the
// ground at the course's start (y -60 on the flat world); every course runs along +z (yaw 0) from it.
//
//   rings     five 5 x 5 frames with 3 x 3 openings 18 apart at heights 7, 12, 6, 14 and 8
//   slalom    five walls 16 high with a 3-wide gap each, alternating 3 left and right of the line, 14 apart
//   tunnel    a 3 x 3 S-tunnel (two arcs of radius 10, 45 degrees each way) with an open entrance and exit, 5 up
//   stair     the 45-degree staircase 3 high (the benchmark's stair45-3high) with an open exit at its top
//   overhang  a ledge 8 up against a cliff under a roof 4 above it that overhangs the ledge's front
//   stack     the owner's stacked platforms: 3 x 3 at y+20 and y+23 (the landing on the inner one, 2 high)
//   shaft     a 1 x 1 shaft 10 deep in a 7 x 7 block (the landing on its floor)
//   full      the stations in a row with a start pad (in the stair) and a finish pad, flown as chained legs
//
// The bore geometry (centreline, carve, runs) was F2's (route/courses.ts) and moved here so the pack and the bot
// share it; the benchmark's standard tunnels are unchanged.
import type { Vec3 } from './protocol.js';

/** The blocks a course is built of (the namespace is minecraft:). */
export type CourseBlock = 'air' | 'stone' | 'dirt' | 'grass_block' | 'gold_block';

export interface CourseOp {
  from: Vec3;
  to: Vec3;
  block: CourseBlock;
}

/** Inclusive block corners. */
export interface CellBox {
  min: Vec3;
  max: Vec3;
}

/**
 * A goal of a leg: pass a box (`box`: block coordinates, `max` exclusive, as the route planner's RegionBox) or land
 * on cells (`land`: the floor's cells, the feet height on it, a shaft's rim, the ceiling over it; the bearing the
 * landing is approached along, from the cells outwards).
 */
export type CourseGoal =
  | { kind: 'box'; min: Vec3; max: Vec3; label: string }
  | { kind: 'land'; cells: { x: number; z: number }[]; top: number; rim?: number; ceiling?: number; bearing: number; label: string };

export interface CourseStart {
  /** Feet. A gliding start is put into the air here (the e2e teleports the body there and asks for the glide). */
  pos: Vec3;
  yaw: number;
  /** The horizontal speed along `yaw` of a gliding start offline (the server's body starts from a fall). */
  speed: number;
  standing?: boolean;
  rockets: number;
}

export interface CourseLeg {
  name: string;
  /** Where the leg starts when it is flown alone (and the first leg of a chain). */
  start: CourseStart;
  /** The leg continues from where the previous one ended (gliding on, or standing where it landed). */
  chained: boolean;
  goals: CourseGoal[];
  /** The margin round the gliding box the route planner keeps (the narrowest passage of the leg). */
  margin: number;
}

export interface CourseLayout {
  name: string;
  origin: Vec3;
  /** The volume the ops clear and build (the ground layers included). */
  bounds: CellBox;
  ops: CourseOp[];
  legs: CourseLeg[];
}

export const COURSE_NAMES = ['rings', 'slalom', 'tunnel', 'stair', 'overhang', 'stack', 'shaft', 'full'] as const;
export type CourseName = (typeof COURSE_NAMES)[number];

// ---------------------------------------------------------------- bore geometry (F2's tunnels)

/** A segment of a tunnel's centreline. */
export type Segment =
  | { kind: 'straight'; len: number }
  /** An arc of `radius` turning `deg` degrees (positive = right-hand, as Bedrock yaw grows). */
  | { kind: 'arc'; radius: number; deg: number }
  /** A sharp corner: the heading turns `deg` on the spot (the bore is carved square there). */
  | { kind: 'corner'; deg: number }
  /** A straight of `len` rising `dy` blocks in all (negative = a drop). */
  | { kind: 'slope'; len: number; dy: number };

/** A cell key (x and z within +-32768 of 0, y within -512..511). */
export const cellKey = (x: number, y: number, z: number): number => ((x + 32768) & 0xffff) * 0x4000000 + ((y + 512) & 0x3ff) * 0x10000 + ((z + 32768) & 0xffff);
/** The centreline's sample step (blocks). */
export const STEP = 0.25;

/** The horizontal unit vector of a Bedrock yaw (0 = +z, 90 = -x). */
export function yawVector(yaw: number): { x: number; z: number } {
  const r = (yaw * Math.PI) / 180;
  return { x: -Math.sin(r), z: Math.cos(r) };
}

export interface Sample {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** The index of the segment the sample belongs to. */
  seg: number;
}

/** Sample the centreline of `segments` from `origin` heading `yaw0` every STEP blocks. */
export function centreline(origin: Vec3, yaw0: number, segments: readonly Segment[]): Sample[] {
  const out: Sample[] = [];
  let x = origin.x;
  let y = origin.y;
  let z = origin.z;
  let yaw = yaw0;
  out.push({ x, y, z, yaw, seg: 0 });
  segments.forEach((sg, si) => {
    if (sg.kind === 'straight' || sg.kind === 'slope') {
      const n = Math.round(sg.len / STEP);
      const dy = sg.kind === 'slope' ? sg.dy / n : 0;
      const d = yawVector(yaw);
      for (let i = 0; i < n; i++) {
        x += d.x * STEP;
        z += d.z * STEP;
        y += dy;
        out.push({ x, y, z, yaw, seg: si });
      }
    } else if (sg.kind === 'arc') {
      const n = Math.round((Math.abs(sg.deg) * (Math.PI / 180) * sg.radius) / STEP);
      const dyaw = sg.deg / n;
      for (let i = 0; i < n; i++) {
        yaw += dyaw / 2;
        const d = yawVector(yaw);
        x += d.x * STEP;
        z += d.z * STEP;
        yaw += dyaw / 2;
        out.push({ x, y, z, yaw, seg: si });
      }
    } else {
      yaw += sg.deg;
      out.push({ x, y, z, yaw, seg: si });
    }
  });
  return out;
}

/** The lateral offsets a bore `w` wide is carved at: every eighth of a block across the width (the band's every cell at any heading, a stair band on a diagonal). */
function lateral(w: number): number[] {
  const out: number[] = [];
  for (let k = -w / 2 + 0.0625; k < w / 2; k += 0.125) out.push(k);
  return out;
}

/** The cells a bore of `w` x `h` carves along the samples. */
export function carve(samples: readonly Sample[], w: number, h: number): Map<number, Vec3> {
  const cells = new Map<number, Vec3>();
  for (const s of samples) {
    const d = yawVector(s.yaw);
    const n = { x: d.z, z: -d.x }; // the perpendicular
    const y0 = Math.floor(s.y + 1e-6);
    for (const k of lateral(w)) {
      const cx = Math.floor(s.x + n.x * k);
      const cz = Math.floor(s.z + n.z * k);
      for (let y = y0; y < y0 + h; y++) cells.set(cellKey(cx, y, cz), { x: cx, y, z: cz });
    }
  }
  return cells;
}

/** Axis-aligned run-length boxes of a cell set (runs along x). */
export function runsOf(cells: Iterable<Vec3>, block: CourseBlock): CourseOp[] {
  const sorted = [...cells].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
  const out: CourseOp[] = [];
  let run: CourseOp | undefined;
  for (const c of sorted) {
    if (run?.to.y === c.y && run.to.z === c.z && run.to.x === c.x - 1) run.to = { ...c };
    else {
      run = { from: { ...c }, to: { ...c }, block };
      out.push(run);
    }
  }
  return out;
}

/** The bounding box (inclusive cells) of cells. */
export function bbox(cells: Iterable<Vec3>): CellBox {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const c of cells) {
    min.x = Math.min(min.x, c.x);
    min.y = Math.min(min.y, c.y);
    min.z = Math.min(min.z, c.z);
    max.x = Math.max(max.x, c.x);
    max.y = Math.max(max.y, c.y);
    max.z = Math.max(max.z, c.z);
  }
  return { min, max };
}

/** Ops of a solid box, split into slabs along z of at most 32 000 blocks (the server's fill limit). */
export function slabs(min: Vec3, max: Vec3, block: CourseBlock): CourseOp[] {
  const out: CourseOp[] = [];
  const dx = max.x - min.x + 1;
  const dy = max.y - min.y + 1;
  const per = Math.max(1, Math.floor(32000 / (dx * dy)));
  for (let z = min.z; z <= max.z; z += per) out.push({ from: { x: min.x, y: min.y, z }, to: { x: max.x, y: max.y, z: Math.min(max.z, z + per - 1) }, block });
  return out;
}

export interface BoreOptions {
  w: number;
  h: number;
  segments: readonly Segment[];
  /** The bore's first sample (the centre of the cross-section's floor cell row, feet height). */
  origin: Vec3;
  yaw: number;
  rockets?: number;
  /** The entry: gliding at this speed `entry` blocks into the bore (default 1.2 at 3), or standing (`standing`). */
  speed?: number;
  entry?: number;
  standing?: boolean;
  /** Rock around the bore (blocks; default 3). */
  shell?: number;
  /** A waypoint at the end of every segment (default true) besides the exit. */
  segmentWaypoints?: boolean;
  /** The bore carries on through the shell at its end (the body flies out into the open after the exit; the benchmark's are sealed). */
  openExit?: boolean;
  /** An open entrance: the bore starts this many blocks before `origin` in the open (the start state lies on that approach, `entry` blocks along it). */
  approach?: number;
}

export interface Bore {
  /** The carved cells (the approach and the open exit included). */
  cells: Map<number, Vec3>;
  /** The stone hull round the inner bore (inclusive). */
  hull: CellBox;
  /** The hull in stone (slabs), then the bore in air (runs). */
  ops: CourseOp[];
  /** The waypoint boxes (`max` exclusive): the entrance (an approach), the segment ends, the exit. */
  goals: { min: Vec3; max: Vec3 }[];
  start: CourseStart;
}

/** A tunnel: the bore carved through a stone hull, waypoints at the segment ends and the exit. */
export function bore(o: BoreOptions): Bore {
  // the centreline of an odd bore runs through cell centres, an even one along cell boundaries
  const snap = (v: number): number => (o.w % 2 ? Math.floor(v) + 0.5 : Math.round(v));
  const origin0 = { x: snap(o.origin.x), y: o.origin.y, z: snap(o.origin.z) };
  const shell = o.shell ?? 3;
  const inner = carve(centreline(origin0, o.yaw, o.segments), o.w, o.h);
  // the open entrance / exit: a straight before the origin / after the last segment, carved through the shell (the hull is sized by the inner bore)
  const back = yawVector(o.yaw);
  const approach = o.approach ?? 0;
  const origin = approach > 0 ? { x: snap(origin0.x - back.x * approach), y: origin0.y, z: snap(origin0.z - back.z * approach) } : origin0;
  const segs: Segment[] = [...(approach > 0 ? [{ kind: 'straight', len: approach } as Segment] : []), ...o.segments, ...(o.openExit ? [{ kind: 'straight', len: shell + 2 } as Segment] : [])];
  const samples = centreline(origin, o.yaw, segs);
  const cells = approach > 0 || o.openExit ? carve(samples, o.w, o.h) : inner;
  const bb = bbox(inner.values());
  const hull = { min: { x: bb.min.x - shell, y: bb.min.y - shell, z: bb.min.z - shell }, max: { x: bb.max.x + shell, y: bb.max.y + shell, z: bb.max.z + shell } };
  const ops: CourseOp[] = [...slabs(hull.min, hull.max, 'stone'), ...runsOf(cells.values(), 'air')];
  // the waypoints: the bore cells carved within a block of a sample, as a box
  const boxAt = (i: number): { min: Vec3; max: Vec3 } => {
    const near = samples.filter((s, j) => Math.abs(j - i) <= Math.round(1 / STEP) && s.seg === samples[i]!.seg);
    const b = bbox(carve(near, o.w, o.h).values());
    return { min: { x: b.min.x, y: b.min.y, z: b.min.z }, max: { x: b.max.x + 1, y: b.max.y + 1, z: b.max.z + 1 } };
  };
  const goals: { min: Vec3; max: Vec3 }[] = [];
  const lastOf = (si: number): number => {
    let last = -1;
    samples.forEach((s, j) => {
      if (s.seg === si) last = j;
    });
    return last;
  };
  const first = approach > 0 ? 1 : 0; // the inner segments' first index in `segs`
  if (approach > 0) goals.push(boxAt(lastOf(0))); // the entrance
  if (o.segmentWaypoints ?? true) {
    for (let si = first; si < first + o.segments.length - 1; si++) {
      const last = lastOf(si);
      if (last > 0 && segs[si]!.kind !== 'corner') goals.push(boxAt(last));
    }
  }
  goals.push(boxAt(lastOf(first + o.segments.length - 1) - Math.round(1 / STEP))); // the exit
  const entry = Math.round((o.entry ?? 3) / STEP);
  const s0 = samples[Math.min(entry, samples.length - 1)]!;
  const start: CourseStart = {
    pos: { x: s0.x, y: o.standing ? Math.floor(s0.y + 1e-6) : s0.y + (o.h - 0.6) / 2, z: s0.z },
    yaw: s0.yaw,
    speed: o.standing ? 0 : (o.speed ?? 1.2),
    rockets: o.rockets ?? 8,
    ...(o.standing ? { standing: true } : {}),
  };
  return { cells, hull, ops, goals, start };
}

// ---------------------------------------------------------------- stations

/** A station: its structure (no ground work), its legs, the cells it spans. */
interface Station {
  ops: CourseOp[];
  legs: CourseLeg[];
  extent: CellBox;
}

const box = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: CourseBlock): CourseOp => ({ from: { x: Math.min(x1, x2), y: Math.min(y1, y2), z: Math.min(z1, z2) }, to: { x: Math.max(x1, x2), y: Math.max(y1, y2), z: Math.max(z1, z2) }, block });
const extentOf = (ops: readonly CourseOp[]): CellBox => bbox(ops.flatMap((o) => [o.from, o.to]));
const grow = (b: CellBox, o: { x0?: number; x1?: number; z0?: number; z1?: number; y1?: number }): CellBox => ({ min: { x: Math.min(b.min.x, o.x0 ?? Infinity), y: b.min.y, z: Math.min(b.min.z, o.z0 ?? Infinity) }, max: { x: Math.max(b.max.x, o.x1 ?? -Infinity), y: Math.max(b.max.y, o.y1 ?? -Infinity), z: Math.max(b.max.z, o.z1 ?? -Infinity) } });

/**
 * A standing start on a 1 x 1 stone pillar from the ground (`ground`, feet height) up to under `feet`: the rings,
 * the slalom and the tunnel start there alone. The server cannot put a body into the air at a speed (a teleported body falls and its glide
 * may not take), and a body standing still is where the plan was made when the worker answers (Track F4a: the
 * e2e's air starts fell off their first plans and some never glided).
 */
function pillarStart(x: number, z: number, ground: number, feet: number, yaw: number, rockets: number): { ops: CourseOp[]; start: CourseStart } {
  const cx = Math.floor(x);
  const cz = Math.floor(z);
  return { ops: [box(cx, ground, cz, cx, feet - 1, cz, 'stone')], start: { pos: { x: cx + 0.5, y: feet, z: cz + 0.5 }, yaw, speed: 0, standing: true, rockets } };
}

/** The ring heights (the opening's centre over the ground) and spacing. */
export const RING_HEIGHTS: readonly number[] = [7, 12, 6, 14, 8];
export const RING_SPACING = 18;
const RING_FIRST = 20;

/** The height of the pillar the rings, the slalom and the tunnel are started from alone (feet over the ground). */
export const START_UP = 11;

/** In the full course a station is flown on from the last leg: no pillar in its way, a gliding start for a leg flown without its predecessor. */
function airStart(o: Vec3, up: number): CourseStart {
  return { pos: { x: o.x + 0.5, y: o.y + up, z: o.z + 2.5 }, yaw: 0, speed: 0.3, rockets: 8 };
}

function startOf(o: Vec3, up: number, pillar: boolean, ops: CourseOp[]): CourseStart {
  if (!pillar) return airStart(o, up + 1);
  const p = pillarStart(o.x, o.z + 2, o.y, o.y + up, 0, 8);
  ops.push(...p.ops);
  return p.start;
}

function rings(o: Vec3, pillar = true): Station {
  const ops: CourseOp[] = [];
  const goals: CourseGoal[] = [];
  RING_HEIGHTS.forEach((h, i) => {
    const z = o.z + RING_FIRST + RING_SPACING * i;
    const y = o.y + h;
    ops.push(box(o.x - 2, y - 2, z, o.x + 2, y + 2, z, 'stone'), box(o.x - 1, y - 1, z, o.x + 1, y + 1, z, 'air'));
    // the opening's column a block either side (the box is passed by the feet at a tick or a half tick)
    goals.push({ kind: 'box', min: { x: o.x - 1, y: y - 1, z: z - 1 }, max: { x: o.x + 2, y: y + 2, z: z + 2 }, label: `ring ${i + 1}` });
  });
  const start = startOf(o, START_UP, pillar, ops);
  return { ops, legs: [{ name: 'rings', start, chained: false, goals, margin: 0.3 }], extent: grow(extentOf(ops), { x0: o.x - 6, x1: o.x + 6, z0: o.z, z1: o.z + RING_FIRST + RING_SPACING * (RING_HEIGHTS.length - 1) + 10, y1: o.y + 24 }) };
}

/** The slalom: gates this far apart, their gaps this far left and right of the line. */
export const SLALOM_GATES = 5;
export const SLALOM_SPACING = 14;
export const SLALOM_OFFSET = 3;
const SLALOM_FIRST = 18;
const SLALOM_HIGH = 16;

function slalom(o: Vec3, pillar = true): Station {
  const ops: CourseOp[] = [];
  const goals: CourseGoal[] = [];
  for (let i = 0; i < SLALOM_GATES; i++) {
    const z = o.z + SLALOM_FIRST + SLALOM_SPACING * i;
    const gx = o.x + (i % 2 ? SLALOM_OFFSET : -SLALOM_OFFSET);
    ops.push(box(o.x - 9, o.y, z, o.x + 9, o.y + SLALOM_HIGH - 1, z, 'stone'), box(gx - 1, o.y, z, gx + 1, o.y + SLALOM_HIGH - 1, z, 'air'));
    goals.push({ kind: 'box', min: { x: gx - 1, y: o.y + 1, z: z - 1 }, max: { x: gx + 2, y: o.y + SLALOM_HIGH, z: z + 2 }, label: `gate ${i + 1}` });
  }
  const start = startOf(o, START_UP, pillar, ops);
  return { ops, legs: [{ name: 'slalom', start, chained: false, goals, margin: 0.3 }], extent: grow(extentOf(ops), { z0: o.z, z1: o.z + SLALOM_FIRST + SLALOM_SPACING * (SLALOM_GATES - 1) + 8, y1: o.y + SLALOM_HIGH + 8 }) };
}

/** The S-tunnel's centreline: two arcs of radius 10, 45 degrees each way, between straights. */
export const S_TUNNEL: readonly Segment[] = [
  { kind: 'straight', len: 6 },
  { kind: 'arc', radius: 10, deg: -45 },
  { kind: 'straight', len: 4 },
  { kind: 'arc', radius: 10, deg: 45 },
  { kind: 'straight', len: 6 },
];
/** The tunnel's floor over the ground (its hull starts 3 lower) and its entrance's distance into the station. */
const TUNNEL_UP = 8;
const TUNNEL_AT = 22;
const TUNNEL_APPROACH = 8;

function tunnelStation(o: Vec3, pillar = true): Station {
  const b = bore({ w: 3, h: 3, segments: S_TUNNEL, origin: { x: o.x, y: o.y + TUNNEL_UP, z: o.z + TUNNEL_AT }, yaw: 0, approach: TUNNEL_APPROACH, openExit: true });
  const goals: CourseGoal[] = b.goals.map((g, i) => ({ kind: 'box', ...g, label: i === 0 ? 'tunnel entrance' : i === b.goals.length - 1 ? 'tunnel exit' : `tunnel ${i}` }));
  const ops = [...b.ops];
  const start = startOf(o, TUNNEL_UP + (pillar ? 1 : 6), pillar, ops);
  return { ops, legs: [{ name: 'tunnel', start, chained: false, goals, margin: 0.3 }], extent: grow(bbox([b.hull.min, b.hull.max, ...b.cells.values()]), { x0: o.x - 6, x1: o.x + 6, z0: o.z, y1: o.y + TUNNEL_UP + 12 }) };
}

/** The staircase: F2's stair45-3high (10 up over 10, 3 high, a flat 6 before and 8 after) with an open exit, its floor 3 up (the hull on the ground). */
export const STAIR: readonly Segment[] = [
  { kind: 'straight', len: 6 },
  { kind: 'slope', len: 10, dy: 10 },
  { kind: 'straight', len: 8 },
];
const STAIR_AT = 4;

function stair(o: Vec3, pad: boolean): Station {
  const b = bore({ w: 3, h: 3, segments: STAIR, origin: { x: o.x, y: o.y + 3, z: o.z + STAIR_AT }, yaw: 0, standing: true, entry: 2, openExit: true });
  const goals: CourseGoal[] = b.goals.map((g, i) => ({ kind: 'box', ...g, label: i === b.goals.length - 1 ? 'stair exit' : `stair ${i + 1}` }));
  const ops = [...b.ops];
  // the start pad: the floor block under the standing start in gold (as solid as the stone)
  if (pad) ops.push(box(Math.floor(b.start.pos.x), b.start.pos.y - 1, Math.floor(b.start.pos.z), Math.floor(b.start.pos.x), b.start.pos.y - 1, Math.floor(b.start.pos.z), 'gold_block'));
  return { ops, legs: [{ name: 'stair', start: b.start, chained: false, goals, margin: 0.15 }], extent: grow(bbox([b.hull.min, b.hull.max, ...b.cells.values()]), { x0: o.x - 6, x1: o.x + 6, z0: o.z, y1: b.hull.max.y + 6 }) };
}

/** The hand-over entry of a route landing: this far out along the bearing and this high over the floor (route/landing.ts ROUTE_ENTRY_OUT, ROUTE_ENTRY_UP). */
export const LAND_ENTRY_OUT = 40;
export const LAND_ENTRY_UP = 9;
/** The landing stations' cells are this far into the station (the entry 40 out lies inside it). */
const LAND_AT = 41;

/**
 * The start of a landing station: gliding at the brain's hand-over entry at 1.0 a tick, facing the cells (the state
 * the route landing gets from the cruise). Not on a pillar: a takeoff 30 up into the stack's 2-high slot is another
 * problem (offline 3 of 8, 282 re-plans); the server flies it from a fall there, which the bare driver cannot
 * make the hand-over's (docs/flight.md, the e2e's landing rows are not gated).
 */
function entryFor(cells: readonly { x: number; z: number }[], over: number, bearing: number): CourseStart {
  let x = 0;
  let z = 0;
  for (const c of cells) {
    x += c.x + 0.5;
    z += c.z + 0.5;
  }
  x /= cells.length;
  z /= cells.length;
  const d = yawVector(bearing);
  const yaw = bearing + 180 >= 360 ? bearing - 180 : bearing + 180;
  return { pos: { x: x + d.x * LAND_ENTRY_OUT, y: over + LAND_ENTRY_UP, z: z + d.z * LAND_ENTRY_OUT }, yaw, speed: 1.0, rockets: 4 };
}

const square = (cx: number, cz: number, half: number): { x: number; z: number }[] => {
  const out: { x: number; z: number }[] = [];
  for (let dx = -half; dx <= half; dx++) for (let dz = -half; dz <= half; dz++) out.push({ x: cx + dx, z: cz + dz });
  return out;
};

/** The overhang: the ledge's feet height, the roof's underside over the ground. */
export const LEDGE_UP = 8;
export const ROOF_UP = 12;

function overhang(o: Vec3): Station {
  const zc = o.z + LAND_AT; // the ledge's middle row
  const ops: CourseOp[] = [
    box(o.x - 6, o.y, zc + 3, o.x + 6, o.y + 15, zc + 7, 'stone'), // the cliff behind the ledge
    box(o.x - 2, o.y, zc - 2, o.x + 2, o.y + LEDGE_UP - 1, zc + 2, 'stone'), // the ledge (a 5 x 5 pillar against the cliff)
    box(o.x - 4, o.y + ROOF_UP, zc - 4, o.x + 4, o.y + ROOF_UP + 1, zc + 2, 'stone'), // the roof, 2 beyond the ledge's front
  ];
  const cells = square(o.x, zc, 1);
  const goal: CourseGoal = { kind: 'land', cells, top: o.y + LEDGE_UP, ceiling: o.y + ROOF_UP, bearing: 180, label: 'overhang ledge' };
  return { ops, legs: [{ name: 'overhang', start: entryFor(cells, o.y + LEDGE_UP, 180), chained: false, goals: [goal], margin: 0.3 }], extent: grow(extentOf(ops), { z0: o.z, y1: o.y + 24 }) };
}

/** The stacked platforms: the lower one's top block and the upper one's bottom block over the ground. */
export const STACK_LOW = 20;
export const STACK_HIGH = 23;

function stack(o: Vec3): Station {
  const zc = o.z + LAND_AT;
  const ops: CourseOp[] = [box(o.x - 1, o.y + STACK_LOW, zc - 1, o.x + 1, o.y + STACK_LOW, zc + 1, 'stone'), box(o.x - 1, o.y + STACK_HIGH, zc - 1, o.x + 1, o.y + STACK_HIGH, zc + 1, 'stone')];
  const cells = square(o.x, zc, 1);
  const goal: CourseGoal = { kind: 'land', cells, top: o.y + STACK_LOW + 1, ceiling: o.y + STACK_HIGH, bearing: 180, label: 'stack inner platform' };
  return { ops, legs: [{ name: 'stack', start: entryFor(cells, o.y + STACK_LOW + 1, 180), chained: false, goals: [goal], margin: 0.12 }], extent: grow(extentOf(ops), { x0: o.x - 6, x1: o.x + 6, z0: o.z, z1: zc + 8, y1: o.y + STACK_HIGH + 14 }) };
}

/** The shaft's depth. */
export const SHAFT_DEPTH = 10;

function shaft(o: Vec3): Station {
  const zc = o.z + LAND_AT;
  const ops: CourseOp[] = [box(o.x - 3, o.y, zc - 3, o.x + 3, o.y + SHAFT_DEPTH - 1, zc + 3, 'stone'), box(o.x, o.y, zc, o.x, o.y + SHAFT_DEPTH - 1, zc, 'air')];
  const cells = [{ x: o.x, z: zc }];
  const goal: CourseGoal = { kind: 'land', cells, top: o.y, rim: o.y + SHAFT_DEPTH, bearing: 180, label: 'shaft floor' };
  return { ops, legs: [{ name: 'shaft', start: entryFor(cells, o.y + SHAFT_DEPTH, 180), chained: false, goals: [goal], margin: 0.1 }], extent: grow(extentOf(ops), { x0: o.x - 6, x1: o.x + 6, z0: o.z, z1: zc + 8, y1: o.y + SHAFT_DEPTH + 14 }) };
}

/** The finish pad: 5 x 5 gold in the ground at (x, zc); the landing on its middle 3 x 3. */
function finishPad(o: Vec3, x: number, zc: number): { ops: CourseOp[]; goal: CourseGoal } {
  return { ops: [box(x - 2, o.y - 1, zc - 2, x + 2, o.y - 1, zc + 2, 'gold_block')], goal: { kind: 'land', cells: square(x, zc, 1), top: o.y, bearing: 180, label: 'finish pad' } };
}
/** The finish pad lies this far right of the line and this far back from the overhang's ledge (out from under the roof, a half turn, down). */
const PAD_SIDE = 14;
const PAD_BACK = 14;

// ---------------------------------------------------------------- layouts

/** The ground work first: air from the feet height to the top, the flat world's two dirt layers and the grass under it. */
function grounded(name: string, origin: Vec3, extent: CellBox, ops: CourseOp[], legs: CourseLeg[]): CourseLayout {
  const min = { x: extent.min.x - 2, y: origin.y - 3, z: Math.min(extent.min.z, origin.z) - 2 };
  const max = { x: extent.max.x + 2, y: extent.max.y, z: extent.max.z + 2 };
  const ground: CourseOp[] = [
    { from: { x: min.x, y: origin.y, z: min.z }, to: max, block: 'air' },
    { from: min, to: { x: max.x, y: origin.y - 2, z: max.z }, block: 'dirt' },
    { from: { x: min.x, y: origin.y - 1, z: min.z }, to: { x: max.x, y: origin.y - 1, z: max.z }, block: 'grass_block' },
  ];
  return { name, origin: { ...origin }, bounds: { min, max }, ops: [...ground, ...ops], legs };
}

function single(name: Exclude<CourseName, 'full'>, o: Vec3): CourseLayout {
  const st = name === 'rings' ? rings(o) : name === 'slalom' ? slalom(o) : name === 'tunnel' ? tunnelStation(o) : name === 'stair' ? stair(o, false) : name === 'overhang' ? overhang(o) : name === 'stack' ? stack(o) : shaft(o);
  return grounded(name, o, st.extent, st.ops, st.legs);
}

/**
 * The full course: stair (the start pad in its foot), rings, slalom, tunnel and overhang in a row with the finish pad
 * in front of the overhang to the side, then the stack and the shaft. The legs:
 *   1 climb   from standing on the start pad: up the staircase, out of its top, through the five rings
 *   2 weave   gliding on: the slalom's five gates, the S-tunnel from entrance to exit
 *   3 ledge   gliding on out of the tunnel: the landing on the overhang's ledge under its roof
 *   4 finish  from standing on the ledge: out from under the roof, a half turn, the landing on the finish pad
 *   5 stack   from the stack's hand-over entry (the body put there): the landing on the inner platform
 *   6 shaft   from the shaft's hand-over entry: the landing on its floor
 * (the stack and the shaft are flown from their entries: a route takeoff out of a 2-high slot or a 1 x 1 shaft needs
 * the brain's walk-out and vertical takeoff, which the bare route driver does not have)
 */
function full(o: Vec3): CourseLayout {
  const at = (dz: number): Vec3 => ({ x: o.x, y: o.y, z: o.z + dz });
  const stations: { st: Station; z: number }[] = [];
  let z = 0;
  const place = (f: (p: Vec3) => Station, gap = 0): Station => {
    const st = f(at(z));
    stations.push({ st, z });
    z = st.extent.max.z - o.z + 1 + gap;
    return st;
  };
  const st = place((p) => stair(p, true));
  const ri = place((p) => rings(p, false));
  const sl = place((p) => slalom(p, false));
  const tu = place((p) => tunnelStation(p, false));
  const ov = place(overhang);
  const ledge = ov.legs[0]!;
  const ledgeGoal = ledge.goals[0] as Extract<CourseGoal, { kind: 'land' }>;
  const pad = finishPad(o, o.x + PAD_SIDE, ledgeGoal.cells[4]!.z - PAD_BACK);
  const sk = place(stack);
  const sh = place(shaft);
  const ops = [...stations.flatMap((s) => s.st.ops), ...pad.ops];
  let extent = stations.map((s) => s.st.extent).reduce((a, b) => grow(a, { x0: b.min.x, x1: b.max.x, z0: b.min.z, z1: b.max.z, y1: b.max.y }));
  extent = grow(extent, { x1: o.x + PAD_SIDE + 4 });
  const leg = (name: string, from: CourseLeg, chained: boolean, goals: CourseGoal[], margin: number): CourseLeg => ({ name, start: from.start, chained, goals, margin });
  const ledgeStart: CourseStart = { pos: { x: o.x + 0.5, y: ledgeGoal.top, z: ledgeGoal.cells[4]!.z + 0.5 }, yaw: 180, speed: 0, standing: true, rockets: 4 };
  const legs: CourseLeg[] = [
    leg('climb', st.legs[0]!, false, [...st.legs[0]!.goals, ...ri.legs[0]!.goals], 0.15),
    leg('weave', ri.legs[0]!, true, [...sl.legs[0]!.goals, ...tu.legs[0]!.goals], 0.3),
    leg('ledge', tu.legs[0]!, true, ledge.goals, 0.3),
    { name: 'finish', start: ledgeStart, chained: true, goals: [pad.goal], margin: 0.3 },
    { ...sk.legs[0]!, name: 'stack' },
    { ...sh.legs[0]!, name: 'shaft' },
  ];
  return grounded('full', o, extent, ops, legs);
}

/** The layout of course `name` at `origin` (feet height of the ground at the course's start); undefined for an unknown name. */
export function courseLayout(name: string, origin: Vec3): CourseLayout | undefined {
  const o = { x: Math.floor(origin.x), y: Math.floor(origin.y), z: Math.floor(origin.z) };
  if (name === 'full') return full(o);
  if ((COURSE_NAMES as readonly string[]).includes(name)) return single(name as Exclude<CourseName, 'full'>, o);
  return undefined;
}

/** The blocks of the ops (the volume each covers, overlaps counted). */
export function opsVolume(ops: readonly CourseOp[]): number {
  let n = 0;
  for (const op of ops) n += (op.to.x - op.from.x + 1) * (op.to.y - op.from.y + 1) * (op.to.z - op.from.z + 1);
  return n;
}

/** The part of an op inside a box (undefined when it misses it). */
export function clipOp(op: CourseOp, b: CellBox): CourseOp | undefined {
  const from = { x: Math.max(op.from.x, b.min.x), y: Math.max(op.from.y, b.min.y), z: Math.max(op.from.z, b.min.z) };
  const to = { x: Math.min(op.to.x, b.max.x), y: Math.min(op.to.y, b.max.y), z: Math.min(op.to.z, b.max.z) };
  if (from.x > to.x || from.y > to.y || from.z > to.z) return undefined;
  return { from, to, block: op.block };
}

/**
 * The bounds split along z into pieces of whole chunk rows, each at most `maxChunks` chunks (a ticking area per
 * piece while it is built).
 */
export function chunkPieces(b: CellBox, maxChunks: number): CellBox[] {
  const cx0 = Math.floor(b.min.x / 16);
  const cx1 = Math.floor(b.max.x / 16);
  const nx = cx1 - cx0 + 1;
  const rows = Math.max(1, Math.floor(maxChunks / nx));
  const out: CellBox[] = [];
  const cz0 = Math.floor(b.min.z / 16);
  const cz1 = Math.floor(b.max.z / 16);
  for (let cz = cz0; cz <= cz1; cz += rows) {
    const z0 = Math.max(b.min.z, cz * 16);
    const z1 = Math.min(b.max.z, (cz + rows) * 16 - 1);
    out.push({ min: { x: b.min.x, y: b.min.y, z: z0 }, max: { x: b.max.x, y: b.max.y, z: z1 } });
  }
  return out;
}
