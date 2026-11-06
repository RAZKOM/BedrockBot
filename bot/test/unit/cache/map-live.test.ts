// Decision 0062 (docs/map.md "Wire"): the map screen's server side, health/map/live.ts, on a replayed
// world with a real cache. GET /api/map/tiles (compact tiles, the window registered, the palette once
// per client, live=1), the `map` topic over a real StreamHub and SSE (only changed tiles of registered
// windows, `from` chaining, a dimension change resets, nothing while no client streams), the Y-slice
// (cache classes everywhere, block names for loaded columns), the routes (405, 400, gzip), and the
// payload sizes against /map.json.
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { HealthServer } from '../../../src/connection/health.ts';
import { Metrics } from '../../../src/connection/metrics.ts';
import { MapBuilder, type MapColourSource } from '../../../src/health/map/data.ts';
import { MapLive } from '../../../src/health/map/live.ts';
import { mapDecodeSlice, mapDecodeTile } from '../../../src/health/map/paint.ts';
import { CompactTileSchema, SliceTileSchema, type CompactTileJson } from '../../../src/health/map/schema.ts';
import { PANEL_BUDGETS } from '../../../src/health/panel/budgets.ts';
import { StreamHub } from '../../../src/health/panel/stream.ts';
import { silentLogger } from '../../../src/log.ts';
import { onFetchablePort, openSse, type SseStream } from '../health/panel-sse.ts';
import { cleanMapWorlds, rid, world3x3 } from './map-world.ts';

const COLOURS: MapColourSource = { peek: (n) => (n === 'water' ? 0x2040c0 : n === 'stone' ? 0x808080 : null), load: () => Promise.resolve() };
const live: MapLive[] = [];
const hubs: StreamHub[] = [];
const servers: HealthServer[] = [];
const streams: SseStream[] = [];
afterEach(async () => {
  for (const s of streams.splice(0)) s.close();
  for (const m of live.splice(0)) m.stop();
  for (const h of hubs.splice(0)) h.close();
  for (const s of servers.splice(0)) await s.stop();
  cleanMapWorlds();
});

function setup() {
  const w = world3x3();
  const source = { world: w.world, cache: w.cache, server: 'test', colours: COLOURS, taskStatus: () => ({ home: [1, -48, 2], waypoints: { mine: { x: 7, y: -48, z: 8 } } }) };
  const builder = new MapBuilder(source);
  const hub = new StreamHub({ log: silentLogger });
  hubs.push(hub);
  const map = new MapLive({ hub, builder, source, colours: COLOURS, tickMs: 3_600_000 });
  live.push(map);
  return { ...w, hub, map, builder };
}

async function serve(hub: StreamHub, map: MapLive): Promise<string> {
  const { server, port } = await onFetchablePort(
    () => {
      const s = new HealthServer({ port: 0, metrics: new Metrics(), log: silentLogger });
      s.use(hub.route());
      s.use(map.route());
      return s;
    },
    (s) => s.start(),
    (s) => s.stop(),
  );
  servers.push(server);
  return `http://127.0.0.1:${port}`;
}

const q = (o: Record<string, string | number>) => new URLSearchParams(Object.entries(o).map(([k, v]): [string, string] => [k, String(v)]));

