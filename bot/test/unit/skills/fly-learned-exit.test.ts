// Track F9b (docs/flight.md "Learned exits (Track F9b)", decisions/0078-learned-exits.md): a recorded flight as the way
// out of a cave. Guarded here on synthetic worlds with synthetic recordings (nothing of anybody's world): a recording
// read into its flights (guide.ts), matched by where it left the ground and never by its name (match.ts), flown along
// its line by the follower and proven like every route takeoff (follow.ts, route/takeoff.ts, glide.ts routeTakeoff),
// refused when the world has changed since (the takeoff then goes on as it would without a recording), and nothing
// different at all without a recording.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETTING_DEFS } from '../../../src/config/settings.ts';
import type { Vec3 } from '../../../src/connection/types.ts';
import { LEARNED_PROOF_BURNS, LEARNED_PROOF_MIXES, routeTakeoff, routeTakeoffOptions, simulateFlight, type SimDeps } from '../../../src/skills/fly/glide.ts';
import { FOLLOW_MARGIN, FOLLOW_SPEED, GuideFollower, lineRoom } from '../../../src/skills/fly/learn/follow.ts';
import { guideHead, guideLength, guideNearest, guidePoint, guidesOf, guideTail } from '../../../src/skills/fly/learn/guide.ts';
import { matchEntries, matchExits, MATCH_NEAR, OUT_AFTER, type OpenSky } from '../../../src/skills/fly/learn/match.ts';
import type { LearnedPath, LearnSample } from '../../../src/skills/fly/learn/recorder.ts';
import { parsePath, PathStore } from '../../../src/skills/fly/learn/store.ts';
import { cruiseHeight, type CellQuery, type LandingTarget } from '../../../src/skills/fly/plan.ts';
import { gridOf } from '../../../src/skills/fly/route/grid.ts';
import { planRoute } from '../../../src/skills/fly/route/search.ts';
import { LEARNED_TRIES, planTakeoffRoute, type TakeoffProof, type TakeoffRoute } from '../../../src/skills/fly/route/takeoff.ts';
import { glideVelocity } from '../../../src/skills/input/physics.ts';
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
  const sky = (top: number): OpenSky => (x, y, z) => {
    for (let k = y + 1; k <= top; k++) if (grid.solid(x, k, z)) return false;
    return true;
  };
  return { world, deps, grid, skyTop, sky };
}

/** A cave under a mesa 46 high: a hall 17 x 17 and 20 high, and a passage 9 wide and 10 high from its west wall out to the open air (fly-cave-exit.test.ts's). */
const cave = (): BlockBox[] => [
  { from: { x: -40, y: FEET, z: -40 }, to: { x: 40, y: FEET + 45, z: 40 }, solid: true },
  { from: { x: -8, y: FEET, z: -8 }, to: { x: 8, y: FEET + 19, z: 8 }, solid: false },
  { from: { x: -40, y: FEET, z: -4 }, to: { x: -9, y: FEET + 9, z: 4 }, solid: false },
];
const START: Vec3 = { x: 4.5, y: FEET, z: 4.5 };
const target: LandingTarget = { x: 0.5, z: 600.5, top: FEET, half: 1 };

/**
 * A recording as `!learn` writes one: `still` samples standing at `from`, then one sample a tick along the corners `via`
 * at `speed` blocks a tick off the ground, a rocket `rocketMs` after the last sample on the ground, and (`land`) samples
 * standing at the last corner.
 */
