// Web panel step 3 (decision 0065, docs/storage.md): the panel's side of the storage index
// (skills/home/storage.ts, search.ts). One owner for the storage wire:
//
//   GET /api/storage                        totals by category, the containers summary and freshness, the
//                                           containers by fullness, the recent changes
//   GET /api/storage/search?q=diamonds      ranked items with every place (search.ts) and their last
//                                           deposits / withdrawals
//   GET /api/storage/container?x&y&z&dim    one container as remembered (counts by item, boxes, per box)
//   topic `storage` (state)                 the summary; a delta when the chest memory or the inventory
//                                           changes (ChestMemory.onChange, Inventory.onChange), and when a
//                                           container event arrives
//
// Recent changes are the event store's `container.deposit` / `container.withdraw` (decision 0059): the
// newest are read once at start (`events.query`), then followed live (`events.subscribe`). Read-only:
// every action the view offers is a chat command through POST /api/cmd (client/storedefs.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BotEvent, EventBus } from '../../events/index.ts';
import type { Logger } from '../../log.ts';
import { searchStorage, type StorageSearch } from '../../skills/home/search.ts';
import { buildStorageIndex, STALE_MS, type CarriedStack, type FreshnessSummary, type Placed, type StorageContainer, type StorageIndex } from '../../skills/home/storage.ts';
import { shulkerContents, isShulkerBox } from '../../skills/container/chest.ts';
import type { ChestMemoryStore } from '../../world/cache/chests.ts';
import type { ItemStack } from '../../world/types.ts';
import type { HealthRoute } from '../map/routes.ts';
import { PANEL_BUDGETS } from './budgets.ts';
import { STORAGE_CONTAINER_PATH, STORAGE_PATH, STORAGE_SEARCH_PATH, STORAGE_TOPIC } from './shared.ts';
import type { StreamHub, Topic } from './stream.ts';

/** Items each category lists in the topic (the page shows the top ones; /api/storage lists them all). */
export const TOPIC_TOP = 4;
/** Containers in the topic's fullest list, changes in its recent list. */
export const TOPIC_FULLEST = 5;
export const TOPIC_RECENT = 8;
/** Container events kept in memory (the recent list and the per-item history of a search). */
export const RECENT_KEEP = 200;
/** After a change: the topic is refreshed this much later (a deposit run changes the memory many times). */
export const REFRESH_MS = 400;
/** The topic is sampled this often while a stream listens: the stale count moves with time alone. */
export const SAMPLE_MS = 5000;
/** An index older than this is rebuilt on a read even without a change (the bot moved: distances). */
export const INDEX_TTL_MS = 2000;

/** A row of a container list. */
export interface StorageRow {
  x: number;
  y: number;
  z: number;
  dim: number;
  kind: string;
  label: string | null;
  used: number;
  size: number;
  readAt: number;
  unreachable: boolean;
}

/** One deposit or withdrawal (a `container.*` event). */
export interface StorageChange {
  id: number;
  ts: number;
  kind: 'deposit' | 'withdraw';
  at: [number, number, number];
  block: string | null;
  /** Items, most first. */
  items: [string, number][];
}

/** The `storage` topic's value (and the head of GET /api/storage). */
export interface StorageSummary {
  rev: number;
  staleMs: number;
  /** Who a panel command runs as (`!bring` "to me" goes to this player); null: the console (the items go home). */
  me: string | null;
  containers: FreshnessSummary & { used: number; size: number };
  totals: { items: number; kinds: number; carried: number };
  categories: { id: string; total: number; kinds: number; top: [string, number][] }[];
  fullest: StorageRow[];
  recent: StorageChange[];
}

/** GET /api/storage: the summary with every category's items and every container by fullness. */
export interface StorageOverview extends Omit<StorageSummary, 'categories'> {
  categories: { id: string; total: number; kinds: number; items: [string, number][] }[];
  byFullness: StorageRow[];
  never: StorageRow[];
}

/** GET /api/storage/search: search.ts's answer plus each item's last changes. */
export interface StorageSearchAnswer extends StorageSearch {
  recent: Record<string, { ts: number; kind: 'deposit' | 'withdraw'; n: number; at: [number, number, number]; block: string | null }[]>;
}

/** GET /api/storage/container */
export interface StorageContainerAnswer {
  container: StorageContainer;
  contents: [string, number][];
  inBoxes: [string, number][];
  boxes: { empty: number; full: number };
  boxList: [string, number][][];
  partner: { x: number; y: number; z: number } | null;
}

export interface StorageInventory {
  readonly slots: readonly (ItemStack | null)[];
  rawItem(window: number, slot: number): unknown;
  onChange?(fn: (window: number, slot: number | undefined) => void): () => void;
}

