// e2e (tag @bds), PLAN.md task 7.12: the persistent world cache on bds-cache (generated world, seed 7).
//   loop     the bot goes round a 200 x 200 block square (teleport hops every 100 blocks, so columns
//            load behind and ahead and unload far away); the region files exist afterwards and a fresh
//            process (node src/world/cache/cli.ts checksum) reads every chunk with the same checksum as
//            the summaries the bot held in memory.
//   trees    3 trees planted in a private area are seen, the bot leaves (cache written), a new bot with
//            the same cache directory connects at spawn, far away: World.find returns the logs flagged
//            `cached` and findCachedTrees returns the 3 trees. The trees are removed afterwards.
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { findCachedTrees } from '../../src/world/cache/index.ts';
import type { BlockInfo, Vec3 } from '../../src/world/types.ts';
import {
  CACHE_CONTAINER,
  E2E,
  cacheDir,
  connectCacheBot,
  disconnectCacheBot,
  fmt,
  hop,
  landFeet,
  privateArea,
  removeDirs,
  sleep,
  standNear,
  type CacheBot,
} from './cache-truth.ts';
import { consoleCommand } from './skills-truth.ts';

const BOT_DIR = fileURLToPath(new URL('../..', import.meta.url));
const isLog = (b: BlockInfo): boolean => b.name.endsWith('_log') && !b.name.startsWith('stripped_');