function record(name: string, from: Vec3, via: Vec3[], o: { speed?: number; rocketMs?: number; land?: boolean; still?: number } = {}): LearnedPath {
  const samples: LearnSample[] = [];
  let t = 0;
  const yawOf = (a: Vec3, b: Vec3): number => (Math.atan2(-(b.x - a.x), b.z - a.z) * 180) / Math.PI;
  for (let i = 0; i < (o.still ?? 6); i++, t += 50) samples.push({ t, x: from.x, y: from.y, z: from.z, yaw: yawOf(from, via[0]!), pitch: 0, ground: true });
  const left = t - 50;
  const speed = o.speed ?? 1.5;
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

/** The flight out of the cave as somebody would record it: the jump, across the hall into the passage, along it rising a little, out of the mouth and up. */
const outLine = (from: Vec3 = START): Vec3[] => [
  { x: from.x, y: from.y + 1.2, z: from.z },
  { x: -6, y: FEET + 3, z: 0.5 },
  { x: -38, y: FEET + 5, z: 0.5 },
  { x: -50, y: FEET + 9, z: 0.5 },
  { x: -70, y: FEET + 24, z: 0.5 },
  { x: -85, y: FEET + 40, z: 0.5 },
];
const wayOut = (name = 'a recording', from: Vec3 = START): LearnedPath => record(name, from, outLine(from), { rocketMs: 400 });

function prover(r: ReturnType<typeof rig>, from: Vec3, cruiseY: number, count?: { sims: number }): TakeoffProof {
  return async (route: TakeoffRoute) => {
    const p = await routeTakeoff(r.deps, from, target, { cruiseY }, 64, { route: { grid: r.grid, plan: (req) => planRoute(req, r.grid), maxMs: SLOW }, takeoff: routeTakeoffOptions(route, true) }, { planTicks: route.ticks });
    if (count) count.sims += p.sims;
    return p;
  };
}

function fly(r: ReturnType<typeof rig>, from: Vec3, cruiseY: number, route: TakeoffRoute, burn?: number) {
  const notes: string[] = [];
  let off = 0;
  return simulateFlight(r.deps, from, target, { cruiseY, takeoffYaw: route.yaw, route: { grid: r.grid, plan: (req) => planRoute(req, r.grid), maxMs: SLOW }, routeTakeoff: routeTakeoffOptions(route, true), note: (m) => notes.push(m) }, {
    rockets: 64,
    yaw: route.yaw,
    maxTicks: 300 + route.ticks,
    until: (b, body) => {
      if (route.guide && b.phase === 'takeoff' && body.gliding) off = Math.max(off, guideNearest(route.guide.line, body.pos).dist);
      return b.phase === 'approach';
    },
    ...(burn !== undefined ? { burn } : {}),
  }).then((sim) => ({ sim, notes, off }));
}

describe('a recording read into its flights (Track F9b, learn/guide.ts)', () => {
  it('one flight from the last sample on the ground: points a block apart, the time each was passed, the rocket where it was fired', () => {
    const g = guidesOf(wayOut());
    expect(g).toHaveLength(1);
    const line = g[0]!;
    expect(line.grounded).toBe(true);
    expect(line.landed).toBe(false);
    expect(line.points[0]).toEqual(START);
    // (a block along the recording between two points: a block apart on its straights, a little nearer round a corner)
    let straight = 0;
    for (let i = 1; i < line.points.length - 1; i++) {
      const d = Math.hypot(line.points[i]!.x - line.points[i - 1]!.x, line.points[i]!.y - line.points[i - 1]!.y, line.points[i]!.z - line.points[i - 1]!.z);
      expect(d).toBeLessThanOrEqual(1 + 1e-6);
      expect(d).toBeGreaterThan(0.6);
      if (Math.abs(d - 1) < 1e-6) straight++;
    }
    expect(straight).toBeGreaterThan(line.points.length - 10);
    expect(guideLength(line)).toBeGreaterThan(100);
    expect(line.ticks[0]).toBe(0);
    for (let i = 1; i < line.ticks.length; i++) expect(line.ticks[i]!).toBeGreaterThanOrEqual(line.ticks[i - 1]!);
    expect(line.rockets).toHaveLength(1);
    expect(line.rockets[0]!.tick).toBe(8);
    expect(line.rockets[0]!.at).toBeLessThan(12);
    // the place of a point beside the line, and the line's point and direction along it
    const near = guideNearest(line, { x: -20, y: FEET + 4.5, z: 2.5 });
    expect(near.dist).toBeGreaterThan(1.9);
    expect(near.dist).toBeLessThan(2.2);
    const p = guidePoint(line, near.at);
    expect(p.pos.x).toBeCloseTo(-20, 0);
    expect(p.dir.x).toBeLessThan(-0.9);
    // a head and a tail keep the line's points and the rockets fired on their part
    expect(guideHead(line, 30).points).toHaveLength(30);
    expect(guideHead(line, 30).rockets).toHaveLength(1);
    expect(guideTail(line, 30).points).toHaveLength(line.points.length - 30);
    expect(guideTail(line, 30).rockets).toHaveLength(0);
    expect(guideTail(line, 30).grounded).toBe(false);
  });

  it('a hop is no flight; a gap ends a flight (nothing is drawn through what was not seen); a sample no speed explains is dropped', () => {
    const hop = record('hop', START, [{ x: START.x, y: START.y + 1.2, z: START.z }, { x: START.x - 3, y: START.y, z: START.z }], { land: true });
    expect(guidesOf(hop)).toHaveLength(0);
    const p = wayOut();
    // a gap of 3 s in the middle: two flights, the second not from the ground
    const cut = Math.floor(p.samples.length / 2);
    const gapped: LearnedPath = { ...p, samples: p.samples.map((s, i) => (i >= cut ? { ...s, t: s.t + 3000 } : s)), gaps: [{ from: p.samples[cut - 1]!.t, to: p.samples[cut]!.t + 3000 }] };
    const two = guidesOf(gapped);
    expect(two).toHaveLength(2);
    expect(two[0]!.grounded).toBe(true);
    expect(two[1]!.grounded).toBe(false);
    expect(guideLength(two[0]!) + guideLength(two[1]!)).toBeLessThan(guideLength(guidesOf(p)[0]!));
    // somebody who stood still for three seconds before the jump (a standing player sends nothing): the takeoff is still
    // where they stood, and the rocket is counted from the jump, not from the last time they moved
    const still: LearnedPath = { ...p, samples: p.samples.map((s) => (s.ground ? { ...s, t: s.t - 3000 } : s)) };
    const stood = guidesOf(still);
    expect(stood).toHaveLength(1);
    expect(stood[0]!.grounded).toBe(true);
    expect(stood[0]!.points[0]).toEqual(START);
    expect(stood[0]!.rockets[0]!.tick).toBe(guidesOf(p)[0]!.rockets[0]!.tick);
    // one sample thrown 300 blocks away and back: the line is as it was
    const k = cut + 3;
    const jumped: LearnedPath = { ...p, samples: p.samples.map((s, i) => (i === k ? { ...s, x: s.x + 300 } : s)) };
    const one = guidesOf(jumped);
    expect(one).toHaveLength(1);
    expect(Math.abs(guideLength(one[0]!) - guideLength(guidesOf(p)[0]!))).toBeLessThan(0.5);
  });

  it('the store reads a folder of recordings, skips what is not one, and reads a changed file again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-paths-'));
    try {
      const store = new PathStore(dir);
      expect(store.all()).toEqual([]);
      writeFileSync(join(dir, 'one.json'), JSON.stringify(wayOut('one')));
      writeFileSync(join(dir, 'broken.json'), '{ not json');
      writeFileSync(join(dir, 'other.json'), JSON.stringify({ version: 2, name: 'x', samples: [] }));
      writeFileSync(join(dir, 'notes.txt'), 'not a path');
      expect(store.all().map((p) => p.name)).toEqual(['one']);
      expect(store.all()[0]).toBe(store.all()[0]); // read once
      writeFileSync(join(dir, 'one.json'), JSON.stringify(record('one again', START, outLine(), { rocketMs: 400, still: 9 })));
      expect(store.all().map((p) => p.name)).toEqual(['one again']);
      expect(new PathStore(join(dir, 'nowhere')).all()).toEqual([]);
      expect(new PathStore(undefined).all()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(parsePath({ version: 1, name: 'n', samples: [{ t: 0, x: 0, y: 0, z: 0 }, { t: 50, x: 1, y: 0, z: 'far' }] })).toBeUndefined();
    expect(parsePath({ version: 1, name: 'n', samples: [{ t: 0, x: 0, y: 0, z: 0 }, { t: 50, x: 1, y: 0, z: 0, ground: true }] })?.samples[1]).toEqual({ t: 50, x: 1, y: 0, z: 0, yaw: 0, pitch: 0, ground: true });
  });
});

