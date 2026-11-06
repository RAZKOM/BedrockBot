// Track F4b (docs/flight.md "Corridor flight"): the flight's coarse costs, the stretches and windows of a fly leg,
// the chain of trackers flown offline on stepBody through the corridor world, and the executor's leg logic over
// stub corridors and stub flights.
import { describe, expect, it } from 'vitest';
import { stepBody, wallImpactDamage } from '../../../src/skills/input/physics.ts';
import { IDLE_COMMAND, initialBody, type BlockQuery, type BodyState, type MoveCommand } from '../../../src/skills/input/types.ts';
import { rng } from '../../../src/skills/fly/route/courses.ts';
import { gridOf, sweep } from '../../../src/skills/fly/route/grid.ts';
import { planRoute } from '../../../src/skills/fly/route/search.ts';
import { BURN, type RouteGoal } from '../../../src/skills/fly/route/types.ts';
import { FlightCost, flightSpace, LANDING_TICKS, ROCKET_TICKS, skyTicks, TAKEOFF_TICKS, tunnelTicks } from '../../../src/skills/fly/corridor/cost.ts';
import { portalOf, volumeOf, type CorridorProvider } from '../../../src/skills/fly/corridor/coarse-port.ts';
import { TrackerChain, STRETCH_WEIGHT } from '../../../src/skills/fly/corridor/drive.ts';
import { CorridorExecutor, UNDER_FLY, UNKNOWN_FLY_MAX, type CorridorPorts, type StepOutcome } from '../../../src/skills/fly/corridor/executor.ts';
import { corridorWanted, CORRIDOR_MIN } from '../../../src/skills/fly/corridor/registry.ts';
import { changeCell, nextWindow, splitLeg, type Stretch, type Window } from '../../../src/skills/fly/corridor/stretches.ts';
import type { Vec3 } from '../../../src/world/types.ts';
import { CoarseLayerImpl, terrainSource } from '../../../src/skills/coarse/index.ts';
import { flatGen } from './genworld.ts';
import { corridorLines, corridorWorld, F, SHAFT_AT, type CorridorWorld } from './fly-corridor-world.ts';

interface ChainRun {
  end: string;
  ticks: number;
  rockets: number;
  hits: number;
  damage: number;
  minClearance: number;
  reached: number;
  goals: number;
  windows: number;
  plans: number;
  replans: number;
  partial: number;
  at: { x: number; y: number; z: number };
}

/**
 * The chain flown on stepBody (route/bench.ts flyCourse's harness: the burn drawn 9..21, its end told 3 ticks late, the
 * glide from the 2nd airborne input). A wall touch does not end the flight (BDS keeps the glide): it is counted with
 * the damage the envelope gives it (wallImpactDamage of the horizontal speed lost). Node budgets only (no ms), so the
 * runs are the same on every machine.
 */
function flyChain(world: BlockQuery, start: { x: number; y: number; z: number; yaw: number }, goals: RouteGoal[], margin: number, o: { seed?: number; maxTicks?: number; note?: (m: string) => void } = {}): ChainRun {
  const r = rng(o.seed ?? 1);
  const grid = gridOf(world);
  const chain = new TrackerChain({ grid, margin, goals, plan: (req) => planRoute(req, grid), maxNodes: 40_000, maxMs: 1e9, weight: STRETCH_WEIGHT, landLibrary: 'landing', yaw: start.yaw, ...(o.note ? { note: o.note } : {}) });
  let body: BodyState = initialBody({ x: start.x, y: start.y, z: start.z }, true);
  let rockets = 16;
  const endsAt: number[] = [];
  let hits = 0;
  let damage = 0;
  let minClearance = Infinity;
  let end = 'timeout';
  let falling = 0;
  let t = 1;
  const max = o.maxTicks ?? 900;
  for (; t <= max; t++) {
    while (endsAt.length && endsAt[0]! <= t) {
      endsAt.shift();
      chain.rocketEnded();
    }
    const out = chain.tick({ pos: body.pos, vel: body.vel, gliding: body.gliding === true, onGround: body.onGround, rockets, boostTicks: body.boostTicks ?? 0 }, t);
    if (out.done) {
      end = 'done';
      break;
    }
    if (out.status === 'failed') {
      end = 'failed';
      break;
    }
    const c = out.control;
    if (body.onGround) falling = 0;
    else falling++;
    const cmd: MoveCommand = { ...IDLE_COMMAND, yaw: c.yaw, pitch: c.pitch, jump: c.jump === true, glide: body.gliding === true || body.onGround || falling >= 2 };
    if (c.fire && rockets > 0 && (body.boostTicks ?? 0) === 0) {
      const burn = BURN.min + Math.floor(r() * (BURN.max - BURN.min + 1));
      cmd.boostStart = burn;
      rockets--;
      endsAt.push(t + burn + 3);
    }
    const before = body;
    body = stepBody(body, cmd, world).state;
    if (before.gliding) {
      const sw = sweep(grid, before.pos, body.pos, 0);
      if (sw.clearance < minClearance) minClearance = sw.clearance;
      if (body.collidedHorizontally) {
        hits++;
        damage += wallImpactDamage(Math.hypot(before.vel.x, before.vel.z), Math.hypot(body.vel.x, body.vel.z));
      } else if (body.collidedVertically && !body.onGround) hits++;
      if (body.onGround) {
        const fin = chain.tick({ pos: body.pos, vel: body.vel, gliding: false, onGround: true, rockets, boostTicks: 0 }, t + 1);
        end = fin.done ? 'done' : 'ground';
        break;
      }
    }
  }
  const s = chain.stats;
  return { end, ticks: t, rockets: 16 - rockets, hits, damage, minClearance: minClearance === Infinity ? 0 : minClearance, reached: chain.reached, goals: goals.length, windows: chain.windows, plans: s.plans, replans: s.replans, partial: s.partial, at: { ...body.pos } };
}

