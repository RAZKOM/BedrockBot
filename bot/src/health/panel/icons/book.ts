// Item icons of the panel (docs/panel.md "Item icons", decision 0046): the PNG of an item, from the
// Java textures of the minecraft-assets package. Items the game draws from a sprite are that sprite
// (16 x 16, shown pixelated); blocks are their inventory view (32 x 32), drawn from the block model
// (render.ts). What has no art (chests, shulker boxes and beds are entity models in the game, items
// newer than the package) is undefined and the page keeps its hand-drawn glyph. Built lazily on the
// first request; every answer, also "none", is kept.
import type { AssetSource } from './source.ts';
import { blockTint, javaName, layered, NO_ICON, SOLID_PARENTS, SPRITE_BLOCKS, spritePaths, spriteTint, type SpriteLayer } from './names.ts';
import { resolveModel, type RawModel, type ResolvedModel } from './models.ts';
import { decodePng, encodePng, firstFrame, overlay, tinted, type Raster } from './png.ts';
import { renderModel } from './render.ts';

/** Output size of a block's inventory view. */
export const BLOCK_ICON_SIZE = 32;
/** Names kept at most (a request names anything; the real set is about 1500). */
const CACHE_MAX = 4096;

interface Index {
  /** items_textures.json: Java item name -> the texture the item is drawn with. */
  textures: Map<string, string | null>;
  models: Map<string, RawModel>;
}

type Plan = { kind: 'sprite'; layers: SpriteLayer[][] } | { kind: 'block'; model: ResolvedModel; tint: number | undefined };

/** `minecraft:items/iron_sword` -> `items/iron_sword`, `block/dirt` -> `blocks/dirt` (the package's folders). */
export function texturePath(ref: string): string {
  return ref.replace(/^minecraft:/, '').replace(/^block\//, 'blocks/').replace(/^item\//, 'items/');
}

export class IconBook {
  private readonly src: AssetSource;
  private index: Promise<Index> | undefined;
  private readonly answers = new Map<string, Promise<Buffer | undefined>>();
  private readonly rasters = new Map<string, Promise<Raster | undefined>>();

  constructor(src: AssetSource) {
    this.src = src;
  }

  /** The PNG for a Bedrock item name (`iron_sword`, `oak_planks`), undefined when there is no art for it. */
  png(name: string): Promise<Buffer | undefined> {
    let p = this.answers.get(name);
    if (!p) {
      if (this.answers.size >= CACHE_MAX) this.answers.clear();
      p = this.make(name).catch((): undefined => {
        this.answers.delete(name); // a read error is not an answer: try again next time
        return undefined;
      });
      this.answers.set(name, p);
    }
    return p;
  }

  private load(): Promise<Index> {
    this.index ??= (async (): Promise<Index> => {
      const [items, models] = await Promise.all([this.src.json('items_textures.json'), this.src.json('blocks_models.json')]);
      const textures = new Map<string, string | null>();
      for (const e of items as { name: string; texture: string | null }[]) textures.set(e.name, e.texture);
      return { textures, models: new Map(Object.entries(models as Record<string, RawModel>)) };
    })().catch((e: unknown) => {
      this.index = undefined;
      throw e;
    });
    return this.index;
  }

  private raster(path: string): Promise<Raster | undefined> {
    let p = this.rasters.get(path);
    if (!p) {
      p = this.src.png(path).then((b) => (b ? firstFrame(decodePng(b)) : undefined));
      this.rasters.set(path, p);
    }
    return p;
  }

  private async make(name: string): Promise<Buffer | undefined> {
    const idx = await this.load();
    const j = javaName(name);
    const plan = this.plan(idx, j);
    if (!plan) return undefined;
    if (plan.kind === 'block') {
      // load every texture the model names, then draw synchronously
      const refs = new Set<string>(Object.values(plan.model.textures));
      const loaded = new Map<string, Raster>();
      await Promise.all([...refs].map(async (ref) => { const r = await this.raster(texturePath(ref)); if (r) loaded.set(ref, r); }));
      const out = renderModel(plan.model, { size: BLOCK_ICON_SIZE, texture: (ref) => loaded.get(ref), tint: (i) => (i === 0 ? plan.tint : undefined) });
      return out ? encodePng(out) : undefined;
    }
    let out: Raster | undefined;
    for (const choice of plan.layers) { // each layer has paths to try: the first file found counts
      let layer: Raster | undefined;
      for (const l of choice) {
        const r = await this.raster(l.path);
        if (r) {
          layer = l.tint === undefined ? r : tinted(r, l.tint);
          break;
        }
      }
      if (layer) out = out ? overlay(out, layer) : layer;
    }
    return out ? encodePng(out) : undefined;
  }

  /** What an item is drawn from: its block model, a sprite (with the paths to try), or nothing. */
  private plan(idx: Index, j: string): Plan | undefined {
    if (NO_ICON.test(j)) return undefined;
    const layers = layered(j);
    if (layers) return { kind: 'sprite', layers: layers.map((l) => [l]) };
    const ref = idx.textures.get(j) ?? undefined;
    const spriteRef = ref !== undefined && !ref.includes('missingno') ? texturePath(ref) : undefined;
    const isItemTexture = spriteRef?.startsWith('items/') === true;
    const tint = spriteTint(j);
    const sprite = (): Plan => ({
      kind: 'sprite',
      layers: [spritePaths(j, spriteRef).map((path): SpriteLayer => (tint === undefined ? { path } : { path, tint }))],
    });
    if (isItemTexture) return sprite();
    const key = idx.models.has(`${j}_inventory`) ? `${j}_inventory` : j;
    const model = resolveModel(idx.models, key);
    if (model) {
      const solid = model.chain.some((c) => SOLID_PARENTS.has(c)) || (model.chain.length === 2 && model.chain[1] === 'block' && !SPRITE_BLOCKS.has(j));
      if (solid && model.gui && model.elements.length > 0 && !model.elements.some((e) => e.rotation !== undefined)) return { kind: 'block', model, tint: blockTint(j) };
      if (model.chain.length === 1 && model.elements.length === 0) return undefined; // entity-rendered (chest, shulker box)
    }
    return sprite();
  }
}
