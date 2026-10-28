// Wave 11 Track AU: Elytra flight on the physics engine and on fakes (docs/flight.md):
// the planning geometry, the approach planner and the brain flying whole trips offline through
// stepBody (the same engine the input loop runs), the kit rules (keeper, !drop, stash, unloader,
// armour) and the owner's supply lines.
import { describe, expect, it } from 'vitest';
import { keepOnDropItems } from '../../../src/chat/commands-survival.ts';
import { flyEndLine } from '../../../src/chat/commands-fly.ts';
import { FlightBrain, climbMomentum } from '../../../src/skills/fly/brain.ts';
import { skyQuery } from '../../../src/skills/fly/controller.ts';
import { elytraWornLimit, fireworksLowLine, flightKitSlots, isFireworksBox, isFlightKitItem, keptKitLine, kitLine, kitReady, readKit, SupplyWatch } from '../../../src/skills/fly/kit.ts';
import {
  ApproachPlanner,
  approachHopeless,
  approachYaw,
  columnsAlong,
  cruiseHeight,
  estimateRockets,
  profilePitch,
  PROFILE_START,
  simulateProfile,
  touchdownCost,
  turnTowards,
  walkMinutes,
  yawDiff,
  yawTo,
  type FlightBody,
  type LandingTarget,
} from '../../../src/skills/fly/plan.ts';
import { flatWorld, GLIDE, glideVelocity, IDLE_COMMAND, initialBody, stepBody, withBoxes, type BlockQuery } from '../../../src/skills/input/index.ts';
import { neverDrop } from '../../../src/skills/survival/keeper.ts';
import { planArmour } from '../../../src/skills/survival/armour.ts';
import { planUnload } from '../../../src/skills/home/unloader.ts';
import type { ItemStack } from '../../../src/world/types.ts';
import { FLIGHT_PRIORITY } from '../../../src/tasks/process/fly.ts';
import { PRIORITY } from '../../../src/tasks/process/manager.ts';

const FEET = -60;
const item = (name: string, count = 1, damage?: number): ItemStack => ({ name, count, networkId: 1, metadata: 0, ...(damage !== undefined ? { damage } : {}) });
/** A shulker box wire item with NBT Items. */
const boxRaw = (items: { name: string; count: number }[]) => ({ extra: { nbt: { nbt: { value: { Items: { value: { value: items.map((i) => ({ Name: { value: `minecraft:${i.name}` }, Count: { value: i.count } })) } } } } } } });

describe('fly: geometry', () => {
  it('yawTo / yawDiff / turnTowards follow the Bedrock yaw convention and turn by at most the step', () => {
    expect(yawTo({ x: 0, z: 0 }, { x: 0, z: 10 })).toBeCloseTo(0, 6);
    expect(yawTo({ x: 0, z: 0 }, { x: -10, z: 0 })).toBeCloseTo(90, 6);
    expect(yawDiff(170, -170)).toBe(20);
    expect(yawDiff(-170, 170)).toBe(-20);
    expect(turnTowards(0, 40)).toBe(15);
    expect(turnTowards(0, 10)).toBe(10);
    expect(approachYaw(0, { x: 0, z: 0 }, { x: 0.5, z: 0.5 })).toBe(0); // frozen within YAW_FREEZE
  });

  it('columnsAlong covers both ends and every column of a straight line', () => {
    const cols = columnsAlong({ x: 0.5, z: 0.5 }, { x: 10.5, z: 3.5 });
    expect(cols[0]).toEqual({ x: 0, z: 0 });
    expect(cols.at(-1)).toEqual({ x: 10, z: 3 });
    expect(cols.length).toBeGreaterThanOrEqual(11);
  });

  it('cruiseHeight clears every known column by the clearance, treats unknown columns as the highest known, and never flies higher than the glide down needs', () => {
    const t: LandingTarget = { x: 150.5, z: 0.5, top: -20, half: 1 };
    const flat = cruiseHeight({ x: 0.5, y: FEET, z: 0.5 }, t, () => -61);
    expect(flat.y).toBeGreaterThanOrEqual(t.top + 12);
    expect(flat.y).toBeLessThan(t.top + 25);
    const hill = cruiseHeight({ x: 0.5, y: FEET, z: 0.5 }, t, (x) => (x > 60 && x < 70 ? 10 : -61), { clearance: 12 });
    expect(hill.y).toBe(10 + 1 + 12);
    expect(hill.highest).toBe(10);
    const unknown = cruiseHeight({ x: 0.5, y: FEET, z: 0.5 }, t, (x) => (x > 60 && x < 70 ? 10 : undefined));
    expect(unknown.unknown).toBeGreaterThan(100);
    expect(unknown.y).toBe(hill.y);
  });

  it('estimateRockets and walkMinutes: about one rocket per 100 blocks plus the climb; a 420-block walk is about 1 minute', () => {
    expect(estimateRockets(300, 20)).toBe(2 + 3 + 1);
    expect(Math.round(walkMinutes(420))).toBe(1);
    expect(climbMomentum(1.06)).toBeCloseTo(14.0, 1);
    expect(climbMomentum(-0.2)).toBe(0);
  });
});

