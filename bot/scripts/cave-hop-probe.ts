// Track F9e (docs/flight.md "Drawn lines, the way in and under one roof (Track F9e)"): flights between two places under
// one roof on Track F5a's private fixture, offline, from the command line: the hop drawn from the world (learn/hop.ts),
// proven as the bot proves it (glide.ts routeHop: every burn, the mixes, a first rocket that fires nothing), and the
// proven hop flown at every burn. Prints counts, times and positions relative to a waypoint only, never a coordinate of
// the fixture.
//
//   node scripts/cave-hop-probe.ts --from cave_start --to cave_end [--each] [--trace 9] [--last 40] [--tried]
//   node scripts/cave-hop-probe.ts --pairs cave [--skip 1,2,3]       every pair of the route cave_start, cave_1 .. cave_N,
//                                                                    cave_end: each waypoint to the next, and (`--skip`) to
//                                                                    the one that many places on
//   node scripts/cave-hop-probe.ts --chain cave_8,cave_12,cave_end   the hops in turn, each from where the last one stood
//
// `--replica`: the world as the replica on the test server has it. `--each`: a line a burn. `--trace <burn>`: every tick of the first hop line at that burn (`--last` ticks of it).
import { simulateFlight, routeHop, routeTakeoffOptions } from '../src/skills/fly/glide.ts';
import { ENTRY_AIR, ENTRY_SOLID, ENTRY_WATER, entryTouchdowns } from '../src/skills/fly/learn/entry.ts';
import { FOLLOW_MARGIN } from '../src/skills/fly/learn/follow.ts';
import { guideLength, guideNearest } from '../src/skills/fly/learn/guide.ts';
import { drawHops, type DrawnHop } from '../src/skills/fly/learn/hop.ts';
import type { LandingTarget } from '../src/skills/fly/plan.ts';
import { boxClear } from '../src/skills/fly/route/grid.ts';
import { GLIDE } from '../src/skills/input/physics.ts';
import type { Vec3 } from '../src/world/types.ts';
import { caveProbeWorld } from './cave-probe-world.ts';

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const w = caveProbeWorld({ replica: has('replica') });
if (!w) {
  console.log('no cave fixture (bot/fixtures-private/cave): nothing to fly');
  process.exit(0);
}
const { grid, deps } = w;
const classOf = (x: number, y: number, z: number): number => (w.solidAt(x, y, z) ? ENTRY_SOLID : grid.solid(x, y, z) ? ENTRY_WATER : ENTRY_AIR);
const noPlan = (): never => {
  throw new Error('a hop asks no planner');
};
const burns = arg('burns', '9,10,11,12,13,14,15,16,17,18,19,20,21').split(',').map(Number);

interface HopRun {
  proven: boolean;
  /** Where the body stands after the nominal flight (the next hop's start), the line's length, the seconds of the slowest burn. */
  stood?: Vec3;
  length?: number;
  seconds?: [number, number];
  said: string;
}

