// The afk task's behaviours as processes (PLAN.md 7.8 / 7.9, Track Q; docs/processes.md) on fakes:
// a guard fight interrupts a gather that resumes and finishes, !pause / !resume / !stop during a
// walk, flee pre-empts a fight, guardRadius changes the guard live, night shelter pre-empts a command
// and a fight in place pre-empts the night, and the afk task wires it all (registrations, nudge).
import { describe, expect, it, vi } from 'vitest';
import { Chat, type CommandDef } from '../../src/chat/chat.ts';
import { registerProcessCommands } from '../../src/chat/commands.ts';
import { registerPveCommandsFor } from '../../src/chat/commands-pve.ts';
import { Metrics } from '../../src/connection/metrics.ts';
import { RuntimeSettings, SETTINGS_VALUE_KEY } from '../../src/config/settings.ts';
import { silentLogger } from '../../src/log.ts';
import type { FellResult, Tree } from '../../src/skills/index.ts';
import type { CommonTaskOptions, TaskContext } from '../../src/tasks/base.ts';
import type { GatherDeps } from '../../src/tasks/gatherWood.ts';
import { createMobility, type Mobility } from '../../src/tasks/mobility.ts';
import { NightSafety, WorldClock } from '../../src/tasks/night.ts';
import type { CommandDeps } from '../../src/tasks/process/deps.ts';
import { AfkGather } from '../../src/tasks/process/gather.ts';
import { NightProcess } from '../../src/tasks/process/night.ts';
import { PveController } from '../../src/tasks/pve.ts';
import { afkTask, type WalkingTask } from '../../src/tasks/registry.ts';
import { RespawnController } from '../../src/tasks/respawn.ts';
import { Inventory } from '../../src/world/inventory.ts';
import type { EntityInfo, Vec3 } from '../../src/world/types.ts';
import { setup as connSetup } from './connection-fakes.ts';
import { FakeLoop, FakeMover, FakeSource, mob } from './skills/pve-fakes.ts';

class PveMover extends FakeMover {
  collects = 0;
  collect(): Promise<unknown> {
    this.collects++;
    return Promise.resolve({ ok: true });
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r));

function world(opts: { home?: Vec3; shelter?: Vec3; guard?: boolean; night?: NightSafety } = {}) {
  const src = new FakeSource();
  const loop = new FakeLoop();
  const mover = new PveMover();
  const ents = new Map<bigint, EntityInfo>();
  const inventory = new Inventory(() => null, () => 1n);
  const settings = new RuntimeSettings();
  const pve = new PveController({
    source: src,
    world: { entities: ents, inventory, self: { runtimeId: 1n, health: 20 } },
    loop,
    skills: mover,
    home: () => opts.home,
    shelter: () => opts.shelter,
    night: opts.night,
    inactive: () => false,
    options: { guard: { on: opts.guard ?? true } },
    settings,
  });
  src.emit('start_game', { entity_id: -42n });
  src.emit('set_health', { health: 20 });
  return { src, loop, mover, ents, pve, settings, pm: pve.processes };
}

function kill(s: ReturnType<typeof world>, rid: bigint): void {
  s.src.emit('entity_event', { runtime_entity_id: rid, event_id: 'death_animation', data: 0 });
  s.loop.step(1);
}