const line = (name: string, r: ChainRun): string =>
  `${name}: ${r.end} ${r.reached}/${r.goals}, ${r.ticks} ticks, ${r.rockets} rockets, ${r.hits} hits (damage ${r.damage.toFixed(1)}), ${r.windows} windows, ${r.plans} plans (${r.replans} re, ${r.partial} partial), at ${r.at.x.toFixed(1)} ${r.at.y.toFixed(1)} ${r.at.z.toFixed(1)}`;

function stretchesOf(w: CorridorWorld): Stretch[] {
  const stub = w.stub();
  return splitLeg(w.corridor.legs[0]!, (p) => {
    const v = stub.volumeAt(p);
    return v ? flightSpace(v) : undefined;
  });
}

describe('fly legs into stretches and windows (stretches.ts)', () => {
  const w = corridorWorld({ x: 1000, z: 2000 });
  const solid = (x: number, y: number, z: number) => w.solidAt(x, y, z);
  const st = stretchesOf(w);

  it('cuts the fly leg at the mouth into the sky and the bore', () => {
    expect(st.map((s) => s.space)).toEqual(['sky', 'under']);
    expect(st[0]!.leave).toBe(w.mouth);
    expect(st[1]!.enter).toBe(w.mouth);
    expect(st[1]!.portals.length).toBe(w.tunnelPortals.length);
    expect(st[1]!.end).toEqual(w.flyEnd);
  });

  it('lands the sky stretch on the cell just inside the mouth', () => {
    expect(changeCell(w.mouth, w.start, st[1]!.points[1]!, 'under', solid)).toEqual({ x: w.mouthX + 2, y: F, z: w.start.z });
  });

  it('ends the bore window before the bend when the tail after it is short, and flies the bend when it is long', () => {
    const land = { x: w.mouthX + 2, y: F, z: w.start.z };
    const short = nextWindow(st[1]!, land, { loaded: () => true, solid, endCell: w.flyEnd })!;
    expect(short.cut).toBe(true);
    // the last straight portal before the bend (x = 16k, 6 or more before it) is the landing
    const lastX = w.tunnelPortals.filter((p) => p.axis === 'x').at(-1)!;
    expect(short.end.x).toBe(lastX.center.x);
    expect(short.goals.at(-1)!.kind).toBe('landing');
    expect(short.goals.some((g) => g.kind === 'waypoint' && g.box.min.z > w.start.z + 2)).toBe(false); // nothing past the bend
    const long = nextWindow(st[1]!, land, { loaded: () => true, solid, endCell: w.flyEnd, tailMin: 0 })!;
    expect(long.cut).toBe(false);
    expect(long.end).toEqual(w.flyEnd);
    expect(long.goals.length).toBeGreaterThan(short.goals.length);
    expect(long.margin).toBe(0.3);
  });

  it('finds the portals of the waypoints by their centres (a leg with an entry, as the layer assembles it)', () => {
    // the layer lists the entry (and the exit) in `portals`, the waypoints hold only the portals crossed inside
    const leg0 = w.corridor.legs[0]!;
    const entry = portalOf({ a: 'x', b: 'y', axis: 'x', center: { x: w.start.x - 6, y: F, z: w.start.z }, height: 3, width: 3, floorY: F });
    const st2 = splitLeg({ ...leg0, entry, portals: [entry, ...leg0.portals] }, (p) => {
      const v = w.stub().volumeAt(p);
      return v ? flightSpace(v) : undefined;
    });
    expect(st2.map((s) => s.space)).toEqual(['sky', 'under']);
    expect(st2[0]!.leave).toBe(w.mouth);
    expect(st2[1]!.portals).toEqual(w.tunnelPortals);
  });

  it('cuts a window at the first portal that is not loaded and lands on the floor of the last loaded one', () => {
    const land = { x: w.mouthX + 2, y: F, z: w.start.z };
    const edge = w.tunnelPortals[3]!.center.x;
    const win = nextWindow(st[1]!, land, { loaded: (x) => x < edge, solid, endCell: w.flyEnd })!;
    expect(win.cut).toBe(true);
    expect(win.end.x).toBe(w.tunnelPortals[2]!.center.x);
    // the next window from there goes on past it
    const next = nextWindow(st[1]!, { x: win.end.x + 0.5, y: win.end.y, z: win.end.z + 0.5 }, { loaded: () => true, solid, endCell: w.flyEnd })!;
    expect(next.portals[0]).toBe(w.tunnelPortals[3]);
  });
});

