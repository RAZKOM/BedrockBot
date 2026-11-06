// How a 2D map paints the world cache's tiles (decision 0062, docs/map.md "Painting"; the rules came
// from decision 0060). ONE module for every map: the panel's map screen imports it as a browser module
// (client/mapview.ts), the server and the tests import it directly, and the debug page /map embeds the
// same code as a classic script (health/map/paint.ts strips the types and the `export` keywords at
// startup: PAINT_JS). So it has no imports but types, reads no browser global (base64 is decoded here),
// and every function takes what it needs (the time for the freshness fade too).
//
// Views: `block` (each column in its surface block's colour from the palette, the in-game map's relief:
// darker when the column to the north is higher, lighter when it is lower; liquids shaded by depth with
// the game's checkerboard) and `class` (the cache classes shaded by height). Columns without surface
// data (records written before decision 0060) fall back to the class colours in both views. A Y-slice
// tile (GET /api/map/slice) paints the cut at one height: the real block names of loaded columns, the
// 2-bit classes of remembered ones. Remembered (not loaded) tiles fade toward grey with their age.
import type { CompactTileJson, MapTileJson, SliceTileJson } from '../shared.ts';

export type PaintMode = 'block' | 'class';
export type LayerPref = 'auto' | 'top' | 'under';
export type Rgb = [number, number, number];

/** A palette entry: a block name and its map colour (`#rrggbb`, null = no art: the class colour). */
export interface PaintPaletteEntry {
  name: string;
  rgb: string | null;
}

export interface PaintLayer {
  names: (string | null)[];
  rgb: (Rgb | null)[];
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

export interface DecodedSlice {
  cx: number;
  cz: number;
  live: boolean;
  updatedAt: number;
  y: number;
  cls: Uint8Array;
  names: (string | null)[] | null;
  rgb: (Rgb | null)[] | null;
}

/** "No such y" in the per-column arrays (and the compact `y8` sentinel 255 decodes to it). */
export const MAP_NONE_Y = -32768;
/** Flat colours per cache class (air / nothing, solid, water, avoid): the block view's fallback. */
export const MAP_CLASS_BASE: readonly Rgb[] = [
  [24, 26, 30],
  [138, 138, 128],
  [47, 111, 208],
  [224, 83, 31],
];
/** Brightness steps of the in-game map, relative to the normal step (220): high 255, low 180. */
export const MAP_HIGH = 255 / 220;
export const MAP_LOW = 180 / 220;
/** Remembered tiles fade toward this grey ("Freshness" in docs/map.md). */
export const MAP_PALE: Rgb = [168, 172, 178];

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = ((): Int8Array => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** Base64 -> bytes (no atob: the module runs in Node, the page and the classic /map script alike). */
export function mapB64(s: string): Uint8Array {
  let n = s.length;
  while (n > 0 && s.charCodeAt(n - 1) === 61) n--; // '='
  const out = new Uint8Array((n * 3) >> 2);
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < n; i++) {
    const v = B64_INDEX[s.charCodeAt(i) & 127]!;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
    }
  }
  return o === out.length ? out : out.subarray(0, o);
}

