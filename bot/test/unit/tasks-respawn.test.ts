// Task 5.1: RespawnController (death cause from death_info or health 0, respawn press, death counter
// in metrics, after-respawn hooks) and the return-home hook. Packet order as measured on BDS 1.26.60.6:
// death_info, respawn state 0, update_attributes health 0; after the press: respawn state 1.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Metrics } from '../../src/connection/metrics.ts';
import type { SkillResult } from '../../src/skills/types.ts';
import { homeHook } from '../../src/tasks/mobility.ts';
import { RespawnController, type RespawnEvent } from '../../src/tasks/respawn.ts';
import { connectAndSpawn, setup } from './connection-fakes.ts';

const EYE = (x: number, z: number) => ({ x, y: -58.38, z });

describe('RespawnController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function start(delay = 1000) {
    const { conn, clients } = setup();
    const metrics = new Metrics();
    const r = new RespawnController(conn, { respawnDelayMs: delay, metrics, position: () => ({ x: 3, y: -60, z: 4 }) });
    r.start();
    const client = await connectAndSpawn(conn, clients, 9n);
    const events: RespawnEvent[] = [];
    r.onEvent((e) => events.push(e));
    return { conn, client, metrics, r, events };
  }

  it('ignores the respawn state 0 of the login sequence (before spawn)', async () => {
    const { conn, clients } = setup();
    const r = new RespawnController(conn);
    r.start();
    const p = conn.connect({ kind: 'bds', host: '127.0.0.1', port: 19132, transport: 'raknet', offline: true });
    await vi.advanceTimersByTimeAsync(0);
    const c = clients[0]!;
    c.receive('start_game', { runtime_entity_id: 9n, player_position: { x: 0, y: 32769, z: 0 } });
    c.receive('respawn', { position: { x: 0.5, y: 32769.62, z: 0.5 }, state: 0, runtime_entity_id: 0n });
    c.receive('respawn', { position: EYE(0.5, 0.5), state: 1, runtime_entity_id: 0n });
    c.receive('play_status', { status: 'player_spawn' });
    c.emit('spawn');
    await p;
    expect(r.deaths).toBe(0);
    expect(r.dead).toBe(false);
  });

  it('death_info + respawn 0: counts the death with its cause, presses respawn after the delay, then respawns', async () => {
    const { client, metrics, r, events } = await start(1000);
    client.receive('death_info', { cause: 'death.attack.generic', messages: ['UnitBot'] });
    client.receive('respawn', { position: EYE(0.5, 0.5), state: 0, runtime_entity_id: 0n });
    client.receive('update_attributes', { runtime_entity_id: 9n, attributes: [{ name: 'minecraft:health', current: 0 }] });
    expect(r.dead).toBe(true);
    expect(r.deaths).toBe(1);
    expect(r.lastDeath).toMatchObject({ n: 1, cause: 'death.attack.generic', messages: ['UnitBot'], at: { x: 3, y: -60, z: 4 } });
    expect(metrics.counters.deaths).toBe(1);
    expect(metrics.counters['deaths.death.attack.generic']).toBe(1);
    await vi.advanceTimersByTimeAsync(900);
    expect(client.sentOf('player_action')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    // The button: client ready (state 2) only; player_action respawn waits for the server's state 1.
    expect(client.sentOf('respawn').at(-1)).toMatchObject({ state: 2, runtime_entity_id: 9n });
    expect(client.sentOf('player_action')).toHaveLength(0);
    client.receive('respawn', { position: EYE(8.5, 8.5), state: 1, runtime_entity_id: 0n });
    await vi.advanceTimersByTimeAsync(60);
    expect(client.sentOf('player_action')).toEqual([{ runtime_entity_id: 9n, action: 'respawn', position: { x: 0, y: 0, z: 0 }, result_position: { x: 0, y: 0, z: 0 }, face: -1 }]);
    const order = client.sent.map((p) => (p.name === 'respawn' ? `respawn${String(p.params.state)}` : p.name)).filter((n) => n.startsWith('respawn') || n === 'player_action');
    expect(order.slice(-3)).toEqual(['respawn2', 'respawn2', 'player_action']);
    expect(r.dead).toBe(false);
    expect(events.map((e) => e.kind)).toEqual(['death', 'health', 'respawn']);
    expect(events.at(-1)).toMatchObject({ kind: 'respawn', feet: { x: 8.5, z: 8.5 } });
    expect(r.status()).toMatchObject({ deaths: 1, dead: false });
  });

  it('health 0 alone is a death too (cause filled in by a later death_info)', async () => {
    const { client, metrics, r } = await start(-1);
    client.receive('set_health', { health: 0 });
    expect(r.dead).toBe(true);
    expect(r.lastDeath?.cause).toBe('health_zero');
    client.receive('death_info', { cause: 'death.attack.mob', messages: ['UnitBot', 'entity.zombie.name'] });
    expect(r.lastDeath?.cause).toBe('death.attack.mob');
    client.receive('respawn', { position: EYE(0.5, 0.5), state: 0, runtime_entity_id: 0n });
    expect(r.deaths).toBe(1); // the same death
    expect(metrics.counters['deaths.death.attack.mob']).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.sentOf('player_action')).toHaveLength(0); // negative delay: stays on the death screen
    expect(r.health).toBe(0);
  });

  it('runs after-respawn hooks in order and aborts them on the next death', async () => {
    const { client, r } = await start(100);
    const order: string[] = [];
    let aborted = false;
    r.afterRespawn(async (_feet, death, signal) => {
      order.push(`a${death?.n}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 5_000);
        signal.addEventListener('abort', () => {
          aborted = true;
          clearTimeout(t);
          resolve();
        });
      });
    });
    r.afterRespawn((_feet, death, signal) => {
      if (!signal.aborted) order.push(`b${death?.n}`);
    });
    client.receive('respawn', { position: EYE(0.5, 0.5), state: 0, runtime_entity_id: 0n });
    await vi.advanceTimersByTimeAsync(200);
    client.receive('respawn', { position: EYE(0.5, 0.5), state: 1, runtime_entity_id: 0n });
    await vi.advanceTimersByTimeAsync(5_100);
    await r.hooksDone;
    expect(order).toEqual(['a1', 'b1']);
    // second death while hook a runs
    client.receive('respawn', { position: EYE(0.5, 0.5), state: 0, runtime_entity_id: 0n });
    await vi.advanceTimersByTimeAsync(200);
    client.receive('respawn', { position: EYE(0.5, 0.5), state: 1, runtime_entity_id: 0n });
    await vi.advanceTimersByTimeAsync(100);
    client.receive('death_info', { cause: 'death.attack.generic', messages: [] });
    client.receive('respawn', { position: EYE(0.5, 0.5), state: 0, runtime_entity_id: 0n });
    await r.hooksDone;
    expect(aborted).toBe(true);
    expect(order).toEqual(['a1', 'b1', 'a2']);
    expect(r.deaths).toBe(3);
  });

  it('a disconnect while dead clears the death screen state and the timer', async () => {
    const { client, r, conn } = await start(1000);
    client.receive('respawn', { position: EYE(0.5, 0.5), state: 0, runtime_entity_id: 0n });
    conn.disconnect();
    expect(r.dead).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.sentOf('player_action')).toHaveLength(0);
  });
});

describe('homeHook', () => {
  it('walks to the home block unless skipped; cancels the walk on abort', async () => {
    const goals: unknown[] = [];
    let finish: (r: SkillResult) => void = () => {};
    const skills = {
      goto: vi.fn((g: unknown) => {
        goals.push(g);
        return new Promise<SkillResult>((resolve) => {
          finish = resolve;
        });
      }),
      cancel: vi.fn(() => {
        finish({ ok: false, reason: 'interrupted' });
      }),
    };
    const results: SkillResult[] = [];
    let skip = false;
    const hook = homeHook({ skills, home: () => ({ x: 4.7, y: -60, z: -2.2 }), skip: () => skip, onResult: (r) => results.push(r) });
    const ac = new AbortController();
    const run = hook({ x: 0, y: -60, z: 0 }, undefined, ac.signal);
    await Promise.resolve();
    expect(goals).toEqual([{ type: 'block', p: { x: 4, y: -60, z: -3 } }]);
    finish({ ok: true });
    await run;
    expect(results).toEqual([{ ok: true }]);

    const ac2 = new AbortController();
    const run2 = hook({ x: 0, y: -60, z: 0 }, undefined, ac2.signal);
    await Promise.resolve();
    ac2.abort();
    await run2;
    expect(skills.cancel).toHaveBeenCalledTimes(1);
    expect(results.at(-1)).toEqual({ ok: false, reason: 'interrupted' });

    skip = true;
    await hook({ x: 0, y: -60, z: 0 }, undefined, new AbortController().signal);
    expect(skills.goto).toHaveBeenCalledTimes(2);
  });
});
