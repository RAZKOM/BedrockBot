// Track F22 (docs/flight.md "The hop asked from a walk (Track F22)"): the hop under one roof AS A TRIP MEETS IT, on Track
// F5a's private fixture, decided as the bot decides it (learn/under.ts on the two layers of skills/fly/corridor/cave-under.ts).
// Prints counts, times and positions relative to a waypoint only, never a coordinate of the fixture.
//
//   node scripts/cave-hop-walk-probe.ts --hop cave_end,cave_start --fuzz 200 [--live 40] [--late 2,6]
//        one decision from the first waypoint, the proven line flown that many times with a burn of its own for every
//        rocket; `--late a,b`: every burn's end seen that many ticks late by the loop (a number of its own for every
//        rocket), as on a server a round trip away; `--off 0.5,1`: from places that far beside where it was proven too;
//        `--proof n`: the decision's proof flies the late ends as well (learn/under.ts `late`)
//   node scripts/cave-hop-walk-probe.ts --hop cave_end,cave_start --walk 30 [--late 2,6]
//        the hop asked from that many places along a walk from the first waypoint to the second (the floors under the
//        way the hop's own flood takes: the passage), BEFORE the track and AFTER it:
//          before   the hop is asked from the walking body; the walk goes on while the decision runs (`--speed` blocks a
//                   tick, the decision's own milliseconds on this host times `--host`); the walk is stopped where the body
//                   is by then and the hop asked again from there; what is proven is flown (the proof and the hop's last
//                   blocks as they were: the fall the server counts not looked at, any sink)
//          after    the walk asks whether a hop may be there (scoutHop), stops, and the hop is decided once, standing,
//                   its proof flying the late ends at the lag the connection's rockets show; a hop that loses its line
//                   is asked again from where the body came down
//        every flight with a burn of its own for every rocket and its end seen `--late` ticks late.
import { damageForCounted } from '../src/skills/fall/damage.ts';
import { burnRange, burnSaid } from '../src/skills/fly/burn.ts';
import { ENTRY_SWITCH } from '../src/skills/fly/learn/entry.ts';
import { PROOF_SWITCH, routeTakeoffOptions, simulateFlight, type SimResult } from '../src/skills/fly/glide.ts';
import { guideLength, guideNearest } from '../src/skills/fly/learn/guide.ts';
import { floodTo, rememberedGrid } from '../src/skills/fly/learn/draw.ts';
import { ENTRY_AIR, ENTRY_SOLID, entryTouchdowns } from '../src/skills/fly/learn/entry.ts';
import { HOP_FLOOD_MAX, HOP_RADIUS } from '../src/skills/fly/learn/hop.ts';
import { hopTarget, liveGrid, pickHop, scoutHop, seenGrid, standNear, type UnderPick } from '../src/skills/fly/learn/under.ts';
import { RocketLag } from '../src/skills/fly/rocket.ts';
import { GLIDE } from '../src/skills/input/physics.ts';
import type { Vec3 } from '../src/world/types.ts';
import { caveUnderWorld } from '../src/skills/fly/corridor/cave-under.ts';

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

