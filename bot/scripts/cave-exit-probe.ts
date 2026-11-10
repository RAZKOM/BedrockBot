// Track F9a (docs/flight.md "Cave exit (Track F9a)"): the takeoff out of the owner's cave (Track F5a's private fixture),
// offline, from the command line: the route takeoff's decision from a waypoint towards another (the exits, the plans,
// the proofs, the ways out under the roof) and the chosen takeoff flown on stepBody at every burn. Prints counts, times
// and positions relative to the start only, never a coordinate of the fixture.
//
//   node scripts/cave-exit-probe.ts [--from cave_start] [--to home] [--cruise <y>] [--far on|off] [--unproven] [--burns 9,11,...] [--notes]
//        [--way-margin 0.15] [--way-risk 0.5] [--no-proof-burns]   (the way out's margin and risk weight; the proof at the nominal burn only, to see every burn flown)
//        [--snapshot] [--async] [--at dx,dz] [--trace] [--replica] [--no-terrain] [--end-lag n]
//
// `--unproven` takes the first complete plan without a proof and flies it with the climb turning to the goal at the exit
// (the takeoff as it was before this track: the Realm's `roof` ends). `--cruise` is the flight's cruise height (default:
// what the fixture's column tops along the line ask for; the Realm's trip had 133). The planner runs in this thread, so
// the times are this machine's. `--snapshot` searches on the grid's snapshot round each request, as the bot's planner
// worker does; `--async` gives each answer as a promise, a tick after it was asked, as the worker's comes (the bot's own
// way: Track F9b measured that the way out flies differently so). `--at` starts the body that far from its cell's centre;
// `--trace` prints the first 90 ticks of every flight, relative to the start. `--replica` flies the world as the replica
// on bds-fly2 has it (the box inside its stone shell, the terraces, the flat world) instead of the fixture's. The
// simulations get the terrain columns, as the bot's own do (the climb keeps the terrain floor); `--no-terrain`: without,
// as Track F9a measured. `--end-lag n`: the brain sees every burn's end n ticks late (a learned line's proof and flights
// have 2 without it). A burn written `a/b` is a first rocket of a ticks and b for the later ones.
//
// Track F9b (docs/flight.md "Learned exits (Track F9b)"): the recorded paths as ways out.
//
//   node scripts/cave-exit-probe.ts --paths <dir> [--learned follow|waypoints|off] [--takes [--each]] [--way-step 12]
//
// `--paths` (or BEDROCKBOT_PATHS_DIR) is a folder of `!learn` recordings, read only (the owner's own: private, never in
// the repository). Without `--takes` the decision is the bot's: the recorded flights that leave the ground at the start
// and come out under open sky, in the bot's order, the first whose proof clears; then that takeoff at every burn. With
// `--takes` every matching take is proven and flown as its own candidate (one summary line a take, `--each`: a line a
// burn). `--learned waypoints` is the alternative that was measured against the follower: the recorded line cut into
// waypoints for the route search and flown by the route tracker.
import { caveWorld, loadCaveFixture, REPLICA_FLAT_FEET, replicaCoarse } from '../src/skills/fly/corridor/cave.ts';
import { routeTakeoff, routeTakeoffOptions, simulateFlight, type SimDeps } from '../src/skills/fly/glide.ts';
import { lineRoom } from '../src/skills/fly/learn/follow.ts';
import { guideLength, guideNearest, guidePoint } from '../src/skills/fly/learn/guide.ts';
import { matchExits, MATCH_NEAR, type GuideMatch, type OpenSky } from '../src/skills/fly/learn/match.ts';
import { PathStore } from '../src/skills/fly/learn/store.ts';
import { cruiseHeight, hdist, yawTo, type LandingTarget } from '../src/skills/fly/plan.ts';
import type { TerrainQuery } from '../src/skills/fly/terrain.ts';
import { planRoute } from '../src/skills/fly/route/search.ts';
import { learnedRoute, planTakeoffRoute, takeoffStart, TAKEOFF_WEIGHT, WAY_MARGIN, WAY_PIECES, WAY_PLAN_MS, WAY_PLAN_NODES, WAY_RISK, WAY_ROCKETS, type TakeoffProof, type TakeoffRoute } from '../src/skills/fly/route/takeoff.ts';
import type { RouteGoal, RouteRequest } from '../src/skills/fly/route/types.ts';
import { gridOfSnapshot, snapshotFor } from '../src/skills/fly/route/worker.ts';
import { GLIDE } from '../src/skills/input/physics.ts';
import { TOP_NONE, TOP_UNKNOWN } from '../src/world/cache/export.ts';
import { CLS_AIR, CLS_WATER } from '../src/world/cache/types.ts';
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
// (--replica: the world as the replica on bds-fly2 has it instead (corridor/cave.ts replicaCoarse): the same box, a stone
// shell round its sides from the flat world up to the box's top, the terraces round it, the flat world beyond, the home pad)
const homeAt = fix.waypoints.get('home');
const replica = has('replica') ? replicaCoarse(world, homeAt ? { home: { x: Math.floor(homeAt.x), y: Math.floor(homeAt.y), z: Math.floor(homeAt.z) } } : {}) : undefined;
const replicaSolid = (x: number, y: number, z: number): boolean => {
  const c = replica!.chunk(x >> 4, z >> 4, e.dim)?.cls(x & 15, y, z & 15);
  return c !== undefined && c !== CLS_AIR && c !== CLS_WATER;
};
const solidAt = replica ? replicaSolid : (x: number, y: number, z: number): boolean => (inBox(x, z) ? world.query.solidAt(x, y, z) === true : outsideSolid(x, y, z));
const query = { solidAt, liquidAt: (x: number, y: number, z: number) => (inBox(x, z) ? world.query.liquidAt!(x, y, z) : null) };
const skyTop = (x: number, z: number, fromY?: number): number | undefined => {
  for (let y = Math.min(b.max.y, Math.floor(fromY ?? b.max.y)); y >= (replica ? REPLICA_FLAT_FEET - 2 : b.min.y); y--) if (solidAt(x, y, z)) return y;
  return undefined;
};
const groundAt = (x: number, z: number, fromY?: number): number | undefined => {
  const t = skyTop(x, z, fromY);
  return t === undefined || grid.solid(x, t + 1, z) ? undefined : t + 1;
};
// the terrain columns, as the bot's own simulations get them (commands-fly.ts simDeps): the simulated climb and cruise keep the
// terrain floor as the flight does (every column here is one the cache knew: none is "not loaded"); --no-terrain: without,
// as Track F9a's probe flew
const tops = new Map<string, number | undefined>();
const terrain: TerrainQuery = (x, z) => {
  const k = `${x},${z}`;
  if (!tops.has(k)) tops.set(k, skyTop(x, z));
  return { top: tops.get(k), src: 'live' };
};
const deps: SimDeps = { world: query, groundAt, skyTop: (x, z) => skyTop(x, z), ...(has('no-terrain') ? {} : { terrain }) };

