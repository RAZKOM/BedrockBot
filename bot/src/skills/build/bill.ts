// The bill of materials (Track B2, docs/build.md "Bill of materials", ADR 0125): for each item a build places,
// what the bot has (the usable inventory, the carried shulker boxes, the chests at home as its chest memory
// knows them), what it can make and from what (the server's grid recipes through the craft chain, and the
// furnace recipes the smelter knows, down to raw materials `!get` gets), and what it cannot get. Pure: the counts,
// the recipe index and the rules in, the bill out; `!build materials` says it and `fetch` works through it
// (chat/commands-build.ts).
//
// The order the bill takes things in: an item the build places comes out of the inventory, then out of the
// carried boxes (the runner takes it out of a box itself, Track BJ), then out of the home chests (`!bring`).
// What is still short is made: the craft chain plans every short item at once on one pool (what is left in the
// inventory, in the carried boxes and in the home chests: Track B4, one shared pool), so two items that need the same
// planks are counted once; what the making uses comes out of the inventory first, then out of the carried boxes
// (`unbox`: fetch takes it out on the spot), then out of the home chests (`bring`). What the chain cannot craft is smelted when the furnace makes it (glass from sand, stone from
// cobblestone, smooth stone from stone, bricks from clay balls), its input taken from the pool or itself smelted,
// crafted or got; a raw material comes from the pool, else `!get`. Smelting needs a furnace (crafted from 8
// cobblestone and set down by `!furnace` when none stands where `!smelt` looks and none is carried) and fuel: a
// furnace item burns 8 smelts a coal or charcoal and 1.5 a plank or log; what the pool holds is burned in that
// order, and logs are got for the rest.
import { planChain, TAG_DEFAULT, type ChainOptions, type ChainStep } from '../craft/chain.ts';
import { TAGS, usablePool, type RecipeIndex } from '../craft/recipes.ts';
import { fuelRank, fuelValue } from '../food/finder.ts';
import { PLANNED_SMELTS, SMELTS } from '../food/smelt.ts';
import { lookup } from '../items/catalog.ts';
import { maxStackOf } from '../container/chest.ts';
import type { ItemStack } from '../../world/types.ts';

type Counts = ReadonlyMap<string, number>;
type Index = Pick<RecipeIndex, 'byOutput'> & Partial<Pick<RecipeIndex, 'outputs2'>>;

/** Smelt output -> its inputs (best first), from the smelter's table. */
export const SMELT_INPUTS: ReadonlyMap<string, readonly string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const [i, o] of Object.entries(SMELTS)) m.set(o, [...(m.get(o) ?? []), i]);
  return m;
})();

/** How `!get` gets a raw material: the command and how many of the item one counted unit gives. */
export interface GetHow {
  /** The `!get` item (`clay` for clay balls: a clay block drops 4). */
  item: string;
  per: number;
}

/** Raw materials `!get` gets under another name. */
const GET_ALIASES: Readonly<Record<string, GetHow>> = {
  clay_ball: { item: 'clay', per: 4 },
};

/** `!get` can get `item` (a gather, mine or hunt in the catalog; farming never ends by itself and is not used). */
export function getHow(item: string): GetHow | undefined {
  const a = GET_ALIASES[item];
  if (a) return a;
  const l = lookup(item);
  return l.strategy === 'gather' || l.strategy === 'mine' || l.strategy === 'hunt' ? { item, per: 1 } : undefined;
}

/** The items a block needs (a double slab is two slabs; Track B2). */
export function itemsOfBlock(item: string): { item: string; n: number } {
  const m = /^(?:(.+)_double_slab|double_(cut_copper)_slab|(.+)_double_(cut_copper)_slab)$/.exec(item);
  if (!m) return { item, n: 1 };
  const base = m[1] ?? m[2] ?? `${m[3]}_${m[4]}`;
  return { item: `${base}_slab`, n: 2 };
}

/** A plan's materials (item -> count) with double slabs as their slabs. */
export function billNeeds(materials: Readonly<Record<string, number>>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, v] of Object.entries(materials)) {
    const { item, n } = itemsOfBlock(k);
    out.set(item, (out.get(item) ?? 0) + v * n);
  }
  return out;
}

export interface BillItem {
  item: string;
  need: number;
  /** Taken from the usable inventory, the carried boxes, the home chests. */
  loose: number;
  boxed: number;
  home: number;
  /** Made: crafted or smelted (`how`), `from` its direct inputs (`12 oak_planks`). */
  make: number;
  how?: 'craft' | 'smelt';
  from?: string;
  /** Still short after everything: cannot get. */
  short: number;
}

