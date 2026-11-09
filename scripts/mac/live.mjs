#!/usr/bin/env node
// The live bot as the test host's runs see it (docs/runbook.md "Tests on the Mac (Track I1)"). READ ONLY: it reads the
// live bot's console log and asks its health endpoint (GET /metrics); it never writes anything of the live bot's.
//
//   node scripts/mac/live.mjs check [--max-load 7]     exit 10 while a `!test` series runs, 11 while the 1-minute load
//                                                      is above the limit, else 0; one line says why
//   node scripts/mac/live.mjs watch --out <file> [--interval 5]   sample the live bot until killed (JSON lines: time,
//                                                      its tick, CPU share, RSS, load)
//   node scripts/mac/live.mjs report --since <iso> [--until <iso>] [--samples <file>]   its health in a window: ticks
//                                                      lost (stalls), CPU, the log's `max tick` and planner timings
//
// Where the live bot lives: BEDROCKBOT_LIVE_HOME (default HOME) /.bedrockbot/logs/realm-console.log (the launchd
// agent's log, deploy/launchd), its health port BEDROCKBOT_LIVE_PORT (default 9465), its process the node running
// `src/index.ts ... --target realm`.
import { execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const LIVE_HOME = process.env.BEDROCKBOT_LIVE_HOME || process.env.HOME || '';
const LOG = join(LIVE_HOME, '.bedrockbot', 'logs', 'realm-console.log');
const PORT = Number(process.env.BEDROCKBOT_LIVE_PORT || 9465);
/** A run of a series takes at most 600 s (TEST_LIMITS); a series with no `[test]` line for longer is gone. */
const SERIES_STALE_MS = 12 * 60_000;

const args = process.argv.slice(2);
const arg = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d;
};

/** The last `bytes` of a file as lines (the first, partial one dropped). */
function tailLines(file, bytes) {
  if (!existsSync(file)) return [];
  const size = statSync(file).size;
  const n = Math.min(size, bytes);
  const fd = openSync(file, 'r');
  const buf = Buffer.alloc(n);
  readSync(fd, buf, 0, n, size - n);
  closeSync(fd);
  const lines = buf.toString('utf8').split('\n');
  if (n < size) lines.shift();
  return lines;
}

const tsOf = (line) => {
  const t = Date.parse(line.slice(0, 24));
  return Number.isFinite(t) ? t : undefined;
};

/** The state of the live bot's test series from its log: the last series start / run start against the last end. */
export function seriesState(lines, now = Date.now()) {
  let state = { running: false };
  for (const line of lines) {
    if (!line.includes('[test] test ') && !/\[test\]|test \S+ failed:/.test(line)) continue;
    const t = tsOf(line);
    if (t === undefined) continue;
    const m = /\btest (\S+?)(?: (\d+)\/(\d+))?: (.*)$/.exec(line);
    if (/\btest \S+ failed: /.test(line)) state = { running: false, last: t };
    else if (m && m[2] === undefined && /^\d+\/\d+ arrived/.test(m[4])) state = { running: false, last: t };
    else if (m && m[2] === undefined && /^kit /.test(m[4])) state = { running: true, series: m[1], since: t, last: t };
    else if (m && m[2] !== undefined) state = { running: true, series: m[1], since: state.running ? state.since : t, run: `${m[2]}/${m[3]}`, last: t };
    else if (state.running) state.last = t;
  }
  if (state.running && now - state.last > SERIES_STALE_MS) state = { running: false, stale: true, last: state.last };
  return state;
}

function botPid() {
  try {
    const out = execFileSync('pgrep', ['-f', 'src/index.ts .*--target realm'], { encoding: 'utf8' }).trim().split('\n');
    return out[0] ? Number(out[0]) : undefined;
  } catch {
    return undefined;
  }
}