export interface StorageSource {
  /** The chest memory `!stock` reads (the world cache's, else the task's in-memory one); may change identity. */
  memory(): ChestMemoryStore | undefined;
  inventory(): StorageInventory | undefined;
  home(): Placed | undefined;
  bot(): Placed | undefined;
  /** The player panel commands run as; null = the console. */
  runAs(): string | null;
}

export interface StorageLiveOptions {
  hub: StreamHub;
  source: StorageSource;
  /** Decision 0059's bus: container events live, and the newest stored ones at start (`query`, when there). */
  events?: (Pick<EventBus, 'subscribe'> & Partial<Pick<EventBus, 'query'>>) | undefined;
  log?: Logger;
  now?: () => number;
}

const top = (m: Readonly<Record<string, number>>): [string, number][] => Object.entries(m).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const row = (c: StorageContainer): StorageRow => ({ x: c.x, y: c.y, z: c.z, dim: c.dim, kind: c.kind, label: c.label, used: c.stacks, size: c.size, readAt: c.readAt, unreachable: c.unreachable !== null });

/** A container event as a change (null for anything else). */
export function changeOf(e: Pick<BotEvent, 'id' | 'ts' | 'kind' | 'data'>): StorageChange | null {
  if (e.kind !== 'container.deposit' && e.kind !== 'container.withdraw') return null;
  const d = e.data as { at?: { x: number; y: number; z: number }; block?: string; items?: Record<string, number> };
  if (!d.at) return null;
  return { id: e.id, ts: e.ts, kind: e.kind === 'container.deposit' ? 'deposit' : 'withdraw', at: [d.at.x, d.at.y, d.at.z], block: d.block ?? null, items: top(d.items ?? {}) };
}

/** What the bot carries, its shulker boxes' contents from the wire items (slots 0..35). */
export function carriedOf(inv: StorageInventory | undefined): CarriedStack[] {
  if (!inv) return [];
  const out: CarriedStack[] = [];
  for (let i = 0; i < 36; i++) {
    const s = inv.slots[i];
    if (!s || s.count <= 0) continue;
    const name = s.name.replace(/^minecraft:/, '');
    if (isShulkerBox(name)) {
      const raw = inv.rawItem(0, i);
      out.push({ name, count: s.count, ...(raw !== undefined ? { box: shulkerContents(raw) } : {}) });
    } else out.push({ name, count: s.count });
  }
  return out;
}

