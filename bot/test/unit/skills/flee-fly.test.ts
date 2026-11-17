// Track M3 (docs/pve.md "The elytra flee", decisions/0086): the elytra flee as a flight mode. The pure choices
// (skills/fly/flee.ts), the floors' order with it (tasks/pve.ts pveFloor, the flee process asking for it and going on
// when it is refused), and the flight's entry point on a fake world (chat/commands-fly.ts `flee`, `fleeReady`,
// `cancelFlee`): where it can take off, where it goes, what its trip is.
import { describe, expect, it } from 'vitest';
import { flyControlOf, registerFlyCommands } from '../../../src/chat/commands-fly.ts';
import { RuntimeSettings, SETTING_DEFS } from '../../../src/config/settings.ts';
import { silentLogger } from '../../../src/log.ts';
import { FLEE_FLY, fleeAway, fleeBearings, fleeHeadings, fleeHomeClear } from '../../../src/skills/fly/flee.ts';
import type { LandMob } from '../../../src/skills/fly/landmobs.ts';
import { parseBlockArgs, type CommandDeps } from '../../../src/tasks/process/deps.ts';
import { FlyProcess } from '../../../src/tasks/process/fly.ts';
import { PRIORITY } from '../../../src/tasks/process/manager.ts';
import { REFLEX_REACH } from '../../../src/skills/combat/reflex.ts';
import { FLIGHT_STRIKE_REACH, FLY_FIRST_HEALTH, FLY_SHOOTER_HEALTH, PveController, pveFloor, type FleeFlightResult, type FloorInput } from '../../../src/tasks/pve.ts';
import { Inventory } from '../../../src/world/inventory.ts';
import type { EntityInfo, ItemStack } from '../../../src/world/types.ts';
import { FakeLoop, FakeMover, FakeSource, mob } from './pve-fakes.ts';

const FEET = -60;
const hostile = (id: number, x: number, z: number, kind: LandMob['kind'] = 'melee'): LandMob => ({ id: BigInt(id), type: 'zombie', kind, x, y: FEET, z, lit: false, hunting: false });
const item = (name: string, count = 1, damage?: number): ItemStack => ({ name, networkId: 1, count, metadata: 0, ...(damage !== undefined ? { damage } : {}) });

describe('the elytra flee: the pure choices (flee.ts)', () => {
  it('away from the hostiles: opposite one, between two, the near one weighing most; nothing known: the way the body looks', () => {
    // Bedrock yaw: 0 = +z, 90 = -x, -90 = +x, 180 = -z
    expect(fleeAway({ x: 0, z: 0 }, [hostile(1, 5, 0)], 33)).toBeCloseTo(90, 6);
    expect(fleeAway({ x: 0, z: 0 }, [hostile(1, 0, 5)], 33)).toBeCloseTo(180, 6);
    expect(fleeAway({ x: 0, z: 0 }, [hostile(1, 5, 0), hostile(2, 0, 5)], 33)).toBeCloseTo(135, 6);
    // one at 2 and one at 20 on the other side: away from the near one
    expect(Math.abs(fleeAway({ x: 0, z: 0 }, [hostile(1, 2, 0), hostile(2, -20, 0)], 33) - 90)).toBeLessThan(1);
    expect(fleeAway({ x: 0, z: 0 }, [], 33)).toBe(33);
    expect(fleeAway({ x: 0, z: 0 }, [hostile(1, 5, 0), hostile(2, -5, 0)], -170)).toBe(-170);
  });

  it('the bearings a destination is looked for on and the takeoff headings: away first, then round from it', () => {
    expect(fleeBearings(90)).toEqual([90, 120, 60, 150, 30, 180, 0]);
    expect(fleeHeadings(170, 90)).toEqual([170, -160, 140, -130, 110, -100, 80]);
    expect(fleeHeadings(0, 60)).toEqual([0, 30, -30, 60, -60]);
  });

  it('home is a destination only when no hostile round the body stands on the way to it (60 degrees either side of its bearing)', () => {
    const from = { x: 0, z: 0 };
    const home = { x: 0, z: -100 };
    expect(fleeHomeClear(from, home, [])).toBe(true);
    // a mob to the side, and one behind the body: clear
    expect(fleeHomeClear(from, home, [hostile(1, 5, 0), hostile(2, 0, 8)])).toBe(true);
    // one that has followed the body away from home stands between the two
    expect(fleeHomeClear(from, home, [hostile(1, 0, -12)])).toBe(false);
    expect(fleeHomeClear(from, home, [hostile(1, 6, -12)])).toBe(false); // 27 degrees off
    expect(fleeHomeClear(from, home, [hostile(1, 12, -6)])).toBe(true); // 63 degrees off
    expect(FLEE_FLY.homeAngle).toBe(60);
  });

  it('the numbers: 3 rockets, 8 blocks of head room, 96 blocks away, home between 48 and 400', () => {
    expect(FLEE_FLY).toMatchObject({ rockets: 3, headroom: 8, far: 96, homeMin: 48, homeMax: 400, safe: 24 });
    expect(SETTING_DEFS.fleeFly.default).toBe(false);
  });
});

