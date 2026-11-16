// Track F9e round 2 (docs/flight.md "What the Realm showed (Track F9e, round 2)"): the flights under a roof on Track
// F5a's private fixture AS THE BOT DECIDES THEM: the same functions with the same numbers as chat/commands-fly.ts
// (learn/under.ts pickHop and pickExitPiece, route/takeoff.ts planTakeoffRoute with the bot's radius and caps), on a world
// of two layers as the bot has it: the fixture is the world CACHE, and the LIVE model is the chunks within `--live`
// chunks of the body (default 9: the Realm's flood sizes say 9 or more; the bot asks for 10), nothing else. A trip is
// flown to its end: a decision, the proven line flown at every burn of the rockets at hand, the body stood where the
// nominal flight stood, the live model moved there, the next decision. Prints counts, times and positions relative to a
// waypoint only, never a coordinate of the fixture.
//
//   node scripts/cave-under-probe.ts --hop cave_start,cave_end [--each]      a trip between two places under the roof
//   node scripts/cave-under-probe.ts --exit cave_end,cave_10 | all            the way out towards `--to home`
//   node scripts/cave-under-probe.ts --pairs cave --skip 1,2,4               every pair of the route (one decision each)
//
// `--live n`: the live model's reach in chunks. `--cold`: nothing is live at the first decision (a body that has just
// arrived: the bot waits LIVE_WAIT_MS for its chunks first). `--flight n`: the rockets' flight duration (default 1, a
// crafted rocket: 19 to 31 ticks; 0: the script API's, 9 to 21). `--block a,b`: a solid set in the LIVE layer only (a
// 3 x 3 x 3 lump) on the cache's way, that many cells along it, before the first decision. `--tried`: every refusal.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { burnRange, burnSaid, proofBurns } from '../src/skills/fly/burn.ts';
import { caveWorld, loadCaveFixture } from '../src/skills/fly/corridor/cave.ts';
import { routeTakeoff, routeTakeoffOptions, simulateFlight, type SimDeps } from '../src/skills/fly/glide.ts';
import { floodTo, rememberedGrid } from '../src/skills/fly/learn/draw.ts';
import { ENTRY_AIR, ENTRY_LAVA, ENTRY_SOLID, ENTRY_WATER, entryTouchdowns } from '../src/skills/fly/learn/entry.ts';
import { guideLength } from '../src/skills/fly/learn/guide.ts';
import { EXIT_FLOOD_MAX, EXIT_RADIUS, hopTarget, liveGrid, pickExitPiece, pickHop, seenGrid, type UnderPick, type UnderWorld } from '../src/skills/fly/learn/under.ts';
import { cruiseHeight, type LandingTarget } from '../src/skills/fly/plan.ts';
import { planTakeoffRoute, type TakeoffProof, type TakeoffRoute } from '../src/skills/fly/route/takeoff.ts';
import type { TerrainQuery } from '../src/skills/fly/terrain.ts';
import { GLIDE } from '../src/skills/input/physics.ts';
import { TOP_NONE, TOP_UNKNOWN } from '../src/world/cache/export.ts';
import { CLS_AIR, CLS_SOLID, CLS_WATER } from '../src/world/cache/types.ts';
import type { Vec3 } from '../src/world/types.ts';

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const fix = loadCaveFixture();
if (!fix) {
  console.log('no cave fixture (bot/fixtures-private/cave): nothing to fly');
  process.exit(0);
}
const e = fix.extract;
const cw = caveWorld(e);
const b = e.box;
const R = Number(arg('live', '9'));
const burn = burnRange(Number(arg('flight', '1')));
const PIECES = 12;