describe('a recorded flight matched by where it left the ground (Track F9b, learn/match.ts)', () => {
  it('a way out is matched from its start and not from elsewhere, whatever the recording is called', () => {
    const r = rig(cave());
    const sky = r.sky(120);
    const paths = [wayOut('zz-holiday')];
    const here = matchExits(paths, START, sky);
    expect(here.flights).toBe(1);
    expect(here.near).toBe(1);
    expect(here.matches).toHaveLength(1);
    const m = here.matches[0]!;
    expect(m.off).toBeLessThan(0.01);
    expect(m.guide.path).toBe('zz-holiday');
    // out under open sky where the line leaves the mesa (x -41), the line kept OUT_AFTER beyond
    const out = guidePoint(m.guide, m.open).pos;
    expect(out.x).toBeLessThan(-40);
    expect(out.x).toBeGreaterThan(-43);
    expect(guideLength(m.guide)).toBeGreaterThanOrEqual(m.open + OUT_AFTER - 1);
    expect(guideLength(m.guide)).toBeLessThanOrEqual(m.open + OUT_AFTER + 1);
    // two blocks beside the start and a block over it: the same way out; the far corner of the hall: not
    expect(matchExits(paths, { x: START.x + 2, y: START.y + 1, z: START.z - 2 }, sky).matches).toHaveLength(1);
    const far = matchExits(paths, { x: START.x - 11, y: START.y, z: START.z - 11 }, sky);
    expect(far.near).toBe(0);
    expect(far.matches).toHaveLength(0);
    expect(matchExits(paths, { x: START.x, y: START.y + MATCH_NEAR + 1, z: START.z }, sky).matches).toHaveLength(0);
  });

  it('a flight that never comes out, one that begins under open sky and one that begins in the air are no ways out', () => {
    const r = rig(cave());
    const sky = r.sky(120);
    // round the hall and back down: under the roof all the way
    const inside = record('inside', START, [{ x: 4.5, y: FEET + 1.2, z: 4.5 }, { x: -5, y: FEET + 6, z: 4.5 }, { x: -5, y: FEET + 6, z: -5 }, { x: 5, y: FEET + 3, z: -5 }], { rocketMs: 400 });
    const got = matchExits([inside], START, sky);
    expect(got.near).toBe(1);
    expect(got.matches).toHaveLength(0);
    // from the open ground west of the mesa
    const open = { x: -60.5, y: FEET, z: 0.5 };
    const outside = record('outside', open, [{ x: -60.5, y: FEET + 1.2, z: 0.5 }, { x: -90, y: FEET + 20, z: 0.5 }], { rocketMs: 400 });
    expect(matchExits([outside], open, sky).matches).toHaveLength(0);
    // the same way out with its first second out of view: it did not leave the ground where anybody stands
    const p = wayOut();
    const late: LearnedPath = { ...p, samples: p.samples.slice(20) };
    expect(guidesOf(late)[0]!.grounded).toBe(false);
    expect(matchExits([late], START, sky).matches).toHaveLength(0);
  });

  it('several takes of one line are several matches, the nearest takeoff first', () => {
    const r = rig(cave());
    const a = wayOut('take b', { x: START.x + 1, y: START.y, z: START.z + 1 });
    const b = wayOut('take a', START);
    const c = wayOut('take c', { x: START.x - 2, y: START.y, z: START.z + 2 });
    const got = matchExits([a, b, c], START, r.sky(120));
    expect(got.matches.map((m) => m.guide.path)).toEqual(['take a', 'take b', 'take c']);
  });

  it('a way in: a flight that came from under open sky and stood again under a roof is matched at its touchdown (for the track that flies it)', () => {
    const r = rig(cave());
    const sky = r.sky(120);
    const from = { x: -90.5, y: FEET, z: 0.5 };
    const inLine = record('in', from, [{ x: -90.5, y: FEET + 1.2, z: 0.5 }, { x: -70, y: FEET + 14, z: 0.5 }, { x: -45, y: FEET + 6, z: 0.5 }, { x: -9, y: FEET + 3, z: 0.5 }, { x: 3.5, y: FEET, z: 3.5 }], { rocketMs: 400, land: true });
    const g = guidesOf(inLine);
    expect(g).toHaveLength(1);
    expect(g[0]!.landed).toBe(true);
    const got = matchEntries([inLine, wayOut()], { x: 4.5, y: FEET, z: 4.5 }, sky);
    expect(got.matches).toHaveLength(1);
    const m = got.matches[0]!;
    expect(m.off).toBeLessThan(2);
    // the line from before the mouth to the touchdown: its last open sky just outside the mesa
    const last = guidePoint(m.guide, m.open).pos;
    expect(last.x).toBeLessThan(-40);
    expect(last.x).toBeGreaterThan(-43);
    const end = m.guide.points[m.guide.points.length - 1]!;
    expect(Math.hypot(end.x - 3.5, end.z - 3.5)).toBeLessThan(0.01);
    expect(m.guide.landed).toBe(true);
    // not for a goal elsewhere, and a landing in the open is no way in
    expect(matchEntries([inLine], { x: -5.5, y: FEET, z: -5.5 }, sky).matches).toHaveLength(0);
    const outside = record('out', START, [...outLine(), { x: -95, y: FEET, z: 0.5 }], { rocketMs: 400, land: true });
    expect(matchEntries([outside], { x: -95, y: FEET, z: 0.5 }, sky).matches).toHaveLength(0);
  });
});

