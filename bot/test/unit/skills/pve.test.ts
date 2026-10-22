// PvE behaviour units (PLAN.md tasks 7.4 to 7.6, docs/pve.md) on fakes: guard (fight, pick up,
// return home), what guard ignores (players, passive mobs, mobs outside the radius), flee to the
// shelter, the night-shelter rules, the resumable goto, follow resumed after a fight, !kill (players
// refused), the chat commands and the option parsing.
import { describe, expect, it } from 'vitest';
import type { Chat, CommandDef } from '../../../src/chat/chat.ts';
import { KILL_REFUSED, registerPveCommands, type PveCommandDeps } from '../../../src/chat/commands-pve.ts';
import { PveController, pveOptionsFrom, refusedKillType, type PveNight } from '../../../src/tasks/pve.ts';
import { Inventory } from '../../../src/world/inventory.ts';
import type { EntityInfo, Vec3 } from '../../../src/world/types.ts';
import { FakeLoop, FakeMover, FakeSource, mob } from './pve-fakes.ts';

class PveMover extends FakeMover {
  collects = 0;
  collect(): Promise<unknown> {
    this.collects++;
    return Promise.resolve({ ok: true });
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r));

function setup(opts: { home?: Vec3; shelter?: Vec3; night?: PveNight; guard?: boolean } = {}) {
  const src = new FakeSource();
  const loop = new FakeLoop();
  const mover = new PveMover();
  const ents = new Map<bigint, EntityInfo>();
  const inventory = new Inventory(() => null, () => 1n);
  const world = { entities: ents, inventory, self: { runtimeId: 1n, health: 20 } };
  const pve = new PveController({
    source: src,
    world,
    loop,
    skills: mover,
    home: () => opts.home,
    shelter: () => opts.shelter,
    night: opts.night,
    inactive: () => false,
    options: { guard: { on: opts.guard ?? true, radius: 16 } },
  });
  src.emit('start_game', { entity_id: -42n });
  src.emit('set_health', { health: 20 });
  return { src, loop, mover, ents, pve };
}

