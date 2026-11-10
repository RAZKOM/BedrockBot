// Track F9b (docs/flight.md "Learned exits (Track F9b)"; decisions/0078-learned-exits.md): the follower that flies a
// body along a guide (`guide.ts`: a recorded flight as a line). It needs no search and no plan: every tick it finds the
// body's place on the line, aims at the line a little ahead (the distance the body covers in the horizon), and flies the
// look near that aim whose glide of the next FOLLOW_HORIZON ticks on the glide formula stays nearest the line and clear
// of every solid, for the burn the body reports and for the burn ending as early and as late as a rocket's can. The
// rockets go where the recording's did (the first one as long after the jump as the recording fired it, which is after
// the glide is on; a later one at its place on the line), and one more whenever the body is slower than FOLLOW_SPEED
// with line still ahead (a short burn where the recording had a long one).
//
// The line is given up (`lost`: the driver lands) when the body is far off it, never glides, gets no farther along it,
// or when every look still ends in a solid within the horizon: then no rocket goes and the body brakes first. A look that
// only passes within the berth of a block is a graze and is flown (the recorded line itself may pass so: a takeoff beside
// a block); the bare box meeting one is a crash.
//
// The follower is the same code in the proof and in the flight, and asks nothing of a planner: what is simulated is
// what flies (the route tracker's plans come from a worker some ticks after they are asked, which a simulation does not
// wait for in the same way; decisions/0078 has the measurement).
//
// Track F9c (docs/flight.md "Learned entries (Track F9c)"; decisions/0080-learned-entries.md):
//   - `entry`: the line is a way IN. The body joins it in the air out of a cruise (no jump, no wait for a glide), no rocket
//     is asked for (the recorded ways in glide; a rocket near a touchdown under a roof is the wrong tool), and a body
//     that stands is at the line's end whatever its place on it. The touchdown itself is `learn/entry.ts`.
//   - a rocket that fired nothing (the server ignored the use; the input loop takes its boost back ROCKET_ADD_WITHIN
//     ticks later, so the burn the follower saw is shorter than any rocket's) is asked for again on the tick the
//     write-off shows, whatever the body's speed then.
import type { Vec3 } from '../../../connection/types.ts';
import { glideVelocity } from '../../input/physics.ts';
import { boxClear, sweep, type RouteGrid } from '../route/grid.ts';
import { BURN } from '../route/types.ts';
import { guideLength, guideNearest, guidePoint, type Guide } from './guide.ts';

/** The glide checked ahead every tick (ticks), and the aim's distance along the line: the blocks the body covers in the horizon, within these bounds. */
export const FOLLOW_HORIZON = 6;
export const FOLLOW_AIM_MIN = 4;
export const FOLLOW_AIM_MAX = 12;
/** The berth the checked glide keeps round the gliding box (blocks). */
export const FOLLOW_MARGIN = 0.3;
/** Slower than this (blocks a tick) with line still ahead and no rocket burning: another rocket. */
export const FOLLOW_SPEED = 1.0;
/** ... but not within this many blocks of the line's end (the climb after it fires its own). */
export const FOLLOW_SPEED_END = 6;
/** The body this far off the line (blocks) for FOLLOW_LOST_TICKS ticks has lost it; so has a body that is not gliding FOLLOW_NO_GLIDE ticks after its first jump. */
export const FOLLOW_LOST = 5;
export const FOLLOW_LOST_TICKS = 5;
export const FOLLOW_NO_GLIDE = 30;
/** ... and one whose glide has not got a block farther along the line in this many ticks (the jump's own wait for its rocket is 8 to 11). */
export const FOLLOW_STUCK = 30;
/** ... and one whose every look ends in a solid within the horizon, this many ticks in a row: it brakes first (the look turned round at this pitch until it is this slow, this many ticks at most). */
export const FOLLOW_CRASH_TICKS = 2;
export const FOLLOW_BRAKE_PITCH = -20;
export const FOLLOW_BRAKE_DONE = 0.25;
export const FOLLOW_BRAKE_TICKS = 12;
/** The look offsets tried round the aim (degrees). */
const YAWS = [0, -6, 6, -14, 14, -28, 28, -45, 45];
const PITCHES = [0, -8, 8, -18, 18, 30];
/**
 * The berth broken in the checked glide costs HIT, more the sooner (a graze: the body passes within FOLLOW_MARGIN of a solid);
 * the bare box (BARE of berth) meeting one costs CRASH; a tick within a block of a solid costs up to CLOSE.
 */
