// Track F9a (docs/flight.md "Cave exit (Track F9a)"): the takeoff out of the owner's cave (Track F5a's private fixture),
// offline, from the command line: the route takeoff's decision from a waypoint towards another (the exits, the plans,
// the proofs, the ways out under the roof) and the chosen takeoff flown on stepBody at every burn. Prints counts, times
// and positions relative to the start only, never a coordinate of the fixture.
//
//   node scripts/cave-exit-probe.ts [--from cave_start] [--to home] [--cruise <y>] [--far on|off] [--unproven] [--burns 9,11,...] [--notes]
//        [--way-margin 0.15] [--way-risk 0.5] [--no-proof-burns]   (the way out's margin and risk weight; the proof at the nominal burn only, to see every burn flown)
//
// `--unproven` takes the first complete plan without a proof and flies it with the climb turning to the goal at the exit
// (the takeoff as it was before this track: the Realm's `roof` ends). `--cruise` is the flight's cruise height (default:
// what the fixture's column tops along the line ask for; the Realm's trip had 133). The planner runs in this thread, so
// the times are this machine's.
import { caveWorld, loadCaveFixture } from '../src/skills/fly/corridor/cave.ts';
import { routeTakeoff, routeTakeoffOptions, simulateFlight, type SimDeps } from '../src/skills/fly/glide.ts';
import { cruiseHeight, hdist, yawTo, type LandingTarget } from '../src/skills/fly/plan.ts';
import { planRoute } from '../src/skills/fly/route/search.ts';
import { planTakeoffRoute, type TakeoffProof } from '../src/skills/fly/route/takeoff.ts';
import type { RouteRequest } from '../src/skills/fly/route/types.ts';
import { gridOfSnapshot, snapshotFor } from '../src/skills/fly/route/worker.ts';
import { TOP_NONE, TOP_UNKNOWN } from '../src/world/cache/export.ts';
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
const world = caveWorld(e);
const grid = world.grid;
const b = e.box;
const inBox = (x: number, z: number): boolean => x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z;
// the flight's world: the fixture's cells in the box; beside the box the extract's column tops (solid up to the top, air
// over it; a column the cache never saw is air, as the live model's unknown is for the flight's physics)
const outsideSolid = (x: number, y: number, z: number): boolean => {
  const t = e.top(x, z);
  return t !== undefined && t !== TOP_UNKNOWN && t !== TOP_NONE && y <= t;
};
const solidAt = (x: number, y: number, z: number): boolean => (inBox(x, z) ? world.query.solidAt(x, y, z) === true : outsideSolid(x, y, z));
const query = { solidAt, liquidAt: (x: number, y: number, z: number) => (inBox(x, z) ? world.query.liquidAt!(x, y, z) : null) };
const skyTop = (x: number, z: number, fromY?: number): number | undefined => {
  for (let y = Math.min(b.max.y, Math.floor(fromY ?? b.max.y)); y >= b.min.y; y--) if (solidAt(x, y, z)) return y;
  return undefined;
};
const groundAt = (x: number, z: number, fromY?: number): number | undefined => {
  const t = skyTop(x, z, fromY);
  return t === undefined || grid.solid(x, t + 1, z) ? undefined : t + 1;
};
const deps: SimDeps = { world: query, groundAt, skyTop: (x, z) => skyTop(x, z) };

