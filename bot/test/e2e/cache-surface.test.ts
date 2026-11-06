// e2e (tag @bds), Track PC (decision 0060): the surface layer of the world cache on bds-cache.
//   walk     a bot stands in a private area (and a pumpkin is set on the ground next to it); the live
//            summaries carry per column the surface block, which matches the server's own blocks
//            (truth:blocks, scanned with the same rule) for sampled columns; the pumpkin shows.
//   map      /map.json on a health server (CACHE_HEALTH_PORT or 9930..9939) serves the names (tile
//            palette + indices, decoded with the page's own code) and their colours.
//   restart  the bot hops away (columns unload into regions) and quits (cache closed); a fresh process
//            (`cli.ts surface`) reads the same names from the region files.
// Also measures the record growth (raw and deflated, with and without the layer) and the tile growth.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { HealthServer } from '../../src/connection/health.ts';
import { mapDecodeTile, type DecodedTile } from '../../src/health/map/paint.ts';
import { mapRoutes } from '../../src/health/map/routes.ts';
import { MapJsonSchema, type MapJson } from '../../src/health/map/schema.ts';
import { assetDir } from '../../src/health/panel/icons/source.ts';
import { StateTable } from '../../src/world/cache/classes.ts';
import { CLS_SOLID } from '../../src/world/cache/types.ts';
import { decodeSummary, encodeRaw, encodeSummary } from '../../src/world/cache/summary.ts';
import { scanTop, type SurfaceColumn } from '../../src/world/cache/surface.ts';
import { CACHE_CONTAINER, E2E, cacheDir, connectCacheBot, disconnectCacheBot, hop, privateArea, removeDirs, settleChunks, sleep, standNear, type CacheBot } from './cache-truth.ts';
import { consoleCommand } from './skills-truth.ts';
import type { Vec3 } from '../../src/world/types.ts';

const BOT_DIR = fileURLToPath(new URL('../..', import.meta.url));
/** Health ports reserved for this suite: 9930 to 9939. CACHE_HEALTH_PORT pins one. */
const PORTS = process.env.CACHE_HEALTH_PORT ? [Number(process.env.CACHE_HEALTH_PORT)] : [9930, 9931, 9932, 9933, 9934, 9935, 9936, 9937, 9938, 9939];
const SAMPLES = 48;
const Y_HI = 319;
const Y_LO = -64;

interface BlocksReply {
  palette: string[];
  runs: [number, number][];
}

interface Expected { x: number; z: number; truth: { name: string; y: number; floor?: string; depth?: number } | undefined }

const same = (a: SurfaceColumn | undefined | null, b: Expected['truth']): boolean => (a ? a.name === b?.name && a.y === b.y && (a.floor ?? undefined) === b.floor : b === undefined);
const show = (a: SurfaceColumn | Expected['truth'] | undefined | null): string => (a ? `${a.name}@${a.y}${a.floor ? ` over ${a.floor} (${a.depth})` : ''}` : 'none');

