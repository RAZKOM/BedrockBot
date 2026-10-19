#!/usr/bin/env node
// End-to-end check that a protocol stack can play <gameVersion> against a local BDS:
// login, spawn handshake, registry + subchunk decode, 20 ticks of walking with no correction.
//
//   node verify.mjs <gameVersion> --port <p> [--deps <dir>|self] [--timeout <s>] [--allow-decode-errors]
//
// --deps: directory whose node_modules provide bedrock-protocol, minecraft-data, prismarine-registry
//         and prismarine-chunk. Default: the bump sandbox (.work/sandbox). `self` = this package's
//         own node_modules (the pnpm workspace install, i.e. what the bot gets, unpatched).
// Prints a JSON report on stdout. Exit 0 = pass; 1 = fail (report.failure has stage + reason); 2 = usage.
// Local BDS only: always connects to 127.0.0.1, offline mode, RakNet (raknet-native).
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { DEFAULT_SANDBOX, HERE } from './lib/sandbox.mjs'

const HOST = '127.0.0.1'
const EYE = 1.62
const WALK_TICKS = 20
const STEP = 0.2 // --walk constant: fixed blocks/tick (spike C); fine for ~6 ticks, corrected over 20
// --walk physics (default): Bedrock/Java ground walking. Each tick: v += ACCEL (input held), move by v,
// v *= FRICTION. ACCEL = movement speed 0.1 * input 0.98; FRICTION = block slipperiness 0.6 * 0.91.
// Steady state 0.098 / (1 - 0.546) = 0.2159 blocks/tick (4.317 m/s); after release the player coasts.
const ACCEL = 0.098
const FRICTION = 0.546

function parseArgs (argv) {
  const a = { _: [], walk: 'physics', timeout: 90, deps: DEFAULT_SANDBOX, username: 'BumpBot' }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (k === '--port') a.port = Number(argv[++i])
    else if (k === '--deps') a.deps = argv[++i]
    else if (k === '--timeout') a.timeout = Number(argv[++i])
    else if (k === '--username') a.username = argv[++i]
    else if (k === '--allow-decode-errors') a.allowDecodeErrors = true
    else if (k === '--walk') a.walk = argv[++i]
    else if (k === '-h' || k === '--help') a.help = true
    else a._.push(k)
  }
  return a
}

const a = parseArgs(process.argv.slice(2))
if (a.help || a._.length !== 1 || !Number.isInteger(a.port)) {
  console.log('usage: node verify.mjs <gameVersion> --port <p> [--deps <dir>|self] [--timeout s] [--username n] [--walk physics|constant] [--allow-decode-errors]')
  process.exit(a.help ? 0 : 2)
}
const ver = a._[0]
const depsDir = a.deps === 'self' ? HERE : resolve(a.deps)
const t0 = Date.now()
const ms = () => Date.now() - t0

const report = {
  ok: false,
  version: ver,
  host: HOST,
  port: a.port,
  deps: depsDir,
  versions: {},
  server: null,
  login: { ok: false, ms: null },
  spawn: { ok: false, ms: null, feet: null },
  registry: { ok: false, blockStatesByRuntimeId: null, itemstates: null },
  chunk: { ok: false, subchunkResult: null, block: null, expected: 'grass_block', at: [0, -61, 0] },
  movement: { ok: false, model: null, ticks: WALK_TICKS, corrections: [], fromZ: null, toZ: null },
  kick: null,
  packetsSeen: 0,
  packetTypes: 0,
  decodeErrors: [],
  unknownPackets: [],
  failure: null,
  elapsedMs: null
}

let finished = false
let client
function finish (failure) {
  if (finished) return
  finished = true
  if (failure) report.failure = failure
  report.ok = !failure
  if (!failure) report.stage = 'done'
  report.elapsedMs = ms()
  try { client?.close?.() } catch {}
  console.log(JSON.stringify(report, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2))
  if (failure) console.error(`verify FAILED at ${failure.stage}: ${failure.reason}`)
  setTimeout(() => process.exit(failure ? 1 : 0), 200)
}
const fail = (stage, reason) => finish({ stage, reason })

// ---- load the stack from depsDir -------------------------------------------------------------
if (!existsSync(join(depsDir, 'node_modules', 'bedrock-protocol'))) {
  fail('setup', `no bedrock-protocol under ${depsDir}/node_modules (run bump.mjs once to create the sandbox, or pass --deps)`)
} else {
  try { await run() } catch (e) { fail(report.stage ?? 'setup', e.stack?.split('\n').slice(0, 3).join(' | ') ?? String(e)) }
}