describe('PveController guard', () => {
  it('fights a hostile within the radius of home, picks up the drops, walks home and guards again', async () => {
    const s = setup({ home: { x: 0, y: -60, z: 0 } });
    expect(s.pve.behaviour()).toBe('guarding r=16');
    s.ents.set(7n, mob(7n, 'minecraft:zombie', { x: 0.5, y: -60, z: 10.5 }));
    s.loop.step(5);
    expect(s.pve.behaviour()).toBe('fighting zombie');
    expect(s.pve.ownsMovement()).toBe(true);
    s.loop.step(1);
    expect(s.mover.gotos.at(-1)!.goal).toMatchObject({ type: 'near', r: 2.5 });
    // we got there and killed it
    s.loop.pos = { x: 0.5, y: -60, z: 8.5 };
    s.src.emit('entity_event', { runtime_entity_id: 7n, event_id: 'death_animation', data: 0 });
    s.loop.step(1);
    await tick();
    expect(s.mover.collects).toBe(1);
    s.ents.delete(7n);
    s.loop.step(5);
    expect(s.pve.behaviour()).toBe('returning home');
    expect(s.mover.gotos.at(-1)!.goal).toEqual({ type: 'block', p: { x: 0, y: -60, z: 0 } });
    s.mover.finish({ ok: true });
    await tick();
    expect(s.pve.behaviour()).toBe('guarding r=16');
    expect(s.pve.stats).toMatchObject({ fights: 1, kills: 1, guardTriggers: 1 });
  });

  it('ignores players, passive mobs, mobs outside the radius, and does nothing when off', () => {
    const s = setup({ home: { x: 0, y: -60, z: 0 } });
    s.ents.set(5n, mob(5n, 'minecraft:player', { x: 1, y: -58.38, z: 1 }, { username: 'Steve' }));
    s.ents.set(6n, mob(6n, 'minecraft:pig', { x: 2, y: -60, z: 1 }));
    s.ents.set(7n, mob(7n, 'minecraft:zombie', { x: 0, y: -60, z: 20 }));
    s.ents.set(8n, mob(8n, 'minecraft:enderman', { x: 3, y: -60, z: 3 }));
    s.loop.step(20);
    expect(s.pve.behaviour()).toBe('guarding r=16');
    expect(s.mover.gotos).toHaveLength(0);
    // a neutral mob that targets us is fair game
    s.src.emit('set_entity_data', { runtime_entity_id: 8n, metadata: [{ key: 'target_eid', value: -42n }] });
    s.loop.step(5);
    expect(s.pve.behaviour()).toBe('fighting enderman');
    s.pve.stop();
    s.pve.setGuard({ on: false });
    s.ents.set(9n, mob(9n, 'minecraft:zombie', { x: 0, y: -60, z: 3 }));
    s.loop.step(20);
    expect(s.pve.behaviour()).toBe('idle');
  });

  it('a goto is suspended by a guard fight and resumed afterwards', async () => {
    const s = setup({ home: { x: 0, y: -60, z: 0 } });
    const walk = s.pve.walk({ type: 'block', p: { x: 40, y: -60, z: 0 } });
    expect(s.pve.behaviour()).toBe('walking to 40 -60 0');
    s.ents.set(7n, mob(7n, 'minecraft:skeleton', { x: 5, y: -60, z: 5 }));
    s.loop.step(5);
    expect(s.pve.behaviour()).toBe('fighting skeleton');
    s.src.emit('entity_event', { runtime_entity_id: 7n, event_id: 'death_animation', data: 0 });
    s.loop.step(1);
    await tick();
    s.ents.delete(7n);
    s.loop.step(5);
    expect(s.pve.behaviour()).toBe('walking to 40 -60 0');
    expect(s.mover.gotos.at(-1)!.goal).toEqual({ type: 'block', p: { x: 40, y: -60, z: 0 } });
    s.mover.finish({ ok: true });
    expect(await walk).toEqual({ ok: true });
    expect(s.pve.behaviour()).toBe('guarding r=16');
  });

  it('follow is resumed after a guard fight', async () => {
    const s = setup();
    s.ents.set(5n, mob(5n, 'minecraft:player', { x: 0, y: -58.38, z: 2 }, { username: 'Steve' }));
    s.pve.follow({ playerName: 'Steve' });
    expect(s.pve.behaviour()).toBe('following Steve');
    s.ents.set(7n, mob(7n, 'minecraft:zombie', { x: 2, y: -60, z: 0 }));
    s.loop.step(5);
    expect(s.pve.behaviour()).toBe('fighting zombie');
    expect(s.pve.follower.busy).toBe(false);
    s.src.emit('entity_event', { runtime_entity_id: 7n, event_id: 'death_animation', data: 0 });
    s.loop.step(1);
    await tick();
    s.ents.delete(7n);
    s.loop.step(5);
    expect(s.pve.behaviour()).toBe('following Steve');
    expect(s.pve.follower.busy).toBe(true);
  });
});

