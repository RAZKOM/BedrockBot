// Track F9c (docs/flight.md "Learned entries (Track F9c)"; decisions/0080-learned-entries.md): a recorded flight as the
// way INTO a place under a roof. Where Track F9b's exit begins standing and ends in a climb, the entry begins in the air
// out of a cruise and ends standing:
//
//   - the LINE (`entryLine`): the recorded way in (learn/match.ts matchEntries: a flight that came from under open sky
//     and stood again by the goal) from its hand-over WINDOW to the touchdown, with a straight LEAD-IN in the open air
//     before it. The window is the stretch of open air where the recording itself was a glide and that ends well before
//     the roof: a body is taken onto the line there or not at all. The lead-in is the window's own heading and slope
//     drawn backwards: the line a cruise can come onto;
//   - the FLIER (`EntryFlier`): the guide follower along the line (learn/follow.ts in its entry mode: no jump, no
//     rocket, never faster than the recording), then the touchdown: the brake landing's station keeping over the
//     touchdown cell (brake.ts keepLook: the look turned back while the body is fast, the creep onto the point, the
//     sink onto the floor). The same code in the proof and in the flight;
//   - the HAND-OVER: the brain gives the body to the flier on the lead-in (`entryJoin`: near the line, heading along
//     it; open air, nothing proven yet). In the window the flier COMMITS when the body is inside the proof's box
//     (`entryCatch`, `ENTRY_BOX`) and the proof stands (`confirmed`); a body that leaves the window uncommitted has
//     missed (`missed`): the brain goes round or falls back, and nothing dives at the mouth;
//   - the PROOF (`proveEntry`): the whole entry simulated from the hand-over to standing, not from one state but from
//     the corners of what the hand-over allows (beside the line, over and under it, slower and faster than the
//     recording, the heading off the line's, early and late in the window). It clears only when every one of them
//     meets no solid and no water and stands within ENTRY_TOUCH of the touchdown at a speed that costs no health.
//     `room` is the least distance any of those flights kept from a solid: several takes are several candidates and
//     the one with the most room is flown;
//   - the proof's WORLD (`entryWorld`): every cell it asks is remembered, so a proof made on the world cache before the
//     goal's chunks arrive is confirmed later by asking the live model the same cells (`entryWorldSame`): the same
//     answers are the same flights.
//
// Losing the line under the roof is the follower's business as on the way out (it brakes and says `lost`; the brain
// lands): nothing here goes on as an unproven glide.
import type { Vec3 } from '../../../connection/types.ts';
import { glideVelocity, liquidContact, stepBody } from '../../input/physics.ts';
import { IDLE_COMMAND, initialBody, type BlockQuery, type BodyState, type MoveCommand } from '../../input/types.ts';
import { BRAKE_FAST, keepLook } from '../brake.ts';
import { holdPitch } from '../maneuvers.ts';
import type { LandingTarget } from '../plan.ts';
import { boxClear, sweep, type RouteGrid } from '../route/grid.ts';
import { FOLLOW_MARGIN, GuideFollower, type FollowBody } from './follow.ts';
import { guideHead, guideLength, guideNearest, guidePoint, guideTail, type Guide } from './guide.ts';
import type { GuideMatch } from './match.ts';

/** The hand-over window ends this far before the line's last open sky (blocks along it): a body off the line comes onto it in the open, not in the mouth. */
export const ENTRY_WINDOW_END = 20;
/** ... and is at most this long. */
export const ENTRY_WINDOW = 24;
/** The window begins where the recording itself flew at least this fast (blocks a tick): the recorder's own takeoff, a jump off a hill, is no place to join. */
export const ENTRY_WINDOW_SPEED = 0.9;
/** The lead-in: this many blocks of straight line before the window, along the window's first ENTRY_LEAD_FIT blocks, descending between these slopes (degrees), every point of it ENTRY_LEAD_ROOM clear of a solid (else it begins later). */
export const ENTRY_LEAD_IN = 40;
export const ENTRY_LEAD_FIT = 8;
export const ENTRY_LEAD_SLOPE = Object.freeze({ min: 6, max: 20 });
export const ENTRY_LEAD_ROOM = 1;
/**
 * What the hand-over allows, and so what the proof flies: the body up to `side` beside the line, `over` above and `under`
 * below it, at `slow` to `fast` times the recording's speed there (and within the absolute bounds), its heading up to
 * `heading` degrees off the line's.
 */
export const ENTRY_BOX = Object.freeze({ side: 3, over: 5, under: 2, slow: 0.5, fast: 1.25, heading: 25, speedMin: 0.8, speedMax: 2.0 });
export type EntryBox = typeof ENTRY_BOX;
/**
 * Where the brain gives the body to the flier on the lead-in (open air): this near the line, this slow at least, heading
 * within this of the line's, this far before the window's end at the latest. Over the line it may be `over` plus `dive`
 * for every block of line still left to the window's end: a cruise crosses the ground before the line with its terrain
 * clearance and comes down onto the line from above, and the follower closes about that much a block (it dives 30
 * degrees steeper than a line that itself descends 10 to 15).
 */
export const ENTRY_JOIN = Object.freeze({ side: 8, over: 4, dive: 0.35, under: 3, heading: 45, speedMin: 0.45, before: 6 });
/** The follower gives the line up this far off it while the body is still in the open before the window's end (FOLLOW_LOST under the roof). */
export const ENTRY_JOIN_LOST = 28;
/** A proven entry stands within this of the touchdown (blocks), and comes down no faster than this (blocks a tick: under the glide's fall reset, no fall is counted). */
export const ENTRY_TOUCH = 2;
/** Round 2: and within this of the goal itself (blocks beside it, and over or under it), whichever cell the touchdown is. */
export const ENTRY_GOAL = 2;
export const ENTRY_TOUCH_VY = 0.45;
export const ENTRY_TOUCH_H = 0.6;
/** The touchdown's station keeping begins where its brake stops the body within this of the touchdown (blocks), rolled out at most this many ticks. */
export const ENTRY_KEEP_NEAR = 0.75;
export const ENTRY_BRAKE_TICKS = 24;
/** ... its box kept this far from a solid in that roll-out (blocks). */
export const ENTRY_BRAKE_BERTH = 0.1;
/** The speed governor's floor (blocks a tick): the recording's last blocks are a stall onto the floor; the body keeps this much for the touchdown's brake to take. */
export const ENTRY_SPEED_FLOOR = 0.7;
/** The follower's checked glide ends where that brake has begun at the latest: this far from the touchdown a block a tick of speed (the brake's reach: 3.5 blocks at 1.05 a tick, brake.ts), and ENTRY_KEEP_NEAR. */
export const ENTRY_KEEP_REACH = 3.6;
/** ... and only on the line's last blocks. */
export const ENTRY_KEEP_LAST = 14;
/** The touchdown's brake holds the height the body has when it begins, between this far over the touchdown's floor and ENTRY_KEEP_TOP over it; a body ENTRY_STEP under that floor beside it sinks where it is. */
export const ENTRY_KEEP_OVER = 0.75;
export const ENTRY_KEEP_TOP = 3;
export const ENTRY_STEP = 0.15;
/** The elevator's pitch once the brake is done (0 sinks 0.149 a tick). */
export const ENTRY_SINK_PITCH = 0;
/** A wall or a ceiling met in the air that takes less than this off the body's speed (blocks a tick) is a touch, not a hit: flying into a wall costs health from a loss of 0.3 a tick, and this is half of it. */
export const ENTRY_BUMP = 0.15;
/** An entry's simulation gives up after this many ticks (the owner's take 4.3 to 5.3 s under the roof). */
export const ENTRY_MAX_TICKS = 400;

