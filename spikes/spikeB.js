// Spike B: decode a subchunk from the wire and compare block names with Script API ground truth. Throwaway.
const bedrock = require('bedrock-protocol')
const { execSync } = require('child_process')
const registry = require('prismarine-registry')('bedrock_1.26.51')
const Chunk = require('prismarine-chunk/src/bedrock/1.18/chunk')(registry)   // bypass: 1.41.0 has no 1.26 table entry
const cmd = (s) => { try { execSync(`docker exec bds-spike send-command ${s}`, { stdio: 'ignore' }) } catch (e) { console.log('cmd fail', s) } }
const probes = [[0, -64, 0], [0, -63, 0], [0, -61, 0], [0, -60, 0], [3, -60, 3]]
const client = bedrock.createClient({ host: '127.0.0.1', port: 19132, username: 'SpikeBot', offline: true, version: '1.26.51' })
const column = new Chunk({ x: 0, z: 0 })
const ORIGIN_Y = -4
let itemstates = []
client.on('item_registry', p => { itemstates = p.itemstates || p.items || []; console.log('[item_registry] keys', Object.keys(p), 'count', itemstates.length) })
client.on('start_game', p => { registry.handleStartGame({ ...p, itemstates }); console.log('[start_game] registry blocksByRuntimeId entries', Object.keys(registry.blocksByRuntimeId || {}).length) })
client.on('spawn', () => {
  console.log('[spawn]')
  setTimeout(() => cmd('scriptevent spike:set 3 -60 3 minecraft:oak_log'), 1500)
  setTimeout(() => {
    console.log('[send] subchunk_request origin y', ORIGIN_Y)
    client.queue('subchunk_request', { dimension: 0, origin: { x: 0, y: ORIGIN_Y, z: 0 }, requests: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }] })
  }, 3000)
  setTimeout(() => { for (const [x, y, z] of probes) cmd(`scriptevent spike:block ${x} ${y} ${z}`); cmd('scriptevent spike:pos') }, 5000)
})
client.on('text', p => { if (p.message.startsWith('[truth]')) console.log('[truth ]', p.message.slice(8)) })
client.on('update_block', p => console.log('[update_block]', JSON.stringify(p.position), 'rid', p.block_runtime_id, '->', registry.blocksByRuntimeId?.[p.block_runtime_id]?.name))
client.on('subchunk', async p => {
  console.log('[subchunk] origin', JSON.stringify(p.origin), 'entries', p.entries.map(e => `${e.dx},${e.dy},${e.dz}:${e.result}:${e.payload?.length ?? 0}B`).join(' '))
  for (const e of p.entries) {
    if (e.result !== 'success') continue
    try { await column.networkDecodeSubChunkNoCache(p.origin.y + e.dy, e.payload) } catch (err) { console.log('[decode error]', err.message); continue }
  }
  for (const [x, y, z] of probes) { try { const b = column.getBlock({ x, y, z }); console.log(`[wire  ] block ${x} ${y} ${z} = ${b?.name}`) } catch (err) { console.log('[getBlock error]', x, y, z, err.message) } }
})
client.on('close', () => { console.log('[close]'); process.exit(0) })
setTimeout(() => { client.disconnect(); setTimeout(() => process.exit(0), 300) }, 12000)