describe('PveController flee and night', () => {
  it('runs to the shelter when the health is low and a hostile is near', () => {
    const s = setup({ home: { x: 0, y: -60, z: 0 }, shelter: { x: -12, y: -60, z: 0 } });
    s.ents.set(7n, mob(7n, 'minecraft:zombie', { x: 0, y: -60, z: 6 }));
    s.src.emit('set_health', { health: 5 });
    s.loop.step(5);
    expect(s.pve.behaviour()).toBe('fleeing');
    expect(s.mover.gotos.at(-1)).toEqual({ goal: { type: 'block', p: { x: -12, y: -60, z: 0 } }, sprint: true });
  });

  it('with no shelter or home it runs 12 blocks away from the hostile', () => {
    const s = setup({ guard: false });
    s.ents.set(7n, mob(7n, 'minecraft:creeper', { x: 0, y: -60, z: 3 }));
    s.src.emit('set_health', { health: 4 });
    s.loop.step(5);
    expect(s.pve.behaviour()).toBe('fleeing');
    expect(s.mover.gotos.at(-1)!.goal).toMatchObject({ type: 'near', p: { x: 0.5, z: -11.5 }, r: 2 });
  });

  it('does not flee while night safety is already walking to the shelter', () => {
    const night = { wantsShelter: () => true, inside: () => false, state: 'going' };
    const s = setup({ shelter: { x: -12, y: -60, z: 0 }, night });
    s.ents.set(7n, mob(7n, 'minecraft:zombie', { x: 0, y: -60, z: 6 }));
    s.src.emit('set_health', { health: 5 });
    s.loop.step(10);
    expect(s.pve.behaviour()).toBe('guarding r=16');
    expect(s.mover.gotos).toHaveLength(0);
  });

  it('inside the shelter at night it only defends in place', () => {
    const night = { wantsShelter: () => true, inside: () => true, state: 'sheltered' };
    const s = setup({ home: { x: 0, y: -60, z: 0 }, shelter: { x: 0, y: -60, z: 0 }, night });
    s.ents.set(7n, mob(7n, 'minecraft:zombie', { x: 0, y: -60, z: 8 }));
    s.loop.step(10);
    expect(s.pve.behaviour()).toBe('guarding r=16'); // out of reach: stays inside
    s.ents.get(7n)!.pos.z = 2;
    s.loop.step(5);
    expect(s.pve.behaviour()).toBe('fighting zombie (in place)');
    s.loop.step(10);
    expect(s.mover.gotos).toHaveLength(0);
    expect(s.loop.pos).toEqual({ x: 0, y: -60, z: 0 });
  });
});

describe('!kill', () => {
  it('refuses players and player names; kills n mobs of a type one after another', async () => {
    const s = setup({ guard: false });
    s.ents.set(5n, mob(5n, 'minecraft:player', { x: 1, y: -58.38, z: 1 }, { username: 'Steve§r' }));
    expect(refusedKillType('player', s.ents)).toBe(true);
    expect(refusedKillType('Steve', s.ents)).toBe(true);
    expect(refusedKillType('@a', s.ents)).toBe(true);
    expect(refusedKillType('zombie', s.ents)).toBe(false);
    expect(await s.pve.kill('steve', 1)).toMatchObject({ ok: false, reason: 'refused_player' });
    s.ents.set(7n, mob(7n, 'minecraft:zombie', { x: 0, y: -60, z: 4 }));
    s.ents.set(8n, mob(8n, 'minecraft:zombie', { x: 0, y: -60, z: 8 }));
    s.ents.set(9n, mob(9n, 'minecraft:husk', { x: 0, y: -60, z: 2 }));
    const job = s.pve.kill('zombie', 2);
    await tick();
    expect(s.pve.combat.target?.runtimeId).toBe(7n); // nearest zombie, the husk is another type
    expect(s.pve.behaviour()).toBe('fighting zombie (kill zombie 0/2)');
    s.src.emit('entity_event', { runtime_entity_id: 7n, event_id: 'death_animation', data: 0 });
    s.loop.step(1);
    s.ents.delete(7n);
    await tick();
    await tick();
    expect(s.pve.combat.target?.runtimeId).toBe(8n);
    s.src.emit('entity_event', { runtime_entity_id: 8n, event_id: 'death_animation', data: 0 });
    s.loop.step(1);
    const r = await job;
    expect(r).toMatchObject({ ok: true, killed: 2, want: 2, reason: 'done' });
    expect(s.pve.behaviour()).toBe('idle');
  });
});

