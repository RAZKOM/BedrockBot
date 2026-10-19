const bedrock = require('bedrock-protocol')
const t0 = Date.now(); const log = (...a) => console.log(`[${Date.now() - t0}ms]`, ...a)
;(async () => {
  try { const r = await bedrock.ping({ host: '127.0.0.1', port: 19140, timeout: 3000 }); log('ping', JSON.stringify(r, (k, v) => typeof v === 'bigint' ? String(v) : v).slice(0, 300)) } catch (e) { log('ping failed', e.message, e.errors?.map(x => x.message).join(' / ')) }
  const client = bedrock.createClient({ host: '127.0.0.1', port: 19140, username: 'SpikeBot', offline: true, version: '1.26.51', transport: 'nethernet', nethernet: { signalling: 'lan' } })
  client.on('join', () => log('join')); client.on('spawn', () => log('SPAWN over nethernet'))
  client.on('play_status', p => log('play_status', p.status)); client.on('kick', p => log('kick', JSON.stringify(p)))
  client.on('error', e => log('error', e.message)); client.on('close', () => { log('close'); process.exit(0) })
  setTimeout(() => { log('timeout'); process.exit(0) }, 25000)
})()