describe('fly: the approach planner (glide formula)', () => {
  const target: LandingTarget = { x: 0.5, z: 150.5, top: -20, half: 1 };
  const body = (y: number, z: number, h: number, vy = -0.15): FlightBody => ({ pos: { x: 0.5, y, z }, vel: { x: 0, y: vy, z: h }, onGround: false, gliding: true, boostTicks: 0 });

  it('the glide formula: level flight sinks about 0.15 blocks a tick; a hard flare from 1.2 blocks/tick climbs several blocks and bleeds the speed to about 0.3', () => {
    let v = { x: 0, y: -0.15, z: 1.2 };
    let dy = 0;
    for (let i = 0; i < 60; i++) {
      v = glideVelocity(v, 0, 0, false);
      dy += v.y;
    }
    expect(dy / 60).toBeGreaterThan(-0.17);
    expect(dy / 60).toBeLessThan(-0.13);
    v = { x: 0, y: -0.15, z: 1.2 };
    dy = 0;
    let rose = false;
    let ticks = 0;
    for (; ticks < 100; ticks++) {
      v = glideVelocity(v, 0, -60, false);
      dy += v.y;
      if (v.y > 0) rose = true;
      if (rose && v.y <= 0) break;
    }
    expect(dy).toBeGreaterThan(4);
    expect(dy).toBeLessThan(10);
    expect(Math.hypot(v.x, v.z)).toBeLessThan(0.4);
  });

  it('profilePitch walks the segments A1 -> A2 -> B (flare) -> C (settle) and only ahead of the flown phase the parameters are free', () => {
    const prof = { pitchA1: 10, ticksA1: 2, pitchA2: 20, flareAt: 12, pitchB: -60, pitchC: -10 };
    let st = { ...PROFILE_START };
    const far = { x: 0.5, y: 0, z: 100 };
    const near = { x: 0.5, y: 0, z: 140 };
    let r = profilePitch(prof, st, far, { x: 0, y: -0.1, z: 1 }, target);
    expect(r.pitch).toBe(10);
    st = r.next;
    r = profilePitch(prof, st, far, { x: 0, y: -0.1, z: 1 }, target);
    expect(r.pitch).toBe(10);
    st = r.next;
    r = profilePitch(prof, st, far, { x: 0, y: -0.1, z: 1 }, target);
    expect(r.pitch).toBe(20);
    expect(r.next.phase).toBe('A2');
    r = profilePitch(prof, r.next, near, { x: 0, y: -0.1, z: 1 }, target);
    expect(r.pitch).toBe(-60);
    expect(r.next.phase).toBe('B');
    r = profilePitch(prof, r.next, near, { x: 0, y: 0.2, z: 0.6 }, target);
    expect(r.next.rose).toBe(true);
    r = profilePitch(prof, r.next, near, { x: 0, y: -0.01, z: 0.5 }, target);
    expect(r.pitch).toBe(-10);
    expect(r.next.phase).toBe('C');
  });

  it('simulateProfile classifies a touchdown on the platform, a miss beside it, the ground and an overshoot; the cost prefers the soft centre', () => {
    const landed = simulateProfile(body(-19.5, 149.3, 0.3, -0.1), 0, target, { pitchA1: 0, ticksA1: 0, pitchA2: 0, flareAt: 0, pitchB: -60, pitchC: 0 });
    expect(landed.kind).toBe('landed');
    expect(landed.off).toBeLessThan(1.5);
    const over = simulateProfile(body(-10, 148, 1.2), 0, target, { pitchA1: 0, ticksA1: 0, pitchA2: 0, flareAt: 0, pitchB: -60, pitchC: 0 });
    expect(over.kind).toBe('over');
    const ground = simulateProfile(body(-50, 100, 1.2), 0, target, { pitchA1: 45, ticksA1: 0, pitchA2: 45, flareAt: 0, pitchB: -60, pitchC: 0 });
    expect(ground.kind).toBe('short');
    const wall = simulateProfile(body(-24, 146, 1.2, -0.1), 0, target, { pitchA1: 0, ticksA1: 0, pitchA2: 0, flareAt: 0, pitchB: -60, pitchC: 0 });
    expect(['wall', 'short']).toContain(wall.kind);
    const soft = touchdownCost({ kind: 'landed', pos: { x: 0.5, y: -20, z: 150.5 }, vel: { x: 0, y: -0.1, z: 0.3 }, ticks: 10, off: 0 }, target);
    const fast = touchdownCost({ kind: 'landed', pos: { x: 0.5, y: -20, z: 150.5 }, vel: { x: 0, y: -0.1, z: 1.3 }, ticks: 10, off: 0 }, target);
    const hard = touchdownCost({ kind: 'landed', pos: { x: 0.5, y: -20, z: 150.5 }, vel: { x: 0, y: -0.9, z: 0.3 }, ticks: 10, off: 0 }, target);
    expect(soft).toBeLessThan(1);
    expect(fast).toBeGreaterThan(30);
    expect(hard).toBeGreaterThan(20);
    expect(touchdownCost(over, target)).toBeGreaterThan(fast);
  });

  it('an obstacle along the way makes every plan a wall hit (the brain then goes around)', () => {
    const wall = (x: number, y: number, z: number) => z === 140 && Math.abs(x) <= 3 && y >= -21 && y <= -14;
    const planner = new ApproachPlanner(7, wall);
    const c = planner.step(body(-10, 94.5, 1.1), 0, target);
    expect(c.touchdown.kind).not.toBe('landed');
    expect(approachHopeless(c, 6, 56)).toBe(false); // patience: not yet within 45 blocks for 6 ticks
    expect(approachHopeless(c, 6, 40)).toBe(true);
  });

  it('from the approach entry (10 above, 56 out, 1.2 blocks/tick) the planner finds a landing that touches down under 0.5 blocks/tick within a block of the centre', () => {
    const planner = new ApproachPlanner(3);
    const c = planner.step(body(-10, 94.5, 1.2), 0, target);
    expect(c.touchdown.kind).toBe('landed');
    expect(c.sims).toBeGreaterThan(50);
    // fly the plan tick by tick with the planner re-planning (the controller's loop) on the pure formula
    let b = body(-10, 94.5, 1.2);
    let yaw = 0;
    for (let t = 0; t < 400 && b.pos.y > target.top; t++) {
      yaw = approachYaw(yaw, b.pos, target);
      const step = planner.step(b, yaw, target);
      const v = glideVelocity(b.vel, yaw, step.pitch, false);
      b = { ...b, pos: { x: b.pos.x + v.x, y: b.pos.y + v.y, z: b.pos.z + v.z }, vel: v };
    }
    expect(b.pos.y).toBeLessThanOrEqual(target.top + 0.01);
    expect(Math.hypot(b.pos.x - target.x, b.pos.z - target.z)).toBeLessThan(1.5);
    expect(Math.hypot(b.vel.x, b.vel.z)).toBeLessThan(0.6);
    expect(b.vel.y).toBeGreaterThan(-0.5);
  });
});

