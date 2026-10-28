// Item icons of the panel (decision 0046): Java block models, as the minecraft-assets package has
// them (blocks_models.json: `parent`, `textures`, `elements`, `display`). A model is resolved the way
// the game does it: the child's textures win over its parents', the first model up the chain with
// `elements` supplies the boxes, the first with `display.gui` the inventory transform.

export type FaceName = 'down' | 'up' | 'north' | 'south' | 'west' | 'east';
export type Vec = [number, number, number];

export interface ModelFace {
  texture: string;
  uv?: [number, number, number, number];
  rotation?: number;
  tintindex?: number;
}

export interface ModelElement {
  from: Vec;
  to: Vec;
  /** Rotated boxes (crossed planes, torches) are drawn as flat sprites instead. */
  rotation?: unknown;
  faces: Partial<Record<FaceName, ModelFace>>;
}

export interface GuiTransform {
  rotation: Vec;
  translation: Vec;
  scale: Vec;
}

export interface RawModel {
  parent?: string;
  textures?: Record<string, string | { sprite?: string } | null>;
  elements?: ModelElement[];
  display?: { gui?: Partial<GuiTransform> };
}

export interface ResolvedModel {
  /** The model's own name, then its parents' (`oak_stairs`, `stairs`, `block`). */
  chain: string[];
  elements: ModelElement[];
  /** Texture variable -> texture reference with every `#alias` followed (a missing one is left out). */
  textures: Record<string, string>;
  gui: GuiTransform | undefined;
}

const CHAIN_MAX = 12;

/** `minecraft:block/cube` and `block/cube` and `cube` are one key in blocks_models.json. */
export const modelKey = (s: string): string => s.replace(/^minecraft:/, '').replace(/^block\//, '');

const textureOf = (v: string | { sprite?: string } | null | undefined): string | undefined => (typeof v === 'string' ? v : (v?.sprite ?? undefined));

export function resolveModel(models: ReadonlyMap<string, RawModel>, name: string): ResolvedModel | undefined {
  const chain: string[] = [];
  const raws: RawModel[] = [];
  for (let k: string | undefined = modelKey(name); k !== undefined && chain.length < CHAIN_MAX; ) {
    const m = models.get(k);
    if (!m) break;
    chain.push(k);
    raws.push(m);
    k = m.parent === undefined ? undefined : modelKey(m.parent);
  }
  if (raws.length === 0) return undefined;
  const vars: Record<string, string> = {};
  for (const m of [...raws].reverse()) for (const [k, v] of Object.entries(m.textures ?? {})) {
    const t = textureOf(v);
    if (t !== undefined) vars[k] = t;
  }
  const textures: Record<string, string> = {};
  for (const k of Object.keys(vars)) {
    let t: string | undefined = vars[k];
    for (let i = 0; i < CHAIN_MAX && t?.startsWith('#') === true; i++) t = vars[t.slice(1)];
    if (t !== undefined && !t.startsWith('#')) textures[k] = t;
  }
  const gui = raws.find((m) => m.display?.gui)?.display?.gui;
  return {
    chain,
    elements: raws.find((m) => m.elements)?.elements ?? [],
    textures,
    gui: gui ? { rotation: gui.rotation ?? [0, 0, 0], translation: gui.translation ?? [0, 0, 0], scale: gui.scale ?? [1, 1, 1] } : undefined,
  };
}

/** The texture a face names (`#side`) or points at directly (`block/dirt`), undefined when unresolved. */
export function faceTexture(m: ResolvedModel, ref: string): string | undefined {
  return ref.startsWith('#') ? m.textures[ref.slice(1)] : ref;
}
