// Track AW (wave 11, docs/crafting.md "Recipes"): the recipe index built from the server's
// `crafting_data` packet (sent once at join, 1219 shaped + 2068 shapeless recipes on BDS 1.26.60.6),
// and the pure planning behind `!craft`: which recipe makes an item, what it consumes, whether it
// needs a crafting table (a 3 x 3 grid) or fits the 2 x 2 grid of the inventory screen.
//
// What the packet carries (measured): shaped recipes have `width`/`height` and one RecipeIngredient
// per cell (row-major, `type: 'invalid'` for an empty cell); shapeless ones a list. An ingredient is
// a `name` descriptor (`minecraft:iron_ingot`, metadata 32767 = any; some carry the aux value in the
// name: `minecraft:coal:0`) or an `item_tag` (`minecraft:planks`, `minecraft:coals`). Every table and
// inventory-grid recipe has `block: 'crafting_table'` (the grid size decides, not the block); furnace,
// smoker, campfire, stonecutter and `deprecated` recipes share the packet and are skipped here.
// `network_id` is what `item_stack_request craft_recipe` names (1..4770 here, distinct per recipe).
import type { ItemStack } from '../../world/types.ts';

/** One ingredient cell: a concrete item or a tag; `count` per craft (1 for grid recipes). */
export interface Ingredient {
  name?: string;
  tag?: string;
  /** 32767 (or undefined) = any aux value. */
  metadata: number;
  count: number;
}

export interface RecipeOutput {
  name: string;
  count: number;
  networkId: number;
  metadata: number;
  blockRuntimeId: number;
}

export interface Recipe {
  id: string;
  networkId: number;
  shaped: boolean;
  /** Shaped: the grid the pattern uses; shapeless: 0. */
  width: number;
  height: number;
  /** Shaped: width x height cells, row-major, null = empty; shapeless: the list. */
  input: (Ingredient | null)[];
  output: RecipeOutput[];
  block: string;
  priority: number;
}

/** `crafting_data` as bedrock-protocol decodes it (only what is read here). */
interface WireIngredient {
  type: 'invalid' | 'valid' | number;
  descriptor_type?: string;
  name?: string;
  tag?: string;
  metadata?: number;
  count?: number;
}
interface WireItem {
  network_id: number;
  count: number;
  metadata: number;
  block_runtime_id: number;
}
interface WireShaped {
  recipe_id: string;
  width: number;
  height: number;
  input: WireIngredient[];
  output: WireItem[];
  block: string;
  priority: number;
  network_id: number;
}
interface WireShapeless {
  recipe_id: string;
  input: WireIngredient[];
  output: WireItem[];
  block: string;
  priority: number;
  network_id: number;
}
export interface CraftingDataPacket {
  shaped_recipes?: WireShaped[];
  shapeless_recipes?: WireShapeless[];
  clear_recipes?: boolean;
}

/** The 2 x 2 grid of the inventory screen (`crafting_input` slots 28..31) and the 3 x 3 of a workbench (32..40). */
export const GRID_2X2 = { base: 28, width: 2 } as const;
export const GRID_3X3 = { base: 32, width: 3 } as const;
/** The crafted result waits in this container / slot of the request. */
export const OUTPUT_CONTAINER = 'creative_output';
export const OUTPUT_SLOT = 50;
/** Blocks whose recipes the index keeps (the grid size decides between the inventory and a table). */
const GRID_BLOCKS = new Set(['crafting_table']);

export const bareName = (n: string): string => (n.startsWith('minecraft:') ? n.slice(10) : n);

/** `minecraft:coal:0` -> { name: 'coal', metadata: 0 }; `minecraft:iron_ingot` -> { name: 'iron_ingot' }. */
export function parseItemName(raw: string): { name: string; metadata?: number } {
  const n = bareName(raw);
  const m = /^(.+):(\d+)$/.exec(n);
  if (m) return { name: m[1]!, metadata: Number(m[2]) };
  return { name: n };
}

function ingredientOf(w: WireIngredient): Ingredient | null {
  if (w.type === 'invalid' || w.type === 0) return null;
  const count = w.count ?? 1;
  if (w.descriptor_type === 'item_tag' && w.tag) return { tag: w.tag, metadata: w.metadata ?? 32767, count };
  if (w.descriptor_type === 'name' && w.name) {
    const p = parseItemName(w.name);
    return { name: p.name, metadata: p.metadata ?? w.metadata ?? 32767, count };
  }
  return null;
}

