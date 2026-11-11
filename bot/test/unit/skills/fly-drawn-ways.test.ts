// Track F9e (docs/flight.md "Drawn lines, the way in and under one roof (Track F9e)", decisions/0082-drawn-entries-and-hops.md):
// longer drawn lines, a drawn way in and flights under one roof. Guarded here on synthetic caves (nothing of anybody's
// world): the taut line and the speed for every point (learn/draw.ts), a long passage with three bends that the follower
// without the speeds loses at a short burn, a drawn entry into a hall through a mouth above it and one refused where the
// opening lies under the goal (learn/drawin.ts), hops between halls joined by a passage (straight, with a bend, with a
// climb), a hop refused by a block set on its line, and a chain of three (learn/hop.ts, glide.ts routeHop).
import { describe, expect, it } from 'vitest';
import { SETTING_DEFS } from '../../../src/config/settings.ts';
import type { Vec3 } from '../../../src/connection/types.ts';
import { HARD_HIT, LEARNED_PROOF_BURNS, routeHop, routeTakeoffOptions, simulateFlight, type SimDeps } from '../../../src/skills/fly/glide.ts';
import { DRAW_CAP_DIVE, DRAW_CAP_MAX, DRAW_CAP_MIN, drawExits, drawWays, floodTo, lineSpeeds, rollDraft, taut } from '../../../src/skills/fly/learn/draw.ts';
import { chooseDrawnEntry, DRAW_IN_MIN, drawEntries } from '../../../src/skills/fly/learn/drawin.ts';
import { ENTRY_AIR, ENTRY_SOLID, entryState, entryTouchdowns, entryVerdict, flyEntry, type EntryWorld } from '../../../src/skills/fly/learn/entry.ts';
import { FOLLOW_MARGIN } from '../../../src/skills/fly/learn/follow.ts';
import { entrySaid, guideLength } from '../../../src/skills/fly/learn/guide.ts';
import { drawHops, HOP_HAND, HOP_LAST_TO, HOP_MIN, type DrawnHop } from '../../../src/skills/fly/learn/hop.ts';
import { cruiseHeight, type CellQuery, type LandingTarget } from '../../../src/skills/fly/plan.ts';
import { gridOf } from '../../../src/skills/fly/route/grid.ts';
import { drawnRoute } from '../../../src/skills/fly/route/takeoff.ts';
import { flatWorld, withBoxes, type BlockBox, type BlockQuery } from '../../../src/skills/input/index.ts';

const FEET = -60;

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
  const ew: EntryWorld = { world, grid };
  const cls = (x: number, y: number, z: number): number => (world.solidAt(x, y, z) ? ENTRY_SOLID : ENTRY_AIR);
  return { world, deps, grid, skyTop, ew, cls };
}

const air = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): BlockBox => ({ from: { x: Math.min(x0, x1), y: Math.min(y0, y1), z: Math.min(z0, z1) }, to: { x: Math.max(x0, x1), y: Math.max(y0, y1), z: Math.max(z0, z1) }, solid: false });
const noPlan = (): never => {
  throw new Error('a drawn line asks no planner');
};

