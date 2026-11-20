// The shell's blocks (Track E7, docs/early-game.md "The shell's blocks", ADR 0104). The night shell (tasks/night-shell.ts)
// walls the bot in with throwaway blocks, 10 on open ground (the 9 cells and the roof's support), and with fewer it stands
// in the open. A death drops every block: on five fresh worlds the shell had nothing to build with in 5 nights of 10.
//
// What keeps the reserve (`shellBlocks`): the obtain job before dusk, after a death it goes on from and at its end, and
// the blocks chore by day when nothing else runs (tasks/shell-refill.ts: after a respawn, a morning after a death in the
// night), dig the shortfall out of the ground near the bot (refillBlocks): dirt kinds by hand (a dirt block each), stone
// kinds with a pickaxe that harvests them (cobblestone, cobbled deepslate, sandstone, ...). Inside the base nothing is
// dug: the bot walks out of it first (leaveBase). The rules for a cell (refillCells):
//   - its top is open (air over it), from one cell over the feet's level to three under it (the bot may stand in the
//     hole of the block it dug last), and it lies on a surface: at least 3 of the 4 cells beside the one over it are
//     open, so a hole's floor is never dug (every hole stays one deep and the walk steps out of it);
//   - never under or next to the feet (Chebyshev 1: the shell's own cells and their floor), never the base (`allowed`: the
//     protect radius round home, built blocks) and never next to a liquid (a dug cell lets water or lava in);
//   - nearest first, the ground under standing height first.
import type { BlockInfo, ItemStack, Vec3 } from '../../world/types.ts';
import { DIG_IN_BLOCKS, SEAL_CELLS, sealItems } from './seal.ts';

/** The night shell's own count on open ground: its 9 cells and the roof's support. */
export const SHELL_BLOCKS = SEAL_CELLS + 1;
/** Cells within this many blocks (horizontally) of the bot are looked at. */
export const REFILL_RADIUS = 10;
/** Dug cells at most a refill (twice the shortfall: a drop can be lost, a cell can fail). */
export const REFILL_TRIES = 2;
/** Natural stone kinds a pickaxe digs into a shell block (never cobblestone or another kind not listed: where cobblestone lies, someone built). */
export const REFILL_STONE: readonly string[] = ['stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'sandstone', 'red_sandstone', 'netherrack'];

const bare = (n: string | undefined): string => (n ?? '').replace(/^minecraft:/, '');
const LIQUID = /water|lava/;
/** Nothing over the cell that would make the hole a trap or open a roof: air, a plant, snow. */
const OPEN_OVER = /^(air|cave_air|short_grass|tall_grass|grass|fern|large_fern|dandelion|poppy|.*_flower|.*_tulip|snow_layer|leaf_litter|.*_petals|deadbush|dead_bush)$/;

/** Throwaway blocks carried that the shell takes. */
export function shellBlocksCarried(slots: readonly (ItemStack | null | undefined)[]): number {
  return sealItems(slots).total;
}

/** Blocks the shell is short of (0 when the reserve is there). */
export function shellShort(slots: readonly (ItemStack | null | undefined)[], need = SHELL_BLOCKS): number {
  return Math.max(0, need - shellBlocksCarried(slots));
}

export interface RefillWorld {
  blockAt(p: Vec3): BlockInfo | undefined;
  /** May this cell be dug (outside the base, not a built block)? */
  allowed(p: Vec3): boolean;
  /** A carried (usable) tool harvests this block. */
  harvests(name: string): boolean;
}

/** May this cell be dug for a shell block (the file comment's rules), and is it one? */
export function refillCell(w: RefillWorld, p: Vec3, feet: Vec3): boolean {
  const fx = Math.floor(feet.x);
  const fy = Math.floor(feet.y + 1e-3);
  const fz = Math.floor(feet.z);
  if (Math.max(Math.abs(p.x - fx), Math.abs(p.z - fz)) <= 1) return false;
  if (p.y > fy + 1) return false;
  const n = bare(w.blockAt(p)?.name);
  const hand = DIG_IN_BLOCKS.includes(n);
  if (!hand && !(REFILL_STONE.includes(n) && w.harvests(n))) return false;
  const over = w.blockAt({ x: p.x, y: p.y + 1, z: p.z });
  if (!over || !OPEN_OVER.test(bare(over.name))) return false;
  // on a surface, not at the bottom of a hole: at least 3 of the 4 cells beside the one over it are open (measured: with
  // the drop picked up from inside the hole, the next cell dug was the floor of the hole before, down to bedrock)
  let openBeside = 0;
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    const b = w.blockAt({ x: p.x + dx, y: p.y + 1, z: p.z + dz });
    if (b && OPEN_OVER.test(bare(b.name))) openBeside++;
  }
  if (openBeside < 3) return false;
  for (const [dx, dy, dz] of [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
    [0, -1, 0],
    [0, 1, 0],
  ] as const) {
    const b = w.blockAt({ x: p.x + dx, y: p.y + dy, z: p.z + dz });
    if (!b || LIQUID.test(bare(b.name))) return false;
  }
  return w.allowed(p);
}

