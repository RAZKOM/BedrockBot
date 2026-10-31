// Flight planning (wave 11, Track AU; docs/flight.md "The landing"): pure geometry over the glide
// model of skills/input/physics.ts (GLIDE, glideVelocity). The cruise height from the columns under
// the straight line, the approach entry, and the landing: a model-predictive choice of a three-segment
// approach profile, re-optimised every tick from the body's real state and flown with the same pitch
// law, because the server's glide ends on ground contact and only the speeds at that contact decide
// the damage (vertical) and the slide (horizontal):
//
//   A  approach   one pitch (a dive, level, or a little up) until the flare point `flareAt` blocks
//                 before the target centre: the body comes in low and fast, below the platform top
//   B  flare      a hard pull-up (`pitchB`, -30 to -75): the pull term of the glide formula trades
//                 the speed for height (1.3 blocks/tick zoom-climbs 3 to 5 blocks); the flare ends at
//                 the top of the climb (vy back to 0), or when the speed is under SETTLE_SPEED
//   C  settle     a shallow pitch held until contact: with little speed left the glide sinks 0.1 to
//                 0.25 blocks/tick onto the platform near its centre
//
// Every tick the planner simulates the current profile and its neighbours (a hill climb over the
// four parameters; a coarse grid when it has no plan that lands) and flies the first tick of the best.
// No teleports, nothing a vanilla client could not do: yaw, pitch and the rocket are the only controls.
import type { Vec3 } from '../../connection/types.ts';
import { glideVelocity } from '../input/physics.ts';

/** A landing target: the block top to stand on (feet y = `top`), its centre and half width in blocks (1 = 3 x 3). */
export interface LandingTarget {
  x: number;
  z: number;
  /** Feet height of a body standing on the platform (the block y + 1). */
  top: number;
  /** Half width of the platform in blocks (0.5 = one block, 1 = 3 x 3, 2 = 5 x 5); the ground: a large value. */
  half: number;
  /** Feet height of the ground around the platform (a glide ending there is short); default top - 24. */
  ground?: number;
  /**
   * Track BF, a landing for a walk (fly then walk, docs/flight.md "Landing v3"): the cells (`columnKey`)
   * a touchdown may end in, every one of them with a confirmed walking path to the goal (the landing
   * cell's flat, dry neighbourhood); the planner scores by safety and slide room, not by the distance
   * from the centre (an off-centre touchdown in the set is as good as the centre: no go-around for it).
   */
  cells?: ReadonlySet<number>;
  /** Track BF: the touchdown is only a stop on the way (with `cells`): the off-centre cost is small. */
  walk?: boolean;
  /**
   * Track BF, under an overhang: the bearing (Bedrock yaw, from the target outwards) of the open
   * corridor the approach must come in along (a ceiling over the cell: no approach from elsewhere).
   */
  bearing?: number;
  /** Track BF: the lowest solid above the landing cells (a ceiling under an overhang), for the log. */
  ceiling?: number;
  /**
   * Track BF: not landable yet (the goal's ground is not in the live world model, or no cell is
   * confirmed): the brain holds high near it (a circle) and never lands; the trip retargets it.
   */
  hold?: boolean;
}

/** Track BF: the key of column (x, z) in `LandingTarget.cells`. */
export function columnKey(x: number, z: number): number {
  return (x & 0xffff) * 65536 + (z & 0xffff);
}

/** Track BF: the unit vector (x, z) of a Bedrock yaw (0 = +z, 90 = -x). */
export function yawDir(yaw: number): { x: number; z: number } {
  const r = (yaw * Math.PI) / 180;
  return { x: -Math.sin(r), z: Math.cos(r) };
}

/** The body as the planner sees it (feet position, blocks per tick). */
export interface FlightBody {
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
  gliding: boolean;
  boostTicks: number;
}

export const DEFAULT_CLEARANCE = 12;
/** Track BL: an unknown column under the line counts this much higher than the highest known one (terrain.ts UNKNOWN_SLACK). */
export const UNKNOWN_SLACK_CRUISE = 24;
export const DEFAULT_CRUISE = 25;
export const DEFAULT_GO_AROUNDS = 4;
/** The approach starts within this horizontal distance of the target (blocks). */
export const APPROACH_DISTANCE = 56;
/** The approach entry: this many blocks above the platform top at the approach distance. */
export const APPROACH_HEIGHT = 10;
/** Touchdown speeds the landing aims under (blocks per tick): the owner's "little to no damage". */
export const TOUCHDOWN_VY = 0.3;
export const TOUCHDOWN_H = 0.3;
/** Level flight sinks about this many blocks per block flown (measured 0.15 per tick at 1.3 blocks per tick). */
export const SINK_RATIO = 0.12;
/**
 * Track AU2, the glide ratio the energy model plans with: blocks of level flight per block of height.
 * The formula's steady level glide is 10.06 (1.51 blocks a tick, sinking 0.15), and the server's
 * glide matches the formula within 0.002 a tick (docs/flight.md "Physics"; the 8.5 of the first
 * notes came from unsettled samples). Arriving a little high is absorbed by the approach planner and
 * the descent geometry; arriving low costs a rocket, which the margin (`glideMargin`) guards against.
 */