/** One hop from a feet position to a waypoint's cell: drawn, proven, flown at every burn. */
async function hop(fromName: string, from: Vec3, toName: string): Promise<HopRun> {
  const goal = w!.cellOf(toName);
  const fromCell = { x: Math.floor(from.x), y: Math.floor(from.y + 1e-6), z: Math.floor(from.z) };
  const rel = (s: string): string =>
    s
      .replace(/(-?\d+\.\d+) (-?\d+\.\d+) (-?\d+\.\d+)/g, (_m, x: string, y: string, z: string) => `[${(Number(x) - from.x).toFixed(1)} ${(Number(y) - from.y).toFixed(1)} ${(Number(z) - from.z).toFixed(1)}]`)
      .replace(/(-?\d+) (-?\d+) (-?\d+)(?=,| \(|:|;|$)/g, (_m, x: string, y: string, z: string) => `[${Number(x) - fromCell.x} ${Number(y) - fromCell.y} ${Number(z) - fromCell.z}]`)
      .replace(/, \d+ from the target/g, '');
  const head = `${fromName} -> ${toName}`;
  if (!w!.stands(fromCell)) return { proven: false, said: `${head}: no place to stand at the start (no floor under its cell, or no two cells of air)` };
  const cells = entryTouchdowns(classOf, goal);
  const t0 = performance.now();
  const d = drawHops(grid, from, goal, cells, w!.top, { ...(has('radius') ? { radius: Number(arg('radius', '192')) } : {}), ...(has('max') ? { max: Number(arg('max', '120000')) } : {}) });
  const drawMs = performance.now() - t0;
  if (!d.hops.length) return { proven: false, said: `${head}: NO line (${d.why ?? d.tried.join(' | ')}; ${d.cells} cells looked at, ${drawMs.toFixed(0)} ms)` };
  const target = (h: DrawnHop): LandingTarget => ({ x: goal.x + 0.5, z: goal.z + 0.5, top: goal.y, half: 2, entry: { line: h.line, goal: { x: goal.x + 0.5, z: goal.z + 0.5, top: goal.y, half: 2 } } });
  const flight = (h: DrawnHop) => ({ route: { grid, plan: noPlan }, takeoff: routeTakeoffOptions({ goals: [], margin: FOLLOW_MARGIN, weight: 2, guide: { line: h.guide, open: Infinity, off: 0 }, hop: { hand: h.hand } }, false) });
  const opts = { cruiseY: from.y + 24, margin: 15, goArounds: 0 };
  const planTicks = (h: DrawnHop): number => h.guide.ticks[h.guide.ticks.length - 1] ?? 0;
  if (has('trace')) {
    const seq = arg('trace', '9').split(',').map(Number);
    const burn = seq.length === 1 ? seq[0]! : (r: number): number => seq[Math.min(seq.length - 1, r)]!;
    const h = d.hops[Number(arg('line', '1')) - 1] ?? d.hops[0]!;
    const g = h.guide;
    const notes: string[] = [];
    const rows: string[] = [];
    const sim = await simulateFlight(deps, from, target(h), { ...opts, takeoffYaw: g.yaw, route: flight(h).route, routeTakeoff: flight(h).takeoff, note: (m) => notes.push(`t${rows.length}: ${rel(m)}`) }, {
      rockets: 64,
      yaw: g.yaw,
      maxTicks: 200 + 1.5 * planTicks(h),
      burn,
      endLag: GLIDE.boostEndLag,
      until: (br, body) => {
        const n = guideNearest(g, body.pos);
        const hs = Math.hypot(body.vel.x, body.vel.z);
        rows.push(`   t${String(br.stats.ticks).padStart(3)} ${br.phase.padEnd(7)} at ${n.at.toFixed(1).padStart(6)} off ${n.dist.toFixed(2)} speed ${Math.hypot(hs, body.vel.y).toFixed(2)} climb ${((Math.atan2(body.vel.y, hs) * 180) / Math.PI).toFixed(0).padStart(3)} boost ${String(body.boostTicks ?? 0).padStart(2)} cap ${g.speeds![Math.min(g.speeds!.length - 1, Math.round(n.at))]!.toFixed(2)} room ${boxClear(grid, body.pos, 0).clearance.toFixed(2)}${body.collidedHorizontally || body.collidedVertically ? ' CONTACT' : ''}${body.inWater ? ' WATER' : ''}`);
        return false;
      },
    });
    console.log(`${head}: ${g.path}, ${guideLength(g).toFixed(0)} blocks (${h.at}), the last rocket ${g.hop!.from.toFixed(0)} to ${g.hop!.to.toFixed(0)} blocks along it, the flier from ${h.hand.toFixed(0)}; at a burn of ${seq.join(',')}: ${sim.end ? `${sim.end.ok ? 'landed' : `ended ${sim.end.reason}`} ${Math.hypot(sim.end.landedAt.x - goal.x - 0.5, sim.end.landedAt.z - goal.z - 0.5).toFixed(1)} from the goal` : `still ${sim.phase}`} after ${sim.ticks} ticks, ${sim.stats.rockets} rockets, ${sim.hard ?? 0} hard hits, ${sim.hits} contacts`);
    for (const n of notes) console.log(`     ${n.slice(0, 420)}`);
    console.log(rows.slice(-Number(arg('last', '40'))).join('\n'));
    return { proven: false, said: '' };
  }
  const tried: string[] = [];
  let sims = 0;
  let proven: DrawnHop | undefined;
  const t1 = performance.now();
  for (const h of d.hops.slice(0, Number(arg('tries', '3')))) {
    const p = await routeHop(deps, from, target(h), opts, 64, flight(h), { planTicks: planTicks(h), yaw: h.guide.yaw });
    sims += p.sims;
    tried.push(`${h.guide.path} (${guideLength(h.guide).toFixed(0)} blocks, ${h.at}, ${h.climb.toFixed(0)} from its lowest to its highest): ${p.line}${p.ok ? '' : ': refused'}`);
    // (a hop that a first rocket that fires nothing brings down short of the goal with no hit is flown all the same, as the bot does)
    if (p.ok) {
      proven = h;
      break;
    }
  }
  const proofMs = performance.now() - t1;
  const times = `${d.cells} cells looked at and ${d.hops.length} line${d.hops.length === 1 ? '' : 's'} drawn in ${drawMs.toFixed(0)} ms, ${sims} simulated in ${proofMs.toFixed(0)} ms`;
  if (!proven) return { proven: false, said: `${head}: NOT proven (${times}): ${rel(tried.join(' | ')).slice(0, has('tried') ? 4000 : 600)}` };
  const g = proven.guide;
  const len = guideLength(g);
  let arrived = 0;
  let hard = 0;
  let worst = 0;
  const secs: number[] = [];
  const rks: number[] = [];
  const rows: string[] = [];
  let stood: Vec3 | undefined;
  for (const burn of burns) {
    let off = 0;
    const sim = await simulateFlight(deps, from, target(proven), { ...opts, takeoffYaw: g.yaw, route: flight(proven).route, routeTakeoff: flight(proven).takeoff }, {
      rockets: 64,
      yaw: g.yaw,
      maxTicks: 200 + 1.5 * planTicks(proven),
      burn,
      endLag: GLIDE.boostEndLag,
      until: (br, body) => {
        if (body.gliding) off = Math.max(off, guideNearest(g, body.pos).dist);
        return false;
      },
    });
    const at = sim.end?.landedAt;
    const d2 = at ? Math.hypot(at.x - goal.x - 0.5, at.z - goal.z - 0.5) : Infinity;
    const ok = at !== undefined && d2 <= 2 && Math.abs(at.y - goal.y) <= 2 && !sim.wet;
    if (ok) arrived++;
    hard += sim.hard ?? 0;
    worst = Math.max(worst, off);
    secs.push(sim.ticks / 20);
    rks.push(sim.stats.rockets);
    if (burn === GLIDE.boostTicks && at) stood = { ...at };
    rows.push(`      burn ${String(burn).padStart(2)}: ${ok ? `standing ${d2.toFixed(1)} from the goal` : `NOT there (${sim.end ? `${sim.end.ok ? 'stands' : `ended ${sim.end.reason}`} ${d2.toFixed(1)} from it` : `still ${sim.phase}`}${sim.wet ? ', wet' : ''})`} after ${sim.ticks} ticks (${(sim.ticks / 20).toFixed(1)} s) on ${sim.stats.rockets} rockets, ${sim.hard ?? 0} hard hits, ${sim.hits - (sim.hard ?? 0)} touches, at most ${off.toFixed(2)} off the line, the flier took it after ${sim.stats.routeTakeoffTicks ?? '?'} ticks`);
  }
  // `--fuzz n`: n more flights of the proven hop, every rocket of each burning its own number of ticks (9 to 21, from a
  // seeded generator: `--seed`), which no proof flies
  let fuzz = '';
  if (has('fuzz')) {
    let seed = Number(arg('seed', '1')) >>> 0;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const n = Number(arg('fuzz', '40'));
    let fine = 0;
    const bad: string[] = [];
    for (let k = 0; k < n; k++) {
      const of: number[] = [];
      const sim = await simulateFlight(deps, from, target(proven), { ...opts, takeoffYaw: g.yaw, route: flight(proven).route, routeTakeoff: flight(proven).takeoff }, { rockets: 64, yaw: g.yaw, maxTicks: 200 + 1.5 * planTicks(proven), burn: (r: number): number => (of[r] ??= 9 + Math.floor(rnd() * 13)), endLag: GLIDE.boostEndLag });
      const at = sim.end?.landedAt;
      const d2 = at ? Math.hypot(at.x - goal.x - 0.5, at.z - goal.z - 0.5) : Infinity;
      if (at !== undefined && d2 <= 2 && Math.abs(at.y - goal.y) <= 2 && !sim.wet && !sim.hard) fine++;
      else bad.push(`burns ${of.join(',')}: ${sim.end ? `${sim.end.ok ? 'stands' : `ended ${sim.end.reason}`} ${d2.toFixed(1)} from the goal` : `still ${sim.phase}`}, ${sim.hard ?? 0} hard hits${sim.wet ? ', wet' : ''}, after ${sim.ticks} ticks (the flier took it after ${sim.stats.routeTakeoffTicks ?? '?'})`);
    }
    fuzz = `\n      fuzz: ${fine} of ${n} flights with a burn of its own for every rocket standing within 2 of the goal with no hard hit${bad.length ? `; NOT: ${bad.join(' | ')}` : ''}`;
  }
  const said = `${head}: PROVEN ${g.path}: ${len.toFixed(0)} blocks of line (${proven.at}), ${proven.climb.toFixed(0)} from its lowest to its highest; ${times}; flown at ${burns.length} burns: ${arrived} standing within 2 of the goal, ${hard} hard hits, ${Math.min(...secs).toFixed(1)} to ${Math.max(...secs).toFixed(1)} s on ${Math.min(...rks)} to ${Math.max(...rks)} rockets, at most ${worst.toFixed(2)} off the line${fuzz}${has('each') ? `\n${rows.join('\n')}` : ''}${has('tried') ? `\n      ${rel(tried.join('\n      '))}` : ''}`;
  return { proven: true, ...(stood ? { stood } : {}), length: len, seconds: [Math.min(...secs), Math.max(...secs)], said };
}

const feet = (name: string): Vec3 => {
  const c = w.cellOf(name);
  return { x: c.x + 0.5, y: c.y, z: c.z + 0.5 };
};

if (has('pairs')) {
  const prefix = arg('pairs', 'cave');
  const mid = w.names.filter((n) => new RegExp(`^${prefix}_\\d+$`).test(n));
  const route = [`${prefix}_start`, ...mid, `${prefix}_end`];
  for (const skip of arg('skip', '1').split(',').map(Number)) {
    for (let i = 0; i + skip < route.length; i++) console.log((await hop(route[i]!, feet(route[i]!), route[i + skip]!)).said);
  }
} else if (has('chain')) {
  const names = arg('chain', '').split(',');
  let at = feet(names[0]!);
  let from = names[0]!;
  let total = 0;
  let lo = 0;
  let hi = 0;
  for (const next of names.slice(1)) {
    const r = await hop(from, at, next);
    console.log(r.said);
    if (!r.proven || !r.stood) {
      console.log(`   the chain stops at ${from}: the hop to ${next} is walked, as before`);
      at = feet(next);
    } else {
      at = r.stood;
      total += r.length ?? 0;
      lo += r.seconds![0];
      hi += r.seconds![1];
    }
    from = next;
  }
  console.log(`chain ${names.join(' -> ')}: ${total.toFixed(0)} blocks flown in ${lo.toFixed(1)} to ${hi.toFixed(1)} s of flight (the decisions and the standing between the hops not counted)`);
} else {
  console.log((await hop(arg('from', 'cave_start'), feet(arg('from', 'cave_start')), arg('to', 'cave_end'))).said);
}