/** The height the touchdown's brake holds for a body that begins it at `y`. */
function holdOver(td: Vec3, y: number): number {
  return Math.max(td.y + ENTRY_KEEP_OVER, Math.min(td.y + ENTRY_KEEP_TOP, y));
}

/** The line of a learned entry and where a body may be taken onto it. */
export interface EntryLine {
  /** The lead-in, then the recorded way in from the hand-over window to where it comes nearest the touchdown. */
  guide: Guide;
  /** Blocks of lead-in before the recorded line (0: none had room). */
  lead: number;
  /** Blocks along `guide` to its last point under open sky. */
  open: number;
  /** The hand-over window (blocks along `guide`). */
  from: number;
  to: number;
  /** The touchdown the flier stops over and sinks onto (feet: the goal's own cell, or where the recording stood), where the recording stood, and how far that lies from the goal asked about. */
  touchdown: Vec3;
  recorded: Vec3;
  off: number;
  /** The goal asked about (feet, its cell's centre) when the touchdown is another cell beside it (Track F9c round 2): a proof's flights must also stand within ENTRY_GOAL of it. */
  goal?: Vec3;
}

/** The recorded speed (blocks a tick) at `at` blocks along a guide: over the three blocks either side. */
export function guideSpeed(g: Pick<Guide, 'points' | 'ticks'>, at: number): number {
  const n = g.points.length;
  const i = Math.max(0, Math.min(n - 1, Math.round(at)));
  const a = Math.max(0, i - 3);
  const b = Math.min(n - 1, i + 3);
  const dt = g.ticks[b]! - g.ticks[a]!;
  if (b <= a || dt <= 0) return 0;
  let d = 0;
  for (let k = a; k < b; k++) d += dist(g.points[k]!, g.points[k + 1]!);
  return d / dt;
}

/**
 * A matched way in (matchEntries with `before` long enough to hold its open part) as an entry line, or why it is none.
 * The window is the last ENTRY_WINDOW blocks of open air that end ENTRY_WINDOW_END before the roof and were flown at
 * ENTRY_WINDOW_SPEED or more. `goal`: the touchdown is that point (the goal's own cell: the recording stood again within
 * the match's reach of it) instead of where the recording stood. `grid`: the lead-in is drawn only through free air.
 */
export function entryLine(m: GuideMatch, o: { goal?: Vec3; touchdown?: Vec3; grid?: RouteGrid } = {}): EntryLine | string {
  const g = m.guide;
  const n = g.points.length;
  const to = Math.floor(m.open - ENTRY_WINDOW_END);
  if (to < 2) return `only ${m.open.toFixed(0)} blocks of it under open sky`;
  let from = to;
  while (from > 0 && to - (from - 1) <= ENTRY_WINDOW && guideSpeed(g, from - 1) >= ENTRY_WINDOW_SPEED) from--;
  if (to - from < 4) return `no 4 blocks of glide in the open before its roof (the recording is at ${guideSpeed(g, to).toFixed(2)} a tick ${ENTRY_WINDOW_END} before it)`;
  // the touchdown: the goal's own cell when the caller gives it, else where the recording stood. The line ends where it
  // comes nearest that point on its last blocks: what a recording does after it is its recorder's own landing (a stall
  // onto a ledge, a step down off it), not a line to fly
  const recorded = g.points[n - 1]!;
  // (round 2: or another standable cell beside the goal, `touchdown`: entryTouchdowns)
  const touchdown = o.touchdown ? { ...o.touchdown } : o.goal ? { ...o.goal } : { ...recorded };
  let end = n - 1;
  let best = Infinity;
  for (let i = Math.max(Math.ceil(m.open) + 1, n - 1 - ENTRY_KEEP_LAST); i < n; i++) {
    const d = Math.hypot(g.points[i]!.x - touchdown.x, g.points[i]!.z - touchdown.z);
    if (d < best - 1e-9) {
      best = d;
      end = i;
    }
  }
  const tail = guideTail(guideHead(g, end + 1), from);
  // the lead-in: the window's first blocks drawn backwards as a straight descent, as far as the air is free
  const p0 = tail.points[0]!;
  const p1 = tail.points[Math.min(tail.points.length - 1, ENTRY_LEAD_FIT)]!;
  const hx = p1.x - p0.x;
  const hz = p1.z - p0.z;
  const h = Math.hypot(hx, hz);
  const lead: Vec3[] = [];
  const speed = Math.max(ENTRY_WINDOW_SPEED, guideSpeed(g, from));
  if (h > 1e-6) {
    const slope = Math.max(ENTRY_LEAD_SLOPE.min, Math.min(ENTRY_LEAD_SLOPE.max, (Math.atan2(p0.y - p1.y, h) * 180) / Math.PI));
    const c = Math.cos((slope * Math.PI) / 180);
    const s = Math.sin((slope * Math.PI) / 180);
    for (let k = 1; k <= ENTRY_LEAD_IN; k++) {
      const p = { x: p0.x - (hx / h) * c * k, y: p0.y + s * k, z: p0.z - (hz / h) * c * k };
      if (o.grid && boxClear(o.grid, p, 0).clearance < ENTRY_LEAD_ROOM) break;
      lead.unshift(p);
    }
  }
  const k = lead.length;
  // (a way in fires no rocket: one the recording fired before the window is its takeoff's)
  const guide: Guide = {
    ...tail,
    points: [...lead, ...tail.points],
    ticks: [...lead.map((_p, i) => i / speed), ...tail.ticks.map((t) => t + k / speed)],
    rockets: [],
    grounded: false,
    landed: true,
  };
  return { guide, lead: k, open: m.open - from + k, from: k, to: to - from + k, touchdown, recorded: { ...recorded }, off: m.off, ...(o.goal ? { goal: { ...o.goal } } : {}) };
}

