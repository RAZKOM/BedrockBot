// Track F8 (docs/flight.md "Cave entry (Track F8)"): what the coarse layer plans INTO the owner's cave (Track F5a's private
// fixture), from the command line: the corridor from a surface start to a covered goal and back out, its legs, the change
// portals and the search's effort against its budget. Prints shapes and counts only, never a coordinate of the fixture
// (the lines name legs, axes, clearances and lengths).
//
//   node scripts/cave-entry-probe.ts [--from home|cave_2|<name>] [--to cave_start|<name>] [--ms 4000] [--runs 1]
import { caveLayer } from '../src/skills/fly/corridor/cave-bench.ts';
import { caveWorld, loadCaveFixture, replicaCoarse } from '../src/skills/fly/corridor/cave.ts';
import { CoarseLayerImpl } from '../src/skills/coarse/index.ts';
import { FlightCost } from '../src/skills/fly/corridor/cost.ts';
import { flightSpace } from '../src/skills/fly/corridor/cost.ts';
import { CORRIDOR_JOIN_MS, CORRIDOR_MODES, CORRIDOR_PLAN_MS, joinCorridors } from '../src/skills/fly/corridor/executor.ts';
import { splitLeg } from '../src/skills/fly/corridor/stretches.ts';
import type { Vec3 } from '../src/world/types.ts';

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};

const fix = loadCaveFixture();
if (!fix) {
  console.log('no cave fixture (bot/fixtures-private/cave): nothing to plan');
  process.exit(0);
}
const world = caveWorld(fix.extract);
const dim = fix.extract.dim;
const cellOf = (name: string): Vec3 => {
  const p = fix.waypoints.get(name);
  if (!p) throw new Error(`no waypoint ${name}`);
  return world.feetCell(p) ?? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
};
const homeCell = fix.waypoints.has('home') ? cellOf('home') : undefined;
const replica = replicaCoarse(world, homeCell ? { home: homeCell } : {});
const layer = arg('source', 'fixture') === 'replica' ? new CoarseLayerImpl(replica) : caveLayer(world);
if (arg('source', 'fixture') === 'replica') layer.setCost('fly', new FlightCost());
const from = cellOf(arg('from', 'home'));
const to = cellOf(arg('to', 'cave_start'));
const ms = Number(arg('ms', String(CORRIDOR_PLAN_MS)));
const runs = Number(arg('runs', '1'));
const rel = (p: Vec3): string => `dx ${Math.round(p.x - to.x)} dy ${Math.round(p.y - to.y)} dz ${Math.round(p.z - to.z)}`; // relative to the goal: no coordinate
for (let r = 0; r < runs; r++) {
  const t0 = performance.now();
  let c = await layer.plan({ start: { x: from.x + 0.5, y: from.y, z: from.z + 0.5 }, goal: { x: to.x + 0.5, y: to.y, z: to.z + 0.5 }, dim, modes: CORRIDOR_MODES, startMode: 'walk', goalStanding: true, maxMs: ms });
  const last = c.legs[c.legs.length - 1];
  if (c.status === 'partial' && last && process.argv.includes('--join')) {
    const c2 = await layer.plan({ start: last.to, goal: { x: to.x + 0.5, y: to.y, z: to.z + 0.5 }, dim, modes: CORRIDOR_MODES, startMode: last.mode, goalStanding: true, maxMs: CORRIDOR_JOIN_MS });
    console.log(`  the second search from the partial end: ${c2.status}, ${c2.legs.length} legs (${c2.legs.map((l) => `${l.mode} ${Math.round(l.blocks)}`).join(', ')}), ${c2.expanded} expanded, ${c2.ms.toFixed(0)} ms${c2.reason ? `: ${c2.reason}` : ''}`);
    if (c2.status === 'found') c = joinCorridors(c, c2);
  }
  console.log(`${arg('from', 'home')} -> ${arg('to', 'cave_start')} (straight ${Math.round(Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z))} blocks): ${c.status}, ${c.legs.length} legs, ${Math.round(c.blocks)} blocks, cost ${Math.round(c.cost)}, ${c.expanded} expanded, ${c.ms.toFixed(0)} ms search (${(performance.now() - t0).toFixed(0)} wall)${c.reason ? `: ${c.reason}` : ''}`);
  for (const [i, leg] of c.legs.entries()) {
    const classify = (p: Vec3) => {
      const v = layer.volumeAt(p, dim);
      return v ? flightSpace(v) : undefined;
    };
    const stretches = leg.mode === 'fly' ? splitLeg(leg, classify) : [];
    console.log(`  leg ${i + 1}: ${leg.mode} ${Math.round(leg.blocks)} blocks, cost ${Math.round(leg.cost)}, ${leg.portals.length} portals, ${leg.volumes.length} volumes, ends ${rel(leg.to)} from the goal${stretches.length ? `; stretches ${stretches.map((s) => `${s.space} ${Math.round(s.points.reduce((a, p, k) => (k ? a + Math.hypot(p.x - s.points[k - 1]!.x, p.y - s.points[k - 1]!.y, p.z - s.points[k - 1]!.z) : 0), 0))}${s.leave ? ` ->${s.leave.axis} ${s.leave.clearance.height}x${s.leave.clearance.width}${s.leave.floorY !== undefined ? ' floor' : ''}` : ''}`).join(', ')}` : ''}`);
    for (const p of leg.portals) {
      const va = layer.graph.volume(p.a);
      const vb = layer.graph.volume(p.b);
      if (process.argv.includes('--portals')) console.log(`    portal ${p.axis} ${p.clearance.height}x${p.clearance.width}${p.floorY !== undefined ? ' floor' : ''} ${p.known}: ${va?.kind ?? '?'} (${va?.floorCells ?? '?'} floor cells, headroom ${va?.headroom?.min ?? '-'}..${va?.headroom?.max ?? '-'}, span ${va?.minSpan ?? '?'}) <-> ${vb?.kind ?? '?'} (${vb?.floorCells ?? '?'}, headroom ${vb?.headroom?.min ?? '-'}..${vb?.headroom?.max ?? '-'}, span ${vb?.minSpan ?? '?'}), centre ${rel(p.center)}`);
    }
  }
}
console.log(`graph: ${layer.graph.stats.builds} chunk builds in ${layer.graph.stats.buildMs.toFixed(0)} ms, ${layer.graph.stats.borders} borders in ${layer.graph.stats.borderMs.toFixed(0)} ms`);
