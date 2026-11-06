// Decision 0065 (docs/storage.md): the panel's storage wire (health/panel/storage.ts) over real HTTP:
// GET /api/storage, /api/storage/search, /api/storage/container (and their refusals), the `storage`
// topic's snapshot and its deltas when the chest memory, the inventory or the event store changes, the
// recent changes per item, a replaced memory followed, and the byte budgets on a worst case.
import { afterEach, describe, expect, it } from 'vitest';
import { HealthServer } from '../../../src/connection/health.ts';
import { Metrics } from '../../../src/connection/metrics.ts';
import { applyDelta, type DeltaOp, type Json } from '../../../src/health/panel/client/delta.ts';
import { PANEL_BUDGETS } from '../../../src/health/panel/budgets.ts';
import { STORAGE_TOPIC } from '../../../src/health/panel/shared.ts';
import { carriedOf, changeOf, REFRESH_MS, StorageLive, type StorageContainerAnswer, type StorageInventory, type StorageOverview, type StorageSearchAnswer, type StorageSummary } from '../../../src/health/panel/storage.ts';
import { StreamHub } from '../../../src/health/panel/stream.ts';
import { silentLogger } from '../../../src/log.ts';
import { itemRegistry } from '../../../src/skills/home/search.ts';
import { ChestMemory, type ChestRecord } from '../../../src/world/cache/chests.ts';
import type { ItemStack } from '../../../src/world/types.ts';
import type { BotEvent } from '../../../src/events/index.ts';
import { onFetchablePort, openSse, type SseStream } from './panel-sse.ts';

const servers: HealthServer[] = [];
const streams: SseStream[] = [];
const lives: StorageLive[] = [];
const hubs: StreamHub[] = [];
afterEach(async () => {
  for (const s of streams.splice(0)) s.close();
  for (const l of lives.splice(0)) l.stop();
  for (const h of hubs.splice(0)) h.close();
  for (const s of servers.splice(0)) await s.stop();
});

const rec = (x: number, contents: Record<string, number>, extra: Partial<ChestRecord> = {}): ChestRecord => ({
  x,
  y: 64,
  z: 0,
  kind: 'chest',
  size: 27,
  free: 27 - Object.keys(contents).length,
  stacks: Object.keys(contents).length,
  contents,
  room: {},
  boxes: { empty: 0, full: 0 },
  double: false,
  readAt: Date.now() - 1000,
  ...extra,
});
const boxRaw = (items: Record<string, number>) => ({ extra: { nbt: { nbt: { value: { Items: { value: { value: Object.entries(items).map(([n, c]) => ({ Name: { value: `minecraft:${n}` }, Count: { value: c } })) } } } } } } });
const stack = (name: string, count: number): ItemStack => ({ name, count, networkId: 1, metadata: 0 });

/** A fake inventory: slots, wire items for boxes, change listeners. */
function fakeInventory() {
  const slots: (ItemStack | null)[] = Array.from({ length: 36 }, () => null);
  const raw = new Map<number, unknown>();
  const fns = new Set<(w: number, s: number | undefined) => void>();
  const inv: StorageInventory & { put(i: number, s: ItemStack | null, r?: unknown): void; listeners: number } = {
    slots,
    rawItem: (_w, i) => raw.get(i),
    onChange: (fn) => {
      fns.add(fn);
      return () => fns.delete(fn);
    },
    put(i, s, r) {
      slots[i] = s;
      if (r !== undefined) raw.set(i, r);
      for (const f of fns) f(0, i);
    },
    get listeners() {
      return fns.size;
    },
  };
  return inv;
}

/** A fake event bus: subscribe, query (the stored ones), emit. */
function fakeEvents(stored: BotEvent[] = []) {
  const fns = new Set<(e: BotEvent) => void>();
  let id = 100;
  return {
    subscribe: (fn: (e: BotEvent) => void) => {
      fns.add(fn);
      return () => fns.delete(fn);
    },
    query: () => Promise.resolve({ events: stored, more: false } as never),
    emit(kind: 'container.deposit' | 'container.withdraw', at: { x: number; y: number; z: number }, items: Record<string, number>) {
      const e = { id: ++id, ts: Date.now(), kind, sev: 'info', data: { at, block: 'chest', items } } as unknown as BotEvent;
      for (const f of fns) f(e);
    },
  };
}