// ---- the two layers ------------------------------------------------------------------------------------
/** The cache: the fixture's cells; a chunk it never saw and everything beside the box is unknown; over the box air, under it solid. */
const cached = (x: number, y: number, z: number): number | undefined => {
  if (y > b.max.y) return ENTRY_AIR;
  if (y < b.min.y) return ENTRY_SOLID;
  if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z || e.unknownChunk(x >> 4, z >> 4)) return undefined;
  const c = e.cls(x, y, z);
  return c === CLS_AIR ? ENTRY_AIR : c === CLS_WATER ? ENTRY_WATER : c === CLS_SOLID ? ENTRY_SOLID : ENTRY_LAVA;
};
/** Solids the live layer alone has (`--block`). */
const lumps = new Set<string>();
let body = { cx: 0, cz: 0, cold: false };
const live = (x: number, y: number, z: number): number | undefined => {
  if (body.cold || Math.hypot((x >> 4) - body.cx, (z >> 4) - body.cz) > R) return undefined;
  if (lumps.has(`${x},${y},${z}`)) return ENTRY_SOLID;
  // (a chunk inside the live reach that the cache never saw: the server has sent it, the fixture does not know what is
  // in it: a solid here, so that nothing flies through it and the live model does not end at it)
  return cached(x, y, z) ?? ENTRY_SOLID;
};
const w: UnderWorld = { live, cached };
const stand = (at: Vec3, cold = false): void => {
  body = { cx: Math.floor(at.x) >> 4, cz: Math.floor(at.z) >> 4, cold };
};

// ---- the simulations' worlds, as the bot's ------------------------------------------------------------
const isSolid = (c: number | undefined): boolean => c === ENTRY_SOLID || c === ENTRY_LAVA;
const skyTop = (x: number, z: number): number | undefined => {
  if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) {
    const t = e.top(x, z);
    return t === undefined || t === TOP_UNKNOWN || t === TOP_NONE ? undefined : t;
  }
  for (let y = b.max.y; y >= b.min.y; y--) if (isSolid(cached(x, y, z))) return y;
  return undefined;
};
const tops = new Map<number, number | undefined>();
const terrain: TerrainQuery = (x, z) => {
  const k = x * 65536 + z;
  if (!tops.has(k)) tops.set(k, skyTop(x, z));
  return { top: tops.get(k), src: 'live' };
};
const liquidAt = (x: number, y: number, z: number) => ((live(x, y, z) ?? cached(x, y, z)) === ENTRY_WATER ? { liquid: 'water' as const, height: 8 / 9 } : null);
const groundAt = (x: number, z: number): number | undefined => {
  const t = skyTop(x, z);
  return t === undefined ? undefined : t + 1;
};
/** A line under a roof (commands-fly.ts liveSim): the live model alone, an unknown cell a solid. */
const liveSim: SimDeps = { world: { solidAt: (x, y, z) => isSolid(live(x, y, z) ?? ENTRY_SOLID), liquidAt }, groundAt, skyTop, terrain };
/** A route takeoff (commands-fly.ts routeTakeoffFor): the live model, the cache's solids where it has nothing. */
const exitSim: SimDeps = { world: { solidAt: (x, y, z) => isSolid(live(x, y, z) ?? cached(x, y, z) ?? ENTRY_AIR), liquidAt }, groundAt, skyTop, terrain };
const noPlan = (): never => {
  throw new Error('a line under a roof asks no planner');
};

