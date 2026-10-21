// Felling in a closed loop without a server (PLAN.md task 4.3): FakeConnection -> InputLoop ->
// BotSkills (goto + Digger) on a generated world, with a stand-in "server" that removes a block a
// few ticks after the bot's start_break. Checks the order (bottom up), re-pathing when the next
// log is out of reach, refusing non-logs, skipping unreachable logs, and cancel.
import { describe, expect, it } from 'vitest';
import { treeShape } from '../../../../packs/truth/src/woodShapes.ts';
import { BotSkills } from '../../../src/skills/index.ts';
import { standSpots, type FellResult } from '../../../src/skills/tree/feller.ts';
import { Inventory } from '../../../src/world/inventory.ts';
import type { Vec3 } from '../../../src/world/types.ts';
import { fakeWorld, harness } from './fakes.ts';
import { flatGen, type GenWorld } from './genworld.ts';

function plant(w: GenWorld, x: number, z: number, h: number): Vec3[] {
  const s = treeShape(x, -60, z, h);
  for (const p of s.logs) w.put(p.x, p.y, p.z, 'oak_log');
  for (const p of s.leaves) if (w.blockAt(p.x, p.y, p.z)?.name === 'air') w.put(p.x, p.y, p.z, 'oak_leaves');
  return s.logs;
}

function setup(gen: GenWorld, start: Vec3) {
  const { conn, loop } = harness(start);
  const inventory = new Inventory(() => null, () => 7n);
  const world = { ...fakeWorld(gen), blockAt: (p: Vec3) => gen.blockAt(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), inventory };
  const skills = new BotSkills({ loop, world });
  const digs: { p: Vec3; tick: number }[] = [];
  const pending: { p: Vec3; at: number }[] = [];
  let t = 0;
  /** One server tick: the bot's input, then breaks that are due. */
  const tick = () => {
    conn.tick();
    t++;
    const last = conn.sent.at(-1);
    for (const a of (last?.block_action ?? []) as { action: string; position: Vec3 }[]) {
      if (a.action === 'start_break') {
        digs.push({ p: { ...a.position }, tick: t });
        pending.push({ p: { ...a.position }, at: t + 3 });
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
  return { conn, loop, skills, digs, tick, ticks: () => t };
}

async function drive(h: ReturnType<typeof setup>, p: Promise<FellResult>, max = 6000, during?: (t: number) => void): Promise<FellResult> {
  let done: FellResult | undefined;
  void p.then((r) => (done = r));
  for (let i = 0; i < max && !done; i++) {
    during?.(i);
    h.tick();
    await Promise.resolve();
    await Promise.resolve();
  }
  // let the last promise callbacks run
  for (let i = 0; i < 5 && !done; i++) await new Promise((r) => setTimeout(r, 0));
  if (!done) throw new Error('fell did not finish');
  return done;
}

describe('fellTree (closed loop)', () => {
  it('walks to the tree and breaks every log bottom up', async () => {
    const gen = flatGen();
    const logs = plant(gen, 6, 2, 6);
    const h = setup(gen, { x: 0.5, y: -60, z: 0.5 });
    const tree = h.skills.treeAt(logs[3]!)!;
    const r = await drive(h, h.skills.fellTree(tree));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.broken).toEqual(logs);
    expect(r.left).toEqual([]);
    expect(h.digs.map((d) => d.p)).toEqual(logs);
    expect(r.repaths).toBeGreaterThanOrEqual(1); // it had to walk there first
    expect(r.corrections).toBe(0);
    for (const p of logs) expect(gen.blockAt(p.x, p.y, p.z)?.name).toBe('air');
    // leaves untouched
    expect(gen.blockAt(6, -56, 4)?.name).toBe('oak_leaves');
  });

  it('skips logs nobody can reach from the ground (9-high trunk) and reports them', async () => {
    const gen = flatGen();
    const logs = plant(gen, 3, 0, 9);
    const h = setup(gen, { x: 0.5, y: -60, z: 0.5 });
    const tree = h.skills.treeAt(logs[0]!)!;
    const r = await drive(h, h.skills.fellTree(tree));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('logs_left');
    expect(r.broken).toEqual(logs.slice(0, 7));
    expect(r.left).toEqual(logs.slice(7));
  });

  it('cancel() interrupts a running fell', async () => {
    const gen = flatGen();
    const logs = plant(gen, 2, 0, 5);
    const h = setup(gen, { x: 0.5, y: -60, z: 0.5 });
    const tree = h.skills.treeAt(logs[0]!)!;
    const r = await drive(h, h.skills.fellTree(tree), 6000, (t) => {
      if (t === 6) h.skills.cancel();
    });
    expect(r.reason).toBe('interrupted');
    expect(h.skills.status().running).toBeUndefined();
  });

  it('a new skill call cancels the running one (skills never overlap)', async () => {
    const gen = flatGen();
    const logs = plant(gen, 8, 0, 5);
    const h = setup(gen, { x: 0.5, y: -60, z: 0.5 });
    const fell = h.skills.fellTree(h.skills.treeAt(logs[0]!)!);
    expect(h.skills.status().running).toBe('fell');
    let fellResult: FellResult | undefined;
    void fell.then((r) => (fellResult = r));
    for (let i = 0; i < 3; i++) h.tick();
    const g = h.skills.goto({ type: 'xz', x: -3, z: 0 });
    expect(h.skills.status().running).toBe('goto');
    for (let i = 0; i < 400 && h.skills.nav.busy; i++) {
      h.tick();
      await Promise.resolve();
    }
    expect(await g).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(fellResult?.reason).toBe('interrupted');
    expect(h.digs).toEqual([]);
  });
});

describe('standSpots', () => {
  it('prefers cells that reach more logs and are close to the tree', () => {
    const gen = flatGen();
    const logs = plant(gen, 0, 0, 6);
    const h = setup(gen, { x: 10.5, y: -60, z: 0.5 });
    const spots = standSpots(logs[5]!, { stand: (x, y, z) => h.skills.nav.grid.stand(x, y, z) }, { reach: 4.75, radius: 4, from: { x: 10.5, y: -60, z: 0.5 }, others: logs });
    expect(spots.length).toBeGreaterThan(0);
    const best = spots[0]!;
    // next to the trunk, on the ground
    expect(Math.max(Math.abs(best.cell.x), Math.abs(best.cell.z))).toBe(1);
    expect(best.feet).toBe(-60);
  });
});
