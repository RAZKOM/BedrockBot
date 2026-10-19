#!/usr/bin/env node
// Which protocol types changed between two Bedrock versions (triage aid for a failing verify).
//
//   node schema-diff.mjs <oldVersion> <newVersion> [--deps <dir>|self] [--show <typeName>]
//
// Reads both protocol.json files through minecraft-data in the deps dir (default: the sandbox,
// so bump the new version first). Prints packets added / removed / changed, other changed types,
// and flags the ones the bot's login, chunk and movement paths depend on.
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { DEFAULT_SANDBOX, HERE } from './lib/sandbox.mjs'

const argv = process.argv.slice(2)
const a = { _: [], deps: DEFAULT_SANDBOX }
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--deps') a.deps = argv[++i]
  else if (argv[i] === '--show') a.show = argv[++i]
  else a._.push(argv[i])
}
if (a._.length !== 2) { console.log('usage: node schema-diff.mjs <oldVersion> <newVersion> [--deps <dir>|self] [--show <typeName>]'); process.exit(1) }
const req = createRequire(join(a.deps === 'self' ? HERE : resolve(a.deps), 'package.json'))
const mcData = req('minecraft-data')
const load = (v) => { const d = mcData('bedrock_' + v); if (!d?.protocol) throw new Error(`no protocol for ${v} in minecraft-data (bump it first?)`); return d.protocol.types }
const [oldV, newV] = a._
const A = load(oldV); const B = load(newV)

if (a.show) {
  console.log(JSON.stringify({ [oldV]: A[a.show] ?? null, [newV]: B[a.show] ?? null }, null, 1))
  process.exit(0)
}

// Packets the verify/bot paths touch; a change here explains a failure at that stage.
const WATCH = {
  login: ['packet_login', 'packet_network_settings', 'packet_request_network_settings', 'packet_server_to_client_handshake', 'packet_play_status', 'packet_resource_packs_info', 'packet_resource_pack_stack', 'packet_resource_pack_client_response', 'packet_start_game', 'packet_disconnect'],
  spawn: ['packet_respawn', 'packet_serverbound_loading_screen', 'packet_set_local_player_as_initialized', 'packet_item_registry', 'packet_move_player'],
  chunk: ['packet_level_chunk', 'packet_subchunk_request', 'packet_subchunk', 'packet_update_block'],
  movement: ['packet_player_auth_input', 'packet_correct_player_move_prediction', 'InputFlag', 'PlayerAuthInputTransaction']
}
const keys = new Set([...Object.keys(A), ...Object.keys(B)])
const out = { from: oldV, to: newV, packetsAdded: [], packetsRemoved: [], packetsChanged: [], typesChanged: [], typesAdded: [], typesRemoved: [], watched: {} }
for (const k of [...keys].sort()) {
  const inA = k in A; const inB = k in B
  const changed = inA && inB && JSON.stringify(A[k]) !== JSON.stringify(B[k])
  const isPacket = k.startsWith('packet_')
  if (!inA) (isPacket ? out.packetsAdded : out.typesAdded).push(k)
  else if (!inB) (isPacket ? out.packetsRemoved : out.typesRemoved).push(k)
  else if (changed) (isPacket ? out.packetsChanged : out.typesChanged).push(k)
}
for (const [stage, list] of Object.entries(WATCH)) {
  const hit = list.filter(k => out.packetsChanged.includes(k) || out.typesChanged.includes(k) || out.packetsAdded.includes(k) || out.packetsRemoved.includes(k))
  if (hit.length) out.watched[stage] = hit
}
// packet id mapping changes
try {
  const ids = (T) => T.mcpe_packet[1].find(f => f.name === 'name').type[1].mappings
  const ia = ids(A); const ib = ids(B)
  out.packetIdChanges = Object.keys({ ...ia, ...ib }).filter(id => ia[id] !== ib[id]).map(id => ({ id, from: ia[id] ?? null, to: ib[id] ?? null }))
} catch {}
console.log(JSON.stringify(out, null, 2))
