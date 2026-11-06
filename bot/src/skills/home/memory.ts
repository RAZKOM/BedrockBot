// Track AG (wave 9, docs/home.md "Chest memory"): turning what the bot saw inside a container into a
// ChestRecord (world/cache/chests.ts), the records into the unloader's PlanChests, and the replies of
// `!chests` and `!stock`.
import { chestKey, type ChestMemoryStore, type ChestRecord } from '../../world/cache/chests.ts';
import type { Vec3 } from '../../world/types.ts';
import { isShulkerBox, type ContainerSnapshot } from '../container/chest.ts';
import type { PlanChest } from './unloader.ts';
import { itemQuery, partnerKeys, stockHits, stockRecords, stockTotals } from './stock.ts'; // decision 0065: shared with the storage index

export { chestKey };
export { itemMatches, itemQuery, partnerKeys } from './stock.ts';

/** A record from a fresh read (keeps the owner's label of an earlier record). */
export function recordFrom(p: Vec3, kind: string, snap: ContainerSnapshot, prev: ChestRecord | undefined, now: number, partner?: Vec3): ChestRecord {
  return {
    x: Math.floor(p.x),
    y: Math.floor(p.y),
    z: Math.floor(p.z),
    kind,
    ...(prev?.label ? { label: prev.label } : {}),
    size: snap.size,
    free: snap.free,
    stacks: snap.stacks,
    contents: { ...snap.counts },
    room: { ...snap.room },
    boxes: { ...snap.boxes },
    double: snap.double,
    ...(partner ? { partner } : {}),
    readAt: now,
  };
}

/** A record for a container found but not opened yet. */
export function unreadRecord(p: Vec3, kind: string): ChestRecord {
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), kind, size: 0, free: 0, stacks: 0, contents: {}, room: {}, boxes: { empty: 0, full: 0 }, double: false, readAt: 0 };
}

/** The read records as unloader targets (partners and never-read containers left out). */
export function planChests(records: readonly ChestRecord[]): PlanChest[] {
  const partners = partnerKeys(records);
  return records
    .filter((r) => r.readAt > 0 && r.size > 0 && !r.unreachable && !partners.has(chestKey(r))) // Track AN: not the unreachable ones
    .map((r) => ({ key: chestKey(r), pos: { x: r.x, y: r.y, z: r.z }, kind: r.kind, label: r.label, free: r.free, contents: r.contents, room: r.room, boxes: r.boxes, inBoxes: r.inBoxes, ...(r.fullStacks ? { fullStacks: r.fullStacks } : {}) })); // Track AV: inBoxes (rule 1)
}

export const fmtPos = (p: Vec3): string => `${p.x} ${p.y} ${p.z}`;

/** `chest`, `double chest`, `barrel`, `shulker box` */
export function kindWord(r: Pick<ChestRecord, 'kind' | 'double'>): string {
  if (isShulkerBox(r.kind)) return 'shulker box';
  if (r.kind === 'trapped_chest') return r.double ? 'double trapped chest' : 'trapped chest';
  if (r.kind === 'chest') return r.double ? 'double chest' : 'chest';
  return r.kind.replace(/_/g, ' ');
}

/** `chest 100 63 -48 (ores)` */
export function chestName(r: ChestRecord): string {
  return `${kindWord(r)} ${fmtPos(r)}${r.label ? ` (${r.label})` : ''}`;
}

const top = (contents: Record<string, number>, n: number): string =>
  Object.entries(contents)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');

const plural = (word: string, n: number): string => (n === 1 ? word : word.endsWith('x') ? `${word}es` : `${word}s`);

/** Track AN: `3 chests (ores, wood), 1 double chest, 1 barrel`: the containers by kind, most first, with their labels. */
export function kindsLine(records: readonly ChestRecord[]): string {
  const groups = new Map<string, { n: number; labels: Set<string> }>();
  for (const r of records) {
    const k = kindWord(r);
    const g = groups.get(k) ?? { n: 0, labels: new Set<string>() };
    g.n++;
    if (r.label) g.labels.add(r.label);
    groups.set(k, g);
  }
  return [...groups]
    .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
    .map(([k, g]) => `${g.n} ${plural(k, g.n)}${g.labels.size ? ` (${[...g.labels].sort().join(', ')})` : ''}`)
    .join(', ');
}

/**
 * `!chests`: the counts (reachable, unreachable), the containers by kind with their labels, then one
 * part per reachable container, nearest first (chat cuts the line at 256 characters).
 */
