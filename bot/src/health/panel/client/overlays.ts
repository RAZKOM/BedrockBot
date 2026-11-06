// The map screen's overlays (decision 0062, docs/map.md "Overlays"): what is drawn over the tiles, from
// the `map-live` topic (bot, trail, path, goal, entities, home, shelter, waypoints) and GET /api/marks
// (chests with what the chest memory knows of their contents, ores by kind, spawners, beds, furnaces /
// crafting tables, farmland, forests, herds). One marker list serves the drawing and the tap ("what is
// here"). Every overlay id is in mapdefs.ts MAP_OVERLAYS (the switches) and docs/map.md (a guard test).
import type { MapLiveJson, PanelMarks } from '../shared.ts';
import type { Ctx2D } from './dom.ts';
import { nice } from './dom.ts';
import { entityOverlay, MAP_OVERLAYS, oreColour } from './mapdefs.ts';

export interface ViewXf {
  /** Device pixels per block. */
  scale: number;
  dpr: number;
  toScreen(x: number, z: number): [number, number];
}

export type Shape = 'square' | 'diamond' | 'dot' | 'cross' | 'cell' | 'ring';

export interface Marker {
  x: number;
  y: number | null;
  z: number;
  overlay: string;
  colour: string;
  label: string;
  shape: Shape;
  /** Lines for the info sheet (a chest's contents). */
  more?: string[];
}

const COL: Record<string, string> = Object.fromEntries(MAP_OVERLAYS.map((o) => [o.id, o.colour]));
const ago = (ms: number): string => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 120 ? `${Math.round(s)} s ago` : s < 7200 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};

/** Every marker of the switched-on overlays (the bot last, so it is drawn on top). */
export function markers(live: MapLiveJson | null, marks: PanelMarks | null, on: (id: string) => boolean): Marker[] {
  const out: Marker[] = [];
  const b = marks?.blocks;
  if (b && on('farmland')) for (const f of b.farmland ?? []) out.push({ x: f[0], y: f[1], z: f[2], overlay: 'farmland', colour: COL.farmland!, label: 'farmland', shape: 'cell' });
  if (b && on('forests')) for (const f of b.forest ?? []) out.push({ x: f[0] + 0.5, y: f[1], z: f[2] + 0.5, overlay: 'forests', colour: COL.forests!, label: `forest (${f[3]} logs)`, shape: 'ring' });
  if (b && on('ores')) for (const o of b.ore ?? []) out.push({ x: o[0] + 0.5, y: o[1], z: o[2] + 0.5, overlay: 'ores', colour: oreColour(String(o[3])), label: `${nice(o[3])} at y ${o[1]}`, shape: 'diamond' });
  if (b && on('stations')) for (const s of b.station ?? []) out.push({ x: s[0] + 0.5, y: s[1], z: s[2] + 0.5, overlay: 'stations', colour: COL.stations!, label: nice(s[3]), shape: 'square' });
  if (b && on('beds')) for (const s of b.bed ?? []) out.push({ x: s[0] + 0.5, y: s[1], z: s[2] + 0.5, overlay: 'beds', colour: COL.beds!, label: nice(s[3]), shape: 'square' });
  if (b && on('spawners')) for (const s of b.spawner ?? []) out.push({ x: s[0] + 0.5, y: s[1], z: s[2] + 0.5, overlay: 'spawners', colour: COL.spawners!, label: nice(s[3]), shape: 'cross' });
  if (marks && on('chests')) {
    for (const c of marks.chests) {
      const more = c.top?.length ? [`holds ${c.top.map(([n, k]) => `${k} ${nice(n)}`).join(', ')}${c.size ? ` (${c.stacks}/${c.size} slots)` : ''}`] : [c.readAt ? 'empty when read' : 'never opened'];
      if (c.readAt) more.push(`read ${ago(c.readAt)}`);
      out.push({ x: c.x + 0.5, y: c.y, z: c.z + 0.5, overlay: 'chests', colour: COL.chests!, label: `${nice(c.kind)}${c.label ? ` "${c.label}"` : ''}${c.unreachable ? ' (unreachable)' : ''}`, shape: 'square', more });
    }
  }
  if (marks && on('passive')) for (const h of marks.herds) out.push({ x: h.x, y: h.y, z: h.z, overlay: 'passive', colour: COL.passive!, label: `herd: ${h.n} ${nice(h.kind)}${h.penned ? ' (penned)' : ''}`, shape: 'ring' });
  if (live) {
    if (on('home') && live.home) out.push({ x: live.home[0] + 0.5, y: live.home[1], z: live.home[2] + 0.5, overlay: 'home', colour: COL.home!, label: 'home', shape: 'square' });
    if (on('home') && live.shelter) out.push({ x: live.shelter[0] + 0.5, y: live.shelter[1], z: live.shelter[2] + 0.5, overlay: 'home', colour: '#c08cff', label: 'shelter', shape: 'square' });
    if (on('waypoints')) for (const w of live.wps) out.push({ x: w[1] + 0.5, y: w[2], z: w[3] + 0.5, overlay: 'waypoints', colour: COL.waypoints!, label: `waypoint ${w[0]}`, shape: 'diamond' });
    for (const [, e] of Object.entries(live.ents)) {
      const ov = entityOverlay(String(e[0]));
      if (!ov || !on(ov)) continue;
      const name = e[5] !== undefined ? String(e[5]) : nice(e[1]);
      out.push({ x: Number(e[2]), y: Number(e[3]), z: Number(e[4]), overlay: ov, colour: COL[ov]!, label: name, shape: 'dot' });
    }
  }
  return out;
}

