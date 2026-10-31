// Track BF: underwater recovery (swim straight up, shore search) and drowning attribution.
import { describe, expect, it } from 'vitest';
import { IDLE_COMMAND, initialBody, stepBody, type BodyState, type MoveCommand } from '../../../src/skills/input/index.ts';
import { blockQueryOf } from '../../../src/skills/terrain/index.ts';
import { headInWater, swimUp } from '../../../src/skills/survival/surface.ts';
import { shoreNear } from '../../../src/tasks/process/surface.ts';
import { MobTracker } from '../../../src/skills/combat/hostiles.ts';
import type { EntityInfo, Vec3 } from '../../../src/world/types.ts';
import { GenWorld } from './genworld.ts';
import { FakeSource, mob } from './pve-fakes.ts';

/** A 16-deep pond (water y -76..-61) in stone, the shore at feet y -60. */
function pond(): GenWorld {
  const w = new GenWorld({ x: -32, y: -80, z: -32 }, { x: 64, y: 40, z: 64 });
  w.fill({ x: -32, y: -80, z: -32 }, { x: 31, y: -61, z: 31 }, 'stone');
  w.fill({ x: -8, y: -76, z: -8 }, { x: 8, y: -61, z: 8 }, 'water');
  return w;
}

function bodyLoop(w: GenWorld, feet: Vec3) {
  const q = blockQueryOf(w);
  let s: BodyState = initialBody(feet, true);
  let cmd: MoveCommand = { ...IDLE_COMMAND };
  const fns = new Set<(t: bigint, st: { pos: Vec3; inWater: boolean }) => void>();
  const loop = {
    get state() {
      return { pos: s.pos, inWater: s.inWater === true, ready: true };
    },
    setCommand(c: Partial<MoveCommand>) {
      cmd = { ...cmd, ...c };
    },
    onBeforeStep(fn: (t: bigint, st: { pos: Vec3; inWater: boolean }) => void) {
      fns.add(fn);
      return () => {
        fns.delete(fn);
      };
    },
    tick() {
      for (const f of [...fns]) f(0n, loop.state);
      s = stepBody(s, cmd, q).state;
    },
    get listeners() {
      return fns.size;
    },
  };
  return loop;
}

const nameAt = (w: GenWorld) => (p: Vec3) => w.blockAt(p.x, p.y, p.z);

const grid = (w: GenWorld) => {
  const solid = (x: number, y: number, z: number) => (w.blockAt(x, y, z)?.boxes.length ?? 0) > 0;
  const liquid = (x: number, y: number, z: number) => /water|lava/.test(w.blockAt(x, y, z)?.name ?? '');
  return {
    stand: (x: number, y: number, z: number) => (solid(x, y - 1, z) && !solid(x, y, z) && !solid(x, y + 1, z) ? y : Number.NaN),
    cls: (x: number, y: number, z: number) => {
      const b = w.blockAt(x, y, z);
      return b ? { name: b.name, liquid: liquid(x, y, z) ? 'water' : undefined } : undefined;
    },
  };
};

describe('underwater recovery', () => {
  it('swims 15 blocks straight up from a pond floor with the jump key and finds the shore', async () => {
    const w = pond();
    const loop = bodyLoop(w, { x: 0.5, y: -76, z: 0.5 });
    expect(headInWater(nameAt(w), loop.state.pos)).toBe(true);
    let done: { ok: boolean; ticks: number; rose: number } | undefined;
    void swimUp(loop, nameAt(w)).then((r) => (done = r));
    for (let i = 0; i < 500 && !done; i++) {
      loop.tick();
      await Promise.resolve();
    }
    expect(done?.ok).toBe(true);
    expect(done!.rose).toBeGreaterThan(14);
    expect(done!.ticks).toBeLessThan(200);
    expect(headInWater(nameAt(w), loop.state.pos)).toBe(false);
    expect(loop.listeners).toBe(0);
    const shore = shoreNear(grid(w), loop.state.pos);
    expect(shore).toBeDefined();
    expect(shore!.y).toBe(-60);
    expect(Math.max(Math.abs(shore!.x), Math.abs(shore!.z))).toBe(9);
  });

  it('gives up after maxTicks under a roof', async () => {
    const w = pond();
    w.fill({ x: -8, y: -61, z: -8 }, { x: 8, y: -61, z: 8 }, 'stone');
    const loop = bodyLoop(w, { x: 0.5, y: -76, z: 0.5 });
    let done: { ok: boolean; ticks: number } | undefined;
    void swimUp(loop, nameAt(w), { maxTicks: 250 }).then((r) => (done = r));
    for (let i = 0; i < 400 && !done; i++) {
      loop.tick();
      await Promise.resolve();
    }
    expect(done).toEqual(expect.objectContaining({ ok: false, ticks: 250 }));
  });
});

describe('drowning attribution', () => {
  const setup = (head: () => boolean) => {
    const src = new FakeSource();
    const entities = new Map<bigint, EntityInfo>();
    const mobs = new MobTracker(src, { entities: () => entities, selfRuntimeId: () => 1n, selfPos: () => ({ x: 0, y: -60, z: 0 }), headInWater: head });
    const hits: { g: unknown; cause: unknown }[] = [];
    mobs.onHit((g, _d, cause) => hits.push({ g, cause }));
    return { src, entities, mobs, hits };
  };

  it('a hit with the head under water and the air out is drowning, not the nearest mob', () => {
    const { src, entities, mobs, hits } = setup(() => true);
    entities.set(3n, mob(3n, 'minecraft:zombie', { x: 2, y: -60, z: 0 }));
    src.emit('set_entity_data', { runtime_entity_id: 1n, metadata: [{ key: 'air', value: 0 }] });
    expect(mobs.selfAir).toBe(0);
    src.emit('set_health', { health: 20 });
    src.emit('set_health', { health: 18 });
    expect(hits).toEqual([{ g: undefined, cause: 'drowning' }]);
  });

  it('with air left, or the head out of the water, the mob guess stays', () => {
    let head = true;
    const { src, entities, hits } = setup(() => head);
    entities.set(3n, mob(3n, 'minecraft:zombie', { x: 2, y: -60, z: 0 }));
    src.emit('set_entity_data', { runtime_entity_id: 1n, metadata: [{ key: 'air', value: 200 }] });
    src.emit('set_health', { health: 20 });
    src.emit('set_health', { health: 18 });
    head = false;
    src.emit('set_entity_data', { runtime_entity_id: 1n, metadata: [{ key: 'air', value: 0 }] });
    src.emit('set_health', { health: 16 });
    expect(hits.map((h) => h.cause)).toEqual([undefined, undefined]);
    expect(hits.every((h) => h.g !== undefined)).toBe(true);
  });

  it('without an air value: head under water and no swing is drowning', () => {
    const { src, hits } = setup(() => true);
    src.emit('set_health', { health: 20 });
    src.emit('set_health', { health: 18 });
    expect(hits).toEqual([{ g: undefined, cause: 'drowning' }]);
  });
});
