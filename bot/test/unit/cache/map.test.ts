// Debug map (PLAN.md task 7.15, Track T): /map.json against its zod schema, tiles, incremental
// updates (since / win), status shapes (path, goal, home, waypoints), and the routes on the health server.
import { afterEach, describe, expect, it } from 'vitest';
import { HealthServer } from '../../../src/connection/health.ts';
import { asWaypoints, buildWithColours, MapBuilder, parseMapQuery, type MapColourSource } from '../../../src/health/map/data.ts';
import { mapDecodeTile, mapDescribe } from '../../../src/health/map/paint.ts';
import { MAP_PAGE } from '../../../src/health/map/page.ts';
import { mapRoutes } from '../../../src/health/map/routes.ts';
import { MapJsonSchema } from '../../../src/health/map/schema.ts';
import { onFetchablePort } from '../health/panel-sse.ts';
import { cleanMapWorlds, rid, world3x3 } from './map-world.ts'; // shared with map-live.test.ts (decision 0062)

afterEach(cleanMapWorlds);

describe('/map.json', () => {
  it('validates against the schema with tiles, bot, entities, path, goal, home and waypoints', () => {
    const { world, cache } = world3x3();
    const b = new MapBuilder({
      world,
      cache,
      server: '127.0.0.1:19184',
      skillsStatus: () => ({
        busy: true,
        running: 'goto',
        lastGoto: { goal: { type: 'block', p: { x: 30, y: -48, z: 4 } }, plans: [{}, {}], path: [{ x: 4, y: -48, z: 4 }, { x: 5, y: -48, z: 4, feet: -48 }] },
      }),
      taskStatus: () => ({ home: [1, -48, 2], waypoints: { mine: { x: 7, y: -48, z: 8 }, base: [0, -48, 0] } }),
    });
    const j = b.build({ r: 2 });
    expect(() => MapJsonSchema.parse(j)).not.toThrow();
    expect(j.tiles).toHaveLength(9);
    expect(j.window).toEqual({ cx0: -2, cz0: -2, cx1: 2, cz1: 2 });
    const t = j.tiles.find((x) => x.cx === 1 && x.cz === 0)!;
    expect(t.live).toBe(true);
    const ys = new Int16Array(new Uint8Array(Buffer.from(t.y, 'base64')).buffer);
    const cs = Buffer.from(t.c, 'base64');
    expect(ys[0]).toBe(-49);
    expect(cs[0]! & 3).toBe(2); // water at local (0, 0) of chunk (1, 0)
    expect((cs[1]! >> 0) & 3).toBe(1); // local (4, 0): stone
    expect(j.entities).toEqual([{ id: '5', type: 'zombie', kind: 'hostile', x: 10, y: -48, z: 3 }]);
    expect(j.nav).toMatchObject({ busy: true, running: 'goto', goal: { x: 30, y: -48, z: 4 }, plans: 2, result: 'running' });
    expect(j.nav.path).toHaveLength(2);
    expect(j.home).toEqual({ x: 1, y: -48, z: 2 });
    expect(j.waypoints.map((w) => w.name).sort()).toEqual(['base', 'mine']);
    expect(j.cache?.live).toBe(9);
    expect(j.bot).toMatchObject({ x: 4.5, z: 4.5 });
  });

  it('sends only changed tiles inside the previous window, all tiles outside it', () => {
    const { src, world, cache } = world3x3();
    const b = new MapBuilder({ world, cache });
    const first = b.build({ r: 1 });
    expect(first.tiles).toHaveLength(9);
    const again = b.build({ r: 1, since: first.rev, win: first.window });
    expect(again.tiles).toHaveLength(0);
    src.emit('update_block', { position: { x: 3, y: -40, z: 3 }, block_runtime_id: rid('stone'), flags: {}, layer: 0 });
    const changed = b.build({ r: 1, since: again.rev, win: again.window });
    expect(changed.tiles.map((x) => `${x.cx},${x.cz}`)).toEqual(['0,0']);
    const moved = b.build({ r: 1, cx: 1, cz: 0, since: changed.rev, win: changed.window });
    expect(moved.tiles.map((x) => `${x.cx},${x.cz}`).sort()).toEqual([]); // the new column (2, *) has no data
    // remembered (unloaded) tiles are dimmed on the page: live false
    src.emit('network_chunk_publisher_update', { coordinates: { x: 1600, y: 0, z: 0 }, radius: 32, saved_chunks: [] });
    const cached = b.build({ r: 1, cx: 0, cz: 0 });
    expect(cached.tiles).toHaveLength(9);
    expect(cached.tiles.every((x) => !x.live)).toBe(true);
    expect(() => MapJsonSchema.parse(cached)).not.toThrow();
  });

  it('works without a world or cache, and rejects bad shapes', () => {
    const j = new MapBuilder({}).build();
    expect(() => MapJsonSchema.parse(j)).not.toThrow();
    expect(j.tiles).toEqual([]);
    expect(j.bot).toBeNull();
    expect(MapJsonSchema.safeParse({ ...j, v: 2 }).success).toBe(false);
    expect(MapJsonSchema.safeParse({ ...j, tiles: [{ cx: 0, cz: 0, live: true, rev: 1, updatedAt: 0, y: 'abc', c: '' }] }).success).toBe(false);
    expect(MapJsonSchema.safeParse({ ...j, extra: 1 }).success).toBe(false);
  });

  it('parses queries and waypoint shapes', () => {
    expect(parseMapQuery(new URLSearchParams('r=8&cx=3&cz=-2&since=17&win=1,2,3,4'))).toEqual({ r: 8, cx: 3, cz: -2, since: 17, win: { cx0: 1, cz0: 2, cx1: 3, cz1: 4 } });
    expect(parseMapQuery(new URLSearchParams('r=x&win=1,2'))).toEqual({});
    expect(asWaypoints([{ name: 'a', x: 1, y: 2, z: 3 }, { name: 'b', pos: [4, 5, 6] }, { name: 'c' }, 7])).toEqual([
      { name: 'a', x: 1, y: 2, z: 3 },
      { name: 'b', x: 4, y: 5, z: 6 },
    ]);
    expect(asWaypoints({ home: { p: { x: 1, y: 2, z: 3 } } })).toEqual([{ name: 'home', x: 1, y: 2, z: 3 }]);
    expect(asWaypoints(undefined)).toEqual([]);
  });
});

