// Item icons of the panel (docs/panel.md "Item icons", decision 0046): PNG helpers, Java model
// resolution, the inventory view of a block (which face is where, how it is shaded), the book's
// rules (sprite, block, nothing, aliases, layers, caching) on a small made-up asset set, and the
// real minecraft-assets package for the names the bot handles.
import { describe, expect, it } from 'vitest';
import { IconBook, texturePath } from '../../../src/health/panel/icons/book.ts';
import { resolveModel, type RawModel } from '../../../src/health/panel/icons/models.ts';
import { ALIASES, javaName } from '../../../src/health/panel/icons/names.ts';
import { decodePng, encodePng, firstFrame, overlay, tinted, type Raster } from '../../../src/health/panel/icons/png.ts';
import { renderModel } from '../../../src/health/panel/icons/render.ts';
import { assetDir, FsAssets, type AssetSource } from '../../../src/health/panel/icons/source.ts';

type Rgb = [number, number, number];
const solid = (rgb: Rgb, a = 255, w = 16, h = w): Raster => ({ w, h, data: Uint8Array.from({ length: w * h * 4 }, (_, i) => [rgb[0], rgb[1], rgb[2], a][i % 4]!) });
const pixel = (r: Raster, x: number, y: number): number[] => [...r.data.subarray((y * r.w + x) * 4, (y * r.w + x) * 4 + 4)];

