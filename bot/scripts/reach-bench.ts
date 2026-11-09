// Track R1 (docs/pathfinding.md "Reachability (Track R1)"; decisions/0072-reachability.md): the reachability
// benchmark. Generated worlds per class (nav/bench/worlds.ts), the oracle's verdict per start / goal pair
// (nav/bench/oracle.ts: reachable under the owner's rules, closed by a rule (b), closed by the world (a)), and the
// REAL navigator walking each pair in a closed loop (test/unit/skills/reach-sim.ts: the worker with the live
// budgets scaled to the owner's M4, the coarse layer, chunks loaded round the body). The headline: false
// unreachable, the pairs the oracle reaches under the rules and the navigator gave up on.
//
// Track R2: `--config live` runs the owner's live settings (allowBreak on, allowPlace off since 2026-11-09 (`--place on`:
// the settings before, 2 cobblestone and 64 dirt carried), digPenalty 500; the oracle with the same moves:
// LIVE_RULES), `--config r1` (default) R1's
// (neither on, digPenalty 60, nothing to place). Every end is checked for "stranded": the body can no longer get
// back to its start without a hurting fall (the oracle on the world as the run left it, the bot's own placed blocks
// diggable) while it could from there before the run. `--fixture <name>` runs a private real place
// (nav/bench/fixture.ts, bot/fixtures-private/<name>) instead of the generated worlds, `--repeat n` times.
//
//   node scripts/reach-bench.ts [--classes hills,caves] [--worlds 16] [--seed0 1] [--jobs 6] [--speed 1.25]
//                               [--config r1|live] [--place on|off] [--break on|off] [--dig-penalty n] [--out results.jsonl] [--only cls:seed[:pair][,...]] [--log] [--detail]
//   node scripts/reach-bench.ts --fixture incident [--pairs cave-entry,...] [--repeat 3] [--config live] [--detail]
import { fork } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { capWorkers } from './workers.ts';
import { LIVE_RULES, OWNER_RULES, oracle, verdict, type OracleRules, type Verdict } from '../src/skills/nav/bench/oracle.ts';
import { WORLD_CLASSES, benchWorld, type BenchPair, type BenchWorld, type WorldClass } from '../src/skills/nav/bench/worlds.ts';
import { loadFixture } from '../src/skills/nav/bench/fixture.ts';
import { causeAgrees, scoreTables, type PairRecord } from '../src/skills/nav/bench/score.ts';
import { V, type Vox } from '../src/skills/nav/bench/vox.ts';
import { runPair, type PairRun, type SimOptions } from '../test/unit/skills/reach-sim.ts';
import type { Vec3 } from '../src/world/types.ts';

interface Job {
  cls: WorldClass | 'fixture';
  seed: number;
  pair?: number;
  /** A fixture's run number (--repeat). */
  rep?: number;
}

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const TOOLS = ['iron_pickaxe', 'iron_shovel'];
/** Track R2: what the bench carries to place with the live settings (the incident's pillar began with 2 cobblestone, then dirt). */
const LIVE_BLOCKS = [
  { name: 'cobblestone', count: 2 },
  { name: 'dirt', count: 64 },
];
/** Track R2: the stranded check's oracle stops here (no answer: not counted). */
const BACK_MAX_EXPANDED = 3_000_000;

type Config = 'r1' | 'live';

/** A config's switches: the config's own, each overridden by `--place on|off`, `--break on|off`, `--dig-penalty n`. */
function switches(cfg: Config): { place: boolean; brk: boolean; digPenalty: number } {
  const on = (name: string, dflt: boolean): boolean => (arg(name) === undefined ? dflt : arg(name) === 'on');
  const live = cfg === 'live';
  return { place: on('place', false), brk: on('break', live), digPenalty: Number(arg('dig-penalty') ?? (live ? 500 : 60)) };
}

function simFor(cfg: Config): Partial<SimOptions> {
  const s = switches(cfg);
  return { allowBreak: s.brk, allowPlace: s.place, digPenalty: s.digPenalty, ...(s.place ? { blocks: LIVE_BLOCKS } : {}) };
}

function rulesFor(cfg: Config, bw: BenchWorld): OracleRules {
  const home = bw.home;
  const protect = home && bw.protectRadius ? { x: home.x + 0.5, y: home.y, z: home.z + 0.5, r: bw.protectRadius } : undefined;
  const s = switches(cfg);
  return { ...(s.brk ? LIVE_RULES : OWNER_RULES), place: s.place, tools: TOOLS, protect };
}

/** The feet cell the oracle starts from at `p` (a body in the air or on a placed block: the first floor down). */
function endCell(vox: Vox, p: Vec3): Vec3 {
  const x = Math.floor(p.x);
  const z = Math.floor(p.z);
  let y = Math.floor(p.y + 1e-3);
  while (y > -60 && vox.get(x, y - 1, z) === V.air) y--;
  return { x, y, z };
}

/**
 * Track R2: can the body get back to `start` from `from` without a hurting fall (the rules of the run, falls held at
 * 0 HP, the run's own placed cells diggable)? Undefined when the oracle ran out of its cap.
 */
function back(vox: Vox, from: Vec3, start: Vec3, rules: OracleRules, own: ReadonlySet<number>): boolean | undefined {
  const r = oracle(vox, from, start, { ...rules, fallBudget: 0, own }, { witness: false, maxExpanded: BACK_MAX_EXPANDED });
  return r.reachable ? true : r.capped ? undefined : false;
}

