// Track PC (decision 0060): map colours of blocks (health/panel/icons/colours.ts) and the shared map
// painting (health/map/paint.ts PAINT_JS): the top-face average (alpha-aware, tinted), the model and
// state lookups, the class fallbacks, the relief rule and the guard that the common overworld surface
// blocks all get a colour from the installed package.
import { describe, expect, it } from 'vitest';
import { averageColour, BlockColours, CLASS_FALLBACK, fallbackColour, firstStateModel, hexColour, installedBlockColours, javaBlockName, mapTint, topTexture, WATER_TINT } from '../../../src/health/panel/icons/colours.ts';
import { GRASS } from '../../../src/health/panel/icons/names.ts';
import { resolveModel, type RawModel } from '../../../src/health/panel/icons/models.ts';
import { encodePng } from '../../../src/health/panel/icons/png.ts';
import { assetDir, type AssetSource } from '../../../src/health/panel/icons/source.ts';
import { mapClassColour, mapDecodeTile, mapDescribe, mapHexRgb, mapLayerFor, mapPixels, mapRelief, mapWaterShade, PAINT_JS } from '../../../src/health/map/paint.ts';
import type { MapTileJson } from '../../../src/health/map/schema.ts';

/** A 2 x 2 RGBA texture. */
const tex = (px: number[][]): Uint8Array => new Uint8Array(px.flat());

describe('block colours: the average', () => {
  it('weights texels by alpha and ignores transparent ones', () => {
    expect(averageColour(tex([[255, 0, 0, 255], [0, 0, 255, 255], [0, 255, 0, 0], [0, 255, 0, 0]]))).toBe(0x800080);
    expect(averageColour(tex([[255, 255, 255, 255], [0, 0, 0, 85], [0, 0, 0, 0], [0, 0, 0, 0]]))).toBe(0xbfbfbf);
    expect(averageColour(tex([[1, 2, 3, 0]]))).toBeUndefined();
  });

  it('multiplies the tint in (grey grass becomes green)', () => {
    expect(averageColour(tex([[255, 255, 255, 255]]), GRASS)).toBe(GRASS);
    expect(averageColour(tex([[128, 128, 128, 255]]), 0xff0000)).toBe(0x800000);
  });

  it('names: Bedrock -> Java blocks, tints of water, grass, leaves and plants', () => {
    expect(javaBlockName('snow')).toBe('snow_block');
    expect(javaBlockName('snow_layer')).toBe('snow');
    expect(javaBlockName('flowing_water')).toBe('water');
    expect(javaBlockName('grass_block')).toBe('grass_block');
    expect(mapTint('water')).toBe(WATER_TINT);
    expect(mapTint('grass_block')).toBe(GRASS);
    expect(mapTint('oak_leaves')).toBeDefined();
    expect(mapTint('short_grass')).toBe(GRASS);
    expect(mapTint('stone')).toBeUndefined();
  });

  it('the top texture: the up face of the highest box, else the model textures', () => {
    const models = new Map<string, RawModel>([
      ['block', {}],
      ['cube', { parent: 'block', elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { up: { texture: '#up', tintindex: 0 }, north: { texture: '#side' } } }] }],
      ['grassy', { parent: 'cube', textures: { up: 'block/grassy_top', side: 'block/grassy_side' } }],
      ['slabby', { parent: 'block', textures: { t: 'block/low' }, elements: [{ from: [0, 0, 0], to: [16, 8, 16], faces: { up: { texture: '#t' } } }, { from: [0, 0, 0], to: [16, 4, 16], faces: { up: { texture: 'block/lower' } } }] }],
      ['watery', { textures: { particle: 'block/water_still' } }],
      ['crossy', { parent: 'block', textures: { cross: 'block/flower' }, elements: [{ from: [0, 0, 8], to: [16, 16, 8], rotation: { angle: 45 }, faces: { up: { texture: '#cross' } } }] }],
    ]);
    expect(topTexture(resolveModel(models, 'grassy')!)).toEqual({ ref: 'block/grassy_top', tinted: true, face: true });
    expect(topTexture(resolveModel(models, 'slabby')!)).toEqual({ ref: 'block/low', tinted: false, face: true });
    expect(topTexture(resolveModel(models, 'watery')!)).toEqual({ ref: 'block/water_still', tinted: false, face: false });
    expect(topTexture(resolveModel(models, 'crossy')!)).toEqual({ ref: 'block/flower', tinted: false, face: false }); // rotated planes: the cross texture
    expect(firstStateModel({ variants: { 'snowy=false': [{ model: 'minecraft:block/a' }, { model: 'minecraft:block/b' }] } })).toBe('minecraft:block/a');
    expect(firstStateModel({ multipart: [{ apply: { model: 'minecraft:block/c' } }] })).toBe('minecraft:block/c');
    expect(firstStateModel(undefined)).toBeUndefined();
  });

  it('a fake package: computed once, cached, null without art, class fallbacks', async () => {
    let reads = 0;
    const png = (rgba: number[]) => encodePng({ w: 1, h: 1, data: new Uint8Array(rgba) });
    const files: Record<string, Uint8Array> = { 'blocks/redstuff': png([200, 10, 10, 255]), 'blocks/water_still': png([200, 200, 200, 255]) };
    const src: AssetSource = {
      json: (file) => Promise.resolve(file === 'blocks_states.json' ? { redstuff: { variants: { '': { model: 'minecraft:block/redstuff' } } }, water: { variants: { '': { model: 'minecraft:block/water' } } } } : { block: {}, cube_all: { parent: 'block', elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { up: { texture: '#all' } } }] }, redstuff: { parent: 'cube_all', textures: { all: 'block/redstuff' } }, water: { textures: { particle: 'block/water_still' } } }),
      png: (path) => {
        reads++;
        return Promise.resolve(files[path]);
      },
    };
    const c = new BlockColours(src);
    expect(c.peek('redstuff')).toBeUndefined();
    await c.load(['redstuff', 'water', 'no_such_block']);
    expect(c.peek('redstuff')).toBe(0xc80a0a);
    expect(c.peek('water')).toBe(averageColour(new Uint8Array([200, 200, 200, 255]), WATER_TINT));
    expect(c.peek('no_such_block')).toBeNull();
    const n = reads;
    expect(await c.colour('redstuff')).toBe(0xc80a0a);
    expect(reads).toBe(n);
    expect(CLASS_FALLBACK).toHaveLength(4);
    expect(fallbackColour(2)).toBe(CLASS_FALLBACK[2]);
    expect(fallbackColour(9)).toBe(CLASS_FALLBACK[1]);
    expect(hexColour(0x0a0b0c)).toBe('#0a0b0c');
  });
});

