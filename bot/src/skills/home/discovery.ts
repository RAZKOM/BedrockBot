// Track AG (wave 9, docs/home.md "Discovery"): the containers within `homeChestRadius` of home. Loaded
// columns are searched block by block (World.find), unloaded ones through the world cache's marks
// (chests, trapped chests, barrels and, since Track AG, shulker boxes are marks like ores). Double
// chests: the half next to a remembered double chest is its partner, never a container of its own.
import type { BlockInfo, Vec3 } from '../../world/types.ts';
import { isShulkerBox } from '../container/chest.ts';

/** The blocks home logistics remembers (the chest skill opens all of them). */
export function isHomeContainer(name: string): boolean {
  const n = name.startsWith('minecraft:') ? name.slice(10) : name;
  return n === 'chest' || n === 'trapped_chest' || n === 'barrel' || isShulkerBox(n);
}

export interface FoundContainer {
  p: Vec3;
  kind: string;
  /** From the world cache (an unloaded column): the kind is what the cache remembered. */
  cached: boolean;
}

export interface DiscoveryWorld {
  find(pred: (b: BlockInfo, p: Vec3) => boolean, opts: { origin: Vec3; radius: number; max: number }): (Vec3 & { cached?: true })[];
  blockAt(p: Vec3): BlockInfo | undefined;
}

/** Every container block within `radius` of `home` (block centres), nearest first. */
export function findContainers(world: DiscoveryWorld, home: Vec3, radius: number, max = 256): FoundContainer[] {
  const origin = { x: Math.floor(home.x) + 0.5, y: Math.floor(home.y) + 0.5, z: Math.floor(home.z) + 0.5 };
  const kinds = new Map<string, string>();
  const found = world.find(
    (b, p) => {
      if (!isHomeContainer(b.name)) return false;
      kinds.set(`${p.x},${p.y},${p.z}`, b.name);
      return true;
    },
    { origin, radius, max },
  );
  return found.map((p) => ({ p: { x: p.x, y: p.y, z: p.z }, kind: kinds.get(`${p.x},${p.y},${p.z}`) ?? world.blockAt(p)?.name ?? 'chest', cached: p.cached === true }));
}

/** The horizontal neighbours of a chest that are chests of the same kind (a double chest's other half). */
export function chestNeighbours(blockAt: (p: Vec3) => BlockInfo | undefined, p: Vec3, kind: string): Vec3[] {
  if (kind !== 'chest' && kind !== 'trapped_chest') return [];
  const out: Vec3[] = [];
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    const q = { x: p.x + dx, y: p.y, z: p.z + dz };
    if (blockAt(q)?.name === kind) out.push(q);
  }
  return out;
}

/** Visit order: nearest neighbour from `start` (short walks between the chests). */
export function visitOrder<T extends { p: Vec3 }>(items: readonly T[], start: Vec3): T[] {
  const left = [...items];
  const out: T[] = [];
  let at = start;
  while (left.length > 0) {
    let best = 0;
    let bd = Infinity;
    left.forEach((it, i) => {
      const d = Math.hypot(it.p.x + 0.5 - at.x, it.p.y - at.y, it.p.z + 0.5 - at.z);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    const [next] = left.splice(best, 1);
    out.push(next!);
    at = { x: next!.p.x + 0.5, y: next!.p.y, z: next!.p.z + 0.5 };
  }
  return out;
}

/**
 * Visit order for a scan (Track AN follow-up): nearest neighbour from `start` on a cost that prefers the
 * same room: straight-line distance, plus 3 per block of height difference (another floor), plus 12 when
 * the path lengths from home differ by more than 8 blocks (another room: the probe measured them). A wall
 * of stacked chests is read row by row before the bot walks across the room or out of the door.
 */
export function visitOrderBanded<T extends { p: Vec3 }>(items: readonly T[], start: Vec3, blocksFromHome: (it: T) => number): T[] {
  const left = [...items];
  const out: T[] = [];
  let at = start;
  let atBlocks: number | undefined;
  while (left.length > 0) {
    let best = 0;
    let bd = Infinity;
    left.forEach((it, i) => {
      const dy = Math.abs(it.p.y - at.y);
      const band = atBlocks === undefined ? 0 : Math.abs(blocksFromHome(it) - atBlocks) > 8 ? 12 : 0;
      const d = Math.hypot(it.p.x + 0.5 - at.x, it.p.z + 0.5 - at.z) + 3 * dy + band;
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    const [next] = left.splice(best, 1);
    out.push(next!);
    at = { x: next!.p.x + 0.5, y: next!.p.y, z: next!.p.z + 0.5 };
    atBlocks = blocksFromHome(next!);
  }
  return out;
}
