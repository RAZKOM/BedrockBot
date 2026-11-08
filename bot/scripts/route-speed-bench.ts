// Track F6 (docs/flight.md "Tight cave flight (Track F6)"): the route search's speed on this machine, so the live
// budgets can be set in nodes a second measured where the bot runs (the deploy host) rather than in this PC's ms.
// Plans from standing through the first waypoints of the generated caves (route/caves.ts: no private data), the
// nodes budget binding (the ms budget wide open), over the worker's dense snapshot as the live planner has it.
//
//   node scripts/route-speed-bench.ts [--nodes 30000] [--caves 0,2,5,8] [--repeat 2]
//
// Prints one line per request (expanded, nodes, ms, nodes per ms) and the median rate. Read-only: nothing is
// written anywhere.
import { landingGoal, viaGoal } from '../src/skills/fly/corridor/stretches.ts';
import { caveSet } from '../src/skills/fly/route/caves.ts';
import { gridOf } from '../src/skills/fly/route/grid.ts';
import { planRoute } from '../src/skills/fly/route/search.ts';
import { NO_BOOST, type RouteGoal, type RouteRequest } from '../src/skills/fly/route/types.ts';
import { gridOfSnapshot, snapshotFor } from '../src/skills/fly/route/worker.ts';

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};
const nodes = Number(arg('nodes', '30000'));
const caves = arg('caves', '0,2,5,8').split(',').map(Number);
const repeat = Number(arg('repeat', '2'));
const set = caveSet();
const rates: number[] = [];
for (const k of caves) {
  const cave = set[k]!;
  const solid = (x: number, y: number, z: number): boolean => cave.world.solidAt(x, y, z) === true;
  const grid = gridOf(cave.world);
  // from the mouth through the second waypoint to a landing on the third (about 40 to 60 blocks of cave)
  const from = { x: cave.waypoints[0]!.x + 0.5, y: cave.waypoints[0]!.y, z: cave.waypoints[0]!.z + 0.5 };
  const goals: RouteGoal[] = [viaGoal({ x: cave.waypoints[1]!.x + 0.5, y: cave.waypoints[1]!.y, z: cave.waypoints[1]!.z + 0.5 }), landingGoal(cave.waypoints[2]!, solid)];
  const first = { x: cave.waypoints[1]!.x + 0.5, z: cave.waypoints[1]!.z + 0.5 };
  const yaw = (Math.atan2(-(first.x - from.x), first.z - from.z) * 180) / Math.PI;
  const req: RouteRequest = { start: { pos: from, vel: { x: 0, y: 0, z: 0 }, yaw, boost: { ...NO_BOOST }, gliding: false, rockets: 16, wp: 0 }, goals, margin: 0.4, maxNodes: nodes, maxMs: 600_000, weight: 2, riskCost: 2 };
  const snap = gridOfSnapshot(snapshotFor(grid, req));
  for (let r = 0; r < repeat; r++) {
    const p = planRoute(req, snap);
    const rate = p.nodes / p.ms;
    rates.push(rate);
    console.log(`${cave.name}: ${p.complete ? 'complete' : 'partial'} ${p.reached}/${goals.length}, ${p.expanded} expanded, ${p.nodes} nodes, ${p.ms.toFixed(0)} ms, ${rate.toFixed(1)} nodes/ms`);
  }
}
rates.sort((a, b) => a - b);
const median = rates[Math.floor(rates.length / 2)]!;
console.log(`median ${median.toFixed(1)} nodes/ms (${(median * 600).toFixed(0)} nodes in 600 ms, ${(median * 2000).toFixed(0)} in 2 s)`);
