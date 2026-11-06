// Track PC (decision 0060, docs/world-cache.md "Debug map"): how a 2D map paints /map.json tiles.
// Written once as plain JavaScript (PAINT_JS, ES2017, no imports, browser globals `atob` and
// `Uint8ClampedArray` only): the debug map page (page.ts) embeds it verbatim, the panel's map-first
// screen (step 2) embeds the same text, and this module evaluates it for the server side and the unit
// tests, so what the tests check is exactly what the browsers run.
//
// Two views: `block` (each column in its surface block's colour from the tile palette, with the
// in-game map's relief rule: darker when the column to the north is higher, lighter when it is lower;
// liquids shaded by depth with the game's checkerboard) and `class` (the cache classes shaded by
// height, the view the map had before decision 0060). Columns without surface data (records written
// before it) fall back to the class colours in both views.
import type { MapTileJson } from './schema.ts';

export const PAINT_JS = String.raw`
var MAP_NONE_Y = -32768;
/** Flat colours per cache class (air / nothing, solid, water, avoid): the block view's fallback. */
var MAP_CLASS_BASE = [[24, 26, 30], [138, 138, 128], [47, 111, 208], [224, 83, 31]];
/** Brightness steps of the in-game map, relative to the normal step (220): high 255, low 180. */
var MAP_HIGH = 255 / 220, MAP_LOW = 180 / 220;

function mapB64(s) { var bin = atob(s), a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
function mapInt16(s) { var b = mapB64(s); return new Int16Array(b.buffer, b.byteOffset, b.length >> 1); }
/** '#rrggbb' -> [r, g, b], null for anything else. */
function mapHexRgb(s) {
  if (typeof s !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(s)) return null;
  var n = parseInt(s.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mapShade(rgb, f) { return [Math.max(0, Math.min(255, Math.round(rgb[0] * f))), Math.max(0, Math.min(255, Math.round(rgb[1] * f))), Math.max(0, Math.min(255, Math.round(rgb[2] * f)))]; }
/** The class view: solid green to brown to white by height (banded every 4 blocks), water by height, avoid orange-red, nothing dark. */
function mapClassColour(cls, y) {
  if (y === MAP_NONE_Y || y === null) return MAP_CLASS_BASE[0];
  if (cls === 2) return mapShade([47, 111, 208], 0.8 + Math.max(-0.3, Math.min(0.3, (y - 62) / 60)));
  if (cls === 3) return [224, 83, 31];
  if (cls === 1) {
    var t = Math.max(0, Math.min(1, (y + 20) / 200));
    var base = t < 0.5 ? [70 + 60 * t, 140 - 20 * t, 50] : [110 + 180 * (t - 0.5), 120 + 160 * (t - 0.5), 60 + 380 * (t - 0.5)];
    return mapShade(base, 0.75 + 0.5 * (((y % 4) + 4) % 4) / 8);
  }
  return MAP_CLASS_BASE[0];
}
/** The in-game map's relief: darker when the column to the north is higher, lighter when lower, else 1 (also when either is unknown). */
function mapRelief(y, yNorth) {
  if (y === null || yNorth === null || y === undefined || yNorth === undefined) return 1;
  return yNorth > y ? MAP_LOW : yNorth < y ? MAP_HIGH : 1;
}
/** The in-game map's water: lighter when shallow, darker when deep, a checkerboard between. */
function mapWaterShade(depth, x, z) {
  var d = depth * 0.1 + ((x + z) & 1) * 0.2;
  return d < 0.5 ? MAP_HIGH : d > 0.9 ? MAP_LOW : 1;
}

/** One surface layer of a tile: names, colours, y, floor names and depths per column (index z * 16 + x). */
function mapLayer(s, sy, f, d, p, palette, ys) {
  var si = mapB64(s), fi = f ? mapB64(f) : null, y = sy ? mapInt16(sy) : ys;
  var names = new Array(256), rgb = new Array(256), floor = new Array(256);
  var entry = function (k) { return k === 255 || !p || p[k] === undefined ? null : palette[p[k]] || null; };
  for (var i = 0; i < 256; i++) {
    var e = entry(si[i]);
    names[i] = e ? e.name : null;
    rgb[i] = e ? mapHexRgb(e.rgb) : null;
    var fe = fi ? entry(fi[i]) : null;
    floor[i] = fe ? fe.name : null;
  }
  return { names: names, rgb: rgb, y: y, floor: floor, depth: d ? mapB64(d) : null };
}

/** A /map.json tile decoded once: heights and classes, and the surface layers when the tile has them. */
function mapDecodeTile(t, palette) {
  var ys = mapInt16(t.y), c = mapB64(t.c), cls = new Uint8Array(256);
  for (var i = 0; i < 256; i++) cls[i] = (c[i >> 2] >> ((i & 3) * 2)) & 3;
  var out = { cx: t.cx, cz: t.cz, live: t.live, updatedAt: t.updatedAt, ys: ys, cls: cls, top: null, under: null };
  if (t.s) out.top = mapLayer(t.s, t.sy, t.f, t.d, t.p, palette || [], ys);
  if (t.u) out.under = mapLayer(t.u.s, t.u.sy, t.u.f, t.u.d, t.p, palette || [], null);
  return out;
}

/** Which layer a view shows: 'under' when asked for (or 'auto') and the tile has it, else 'top'. */
function mapLayerFor(dec, pref) { return (pref === 'under' || pref === 'auto') && dec && dec.under ? 'under' : 'top'; }

/** Height of column i in a view (null = unknown): the layer's surface y in the block view, the top / roof height otherwise. */
function mapHeight(dec, mode, pref, i) {
  if (!dec) return null;
  var L = mode === 'block' ? dec[mapLayerFor(dec, pref)] : null;
  if (L && L.names[i] !== null) return L.y[i];
  var y = dec.ys[i];
  return y === MAP_NONE_Y ? null : y;
}

/** RGBA pixels (16 x 16, row z, column x) of a decoded tile; north = the decoded tile at cz - 1 (relief of row 0), or null. */
function mapPixels(dec, mode, pref, north) {
  var px = new Uint8ClampedArray(1024), layer = mapLayerFor(dec, pref), L = mode === 'block' ? dec[layer] : null;
  for (var i = 0; i < 256; i++) {
    var x = i & 15, z = i >> 4, rgb;
    if (L && L.names[i] !== null) {
      var base = L.rgb[i] || (layer === 'top' ? MAP_CLASS_BASE[dec.cls[i]] : MAP_CLASS_BASE[1]);
      var deep = L.depth ? L.depth[i] : 0;
      if (deep > 0 || L.floor[i] !== null) rgb = mapShade(base, mapWaterShade(deep, x, z));
      else rgb = mapShade(base, mapRelief(L.y[i], z > 0 ? mapHeight(dec, mode, pref, i - 16) : mapHeight(north, mode, pref, 240 + x)));
    } else if (mode === 'block') {
      var y = dec.ys[i];
      rgb = y === MAP_NONE_Y ? MAP_CLASS_BASE[0] : mapShade(MAP_CLASS_BASE[dec.cls[i]], mapRelief(y, z > 0 ? mapHeight(dec, mode, pref, i - 16) : mapHeight(north, mode, pref, 240 + x)));
    } else rgb = mapClassColour(dec.cls[i], dec.ys[i]);
    if (!dec.live) rgb = mapShade(rgb, 0.55);
    px[i * 4] = rgb[0]; px[i * 4 + 1] = rgb[1]; px[i * 4 + 2] = rgb[2]; px[i * 4 + 3] = 255;
  }
  return px;
}

/** What column i shows, as text: 'grass_block, y 64', 'water, y 62, 5 deep over sand', else the class and height. */
function mapDescribe(dec, pref, i) {
  var layer = mapLayerFor(dec, pref), L = dec[layer], y = dec.ys[i];
  if (L && L.names[i] !== null) {
    var deep = L.depth ? L.depth[i] : 0, s = L.names[i] + ', y ' + L.y[i];
    if (deep > 0 || L.floor[i] !== null) s += ', ' + (deep >= 255 ? '255+' : deep) + ' deep' + (L.floor[i] !== null ? ' over ' + L.floor[i] : '');
    return s + (layer === 'under' ? ' (under the roof)' : '');
  }
  return y === MAP_NONE_Y ? 'nothing' : ['air', 'solid', 'water', 'avoid'][dec.cls[i]] + ' at y ' + y;
}
`;

