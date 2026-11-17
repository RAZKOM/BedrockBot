// Version shim registry. To support a new game version, add `version-shims/<ver>.ts` exporting a
// VersionShim and list it in SHIMS (newest first). See docs/world-model.md.
import type { ItemRegistry, ItemStateEntry, StartGame } from '../packets.ts';
import { shim_1_26_51 } from './1.26.51.ts';
import { shim_1_26_60 } from './1.26.60.ts';
import { shim_1_26_70 } from './1.26.70.ts';

export interface DimensionInfo {
  /** Lowest block y. */
  minY: number;
  /** Number of block layers (multiple of 16). */
  height: number;
}

export interface VersionShim {
  /** Game versions (bedrock-protocol `version` strings) this shim serves. */
  gameVersions: readonly string[];
  /**
   * Version key of the dumped BDS block palette (`bot/data/block-palette/<key>.json`, palette.ts): the block states
   * this version's server sends (Track AC, decision 0024). The block and item tables themselves are the process-wide
   * data/blockData.ts key whatever the version (decision 0094).
   */
  blockPalette?: string;
  /**
   * Without a dump: the minecraft-data version key whose blockStates stand in for the server's states (1.26.51).
   * Neither: the block data's own states.
   */
  paletteFromData?: string;
  /**
   * Item states for prismarine-registry's handleStartGame. Returns undefined while they are not known
   * yet (1.26.x: they come in `item_registry`, after `start_game`).
   */
  itemStates(startGame: StartGame, itemRegistry: ItemRegistry | undefined): ItemStateEntry[] | undefined;
  /** Dimension id -> vertical range. */
  dimensions: Readonly<Record<number, DimensionInfo>>;
  /** Highest subchunk storage version the decoder must accept. */
  maxSubChunkVersion: number;
}

// Newest first. SHIMS[0] is also the fallback for a version no shim lists (one bedrock-protocol speaks but the world
// model was not told about: most likely newer still). The default game version is 1.26.60 (config/defaults.ts);
// 1.26.70 is the 1.26.70.24 preview's protocol 2259 (docs/versions.md), spoken when the server advertises it or
// refuses 1.26.60; 1.26.51 stays for the rollback path (BOT_VERSION=1.26.51).
export const SHIMS: readonly VersionShim[] = [shim_1_26_70, shim_1_26_60, shim_1_26_51];

/** The shim for `version`, or undefined when no shim lists it. */
export function shimFor(version: string): VersionShim | undefined {
  return SHIMS.find((s) => s.gameVersions.includes(version));
}

export function dimensionInfo(shim: VersionShim, dimension: number): DimensionInfo {
  return shim.dimensions[dimension] ?? shim.dimensions[0] ?? { minY: -64, height: 384 };
}