describe('GET /api/map/tiles (MapLive.tilesAnswer)', () => {
  it('compact tiles of the window, the palette from what the client has, the window registered by cid', async () => {
    const { map } = setup();
    const a = await map.tilesAnswer(q({ cid: 'c1', r: 1, cx: 0, cz: 0, pal: 0 }));
    expect(a.tiles).toHaveLength(9);
    for (const t of a.tiles) expect(() => CompactTileSchema.parse(t)).not.toThrow();
    expect(a.window).toEqual({ cx0: -1, cz0: -1, cx1: 1, cz1: 1 });
    expect(map.windowCount()).toBe(1);
    expect(a.palFrom).toBe(0);
    const names = a.palette.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['stone', 'water']));
    expect(a.palette.find((p) => p.name === 'water')!.rgb).toBe('#2040c0');
    // the compact heights: one base and u8 offsets; the surface y equals the height here (no `sd`)
    const t = a.tiles.find((x) => x.cx === 1 && x.cz === 0)!;
    expect(t.y).toBeUndefined();
    expect(typeof t.yb).toBe('number');
    const dec = mapDecodeTile(t, a.palette);
    expect(dec.ys[0]).toBe(-49);
    expect(dec.top?.names[0]).toBe('water');
    expect(dec.top?.names[4]).toBe('stone');
    // the palette is sent once: a client that has it gets none, the same tiles
    const again = await map.tilesAnswer(q({ cid: 'c1', r: 1, cx: 0, cz: 0, pal: a.palette.length }));
    expect(again.palette).toEqual([]);
    expect(again.palFrom).toBe(a.palette.length);
    // incremental: since + win = only the tiles that changed in the old window
    const inc = await map.tilesAnswer(q({ cid: 'c1', r: 1, cx: 0, cz: 0, pal: a.palette.length, since: a.rev, win: '-1,-1,1,1' }));
    expect(inc.tiles).toEqual([]);
    // live=1 (a page without the stream): the overlays come along
    const withLive = await map.tilesAnswer(q({ cid: 'c1', r: 1, live: 1 }));
    expect(withLive.live?.bot).toEqual([4.5, -48, 4.5, 0]);
    expect(withLive.live?.wps).toEqual([['mine', 7, -48, 8]]);
    expect(withLive.live?.home).toEqual([1, -48, 2]);
    expect(Object.values(withLive.live!.ents)).toEqual([['hostile', 'zombie', 10, -48, 3]]);
    expect(a.live).toBeUndefined();
    // a bad cid registers nothing; at most 8 windows are kept
    await map.tilesAnswer(q({ cid: '../x', r: 1 }));
    expect(map.windowCount()).toBe(1);
    for (let i = 0; i < 12; i++) await map.tilesAnswer(q({ cid: `w${i}`, r: 1 }));
    expect(map.windowCount()).toBe(8);
  });

  it('payload: the compact answer is smaller than /map.json for the same window (raw and gzip)', async () => {
    const { map, builder } = setup();
    for (const r of [1, 4]) {
      const legacy = JSON.stringify(builder.build({ r }));
      const compact = JSON.stringify(await map.tilesAnswer(q({ r, pal: 0 })));
      expect(compact.length).toBeLessThan(legacy.length);
      expect(gzipSync(compact).length).toBeLessThan(gzipSync(legacy).length);
      expect(compact.length).toBeLessThan(PANEL_BUDGETS.mapFetch);
    }
  });
});

