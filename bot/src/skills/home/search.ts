// Decision 0065 (docs/storage.md "Search"): "where are my diamonds" as the owner would type it. A query
// matches item names, their readable names (`iron ingot`, and the game's own display names from the item
// registry: `steak` is cooked_beef), plurals (`diamonds`, `torches`), common words through groups and a
// small alias table, and is ranked:
//
//   100  the exact item (`diamond`, `iron ingot`, `diamonds`)
//    90  an alias member, in the alias order (`iron` -> iron_ingot, raw_iron, iron_block, iron_nugget)
//    80  a group member (`ores`, `logs`, `food`, `tools`, `armour`, `shulker`, ...)
//    60  the name starts with the query (`diamond_` ...)
//    50  every word is a word of the name (`iron` -> iron_sword)
//    35  every word starts a word of the name (typing: `diam`)
//    20  the query is inside the name
//
// then by how many the bot has. Groups come from metadata where it exists (categories.ts, the survival
// tables, name patterns over the item registry: minecraft-data's Bedrock items) and from the alias table
// where it does not; a guard test checks that every group and alias is documented in docs/storage.md and
// resolves to real items. Pure apart from reading the item registry once.
import { createRequire } from 'node:module';
import { isShulkerBox, maxStackOf } from '../container/chest.ts';
import { armourSlotOf } from '../survival/armour.ts';
import { maxDurability } from '../survival/tools.ts';
import { categoryOf } from './categories.ts';
import type { ItemTotal, StorageIndex, StoragePlace } from './storage.ts';

const require = createRequire(import.meta.url);

/** The item registry version (the same Bedrock data as chest.ts maxStackOf). */
export const REGISTRY_VERSION = 'bedrock_1.26.51';

let registry: Map<string, string> | undefined;

/** Every item the registry knows: name -> display name (`cooked_beef` -> `Steak`); empty when minecraft-data is missing. */
export function itemRegistry(): ReadonlyMap<string, string> {
  if (!registry) {
    registry = new Map();
    try {
      const md = require('minecraft-data') as (v: string) => { itemsArray: { name: string; displayName: string }[] } | null;
      for (const i of md(REGISTRY_VERSION)?.itemsArray ?? []) registry.set(i.name, i.displayName);
    } catch {
      // no registry: names only
    }
  }
  return registry;
}

/** `iron_ingot` -> `iron ingot`. */
export const readableName = (name: string): string => name.replace(/^minecraft:/, '').replace(/_/g, ' ');

export interface SearchGroup {
  id: string;
  /** Words that name the group (lower case, singular and plural). */
  words: readonly string[];
  /** docs/storage.md says the same. */
  doc: string;
  /** Where the members come from. */
  source: 'categories' | 'survival tables' | 'name pattern' | 'shulker names';
  match(name: string): boolean;
}

const isArmour = (n: string): boolean => armourSlotOf(n) !== undefined;

/** The groups (docs/storage.md "Groups" is generated from this list). */
export const STORAGE_GROUPS: readonly SearchGroup[] = [
  { id: 'ores', words: ['ore', 'ores', 'mineral', 'minerals', 'metal', 'metals', 'gem', 'gems', 'ingot', 'ingots'], doc: 'ores, raw metals, ingots, gems, coal, redstone, lapis, quartz and their blocks (the unloader\'s `ores` category)', source: 'categories', match: (n) => categoryOf(n) === 'ores' },
  { id: 'wood', words: ['wood', 'woods', 'timber', 'lumber'], doc: 'logs, wood, planks, stems, hyphae, saplings, sticks (the `wood` category)', source: 'categories', match: (n) => categoryOf(n) === 'wood' },
  { id: 'logs', words: ['log', 'logs', 'stem', 'stems'], doc: 'every `_log` and `_stem`, stripped ones too', source: 'name pattern', match: (n) => n.endsWith('_log') || n.endsWith('_stem') },
  { id: 'planks', words: ['plank', 'planks', 'board', 'boards'], doc: 'every `_planks`', source: 'name pattern', match: (n) => n.endsWith('_planks') },
  { id: 'food', words: ['food', 'foods', 'meat', 'crop', 'crops'], doc: 'real food, crops, seeds, eggs (the `food` category: the eater\'s food table)', source: 'categories', match: (n) => categoryOf(n) === 'food' },
  { id: 'blocks', words: ['block', 'blocks', 'building'], doc: 'stone-like and building blocks (the `blocks` category)', source: 'categories', match: (n) => categoryOf(n) === 'blocks' },
  { id: 'tools', words: ['tool', 'tools', 'weapon', 'weapons', 'gear'], doc: 'anything with durability that is not armour (the survival kit\'s durability table)', source: 'survival tables', match: (n) => maxDurability(n) !== undefined && !isArmour(n) },
  { id: 'armour', words: ['armour', 'armor', 'armours', 'armors'], doc: 'helmets, chestplates, leggings, boots, the elytra (the armour table)', source: 'survival tables', match: isArmour },
  { id: 'shulker', words: ['shulker', 'shulkers', 'box', 'boxes'], doc: 'every shulker box colour', source: 'shulker names', match: (n) => isShulkerBox(n) },
  { id: 'junk', words: ['junk', 'trash', 'drops'], doc: 'what the stash step drops (the `junk` category)', source: 'categories', match: (n) => categoryOf(n) === 'junk' },
  { id: 'wool', words: ['wool', 'wools'], doc: 'every `_wool`', source: 'name pattern', match: (n) => n.endsWith('_wool') },
];