describe.skipIf(!E2E)('@bds world cache: the surface layer (bds-cache)', () => {
  const summary: string[] = [];
  const bots: CacheBot[] = [];
  let server: HealthServer | undefined;

  afterAll(async () => {
    console.log(`[cache-surface e2e]\n  ${summary.join('\n  ')}`);
    await server?.stop().catch(() => undefined);
    for (const b of bots) await disconnectCacheBot(b).catch(() => undefined);
    removeDirs();
  });

  it('records the surface block per column, serves it on /map.json, and keeps it across a restart', async () => {
    const dir = cacheDir('surface');
    const bot = await connectCacheBot('CacheSurf', { dir, flushIntervalMs: 2000 });
    bots.push(bot);
    let land: Vec3 | undefined;
    for (let i = 0; i < 6 && !land; i++) {
      const a = privateArea();
      land = await standNear(bot, a.x, a.z);
    }
    expect(land, 'no land found').toBeDefined();
    const L: Vec3 = land!;
    await settleChunks(bot);
    const table = new StateTable(bot.world.registry);
    const facts = (s: number) => table.of(s);

    // a pumpkin on open ground near the bot (a solid surface block that is not leaves): the surface there
    let spot: Vec3 | undefined;
    for (let d = 2; d <= 12 && !spot; d++) {
      for (const [dx, dz] of [[d, 0], [0, d], [-d, 0], [0, -d], [d, d], [-d, -d]] as const) {
        const x = L.x + dx;
        const z = L.z + dz;
        const top = bot.cache.liveSummary(x >> 4, z >> 4)?.surfaceAt(x & 15, z & 15);
        const st = top ? bot.world.registry.stateIdOf(top.name) : undefined;
        if (top && st !== undefined && table.of(st).cls === CLS_SOLID && !top.name.endsWith('leaves')) {
          spot = { x, y: top.y + 1, z };
          break;
        }
      }
    }
    expect(spot, 'no open ground near the bot').toBeDefined();
    const pk: Vec3 = spot!;
    await bot.truth.ok('setblock', [pk.x, pk.y, pk.z, 'pumpkin']);
    const t0 = performance.now();
    let pumpkin: SurfaceColumn | undefined;
    while (performance.now() - t0 < 5000) {
      pumpkin = bot.cache.liveSummary(pk.x >> 4, pk.z >> 4)?.surfaceAt(pk.x & 15, pk.z & 15);
      if (pumpkin?.name === 'pumpkin') break;
      await sleep(100);
    }
    expect(pumpkin).toEqual({ name: 'pumpkin', y: pk.y });

    // sampled columns: the cache against the server's blocks, scanned with the same rule
    const cols: Expected[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const x = L.x + Math.round((Math.random() - 0.5) * 80);
      const z = L.z + Math.round((Math.random() - 0.5) * 80);
      if (x === pk.x && z === pk.z) continue;
      const r = await bot.truth.ok<BlocksReply>('blocks', [x, Y_LO, z, x, Y_HI, z], 20_000);
      const names: string[] = [];
      for (const [p, n] of r.runs) for (let k = 0; k < n; k++) names.push(r.palette[p]!.replace(/^minecraft:/, ''));
      const stateAt = (y: number): number => bot.world.registry.stateIdOf(names[y - Y_LO] ?? 'air') ?? -1;
      const t = scanTop(stateAt, facts, Y_HI, Y_LO);
      cols.push({ x, z, truth: t ? { name: t.name, y: t.y, ...(t.floor ? { floor: t.floor, depth: t.depth } : {}) } : undefined });
    }
    const live = cols.map((c) => bot.cache.summary(c.x >> 4, c.z >> 4)?.surfaceAt(c.x & 15, c.z & 15));
    const liveBad = cols.filter((c, i) => !same(live[i], c.truth)).map((c) => `${c.x},${c.z}: cache ${show(live[cols.indexOf(c)])} truth ${show(c.truth)}`);
    const names = new Map<string, number>();
    for (const c of cols) if (c.truth) names.set(c.truth.name, (names.get(c.truth.name) ?? 0) + 1);
    summary.push(`area ${L.x},${L.z} (feet y ${L.y}): ${cols.length} sampled columns, ${cols.length - liveBad.length} match the truth live; names ${JSON.stringify(Object.fromEntries(names))}${liveBad.length ? `; differ: ${liveBad.slice(0, 6).join('; ')}` : ''}`);
    expect(cols.length).toBeGreaterThanOrEqual(SAMPLES - 2);
    expect(liveBad.length, liveBad.join('\n')).toBeLessThanOrEqual(Math.floor(cols.length * 0.05)); // grass grows, water flows: a few may move

    // record size with and without the layer (the live summaries now)
    let raw = 0;
    let def = 0;
    let rawOld = 0;
    let defOld = 0;
    let n = 0;
    let liquidCols = 0;
    let namesMin = Infinity;
    let namesMax = 0;
    let namesSum = 0;
    for (const { cx, cz } of bot.cache.storedChunks()) {
      const s = bot.cache.liveSummary(cx, cz);
      if (!s?.surf) continue;
      raw += encodeRaw(s).length;
      def += encodeSummary(s).length;
      const old = decodeSummary(encodeSummary(s));
      old.surf = undefined;
      rawOld += encodeRaw(old).length;
      defOld += encodeSummary(old).length;
      for (let i = 0; i < 256; i++) if (s.surf.top.depth[i]! > 0) liquidCols++;
      const k = s.surf.compact().names.length;
      namesMin = Math.min(namesMin, k);
      namesMax = Math.max(namesMax, k);
      namesSum += k;
      n++;
    }
    const st = bot.cache.stats;
    summary.push(
      `records over ${n} live chunks (${liquidCols} liquid columns, ${namesMin} to ${namesMax} surface names per chunk, mean ${(namesSum / n).toFixed(1)}): raw ${Math.round(rawOld / n)} -> ${Math.round(raw / n)} B (+${Math.round((raw - rawOld) / n)}), deflated ${Math.round(defOld / n)} -> ${Math.round(def / n)} B (+${Math.round((def - defOld) / n)}, ${(((def - defOld) / defOld) * 100).toFixed(1)} %); ` +
        `summarize ${(st.summarizeMs / Math.max(1, st.summarized)).toFixed(3)} ms per column over ${st.summarized}`,
    );

    // /map.json on a health server
    const metrics = { snapshot: () => ({ state: 'spawned', uptimeS: 1, rates: { correctionsPerMin: 0 }, reconnects: 0, kicks: { byReason: {} }, counters: {}, gameVersion: 'x' }) };
    const routes = mapRoutes({ world: bot.world, cache: bot.cache, server: 'cache-surface' });
    let port = 0;
    for (const p of PORTS) {
      const s = new HealthServer({ port: p, metrics: metrics as never, routes });
      try {
        port = await s.start();
        server = s;
        break;
      } catch {
        await s.stop().catch(() => undefined);
      }
    }
    expect(port, 'no free health port in 9930..9939').not.toBe(0);
    const cx = L.x >> 4;
    const cz = L.z >> 4;
    const tMap = performance.now();
    const res = await fetch(`http://127.0.0.1:${port}/map.json?r=4&cx=${cx}&cz=${cz}`);
    const text = await res.text();
    const gzBytes = gzipSync(text, { level: 6 }).length;
    const mapMs = performance.now() - tMap;
    const j: MapJson = MapJsonSchema.parse(JSON.parse(text));
    const decoded = new Map<string, DecodedTile>(j.tiles.map((t) => [`${t.cx},${t.cz}`, mapDecodeTile(t, j.palette)]));
    const mapBad: string[] = [];
    for (const c of cols) {
      const d = decoded.get(`${c.x >> 4},${c.z >> 4}`);
      if (!d) continue;
      const i = ((c.z & 15) << 4) | (c.x & 15);
      const got = d.top?.names[i] ?? undefined;
      const want = bot.cache.summary(c.x >> 4, c.z >> 4)?.surfaceAt(c.x & 15, c.z & 15)?.name;
      if (got !== want) mapBad.push(`${c.x},${c.z}: map ${got} cache ${want}`);
    }
    const coloured = j.palette.filter((e) => e.rgb !== null).length;
    let grow = 0;
    for (const t of j.tiles) {
      const { s: _s, p: _p, sy: _sy, f: _f, d: _d, u: _u, ...old } = t;
      grow += JSON.stringify(t).length - JSON.stringify(old).length;
    }
    const tilesWithSy = j.tiles.filter((t) => t.sy).length;
    const tilesWithLiquid = j.tiles.filter((t) => t.f).length;
    summary.push(
      `/map.json r=4 on port ${port}: ${j.tiles.length} tiles, ${text.length} B (gzip ${gzBytes} B, ${res.headers.get('content-encoding') ?? 'identity'} on the wire) in ${mapMs.toFixed(0)} ms (first request, colours read); palette ${j.palette.length} names, ${coloured} coloured; ` +
        `surface fields +${Math.round(grow / Math.max(1, j.tiles.length))} B per tile (sy in ${tilesWithSy}, floor/depth in ${tilesWithLiquid}); ${mapBad.length} sampled columns differ from the cache`,
    );
    expect(j.tiles.length).toBeGreaterThan(40);
    expect(j.tiles.every((t) => t.s !== undefined)).toBe(true);
    expect(mapBad).toEqual([]);
    if (assetDir()) expect(coloured).toBeGreaterThanOrEqual(Math.ceil(j.palette.length * 0.8));
    const pkTile = decoded.get(`${pk.x >> 4},${pk.z >> 4}`)!;
    expect(pkTile.top!.names[((pk.z & 15) << 4) | (pk.x & 15)]).toBe('pumpkin');
    const t1 = performance.now();
    const inc = await fetch(`http://127.0.0.1:${port}/map.json?r=4&cx=${cx}&cz=${cz}`);
    await inc.text();
    summary.push(`second /map.json r=4: ${(performance.now() - t1).toFixed(0)} ms (colours cached)`);

    // the pumpkin goes again: the live surface follows the block update
    await consoleCommand(CACHE_CONTAINER, 'setblock', String(pk.x), String(pk.y), String(pk.z), 'air');
    const t3 = performance.now();
    let after: SurfaceColumn | undefined = pumpkin;
    while (performance.now() - t3 < 5000 && after?.name === 'pumpkin') {
      await sleep(100);
      after = bot.cache.liveSummary(pk.x >> 4, pk.z >> 4)?.surfaceAt(pk.x & 15, pk.z & 15);
    }
    summary.push(`pumpkin set: surface ${show(pumpkin)}; removed: surface ${show(after)}`);
    expect(after?.name).not.toBe('pumpkin');
    expect(after!.y).toBeLessThan(pk.y);

    // restart: away (unload), quit (close), a fresh process reads the regions
    await hop(bot, L.x + 600, L.z + 600, 2);
    await settleChunks(bot);
    bots.splice(bots.indexOf(bot), 1);
    await disconnectCacheBot(bot);
    const byChunk = new Map<string, Expected[]>();
    for (const c of cols) {
      const k = `${c.x >> 4} ${c.z >> 4}`;
      byChunk.set(k, [...(byChunk.get(k) ?? []), c]);
    }
    const pkExpect: Expected = { x: pk.x, z: pk.z, truth: undefined };
    byChunk.set(`${pk.x >> 4} ${pk.z >> 4}`, [...(byChunk.get(`${pk.x >> 4} ${pk.z >> 4}`) ?? []), pkExpect]);
    const diskBad: string[] = [];
    let diskOk = 0;
    const t2 = performance.now();
    for (const [k, list] of byChunk) {
      const [qx, qz] = k.split(' ');
      const r = spawnSync(process.execPath, ['src/world/cache/cli.ts', 'surface', dir, qx!, qz!], { cwd: BOT_DIR, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout) as { surface: boolean; columns: { x: number; z: number; top: SurfaceColumn | null }[] };
      expect(out.surface).toBe(true);
      for (const c of list) {
        const col = out.columns.find((q) => q.x === c.x && q.z === c.z);
        const was = c === pkExpect ? after : live[cols.indexOf(c)];
        if (same(col?.top, was ? { name: was.name, y: was.y, ...(was.floor ? { floor: was.floor } : {}) } : undefined)) diskOk++;
        else diskBad.push(`${c.x},${c.z}: disk ${show(col?.top)} live ${show(was)}`);
      }
    }
    summary.push(`restart: ${byChunk.size} chunks read by fresh processes in ${(performance.now() - t2).toFixed(0)} ms; ${diskOk} columns equal to what the bot held${diskBad.length ? `; differ: ${diskBad.slice(0, 6).join('; ')}` : ''}`);
    expect(diskBad).toEqual([]);
  }, 600_000);
});
