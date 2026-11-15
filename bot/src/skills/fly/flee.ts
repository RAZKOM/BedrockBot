// The elytra flee as a flight mode (Track M3; docs/pve.md "The elytra flee", decisions/0086-landing-looks-at-mobs.md;
// the setting `fleeFly`, default off): the numbers and the pure choices; the flight itself is built in
// chat/commands-fly.ts (`flee`) from the flight's own takeoffs, cruise and landing search, and asked for by the guard
// (tasks/pve.ts).
//
// What a player does when the mobs are too many: jump, open the wings, a rocket, and come down somewhere else. The
// flee does the same and nothing a flight does not do already:
//   - it takes off only where a takeoff's simulation is clear: the jump along a heading away from the hostiles, else
//     straight up the open column over the body. Under a roof (FLEE_FLY.headroom) there is no flee: the other floors
//     (the flight on foot, the seal-in, the stand) stay in charge;
//   - it needs the elytra and FLEE_FLY.rockets loose rockets (a jump takeoff fires 1 to 3, a go-around at the landing
//     1 or 2). The fireworks box is never opened or placed in a flee;
//   - it flies FLEE_FLY.far blocks away from the hostiles (home instead when that is far enough, not on the hostiles'
//     side of the body and nothing hostile is known there), and its landing is found from the air by the landing search with the look at hostiles
//     (landmobs.ts): never inside a creeper's range, away from the rest;
//   - it never lands because the health is low (a flight's own rule, tasks/process/fly.ts): the health is why it flies.
import type { LandMob } from './landmobs.ts';

export const FLEE_FLY = Object.freeze({
  /** Loose rockets a flee needs before it takes off. */
  rockets: 3,
  /** The column over the body must be open this far over the feet (blocks) for a flee to be tried at all. */
  headroom: 8,
  /** The flee's destination lies this far away (blocks): outside what any common mob follows (a zombie 35 to 40), inside what the server keeps loaded round the body. */
  far: 96,
  /** Home is the destination when it lies at least this far from the body (a flee that lands where it took off is none) ... */
  homeMin: 48,
  /** ... and at most this far (a flee is a short flight: farther, the nearest safe ground). */
  homeMax: 400,
  /** ... and no hostile is known within this of it, ... */
  safe: 24,
  /** ... and every hostile round the body is more than this many degrees off the bearing to it (fleeHomeClear). */
  homeAngle: 60,
  /** The hostiles a flee counts: within this of the body (level). */
  scan: 32,
});

/** What an elytra flee came to. */
export interface FleeFlight {
  /** The body stands on ground again after a flight. */
  ok: boolean;
  /** A takeoff was made (false: refused where the body stood: the other floors go on). */
  flew: boolean;
  reason?: string;
  /** One line for the log. */
  line: string;
  seconds: number;
  landedAt?: { x: number; y: number; z: number };
  /** Blocks (level) from the takeoff to where the flight ended, the rockets it fired, the nearest hostile known there. */
  moved?: number;
  rockets?: number;
  nearest?: number;
}

const norm = (yaw: number): number => {
  let y = yaw % 360;
  if (y > 180) y -= 360;
  if (y <= -180) y += 360;
  return y;
};

/**
 * The heading away from the hostiles (Bedrock yaw: 0 = +z, 90 = -x): the sum of the ways away from each, the near ones
 * weighing most (1 / d squared, as the flight on foot's hand-steered run). Nothing hostile known, or the pulls cancel:
 * `fallback` (the way the body looks).
 */
export function fleeAway(from: { x: number; z: number }, mobs: readonly LandMob[], fallback: number): number {
  let ax = 0;
  let az = 0;
  for (const m of mobs) {
    const d = Math.max(0.5, Math.hypot(from.x - m.x, from.z - m.z));
    ax += (from.x - m.x) / (d * d);
    az += (from.z - m.z) / (d * d);
  }
  if (Math.hypot(ax, az) < 1e-6) return norm(fallback);
  return norm((Math.atan2(-ax, az) * 180) / Math.PI);
}

/**
 * Home is a flee's destination only when the hostiles round the body are not on the way to it: every one of them more
 * than FLEE_FLY.homeAngle degrees off the bearing to home as seen from the body (the flight on foot's own rule for its
 * leg home, tasks/pve.ts FLEE_HOME_ANGLE). A mob that has followed the body away from home stands between the two, and
 * a flight home over it only turns it round: on bds-pve a pillager that had followed a first flee 96 blocks out was 23
 * blocks from home when the second flee landed there, and shot the body dead.
 */
export function fleeHomeClear(from: { x: number; z: number }, home: { x: number; z: number }, mobs: readonly LandMob[]): boolean {
  const hx = home.x - from.x;
  const hz = home.z - from.z;
  const hd = Math.hypot(hx, hz);
  if (hd < 1e-6) return false;
  const cos = Math.cos((FLEE_FLY.homeAngle * Math.PI) / 180);
  for (const m of mobs) {
    const mx = m.x - from.x;
    const mz = m.z - from.z;
    const md = Math.hypot(mx, mz);
    if (md < 1e-6) return false;
    if ((mx * hx + mz * hz) / (md * hd) > cos) return false;
  }
  return true;
}

/** The bearings a destination is looked for on: away first, then 30, 60 and 90 degrees either side of it. */
export function fleeBearings(away: number): number[] {
  return [0, 30, -30, 60, -60, 90, -90].map((o) => norm(away + o));
}

/** The takeoff headings tried, in order: `yaw` first, then every 30 degrees either side out to `spread`. */
export function fleeHeadings(yaw: number, spread: number): number[] {
  const out = [norm(yaw)];
  for (let o = 30; o <= spread; o += 30) out.push(norm(yaw + o), norm(yaw - o));
  return out;
}
