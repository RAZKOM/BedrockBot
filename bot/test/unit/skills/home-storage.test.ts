// Decision 0065 (docs/storage.md): the storage index (skills/home/storage.ts) and its search
// (skills/home/search.ts): totals per item over every dimension and what the bot carries, where each item
// is (loose or in a shulker box, distances), freshness, categories, fullness; the search's words,
// plurals, groups, aliases and ranking; the chest memory's change hook and its dimensions.
import { describe, expect, it } from 'vitest';
import { ChestMemory, type ChestRecord } from '../../../src/world/cache/chests.ts';
import { stockLine } from '../../../src/skills/home/memory.ts';
import { stockTotals } from '../../../src/skills/home/stock.ts';
import { buildStorageIndex, STALE_MS, storageKey } from '../../../src/skills/home/storage.ts';
import { itemRegistry, parseQuery, queryGroup, scoreItem, searchStorage, singulars } from '../../../src/skills/home/search.ts';

const NOW = 1_000_000_000_000;
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
  readAt: NOW - 60_000,
  ...extra,
});

/** Two chests near home (one holds a shulker box of diamonds), a stale barrel, one never opened, a nether chest. */
function world() {
  const a = rec(4, { diamond: 5, cobblestone: 128, oak_log: 20 }, { label: 'ores' });
  const b = rec(10, { undyed_shulker_box: 1, iron_ingot: 40 }, { boxes: { empty: 0, full: 1 }, inBoxes: { diamond: 64, emerald: 3 }, boxList: [{ diamond: 64, emerald: 3 }] });
  const c = rec(30, { bread: 12, cooked_beef: 9, iron_pickaxe: 1 }, { kind: 'barrel', readAt: NOW - STALE_MS - 1 });
  const d = rec(40, {}, { size: 0, free: 0, stacks: 0, readAt: 0 });
  const n = rec(2, { quartz: 30, gold_nugget: 9 }, { stacks: 26, free: 1 });
  return { a, b, c, d, n, dims: [{ dim: 0, records: [a, b, c, d] }, { dim: 1, records: [n] }] };
}