describe('fly: the taut line and a speed for every point (Track F9e)', () => {
  it('the heights are straight where nothing is in the way, and bend only at a sill and under a low roof', () => {
    const xs = Array.from({ length: 40 }, (_v, i) => i + 1);
    // free: one slope from the start's height to the end's
    const free = taut(xs, xs.map(() => 0), xs.map(() => 50), 10, 30);
    for (let i = 0; i < 40; i++) expect(free[i]!).toBeCloseTo(10 + (20 * (i + 1)) / 40, 6);
    // a sill at 20 (the floor 26 there): up to it on one slope, down from it on another, and nowhere else a bend
    const lo = xs.map((x) => (x === 20 ? 26 : 0));
    const sill = taut(xs, lo, xs.map(() => 50), 10, 12);
    expect(sill[19]!).toBeCloseTo(26, 6);
    for (let i = 1; i < 19; i++) expect(sill[i]! - sill[i - 1]!).toBeCloseTo(0.8, 6);
    for (let i = 21; i < 40; i++) expect(sill[i]! - sill[i - 1]!).toBeCloseTo(-0.7, 6);
    // a low roof at 10 (the roof 4 there): down under it, then up again
    const hi = xs.map((x) => (x === 10 ? 4 : 50));
    const roof = taut(xs, xs.map(() => 0), hi, 10, 20);
    expect(roof[9]!).toBeCloseTo(4, 6);
    expect(roof[4]!).toBeCloseTo(7, 6);
    expect(roof[39]!).toBeCloseTo(20, 6);
    // every height inside its band
    for (let i = 0; i < 40; i++) {
      expect(sill[i]!).toBeGreaterThanOrEqual(lo[i]! - 1e-9);
      expect(roof[i]!).toBeLessThanOrEqual(hi[i]! + 1e-9);
    }
  });

  it('the speeds: a straight level line the most, a line that falls a block a tick, a top less, and less already before it', () => {
    const level: Vec3[] = Array.from({ length: 60 }, (_v, i) => ({ x: i, y: 0, z: 0 }));
    for (const v of lineSpeeds(level)) expect(v).toBe(DRAW_CAP_MAX);
    const falling: Vec3[] = Array.from({ length: 60 }, (_v, i) => ({ x: i * 0.866, y: -i * 0.5, z: 0 }));
    expect(lineSpeeds(falling)[30]).toBe(DRAW_CAP_DIVE);
    // up 30 degrees for 30 blocks, then down 30 degrees: a top with no rounding
    const top: Vec3[] = [...Array.from({ length: 30 }, (_v, i) => ({ x: i * 0.866, y: i * 0.5, z: 0 })), ...Array.from({ length: 30 }, (_v, i) => ({ x: (30 + i) * 0.866, y: 15 - i * 0.5, z: 0 }))];
    const caps = lineSpeeds(top);
    expect(caps[30]!).toBe(DRAW_CAP_MIN);
    expect(caps[20]!).toBeGreaterThan(caps[26]!);
    expect(caps[26]!).toBeGreaterThan(caps[30]! - 1e-9);
    expect(caps[5]!).toBe(DRAW_CAP_MAX);
  });
});

/**
 * A mesa with a tunnel 11 wide and 10 high: a hall, 30 blocks level, a ramp up 24 at 45 degrees to a sill, down the far
 * side as steep, a bend north, a bend west and out: three bends, the first of them over a top.
 */
function threeBends(): BlockBox[] {
  const b: BlockBox[] = [{ from: { x: -120, y: FEET, z: -60 }, to: { x: 60, y: FEET + 59, z: 60 }, solid: true }];
  b.push(air(30, FEET, -6, 44, FEET + 9, 6));
  b.push(air(0, FEET, -5, 30, FEET + 9, 5));
  for (let k = 0; k <= 24; k++) b.push(air(-k, FEET + k, -5, -k, FEET + k + 9, 5));
  b.push(air(-30, FEET + 24, -5, -24, FEET + 33, 5));
  for (let k = 0; k <= 24; k++) b.push(air(-30 - k, FEET + 24 - k, -5, -30 - k, FEET + 33 - k, 5));
  b.push(air(-64, FEET, -5, -54, FEET + 9, 30));
  b.push(air(-121, FEET, 20, -54, FEET + 9, 30));
  return b;
}

