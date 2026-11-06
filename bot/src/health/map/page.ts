// GET /map (PLAN.md task 7.15): a dependency-free page that polls /map.json every second and draws
// the cached chunks top-down (Track PC, decision 0060: each column in its surface block's colour with
// the in-game map's relief shading, or the class view; remembered-only chunks dimmed), the bot (arrow
// by yaw) and its trail, the planned path and the goal, entities, home, shelter and waypoints. Drag to
// pan, wheel or +/- to zoom, "follow" re-centres on the bot. The painting is paint.ts PAINT_JS.
import { PAINT_JS } from './paint.ts';

export const MAP_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BedrockBot map</title>
<style>
  :root { color-scheme: dark; --bg: #111418; --panel: #1b2027; --text: #d8dee6; --muted: #8a94a3; --accent: #f5c542; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 13px/1.4 system-ui, sans-serif; }
  #wrap { display: flex; height: 100%; }
  #map { flex: 1; position: relative; overflow: hidden; cursor: grab; }
  #map.drag { cursor: grabbing; }
  canvas { position: absolute; inset: 0; width: 100%; height: 100%; image-rendering: pixelated; }
  #side { width: 300px; padding: 10px 12px; background: var(--panel); overflow-y: auto; box-sizing: border-box; }
  h1 { font-size: 15px; margin: 0 0 8px; }
  .row { margin: 4px 0; }
  .muted { color: var(--muted); }
  .k { color: var(--muted); display: inline-block; min-width: 86px; }
  button, select { background: #2a313b; color: var(--text); border: 1px solid #3a4350; border-radius: 4px; padding: 2px 8px; }
  .legend span { display: inline-block; width: 10px; height: 10px; margin-right: 4px; vertical-align: middle; border-radius: 2px; }
  #err { color: #ff7b72; }
  @media (max-width: 700px) { #wrap { flex-direction: column; } #side { width: 100%; height: 40%; } }
</style>
</head>
<body>
<div id="wrap">
  <div id="map"><canvas id="cv"></canvas></div>
  <div id="side">
    <h1>BedrockBot map</h1>
    <div class="row"><button id="zin">+</button> <button id="zout">&minus;</button>
      <label><input type="checkbox" id="follow" checked> follow</label>
      <select id="radius"><option>6</option><option>8</option><option selected>12</option><option>16</option><option>24</option><option>32</option></select> chunks</div>
    <div class="row"><label><input type="checkbox" id="grid"> chunk grid</label> <label><input type="checkbox" id="labels" checked> labels</label></div>
    <div class="row"><select id="mode"><option value="block" selected>blocks</option><option value="class">classes</option></select> colours
      <select id="layer"><option value="auto" selected>auto</option><option value="top">top</option><option value="under">under the roof</option></select> layer</div>
    <div id="err" class="row"></div>
    <div id="info"></div>
    <div class="row legend muted" style="margin-top:10px">
      <div id="legend-class"><span style="background:#5f9e3c"></span>solid (shaded by height) <span style="background:#2f6fd0"></span>water <span style="background:#e0531f"></span>avoid</div>
      <div id="legend-block">blocks: the surface block's colour, darker where the column to the north is higher, lighter where lower; water darker with depth. Chunks remembered before block colours: grey / blue / orange by class</div>
      <div><span style="background:#fff"></span>bot <span style="background:#f5c542"></span>path / goal <span style="background:#ff5050"></span>hostile <span style="background:#5cd6ff"></span>player</div>
      <div><span style="background:#b0e57c"></span>passive <span style="background:#ffd27f"></span>item <span style="background:#4ce08a"></span>home <span style="background:#c08cff"></span>shelter / waypoint</div>
      <div>dimmed chunks: remembered (not loaded); outlined: loaded</div>
    </div>
  </div>
</div>
<script>
(() => {
  const cv = document.getElementById('cv');
  const ctx = cv.getContext('2d');
  const mapEl = document.getElementById('map');
  const info = document.getElementById('info');
  const err = document.getElementById('err');
  const follow = document.getElementById('follow');
  const radiusSel = document.getElementById('radius');
  const gridBox = document.getElementById('grid');
  const labelsBox = document.getElementById('labels');
  const modeSel = document.getElementById('mode');
  const layerSel = document.getElementById('layer');
  const tiles = new Map();          // "cx,cz" -> {t (decoded, paint.ts), img}
  let data = null, since = -1, win = null, scale = 3, view = { x: 0, z: 0 }, hover = null, inFlight = false;
${PAINT_JS}
  function paintTile(entry) {
    const north = tiles.get(entry.t.cx + ',' + (entry.t.cz - 1));
    const g = entry.img.getContext('2d'), img = g.createImageData(16, 16);
    img.data.set(mapPixels(entry.t, modeSel.value, layerSel.value, north ? north.t : null));
    g.putImageData(img, 0, 0);
  }
  function addTile(raw, palette) {
    const c = document.createElement('canvas'); c.width = 16; c.height = 16;
    const entry = { t: mapDecodeTile(raw, palette), img: c };
    tiles.set(raw.cx + ',' + raw.cz, entry);
    return entry;
  }
  function repaintAll() { for (const e of tiles.values()) paintTile(e); }
  function syncLegend() {
    document.getElementById('legend-class').style.display = modeSel.value === 'class' ? '' : 'none';
    document.getElementById('legend-block').style.display = modeSel.value === 'block' ? '' : 'none';
  }
  function toScreen(x, z) { return [(x - view.x) * scale + cv.width / 2, (z - view.z) * scale + cv.height / 2]; }
  function toWorld(sx, sy) { return [(sx - cv.width / 2) / scale + view.x, (sy - cv.height / 2) / scale + view.z]; }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(mapEl.clientWidth * dpr), h = Math.round(mapEl.clientHeight * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#0b0d10'; ctx.fillRect(0, 0, w, h);
    for (const { t, img } of tiles.values()) {
      const [sx, sy] = toScreen(t.cx * 16, t.cz * 16);
      const s = 16 * scale;
      if (sx > w || sy > h || sx + s < 0 || sy + s < 0) continue;
      ctx.drawImage(img, sx, sy, s, s);
      if (t.live) { ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1; ctx.strokeRect(sx + 0.5, sy + 0.5, s - 1, s - 1); }
      else if (gridBox.checked) { ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.strokeRect(sx + 0.5, sy + 0.5, s - 1, s - 1); }
    }
    if (!data) return;
    const line = (pts, style, width) => {
      if (!pts || pts.length < 2) return;
      ctx.strokeStyle = style; ctx.lineWidth = width; ctx.beginPath();
      pts.forEach((p, i) => { const [x, y] = toScreen(p.x + 0.5, p.z + 0.5); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
    };
    line(data.trail.map((p) => ({ x: p.x - 0.5, z: p.z - 0.5 })), 'rgba(255,255,255,0.35)', 1.5);
    line(data.nav.path, '#f5c542', 2.5);
    const dot = (x, z, r, fill, label) => {
      const [sx, sy] = toScreen(x, z);
      ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
      if (label && labelsBox.checked) { ctx.fillStyle = '#e8ecf1'; ctx.font = '11px system-ui'; ctx.fillText(label, sx + r + 3, sy + 4); }
    };
    const square = (p, fill, label) => {
      const [sx, sy] = toScreen(p.x + 0.5, p.z + 0.5);
      ctx.fillStyle = fill; ctx.fillRect(sx - 5, sy - 5, 10, 10); ctx.strokeStyle = '#000'; ctx.strokeRect(sx - 5, sy - 5, 10, 10);
      if (label && labelsBox.checked) { ctx.fillStyle = '#e8ecf1'; ctx.font = '11px system-ui'; ctx.fillText(label, sx + 8, sy + 4); }
    };
    if (data.nav.goal) {
      const [gx, gy] = toScreen(data.nav.goal.x + 0.5, data.nav.goal.z + 0.5);
      ctx.strokeStyle = '#f5c542'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(gx - 7, gy - 7); ctx.lineTo(gx + 7, gy + 7); ctx.moveTo(gx + 7, gy - 7); ctx.lineTo(gx - 7, gy + 7); ctx.stroke();
    }
    if (data.home) square(data.home, '#4ce08a', 'home');
    if (data.shelter) square(data.shelter, '#c08cff', 'shelter');
    for (const wp of data.waypoints) square(wp, '#c08cff', wp.name);
    const ecol = { player: '#5cd6ff', hostile: '#ff5050', neutral: '#ffa94d', passive: '#b0e57c', item: '#ffd27f', other: '#cccccc' };
    for (const e of data.entities) dot(e.x, e.z, e.kind === 'item' ? 2.5 : 4, ecol[e.kind] || '#ccc', e.kind === 'item' ? '' : (e.name || e.type));
    if (data.bot) {
      const [bx, by] = toScreen(data.bot.x, data.bot.z);
      const yaw = (data.bot.yaw * Math.PI) / 180, dx = -Math.sin(yaw), dz = Math.cos(yaw);
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5; ctx.beginPath();
      ctx.moveTo(bx + dx * 11, by + dz * 11); ctx.lineTo(bx - dx * 6 - dz * 6, by - dz * 6 + dx * 6); ctx.lineTo(bx - dx * 6 + dz * 6, by - dz * 6 - dx * 6); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  }

  function render() {
    if (!data) { info.innerHTML = '<span class="muted">waiting for /map.json ...</span>'; return; }
    const f = (v, d = 1) => (v == null ? '-' : Number(v).toFixed(d));
    const b = data.bot, c = data.cache, n = data.nav;
    let html = '';
    html += '<div class="row"><span class="k">server</span>' + (data.server || '-') + '</div>';
    html += '<div class="row"><span class="k">bot</span>' + (b ? f(b.x) + ' ' + f(b.y) + ' ' + f(b.z) + ' yaw ' + f(b.yaw, 0) : '-') + '</div>';
    html += '<div class="row"><span class="k">dimension</span>' + data.dimension + ' <span class="muted">window ' + (2 * data.radius + 1) + '&sup2; chunks</span></div>';
    html += '<div class="row"><span class="k">nav</span>' + (n.busy ? 'busy' : 'idle') + (n.running ? ' (' + n.running + ')' : '') + (n.result ? ', last goto ' + n.result : '') + (n.plans ? ', ' + n.plans + ' plan(s)' : '') + (n.path ? ', path ' + n.path.length + ' nodes' : '') + '</div>';
    html += '<div class="row"><span class="k">entities</span>' + data.entities.length + '</div>';
    if (c) html += '<div class="row"><span class="k">cache</span>' + c.live + ' live, ' + c.decoded + ' remembered in memory, ' + c.regions + ' region(s), ~' + (c.approxBytes / 1048576).toFixed(1) + ' MB; ' + c.lookups + ' planner lookups, ' + c.corrections + ' corrections' + (c.errors ? ', <b>' + c.errors + ' errors</b>' : '') + '<div class="muted" style="word-break:break-all">' + c.dir + '</div></div>';
    else html += '<div class="row"><span class="k">cache</span><span class="muted">none attached</span></div>';
    if (hover) html += '<div class="row"><span class="k">cursor</span>' + hover + '</div>';
    html += '<div class="row muted">tiles in view: ' + tiles.size + '</div>';
    info.innerHTML = html;
  }

  async function poll() {
    if (inFlight) return;
    inFlight = true;
    try {
      const r = Number(radiusSel.value);
      const p = new URLSearchParams({ r: String(r), since: String(since) });
      if (!follow.checked) { p.set('cx', String(Math.floor(view.x / 16))); p.set('cz', String(Math.floor(view.z / 16))); }
      if (win) p.set('win', [win.cx0, win.cz0, win.cx1, win.cz1].join(','));
      const res = await fetch('map.json?' + p.toString(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      const fresh = [];
      for (const t of d.tiles) fresh.push(addTile(t, d.palette || []));
      // relief needs the row to the north: paint the new tiles and the ones just south of them
      const again = new Set(fresh);
      for (const e of fresh) { const s = tiles.get(e.t.cx + ',' + (e.t.cz + 1)); if (s) again.add(s); }
      for (const e of again) paintTile(e);
      const w0 = d.window;
      for (const [k, v] of tiles) if (v.t.cx < w0.cx0 - 2 || v.t.cx > w0.cx1 + 2 || v.t.cz < w0.cz0 - 2 || v.t.cz > w0.cz1 + 2) tiles.delete(k);
      win = w0; since = d.rev; data = d;
      if (follow.checked && d.bot) view = { x: d.bot.x, z: d.bot.z };
      err.textContent = '';
    } catch (e) {
      err.textContent = 'fetch failed: ' + (e && e.message ? e.message : e);
    } finally {
      inFlight = false;
    }
    render(); draw();
  }

  let dragging = null;
  mapEl.addEventListener('mousedown', (e) => { dragging = { x: e.clientX, y: e.clientY, vx: view.x, vz: view.z }; mapEl.classList.add('drag'); });
  window.addEventListener('mouseup', () => { dragging = null; mapEl.classList.remove('drag'); });
  window.addEventListener('mousemove', (e) => {
    const rect = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (dragging) {
      follow.checked = false;
      view = { x: dragging.vx - ((e.clientX - dragging.x) * dpr) / scale, z: dragging.vz - ((e.clientY - dragging.y) * dpr) / scale };
      draw();
    }
    const [wx, wz] = toWorld((e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr);
    const bx = Math.floor(wx), bz = Math.floor(wz), tile = tiles.get((bx >> 4) + ',' + (bz >> 4));
    if (tile) {
      const i = ((bz & 15) << 4) | (bx & 15);
      hover = bx + ', ' + bz + ': ' + mapDescribe(tile.t, layerSel.value, i) + (tile.t.live ? ' (loaded)' : ' (remembered ' + new Date(tile.t.updatedAt).toLocaleString() + ')');
    } else hover = bx + ', ' + bz + ': unknown';
    render();
  });
  mapEl.addEventListener('wheel', (e) => { e.preventDefault(); scale = Math.max(0.5, Math.min(24, scale * (e.deltaY < 0 ? 1.25 : 0.8))); draw(); }, { passive: false });
  document.getElementById('zin').onclick = () => { scale = Math.min(24, scale * 1.25); draw(); };
  document.getElementById('zout').onclick = () => { scale = Math.max(0.5, scale * 0.8); draw(); };
  radiusSel.onchange = () => { since = -1; win = null; poll(); };
  follow.onchange = () => { since = -1; win = null; poll(); };
  gridBox.onchange = draw; labelsBox.onchange = draw;
  modeSel.onchange = () => { syncLegend(); repaintAll(); draw(); };
  layerSel.onchange = () => { repaintAll(); draw(); };
  syncLegend();
  window.addEventListener('resize', draw);
  render(); poll();
  setInterval(poll, 1000);
})();
</script>
</body>
</html>
`;