const cellOf = (name: string): Vec3 => {
  const p = fix.waypoints.get(name);
  if (!p) throw new Error(`no waypoint ${name}`);
  return world.feetCell(p) ?? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
};
const start = cellOf(arg('from', 'cave_start'));
const goal = cellOf(arg('to', 'home'));
const from: Vec3 = { x: start.x + 0.5, y: start.y, z: start.z + 0.5 };
const target: LandingTarget = { x: goal.x + 0.5, z: goal.z + 0.5, top: goal.y, half: 1, hold: true };
const cruiseY = has('cruise') ? Number(arg('cruise', '133')) : cruiseHeight(from, target, (x, z) => skyTop(x, z), {}).y;
const flight = { cruiseY, margin: 15, goArounds: 2 };
// a line with the fixture's coordinates made relative to the start
const rel = (s: string): string => s.replace(/(-?\d+) (-?\d+) (-?\d+)(?= \(|:|,|;|$)/g, (_m, x: string, y: string, z: string) => `[${Number(x) - start.x} ${Number(y) - start.y} ${Number(z) - start.z}]`);
const relNote = (s: string): string => s.replace(/(-?\d+\.\d) (-?\d+\.\d) (-?\d+\.\d)/g, (_m, x: string, y: string, z: string) => `[${(Number(x) - from.x).toFixed(1)} ${(Number(y) - from.y).toFixed(1)} ${(Number(z) - from.z).toFixed(1)}]`);

let plans = 0;
let planMs = 0;
const plan = (req: RouteRequest) => {
  const t = performance.now();
  // (--snapshot: on the grid's snapshot round the request, as the bot's planner worker searches it: route/worker.ts)
  const p = planRoute(req, has('snapshot') ? gridOfSnapshot(snapshotFor(grid, req)) : grid);
  planMs += performance.now() - t;
  plans++;
  return p;
};
let sims = 0;
const prove: TakeoffProof = async (route) => {
  const r = await routeTakeoff(deps, from, target, flight, 64, { route: { grid, plan }, takeoff: routeTakeoffOptions(route, true) }, { planTicks: route.ticks, ...(has('no-proof-burns') ? { burns: [] } : {}) });
  sims += r.sims;
  return r;
};
const unproven = has('unproven');
const t0 = performance.now();
const got = await planTakeoffRoute(grid, from, target, { rockets: 4, ...(unproven ? {} : { prove }), ...(arg('far', 'on') === 'on' && !unproven ? { far: { top: Math.ceil(cruiseY), ...(has('way-margin') ? { margin: Number(arg('way-margin', '0.15')) } : {}), ...(has('way-risk') ? { riskCost: Number(arg('way-risk', '0.5')) } : {}) } } : {}), ...(has('no-proof-burns') ? { budgetMs: 60_000 } : {}) }, plan);
console.log(`${arg('from', 'cave_start')} -> ${arg('to', 'home')} (${Math.round(hdist(from, target))} blocks, heading ${Math.round(yawTo(from, target))}, cruise y ${cruiseY.toFixed(0)}): ${got.exits} exits${got.ways !== undefined ? `, ${got.ways} ways out under the roof` : ''}; ${plans} searches (${planMs.toFixed(0)} ms), ${sims} simulations, ${(performance.now() - t0).toFixed(0)} ms in all${unproven ? ' (unproven: the takeoff as before Track F9a)' : ''}`);
for (const t of got.tried) console.log(`  ${rel(t)}`);
const route = got.route;
if (!route) {
  console.log('-> no route takeoff');
  process.exit(0);
}
console.log(`-> out to [${route.exit.x - start.x} ${route.exit.y - start.y} ${route.exit.z - start.z}] (${route.exit.steps} cells), ${route.goals.length} goal${route.goals.length === 1 ? '' : 's'}, ${route.ticks} ticks, ${route.rockets} rockets planned${route.proven ? `, proven, ${((route.score ?? 0) / 20).toFixed(0)} s to the goal` : ', not proven'}`);
const burns = arg('burns', '9,11,13,15,17,19,21').split(',').map(Number);
for (const burn of burns) {
  const notes: string[] = [];
  let out70 = '';
  const sim = await simulateFlight(
    deps,
    from,
    target,
    { ...flight, takeoffYaw: route.yaw, route: { grid, plan }, routeTakeoff: routeTakeoffOptions(route, route.proven === true), note: (m) => notes.push(m) },
    {
      rockets: 64,
      yaw: route.yaw,
      maxTicks: 400,
      burn,
      until: (br, body) => {
        if (!out70 && hdist(body.pos, from) >= 70) out70 = `, 70 blocks out at tick ${br.stats.ticks} (${(br.stats.ticks / 20).toFixed(1)} s), ${(body.pos.y - from.y).toFixed(0)} over the start`;
        return br.phase === 'approach';
      },
    },
  );
  const s = sim.stats;
  console.log(`  burn ${String(burn).padStart(2)}: ${sim.end ? `ended ${sim.end.ok ? 'landed' : sim.end.reason} after ${sim.ticks} ticks, ${(sim.body.pos.y - from.y).toFixed(0)} from the start's height, ${hdist(sim.body.pos, from).toFixed(0)} out` : `flying (${sim.phase}) after ${sim.ticks} ticks`}; ${sim.hits - (sim.bumps ?? 0)} hits${sim.bumps ? `, ${sim.bumps} head bumps` : ''}; the way out ${s.routeTakeoffEnd ?? 'not ended'} after ${s.routeTakeoffTicks ?? '?'} ticks on ${s.routeTakeoffRockets ?? 0} rockets${s.routeExitYaw !== undefined ? `, left the exit on heading ${Math.round(s.routeExitYaw)}${s.routeHeadingAt !== undefined ? `, on the goal's at tick ${s.routeHeadingAt}` : ''}` : ''}${out70}; ${s.rockets} rockets, steered ${s.steered}`);
  if (has('notes')) for (const n of notes) console.log(`      ${relNote(n).slice(0, 260)}`);
}
