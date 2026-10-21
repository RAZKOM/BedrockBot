// Task 5.2: WorldClock (sync_world_clocks as BDS 1.26.60 sends it, set_time, start_game, the
// doDayLightCycle rule) and the NightSafety state machine with a fake mover.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Metrics } from '../../src/connection/metrics.ts';
import type { Vec3 } from '../../src/connection/types.ts';
import type { SkillResult } from '../../src/skills/types.ts';
import { isNight, NightSafety, timeOfDay, WorldClock, type Mover } from '../../src/tasks/night.ts';
import { connectAndSpawn, setup } from './connection-fakes.ts';

// What bds-hard sent at login on 2026-10-29 (ids shortened).
const INIT = {
  payload_type: 'initialize_registry',
  clocks: [
    {
      id: 7194480507151251734n,
      name: 'minecraft:overworld',
      time: 13260,
      paused: false,
      time_markers: [{ id: 1n, name: 'minecraft:sunset', time: 12000, period: 24000 }],
    },
  ],
};
const sync = (time: number, paused = false) => ({ payload_type: 'sync_state', sync_states: [{ clock_id: 7194480507151251734n, time, paused }] });

describe('time of day', () => {
  it('isNight is [12000, 23000) of the day', () => {
    expect(isNight(11999)).toBe(false);
    expect(isNight(12000)).toBe(true);
    expect(isNight(18000)).toBe(true);
    expect(isNight(22999)).toBe(true);
    expect(isNight(23000)).toBe(false);
    expect(isNight(24000 + 13000)).toBe(true);
    expect(timeOfDay(-1)).toBe(23999);
  });
});

describe('WorldClock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('follows sync_world_clocks and extrapolates 1 per 50 ms while the cycle runs', async () => {
    const { conn, clients } = setup();
    const clock = new WorldClock(conn);
    clock.start();
    const c = await connectAndSpawn(conn, clients);
    expect(clock.known).toBe(false);
    c.receive('start_game', { runtime_entity_id: 7n, player_position: { x: 0, y: 0, z: 0 }, day_cycle_stop_time: 13260, gamerules: [{ name: 'doDayLightCycle', editable: true, type: 'bool', value: true }] });
    c.receive('sync_world_clocks', INIT);
    expect(clock.time).toBe(13260);
    await vi.advanceTimersByTimeAsync(1000);
    expect(clock.time).toBe(13280);
    c.receive('sync_world_clocks', sync(12501));
    expect(clock.timeOfDay).toBe(12501);
    // another clock id is ignored once the overworld id is known
    c.receive('sync_world_clocks', { payload_type: 'sync_state', sync_states: [{ clock_id: 5n, time: 100, paused: false }] });
    expect(clock.timeOfDay).toBe(12501);
    // doDayLightCycle false freezes the time; true resumes
    c.receive('game_rules_changed', { rules: [{ name: 'doDayLightCycle', editable: true, type: 'bool', value: false }] });
    await vi.advanceTimersByTimeAsync(5000);
    expect(clock.time).toBe(12501);
    c.receive('game_rules_changed', { rules: [{ name: 'doDayLightCycle', editable: true, type: 'bool', value: true }] });
    await vi.advanceTimersByTimeAsync(500);
    expect(clock.time).toBe(12511);
    // paused clock state
    c.receive('sync_world_clocks', sync(6000, true));
    await vi.advanceTimersByTimeAsync(1000);
    expect(clock.time).toBe(6000);
    // older servers: set_time
    c.receive('set_time', { time: 18000 });
    expect(clock.status()).toMatchObject({ timeOfDay: 18000, source: 'set_time' });
    conn.disconnect();
    expect(clock.known).toBe(false);
  });
});

class FakeMover implements Mover {
  calls: Vec3[] = [];
  cancels = 0;
  pending: ((r: SkillResult) => void) | undefined;
  pos: Vec3 = { x: 0.5, y: -60, z: 0.5 };
  goto(goal: { type: string; p?: Vec3 }): Promise<SkillResult> {
    this.calls.push({ ...goal.p! });
    return new Promise((resolve) => {
      this.pending = (r) => {
        this.pending = undefined;
        resolve(r);
      };
    });
  }
  cancel(): void {
    this.cancels++;
    this.pending?.({ ok: false, reason: 'interrupted' });
  }
  arrive(p: Vec3): void {
    this.pos = { x: Math.floor(p.x) + 0.5, y: p.y, z: Math.floor(p.z) + 0.5 };
    this.pending?.({ ok: true });
  }
}