/** The flight and the proof as they were before the track (a hop's last blocks at any sink, the counted fall not looked at), or as they are. */
const asBefore = (on: boolean): void => {
  ENTRY_SWITCH.sink = !on;
  PROOF_SWITCH.fall = !on;
};
// (`--before`: the one-line modes fly and prove as before the track)
if (has('before')) asBefore(true);
const cu = caveUnderWorld(Number(arg('live', '9')));
if (!cu) {
  console.log('no cave fixture (bot/fixtures-private/cave): nothing to fly');
  process.exit(0);
}
const { w, liveSim } = cu;
const burn = burnRange(Number(arg('flight', '1')));
const noPlan = (): never => {
  throw new Error('a line under a roof asks no planner');
};
const [lateLo = GLIDE.boostEndLag, lateHi = lateLo] = arg('late', String(GLIDE.boostEndLag)).split(',').map(Number);
// (`--slow p,n`: one rocket in 1/p has its end seen n ticks late instead: a slow packet now and then, as the Realm's log has)
const [slowP = 0, slowN = 6] = arg('slow', '0').split(',').map(Number);
const lateOf = (r: () => number): number => (slowP > 0 && r() < slowP ? slowN : lateLo + Math.floor(r() * (lateHi - lateLo + 1)));
const lateSaid = `${lateLo === lateHi ? lateLo : `${lateLo} to ${lateHi}`} ticks late${slowP > 0 ? ` (${slowN} for one rocket in ${Math.round(1 / slowP)})` : ''}`;
const feet = (c: Vec3): Vec3 => ({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 });
const options = (from: Vec3, goalY: number, late?: number) => ({ rockets: 64, burn, margin: 15, top: Math.min(319, Math.max(Math.floor(from.y), goalY) + 64), plan: noPlan, ...(late !== undefined ? { late } : {}) });
let seed = Number(arg('seed', '1')) >>> 0;
const rnd = (): number => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};
const span = (a: number[], f: (n: number) => string = (n) => String(Math.round(n))): string => (a.length ? (Math.min(...a) === Math.max(...a) ? f(a[0]!) : `${f(Math.min(...a))} to ${f(Math.max(...a))}`) : '-');
const median = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;

type Hop = NonNullable<UnderPick['hop']>;
interface Flown {
  sim: SimResult;
  /** standing within 2 of the hop's cell with no hard hit and dry */
  fine: boolean;
  /** how the flight ended; the blocks along the line it got; the most it was off it; the blocks from the hop's cell it ended */
  end: string;
  at: number;
  off: number;
  from: number;
  notes: string[];
  burns: number[];
  lates: number[];
  /** the damage of the fall the server would have counted at the landing (fall/damage.ts) */
  hurt: number;
}

/** One flight of a proven hop from `start`: every rocket with a burn of its own, its end seen late by the loop (`--late`). */
async function fly(pick: Hop, start: Vec3): Promise<Flown> {
  const h = pick.drawn;
  const g = h.guide;
  const notes: string[] = [];
  const burns: number[] = [];
  const lates: number[] = [];
  let off = 0;
  let at = 0;
  const sim = await simulateFlight(liveSim, start, hopTarget(h, pick.cell), { cruiseY: start.y + 24, margin: 15, goArounds: 0, takeoffYaw: g.yaw, route: { grid: liveGrid(w), plan: noPlan }, routeTakeoff: routeTakeoffOptions(pick.route, true), note: (m) => notes.push(m) }, {
    rockets: 64,
    yaw: g.yaw,
    maxTicks: 200 + 1.5 * pick.route.ticks,
    burn: (r) => (burns[r] ??= burn.min + Math.floor(rnd() * (burn.max - burn.min + 1))),
    endLate: (r) => (lates[r] ??= lateOf(rnd)),
    until: (_br, body) => {
      if (body.gliding) {
        const n = guideNearest(g, body.pos);
        off = Math.max(off, n.dist);
        at = n.at;
      }
      return false;
    },
  });
  const e = sim.end?.landedAt ?? sim.body.pos;
  const from = Math.hypot(e.x - pick.cell.x - 0.5, e.y - pick.cell.y, e.z - pick.cell.z - 0.5);
  const fine = sim.end !== undefined && Math.hypot(e.x - pick.cell.x - 0.5, e.z - pick.cell.z - 0.5) <= 2 && Math.abs(e.y - pick.cell.y) <= 2 && !sim.wet && !sim.hard;
  return { sim, fine, end: sim.end ? (sim.end.ok ? 'stands' : `ended ${sim.end.reason}`) : `still ${sim.phase}`, at, off, from, notes, burns, lates, hurt: damageForCounted(sim.fall ?? 0) };
}

const said = (f: Flown, g: Hop): string => `${f.hurt ? `HURT ${f.hurt} (a fall of ${(f.sim.fall ?? 0).toFixed(0)} counted), ` : ''}${f.end} ${f.at.toFixed(0)} of ${guideLength(g.drawn.guide).toFixed(0)} blocks along the line, at most ${f.off.toFixed(2)} off it, ${f.sim.hard ?? 0} hard hits${f.sim.wet ? ', wet' : ''}, ${f.sim.ticks} ticks, ${f.sim.stats.rockets} rockets`;