function setup(o: { memory?: ChestMemory; events?: ReturnType<typeof fakeEvents>; me?: string | null } = {}) {
  const memory = o.memory ?? new ChestMemory();
  const inv = fakeInventory();
  const hub = new StreamHub({ boot: 'st' });
  hubs.push(hub);
  let mem: ChestMemory | undefined = memory;
  const live = new StorageLive({
    hub,
    source: { memory: () => mem, inventory: () => inv, home: () => ({ x: 0.5, y: 64, z: 0.5, dim: 0 }), bot: () => ({ x: 2.5, y: 64, z: 0.5, dim: 0 }), runAs: () => (o.me === undefined ? 'Owner' : o.me) },
    events: o.events,
    log: silentLogger,
  });
  lives.push(live);
  return { memory, inv, hub, live, swap: (m: ChestMemory | undefined) => (mem = m) };
}

async function serve(hub: StreamHub, live: StorageLive): Promise<string> {
  const { server, port } = await onFetchablePort(
    () => {
      const s = new HealthServer({ port: 0, metrics: new Metrics(), log: silentLogger });
      s.use(hub.route());
      s.use(live.route());
      return s;
    },
    (s) => s.start(),
    (s) => s.stop(),
  );
  servers.push(server);
  return `http://127.0.0.1:${port}`;
}

const json = async <T>(r: Response): Promise<T> => (await r.json()) as T;

describe('storage API (decision 0065)', () => {
  it('GET /api/storage, /search, /container; refusals', async () => {
    const t = setup();
    t.memory.set(rec(4, { diamond: 5, cobblestone: 128 }, { label: 'ores' }));
    t.memory.set(rec(10, { undyed_shulker_box: 1 }, { boxes: { empty: 0, full: 1 }, inBoxes: { diamond: 64 }, boxList: [{ diamond: 64 }] }));
    t.memory.set(rec(20, {}, { size: 0, free: 0, stacks: 0, readAt: 0 }));
    t.inv.put(0, stack('diamond', 2));
    const base = await serve(t.hub, t.live);

    const o = await json<StorageOverview>(await fetch(`${base}/api/storage`));
    expect(o.containers).toMatchObject({ known: 3, read: 2, never: 1, stale: 0 });
    expect(o.me).toBe('Owner');
    expect(o.totals.carried).toBe(2);
    expect(o.never.map((r) => r.x)).toEqual([20]);
    expect(o.byFullness.length).toBe(2);
    expect(o.categories.find((c) => c.id === 'ores')!.items[0]).toEqual(['diamond', 71]);

    const s = await json<StorageSearchAnswer>(await fetch(`${base}/api/storage/search?q=diamonds`));
    expect(s.results[0]).toMatchObject({ name: 'diamond', total: 71, carried: 2, boxed: 64, loose: 5 });
    expect(s.results[0]!.where.map((p) => [p.where, p.x, p.count, p.boxed])).toEqual([
      ['carried', null, 2, 0],
      ['chest', 10, 64, 64],
      ['chest', 4, 5, 0],
    ]);

    const c = await json<StorageContainerAnswer>(await fetch(`${base}/api/storage/container?x=10&y=64&z=0&dim=0`));
    expect(c).toMatchObject({ contents: [['undyed_shulker_box', 1]], inBoxes: [['diamond', 64]], boxList: [[['diamond', 64]]], partner: null });
    expect((await fetch(`${base}/api/storage/container?x=10&y=64&z=0`)).status).toBe(200); // dim defaults to 0
    expect((await fetch(`${base}/api/storage/container?x=10&y=64&z=0&dim=1`)).status).toBe(404);
    expect((await fetch(`${base}/api/storage/container?x=a&y=64&z=0`)).status).toBe(400);
    expect((await fetch(`${base}/api/storage`, { method: 'POST' })).status).toBe(405);
    const long = await json<StorageSearchAnswer>(await fetch(`${base}/api/storage/search?q=${'d'.repeat(200)}`));
    expect(long.q.length).toBe(64);
    expect((await fetch(`${base}/api/storage/search`)).status).toBe(200);
  });

  it('no memory yet: an empty answer, not an error', async () => {
    const t = setup();
    t.swap(undefined);
    const base = await serve(t.hub, t.live);
    const o = await json<StorageOverview>(await fetch(`${base}/api/storage`));
    expect(o.containers.known).toBe(0);
  });
});

