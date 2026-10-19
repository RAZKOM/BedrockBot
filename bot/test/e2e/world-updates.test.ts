// e2e (tag @bds), PLAN.md task 2.3: block updates reach the model within 2 ticks, and a box
// checksum computed from the model equals truth:checksum. Needs bds-world (udp/19142) and BDS_E2E=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Connection } from '../../src/connection/connection.ts';
import { silentLogger } from '../../src/log.ts';
import { World } from '../../src/world/index.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { E2E, Truth, WORLD_TARGET, leave, pollUntil, rng, uniqueName } from './world-truth.ts';

const SEED = Number(process.env.WORLD_SEED ?? 20261028);
const TYPES = ['oak_log', 'stone', 'chest'] as const;
/** 2 ticks, and the 500 ms poll budget from the task. */
const POLL_MS = 500;
const AREA = { from: { x: -12, y: -64, z: -12 }, to: { x: 12, y: -55, z: 12 } };

describe.skipIf(!E2E)('@bds world block updates vs truth pack (bds-world)', () => {
  let conn: Connection;
  let world: World;
  let truth: Truth;
  const seen = new Map<string, { at: number; before: string | undefined; after: string }>();

  const k = (p: Vec3) => `${p.x},${p.y},${p.z}`;

  beforeAll(async () => {
    conn = new Connection({ version: '1.26.51', username: uniqueName('WUpdates'), logger: silentLogger, reconnect: false });
    world = new World(conn, { logger: silentLogger });
    truth = new Truth(conn);
    await conn.connect(WORLD_TARGET);
    await world.waitForChunks(3, { timeoutMs: 30_000 });
    await truth.ok('fill', [-12, -60, -12, 12, -50, 12, 'air']);
    await truth.ok('fill', [-12, -61, -12, 12, -61, 12, 'grass_block']);
    const clean = await pollUntil(() => world.checksum(AREA.from, AREA.to) !== undefined && world.blockAt({ x: 5, y: -60, z: 5 })?.name === 'air', 2000);
    expect(clean).toBeGreaterThanOrEqual(0);
    world.onBlockUpdate((p, before, after) => {
      seen.set(k(p), { at: performance.now(), before: before?.name, after: after.name });
    });
  }, 60_000);

  afterAll(async () => {
    try {
      await truth?.ok('fill', [-12, -60, -12, 12, -50, 12, 'air']);
    } catch {
      // best effort
    }
    truth?.dispose();
    world?.dispose();
    await leave(conn);
  });

  it('sees 20 truth:set blocks (oak_log, stone, chest) within 2 ticks', async () => {
    const rand = rng(SEED);
    const used = new Set<string>();
    const placed: { p: Vec3; type: string }[] = [];
    while (placed.length < 20) {
      const p = { x: Math.floor(rand() * 21) - 10, y: -60 + Math.floor(rand() * 4), z: Math.floor(rand() * 21) - 10 };
      if (Math.abs(p.x) <= 1 && Math.abs(p.z) <= 1) continue; // not on the bot
      if (used.has(k(p))) continue;
      used.add(k(p));
      placed.push({ p, type: TYPES[placed.length % TYPES.length]! });
    }
    const latencies: number[] = [];
    for (const { p, type } of placed) {
      const data = await truth.ok<{ typeId: string }>('set', [p.x, p.y, p.z, type]);
      expect(data.typeId).toBe(`minecraft:${type}`);
      const replyAt = performance.now();
      const waited = await pollUntil(() => world.blockAt(p)?.name === type, POLL_MS);
      expect(waited, `${type} at ${k(p)} not seen within ${POLL_MS} ms (model: ${world.blockAt(p)?.name})`).toBeGreaterThanOrEqual(0);
      const ev = seen.get(k(p));
      expect(ev?.after).toBe(type);
      expect(ev?.before).toBe('air');
      latencies.push(ev ? ev.at - replyAt : waited);
    }
    const max = Math.max(...latencies);
    console.log(`[world-updates] 20 sets: update arrival relative to the truth reply: min ${Math.min(...latencies).toFixed(1)} ms, max ${max.toFixed(1)} ms`);
    // Arrival within 2 ticks (100 ms) of the truth reply; negative = before the reply.
    expect(max).toBeLessThanOrEqual(100);
    // Chests come with a block entity (block_entity_data or the subchunk's NBT).
    const chests = placed.filter((b) => b.type === 'chest');
    const withEntity = await pollUntil(() => chests.every((c) => world.blockEntityAt(c.p) !== undefined), POLL_MS);
    console.log(`[world-updates] chest block entities: ${chests.filter((c) => world.blockEntityAt(c.p)).length}/${chests.length}`, JSON.stringify(world.blockEntityAt(chests[0]!.p)));
    expect(withEntity).toBeGreaterThanOrEqual(0);
    expect(world.blockEntityAt(chests[0]!.p)?.id).toBe('Chest');
  });

  it('sees a 5x5x5 truth:fill and the model checksum equals truth:checksum', async () => {
    const from = { x: 3, y: -60, z: -8 };
    const to = { x: 7, y: -56, z: -4 };
    await truth.ok('fill', [from.x, from.y, from.z, to.x, to.y, to.z, 'stone']);
    const all: Vec3[] = [];
    for (let y = from.y; y <= to.y; y++) for (let z = from.z; z <= to.z; z++) for (let x = from.x; x <= to.x; x++) all.push({ x, y, z });
    const waited = await pollUntil(() => all.every((p) => world.blockAt(p)?.name === 'stone'), POLL_MS);
    expect(waited, `fill not fully visible: ${all.filter((p) => world.blockAt(p)?.name !== 'stone').length} of 125 missing`).toBeGreaterThanOrEqual(0);

    const t = await truth.ok<{ hash: string; count: number }>('checksum', [AREA.from.x, AREA.from.y, AREA.from.z, AREA.to.x, AREA.to.y, AREA.to.z]);
    const mine = world.checksum(AREA.from, AREA.to);
    console.log(`[world-updates] checksum over ${t.count} blocks: truth ${t.hash} model ${mine}; waited ${waited.toFixed(1)} ms for the fill`);
    expect(mine).toBe(t.hash);
  });
});
