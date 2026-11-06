// Map colours of blocks (Track PC, decision 0060; docs/world-cache.md "Block colours"): the colour a 2D
// map paints a block with, the average of the block's top face as the game draws it, from the Java art
// of the minecraft-assets package (the same reader, model resolution, Bedrock -> Java names and tints as
// the item icons, decision 0046). Alpha-aware: transparent texels do not count, half-transparent ones
// count by their alpha. Computed on the first request per name and kept; nothing derived from the art
// is written anywhere (it lives in this process's memory only). A block without art (Bedrock-only
// blocks, entity-rendered ones) has no colour, and the map uses the fallback colour of its cache class.
import { blockTint, GRASS, javaName, spriteTint } from './names.ts';
import { faceTexture, modelKey, resolveModel, type RawModel, type ResolvedModel } from './models.ts';
import { decodePng, encodePng, firstFrame, tinted, type Raster } from './png.ts';
import { texturePath } from './book.ts';
import { assetDir, FsAssets, type AssetSource } from './source.ts';

/** The water colour of the plains biome (the water textures are grey and tinted by the game). */
export const WATER_TINT = 0x3f76e4;

/** Fallback colours per cache class (air / nothing, solid, water, avoid), `0xRRGGBB`: a block without art. */
export const CLASS_FALLBACK: readonly number[] = [0x181a1e, 0x8a8a80, 0x2f6fd0, 0xe0531f];

/** The fallback colour of a cache class (0 air, 1 solid, 2 water, 3 avoid). */
export function fallbackColour(cls: number): number {
  return CLASS_FALLBACK[cls] ?? CLASS_FALLBACK[1]!;
}

/** Bedrock names the map meets on the surface whose Java block is named otherwise (beyond the icons' ALIASES). */
const MAP_ALIASES: Readonly<Record<string, string>> = {
  flowing_water: 'water',
  flowing_lava: 'lava',
  yellow_flower: 'dandelion',
  red_flower: 'poppy',
  double_plant: 'tall_grass',
  bubble_column: 'water',
  seagrass: 'water',
  kelp: 'water',
  lit_redstone_lamp: 'redstone_lamp',
  unlit_redstone_torch: 'redstone_torch',
  standing_sign: 'oak_sign',
  wall_sign: 'oak_wall_sign',
  monster_egg: 'infested_stone',
  stonebrick: 'stone_bricks',
  magma: 'magma_block',
};

/** The Java block a Bedrock block name is drawn as. */
export function javaBlockName(bedrock: string): string {
  return MAP_ALIASES[bedrock] ?? javaName(bedrock);
}

/** The tint the game multiplies into a tinted face of this (Java) block, plains biome. */
export function mapTint(j: string): number | undefined {
  if (j === 'water') return WATER_TINT;
  if (j === 'sugar_cane') return GRASS;
  return blockTint(j) ?? spriteTint(j);
}

/** Texture variables tried, in order, when no box of the model has an up face (water, plants drawn as crossed planes). */
const TOP_VARS = ['top', 'end', 'up', 'all', 'cross', 'texture', 'plant', 'particle'] as const;

/**
 * The texture the map sees of a model: the up face of its highest unrotated box (with whether that face
 * is tinted), else the first of TOP_VARS the model names. undefined when the model names no texture.
 */
export function topTexture(m: ResolvedModel): { ref: string; tinted: boolean; face: boolean } | undefined {
  let best: { ref: string; tinted: boolean; top: number } | undefined;
  for (const el of m.elements) {
    if (el.rotation !== undefined) continue;
    const up = el.faces.up;
    if (!up) continue;
    const ref = faceTexture(m, up.texture);
    if (ref === undefined) continue;
    if (!best || el.to[1] > best.top) best = { ref, tinted: up.tintindex !== undefined, top: el.to[1] };
  }
  if (best) return { ref: best.ref, tinted: best.tinted, face: true };
  for (const v of TOP_VARS) {
    const ref = m.textures[v];
    if (ref !== undefined) return { ref, tinted: false, face: false };
  }
  return undefined;
}

/** The model a block state file points at first (the first variant, or the first multipart part). */
export function firstStateModel(state: unknown): string | undefined {
  const pick = (v: unknown): string | undefined => {
    const one = Array.isArray(v) ? (v as unknown[])[0] : v;
    const model = typeof one === 'object' && one !== null ? (one as { model?: unknown }).model : undefined;
    return typeof model === 'string' ? model : undefined;
  };
  if (typeof state !== 'object' || state === null) return undefined;
  const s = state as { variants?: Record<string, unknown>; multipart?: { apply?: unknown }[] };
  if (s.variants) {
    for (const v of Object.values(s.variants)) {
      const m = pick(v);
      if (m) return m;
    }
  }
  for (const part of s.multipart ?? []) {
    const m = pick(part.apply);
    if (m) return m;
  }
  return undefined;
}

/** Alpha-weighted mean of RGBA pixels, `0xRRGGBB`, or undefined when every pixel is transparent. */
export function averageColour(data: Uint8Array, tint?: number): number | undefined {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let i = 0; i < data.length; i += 4) {
    const w = data[i + 3]!;
    if (w === 0) continue;
    r += data[i]! * w;
    g += data[i + 1]! * w;
    b += data[i + 2]! * w;
    a += w;
  }
  if (a === 0) return undefined;
  r /= a;
  g /= a;
  b /= a;
  if (tint !== undefined) {
    r = (r * ((tint >> 16) & 255)) / 255;
    g = (g * ((tint >> 8) & 255)) / 255;
    b = (b * (tint & 255)) / 255;
  }
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

