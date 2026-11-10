// Track F9a (docs/flight.md "Cave exit (Track F9a)", decisions/0077-cave-exit.md): the route takeoff proven with the
// climb after it. The Realm, 2026-11-09: out of a cave the route takeoff planned a way to a cell with 16 of air over it
// (the cave's hall), the climb turned to the goal's heading there and met the hill 14 ticks on, every trip. Guarded
// here on synthetic worlds (nothing of the owner's cave): the hall whose exits prove nothing (refused; with the ways
// out, flown through the mouth), an exit under open sky beside a cliff on the goal's heading (a line that clears), the
// first rocket held for the server's glide, and a rocket entity matched where the rocket was used.
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../src/connection/types.ts';
import { FlightController, ROCKET_GLIDE_WAIT, type FlightLoop } from '../../../src/skills/fly/controller.ts';
import { PROOF_BURNS, routeTakeoff, routeTakeoffOptions, simulateFlight, type SimDeps } from '../../../src/skills/fly/glide.ts';
import { cruiseHeight, type CellQuery, type LandingTarget } from '../../../src/skills/fly/plan.ts';
import { ROCKET_ADD_WITHIN, RocketHand } from '../../../src/skills/fly/rocket.ts';
import { gridOf } from '../../../src/skills/fly/route/grid.ts';
import { planRoute } from '../../../src/skills/fly/route/search.ts';
import { exitsFrom, exitsToTry, EXIT_APART, planTakeoffRoute, waysOut, type TakeoffProof, type TakeoffRoute } from '../../../src/skills/fly/route/takeoff.ts';
import type { InputLoopEvent, InputLoopState } from '../../../src/skills/input/inputLoop.ts';
import { flatWorld, withBoxes, type BlockBox, type BlockQuery } from '../../../src/skills/input/index.ts';
import type { EntityInfo } from '../../../src/world/types.ts';

const FEET = -60;
/** The searches' wall-clock budget here: none that matters (their nodes bound them: a loaded machine must find the same plans). */
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
  return { world, deps, grid, skyTop };
}

/**
 * A cave under a mesa 46 high: a hall 17 x 17 and 20 high (every floor cell has 16 of air over it: an "exit" by the
 * flood's rule, and none of them is one), and a passage 9 wide and 10 high from its west wall out to the open air.
 */
const cave = (): BlockBox[] => [
  { from: { x: -40, y: FEET, z: -40 }, to: { x: 40, y: FEET + 45, z: 40 }, solid: true },
  { from: { x: -8, y: FEET, z: -8 }, to: { x: 8, y: FEET + 19, z: 8 }, solid: false },
  { from: { x: -40, y: FEET, z: -4 }, to: { x: -9, y: FEET + 9, z: 4 }, solid: false },
];
/** A slab 7 x 7 three over the start on open ground, and a cliff 50 high across the goal's heading from 10 blocks out. */
const cliff = (): BlockBox[] => [
  { from: { x: -3, y: FEET + 3, z: -3 }, to: { x: 3, y: FEET + 3, z: 3 }, solid: true },
  { from: { x: -30, y: FEET, z: 10 }, to: { x: 30, y: FEET + 49, z: 50 }, solid: true },
];

const target: LandingTarget = { x: 0.5, z: 600.5, top: FEET, half: 1 };

/** The proof as commands-fly.ts wires it (the in-thread planner). */
function prover(r: ReturnType<typeof rig>, from: Vec3, cruiseY: number, count?: { sims: number }): TakeoffProof {
  return async (route: TakeoffRoute) => {
    const p = await routeTakeoff(r.deps, from, target, { cruiseY }, 64, { route: { grid: r.grid, plan: (req) => planRoute(req, r.grid), maxMs: SLOW }, takeoff: routeTakeoffOptions(route, true) }, { planTicks: route.ticks });
    if (count) count.sims += p.sims;
    return p;
  };
}

