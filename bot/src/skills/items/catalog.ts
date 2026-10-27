// Item catalog for `!get <item> [n]` (wave 8, Track AD; docs/get.md "Catalog"): what the owner asks
// for -> how the bot gets it. One front door instead of choosing between !gather, !mine, !food and
// !farm. Pure data and parsing (no bot state), so the unit tests cover it completely.
//
//   gather   trees: the gather-wood process (`!gather n`; any log kind counts)
//   mine     an ore (by its drop, ore or raw name) or a plain block: the mine process (`!mine <block> n`),
//            which digs for it (plain blocks: the nearest one, tunnelling under the mining rules)
//   hunt     food mobs: the food process (`!food n`); string: spiders (`!kill spider n`)
//   farm     a crop: the farm process (`!farm`) for one round of the field around the bot, or until n
//            of that crop were harvested
//   unknown  everything else: the reply lists the categories
export type Strategy = 'gather' | 'mine' | 'hunt' | 'farm' | 'unknown';

export interface CatalogEntry {
  strategy: Exclude<Strategy, 'unknown'>;
  /** The item the owner gets (reply: `getting 16 oak_log`). */
  item: string;
  /** mine: the block to dig; farm: the crop block; hunt: the mob for `!kill` (else `!food`). */
  target?: string;
  /** What the reply says the bot does (`gathering wood`, `mining coal_ore`). */
  doing: string;
  /** Extra note for the reply (flint comes from gravel, any log counts). */
  note?: string;
}

export type Lookup = (CatalogEntry & { count: number; command: string; name: string }) | { strategy: 'unknown'; name: string };

/** Default counts per strategy (farm: 0 = one round of the field). */
export const DEFAULT_COUNTS: Record<CatalogEntry['strategy'], number> = { gather: 16, mine: 8, hunt: 6, farm: 0 };
/** Upper bounds: the commands' own (`!gather` 2304, `!mine` 256, `!food` 64, `!kill` 64). */
export const MAX_COUNTS: Record<CatalogEntry['strategy'], number> = { gather: 2304, mine: 256, hunt: 64, farm: 2304 };

const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak'];

const ORES: Record<string, { item: string; ore: string }> = {
  coal: { item: 'coal', ore: 'coal_ore' },
  iron: { item: 'raw_iron', ore: 'iron_ore' },
  gold: { item: 'raw_gold', ore: 'gold_ore' },
  copper: { item: 'raw_copper', ore: 'copper_ore' },
  diamond: { item: 'diamond', ore: 'diamond_ore' },
  redstone: { item: 'redstone', ore: 'redstone_ore' },
  lapis: { item: 'lapis_lazuli', ore: 'lapis_ore' },
  emerald: { item: 'emerald', ore: 'emerald_ore' },
  quartz: { item: 'quartz', ore: 'quartz_ore' },
};

/** Plain blocks: what is dug -> what drops. */
const BLOCKS: Record<string, { item: string; block: string; note?: string }> = {
  stone: { item: 'cobblestone', block: 'stone' },
  cobblestone: { item: 'cobblestone', block: 'stone' },
  cobble: { item: 'cobblestone', block: 'stone' },
  dirt: { item: 'dirt', block: 'dirt' },
  sand: { item: 'sand', block: 'sand' },
  red_sand: { item: 'red_sand', block: 'red_sand' },
  gravel: { item: 'gravel', block: 'gravel' },
  flint: { item: 'flint', block: 'gravel', note: 'flint drops from about 1 in 10 gravel: counting gravel dug' },
  clay: { item: 'clay_ball', block: 'clay' },
  deepslate: { item: 'cobbled_deepslate', block: 'deepslate' },
  cobbled_deepslate: { item: 'cobbled_deepslate', block: 'deepslate' },
  andesite: { item: 'andesite', block: 'andesite' },
  diorite: { item: 'diorite', block: 'diorite' },
  granite: { item: 'granite', block: 'granite' },
  tuff: { item: 'tuff', block: 'tuff' },
  calcite: { item: 'calcite', block: 'calcite' },
  netherrack: { item: 'netherrack', block: 'netherrack' },
  obsidian: { item: 'obsidian', block: 'obsidian' },
};

