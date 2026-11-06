// The map screen's tiles (decision 0062, docs/map.md "Wire"): what the page knows of the world cache in
// its window, kept current without polling. A window change (a pan, the bot walking on in follow mode, a
// zoom) is one incremental GET /api/map/tiles (only the tiles new to the window; the fetch also registers
// the window with the server), and the `map` topic brings the tiles that change; a message whose `from`
// is newer than our rev means we missed one, so we fetch again with since = our rev. The palette is the
// server's global one, sent once (each answer or message carries only the entries we lack). Without the
// stream (old browser, proxy) the store polls the same route every MAP_POLL_MS. Y-slices are fetched per
// height and window (GET /api/map/slice). Painting is paint.ts, the same code as the debug page.
import { MAP_POLL_MS, MAP_SLICE_PATH, MAP_TILES_PATH, MAP_TOPIC, WINDOW_TOUCH_MS, type CompactTileJson, type SliceTileJson } from '../shared.ts';
import type { El } from './dom.ts';
import { mapDecodeSlice, mapDecodeTile, mapPixels, mapSlicePixels, type DecodedSlice, type DecodedTile, type LayerPref, type PaintMode, type PaintPaletteEntry } from './paint.ts';
import type { Page } from './page.ts';

export interface ChunkWindow {
  cx0: number;
  cz0: number;
  cx1: number;
  cz1: number;
}

export interface StoredTile {
  raw: CompactTileJson;
  dec: DecodedTile;
  img: El;
  /** Names of the tile's surface (for the textures). */
  names: Set<string>;
  /** The textured canvas of the closest zooms (mapview.ts), dropped when the tile changes. */
  tex?: El | null;
}

export interface StoredSlice {
  dec: DecodedSlice;
  img: El;
}

interface TilesAnswer {
  dim: number;
  rev: number;
  window: ChunkWindow;
  tiles: CompactTileJson[];
  palFrom: number;
  palette: PaintPaletteEntry[];
  live?: unknown;
}

interface MapMessage {
  from: number;
  rev: number;
  dim: number;
  reset?: boolean;
  tiles?: CompactTileJson[];
  palFrom?: number;
  palette?: PaintPaletteEntry[];
}

export interface TileStore {
  readonly tiles: Map<string, StoredTile>;
  readonly slices: Map<string, StoredSlice>;
  readonly palette: (PaintPaletteEntry | undefined)[];
  /** Ask for this window (the view decides it); fetches when it moved or grew. */
  want(cx: number, cz: number, r: number): void;
  /** The tiles' paint mode and layer (repaints every tile when it changed). */
  setPaint(mode: PaintMode, pref: LayerPref): void;
  /** The Y-slice to show (null: none); fetched for the current window. */
  setSlice(y: number | null): void;
  sliceY(): number | null;
  tile(bx: number, bz: number): StoredTile | undefined;
  slice(bx: number, bz: number): StoredSlice | undefined;
  /** Counts for the status line and the tests. */
  info(): { tiles: number; slices: number; rev: number; fetches: number; messages: number; gaps: number; palette: number; dim: number };
  /** The `live` part of the last polled answer (fallback without the stream), or undefined. */
  polledLive(): unknown;
  /** Stop asking (the map view is hidden). */
  pause(on: boolean): void;
}

