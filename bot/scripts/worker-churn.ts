// Track I1 (decision 0089): start and end planner workers as the navigator tests do, in many processes, and count the
// processes V8 aborts (`Check failed: ...` in the wasm import wrapper code, SIGTRAP on macOS). The repro and the bar of
// src/threads.ts's guard.
//
//   node scripts/worker-churn.ts [--procs 100] [--jobs 4] [--cycles 40] [--alive 2] [--minutes 12] [--guard]
//                                [--flag <v8 flag>]... [--cache] [--hold <ms>] [--worker planner|route|plain]
//
// A child process starts `--cycles` workers on the planner's source (nav/worker.ts), `--alive` at a time: each one is
// ended (terminate, not awaited, as PlannerClient.kill does) once it posts `ready` (and `--hold` ms later), and the next
// starts at once, so one worker loads its sources (wasm: the type stripping) while another one ends. `--guard` starts
// them through src/threads.ts (the fix); `--flag` passes a node / V8 flag to the children; `--cache` gives the children a
// warm compile cache (NODE_COMPILE_CACHE: the stripped sources come from disk, no wasm runs in the workers). Without it
// the children's NODE_COMPILE_CACHE is unset. One JSON line a child, then a summary line (aborts per 100 processes).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Worker } from 'node:worker_threads';
import { capWorkers } from './workers.ts';

const { values: a } = parseArgs({
  options: {
    child: { type: 'boolean', default: false },
    procs: { type: 'string', default: '100' },
    jobs: { type: 'string', default: '4' },
    cycles: { type: 'string', default: '40' },
    alive: { type: 'string', default: '2' },
    minutes: { type: 'string', default: '12' },
    hold: { type: 'string', default: '0' },
    guard: { type: 'boolean', default: false },
    cache: { type: 'boolean', default: false },
    flag: { type: 'string', multiple: true, default: [] },
    worker: { type: 'string', default: 'planner' },
  },
});

const here = fileURLToPath(new URL('.', import.meta.url));
const WORKERS: Record<string, { file: URL; data: Record<string, boolean> }> = {
  planner: { file: pathToFileURL(join(here, '../src/skills/nav/worker.ts')), data: { bedrockbotPlanner: true } },
  route: { file: pathToFileURL(join(here, '../src/skills/fly/route/worker.ts')), data: { bedrockbotRoute: true } },
};

async function child(): Promise<void> {
  const cycles = Number(a.cycles);
  const alive = Math.max(1, Number(a.alive));
  const hold = Number(a.hold);
  const kind = WORKERS[a.worker] ?? WORKERS.planner!;
  const start = a.guard ? (await import('../src/threads.ts')).startWorker : (u: URL, o: object) => new Worker(u, o);
  let started = 0;
  let ended = 0;
  const t0 = performance.now();
  await new Promise<void>((resolve) => {
    const next = (): void => {
      if (started >= cycles) return;
      started++;
      const w = start(kind.file, { workerData: kind.data, name: a.worker });
      // the route worker posts nothing until asked: it counts as up once it is online
      const up = (): void => {
        setTimeout(() => {
          void w.terminate();
          next();
        }, hold);
      };
      if (a.worker === 'route') w.once('online', up);
      else w.once('message', up);
      w.once('exit', () => {
        if (++ended >= cycles) resolve();
      });
      w.on('error', () => {});
    };
    for (let i = 0; i < alive; i++) next();
  });
  const mem = process.memoryUsage();
  process.stdout.write(`${JSON.stringify({ cycles, ms: Math.round(performance.now() - t0), rssMB: +(mem.rss / 1e6).toFixed(1) })}\n`);
}

async function driver(): Promise<void> {
  const procs = Number(a.procs);
  const jobs = capWorkers(Number(a.jobs));
  const deadline = Date.now() + Number(a.minutes) * 60_000;
  const self = fileURLToPath(import.meta.url);
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_COMPILE_CACHE;
  let cacheDir: string | undefined;
  const childArgs = ['--child', '--cycles', a.cycles, '--alive', a.alive, '--hold', a.hold, '--worker', a.worker, ...(a.guard ? ['--guard'] : [])];
  const run = (n: number): Promise<{ n: number; code: number | null; signal: string | null; check: string | undefined; out: string; ms: number }> =>
    new Promise((resolve) => {
      const t0 = Date.now();
      const c = spawn(process.execPath, [...a.flag, self, ...childArgs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      c.stdout.on('data', (d: Buffer) => (out += d.toString()));
      c.stderr.on('data', (d: Buffer) => (err += d.toString()));
      c.on('close', (code, signal) => resolve({ n, code, signal, check: /Check failed: [^\n]*/.exec(err)?.[0], out: out.trim(), ms: Date.now() - t0 }));
    });
  if (a.cache) {
    cacheDir = mkdtempSync(join(tmpdir(), 'churn-cache-'));
    env.NODE_COMPILE_CACHE = cacheDir;
    await run(-1); // fills the cache
  }
  console.log(JSON.stringify({ node: process.versions.node, v8: process.versions.v8, platform: `${process.platform}-${process.arch}`, procs, jobs, cycles: Number(a.cycles), alive: Number(a.alive), hold: Number(a.hold), worker: a.worker, guard: a.guard, cache: a.cache, flags: a.flag }));
  let done = 0;
  let aborts = 0;
  let other = 0;
  let next = 0;
  const checks = new Map<string, number>();
  const rss: number[] = [];
  /** A child's time over its workers (with --alive 1: start, ready, end of one worker after another). */
  const perWorker: number[] = [];
  const t0 = Date.now();
  await new Promise<void>((resolve) => {
    let running = 0;
    const launch = (): void => {
      while (running < jobs && next < procs && Date.now() < deadline) {
        running++;
        void run(next++).then((r) => {
          running--;
          done++;
          const aborted = r.signal === 'SIGTRAP' || r.signal === 'SIGILL' || r.signal === 'SIGABRT' || r.signal === 'SIGSEGV' || r.check !== undefined || (r.code !== null && r.code >= 128);
          if (aborted) {
            aborts++;
            if (r.check) checks.set(r.check, (checks.get(r.check) ?? 0) + 1);
          } else if (r.code !== 0) other++;
          try {
            const m = JSON.parse(r.out) as { rssMB?: number; ms?: number; cycles?: number };
            if (m.rssMB) rss.push(m.rssMB);
            if (m.ms && m.cycles) perWorker.push(m.ms / m.cycles);
          } catch {
            /* an aborted child writes no line */
          }
          console.log(JSON.stringify({ n: r.n, code: r.code, signal: r.signal, aborted, check: r.check, ms: r.ms, out: r.out.slice(0, 200) }));
          if (running === 0 && (next >= procs || Date.now() >= deadline)) resolve();
          else launch();
        });
      }
      if (running === 0) resolve();
    };
    launch();
  });
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
  rss.sort((x, y) => x - y);
  perWorker.sort((x, y) => x - y);
  const cycles = Number(a.cycles);
  console.log(JSON.stringify({ summary: true, procs: done, aborts, other, abortsPer100: +((aborts * 100) / Math.max(1, done)).toFixed(1), workerEnds: done * cycles, checks: Object.fromEntries(checks), rssMedianMB: rss[rss.length >> 1], msPerWorkerMedian: perWorker.length ? +perWorker[perWorker.length >> 1]!.toFixed(1) : undefined, s: Math.round((Date.now() - t0) / 1000) }));
  process.exitCode = aborts > 0 ? 1 : 0;
}

await (a.child ? child() : driver());