/** ps cumulative CPU time ("[hh:]mm:ss.ss", minutes past 59 on macOS) in seconds, and RSS in MB. */
function procStat(pid) {
  try {
    const [time, rss] = execFileSync('ps', ['-o', 'time=,rss=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/);
    let s = 0;
    for (const p of time.split(':').map(Number)) s = s * 60 + p;
    return { cpuS: s, rssMb: Math.round(Number(rss) / 1024) };
  } catch {
    return undefined;
  }
}

async function liveTick() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/metrics`, { signal: AbortSignal.timeout(2000) });
    const j = await r.json();
    return typeof j.tick === 'number' ? j.tick : Number(j.tick);
  } catch {
    return undefined;
  }
}

const iso = (t) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');

async function main(cmd) {
  if (cmd === 'check') {
    const maxLoad = Number(arg('max-load', 7));
    const s = seriesState(tailLines(LOG, 8 * 1024 * 1024));
    const load = loadavg()[0];
    if (s.running) {
      console.log(`the live bot runs !test ${s.series}${s.run ? ` (run ${s.run})` : ''} since ${iso(s.since)} UTC`);
      process.exit(10);
    }
    if (load > maxLoad) {
      console.log(`load ${load.toFixed(2)} is above ${maxLoad}`);
      process.exit(11);
    }
    console.log(`idle (no !test series${s.stale ? '; the last one stopped logging' : ''}), load ${load.toFixed(2)}`);
    process.exit(0);
  } else if (cmd === 'watch') {
    const out = arg('out');
    if (!out) throw new Error('watch needs --out <file>');
    const every = Number(arg('interval', 5)) * 1000;
    let prev;
    for (;;) {
      const t = Date.now();
      const pid = botPid();
      const st = pid ? procStat(pid) : undefined;
      const tick = await liveTick();
      const row = { t: new Date(t).toISOString(), tick, pid, cpuS: st?.cpuS, rssMb: st?.rssMb, load: loadavg().map((x) => Math.round(x * 100) / 100) };
      if (prev && prev.pid === pid && st && prev.cpuS !== undefined) row.cpu = Math.round(((st.cpuS - prev.cpuS) / ((t - prev.tm) / 1000)) * 1000) / 10;
      appendFileSync(out, `${JSON.stringify(row)}\n`);
      prev = { ...row, tm: t };
      await new Promise((r) => setTimeout(r, Math.max(0, every - (Date.now() - t))));
    }
  } else if (cmd === 'report') {
    const since = Date.parse(arg('since', ''));
    const until = arg('until') ? Date.parse(arg('until')) : Date.now();
    if (!Number.isFinite(since)) throw new Error('report needs --since <iso time>');
    const res = { window: `${iso(since)} .. ${iso(until)} UTC` };
    const samplesFile = arg('samples');
    if (samplesFile && existsSync(samplesFile)) {
      const rows = readFileSync(samplesFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => {
        const t = Date.parse(r.t);
        return t >= since && t <= until;
      });
      let lost = 0;
      let worst = 0;
      let span = 0;
      const cpus = [];
      for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1];
        const b = rows[i];
        if (b.cpu !== undefined) cpus.push(b.cpu);
        if (typeof a.tick !== 'number' || typeof b.tick !== 'number' || b.tick < a.tick) continue; // a respawn resets the tick
        const dt = (Date.parse(b.t) - Date.parse(a.t)) / 1000;
        const miss = Math.max(0, Math.round(dt * 20 - (b.tick - a.tick)));
        span += dt;
        lost += miss;
        worst = Math.max(worst, miss);
      }
      const mean = (xs) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : undefined);
      const loads = rows.map((r) => r.load?.[0]).filter((x) => typeof x === 'number');
      res.samples = rows.length;
      res.tickRate = span ? Math.round(((span * 20 - lost) / span) * 100) / 100 : undefined;
      res.ticksLost = lost;
      res.worstInterval = worst;
      res.cpuMean = mean(cpus);
      res.cpuMax = cpus.length ? Math.max(...cpus) : undefined;
      res.rssMb = rows.at(-1)?.rssMb;
      res.load1Mean = mean(loads);
      res.load1Max = loads.length ? Math.max(...loads) : undefined;
    }
    // the log: every `max tick N ms` (goto / walk ends) and the planners' `N ms` lines in the window
    const lines = tailLines(LOG, 64 * 1024 * 1024).filter((l) => {
      const t = tsOf(l);
      return t !== undefined && t >= since && t <= until;
    });
    const maxTicks = lines.map((l) => /max tick ([\d.]+) ms/.exec(l)?.[1]).filter(Boolean).map(Number);
    const plans = lines.filter((l) => /\b(plan|corridor|search|route)\b/.test(l)).map((l) => /(?:expanded, |in )([\d.]+) ms/.exec(l)?.[1]).filter(Boolean).map(Number);
    res.logLines = lines.length;
    res.maxTickMs = maxTicks.length ? Math.max(...maxTicks) : null;
    res.maxTickLines = maxTicks.length;
    res.plannerMsMax = plans.length ? Math.max(...plans) : null;
    res.plannerLines = plans.length;
    res.corrections = lines.filter((l) => /\[move\] correction #/.test(l)).length;
    // between two nudges (every 240 s by the wall clock) the 20 Hz driver should count 20 ticks a second; it skips
    // the ticks of a stall over 250 ms, so the shortfall is the time lost to stalls
    const nudges = lines.map((l) => ({ t: tsOf(l), m: /nudge \d+ at tick (\d+)/.exec(l) })).filter((x) => x.m).map((x) => ({ t: x.t, tick: Number(x.m[1]) }));
    const rates = nudges.slice(1).map((b, i) => ({ dt: (b.t - nudges[i].t) / 1000, dtick: b.tick - nudges[i].tick })).filter((g) => g.dtick > 0 && g.dt > 0).map((g) => g.dtick / g.dt);
    res.nudgeGaps = rates.length;
    res.nudgeTickRateMean = rates.length ? Math.round((rates.reduce((s, x) => s + x, 0) / rates.length) * 100) / 100 : null;
    res.nudgeTickRateMin = rates.length ? Math.round(Math.min(...rates) * 100) / 100 : null;
    res.series = seriesState(lines, until);
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.error('usage: node scripts/mac/live.mjs check [--max-load N] | watch --out <file> [--interval s] | report --since <iso> [--until <iso>] [--samples <file>]');
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(args[0]);
