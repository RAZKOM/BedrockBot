// Pillar-up felling and temporary scaffold (decision 0051, docs/wood.md "Pillar-up") on fakes: a block map,
// a body that falls onto the first solid block under it, goto = teleport onto a standable cell, place = a pillar
// block under the feet (the body rises by one), dig = air (the body drops when its floor goes).
import { describe, expect, it } from 'vitest';
import { collectItems, type CollectDeps } from '../../../src/skills/collect/collect.ts';
import { clearScaffold, dropUnder, ScaffoldRecord } from '../../../src/skills/place/scaffold.ts';
import { fellTree, pillarSpots, planColumn, type FellDeps } from '../../../src/skills/tree/feller.ts';
import { detectTree } from '../../../src/skills/tree/tree.ts';
import type { NavGoal } from '../../../src/skills/nav/goals.ts';
import type { BlockInfo, EntityInfo, Vec3 } from '../../../src/world/types.ts';

const GROUND = -61; // top of the floor; feet at -60
const k = (x: number, y: number, z: number) => `${x},${y},${z}`;
const SOLID = [[0, 0, 0, 1, 1, 1] as const];

class Blocks {
  readonly m = new Map<string, string>();
  set(x: number, y: number, z: number, name: string): void {
    this.m.set(k(x, y, z), name);
  }
  name(x: number, y: number, z: number): string {
    return this.m.get(k(x, y, z)) ?? (y <= GROUND ? (y === GROUND ? 'grass_block' : 'dirt') : 'air');
  }
  at = (p: Vec3): BlockInfo => {
    const n = this.name(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    const solid = n !== 'air';
    return { name: n, stateId: 1, states: {}, hardness: 1, solid, boxes: solid ? (SOLID) : [] };
  };
  solid(x: number, y: number, z: number): boolean {
    return this.name(x, y, z) !== 'air';
  }
}

/** A tree: a column (or 2 x 2) of logs `h` high from feet level, a leaf canopy over its top 3 logs. */
function tree(b: Blocks, x: number, z: number, h: number, kind: string, wide = false): Vec3[] {
  const cols = wide ? [[0, 0], [1, 0], [0, 1], [1, 1]] : [[0, 0]];
  const logs: Vec3[] = [];
  for (let y = -60; y < -60 + h; y++) for (const [dx, dz] of cols) {
    b.set(x + dx!, y, z + dz!, `${kind}_log`);
    logs.push({ x: x + dx!, y, z: z + dz! });
  }
  for (let y = -60 + h - 3; y <= -60 + h; y++)
    for (let dx = -2; dx <= (wide ? 3 : 2); dx++)
      for (let dz = -2; dz <= (wide ? 3 : 2); dz++) if (!b.solid(x + dx, y, z + dz)) b.set(x + dx, y, z + dz, `${kind}_leaves`);
  return logs;
}

function world(b: Blocks, start: Vec3, throwaways: number) {
  const body = { pos: { ...start }, corrections: 0, onGround: true };
  const log: { dug: { p: Vec3; was: string }[]; placed: Vec3[]; lines: string[]; minY: number; maxFall: number } = { dug: [], placed: [], lines: [], minY: start.y, maxFall: 0 };
  let carried = throwaways;
  const fall = () => {
    const x = Math.floor(body.pos.x);
    const z = Math.floor(body.pos.z);
    let y = Math.floor(body.pos.y + 1e-3);
    const from = y;
    while (!b.solid(x, y - 1, z)) y--;
    log.maxFall = Math.max(log.maxFall, from - y);
    body.pos.y = y;
  };
  const stand = (x: number, y: number, z: number) => (b.solid(x, y - 1, z) && !b.solid(x, y, z) && !b.solid(x, y + 1, z) ? y : Number.NaN);
  const deps: FellDeps = {
    blockAt: b.at,
    state: () => body,
    stand,
    cancelled: () => false,
    dig: (p) => {
      const was = b.name(p.x, p.y, p.z);
      if (was === 'air') return Promise.resolve({ ok: false, reason: 'no_block' });
      log.dug.push({ p: { ...p }, was });
      b.set(p.x, p.y, p.z, 'air');
      if (was === 'cobblestone') carried++; // the drop falls with the body: picked up
      fall();
      return Promise.resolve({ ok: true, ticks: 5 });
    },
    goto: (g) => {
      if (g.type !== 'block') return Promise.resolve({ ok: false, reason: 'bad goal' });
      if (Number.isNaN(stand(g.p.x, g.p.y, g.p.z))) return Promise.resolve({ ok: false, reason: 'unreachable' });
      body.pos = { x: g.p.x + 0.5, y: g.p.y, z: g.p.z + 0.5 };
      return Promise.resolve({ ok: true });
    },
    place: (p) => {
      const f = { x: Math.floor(body.pos.x), y: Math.floor(body.pos.y + 1e-3), z: Math.floor(body.pos.z) };
      if (p.x !== f.x || p.y !== f.y || p.z !== f.z || carried <= 0) return Promise.resolve({ ok: false, reason: 'in_body' });
      if (b.solid(f.x, f.y + 2, f.z) || b.solid(f.x, f.y + 3, f.z)) return Promise.resolve({ ok: false, reason: 'no_headroom' });
      b.set(p.x, p.y, p.z, 'cobblestone');
      carried--;
      log.placed.push({ ...p });
      body.pos.y += 1;
      return Promise.resolve({ ok: true, block: 'cobblestone' });
    },
    throwaways: () => carried,
    waitTicks: () => Promise.resolve(),
    logger: { debug: () => {}, info: (m: string) => log.lines.push(m), warn: (m: string) => log.lines.push(m), error: (m: string) => log.lines.push(m) },
  };
  return { deps, body, log, carried: () => carried };
}

function cobbleLeft(b: Blocks): string[] {
  return [...b.m.entries()].filter(([, n]) => n === 'cobblestone').map(([key]) => key);
}

describe('fellTree pillar-up (fakes)', () => {
  it('fells a 20-high spruce: pillars next to the trunk, digs the pillar down again, back on the ground', async () => {
    const b = new Blocks();
    const logs = tree(b, 0, 0, 20, 'spruce');
    const t = detectTree(b.at, logs[0]!)!;
    expect(t.logs.length).toBe(20);
    const w = world(b, { x: 4.5, y: -60, z: 0.5 }, 64);
    const r = await fellTree(t, w.deps);
    expect(r.ok, w.log.lines.join('\n')).toBe(true);
    expect(r.left).toEqual([]);
    expect(r.pillars).toBeGreaterThanOrEqual(1);
    expect(r.scaffoldPlaced).toBeGreaterThanOrEqual(10);
    expect(r.scaffoldRemoved).toBe(r.scaffoldPlaced);
    expect(r.scaffoldLeft).toEqual([]);
    expect(cobbleLeft(b)).toEqual([]);
    expect(w.body.pos.y).toBe(-60); // on the ground
    expect(w.log.maxFall).toBeLessThanOrEqual(1); // one block at a time
    expect(w.carried()).toBe(64); // every block picked up again
    // only logs, leaves and its own blocks were dug; every cobblestone dug was one it placed
    const placed = new Set(w.log.placed.map((p) => k(p.x, p.y, p.z)));
    for (const d of w.log.dug) {
      expect(['spruce_log', 'spruce_leaves', 'cobblestone']).toContain(d.was);
      if (d.was === 'cobblestone') expect(placed.has(k(d.p.x, d.p.y, d.p.z))).toBe(true);
    }
  });

  it('fells a 2 x 2 jungle tree 25 high', async () => {
    const b = new Blocks();
    const logs = tree(b, 0, 0, 25, 'jungle', true);
    const t = detectTree(b.at, logs[0]!)!;
    expect(t.logs.length).toBe(100);
    const w = world(b, { x: 5.5, y: -60, z: 0.5 }, 32);
    const r = await fellTree(t, w.deps);
    expect(r.ok, w.log.lines.join('\n')).toBe(true);
    expect(cobbleLeft(b)).toEqual([]);
    expect(w.body.pos.y).toBe(-60);
    expect(w.carried()).toBe(32);
  });

  it('without throwaway blocks behaves as before: the logs out of reach are left', async () => {
    const b = new Blocks();
    const logs = tree(b, 0, 0, 9, 'oak');
    const t = detectTree(b.at, logs[0]!)!;
    const w = world(b, { x: 3.5, y: -60, z: 0.5 }, 0);
    const r = await fellTree(t, w.deps);
    expect(r.reason).toBe('logs_left');
    expect(r.broken).toEqual(logs.slice(0, 7));
    expect(r.pillars).toBe(0);
    expect(w.log.lines.some((l) => l.includes('no throwaway blocks'))).toBe(true);
  });

  it('places nothing inside the protected area and says so', async () => {
    const b = new Blocks();
    const logs = tree(b, 0, 0, 12, 'oak');
    const t = detectTree(b.at, logs[0]!)!;
    const w = world(b, { x: 3.5, y: -60, z: 0.5 }, 64);
    w.deps.protectedAt = (p) => Math.hypot(p.x + 0.5 - 10, p.y + 0.5 + 60, p.z + 0.5) <= 48;
    const r = await fellTree(t, w.deps);
    expect(r.reason).toBe('logs_left');
    expect(w.log.placed).toEqual([]);
    expect(w.log.lines.some((l) => l.includes('protected area'))).toBe(true);
  });

  it('planColumn digs leaves on the way, refuses other blocks; pillarSpots prefers short pillars next to the trunk', () => {
    const b = new Blocks();
    const logs = tree(b, 0, 0, 14, 'oak');
    const ctx = { blockAt: b.at, stand: (x: number, y: number, z: number) => (b.solid(x, y - 1, z) && !b.solid(x, y, z) && !b.solid(x, y + 1, z) ? y : Number.NaN), treeLogs: new Set(logs.map((p) => k(p.x, p.y, p.z))), reach: 4.75, maxBlocks: 40 };
    const top = logs.at(-1)!;
    b.set(1, -55, 0, 'oak_leaves'); // a leaf in the column: dug on the way
    const c = planColumn(1, 0, -60, top, ctx);
    if ('why' in c) throw new Error(c.why);
    expect(c.blocks).toBe(c.top + 60);
    expect(top.y - (c.top + 1.62)).toBeGreaterThan(3.5); // the lowest top from which the log is in reach (4.75)
    expect(top.y - (c.top + 1.62)).toBeLessThan(4.75);
    expect(c.leaves).toBe(1);
    b.set(1, -55, 0, 'stone');
    const blocked = planColumn(1, 0, -60, top, ctx);
    expect('why' in blocked && blocked.why).toContain('blocked');
    b.set(1, -55, 0, 'air');
    const s = pillarSpots(top, ctx, { from: { x: 5, y: -60, z: 0 }, others: logs });
    expect(s.spots.length).toBeGreaterThan(0);
    const best = s.spots[0]!;
    expect(Math.max(Math.abs(best.foot.x), Math.abs(best.foot.z))).toBeLessThanOrEqual(1);
    expect(best.foot.y).toBe(-60);
  });
});

describe('clearScaffold (fakes)', () => {
  it('digs a pillar down from its top, one block at a time, and never a block it did not place', async () => {
    const b = new Blocks();
    const rec = new ScaffoldRecord();
    for (let y = -60; y < -55; y++) {
      b.set(0, y, 0, 'cobblestone');
      rec.add({ x: 0, y, z: 0 }, 'cobblestone');
    }
    b.set(0, -58, 0, 'dirt'); // someone replaced one: not ours any more
    const w = world(b, { x: 0.5, y: -55, z: 0.5 }, 0);
    const r = await clearScaffold(rec, { blockAt: b.at, state: () => w.body, dig: w.deps.dig, goto: w.deps.goto, waitTicks: () => Promise.resolve() });
    expect(r.gone).toEqual([{ x: 0, y: -58, z: 0 }]);
    expect(b.name(0, -58, 0)).toBe('dirt');
    expect(r.removed.map((p) => p.y)).toEqual([-56, -57]);
    expect(w.body.pos.y).toBe(-57); // standing on the dirt now
    // the two below the dirt: dug from the side? the body stands above them on a block it did not place: left
    expect(r.left.map((l) => l.p.y).sort()).toEqual([-59, -60].sort());
    expect(w.log.dug.every((d) => d.was === 'cobblestone')).toBe(true);
  });

  it('leaves a bridge block over a deep drop (removing it would strand or hurt the bot)', async () => {
    const b = new Blocks();
    for (let y = -66; y <= -61; y++) b.set(0, y, 0, 'air'); // a pit 6 deep
    b.set(0, -61, 0, 'cobblestone');
    const rec = new ScaffoldRecord();
    rec.add({ x: 0, y: -61, z: 0 }, 'cobblestone');
    expect(dropUnder(b.at, { x: 0, y: -61, z: 0 })).toBe(5);
    const w = world(b, { x: 0.5, y: -60, z: 0.5 }, 0);
    const r = await clearScaffold(rec, { blockAt: b.at, state: () => w.body, dig: w.deps.dig, waitTicks: () => Promise.resolve() });
    expect(r.removed).toEqual([]);
    expect(r.left).toHaveLength(1);
    expect(r.left[0]!.why).toContain('drop');
    expect(b.name(0, -61, 0)).toBe('cobblestone');
  });

  it('walks onto a column it does not stand on and digs it down (the ledge after a pickup)', async () => {
    const b = new Blocks();
    // a ledge 3 high at x >= 1; a 3-block pillar at x = 0 against it; the body on the ledge
    for (let x = 1; x <= 4; x++) for (let y = -60; y <= -58; y++) b.set(x, y, 0, 'stone');
    const rec = new ScaffoldRecord();
    for (let y = -60; y <= -58; y++) {
      b.set(0, y, 0, 'cobblestone');
      rec.add({ x: 0, y, z: 0 }, 'cobblestone');
    }
    const w = world(b, { x: 2.5, y: -57, z: 0.5 }, 0);
    const r = await clearScaffold(rec, { blockAt: b.at, state: () => w.body, dig: w.deps.dig, goto: w.deps.goto, waitTicks: () => Promise.resolve() });
    expect(r.left).toEqual([]);
    expect(r.removed).toHaveLength(3);
    expect(w.body.pos).toMatchObject({ x: 0.5, y: -60 });
    expect(cobbleLeft(b)).toEqual([]);
  });
});

describe('collect: a walk that may dig and place for an item the walk cannot reach', () => {
  const item = (id: bigint, pos: Vec3): EntityInfo => ({ runtimeId: id, uniqueId: id, type: 'minecraft:item', item: { name: 'oak_log', networkId: 17, count: 1, metadata: 0 }, pos, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, headYaw: 0, onGround: true, updatedAt: 0 });

  function fake() {
    const entities = new Map<bigint, EntityInfo>();
    const state = { pos: { x: 0.5, y: -60, z: 0.5 }, corrections: 0, tick: 0n };
    const calls: { hard: number; cleared: ScaffoldRecord[]; opts: unknown[] } = { hard: 0, cleared: [], opts: [] };
    const deps: CollectDeps = {
      entities: () => entities,
      state: () => state,
      waitTicks: (n) => {
        state.tick += BigInt(n);
        return Promise.resolve();
      },
      goto: () => Promise.resolve({ ok: false, reason: 'unreachable' }),
      inventory: { slots: [], room: () => 64, count: () => 0 },
      cancelled: () => false,
      hardGoto: (_g: NavGoal, o, record) => {
        calls.hard++;
        calls.opts.push(o);
        for (let y = -60; y <= -57; y++) record.add({ x: 0, y, z: 0 }, 'cobblestone');
        entities.clear(); // picked up on the ledge
        return Promise.resolve({ ok: true });
      },
      clearScaffold: (record) => {
        calls.cleared.push(record);
        return Promise.resolve({ removed: record.cells.map((c) => c.p), left: [], gone: [] });
      },
    };
    return { entities, deps, calls };
  }

  it('picks the item up with one such walk and digs the scaffold again', async () => {
    const f = fake();
    f.entities.set(1n, item(1n, { x: 2.5, y: -55.875, z: 0.5 }));
    const r = await collectItems(8, 200, f.deps, { hard: true });
    expect(r.ok).toBe(true);
    expect(r.pickedUp).toBe(1);
    expect(f.calls.hard).toBe(1);
    expect(f.calls.opts[0]).toMatchObject({ allowBreak: true, allowPlace: true, timeoutTicks: 300 });
    expect(f.calls.cleared).toHaveLength(1);
    expect(r.hardWalks).toBe(1);
    expect(r.scaffoldPlaced).toBe(4);
    expect(r.scaffoldLeft).toBe(0);
  });

  it('is off by default and limited to one walk per item (also across collects), and to hardFilter', async () => {
    const f = fake();
    f.entities.set(1n, item(1n, { x: 2.5, y: -55.875, z: 0.5 }));
    const r0 = await collectItems(8, 100, f.deps);
    expect(f.calls.hard).toBe(0);
    expect(r0.hardWalks).toBeUndefined();
    await collectItems(8, 100, f.deps, { hard: true, hardFilter: (i) => i.name === 'stick' });
    expect(f.calls.hard).toBe(0);
    f.deps.hardTried = new Set([1n]);
    await collectItems(8, 100, f.deps, { hard: true });
    expect(f.calls.hard).toBe(0);
  });
});