export const GLIDE_RATIO = 10;
/** Blocks of height one rocket buys in a back-to-back climb at the climb pitch (-38): 15.7 while it burns, the last one's momentum on top (docs/flight.md "Rocket economy"). */
export const ROCKET_CLIMB = 18;
/** Blocks of height one rocket fired from a level glide buys at the climb pitch, its momentum included (measured 31 on the formula; 24 at -30, 14 at -20, 6 at -10). */
export const ROCKET_CRUISE_CLIMB = 31;
/** The default spare height above the approach entry the cruise keeps (`flyMargin`). */
export const DEFAULT_MARGIN = 15;
/** The default height cap of the climb above the start (`flyMaxClimb`): a longer glide is topped up on the way. */
export const DEFAULT_MAX_CLIMB = 120;
/** The default takeoff run checked for open sky (`flyTakeoffRun`, blocks along the heading). */
export const DEFAULT_TAKEOFF_RUN = 12;
/** Blocks of ground a rocket climb covers per block of height gained (measured 1.3 blocks/tick forward at 1.06 up). */
export const CLIMB_RUN = 1.25;
/** Below this horizontal speed the glide stalls (the dive term no longer feeds it): pitch down. */
export const STALL_SPEED = 0.55;
/** The flare ends once the speed is under this (the settle segment takes over). */
export const SETTLE_SPEED = 0.35;
/** The flare never lasts longer than this many ticks. */
export const FLARE_MAX = 40;
/** The yaw law stops turning towards the target this close to it (the bearing flips when passing it). */
export const YAW_FREEZE = 1.5;

export const hdist = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);

/** Bedrock yaw (0 = +z, 90 = -x) that looks from `from` towards `to`. */
export function yawTo(from: { x: number; z: number }, to: { x: number; z: number }): number {
  return (Math.atan2(-(to.x - from.x), to.z - from.z) * 180) / Math.PI;
}

