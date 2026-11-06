// Flight v2, Track F1 (docs/flight.md "Manoeuvres (flight v2, Track F1)", decisions/0057): the brake /
// elevator landing, offline on synthetic worlds and the physics engine (stepBody). The precision goals of
// findLanding (a 1 x 1 pillar top, the floors of a 2 x 2 and a 1 x 1 shaft 10 deep, a cell under a roof 3
// and 4 above, the owner's farm), whole trips of the brain onto each (two seeds), the family `auto` picks,
// the go-arounds the brake saves (stop and re-aim), and the flare's landings unchanged on plain platforms.
import { describe, expect, it } from 'vitest';
import { BRAKE_BIAS, BRAKE_FAMILY, BRAKE_START, BrakePlanner, simulateBrake, type BrakeProfile } from '../../../src/skills/fly/brake.ts';
import { findLanding, PRECISE_HEADROOM, stillLandable, type LandingOptions, type LandingPlan } from '../../../src/skills/fly/landing.ts';
import { columnKey, entryTop, onTarget, touchdownCost, type LandingTarget } from '../../../src/skills/fly/plan.ts';
import type { BlockBox } from '../../../src/skills/input/index.ts';
import { flyTrip } from './fly-trip.ts';
import { FEET, farm, trip, world } from './fly-worlds.ts';

const OPTS: LandingOptions = { radius: 48, headroom: 4, maxUnder: 12, probes: 16, budgetMs: 60_000, exact: 1, style: 'auto' };
const T = 300;
const RIM = FEET + 10;
const P = FEET + 20;

/** A hollow tower on the flat ground: a w x w shaft 10 deep (its floor the ground, the rim 10 up). */
const tower = (w: number): BlockBox[] => [
  { from: { x: -3, y: FEET, z: T - 3 }, to: { x: 2 + w, y: RIM - 1, z: T + 2 + w }, solid: true },
  { from: { x: 0, y: FEET, z: T }, to: { x: w - 1, y: RIM - 1, z: T + w - 1 }, solid: false },
];
/** A 9 x 9 platform 20 up with a roof `r` above over its far two thirds (z from T - 2): the goal (0, T) under it. */
const roofed = (r: number): BlockBox[] => [
  { from: { x: -4, y: P - 1, z: T - 4 }, to: { x: 4, y: P - 1, z: T + 4 }, solid: true },
  { from: { x: -4, y: P + r, z: T - 2 }, to: { x: 4, y: P + r, z: T + 4 }, solid: true },
];
const CASES: { name: string; boxes: BlockBox[]; goal: { x: number; y: number; z: number } }[] = [
  { name: 'a 1 x 1 pillar 8 high', boxes: [{ from: { x: 0, y: FEET, z: T }, to: { x: 0, y: FEET + 7, z: T }, solid: true }], goal: { x: 0, y: FEET + 8, z: T } },
  { name: 'a 2 x 2 shaft 10 deep', boxes: tower(2), goal: { x: 0, y: FEET, z: T } },
  { name: 'a 1 x 1 shaft 10 deep', boxes: tower(1), goal: { x: 0, y: FEET, z: T } },
  { name: 'a roof 3 above', boxes: roofed(3), goal: { x: 0, y: P, z: T } },
  { name: 'a roof 4 above', boxes: roofed(4), goal: { x: 0, y: P, z: T } },
];

async function landingOf(boxes: BlockBox[], goal: { x: number; y: number; z: number }, o: Partial<LandingOptions> = {}): Promise<{ w: ReturnType<typeof world>; plan: LandingPlan }> {
  const w = world(boxes);
  const plan = await findLanding(goal, 'goal', { look: w.look, obstacle: (x, y, z) => w.solid.solidAt(x, y, z) === true, probe: () => Promise.resolve({ status: 'found', blocks: 3 }) }, { ...OPTS, ...o });
  return { w, plan };
}