export interface BillSmelt {
  input: string;
  output: string;
  n: number;
  /** Smelt chains: 0 for a smelt the build needs, 1 for its input's smelt (stone for smooth stone), ... */
  depth: number;
}

/** Fuel burned for the smelts; planks crafted `from` logs first when it says so. */
export interface BillFuel {
  item: string;
  n: number;
  from?: { item: string; n: number };
}

export interface Bill {
  items: BillItem[];
  /** Taken out of the home chests (`!bring <item> <n> home`): build items and materials. */
  bring: { item: string; n: number }[];
  /**
   * Track B4 (decision 0129): materials the making takes out of the carried boxes (logs for planks, sand for glass,
   * cobblestone for a furnace); the build's own blocks in the boxes are not here (the runner takes them out on site).
   */
  unbox: { item: string; n: number }[];
  /** The craft chain (ingredients first; the furnace left out: `!furnace` crafts it). */
  crafts: ChainStep[];
  /** Deepest first. */
  smelts: BillSmelt[];
  /** A furnace to craft and set down (none stands where `!smelt` looks and none is carried). */
  furnace: boolean;
  /** Burned for the smelts. */
  fuel: BillFuel[];
  /** Raw materials `!get` gets (`n` of `item`, `count` for the command). */
  get: { item: string; n: number; command: string; count: number }[];
  cannot: { item: string; n: number; why: string }[];
  /** Nothing to bring, make or get: the inventory and the boxes hold the build. */
  ok: boolean;
}

export interface BillInput {
  /** What the build places, by item (billNeeds). */
  need: ReadonlyMap<string, number>;
  /** The usable inventory (the throwaway reserve held back). */
  loose: Counts;
  /** In the carried shulker boxes (Track B4: everything they hold, the making's materials too). */
  boxed?: Counts;
  /** In the home chests (the chest memory). */
  home?: Counts;
  recipes?: Index;
  /** The crafter's plan options (kept items, the craft reserve, a table near). */
  chain?: ChainOptions;
  /** A furnace stands where `!smelt` looks, or one is carried. */
  furnaceNear?: boolean;
  /** How `!get` gets a raw material (default getHow). */
  get?: (item: string) => GetHow | undefined;
  /**
   * The throwaway reserve: the kinds and how many the inventory lacks of it now (`throwawayMin` less every throwaway block
   * carried). A throwaway kind brought from home brings that many more, or the reserve would keep what was brought.
   */
  reserve?: { kinds: readonly string[]; short: number };
}

const add = (m: Map<string, number>, k: string, n: number): void => {
  if (n) m.set(k, (m.get(k) ?? 0) + n);
};
const take = (m: Map<string, number>, k: string, n: number): number => {
  const h = m.get(k) ?? 0;
  const t = Math.max(0, Math.min(h, n));
  if (t) m.set(k, h - t);
  return t;
};

/** The pool as slots for the craft chain: one stack per item (the chain reads at most 36). */
function poolSlots(pool: Counts, relevant: (name: string) => boolean): ItemStack[] {
  const rows = [...pool.entries()].filter(([, n]) => n > 0);
  rows.sort((a, b) => Number(relevant(b[0])) - Number(relevant(a[0])) || b[1] - a[1]);
  return rows.slice(0, 36).map(([name, count]) => ({ name, count, networkId: 0, metadata: 0 }));
}

/** Every item a recipe, tag member or smelt input could bring into making `targets` (for the 36-slot pool). */
function closure(index: Index | undefined, targets: Iterable<string>, pool: Counts): Set<string> {
  const out = new Set<string>(['crafting_table', 'cobblestone', 'coal', 'charcoal']);
  const tags = new Set<string>();
  const todo = [...targets];
  const seen = new Set<string>();
  for (let i = 0; i < todo.length && seen.size < 400; i++) {
    const t = todo[i]!;
    if (seen.has(t)) continue;
    seen.add(t);
    out.add(t);
    for (const s of SMELT_INPUTS.get(t) ?? []) if (!out.has(s)) todo.push(s);
    for (const r of index?.byOutput(t) ?? []) {
      for (const ing of r.input) {
        if (!ing) continue;
        if (ing.name !== undefined && !out.has(ing.name)) todo.push(ing.name);
        if (ing.tag !== undefined) tags.add(ing.tag);
      }
    }
  }
  for (const tag of tags) {
    const pred = TAGS[tag];
    if (!pred) continue;
    for (const n of pool.keys()) if (pred(n)) out.add(n);
    const def = TAG_DEFAULT[tag];
    if (def) out.add(def);
  }
  for (const n of pool.keys()) if (/(_log|_wood|_planks)$/.test(n)) out.add(n); // fuel and planks
  return out;
}

