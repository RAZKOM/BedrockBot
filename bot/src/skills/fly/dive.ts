// Track BL, deliverable 6 (docs/flight.md "The dive descent", decisions/0055): from high above the
// approach entry, dive steeply at the target, pull out above the entry and bleed the speed, then hand over
// to the ApproachPlanner, instead of the descent circle that sinks 0.15 to 0.2 blocks a tick. Measured on
// glideVelocity (the formula the server matches within 0.002 a tick): a dive at pitch 75 to 85 falls 2 to
// 3.5 blocks a tick with the horizontal speed under 1; a pull at pitch -30 then turns the fall into a near
// level glide within about 40 ticks for 10 to 20 blocks of drop; pitch -6 bleeds it to the planner's 1.15.
// From 250 above: about 170 ticks against about 1400 for the circle.
//
// The whole profile is simulated before it is flown, every candidate (dive pitch x pull pitch, the pull-out
// height solved for the hand-over height) first on the formula alone, then the best few against the cells:
// the obstacle query where unknown is not air (terrain.ts strictObstacle) and a clearance over every column
// under the path (`clearTop`). A profile is taken only when it ends inside the hand-over window (DIVE_END_MIN
// to DIVE_END_MAX blocks before the target, the entry height -3 to +8, slow and level) without passing the
// target; else the brain waits (the window is still ahead) or flies the circle (too close: it never fits).
import { glideVelocity } from '../input/physics.ts';
import { APPROACH_HEIGHT, approachYaw, hdist, hitsObstacle, type FlightBody, type LandingTarget, type Obstacle } from './plan.ts';

/** The hand-over window: this many blocks before the target centre (the planner starts at 56). */
export const DIVE_END_MIN = 48;
export const DIVE_END_MAX = 72;
/** The hand-over height: the approach entry (10 above the top) -3 .. +8; aimed 2 over it. */
export const DIVE_END_BELOW = 3;
export const DIVE_END_ABOVE = 5;
const DIVE_END_AIM = 2;
/** The hand-over speed (the planner's approach speed) and the most vertical speed left then. */
export const DIVE_HANDOVER_H = 1.05;
const DIVE_HANDOVER_VY = 0.35;
/** The bleed pitch after the pull (the cruise's speed bleed before the approach). */
export const DIVE_BLEED_PITCH = -6;
/** The pull ends when the fall is under this (blocks a tick). */
const PULL_END_VY = -0.3;
/** Every column under the path must be this far under the feet (the pull-out's room to spare). */
export const DIVE_CLEARANCE = 6;
/** The least height above the entry for a dive (auto); `dive` mode from DIVE_MIN_ABOVE_FORCED. */
export const DIVE_MIN_ABOVE = 24;
export const DIVE_MIN_ABOVE_FORCED = 16;
/** Candidates: the dive pitch and the pull pitch. */
export const DIVE_PITCHES = [55, 65, 75, 85] as const;
export const PULL_PITCHES = [-15, -30, -45] as const;
const MAX_TICKS = 600;

export type DivePhase = 'dive' | 'pull' | 'bleed';

export interface DiveProfile {
  divePitch: number;
  pullPitch: number;
  /** The dive ends (the pull begins) when the feet are at or under this y. */
  pullAt: number;
}

export interface DiveSim {
  ok: boolean;
  why?: string;
  ticks: number;
  /** The hand-over state. */
  end: { x: number; y: number; z: number; d: number; h: number; vy: number };
  /** The lowest clearance over the columns under the path (blocks), the most speed reached. */
  minClear: number;
  maxSpeed: number;
}

export interface DivePlan {
  ok: boolean;
  profile?: DiveProfile;
  sim?: DiveSim;
  /** No profile ends in the window yet because every one ends farther out (wait), or nearer / past it (never fits from here). */
  wait: boolean;
  why: string;
  sims: number;
}

/** The phase law of a dive profile (the brain and the simulation share it): dive, then pull, then bleed; 'done' at hand-over. */
export function divePhase(p: DiveProfile, phase: DivePhase, pos: { y: number }, vel: { x: number; y: number; z: number }): DivePhase | 'done' {
  let ph: DivePhase | 'done' = phase;
  if (ph === 'dive' && pos.y <= p.pullAt) ph = 'pull';
  if (ph === 'pull' && vel.y > PULL_END_VY) ph = 'bleed';
  if (ph === 'bleed' && Math.hypot(vel.x, vel.z) <= DIVE_HANDOVER_H && Math.abs(vel.y) <= DIVE_HANDOVER_VY) ph = 'done';
  return ph;
}

export function divePitch(p: DiveProfile, phase: DivePhase): number {
  return phase === 'dive' ? p.divePitch : phase === 'pull' ? p.pullPitch : DIVE_BLEED_PITCH;
}

/**
 * Simulate a dive profile from `body` (the yaw law of the approach: towards the target) until the hand-over,
 * the target passed, a hit, or MAX_TICKS. With `cells` the path is checked against the obstacle (the gliding
 * box with its berth, at every tick's end and midpoint) and the clearance over each column's top (`clearTop`).
 */
