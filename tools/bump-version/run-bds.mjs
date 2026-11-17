#!/usr/bin/env node
// Start (or reuse) a pinned BDS container for version-bump checks and wait for "Server started".
//
//   node run-bds.mjs --links                         print the newest BDS builds from the official links API
//   node run-bds.mjs <build> --port <p> --name <n>   e.g. 1.26.60.6 --port 19134 --name bds60
//       [--data <dir>]       host data dir (default tools/bump-version/.bds/<name>)
//       [--timeout <sec>]    wait for "Server started" (default 240; first start downloads ~100 MB)
//       [--env K=V]...       extra container env (repeatable)
//       [--transport nethernet] [--udp-ports a-b]   NetherNet only (TRANSPORT=nethernet): publishes <p>/tcp and <p>/udp,
//                            the LAN discovery port 7551/udp and the WebRTC UDP range (SERVER_UDP_PORTS, default
//                            19260-19267). Only one NetherNet LAN server per host: 7551 is fixed.
//       [--preview]          PREVIEW=true (a preview build; implied by `preview`)
//   <build> may also be `latest` or `preview`: resolved to an exact build via the links API.
//
// Safety: never removes or stops anything. If a container with <name> already exists it is only
// started (if stopped) and its VERSION / SERVER_PORT must match, otherwise the script exits 2.
// Local BDS only: ONLINE_MODE=false, ALLOW_LIST=false, RakNet (or NetherNet with --transport), published on the given port.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const IMAGE = 'itzg/minecraft-bedrock-server:2026.10.2'
const LINKS_API = 'https://net-secondary.web.minecraft-services.net/api/v1.0/download/links'

export async function fetchBdsLinks () {
  const res = await fetch(LINKS_API, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`links API HTTP ${res.status}`)
  const body = await res.json()
  const out = {}
  for (const l of body?.result?.links ?? []) {
    const m = /bedrock-server-(\d+\.\d+\.\d+\.\d+)\.zip$/.exec(l.downloadUrl ?? '')
    out[l.downloadType] = { url: l.downloadUrl, build: m ? m[1] : null }
  }
  return {
    release: out.serverBedrockLinux?.build ?? null,
    preview: out.serverBedrockPreviewLinux?.build ?? null,
    links: out
  }
}

function parseArgs (argv) {
  const a = { _: [], env: [], transport: 'raknet', udpPorts: '19260-19267' }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (k === '--port') a.port = Number(argv[++i])
    else if (k === '--name') a.name = argv[++i]
    else if (k === '--data') a.data = argv[++i]
    else if (k === '--timeout') a.timeout = Number(argv[++i])
    else if (k === '--env') a.env.push(argv[++i])
    else if (k === '--links') a.links = true
    else if (k === '--transport') a.transport = argv[++i]
    else if (k === '--udp-ports') a.udpPorts = argv[++i]
    else if (k === '--preview') a.preview = true
    else if (k === '-h' || k === '--help') a.help = true
    else a._.push(k)
  }
  return a
}

function docker (args, opts = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', ...opts })
  if (r.error) throw r.error
  return r
}

function inspect (name) {
  const r = docker(['inspect', name, '--format', '{{json .}}'])
  if (r.status !== 0) return null
  return JSON.parse(r.stdout)
}

