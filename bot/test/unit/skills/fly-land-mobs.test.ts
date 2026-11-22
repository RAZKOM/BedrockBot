// Track M3 (docs/flight.md "The landing looks at hostile mobs", decisions/0086): the landing's look at hostile mobs.
// The pure rules (landmobs.ts), the search's refusals and prices (landing.ts findLanding), the brain's look in the
// approach and the elevator, and whole trips on the physics engine with scripted hostiles (fly-mobs-sim.ts): a creeper on
// the landing cell and beside it, a zombie on it, a skeleton 10 off, a phantom overhead, and no mob at all, with the look
// off and on. `M3_BENCH=1` runs each case over 10 seeds and prints the table of docs/flight.md.
import { describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { SETTING_GROUPS } from '../../../src/chat/help.ts';
import { SETTING_DEFS } from '../../../src/config/settings.ts';
import { FlightBrain, FROM_GROUND_SPEED, FROM_GROUND_WAIT } from '../../../src/skills/fly/brain.ts';
import { cellsAround, ColumnView, findLanding, walkTarget } from '../../../src/skills/fly/landing.ts';
import { cellPrice, cellRefusal, clearGround, clearOfCreepers, LAND_MOBS, landMobKind, landMobsNear, landMobsSaid, nearestCreeper, touchdownThreat, type CreeperTrack, type LandMob } from '../../../src/skills/fly/landmobs.ts';
import type { EntityInfo } from '../../../src/world/types.ts';
import { mobTrip, openBoxes, simMob, yardBoxes, type MobRun, type SimMob } from './fly-mobs-sim.ts';
import { FEET, trip, world } from './fly-worlds.ts';

const mob = (id: number, kind: LandMob['kind'], x: number, z: number, y = 0, extra: Partial<LandMob> = {}): LandMob => ({ id: BigInt(id), type: kind === 'melee' ? 'zombie' : kind === 'ranged' ? 'skeleton' : kind === 'flying' ? 'phantom' : 'creeper', kind, x, y, z, lit: false, hunting: false, ...extra });
const entity = (id: number, type: string, x: number, y: number, z: number, username?: string): EntityInfo => ({ runtimeId: BigInt(id), uniqueId: BigInt(-id), type, pos: { x, y, z }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, headYaw: 0, onGround: true, updatedAt: 0, ...(username ? { username } : {}) });

describe('the landing and the hostiles: what counts (landmobs.ts)', () => {
  it('a hostile is a creeper, a melee mob, a shooter or a flier; a player, a neutral or passive mob, an item is none', () => {
    expect(landMobKind('minecraft:creeper')).toBe('creeper');
    expect(landMobKind('minecraft:zombie')).toBe('melee');
    expect(landMobKind('minecraft:husk')).toBe('melee');
    expect(landMobKind('minecraft:spider')).toBe('melee');
    expect(landMobKind('minecraft:skeleton')).toBe('ranged');
    expect(landMobKind('minecraft:witch')).toBe('ranged');
    expect(landMobKind('minecraft:phantom')).toBe('flying');
    for (const t of ['minecraft:player', 'minecraft:cow', 'minecraft:villager_v2', 'minecraft:iron_golem', 'minecraft:enderman', 'minecraft:wolf', 'minecraft:item', 'minecraft:arrow', 'minecraft:fireworks_rocket']) expect(landMobKind(t), t).toBeUndefined();
  });

  it('the hostiles near a place: from the entity tracker and the mob tracker; the dead, the far and a player left out', () => {
    const ents = [entity(1, 'minecraft:creeper', 3.5, 64, 0.5), entity(2, 'minecraft:zombie', 10.5, 64, 0.5), entity(3, 'minecraft:zombie', 200.5, 64, 0.5), entity(4, 'minecraft:skeleton', -8.5, 64, 0.5), entity(5, 'minecraft:player', 1.5, 65.62, 0.5, 'Steve'), entity(6, 'minecraft:cow', 2.5, 64, 0.5), entity(7, 'minecraft:creeper', 6.5, 64, 0.5)];
    const states = { get: (rid: bigint) => (rid === 1n ? { ignited: true } : rid === 4n ? { dead: true } : undefined), targetsUs: (rid: bigint) => rid === 2n };
    const got = landMobsNear(ents, states, { x: 0.5, z: 0.5 });
    expect(got.map((m) => [Number(m.id), m.kind, m.lit, m.hunting])).toEqual([[1, 'creeper', true, false], [2, 'melee', false, true], [7, 'creeper', false, false]]);
    expect(got[0]).toMatchObject({ type: 'creeper', x: 3.5, y: 64, z: 0.5 });
    expect(landMobsNear(ents, undefined, { x: 0.5, z: 0.5 }, 5).map((m) => Number(m.id))).toEqual([1]);
    expect(landMobsSaid(got, { x: 0.5, y: 64, z: 0.5 })).toBe('2 creepers (nearest 3), 1 melee');
    expect(landMobsSaid([])).toBeUndefined();
  });
});

describe('the landing and the hostiles: a cell against them (cellPrice, cellRefusal)', () => {
  const cell = { x: 0, z: 0, feet: 0 };
  it('nothing hostile: no price, no refusal', () => {
    expect(cellPrice(cell, [])).toEqual({ priceS: 0 });
    expect(cellRefusal(cell, [])).toBeUndefined();
    expect(cellPrice(cell, [mob(1, 'flying', 0.5, 0.5, 12)])).toEqual({ priceS: 0 });
    expect(cellPrice(cell, [mob(1, 'melee', 40.5, 0.5)])).toEqual({ priceS: 0 });
  });

  it('a creeper inside 12 of the cell: no landing (its blast range of 7 and the 5 blocks it walks during the shortest elevator)', () => {
    for (const d of [0, 3, 7, 11.4]) {
      const r = cellPrice(cell, [mob(1, 'creeper', 0.5 + d, 0.5)]);
      expect(r.refuse, `creeper ${d} off`).toMatch(/^a creeper \d+ off$/);
      expect(cellRefusal(cell, [mob(1, 'creeper', 0.5 + d, 0.5)])).toBe(r.refuse);
    }
    // in 3D: a creeper in a cave 14 under the cell is none; one 5 under it is
    expect(cellRefusal(cell, [mob(1, 'creeper', 0.5, 0.5, -14)])).toBeUndefined();
    expect(cellRefusal(cell, [mob(1, 'creeper', 0.5, 0.5, -5)])).toBeDefined();
    expect(LAND_MOBS.refuse).toBe(LAND_MOBS.blast + 5);
  });

  it('a creeper that will follow (inside 16) costs 10 s, running out at 24; other hostiles cost by distance; the sum is capped', () => {
    expect(cellPrice(cell, [mob(1, 'creeper', 14.5, 0.5)])).toMatchObject({ priceS: 10, note: 'a creeper 14 off' });
    expect(cellPrice(cell, [mob(1, 'creeper', 20.5, 0.5)]).priceS).toBeCloseTo(5, 6);
    expect(cellPrice(cell, [mob(1, 'creeper', 24.5, 0.5)]).priceS).toBe(0);
    expect(cellPrice(cell, [mob(1, 'melee', 1.5, 0.5)])).toMatchObject({ priceS: 6, note: '1 melee' });
    expect(cellPrice(cell, [mob(1, 'melee', 6.5, 0.5)]).priceS).toBeCloseTo(3, 6);
    expect(cellPrice(cell, [mob(1, 'melee', 10.5, 0.5)]).priceS).toBe(0);
    expect(cellPrice(cell, [mob(1, 'ranged', 6.5, 0.5)])).toMatchObject({ priceS: 4, note: '1 shooting' });
    expect(cellPrice(cell, [mob(1, 'ranged', 12.5, 0.5)]).priceS).toBeCloseTo(2, 6);
    // on another level (a roof, a cave): nothing
    expect(cellPrice(cell, [mob(1, 'melee', 1.5, 0.5, 9)]).priceS).toBe(0);
    const crowd = [1, 2, 3, 4, 5, 6].map((k) => mob(k, 'melee', 0.5 + k * 0.3, 0.5));
    expect(cellPrice(cell, crowd).priceS).toBe(LAND_MOBS.capS);
  });
});

describe('the landing and the hostiles: the look in the last seconds (touchdownThreat, clearGround)', () => {
  const td = { x: 0.5, y: 0, z: 0.5 };
  it('a creeper inside its blast range of the touchdown is a threat; one beyond it that stands is none', () => {
    const track: CreeperTrack = new Map();
    expect(touchdownThreat([], td, 40, 1, track)).toBeUndefined();
    expect(touchdownThreat([mob(1, 'creeper', 4.5, 0.5)], td, 40, 1, track)).toMatchObject({ d: 4, atTouchdown: 4, closing: 0 });
    expect(touchdownThreat([mob(2, 'creeper', 9.5, 0.5)], td, 40, 2, track)).toBeUndefined();
    expect(touchdownThreat([mob(3, 'melee', 1.5, 0.5), mob(4, 'ranged', 3.5, 0.5)], td, 40, 3, track)).toBeUndefined();
    // the memory of creepers no longer known is dropped
    expect(track.size).toBe(0);
  });

  it('a creeper that walks in: its distance at the touchdown counts, at the pace it closed over the last ticks', () => {
    const track: CreeperTrack = new Map();
    const at = (x: number): LandMob[] => [mob(1, 'creeper', x, 0.5)];
    // 14 off, standing: nothing
    expect(touchdownThreat(at(14.5), td, 60, 0, track)).toBeUndefined();
    // five ticks on it has walked half a block: 0.1 a tick; with 60 ticks to the touchdown it will be 7.5 off: still none
    expect(touchdownThreat(at(14.0), td, 60, 5, track)).toBeUndefined();
    expect(track.get(1n)?.closing).toBeCloseTo(0.1, 6);
    // with 80 ticks to go it will be inside 7
    const t = touchdownThreat(at(14.0), td, 80, 6, track);
    expect(t?.atTouchdown).toBeCloseTo(5.5, 6);
    expect(t?.d).toBeCloseTo(13.5, 6);
    // a creeper first seen already targeting the body counts at a creeper's walk before it has been seen walking
    const fresh: CreeperTrack = new Map();
    expect(touchdownThreat([mob(2, 'creeper', 12.5, 0.5, 0, { hunting: true })], td, 60, 1, fresh)?.atTouchdown).toBeCloseTo(6, 6);
    expect(touchdownThreat([mob(3, 'creeper', 12.5, 0.5)], td, 60, 1, new Map())).toBeUndefined();
  });

  it('ground clear of every creeper: the nearest ring with ground 20 from them, the farthest bearing on it; else 12', () => {
    const flat = (): number => 0;
    const creepers = [mob(1, 'creeper', 0.5, 0.5)];
    const g = clearGround({ x: 0.5, z: 0.5, top: 0 }, creepers, flat)!;
    expect(Math.hypot(g.x - 0.5, g.z - 0.5)).toBeGreaterThanOrEqual(20);
    expect(Math.hypot(g.x - 0.5, g.z - 0.5)).toBeLessThanOrEqual(24.5);
    expect(g.clear).toBe(LAND_MOBS.clear);
    expect(clearOfCreepers({ x: g.x, y: g.top, z: g.z }, creepers, LAND_MOBS.clear)).toBe(true);
    // ground only within 16: the lesser clearance
    const small = (x: number, z: number): number | undefined => (Math.hypot(x, z) <= 16 ? 0 : undefined);
    const s = clearGround({ x: 0.5, z: 0.5, top: 0 }, creepers, small)!;
    expect(s.clear).toBe(LAND_MOBS.clearMin);
    expect(Math.hypot(s.x - 0.5, s.z - 0.5)).toBeGreaterThanOrEqual(12);
    // a second creeper 20 to one side: the ground is not on that side
    const two = [...creepers, mob(2, 'creeper', 20.5, 0.5)];
    const h = clearGround({ x: 0.5, z: 0.5, top: 0 }, two, flat)!;
    expect(clearOfCreepers({ x: h.x, y: h.top, z: h.z }, two, LAND_MOBS.clear)).toBe(true);
    expect(h.x).toBeLessThan(2);
    // none known, or ground on another level only: undefined
    expect(clearGround({ x: 0.5, z: 0.5, top: 0 }, creepers, () => undefined)).toBeUndefined();
    expect(clearGround({ x: 0.5, z: 0.5, top: 0 }, creepers, () => 30)).toBeUndefined();
    expect(nearestCreeper(two, { x: 18.5, y: 0, z: 0.5 })?.mob.id).toBe(2n);
  });
});

describe('the landing search and the hostiles (findLanding)', () => {
  const w = world(openBoxes());
  const goal = { x: 0, y: FEET, z: 150 };
  const deps = (hostiles: LandMob[]) => ({
    look: w.look,
    obstacle: (x: number, y: number, z: number) => w.solid.solidAt(x, y, z) === true,
    probe: (from: { x: number; y: number; z: number }) => Promise.resolve({ status: 'found' as const, blocks: Math.hypot(from.x - 0.5, from.z - 150.5) }),
    dryGround: (x: number, z: number) => w.dryGround(x, z),
    ...(hostiles.length ? { mobs: (c: { x: number; z: number; feet: number }) => cellPrice(c, hostiles) } : {}),
  });
  const o = { radius: 32, headroom: 4, maxUnder: 8, probes: 16, budgetMs: 6000 };

  it('no hostile: the goal itself; a creeper on it: a cell at least 12 from the creeper, and the line says so', async () => {
    const plain = await findLanding(goal, 'g', deps([]), o);
    expect(plain.kind).toBe('goal');
    const c = [mob(1, 'creeper', 0.5, 150.5, FEET)];
    const moved = await findLanding(goal, 'g', deps(c), o);
    expect(moved.kind, moved.line).toBe('cell');
    if (moved.kind !== 'cell') return;
    expect(Math.hypot(moved.cell.x + 0.5 - 0.5, moved.cell.z + 0.5 - 150.5)).toBeGreaterThanOrEqual(LAND_MOBS.refuse);
    expect(moved.line).toMatch(/cells refused for a creeper/);
    expect(cellRefusal(moved.cell, c)).toBeUndefined();
    for (const a of moved.target.alternatives ?? []) expect(clearOfCreepers({ x: a.x, y: a.top, z: a.z }, c, LAND_MOBS.refuse)).toBe(true);
    // an exact goal (`!fly x y z`) is given up for the creeper too
    const exact = await findLanding(goal, 'g', deps(c), { ...o, exact: 2 });
    expect(exact.kind).toBe('cell');
  });

  it('a zombie on the goal: a cell beside it, where it costs less than the walk back; a skeleton 10 off: the goal (the walk ends there anyway)', async () => {
    const z = [mob(1, 'melee', 0.5, 150.5, FEET)];
    const one = await findLanding(goal, 'g', deps(z), o);
    expect(one.kind, one.line).toBe('cell');
    if (one.kind !== 'cell') return;
    const d = Math.hypot(one.cell.x, one.cell.z - 150);
    expect(d).toBeGreaterThanOrEqual(5);
    expect(d).toBeLessThanOrEqual(12);
    expect(cellPrice(one.cell, z).priceS).toBeLessThan(LAND_MOBS.relookS);
    expect(one.line).toMatch(/hostiles \d+\.\d s \(1 melee\)|path \d+/);
    expect((await findLanding(goal, 'g', deps([mob(1, 'ranged', 10.5, 150.5, FEET)]), o)).kind).toBe('goal');
    // a crowd on the best cell prices it out
    const crowd = [1, 2, 3].map((k) => mob(k, 'melee', 0.5 + k, 150.5, FEET));
    expect(cellPrice({ x: 0, z: 150, feet: FEET }, crowd).priceS).toBeGreaterThan(12);
    expect(cellPrice({ x: 0, z: 138, feet: FEET }, crowd).priceS).toBe(0);
  });
});

describe('the brain and the hostiles at the touchdown (FlightBrain mobLook)', () => {
  const Z = 150;
  const start = { x: 0.5, y: FEET + 70, z: 0.5 };
  const targetOf = (w: ReturnType<typeof world>) => {
    const view = new ColumnView(w.look, FEET);
    const cell = { x: 0, z: Z, feet: FEET, kind: 'open' as const };
    return walkTarget(cell, cellsAround(view, cell, 'open', 5, 4), { walkS: 0, walkKnown: true });
  };

  it('with nothing hostile known the flight is tick for tick what it is without the look (open ground and a yard between roofs)', () => {
    for (const boxes of [openBoxes(), yardBoxes(Z)]) {
      const w = world(boxes);
      const t = targetOf(w);
      const plain = trip(w, start, t, { seed: 5 });
      const looked = trip(w, start, t, { seed: 5, landMobs: () => [] });
      expect(looked.ticks).toBe(plain.ticks);
      expect(looked.rockets).toBe(plain.rockets);
      expect(looked.end).toEqual(plain.end);
      expect(looked.body.pos).toEqual(plain.body.pos);
      expect(looked.notes).toEqual(plain.notes);
      expect(looked.stats).toEqual(plain.stats);
      // a zombie, a skeleton and a phantom at the landing change nothing either: only a creeper moves a landing
      const others = trip(w, start, t, { seed: 5, landMobs: () => [mob(1, 'melee', 0.5, Z + 0.5, FEET), mob(2, 'ranged', 8.5, Z + 0.5, FEET), mob(3, 'flying', 0.5, Z + 0.5, FEET + 12)] });
      expect(others.ticks).toBe(plain.ticks);
      expect(others.end).toEqual(plain.end);
      expect(others.stats).toEqual(plain.stats);
    }
  }, 60_000);

  it('a creeper on the landing: the landing is moved clear of it and the body goes round to it; no touchdown inside its blast range', () => {
    for (const boxes of [openBoxes(), yardBoxes(Z)]) {
      const w = world(boxes);
      const t = targetOf(w);
      const creeper = [mob(1, 'creeper', 0.5, Z + 0.5, FEET)];
      const r = trip(w, start, t, { seed: 5, landMobs: () => creeper });
      const d = Math.hypot(r.body.pos.x - 0.5, r.body.pos.z - (Z + 0.5));
      expect(d, r.notes.join(' | ')).toBeGreaterThanOrEqual(LAND_MOBS.blast);
      expect(r.stats.mobRounds).toBe(1);
      expect(r.stats.mobNotes?.[0]).toMatch(/^landing look: a creeper \d+\.\d from the touchdown, the body \d+\.\d over the floor: the landing moved to -?\d+ -60 -?\d+ \(\d+ blocks on, clear of every creeper known\), going round to it \(round 1\)$/);
      expect(r.end.ok, r.notes.join(' | ')).toBe(true);
      expect(r.hits).toBe(0);
    }
  }, 60_000);

  it('a creeper 12 off that stands: the landing as planned; no rocket left: the landing as planned, with a line', () => {
    const w = world(openBoxes());
    const t = targetOf(w);
    const plain = trip(w, start, t, { seed: 5 });
    const far = trip(w, start, t, { seed: 5, landMobs: () => [mob(1, 'creeper', 12.5, Z + 0.5, FEET)] });
    expect(far.ticks).toBe(plain.ticks);
    expect(far.stats.mobRounds).toBeUndefined();
    const dry = trip(w, start, t, { seed: 5, rockets: plain.rockets, landMobs: () => [mob(1, 'creeper', 0.5, Z + 0.5, FEET)] });
    expect(dry.stats.mobRounds).toBeUndefined();
    expect(dry.stats.mobNotes?.[0]).toMatch(/no rocket to go round on, landing as planned$/);
  }, 60_000);
});

describe('a takeoff from the ground and from rest (the elytra flee: BrainOptions.fromGround)', () => {
  const step = (b: FlightBrain, body: { onGround: boolean; vx: number; vy: number }, t: number) =>
    b.step({ tick: t, body: { pos: { x: 0.5, y: body.onGround ? FEET : FEET + 0.3, z: 0.5 }, vel: { x: body.vx, y: body.vy, z: 0 }, onGround: body.onGround, gliding: false, boostTicks: 0 }, yaw: 0, pitch: 0, rockets: 8, canFire: true, health: 20, elytraLeft: 400 }).control;
  const target = { x: 0.5, z: 100.5, top: FEET, half: 2 };

  it('a body in the air and falling, or moving on the ground: no glide is asked and no jump made until it stands slower than FROM_GROUND_SPEED', () => {
    const b = new FlightBrain(target, { cruiseY: FEET + 20, fromGround: true });
    // mid-jump of a walk: falling 0.3 over the ground at 0.8 a tick
    let c = step(b, { onGround: false, vx: 0.8, vy: -0.2 }, 1);
    expect(c.glide).toBe(false);
    expect(c.jump).toBe(false);
    // landed, still sliding
    c = step(b, { onGround: true, vx: 0.4, vy: 0 }, 2);
    expect(c.jump).toBe(false);
    // at rest: the jump
    c = step(b, { onGround: true, vx: FROM_GROUND_SPEED - 0.05, vy: 0 }, 3);
    expect(c.jump).toBe(true);
    // its own fall: the glide
    c = step(b, { onGround: false, vx: 0, vy: -0.1 }, 4);
    expect(c.glide).toBe(true);
  });

  it('it waits FROM_GROUND_WAIT ticks at the most; without the option a falling body is given the glide at once, as before', () => {
    const b = new FlightBrain(target, { cruiseY: FEET + 20, fromGround: true });
    let c = step(b, { onGround: false, vx: 0.8, vy: -0.2 }, 1);
    for (let t = 2; t <= FROM_GROUND_WAIT; t++) c = step(b, { onGround: false, vx: 0.8, vy: -0.2 }, t);
    expect(c.glide).toBe(false);
    c = step(b, { onGround: false, vx: 0.8, vy: -0.2 }, FROM_GROUND_WAIT + 1);
    expect(c.glide).toBe(true);
    const plain = new FlightBrain(target, { cruiseY: FEET + 20 });
    expect(step(plain, { onGround: false, vx: 0.8, vy: -0.2 }, 1).glide).toBe(true);
  });
});

// ---- whole trips with scripted hostiles: the look off and on ----------------------------------------------------

interface Case {
  name: string;
  mobs: (Z: number) => SimMob[];
  /** A netherite sword in the hotbar (the live kit); else bare hands. */
  blade?: boolean;
}
const CASES: Case[] = [
  { name: 'creeper on the cell', mobs: (Z) => [simMob(1, 'creeper', 0.5, Z + 0.5)] },
  { name: 'creeper 3 beside it', mobs: (Z) => [simMob(1, 'creeper', 3.5, Z + 0.5)] },
  { name: 'zombie on the cell', mobs: (Z) => [simMob(1, 'zombie', 0.5, Z + 0.5)] },
  { name: 'zombie on the cell, a blade', mobs: (Z) => [simMob(1, 'zombie', 0.5, Z + 0.5)], blade: true },
  { name: 'skeleton 10 off', mobs: (Z) => [simMob(1, 'skeleton', 10.5, Z + 0.5)] },
  { name: 'phantom overhead', mobs: (Z) => [simMob(1, 'phantom', 0.5, Z + 0.5, FEET + 12)] },
  { name: 'no mob', mobs: () => [] },
];

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

async function series(terrain: 'open' | 'yard', c: Case, look: boolean, seeds: number[]): Promise<MobRun[]> {
  const Z = 150;
  const out: MobRun[] = [];
  for (const seed of seeds) out.push(await mobTrip(terrain === 'open' ? openBoxes() : yardBoxes(Z), Z, c.mobs(Z), { look, seed, ...(c.blade ? { blade: true } : {}) }));
  return out;
}

describe('whole trips with hostiles at the landing: the look off and on (fly-mobs-sim.ts)', () => {
  const BENCH = process.env.M3_BENCH === '1';
  const seeds = BENCH ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] : [5];

  it('a creeper on or beside the landing cell: off, the body touches down in its blast range and is blown up; on, never', async () => {
    for (const terrain of ['open', 'yard'] as const) {
      for (const c of CASES.slice(0, 2)) {
        const off = await series(terrain, c, false, seeds);
        const on = await series(terrain, c, true, seeds);
        const said = `${terrain}, ${c.name}`;
        expect(off.filter((r) => r.creeperAtTouchdown < LAND_MOBS.blast).length, said).toBe(off.length);
        expect(off.filter((r) => r.explosions > 0).length, said).toBeGreaterThan(0);
        expect(on.filter((r) => r.creeperAtTouchdown < LAND_MOBS.blast).length, `${said}: ${on.map((r) => r.creeperAtTouchdown.toFixed(1)).join(' ')}; ${on[0]?.notes.join(' | ')}`).toBe(0);
        expect(on.reduce((n, r) => n + r.explosions, 0), said).toBe(0);
        expect(on.every((r) => r.landed), said).toBe(true);
      }
    }
  }, 240_000);

  it('a zombie on the landing cell: off, it hits the body in the elevator; on, the landing is beside it and it takes no more damage than off', async () => {
    for (const c of [CASES[2]!, CASES[3]!]) {
      for (const terrain of ['open', 'yard'] as const) {
        const off = await series(terrain, c, false, seeds);
        const on = await series(terrain, c, true, seeds);
        const said = `${terrain}, ${c.name}: off ${off.map((r) => r.damage).join(' ')}, on ${on.map((r) => r.damage).join(' ')}`;
        expect(mean(on.map((r) => r.damage)), said).toBeLessThanOrEqual(mean(off.map((r) => r.damage)));
        if (terrain === 'yard') expect(mean(off.map((r) => r.damage)), said).toBeGreaterThan(0);
        expect(on.every((r) => r.landed), said).toBe(true);
      }
    }
  }, 240_000);

  it('no mob: the look changes nothing (ticks, rockets, where it stands)', async () => {
    for (const terrain of ['open', 'yard'] as const) {
      const off = await series(terrain, CASES[6]!, false, seeds);
      const on = await series(terrain, CASES[6]!, true, seeds);
      expect(on.map((r) => [r.ticks, r.rockets, r.at])).toEqual(off.map((r) => [r.ticks, r.rockets, r.at]));
    }
  }, 240_000);

  it.runIf(BENCH)('the table: every case, 10 seeds, the look off and on', async () => {
    const lines: string[] = [];
    for (const terrain of ['open', 'yard'] as const) {
      const base = mean((await series(terrain, CASES[6]!, false, seeds)).map((r) => r.ticks));
      for (const c of CASES) {
        for (const look of [false, true]) {
          const rs = await series(terrain, c, look, seeds);
          const row = {
            terrain,
            case: c.name,
            look: look ? 'on' : 'off',
            n: rs.length,
            landed: rs.filter((r) => r.landed).length,
            inBlast: rs.filter((r) => r.creeperAtTouchdown < LAND_MOBS.blast).length,
            hurt: rs.filter((r) => r.damage > 0).length,
            damage: Number(mean(rs.map((r) => r.damage)).toFixed(2)),
            explosions: rs.reduce((n, r) => n + r.explosions, 0),
            seconds: Number((mean(rs.map((r) => r.ticks)) / 20).toFixed(1)),
            added: Number(((mean(rs.map((r) => r.ticks)) - base) / 20).toFixed(1)),
            rockets: Number(mean(rs.map((r) => r.rockets)).toFixed(1)),
            mobRounds: rs.reduce((n, r) => n + r.mobRounds, 0),
            retargets: rs.reduce((n, r) => n + r.retargets, 0),
            fromFirst: Number(mean(rs.map((r) => r.fromFirst)).toFixed(1)),
            airStrikes: rs.reduce((n, r) => n + r.airStrikes, 0),
          };
          lines.push(JSON.stringify(row));
        }
      }
    }
    console.log(lines.join('\n'));
    if (process.env.M3_OUT) appendFileSync(process.env.M3_OUT, `${lines.join('\n')}\n`);
    expect(lines.length).toBe(28);
  }, 900_000);
});