export interface EntryOutput {
  control: { yaw: number; pitch: number };
  /**
   * `joining`: on the line, not committed yet (the lead-in, the window); `line`: committed, the follower flies the line;
   * `touchdown`: the station keeping over the touchdown; `landed`: the body stands; `missed`: the window was left
   * uncommitted, or the line was lost before it (`why`: go round); `lost`: the line is given up after the commit (`why`: land).
   */
  status: 'joining' | 'line' | 'touchdown' | 'landed' | 'missed' | 'lost';
  at: number;
  error: number;
  why?: string;
}

/** The flier of a learned entry: the follower along the line, the commit in the window, then the touchdown (see the file comment). */
export class EntryFlier {
  readonly follower: GuideFollower;
  private readonly line: EntryLine;
  private readonly grid: RouteGrid;
  private readonly box: EntryBox;
  private readonly note: ((msg: string) => void) | undefined;
  private readonly length: number;
  private keeping = false;
  private stay: { x: number; z: number } | undefined;
  private holdY: number | undefined;
  /** The proof stands (a proof made on the world cache waits for the live model to say the same). */
  confirmed = true;
  /** The body was inside the proof's box in the window: from here on the entry is the proven one. */
  committed = false;
  /** Ticks flown, of them since the commit and in the touchdown; the tick the body passed the line's last open sky. */
  ticks = 0;
  lineTicks = 0;
  keepTicks = 0;
  roofAt: number | undefined;
  /** Why and where the touchdown began (for the log). */
  began: string | undefined;
  /** The last look at the window: why the body was not taken (for the `missed` line). */
  private refused: string | undefined;

  /** `at`: the body's place on the line when the flier takes it (blocks along it); `committed`: the body is one of the proof's own states (the proof's flights). */
  constructor(o: { grid: RouteGrid; line: EntryLine; at?: number; committed?: boolean; box?: EntryBox; note?: (msg: string) => void }) {
    this.line = o.line;
    this.length = guideLength(o.line.guide);
    this.grid = o.grid;
    this.box = o.box ?? ENTRY_BOX;
    this.note = o.note;
    this.committed = o.committed === true;
    const g = o.line.guide;
    this.follower = new GuideFollower({
      grid: o.grid,
      guide: g,
      entry: { touchdown: o.line.touchdown, reach: (h) => ENTRY_KEEP_NEAR + ENTRY_KEEP_REACH * h, speed: (at) => Math.max(ENTRY_SPEED_FLOOR, guideSpeed(g, at)), join: { until: o.line.to, lost: ENTRY_JOIN_LOST }, ...(o.at !== undefined ? { at: o.at } : {}) },
      ...(o.note ? { note: o.note } : {}),
    });
  }

  tick(b: FollowBody, look: { yaw: number }, tick: number): EntryOutput {
    this.ticks++;
    const td = this.line.touchdown;
    if (!b.gliding && b.onGround) return { control: { yaw: look.yaw, pitch: 0 }, status: 'landed', at: this.follower.place, error: 0 };
    if (!this.keeping) {
      const out = this.follower.tick(b, tick);
      if (this.roofAt === undefined && out.at >= this.line.open) this.roofAt = this.ticks;
      if (!this.committed) {
        // before the commit: the lead-in and the window, in the open. Inside the proof's box in the window with the proof
        // standing: committed. Past the window without it, or the line lost out here: missed
        if (out.status === 'lost') return { control: out.control, status: 'missed', at: out.at, error: out.error, why: out.why ?? 'the line lost before the window' };
        if (out.at >= this.line.from - 0.5) {
          const c = entryCatch(this.line, b, this.box);
          if (c.ok && this.confirmed) {
            this.committed = true;
            this.note?.(`learned entry: on the line ${this.line.guide.path} ${(this.line.open - c.at).toFixed(0)} blocks before its roof (${Math.abs(c.side).toFixed(1)} beside it, ${Math.abs(c.up).toFixed(1)} ${c.up >= 0 ? 'over' : 'under'} it, ${c.speed.toFixed(2)} a tick where the recording had ${c.recorded.toFixed(2)}, the heading ${c.heading.toFixed(0)} degrees off its own): inside what the proof flew, the follower has it to the touchdown`);
          } else {
            if (out.at <= this.line.to + 0.5 || this.refused === undefined) this.refused = c.ok ? 'the proof is not confirmed on the live world yet' : c.why;
            if (out.at > this.line.to + 0.5) return { control: { yaw: out.control.yaw, pitch: out.control.pitch }, status: 'missed', at: out.at, error: out.error, why: this.refused ?? 'past the window' };
          }
        }
        if (!this.committed) return { control: { yaw: out.control.yaw, pitch: out.control.pitch }, status: 'joining', at: out.at, error: out.error };
      }
      this.lineTicks++;
      const last = out.at >= this.length - ENTRY_KEEP_LAST;
      if (out.status === 'lost') return { control: out.control, status: 'lost', at: out.at, error: out.error, ...(out.why !== undefined ? { why: out.why } : {}) };
      // the touchdown: on the line's last blocks, as late as the brake still stops the body over the touchdown (`brakeDue`);
      // at the line's end; or where the glide ahead ends in a solid short of that (the floor's step under a body too slow
      // for it: it stops and sinks here). Before the last blocks a look that ends in a solid is the follower's own
      // business: it brakes and gives the line up
      const due = out.status === 'done' ? "the line's end" : !last ? undefined : out.crash === true ? 'a solid ahead' : this.brakeDue(b, look.yaw, out.control);
      if (due === undefined) return { control: { yaw: out.control.yaw, pitch: out.control.pitch }, status: 'line', at: out.at, error: out.error };
      this.keeping = true;
      this.began = `${due}, ${Math.hypot(td.x - b.pos.x, td.z - b.pos.z).toFixed(1)} from the touchdown and ${(b.pos.y - td.y).toFixed(1)} over it at ${Math.hypot(b.vel.x, b.vel.z).toFixed(2)} a tick`;
      this.note?.(`learned entry: the touchdown begins (${this.began}), ${this.lineTicks} ticks after the commit`);
    }
    this.keepTicks++;
    // the station keeping over the touchdown (brake.ts keepLook: the look back while fast, the creep onto the point, the
    // sink), the brake's pitch holding the height the body came with. A body that has come down under the touchdown's floor
    // beside it (the floor steps up to it and the body was too slow for the step) stops and sinks where it is: creeping on
    // would be creeping into the step.
    this.holdY ??= holdOver(td, b.pos.y);
    if (this.stay === undefined && b.pos.y < td.y - ENTRY_STEP && Math.hypot(td.x - b.pos.x, td.z - b.pos.z) > 0.4) this.stay = { x: b.pos.x, z: b.pos.z };
    const k = keepLook({ pos: b.pos, vel: b.vel, yaw: look.yaw }, this.stay ?? td, holdPitch(b.pos.y, this.holdY), ENTRY_SINK_PITCH);
    return { control: k, status: 'touchdown', at: this.follower.place, error: Math.hypot(td.x - b.pos.x, td.y - b.pos.y, td.z - b.pos.z) };
  }

