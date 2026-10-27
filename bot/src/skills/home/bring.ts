// Track AS (wave 10, docs/home.md "Bring", decision 0040): `!bring <item> [n] [to <player>|home]` takes
// stored items out of the chests at home (by the chest memory) and carries them to the owner. `!get`
// makes new things and ends at home; `!bring` moves things that are already stored. This file is the
// pure part: what the owner's word means, how much is where, and which chests to visit.
//
//   resolve   the word -> the item names that count: the names the chest memory (or the inventory)
//             knows that match it (`torches` -> torch, `shulker` -> any shulker box), then the `!get`
//             catalog's (`iron` -> iron_ingot, raw_iron; `wood` -> any log)
//   plan      what the bot carries counts first; then loose stacks, nearest chest first, by the
//             memory's counts; only when the loose stacks are not enough, full shulker boxes holding
//             the item (the whole box is taken: the box is then the only source, the reply says so)
//
// The logistics (logistics.ts `withdraw`) plans again before every chest trip with the memory as
// that trip left it, so a chest that held less than remembered only sends the bot on to the next one.
import type { ChestRecord } from '../../world/cache/chests.ts';
import type { Vec3 } from '../../world/types.ts';
import { isShulkerBox, maxStackOf } from '../container/chest.ts';
import { entryFor, normaliseName } from '../items/catalog.ts';
import { chestKey, itemMatches, itemQuery, partnerKeys } from './memory.ts';

/** What `!bring` looks for. */
export interface BringItem {
  /** The owner's word, normalised (`torch`, `iron`, `shulker_box`). */
  word: string;
  /** Item names that count, the preferred first (loose stacks of the first name are taken first). */
  names: string[];
  /** Any shulker box counts (`!bring shulker`): empty boxes are taken before full ones. */
  boxes: boolean;
}

/** Whether an item name counts for the request. */
export function bringMatches(item: BringItem, name: string): boolean {
  const n = name.replace(/^minecraft:/, '');
  return item.boxes ? isShulkerBox(n) : item.names.includes(n);
}

/** Sum of the counts that match. */
export function countOf(item: BringItem, counts: Readonly<Record<string, number>> | undefined): number {
  let n = 0;
  for (const [k, v] of Object.entries(counts ?? {})) if (bringMatches(item, k)) n += v;
  return n;
}

/**
 * The owner's word -> the item names that count. `known`: item names the chest memory and the
 * inventory hold (exact names win over the catalog's: `!bring torches` is torch, `!bring shulker` any box).
 */
export function resolveBringItem(raw: string, known: Iterable<string> = []): BringItem {
  const word = itemQuery(normaliseName(raw));
  if (word === 'shulker_box') return { word, names: ['shulker_box'], boxes: true };
  const names: string[] = [];
  const add = (n: string) => {
    if (!names.includes(n)) names.push(n);
  };
  const knownList = [...new Set([...known].map((k) => k.replace(/^minecraft:/, '')))];
  const e = entryFor(word);
  // ores: the ingot first (what an owner who says "iron" usually wants), then the raw ore item, then the rest
  if (e?.strategy === 'mine' && e.item.startsWith('raw_')) {
    const base = e.item.slice(4);
    add(`${base}_ingot`);
    add(e.item);
  }
  for (const k of knownList) if (!isShulkerBox(k) && itemMatches(word, k)) add(k);
  if (e) {
    if (e.strategy === 'gather' && e.item === 'logs') for (const k of knownList) if (k.endsWith('_log') || k.endsWith('_stem')) add(k);
    add(e.item);
  }
  if (names.length === 0) add(word); // nothing knows it: the reply names the word
  return { word, names, boxes: false };
}

/** The default amount: one stack of the first name (a shulker box: one). */
export function defaultCount(item: BringItem): number {
  return item.boxes ? 1 : maxStackOf(item.names[0] ?? item.word);
}

/** Records the bring may take from: read, reachable, not the other half of a double chest. */
export function sourceRecords(records: readonly ChestRecord[]): ChestRecord[] {
  const partners = partnerKeys(records);
  return records.filter((r) => r.readAt > 0 && r.size > 0 && !r.unreachable && !partners.has(chestKey(r)));
}

/** Loose items and items inside full shulker boxes the memory knows, in all. */
export function stockOf(records: readonly ChestRecord[], item: BringItem): { loose: number; boxed: number; chests: number } {
  let loose = 0;
  let boxed = 0;
  let chests = 0;
  for (const r of sourceRecords(records)) {
    const l = countOf(item, r.contents);
    const b = item.boxes ? 0 : countOf(item, r.inBoxes);
    loose += l;
    boxed += b;
    if (l + b > 0) chests++;
  }
  return { loose, boxed, chests };
}

