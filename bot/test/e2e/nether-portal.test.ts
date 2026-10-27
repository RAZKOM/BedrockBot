// e2e (tag @bds), wave 10 Track AT (docs/nether.md): portal travel on bds-nether. One afk-task bot
// (walking, the CLI's wiring, in-memory settings and waypoints, a world cache in a temp directory) on
// a stone platform at y 150 of a random far overworld area, with a lit obsidian portal (truth:portal)
// 3 blocks east of it:
//   nether     `!nether`: the bot walks into the portal, the server moves it (truth:dimension nether),
//              the world model holds Nether chunks and none of the overworld entities, the cache writes
//              the Nether's regions to <dir>/dim1, the `portal` and `nether_portal` waypoints exist
//   top        `!top` in the Nether: the refusal (no surface under the bedrock ceiling)
//   night      midnight in the Nether with a shelter set: the night process never takes control and the
//              bot does not move
//   overworld  `!overworld`: back through the paired portal, next to the overworld portal
// Env: NETHER_BDS_HOST / NETHER_BDS_PORT / NETHER_BDS_CONTAINER (nether-truth.ts), NETHER_AREA,
// NETHER_VERBOSE=1.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { waypointStoreOf } from '../../src/chat/commands-nav.ts';
import type { Vec3 } from '../../src/connection/types.ts';
import { dimTeleport, E2E, hdist, netherCmd, prepareServer, privateArea, sleep, startNetherBot, truthDimension, truthRetry, type NetherBot } from './nether-truth.ts';

