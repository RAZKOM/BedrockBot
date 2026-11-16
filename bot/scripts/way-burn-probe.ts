// Track F19 (docs/flight.md "Windows that do not start under a full burn (Track F19)"): every window the scout could
// lay along a way (skills/fly/cave/waywin.ts wayWindow from every `--every`th node with WAY_HEAD_MIN of head room, at
// least `--min` blocks long), proven once per variant at the live budget, and each proof that passes the variant's rule
// flown on stepBody (cave/bench.ts flyWindow) at every burn of the kit's range (a glide window, which fires nothing,
// from start offsets instead: the walk stops within WAY_START_OFF of the takeoff and flies the proven plan from there).
// The variants: `live` (the window as the bot proves it), `glide` (no rocket: the trackers plan with none), `late` (the
// search's landing stage begins unpowered, route/types.ts RouteRequest.landUnpowered). One JSON line a window; a table
// a way, variant and kit. Prints no coordinate of the fixture (a window's start is its blocks along the way).
//
//   node scripts/way-burn-probe.ts [--fixture name] [--pairs a,b] [--kit crafted,plain] [--variants live,glide,late]
//                                  [--min 12] [--every 2] [--workers 8] [--out f.jsonl] [--corridor | --hook [--inner]]
//                                  [--rule margin|takeoff] [--fly-all]
//
// `--rule takeoff` judges the margin after the takeoff edge (RoutePlan.flightClearance); `--fly-all` flies every complete
// robust proof whatever the rule says (the rule's verdict is in the line).
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { startWorker } from '../src/threads.ts';
import { capWorkers } from './workers.ts';
import { burnRange } from '../src/skills/fly/burn.ts';
import { flyWindow, type CaveBenchOptions } from '../src/skills/fly/cave/bench.ts';
import { caveStretchOptions } from '../src/skills/fly/cave/style.ts';
import { headRoom, nodeCell, wayAlong, wayGate, wayLandsUnpowered, wayProven, wayWindow, WAY_HEAD_MIN, WAY_PROVE_MS, WAY_PROVE_NODES, type WayNode, type WayWindow } from '../src/skills/fly/cave/waywin.ts';
import { caveWorld, loadCaveFixture } from '../src/skills/fly/corridor/cave.ts';
import { windowRequest } from '../src/skills/fly/corridor/drive.ts';
import { PATH_PACE } from '../src/skills/fly/landprice.ts';
import { planRoute } from '../src/skills/fly/route/search.ts';
import { gridOfSnapshot, snapshotFor } from '../src/skills/fly/route/worker.ts';
import { BURN, type KitBurn, type RoutePlan } from '../src/skills/fly/route/types.ts';
import type { RouteGrid } from '../src/skills/fly/route/grid.ts';
import type { CellSolid } from '../src/skills/fly/corridor/stretches.ts';
import type { BlockQuery } from '../src/skills/input/index.ts';

const arg = (name: string, def?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1] : def;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

type Variant = 'live' | 'glide' | 'late';
interface StoredNode extends WayNode {
  ticks: number;
}
interface Job {
  tag: string;
  kit: 'crafted' | 'plain';
  variant: Variant;
  fixture: string;
  corridor: boolean;
  hook: boolean;
  inner: boolean;
  min: number;
  every: number;
  rule: 'margin' | 'takeoff';
  flyAll: boolean;
}
interface Flight {
  burn: number | string;
  end: string;
  bailed: boolean;
  damage: number;
  ticks: number;
  reached: number;
  rockets: number;
}
interface Row {
  tag: string;
  kit: string;
  variant: Variant;
  startS: number;
  blocks: number;
  drop: number;
  goals: number;
  complete: boolean;
  robust: boolean;
  clearance: number;
  flightClearance: number;
  unpowered: boolean;
  ticks: number;
  rockets: number;
  ms: number;
  expanded: number;
  why?: string;
  proven: boolean;
  provenWhy: string;
  walkS: number;
  saveS: number;
  take: boolean;
  flights: Flight[];
}

