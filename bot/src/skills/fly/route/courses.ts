// Track F2: the course generator of the route benchmark (docs/flight.md "Route planner", "Benchmark"): seeded
// random tunnels (cross-sections 1 x 2, 2 x 2, 3 x 3; curves of different radii, 90-degree corners, climbs
// and drops, the 45-degree staircase 3 and 2 high, 1-high slots) and open-air obstacle fields. A course is a
// fully known world over the flat ground (`world`), the fill boxes that build it on a server with the truth
// pack (`fills`, in order: the hull in stone, the bore in air), the start state and the goals (waypoint boxes
// along the bore, the exit last). The same course flies offline on stepBody (bench.ts) and on bds-fly3
// (test/e2e/fly-route.test.ts).
//
// Track F4a (docs/flight.md "Obstacle course (Track F4a)", decisions/0067): the bore geometry lives in the truth
// pack's pure course-layout.ts, shared with the obstacle courses the pack builds (`truth:course`); `layoutCourses`
// turns such a layout into one Course per leg over the same world.
import type { Vec3 } from '../../../connection/types.ts';
import { flatWorld } from '../../input/world.ts';
import type { BlockQuery } from '../../input/types.ts';
import { bore, cellKey, courseLayout, type CourseBlock, type CourseLayout, type CourseLeg, type Segment } from '../../../../../packs/truth/src/course-layout.ts';
import { ROUTE_WEIGHT, landingGoalFor, type LandingRouteSpec } from './landing.ts';
import type { RegionBox, RouteGoal, RouteRequest } from './types.ts';

export type { Segment } from '../../../../../packs/truth/src/course-layout.ts';
export { centreline } from '../../../../../packs/truth/src/course-layout.ts';

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
  block: CourseBlock;
}

export interface Course {
  name: string;
  kind: 'tunnel' | 'stair' | 'slot' | 'field' | 'course';
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
  /** Track F4a: the edge set and the heuristic's weight the leg is flown with (a leg ending in a landing: `landing`, ROUTE_WEIGHT). */
  library?: RouteRequest['library'];
  weight?: number;
  /** Track F4a: the leg goes on from where the previous one ended (an obstacle course's chain). */
  chained?: boolean;
  /** Track F4a: a label per goal (the tables' "reached" column). */
  labels?: string[];
}

const FEET = -60;

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

/** A tunnel course: the bore carved through a stone hull, waypoints at the segment ends and the exit (course-layout.ts `bore`). */
export function tunnel(o: TunnelOptions): Course {
  const b = bore(o);
  const { min: hullMin, max: hullMax } = b.hull;
  const flat = flatWorld();
  const world: BlockQuery = {
    solidAt(x, y, z) {
      if (x >= hullMin.x && x <= hullMax.x && y >= hullMin.y && y <= hullMax.y && z >= hullMin.z && z <= hullMax.z) return !b.cells.has(cellKey(x, y, z));
      return flat.solidAt(x, y, z);
    },
  };
  return {
    name: o.name,
    kind: o.kind ?? 'tunnel',
    world,
    fills: b.ops,
    start: b.start,
    goals: b.goals.map((box) => ({ kind: 'waypoint', box })),
    margin: o.margin ?? (o.w >= 3 ? 0.3 : o.w === 2 ? 0.2 : 0.12),
    bounds: { min: hullMin, max: { x: hullMax.x + 1, y: hullMax.y + 1, z: hullMax.z + 1 } },
    section: { w: o.w, h: o.h },
    cells: b.cells.size,
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
    goals: c.goals.map((g) => (g.kind === 'waypoint' ? { kind: 'waypoint', box: { min: mv(g.box.min), max: mv(g.box.max) } } : { ...g, cell: { x: g.cell.x + d.x, z: g.cell.z + d.z }, top: g.top + d.y, ...(g.cells ? { cells: g.cells.map((k) => ({ x: k.x + d.x, z: k.z + d.z })) } : {}), ...(g.via ? { via: { ...g.via, pos: mv(g.via.pos) } } : {}) })),
    bounds: { min: mv(c.bounds.min), max: mv(c.bounds.max) },
  };
}

