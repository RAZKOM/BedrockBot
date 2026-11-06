// Track F2: the course generator of the route benchmark (docs/flight.md "Route planner", "Benchmark"): seeded
// random tunnels (cross-sections 1 x 2, 2 x 2, 3 x 3; curves of different radii, 90-degree corners, climbs
// and drops, the 45-degree staircase 3 and 2 high, 1-high slots) and open-air obstacle fields. A course is a
// fully known world over the flat ground (`world`), the fill boxes that build it on a server with the truth
// pack (`fills`, in order: the hull in stone, the bore in air), the start state and the goals (waypoint boxes
// along the bore, the exit last). The same course flies offline on stepBody (bench.ts) and on bds-fly3
// (test/e2e/fly-route.test.ts).
import type { Vec3 } from '../../../connection/types.ts';
import { flatWorld } from '../../input/world.ts';
import type { BlockQuery } from '../../input/types.ts';
import { yawDir } from '../plan.ts';
import type { RegionBox, RouteGoal } from './types.ts';

export interface CourseStart {
  pos: Vec3;
  yaw: number;
  /** Horizontal speed along the yaw at the start (gliding), 0 for a standing start. */
  speed: number;
  standing?: boolean;
  rockets: number;
}

export interface Fill {
  from: Vec3;
  to: Vec3;
  block: 'stone' | 'air';
}

export interface Course {
  name: string;
  kind: 'tunnel' | 'stair' | 'slot' | 'field';
  world: BlockQuery;
  fills: Fill[];
  start: CourseStart;
  goals: RouteGoal[];
  margin: number;
  bounds: RegionBox;
  /** The bore's cross-section (tunnels). */
  section?: { w: number; h: number };
  /** The cells of the course for the report. */
  cells: number;
}

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
const key = (x: number, y: number, z: number): number => ((x + 32768) & 0xffff) * 0x4000000 + ((y + 512) & 0x3ff) * 0x10000 + ((z + 32768) & 0xffff);
const FEET = -60;
const STEP = 0.25;