async function worldOf(j: Job): Promise<{ way: StoredNode[]; query: BlockQuery; grid: RouteGrid; solid: CellSolid; floor: CellSolid }> {
  const { flatWorld, withBoxes } = await import('../src/skills/input/index.ts');
  if (j.corridor || j.hook) {
    if (j.hook) {
      const { hookWorld } = await import('../test/unit/skills/fly-cave-way-world.ts');
      const w = hookWorld({ x: 0, z: 0 });
      const world = withBoxes(flatWorld(), w.fills.map((f) => ({ from: f.from, to: f.to, solid: f.block === 'stone' })));
      const solid = (x: number, y: number, z: number): boolean => world.solidAt(x, y, z) === true;
      const way = (j.inner ? w.inner : w.line).map((c, i) => ({ x: c.x, y: c.y, z: c.z, feet: c.y, cost: i ? 4.6 : 0, ticks: i ? 4.6 : 0 }));
      return { way, query: world, grid: { solid }, solid, floor: solid };
    }
    const { corridorWorld } = await import('../test/unit/skills/fly-corridor-world.ts');
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
  const { fixtureDir } = await import('../src/skills/nav/bench/fixture.ts');
  const ways = JSON.parse(readFileSync(join(fixtureDir(j.fixture), 'f17-ways.json'), 'utf8')) as Record<string, { nodes: StoredNode[] }>;
  const cw = caveWorld(loadCaveFixture(fixtureDir(j.fixture))!.extract);
  return { way: ways[j.tag]!.nodes, query: cw.query, grid: cw.grid, solid: cw.solid, floor: cw.floor };
}

async function runJob(j: Job): Promise<Row[]> {
  const { way, query, grid, solid, floor } = await worldOf(j);
  const ticksAt: number[] = [0];
  for (let i = 1; i < way.length; i++) ticksAt.push(ticksAt[i - 1]! + way[i]!.ticks);
  const gateS = (i: number, k: number): number => (Math.max(0, ticksAt[Math.max(i, k)]! - ticksAt[Math.min(i, k)]!) / 20) * PATH_PACE;
  const along = wayAlong(way);
  const kit: Readonly<KitBurn> | undefined = j.kit === 'crafted' ? burnRange(1) : undefined;
  const range = kit ?? BURN;
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < way.length - 1; i += j.every) {
    if (headRoom(solid, nodeCell(way[i]!)) < WAY_HEAD_MIN) continue;
    const w: WayWindow | undefined = wayWindow(way, i, { solid, floor, loaded: () => true, price: gateS, minBlocks: j.min }, along);
    if (!w) continue;
    const key = `${w.from.x},${w.from.z},${w.win.end.x},${w.win.end.z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const so = caveStretchOptions(w.win);
    const req = windowRequest(w.win, w.from, 64, {
      margin: so.margin,
      maxMs: WAY_PROVE_MS,
      maxNodes: WAY_PROVE_NODES,
      riskCost: so.riskCost,
      ...(so.pieces !== undefined ? { pieces: so.pieces } : {}),
      ...(kit ? { kit } : {}),
      ...(j.variant === 'glide' ? { rockets: 0 } : {}),
      ...(j.variant === 'late' ? { landUnpowered: true } : {}),
    });
    const g = gridOfSnapshot(snapshotFor(grid, req));
    const p: RoutePlan = planRoute(req, g);
    const fc = p.flightClearance ?? p.clearance;
    const pr = j.rule === 'takeoff' ? wayProven({ ...p, clearance: fc }, w.win) : wayProven(p, w.win);
    const gate = wayGate({ walkS: gateS(w.start, w.land), flyS: p.ticks / 20, rockets: p.rockets, loose: 64 });
    const row: Row = {
      tag: j.tag,
      kit: j.kit,
      variant: j.variant,
      startS: +along[w.start]!.toFixed(1),
      blocks: +w.win.blocks.toFixed(1),
      drop: +(w.from.y - w.win.end.y).toFixed(1),
      goals: w.win.goals.length,
      complete: p.complete,
      robust: p.robust,
      clearance: +p.clearance.toFixed(2),
      flightClearance: +fc.toFixed(2),
      unpowered: wayLandsUnpowered(p, w.win.goals.length),
      ticks: p.ticks,
      rockets: p.rockets,
      ms: Math.round(p.ms),
      expanded: p.expanded,
      ...(p.why ? { why: p.why } : {}),
      proven: pr.ok,
      provenWhy: pr.why,
      walkS: +gateS(w.start, w.land).toFixed(1),
      saveS: +gate.saveS.toFixed(1),
      take: pr.ok && gate.take,
      flights: [],
    };
    const fly = pr.ok || (j.flyAll && p.complete && p.robust);
    if (fly) {
      // a glide fires nothing: the body's start offsets instead of the burns (the walk stops within 0.3 of the takeoff)
      const cases: { burn: number | string; o: CaveBenchOptions; from: typeof w.from }[] = [];
      const base: CaveBenchOptions = { variant: { rules: { refClear: true } }, ...(kit ? { kit } : {}), ...(j.variant === 'glide' ? { rockets: 0 } : {}), ...(j.variant === 'late' ? { landUnpowered: true } : {}) };
      if (p.rockets === 0) {
        for (const [dx, dz] of [[0, 0], [0.2, 0], [-0.2, 0], [0, 0.2], [0, -0.2], [0.2, 0.2], [-0.2, -0.2]] as const) cases.push({ burn: `${dx},${dz}`, o: { ...base, burn: range.nominal }, from: { x: w.from.x + dx, y: w.from.y, z: w.from.z + dz } });
      } else for (let b = range.min; b <= range.max; b++) cases.push({ burn: b, o: { ...base, burn: b }, from: w.from });
      for (const c of cases) {
        const r = await flyWindow(query, c.from, w.win.goals, w.win.margin, { ...c.o, seed: 1 }, 1, structuredClone(p), grid, w.win.height, floor);
        row.flights.push({ burn: c.burn, end: r.end, bailed: r.bailed, damage: +r.damage.toFixed(1), ticks: r.ticks, reached: r.reached, rockets: r.rockets });
      }
    }
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
  const corridor = has('corridor');
  const tags = hook ? [has('inner') ? 'hook-inner' : 'hook'] : corridor ? ['bore'] : arg('pairs', 'cave_8,cave_9,cave_16,cave_17,cave_19')!.split(',');
  const kits = arg('kit', 'crafted,plain')!.split(',') as ('crafted' | 'plain')[];
  const variants = arg('variants', 'live,glide,late')!.split(',') as Variant[];
  const jobs: Job[] = [];
  for (const tag of tags) for (const kit of kits) for (const variant of variants) jobs.push({ tag, kit, variant, fixture: arg('fixture', 'cave-2026-11-14-wide')!, corridor, hook, inner: has('inner'), min: Number(arg('min', '12')), every: Number(arg('every', '2')), rule: arg('rule', 'margin') === 'takeoff' ? 'takeoff' : 'margin', flyAll: has('fly-all') });
  const out = arg('out');
  if (out) writeFileSync(out, '');
  const all: Row[] = [];
  const workers = capWorkers(Number(arg('workers', '8')));
  let next = 0;
  const file = new URL(import.meta.url);
  await Promise.all(
    Array.from({ length: Math.min(workers, jobs.length) }, async () => {
      for (;;) {
        const j = jobs[next++];
        if (!j) return;
        const rows = await new Promise<Row[]>((res, rej) => {
          const w = startWorker(file, { workerData: j, argv: process.argv.slice(2) });
          w.on('message', (m: { rows?: Row[]; error?: string }) => (m.rows ? res(m.rows) : rej(new Error(m.error))));
          w.on('error', rej);
        });
        for (const r of rows) {
          all.push(r);
          if (out) appendFileSync(out, JSON.stringify(r) + '\n');
          const fl = r.flights;
          const landed = fl.filter((f) => f.end === 'done').length;
          console.log(`${r.tag} ${r.kit} ${r.variant} from ${r.startS} (${r.blocks} blocks, drop ${r.drop}, ${r.goals} goals): ${r.complete ? 'complete' : `partial ${r.why ?? ''}`}${r.robust ? '' : ' not robust'}, ${r.ticks} ticks, ${r.rockets} rockets, clearance ${r.clearance} (${r.flightClearance} after), ${r.unpowered ? 'unpowered' : 'burning'} at the landing, ${r.ms} ms; ${r.proven ? 'proven' : r.provenWhy}; walk ${r.walkS} s, saves ${r.saveS} s${r.take ? ' TAKE' : ''}${fl.length ? `; flown ${fl.length}: ${landed} landed, ${fl.filter((f) => f.bailed).length} bailed, damage max ${Math.max(0, ...fl.map((f) => f.damage))} [${fl.map((f) => `${f.burn}:${f.end === 'done' ? 'L' : f.bailed ? 'B' : f.end}${f.damage ? `!${f.damage}` : ''}`).join(' ')}]` : ''}`);
        }
      }
    }),
  );
  console.log('| way | kit | variant | windows | complete | proven | taken by the gate | flights (landed, bailed, hit) | damage max |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const tag of tags) {
    for (const kit of kits) {
      for (const variant of variants) {
        const rs = all.filter((r) => r.tag === tag && r.kit === kit && r.variant === variant);
        if (!rs.length) continue;
        const fl = rs.flatMap((r) => r.flights);
        console.log(`| ${tag} | ${kit} | ${variant} | ${rs.length} | ${rs.filter((r) => r.complete).length} | ${rs.filter((r) => r.proven).length} | ${rs.filter((r) => r.take).length} | ${fl.length} (${fl.filter((f) => f.end === 'done').length}, ${fl.filter((f) => f.bailed).length}, ${fl.filter((f) => f.damage > 0).length}) | ${Math.max(0, ...fl.map((f) => f.damage)).toFixed(1)} |`);
      }
    }
  }
}
