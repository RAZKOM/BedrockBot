// Bedrock 1.26.70 (protocol 2259, BDS 1.26.70.24 preview) derived from minecraft-data's 1.26.60 (protocol 2225).
// minecraft-data has no 1.26.70 yet (2026-11-16). Sources, compared field by field:
// - Mojang/bedrock-protocol-docs, tag v1.26.70-preview.24 (88e783ac, 2026-11-10, x-protocol-version 2259)
//   against tag v1.26.65 (b0c990c8, 2225), and the developer notes of the previews;
// - gophertunnel branch feature/26.70 (2250) plus open PR #554 (2259, 2026-11-14).
// CloudburstMC/Protocol and PrismarineJS had nothing for 2259 on that date. Every edit below is in both sources
// unless its comment says otherwise. releaseType 'beta': the data is a preview's; at the release, minecraft-data's
// own 1.26.70 replaces it (playbook "A preview's protocol").
//
// Choices where the sources differ or say nothing:
// - Data store variant indices (DataStoreChangeEntry.change_type, DataStoreValue.type): unsigned varints, as both
//   gophertunnel and CloudburstMC read them (minecraft-data's 1.26.60 has lu32; that table is left as it is).
// - MusicPlaybackState: a string (Mojang's docs reference the enum without Enum-as-Value, which they write as the
//   name, as minecraft-data does for AudioContentPlaybackType); gophertunnel PR #554 reads a u8. Unverified.
// - ContainerSlotType from 64 on: Mojang's numbering (recipe_food 64 ... reserved 67 to 70, virtual_container 71),
//   which gophertunnel and CloudburstMC share; minecraft-data's 1.26.60 has an extra `registry` at 64 that shifts
//   them by one. The bot uses no slot type above 63.
// - SoundType (LevelSoundEvent) renumbering after 614 is not applied: no packet references the type.
// Not in the docs: the new actor flag for hidden armour (metadata flags are a bit field: parsing is unaffected), the
// block palette (scaffolding `bottom`, repeater `locked`, disc_press, brittle ice: bot/data/block-palette/1.26.70.json).
const opt = (type) => ['option', type]
const str = 'string'