  /**
   * The touchdown's brake is due (why), or not yet: begun this tick it stops the body within ENTRY_KEEP_NEAR of the
   * touchdown or past it; or begun a tick later (after one more tick of the follower's look) it would meet a solid where
   * it meets none begun now.
   */
  private brakeDue(b: FollowBody, yaw: number, next: { yaw: number; pitch: number }): string | undefined {
    const td = this.line.touchdown;
    const d = Math.hypot(td.x - b.pos.x, td.z - b.pos.z);
    if (d <= ENTRY_KEEP_NEAR) return 'over it';
    const now = this.brakeRoll(b.pos, b.vel, yaw);
    if (now.travel >= d - ENTRY_KEEP_NEAR) return "the brake's reach";
    if (now.hit) return undefined;
    const v = glideVelocity(b.vel, next.yaw, next.pitch, false);
    return this.brakeRoll({ x: b.pos.x + v.x, y: b.pos.y + v.y, z: b.pos.z + v.z }, v, next.yaw).hit ? 'a tick later the brake would meet a solid' : undefined;
  }

  /** The touchdown's brake rolled out from a state on the glide formula (the station keeping's own law) until the body is slow: how far it goes along the ground, and whether its box meets a solid on the way. */
  private brakeRoll(from: Vec3, v0: Vec3, yaw: number): { travel: number; hit: boolean } {
    const td = this.line.touchdown;
    let pos = from;
    let vel = v0;
    let look = yaw;
    let hit = false;
    const holdY = holdOver(td, from.y);
    for (let t = 0; t < ENTRY_BRAKE_TICKS && Math.hypot(vel.x, vel.z) > BRAKE_FAST; t++) {
      const k = keepLook({ pos, vel, yaw: look }, td, holdPitch(pos.y, holdY), ENTRY_SINK_PITCH);
      look = k.yaw;
      vel = glideVelocity(vel, k.yaw, k.pitch, false);
      const q = { x: pos.x + vel.x, y: pos.y + vel.y, z: pos.z + vel.z };
      if (!hit && sweep(this.grid, pos, q, ENTRY_BRAKE_BERTH).hit) hit = true;
      pos = q;
    }
    return { travel: Math.hypot(pos.x - from.x, pos.z - from.z), hit };
  }
}

/** A body in the air. */
export interface EntryState {
  pos: Vec3;
  vel: Vec3;
}

/** The state `at` blocks along a line, moved off it and with another speed and heading than the recording's (the proof's corners, the probe's sweeps). */
export function entryState(line: EntryLine, at: number, o: { side?: number; up?: number; speed?: number; factor?: number; heading?: number } = {}): EntryState {
  const g = line.guide;
  const { pos, dir } = guidePoint(g, at);
  const h = Math.hypot(dir.x, dir.z) || 1;
  // (to the right of the line's heading is +side)
  const right = { x: -dir.z / h, z: dir.x / h };
  const speed = o.speed ?? guideSpeed(g, at) * (o.factor ?? 1);
  const turn = ((o.heading ?? 0) * Math.PI) / 180;
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  return {
    pos: { x: pos.x + right.x * (o.side ?? 0), y: pos.y + (o.up ?? 0), z: pos.z + right.z * (o.side ?? 0) },
    vel: { x: (dir.x * c - dir.z * s) * speed, y: dir.y * speed, z: (dir.x * s + dir.z * c) * speed },
  };
}

/** A body against the line between two places on it: the nearest place, the offsets (to the right of the line, over it), the speed against the recording's there, the heading against the line's. */
export function entryPlace(line: EntryLine, b: EntryState, from = 0, to = line.to + 2 * ENTRY_WINDOW): { at: number; side: number; up: number; speed: number; recorded: number; heading: number } {
  const g = line.guide;
  const n = guideNearest(g, b.pos, from, to - from);
  const { pos, dir } = guidePoint(g, n.at);
  const h = Math.hypot(dir.x, dir.z) || 1;
  const bh = Math.hypot(b.vel.x, b.vel.z);
  return {
    at: n.at,
    side: ((b.pos.x - pos.x) * -dir.z + (b.pos.z - pos.z) * dir.x) / h,
    up: b.pos.y - pos.y,
    speed: Math.hypot(b.vel.x, b.vel.y, b.vel.z),
    recorded: guideSpeed(g, n.at),
    heading: bh > 0.05 ? Math.abs((Math.atan2(b.vel.x * dir.z - b.vel.z * dir.x, b.vel.x * dir.x + b.vel.z * dir.z) * 180) / Math.PI) : 180,
  };
}

/** The commit's test: the body is in the hand-over window and inside the proof's box; `why` when it is not. */
export function entryCatch(line: EntryLine, b: EntryState, box: EntryBox = ENTRY_BOX): ReturnType<typeof entryPlace> & { ok: boolean; why?: string } {
  const p = entryPlace(line, b);
  let why: string | undefined;
  if (p.at < line.from - 0.5) why = `before the window (${(line.from - p.at).toFixed(0)} blocks)`;
  else if (p.at > line.to + 0.5) why = `past the window (${(p.at - line.to).toFixed(0)} blocks)`;
  else if (Math.abs(p.side) > box.side) why = `${Math.abs(p.side).toFixed(1)} beside the line`;
  else if (p.up > box.over) why = `${p.up.toFixed(1)} over the line`;
  else if (p.up < -box.under) why = `${(-p.up).toFixed(1)} under the line`;
  else if (p.speed < Math.max(box.speedMin, p.recorded * box.slow)) why = `${p.speed.toFixed(2)} a tick, too slow (the recording ${p.recorded.toFixed(2)})`;
  else if (p.speed > Math.min(box.speedMax, p.recorded * box.fast)) why = `${p.speed.toFixed(2)} a tick, too fast (the recording ${p.recorded.toFixed(2)})`;
  else if (p.heading > box.heading) why = `the heading ${p.heading.toFixed(0)} degrees off the line's`;
  return { ...p, ok: why === undefined, ...(why !== undefined ? { why } : {}) };
}

/** The brain's test for giving the body to the flier: on the lead-in or the window (ENTRY_JOIN.before from its end at the latest), near the line and heading along it (ENTRY_JOIN); `past`: the body is beyond the window. */
export function entryJoin(line: EntryLine, b: EntryState): ReturnType<typeof entryPlace> & { ok: boolean; past: boolean } {
  const p = entryPlace(line, b, 0, line.to + ENTRY_WINDOW);
  const j = ENTRY_JOIN;
  const ok = p.at >= 0.5 && p.at <= line.to - j.before && Math.abs(p.side) <= j.side && p.up <= j.over + j.dive * (line.to - p.at) && p.up >= -j.under && p.heading <= j.heading && p.speed >= j.speedMin;
  return { ...p, ok, past: p.at > line.to - j.before };
}

