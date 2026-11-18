// A starter farm's plot (Track E6, docs/farming.md "A starter farm", ADR 0102): where `!farm new` tills, pure over a block
// lookup so the unit tests need no server. The rules, for any world:
//
//   size      n x n soil cells (n odd, 3 to 9) round one water cell in the middle: one water source keeps farmland moist
//             up to 4 cells away, so 9 x 9 is the largest plot one bucket waters (80 cells to plant);
//   soil      every cell at one height, a block a hoe tills (grass_block, dirt, a path) or farmland already, never a
//             built block; over it air or a plant a hand clears (grass, a flower, leaf litter: dug first, the hoe
//             refuses a cell with anything on it), and over that air or a plant again (the bot walks the field);
//   water     the middle cell: a tillable block (dug, then the bucket emptied into the hole) or water already, with a
//             full solid block under it (the water stays a source in a one-deep hole walled by the soil);
//   rim       the ring one cell out (the fence line, at the plants' height): each cell free with a full top under it
//             (a fence goes there) or a solid block already (it holds the line); a cell with no floor fails the site;
//   where     the nearest site to the anchor (home, else the bot) within FARM_SITE_RANGE, never within FARM_HOME_GAP of
//             the anchor (the home walk and the bed stay clear); inside `protectRadius` of home only when the base is
//             the bot's own (`ownBase`): no built block there but the kinds the bot sets down itself (a bed, a crafting
//             table, a furnace) and its own farm's fence; else the plot lies outside protectRadius.
import type { BlockInfo, Vec3 } from '../../world/types.ts';
import { clearableCover } from '../craft/table-spot.ts';
import { isInteractive, REPLACEABLE } from '../place/place.ts';
import { FARMLAND } from './crops.ts';

/** `!farm new` without a size. */
export const FARM_NEW_SIZE = 9;
export const FARM_NEW_MIN = 3;
/** One water source moistens farmland up to 4 cells away: 9 x 9 round it. */
export const FARM_NEW_MAX = 9;
/** How far from the anchor a plot's middle may lie (blocks, x and z). */
export const FARM_SITE_RANGE = 24;
/** No plot cell (rim included) this close to the anchor (x and z), so the walk home and the bed stay clear. */
export const FARM_HOME_GAP = 3;
/** The protected base: the plot lies this far past protectRadius when the base is not the bot's own. */
export const FARM_PROTECT_MARGIN = 2;
/** A wooden fence post or gate (`oak_fence`, `fence_gate`, `birch_fence_gate`). */
export const FENCE_RE = /_fence(_gate)?$|^fence_gate$/;
/** Built blocks deeper than this under home are no part of the base the plot keeps out of (ownBase). */
export const BASE_DEPTH = 8;

/** Blocks a hoe turns into farmland (Bedrock names; coarse and rooted dirt till to dirt, not farmland). */
export const TILLABLE: ReadonlySet<string> = new Set(['grass_block', 'grass', 'dirt', 'grass_path', 'dirt_path']);
/** Built kinds the bot sets down by home itself (a base with nothing else built near is its own). */
export const OWN_KINDS: ReadonlySet<string> = new Set(['bed', 'crafting_table', 'furnace', 'lit_furnace']);

const AIR = new Set(['air', 'cave_air', 'void_air']);
const liquid = (n: string): boolean => n.includes('water') || n.includes('lava');
export const isWater = (b: BlockInfo | undefined): boolean => !!b && (b.name === 'water' || b.name === 'flowing_water');
/** A still water source (a bucket fills from it). */
export const isWaterSource = (b: BlockInfo | undefined): boolean => isWater(b) && Number(b!.states.liquid_depth ?? 0) === 0;

/** A plant on a cell that the hand clears at once (grass, flowers, leaf litter), or nothing in the way at all. */
export function clearCell(b: BlockInfo | undefined): 'air' | 'cover' | 'blocked' {
  if (!b || b.name === 'unknown') return 'blocked';
  if (AIR.has(b.name)) return 'air';
  if (liquid(b.name) || isInteractive(b.name)) return 'blocked';
  if (b.boxes.length === 0 && (REPLACEABLE.has(b.name) || clearableCover(b))) return 'cover';
  return 'blocked';
}

function fullTop(b: BlockInfo | undefined): boolean {
  if (!b || !b.solid || liquid(b.name) || isInteractive(b.name)) return false;
  return b.boxes.some((x) => x[0] <= 0 && x[2] <= 0 && x[3] >= 1 && x[5] >= 1 && x[4] >= 1);
}

export interface PlotSite {
  /** The water cell (the middle, at the soil's height). */
  water: Vec3;
  /** The soil's height (the farmland blocks; crops grow at y + 1). */
  y: number;
  n: number;
  /** Soil blocks (without the water cell), nearest the anchor first. */
  soil: Vec3[];
  /** Plants on the soil and over it to dig first (the hoe refuses a cell under one). */
  covers: Vec3[];
  /** Fence line cells (at y + 1) that need a fence: free with a floor; solid ones hold the line already. */
  rim: Vec3[];
  /** The rim cell for the gate: the middle of the side facing the anchor. */
  gate: Vec3;
  /** Soil cells already farmland, the water cell already water (a site set up before). */
  farmland: number;
  watered: boolean;
  /** Distance of the middle from the anchor (x, z). */
  dist: number;
}