describe('the floors with the elytra flee (pveFloor)', () => {
  const base: FloorInput = { danger: true, canDuel: false, nearest: 3, health: 7, food: 14, hasFood: true, failed: false, critical: false, fly: true, seal: true };
  it('the flee that can go and comes first (no blade, or the health at most FLY_FIRST_HEALTH): before the flight on foot; else after it, as before', () => {
    expect(pveFloor(base)).toBe('backoff');
    expect(pveFloor({ ...base, flyFirst: true })).toBe('fly');
    // never before the fight that is worth it, never before the bite in the clear
    expect(pveFloor({ ...base, flyFirst: true, canDuel: true })).toBe('fight');
    expect(pveFloor({ ...base, flyFirst: true, danger: false })).toBe('fight');
    expect(pveFloor({ ...base, flyFirst: true, nearest: 9 })).toBe('eat');
    // it cannot go (a roof, no rockets, tried within 30 s): the floors as they were
    expect(pveFloor({ ...base, fly: false, flyFirst: false })).toBe('backoff');
    expect(pveFloor({ ...base, fly: false, flyFirst: false, critical: true })).toBe('seal');
    expect(pveFloor({ ...base, critical: true })).toBe('fly');
    expect(FLY_FIRST_HEALTH).toBe(6);
  });
});

