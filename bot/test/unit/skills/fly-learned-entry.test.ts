// Track F9c (docs/flight.md "Learned entries (Track F9c)", decisions/0080-learned-entries.md): a recorded flight as the way
// INTO a place under a roof. Guarded here on synthetic worlds with synthetic recordings (nothing of anybody's world): an
// entry matched at a covered goal and not at an open one, by where it stands again and never by its name; its line with
// the hand-over window and the lead-in; the proof from every state the hand-over allows, ending standing; the flier from
// the hand-over to the touchdown, never faster than the recording; the whole flight out of a cruise (the brain's
// hand-over, the commit, the entry); a body outside what the proof flew that is never committed (a miss, a go-around,
// the fallback: no dive at the mouth); a world that changed since the recording (refused, and a proof made before the
// change does not stand on the live world); nothing different without an entry; and, for the learned exit of Track
// F9b, a first rocket that fires nothing (the proof flies it, the follower finds its place again and fires again).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETTING_DEFS } from '../../../src/config/settings.ts';
import type { Vec3 } from '../../../src/connection/types.ts';
import type { FlightBrain } from '../../../src/skills/fly/brain.ts';
import { ENTRY_HELIX_UNTIL, ENTRY_TRIES } from '../../../src/skills/fly/brain.ts';
import { DUD_SEEN_TICKS, LEARNED_PROOF_BURNS, LEARNED_PROOF_DUDS, LEARNED_PROOF_MIXES, routeTakeoff, routeTakeoffOptions, simulateFlight, type SimDeps } from '../../../src/skills/fly/glide.ts';
import {
  chooseTouchdown,
  ENTRY_AIR,
  ENTRY_BOX,
  ENTRY_GOAL,
  ENTRY_JOIN,
  ENTRY_SOLID,
  ENTRY_TOUCH,
  ENTRY_UNKNOWN,
  EntryFlier,
  entryAim,
  entryCases,
  entryCatch,
  entryJoin,
  entryLine,
  entryState,
  entryTouchdowns,
  entryVerdict,
  entryWorld,
  entryWorldSame,
  flyEntry,
  guideSpeed,
  offsets,
  proveEntry,
  type EntryLine,
} from '../../../src/skills/fly/learn/entry.ts';
import { fixtureExportedAt, fixtureFreshness } from '../../../src/skills/fly/learn/fresh.ts';
import { FOLLOW_DUD_TICKS, FOLLOW_TAP_OVER, GuideFollower } from '../../../src/skills/fly/learn/follow.ts';
import { guideLength, guidePoint, guidesOf } from '../../../src/skills/fly/learn/guide.ts';
import { matchEntries, matchExits, type OpenSky } from '../../../src/skills/fly/learn/match.ts';
import type { LearnedPath, LearnSample } from '../../../src/skills/fly/learn/recorder.ts';
import { APPROACH_HEIGHT, cruiseHeight, type CellQuery, type LandingTarget } from '../../../src/skills/fly/plan.ts';
import { gridOf } from '../../../src/skills/fly/route/grid.ts';
import { planRoute } from '../../../src/skills/fly/route/search.ts';
import { ROCKET_ADD_WITHIN } from '../../../src/skills/fly/rocket.ts';
import { planTakeoffRoute, type TakeoffProof, type TakeoffRoute } from '../../../src/skills/fly/route/takeoff.ts';
import { flatWorld, withBoxes, type BlockBox, type BlockQuery } from '../../../src/skills/input/index.ts';

const FEET = -60;
const SLOW = 120_000;

function rig(boxes: BlockBox[]) {
  const world: BlockQuery = withBoxes(flatWorld(), boxes);
  const cell: CellQuery = (x, y, z) => world.solidAt(x, y, z);
  const skyTop = (x: number, z: number): number => {
    for (let y = 200; y >= -64; y--) if (world.solidAt(x, y, z)) return y;
    return -64;
  };
  const groundAt = (x: number, z: number, fromY = 200): number => {
    for (let y = Math.floor(fromY); y >= -64; y--) if (world.solidAt(x, y, z)) return y + 1;
    return -63;
  };
  const deps: SimDeps & { cell: CellQuery } = { world, cell, skyTop, groundAt };
  const grid = gridOf(world);
  const sky: OpenSky = (x, y, z) => {
    for (let k = y + 1; k <= y + 64; k++) if (grid.solid(x, k, z)) return false;
    return true;
  };
  // the entry's world over the same cells (an unknown cell is none here: the whole synthetic world is known)
  const cells = (x: number, y: number, z: number): number => (world.solidAt(x, y, z) ? ENTRY_SOLID : ENTRY_AIR);
  return { world, deps, grid, skyTop, sky, cells };
}

/** A cave under a mesa 46 high: a hall 17 x 17 and 20 high, and a passage 9 wide and 14 high from its west wall out to the open air (the learned exit's test cave, its passage 4 higher: a glide in comes down through it). */
const cave = (): BlockBox[] => [
  { from: { x: -40, y: FEET, z: -40 }, to: { x: 40, y: FEET + 45, z: 40 }, solid: true },
  { from: { x: -8, y: FEET, z: -8 }, to: { x: 8, y: FEET + 19, z: 8 }, solid: false },
  { from: { x: -40, y: FEET, z: -4 }, to: { x: -9, y: FEET + 13, z: 4 }, solid: false },
];
/** The goal: a cell on the hall's floor, a roof 20 over it. */
const GOAL: Vec3 = { x: 4, y: FEET, z: 0 };
const GOAL_AT: Vec3 = { x: GOAL.x + 0.5, y: GOAL.y, z: GOAL.z + 0.5 };

/** A recording as `!learn` writes one: samples standing at `from`, one sample a tick along the corners `via` at `speed` blocks a tick off the ground, and (`land`) samples standing at the last corner; `rocketMs`: a rocket that long after the last sample on the ground. */
function record(name: string, from: Vec3, via: Vec3[], o: { speed?: number; land?: boolean; rocketMs?: number } = {}): LearnedPath {
  const samples: LearnSample[] = [];
  let t = 0;
  const yawOf = (a: Vec3, b: Vec3): number => (Math.atan2(-(b.x - a.x), b.z - a.z) * 180) / Math.PI;
  for (let i = 0; i < 6; i++, t += 50) samples.push({ t, x: from.x, y: from.y, z: from.z, yaw: yawOf(from, via[0]!), pitch: 0, ground: true });
  const left = t - 50;
  const speed = o.speed ?? 1.3;
  let at = from;
  for (const c of via) {
    const d = Math.hypot(c.x - at.x, c.y - at.y, c.z - at.z);
    const n = Math.max(1, Math.round(d / speed));
    for (let k = 1; k <= n; k++, t += 50) samples.push({ t, x: at.x + ((c.x - at.x) * k) / n, y: at.y + ((c.y - at.y) * k) / n, z: at.z + ((c.z - at.z) * k) / n, yaw: yawOf(at, c), pitch: 0, ground: false });
    at = c;
  }
  if (o.land) for (let i = 0; i < 6; i++, t += 50) samples.push({ t, x: at.x, y: at.y, z: at.z, yaw: 0, pitch: 0, ground: true });
  const rockets = o.rocketMs !== undefined ? [{ t: left + o.rocketMs, x: from.x, y: from.y + 1, z: from.z }] : [];
  return { version: 1, name, player: 'somebody', recorded: '2026-01-01T00:00:00.000Z', samples, rockets, gaps: [], ended: 'stop' };
}

