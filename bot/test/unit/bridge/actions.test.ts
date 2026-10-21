import { describe, expect, it } from 'vitest';
import { ACTION_TICK_CAP, ActionExecutor, raycast, viewVector, isDigTarget } from '../../../src/bridge/actions.ts';
import { FakeLoop, FakeSkills, FakeWorld } from './fakes.ts';

function setup() {
  const world = new FakeWorld();
  const loop = new FakeLoop();
  const skills = new FakeSkills(loop, world);
  const ex = new ActionExecutor({ world, loop, skills });
  return { world, loop, skills, ex };
}

describe('raycast / view vector', () => {
  it('view vector: yaw 0 = +z, 90 = -x, pitch 90 = down', () => {
    expect(viewVector(0, 0).z).toBeCloseTo(1);
    expect(viewVector(90, 0).x).toBeCloseTo(-1);
    expect(viewVector(0, 90).y).toBeCloseTo(-1);
  });

  it('hits the first diggable block within reach', () => {
    const w = new FakeWorld();
    w.set(0, -59, 3, 'oak_log');
    const eye = { x: 0.5, y: -60 + 1.62, z: 0.5 };
    expect(raycast((p) => w.blockAt(p), eye, viewVector(0, 0), 5, isDigTarget)).toEqual({ x: 0, y: -59, z: 3 });
    expect(raycast((p) => w.blockAt(p), eye, viewVector(180, 0), 5, isDigTarget)).toBeUndefined();
    // looking down: the grass under the feet
    expect(raycast((p) => w.blockAt(p), eye, viewVector(0, 90), 5, isDigTarget)).toEqual({ x: 0, y: -61, z: 0 });
  });
});

describe('action executor', () => {
  it('noop waits 10 ticks', async () => {
    const { ex } = setup();
    expect(await ex.run({ kind: 'noop', block: 'log' })).toEqual({ ok: true, action: 'noop', ticks: 10 });
  });

  it('goto_nearest_log: near goal around the nearest log, then looks at it', async () => {
    const { ex, world, skills } = setup();
    expect(await ex.run({ kind: 'goto_nearest_log', block: 'log' })).toMatchObject({ ok: false, reason: 'no_log' });
    world.set(6, -60, 0, 'oak_log');
    const r = await ex.run({ kind: 'goto_nearest_log', block: 'log' });
    expect(r).toMatchObject({ ok: true, action: 'goto_nearest_log', target: { x: 6, y: -60, z: 0 } });
    expect(skills.calls).toEqual(['goto {"type":"near","p":{"x":6.5,"y":-60,"z":0.5},"r":3}', 'lookAt 6.5,-59.5,0.5']);
  });

  it('dig_facing_block digs what the view ray hits, never anything else', async () => {
    const { ex, world, loop, skills } = setup();
    expect(await ex.run({ kind: 'dig_facing_block', block: 'log' })).toMatchObject({ ok: false, reason: 'no_block' });
    world.set(0, -59, 2, 'oak_log');
    const r = await ex.run({ kind: 'dig_facing_block', block: 'log' });
    expect(r).toMatchObject({ ok: true, target: { x: 0, y: -59, z: 2 } });
    expect(world.blockAt({ x: 0, y: -59, z: 2 })?.name).toBe('air');
    loop.setCommand({ pitch: 90 });
    skills.digResult = { ok: false, reason: 'unbreakable' };
    expect(await ex.run({ kind: 'dig_facing_block', block: 'log' })).toMatchObject({ ok: false, reason: 'unbreakable', target: { x: 0, y: -61, z: 0 } });
  });

  it('caps a hanging skill at 100 ticks and cancels it', async () => {
    const { ex, world, skills } = setup();
    world.set(20, -60, 0, 'oak_log');
    skills.hang = true;
    const r = await ex.run({ kind: 'goto_nearest_log', block: 'log' });
    expect(r).toMatchObject({ ok: false, reason: 'timeout' });
    expect(r.ticks).toBeGreaterThanOrEqual(ACTION_TICK_CAP);
    expect(r.ticks).toBeLessThanOrEqual(ACTION_TICK_CAP + 2);
    expect(skills.cancelled).toBeGreaterThan(0);
  });

  it('turns by 45 degrees with pitch 0', async () => {
    const { ex, loop } = setup();
    loop.setCommand({ yaw: 10, pitch: 30 });
    await ex.run({ kind: 'turn_right', block: 'log' });
    expect(loop.command).toMatchObject({ yaw: 55, pitch: 0 });
    await ex.run({ kind: 'turn_left', block: 'log' });
    await ex.run({ kind: 'turn_left', block: 'log' });
    expect(loop.command.yaw).toBe(325);
  });

  it('step_forward moves one block and releases the keys; a wall reports blocked', async () => {
    const { ex, loop } = setup();
    const r = await ex.run({ kind: 'step_forward', block: 'log' });
    expect(r.ok).toBe(true);
    expect(loop.state.pos.z).toBeGreaterThanOrEqual(1.5);
    expect(loop.command.forward).toBe(0);
    loop.speed = 0;
    expect(await ex.run({ kind: 'step_forward', block: 'log' })).toMatchObject({ ok: false, reason: 'blocked' });
  });

  it('runs one action at a time', async () => {
    const { ex } = setup();
    const a = ex.run({ kind: 'noop', block: 'log' });
    expect(await ex.run({ kind: 'noop', block: 'log' })).toMatchObject({ ok: false, reason: 'busy' });
    expect((await a).ok).toBe(true);
  });

  it('collect_drops goes through the skill with the remaining budget', async () => {
    const { ex, skills } = setup();
    expect((await ex.run({ kind: 'collect_drops', block: 'log' })).ok).toBe(true);
    expect(skills.calls).toEqual(['collect 8 100']);
  });
});
