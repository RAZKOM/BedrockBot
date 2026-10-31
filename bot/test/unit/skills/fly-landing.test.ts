// Wave 11 Track BF (docs/flight.md "Landing v3"): where a flight that ends in a walk lands, offline on
// synthetic worlds and the physics engine (stepBody): dry ground only (the Realm's sea floor), a
// confirmed walking path (the Realm's spawning-box roof), the overhang landing on the owner's farm
// replica (a 9 x 7 platform under a 30 x 30 box, the goal in a room below it), the hold while the
// goal is not loaded, the walk landing's acceptance (no go-around for an off-centre touchdown).
import { describe, expect, it } from 'vitest';
import { FlightBrain } from '../../../src/skills/fly/brain.ts';
import { cellsAround, ColumnView, corridorLands, corridorsOf, findLanding, floorsOf, walkTarget, type BlockLookup, type CellBlock, type LandingDeps, type LandingOptions, type ProbeOutcome } from '../../../src/skills/fly/landing.ts';
import { columnKey, cruiseHeight, onTarget, simulateProfile, slideOut, touchdownCost, type LandingTarget } from '../../../src/skills/fly/plan.ts';
import { flatWorld, GLIDE, IDLE_COMMAND, initialBody, stepBody, withBoxes, type BlockBox, type BlockQuery } from '../../../src/skills/input/index.ts';

const FEET = -60;
const OPTS: LandingOptions = { radius: 48, headroom: 4, maxUnder: 12, probes: 16, budgetMs: 60_000 };

/** A synthetic world: boxes of solids over the flat ground, plus water boxes (for the dryness rules). */
function world(boxes: BlockBox[], water: BlockBox[] = []) {
  const solid = withBoxes(flatWorld(), boxes);
  const wet = (x: number, y: number, z: number) => water.some((w) => x >= w.from.x && x <= w.to.x && y >= w.from.y && y <= w.to.y && z >= w.from.z && z <= w.to.z);
  const look: BlockLookup = (x, y, z): CellBlock => {
    if (solid.solidAt(x, y, z)) return { name: 'stone', solid: true };
    return wet(x, y, z) ? { name: 'water', solid: false } : { name: 'air', solid: false };
  };
  const skyTop = (x: number, z: number): number => {
    for (let y = 200; y >= -64; y--) if (solid.solidAt(x, y, z)) return y;
    return -64;
  };
  /** Dry ground under open sky (feet), the brain's groundAt. */
  const dryGround = (x: number, z: number, fromY = 200): number | undefined => {
    const f = floorsOf(look, x, z, Math.floor(fromY), -64)?.[0];
    return f && !f.wet && !f.hazard ? f.feet : undefined;
  };
  return { solid, look, skyTop, dryGround };
}

/**
 * The owner's creeper farm (the Realm, 2026-10-31): a 9 x 7 platform floating 70 above the sea (its
 * top at `Y - 1`), a room under it with the goal (feet Y - 4) and a ladder up through a hole in the
 * platform, a 4 x 4 shaft rising 12 from the platform's west half and a 32 x 30 x 12 box on top of it
 * that overhangs the whole platform (its east edge one block past the platform's): no cell of the
 * platform has open sky; the corridor in is from the east (+x).
 */
function farm(o: { island?: boolean } = {}) {
  const Y = FEET + 70;
  const cz = 300;
  const boxes: BlockBox[] = [
    // the room under the platform: a shell, hollowed
    { from: { x: -3, y: Y - 5, z: cz - 3 }, to: { x: 3, y: Y - 2, z: cz + 3 }, solid: true },
    { from: { x: -2, y: Y - 4, z: cz - 2 }, to: { x: 2, y: Y - 2, z: cz + 2 }, solid: false },
    // the platform (9 x 7) with the hole over the ladder
    { from: { x: -4, y: Y - 1, z: cz - 3 }, to: { x: 4, y: Y - 1, z: cz + 3 }, solid: true },
    { from: { x: 2, y: Y - 1, z: cz }, to: { x: 2, y: Y - 1, z: cz }, solid: false },
    // the shaft (4 x 4, hollow) up to the box
    { from: { x: -4, y: Y, z: cz - 2 }, to: { x: -1, y: Y + 11, z: cz + 1 }, solid: true },
    { from: { x: -3, y: Y, z: cz - 1 }, to: { x: -2, y: Y + 11, z: cz }, solid: false },
    // the spawning box: a shell 12 high, overhanging the platform to x = 5
    { from: { x: -26, y: Y + 12, z: cz - 15 }, to: { x: 5, y: Y + 23, z: cz + 14 }, solid: true },
    { from: { x: -25, y: Y + 13, z: cz - 14 }, to: { x: 4, y: Y + 22, z: cz + 13 }, solid: false },
  ];
  if (o.island) boxes.push({ from: { x: 40, y: FEET, z: cz - 10 }, to: { x: 52, y: FEET + 6, z: cz + 10 }, solid: true });
  // the sea: 5 deep over the flat ground everywhere around
  const water: BlockBox[] = [{ from: { x: -200, y: FEET, z: cz - 200 }, to: { x: 200, y: FEET + 4, z: cz + 200 }, solid: false }];
  const w = world(boxes, water);
  const goal = { x: 0, y: Y - 4, z: cz };
  /** The probe: a walk from the platform down the ladder (its path: to the hole, 4 down, to the goal); nothing else walks there. */
  const probe = (from: { x: number; y: number; z: number }): Promise<ProbeOutcome> =>
    Promise.resolve(from.y === Y ? { status: 'found', blocks: Math.abs(from.x - 2.5) + Math.abs(from.z - (cz + 0.5)) + 4 + 2.5 } : { status: 'none' });
  return { ...w, Y, cz, goal, probe };
}