describe('corridor stretches flown offline (stepBody, the chain of trackers)', () => {
  it('flies the 140-block bore from standing inside the mouth and lands before the bend (3 seeds)', { timeout: 120_000 }, () => {
    const w = corridorWorld({ x: 1000, z: 2000 });
    const solid = (x: number, y: number, z: number) => w.solidAt(x, y, z);
    const st = stretchesOf(w);
    const land = changeCell(w.mouth, w.start, st[1]!.points[1]!, 'under', solid)!;
    const win = nextWindow(st[1]!, land, { loaded: () => true, solid, endCell: w.flyEnd })!;
    for (const seed of [1, 2, 3]) {
      const r = flyChain({ solidAt: solid }, { x: land.x + 0.5, y: land.y, z: land.z + 0.5, yaw: -90 }, win.goals, win.margin, { seed });
      console.log(line(`bore, seed ${seed}`, r));
      expect(r.end).toBe('done');
      expect(r.damage).toBe(0);
      expect(r.windows).toBeGreaterThan(1);
    }
  });

  it('flies a bend with a long tail after it and lands 60 blocks on (recorded)', { timeout: 120_000 }, () => {
    const w = corridorWorld({ x: 1000, z: 2000 }, { after: 70 });
    const solid = (x: number, y: number, z: number) => w.solidAt(x, y, z);
    const st = stretchesOf(w);
    // the window from the last straight portal before the bend (the second window of the bore)
    const lastX = w.tunnelPortals.filter((p) => p.axis === 'x').at(-1)!;
    const from = { x: lastX.center.x - 16, y: F, z: w.start.z };
    const win = nextWindow(st[1]!, from, { loaded: () => true, solid, endCell: w.flyEnd })!;
    expect(win.cut).toBe(false);
    const ends: string[] = [];
    for (const seed of [1, 2, 3]) {
      const r = flyChain({ solidAt: solid }, { x: from.x + 0.5, y: from.y, z: from.z + 0.5, yaw: -90 }, win.goals, win.margin, { seed });
      console.log(line(`bend, seed ${seed}`, r));
      ends.push(r.end);
    }
    expect(ends.filter((e) => e === 'done').length).toBeGreaterThanOrEqual(1);
  });
});

interface Call {
  kind: 'sky' | 'under' | 'walk';
  cell: Vec3;
  label: string;
  win?: Window;
}

/**
 * The executor's ports over the corridor world with stub flights: every flight and walk ends standing on the
 * centre of its cell (a sky cruise 2 rockets, a window 1) unless an override answers for it.
 */