describe.skipIf(!E2E)('@bds nether: portal travel and the dimension change (Track AT)', () => {
  const notes: string[] = [];
  let bot: NetherBot | undefined;
  let area: { x: number; z: number };
  let portal: Vec3;
  let overworldEntities: bigint[] = [];

  beforeAll(async () => {
    await prepareServer();
    area = privateArea();
    const shelter = { x: area.x, y: 151, z: area.z };
    bot = await startNetherBot('Portal', { shelter });
    const b = bot;
    // a platform high in the air (nothing of the generated terrain in the way) and the portal on it
    await dimTeleport(b, 'overworld', { x: area.x + 0.5, y: 152, z: area.z + 0.5 }, -90).catch(() => undefined);
    await truthRetry(b, 'fill', [area.x - 6, 150, area.z - 6, area.x + 6, 150, area.z + 6, 'stone']);
    await truthRetry(b, 'fill', [area.x - 6, 151, area.z - 6, area.x + 6, 156, area.z + 6, 'air']);
    await truthRetry(b, 'portal', ['overworld', area.x + 3, 150, area.z - 1, 'z']);
    portal = { x: area.x + 3, y: 151, z: area.z };
    await dimTeleport(b, 'overworld', { x: area.x + 0.5, y: 151, z: area.z + 0.5 }, -90);
    // two passive mobs penned behind the bot: entities of the overworld the reset must drop
    await truthRetry(b, 'fill', [area.x - 6, 151, area.z - 6, area.x - 4, 152, area.z - 4, 'glass']);
    await truthRetry(b, 'fill', [area.x - 5, 151, area.z - 5, area.x - 5, 152, area.z - 5, 'air']);
    await b.truth.ok('summon', ['minecraft:pig', area.x - 4.5, 151, area.z - 4.5, 'nether_portal_e2e']);
    await b.truth.ok('summon', ['minecraft:cow', area.x - 4.5, 151, area.z - 4.5, 'nether_portal_e2e']);
    await sleep(1500);
    overworldEntities = [...b.built.mobility!.world.entities.keys()];
    expect(overworldEntities.length).toBeGreaterThanOrEqual(2);
    notes.push(`area ${area.x} ${area.z}, portal ${portal.x} ${portal.y} ${portal.z}, ${overworldEntities.length} overworld entities tracked`);
  }, 180_000);

  afterAll(async () => {
    await netherCmd('time', 'set', 'noon').catch(() => undefined);
    await bot?.truth.cmd('killmobs', ['nether_portal_e2e']).catch(() => undefined);
    console.log(`[nether-portal] ${notes.join('\n[nether-portal] ')}`);
    await bot?.stop();
  }, 60_000);

  it('!nether: walks into the portal, changes the dimension, resets the world model and caches the Nether separately', async () => {
    const b = bot!;
    const world = b.built.mobility!.world;
    const columnsBefore = world.chunks.loadedCount;
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!nether');
    const end = await b.reply((s) => s.startsWith('in the nether') || s.startsWith('nether:'), from, 120_000);
    notes.push(`!nether: "${end}" after ${((Date.now() - t0) / 1000).toFixed(1)} s; ${columnsBefore} overworld columns dropped (watcher ${world.dimensions.stats.lastColumnsDropped}), server ack after ${world.dimensions.stats.lastAckMs} ms`);
    expect(end).toMatch(/^in the nether at the portal /);
    const t = await truthDimension(b);
    expect(t.dimension).toBe('nether');
    expect(world.self.dimension).toBe(1);
    expect(world.chunks.dimension).toBe(1);
    await world.waitForChunks(2, { timeoutMs: 30_000 });
    expect(world.chunks.loadedCount).toBeGreaterThan(20);
    const stale = overworldEntities.filter((id) => world.entities.has(id));
    expect(stale).toEqual([]);
    // the waypoints of both sides
    const store = waypointStoreOf(b.task)!;
    const ow = store.get('portal');
    const nw = store.get('nether_portal');
    notes.push(`waypoints: portal ${ow?.x} ${ow?.y} ${ow?.z}, nether_portal ${nw?.x} ${nw?.y} ${nw?.z}; truth position ${t.location.x.toFixed(1)} ${t.location.y.toFixed(1)} ${t.location.z.toFixed(1)}`);
    expect(ow && hdist(ow, portal) <= 1.5 && ow.y === portal.y).toBe(true);
    expect(nw).toBeDefined();
    expect(hdist(nw!, t.location)).toBeLessThan(4);
    // the cache writes the Nether to its own directory
    await b.cache.flush();
    const dir = join(b.cacheDir, 'dim1');
    expect(existsSync(dir)).toBe(true);
    const files = readdirSync(dir);
    notes.push(`cache: ${files.length} files in dim1 (${files.slice(0, 3).join(', ')})`);
    expect(files.length).toBeGreaterThan(0);
  }, 180_000);

  it('!top in the Nether: refused with the reason', async () => {
    const b = bot!;
    const from = b.said.length;
    await b.command('!top');
    const r = await b.reply((s) => s.startsWith('top'), from);
    notes.push(`!top: "${r}"`);
    expect(r).toMatch(/^top: there is no surface in the Nether/);
  }, 30_000);

  it('night safety does not start in the Nether at night', async () => {
    const b = bot!;
    const start = b.task.position()!;
    await netherCmd('time', 'set', 'midnight');
    const night = b.processes.find('night')[0]!;
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      expect(night.wants()).toBe(false);
      expect(b.processes.active?.name).not.toBe('night');
    }
    const end = b.task.position()!;
    notes.push(`night in the Nether: night process stayed off for 5 s, moved ${hdist(start, end).toFixed(2)} blocks`);
    expect(hdist(start, end)).toBeLessThan(1.5);
    await netherCmd('time', 'set', 'noon');
  }, 30_000);

  it('!overworld: back through the paired portal', async () => {
    const b = bot!;
    const world = b.built.mobility!.world;
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!overworld');
    const end = await b.reply((s) => s.startsWith('in the overworld') || s.startsWith('overworld:'), from, 120_000);
    notes.push(`!overworld: "${end}" after ${((Date.now() - t0) / 1000).toFixed(1)} s; server ack after ${world.dimensions.stats.lastAckMs} ms`);
    expect(end).toMatch(/^in the overworld at the portal /);
    const t = await truthDimension(b);
    expect(t.dimension).toBe('overworld');
    expect(world.self.dimension).toBe(0);
    expect(hdist(t.location, { x: portal.x + 0.5, z: portal.z + 0.5 })).toBeLessThan(4);
    const store = waypointStoreOf(b.task)!;
    expect(store.get('portal')).toBeDefined();
    expect(store.get('nether_portal')).toBeDefined();
  }, 180_000);
});