describe.skipIf(!E2E)('@bds world cache: regions, reload, trees across a restart (bds-cache)', () => {
  const summary: string[] = [];
  const bots: CacheBot[] = [];

  afterAll(async () => {
    console.log(`[cache-world e2e]\n  ${summary.join('\n  ')}`);
    for (const b of bots) await disconnectCacheBot(b).catch(() => undefined);
    removeDirs();
  });

  it('writes region files while going round a 200-block loop; a fresh process reads identical summaries', async () => {
    const dir = cacheDir('loop');
    const bot = await connectCacheBot('CacheLoop', { dir, flushIntervalMs: 2000 });
    bots.push(bot);
    const a = privateArea();
    const corners: [number, number][] = [
      [0, 0],
      [100, 0],
      [200, 0],
      [200, 100],
      [200, 200],
      [100, 200],
      [0, 200],
      [0, 100],
      [0, 0],
    ];
    const t0 = performance.now();
    for (const [dx, dz] of corners) await hop(bot, a.x + dx, a.z + dz, 3);
    const hopS = (performance.now() - t0) / 1000;
    await sleep(3000); // a periodic flush runs meanwhile
    const unloaded = bot.world.chunks.stats.unloaded;
    // what the bot holds in memory: every chunk it has seen (live or remembered)
    const mem = new Map<string, string>();
    for (const { cx, cz } of bot.cache.storedChunks()) {
      const s = bot.cache.summary(cx, cz);
      if (s) mem.set(`${cx},${cz}`, s.checksum());
    }
    const st = { ...bot.cache.stats };
    const info = bot.cache.info();
    bots.splice(bots.indexOf(bot), 1);
    const tClose = performance.now();
    await disconnectCacheBot(bot); // close(): writes the live columns too
    const closeMs = performance.now() - tClose;
    const files = readdirSync(dir).filter((f) => f.endsWith('.bin'));
    const bytes = files.reduce((n, f) => n + statSync(join(dir, f)).size, 0);

    const t1 = performance.now();
    const r = spawnSync(process.execPath, ['src/world/cache/cli.ts', 'checksum', dir, '--chunks'], { cwd: BOT_DIR, encoding: 'utf8' });
    const reloadMs = performance.now() - t1;
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { chunks: number; bytes: number; checksum: string; perChunk: Record<string, string> };
    const disk = new Map(Object.entries(out.perChunk));
    let same = 0;
    const diff: string[] = [];
    for (const [k, v] of mem) {
      if (disk.get(k) === v) same++;
      else diff.push(`${k}: mem ${v} disk ${disk.get(k)}`);
    }
    summary.push(
      `loop: area ${a.x},${a.z}, 9 hops in ${hopS.toFixed(1)} s, ${st.summarized} column summaries (${(st.summarizeMs / Math.max(1, st.summarized)).toFixed(3)} ms each), ${unloaded} column unloads, ` +
        `${st.encoded} encodes (${(st.encodeMs / Math.max(1, st.encoded)).toFixed(3)} ms each, raw ${Math.round(st.rawBytes / Math.max(1, st.encoded))} B -> deflated ${Math.round(st.encodedBytes / Math.max(1, st.encoded))} B per chunk), ` +
        `${st.regionWrites} region writes (${(st.regionWriteMs / Math.max(1, st.regionWrites)).toFixed(1)} ms each, ${st.regionBytesWritten} B), close ${closeMs.toFixed(0)} ms; memory ${JSON.stringify(info)}`,
      `disk: ${files.length} region file(s) ${files.join(' ')}, ${bytes} B for ${out.chunks} chunks (${Math.round(bytes / Math.max(1, out.chunks))} B per chunk); fresh process read them in ${reloadMs.toFixed(0)} ms (incl. node start); ` +
        `aggregate checksum ${out.checksum}; ${same}/${mem.size} chunk checksums equal${diff.length ? `; differ: ${diff.slice(0, 5).join(', ')}` : ''}`,
    );
    expect(unloaded).toBeGreaterThan(100);
    expect(files.length).toBeGreaterThan(0);
    expect(mem.size).toBeGreaterThan(900);
    expect(out.chunks).toBe(mem.size);
    expect(diff).toEqual([]);
  }, 600_000);

  it('remembers trees across a restart (World.find flags them cached, findCachedTrees groups them)', async () => {
    const dir = cacheDir('trees');
    const first = await connectCacheBot('CacheTreeA', { dir });
    bots.push(first);
    let land: Vec3 | undefined;
    let area = privateArea();
    for (let i = 0; i < 6 && !land; i++) {
      area = privateArea();
      land = await standNear(first, area.x, area.z);
    }
    expect(land, 'no land found').toBeDefined();
    const L = land!;
    // three birch trees around the bot, on land, at least 5 blocks apart
    const planted: Vec3[] = [];
    const skipped: string[] = [];
    for (let i = 0; i < 48 && planted.length < 3; i++) {
      const ang = (i * 2.4) % (2 * Math.PI);
      const r = 5 + (i % 6);
      const x = L.x + Math.round(Math.cos(ang) * r);
      const z = L.z + Math.round(Math.sin(ang) * r);
      if (planted.some((p) => Math.hypot(p.x - x, p.z - z) < 5)) continue;
      const y = landFeet(first, x, z);
      if (y === undefined) {
        skipped.push(`${x},${z}: no land`);
        continue;
      }
      const rep = await first.truth.cmd('tree', [x, y, z, 5, 'birch', 1], 20_000);
      if (rep.ok) planted.push({ x, y, z });
      else skipped.push(`${x},${y},${z}: ${rep.reason ?? '?'}`);
    }
    if (planted.length < 3) summary.push(`trees: area ${area.x},${area.z} land ${fmt(L)}: planted ${planted.length}; skipped ${skipped.join('; ')}`);
    expect(planted.length).toBe(3);
    const t0 = performance.now();
    while (!planted.every((p) => first.world.blockAt(p)?.name === 'birch_log') && performance.now() - t0 < 5000) await sleep(50);
    const liveLogs = first.world.find(isLog, { origin: L, radius: 24, max: 4096, class: 'log' });
    const liveTrees = first.skills.findTrees(24, { origin: L });
    for (const p of planted) expect(first.world.blockAt(p)?.name, `planted log at ${fmt(p)}`).toBe('birch_log');
    bots.splice(bots.indexOf(first), 1);
    await disconnectCacheBot(first);

    // the restart: a new bot, the same cache directory, at the world spawn (far away)
    const second = await connectCacheBot('CacheTreeB', { dir });
    bots.push(second);
    const here = second.world.self.pos;
    const far = Math.hypot(here.x - L.x, here.z - L.z);
    expect(second.world.isLoaded(L.x >> 4, L.z >> 4)).toBe(false);
    const t1 = performance.now();
    const cachedLogs = second.world.find(isLog, { origin: L, radius: 24, max: 4096, class: 'log' });
    const findMs = performance.now() - t1;
    const t2 = performance.now();
    const trees = findCachedTrees(second.world, second.cache, L, 24);
    const treesMs = performance.now() - t2;
    // a planted tree may touch a natural birch (26-connected logs): match by its base log, not by the tree's base
    const found = planted.filter((p) => trees.some((t) => t.kind === 'birch' && t.logs.some((q) => q.x === p.x && q.y === p.y && q.z === p.z)));
    summary.push(
      `trees: area ${area.x},${area.z}, land ${fmt(L)}, planted ${planted.map(fmt).join(' ')}; before leaving: ${liveLogs.length} logs, ${liveTrees.length} trees (live) within 24; ` +
        `after the restart at ${fmt(here)} (${far.toFixed(0)} blocks away): World.find ${cachedLogs.length} logs (${cachedLogs.filter((p) => p.cached).length} flagged cached) in ${findMs.toFixed(1)} ms, ` +
        `findCachedTrees ${trees.length} trees in ${treesMs.toFixed(1)} ms, planted found ${found.length}/3`,
    );
    expect(far).toBeGreaterThan(200);
    expect(cachedLogs.length).toBe(liveLogs.length);
    expect(cachedLogs.every((p) => p.cached === true)).toBe(true);
    expect(found).toHaveLength(3);

    // clean up: remove the planted trees (the area is private, but leave it as found)
    await hop(second, L.x, L.z, 3);
    for (const p of planted) {
      await consoleCommand(CACHE_CONTAINER, 'fill', String(p.x - 2), String(p.y), String(p.z - 2), String(p.x + 2), String(p.y + 7), String(p.z + 2), 'air', 'replace', 'birch_leaves');
      await consoleCommand(CACHE_CONTAINER, 'fill', String(p.x), String(p.y), String(p.z), String(p.x), String(p.y + 4), String(p.z), 'air', 'replace', 'birch_log');
    }
  }, 600_000);
});