describe('NightSafety', () => {
  function make(opts: { shelter?: Vec3; home?: Vec3 } = {}) {
    let now = 0;
    let time: number | undefined = 6000;
    const mover = new FakeMover();
    const metrics = new Metrics();
    const n = new NightSafety({
      clock: {
        get time() {
          return time;
        },
        get known() {
          return time !== undefined;
        },
      },
      mover,
      position: () => mover.pos,
      shelter: 'shelter' in opts ? opts.shelter : { x: 10, y: -60, z: 10 },
      home: () => opts.home,
      retryMs: 60_000,
      maxAttempts: 3,
      metrics,
      now: () => now,
    });
    const events: string[] = [];
    n.onEvent((e) => events.push(e.kind));
    return {
      n,
      mover,
      metrics,
      events,
      setTime: (t: number | undefined) => {
        time = t;
      },
      advance: (ms: number) => {
        now += ms;
      },
    };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('does nothing by day or without a shelter or a known time', () => {
    const { n, mover, setTime } = make();
    n.check();
    expect(mover.calls).toEqual([]);
    setTime(undefined);
    n.check();
    expect(mover.calls).toEqual([]);
    const none = make({ shelter: undefined });
    none.setTime(13000);
    none.n.check();
    expect(none.mover.calls).toEqual([]);
    expect(none.n.status().state).toBe('off');
  });

  it('retreats at dusk, is sheltered on arrival, re-enters when pushed out, and walks home at dawn', async () => {
    const { n, mover, setTime, events, metrics } = make({ home: { x: 0, y: -60, z: 0 } });
    n.check();
    setTime(12000);
    n.check();
    expect(n.state).toBe('going');
    expect(mover.calls).toEqual([{ x: 10, y: -60, z: 10 }]);
    n.check(); // no second goto while going
    expect(mover.calls).toHaveLength(1);
    mover.arrive({ x: 10, y: -60, z: 10 });
    await tick();
    expect(n.state).toBe('sheltered');
    expect(n.inside()).toBe(true);
    expect(metrics.counters['night.retreats']).toBe(1);
    setTime(18000);
    n.check();
    expect(mover.calls).toHaveLength(1);
    // knocked out of the shelter (or respawned elsewhere): back in
    mover.pos = { x: 14.5, y: -60, z: 10.5 };
    n.check();
    expect(mover.calls).toHaveLength(2);
    mover.arrive({ x: 10, y: -60, z: 10 });
    await tick();
    expect(n.state).toBe('sheltered');
    setTime(23000);
    n.check();
    expect(events).toEqual(['retreat', 'sheltered', 'retreat', 'sheltered', 'dawn']);
    expect(mover.calls.at(-1)).toEqual({ x: 0, y: -60, z: 0 });
    expect(n.state).toBe('returning');
    mover.arrive({ x: 0, y: -60, z: 0 });
    await tick();
    expect(n.state).toBe('day');
  });

  it('unreachable shelter: logs, stays put, retries after retryMs, gives up after maxAttempts until the next dusk', async () => {
    const { n, mover, setTime, advance, metrics, events } = make();
    setTime(13000);
    n.check();
    mover.pending!({ ok: false, reason: 'unreachable' });
    await tick();
    expect(n.state).toBe('unreachable');
    expect(n.attempts).toBe(1);
    n.check();
    advance(59_000);
    n.check();
    expect(mover.calls).toHaveLength(1); // waits retryMs, no loop
    advance(1_000);
    n.check();
    expect(mover.calls).toHaveLength(2);
    mover.pending!({ ok: false, reason: 'unreachable' });
    await tick();
    advance(60_000);
    n.check();
    mover.pending!({ ok: false, reason: 'timeout' });
    await tick();
    expect(n.state).toBe('gave_up');
    for (let i = 0; i < 10; i++) {
      advance(60_000);
      n.check();
    }
    expect(mover.calls).toHaveLength(3);
    expect(metrics.counters['night.unreachable']).toBe(3);
    expect(events.filter((e) => e === 'unreachable')).toHaveLength(3);
    // next day, next dusk: a fresh budget
    setTime(24000 + 6000);
    n.check();
    expect(n.state).toBe('day');
    setTime(24000 + 12500);
    n.check();
    expect(mover.calls).toHaveLength(4);
  });

  it('dawn while walking to the shelter cancels the walk', async () => {
    const { n, mover, setTime } = make();
    setTime(22990);
    n.check();
    expect(n.state).toBe('going');
    setTime(23001);
    n.check();
    await tick();
    expect(mover.cancels).toBe(1);
    expect(n.state).toBe('day');
  });

  it('setShelter resets a given-up night', async () => {
    const { n, mover, setTime } = make();
    setTime(13000);
    for (let i = 0; i < 3; i++) {
      n.check();
      mover.pending?.({ ok: false, reason: 'unreachable' });
      await tick();
      (n as unknown as { nextAttemptAt: number }).nextAttemptAt = 0;
    }
    expect(n.state).toBe('gave_up');
    n.setShelter({ x: 2, y: -60, z: 2 });
    n.check();
    expect(mover.calls.at(-1)).toEqual({ x: 2, y: -60, z: 2 });
  });
});
