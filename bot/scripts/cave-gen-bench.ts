// Track F5b: the cave bench from the command line (docs/flight.md "Cave flight (Track F5b)").
//
//   node scripts/cave-gen-bench.ts [--mode corridor|waypoints|both] [--style <variant>[,<variant>...]] [--burns all|nominal|random]
//                              [--ms 600] [--nodes 40000] [--caves 12] [--only 0,3,5] [--workers 8] [--verbose]
//
// Flies the GENERALISATION set (route/caves.ts caveSet) with the executor over the coarse layer's own corridor
// (`corridor`: no waypoints) and / or over the generator's waypoints (`waypoints`), with the cave style on
// (`on`: CAVE_STYLE), off (`off`: Track F4b's windows and no rules) or a named variant of the style (VARIANTS
// below: one number changed at a time), over CAVE_BURNS (every rocket 9 / 12 / 15 / 18 / 21 ticks, then three
// random draws) at the planner budget given, in worker threads (one trip per job). Prints a line per trip and
// the score per (mode, style) and per cave.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CAVE_BURNS, caveScoreLine, caveTripLine, flyCaveCorridor, flyCaveWaypoints, scoreCaves, type CaveBenchOptions, type CaveTrip } from '../src/skills/fly/cave/bench.ts';
import type { CaveStyle } from '../src/skills/fly/cave/style.ts';
import { caveSet } from '../src/skills/fly/route/caves.ts';

/** The style's variants: `on` is CAVE_STYLE, `off` Track F4b's flight, the rest one change each. */
const VARIANTS: Record<string, { style: boolean; variant?: Partial<CaveStyle> }> = {
  on: { style: true },
  off: { style: false },
  rules0: { style: true, variant: { chainWindow: 5, riskCost: 0.5, marginExtra: 0, prove: false, windowBlocks: 320, tailMin: 40, rules: { commitTicks: 0, partialStop: false, bailAfter: undefined, completeOnly: false, replanLead: 0, bailError: undefined } } },
  noprove: { style: true, variant: { prove: false } },
  partialok: { style: true, variant: { rules: { completeOnly: false } } },
  nolead: { style: true, variant: { rules: { replanLead: 0 } } },
  noerr: { style: true, variant: { rules: { bailError: undefined } } },
  err3: { style: true, variant: { rules: { bailError: 3 } } },
  norobust: { style: true, variant: { proveRobust: false } },
  prove600: { style: true, variant: { proveMs: 600, proveNodes: 40_000 } },
  win5: { style: true, variant: { chainWindow: 5 } },
  win2: { style: true, variant: { chainWindow: 2 } },
  risk05: { style: true, variant: { riskCost: 0.5 } },
  risk4: { style: true, variant: { riskCost: 4 } },
  margin0: { style: true, variant: { marginExtra: 0 } },
  margin2: { style: true, variant: { marginExtra: 0.2 } },
  nostop: { style: true, variant: { rules: { partialStop: false } } },
  nobail: { style: true, variant: { rules: { bailAfter: undefined, partialStop: false } } },
  commit20: { style: true, variant: { rules: { commitTicks: 20 } } },
  speed11: { style: true, variant: { rules: { fireSpeedMax: 1.1 } } },
  blocks64: { style: true, variant: { windowBlocks: 64 } },
  blocks160: { style: true, variant: { windowBlocks: 160 } },
  // Track F6: the pieces, the field, the re-timed reference, the margin rule, the landing zone, the proof budget
  f5b: { style: true, variant: { pieces: 0, geodesic: false, landReach: 2, marginExtraFrom: 0, rules: { retime: false } } },
  nopieces: { style: true, variant: { pieces: 0 } },
  pieces2: { style: true, variant: { pieces: 2 } },
  geo: { style: true, variant: { geodesic: true } },
  noretime: { style: true, variant: { rules: { retime: false } } },
  margin3: { style: true, variant: { marginExtraFrom: 0 } },
  reach2: { style: true, variant: { landReach: 2 } },
  err10: { style: true, variant: { rules: { bailError: 1.0 } } },
  prove6s: { style: true, variant: { proveMs: 6000, proveNodes: 200_000 } },
  // Track F7: the tube controller off (F6's tracker on this code), and its pieces
  notube: { style: true, variant: { rules: { tube: false } } },
  bbail: { style: true, variant: { rules: { blockedBail: true } } },
  nobbail: { style: true, variant: { rules: { blockedBail: false } } },
  err15: { style: true, variant: { rules: { bailError: 1.5 } } },
  err20: { style: true, variant: { rules: { bailError: 2.0 } } },
};