/** A gather backend whose fellTree stays pending until the test lets it finish (or it is cancelled). */
function gatherFake() {
  const inv = new Inventory((i) => (i.network_id === 0 ? null : { name: 'oak_log', networkId: i.network_id, count: i.count, metadata: 0 }), () => 1n);
  const tree: Tree = { kind: 'oak', logs: [{ x: 5, y: -60, z: 0 }], base: { x: 5, y: -60, z: 0 }, top: -60, leaves: 0, partial: false, grounded: true };
  let felled = false;
  let pending: ((r: FellResult) => void) | undefined;
  const calls: string[] = [];
  const fell = (r: FellResult) => {
    const p = pending;
    pending = undefined;
    p?.(r);
  };
  const deps: GatherDeps = {
    skills: {
      findTrees: () => (felled ? [] : [tree]),
      fellTree: () => {
        calls.push('fell');
        return new Promise((r) => (pending = r));
      },
      collect: () => Promise.resolve({ ok: true as const, gained: {}, pickedUp: 0, skipped: 0, ticks: 1, corrections: 0 }),
      goto: () => Promise.resolve({ ok: true as const }),
      open: () => Promise.resolve({ ok: false as const, reason: 'none' }),
      deposit: () => Promise.resolve({ ok: true, moved: {}, total: 0, requests: 0, errors: 0 }),
      closeContainer: () => Promise.resolve(true),
      cancel: () => {
        calls.push('cancel');
        fell({ ok: false, reason: 'interrupted', broken: [], left: tree.logs, repaths: 0, digFailures: 0, corrections: 0, ticksDigging: 0 });
      },
      status: () => ({}) as never,
    } as unknown as GatherDeps['skills'],
    inventory: inv,
    position: () => ({ x: 0.5, y: -60, z: 0.5 }),
    ready: () => true,
    waitTicks: () => tick(),
    corrections: () => 0,
  };
  const finishTree = () => {
    felled = true;
    inv.handleInventorySlot({ window_id: 0, slot: 0, item: { network_id: 17, count: 1, metadata: 0, has_stack_id: false, block_runtime_id: 0 } });
    fell({ ok: true, broken: tree.logs, left: [], repaths: 0, digFailures: 0, corrections: 0, ticksDigging: 5 });
  };
  return { deps, calls, finishTree, inv };
}