function fakeTrip(w: CorridorWorld, provider: CorridorProvider, o: { sky?: (cell: Vec3, n: number) => StepOutcome | undefined; under?: (win: Window, n: number) => StepOutcome | undefined; underFly?: boolean } = {}) {
  const centre = (c: Vec3): Vec3 => ({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 });
  let pos = centre(w.start);
  const calls: Call[] = [];
  const answer = (f: StepOutcome | undefined, cell: Vec3, ok: StepOutcome): StepOutcome => {
    if (f) {
      if (f.at) pos = { ...f.at };
      return f;
    }
    pos = centre(cell);
    return { ...ok, at: { ...pos } };
  };
  const ports: CorridorPorts = {
    provider,
    position: () => ({ ...pos }),
    dim: () => 0,
    solid: (x, y, z) => w.solidAt(x, y, z),
    loaded: () => true,
    waitLoaded: () => Promise.resolve(true),
    flySky: (cell, label) => {
      calls.push({ kind: 'sky', cell, label });
      return Promise.resolve(answer(o.sky?.(cell, calls.filter((c) => c.kind === 'sky').length), cell, { ok: true, rockets: 2, corrections: 1 }));
    },
    flyUnder: (win, label) => {
      calls.push({ kind: 'under', cell: win.end, label, win });
      return Promise.resolve(answer(o.under?.(win, calls.filter((c) => c.kind === 'under').length), win.end, { ok: true, rockets: 1, corrections: 2, replans: 1 }));
    },
    walk: (cell, label) => {
      calls.push({ kind: 'walk', cell, label });
      return Promise.resolve(answer(undefined, cell, { ok: true }));
    },
    stopped: () => false,
  };
  // the window tests fly underground (the executor's own default since the 2026-11-06 hotfix walks it)
  return { ports, calls, ex: new CorridorExecutor(ports, { underFly: o.underFly ?? true }) };
}

