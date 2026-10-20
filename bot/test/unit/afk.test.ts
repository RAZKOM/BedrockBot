// Task 1.3: AfkTask nudge packets (tick counter, eye-height position, flags) and scheduling.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Metrics } from '../../src/connection/metrics.ts';
import type { PlayerAuthInputPacket } from '../../src/connection/types.ts';
import { silentLogger } from '../../src/log.ts';
import { AfkTask, lookVector, NUDGE_TICKS, type AfkOptions } from '../../src/tasks/afk.ts';
import { connectAndSpawn, setup, type FakeClient } from './connection-fakes.ts';

const inputs = (c: FakeClient) => c.sentOf('player_auth_input') as unknown as PlayerAuthInputPacket[];

describe('AfkTask', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function start(opts: AfkOptions = {}) {
    const { conn, clients } = setup({ reconnect: { baseMs: 100, jitter: 0 } });
    const metrics = new Metrics();
    const afk = new AfkTask(conn, { log: silentLogger, metrics, ...opts });
    afk.start();
    const client = await connectAndSpawn(conn, clients, 9n);
    return { conn, clients, afk, client, metrics };
  }

  it('sends one settle input after spawn, then nothing until the first nudge', async () => {
    const { client, afk } = await start({ nudgeIntervalMs: 10_000 });
    await vi.advanceTimersByTimeAsync(9_000);
    const sent = inputs(client);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ tick: 1n, input_data: ['vertical_collision'], yaw: 0, position: { x: 0.5, z: 0.5 } });
    expect(sent[0]!.position.y).toBeCloseTo(-58.38, 5);
    expect(afk.nudges).toBe(0);
  });

  it('nudges every interval: look, one-tick sneak toggle, look back, at eye height with the live tick', async () => {
    const { client, afk, conn, metrics } = await start({ nudgeIntervalMs: 10_000 });
    const nudges: bigint[] = [];
    afk.onEvent((e) => {
      if (e.kind === 'nudge') nudges.push(e.tick);
    });
    await vi.advanceTimersByTimeAsync(10_000 + 50 * (NUDGE_TICKS + 1));
    const sent = inputs(client).slice(1); // skip the settle input
    expect(sent).toHaveLength(NUDGE_TICKS);
    expect(sent.map((p) => p.yaw)).toEqual([30, 30, 30, 0]);
    expect(sent.map((p) => p.head_yaw)).toEqual([30, 30, 30, 0]);
    expect(sent[1]!.input_data).toEqual(['vertical_collision', 'sneak_down', 'want_down', 'sneak_current_raw', 'sneak_pressed_raw', 'sneaking', 'start_sneaking']);
    expect(sent[2]!.input_data).toEqual(['vertical_collision', 'sneak_released_raw', 'stop_sneaking']);
    expect(sent[0]!.input_data).toEqual(['vertical_collision']);
    // Consecutive ticks of the 20 Hz driver, as BigInt.
    const ticks = sent.map((p) => p.tick);
    expect(typeof ticks[0]).toBe('bigint');
    expect(ticks.map((t) => t - ticks[0]!)).toEqual([0n, 1n, 2n, 3n]);
    expect(ticks[0]! > 190n && ticks[0]! < 210n).toBe(true);
    for (const p of sent) {
      expect(p.position).toEqual({ x: 0.5, y: -58.38, z: 0.5 });
      expect(p.delta).toEqual({ x: 0, y: 0, z: 0 });
      expect(p.move_vector).toEqual({ x: 0, z: 0 });
      expect(p).toMatchObject({ input_mode: 'mouse', play_mode: 'normal', interaction_model: 'crosshair' });
    }
    expect(sent[0]!.camera_orientation).toEqual(lookVector(30, 0));
    expect(nudges).toEqual([ticks[3]]);
    expect(metrics.counters.nudges).toBe(1);
    // The next nudge looks the other way.
    client.sent = [];
    await vi.advanceTimersByTimeAsync(10_000 + 50 * NUDGE_TICKS);
    expect(inputs(client).map((p) => p.yaw)).toEqual([-30, -30, -30, 0]);
    expect(afk.nudges).toBe(2);
    expect(conn.state).toBe('spawned');
  });

  it('nudgeIntervalMs 0 never nudges; heartbeat sends an idle input every tick', async () => {
    const off = await start({ nudgeIntervalMs: 0 });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(inputs(off.client)).toHaveLength(1);
    expect(off.afk.nudges).toBe(0);
    off.conn.disconnect();

    const hb = await start({ nudgeIntervalMs: 0, heartbeat: true });
    await vi.advanceTimersByTimeAsync(1_000);
    const sent = inputs(hb.client);
    expect(sent.length).toBeGreaterThanOrEqual(19);
    expect(new Set(sent.map((p) => p.tick)).size).toBe(sent.length); // one per tick
  });

  it('follows teleports (move_player) and corrections, and flags handled_teleport once', async () => {
    const { client, afk, metrics } = await start({ nudgeIntervalMs: 10_000 });
    await vi.advanceTimersByTimeAsync(60); // settle input first
    client.receive('move_player', { runtime_id: 9, position: { x: 10.5, y: -50.38, z: 3.5 }, pitch: 10, yaw: 90, head_yaw: 90, mode: 'teleport', on_ground: true, ridden_runtime_id: 0, tick: 0n });
    afk.nudgeNow();
    await vi.advanceTimersByTimeAsync(50 * (NUDGE_TICKS + 1));
    const sent = inputs(client).slice(1);
    expect(sent[0]!.position.x).toBe(10.5);
    expect(sent[0]!.position.y).toBeCloseTo(-50.38, 5);
    expect(sent[0]!.input_data).toContain('handled_teleport');
    expect(sent[1]!.input_data).not.toContain('handled_teleport');
    expect(sent.map((p) => p.yaw)).toEqual([120, 120, 120, 90]);
    expect(sent[0]!.pitch).toBe(10);
    // Another player's move_player is ignored.
    client.receive('move_player', { runtime_id: 77, position: { x: 99, y: 0, z: 99 }, pitch: 0, yaw: 0, head_yaw: 0, mode: 'normal', on_ground: true, ridden_runtime_id: 0, tick: 0n });
    expect(afk.feet?.x).toBe(10.5);
    client.receive('correct_player_move_prediction', { prediction_type: 'player', position: { x: 10.5, y: -51.38, z: 3.5 }, delta: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0 }, on_ground: true, tick: 5n });
    expect(afk.corrections).toBe(1);
    expect(metrics.counters.corrections).toBe(1);
    expect(afk.feet?.y).toBeCloseTo(-53, 5);
  });

  it('restarts its schedule and settles again after a reconnect, without duplicate sends', async () => {
    const { clients, afk } = await start({ nudgeIntervalMs: 10_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    clients[0]!.kick('kicked');
    await vi.advanceTimersByTimeAsync(100);
    clients[1]!.spawn(9n, { x: 2.5, y: -58.38, z: 2.5 });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(inputs(clients[1]!)).toHaveLength(1); // settle only; the nudge is 10 s after the respawn
    expect(inputs(clients[1]!)[0]!.position.x).toBe(2.5);
    await vi.advanceTimersByTimeAsync(1_000 + 50 * (NUDGE_TICKS + 1));
    const sent = inputs(clients[1]!);
    expect(sent).toHaveLength(1 + NUDGE_TICKS);
    expect(afk.nudges).toBe(1);
    expect(inputs(clients[0]!)).toHaveLength(1);
  });

  it('presses respawn after death and resumes nudging', async () => {
    const { client, afk, metrics, conn } = await start({ nudgeIntervalMs: 10_000, respawnDelayMs: 1_000 });
    const events: string[] = [];
    afk.onEvent((e) => events.push(e.kind));
    await vi.advanceTimersByTimeAsync(100);
    client.receive('respawn', { position: { x: 0.5, y: -58.38, z: 0.5 }, state: 0, runtime_entity_id: 0n });
    expect(afk.dead).toBe(true);
    afk.nudgeNow();
    await vi.advanceTimersByTimeAsync(900);
    expect(client.sentOf('respawn')).toHaveLength(1); // only the spawn handshake so far
    expect(inputs(client)).toHaveLength(1); // no input while dead
    await vi.advanceTimersByTimeAsync(150);
    expect(client.sentOf('respawn').at(-1)).toEqual({ position: { x: 0, y: 0, z: 0 }, state: 2, runtime_entity_id: 9n });
    expect(client.sentOf('player_action')).toEqual([{ runtime_entity_id: 9n, action: 'respawn', position: { x: 0, y: 0, z: 0 }, result_position: { x: 0, y: 0, z: 0 }, face: -1 }]);
    client.receive('respawn', { position: { x: 4.5, y: -58.38, z: 4.5 }, state: 1, runtime_entity_id: 0n });
    expect(afk.dead).toBe(false);
    expect(afk.feet?.x).toBe(4.5);
    await vi.advanceTimersByTimeAsync(100);
    expect(inputs(client).at(-1)?.position.x).toBe(4.5); // settle at the new spot
    expect(events).toEqual(['death', 'position', 'respawn']);
    expect(metrics.counters.deaths).toBe(1);
    expect(conn.state).toBe('spawned');
  });

  it('stop() detaches everything', async () => {
    const { client, afk } = await start({ nudgeIntervalMs: 1_000, heartbeat: true });
    afk.stop();
    client.sent = [];
    await vi.advanceTimersByTimeAsync(5_000);
    expect(inputs(client)).toHaveLength(0);
  });
});
