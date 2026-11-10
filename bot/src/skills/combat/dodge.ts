// The dodge (Track M1 round 2, docs/pve.md "Never die to common mobs (Track M1)", ADR 0079): a bot with no blade does not
// stand and trade with an archer or a witch, and does not run from one in a straight line either (its arrows come along
// the line it runs on). It runs across their line of fire, by hand, a step at a time where the ground is known to be safe.
//
// What it stands on (measured on BDS 1.26.60 with test/e2e/gaunt-probe.test.ts):
// - a skeleton aims at where the bot is when it lets go, not where it will be (the aim off the bot's line: within 1 block
//   at 6, 10 and 14 blocks while the bot ran across at 0.21 blocks a tick); the arrow flies 5 to 15 ticks;
// - standing, 7 of 9 arrows hit; running across at sprint, 2 of 13, both at a turn (the body slow for a few ticks);
// - a witch throws from 8 blocks (none from 12), every 61 ticks, the potion flies 4 ticks at 4 blocks and 10 at 8; side
//   steps at each throw put the potion 3.7 blocks off and halve what it does (poison 12.6 s instead of 45);
// - a 2-high block between, or a 2-deep hole, stops a held archer or witch from throwing at all (0 shots in 15 to 25 s).
//
// So: across the nearest shooter's line at sprint, with a drift out of its range (DODGE_BAND), turning only when no shot is
// in the air (a turn is the slow moment), and every step checked: the next two cells on the heading must have a floor
// under them (no drop, no liquid, nothing that hurts) and room for the body; else the other way, else straight out, else
// no dodge (the caller runs the ordinary flight).
import type { Vec3 } from '../../world/types.ts';
import { yawTowards } from '../nav/follower.ts';
import type { GridLike } from './targeting.ts';

/** Who is dodged: the archers (arrows) and the witch (potions). */
export type ShooterKind = 'archer' | 'witch';

/** Distance band (feet to feet, level) the dodge keeps from the nearest shooter: inside `lo` it drifts out faster. */
export const DODGE_BAND: Readonly<Record<ShooterKind, readonly [number, number]>> = {
  archer: [10, 18],
  witch: [13, 20], // she throws from 8, not from 12
};
/** Within this of a shooter the dodge is mostly straight out. */
export const DODGE_CLOSE = 6;
/** Turn round at most this often (ticks) without a reason: keeps the bot near where it was. */
export const DODGE_FLIP_TICKS = 60;

export interface DodgeShooter {
  pos: Vec3;
  kind: ShooterKind;
}

export interface DodgeInput {
  me: Vec3;
  /** The shooters with a line on the bot, within 16. */
  shooters: readonly DodgeShooter[];
  /** +1 / -1: which way across the line. */
  dir: 1 | -1;
  /** An arrow or a potion is in the air towards the bot: no turn now (a turn is the slow moment). */
  inFlight: boolean;
  /** Ticks since the last turn. */
  sinceFlip: number;
  grid: GridLike | undefined;
}

export interface DodgeStep {
  /** Yaw to sprint along (degrees). */
  yaw: number;
  dir: 1 | -1;
  flipped: boolean;
  /** Distance to the nearest shooter. */
  d: number;
}

/** Feet can stand at (x, y, z) and step there from the same level: a floor under it, room for the body, nothing that hurts or is liquid. */
export function safeCell(grid: GridLike, x: number, y: number, z: number): boolean {
  const fx = Math.floor(x);
  const fz = Math.floor(z);
  const under = grid.cls(fx, y - 1, fz);
  const feet = grid.cls(fx, y, fz);
  const head = grid.cls(fx, y + 1, fz);
  if (!under || !feet || !head) return false;
  if (!under.floor || under.danger || under.liquid) return false;
  for (const c of [feet, head]) if (c.boxes.length > 0 || c.liquid || c.danger) return false;
  return true;
}

/** The heading's next two cells are safe (see the file comment). */
function clearAlong(grid: GridLike, me: Vec3, hx: number, hz: number): boolean {
  const y = Math.floor(me.y + 1e-3);
  for (const k of [0.8, 1.6, 2.4]) if (!safeCell(grid, me.x + hx * k, y, me.z + hz * k)) return false;
  return true;
}

/** Ticks the potion side step lasts at most (a potion thrown from 8 flies 10 to 12). */
export const POTION_STEP_TICKS = 12;