const HIT = 1000;
const CRASH = 100_000;
const BARE = 0.02;
const CLOSE = 0.6;
/** A degree of offset from the aim costs this much (the aim wins a tie). */
const OFFSET = 0.004;

/** `lineRoom` skips this many blocks of the line from its start (the takeoff: the box stands on the floor there) and measures no farther than LINE_ROOM_MAX from the box. */
export const LINE_ROOM_FROM = 3;
export const LINE_ROOM_MAX = 1;

/**
 * The least room a guide's own line keeps: the gap from the gliding box on each of its points to the nearest solid, from
 * LINE_ROOM_FROM blocks along it to `to` (its first open sky), capped at LINE_ROOM_MAX. A line under FOLLOW_MARGIN grazes
 * a block by itself, before any body has flown it.
 */
export function lineRoom(grid: RouteGrid, g: Pick<Guide, 'points'>, to: number): number {
  let room: number = LINE_ROOM_MAX;
  const n = Math.min(g.points.length - 1, Math.round(to));
  for (let i = LINE_ROOM_FROM; i <= n; i++) room = Math.min(room, boxClear(grid, g.points[i]!, 0).clearance);
  return room;
}

export interface FollowBody {
  pos: Vec3;
  vel: Vec3;
  gliding: boolean;
  onGround: boolean;
  /** Ticks the burning rocket is expected to burn on (0: none burns). */
  boostTicks: number;
  rockets: number;
}

export interface FollowControl {
  yaw: number;
  pitch: number;
  fire: boolean;
  jump?: boolean;
}

export interface FollowOutput {
  control: FollowControl;
  /** `lost`: the body is off the line or never glided (`why` says); `done`: the line's end is reached. */
  status: 'takeoff' | 'following' | 'done' | 'lost';
  /** The body's place on the line (blocks along it) and its distance from the line. */
  at: number;
  error: number;
  why?: string;
  /** Track F9c: the best look this tick still ends in a solid within the horizon (a way in's line ends on the ground: its driver begins the touchdown there). */
  crash?: boolean;
}

export interface FollowStats {
  ticks: number;
  /** Rockets asked for (the driver decides whether one goes). */
  asked: number;
  maxError: number;
  /** Ticks a look other than the aim was flown because the aim's glide met a solid. */
  steered: number;
  /** Ticks on which every look tried met a solid within the horizon. */
  blocked: number;
  /** Track F9c: ticks a way in's speed governor looked back (FOLLOW_TAP_OVER). */
  taps: number;
}

export interface FollowOptions {
  grid: RouteGrid;
  guide: Guide;
  margin?: number;
  note?: (msg: string) => void;
  /** Track F9c: the line is a way in, joined in the air and ended on the ground: no jump, no rocket (see the file comment). */
  entry?: FollowEntry;
}

/** Track F9c: a way in's end: the touchdown the driver brakes over, and how far from it (blocks, horizontally) that brake has begun at a horizontal speed (the checked glide ends there). */
export interface FollowEntry {
  touchdown: Vec3;
  reach(speed: number): number;
  /** The speed the recording had `at` blocks along the line (blocks a tick; 0: unknown): a body faster than FOLLOW_TAP_OVER of it is slowed (the speed governor below). */
  speed(at: number): number;
  /** The body joins the line in the open: up to `until` blocks along it the line is lost only `lost` blocks off it (FOLLOW_LOST from there on). */
  join?: { until: number; lost: number };
  /** The body's place on the line when the follower takes it (blocks along it; default its start). */
  at?: number;
}

/**
 * Track F9c, speed without rockets: a way in is flown no faster than its recording flew it. A body over FOLLOW_TAP_OVER of
 * the recorded speed at its place (and FOLLOW_TAP_ABS over it) looks straight back along its velocity for one tick (the
 * brake's look: a fifth of the speed, the direction kept, the height held at FOLLOW_TAP_PITCH) and steers again the tick
 * after: never two ticks in a row, so the line is still followed. The recordings do the same with a pull-up before the
 * touchdown; a follower that tracks only the place arrived there half again as fast as its recording and met the wall
 * behind it.
 */
