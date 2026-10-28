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
 * The cruise height: `clearance` above every known column top under the straight line (unknown
 * columns count as the highest known), and at least `cruise` above the higher of the two ends;
 * never more than what a glide from the approach entry back down to the target would waste
 * (`APPROACH_HEIGHT` + SINK_RATIO x distance above the target). `skyTop(x, z)` = the highest solid
 * block of the column (undefined = unknown).
 */
export function cruiseHeight(
  from: Vec3,
  target: LandingTarget,
  skyTop: (x: number, z: number) => number | undefined,
  o: { clearance?: number; cruise?: number } = {},
): { y: number; highest: number | undefined; unknown: number } {
  const clearance = o.clearance ?? DEFAULT_CLEARANCE;
  const cruise = o.cruise ?? DEFAULT_CRUISE;
  let highest: number | undefined;
  let unknown = 0;
  for (const c of columnsAlong(from, target)) {
    const t = skyTop(c.x, c.z);
    if (t === undefined) unknown++;
    else if (highest === undefined || t > highest) highest = t;
  }
  const terrain = highest === undefined ? Math.max(from.y, target.top) : highest + 1 + clearance;
  const ends = Math.max(from.y, target.top) + cruise;
  const distance = hdist(from, target);
  // what the glide slope from the approach entry needs: the cruise is flown after the climb, which
  // itself covers about CLIMB_RUN blocks per block climbed (two rounds settle the circular estimate)
  let enough = target.top + APPROACH_HEIGHT + 2;
  for (let i = 0; i < 2; i++) {
    const climbRun = Math.max(0, enough - from.y) * CLIMB_RUN;
    enough = target.top + APPROACH_HEIGHT + Math.max(0, distance - APPROACH_DISTANCE - climbRun) * SINK_RATIO + 2;
  }
  const y = Math.max(terrain, Math.min(ends, enough), target.top + APPROACH_HEIGHT + 2);
  return { y, highest, unknown };
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
  const inside = (p: Vec3): boolean => Math.abs(p.x - target.x) <= target.half + 0.2 && Math.abs(p.z - target.z) <= target.half + 0.2;
  const ground = target.ground ?? target.top - 24;
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
    if (obstacle && hdist(nx, target) > target.half + 0.6 + OBSTACLE_BERTH && (hitsObstacle(obstacle, nx) || hitsObstacle(obstacle, { x: (pos.x + nx.x) / 2, y: (pos.y + nx.y) / 2, z: (pos.z + nx.z) / 2 }))) {
      return { kind: 'wall', pos: nx, vel, ticks: t, off: hdist(nx, target) };
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

/** The gliding body's box (half width 0.3, height 0.6) with a berth of OBSTACLE_BERTH around it and under the feet (the real body strays a few tenths from the plan between corrections; grazing a block's edge counts) overlaps a solid cell. */
export const OBSTACLE_BERTH = 0.4;
export function hitsObstacle(obstacle: Obstacle, p: Vec3): boolean {
  const r = 0.3 + OBSTACLE_BERTH;
  const x0 = Math.floor(p.x - r);
  const x1 = Math.floor(p.x + r);
  const z0 = Math.floor(p.z - r);
  const z1 = Math.floor(p.z + r);
  const y0 = Math.floor(p.y - OBSTACLE_BERTH);
  const y1 = Math.floor(p.y + 0.6 + OBSTACLE_BERTH);
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

/** Rockets a flight of `distance` blocks needs: the climb plus about one per 100 blocks of cruise (measured, docs/flight.md). */
export function estimateRockets(distance: number, climb: number): number {
  return Math.ceil(Math.max(0, climb) / 18) + Math.ceil(Math.max(0, distance - APPROACH_DISTANCE) / 100) + 1;
}

/** Seconds a flight of `distance` blocks takes at the cruise speed (measured 1.3 to 1.5 blocks per tick) plus takeoff and landing. */
export function flightSeconds(distance: number): number {
  return Math.round(distance / 1.35 / 20 + 8);
}

/** Minutes the walk would take (the steady sprint speed, 1 block per 3.564 ticks). */
export function walkMinutes(distance: number): number {
  return (distance * 3.564) / 20 / 60;
}
