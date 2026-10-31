// Tree model (PLAN.md task 4.3): from any log, the connected logs of the same kind (trunk and
// branches, 26-connected) plus the leaves around them, and the felling order (bottom up).
// Pure functions over a block lookup, so the same code runs on the world model and in unit tests.
import type { BlockInfo, Vec3 } from '../../world/types.ts';
import { isBuiltBlock } from '../terrain/classify.ts';
import { isInteractive } from '../place/place.ts';

export type BlockLookup = (p: Vec3) => BlockInfo | undefined;

/** Natural (unstripped) log or stem name -> its wood kind (`oak_log` -> `oak`); undefined otherwise. */
export function logKind(name: string | undefined): string | undefined {
  if (!name || name.startsWith('stripped_')) return undefined;
  if (name.endsWith('_log')) return name.slice(0, -4);
  if (name === 'crimson_stem' || name === 'warped_stem') return name.slice(0, -5);
  return undefined;
}

export function isLog(name: string | undefined): boolean {
  return logKind(name) !== undefined;
}

export function isLeaves(name: string | undefined): boolean {
  return !!name && (name.endsWith('_leaves') || name === 'azalea_leaves_flowered');
}

/** Blocks a tree can grow on (the base log's floor). */
export const SOIL = new Set(['dirt', 'grass_block', 'podzol', 'coarse_dirt', 'rooted_dirt', 'mycelium', 'moss_block', 'mud', 'muddy_mangrove_roots', 'dirt_with_roots', 'farmland']);

export interface Tree {
  kind: string;
  /** Every log of the tree, in felling order (bottom up; within a layer the trunk first). */
  logs: Vec3[];
  /** The lowest log closest to the trunk axis. */
  base: Vec3;
  /** Highest log y. */
  top: number;
  /** Leaves within 2 blocks of a log (any kind). */
  leaves: number;
  /** Some log touches an unloaded block (the tree may be larger than seen). */
  partial: boolean;
  /** The base stands on soil. */
  grounded: boolean;
}

export interface TreeOptions {
  /** Max logs in one tree (bigger structures are refused: houses, log piles). Default 160 (a 2 x 2 jungle or spruce trunk 30 high with its branches). */
  maxLogs?: number;
  /** Max horizontal distance of a log from the start log. Default 8. */
  radius?: number;
  /** Min leaves near the logs; 0 accepts bare log columns. Default 3. */
  minLeaves?: number;
  /** The base must stand on soil (dirt, grass ...). Default true. */
  requireSoil?: boolean;
  /** Max logs in the lowest layer (a 2 x 2 trunk is 4, two trunks side by side 2 to 8; a log wall more). Default 8. */
  maxBase?: number;
  /**
   * Logs to leave alone (the navigator's failure blacklist: logs nobody could get to). `treesFrom`
   * starts no tree from them and drops a tree whose every log is skipped.
   */
  skip?: (p: Vec3) => boolean;
}

const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;

/**
 * The tree that contains the log at `start`, or undefined (not a log, too big, too few leaves,
 * not on soil). Logs are 26-connected (branches may touch only by an edge or corner) and of the
 * same kind as the start log.
 */
/**
 * A log structure the owner built, not a tree (Realm 2026-10-31: a log cabin next to leaves was felled as a
 * 57-log spruce): a trunk wider than 2 x 2 at the bottom, a layer with more logs than any canopy has, mostly
 * sideways logs (beams), or a built block, a stripped log or a container / door touching a log.
 */
export function looksBuilt(blockAt: BlockLookup, logs: readonly Vec3[], bottom: readonly Vec3[]): boolean {
  if (bottom.length > 4) return true;
  const perLayer = new Map<number, number>();
  for (const p of logs) perLayer.set(p.y, (perLayer.get(p.y) ?? 0) + 1);
  if ([...perLayer.values()].some((n) => n > MAX_LAYER_LOGS)) return true;
  let sideways = 0;
  for (const p of logs) {
    const axis = blockAt(p)?.states.pillar_axis;
    if (axis === 'x' || axis === 'z') sideways++;
    for (const [dx, dy, dz] of FACES) {
      const n = blockAt({ x: p.x + dx, y: p.y + dy, z: p.z + dz })?.name;
      if (n && (n.startsWith('stripped_') || isBuiltBlock(n) || isInteractive(n))) return true;
    }
  }
  return sideways > 6 && sideways * 2 > logs.length;
}