describe('storage index (decision 0065)', () => {
  it('totals per item: loose, in boxes, carried (carried shulker contents included), over every dimension', () => {
    const w = world();
    const idx = buildStorageIndex({ dims: w.dims, carried: [{ name: 'diamond', count: 3 }, { name: 'red_shulker_box', count: 1, box: { diamond: 10, torch: 64 } }], home: { x: 0.5, y: 64, z: 0.5, dim: 0 }, now: NOW });
    const d = idx.items.get('diamond')!;
    expect(d).toMatchObject({ total: 5 + 64 + 13, loose: 5, boxed: 64, carried: 13, places: 2, category: 'ores' });
    expect(idx.items.get('torch')).toMatchObject({ total: 64, carried: 64, places: 0 });
    expect(idx.items.get('quartz')).toMatchObject({ total: 30, places: 1 });
    expect(idx.carried).toEqual({ diamond: 13, red_shulker_box: 1, torch: 64 });
    expect(idx.carriedBoxed).toEqual({ diamond: 10, torch: 64 });
    expect(idx.totals()).toEqual({ items: [...idx.items.values()].reduce((a, t) => a + t.total, 0), kinds: idx.items.size, carried: 78 });
  });

  it('where: the bot first, then containers by count; box flagged; distances only in the same dimension', () => {
    const w = world();
    const idx = buildStorageIndex({ dims: w.dims, carried: [{ name: 'diamond', count: 3 }], home: { x: 0.5, y: 64, z: 0.5, dim: 0 }, bot: { x: 10.5, y: 64, z: 0.5, dim: 1 }, now: NOW });
    const places = idx.where('diamond');
    expect(places.map((p) => [p.where, p.x, p.count, p.loose, p.boxed])).toEqual([
      ['carried', null, 3, 3, 0],
      ['chest', 10, 64, 0, 64],
      ['chest', 4, 5, 5, 0],
    ]);
    expect(places[1]!.distHome).toBeCloseTo(10, 0);
    expect(places[1]!.distBot).toBeNull(); // the bot is in the nether
    const q = idx.where('quartz')[0]!;
    expect(q).toMatchObject({ dim: 1, distHome: null, key: storageKey(1, w.n) });
    expect(q.distBot).toBeCloseTo(8, 0);
  });

  it('freshness: read, never opened, stale, unreachable; per dimension; partners counted once', () => {
    const w = world();
    const half = rec(5, {}, { double: true, size: 54 }); // the record naming a partner is the container; the partner is left out
    w.a.double = true;
    w.a.size = 54;
    w.a.partner = { x: 5, y: 64, z: 0 };
    w.c.unreachable = 'no path';
    const idx = buildStorageIndex({ dims: [{ dim: 0, records: [...w.dims[0]!.records, half] }, w.dims[1]!], now: NOW });
    expect(idx.freshness).toMatchObject({ known: 5, read: 4, never: 1, stale: 1, unreachable: 1, dims: { 0: 4, 1: 1 } });
    expect(idx.freshness.oldestReadAt).toBe(w.c.readAt);
    expect(idx.containers.find((c) => c.x === 40)!.fresh).toBe('never');
    expect(idx.containers.find((c) => c.x === 30)!.fresh).toBe('stale');
  });

  it('categories biggest first; containers by fullness; one container by key', () => {
    const w = world();
    const idx = buildStorageIndex({ dims: w.dims, now: NOW });
    const cats = idx.categories();
    expect(cats.map((c) => c.id)).toEqual([...cats].sort((a, b) => b.total - a.total || a.id.localeCompare(b.id)).map((c) => c.id));
    expect(cats.find((c) => c.id === 'ores')!.items[0]).toEqual(['diamond', 69]);
    expect(idx.byFullness()[0]!.dim).toBe(1); // 26 of 27 slots
    expect(idx.byFullness().some((c) => c.x === 40)).toBe(false); // never opened: no fullness
    expect(idx.container(0, { x: 10, y: 64, z: 0 })!.container).toMatchObject({ loose: 41, boxed: 67 });
    expect(idx.container(2, { x: 10, y: 64, z: 0 })).toBeUndefined();
  });

  it('agrees with !stock: the same totals (stock.ts), and stockLine words them unchanged', () => {
    const w = world();
    const idx = buildStorageIndex({ dims: [w.dims[0]!], now: NOW });
    const t = stockTotals(w.dims[0]!.records);
    for (const [k, v] of Object.entries(t)) expect(idx.items.get(k)!.loose + idx.items.get(k)!.boxed).toBe(v);
    expect(Object.keys(t).sort()).toEqual([...idx.items.keys()].sort());
    expect(stockLine({ all: () => w.dims[0]!.records }, 'diamond')).toBe('diamond: 64 in chest 10 64 0 (all in boxes), 5 in chest 4 64 0 (ores) (69 in all)');
  });
});