/** Cells to dig for shell blocks round `feet`, nearest first (the ground at standing height first). */
export function refillCells(w: RefillWorld, feet: Vec3, max: number, radius = REFILL_RADIUS): Vec3[] {
  const fx = Math.floor(feet.x);
  const fy = Math.floor(feet.y + 1e-3);
  const fz = Math.floor(feet.z);
  const out: { p: Vec3; score: number }[] = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      // the top block of the column near the feet: the first cell from fy + 1 down (to fy - 3) with an open cell over
      // it (fy and fy + 1: the bot stands in a hole it dug for the last block, or at the foot of a step up)
      for (let dy = 1; dy >= -3; dy--) {
        const p = { x: fx + dx, y: fy + dy, z: fz + dz };
        if (!refillCell(w, p, feet)) continue;
        out.push({ p, score: Math.hypot(dx, dz) + 2 * Math.abs(dy + 1) });
        break;
      }
    }
  }
  return out
    .sort((a, b) => a.score - b.score)
    .slice(0, max)
    .map((c) => c.p);
}

export interface RefillDeps extends RefillWorld {
  position(): Vec3;
  slots(): readonly (ItemStack | null | undefined)[];
  /** Walk within reach of a cell. */
  goto(p: Vec3, r: number): Promise<{ ok: boolean; reason?: string }>;
  dig(p: Vec3): Promise<{ ok: boolean; reason?: string }>;
  /** Pick up the drops near a cell. */
  collect(at: Vec3): Promise<unknown>;
  /**
   * No cell near may be dug and the bot stands inside the base: walk out of it (tasks/shell-refill.ts). False: not inside
   * a base, or no way out.
   */
  leaveBase?(): Promise<boolean>;
}

export interface RefillResult {
  /** Shell blocks carried before and after. */
  before: number;
  after: number;
  dug: number;
  /** Why it ended short (no cell, a walk or a dig failed, cancelled). */
  reason?: string;
  /** The bot walked out of the base first. */
  left?: boolean;
}

/**
 * Dig shell blocks until `need` are carried (REFILL_TRIES times the shortfall in cells at most): the nearest allowed cell,
 * walked to within 3.5 when farther than 4, dug, its drop picked up. With no cell near and the bot inside the base it
 * walks out of the base once and looks again. Safe to run again (it counts what is carried).
 */
export async function refillBlocks(d: RefillDeps, need: number, cancelled: () => boolean): Promise<RefillResult> {
  const before = shellBlocksCarried(d.slots());
  let dug = 0;
  let tries = Math.max(0, need - before) * REFILL_TRIES;
  let left = false;
  const skip = new Set<string>();
  const end = (reason?: string): RefillResult => ({ before, after: shellBlocksCarried(d.slots()), dug, ...(reason ? { reason } : {}), ...(left ? { left } : {}) });
  while (shellBlocksCarried(d.slots()) < need && tries > 0) {
    if (cancelled()) return end('cancelled');
    const me = d.position();
    const cell = refillCells({ ...d, allowed: (p) => !skip.has(`${p.x},${p.y},${p.z}`) && d.allowed(p) }, me, 1)[0];
    if (!cell) {
      if (!left && d.leaveBase && (await d.leaveBase())) {
        left = true;
        continue;
      }
      return end(cancelled() ? 'cancelled' : `no ground to dig within ${REFILL_RADIUS}`);
    }
    tries--;
    skip.add(`${cell.x},${cell.y},${cell.z}`);
    const c = { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 };
    if (Math.hypot(c.x - me.x, c.y - (me.y + 1.6), c.z - me.z) > 4) {
      const w = await d.goto(c, 3.5);
      if (cancelled()) return end('cancelled');
      if (!w.ok) continue;
    }
    const r = await d.dig(cell);
    if (cancelled()) return end('cancelled');
    if (!r.ok) continue;
    dug++;
    await d.collect(c);
  }
  return end(shellBlocksCarried(d.slots()) < need ? 'tries used up' : undefined);
}
