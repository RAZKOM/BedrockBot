// Track AR (docs/panel.md "Map"): the panel's own map, drawn only while its section is open: /map.json
// tiles (surface y and class per column), the bot as an arrow, the trail, path and goal, home, shelter,
// waypoints, and every 5th poll /api/marks for the remembered chests and herds; drag, zoom, follow; a
// right-click or long-press opens the column's menu (menu.ts mapActions). The map-first screen of the
// web panel programme (step 2) replaces this section; until then it stays as it was.
import { MAP_POLL_MS, type MapJson, type MapTileJson, type PanelMarks } from '../shared.ts';
import { nice, orElse, why, type Ctx2D, type El, type Ev } from './dom.ts';
import { mapActions } from './menu.ts';
import type { Page } from './page.ts';

const MAP_COL: Record<string, string> = { bot: '#ffffff', path: '#f5c542', home: '#4ce08a', shelter: '#c08cff', wp: '#5cd6ff', chest: '#b5793a', herd: '#b0e57c', hostile: '#ff5050', player: '#e8e8e8', passive: '#9fcf6a', neutral: '#ffa94d', item: '#ffd27f', other: '#cccccc' };
const NOTHING = -32768;

interface Tile {
  t: MapTileJson;
  img: El;
  ys: Int16Array;
  cs: Uint8Array;
}
/** [x, z, colour, label, kind] */
type Marker = [number, number, string, string, 'sq' | 'wp' | 'chest' | 'herd' | 'ent' | 'bot'];
interface Column {
  y: number | null;
  cls: number;
  live: boolean;
}

// The class colours (land / water / lava / unknown) duplicate health/map/paint.ts (decision 0060,
// PAINT_JS for /map). The map redesign (programme step 2) moves them to one place both pages import.
function tileColour(cls: number, y: number, live: boolean): number[] {
  let c = cls === 2 ? [47, 111, 208] : cls === 3 ? [224, 83, 31] : cls === 1 ? (y > 90 ? [150, 150, 140] : [72 + Math.max(0, Math.min(60, y)), 130, 56]) : [24, 26, 30];
  if (cls === 1) {
    const f = 0.8 + (((y % 4) + 4) % 4) / 10;
    c = c.map((v) => Math.min(255, v * f));
  }
  return live ? c : c.map((v) => v * 0.55);
}