export function chestsLine(records: readonly ChestRecord[], now: number, origin?: Vec3): string {
  if (records.length === 0) return 'chests: none remembered (try !chests scan near home)';
  const partners = partnerKeys(records);
  const list = records.filter((r) => !partners.has(chestKey(r)));
  const bad = list.filter((r) => r.unreachable).length;
  const head = `chests: ${list.length} remembered (${list.length - bad} reachable${bad ? `, ${bad} unreachable: !chests unreachable` : ''}): ${kindsLine(list)}`;
  const ok = list.filter((r) => !r.unreachable);
  const sorted = origin ? [...ok].sort((a, b) => Math.hypot(a.x - origin.x, a.y - origin.y, a.z - origin.z) - Math.hypot(b.x - origin.x, b.y - origin.y, b.z - origin.z)) : ok;
  const parts = sorted.map((r) => {
    if (r.readAt <= 0) return `${chestName(r)}: not read yet`;
    const age = Math.max(0, Math.round((now - r.readAt) / 60_000));
    const what = top(r.contents, 3);
    return `${chestName(r)}: ${r.free}/${r.size} free${what ? `, ${what}` : ', empty'}${r.boxes.empty ? `, ${r.boxes.empty} empty shulker box${r.boxes.empty === 1 ? '' : 'es'}` : ''} (${age} min ago)`;
  });
  return parts.length ? `${head} | ${parts.join(' | ')}` : head;
}

/**
 * Track AN: `!chests unreachable`: the containers the bot could not get to, with the reasons and the
 * age, nearest first, packed into at most `maxLines` chat lines of `maxLength` characters.
 */
export function unreachableLines(records: readonly ChestRecord[], now: number, origin?: Vec3, maxLines = 3, maxLength = 256): string[] {
  const list = records.filter((r) => r.unreachable);
  if (list.length === 0) return ['chests: none unreachable'];
  const sorted = origin ? [...list].sort((a, b) => Math.hypot(a.x - origin.x, a.y - origin.y, a.z - origin.z) - Math.hypot(b.x - origin.x, b.y - origin.y, b.z - origin.z)) : list;
  const parts = sorted.map((r) => `${chestName(r)}: ${r.unreachable} (${Math.max(0, Math.round((now - (r.unreachableAt ?? now)) / 60_000))} min ago)`);
  const lines: string[] = [];
  let cur = `chests: ${list.length} unreachable: `;
  let first = true;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const more = ` ... and ${parts.length - i} more (!chests clear forgets them, !chests scan tries again)`;
    const sep = first ? '' : ' | ';
    if (cur.length + sep.length + part.length <= maxLength && (lines.length < maxLines - 1 || cur.length + sep.length + part.length + more.length <= maxLength || i === parts.length - 1)) {
      cur += sep + part;
      first = false;
      continue;
    }
    if (lines.length === maxLines - 1) {
      lines.push(`${cur}${more}`.slice(0, maxLength));
      return lines;
    }
    lines.push(cur);
    cur = part;
    first = false;
  }
  lines.push(cur);
  return lines;
}

/** `!stock [item]` from memory (decision 0065: the counting is stock.ts, shared with the storage index; this only words the reply). */
export function stockLine(store: Pick<ChestMemoryStore, 'all'>, raw: string | undefined, origin?: Vec3, radius = Infinity): string {
  const list = stockRecords(store.all(), origin, radius);
  if (list.length === 0) return 'stock: no chest read yet (try !chests scan near home)';
  if (!raw) {
    const what = top(stockTotals(list), 12);
    return `stock: ${list.length} container${list.length === 1 ? '' : 's'}: ${what || 'all empty'}`;
  }
  const q = itemQuery(raw);
  const hits = stockHits(list, q);
  if (hits.length === 0) return `stock: no ${q} in the ${list.length} container${list.length === 1 ? '' : 's'} I know`;
  const total = hits.reduce((a, h) => a + h.n, 0);
  const parts = hits.map((h) => `${h.n} in ${chestName(h.r)}${h.empty !== undefined ? ` (${h.empty} empty)` : ''}${h.boxed > 0 ? ` (${h.boxed === h.n ? 'all' : h.boxed} in boxes)` : ''}`);
  return `${q}: ${parts.join(', ')}${hits.length > 1 ? ` (${total} in all)` : ''}`;
}