/** Track F9c: a way in's aim lies at least this many times the body's distance from the line ahead of its place on it. */
export const FOLLOW_JOIN_AIM = 2.5;
export const FOLLOW_TAP_OVER = 1.1;
export const FOLLOW_TAP_ABS = 0.05;
export const FOLLOW_TAP_PITCH = -30;

/** Track F9c: a burn seen to end after fewer ticks than this was no burn: the rocket fired nothing and its boost was taken back (rocket.ts ROCKET_ADD_WITHIN is 5; the shortest real burn is BURN.min and is seen GLIDE.boostEndLag longer). */
export const FOLLOW_DUD_TICKS = BURN.min - 1;
/** Track F9c, for the probe only (scripts/cave-exit-probe.ts --old-dud): `dud` false flies the follower as Track F9b left it, a rocket that fired nothing not noticed, to measure what noticing it changed. Nothing in the bot writes it. */
export const FOLLOW_SWITCH = { dud: true };

export class GuideFollower {
  readonly stats: FollowStats = { ticks: 0, asked: 0, maxError: 0, steered: 0, blocked: 0, taps: 0 };
  private readonly g: Guide;
  private readonly grid: RouteGrid;
  private readonly margin: number;
  private readonly length: number;
  private readonly note: ((msg: string) => void) | undefined;
  private at = 0;
  /** Ticks since the body left the ground; ticks since the last rocket began to burn. */
  private air = 0;
  private sinceFire = Infinity;
  private wasBoosting = false;
  /** The next recorded rocket; rockets seen burning. */
  private next = 0;
  private fired = 0;
  private lostTicks = 0;
  /** The place the glide last got a block farther along the line, and the follower's tick then. */
  private movedAt = 0;
  private movedTick = -1;
  /** Ticks in a row on which the best look still ended in a solid, and the brake that follows (where it began, its ticks, its look). */
  private crashRun = 0;
  private braking: { at: number; ticks: number; yaw: number } | undefined;
  /** The rocket count the last rocket's note was written for (one note a rocket). */
  private notedFor = -1;
  private jumps = 0;
  private firstJump = -1;
  /** Track F9c: a way in (no jump, no rocket); the last rocket fired nothing and is to be asked for again; rockets written off so. */
  private readonly entry: FollowEntry | undefined;
  private refire = false;
  private replaced = false;
  private tapped = false;
  private duds = 0;

  constructor(o: FollowOptions) {
    this.g = o.guide;
    this.grid = o.grid;
    this.margin = o.margin ?? FOLLOW_MARGIN;
    this.length = guideLength(o.guide);
    this.note = o.note;
    this.entry = o.entry;
    if (o.entry?.at !== undefined) this.at = Math.max(0, o.entry.at);
  }

  /** Track F9c: rockets seen to fire nothing so far (their boost taken back before a burn's shortest). */
  get wasted(): number {
    return this.duds;
  }

  /** The body's place on the line (blocks along it). */
  get place(): number {
    return this.at;
  }