/** The takeoff flown on stepBody for 300 ticks at `burn`, as the proof flies it. */
function fly(r: ReturnType<typeof rig>, from: Vec3, cruiseY: number, route: TakeoffRoute, curve: boolean, burn?: number) {
  const notes: string[] = [];
  return simulateFlight(r.deps, from, target, { cruiseY, takeoffYaw: route.yaw, route: { grid: r.grid, plan: (req) => planRoute(req, r.grid), maxMs: SLOW }, routeTakeoff: routeTakeoffOptions(route, curve), note: (m) => notes.push(m) }, { rockets: 64, yaw: route.yaw, maxTicks: 300 + route.ticks, until: (b) => b.phase === 'approach', ...(burn !== undefined ? { burn } : {}) }).then((sim) => ({ sim, notes }));
}

describe('the route takeoff proven with the climb after it (Track F9a)', () => {
  it('the hall never has open sky over the body: the proven climb keeps the exit\'s line and never turns to the goal (and is refused for what it meets)', async () => {
    const r = rig(cave());
    const from = { x: 4.5, y: FEET, z: 4.5 };
    const cz = cruiseHeight(from, target, r.skyTop, {});
    const hall = (await planTakeoffRoute(r.grid, from, target, { rockets: 4, maxMs: SLOW })).route!;
    const { sim, notes } = await fly(r, from, cz.y, hall, true);
    const line = notes.join(' | ');
    expect(sim.stats.routeTakeoffEnd, line).toBe('out');
    expect(sim.stats.routeSkyAt, line).toBeUndefined();
    expect(sim.stats.routeHeadingAt, line).toBeUndefined();
    expect(sim.end !== undefined || sim.hits > 0, line).toBe(true);
  });

  it("the Realm's failure: in a hall every floor cell is an exit, the unproven takeoff flies to one and its climb ends `roof`", async () => {
    const r = rig(cave());
    const from = { x: 4.5, y: FEET, z: 4.5 };
    const cz = cruiseHeight(from, target, r.skyTop, {});
    expect(exitsFrom(r.grid, from).length).toBeGreaterThan(50);
    const old = await planTakeoffRoute(r.grid, from, target, { rockets: 4, maxMs: SLOW });
    expect(old.route, old.tried.join('; ')).toBeDefined();
    expect(old.route!.proven).toBeUndefined();
    const { sim, notes } = await fly(r, from, cz.y, old.route!, false);
    const line = `${sim.end ? (sim.end.ok ? 'ok' : sim.end.reason) : sim.phase}, ${sim.hits} hits: ${notes.join(' | ')}`;
    expect(sim.stats.routeTakeoffEnd, line).toBe('out');
    expect(sim.end && !sim.end.ok ? sim.end.reason : undefined, line).toBe('roof');
    expect(notes.some((n) => n.includes('nothing clears the solid ahead in the climb')), line).toBe(true);
  });

  it('proven, the hall has no takeoff: every exit tried is refused with what its climb met, in one line each', async () => {
    const r = rig(cave());
    const from = { x: 4.5, y: FEET, z: 4.5 };
    const cz = cruiseHeight(from, target, r.skyTop, {});
    const count = { sims: 0 };
    const got = await planTakeoffRoute(r.grid, from, target, { rockets: 4, maxMs: SLOW, prove: prover(r, from, cz.y, count) });
    expect(got.route, got.tried.join('; ')).toBeUndefined();
    expect(got.tried.length).toBeGreaterThan(0);
    for (const t of got.tried) expect(t).toMatch(/the climb after it: .*: refused$/);
    // an exit beside a refused one is the same opening: not tried again (three cells of one hall were three proofs)
    expect(got.tried.length).toBeLessThanOrEqual(3);
    expect(count.sims).toBeLessThanOrEqual(got.tried.length * (1 + PROOF_BURNS.length));
  });

  it('the ways out: the flood stays under the roof and ends at the mouth; the takeoff through it is proven at every burn and flies out with no hit', async () => {
    const r = rig(cave());
    const from = { x: 4.5, y: FEET, z: 4.5 };
    const cz = cruiseHeight(from, target, r.skyTop, {});
    const ways = waysOut(r.grid, from, Math.ceil(cz.y));
    expect(ways.ways.length).toBeGreaterThan(0);
    // the cell under the real sky just outside the mouth, reached along the passage; the flood is the cave's size, not the sky's
    expect(ways.ways[0]!.x).toBe(-41);
    expect(ways.ways[0]!.way.length).toBeGreaterThan(30);
    expect(ways.cells).toBeLessThan(12_000);
    const got = await planTakeoffRoute(r.grid, from, target, { rockets: 4, maxMs: SLOW, prove: prover(r, from, cz.y), far: { top: Math.ceil(cz.y), maxMs: SLOW } });
    const said = got.tried.join('; ');
    expect(got.route, said).toBeDefined();
    expect(got.route!.proven, said).toBe(true);
    expect(got.route!.pieces, said).toBeDefined();
    expect(got.route!.goals.length, said).toBeGreaterThan(1);
    expect(said).toMatch(/the way out at -41 .*the climb after it: clear at burns of 15, 9, 21, 12, 18 ticks/);
    for (const burn of [undefined, 9, 21]) {
      const { sim, notes } = await fly(r, from, cz.y, got.route!, true, burn);
      const line = `burn ${burn ?? 15}: ${sim.end ? (sim.end.ok ? 'ok' : sim.end.reason) : sim.phase}, ${sim.hits} hits at ${sim.body.pos.x.toFixed(0)} ${sim.body.pos.y.toFixed(0)} ${sim.body.pos.z.toFixed(0)}: ${notes.join(' | ')}`;
      expect(sim.stats.routeTakeoffEnd, line).toBe('out');
      expect(sim.hits, line).toBe(0);
      expect(sim.end, line).toBeUndefined();
      // out of the mesa's footprint or over it, still flying
      expect(Math.abs(sim.body.pos.x) > 40 || Math.abs(sim.body.pos.z) > 40 || sim.body.pos.y > FEET + 46, line).toBe(true);
      // two phases: first out (open sky over the body, only after the last goal), and the turn to the goal only after that
      expect(sim.stats.routeSkyAt, line).toBeGreaterThanOrEqual(sim.stats.routeTakeoffTicks!);
      expect(sim.stats.routeHeadingAt ?? Infinity, line).toBeGreaterThanOrEqual(sim.stats.routeSkyAt!);
      expect(notes.some((n) => n.includes('open sky over the body')), line).toBe(true);
    }
  }, 120_000);

  it('the hill case: an exit under open sky with a cliff across the goal\'s heading: a line that clears is proven and flown, the heading turned only as the path clears', async () => {
    const r = rig(cliff());
    const from = { x: 0.5, y: FEET, z: 0.5 };
    const cz = cruiseHeight(from, target, r.skyTop, {});
    const got = await planTakeoffRoute(r.grid, from, target, { rockets: 4, maxMs: SLOW, prove: prover(r, from, cz.y) });
    const said = got.tried.join('; ');
    expect(got.route, said).toBeDefined();
    expect(got.route!.proven, said).toBe(true);
    expect(got.route!.out, said).toBeGreaterThan(0);
    expect(got.route!.score, said).toBeGreaterThan(0);
    for (const burn of [undefined, 9, 21]) {
      const { sim, notes } = await fly(r, from, cz.y, got.route!, true, burn);
      const line = `burn ${burn ?? 15}: ${sim.end ? (sim.end.ok ? 'ok' : sim.end.reason) : sim.phase}, ${sim.hits} hits: ${notes.join(' | ')}`;
      expect(sim.stats.routeTakeoffEnd, line).toBe('out');
      // (the slab's edge may be touched from below on the way out: a head bump, not a hit)
      expect(sim.hits - (sim.bumps ?? 0), line).toBe(0);
      expect(sim.end, line).toBeUndefined();
      expect(sim.stats.routeExitYaw, line).toBeDefined();
      // the cliff is 50 high across the goal's heading: the heading reached the goal's only above it
      expect(sim.stats.routeHeadingAt, line).toBeDefined();
      expect(sim.stats.routeHeadingAt!, line).toBeGreaterThanOrEqual(sim.stats.routeSkyAt!);
      expect(sim.stats.maxY, line).toBeGreaterThan(FEET + 50);
    }
  }, 120_000);

  it('exitsToTry: the nearest, then exits EXIT_APART from every one chosen, then the nearest other columns', () => {
    const e = (x: number, z: number, steps: number) => ({ x, y: 0, z, steps, dist: Math.hypot(x, z) });
    const one = [e(1, 0, 1), e(2, 0, 2), e(1, 1, 2), e(3, 0, 3)];
    expect(exitsToTry(one, 3).map((q) => `${q.x},${q.z}`)).toEqual(['1,0', '2,0', '1,1']); // one opening: as before
    const two = [e(1, 0, 1), e(2, 0, 2), e(1, 1, 2), e(1 + EXIT_APART, 0, 9), e(2 + EXIT_APART, 0, 10)];
    expect(exitsToTry(two, 3).map((q) => `${q.x},${q.z}`)).toEqual(['1,0', `${1 + EXIT_APART},0`, '2,0']); // the other opening before a second cell of the first
  });
});