export function simulateDive(body: FlightBody, yaw: number, target: LandingTarget, p: DiveProfile, phase0: DivePhase = 'dive', cells?: { obstacle: Obstacle; clearTop?: (x: number, z: number) => number | undefined }): DiveSim {
  let pos = { ...body.pos };
  let vel = { ...body.vel };
  let y = yaw;
  let phase: DivePhase = phase0;
  let minClear = Infinity;
  let maxSpeed = 0;
  let boost = body.boostTicks;
  const entry = target.top + APPROACH_HEIGHT;
  const fail = (why: string, t: number): DiveSim => ({ ok: false, why, ticks: t, end: { ...pos, d: hdist(pos, target), h: Math.hypot(vel.x, vel.z), vy: vel.y }, minClear, maxSpeed });
  for (let t = 1; t <= MAX_TICKS; t++) {
    const ph = divePhase(p, phase, pos, vel);
    if (ph === 'done') {
      const d = hdist(pos, target);
      const end = { ...pos, d, h: Math.hypot(vel.x, vel.z), vy: vel.y };
      const sim = { ticks: t - 1, end, minClear, maxSpeed };
      if (d < DIVE_END_MIN) return { ok: false, why: `ends ${d.toFixed(0)} out (too near)`, ...sim };
      if (d > DIVE_END_MAX) return { ok: false, why: `ends ${d.toFixed(0)} out (too far)`, ...sim };
      if (pos.y < entry - DIVE_END_BELOW) return { ok: false, why: `ends ${(entry - pos.y).toFixed(0)} under the entry`, ...sim };
      if (pos.y > entry + DIVE_END_ABOVE) return { ok: false, why: `ends ${(pos.y - entry).toFixed(0)} over the entry`, ...sim };
      return { ok: true, ...sim };
    }
    phase = ph;
    y = approachYaw(y, pos, target);
    vel = glideVelocity(vel, y, divePitch(p, phase), boost > 0);
    if (boost > 0) boost--;
    const nx = { x: pos.x + vel.x, y: pos.y + vel.y, z: pos.z + vel.z };
    maxSpeed = Math.max(maxSpeed, Math.hypot(vel.x, vel.y, vel.z));
    if (hdist(nx, target) < DIVE_END_MIN - 16) return fail('passes the target', t);
    if (nx.y <= target.top) return fail('reaches the ground', t);
    if (cells) {
      const mid = { x: (pos.x + nx.x) / 2, y: (pos.y + nx.y) / 2, z: (pos.z + nx.z) / 2 };
      if (hitsObstacle(cells.obstacle, nx) || hitsObstacle(cells.obstacle, mid)) return fail(`a solid at ${Math.floor(nx.x)} ${Math.floor(nx.y)} ${Math.floor(nx.z)}`, t);
      const top = cells.clearTop?.(Math.floor(nx.x), Math.floor(nx.z));
      if (top !== undefined) {
        const clear = nx.y - (top + 1);
        minClear = Math.min(minClear, clear);
        // the hand-over itself is at the entry height (10 over the top): only the columns farther than the window are held to the clearance
        if (clear < DIVE_CLEARANCE && hdist(nx, target) > DIVE_END_MIN) return fail(`${clear.toFixed(0)} over the column ${Math.floor(nx.x)} ${Math.floor(nx.z)} (top ${top})`, t);
      }
    }
    pos = nx;
  }
  return fail('no hand-over', MAX_TICKS);
}

/**
 * The dive for `body` now: every candidate on the formula (the pull-out height solved in two rounds for the
 * hand-over height), the passing ones by time against the cells, the first clear one taken.
 */
export function planDive(body: FlightBody, yaw: number, target: LandingTarget, cells: { obstacle: Obstacle; clearTop?: (x: number, z: number) => number | undefined }): DivePlan {
  const entry = target.top + APPROACH_HEIGHT;
  let sims = 0;
  const passing: { p: DiveProfile; s: DiveSim }[] = [];
  let far = 0;
  let near = 0;
  let lastWhy = 'no candidate';
  for (const divePitchDeg of DIVE_PITCHES) {
    for (const pullPitch of PULL_PITCHES) {
      let p: DiveProfile = { divePitch: divePitchDeg, pullPitch, pullAt: entry + DIVE_END_AIM + 15 };
      if (p.pullAt >= body.pos.y) continue;
      let s = simulateDive(body, yaw, target, p);
      sims++;
      for (let round = 0; round < 2 && !s.ok && s.why !== 'passes the target' && s.why !== 'reaches the ground'; round++) {
        const err = s.end.y - (entry + DIVE_END_AIM);
        if (Math.abs(err) < 0.5) break;
        p = { ...p, pullAt: p.pullAt - err };
        if (p.pullAt >= body.pos.y) break;
        s = simulateDive(body, yaw, target, p);
        sims++;
      }
      if (s.ok) passing.push({ p, s });
      else {
        lastWhy = s.why ?? '?';
        if (s.end.d > DIVE_END_MAX && s.why?.includes('too far')) far++;
        else near++;
      }
    }
  }
  passing.sort((a, b) => a.s.ticks - b.s.ticks);
  for (const c of passing.slice(0, 4)) {
    const s = simulateDive(body, yaw, target, c.p, 'dive', cells);
    sims++;
    if (s.ok) return { ok: true, profile: c.p, sim: s, wait: false, why: `dive ${c.p.divePitch} to y ${c.p.pullAt.toFixed(0)}, pull ${c.p.pullPitch}: ${s.ticks} ticks, hand-over ${s.end.d.toFixed(0)} out ${(s.end.y - entry).toFixed(1)} over the entry at ${s.end.h.toFixed(2)}, clearance ${Number.isFinite(s.minClear) ? s.minClear.toFixed(0) : '-'}`, sims };
    lastWhy = s.why ?? '?';
  }
  if (passing.length) return { ok: false, wait: false, why: `every dive meets the terrain (${lastWhy})`, sims };
  return { ok: false, wait: far > 0, why: far > 0 ? `the window is still ahead (${lastWhy})` : `no dive ends in the window from here (${lastWhy})`, sims };
}