  tick(b: FollowBody, tick: number): FollowOutput {
    this.stats.ticks++;
    // Track F9c: a rocket that fired nothing. The loop had predicted its boost and took it back: the body is where it would
    // be without it, behind the place the predicted body had reached on the line. The place is found again from the line's
    // start (it is otherwise never looked for behind the last one), or the follower aims from where the body is not: the
    // Realm's one failed learned exit flew its second rocket 6.5 off the line from there and met the passage
    if (FOLLOW_SWITCH.dud && b.boostTicks <= 0 && this.wasBoosting && this.sinceFire + 1 < FOLLOW_DUD_TICKS && !this.replaced) {
      this.replaced = true;
      const back = guideNearest(this.g, b.pos, 0, this.at + FOLLOW_AIM_MAX);
      if (back.at < this.at) {
        this.note?.(`learned line: the body is ${back.at.toFixed(0)} blocks along the line, not ${this.at.toFixed(0)} (a rocket's boost was taken back): followed from there`);
        this.at = back.at;
        this.movedAt = back.at;
        this.movedTick = this.stats.ticks;
      }
    }
    const near = guideNearest(this.g, b.pos, this.at, 2 * FOLLOW_AIM_MAX);
    this.at = near.at;
    if (b.gliding && near.dist > this.stats.maxError) this.stats.maxError = near.dist;
    const speed = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
    // (Track F9c: a way in's line ends at its touchdown: the aim is never beyond it)
    const ahead = this.at + Math.max(FOLLOW_AIM_MIN, Math.min(FOLLOW_AIM_MAX, speed * FOLLOW_HORIZON));
    // (and a body that joins it from far off, out of a cruise over it, aims FOLLOW_JOIN_AIM times its distance from the line
    // ahead: it comes onto the line at a slant that keeps its speed, not straight down at it)
    const aimAt = this.entry ? Math.min(this.length, Math.max(ahead, this.at + FOLLOW_JOIN_AIM * near.dist)) : ahead;
    const aim = guidePoint(this.g, aimAt).pos;
    const dx = aim.x - b.pos.x;
    const dy = aim.y - b.pos.y;
    const dz = aim.z - b.pos.z;
    const yaw = (Math.atan2(-dx, dz) * 180) / Math.PI;
    const pitch = Math.max(-70, Math.min(40, (-Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI));
    if (!b.onGround) this.air++;
    // Track F9c: a way in has no takeoff: a body that stands has landed (the line's end for the driver), one that is in the
    // air without a glide has lost it
    if (this.entry && !b.gliding) return { control: { yaw, pitch: Math.min(0, pitch), fire: false }, status: b.onGround ? 'done' : 'lost', at: this.at, error: near.dist, ...(b.onGround ? {} : { why: `no glide ${this.at.toFixed(0)} blocks along the line` }) };
    if (!b.gliding) {
      // the jump, and the ticks before the glide takes: the look along the line
      if (b.onGround) {
        if (this.firstJump < 0) this.firstJump = tick;
        this.air = 0;
        this.jumps++;
      }
      if (this.firstJump >= 0 && tick - this.firstJump > FOLLOW_NO_GLIDE) return { control: { yaw, pitch: 0, fire: false }, status: 'lost', at: this.at, error: near.dist, why: `no glide ${tick - this.firstJump} ticks after the jump (${this.jumps} jumps)` };
      return { control: { yaw, pitch: Math.min(0, pitch), fire: false, jump: b.onGround }, status: 'takeoff', at: this.at, error: near.dist };
    }
    // the burn: a rocket seen burning counts as fired; a recorded rocket whose place the body reaches while one burns is
    // done (the burn stands for it)
    const boosting = b.boostTicks > 0;
    if (boosting && !this.wasBoosting) {
      this.sinceFire = 0;
      this.fired++;
      this.refire = false;
      this.replaced = false;
    } else if (this.sinceFire < Infinity) this.sinceFire++;
    // Track F9c: the burn is over sooner than any rocket burns: that rocket fired nothing (the loop took its boost back):
    // asked for again now, not when the body has slowed down
    if (FOLLOW_SWITCH.dud && !boosting && this.wasBoosting && this.sinceFire < FOLLOW_DUD_TICKS) {
      this.refire = true;
      this.duds++;
      this.note?.(`learned line: rocket ${this.fired} fired nothing (its burn taken back after ${this.sinceFire} ticks, ${this.at.toFixed(0)} blocks along the line at ${speed.toFixed(2)} a tick): asked for again`);
    }
    this.wasBoosting = boosting;
    while (boosting && this.next < this.g.rockets.length && this.due(this.g.rockets[this.next]!)) this.next++;
    if (this.at >= this.length - 0.5) return { control: { yaw, pitch, fire: false }, status: 'done', at: this.at, error: near.dist };
    const lost = this.entry?.join && this.at <= this.entry.join.until ? this.entry.join.lost : FOLLOW_LOST;
    this.lostTicks = near.dist > lost ? this.lostTicks + 1 : 0;
    if (this.lostTicks >= FOLLOW_LOST_TICKS) return { control: { yaw, pitch, fire: false }, status: 'lost', at: this.at, error: near.dist, why: `${near.dist.toFixed(1)} off the line ${this.at.toFixed(0)} blocks along it` };
    // no way on: a glide that gets no farther along the line (something stands on it now that no look gets round)
    if (this.at > this.movedAt + 1 || this.movedTick < 0) {
      this.movedAt = this.at;
      this.movedTick = this.stats.ticks;
    } else if (this.stats.ticks - this.movedTick > FOLLOW_STUCK) return { control: { yaw, pitch, fire: false }, status: 'lost', at: this.at, error: near.dist, why: `no farther than ${this.at.toFixed(0)} blocks along the line in ${FOLLOW_STUCK} ticks` };
    const look = this.steer(b, yaw, pitch);
    // every look ends in a solid within the horizon (the world is not the recording's any more): the line is lost now,
    // while there is still room to stop, and no rocket goes into it
    this.crashRun = look.crash ? this.crashRun + 1 : 0;
    if (this.crashRun >= FOLLOW_CRASH_TICKS && this.braking === undefined) this.braking = { at: this.at, ticks: 0, yaw: (Math.atan2(-b.vel.x, b.vel.z) * 180) / Math.PI + 180 };
    if (this.braking) {
      // the 180 brake first (the envelope: stopped in 8 to 10 ticks and about 5 blocks, the height held at this pitch), then lost
      const h = Math.hypot(b.vel.x, b.vel.z);
      if (h < FOLLOW_BRAKE_DONE || this.braking.ticks++ >= FOLLOW_BRAKE_TICKS) return { control: { yaw, pitch: 0, fire: false }, status: 'lost', at: this.at, error: near.dist, why: `no look clears the solid ahead ${this.braking.at.toFixed(0)} blocks along the line (braked to ${h.toFixed(2)} a tick)` };
      return { control: { yaw: this.braking.yaw, pitch: FOLLOW_BRAKE_PITCH, fire: false }, status: 'following', at: this.at, error: near.dist };
    }
    // Track F9c, a way in's speed governor (FOLLOW_TAP_OVER): faster than the recording was here, the look goes straight back
    // for this tick; the steering has the next one
    if (this.entry && !look.crash) {
      const recorded = this.entry.speed(this.at);
      if (!this.tapped && recorded > 0 && speed > recorded * FOLLOW_TAP_OVER + FOLLOW_TAP_ABS) {
        this.tapped = true;
        this.stats.taps++;
        return { control: { yaw: (Math.atan2(-b.vel.x, b.vel.z) * 180) / Math.PI + 180, pitch: FOLLOW_TAP_PITCH, fire: false }, status: 'following', at: this.at, error: near.dist };
      }
      this.tapped = false;
    }
    // the rockets: the recording's where it fired them, and one more when the body is slow with line ahead
    let fire = false;
    if (!this.entry && !boosting && b.rockets > 0 && !look.crash) {
      const r = this.g.rockets[this.next];
      if (r && this.due(r)) fire = true;
      else if (this.refire && this.at < this.length - FOLLOW_SPEED_END) fire = true; // Track F9c: the one before fired nothing
      else if (this.fired > 0 && speed < FOLLOW_SPEED && this.at < this.length - FOLLOW_SPEED_END) fire = true;
      // (a recording with no rocket at its start, a glide off a height, is flown as it was: without one)
    }
    if (fire) {
      this.stats.asked++;
      if (this.notedFor !== this.fired) {
        this.notedFor = this.fired;
        const r = this.g.rockets[this.next];
        this.note?.(`learned line: rocket ${this.fired + 1} asked for ${this.at.toFixed(0)} blocks along it, ${this.air} ticks off the ground (${r && this.due(r) ? 'where the recording fired one' : this.refire ? 'the one before fired nothing' : `the body at ${Math.hypot(b.vel.x, b.vel.z).toFixed(2)} a tick with line ahead`})`);
      }
    }
    return { control: { yaw: look.yaw, pitch: look.pitch, fire }, status: 'following', at: this.at, error: near.dist, ...(look.crash ? { crash: true } : {}) };
  }

  /**
   * A recorded rocket is due: at its place on the line; the flight's first one also once the body has been off the ground as
   * long as the recording was when it fired it (a body that has not fired yet does not get along the line to any place).
   */
  private due(r: Guide['rockets'][number]): boolean {
    return this.at >= r.at - 0.5 || (this.fired === 0 && this.air >= r.tick);
  }

  /** The look near the aim whose glide over the horizon stays nearest the line and clear, for every end the burn may have. */
  private steer(b: FollowBody, yaw: number, pitch: number): { yaw: number; pitch: number; crash: boolean } {
    // the burns to fly the horizon with: as reported, ending as early as a burn can, running as long as one can
    const burns: number[] = [Math.min(FOLLOW_HORIZON, b.boostTicks)];
    if (b.boostTicks > 0 || this.sinceFire < BURN.max) {
      const early = b.boostTicks > 0 ? Math.max(0, Math.min(FOLLOW_HORIZON, BURN.min - this.sinceFire)) : 0;
      const late = b.boostTicks > 0 ? Math.max(0, Math.min(FOLLOW_HORIZON, BURN.max - this.sinceFire)) : 0;
      for (const n of [early, late]) if (!burns.includes(n)) burns.push(n);
    }
    // (one tick's cells are asked for many times over: remembered for the tick, in coordinates from the body's column so
    // that a cell's key is a small number)
    const ox = Math.floor(b.pos.x);
    const oz = Math.floor(b.pos.z);
    const memo = new Map<number, boolean>();
    const grid: RouteGrid = {
      solid: (x, y, z) => {
        const k = (x + 1024) * 4_194_304 + (y + 512) * 2048 + (z + 1024);
        let s = memo.get(k);
        if (s === undefined) {
          s = this.grid.solid(x + ox, y, z + oz);
          memo.set(k, s);
        }
        return s;
      },
    };
    // (a body already within the berth of a solid, standing beside a block at the takeoff, keeps half of what it has: the
    // search does the same for its first edges, search.ts startMarginFor)
    const here = boxClear(grid, { x: b.pos.x - ox, y: b.pos.y, z: b.pos.z - oz }, 0).clearance;
    const margin = here < this.margin ? Math.max(0, here * 0.5) : this.margin;
    let best: { yaw: number; pitch: number; cost: number; hit: boolean; crash: boolean } | undefined;
    let aimHit = false;
    const stop = this.entry?.touchdown;
    for (const dp of PITCHES) {
      for (const dyaw of YAWS) {
        const cy = yaw + dyaw;
        const cp = Math.max(-80, Math.min(60, pitch + dp));
        let cost = (Math.abs(dyaw) + Math.abs(dp)) * OFFSET;
        let hit = false;
        let crash = false;
        for (let h = 0; h < burns.length && !crash; h++) {
          let p = { x: b.pos.x - ox, y: b.pos.y, z: b.pos.z - oz };
          let v = b.vel;
          let at = this.at;
          // (the berth first; once it is broken the glide is flown on with the bare box, to tell a graze from a crash)
          let berth = margin;
          let off = 0;
          for (let k = 1; k <= FOLLOW_HORIZON; k++) {
            // Track F9c: a way in ends in a brake over its touchdown: the glide is checked up to where that brake has begun
            // (what lies beyond the touchdown is not flown into), and the ticks left count as flown where it began
            if (stop && Math.hypot(p.x + ox - stop.x, p.z + oz - stop.z) <= this.entry.reach(Math.hypot(v.x, v.z))) {
              if (h === 0) cost += off * (FOLLOW_HORIZON - k + 2);
              break;
            }
            v = glideVelocity(v, cy, cp, k <= burns[h]!);
            const q = { x: p.x + v.x, y: p.y + v.y, z: p.z + v.z };
            let sw = sweep(grid, p, q, berth);
            if (sw.hit && berth > BARE) {
              cost += HIT * (FOLLOW_HORIZON - k + 1);
              hit = true;
              berth = BARE;
              sw = sweep(grid, p, q, berth);
            }
            if (sw.hit) {
              cost += CRASH * (FOLLOW_HORIZON - k + 1);
              crash = true;
              break;
            }
            if (!hit) cost += (1 - sw.clearance) * CLOSE;
            p = q;
            if (h === 0) {
              // the distance to the line, on the burn as reported (the last tick counts double: where the glide ends up)
              const n = guideNearest(this.g, { x: q.x + ox, y: q.y, z: q.z + oz }, at, 2 * FOLLOW_AIM_MAX);
              at = n.at;
              off = n.dist;
              cost += n.dist * (k === FOLLOW_HORIZON ? 2 : 1);
            }
          }
        }
        if (dp === 0 && dyaw === 0) aimHit = hit;
        if (!best || cost < best.cost) best = { yaw: cy, pitch: cp, cost, hit, crash };
      }
    }
    if (best!.hit) this.stats.blocked++;
    else if (aimHit) this.stats.steered++;
    return { yaw: best!.yaw, pitch: best!.pitch, crash: best!.crash };
  }
}
