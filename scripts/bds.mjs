#!/usr/bin/env node
// Dev BDS helper (PLAN.md task 0.2). Touches only the container of the selected profile; the
// default profile is `bds-dev` (docker/compose.dev.yml, udp/19132).
//   node scripts/bds.mjs up      start docker/compose.dev.yml and wait for "Server started."
//   node scripts/bds.mjs down    stop and remove bds-dev (data in docker/data/dev is kept)
//   node scripts/bds.mjs restart `docker restart bds-dev` and wait for "Server started."
//   node scripts/bds.mjs idle    print the effective player-idle-timeout (minutes)
// Env: BDS_IDLE_TIMEOUT=<minutes> for `up` recreates bds-dev with that idle kick (default 0 = off).
//   node scripts/bds.mjs cmd ... run a console command, e.g. `cmd say hi`
//   node scripts/bds.mjs logs    follow the server log
//   node scripts/bds.mjs pack    deploy the truth pack (packs/truth) into the profile's data dir and restart
// Profiles (PLAN.md tasks 1.4 and 1.5), chosen with `--profile <name>` anywhere on the command line
// or with env BDS_CONTAINER=<container> (the e2e suite sets it). Default game version 1.26.60 since
// 2026-10-28 (docs/versions.md):
//   dev    bds-dev    docker/compose.dev.yml            BDS 1.26.60.6, RakNet    udp/19132 (default)
//   dev51  bds-dev51  docker/compose.dev51.yml          BDS 1.26.51.1, RakNet    udp/19134 (rollback)
//   nn     bds-nn     docker/compose.dev-nethernet.yml  BDS 1.26.60.6, NetherNet tcp+udp/19140, udp/19160-19167, udp/7551
//   world  bds-world  docker/compose.world.yml          BDS 1.26.60.6, RakNet    udp/19142 (world-* e2e)
//   move   bds-move   docker/compose.move.yml           BDS 1.26.60.6, RakNet    udp/19146 (nav-*, skills-input e2e)
//   dig    bds-dig    docker/compose.dig.yml            BDS 1.26.60.6, RakNet    udp/19148 (dig e2e)
//   wood   bds-wood   docker/compose.wood.yml           BDS 1.26.60.6, RakNet    udp/19150 (wood-* e2e)
//   hard   bds-hard   docker/compose.hard.yml           BDS 1.26.60.6, RakNet    udp/19154 (hard-* e2e: death, night)
//   soak   bds-soak   docker/compose.soak.yml           BDS 1.26.60.6, RakNet    udp/19152 (8 h AFK soak only)
//   rl     bds-rl     docker/compose.rl.yml             BDS 1.26.60.6, RakNet    udp/19156 (RL env: rl-* e2e, rl/ contract test)
// Any other BDS_CONTAINER value works for restart/idle/cmd/logs only.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PROFILES = {
  dev: { container: 'bds-dev', compose: 'compose.dev.yml', data: 'dev', port: 'udp/19132' },
  dev51: { container: 'bds-dev51', compose: 'compose.dev51.yml', data: 'dev51', port: 'udp/19134' },
  nn: { container: 'bds-nn', compose: 'compose.dev-nethernet.yml', data: 'nn', port: 'tcp+udp/19140, WebRTC udp/19160-19167, discovery udp/7551 (NetherNet)' },
  world: { container: 'bds-world', compose: 'compose.world.yml', data: 'world', port: 'udp/19142' },
  move: { container: 'bds-move', compose: 'compose.move.yml', data: 'move', port: 'udp/19146' },
  dig: { container: 'bds-dig', compose: 'compose.dig.yml', data: 'dig', port: 'udp/19148' },
  wood: { container: 'bds-wood', compose: 'compose.wood.yml', data: 'wood', port: 'udp/19150' },
  hard: { container: 'bds-hard', compose: 'compose.hard.yml', data: 'hard', port: 'udp/19154' },
  soak: { container: 'bds-soak', compose: 'compose.soak.yml', data: 'soak', port: 'udp/19152' },
  rl: { container: 'bds-rl', compose: 'compose.rl.yml', data: 'rl', port: 'udp/19156' },
}
const argv = process.argv.slice(2)
const profileFlag = argv.indexOf('--profile')
const profileName = profileFlag >= 0 ? argv.splice(profileFlag, 2)[1] : undefined
if (profileName !== undefined && !PROFILES[profileName]) {
  console.error(`unknown profile "${profileName}" (${Object.keys(PROFILES).join(', ')})`)
  process.exit(2)
}
const PROFILE = profileName
  ? PROFILES[profileName]
  : process.env.BDS_CONTAINER
    ? (Object.values(PROFILES).find((p) => p.container === process.env.BDS_CONTAINER) ?? { container: process.env.BDS_CONTAINER })
    : PROFILES.dev
