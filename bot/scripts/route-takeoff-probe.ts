// Track F10 (docs/flight.md "The open-air flight on the burn of the rockets at hand"): the searched route takeoffs
// offline (a way out planned by the route planner, no line): out from under a slab with a cliff across the goal's
// heading, out of a room under a roof 3 above, out of a 1 x 1 hole 2 deep. Each is planned and proven as the bot does it
// (route/takeoff.ts planTakeoffRoute with glide.ts routeTakeoff as its proof), once told nothing (the plain rocket's 9 to
// 21: `flyKitBurn` off) and once told a kit's burn (`--told 1`: 19 to 31), and the proven takeoff is then flown at every
// burn of `--burns` (default 19 to 31, a crafted rocket's). One line a case and a telling: the plan, the proof's own
// line, the wall time of the decision (the searches and the proof's simulations: measure it on the test host), and how
// many of the flights came out through the exit with no hit and were still flying 300 ticks later.
//
//   node scripts/route-takeoff-probe.ts [--case cliff,room3,hole1] [--told 1] [--burns 19,20,...,31] [--ms 800] [--nodes 40000]
//
// `--ms` / `--nodes`: the search's budget a request (the bot's are route/takeoff.ts TAKEOFF_PLAN_MS and
// TAKEOFF_PLAN_NODES; the default here is a node budget alone, so that a flight is the same every time it is flown).
import { burnRange } from '../src/skills/fly/burn.ts';
import { routeTakeoff, routeTakeoffOptions, simulateFlight } from '../src/skills/fly/glide.ts';
import { cruiseHeight, type LandingTarget } from '../src/skills/fly/plan.ts';
import { gridOf } from '../src/skills/fly/route/grid.ts';
import { planRoute } from '../src/skills/fly/route/search.ts';
import { planTakeoffRoute, type TakeoffRoute } from '../src/skills/fly/route/takeoff.ts';
import type { RouteRequest } from '../src/skills/fly/route/types.ts';
import type { BlockBox } from '../src/skills/input/index.ts';
import { FEET, world } from '../test/unit/skills/fly-worlds.ts';

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const CASES: Record<string, { boxes: BlockBox[]; from: { x: number; y: number; z: number } }> = {
  // a slab 7 x 7 three over the start on open ground, and a cliff 50 high across the goal's heading from 10 blocks out (test/unit/skills/fly-cave-exit.test.ts)
  cliff: {
    boxes: [
      { from: { x: -3, y: FEET + 3, z: -3 }, to: { x: 3, y: FEET + 3, z: 3 }, solid: true },
      { from: { x: -30, y: FEET, z: 10 }, to: { x: 30, y: FEET + 49, z: 50 }, solid: true },
    ],
    from: { x: 0.5, y: FEET, z: 0.5 },
  },
  // a cell under a roof 3 above at ground level, open on one side (test/e2e/fly-route-land.test.ts room3)
  room3: {
    boxes: [
      { from: { x: -3, y: FEET, z: -3 }, to: { x: 3, y: FEET + 3, z: 3 }, solid: true },
      { from: { x: -2, y: FEET, z: -3 }, to: { x: 2, y: FEET + 2, z: 2 }, solid: false },
    ],
    from: { x: 0.5, y: FEET, z: 0.5 },
  },
  // a 1 x 1 hole 2 deep in the ground (fly-route-land.test.ts hole1)
  hole1: { boxes: [{ from: { x: 0, y: FEET - 2, z: 0 }, to: { x: 0, y: FEET - 1, z: 0 }, solid: false }], from: { x: 0.5, y: FEET - 2, z: 0.5 } },
};

const told = has('told') ? burnRange(Number(arg('told', '1'))) : undefined;
const burns = arg('burns', '19,20,21,22,23,24,25,26,27,28,29,30,31').split(',').map(Number);
const maxMs = Number(arg('ms', '1000000000'));
const maxNodes = Number(arg('nodes', '40000'));
const target: LandingTarget = { x: 0.5, z: 600.5, top: FEET, half: 1 };

for (const name of arg('case', 'cliff,room3,hole1').split(',')) {
  const c = CASES[name];
  if (!c) throw new Error(`no case ${name}`);
  const w = world(c.boxes);
  const grid = gridOf(w.solid);
  const cz = cruiseHeight(c.from, target, w.skyTop, {});
  const deps = { world: w.solid, groundAt: w.dryGround, skyTop: w.skyTop };
  const plan = (req: RouteRequest) => planRoute({ ...req, maxMs: Math.min(req.maxMs, maxMs), maxNodes: Math.min(req.maxNodes, maxNodes) }, grid);
  const lines: string[] = [];
  let sims = 0;
  const t0 = performance.now();
  const got = await planTakeoffRoute(grid, c.from, target, {
    rockets: 4,
    maxMs,
    maxNodes,
    ...(told ? { kit: told } : {}),
    prove: async (route: TakeoffRoute) => {
      const p = await routeTakeoff(deps, c.from, target, { cruiseY: cz.y, ...(told ? { burn: told } : {}) }, 64, { route: { grid, plan, maxMs }, takeoff: routeTakeoffOptions(route, true) }, { planTicks: route.ticks });
      sims += p.sims;
      if (p.ok) lines.push(p.line);
      return p;
    },
  });
  const ms = performance.now() - t0;
  const head = `${name}, told ${told ? `${told.min} to ${told.max}` : 'nothing (9 to 21)'}`;
  if (!got.route) {
    console.log(`${head}: no proven takeoff (${sims} simulated, ${ms.toFixed(0)} ms): ${got.tried.join('; ')}`);
    continue;
  }
  const r = got.route;
  let clean = 0;
  const said: string[] = [];
  for (const burn of burns) {
    const sim = await simulateFlight(deps, c.from, target, { cruiseY: cz.y, takeoffYaw: r.yaw, ...(told ? { burn: told } : {}), route: { grid, plan, maxMs }, routeTakeoff: routeTakeoffOptions(r, true) }, { rockets: 64, yaw: r.yaw, maxTicks: 300 + r.ticks, burn, endLag: 2, until: (b) => b.phase === 'approach' });
    const hits = sim.hits - (sim.bumps ?? 0);
    if (sim.stats.routeTakeoffEnd === 'out' && hits === 0 && !sim.end && !sim.wet) clean++;
    else said.push(`burn ${burn}: ${sim.stats.routeTakeoffEnd ?? 'never out'}, ${hits} hits${sim.end ? `, ${sim.end.ok ? 'landed' : sim.end.reason}` : ''}`);
  }
  console.log(`${head}: the plan ${r.ticks} ticks on ${r.rockets} rocket${r.rockets === 1 ? '' : 's'} (${r.edges}); ${lines[lines.length - 1] ?? 'no proof'}; the decision ${sims} simulated, ${ms.toFixed(0)} ms; flown at ${burns[0]} to ${burns[burns.length - 1]}: ${clean} of ${burns.length} out with no hit${said.length ? ` (${said.join('; ')})` : ''}`);
}
