// Track F9c (docs/flight.md "Learned entries (Track F9c)"): the way INTO the owner's cave along a recorded flight, offline,
// from the command line, on Track F5a's private fixture. Prints counts, times and positions relative to the goal only,
// never a coordinate of the fixture.
//
//   node scripts/cave-learned-entry-probe.ts --paths <dir> [--to cave_start] [--mode lines]
//
// `--paths` (or BEDROCKBOT_PATHS_DIR) is a folder of `!learn` recordings, read only (the owner's own: private, never in
// the repository).
//
//   --mode lines    what the recorded ways in look like: where they stand again, the line kept, its last open sky, the
//                   speed and the slope along it, the room it keeps
import { FlightBrain, type FlightEnd, type FlightPhase } from '../src/skills/fly/brain.ts';
import { caveWorld, loadCaveFixture, REPLICA_FLAT_FEET, replicaCoarse } from '../src/skills/fly/corridor/cave.ts';
import { simulateFlight, type SimDeps } from '../src/skills/fly/glide.ts';
import { caseSpeed, chooseTouchdown, ENTRY_AIM_OUT, ENTRY_AIR, ENTRY_BOX, ENTRY_SOLID, ENTRY_WATER, entryAim, entryCases, entryLine, entryState, entryTouchdowns, entryVerdict, flyEntry, guideSpeed, proveEntry, type EntryLine, type EntryWorld } from '../src/skills/fly/learn/entry.ts';
import { fixtureExportedAt, fixtureFreshness } from '../src/skills/fly/learn/fresh.ts';
import { guideLength, guidesOf } from '../src/skills/fly/learn/guide.ts';
import { matchEntries, MATCH_NEAR, type OpenSky } from '../src/skills/fly/learn/match.ts';
import { PathStore } from '../src/skills/fly/learn/store.ts';
import { APPROACH_HEIGHT, cruiseHeight, type LandingTarget } from '../src/skills/fly/plan.ts';
import { boxClear } from '../src/skills/fly/route/grid.ts';
import type { TerrainQuery } from '../src/skills/fly/terrain.ts';
import { GLIDE, stepBody } from '../src/skills/input/physics.ts';
import { IDLE_COMMAND, initialBody, type BodyState } from '../src/skills/input/types.ts';
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
const b = e.box;
const inBox = (x: number, z: number): boolean => x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z;
// the flight's world: the fixture's cells in the box; beside the box the extract's column tops (solid up to the top, air
// over it; a column the cache never saw is air), as scripts/cave-exit-probe.ts has it
const outsideSolid = (x: number, y: number, z: number): boolean => {
  const t = e.top(x, z);
  return t !== undefined && t !== TOP_UNKNOWN && t !== TOP_NONE && y <= t;
};
// (--replica: the world as the replica on bds-fly2 has it instead (corridor/cave.ts replicaCoarse, as scripts/cave-exit-probe.ts):
// the same box inside a stone shell from the flat world up to the box's top, the terraces round it, the home pad)
const homeAt = fix.waypoints.get('home');
const replica = has('replica') ? replicaCoarse(world, homeAt ? { home: { x: Math.floor(homeAt.x), y: Math.floor(homeAt.y), z: Math.floor(homeAt.z) } } : {}) : undefined;
const replicaCls = (x: number, y: number, z: number): number | undefined => replica!.chunk(x >> 4, z >> 4, e.dim)?.cls(x & 15, y, z & 15);
const solidAt = replica
  ? (x: number, y: number, z: number): boolean => {
      const c = replicaCls(x, y, z);
      return c !== undefined && c !== CLS_AIR && c !== CLS_WATER;
    }
  : (x: number, y: number, z: number): boolean => (inBox(x, z) ? world.query.solidAt(x, y, z) === true : outsideSolid(x, y, z));
