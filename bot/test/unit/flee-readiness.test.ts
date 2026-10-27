// Flee v2 and trip readiness (wave 7, Track W; docs/pve.md "Flee", "Trip readiness") on fakes: the
// home-between rule, the creeper rule, eating while fleeing (only 8 clear), the recovery hysteresis,
// cornered, the readiness rules and the preparation, `!come` eating first / refused at night / `now`,
// and `!come` to a player beyond the entity range through the locator bar.
import { describe, expect, it } from 'vitest';
import type { CommandDef } from '../../src/chat/chat.ts';
import { registerPveCommands, type PveCommandDeps } from '../../src/chat/commands-pve.ts';
import { checkTrip, hasChestplate, longTrip, needsPrep, prepareTrip, splitNow, type TripKit } from '../../src/tasks/process/readiness.ts';
import { homeClear, PveController, type PveNight } from '../../src/tasks/pve.ts';
import { Inventory } from '../../src/world/inventory.ts';
import type { EntityInfo, ItemStack, Vec3 } from '../../src/world/types.ts';
import { FakeLoop, FakeMover, FakeSource, mob } from './skills/pve-fakes.ts';

class PveMover extends FakeMover {
  collect(): Promise<unknown> {
    return Promise.resolve({ ok: true });
  }
}

/** A survival kit fake: each bite +5 food (the server refuses at 20). */
class FakeKit implements TripKit {
  readonly overrides: { autoEat?: boolean } = {};
  bites = 0;
  equips = 0;
  busy = false;
  plans: unknown[] = [];
  foodLeft = 8;
  private readonly self: { food: number };
  constructor(self: { food: number }) {
    this.self = self;
  }
  readonly armour = { worn: (): (ItemStack | null)[] => [null, null, null, null], plan: () => this.plans };
  eat(): Promise<{ ok: boolean; reason?: string }> {
    if (this.self.food >= 20) return Promise.resolve({ ok: false, reason: 'not_hungry' });
    if (this.foodLeft <= 0) return Promise.resolve({ ok: false, reason: 'no_food' });
    this.foodLeft--;
    this.bites++;
    this.self.food = Math.min(20, this.self.food + 5);
    return Promise.resolve({ ok: true });
  }
  equip(): Promise<{ ok: boolean; equipped: string[] }> {
    this.equips++;
    this.plans = [];
    return Promise.resolve({ ok: true, equipped: ['chest iron_chestplate'] });
  }
}

const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

function setup(opts: { home?: Vec3; shelter?: Vec3; night?: PveNight; guard?: boolean; food?: number } = {}) {
  const src = new FakeSource();
  const loop = new FakeLoop();
  const mover = new PveMover();
  const ents = new Map<bigint, EntityInfo>();
  const inventory = new Inventory(() => null, () => 1n);
  const self = { runtimeId: 1n, health: 20, food: opts.food ?? 20 };
  const pve = new PveController({
    source: src,
    world: { entities: ents, inventory, self },
    loop,
    skills: mover,
    home: () => opts.home,
    shelter: () => opts.shelter,
    night: opts.night,
    inactive: () => false,
    options: { guard: { on: opts.guard ?? false, radius: 16 } },
  });
  const kit = new FakeKit(self);
  pve.kit = () => kit;
  src.emit('start_game', { entity_id: -42n });
  src.emit('set_health', { health: 20 });
  return { src, loop, mover, ents, pve, kit, self };
}