describe('the corridor executor over stub corridors (executor.ts)', () => {
  const origin = { x: 1000, z: 2000 };

  it('flies sky -> mouth -> bore, walks the short tail after the bend and the low section to the goal', async () => {
    const w = corridorWorld(origin);
    const provider = w.stub();
    const t = fakeTrip(w, provider);
    const r = await t.ex.run(w.goal, 'the chamber');
    expect(r.ok).toBe(true);
    expect(t.calls.map((c) => c.kind)).toEqual(['sky', 'under', 'walk', 'walk']);
    // the cruise lands just inside the mouth, the window lands on the last straight portal before the bend
    expect(t.calls[0]!.cell).toEqual({ x: w.mouthX + 2, y: F, z: w.start.z });
    expect(t.calls[0]!.label).toContain('mouth');
    const lastX = w.tunnelPortals.filter((p) => p.axis === 'x').at(-1)!;
    expect(t.calls[1]!.win!.end.x).toBe(lastX.center.x);
    expect(t.calls[1]!.win!.goals.at(-1)!.kind).toBe('landing');
    expect(t.calls[2]!.cell).toEqual(w.flyEnd);
    expect(t.calls[3]!.cell).toEqual(w.goal);
    expect(r.legs.map((l) => `${l.mode}:${l.how}:${l.ok}`)).toEqual(['fly:fly:true', 'walk:walk:true']);
    expect([r.plans, r.replans, r.cruises, r.windows, r.walks, r.rockets, r.corrections, r.trackerReplans]).toEqual([1, 0, 1, 1, 2, 3, 3, 1]);
    expect(r.marks).toEqual([{ id: w.mouth.id, mode: 'fly', outcome: 'ok' }]);
    expect(provider.requests[0]).toMatchObject({ modes: ['walk', 'fly'], startMode: 'walk', goalStanding: true, dim: 0 });
  });

  it('walks the bore by default (hotfix 2026-11-06: no powered flight underground): only the cruise to the mouth is flown', async () => {
    expect(UNDER_FLY).toBe(false);
    const w = corridorWorld(origin);
    const t = fakeTrip(w, w.stub(), { underFly: UNDER_FLY });
    const r = await t.ex.run(w.goal, 'the chamber');
    expect(r.ok).toBe(true);
    expect(t.calls.some((c) => c.kind === 'under')).toBe(false);
    expect(t.calls[0]!.kind).toBe('sky');
    expect(t.calls[0]!.label).toContain('mouth');
    expect(t.calls.slice(1).every((c) => c.kind === 'walk')).toBe(true);
    expect(r.windows).toBe(0);
  });

  it('drops down a shaft: the cruise lands on the bore floor under the roof hole, the bore is flown from there', async () => {
    const w = corridorWorld(origin, { shaft: true });
    const provider = w.stub([w.viaShaft!]);
    const t = fakeTrip(w, provider);
    const r = await t.ex.run(w.goal, 'the chamber');
    expect(r.ok).toBe(true);
    expect(t.calls.map((c) => c.kind)).toEqual(['sky', 'under', 'walk', 'walk']);
    expect(t.calls[0]!.cell).toEqual({ x: w.mouthX + SHAFT_AT, y: F, z: w.start.z });
    expect(t.calls[0]!.label).toContain('shaft');
    // the window starts past the shaft's foot and passes only the portals beyond the hole
    expect(t.calls[1]!.win!.portals.every((p) => p.axis !== 'y' && (p.axis !== 'x' || p.center.x > w.mouthX + SHAFT_AT))).toBe(true);
    expect(r.marks).toEqual([{ id: w.shaft!.id, mode: 'fly', outcome: 'ok' }]);
  });

  it('marks a mouth the cruise failed at and plans again: the second corridor goes in through the shaft', async () => {
    const w = corridorWorld(origin, { shaft: true });
    const provider = w.stub([w.corridor, w.viaShaft!]);
    const crash = { x: w.start.x + 60.5, y: F, z: w.start.z + 0.5 };
    const t = fakeTrip(w, provider, { sky: (cell) => (cell.x === w.mouthX + 2 ? { ok: false, reason: 'hit', at: crash, rockets: 1 } : undefined) });
    const r = await t.ex.run(w.goal, 'the chamber');
    expect(r.ok).toBe(true);
    expect([r.plans, r.replans]).toEqual([2, 1]);
    expect(t.calls.map((c) => c.kind)).toEqual(['sky', 'sky', 'under', 'walk', 'walk']);
    expect(t.calls[1]!.cell).toEqual({ x: w.mouthX + SHAFT_AT, y: F, z: w.start.z });
    expect(r.marks).toEqual([
      { id: w.mouth.id, mode: 'fly', outcome: 'failed' },
      { id: w.shaft!.id, mode: 'fly', outcome: 'ok' },
    ]);
    expect(provider.failed(w.mouth.id, 'fly')).toBe(true);
    // the re-plan starts where the body came down
    expect(provider.requests[1]!.start).toEqual(crash);
    expect(r.legs.map((l) => l.ok)).toEqual([false, true, true]);
  });

  it('walks the rest into the mouth when the cruise lands a few blocks short', async () => {
    const w = corridorWorld(origin);
    const t = fakeTrip(w, w.stub(), { sky: (cell, n) => (n === 1 ? { ok: false, reason: 'landed short', at: { x: cell.x - 9.5, y: F, z: cell.z + 0.5 } } : undefined) });
    const r = await t.ex.run(w.goal, 'the chamber');
    expect(r.ok).toBe(true);
    expect(t.calls.map((c) => c.kind)).toEqual(['sky', 'walk', 'under', 'walk', 'walk']);
    expect(t.calls[1]!.cell).toEqual({ x: w.mouthX + 2, y: F, z: w.start.z });
    expect(r.replans).toBe(0);
  });

  it('walks to a shaft whose cruise ran out of go-arounds 35 off, flies one 100 off again once, and fails it after a second', async () => {
    const w = corridorWorld(origin, { shaft: true });
    const off = (cell: Vec3, dz: number): StepOutcome => ({ ok: false, reason: 'landed_off', at: { x: cell.x - 12.5, y: F, z: cell.z + dz }, rockets: 4 });
    // 35 off (the roof beside the hole, the e2e): the walk takes it there, no second cruise
    const walked = fakeTrip(w, w.stub([w.viaShaft!]), { sky: (cell, n) => (n === 1 ? off(cell, 33.5) : undefined) });
    const r0 = await walked.ex.run(w.goal, 'the chamber');
    expect(r0.ok).toBe(true);
    expect(walked.calls.map((c) => c.kind)).toEqual(['sky', 'walk', 'under', 'walk', 'walk']);
    expect(walked.calls[1]!.cell).toEqual(walked.calls[0]!.cell);
    expect([r0.cruises, r0.replans]).toEqual([1, 0]);
    // 100 off: a second approach from there lands on the cell
    const once = fakeTrip(w, w.stub([w.viaShaft!]), { sky: (cell, n) => (n === 1 ? off(cell, 99.5) : undefined) });
    const r1 = await once.ex.run(w.goal, 'the chamber');
    expect(r1.ok).toBe(true);
    expect(once.calls.map((c) => c.kind)).toEqual(['sky', 'sky', 'under', 'walk', 'walk']);
    expect(once.calls[1]!.cell).toEqual(once.calls[0]!.cell);
    expect([r1.cruises, r1.replans, r1.rockets]).toEqual([2, 0, 4 + 2 + 1]);
    expect(r1.marks).toEqual([{ id: w.shaft!.id, mode: 'fly', outcome: 'ok' }]);
    // both approaches 100 off: the shaft is failed for flight and the stub has no other way
    const twice = fakeTrip(w, w.stub([w.viaShaft!]), { sky: (cell) => off(cell, 99.5) });
    const r2 = await twice.ex.run(w.goal, 'the chamber');
    expect(r2.ok).toBe(false);
    expect(twice.calls.map((c) => c.kind)).toEqual(['sky', 'sky']);
    expect(r2.marks).toEqual([{ id: w.shaft!.id, mode: 'fly', outcome: 'failed' }]);
    expect(r2.reason).toContain('failed portal');
  });

  it('refuses to fly an underground leg through unknown space: the leg is walked', async () => {
    const w = corridorWorld(origin);
    const vols = w.volumes.map((v) => (v.id === '0:cave:a' ? volumeOf(v.id, 'unknown', v.min, v.max, { known: 'unknown' }) : v));
    const provider = w.stub([w.corridor], vols);
    const t = fakeTrip(w, provider);
    const stretches = splitLeg(w.corridor.legs[0]!, (p) => {
      const v = provider.volumeAt(p);
      return v ? flightSpace(v) : undefined;
    });
    expect(t.ex.undergroundUnknown(w.corridor.legs[0]!, stretches)).toBeGreaterThan(UNKNOWN_FLY_MAX);
    const r = await t.ex.run(w.goal, 'the chamber');
    expect(r.ok).toBe(true);
    expect(t.calls.map((c) => c.kind)).toEqual(['walk', 'walk']);
    expect(t.calls[0]!.cell).toEqual(w.flyEnd);
    expect(r.legs.map((l) => l.how)).toEqual(['walk (unknown)', 'walk']);
    expect([r.cruises, r.windows, r.marks.length]).toEqual([0, 0, 0]);
  });

  it('marks the first portal of a window that fails three times and gives up when no corridor is left', async () => {
    const w = corridorWorld(origin);
    const provider = w.stub();
    const t = fakeTrip(w, provider, { under: (win) => ({ ok: false, reason: 'hit', at: { x: win.from.x, y: F, z: win.from.z }, rockets: 1 }) });
    const r = await t.ex.run(w.goal, 'the chamber');
    expect(r.ok).toBe(false);
    expect(r.windows).toBe(3);
    expect(r.marks.at(-1)).toMatchObject({ mode: 'fly', outcome: 'failed' });
    expect(r.marks.at(-1)!.id).toBe(t.calls[1]!.win!.portals[0]!.id);
    expect(r.plans).toBe(2);
    expect(r.reason).toContain('failed portal');
  });
});