/** Base64 of little endian int16 values. */
export function mapInt16(s: string): Int16Array {
  const b = mapB64(s);
  const out = new Int16Array(b.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = (b[2 * i]! | (b[2 * i + 1]! << 8)) << 16 >> 16;
  return out;
}

/** '#rrggbb' -> [r, g, b], null for anything else. */
export function mapHexRgb(s: unknown): Rgb | null {
  if (typeof s !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(s)) return null;
  const n = parseInt(s.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
export function mapShade(rgb: readonly number[], f: number): Rgb {
  return [clamp(rgb[0]! * f), clamp(rgb[1]! * f), clamp(rgb[2]! * f)];
}
/** a mixed toward b by k (0 = a, 1 = b). */
export function mapMix(a: readonly number[], b: readonly number[], k: number): Rgb {
  return [clamp(a[0]! + (b[0]! - a[0]!) * k), clamp(a[1]! + (b[1]! - a[1]!) * k), clamp(a[2]! + (b[2]! - a[2]!) * k)];
}

/** The class view: solid green to brown to white by height (banded every 4 blocks), water by height, avoid orange-red, nothing dark. */
export function mapClassColour(cls: number, y: number | null): Rgb {
  if (y === MAP_NONE_Y || y === null) return MAP_CLASS_BASE[0]!;
  if (cls === 2) return mapShade([47, 111, 208], 0.8 + Math.max(-0.3, Math.min(0.3, (y - 62) / 60)));
  if (cls === 3) return [224, 83, 31];
  if (cls === 1) {
    const t = Math.max(0, Math.min(1, (y + 20) / 200));
    const base = t < 0.5 ? [70 + 60 * t, 140 - 20 * t, 50] : [110 + 180 * (t - 0.5), 120 + 160 * (t - 0.5), 60 + 380 * (t - 0.5)];
    return mapShade(base, 0.75 + (0.5 * (((y % 4) + 4) % 4)) / 8);
  }
  return MAP_CLASS_BASE[0]!;
}

/** The in-game map's relief: darker when the column to the north is higher, lighter when lower, else 1 (also when either is unknown). */
export function mapRelief(y: number | null | undefined, yNorth: number | null | undefined): number {
  if (y === null || yNorth === null || y === undefined || yNorth === undefined) return 1;
  return yNorth > y ? MAP_LOW : yNorth < y ? MAP_HIGH : 1;
}

/** The in-game map's water: lighter when shallow, darker when deep, a checkerboard between. */
export function mapWaterShade(depth: number, x: number, z: number): number {
  const d = depth * 0.1 + ((x + z) & 1) * 0.2;
  return d < 0.5 ? MAP_HIGH : d > 0.9 ? MAP_LOW : 1;
}

/**
 * Freshness (docs/map.md): how far a remembered tile's colours move toward MAP_PALE. A loaded tile 0;
 * a remembered one 0.25 at once, then 0.25 + 0.35 x (1 - 2^(-age / 24 h)): 0.43 after a day, 0.51 after
 * two, 0.6 at most. Without a clock (`now` undefined) a remembered tile gets the 0.25.
 */
export function mapFade(live: boolean, updatedAt: number, now?: number): number {
  if (live) return 0;
  if (now === undefined || !(updatedAt > 0)) return 0.25;
  const hours = Math.max(0, now - updatedAt) / 3_600_000;
  return 0.25 + 0.35 * (1 - Math.pow(2, -hours / 24));
}

type AnyTile = MapTileJson | CompactTileJson;

/** The heights of a tile: `y` (int16), or the compact `yb` + `y8` (u8 offsets, 255 = none). */
function tileYs(t: AnyTile): Int16Array {
  if (typeof t.y === 'string') return mapInt16(t.y);
  const c = t as CompactTileJson;
  const out = new Int16Array(256).fill(MAP_NONE_Y);
  if (typeof c.y8 === 'string' && typeof c.yb === 'number') {
    const b = mapB64(c.y8);
    for (let i = 0; i < 256; i++) if (b[i] !== 255) out[i] = c.yb + b[i]!;
  }
  return out;
}

/** The surface y of a tile's top layer: `sy` (int16), the compact `sd` (int8 offsets from the heights), else the heights. */
function surfaceYs(t: AnyTile, ys: Int16Array): Int16Array {
  if (typeof t.sy === 'string') return mapInt16(t.sy);
  const sd = (t as CompactTileJson).sd;
  if (typeof sd !== 'string') return ys;
  const b = mapB64(sd);
  const out = new Int16Array(256);
  for (let i = 0; i < 256; i++) out[i] = ys[i]! + ((b[i]! << 24) >> 24);
  return out;
}

function entryOf(k: number, p: readonly number[] | undefined, palette: readonly (PaintPaletteEntry | undefined)[]): PaintPaletteEntry | null {
  const g = k === 255 ? undefined : p?.[k];
  return g === undefined ? null : (palette[g] ?? null);
}

/** One surface layer of a tile: names, colours, y, floor names and depths per column (index z * 16 + x). */
function decodeLayer(s: string, y: Int16Array, f: string | undefined, d: string | undefined, p: readonly number[] | undefined, palette: readonly (PaintPaletteEntry | undefined)[]): PaintLayer {
  const si = mapB64(s);
  const fi = f ? mapB64(f) : null;
  const names = new Array<string | null>(256);
  const rgb = new Array<Rgb | null>(256);
  const floor = new Array<string | null>(256);
  for (let i = 0; i < 256; i++) {
    const e = entryOf(si[i]!, p, palette);
    names[i] = e ? e.name : null;
    rgb[i] = e ? mapHexRgb(e.rgb) : null;
    const fe = fi ? entryOf(fi[i]!, p, palette) : null;
    floor[i] = fe ? fe.name : null;
  }
  return { names, rgb, y, floor, depth: d ? mapB64(d) : null };
}

/** A tile (/map.json, or the compact form of the map topic) decoded once: heights, classes, the surface layers when it has them. */
export function mapDecodeTile(t: AnyTile, palette: readonly (PaintPaletteEntry | undefined)[]): DecodedTile {
  const ys = tileYs(t);
  const c = mapB64(t.c);
  const cls = new Uint8Array(256);
  for (let i = 0; i < 256; i++) cls[i] = (c[i >> 2]! >> ((i & 3) * 2)) & 3;
  const out: DecodedTile = { cx: t.cx, cz: t.cz, live: t.live, updatedAt: t.updatedAt, ys, cls, top: null, under: null };
  const pal = palette ?? [];
  if (t.s) out.top = decodeLayer(t.s, surfaceYs(t, ys), t.f, t.d, t.p, pal);
  if (t.u) out.under = decodeLayer(t.u.s, mapInt16(t.u.sy), t.u.f, t.u.d, t.p, pal);
  return out;
}

/** Which layer a view shows: 'under' when asked for (or 'auto') and the tile has it, else 'top'. */
export function mapLayerFor(dec: DecodedTile | null, pref: LayerPref): 'top' | 'under' {
  return (pref === 'under' || pref === 'auto') && dec?.under ? 'under' : 'top';
}

/** Height of column i in a view (null = unknown): the layer's surface y in the block view, the top height otherwise. */
export function mapHeight(dec: DecodedTile | null, mode: PaintMode, pref: LayerPref, i: number): number | null {
  if (!dec) return null;
  const L = mode === 'block' ? dec[mapLayerFor(dec, pref)] : null;
  if (L && L.names[i] !== null) return L.y[i]!;
  const y = dec.ys[i]!;
  return y === MAP_NONE_Y ? null : y;
}

/**
 * The brightness factor of column i in the block view: the depth shading of a liquid, else the relief
 * against the column to the north (`north` = the decoded tile at cz - 1 for row 0, or null); 1 in the
 * class view. The textured zooms (mapview.ts) lay the same factor over the texture.
 */
export function mapColumnShade(dec: DecodedTile, mode: PaintMode, pref: LayerPref, north: DecodedTile | null, i: number): number {
  if (mode !== 'block') return 1;
  const L = dec[mapLayerFor(dec, pref)];
  const x = i & 15;
  const z = i >> 4;
  const yN = z > 0 ? mapHeight(dec, mode, pref, i - 16) : mapHeight(north, mode, pref, 240 + x);
  if (L && L.names[i] !== null) {
    const deep = L.depth ? L.depth[i]! : 0;
    if (deep > 0 || L.floor[i] !== null) return mapWaterShade(deep, x, z);
    return mapRelief(L.y[i], yN);
  }
  const y = dec.ys[i]!;
  return y === MAP_NONE_Y ? 1 : mapRelief(y, yN);
}

/** The colour of column i (no fade); `north` = the decoded tile at cz - 1 for the relief of row 0, or null. */
export function mapColumnRgb(dec: DecodedTile, mode: PaintMode, pref: LayerPref, north: DecodedTile | null, i: number): Rgb {
  const layer = mapLayerFor(dec, pref);
  const L = mode === 'block' ? dec[layer] : null;
  if (L && L.names[i] !== null) {
    const base = L.rgb[i] ?? (layer === 'top' ? MAP_CLASS_BASE[dec.cls[i]!]! : MAP_CLASS_BASE[1]!);
    return mapShade(base, mapColumnShade(dec, mode, pref, north, i));
  }
  if (mode === 'block') {
    const y = dec.ys[i]!;
    return y === MAP_NONE_Y ? MAP_CLASS_BASE[0]! : mapShade(MAP_CLASS_BASE[dec.cls[i]!]!, mapColumnShade(dec, mode, pref, north, i));
  }
  return mapClassColour(dec.cls[i]!, dec.ys[i]!);
}

/** RGBA pixels (16 x 16, row z, column x) of a decoded tile; `now` (ms) fades a remembered tile by its age. */
export function mapPixels(dec: DecodedTile, mode: PaintMode, pref: LayerPref, north: DecodedTile | null, now?: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(1024);
  const fade = mapFade(dec.live, dec.updatedAt, now);
  for (let i = 0; i < 256; i++) {
    let rgb = mapColumnRgb(dec, mode, pref, north, i);
    if (fade > 0) rgb = mapMix(rgb, MAP_PALE, fade);
    px[i * 4] = rgb[0];
    px[i * 4 + 1] = rgb[1];
    px[i * 4 + 2] = rgb[2];
    px[i * 4 + 3] = 255;
  }
  return px;
}

/** What column i shows, as text: 'grass_block, y 64', 'water, y 62, 5 deep over sand', else the class and height. */
export function mapDescribe(dec: DecodedTile, pref: LayerPref, i: number): string {
  const layer = mapLayerFor(dec, pref);
  const L = dec[layer];
  const y = dec.ys[i]!;
  if (L && L.names[i] !== null) {
    const deep = L.depth ? L.depth[i]! : 0;
    let s = `${L.names[i]}, y ${L.y[i]}`;
    if (deep > 0 || L.floor[i] !== null) s += `, ${deep >= 255 ? '255+' : deep} deep${L.floor[i] !== null ? ` over ${L.floor[i]}` : ''}`;
    return s + (layer === 'under' ? ' (under the roof)' : '');
  }
  return y === MAP_NONE_Y ? 'nothing' : `${['air', 'solid', 'water', 'avoid'][dec.cls[i]!]} at y ${y}`;
}

/** The surface block's name and y of column i (null when the tile has no surface there). */
export function mapSurfaceAt(dec: DecodedTile, pref: LayerPref, i: number): { name: string; y: number } | null {
  const L = dec[mapLayerFor(dec, pref)];
  if (L && L.names[i] !== null) return { name: L.names[i]!, y: L.y[i]! };
  return null;
}

// ---- the Y-slice (GET /api/map/slice) ---------------------------------------------------------------

/** A slice tile decoded: per column the class at y, and for a loaded column the block name and colour. */
export function mapDecodeSlice(t: SliceTileJson, palette: readonly (PaintPaletteEntry | undefined)[]): DecodedSlice {
  const c = mapB64(t.c);
  const cls = new Uint8Array(256);
  for (let i = 0; i < 256; i++) cls[i] = (c[i >> 2]! >> ((i & 3) * 2)) & 3;
  let names: (string | null)[] | null = null;
  let rgb: (Rgb | null)[] | null = null;
  if (t.n) {
    const ni = mapB64(t.n);
    names = new Array(256);
    rgb = new Array(256);
    for (let i = 0; i < 256; i++) {
      const e = entryOf(ni[i]!, t.p, palette);
      names[i] = e ? e.name : null;
      rgb[i] = e ? mapHexRgb(e.rgb) : null;
    }
  }
  return { cx: t.cx, cz: t.cz, live: t.live, updatedAt: t.updatedAt, y: t.y, cls, names, rgb };
}

/** RGBA pixels of a slice tile: air dark, solid by its block's colour (loaded) or grey, water blue, avoid orange; a checker marks cells with nothing known. */
export function mapSlicePixels(dec: DecodedSlice, now?: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(1024);
  const fade = mapFade(dec.live, dec.updatedAt, now);
  for (let i = 0; i < 256; i++) {
    const c = dec.cls[i]!;
    const named = dec.rgb ? dec.rgb[i] : null;
    let rgb: Rgb = c === 0 ? (dec.names?.[i] === null ? [16, 17, 20] : [40, 43, 49]) : (named ?? MAP_CLASS_BASE[c]!);
    if (c === 0 && ((i & 15) + (i >> 4)) % 2 === 0) rgb = mapShade(rgb, 1.15);
    if (fade > 0) rgb = mapMix(rgb, MAP_PALE, fade * 0.6);
    px[i * 4] = rgb[0];
    px[i * 4 + 1] = rgb[1];
    px[i * 4 + 2] = rgb[2];
    px[i * 4 + 3] = 255;
  }
  return px;
}

/** What a slice cell shows: `stone at y 12`, `solid at y 12 (remembered)`, `air at y 12`. */
export function mapDescribeSlice(dec: DecodedSlice, i: number): string {
  const n = dec.names ? dec.names[i] : null;
  if (n) return `${n} at y ${dec.y}`;
  return `${['air', 'solid', 'water', 'avoid'][dec.cls[i]!]} at y ${dec.y}${dec.live ? '' : ' (remembered)'}`;
}
