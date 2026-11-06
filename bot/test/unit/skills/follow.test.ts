// Follow / come units (PLAN.md task 7.5, docs/pve.md) on the fakes of combat.test.ts: near goal of
// radius 3, re-planned when the target moved more than 2 blocks, sprint beyond 8, stop within 3,
// last known position (or the spot before a teleport) when the target leaves the tracked set.
import { describe, expect, it } from 'vitest';
import { cleanName, findPlayer, FollowController } from '../../../src/skills/follow/follow.ts';
import type { EntityInfo } from '../../../src/world/types.ts';
import { FakeLoop, FakeMover, mob } from './pve-fakes.ts';

/** Track W1: a loop whose body is in water (`inWater`, the physics test of the input loop). */
class WetLoop extends FakeLoop {
  inWater = true;
  override get state() {
    return { ...super.state, inWater: this.inWater };
  }
}

function setup(ents: Map<bigint, EntityInfo>) {
  const loop = new FakeLoop();
  const mover = new FakeMover();
  const f = new FollowController({ loop, mover, entities: () => ents });
  return { loop, mover, f };
}

describe('FollowController', () => {
  it('walks a near goal of radius 3, sprints beyond 8, re-plans after a 2-block move, stops within 3', async () => {
    const ents = new Map<bigint, EntityInfo>([[9n, mob(9n, 'minecraft:pig', { x: 0, y: -60, z: 12 })]]);
    const s = setup(ents);
    const done = s.f.follow({ runtimeId: 9n });
    s.loop.step();
    expect(s.mover.gotos).toHaveLength(1);
    expect(s.mover.gotos[0]).toMatchObject({ goal: { type: 'near', p: { x: 0, y: -60, z: 12 }, r: 3 }, sprint: true });
    expect(s.f.status().state).toBe('following');
    // small move: no new plan while walking
    ents.get(9n)!.pos.z = 13;
    s.loop.step(6);
    expect(s.mover.gotos).toHaveLength(1);
    // more than 2 blocks since the plan: re-plan
    ents.get(9n)!.pos.z = 15;
    s.loop.step(1);
    expect(s.mover.gotos).toHaveLength(2);
    // arrive (fake: the goto succeeds and we stand 2.5 blocks away)
    s.loop.pos = { x: 0, y: -60, z: 12.5 };
    s.mover.finish({ ok: true });
    await Promise.resolve();
    s.loop.step(10);
    expect(s.f.status().state).toBe('close');
    expect(s.mover.gotos).toHaveLength(2);
    // goal reached but 3.2 away by 3D distance: no replanning loop
    s.loop.pos = { x: 0, y: -60, z: 11.8 };
    s.loop.step(20);
    expect(s.mover.gotos.length).toBeLessThanOrEqual(3);
    s.f.stop();
    expect(await done).toMatchObject({ ok: true, reason: 'stopped' });
  });

  it('goes to the last known position when the target leaves view, then waits; resumes when it is back', async () => {
    const ents = new Map<bigint, EntityInfo>([[5n, mob(5n, 'minecraft:player', { x: 6, y: -58.38, z: 0 }, { username: 'Steve§r' })]]);
    const s = setup(ents);
    void s.f.follow({ playerName: 'steve' });
    s.loop.step();
    expect(s.mover.gotos[0]!.goal).toMatchObject({ type: 'near', p: { x: 6, y: -60, z: 0 }, r: 3 });
    ents.delete(5n);
    s.loop.step();
    expect(s.f.status().state).toBe('lost');
    expect(s.mover.gotos.at(-1)!.goal).toMatchObject({ type: 'near', p: { x: 6, y: -60, z: 0 }, r: 1.5 });
    s.mover.finish({ ok: true });
    await Promise.resolve();
    s.loop.step(3);
    expect(s.f.status().state).toBe('waiting');
    const n = s.mover.gotos.length;
    s.loop.step(40);
    expect(s.mover.gotos).toHaveLength(n); // waits, no walking around
    ents.set(5n, mob(5n, 'minecraft:player', { x: 10, y: -58.38, z: 4 }, { username: 'Steve' }));
    s.loop.step();
    expect(s.f.status().state).toBe('following');
    expect(s.mover.gotos.length).toBe(n + 1);
    s.f.dispose();
  });

  it('after a teleport followed by leaving view it goes where the target was before the jump', () => {
    const ents = new Map<bigint, EntityInfo>([[5n, mob(5n, 'minecraft:player', { x: 4, y: -58.38, z: 0 }, { username: 'Steve' })]]);
    const s = setup(ents);
    void s.f.follow({ playerName: 'Steve' });
    s.loop.step();
    ents.get(5n)!.pos.x = 400; // teleported far away ...
    s.loop.step();
    ents.delete(5n); // ... and dropped from view
    s.loop.step();
    expect(s.mover.gotos.at(-1)!.goal).toMatchObject({ type: 'near', p: { x: 4 }, r: 1.5 });
    s.f.dispose();
  });

  it('come: one goto to within 2 blocks of the player, not_found when unknown', async () => {
    const ents = new Map<bigint, EntityInfo>([[5n, mob(5n, 'minecraft:player', { x: 20, y: -58.38, z: 5 }, { username: 'Alex' })]]);
    const s = setup(ents);
    expect(await s.f.come('Nobody')).toEqual({ ok: false, reason: 'not_found' });
    const p = s.f.come('alex');
    expect(s.mover.gotos[0]).toMatchObject({ goal: { type: 'near', p: { x: 20, y: -60, z: 5 }, r: 2 }, sprint: true });
    s.mover.finish({ ok: true });
    expect(await p).toEqual({ ok: true });
  });

  it('Track W1: in water with nothing driving it treads water (jump held) instead of sinking; stops out of it', async () => {
    const ents = new Map<bigint, EntityInfo>([[5n, mob(5n, 'minecraft:player', { x: 0, y: -59.38, z: 6 }, { username: 'Steve' })]]);
    const loop = new WetLoop();
    loop.pos = { x: 0, y: -61.2, z: 0 };
    const mover = new FakeMover();
    const f = new FollowController({ loop, mover, entities: () => ents });
    void f.follow({ playerName: 'steve' });
    loop.step();
    expect(mover.gotos).toHaveLength(1);
    // the walk ends 3.5 from the swimming target (its goal reached): following, settled, treading water
    loop.pos = { x: 0, y: -61.2, z: 2.5 };
    mover.finish({ ok: true });
    await Promise.resolve();
    loop.step(3);
    expect(f.status().state).toBe('following');
    expect(mover.gotos).toHaveLength(1);
    expect(loop.command.jump).toBe(true);
    expect(loop.command.forward).toBe(0);
    // within the stop distance: close, still treading
    loop.pos = { x: 0, y: -61.2, z: 3.5 };
    loop.step(2);
    expect(f.status().state).toBe('close');
    expect(loop.command.jump).toBe(true);
    // bobbing a little past the stop distance stays close in water (no cancelled walk every few ticks)
    loop.pos = { x: 0, y: -60.2, z: 2.6 };
    loop.step(2);
    expect(f.status().state).toBe('close');
    expect(mover.gotos).toHaveLength(1);
    // out of the water (on a step 2.5 from the target): the jump key goes
    loop.pos = { x: 0, y: -61, z: 3.5 };
    loop.inWater = false;
    loop.step(2);
    expect(loop.command.jump).toBe(false);
    // dry and close: never jumps
    loop.step(5);
    expect(loop.command.jump).toBe(false);
    // the target swims off: the navigator drives (treading ends, no jump left over from it)
    loop.inWater = true;
    loop.step(2);
    expect(loop.command.jump).toBe(true);
    ents.get(5n)!.pos.z = 12;
    loop.step(1);
    expect(mover.nav.busy).toBe(true);
    expect(f.status().state).toBe('following');
    f.dispose();
  });

  it('finds players by name, ignoring case and formatting codes', () => {
    const ents = new Map<bigint, EntityInfo>([[5n, mob(5n, 'minecraft:player', { x: 0, y: 0, z: 0 }, { username: '§aSteve§r' })]]);
    expect(cleanName('§aSteve§r')).toBe('steve');
    expect(findPlayer(ents, 'STEVE')?.runtimeId).toBe(5n);
    expect(findPlayer(ents, 'Alex')).toBeUndefined();
  });
});