/** Markers within r blocks of the block (bx, bz), nearest first. */
export function nearMarkers(list: readonly Marker[], bx: number, bz: number, r = 1.5): Marker[] {
  const cx = bx + 0.5;
  const cz = bz + 0.5;
  return list
    .filter((m) => m.shape !== 'cell' || (Math.floor(m.x) === bx && Math.floor(m.z) === bz))
    .map((m) => ({ m, d: Math.hypot(m.x - cx, m.z - cz) }))
    .filter((e) => e.d <= r)
    .sort((a, b) => a.d - b.d)
    .map((e) => e.m);
}

function line(g: Ctx2D, v: ViewXf, pts: readonly (readonly number[])[], style: string, width: number, dx = 0): void {
  if (pts.length < 2) return;
  g.strokeStyle = style;
  g.lineWidth = width * v.dpr;
  g.beginPath();
  pts.forEach((p, i) => {
    const q = v.toScreen(p[0]! + dx, p[p.length === 2 ? 1 : 2]! + dx);
    if (i) g.lineTo(q[0], q[1]);
    else g.moveTo(q[0], q[1]);
  });
  g.stroke();
}

/** Draws the switched-on overlays; `w` / `h` = the canvas (markers outside are skipped). */
export function drawOverlays(g: Ctx2D, v: ViewXf, live: MapLiveJson | null, list: readonly Marker[], on: (id: string) => boolean, w: number, h: number): void {
  const r = v.dpr;
  if (live && on('trail')) line(g, v, live.trail, 'rgba(230,234,240,0.45)', 1.5);
  if (live && on('path') && live.path) line(g, v, live.path, COL.path!, 2.5, 0.5);
  if (live && on('path') && live.goal) {
    const q = v.toScreen(live.goal[0] + 0.5, live.goal[2] + 0.5);
    const k = 6 * r;
    g.strokeStyle = COL.path!;
    g.lineWidth = 2 * r;
    g.beginPath();
    g.moveTo(q[0] - k, q[1] - k);
    g.lineTo(q[0] + k, q[1] + k);
    g.moveTo(q[0] + k, q[1] - k);
    g.lineTo(q[0] - k, q[1] + k);
    g.stroke();
  }
  const labels = v.scale / r >= 6;
  g.font = `${Math.round(11 * r)}px system-ui, sans-serif`;
  for (const m of list) {
    const q = v.toScreen(m.x, m.z);
    if (q[0] < -20 || q[1] < -20 || q[0] > w + 20 || q[1] > h + 20) continue;
    g.fillStyle = m.colour;
    g.strokeStyle = '#000';
    g.lineWidth = r;
    if (m.shape === 'cell') {
      const s = Math.max(2, v.scale);
      g.fillRect(q[0], q[1], s, s);
      continue;
    }
    const k = (m.shape === 'dot' ? 3.5 : m.shape === 'diamond' ? 4.5 : 4) * r;
    g.beginPath();
    if (m.shape === 'dot' || m.shape === 'ring') {
      g.arc(q[0], q[1], m.shape === 'ring' ? 6 * r : k, 0, Math.PI * 2);
      if (m.shape === 'ring') {
        g.strokeStyle = m.colour;
        g.lineWidth = 2.5 * r;
        g.stroke();
      } else {
        g.fill();
        g.stroke();
      }
    } else if (m.shape === 'diamond') {
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
      if (m.shape === 'cross') {
        g.moveTo(q[0] - k, q[1] - k);
        g.lineTo(q[0] + k, q[1] + k);
        g.moveTo(q[0] + k, q[1] - k);
        g.lineTo(q[0] - k, q[1] + k);
        g.stroke();
      }
    }
    if (labels && (m.overlay === 'waypoints' || m.overlay === 'home' || m.overlay === 'players')) {
      g.fillStyle = '#f2f4f7';
      g.fillText(m.overlay === 'waypoints' ? m.label.replace(/^waypoint /, '') : m.label, q[0] + 7 * r, q[1] + 4 * r);
    }
  }
  if (live?.bot && on('bot')) {
    const q = v.toScreen(live.bot[0], live.bot[2]);
    const yaw = (live.bot[3] * Math.PI) / 180;
    const dx = -Math.sin(yaw);
    const dz = Math.cos(yaw);
    const a = 11 * r;
    const b = 6.5 * r;
    g.fillStyle = COL.bot!;
    g.strokeStyle = '#000';
    g.lineWidth = 1.5 * r;
    g.beginPath();
    g.moveTo(q[0] + dx * a, q[1] + dz * a);
    g.lineTo(q[0] - dx * b - dz * b, q[1] - dz * b + dx * b);
    g.lineTo(q[0] - dx * b + dz * b, q[1] - dz * b - dx * b);
    g.closePath();
    g.fill();
    g.stroke();
  }
}