/** The brain flying a whole trip on stepBody to `target` (the offline simulator; fly.test.ts flyTrip generalised). */
function trip(w: ReturnType<typeof world>, start: { x: number; y: number; z: number }, target: LandingTarget, o: { seed?: number; retarget?: (t: number, pos: { x: number; y: number; z: number }) => LandingTarget | undefined; maxTicks?: number } = {}) {
  const notes: string[] = [];
  const cz = cruiseHeight(start, target, w.skyTop, {});
  const brain = new FlightBrain(target, { cruiseY: cz.y, groundAt: (x, z, fromY) => w.dryGround(x, z, fromY), skyTop: w.skyTop, obstacle: (x, y, z) => w.solid.solidAt(x, y, z) === true, seed: o.seed ?? 5, note: (m) => notes.push(m) });
  let body = initialBody(start, true);
  let cmd = { ...IDLE_COMMAND };
  let rockets = 64;
  let lastFire = -100;
  let lastAir = { vy: 0, h: 0 };
  let hits = 0;
  let minClear = Infinity;
  for (let t = 1; t < (o.maxTicks ?? 8000); t++) {
    const nt = o.retarget?.(t, body.pos);
    if (nt) brain.retarget(nt, { pos: body.pos, vel: body.vel, onGround: body.onGround, gliding: body.gliding ?? false, boostTicks: body.boostTicks ?? 0 });
    const out = brain.step({ tick: t, body: { pos: body.pos, vel: body.vel, onGround: body.onGround, gliding: body.gliding ?? false, boostTicks: body.boostTicks ?? 0 }, yaw: cmd.yaw, pitch: cmd.pitch, rockets, canFire: t - lastFire >= 4, health: 20, elytraLeft: 400 });
    const c = out.control;
    cmd = { ...cmd, yaw: c.yaw, pitch: c.pitch, jump: c.jump, glide: c.glide };
    const step = { ...cmd, ...(c.fire ? { boostStart: GLIDE.boostTicks } : {}) };
    if (c.fire) {
      rockets--;
      lastFire = t;
    }
    if (body.gliding) lastAir = { vy: body.vel.y, h: Math.hypot(body.vel.x, body.vel.z) };
    const before = body.vel;
    body = stepBody(body, step, w.solid).state;
    if (body.gliding && Math.hypot(before.x, before.z) > 0.6 && Math.hypot(body.vel.x, body.vel.z) < Math.hypot(before.x, before.z) * 0.3 && body.pos.y > FEET + 0.5) hits++;
    if (body.gliding) minClear = Math.min(minClear, body.pos.y - w.skyTop(Math.floor(body.pos.x), Math.floor(body.pos.z)));
    if (out.end) return { end: out.end, ticks: t, rockets: 64 - rockets, goArounds: brain.stats.goArounds, reasons: brain.stats.goAroundReasons, lastAir, hits, body, notes, holdTicks: brain.stats.holdTicks, descents: brain.stats.descents };
  }
  throw new Error(`the flight never ended (${brain.phase}, notes ${notes.join(' | ')})`);
}