function waitForStarted (name, sinceIso, timeoutSec) {
  return new Promise((resolveP, rejectP) => {
    const p = spawn('docker', ['logs', '-f', '--since', sinceIso, name], { stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    const t0 = Date.now()
    const done = (err, val) => { clearTimeout(timer); p.kill(); err ? rejectP(err) : resolveP(val) }
    const timer = setTimeout(() => done(new Error(`timeout after ${timeoutSec}s waiting for "Server started" (last log: ${buf.slice(-400)})`)), timeoutSec * 1000)
    const onData = (d) => {
      const s = d.toString()
      buf = (buf + s).slice(-8000)
      for (const line of s.split(/\r?\n/)) {
        if (/Downloading Bedrock server version|Starting Bedrock server|Version: |ERROR|TRANSPORT TYPE/i.test(line)) process.stderr.write(`  [${name}] ${line.trim()}\n`)
      }
      if (/Server started\./.test(buf)) done(null, Date.now() - t0)
    }
    p.stdout.on('data', onData); p.stderr.on('data', onData)
    p.on('exit', () => {
      const st = inspect(name)?.State
      if (st && !st.Running) done(new Error(`container ${name} exited (code ${st.ExitCode}); last log: ${buf.slice(-600)}`))
    })
  })
}

async function main () {
  const a = parseArgs(process.argv.slice(2))
  if (a.help || (!a.links && a._.length === 0)) {
    console.log('usage: node run-bds.mjs --links | <build|latest|preview> --port <p> --name <container> [--data dir] [--timeout s] [--env K=V] [--transport raknet|nethernet] [--udp-ports a-b] [--preview]')
    process.exit(a.help ? 0 : 1)
  }
  if (a.links) {
    const l = await fetchBdsLinks()
    console.log(JSON.stringify({ release: l.release, preview: l.preview, source: LINKS_API, links: l.links }, null, 2))
    return
  }
  let build = a._[0]
  if (build === 'preview') a.preview = true
  if (a.transport !== 'raknet' && a.transport !== 'nethernet') throw new Error(`--transport must be raknet or nethernet (got ${a.transport})`)
  const range = /^(\d+)-(\d+)$/.exec(a.udpPorts ?? '')
  if (a.transport === 'nethernet' && (!range || Number(range[1]) > Number(range[2]) || Number(range[1]) < 1024 || Number(range[2]) > 65535)) throw new Error(`--udp-ports must be a range like 19260-19267 (got ${a.udpPorts})`)
  if (build === 'latest' || build === 'preview') {
    const l = await fetchBdsLinks()
    build = build === 'latest' ? l.release : l.preview
    console.error(`resolved ${a._[0]} -> ${build}`)
  }
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(build ?? '')) throw new Error(`build must be a full 4-part BDS build like 1.26.60.6 (got ${build})`)
  if (!Number.isInteger(a.port) || a.port < 1024 || a.port > 65535) throw new Error('--port <p> required (UDP, 1024-65535)')
  if (!a.name || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(a.name)) throw new Error('--name <container> required')
  const timeout = a.timeout || 240

  const existing = inspect(a.name)
  let since
  if (existing) {
    const env = Object.fromEntries((existing.Config.Env || []).map(e => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]))
    const ports = Object.keys(existing.HostConfig.PortBindings || {})
    if (env.VERSION !== build || String(env.SERVER_PORT) !== String(a.port) || !ports.includes(`${a.port}/udp`) || (env.TRANSPORT ?? 'raknet') !== a.transport) {
      console.error(`container ${a.name} exists with VERSION=${env.VERSION} SERVER_PORT=${env.SERVER_PORT} TRANSPORT=${env.TRANSPORT} ports=${ports.join(',')}; ` +
        `wanted ${build} on ${a.port}/udp (${a.transport}). Not touching it (remove it yourself if it is yours).`)
      process.exit(2)
    }
    if (existing.State.Running) {
      since = existing.State.StartedAt
      console.error(`container ${a.name} already running (image ${existing.Config.Image}); checking it is up`)
    } else {
      since = new Date(Date.now() - 2000).toISOString()
      console.error(`starting existing container ${a.name} (image ${existing.Config.Image})`)
      const r = docker(['start', a.name])
      if (r.status !== 0) throw new Error(`docker start failed: ${r.stderr}`)
    }
  } else {
    const dataDir = resolve(a.data || resolve(HERE, '.bds', a.name))
    mkdirSync(dataDir, { recursive: true })
    const env = {
      EULA: 'TRUE',
      VERSION: build,
      TRANSPORT: a.transport,
      ONLINE_MODE: 'false',
      ALLOW_LIST: 'false',
      PLAYER_IDLE_TIMEOUT: '0',
      LEVEL_TYPE: 'FLAT',
      SERVER_PORT: String(a.port),
      ...(a.preview ? { PREVIEW: 'true' } : {}),
      ...(a.transport === 'nethernet' ? { SERVER_UDP_PORTS: a.udpPorts } : {})
    }
    for (const kv of a.env) { const i = kv.indexOf('='); if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1) }
    const args = ['run', '-d', '--name', a.name, '--label', 'bedrockbot.tool=bump-version']
    for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`)
    args.push('-p', `${a.port}:${a.port}/udp`)
    if (a.transport === 'nethernet') {
      // WebRTC over the published range; LAN discovery answers on 7551/udp
      args.push('-p', `${a.port}:${a.port}/tcp`, '-p', `7551:7551/udp`, '-p', `${range[1]}-${range[2]}:${range[1]}-${range[2]}/udp`)
    }
    args.push('--mount', `type=bind,source=${dataDir},target=/data`, IMAGE)
    since = new Date(Date.now() - 2000).toISOString()
    console.error(`docker ${args.join(' ')}`)
    const r = docker(args)
    if (r.status !== 0) throw new Error(`docker run failed: ${r.stderr}`)
  }
  const ms = await waitForStarted(a.name, since, timeout)
  console.log(JSON.stringify({ ok: true, name: a.name, build, port: a.port, transport: a.transport, readyAfterMs: ms }))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(`run-bds: ${e.message}`); process.exit(1) })
}
