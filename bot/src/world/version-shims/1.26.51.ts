// Version shim for Bedrock 1.26.51 (protocol 2193), minecraft-data 3.117.0 to 3.119.0, prismarine-registry 1.12.0.
// Everything version-specific the world model needs lives in a shim, so an upstream fix (or a fork
// swap) touches one file (PLAN.md section 2, change 2).
//
// Known gaps for this version (PLAN.md facts 3a to 3d):
// - No BDS palette dump: the server's block states are minecraft-data 3.119.0's own 1.26.51 states
//   (`paletteFromData`, 22 091 states; up to 3.118.0 the 1.26.51 key pointed at the 1.26.30 data). States the
//   bot's block data (1.26.60, data/blockData.ts) lacks borrow their shape and hardness (registry.ts).
// - Item states arrive in a separate `item_registry` packet after `start_game`; prismarine-registry's
//   handleStartGame wants them inside start_game.
// - prismarine-chunk 1.41.0 has no 1.26 table entry; the world model decodes subchunks itself
//   (subchunk.ts), cross-checked against prismarine-chunk's 1.18 decoder in the unit tests.
// - BDS sends level_chunk with sub_chunk_count 0 plus highest_subchunk_count; the client requests
//   the subchunks with subchunk_request (origin y = lowest subchunk index of the dimension).
import type { ItemRegistry, ItemStateEntry, StartGame } from '../packets.ts';
import type { VersionShim } from './index.ts';

export const shim_1_26_51: VersionShim = {
  gameVersions: ['1.26.51'],
  paletteFromData: 'bedrock_1.26.51',
  itemStates(startGame: StartGame, itemRegistry: ItemRegistry | undefined): ItemStateEntry[] | undefined {
    if (itemRegistry) return itemRegistry.itemstates;
    if (Array.isArray(startGame.itemstates) && startGame.itemstates.length > 0) return startGame.itemstates;
    return undefined;
  },
  dimensions: {
    0: { minY: -64, height: 384 }, // overworld: subchunk indices -4..19
    1: { minY: 0, height: 128 }, // nether
    2: { minY: 0, height: 256 }, // the end
  },
  maxSubChunkVersion: 9,
};