describe('the follower flies a line (Track F9b, learn/follow.ts)', () => {
  it('in open air: the jump, the rocket when the recording fired it and not before, the line held, done at its end', () => {
    const from = { x: 0.5, y: FEET, z: 0.5 };
    const g = guidesOf(record('line', from, [{ x: 0.5, y: FEET + 1.2, z: 0.5 }, { x: 0.5, y: FEET + 12, z: 60 }, { x: 20, y: FEET + 20, z: 90 }], { rocketMs: 500 }))[0]!;
    const grid = gridOf(flatWorld());
    const f = new GuideFollower({ grid, guide: g });
    // a body on the glide formula (no collisions: open air)
    let pos = { ...from };
    let vel = { x: 0, y: 0, z: 0 };
    let gliding = false;
    let onGround = true;
    let boost = 0;
    let firedAt = -1;
    let status = '';
    let worst = 0;
    for (let t = 1; t <= 200 && status !== 'done' && status !== 'lost'; t++) {
      const out = f.tick({ pos, vel, gliding, onGround, boostTicks: boost, rockets: 8 }, t);
      status = out.status;
      if (gliding) worst = Math.max(worst, out.error);
      if (out.control.jump && onGround) {
        vel = { x: 0, y: 0.42, z: 0 };
        onGround = false;
      } else if (!onGround && !gliding) {
        vel = { x: 0, y: (vel.y - 0.08) * 0.98, z: 0 };
        if (t >= 3) gliding = true;
      } else if (gliding) {
        if (out.control.fire && boost === 0) {
          boost = 15;
          if (firedAt < 0) firedAt = t;
        }
        vel = glideVelocity(vel, out.control.yaw, out.control.pitch, boost > 0);
        if (boost > 0) boost--;
      }
      pos = { x: pos.x + vel.x, y: pos.y + vel.y, z: pos.z + vel.z };
    }
    expect(status).toBe('done');
    // the recording's rocket came 10 ticks after it left the ground: the follower's the same (the jump is tick 1)
    expect(firedAt).toBeGreaterThanOrEqual(10);
    expect(firedAt).toBeLessThanOrEqual(12);
    expect(worst).toBeLessThan(2);
    expect(f.stats.maxError).toBe(worst);
    expect(f.place).toBeGreaterThan(guideLength(g) - 1);
  });

  it('a body that never glides, and one carried off the line, have lost it', () => {
    const from = { x: 0.5, y: FEET, z: 0.5 };
    const g = guidesOf(record('line', from, [{ x: 0.5, y: FEET + 1.2, z: 0.5 }, { x: 0.5, y: FEET + 12, z: 60 }], { rocketMs: 500 }))[0]!;
    const grid = gridOf(flatWorld());
    const stuck = new GuideFollower({ grid, guide: g });
    let s = '';
    let why: string | undefined;
    for (let t = 1; t <= 60 && s !== 'lost'; t++) ({ status: s, why } = stuck.tick({ pos: from, vel: { x: 0, y: 0, z: 0 }, gliding: false, onGround: true, boostTicks: 0, rockets: 8 }, t));
    expect(s).toBe('lost');
    expect(why).toMatch(/no glide/);
    const off = new GuideFollower({ grid, guide: g });
    s = '';
    for (let t = 1; t <= 20 && s !== 'lost'; t++) ({ status: s, why } = off.tick({ pos: { x: 12.5, y: FEET + 6, z: 20 }, vel: { x: 0, y: 0, z: 1.2 }, gliding: true, onGround: false, boostTicks: 0, rockets: 8 }, t));
    expect(s).toBe('lost');
    expect(why).toMatch(/off the line/);
  });

  it('a slow body with line ahead asks for another rocket; a fast one does not', () => {
    const from = { x: 0.5, y: FEET, z: 0.5 };
    const g = guidesOf(record('line', from, [{ x: 0.5, y: FEET + 1.2, z: 0.5 }, { x: 0.5, y: FEET + 12, z: 80 }], { rocketMs: 500 }))[0]!;
    const grid = gridOf(flatWorld());
    const at = { x: 0.5, y: FEET + 6, z: 30 };
    for (const [speed, want] of [[FOLLOW_SPEED - 0.2, true], [FOLLOW_SPEED + 0.3, false]] as const) {
      const f = new GuideFollower({ grid, guide: g });
      // (a rocket seen burning first, past the place of the recorded one: the takeoff's)
      f.tick({ pos: { x: 0.5, y: FEET + 3, z: 20 }, vel: { x: 0, y: 0.1, z: 1.5 }, gliding: true, onGround: false, boostTicks: 9, rockets: 8 }, 1);
      const out = f.tick({ pos: at, vel: { x: 0, y: 0.1, z: speed }, gliding: true, onGround: false, boostTicks: 0, rockets: 8 }, 2);
      expect(out.control.fire, `speed ${speed}`).toBe(want);
    }
  });
});

