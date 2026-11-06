// The map screen (decision 0062, docs/map.md): the panel's main view on a phone. A full-screen canvas of
// the world cache's tiles (tiles.ts, painted by paint.ts), the overlays (overlays.ts), a compact HUD
// (health, food, the current job with its ETA, Stop), and the controls: drag to pan, pinch or wheel to
// zoom, follow the bot (off when you pan; the target button re-centres), layers (surface, classes,
// Y-slice) and overlay switches, box mode. Tap a block for the sheet (mapsheet.ts); in box mode drag a
// box, then drag its corners. At the closest zooms each column shows its block's top-face texture
// (GET /tex/<block>.png; a 404 keeps the colour). The view (map / cards) and the map's switches are kept
// in this browser (try/catch storage).
import { MAP_LIVE_TOPIC, MAP_PREFS_KEY, MARKS_REFRESH_MS, VIEW_KEY, type MapLiveJson, type PanelMarks } from '../shared.ts';
import { applyDelta, type DeltaOp, type Json } from './delta.ts';
import { dur, nice, num, type Ctx2D } from './dom.ts';
import { boxCorners, setupGestures } from './mapinput.ts';
import { MAP_OVERLAYS, type MapBox } from './mapdefs.ts';
import { setupSheet } from './mapsheet.ts';
import { drawOverlays, markers, nearMarkers, type Marker } from './overlays.ts';
import { setupTextures, TEX_ZOOM } from './maptex.ts';
import { mapDescribe, mapDescribeSlice, mapSurfaceAt } from './paint.ts';
import type { Lite, Page } from './page.ts';
import { setupTiles, type StoredTile } from './tiles.ts';


/** 2: ore markers off by default (an `ores` switch stored by version 1 is dropped once). */
const PREFS_V = 2;

interface Prefs {
  v: number;
  layer: 'surface' | 'class' | 'slice';
  ov: Record<string, boolean>;
  tex: boolean;
}