/** A FlightLoop stand-in whose server confirms the glide `confirmAfter` gliding ticks after the local model took it (never: undefined). */
function fakeLoop(start: Vec3, confirmAfter: number | undefined) {
  const state = { pos: { ...start }, vel: { x: 0, y: 0, z: 0 }, onGround: true, collidedHorizontally: false, collidedVertically: false, corrections: 0, motions: 0, sprinting: false, inWater: false, inLava: false, gliding: false, boostTicks: 0, teleports: 0 } as unknown as InputLoopState;
  const steps = new Set<(t: bigint, s: InputLoopState) => void>();
  const events = new Set<(e: InputLoopEvent) => void>();
  const cmd = { yaw: 0, pitch: 0, jump: false, glide: false };
  let t = 0n;
  let gliding = 0;
  const loop: FlightLoop = {
    state,
    world: { solidAt: (_x, y) => y < 60 },
    command: cmd,
    setCommand: (c) => Object.assign(cmd, c),
    onBeforeStep: (fn) => (steps.add(fn), () => steps.delete(fn)),
    onEvent: (fn) => (events.add(fn), () => events.delete(fn)),
    boost: () => {
      state.boostTicks = 15;
    },
    endBoost: () => {
      state.boostTicks = 0;
    },
    waitTicks: () => Promise.resolve(),
  };
  const tick = (): void => {
    t++;
    for (const fn of [...steps]) fn(t, state);
    if (cmd.jump && state.onGround) {
      state.onGround = false;
      state.vel = { x: 0, y: 0.42, z: 0 };
    } else if (!state.onGround) {
      state.vel = { x: 0, y: state.gliding ? 0.05 : state.vel.y - 0.08, z: 0 };
      if (cmd.glide && state.vel.y < 0.3) state.gliding = true;
    }
    state.pos = { x: state.pos.x, y: state.pos.y + state.vel.y, z: state.pos.z };
    if (state.boostTicks > 0) state.boostTicks--;
    if (state.gliding && ++gliding === confirmAfter) for (const fn of [...events]) fn({ kind: 'glide', gliding: true, tick: t, replayed: 0 });
  };
  return { loop, tick, glidingTicks: () => gliding };
}