/** More logs than this in one layer is a wall or a floor (a 2 x 2 trunk with its branches stays under it). */
export const MAX_LAYER_LOGS = 9;
const FACES: readonly (readonly [number, number, number])[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

export function detectTree(blockAt: BlockLookup, start: Vec3, opts: TreeOptions = {}): Tree | undefined {
  const s = { x: Math.floor(start.x), y: Math.floor(start.y), z: Math.floor(start.z) };
  const kind = logKind(blockAt(s)?.name);
  if (!kind) return undefined;
  const maxLogs = opts.maxLogs ?? 160;
  const radius = opts.radius ?? 8;
  const seen = new Set<string>([key(s)]);
  const logs: Vec3[] = [];
  const queue: Vec3[] = [s];
  let partial = false;
  while (queue.length) {
    const p = queue.shift()!;
    logs.push(p);
    if (logs.length > maxLogs) return undefined;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (!dx && !dy && !dz) continue;
          const q = { x: p.x + dx, y: p.y + dy, z: p.z + dz };
          const k = key(q);
          if (seen.has(k)) continue;
          seen.add(k);
          if (Math.max(Math.abs(q.x - s.x), Math.abs(q.z - s.z)) > radius) continue;
          const b = blockAt(q);
          if (!b) {
            partial = true;
            continue;
          }
          if (logKind(b.name) === kind) queue.push(q);
        }
      }
    }
  }
  const minY = Math.min(...logs.map((p) => p.y));
  const top = Math.max(...logs.map((p) => p.y));
  // trunk axis: the mean x/z of the lowest layer
  const bottom = logs.filter((p) => p.y === minY);
  // a wall or a pile, not a trunk: the footprint of the lowest 3 layers (a 2 x 2 trunk is 4 columns)
  const foot = new Set(logs.filter((p) => p.y < minY + 3).map((p) => `${p.x},${p.z}`));
  if (foot.size > (opts.maxBase ?? 8)) return undefined;
  // a built thing (planks, glass, doors, slabs, stairs, fences, torches, containers ... touching a log): looksBuilt
  if (looksBuilt(blockAt, logs, bottom)) return undefined;
  const ax = bottom.reduce((a, p) => a + p.x, 0) / bottom.length;
  const az = bottom.reduce((a, p) => a + p.z, 0) / bottom.length;
  const axial = (p: Vec3) => Math.hypot(p.x - ax, p.z - az);
  const ordered = [...logs].sort((a, b) => a.y - b.y || axial(a) - axial(b) || a.x - b.x || a.z - b.z);
  const base = ordered[0]!;

  // Leaves within 2 of any log.
  const leafSeen = new Set<string>();
  let leaves = 0;
  for (const p of logs) {
    for (let dy = -1; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          const q = { x: p.x + dx, y: p.y + dy, z: p.z + dz };
          const k = key(q);
          if (leafSeen.has(k)) continue;
          leafSeen.add(k);
          if (isLeaves(blockAt(q)?.name)) leaves++;
        }
      }
    }
  }
  if (leaves < (opts.minLeaves ?? 3)) return undefined;
  const grounded = bottom.some((p) => SOIL.has(blockAt({ x: p.x, y: p.y - 1, z: p.z })?.name ?? ''));
  if ((opts.requireSoil ?? true) && !grounded) return undefined;
  return { kind, logs: ordered, base, top, leaves, partial, grounded };
}

/** Logs of `tree` that are still logs of its kind in the world, in felling order. */
export function remainingLogs(blockAt: BlockLookup, tree: Pick<Tree, 'logs' | 'kind'>): Vec3[] {
  return tree.logs.filter((p) => logKind(blockAt(p)?.name) === tree.kind);
}

/**
 * Trees whose logs are within `radius` of `origin`, closest base first. `logs` are candidate log
 * positions (e.g. World.find with class 'log'); every tree is reported once.
 */
export function treesFrom(blockAt: BlockLookup, logs: readonly Vec3[], origin: Vec3, opts: TreeOptions = {}): Tree[] {
  const claimed = new Set<string>();
  const out: Tree[] = [];
  const skip = opts.skip;
  for (const l of logs) {
    if (claimed.has(key(l))) continue;
    if (skip?.(l)) continue;
    const t = detectTree(blockAt, l, opts);
    claimed.add(key(l));
    if (!t) continue;
    for (const p of t.logs) claimed.add(key(p));
    if (skip && t.logs.every((p) => skip(p))) continue;
    out.push(t);
  }
  const d = (t: Tree) => Math.hypot(t.base.x + 0.5 - origin.x, t.base.y - origin.y, t.base.z + 0.5 - origin.z);
  return out.sort((a, b) => d(a) - d(b));
}
