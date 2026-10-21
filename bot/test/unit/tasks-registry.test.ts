// Task registry (bot --task <name>) and the afk task's wiring (respawn, night safety, home).
import { describe, expect, it, vi } from 'vitest';
import { Chat } from '../../src/chat/chat.ts';
import { registerHardeningCommands } from '../../src/chat/commands.ts';
import { Metrics } from '../../src/connection/metrics.ts';
import { silentLogger } from '../../src/log.ts';
import type { CommonTaskOptions, TaskContext } from '../../src/tasks/base.ts';
import { createMobility, type Mobility } from '../../src/tasks/mobility.ts';
import { WorldClock } from '../../src/tasks/night.ts';
import { afkTask, getTask, registerTask, taskNames, type WalkingTask } from '../../src/tasks/registry.ts';
import { RespawnController } from '../../src/tasks/respawn.ts';
import { setup } from './connection-fakes.ts';

const COMMON: CommonTaskOptions = { nudgeIntervalS: 240, heartbeat: false, home: undefined, shelter: undefined, walk: false, respawnDelayMs: 2000 };

function context(options: Partial<CommonTaskOptions> = {}) {
  const { conn } = setup();
  const metrics = new Metrics();
  const chat = new Chat(conn, { log: silentLogger });
  let mob: Mobility | undefined;
  const respawn = new RespawnController(conn);
  const clock = new WorldClock(conn);
  const mobility = vi.fn(() => (mob ??= createMobility(conn, { version: '1.26.60' })));
  const ctx: TaskContext = {
    name: 'afk',
    conn,
    metrics,
    chat,
    log: silentLogger,
    version: '1.26.60',
    options: { ...COMMON, ...options },
    values: {},
    taskConfig: {},
    logger: () => silentLogger,
    respawn: () => respawn,
    mobility,
    clock: () => clock,
  };
  return { ctx, mobility, chat, conn };
}

describe('task registry', () => {
  it('has echo and afk; a second registration of a name throws', () => {
    expect(taskNames()).toEqual(expect.arrayContaining(['echo', 'afk']));
    expect(getTask('afk')).toBe(afkTask);
    expect(getTask('nope')).toBeUndefined();
    expect(() => {
      registerTask({ name: 'afk', summary: 'dup', create: () => afkTask.create(context().ctx) });
    }).toThrow(/twice/);
  });

  it('afk without home/shelter/walk does not build the movement stack', () => {
    const { ctx, mobility } = context();
    const t = afkTask.create(ctx) as WalkingTask;
    expect(mobility).not.toHaveBeenCalled();
    expect(t.home).toBeUndefined();
    expect(t.shelter).toBeUndefined();
    expect(t.status()).toMatchObject({ mode: 'own-inputs', night: null });
    expect(t.alive?.()).toBe(true);
  });

  it('afk with a shelter builds it and exposes !home / !shelter', () => {
    const { ctx, mobility, chat } = context({ shelter: { x: 10, y: -60, z: 10 } });
    const t = afkTask.create(ctx) as WalkingTask;
    expect(mobility).toHaveBeenCalledTimes(1);
    expect(t.status()).toMatchObject({ mode: 'loop', night: { state: 'day', shelter: { x: 10, y: -60, z: 10 } } });
    expect(t.shelter?.get()).toEqual({ x: 10, y: -60, z: 10 });
    t.home?.set({ x: 1, y: -60, z: 1 });
    expect(t.home?.get()).toEqual({ x: 1, y: -60, z: 1 });
    // chat commands
    const replies: string[] = [];
    vi.spyOn(chat, 'say').mockImplementation((m) => {
      replies.push(m);
      return true;
    });
    registerHardeningCommands(chat, {
      health: () => ({ health: 20, food: 20, deaths: 0, dead: false, healthy: true }),
      shelter: t.shelter,
      home: t.home,
      position: () => ({ x: 5.3, y: -60, z: -2.7 }),
    });
    const run = (body: string) => {
      chat.handle({ type: 'announcement', source: 'Server', message: `[Server] ${body}`, body, xuid: '', truth: false });
    };
    run('!shelter set');
    run('!shelter');
    run('!home set 7 -60 8');
    run('!home clear');
    run('!shelter bogus');
    run('!health');
    expect(replies).toEqual([
      'shelter set to 5 -60 -3',
      'shelter 5 -60 -3, state day',
      'home set to 7 -60 8',
      'home cleared',
      'usage: !shelter [show] | set [x y z] | go | clear',
      'health: health 20, food 20, deaths 0, alive, healthy',
    ]);
    t.stop();
  });
});