export class StorageLive {
  readonly topic: Topic;
  private readonly o: StorageLiveOptions;
  private readonly now: () => number;
  private rev = 1;
  private built: { rev: number; at: number; index: StorageIndex } | undefined;
  private watchedMemory: ChestMemoryStore | undefined;
  private offMemory: (() => void) | undefined;
  private watchedInventory: StorageInventory | undefined;
  private offInventory: (() => void) | undefined;
  private readonly offEvents: (() => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private recentList: StorageChange[] = [];
  readonly stats = { builds: 0, changes: 0, refreshes: 0, searches: 0 };

  constructor(o: StorageLiveOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.topic = o.hub.topic(STORAGE_TOPIC, { kind: 'state', read: () => this.summary(), sampleMs: SAMPLE_MS, budget: PANEL_BUDGETS.storage, deltaBudget: PANEL_BUDGETS.storageDelta });
    if (o.events) {
      this.offEvents = o.events.subscribe((e) => {
        const c = changeOf(e);
        if (!c) return;
        this.addChanges([c]);
        this.changed();
      });
      void (o.events.query?.({ kinds: ['container'], limit: RECENT_KEEP }) ?? Promise.resolve(undefined)).then(
        (r) => {
          const list = (r?.events ?? []).map(changeOf).filter((c): c is StorageChange => c !== null);
          if (list.length) {
            this.addChanges(list);
            this.changed();
          }
        },
        (e: unknown) => this.o.log?.warn(`storage: reading the recent container events failed: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
    this.watch();
  }

  private addChanges(list: StorageChange[]): void {
    const byId = new Map(this.recentList.map((c) => [c.id, c]));
    for (const c of list) byId.set(c.id, c);
    this.recentList = [...byId.values()].sort((a, b) => a.id - b.id).slice(-RECENT_KEEP);
  }

  /** Follow the current chest memory and inventory (either may be replaced: the world cache opening late). */
  private watch(): void {
    const m = this.o.source.memory();
    if (m !== this.watchedMemory) {
      this.offMemory?.();
      this.watchedMemory = m;
      this.offMemory = m?.onChange?.(() => this.changed());
      this.rev++;
    }
    const inv = this.o.source.inventory();
    if (inv !== this.watchedInventory) {
      this.offInventory?.();
      this.watchedInventory = inv;
      this.offInventory = inv?.onChange?.((w) => {
        if (w === 0) this.changed();
      });
      this.rev++;
    }
  }

  /** Something changed: a new revision, the topic refreshed shortly (many changes in a burst are one refresh). */
  changed(): void {
    this.rev++;
    this.stats.changes++;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.stats.refreshes++;
      this.topic.refresh();
    }, REFRESH_MS);
    this.timer.unref?.();
  }

  /** The index of what is known now (rebuilt after a change, or when older than INDEX_TTL_MS). */
  index(): StorageIndex {
    this.watch();
    const now = this.now();
    if (this.built?.rev === this.rev && now - this.built.at < INDEX_TTL_MS) return this.built.index;
    const m = this.watchedMemory;
    const dims = m ? (m.byDimension?.() ?? [{ dim: this.o.source.bot()?.dim ?? 0, records: m.all() }]) : [];
    const index = buildStorageIndex({ dims, carried: carriedOf(this.watchedInventory), home: this.o.source.home(), bot: this.o.source.bot(), now });
    this.built = { rev: this.rev, at: now, index };
    this.stats.builds++;
    return index;
  }

  /** The topic's value. */
  summary(): StorageSummary {
    const ix = this.index();
    let used = 0;
    let size = 0;
    for (const c of ix.containers) {
      used += c.stacks;
      size += c.size;
    }
    return {
      rev: this.rev,
      staleMs: STALE_MS,
      me: this.o.source.runAs(),
      containers: { ...ix.freshness, used, size },
      totals: ix.totals(),
      categories: ix.categories().map((c) => ({ id: c.id, total: c.total, kinds: c.kinds, top: c.items.slice(0, TOPIC_TOP) })),
      fullest: ix.byFullness().slice(0, TOPIC_FULLEST).map(row),
      recent: this.recentList.slice(-TOPIC_RECENT).reverse().map((c) => ({ ...c, items: c.items.slice(0, 4) })),
    };
  }

  overview(): StorageOverview {
    const ix = this.index();
    const s = this.summary();
    return {
      ...s,
      categories: ix.categories().map((c) => ({ id: c.id, total: c.total, kinds: c.kinds, items: c.items })),
      byFullness: ix.byFullness().map(row),
      never: ix.containers.filter((c) => c.fresh === 'never').map(row),
    };
  }

  search(q: string): StorageSearchAnswer {
    this.stats.searches++;
    const a = searchStorage(this.index(), q);
    const recent: StorageSearchAnswer['recent'] = {};
    for (const r of a.results) {
      const list: StorageSearchAnswer['recent'][string] = [];
      for (let i = this.recentList.length - 1; i >= 0 && list.length < 5; i--) {
        const c = this.recentList[i]!;
        const n = c.items.find(([k]) => k === r.name)?.[1];
        if (n) list.push({ ts: c.ts, kind: c.kind, n, at: c.at, block: c.block });
      }
      if (list.length) recent[r.name] = list;
    }
    return { ...a, recent };
  }

  container(dim: number, p: { x: number; y: number; z: number }): StorageContainerAnswer | undefined {
    const hit = this.index().container(dim, p);
    if (!hit) return undefined;
    const r = hit.record;
    return { container: hit.container, contents: top(r.contents), inBoxes: top(r.inBoxes ?? {}), boxes: { ...r.boxes }, boxList: (r.boxList ?? []).map(top), partner: r.partner ? { ...r.partner } : null };
  }

  route(): HealthRoute {
    return (path: string, req: IncomingMessage, res: ServerResponse): boolean => {
      if (path !== STORAGE_PATH && path !== STORAGE_SEARCH_PATH && path !== STORAGE_CONTAINER_PATH) return false;
      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        send(res, 405, { error: 'method not allowed' });
        return true;
      }
      const q = new URL(req.url ?? path, 'http://localhost').searchParams;
      try {
        if (path === STORAGE_PATH) send(res, 200, this.overview(), method === 'HEAD');
        else if (path === STORAGE_SEARCH_PATH) {
          const text = (q.get('q') ?? '').slice(0, 64);
          send(res, 200, this.search(text), method === 'HEAD');
        } else {
          const n = ['x', 'y', 'z', 'dim'].map((k) => Number(q.get(k) ?? (k === 'dim' ? 0 : NaN)));
          if (!n.every((v) => Number.isInteger(v))) {
            send(res, 400, { error: 'x, y, z (and dim) must be whole numbers' });
            return true;
          }
          const a = this.container(n[3]!, { x: n[0]!, y: n[1]!, z: n[2]! });
          if (a) send(res, 200, a, method === 'HEAD');
          else send(res, 404, { error: 'no container remembered there' });
        }
      } catch (e) {
        send(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    };
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.offMemory?.();
    this.offInventory?.();
    this.offEvents?.();
  }
}

function send(res: ServerResponse, status: number, body: unknown, head = false): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(head ? undefined : `${JSON.stringify(body)}\n`);
}
