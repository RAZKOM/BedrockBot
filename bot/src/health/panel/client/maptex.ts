// The map screen's textures (decision 0062, docs/map.md "Textures"): at the closest zooms each column
// shows its block's top face (GET /tex/<block>.png, 16 x 16, made by the server from the minecraft-assets
// package with the colours' tints; nothing from the art is in git). One <img> per block name; a 404 keeps
// the column's colour. Each tile gets a 256 x 256 canvas: the textures, darkened or lightened by the same
// shade as the colour (relief, water depth: paint.ts mapColumnShade) and paled by the same freshness fade.
// Off when the server has no art (state.icons false) or the owner switched it off.
import { TEX_PREFIX } from '../shared.ts';
import type { El } from './dom.ts';
import { mapColumnShade, mapFade, mapLayerFor, MAP_PALE, type LayerPref, type PaintMode } from './paint.ts';
import type { Page } from './page.ts';
import type { StoredTile, TileStore } from './tiles.ts';

/** CSS pixels per block from which the columns show their textures. */
export const TEX_ZOOM = 10;
/** Textured tile canvases kept at once (256 x 256 each); past it the least recently used one is dropped. */
const TEX_TILES = 96;
/** Textured tiles made per frame; the rest show their colours until a later frame (a pan stays smooth). */
const TEX_BUILDS_PER_FRAME = 3;
const NAME = /^[a-z0-9_]{1,64}$/;

export interface Textures {
  /** The tile's textured canvas, or null (no layer, no canvas). */
  of(t: StoredTile, mode: PaintMode, pref: LayerPref): El | null;
  /** Starts a frame: resets the build budget. */
  frame(): void;
  /** True when a tile of this frame wanted a texture over the budget (draw again). */
  pending(): boolean;
  /** Counts for the tests: names asked, loaded, missing. */
  info(): { asked: number; ok: number; missing: number };
}

export function setupTextures(page: Page, tiles: TileStore, changed: () => void): Textures {
  const { ui } = page;
  const imgs = new Map<string, { el: El; ok: boolean | null }>();
  /** Tiles holding a textured canvas, least recently used first. */
  const built = new Set<StoredTile>();
  let budget = TEX_BUILDS_PER_FRAME;
  let wanted = false;
  const drop = (s: StoredTile): void => {
    s.tex = undefined;
    built.delete(s);
  };

  function img(name: string): El | null {
    if (!page.last.icons || !NAME.test(name)) return null;
    let t = imgs.get(name);
    if (!t) {
      const entry = { el: ui.el('img'), ok: null as boolean | null };
      entry.el.addEventListener('load', () => {
        entry.ok = true;
        for (const s of tiles.tiles.values()) if (s.names.has(name)) drop(s);
        changed();
      });
      entry.el.addEventListener('error', () => {
        entry.ok = false; // a 404: this block keeps its colour
      });
      entry.el.src = `${TEX_PREFIX}${name}.png`;
      imgs.set(name, entry);
      t = entry;
    }
    return t.ok ? t.el : null;
  }

  function of(t: StoredTile, mode: PaintMode, pref: LayerPref): El | null {
    if (t.tex) {
      built.delete(t); // most recently used: to the end
      built.add(t);
      return t.tex;
    }
    const L = mapLayerFor(t.dec, pref) === 'under' ? t.dec.under : t.dec.top;
    if (!L) return null;
    if (budget <= 0) {
      wanted = true;
      return null;
    }
    budget--;
    while (built.size >= TEX_TILES) drop(built.values().next().value!);
    const c = ui.el('canvas');
    c.width = 256;
    c.height = 256;
    const g = c.getContext?.('2d');
    if (!g) return null;
    g.imageSmoothingEnabled = false;
    const north = tiles.tiles.get(`${t.dec.cx},${t.dec.cz - 1}`)?.dec ?? null;
    const fade = mapFade(t.dec.live, t.dec.updatedAt, Date.now());
    for (let i = 0; i < 256; i++) {
      const x = (i & 15) * 16;
      const z = (i >> 4) * 16;
      const name = L.names[i];
      const pic = name ? img(name) : null;
      if (!pic) {
        g.drawImage(t.img, i & 15, i >> 4, 1, 1, x, z, 16, 16); // the colour pixel (already shaded and faded)
        continue;
      }
      g.drawImage(pic, x, z, 16, 16);
      const f = mapColumnShade(t.dec, mode, pref, north, i);
      if (f < 1) {
        g.fillStyle = `rgba(0,0,0,${(1 - f).toFixed(3)})`;
        g.fillRect(x, z, 16, 16);
      } else if (f > 1) {
        g.fillStyle = `rgba(255,255,255,${((f - 1) * 0.8).toFixed(3)})`;
        g.fillRect(x, z, 16, 16);
      }
      if (fade > 0) {
        g.fillStyle = `rgba(${MAP_PALE.join(',')},${fade.toFixed(3)})`;
        g.fillRect(x, z, 16, 16);
      }
    }
    t.tex = c;
    built.add(t);
    return c;
  }

  return {
    of,
    frame: () => {
      budget = TEX_BUILDS_PER_FRAME;
      wanted = false;
    },
    pending: () => wanted,
    info: () => {
      let ok = 0;
      let missing = 0;
      for (const e of imgs.values()) {
        if (e.ok === true) ok++;
        else if (e.ok === false) missing++;
      }
      return { asked: imgs.size, ok, missing };
    },
  };
}
