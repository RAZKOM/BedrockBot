// Craft chains (Track E1, docs/early-game.md "Craft chains"): what a player crafts first to craft an item from
// what is carried. `!craft wooden_pickaxe` with logs only needs planks (from the logs), sticks (from the planks)
// and a crafting table (from the planks) first; the crafter itself only crafts a table on its own (docs/crafting.md
// "The crafter"). Pure: the recipe index and the inventory in, an ordered list of crafts out, plus the raw
// materials the chain cannot craft (logs, cobblestone, wool, ...), which `!get` goes and gets (skills/items/obtain.ts).
//
// The search: the targets one after another on one simulated pool (the usable inventory: kept items such as tools
// are never ingredients, the reserve is held back). An item short in the pool is crafted when a grid recipe makes it:
// each recipe is tried on a copy of the pool (lower priority number first, then the one with the least missing raw
// material, then the one using the preferred plain materials: oak planks, cobblestone, white wool), recursing into its
// ingredients up to MAX_DEPTH, never through an item already on the path (no cycles: an iron block from ingots from an
// iron block). A tag ingredient (`#planks`) tries the matching items the pool holds first, then the preferred one.
// A recipe that needs a table and no table stands near or is carried makes the table its first ingredient (it is not
// consumed: the crafter places it and picks it up again).
import type { ItemStack } from '../../world/types.ts';
import { needsTable, TAGS, usablePool, type PlanOptions, type Recipe, type RecipeIndex } from './recipes.ts';

/** Recursion depth: log -> planks -> sticks -> pickaxe is 3; a bed (planks, wool) is 2. */
export const MAX_DEPTH = 5;
/** Tag members tried per tag ingredient. */
const MAX_TAG_TRIES = 6;
/** Plain materials a tie goes to (the one a fresh world has most of). */
export const PREFERRED: readonly string[] = ['oak_planks', 'oak_log', 'cobblestone', 'white_wool', 'coal', 'stick'];
/** The item a tag ingredient stands for when nothing carried matches it. */
export const TAG_DEFAULT: Readonly<Record<string, string>> = {
  'minecraft:planks': 'oak_planks',
  'minecraft:logs': 'oak_log',
  'minecraft:logs_that_burn': 'oak_log',
  'minecraft:coals': 'coal',
  'minecraft:stone_crafting_materials': 'cobblestone',
  'minecraft:stone_tool_materials': 'cobblestone',
  'minecraft:wool': 'white_wool',
  'minecraft:sand': 'sand',
  'minecraft:wooden_slabs': 'oak_slab',
};

export interface ChainStep {
  /** The item crafted (`!craft <item> <n>`). */
  item: string;
  /** Items made by this step (crafts x output count). */
  n: number;
  /** The recipe needs a crafting table. */
  table: boolean;
}

export interface ChainLeaf {
  /** A raw material no grid recipe makes from what is carried (`oak_log`, `cobblestone`, `white_wool`). */
  item: string;
  n: number;
}

export interface ChainPlan {
  /** Crafts in order (ingredients before what they make), targets last. */
  steps: ChainStep[];
  /** Raw materials still missing (empty: every target can be crafted now). */
  missing: ChainLeaf[];
  /** Track E2: the usable pool the crafts leave (the fuel the smelts may burn). */
  left?: Map<string, number>;
}

export interface ChainOptions extends PlanOptions {
  /** A crafting table stands where the crafter uses or walks to one (no table needs crafting). */
  tableNear?: boolean;
  maxDepth?: number;
  /**
   * Raw materials the caller can get (`!get` gathers logs, mines stone, hunts sheep). A recipe whose missing materials are
   * not all raw is not taken: the item itself is then what is missing (an iron ingot, not the iron block it unpacks from).
   * Default: every material counts.
   */
  raw?: (item: string) => boolean;
}

type Index = Pick<RecipeIndex, 'byOutput'> & Partial<Pick<RecipeIndex, 'outputs2'>>;

interface State {
  pool: Map<string, number>;
  steps: ChainStep[];
  missing: Map<string, number>;
  table: boolean;
}

const clone = (s: State): State => ({ pool: new Map(s.pool), steps: s.steps.map((x) => ({ ...x })), missing: new Map(s.missing), table: s.table });
const missingTotal = (s: State): number => [...s.missing.values()].reduce((a, b) => a + b, 0);
const prefScore = (names: readonly string[]): number => names.reduce((a, n) => a + (PREFERRED.includes(n) ? 1 : 0), 0);
/** Materials missing in `t` that were not missing in `s` and that the caller cannot get. */
const badMissing = (t: State, s: State, o: ChainOptions): number => {
  if (!o.raw) return 0;
  let n = 0;
  for (const [k, v] of t.missing) if (v > (s.missing.get(k) ?? 0) && !o.raw(k)) n++;
  return n;
};
const less = (a: readonly number[], b: readonly number[]): boolean => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
};

/** The concrete items a tag can stand for, best first: carried ones (most first), the default, then the rest known. */
function tagCandidates(tag: string, s: State, index: Index): string[] {
  const pred = TAGS[tag];
  if (!pred) return [];
  const carried = [...s.pool.entries()].filter(([n, c]) => c > 0 && pred(n)).sort((a, b) => b[1] - a[1]).map(([n]) => n);
  const out = [...carried];
  const def = TAG_DEFAULT[tag];
  if (def && !out.includes(def)) out.push(def);
  for (const n of index.outputs2?.() ?? []) if (pred(n) && !out.includes(n)) out.push(n);
  return out.slice(0, MAX_TAG_TRIES);
}

