// Track F9d (docs/flight.md "Drawn lines (Track F9d)"): the takeoff out of the owner's cave with NO recording (Track F5a's
// private fixture), offline, from the command line: from each waypoint asked for, the lines drawn from the flood to the
// open sky (learn/draw.ts), their rolls, the proof of each as the bot proves it (glide.ts routeTakeoff: every burn, the
// mixes, a first rocket that fires nothing), and the proven line flown at every burn. One row a waypoint. Prints counts,
// times and positions relative to the waypoint only, never a coordinate of the fixture.
//
//   node scripts/cave-drawn-probe.ts [--from cave_start,cave_1 | all] [--to home] [--burns 9,10,...,21] [--each] [--profile]
//        [--radius 128] [--budget 6000] [--cruise <y>] [--tried]
//
// `--from all`: every waypoint inside the fixture's box that has a roof over it. `--each`: a line a burn. `--profile`:
// the proven line every 4 blocks (offsets from the waypoint, the heading, the slope). `--budget`: the takeoff's own budget
// for its proofs (ms; the bot's is route/takeoff.ts TAKEOFF_BUDGET_MS). `--tried`: every line of the decision.
// The world set-up is scripts/cave-exit-probe.ts's (the fixture's cells in the box, its column tops beside it).
import { caveWorld, loadCaveFixture } from '../src/skills/fly/corridor/cave.ts';
import { routeTakeoff, routeTakeoffOptions, simulateFlight, type SimDeps } from '../src/skills/fly/glide.ts';
import { guideLength, guideNearest } from '../src/skills/fly/learn/guide.ts';
import { cruiseHeight, hdist, takeoffSky, type LandingTarget } from '../src/skills/fly/plan.ts';
import type { TerrainQuery } from '../src/skills/fly/terrain.ts';
import { planTakeoffRoute, type TakeoffProof } from '../src/skills/fly/route/takeoff.ts';
import { GLIDE } from '../src/skills/input/physics.ts';
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
const tops = new Map<string, number | undefined>();
const terrain: TerrainQuery = (x, z) => {
  const k = `${x},${z}`;
  if (!tops.has(k)) tops.set(k, skyTop(x, z));
  return { top: tops.get(k), src: 'live' };
};
const deps: SimDeps = { world: query, groundAt, skyTop: (x, z) => skyTop(x, z), terrain };

const cellOf = (name: string): Vec3 => {
  const p = fix.waypoints.get(name);
  if (!p) throw new Error(`no waypoint ${name}`);
  return world.feetCell(p) ?? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
};
const roofed = (c: Vec3): boolean => {
  for (let y = c.y + 1; y <= b.max.y; y++) if (grid.solid(c.x, y, c.z)) return true;
  return false;
};
const goal = cellOf(arg('to', 'home'));
const target: LandingTarget = { x: goal.x + 0.5, z: goal.z + 0.5, top: goal.y, half: 1, hold: true };
const names = arg('from', 'cave_start') === 'all' ? [...fix.waypoints.keys()].filter((n) => inBox(cellOf(n).x, cellOf(n).z) && roofed(cellOf(n))).sort((x, y) => x.localeCompare(y, undefined, { numeric: true })) : arg('from', 'cave_start').split(',');
const burns = arg('burns', '9,10,11,12,13,14,15,16,17,18,19,20,21').split(',').map(Number);
const noPlan = (): never => {
  throw new Error('a drawn line asks no planner');
};

