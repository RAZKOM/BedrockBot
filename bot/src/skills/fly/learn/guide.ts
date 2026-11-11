// Track F9b (docs/flight.md "Learned exits (Track F9b)"; decisions/0078-learned-exits.md): a recorded path as a line
// to fly along. A recording (`recorder.ts`) is what the server said about a player about 20 times a second; a GUIDE is
// one flight out of it (from where the player left the ground to where they stood again, or to the end of what was
// seen) as a line of points a block apart, with the time each was passed and the rockets fired on it. It is geometry
// only: who flew it and what the file is called decide nothing (`match.ts` matches by where the line begins and ends).
//
// A recording is a demonstration, not a script: the follower (`follow.ts`) flies the line's place, not its timetable,
// and nothing is flown that its simulation has not cleared (glide.ts routeTakeoff).
import type { Vec3 } from '../../../connection/types.ts';
import { GAP_MS, type LearnedPath, type LearnSample } from './recorder.ts';

/** The guide's points lie this far apart along the line (blocks). */
export const GUIDE_STEP = 1;
/** A stretch off the ground shorter than this (blocks along it) is a hop, not a flight. */
export const FLIGHT_MIN_BLOCKS = 12;
/** A sample faster than this from the one before (blocks a second; a rocket's best is about 34) is a teleport or a late packet: dropped. */
export const SAMPLE_MAX_SPEED = 80;
/** A flight left the ground at the sample on the ground before its first one in the air when that lies within this of it (blocks: a jump's first tick is 0.42 up). */
export const GROUND_LINK = 2;
const TICK_MS = 50;

export interface Guide {
  /** The recording's name: for the log only, never for matching. */
  path: string;
  /** Which of the recording's flights this is (0 first). */
  flight: number;
  /** The line, GUIDE_STEP apart: the first point is where the flight left the ground (or its first sample in the air), the last where it stood again (or the last sample seen). Feet heights. */
  points: Vec3[];
  /** The recorded time each point was passed, in ticks after the first. */
  ticks: number[];
  /** The rockets fired on the line: ticks after the first point, and blocks along the line. */
  rockets: { tick: number; at: number }[];
  /** The look at the first point (Bedrock yaw). */
  yaw: number;
  /** The flight left the ground at its first point (a takeoff), and stood again at its last (a landing). */
  grounded: boolean;
  landed: boolean;
  /** Track F9d: the line was not recorded but drawn from the world (learn/draw.ts): for the log's words; it is proven and flown as a recorded one. */
  drawn?: boolean;
  /**
   * Track F9e: a drawn line's speed for every point (blocks a tick; learn/draw.ts lineSpeeds): the most a glide with no
   * rocket burning may have there and still follow the line through what comes (a top the line goes over, a tight
   * corner). The follower takes speed off a faster body (learn/follow.ts) and holds a rocket back before a slow place.
   * A recorded line has none and is flown as before.
   */
  speeds?: number[];
  /**
   * Track F9e: the line is a hop between two places under one roof (learn/hop.ts): it ends on a touchdown, not in the open.
   * `from` and `to` (blocks along it) are where its LAST rocket goes: a body there with none burning and slower than a
   * rocket's speed fires one, and none is fired beyond `to` (a rocket burns up to 21 ticks, 35 blocks of flight: one fired
   * later would still burn at the touchdown's brake).
   */
  hop?: { from: number; to: number };
}

/** Track F9d: a guide as the log names it: `the learned line <name>` (a recording) or `the drawn line <name>` (learn/draw.ts). */
export function guideSaid(g: Pick<Guide, 'path' | 'drawn'>): string {
  return `the ${g.drawn ? 'drawn' : 'learned'} line ${g.path}`;
}

/** Track F9e: what the log calls a flight's end along a line: a `learned entry` (a recording's) or a `drawn entry` (learn/drawin.ts). */
export function entrySaid(g: Pick<Guide, 'drawn'>): string {
  return g.drawn ? 'drawn entry' : 'learned entry';
}