describe('fly: a long drawn way out (Track F9e)', () => {
  it('a passage with three bends, the first over a top: lost at a short burn without the speeds, flown out at every burn with them', async () => {
    const r = rig(threeBends());
    const from: Vec3 = { x: 37.5, y: FEET, z: 0.5 };
    const target: LandingTarget = { x: -600.5, z: 0.5, top: FEET, half: 1 };
    const cz = cruiseHeight(from, target, r.skyTop, {}).y;
    const d = drawExits(r.grid, from, Math.ceil(cz), { radius: 300 });
    expect(d.lines.length, d.tried.join(' | ')).toBeGreaterThan(0);
    const l = d.lines[0]!;
    expect(guideLength(l.guide)).toBeGreaterThan(150);
    expect(l.guide.speeds?.length).toBe(l.guide.points.length);
    // the speeds know the top: under the most somewhere on the way
    expect(Math.min(...l.guide.speeds!)).toBeLessThan(1.2);
    const fly = async (speeds: boolean, burn: number): Promise<boolean> => {
      const { speeds: caps, ...bare } = l.guide;
      const route = drawnRoute({ ...l, guide: speeds ? { ...bare, speeds: caps! } : bare }, from, 0);
      const sim = await simulateFlight(r.deps, from, target, { cruiseY: cz, takeoffYaw: route.yaw, route: { grid: r.grid, plan: noPlan }, routeTakeoff: routeTakeoffOptions(route, true) }, { rockets: 64, yaw: route.yaw, maxTicks: 700, burn, endLag: 2, until: (b) => b.phase === 'approach' });
      return sim.stats.routeTakeoffEnd === 'out' && sim.hits - (sim.bumps ?? 0) === 0 && !sim.end;
    };
    // without the speeds (the follower as it was): the shortest burn ends before the top and the body leaves the line there
    expect(await fly(false, 9)).toBe(false);
    for (const burn of [9, 12, 15, 18, 21]) expect(await fly(true, burn), `burn ${burn}`).toBe(true);
  }, 120_000);

  it('the lines are drawn at once and rolled one by one: the first that rolls is as the eager draw has it', () => {
    const r = rig(threeBends());
    const from: Vec3 = { x: 37.5, y: FEET, z: 0.5 };
    const w = drawWays(r.grid, from, FEET + 80, { radius: 300 });
    expect(w.drafts.length).toBeGreaterThan(0);
    const first = w.drafts.map((d) => rollDraft(w.grid, d, FEET + 80)).find((x) => typeof x !== 'string');
    expect(first).toBeDefined();
    if (first && typeof first !== 'string') expect(first.rockets).toBeGreaterThan(1);
  }, 60_000);
});

/** A mesa 60 high with a hall 17 x 17 and 12 high on its floor; `up`: a passage 9 wide and 9 high from the hall's west wall rising 20 degrees to a mouth in the mesa's west face. */
const hallMesa: BlockBox[] = [
  { from: { x: -40, y: FEET, z: -40 }, to: { x: 40, y: FEET + 59, z: 40 }, solid: true },
  air(-8, FEET, -8, 8, FEET + 11, 8),
];
function passageUp(): BlockBox[] {
  const b: BlockBox[] = [];
  for (let k = 0; k <= 32; k++) b.push(air(-9 - k, FEET + Math.floor(k * 0.36), -4, -9 - k, FEET + Math.floor(k * 0.36) + 8, 4));
  return b;
}

