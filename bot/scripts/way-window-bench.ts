// Track F17 (docs/flight.md "Windows beside the walk (Track F17)"): the walk from a flight's landing at a cave's mouth to
// a goal deep in it, offline, with the windows beside the walk (skills/fly/cave/waywin.ts) as the bot runs them: the way
// is the landing probe's path from the landing cell (Track W2, as findLanding asks it over the navigator), the scout
// proves windows ahead of the body at the live budget while the body walks, and a proven window that pays is flown on
// stepBody (cave/bench.ts flyWindow: the chain of trackers, the worker's latency, the burn of each rocket drawn from the
// seed). The walk is priced by the probe's ticks at the pace the closed-loop walk measured (walk-way-bench: 1.18 to 1.25
// times the probe's planned seconds; `--pace`), the gate by the live pace (landprice.ts PATH_PACE). Prints a line a run
// and a table a goal (before: the priced walk; after: the walk with the windows), never a coordinate of the fixture.
//
//   node scripts/way-window-bench.ts --fixture <name> [--pairs a,b] [--seeds 10] [--kit crafted,plain] [--workers 5]
//                                    [--out f.jsonl] [--verbose] [--trace] [--corridor | --hook [--inner]] [--pace 1.22]
//                                    [--refclear on|off] [--clear margin|corridor|takeoff|burns] [--burn-margin m]
//                                    [--mids] [--prove-ms 2000] [--turn-max 60] [--late]
//
// `--corridor`: a made-up cave instead (test/unit/skills/fly-corridor-world.ts: the 3 x 3 bore, the bend, the 2-high
// section, the chamber), the way the walk's own straight line through it from 3 blocks inside the mouth. `--hook`: the
// e2e's cave (test/unit/skills/fly-cave-way-world.ts), its centre line from the cell before the mouth (`--inner`: along
// its inner side rows, the e2e probe's way). `--refclear off`
// flies the windows without TrackerRules.refClear; `--clear corridor` takes a proof by the corridor's rule (complete,
// robust, clearance 0.15) instead of wayProven's; Track F18: `--clear takeoff` wayProven's with the margin judged after
// the takeoff edge (RoutePlan.flightClearance), `--clear burns` wayProven's with the margin judged by cave/bench.ts
// burnsHold (every burn of the kit's range open loop, `--burn-margin` its margin, default the window's); `--mids`
// proves robust to the burns between the ends too; `--prove-ms` the proof's budget (waywin.ts WAY_PROVE_MS) with the
// scout's lead half a second over it; `--turn-max` the most a window's way may turn (WAY_TURN_MAX; 180: no cut at a bend).
// Each window is flown on a copy of its proof (the tracker re-times the plan it flies, and the proof is flown again on
// the next seed: before Track F18 the seeds after the first flew a reference re-timed to an earlier seed's burn). A
// start's proof is made once for every seed: one that ran out of its ms budget is the machine's of that moment (Track
// F19: a stall of 2 s in one run moved the crafted hook cave's p50 from 23.5 to 31.0 s), so a case near the budget is
// run twice. Track F19: `--late` proves and re-plans with the landing searched unpowered (RouteRequest.landUnpowered).
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { startWorker } from '../src/threads.ts';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { capWorkers } from './workers.ts';
import { burnRange } from '../src/skills/fly/burn.ts';
import { burnsHold, flyWindow, type BurnsCheck, type CaveBenchOptions } from '../src/skills/fly/cave/bench.ts';
import { caveStretchOptions, CAVE_STYLE } from '../src/skills/fly/cave/style.ts';
import { wayAt, wayGate, wayProven, WayScout, WAY_OVER_S, WAY_PROVE_MS, WAY_PROVE_NODES, type WayNode, type WayWindow } from '../src/skills/fly/cave/waywin.ts';
import { RISK_RANGE } from '../src/skills/fly/route/types.ts';
import { caveWorld, loadCaveFixture } from '../src/skills/fly/corridor/cave.ts';
import { windowRequest } from '../src/skills/fly/corridor/drive.ts';
import { PATH_PACE } from '../src/skills/fly/landprice.ts';
import { planRoute } from '../src/skills/fly/route/search.ts';
import { gridOfSnapshot, snapshotFor } from '../src/skills/fly/route/worker.ts';
import type { RouteGrid } from '../src/skills/fly/route/grid.ts';
import type { CellSolid } from '../src/skills/fly/corridor/stretches.ts';
import type { BlockQuery } from '../src/skills/input/index.ts';
import type { KitBurn, RoutePlan } from '../src/skills/fly/route/types.ts';
import type { Vec3 } from '../src/world/types.ts';