/** The samples without the teleport-like ones (a sample no speed explains, where the samples round it fit each other). */
function cleaned(samples: readonly LearnSample[]): LearnSample[] {
  const out: LearnSample[] = [];
  const fast = (a: LearnSample, b: LearnSample): boolean => {
    const dt = Math.max(1, b.t - a.t);
    return (Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / dt) * 1000 > SAMPLE_MAX_SPEED;
  };
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const prev = out[out.length - 1];
    const next = samples[i + 1];
    // one sample out of line: the one before and the one after agree with each other and not with it
    if (prev && fast(prev, s) && next && !fast(prev, next)) continue;
    out.push(s);
  }
  return out;
}

/**
 * The flights of a recording, each as a guide: the stretches off the ground at least FLIGHT_MIN_BLOCKS long, cut at
 * the gaps (a stretch flown out of the recorder's view is not known, so nothing is drawn through it) and at a jump no
 * speed explains. A flight that begins after a sample on the ground starts at that sample (`grounded`); one followed
 * by a sample on the ground ends at it (`landed`).
 */
export function guidesOf(path: LearnedPath): Guide[] {
  const s = cleaned(path.samples);
  const out: Guide[] = [];
  const broken = (a: LearnSample, b: LearnSample): boolean => b.t - a.t > GAP_MS || (Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / Math.max(1, b.t - a.t)) * 1000 > SAMPLE_MAX_SPEED;
  let i = 0;
  while (i < s.length) {
    if (s[i]!.ground) {
      i++;
      continue;
    }
    // the run of samples in the air from i, unbroken
    let j = i;
    while (j + 1 < s.length && !s[j + 1]!.ground && !broken(s[j]!, s[j + 1]!)) j++;
    // (the takeoff: the sample on the ground before the first one in the air, where it lies beside it. A player who stood
    // still sends nothing, so that sample may be seconds old: its place is the takeoff's, its time is a tick before the jump's)
    const before = i > 0 ? s[i - 1]! : undefined;
    const grounded = before !== undefined && before.ground && Math.hypot(s[i]!.x - before.x, s[i]!.y - before.y, s[i]!.z - before.z) <= GROUND_LINK;
    const landed = j + 1 < s.length && s[j + 1]!.ground && !broken(s[j]!, s[j + 1]!);
    const run = s.slice(i, landed ? j + 2 : j + 1);
    if (grounded) run.unshift({ ...before, t: Math.max(before.t, s[i]!.t - TICK_MS) });
    const g = guideOfRun(path, out.length, run, grounded, landed);
    if (g) out.push(g);
    i = j + 1;
  }
  return out;
}

function guideOfRun(path: LearnedPath, flight: number, run: readonly LearnSample[], grounded: boolean, landed: boolean): Guide | undefined {
  if (run.length < 2) return undefined;
  const first = run[0]!;
  const points: Vec3[] = [{ x: first.x, y: first.y, z: first.z }];
  const ticks: number[] = [0];
  // the samples' own distances along the line (for the rockets)
  const along: number[] = [0];
  let walked = 0;
  let next: number = GUIDE_STEP;
  for (let k = 1; k < run.length; k++) {
    const a = run[k - 1]!;
    const b = run[k]!;
    const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    while (d > 0 && walked + d >= next) {
      const f = (next - walked) / d;
      points.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f });
      ticks.push((a.t + (b.t - a.t) * f - first.t) / TICK_MS);
      next += GUIDE_STEP;
    }
    walked += d;
    along.push(walked);
  }
  if (walked < FLIGHT_MIN_BLOCKS) return undefined;
  const last = run[run.length - 1]!;
  const tail = points[points.length - 1]!;
  if (Math.hypot(last.x - tail.x, last.y - tail.y, last.z - tail.z) > 0.25) {
    points.push({ x: last.x, y: last.y, z: last.z });
    ticks.push((last.t - first.t) / TICK_MS);
  }
  // the rockets seen while this flight was in the air (a rocket's packet may come a few ticks after its use)
  const rockets: Guide['rockets'] = [];
  for (const r of path.rockets) {
    if (r.t < first.t || r.t > last.t) continue;
    let k = 0;
    while (k + 1 < run.length && run[k + 1]!.t <= r.t) k++;
    rockets.push({ tick: Math.round((r.t - first.t) / TICK_MS), at: along[k]! });
  }
  return { path: path.name, flight, points, ticks, rockets, yaw: first.yaw, grounded, landed };
}