/** The direct inputs of the first recipe of `item` (`12 oak_planks`), for the bill's "from". */
function directInputs(index: Index | undefined, item: string, n: number, pool: Counts): string | undefined {
  const r = index?.byOutput(item).slice().sort((a, b) => a.priority - b.priority)[0];
  const per = r?.output[0]?.count;
  if (!r || !per) return undefined;
  const crafts = Math.ceil(n / per);
  const by = new Map<string, number>();
  for (const ing of r.input) {
    if (!ing) continue;
    let name = ing.name;
    if (name === undefined && ing.tag !== undefined) {
      const pred = TAGS[ing.tag];
      name = [...pool.entries()].filter(([k, c]) => c > 0 && pred?.(k)).sort((a, b) => b[1] - a[1])[0]?.[0] ?? TAG_DEFAULT[ing.tag] ?? ing.tag;
    }
    if (name === undefined) continue;
    add(by, name, (r.shaped ? 1 : ing.count) * crafts);
  }
  return [...by.entries()].map(([k, v]) => `${v} ${k}`).join(', ');
}

const FUEL_LOG = 'oak_log';

/** The planks a log makes (`stripped_spruce_log` -> `spruce_planks`), or undefined. */
export function planksOf(log: string): string | undefined {
  const m = /^(?:stripped_)?(.+)_(log|wood)$/.exec(log);
  return m ? `${m[1]}_planks` : undefined;
}

/** The bill of materials (see the header). */
export function billOf(input: BillInput): Bill {
  const getOf = input.get ?? getHow;
  const pass = (withFurnace: boolean) => planBill(input, getOf, withFurnace);
  const first = pass(false);
  if (first.smeltCount > 0 && !input.furnaceNear) return pass(true).bill;
  return first.bill;
}