export default {
  version: '1.26.70',
  protocol: 2259,
  base: '1.26.60',
  releaseType: 'beta',
  edits: [
    {
      name: 'text: translation, popup and jukebox_popup end with a queue bool',
      apply (d) {
        const sw = d.switchOf(d.fields('packet_text'), undefined, 'packet_text')
        for (const arm of ['translation', 'popup', 'jukebox_popup']) d.appendAfterLast(d.fields(sw.fields[arm], `packet_text ${arm}`), 'parameters', [{ name: 'queue', type: 'bool' }], `packet_text ${arm}`)
      }
    },
    {
      name: 'command_output: each output entry ends with raw_message?',
      apply (d) {
        const out = d.field(d.fields('packet_command_output'), 'output')
        d.appendAfterLast(d.fields(out.type[1].type, 'command_output output[]'), 'parameters', [{ name: 'raw_message', type: opt(str) }], 'command_output output[]')
      }
    },
    {
      name: 'command_block_update: last_output_is_raw_message',
      apply (d) { d.appendAfterLast(d.fields('packet_command_block_update'), 'execute_on_first_tick', [{ name: 'last_output_is_raw_message', type: 'bool' }], 'command_block_update') }
    },
    {
      name: 'transfer: server_transfer_settings? (TransferUIOptions)',
      apply (d) {
        d.defineType('TransferUIOptions', ['container', [
          { name: 'title_text', type: opt(str) },
          { name: 'body_text', type: opt(str) },
          { name: 'title_visible', type: opt('bool') },
          { name: 'body_visible', type: opt('bool') },
          { name: 'cancel_button_text', type: opt(str) },
          { name: 'cancel_button_visible', type: opt('bool') },
          { name: 'cancel_button_delay_seconds', type: opt('lf32') }
        ]])
        d.appendAfterLast(d.fields('packet_transfer'), 'gatherings_configuration', [{ name: 'server_transfer_settings', type: opt('TransferUIOptions') }], 'transfer')
      }
    },
    {
      name: 'play_sound and clientbound_play_audio_content: start_delay_seconds?, attach_options?',
      apply (d) {
        d.defineType('SoundAttachOptions', ['container', [{ name: 'entity_runtime_id', type: 'varint64' }]])
        for (const p of ['packet_play_sound', 'packet_clientbound_play_audio_content']) {
          d.appendAfterLast(d.fields(p), 'playback_position_seconds', [{ name: 'start_delay_seconds', type: opt('lf32') }, { name: 'attach_options', type: opt('SoundAttachOptions') }], p)
        }
      }
    },
    {
      name: 'structure_block_update: keep_structure_void',
      apply (d) { d.appendAfterLast(d.fields('packet_structure_block_update'), 'water_logged', [{ name: 'keep_structure_void', type: 'bool' }], 'structure_block_update') }
    },
    {
      name: 'resource_pack_stack: has_editor_packs bool -> editor_pack_types u8 (bits: 1 core, 2 annotation)',
      apply (d) { d.replaceField(d.fields('packet_resource_pack_stack'), 'has_editor_packs', 'bool', { name: 'editor_pack_types', type: 'u8' }, 'resource_pack_stack') }
    },
    {
      name: 'network_settings: sctp_recovery_profile u8 (required; 2259 only)',
      apply (d) {
        d.appendAfterLast(d.fields('packet_network_settings'), 'client_throttle_scalar', [{ name: 'sctp_recovery_profile', type: ['mapper', { type: 'u8', mappings: { 0: 'default', 1: 'fast', 2: 'balanced' } }] }], 'network_settings')
      }
    },
    {
      name: 'start_game server_join_info: managed_chat_info? (ManagedChatJoinInfo)',
      apply (d) {
        d.defineType('ManagedChatJoinInfo', ['container', [{ name: 'enabled', type: 'bool' }]])
        d.appendAfterLast(d.fields('ServerJoinInformation'), 'presence_info', [{ name: 'managed_chat_info', type: opt('ManagedChatJoinInfo') }], 'ServerJoinInformation')
      }
    },
    {
      name: 'PassengerOfBlockData: block_type lu64 (2250), pack_uuid (2259)',
      apply (d) { d.appendAfterLast(d.fields('PassengerOfBlockData'), 'emote_type', [{ name: 'block_type', type: 'lu64' }, { name: 'pack_uuid', type: 'uuid' }], 'PassengerOfBlockData') }
    },
    {
      name: 'data store: one variable name, a primitive value (DataStoreValue) and one update count',
      apply (d) {
        const value = ['container', [
          { name: 'type', type: ['mapper', { type: 'varint', mappings: { 0: 'double', 1: 'bool', 2: 'string' } }] },
          { name: 'value', type: ['switch', { compareTo: 'type', fields: { double: 'lf64', bool: 'bool', string: 'string' } }] }
        ]]
        d.defineType('DataStoreValue', value)
        const entry = d.type('DataStoreChangeEntry')
        d.field(d.fields(entry), 'change_type', 'DataStoreChangeEntry')
        d.redefineType('DataStoreChangeEntry', ['container', [
          { name: 'change_type', type: ['mapper', { type: 'varint', mappings: { 0: 'update', 1: 'change', 2: 'removal' } }] },
          {
            anon: true,
            type: ['switch', {
              compareTo: 'change_type',
              fields: {
                update: ['container', [{ name: 'variable_name', type: str }, { name: 'value', type: 'DataStoreValue' }, { name: 'update_count', type: 'lu32' }]],
                change: ['container', [{ name: 'variable_name', type: str }, { name: 'update_count', type: 'lu32' }, { name: 'value', type: 'DataStoreValue' }]],
                removal: ['container', [{ name: 'variable_name', type: str }]]
              }
            }]
          }
        ]])
        const sb = d.fields('packet_serverbound_data_store')
        d.field(sb, 'path_update_count', 'serverbound_data_store')
        d.redefineType('packet_serverbound_data_store', ['container', [{ name: 'variable_name', type: str }, { name: 'value', type: 'DataStoreValue' }, { name: 'update_count', type: 'lu32' }]])
      }
    },
    {
      name: 'data store: the property value types are gone',
      apply (d) {
        // DataStoreMapEntry and DataStorePropertyValue reference each other: drop both together
        const users = Object.keys(d.types).filter((k) => !['DataStoreMapEntry', 'DataStorePropertyValue'].includes(k) && /"DataStore(MapEntry|PropertyValue)"/.test(JSON.stringify(d.types[k])))
        if (users.length) throw new Error(`still used by ${users.join(', ')}`)
        delete d.types.DataStoreMapEntry
        delete d.types.DataStorePropertyValue
      }
    },
    {
      name: 'AttributeData: type 3 string (string_value, string_operation?)',
      apply (d) {
        const fields = d.fields('AttributeData')
        d.addMapping(d.mappings(d.field(fields, 'type', 'AttributeData')), '3', 'string', 'AttributeData type')
        const sw = d.switchOf(fields, undefined, 'AttributeData')
        if (sw.fields.string) throw new Error('AttributeData has a string arm already')
        sw.fields.string = ['container', [{ name: 'string_value', type: str }, { name: 'string_operation', type: opt('li32') }]]
      }
    },
    {
      name: 'ItemStackRequest: craft_reserved -> craft_disc_press (track_sound_event_id, times_crafted)',
      apply (d) {
        const isr = JSON.stringify(d.type('ItemStackRequest'))
        if (!isr.includes('"craft_reserved"')) throw new Error('no craft_reserved in ItemStackRequest')
        const before = '"craft_reserved":["container",[{"name":"reserved_id","type":"string"},{"name":"times_crafted","type":"u8"}]]'
        if (!isr.includes(before)) throw new Error('craft_reserved arm differs from what the edit expects')
        const out = isr.replace(before, '"craft_disc_press":["container",[{"name":"track_sound_event_id","type":"string"},{"name":"times_crafted","type":"u8"}]]').replace(/"craft_reserved"/g, '"craft_disc_press"')
        d.types.ItemStackRequest = JSON.parse(out)
      }
    },
    {
      name: 'Action: 38 swap_offhand',
      apply (d) { d.addMapping(d.mappings(d.type('Action'), 'Action'), '38', 'swap_offhand', 'Action') }
    },
    {
      name: 'InputData: 65 internal_update -> swap_offhand',
      apply (d) { d.renameMapping(d.mappings(d.type('InputData'), 'InputData'), '65', 'internal_update', 'swap_offhand', 'InputData') }
    },
    {
      name: 'player_auth_input input_mode: 5 game_pad_and_mouse',
      apply (d) { d.addMapping(d.mappings(d.field(d.fields('packet_player_auth_input'), 'input_mode'), 'input_mode'), '5', 'game_pad_and_mouse', 'input_mode') }
    },
    {
      name: 'WindowType: 38 disc_press, 39 virtual_container',
      apply (d) {
        const m = d.mappings(d.type('WindowType'), 'WindowType')
        d.addMapping(m, '38', 'disc_press', 'WindowType')
        d.addMapping(m, '39', 'virtual_container', 'WindowType')
      }
    },
    {
      name: 'ContainerSlotType: Mojang numbering from 64, disc press slots 67 to 70, 71 virtual_container',
      apply (d) {
        const m = d.mappings(d.type('ContainerSlotType'), 'ContainerSlotType')
        const want = { 63: 'dynamic', 64: 'registry', 65: 'recipe_food', 66: 'recipe_blocks', 67: 'recipe_furnace_items', 68: 'reserved_container_a', 69: 'reserved_container_b', 70: 'reserved_container_c', 71: 'reserved_container_d' }
        for (const [k, v] of Object.entries(want)) if (m[k] !== v) throw new Error(`ContainerSlotType ${k} is ${m[k]}, expected ${v}`)
        Object.assign(m, { 64: 'recipe_food', 65: 'recipe_blocks', 66: 'recipe_furnace_items', 67: 'disc_press_block', 68: 'disc_press_dye', 69: 'disc_press_disc', 70: 'disc_press_result_preview', 71: 'virtual_container' })
      }
    },
    {
      name: 'DisconnectFailReason: 151 to 159',
      apply (d) {
        const m = d.mappings(d.type('DisconnectFailReason'), 'DisconnectFailReason')
        if (m['150'] !== 'sub_client_login_not_bound') throw new Error(`DisconnectFailReason 150 is ${m['150']}`)
        const added = ['session_runtime_error', 'session_invalid_response', 'session_network_error', 'session_service_error', 'session_service_unavailable', 'session_throttled', 'session_request_rejected', 'session_unknown_error', 'broken_data']
        added.forEach((v, i) => d.addMapping(m, String(151 + i), v, 'DisconnectFailReason'))
      }
    },
    {
      name: 'new packets 0x169 to 0x16f',
      apply (d) {
        d.defineType('SignedChat', ['container', ['key_id', 'sender_id', 'message_id', 'scan_text', 'redacted_text', 'author_name', 'signature'].map((name) => ({ name, type: str }))])
        d.defineType('ChatFormatting', ['container', ['name_prefix', 'name_postfix', 'message_prefix', 'message_postfix'].map((name) => ({ name, type: opt(str) }))])
        d.defineType('MusicPlaybackState', str)
        d.addPacket(0x169, 'chat', ['container', [{ name: 'signed_chat', type: 'SignedChat' }, { name: 'room_id', type: opt(str) }, { name: 'formatting', type: opt('ChatFormatting') }]])
        d.addPacket(0x16a, 'serverbound_request_online_music_playback', ['container', [{ name: 'request_id', type: 'lu32' }, { name: 'sound_event_name', type: str }]])
        d.addPacket(0x16b, 'clientbound_online_music_playback_response', ['container', [{ name: 'request_id', type: 'lu32' }, { name: 'state', type: 'MusicPlaybackState' }, { name: 'shared_metadata', type: str }, { name: 'playback_content', type: str }]])
        d.addPacket(0x16c, 'player_toggle_armor_visibility_request', ['container', [{ name: 'hide_armor', type: 'bool' }]])
        d.addPacket(0x16d, 'clientbound_music_playback_failure', ['container', [{ name: 'failures', type: ['array', { countType: 'varint', type: ['container', [{ name: 'state', type: 'MusicPlaybackState' }, { name: 'description', type: str }]] }] }]])
        d.addPacket(0x16e, 'virtual_container_open', ['container', [{ name: 'window_id', type: 'WindowID' }, { name: 'session_id', type: 'varint64' }, { name: 'title', type: str }, { name: 'slots', type: ['array', { countType: 'varint', type: 'ItemV4' }] }]])
        d.addPacket(0x16f, 'virtual_container_close', ['container', [
          { name: 'session_id', type: 'varint64' },
          { name: 'kind', type: ['mapper', { type: 'u8', mappings: { 0: 'request', 1: 'closed', 2: 'confirmed' } }] },
          { name: 'cause', type: ['mapper', { type: 'u8', mappings: { 0: 'unknown', 1: 'user_closed', 2: 'server_requested', 3: 'user_busy', 4: 'client_not_ready', 5: 'invalid_contents', 6: 'ui_creation_failed', 7: 'ui_cancelled' } }] }
        ]])
      }
    },
    {
      name: 'removed packets: add_volume_entity (0xa6), remove_volume_entity (0xa7)',
      apply (d) {
        d.removePacket(0xa6, 'add_volume_entity')
        d.removePacket(0xa7, 'remove_volume_entity')
      }
    }
  ]
}
