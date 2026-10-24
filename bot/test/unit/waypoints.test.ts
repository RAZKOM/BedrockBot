// Task 7.10 waypoints: the per-server store (persisted in the config dir), the server id, the
// automatic waypoints (death, spawn, home) and the chat commands !wp / !goto <waypoint> / !top.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Chat, parseOwners } from '../../src/chat/chat.ts';
import { registerHardeningCommands } from '../../src/chat/commands.ts';
import { registerNavChat, registerNavCommands, waypointGoal } from '../../src/chat/commands-nav.ts';
import type { TextPacket } from '../../src/connection/types.ts';
import { silentLogger } from '../../src/log.ts';
import { NavBlacklist } from '../../src/skills/nav/blacklist.ts';
import type { NavGoal } from '../../src/skills/nav/goals.ts';
import type { NavGotoOptions } from '../../src/skills/nav/navigator.ts';
import type { SkillResult } from '../../src/skills/types.ts';
import type { Mobility } from '../../src/tasks/mobility.ts';
import type { WalkingTask } from '../../src/tasks/registry.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { attachAutoWaypoints, spawnPositionOf } from '../../src/waypoints/auto.ts';
import { WaypointStore, sanitizeServerId, serverIdOf, waypointName, waypointsFile, waypointsLocation } from '../../src/waypoints/store.ts';
import { connectAndSpawn, setup, type FakeClient } from './connection-fakes.ts';

const tmp = mkdtempSync(join(tmpdir(), 'bedrockbot-wp-'));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('WaypointStore', () => {
  it('sets, lists, deletes; names are case-insensitive; positions are floored', () => {
    const s = new WaypointStore({ now: () => new Date('2026-10-29T12:00:00Z') });
    expect(s.set('Base', { x: 1.7, y: -60, z: -2.2 })).toMatchObject({ name: 'base', x: 1, y: -60, z: -3, auto: false, at: '2026-10-29T12:00:00.000Z' });
    s.set('mine_1', { x: 0, y: null, z: 0 }, { auto: true });
    expect(s.get('BASE')?.x).toBe(1);
    expect(s.list().map((w) => w.name)).toEqual(['base', 'mine_1']);
    expect(s.delete('base')).toBe(true);
    expect(s.delete('base')).toBe(false);
    expect(s.size).toBe(1);
    expect(() => s.set('no spaces', { x: 0, y: 0, z: 0 })).toThrow(/bad waypoint name/);
    expect([waypointName('ok-1'), waypointName(''), waypointName('x'.repeat(33)), waypointName('-a')]).toEqual(['ok-1', undefined, undefined, undefined]);
  });

  it('persists to its file and a new store (a restart) reads it back', () => {
    const file = join(tmp, 'waypoints', 'a.json');
    const s = new WaypointStore({ file, server: '127.0.0.1_19146' });
    s.set('base', { x: 10, y: -60, z: 20 });
    s.set('spawn', { x: 0, y: null, z: 0 }, { auto: true });
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { version: number; server: string; waypoints: Record<string, unknown> };
    expect(raw.version).toBe(1);
    expect(raw.server).toBe('127.0.0.1_19146');
    expect(Object.keys(raw.waypoints)).toEqual(['base', 'spawn']);
    const again = new WaypointStore({ file });
    expect(again.load()).toBe(2);
    expect(again.get('base')).toMatchObject({ x: 10, y: -60, z: 20, auto: false });
    expect(again.get('spawn')).toMatchObject({ y: null, auto: true });
    again.delete('spawn');
    expect(new WaypointStore({ file }).load()).toBe(1);
  });

  it('a broken file is kept aside and the store starts empty', () => {
    const file = join(tmp, 'broken.json');
    writeFileSync(file, '{ not json');
    const s = new WaypointStore({ file });
    expect(s.load()).toBe(0);
    expect(existsSync(`${file}.bad`)).toBe(true);
    s.set('x', { x: 1, y: 2, z: 3 });
    expect(new WaypointStore({ file }).load()).toBe(1);
  });
});