export interface EntryFlight {
  /** The body stands (the simulation's end); the ticks to there, and from the line's last open sky. */
  landed: boolean;
  ticks: number;
  roofTicks: number | undefined;
  /** Collisions in the air that cost speed (a wall or a ceiling that took more than ENTRY_BUMP a tick off it), slower touches, and water or lava touched. */
  hits: number;
  bumps: number;
  wet: boolean;
  /** The line was given up (why). */
  lost?: string;
  end: Vec3;
  /** Where the body stands against the touchdown: blocks beside it and over it; and its distance from where the recording stood. */
  off: number;
  dy: number;
  offRecorded: number;
  /** Round 2: where it stands against the goal (the line's `goal`, else its touchdown): blocks beside it and over it. */
  offGoal: number;
  dyGoal: number;
  /** The speeds of the last tick in the air (blocks a tick). */
  touch: { vy: number; h: number };
  maxError: number;
  /** The least distance from the gliding box to a solid on the way (capped at 1), before the touchdown's station keeping. */
  room: number;
  keepTicks: number;
  /** The first hit: its tick, the blocks along the line, and where the body was against the goal (blocks east, up, south of the goal's feet: the offsets a refusal is read by). */
  firstHit?: { tick: number; at: number; from: Vec3 };
  /** Why and where the touchdown began; ticks the speed governor looked back. */
  began?: string;
  taps: number;
}

export interface EntryWorld {
  /** The world for stepBody. */
  world: BlockQuery;
  /** The follower's grid (unknown and liquid solid). */
  grid: RouteGrid;
}

/** One entry flown on stepBody from `s0` (a state of the hand-over window, taken as committed) to standing: the proof's unit and the probe's; the brain flies the same flier. */
export function flyEntry(w: EntryWorld, line: EntryLine, s0: EntryState, o: { maxTicks?: number; trace?: (t: number, body: BodyState, out: EntryOutput) => void } = {}): EntryFlight {
  const steps = entrySteps(w, line, s0, o);
  for (;;) {
    const s = steps.next();
    if (s.done) return s.value;
  }
}

/** The ticks an entry's simulation flies between two pauses (`entrySteps`): about a hundredth of a second of work. */
export const ENTRY_SLICE = 12;

/** `flyEntry` in slices: it yields every ENTRY_SLICE ticks, so a proof that runs while the bot flies gives the input loop its turn between them. */
export function* entrySteps(w: EntryWorld, line: EntryLine, s0: EntryState, o: { maxTicks?: number; trace?: (t: number, body: BodyState, out: EntryOutput) => void } = {}): Generator<undefined, EntryFlight, undefined> {
  const flier = new EntryFlier({ grid: w.grid, line, at: entryPlace(line, s0).at, committed: true });
  let body: BodyState = { ...initialBody(s0.pos, false), vel: { ...s0.vel }, gliding: true, boostTicks: 0 };
  let cmd: MoveCommand = { ...IDLE_COMMAND, yaw: (Math.atan2(-s0.vel.x, s0.vel.z) * 180) / Math.PI, glide: true };
  const r: EntryFlight = { landed: false, ticks: 0, roofTicks: undefined, hits: 0, bumps: 0, wet: false, end: body.pos, off: Infinity, dy: 0, offRecorded: Infinity, offGoal: Infinity, dyGoal: 0, taps: 0, touch: { vy: 0, h: 0 }, maxError: 0, room: 1, keepTicks: 0 };
  const max = o.maxTicks ?? ENTRY_MAX_TICKS;
  const goal = line.goal ?? line.touchdown;
  let lastAir = { vy: s0.vel.y, h: Math.hypot(s0.vel.x, s0.vel.z) };
  for (let t = 1; t <= max; t++) {
    if (t % ENTRY_SLICE === 0) yield undefined;
    const out = flier.tick({ pos: body.pos, vel: body.vel, gliding: body.gliding === true, onGround: body.onGround, boostTicks: 0, rockets: 0 }, { yaw: cmd.yaw }, t);
    o.trace?.(t, body, out);
    r.ticks = t;
    if (out.status === 'landed') {
      r.landed = true;
      break;
    }
    if (out.status === 'lost' || out.status === 'missed') {
      r.lost = out.why ?? out.status;
      break;
    }
    if (out.status === 'line') {
      if (out.error > r.maxError) r.maxError = out.error;
      r.room = Math.min(r.room, boxClear(w.grid, body.pos, 0).clearance);
    }
    cmd = { ...cmd, yaw: out.control.yaw, pitch: out.control.pitch, glide: true };
    const before = body;
    const s = stepBody(body, cmd, w.world);
    if (!s.simulated) {
      r.lost = 'the world is not known here';
      break;
    }
    body = s.state;
    if (before.gliding) lastAir = { vy: body.onGround ? before.vel.y : body.vel.y, h: Math.hypot(before.vel.x, before.vel.z) };
    // a collision in the air (glide.ts simulateFlight's rule): a wall met, or a ceiling. One that costs less than ENTRY_BUMP
    // of speed is a touch (the touchdown's creep brushing the wall beside its cell): counted apart, it costs no health
    if (before.gliding && body.pos.y > Math.floor(body.pos.y) + 0.05 && (body.collidedHorizontally || (body.collidedVertically && !body.onGround))) {
      if (Math.hypot(before.vel.x, before.vel.y, before.vel.z) - Math.hypot(body.vel.x, body.vel.y, body.vel.z) > ENTRY_BUMP) {
        r.hits++;
        r.firstHit ??= { tick: t, at: out.at, from: { x: body.pos.x - goal.x, y: body.pos.y - goal.y, z: body.pos.z - goal.z } };
      } else r.bumps++;
    }
    if (body.inWater || body.inLava || liquidContact(w.world, body.pos).water || liquidContact(w.world, body.pos).lava) r.wet = true;
  }
  const td = line.touchdown;
  r.end = { ...body.pos };
  r.off = Math.hypot(body.pos.x - td.x, body.pos.z - td.z);
  r.dy = body.pos.y - td.y;
  r.offRecorded = dist(body.pos, line.recorded);
  r.offGoal = Math.hypot(body.pos.x - goal.x, body.pos.z - goal.z);
  r.dyGoal = body.pos.y - goal.y;
  r.touch = lastAir;
  r.keepTicks = flier.keepTicks;
  r.taps = flier.follower.stats.taps;
  if (flier.began !== undefined) r.began = flier.began;
  r.roofTicks = flier.roofAt !== undefined ? r.ticks - flier.roofAt : undefined;
  return r;
}

/** Offsets from the goal for a log line: blocks east, up and south of its feet (x y z), a decimal each. */
export function offsets(p: Vec3): string {
  return `${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}`;
}