/** A whole trip from 300 blocks south onto the case's precision goal: on the cell, nearly still, soft, no hit, no go-around. */
function expectBrakeLanding(name: string, w: ReturnType<typeof world>, target: LandingTarget, o: { landStyle?: 'auto' | 'brake'; start?: { x: number; y: number; z: number }; maxH?: number } = {}) {
  const lines: string[] = [];
  for (const seed of [5, 11]) {
    const r = trip(w, o.start ?? { x: 0.5, y: FEET, z: 0.5 }, target, { seed, ...(o.landStyle ? { landStyle: o.landStyle } : {}) });
    const line = `${name} seed ${seed}: ${r.end.ok ? 'ok' : r.end.reason} at ${r.body.pos.x.toFixed(2)} ${r.body.pos.y.toFixed(2)} ${r.body.pos.z.toFixed(2)}, ${r.end.off.toFixed(2)} off, touchdown vy ${r.lastAir.vy.toFixed(2)} h ${r.lastAir.h.toFixed(2)}, ${r.ticks} ticks, ${r.rockets} rockets, ${r.goArounds} go-arounds, ${r.stats.landStyle} (${r.stats.brakeTicks} in K), hits ${r.hits}`;
    lines.push(line);
    expect(r.end.ok, line).toBe(true);
    expect(r.stats.landStyle, line).toBe('brake');
    expect(onTarget(target, r.body.pos), line).toBe(true);
    expect(r.body.pos.y, line).toBeCloseTo(target.top, 3);
    expect(r.hits, line).toBe(0);
    expect(r.goArounds, line).toBe(0);
    expect(r.lastAir.vy, line).toBeGreaterThan(-0.36);
    expect(r.lastAir.h, line).toBeLessThanOrEqual(o.maxH ?? 0.15);
  }
  return lines;
}

