// The map screen's data on the panel (decision 0062, docs/map.md "Wire"): the tiles of the client's
// window without polling, the overlays, and the Y-slice.
//
//   GET /api/map/tiles?cid=&r=&cx=&cz=[&since=&win=&pal=]   compact tiles of the window (gzip), the global
//                                                            palette from `pal` on; registers the window
//   GET /api/map/slice?y=&cx=&cz=&r=                        the cut at height y: classes, loaded names
//   topic `map`       (event) every second while a stream listens and a window is registered: the tiles
//                     of the registered windows that changed since the last message, the new palette
//                     entries; `{from, rev}` chain the messages (a client whose rev is older than `from`
//                     missed one and fetches again); `{reset: true}` when the dimension changed
//   topic `map-live`  (state) the overlays: bot, trail, path, goal, entities, home, shelter, waypoints
//
// A client registers its window by fetching it (the `cid` of the fetch), so a pan or a follow step is
// one incremental fetch (only the tiles new to the window), and the topic then carries the changes.
// Windows expire WINDOW_TTL_MS after their last fetch (the page fetches every WINDOW_TOUCH_MS).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import type { Logger } from '../../log.ts';
import { silentLogger } from '../../log.ts';
import type { WorldCache } from '../../world/cache/cache.ts';
import { currentRev } from '../../world/cache/summary.ts';
import type { StreamHub, Topic } from '../panel/stream.ts';
import { GlobalPalette, packClasses, parseMapQuery, type ChunkWindow, type MapBuilder, type MapColourSource, type MapLiveJson, type MapSource } from './data.ts';
import type { HealthRoute } from './routes.ts';
import { GZIP_MIN } from './routes.ts';
import type { CompactTileJson, MapPaletteEntry, SliceTileJson } from './schema.ts';
import { MAP_LIVE_TOPIC, MAP_TILES_PATH, MAP_SLICE_PATH, MAP_TOPIC, MAP_TILES_MAX_R, MAP_SLICE_MAX_R, WINDOW_TTL_MS } from '../panel/shared.ts';
import { PANEL_BUDGETS } from '../panel/budgets.ts';

/** A message of the `map` topic. */
export interface MapTopicMessage {
  /** The rev of the previous message: a client with an older rev missed tiles (it fetches with since = its rev). */
  from: number;
  rev: number;
  dim: number;
  /** The dimension changed: drop every tile and fetch again. */
  reset?: true;
  tiles?: CompactTileJson[];
  /** New global palette entries, starting at index palFrom. */
  palFrom?: number;
  palette?: MapPaletteEntry[];
}

/** The answer of GET /api/map/tiles. */
export interface MapTilesAnswer {
  ts: number;
  dim: number;
  rev: number;
  center: { cx: number; cz: number };
  radius: number;
  window: ChunkWindow;
  tiles: CompactTileJson[];
  palFrom: number;
  palette: MapPaletteEntry[];
  /** With `live=1` (a page that polls because it has no stream): the overlays, what the map-live topic carries. */
  live?: MapLiveJson;
}

/** The answer of GET /api/map/slice. */
export interface MapSliceAnswer {
  ts: number;
  dim: number;
  y: number;
  window: ChunkWindow;
  tiles: SliceTileJson[];
  palFrom: number;
  palette: MapPaletteEntry[];
}

export interface MapLiveOptions {
  hub: StreamHub;
  builder: MapBuilder;
  source: MapSource;
  colours: MapColourSource | null | undefined;
  log?: Logger;
  /** The topic's tick (default 1000 ms). */
  tickMs?: number;
}

const CID = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_WINDOWS = 8;

export class MapLive {
  readonly palette: GlobalPalette;
  readonly topic: Topic;
  readonly liveTopic: Topic;
  private readonly o: MapLiveOptions;
  private readonly log: Logger;
  private readonly windows = new Map<string, { w: ChunkWindow; at: number }>();
  private last = currentRev();
  private lastDim: number;
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  readonly stats = { messages: 0, tiles: 0, fetches: 0, slices: 0, maxMessage: 0, lastMessage: 0 };