describe('server id and file location', () => {
  it('host_port for a BDS (CLI > config > defaults), realm-<name> for a Realm', () => {
    expect(serverIdOf({ host: '127.0.0.1', port: '19146' })).toBe('127.0.0.1_19146');
    expect(serverIdOf({}, { host: 'my.server', port: 19133 })).toBe('my.server_19133');
    expect(serverIdOf({})).toBe('127.0.0.1_19132');
    expect(serverIdOf({ target: 'realm', 'realm-name': 'Your Realm' })).toBe('realm-Your_Realm');
    expect(serverIdOf({ target: 'realm' }, { realm: { realmId: '123' } })).toBe('realm-id-123');
    expect(serverIdOf({ target: 'realm', 'realm-invite': 'AbC' })).toBe('realm-invite-AbC');
    expect(sanitizeServerId('../../etc/passwd')).toBe('etc_passwd');
    expect(waypointsFile('/cfg', 'h_1')).toBe(join('/cfg', 'waypoints', 'h_1.json'));
  });

  it('the config file directory, or memory only with --no-config', () => {
    const cfg = join(tmp, 'config.json');
    writeFileSync(cfg, '{ "port": 19146 }');
    expect(waypointsLocation({ config: cfg })).toEqual({ file: join(tmp, 'waypoints', '127.0.0.1_19146.json'), server: '127.0.0.1_19146' });
    expect(waypointsLocation({ config: cfg, port: '19150' }).server).toBe('127.0.0.1_19150');
    expect(waypointsLocation({ 'no-config': true }).file).toBeUndefined();
    expect(waypointsLocation({}, { BEDROCKBOT_CONFIG: cfg }, tmp).file).toBe(join(tmp, 'waypoints', '127.0.0.1_19146.json'));
  });
});

describe('automatic waypoints', () => {
  it('spawn from set_spawn_position: the player spawn (bed) first, else the world spawn; unsigned y; no height -> null', () => {
    expect(spawnPositionOf({ spawn_type: 'player', player_position: { x: 5, y: -60, z: 6 }, world_position: { x: 0, y: 70, z: 0 } })).toEqual({ x: 5, y: -60, z: 6 });
    expect(spawnPositionOf({ spawn_type: 'world', player_position: { x: 5, y: -60, z: 6 }, world_position: { x: 1, y: 4294967236, z: 2 } })).toEqual({ x: 1, y: -60, z: 2 });
    expect(spawnPositionOf({ spawn_type: 'world', world_position: { x: 1, y: 32767, z: 2 } })).toEqual({ x: 1, y: null, z: 2 });
    expect(spawnPositionOf({ spawn_type: 'player', player_position: { x: -2147483648, y: 0, z: -2147483648 }, world_position: { x: 3, y: 64, z: 4 } })).toEqual({ x: 3, y: 64, z: 4 });
    expect(spawnPositionOf({})).toBeUndefined();
  });

  it('death and spawn follow their events', () => {
    const store = new WaypointStore();
    const handlers = new Map<string, (p: Record<string, unknown>) => void>();
    let onEvent: ((e: { kind: string; death?: { at?: Vec3 } }) => void) | undefined;
    const off = attachAutoWaypoints({
      store,
      conn: { on: (n, fn) => (handlers.set(n, fn), () => handlers.delete(n)) },
      respawn: { onEvent: (fn) => ((onEvent = fn), () => (onEvent = undefined)) },
    });
    // the join: the world spawn from start_game (no height), then a set_spawn_position without any position
    handlers.get('start_game')!({ spawn_position: { x: 0, y: 32767, z: 0 } });
    expect(store.get('spawn')).toMatchObject({ x: 0, y: null, z: 0 });
    const none = -2147483648;
    handlers.get('set_spawn_position')!({ spawn_type: 'player', player_position: { x: none, y: none, z: none }, world_position: { x: none, y: none, z: none } });
    expect(store.get('spawn')).toMatchObject({ x: 0, y: null, z: 0 });
    // /spawnpoint or a bed
    handlers.get('set_spawn_position')!({ spawn_type: 'world', world_position: { x: 8, y: -60, z: 9 }, player_position: { x: 0, y: 0, z: 0 } });
    onEvent!({ kind: 'death', death: { at: { x: 3.7, y: -59.99999999, z: -4.2 } } });
    onEvent!({ kind: 'respawn' });
    expect(store.get('spawn')).toMatchObject({ x: 8, y: -60, z: 9, auto: true });
    expect(store.get('death')).toMatchObject({ x: 3, y: -60, z: -5, auto: true });
    // a restart: start_game does not replace a stored spawn
    handlers.get('start_game')!({ spawn_position: { x: 100, y: 70, z: 100 } });
    expect(store.get('spawn')).toMatchObject({ x: 8, y: -60, z: 9 });
    off();
    expect(handlers.size).toBe(0);
  });
});