for (const name of names) {
  const start = cellOf(name);
  const from: Vec3 = { x: start.x + 0.5, y: start.y, z: start.z + 0.5 };
  const rel = (s: string): string => s.replace(/(-?\d+) (-?\d+) (-?\d+)(?=,| \(|:|;|$)/g, (_m, x: string, y: string, z: string) => `[${Number(x) - start.x} ${Number(y) - start.y} ${Number(z) - start.z}]`);
  const stand = grid.solid(start.x, start.y - 1, start.z) && !grid.solid(start.x, start.y, start.z) && !grid.solid(start.x, start.y + 1, start.z);
  if (!stand) {
    console.log(`${name}: no place to stand (the waypoint's cell has no floor under it or no two cells of air: water, a ledge's edge): not flown`);
    continue;
  }
  const cruiseY = has('cruise') ? Number(arg('cruise', '133')) : cruiseHeight(from, target, (x, z) => skyTop(x, z), {}).y;
  const flight = { cruiseY, margin: 15, goArounds: 2 };
  let sims = 0;
  const prove: TakeoffProof = async (route) => {
    const r = await routeTakeoff(deps, from, target, flight, 64, { route: { grid, plan: noPlan }, takeoff: routeTakeoffOptions(route, true) }, { planTicks: route.ticks });
    sims += r.sims;
    return r;
  };
  const t0 = performance.now();
  // (the drawn lines alone: no recording, and the exits and the searched ways out left aside: `tries: 0`)
  const got = await planTakeoffRoute(grid, from, target, { rockets: 4, prove, tries: 0, drawn: { top: Math.min(319, Math.ceil(cruiseY)), ...(has('radius') ? { radius: Number(arg('radius', '128')) } : {}) }, budgetMs: Number(arg('budget', '6000')) }, noPlan);
  const ms = performance.now() - t0;
  const d = got.drawn!;
  const head = `${name}: a flood of ${d.cells} cells, ${d.ways} to the open sky, ${d.lines} line${d.lines === 1 ? '' : 's'} drawn and rolled in ${d.ms.toFixed(0)} ms`;
  const route = got.route;
  if (!route?.guide) {
    console.log(`${head}; NO proven line (${sims} simulated, ${ms.toFixed(0)} ms in all): ${got.tried.map(rel).join(' | ').slice(0, has('tried') ? 4000 : 700)}`);
    continue;
  }
  const g = route.guide.line;
  let clean = 0;
  const outTicks: number[] = [];
  const skyTicks: number[] = [];
  const rockets: number[] = [];
  let maxOff = 0;
  const rows: string[] = [];
  for (const burn of burns) {
    let off = 0;
    let skyAt = -1;
    const sim = await simulateFlight(
      deps,
      from,
      target,
      { ...flight, takeoffYaw: route.yaw, route: { grid, plan: noPlan }, routeTakeoff: routeTakeoffOptions(route, true) },
      {
        rockets: 64,
        yaw: route.yaw,
        maxTicks: 300 + route.ticks,
        burn,
        endLag: GLIDE.boostEndLag,
        until: (br, body) => {
          if (br.phase === 'takeoff' && body.gliding) off = Math.max(off, guideNearest(g, body.pos).dist);
          // (the first tick with open sky over the body: the sky check's 3 x 3 up to the cruise height, as the brain asks it)
          if (skyAt < 0 && body.gliding && takeoffSky(body.pos, target, cruiseY, 0, (x, y, z) => solidAt(x, y, z)).ok) skyAt = br.stats.ticks;
          return br.phase === 'approach';
        },
      },
    );
    const s = sim.stats;
    const hits = sim.hits - (sim.bumps ?? 0);
    const ok = s.routeTakeoffEnd === 'out' && hits === 0 && !sim.end && !sim.wet;
    if (ok) clean++;
    if (s.routeTakeoffEnd === 'out') {
      outTicks.push(s.routeTakeoffTicks ?? 0);
      rockets.push(s.routeTakeoffRockets ?? 0);
    }
    if (skyAt >= 0) skyTicks.push(skyAt);
    maxOff = Math.max(maxOff, off);
    rows.push(`      burn ${String(burn).padStart(2)}: ${ok ? 'out, no hit' : `NOT CLEAN (${sim.end ? `ended ${sim.end.ok ? 'landed' : sim.end.reason}` : s.routeTakeoffEnd ?? 'not out'}, ${hits} hits${sim.wet ? ', wet' : ''})`}; the line left after ${s.routeTakeoffTicks ?? '?'} ticks on ${s.routeTakeoffRockets ?? 0} rockets, open sky over the body at tick ${skyAt}, at most ${off.toFixed(2)} off the line; ${hdist(sim.body.pos, from).toFixed(0)} blocks out and ${(sim.body.pos.y - from.y).toFixed(0)} up after ${sim.ticks} ticks, ${s.rockets} rockets, steered ${s.steered}`);
  }
  const span = (a: number[], f: (n: number) => string = (n) => String(n)): string => (a.length ? `${f(Math.min(...a))} to ${f(Math.max(...a))}` : '-');
  console.log(
    `${head}; PROVEN ${g.path}: to ${rel(`${route.exit.x} ${route.exit.y} ${route.exit.z}`)} (${route.drawn?.steps ?? '?'} cells of the flood, a berth of ${route.drawn?.berth ?? '?'}), ${guideLength(g).toFixed(0)} blocks of line, ${route.guide.open.toFixed(0)} to open sky; ${sims} simulated, ${ms.toFixed(0)} ms in all; flown at ${burns.length} burns: ${clean} out with no hit, open sky over the body after ${span(skyTicks, (n) => (n / 20).toFixed(1))} s, the line left after ${span(outTicks)} ticks on ${span(rockets)} rockets, at most ${maxOff.toFixed(2)} off the line`,
  );
  if (has('tried')) for (const t of got.tried) console.log(`      ${rel(t)}`);
  if (has('each')) console.log(rows.join('\n'));
  if (has('profile')) {
    const lines: string[] = [];
    for (let i = 0; i < g.points.length; i += 4) {
      const a = g.points[Math.max(0, i - 2)]!;
      const c = g.points[Math.min(g.points.length - 1, i + 2)]!;
      const q = g.points[i]!;
      lines.push(`      ${String(i).padStart(3)} [${(q.x - from.x).toFixed(1)} ${(q.y - from.y).toFixed(1)} ${(q.z - from.z).toFixed(1)}] tick ${g.ticks[i]!.toFixed(0).padStart(3)} heading ${((Math.atan2(-(c.x - a.x), c.z - a.z) * 180) / Math.PI).toFixed(0).padStart(4)} slope ${((Math.atan2(c.y - a.y, Math.hypot(c.x - a.x, c.z - a.z)) * 180) / Math.PI).toFixed(0).padStart(3)}`);
    }
    console.log(lines.join('\n'));
  }
}