async function run () {
  const req = createRequire(join(depsDir, 'package.json'))
  const pv = (n) => { try { return req(`${n}/package.json`).version } catch { return null } }
  for (const n of ['bedrock-protocol', 'minecraft-data', 'prismarine-registry', 'prismarine-chunk', 'raknet-native']) report.versions[n] = pv(n)
  const bedrock = req('bedrock-protocol')
  const mcData = req('minecraft-data')
  const Options = req('bedrock-protocol/src/options')
  if (!Options.Versions[ver]) return fail('setup', `bedrock-protocol/minecraft-data in ${depsDir} do not know ${ver}; known newest: ${Object.keys(Options.Versions).slice(0, 3).join(', ')} (run bump.mjs ${ver})`)
  const md = mcData('bedrock_' + ver)
  if (!md?.protocol) return fail('setup', `minecraft-data has no data.js entry for bedrock_${ver} (run bump.mjs ${ver})`)
  report.protocol = Options.Versions[ver]

  // packet id -> name, for naming packets that fail to decode
  const idToName = {}
  try {
    const nameField = md.protocol.types.mcpe_packet[1].find(f => f.name === 'name')
    Object.assign(idToName, nameField.type[1].mappings)
  } catch {}

  const registry = req('prismarine-registry')('bedrock_' + ver)
  const Chunk = req('prismarine-chunk/src/bedrock/1.18/chunk')(registry) // 1.26 bypass (prismarine-chunk PR #338)
  const column = new Chunk({ x: 0, z: 0 })

  // ---- ping: what does the server say it is? ------------------------------------------------
  report.stage = 'ping'
  try {
    const ad = await bedrock.ping({ host: HOST, port: a.port, timeout: 5000 })
    report.server = { version: ad.version, protocol: Number(ad.protocol), motd: ad.motd, levelName: ad.levelName }
    if (Number(ad.protocol) !== report.protocol) {
      return fail('login', `server advertises ${ad.version} protocol ${ad.protocol}, client ${ver} is protocol ${report.protocol} (wrong BDS build or wrong version argument)`)
    }
  } catch (e) {
    return fail('ping', `no RakNet answer from ${HOST}:${a.port} (${e.message}); is the container up with TRANSPORT=raknet?`)
  }

  // ---- connect ------------------------------------------------------------------------------
  report.stage = 'login'
  const timer = setTimeout(() => fail(report.stage, `timeout after ${a.timeout}s in stage ${report.stage}`), a.timeout * 1000)
  timer.unref?.()
  client = bedrock.createClient({ host: HOST, port: a.port, username: a.username, offline: true, version: ver, raknetBackend: 'raknet-native', skipPing: true })

  const seen = new Map()
  let lastRaw = null
  const origRead = client.readPacket.bind(client)
  client.readPacket = (buf) => { lastRaw = buf; return origRead(buf) }

  client.on('packet', (des) => { report.packetsSeen++; const n = des.data.name; seen.set(n, (seen.get(n) || 0) + 1); report.packetTypes = seen.size })
  client.on('error', (e) => {
    let id = null
    if (lastRaw) { let v = 0; let s = 0; for (let i = 0; i < 5 && i < lastRaw.length; i++) { const b = lastRaw[i]; v |= (b & 0x7f) << s; s += 7; if (!(b & 0x80)) break } id = v & 0x3ff }
    const name = id != null ? (idToName[id] ?? idToName[String(id)] ?? `unknown_0x${id.toString(16)}`) : null
    report.decodeErrors.push({ stage: report.stage, packetId: id, packetName: name, message: String(e.message).slice(0, 300) })
    if (name && !report.unknownPackets.includes(name)) report.unknownPackets.push(name)
    if (report.stage === 'login' && !report.login.ok) fail('login', `error before login completed: ${e.message}`)
  })
  client.on('kick', (p) => { report.kick = p; fail(report.stage, `kicked: ${JSON.stringify(p)}`) })
  client.on('close', () => { if (!finished) fail(report.stage, 'connection closed by server') })

  let rid = null; let feet = null; let itemstates = []
  client.on('play_status', (p) => {
    if (p.status === 'login_success') { report.login = { ok: true, ms: ms() }; report.stage = 'spawn' }
    if (p.status === 'player_spawn') {
      client.queue('serverbound_loading_screen', { type: 1 })
      client.queue('serverbound_loading_screen', { type: 2 })
    }
    if (/failed|outdated/.test(p.status)) fail('login', `play_status ${p.status}`)
  })
  // 1.26.x sends item states in a separate item_registry packet (usually right after start_game);
  // prismarine-registry wants them inside start_game, so register once both have arrived (or at spawn).
  let startGame = null
  const registerOnce = () => {
    if (report.registry.ok || !startGame) return
    try {
      registry.handleStartGame({ ...startGame, itemstates })
      report.registry = { ok: true, blockStatesByRuntimeId: Object.keys(registry.blocksByRuntimeId ?? {}).length, itemstates: itemstates.length }
    } catch (e) {
      report.registry = { ok: false, error: e.message }
    }
  }
  client.on('item_registry', (p) => { itemstates = p.itemstates ?? []; registerOnce() })
  client.on('start_game', (p) => {
    rid = p.runtime_entity_id; startGame = p
    if (!feet && p.player_position) feet = { x: p.player_position.x, y: p.player_position.y - EYE, z: p.player_position.z }
    if (itemstates.length) registerOnce()
  })
  client.on('respawn', (p) => {
    if (p.state === 1) {
      feet = { x: p.position.x, y: p.position.y - EYE, z: p.position.z }
      client.queue('respawn', { position: p.position, state: 2, runtime_entity_id: rid })
    }
  })
  let walking = false; let walkStartTick = null
  client.on('correct_player_move_prediction', (p) => {
    report.movement.corrections.push({ tick: String(p.tick), position: p.position, walking })
  })

  let chunkDone = false
  client.on('subchunk', async (p) => {
    try {
      const entries = p.entries ?? []
      const target = entries.find(e => e.dx === 0 && e.dz === 0 && (p.origin.y + e.dy) === -4) ?? entries[0]
      report.chunk.subchunkResult = target?.result ?? null
      for (const e of entries) if (e.result === 'success') await column.networkDecodeSubChunkNoCache(p.origin.y + e.dy, e.payload)
      const b = column.getBlock({ x: 0, y: -61, z: 0 })
      report.chunk.block = b?.name ?? null
      report.chunk.below = column.getBlock({ x: 0, y: -64, z: 0 })?.name ?? null
      report.chunk.above = column.getBlock({ x: 0, y: -60, z: 0 })?.name ?? null
      report.chunk.ok = report.chunk.block === 'grass_block'
      chunkDone = true
      if (!report.chunk.ok) fail('chunk', `block (0,-61,0) decoded as ${report.chunk.block} (subchunk result ${report.chunk.subchunkResult}); expected grass_block on a flat world`)
      else startWalk()
    } catch (e) {
      fail('chunk', `subchunk decode threw: ${e.message}`)
    }
  })

  let tick = 0n; let n = 0; let vz = 0
  function startWalk () {
    report.stage = 'movement'
    walking = true; walkStartTick = n
    report.movement.model = a.walk === 'constant' ? `constant ${STEP}/tick` : `physics accel ${ACCEL} friction ${FRICTION}`
    report.movement.fromZ = feet.z
  }

  client.on('spawn', () => {
    report.spawn = { ok: true, ms: ms(), feet: feet && { ...feet } }
    report.stage = 'chunk'
    registerOnce()
    if (!report.registry.ok) return fail('chunk', `registry.handleStartGame failed: ${report.registry.error ?? 'start_game not seen'}`)
    if (!feet) return fail('spawn', 'no respawn/start_game position received')
    const loop = setInterval(() => {
      if (finished) return clearInterval(loop)
      n++; tick++
      if (n === 10) client.queue('subchunk_request', { dimension: 0, origin: { x: 0, y: -4, z: 0 }, requests: [{ x: 0, y: 0, z: 0 }] })
      if (n === 70 && !chunkDone) return fail('chunk', 'no subchunk answer within 3 s of subchunk_request (chunk (0,0) outside the loaded area?)')
      const moving = walking && n - walkStartTick < WALK_TICKS
      let dz = 0
      if (a.walk === 'constant') dz = moving ? STEP : 0
      else if (walking) { vz += moving ? ACCEL : 0; dz = vz; vz *= FRICTION; if (Math.abs(vz) < 0.003) vz = 0 }
      feet.z += dz
      if (walking && n - walkStartTick >= WALK_TICKS - 1) report.movement.toZ = feet.z
      // after walking, idle 30 more ticks (1.5 s) so a late correction (min 5-tick delay) is seen
      if (walking && n - walkStartTick >= WALK_TICKS + 30) {
        clearInterval(loop)
        const during = report.movement.corrections.filter(c => c.walking)
        report.movement.ok = during.length === 0
        if (!report.movement.ok) return fail('movement', `${during.length} correct_player_move_prediction during/after the walk; first ${JSON.stringify(during[0].position)}`)
        if (report.decodeErrors.length && !a.allowDecodeErrors) return fail('decode', `${report.decodeErrors.length} packet(s) failed to decode: ${report.unknownPackets.join(', ')}`)
        return finish(null)
      }
      const mv = moving ? { x: 0, z: 1 } : { x: 0, z: 0 }
      const flags = ['vertical_collision']; if (moving) flags.push('up')
      client.queue('player_auth_input', {
        pitch: 0, yaw: 0, position: { x: feet.x, y: feet.y + EYE, z: feet.z }, move_vector: mv, head_yaw: 0,
        input_data: flags, input_mode: 'mouse', play_mode: 'normal', interaction_model: 'crosshair',
        interact_rotation: { x: 0, z: 0 }, tick, delta: { x: 0, y: 0, z: dz },
        analogue_move_vector: mv, camera_orientation: { x: 0, y: 0, z: 1 }, raw_move_vector: mv
      })
    }, 50)
  })

}
