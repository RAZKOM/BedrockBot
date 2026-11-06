// Decision 0065 (docs/storage.md "The index"): the counting both `!stock` and the storage index
// (storage.ts) use, so the chat reply and the panel never disagree. Pure, and it imports only the chest
// memory's types and the shulker box names: memory.ts re-exports it (bring.ts and the tests import these
// names from there), and storage.ts builds on it without an import cycle through categories.ts.
import { chestKey, type ChestRecord } from '../../world/cache/chests.ts';
import type { Vec3 } from '../../world/types.ts';
import { isShulkerBox } from '../container/chest.ts';

/** Positions that are the other half of a remembered double chest (never containers of their own). */
export function partnerKeys(records: readonly ChestRecord[]): Set<string> {
  const out = new Set<string>();
  for (const r of records) if (r.partner) out.add(chestKey(r.partner));
  return out;
}

/** Normalised item query: `minecraft:Coal` -> `coal`; `shulker` / `shulkers` / `box` -> any shulker box. */
export function itemQuery(raw: string): string {
  const n = raw.toLowerCase().replace(/^minecraft:/, '');
  if (['shulker', 'shulkers', 'box', 'boxes', 'shulker_box', 'shulker_boxes'].includes(n)) return 'shulker_box';
  return n;
}

/** Matches a query: the exact name, its plural, or any shulker box for `shulker_box`. */
export function itemMatches(query: string, name: string): boolean {
  if (query === 'shulker_box') return isShulkerBox(name);
  return name === query || `${name}s` === query || name === query.replace(/es$/, '') || name.replace(/^raw_/, '') === query;
}

/** The containers `!stock` counts: read, within `radius` of `origin` (when given), not the other half of a double chest. */
export function stockRecords(records: readonly ChestRecord[], origin?: Vec3, radius = Infinity): ChestRecord[] {
  const read = records.filter((r) => r.readAt > 0 && (!origin || Math.hypot(r.x - origin.x, r.y - origin.y, r.z - origin.z) <= radius));
  const partners = partnerKeys(read);
  return read.filter((r) => !partners.has(chestKey(r)));
}

/** Items by name over the containers: loose plus inside their full shulker boxes (Track AV: boxed items count). */
export function stockTotals(list: readonly ChestRecord[]): Record<string, number> {
  const total: Record<string, number> = {};
  for (const r of list) for (const [k, v] of Object.entries(r.contents)) total[k] = (total[k] ?? 0) + v;
  for (const r of list) for (const [k, v] of Object.entries(r.inBoxes ?? {})) total[k] = (total[k] ?? 0) + v;
  return total;
}

export interface StockHit {
  r: ChestRecord;
  /** Loose + boxed. */
  n: number;
  boxed: number;
  /** `!stock shulker`: the empty boxes in it. */
  empty?: number;
}

/** Where a `!stock` query is: the containers holding it, most first (a shulker query counts the boxes, not their contents). */
export function stockHits(list: readonly ChestRecord[], q: string): StockHit[] {
  const hits: StockHit[] = [];
  for (const r of list) {
    let n = 0;
    for (const [k, v] of Object.entries(r.contents)) if (itemMatches(q, k)) n += v;
    let boxed = 0;
    if (q !== 'shulker_box') for (const [k, v] of Object.entries(r.inBoxes ?? {})) if (itemMatches(q, k)) boxed += v;
    if (n + boxed > 0) hits.push({ r, n: n + boxed, boxed, ...(q === 'shulker_box' ? { empty: r.boxes.empty } : {}) });
  }
  return hits.sort((a, b) => b.n - a.n);
}