/** Why a flown entry is no proof (undefined: it is one). */
export function entryVerdict(f: EntryFlight): string | undefined {
  if (f.hits) return `hits a solid ${f.hits} time${f.hits === 1 ? '' : 's'}${f.firstHit ? ` (the first at tick ${f.firstHit.tick}, ${f.firstHit.at.toFixed(0)} blocks along the line, ${offsets(f.firstHit.from)} from the goal)` : ''}`;
  if (f.wet) return 'ends in water';
  if (f.lost !== undefined) return `loses the line (${f.lost})`;
  if (!f.landed) return `still in the air after ${f.ticks} ticks`;
  if (f.off > ENTRY_TOUCH || Math.abs(f.dy) > ENTRY_TOUCH) return `stands ${f.off.toFixed(1)} from the touchdown${Math.abs(f.dy) > ENTRY_TOUCH ? ` and ${Math.abs(f.dy).toFixed(1)} ${f.dy > 0 ? 'over' : 'under'} it` : ''}`;
  if (f.offGoal > ENTRY_GOAL || Math.abs(f.dyGoal) > ENTRY_GOAL) return `stands ${f.offGoal.toFixed(1)} from the goal${Math.abs(f.dyGoal) > ENTRY_GOAL ? ` and ${Math.abs(f.dyGoal).toFixed(1)} ${f.dyGoal > 0 ? 'over' : 'under'} it` : ''}`;
  if (f.touch.vy < -ENTRY_TOUCH_VY) return `comes down at ${(-f.touch.vy).toFixed(2)} a tick`;
  if (f.touch.h > ENTRY_TOUCH_H) return `touches down at ${f.touch.h.toFixed(2)} a tick along the ground`;
  return undefined;
}

/** One corner of the proof: where on the window, and how far off the recording's state. */
export interface EntryCase {
  name: string;
  at: number;
  side: number;
  up: number;
  factor: number;
  heading: number;
}

/**
 * The entry states a proof flies: the recording's own state at the window's middle, its start and its end; then at each of
 * those every single extreme of the box (beside, over, under, slow, fast, the heading either way), and the corners that
 * stack them (high and fast, low and slow, each on either side with the heading turned in).
 */
export function entryCases(line: EntryLine, box: EntryBox = ENTRY_BOX): EntryCase[] {
  const out: EntryCase[] = [];
  const places: [string, number][] = [
    ['mid', (line.from + line.to) / 2],
    ['early', line.from],
    ['late', line.to],
  ];
  const adder = (where: string, at: number) => (name: string, c: Partial<EntryCase>): void => {
    out.push({ name: `${where} ${name}`, at, side: 0, up: 0, factor: 1, heading: 0, ...c });
  };
  // the recording's own three states first (a take that does not fly from those is refused for three simulations), then
  // the corners that stack the extremes (where a line that does not hold fails soonest), then each single extreme
  for (const [where, at] of places) adder(where, at)('on the line', {});
  for (const [where, at] of places) {
    const add = adder(where, at);
    for (const side of [box.side, -box.side]) {
      add(`over, fast, ${side > 0 ? 'right' : 'left'}`, { side, up: box.over, factor: box.fast, heading: side > 0 ? -box.heading : box.heading });
      add(`under, slow, ${side > 0 ? 'right' : 'left'}`, { side, up: -box.under, factor: box.slow, heading: side > 0 ? box.heading : -box.heading });
    }
  }
  for (const [where, at] of places) {
    const add = adder(where, at);
    add('right', { side: box.side });
    add('left', { side: -box.side });
    add('over', { up: box.over });
    add('under', { up: -box.under });
    add('slow', { factor: box.slow });
    add('fast', { factor: box.fast });
    add('heading right', { heading: box.heading });
    add('heading left', { heading: -box.heading });
  }
  return out;
}

/** The speed a case is flown at: the recording's at its place times the case's factor, within the box's absolute bounds. */
export function caseSpeed(line: EntryLine, c: EntryCase, box: EntryBox = ENTRY_BOX): number {
  return Math.max(box.speedMin, Math.min(box.speedMax, guideSpeed(line.guide, c.at) * c.factor));
}

export interface EntryProof {
  ok: boolean;
  /** What the proof flew and said (for the decision's line). */
  line: string;
  sims: number;
  /** The least room any of the flights kept under way (blocks, capped at 1), the longest from the last open sky to standing (ticks), the farthest from the touchdown. */
  room: number;
  roofTicks: number;
  off: number;
  /** Round 2: the farthest any flight stood from the goal (blocks beside it). */
  far: number;
}

/**
 * The proof of a learned entry: every case of `entryCases` flown from the hand-over to standing. A case whose start
 * already lies in a solid (the box reaches into the hillside there) is no state a body can be in and is left out, but
 * the recording's own states must all be flown. `yieldNow` is awaited between flights (the proof may run while the bot
 * flies).
 */
export async function proveEntry(w: EntryWorld, line: EntryLine, o: { box?: EntryBox; yieldNow?: () => Promise<void>; cases?: readonly EntryCase[] } = {}): Promise<EntryProof> {
  const box = o.box ?? ENTRY_BOX;
  const cases = o.cases ?? entryCases(line, box);
  let sims = 0;
  let room = 1;
  let roofTicks = 0;
  let off = 0;
  let far = 0;
  let skipped = 0;
  for (const c of cases) {
    const s0 = entryState(line, c.at, { side: c.side, up: c.up, speed: caseSpeed(line, c, box), heading: c.heading });
    if (boxClear(w.grid, s0.pos, FOLLOW_MARGIN).hit) {
      if (c.side === 0 && c.up === 0) return { ok: false, line: `the recorded line itself is within ${FOLLOW_MARGIN} of a block in its hand-over window (${c.name})`, sims, room: 0, roofTicks, off, far };
      skipped++;
      continue;
    }
    let f: EntryFlight;
    if (o.yieldNow) {
      const steps = entrySteps(w, line, s0);
      for (;;) {
        await o.yieldNow();
        const s = steps.next();
        if (s.done) {
          f = s.value;
          break;
        }
      }
    } else f = flyEntry(w, line, s0);
    sims++;
    const why = entryVerdict(f);
    if (why !== undefined) return { ok: false, line: `${why} from ${c.name} (${describeCase(c)})`, sims, room: Math.min(room, f.room), roofTicks, off, far };
    room = Math.min(room, f.room);
    roofTicks = Math.max(roofTicks, f.roofTicks ?? f.ticks);
    off = Math.max(off, f.off);
    far = Math.max(far, f.offGoal);
  }
  return {
    ok: true,
    line: `clear from ${sims} entry states (up to ${box.side} beside the line, ${box.over} over and ${box.under} under it, ${box.slow} to ${box.fast} of its speed, ${box.heading} degrees off its heading, early and late${skipped ? `; ${skipped} inside the ground left out` : ''}): standing at most ${off.toFixed(1)} from the touchdown${line.goal && (line.goal.x !== line.touchdown.x || line.goal.y !== line.touchdown.y || line.goal.z !== line.touchdown.z) ? ` and ${far.toFixed(1)} from the goal` : ''}, ${roofTicks} ticks at most from the last open sky, never nearer than ${room >= 1 ? '1 or more' : room.toFixed(2)} to a block`,
    sims,
    room,
    roofTicks,
    off,
    far,
  };
}

