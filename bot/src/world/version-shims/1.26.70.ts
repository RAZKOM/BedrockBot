// Version shim for Bedrock 1.26.70 (protocol 2259; BDS 1.26.70.24 preview, the first build that speaks it). The
// protocol data is the bot's own: tools/bump-version/derive/1.26.70.mjs derives it from 1.26.60's by named edits
// (minecraft-data has no 1.26.70 yet; releaseType beta, docs/versions.md "1.26.70 preview").
//
// Same as 1.26.60 for everything the world model touches. `node tools/bump-version/schema-diff.mjs 1.26.60
// 1.26.70 --deps self` (2026-11-16): level_chunk, subchunk, subchunk_request, update_block,
// update_subchunk_blocks, item_registry, respawn and start_game's own fields are unchanged; start_game's
// server_join_info gained an optional managed_chat_info; add_player / add_entity's passenger_of_block gained
// block_type and pack_uuid (parsed, not read); player_auth_input's input data 65 is swap_offhand (was
// internal_update; the bot sends neither) and input_mode 5 is game_pad_and_mouse.
//
// Block states: the runtime-id table comes from the BDS 1.26.70.24 palette dump in
// bot/data/block-palette/1.26.70.json (palette.ts): 1507 types, 25 028 states against 1.26.60's 1480 and 23 941.
// 28 blocks are new (the calcite, packed ice brick and snow brick sets, brittle_ice, chiseled_soulshale),
// disc_press is gone, and scaffolding (`bottom`) and both repeaters (`locked`) gained a state. 1139 of its states
// are not in the block data (bedrock_1.26.60): they get ids above the block data's (registry.ts EXT) and the
// hardness and boxes of the closest state of the same block or of a shape donor, else a full cube of hardness -1.
import type { VersionShim } from './index.ts';
import { shim_1_26_60 } from './1.26.60.ts';

export const shim_1_26_70: VersionShim = {
  ...shim_1_26_60,
  gameVersions: ['1.26.70'],
  blockPalette: '1.26.70',
};