const CROPS: Record<string, { item: string; crop: string }> = {
  wheat: { item: 'wheat', crop: 'wheat' },
  seeds: { item: 'wheat_seeds', crop: 'wheat' },
  wheat_seeds: { item: 'wheat_seeds', crop: 'wheat' },
  carrot: { item: 'carrot', crop: 'carrots' },
  carrots: { item: 'carrot', crop: 'carrots' },
  potato: { item: 'potato', crop: 'potatoes' },
  potatoes: { item: 'potato', crop: 'potatoes' },
  beetroot: { item: 'beetroot', crop: 'beetroot' },
  beetroots: { item: 'beetroot', crop: 'beetroot' },
  beetroot_seeds: { item: 'beetroot_seeds', crop: 'beetroot' },
};

/** Words for "food from animals" and the item each one names. */
const FOOD: Record<string, string> = {
  food: 'food',
  meat: 'food',
  beef: 'beef',
  steak: 'beef',
  pork: 'porkchop',
  porkchop: 'porkchop',
  mutton: 'mutton',
  chicken: 'chicken',
  rabbit: 'rabbit',
};

/** `minecraft:Oak_Logs` -> `oak_logs`; plural `-s` / `-es` handled by the lookup. */
export function normaliseName(input: string): string {
  return input.trim().toLowerCase().replace(/^minecraft:/, '').replace(/[\s-]+/g, '_');
}

/** Singular candidates of a word: itself, without `s`, without `es`. */
function forms(n: string): string[] {
  const out = [n];
  if (n.endsWith('es')) out.push(n.slice(0, -2));
  if (n.endsWith('s')) out.push(n.slice(0, -1));
  return out;
}

/** The catalog entry for an item name, or undefined. */
export function entryFor(input: string): CatalogEntry | undefined {
  const raw = normaliseName(input);
  for (const n of forms(raw)) {
    // wood
    if (n === 'wood' || n === 'log' || n === 'tree' || n === 'timber') return { strategy: 'gather', item: 'logs', doing: 'gathering wood', note: 'any log kind counts' };
    const w = WOODS.find((k) => n === k || n === `${k}_log` || n === `${k}_wood` || n === `stripped_${k}_log`);
    if (w) return { strategy: 'gather', item: `${w}_log`, doing: 'gathering wood', ...(w === 'oak' ? {} : { note: 'any log kind counts' }) };
    // Track AQ: every ore kind in one trip (`!get ores 32`: n blocks in all, no quota per kind)
    if (n === 'ores' || n === 'ore' || n === 'all_ores' || n === 'every_ore') return { strategy: 'mine', item: 'ores', target: 'ores', doing: 'mining every ore kind in one trip', note: 'n blocks of any ore' };
    // ores: coal, coal_ore, deepslate_coal_ore, raw_iron, iron_ingot, diamonds ...
    const base = n.replace(/^deepslate_/, '').replace(/^raw_/, '').replace(/_ore$/, '').replace(/_ingot$/, '').replace(/_lazuli$/, '').replace(/^nether_/, '');
    const ore = ORES[base] ?? (base === 'redstone_dust' ? ORES.redstone : undefined);
    if (ore && (n === base || n.endsWith('_ore') || n.startsWith('raw_') || n.endsWith('_ingot') || n.endsWith('_lazuli') || n === 'redstone_dust')) {
      return { strategy: 'mine', item: ore.item, target: ore.ore, doing: `mining ${ore.ore}` };
    }
    const b = BLOCKS[n];
    if (b) return { strategy: 'mine', item: b.item, target: b.block, doing: `mining ${b.block}`, ...(b.note ? { note: b.note } : {}) };
    const c = CROPS[n];
    if (c) return { strategy: 'farm', item: c.item, target: c.crop, doing: `farming ${c.crop}` };
    const f = FOOD[n];
    if (f) return { strategy: 'hunt', item: f, doing: 'hunting food mobs', ...(f === 'food' ? {} : { note: 'any food mob counts' }) };
    if (n === 'string' || n === 'cobweb') return { strategy: 'hunt', item: 'string', target: 'spider', doing: 'hunting spiders', note: 'counting spiders killed' };
  }
  return undefined;
}

/** The chat command (without `!`) that runs the strategy. */
export function commandFor(e: CatalogEntry, count: number): string {
  switch (e.strategy) {
    case 'gather':
      return `gather ${count}`;
    case 'mine':
      return `mine ${e.target!} ${count}`;
    case 'hunt':
      return e.target ? `kill ${e.target} ${count}` : `food ${count}`;
    case 'farm':
      return 'farm';
  }
}

