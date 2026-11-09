#!/usr/bin/env node
// The test host's BDS containers (Track I1; docker/compose.mac.yml). Runs ON the test host, in a test checkout,
// started by `node scripts/mac-run.mjs bds <command> [fly fly2 fly3]` from the dev machine:
//   up       create / start the containers, wait for "Server started.", deploy the truth pack where it is missing
//   down     stop and remove them (the data in $BEDROCKBOT_TEST_ROOT/data is kept)
//   restart  docker restart and wait
//   pack     (re)deploy the truth pack from this checkout and restart
//   status   state, CPU and memory of each
//   tps      the server's ticks per second over 30 s (`time query gametime` twice; 20 is full speed)
//   logs     the last 40 lines of each
// The containers are the dev machine's bds-fly / bds-fly2 / bds-fly3 (same names, ports, settings), so the e2e
// suites' defaults point at them.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMPOSE = join(ROOT, 'docker', 'compose.mac.yml');
const DATA = join(process.env.BEDROCKBOT_TEST_ROOT ?? join(process.env.HOME ?? '', 'bbtest.noindex'), 'data');
const PROFILES = { fly: 'bds-fly', fly2: 'bds-fly2', fly3: 'bds-fly3' };
const STARTED = 'Server started.';

const [cmd = 'status', ...rest] = process.argv.slice(2);
const names = rest.length ? rest : Object.keys(PROFILES);
for (const n of names) if (!PROFILES[n]) fail(`unknown profile ${n} (${Object.keys(PROFILES).join(', ')})`);

function fail(msg) {
  console.error(`bds: ${msg}`);
  process.exit(2);
}

function docker(args, capture = false) {
  const r = spawnSync('docker', args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8', env: { ...process.env, BEDROCKBOT_TEST_DATA: DATA } });
  if (r.error) throw r.error;
  return r;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitStarted(container, timeoutMs = Number(process.env.BDS_UP_TIMEOUT_MS ?? 600_000)) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const [status, since] = docker(['inspect', '-f', '{{.State.Status}} {{.State.StartedAt}}', container], true).stdout.trim().split(' ');
    if (status === 'exited' || status === 'dead') {
      docker(['logs', '--tail', '40', container]);
      throw new Error(`${container} is ${status}`);
    }
    const logs = docker(['logs', '--since', since ?? '', container], true);
    if (`${logs.stdout}${logs.stderr}`.includes(STARTED)) return Date.now() - t0;
    await sleep(2000);
  }
  throw new Error(`${container} did not log "${STARTED}" within ${timeoutMs / 1000} s (the first start downloads BDS)`);
}

function deployPack(name) {
  const deploy = join(ROOT, 'packs', 'truth', 'scripts', 'deploy.mjs');
  const r = spawnSync(process.execPath, [deploy, '--data', join(DATA, name), '--restart', PROFILES[name]], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`truth pack deploy into ${PROFILES[name]} failed (exit ${r.status})`);
}

/** `time query gametime` answers `[2026-11-09 02:58:20:670 INFO] Gametime is 956` in the server log (its own clock). */
function gametime(container) {
  const since = new Date(Date.now() - 1000).toISOString();
  docker(['exec', container, 'send-command', 'time', 'query', 'gametime'], true);
  for (let i = 0; i < 20; i++) {
    spawnSync('sleep', ['0.25']);
    const out = docker(['logs', '--since', since, container], true).stdout;
    const m = [...out.matchAll(/\[(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d):(\d{3}) INFO\] Gametime is (\d+)/g)].at(-1);
    if (m) return { t: Date.parse(`${m[1]}T${m[2]}.${m[3]}Z`), ticks: Number(m[4]) };
  }
  return undefined;
}

try {
  const services = names.map((n) => PROFILES[n]);
  switch (cmd) {
    case 'up': {
      for (const n of names) mkdirSync(join(DATA, n), { recursive: true });
      const r = docker(['compose', '-f', COMPOSE, 'up', '-d', ...services]);
      if (r.status !== 0) process.exit(r.status ?? 1);
      for (const n of names) {
        const ms = await waitStarted(PROFILES[n]);
        console.log(`${PROFILES[n]}: Server started (${(ms / 1000).toFixed(1)} s)`);
        if (!existsSync(join(DATA, n, 'behavior_packs', 'truth', 'manifest.json'))) {
          deployPack(n);
          await waitStarted(PROFILES[n]);
          console.log(`${PROFILES[n]}: truth pack deployed`);
        }
      }
      break;
    }
    case 'down':
      process.exit(docker(['compose', '-f', COMPOSE, 'rm', '-s', '-f', ...services]).status ?? 1);
      break;
    case 'restart':
      for (const s of services) {
        if (docker(['restart', s]).status !== 0) process.exit(1);
        console.log(`${s}: restarted (${((await waitStarted(s)) / 1000).toFixed(1)} s)`);
      }
      break;
    case 'pack':
      for (const n of names) {
        deployPack(n);
        console.log(`${PROFILES[n]}: truth pack deployed, restarted (${((await waitStarted(PROFILES[n])) / 1000).toFixed(1)} s)`);
      }
      break;
    case 'status':
      docker(['ps', '-a', '--filter', 'name=bds-fly', '--format', 'table {{.Names}}\t{{.Status}}\t{{.Ports}}']);
      docker(['stats', '--no-stream', '--format', 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}', ...services]);
      break;
    case 'tps': {
      const secs = Number(process.env.BDS_TPS_SECONDS ?? 30);
      const a = new Map(services.map((s) => [s, gametime(s)]));
      await sleep(secs * 1000);
      for (const s of services) {
        const b = gametime(s);
        const x = a.get(s);
        if (!x || !b) console.log(`${s}: no answer to time query`);
        else console.log(`${s}: ${((b.ticks - x.ticks) / ((b.t - x.t) / 1000)).toFixed(2)} ticks/s over ${((b.t - x.t) / 1000).toFixed(1)} s`);
      }
      break;
    }
    case 'logs':
      for (const s of services) {
        console.log(`--- ${s}`);
        docker(['logs', '--tail', '40', s]);
      }
      break;
    default:
      fail(`unknown command ${cmd} (up | down | restart | pack | status | tps | logs)`);
  }
} catch (err) {
  console.error(`bds: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