describe('the guard asks for the elytra flee (tasks/pve.ts)', () => {
  function setup(health: number) {
    const src = new FakeSource();
    const loop = new FakeLoop();
    const ents = new Map<bigint, EntityInfo>();
    const inventory = new Inventory(() => null, () => 1n);
    const mover = Object.assign(new FakeMover(), { collect: () => Promise.resolve({ ok: true }) });
    const pve = new PveController({ source: src, world: { entities: ents, inventory, self: { runtimeId: 1n, health } }, loop, skills: mover, home: () => undefined, shelter: () => undefined, inactive: () => false, options: { guard: { on: true, radius: 16 } } });
    pve.settings.set('mobReflex', false);
    src.emit('start_game', { entity_id: -42n });
    src.emit('set_health', { health });
    const asked: string[] = [];
    let answer!: (r: FleeFlightResult) => void;
    let ready = true;
    let cancelled = 0;
    pve.fleeFlight = {
      ready: () => ready,
      go: (why) => {
        asked.push(why);
        return new Promise<FleeFlightResult>((r) => (answer = r));
      },
      cancel: () => (cancelled++, true),
      active: () => false,
    };
    return { src, loop, ents, pve, mover, asked, answer: (r: FleeFlightResult) => answer(r), setReady: (v: boolean) => (ready = v), cancelled: () => cancelled, blade: () => inventory.setItem(0, 0, item('netherite_sword')) };
  }
  const tick = async (s: { loop: FakeLoop }, n = 6): Promise<void> => {
    for (let i = 0; i < n; i++) {
      s.loop.step();
      await Promise.resolve();
    }
  };

  it('fleeFly off: the flight on foot as before, the flee never asked', async () => {
    const s = setup(7);
    s.ents.set(7n, mob(7n, 'minecraft:skeleton', { x: s.loop.pos.x + 9, y: s.loop.pos.y, z: s.loop.pos.z }));
    s.ents.set(8n, mob(8n, 'minecraft:skeleton', { x: s.loop.pos.x - 9, y: s.loop.pos.y, z: s.loop.pos.z }));
    s.ents.set(9n, mob(9n, 'minecraft:zombie', { x: s.loop.pos.x, y: s.loop.pos.y, z: s.loop.pos.z + 5 }));
    await tick(s);
    expect(s.asked).toEqual([]);
    expect(s.pve.floors.backoff).toBe(1);
    expect(s.pve.floors.fly).toBeUndefined();
  });

  it('fleeFly on, no blade, a flee trigger: the elytra flee before the run; the guard and the flight on foot stand down until it answers', async () => {
    const s = setup(7);
    s.pve.settings.set('fleeFly', true);
    s.ents.set(7n, mob(7n, 'minecraft:skeleton', { x: s.loop.pos.x + 9, y: s.loop.pos.y, z: s.loop.pos.z }));
    s.ents.set(8n, mob(8n, 'minecraft:skeleton', { x: s.loop.pos.x - 9, y: s.loop.pos.y, z: s.loop.pos.z }));
    s.ents.set(9n, mob(9n, 'minecraft:zombie', { x: s.loop.pos.x, y: s.loop.pos.y, z: s.loop.pos.z + 5 }));
    // a walk home that waits its turn (the home return): dropped when the flee is asked for
    const pm = s.pve.processes as unknown as { find(n: string): unknown[]; stop(p: unknown, r: string): unknown };
    const home = { name: 'home' };
    const dropped: string[] = [];
    const find = pm.find.bind(pm);
    const stop = pm.stop.bind(pm);
    pm.find = (n) => (n === 'home' ? [home] : find(n));
    pm.stop = (q, r) => (q === home ? (dropped.push(r), true) : stop(q, r));
    await tick(s);
    expect(s.asked).toHaveLength(1);
    expect(dropped).toEqual(['dropped']);
    expect(s.asked[0]).toMatch(/^no blade with (skeleton|zombie) at \d/);
    expect(s.pve.floors.fly).toBe(1);
    expect(s.pve.floors.backoff).toBeUndefined();
    expect(s.pve.flyHandover()).toBe(true);
    const guard = (s.pve as unknown as { guardProcess: { wants(): boolean } }).guardProcess;
    const flee = (s.pve as unknown as { fleeProcess: { wants(): boolean } }).fleeProcess;
    expect(guard.wants()).toBe(false);
    expect(flee.wants()).toBe(false);
    await tick(s, 20);
    expect(s.asked).toHaveLength(1);
    // it flew and landed: the result is kept, nothing else was started meanwhile
    s.answer({ ok: true, flew: true, line: 'elytra flee: landed' });
    await tick(s, 1);
    expect(s.pve.lastFleeFlight).toMatchObject({ ok: true, flew: true });
    expect(s.pve.flyHandover()).toBe(false);
    expect(s.mover.gotos).toEqual([]);
  });

  it('a flee that made no takeoff (a roof): the flight on foot goes on at once, and the flee is not asked again for 30 s', async () => {
    const s = setup(7);
    s.pve.settings.set('fleeFly', true);
    s.ents.set(9n, mob(9n, 'minecraft:zombie', { x: s.loop.pos.x, y: s.loop.pos.y, z: s.loop.pos.z + 5 }));
    s.ents.set(10n, mob(10n, 'minecraft:zombie', { x: s.loop.pos.x + 5, y: s.loop.pos.y, z: s.loop.pos.z }));
    await tick(s);
    expect(s.asked).toHaveLength(1);
    s.answer({ ok: false, flew: false, reason: 'a roof 3 over the feet', line: 'no elytra flee: a roof 3 over the feet' });
    await tick(s, 8);
    expect(s.pve.lastFleeFlight).toMatchObject({ flew: false });
    expect(s.asked).toHaveLength(1);
    expect(s.pve.floors.backoff).toBe(1);
    // where it cannot take off at all (`ready` false) it is never asked
    const t = setup(7);
    t.pve.settings.set('fleeFly', true);
    t.setReady(false);
    t.ents.set(9n, mob(9n, 'minecraft:zombie', { x: t.loop.pos.x, y: t.loop.pos.y, z: t.loop.pos.z + 5 }));
    t.ents.set(10n, mob(10n, 'minecraft:zombie', { x: t.loop.pos.x + 5, y: t.loop.pos.y, z: t.loop.pos.z }));
    await tick(t);
    expect(t.asked).toEqual([]);
    expect(t.pve.floors.backoff).toBe(1);
  });

  it('with a blade: the flight on foot first; the elytra flee from health 6 down', async () => {
    const s = setup(7);
    s.pve.settings.set('fleeFly', true);
    s.blade();
    s.ents.set(9n, mob(9n, 'minecraft:zombie', { x: s.loop.pos.x, y: s.loop.pos.y, z: s.loop.pos.z + 5 }));
    s.ents.set(10n, mob(10n, 'minecraft:zombie', { x: s.loop.pos.x + 5, y: s.loop.pos.y, z: s.loop.pos.z }));
    await tick(s);
    expect(s.asked).toEqual([]);
    expect(s.pve.floors.backoff).toBe(1);
    const low = setup(5.5);
    low.pve.settings.set('fleeFly', true);
    low.blade();
    low.ents.set(9n, mob(9n, 'minecraft:zombie', { x: low.loop.pos.x, y: low.loop.pos.y, z: low.loop.pos.z + 5 }));
    low.ents.set(10n, mob(10n, 'minecraft:zombie', { x: low.loop.pos.x + 5, y: low.loop.pos.y, z: low.loop.pos.z }));
    await tick(low);
    expect(low.asked).toHaveLength(1);
    expect(low.asked[0]).toMatch(/^health low with zombie/);
  });

  it('no blade, a skeleton in sight, health under 14: the elytra flee before the health is gone; with the flee off, or a blade, nothing new', async () => {
    const s = setup(12);
    s.pve.settings.set('fleeFly', true);
    s.ents.set(7n, mob(7n, 'minecraft:skeleton', { x: s.loop.pos.x + 9, y: s.loop.pos.y, z: s.loop.pos.z }));
    await tick(s);
    expect(s.asked).toHaveLength(1);
    expect(s.asked[0]).toMatch(/^no blade with skeleton at 9/);
    expect(FLY_SHOOTER_HEALTH).toBe(14);
    // at 15 health: not yet
    const high = setup(15);
    high.pve.settings.set('fleeFly', true);
    high.ents.set(7n, mob(7n, 'minecraft:skeleton', { x: high.loop.pos.x + 9, y: high.loop.pos.y, z: high.loop.pos.z }));
    await tick(high);
    expect(high.asked).toEqual([]);
    // the setting off: the trigger does not exist (the flight on foot's own rules: since Track M6 `bareArcher` runs from
    // the archer on foot with no blade; with that rule off, nothing)
    const off = setup(12);
    off.ents.set(7n, mob(7n, 'minecraft:skeleton', { x: off.loop.pos.x + 9, y: off.loop.pos.y, z: off.loop.pos.z }));
    expect(off.pve.fleeReason(off.loop.pos)?.threat.runtimeId).toBe(7n);
    off.pve.rules.bareArcher = false;
    expect(off.pve.fleeReason(off.loop.pos)).toBeUndefined();
    // a blade: the duel
    const armed = setup(12);
    armed.pve.settings.set('fleeFly', true);
    armed.blade();
    armed.ents.set(7n, mob(7n, 'minecraft:skeleton', { x: armed.loop.pos.x + 9, y: armed.loop.pos.y, z: armed.loop.pos.z }));
    expect(armed.pve.fleeReason(armed.loop.pos)).toBeUndefined();
  });

  it('the reflex under a flight: only while the flight says the body is coming down onto its landing, and from farther there', () => {
    const s = setup(20);
    s.pve.settings.set('mobReflex', true);
    const d = (s.pve.reflex as unknown as { d: { enabled(): boolean; reach?(): number } }).d;
    expect(d.enabled()).toBe(true);
    expect(d.reach?.()).toBe(REFLEX_REACH);
    const pm = s.pve.processes as unknown as { active: { name: string } | undefined };
    Object.defineProperty(pm, 'active', { get: () => ({ name: 'flight' }), configurable: true });
    expect(d.enabled()).toBe(false);
    s.pve.flightStrike = () => false;
    expect(d.enabled()).toBe(false);
    s.pve.flightStrike = () => true;
    expect(d.enabled()).toBe(true);
    expect(d.reach?.()).toBe(FLIGHT_STRIKE_REACH);
    expect(FLIGHT_STRIKE_REACH).toBe(5.5);
    expect(FLIGHT_STRIKE_REACH).toBeLessThan(6.2); // the server takes a hit up to 6.2 (docs/pve.md "Server rules")
  });

  it("the owner's !stop cancels an elytra flee", () => {
    const s = setup(20);
    s.pve.stopCommands();
    expect(s.cancelled()).toBe(1);
  });
});