describe('fly: a drawn way in (Track F9e)', () => {
  it('into a hall through a mouth above it: drawn from the touchdown outwards, coming down all the way, proven and flown to standing by the goal', async () => {
    const r = rig([...hallMesa, ...passageUp()]);
    const goal: Vec3 = { x: 2, y: FEET, z: 0 };
    const d = await drawEntries(r.grid, { x: goal.x + 0.5, y: goal.y, z: goal.z + 0.5 }, FEET + 90);
    expect(d.ways).toBe(1);
    expect(d.entries.length, d.tried.join(' | ')).toBeGreaterThan(0);
    const g = d.entries[0]!.match.guide;
    expect(g.drawn).toBe(true);
    expect(entrySaid(g)).toBe('drawn entry');
    expect(g.rockets.length).toBe(0);
    expect(g.landed).toBe(true);
    // it begins in the open, at least the hand-over's length of it, and ends on the touchdown
    expect(d.entries[0]!.match.open).toBeGreaterThanOrEqual(DRAW_IN_MIN);
    const last = g.points[g.points.length - 1]!;
    expect(Math.hypot(last.x - goal.x - 0.5, last.z - goal.z - 0.5)).toBeLessThan(0.01);
    expect(g.points[0]!.y).toBeGreaterThan(last.y + 10);
    // its clock: no faster than a falling line is flown, slower at the end
    expect(g.ticks[g.ticks.length - 1]!).toBeGreaterThan(guideLength(g) / 1.3);
    const pick = await chooseDrawnEntry(r.ew, r.grid, goal, entryTouchdowns(r.cls, goal), FEET + 90);
    expect(pick.line, pick.tried.join(' | ')).toBeDefined();
    expect(pick.proof!.ok).toBe(true);
    const line = pick.line!;
    for (const at of [line.from, (line.from + line.to) / 2, line.to]) {
      const f = flyEntry(r.ew, line, entryState(line, at));
      expect(entryVerdict(f), `from ${at}`).toBeUndefined();
      expect(f.offGoal).toBeLessThanOrEqual(2);
    }
  }, 120_000);

  it('refused where the opening lies under the goal (a glide comes down all the way), and where the hall is sealed', async () => {
    // the hall's floor 20 over the ground, its only way out a passage down to the mesa's foot
    const high: BlockBox[] = [{ from: { x: -40, y: FEET, z: -40 }, to: { x: 40, y: FEET + 59, z: 40 }, solid: true }, air(-8, FEET + 20, -8, 8, FEET + 31, 8)];
    for (let k = 0; k <= 32; k++) high.push(air(-9 - k, FEET + 20 - Math.floor(k * 0.62), -4, -9 - k, FEET + 28 - Math.floor(k * 0.62), 4));
    const r = rig(high);
    const goal: Vec3 = { x: 2, y: FEET + 20, z: 0 };
    const pick = await chooseDrawnEntry(r.ew, r.grid, goal, entryTouchdowns(r.cls, goal), FEET + 90);
    expect(pick.line).toBeUndefined();
    expect(pick.tried.join(' | ')).toMatch(/climbs/);
    const sealed = rig(hallMesa);
    const none = await chooseDrawnEntry(sealed.ew, sealed.grid, { x: 2, y: FEET, z: 0 }, entryTouchdowns(sealed.cls, { x: 2, y: FEET, z: 0 }), FEET + 90);
    expect(none.line).toBeUndefined();
    expect(none.tried.join(' | ')).toMatch(/no way under the roof/);
    expect(SETTING_DEFS.flyCaveEntry.default).toBe(false);
  }, 60_000);
});

/** A mountain with halls 13 x 13 and 10 high along x, 90 apart, joined by passages 9 wide and 8 high; `rise`: each hall that much higher than the one before; `bend`: the passage leaves north and bends east. */
function halls(n: number, o: { rise?: number; bend?: boolean } = {}): { boxes: BlockBox[]; at: Vec3[] } {
  const rise = o.rise ?? 0;
  const boxes: BlockBox[] = [{ from: { x: -30, y: FEET, z: -70 }, to: { x: 90 * n + 30, y: FEET + 79, z: 70 }, solid: true }];
  const at: Vec3[] = [];
  for (let k = 0; k < n; k++) {
    const x = 90 * k;
    const y = FEET + rise * k;
    // (`bend`: each hall 40 north of the one before: the passage leaves north and bends east into it)
    const z = o.bend ? 40 * k : 0;
    boxes.push(air(x - 6, y, z - 6, x + 6, y + 9, z + 6));
    at.push({ x: x + 0.5, y, z: z + 0.5 });
    if (k + 1 === n) break;
    if (o.bend) {
      boxes.push(air(x - 5, y, z + 7, x + 5, y + 8, z + 45));
      boxes.push(air(x - 5, y, z + 35, x + 83, y + 8, z + 45));
    } else {
      for (let j = 7; j <= 83; j++) {
        const yy = y + Math.round((rise * (j - 7)) / 76);
        boxes.push(air(x + j, yy, -4, x + j, yy + 7, 4));
      }
    }
  }
  return { boxes, at };
}