function describeCase(c: EntryCase): string {
  const parts: string[] = [];
  if (c.side) parts.push(`${Math.abs(c.side)} ${c.side > 0 ? 'right of' : 'left of'} the line`);
  if (c.up) parts.push(`${Math.abs(c.up)} ${c.up > 0 ? 'over' : 'under'} it`);
  if (c.factor !== 1) parts.push(`${c.factor} of its speed`);
  if (c.heading) parts.push(`${Math.abs(c.heading)} degrees ${c.heading > 0 ? 'right' : 'left'} of its heading`);
  return parts.length ? parts.join(', ') : "the recording's own state";
}

// ---- the hand-over ---------------------------------------------------------------------------------------------

/** The cruise is brought to this far before the window's end (blocks along the line's heading there): the brain's route hand-over distance (route/landing.ts ROUTE_HANDOVER), so the body comes onto the lead-in before the window. */
export const ENTRY_AIM_OUT = 44;
/** ... and no lower than this over the ground under the lead-in and this far beside it (blocks; the flight's own clearance when the caller gives it). */
export const ENTRY_AIM_CLEARANCE = 12;
export const ENTRY_AIM_BESIDE = 6;

/** What a flight carries to end along a learned entry (plan.ts `LandingTarget.entry`; the brain's `entry` phase flies it). */
export interface EntryHandoff {
  line: EntryLine;
  /** The goal the entry ends on: the flight's outcome is measured against it, not against the point in the air the cruise aims at. */
  goal: { x: number; z: number; top: number; half: number };
  /** The proof read cells the live model did not have yet (the world cache's): the flier commits only once `FlightBrain.confirmEntry(true)` says the live model answers the same. */
  unconfirmed?: boolean;
  /** Where the flight goes when the entry is given up (missed twice, or the proof does not stand on the live world): the landing as without a recording. */
  fallback?: LandingTarget;
}

/**
 * Where the cruise aims for an entry line, as the fields of a landing target with a corridor (plan.ts `bearing`): the
 * window's end, come to along the lead-in's heading, at the height the lead-in has ENTRY_AIM_OUT before it (the brain's
 * glide line is flat that near: `top` is that height less the approach's entry height, which the caller knows).
 */
export function entryAim(line: EntryLine, o: { top?: (x: number, z: number) => number | undefined; clearance?: number } = {}): { x: number; z: number; y: number; bearing: number } {
  const g = line.guide;
  const end = guidePoint(g, line.to).pos;
  const a = guidePoint(g, Math.max(0, line.from - 1));
  const h = Math.hypot(a.dir.x, a.dir.z) || 1;
  // the bearing from the aim outwards is against the line's heading in
  const bearing = (Math.atan2(a.dir.x, -a.dir.z) * 180) / Math.PI;
  // the lead-in's height that far out: on the line while it lasts, on along its slope beyond its start
  const out = Math.max(0, line.to - ENTRY_AIM_OUT);
  let y = guidePoint(g, out).pos.y + (line.to - ENTRY_AIM_OUT < 0 ? (ENTRY_AIM_OUT - line.to) * Math.max(0, -a.dir.y / h) : 0);
  // ... and no lower than the cruise may fly there: its clearance over the ground under the lead-in and beside it (`top`:
  // a column's highest block). A recorded way in begins on a height and runs down its flank: the cruise crosses that
  // height with its clearance and the flier takes the body down onto the line from above (ENTRY_JOIN)
  if (o.top) {
    const side = { x: -a.dir.z / h, z: a.dir.x / h };
    let ground = -Infinity;
    for (let i = 0; i <= Math.min(g.points.length - 1, Math.round(line.from)); i += 2) {
      for (const s of [-ENTRY_AIM_BESIDE, 0, ENTRY_AIM_BESIDE]) {
        const t = o.top(Math.floor(g.points[i]!.x + side.x * s), Math.floor(g.points[i]!.z + side.z * s));
        if (t !== undefined && t > ground) ground = t;
      }
    }
    if (ground > -Infinity) y = Math.max(y, ground + 1 + (o.clearance ?? ENTRY_AIM_CLEARANCE));
  }
  return { x: end.x, z: end.z, y, bearing };
}

// ---- the proof's world -----------------------------------------------------------------------------------------

/** A cell for an entry's proof: air, a solid (an unknown cell is one), water, lava. */
export const ENTRY_AIR = 0;
export const ENTRY_SOLID = 1;
export const ENTRY_WATER = 2;
export const ENTRY_LAVA = 3;
/** ... and, to `entryWorldSame` only, a cell the live model has not been sent. */
export const ENTRY_UNKNOWN = -1;
export type EntryCell = (x: number, y: number, z: number) => number;

const WATER_HEIGHT = 8 / 9;
/** The cells an entry's proof asked, by a key within ASKED_SPAN blocks of an origin (a cell beyond it is asked again every time and not remembered). */
export interface EntryAsked {
  origin: { x: number; z: number };
  cells: Map<number, number>;
}
const ASKED_SPAN = 2048;

/**
 * The world of an entry's proof over a cell function, every answer remembered (`asked`): the follower's grid has
 * everything but air as an obstacle, the body's physics the solids and the liquids. `origin`: a place near the line
 * (the touchdown).
 */
export function entryWorld(cell: EntryCell, origin: { x: number; z: number }): EntryWorld & { asked: EntryAsked } {
  const ox = Math.floor(origin.x) - ASKED_SPAN;
  const oz = Math.floor(origin.z) - ASKED_SPAN;
  const cells = new Map<number, number>();
  const asked: EntryAsked = { origin: { x: ox, z: oz }, cells };
  const at = (x: number, y: number, z: number): number => {
    const dx = x - ox;
    const dz = z - oz;
    const dy = y + 64;
    if (dx < 0 || dx >= 2 * ASKED_SPAN || dz < 0 || dz >= 2 * ASKED_SPAN || dy < 0 || dy > 511) return cell(x, y, z);
    const k = (dx * 2 * ASKED_SPAN + dz) * 512 + dy;
    let c = cells.get(k);
    if (c === undefined) {
      c = cell(x, y, z);
      cells.set(k, c);
    }
    return c;
  };
  return {
    asked,
    grid: { solid: (x, y, z) => at(x, y, z) !== ENTRY_AIR },
    world: {
      solidAt: (x, y, z) => at(x, y, z) === ENTRY_SOLID,
      liquidAt: (x, y, z) => {
        const c = at(x, y, z);
        return c === ENTRY_WATER ? { liquid: 'water', height: WATER_HEIGHT } : c === ENTRY_LAVA ? { liquid: 'lava', height: WATER_HEIGHT } : null;
      },
    },
  };
}