/** The brain flying a whole trip on stepBody over a synthetic world (the offline simulator of the track). */
function flyTrip(o: { dist: number; up: number; half: number; startUp?: number; wall?: boolean; rockets?: number; life?: number }) {
  const tx = 0;
  const tz = o.dist;
  const top = FEET + o.up;
  const boxes = [] as { from: { x: number; y: number; z: number }; to: { x: number; y: number; z: number }; solid: boolean }[];
  if (o.up > 0) boxes.push({ from: { x: tx - o.half, y: top - 1, z: tz - o.half }, to: { x: tx + o.half, y: top - 1, z: tz + o.half }, solid: true });
  if (o.wall) boxes.push({ from: { x: tx - 3, y: top - 1, z: tz - o.half - 10 }, to: { x: tx + 3, y: top + 11, z: tz - o.half - 10 }, solid: true });
  if (o.startUp) boxes.push({ from: { x: -1, y: FEET, z: -1 }, to: { x: 1, y: FEET + o.startUp - 1, z: 1 }, solid: true });
  const world: BlockQuery = withBoxes(flatWorld(), boxes);
  const skyTop = (x: number, z: number): number => {
    for (let y = 100; y >= -64; y--) if (world.solidAt(x, y, z)) return y;
    return -64;
  };
  const target: LandingTarget = { x: tx + 0.5, z: tz + 0.5, top, half: o.half, ground: FEET };
  const start = { x: 0.5, y: FEET + (o.startUp ?? 0), z: 0.5 };
  const cz = cruiseHeight(start, target, skyTop, {});
  const brain = new FlightBrain(target, { cruiseY: cz.y, groundAt: (x, z) => skyTop(x, z) + 1, obstacle: (x, y, z) => world.solidAt(x, y, z) === true, seed: 5 });
  let body = initialBody(start, true);
  let cmd = { ...IDLE_COMMAND };
  let rockets = o.rockets ?? 64;
  let lastFire = -100;
  let lastAir = { vy: 0, h: 0 };
  for (let t = 1; t < 4000; t++) {
    const out = brain.step({
      tick: t,
      body: { pos: body.pos, vel: body.vel, onGround: body.onGround, gliding: body.gliding ?? false, boostTicks: body.boostTicks ?? 0 },
      yaw: cmd.yaw,
      pitch: cmd.pitch,
      rockets,
      canFire: t - lastFire >= 4,
      health: 20,
      elytraLeft: 400,
    });
    const c = out.control;
    cmd = { ...cmd, yaw: c.yaw, pitch: c.pitch, jump: c.jump, glide: c.glide };
    const step = { ...cmd, ...(c.fire ? { boostStart: Math.min(GLIDE.boostTicks, o.life ?? 15) } : {}) };
    if (c.fire) {
      rockets--;
      lastFire = t;
    }
    if (body.gliding) lastAir = { vy: body.vel.y, h: Math.hypot(body.vel.x, body.vel.z) };
    body = stepBody(body, step, world).state;
    if (out.end) return { end: out.end, ticks: t, rockets: (o.rockets ?? 64) - rockets, goArounds: brain.stats.goArounds, lastAir, maxY: brain.stats.maxY, body };
  }
  throw new Error('the flight never ended');
}