describe('the takeoff along a recorded line (Track F9b, route/takeoff.ts learned, glide.ts routeTakeoff)', () => {
  it('a recorded way out is proven at every burn from 9 to 21 and at two mixes of them, and flown out of the cave with no hit, on one or two rockets, the two phases kept', async () => {
    const r = rig(cave());
    const cz = cruiseHeight(START, target, r.skyTop, {});
    const learned = matchExits([wayOut('the way out')], START, r.sky(Math.ceil(cz.y)));
    const count = { sims: 0 };
    const t0 = performance.now();
    const got = await planTakeoffRoute(r.grid, START, target, { rockets: 4, maxMs: SLOW, prove: prover(r, START, cz.y, count), learned });
    // (the decision's time on this machine, for the docs: `vitest run ... --silent=false` shows it)
    console.log(`learned takeoff decision (the synthetic cave): ${(performance.now() - t0).toFixed(0)} ms, ${count.sims} simulations`);
    const said = got.tried.join('; ');
    expect(got.route, said).toBeDefined();
    expect(got.learned).toBe(1);
    expect(got.route!.guide, said).toBeDefined();
    expect(got.route!.proven, said).toBe(true);
    expect(got.route!.goals).toHaveLength(0);
    // one line for the decision: which recording, how far its takeoff lay, what its proof said; and no search at all
    expect(got.tried).toHaveLength(1);
    expect(said).toMatch(/^the learned way out along the way out \(it left the ground 0\.0 from here, \d+ blocks to open sky in \d+ ticks, 1 rocket, its line 1 or more from the nearest block\): clear at burns of 15, 9, 21, 12, 18, 10, 11, 13, 14, 16, 17, 19, 20 ticks and of 21 then 9, 9 then 21 \(through the exit/);
    expect(count.sims).toBe(1 + LEARNED_PROOF_BURNS.length + LEARNED_PROOF_MIXES.length);
    for (const burn of [undefined, 9, 12, 18, 21]) {
      const { sim, notes, off } = await fly(r, START, cz.y, got.route!, burn);
      const line = `burn ${burn ?? 15}: ${sim.end ? (sim.end.ok ? 'ok' : sim.end.reason) : sim.phase}, ${sim.hits} hits at ${sim.body.pos.x.toFixed(0)} ${sim.body.pos.y.toFixed(0)} ${sim.body.pos.z.toFixed(0)}, ${off.toFixed(2)} off: ${notes.join(' | ')}`;
      expect(sim.stats.routeTakeoffEnd, line).toBe('out');
      expect(sim.hits, line).toBe(0);
      expect(sim.end, line).toBeUndefined();
      expect(Math.abs(sim.body.pos.x) > 40 || Math.abs(sim.body.pos.z) > 40 || sim.body.pos.y > FEET + 46, line).toBe(true);
      // along the recording: never far from its line under the roof, out on one or two rockets
      expect(off, line).toBeLessThan(2);
      expect(sim.stats.routeTakeoffRockets, line).toBeGreaterThanOrEqual(1);
      expect(sim.stats.routeTakeoffRockets, line).toBeLessThanOrEqual(2);
      // first out, then to the goal: open sky over the body no sooner than the hand-over, the heading to the goal's after it
      expect(sim.stats.routeSkyAt, line).toBeGreaterThanOrEqual(sim.stats.routeTakeoffTicks!);
      expect(sim.stats.routeHeadingAt ?? Infinity, line).toBeGreaterThanOrEqual(sim.stats.routeSkyAt!);
      expect(notes.some((n) => n.includes('out along the learned line the way out')), line).toBe(true);
    }
  }, 120_000);

  it('a recording that left the ground two blocks beside the start is the same way out; the nearest take is tried first and the first proven wins', async () => {
    const r = rig(cave());
    const cz = cruiseHeight(START, target, r.skyTop, {});
    // (two takes of one line, one begun half a block from the start and one two blocks from it)
    const beside = { x: START.x + 1.5, y: START.y, z: START.z + 1.5 };
    const learned = matchExits([wayOut('farther', beside), wayOut('nearer', { x: START.x + 0.5, y: START.y, z: START.z })], START, r.sky(Math.ceil(cz.y)));
    expect(learned.matches.map((m) => m.guide.path)).toEqual(['nearer', 'farther']);
    const got = await planTakeoffRoute(r.grid, START, target, { rockets: 4, maxMs: SLOW, prove: prover(r, START, cz.y), learned });
    expect(got.route?.guide?.line.path, got.tried.join('; ')).toBe('nearer');
    expect(got.learned).toBe(1);
    const far = await planTakeoffRoute(r.grid, START, target, { rockets: 4, maxMs: SLOW, prove: prover(r, START, cz.y), learned: { matches: learned.matches.slice(1) } });
    expect(far.route?.guide?.line.path, far.tried.join('; ')).toBe('farther');
    const { sim, notes } = await fly(r, START, cz.y, far.route!, 9);
    expect(sim.hits, notes.join(' | ')).toBe(0);
    expect(sim.stats.routeTakeoffEnd, notes.join(' | ')).toBe('out');
  }, 120_000);

  it('a take whose own line grazes a block is tried after one that keeps its berth, though it began nearer', async () => {
    // a post in the hall, and the nearer take recorded past it at a fifth of a block (somebody who knows the cave); the other
    // take begins 3 blocks off and passes the post a block and a half away
    const post: BlockBox = { from: { x: 0, y: FEET, z: 2 }, to: { x: 0, y: FEET + 4, z: 2 }, solid: true };
    const r = rig([...cave(), post]);
    const cz = cruiseHeight(START, target, r.skyTop, {});
    const grazing = record('grazing', START, [{ x: START.x, y: START.y + 1.2, z: START.z }, { x: 1.5, y: FEET + 2, z: 3.5 }, { x: -0.5, y: FEET + 2, z: 3.5 }, ...outLine().slice(1)], { rocketMs: 400 });
    const roomy = wayOut('roomy', { x: START.x, y: START.y, z: START.z + 3 });
    const learned = matchExits([grazing, roomy], START, r.sky(Math.ceil(cz.y)));
    expect(learned.matches.map((m) => m.guide.path)).toEqual(['grazing', 'roomy']);
    const room = learned.matches.map((m) => lineRoom(r.grid, m.guide, m.open));
    expect(room[0]!).toBeGreaterThan(0.1);
    expect(room[0]!).toBeLessThan(FOLLOW_MARGIN);
    expect(room[1]!).toBeGreaterThanOrEqual(FOLLOW_MARGIN);
    const asked: string[] = [];
    const never: TakeoffProof = (route) => {
      if (route.guide) asked.push(route.guide.line.path);
      return Promise.resolve({ ok: false, line: 'refused here' });
    };
    const got = await planTakeoffRoute(r.grid, START, target, { rockets: 4, maxMs: SLOW, prove: never, learned });
    expect(asked).toEqual(['roomy', 'grazing']);
    expect(got.tried[0]).toMatch(/^the learned way out along roomy \(it left the ground 3\.0 from here, .* its line (1 or more|0\.\d\d) from the nearest block\): refused here: refused$/);
    expect(got.tried[1]).toMatch(/^the learned way out along grazing \(it left the ground 0\.0 from here, .* its line 0\.[12]\d from the nearest block\)/);
  }, 120_000);

  it('the world changed since the recording (the passage walled up): the proof refuses the line in one line and the takeoff goes on as without a recording', async () => {
    const wall: BlockBox = { from: { x: -26, y: FEET, z: -4 }, to: { x: -25, y: FEET + 9, z: 4 }, solid: true };
    const r = rig([...cave(), wall]);
    const cz = cruiseHeight(START, target, r.skyTop, {});
    // (the recording is of the cave as it was: matched against the world of then)
    const then = rig(cave());
    const learned = matchExits([wayOut('before the wall')], START, then.sky(Math.ceil(cz.y)));
    expect(learned.matches).toHaveLength(1);
    const got = await planTakeoffRoute(r.grid, START, target, { rockets: 4, maxMs: SLOW, prove: prover(r, START, cz.y), learned });
    expect(got.route, got.tried.join('; ')).toBeUndefined();
    expect(got.learned).toBe(1);
    // (the follower meets no wall: it gets no farther along the line, which is the line lost)
    expect(got.tried[0]).toMatch(/^the learned way out along before the wall .*: the way out ended off the line: refused$/);
    // what follows is the takeoff without a recording, line for line (the hall's exits, each refused)
    const plain = await planTakeoffRoute(r.grid, START, target, { rockets: 4, maxMs: SLOW, prove: prover(r, START, cz.y) });
    const strip = (t: string): string => t.replace(/, \d+ ms/g, '');
    expect(got.tried.slice(1).map(strip)).toEqual(plain.tried.map(strip));
    expect(got.tried.length).toBeGreaterThan(1);
    // flown all the same (a wall that came between the proof and the flight), it does not fly into it: no look clears the wall
    // six ticks ahead, so no second rocket goes, the body brakes to a stop short of the wall and lands under the roof; it
    // never climbs blind
    const route = { ...(await planTakeoffRoute(then.grid, START, target, { rockets: 4, maxMs: SLOW, prove: prover(then, START, cz.y), learned })).route! };
    const { sim, notes } = await fly(r, START, cz.y, route);
    const line = `${sim.end ? (sim.end.ok ? 'ok' : sim.end.reason) : sim.phase}, ${sim.hits} hits: ${notes.join(' | ')}`;
    expect(sim.stats.routeTakeoffEnd, line).toBe('off the line');
    expect(sim.stats.routeTakeoffRockets, line).toBe(1);
    expect(sim.stats.routeSkyAt, line).toBeUndefined();
    expect(sim.end && !sim.end.ok ? sim.end.reason : undefined, line).toBe('roof');
    expect(notes.some((n) => /the learned line before the wall lost after \d+ ticks \(no look clears the solid ahead \d+ blocks along the line \(braked to 0\.[012]\d a tick\)/.test(n)), line).toBe(true);
    expect(sim.body.pos.x, line).toBeGreaterThan(-24);
    // (what the forced landing touches at a walk's pace beside the wall is counted as hits by the simulation: a few, not the
    // 42 of a body held against the wall by its rockets, which is what the follower did before it knew a crash from a graze)
    expect(sim.hits, line).toBeLessThan(12);
  }, 120_000);

  it('a pillar on the line: the follower steers round it, and the takeoff is still proven with no hit', async () => {
    const pillar: BlockBox = { from: { x: -22, y: FEET, z: 0 }, to: { x: -22, y: FEET + 9, z: 0 }, solid: true };
    const r = rig([...cave(), pillar]);
    const cz = cruiseHeight(START, target, r.skyTop, {});
    const learned = matchExits([wayOut('round the pillar')], START, r.sky(Math.ceil(cz.y)));
    const got = await planTakeoffRoute(r.grid, START, target, { rockets: 4, maxMs: SLOW, prove: prover(r, START, cz.y), learned });
    expect(got.route?.guide, got.tried.join('; ')).toBeDefined();
    for (const burn of [9, 21]) {
      const { sim, notes } = await fly(r, START, cz.y, got.route!, burn);
      const line = `burn ${burn}: ${sim.hits} hits: ${notes.join(' | ')}`;
      expect(sim.hits, line).toBe(0);
      expect(sim.stats.routeTakeoffEnd, line).toBe('out');
      expect(notes.find((n) => n.includes('out along the learned line')), line).toMatch(/steered [1-9]\d* ticks/);
    }
  }, 120_000);

  it('nothing learned is taken unproven, at most LEARNED_TRIES takes are proven, and without a recording nothing changes', async () => {
    const r = rig(cave());
    const cz = cruiseHeight(START, target, r.skyTop, {});
    const learned = matchExits([wayOut()], START, r.sky(Math.ceil(cz.y)));
    // no proof asked for (Track F3's unproven first plan): the recording is not used at all
    const unproven = await planTakeoffRoute(r.grid, START, target, { rockets: 4, maxMs: SLOW, learned });
    expect(unproven.route?.guide).toBeUndefined();
    expect(unproven.learned).toBeUndefined();
    // five takes whose proofs all refuse: three are tried
    let asked = 0;
    const never: TakeoffProof = (route) => {
      if (route.guide) asked++;
      return Promise.resolve({ ok: false, line: 'refused here' });
    };
    const five = matchExits([0, 1, 2, 3, 4].map((i) => wayOut(`take ${i}`, { x: START.x + i * 0.3, y: START.y, z: START.z })), START, r.sky(Math.ceil(cz.y)));
    expect(five.matches).toHaveLength(5);
    const refused = await planTakeoffRoute(r.grid, START, target, { rockets: 4, maxMs: SLOW, prove: never, learned: five });
    expect(asked).toBe(LEARNED_TRIES);
    expect(refused.learned).toBe(LEARNED_TRIES);
    expect(refused.route).toBeUndefined();
    // no recording that matches: the same lines as with no recordings at all
    const none = await planTakeoffRoute(r.grid, START, target, { rockets: 4, maxMs: SLOW, prove: prover(r, START, cz.y), learned: { matches: [] } });
    const plain = await planTakeoffRoute(r.grid, START, target, { rockets: 4, maxMs: SLOW, prove: prover(r, START, cz.y) });
    const strip = (t: string): string => t.replace(/, \d+ ms/g, '');
    expect(none.tried.map(strip)).toEqual(plain.tried.map(strip));
    expect(none.route).toBeUndefined();
    expect(plain.route).toBeUndefined();
    // and the switch is off unless somebody turns it on
    expect(SETTING_DEFS.flyLearned.default).toBe(false);
  }, 120_000);

  it("the proof's simulation: every rocket its own burn, and a burn's end seen late costs the climb a rocket's start each time", async () => {
    const r = rig(cave());
    const cz = cruiseHeight(START, target, r.skyTop, {});
    const route = (await planTakeoffRoute(r.grid, START, target, { rockets: 4, maxMs: SLOW, prove: prover(r, START, cz.y), learned: matchExits([wayOut()], START, r.sky(Math.ceil(cz.y))) })).route!;
    // the rockets' burns as the simulation was told them, in the order they were fired
    const fly = async (burn: number | ((rocket: number) => number), endLag: number) => {
      const fired: number[] = [];
      let last = 0;
      const sim = await simulateFlight(r.deps, START, target, { cruiseY: cz.y + 60, takeoffYaw: route.yaw, route: { grid: r.grid, plan: (req) => planRoute(req, r.grid) }, routeTakeoff: routeTakeoffOptions(route, true) }, {
        rockets: 64,
        yaw: route.yaw,
        maxTicks: 150,
        burn,
        endLag,
        until: (b, body) => {
          if (b.stats.rockets > last) fired.push(body.boostTicks ?? 0);
          last = b.stats.rockets;
          return false;
        },
      });
      return { sim, fired };
    };
    // a first rocket of 21 ticks and 9 for the later ones (the body's boost counts one tick down on the tick the rocket goes)
    const mixed = await fly((rocket) => (rocket === 0 ? 21 : 9), 0);
    expect(mixed.fired[0]).toBe(20);
    expect(mixed.fired.length).toBeGreaterThan(2);
    for (const b of mixed.fired.slice(1)) expect(b).toBe(8);
    // seen two ticks late, each burn's end leaves a gap before the next rocket: fewer rockets in the same ticks and less height
    const prompt = await fly(9, 0);
    const late = await fly(9, 2);
    expect(late.sim.stats.rockets).toBeLessThan(prompt.sim.stats.rockets);
    expect(late.sim.body.pos.y).toBeLessThan(prompt.sim.body.pos.y);
    expect(late.sim.hits).toBe(0);
  }, 120_000);
});
