import { describe, expect, it } from 'vitest';
import type {
  CorrectPlayerMovePredictionPacket,
  MovePlayerPacket,
  PlayerAuthInputPacket,
  RespawnPacket,
  Vec3,
} from '../../../src/connection/types.ts';
import { InputLoop, flatWorld, type InputConnection, type InputLoopEvent } from '../../../src/skills/input/index.ts';

/** A Connection stand-in driven by the test: `tick()` runs the tick handlers like the 20 Hz driver. */
class FakeConnection implements InputConnection {
  runtimeId = 7n;
  spawnPosition: Vec3 | undefined = { x: 0.5, y: -58.38, z: 0.5 };
  sent: PlayerAuthInputPacket[] = [];
  private n = 0n;
  private readonly handlers = new Map<string, Set<(p: never) => void>>();
  private readonly tickFns = new Set<(t: bigint) => void>();
  private readonly spawnFns = new Set<() => void>();

  on(name: 'move_player', fn: (p: MovePlayerPacket) => void): () => void;
  on(name: 'correct_player_move_prediction', fn: (p: CorrectPlayerMovePredictionPacket) => void): () => void;
  on(name: 'respawn', fn: (p: RespawnPacket) => void): () => void;
  on(name: string, fn: (p: never) => void): () => void {
    let set = this.handlers.get(name);
    if (!set) this.handlers.set(name, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }
  queue(_name: 'player_auth_input', p: PlayerAuthInputPacket): void {
    this.sent.push(p);
  }
  onTick(fn: (t: bigint) => void): () => void {
    this.tickFns.add(fn);
    return () => this.tickFns.delete(fn);
  }
  onSpawn(fn: () => void): () => void {
    this.spawnFns.add(fn);
    return () => this.spawnFns.delete(fn);
  }
  spawn(): void {
    this.n = 0n;
    for (const fn of this.spawnFns) fn();
  }
  tick(count = 1): void {
    for (let i = 0; i < count; i++) {
      this.n++;
      for (const fn of this.tickFns) fn(this.n);
    }
  }
  receive(name: string, p: object): void {
    for (const fn of this.handlers.get(name) ?? []) (fn as (p: object) => void)(p);
  }
  get last(): PlayerAuthInputPacket {
    return this.sent.at(-1)!;
  }
}

function setup(): { conn: FakeConnection; loop: InputLoop; events: InputLoopEvent[] } {
  const conn = new FakeConnection();
  const loop = new InputLoop(conn, { world: flatWorld() });
  const events: InputLoopEvent[] = [];
  loop.onEvent((e) => events.push(e));
  loop.start();
  conn.spawn();
  return { conn, loop, events };
}

describe('InputLoop', () => {
  it('sends one player_auth_input per tick from the spawn point, eye position, increasing ticks', () => {
    const { conn, loop } = setup();
    conn.tick(3);
    expect(conn.sent.map((p) => p.tick)).toEqual([1n, 2n, 3n]);
    expect(conn.last.position.y).toBeCloseTo(-58.38, 4);
    expect(conn.last.input_data).toEqual(['vertical_collision']);
    expect(loop.state.onGround).toBe(true);
    expect(loop.state.pos.y).toBeCloseTo(-60, 4);
    expect(loop.state.ready).toBe(true);
  });

  it('walks with the command and reports the velocity as delta', () => {
    const { conn, loop } = setup();
    conn.tick(2); // settle: the body starts airborne at the spawn point (velocity 0) and lands on the second tick
    loop.setCommand({ forward: 1 });
    conn.tick(2);
    expect(conn.last.input_data).toEqual(['up', 'vertical_collision']);
    expect(conn.last.move_vector).toEqual({ x: 0, z: 1 });
    expect(conn.last.position.z).toBeCloseTo(0.5 + 0.098 + 0.098 * 1.546, 4);
    expect(conn.last.delta.z).toBeCloseTo(loop.state.vel.z, 6);
    loop.release();
    conn.tick();
    expect(conn.last.input_data).toEqual(['vertical_collision']);
  });

  it('applies a correction (rewind + replay), counts it and emits an event', () => {
    const { conn, loop, events } = setup();
    conn.tick(5);
    conn.receive('correct_player_move_prediction', {
      prediction_type: 'player',
      position: { x: 3.5, y: -58.38, z: 0.5 },
      delta: { x: 0, y: -0.0784, z: 0 },
      rotation: { x: 0, y: 0 },
      on_ground: true,
      tick: 4n,
    } satisfies CorrectPlayerMovePredictionPacket);
    expect(loop.state.corrections).toBe(1);
    expect(loop.state.pos.x).toBeCloseTo(3.5, 5);
    const ev = events.find((e) => e.kind === 'correction');
    expect(ev).toMatchObject({ kind: 'correction', tick: 4n, replayed: 1, count: 1 });
    expect(ev?.kind === 'correction' && ev.error).toBeCloseTo(3, 4);
    conn.tick();
    expect(conn.last.position.x).toBeCloseTo(3.5, 5);
  });

  it('adopts a move_player teleport and sets handled_teleport on the next input only', () => {
    const { conn, loop, events } = setup();
    loop.setCommand({ forward: 1 });
    conn.tick(3);
    conn.receive('move_player', {
      runtime_id: 7,
      position: { x: 10.5, y: -58.38, z: 10.5 },
      pitch: 0,
      yaw: 45,
      head_yaw: 45,
      mode: 'teleport',
      on_ground: true,
      ridden_runtime_id: 0,
      tick: 3n,
    } satisfies MovePlayerPacket);
    expect(loop.state.teleports).toBe(1);
    expect(loop.command.yaw).toBe(45);
    conn.tick();
    // the first input after the teleport is not simulated: it reports the target
    expect(conn.last.input_data).toContain('handled_teleport');
    expect(conn.last.position).toEqual({ x: 10.5, y: Math.fround(-60 + 1.62), z: 10.5 });
    conn.tick();
    expect(conn.last.input_data).not.toContain('handled_teleport');
    expect(conn.last.position.x).not.toBe(10.5); // walking at yaw 45 again
    expect(events.some((e) => e.kind === 'teleport')).toBe(true);
  });

  it('ignores move_player for other entities and rotation-only updates keep the position', () => {
    const { conn, loop } = setup();
    conn.tick();
    const base = { position: { x: 9, y: -58.38, z: 9 }, pitch: 0, yaw: 30, head_yaw: 30, on_ground: true, ridden_runtime_id: 0, tick: 1n };
    conn.receive('move_player', { ...base, runtime_id: 99, mode: 'teleport' });
    conn.receive('move_player', { ...base, runtime_id: 7, mode: 'rotation' });
    expect(loop.state.teleports).toBe(0);
    expect(loop.state.pos.x).toBeCloseTo(0.5, 5);
    expect(loop.command.yaw).toBe(30);
  });

  it('nudge moves the local position without inputs; waitTicks resolves after n inputs', async () => {
    const { conn, loop } = setup();
    loop.nudge({ x: 0, y: 0, z: 3 });
    const done = loop.waitTicks(2);
    conn.tick(2);
    await done;
    expect(conn.last.position.z).toBeCloseTo(3.5, 5);
    expect(conn.last.input_data).toEqual(['vertical_collision']);
  });

  it('sends idle inputs without simulating when the world is unknown', () => {
    const conn = new FakeConnection();
    const loop = new InputLoop(conn, { world: { solidAt: () => undefined } });
    loop.start();
    conn.spawn();
    loop.setCommand({ forward: 1 });
    conn.tick(3);
    expect(conn.last.move_vector).toEqual({ x: 0, z: 0 });
    expect(conn.last.input_data).not.toContain('up');
    expect(loop.state.pos.z).toBeCloseTo(0.5, 6);
  });
});