describe('flee v2', () => {
  it('home is clear when every threat is more than 60 degrees off its bearing, or farther than home', () => {
    const me = { x: 0.5, y: -60, z: 0.5 };
    const home = { x: 20, y: -60, z: 0 }; // east
    expect(homeClear(me, home, [{ x: 8, y: -60, z: 0 }])).toBe(false); // on the way
    expect(homeClear(me, home, [{ x: 8, y: -60, z: 9 }])).toBe(false); // 49 degrees off and closer than home
    expect(homeClear(me, home, [{ x: 4, y: -60, z: 8 }])).toBe(true); // 63 degrees off
    expect(homeClear(me, home, [{ x: 30, y: -60, z: 1 }])).toBe(true); // beyond home
    expect(homeClear(me, home, [{ x: -8, y: -60, z: 0 }])).toBe(true); // behind
  });

  it('one melee mob and health for 3 more of its hits: no flight (duel); two of them: flight', () => {
    const s = setup({ guard: true });
    s.ents.set(7n, mob(7n, 'minecraft:zombie', { x: 0.5, y: -60, z: 6 }));
    s.src.emit('set_health', { health: 7 });
    (s.pve as unknown as { recentHits: unknown[] }).recentHits.length = 0; // the set_health drop is not a fight
    s.pve.lastHit = { damage: 1.4, at: performance.now() }; // iron armour
    s.loop.step(5);
    expect(s.pve.behaviour()).toBe('guarding r=16'); // low: guard waits for it within reach (in place), no flight
    s.ents.set(8n, mob(8n, 'minecraft:zombie', { x: 3, y: -60, z: 6 }));
    s.loop.step(5);
    expect(s.pve.behaviour()).toBe('fleeing');
  });

  it('a creeper within 6 starts a flight below health 10 whatever fleeHealth says', () => {
    const s = setup();
    s.ents.set(9n, mob(9n, 'minecraft:creeper', { x: 0.5, y: -60, z: 5 }));
    s.src.emit('set_health', { health: 12 });
    s.loop.step(5);
    expect(s.pve.behaviour()).toBe('idle');
    s.src.emit('set_health', { health: 9 });
    s.loop.step(1);
    expect(s.pve.behaviour()).toBe('fleeing');
    expect(s.mover.gotos.at(-1)!.goal).toMatchObject({ type: 'runAway', r: 16 });
  });

  it('eats while fleeing only when 8 clear of every hostile; holds the kit auto-eat during the flight', async () => {
    const s = setup({ food: 14 });
    s.ents.set(7n, mob(7n, 'minecraft:zombie', { x: 0.5, y: -60, z: 5 }));
    s.src.emit('set_health', { health: 6 });
    s.loop.step(5);
    expect(s.pve.behaviour()).toBe('fleeing');
    expect(s.kit.overrides.autoEat).toBe(false);
    s.loop.step(10);
    await flush();
    expect(s.kit.bites).toBe(0); // the zombie is 4.5 away
    s.loop.pos = { x: 0.5, y: -60, z: -5 };
    s.loop.step(5);
    await flush();
    expect(s.kit.bites).toBe(1); // 9.5 away: one bite
    s.ents.delete(7n);
    for (let i = 0; i < 30; i++) s.loop.step(5);
    await new Promise((r) => setTimeout(r, 2100));
    s.loop.step(5);
    expect(s.pve.behaviour()).toBe('idle');
    expect('autoEat' in s.kit.overrides).toBe(false); // restored
  });

  it('keeps away until the health is back to fleeHealth + 6 (no fleeing at 7.9 and fighting at 8.1)', async () => {
    const s = setup({ guard: true });
    s.ents.set(7n, mob(7n, 'minecraft:zombie', { x: 0.5, y: -60, z: 5 }));
    s.src.emit('set_health', { health: 7 });
    s.loop.step(5);
    expect(s.pve.behaviour()).toBe('fleeing');
    // the zombie is gone; health 9 (above fleeHealth 8, below 14)
    s.ents.delete(7n);
    s.src.emit('set_health', { health: 9 });
    s.loop.step(5);
    await new Promise((r) => setTimeout(r, 2100));
    s.loop.step(5);
    expect(s.pve.behaviour()).toBe('guarding r=16');
    await new Promise((r) => setTimeout(r, 2100)); // the cooldown
    // an archer does not start a recovery flight (guard goes for it)
    s.ents.set(9n, mob(9n, 'minecraft:skeleton', { x: 0.5, y: -60, z: -10 }));
    s.loop.step(5);
    expect(s.pve.behaviour()).toBe('fighting skeleton');
    s.pve.guardProcess.cancelEpisode();
    s.ents.delete(9n);
    s.ents.set(8n, mob(8n, 'minecraft:zombie', { x: 0.5, y: -60, z: 10 }));
    s.loop.step(5);
    expect(s.pve.behaviour()).toBe('fleeing'); // recovering: no fight yet
    s.src.emit('set_health', { health: 15 });
    s.pve.fleeProcess.cancelEpisode();
    await new Promise((r) => setTimeout(r, 10));
    s.loop.step(5);
    expect(s.pve.behaviour()).toBe('fighting zombie');
  });

  it('no plan: runs straight away by hand for 15 ticks; cornered after 4 such tries (guard defends in place)', async () => {
    const s = setup();
    s.ents.set(7n, mob(7n, 'minecraft:zombie', { x: 0.5, y: -60, z: 3 }));
    s.src.emit('set_health', { health: 5 });
    s.loop.step(5);
    expect(s.pve.behaviour()).toBe('fleeing');
    s.mover.finish({ ok: false, reason: 'unreachable' });
    await flush();
    s.loop.step(1);
    expect(s.pve.behaviour()).toBe('fleeing');
    expect(s.loop.cmd).toMatchObject({ forward: 1, sprint: true });
    expect(Math.abs(Math.abs(s.loop.cmd.yaw) - 180)).toBeLessThan(10); // away from the zombie (+z): -z
    s.loop.pos = { x: 0.5, y: -60, z: 0 }; // pinned (a wall behind)
    for (let i = 0; i < 4; i++) {
      s.loop.step(20);
      s.loop.pos = { x: 0.5, y: -60, z: 0 }; // the run got nowhere
      s.mover.finish({ ok: false, reason: 'unreachable' });
      await flush();
    }
    expect(s.pve.behaviour()).toBe('idle');
  });
});

