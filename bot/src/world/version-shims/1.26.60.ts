// Version shim for Bedrock 1.26.60 (protocol 2225; BDS 1.26.65.1 speaks the same protocol and sends the same
// block palette, docs/versions.md "1.26.65"). minecraft-data ships 1.26.60 since 3.118.0 (from 2026-10-28 to
// 2026-11-16 it came from a patch of 3.117.0; tools/bump-version, PLAN.md task 1.5).
//
// Same as 1.26.51 for everything the world model touches. `node tools/bump-version/schema-diff.mjs
// 1.26.51 1.26.60 --deps self` (2026-10-28): level_chunk gained a trailing `client_biome_update`
// bool, start_game gained `editor_level_migration_version`, add_player / add_entity gained an
// optional `passenger_of_block`; subchunk, subchunk_request, update_block, item_registry, respawn
// and player_auth_input are unchanged.
//
// Block states (wave 8, Track AC, decision 0024): the runtime-id table comes from the BDS 1.26.60.6 palette
// dump in bot/data/block-palette/1.26.60.json (palette.ts). Since decision 0094 (minecraft-data 3.119.0) the
// block data is 1.26.60's own and holds every state of that dump (23 941 of its 23 960), so no state needs a
// borrowed shape on this version.
import type { VersionShim } from './index.ts';
import { shim_1_26_51 } from './1.26.51.ts';

export const shim_1_26_60: VersionShim = {
  ...shim_1_26_51,
  gameVersions: ['1.26.60'],
  paletteFromData: undefined,
  blockPalette: '1.26.60',
};
