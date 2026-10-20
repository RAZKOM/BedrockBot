// Records fixtures/<BOT_VERSION, default 1.26.51>/world-chunks.jsonl.gz (login, chunk load, a block-update burst, an item
// drop and a give) against bds-world, with the truth pack's answers inside the capture as `@truth`
// text packets, so test/unit/world/world-replay.test.ts can check the world model offline.
// Opt-in only (it rewrites a committed fixture):
//   BDS_E2E=1 WORLD_RECORD=1 pnpm --filter bot test:e2e -- world-record
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Connection } from '../../src/connection/connection.ts';
import { PacketRecorder } from '../../src/connection/recorder.ts';
import { silentLogger } from '../../src/log.ts';
import { World } from '../../src/world/index.ts';
import { E2E_TRANSPORT, E2E_VERSION } from './env.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { E2E, Truth, WORLD_CONTAINER, WORLD_TARGET, consoleCommand, pollUntil, rng, sleep } from './world-truth.ts';

const RECORD = process.env.WORLD_RECORD === '1';
const OUT = fileURLToPath(new URL(`../../../fixtures/${E2E_VERSION}/world-chunks.jsonl.gz`, import.meta.url));
/** BDS build and image, for the fixture header (env BDS_BUILD, default the 1.26.51 dev server). */
const BDS_BUILD = process.env.BDS_BUILD ?? '1.26.51.1';
const require = createRequire(import.meta.url);
const USERNAME = 'WorldFixture';

describe.skipIf(!E2E || !RECORD)(`@bds record fixtures/${E2E_VERSION}/world-chunks.jsonl.gz`, () => {
  it('records login, chunk load, update burst, item drop and give', async () => {
    const recorder = new PacketRecorder(OUT, { includeRaw: true });
    const pkg = (n: string) => (require(`${n}/package.json`) as { version: string }).version;
    recorder.record('meta', 'fixture', {
      kind: 'world-chunks',
      gameVersion: E2E_VERSION,
      chunkRadius: 10, // bedrock-protocol 3.60.1 always requests 10 (ConnectionOptions.viewDistance is not applied)
      bds: `${BDS_BUILD} (itzg/minecraft-bedrock-server:2026.10.2, flat world, ${E2E_TRANSPORT}, offline, truth pack 0.1.0)`,
      bedrockProtocol: pkg('bedrock-protocol'),
      minecraftData: pkg('minecraft-data'),
      recordedAt: new Date().toISOString(),
      note: 'truth replies are recorded as text packets; the unit replay compares the model at each reply',
    });
    const conn = new Connection({ version: E2E_VERSION, username: USERNAME, logger: silentLogger, reconnect: false, recorder });
    const world = new World(conn, { version: E2E_VERSION, logger: silentLogger });
    const truth = new Truth(conn);
    // Clean area first (not part of the interesting burst, but recorded).
    await consoleCommand(WORLD_CONTAINER, 'kill', '@e[type=item]');
    await conn.connect(WORLD_TARGET);
    await world.waitForChunks(3, { timeoutMs: 30_000 });
    expect(await pollUntil(() => world.chunks.pendingCount === 0, 10_000)).toBeGreaterThanOrEqual(0);
    await truth.ok('fill', [-12, -60, -12, 12, -50, 12, 'air']);
    await truth.ok('fill', [-12, -61, -12, 12, -61, 12, 'grass_block']);
    await truth.ok('clear', [USERNAME]);
    await sleep(500);

    // The update burst: 20 sets of oak_log / stone / chest, then a 5x5x5 fill.
    const rand = rng(20261028);
    const used = new Set<string>();
    const sets: Vec3[] = [];
    while (sets.length < 20) {
      const p = { x: Math.floor(rand() * 21) - 10, y: -60 + Math.floor(rand() * 4), z: Math.floor(rand() * 21) - 10 };
      const key = `${p.x},${p.y},${p.z}`;
      if ((Math.abs(p.x) <= 1 && Math.abs(p.z) <= 1) || used.has(key)) continue;
      used.add(key);
      sets.push(p);
      await truth.ok('set', [p.x, p.y, p.z, ['oak_log', 'stone', 'chest'][sets.length % 3]!]);
    }
    await truth.ok('fill', [3, -60, -8, 7, -56, -4, 'stone']);
    // Let every update arrive before the truth snapshots, so the replay can compare at the reply.
    await sleep(1000);
    await truth.ok('blocks', [-10, -64, -10, 10, -56, 10]);
    await truth.ok('checksum', [-12, -64, -12, 12, -55, 12]);
    for (const p of sets.slice(0, 5)) await truth.ok('block', [p.x, p.y, p.z]);

    // Entities and inventory.
    await truth.ok('spawnitem', [6.5, -60, 6.5, 'oak_log', 3]);
    await sleep(1500);
    await truth.ok('give', [USERNAME, 'oak_log', 5]);
    await sleep(500);
    await truth.ok('inv', [USERNAME]);
    await sleep(500);

    truth.dispose();
    world.dispose();
    conn.disconnect('fixture done');
    await sleep(300);
    await recorder.close();
    console.log(`[world-record] wrote ${recorder.count} packets to ${OUT}`);
    // Leave the area clean for the other suites.
    await consoleCommand(WORLD_CONTAINER, 'kill', '@e[type=item]');
    await consoleCommand(WORLD_CONTAINER, 'scriptevent', 'truth:fill', '-12', '-60', '-12', '12', '-50', '12', 'air');
    expect(recorder.count).toBeGreaterThan(300);
  }, 120_000);
});
