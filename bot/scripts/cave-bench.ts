// Track F5a (docs/flight.md "Real-cave benchmark (Track F5a)"): the cave benchmark's scoreboard, in parallel worker
// processes. Needs the private fixture (bot/fixtures-private/cave or CAVE_FIXTURE_DIR); without it it says so and exits 0.
//
//   node scripts/cave-bench.ts [--mode leg,route,executor,walk] [--route A,B] [--legs 0,3 | --legs "cave_4 -> cave_5"]
//                              [--burns 9-21 | 9,15,21 | random] [--budget live,generous] [--latency 0] [--jobs 16]
//                              [--json out.json]
//
//   leg       each leg as one window from standing (bends + landing), the TrackerChain on stepBody
//   route     the whole route as one window (a waypoint box at every waypoint)
//   executor  each leg through the corridor executor with underFly true (the coarse layer, stretches, windows, walks)
//   walk      each leg walked by the navigator in a closed loop (the walk-only baseline)
// Defaults: every mode, routes A and B, every leg, burns 9..21, both budgets, latency 0, jobs = cores / 2.
import { fork } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { caveLegs, caveWorld, loadCaveFixture, ROUTE_A, ROUTE_B, type CaveFixture, type CaveLeg, type CaveWorld } from '../src/skills/fly/corridor/cave.ts';
import { CAVE_BUDGETS, CAVE_BURNS, CAVE_SCORE_HEADER, caveGoals, caveScore, caveScoreRow, flyCaveWindow, runCaveExecutor, type CaveBudget, type FlightRun } from '../src/skills/fly/corridor/cave-bench.ts';
import { caveWalker } from '../test/unit/skills/fly-cave-walk.ts';

type Mode = 'leg' | 'route' | 'executor' | 'walk';
interface Job {
  id: number;
  mode: Mode;
  route: 'A' | 'B';
  leg: number;
  burn: number | 'random';
  seed: number;
  budget: CaveBudget;
  latency: number;
}
interface ExecSummary {
  ok: boolean;
  reason?: string;
  legs: string;
  windows: number;
  windowsDone: number;
  skies: number;
  walks: number;
  walkFails: number;
  ticks: number;
  rockets: number;
  hits: number;
  damage: number;
  minClearance: number;
  partial: number;
  waterTicks: number;
  flownBlocks: number;
  walkBlocks: number;
}
interface WalkSummary {
  ok: boolean;
  ticks: number;
  reason?: string;
  waterTicks: number;
}
interface Result {
  id: number;
  ms: number;
  flight?: FlightRun;
  exec?: ExecSummary;
  walk?: WalkSummary;
  error?: string;
}

const ROUTES = { A: ROUTE_A, B: ROUTE_B } as const;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function legsOf(fix: CaveFixture, w: CaveWorld, r: 'A' | 'B'): CaveLeg[] {
  return caveLegs(fix, w, ROUTES[r]);
}

async function runJob(fix: CaveFixture, w: CaveWorld, j: Job): Promise<Result> {
  const t0 = performance.now();
  const legs = legsOf(fix, w, j.route);
  const budget = CAVE_BUDGETS[j.budget];
  const flight = { burn: j.burn, seed: j.seed, ...budget, latency: j.latency };
  const centre = (c: { x: number; y: number; z: number }) => ({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 });
  if (j.mode === 'route') {
    const stops = [legs[0]!.from, ...legs.map((l) => l.to)];
    const f = await flyCaveWindow(w, centre(stops[0]!), caveGoals(w, stops), { ...flight, maxTicks: 4000 });
    return { id: j.id, ms: performance.now() - t0, flight: f };
  }
  const leg = legs[j.leg]!;
  if (j.mode === 'leg') {
    const f = await flyCaveWindow(w, centre(leg.from), caveGoals(w, [leg.from, leg.to]), flight);
    return { id: j.id, ms: performance.now() - t0, flight: f };
  }
  if (j.mode === 'walk') {
    const r = await caveWalker(w)(centre(leg.from), leg.to);
    return { id: j.id, ms: performance.now() - t0, walk: { ok: r.ok, ticks: r.ticks, waterTicks: r.waterTicks ?? 0, ...(r.reason ? { reason: r.reason } : {}) } };
  }
  const e = await runCaveExecutor(w, leg, { ...flight, walk: caveWalker(w) });
  return {
    id: j.id,
    ms: performance.now() - t0,
    exec: {
      ok: e.ok,
      ...(e.reason ? { reason: e.reason } : {}),
      legs: e.report.legs.map((l) => `${l.how} ${l.blocks}${l.ok ? '' : ' x'}`).join(', '),
      windows: e.flights.length,
      windowsDone: e.flights.filter((f) => f.end === 'done').length,
      skies: e.skies,
      walks: e.walks.length,
      walkFails: e.walks.filter((x) => !x.ok).length,
      ticks: e.ticks,
      rockets: e.rockets,
      hits: e.hits,
      damage: e.damage,
      minClearance: e.minClearance,
      partial: e.partial,
      waterTicks: e.waterTicks,
      flownBlocks: e.flownBlocks,
      walkBlocks: e.walkBlocks,
    },
  };
}