/**
 * Whether a proof still stands on another view of the world (the live model, once the goal's chunks have come): `same`
 * when `live` answers every cell the proof asked as the proof was answered (the same answers are the same flights);
 * `changed` with the first cell that differs; `unknown` while any of them is not known live (ENTRY_UNKNOWN).
 */
export function entryWorldSame(asked: EntryAsked, live: EntryCell): { same: 'same' | 'changed' | 'unknown'; cell?: Vec3; unknown: number } {
  let unknown = 0;
  for (const [k, was] of asked.cells) {
    const y = (k % 512) - 64;
    const r = Math.floor(k / 512);
    const z = (r % (2 * ASKED_SPAN)) + asked.origin.z;
    const x = Math.floor(r / (2 * ASKED_SPAN)) + asked.origin.x;
    const now = live(x, y, z);
    if (now === ENTRY_UNKNOWN) unknown++;
    else if (now !== was) return { same: 'changed', cell: { x, y, z }, unknown };
  }
  return { same: unknown ? 'unknown' : 'same', unknown };
}

const dist = (a: Vec3, b: Vec3): number => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

// ---- the touchdown beside the goal (round 2) ---------------------------------------------------------------------

/**
 * Round 2 (docs/flight.md "Learned entries", "The cave changes"): the touchdown need not be the goal's own cell. A cave
 * changes between a recording and a flight (a block set beside the goal closed the last two blocks of both flyable takes
 * of the owner's cave): the standable cells within ENTRY_TOUCH_REACH of the goal (blocks beside it, cell to cell) and
 * ENTRY_TOUCH_LEVELS over or under its floor are tried in turn, and the proof decides. A take whose own three states do
 * not fly to ENTRY_TOUCH_SCREENS cells in a row is given up (the cells behind what closed the goal come first and all
 * fail: a simulation each); a take gets ENTRY_TOUCH_PROOFS whole proofs at the most.
 */
export const ENTRY_TOUCH_REACH = 2;
export const ENTRY_TOUCH_LEVELS = 1;
export const ENTRY_TOUCH_SCREENS = 6;
export const ENTRY_TOUCH_PROOFS = 3;

/**
 * The cells a learned entry may touch down on for a goal (feet cells, whole numbers): the goal's own first, then the
 * standable ones round it (a solid under the feet, the feet and the head in air: an unknown or a liquid cell is neither)
 * by their distance beside the goal, the goal's own level before the level under it before the level over it.
 */
export function entryTouchdowns(cell: EntryCell, goal: Vec3): Vec3[] {
  const out: { c: Vec3; d: number; dy: number }[] = [];
  for (let dy = -ENTRY_TOUCH_LEVELS; dy <= ENTRY_TOUCH_LEVELS; dy++) {
    for (let dx = -ENTRY_TOUCH_REACH; dx <= ENTRY_TOUCH_REACH; dx++) {
      for (let dz = -ENTRY_TOUCH_REACH; dz <= ENTRY_TOUCH_REACH; dz++) {
        const d = Math.hypot(dx, dz);
        if (d > ENTRY_TOUCH_REACH || (dx === 0 && dy === 0 && dz === 0)) continue;
        const c = { x: goal.x + dx, y: goal.y + dy, z: goal.z + dz };
        if (cell(c.x, c.y - 1, c.z) === ENTRY_SOLID && cell(c.x, c.y, c.z) === ENTRY_AIR && cell(c.x, c.y + 1, c.z) === ENTRY_AIR) out.push({ c, d, dy });
      }
    }
  }
  out.sort((a, b) => a.d - b.d || Math.abs(a.dy) - Math.abs(b.dy) || a.dy - b.dy);
  return [{ ...goal }, ...out.map((o) => o.c)];
}

export interface EntryChoice {
  /** The line to the first cell whose proof cleared, its proof and that cell; none: the take is refused. */
  line?: EntryLine;
  proof?: EntryProof;
  cell?: Vec3;
  /** What was tried, cell by cell (offsets from the goal's cell), for the decision's line. */
  said: string;
  sims: number;
  /** Whole proofs flown (a take refused at its own states has none). */
  proofs: number;
}

/**
 * One recorded take against a goal: its line to each touchdown cell of `cells` in turn (entryTouchdowns), the
 * recording's own three states first (the proof's first three cases: three simulations refuse a cell), then the whole
 * proof; the first cell that clears is the take's. Every flight of a proof must stand within ENTRY_TOUCH of the touchdown
 * and within ENTRY_GOAL of the goal.
 */
export async function chooseTouchdown(w: EntryWorld, m: GuideMatch, goal: Vec3, cells: readonly Vec3[], o: { yieldNow?: () => Promise<void> } = {}): Promise<EntryChoice> {
  const centre = { x: goal.x + 0.5, y: goal.y, z: goal.z + 0.5 };
  const said: string[] = [];
  let sims = 0;
  let proofs = 0;
  let screens = 0;
  let more = 0;
  const done = (): string => `${said.join('; ')}${more ? `; its own state does not fly to ${more} more cell${more === 1 ? '' : 's'} beside the goal either` : ''}`;
  const run = o.yieldNow ? { yieldNow: o.yieldNow } : {};
  for (const c of cells) {
    if (proofs >= ENTRY_TOUCH_PROOFS || screens >= ENTRY_TOUCH_SCREENS) break;
    const own = c.x === goal.x && c.y === goal.y && c.z === goal.z;
    const line = entryLine(m, { goal: centre, ...(own ? {} : { touchdown: { x: c.x + 0.5, y: c.y, z: c.z + 0.5 } }), grid: w.grid });
    if (typeof line === 'string') return { said: `no line (${line})`, sims, proofs };
    const where = own ? "to the goal's cell" : `to the cell ${c.x - goal.x} ${c.y - goal.y} ${c.z - goal.z} from it (${Math.hypot(c.x - goal.x, c.z - goal.z).toFixed(1)} beside)`;
    const cases = entryCases(line);
    const screen = await proveEntry(w, line, { ...run, cases: cases.slice(0, 3) });
    sims += screen.sims;
    if (!screen.ok) {
      if (said.length) more++;
      else said.push(`${where}: ${screen.line}`);
      screens++;
      continue;
    }
    screens = 0;
    proofs++;
    const proof = await proveEntry(w, line, { ...run, cases });
    sims += proof.sims;
    said.push(`${where}: ${proof.line}`);
    if (proof.ok) return { line, proof, cell: { ...c }, said: done(), sims, proofs };
  }
  return { said: done(), sims, proofs };
}