describe('the map topic (MapLive.tick over a real hub and SSE)', () => {
  it('sends the changed tiles of the registered windows, chained by from / rev; a dimension change resets; quiet without clients', async () => {
    const { src, world, map, hub } = setup();
    // no client streams: the tick sends nothing and moves on (a late client does not get a backlog)
    await map.tilesAnswer(q({ cid: 'c1', r: 1, cx: 0, cz: 0, pal: 0 }));
    src.emit('update_block', { position: { x: 3, y: -40, z: 3 }, block_runtime_id: rid('stone'), flags: {}, layer: 0 });
    expect(await map.tick()).toBeUndefined();
    const base = await serve(hub, map);
    const s = await openSse(`${base}/api/stream?topics=map`);
    streams.push(s);
    await s.next('hello');
    expect(await map.tick()).toBeUndefined(); // nothing changed since
    const first = await map.tilesAnswer(q({ cid: 'c1', r: 1, cx: 0, cz: 0, pal: 0 }));
    src.emit('update_block', { position: { x: 20, y: -40, z: 3 }, block_runtime_id: rid('stone'), flags: {}, layer: 0 });
    const m = await map.tick();
    expect(m?.tiles?.map((t) => `${t.cx},${t.cz}`)).toEqual(['1,0']);
    expect(m!.from).toBeLessThanOrEqual(first.rev);
    expect(m!.rev).toBeGreaterThan(first.rev);
    const got = JSON.parse((await s.next('map')).data) as { from: number; rev: number; tiles: CompactTileJson[] };
    expect(got.rev).toBe(m!.rev);
    expect(got.tiles[0]!.cx).toBe(1);
    // the next message starts where this one ended
    src.emit('update_block', { position: { x: -5, y: -40, z: -5 }, block_runtime_id: rid('stone'), flags: {}, layer: 0 });
    const m2 = await map.tick();
    expect(m2!.from).toBe(m!.rev);
    expect(m2!.tiles?.map((t) => `${t.cx},${t.cz}`)).toEqual(['-1,-1']);
    expect(JSON.parse((await s.next('map')).data)).toMatchObject({ from: m!.rev, rev: m2!.rev });
    // a change outside every window is not sent (the rev still moves)
    src.emit('network_chunk_publisher_update', { coordinates: { x: 8, y: 0, z: 8 }, radius: 32, saved_chunks: [] });
    // the dimension changes: reset (the page fetches its window again)
    world.self.dimension = 1;
    const r = await map.tick();
    expect(r).toMatchObject({ dim: 1, reset: true });
    expect(map.stats.maxMessage).toBeLessThan(PANEL_BUDGETS.mapMessage);
  });

  it('the map-live topic is a state topic: a snapshot of the overlays on connect', async () => {
    const { map, hub } = setup();
    const base = await serve(hub, map);
    const s = await openSse(`${base}/api/stream?topics=map-live`);
    streams.push(s);
    const snap = JSON.parse((await s.next('map-live')).data) as { snap: { bot: number[]; trail: unknown[]; wps: unknown[] } };
    expect(snap.snap.bot).toEqual([4.5, -48, 4.5, 0]);
    expect(snap.snap.wps).toEqual([['mine', 7, -48, 8]]);
    expect(JSON.stringify(snap.snap).length).toBeLessThan(PANEL_BUDGETS.mapLive);
  });
});

describe('GET /api/map/slice and the routes', () => {
  it('the classes at y for every cached column and the block names of loaded columns', async () => {
    const { map } = setup();
    const a = await map.sliceAnswer(q({ y: -49, r: 1, cx: 0, cz: 0, pal: 0 }));
    expect(a.tiles).toHaveLength(9);
    for (const t of a.tiles) expect(() => SliceTileSchema.parse(t)).not.toThrow();
    const t = mapDecodeSlice(a.tiles.find((x) => x.cx === 1 && x.cz === 0)!, a.palette);
    expect(t.live).toBe(true);
    expect([t.cls[0], t.cls[4]]).toEqual([2, 1]); // water, stone
    expect([t.names?.[0], t.names?.[4]]).toEqual(['water', 'stone']);
    const air = mapDecodeSlice((await map.sliceAnswer(q({ y: -40, r: 0, cx: 0, cz: 0, pal: a.palette.length }))).tiles[0]!, a.palette);
    expect(air.cls.every((c) => c === 0)).toBe(true);
    expect(air.names?.every((n) => n === null)).toBe(true);
    await expect(map.sliceAnswer(q({ r: 1 }))).rejects.toThrow(/y must be a number/);
  });

  it('GET only, 400 for a bad slice, gzip when asked and large enough', async () => {
    const { map, hub } = setup();
    const base = await serve(hub, map);
    expect((await fetch(`${base}/api/map/tiles`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/api/map/slice?r=1`)).status).toBe(400);
    const res = await fetch(`${base}/api/map/tiles?r=4&pal=0`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(((await res.json()) as { tiles: unknown[] }).tiles).toHaveLength(9);
    expect((await fetch(`${base}/api/map/slice?y=-49&r=1`)).status).toBe(200);
  });
});
