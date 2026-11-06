// Web panel step 3 (decision 0065, docs/storage.md): the storage index. One pure answer to "what do I have
// and where is it" from what the bot already knows, nothing scanned anew:
//
//   - every remembered container (the chest memory, world/cache/chests.ts, every dimension): its loose
//     contents and what the full shulker boxes inside hold (`inBoxes`), its fullness and freshness
//     (`readAt`; a container found but never opened counts apart, one read longer ago than STALE_MS is
//     stale), its distance from home and from the bot (same dimension only);
//   - what the bot carries, the contents of its carried shulker boxes included.
//
// It answers the totals per item (loose, in boxes, carried), where each item is (container, count, loose
// or in a box, distances), the totals per category (categories.ts) and the containers by fullness.
//
// `!stock` counts with the same primitives (stock.ts: partners left out, loose plus boxed; memory.ts
// stockLine only words the reply), so the chat and the panel never disagree. It lives next to the chest memory's other readers
// (memory.ts, bring.ts) because both the chat command and the panel (health/panel/storage.ts) import it,
// and skills/ never imports the panel. Pure: no bot state, no I/O.
import { chestKey, type ChestRecord } from '../../world/cache/chests.ts';
import type { Vec3 } from '../../world/types.ts';
import { categoryOf, type Category } from './categories.ts';
import { partnerKeys } from './stock.ts';

/** A container read longer ago than this is stale (its contents may have changed since). */
export const STALE_MS = 24 * 3_600_000;

/** Bedrock dimension ids (the chest memory keeps one file per dimension). */
export const DIMENSIONS: Readonly<Record<number, string>> = { 0: 'overworld', 1: 'nether', 2: 'the_end' };

/** A position in a dimension. */
export interface Placed extends Vec3 {
  dim: number;
}

/** One stack the bot carries; a shulker box with its contents when the wire item says them. */
export interface CarriedStack {
  name: string;
  count: number;
  box?: Readonly<Record<string, number>> | undefined;
}

export interface StorageInput {
  /** The chest memory per dimension (ChestMemory.byDimension). */
  dims: readonly { dim: number; records: readonly ChestRecord[] }[];
  /** What the bot carries (inventory slots 0..35). */
  carried?: readonly CarriedStack[];
  home?: Placed | undefined;
  bot?: Placed | undefined;
  now?: number;
  staleMs?: number;
}

export type Freshness = 'fresh' | 'stale' | 'never';

export interface StorageContainer {
  /** `dim:x,y,z` */
  key: string;
  dim: number;
  x: number;
  y: number;
  z: number;
  kind: string;
  label: string | null;
  double: boolean;
  size: number;
  free: number;
  stacks: number;
  readAt: number;
  unreachable: string | null;
  /** Slots used / size when read (null: never opened). */
  fullness: number | null;
  /** Items lying loose, items inside its full shulker boxes. */
  loose: number;
  boxed: number;
  distHome: number | null;
  distBot: number | null;
  fresh: Freshness;
}

/** One place an item is: a container, or the bot's inventory. */
export interface StoragePlace {
  where: 'chest' | 'carried';
  /** The container's key; null for the bot. */
  key: string | null;
  dim: number | null;
  x: number | null;
  y: number | null;
  z: number | null;
  kind: string;
  label: string | null;
  /** count = loose + boxed. */
  count: number;
  loose: number;
  boxed: number;
  readAt: number | null;
  distHome: number | null;
  distBot: number | null;
  unreachable: string | null;
}

export interface ItemTotal {
  name: string;
  category: Category;
  total: number;
  /** In containers, loose / inside their full shulker boxes. */
  loose: number;
  boxed: number;
  /** Carried (loose and inside carried boxes). */
  carried: number;
  /** Containers holding some. */
  places: number;
}

export interface CategoryTotal {
  id: Category;
  total: number;
  kinds: number;
  /** Items by total, most first. */
  items: [string, number][];
}

export interface FreshnessSummary {
  /** Containers remembered (second halves of double chests not counted). */
  known: number;
  read: number;
  never: number;
  stale: number;
  unreachable: number;
  /** Oldest / newest read (ms; 0 = none read). */
  oldestReadAt: number;
  newestReadAt: number;
  /** Containers per dimension id. */
  dims: Record<string, number>;
}