describe('FlightCost (cost.ts): flight priced on the coarse graph in ticks', () => {
  const c = new FlightCost();
  const sky = volumeOf('s', 'sky', { x: 0, y: 64, z: 0 }, { x: 63, y: 319, z: 63 });
  const cave3 = volumeOf('c3', 'cave', { x: 64, y: 40, z: 0 }, { x: 127, y: 42, z: 2 });
  const cave2 = volumeOf('c2', 'cave', { x: 64, y: 40, z: 0 }, { x: 127, y: 41, z: 2 });
  const water = volumeOf('w', 'water', { x: 64, y: 40, z: 0 }, { x: 127, y: 50, z: 20 });
  const shaftV = volumeOf('sh', 'cave', { x: 10, y: 30, z: 10 }, { x: 10, y: 39, z: 10 }, { minSpan: 1, headroom: { min: 10, max: 10 } });
  const mouth = (to: string, height: number) => portalOf({ a: 's', b: to, axis: 'x', center: { x: 64, y: 40, z: 1 }, height, width: 3, floorY: 40 });
  const shaft = portalOf({ a: 's', b: 'sh', axis: 'y', center: { x: 10, y: 40, z: 10 }, height: 1, width: 1 });

  it('prices open sky well under a tunnel and under walking (4.6 ticks a block)', () => {
    expect(skyTicks(100)).toBeLessThan(tunnelTicks(100, 3, 3));
    expect(skyTicks(300) / 300).toBeLessThan(1);
    expect(tunnelTicks(100, 3, 3)).toBeLessThan(100 * 4.6);
    expect(tunnelTicks(100, 3, 1)).toBeGreaterThan(tunnelTicks(100, 3, 3));
  });

  it('flies a 2-high opening only as a glide in (a landing just inside), powered flight from 3 high', () => {
    expect(Number.isFinite(c.edgeCost(mouth('c3', 3), sky, cave3, 60))).toBe(true);
    expect(Number.isFinite(c.edgeCost(mouth('c2', 2), sky, cave2, 5))).toBe(true);
    expect(c.edgeCost(mouth('c2', 2), sky, cave2, 20)).toBe(Infinity);
    expect(c.edgeCost(mouth('c3', 1), sky, cave3, 5)).toBe(Infinity);
  });

  it('prices travel from the search start (a pseudo-portal inside the volume) as plain travel, no shaft', () => {
    const start = (v: typeof cave3) => ({ ...portalOf({ a: v.id, b: v.id, axis: 'y', center: { x: 70, y: 40, z: 1 }, height: 16, width: 16 }), floorY: 40 });
    expect(c.edgeCost(start(cave3), cave3, cave3, 40)).toBeCloseTo(tunnelTicks(40, 3, 3));
    expect(c.edgeCost(start(sky), sky, sky, 100)).toBeCloseTo(skyTicks(100));
  });

  it('never flies water', () => {
    expect(c.allows('water')).toBe(false);
    expect(c.edgeCost(mouth('w', 3), sky, water, 10)).toBe(Infinity);
    expect(c.switchCost('walk', water)).toBe(Infinity);
  });

  it('drops down a 1 x 1 shaft (the hover sink) and climbs out of it (the vertical takeoff)', () => {
    const down = c.edgeCost(shaft, sky, shaftV, 10);
    expect(Number.isFinite(down)).toBe(true);
    expect(down).toBeGreaterThan(10 / 0.149);
    expect(Number.isFinite(c.edgeCost(shaft, shaftV, sky, 10))).toBe(true);
  });

  it('refuses a portal the flight failed at and a dig portal, discounts one that worked', () => {
    const plain = c.edgeCost(mouth('c3', 3), sky, cave3, 60);
    expect(c.edgeCost(mouth('c3', 3), sky, cave3, 60, 'failed')).toBe(Infinity);
    expect(c.edgeCost(mouth('c3', 3), sky, cave3, 60, 'ok')).toBeLessThan(plain);
    expect(c.edgeCost({ ...mouth('c3', 3), id: `${mouth('c3', 3).id}:dig`, dug: 2 }, sky, cave3, 60)).toBe(Infinity);
  });

  it('gives the search a heuristic slope under every fly price per block', () => {
    expect(c.ticksPerBlock).toBeLessThan(skyTicks(1));
    expect(c.ticksPerBlock).toBeGreaterThan(0.5);
  });

  it('prices unknown space high but finite, unknown high sky far below unknown space underground', () => {
    const uHigh = volumeOf('uh', 'unknown', { x: 64, y: 200, z: 0 }, { x: 127, y: 319, z: 63 }, { known: 'unknown' });
    const uLow = volumeOf('ul', 'unknown', { x: 64, y: 0, z: 0 }, { x: 127, y: 40, z: 63 }, { known: 'unknown' });
    const pHigh = portalOf({ a: 's', b: 'uh', axis: 'x', center: { x: 64, y: 200, z: 30 }, height: 16, width: 16, known: 'unknown' });
    const pLow = portalOf({ a: 's', b: 'ul', axis: 'x', center: { x: 64, y: 30, z: 30 }, height: 3, width: 3, known: 'unknown' });
    const high = c.edgeCost(pHigh, sky, uHigh, 100);
    const low = c.edgeCost(pLow, sky, uLow, 100);
    expect(Number.isFinite(low)).toBe(true);
    expect(high).toBeLessThan(low);
    expect(low).toBeGreaterThan(c.edgeCost(mouth('c3', 3), sky, cave3, 100));
    expect(high).toBeGreaterThan(c.edgeCost(portalOf({ a: 's', b: 's', axis: 'x', center: { x: 64, y: 200, z: 30 }, height: 16, width: 16 }), sky, sky, 100));
  });

  it('switches into flight with a takeoff and a landing, never under a ceiling too low for the takeoff', () => {
    expect(c.switchCost('fly', cave2)).toBe(0);
    expect(c.switchCost('walk', sky)).toBe(TAKEOFF_TICKS + ROCKET_TICKS + LANDING_TICKS);
    expect(c.switchCost('walk', cave3)).toBe(TAKEOFF_TICKS + ROCKET_TICKS + LANDING_TICKS);
    expect(c.switchCost('walk', cave2)).toBe(Infinity);
    expect(c.switchCost('walk', volumeOf('ul', 'unknown', { x: 0, y: 0, z: 0 }, { x: 15, y: 40, z: 15 }))).toBe(Infinity);
  });
});