describe('storage topic (decision 0065)', () => {
  it('a snapshot, then a delta when the memory changes, the inventory changes, a container event arrives', async () => {
    const ev = fakeEvents();
    const t = setup({ events: ev });
    t.memory.set(rec(4, { diamond: 5 }));
    const base = await serve(t.hub, t.live);
    const s = await openSse(`${base}/api/stream?topics=${STORAGE_TOPIC}`);
    streams.push(s);
    let have = (JSON.parse((await s.next(STORAGE_TOPIC)).data) as { snap: StorageSummary }).snap;
    expect(have.totals).toMatchObject({ items: 5, kinds: 1 });
    const next = async (): Promise<{ bytes: number }> => {
      const m = await s.next(STORAGE_TOPIC, REFRESH_MS + 2000);
      const d = JSON.parse(m.data) as { d?: DeltaOp[]; snap?: StorageSummary };
      have = d.snap ?? (applyDelta(have as unknown as Json, d.d!) as unknown as StorageSummary);
      expect(m.bytes).toBeLessThan(PANEL_BUDGETS.storageDelta);
      return m;
    };

    t.memory.set(rec(4, { diamond: 9, gold_ingot: 3 }));
    await next();
    expect(have.totals).toMatchObject({ items: 12, kinds: 2 });
    expect(have).toEqual(t.live.summary());

    t.inv.put(3, stack('red_shulker_box', 1), boxRaw({ diamond: 10 }));
    await next();
    expect(have.totals.carried).toBe(11);
    expect(t.live.search('diamond').results[0]!.where[0]).toMatchObject({ where: 'carried', count: 10, boxed: 10 });

    ev.emit('container.deposit', { x: 4, y: 64, z: 0 }, { diamond: 4 });
    await next();
    expect(have.recent[0]).toMatchObject({ kind: 'deposit', at: [4, 64, 0], items: [['diamond', 4]] });
    expect(t.live.search('diamonds').recent.diamond![0]).toMatchObject({ kind: 'deposit', n: 4 });
  });

  it('a burst of changes is one refresh; the stored container events are read at start', async () => {
    const stored = [{ id: 7, ts: 1000, kind: 'container.withdraw', sev: 'info', data: { at: { x: 1, y: 2, z: 3 }, items: { coal: 3 } } }, { id: 8, ts: 1001, kind: 'world.time', sev: 'info', data: {} }] as unknown as BotEvent[];
    const t = setup({ events: fakeEvents(stored) });
    await new Promise((r) => setTimeout(r, 10));
    expect(t.live.summary().recent).toEqual([{ id: 7, ts: 1000, kind: 'withdraw', at: [1, 2, 3], block: null, items: [['coal', 3]] }]);
    const before = t.live.stats.refreshes;
    for (let i = 0; i < 20; i++) t.memory.set(rec(i, { stone: i + 1 }));
    await new Promise((r) => setTimeout(r, REFRESH_MS + 100));
    expect(t.live.stats.refreshes - before).toBe(1);
  });

  it('follows a replaced memory and inventory listener; stop unsubscribes', () => {
    const t = setup();
    expect(t.live.summary().containers.known).toBe(0);
    const other = new ChestMemory();
    other.set(rec(1, { coal: 1 }));
    t.swap(other);
    expect(t.live.summary().containers.known).toBe(1);
    const changes = t.live.stats.changes;
    t.memory.set(rec(2, { coal: 1 })); // the old one: no longer followed
    expect(t.live.stats.changes).toBe(changes);
    other.set(rec(3, { coal: 1 }));
    expect(t.live.stats.changes).toBe(changes + 1);
    expect(t.inv.listeners).toBe(1);
    t.live.stop();
    expect(t.inv.listeners).toBe(0);
  });

  it('changeOf and carriedOf', () => {
    expect(changeOf({ id: 1, ts: 2, kind: 'container.deposit', data: { at: { x: 1, y: 2, z: 3 }, block: 'barrel', items: { a: 1, b: 5 } } } as never)).toEqual({ id: 1, ts: 2, kind: 'deposit', at: [1, 2, 3], block: 'barrel', items: [['b', 5], ['a', 1]] });
    expect(changeOf({ id: 1, ts: 2, kind: 'bot.spawn', data: {} } as never)).toBeNull();
    const inv = fakeInventory();
    inv.put(0, stack('minecraft:cobblestone', 64));
    inv.put(1, stack('undyed_shulker_box', 1), boxRaw({ torch: 64 }));
    expect(carriedOf(inv)).toEqual([{ name: 'cobblestone', count: 64 }, { name: 'undyed_shulker_box', count: 1, box: { torch: 64 } }]);
    expect(carriedOf(undefined)).toEqual([]);
  });
});

