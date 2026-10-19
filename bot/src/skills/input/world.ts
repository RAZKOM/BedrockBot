// Small BlockQuery implementations for tests and courses whose terrain is known by construction,
// until Track B's world model (PLAN.md 4.2) is available.
import type { BlockQuery, Vec3 } from './types.ts';

/** A BDS flat world: solid from `bottomY` up to `groundTopY` (default: grass top at y = -61), air above. */
export function flatWorld(groundTopY = -61, bottomY = -64): BlockQuery {
  return { solidAt: (_x, y) => y <= groundTopY && y >= bottomY };
}

/** An axis-aligned block box (inclusive integer corners), as `truth:fill` takes them. */
export interface BlockBox {
  from: Vec3;
  to: Vec3;
  solid: boolean;
}

/** `base` with boxes painted over it; later boxes win. */
export function withBoxes(base: BlockQuery, boxes: readonly BlockBox[]): BlockQuery {
  const norm = boxes.map((b) => ({
    x0: Math.min(b.from.x, b.to.x),
    y0: Math.min(b.from.y, b.to.y),
    z0: Math.min(b.from.z, b.to.z),
    x1: Math.max(b.from.x, b.to.x),
    y1: Math.max(b.from.y, b.to.y),
    z1: Math.max(b.from.z, b.to.z),
    solid: b.solid,
  }));
  return {
    solidAt(x, y, z) {
      for (let i = norm.length - 1; i >= 0; i--) {
        const b = norm[i]!;
        if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && z >= b.z0 && z <= b.z1) return b.solid;
      }
      return base.solidAt(x, y, z);
    },
  };
}