function planBill(input: BillInput, getOf: (item: string) => GetHow | undefined, withFurnace: boolean): { bill: Bill; smeltCount: number } {
  const loose = new Map(input.loose);
  const boxed = new Map(input.boxed ?? []);
  const home = new Map(input.home ?? []);
  const homeUse = new Map<string, number>();
  const items: BillItem[] = [];
  const short: { item: string; n: number }[] = [];
  const needs = [...input.need.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [item, need] of needs) {
    const l = take(loose, item, need);
    const b = take(boxed, item, need - l);
    const h = take(home, item, need - l - b);
    add(homeUse, item, h);
    items.push({ item, need, loose: l, boxed: b, home: h, make: 0, short: 0 });
    if (need - l - b - h > 0) short.push({ item, n: need - l - b - h });
  }
  // the pool the making draws on: what is left loose, in the carried boxes (Track B4) and at home
  const pool0 = new Map<string, number>();
  for (const [k, v] of loose) add(pool0, k, v);
  for (const [k, v] of boxed) add(pool0, k, v);
  for (const [k, v] of home) add(pool0, k, v);
  const targets = [...short];
  if (withFurnace) targets.push({ item: 'furnace', n: 1 });
  const smeltable = (i: string) => SMELT_INPUTS.has(i);
  const raw = (i: string) => getOf(i) !== undefined || smeltable(i);
  let crafts: ChainStep[] = [];
  let pool = new Map(pool0);
  const missing: { item: string; n: number }[] = [];
  const crafted = new Set<string>();
  if (targets.length && input.recipes) {
    const rel = closure(input.recipes, targets.map((t) => t.item), pool0);
    const slots = poolSlots(pool0, (n) => rel.has(n));
    // the chain counts a target already carried: none is (the build items were taken out above), but the furnace may be
    const plan = planChain(input.recipes, targets.map((t) => ({ item: t.item, n: t.n })), slots, { ...input.chain, raw });
    crafts = plan.steps.filter((s) => s.item !== 'furnace');
    for (const s of plan.steps) crafted.add(s.item);
    // the pool after the crafts: only what the chain was given can have been used (Track B4: an item it keeps, such as
    // a shulker box in a home chest, or one past its 36 slots, stays in the pool; before, it counted as used and the
    // fetch brought it home: `!bring orange_shulker_box 1 home`)
    if (plan.left) {
      const start = usablePool(slots, input.chain);
      const after = new Map(pool0);
      for (const k of new Set([...start.keys(), ...plan.left.keys()])) {
        const v = (pool0.get(k) ?? 0) - (start.get(k) ?? 0) + (plan.left.get(k) ?? 0);
        if (v > 0) after.set(k, v);
        else after.delete(k);
      }
      pool = after;
    }
    for (const m of plan.missing) missing.push(m);
    // a target the chain left wholly missing was not crafted
    for (const t of targets) if (plan.missing.some((m) => m.item === t.item && m.n >= t.n)) crafted.delete(t.item);
  } else {
    missing.push(...targets);
  }
  // what the chain could not craft: smelted, got, or nothing
  const smelts = new Map<string, BillSmelt>();
  const gets = new Map<string, number>();
  const cannot = new Map<string, { n: number; why: string }>();
  const resolve = (item: string, n: number, depth: number): void => {
    const t = take(pool, item, n);
    n -= t;
    if (n <= 0) return;
    const inputs = SMELT_INPUTS.get(item);
    if (inputs && depth < 4) {
      let rest = n;
      for (const i of inputs) {
        const got = take(pool, i, rest);
        if (got) addSmelt(i, item, got, depth);
        rest -= got;
      }
      if (rest <= 0) return;
      // an ingot `!get` plans itself (mine, then smelt)
      if (PLANNED_SMELTS[item] && item !== 'glass' && getOf(item)) {
        add(gets, item, rest);
        return;
      }
      const i = inputs[0]!;
      addSmelt(i, item, rest, depth);
      resolve(i, rest, depth + 1);
      return;
    }
    if (item.startsWith('minecraft:')) {
      // a tag the chain found no item for: its usual item
      const def = TAG_DEFAULT[item];
      if (def && getOf(def)) add(gets, def, n);
      else cannot.set(item, { n: (cannot.get(item)?.n ?? 0) + n, why: 'no item for this tag' });
      return;
    }
    if (getOf(item)) {
      add(gets, item, n);
      return;
    }
    cannot.set(item, { n: (cannot.get(item)?.n ?? 0) + n, why: input.recipes ? 'no recipe and !get does not know it' : 'no recipes yet' });
  };
  const addSmelt = (i: string, o: string, n: number, depth: number): void => {
    const k = `${i}>${o}`;
    const s = smelts.get(k);
    if (s) {
      s.n += n;
      s.depth = Math.max(s.depth, depth);
    } else smelts.set(k, { input: i, output: o, n, depth });
  };
  for (const m of missing) resolve(m.item, m.n, 0);
  // fuel: what the pool holds, best first (coal and the like, then planks), then logs crafted into planks (a log
  // burned as it is smelts 1.5 items, as four planks 6)
  const smeltCount = [...smelts.values()].reduce((a, s) => a + s.n, 0);
  const fuel: BillFuel[] = [];
  if (smeltCount > 0) {
    let units = 0;
    const isLog = (k: string) => /(_log|_wood)$/.test(k);
    const kinds = [...pool.entries()].filter(([k, c]) => c > 0 && fuelValue(k) > 0 && !isLog(k) && !input.chain?.keep?.(k)).sort((a, b) => fuelRank(a[0]) - fuelRank(b[0]) || b[1] - a[1]);
    for (const [k] of kinds) {
      if (units >= smeltCount) break;
      const v = fuelValue(k);
      const t = take(pool, k, Math.ceil((smeltCount - units) / v));
      if (t) fuel.push({ item: k, n: t });
      units += t * v;
    }
    if (units < smeltCount) {
      const left = smeltCount - units;
      const logKind = [...pool.entries()].filter(([k, c]) => c > 0 && k.endsWith('_log') && fuelValue(k) > 0 && !input.chain?.keep?.(k)).sort((a, b) => b[1] - a[1])[0]?.[0] ?? FUEL_LOG;
      const planks = planksOf(logKind);
      const asPlanks = planks !== undefined && (input.recipes?.byOutput(planks).length ?? 0) > 0;
      const per = asPlanks ? 4 * fuelValue(planks) : fuelValue(logKind);
      const logs = Math.ceil(left / per);
      const t = take(pool, logKind, logs);
      if (t < logs) add(gets, getOf(logKind) ? logKind : FUEL_LOG, logs - t);
      fuel.push(asPlanks ? { item: planks, n: logs * 4, from: { item: logKind, n: logs } } : { item: logKind, n: logs });
    }
  }
  // what the making used, out of the inventory first, then out of the carried boxes (Track B4), the rest out of the
  // home chests
  const boxUse = new Map<string, number>();
  for (const [k, v] of pool0) {
    const used = v - (pool.get(k) ?? 0);
    if (used <= 0) continue;
    let rest = Math.max(0, used - (loose.get(k) ?? 0));
    const fromBox = Math.min(rest, boxed.get(k) ?? 0);
    add(boxUse, k, fromBox);
    rest -= fromBox;
    add(homeUse, k, Math.min(rest, home.get(k) ?? 0));
  }
  // the build items' lines: made or short
  for (const it of items) {
    const s = it.need - it.loose - it.boxed - it.home;
    if (s <= 0) continue;
    const sm = [...smelts.values()].find((x) => x.output === it.item && x.depth === 0);
    const c = cannot.get(it.item);
    if (c) {
      it.short = Math.min(s, c.n);
      it.make = s - it.short;
    } else it.make = s;
    if (sm) {
      it.how = 'smelt';
      it.from = `${sm.n} ${sm.input}`;
    } else if (it.make > 0 && crafted.has(it.item)) {
      it.how = 'craft';
      const f = directInputs(input.recipes, it.item, it.make, pool0);
      if (f) it.from = f;
    } else if (it.make > 0 && gets.has(it.item)) {
      it.from = '!get';
    }
  }
  // the reserve: a throwaway kind brought or got brings or gets the reserve's shortfall too (the reserve would keep it)
  const r = input.reserve;
  if (r && r.short > 0) {
    let left = r.short;
    // Track B4: a throwaway kind taken out of a box (cobblestone for a furnace) takes the shortfall out too
    const unboxed = [...boxUse.entries()].filter(([k, n]) => n > 0 && r.kinds.includes(k)).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (unboxed) {
      const extra = Math.min(left, Math.max(0, (boxed.get(unboxed) ?? 0) - (boxUse.get(unboxed) ?? 0)));
      add(boxUse, unboxed, extra);
      left -= extra;
    }
    const brought = [...homeUse.entries()].filter(([k, n]) => n > 0 && r.kinds.includes(k)).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (brought) {
      const extra = Math.min(left, Math.max(0, (input.home?.get(brought) ?? 0) - (homeUse.get(brought) ?? 0)));
      add(homeUse, brought, extra);
      left -= extra;
    }
    const got = [...gets.keys()].find((k) => r.kinds.includes(k)) ?? (brought && getOf(brought) ? brought : undefined);
    if (left > 0 && got) add(gets, got, left);
  }
  const get = [...gets.entries()].map(([item, n]) => {
    const how = getOf(item) ?? { item, per: 1 };
    return { item, n, command: how.item, count: Math.ceil(n / how.per) };
  });
  const bring = [...homeUse.entries()].filter(([, n]) => n > 0).map(([item, n]) => ({ item, n }));
  const unbox = [...boxUse.entries()].filter(([, n]) => n > 0).map(([item, n]) => ({ item, n }));
  const bill: Bill = {
    items,
    bring,
    unbox,
    crafts,
    smelts: [...smelts.values()].sort((a, b) => b.depth - a.depth),
    furnace: withFurnace,
    fuel,
    get,
    cannot: [...cannot.entries()].map(([item, c]) => ({ item, ...c })),
    ok: false,
  };
  bill.ok = bring.length === 0 && unbox.length === 0 && crafts.length === 0 && smelts.size === 0 && get.length === 0 && cannot.size === 0 && items.every((i) => i.loose + i.boxed >= i.need);
  return { bill, smeltCount };
}