export interface SiteOptions {
  n: number;
  /** Middle within this many blocks of the anchor (x and z). Default FARM_SITE_RANGE. */
  range?: number;
  /** Built blocks (terrain/classify.ts isBuiltBlock): never tilled, never under a plant dug. */
  built?: (name: string) => boolean;
  /** Home and the radius no plot cell may enter (the owner's base); undefined: none. */
  protect?: { home: Vec3; radius: number };
  /** Soil heights tried round the anchor's feet (default 6 down to 3 up). */
  below?: number;
  above?: number;
}

export interface SiteFail {
  reason: 'no_site';
  tried: number;
  why: Record<string, number>;
}

/** The soil height of column (x, z): the highest full block with air or a plant over it, from `top` down to `bottom`. */
function surface(blockAt: (p: Vec3) => BlockInfo | undefined, x: number, z: number, top: number, bottom: number): number | undefined {
  for (let y = top; y >= bottom; y--) {
    const b = blockAt({ x, y, z });
    if (!b || b.name === 'unknown') return undefined;
    if (clearCell(b) !== 'blocked' || isWater(b)) continue;
    const over = blockAt({ x, y: y + 1, z });
    if (clearCell(over) !== 'blocked') return y;
    return undefined;
  }
  return undefined;
}

/** Check one site: the reason it fails, or the site. */
export function checkSite(blockAt: (p: Vec3) => BlockInfo | undefined, water: Vec3, n: number, o: SiteOptions, anchor: Vec3): PlotSite | string {
  const h = (n - 1) / 2;
  const built = o.built ?? (() => false);
  const y = water.y;
  const soil: Vec3[] = [];
  const covers: Vec3[] = [];
  const rim: Vec3[] = [];
  let farmland = 0;
  const gap = FARM_HOME_GAP;
  const protect = o.protect;
  for (let dx = -h - 1; dx <= h + 1; dx++) {
    for (let dz = -h - 1; dz <= h + 1; dz++) {
      const x = water.x + dx;
      const z = water.z + dz;
      if (Math.abs(x - Math.floor(anchor.x)) <= gap && Math.abs(z - Math.floor(anchor.z)) <= gap) return 'near_home';
      if (protect && Math.hypot(x + 0.5 - protect.home.x, z + 0.5 - protect.home.z) <= protect.radius + FARM_PROTECT_MARGIN) return 'protected';
      const edge = Math.abs(dx) === h + 1 || Math.abs(dz) === h + 1;
      if (edge) {
        const c = { x, y: y + 1, z };
        const b = blockAt(c);
        const k = clearCell(b);
        if (k === 'blocked') {
          // a fence or a gate holds the line too (a farm's own fence: not `solid`, a post is no full block)
          if (b && FENCE_RE.test(b.name)) continue;
          if (!b || b.name === 'unknown' || !b.solid || liquid(b.name)) return 'rim';
          continue; // a solid block holds the line
        }
        if (!fullTop(blockAt({ x, y, z }))) return 'rim';
        rim.push(c);
        if (k === 'cover') covers.push(c);
        continue;
      }
      const g = blockAt({ x, y, z });
      if (!g || g.name === 'unknown') return 'unloaded';
      const middle = dx === 0 && dz === 0;
      if (middle) {
        if (!isWater(g) && !TILLABLE.has(g.name)) return 'soil';
        if (!fullTop(blockAt({ x, y: y - 1, z }))) return 'no_floor';
      } else {
        if (built(g.name)) return 'built';
        if (g.name === FARMLAND) farmland++;
        else if (!TILLABLE.has(g.name)) return 'soil';
      }
      for (const up of [1, 2]) {
        const c = { x, y: y + up, z };
        const k = clearCell(blockAt(c));
        if (k === 'blocked') {
          // a crop on farmland set up before is no obstacle
          if (up === 1 && g.name === FARMLAND) continue;
          return 'covered';
        }
        if (k === 'cover' && !(up === 1 && g.name === FARMLAND && /wheat|carrots|potatoes|beetroot/.test(blockAt(c)?.name ?? ''))) covers.push(c);
      }
      if (!middle) soil.push({ x, y, z });
    }
  }
  const ax = Math.floor(anchor.x);
  const az = Math.floor(anchor.z);
  // the gate: the middle of the side facing the anchor
  const sx = Math.sign(ax - water.x);
  const sz = Math.sign(az - water.z);
  const gate = Math.abs(ax - water.x) >= Math.abs(az - water.z) ? { x: water.x + (sx || 1) * (h + 1), y: y + 1, z: water.z } : { x: water.x, y: y + 1, z: water.z + (sz || 1) * (h + 1) };
  const d2 = (p: Vec3): number => (p.x - ax) ** 2 + (p.z - az) ** 2;
  soil.sort((a, b) => d2(a) - d2(b));
  return { water, y, n, soil, covers, rim, gate, farmland, watered: isWater(blockAt(water)), dist: Math.hypot(water.x - ax, water.z - az) };
}

