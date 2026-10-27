// Version shim for Bedrock 1.26.60 (protocol 2225). minecraft-data 3.117.0 does not ship 1.26.60;
// it comes from patches/minecraft-data@3.117.0.patch (tools/bump-version, PLAN.md task 1.5).
//
// Same as 1.26.51 for everything the world model touches. `node tools/bump-version/schema-diff.mjs
// 1.26.51 1.26.60 --deps self` (2026-10-28): level_chunk gained a trailing `client_biome_update`
// bool, start_game gained `editor_level_migration_version`, add_player / add_entity gained an
// optional `passenger_of_block`; subchunk, subchunk_request, update_block, item_registry, respawn
// and player_auth_input are unchanged. Blocks, block states and items still point at the 1.26.30
// data upstream (PLAN.md row 3a), exactly as for 1.26.51.
//
// Block states (wave 8, Track AC, decision 0024): the runtime-id table comes from the BDS 1.26.60.6 palette
// dump in bot/data/block-palette/1.26.60.json (palette.ts); minecraft-data's 1.26.30 tables still give
// hardness and collision shapes. 1.26.61 is the same protocol: re-dump into 1.26.61.json and list it here.
import type { VersionShim } from './index.ts';
import { shim_1_26_51 } from './1.26.51.ts';

export const shim_1_26_60: VersionShim = {
  ...shim_1_26_51,
  gameVersions: ['1.26.60'],
  registryVersion: 'bedrock_1.26.60',
  blockDataVersion: '1.26.30',
  blockPalette: '1.26.60',
};