/** The lag a hop's proof takes on a connection whose rockets are seen `--late` ticks late: as the bot reckons it (rocket.ts RocketLag over its last rockets: the entity comes a tick sooner than the removal is known). */
function proofLate(): number {
  // (the lag the bot settles on: the median of what its last 40 rockets give, over many such runs of rockets)
  let s = 12345;
  const r = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const lates: number[] = [];
  for (let run = 0; run < 201; run++) {
    const lag = new RocketLag();
    for (let k = 0; k < 40; k++) lag.note(lateOf(r) - 1);
    lates.push(lag.late);
  }
  return median(lates);
}

/**
 * The places a walk through the passage stands on: the floors under the way the hop's own flood takes from the start to
 * the goal (the passage the waypoints mark), cell by cell of that way (a cell with no floor under it: none). Looked for
 * with the whole cave live, so that every floor is seen.
 */
function wayFloors(start: Vec3, goal: Vec3): (Vec3 | undefined)[] {
  const from = feet(start);
  cu!.reach(64);
  cu!.stand(from);
  const seenCls = (x: number, y: number, z: number): number => w.live(x, y, z) ?? w.cached(x, y, z) ?? ENTRY_SOLID;
  const stands = (c: Vec3): boolean => seenCls(c.x, c.y - 1, c.z) === ENTRY_SOLID && seenCls(c.x, c.y, c.z) === ENTRY_AIR && seenCls(c.x, c.y + 1, c.z) === ENTRY_AIR;
  const c = entryTouchdowns(seenCls, goal).find(stands);
  const f = c ? floodTo(rememberedGrid(seenGrid(w), from), from, c, { radius: HOP_RADIUS, max: HOP_FLOOD_MAX, top: options(from, goal.y).top }) : undefined;
  const out = (f?.way?.way ?? []).map((cell) => standNear(w, cell)?.cell);
  cu!.reach(Number(arg('live', '9')));
  return out;
}

interface Tally {
  asked: number;
  decisions: number;
  stale: number;
  staleBy: number[];
  flown: number;
  stood: number;
  roof: number;
  other: number;
  refused: number;
  again: number;
  hurt: number;
  ticks: number[];
  endedFrom: number[];
  ms: number[];
  lines: string[];
}
const tally = (): Tally => ({ asked: 0, decisions: 0, stale: 0, staleBy: [], flown: 0, stood: 0, roof: 0, other: 0, refused: 0, again: 0, hurt: 0, ticks: [], endedFrom: [], ms: [], lines: [] });
const row = (name: string, t: Tally): string =>
  `   ${name}: ${t.asked} places asked from; ${t.decisions} decisions (${span(t.ms)} ms each on this host, median ${Math.round(median(t.ms))}); ${t.stale} answers came for a place the body had left${t.staleBy.length ? ` (${span(t.staleBy, (n) => n.toFixed(1))} blocks behind it)` : ''}; ${t.refused} places with no hop proven; ${t.flown} hops flown: ${t.stood} standing by their touchdown, ${t.roof} ended on a roof short of it, ${t.other} ended otherwise, ${t.hurt} landed hurt by a counted fall${t.again ? `; ${t.again} asked again where a lost line came down` : ''}; flights of ${span(t.ticks)} ticks (median ${Math.round(median(t.ticks))}); the ones not standing ended ${span(t.endedFrom)} blocks from their touchdown`;

