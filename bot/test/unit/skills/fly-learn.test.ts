// skills/fly/learn/recorder.ts: a flight the owner flies while the bot watches, recorded from the tracked player.
import { describe, expect, it } from 'vitest';
import { pathLine, PathRecorder, summarizePath, validPathName } from '../../../src/skills/fly/learn/recorder.ts';
import type { EntityInfo } from '../../../src/world/types.ts';

function world() {
  let t = 0;
  const player: EntityInfo = { runtimeId: 2n, uniqueId: 2n, type: 'minecraft:player', username: 'Owner', pos: { x: 0, y: 65.62, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, headYaw: 0, onGround: true, updatedAt: 0 };
  const ents = new Map<bigint, EntityInfo>([[2n, player]]);
  const adds = new Set<(e: EntityInfo) => void>();
  return {
    player,
    ents,
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
    move(dx: number, dy: number, dz: number, ground: boolean) {
      player.pos = { x: player.pos.x + dx, y: player.pos.y + dy, z: player.pos.z + dz };
      player.onGround = ground;
      player.updatedAt = t;
    },
    rocket() {
      const e: EntityInfo = { ...player, runtimeId: 9n, uniqueId: 9n, type: 'minecraft:fireworks_rocket', username: undefined, pos: { ...player.pos } };
      for (const fn of adds) fn(e);
    },
    deps: () => ({ entities: () => ents.values(), onAdd: (fn: (e: EntityInfo) => void) => (adds.add(fn), () => adds.delete(fn)), now: () => t }),
  };
}

describe('PathRecorder', () => {
  it('records the glide, the rockets and a gap, and ends by itself 8 s after the landing', () => {
    const w = world();
    const r = new PathRecorder('farm_home', 'owner', w.deps());
    expect(r.visible()).toBe(true);
    let ended: string | undefined;
    const step = (n: number, move: () => void): void => {
      for (let i = 0; i < n; i++) {
        w.advance(50);
        move();
        r.tick();
      }
    };
    // 1 s standing, a rocket, 4 s gliding at 1.5 blocks a tick (30 b/s), 1.5 s out of view, 1 s more gliding, the landing
    step(20, () => w.move(0, 0, 0, true));
    w.rocket();
    step(80, () => w.move(1.5, 0.2, 0, false));
    step(30, () => undefined);
    step(20, () => w.move(1.5, -0.2, 0, false));
    for (let i = 0; i < 200 && !ended; i++) {
      w.advance(50);
      w.move(0, 0, 0, true);
      ended = r.tick();
    }
    expect(ended).toBe('landed');
    const p = r.stop();
    expect(p.ended).toBe('landed');
    expect(p.rockets).toHaveLength(1);
    expect(p.gaps).toHaveLength(1);
    const m = summarizePath(p);
    expect(m.flownSeconds).toBeGreaterThan(4);
    expect(m.maxSpeed).toBeGreaterThan(25);
    expect(m.gaps).toBe(1);
    expect(p.samples[0]!.y).toBeCloseTo(64, 5);
    expect(pathLine(p)).toMatch(/^farm_home: [\d.]+ s, \d+ blocks \(\d+ straight\), flown [\d.]+ s, 1 rocket, top speed [\d.]+ b\/s, y \d+\.\.\d+, 1 gap/);
  });

  it('a walk alone never ends by itself; stop() saves it', () => {
    const w = world();
    const r = new PathRecorder('walk', 'Owner', w.deps());
    for (let i = 0; i < 400; i++) {
      w.advance(50);
      w.move(0.2, 0, 0, true);
      expect(r.tick()).toBeUndefined();
    }
    expect(r.stop().ended).toBe('stop');
  });

  it('names', () => {
    expect(validPathName('cave_in-2')).toBe(true);
    expect(validPathName('../x')).toBe(false);
  });
});
