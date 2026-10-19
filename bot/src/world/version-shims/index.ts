// Version shim registry. To support a new game version, add `version-shims/<ver>.ts` exporting a
// VersionShim and list it in SHIMS (newest first). See docs/world-model.md.
import type { ItemRegistry, ItemStateEntry, StartGame } from '../packets.ts';
import { shim_1_26_51 } from './1.26.51.ts';

export interface DimensionInfo {
  /** Lowest block y. */
  minY: number;
  /** Number of block layers (multiple of 16). */
  height: number;
}

export interface VersionShim {
  /** Game versions (bedrock-protocol `version` strings) this shim serves. */
  gameVersions: readonly string[];
  /** prismarine-registry / minecraft-data version key. */
  registryVersion: string;
  /** Which minecraft-data release the block and item tables really come from (for logs and docs). */
  blockDataVersion: string;
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

export const SHIMS: readonly VersionShim[] = [shim_1_26_51];

/** The shim for `version`, or undefined when no shim lists it. */
export function shimFor(version: string): VersionShim | undefined {
  return SHIMS.find((s) => s.gameVersions.includes(version));
}

export function dimensionInfo(shim: VersionShim, dimension: number): DimensionInfo {
  return shim.dimensions[dimension] ?? shim.dimensions[0] ?? { minY: -64, height: 384 };
}