const arg = (name: string, def?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1] : def;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

/** A node of a stored way: the walk's node and the probe's ticks of the move into it (landprice.ts probeTicks). */
interface StoredNode extends WayNode {
  ticks: number;
}
type Ways = Record<string, { goal: Vec3; nodes: StoredNode[] }>;

/** The probe's ways from each pair's landing cell (cached beside the fixture: the private coordinates stay there). */
async function fixtureWays(name: string, want: readonly string[]): Promise<Ways> {
  const { fixtureDir, loadFixture } = await import('../src/skills/nav/bench/fixture.ts');
  const file = join(fixtureDir(name), 'f17-ways.json');
  const cached: Ways = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Ways) : {};
  const missing = want.filter((t) => !cached[t]);
  if (!missing.length) return cached;
  const { runPair } = await import('../test/unit/skills/reach-sim.ts');
  const { landingProbe } = await import('../src/skills/fly/landprobe.ts');
  const { LONG_PROBE } = await import('../src/skills/fly/landing.ts');
  const { probeTicks } = await import('../src/skills/fly/landprice.ts');
  const { DEFAULT_COSTS } = await import('../src/skills/nav/costs.ts');
  const { MAX_JUMP_RISE } = await import('../src/skills/nav/astar.ts');
  const f = loadFixture(name);
  if (!f) throw new Error(`no fixture ${name}`);
  for (const tag of missing) {
    const pair = f.world.pairs.find((p) => p.tag === tag);
    if (!pair) continue;
    await runPair(f.world, pair, new Map(), {
      preload: true,
      timeoutTicks: 1,
      before: async (skills) => {
        const nav = skills.nav;
        const pr = landingProbe({ grid: nav.grid, planOptions: (o) => nav.planOptions(o) }, pair.goal, {
          budget: { nodes: LONG_PROBE.nodes, ms: LONG_PROBE.ms },
          surface: false,
          onPath: (path) => {
            const costs = { ...DEFAULT_COSTS, ...nav.planOptions({ allowBreak: false, allowPlace: false, sprint: false }).costs };
            const prefs = { underground: 0, isUnderground: (x: number, z: number, feet: number) => nav.grid.underground(x, z, feet), irreversibleDrop: costs.irreversibleDrop, jumpRise: MAX_JUMP_RISE };
            // (the bench world's x and z are the extract's less the fixture's origin: stored in world coordinates, the cave's own)
            const w0 = f.toWorld({ x: 0, y: 0, z: 0 });
            cached[tag] = { goal: f.toWorld(pair.goal), nodes: path.map((n, i) => ({ x: n.x + w0.x, y: n.y, z: n.z + w0.z, feet: n.feet, cost: n.cost, ticks: i ? probeTicks([path[i - 1]!, n], prefs) : 0 })) };
          },
        });
        await pr({ x: pair.start.x + 0.5, y: pair.start.y, z: pair.start.z + 0.5 });
        return {};
      },
    });
  }
  writeFileSync(file, JSON.stringify(cached));
  return cached;
}

/** The corridor world's way: the walk's straight line from 3 blocks inside the mouth along the bore, round the bend, through the low section to the chamber's centre. */
async function corridorWay(): Promise<{ way: StoredNode[]; query: BlockQuery; grid: RouteGrid; solid: CellSolid; floor: CellSolid }> {
  const { corridorWorld } = await import('../test/unit/skills/fly-corridor-world.ts');
  const { flatWorld, withBoxes } = await import('../src/skills/input/index.ts');
  const w = corridorWorld({ x: 0, z: 0 });
  const world = withBoxes(flatWorld(), w.fills.map((f) => ({ from: f.from, to: f.to, solid: f.block === 'stone' })));
  const solid = (x: number, y: number, z: number): boolean => world.solidAt(x, y, z) === true;
  const way: StoredNode[] = [];
  const push = (x: number, z: number): void => {
    way.push({ x, y: w.start.y, z, feet: w.start.y, cost: way.length ? 4.6 : 0, ticks: way.length ? 4.6 : 0 });
  };
  for (let x = w.mouthX + 3; x <= w.bendX; x++) push(x, w.start.z);
  for (let z = w.start.z + 1; z <= w.goal.z; z++) push(w.bendX, z);
  return { way, query: world, grid: { solid }, solid, floor: solid };
}