describe('/map.json surface layer (Track PC)', () => {
  /** Colours of a fake package: computed on load, after a tick. */
  function fakeColours(table: Record<string, number | null>): MapColourSource & { loads: string[][] } {
    const done = new Map<string, number | null>();
    const loads: string[][] = [];
    return {
      loads,
      peek: (n) => done.get(n),
      load: async (names) => {
        const list = [...names];
        loads.push(list);
        await new Promise((r) => setTimeout(r, 5));
        for (const n of list) done.set(n, table[n] ?? null);
      },
    };
  }

  it('tiles carry the surface names (palette + indices), floor and depth only where there is a liquid, sy only when it differs', () => {
    const { world, cache } = world3x3();
    const j = new MapBuilder({ world, cache }).build({ r: 1 });
    expect(() => MapJsonSchema.parse(j)).not.toThrow();
    expect(j.palette.map((e) => e.name).sort()).toEqual(['stone', 'water']);
    expect(j.palette.every((e) => e.rgb === null)).toBe(true); // no colour source
    const plain = j.tiles.find((t) => t.cx === 0 && t.cz === 0)!;
    const wet = j.tiles.find((t) => t.cx === 1 && t.cz === 0)!;
    expect(plain.s).toBeDefined();
    expect(plain.sy).toBeUndefined(); // stone at the top height everywhere
    expect(plain.f).toBeUndefined();
    expect(wet.f).toBeDefined();
    expect(wet.d).toBeDefined();
    expect(wet.u).toBeUndefined();
    // decoded with the page's own code: the same as the cache
    const dec = mapDecodeTile(wet, j.palette);
    expect(dec.top!.names[0]).toBe('water');
    expect(dec.top!.floor[0]).toBe('stone');
    expect(dec.top!.depth![0]).toBe(1);
    expect(dec.top!.names[4]).toBe('stone');
    expect(mapDescribe(dec, 'auto', 0)).toBe('water, y -49, 1 deep over stone');
    expect(cache.liveSummary(1, 0)!.surfaceAt(0, 0)).toEqual({ name: 'water', y: -49, depth: 1, floor: 'stone', floorY: -50 });
  });

  it('fills the palette colours once they are computed (the route waits for the first ones)', async () => {
    const { world, cache } = world3x3();
    const colours = fakeColours({ stone: 0x808080 });
    const b = new MapBuilder({ world, cache, colours });
    expect(b.build({ r: 1 }).palette.every((e) => e.rgb === null)).toBe(true);
    const j = await buildWithColours(b, colours, { r: 1 });
    expect(Object.fromEntries(j.palette.map((e) => [e.name, e.rgb]))).toEqual({ stone: '#808080', water: null });
    expect(() => MapJsonSchema.parse(j)).not.toThrow();
    const again = await buildWithColours(b, colours, { r: 1 });
    expect(again.palette.find((e) => e.name === 'stone')!.rgb).toBe('#808080');
    expect(colours.loads).toHaveLength(1); // known names are not loaded again
  });

  it('the /map page script (with PAINT_JS embedded) is valid JavaScript', () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(MAP_PAGE)?.[1];
    expect(script).toContain('function mapPixels');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- compiled, not run: a syntax check of the page script
    expect(() => new Function(script!)).not.toThrow();
  });

  it('the schema takes the additive fields and rejects bad ones', () => {
    const j = new MapBuilder({}).build();
    const t = { cx: 0, cz: 0, live: true, rev: 1, updatedAt: 0, y: Buffer.alloc(512).toString('base64'), c: Buffer.alloc(64).toString('base64') };
    const s = Buffer.alloc(256).toString('base64');
    expect(MapJsonSchema.safeParse({ ...j, tiles: [{ ...t, s, p: [0] }], palette: [{ name: 'stone', rgb: '#808080' }] }).success).toBe(true);
    expect(MapJsonSchema.safeParse({ ...j, tiles: [{ ...t, s: 'abc' }] }).success).toBe(false);
    expect(MapJsonSchema.safeParse({ ...j, palette: [{ name: 'stone', rgb: 'red' }] }).success).toBe(false);
    expect(MapJsonSchema.safeParse({ ...j, tiles: [{ ...t, s, p: [0], u: { s, sy: t.y } }] }).success).toBe(true);
  });
});