const NAMES = ['mapB64', 'mapHexRgb', 'mapClassColour', 'mapRelief', 'mapWaterShade', 'mapDecodeTile', 'mapLayerFor', 'mapHeight', 'mapPixels', 'mapDescribe'] as const;

// eslint-disable-next-line @typescript-eslint/no-implied-eval -- the same text the page runs (see the file comment)
const build = new Function(`${PAINT_JS}\nreturn { ${NAMES.join(', ')} };`) as () => unknown;
const api = build() as Record<(typeof NAMES)[number], (...a: unknown[]) => unknown>;

/** A palette entry of /map.json (`palette[]`). */
export interface PaintPaletteEntry {
  name: string;
  rgb: string | null;
}

export interface PaintLayer {
  names: (string | null)[];
  rgb: ([number, number, number] | null)[];
  y: Int16Array;
  floor: (string | null)[];
  depth: Uint8Array | null;
}

export interface DecodedTile {
  cx: number;
  cz: number;
  live: boolean;
  updatedAt: number;
  ys: Int16Array;
  cls: Uint8Array;
  top: PaintLayer | null;
  under: PaintLayer | null;
}

export type PaintMode = 'block' | 'class';
export type LayerPref = 'auto' | 'top' | 'under';

export const mapHexRgb = api.mapHexRgb as (s: unknown) => [number, number, number] | null;
export const mapClassColour = api.mapClassColour as (cls: number, y: number | null) => [number, number, number];
export const mapRelief = api.mapRelief as (y: number | null, yNorth: number | null) => number;
export const mapWaterShade = api.mapWaterShade as (depth: number, x: number, z: number) => number;
export const mapDecodeTile = api.mapDecodeTile as (t: MapTileJson, palette: readonly PaintPaletteEntry[]) => DecodedTile;
export const mapLayerFor = api.mapLayerFor as (dec: DecodedTile, pref: LayerPref) => 'top' | 'under';
export const mapHeight = api.mapHeight as (dec: DecodedTile | null, mode: PaintMode, pref: LayerPref, i: number) => number | null;
export const mapPixels = api.mapPixels as (dec: DecodedTile, mode: PaintMode, pref: LayerPref, north: DecodedTile | null) => Uint8ClampedArray;
export const mapDescribe = api.mapDescribe as (dec: DecodedTile, pref: LayerPref, i: number) => string;