/** The flight into the cave as somebody would record it: off a height in the open to the west, a glide down to the passage's mouth, along the passage sinking a little, into the hall and down beside the goal. */
const wayIn = (name = 'a recording', end: Vec3 = { x: 3.5, y: FEET, z: 0.5 }): LearnedPath =>
  record(
    name,
    { x: -130.5, y: FEET + 36, z: 0.5 },
    [
      { x: -130.5, y: FEET + 37.2, z: 0.5 },
      { x: -100, y: FEET + 30, z: 0.5 },
      { x: -70, y: FEET + 18, z: 0.5 },
      { x: -42, y: FEET + 10.5, z: 0.5 },
      { x: -10, y: FEET + 3, z: 0.5 },
      { x: -2, y: FEET + 1.5, z: 0.5 },
      end,
    ],
    { land: true },
  );

/** The entry line of the recorded way in on a rig, proven wherever a test needs that. */
function lineOf(r: ReturnType<typeof rig>, path: LearnedPath = wayIn()): EntryLine {
  const found = matchEntries([path], GOAL_AT, r.sky, { before: 200 });
  expect(found.matches).toHaveLength(1);
  const line = entryLine(found.matches[0]!, { goal: GOAL_AT, grid: r.grid });
  if (typeof line === 'string') throw new Error(line);
  return line;
}

/** The flight's target for an entry line: where the cruise comes onto it, and the hand-over. */
function entryTarget(line: EntryLine, fallback?: LandingTarget): LandingTarget {
  const aim = entryAim(line);
  return { x: aim.x, z: aim.z, top: Math.round(aim.y) - APPROACH_HEIGHT, half: 2, bearing: aim.bearing, entry: { line, goal: { x: GOAL_AT.x, z: GOAL_AT.z, top: GOAL.y, half: 2 }, ...(fallback ? { fallback } : {}) } };
}

const noPlan = (): never => {
  throw new Error('an entry asks no planner');
};

describe('a recorded way in matched by where it stands again (Track F9c, learn/match.ts matchEntries)', () => {
  it('at a goal under a roof: the flight that came from open sky and stood again beside it, whatever it is called; not at a goal under open sky, not 5 blocks away', () => {
    const r = rig(cave());
    for (const name of ['a recording', 'the_way_out', 'x']) {
      const found = matchEntries([wayIn(name)], GOAL_AT, r.sky, { before: 200 });
      expect(found.flights).toBe(1);
      expect(found.near).toBe(1);
      expect(found.matches).toHaveLength(1);
      expect(found.matches[0]!.off).toBeLessThan(1.5);
      // its last open sky is the mesa's edge: about 90 blocks along it, 45 more under the roof
      expect(guideLength(found.matches[0]!.guide) - found.matches[0]!.open).toBeGreaterThan(40);
    }
    // a goal 5 away from where it stood: no match; nor is the way in a way out from the goal
    expect(matchEntries([wayIn()], { x: 4.5, y: FEET, z: 6.5 }, r.sky, { before: 200 }).matches).toHaveLength(0);
    expect(matchExits([wayIn()], GOAL_AT, r.sky).matches).toHaveLength(0);
    // the same flight ending on open ground (no mesa): a landing in the open needs no way in
    const open = rig([]);
    const found = matchEntries([wayIn()], GOAL_AT, open.sky, { before: 200 });
    expect(found.near).toBe(1);
    expect(found.matches).toHaveLength(0);
  });
});

describe('the entry line: the hand-over window in the open, the lead-in before it, the touchdown (learn/entry.ts entryLine)', () => {
  it('the window lies in the open air well before the roof, the lead-in is its heading drawn backwards, the line ends over the goal', () => {
    const r = rig(cave());
    const line = lineOf(r);
    const g = line.guide;
    expect(line.to - line.from).toBeGreaterThanOrEqual(20);
    expect(line.open - line.to).toBeGreaterThanOrEqual(19);
    expect(line.lead).toBeGreaterThan(20);
    expect(line.from).toBe(line.lead);
    // every point up to the window's end is under open sky; the touchdown is the goal's cell, under the roof
    for (let i = 0; i <= line.to; i++) expect(r.sky(Math.floor(g.points[i]!.x), Math.floor(g.points[i]!.y), Math.floor(g.points[i]!.z))).toBe(true);
    expect(line.touchdown).toEqual(GOAL_AT);
    expect(r.sky(GOAL.x, GOAL.y, GOAL.z)).toBe(false);
    // the lead-in: straight, descending towards the window, along the recording's heading there (+x)
    const a = g.points[0]!;
    const b = g.points[line.lead]!;
    expect(a.y).toBeGreaterThan(b.y + 5);
    expect(b.x - a.x).toBeGreaterThan(line.lead * 0.9);
    expect(Math.abs(a.z - b.z)).toBeLessThan(0.01);
    // the recording's speed is on the line (the lead-in at the window's own), no rocket is
    expect(guideSpeed(g, (line.from + line.to) / 2)).toBeCloseTo(1.3, 1);
    expect(guideSpeed(g, line.lead / 2)).toBeCloseTo(1.3, 1);
    expect(g.rockets).toHaveLength(0);
    // where the cruise aims: the window's end, in along the lead-in
    const aim = entryAim(line);
    expect(aim.x).toBeCloseTo(guidePoint(g, line.to).pos.x, 3);
    expect(Math.abs(((aim.bearing - 90 + 540) % 360) - 180)).toBeLessThan(1); // from the aim outwards: west, yaw 90
  });

  it('a recording with no glide in the open before its roof gives no line', () => {
    const r = rig(cave());
    // (it stands off the ground right at the mouth: 8 blocks of open air)
    const short = record('short', { x: -48.5, y: FEET, z: 0.5 }, [{ x: -48.5, y: FEET + 1.2, z: 0.5 }, { x: -10, y: FEET + 3, z: 0.5 }, { x: 3.5, y: FEET, z: 0.5 }], { land: true });
    const found = matchEntries([short], GOAL_AT, r.sky, { before: 200 });
    expect(found.matches).toHaveLength(1);
    expect(typeof entryLine(found.matches[0]!, { goal: GOAL_AT, grid: r.grid })).toBe('string');
  });
});