describe('fly: the brain flies whole trips on stepBody', () => {
  it('150 blocks to a 3x3 platform 40 up: lands on it with a soft touchdown and few rockets', () => {
    const r = flyTrip({ dist: 150, up: 40, half: 1 });
    expect(r.end.ok, JSON.stringify(r.end)).toBe(true);
    expect(r.end.off).toBeLessThanOrEqual(1.5);
    expect(r.lastAir.vy).toBeGreaterThan(-0.5);
    expect(r.rockets).toBeLessThanOrEqual(6);
    expect(r.goArounds).toBeLessThanOrEqual(2);
  });

  it('100 blocks to flat ground: one rocket, lands within a block and a half of the aim', () => {
    const r = flyTrip({ dist: 100, up: 0, half: 40 });
    expect(r.end.ok).toBe(true);
    expect(r.end.off).toBeLessThan(1.5);
    expect(r.rockets).toBeLessThanOrEqual(2);
  });

  it('from 60 blocks above the platform level, 100 blocks away: spirals down and lands without a go-around', () => {
    const r = flyTrip({ dist: 100, up: 40, half: 1, startUp: 100 });
    expect(r.end.ok).toBe(true);
    expect(r.goArounds).toBe(0);
    expect(r.rockets).toBeLessThanOrEqual(2);
  });

  it('a wall 12 high 10 blocks before the platform: at least one go-around, then a landing', () => {
    const r = flyTrip({ dist: 150, up: 40, half: 1, wall: true });
    expect(r.end.ok).toBe(true);
    expect(r.goArounds).toBeGreaterThanOrEqual(1);
  });

  it('300 blocks to a 5x5 platform 20 up: at most 6 rockets', () => {
    const r = flyTrip({ dist: 300, up: 20, half: 2 });
    expect(r.end.ok).toBe(true);
    expect(r.rockets).toBeLessThanOrEqual(6);
  });

  it('out of rockets early: the flight ends on the ground (no_rockets or landed short), never in the air', () => {
    const r = flyTrip({ dist: 300, up: 20, half: 2, rockets: 1 });
    expect(r.body.onGround).toBe(true);
    expect(r.end.ok || r.end.reason === 'no_rockets' || r.end.reason === 'landed_off').toBe(true);
  });

  it('landNow in the air ends on the ground; landNow on the ground before the takeoff is done at once', () => {
    const target: LandingTarget = { x: 0.5, z: 150.5, top: -20, half: 1, ground: FEET };
    const brain = new FlightBrain(target, { cruiseY: -5, groundAt: () => FEET });
    brain.landNow('stopped', { pos: { x: 0.5, y: FEET, z: 0.5 }, vel: { x: 0, y: 0, z: 0 }, onGround: true, gliding: false, boostTicks: 0 });
    expect(brain.phase).toBe('done');
    const flying = new FlightBrain(target, { cruiseY: -5, groundAt: () => FEET });
    flying.step({ tick: 1, body: { pos: { x: 0.5, y: -30, z: 40 }, vel: { x: 0, y: -0.15, z: 1.2 }, onGround: false, gliding: true, boostTicks: 0 }, yaw: 0, pitch: 0, rockets: 10, canFire: true, health: 20, elytraLeft: 400 });
    flying.landNow('stopped', { pos: { x: 0.5, y: -30, z: 40 }, vel: { x: 0, y: -0.15, z: 1.2 }, onGround: false, gliding: true, boostTicks: 0 });
    expect(flying.phase).toBe('land');
    expect(flying.aim.top).toBe(FEET);
  });

  it('skyQuery treats unknown cells as air and keeps known ones', () => {
    const q = skyQuery({ solidAt: (x, y) => (y === 0 ? true : y === 1 ? false : undefined) });
    expect(q.solidAt(0, 0, 0)).toBe(true);
    expect(q.solidAt(0, 1, 0)).toBe(false);
    expect(q.solidAt(0, 5, 0)).toBe(false);
  });

  it('the in-air process outranks flee', () => {
    expect(FLIGHT_PRIORITY).toBeGreaterThan(PRIORITY.flee);
  });
});