describe('storage search (decision 0065)', () => {
  const idx = (): ReturnType<typeof buildStorageIndex> => {
    const w = world();
    return buildStorageIndex({ dims: w.dims, carried: [{ name: 'oak_planks', count: 8 }, { name: 'iron_sword', count: 1 }], home: { x: 0.5, y: 64, z: 0.5, dim: 0 }, now: NOW });
  };

  it('plurals and singulars', () => {
    expect(singulars('diamonds')).toContain('diamond');
    expect(singulars('torches')).toContain('torch');
    expect(singulars('berries')).toContain('berry');
    expect(parseQuery('Iron Ingots').forms).toContain('iron_ingot');
    expect(parseQuery('minecraft:diamond').name).toBe('diamond');
  });

  it('"diamonds" finds both places with the right counts, the box flagged', () => {
    const s = searchStorage(idx(), 'diamonds');
    expect(s.results[0]).toMatchObject({ name: 'diamond', total: 69, loose: 5, boxed: 64, score: 100, stack: 64 });
    expect(s.results[0]!.where.map((p) => [p.x, p.count, p.boxed])).toEqual([
      [10, 64, 64],
      [4, 5, 0],
    ]);
    expect(s.none).toBeNull();
  });

  it('common words: iron, logs, wood, ores, food, tools, armour, shulker', () => {
    const names = (q: string): string[] => searchStorage(idx(), q).results.map((r) => r.name);
    expect(names('iron')[0]).toBe('iron_ingot'); // the alias first, then iron_pickaxe / iron_sword by word
    expect(names('iron')).toEqual(expect.arrayContaining(['iron_pickaxe', 'iron_sword']));
    expect(names('logs')).toEqual(['oak_log']);
    expect(names('wood')).toEqual(expect.arrayContaining(['oak_log', 'oak_planks']));
    expect(names('ores')).toEqual(expect.arrayContaining(['diamond', 'iron_ingot', 'quartz', 'emerald']));
    expect(names('food')).toEqual(expect.arrayContaining(['bread', 'cooked_beef']));
    expect(names('tools')).toEqual(expect.arrayContaining(['iron_pickaxe', 'iron_sword']));
    expect(names('shulker')).toEqual(['undyed_shulker_box']);
    expect(names('steak')[0]).toBe('cooked_beef');
    expect(searchStorage(idx(), 'ores').group).toMatchObject({ id: 'ores' });
  });

  it('ranking: exact over alias over group over prefix over words over typing over substring', () => {
    const q = parseQuery('iron');
    expect(scoreItem('iron_ingot', q)).toBeGreaterThan(scoreItem('iron_sword', q));
    expect(scoreItem('diamond', parseQuery('diam'))).toBe(60);
    expect(scoreItem('diamond_pickaxe', parseQuery('pick'))).toBe(35);
    expect(scoreItem('stripped_oak_log', parseQuery('ak_lo'))).toBe(20);
    expect(scoreItem('cobblestone', parseQuery('xyz'))).toBe(0);
    expect(queryGroup(parseQuery('shulkers'))!.id).toBe('shulker');
  });

  it('none: a real item that is not stored says so; unknown words just find nothing', () => {
    const s = searchStorage(idx(), 'netherite ingot');
    expect(s.none).toBe('netherite_ingot');
    expect(s.containers).toBe(5);
    expect(searchStorage(idx(), 'zzzz')).toMatchObject({ none: null, results: [] });
  });

  it('limits: results and places', () => {
    const s = searchStorage(idx(), 'o', 2, 1);
    expect(s.results.length).toBe(2);
    expect(s.more).toBeGreaterThan(0);
    const d = searchStorage(idx(), 'diamond', 12, 1).results[0]!;
    expect(d.where.length).toBe(1);
    expect(d.morePlaces).toBe(1);
  });

  it('reads the item registry (display names)', () => {
    expect(itemRegistry().get('cooked_beef')).toBe('Steak');
  });
});

describe('chest memory hooks (decision 0065)', () => {
  it('onChange fires on set and on a real delete; byDimension lists 0, 1, 2', () => {
    let dim = 0;
    const m = new ChestMemory({ dimension: () => dim });
    const seen: string[] = [];
    const off = m.onChange((d, p) => seen.push(`${d}:${p.x}`));
    m.set(rec(4, { diamond: 1 }));
    dim = 1;
    m.set(rec(7, {}));
    m.delete({ x: 7, y: 64, z: 0 });
    m.delete({ x: 99, y: 64, z: 0 }); // nothing there: no change
    expect(seen).toEqual(['0:4', '1:7', '1:7']);
    expect(m.byDimension().map((d) => [d.dim, d.records.length])).toEqual([
      [0, 1],
      [1, 0],
      [2, 0],
    ]);
    off();
    m.set(rec(8, {}));
    expect(seen.length).toBe(3);
  });
});