interface Sample {
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
      const d = yawDir(yaw);
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
        const d = yawDir(yaw);
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
function carve(samples: readonly Sample[], w: number, h: number): Map<number, Vec3> {
  const cells = new Map<number, Vec3>();
  for (const s of samples) {
    const d = yawDir(s.yaw);
    const n = { x: d.z, z: -d.x }; // the perpendicular
    const y0 = Math.floor(s.y + 1e-6);
    for (const k of lateral(w)) {
      const cx = Math.floor(s.x + n.x * k);
      const cz = Math.floor(s.z + n.z * k);
      for (let y = y0; y < y0 + h; y++) cells.set(key(cx, y, cz), { x: cx, y, z: cz });
    }
  }
  return cells;
}

/** Axis-aligned run-length boxes of a cell set (runs along x), for the fills. */
function runsOf(cells: Iterable<Vec3>, block: 'stone' | 'air'): Fill[] {
  const sorted = [...cells].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
  const out: Fill[] = [];
  let run: Fill | undefined;
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
function bbox(cells: Iterable<Vec3>): { min: Vec3; max: Vec3 } {
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

/** Fill boxes of a solid box, split into slabs of at most 32 768 blocks (the server's fill limit). */
function slabs(min: Vec3, max: Vec3, block: 'stone' | 'air'): Fill[] {
  const out: Fill[] = [];
  const dx = max.x - min.x + 1;
  const dy = max.y - min.y + 1;
  const per = Math.max(1, Math.floor(32000 / (dx * dy)));
  for (let z = min.z; z <= max.z; z += per) out.push({ from: { x: min.x, y: min.y, z }, to: { x: max.x, y: max.y, z: Math.min(max.z, z + per - 1) }, block });
  return out;
}

export interface TunnelOptions {
  name: string;
  w: number;
  h: number;
  segments: readonly Segment[];
  /** The bore's first sample (the centre of the cross-section's floor cell row, feet height). */
  origin: Vec3;
  yaw: number;
  margin?: number;
  rockets?: number;
  /** The entry: gliding at this speed `entry` blocks into the bore (default 1.2 at 3), or standing (`standing`). */
  speed?: number;
  entry?: number;
  standing?: boolean;
  /** Rock around the bore (blocks; default 3). */
  shell?: number;
  kind?: Course['kind'];
  /** A waypoint at the end of every segment (default true) besides the exit. */
  segmentWaypoints?: boolean;
  /** The bore carries on through the shell at its end (the body flies out into the open after the exit; the benchmark's are sealed). */
  openExit?: boolean;
  /** An open entrance: the bore starts this many blocks before `origin` in the open (the start state lies on that approach, `entry` blocks along it). */
  approach?: number;
}

/** A tunnel course: the bore carved through a stone hull, waypoints at the segment ends and the exit. */
export function tunnel(o: TunnelOptions): Course {
  // the centreline of an odd bore runs through cell centres, an even one along cell boundaries
  const snap = (v: number): number => (o.w % 2 ? Math.floor(v) + 0.5 : Math.round(v));
  const origin0 = { x: snap(o.origin.x), y: o.origin.y, z: snap(o.origin.z) };
  const shell = o.shell ?? 3;
  const inner = carve(centreline(origin0, o.yaw, o.segments), o.w, o.h);
  // the open entrance / exit: a straight before the origin / after the last segment, carved through the shell (the hull is sized by the inner bore)
  const back = yawDir(o.yaw);
  const approach = o.approach ?? 0;
  const origin = approach > 0 ? { x: snap(origin0.x - back.x * approach), y: origin0.y, z: snap(origin0.z - back.z * approach) } : origin0;
  const segs: Segment[] = [...(approach > 0 ? [{ kind: 'straight', len: approach } as Segment] : []), ...o.segments, ...(o.openExit ? [{ kind: 'straight', len: shell + 2 } as Segment] : [])];
  const samples = centreline(origin, o.yaw, segs);
  const bore = approach > 0 || o.openExit ? carve(samples, o.w, o.h) : inner;
  const bb = bbox(inner.values());
  const hullMin = { x: bb.min.x - shell, y: bb.min.y - shell, z: bb.min.z - shell };
  const hullMax = { x: bb.max.x + shell, y: bb.max.y + shell, z: bb.max.z + shell };
  const flat = flatWorld();
  const world: BlockQuery = {
    solidAt(x, y, z) {
      if (x >= hullMin.x && x <= hullMax.x && y >= hullMin.y && y <= hullMax.y && z >= hullMin.z && z <= hullMax.z) return !bore.has(key(x, y, z));
      return flat.solidAt(x, y, z);
    },
  };
  const fills: Fill[] = [...slabs(hullMin, hullMax, 'stone'), ...runsOf(bore.values(), 'air')];
  // the waypoints: the bore cells carved within a block of a sample, as a box
  const boxAt = (i: number): RegionBox => {
    const near = samples.filter((s, j) => Math.abs(j - i) <= Math.round(1 / STEP) && s.seg === samples[i]!.seg);
    const b = bbox(carve(near, o.w, o.h).values());
    return { min: { x: b.min.x, y: b.min.y, z: b.min.z }, max: { x: b.max.x + 1, y: b.max.y + 1, z: b.max.z + 1 } };
  };
  const goals: RouteGoal[] = [];
  const lastOf = (si: number): number => {
    let last = -1;
    samples.forEach((s, j) => {
      if (s.seg === si) last = j;
    });
    return last;
  };
  const first = approach > 0 ? 1 : 0; // the inner segments' first index in `segs`
  if (approach > 0) goals.push({ kind: 'waypoint', box: boxAt(lastOf(0)) }); // the entrance
  if (o.segmentWaypoints ?? true) {
    for (let si = first; si < first + o.segments.length - 1; si++) {
      const last = lastOf(si);
      if (last > 0 && segs[si]!.kind !== 'corner') goals.push({ kind: 'waypoint', box: boxAt(last) });
    }
  }
  goals.push({ kind: 'waypoint', box: boxAt(lastOf(first + o.segments.length - 1) - Math.round(1 / STEP)) }); // the exit
  const entry = Math.round((o.entry ?? 3) / STEP);
  const s0 = samples[Math.min(entry, samples.length - 1)]!;
  const start: CourseStart = {
    pos: { x: s0.x, y: o.standing ? Math.floor(s0.y + 1e-6) : s0.y + (o.h - 0.6) / 2, z: s0.z },
    yaw: s0.yaw,
    speed: o.standing ? 0 : (o.speed ?? 1.2),
    rockets: o.rockets ?? 8,
    ...(o.standing ? { standing: true } : {}),
  };
  return {
    name: o.name,
    kind: o.kind ?? 'tunnel',
    world,
    fills,
    start,
    goals,
    margin: o.margin ?? (o.w >= 3 ? 0.3 : o.w === 2 ? 0.2 : 0.12),
    bounds: { min: hullMin, max: { x: hullMax.x + 1, y: hullMax.y + 1, z: hullMax.z + 1 } },
    section: { w: o.w, h: o.h },
    cells: bore.size,
  };
}

/** A small seeded generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random tunnel of `n` segments from a seed: straights, arcs of radius 4 to 16, corners, slopes. */
export function randomSegments(seed: number, n: number, o: { corners?: boolean; slopes?: boolean; minRadius?: number } = {}): Segment[] {
  const r = rng(seed);
  const out: Segment[] = [{ kind: 'straight', len: 8 }];
  for (let i = 0; i < n; i++) {
    const p = r();
    if (p < 0.35) out.push({ kind: 'straight', len: 6 + Math.floor(r() * 10) });
    else if (p < 0.7) out.push({ kind: 'arc', radius: (o.minRadius ?? 4) + Math.floor(r() * 12), deg: (r() < 0.5 ? -1 : 1) * (30 + Math.floor(r() * 60)) });
    else if (p < 0.85 && (o.corners ?? true)) out.push({ kind: 'straight', len: 6 }, { kind: 'corner', deg: r() < 0.5 ? -90 : 90 }, { kind: 'straight', len: 6 });
    else if (o.slopes ?? true) out.push({ kind: 'slope', len: 8 + Math.floor(r() * 8), dy: (r() < 0.5 ? -1 : 1) * (1 + Math.floor(r() * 3)) });
    else out.push({ kind: 'straight', len: 8 });
  }
  out.push({ kind: 'straight', len: 8 });
  return out;
}

/** An open-air obstacle field: `count` random pillars and slabs in a `size` x `height` x `size` volume between the start and the goal. */
export function field(seed: number, o: { name?: string; size?: number; height?: number; count?: number; rockets?: number; margin?: number; origin?: Vec3 } = {}): Course {
  const r = rng(seed);
  const size = o.size ?? 60;
  const height = o.height ?? 24;
  const origin = o.origin ?? { x: 0, y: FEET + 8, z: 0 };
  const boxes: { min: Vec3; max: Vec3 }[] = [];
  for (let i = 0; i < (o.count ?? 18); i++) {
    const pillar = r() < 0.6;
    const w = pillar ? 1 + Math.floor(r() * 3) : 4 + Math.floor(r() * 8);
    const h = pillar ? 6 + Math.floor(r() * height) : 1 + Math.floor(r() * 3);
    const x = origin.x - size / 2 + Math.floor(r() * (size - w));
    const z = origin.z + 10 + Math.floor(r() * (size - 20 - w));
    const y = pillar ? FEET : FEET + 2 + Math.floor(r() * (height - 4));
    boxes.push({ min: { x, y, z }, max: { x: x + w - 1, y: y + h - 1, z: z + w - 1 } });
  }
  const flat = flatWorld();
  const world: BlockQuery = {
    solidAt(x, y, z) {
      for (const b of boxes) if (x >= b.min.x && x <= b.max.x && y >= b.min.y && y <= b.max.y && z >= b.min.z && z <= b.max.z) return true;
      return flat.solidAt(x, y, z);
    },
  };
  const fills: Fill[] = boxes.map((b) => ({ from: b.min, to: b.max, block: 'stone' as const }));
  let cells = 0;
  for (const b of boxes) cells += (b.max.x - b.min.x + 1) * (b.max.y - b.min.y + 1) * (b.max.z - b.min.z + 1);
  const goalC = { x: origin.x + 0.5, y: origin.y, z: origin.z + size + 2 };
  return {
    name: o.name ?? `field${seed}`,
    kind: 'field',
    world,
    fills,
    start: { pos: { x: origin.x + 0.5, y: origin.y + 4, z: origin.z + 0.5 }, yaw: 0, speed: 1.3, rockets: o.rockets ?? 4 },
    goals: [{ kind: 'waypoint', box: { min: { x: goalC.x - 2, y: goalC.y - 2, z: goalC.z - 1 }, max: { x: goalC.x + 2, y: goalC.y + 6, z: goalC.z + 1 } } }],
    margin: o.margin ?? 0.4,
    bounds: { min: { x: origin.x - size / 2 - 4, y: FEET - 1, z: origin.z - 4 }, max: { x: origin.x + size / 2 + 4, y: origin.y + height + 8, z: origin.z + size + 8 } },
    cells,
  };
}

/** The benchmark's standard set (docs/flight.md "Benchmark"); every course at `origin` (the e2e moves it to the private area). */
export function standardCourses(origin: Vec3 = { x: 0, y: FEET + 1, z: 0 }, common: Partial<TunnelOptions> = {}): Course[] {
  const o = origin;
  const t = (name: string, w: number, h: number, segments: Segment[], extra: Partial<TunnelOptions> = {}): Course => tunnel({ name, w, h, segments, origin: o, yaw: 0, ...common, ...extra });
  const curve = (radius: number): Segment[] => [{ kind: 'straight', len: 10 }, { kind: 'arc', radius, deg: 90 }, { kind: 'straight', len: 10 }];
  const corner: Segment[] = [{ kind: 'straight', len: 12 }, { kind: 'corner', deg: -90 }, { kind: 'straight', len: 12 }];
  const sbend: Segment[] = [{ kind: 'straight', len: 8 }, { kind: 'arc', radius: 6, deg: 60 }, { kind: 'arc', radius: 6, deg: -60 }, { kind: 'straight', len: 8 }];
  return [
    t('straight-3x3', 3, 3, [{ kind: 'straight', len: 40 }]),
    t('straight-2x2', 2, 2, [{ kind: 'straight', len: 40 }]),
    t('straight-1x2', 1, 2, [{ kind: 'straight', len: 30 }]),
    t('curve-r16-3x3', 3, 3, curve(16)),
    t('curve-r8-3x3', 3, 3, curve(8)),
    t('curve-r4-3x3', 3, 3, curve(4)),
    t('curve-r8-2x2', 2, 2, curve(8)),
    t('corner-3x3', 3, 3, corner),
    t('corner-2x2', 2, 2, corner),
    t('sbend-2x2', 2, 2, sbend),
    t('climb-3x3', 3, 3, [{ kind: 'straight', len: 8 }, { kind: 'slope', len: 20, dy: 6 }, { kind: 'straight', len: 8 }]),
    t('drop-3x3', 3, 3, [{ kind: 'straight', len: 8 }, { kind: 'slope', len: 20, dy: -8 }, { kind: 'straight', len: 8 }]),
    // the staircases: a 45-degree diagonal passage (the envelope: +-0.4 of slack for the box in a 3-high one, so the margin is 0.15), from standing in the flat section before it
    t('stair45-3high', 3, 3, [{ kind: 'straight', len: 6 }, { kind: 'slope', len: 10, dy: 10 }, { kind: 'straight', len: 8 }], { kind: 'stair', standing: true, entry: 2, margin: 0.15 }),
    t('stair45-2high', 3, 2, [{ kind: 'straight', len: 6 }, { kind: 'slope', len: 10, dy: 10 }, { kind: 'straight', len: 8 }], { kind: 'stair', standing: true, entry: 2, margin: 0.15 }),
    t('slot-1high-6', 3, 1, [{ kind: 'straight', len: 6 }], { kind: 'slot', margin: 0.12, origin: { x: o.x, y: o.y + 6, z: o.z }, speed: 1.4, entry: 0.5, shell: 2 }),
    t('slot-1high-12', 3, 1, [{ kind: 'straight', len: 12 }], { kind: 'slot', margin: 0.12, origin: { x: o.x, y: o.y + 6, z: o.z }, speed: 1.4, entry: 0.5, shell: 2 }),
    t('random-3x3-a', 3, 3, randomSegments(11, 4)),
    t('random-3x3-b', 3, 3, randomSegments(12, 4)),
    // (a 2-high bore with a slope leaves a 1-high opening at every step of its floor: the 2 x 2 random tunnels have curves only)
    t('random-2x2-a', 2, 2, randomSegments(21, 3, { corners: false, slopes: false })),
    t('random-2x2-b', 2, 2, randomSegments(22, 3, { corners: false, slopes: false })),
    field(1, { origin: { x: o.x, y: o.y + 8, z: o.z } }),
    field(2, { origin: { x: o.x, y: o.y + 8, z: o.z } }),
    field(3, { origin: { x: o.x, y: o.y + 8, z: o.z } }),
  ];
}

/** A course moved by `d` (the e2e builds the standard set in its private area). */
export function shifted(c: Course, d: Vec3): Course {
  const mv = (p: Vec3): Vec3 => ({ x: p.x + d.x, y: p.y + d.y, z: p.z + d.z });
  const base = c.world;
  return {
    ...c,
    world: { solidAt: (x, y, z) => base.solidAt(x - d.x, y - d.y, z - d.z) },
    fills: c.fills.map((f) => ({ ...f, from: mv(f.from), to: mv(f.to) })),
    start: { ...c.start, pos: mv(c.start.pos) },
    goals: c.goals.map((g) => (g.kind === 'waypoint' ? { kind: 'waypoint', box: { min: mv(g.box.min), max: mv(g.box.max) } } : { ...g, cell: { x: g.cell.x + d.x, z: g.cell.z + d.z }, top: g.top + d.y })),
    bounds: { min: mv(c.bounds.min), max: mv(c.bounds.max) },
  };
}
