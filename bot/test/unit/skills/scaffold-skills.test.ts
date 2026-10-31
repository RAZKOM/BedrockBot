// Pending scaffold at the BotSkills level (decision 0051, review 2026-10-31) in a closed loop: FakeConnection ->
// InputLoop -> BotSkills (Digger) on a generated flat world with a dirt pillar the bot stands on, and a stand-in
// "server" that removes a block a few ticks after the bot's start_break (unless the test refuses it).
//   cancel -> the dig-down starts; a goto waits for it (nav.busy and status().busy while it waits) and a cancel
//   drops the waiting goto; a dig that keeps failing never gives the cell under the feet up (it stays pending and
//   the next dig-down tries again); a bot in the air over its pillar (a pillar jump) is waited for, then dug down.
import { describe, expect, it } from 'vitest';
import { BotSkills } from '../../../src/skills/index.ts';
import type { SkillResult } from '../../../src/skills/types.ts';
import { Inventory } from '../../../src/world/inventory.ts';
import type { Vec3 } from '../../../src/world/types.ts';
import { fakeWorld, harness } from './fakes.ts';
import { flatGen, type GenWorld } from './genworld.ts';

const TOP = -56; // a dirt pillar at (0, -60..-56, 0): the feet stand at -55

function setup(start: Vec3 = { x: 0.5, y: TOP + 1, z: 0.5 }) {
  const gen: GenWorld = flatGen();
  for (let y = -60; y <= TOP; y++) gen.put(0, y, 0, 'dirt');
  const { conn, loop } = harness(start);
  const inventory = new Inventory(() => null, () => 7n);
  const world = { ...fakeWorld(gen), blockAt: (p: Vec3) => gen.blockAt(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), inventory };
  const skills = new BotSkills({ loop, world });
  for (let y = -60; y <= TOP; y++) skills.scaffold.add({ x: 0, y, z: 0 }, 'dirt');
  const pending: { p: Vec3; at: number }[] = [];
  const refuse = { left: 0 }; // start_breaks the server ignores (the block stays: the dig times out)
  let t = 0;
  const tick = () => {
    conn.tick();
    t++;
    for (const a of (conn.sent.at(-1)?.block_action ?? []) as { action: string; position: Vec3 }[]) {
      if (a.action === 'start_break') {
        if (refuse.left > 0) refuse.left--;
        else pending.push({ p: { ...a.position }, at: t + 3 });
      }
      if (a.action === 'abort_break') {
        const i = pending.findIndex((q) => q.p.x === a.position.x && q.p.y === a.position.y && q.p.z === a.position.z);
        if (i >= 0) pending.splice(i, 1);
      }
    }
    for (const q of pending.filter((q) => q.at <= t)) {
      pending.splice(pending.indexOf(q), 1);
      gen.set(q.p.x, q.p.y, q.p.z, 'air');
    }
  };
  conn.tick(5);
  const run = async (until: () => boolean, max = 3000) => {
    for (let i = 0; i < max && !until(); i++) {
      tick();
      await Promise.resolve();
      await Promise.resolve();
    }
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const dirtLeft = () => {
    let n = 0;
    for (let y = -60; y <= TOP; y++) if (gen.blockAt(0, y, 0)?.name === 'dirt') n++;
    return n;
  };
  return { gen, conn, loop, skills, tick, run, refuse, dirtLeft };
}

describe('pending scaffold (BotSkills)', () => {
  it('a cancel on top of the pillar digs it down, one block at a time, to the ground', async () => {
    const h = setup();
    expect(h.skills.onScaffold()).toBe(true);
    h.skills.cancel();
    expect(h.skills.status().busy).toBe(true); // the dig-down counts as busy
    await h.run(() => h.skills.scaffold.size === 0 && !h.skills.status().busy && h.loop.state.onGround);
    expect(h.skills.scaffold.size).toBe(0);
    expect(h.dirtLeft()).toBe(0);
    expect(h.loop.state.pos.y).toBeCloseTo(-60, 3);
    expect(h.skills.onScaffold()).toBe(false);
  });

  it('a goto waits for the dig-down (nav.busy while it waits), then walks', async () => {
    const h = setup();
    let r: SkillResult | undefined;
    void h.skills.goto({ type: 'block', p: { x: 4, y: -60, z: 0 } }, { timeoutTicks: 2000 }).then((x) => (r = x));
    expect(h.skills.nav.busy).toBe(true); // `if (nav.busy) cancel()` callers see it
    expect(h.skills.status().busy).toBe(true);
    await h.run(() => r !== undefined);
    expect(r).toEqual({ ok: true });
    expect(h.dirtLeft()).toBe(0);
    expect(Math.floor(h.loop.state.pos.x)).toBe(4);
  });

  it('a cancel drops the waiting goto (no stale walk after the dig-down)', async () => {
    const h = setup();
    let r: SkillResult | undefined;
    void h.skills.goto({ type: 'block', p: { x: 4, y: -60, z: 0 } }, { timeoutTicks: 2000 }).then((x) => (r = x));
    h.tick();
    expect(h.skills.nav.busy).toBe(true);
    if (h.skills.nav.busy) h.skills.cancel(); // what follow / GotoProcess.halt / pve do
    await h.run(() => r !== undefined);
    expect(r).toEqual({ ok: false, reason: 'interrupted' });
    expect(h.skills.nav.busy).toBe(false);
    await h.run(() => h.skills.scaffold.size === 0 && h.loop.state.onGround && !h.skills.status().busy);
    expect(h.dirtLeft()).toBe(0); // the dig-down still finished
    expect(Math.floor(h.loop.state.pos.x)).toBe(0); // and it never walked
  });

  it('N1: digs that keep failing never give up the cell under the feet; it stays pending and the next dig-down retries', async () => {
    const h = setup();
    h.refuse.left = 1000; // the server ignores every start_break for now
    h.skills.cancel();
    await h.run(() => !h.skills.status().busy, 4000);
    expect(h.skills.scaffold.size).toBe(5); // nothing given up
    expect(h.skills.scaffold.lost).toBe(0);
    expect(h.skills.onScaffold()).toBe(true);
    h.refuse.left = 2; // two more failures, then the server lets it break
    h.skills.cancel();
    await h.run(() => h.skills.scaffold.size === 0 && !h.skills.status().busy && h.loop.state.onGround, 4000);
    expect(h.dirtLeft()).toBe(0);
    expect(h.loop.state.pos.y).toBeCloseTo(-60, 3);
  });

  it('N2: a cancel while in the air over the pillar (a pillar jump) waits for the landing, then digs down', async () => {
    const h = setup({ x: 0.5, y: TOP + 2.2, z: 0.5 });
    expect(h.loop.state.onGround).toBe(false);
    h.skills.cancel();
    expect(h.skills.status().busy).toBe(true);
    await h.run(() => h.skills.scaffold.size === 0 && !h.skills.status().busy && h.loop.state.onGround);
    expect(h.dirtLeft()).toBe(0);
    expect(h.loop.state.pos.y).toBeCloseTo(-60, 3);
  });
});
