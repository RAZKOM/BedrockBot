const bedrock = require('bedrock-protocol'); const { execSync } = require('child_process')
const cmd = (s) => { try { execSync(`docker exec bds-spike send-command ${s}`, { stdio: 'ignore' }) } catch (e) { console.log('cmd fail', s) } }
const client = bedrock.createClient({ host: '127.0.0.1', port: 19132, username: 'SpikeBot', offline: true, version: '1.26.51' })
client.on('spawn', () => setTimeout(() => { cmd('scriptevent spike:ping'); cmd('scriptevent spike:block 0 -61 0'); cmd('scriptevent spike:pos'); cmd('say plain') }, 2000))
client.on('text', p => console.log('[text]', JSON.stringify(p).slice(0, 300)))
setTimeout(() => process.exit(0), 7000)