describe('storage budgets (decision 0065)', () => {
  const measure = (what: string, n: number, budget: number): void => {
    if (process.env.PANEL_MEASURE) console.log(`panel budget: ${what} ${n} bytes (budget ${budget})`);
    expect(n).toBeLessThan(budget);
  };

  /** 512 full containers in each dimension, every slot a different item of the registry, a box in each. */
  function worst() {
    const names = [...itemRegistry().keys()];
    const memory = new ChestMemory({ max: 4096 });
    let k = 0;
    for (let i = 0; i < 512; i++) {
      const contents: Record<string, number> = {};
      for (let j = 0; j < 27; j++) contents[names[k++ % names.length]!] = 64;
      memory.set(rec(100000 + i, contents, { label: `label number ${i}`, inBoxes: { diamond: 64, [names[(k * 7) % names.length]!]: 64 }, boxes: { empty: 0, full: 1 } }));
    }
    const ev = fakeEvents();
    const t = setup({ memory, events: ev });
    for (let i = 0; i < 50; i++) ev.emit('container.deposit', { x: 100000 + i, y: 64, z: 0 }, Object.fromEntries(names.slice(i, i + 12).map((n) => [n, 64])));
    for (let i = 0; i < 20; i++) ev.emit('container.withdraw', { x: 100000 + i, y: 64, z: 0 }, { diamond: 64 });
    return t;
  }

  it('the topic snapshot, a search, GET /api/storage', () => {
    const t = worst();
    measure('storage snapshot (512 containers)', Buffer.byteLength(JSON.stringify(t.live.summary())), PANEL_BUDGETS.storage);
    measure('storage search "diamond"', Buffer.byteLength(JSON.stringify(t.live.search('diamond'))), PANEL_BUDGETS.storageSearch);
    measure('storage search "o" (12 items, 8 places)', Buffer.byteLength(JSON.stringify(t.live.search('o'))), PANEL_BUDGETS.storageSearch);
    measure('GET /api/storage (512 containers)', Buffer.byteLength(JSON.stringify(t.live.overview())), PANEL_BUDGETS.storageFetch);
  });

  it('a delta after a deposit', () => {
    const t = worst();
    const a = t.live.summary();
    t.memory.set(rec(100003, { diamond: 64, emerald: 12 }));
    const b = t.live.summary();
    // the stream sends the delta between the two values (stream.ts); a delta is at most the changed parts
    const changed = Object.keys(b).filter((k) => JSON.stringify((a as never)[k]) !== JSON.stringify((b as never)[k]));
    const bytes = changed.reduce((n, k) => n + Buffer.byteLength(JSON.stringify((b as never)[k])), 0);
    measure('storage delta (a deposit)', bytes, PANEL_BUDGETS.storageDelta);
  });
});