/** The fly commands on a fake world (fly.test.ts comeRig): flat ground, optionally a slab roof 3 over the bot; hostiles as entities. */
function rig(o: { roof?: boolean; home?: { x: number; y: number; z: number }; slots?: (ItemStack | null)[]; hostiles?: EntityInfo[] } = {}) {
  const solid = (x: number, y: number, z: number): boolean => {
    if (y < -64 || y > 319) return false;
    if (y <= FEET - 1) return true;
    return o.roof === true && Math.abs(x) <= 10 && Math.abs(z) <= 10 && y === FEET + 3;
  };
  const block = (s: boolean) => ({ name: s ? 'stone' : 'air', stateId: 1, states: {}, hardness: s ? 1.5 : 0, solid: s, boxes: [] });
  const slots: (ItemStack | null)[] = o.slots ?? [item('firework_rocket', 64), item('elytra', 1, 0), ...Array.from({ length: 34 }, () => null)];
  const inventory = { slots, selected: 0, rawItem: () => undefined, window: (id: number) => (id === 120 ? { slots: [null, null, null, null] } : undefined) };
  const entities = new Map<bigint, EntityInfo>((o.hostiles ?? []).map((e) => [e.runtimeId, e]));
  const world = { blockAt: (p: { x: number; y: number; z: number }) => block(solid(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))), inventory, entities, entityTracker: {}, self: { health: 20, dimension: 0 }, cache: undefined };
  const loop = { state: { ready: true, pos: { x: 0.5, y: FEET, z: 0.5 }, gliding: false, onGround: true, inWater: false, inLava: false }, command: { yaw: 0, pitch: 0 }, waitTicks: () => Promise.resolve() };
  const added: unknown[] = [];
  const stopped: unknown[] = [];
  const pve = { returnHome: () => Promise.resolve({ ok: true }), walk: () => Promise.resolve({ ok: true }), come: () => Promise.resolve({ ok: true }), playerFeet: () => undefined, mover: undefined, hotbar: undefined, mobs: undefined, flightStrike: undefined as (() => boolean) | undefined };
  const settings = new RuntimeSettings();
  const task = { name: 'afk', stop: () => {}, ...(o.home ? { home: { get: () => o.home } } : {}) };
  const deps = {
    chat: { register: () => {}, say: () => {} },
    task,
    conn: { queue: () => {} },
    mobility: { loop },
    skills: {},
    world,
    processes: { add: (p: unknown) => added.push(p), find: () => [], stop: (p: unknown) => (stopped.push(p), true), userProcesses: () => [] },
    settings,
    pve,
    log: silentLogger,
    parseBlock: parseBlockArgs,
    needsWalking: (c: string) => `${c} needs walking`,
  } as unknown as CommandDeps;
  registerFlyCommands(deps);
  return { control: flyControlOf(task)!, added, stopped, settings, pve, loop };
}
const waitFor = async <T>(fn: () => T | undefined): Promise<T | undefined> => {
  for (let i = 0; i < 500; i++) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  return undefined;
};