describe('afk processes', () => {
  it('a guard fight interrupts a running gather; the gather resumes on the same tree and finishes', async () => {
    const s = world({ home: { x: 0, y: -60, z: 0 } });
    const g = gatherFake();
    const said: string[] = [];
    const ag = new AfkGather({ deps: g.deps, processes: s.pm, log: silentLogger, say: (m) => said.push(m) });
    expect(ag.start(1, undefined)).toBe('gathering 1 logs (no chest: keeping them)');
    await tick();
    expect(g.calls).toEqual(['cancel', 'fell']);
    expect(s.pve.behaviour()).toBe('gathering 0/1 logs');
    // a zombie within the guard radius: the fight pre-empts the gather (paused, its skill cancelled)
    s.ents.set(7n, mob(7n, 'minecraft:zombie', { x: 3, y: -60, z: 3 }));
    s.loop.step(1);
    expect(s.pve.behaviour()).toBe('fighting zombie');
    expect(g.calls).toEqual(['cancel', 'fell', 'cancel']);
    expect(ag.task.state).toBe('dead'); // GatherWoodTask's pause state (shown as paused in the stack)
    expect(s.pm.stack().map((e) => `${e.name}:${e.state}`)).toEqual(['guard:active', 'gather:paused']);
    expect(ag.status()).toMatch(/^gather: gather 0\/1 logs \(paused, 0 trees\)/);
    kill(s, 7n);
    await tick();
    s.ents.delete(7n);
    s.loop.step(1);
    await tick();
    // resumed from find-tree: the same tree again
    expect(s.pve.behaviour()).toBe('gathering 0/1 logs');
    expect(g.calls).toEqual(['cancel', 'fell', 'cancel', 'fell']);
    g.finishTree();
    for (let i = 0; i < 5; i++) await tick();
    expect(ag.task.state).toBe('done');
    expect(s.pm.userProcesses()).toHaveLength(0);
    expect(said).toEqual(['gather done: 1/1 logs']);
  });

  it('!pause / !resume / !stop during a goto; guard keeps running while commands are held', async () => {
    const s = world({ home: { x: 0, y: -60, z: 0 } });
    const defs = new Map<string, CommandDef>();
    const chat = { register: (d: CommandDef) => defs.set(d.name, d) } as unknown as Chat;
    const deps = { chat, processes: s.pm, pve: s.pve, world: { entities: s.ents }, selfName: () => 'Bot', needsWalking: (c: string) => c } as unknown as CommandDeps;
    registerProcessCommands(deps);
    registerPveCommandsFor(deps);
    const run = (name: string, ...args: string[]) => {
      const out: string[] = [];
      defs.get(name)!.run({ line: {} as never, sender: { kind: 'console' }, args, reply: (m) => out.push(m) });
      return out;
    };
    const walk = s.pve.walk({ type: 'block', p: { x: 40, y: -60, z: 0 } });
    expect(s.mover.gotos).toHaveLength(1);
    expect(run('pause')).toEqual(['paused: walking to 40 -60 0 (!resume to continue)']);
    expect(s.mover.nav.busy).toBe(false);
    expect(s.pve.behaviour()).toBe('paused (walking to 40 -60 0)');
    // guard still fights while held
    s.ents.set(7n, mob(7n, 'minecraft:zombie', { x: 2, y: -60, z: 2 }));
    s.loop.step(1);
    expect(s.pve.behaviour()).toBe('fighting zombie');
    kill(s, 7n);
    await tick();
    s.ents.delete(7n);
    s.loop.step(1);
    expect(s.pve.behaviour()).toBe('paused (walking to 40 -60 0)');
    expect(run('resume')).toEqual(['resumed: walking to 40 -60 0']);
    expect(s.mover.gotos.at(-1)!.goal).toEqual({ type: 'block', p: { x: 40, y: -60, z: 0 } });
    expect(run('resume')).toEqual(['nothing paused']);
    // !stop: the goto ends (interrupted), guard stays on
    expect(run('stop')).toEqual(['stopped (was walking to 40 -60 0); guarding r=16']);
    expect(await walk).toEqual({ ok: false, reason: 'interrupted' });
    expect(s.pve.guard.on).toBe(true);
    expect(run('pause')).toEqual(['nothing to pause (commands given now wait for !resume)']);
    expect(run('resume')).toEqual(['resumed']);
  });

  it('flee pre-empts a guard fight; afterwards the bot only defends in place while the health is low', async () => {
    const s = world({ home: { x: 0, y: -60, z: 0 }, shelter: { x: -12, y: -60, z: 0 } });
    s.ents.set(7n, mob(7n, 'minecraft:zombie', { x: 0.5, y: -60, z: 6.5 }));
    s.loop.step(1);
    expect(s.pve.behaviour()).toBe('fighting zombie');
    s.src.emit('set_health', { health: 5 });
    s.loop.step(1);
    expect(s.pve.behaviour()).toBe('fleeing');
    expect(s.mover.gotos.at(-1)).toEqual({ goal: { type: 'block', p: { x: -12, y: -60, z: 0 } }, sprint: true });
    expect(s.pve.combat.busy).toBe(false);
    s.mover.finish({ ok: true });
    await tick();
    s.loop.pos = { x: -11.5, y: -60, z: 0.5 };
    s.loop.step(1);
    // the zombie is 13 blocks away: out of reach, no fight while the health is low
    expect(s.pve.behaviour()).toBe('guarding r=16');
    s.ents.get(7n)!.pos = { x: -10.5, y: -60, z: 0.5 };
    s.loop.step(1);
    expect(s.pve.behaviour()).toBe('fighting zombie (in place)');
    expect(s.pve.stats.flees).toBe(1);
  });

  it('guardRadius changes the guard live', () => {
    const s = world({ home: { x: 0, y: -60, z: 0 } });
    s.ents.set(7n, mob(7n, 'minecraft:zombie', { x: 0.5, y: -60, z: 12.5 }));
    s.settings.set('guardRadius', 8);
    s.loop.step(5);
    expect(s.pve.behaviour()).toBe('guarding r=8');
    s.settings.set('guardRadius', 16);
    s.loop.step(1);
    expect(s.pve.behaviour()).toBe('fighting zombie');
  });

  it('night shelter pre-empts a command and a fight in place pre-empts the sheltered night', async () => {
    let time = 6000;
    const clock = {
      get time() {
        return time;
      },
      get known() {
        return true;
      },
    } as unknown as WorldClock;
    const nightMover = new FakeMover();
    const loopRef: { loop?: FakeLoop } = {};
    const ref: { p?: NightProcess } = {};
    const n = new NightSafety({ clock, mover: nightMover as never, position: () => loopRef.loop?.state.pos, shelter: { x: 0, y: -60, z: 0 }, canMove: () => ref.p?.hasControl ?? false });
    const s = world({ night: n });
    loopRef.loop = s.loop;
    s.loop.pos = { x: 10.5, y: -60, z: 0.5 };
    ref.p = s.pm.add(new NightProcess(n));
    const walk = s.pve.walk({ type: 'block', p: { x: 30, y: -60, z: 0 } });
    expect(s.pve.behaviour()).toBe('walking to 30 -60 0');
    time = 13000;
    s.loop.step(1);
    expect(n.state).toBe('going');
    expect(s.pve.behaviour()).toBe('going to the shelter');
    expect(nightMover.gotos.at(-1)!.goal).toEqual({ type: 'block', p: { x: 0, y: -60, z: 0 } });
    s.loop.pos = { x: 0.5, y: -60, z: 0.5 };
    nightMover.finish({ ok: true });
    await tick();
    s.loop.step(1);
    expect(n.state).toBe('sheltered');
    expect(s.pve.behaviour()).toBe('sheltered');
    expect(s.pm.busy()).toBe(false); // sheltered: the nudge may run
    // a zombie out of reach: no fight; within reach: defend in place (85 > 80)
    s.ents.set(7n, mob(7n, 'minecraft:zombie', { x: 0.5, y: -60, z: 6.5 }));
    s.loop.step(2);
    expect(s.pve.behaviour()).toBe('sheltered');
    s.ents.get(7n)!.pos = { x: 0.5, y: -60, z: 2.5 };
    s.loop.step(1);
    expect(s.pve.behaviour()).toBe('fighting zombie (in place)');
    kill(s, 7n);
    await tick();
    s.ents.delete(7n);
    s.loop.step(1);
    expect(s.pve.behaviour()).toBe('sheltered');
    // dawn: the walk resumes
    time = 23500;
    n.check();
    s.loop.step(1);
    expect(s.pve.behaviour()).toBe('walking to 30 -60 0');
    s.mover.finish({ ok: true });
    expect(await walk).toEqual({ ok: true });
  });
});