describe('the proof: every state the hand-over allows, flown to standing (learn/entry.ts proveEntry)', () => {
  it('clears from the window\'s middle, start and end, on the line and at every extreme of the box; each flight stands by the goal without a hit', async () => {
    const r = rig(cave());
    const line = lineOf(r);
    const w = entryWorld(r.cells, GOAL_AT);
    const cases = entryCases(line);
    expect(cases.length).toBe(39);
    const proof = await proveEntry(w, line);
    expect(proof.line).toMatch(/^clear from \d+ entry states/);
    expect(proof.ok).toBe(true);
    expect(proof.sims).toBeGreaterThanOrEqual(30);
    expect(proof.off).toBeLessThanOrEqual(ENTRY_TOUCH);
    expect(proof.room).toBeGreaterThan(0.3);
    // from the last open sky to standing: 8 s at most
    expect(proof.roofTicks).toBeLessThanOrEqual(160);
    // one of them by itself: the recording's own state at the window's middle
    const f = flyEntry(w, line, entryState(line, (line.from + line.to) / 2));
    expect(entryVerdict(f)).toBeUndefined();
    expect(f.landed).toBe(true);
    expect(f.hits).toBe(0);
    expect(f.off).toBeLessThan(1);
    expect(Math.abs(f.dy)).toBeLessThan(0.01);
    expect(f.touch.vy).toBeGreaterThan(-0.3);
  }, 60_000);

  it('a body faster than the recording is slowed to it (the look straight back for a tick, never two in a row) and still stands on the goal', () => {
    const r = rig(cave());
    const line = lineOf(r);
    const w = entryWorld(r.cells, GOAL_AT);
    const mid = (line.from + line.to) / 2;
    let fastest = 0;
    let taps = 0;
    let lastTap = -5;
    let twice = false;
    const f = flyEntry(w, line, entryState(line, mid, { speed: 1.9 }), {
      trace: (t, body, out) => {
        if (out.status !== 'line' || out.at < line.open) return;
        fastest = Math.max(fastest, Math.hypot(body.vel.x, body.vel.y, body.vel.z));
        // (a tap: the look against the velocity)
        const back = Math.abs(((out.control.yaw - (Math.atan2(-body.vel.x, body.vel.z) * 180) / Math.PI + 540) % 360) - 180) > 170;
        if (back) {
          taps++;
          if (t - lastTap === 1) twice = true;
          lastTap = t;
        }
      },
    });
    expect(entryVerdict(f)).toBeUndefined();
    expect(f.taps).toBeGreaterThan(0);
    expect(twice).toBe(false);
    // under the roof it is no faster than the governor lets it be (a tick's worth over)
    expect(fastest).toBeLessThan(1.3 * FOLLOW_TAP_OVER + 0.25);
    expect(taps).toBeLessThanOrEqual(f.taps);
  });

  it('the world changed since the recording (a wall across the passage): refused; and a proof made before the change does not stand on the live world', async () => {
    const before = rig(cave());
    const line = lineOf(before);
    const w = entryWorld(before.cells, GOAL_AT);
    expect((await proveEntry(w, line)).ok).toBe(true);
    const wall: BlockBox = { from: { x: -22, y: FEET, z: -4 }, to: { x: -21, y: FEET + 9, z: 4 }, solid: true };
    const after = rig([...cave(), wall]);
    const refused = await proveEntry(entryWorld(after.cells, GOAL_AT), lineOf(after));
    expect(refused.ok).toBe(false);
    expect(refused.line).toMatch(/loses the line|hits a solid/);
    // the proof's cells against the live world: the same world, the changed one, one not loaded yet
    expect(entryWorldSame(w.asked, before.cells).same).toBe('same');
    const changed = entryWorldSame(w.asked, after.cells);
    expect(changed.same).toBe('changed');
    expect(changed.cell!.x).toBeGreaterThanOrEqual(-22);
    expect(changed.cell!.x).toBeLessThanOrEqual(-21);
    const loading = entryWorldSame(w.asked, (x, y, z) => (x > -20 ? ENTRY_UNKNOWN : before.cells(x, y, z)));
    expect(loading.same).toBe('unknown');
    expect(loading.unknown).toBeGreaterThan(0);
  }, 60_000);
});

describe('the hand-over: on the lead-in to the flier, committed only inside what the proof flew (learn/entry.ts)', () => {
  it('entryJoin takes a body near the lead-in heading along it, higher the farther before the window; entryCatch only one inside the box in the window', () => {
    const r = rig(cave());
    const line = lineOf(r);
    const mid = (line.from + line.to) / 2;
    expect(entryCatch(line, entryState(line, mid)).ok).toBe(true);
    expect(entryCatch(line, entryState(line, mid, { side: ENTRY_BOX.side + 1 })).why).toMatch(/beside the line/);
    expect(entryCatch(line, entryState(line, mid, { up: ENTRY_BOX.over + 1 })).why).toMatch(/over the line/);
    expect(entryCatch(line, entryState(line, mid, { up: -ENTRY_BOX.under - 1 })).why).toMatch(/under the line/);
    expect(entryCatch(line, entryState(line, mid, { heading: ENTRY_BOX.heading + 10 })).why).toMatch(/heading/);
    expect(entryCatch(line, entryState(line, mid, { speed: 0.5 })).why).toMatch(/too slow/);
    expect(entryCatch(line, entryState(line, mid, { speed: 2.4 })).why).toMatch(/too fast/);
    expect(entryCatch(line, entryState(line, line.from - 6)).why).toMatch(/before the window/);
    expect(entryCatch(line, entryState(line, line.open - 4)).why).toMatch(/past the window/);
    // the join: 12 over the lead-in's start is fine (the line is long ahead), 12 over the window's end is not
    expect(entryJoin(line, entryState(line, 14, { up: 12 })).ok).toBe(true);
    expect(entryJoin(line, entryState(line, line.to - ENTRY_JOIN.before - 1, { up: 12 })).ok).toBe(false);
    expect(entryJoin(line, entryState(line, 10, { side: ENTRY_JOIN.side + 2 })).ok).toBe(false);
    expect(entryJoin(line, entryState(line, 10, { heading: ENTRY_JOIN.heading + 10 })).ok).toBe(false);
    expect(entryJoin(line, entryState(line, line.to + 2)).past).toBe(true);
  });

  it('a body that reaches the window outside the box is never committed: the flier says missed at the window\'s end; one whose proof is not confirmed likewise', () => {
    const r = rig(cave());
    const line = lineOf(r);
    // held 5.5 beside the line all the way (a body that cannot come nearer): joining, never the line, then missed
    const flyHeld = (confirmed: boolean, side: number): string[] => {
      const flier = new EntryFlier({ grid: r.grid, line, at: line.from - 4 });
      flier.confirmed = confirmed;
      const seen: string[] = [];
      for (let at = line.from - 4; at <= line.to + 3; at += 1.3) {
        const s = entryState(line, at, { side });
        const out = flier.tick({ pos: s.pos, vel: s.vel, gliding: true, onGround: false, boostTicks: 0, rockets: 0 }, { yaw: -90 }, 1);
        seen.push(out.status);
        if (out.status === 'missed') {
          seen.push(out.why ?? '');
          break;
        }
      }
      expect(flier.committed).toBe(seen.includes('line'));
      return seen;
    };
    const off = flyHeld(true, ENTRY_BOX.side + 2.5);
    expect(off).not.toContain('line');
    expect(off[off.length - 2]).toBe('missed');
    expect(off[off.length - 1]).toMatch(/beside the line/);
    const unconfirmed = flyHeld(false, 0);
    expect(unconfirmed).not.toContain('line');
    expect(unconfirmed[unconfirmed.length - 1]).toMatch(/not confirmed/);
    // on the line with the proof standing: committed in the window
    expect(flyHeld(true, 0)).toContain('line');
  });
});

