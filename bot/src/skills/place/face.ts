// Block faces for placing and using blocks (PLAN.md task 7.3). The protocol numbers faces 0..5
// (`inventory_transaction.transaction_data.face`, `player_auth_input.block_action[].face`):
// 0 down (-y), 1 up (+y), 2 north (-z), 3 south (+z), 4 west (-x), 5 east (+x), the same numbering
// as skills/dig/look.ts FACE. A click on face F of block S puts a new block at S + offset(F).
import type { Vec3 } from '../../world/types.ts';

export type BlockFace = 'down' | 'up' | 'north' | 'south' | 'west' | 'east';

/** All faces in protocol order (index = packet face number). */
export const BLOCK_FACES: readonly BlockFace[] = Object.freeze(['down', 'up', 'north', 'south', 'west', 'east']);

const INDEX: Readonly<Record<BlockFace, number>> = Object.freeze({ down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 });

const OFFSET: Readonly<Record<BlockFace, Readonly<Vec3>>> = Object.freeze({
  down: Object.freeze({ x: 0, y: -1, z: 0 }),
  up: Object.freeze({ x: 0, y: 1, z: 0 }),
  north: Object.freeze({ x: 0, y: 0, z: -1 }),
  south: Object.freeze({ x: 0, y: 0, z: 1 }),
  west: Object.freeze({ x: -1, y: 0, z: 0 }),
  east: Object.freeze({ x: 1, y: 0, z: 0 }),
});

const OPPOSITE: Readonly<Record<BlockFace, BlockFace>> = Object.freeze({ down: 'up', up: 'down', north: 'south', south: 'north', west: 'east', east: 'west' });

/** Packet face number (0..5). */
export function faceIndex(f: BlockFace): number {
  return INDEX[f];
}

/** Face of a packet face number; undefined outside 0..5. */
export function faceOf(i: number): BlockFace | undefined {
  return BLOCK_FACES[i];
}

/** Unit normal of a face (pointing out of the block). */
export function faceOffset(f: BlockFace): Vec3 {
  return { ...OFFSET[f] };
}

export function oppositeFace(f: BlockFace): BlockFace {
  return OPPOSITE[f];
}

/** The block next to `p` across face `f` (`p + offset(f)`), integer coordinates. */
export function neighbour(p: Vec3, f: BlockFace): Vec3 {
  const o = OFFSET[f];
  return { x: Math.floor(p.x) + o.x, y: Math.floor(p.y) + o.y, z: Math.floor(p.z) + o.z };
}

/**
 * For a new block at `p` placed by clicking face `f` of its support: the support block
 * (`p - offset(f)`). E.g. face 'up' -> the block below `p`.
 */
export function supportOf(p: Vec3, f: BlockFace): Vec3 {
  return neighbour(p, OPPOSITE[f]);
}

/** Centre of face `f` of block `p`, block-relative (0..1 per axis): the click position vanilla reports. */
export function faceCenter(f: BlockFace): Vec3 {
  const o = OFFSET[f];
  return { x: o.x === 0 ? 0.5 : o.x > 0 ? 1 : 0, y: o.y === 0 ? 0.5 : o.y > 0 ? 1 : 0, z: o.z === 0 ? 0.5 : o.z > 0 ? 1 : 0 };
}

/** Centre of face `f` of block `p` in world coordinates. */
export function facePoint(p: Vec3, f: BlockFace): Vec3 {
  const c = faceCenter(f);
  return { x: Math.floor(p.x) + c.x, y: Math.floor(p.y) + c.y, z: Math.floor(p.z) + c.z };
}

/**
 * The face of the support block `s` whose outward side the eye is on (the face can be seen from
 * there): eye beyond the face plane. A face the eye is behind cannot be clicked by a real client.
 */
export function faceVisibleFrom(eye: Vec3, s: Vec3, f: BlockFace): boolean {
  const o = OFFSET[f];
  const bx = Math.floor(s.x);
  const by = Math.floor(s.y);
  const bz = Math.floor(s.z);
  if (o.x > 0) return eye.x > bx + 1;
  if (o.x < 0) return eye.x < bx;
  if (o.y > 0) return eye.y > by + 1;
  if (o.y < 0) return eye.y < by;
  if (o.z > 0) return eye.z > bz + 1;
  return eye.z < bz;
}