/** `0xRRGGBB` -> `#rrggbb`. */
export const hexColour = (rgb: number): string => `#${rgb.toString(16).padStart(6, '0')}`;

interface Index {
  states: Record<string, unknown>;
  models: Map<string, RawModel>;
}

const CACHE_MAX = 4096;

/** Map colours of block names, computed lazily from the package's art and kept. */
export class BlockColours {
  private readonly src: AssetSource;
  private index: Promise<Index> | undefined;
  private readonly pending = new Map<string, Promise<number | null>>();
  private readonly done = new Map<string, number | null>();

  constructor(src: AssetSource) {
    this.src = src;
  }

  /** The colour when already computed: a number, null = no art (use the class fallback), undefined = not computed yet. */
  peek(name: string): number | null | undefined {
    return this.done.get(name);
  }

  /** The colour of a Bedrock block name (`grass_block`, `water`), null when the package has no art for it. */
  colour(name: string): Promise<number | null> {
    const d = this.done.get(name);
    if (d !== undefined) return Promise.resolve(d);
    let p = this.pending.get(name);
    if (!p) {
      if (this.done.size >= CACHE_MAX) this.done.clear();
      p = this.make(name).then(
        (c) => {
          this.done.set(name, c);
          this.pending.delete(name);
          return c;
        },
        (): null => {
          this.pending.delete(name); // a read error is not an answer: try again next time
          return null;
        },
      );
      this.pending.set(name, p);
    }
    return p;
  }

  /** Computes every name not known yet (the map route awaits this before answering). */
  async load(names: Iterable<string>): Promise<void> {
    await Promise.all([...names].map((n) => this.colour(n)));
  }

  private loadIndex(): Promise<Index> {
    this.index ??= (async (): Promise<Index> => {
      const [states, models] = await Promise.all([this.src.json('blocks_states.json'), this.src.json('blocks_models.json')]);
      return { states: states as Record<string, unknown>, models: new Map(Object.entries(models as Record<string, RawModel>)) };
    })().catch((e: unknown) => {
      this.index = undefined;
      throw e;
    });
    return this.index;
  }

  /**
   * The top face the map sees of a block: the first frame of its top texture (the model's up face, else
   * `<block>_top`, else `<block>`) with any opaque texel, and the tint the game multiplies in. null = no art.
   */
  private async face(name: string): Promise<{ r: Raster; tint: number | undefined } | null> {
    const idx = await this.loadIndex();
    const j = javaBlockName(name);
    const tint = mapTint(j);
    const modelName = firstStateModel(idx.states[j]) ?? (idx.models.has(j) ? j : undefined);
    const model = modelName === undefined ? undefined : resolveModel(idx.models, modelKey(modelName));
    const top = model ? topTexture(model) : undefined;
    const paths = [...(top ? [texturePath(top.ref)] : []), `blocks/${j}_top`, `blocks/${j}`];
    const tinted = top ? top.tinted || !top.face : true;
    for (const path of paths) {
      const bytes = await this.src.png(path);
      if (!bytes) continue;
      const r = firstFrame(decodePng(bytes));
      let opaque = false;
      for (let i = 3; i < r.data.length && !opaque; i += 4) opaque = r.data[i]! > 0;
      if (opaque) return { r, tint: tinted ? tint : undefined };
    }
    return null;
  }

  private async make(name: string): Promise<number | null> {
    const f = await this.face(name);
    return f ? (averageColour(f.r.data, f.tint) ?? null) : null;
  }

  /**
   * Decision 0062 (GET /tex/<block>.png): the block's top face as a 16 x 16 PNG, tinted like its map
   * colour (the same face as `colour`), undefined when there is no art. Kept in memory (TEX_MAX names);
   * nothing is written anywhere. A read error rejects (the route answers 500, not cached).
   */
  async texture(name: string): Promise<Buffer | undefined> {
    const hit = this.tex.get(name);
    if (hit !== undefined) return hit ?? undefined;
    const f = await this.face(name);
    let png: Buffer | null = null;
    if (f) {
      const r = f.r.w === 16 && f.r.h === 16 ? f.r : scaleNearest(f.r, 16);
      png = encodePng(f.tint !== undefined ? tinted(r, f.tint) : r);
    }
    if (this.tex.size >= TEX_MAX) this.tex.clear();
    this.tex.set(name, png);
    return png ?? undefined;
  }

  private readonly tex = new Map<string, Buffer | null>();
}

/** Textures the map keeps as PNG (16 x 16, a few hundred bytes each). */
const TEX_MAX = 2048;

/** A square raster scaled to n x n (nearest texel; high-resolution art). */
function scaleNearest(r: Raster, n: number): Raster {
  const out = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const sx = Math.floor((x * r.w) / n);
      const sy = Math.floor((y * r.h) / n);
      out.set(r.data.subarray((sy * r.w + sx) * 4, (sy * r.w + sx) * 4 + 4), (y * n + x) * 4);
    }
  }
  return { w: n, h: n, data: out };
}

let installed: BlockColours | null | undefined;

/** Block colours from the installed package (one per process), null when the package is not installed. */
export function installedBlockColours(): BlockColours | null {
  if (installed === undefined) {
    const dir = assetDir();
    installed = dir ? new BlockColours(new FsAssets(dir)) : null;
  }
  return installed;
}