async function runJob(j: Job, speed: number, cfg: Config, send: (r: PairRecord) => void): Promise<void> {
  let bw: BenchWorld;
  let pairs: BenchPair[];
  const fixtureName = arg('fixture');
  if (j.cls === 'fixture') {
    const f = loadFixture(fixtureName!);
    if (!f) throw new Error(`no fixture ${fixtureName}`);
    bw = f.world;
    pairs = bw.pairs;
  } else {
    bw = benchWorld(j.cls, j.seed);
    pairs = bw.pairs;
  }
  const rules = rulesFor(cfg, bw);
  const payloads = new Map<number, Buffer[]>();
  for (let i = 0; i < pairs.length; i++) {
    if (j.pair !== undefined && j.pair !== i) continue;
    const pair = pairs[i]!;
    // (a real place is too big for the exhaustive oracle: its pairs are scored by arrival and the stranded check)
    const v: Verdict = j.cls === 'fixture' ? { verdict: 'reachable', plain: false, rules: [], expanded: 0, ms: 0 } : verdict(bw.vox, pair.start, pair.goal, rules, switches(cfg).brk ? { margin: 32 } : {});
    let run: PairRun;
    let backAfter: boolean | undefined;
    let endAt: Vec3 | undefined;
    let own: ReadonlySet<number> = new Set();
    try {
      run = await runPair(bw, pair, payloads, {
        tools: TOOLS,
        speed,
        ...simFor(cfg),
        ...(j.cls === 'fixture' ? { preload: true, timeoutTicks: 12_000 } : {}),
        ...(j.pair !== undefined || j.cls === 'fixture' ? { logLines: process.argv.includes('--debug') ? 4000 : 400 } : {}),
        ...(process.argv.includes('--debug') ? { debug: true } : {}),
        after: (vox, end, placed) => {
          endAt = endCell(vox, end);
          own = new Set(placed);
          const ok = Math.hypot(end.x - (pair.goal.x + 0.5), end.z - (pair.goal.z + 0.5)) < 1.5 && Math.abs(end.y - pair.goal.y) < 1.5;
          if (!ok) backAfter = back(vox, endAt, pair.start, rules, own);
        },
      });
    } catch (e) {
      run = { ok: false, reason: 'harness error', note: e instanceof Error ? (e.stack ?? e.message).slice(0, 400) : String(e), reply: 'harness error', ticks: 0, wallMs: 0, damage: 0, died: false, dug: 0, doors: 0, placed: 0, endPos: pair.start, endDist: -1, plans: 0, failures: 0, log: [] };
    }
    // stranded: no way back now, a way back from there before the run (a cell the run built: from the ground under it)
    if (backAfter === false && endAt) {
      const before = back(bw.vox, endCell(bw.vox, endAt), pair.start, rules, new Set());
      run.stranded = before === true;
    } else if (backAfter === true) run.stranded = false;
    if (j.pair !== undefined || j.cls === 'fixture') {
      if (process.argv.includes('--detail')) {
        // one pair: the oracle's witness and the navigator's log
        console.log(`oracle ${v.verdict} plain ${v.plain} rules ${v.rules.join(',')} dug ${v.dug} dmg ${v.dmg} (${v.ms} ms, ${v.expanded} expanded)`);
        if (v.path) console.log(`witness: ${v.path.map((s) => `${s.move}@${s.x},${s.y},${s.z}`).join(' ')}`);
        console.log(`run: ${JSON.stringify({ ...run, log: undefined })}`);
        for (const l of run.log) console.log(`  | ${l}`);
      }
    }
    const { path: _p, ...ov } = v;
    send({ cls: j.cls === 'fixture' ? `fixture:${pair.tag}` : j.cls, seed: j.rep ?? j.seed, pair: i, tag: pair.tag, start: pair.start, goal: pair.goal, dist: Math.round(Math.hypot(pair.goal.x - pair.start.x, pair.goal.z - pair.start.z)), oracle: ov, run, agree: causeAgrees(ov, run), cfg });
  }
}

function child(): void {
  const speed = Number(arg('speed') ?? 1.25);
  const cfg = (arg('config') ?? 'r1') as Config;
  process.on('message', (j: Job | { done: true }) => {
    if ('done' in j) process.exit(0);
    runJob(j, speed, cfg, (r) => process.send!({ rec: r })).then(
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
  const jobsN = capWorkers(Number(arg('jobs') ?? 6));
  const out = arg('out') ?? 'reach-bench.jsonl';
  const only = arg('only');
  const fixture = arg('fixture');
  const jobs: Job[] = [];
  if (fixture) {
    const f = loadFixture(fixture);
    if (!f) {
      console.log(`no fixture ${fixture} (bot/fixtures-private/${fixture}/fixture.json): skipped`);
      return;
    }
    const want = arg('pairs')?.split(',');
    const repeat = Number(arg('repeat') ?? 1);
    for (let rep = 1; rep <= repeat; rep++)
      f.world.pairs.forEach((p, i) => {
        if (!want || want.includes(p.tag)) jobs.push({ cls: 'fixture', seed: 0, pair: i, rep });
      });
  } else if (only) {
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
        const c = fork(self, ['--child', ...process.argv.slice(2)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], execArgv: ['--max-old-space-size=6144'] });
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
            if (process.argv.includes('--log') || only !== undefined || fixture !== undefined || (!r.run.ok && r.oracle.verdict === 'reachable') || r.run.stranded)
              console.log(`${r.cls}:${r.seed}:${r.pair} ${r.tag} d${r.dist} oracle ${r.oracle.verdict}${r.oracle.rules.length ? `(${r.oracle.rules.join('|')})` : ''} -> ${r.run.ok ? 'arrived' : r.run.reply} [${r.run.ticks}t ${r.run.wallMs}ms dmg ${r.run.damage}${r.run.died ? ' DIED' : ''} dug ${r.run.dug} placed ${r.run.placed}${r.run.stranded ? ' STRANDED' : ''}]`);
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
