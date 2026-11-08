// Track F5b: the owner's cave (Track F5a's private fixture, corridor/cave.ts) through the cave style's executor path
// (cave/bench.ts flyTrip: the proof before every takeoff, the windows on stepBody with the worker's latency), from
// the command line. Skips when the fixture is not there. Nothing here prints a coordinate: the lines name legs only.
//
//   node scripts/cave-real-bench.ts [--mode corridor,routeA,legsA,routeB,tripC,proofB] [--style on,off,rules0]
//                                   [--burns all|nominal|random] [--ms 600] [--workers 8] [--verbose]
//
//   corridor  cave_start to cave_end on the coarse layer's own corridor (no waypoints)
//   routeA    every waypoint of route A as a hint (WaypointProvider), one trip
//   legsA     route A leg by leg (a trip of two waypoints each)
//   routeB    cave_4, cave_5, cave_shortcut, cave_end as hints
//   tripC     home, cave_2, cave_start (the sky part is a stub cruise)
//   proofB    the shortcut proof (cave/proof.ts) from cave_5 through cave_shortcut to cave_end
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CAVE_BURNS, caveScoreLine, caveTripLine, flyTrip, scoreCaves, tripWorldOfCave, type CaveBenchOptions, type CaveTrip } from '../src/skills/fly/cave/bench.ts';
import { proveShortcut } from '../src/skills/fly/cave/proof.ts';
import { WaypointProvider, type RoutePoint } from '../src/skills/fly/cave/route.ts';
import type { CaveStyle } from '../src/skills/fly/cave/style.ts';
import { caveLegs, caveWorld, loadCaveFixture, ROUTE_A, ROUTE_B, TRIP_C, type CaveFixture, type CaveWorld } from '../src/skills/fly/corridor/cave.ts';
import { caveLayer } from '../src/skills/fly/corridor/cave-bench.ts';
import type { Vec3 } from '../src/world/types.ts';

const VARIANTS: Record<string, { style: boolean; variant?: Partial<CaveStyle> }> = {
  on: { style: true },
  off: { style: false },
  rules0: { style: true, variant: { chainWindow: 5, riskCost: 0.5, marginExtra: 0, prove: false, windowBlocks: 320, tailMin: 40, rules: { commitTicks: 0, partialStop: false, bailAfter: undefined, completeOnly: false, replanLead: 0, bailError: undefined } } },
  // Track F7: the tube controller's variants (the generator bench has the same)
  notube: { style: true, variant: { rules: { tube: false } } },
  nobbail: { style: true, variant: { rules: { blockedBail: false } } },
  err15: { style: true, variant: { rules: { bailError: 1.5 } } },
};

type Mode = 'corridor' | 'routeA' | 'legsA' | 'routeB' | 'tripC';

interface Job {
  mode: Mode;
  leg?: number;
  style: string;
  burn: number | 'random';
  seed: number;
  ms: number;
}

type Done = Omit<CaveTrip, 'report' | 'windows'> & { windows: number; job: Job };

function fixture(): { fix: CaveFixture; world: CaveWorld } | undefined {
  const fix = loadCaveFixture();
  if (!fix) return undefined;
  return { fix, world: caveWorld(fix.extract) };
}

/** The feet cells of a route's stops, by name. */
function stops(fix: CaveFixture, world: CaveWorld, names: readonly string[]): RoutePoint[] {
  return names.map((name) => {
    const p = fix.waypoints.get(name);
    if (!p) throw new Error(`no waypoint ${name}`);
    // (a stop outside the extract, trip C's home in the open: the waypoint itself; the cruise there is a stub)
    const cell = world.feetCell(p) ?? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    return { name, cell };
  });
}

/** A cell is covered: a solid cell of the extract above it. */
function coveredIn(world: CaveWorld): (cell: Vec3) => boolean {
  const b = world.extract.box;
  return (cell) => {
    // outside the extract (trip C's home, the open country): the sky (the loader answers solid there: the box's wall, not a roof)
    if (cell.x < b.min.x || cell.x > b.max.x || cell.z < b.min.z || cell.z > b.max.z) return false;
    for (let y = b.max.y; y > cell.y + 1; y--) if (world.solid(Math.floor(cell.x), y, Math.floor(cell.z)) === true) return true;
    return false;
  };
}