// the follower's grid: water is an obstacle (the fixture's grid), the columns beside the box as above
const grid = { solid: replica ? (x: number, y: number, z: number): boolean => replicaCls(x, y, z) !== CLS_AIR : (x: number, y: number, z: number): boolean => (inBox(x, z) ? world.grid.solid(x, y, z) : outsideSolid(x, y, z)) };
const floorY = replica ? REPLICA_FLAT_FEET - 2 : b.min.y;
const ew: EntryWorld = { world: { solidAt, liquidAt: (x: number, y: number, z: number) => (inBox(x, z) ? world.query.liquidAt!(x, y, z) : null) }, grid };

const cellOf = (name: string): Vec3 => {
  const p = fix.waypoints.get(name);
  if (!p) throw new Error(`no waypoint ${name}`);
  return world.feetCell(p) ?? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
};
const goal = cellOf(arg('to', 'cave_start'));
const to: Vec3 = { x: goal.x + 0.5, y: goal.y, z: goal.z + 0.5 };
const rel = (p: Vec3): string => `[${(p.x - to.x).toFixed(1)} ${(p.y - to.y).toFixed(1)} ${(p.z - to.z).toFixed(1)}]`;
// a note of the brain's has the fixture's coordinates: made relative to the goal
// (also a column `at x z` and a height `y n`, as the terrain lines have them)
const relNote = (s: string): string =>
  s
    .replace(/(-?\d+\.\d+) (-?\d+\.\d+) (-?\d+\.\d+)/g, (_m, x: string, y: string, z: string) => rel({ x: Number(x), y: Number(y), z: Number(z) }))
    .replace(/(-?\d+) (-?\d+) (-?\d+)(?= \(|:|,|;|$)/g, (_m, x: string, y: string, z: string) => rel({ x: Number(x) + 0.5, y: Number(y), z: Number(z) + 0.5 }))
    .replace(/\bat (-?\d+) (-?\d+)(?= |:|,|;|$)/g, (_m, x: string, z: string) => `at [${Math.round(Number(x) + 0.5 - to.x)} ${Math.round(Number(z) + 0.5 - to.z)}]`)
    .replace(/\by (-?\d+(?:\.\d+)?)/g, (_m, y: string) => `y [${(Number(y) - to.y).toFixed(0)}]`);
const top = b.max.y;
const sky: OpenSky = (x, y, z) => {
  for (let k = y + 1; k <= top; k++) if (solidAt(x, k, z)) return false;
  return true;
};

const pathsDir = has('paths') ? arg('paths', '') : process.env.BEDROCKBOT_PATHS_DIR;
if (!pathsDir) {
  console.log('no recordings (--paths <dir> or BEDROCKBOT_PATHS_DIR)');
  process.exit(0);
}
const paths = new PathStore(pathsDir).all();
// (round 2: a fixture older than the recordings is another cave than the one they were made in: said first)
console.log(fixtureFreshness(fixtureExportedAt(fix.dir), paths.map((p) => p.recorded)).line);
const before = Number(arg('before', '200'));
const found = matchEntries(paths, to, sky, { before });
console.log(`${paths.length} recordings, ${found.flights} flights, ${found.near} stand again within ${MATCH_NEAR} of ${arg('to', 'cave_start')}, ${found.matches.length} of those come from under open sky to a place under a roof`);
console.log(`the box: goal ${rel({ x: b.min.x, y: b.min.y, z: b.min.z })} .. ${rel({ x: b.max.x, y: b.max.y, z: b.max.z })}`);

const mode = arg('mode', 'lines');
if (mode === 'lines') {
  for (const p of paths) {
    for (const g of guidesOf(p)) {
      const end = g.points[g.points.length - 1]!;
      console.log(`  (${p.name} flight ${g.flight}: ${guideLength(g).toFixed(0)} blocks, grounded ${g.grounded}, landed ${g.landed}, begins ${rel(g.points[0]!)}, ends ${rel(end)}, ${g.rockets.length} rockets at ${g.rockets.map((r) => `${r.at.toFixed(0)} blocks / tick ${r.tick}`).join(', ') || '-'})`);
    }
  }
  for (const m of found.matches) {
    const g = m.guide;
    const n = g.points.length;
    const len = guideLength(g);
    console.log(`${g.path}: stands again ${m.off.toFixed(1)} from the goal at ${rel(g.points[n - 1]!)}; the line kept ${len.toFixed(0)} blocks (${Math.round(g.ticks[n - 1]!)} ticks), its last open sky ${m.open.toFixed(0)} blocks along it: ${(len - m.open).toFixed(0)} blocks under the roof in ${Math.round(g.ticks[n - 1]! - (g.ticks[Math.round(m.open)] ?? 0))} ticks; begins ${rel(g.points[0]!)}, in the box ${inBox(Math.floor(g.points[0]!.x), Math.floor(g.points[0]!.z))}; rockets on it ${g.rockets.map((r) => `${r.at.toFixed(0)}`).join(', ') || '-'}`);
    // every 6 blocks: the place, the speed (blocks a tick over the 6 blocks round it), the heading, the slope, the room
    const rows: string[] = [];
    for (let i = 0; i < n; i += Number(arg('every', '6'))) {
      const a = Math.max(0, i - 3);
      const c = Math.min(n - 1, i + 3);
      const pa = g.points[a]!;
      const pc = g.points[c]!;
      const d = Math.hypot(pc.x - pa.x, pc.y - pa.y, pc.z - pa.z);
      const dt = Math.max(0.01, g.ticks[c]! - g.ticks[a]!);
      const yaw = (Math.atan2(-(pc.x - pa.x), pc.z - pa.z) * 180) / Math.PI;
      const slope = (Math.atan2(pc.y - pa.y, Math.hypot(pc.x - pa.x, pc.z - pa.z)) * 180) / Math.PI;
      const room = boxClear(grid, g.points[i]!, 0).clearance;
      const p = g.points[i]!;
      rows.push(`    ${String(i).padStart(3)} ${rel(p).padEnd(22)} tick ${g.ticks[i]!.toFixed(0).padStart(4)} speed ${(d / dt).toFixed(2)} yaw ${yaw.toFixed(0).padStart(4)} slope ${slope.toFixed(0).padStart(4)} room ${room.toFixed(2)} ${sky(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) ? 'sky' : 'roof'}`);
    }
    console.log(rows.join('\n'));
  }
}

/**
 * The entry lines of the matching takes (`--take name` for one). `--touch choose` (the default, round 2): the touchdown the
 * bot would choose (the goal's own cell, else the nearest standable cell within 2 blocks of it whose proof clears:
 * chooseTouchdown), and the goal's own cell for a take refused everywhere; `--touch goal`: the goal's own cell always;
 * `--touch recorded`: where the recording stood.
 */
const lines: { name: string; line: EntryLine }[] = [];
const classOf = (x: number, y: number, z: number): number => (solidAt(x, y, z) ? ENTRY_SOLID : grid.solid(x, y, z) ? ENTRY_WATER : ENTRY_AIR);
for (const m of found.matches) {
  if (has('take') && m.guide.path !== arg('take', '')) continue;
  const touch = arg('touch', 'choose');
  if (touch === 'choose') {
    const t0 = performance.now();
    const pick = await chooseTouchdown(ew, m, goal, entryTouchdowns(classOf, goal));
    console.log(`${m.guide.path}: ${pick.said}${pick.proof ? '' : ': refused'} (${pick.sims} simulated, ${(performance.now() - t0).toFixed(0)} ms)`);
    if (pick.line) {
      lines.push({ name: m.guide.path, line: pick.line });
      continue;
    }
  }
  const l = entryLine(m, { grid, ...(touch === 'recorded' ? {} : { goal: to }) });
  if (typeof l === 'string') console.log(`${m.guide.path}: no entry line (${l})`);
  else lines.push({ name: m.guide.path, line: l });
}
const short = (f: ReturnType<typeof flyEntry>): string => {
  const why = entryVerdict(f);
  return `${why === undefined ? 'ok ' : 'NO '} ${f.landed ? `stands ${f.off.toFixed(1)} off (${f.dy >= 0 ? '+' : ''}${f.dy.toFixed(1)}; ${f.offRecorded.toFixed(1)} from where the recording stood) after ${f.ticks} ticks, ${f.roofTicks ?? '?'} from the last open sky (${((f.roofTicks ?? 0) / 20).toFixed(1)} s), touch vy ${f.touch.vy.toFixed(2)} h ${f.touch.h.toFixed(2)}, ${f.keepTicks} ticks of touchdown` : `not standing after ${f.ticks} ticks`}, at most ${f.maxError.toFixed(1)} off the line, room ${f.room.toFixed(2)}, ${f.taps} governor ticks, ${f.bumps} touches${f.began ? `; the touchdown began for ${f.began}` : ''}${why !== undefined ? `: ${why}` : ''}`;
};

if (mode === 'catch') {
  // what the follower catches: one axis at a time from the window's middle (and its ends), then the proof's own cases
  for (const { name, line } of lines) {
    const g = line.guide;
    const mid = (line.from + line.to) / 2;
    console.log(`${name}: the line ${guideLength(g).toFixed(0)} blocks, its last open sky at ${line.open.toFixed(0)}, the window ${line.from.toFixed(0)} to ${line.to.toFixed(0)} (the recording at ${guideSpeed(g, line.from).toFixed(2)}, ${guideSpeed(g, mid).toFixed(2)}, ${guideSpeed(g, line.to).toFixed(2)} a tick there; its middle ${rel(entryState(line, mid).pos)}), the touchdown ${line.off.toFixed(1)} from the goal`);
    for (const [where, at] of [['mid', mid], ['early', line.from], ['late', line.to]] as const) console.log(`   ${where.padEnd(6)} on the line: ${short(flyEntry(ew, line, entryState(line, at)))}`);
    const sweep = (label: string, values: number[], make: (v: number) => Parameters<typeof entryState>[2]): void => {
      for (const [where, at] of [['mid', mid], ['early', line.from], ['late', line.to]] as const) {
        const marks = values.map((v) => {
          const f = flyEntry(ew, line, entryState(line, at, make(v)));
          const why = entryVerdict(f);
          return `${v}:${why === undefined ? 'ok' : f.hits ? 'HIT' : f.wet ? 'WET' : f.lost !== undefined ? 'lost' : !f.landed ? 'air' : f.off > 2 || Math.abs(f.dy) > 2 ? `off${f.off.toFixed(0)}` : 'hard'}`;
        });
        console.log(`   ${label.padEnd(8)} ${where.padEnd(6)} ${marks.join('  ')}`);
      }
    };
    if (!has('no-sweeps')) {
      sweep('side', [-8, -6, -4, -3, -2, -1, 1, 2, 3, 4, 6, 8], (v) => ({ side: v }));
      sweep('up', [-5, -4, -3, -2, -1, 1, 2, 3, 4, 6, 8, 10, 12, 16], (v) => ({ up: v }));
      sweep('speed x', [0.5, 0.6, 0.7, 0.8, 0.9, 1.1, 1.2, 1.3, 1.4, 1.5, 1.7], (v) => ({ factor: v }));
      sweep('speed', [0.7, 0.9, 1.1, 1.3, 1.5, 1.7, 1.9, 2.1], (v) => ({ speed: v }));
      sweep('heading', [-60, -45, -35, -25, -15, 15, 25, 35, 45, 60], (v) => ({ heading: v }));
    }
    const t0 = performance.now();
    const proof = await proveEntry(ew, line);
    console.log(`   the proof (${entryCases(line).length} cases, the box ${JSON.stringify(ENTRY_BOX)}): ${proof.ok ? '' : 'REFUSED: '}${proof.line} (${proof.sims} simulated, ${(performance.now() - t0).toFixed(0)} ms)`);
    if (has('cases')) {
      for (const c of entryCases(line)) {
        console.log(`      ${c.name.padEnd(28)} ${short(flyEntry(ew, line, entryState(line, c.at, { side: c.side, up: c.up, speed: caseSpeed(line, c), heading: c.heading })))}`);
      }
    }
  }
}

if (mode === 'trace') {
  // one entry, every tick, relative to the goal: --take <name> [--at mid|early|late] [--side n] [--up n] [--factor n] [--heading n]
  for (const { name, line } of lines) {
    const at = arg('at', 'mid') === 'early' ? line.from : arg('at', 'mid') === 'late' ? line.to : (line.from + line.to) / 2;
    const s0 = entryState(line, at, { side: Number(arg('side', '0')), up: Number(arg('up', '0')), factor: Number(arg('factor', '1')), heading: Number(arg('heading', '0')) });
    const f = flyEntry(ew, line, s0, {
      trace: (t, body, out) => {
        const h = Math.hypot(body.vel.x, body.vel.z);
        console.log(`  t${String(t).padStart(3)} ${out.status.padEnd(9)} ${rel(body.pos).padEnd(22)} speed ${Math.hypot(h, body.vel.y).toFixed(2)} (recorded ${guideSpeed(line.guide, out.at).toFixed(2)}) climb ${((Math.atan2(body.vel.y, h) * 180) / Math.PI).toFixed(0).padStart(4)} look ${out.control.yaw.toFixed(0)}/${out.control.pitch.toFixed(0)} at ${out.at.toFixed(1)} off ${out.error.toFixed(2)}${body.collidedHorizontally || body.collidedVertically ? ' CONTACT' : ''}`);
      },
    });
    console.log(`${name}: ${short(f)}`);
  }
}

if (mode === 'approach') {
  // the whole flight: standing in the open some way off (`--dist`, on each of `--bearings` from the goal), the takeoff, the
  // cruise onto the lead-in, the hand-over, the line, the touchdown. `--burns a,b`: every rocket burning that long.
  const skyTop = (x: number, z: number, fromY?: number): number | undefined => {
    for (let y = Math.min(b.max.y, Math.floor(fromY ?? b.max.y)); y >= floorY; y--) if (solidAt(x, y, z)) return y;
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
  const deps: SimDeps = { world: ew.world, groundAt, skyTop: (x, z) => skyTop(x, z), terrain };
  const noPlan = (): never => {
    throw new Error('no route planner in this probe');
  };
  // (`--starts dx,dz;dx,dz`: where the body stands at first, blocks from the goal; a start with no known ground is skipped)
  // (`home`: the fixture's home waypoint, the trip's real start: only with --replica, whose world has ground there)
  const starts = arg('starts', '-250,0;-250,-50;-200,100;-120,150;-20,150;-150,-55;-100,60;15,60')
    .split(';')
    .map((s) => (s === 'home' && homeAt ? [Math.floor(homeAt.x) + 0.5 - to.x, Math.floor(homeAt.z) + 0.5 - to.z] : s.split(',').map(Number)) as [number, number]);
  const burnList = arg('burns', '15').split(',').map(Number);
  for (const { name, line } of lines) {
    const proof = await proveEntry(ew, line);
    console.log(`${name}: the proof: ${proof.ok ? '' : 'REFUSED: '}${proof.line}`);
    if (!proof.ok && !has('unproven')) continue;
    const aim = entryAim(line, { top: (x, z) => skyTop(x, z) });
    const hold: LandingTarget = { x: to.x, z: to.z, top: goal.y, half: 2, hold: true };
    const target: LandingTarget = { x: aim.x, z: aim.z, top: aim.y - APPROACH_HEIGHT, half: 2, bearing: aim.bearing, entry: { line, goal: { x: to.x, z: to.z, top: goal.y, half: 2 }, fallback: hold } };
    console.log(`   the cruise aims ${rel({ x: aim.x, y: aim.y, z: aim.z })} (the window's end; the hand-over's height ${ENTRY_AIM_OUT} before it), in along heading ${Math.round(aim.bearing + 180)}; the lead-in ${line.lead} blocks, the window ${line.from} to ${line.to}, the last open sky at ${line.open.toFixed(0)}`);
    for (const [dx, dz] of starts) {
      for (const burn of burnList) {
        const sx = Math.floor(to.x + dx);
        const sz = Math.floor(to.z + dz);
        const t = skyTop(sx, sz);
        const bearing = Math.hypot(dx, dz) > 400 ? 'home' : `[${dx} ${dz}]`;
        const dist = Math.round(Math.hypot(dx, dz));
        if (t === undefined) {
          console.log(`   from ${bearing}: no ground known there`);
          continue;
        }
        const from: Vec3 = { x: sx + 0.5, y: t + 1, z: sz + 0.5 };
        // (`--cruise-over n`: the cruise that far over the goal, as a flight that had to come in high has it)
        const cruiseY = has('cruise-over') ? goal.y + Number(arg('cruise-over', '0')) : cruiseHeight(from, hold, (x, z) => skyTop(x, z), {}).y;
        const notes: string[] = [];
        let lastSky = 0;
        const sim = await simulateFlight(
          deps,
          from,
          target,
          { cruiseY, margin: 15, goArounds: 4, route: { grid, plan: noPlan }, note: (m) => notes.push(m) },
          {
            rockets: 64,
            maxTicks: Number(arg('ticks', '3000')),
            burn,
            endLag: GLIDE.boostEndLag,
            until: (br, body) => {
              if (sky(Math.floor(body.pos.x), Math.floor(body.pos.y), Math.floor(body.pos.z))) lastSky = br.stats.ticks;
              // (where a contact was: the count alone does not say whether it was the takeoff, the way in or the touchdown's creep)
              if (body.gliding && (body.collidedHorizontally || (body.collidedVertically && !body.onGround))) notes.push(`#contact at tick ${br.stats.ticks} in ${br.phase}${br.descending ? ` (${br.descending})` : ''} ${rel(body.pos)}, ${Math.hypot(body.vel.x, body.vel.y, body.vel.z).toFixed(2)} a tick after it`);
              if (has('trace') && br.phase !== 'climb' && br.phase !== 'takeoff' && Math.hypot(body.pos.x - to.x, body.pos.z - to.z) < Number(arg('trace-within', '140'))) {
                const h = Math.hypot(body.vel.x, body.vel.z);
                notes.push(`#t${br.stats.ticks} ${br.phase}${br.descending ? ` (${br.descending})` : ''} ${rel(body.pos)} speed ${Math.hypot(h, body.vel.y).toFixed(2)} climb ${((Math.atan2(body.vel.y, h) * 180) / Math.PI).toFixed(0)} heading ${h > 0.05 ? ((Math.atan2(-body.vel.x, body.vel.z) * 180) / Math.PI).toFixed(0) : '-'} boost ${body.boostTicks ?? 0}`);
              }
              return false;
            },
          },
        );
        const en = sim.stats.entry;
        const e2 = sim.end;
        console.log(
          `   from ${bearing.padEnd(11)} (${dist} out, ${(from.y - goal.y).toFixed(0)} over the goal, cruise ${(cruiseY - goal.y).toFixed(0)} over it), burn ${burn}: ${e2 ? `${e2.ok ? 'landed on the goal' : `ended ${e2.reason}`} ${Math.hypot(e2.landedAt.x - to.x, e2.landedAt.z - to.z).toFixed(1)} from it (${(e2.landedAt.y - goal.y).toFixed(1)}) after ${sim.ticks} ticks (${(sim.ticks / 20).toFixed(1)} s)` : `still ${sim.phase} after ${sim.ticks} ticks`}; ${sim.hits} contacts, ${sim.wet ? 'WET, ' : ''}${sim.stats.rockets} rockets, ${sim.stats.goArounds} go-arounds; the entry ${en ? `${en.end ?? 'not ended'}${en.why ? ` (${en.why.slice(0, 160)})` : ''}, ${en.joins} joins, ${en.misses} misses, committed at tick ${en.committedAt ?? '-'}, ${en.ticks ?? '-'} ticks from the commit, ${en.roofTicks ?? '-'} from the line's last open sky, at most ${en.maxError?.toFixed(2) ?? '-'} off the line, slowed ${en.taps ?? '-'} ticks` : 'never begun'}; the last open sky at tick ${lastSky}${e2 ? `: ${sim.ticks - lastSky} ticks (${((sim.ticks - lastSky) / 20).toFixed(1)} s) under the roof to standing` : ''}`,
        );
        if (has('notes') || has('trace')) for (const n of notes) console.log(`      ${n.startsWith('#') ? n.slice(1) : relNote(n).slice(0, 300)}`);
      }
    }
  }
}

if (mode === 'arrive') {
  // Track F9d: the end of a long flight as the live server has it: the body already in the cruise towards the goal (a held
  // target: its ground not loaded yet), high and fast, `--out` blocks from where the entry's line is aimed at, on the bearing
  // of `--from` (a waypoint of the fixture; default home), and there RETARGETED to the entry, as tasks/process/fly.ts
  // watchEntry does once the proof is in. `--overs` (the body's height over the goal there), `--sides` (blocks beside that
  // bearing), `--speeds` (blocks a tick): every combination is one flight. One line a flight: the go-arounds, the windows
  // missed, the seconds from the retarget to standing.
  const skyTop = (x: number, z: number, fromY?: number): number | undefined => {
    for (let y = Math.min(b.max.y, Math.floor(fromY ?? b.max.y)); y >= floorY; y--) if (solidAt(x, y, z)) return y;
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
  const noPlan = (): never => {
    throw new Error('no route planner in this probe');
  };
  const nums = (name: string, def: string): number[] => arg(name, def).split(',').map(Number);
  const out = Number(arg('out', '320'));
  const fromAt = fix.waypoints.get(arg('from', 'home'));
  if (!fromAt) throw new Error(`no waypoint ${arg('from', 'home')}`);
  for (const { name, line } of lines) {
    const proof = await proveEntry(ew, line);
    console.log(`${name}: the proof: ${proof.ok ? '' : 'REFUSED: '}${proof.line}`);
    if (!proof.ok && !has('unproven')) continue;
    const aim = entryAim(line, { top: (x, z) => skyTop(x, z) });
    const hold: LandingTarget = { x: to.x, z: to.z, top: goal.y, half: 2, hold: true };
    const target: LandingTarget = { x: aim.x, z: aim.z, top: aim.y - APPROACH_HEIGHT, half: 2, bearing: aim.bearing, entry: { line, goal: { x: to.x, z: to.z, top: goal.y, half: 2 }, fallback: hold } };
    const p0 = line.guide.points[0]!;
    // the unit vector from the aim towards where the flight comes from, and the one to its right
    const fl = Math.hypot(fromAt.x - aim.x, fromAt.z - aim.z) || 1;
    const back = { x: (fromAt.x - aim.x) / fl, z: (fromAt.z - aim.z) / fl };
    const right = { x: -back.z, z: back.x };
    console.log(`   the line's start ${rel(p0)}, the cruise's aim ${rel({ x: aim.x, y: aim.y, z: aim.z })}; the flight comes ${Math.round(Math.abs(((((Math.atan2(-back.x, back.z) * 180) / Math.PI - aim.bearing + 540) % 360) - 180)))} degrees off the line's bearing; retargeted ${out} blocks from the aim`);
    let flights = 0;
    let clean = 0;
    const secs: number[] = [];
    for (const over of nums('overs', '99')) {
      for (const side of nums('sides', '0')) {
        for (const speed of nums('speeds', '1.5')) {
          const start: Vec3 = { x: aim.x + back.x * out + right.x * side, y: goal.y + over, z: aim.z + back.z * out + right.z * side };
          const notes: string[] = [];
          const brain = new FlightBrain(hold, { cruiseY: goal.y + Number(arg('cruise-over', '79')), margin: 15, goArounds: 4, route: { grid, plan: noPlan }, note: (m) => notes.push(m), groundAt, skyTop: (x, z) => skyTop(x, z), terrain, obstacle: (x, y, z) => solidAt(x, y, z) });
          brain.phase = 'cruise';
          const yaw = (Math.atan2(back.x, -back.z) * 180) / Math.PI;
          let body: BodyState = { ...initialBody(start, false), vel: { x: -back.x * speed, y: -0.1, z: -back.z * speed }, gliding: true };
          let cmd = { ...IDLE_COMMAND, yaw, pitch: 0 };
          let rockets = 64;
          let lastFire = -100;
          let lag = 0;
          let hits = 0;
          let end: FlightEnd | undefined;
          let t = 1;
          let unknown = 0;
          for (; t <= Number(arg('ticks', '3000')); t++) {
            if (t === 2) brain.retarget(target, { pos: body.pos, vel: body.vel, onGround: body.onGround, gliding: true, boostTicks: body.boostTicks ?? 0 });
            const burning = body.boostTicks ?? 0;
            if (burning > 0) lag = GLIDE.boostEndLag;
            const seen = burning > 0 ? burning : lag > 0 && body.gliding ? 1 : 0;
            if (burning === 0 && lag > 0) lag--;
            const o2 = brain.step({ tick: t, body: { pos: body.pos, vel: body.vel, onGround: body.onGround, gliding: body.gliding ?? false, boostTicks: seen }, yaw: cmd.yaw, pitch: cmd.pitch, rockets, canFire: t - lastFire >= 4, health: 20, elytraLeft: 400 });
            if (o2.end) {
              end = o2.end;
              break;
            }
            const c = o2.control;
            cmd = { ...cmd, yaw: c.yaw, pitch: c.pitch, jump: c.jump, glide: c.glide, forward: c.forward ?? 0, sneak: c.sneak === true, sprint: false };
            const firing = c.fire && rockets > 0;
            if (firing) {
              rockets--;
              lastFire = t;
            }
            const r = stepBody(body, { ...cmd, ...(firing ? { boostStart: Number(arg('burn', '15')) } : {}) }, ew.world);
            if (!r.simulated) break;
            const was = body;
            body = r.state;
            if (was.gliding && body.pos.y > Math.floor(body.pos.y) + 0.05 && (body.collidedHorizontally || (body.collidedVertically && !body.onGround))) hits++;
            if (skyTop(Math.floor(body.pos.x), Math.floor(body.pos.z)) === undefined) unknown++;
            if (has('trace') && Math.hypot(body.pos.x - p0.x, body.pos.z - p0.z) < Number(arg('trace-within', '120')) && (brain.phase as FlightPhase) !== 'entry') {
              const h = Math.hypot(body.vel.x, body.vel.z);
              notes.push(`#t${t} ${brain.phase}${brain.descending ? ` (${brain.descending})` : ''} ${Math.hypot(body.pos.x - p0.x, body.pos.z - p0.z).toFixed(0)} from the line's start, ${(body.pos.y - p0.y).toFixed(1)} over it, speed ${Math.hypot(h, body.vel.y).toFixed(2)} climb ${((Math.atan2(body.vel.y, h) * 180) / Math.PI).toFixed(0)} look ${cmd.pitch.toFixed(0)} boost ${body.boostTicks ?? 0}`);
            }
          }
          const en = brain.stats.entry;
          flights++;
          const ok = end?.ok === true && brain.stats.goArounds === 0 && (en?.misses ?? 0) === 0 && hits === 0;
          if (ok) clean++;
          if (end?.ok) secs.push(t / 20);
          console.log(
            `   ${over} over the goal, ${side} beside, ${speed} a tick: ${end ? `${end.ok ? 'landed on the goal' : `ended ${end.reason}`} ${Math.hypot(end.landedAt.x - to.x, end.landedAt.z - to.z).toFixed(1)} from it after ${t} ticks (${(t / 20).toFixed(1)} s from the retarget)` : `still ${brain.phase} after ${t} ticks`}; ${brain.stats.goArounds} go-arounds, ${en?.misses ?? 0} windows missed, ${en?.joins ?? 0} joins, ${hits} contacts, ${brain.stats.rockets} rockets${unknown ? `, ${unknown} ticks over columns the fixture does not know` : ''}; ${brain.stats.descents.join('; ') || 'no descent geometry'}`,
          );
          if (has('notes') || has('trace')) for (const n of notes) console.log(`      ${n.startsWith('#') ? n.slice(1) : relNote(n).slice(0, 400)}`);
        }
      }
    }
    secs.sort((x, y) => x - y);
    console.log(`   ${name}: ${clean} of ${flights} flights stood on the goal with no go-around, no window missed and no contact; ${secs.length ? `${secs[0]!.toFixed(1)} to ${secs[secs.length - 1]!.toFixed(1)} s from the retarget to standing (median ${secs[Math.floor(secs.length / 2)]!.toFixed(1)})` : 'none stood'}`);
  }
}
