// Spike C: send player_auth_input at 20 Hz, walk +z, see what the server accepts/corrects. Throwaway.
const bedrock = require('bedrock-protocol'); const { exec } = require('child_process')
const cmd = (s) => exec(`docker exec bds-spike send-command ${s}`, () => {})
const client = bedrock.createClient({ host: '127.0.0.1', port: 19132, username: 'SpikeBot', offline: true, version: '1.26.51' })
const EYE = 1.62
let rid, tick = 0n, feet = null, timer, phase = 'wait'
const log = (...a) => console.log(`[t=${tick}]`, ...a)
client.on('start_game', p => { rid = p.runtime_entity_id; feet = { x: p.player_position.x, y: p.player_position.y - EYE, z: p.player_position.z } })
client.on('move_player', p => { if (String(p.runtime_id) === String(rid)) { log('move_player self mode', p.mode, JSON.stringify(p.position), 'onground', p.on_ground, 'tick', String(p.tick)); feet = { x: p.position.x, y: p.position.y - EYE, z: p.position.z } } })
client.on('correct_player_move_prediction', p => { log('CORRECTION', JSON.stringify({ pos: p.position, delta: p.delta, on_ground: p.on_ground, tick: String(p.tick) })); feet = { x: p.position.x, y: p.position.y - EYE, z: p.position.z } })
client.on('text', p => { if (p.type === 'json') { try { const m = JSON.parse(p.message).rawtext.map(r => r.text).join(''); if (m.includes('pos ')) log('TRUTH', m.replace('[truth] ', ''), '| local feet', JSON.stringify(feet)) } catch {} } })
client.on('respawn', p => { log('respawn state', p.state, JSON.stringify(p.position)); if (p.state === 1) { feet = { x: p.position.x, y: p.position.y - EYE, z: p.position.z }; client.queue('respawn', { position: p.position, state: 2, runtime_entity_id: rid }); log('sent respawn client_ready, feet', JSON.stringify(feet)) } })
client.on('play_status', p => { if (p.status === 'player_spawn') { client.queue('serverbound_loading_screen', { type: 1 }); client.queue('serverbound_loading_screen', { type: 2 }); log('sent loading screen acks') } })
client.on('kick', p => log('KICK', JSON.stringify(p))); client.on('disconnect', p => log('DISCONNECT', JSON.stringify(p)))
client.on('close', () => { log('close'); process.exit(0) })
function send(moving, dz) {
  tick++
  if (moving) feet.z += dz
  const flags = ['vertical_collision']; if (moving) flags.push('up')
  const mv = moving ? { x: 0, z: 1 } : { x: 0, z: 0 }
  client.queue('player_auth_input', {
    pitch: 0, yaw: 0, position: { x: feet.x, y: feet.y + EYE, z: feet.z }, move_vector: mv, head_yaw: 0,
    input_data: flags, input_mode: 'mouse', play_mode: 'normal', interaction_model: 'crosshair', interact_rotation: { x: 0, z: 0 },
    tick, delta: { x: 0, y: 0, z: moving ? dz : 0 }, analogue_move_vector: mv, camera_orientation: { x: 0, y: 0, z: 1 }, raw_move_vector: mv
  })
}
client.on('spawn', () => {
  log('spawn; start_game feet', JSON.stringify(feet))
  let n = 0
  timer = setInterval(() => {
    n++
    if (n === 1) phase = 'idle1'
    if (n === 40) { cmd('scriptevent spike:pos'); }
    if (n === 60) { phase = 'walk'; log('--- walking +z 0.2/tick for 6 ticks (with up flag) ---') }
    if (n === 66) { phase = 'idle2'; log('--- stop; local feet', JSON.stringify(feet)) }
    if (n === 100) cmd('scriptevent spike:pos')
    if (n === 120) { log('--- jump position +3 z in one tick, no input flags ---'); feet.z += 3; phase = 'idle3' }
    if (n === 160) cmd('scriptevent spike:pos')
    if (n === 180) { log('final local feet', JSON.stringify(feet)); clearInterval(timer); client.disconnect(); setTimeout(() => process.exit(0), 300) }
    send(phase === 'walk', 0.2)
  }, 50)
})
