// The one minecraft-data block and item table the bot reads (decision 0094). Hardness, collision shapes,
// materials and harvest tools (data/mining.ts, skills/terrain/shapes.ts), stack sizes (skills/container/chest.ts)
// and display names (skills/home/search.ts) all come from this key, and the world registry numbers block states by
// its blockStates. A state id therefore means the same block state in every module of a process, whatever game
// version the connection speaks: each version's own block states come from its BDS palette dump
// (world/version-shims/palette.ts), and the states this table lacks get process-wide ids above it
// (world/registry.ts).
//
// minecraft-data 3.119.0 (2026-11-16) regenerated the bedrock block and item data: bedrock_1.26.60 has its own
// tables (1480 blocks, 23 960 states, 2080 items; materials from bedrock/1.26.51). Before that every 1.26.x key
// pointed at bedrock/1.26.30's (1356 blocks, 16 913 states, 1933 items). test/unit/world/data-pin.test.ts pins the
// tables this key resolves to: a dependency bump that changes them fails the suite until it is measured.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** minecraft-data version key of the block and item tables. */
export const BLOCK_DATA_KEY = 'bedrock_1.26.60';
/** The minecraft-data data folder those tables come from (`bedrock/<this>/blocks.json`), for logs and docs. */
export const BLOCK_DATA_VERSION = '1.26.60';

/**
 * Hardness the bot keeps whatever the block data says, each for a reason of the bot's own (decision 0094); every
 * reader of block hardness (data/mining.ts, world/registry.ts) goes through `hardnessOf`.
 * - air: 3.119.0 gives -1 (unbreakable), 3.118.0 gave 0. Air is nothing to break: a build plan that fills air would
 *   skip every cell as `unbreakable`.
 * - unknown: 3.119.0 gives 0 (instant), 3.118.0 gave -1. The bot names every block it cannot resolve `unknown`
 *   (registry.unknownInfo, -1 as well) and must never plan to dig one as if it broke at once.
 */
export const HARDNESS_FIXES: Readonly<Record<string, number>> = Object.freeze({ air: 0, unknown: -1 });

/** A block's hardness: HARDNESS_FIXES first, else the block data's value (null or missing = -1, unbreakable). */
export function hardnessOf(name: string, dataHardness: number | null | undefined): number {
  return HARDNESS_FIXES[name] ?? dataHardness ?? -1;
}

/**
 * Stack sizes of items newer than the block data, measured on BDS (`truth:itemmax`, e2e data-truth): the items of
 * BDS 1.26.70.24 (2026-11-16) that bedrock_1.26.60 lacks and that do not stack to the default 64. An item the block
 * data has keeps the data's value; drop an entry when the block data moves to a version that has it.
 */
export const NEWER_ITEM_STACKS: Readonly<Record<string, number>> = Object.freeze({ ice_ball: 16, music_disc_flurry: 1 });

let md: unknown;

/** minecraft-data's object for BLOCK_DATA_KEY (cached; the same object minecraft-data hands every caller). */
export function blockData<T>(): T {
  md ??= (require('minecraft-data') as (v: string) => unknown)(BLOCK_DATA_KEY);
  if (!md) throw new Error(`minecraft-data has no ${BLOCK_DATA_KEY}`);
  return md as T;
}