function hopRig(boxes: BlockBox[]) {
  const r = rig(boxes);
  const target = (h: DrawnHop, goal: Vec3): LandingTarget => ({ x: goal.x + 0.5, z: goal.z + 0.5, top: goal.y, half: 2, entry: { line: h.line, goal: { x: goal.x + 0.5, z: goal.z + 0.5, top: goal.y, half: 2 } } });
  const flight = (h: DrawnHop) => ({ route: { grid: r.grid, plan: noPlan }, takeoff: routeTakeoffOptions({ goals: [], margin: FOLLOW_MARGIN, weight: 2, guide: { line: h.guide, open: Infinity, off: 0 }, hop: { hand: h.hand } }, false) });
  const cellOf = (p: Vec3): Vec3 => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
  const draw = (from: Vec3, to: Vec3) => drawHops(r.grid, from, cellOf(to), entryTouchdowns(r.cls, cellOf(to)), FEET + 100);
  const prove = (h: DrawnHop, from: Vec3, to: Vec3, deps: SimDeps = r.deps) => routeHop(deps, from, target(h, cellOf(to)), { cruiseY: from.y + 24 }, 64, flight(h), { planTicks: h.guide.ticks[h.guide.ticks.length - 1] ?? 0, yaw: h.guide.yaw });
  const fly = (h: DrawnHop, from: Vec3, to: Vec3, burn: number, deps: SimDeps = r.deps, grid = r.grid) =>
    simulateFlight(deps, from, target(h, cellOf(to)), { cruiseY: from.y + 24, takeoffYaw: h.guide.yaw, route: { grid, plan: noPlan }, routeTakeoff: flight(h).takeoff }, { rockets: 64, yaw: h.guide.yaw, maxTicks: 600, burn, endLag: 2 });
  return { ...r, draw, prove, fly, cellOf };
}