/** Item tags a grid recipe may name, resolved against item names (the ones the bot's recipes use). */
const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'bamboo', 'crimson', 'warped'];
export const TAGS: Readonly<Record<string, (name: string) => boolean>> = {
  'minecraft:planks': (n) => n === 'planks' || n.endsWith('_planks'),
  'minecraft:logs': (n) => /(_log|_wood|_stem|_hyphae)$/.test(n),
  'minecraft:logs_that_burn': (n) => /(_log|_wood)$/.test(n) && !n.startsWith('crimson') && !n.startsWith('warped'),
  'minecraft:coals': (n) => n === 'coal' || n === 'charcoal',
  'minecraft:wooden_slabs': (n) => n.endsWith('_slab') && WOODS.some((w) => n.startsWith(w)),
  'minecraft:stone_crafting_materials': (n) => n === 'cobblestone' || n === 'cobbled_deepslate' || n === 'blackstone',
  'minecraft:stone_tool_materials': (n) => n === 'cobblestone' || n === 'cobbled_deepslate' || n === 'blackstone',
  'minecraft:wool': (n) => n === 'wool' || n.endsWith('_wool'),
  'minecraft:soul_fire_base_blocks': (n) => n === 'soul_sand' || n === 'soul_soil',
  'minecraft:sand': (n) => n === 'sand' || n === 'red_sand',
  'minecraft:egg': (n) => n === 'egg' || n.endsWith('_egg'),
  'minecraft:metal_nuggets': (n) => n === 'iron_nugget' || n === 'gold_nugget',
  'minecraft:mushrooms_for_stew': (n) => n === 'brown_mushroom' || n === 'red_mushroom',
};

/** Does item `name` satisfy ingredient `ing`? */
export function matches(ing: Ingredient, name: string): boolean {
  const n = bareName(name);
  if (ing.name !== undefined) return ing.name === n;
  if (ing.tag !== undefined) return TAGS[ing.tag]?.(n) ?? false;
  return false;
}

/** True when the recipe does not fit the inventory's 2 x 2 grid. */
export function needsTable(r: Recipe): boolean {
  if (r.shaped) return r.width > 2 || r.height > 2;
  return r.input.reduce((a, i) => a + (i ? i.count : 0), 0) > 4;
}

/** The `crafting_input` slot of each input cell (shaped: the pattern at the grid's top-left; shapeless: in order). */
export function gridSlots(r: Recipe, table: boolean): number[] {
  const g = table ? GRID_3X3 : GRID_2X2;
  const out: number[] = [];
  if (r.shaped) {
    for (let row = 0; row < r.height; row++) for (let col = 0; col < r.width; col++) out.push(g.base + row * g.width + col);
  } else {
    let i = 0;
    for (const ing of r.input) for (let k = 0; k < (ing?.count ?? 1); k++) out.push(g.base + i++);
  }
  return out;
}

/**
 * The index: `crafting_data` in, recipes by output name out. Furnace / brewing / smithing recipes are
 * not kept (docs/food.md owns the furnace).
 */
export class RecipeIndex {
  private readonly byOut = new Map<string, Recipe[]>();
  private readonly itemName: (networkId: number) => string | undefined;
  private readonly off: (() => void) | undefined;
  /** Recipes kept / recipes in the last packet. */
  readonly stats = { kept: 0, seen: 0, packets: 0 };

  constructor(itemName: (networkId: number) => string | undefined, source?: { on(name: string, fn: (p: Record<string, unknown>) => void): () => void }) {
    this.itemName = itemName;
    this.off = source?.on('crafting_data', (p) => {
      this.handle(p);
    });
  }

  dispose(): void {
    this.off?.();
  }

  get size(): number {
    return this.stats.kept;
  }