export function setupMap(page: Page): void {
  const { ui } = page;
  const env = ui.env;
  const M = {
    on: false,
    cv: null as El | null,
    g: null as Ctx2D | null,
    tiles: new Map<string, Tile>(),
    data: null as MapJson | null,
    marks: { chests: [], herds: [] } as PanelMarks,
    since: -1,
    win: null as MapJson['window'] | null,
    scale: 4,
    view: { x: 0, z: 0 },
    t: 0 as unknown,
    n: 0,
    busy: false,
    down: null as { x: number; y: number; vx: number; vz: number; moved: boolean } | null,
    lp: 0,
    lpT: 0 as unknown,
  };
  const b64 = (s: string): Uint8Array => {
    const bin = env.atob(s);
    const a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  };
  function tileImage(t: MapTileJson): Tile {
    const ys = new Int16Array(b64(t.y).buffer);
    const cs = b64(t.c);
    const c = ui.doc.createElement('canvas');
    c.width = 16;
    c.height = 16;
    const g = c.getContext?.('2d');
    if (g) {
      const img = g.createImageData(16, 16);
      for (let i = 0; i < 256; i++) {
        const cls = (cs[i >> 2]! >> ((i & 3) * 2)) & 3;
        const y = ys[i]!;
        const rgb = y === NOTHING ? [24, 26, 30] : tileColour(cls, y, t.live);
        const o = i * 4;
        img.data[o] = rgb[0]!;
        img.data[o + 1] = rgb[1]!;
        img.data[o + 2] = rgb[2]!;
        img.data[o + 3] = 255;
      }
      g.putImageData(img, 0, 0);
    }
    return { t, img: c, ys, cs };
  }
  const dpr = (): number => env.window.devicePixelRatio ?? 1;
  const cv = (): El => M.cv!;
  const toScreen = (x: number, z: number): [number, number] => [(x - M.view.x) * M.scale + cv().width / 2, (z - M.view.z) * M.scale + cv().height / 2];
  const toWorld = (sx: number, sy: number): [number, number] => [(sx - cv().width / 2) / M.scale + M.view.x, (sy - cv().height / 2) / M.scale + M.view.z];
  /** Surface y and class of a column (null: not in the cache). */
  function column(bx: number, bz: number): Column | null {
    const tile = M.tiles.get(`${bx >> 4},${bz >> 4}`);
    if (!tile) return null;
    const i = ((bz & 15) << 4) | (bx & 15);
    const y = tile.ys[i]!;
    return { y: y === NOTHING ? null : y, cls: (tile.cs[i >> 2]! >> ((i & 3) * 2)) & 3, live: tile.t.live };
  }
  function markers(): Marker[] {
    const d = M.data;
    const out: Marker[] = [];
    if (!d) return out;
    if (d.home) out.push([d.home.x + 0.5, d.home.z + 0.5, MAP_COL.home!, 'home', 'sq']);
    if (d.shelter) out.push([d.shelter.x + 0.5, d.shelter.z + 0.5, MAP_COL.shelter!, 'shelter', 'sq']);
    for (const w of d.waypoints) out.push([w.x + 0.5, w.z + 0.5, MAP_COL.wp!, `waypoint ${w.name}`, 'wp']);
    for (const c of M.marks.chests) out.push([c.x + 0.5, c.z + 0.5, MAP_COL.chest!, `${nice(c.kind)}${c.label ? ` "${c.label}"` : ''}${c.unreachable ? ' (unreachable)' : ''}`, 'chest']);
    for (const h of M.marks.herds) out.push([h.x, h.z, MAP_COL.herd!, `herd: ${h.n} ${nice(h.kind)}${h.penned ? ' (penned)' : ''}`, 'herd']);
    for (const e of d.entities) if (e.kind !== 'item') out.push([e.x, e.z, MAP_COL[e.kind] ?? MAP_COL.other!, orElse(e.name, nice(e.type)), 'ent']);
    if (d.bot) out.push([d.bot.x, d.bot.z, MAP_COL.bot!, `bot ${d.bot.x.toFixed(1)} ${d.bot.y.toFixed(1)} ${d.bot.z.toFixed(1)}`, 'bot']);
    return out;
  }
  function draw(): void {
    if (!M.on || !M.g) return;
    const g = M.g;
    const c = cv();
    const view = ui.need('mapview');
    const r = dpr();
    const w = Math.round(view.clientWidth * r);
    const h = Math.round(view.clientHeight * r);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#0b0d10';
    g.fillRect(0, 0, w, h);
    for (const { t, img } of M.tiles.values()) {
      const p = toScreen(t.cx * 16, t.cz * 16);
      const s = 16 * M.scale;
      if (p[0] > w || p[1] > h || p[0] + s < 0 || p[1] + s < 0) continue;
      g.drawImage(img, p[0], p[1], s, s);
    }
    const d = M.data;
    if (!d) return;
    const line = (pts: { x: number; z: number }[] | null | undefined, style: string, lw: number): void => {
      if (!pts || pts.length < 2) return;
      g.strokeStyle = style;
      g.lineWidth = lw * r;
      g.beginPath();
      pts.forEach((p, i) => {
        const q = toScreen(p.x, p.z);
        if (i) g.lineTo(q[0], q[1]);
        else g.moveTo(q[0], q[1]);
      });
      g.stroke();
    };
    line(d.trail, 'rgba(255,255,255,0.35)', 1.5);
    line(d.nav.path?.map((p) => ({ x: p.x + 0.5, z: p.z + 0.5 })), MAP_COL.path!, 2.5);
    if (d.nav.goal) {
      const q = toScreen(d.nav.goal.x + 0.5, d.nav.goal.z + 0.5);
      const k = 6 * r;
      g.strokeStyle = MAP_COL.path!;
      g.lineWidth = 2 * r;
      g.beginPath();
      g.moveTo(q[0] - k, q[1] - k);
      g.lineTo(q[0] + k, q[1] + k);
      g.moveTo(q[0] + k, q[1] - k);
      g.lineTo(q[0] - k, q[1] + k);
      g.stroke();
    }
    for (const m of markers()) {
      const q = toScreen(m[0], m[1]);
      const k = (m[4] === 'ent' || m[4] === 'chest' ? 3 : 5) * r;
      g.fillStyle = m[2];
      g.strokeStyle = '#000';
      g.lineWidth = r;
      if (m[4] === 'bot' && d.bot) {
        const yaw = (d.bot.yaw * Math.PI) / 180;
        const dx = -Math.sin(yaw);
        const dz = Math.cos(yaw);
        const a = 10 * r;
        const b = 6 * r;
        g.beginPath();
        g.moveTo(q[0] + dx * a, q[1] + dz * a);
        g.lineTo(q[0] - dx * b - dz * b, q[1] - dz * b + dx * b);
        g.lineTo(q[0] - dx * b + dz * b, q[1] - dz * b - dx * b);
        g.closePath();
        g.fill();
        g.stroke();
      } else if (m[4] === 'herd' || m[4] === 'ent') {
        g.beginPath();
        g.arc(q[0], q[1], k, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      } else if (m[4] === 'wp') {
        g.beginPath();
        g.moveTo(q[0], q[1] - k);
        g.lineTo(q[0] + k, q[1]);
        g.lineTo(q[0], q[1] + k);
        g.lineTo(q[0] - k, q[1]);
        g.closePath();
        g.fill();
        g.stroke();
      } else {
        g.fillRect(q[0] - k, q[1] - k, 2 * k, 2 * k);
        g.strokeRect(q[0] - k, q[1] - k, 2 * k, 2 * k);
      }
    }
  }
  /** What is under a canvas point: the nearest marker within 10 px, else the column. */
  function describeAt(sx: number, sy: number): { bx: number; bz: number; c: Column | null; text: string } {
    let best: Marker | null = null;
    let bd = 10 * dpr();
    for (const m of markers()) {
      const q = toScreen(m[0], m[1]);
      const dd = Math.hypot(q[0] - sx, q[1] - sy);
      if (dd < bd) {
        bd = dd;
        best = m;
      }
    }
    const wpt = toWorld(sx, sy);
    const bx = Math.floor(wpt[0]);
    const bz = Math.floor(wpt[1]);
    const c = column(bx, bz);
    const col = `${bx} ${bz}: ${!c ? 'unknown' : c.y === null ? 'nothing' : `${['air', 'solid', 'water', 'avoid'][c.cls]} at y ${c.y}${c.live ? '' : ' (remembered)'}`}`;
    return { bx, bz, c, text: best ? `${best[3]} (${col})` : col };
  }
  const getJson = async <T>(url: string): Promise<T> => {
    const res = await env.fetch(url, { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) throw new Error(`${url.split('?')[0]} ${res.status}`);
    return (await res.json()) as T;
  };
  async function poll(): Promise<void> {
    env.clearTimeout(M.t);
    if (!M.on) return;
    if (!M.busy) {
      M.busy = true;
      try {
        const follow = ui.need('map-follow').checked;
        const p = new URLSearchParams({ r: ui.need('map-r').value, since: String(M.since) });
        if (!follow) {
          p.set('cx', String(Math.floor(M.view.x / 16)));
          p.set('cz', String(Math.floor(M.view.z / 16)));
        }
        if (M.win) p.set('win', [M.win.cx0, M.win.cz0, M.win.cx1, M.win.cz1].join(','));
        const d = await getJson<MapJson>(`/map.json?${p.toString()}`);
        for (const t of d.tiles) M.tiles.set(`${t.cx},${t.cz}`, tileImage(t));
        const w0 = d.window;
        for (const [k, v] of M.tiles) if (v.t.cx < w0.cx0 - 2 || v.t.cx > w0.cx1 + 2 || v.t.cz < w0.cz0 - 2 || v.t.cz > w0.cz1 + 2) M.tiles.delete(k);
        M.win = w0;
        M.since = d.rev;
        M.data = d;
        if (follow && d.bot) M.view = { x: d.bot.x, z: d.bot.z };
        if (M.n++ % 5 === 0) {
          try {
            M.marks = await getJson<PanelMarks>('/api/marks');
          } catch {
            /* the markers stay as they were */
          }
        }
        ui.text('map-info', `${d.nav.busy ? 'walking' : 'idle'}${d.nav.result ? `, last goto ${d.nav.result}` : ''}; ${M.marks.chests.length} chests, ${M.marks.herds.length} herds`);
      } catch (e) {
        ui.text('map-info', `map: ${why(e)}`);
      }
      M.busy = false;
      draw();
    }
    M.t = env.setTimeout(poll, MAP_POLL_MS);
  }
  function point(ev: Ev | undefined): [number, number] {
    const r = cv().getBoundingClientRect?.() ?? { left: 0, top: 0 };
    return [((ev?.clientX ?? 0) - r.left) * dpr(), ((ev?.clientY ?? 0) - r.top) * dpr()];
  }
  function columnMenu(ev: Ev | undefined): void {
    const p = point(ev);
    const at = describeAt(p[0], p[1]);
    const key = `map:${at.bx},${at.bz}`;
    if (page.menuKey() === key && !ui.need('menu').hidden) return;
    page.openMenu(key, at.text, mapActions(at.bx, at.bz, at.c ? at.c.y : null, M.data?.bot ? M.data.bot.y : null), ev?.clientX ?? 0, ev?.clientY ?? 0);
  }
  function tip(ev: Ev | undefined): void {
    const p = point(ev);
    const at = describeAt(p[0], p[1]);
    const t = ui.need('maptip');
    const r = cv().getBoundingClientRect?.() ?? { left: 0, top: 0, width: 400 };
    t.textContent = at.text;
    t.hidden = false;
    t.style.left = `${Math.min((ev?.clientX ?? 0) - r.left + 12, r.width - 160)}px`;
    t.style.top = `${(ev?.clientY ?? 0) - r.top + 12}px`;
  }
  function init(): void {
    const c = ui.need('mapcv');
    M.cv = c;
    M.g = c.getContext?.('2d') ?? null;
    c.addEventListener('contextmenu', (ev) => {
      ev?.preventDefault?.();
      if (Date.now() - M.lp < 800) return;
      columnMenu(ev);
    });
    c.addEventListener('pointerdown', (ev) => {
      M.down = { x: ev?.clientX ?? 0, y: ev?.clientY ?? 0, vx: M.view.x, vz: M.view.z, moved: false };
      if (ev?.pointerId !== undefined) c.setPointerCapture?.(ev.pointerId);
      env.clearTimeout(M.lpT);
      if (ev?.pointerType !== 'mouse')
        M.lpT = env.setTimeout(() => {
          if (M.down && !M.down.moved) {
            M.lp = Date.now();
            columnMenu(ev);
          }
        }, 550);
    });
    c.addEventListener('pointermove', (ev) => {
      const d = M.down;
      if (d) {
        const x = ev?.clientX ?? 0;
        const y = ev?.clientY ?? 0;
        if (!d.moved && Math.hypot(x - d.x, y - d.y) > 8) {
          d.moved = true;
          env.clearTimeout(M.lpT);
        }
        if (d.moved) {
          ui.need('map-follow').checked = false;
          M.view = { x: d.vx - ((x - d.x) * dpr()) / M.scale, z: d.vz - ((y - d.y) * dpr()) / M.scale };
          draw();
        }
      } else if (ev?.pointerType === 'mouse') tip(ev);
    });
    const up = (ev?: Ev): void => {
      env.clearTimeout(M.lpT);
      const d = M.down;
      M.down = null;
      if (!d || d.moved || ev?.type !== 'pointerup' || Date.now() - M.lp < 800) return;
      if (ev.button === 0 && !ui.need('menu').hidden && page.menuKey()?.startsWith('map:')) page.closeMenu();
      tip(ev);
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', () => {
      ui.need('maptip').hidden = true;
    });
    c.addEventListener(
      'wheel',
      (ev) => {
        ev?.preventDefault?.();
        M.scale = Math.max(0.5, Math.min(24, M.scale * ((ev?.deltaY ?? 0) < 0 ? 1.25 : 0.8)));
        draw();
      },
      { passive: false },
    );
    ui.need('map-zin').addEventListener('click', () => {
      M.scale = Math.min(24, M.scale * 1.25);
      draw();
    });
    ui.need('map-zout').addEventListener('click', () => {
      M.scale = Math.max(0.5, M.scale * 0.8);
      draw();
    });
    ui.need('map-r').addEventListener('change', () => {
      M.since = -1;
      M.win = null;
      void poll();
    });
    const follow = ui.need('map-follow');
    follow.addEventListener('change', () => {
      M.since = -1;
      M.win = null;
      if (follow.checked && M.data?.bot) M.view = { x: M.data.bot.x, z: M.data.bot.z };
      void poll();
    });
    env.window.addEventListener('resize', draw);
  }
  const box = ui.need('mapbox');
  box.addEventListener('toggle', () => {
    M.on = !!box.open;
    if (!M.on) {
      env.clearTimeout(M.t);
      return;
    }
    if (!M.cv) init();
    void poll();
  });
}
