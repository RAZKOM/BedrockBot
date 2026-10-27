// Wave 9, Track AK (decision 0031; Track W's open issue): the sleeping pose has its own input-loop slot
// (InputLoop.setPose) beside the single setTickExtras slot, so a dig or a hotbar move that takes or clears
// the tick extras while the bot lies in bed no longer drops the held bed position (and the reverse).
import { describe, expect, it } from 'vitest';
import type { CorrectPlayerMovePredictionPacket, MovePlayerPacket, PlayerAuthInputPacket, RespawnPacket, Vec3 } from '../../../src/connection/types.ts';
import { InputLoop, flatWorld, type InputConnection } from '../../../src/skills/input/index.ts';
import { SleepController, SLEEP_EYE_ABOVE } from '../../../src/skills/survival/sleep.ts';
import type { BlockInfo, ItemStack } from '../../../src/world/types.ts';
import { FakeSource } from './pve-fakes.ts';

class FakeConnection implements InputConnection {
  runtimeId = 7n;
  spawnPosition: Vec3 | undefined = { x: 0.5, y: -58.38, z: 0.5 };
  sent: PlayerAuthInputPacket[] = [];
  private n = 0n;
  private readonly tickFns = new Set<(t: bigint) => void>();
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
  onSpawn(): () => void {
    return () => {};
  }
  tick(count = 1): void {
    for (let i = 0; i < count; i++) {
      this.n++;
      for (const fn of this.tickFns) fn(this.n);
    }
  }
}

const HOLD = { x: 3.5, y: -60 + SLEEP_EYE_ABOVE, z: 0.5 };
const zero = { x: 0, y: 0, z: 0 };

describe('InputLoop.setPose (a slot of its own)', () => {
  it('is merged after the tick extras (its fields win, flags add up) and survives setTickExtras(undefined)', () => {
    const conn = new FakeConnection();
    const loop = new InputLoop(conn, { world: flatWorld() });
    loop.start();
    loop.setPose(() => ({ position: HOLD, delta: zero }));
    const action = [{ action: 'start_break', position: { x: 2, y: -60, z: 0 }, face: 4 }];
    loop.setTickExtras(() => ({ input_data: ['block_action'], block_action: action, position: { x: 9, y: 9, z: 9 } }));
    conn.tick();
    expect(conn.sent[0]).toMatchObject({ position: HOLD, delta: zero, block_action: action });
    expect(conn.sent[0]!.input_data).toContain('block_action');
    // the digger clears its slot: the pose stays
    loop.setTickExtras(undefined);
    conn.tick();
    expect(conn.sent[1]!.position).toEqual(HOLD);
    expect(conn.sent[1]!.block_action).toBeUndefined();
    // the pose goes: the loop reports its own body again
    loop.setPose(undefined);
    conn.tick();
    expect(conn.sent[2]!.position).not.toEqual(HOLD);
  });
});

describe('SleepController holds the bed pose in the pose slot', () => {
  const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;
  const bed = (head: boolean): BlockInfo => ({ name: 'bed', stateId: 1, states: { direction: 3, head_piece_bit: head ? 1 : 0, occupied_bit: 0 }, hardness: 0.2, solid: true, boxes: [] });

  it('uses setPose when the loop has it and never touches setTickExtras', async () => {
    const blocks = new Map<string, BlockInfo>([
      ['2,-60,0', bed(false)],
      ['3,-60,0', bed(true)],
    ]);
    const world = {
      chunks: { runtimeIdAt: (x: number, y: number, z: number) => (blocks.has(key({ x, y, z })) ? 777 : 0) },
      inventory: { slots: [] as (ItemStack | null)[], selected: 0, rawItem: () => undefined },
      blockAt: (p: Vec3): BlockInfo | undefined => blocks.get(key(p)) ?? { name: 'air', stateId: 0, states: {}, hardness: 0, solid: false, boxes: [] },
    };
    let pose: ((t: bigint) => Record<string, unknown> | undefined) | undefined;
    let extrasCalls = 0;
    const waiters: (() => void)[] = [];
    const loop = {
      state: { pos: { x: 0.5, y: -60, z: 0.5 }, ready: true },
      setCommand: () => undefined,
      waitTicks: () => new Promise<void>((r) => waiters.push(r)),
      setTickExtras: () => {
        extrasCalls++;
      },
      setPose: (fn: typeof pose) => {
        pose = fn;
      },
    };
    const tick = async (n: number) => {
      for (let i = 0; i < n; i++) {
        for (const r of waiters.splice(0)) r();
        for (let k = 0; k < 5; k++) await Promise.resolve();
      }
    };
    const src = new FakeSource();
    const sleeper = new SleepController({ source: src, loop, world, selfRuntimeId: () => 5n });
    const p = sleeper.sleep({ x: 2, y: -60, z: 0 });
    await tick(2);
    src.emit('set_entity_data', { runtime_entity_id: 5n, metadata: [{ key: 'player_flags', value: 2 }, { key: 'player_bed_position', value: { x: 3, y: -60, z: 0 } }] });
    await tick(1);
    expect((await p).ok).toBe(true);
    expect(pose?.(1n)).toMatchObject({ position: HOLD, delta: zero });
    src.emit('set_entity_data', { runtime_entity_id: 5n, metadata: [{ key: 'player_flags', value: 0 }] });
    expect(pose).toBeUndefined();
    expect(extrasCalls).toBe(0);
  });
});