const COMPOSE = PROFILE.compose ? join(ROOT, 'docker', PROFILE.compose) : undefined
const CONTAINER = PROFILE.container
const STARTED = 'Server started.'

function needCompose () {
  if (!COMPOSE) throw new Error(`no compose file for container ${CONTAINER}; use --profile ${Object.keys(PROFILES).join('|')}`)
  return COMPOSE
}

function run (args, opts = {}) {
  const r = spawnSync('docker', args, { stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8' })
  if (r.error) throw r.error
  return r
}

async function waitStarted (timeoutMs) {
  const t0 = Date.now()
  let startedAt = ''
  while (Date.now() - t0 < timeoutMs) {
    const insp = run(['inspect', '-f', '{{.State.Status}} {{.State.StartedAt}}', CONTAINER], { capture: true })
    const [status, since] = insp.stdout.trim().split(' ')
    if (status === 'exited' || status === 'dead') {
      run(['logs', '--tail', '40', CONTAINER])
      throw new Error(`${CONTAINER} is ${status}`)
    }
    startedAt = since ?? ''
    // Only look at logs from the current container start, so an old "Server started." does not count.
    const logs = run(['logs', '--since', startedAt, CONTAINER], { capture: true })
    if (`${logs.stdout}${logs.stderr}`.includes(STARTED)) return Date.now() - t0
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  run(['logs', '--tail', '40', CONTAINER])
  throw new Error(`${CONTAINER} did not log "${STARTED}" within ${timeoutMs / 1000} s (first run downloads BDS, ~100 MB)`)
}

const [cmd, ...rest] = argv
try {
  switch (cmd) {
    case 'up': {
      const t0 = Date.now()
      const r = run(['compose', '-f', needCompose(), 'up', '-d'])
      if (r.status !== 0) process.exit(r.status ?? 1)
      await waitStarted(Number(process.env.BDS_UP_TIMEOUT_MS ?? 180_000))
      console.log(`${CONTAINER}: Server started (${((Date.now() - t0) / 1000).toFixed(1)} s) on ${PROFILE.port ?? '?'}, player-idle-timeout=${process.env.BDS_IDLE_TIMEOUT ?? 0}`)
      break
    }
    case 'restart': {
      const t0 = Date.now()
      const r = run(['restart', CONTAINER])
      if (r.status !== 0) process.exit(r.status ?? 1)
      await waitStarted(Number(process.env.BDS_UP_TIMEOUT_MS ?? 180_000))
      console.log(`${CONTAINER}: restarted (${((Date.now() - t0) / 1000).toFixed(1)} s)`)
      break
    }
    case 'idle': {
      const r = run(['exec', CONTAINER, 'sh', '-c', 'grep -E "^player-idle-timeout=" /data/server.properties'], { capture: true })
      if (r.status !== 0) throw new Error(r.stderr || `${CONTAINER} not running`)
      console.log(r.stdout.trim())
      break
    }
    case 'down':
      process.exit(run(['compose', '-f', needCompose(), 'down']).status ?? 1)
      break
    case 'cmd': {
      if (rest.length === 0) throw new Error('usage: bds:cmd <console command...>')
      process.exit(run(['exec', CONTAINER, 'send-command', ...rest]).status ?? 1)
      break
    }
    case 'pack': {
      if (!PROFILE.data) throw new Error(`no data dir known for container ${CONTAINER}; use --profile ${Object.keys(PROFILES).join('|')}`)
      const t0 = Date.now()
      const deploy = join(ROOT, 'packs', 'truth', 'scripts', 'deploy.mjs')
      const r = spawnSync(process.execPath, [deploy, '--data', join(ROOT, 'docker', 'data', PROFILE.data), '--restart', CONTAINER], { stdio: 'inherit' })
      if (r.status !== 0) process.exit(r.status ?? 1)
      await waitStarted(Number(process.env.BDS_UP_TIMEOUT_MS ?? 180_000))
      console.log(`${CONTAINER}: truth pack deployed, restarted (${((Date.now() - t0) / 1000).toFixed(1)} s)`)
      break
    }
    case 'logs':
      process.exit(run(['logs', '-f', '--tail', String(process.env.BDS_LOG_TAIL ?? 100), CONTAINER]).status ?? 1)
      break
    default:
      console.error(`usage: node scripts/bds.mjs [--profile ${Object.keys(PROFILES).join('|')}] up|down|restart|idle|cmd <command...>|logs|pack`)
      process.exit(2)
  }
} catch (err) {
  console.error(String(err instanceof Error ? err.message : err))
  process.exit(1)
}