const GUI = { rotation: [30, 225, 0], translation: [0, 0, 0], scale: [0.625, 0.625, 0.625] };
const FACES = { down: { texture: '#down' }, up: { texture: '#up' }, north: { texture: '#north' }, south: { texture: '#south' }, west: { texture: '#west' }, east: { texture: '#east' } };
const MODELS: [string, RawModel][] = [
  ['block', { display: { gui: GUI } } as RawModel],
  ['cube', { parent: 'block/block', elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: FACES }] }],
  ['cube_all', { parent: 'block/cube', textures: { down: '#all', up: '#all', north: '#all', south: '#all', west: '#all', east: '#all' } }],
  ['dice', { parent: 'block/cube', textures: { up: 'a/up', down: 'a/down', north: 'a/north', south: 'a/south', west: 'a/west', east: 'a/east' } }],
  ['stone', { parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/stone' } }],
  ['template_torch', { elements: [{ from: [7, 0, 7], to: [9, 10, 9], faces: FACES }] }],
  ['torch', { parent: 'minecraft:block/template_torch', textures: { torch: 'minecraft:block/torch' } }],
  ['chest', { textures: { particle: 'minecraft:block/oak_planks' } }],
  ['glass', { parent: 'block/cube_all', textures: { all: 'minecraft:block/glass' } }],
];

describe('png helpers', () => {
  it('encode then decode gives the same pixels', () => {
    const r = solid([10, 20, 30], 200, 4, 3);
    const back = decodePng(encodePng(r));
    expect([back.w, back.h]).toEqual([4, 3]);
    expect([...back.data]).toEqual([...r.data]);
  });

  it('firstFrame cuts an animation strip to its first square; a square stays as it is', () => {
    const strip: Raster = { w: 2, h: 6, data: Uint8Array.from({ length: 2 * 6 * 4 }, (_, i) => Math.floor(i / 16)) };
    const f = firstFrame(strip);
    expect([f.w, f.h]).toEqual([2, 2]);
    expect(new Set(f.data)).toEqual(new Set([0]));
    const sq = solid([1, 2, 3], 255, 2);
    expect(firstFrame(sq)).toBe(sq);
  });

  it('tinted multiplies the colour, overlay lays the top over the base by its alpha', () => {
    expect(pixel(tinted(solid([200, 100, 50]), 0x808080), 0, 0)).toEqual([100, 50, 25, 255]);
    const over = overlay(solid([0, 0, 200]), solid([200, 0, 0], 128));
    expect(pixel(over, 0, 0)).toEqual([100, 0, 100, 255]);
    expect(pixel(overlay(solid([0, 0, 200]), solid([200, 0, 0], 0)), 0, 0)).toEqual([0, 0, 200, 255]);
  });
});

describe('model resolution', () => {
  const models = new Map(MODELS);

  it('child textures win, #aliases are followed through the parents, boxes and the gui view come from up the chain', () => {
    const m = resolveModel(models, 'minecraft:block/stone')!;
    expect(m.chain).toEqual(['stone', 'cube_all', 'cube', 'block']);
    expect(m.textures.up).toBe('minecraft:block/stone');
    expect(m.textures.east).toBe('minecraft:block/stone');
    expect(m.elements).toHaveLength(1);
    expect(m.gui).toEqual(GUI);
    expect(resolveModel(models, 'nothing_like_it')).toBeUndefined();
  });

  it('an alias that points nowhere is left out; a parent loop stops', () => {
    const loop = new Map<string, RawModel>([['a', { parent: 'b', textures: { x: '#y', y: '#x' } }], ['b', { parent: 'a' }]]);
    const m = resolveModel(loop, 'a')!;
    expect(m.chain.length).toBeLessThanOrEqual(12);
    expect(m.textures.x).toBeUndefined();
  });
});

describe('the inventory view of a block', () => {
  const dice = resolveModel(new Map(MODELS), 'dice')!;
  const textures: Record<string, Raster> = { 'a/up': solid([200, 0, 0]), 'a/east': solid([0, 200, 0]), 'a/north': solid([0, 0, 200]), 'a/down': solid([9, 9, 9]), 'a/south': solid([9, 9, 9]), 'a/west': solid([9, 9, 9]) };
  const view = renderModel(dice, { size: 32, texture: (ref) => textures[ref] })!;

  it('shows the top, the east face on the left and the north face on the right, shaded 100 / 80 / 60 %', () => {
    expect([view.w, view.h]).toEqual([32, 32]);
    expect(pixel(view, 16, 7)).toEqual([200, 0, 0, 255]);
    expect(pixel(view, 9, 19)).toEqual([0, 160, 0, 255]);
    expect(pixel(view, 23, 19)).toEqual([0, 0, 120, 255]);
  });

  it('is the hexagon of a block: corners clear, about three quarters of the square covered, nothing of the hidden faces', () => {
    for (const [x, y] of [[0, 0], [31, 0], [0, 31], [31, 31]] as const) expect(pixel(view, x, y)[3]).toBe(0);
    let opaque = 0;
    for (let i = 3; i < view.data.length; i += 4) if (view.data[i] === 255) opaque++;
    expect(opaque).toBeGreaterThan(32 * 32 * 0.6);
    expect(opaque).toBeLessThan(32 * 32 * 0.85);
    for (let i = 0; i < view.data.length; i += 4) for (const c of [0, 1, 2]) expect([9, 7, 5]).not.toContain(view.data[i + c]); // the gray hidden faces (9 * shade) never show
  });

  it('faces are laid over each other front to back: a half clear box shows the one behind it; faces turned away are not drawn', () => {
    const face = { up: { texture: '#up' } };
    const two = { ...dice, elements: [{ from: [0, 0, 0] as [number, number, number], to: [16, 16, 16] as [number, number, number], faces: face }, { from: [0, 1, 0] as [number, number, number], to: [16, 17, 16] as [number, number, number], faces: { up: { texture: '#up2' } } }], textures: { up: 'a/up', up2: 'a/glass' } };
    const both = renderModel(two, { size: 32, texture: (ref) => (ref === 'a/glass' ? solid([0, 0, 200], 128) : textures[ref]) })!;
    const [r, g, b, a] = pixel(both, 16, 7);
    expect(a).toBe(255);
    expect(g).toBe(0);
    expect(r).toBeGreaterThan(90);
    expect(r).toBeLessThan(110);
    expect(b).toBeGreaterThan(90);
    expect(b).toBeLessThan(110);
    const clear = { ...dice, textures: { ...dice.textures, up: 'a/clear' } };
    expect(pixel(renderModel(clear, { size: 32, texture: (ref) => (ref === 'a/clear' ? solid([0, 0, 0], 0) : textures[ref]) })!, 16, 7)[3]).toBe(0); // the faces below the top are turned away: nothing shows through
  });

  it('a tint multiplies a face with a tintindex and leaves the others', () => {
    const tintedModel = { ...dice, elements: [{ ...dice.elements[0]!, faces: { ...dice.elements[0]!.faces, up: { texture: '#up', tintindex: 0 } } }] };
    const green = renderModel(tintedModel, { size: 32, texture: (ref) => textures[ref], tint: (i) => (i === 0 ? 0x00ff00 : undefined) })!;
    expect(pixel(green, 16, 7)).toEqual([0, 0, 0, 255]); // red * green = black
    expect(pixel(green, 9, 19)).toEqual([0, 160, 0, 255]); // an untinted face stays
  });

  it('no view without display.gui, nothing drawn without textures', () => {
    expect(renderModel({ ...dice, gui: undefined }, { size: 32, texture: (ref) => textures[ref] })).toBeUndefined();
    expect(renderModel(dice, { size: 32, texture: () => undefined })).toBeUndefined();
  });
});

class MemAssets implements AssetSource {
  reads = 0;
  failing = false;
  private readonly items: { name: string; texture: string | null }[];
  private readonly pngs: Record<string, Raster>;
  constructor(items: { name: string; texture: string | null }[], pngs: Record<string, Raster>) {
    this.items = items;
    this.pngs = pngs;
  }
  json(file: string): Promise<unknown> {
    this.reads++;
    if (this.failing) return Promise.reject(new Error('disk'));
    return Promise.resolve(file === 'items_textures.json' ? this.items : Object.fromEntries(MODELS));
  }
  png(path: string): Promise<Uint8Array | undefined> {
    const r = this.pngs[path];
    return Promise.resolve(r ? encodePng(r) : undefined);
  }
}

const ITEMS = [
  { name: 'iron_sword', texture: 'minecraft:items/iron_sword' },
  { name: 'stone', texture: 'minecraft:block/stone' },
  { name: 'torch', texture: 'minecraft:block/torch' },
  { name: 'oak_door', texture: 'minecraft:items/oak_door' },
  { name: 'chest', texture: 'block/oak_planks' },
  { name: 'compass', texture: null },
  { name: 'white_bed', texture: 'block/white_wool' },
];
const PNGS: Record<string, Raster> = {
  'items/iron_sword': solid([180, 180, 190]),
  'blocks/stone': solid([120, 120, 120]),
  'blocks/torch': solid([250, 200, 0]),
  'items/oak_door': solid([150, 100, 50]),
  'items/compass_16': solid([90, 90, 90]),
  'items/leather_helmet': solid([128, 128, 128]),
  'items/leather_helmet_overlay': solid([255, 255, 255], 0),
  'blocks/oak_planks': solid([160, 130, 80]),
};

describe('IconBook', () => {
  const book = () => new IconBook(new MemAssets(ITEMS, PNGS));

  it('an item with a sprite is that sprite, 16 x 16; a block is its inventory view, 32 x 32', async () => {
    const b = book();
    expect(decodePng((await b.png('iron_sword'))!)).toEqual(solid([180, 180, 190]));
    const stone = decodePng((await b.png('stone'))!);
    expect([stone.w, stone.h]).toEqual([32, 32]);
    expect(pixel(stone, 16, 7)).toEqual([120, 120, 120, 255]); // the top, unshaded
  });

  it('blocks the game draws flat (torch) are a sprite; entity models (chest, bed) and unknown names have none', async () => {
    const b = book();
    expect(decodePng((await b.png('torch'))!).w).toBe(16);
    expect(await b.png('chest')).toBeUndefined();
    expect(await b.png('bed')).toBeUndefined();
    expect(await b.png('white_bed')).toBeUndefined();
    expect(await b.png('no_such_item')).toBeUndefined();
  });

  it('Bedrock names go through the aliases; an item without a texture falls back to its frame file', async () => {
    const b = book();
    expect(ALIASES.wooden_door).toBe('oak_door');
    expect(javaName('wooden_door')).toBe('oak_door');
    expect(javaName('iron_sword')).toBe('iron_sword');
    expect(decodePng((await b.png('wooden_door'))!)).toEqual(solid([150, 100, 50]));
    expect(decodePng((await b.png('compass'))!)).toEqual(solid([90, 90, 90]));
  });

  it('leather armour is its texture tinted brown with the overlay on top', async () => {
    const r = decodePng((await book().png('leather_helmet'))!);
    expect(pixel(r, 0, 0)).toEqual([Math.round((128 * 0xa0) / 255), Math.round((128 * 0x65) / 255), Math.round((128 * 0x40) / 255), 255]);
  });

  it('answers are kept (the index is read once), a read error is not kept', async () => {
    const src = new MemAssets(ITEMS, PNGS);
    const b = new IconBook(src);
    const [a, c] = await Promise.all([b.png('stone'), b.png('stone')]);
    expect(a).toBe(c);
    await b.png('iron_sword');
    expect(src.reads).toBe(2); // items_textures.json and blocks_models.json, once
    const flaky = new MemAssets(ITEMS, PNGS);
    flaky.failing = true;
    const f = new IconBook(flaky);
    expect(await f.png('stone')).toBeUndefined();
    flaky.failing = false;
    expect(await f.png('stone')).toBeDefined();
  });

  it('texturePath maps the references of the package to its folders', () => {
    expect(texturePath('minecraft:block/dirt')).toBe('blocks/dirt');
    expect(texturePath('block/dirt')).toBe('blocks/dirt');
    expect(texturePath('minecraft:items/oak_door')).toBe('items/oak_door');
    expect(texturePath('item/apple')).toBe('items/apple');
  });
});

describe('the minecraft-assets package', () => {
  const dir = assetDir();
  const real = () => new IconBook(new FsAssets(dir!));

  it('is installed, with the version the panel uses', () => {
    expect(dir).toBeDefined();
    expect(dir).toMatch(/26\.1$/);
  });

  it('draws what the bot carries: tools, armour, food, blocks, stairs, ores, rockets (Bedrock names)', async () => {
    const b = real();
    const names = [
      'iron_sword', 'diamond_pickaxe', 'netherite_axe', 'golden_shovel', 'wooden_hoe', 'bow', 'crossbow', 'arrow', 'trident', 'elytra', 'firework_rocket', 'fireworks',
      'iron_helmet', 'diamond_chestplate', 'leather_leggings', 'chainmail_boots', 'turtle_helmet', 'cooked_beef', 'bread', 'apple', 'golden_apple', 'carrot', 'baked_potato', 'cooked_porkchop',
      'oak_planks', 'cobblestone', 'stone', 'dirt', 'sand', 'gravel', 'oak_log', 'birch_log', 'oak_leaves', 'grass_block', 'glass', 'crafting_table', 'furnace', 'barrel', 'tnt', 'bookshelf',
      'oak_stairs', 'stone_stairs', 'oak_slab', 'cobblestone_wall', 'oak_fence', 'iron_ore', 'deepslate_diamond_ore', 'coal', 'iron_ingot', 'raw_iron', 'diamond', 'redstone', 'lapis_lazuli',
      'torch', 'oak_door', 'wooden_door', 'bucket', 'water_bucket', 'compass', 'clock', 'stick', 'bone_meal', 'wheat_seeds', 'oak_sapling', 'glass_bottle', 'potion', 'ender_pearl', 'book', 'name_tag',
    ];
    const missing: string[] = [];
    for (const n of names) if (!(await b.png(n))) missing.push(n);
    expect(missing).toEqual([]);
  });

  it('blocks are 32 x 32, items 16 x 16, grass is green on top, leaves are tinted', async () => {
    const b = real();
    expect(decodePng((await b.png('iron_sword'))!).w).toBe(16);
    const planks = decodePng((await b.png('oak_planks'))!);
    expect([planks.w, planks.h]).toEqual([32, 32]);
    const grass = pixel(decodePng((await b.png('grass_block'))!), 16, 7);
    expect(grass[1]).toBeGreaterThan(grass[0]!);
    expect(grass[1]).toBeGreaterThan(grass[2]!);
    const leaves = decodePng((await b.png('oak_leaves'))!);
    const greens = [...Array(32 * 32).keys()].filter((i) => leaves.data[i * 4 + 3]! > 200 && leaves.data[i * 4 + 1]! > leaves.data[i * 4]! && leaves.data[i * 4 + 1]! > leaves.data[i * 4 + 2]!);
    expect(greens.length).toBeGreaterThan(100);
  });

  it('what the game draws as an entity model has no picture (the panel keeps its glyph)', async () => {
    const b = real();
    for (const n of ['chest', 'ender_chest', 'white_shulker_box', 'undyed_shulker_box', 'bed', 'shield', 'player_head', 'standing_banner']) expect(await b.png(n), n).toBeUndefined();
  });
});