/** The length of a guide (blocks along it). */
export function guideLength(g: Pick<Guide, 'points'>): number {
  // (a place on the line is counted in its points, GUIDE_STEP each, and the last piece's own length: `guidePoint` and
  // `guideNearest` count the same way; round a corner of the recording two points lie a little nearer than a step)
  const n = g.points.length;
  return n < 2 ? 0 : (n - 2) * GUIDE_STEP + dist(g.points[n - 2]!, g.points[n - 1]!);
}

/** The guide's first `points` points (its line up to there, the rockets fired on that part). */
export function guideHead(g: Guide, points: number): Guide {
  if (points >= g.points.length) return g;
  const n = Math.max(2, points);
  const cut = { ...g, points: g.points.slice(0, n), ticks: g.ticks.slice(0, n), landed: false };
  const len = guideLength(cut);
  return { ...cut, rockets: g.rockets.filter((r) => r.at <= len) };
}

/** The guide from its `from`-th point on (the line's end: an approach and a landing). */
export function guideTail(g: Guide, from: number): Guide {
  if (from <= 0) return g;
  const k = Math.min(from, g.points.length - 2);
  const before = guideLength({ points: g.points.slice(0, k + 1) });
  const t0 = g.ticks[k]!;
  return { ...g, points: g.points.slice(k), ticks: g.ticks.slice(k).map((t) => t - t0), rockets: g.rockets.filter((r) => r.at >= before).map((r) => ({ tick: r.tick - Math.round(t0), at: r.at - before })), grounded: false };
}

/** The point `at` blocks along the guide (beyond its end: on along its last direction), and the line's direction there. */
export function guidePoint(g: Pick<Guide, 'points'>, at: number): { pos: Vec3; dir: Vec3 } {
  const p = g.points;
  const n = p.length;
  // (the points lie GUIDE_STEP apart but for the last, which may be nearer)
  const i = Math.max(0, Math.min(n - 2, Math.floor(at / GUIDE_STEP)));
  const a = p[i]!;
  const b = p[i + 1]!;
  const d = dist(a, b) || 1;
  const dir = { x: (b.x - a.x) / d, y: (b.y - a.y) / d, z: (b.z - a.z) / d };
  const f = at - i * GUIDE_STEP;
  return { pos: { x: a.x + dir.x * f, y: a.y + dir.y * f, z: a.z + dir.z * f }, dir };
}

/**
 * The place of `pos` on the guide: the blocks along it of the nearest point of the line between `from` and `from + window`
 * (the line is flown forwards: a place behind `from` is not looked for), and the distance to it.
 */
export function guideNearest(g: Pick<Guide, 'points'>, pos: Vec3, from = 0, window = Infinity): { at: number; dist: number } {
  const p = g.points;
  const i0 = Math.max(0, Math.min(p.length - 2, Math.floor(from / GUIDE_STEP)));
  const i1 = Math.min(p.length - 2, Number.isFinite(window) ? Math.ceil((from + window) / GUIDE_STEP) : p.length - 2);
  let best = { at: from, dist: Infinity };
  for (let i = i0; i <= i1; i++) {
    const a = p[i]!;
    const b = p[i + 1]!;
    const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const len2 = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z || 1;
    const f = Math.max(0, Math.min(1, ((pos.x - a.x) * ab.x + (pos.y - a.y) * ab.y + (pos.z - a.z) * ab.z) / len2));
    const d = Math.hypot(pos.x - (a.x + ab.x * f), pos.y - (a.y + ab.y * f), pos.z - (a.z + ab.z * f));
    if (d < best.dist) best = { at: Math.max(from, i * GUIDE_STEP + f * Math.sqrt(len2)), dist: d };
  }
  return best;
}

const dist = (a: Vec3, b: Vec3): number => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