// ---- the bill as chat lines -----------------------------------------------------------------------------

const stockText = (it: BillItem): string => {
  const parts: string[] = [];
  if (it.loose) parts.push(`${it.loose} carried`);
  if (it.boxed) parts.push(`${it.boxed} in my boxes`);
  if (it.home) parts.push(`${it.home} at home`);
  return parts.length ? parts.join(', ') : 'none';
};

/** One entry a build item: `oak_stairs 8: have none; craft 8 from 12 oak_planks`. */
export function billItemText(it: BillItem): string {
  const parts = [`have ${stockText(it)}`];
  if (it.make > 0) parts.push(it.how === 'smelt' ? `smelt ${it.make} from ${it.from ?? '?'}` : it.how === 'craft' ? `craft ${it.make}${it.from ? ` from ${it.from}` : ''}` : `get ${it.make} with !get`);
  if (it.short > 0) parts.push(`cannot get ${it.short}`);
  return `${it.item} ${it.need}: ${parts.join('; ')}`;
}

/** The bill's steps in the order `fetch` takes them (`from home: 15 oak_log, 4 sand`, `smelt 4 sand -> glass`). */
export function billSteps(b: Bill): string[] {
  const steps: string[] = [];
  if (b.unbox.length) steps.push(`from my boxes: ${b.unbox.map((x) => `${x.n} ${x.item}`).join(', ')}`); // Track B4
  if (b.bring.length) steps.push(`from home: ${b.bring.map((x) => `${x.n} ${x.item}`).join(', ')}`);
  if (b.get.length) steps.push(`!get ${b.get.map((x) => `${x.item === x.command ? '' : `${x.command} for `}${x.n} ${x.item}`).join(', ')}`);
  const madeFirst = b.crafts.filter((c) => !b.items.some((i) => i.item === c.item));
  if (madeFirst.length) steps.push(`craft first ${madeFirst.map((c) => `${c.n} ${c.item}`).join(', ')}`);
  if (b.furnace) steps.push('a furnace (8 cobblestone)');
  if (b.smelts.length) steps.push(`smelt ${b.smelts.map((s) => `${s.n} ${s.input} -> ${s.output}`).join(', ')}`);
  if (b.fuel.length) steps.push(`fuel ${b.fuel.map((f) => `${f.n} ${f.item}${f.from ? ` (from ${f.from.n} ${f.from.item})` : ''}`).join(', ')}`);
  if (b.cannot.length) steps.push(`cannot get ${b.cannot.map((c) => `${c.n} ${c.item} (${c.why})`).join(', ')}`);
  return steps;
}