describe('/map routes on the health server', () => {
  it('serves the page and the JSON next to /healthz', async () => {
    const { world, cache } = world3x3();
    const metrics = { snapshot: () => ({ state: 'spawned', uptimeS: 1, rates: { correctionsPerMin: 0 }, reconnects: 0, kicks: { byReason: {} }, counters: {}, gameVersion: 'x' }) };
    const { server, port } = await onFetchablePort(() => new HealthServer({ port: 0, metrics: metrics as never, routes: mapRoutes({ world, cache, server: 'test' }) }), (s) => s.start(), (s) => s.stop());
    try {
      const page = await fetch(`http://127.0.0.1:${port}/map`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      const html = await page.text();
      expect(html).toContain('<canvas');
      expect(html).toContain('map.json');
      expect(html).toContain('function mapPixels'); // Track PC: the shared painting is embedded
      const res = await fetch(`http://127.0.0.1:${port}/map.json?r=3`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-encoding')).toBe('gzip'); // Track PC: fetch asks for gzip, the body is over GZIP_MIN
      const j = MapJsonSchema.parse(await res.json());
      expect(j.tiles).toHaveLength(9);
      const plain = await fetch(`http://127.0.0.1:${port}/map.json?r=3`, { headers: { 'accept-encoding': 'identity' } });
      expect(plain.headers.get('content-encoding')).toBeNull();
      expect(MapJsonSchema.parse(await plain.json()).tiles).toHaveLength(9);
      expect(j.server).toBe('test');
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});
