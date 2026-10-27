// Vein mining (wave 10 Track AQ; docs/mining.md "Veins", docs/decisions/0038): after the first block of a
// vein the miner takes the whole group from where it stands. The group is the flood fill of the same ore
// kind through face and edge neighbours (18-connected; deepslate and normal variants, lit redstone, are
// one kind), at most VEIN_MAX blocks. Pure functions over a block lookup (the world model, the unit
// tests' voxel worlds); the miner (miner.ts) digs, steps and collects.
import type { BlockInfo, Vec3 } from '../../world/types.ts';

/** Blocks of one group at most. */
export const VEIN_MAX = 64;

/** The 18 neighbours: 6 faces and 12 edges. */
export const VEIN_NEIGHBOURS: readonly (readonly [number, number, number])[] = (() => {
  const out: [number, number, number][] = [];
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++) {
        const n = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
        if (n === 1 || n === 2) out.push([dx, dy, dz]);
      }
  return out;
})();

/** `deepslate_iron_ore` / `lit_redstone_ore` -> `iron_ore` / `redstone_ore`: one kind per ore. */
export function oreKind(name: string): string {
  return name
    .toLowerCase()
    .replace(/^minecraft:/, '')
    .replace(/^lit_/, '')
    .replace(/^deepslate_/, '');
}

const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;

/**
 * The group of `kind` (an `oreKind`) around `seed`: the seed itself when it still is that ore, and every
 * block of the kind reachable through face and edge neighbours, in breadth-first order from the seed
 * (the seed may already be mined: its neighbours start the fill). At most `max` blocks.
 */
export function veinFrom(blockAt: (p: Vec3) => BlockInfo | undefined, seed: Vec3, kind: string, max = VEIN_MAX): Vec3[] {
  const is = (p: Vec3) => {
    const b = blockAt(p);
    return !!b && oreKind(b.name) === kind;
  };
  const out: Vec3[] = [];
  const seen = new Set<string>([key(seed)]);
  const queue: Vec3[] = [seed];
  if (is(seed)) out.push({ ...seed });
  while (queue.length > 0 && out.length < max) {
    const c = queue.shift()!;
    for (const [dx, dy, dz] of VEIN_NEIGHBOURS) {
      const n = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
      const k = key(n);
      if (seen.has(k)) continue;
      seen.add(k);
      if (!is(n)) continue;
      out.push(n);
      queue.push(n);
      if (out.length >= max) break;
    }
  }
  return out;
}

/** The centre of a group (block centres; y at the blocks' bottoms), for the collect at its end. */
export function veinCentre(cells: readonly Vec3[]): Vec3 {
  const n = Math.max(1, cells.length);
  return { x: cells.reduce((a, c) => a + c.x + 0.5, 0) / n, y: cells.reduce((a, c) => a + c.y, 0) / n, z: cells.reduce((a, c) => a + c.z + 0.5, 0) / n };
}

/** Blocks from the centre to the farthest block of the group. */
export function veinRadius(cells: readonly Vec3[]): number {
  const c = veinCentre(cells);
  return cells.reduce((a, p) => Math.max(a, Math.hypot(p.x + 0.5 - c.x, p.y - c.y, p.z + 0.5 - c.z)), 0);
}