// ---------------------------------------------------------------- Track F4a: the obstacle courses

/** The world of a layout: its ops painted in order over the flat world inside its bounds (a voxel box), the flat world outside. */
export function layoutWorld(l: CourseLayout): BlockQuery {
  const { min, max } = l.bounds;
  const sx = max.x - min.x + 1;
  const sy = max.y - min.y + 1;
  const sz = max.z - min.z + 1;
  const flat = flatWorld();
  const cells = new Uint8Array(sx * sy * sz);
  const at = (x: number, y: number, z: number): number => ((y - min.y) * sz + (z - min.z)) * sx + (x - min.x);
  for (let y = min.y; y <= max.y; y++) {
    if (!flat.solidAt(0, y, 0)) continue;
    for (let z = min.z; z <= max.z; z++) cells.fill(1, at(min.x, y, z), at(min.x, y, z) + sx);
  }
  for (const op of l.ops) {
    const v = op.block === 'air' ? 0 : 1;
    const x0 = Math.max(min.x, op.from.x);
    const x1 = Math.min(max.x, op.to.x);
    if (x0 > x1) continue;
    for (let y = Math.max(min.y, op.from.y); y <= Math.min(max.y, op.to.y); y++) {
      for (let z = Math.max(min.z, op.from.z); z <= Math.min(max.z, op.to.z); z++) cells.fill(v, at(x0, y, z), at(x1, y, z) + 1);
    }
  }
  return {
    solidAt(x, y, z) {
      if (x < min.x || x > max.x || y < min.y || y > max.y || z < min.z || z > max.z) return flat.solidAt(x, y, z);
      return cells[at(x, y, z)] === 1;
    },
  };
}

/** The route goal of a layout's goal (a landing: landing.ts `landingGoalFor` along its bearing, the `via` hint included). */
export function legGoal(g: CourseLeg['goals'][number]): RouteGoal {
  if (g.kind === 'box') return { kind: 'waypoint', box: { min: { ...g.min }, max: { ...g.max } } };
  return landingGoalFor(legSpec(g), g.bearing);
}

/** The landing spec of a layout's landing goal. */
export function legSpec(g: Extract<CourseLeg['goals'][number], { kind: 'land' }>): LandingRouteSpec {
  return { cells: g.cells, top: g.top, ...(g.rim !== undefined ? { rim: g.rim } : {}), ...(g.ceiling !== undefined ? { ceiling: g.ceiling } : {}) };
}

/** One Course per leg of a layout, all over the layout's world (a leg with a landing is flown with the `landing` edges and ROUTE_WEIGHT, as the brain's route phase). */
export function layoutCourses(l: CourseLayout, world: BlockQuery = layoutWorld(l)): Course[] {
  const bounds: RegionBox = { min: { ...l.bounds.min }, max: { x: l.bounds.max.x + 1, y: l.bounds.max.y + 1, z: l.bounds.max.z + 1 } };
  return l.legs.map((leg) => {
    const landing = leg.goals.some((g) => g.kind === 'land');
    return {
      name: l.legs.length > 1 ? `${l.name}/${leg.name}` : l.name,
      kind: 'course',
      world,
      fills: l.ops,
      start: { ...leg.start, pos: { ...leg.start.pos } },
      goals: leg.goals.map(legGoal),
      margin: leg.margin,
      bounds,
      cells: 0,
      ...(landing ? { library: 'landing' as const, weight: ROUTE_WEIGHT } : {}),
      chained: leg.chained,
      labels: leg.goals.map((g) => g.label),
    };
  });
}

/** The obstacle course `name` at `origin` (feet height of the ground; default the flat world's at 0, 0) as Courses, one per leg. */
export function obstacleCourse(name: string, origin: Vec3 = { x: 0, y: FEET, z: 0 }): Course[] {
  const l = courseLayout(name, origin);
  if (!l) throw new Error(`unknown course ${name}`);
  return layoutCourses(l);
}