async function runJob(j: Job): Promise<Done> {
  const f = fixture();
  if (!f) throw new Error('no cave fixture');
  const { fix, world } = f;
  const v = VARIANTS[j.style] ?? VARIANTS.on!;
  const o: CaveBenchOptions = { seed: j.seed, burn: j.burn, maxMs: j.ms, style: v.style, ...(v.variant ? { variant: v.variant } : {}) };
  const tw = tripWorldOfCave(world, 'the cave');
  const covered = coveredIn(world);
  let t: CaveTrip;
  if (j.mode === 'corridor') {
    const [a, b] = stops(fix, world, ['cave_start', 'cave_end']);
    t = await flyTrip(tw, caveLayer(world), a!.cell, b!.cell, o, 'cave_start -> cave_end (corridor)');
  } else if (j.mode === 'legsA') {
    const legs = caveLegs(fix, world, ROUTE_A);
    const leg = legs[j.leg ?? 0]!;
    const pts: RoutePoint[] = [{ name: 'from', cell: leg.from }, { name: 'to', cell: leg.to }];
    t = await flyTrip(tw, new WaypointProvider(pts, { covered }), leg.from, leg.to, o, leg.name);
  } else {
    const route = j.mode === 'routeA' ? ROUTE_A : j.mode === 'routeB' ? ROUTE_B : TRIP_C;
    const pts = stops(fix, world, route.stops);
    t = await flyTrip(tw, new WaypointProvider(pts, { covered }), pts[0]!.cell, pts[pts.length - 1]!.cell, o, `route ${route.name} (waypoints)`);
  }
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
  const f = fixture();
  if (!f) {
    console.log('no cave fixture (bot/fixtures-private/cave): nothing to fly');
    process.exit(0);
  }
  const arg = (name: string, def: string): string => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
  };
  const modes = arg('mode', 'corridor,routeA,legsA,routeB,tripC,proofB').split(',');
  const styles = arg('style', 'on').split(',');
  const burns = ((b) => (b === 'all' ? CAVE_BURNS : b === 'nominal' ? [15] : b === 'random' ? ['random', 'random', 'random'] : b.split(',').map((s) => (s === 'random' ? 'random' : Number(s)))))(arg('burns', 'all')) as (number | 'random')[];
  const ms = Number(arg('ms', '600'));
  const workers = Math.max(1, Number(arg('workers', String(Math.min(8, availableParallelism())))));
  const verbose = process.argv.includes('--verbose');
  if (modes.includes('proofB')) {
    const pts = stops(f.fix, f.world, ['cave_5', 'cave_shortcut', 'cave_end']);
    const t0 = performance.now();
    const proof = await proveShortcut(f.world.grid, pts.map((p) => p.cell));
    console.log(`proof B (cave_5 -> cave_shortcut -> cave_end): ${proof.proven ? 'PROVEN' : `not proven: ${proof.reason ?? '?'}`}, ${proof.windows} windows, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    for (const l of proof.lines) console.log('  ' + l);
  }
  const jobs: Job[] = [];
  const legsA = caveLegs(f.fix, f.world, ROUTE_A).length;
  for (const mode of modes.filter((m): m is Mode => m !== 'proofB')) {
    for (const style of styles) {
      burns.forEach((burn, i) => {
        if (mode === 'legsA') for (let l = 0; l < legsA; l++) jobs.push({ mode, leg: l, style, burn, seed: 1 + i, ms });
        else jobs.push({ mode, style, burn, seed: 1 + i, ms });
      });
    }
  }
  if (!jobs.length) process.exit(0);
  console.log(`${jobs.length} trips: modes ${modes.join('/')}, style ${styles.join('/')}, burns ${burns.join(' ')}, ${ms} ms in flight, ${workers} workers`);
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
  const trip = (r: Done): CaveTrip => ({ ...r, windows: [], report: undefined as never });
  for (const mode of modes.filter((m) => m !== 'proofB')) {
    for (const style of styles) {
      const rs = results.filter((r) => r.job.mode === mode && r.job.style === style);
      if (!rs.length) continue;
      console.log(caveScoreLine(`${mode}, style ${style}`, scoreCaves(rs.map(trip))));
      if (mode === 'legsA') {
        for (let l = 0; l < legsA; l++) {
          const ls = rs.filter((r) => r.job.leg === l);
          if (ls.length) console.log('  ' + caveScoreLine(ls[0]!.name, scoreCaves(ls.map(trip))));
        }
      }
    }
  }
}
