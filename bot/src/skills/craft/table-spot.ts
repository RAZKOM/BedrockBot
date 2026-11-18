// Where a crafting table may be set down next to the bot (Track E1, docs/early-game.md "Craft chains").
// The crafter used the shulker box's spot rule (skills/container/stash.ts boxSpots), whose lid needs an empty cell over
// the box: under a tree's leaves, or with leaf litter, flowers or a grass tuft that is not in the placer's replaceable
// list round the feet, no cell passed, and `!craft wooden_pickaxe` ended with "no free cell next to the bot for a
// crafting table" (measured on a fresh world: a bot by the trees it had just felled, every ring cell leaf litter or
// leaves, the cells farther out over leaf litter one lower). A table has no lid. The rule here:
//   - the ring cells round the feet (the box's 12, nearest first), at the feet's height;
//   - the cell empty, or a cover with no collision box that a hand clears at once (leaf litter, a flower, a tuft:
//     dug first, `cover` lists them), never a liquid, never a container or anything a click opens;
//   - a full solid top under it that is not a built block (the caller's `built` rule) and no container;
//   - not in the body.
import type { BlockInfo, Vec3 } from '../../world/types.ts';
import { isInteractive, REPLACEABLE } from '../place/place.ts';

const RING: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
  [2, 0],
  [-2, 0],
  [0, 2],
  [0, -2],
];

export interface TableSpot {
  p: Vec3;
  /** A cover to dig before placing (leaf litter, a flower), else undefined. */
  cover?: string;
}

const liquid = (n: string): boolean => n.includes('water') || n.includes('lava');

/** Empty for a placement: air or the placer's replaceable plants. */
function free(b: BlockInfo): boolean {
  return b.name !== 'unknown' && b.boxes.length === 0 && (b.name === 'air' || REPLACEABLE.has(b.name)) && !liquid(b.name);
}

/** A cover a hand clears at once: no collision box, not liquid, not replaceable already, nothing a click opens. */
export function clearableCover(b: BlockInfo | undefined): boolean {
  if (!b || b.name === 'unknown' || b.boxes.length > 0 || liquid(b.name) || isInteractive(b.name)) return false;
  if (b.name === 'air' || REPLACEABLE.has(b.name)) return false;
  return /litter|petals|flower|tulip|poppy|dandelion|orchid|allium|azure_bluet|daisy|cornflower|lily_of_the_valley|bush|grass|fern|sapling|mushroom|torchflower|wildflowers|moss_carpet|leaf/.test(b.name) && !b.name.endsWith('_leaves');
}

function fullTop(b: BlockInfo | undefined): boolean {
  if (!b || !b.solid || isInteractive(b.name) || b.name.endsWith('shulker_box')) return false;
  return b.boxes.some((x) => x[0] <= 0 && x[2] <= 0 && x[3] >= 1 && x[5] >= 1 && x[4] >= 1);
}

/** Cells next to the feet a crafting table may go, free ones first, then those under a cover (nearest first in each). */
export function tableSpots(blockAt: (p: Vec3) => BlockInfo | undefined, feet: Vec3, built: (name: string) => boolean = () => false): TableSpot[] {
  const f = { x: Math.floor(feet.x), y: Math.floor(feet.y + 1e-6), z: Math.floor(feet.z) };
  const out: { s: TableSpot; d: number }[] = [];
  for (const [dx, dz] of RING) {
    const p = { x: f.x + dx, y: f.y, z: f.z + dz };
    const here = blockAt(p);
    if (!here) continue;
    const isFree = free(here);
    if (!isFree && !clearableCover(here)) continue;
    const below = blockAt({ ...p, y: p.y - 1 });
    if (!fullTop(below) || built(below!.name)) continue;
    if (feet.x + 0.3 > p.x && feet.x - 0.3 < p.x + 1 && feet.z + 0.3 > p.z && feet.z - 0.3 < p.z + 1) continue;
    const d = Math.hypot(p.x + 0.5 - feet.x, p.z + 0.5 - feet.z) + (isFree ? 0 : 10);
    out.push({ s: isFree ? { p } : { p, cover: here.name }, d });
  }
  return out.sort((a, b) => a.d - b.d).map((o) => o.s);
}