/**
 * Words with no metadata behind them: the word -> the items it means, most likely first (docs/storage.md
 * "Aliases" is generated from this table; every name must be a real item).
 */
export const STORAGE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  iron: ['iron_ingot', 'raw_iron', 'iron_block', 'iron_nugget', 'raw_iron_block'],
  gold: ['gold_ingot', 'raw_gold', 'gold_block', 'gold_nugget', 'raw_gold_block'],
  copper: ['copper_ingot', 'raw_copper', 'copper_block', 'raw_copper_block'],
  netherite: ['netherite_ingot', 'netherite_scrap', 'ancient_debris', 'netherite_block'],
  coal: ['coal', 'charcoal', 'coal_block'],
  lapis: ['lapis_lazuli', 'lapis_block'],
  redstone: ['redstone', 'redstone_block'],
  quartz: ['quartz', 'quartz_block'],
  stone: ['cobblestone', 'stone', 'cobbled_deepslate', 'deepslate', 'smooth_stone'],
  cobble: ['cobblestone', 'cobbled_deepslate'],
  seeds: ['wheat_seeds', 'beetroot_seeds', 'pumpkin_seeds', 'melon_seeds'],
  pearl: ['ender_pearl'],
  pearls: ['ender_pearl'],
  rocket: ['firework_rocket'],
  rockets: ['firework_rocket'],
  fireworks: ['firework_rocket'],
  steak: ['cooked_beef'],
};

const WORD_GROUP = new Map<string, SearchGroup>();
for (const g of STORAGE_GROUPS) for (const w of g.words) WORD_GROUP.set(w, g);

/** A word and its singular forms (`torches` -> torch, `berries` -> berry, `diamonds` -> diamond). */
export function singulars(word: string): string[] {
  const out = [word];
  if (word.endsWith('ies')) out.push(`${word.slice(0, -3)}y`);
  if (/(ch|sh|x|ss|s)es$/.test(word)) out.push(word.slice(0, -2));
  if (word.endsWith('s') && !word.endsWith('ss')) out.push(word.slice(0, -1));
  return [...new Set(out)];
}

export interface ParsedQuery {
  /** Lower case, `minecraft:` dropped, spaces as underscores: `iron_ingot`. */
  name: string;
  /** The words (`iron`, `ingot`). */
  words: string[];
  /** The name and its singulars, for exact matches and lookups. */
  forms: string[];
}