describe('afk task wiring', () => {
  const COMMON: CommonTaskOptions = { nudgeIntervalS: 240, heartbeat: false, home: undefined, shelter: undefined, walk: true, respawnDelayMs: 2000 };
  function context(values: Record<string, unknown> = {}, options: Partial<CommonTaskOptions> = {}) {
    const { conn } = connSetup();
    const chat = new Chat(conn, { log: silentLogger });
    let m: Mobility | undefined;
    const ctx: TaskContext = {
      name: 'afk',
      conn,
      metrics: new Metrics(),
      chat,
      log: silentLogger,
      version: '1.26.60',
      options: { ...COMMON, ...options },
      values,
      taskConfig: {},
      logger: () => silentLogger,
      respawn: () => new RespawnController(conn),
      mobility: () => (m ??= createMobility(conn, { version: '1.26.60' })),
      clock: () => new WorldClock(conn),
    };
    return { ctx, chat };
  }

  it('registers every command through the list, uses the CLI settings, applies nudgeInterval live', () => {
    const settings = new RuntimeSettings();
    const { ctx, chat } = context({ [SETTINGS_VALUE_KEY]: settings, guard: '24' });
    const t = afkTask.create(ctx) as WalkingTask;
    expect(chat.commandNames()).toEqual(expect.arrayContaining(['follow', 'come', 'stop', 'guard', 'kill', 'pause', 'resume', 'set', 'gather']));
    expect(t.settings).toBe(settings);
    expect(settings.get('guardRadius')).toBe(24);
    expect(t.pve?.guard).toEqual({ on: true, radius: 24 });
    expect(t.processLines?.()).toEqual(['processes: idle']);
    const st = t.status();
    expect(st.nudgeIntervalMs).toBe(240_000);
    settings.set('nudgeInterval', 30);
    expect(t.status().nudgeIntervalMs).toBe(30_000);
    t.stop();
  });

  it('without walking the movement commands say so; a bad --guard throws for index.ts', () => {
    const { ctx, chat } = context({}, { walk: false });
    const t = afkTask.create(ctx) as WalkingTask;
    expect(t.processes).toBeUndefined();
    const replies: string[] = [];
    vi.spyOn(chat, 'say').mockImplementation((m) => {
      replies.push(m);
      return true;
    });
    for (const c of ['pause', 'gather 5', 'set guardRadius 9']) chat.handle({ type: 'announcement', source: 'Server', message: `[Server] !${c}`, body: `!${c}`, xuid: '', truth: false });
    expect(replies).toEqual([
      'pause needs a task that can walk (start with --walk, --home or --target realm)',
      'gather needs a task that can walk (start with --walk, --home or --target realm)',
      'guardRadius = 9 (was 16), not saved (no settings file)',
    ]);
    t.stop();
    expect(() => afkTask.create(context({ guard: '1' }).ctx)).toThrow('guard radius must be 2..64, got 1');
  });
});