describe('the first rocket waits for the server\'s glide (Track F9a, controller.ts)', () => {
  const far = { x: 300.5, z: 0.5, top: 60, half: 1 };
  const run = (confirmAfter: number | undefined) => {
    const { loop, tick, glidingTicks } = fakeLoop({ x: 20.5, y: 60, z: 5.5 }, confirmAfter);
    let firedAt: number | undefined;
    const slots = [{ name: 'firework_rocket', count: 64, networkId: 1000 }, ...Array.from({ length: 35 }, () => null)];
    const c = new FlightController({
      loop,
      queue: (name) => {
        if (name === 'inventory_transaction') firedAt ??= glidingTicks();
      },
      inventory: { slots, selected: 0, rawItem: () => undefined } as never,
      hotbar: { select: () => true, rawItem: () => undefined },
      entities: { onAdd: () => () => {}, onRemove: () => () => {} },
      health: () => 20,
      elytraLeft: () => 400,
    });
    void c.flyTo(far, { cruiseY: 120, vertical: { top: 30 } });
    for (let i = 0; i < 40 && firedAt === undefined; i++) tick();
    c.dispose();
    return firedAt;
  };

  it('no rocket before the flag; the rocket on the tick after it', () => {
    // (the vertical takeoff asks for a rocket on its first gliding tick: before this track it went then)
    expect(run(4)).toBe(4);
    expect(run(2)).toBe(2);
  });

  it(`a flag that never comes: the rocket goes once ${ROCKET_GLIDE_WAIT} gliding ticks have passed, as it went before`, () => {
    expect(run(undefined)).toBe(ROCKET_GLIDE_WAIT + 1);
  });
});