describe('fly: landing v3, the cell (Track BF)', () => {
  it('a column under water is never ground: the sea floor 5 under the surface is wet, a puddle too; lava is a hazard', () => {
    const w = world([{ from: { x: 5, y: FEET, z: 0 }, to: { x: 5, y: FEET, z: 0 }, solid: true }], [{ from: { x: 0, y: FEET, z: 0 }, to: { x: 3, y: FEET + 4, z: 3 }, solid: false }]);
    const sea = floorsOf(w.look, 1, 1, 40, -64)!;
    expect(sea[0]).toMatchObject({ feet: FEET, wet: true });
    expect(w.dryGround(1, 1)).toBeUndefined();
    expect(w.dryGround(10, 10)).toBe(FEET);
    const lava: BlockLookup = (x, y) => (y < FEET ? { name: 'stone', solid: true } : y === FEET ? { name: 'lava', solid: false } : { name: 'air', solid: false });
    expect(floorsOf(lava, 0, 0, 0, -64)![0]).toMatchObject({ wet: true });
  });

  it('the farm: the platform cells under the box are overhang candidates with a corridor in from the east, and the approach simulation lands on them', () => {
    const f = farm();
    const view = new ColumnView(f.look, f.goal.y);
    const fl = view.floorNear(3, f.cz - 1, f.Y, 0)!;
    expect(fl).toMatchObject({ feet: f.Y, ceiling: f.Y + 12, wet: false });
    expect(view.kindOf(fl, 4)).toBe('roof');
    expect(view.sound(3, f.cz - 1, fl)).toBe(true);
    // beside the hole over the ladder: not level (the neighbour's floor is the room's, 4 down)
    expect(view.sound(3, f.cz, view.floorNear(3, f.cz, f.Y, 0)!)).toBe(false);
    const corridors = corridorsOf(f.look, 3, f.cz - 1, f.Y, 12);
    expect(corridors.length).toBeGreaterThan(0);
    expect(Math.abs(corridors[0]!.bearing - 270)).toBeLessThanOrEqual(30); // +x
    expect(corridors[0]!.under).toBeLessThanOrEqual(3);
    const cells = cellsAround(view, { x: 3, z: f.cz - 1, feet: f.Y }, 'roof', 2, 4);
    const t = walkTarget({ x: 3, z: f.cz - 1, feet: f.Y, kind: 'roof' }, cells, { bearing: 270 });
    const sim = corridorLands(t, 270, (x, y, z) => f.solid.solidAt(x, y, z) === true);
    expect(sim.ok, JSON.stringify(sim)).toBe(true);
  });

  it('the farm: findLanding picks a platform cell under the box (a confirmed walk down the ladder), never the box roof (no path) nor the sea floor', async () => {
    const f = farm();
    const deps: LandingDeps = { look: f.look, obstacle: (x, y, z) => f.solid.solidAt(x, y, z) === true, probe: f.probe, dryGround: (x, z) => f.dryGround(x, z) };
    const plan = await findLanding(f.goal, 'gunpowder', deps, OPTS);
    expect(plan.kind, plan.line).toBe('cell');
    if (plan.kind !== 'cell') return;
    expect(plan.cell.feet).toBe(f.Y);
    expect(plan.cell.kind).toBe('roof');
    expect(Math.abs(plan.target.bearing! - 270)).toBeLessThanOrEqual(30);
    expect(plan.target.walk).toBe(true);
    expect(plan.line).toMatch(/under a roof/);
  });

  it('the goal fully under a big roof (60 x 60, 5 above the ground): no corridor reaches the middle; the cell is open ground outside the roof edge with a path', async () => {
    const w = world([{ from: { x: -30, y: FEET + 5, z: -30 }, to: { x: 30, y: FEET + 5, z: 30 }, solid: true }]);
    // the ground walks to the middle, the roof's top does not
    const probe = (from: { x: number; y: number; z: number }): Promise<ProbeOutcome> => Promise.resolve(from.y === FEET ? { status: 'found', blocks: Math.hypot(from.x, from.z) + 1 } : { status: 'none' });
    const plan = await findLanding({ x: 0, y: FEET, z: 0 }, 'hall', { look: w.look, obstacle: (x, y, z) => w.solid.solidAt(x, y, z) === true, probe }, OPTS);
    expect(plan.kind, plan.line).toBe('cell');
    if (plan.kind !== 'cell') return;
    console.log(plan.line);
    // either the open ground beyond the edge or a cell near the edge with a short corridor (12 blocks at most under it)
    expect(Math.max(Math.abs(plan.cell.x), Math.abs(plan.cell.z))).toBeGreaterThanOrEqual(19);
  });

  it('nothing confirmed (the probe finds no path anywhere): the nearest dry ground, said as a fallback; over the open sea with an island, the island', async () => {
    const f = farm({ island: true });
    const none = (): Promise<ProbeOutcome> => Promise.resolve({ status: 'none' });
    const plan = await findLanding(f.goal, 'gunpowder', { look: f.look, obstacle: (x, y, z) => f.solid.solidAt(x, y, z) === true, probe: none, dryGround: (x, z) => f.dryGround(x, z) }, OPTS);
    expect(plan.kind, plan.line).toBe('fallback');
    if (plan.kind !== 'fallback') return;
    expect(plan.cell.feet).not.toBe(FEET); // never the sea floor
    expect(plan.line).toMatch(/none confirmed/);
  });

  it('the goal not loaded: unknown (the flight holds); partly loaded around it: unknown too', async () => {
    const f = farm();
    const unloaded: BlockLookup = () => undefined;
    expect((await findLanding(f.goal, 'g', { look: unloaded, obstacle: () => false }, OPTS)).kind).toBe('unknown');
    const half: BlockLookup = (x, y, z) => (x < 0 ? undefined : f.look(x, y, z));
    expect((await findLanding(f.goal, 'g', { look: half, obstacle: () => false, probe: f.probe }, OPTS)).kind).toBe('unknown');
  });

  it('a walk landing: a touchdown anywhere in the cells costs little, a slide out of them a lot; onTarget follows the cells', () => {
    const cells = new Set<number>();
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) cells.add(columnKey(x, z));
    const t: LandingTarget = { x: 0.5, z: 0.5, top: FEET, half: 3, cells, walk: true };
    expect(onTarget(t, { x: 2.9, z: -1.5 })).toBe(true);
    expect(onTarget(t, { x: 3.1, z: 0 })).toBe(false);
    const td = (x: number, vx: number) => ({ kind: 'landed' as const, pos: { x, y: FEET, z: 0.5 }, vel: { x: vx, y: -0.1, z: 0 }, ticks: 50, off: Math.abs(x - 0.5) });
    // 2 blocks off the centre, slow, the slide (the model's plus the server's 0.8) staying inside: about the cost of 2 blocks of walk
    expect(touchdownCost(td(-0.5, -0.05), t)).toBeLessThan(2);
    // the same towards the edge: the slide leaves the cells
    expect(slideOut(t, { x: 2.5, z: 0.5 }, { x: 0.4, z: 0 }, 1.3)).toBeGreaterThan(0);
    expect(touchdownCost(td(2.5, 0.4), t)).toBeGreaterThan(touchdownCost(td(-0.5, -0.4), t) + 10);
    // the exact landing's cost for the same off-centre touchdown is higher
    const exact: LandingTarget = { x: 0.5, z: 0.5, top: FEET, half: 1 };
    expect(touchdownCost(td(-0.5, -0.05), exact)).toBeGreaterThan(touchdownCost(td(-0.5, -0.05), t) + 1);
    void simulateProfile;
  });
});