if (has('walk')) {
  const [a = 'cave_end', c = 'cave_start'] = arg('hop', 'cave_end,cave_start').split(',');
  const start = cu.cellOf(a);
  const goal = cu.cellOf(c);
  const floors = wayFloors(start, goal);
  if (!floors.length) {
    console.log(`${a} -> ${c}: no way under the roof`);
    process.exit(0);
  }
  const n = Number(arg('walk', '30'));
  const speed = Number(arg('speed', '0.18'));
  const host = Number(arg('host', '1'));
  const tolerance = Number(arg('tolerance', '1'));
  /** The floor under the way's cell `i`, or under the next cell that has one. */
  const floorAt = (i: number): { i: number; cell: Vec3 } | undefined => {
    for (let k = Math.max(0, i); k < floors.length; k++) if (floors[k]) return { i: k, cell: floors[k]! };
    return undefined;
  };
  // (the places: evenly along the way, the last a hop's least length short of the goal)
  const least = 70;
  const places: { i: number; cell: Vec3 }[] = [];
  for (let k = 0; k < n; k++) {
    const p = floorAt(Math.floor(((floors.length - least) * k) / n));
    if (p && p.i < floors.length - least && !places.some((q) => q.i === p.i)) places.push(p);
  }
  const total = floors.length;
  const along = (i: number): number => i;
  const lag = proofLate();
  const before = tally();
  const after = tally();
  for (const place of places) {
    const i = place.i;
    const from = feet(place.cell);
    // ---- before: asked from the walking body, stopped where the body is by the answer, asked again there, flown
    asBefore(true);
    cu.stand(from);
    before.asked++;
    let t0 = performance.now();
    const first = await pickHop(w, liveSim, from, goal, c, options(from, goal.y));
    let ms = performance.now() - t0;
    before.decisions++;
    before.ms.push(ms);
    let what = `no hop from the walking body (${first.tried[first.tried.length - 1]?.slice(0, 60) ?? ''})`;
    if (first.hop) {
      const moved = (ms * host * speed) / 50;
      if (moved > tolerance) {
        before.stale++;
        before.staleBy.push(moved);
      }
      const next = floorAt(i + Math.round(moved)) ?? place;
      const j = next.i;
      const from2 = feet(next.cell);
      cu.stand(from2);
      t0 = performance.now();
      const second = await pickHop(w, liveSim, from2, goal, c, options(from2, goal.y));
      ms = performance.now() - t0;
      before.decisions++;
      before.ms.push(ms);
      if (!second.hop) {
        before.refused++;
        what = `the answer ${moved.toFixed(1)} blocks stale; no hop from where the walk stopped`;
      } else {
        const f = await fly(second.hop, from2);
        before.flown++;
        if (f.hurt) before.hurt++;
        before.ticks.push(f.sim.ticks);
        if (f.fine) before.stood++;
        else {
          if (f.end === 'ended roof') before.roof++;
          else before.other++;
          before.endedFrom.push(f.from);
        }
        what = `the answer ${moved.toFixed(1)} blocks stale; asked again ${(along(j) - along(i)).toFixed(0)} cells of the way on: ${second.hop.piece ? 'a piece' : 'the whole way'} of ${second.hop.length} blocks: ${said(f, second.hop)}`;
      }
    } else before.refused++;
    before.lines.push(`      ${along(i)} cells along the way: ${what}`);
    // ---- after: the walk asks whether a hop may be there, stops, decides once standing (the late ends proven), flies
    asBefore(false);
    cu.stand(from);
    after.asked++;
    const sc = scoutHop(w, from, goal, { burn, top: options(from, goal.y).top });
    let then = `no hop may be there (${sc.why.slice(0, 60)}): the walk does not stop`;
    if (sc.may) {
      let at = from;
      then = '';
      for (let k = 0; k <= 2; k++) {
        cu.stand(at);
        t0 = performance.now();
        const pick = await pickHop(w, liveSim, at, goal, c, options(at, goal.y, lag));
        ms = performance.now() - t0;
        after.decisions++;
        after.ms.push(ms);
        if (!pick.hop) {
          if (k === 0) after.refused++;
          then += `${k ? '; asked again there: ' : ''}no hop proven standing (${(pick.tried.find((t) => /seen \d+ ticks late/.test(t)) ? 'lost with a burn\'s end seen late' : (pick.tried[pick.tried.length - 1] ?? '')).slice(0, 70)})`;
          break;
        }
        const f = await fly(pick.hop, at);
        after.flown++;
        if (f.hurt) after.hurt++;
        after.ticks.push(f.sim.ticks);
        then += `${k ? '; asked again there: ' : ''}${pick.hop.piece ? 'a piece' : 'the whole way'} of ${pick.hop.length} blocks: ${said(f, pick.hop)}`;
        if (f.fine) {
          after.stood++;
          break;
        }
        if (f.end === 'ended roof') after.roof++;
        else after.other++;
        after.endedFrom.push(f.from);
        // a lost line that came down under the roof with no hard hit, 16 blocks or more from its start: asked again there
        const e = f.sim.end?.landedAt;
        if (f.end !== 'ended roof' || !e || f.sim.hard || Math.hypot(e.x - at.x, e.y - at.y, e.z - at.z) < 16 || k === 2) break;
        after.again++;
        at = { ...e };
      }
    } else after.refused++;
    after.lines.push(`      ${along(i)} cells along the way: ${then}`);
  }
  console.log(`${a} -> ${c}: the way under the roof is ${total} cells; the hop asked from ${places.length} floors under it, evenly along it; the live model the chunks within ${arg('live', '9')} of the body; rockets that burn ${burnSaid(burn)} ticks, a burn's end seen ${lateSaid} (the proof after takes ${lag}); the walk at ${speed} blocks a tick, this host's decisions counted ${host} times`);
  console.log(row('BEFORE', before));
  console.log(row('AFTER ', after));
  if (has('each')) {
    console.log('   before, place by place:');
    console.log(before.lines.join('\n'));
    console.log('   after, place by place:');
    console.log(after.lines.join('\n'));
  }
} else {
  const [a = 'cave_end', c = 'cave_start'] = arg('hop', 'cave_end,cave_start').split(',');
  const from = feet(cu.cellOf(a));
  const goal = cu.cellOf(c);
  cu.stand(from);
  const t0 = performance.now();
  const pick = await pickHop(w, liveSim, from, goal, c, options(from, goal.y, has('proof') ? Number(arg('proof', '2')) : undefined));
  console.log(`${a} -> ${c}, the live model the chunks within ${arg('live', '9')} of the body, rockets that burn ${burnSaid(burn)} ticks: ${pick.hop ? `${pick.hop.piece ? 'a PIECE' : 'the WHOLE way'}: ${pick.hop.drawn.guide.path}, ${pick.hop.length} blocks of line` : 'NO hop'} (${pick.cells} cells, ${pick.sims} simulated, ${(performance.now() - t0).toFixed(0)} ms)`);
  if (has('tried')) console.log(`   ${pick.tried.map((t) => t.replace(/at burns of [^;]*;/, '[burns];')).join('\n   ')}`);
  const h = pick.hop;
  if (h) {
    const n = Number(arg('fuzz', '100'));
    const offs = arg('off', '0').split(',').map(Number);
    for (const o of offs) {
      for (const [dx, dz] of o === 0 ? [[0, 0]] : [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const start = { x: from.x + dx! * o, y: from.y, z: from.z + dz! * o };
        let fine = 0;
        let hurt = 0;
        const ends = new Map<string, number>();
        const bad: string[] = [];
        for (let k = 0; k < n; k++) {
          const f = await fly(h, start);
          if (f.hurt) hurt++;
          if (f.fine && !f.hurt) fine++;
          else {
            ends.set(f.end, (ends.get(f.end) ?? 0) + 1);
            bad.push(`      burns ${f.burns.join(',')}, seen ${f.lates.join(',')} late: ${said(f, h)}${has('notes') ? `\n         ${f.notes.filter((m) => /lost|rocket \d+ asked|ended/.test(m)).join('\n         ')}` : ''}`);
          }
        }
        console.log(`   from ${o === 0 ? 'where it was proven' : `${o} beside it (${dx} ${dz})`}, a burn's end seen ${lateSaid}: ${fine} of ${n} flights with a burn of its own for every rocket standing within 2 of its cell with no hard hit and no fall counted${hurt ? ` (${hurt} landed hurt by a counted fall)` : ''}${ends.size ? `; NOT: ${[...ends].map(([e, k]) => `${k} ${e}`).join(', ')}` : ''}`);
        if (bad.length) console.log(bad.slice(0, Number(arg('show', '12'))).join('\n'));
      }
    }
  }
}