describe('trip readiness rules', () => {
  const chest: ItemStack = { name: 'iron_chestplate', networkId: 1, count: 1, metadata: 0 };
  it('prepares when food or health is below 14, for trips of more than 16 blocks', () => {
    expect(needsPrep({ food: 13, health: 20 })).toBe(true);
    expect(needsPrep({ food: 20, health: 13.5 })).toBe(true);
    expect(needsPrep({ food: 14, health: 14 })).toBe(false);
    expect(longTrip({ x: 0, y: 0, z: 0 }, { x: 16, y: 0, z: 0 })).toBe(false);
    expect(longTrip({ x: 0, y: 0, z: 0 }, { x: 17, y: 0, z: 0 })).toBe(true);
    expect(longTrip({ x: 0, y: 0, z: 0 }, undefined)).toBe(true);
    expect(hasChestplate([null, chest], [])).toBe(true);
    expect(hasChestplate([null, null], [null, chest])).toBe(true);
    expect(hasChestplate([null, null], [])).toBe(false);
    expect(splitNow(['Steve', 'NOW'])).toEqual({ args: ['Steve'], now: true });
    expect(splitNow(['Steve'])).toEqual({ args: ['Steve'], now: false });
  });

  it('refuses at night without a chestplate unless now; short trips are never refused', () => {
    const base = { cmd: 'come', self: { food: 10, health: 20 }, worn: [], slots: [], long: true, now: false };
    expect(checkTrip({ ...base, timeOfDay: 6000 })).toEqual({ prep: true });
    expect(checkTrip({ ...base, timeOfDay: 18000 }).refuse).toBe('come: it is night and I have no chestplate; add "now" to go anyway (!come now)');
    expect(checkTrip({ ...base, timeOfDay: 18000, now: true })).toEqual({ prep: true });
    expect(checkTrip({ ...base, timeOfDay: 18000, worn: [null, chest] })).toEqual({ prep: true });
    expect(checkTrip({ ...base, timeOfDay: 18000, long: false })).toEqual({ prep: false });
  });

  it('prepareTrip puts on armour, then eats until full (or no food)', async () => {
    const self = { food: 6, health: 20 };
    const kit = new FakeKit(self);
    kit.plans = [{}];
    const phases: string[] = [];
    const r = await prepareTrip(kit, self, { alive: () => true, phase: (p) => phases.push(p), wait: () => Promise.resolve() });
    expect(r).toMatchObject({ bites: 3, foodBefore: 6, foodAfter: 20, stop: 'full', equipped: ['chest iron_chestplate'] });
    expect(phases).toEqual(['armour', 'eating']);
    const self2 = { food: 2, health: 20 };
    const kit2 = new FakeKit(self2);
    kit2.foodLeft = 1;
    expect(await prepareTrip(kit2, self2, { alive: () => true, phase: () => undefined, wait: () => Promise.resolve() })).toMatchObject({ bites: 1, foodAfter: 7, stop: 'no_food' });
  });
});