interface Job {
  cave: number;
  mode: 'corridor' | 'waypoints';
  style: string;
  burn: number | 'random';
  seed: number;
  ms: number;
  nodes: number;
}

type Done = Omit<CaveTrip, 'report' | 'windows'> & { windows: number; job: Job };

async function runJob(j: Job): Promise<Done> {
  const cave = caveSet()[j.cave]!;
  const v = VARIANTS[j.style] ?? VARIANTS.on!;
  const o: CaveBenchOptions = { seed: j.seed, burn: j.burn, maxMs: j.ms, maxNodes: j.nodes, style: v.style, ...(v.variant ? { variant: v.variant } : {}) };
  const t = j.mode === 'corridor' ? await flyCaveCorridor(cave, o) : await flyCaveWaypoints(cave, o);
  const { report: _r, windows, ...rest } = t;
  return { ...rest, windows: windows.length, job: j };
}

if (!isMainThread) {
  const jobs = workerData as Job[];
  void (async () => {
    for (const j of jobs) parentPort!.postMessage(await runJob(j));
    parentPort!.postMessage('end');
  })();
} else {
  const arg = (name: string, def: string): string => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
  };
  const modes = ((m) => (m === 'both' ? ['corridor', 'waypoints'] : [m]))(arg('mode', 'corridor')) as Job['mode'][];
  const styles = arg('style', 'on').split(',');
  for (const s of styles) if (!VARIANTS[s]) throw new Error(`unknown style ${s} (${Object.keys(VARIANTS).join(', ')})`);
  const burns = ((b) => (b === 'all' ? CAVE_BURNS : b === 'nominal' ? [15] : b === 'random' ? ['random', 'random', 'random'] : b.split(',').map((s) => (s === 'random' ? 'random' : Number(s)))))(arg('burns', 'all')) as (number | 'random')[];
  const ms = Number(arg('ms', '600'));
  const nodes = Number(arg('nodes', '40000'));
  const set = caveSet();
  const only = arg('only', '');
  const caves = only ? only.split(',').map(Number) : Array.from({ length: Math.min(set.length, Number(arg('caves', String(set.length)))) }, (_, i) => i);
  const workers = Math.max(1, Number(arg('workers', String(Math.min(8, availableParallelism())))));
  const verbose = process.argv.includes('--verbose');
  const jobs: Job[] = [];
  for (const mode of modes) for (const style of styles) for (const c of caves) burns.forEach((burn, i) => jobs.push({ cave: c, mode, style, burn, seed: 1 + i, ms, nodes }));
  console.log(`cave bench: ${set.length} caves (${set.map((c) => `${c.name}: ${c.kind}, ${c.centre.length} blocks, ${c.waypoints.length} waypoints, narrowest ${c.narrowest.height} high ${c.narrowest.width} wide`).join('; ')})`);
  console.log(`${jobs.length} trips: modes ${modes.join('/')}, style ${styles.join('/')}, burns ${burns.join(' ')}, ${ms} ms / ${nodes} nodes, caves ${caves.join(',')}, ${workers} workers`);
  const t0 = performance.now();
  const results: Done[] = [];
  const chunks: Job[][] = Array.from({ length: workers }, () => []);
  jobs.forEach((j, i) => chunks[i % workers]!.push(j));
  const file = fileURLToPath(import.meta.url);
  await Promise.all(
    chunks.filter((c) => c.length).map(
      (c) =>
        new Promise<void>((resolve, reject) => {
          const w = new Worker(file, { workerData: c });
          w.on('message', (m: Done | 'end') => {
            if (m === 'end') {
              resolve();
              return;
            }
            results.push(m);
            if (verbose) console.log(`[${m.job.mode} ${m.job.style} burn ${m.job.burn} seed ${m.job.seed}] ${caveTripLine({ ...m, windows: [], report: undefined as never })}`);
          });
          w.on('error', reject);
        }),
    ),
  );
  console.log(`${results.length} trips in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  for (const mode of modes) {
    for (const style of styles) {
      const rs = results.filter((r) => r.job.mode === mode && r.job.style === style);
      const trip = (r: Done): CaveTrip => ({ ...r, windows: [], report: undefined as never });
      console.log(caveScoreLine(`${mode}, style ${style}`, scoreCaves(rs.map(trip))));
      for (const c of caves) {
        const cs = rs.filter((r) => r.job.cave === c);
        if (cs.length) console.log('  ' + caveScoreLine(set[c]!.name, scoreCaves(cs.map(trip))));
      }
    }
  }
}