describe("the elytra flee: the flight's entry point (commands-fly.ts flee, fleeReady, cancelFlee)", () => {
  it('ready under open sky with the elytra and 3 rockets; not under a roof, with 2 rockets, without an elytra', () => {
    expect(rig().control.fleeReady()).toBeUndefined();
    expect(rig({ roof: true }).control.fleeReady()).toBe('a roof 3 over the feet (a takeoff needs 8 open)');
    expect(rig({ slots: [item('firework_rocket', 2), item('elytra', 1, 0)] }).control.fleeReady()).toBe('2 rockets at hand (a flee needs 3)');
    expect(rig({ slots: [item('firework_rocket', 64)] }).control.fleeReady()).toMatch(/no elytra/);
    expect(rig({ slots: [item('firework_rocket', 64), item('elytra', 1, 432 - 5)] }).control.fleeReady()).toMatch(/elytra/);
  });

  it('under a roof: no takeoff, no trip; the answer comes at once and says why', async () => {
    const r = rig({ roof: true });
    const out = await r.control.flee('test');
    expect(out).toMatchObject({ ok: false, flew: false, reason: 'a roof 3 over the feet (a takeoff needs 8 open)' });
    expect(out.line).toBe('no elytra flee: a roof 3 over the feet (a takeoff needs 8 open)');
    expect(r.added.some((p) => p instanceof FlyProcess)).toBe(false);
    expect(r.control.fleeing()).toBe(false);
  });

  it('a zombie to the east: a trip over the flight on foot, heading west, held high over a point 96 blocks away; never the low-health landing', async () => {
    const r = rig({ hostiles: [mob(7n, 'minecraft:zombie', { x: 3.5, y: FEET, z: 0.5 })] });
    void r.control.flee('no blade with zombie at 3.0');
    expect(r.control.fleeing()).toBe(true);
    expect(r.control.fleeReady()).toBe('a flee is on its way');
    const fly = await waitFor(() => r.added.find((p): p is FlyProcess => p instanceof FlyProcess));
    expect(fly).toBeDefined();
    expect(fly).toMatchObject({ name: 'fleefly', kind: 'auto', flee: true });
    expect(fly!.priority).toBe(PRIORITY.flee + 0.5);
    expect(fly!.priority).toBeLessThan(PRIORITY.flee + 1);
    expect(fly!.target).toMatchObject({ hold: true, label: 'safe ground', goal: { x: -96, y: FEET, z: 0 } });
    // the takeoff heading: within 90 degrees of west (yaw 90)
    expect(Math.abs((((fly!.target.takeoffYaw ?? 0) - 90 + 540) % 360) - 180)).toBeLessThanOrEqual(90);
    // the reflex strikes under a flee's flight while it comes down, whatever flyLandMobs says
    expect(r.settings.get('flyLandMobs')).toBe(false);
    expect(r.pve.flightStrike).toBeTypeOf('function');
  }, 30_000);

  it('home 100 blocks away with nothing hostile known there: the flee goes home; home 20 away, or a creeper beside it: the nearest safe ground', async () => {
    const home = { x: 0, y: FEET, z: -100 };
    const r = rig({ home, hostiles: [mob(7n, 'minecraft:zombie', { x: 3.5, y: FEET, z: 0.5 })] });
    void r.control.flee('test');
    const fly = await waitFor(() => r.added.find((p): p is FlyProcess => p instanceof FlyProcess));
    expect(fly!.target).toMatchObject({ label: 'home', goal: { x: 0, y: FEET, z: -100 } });
    const near = rig({ home: { x: 0, y: FEET, z: -20 }, hostiles: [mob(7n, 'minecraft:zombie', { x: 3.5, y: FEET, z: 0.5 })] });
    void near.control.flee('test');
    expect((await waitFor(() => near.added.find((p): p is FlyProcess => p instanceof FlyProcess)))!.target.label).toBe('safe ground');
    // home on the far side of the zombie (it has followed the body away from it): not over it
    const behind = rig({ home: { x: 100, y: FEET, z: 0 }, hostiles: [mob(7n, 'minecraft:zombie', { x: 3.5, y: FEET, z: 0.5 })] });
    void behind.control.flee('test');
    expect((await waitFor(() => behind.added.find((p): p is FlyProcess => p instanceof FlyProcess)))!.target.label).toBe('safe ground');
    const guarded = rig({ home, hostiles: [mob(7n, 'minecraft:zombie', { x: 3.5, y: FEET, z: 0.5 }), mob(8n, 'minecraft:creeper', { x: 10.5, y: FEET, z: -90.5 })] });
    void guarded.control.flee('test');
    expect((await waitFor(() => guarded.added.find((p): p is FlyProcess => p instanceof FlyProcess)))!.target.label).toBe('safe ground');
  }, 30_000);

  it('cancelFlee: nothing to cancel is false; a flee on the ground is stopped', async () => {
    const r = rig({ hostiles: [mob(7n, 'minecraft:zombie', { x: 3.5, y: FEET, z: 0.5 })] });
    expect(r.control.cancelFlee()).toBe(false);
    void r.control.flee('test');
    const fly = await waitFor(() => r.added.find((p): p is FlyProcess => p instanceof FlyProcess));
    expect(r.control.cancelFlee()).toBe(true);
    expect(r.stopped).toContain(fly);
  }, 30_000);
});