/** One chest trip of a plan. */
export interface BringSource {
  key: string;
  pos: Vec3;
  kind: string;
  /** Items planned from this chest (a box source: the items inside its boxes, up to what is needed). */
  take: number;
  /** Take whole shulker boxes holding the item (the loose stacks are not enough). */
  box: boolean;
}

export interface BringPlan {
  want: number;
  /** Carried already (counts first). */
  carried: number;
  /** Still to take from the chests. */
  need: number;
  sources: BringSource[];
  /** Loose items and box contents the memory knows of. */
  loose: number;
  boxed: number;
  /** What the chests cannot give (need beyond loose + boxed). */
  short: number;
}

const dist = (r: Vec3, o: Vec3 | undefined): number => (o ? Math.hypot(r.x + 0.5 - o.x, r.y + 0.5 - o.y, r.z + 0.5 - o.z) : 0);

/** The plan (see the file comment): nearest chests first, loose stacks before boxes. */
export function planBring(records: readonly ChestRecord[], item: BringItem, want: number, carried: number, origin?: Vec3): BringPlan {
  const need = Math.max(0, want - carried);
  const list = sourceRecords(records).sort((a, b) => dist(a, origin) - dist(b, origin));
  const stock = stockOf(list, item);
  const plan: BringPlan = { want, carried, need, sources: [], loose: stock.loose, boxed: stock.boxed, short: 0 };
  let left = need;
  for (const r of list) {
    if (left <= 0) break;
    const n = Math.min(left, countOf(item, r.contents));
    if (n <= 0) continue;
    plan.sources.push({ key: chestKey(r), pos: { x: r.x, y: r.y, z: r.z }, kind: r.kind, take: n, box: false });
    left -= n;
  }
  if (!item.boxes) {
    for (const r of list) {
      if (left <= 0) break;
      const n = Math.min(left, countOf(item, r.inBoxes));
      if (n <= 0) continue;
      plan.sources.push({ key: chestKey(r), pos: { x: r.x, y: r.y, z: r.z }, kind: r.kind, take: n, box: true });
      left -= n;
    }
  }
  plan.short = left;
  return plan;
}

/** `!bring` arguments: `<item words> [n] [to <player>|home]`, `[n] <item>`. */
export function parseBringArgs(args: readonly string[]): { name: string; count: number | undefined; to: string | undefined } | { error: string } {
  const words = [...args];
  let to: string | undefined;
  const ti = words.findIndex((w) => w.toLowerCase() === 'to');
  if (ti >= 0) {
    const rest = words.slice(ti + 1);
    if (rest.length !== 1 || !/^[A-Za-z0-9_]{1,16}$/.test(rest[0]!)) return { error: 'to <player> or to home' };
    to = rest[0]!.toLowerCase() === 'home' ? 'home' : rest[0]!;
    words.splice(ti);
  } else if (words.length > 1 && words[words.length - 1]!.toLowerCase() === 'home') {
    to = 'home';
    words.pop();
  }
  // `me` = the sender (`!bring me 64 torches`, `!bring torches to me`)
  if (to?.toLowerCase() === 'me') to = undefined;
  if (words[0]?.toLowerCase() === 'me') words.shift();
  let count: number | undefined;
  const isNum = (s: string | undefined) => s !== undefined && /^\d+$/.test(s);
  if (isNum(words[words.length - 1])) count = Number(words.pop());
  else if (isNum(words[0])) count = Number(words.shift());
  if (words.length === 0) return { error: 'no item' };
  if (words.some((w) => /^\d+$/.test(w))) return { error: 'one count only' };
  if (count !== undefined && (count < 1 || count > 2304)) return { error: 'count must be 1 to 2304' };
  return { name: words.join('_'), count, to };
}

const MASS = new Set(['coal', 'charcoal', 'redstone', 'dirt', 'sand', 'red_sand', 'gravel', 'cobblestone', 'stone', 'cobbled_deepslate', 'netherrack', 'clay', 'glass', 'wheat', 'string', 'gunpowder', 'sugar', 'lapis_lazuli', 'quartz', 'bread', 'leather', 'iron', 'gold', 'copper', 'obsidian', 'tuff', 'deepslate', 'andesite', 'diorite', 'granite', 'calcite', 'flint', 'beef', 'mutton', 'chicken', 'rabbit', 'wood', 'logs']);

/** `64 torches`, `1 torch`, `20 coal`, `2 shulker boxes` (item names as the bot knows them). */
export function itemsText(n: number, name: string): string {
  const w = name.replace(/^minecraft:/, '');
  if (n === 1 || MASS.has(w) || w.endsWith('s')) return `${n} ${isShulkerBox(name) ? 'shulker box' : w}`;
  if (isShulkerBox(name)) return `${n} shulker boxes`;
  if (/(ch|sh|x)$/.test(w)) return `${n} ${w}es`;
  return `${n} ${w}s`;
}
