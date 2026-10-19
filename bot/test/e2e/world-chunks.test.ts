// e2e (tag @bds), PLAN.md task 2.2: the chunk store agrees with the truth pack.
// Needs the bds-world container (udp/19142, flat world, truth pack deployed) and BDS_E2E=1:
//   BDS_E2E=1 pnpm --filter bot test:e2e
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Connection } from '../../src/connection/connection.ts';
import { silentLogger } from '../../src/log.ts';
import { World } from '../../src/world/index.ts';
import { typeIdOf } from '../../src/world/checksum.ts';
import { E2E, Truth, WORLD_TARGET, boxPos, decodeBlocks, leave, rng, uniqueName } from './world-truth.ts';

const SEED = Number(process.env.WORLD_SEED ?? 20261028);

describe.skipIf(!E2E)('@bds world chunks vs truth pack (bds-world)', () => {
  let conn: Connection;
  let world: World;
  let truth: Truth;

  beforeAll(async () => {
    conn = new Connection({ version: '1.26.51', username: uniqueName('WChunks'), logger: silentLogger, reconnect: false });
    world = new World(conn, { logger: silentLogger });
    truth = new Truth(conn);
    await conn.connect(WORLD_TARGET);
    // 48 blocks = 3 chunks around the spawn chunk; wait for 4 to be safe.
    await world.waitForChunks(4, { timeoutMs: 30_000 });
    // Leave the area as the flat world generated it (other tests place blocks here).
    await truth.ok('fill', [-24, -60, -24, 24, -50, 24, 'air']);
    await truth.ok('fill', [-24, -61, -24, 24, -61, 24, 'grass_block']);
    await truth.ok('fill', [-24, -63, -24, 24, -62, 24, 'dirt']);
  }, 60_000);

  afterAll(async () => {
    truth?.dispose();
    world?.dispose();
    await leave(conn);
  });

  it('decodes the flat-world layers in every loaded column within 48 blocks', () => {
    const expected: Record<number, string> = { [-64]: 'bedrock', [-63]: 'dirt', [-62]: 'dirt', [-61]: 'grass_block' };
    let checked = 0;
    for (let x = -48; x <= 48; x++) {
      for (let z = -48; z <= 48; z++) {
        if (x * x + z * z > 48 * 48) continue;
        for (let y = -64; y <= -50; y++) {
          const b = world.blockAt({ x, y, z });
          expect(b, `${x} ${y} ${z} loaded`).toBeDefined();
          expect(b?.name, `${x} ${y} ${z}`).toBe(expected[y] ?? 'air');
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100_000);
    expect(world.registry.unknownRuntimeIds.size).toBe(0);
    expect(world.chunks.stats.decodeErrors).toBe(0);
  });

  it('matches truth:blocks at 200 random positions within 48 blocks (y -64..-55), 100 %', async () => {
    const rand = rng(SEED);
    const BOXES = 5;
    const PER_BOX = 40;
    let agree = 0;
    let total = 0;
    let boxBlocks = 0;
    let boxAgree = 0;
    const mismatches: string[] = [];
    let boxes = 0;
    for (let attempt = 0; boxes < BOXES && attempt < 50; attempt++) {
      // A 20 x 10 x 20 box (4000 blocks, under the 4096 limit) fully within 48 blocks of the spawn.
      const angle = rand() * 2 * Math.PI;
      const dist = rand() * 20;
      const from = { x: Math.round(dist * Math.cos(angle)) - 10, y: -64, z: Math.round(dist * Math.sin(angle)) - 10 };
      const to = { x: from.x + 19, y: -55, z: from.z + 19 };
      const r = await truth.cmd('blocks', [from.x, from.y, from.z, to.x, to.y, to.z]);
      if (!r.ok) {
        // The server only keeps ~4 chunks around the player loaded for scripts; pick another box.
        expect(r.reason).toBe('unloaded_chunk');
        continue;
      }
      boxes++;
      const { ids, data } = decodeBlocks(r.data);
      // Every block of the box.
      ids.forEach((id, i) => {
        const p = boxPos(data.from, data.size, i);
        const b = world.blockAt(p);
        boxBlocks++;
        if (b && typeIdOf(b) === id) boxAgree++;
        else if (mismatches.length < 10) mismatches.push(`${p.x} ${p.y} ${p.z}: truth ${id} model ${b ? typeIdOf(b) : 'unloaded'}`);
      });
      // 40 random positions per box (all within 48 blocks horizontally of the spawn).
      for (let k = 0; k < PER_BOX; k++) {
        const i = Math.floor(rand() * ids.length);
        const p = boxPos(data.from, data.size, i);
        expect(Math.hypot(p.x - 0.5, p.z - 0.5)).toBeLessThanOrEqual(48);
        const b = world.blockAt(p);
        total++;
        if (b && typeIdOf(b) === ids[i]) agree++;
      }
    }
    console.log(`[world-chunks] seed ${SEED}: random positions ${agree}/${total} agree; all box blocks ${boxAgree}/${boxBlocks} agree in ${boxes} boxes`);
    expect(boxes).toBe(BOXES);
    expect(mismatches).toEqual([]);
    expect(total).toBe(200);
    expect(agree).toBe(total);
    expect(boxAgree).toBe(boxBlocks);
  });

  it('reports undefined for columns that are not loaded and loads columns as the server sends them', () => {
    expect(world.blockAt({ x: 100_000, y: -61, z: 100_000 })).toBeUndefined();
    expect(world.isLoaded(6250, 6250)).toBe(false);
    expect(world.isLoaded(0, 0)).toBe(true);
    // The store batches requests: far fewer subchunk_request packets than columns.
    const s = world.chunks.stats;
    expect(s.requestsSent).toBeLessThan(s.levelChunks);
    expect(world.chunks.loadedCount).toBeGreaterThanOrEqual(81);
  });
});