/** Signed smallest difference b - a in degrees, in (-180, 180]. */
export function yawDiff(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Turn `yaw` towards `want` by at most `maxStep` degrees (a smooth turn the server follows without corrections). */
export function turnTowards(yaw: number, want: number, maxStep = 15): number {
  const d = yawDiff(yaw, want);
  return Math.abs(d) <= maxStep ? want : yaw + Math.sign(d) * maxStep;
}

/** The approach yaw law (the brain and the simulation share it): turn towards the target, frozen within YAW_FREEZE blocks. */
export function approachYaw(yaw: number, pos: { x: number; z: number }, target: { x: number; z: number }): number {
  return hdist(pos, target) > YAW_FREEZE ? turnTowards(yaw, yawTo(pos, target)) : yaw;
}

/** Integer columns under the straight line from `a` to `b` (both ends included). */
export function columnsAlong(a: { x: number; z: number }, b: { x: number; z: number }): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  const n = Math.max(1, Math.ceil(hdist(a, b)));
  const seen = new Set<string>();
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = Math.floor(a.x + (b.x - a.x) * t);
    const z = Math.floor(a.z + (b.z - a.z) * t);
    const k = `${x},${z}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ x, z });
  }
  return out;
}

/**
 * The cruise height (Track AU2, the energy model of docs/flight.md "Rocket economy"): what a glide at
 * GLIDE_RATIO from the top of the climb down to the approach entry needs, with the glide margin to
 * spare (`glideMargin`) and the distance the climb itself covers taken off (about CLIMB_RUN blocks per
 * block climbed; two rounds settle the circular estimate), capped at `maxClimb` above the start (a
 * longer glide is topped up on the way: one rocket from a level glide buys about ROCKET_CRUISE_CLIMB
 * blocks, cheaper than a level boost); never under `clearance` above every known column top under the
 * straight line (Track BL: with any unknown column, 24 more: unknown is not air) nor under the approach entry. (Track

 * AU's `flyCruise` cap above the higher end is gone: it made every long flight cruise 25 blocks up and
 * boost level every 100 blocks.) `skyTop(x, z)` = the highest solid block of the column (undefined =
 * unknown).
 */
export function cruiseHeight(
  from: Vec3,
  target: LandingTarget,
  skyTop: (x: number, z: number) => number | undefined,
  o: { clearance?: number; margin?: number; maxClimb?: number } = {},
): { y: number; highest: number | undefined; unknown: number; needed: number } {
  const clearance = o.clearance ?? DEFAULT_CLEARANCE;
  const margin = o.margin ?? DEFAULT_MARGIN;
  const maxClimb = o.maxClimb ?? DEFAULT_MAX_CLIMB;
  let highest: number | undefined;
  let startTop: number | undefined;
  let unknown = 0;
  for (const c of columnsAlong(from, target)) {
    const t = skyTop(c.x, c.z);
    // Track BL: the start's own platform (under the feet, within 6 blocks) gets the clearance but not the unknown slack (e2e: from a
    // 3x3 platform 200 up its top + clearance + 24 climbed the flight 50 blocks before the glide down)
    if (t !== undefined && t < from.y && hdist(c, from) <= 6) {
      startTop = Math.max(startTop ?? t, t);
      continue;
    }
    if (t === undefined) unknown++;
    else if (highest === undefined || t > highest) highest = t;
  }
  // Track BL: unknown columns are not air: they count as the highest known column plus UNKNOWN_SLACK (24; terrain.ts)
  const along = highest === undefined ? Math.max(from.y, target.top) : highest + 1 + clearance + (unknown > 0 ? UNKNOWN_SLACK_CRUISE : 0);
  const terrain = Math.max(along, startTop === undefined ? -Infinity : startTop + 1 + clearance);
  if (startTop !== undefined && (highest === undefined || startTop > highest)) highest = startTop;
  const distance = hdist(from, target);
  const entry = target.top + APPROACH_HEIGHT;
  // the glide slope from the approach entry: the cruise is flown after the climb, which itself covers
  // about CLIMB_RUN blocks per block climbed (two rounds settle the circular estimate)
  const spare = glideMargin(margin, distance);
  let needed = entry + spare + 2;
  for (let i = 0; i < 2; i++) {
    const climbRun = Math.max(0, needed - from.y) * CLIMB_RUN;
    needed = entry + Math.max(0, distance - APPROACH_DISTANCE - climbRun) / GLIDE_RATIO + spare + 2;
  }
  const y = Math.max(terrain, Math.min(needed, from.y + maxClimb), entry + 2);
  return { y, highest, unknown, needed };
}

/**
 * The spare height the cruise keeps above the glide line towards a target `distance` blocks away:
 * the full `margin` (flyMargin, 15) from 600 blocks on, less for a short glide (the glide ratio's
 * error grows with the distance flown: about 3 blocks per 100), none under 150 blocks (a short
 * flight's climb overshoots by its momentum anyway, and the approach planner wants the body low:
 * the offline trips go around when it arrives 15 above the entry at 300 blocks).
 */
export function glideMargin(margin: number, distance: number): number {
  return Math.min(margin, Math.max(0, distance / 30 - 5));
}

/** The feet height from which a glide at GLIDE_RATIO reaches the approach entry of `target` from `distance` blocks out (the glide line). */
export function glideLine(target: LandingTarget, distance: number): number {
  return target.top + APPROACH_HEIGHT + Math.max(0, distance - APPROACH_DISTANCE) / GLIDE_RATIO;
}

/**
 * The climb pitch of one rocket fired from a level glide that should buy about `gain` blocks (its
 * momentum included), from the formula's table: -10 buys 6, -20 14, -30 24, -38 31 (the efficient
 * climb pitch; steeper buys more but leaves the speed near the stall). Rounded to 5 degrees, never
 * steeper than the climb pitch.
 */
export function rocketPitchFor(gain: number): number {
  const table: readonly (readonly [number, number])[] = [
    [6, -10],
    [14, -20],
    [24, -30],
    [31, -38],
  ];
  const climb = table[table.length - 1]![1];
  if (gain <= table[0]![0]) return table[0]![1];
  for (let i = 1; i < table.length; i++) {
    const [g0, p0] = table[i - 1]!;
    const [g1, p1] = table[i]!;
    if (gain <= g1) return Math.max(climb, Math.round((p0 + ((gain - g0) / (g1 - g0)) * (p1 - p0)) / 5) * 5);
  }
  return climb;
}

// ---- Track AU2: the sky over the takeoff, the path ahead, the descent geometry ----------------------

/** A cell query over the world model: true = solid, false = air, undefined = not loaded. */
export type CellQuery = (x: number, y: number, z: number) => boolean | undefined;

export type SkyCheck = { ok: true; yaw: number } | { ok: false; roofY: number; above: number; ahead: number; line: string };

/**
 * Open sky over the takeoff (Track AU2, docs/flight.md "Takeoff and roofs"): the start's column must be
 * free from the head up to `cruiseY`, its eight neighbours from two above the head (a trunk beside the
 * bot is no roof), and the columns of the first `run` blocks along the heading above the climb cone
 * (TAKEOFF_CONE: the feet's height less 2 for the first 3 blocks, then rising 0.6 per block, the
 * measured climb's slope with a berth: a bump on the ground 10 out is under the cone, a tree is not);
 * an unknown cell counts as blocked here (unlike the cruise's skyQuery: a roof the model has not
 * loaded is still a roof). A roof over the start refuses; a blocked run along the target's bearing
 * tries other headings (30 degrees apart, the nearest first) and returns the first free one as the
 * takeoff heading: the climb holds it until it is above the obstacle.
 */
export const TAKEOFF_CONE = Object.freeze({ flat: 3, slope: 0.6, berth: 2 });
export function takeoffSky(from: Vec3, target: { x: number; z: number }, cruiseY: number, run: number, cell: CellQuery): SkyCheck {
  const fx = Math.floor(from.x);
  const fz = Math.floor(from.z);
  const feet = Math.floor(from.y);
  const y1 = Math.min(319, Math.ceil(cruiseY));
  const roof = (x: number, z: number, y0: number): number | undefined => {
    for (let y = Math.max(y0, feet + 1); y <= y1; y++) if (cell(x, y, z) !== false) return y;
    return undefined;
  };
  const refuse = (y: number, ahead: number): SkyCheck => {
    const above = y - feet;
    return { ok: false, roofY: y, above, ahead, line: `fly: no open sky here (roof at y ${y}, ${above} block${above === 1 ? '' : 's'} up${ahead > 0 ? `, ${ahead} ahead` : ''}); walk outside first` };
  };
  let lowest: { y: number; ahead: number } | undefined;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const y = roof(fx + dx, fz + dz, dx === 0 && dz === 0 ? feet + 1 : feet + 3);
      if (y !== undefined && (!lowest || y < lowest.y)) lowest = { y, ahead: 0 };
    }
  }
  if (lowest) return refuse(lowest.y, 0);
  const bearing = yawTo(from, target);
  const runClear = (yaw: number): { y: number; ahead: number } | undefined => {
    const r = (yaw * Math.PI) / 180;
    const dir = { x: -Math.sin(r), z: Math.cos(r) };
    for (let i = 1; i <= run; i++) {
      const cone = feet - TAKEOFF_CONE.berth + Math.max(0, i - TAKEOFF_CONE.flat) * TAKEOFF_CONE.slope;
      const y = roof(Math.floor(from.x + dir.x * i), Math.floor(from.z + dir.z * i), Math.ceil(cone));
      if (y !== undefined) return { y, ahead: i };
    }
    return undefined;
  };
  let first: { y: number; ahead: number } | undefined;
  for (const off of [0, 30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180]) {
    const yaw = bearing + off;
    const hit = runClear(yaw);
    if (!hit) return { ok: true, yaw };
    first ??= hit;
  }
  return refuse(first!.y, first!.ahead);
}

/**
 * The path ahead (Track AU2): the glide of `ticks` ticks from `body` with `yaw` and `pitch` held, on
 * the formula, against the world model's solid cells (unknown = free). The tick of the first hit, or
 * undefined when the path is clear. Checked at every tick's end and midpoint like the landing's
 * simulation (a one-block wall is thinner than a tick of flight).
 */
export function pathAhead(body: FlightBody, yaw: number, pitch: number, ticks: number, obstacle: Obstacle): number | undefined {
  let pos = { ...body.pos };
  let vel = { ...body.vel };
  let boost = body.boostTicks;
  for (let t = 1; t <= ticks; t++) {
    vel = glideVelocity(vel, yaw, pitch, boost > 0);
    if (boost > 0) boost--;
    const nx = { x: pos.x + vel.x, y: pos.y + vel.y, z: pos.z + vel.z };
    if (hitsObstacle(obstacle, nx) || hitsObstacle(obstacle, { x: (pos.x + nx.x) / 2, y: (pos.y + nx.y) / 2, z: (pos.z + nx.z) / 2 })) return t;
    pos = nx;
  }
  return undefined;
}

/** Radii the descent spiral may use (blocks); the circle's columns must be free this much farther out (the body strays from the circle). */
export const SPIRAL_RADII = Object.freeze({ min: 6, max: 24, berth: 4 });

export interface SpiralFit {
  centre: { x: number; z: number };
  radius: number;
}

/**
 * The descent geometry (Track AU2, docs/flight.md "Descent geometry"): the largest circle of radius
 * SPIRAL_RADII.min to .max around `centre` whose columns (out to the radius plus the berth) are all
 * lower than `below` (the height the body will come down to in the circle, minus a margin), from the
 * world model's column tops (`skyTop`: the highest solid block, undefined = unknown, which blocks).
 * Undefined when none fits.
 */
export function spiralFit(centre: { x: number; z: number }, below: number, skyTop: (x: number, z: number) => number | undefined): SpiralFit | undefined {
  const cx = Math.floor(centre.x);
  const cz = Math.floor(centre.z);
  // the farthest free ring: every column within r + berth lower than `below`
  const rMax = SPIRAL_RADII.max + SPIRAL_RADII.berth;
  let free = Infinity;
  for (let dx = -rMax; dx <= rMax; dx++) {
    for (let dz = -rMax; dz <= rMax; dz++) {
      const d = Math.hypot(dx, dz);
      if (d > rMax || d >= free) continue;
      const t = skyTop(cx + dx, cz + dz);
      if (t === undefined || t + 1 >= below) free = d;
    }
  }
  // the circle's radius must stay strictly inside the free ring by the berth (a wall 10 out blocks a radius of 6)
  const radius = Math.min(SPIRAL_RADII.max, Math.ceil(free - SPIRAL_RADII.berth) - 1);
  if (radius < SPIRAL_RADII.min) return undefined;
  return { centre: { x: cx + 0.5, z: cz + 0.5 }, radius };
}

/**
 * The yaw that follows a circle of `radius` around `centre` (pure pursuit on the circle: aim about
 * 10 blocks ahead along it, `dir` +1 = clockwise seen from above in Bedrock's yaw sense), turning
 * from `yaw` by at most 15 degrees a tick.
 */
export function circleYaw(yaw: number, pos: { x: number; z: number }, centre: { x: number; z: number }, radius: number, dir: 1 | -1): number {
  const ang = Math.atan2(pos.z - centre.z, pos.x - centre.x);
  const d = Math.max(1e-6, hdist(pos, centre));
  // far outside the circle: head for the nearest point of it; on it: a point 10 blocks ahead along it
  const ahead = d > radius + 10 ? 0.15 : 10 / radius;
  const a = ang + dir * ahead;
  const aim = { x: centre.x + Math.cos(a) * radius, z: centre.z + Math.sin(a) * radius };
  return turnTowards(yaw, yawTo(pos, aim), 15);
}

/** Where the approach begins: `APPROACH_DISTANCE` before the target on the line from `from`, `APPROACH_HEIGHT` above its top. */
export function approachEntry(from: { x: number; z: number }, target: LandingTarget, distance = APPROACH_DISTANCE): Vec3 {
  const d = hdist(from, target);
  if (d < 1e-6) return { x: target.x, y: target.top + APPROACH_HEIGHT, z: target.z - distance };
  const ux = (from.x - target.x) / d;
  const uz = (from.z - target.z) / d;
  return { x: target.x + ux * distance, y: target.top + APPROACH_HEIGHT, z: target.z + uz * distance };
}

export type TouchdownKind = 'landed' | 'short' | 'over' | 'wall' | 'none';

/** A solid cell at integer (x, y, z) the body must not fly through (the world model; unknown = false). */
export type Obstacle = (x: number, y: number, z: number) => boolean;

export interface Touchdown {
  kind: TouchdownKind;
  /** Feet position at the end of the simulated glide. */
  pos: Vec3;
  /** The velocity of the last airborne tick: what hits the ground. */
  vel: Vec3;
  ticks: number;
  /** Horizontal distance from the platform centre at touchdown. */
  off: number;
}

// ---- the approach profile -------------------------------------------------------------------------

/**
 * The approach profile (see the file comment): two approach segments (the first bleeds speed or
 * loses height, the second brings the body to the flare point), the flare and the settle. Measured
 * on the glide formula (docs/flight.md "Landing"): the zoom climb of the flare grows with the square
 * of the speed (from 0.9 blocks/tick a -60 flare climbs 0.4 blocks, from 1.2 about 7, from 1.6 about
 * 20), so a landing bleeds the speed to about 0.9 before the flare and settles from under a block up.
 */
export interface ApproachProfile {
  /** A1: the pitch held for `ticksA1` ticks. */
  pitchA1: number;
  ticksA1: number;
  /** A2: the pitch held until the flare point. */
  pitchA2: number;
  /** The flare starts this many blocks (horizontal) before the target centre. */
  flareAt: number;
  /** B: the flare pitch (negative = looking up). */
  pitchB: number;
  /** C: the settling pitch until contact. */
  pitchC: number;
}

export type ProfilePhase = 'A1' | 'A2' | 'B' | 'C';

/** Where the flown profile is (the planner keeps it; the simulation starts from it). */
export interface ProfileState {
  phase: ProfilePhase;
  /** Ticks spent in A1. */
  ticksA: number;
  /** B: the body rose (vy > 0) since the flare began. */
  rose: boolean;
  /** Ticks spent in B. */
  flareTicks: number;
}

export const PROFILE_START: Readonly<ProfileState> = Object.freeze({ phase: 'A1', ticksA: 0, rose: false, flareTicks: 0 });

/** The pitch law of a profile: the pitch for this tick and the state after it (pure). */
export function profilePitch(prof: ApproachProfile, st: ProfileState, pos: Vec3, vel: Vec3, target: LandingTarget): { pitch: number; next: ProfileState } {
  let { phase, ticksA, rose, flareTicks } = st;
  if (phase === 'A1') {
    if (ticksA >= prof.ticksA1) phase = 'A2';
    else ticksA++;
  }
  if ((phase === 'A1' || phase === 'A2') && hdist(pos, target) <= prof.flareAt) phase = 'B';
  if (phase === 'B') {
    const h = Math.hypot(vel.x, vel.z);
    if (vel.y > 0) rose = true;
    if ((rose && vel.y <= 0) || h < SETTLE_SPEED || flareTicks >= FLARE_MAX) phase = 'C';
    else flareTicks++;
  }
  const pitch = phase === 'A1' ? prof.pitchA1 : phase === 'A2' ? prof.pitchA2 : phase === 'B' ? prof.pitchB : prof.pitchC;
  return { pitch, next: { phase, ticksA, rose, flareTicks } };
}

/**
 * Simulate the glide along `prof` from `body` (in profile state `st`), the yaw turning towards the
 * target each tick as the brain flies it, until the feet touch the platform top, pass the target,
 * hit its side, reach the ground, or `maxTicks`.
 */
export function simulateProfile(body: FlightBody, yaw: number, target: LandingTarget, prof: ApproachProfile, st: ProfileState = PROFILE_START, maxTicks = 240, obstacle?: Obstacle): Touchdown {
  let pos = { ...body.pos };
  let vel = { ...body.vel };
  let y = yaw;
  let boost = body.boostTicks;
  let ps = st;
  const inside = (p: Vec3): boolean => onTarget(target, p);
  const ground = target.ground ?? target.top - 24;
  // Track BF: near the target only its floor (and below) is no obstacle, with a thin berth: a wall on a
  // platform, a ceiling over an overhang landing still count (before, the whole check stopped there)
  const nearObstacle: Obstacle | undefined = obstacle ? (x, y, z) => y >= target.top && obstacle(x, y, z) : undefined;
  const nearZone = target.half + 0.6 + OBSTACLE_BERTH;
  for (let t = 1; t <= maxTicks; t++) {
    y = approachYaw(y, pos, target);
    const { pitch, next } = profilePitch(prof, ps, pos, vel, target);
    ps = next;
    vel = glideVelocity(vel, y, pitch, boost > 0);
    if (boost > 0) boost--;
    const nx = { x: pos.x + vel.x, y: pos.y + vel.y, z: pos.z + vel.z };
    // crossing the platform's top plane inside the footprint: touchdown (far from the platform the body
    // just flies on below its top: the approach comes in low on purpose)
    if (pos.y >= target.top && nx.y <= target.top) {
      const f = (pos.y - target.top) / Math.max(1e-9, pos.y - nx.y);
      const at = { x: pos.x + (nx.x - pos.x) * f, y: target.top, z: pos.z + (nx.z - pos.z) * f };
      if (inside(at)) return { kind: 'landed', pos: at, vel, ticks: t, off: hdist(at, target) };
      if (hdist(at, target) <= target.half + 1.2) return { kind: 'short', pos: at, vel, ticks: t, off: hdist(at, target) }; // just beside it: a miss
    }
    // into the side of the platform while below its top (the approach from below pulled up too late)
    if (nx.y < target.top && inside(nx) && !inside(pos)) return { kind: 'wall', pos: nx, vel, ticks: t, off: hdist(nx, target) };
    // the ground around the platform
    if (nx.y <= ground) return { kind: 'short', pos: nx, vel, ticks: t, off: hdist(nx, target) };
    // a block in the way of the body's box (0.6 wide, 0.6 high while gliding; the platform's own top row is the landing)
    // (checked at the step's end and its midpoint: a one-block wall is thinner than a tick of flight)
    if (obstacle) {
      const mid = { x: (pos.x + nx.x) / 2, y: (pos.y + nx.y) / 2, z: (pos.z + nx.z) / 2 };
      const near = hdist(nx, target) <= nearZone;
      const o = near ? nearObstacle! : obstacle;
      const berth = near ? NEAR_BERTH : OBSTACLE_BERTH;
      if (hitsObstacle(o, nx, berth) || hitsObstacle(o, mid, berth)) return { kind: 'wall', pos: nx, vel, ticks: t, off: hdist(nx, target) };
    }
    // past the target above its top: overshoot
    const toT = { x: target.x - nx.x, z: target.z - nx.z };
    if (nx.y > target.top && hdist(nx, target) > target.half + 0.5 && toT.x * vel.x + toT.z * vel.z < 0 && hdist(pos, target) < target.half + 3) {
      return { kind: 'over', pos: nx, vel, ticks: t, off: hdist(nx, target) };
    }
    pos = nx;
  }
  return { kind: 'none', pos, vel, ticks: maxTicks, off: hdist(pos, target) };
}

/**
 * The cost of a simulated touchdown (lower is better; `landed` with a near stall at the centre is
 * about 0). The misses carry a gradient (how high it passed, how far it fell short) for the search.
 */
export function touchdownCost(td: Touchdown, target: LandingTarget): number {
  const h = Math.hypot(td.vel.x, td.vel.z);
  if (td.kind === 'landed' && target.walk && target.cells) {
    // Track BF, a landing for a walk: anywhere in the confirmed cells is fine; what counts is the damage
    // (vy), the slide staying inside the cells (the server slides up to 0.8 further than the model) and time
    const vy = Math.max(0, -td.vel.y - TOUCHDOWN_VY);
    const hs = Math.max(0, h - WALK_TOUCHDOWN_H);
    const out = slideOut(target, td.pos, td.vel, h * 1.2 + SERVER_SLIDE);
    return td.off * WALK_OFF_COST + vy * 40 + hs * 25 + out * 30 + Math.max(0, td.ticks - 60) * TICK_COST;
  }
  if (td.kind === 'landed') {
    const vy = Math.max(0, -td.vel.y - TOUCHDOWN_VY);
    const hs = Math.max(0, h - TOUCHDOWN_H);
    // the slide after touchdown must stay on the platform: speed counts against the room left
    const room = Math.max(0.05, target.half + 0.5 - td.off);
    // the time term keeps a plan from parachuting down at stall speed for hundreds of ticks (an emergency landing from high up)
    return td.off * 2 + vy * 40 + hs * 40 + Math.max(0, h * 1.2 - room) * 30 + Math.max(0, td.ticks - 60) * TICK_COST;
  }
  if (td.kind === 'wall') return 200 + h * 30 + Math.max(0, target.top - td.pos.y) * 2;
  if (td.kind === 'over') return 120 + Math.max(0, td.pos.y - target.top) * 3 + td.off;
  if (td.kind === 'short') return 80 + td.off * 2;
  return 60 + td.off;
}

/**
 * Track BF: the touchdown point `at` is on the target: inside the confirmed cells of a walk landing,
 * else inside the platform's footprint (half + 0.2).
 */
export function onTarget(target: LandingTarget, at: { x: number; z: number }): boolean {
  if (target.cells) return target.cells.has(columnKey(Math.floor(at.x), Math.floor(at.z)));
  return Math.abs(at.x - target.x) <= target.half + 0.2 && Math.abs(at.z - target.z) <= target.half + 0.2;
}

/** Track BF: the server's body slides this much further after the glide ends than the model's (measured 0.6 to 0.8). */
export const SERVER_SLIDE = 0.8;
/** Track BF: a walk landing's touchdown speed above which the slide counts (the cells give room). */
export const WALK_TOUCHDOWN_H = 0.5;
/** Track BF: a walk landing's cost per block from the centre (a block of walk; the exact landing's is 2). */
export const WALK_OFF_COST = 0.3;
/** Track BF: the berth around the body near the target (its own walls and ceiling; farther out OBSTACLE_BERTH). */
export const NEAR_BERTH = 0.1;

/**
 * Track BF: how much of a slide of `dist` blocks from `at` along the horizontal velocity leaves the
 * target's cells: 0 = it stays inside, towards 1 = it leaves at once (quarter-block steps).
 */
export function slideOut(target: LandingTarget, at: { x: number; z: number }, vel: { x: number; z: number }, dist: number): number {
  const h = Math.hypot(vel.x, vel.z);
  if (h < 1e-6 || dist <= 0) return onTarget(target, at) ? 0 : 1;
  const ux = vel.x / h;
  const uz = vel.z / h;
  const steps = Math.max(1, Math.ceil(dist / 0.25));
  for (let i = 0; i <= steps; i++) {
    const s = (dist * i) / steps;
    if (!onTarget(target, { x: at.x + ux * s, z: at.z + uz * s })) return 1 - i / (steps + 1);
  }
  return 0;
}

/** The gliding body's box (half width 0.3, height 0.6) with a berth of OBSTACLE_BERTH around it and under the feet (the real body strays a few tenths from the plan between corrections; grazing a block's edge counts) overlaps a solid cell. */
export const OBSTACLE_BERTH = 0.4;
export function hitsObstacle(obstacle: Obstacle, p: Vec3, berth = OBSTACLE_BERTH): boolean {
  const r = 0.3 + berth;
  const x0 = Math.floor(p.x - r);
  const x1 = Math.floor(p.x + r);
  const z0 = Math.floor(p.z - r);
  const z1 = Math.floor(p.z + r);
  const y0 = Math.floor(p.y - berth);
  const y1 = Math.floor(p.y + 0.6 + berth);
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) if (obstacle(x, y, z)) return true;
  return false;
}

/** The ranges the planner samples profiles from. */
export const RANGES = Object.freeze({
  pitchA1: [-30, 45],
  ticksA1: [0, 40],
  pitchA2: [-30, 45],
  flareAt: [2, 30],
  pitchB: [-85, -20],
  pitchC: [-30, 30],
} as const);
/** Cost per tick of a landing plan beyond 60 ticks (about 1 point per 25 ticks). */
export const TICK_COST = 0.04;
/** A landing plan under this cost is soft enough that the planner only refines it. */
export const GOOD_COST = 8;
const STEPS: Record<keyof ApproachProfile, number> = { pitchA1: 5, ticksA1: 4, pitchA2: 5, flareAt: 1, pitchB: 5, pitchC: 5 };
const PARAMS = Object.keys(RANGES) as (keyof ApproachProfile)[];

export interface ApproachChoice {
  pitch: number;
  cost: number;
  touchdown: Touchdown;
  profile: ApproachProfile;
  phase: ProfilePhase;
  /** Simulations this tick. */
  sims: number;
}

/**
 * The approach planner of one landing: keeps the profile being flown and its phase, re-optimises the
 * free parameters every tick (random samples around and across the ranges, then a hill climb; more
 * samples while no plan lands) and returns the pitch to hold now. `reset()` for a new approach (a
 * go-around). Deterministic: a seeded generator, so a flight replays the same.
 */
export class ApproachPlanner {
  private prof: ApproachProfile | undefined;
  private st: ProfileState = { ...PROFILE_START };
  private last: ApproachChoice | undefined;
  private seed: number;
  private readonly obstacle: Obstacle | undefined;
  /** Consecutive ticks whose best plan does not land. */
  missing = 0;

  constructor(seed = 12345, obstacle?: Obstacle) {
    this.seed = seed >>> 0 || 1;
    this.obstacle = obstacle;
  }

  get state(): Readonly<ProfileState> {
    return this.st;
  }

  get current(): ApproachChoice | undefined {
    return this.last;
  }

  reset(): void {
    this.prof = undefined;
    this.st = { ...PROFILE_START };
    this.last = undefined;
    this.missing = 0;
  }

  private rnd(): number {
    // xorshift32
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x >>> 0;
    return this.seed / 4294967296;
  }

  private sample(base: ApproachProfile | undefined, free: ReadonlySet<keyof ApproachProfile>, local: boolean): ApproachProfile {
    const out: ApproachProfile = base ? { ...base } : { pitchA1: 0, ticksA1: 0, pitchA2: 0, flareAt: 12, pitchB: -60, pitchC: -10 };
    for (const k of PARAMS) {
      if (!free.has(k)) continue;
      const [lo, hi] = RANGES[k];
      const v = local && base ? base[k] + (this.rnd() * 2 - 1) * STEPS[k] * 3 : lo + this.rnd() * (hi - lo);
      out[k] = Math.round(clamp(v, lo, hi));
    }
    return out;
  }

  /** Plan from the body now (yaw = the yaw the brain will command this tick) and advance the profile's phase. */
  step(body: FlightBody, yaw: number, target: LandingTarget): ApproachChoice {
    let sims = 0;
    const evalP = (p: ApproachProfile): { p: ApproachProfile; cost: number; td: Touchdown } => {
      sims++;
      const td = simulateProfile(body, yaw, target, p, this.st, 240, this.obstacle);
      return { p, cost: touchdownCost(td, target), td };
    };
    const free = this.freeParams();
    let best = this.prof ? evalP(this.prof) : undefined;
    // samples: many across the ranges until a soft landing is planned (GOOD_COST), fewer around the plan afterwards
    const good = best?.td.kind === 'landed' && best.cost <= GOOD_COST;
    const wide = good ? 30 : 120;
    const near = 40;
    for (let n = 0; n < wide + near; n++) {
      const r = evalP(this.sample(best?.p, free, n >= wide));
      if (!best || r.cost < best.cost) best = r;
    }
    // the hill climb: each free parameter one step either way, until no step helps (at most 3 rounds)
    for (let round = 0; round < 3 && best; round++) {
      let improved = false;
      for (const k of free) {
        for (const dir of [-1, 1]) {
          const [lo, hi] = RANGES[k];
          const v = clamp(best.p[k] + dir * STEPS[k], lo, hi);
          if (v === best.p[k]) continue;
          const r = evalP({ ...best.p, [k]: v });
          if (r.cost < best.cost - 1e-9) {
            best = r;
            improved = true;
          }
        }
      }
      if (!improved) break;
    }
    const b = best!;
    this.prof = b.p;
    const { pitch, next } = profilePitch(b.p, this.st, body.pos, body.vel, target);
    this.st = next;
    this.missing = b.td.kind === 'landed' ? 0 : this.missing + 1;
    this.last = { pitch, cost: b.cost, touchdown: b.td, profile: b.p, phase: this.st.phase, sims };
    return this.last;
  }

  /** The parameters still ahead of the flown phase. */
  private freeParams(): Set<keyof ApproachProfile> {
    const s = new Set<keyof ApproachProfile>(['pitchC']);
    if (this.st.phase !== 'C') s.add('pitchB');
    if (this.st.phase === 'A1' || this.st.phase === 'A2') {
      s.add('pitchA2');
      s.add('flareAt');
    }
    if (this.st.phase === 'A1') {
      s.add('pitchA1');
      s.add('ticksA1');
    }
    return s;
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * The approach cannot end on the platform from here: no plan landed for `patience` ticks within
 * `within` blocks of the target, or the touchdown ahead is hard (cost over `hard`) and near: go around.
 */
export function approachHopeless(c: ApproachChoice, missing: number, distance: number, o: { patience?: number; within?: number; hard?: number } = {}): boolean {
  const patience = o.patience ?? 6;
  const within = o.within ?? 45;
  const hard = o.hard ?? 35;
  if (c.touchdown.kind !== 'landed') return missing >= patience && distance <= within;
  // a hard landing ahead: go around while there is room to turn (a very hard one from farther out)
  return (c.cost > hard && distance <= 14) || (c.cost > hard * 2 && distance <= 30);
}

/**
 * Rockets a flight of `distance` blocks with a climb of `climb` blocks needs (Track AU2, the energy
 * model): one per ROCKET_CLIMB blocks of climb (at least one: the takeoff), plus a top-up per
 * ROCKET_CRUISE_CLIMB x GLIDE_RATIO blocks of glide beyond what the climb's height covers.
 */
export function estimateRockets(distance: number, climb: number): number {
  const up = Math.max(ROCKET_CLIMB, climb); // the takeoff's rocket climbs at least one rocket's worth
  const climbRockets = Math.ceil(up / ROCKET_CLIMB);
  const glide = Math.max(0, up - APPROACH_HEIGHT) * GLIDE_RATIO + up * CLIMB_RUN + APPROACH_DISTANCE;
  return climbRockets + Math.ceil(Math.max(0, distance - glide) / (ROCKET_CRUISE_CLIMB * GLIDE_RATIO));
}

/** Seconds a flight of `distance` blocks takes at the cruise speed (measured 1.3 to 1.5 blocks per tick) plus takeoff and landing. */
export function flightSeconds(distance: number): number {
  return Math.round(distance / 1.35 / 20 + 8);
}

/** Minutes the walk would take (the steady sprint speed, 1 block per 3.564 ticks). */
export function walkMinutes(distance: number): number {
  return (distance * 3.564) / 20 / 60;
}