  constructor(o: MapLiveOptions) {
    this.o = o;
    this.log = o.log ?? silentLogger;
    this.palette = new GlobalPalette(o.colours);
    this.lastDim = this.dim();
    this.topic = o.hub.topic(MAP_TOPIC, { kind: 'event', budget: PANEL_BUDGETS.mapMessage });
    this.liveTopic = o.hub.topic(MAP_LIVE_TOPIC, { kind: 'state', read: () => o.builder.live(), sampleMs: 1000, budget: PANEL_BUDGETS.mapLive, deltaBudget: PANEL_BUDGETS.mapLiveDelta });
    this.timer = setInterval(() => void this.tick(), o.tickMs ?? 1000);
    this.timer.unref();
  }

  private get cache(): WorldCache | undefined {
    return this.o.source.cache;
  }

  private dim(): number {
    return this.o.source.world?.self.dimension ?? 0;
  }

  /** Registered windows (tests, stats). */
  windowCount(): number {
    return this.windows.size;
  }

  /** Register (or refresh) a client's window. */
  touch(cid: string, w: ChunkWindow, now = Date.now()): void {
    this.windows.delete(cid);
    this.windows.set(cid, { w, at: now });
    while (this.windows.size > MAX_WINDOWS) this.windows.delete(this.windows.keys().next().value!);
  }

  private expire(now: number): void {
    for (const [k, v] of this.windows) if (now - v.at > WINDOW_TTL_MS) this.windows.delete(k);
  }

  /** One tick of the `map` topic (public for the tests). */
  async tick(now = Date.now()): Promise<MapTopicMessage | undefined> {
    if (this.busy) return undefined;
    const rev = currentRev();
    const dim = this.dim();
    this.expire(now);
    if (this.o.hub.stats().clients === 0 || this.windows.size === 0 || !this.cache) {
      this.last = rev;
      this.lastDim = dim;
      return undefined;
    }
    if (dim !== this.lastDim) {
      const m: MapTopicMessage = { from: this.last, rev, dim, reset: true };
      this.last = rev;
      this.lastDim = dim;
      this.send(m);
      return m;
    }
    if (rev === this.last) return undefined;
    const from = this.last;
    this.last = rev;
    const palFrom = this.palette.size;
    const seen = new Set<string>();
    const tiles: CompactTileJson[] = [];
    for (const { w } of this.windows.values()) {
      for (const t of this.o.builder.tiles(w, this.palette, from, w, true) as CompactTileJson[]) {
        const k = `${t.cx},${t.cz}`;
        if (seen.has(k)) continue;
        seen.add(k);
        tiles.push(t);
      }
    }
    const m: MapTopicMessage = { from, rev, dim };
    if (tiles.length) m.tiles = tiles;
    if (this.palette.size > palFrom) {
      this.busy = true;
      try {
        await this.palette.ready(palFrom);
      } finally {
        this.busy = false;
      }
      m.palFrom = palFrom;
      m.palette = this.palette.entriesFrom(palFrom);
    }
    this.send(m);
    return m;
  }

  private send(m: MapTopicMessage): void {
    const bytes = JSON.stringify(m).length;
    this.stats.messages++;
    this.stats.tiles += m.tiles?.length ?? 0;
    this.stats.lastMessage = bytes;
    if (bytes > this.stats.maxMessage) this.stats.maxMessage = bytes;
    this.topic.publish(m);
  }

  /** GET /api/map/tiles: compact tiles of a window, registering it for the topic. */
  async tilesAnswer(search: URLSearchParams, now = Date.now()): Promise<MapTilesAnswer> {
    const q = parseMapQuery(search);
    const { center, radius, window } = this.o.builder.windowOf({ ...q, r: q.r ?? 8 }, MAP_TILES_MAX_R);
    const cid = search.get('cid') ?? '';
    if (CID.test(cid)) this.touch(cid, window, now);
    const rev = currentRev();
    const palKnown = Math.max(0, Math.min(this.palette.size, Math.floor(Number(search.get('pal') ?? 0)) || 0));
    const before = this.palette.size;
    const tiles = this.o.builder.tiles(window, this.palette, q.since ?? -1, q.win, true) as CompactTileJson[];
    await this.palette.ready(Math.min(before, palKnown));
    this.stats.fetches++;
    const a: MapTilesAnswer = { ts: now, dim: this.dim(), rev, center, radius, window, tiles, palFrom: palKnown, palette: this.palette.entriesFrom(palKnown) };
    if (search.get('live') === '1') a.live = this.o.builder.live(now);
    return a;
  }

