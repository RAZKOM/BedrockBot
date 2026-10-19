// Spike A: connect to local BDS (offline mode), print chat + own position. Throwaway code.
const bedrock = require('bedrock-protocol')
const seen = {}
const client = bedrock.createClient({ host: '127.0.0.1', port: 19132, username: 'SpikeBot', offline: true, version: '1.26.51' })
let myRid = null, pos = null
client.on('packet', p => { const n = p.data?.name; if (n) seen[n] = (seen[n] || 0) + 1 })
client.on('start_game', p => {
  myRid = p.runtime_entity_id; pos = p.player_position
  console.log('[start_game] runtime_id', String(myRid), 'pos', pos, 'movement', JSON.stringify(p.movement_settings ?? p.movement_authority ?? '?'), 'hashes', p.block_network_ids_are_hashes)
})
client.on('join', () => console.log('[join] encryption/handshake done'))
client.on('spawn', () => {
  console.log('[spawn] client spawned; pos', pos)
  client.queue('text', { type: 'chat', needs_translation: false, source_name: 'SpikeBot', xuid: '', platform_chat_id: '', filtered_message: '', message: 'hello from SpikeBot' })
})
client.on('text', p => console.log('[text]', p.type, p.source_name || '', '|', p.message))
client.on('move_player', p => { if (String(p.runtime_id) === String(myRid)) { pos = p.position; console.log('[move_player] mode', p.mode, 'pos', p.position) } })
client.on('correct_player_move_prediction', p => console.log('[correct_player_move_prediction]', JSON.stringify(p)))
client.on('kick', p => console.log('[kick]', JSON.stringify(p)))
client.on('disconnect', p => console.log('[disconnect]', JSON.stringify(p)))
client.on('error', e => console.log('[error]', e.message))
client.on('close', () => console.log('[close]'))
setTimeout(() => { console.log('[packets seen]', JSON.stringify(seen)); client.disconnect(); setTimeout(() => process.exit(0), 500) }, 20000)