const consoleSay = (msg: string): TextPacket => ({ needs_translation: false, category: 'authored', type: 'announcement', source_name: 'Server', message: `[Server] ${msg}`, xuid: '' });

describe('chat: !wp, !goto <waypoint>, !top', () => {
  let client: FakeClient;
  let chat: Chat;
  let walks: { goal: NavGoal; opts: NavGotoOptions; label: string }[];
  let result: SkillResult;

  async function start(opts: { walk?: boolean; home?: { set(p: Vec3 | undefined): void } } = {}) {
    const { conn, clients } = setup({ username: 'Bot' });
    chat = new Chat(conn, { owners: parseOwners([]), log: silentLogger, maxReplies: 100 });
    walks = [];
    result = { ok: true };
    const store = new WaypointStore();
    registerNavChat(chat, {
      store,
      position: () => ({ x: 1.5, y: -60, z: 2.5 }),
      ...(opts.walk === false
        ? {}
        : {
            walk: (goal: NavGoal, o: NavGotoOptions, label: string) => {
              walks.push({ goal, opts: o, label });
              return Promise.resolve(result);
            },
          }),
      ...(opts.home ? { home: opts.home } : {}),
    });
    // index.ts registers the coordinate-only !goto after the task (and would replace ours)
    registerHardeningCommands(chat, { health: () => ({ health: 20, deaths: 0, dead: false, healthy: true }), goto: () => Promise.resolve({ ok: false, reason: 'old goto' }), position: () => undefined });
    chat.start();
    client = await connectAndSpawn(conn, clients);
    return store;
  }

  async function say(msg: string): Promise<string[]> {
    client.sent = [];
    client.receive('text', consoleSay(msg));
    await vi.advanceTimersByTimeAsync(60);
    return client.sentOf('text').map((p) => String(p.message));
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('!wp set / list / show / del', async () => {
    const store = await start();
    expect(await say('!wp')).toEqual(['no waypoints yet (!wp set <name>)']);
    expect(await say('!wp set base 10 -60 20')).toEqual(['waypoint base set to 10 -60 20']);
    expect(await say('!wp set here')).toEqual(['waypoint here set to 1 -60 2']);
    expect(await say('!wp set bad! 1 2 3')).toEqual(['usage: !wp set <name> [x y z] (name: 1..32 of a-z 0-9 _ -)']);
    expect(await say('!wp set x 1 2')).toEqual(['usage: !wp set <name> [x y z]']);
    store.set('spawn', { x: 0, y: null, z: 0 }, { auto: true });
    expect(await say('!wp list')).toEqual(['waypoints (3): base 10 -60 20, here 1 -60 2, spawn* 0 ? 0']);
    expect((await say('!wp base'))[0]).toMatch(/^waypoint base: 10 -60 20, set /);
    expect(await say('!wp del base')).toEqual(['waypoint base deleted']);
    expect(await say('!wp del base')).toEqual(['no waypoint "base"']);
  });

  it('!goto resolves a waypoint name before coordinates (and wins over the coordinate-only !goto)', async () => {
    const store = await start();
    store.set('base', { x: 10, y: -60, z: 20 });
    store.set('spawn', { x: 3, y: null, z: 4 }, { auto: true });
    expect(await say('!goto base')).toEqual(['walking to base (10 -60 20)', 'arrived at base (10 -60 20)']);
    expect(walks[0]).toMatchObject({ goal: { type: 'block', p: { x: 10, y: -60, z: 20 } }, opts: { timeoutTicks: 6000 } });
    await say('!goto spawn');
    expect(walks[1]!.goal).toEqual({ type: 'xz', x: 3, z: 4 });
    expect(await say('!goto 1 -60 2')).toEqual(['walking to 1 -60 2', 'arrived at 1 -60 2']);
    expect(await say('!goto nowhere')).toEqual(['no waypoint "nowhere" (!wp list)']);
    expect(await say('!goto 1 2')).toEqual(['usage: !goto <waypoint> | x y z']);
    result = { ok: false, reason: 'unreachable' };
    expect(await say('!goto base')).toEqual(['walking to base (10 -60 20)', 'goto: unreachable']);
    expect(waypointGoal({ x: 1, y: 2, z: 3 })).toEqual({ type: 'block', p: { x: 1, y: 2, z: 3 } });
  });

  it('!top walks to the surface goal with pillaring allowed', async () => {
    await start();
    expect(await say('!top')).toEqual(['going up to the surface', 'on the surface at 1.5 -60.0 2.5']);
    expect(walks[0]).toMatchObject({ goal: { type: 'surface' }, opts: { allowPlace: true, timeoutTicks: 2400 } });
  });

  it('without walking: !goto and !top say so; !wp still works', async () => {
    await start({ walk: false });
    expect(await say('!goto 1 2 3')).toEqual(['goto needs a task that can walk (start with --walk, --home or --target realm)']);
    expect(await say('!top')).toEqual(['top needs a task that can walk (start with --walk, --home or --target realm)']);
    expect(await say('!wp set a 1 2 3')).toEqual(['waypoint a set to 1 2 3']);
  });

  it('!wp set home / del home change the home point too', async () => {
    const homes: (Vec3 | undefined)[] = [];
    const store = await start({ home: { set: (p) => homes.push(p) } });
    expect(await say('!wp set home 5 -60 5')).toEqual(['waypoint home set to 5 -60 5 (home point too)']);
    expect(homes).toEqual([{ x: 5, y: -60, z: 5 }]);
    expect(store.get('home')).toBeDefined();
    expect(await say('!wp del home')).toEqual(['waypoint home deleted (home point cleared)']);
    expect(homes.at(-1)).toBeUndefined();
  });
});

describe('registerNavCommands (the afk task wiring)', () => {
  it('home follows !home set, !status shows the blacklist and waypoint counts, the task status lists them', () => {
    const { conn } = setup({ username: 'Bot' });
    const chat = new Chat(conn, { owners: parseOwners([]), log: silentLogger });
    let home: Vec3 | undefined = { x: 1, y: -60, z: 1 };
    const task: WalkingTask = {
      name: 'afk',
      start: () => undefined,
      stop: () => undefined,
      status: () => ({ a: 1 }),
      position: () => undefined,
      statusLine: () => ({ task: 'afk', nudges: 0 }),
      home: { get: () => home, set: (p) => (home = p) },
    };
    const blacklist = new NavBlacklist({ failures: 1, now: () => 0 });
    const attached: unknown[] = [];
    const mob = { skills: { nav: { blacklist }, goto: () => Promise.resolve({ ok: true }), attach: (p: unknown) => attached.push(p) } } as unknown as Mobility;
    const store = registerNavCommands({ ctx: { chat, conn, values: { 'no-config': true }, logger: () => silentLogger }, task, mob, store: new WaypointStore() });
    expect(store.get('home')).toMatchObject({ x: 1, y: -60, z: 1, auto: true }); // --home at start
    expect(attached).toEqual([{ source: conn }]); // place / use actions for !top and doors
    task.home!.set({ x: 7, y: -60, z: 8 });
    expect(home).toEqual({ x: 7, y: -60, z: 8 });
    expect(store.get('home')).toMatchObject({ x: 7, z: 8 });
    task.home!.set(undefined);
    expect(store.get('home')).toBeUndefined();
    blacklist.fail('b:1,2,3');
    store.set('a', { x: 0, y: 0, z: 0 });
    expect(task.statusLine!()).toEqual({ task: 'afk', nudges: 0, blacklist: 1, waypoints: 1 });
    expect(task.status()).toMatchObject({ a: 1, nav: { blacklist: [{ key: 'b:1,2,3' }], waypoints: [{ name: 'a' }] } });
  });
});
