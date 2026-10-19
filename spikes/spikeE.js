// Spike E: can bedrock-protocol 3.60.1 + minecraft-data master (1.26.60 protocol.json) join BDS 1.26.60.6? Throwaway.
const bedrock = require('bedrock-protocol'); const { exec } = require('child_process')
const cmd = (s) => exec(`docker exec bds60 send-command ${s}`, () => {})
const registry = require('prismarine-registry')('bedrock_1.26.60')
const Chunk = require('prismarine-chunk/src/bedrock/1.18/chunk')(registry)
const column = new Chunk({ x: 0, z: 0 }); let itemstates = []
const client = bedrock.createClient({ host: '127.0.0.1', port: 19134, username: 'SpikeBot', offline: true, version: '1.26.60' })
const EYE = 1.62; let rid, tick = 0n, feet = null, n = 0, moving = false
const log = (...a) => console.log(`[t=${tick}]`, ...a)
client.on('item_registry', p => { itemstates = p.itemstates })
client.on('start_game', p => { rid = p.runtime_entity_id; try { registry.handleStartGame({ ...p, itemstates }); log('start_game ok; blocks by runtime id', Object.keys(registry.blocksByRuntimeId).length) } catch (e) { log('registry error', e.message) } })
client.on('respawn', p => { if (p.state === 1) { feet = { x: p.position.x, y: p.position.y - EYE, z: p.position.z }; client.queue('respawn', { position: p.position, state: 2, runtime_entity_id: rid }) } })
client.on('play_status', p => { log('play_status', p.status); if (p.status === 'player_spawn') { client.queue('serverbound_loading_screen', { type: 1 }); client.queue('serverbound_loading_screen', { type: 2 }) } })
client.on('text', p => log('text', p.type, p.message.slice(0, 120)))
client.on('correct_player_move_prediction', p => log('CORRECTION', JSON.stringify(p.position)))
client.on('subchunk', async p => { for (const e of p.entries) if (e.result === 'success') await column.networkDecodeSubChunkNoCache(p.origin.y + e.dy, e.payload); for (const [x, y, z] of [[0, -64, 0], [0, -61, 0], [0, -60, 0]]) log(`wire block ${x} ${y} ${z} = ${column.getBlock({ x, y, z })?.name}`) })
client.on('kick', p => log('KICK', JSON.stringify(p))); client.on('disconnect', p => log('DISCONNECT', JSON.stringify(p))); client.on('error', e => log('ERROR', e.message))
client.on('close', () => { log('close'); process.exit(0) })
client.on('spawn', () => {
  log('SPAWN on 1.26.60; feet', JSON.stringify(feet))
  setInterval(() => {
    n++; tick++
    if (n === 20) client.queue('subchunk_request', { dimension: 0, origin: { x: 0, y: -4, z: 0 }, requests: [{ x: 0, y: 0, z: 0 }] })
    if (n === 40) { moving = true; log('walk +z') } if (n === 46) { moving = false; log('stop; local z', feet.z.toFixed(3)) }
    if (n === 80) cmd('testforblock 0 -61 0 grass_block'), cmd('say hello60')
    if (n === 120) { cmd('tp SpikeBot ~ ~ ~'); } // forces a move_player with the server's position
    if (n === 160) { log('final local feet', JSON.stringify(feet)); client.disconnect(); setTimeout(() => process.exit(0), 300) }
    if (moving) feet.z += 0.2
    const mv = moving ? { x: 0, z: 1 } : { x: 0, z: 0 }; const flags = ['vertical_collision']; if (moving) flags.push('up')
    client.queue('player_auth_input', { pitch: 0, yaw: 0, position: { x: feet.x, y: feet.y + EYE, z: feet.z }, move_vector: mv, head_yaw: 0, input_data: flags, input_mode: 'mouse', play_mode: 'normal', interaction_model: 'crosshair', interact_rotation: { x: 0, z: 0 }, tick, delta: { x: 0, y: 0, z: moving ? 0.2 : 0 }, analogue_move_vector: mv, camera_orientation: { x: 0, y: 0, z: 1 }, raw_move_vector: mv })
  }, 50)
})
client.on('move_player', p => { if (String(p.runtime_id) === String(rid)) log('move_player self', p.mode, JSON.stringify(p.position)) })