const cellOf = (name: string): Vec3 => {
  // (Track F17: `landing:<tag>`: the start cell of a pair in the fixture's fixture.json, a flight's landing at a cave's mouth)
  if (name.startsWith('landing:')) {
    const pairs = (JSON.parse(readFileSync(join(fix.dir, 'fixture.json'), 'utf8')) as { pairs?: { start: Vec3; tag: string }[] }).pairs ?? [];
    const q = pairs.find((x) => x.tag === name.slice('landing:'.length));
    if (!q) throw new Error(`no pair ${name}`);
    return { x: Math.floor(q.start.x), y: Math.floor(q.start.y + 1e-6), z: Math.floor(q.start.z) };
  }
  const p = fix.waypoints.get(name);
  if (!p) throw new Error(`no waypoint ${name}`);
  return cw.feetCell(p) ?? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
};
const feet = (c: Vec3): Vec3 => ({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 });
const seenSolid = (x: number, y: number, z: number): boolean => (cached(x, y, z) ?? ENTRY_SOLID) !== ENTRY_AIR;
const stands = (c: Vec3): boolean => isSolid(cached(c.x, c.y - 1, c.z)) && !seenSolid(c.x, c.y, c.z) && !seenSolid(c.x, c.y + 1, c.z);
const roofed = (c: Vec3): boolean => {
  for (let y = c.y + 1; y <= b.max.y; y++) if (seenSolid(c.x, y, c.z)) return true;
  return false;
};
const inBox = (c: Vec3): boolean => c.x >= b.min.x && c.x <= b.max.x && c.z >= b.min.z && c.z <= b.max.z;
/** A line of the bot's, its coordinates taken out. */
const rel = (s: string, from: Vec3): string =>
  s
    .replace(/(-?\d+\.\d+) (-?\d+\.\d+) (-?\d+\.\d+)/g, (_m, x: string, y: string, z: string) => `[${(Number(x) - from.x).toFixed(1)} ${(Number(y) - from.y).toFixed(1)} ${(Number(z) - from.z).toFixed(1)}]`)
    .replace(/(-?\d{2,}) (-?\d+) (-?\d{2,})(?=,| \(|:|;|$)/g, (_m, x: string, y: string, z: string) => `[${Number(x) - Math.floor(from.x)} ${Number(y) - Math.floor(from.y)} ${Number(z) - Math.floor(from.z)}]`)
    .replace(/, \d+ from the target/g, '');
const span = (a: number[], f: (n: number) => string = (n) => String(n)): string => (a.length ? (Math.min(...a) === Math.max(...a) ? f(a[0]!) : `${f(Math.min(...a))} to ${f(Math.max(...a))}`) : '-');
const kit = [burn.nominal, ...proofBurns(burn)].sort((x, y) => x - y);

/** A proven hop flown at every burn of the kit: how many stood within 2 of its cell with no hard hit, the seconds, the rockets, and where the nominal flight stood. */
async function flyHop(pick: NonNullable<UnderPick['hop']>, from: Vec3): Promise<{ ok: number; hard: number; secs: number[]; rockets: number[]; stood: Vec3 | undefined; rows: string[] }> {
  const h = pick.drawn;
  const grid = liveGrid(w);
  let ok = 0;
  let hard = 0;
  const secs: number[] = [];
  const rockets: number[] = [];
  const rows: string[] = [];
  let stood: Vec3 | undefined;
  for (const ticks of kit) {
    const sim = await simulateFlight(liveSim, from, hopTarget(h, pick.cell), { cruiseY: from.y + 24, margin: 15, goArounds: 0, takeoffYaw: h.guide.yaw, route: { grid, plan: noPlan }, routeTakeoff: routeTakeoffOptions(pick.route, true) }, { rockets: 64, yaw: h.guide.yaw, maxTicks: 200 + 1.5 * pick.route.ticks, burn: ticks, endLag: GLIDE.boostEndLag });
    const at = sim.end?.landedAt;
    const off = at ? Math.hypot(at.x - pick.cell.x - 0.5, at.z - pick.cell.z - 0.5) : Infinity;
    const fine = at !== undefined && off <= 2 && Math.abs(at.y - pick.cell.y) <= 2 && !sim.wet && !sim.hard;
    if (fine) ok++;
    hard += sim.hard ?? 0;
    secs.push(sim.ticks / 20);
    rockets.push(sim.stats.rockets);
    if (ticks === burn.nominal && at) stood = { ...at };
    rows.push(`        burn ${ticks}: ${fine ? `standing ${off.toFixed(1)} from the cell` : `NOT there (${sim.end ? `${sim.end.ok ? 'stands' : `ended ${sim.end.reason}`} ${off.toFixed(1)} from it` : `still ${sim.phase}`}${sim.wet ? ', wet' : ''})`} after ${sim.ticks} ticks on ${sim.stats.rockets} rockets, ${sim.hard ?? 0} hard hits, ${sim.hits - (sim.hard ?? 0)} touches`);
  }
  return { ok, hard, secs, rockets, stood, rows };
}

const options = (from: Vec3, goalY: number) => ({ rockets: 64, burn, margin: 15, top: Math.min(319, Math.max(Math.floor(from.y), goalY) + 64), plan: noPlan });

/** A trip under the roof from a waypoint to another, as the bot flies it: pieces while the way leaves the live model. */
async function hopTrip(fromName: string, toName: string, once = false): Promise<string> {
  const goal = cellOf(toName);
  const start = cellOf(fromName);
  if (!stands(start)) return `${fromName} -> ${toName}: no place to stand at the start (no floor under its cell, or no two cells of air)`;
  let from = feet(start);
  const out: string[] = [];
  let blocks = 0;
  let ms = 0;
  let lo = 0;
  let hi = 0;
  let pieces = 0;
  // (`--block`: the lumps go on the cache's way from the start, before the first decision)
  if (has('block')) {
    const seen = rememberedGrid(seenGrid({ live: () => undefined, cached }), from);
    const c = entryTouchdowns((x, y, z) => cached(x, y, z) ?? ENTRY_SOLID, goal).find(stands);
    const f = c ? floodTo(seen, from, c, { top: options(from, goal.y).top, radius: 320, max: 150_000 }) : undefined;
    for (const n of arg('block', '116').split(',').map(Number)) {
      const p = f?.way?.way[n];
      if (!p) continue;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) lumps.add(`${p.x + dx},${p.y + dy},${p.z + dz}`);
      out.push(`   a lump set in the live layer ${n} cells along the cache's way of ${f?.way?.way.length ?? 0}`);
    }
  }
  for (let k = 0; k < PIECES; k++) {
    stand(from, has('cold') && k === 0);
    const t0 = performance.now();
    const pick = await pickHop(w, liveSim, from, goal, toName, options(from, goal.y));
    const took = performance.now() - t0;
    ms += took;
    const h = pick.hop;
    if (!h) {
      out.push(`   ${k + 1}: NO hop (${pick.cells} cells, ${pick.sims} simulated, ${took.toFixed(0)} ms): ${rel(pick.tried.join(' | '), from).slice(0, has('tried') ? 3000 : 420)}`);
      return `${fromName} -> ${toName}: ${pieces ? `${pieces} piece${pieces === 1 ? '' : 's'} flown (${blocks.toFixed(0)} blocks), then NO hop` : 'NO hop'}${has('cold') ? ' (cold: nothing live at the first decision)' : ''}; the trip walks on from there\n${out.join('\n')}`;
    }
    const f = await flyHop(h, from);
    pieces++;
    blocks += h.length;
    lo += Math.min(...f.secs);
    hi += Math.max(...f.secs);
    out.push(`   ${k + 1}: ${h.piece ? `a PIECE to the way's cell ${h.piece.to} of ${h.piece.of}` : 'the whole way'}: ${h.drawn.guide.path}, ${h.length} blocks of line, ${pick.cells} cells and ${pick.sims} simulated in ${took.toFixed(0)} ms${h.frail ? ' (short of its cell on a first rocket that fires nothing)' : ''}; flown at ${kit.length} burns: ${f.ok} standing within 2 of its cell, ${f.hard} hard hits, ${span(f.secs, (n) => n.toFixed(1))} s on ${span(f.rockets)} rockets${has('tried') ? `\n        ${rel(pick.tried.join('\n        '), from)}` : ''}${has('each') ? `\n${f.rows.join('\n')}` : ''}`);
    if (f.ok < kit.length || !f.stood) return `${fromName} -> ${toName}: a flight of piece ${k + 1} did not stand by its cell\n${out.join('\n')}`;
    if (!h.piece || once) return `${fromName} -> ${toName}: ${h.piece ? 'a PIECE' : 'ARRIVED'}${pieces > 1 ? ` in ${pieces} pieces` : ''}: ${blocks.toFixed(0)} blocks flown in ${lo.toFixed(1)} to ${hi.toFixed(1)} s of flight, ${(ms / 1000).toFixed(1)} s of deciding in all\n${out.join('\n')}`;
    from = f.stood;
  }
  return `${fromName} -> ${toName}: still on the way after ${PIECES} pieces\n${out.join('\n')}`;
}

/** The way out from a waypoint towards `--to`, as the bot decides it: the drawn way out in the live model, else pieces of the cache's way. */
async function exitTrip(name: string): Promise<string> {
  const start = cellOf(name);
  if (!stands(start)) return `${name}: no place to stand (the waypoint's cell has no floor under it or no two cells of air)`;
  const home = cellOf(arg('to', 'home'));
  const target: LandingTarget = { x: home.x + 0.5, z: home.z + 0.5, top: home.y, half: 1, hold: true };
  let from = feet(start);
  const out: string[] = [];
  let ms = 0;
  let lo = 0;
  let hi = 0;
  for (let k = 0; k < PIECES; k++) {
    stand(from, has('cold') && k === 0);
    const grid = liveGrid(w);
    const cruiseY = cruiseHeight(from, target, (x, z) => skyTop(x, z), {}).y;
    const flight = { cruiseY, margin: 15, goArounds: 2 };
    let sims = 0;
    const prove: TakeoffProof = async (route) => {
      const r = await routeTakeoff(exitSim, from, target, flight, 64, { route: { grid, plan: noPlan }, takeoff: routeTakeoffOptions(route, true) }, { planTicks: route.ticks });
      sims += r.sims;
      return r;
    };
    const t0 = performance.now();
    // (the bot's own call, the exits' search left aside: `tries: 0`)
    const got = await planTakeoffRoute(grid, from, target, { rockets: 4, prove, tries: 0, drawn: { top: Math.min(319, Math.ceil(cruiseY)), radius: EXIT_RADIUS, max: EXIT_FLOOD_MAX }, burn, budgetMs: 6000 }, noPlan);
    let took = performance.now() - t0;
    const route: TakeoffRoute | undefined = got.route;
    if (route?.guide) {
      ms += took;
      // the proven way out at every burn: out with no hit
      let clean = 0;
      const sky: number[] = [];
      const rks: number[] = [];
      for (const ticks of kit) {
        const sim = await simulateFlight(exitSim, from, target, { ...flight, takeoffYaw: route.yaw, route: { grid, plan: noPlan }, routeTakeoff: routeTakeoffOptions(route, true) }, { rockets: 64, yaw: route.yaw, maxTicks: 300 + route.ticks, burn: ticks, endLag: GLIDE.boostEndLag, until: (br) => br.phase === 'approach' });
        const hits = sim.hits - (sim.bumps ?? 0);
        if (sim.stats.routeTakeoffEnd === 'out' && hits === 0 && !sim.end && !sim.wet) clean++;
        if (sim.stats.routeSkyAt !== undefined) sky.push(sim.stats.routeSkyAt / 20);
        rks.push(sim.stats.routeTakeoffRockets ?? 0);
      }
      lo += sky.length ? Math.min(...sky) : 0;
      hi += sky.length ? Math.max(...sky) : 0;
      out.push(`   ${k + 1}: the drawn WAY OUT ${route.guide.line.path}: ${guideLength(route.guide.line).toFixed(0)} blocks of line, ${route.guide.open.toFixed(0)} to open sky (a flood of ${got.drawn?.cells ?? '?'} cells, ${got.drawn?.lines ?? '?'} lines), ${sims} simulated, ${took.toFixed(0)} ms; flown at ${kit.length} burns: ${clean} out with no hit, open sky over the body after ${span(sky, (n) => n.toFixed(1))} s on ${span(rks)} rockets${has('tried') ? `\n        ${rel(got.tried.join('\n        '), from)}` : ''}`);
      return `${name}: ${clean === kit.length ? 'OUT' : 'NOT CLEAN'}${k ? ` after ${k} piece${k === 1 ? '' : 's'}` : ''}: open sky after ${lo.toFixed(1)} to ${hi.toFixed(1)} s of flight, ${(ms / 1000).toFixed(1)} s of deciding in all\n${out.join('\n')}`;
    }
    const why = rel(got.tried.join(' | '), from).slice(0, has('tried') ? 3000 : 260);
    const t1 = performance.now();
    const pick = await pickExitPiece(w, liveSim, from, options(from, Math.floor(from.y)));
    took += performance.now() - t1;
    ms += took;
    const h = pick.hop;
    if (!h) {
      out.push(`   ${k + 1}: NO way out (a flood of ${got.drawn?.cells ?? '?'} cells in the live model: ${why}); the cache's way: ${rel(pick.tried.join(' | '), from).slice(0, has('tried') ? 3000 : 420)} (${took.toFixed(0)} ms)`);
      return `${name}: NO way out${k ? ` after ${k} piece${k === 1 ? '' : 's'}` : ''}${has('cold') ? ' (cold: nothing live at the first decision)' : ''}; the trip walks out from there\n${out.join('\n')}`;
    }
    const f = await flyHop(h, from);
    lo += Math.min(...f.secs);
    hi += Math.max(...f.secs);
    out.push(`   ${k + 1}: a PIECE of the way out to its cell ${h.piece!.to} of ${h.piece!.of}: ${h.length} blocks of line, ${pick.cells} cells and ${pick.sims} simulated, ${took.toFixed(0)} ms with the takeoff's own look; flown at ${kit.length} burns: ${f.ok} standing within 2 of its cell, ${f.hard} hard hits, ${span(f.secs, (n) => n.toFixed(1))} s on ${span(f.rockets)} rockets${has('each') ? `\n${f.rows.join('\n')}` : ''}`);
    if (f.ok < kit.length || !f.stood) return `${name}: a flight of piece ${k + 1} did not stand by its cell\n${out.join('\n')}`;
    from = f.stood;
  }
  return `${name}: still under the roof after ${PIECES} pieces\n${out.join('\n')}`;
}

console.log(`the fixture as the world cache, the live model ${has('cold') ? 'empty at the first decision, then ' : ''}the chunks within ${R} of the body; rockets that burn ${burnSaid(burn)} ticks`);
if (has('exit')) {
  const names = arg('exit', 'cave_end') === 'all' ? [...fix.waypoints.keys()].filter((n) => inBox(cellOf(n)) && roofed(cellOf(n)) && n.startsWith('cave')).sort((x, y) => x.localeCompare(y, undefined, { numeric: true })) : arg('exit', 'cave_end').split(',');
  for (const n of names) console.log(await exitTrip(n));
} else if (has('pairs')) {
  const prefix = arg('pairs', 'cave');
  const mid = [...fix.waypoints.keys()].filter((n) => new RegExp(`^${prefix}_\\d+$`).test(n) && inBox(cellOf(n))).sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
  const route = [`${prefix}_start`, ...mid, `${prefix}_end`];
  for (const skip of arg('skip', '1').split(',').map(Number)) for (let i = 0; i + skip < route.length; i++) console.log((await hopTrip(route[i]!, route[i + skip]!, true)).split('\n').slice(0, has('tried') ? 99 : 2).join('\n'));
} else if (has('along')) {
  // Track F17: the hop asked as the walk's re-check asks it: from the cells of a walk from the start to the goal (a flood
  // over the standable cells, steps of 1 up or down), every `--along` blocks of it once under the roof, one decision each
  const [a = 'cave_start', c = 'cave_end'] = arg('hop', 'cave_start,cave_end').split(',');
  const start = cellOf(a);
  const goal = cellOf(c);
  const key = (p: Vec3): string => `${p.x},${p.y},${p.z}`;
  const prev = new Map<string, Vec3 | null>([[key(start), null]]);
  const queue: Vec3[] = [start];
  for (let i = 0; i < queue.length && !prev.has(key(goal)) && queue.length < 400_000; i++) {
    const p = queue[i]!;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      for (const dy of [0, 1, -1, -2, -3]) {
        const q = { x: p.x + dx, y: p.y + dy, z: p.z + dz };
        if (prev.has(key(q)) || !stands(q)) continue;
        // (up: head room over the start; down: the column over the lower cell clear)
        if (dy > 0 && seenSolid(p.x, p.y + 2, p.z)) continue;
        if (dy < 0 && [...Array(-dy).keys()].some((k) => seenSolid(q.x, q.y + 2 + k, q.z))) continue;
        prev.set(key(q), p);
        queue.push(q);
        break;
      }
    }
  }
  const path: Vec3[] = [];
  for (let p: Vec3 | null | undefined = prev.has(key(goal)) ? goal : undefined; p; p = prev.get(key(p))) path.unshift(p);
  if (!path.length) console.log(`${a} -> ${c}: no walk found over the standable cells`);
  const step = Number(arg('along', '24'));
  let next = 0;
  let blocks = 0;
  for (let i = 0; i < path.length; i++) {
    if (i > 0) blocks += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y, path[i]!.z - path[i - 1]!.z);
    const p = path[i]!;
    if (blocks < next || !roofed(p)) continue;
    next = blocks + step;
    const from = feet(p);
    stand(from);
    const t0 = performance.now();
    const pick = await pickHop(w, liveSim, from, goal, c, options(from, goal.y));
    const left = path.length - 1 - i;
    console.log(`   ${blocks.toFixed(0)} blocks walked (${left} cells left): ${pick.hop ? `${pick.hop.piece ? 'a PIECE' : 'the WHOLE way'}: ${pick.hop.length} blocks of line, ${pick.sims} simulated` : 'NO hop'} in ${(performance.now() - t0).toFixed(0)} ms; ${rel(pick.tried.join(' | '), from).slice(0, has('tried') ? 3000 : 600)}`);
  }
} else {
  const [a = 'cave_start', c = 'cave_end'] = arg('hop', 'cave_start,cave_end').split(',');
  console.log(await hopTrip(a, c));
}
