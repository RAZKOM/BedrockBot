// Debug map (PLAN.md task 7.15, Track T): /map.json against its zod schema, tiles, incremental
// updates (since / win), status shapes (path, goal, home, waypoints), and the routes on the health server.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HealthServer } from '../../../src/connection/health.ts';
import { asWaypoints, MapBuilder, parseMapQuery } from '../../../src/health/map/data.ts';
import { mapRoutes } from '../../../src/health/map/routes.ts';
import { MapJsonSchema } from '../../../src/health/map/schema.ts';
import { silentLogger } from '../../../src/log.ts';
import { WorldCache } from '../../../src/world/cache/index.ts';
import { World } from '../../../src/world/index.ts';
import { encodeSubChunk, fillSection, readyRegistry, recordedLogin, ReplaySource } from '../world/helpers.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const reg = readyRegistry();
const rid = (name: string): number => reg.runtimeIdOf(reg.stateIdOf(name)!);

function world3x3() {
  const src = new ReplaySource();
  const world = new World(src, { logger: silentLogger, defer: (fn) => fn() });
  const { startGame, itemRegistry } = recordedLogin();
  src.emit('start_game', startGame);
  src.emit('item_registry', itemRegistry as unknown as Record<string, unknown>);
  src.emit('network_chunk_publisher_update', { coordinates: { x: 8, y: 0, z: 8 }, radius: 32, saved_chunks: [] });
  const dir = mkdtempSync(join(tmpdir(), 'bb-map-'));
  dirs.push(dir);
  const cache = new WorldCache({ dir, flushIntervalMs: 0, logger: silentLogger });
  cache.attach(world);
  const stone = rid('stone');
  const water = rid('water');
  for (let cx = -1; cx <= 1; cx++) {
    for (let cz = -1; cz <= 1; cz++) {
      src.emit('level_chunk', { x: cx, z: cz, dimension: 0, sub_chunk_count: 0, highest_subchunk_count: 1, cache_enabled: false, blobs: [], payload: Buffer.alloc(0) });
      const sec = fillSection((x, y) => (y < 15 ? stone : cx === 1 && x < 4 ? water : stone));
      src.emit('subchunk', { cache_enabled: false, dimension: 0, origin: { x: cx, y: -4, z: cz }, entries: [{ dx: 0, dy: 0, dz: 0, result: 'success', payload: encodeSubChunk([sec], { y: -4 }) }] });
    }
  }
  world.self.pos = { x: 4.5, y: -48, z: 4.5 };
  world.entityTracker.entities.set(5n, {
    runtimeId: 5n,
    uniqueId: 5n,
    type: 'minecraft:zombie',
    pos: { x: 10, y: -48, z: 3 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    headYaw: 0,
    onGround: true,
    updatedAt: 0,
  });
  return { src, world, cache };
}

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

describe('/map routes on the health server', () => {
  it('serves the page and the JSON next to /healthz', async () => {
    const { world, cache } = world3x3();
    const metrics = { snapshot: () => ({ state: 'spawned', uptimeS: 1, rates: { correctionsPerMin: 0 }, reconnects: 0, kicks: { byReason: {} }, counters: {}, gameVersion: 'x' }) };
    const server = new HealthServer({ port: 0, metrics: metrics as never, routes: mapRoutes({ world, cache, server: 'test' }) });
    const port = await server.start();
    try {
      const page = await fetch(`http://127.0.0.1:${port}/map`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      const html = await page.text();
      expect(html).toContain('<canvas');
      expect(html).toContain('map.json');
      const res = await fetch(`http://127.0.0.1:${port}/map.json?r=3`);
      expect(res.status).toBe(200);
      const j = MapJsonSchema.parse(await res.json());
      expect(j.tiles).toHaveLength(9);
      expect(j.server).toBe('test');
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});