describe('chat commands', () => {
  function fakeChat() {
    const defs = new Map<string, CommandDef>();
    const chat = { register: (d: CommandDef) => defs.set(d.name, d) } as unknown as Chat;
    const run = (name: string, args: string[], sender: { kind: 'console' } | { kind: 'player'; name: string; xuid: string } = { kind: 'console' }) => {
      const out: string[] = [];
      defs.get(name)!.run({ line: {} as never, sender, args, reply: (m) => out.push(m) });
      return out;
    };
    return { chat, run, defs };
  }

  it('without walking every command says so', () => {
    const c = fakeChat();
    registerPveCommands(c.chat, undefined);
    expect([...c.defs.keys()].sort()).toEqual(['come', 'follow', 'guard', 'kill', 'stop']);
    expect(c.run('follow', ['Steve'])[0]).toBe('follow needs a task that can walk (start with --walk, --home or --target realm)');
  });

  it('parses arguments, defaults to the sender, refuses players for !kill', () => {
    const calls: string[] = [];
    let guard = { on: false, radius: 16 };
    const deps: PveCommandDeps = {
      follow: (n) => (calls.push(`follow ${n}`), n),
      come: (n) => (calls.push(`come ${n}`), Promise.resolve({ ok: true })),
      stop: () => 'following Steve',
      guard: () => guard,
      setGuard: (g) => (guard = { on: g.on ?? guard.on, radius: g.radius ?? guard.radius }),
      kill: (t, n) => (calls.push(`kill ${t} ${n}`), Promise.resolve({ ok: true, killed: n, want: n, reason: 'done', type: t })),
      refused: (t) => t === 'player' || t.toLowerCase() === 'steve',
      behaviour: () => 'idle',
      selfName: () => 'Bot',
    };
    const c = fakeChat();
    registerPveCommands(c.chat, deps);
    const steve = { kind: 'player' as const, name: 'Steve§r', xuid: '' };
    expect(c.run('follow', [], steve)).toEqual(['following Steve']);
    expect(c.run('follow', [])).toEqual(['usage: !follow <name> (the console has no position)']);
    expect(c.run('follow', ['bot'])).toEqual(['I cannot follow myself']);
    expect(c.run('come', [], steve)).toEqual(['coming to Steve']);
    expect(c.run('stop', [])).toEqual(['stopped (was following Steve); idle']);
    expect(c.run('guard', ['24'])).toEqual(['guard on, radius 24']);
    expect(c.run('guard', ['off'])).toEqual(['guard off, radius 24']);
    expect(c.run('guard', [])).toEqual(['guard off, radius 24; idle']);
    expect(c.run('guard', ['1000'])[0]).toMatch(/^usage/);
    expect(c.run('kill', ['player'])).toEqual([KILL_REFUSED]);
    expect(c.run('kill', ['Steve', '3'])).toEqual([KILL_REFUSED]);
    expect(c.run('kill', ['zombie', 'x'])[0]).toMatch(/^usage/);
    expect(c.run('kill', ['zombie', '3'])).toEqual(['killing 3 zombie']);
    expect(calls).toEqual(['follow Steve', 'come Steve', 'kill zombie 3']);
  });
});

describe('options', () => {
  it('reads --guard / --flee-health and the config block', () => {
    expect(pveOptionsFrom({}, {})).toEqual({});
    expect(pveOptionsFrom({ guard: '24', 'flee-health': '6' }, {})).toEqual({ guard: { on: true, radius: 24 }, fleeHealth: 6 });
    expect(pveOptionsFrom({ guard: 'on' }, { guard: { radius: 8 } })).toEqual({ guard: { on: true } });
    expect(pveOptionsFrom({}, { guard: { radius: 8 }, fleeHealth: 10 })).toEqual({ guard: { on: true, radius: 8 }, fleeHealth: 10 });
    expect(pveOptionsFrom({}, { guard: false })).toEqual({ guard: { on: false } });
    expect(() => pveOptionsFrom({ guard: '1' }, {})).toThrow(/guard radius/);
    expect(() => pveOptionsFrom({ 'flee-health': 'x' }, {})).toThrow(/flee health/);
  });
});