const add = (m: Record<string, number>, k: string, n: number): void => {
  if (n) m[k] = (m[k] ?? 0) + n;
};

const sum = (m: Readonly<Record<string, number>> | undefined): number => Object.values(m ?? {}).reduce((a, b) => a + b, 0);

// ---- the index -------------------------------------------------------------------------------------------

export const storageKey = (dim: number, p: Vec3): string => `${dim}:${chestKey(p)}`;

const dist = (a: Vec3, dim: number, b: Placed | undefined): number | null =>
  b?.dim === dim ? Math.round(Math.hypot(a.x + 0.5 - b.x, a.y + 0.5 - b.y, a.z + 0.5 - b.z) * 10) / 10 : null;

interface Entry {
  c: StorageContainer;
  r: ChestRecord;
}

export class StorageIndex {
  /** Every container (partners left out), nearest to home first (then to the bot). */
  readonly containers: readonly StorageContainer[];
  readonly items: ReadonlyMap<string, ItemTotal>;
  readonly freshness: FreshnessSummary;
  /** Carried items by name (loose plus inside carried boxes) and the part inside boxes. */
  readonly carried: Readonly<Record<string, number>>;
  readonly carriedBoxed: Readonly<Record<string, number>>;
  readonly now: number;
  private readonly entries: readonly Entry[];
  private readonly byKey: ReadonlyMap<string, Entry>;

  constructor(input: StorageInput) {
    const now = input.now ?? Date.now();
    const staleMs = input.staleMs ?? STALE_MS;
    this.now = now;
    const entries: Entry[] = [];
    const fresh: FreshnessSummary = { known: 0, read: 0, never: 0, stale: 0, unreachable: 0, oldestReadAt: 0, newestReadAt: 0, dims: {} };
    for (const { dim, records } of input.dims) {
      const partners = partnerKeys(records);
      for (const r of records) {
        if (partners.has(chestKey(r))) continue;
        const read = r.readAt > 0 && r.size > 0;
        const f: Freshness = !read ? 'never' : now - r.readAt > staleMs ? 'stale' : 'fresh';
        const c: StorageContainer = {
          key: storageKey(dim, r),
          dim,
          x: r.x,
          y: r.y,
          z: r.z,
          kind: r.kind,
          label: r.label ?? null,
          double: r.double,
          size: r.size,
          free: r.free,
          stacks: r.stacks,
          readAt: r.readAt,
          unreachable: r.unreachable ?? null,
          fullness: read ? Math.round((r.stacks / r.size) * 1000) / 1000 : null,
          loose: sum(r.contents),
          boxed: sum(r.inBoxes),
          distHome: dist(r, dim, input.home),
          distBot: dist(r, dim, input.bot),
          fresh: f,
        };
        entries.push({ c, r });
        fresh.known++;
        fresh.dims[String(dim)] = (fresh.dims[String(dim)] ?? 0) + 1;
        if (r.unreachable) fresh.unreachable++;
        if (f === 'never') fresh.never++;
        else {
          fresh.read++;
          if (f === 'stale') fresh.stale++;
          if (!fresh.oldestReadAt || r.readAt < fresh.oldestReadAt) fresh.oldestReadAt = r.readAt;
          fresh.newestReadAt = Math.max(fresh.newestReadAt, r.readAt);
        }
      }
    }
    const near = (c: StorageContainer): number => c.distHome ?? (c.distBot !== null ? 1e6 + c.distBot : 2e6);
    entries.sort((a, b) => near(a.c) - near(b.c) || a.c.key.localeCompare(b.c.key));
    this.entries = entries;
    this.containers = entries.map((e) => e.c);
    this.byKey = new Map(entries.map((e) => [e.c.key, e]));
    this.freshness = fresh;

    const carried: Record<string, number> = {};
    const carriedBoxed: Record<string, number> = {};
    for (const s of input.carried ?? []) {
      if (s.count <= 0) continue;
      add(carried, s.name, s.count);
      for (const [k, v] of Object.entries(s.box ?? {})) {
        add(carried, k, v * Math.max(1, s.count));
        add(carriedBoxed, k, v * Math.max(1, s.count));
      }
    }
    this.carried = carried;
    this.carriedBoxed = carriedBoxed;

    const items = new Map<string, ItemTotal>();
    const item = (name: string): ItemTotal => {
      let t = items.get(name);
      if (!t) {
        t = { name, category: categoryOf(name), total: 0, loose: 0, boxed: 0, carried: 0, places: 0 };
        items.set(name, t);
      }
      return t;
    };
    for (const { r } of entries) {
      const here = new Set<string>();
      for (const [k, v] of Object.entries(r.contents)) {
        if (v <= 0) continue;
        const t = item(k);
        t.loose += v;
        t.total += v;
        here.add(k);
      }
      for (const [k, v] of Object.entries(r.inBoxes ?? {})) {
        if (v <= 0) continue;
        const t = item(k);
        t.boxed += v;
        t.total += v;
        here.add(k);
      }
      for (const k of here) item(k).places++;
    }
    for (const [k, v] of Object.entries(carried)) {
      const t = item(k);
      t.carried += v;
      t.total += v;
    }
    this.items = items;
  }