export function setupMapView(page: Page): (s: Lite) => void {
  const { ui } = page;
  const env = ui.env;
  const root = ui.doc.documentElement;
  const cv = ui.need('mapcv');
  const g: Ctx2D | null = cv.getContext?.('2d') ?? null;
  const dpr = (): number => env.window.devicePixelRatio ?? 1;
  const prefs: Prefs = { v: PREFS_V, layer: 'surface', ov: Object.fromEntries(MAP_OVERLAYS.map((o) => [o.id, o.on])), tex: true };
  try {
    const p = JSON.parse(ui.store.get(MAP_PREFS_KEY) ?? 'null') as Partial<Prefs> | null;
    if (p?.layer === 'class' || p?.layer === 'surface' || p?.layer === 'slice') prefs.layer = p.layer;
    if (p?.ov) for (const k of Object.keys(prefs.ov)) if (typeof p.ov[k] === 'boolean' && !(k === 'ores' && (p.v ?? 1) < 2)) prefs.ov[k] = p.ov[k];
    if (typeof p?.tex === 'boolean') prefs.tex = p.tex;
  } catch {
    /* a broken entry: the defaults */
  }
  const savePrefs = (): void => ui.store.set(MAP_PREFS_KEY, JSON.stringify(prefs));
  const on = (id: string): boolean => prefs.ov[id] !== false;

  const V = {
    x: page.last.self.pos?.x ?? 0,
    z: page.last.self.pos?.z ?? 0,
    scale: 3 * dpr(),
    follow: true,
    centred: !!page.last.self.pos,
    shown: false,
    live: null as MapLiveJson | null,
    marks: null as PanelMarks | null,
    marksAt: 0,
    marksKey: '',
    list: [] as Marker[],
    drawT: 0 as unknown,
    marksT: 0 as unknown,
    sel: null as { x: number; z: number } | null,
    boxMode: false,
    box: null as MapBox | null,
    y: 64,
  };
  const tiles = setupTiles(page, () => drawSoon());
  const sheet = setupSheet(page, () => {
    V.sel = null;
    if (!V.boxMode) V.box = null;
    drawSoon();
  });

  // ---- the view switch (map / cards), kept in this browser
  const setView = (map: boolean): void => {
    root.dataset.view = map ? 'map' : 'cards'; // the CSS shows one of the two (page.ts VIEW_BOOT set it first)
    ui.store.set(VIEW_KEY, map ? 'map' : 'cards');
    V.shown = map;
    tiles.pause(!map);
    if (map) {
      listen();
      layout();
      marksTick();
    }
  };
  ui.need('view-cards').addEventListener('click', () => setView(false));
  ui.need('view-map').addEventListener('click', () => setView(true));

  // ---- live overlays: the map-live topic (a snapshot, then deltas), else the polled tiles answer
  let listening = false;
  const listen = (): void => {
    if (listening) return; // joined the first time the map shows
    listening = true;
    page.listen(MAP_LIVE_TOPIC, (data) => {
      const m = JSON.parse(data) as { snap?: MapLiveJson; d?: DeltaOp[] };
      if (m.snap) V.live = m.snap;
      else if (m.d && V.live) V.live = applyDelta(V.live as unknown as Json, m.d) as unknown as MapLiveJson;
      afterLive();
    });
  };
  function afterLive(): void {
    if (V.follow && V.live?.bot) {
      V.x = V.live.bot[0];
      V.z = V.live.bot[2];
      V.centred = true;
    }
    if (V.shown) layout();
  }

  // ---- marks (chests, ores, beds ...): fetched for the window, again every MARKS_REFRESH_MS
  function refreshMarks(force = false): void {
    if (!V.shown) return;
    const cx = Math.floor(V.x / 16);
    const cz = Math.floor(V.z / 16);
    const r = Math.min(16, windowR());
    const k = `${Math.round(cx / 4)},${Math.round(cz / 4)},${r}`;
    if (!force && k === V.marksKey && Date.now() - V.marksAt < MARKS_REFRESH_MS) return;
    V.marksKey = k;
    V.marksAt = Date.now();
    void env
      .fetch(`/api/marks?cx=${cx}&cz=${cz}&r=${r}`, { cache: 'no-store', credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`marks ${res.status}`);
        V.marks = (await res.json()) as PanelMarks;
        drawSoon();
      })
      .catch((e: unknown) => env.console.debug(`panel: map marks: ${e instanceof Error ? e.message : String(e)}`));
  }
  /** Every 2 s while the map shows: the marks when due; without the stream the overlays of the last polled answer. */
  const marksTick = (): void => {
    env.clearTimeout(V.marksT);
    V.marksT = 0;
    if (!V.shown) return;
    refreshMarks();
    if (!page.streaming() && V.shown) {
      const l = tiles.polledLive() as MapLiveJson | undefined;
      if (l) {
        V.live = l;
        afterLive();
      }
    }
    V.marksT = env.setTimeout(marksTick, 2000);
  };

  // ---- geometry
  const W = (): number => cv.width;
  const H = (): number => cv.height;
  const toScreen = (x: number, z: number): [number, number] => [(x - V.x) * V.scale + W() / 2, (z - V.z) * V.scale + H() / 2];
  const toWorld = (sx: number, sy: number): [number, number] => [(sx - W() / 2) / V.scale + V.x, (sy - H() / 2) / V.scale + V.z];
  const windowR = (): number => Math.max(1, Math.min(16, Math.ceil(Math.max(W(), H()) / 2 / V.scale / 16) + 1));
  function layout(): void {
    const view = ui.need('mapscreen');
    const r = dpr();
    const w = Math.round((view.clientWidth || 360) * r);
    const h = Math.round((view.clientHeight || 640) * r);
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    tiles.want(Math.floor(V.x / 16), Math.floor(V.z / 16), windowR());
    refreshMarks();
    drawSoon();
  }
  // A throttle, not a debounce: during a pan the moves keep coming, and a timer reset on each one would
  // hold the frame back until the finger stops.
  const drawSoon = (): void => {
    if (!V.shown || V.drawT) return;
    V.drawT = env.setTimeout(() => {
      V.drawT = 0;
      draw();
    }, 16);
  };

  const tex = setupTextures(page, tiles, () => drawSoon());

  // ---- drawing
  function draw(): void {
    if (!V.shown || !g) return;
    const w = W();
    const h = H();
    const r = dpr();
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#0b0d10';
    g.fillRect(0, 0, w, h);
    const slice = prefs.layer === 'slice';
    const s = 16 * V.scale;
    const useTex = !slice && prefs.tex && prefs.layer === 'surface' && V.scale / r >= TEX_ZOOM;
    const src = slice ? tiles.slices : tiles.tiles;
    if (useTex) tex.frame();
    for (const t of src.values()) {
      const p = toScreen(t.dec.cx * 16, t.dec.cz * 16);
      if (p[0] > w || p[1] > h || p[0] + s < 0 || p[1] + s < 0) continue;
      const img = useTex ? (tex.of(t as StoredTile, 'block', 'auto') ?? t.img) : t.img;
      g.drawImage(img, p[0], p[1], s, s);
    }
    if (useTex && tex.pending()) drawSoon(); // the tiles over this frame's build budget come next frame
    V.list = markers(V.live, V.marks, on);
    drawOverlays(g, { scale: V.scale, dpr: r, toScreen }, V.live, V.list, on, w, h);
    const box = V.box;
    if (box) {
      const a = toScreen(Math.min(box.x1, box.x2), Math.min(box.z1, box.z2));
      const b = toScreen(Math.max(box.x1, box.x2) + 1, Math.max(box.z1, box.z2) + 1);
      g.fillStyle = 'rgba(245,197,66,0.18)';
      g.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
      g.strokeStyle = '#f5c542';
      g.lineWidth = 2 * r;
      g.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
      g.fillStyle = '#f5c542';
      for (const [cx, cz] of boxCorners(box)) {
        const q = toScreen(cx + 0.5, cz + 0.5);
        g.fillRect(q[0] - 7 * r, q[1] - 7 * r, 14 * r, 14 * r);
      }
    }
    if (V.sel) {
      const q = toScreen(V.sel.x, V.sel.z);
      const k = Math.max(V.scale, 6 * r);
      g.strokeStyle = '#ffffff';
      g.lineWidth = 2 * r;
      g.strokeRect(q[0] - (k - V.scale) / 2, q[1] - (k - V.scale) / 2, k, k);
    }
    const i = tiles.info();
    ui.text('map-status', `${i.tiles} chunks${slice ? `, slice y ${tiles.sliceY() ?? '-'} (${i.slices})` : ''}${page.streaming() ? '' : ', polling'}`);
  }

  // ---- what a tap finds
  function tapAt(bx: number, bz: number): void {
    const slice = prefs.layer === 'slice';
    const t = tiles.tile(bx, bz);
    const i = ((bz & 15) << 4) | (bx & 15);
    const lines: string[] = [];
    let title = `${bx} ${bz}: unknown`;
    let y: number | null = null;
    let block: string | null = null;
    if (slice) {
      const sl = tiles.slice(bx, bz);
      y = tiles.sliceY();
      if (sl) {
        title = `${bx} ${y} ${bz}: ${mapDescribeSlice(sl.dec, i)}`;
        block = sl.dec.names?.[i] ?? (sl.dec.cls[i] === 0 ? null : 'unknown');
      }
    } else if (t) {
      title = `${bx} ${bz}: ${mapDescribe(t.dec, 'auto', i)}`;
      const top = mapSurfaceAt(t.dec, 'auto', i);
      y = top?.y ?? (t.dec.ys[i] === -32768 ? null : t.dec.ys[i]!);
      block = top?.name ?? null;
    }
    if (t) lines.push(t.dec.live ? 'loaded now' : `remembered, seen ${dur((Date.now() - t.dec.updatedAt) / 1000)} ago`);
    for (const m of nearMarkers(markers(V.live, V.marks, on), bx, bz)) {
      lines.push(`${m.label}${m.y !== null && m.overlay !== 'ores' ? ` (y ${Math.round(m.y)})` : ''}`);
      for (const l of m.more ?? []) lines.push(`  ${l}`);
    }
    const inv = page.last.inventory;
    const elytra = !!inv && (inv.armour.some((a) => a?.name === 'elytra') || inv.slots.some((a) => a?.name === 'elytra'));
    const bot = V.live?.bot ? { x: V.live.bot[0], y: V.live.bot[1], z: V.live.bot[2] } : page.last.self.pos ?? null;
    V.sel = { x: bx, z: bz };
    sheet.openPoint({ title, lines, ctx: { x: bx, z: bz, y, block, bot, elytra } });
    drawSoon();
  }
  /** The surface range of the box's columns (the default y range), null when none is known. */
  function surfaceRange(b: MapBox): [number, number] | null {
    let lo = Infinity;
    let hi = -Infinity;
    for (let x = Math.min(b.x1, b.x2); x <= Math.max(b.x1, b.x2); x++) {
      for (let z = Math.min(b.z1, b.z2); z <= Math.max(b.z1, b.z2); z++) {
        const t = tiles.tile(x, z);
        const s = t ? mapSurfaceAt(t.dec, 'auto', ((z & 15) << 4) | (x & 15)) : null;
        if (!s) continue;
        lo = Math.min(lo, s.y);
        hi = Math.max(hi, s.y);
      }
    }
    return lo === Infinity ? null : [lo, hi];
  }

  const setFollow = (f: boolean): void => {
    V.follow = f;
    ui.need('map-follow').classList.toggle('on', f);
    if (f) afterLive();
  };
  const boxSheet = (end: boolean): void => {
    const b = V.box;
    if (!b) return;
    if (sheet.isOpen() && sheet.box()) sheet.moveBox(b);
    else if (end) sheet.openBox(b, surfaceRange(b));
    drawSoon();
  };
  const { zoomAt } = setupGestures(cv, {
    V,
    dpr,
    toWorld,
    toScreen,
    layout,
    drawSoon,
    setFollow,
    tap: tapAt,
    boxMoved: boxSheet,
    boxTap: (bx, bz) => {
      V.box = { x1: bx, z1: bz, x2: bx, z2: bz, y1: 0, y2: 0 };
      sheet.openBox(V.box, surfaceRange(V.box));
      drawSoon();
    },
  });
  ui.need('map-zin').addEventListener('click', () => zoomAt(W() / 2, H() / 2, 1.5));
  ui.need('map-zout').addEventListener('click', () => zoomAt(W() / 2, H() / 2, 1 / 1.5));
  ui.need('map-follow').addEventListener('click', () => setFollow(true));
  const boxBtn = ui.need('map-box');
  boxBtn.addEventListener('click', () => {
    V.boxMode = !V.boxMode;
    boxBtn.classList.toggle('on', V.boxMode);
    if (!V.boxMode) {
      V.box = null;
      if (sheet.box()) sheet.close();
    }
    page.toast(V.boxMode ? 'box mode: drag a box on the map, then drag its corners' : 'box mode off');
    drawSoon();
  });

  // ---- layers and overlay switches
  const layersPanel = ui.need('map-layers');
  ui.need('map-layers-btn').addEventListener('click', () => {
    layersPanel.hidden = !layersPanel.hidden;
  });
  const yv = ui.need('map-y');
  function applyLayer(): void {
    tiles.setPaint(prefs.layer === 'class' ? 'class' : 'block', 'auto');
    tiles.setSlice(prefs.layer === 'slice' ? V.y : null);
    ui.need('map-slice').hidden = prefs.layer !== 'slice';
    ui.text('map-yv', `y ${V.y}`);
    for (const e of ui.doc.querySelectorAll('[data-layer]')) e.checked = e.dataset.layer === prefs.layer;
    drawSoon();
  }
  for (const e of ui.doc.querySelectorAll('[data-layer]')) {
    e.addEventListener('change', () => {
      if (!e.checked) return;
      prefs.layer = (e.dataset.layer as Prefs['layer']) ?? 'surface';
      if (prefs.layer === 'slice') V.y = Math.floor(V.live?.bot?.[1] ?? page.last.self.pos?.y ?? 64);
      yv.value = String(V.y);
      savePrefs();
      applyLayer();
    });
  }
  const setY = (y: number): void => {
    V.y = Math.max(-64, Math.min(319, Math.round(y)));
    yv.value = String(V.y);
    applyLayer();
  };
  yv.addEventListener('input', () => setY(Number(yv.value)));
  ui.need('map-ydown').addEventListener('click', () => setY(V.y - 1));
  ui.need('map-yup').addEventListener('click', () => setY(V.y + 1));
  for (const e of ui.doc.querySelectorAll('[data-ov]')) {
    const id = e.dataset.ov ?? '';
    e.checked = on(id);
    e.addEventListener('change', () => {
      prefs.ov[id] = !!e.checked;
      savePrefs();
      drawSoon();
    });
  }
  const texBox = ui.need('map-tex');
  texBox.checked = prefs.tex;
  texBox.addEventListener('change', () => {
    prefs.tex = !!texBox.checked;
    savePrefs();
    drawSoon();
  });
  ui.need('hud-stop').addEventListener('click', () => void page.send('!stop', true));
  env.window.addEventListener('resize', () => {
    if (V.shown) layout();
  });
  if (prefs.layer === 'slice') prefs.layer = 'surface'; // a slice needs a height: start on the surface
  applyLayer();
  setView(ui.store.get(VIEW_KEY) !== 'cards');
  setFollow(true);

  /** The HUD from the state (health, food, the job and its ETA). */
  return (s: Lite): void => {
    if (!V.centred && s.self.pos && V.follow && !V.live) {
      V.x = s.self.pos.x;
      V.z = s.self.pos.z;
      V.centred = true;
      if (V.shown) layout();
    }
    ui.text('hud-hp', `${num(s.self.health)}`);
    ui.text('hud-food', `${num(s.self.food)}`);
    ui.width('hud-hpbar', ((s.self.health ?? 0) / 20) * 100);
    ui.width('hud-foodbar', ((s.self.food ?? 0) / 20) * 100);
    const j = s.job;
    ui.text('hud-job', j ? `${nice(j.name)}: ${j.line ?? j.state}${j.etaS != null ? `, eta ${dur(j.etaS)}` : ''}` : 'idle');
  };
}