describe('come with readiness', () => {
  const player = (pos: Vec3): EntityInfo => mob(50n, 'minecraft:player', { x: pos.x, y: pos.y + 1.62, z: pos.z }, { username: 'Steve' });

  it('food 6 and a player 30 blocks away: preparing: eating first, then the walk', async () => {
    const s = setup({ food: 6 });
    s.ents.set(50n, player({ x: 30.5, y: -60, z: 0.5 }));
    const done = s.pve.come('Steve');
    expect(s.pve.behaviour()).toBe('preparing: eating');
    expect(s.pve.processes.stack()[0]!.line).toBe('preparing: eating (then coming to Steve)');
    expect(s.mover.gotos).toHaveLength(0);
    await flush();
    expect(s.kit.bites).toBe(3);
    expect(s.self.food).toBe(20);
    expect(s.pve.behaviour()).toBe('coming to Steve');
    expect(s.mover.gotos.at(-1)!.goal).toMatchObject({ type: 'near', r: 2 });
    s.mover.finish({ ok: true });
    expect(await done).toEqual({ ok: true });
  });

  it('a short come or a fed bot goes at once', () => {
    const s = setup({ food: 6 });
    s.ents.set(50n, player({ x: 10.5, y: -60, z: 0.5 }));
    void s.pve.come('Steve');
    expect(s.pve.behaviour()).toBe('coming to Steve');
    expect(s.kit.bites).toBe(0);
  });

  it('beyond the entity range: walks to the locator bar position, then on to the tracked player', async () => {
    const s = setup();
    s.src.emit('player_list', { records: { records: [{ type: 'add', uuid: 'u1', entity_unique_id: -77n, username: 'Steve' }] } });
    s.src.emit('player_location', { entity_unique_id: -77n, type: 'coordinates', position: { x: 100.5, y: -58.38, z: 0.5 } });
    expect(s.pve.playerFeet('Steve')).toEqual({ x: 100.5, y: -60, z: 0.5 });
    const done = s.pve.come('Steve');
    expect(s.mover.gotos.at(-1)!.goal).toEqual({ type: 'near', p: { x: 100.5, y: -60, z: 0.5 }, r: 2 });
    // in range now: the last stretch to the tracked player
    s.ents.set(50n, player({ x: 103.5, y: -60, z: 2.5 }));
    s.mover.finish({ ok: true });
    await flush();
    expect(s.mover.gotos.at(-1)!.goal).toMatchObject({ type: 'near', p: { x: 103.5, z: 2.5 }, r: 2 });
    s.mover.finish({ ok: true });
    expect(await done).toEqual({ ok: true });
    // unknown players: not found
    expect(await s.pve.come('Alex')).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('!come / !follow / !kill with readiness', () => {
  function chat() {
    const defs = new Map<string, CommandDef>();
    return {
      chat: { register: (d: CommandDef) => defs.set(d.name, d) } as never,
      run: (name: string, args: string[]) => {
        const out: string[] = [];
        defs.get(name)!.run({ line: {} as never, sender: { kind: 'player', name: 'Steve', xuid: '' }, args, reply: (m) => out.push(m) });
        return out;
      },
    };
  }

  it('replies eating first, refuses at night without a chestplate, and passes now as urgent', () => {
    const calls: string[] = [];
    let check = { prep: true } as { prep: boolean; refuse?: string };
    const deps: PveCommandDeps = {
      follow: (n, o) => (calls.push(`follow ${n} ${o?.urgent ? 'urgent' : ''}`), n),
      come: (n, o) => (calls.push(`come ${n} ${o?.urgent ? 'urgent' : ''}`), Promise.resolve({ ok: true })),
      stop: () => 'idle',
      guard: () => ({ on: true, radius: 16 }),
      setGuard: () => ({ on: true, radius: 16 }),
      kill: (t, n, o) => (calls.push(`kill ${t} ${n} ${o?.urgent ? 'urgent' : ''}`), Promise.resolve({ ok: true, killed: n, want: n, reason: 'done', type: t })),
      refused: () => false,
      behaviour: () => 'idle',
      selfName: () => 'Bot',
      trip: (cmd, _target, now) => (now ? { prep: check.prep } : check),
    };
    const c = chat();
    registerPveCommands(c.chat, deps);
    expect(c.run('come', [])).toEqual(['coming to Steve (eating first)']);
    expect(c.run('follow', ['Alex'])).toEqual(['following Alex (eating first)']);
    expect(c.run('kill', ['zombie', '2'])).toEqual(['killing 2 zombie (eating first)']);
    check = { prep: false, refuse: 'come: it is night and I have no chestplate; add "now" to go anyway (!come now)' };
    expect(c.run('come', [])).toEqual([check.refuse]);
    expect(c.run('come', ['now'])).toEqual(['coming to Steve']);
    expect(c.run('follow', ['Alex', 'now'])).toEqual(['following Alex']);
    expect(calls).toEqual(['come Steve ', 'follow Alex ', 'kill zombie 2 ', 'come Steve urgent', 'follow Alex urgent']);
    expect(c.run('sleep', [])).toEqual(['sleep needs a task that can walk (start with --walk, --home or --target realm)']);
  });
});