  /** A container by dimension and position (its record too: the slots as remembered). */
  container(dim: number, p: Vec3): { container: StorageContainer; record: ChestRecord } | undefined {
    const e = this.byKey.get(storageKey(dim, p));
    return e ? { container: e.c, record: e.r } : undefined;
  }

  /** Where an item is: the bot first (it is at hand), then the containers by count, nearest first on a tie. */
  where(name: string): StoragePlace[] {
    const out: StoragePlace[] = [];
    const carried = this.carried[name] ?? 0;
    if (carried > 0) {
      const boxed = this.carriedBoxed[name] ?? 0;
      out.push({ where: 'carried', key: null, dim: null, x: null, y: null, z: null, kind: 'inventory', label: null, count: carried, loose: carried - boxed, boxed, readAt: null, distHome: null, distBot: 0, unreachable: null });
    }
    const chests: StoragePlace[] = [];
    for (const { c, r } of this.entries) {
      const loose = r.contents[name] ?? 0;
      const boxed = r.inBoxes?.[name] ?? 0;
      if (loose + boxed <= 0) continue;
      chests.push({ where: 'chest', key: c.key, dim: c.dim, x: c.x, y: c.y, z: c.z, kind: c.kind, label: c.label, count: loose + boxed, loose, boxed, readAt: c.readAt, distHome: c.distHome, distBot: c.distBot, unreachable: c.unreachable });
    }
    chests.sort((a, b) => b.count - a.count || (a.distHome ?? Infinity) - (b.distHome ?? Infinity));
    return [...out, ...chests];
  }

  /** Totals per category (categories.ts), biggest first; items in each, most first. */
  categories(): CategoryTotal[] {
    const by = new Map<Category, CategoryTotal>();
    for (const t of this.items.values()) {
      if (t.total <= 0) continue;
      let c = by.get(t.category);
      if (!c) {
        c = { id: t.category, total: 0, kinds: 0, items: [] };
        by.set(t.category, c);
      }
      c.total += t.total;
      c.kinds++;
      c.items.push([t.name, t.total]);
    }
    const out = [...by.values()];
    for (const c of out) c.items.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return out.sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));
  }

  /** The read containers, fullest first (most slots used of their size). */
  byFullness(): StorageContainer[] {
    return this.containers.filter((c) => c.fullness !== null).sort((a, b) => b.fullness! - a.fullness! || b.stacks - a.stacks || a.key.localeCompare(b.key));
  }

  /** Items in all (containers and carried) and kinds. */
  totals(): { items: number; kinds: number; carried: number } {
    let items = 0;
    let kinds = 0;
    for (const t of this.items.values()) {
      if (t.total <= 0) continue;
      items += t.total;
      kinds++;
    }
    return { items, kinds, carried: sum(this.carried) };
  }
}

export function buildStorageIndex(input: StorageInput): StorageIndex {
  return new StorageIndex(input);
}
