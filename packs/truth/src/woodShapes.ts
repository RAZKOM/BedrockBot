// Pure tree-shape helpers for the wood commands (truth:tree) and the bot's wood e2e worlds. No
// @minecraft/server import, so the bot's tests can reuse them.
import type { Vec3 } from './protocol.js';

export interface TreeShape {
  /** Log positions, bottom up (the trunk column). */
  logs: Vec3[];
  /** Leaf positions (never on a log). */
  leaves: Vec3[];
}

/**
 * A simple oak/birch-like tree standing on (x, y - 1, z): a log column y .. y + height - 1 and a
 * leaf canopy around the top. Deterministic (no random corners):
 *
 *   top + 2   plus shape (centre + 4)
 *   top + 1   radius 1 square without corners (the trunk ends below: centre is a leaf)
 *   top, top - 1   radius 2 square without its 4 corners, the trunk in the middle
 *
 * where top = y + height - 1. The lowest leaves are at y + height - 2, so for height >= 4 the
 * cells next to the trunk are free up to y + 1 (a player can stand next to it and dig every log
 * from the ground: the highest log of a 6-high tree is 3.4 blocks from the eye).
 */
export function treeShape(x: number, y: number, z: number, height: number): TreeShape {
  if (!Number.isInteger(height) || height < 1 || height > 32) throw new Error(`tree height must be 1..32, got ${height}`);
  const top = y + height - 1;
  const logs: Vec3[] = [];
  for (let i = 0; i < height; i++) logs.push({ x, y: y + i, z });
  const leaves: Vec3[] = [];
  const isLog = (p: Vec3) => p.x === x && p.z === z && p.y >= y && p.y <= top;
  const layer = (ly: number, r: number, corners: boolean) => {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (!corners && Math.abs(dx) === r && Math.abs(dz) === r) continue;
        const p = { x: x + dx, y: ly, z: z + dz };
        if (!isLog(p)) leaves.push(p);
      }
    }
  };
  if (height >= 2) layer(top - 1, 2, false);
  layer(top, 2, false);
  layer(top + 1, 1, false);
  // plus shape = radius 1 without corners
  layer(top + 2, 1, false);
  // dedupe (a radius-1 layer without corners is already the plus shape; keep the list unique anyway)
  const seen = new Set<string>();
  const uniq = leaves.filter((p) => {
    const k = `${p.x},${p.y},${p.z}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { logs, leaves: uniq };
}

/** Tree kinds the truth pack can place (`<kind>_log`, `<kind>_leaves`). */
export const TREE_KINDS = ['oak', 'birch', 'spruce', 'jungle', 'acacia', 'dark_oak', 'cherry', 'mangrove', 'pale_oak'] as const;