  handle(p: CraftingDataPacket): void {
    this.stats.packets++;
    if (p.clear_recipes) {
      this.byOut.clear();
      this.stats.kept = 0;
    }
    this.stats.seen = 0;
    for (const r of p.shaped_recipes ?? []) {
      this.stats.seen++;
      if (!GRID_BLOCKS.has(r.block)) continue;
      const input = r.input.map(ingredientOf);
      this.add({ id: r.recipe_id, networkId: r.network_id, shaped: true, width: r.width, height: r.height, input, output: this.outputs(r.output), block: r.block, priority: r.priority });
    }
    for (const r of p.shapeless_recipes ?? []) {
      this.stats.seen++;
      if (!GRID_BLOCKS.has(r.block)) continue;
      const input = r.input.map(ingredientOf).filter((i): i is Ingredient => i !== null);
      this.add({ id: r.recipe_id, networkId: r.network_id, shaped: false, width: 0, height: 0, input, output: this.outputs(r.output), block: r.block, priority: r.priority });
    }
  }

  private outputs(items: WireItem[]): RecipeOutput[] {
    return items.map((o) => ({ name: this.itemName(o.network_id) ?? `unknown:${o.network_id}`, count: o.count, networkId: o.network_id, metadata: o.metadata, blockRuntimeId: o.block_runtime_id }));
  }

  private add(r: Recipe): void {
    if (r.output.length === 0 || r.input.every((i) => i === null)) return;
    const name = r.output[0]!.name;
    const list = this.byOut.get(name) ?? [];
    if (list.some((x) => x.networkId === r.networkId)) return;
    list.push(r);
    this.byOut.set(name, list);
    this.stats.kept++;
  }

  /** Grid recipes that make `name` (with or without the namespace). */
  byOutput(name: string): Recipe[] {
    return this.byOut.get(bareName(name)) ?? [];
  }

  /** Every output name known (for `!craft` suggestions). */
  outputs2(): string[] {
    return [...this.byOut.keys()];
  }
}

// ---- planning --------------------------------------------------------------------------------------

export interface PlanOptions {
  /** Items never consumed (tools, armour, food, the flight kit, shulker boxes: `keepOnDropItems`). */
  keep?: (name: string) => boolean;
  /** Keep at least this many of an item (`craftReserve`). */
  reserve?: (name: string) => number;
  /** Max stack per grid cell / output. Default 64. */
  maxStack?: (name: string) => number;
}

export interface CraftCell {
  /** Index into the recipe's input (and into gridSlots). */
  cell: number;
  /** The concrete item chosen for the cell (a tag resolved against the inventory). */
  item: string;
}

export interface CraftPlan {
  recipe: Recipe;
  /** The item wanted (the recipe's first output). */
  item: string;
  /** Items per craft. */
  outputPer: number;
  /** Crafts wanted for `n` items. */
  wantedCrafts: number;
  /** Crafts the inventory allows now (0 = missing ingredients), capped at wantedCrafts. */
  crafts: number;
  /** Crafts per request: the output must fit one stack and each cell one stack. */
  batchMax: number;
  cells: CraftCell[];
  /** Items consumed per craft, by name. */
  perCraft: Record<string, number>;
  table: boolean;
  /** The ingredient that limits the count (when crafts < wantedCrafts). */
  shortfall?: { name: string; have: number; need: number };
}

/** Usable counts by item name: everything carried minus the kept items and the reserve. */
export function usablePool(slots: readonly (ItemStack | null | undefined)[], opts: PlanOptions = {}): Map<string, number> {
  const pool = new Map<string, number>();
  for (let i = 0; i < Math.min(slots.length, 36); i++) {
    const s = slots[i];
    if (!s || s.count <= 0 || opts.keep?.(s.name)) continue;
    pool.set(s.name, (pool.get(s.name) ?? 0) + s.count);
  }
  for (const [k, v] of pool) {
    const left = v - (opts.reserve?.(k) ?? 0);
    if (left > 0) pool.set(k, left);
    else pool.delete(k);
  }
  return pool;
}

