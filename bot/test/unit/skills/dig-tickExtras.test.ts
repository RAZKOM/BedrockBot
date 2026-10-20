// InputLoop.setTickExtras (the hook digging uses): fields are merged into the queued
// player_auth_input, flags are appended without duplicates, and the Digger drives it end to end.
import { describe, expect, it } from 'vitest';
import type {
  CorrectPlayerMovePredictionPacket,
  MovePlayerPacket,
  PlayerAuthInputPacket,
  RespawnPacket,
  Vec3,
} from '../../../src/connection/types.ts';
import { Digger } from '../../../src/skills/dig/index.ts';
import { InputLoop, flatWorld, type InputConnection } from '../../../src/skills/input/index.ts';
import type { BlockInfo } from '../../../src/world/types.ts';

class FakeConnection implements InputConnection {
  runtimeId = 7n;
  spawnPosition: Vec3 | undefined = { x: 0.5, y: -58.38, z: 0.5 };
  sent: PlayerAuthInputPacket[] = [];
  private n = 0n;
  private readonly tickFns = new Set<(t: bigint) => void>();
  private readonly spawnFns = new Set<() => void>();
  on(name: 'move_player', fn: (p: MovePlayerPacket) => void): () => void;
  on(name: 'correct_player_move_prediction', fn: (p: CorrectPlayerMovePredictionPacket) => void): () => void;
  on(name: 'respawn', fn: (p: RespawnPacket) => void): () => void;
  on(): () => void {
    return () => {};
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
  tick(count = 1): void {
    for (let i = 0; i < count; i++) {
      this.n++;
      for (const fn of this.tickFns) fn(this.n);
    }
  }
}

function setup() {
  const conn = new FakeConnection();
  const loop = new InputLoop(conn, { world: flatWorld() });
  loop.start();
  return { conn, loop };
}

describe('InputLoop.setTickExtras', () => {
  it('merges fields and appends flags on the ticks the provider returns something', () => {
    const { conn, loop } = setup();
    const action = [{ action: 'start_break', position: { x: 2, y: -60, z: 0 }, face: 4 }];
    loop.setTickExtras((t) => (t === 2n ? { input_data: ['block_action', 'vertical_collision'], block_action: action } : undefined));
    conn.tick(3);
    expect(conn.sent).toHaveLength(3);
    expect(conn.sent[0]!.block_action).toBeUndefined();
    expect(conn.sent[1]!.block_action).toEqual(action);
    expect(conn.sent[1]!.input_data).toContain('block_action');
    // no duplicate of a flag the loop already sets
    expect(conn.sent[1]!.input_data.filter((f) => f === 'vertical_collision')).toHaveLength(1);
    expect(conn.sent[2]!.input_data).not.toContain('block_action');
    // movement fields are untouched
    expect(conn.sent[1]!.position).toEqual(conn.sent[0]!.position);
    loop.setTickExtras(undefined);
    conn.tick();
    expect(conn.sent[3]!.block_action).toBeUndefined();
  });

  it('carries a whole dig: look, start, continue, predict+stop, release', async () => {
    const { conn, loop } = setup();
    const p = { x: 2, y: -60, z: 0 };
    let name = 'short_grass';
    const listeners = new Set<(q: Vec3, b: BlockInfo | undefined, a: BlockInfo) => void>();
    const info = (n: string): BlockInfo => ({ name: n, stateId: 0, states: {}, hardness: 0, solid: false, boxes: [] });
    const world = {
      blockAt: (q: Vec3) => (q.x === p.x && q.y === p.y && q.z === p.z ? info(name) : info('air')),
      onBlockUpdate: (fn: (q: Vec3, b: BlockInfo | undefined, a: BlockInfo) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      inventory: { slots: [], selected: 0 },
    };
    const digger = new Digger({ loop, world });
    conn.tick();
    const pending = digger.dig(p);
    conn.tick(2);
    const start = conn.sent.at(-1)!;
    expect(start.yaw).toBeCloseTo(-90, 0); // the look is in the same packet
    expect(start.pitch).toBeGreaterThan(0);
    expect((start.block_action as { action: string }[]).map((a) => a.action)).toEqual(['start_break', 'predict_break', 'stop_break']);
    name = 'air';
    for (const fn of listeners) fn(p, info('short_grass'), info('air'));
    expect(await pending).toMatchObject({ ok: true, expected: 0 });
    conn.tick();
    expect((conn.sent.at(-1)!.block_action as { action: string }[]).map((a) => a.action)).toEqual(['abort_break']);
    conn.tick();
    expect(conn.sent.at(-1)!.block_action).toBeUndefined();
  });
});