describe('fly: the brake / elevator landing family (flight v2, Track F1)', () => {
  it('the family: A1, A2, then K (brake, station keeping, elevator); in K only the two pitches are free; from the approach entry the first plan lands on the 1 x 1 pillar', () => {
    expect([...BRAKE_FAMILY.free(BRAKE_START)].sort()).toEqual(['brakeAt', 'pitchA1', 'pitchA2', 'pitchE', 'pitchK', 'ticksA1']);
    expect([...BRAKE_FAMILY.free({ phase: 'K', ticksA: 3 })].sort()).toEqual(['pitchE', 'pitchK']);
    const target: LandingTarget = { x: 0.5, z: T + 0.5, top: FEET + 8, half: 0.5, ground: FEET, precise: true };
    const body = { pos: { x: 0.5, y: target.top + 10, z: T - 55.5 }, vel: { x: 0, y: -0.1, z: 1.05 }, onGround: false, gliding: true, boostTicks: 0 };
    const c = new BrakePlanner(54321).step(body, 0, target);
    expect(c.style).toBe('brake');
    const td = simulateBrake(body, 0, target, c.profile);
    expect(td).toEqual(c.touchdown);
    // (the first tick's plan: the trips below refine it every tick to a touchdown nearly still on the centre)
    expect(td.kind).toBe('landed');
    expect(td.off).toBeLessThan(0.3);
    expect(Math.hypot(td.vel.x, td.vel.z)).toBeLessThan(0.3);
    // the cost: the time only (a nearly still touchdown); the flare's touchdown at 0.33 on the same cell slides off it (the server's slide counts on a precision cell)
    expect(touchdownCost(td, target)).toBeLessThan(5);
    const centre = { ...td, ticks: 60, off: 0, pos: { x: target.x, y: target.top, z: target.z } };
    expect(touchdownCost({ ...centre, vel: { x: 0, y: -0.15, z: 0.01 } }, target)).toBeLessThan(0.1);
    expect(touchdownCost({ ...centre, vel: { x: 0, y: -0.15, z: 0.33 } }, target)).toBeGreaterThan(BRAKE_BIAS + 1);
    // a profile that brakes too late runs past the cell: no landing
    const late: BrakeProfile = { ...c.profile, brakeAt: 2, pitchA1: 45, ticksA1: 40, pitchA2: -30 };
    expect(simulateBrake(body, 0, target, late).kind).not.toBe('landed');
  });

  it('findLanding: the precision goals (the pillar top; the shaft floors with their rim and cells; the cells under a low roof with the corridor), never wet, never under 3 of room; flyLandStyle flare keeps the Track BF search', async () => {
    const pillar = await landingOf(CASES[0]!.boxes, CASES[0]!.goal);
    expect(pillar.plan.kind).toBe('goal');
    if (pillar.plan.kind !== 'goal') throw new Error(pillar.plan.line);
    expect(pillar.plan.target).toMatchObject({ x: 0.5, z: T + 0.5, top: FEET + 8, half: 0.5, precise: true });
    expect(pillar.plan.target.rim).toBeUndefined();
    expect(pillar.plan.cell.precise).toBe(true);
    for (const [i, w] of [
      [1, 2],
      [2, 1],
    ] as const) {
      const s = await landingOf(CASES[i]!.boxes, CASES[i]!.goal);
      if (s.plan.kind !== 'goal') throw new Error(s.plan.line);
      expect(s.plan.target.rim, s.plan.line).toBe(RIM);
      expect(entryTop(s.plan.target)).toBe(RIM);
      expect(s.plan.target.cells?.size ?? 1).toBe(w * w);
      expect(s.plan.line).toMatch(/a shaft floor 10 deep/);
    }
    for (const i of [3, 4]) {
      const s = await landingOf(CASES[i]!.boxes, CASES[i]!.goal);
      if (s.plan.kind !== 'goal') throw new Error(s.plan.line);
      expect(s.plan.target.bearing, s.plan.line).toBeDefined();
      expect(s.plan.target.rim).toBeUndefined(); // a roof is no wall: the approach comes in under it
      expect(s.plan.target.ceiling).toBe(P + i);
    }
    // the flare's search: the pillar's goal is no landing (the ground beside it is)
    const flare = await landingOf(CASES[0]!.boxes, CASES[0]!.goal, { style: 'flare' });
    expect(flare.plan.kind).not.toBe('goal');
    // a roof 2 above: no room for the brake either
    const low = await landingOf(roofed(2), { x: 0, y: P, z: T });
    expect(low.plan.kind).not.toBe('goal');
    expect(PRECISE_HEADROOM).toBe(3);
    // the descent's re-check of a precision cell: dry and with room (sound is not asked of it)
    expect(stillLandable(pillar.w.look, { x: 0, z: T, feet: FEET + 8, precise: true }, 4)).toBe(true);
    expect(stillLandable(pillar.w.look, { x: 0, z: T, feet: FEET + 8 }, 4)).toBe(false);
  });

  it('whole trips onto the 1 x 1 pillar and the two shafts (auto picks the brake): on the cell, nearly still, no hit, no go-around', async () => {
    const lines: string[] = [];
    for (const c of CASES.slice(0, 3)) {
      const { w, plan } = await landingOf(c.boxes, c.goal);
      if (plan.kind !== 'goal') throw new Error(plan.line);
      lines.push(...expectBrakeLanding(c.name, w, plan.target));
    }
    console.log(lines.join('\n'));
  }, 60_000);

  it('whole trips under the roofs 3 and 4 above (in along the corridor, auto picks the brake): on the cells, soft, no hit', async () => {
    const lines: string[] = [];
    for (const c of CASES.slice(3)) {
      const { w, plan } = await landingOf(c.boxes, c.goal);
      if (plan.kind !== 'goal') throw new Error(plan.line);
      lines.push(...expectBrakeLanding(c.name, w, plan.target, { maxH: 0.32 }));
    }
    console.log(lines.join('\n'));
  }, 60_000);

  it('a cell with a wall 6 behind (flyLandStyle brake): stops within 0.1 of the centre, never near the wall; auto keeps the flare there (a plain floor)', () => {
    const w = world([{ from: { x: -4, y: FEET, z: T + 6 }, to: { x: 4, y: FEET + 9, z: T + 6 }, solid: true }]);
    const target: LandingTarget = { x: 0.5, z: T + 0.5, top: FEET, half: 1, ground: FEET - 24 };
    const lines = expectBrakeLanding('wall 6 behind', w, target, { landStyle: 'brake' });
    for (const l of lines) expect(Number(/, ([\d.]+) off/.exec(l)![1])).toBeLessThan(0.15);
    const auto = trip(w, { x: 0.5, y: FEET, z: 0.5 }, target, { seed: 5 });
    expect(auto.end.ok).toBe(true);
    expect(auto.stats.landStyle).toBe('flare');
    console.log(lines.join('\n'));
  });

  it('the farm (flyLandStyle brake): in under the box along the corridor, the brake onto a platform cell, then the walk', async () => {
    const f = farm();
    const plan = await findLanding(f.goal, 'gunpowder', { look: f.look, obstacle: (x, y, z) => f.solid.solidAt(x, y, z) === true, probe: f.probe }, { ...OPTS, exact: undefined });
    if (plan.kind !== 'cell') throw new Error(plan.line);
    const lines: string[] = [];
    for (const seed of [5, 11]) {
      const r = trip(f, { x: -300.5, y: FEET + 7, z: f.cz + 0.5 }, plan.target, { seed, landStyle: 'brake' });
      const line = `farm seed ${seed}: ${r.end.ok ? 'ok' : r.end.reason} at ${r.body.pos.x.toFixed(2)} ${r.body.pos.y.toFixed(2)} ${r.body.pos.z.toFixed(2)}, touchdown vy ${r.lastAir.vy.toFixed(2)} h ${r.lastAir.h.toFixed(2)}, ${r.ticks} ticks, ${r.rockets} rockets, ${r.goArounds} go-arounds, ${r.stats.brakeTicks} in K, hits ${r.hits}`;
      lines.push(line);
      expect(r.end.ok, line).toBe(true);
      expect(r.hits, line).toBe(0);
      expect(r.body.pos.y, line).toBeCloseTo(f.Y, 1);
      expect(onTarget(plan.target, r.body.pos), line).toBe(true);
      expect(r.lastAir.h, line).toBeLessThan(0.15);
    }
    console.log(lines.join('\n'));
  }, 60_000);

  it('the flare cannot do these: the 2 x 2 shaft floor is never landed (go-arounds, then off it); on the pillar it touches down at 0.3 or more (the server slides 0.6 to 0.8 on: off the top)', async () => {
    const shaft = await landingOf(CASES[1]!.boxes, CASES[1]!.goal);
    if (shaft.plan.kind !== 'goal') throw new Error(shaft.plan.line);
    const r = trip(shaft.w, { x: 0.5, y: FEET, z: 0.5 }, shaft.plan.target, { seed: 5, landStyle: 'flare' });
    expect(r.goArounds).toBeGreaterThan(0);
    expect(onTarget(shaft.plan.target, r.body.pos)).toBe(false);
    const pillar = await landingOf(CASES[0]!.boxes, CASES[0]!.goal);
    if (pillar.plan.kind !== 'goal') throw new Error(pillar.plan.line);
    const f = trip(pillar.w, { x: 0.5, y: FEET, z: 0.5 }, pillar.plan.target, { seed: 5, landStyle: 'flare' });
    expect(f.lastAir.h).toBeGreaterThan(0.3);
  }, 60_000);

  it('go-arounds shortened (stop and re-aim): retargeted to the cell before the fly-walk house while circling beyond it, the flare goes around once, auto brakes in (no go-around, fewer ticks and rockets)', () => {
    const lines: string[] = [];
    for (const seed of [1, 2]) {
      const o = { dist: 300, up: 0, half: 1, house: 0, seed, retargetFrom: { x: 0.5, z: 295.5, top: FEET, half: 1, ground: FEET }, retargetWithin: 60, retargetBeyond: 10 } as const;
      const flare = flyTrip({ ...o, landStyle: 'flare' });
      const auto = flyTrip({ ...o, landStyle: 'auto' });
      lines.push(`house seed ${seed}: flare ${flare.goArounds} go-arounds ${flare.ticks} ticks ${flare.rockets} rockets; auto (${auto.stats.landStyle}, ${auto.stats.brakeRescues} rescues) ${auto.goArounds} go-arounds ${auto.ticks} ticks ${auto.rockets} rockets`);
      expect(flare.goArounds).toBe(1);
      expect(auto.end.ok).toBe(true);
      expect(auto.hits).toBe(0);
      expect(auto.goArounds).toBe(0);
      expect(auto.stats.brakeRescues).toBe(1);
      expect(auto.ticks).toBeLessThan(flare.ticks - 60);
      expect(auto.rockets).toBeLessThan(flare.rockets);
    }
    console.log(lines.join('\n'));
  });

  it('the flare unchanged: on plain platforms auto flies exactly the flare (the same ticks, rockets, touchdown); a block-wide platform gets the brake', () => {
    for (const o of [
      { dist: 150, up: 40, half: 1 },
      { dist: 300, up: 20, half: 2 },
      { dist: 100, up: 40, half: 1, startUp: 100, walls: true },
      { dist: 300, up: 0, half: 1, tree: true },
    ]) {
      const a = flyTrip({ ...o, landStyle: 'auto' });
      const f = flyTrip({ ...o, landStyle: 'flare' });
      expect(a.stats.landStyle, JSON.stringify(o)).toBe('flare');
      expect(a.ticks).toBe(f.ticks);
      expect(a.rockets).toBe(f.rockets);
      expect(a.body.pos).toEqual(f.body.pos);
      expect(a.stats.brakeRescues).toBe(0);
    }
    const one = flyTrip({ dist: 150, up: 40, half: 0.5, landStyle: 'auto' });
    expect(one.stats.landStyle).toBe('brake');
    expect(one.end.off).toBeLessThan(0.15);
    expect(one.lastAir.h).toBeLessThan(0.1);
    expect(columnKey(0, 0)).toBe(0);
  });
});