describe('what the look costs a tick (M3_TIMING=1 prints it; the Mac under the CPU policy of the live bot)', () => {
  const crowd = (n: number): EntityInfo[] => {
    const types = ['minecraft:zombie', 'minecraft:creeper', 'minecraft:skeleton', 'minecraft:item', 'minecraft:cow', 'minecraft:phantom', 'minecraft:arrow', 'minecraft:sheep'];
    return Array.from({ length: n }, (_, k) => entity(k + 1, types[k % types.length]!, ((k * 37) % 160) - 80 + 0.5, 64, ((k * 91) % 160) - 80 + 0.5));
  };
  // Track REL3: the time (under a millisecond a tick at 200 entities) is checked in the perf project (test/perf/land-mobs.perf.test.ts)
  it('the hostiles near a place and the touchdown look over 50, 200 and 800 entities', () => {
    const lines: string[] = [];
    for (const n of [50, 200, 800]) {
      const ents = crowd(n);
      const states = { get: () => undefined, targetsUs: () => false };
      const track: CreeperTrack = new Map();
      const reps = 2000;
      let found = 0;
      const t0 = performance.now();
      for (let i = 0; i < reps; i++) {
        const mobs = landMobsNear(ents, states, { x: 0.5, z: 0.5 });
        found = mobs.length;
        touchdownThreat(mobs, { x: 0.5, y: 64, z: 0.5 }, 40, i, track);
      }
      const us = ((performance.now() - t0) / reps) * 1000;
      const t1 = performance.now();
      const mobs = landMobsNear(ents, states, { x: 0.5, z: 0.5 });
      for (let i = 0; i < reps; i++) cellPrice({ x: i % 30, z: 3, feet: 64 }, mobs);
      const cellUs = ((performance.now() - t1) / reps) * 1000;
      lines.push(`${n} entities (${found} hostile within ${LAND_MOBS.scan}): the look ${us.toFixed(1)} us a tick, a cell's price ${cellUs.toFixed(2)} us`);
      expect(found, `hostiles within the scan of ${n}`).toBeGreaterThan(0);
    }
    if (process.env.M3_TIMING === '1') console.log(lines.join('\n'));
  });
});

describe('the setting', () => {
  it('flyLandMobs is off by default and listed with the flight settings', () => {
    expect(SETTING_DEFS.flyLandMobs.default).toBe(false);
    expect(SETTING_DEFS.flyLandMobs.kind).toBe('boolean');
    expect(SETTING_GROUPS.find(([g]) => g === 'flight')?.[1]).toContain('flyLandMobs');
  });
});