describe('fly: a hop between two places under one roof (Track F9e)', () => {
  it('the flood to a cell stays in the cave: aimed at the goal, through a hole in the roof, never out into the open air', () => {
    const { boxes, at } = halls(2);
    const r = rig(boxes);
    const f = floodTo(r.grid, at[0]!, { x: 90, y: FEET, z: 0 }, { top: FEET + 100 });
    expect(f.way).toBeDefined();
    expect(f.way!.way[0]).toEqual({ x: 0, y: FEET, z: 0 });
    expect(f.way!.way[f.way!.way.length - 1]).toEqual({ x: 90, y: FEET, z: 0 });
    // a second hall that is not joined to the first: none, and the search did not wander the open air for it
    const apart = rig([{ from: { x: -30, y: FEET, z: -70 }, to: { x: 210, y: FEET + 79, z: 70 }, solid: true }, air(-6, FEET, -6, 6, FEET + 9, 6), air(84, FEET, -6, 96, FEET + 9, 6)]);
    const none = floodTo(apart.grid, at[0]!, { x: 90, y: FEET, z: 0 }, { top: FEET + 100 });
    expect(none.way).toBeUndefined();
    expect(none.cells).toBeLessThan(5000);
  });

  it('a straight passage: drawn with the place of its last rocket and of its flier, proven at every burn, and flown to standing by the goal with no hit', async () => {
    const { boxes, at } = halls(2);
    const r = hopRig(boxes);
    const d = r.draw(at[0]!, at[1]!);
    expect(d.hops.length, d.tried.join(' | ')).toBeGreaterThan(0);
    const h = d.hops[0]!;
    const len = guideLength(h.guide);
    expect(len).toBeGreaterThan(HOP_MIN);
    expect(h.guide.hop!.to).toBeCloseTo(len - HOP_LAST_TO, 6);
    expect(h.hand).toBeCloseTo(len - HOP_HAND, 6);
    expect(h.line.touchdown).toEqual({ x: 90.5, y: FEET, z: 0.5 });
    const p = await r.prove(h, at[0]!, at[1]!);
    expect(p.ok, p.line).toBe(true);
    expect(p.sims).toBe(1 + LEARNED_PROOF_BURNS.length + 2 + 3);
    for (const burn of [9, 15, 21]) {
      const sim = await r.fly(h, at[0]!, at[1]!, burn);
      expect(sim.end?.ok, `burn ${burn}`).toBe(true);
      expect(Math.hypot(sim.end!.landedAt.x - 90.5, sim.end!.landedAt.z - 0.5)).toBeLessThanOrEqual(2);
      expect(sim.hard ?? 0).toBe(0);
      // no rocket in the last blocks: the flier took a body that glides
      expect(sim.stats.entry?.end).toBe('landed');
    }
    expect(HARD_HIT).toBeLessThan(0.3);
    expect(SETTING_DEFS.flyCaveHop.default).toBe(false);
  }, 120_000);

  it('a passage with a bend, and one that climbs 14 to the next hall (it climbs on its burns): proven and flown', async () => {
    for (const o of [{ bend: true }, { rise: 14 }]) {
      const { boxes, at } = halls(2, o);
      const r = hopRig(boxes);
      const d = r.draw(at[0]!, at[1]!);
      expect(d.hops.length, d.tried.join(' | ')).toBeGreaterThan(0);
      let proven: DrawnHop | undefined;
      const said: string[] = [];
      for (const h of d.hops.slice(0, 3)) {
        const p = await r.prove(h, at[0]!, at[1]!);
        said.push(p.line);
        if (p.ok) {
          proven = h;
          break;
        }
      }
      expect(proven, said.join(' | ')).toBeDefined();
      const sim = await r.fly(proven!, at[0]!, at[1]!, 12);
      expect(sim.end?.ok).toBe(true);
      expect(Math.abs(sim.end!.landedAt.y - at[1]!.y)).toBeLessThanOrEqual(2);
      expect(sim.hard ?? 0).toBe(0);
    }
  }, 240_000);

  it('too short a way is not flown, and a block set across the line refuses the hop: the body that flies it all the same stops short and comes down with no hard hit', async () => {
    const { boxes, at } = halls(2);
    const r = hopRig(boxes);
    // 30 blocks: under what a rocket's longest burn flies
    const near = r.draw(at[0]!, { x: 30.5, y: FEET, z: 0.5 });
    expect(near.hops.length).toBe(0);
    expect(near.tried.join(' | ')).toMatch(/too short to fly/);
    const h = r.draw(at[0]!, at[1]!).hops[0]!;
    // a wall across the passage after the line was drawn
    const walled = rig([...boxes, { from: { x: 50, y: FEET, z: -4 }, to: { x: 51, y: FEET + 7, z: 4 }, solid: true }]);
    const p = await r.prove(h, at[0]!, at[1]!, walled.deps);
    // (the proof's follower still sees the old grid here: its body meets the wall; with the wall in its grid it stops before it)
    expect(p.ok).toBe(false);
    const sim = await r.fly(h, at[0]!, at[1]!, 15, walled.deps, walled.grid);
    expect(sim.end).toBeDefined();
    expect(sim.end!.landedAt.x).toBeLessThan(50);
    expect(sim.hard ?? 0).toBe(0);
  }, 120_000);

  it('a chain of three hops: each drawn and proven from where the last one stood', async () => {
    const { boxes, at } = halls(4);
    const r = hopRig(boxes);
    let from = at[0]!;
    for (let k = 1; k < 4; k++) {
      const d = r.draw(from, at[k]!);
      expect(d.hops.length, `hop ${k}: ${d.tried.join(' | ')}`).toBeGreaterThan(0);
      const h = d.hops[0]!;
      const p = await r.prove(h, from, at[k]!);
      expect(p.ok, `hop ${k}: ${p.line}`).toBe(true);
      const sim = await r.fly(h, from, at[k]!, 9 + 4 * k);
      expect(sim.end?.ok, `hop ${k}`).toBe(true);
      expect(Math.hypot(sim.end!.landedAt.x - at[k]!.x, sim.end!.landedAt.z - at[k]!.z)).toBeLessThanOrEqual(2);
      from = sim.end!.landedAt;
    }
  }, 240_000);
});
