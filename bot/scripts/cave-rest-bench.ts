// Track F17 (docs/flight.md "Windows beside the walk (Track F17)"): what `!fly`'s corridor would do over the rest of a
// trip after its landing at a cave's mouth: the executor with the cave style (cave/bench.ts flyTrip) over the private
// cave fixture's coarse layer (corridor/cave-bench.ts caveLayer), from each pair's landing cell (fixture.json) to its
// goal, in worker threads. Needs bot/fixtures-private/<fixture>; prints the trip lines only.
//
//   node scripts/cave-rest-bench.ts [--fixture cave-2026-11-14-wide] [--pairs cave_8,...] [--burns random|9,15,...]
//                                   [--repeat 1] [--kit plain|crafted] [--ms 600] [--workers 8] [--verbose]
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { startWorker } from '../src/threads.ts';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capWorkers } from './workers.ts';
import { caveTripLine, flyTrip, tripWorldOfCave, type CaveBenchOptions, type CaveTrip } from '../src/skills/fly/cave/bench.ts';
import { caveWorld, loadCaveFixture } from '../src/skills/fly/corridor/cave.ts';
import { caveLayer } from '../src/skills/fly/corridor/cave-bench.ts';
import { burnRange } from '../src/skills/fly/burn.ts';
import type { Vec3 } from '../src/world/types.ts';

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};
const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures-private', arg('fixture', 'cave-2026-11-14-wide'));

interface Job {
  tag: string;
  start: Vec3;
  goal: string;
  burn: number | 'random';
  seed: number;
  kit: boolean;
  ms: number;
}

async function runJob(j: Job): Promise<{ job: Job; line: string; notes: string[]; trip: Omit<CaveTrip, 'report' | 'windows'> & { windows: unknown[] } }> {
  const fix = loadCaveFixture(DIR)!;
  const world = caveWorld(fix.extract);
  const g = fix.waypoints.get(j.goal)!;
  const goal = world.feetCell(g) ?? { x: Math.floor(g.x), y: Math.floor(g.y), z: Math.floor(g.z) };
  const notes: string[] = [];
  const o: CaveBenchOptions = { seed: j.seed, burn: j.burn, maxMs: j.ms, style: true, ...(j.kit ? { kit: burnRange(1) } : {}), note: (m) => notes.push(m) };
  const t = await flyTrip(tripWorldOfCave(world, 'the cave'), caveLayer(world), j.start, goal, o, `${j.tag}`);
  const { report: _r, ...rest } = t;
  return { job: j, line: caveTripLine(t), notes, trip: rest };
}

if (!isMainThread) {
  const jobs = workerData as Job[];
  void (async () => {
    for (const j of jobs) parentPort!.postMessage(await runJob(j));
    parentPort!.postMessage('end');
  })();
} else {
  const f = JSON.parse(readFileSync(join(DIR, 'fixture.json'), 'utf8')) as { pairs: { start: Vec3; goal: string; tag: string }[] };
  const want = arg('pairs', 'cave_8,cave_9,cave_16,cave_17,cave_19').split(',');
  const burns = arg('burns', 'random').split(',').map((s) => (s === 'random' ? 'random' : Number(s))) as (number | 'random')[];
  const reps = Number(arg('repeat', '1'));
  const kit = arg('kit', 'plain') === 'crafted';
  const ms = Number(arg('ms', '600'));
  const jobs: Job[] = [];
  for (const p of f.pairs.filter((q) => want.includes(q.tag))) for (let r = 0; r < reps; r++) burns.forEach((burn, i) => jobs.push({ tag: p.tag, start: p.start, goal: p.goal, burn, seed: 1 + i + r * 31, kit, ms }));
  const workers = capWorkers(Number(arg('workers', '8')));
  const chunks: Job[][] = Array.from({ length: workers }, () => []);
  jobs.forEach((j, i) => chunks[i % workers]!.push(j));
  const file = fileURLToPath(import.meta.url);
  const verbose = process.argv.includes('--verbose');
  await Promise.all(
    chunks.filter((c) => c.length).map(
      (c) =>
        new Promise<void>((res, rej) => {
          const w = startWorker(file, { workerData: c, argv: process.argv.slice(2) });
          w.on('message', (m: 'end' | { job: Job; line: string; notes: string[] }) => {
            if (m === 'end') return res();
            console.log(`[${m.job.tag} burn ${m.job.burn} seed ${m.job.seed}] ${m.line}`);
            if (verbose) for (const n of m.notes) console.log(`    ${n}`);
          });
          w.on('error', rej);
        }),
    ),
  );
}
