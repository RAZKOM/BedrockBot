// e2e (tag @bds), Track P2 (decision 0062, docs/map.md): the map-first screen on a real bot process
// against bds-cache (a generated world: real terrain for the surface and the slice). A floating stone
// platform in a private area gives the actions a known floor; the bot (the CLI, `--walk`) stands on it.
//   1. the page opens on the map screen; its modules (mapview, tiles, paint, ...) are served;
//   2. tiles: GET /api/map/tiles registers the window, the `map` topic over SSE brings a changed tile (a
//      pumpkin set on the platform), and the surface of sampled columns (decoded with the page's own
//      paint.ts and the global palette) matches the server's blocks scanned with the cache's rule;
//   3. the Y-slice (GET /api/map/slice) at the platform height and at a natural height matches
//      truth:blocks for every column of the 3 x 3 chunks around the bot;
//   4. Go here (mapdefs.ts pointActions, what the sheet offers) sends `!goto` and the bot arrives;
//   5. a box Clear (boxActions) digs the blocks of a small box;
//   6. Set waypoint sends `!wp set` and the waypoint shows in `!wp <name>` and in the overlays;
//   plus the sizes: /map.json against /api/map/tiles at r = 4 and 12 (raw and gzip), the map messages.
// Env: PANEL_MAP_E2E_PORT (default a random port in 9950..9959) plus cache-truth.ts (CACHE_BDS_*).
// Needs BDS_E2E=1 and bds-cache with the truth pack (`node scripts/bds.mjs --profile cache up` and `... pack`).
import { randomInt } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Connection } from '../../src/connection/connection.ts';
import type { MapSliceAnswer, MapTilesAnswer, MapTopicMessage } from '../../src/health/map/live.ts';
import { mapDecodeSlice, mapDecodeTile, mapSurfaceAt } from '../../src/health/map/paint.ts';
import type { CompactTileJson, MapPaletteEntry } from '../../src/health/map/schema.ts';
import { PANEL_BUDGETS } from '../../src/health/panel/budgets.ts';
import { boxActions, pointActions } from '../../src/health/panel/client/mapdefs.ts';
import type { MenuAction } from '../../src/health/panel/menu.ts';
import { MAP_TOPIC } from '../../src/health/panel/shared.ts';
import { silentLogger } from '../../src/log.ts';
import { StateTable } from '../../src/world/cache/classes.ts';
import { scanTop } from '../../src/world/cache/surface.ts';
import { BlockRegistry } from '../../src/world/registry.ts';
import { openSse, type SseStream } from '../unit/health/panel-sse.ts';
import { CACHE_CONTAINER, CACHE_HOST, CACHE_PORT, CACHE_TARGET, E2E, hdist, prepareServer, privateArea, sleep, uniqueName } from './cache-truth.ts';
import { centre, startCli, truthLoaded, until, waitOnline, type CoreCli } from './core-truth.ts';
import { E2E_VERSION } from './env.ts';
import { PveTruth } from './pve-truth.ts';

const PORT = Number(process.env.PANEL_MAP_E2E_PORT ?? 9950 + randomInt(10));
const TOKEN = Array.from({ length: 24 }, () => 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(57)]).join('');
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = { authorization: `Bearer ${TOKEN}` };
/** The platform: stone at y PY, air above, radius PR around P. */
const PY = 200;
const PR = 12;
const Y_HI = 319;
const Y_LO = -64;
const SAMPLES = 40;

interface BlocksReply {
  palette: string[];
  runs: [number, number][];
}
const plain = (n: string): string => n.replace(/^minecraft:/, '');
/** truth:blocks unrolled (y outermost, then z, then x). */
function unroll(r: BlocksReply): string[] {
  const out: string[] = [];
  for (const [p, n] of r.runs) for (let k = 0; k < n; k++) out.push(plain(r.palette[p]!));
  return out;
}
const idx = (x: number, z: number): number => ((z & 15) << 4) | (x & 15);
const key = (cx: number, cz: number): string => `${cx},${cz}`;