export function setupTiles(page: Page, changed: () => void): TileStore {
  const { ui } = page;
  const env = ui.env;
  const tiles = new Map<string, StoredTile>();
  const slices = new Map<string, StoredSlice>();
  const palette: (PaintPaletteEntry | undefined)[] = [];
  const cid = `m${Math.floor(Math.random() * 1e9).toString(36)}`;
  const S = {
    rev: -1,
    dim: 0,
    win: null as ChunkWindow | null,
    want: null as { cx: number; cz: number; r: number } | null,
    mode: 'block' as PaintMode,
    pref: 'auto' as LayerPref,
    sliceY: null as number | null,
    sliceWin: '',
    busy: false,
    again: false,
    touchedAt: 0,
    fetches: 0,
    messages: 0,
    gaps: 0,
    paused: true,
    live: undefined as unknown,
    pollT: 0 as unknown,
    sliceT: 0 as unknown,
  };
  const key = (cx: number, cz: number): string => `${cx},${cz}`;
  const now = (): number => Date.now();

  function paint(t: StoredTile): void {
    const north = tiles.get(key(t.dec.cx, t.dec.cz - 1));
    const g = t.img.getContext?.('2d');
    if (!g) return;
    const img = g.createImageData(16, 16);
    img.data.set(mapPixels(t.dec, S.mode, S.pref, north ? north.dec : null, now()));
    g.putImageData(img, 0, 0);
    t.tex = undefined;
  }

  function add(raw: CompactTileJson): StoredTile {
    const k = key(raw.cx, raw.cz);
    const old = tiles.get(k);
    const img = old?.img ?? ui.el('canvas');
    img.width = 16;
    img.height = 16;
    const dec = mapDecodeTile(raw, palette);
    const names = new Set<string>();
    if (dec.top) for (const n of dec.top.names) if (n) names.add(n);
    const t: StoredTile = { raw, dec, img, names };
    tiles.set(k, t);
    return t;
  }

  /** New tiles painted, and the tile south of each (its row 0 compares with the new tile). */
  function paintNew(fresh: StoredTile[]): void {
    const again = new Set(fresh);
    for (const t of fresh) {
      const s = tiles.get(key(t.dec.cx, t.dec.cz + 1));
      if (s) again.add(s);
    }
    for (const t of again) paint(t);
  }

  /** Palette entries from index `from` on; a hole before them (entries we never got) is fetched again. */
  function addPalette(from: number | undefined, entries: PaintPaletteEntry[] | undefined): boolean {
    if (from === undefined || !entries?.length) return false;
    const holeBefore = palette.length < from;
    for (let i = 0; i < entries.length; i++) palette[from + i] = entries[i];
    return holeBefore;
  }
  const knownPalette = (): number => {
    let n = 0;
    while (n < palette.length && palette[n] !== undefined) n++;
    return n;
  };

  function drop(w: ChunkWindow): void {
    for (const [k, t] of tiles) if (t.dec.cx < w.cx0 - 2 || t.dec.cx > w.cx1 + 2 || t.dec.cz < w.cz0 - 2 || t.dec.cz > w.cz1 + 2) tiles.delete(k);
  }

  async function fetchTiles(full: boolean): Promise<void> {
    const w = S.want;
    if (!w || S.paused) return;
    if (S.busy) {
      S.again = true;
      return;
    }
    S.busy = true;
    try {
      const p = new URLSearchParams({ cid, r: String(w.r), cx: String(w.cx), cz: String(w.cz), pal: String(knownPalette()) });
      if (!full && S.win && S.rev >= 0) {
        p.set('since', String(S.rev));
        p.set('win', [S.win.cx0, S.win.cz0, S.win.cx1, S.win.cz1].join(','));
      }
      if (!page.streaming()) p.set('live', '1');
      const res = await env.fetch(`${MAP_TILES_PATH}?${p.toString()}`, { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) throw new Error(`tiles ${res.status}`);
      const a = (await res.json()) as TilesAnswer;
      S.fetches++;
      if (a.dim !== S.dim) {
        tiles.clear();
        slices.clear();
        S.dim = a.dim;
      }
      const hole = addPalette(a.palFrom, a.palette);
      if (hole) S.again = true;
      paintNew(a.tiles.map(add));
      S.win = a.window;
      S.rev = Math.max(S.rev, a.rev);
      S.touchedAt = now();
      S.live = a.live;
      drop(a.window);
      changed();
    } catch (e) {
      env.console.debug(`panel: map tiles: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      S.busy = false;
    }
    if (S.again) {
      S.again = false;
      void fetchTiles(false);
    }
  }

  function onMessage(data: string): void {
    const m = JSON.parse(data) as MapMessage;
    S.messages++;
    if (m.reset || m.dim !== S.dim) {
      tiles.clear();
      slices.clear();
      S.dim = m.dim;
      S.rev = -1;
      S.win = null;
      void fetchTiles(true);
      return;
    }
    if (S.rev < 0) return; // our first answer is on its way; it is at least as new
    const hole = addPalette(m.palFrom, m.palette);
    if (m.from > S.rev || hole) {
      S.gaps++; // we missed a message (a stream that did not resume): fetch what changed since our rev
      void fetchTiles(false);
      return;
    }
    if (m.rev <= S.rev && !m.tiles?.length) return;
    const w = S.win;
    const fresh = (m.tiles ?? []).filter((t) => !w || (t.cx >= w.cx0 - 2 && t.cx <= w.cx1 + 2 && t.cz >= w.cz0 - 2 && t.cz <= w.cz1 + 2)).map(add);
    S.rev = Math.max(S.rev, m.rev);
    if (fresh.length) {
      paintNew(fresh);
      changed();
    }
  }
  /** The topic is joined the first time the map shows (a page that stays on the cards never carries it). */
  let listening = false;
  const listen = (): void => {
    if (listening) return;
    listening = true;
    page.listen(MAP_TOPIC, (data) => {
      try {
        onMessage(data);
      } catch (e) {
        env.console.debug(`panel: map message: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  };

  /** Every MAP_POLL_MS while the map shows: without the stream poll the tiles (incremental); with it only refresh the window's registration now and then. */
  function tick(): void {
    env.clearTimeout(S.pollT);
    S.pollT = 0;
    if (S.paused) return;
    if (!page.streaming() || now() - S.touchedAt > WINDOW_TOUCH_MS) void fetchTiles(false);
    if (S.sliceY !== null && !page.streaming()) void fetchSlice();
    S.pollT = env.setTimeout(tick, MAP_POLL_MS);
  }

  async function fetchSlice(): Promise<void> {
    const w = S.want;
    if (!w || S.sliceY === null || S.paused) return;
    const y = S.sliceY;
    const r = Math.min(8, w.r);
    const p = new URLSearchParams({ y: String(y), cx: String(w.cx), cz: String(w.cz), r: String(r), pal: String(knownPalette()) });
    S.sliceWin = `${y}:${w.cx},${w.cz},${r}`;
    try {
      const res = await env.fetch(`${MAP_SLICE_PATH}?${p.toString()}`, { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) throw new Error(`slice ${res.status}`);
      const a = (await res.json()) as { y: number; tiles: SliceTileJson[]; palFrom: number; palette: PaintPaletteEntry[] };
      if (a.y !== S.sliceY) return;
      addPalette(a.palFrom, a.palette);
      slices.clear();
      for (const t of a.tiles) {
        const img = ui.el('canvas');
        img.width = 16;
        img.height = 16;
        const dec = mapDecodeSlice(t, palette);
        const g = img.getContext?.('2d');
        if (g) {
          const id = g.createImageData(16, 16);
          id.data.set(mapSlicePixels(dec, now()));
          g.putImageData(id, 0, 0);
        }
        slices.set(key(t.cx, t.cz), { dec, img });
      }
      changed();
    } catch (e) {
      env.console.debug(`panel: map slice: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const sliceSoon = (): void => {
    env.clearTimeout(S.sliceT);
    S.sliceT = env.setTimeout(() => void fetchSlice(), 250);
  };

  return {
    tiles,
    slices,
    palette,
    want(cx, cz, r) {
      const old = S.want;
      S.want = { cx, cz, r };
      if (S.busy && old?.cx === cx && old.cz === cz && old.r === r) return; // that window's answer is on its way
      const w = S.win;
      // fetch when the needed window leaves the registered one (a margin of 1 chunk) or grows
      const inside = w && cx - r >= w.cx0 - 1 && cx + r <= w.cx1 + 1 && cz - r >= w.cz0 - 1 && cz + r <= w.cz1 + 1 && 2 * r + 1 <= w.cx1 - w.cx0 + 3;
      if (!inside || !old) void fetchTiles(false);
      if (S.sliceY !== null && S.sliceWin !== `${S.sliceY}:${cx},${cz},${Math.min(8, r)}` && (!old || Math.abs(old.cx - cx) + Math.abs(old.cz - cz) > 1 || old.r !== r)) sliceSoon();
    },
    setPaint(mode, pref) {
      if (mode === S.mode && pref === S.pref) return;
      S.mode = mode;
      S.pref = pref;
      for (const t of tiles.values()) paint(t);
      changed();
    },
    setSlice(y) {
      if (y === S.sliceY) return;
      S.sliceY = y;
      if (y === null) {
        slices.clear();
        changed();
      } else sliceSoon();
    },
    sliceY: () => S.sliceY,
    tile: (bx, bz) => tiles.get(key(bx >> 4, bz >> 4)),
    slice: (bx, bz) => slices.get(key(bx >> 4, bz >> 4)),
    info: () => ({ tiles: tiles.size, slices: slices.size, rev: S.rev, fetches: S.fetches, messages: S.messages, gaps: S.gaps, palette: knownPalette(), dim: S.dim }),
    polledLive: () => S.live,
    pause(on) {
      const was = S.paused;
      S.paused = on;
      if (!on) listen();
      if (was && !on) {
        void fetchTiles(S.rev < 0);
        if (S.sliceY !== null) sliceSoon();
        env.clearTimeout(S.pollT);
        S.pollT = env.setTimeout(tick, MAP_POLL_MS);
      }
    },
  };
}
