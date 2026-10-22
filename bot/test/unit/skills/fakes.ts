// Test doubles for closed-loop movement tests: a Connection stand-in driven tick by tick, and a
// world stand-in exposing what BotSkills needs (chunks / registry backed by a GenWorld).
import type { PlayerAuthInputPacket, Vec3 } from '../../../src/connection/types.ts';
import { InputLoop, type InputConnection } from '../../../src/skills/input/index.ts';
import type { BlockInfo } from '../../../src/world/types.ts';
import type { GenWorld } from './genworld.ts';

export class FakeConnection implements InputConnection {
  runtimeId = 7n;
  spawnPosition: Vec3 | undefined;
  sent: PlayerAuthInputPacket[] = [];
  private n = 0n;
  private readonly handlers = new Map<string, Set<(p: never) => void>>();
  private readonly tickFns = new Set<(t: bigint) => void>();
  private readonly spawnFns = new Set<() => void>();

  constructor(feet: Vec3) {
    this.spawnPosition = { x: feet.x, y: feet.y + 1.62, z: feet.z };
  }

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
}

/** The parts of `World` BotSkills reads, backed by a GenWorld. */
export function fakeWorld(gen: GenWorld) {
  const self = { health: 20, food: 20 };
  return {
    gen,
    self,
    chunks: {
      stateIdAt: (x: number, y: number, z: number) => gen.blockAt(x, y, z)?.stateId,
      runtimeIdAt: () => 0,
      maxY: gen.maxY,
      minY: gen.minY,
    },
    registry: {
      blockInfo: (stateId: number) => infoByState(gen, stateId),
    },
    onBlockUpdate: (fn: (p: Vec3, before: BlockInfo | undefined, after: BlockInfo) => void) => gen.onBlockUpdate(fn),
  };
}

function infoByState(gen: GenWorld, stateId: number): BlockInfo {
  const info = gen.infoOf(stateId);
  if (!info) throw new Error(`state ${stateId} not in the world`);
  return info;
}

/** A connection + InputLoop spawned at `feet`, ready to be ticked. */
export function harness(feet: Vec3): { conn: FakeConnection; loop: InputLoop } {
  const conn = new FakeConnection(feet);
  const loop = new InputLoop(conn, { world: { solidAt: () => false } });
  loop.start();
  conn.spawn();
  return { conn, loop };
}
