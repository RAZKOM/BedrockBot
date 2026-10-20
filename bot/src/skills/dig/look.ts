// Aiming and reach for digging: yaw/pitch towards a point, the block face seen from the eye, and the
// reach limits measured on BDS 1.26.51 (docs/digging.md).
import type { Vec3 } from '../../connection/types.ts';

export const EYE_HEIGHT = 1.62;

/** Block faces as the protocol numbers them (`block_action.face`). */
export const FACE = Object.freeze({ down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 });
export type Face = (typeof FACE)[keyof typeof FACE];

/**
 * Bedrock yaw/pitch (degrees) that point the view from `eye` at `target`: yaw 0 = +z, 90 = -x;
 * pitch +90 = straight down. Matches `viewDirection()` in skills/input/flags.ts.
 */
export function lookAngles(eye: Vec3, target: Vec3): { yaw: number; pitch: number } {
  const dx = target.x - eye.x;
  const dy = target.y - eye.y;
  const dz = target.z - eye.z;
  const yaw = (Math.atan2(-dx, dz) * 180) / Math.PI;
  const pitch = (-Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI;
  return { yaw: yaw + 0, pitch: pitch + 0 };
}

export function blockCenter(p: Vec3): Vec3 {
  return { x: Math.floor(p.x) + 0.5, y: Math.floor(p.y) + 0.5, z: Math.floor(p.z) + 0.5 };
}

/**
 * The face of block `p` that a ray from `eye` towards the block centre enters through (the face the
 * player sees). An eye inside the block's column on two axes picks the remaining axis.
 */
export function faceToward(eye: Vec3, p: Vec3): Face {
  const bx = Math.floor(p.x);
  const by = Math.floor(p.y);
  const bz = Math.floor(p.z);
  // Entry fraction along each axis of the segment eye -> centre; the largest one is the entry face.
  const c = blockCenter(p);
  const axes: { t: number; face: Face }[] = [];
  const entry = (e: number, cc: number, lo: number, neg: Face, pos: Face) => {
    const d = cc - e;
    if (d > 0 && e < lo) axes.push({ t: (lo - e) / d, face: neg });
    else if (d < 0 && e > lo + 1) axes.push({ t: (lo + 1 - e) / d, face: pos });
  };
  entry(eye.x, c.x, bx, FACE.west, FACE.east);
  entry(eye.y, c.y, by, FACE.down, FACE.up);
  entry(eye.z, c.z, bz, FACE.north, FACE.south);
  if (axes.length === 0) return FACE.up; // eye inside the block
  axes.sort((a, b) => b.t - a.t);
  return axes[0]!.face;
}

/** Distance from the eye to the closest point of block `p`. */
export function distanceToBlock(eye: Vec3, p: Vec3): number {
  const gap = (e: number, lo: number) => Math.max(lo - e, 0, e - (lo + 1));
  return Math.hypot(gap(eye.x, Math.floor(p.x)), gap(eye.y, Math.floor(p.y)), gap(eye.z, Math.floor(p.z)));
}

/**
 * Server pick range on BDS 1.26.51 with server-authoritative block breaking, measured
 * (docs/digging.md): a break is accepted while |eye - block min corner| <= SERVER_PICK_BASE * scalar,
 * where scalar = `server-authoritative-block-breaking-pick-range-scalar` (default 1.5). Measured limits:
 * between 6.698 and 6.717 at scalar 1.0 and between 10.048 and 10.076 at 1.5 (consistent with
 * sqrt(45) = 6.708 * scalar). Beyond it the server silently ignores the break (no kick, no correction).
 */
export const SERVER_PICK_BASE = 6.7;
export const DEFAULT_PICK_SCALAR = 1.5;

/** The distance the server measures (eye to the block's integer min corner). */
export function serverReachDistance(eye: Vec3, p: Vec3): number {
  return Math.hypot(Math.floor(p.x) - eye.x, Math.floor(p.y) - eye.y, Math.floor(p.z) - eye.z);
}

/**
 * The bot's own reach (eye to the closest point of the block), well inside the server limit and
 * about what a vanilla survival player reaches with a mouse. A Realm may run a smaller scalar.
 */
export const DEFAULT_REACH = 5;

export interface ReachCheck {
  ok: boolean;
  /** Eye to the closest point of the block. */
  distance: number;
  /** Eye to the block's min corner (the server's measure). */
  serverDistance: number;
  reason?: 'too_far' | 'server_range';
}

export function checkReach(eye: Vec3, p: Vec3, reach = DEFAULT_REACH, scalar = DEFAULT_PICK_SCALAR): ReachCheck {
  const distance = distanceToBlock(eye, p);
  const serverDistance = serverReachDistance(eye, p);
  if (distance > reach) return { ok: false, distance, serverDistance, reason: 'too_far' };
  if (serverDistance > SERVER_PICK_BASE * scalar) return { ok: false, distance, serverDistance, reason: 'server_range' };
  return { ok: true, distance, serverDistance };
}