/** The plan for one recipe against the pool; undefined when a tag has no item or an ingredient is unknown. */
export function planRecipe(r: Recipe, n: number, pool: ReadonlyMap<string, number>, opts: PlanOptions = {}): CraftPlan | undefined {
  const out = r.output[0];
  if (!out) return undefined;
  const maxStack = opts.maxStack ?? (() => 64);
  const outputPer = out.count;
  const wantedCrafts = Math.max(1, Math.ceil(n / outputPer));
  // assign a concrete item to every cell (tags: the most plentiful match not yet exhausted)
  const cells: CraftCell[] = [];
  const perCraft: Record<string, number> = {};
  let shortfall: CraftPlan['shortfall'];
  const expanded: { cell: number; ing: Ingredient }[] = [];
  r.input.forEach((ing, cell) => {
    if (!ing) return;
    for (let k = 0; k < (r.shaped ? 1 : ing.count); k++) expanded.push({ cell, ing });
  });
  for (const { cell, ing } of expanded) {
    let item: string | undefined;
    if (ing.name !== undefined) item = ing.name;
    else if (ing.tag !== undefined) {
      const tag = TAGS[ing.tag];
      if (!tag) return undefined;
      let best: string | undefined;
      let bestLeft = -Infinity;
      for (const [name, have] of pool) {
        if (!tag(name)) continue;
        const left = have - (perCraft[name] ?? 0);
        if (left > bestLeft) {
          best = name;
          bestLeft = left;
        }
      }
      item = best ?? (ing.tag === 'minecraft:planks' ? 'oak_planks' : ing.tag.replace('minecraft:', ''));
      if (!best && !shortfall) shortfall = { name: item, have: 0, need: wantedCrafts };
    }
    if (item === undefined) return undefined;
    cells.push({ cell, item });
    perCraft[item] = (perCraft[item] ?? 0) + 1;
  }
  let crafts = wantedCrafts;
  for (const [name, per] of Object.entries(perCraft)) {
    const have = pool.get(name) ?? 0;
    const possible = Math.floor(have / per);
    if (possible < crafts) {
      crafts = possible;
      shortfall = { name, have, need: wantedCrafts * per };
    }
  }
  let batchMax = Math.max(1, Math.floor(maxStack(out.name) / outputPer));
  for (const c of cells) batchMax = Math.min(batchMax, maxStack(c.item));
  batchMax = Math.min(batchMax, 64);
  const plan: CraftPlan = { recipe: r, item: out.name, outputPer, wantedCrafts, crafts, batchMax, cells, perCraft, table: needsTable(r) };
  if (crafts < wantedCrafts && shortfall) plan.shortfall = shortfall;
  return plan;
}

/**
 * The best plan for `n` of `item` from the inventory: the recipe with the most crafts possible now
 * (ties: the one fitting the inventory grid, then the lower priority number, then fewer inputs);
 * undefined when no grid recipe makes the item.
 */
export function planCraft(index: Pick<RecipeIndex, 'byOutput'>, item: string, n: number, slots: readonly (ItemStack | null | undefined)[], opts: PlanOptions = {}): CraftPlan | undefined {
  const pool = usablePool(slots, opts);
  const plans = index
    .byOutput(item)
    .map((r) => planRecipe(r, n, pool, opts))
    .filter((p): p is CraftPlan => p !== undefined);
  plans.sort((a, b) => b.crafts - a.crafts || Number(a.table) - Number(b.table) || a.recipe.priority - b.recipe.priority || a.cells.length - b.cells.length);
  return plans[0];
}

/** `canCraft(item, n, inventory)`: what the plan says in one object (docs/crafting.md). */
export function canCraft(index: Pick<RecipeIndex, 'byOutput'>, item: string, n: number, slots: readonly (ItemStack | null | undefined)[], opts: PlanOptions = {}): { ok: boolean; plan?: CraftPlan; table: boolean; reason?: 'no_recipe' | 'missing'; shortfall?: CraftPlan['shortfall'] } {
  const plan = planCraft(index, item, n, slots, opts);
  if (!plan) return { ok: false, table: false, reason: 'no_recipe' };
  if (plan.crafts <= 0) return { ok: false, plan, table: plan.table, reason: 'missing', ...(plan.shortfall ? { shortfall: plan.shortfall } : {}) };
  return { ok: true, plan, table: plan.table, ...(plan.shortfall ? { shortfall: plan.shortfall } : {}) };
}

/** `36 iron_ingot` / `2 oak_planks, 1 stick` (the perCraft map times `crafts`). */
export function usedText(perCraft: Readonly<Record<string, number>>, crafts: number): string {
  return Object.entries(perCraft)
    .map(([k, v]) => `${v * crafts} ${k}`)
    .join(', ');
}