/**
 * The side step from a witch's potion in the air (the reflex's, with the keys free; tasks/pve.ts potionStep): at right angles
 * to the potion's flight (to the line from it when it hardly moves), the side whose next cells are safe, the one away from
 * `avoid` (the nearest melee mob) when both are. Measured: a side step at each throw put the potion 3.7 blocks off and halved
 * what it did (poison 45 s to 12.6). Undefined when neither side is safe.
 */
export function potionSideStep(i: { me: Vec3; potion: Vec3; vel: Vec3; avoid?: Vec3; grid: GridLike | undefined }): { yaw: number } | undefined {
  if (!i.grid) return undefined;
  let fx = i.vel.x;
  let fz = i.vel.z;
  if (Math.hypot(fx, fz) < 0.05) {
    fx = i.me.x - i.potion.x;
    fz = i.me.z - i.potion.z;
  }
  const n = Math.hypot(fx, fz);
  if (n < 1e-6) return undefined;
  const sides = [
    { x: -fz / n, z: fx / n },
    { x: fz / n, z: -fx / n },
  ];
  if (i.avoid) {
    const ax = i.avoid.x - i.me.x;
    const az = i.avoid.z - i.me.z;
    sides.sort((a, b) => a.x * ax + a.z * az - (b.x * ax + b.z * az));
  }
  for (const s of sides) if (clearAlong(i.grid, i.me, s.x, s.z)) return { yaw: yawTowards(s.x, s.z) };
  return undefined;
}

/** One tick of the dodge (see the file comment); undefined = no safe way across or out (run the ordinary flight). */
export function dodgeStep(i: DodgeInput): DodgeStep | undefined {
  if (!i.grid || i.shooters.length === 0) return undefined;
  let s = i.shooters[0]!;
  let d = Math.hypot(s.pos.x - i.me.x, s.pos.z - i.me.z);
  // the way out: away from all of them, the near ones weighing most (one shooter: straight away from it). With several,
  // the nearest alone flips the heading whenever another becomes the nearest (a bare skeleton-4 run stood in a 3-block
  // patch for 10 s that way, round 2)
  let ax = 0;
  let az = 0;
  for (const o of i.shooters) {
    const od = Math.max(0.5, Math.hypot(o.pos.x - i.me.x, o.pos.z - i.me.z));
    ax += (i.me.x - o.pos.x) / (od * od);
    az += (i.me.z - o.pos.z) / (od * od);
    if (od < d) {
      s = o;
      d = od;
    }
  }
  let an = Math.hypot(ax, az);
  if (an < 1e-6) {
    ax = i.me.x - s.pos.x;
    az = i.me.z - s.pos.z;
    an = Math.max(1e-6, Math.hypot(ax, az));
  }
  const ux = ax / an;
  const uz = az / an;
  // a witch anywhere inside her band, or anyone within DODGE_CLOSE: mostly out (her splash reaches past a side step; an
  // arrow from 3 blocks flies 2 ticks, too short to step out of its way)
  const witch = i.shooters.some((o) => o.kind === 'witch' && Math.hypot(o.pos.x - i.me.x, o.pos.z - i.me.z) < DODGE_BAND.witch[0]);
  const [lo, hi] = DODGE_BAND[witch ? 'witch' : s.kind];
  const out = witch || d < DODGE_CLOSE ? 1.5 : d < lo ? 0.6 : d > hi ? -0.3 : 0.25;
  const heading = (dir: 1 | -1): { x: number; z: number } => {
    const tx = -uz * dir;
    const tz = ux * dir;
    const hx = tx + out * ux;
    const hz = tz + out * uz;
    const n = Math.hypot(hx, hz);
    return { x: hx / n, z: hz / n };
  };
  let dir = i.dir;
  let flipped = false;
  // a turn now and then (keeps the bot near), never with a shot in the air
  if (!i.inFlight && i.sinceFlip >= DODGE_FLIP_TICKS) {
    dir = dir === 1 ? -1 : 1;
    flipped = true;
  }
  let h = heading(dir);
  if (!clearAlong(i.grid, i.me, h.x, h.z)) {
    const other: 1 | -1 = dir === 1 ? -1 : 1;
    const h2 = heading(other);
    if (clearAlong(i.grid, i.me, h2.x, h2.z)) {
      dir = other;
      flipped = !flipped;
      h = h2;
    } else if (clearAlong(i.grid, i.me, ux, uz)) {
      h = { x: ux, z: uz };
    } else return undefined;
  }
  return { yaw: yawTowards(h.x, h.z), dir, flipped, d };
}
