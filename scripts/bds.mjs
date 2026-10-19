#!/usr/bin/env node
// Dev BDS helper (PLAN.md task 0.2). Only ever touches the container `bds-dev`.
//   node scripts/bds.mjs up      start docker/compose.dev.yml and wait for "Server started."
//   node scripts/bds.mjs down    stop and remove bds-dev (data in docker/data/dev is kept)
//   node scripts/bds.mjs cmd ... run a console command, e.g. `cmd say hi`
//   node scripts/bds.mjs logs    follow the server log
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const COMPOSE = join(ROOT, 'docker', 'compose.dev.yml')
const CONTAINER = 'bds-dev'
const STARTED = 'Server started.'

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

const [cmd, ...rest] = process.argv.slice(2)
try {
  switch (cmd) {
    case 'up': {
      const t0 = Date.now()
      const r = run(['compose', '-f', COMPOSE, 'up', '-d'])
      if (r.status !== 0) process.exit(r.status ?? 1)
      await waitStarted(Number(process.env.BDS_UP_TIMEOUT_MS ?? 180_000))
      console.log(`${CONTAINER}: Server started (${((Date.now() - t0) / 1000).toFixed(1)} s) on udp/19132`)
      break
    }
    case 'down':
      process.exit(run(['compose', '-f', COMPOSE, 'down']).status ?? 1)
      break
    case 'cmd': {
      if (rest.length === 0) throw new Error('usage: bds:cmd <console command...>')
      process.exit(run(['exec', CONTAINER, 'send-command', ...rest]).status ?? 1)
      break
    }
    case 'logs':
      process.exit(run(['logs', '-f', '--tail', String(process.env.BDS_LOG_TAIL ?? 100), CONTAINER]).status ?? 1)
      break
    default:
      console.error('usage: node scripts/bds.mjs up|down|cmd <command...>|logs')
      process.exit(2)
  }
} catch (err) {
  console.error(String(err instanceof Error ? err.message : err))
  process.exit(1)
}