  /** GET /api/map/slice: per column of the window the class at y (cache cells), and the block name for loaded columns. */
  async sliceAnswer(search: URLSearchParams, now = Date.now()): Promise<MapSliceAnswer> {
    const q = parseMapQuery(search);
    const ys = search.get('y')?.trim() ?? '';
    const y = Math.floor(Number(ys));
    if (ys === '' || !Number.isFinite(y) || Math.abs(y) > 4096) throw new Error('y must be a number');
    const { window } = this.o.builder.windowOf({ ...q, r: q.r ?? 4 }, MAP_SLICE_MAX_R);
    const palKnown = Math.max(0, Math.min(this.palette.size, Math.floor(Number(search.get('pal') ?? 0)) || 0));
    const world = this.o.source.world;
    const cache = this.cache;
    const tiles: SliceTileJson[] = [];
    for (let cx = window.cx0; cx <= window.cx1; cx++) {
      for (let cz = window.cz0; cz <= window.cz1; cz++) {
        const s = cache?.summary(cx, cz);
        const loaded = !!world?.blockAt && (world.isLoaded?.(cx, cz) ?? false);
        if (!s && !loaded) continue;
        const cls = new Uint8Array(256);
        if (s) for (let i = 0; i < 256; i++) cls[i] = s.cls(i & 15, y, i >> 4);
        const t: SliceTileJson = { cx, cz, live: loaded, updatedAt: s?.updatedAt ?? now, y, c: packClasses(cls) };
        if (loaded) {
          const local = new Map<string, number>();
          const p: number[] = [];
          const n = new Uint8Array(256).fill(255);
          for (let i = 0; i < 256; i++) {
            const b = world.blockAt!({ x: cx * 16 + (i & 15), y, z: cz * 16 + (i >> 4) });
            if (!b || b.name === 'air') continue;
            let k = local.get(b.name);
            if (k === undefined) {
              if (p.length >= 255) continue;
              k = p.length;
              local.set(b.name, k);
              p.push(this.palette.index(b.name));
            }
            n[i] = k;
          }
          t.n = Buffer.from(n).toString('base64');
          t.p = p;
        }
        tiles.push(t);
      }
    }
    await this.palette.ready(palKnown);
    this.stats.slices++;
    return { ts: now, dim: this.dim(), y, window, tiles, palFrom: palKnown, palette: this.palette.entriesFrom(palKnown) };
  }

  /** The routes (behind the panel's token: panel.use). */
  route(): HealthRoute {
    return (path: string, req: IncomingMessage, res: ServerResponse): boolean => {
      if (path !== MAP_TILES_PATH && path !== MAP_SLICE_PATH) return false;
      const method = req.method ?? 'GET';
      const json = (status: number, body: unknown): void => {
        const text = JSON.stringify(body);
        const gz = text.length >= GZIP_MIN && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(gz ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}) });
        res.end(method === 'HEAD' ? undefined : gz ? gzipSync(text, { level: 6 }) : text);
      };
      if (method !== 'GET' && method !== 'HEAD') {
        json(405, { error: 'GET only' });
        return true;
      }
      const search = new URL(req.url ?? '/', 'http://localhost').searchParams;
      const p = path === MAP_TILES_PATH ? this.tilesAnswer(search) : this.sliceAnswer(search);
      p.then(
        (a) => json(200, a),
        (e: unknown) => json(path === MAP_SLICE_PATH ? 400 : 500, { error: e instanceof Error ? e.message : String(e) }),
      );
      return true;
    };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.windows.clear();
    this.log.debug(`map: stopped (${this.stats.messages} messages, ${this.stats.fetches} fetches, ${this.stats.slices} slices)`);
  }
}