let lastCmdAt = 0;
async function cmd(text: string): Promise<{ status: number; body: { ok: boolean; command: string; replies: string[]; error?: string } }> {
  const wait = 220 - (Date.now() - lastCmdAt);
  if (wait > 0) await sleep(wait);
  lastCmdAt = Date.now();
  const r = await fetch(`${BASE}/api/cmd`, { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  return { status: r.status, body: (await r.json()) as { ok: boolean; command: string; replies: string[]; error?: string } };
}

function action(menu: MenuAction[], id: string): MenuAction {
  const a = menu.find((x) => x.id === id);
  expect(a, `the sheet offers ${id}: ${JSON.stringify(menu.map((x) => x.id))}`).toBeDefined();
  return a!;
}

/** What the page keeps: the global palette and the newest tile per chunk. */
class Client {
  readonly pal: (MapPaletteEntry | undefined)[] = [];
  readonly tiles = new Map<string, CompactTileJson>();
  rev = 0;
  takePalette(from: number | undefined, entries: MapPaletteEntry[] | undefined): void {
    if (from === undefined || !entries) return;
    entries.forEach((e, k) => (this.pal[from + k] = e));
  }
  take(a: { tiles?: CompactTileJson[]; palFrom?: number; palette?: MapPaletteEntry[]; rev: number }): void {
    this.takePalette(a.palFrom, a.palette);
    for (const t of a.tiles ?? []) this.tiles.set(key(t.cx, t.cz), t);
    this.rev = Math.max(this.rev, a.rev);
  }
  surface(x: number, z: number): { name: string; y: number } | null | undefined {
    const t = this.tiles.get(key(x >> 4, z >> 4));
    return t ? mapSurfaceAt(mapDecodeTile(t, this.pal), 'auto', idx(x, z)) : undefined;
  }
}

describe.skipIf(!E2E)('@bds panel map screen (Track P2, bds-cache)', () => {
  const area = privateArea();
  const P = { x: area.x + 8, y: PY + 1, z: area.z + 8 };
  const cx = P.x >> 4;
  const cz = P.z >> 4;
  const measurements: string[] = [];
  const registry = new BlockRegistry({ version: E2E_VERSION, logger: silentLogger });
  const table = new StateTable(registry);
  const client = new Client();
  let conn: Connection | undefined;
  let truth: PveTruth | undefined;
  let cli: CoreCli | undefined;
  let dir: string | undefined;
  let stream: SseStream | undefined;
  const cid = `e2e${randomInt(1000, 9999)}`;
  /** A height that cuts the natural terrain (one below the median surface of the sampled natural columns). */
  let naturalY = 60;

  const tilesUrl = (o: Record<string, string | number>): string => `${BASE}/api/map/tiles?${new URLSearchParams(Object.entries(o).map(([k, v]): [string, string] => [k, String(v)])).toString()}`;
  async function fetchTiles(o: Record<string, string | number> = {}): Promise<MapTilesAnswer> {
    const a = (await fetch(tilesUrl({ cid, r: 2, cx, cz, pal: client.pal.length, ...o }), { headers: AUTH }).then((r) => r.json())) as MapTilesAnswer;
    client.take(a);
    return a;
  }

  beforeAll(async () => {
    await prepareServer();
    const name = uniqueName('PanelMap');
    conn = new Connection({ version: E2E_VERSION, username: name, logger: silentLogger, reconnect: false });
    await conn.connect(CACHE_TARGET);
    truth = new PveTruth(conn, CACHE_CONTAINER);
    await waitOnline(truth, name);
    await truth.tp(name, { x: P.x - 10 + 0.5, y: PY + 20, z: P.z - 10 + 0.5 }, 0, 0); // loads the chunks
    await truthLoaded(truth, 'fill', [P.x - PR, PY, P.z - PR, P.x + PR, PY, P.z + PR, 'stone']);
    await truthLoaded(truth, 'fill', [P.x - PR, PY + 1, P.z - PR, P.x + PR, PY + 6, P.z + PR, 'air']);
    await truth.tp(name, { x: P.x - 10 + 0.5, y: PY + 1, z: P.z - 10 + 0.5 }, 0, 0);
    process.env.BEDROCKBOT_PANEL_TOKEN = TOKEN;
    dir = mkdtempSync(join(tmpdir(), 'bot-e2e-panel-map-'));
    writeFileSync(join(dir, 'config.json'), '{}\n'); // the waypoints go to <tmp>/waypoints/
    process.env.BEDROCKBOT_CACHE_DIR = dir;
    delete process.env.BEDROCKBOT_CACHE;
    cli = startCli(['--walk', '--health-port', String(PORT), '--config', join(dir, 'config.json')], uniqueName('PanelMapB'), { host: CACHE_HOST, port: CACHE_PORT });
    delete process.env.BEDROCKBOT_PANEL_TOKEN;
    delete process.env.BEDROCKBOT_CACHE_DIR;
    await waitOnline(truth, cli.name);
    await truth.tp(cli.name, centre(P), 0, 0);
    await until(async () => ((await fetch(`${BASE}/healthz`).catch(() => undefined))?.status === 200 ? true : undefined), 20_000, 'panel /healthz 200', 250);
    // the platform in the map: the window registered, the bot's chunk summarised
    await until(async () => {
      await fetchTiles();
      return client.surface(P.x, P.z)?.name === 'stone' ? true : undefined;
    }, 30_000, 'the platform in /api/map/tiles', 500);
  }, 120_000);

  afterAll(async () => {
    stream?.close();
    if (cli) {
      await sleep(300);
      await cmd('!quit').catch(() => undefined);
      await Promise.race([cli.exit, sleep(10_000)]);
      cli.kill();
    }
    if (truth) await truthLoaded(truth, 'fill', [P.x - PR, PY, P.z - PR, P.x + PR, PY + 6, P.z + PR, 'air']).catch(() => undefined);
    await conn?.disconnectAndFlush('test done').catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
    console.log(`panel map e2e (port ${PORT}, area ${P.x} ${P.z}):\n  ${measurements.join('\n  ')}`);
  }, 60_000);

  it('the page opens on the map screen and serves its modules', async () => {
    const html = await fetch(`${BASE}/`, { headers: AUTH }).then((r) => r.text());
    for (const m of ['id="mapscreen"', 'id="mapcv"', 'id="map-sheet"', 'id="hud-stop"', 'id="view-map"', 'id="view-cards"', 'data-layer="slice"', 'data-ov="ores"']) expect(html).toContain(m);
    expect(Buffer.byteLength(html)).toBeLessThan(PANEL_BUDGETS.html);
    const preload = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]!);
    for (const m of ['mapview', 'mapsheet', 'mapinput', 'maptex', 'tiles', 'paint', 'overlays', 'mapdefs']) expect(preload.some((u) => u.endsWith(`/client/${m}.ts`)), m).toBe(true);
    for (const u of preload) expect((await fetch(`${BASE}${u}`, { headers: AUTH })).status).toBe(200);
    const tex = await fetch(`${BASE}/tex/stone.png`, { headers: AUTH });
    expect([200, 404]).toContain(tex.status); // 404 without the extracted assets: the page paints the colour
    measurements.push(`page ${Buffer.byteLength(html)} bytes, ${preload.length} modules; /tex/stone.png ${tex.status}`);
  });

  it('tiles over the stream: a changed tile arrives on the map topic; sampled surfaces match the truth', async () => {
    stream = await openSse(`${BASE}/api/stream?topics=${MAP_TOPIC}`, AUTH);
    expect(stream.status).toBe(200);
    await stream.next('hello', 10_000);
    await fetchTiles(); // re-register (and catch up) now that the stream is open
    const pk = { x: P.x + 3, y: PY + 1, z: P.z + 3 };
    await truth!.ok('setblock', [pk.x, pk.y, pk.z, 'pumpkin']);
    const t0 = Date.now();
    const got: MapTopicMessage[] = [];
    await until(async () => {
      const m = JSON.parse((await stream!.next(MAP_TOPIC, 15_000)).data) as MapTopicMessage;
      got.push(m);
      client.take(m);
      return m.tiles?.some((t) => t.cx === pk.x >> 4 && t.cz === pk.z >> 4) && client.surface(pk.x, pk.z)?.name === 'pumpkin' ? true : undefined;
    }, 20_000, 'the pumpkin tile on the map topic', 0);
    expect(client.surface(pk.x, pk.z)).toEqual({ name: 'pumpkin', y: pk.y });
    const msgBytes = stream.messages.filter((m) => m.event === MAP_TOPIC).map((m) => m.bytes);
    for (const b of msgBytes) expect(b).toBeLessThan(PANEL_BUDGETS.mapMessage);
    measurements.push(`map topic: the pumpkin tile ${Date.now() - t0} ms after the setblock, ${got.length} messages (${got.map((m, i) => `${m.tiles?.length ?? 0} tiles ${msgBytes[i]} B`).join(', ')})`);

    // sampled columns: the tiles the page holds against the server's blocks, scanned with the cache's rule
    const facts = (s: number) => table.of(s);
    const bad: string[] = [];
    const natural: number[] = [];
    let n = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const x = P.x + Math.round((Math.random() - 0.5) * 72);
      const z = P.z + Math.round((Math.random() - 0.5) * 72);
      const mine = client.surface(x, z);
      if (mine === undefined) continue; // no tile there (not loaded)
      const names = unroll(await truthLoaded<BlocksReply>(truth!, 'blocks', [x, Y_LO, z, x, Y_HI, z]));
      const t = scanTop((y) => registry.stateIdOf(names[y - Y_LO] ?? 'air') ?? -1, facts, Y_HI, Y_LO);
      n++;
      if (t && Math.abs(x - P.x) > PR) natural.push(t.y);
      if ((mine?.name ?? null) !== (t?.name ?? null) || (mine?.y ?? null) !== (t?.y ?? null)) bad.push(`${x},${z}: map ${mine ? `${mine.name}@${mine.y}` : 'none'} truth ${t ? `${t.name}@${t.y}` : 'none'}`);
    }
    measurements.push(`surface: ${n} sampled columns, ${n - bad.length} match the truth${bad.length ? `; differ: ${bad.slice(0, 5).join('; ')}` : ''}`);
    expect(n).toBeGreaterThanOrEqual(SAMPLES - 4);
    expect(bad.length, bad.join('\n')).toBeLessThanOrEqual(Math.floor(n * 0.05)); // grass grows, water flows: a few may move
    natural.sort((a, b) => a - b);
    naturalY = natural.length ? natural[natural.length >> 1]! - 1 : 60;
  }, 120_000);

  it('the Y-slice at the platform height and at a natural height matches truth:blocks', async () => {
    for (const y of [PY, naturalY]) {
      const a = (await fetch(`${BASE}/api/map/slice?y=${y}&r=1&cx=${cx}&cz=${cz}&pal=${client.pal.length}`, { headers: AUTH }).then((r) => r.json())) as MapSliceAnswer;
      client.takePalette(a.palFrom, a.palette);
      expect(a.tiles).toHaveLength(9);
      const x0 = (cx - 1) * 16;
      const z0 = (cz - 1) * 16;
      const want = unroll(await truthLoaded<BlocksReply>(truth!, 'blocks', [x0, y, z0, x0 + 47, y, z0 + 47]));
      expect(want).toHaveLength(48 * 48);
      let cells = 0;
      const bad: string[] = [];
      const kinds = new Map<string, number>();
      for (const t of a.tiles) {
        const d = mapDecodeSlice(t, client.pal);
        if (!d.names) continue; // a remembered column (not loaded): classes only
        for (let i = 0; i < 256; i++) {
          const x = t.cx * 16 + (i & 15);
          const z = t.cz * 16 + (i >> 4);
          const truthName = want[(z - z0) * 48 + (x - x0)]!;
          const mine = d.names[i] ?? 'air';
          cells++;
          kinds.set(truthName, (kinds.get(truthName) ?? 0) + 1);
          if (mine !== truthName) bad.push(`${x},${z}: slice ${mine} truth ${truthName}`);
          if (y === PY && Math.abs(x - P.x) <= PR && Math.abs(z - P.z) <= PR) {
            expect(mine, `platform ${x},${z}`).toBe('stone');
            expect(d.cls[i], `platform ${x},${z} class`).toBe(1);
          }
        }
      }
      measurements.push(`slice y ${y}: ${cells} cells, ${cells - bad.length} match (${JSON.stringify(Object.fromEntries(kinds))})${bad.length ? `; differ: ${bad.slice(0, 5).join('; ')}` : ''}`);
      expect(cells).toBeGreaterThanOrEqual(256 * 5);
      expect(bad.length, bad.slice(0, 20).join('\n')).toBeLessThanOrEqual(Math.floor(cells * 0.02));
    }
  }, 90_000);

  it('Go here sends !goto to the block above and the bot arrives', async () => {
    const start = (await truth!.pos(cli!.name)).location;
    const target = { x: P.x + 8, z: P.z };
    await fetchTiles();
    const s = client.surface(target.x, target.z);
    expect(s).toEqual({ name: 'stone', y: PY });
    const walk = action(pointActions({ x: target.x, z: target.z, y: s!.y, block: s!.name, bot: start, elytra: false }), 'walk');
    expect(walk.cmd).toBe(`!goto ${target.x} ${PY + 1} ${target.z}`);
    const t0 = Date.now();
    const r = await cmd(walk.cmd!);
    expect(r.status).toBe(200);
    expect(r.body.replies[0]).toBe(`walking to ${target.x} ${PY + 1} ${target.z}`);
    const arrived = await until(async () => {
      const p = (await truth!.pos(cli!.name)).location;
      return hdist(p, { x: target.x + 0.5, z: target.z + 0.5 }) < 1 ? p : undefined;
    }, 30_000, 'the bot at the tapped column', 200);
    expect(hdist(arrived, start)).toBeGreaterThan(5);
    measurements.push(`Go here: "${walk.cmd}" -> "${r.body.replies[0]}", arrived in ${Date.now() - t0} ms`);
  }, 60_000);

  it('a box Clear digs the box', async () => {
    const box = { x1: P.x - 4, z1: P.z - 4, x2: P.x - 6, z2: P.z - 4, y1: PY + 2, y2: PY + 1 };
    await truthLoaded(truth!, 'fill', [P.x - 6, PY + 1, P.z - 4, P.x - 4, PY + 2, P.z - 4, 'dirt']);
    // the owner boxes what the map shows: wait until the bot's world (the tiles) has the dirt
    await until(async () => {
      await fetchTiles();
      return [P.x - 6, P.x - 5, P.x - 4].every((x) => client.surface(x, P.z - 4)?.name === 'dirt') ? true : undefined;
    }, 10_000, 'the dirt in the tiles', 250);
    const clear = action(boxActions(box, { block: null }), 'clear');
    expect(clear.cmd).toBe(`!build clear ${P.x - 6} ${PY + 1} ${P.z - 4} ${P.x - 4} ${PY + 2} ${P.z - 4}`);
    const t0 = Date.now();
    const r = await cmd(clear.cmd!);
    expect(r.status).toBe(200);
    // the builder plans first and replies later: the reply reaches the panel chat (what the sheet shows)
    const said = r.body.replies.find((x) => x.startsWith('build')) ?? (await until(async () => {
      const s = (await fetch(`${BASE}/api/state`, { headers: AUTH }).then((q) => q.json())) as { chat: { ts: number; text: string }[] };
      return s.chat.find((c) => c.ts >= t0 - 1000 && /^build(ing |: )/.test(c.text))?.text;
    }, 20_000, 'the build reply in the panel chat', 250));
    expect(said).toMatch(/^building /);
    await until(async () => {
      const names = unroll(await truthLoaded<BlocksReply>(truth!, 'blocks', [P.x - 6, PY + 1, P.z - 4, P.x - 4, PY + 2, P.z - 4]));
      return names.every((n) => n === 'air') ? true : undefined;
    }, 90_000, 'the box dug out', 1000);
    // and the map shows the platform again there (the tiles the page would hold)
    await until(async () => {
      await fetchTiles();
      return client.surface(P.x - 5, P.z - 4)?.name === 'stone' ? true : undefined;
    }, 10_000, 'the cleared column back to stone in the tiles', 500);
    measurements.push(`box Clear: "${clear.cmd}" -> "${said}", 6 blocks dug in ${Date.now() - t0} ms`);
  }, 120_000);

  it('Set waypoint sends !wp set; the waypoint shows in !wp and in the overlays', async () => {
    const x = P.x + 2;
    const z = P.z - 3;
    await fetchTiles();
    const s = client.surface(x, z);
    expect(s?.y).toBe(PY);
    const wp = action(pointActions({ x, z, y: s!.y, block: s!.name, bot: null, elytra: false }), 'wp');
    expect(wp.prompt).toBeDefined();
    const name = `mapwp${randomInt(100, 999)}`;
    const text = wp.cmd!.replace('{name}', name);
    expect(text).toBe(`!wp set ${name} ${x} ${PY + 1} ${z}`);
    const r = await cmd(text);
    expect(r.body.replies[0]).toBe(`waypoint ${name} set to ${x} ${PY + 1} ${z}`);
    const show = await cmd(`!wp ${name}`);
    expect(show.body.replies[0]).toMatch(new RegExp(`^waypoint ${name}: ${x} ${PY + 1} ${z}`));
    const live = await fetchTiles({ live: 1 });
    expect(live.live?.wps.some((w) => w[0] === name)).toBe(true);
    measurements.push(`Set waypoint: "${text}" -> "${r.body.replies[0]}"; "!wp ${name}" -> "${show.body.replies[0]}"`);
  });

  it('sizes: /map.json against the compact tiles at r = 4 and 12; the stream while the bot stands', async () => {
    const polled: Record<number, number> = {};
    for (const r of [4, 12]) {
      const old = await fetch(`${BASE}/map.json?r=${r}&cx=${cx}&cz=${cz}`, { headers: AUTH }).then((q) => q.text());
      const now = await fetch(`${BASE}/api/map/tiles?r=${r}&cx=${cx}&cz=${cz}&pal=0`, { headers: AUTH }).then((q) => q.text());
      const tiles = (JSON.parse(now) as MapTilesAnswer).tiles.length;
      const oldGz = gzipSync(old, { level: 6 }).length;
      const nowGz = gzipSync(now, { level: 6 }).length;
      measurements.push(`r=${r} (${tiles} tiles): /map.json ${old.length} B raw, ${oldGz} B gzip; /api/map/tiles ${now.length} B raw, ${nowGz} B gzip (${((1 - nowGz / oldGz) * 100).toFixed(0)} % less gzip)`);
      expect(now.length).toBeLessThan(old.length);
      expect(nowGz).toBeLessThanOrEqual(oldGz);
      polled[r] = oldGz;
    }
    // what the open page costs in 10 s, r=4: the map topic (changed tiles of the window) against the old
    // page's poll (every 2 s /map.json?since=<rev>&win=<window>: changed tiles plus the overlays and palette)
    await fetchTiles({ r: 4 });
    const seen = stream!.messages.length;
    let since = 0;
    let win = '';
    let pollRaw = 0;
    let pollGz = 0;
    for (let i = 0; i < 6; i++) {
      const j = await fetch(`${BASE}/map.json?r=4&cx=${cx}&cz=${cz}${i ? `&since=${since}&win=${win}` : ''}`, { headers: AUTH }).then((q) => q.text());
      const d = JSON.parse(j) as { rev: number; window: { cx0: number; cz0: number; cx1: number; cz1: number } };
      since = d.rev;
      win = [d.window.cx0, d.window.cz0, d.window.cx1, d.window.cz1].join(',');
      if (i) {
        pollRaw += j.length;
        pollGz += gzipSync(j, { level: 6 }).length;
      }
      await sleep(2000);
    }
    const late = stream!.messages.slice(seen).filter((m) => m.event === MAP_TOPIC);
    const bytes = late.reduce((s, m) => s + m.bytes, 0);
    measurements.push(
      `10 s with the map open, r=4, bot standing: map topic ${late.length} messages, ${bytes} B raw (${late.length ? gzipSync(late.map((m) => m.data).join('\n')).length : 0} B gzip); ` +
        `the old poll 5 x /map.json?since: ${pollRaw} B raw, ${pollGz} B gzip (a full r=4 answer ${polled[4]} B gzip)`,
    );
  }, 60_000);
});