describe('fly: the kit rules', () => {
  const raw64 = boxRaw([{ name: 'firework_rocket', count: 64 }]);
  const inv = (slots: (ItemStack | null)[], worn: ItemStack | null = null, raws: Record<number, unknown> = {}) => ({
    slots: [...slots, ...Array.from({ length: 36 - slots.length }, () => null)],
    rawItem: (_w: number, i: number) => raws[i],
    window: (id: number) => (id === 120 ? { slots: [null, worn, null, null] } : undefined),
  });

  it('a fireworks box is a shulker box holding rockets only; readKit counts the elytra, the rockets (hotbar and all) and the box', () => {
    expect(isFireworksBox('undyed_shulker_box', raw64)).toBe(true);
    expect(isFireworksBox('red_shulker_box', boxRaw([{ name: 'firework_rocket', count: 10 }, { name: 'cobblestone', count: 3 }]))).toBe(false);
    expect(isFireworksBox('undyed_shulker_box', boxRaw([]))).toBe(false);
    expect(isFireworksBox('chest', raw64)).toBe(false);
    const k = readKit(inv([item('firework_rocket', 16), null, null, null, null, null, null, null, null, item('elytra', 1, 32), item('firework_rocket', 7), item('undyed_shulker_box')], null, { 11: raw64 }));
    expect(k.elytraSlot).toBe(9);
    expect(k.elytraWorn).toBe(false);
    expect(k.elytraLeft).toBe(400);
    expect(k.rocketsHotbar).toBe(16);
    expect(k.rockets).toBe(23);
    expect(k.boxSlot).toBe(11);
    expect(k.boxRockets).toBe(64);
    expect(kitLine(k)).toBe('elytra 400/432, 23 rockets (16 in the hotbar), box 64');
    expect(keptKitLine(k)).toBe('kept the flight kit (elytra, 23 rockets, the fireworks box); !drop flightkit drops it');
    const named = readKit(inv([null, item('undyed_shulker_box')], item('elytra'), { 1: boxRaw([]) }), { namedBoxSlot: 1 });
    expect(named.boxSlot).toBe(1);
    expect(named.elytraWorn).toBe(true);
  });

  it('kitReady refuses without an elytra, with a worn one (toolWearLimit + 20) and without any rockets', () => {
    expect(kitReady(readKit(inv([item('firework_rocket', 5)])), 10)).toMatchObject({ ok: false, reason: 'no_elytra' });
    const worn = kitReady(readKit(inv([item('firework_rocket', 5), item('elytra', 1, 432 - 25)])), 10);
    expect(worn).toMatchObject({ ok: false, reason: 'elytra_worn', line: 'elytra worn: 25 uses left; I will not fly until it is mended or replaced' });
    expect(elytraWornLimit(10)).toBe(30);
    expect(kitReady(readKit(inv([item('elytra')])), 10)).toMatchObject({ ok: false, reason: 'no_rockets' });
    expect(kitReady(readKit(inv([item('elytra'), item('undyed_shulker_box')], null, { 1: raw64 })), 10)).toEqual({ ok: true });
  });

  it('the keeper never drops the kit, !drop items keeps the rockets, flightKitSlots names every kit slot', () => {
    expect(isFlightKitItem('firework_rocket')).toBe(true);
    expect(isFlightKitItem('minecraft:elytra')).toBe(true);
    expect(neverDrop('firework_rocket')).toBe(true);
    expect(neverDrop('elytra')).toBe(true);
    expect(keepOnDropItems('firework_rocket')).toBe(true);
    expect(keepOnDropItems('undyed_shulker_box')).toBe(true);
    const slots = flightKitSlots(inv([item('firework_rocket', 16), item('cobblestone', 64), item('elytra'), item('undyed_shulker_box'), item('purple_shulker_box')], null, { 3: raw64, 4: boxRaw([{ name: 'cobblestone', count: 64 }]) }), undefined);
    expect([...slots].sort()).toEqual([0, 2, 3]);
  });

  it('the unloader keeps a flight-kit box, the armour pass leaves a worn elytra alone', () => {
    const plan = planUnload(
      [
        { slot: 0, name: 'undyed_shulker_box', count: 1, boxUsed: 1, flightKit: true },
        { slot: 1, name: 'cobblestone', count: 64 },
      ],
      [{ key: 'c', pos: { x: 0, y: 0, z: 0 }, kind: 'chest', free: 27, contents: {}, room: {}, boxes: { empty: 0, full: 0 } }],
      { reserve: 0 },
    );
    expect(plan.kept).toContainEqual({ name: 'undyed_shulker_box', count: 1, why: 'flight_kit' });
    expect(plan.moves.some((m) => m.name === 'undyed_shulker_box')).toBe(false);
    expect(plan.moves.some((m) => m.name === 'cobblestone')).toBe(true);
    const moves = planArmour([item('iron_chestplate')], [null, item('elytra'), null, null]);
    expect(moves).toEqual([]);
    const plain = planArmour([item('iron_chestplate')], [null, null, null, null]);
    expect(plain).toHaveLength(1);
  });

  it('SupplyWatch says the low-fireworks line once per count and the worn-elytra line once per use count', () => {
    const w = new SupplyWatch();
    const low = readKit(inv([item('firework_rocket', 9), item('elytra')]));
    expect(w.check(low, 16, 10)).toEqual([fireworksLowLine(9)]);
    expect(fireworksLowLine(9)).toBe('fireworks low: 9 rockets left and the box is empty; give me more (drop them or !bring fireworks_rocket 64)');
    expect(w.check(low, 16, 10)).toEqual([]);
    const lower = readKit(inv([item('firework_rocket', 7), item('elytra')]));
    expect(w.check(lower, 16, 10)).toEqual([fireworksLowLine(7)]);
    const boxed = readKit(inv([item('firework_rocket', 7), item('elytra'), item('undyed_shulker_box')], null, { 2: raw64 }));
    expect(w.check(boxed, 16, 10)).toEqual([]);
    const worn = readKit(inv([item('firework_rocket', 40), item('elytra', 1, 432 - 25)]));
    expect(w.check(worn, 16, 10)).toEqual(['elytra worn: 25 uses left; I will not fly until it is mended or replaced']);
    expect(w.check(worn, 16, 10)).toEqual([]);
  });

  it('flyEndLine words the outcomes', () => {
    const target = { x: 0.5, z: 0.5, top: -20, half: 1, label: 'home' };
    const report = { ok: true, landedAt: { x: 0.7, y: -20, z: 0.2 }, off: 0.4, onTarget: true, rockets: 3, goArounds: 1, ticks: 200, corrections: 4, glideEnds: 1, touchdown: { vy: -0.1, h: 0.3 }, maxY: 0 };
    expect(flyEndLine({ ok: true, target, distance: 150, report, seconds: 12, notes: [] })).toBe('landed at 0.7 -20 0.2, 0.4 from the aim (home); 3 rockets, 1 go-around, 12 s');
    expect(flyEndLine({ ok: false, reason: 'stopped', target, distance: 150, report: { ...report, ok: false }, seconds: 5, notes: [] })).toMatch(/^landed \(stopped\) at /);
    expect(flyEndLine({ ok: false, reason: 'no_glide', target, distance: 150, seconds: 5, notes: [] })).toMatch(/^fly: the server did not let me glide/);
  });
});
