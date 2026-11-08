// Track R1 (docs/pathfinding.md "Reachability (Track R1)"; decisions/0072-reachability.md): the reachability
// benchmark. Generated worlds per class (nav/bench/worlds.ts), the oracle's verdict per start / goal pair
// (nav/bench/oracle.ts: reachable under the owner's rules, closed by a rule (b), closed by the world (a)), and the
// REAL navigator walking each pair in a closed loop (test/unit/skills/reach-sim.ts: the worker with the live
// budgets scaled to the owner's M4, the coarse layer, chunks loaded round the body). The headline: false
// unreachable, the pairs the oracle reaches under the rules and the navigator gave up on.
//
//   node scripts/reach-bench.ts [--classes hills,caves] [--worlds 16] [--seed0 1] [--jobs 6] [--speed 1.25]
//                               [--out results.jsonl] [--only cls:seed[:pair][,...]] [--log] [--detail]
import { fork } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OWNER_RULES, verdict, type Verdict } from '../src/skills/nav/bench/oracle.ts';
import { WORLD_CLASSES, benchWorld, type WorldClass } from '../src/skills/nav/bench/worlds.ts';
import { causeAgrees, scoreTables, type PairRecord } from '../src/skills/nav/bench/score.ts';
import { runPair, type PairRun } from '../test/unit/skills/reach-sim.ts';

interface Job {
  cls: WorldClass;
  seed: number;
  pair?: number;
}

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const TOOLS = ['iron_pickaxe', 'iron_shovel'];

async function runJob(j: Job, speed: number, send: (r: PairRecord) => void): Promise<void> {
  const bw = benchWorld(j.cls, j.seed);
  const home = bw.home;
  const rules = { ...OWNER_RULES, tools: TOOLS, protect: home && bw.protectRadius ? { x: home.x + 0.5, y: home.y, z: home.z + 0.5, r: bw.protectRadius } : undefined };
  const payloads = new Map<number, Buffer[]>();
  for (let i = 0; i < bw.pairs.length; i++) {
    if (j.pair !== undefined && j.pair !== i) continue;
    const pair = bw.pairs[i]!;
    const v: Verdict = verdict(bw.vox, pair.start, pair.goal, rules);
    let run: PairRun;
    try {
      run = await runPair(bw, pair, payloads, { tools: TOOLS, speed, ...(j.pair !== undefined ? { logLines: 400 } : {}) });
    } catch (e) {
      run = { ok: false, reason: 'harness error', note: e instanceof Error ? (e.stack ?? e.message).slice(0, 400) : String(e), reply: 'harness error', ticks: 0, wallMs: 0, damage: 0, died: false, dug: 0, doors: 0, placed: 0, endPos: pair.start, endDist: -1, plans: 0, failures: 0, log: [] };
    }
    if (j.pair !== undefined && process.argv.includes("--detail")) {
      // one pair: the oracle's witness and the navigator's log
      console.log(`oracle ${v.verdict} plain ${v.plain} rules ${v.rules.join(',')} dug ${v.dug} dmg ${v.dmg} (${v.ms} ms, ${v.expanded} expanded)`);
      if (v.path) console.log(`witness: ${v.path.map((s) => `${s.move}@${s.x},${s.y},${s.z}`).join(' ')}`);
      console.log(`run: ${JSON.stringify({ ...run, log: undefined })}`);
      for (const l of run.log) console.log(`  | ${l}`);
    }
    const { path: _p, ...ov } = v;
    send({ cls: j.cls, seed: j.seed, pair: i, tag: pair.tag, start: pair.start, goal: pair.goal, dist: Math.round(Math.hypot(pair.goal.x - pair.start.x, pair.goal.z - pair.start.z)), oracle: ov, run, agree: causeAgrees(ov, run) });
  }
}

function child(): void {
  const speed = Number(arg('speed') ?? 1.25);
  process.on('message', (j: Job | { done: true }) => {
    if ('done' in j) process.exit(0);
    runJob(j, speed, (r) => process.send!({ rec: r })).then(
      () => process.send!({ jobDone: true }),
      (e: unknown) => process.send!({ jobDone: true, error: e instanceof Error ? (e.stack ?? e.message) : String(e) }),
    );
  });
  process.send!({ ready: true });
}

async function main(): Promise<void> {
  const classes = (arg('classes')?.split(',') ?? [...WORLD_CLASSES]) as WorldClass[];
  const worlds = Number(arg('worlds') ?? 16);
  const seed0 = Number(arg('seed0') ?? 1);
  const jobsN = Number(arg('jobs') ?? 6);
  const out = arg('out') ?? 'reach-bench.jsonl';
  const only = arg('only');
  const jobs: Job[] = [];
  if (only) {
    for (const o of only.split(',')) {
      const [c, s, p] = o.split(':');
      jobs.push({ cls: c as WorldClass, seed: Number(s), ...(p !== undefined ? { pair: Number(p) } : {}) });
    }
  } else for (let k = 0; k < worlds; k++) for (const cls of classes) jobs.push({ cls, seed: seed0 + k });
  writeFileSync(out, '');
  const recs: PairRecord[] = [];
  const self = fileURLToPath(import.meta.url);
  let next = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: Math.min(jobsN, jobs.length) }, () => {
      return new Promise<void>((resolve) => {
        const c = fork(self, ['--child', ...process.argv.slice(2)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        const give = (): void => {
          const j = jobs[next++];
          if (j) c.send(j);
          else c.send({ done: true });
        };
        c.on('message', (m: { ready?: boolean; rec?: PairRecord; jobDone?: boolean; error?: string }) => {
          if (m.rec) {
            recs.push(m.rec);
            appendFileSync(out, JSON.stringify(m.rec) + '\n');
            const r = m.rec;
            if (process.argv.includes("--log") || only !== undefined || (!r.run.ok && r.oracle.verdict === "reachable"))
              console.log(`${r.cls}:${r.seed}:${r.pair} ${r.tag} d${r.dist} oracle ${r.oracle.verdict}${r.oracle.rules.length ? `(${r.oracle.rules.join('|')})` : ''} -> ${r.run.ok ? 'arrived' : r.run.reply} [${r.run.ticks}t ${r.run.wallMs}ms dmg ${r.run.damage}${r.run.died ? ' DIED' : ''}]`);
          }
          if (m.error) console.error(`job error: ${m.error}`);
          if (m.ready || m.jobDone) give();
        });
        c.on('exit', () => resolve());
      });
    }),
  );
  console.log(scoreTables(recs));
  console.log(`${recs.length} pairs in ${((performance.now() - t0) / 1000).toFixed(0)} s; results in ${out}`);
}

if (process.argv.includes('--child')) child();
else void main();