/** The hook cave's way (the e2e's cave): the centre line from the cell before its mouth through the 2-high passage, the bore in, across and back to the chamber's centre (`inner`: along the hook's inner side rows, as the e2e's landing probe walked it). */
async function hookWay(inner = false): Promise<{ way: StoredNode[]; query: BlockQuery; grid: RouteGrid; solid: CellSolid; floor: CellSolid }> {
  const { hookWorld } = await import('../test/unit/skills/fly-cave-way-world.ts');
  const { flatWorld, withBoxes } = await import('../src/skills/input/index.ts');
  const w = hookWorld({ x: 0, z: 0 });
  const world = withBoxes(flatWorld(), w.fills.map((f) => ({ from: f.from, to: f.to, solid: f.block === 'stone' })));
  const solid = (x: number, y: number, z: number): boolean => world.solidAt(x, y, z) === true;
  const way: StoredNode[] = (inner ? w.inner : w.line).map((c, i) => ({ x: c.x, y: c.y, z: c.z, feet: c.y, cost: i ? 4.6 : 0, ticks: i ? 4.6 : 0 }));
  return { way, query: world, grid: { solid }, solid, floor: solid };
}

interface Job {
  tag: string;
  seeds: number[];
  kit: 'crafted' | 'plain';
  pace: number;
  corridor: boolean;
  hook?: boolean;
  /** The hook's way along its inner side rows. */
  inner?: boolean;
  fixture?: string;
  /** The windows' trackers with TrackerRules.refClear (the setting's flight). */
  refClear: boolean;
  /**
   * The proof rule: `margin` waywin.ts wayProven (the setting's), `corridor` the corridor's (CAVE_STYLE proveClearMin),
   * Track F18: `takeoff` wayProven with the clearance judged after the takeoff edge (RoutePlan.flightClearance), `burns`
   * wayProven with the clearance after the takeoff over every burn of the kit's range (cave/bench.ts burnsHold).
   */
  clearRule: 'margin' | 'corridor' | 'takeoff' | 'burns';
  /** The margin the `takeoff` and `burns` rules ask after the takeoff (default the window's). */
  burnMargin?: number;
  /** The proof's budget (ms; WAY_PROVE_MS) and the scout's lead with it. */
  proveMs: number;
  /** The most a window's way may turn (degrees; WAY_TURN_MAX). */
  turnMax?: number;
  /** Track F19: the proofs and the windows' trackers search their landing unpowered (RouteRequest.landUnpowered); `--late`. */
  late?: boolean;
}

interface WindowRow {
  startS: number;
  blocks: number;
  walkS: number;
  flyS: number;
  end: string;
  bailed: boolean;
  damage: number;
  rockets: number;
  lostS: number;
}

interface RunRow {
  tag: string;
  kit: string;
  seed: number;
  beforeS: number;
  afterS: number;
  proofs: number;
  proofMs: number[];
  provenComplete: number;
  passed: number;
  gated: number;
  windows: WindowRow[];
  flownBlocks: number;
  wayBlocks: number;
  damage: number;
  rockets: number;
  notes: string[];
}