const cellOf = (name: string): Vec3 => {
  const p = fix.waypoints.get(name);
  if (!p) throw new Error(`no waypoint ${name}`);
  return world.feetCell(p) ?? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
};
const start = cellOf(arg('from', 'cave_start'));
const goal = cellOf(arg('to', 'home'));
// (--at dx,dz: the body that far from the cell's centre, blocks: the takeoff from where a walk or a teleport really left it)
const at = arg('at', '0,0').split(',').map(Number);
const from: Vec3 = { x: start.x + 0.5 + (at[0] ?? 0), y: start.y, z: start.z + 0.5 + (at[1] ?? 0) };
const target: LandingTarget = { x: goal.x + 0.5, z: goal.z + 0.5, top: goal.y, half: 1, hold: true };
const cruiseY = has('cruise') ? Number(arg('cruise', '133')) : cruiseHeight(from, target, (x, z) => skyTop(x, z), {}).y;
const flight = { cruiseY, margin: 15, goArounds: 2 };
// a line with the fixture's coordinates made relative to the start
const rel = (s: string): string => s.replace(/(-?\d+) (-?\d+) (-?\d+)(?= \(|:|,|;|$)/g, (_m, x: string, y: string, z: string) => `[${Number(x) - start.x} ${Number(y) - start.y} ${Number(z) - start.z}]`);
const relNote = (s: string): string => s.replace(/(-?\d+\.\d) (-?\d+\.\d) (-?\d+\.\d)/g, (_m, x: string, y: string, z: string) => `[${(Number(x) - from.x).toFixed(1)} ${(Number(y) - from.y).toFixed(1)} ${(Number(z) - from.z).toFixed(1)}]`);

let plans = 0;
let planMs = 0;
const planNow = (req: RouteRequest) => {
  const t = performance.now();
  // (--snapshot: on the grid's snapshot round the request, as the bot's planner worker searches it: route/worker.ts)
  const p = planRoute(req, has('snapshot') ? gridOfSnapshot(snapshotFor(grid, req)) : grid);
  planMs += performance.now() - t;
  plans++;
  return p;
};
// (--async: the answer comes as a promise, a tick after it was asked, as the worker's does; it implies --snapshot's grid when both are given)
let pending: Promise<unknown> | undefined;
const plan = has('async')
  ? (req: RouteRequest) => {
      const r = Promise.resolve(planNow(req));
      pending = r;
      return r;
    }
  : planNow;
/** The simulation waits for an answer that is still out (glide.ts routeTakeoff does the same). */
const wait = (): Promise<unknown> | undefined => {
  const w = pending;
  pending = undefined;
  return w;
};
let sims = 0;
const prove: TakeoffProof = async (route) => {
  const r = await routeTakeoff(deps, from, target, flight, 64, { route: { grid, plan }, takeoff: routeTakeoffOptions(route, true) }, { planTicks: route.ticks, ...(endLag !== undefined ? { endLag } : {}), ...(has('no-proof-burns') ? { burns: [] } : {}) });
  sims += r.sims;
  return r;
};
// (--end-lag n: the brain sees a burn n ticks after it has ended, in the proof and in the flights: glide.ts simulateFlight endLag)
const endLag = has('end-lag') ? Number(arg('end-lag', '2')) : undefined;
// (a burn as `a/b`: the first rocket burns a ticks and every later one b: the flight no single burn flies)
const burns = arg('burns', '9,11,13,15,17,19,21').split(',');
const median = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? NaN;

/** A route flown at every burn asked for, one line a burn; the burns flown with no hit, the rockets up to the way's end and up to 70 blocks out, the ticks to 70 blocks out. */
async function flyBurns(route: TakeoffRoute, quiet = false): Promise<{ clean: number; out: number; rocketsOut: number[]; ticksOut: number[]; up70: number[]; rockets70: number[]; ticks70: number[]; maxOff: number }> {
  const sum = { clean: 0, out: 0, rocketsOut: [] as number[], ticksOut: [] as number[], up70: [] as number[], rockets70: [] as number[], ticks70: [] as number[], maxOff: 0 };
  for (const label of burns) {
    const [first, rest] = label.split('/').map(Number);
    const burn = rest === undefined ? first! : (k: number): number => (k === 0 ? first! : rest);
    const notes: string[] = [];
    let out70 = '';
    let off = 0;
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
        ...(endLag !== undefined ? { endLag } : route.guide ? { endLag: GLIDE.boostEndLag } : {}), // (a learned line as its proof flies it: every burn's end seen late)
        wait,
        until: (br, body) => {
          if (route.guide && br.phase === 'takeoff' && body.gliding) off = Math.max(off, guideNearest(route.guide.line, body.pos).dist);
          // (--trace: every tick of the first 90, relative to the start)
          if (has('trace') && br.stats.ticks <= 90) {
            const n = route.guide ? guideNearest(route.guide.line, body.pos) : undefined;
            const h = Math.hypot(body.vel.x, body.vel.z);
            notes.push(`#t${br.stats.ticks} ${br.phase} [${(body.pos.x - from.x).toFixed(1)} ${(body.pos.y - from.y).toFixed(1)} ${(body.pos.z - from.z).toFixed(1)}] speed ${Math.hypot(h, body.vel.y).toFixed(2)} climb ${((Math.atan2(body.vel.y, h) * 180) / Math.PI).toFixed(0)} boost ${body.boostTicks ?? 0}${n ? ` at ${n.at.toFixed(1)} off ${n.dist.toFixed(2)}` : ''}${body.collidedHorizontally || body.collidedVertically ? ' CONTACT' : ''}`);
          }
          if (!out70 && hdist(body.pos, from) >= 70) {
            out70 = `, 70 blocks out at tick ${br.stats.ticks} (${(br.stats.ticks / 20).toFixed(1)} s) on ${br.stats.rockets} rocket${br.stats.rockets === 1 ? '' : 's'}, ${(body.pos.y - from.y).toFixed(0)} over the start`;
            sum.ticks70.push(br.stats.ticks);
            sum.rockets70.push(br.stats.rockets);
            sum.up70.push(body.pos.y - from.y);
          }
          return br.phase === 'approach';
        },
      },
    );
    const s = sim.stats;
    const hits = sim.hits - (sim.bumps ?? 0);
    if (s.routeTakeoffEnd === 'out') {
      sum.out++;
      sum.rocketsOut.push(s.routeTakeoffRockets ?? 0);
      sum.ticksOut.push(s.routeTakeoffTicks ?? 0);
    }
    if (s.routeTakeoffEnd === 'out' && hits === 0 && !sim.end && !sim.wet) sum.clean++;
    sum.maxOff = Math.max(sum.maxOff, off);
    if (!quiet) console.log(`  burn ${label.padStart(2)}: ${sim.end ? `ended ${sim.end.ok ? 'landed' : sim.end.reason} after ${sim.ticks} ticks, ${(sim.body.pos.y - from.y).toFixed(0)} from the start's height, ${hdist(sim.body.pos, from).toFixed(0)} out` : `flying (${sim.phase}) after ${sim.ticks} ticks`}; ${hits} hits${sim.bumps ? `, ${sim.bumps} head bumps` : ''}; the way out ${s.routeTakeoffEnd ?? 'not ended'} after ${s.routeTakeoffTicks ?? '?'} ticks on ${s.routeTakeoffRockets ?? 0} rockets${route.guide ? `, at most ${off.toFixed(2)} off the line` : ''}${s.routeExitYaw !== undefined ? `, left the exit on heading ${Math.round(s.routeExitYaw)}${s.routeHeadingAt !== undefined ? `, on the goal's at tick ${s.routeHeadingAt}` : ''}` : ''}${out70}; ${s.rockets} rockets, steered ${s.steered}`);
    // (a trace line is relative already; a note of the brain's has the fixture's coordinates, made relative here)
    if (has('notes') || has('trace')) for (const n of notes) console.log(`      ${(n.startsWith('#') ? n.slice(1) : relNote(n)).slice(0, 260)}`);
  }
  return sum;
}

// Track F9b (docs/flight.md "Learned exits (Track F9b)"): the recorded paths (`--paths <dir>` or BEDROCKBOT_PATHS_DIR: the
// owner's own, private and read only) as ways out from the start
const pathsDir = has('paths') ? arg('paths', '') : process.env.BEDROCKBOT_PATHS_DIR;
const learnedMode = arg('learned', pathsDir ? 'follow' : 'off');
const top = Math.ceil(cruiseY);
const sky: OpenSky = (x, y, z) => {
  for (let k = y + 1; k <= top; k++) if (grid.solid(x, k, z)) return false;
  return true;
};
const learned = pathsDir && learnedMode !== 'off' ? matchExits(new PathStore(pathsDir).all(), from, sky) : undefined;
if (learned) {
  console.log(`learned: ${learned.flights} recorded flights, ${learned.near} leave the ground within ${MATCH_NEAR} of ${arg('from', 'cave_start')}, ${learned.matches.length} of those come out under open sky`);
  for (const m of learned.matches) console.log(`  ${m.guide.path}: left the ground ${m.off.toFixed(1)} away, ${m.open.toFixed(0)} blocks along it to open sky (${Math.round(m.guide.ticks[Math.round(m.open)] ?? 0)} ticks recorded), the line kept ${guideLength(m.guide).toFixed(0)} blocks and itself ${lineRoom(grid, m.guide, m.open).toFixed(2)} from the nearest block, rockets at ticks ${m.guide.rockets.map((r) => r.tick).join(', ') || '-'}`);
}

/** `--learned waypoints`, the measured alternative: the recorded line as waypoints for the route search (a 3 x 3 x 3 box every `--way-step` blocks of it, its first open sky, 12 beyond), in pieces of one goal as the ways out are, flown by the route tracker. */
function waypointRoute(m: GuideMatch): TakeoffRoute | string {
  const step = Number(arg('way-step', '12'));
  const box = (p: Vec3, half: number, up: number): RouteGoal => ({ kind: 'waypoint', box: { min: { x: Math.floor(p.x) - half, y: Math.floor(p.y) - 1, z: Math.floor(p.z) - half }, max: { x: Math.floor(p.x) + half + 1, y: Math.floor(p.y) - 1 + up, z: Math.floor(p.z) + half + 1 } } });
  const goals: RouteGoal[] = [];
  for (let at = step; at < m.open - step / 2; at += step) goals.push(box(guidePoint(m.guide, at).pos, 1, 3));
  goals.push(box(guidePoint(m.guide, m.open).pos, 1, 4));
  goals.push(box(guidePoint(m.guide, Math.min(guideLength(m.guide), m.open + 12)).pos, 2, 6));
  const yaw = yawTo(from, target);
  const p = planNow({ start: takeoffStart(from, yaw, WAY_ROCKETS), goals, margin: WAY_MARGIN, riskCost: WAY_RISK, maxNodes: WAY_PLAN_NODES, maxMs: WAY_PLAN_MS, weight: TAKEOFF_WEIGHT, pieces: WAY_PIECES });
  if (!p.complete) return `no plan through ${goals.length} goals (${p.why ?? '?'}; ${p.nodes} nodes, ${p.ms.toFixed(0)} ms)`;
  const e = learnedRoute(m, from, yaw).exit;
  return { exit: e, goals, margin: WAY_MARGIN, riskCost: WAY_RISK, weight: TAKEOFF_WEIGHT, yaw, ticks: p.ticks, rockets: p.rockets, edges: p.edges.map((k) => k.name).join(' '), nodes: p.nodes, ms: p.ms, pieces: WAY_PIECES };
}

if (learned && has('takes')) {
  // every take that matches, each as its own candidate: its proof, then every burn flown
  console.log(`every take as the way out (${learnedMode === 'waypoints' ? 'its line as waypoints for the route search' : 'its line flown by the guide follower'}); burns ${burns.join(', ')}:`);
  for (const m of learned.matches) {
    const t0 = performance.now();
    const made = learnedMode === 'waypoints' ? waypointRoute(m) : learnedRoute(m, from, yawTo(from, target));
    if (typeof made === 'string') {
      console.log(`${m.guide.path}: ${made}`);
      continue;
    }
    const proof = await prove(made);
    const ms = performance.now() - t0;
    const route: TakeoffRoute = { ...made, proven: true };
    console.log(`${m.guide.path}${learnedMode === 'waypoints' ? ` (${made.goals.length} goals, ${made.ticks} ticks, ${made.rockets} rockets planned: ${made.edges})` : ''}: the proof: ${proof.ok ? '' : 'REFUSED: '}${proof.line} (${ms.toFixed(0)} ms)`);
    const s = await flyBurns(route, !has('each'));
    console.log(`   flown: ${s.clean} of ${burns.length} burns out with no hit (${s.out} out); the way out ${Math.min(...s.ticksOut)} to ${Math.max(...s.ticksOut)} ticks on ${Math.min(...s.rocketsOut)} to ${Math.max(...s.rocketsOut)} rockets; 70 blocks out after ${(Math.min(...s.ticks70) / 20).toFixed(1)} to ${(Math.max(...s.ticks70) / 20).toFixed(1)} s (median ${(median(s.ticks70) / 20).toFixed(1)}) on ${Math.min(...s.rockets70)} to ${Math.max(...s.rockets70)} rockets, ${Math.min(...s.up70).toFixed(0)} to ${Math.max(...s.up70).toFixed(0)} over the start${made.guide ? `; at most ${s.maxOff.toFixed(2)} off the line` : ''}`);
  }
  process.exit(0);
}

const unproven = has('unproven');
const t0 = performance.now();
const got = await planTakeoffRoute(
  grid,
  from,
  target,
  {
    rockets: 4,
    ...(unproven ? {} : { prove }),
    ...(arg('far', 'on') === 'on' && !unproven ? { far: { top: Math.ceil(cruiseY), ...(has('way-margin') ? { margin: Number(arg('way-margin', '0.15')) } : {}), ...(has('way-risk') ? { riskCost: Number(arg('way-risk', '0.5')) } : {}) } } : {}),
    ...(has('no-proof-burns') ? { budgetMs: 60_000 } : {}),
    ...(learned && learnedMode === 'follow' && !unproven ? { learned: { matches: learned.matches } } : {}),
  },
  plan,
);
console.log(`${arg('from', 'cave_start')} -> ${arg('to', 'home')} (${Math.round(hdist(from, target))} blocks, heading ${Math.round(yawTo(from, target))}, cruise y ${cruiseY.toFixed(0)}): ${got.learned !== undefined ? `${got.learned} learned way${got.learned === 1 ? '' : 's'} out tried, ` : ''}${got.exits} exits${got.ways !== undefined ? `, ${got.ways} ways out under the roof` : ''}; ${plans} searches (${planMs.toFixed(0)} ms), ${sims} simulations, ${(performance.now() - t0).toFixed(0)} ms in all${unproven ? ' (unproven: the takeoff as before Track F9a)' : ''}`);
for (const t of got.tried) console.log(`  ${rel(t)}`);
const route = got.route;
if (!route) {
  console.log('-> no route takeoff');
  process.exit(0);
}
console.log(`-> out to [${route.exit.x - start.x} ${route.exit.y - start.y} ${route.exit.z - start.z}] (${route.exit.steps} ${route.guide ? 'blocks along the recorded line' : 'cells'}), ${route.guide ? `the learned line ${route.guide.line.path}` : `${route.goals.length} goal${route.goals.length === 1 ? '' : 's'}`}, ${route.ticks} ticks, ${route.rockets} rockets ${route.guide ? 'recorded' : 'planned'}${route.proven ? `, proven, ${((route.score ?? 0) / 20).toFixed(0)} s to the goal` : ', not proven'}`);
const s = await flyBurns(route);
console.log(`   ${s.clean} of ${burns.length} burns out with no hit; the way out ${Math.min(...s.ticksOut)} to ${Math.max(...s.ticksOut)} ticks on ${Math.min(...s.rocketsOut)} to ${Math.max(...s.rocketsOut)} rockets; 70 blocks out after ${(Math.min(...s.ticks70) / 20).toFixed(1)} to ${(Math.max(...s.ticks70) / 20).toFixed(1)} s on ${Math.min(...s.rockets70)} to ${Math.max(...s.rockets70)} rockets, ${Math.min(...s.up70).toFixed(0)} to ${Math.max(...s.up70).toFixed(0)} over the start`);