describe('the whole flight: out of a cruise onto the line, under the roof, standing on the goal (brain.ts entry)', () => {
  /** A flight from standing in the open to the entry's target, on the same simulator as every takeoff's proof. */
  async function fly(r: ReturnType<typeof rig>, from: Vec3, target: LandingTarget, o: { entryTries?: number; confirm?: boolean; cruiseY?: number } = {}) {
    const notes: string[] = [];
    const cruiseY = o.cruiseY ?? cruiseHeight(from, { x: GOAL_AT.x, z: GOAL_AT.z, top: GOAL.y, half: 2 }, r.skyTop, {}).y;
    let committedOutside = false;
    let underRoof = false;
    let brainSeen: FlightBrain | undefined;
    const sim = await simulateFlight(r.deps, from, target, { cruiseY, route: { grid: r.grid, plan: noPlan }, note: (m) => notes.push(m), ...(o.entryTries !== undefined ? { entryTries: o.entryTries } : {}) }, {
      rockets: 64,
      maxTicks: 4000,
      until: (b, body) => {
        if (!brainSeen) {
          brainSeen = b;
          if (o.confirm !== undefined) b.confirmEntry(o.confirm);
        }
        // never under the roof on a learned line without the commit
        if (b.phase === 'entry' && b.descending === 'entry (joining)' && body.pos.x > -40 && body.gliding) committedOutside = true;
        // in the air inside the mesa's footprint and under its top: in the passage or the hall, whatever the phase
        if (body.gliding && Math.abs(body.pos.x) < 40 && Math.abs(body.pos.z) < 40 && body.pos.y < FEET + 45) underRoof = true;
        return false;
      },
    });
    return { sim, notes, committedOutside, underRoof };
  }

  it('from the west: one flight, onto the lead-in, committed in the window, standing on the goal\'s cell; no hit, no water, no go-around', async () => {
    const r = rig(cave());
    const line = lineOf(r);
    const { sim, notes, committedOutside } = await fly(r, { x: -420.5, y: FEET, z: 30.5 }, entryTarget(line));
    const say = notes.join('\n');
    expect(sim.end, say).toBeDefined();
    expect(sim.end!.ok, say).toBe(true);
    expect(sim.end!.onTarget).toBe(true);
    expect(Math.hypot(sim.end!.landedAt.x - GOAL_AT.x, sim.end!.landedAt.z - GOAL_AT.z)).toBeLessThan(ENTRY_TOUCH);
    expect(sim.end!.landedAt.y).toBe(FEET);
    expect(sim.wet).toBe(false);
    expect(sim.stats.entry).toMatchObject({ name: 'a recording', end: 'landed', misses: 0 });
    expect(sim.stats.entry!.roofTicks).toBeLessThanOrEqual(160);
    expect(sim.stats.goArounds).toBe(0);
    expect(committedOutside).toBe(false);
    // the decision's lines: the hand-over, the commit with what the body's state was, the touchdown, the standing
    expect(say).toMatch(/learned entry: onto the line of a recording \d+ blocks (before its hand-over window \(the lead-in\)|into its hand-over window), \d+ before its roof/);
    expect(say).toMatch(/learned entry: on the line a recording \d+ blocks before its roof \([\d.]+ beside it, [\d.]+ (over|under) it, [\d.]+ a tick where the recording had [\d.]+, the heading \d+ degrees off its own\): inside what the proof flew/);
    expect(say).toMatch(/learned entry: the touchdown begins/);
    expect(say).toMatch(/learned entry: standing [\d.]+ from the goal along a recording: \d+ ticks after the commit, \d+ from the line's last open sky/);
  }, 120_000);

  it('a flight that comes in 120 over the lead-in: down the helix beside its start, onto the line at a pass along it, standing on the goal', async () => {
    const r = rig(cave());
    const line = lineOf(r);
    const top = line.guide.points[0]!.y;
    const { sim, notes, committedOutside } = await fly(r, { x: -420.5, y: FEET, z: 30.5 }, entryTarget(line), { cruiseY: top + 120 });
    const say = notes.join('\n');
    expect(say).toMatch(/learned entry: \d+ over the lead-in of a recording where the flier takes at most \d+: down in a circle of 14 beside its start/);
    expect(sim.stats.descents.some((d) => d.startsWith('helix r14'))).toBe(true);
    expect(sim.end?.ok, say).toBe(true);
    expect(sim.stats.entry).toMatchObject({ end: 'landed', misses: 0 });
    expect(sim.stats.goArounds).toBe(0);
    expect(committedOutside).toBe(false);
    expect(sim.wet).toBe(false);
  }, 120_000);

  it('the helix is steered to its pass: from any height over the lead-in the body comes onto the line about ENTRY_HELIX_UNTIL over it (a lap never ends where the arrival height happened to put it)', async () => {
    const r = rig(cave());
    const line = lineOf(r);
    const top = line.guide.points[0]!.y;
    let circled = 0;
    for (const over of [40, 44, 48, 52, 55, 58, 62, 66, 71, 84, 97, 110, 123, 136]) {
      const { sim, notes } = await fly(r, { x: -420.5, y: FEET, z: 30.5 }, entryTarget(line), { cruiseY: top + over });
      const say = `${over} over: ${notes.join('\n')}`;
      expect(sim.end?.ok, say).toBe(true);
      expect(sim.stats.entry, say).toMatchObject({ end: 'landed', misses: 0 });
      expect(sim.stats.goArounds, say).toBe(0);
      // (a cruise low enough comes down onto the lead-in by its own dive and flies no circle; one that reaches the start
      // just over what the flier takes has no lap to spend and is handed over as high as the hand-over allows)
      const laps = /down in a circle of 14 beside its start, (\d+) laps?/.exec(notes.join('\n'));
      if (!laps || Number(laps[1]) < 1) continue;
      expect(sim.stats.descents.some((d) => d.startsWith('helix r14')), say).toBe(true);
      circled++;
      // the hand-over after the circle: how far over the line the body was given to the flier
      const m = /learned entry: onto the line of a recording .*?\([\d.]+ beside the line, ([\d.]+) (over|under) it/.exec(notes.join('\n'));
      expect(m, say).not.toBeNull();
      const up = Number(m![1]) * (m![2] === 'over' ? 1 : -1);
      expect(up, say).toBeGreaterThan(ENTRY_HELIX_UNTIL - 4);
      expect(up, say).toBeLessThan(ENTRY_HELIX_UNTIL + 5);
    }
    expect(circled).toBeGreaterThanOrEqual(4);
  }, 240_000);

  it('ground under both circles within a few blocks of the pass height: no helix is begun, and the flight does not end under the roof uncommitted', async () => {
    const open = rig(cave());
    const p0 = lineOf(open).guide.points[0]!;
    // a ridge on each side of the lead-in's start, 6 blocks from the line, its top 10 over the start
    const ridge = (side: 1 | -1): BlockBox => ({ from: { x: Math.floor(p0.x) - 24, y: FEET, z: side === 1 ? 6 : -40 }, to: { x: Math.floor(p0.x) + 24, y: Math.floor(p0.y) + 10, z: side === 1 ? 40 : -6 }, solid: true });
    const r = rig([...cave(), ridge(1), ridge(-1)]);
    const line = lineOf(r);
    expect(line.guide.points[0]!.y).toBeCloseTo(p0.y, 1);
    const { sim, notes, committedOutside } = await fly(r, { x: -420.5, y: FEET, z: 30.5 }, entryTarget(line), { cruiseY: p0.y + 100 });
    const say = notes.join('\n');
    expect(say).not.toMatch(/down in a circle/);
    expect(sim.stats.descents.some((d) => d.startsWith('helix r14')), say).toBe(false);
    expect(committedOutside, say).toBe(false);
    expect(sim.wet).toBe(false);
  }, 120_000);

  it('from behind the mesa (the wrong side for the line): it goes round or falls back, and is never under the roof on the line uncommitted', async () => {
    const r = rig(cave());
    const line = lineOf(r);
    const hold: LandingTarget = { x: GOAL_AT.x, z: GOAL_AT.z, top: GOAL.y, half: 2, hold: true };
    const { sim, notes, committedOutside } = await fly(r, { x: 320.5, y: FEET, z: 20.5 }, entryTarget(line, hold));
    const say = notes.join('\n');
    expect(committedOutside, say).toBe(false);
    const en = sim.stats.entry;
    // either it came round onto the lead-in and stood on the goal, or it gave the entry up for the landing as before
    // (the goal held: nothing here retargets it, so the flight is still holding when the simulation stops)
    if (en?.end === 'landed') expect(sim.end!.ok, say).toBe(true);
    else {
      expect(en?.end ?? 'fallback', say).toBe('fallback');
      expect(say).toMatch(/learned entry: a recording given up/);
      expect(sim.end, say).toBeUndefined();
    }
    expect(sim.wet).toBe(false);
  }, 120_000);

  it('the proof made on the world cache and not confirmed live: never committed; told the live world differs: the fallback at once', async () => {
    const r = rig(cave());
    const line = lineOf(r);
    const hold: LandingTarget = { x: GOAL_AT.x, z: GOAL_AT.z, top: GOAL.y, half: 2, hold: true };
    const unconfirmed = entryTarget(line, hold);
    unconfirmed.entry!.unconfirmed = true;
    // never confirmed: the window is missed (twice), then the fallback
    const a = await fly(r, { x: -420.5, y: FEET, z: 30.5 }, unconfirmed);
    expect(a.committedOutside).toBe(false);
    expect(a.sim.stats.entry).toMatchObject({ end: 'fallback' });
    expect(a.sim.stats.entry!.misses).toBe(ENTRY_TRIES);
    expect(a.notes.join('\n')).toMatch(/the proof is not confirmed on the live world yet/);
    // confirmed on the way: flown as any other
    const b = await fly(r, { x: -420.5, y: FEET, z: 30.5 }, unconfirmed, { confirm: true });
    expect(b.sim.stats.entry).toMatchObject({ end: 'landed', misses: 0 });
    expect(b.sim.end!.ok).toBe(true);
    // the live world differs: given up before the line is ever joined
    const c = await fly(r, { x: -420.5, y: FEET, z: 30.5 }, unconfirmed, { confirm: false });
    expect(c.sim.stats.entry).toMatchObject({ end: 'fallback', joins: 0 });
    expect(c.notes.join('\n')).toMatch(/the proof does not stand on the live world/);
  }, 240_000);

  it('given up low at the window\'s end (one try, the proof never confirmed): up and away on a rocket whose path is clear, or down on the nearest ground at once; never on under the roof, no hit', async () => {
    const r = rig(cave());
    const line = lineOf(r);
    const hold: LandingTarget = { x: GOAL_AT.x, z: GOAL_AT.z, top: GOAL.y, half: 2, hold: true };
    const target = entryTarget(line, hold);
    target.entry!.unconfirmed = true;
    const { sim, notes, underRoof, committedOutside } = await fly(r, { x: -420.5, y: FEET, z: 30.5 }, target, { entryTries: 1 });
    const say = notes.join('\n');
    expect(sim.stats.entry, say).toMatchObject({ end: 'fallback', misses: 1 });
    expect(committedOutside, say).toBe(false);
    expect(sim.hits, say).toBe(0);
    expect(sim.wet).toBe(false);
    // the mesa's wall is 20 blocks ahead of the window's end and 25 over the line there: no look clears it, so the
    // landing at once, on ground before the line's roof (uncapped, the emergency landing took the safe ground 60 blocks
    // ahead: the hall's floor, through the passage on nobody's proof)
    expect(say).toMatch(/learned entry: no way up and out from where it was given up .*landing on the nearest ground, within \d+ blocks/);
    expect(sim.end, say).toMatchObject({ ok: false, reason: 'roof' });
    expect(underRoof, say).toBe(false);
    expect(sim.end!.landedAt.x, say).toBeLessThanOrEqual(-40);
  }, 120_000);

  it('no entry on the target: the brain flies as it did (the same controls tick for tick, with or without the entry options)', async () => {
    const r = rig([]);
    const target: LandingTarget = { x: 0.5, z: 300.5, top: FEET, half: 2 };
    const run = async (opts: { entryTries?: number; entrySneak?: boolean }): Promise<string> => {
      const seen: string[] = [];
      const sim = await simulateFlight(r.deps, { x: 0.5, y: FEET, z: 0.5 }, target, { cruiseY: FEET + 40, ...opts }, { rockets: 16, maxTicks: 1500, until: (b, body) => (seen.push(`${b.phase} ${body.pos.x.toFixed(3)} ${body.pos.y.toFixed(3)} ${body.pos.z.toFixed(3)}`), false) });
      expect(sim.stats.entry).toBeUndefined();
      return `${sim.end?.ok} ${sim.ticks} ${seen.join('|')}`;
    };
    expect(await run({ entryTries: 0, entrySneak: true })).toBe(await run({}));
  }, 60_000);

  it('the setting is off by default', () => {
    expect(SETTING_DEFS.flyLearnedEntry.default).toBe(false);
    expect(SETTING_DEFS.flyLearned.default).toBe(false);
  });
});

describe('the learned exit and a first rocket that fires nothing (Track F9c, item 5: glide.ts, learn/follow.ts)', () => {
  const START: Vec3 = { x: 4.5, y: FEET, z: 4.5 };
  const target: LandingTarget = { x: 0.5, z: 600.5, top: FEET, half: 1 };
  const outLine = (from: Vec3 = START): Vec3[] => [
    { x: from.x, y: from.y + 1.2, z: from.z },
    { x: -6, y: FEET + 3, z: 0.5 },
    { x: -38, y: FEET + 5, z: 0.5 },
    { x: -50, y: FEET + 9, z: 0.5 },
    { x: -70, y: FEET + 24, z: 0.5 },
    { x: -85, y: FEET + 40, z: 0.5 },
  ];
  const wayOut = (name = 'a recording', from: Vec3 = START): LearnedPath => record(name, from, outLine(from), { speed: 1.5, rocketMs: 400 });
  const skyTo = (r: ReturnType<typeof rig>, top: number): OpenSky => (x, y, z) => {
    for (let k = y + 1; k <= top; k++) if (r.grid.solid(x, k, z)) return false;
    return true;
  };

  it('the write-off is seen as long as the rocket hand believes a use (the simulation\'s DUD_SEEN_TICKS is the hand\'s ROCKET_ADD_WITHIN), and is shorter than any burn', () => {
    expect(DUD_SEEN_TICKS).toBe(ROCKET_ADD_WITHIN);
    expect(DUD_SEEN_TICKS).toBeLessThan(FOLLOW_DUD_TICKS);
  });

  it('the proof flies a first rocket that fires nothing (the next at the nominal burn and the extremes) and says so; the follower finds its place again and asks for the rocket again', async () => {
    const r = rig(cave());
    const cruiseY = cruiseHeight(START, target, r.skyTop, {}).y;
    const learned = matchExits([wayOut()], START, skyTo(r, Math.ceil(cruiseY)));
    const count = { sims: 0 };
    const prove: TakeoffProof = async (route: TakeoffRoute) => {
      const p = await routeTakeoff(r.deps, START, target, { cruiseY }, 64, { route: { grid: r.grid, plan: (req) => planRoute(req, r.grid), maxMs: SLOW }, takeoff: routeTakeoffOptions(route, true) }, { planTicks: route.ticks });
      count.sims += p.sims;
      return p;
    };
    const got = await planTakeoffRoute(r.grid, START, target, { rockets: 4, prove, learned: { matches: learned.matches } }, (req) => planRoute(req, r.grid));
    expect(got.route?.guide?.line.path).toBe('a recording');
    expect(count.sims).toBe(1 + LEARNED_PROOF_BURNS.length + LEARNED_PROOF_MIXES.length + LEARNED_PROOF_DUDS.length);
    expect(got.tried[0]).toMatch(/and with a first rocket that fires nothing \(the next at 15, 9, 21\)/);
    // flown with the dud: the follower notices (the burn it saw is shorter than any rocket's), follows from where the body
    // really is, fires again at once, and the takeoff is out with no hit
    const notes: string[] = [];
    const route = got.route!;
    const sim = await simulateFlight(r.deps, START, target, { cruiseY, takeoffYaw: route.yaw, route: { grid: r.grid, plan: (req) => planRoute(req, r.grid), maxMs: SLOW }, routeTakeoff: routeTakeoffOptions(route, true), note: (m) => notes.push(m) }, { rockets: 64, yaw: route.yaw, maxTicks: 300 + route.ticks, until: (b) => b.phase === 'approach', dud: (k) => k === 0 });
    const say = notes.join('\n');
    expect(sim.stats.routeTakeoffEnd, say).toBe('out');
    expect(sim.hits - (sim.bumps ?? 0)).toBe(0);
    expect(say).toMatch(/learned line: rocket 1 fired nothing \(its burn taken back after \d ticks/);
    expect(say).toMatch(/learned line: rocket 2 asked for \d+ blocks along it, \d+ ticks off the ground \((the one before fired nothing|the body at)/);
    expect(sim.stats.routeTakeoffRockets).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it('a take that clears every burn but not a dud first rocket is kept for last: the take that survives one is flown; alone, it is still flown and its line says so', async () => {
    const r = rig(cave());
    const cruiseY = cruiseHeight(START, target, r.skyTop, {}).y;
    const two = matchExits([wayOut('first'), wayOut('second', { x: 5.5, y: FEET, z: 5.5 })], START, skyTo(r, Math.ceil(cruiseY)));
    expect(two.matches.map((m) => m.guide.path)).toEqual(['first', 'second']);
    // (a stand-in proof: both clear; the nearer take does not survive the dud)
    const prove: TakeoffProof = (route) => Promise.resolve({ ok: true, ticks: 100, out: 60, line: 'clear', dud: route.guide?.line.path !== 'first' });
    const got = await planTakeoffRoute(r.grid, START, target, { rockets: 4, prove, learned: { matches: two.matches } }, (req) => planRoute(req, r.grid));
    expect(got.route?.guide?.line.path).toBe('second');
    expect(got.tried[0]).toMatch(/first .*kept for when no other take survives a rocket that fires nothing/);
    const alone = await planTakeoffRoute(r.grid, START, target, { rockets: 4, prove, learned: { matches: two.matches.slice(0, 1) } }, (req) => planRoute(req, r.grid));
    expect(alone.route?.guide?.line.path).toBe('first');
    expect(alone.route?.proven).toBe(true);
  }, 60_000);

  it('the follower by itself: a burn that ends after 5 ticks was no burn: the rocket is asked for again on that tick, at any speed', () => {
    const r = rig(cave());
    const g = guidesOf(wayOut())[0]!;
    const f = new GuideFollower({ grid: r.grid, guide: g });
    const at = guidePoint(g, 20);
    const body = (boost: number) => ({ pos: at.pos, vel: { x: at.dir.x * 1.4, y: at.dir.y * 1.4, z: at.dir.z * 1.4 }, gliding: true, onGround: false, boostTicks: boost, rockets: 8 });
    // a burn seen for 5 ticks, then gone
    for (let t = 1; t <= 5; t++) expect(f.tick(body(20 - t), t).control.fire).toBe(false);
    const out = f.tick(body(0), 6);
    expect(out.control.fire).toBe(true);
    expect(f.wasted).toBe(1);
    // a real burn that ends after 12 ticks is none: no rocket for a body at speed
    const f2 = new GuideFollower({ grid: r.grid, guide: g });
    for (let t = 1; t <= 12; t++) f2.tick(body(12 - t + 1), t);
    expect(f2.tick(body(0), 13).control.fire).toBe(false);
    expect(f2.wasted).toBe(0);
  });
});

describe('round 2: the cave changed since the recording: another touchdown beside the goal (learn/entry.ts chooseTouchdown)', () => {
  const matchOf = (r: ReturnType<typeof rig>, path: LearnedPath) => {
    const found = matchEntries([path], GOAL_AT, r.sky, { before: 200 });
    expect(found.matches).toHaveLength(1);
    return found.matches[0]!;
  };

  it('the cells a touchdown may be: the goal\'s own first, then the standable ones within 2 of it by distance, its own level before the one under it before the one over it', () => {
    // a floor at y 0 round a goal at (0, 1, 0); a hole west of it one deeper; a block north of it; water south of it
    const cell = (x: number, y: number, z: number): number => {
      if (x === -1 && z === 0) return y <= -1 ? ENTRY_SOLID : ENTRY_AIR; // the hole: its floor a level under the goal's
      if (x === 0 && z === -1) return y <= 1 ? ENTRY_SOLID : ENTRY_AIR; // a block on the floor: its top a level over
      if (x === 0 && z === 1 && y === 1) return ENTRY_UNKNOWN; // a cell nobody knows: no touchdown
      return y <= 0 ? ENTRY_SOLID : ENTRY_AIR;
    };
    const goal = { x: 0, y: 1, z: 0 };
    const cells = entryTouchdowns(cell, goal);
    const key = (c: Vec3): string => `${c.x - goal.x} ${c.y - goal.y} ${c.z - goal.z}`;
    expect(key(cells[0]!)).toBe('0 0 0');
    const keys = cells.map(key);
    // one block beside the goal: its own level (east), then the level under (the hole), then the level over (the block's top)
    expect(keys.slice(1, 4)).toEqual(['1 0 0', '-1 -1 0', '0 1 -1']);
    expect(keys).not.toContain('0 0 1'); // unknown
    expect(keys).not.toContain('-1 0 0'); // no floor under the feet
    expect(keys).not.toContain('0 0 -1'); // a solid
    for (const c of cells) expect(Math.hypot(c.x - goal.x, c.z - goal.z)).toBeLessThanOrEqual(2);
    for (let i = 2; i < cells.length; i++) expect(Math.hypot(cells[i]!.x, cells[i]!.z)).toBeGreaterThanOrEqual(Math.hypot(cells[i - 1]!.x, cells[i - 1]!.z));
  });

  it('the cells are tried in turn and the proof decides: one that leaves the body more than 2 from the goal is refused, the next that clears is the take\'s, and the whole flight stands within 2 of the goal on it', async () => {
    const r = rig(cave());
    const m = matchOf(r, wayIn());
    const w = entryWorld(r.cells, GOAL_AT);
    // a standable cell of the hall 2.8 beside the goal (no touchdown of entryTouchdowns: here to be refused), then the one before the goal on the line
    const far = { x: GOAL.x + 2, y: GOAL.y, z: GOAL.z + 2 };
    const near = { x: GOAL.x - 1, y: GOAL.y, z: GOAL.z };
    const pick = await chooseTouchdown(w, m, GOAL, [far, near]);
    expect(pick.said).toMatch(/^to the cell 2 0 2 from it \(2\.8 beside\): stands [\d.]+ from the (touchdown|goal) from /);
    expect(pick.proof?.ok, pick.said).toBe(true);
    expect(pick.cell).toEqual(near);
    expect(pick.said).toMatch(/; to the cell -1 0 0 from it \(1\.0 beside\): clear from \d+ entry states .*standing at most [\d.]+ from the touchdown and [\d.]+ from the goal/);
    expect(pick.proof!.far).toBeLessThanOrEqual(ENTRY_GOAL);
    expect(pick.proofs).toBe(1);
    // the line it flies: to that cell, the goal kept beside it
    const line = pick.line!;
    expect(line.touchdown).toEqual({ x: near.x + 0.5, y: near.y, z: near.z + 0.5 });
    expect(line.goal).toEqual(GOAL_AT);
    // the cells the choice asked are the proof's cells: the live confirmation covers the refused cell's flights too
    expect(entryWorldSame(w.asked, r.cells).same).toBe('same');
    // the whole flight along that line: standing beside the goal, within 2 of it
    const notes: string[] = [];
    const from = { x: -420.5, y: FEET, z: 30.5 };
    const sim = await simulateFlight(r.deps, from, entryTarget(line), { cruiseY: cruiseHeight(from, { x: GOAL_AT.x, z: GOAL_AT.z, top: GOAL.y, half: 2 }, r.skyTop, {}).y, route: { grid: r.grid, plan: noPlan }, note: (n) => notes.push(n) }, { rockets: 64, maxTicks: 4000 });
    const say = notes.join('\n');
    expect(sim.stats.entry, say).toMatchObject({ end: 'landed', misses: 0 });
    expect(sim.end, say).toBeDefined();
    expect(Math.hypot(sim.end!.landedAt.x - GOAL_AT.x, sim.end!.landedAt.z - GOAL_AT.z), say).toBeLessThanOrEqual(ENTRY_GOAL);
    expect(sim.wet).toBe(false);
    // the goal's own cell first when it is among the cells and clears: as before round 2, and its line says nothing of another cell
    const own = await chooseTouchdown(entryWorld(r.cells, GOAL_AT), m, GOAL, entryTouchdowns(r.cells, GOAL));
    expect(own.cell).toEqual(GOAL);
    expect(own.said).toMatch(/^to the goal's cell: clear from \d+ entry states/);
    expect(own.said).not.toMatch(/to the cell|from the goal/);
    // a take whose own states fly to none of the cells is given up for a few simulations, with no whole proof
    const nowhere = await chooseTouchdown(entryWorld(r.cells, GOAL_AT), m, GOAL, [far, { x: GOAL.x + 2, y: GOAL.y, z: GOAL.z - 2 }, { x: GOAL.x - 2, y: GOAL.y, z: GOAL.z + 3 }]);
    expect(nowhere.proof).toBeUndefined();
    expect(nowhere.cell).toBeUndefined();
    expect(nowhere.proofs).toBe(0);
    expect(nowhere.sims).toBeLessThanOrEqual(9);
    expect(nowhere.said).toMatch(/its own state does not fly to 2 more cells beside the goal either$/);
  }, 180_000);

  it('an entry that stood and is in the air again (it slid off the single block it stood on) comes down where it is: the flight is not called lost', async () => {
    const r = rig(cave());
    const line = lineOf(r);
    const from = { x: -420.5, y: FEET, z: 30.5 };
    const notes: string[] = [];
    let brain: FlightBrain | undefined;
    const sim = await simulateFlight(r.deps, from, entryTarget(line), { cruiseY: cruiseHeight(from, { x: GOAL_AT.x, z: GOAL_AT.z, top: GOAL.y, half: 2 }, r.skyTop, {}).y, route: { grid: r.grid, plan: noPlan }, note: (n) => notes.push(n) }, {
      rockets: 64,
      maxTicks: 4000,
      until: (b) => {
        brain = b;
        return false;
      },
    });
    expect(sim.stats.entry).toMatchObject({ end: 'landed' });
    expect(brain!.phase).toBe('done');
    const at = sim.end!.landedAt;
    brain!.bounce({ pos: { x: at.x, y: at.y + 0.6, z: at.z }, vel: { x: 0, y: -0.2, z: 0 }, gliding: false, onGround: false, boostTicks: 0 });
    // (before: the cruise again and `landNow('lost')`: the entry's target is the window's end, 90 blocks off, so the brain took
    // the body for one far from its landing)
    expect(brain!.phase).toBe('land');
    expect(notes.join('\n')).toMatch(/learned entry: in the air again after standing/);
  }, 120_000);

  it('a flight must stand within 2 of the goal whatever its touchdown, and a refusal says where the hit was against the goal', () => {
    const r = rig(cave());
    const line = lineOf(r);
    const f = flyEntry(entryWorld(r.cells, GOAL_AT), line, entryState(line, (line.from + line.to) / 2));
    expect(entryVerdict(f)).toBeUndefined();
    expect(f.offGoal).toBeLessThan(1);
    expect(entryVerdict({ ...f, offGoal: 2.4 })).toBe('stands 2.4 from the goal');
    expect(entryVerdict({ ...f, dyGoal: -3 })).toBe('stands 0.' + f.offGoal.toFixed(1).slice(2) + ' from the goal and 3.0 under it');
    expect(entryVerdict({ ...f, hits: 1, firstHit: { tick: 70, at: 134, from: { x: -0.2, y: 1, z: -1.8 } } })).toBe('hits a solid 1 time (the first at tick 70, 134 blocks along the line, -0.2 1.0 -1.8 from the goal)');
    expect(offsets({ x: 1, y: -1, z: 0.04 })).toBe('1.0 -1.0 0.0');
  });

  it('the proof flies the recording\'s own three states first, then the corners, then each single extreme: 39 in all', () => {
    const r = rig(cave());
    const cases = entryCases(lineOf(r));
    expect(cases).toHaveLength(39);
    for (const c of cases.slice(0, 3)) expect([c.side, c.up, c.factor, c.heading]).toEqual([0, 0, 1, 0]);
    expect(cases.slice(0, 3).map((c) => c.name)).toEqual(['mid on the line', 'early on the line', 'late on the line']);
    for (const c of cases.slice(3, 15)) expect(c.side !== 0 && c.up !== 0 && c.factor !== 1 && c.heading !== 0, c.name).toBe(true);
    for (const c of cases.slice(15)) expect([c.side !== 0, c.up !== 0, c.factor !== 1, c.heading !== 0].filter(Boolean), c.name).toHaveLength(1);
  });
});

describe('round 2: a fixture older than the recordings flown in it (learn/fresh.ts)', () => {
  it('stale when a recording is newer than the fixture, and the line says so first; fresh when none is; unknown without a time', () => {
    const stale = fixtureFreshness('2026-01-01T00:00:00.000Z', ['2025-12-30T00:00:00.000Z', '2026-01-04T00:00:00.000Z']);
    expect(stale.stale).toBe(true);
    expect(stale.line).toMatch(/^WARNING: STALE FIXTURE: the fixture was exported 2026-01-01T00:00:00.000Z; the newest of 2 recordings is from 2026-01-04T00:00:00.000Z, 3\.0 days after it \(1 recording newer than the fixture\)/);
    const hours = fixtureFreshness('2026-01-01T00:00:00.000Z', ['2026-01-01T06:30:00.000Z']);
    expect(hours.line).toMatch(/6\.5 hours after it/);
    const fresh = fixtureFreshness('2026-01-05T00:00:00.000Z', ['2026-01-04T00:00:00.000Z']);
    expect(fresh.stale).toBe(false);
    expect(fresh.unknown).toBe(false);
    expect(fresh.line).toMatch(/the fixture is newer than every recording$/);
    for (const f of [fixtureFreshness(undefined, ['2026-01-04T00:00:00.000Z']), fixtureFreshness('2026-01-05T00:00:00.000Z', []), fixtureFreshness('2026-01-05T00:00:00.000Z', [undefined])]) {
      expect(f.stale).toBe(false);
      expect(f.unknown).toBe(true);
      expect(f.line).toMatch(/cannot be told$/);
    }
  });

  it('the export time is read from the fixture folder\'s extract; a folder without one has none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-fresh-'));
    try {
      expect(fixtureExportedAt(dir)).toBeUndefined();
      writeFileSync(join(dir, 'extract.json'), JSON.stringify({ format: 'x', exportedAt: '2026-01-05T00:00:00.000Z' }));
      expect(fixtureExportedAt(dir)).toBe('2026-01-05T00:00:00.000Z');
      writeFileSync(join(dir, 'extract.json'), '{ not json');
      expect(fixtureExportedAt(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