/** A chat line of the bill at most (the chat cuts a reply at 256 characters: Chat's maxReplyLength). */
export const BILL_LINE_MAX = 250;

/** Steps as words for packLines: each split at its commas, `;` after every step but the last. */
export function stepWords(steps: readonly string[]): string[] {
  return steps.flatMap((s, k) => {
    const parts = s.split(', ');
    return parts.map((p, i) => (i < parts.length - 1 ? `${p},` : k < steps.length - 1 ? `${p};` : p));
  });
}

/** The bill's chat lines (after the materials line), each within `max` bytes; empty when the bill is ok. */
export function billLines(label: string, b: Bill, max = BILL_LINE_MAX): string[] {
  if (b.ok) return [];
  const entries = b.items.map(billItemText);
  const steps = billSteps(b);
  return packLines([`bill for ${label}:`, ...entries.map((e, i) => (i < entries.length - 1 ? `${e} |` : e))], max).concat(steps.length ? packLines(['bill:', ...stepWords(steps)], max) : []);
}

/** Words into lines of at most `max` bytes, joined by spaces (a word longer than that is cut). */
export function packLines(words: readonly string[], max = BILL_LINE_MAX): string[] {
  const out: string[] = [];
  let cur = '';
  const size = (s: string) => Buffer.byteLength(s, 'utf8');
  for (const w0 of words) {
    const w = size(w0) > max ? w0.slice(0, max - 3) + '...' : w0;
    if (!cur) cur = w;
    else if (size(`${cur} ${w}`) <= max) cur = `${cur} ${w}`;
    else {
      out.push(cur);
      cur = w;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ---- fetch: the next command ----------------------------------------------------------------------------

/** What the fetch's next command depends on besides the bill: the inventory and the crafter. */
export interface FetchNow {
  slots: readonly (ItemStack | null | undefined)[];
  recipes?: Index;
  chain?: ChainOptions;
  /**
   * Track B4 (decision 0129): what the carried boxes hold now and how many free slots they have. With them the fetch
   * takes the making's materials out of the boxes a chunk at a time (what the inventory holds with what is made of it)
   * and puts what it made into the boxes when the inventory fills up; without them it works from the inventory alone.
   */
  boxed?: ReadonlyMap<string, number>;
  boxRoom?: number;
  /** An item's stack size (default maxStackOf). */
  stack?: (item: string) => number;
  /** Kinds never put into a box by `stow` (the throwaway reserve's blocks). */
  never?: readonly string[];
}

/**
 * Track B4: `unbox`: take these out of the carried boxes (on a cell off the build); `stow`: put the loose items of these
 * kinds beyond the count given into the carried boxes (what a round made and the inventory cannot hold).
 */
export type FetchStep = { kind: 'run'; command: string } | { kind: 'unbox'; want: Record<string, number> } | { kind: 'stow'; keep: Record<string, number> } | { kind: 'done' } | { kind: 'stuck'; why: string };

/** Track B4: inventory slots a fetch step leaves free (a craft's table, the box's own slot and its pickup, a drop). */
export const FETCH_FREE_MIN = 3;
/** Track B4: below this many free slots the fetch puts what it finished into the carried boxes first. */
export const STOW_FREE = 8;

const carriedOf = (slots: readonly (ItemStack | null | undefined)[], name: string): number => {
  let n = 0;
  for (let i = 0; i < Math.min(slots.length, 36); i++) if (slots[i]?.name === name) n += slots[i]!.count;
  return n;
};

/** Free inventory slots (0..35). */
export function freeSlotsOf(slots: readonly (ItemStack | null | undefined)[]): number {
  let n = 0;
  for (let i = 0; i < 36; i++) if (!slots[i] || slots[i]!.count <= 0) n++;
  return n;
}

const stackOf = (now: FetchNow, item: string): number => Math.max(1, now.stack?.(item) ?? maxStackOf(item));

/** `!craft item n` would craft now from what is carried (the craft chain finds nothing missing). */
export function canCraftNow(now: FetchNow, item: string, n: number): boolean {
  if (!now.recipes || now.recipes.byOutput(item).length === 0) return false;
  const p = planChain(now.recipes, [{ item, n: carriedOf(now.slots, item) + n }], now.slots, now.chain ?? {});
  return p.missing.length === 0;
}

/**
 * Track B4: `n` of `item` crafted from what is carried and what the carried boxes hold: the chain for them, what of
 * its raw materials the boxes give (`unbox`), and the slots it may take at most (the materials taken out and every
 * craft's output, counted as if nothing were used up). Undefined when the chain misses something the boxes lack.
 */
function chunkOf(now: FetchNow, item: string, n: number): { unbox: Record<string, number>; slots: number } | undefined {
  if (!now.recipes || now.recipes.byOutput(item).length === 0) return undefined;
  const p = planChain(now.recipes, [{ item, n: carriedOf(now.slots, item) + n }], now.slots, now.chain ?? {});
  const unbox: Record<string, number> = {};
  let slots = 0;
  for (const m of p.missing) {
    if ((now.boxed?.get(m.item) ?? 0) < m.n) return undefined;
    unbox[m.item] = m.n;
    slots += Math.ceil(m.n / stackOf(now, m.item));
  }
  for (const s of p.steps) slots += Math.ceil(s.n / stackOf(now, s.item));
  return { unbox, slots };
}

/**
 * Track B4: the most of `item` (at most `n`) whose chunk fits in `room` slots (chunkOf), with its unbox; undefined when
 * not one fits or the chain misses what the boxes lack. Without box counts (`now.boxed`): `n` when it can be crafted now.
 */
function fitCraft(now: FetchNow, item: string, n: number, room: number): { n: number; unbox: Record<string, number> } | undefined {
  if (!now.boxed) return canCraftNow(now, item, n) ? { n, unbox: {} } : undefined;
  const full = chunkOf(now, item, n);
  if (!full) return undefined;
  if (full.slots <= room) return { n, unbox: full.unbox };
  // the largest chunk that fits (fewer is never more slots)
  let lo = 0;
  let hi = n;
  let best: { n: number; unbox: Record<string, number> } | undefined;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const c = chunkOf(now, item, mid);
    if (c && c.slots <= room) {
      best = { n: mid, unbox: c.unbox };
      lo = mid;
    } else hi = mid - 1;
  }
  return best;
}

/** Track B4: `want` in at most `room` slots, in the order given (a partial last item). */
function capToSlots(now: FetchNow, want: readonly { item: string; n: number }[], room: number): Record<string, number> {
  const out: Record<string, number> = {};
  let left = room;
  for (const w of want) {
    if (left <= 0) break;
    const st = stackOf(now, w.item);
    const n = Math.min(w.n, left * st);
    if (n <= 0) continue;
    out[w.item] = (out[w.item] ?? 0) + n;
    left -= Math.ceil(n / st);
  }
  return out;
}

/**
 * The fetch's next command for a bill made just now (docs/build.md "Fetch"): what cannot be got stops it; then each
 * take from the home chests (`bring <item> <n> home`), each raw material (`get`), a craft of a build item that can be
 * crafted from what is carried (an item another one is made from last: planks after the stairs that use them), the
 * fuel's planks, the furnace, a smelt whose input is carried (the deepest first); done when the bill is ok.
 * Track B4 (with `now.boxed`): a craft is cut to what the inventory holds and its materials are taken out of the boxes
 * first (`unbox`); so are the furnace's cobblestone, the fuel and the smelts' inputs; below STOW_FREE free slots the
 * build items the fetch has finished go into the boxes (`stow`) before anything else.
 */
export function nextFetchStep(b: Bill, now: FetchNow): FetchStep {
  if (b.cannot.length) return { kind: 'stuck', why: `cannot get ${b.cannot.map((c) => `${c.n} ${c.item} (${c.why})`).join(', ')}` };
  const crafts = b.items.filter((i) => i.how === 'craft' && i.make > 0);
  const inputs = new Set(crafts.flatMap((i) => (i.from ?? '').split(', ').map((s) => s.replace(/^\d+ /, ''))));
  const boxes = now.boxed !== undefined;
  const free = freeSlotsOf(now.slots);
  const room = Math.max(0, free - FETCH_FREE_MIN);
  // Track B4: the inventory filling up: what is finished goes into the boxes (no build item the making still uses)
  if (boxes && free < STOW_FREE && (now.boxRoom ?? 0) > 0) {
    const used = new Set<string>([...inputs, ...b.unbox.map((u) => u.item), ...b.smelts.map((s) => s.input), ...b.fuel.flatMap((f) => [f.item, ...(f.from ? [f.from.item] : [])])]);
    if (b.furnace) used.add('cobblestone');
    for (const k of now.never ?? []) used.add(k);
    const keep: Record<string, number> = {};
    for (const i of b.items) if (!used.has(i.item) && i.make === 0 && carriedOf(now.slots, i.item) > 0) keep[i.item] = 0;
    if (Object.keys(keep).length) return { kind: 'stow', keep };
  }
  // `!bring <item> <n>` brings what makes n in all (what is carried loose counts first): the carried ones and the home part
  const bring = b.bring[0];
  if (bring) return { kind: 'run', command: `bring ${bring.item} ${carriedOf(now.slots, bring.item) + bring.n} home` };
  const get = b.get[0];
  if (get) return { kind: 'run', command: `get ${get.command} ${get.count}` };
  const order = [...crafts].sort((x, y) => Number(inputs.has(x.item)) - Number(inputs.has(y.item)));
  const unboxOr = (c: { n: number; unbox: Record<string, number> }, command: string): FetchStep => (Object.keys(c.unbox).length ? { kind: 'unbox', want: c.unbox } : { kind: 'run', command });
  for (const i of order) {
    const c = fitCraft(now, i.item, i.make, room);
    if (c) return unboxOr(c, `craft ${i.item} ${c.n}`);
  }
  for (const f of b.fuel) {
    if (!f.from) continue;
    const c = fitCraft(now, f.item, f.n, room);
    if (c) return unboxOr(c, `craft ${f.item} ${c.n}`);
  }
  const fromBoxes = (item: string, n: number): FetchStep | undefined => {
    const has = Math.min(n, now.boxed?.get(item) ?? 0);
    const want = capToSlots(now, [{ item, n: has }], room);
    return want[item] ? { kind: 'unbox', want } : undefined;
  };
  if (b.furnace) {
    // Track B4: `!furnace` crafts it from carried cobblestone (the reserve's share comes out with it: the bill's unbox)
    const cob = b.unbox.find((u) => u.item === 'cobblestone');
    if (boxes && cob && carriedOf(now.slots, 'cobblestone') < 8) {
      const s = fromBoxes('cobblestone', cob.n);
      if (s) return s;
    }
    return { kind: 'run', command: 'furnace' };
  }
  // Track B4: the fuel the smelts burn, carried before they start
  if (boxes && b.smelts.length) {
    for (const f of b.fuel) {
      if (f.from) continue;
      const short = f.n - carriedOf(now.slots, f.item);
      const s = short > 0 ? fromBoxes(f.item, short) : undefined;
      if (s) return s;
    }
  }
  for (const s of b.smelts) {
    const have = carriedOf(now.slots, s.input);
    if (have > 0) return { kind: 'run', command: `smelt ${s.input} ${Math.min(s.n, have, 64)}` };
    const u = boxes ? fromBoxes(s.input, Math.min(s.n, 64)) : undefined;
    if (u) return u;
  }
  // Track B4: what else the making takes out of the boxes
  if (boxes && b.unbox.length) {
    const want = capToSlots(now, b.unbox.filter((u) => (now.boxed?.get(u.item) ?? 0) > 0).map((u) => ({ item: u.item, n: Math.min(u.n, now.boxed?.get(u.item) ?? 0) })), room);
    if (Object.keys(want).length) return { kind: 'unbox', want };
  }
  if (b.ok) return { kind: 'done' };
  const left = billSteps(b);
  const waiting = order.map((i) => `${i.make} ${i.item}`);
  const full = boxes && room <= 0 ? '; my inventory is full' : '';
  return { kind: 'stuck', why: `nothing to do from what I carry${waiting.length ? ` (cannot craft ${waiting.join(', ')} yet)` : ''}${full}${left.length ? `; left: ${left.join('; ')}` : ''}` };
}