describe('fly: landing v3, whole trips on stepBody (Track BF)', () => {
  it('the farm from 300 blocks on the far side (behind the box): out to the corridor, in under the box, lands on the platform without a hit', async () => {
    const f = farm();
    const plan = await findLanding(f.goal, 'gunpowder', { look: f.look, obstacle: (x, y, z) => f.solid.solidAt(x, y, z) === true, probe: f.probe }, OPTS);
    if (plan.kind !== 'cell') throw new Error(plan.line);
    const results = [];
    for (const seed of [5, 11, 23]) {
      const r = trip(f, { x: -300.5, y: FEET + 7, z: f.cz + 0.5 }, plan.target, { seed });
      results.push(`seed ${seed}: ${r.end.ok ? 'ok' : r.end.reason} at ${r.body.pos.x.toFixed(1)} ${r.body.pos.y.toFixed(1)} ${r.body.pos.z.toFixed(1)}, ${r.rockets} rockets, ${r.goArounds} go-arounds, hits ${r.hits}, ${r.ticks} ticks; ${r.notes.join(' | ')}`);
      expect(r.hits, results.join('\n')).toBe(0);
      expect(r.end.ok, results.join('\n')).toBe(true);
      expect(r.body.pos.y).toBeCloseTo(f.Y, 1);
      expect(onTarget(plan.target, r.body.pos), results.join('\n')).toBe(true);
    }
    console.log(results.join('\n'));
  });

  it('hold: a target that is not landable yet is circled high (no landing) until the retarget, then landed', () => {
    const w = world([]);
    const goal: LandingTarget = { x: 0.5, z: 300.5, top: FEET, half: 1, hold: true };
    let held = 0;
    const r = trip(w, { x: 0.5, y: FEET, z: 0.5 }, goal, {
      retarget: (t) => {
        if (t === 1200) {
          held = t;
          return { x: 4.5, z: 300.5, top: FEET, half: 1 };
        }
        return undefined;
      },
    });
    expect(held).toBe(1200);
    expect(r.holdTicks).toBeGreaterThan(200);
    expect(r.ticks).toBeGreaterThan(1200);
    expect(r.end.ok).toBe(true);
    expect(r.notes.some((n) => n.startsWith('holding over'))).toBe(true);
  });
});