/** Common surface blocks of the overworld and the Nether (Bedrock names). */
const COMMON = ['grass_block', 'sand', 'red_sand', 'stone', 'water', 'lava', 'oak_leaves', 'spruce_leaves', 'birch_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves', 'snow', 'snow_layer', 'dirt', 'coarse_dirt', 'podzol', 'mycelium', 'gravel', 'ice', 'packed_ice', 'blue_ice', 'sandstone', 'terracotta', 'clay', 'mud', 'moss_block', 'dirt_path', 'farmland', 'short_grass', 'tall_grass', 'fern', 'poppy', 'dandelion', 'oak_log', 'spruce_log', 'birch_log', 'cactus', 'sugar_cane', 'lily_pad', 'deepslate', 'calcite', 'tuff', 'cobblestone', 'oak_planks', 'netherrack', 'crimson_nylium', 'warped_nylium', 'soul_sand', 'soul_soil', 'basalt', 'blackstone', 'bedrock', 'magma', 'glowstone', 'obsidian', 'pumpkin', 'end_stone'];

describe.skipIf(!assetDir())('block colours from the installed minecraft-assets package (guard)', () => {
  it('every common surface block gets a colour', async () => {
    const c = installedBlockColours()!;
    expect(c).not.toBeNull();
    await c.load(COMMON);
    const missing = COMMON.filter((n) => typeof c.peek(n) !== 'number');
    expect(missing).toEqual([]);
    const rgb = (n: string) => mapHexRgb(hexColour(c.peek(n)!))!;
    // plausibility: grass and leaves green, water blue, sand light, lava red-orange
    for (const n of ['grass_block', 'oak_leaves']) expect(rgb(n)[1], n).toBeGreaterThan(Math.max(rgb(n)[0], rgb(n)[2]));
    expect(rgb('water')[2]).toBeGreaterThan(rgb('water')[0]);
    expect(rgb('sand').reduce((a, b) => a + b)).toBeGreaterThan(500);
    expect(rgb('lava')[0]).toBeGreaterThan(rgb('lava')[2]);
  });
});

// ---- paint.ts ----