describe('the !fly hand-over to a corridor (registry.ts corridorWanted)', () => {
  const p = corridorWorld({ x: 0, z: 0 }).stub();
  it('follows a corridor only with the setting on, a provider, a far goal and no open sky over it', () => {
    expect(corridorWanted('auto', p, 300, true)).toBe(true);
    expect(corridorWanted('off', p, 300, true)).toBe(false);
    expect(corridorWanted('auto', undefined, 300, true)).toBe(false);
    expect(corridorWanted('auto', p, CORRIDOR_MIN, true)).toBe(false);
    expect(corridorWanted('auto', p, 300, false)).toBe(false);
  });
});

for (const shaft of [false, true]) {
  describe(`the coarse layer's own corridor over the corridor world${shaft ? ' with the roof hole' : ''} (Track CB, FlightCost registered)`, () => {
    const w = corridorWorld({ x: 0, z: 0 }, { shaft });
    const gen = flatGen({ x: -48, y: -64, z: -48 }, { x: 400, y: 32, z: 160 });
    for (const f of w.fills) gen.fill(f.from, f.to, f.block === 'air' ? 'air' : 'stone');
    const start = { x: w.start.x + 0.5, y: F, z: w.start.z + 0.5 };
    const goal = { x: w.goal.x + 0.5, y: F, z: w.goal.z + 0.5 };
    const inBore = (p: Vec3) => p.x >= w.mouthX && p.x <= w.bendX + 1 && p.z >= w.start.z - 1 && p.z <= w.start.z + 2 && p.y >= F && p.y <= F + 4;
    const layerOf = () => {
      const layer = new CoarseLayerImpl(terrainSource(gen));
      layer.setCost('fly', new FlightCost());
      return layer;
    };

    it(`flies to ${shaft ? 'the roof hole' : 'the mouth'} partway along, through the bore, and walks the rest; walk only is dearer`, async () => {
      const layer = layerOf();
      const c = await layer.plan({ start, goal, modes: ['fly', 'walk'], startMode: 'walk', goalStanding: true });
      const walk = await layer.plan({ start, goal, modes: ['walk'], startMode: 'walk', goalStanding: true });
      console.log([`fly + walk${shaft ? ' (roof hole)' : ''}:`, ...corridorLines(c), 'walk only:', ...corridorLines(walk)].join('\n'));
      expect(c.status).toBe('found');
      expect(c.legs.map((l) => l.mode)).toEqual(['fly', 'walk']);
      const fly = c.legs[0]!;
      expect(fly.waypoints.some(inBore)).toBe(true);
      // the way in: the shaft (a y portal at the hole) when there is one, else the mouth (the sky contact of the mouth's chunk, then the bore)
      if (shaft) expect(fly.portals.some((p) => p.axis === 'y' && Math.floor(p.center.x) === w.mouthX + SHAFT_AT)).toBe(true);
      else expect(fly.portals.some((p) => Math.floor(p.center.x) === w.mouthX + SHAFT_AT)).toBe(false);
      expect(c.cost).toBeLessThan(walk.cost);
    });

    it('the executor follows it (stub flights): the cruise to the way in, a window underground, the walk', async () => {
      const layer = layerOf();
      const t = fakeTrip(w, layer);
      const r = await t.ex.run(w.goal, 'the chamber');
      console.log(t.calls.map((k) => `${k.kind} ${k.cell.x} ${k.cell.y} ${k.cell.z} (${k.label})${k.win ? `: ${k.win.goals.length} goals, ${Math.round(k.win.blocks)} blocks${k.win.cut ? ', cut' : ''}` : ''}`).join('\n'));
      expect(r.ok, r.reason).toBe(true);
      expect(t.calls[0]!.kind).toBe('sky');
      const land = t.calls[0]!.cell;
      // the cruise lands at the way in: on the bore floor under the hole, or on the open ground by the mouth (the window flies in from there)
      if (shaft) expect(land).toEqual({ x: w.mouthX + SHAFT_AT, y: F, z: w.start.z });
      else expect(Math.hypot(land.x - w.mouthX, land.z - w.start.z) <= 16 && land.y === F && !inBore(land)).toBe(true);
      expect(t.calls.filter((k) => k.kind === 'under').length).toBeGreaterThanOrEqual(1);
      expect(t.calls.at(-1)).toMatchObject({ kind: 'walk', cell: w.goal });
      expect(r.marks.every((m) => m.outcome === 'ok')).toBe(true);
    });
  });
}