async function runJob(j: Job): Promise<RunRow[]> {
  let way: StoredNode[];
  let query: BlockQuery;
  let grid: RouteGrid;
  let solid: CellSolid;
  let floor: CellSolid | undefined;
  if (j.hook) {
    ({ way, query, grid, solid, floor } = await hookWay(j.inner === true));
  } else if (j.corridor) {
    ({ way, query, grid, solid, floor } = await corridorWay());
  } else {
    const ways = JSON.parse(readFileSync(join((await import('../src/skills/nav/bench/fixture.ts')).fixtureDir(j.fixture!), 'f17-ways.json'), 'utf8')) as Ways;
    way = ways[j.tag]!.nodes;
    const fix = loadCaveFixture((await import('../src/skills/nav/bench/fixture.ts')).fixtureDir(j.fixture!))!;
    const cw = caveWorld(fix.extract);
    query = cw.query;
    grid = cw.grid;
    solid = cw.solid;
    floor = cw.floor;
  }
  const ticksAt: number[] = [0];
  for (let i = 1; i < way.length; i++) ticksAt.push(ticksAt[i - 1]! + way[i]!.ticks);
  /** The walk's seconds from node i to node j at a pace. */
  const at = (pace: number) => (i: number, k: number): number => (Math.max(0, ticksAt[Math.max(i, k)]! - ticksAt[Math.min(i, k)]!) / 20) * pace;
  const walkS = at(j.pace);
  const gateS = at(PATH_PACE);
  const kit: Readonly<KitBurn> | undefined = j.kit === 'crafted' ? burnRange(1) : undefined;
  const proofs = new Map<number, RoutePlan>();
  const burnChecks = new Map<number, BurnsCheck>();
  const prove = (w: WayWindow, loose: number): RoutePlan => {
    const hit = proofs.get(w.start);
    if (hit) return hit;
    const so = caveStretchOptions(w.win);
    const req = windowRequest(w.win, w.from, loose, { margin: so.margin, maxMs: j.proveMs, maxNodes: WAY_PROVE_NODES, riskCost: so.riskCost, ...(so.pieces !== undefined ? { pieces: so.pieces } : {}), ...(kit ? { kit } : {}), ...(has('mids') ? { midBurns: true } : {}), ...(j.late ? { landUnpowered: true } : {}) });
    const g = gridOfSnapshot(snapshotFor(grid, req));
    const p = planRoute(req, g);
    proofs.set(w.start, p);
    if (p.complete && p.robust && j.clearRule === 'burns') burnChecks.set(w.start, burnsHold(req.start, p, g, req.goals, j.burnMargin ?? w.win.margin));
    return p;
  };
  /** The proof rule of the job (see Job.clearRule). */
  const proven = (w: WayWindow, p: RoutePlan): { ok: boolean; why: string } => {
    if (j.clearRule === 'corridor') return { ok: p.complete && p.robust && p.clearance >= CAVE_STYLE.proveClearMin, why: `clearance ${p.clearance.toFixed(2)}` };
    if (j.clearRule === 'margin') return wayProven(p, w.win);
    // (`takeoff`: the margin after the takeoff edge; `burns`: the search's proof and the landing unpowered, the margin by burnsHold)
    if (j.clearRule === 'takeoff') return wayProven({ ...p, clearance: p.flightClearance ?? p.clearance }, { ...w.win, margin: j.burnMargin ?? w.win.margin });
    const base = wayProven({ ...p, clearance: RISK_RANGE }, w.win);
    if (!base.ok) return base;
    const c = burnChecks.get(w.start);
    return c ? { ok: c.ok, why: c.why } : { ok: false, why: 'no burn check' };
  };
  const rows: RunRow[] = [];
  const total = walkS(0, way.length - 1);
  for (const seed of j.seeds) {
    const notes: string[] = [];
    const scout = new WayScout(way, { solid, ...(floor !== undefined ? { floor } : {}), loaded: () => true, price: gateS, leadS: j.proveMs / 1000 + 0.5, ...(j.turnMax !== undefined ? { turnMax: j.turnMax } : {}) });
    let i = 0;
    let t = 0;
    let loose = 64;
    const row: RunRow = { tag: j.tag, kit: j.kit, seed, beforeS: +total.toFixed(1), afterS: 0, proofs: 0, proofMs: [], provenComplete: 0, passed: 0, gated: 0, windows: [], flownBlocks: 0, wayBlocks: +scout.along[way.length - 1]!.toFixed(1), damage: 0, rockets: 0, notes };
    let k = 0;
    for (let guard = 0; guard < 200; guard++) {
      const w = scout.next(i);
      if (!w) break;
      row.proofs++;
      const p = prove(w, loose);
      row.proofMs.push(Math.round(p.ms));
      const proofS = p.ms / 1000;
      const arrive = walkS(i, w.start);
      // the body walks on while the proof runs: where it stands when the proof comes back
      const walkedTo = (s: number): number => {
        let m = i;
        while (m < way.length - 1 && walkS(i, m) < s) m++;
        return m;
      };
      // (--clear corridor: the corridor's own proof rule, CAVE_STYLE proveClearMin; the setting's: wayProven, the window's margin)
      const pv = proven(w, p);
      const ok = pv.ok;
      if (ok) row.provenComplete++;
      if (p.complete && p.robust && !ok) notes.push(`proof from ${scout.along[w.start]!.toFixed(0)}: ${pv.why}: walked`);
      if (proofS > arrive) {
        row.passed++;
        notes.push(`proof from ${scout.along[w.start]!.toFixed(0)} came back after the body passed it (${p.ms.toFixed(0)} ms, ${arrive.toFixed(1)} s of walk)`);
        const m = walkedTo(proofS);
        t += walkS(i, m);
        i = m;
        continue;
      }
      const g = ok ? wayGate({ walkS: gateS(w.start, w.land), flyS: p.ticks / 20, rockets: p.rockets, loose }) : undefined;
      if (!g?.take) {
        if (ok) row.gated++;
        notes.push(`window from ${scout.along[w.start]!.toFixed(0)} (${w.win.blocks.toFixed(0)} blocks, ${w.win.width}x${w.win.height}, margin ${w.win.margin}): ${ok ? g!.line : `${p.complete ? 'complete' : `partial (${p.why ?? '?'})`} ${p.reached}/${w.win.goals.length} goals${p.robust ? '' : ', not robust'}, clearance ${p.clearance.toFixed(2)} (${(p.flightClearance ?? p.clearance).toFixed(2)} after the takeoff), ${p.expanded} expanded in ${p.ms.toFixed(0)} ms`}`);
        const m = walkedTo(proofS);
        t += walkS(i, m);
        i = m;
        continue;
      }
      // taken: the walk to its start, the stop, the window
      t += arrive;
      const o: CaveBenchOptions = { seed: seed * 131 + ++k, burn: 'random', ...(kit ? { kit } : {}), ...(j.refClear ? { variant: { rules: { refClear: true } } } : {}), ...(j.late ? { landUnpowered: true } : {}), ...(has('trace') ? { note: (m: string) => notes.push(`      ${m}`) } : {}) };
      // (a copy: the tracker changes the plan it flies, and the proof is flown again on the next seed)
      const r = await flyWindow(query, w.from, w.win.goals, w.win.margin, o, o.seed, structuredClone(p), grid, w.win.height, floor);
      t += r.ticks / 20 + WAY_OVER_S;
      loose -= r.rockets;
      row.rockets += r.rockets;
      row.damage += r.damage;
      // the walk goes on along the way from the node the body stands on (W2: a small search back onto the way within 8)
      const pos = { ...r.at, y: Math.floor(r.at.y + 1e-6) };
      let next = wayAt(way, pos, w.start, 8);
      let rejoin: number;
      if (next === undefined) {
        // farther off: the nearest node of the rest of the way, the straight line to it at the walk's pace
        let bd = Infinity;
        for (let m = w.start; m < way.length; m++) {
          const d = Math.hypot(way[m]!.x + 0.5 - pos.x, way[m]!.feet - pos.y, way[m]!.z + 0.5 - pos.z);
          if (d < bd) {
            bd = d;
            next = m;
          }
        }
        rejoin = bd;
      } else rejoin = Math.hypot(way[next]!.x + 0.5 - pos.x, way[next]!.z + 0.5 - pos.z);
      t += rejoin * 0.3 * j.pace;
      if (r.bailed || r.end !== 'done') scout.bailed();
      const lost = r.end === 'done' ? 0 : walkS(next!, w.land);
      row.windows.push({ startS: +scout.along[w.start]!.toFixed(0), blocks: +w.win.blocks.toFixed(0), walkS: +walkS(w.start, w.land).toFixed(1), flyS: +(r.ticks / 20).toFixed(1), end: r.end, bailed: r.bailed, damage: +r.damage.toFixed(1), rockets: r.rockets, lostS: +lost.toFixed(1) });
      row.flownBlocks += r.blocks;
      notes.push(`WINDOW from ${scout.along[w.start]!.toFixed(0)} (${w.win.blocks.toFixed(0)} blocks, ${w.win.width}x${w.win.height}, proof clearance ${p.clearance.toFixed(2)}, ${p.rockets} rockets, ${g.line}): ${r.end}${r.bailed ? ' (bailed)' : ''}, ${r.reached}/${r.goals} goals, ${r.ticks} ticks, ${r.rockets} rockets, damage ${r.damage.toFixed(1)}, back on the way ${rejoin.toFixed(1)} off at ${scout.along[next!]!.toFixed(0)}`);
      i = Math.max(next!, i);
    }
    t += walkS(i, way.length - 1);
    row.afterS = +t.toFixed(1);
    row.flownBlocks = +row.flownBlocks.toFixed(0);
    rows.push(row);
  }
  return rows;
}