export function parseQuery(raw: string): ParsedQuery {
  const words = raw
    .toLowerCase()
    .replace(/^minecraft:/, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const name = words.join('_');
  const last = words.at(-1);
  const forms = new Set<string>([name]);
  if (last) for (const s of singulars(last)) forms.add([...words.slice(0, -1), s].join('_'));
  return { name, words, forms: [...forms].filter(Boolean) };
}

/** The group a query names (`ores`, `logs`, `shulkers`), if any. */
export function queryGroup(q: ParsedQuery): SearchGroup | undefined {
  for (const f of q.forms) {
    const g = WORD_GROUP.get(f);
    if (g) return g;
  }
  return undefined;
}

/** The alias list a query names, if any. */
export function queryAlias(q: ParsedQuery): readonly string[] | undefined {
  for (const f of q.forms) if (STORAGE_ALIASES[f]) return STORAGE_ALIASES[f];
  return undefined;
}

const tokensOf = (name: string): string[] => {
  const display = itemRegistry().get(name);
  const t = name.split('_');
  if (display) t.push(...display.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  return t;
};

/** How well an item name answers the query (0: not at all); see the file comment. */
export function scoreItem(name: string, q: ParsedQuery): number {
  if (!q.name) return 0;
  if (q.forms.includes(name)) return 100;
  const alias = queryAlias(q);
  const ai = alias ? alias.indexOf(name) : -1;
  if (ai >= 0) return 90 - Math.min(ai, 9) * 0.5;
  const g = queryGroup(q);
  if (g?.match(name)) return 80;
  if (name.startsWith(q.name)) return 60;
  const tokens = tokensOf(name);
  const words = q.words.map((w, i) => (i === q.words.length - 1 ? singulars(w) : [w]));
  if (words.every((forms) => forms.some((f) => tokens.includes(f)))) return 50;
  if (q.words.every((w) => tokens.some((t) => t.startsWith(w)))) return 35;
  if (name.includes(q.name)) return 20;
  return 0;
}

export interface StorageSearchItem {
  name: string;
  category: string;
  /** The item's stack size (the Bring picker's "a stack"). */
  stack: number;
  score: number;
  total: number;
  loose: number;
  boxed: number;
  carried: number;
  /** Where it is: the bot first, then the containers (at most `places`; `morePlaces` counts the rest). */
  where: StoragePlace[];
  morePlaces: number;
}

export interface StorageSearch {
  q: string;
  /** The group the query names, with its total over what is stored and carried. */
  group: { id: string; total: number; kinds: number } | null;
  results: StorageSearchItem[];
  /** Results left out beyond the limit. */
  more: number;
  /** The query named one item exactly and none is known: that item (the page says "no diamond in the 9 containers I know"). */
  none: string | null;
  /** Containers remembered (the reply's "in the 9 containers I know"). */
  containers: number;
}

/** Search the index (see the file comment): at most `limit` items, `places` places each. */
export function searchStorage(index: StorageIndex, raw: string, limit = 12, places = 8): StorageSearch {
  const q = parseQuery(raw);
  const g = queryGroup(q);
  const hits: { t: ItemTotal; score: number }[] = [];
  for (const t of index.items.values()) {
    if (t.total <= 0) continue;
    const score = scoreItem(t.name, q);
    if (score > 0) hits.push({ t, score });
  }
  hits.sort((a, b) => b.score - a.score || b.t.total - a.t.total || a.t.name.localeCompare(b.t.name));
  const members = g ? hits.filter((h) => g.match(h.t.name)) : [];
  const exact = q.forms.find((f) => itemRegistry().has(f));
  const none = q.name && !hits.some((h) => h.score >= 90) && exact && !g ? exact : null;
  return {
    q: raw,
    group: g ? { id: g.id, total: members.reduce((a, h) => a + h.t.total, 0), kinds: members.length } : null,
    results: hits.slice(0, limit).map(({ t, score }) => {
      const where = index.where(t.name);
      return { name: t.name, category: t.category, stack: maxStackOf(t.name), score, total: t.total, loose: t.loose, boxed: t.boxed, carried: t.carried, where: where.slice(0, places), morePlaces: Math.max(0, where.length - places) };
    }),
    more: Math.max(0, hits.length - limit),
    none,
    containers: index.freshness.known,
  };
}

/** Guard helper: the registry items a group matches. */
export function groupMembers(g: SearchGroup): string[] {
  return [...itemRegistry().keys()].filter((n) => g.match(n));
}

/** docs/storage.md "Groups" and "Aliases", generated (the guard test compares them with the doc). */
export function groupTable(): string {
  const rows = STORAGE_GROUPS.map((g) => `| \`${g.id}\` | ${g.words.map((w) => `\`${w}\``).join(' ')} | ${g.source} | ${g.doc} | ${groupMembers(g).length} |`);
  return ['| group | words | from | members | registry items |', '|---|---|---|---|---|', ...rows].join('\n');
}

export function aliasTable(): string {
  const rows = Object.entries(STORAGE_ALIASES).map(([w, names]) => `| \`${w}\` | ${names.map((n) => `\`${n}\``).join(', ')} |`);
  return ['| word | items, most likely first |', '|---|---|', ...rows].join('\n');
}