/** The items a recipe's cells consume per craft: [ingredient name or tag, count]. */
function cellsOf(r: Recipe): { name?: string; tag?: string; per: number }[] {
  const by = new Map<string, { name?: string; tag?: string; per: number }>();
  for (const ing of r.input) {
    if (!ing) continue;
    const key = ing.name !== undefined ? `n:${ing.name}` : `t:${ing.tag}`;
    const per = r.shaped ? 1 : ing.count;
    const e = by.get(key);
    if (e) e.per += per;
    else by.set(key, { ...(ing.name !== undefined ? { name: ing.name } : { tag: ing.tag! }), per });
  }
  return [...by.values()];
}

function addStep(s: State, step: ChainStep): void {
  const same = s.steps.find((x) => x.item === step.item);
  if (same) same.n += step.n;
  else s.steps.push(step);
}

/** Take `count` of `item` from the pool, crafting what is short. Records what cannot be had in `s.missing`. */
function need(index: Index, s: State, item: string, count: number, depth: number, path: ReadonlySet<string>, o: ChainOptions): void {
  const have = s.pool.get(item) ?? 0;
  const take = Math.min(have, count);
  if (take > 0) s.pool.set(item, have - take);
  const short = count - take;
  if (short <= 0) return;
  const recipes = depth >= (o.maxDepth ?? MAX_DEPTH) || path.has(item) ? [] : index.byOutput(item).filter((r) => (o.recipe?.(r) ?? true) && !r.input.some((i) => i && (i.name === item || (i.name !== undefined && path.has(i.name)))));
  let best: State | undefined;
  let bestKey: [number, number, number, number] | undefined;
  const next = new Set(path).add(item);
  for (const r of recipes) {
    const out = r.output[0];
    if (!out || out.count <= 0) continue;
    const t = clone(s);
    const crafts = Math.ceil(short / out.count);
    const used: string[] = [];
    if (needsTable(r) && !t.table) {
      need(index, t, 'crafting_table', 1, depth + 1, next, o);
      t.pool.set('crafting_table', (t.pool.get('crafting_table') ?? 0) + 1); // not consumed: placed and picked up again
      t.table = true;
    }
    for (const c of cellsOf(r)) {
      const want = c.per * crafts;
      if (c.name !== undefined) {
        used.push(c.name);
        need(index, t, c.name, want, depth + 1, next, o);
        continue;
      }
      // a tag: the first candidate that resolves with nothing missing, else the first one tried
      let chosen: State | undefined;
      let chosenName: string | undefined;
      let chosenBad = Infinity;
      for (const cand of tagCandidates(c.tag!, t, index)) {
        if (next.has(cand)) continue;
        const tt = clone(t);
        need(index, tt, cand, want, depth + 1, next, o);
        const bad = badMissing(tt, t, o);
        if (bad < chosenBad) {
          chosen = tt;
          chosenName = cand;
          chosenBad = bad;
        }
        if (missingTotal(tt) === missingTotal(t)) {
          chosen = tt;
          chosenName = cand;
          break;
        }
      }
      if (!chosen) {
        t.missing.set(c.tag!, (t.missing.get(c.tag!) ?? 0) + want);
        continue;
      }
      Object.assign(t, chosen);
      used.push(chosenName!);
    }
    addStep(t, { item, n: crafts * out.count, table: needsTable(r) });
    t.pool.set(item, (t.pool.get(item) ?? 0) + crafts * out.count - short);
    const key: [number, number, number, number] = [badMissing(t, s, o), missingTotal(t), r.priority, -prefScore(used)];
    if (!bestKey || less(key, bestKey)) {
      best = t;
      bestKey = key;
    }
    if (key[0] === 0 && key[1] === missingTotal(s) && key[2] <= 0) break; // a clean plain recipe: good enough
  }
  if (best && bestKey?.[0] === 0) {
    Object.assign(s, best);
    return;
  }
  s.missing.set(item, (s.missing.get(item) ?? 0) + short);
}

/** Carried count of an item (every slot, kept items too). */
export function carried(slots: readonly (ItemStack | null | undefined)[], name: string): number {
  let n = 0;
  for (let i = 0; i < Math.min(slots.length, 36); i++) {
    const s = slots[i];
    if (s?.name === name) n += s.count;
  }
  return n;
}

/**
 * The crafts that make `targets` (`n` of each in all: what is carried counts) from the inventory, and the raw
 * materials missing. A target already carried in full adds nothing; carried targets are never ingredients.
 */
export function planChain(index: Index, targets: readonly { item: string; n: number }[], slots: readonly (ItemStack | null | undefined)[], o: ChainOptions = {}): ChainPlan {
  const s: State = { pool: usablePool(slots, o), steps: [], missing: new Map(), table: o.tableNear === true || carried(slots, 'crafting_table') > 0 };
  for (const t of targets) {
    const short = t.n - carried(slots, t.item);
    if (short <= 0) continue;
    // the carried targets stay targets (a tool is not in the pool anyway)
    s.pool.set(t.item, 0);
    need(index, s, t.item, short, 0, new Set(), o);
  }
  return { steps: s.steps, missing: [...s.missing.entries()].map(([item, n]) => ({ item, n })), left: s.pool };
}

/** `8 oak_planks, 4 stick, 1 crafting_table` */
export function chainText(steps: readonly ChainStep[]): string {
  return steps.map((s) => `${s.n} ${s.item}`).join(', ');
}