if (!isMainThread) {
  void runJob(workerData as Job).then(
    (rows) => parentPort!.postMessage({ rows }),
    (e: unknown) => parentPort!.postMessage({ error: e instanceof Error ? (e.stack ?? e.message) : String(e) }),
  );
} else {
  const hook = has('hook');
  const corridor = has('corridor') || hook;
  const fixture = arg('fixture', 'cave-2026-11-14-wide')!;
  const tags = hook ? [has('inner') ? 'hook-inner' : 'hook'] : corridor ? ['bore'] : arg('pairs', 'cave_8,cave_9,cave_16,cave_17,cave_19')!.split(',');
  if (!corridor) await fixtureWays(fixture, tags);
  const seeds = Array.from({ length: Number(arg('seeds', '10')) }, (_, i) => i + 1);
  const kits = (arg('kit', 'crafted,plain')!.split(',') as ('crafted' | 'plain')[]).filter((k) => k === 'crafted' || k === 'plain');
  const pace = Number(arg('pace', '1.22'));
  const jobs: Job[] = [];
  const refClear = arg('refclear', 'on') === 'on';
  const rule = arg('clear', 'margin')!;
  const clearRule = rule === 'corridor' || rule === 'takeoff' || rule === 'burns' ? rule : 'margin';
  const proveMs = Number(arg('prove-ms', String(WAY_PROVE_MS)));
  for (const tag of tags) for (const kit of kits) jobs.push({ tag, seeds, kit, pace, corridor, hook, inner: hook && has('inner'), fixture, refClear, clearRule, proveMs, ...(arg('turn-max') ? { turnMax: Number(arg('turn-max')) } : {}), ...(arg('burn-margin') ? { burnMargin: Number(arg('burn-margin')) } : {}), ...(has('late') ? { late: true } : {}) });
  const out = arg('out');
  if (out) writeFileSync(out, '');
  const all: RunRow[] = [];
  const workers = capWorkers(Number(arg('workers', String(jobs.length))));
  let next = 0;
  const file = new URL(import.meta.url);
  await Promise.all(
    Array.from({ length: Math.min(workers, jobs.length) }, async () => {
      for (;;) {
        const j = jobs[next++];
        if (!j) return;
        const rows = await new Promise<RunRow[]>((res, rej) => {
          const w = startWorker(file, { workerData: j, argv: process.argv.slice(2) });
          w.on('message', (m: { rows?: RunRow[]; error?: string }) => (m.rows ? res(m.rows) : rej(new Error(m.error))));
          w.on('error', rej);
        });
        for (const r of rows) {
          all.push(r);
          if (out) appendFileSync(out, JSON.stringify(r) + '\n');
          console.log(`${r.tag} ${r.kit} seed ${r.seed}: ${r.beforeS} -> ${r.afterS} s (${((r.afterS / r.beforeS - 1) * 100).toFixed(0)} %), ${r.windows.length} windows (${r.windows.filter((x) => x.end === 'done').length} landed, ${r.windows.filter((x) => x.bailed).length} bailed), flown ${r.flownBlocks} of ${r.wayBlocks}, ${r.proofs} proofs (${r.provenComplete} proven, ${r.gated} not worth it, ${r.passed} too late), damage ${r.damage.toFixed(1)}, ${r.rockets} rockets`);
          if (has('verbose')) for (const n of r.notes) console.log(`    ${n}`);
        }
      }
    }),
  );
  console.log('| goal | kit | runs | before s | after s p50 (min-max) | windows (landed, bailed) | flown of way | proofs (proven, too late) | proof ms p50 / max | damage max | rockets |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  const med = (a: number[]): number => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[Math.floor((s.length - 1) / 2)]! : 0;
  };
  for (const tag of tags) {
    for (const kit of kits) {
      const rs = all.filter((r) => r.tag === tag && r.kit === kit);
      if (!rs.length) continue;
      const a = rs.map((r) => r.afterS);
      const ws = rs.flatMap((r) => r.windows);
      const ms = rs.flatMap((r) => r.proofMs);
      console.log(`| ${tag} | ${kit} | ${rs.length} | ${rs[0]!.beforeS} | ${med(a)} (${Math.min(...a)}-${Math.max(...a)}) | ${ws.length} (${ws.filter((x) => x.end === 'done').length}, ${ws.filter((x) => x.bailed).length}) | ${med(rs.map((r) => r.flownBlocks))} of ${rs[0]!.wayBlocks} | ${rs.reduce((s, r) => s + r.proofs, 0)} (${rs.reduce((s, r) => s + r.provenComplete, 0)}, ${rs.reduce((s, r) => s + r.passed, 0)}) | ${med(ms)} / ${Math.max(0, ...ms)} | ${Math.max(0, ...rs.map((r) => r.damage)).toFixed(1)} | ${med(rs.map((r) => r.rockets))} |`);
    }
  }
}