describe('a rocket entity is matched where the rocket was used (Track F9a, rocket.ts)', () => {
  const hand = () => {
    const state = { pos: { x: 0, y: 100, z: 0 } };
    let add: ((e: EntityInfo) => void) | undefined;
    let boosted = 0;
    let ended = 0;
    const notes: string[] = [];
    const log = { debug: () => {}, info: (m: string) => notes.push(m), warn: () => {}, error: () => {} };
    const slots = [{ name: 'firework_rocket', count: 64, networkId: 1000 }, ...Array.from({ length: 35 }, () => null)];
    const h = new RocketHand({
      loop: { state, boost: () => void boosted++, endBoost: () => void ended++ },
      queue: () => {},
      inventory: { slots, selected: 0, rawItem: () => undefined } as never,
      hotbar: { select: () => true, rawItem: () => undefined },
      entities: { onAdd: (fn) => ((add = fn), () => {}), onRemove: () => () => {} },
      log,
    });
    let now = 0;
    h.attach(() => now);
    const rocket = (pos: Vec3): EntityInfo => ({ type: 'minecraft:fireworks_rocket', pos, uniqueId: 7n }) as unknown as EntityInfo;
    return { h, state, notes, at: (t: number) => ((now = t), h.tick(t)), add: (pos: Vec3) => add!(rocket(pos)), ended: () => ended };
  };

  it('ours when it appears where the body used the rocket, the local body a round trip of ticks farther on', () => {
    const k = hand();
    k.at(10);
    k.h.fire(0, { ...k.state.pos }, 10);
    // 4 ticks at 1.7 a tick later: the body is 6.8 on, the entity where the server's body used the rocket
    k.state.pos = { x: 6.8, y: 100, z: 0 };
    k.at(14);
    k.add({ x: 0.2, y: 100.5, z: 0 });
    k.at(10 + ROCKET_ADD_WITHIN + 2);
    expect(k.h.wasted).toBe(0);
    expect(k.h.burning).toBe(true);
    expect(k.ended()).toBe(0);
  });

  it('a rocket entity far from both is not ours, and one that comes for a use already written off is said to have fired', () => {
    const k = hand();
    k.at(10);
    k.h.fire(0, { ...k.state.pos }, 10);
    k.at(12);
    k.add({ x: 40, y: 100, z: 0 });
    expect(k.notes.some((n) => n.includes('not taken as ours'))).toBe(true);
    k.at(10 + ROCKET_ADD_WITHIN + 1);
    expect(k.h.wasted).toBe(1);
    expect(k.notes.some((n) => n.includes('fired nothing'))).toBe(true);
    k.at(10 + ROCKET_ADD_WITHIN + 3);
    k.add({ x: 0.5, y: 100.2, z: 0 });
    expect(k.h.late).toBe(1);
    expect(k.notes.some((n) => n.includes('that rocket did fire'))).toBe(true);
  });
});