/** `!get` arguments (`oak_log 20`, `20 oak_log`, `iron ore 4`) -> the item words and the count (undefined: default). */
export function parseGetArgs(args: readonly string[]): { name: string; count: number | undefined } | { error: string } {
  const words = [...args];
  let count: number | undefined;
  const isNum = (s: string | undefined) => s !== undefined && /^\d+$/.test(s);
  if (isNum(words[words.length - 1])) count = Number(words.pop());
  else if (isNum(words[0])) count = Number(words.shift());
  if (words.length === 0) return { error: 'no item' };
  if (words.some((w) => /^\d+$/.test(w))) return { error: 'one count only' };
  if (count !== undefined && count < 1) return { error: 'count must be 1 or more' };
  return { name: words.join('_'), count };
}

/**
 * Track AQ: several mined items with a count each (`iron 8 coal 16`, `8 iron 16 coal`): one `!mine` with
 * every kind and its quota, one trip. undefined when the words are not that form (one item: the plain
 * lookup); an error when they are but an item is unknown or not mined.
 */
export function lookupMulti(args: readonly string[]): { items: Extract<Lookup, { command: string }>[]; command: string } | { error: string } | undefined {
  const isNum = (s: string | undefined) => s !== undefined && /^\d+$/.test(s);
  const nums = args.filter((w) => isNum(w)).length;
  if (nums < 2) return undefined;
  const words = args.filter((w) => w.toLowerCase() !== 'and' && w !== ',' && w !== '&');
  // count after the name (`iron 8 coal 16`) or before it (`8 iron 16 coal`)
  const after = isNum(words[words.length - 1]);
  const pairs: { name: string; count: number }[] = [];
  let name: string[] = [];
  let count: number | undefined;
  for (const w of words) {
    if (isNum(w)) {
      if (after) {
        if (name.length === 0) return { error: 'a count without an item' };
        pairs.push({ name: name.join('_'), count: Number(w) });
        name = [];
      } else {
        if (count !== undefined) {
          if (name.length === 0) return { error: 'a count without an item' };
          pairs.push({ name: name.join('_'), count });
          name = [];
        }
        count = Number(w);
      }
    } else name.push(w.replace(/,$/, ''));
  }
  if (!after && count !== undefined && name.length > 0) pairs.push({ name: name.join('_'), count });
  else if (name.length > 0) return { error: `no count for ${name.join(' ')}` };
  const items: Extract<Lookup, { command: string }>[] = [];
  for (const p of pairs) {
    if (p.count < 1) return { error: 'count must be 1 or more' };
    const f = lookup(p.name, p.count);
    if (f.strategy === 'unknown') return { error: `I do not know how to get ${f.name}` };
    if (f.strategy !== 'mine') return { error: `several items in one !get are ores and mined blocks only (${f.name} is ${f.doing})` };
    if (items.some((x) => x.target === f.target)) return { error: `${f.name} named twice` };
    items.push(f);
  }
  if (items.length < 2) return undefined;
  return { items, command: `mine ${items.map((f) => `${f.target!} ${f.count}`).join(' ')}` };
}

/** Look an item up with a count (default per strategy, bounded by the command's own maximum). */
export function lookup(name: string, count?: number): Lookup {
  const e = entryFor(name);
  const n = normaliseName(name);
  if (!e) return { strategy: 'unknown', name: n };
  const c = Math.min(count ?? DEFAULT_COUNTS[e.strategy], MAX_COUNTS[e.strategy]);
  return { ...e, count: c, command: commandFor(e, c), name: n };
}

/** The categories for the unknown reply. */
export function categories(): string {
  return 'wood, ores (coal, iron, gold, copper, diamond, redstone, lapis, emerald; `ores` = every kind, several with a count each in one trip), stone, dirt, sand, gravel, flint, clay, food (beef, pork, mutton, chicken), string, crops (wheat, carrots, potatoes, beetroot)';
}

export function unknownReply(name: string): string {
  return `get: I do not know how to get ${name}; I can get: ${categories()}`;
}

/** The item a mined block drops (`coal_ore` / `deepslate_coal_ore` -> coal, `stone` -> cobblestone); the block itself otherwise. */
export function minedItem(block: string): string {
  const b = normaliseName(block).replace(/^lit_/, '');
  const base = b.replace(/^deepslate_/, '').replace(/_ore$/, '');
  const ore = ORES[base];
  if (b.endsWith('_ore') && ore) return ore.item;
  if (b === 'deepslate') return 'cobbled_deepslate';
  return BLOCKS[b]?.item ?? b;
}