/**
 * The nearest plot site to `anchor` (its middle on a spiral out to `range`), or why none: the counts of each reason
 * the columns failed (`soil`, `covered`, `rim`, `protected`, ...).
 */
export function findPlotSite(blockAt: (p: Vec3) => BlockInfo | undefined, anchor: Vec3, o: SiteOptions): PlotSite | SiteFail {
  const n = o.n;
  const range = o.range ?? FARM_SITE_RANGE;
  const ax = Math.floor(anchor.x);
  const az = Math.floor(anchor.z);
  const ay = Math.floor(anchor.y + 1e-6);
  const top = ay + (o.above ?? 3);
  const bottom = ay - (o.below ?? 6);
  const why: Record<string, number> = {};
  let tried = 0;
  const cols: [number, number][] = [];
  for (let dx = -range; dx <= range; dx++) for (let dz = -range; dz <= range; dz++) cols.push([dx, dz]);
  cols.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]));
  for (const [dx, dz] of cols) {
    const x = ax + dx;
    const z = az + dz;
    // quick: the plot must clear the home gap
    const h = (n - 1) / 2 + 1;
    if (Math.abs(dx) <= FARM_HOME_GAP + h && Math.abs(dz) <= FARM_HOME_GAP + h) {
      why.near_home = (why.near_home ?? 0) + 1;
      continue;
    }
    // quick: a plot whose nearest cell is inside the protected base cannot fit
    if (o.protect) {
      const nx = Math.max(Math.abs(x + 0.5 - o.protect.home.x) - h, 0);
      const nz = Math.max(Math.abs(z + 0.5 - o.protect.home.z) - h, 0);
      if (Math.hypot(nx, nz) <= o.protect.radius + FARM_PROTECT_MARGIN) {
        why.protected = (why.protected ?? 0) + 1;
        continue;
      }
    }
    const y = surface(blockAt, x, z, top, bottom);
    if (y === undefined) {
      why.surface = (why.surface ?? 0) + 1;
      continue;
    }
    tried++;
    const s = checkSite(blockAt, { x, y, z }, n, o, anchor);
    if (typeof s !== 'string') return s;
    why[s] = (why[s] ?? 0) + 1;
  }
  return { reason: 'no_site', tried, why };
}

/** `soil 31, covered 12` (the commonest reasons first). */
export function siteWhyText(why: Record<string, number>): string {
  const names: Record<string, string> = { soil: 'not grass or dirt', covered: 'something over the ground', rim: 'no ground for the fence', protected: 'inside the base (protectRadius)', near_home: 'too near home', surface: 'no ground at the height', built: 'built blocks', unloaded: 'not loaded', no_floor: 'no floor under the water' };
  return Object.entries(why)
    .filter(([k]) => k !== 'near_home')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${names[k] ?? k} ${v}`)
    .join(', ');
}

/**
 * The base is the bot's own: no built block within `radius` of home but the kinds the bot sets down by home itself
 * (OWN_KINDS) and the fence of the bot's own farm (`ownFence`: cells of its plot's rim). `builtNear` lists the built
 * blocks of the loaded world near home (World.find with isBuiltBlock); an unloaded home is not the bot's own. With
 * `homeY`, a block more than BASE_DEPTH under home does not count: a farm on the surface touches no cellar, and the
 * world generates "built" kinds deep down (the raw copper and raw iron blocks of large ore veins: a fresh world had 8
 * raw_copper_block 21 to 35 under home, which pushed the plot 65 blocks out).
 */
export function ownBase(
  builtNear: readonly { p: Vec3; name: string }[],
  ownFence: (p: Vec3) => boolean = () => false,
  homeY?: number,
): { own: boolean; foreign: { p: Vec3; name: string }[] } {
  const foreign = builtNear.filter(
    (b) => (homeY === undefined || b.p.y >= homeY - BASE_DEPTH) && !OWN_KINDS.has(b.name) && !(FENCE_RE.test(b.name) && ownFence(b.p)),
  );
  return { own: foreign.length === 0, foreign };
}

/** Is `p` on the fence line of the plot round `water` (size n)? */
export function onRim(water: Vec3, n: number, p: Vec3): boolean {
  const h = (n - 1) / 2 + 1;
  const dx = Math.abs(p.x - water.x);
  const dz = Math.abs(p.z - water.z);
  return Math.abs(p.y - (water.y + 1)) <= 1 && Math.max(dx, dz) === h;
}

/** Blocks whose harvest gives wheat seeds (Bedrock: a 1 in 8 chance each). */
export const SEED_PLANTS: ReadonlySet<string> = new Set(['short_grass', 'tallgrass', 'tall_grass', 'grass']);
/** A plant that drops seeds when broken (`grass` is the plant's old name; the block is grass_block). */
export const seedPlant = (b: BlockInfo | undefined): boolean => !!b && SEED_PLANTS.has(b.name) && b.boxes.length === 0;