const b64 = (a: Uint8Array | Int16Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');

/** A tile: heights `ys` (one per row z), classes solid, surface names by column from `name(x, z)` over palette ['stone', 'water', 'grass_block']. */
function tile(o: { cz?: number; ys?: (z: number) => number; name?: (x: number, z: number) => number; liquid?: boolean; live?: boolean; noSurface?: boolean }): MapTileJson {
  const y = new Int16Array(256);
  const c = new Uint8Array(64);
  const s = new Uint8Array(256);
  const f = new Uint8Array(256).fill(255);
  const d = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const x = i & 15;
    const z = i >> 4;
    y[i] = o.ys ? o.ys(z) : 64;
    s[i] = o.name ? o.name(x, z) : 0;
    c[i >> 2] = c[i >> 2]! | ((s[i] === 1 ? 2 : 1) << ((i & 3) * 2));
    if (s[i] === 1) {
      f[i] = 0;
      d[i] = x;
    }
  }
  const t: MapTileJson = { cx: 0, cz: o.cz ?? 0, live: o.live ?? true, rev: 1, updatedAt: 0, y: b64(y), c: b64(c) };
  if (!o.noSurface) Object.assign(t, { s: b64(s), p: [0, 1, 2] }, o.liquid ? { f: b64(f), d: b64(d) } : {});
  return t;
}
const PAL = [{ name: 'stone', rgb: '#808080' }, { name: 'water', rgb: '#2040c0' }, { name: 'grass_block', rgb: null }];
const px = (p: Uint8ClampedArray, x: number, z: number) => Array.from(p.subarray((z * 16 + x) * 4, (z * 16 + x) * 4 + 3));

describe('map painting (PAINT_JS)', () => {
  it('is plain JavaScript the page embeds (no backticks, no template holes, no imports)', () => {
    expect(PAINT_JS).not.toMatch(/`|\$\{|\bimport\b|\brequire\(/);
  });

  it('relief: darker when the north neighbour is higher, lighter when lower, the same when equal or unknown', () => {
    expect(mapRelief(64, 65)).toBeLessThan(1);
    expect(mapRelief(64, 63)).toBeGreaterThan(1);
    expect(mapRelief(64, 64)).toBe(1);
    expect(mapRelief(64, null)).toBe(1);
    expect(mapWaterShade(1, 0, 0)).toBeGreaterThan(1);
    expect(mapWaterShade(12, 0, 0)).toBeLessThan(1);
    expect(mapWaterShade(4, 0, 0)).not.toBe(mapWaterShade(4, 1, 0)); // the checkerboard
  });

  it('paints the block view with the palette colours and the relief (north = the row above, or the tile to the north)', () => {
    // a slope rising to the south: every row higher than the one to the north
    const dec = mapDecodeTile(tile({ ys: (z) => 60 + z }), PAL);
    const north = mapDecodeTile(tile({ cz: -1, ys: () => 100 }), PAL);
    const p = mapPixels(dec, 'block', 'auto', north);
    expect(px(p, 3, 5)).toEqual([0x80, 0x80, 0x80].map((v) => Math.round(v * (255 / 220))));
    expect(px(p, 3, 0)).toEqual([0x80, 0x80, 0x80].map((v) => Math.round(v * (180 / 220)))); // row 0 under a higher tile to the north
    expect(px(mapPixels(dec, 'block', 'auto', null), 3, 0)).toEqual([0x80, 0x80, 0x80]); // no north tile: flat
    // no colour in the palette: the class colour (solid) with the relief
    const g = mapDecodeTile(tile({ name: () => 2, ys: () => 64 }), PAL);
    expect(px(mapPixels(g, 'block', 'auto', null), 0, 4)).toEqual([138, 138, 128]);
  });

  it('shades liquids by depth, dims remembered tiles, and keeps the class view of before', () => {
    const dec = mapDecodeTile(tile({ name: (x) => (x < 12 ? 1 : 0), liquid: true }), PAL);
    const p = mapPixels(dec, 'block', 'auto', null);
    expect(px(p, 0, 0)).toEqual([0x20, 0x40, 0xc0].map((v) => Math.round(v * (255 / 220)))); // depth 0 (x) -> shallow
    expect(px(p, 10, 0)).toEqual([0x20, 0x40, 0xc0].map((v) => Math.round(v * (180 / 220)))); // depth 10 -> deep
    expect(mapDescribe(dec, 'auto', 5)).toBe('water, y 64, 5 deep over stone');
    expect(mapDescribe(dec, 'auto', 13)).toBe('stone, y 64');
    const cls = mapPixels(dec, 'class', 'auto', null);
    expect(px(cls, 13, 0)).toEqual(mapClassColour(1, 64));
    const dim = mapPixels(mapDecodeTile(tile({ live: false }), PAL), 'block', 'auto', null);
    expect(px(dim, 2, 2)).toEqual([0x80, 0x80, 0x80].map((v) => Math.round(v * 0.55)));
  });

  it('tiles without surface data (old records) draw by class in both views', () => {
    const dec = mapDecodeTile(tile({ noSurface: true, ys: () => 70 }), PAL);
    expect(dec.top).toBeNull();
    expect(mapLayerFor(dec, 'auto')).toBe('top');
    expect(px(mapPixels(dec, 'block', 'auto', null), 1, 1)).toEqual([138, 138, 128]);
    expect(px(mapPixels(dec, 'class', 'auto', null), 1, 1)).toEqual(mapClassColour(1, 70));
    expect(mapDescribe(dec, 'auto', 0)).toBe('solid at y 70');
  });
});