function worker(): void {
  const fix = loadCaveFixture()!;
  const w = caveWorld(fix.extract);
  process.on('message', (j: Job) => {
    runJob(fix, w, j).then(
      (r) => process.send!(r),
      (e: unknown) => process.send!({ id: j.id, ms: 0, error: e instanceof Error ? (e.stack ?? e.message) : String(e) }),
    );
  });
  process.send!({ ready: true });
}

function parseBurns(s: string | undefined): (number | 'random')[] {
  if (!s) return [...CAVE_BURNS];
  if (s === 'random') return ['random', 'random', 'random'];
  const m = /^(\d+)-(\d+)$/.exec(s);
  if (m) return Array.from({ length: Number(m[2]) - Number(m[1]) + 1 }, (_, i) => Number(m[1]) + i);
  return s.split(',').map((x) => (x === 'random' ? 'random' : Number(x)));
}

async function main(): Promise<number> {
  const fix = loadCaveFixture();
  if (!fix) {
    console.log(`cave bench: no fixture in ${process.env.CAVE_FIXTURE_DIR ?? 'bot/fixtures-private/cave'} (extract.json, waypoints.json): nothing to do`);
    return 0;
  }
  const w = caveWorld(fix.extract);
  const modes = (arg('mode') ?? 'leg,route,executor,walk').split(',') as Mode[];
  const routes = (arg('route') ?? 'A,B').split(',') as ('A' | 'B')[];
  const burns = parseBurns(arg('burns'));
  const budgets = (arg('budget') ?? 'live,generous').split(',') as CaveBudget[];
  const latency = Number(arg('latency') ?? 0);
  const legSel = arg('legs');
  const jobsN = Number(arg('jobs') ?? Math.max(1, Math.floor(availableParallelism() / 2)));
  const jobs: Job[] = [];
  for (const mode of modes) {
    for (const route of routes) {
      const legs = legsOf(fix, w, route);
      const picked = legs.map((l, i) => ({ l, i })).filter(({ l, i }) => !legSel || legSel.split(',').some((s) => s.trim() === String(i) || s.trim() === l.name));
      const idx = mode === 'route' ? [-1] : picked.map((p) => p.i);
      for (const leg of idx) {
        if (mode === 'walk') {
          jobs.push({ id: jobs.length, mode, route, leg, burn: 15, seed: 1, budget: 'live', latency });
          continue;
        }
        for (const budget of budgets) burns.forEach((burn, k) => jobs.push({ id: jobs.length, mode, route, leg, burn, seed: 1 + k, budget, latency }));
      }
    }
  }
  const t0 = performance.now();
  console.log(`cave bench: ${jobs.length} jobs on ${jobsN} workers (box ${w.extract.size.x} x ${w.extract.size.y} x ${w.extract.size.z}, ${w.extract.unknown.length} unknown chunks)`);
  const results = new Map<number, Result>();
  await new Promise<void>((resolve) => {
    let next = 0;
    let live = 0;
    const self = fileURLToPath(import.meta.url);
    for (let k = 0; k < Math.min(jobsN, jobs.length); k++) {
      const child = fork(self, ['--worker'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      live++;
      const give = (): void => {
        const j = jobs[next++];
        if (j) child.send(j);
        else {
          child.kill();
          if (--live === 0) resolve();
        }
      };
      child.on('message', (m: Result | { ready: true }) => {
        if ('id' in m) {
          results.set(m.id, m);
          if (results.size % 25 === 0) console.log(`  ${results.size} / ${jobs.length} (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
        }
        give();
      });
    }
  });
  console.log(`cave bench: done in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  const errors = [...results.values()].filter((r) => r.error);
  for (const e of errors.slice(0, 3)) console.log(`error in job ${e.id}: ${e.error}`);
  // the tables
  const out: string[] = [];
  for (const mode of modes) {
    for (const route of routes) {
      const legs = legsOf(fix, w, route);
      if (mode === 'walk') {
        out.push(`\n### walk only, route ${route} (the navigator in a closed loop)\n\n| leg | blocks | walked | ticks | water ticks | why not |\n|---|---|---|---|---|---|`);
        for (const j of jobs.filter((j) => j.mode === mode && j.route === route)) {
          const r = results.get(j.id)?.walk;
          const l = legs[j.leg]!;
          out.push(`| ${l.name} | ${l.blocks.toFixed(0)} | ${r?.ok ? 'yes' : 'no'} | ${r?.ticks ?? '-'} | ${r?.waterTicks ?? '-'} | ${r?.ok ? '-' : (r?.reason ?? results.get(j.id)?.error?.split('\n')[0] ?? '?')} |`);
        }
        continue;
      }
      for (const budget of budgets) {
        const mine = jobs.filter((j) => j.mode === mode && j.route === route && j.budget === budget);
        if (!mine.length) continue;
        const b = CAVE_BUDGETS[budget];
        const title = `${mode}, route ${route}, ${budget} budget (${b.maxMs} ms / ${b.maxNodes} nodes${latency ? `, answers ${latency} ticks late` : ''}), burns ${burns.join(' ')}`;
        if (mode === 'executor') {
          out.push(`\n### ${title}\n\n| leg | arrived | windows flown (done) | sky | walks (failed) | flown / walked blocks | rockets | hits | damage | min clearance | partial | the corridor |\n|---|---|---|---|---|---|---|---|---|---|---|---|`);
          const byLeg = new Map<number, ExecSummary[]>();
          for (const j of mine) {
            const e = results.get(j.id)?.exec;
            if (e) byLeg.set(j.leg, [...(byLeg.get(j.leg) ?? []), e]);
          }
          for (const [leg, es] of [...byLeg.entries()].sort((a, b2) => a[0] - b2[0])) {
            const n = es.length;
            const m = (f: (e: ExecSummary) => number): string => (es.reduce((a, e) => a + f(e), 0) / n).toFixed(1);
            const minC = Math.min(...es.map((e) => e.minClearance));
            const ways = [...new Set(es.map((e) => e.legs))].slice(0, 2).join(' / ');
            out.push(`| ${legs[leg]!.name} | ${es.filter((e) => e.ok).length}/${n} | ${m((e) => e.windows)} (${m((e) => e.windowsDone)}) | ${m((e) => e.skies)} | ${m((e) => e.walks)} (${m((e) => e.walkFails)}) | ${m((e) => e.flownBlocks)} / ${m((e) => e.walkBlocks)} | ${m((e) => e.rockets)} | ${m((e) => e.hits)} | ${m((e) => e.damage)} | ${Number.isFinite(minC) ? minC.toFixed(2) : '-'} | ${m((e) => e.partial)} | ${ways} |`);
          }
          continue;
        }
        out.push(`\n### ${title}\n\n${CAVE_SCORE_HEADER}`);
        const groups = mode === 'route' ? [{ name: `route ${route} (${legs.length} legs)`, leg: -1 }] : legs.map((l, i) => ({ name: l.name, leg: i }));
        for (const g of groups) {
          const rs = mine.filter((j) => j.leg === g.leg).map((j) => results.get(j.id)?.flight).filter((f): f is FlightRun => !!f);
          if (rs.length) out.push(caveScoreRow(caveScore(g.name, rs)));
        }
      }
    }
  }
  console.log(out.join('\n'));
  const json = arg('json');
  if (json) writeFileSync(json, JSON.stringify({ jobs, results: [...results.values()] }));
  return errors.length ? 1 : 0;
}

if (process.argv.includes('--worker')) worker();
else void main().then((c) => process.exit(c));
