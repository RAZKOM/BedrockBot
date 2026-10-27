// Wave 9 Track AG: the chest memory sidecar of the world cache (world/cache/chests.ts): per dimension,
// written atomically with the cache's flush, read lazily, bad records dropped; shulker boxes are
// container marks of the cache (classes.ts).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChestMemory, CHEST_FILE, chestKey, type ChestRecord } from '../../../src/world/cache/chests.ts';
import { isInteresting } from '../../../src/world/cache/classes.ts';
import { WorldCache } from '../../../src/world/cache/cache.ts';

const rec = (x: number, extra: Partial<ChestRecord> = {}): ChestRecord => ({
  x,
  y: -60,
  z: 3,
  kind: 'chest',
  size: 27,
  free: 26,
  stacks: 1,
  contents: { coal: 20 },
  room: { coal: 44 },
  boxes: { empty: 0, full: 0 },
  double: false,
  readAt: 1000 + x,
  ...extra,
});

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'chests-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('ChestMemory', () => {
  it('get / set / delete / near (nearest first) in memory', () => {
    const m = new ChestMemory();
    m.set(rec(10));
    m.set(rec(2, { label: 'ores' }));
    m.set(rec(40));
    expect(m.size).toBe(3);
    expect(m.get({ x: 2.7, y: -60, z: 3.2 })?.label).toBe('ores');
    expect(m.near({ x: 0, y: -60, z: 3 }, 12).map((r) => r.x)).toEqual([2, 10]);
    expect(m.delete({ x: 10, y: -60, z: 3 })).toBe(true);
    expect(m.delete({ x: 10, y: -60, z: 3 })).toBe(false);
    expect(chestKey({ x: 1.5, y: -60, z: -0.5 })).toBe('1,-60,-1');
  });

  it('flushes per dimension and reads back lazily; a bad record is dropped', async () => {
    const dir = tmp();
    let dim = 0;
    const m = new ChestMemory({ dir, dimension: () => dim });
    m.set(rec(1, { partner: { x: 1, y: -60, z: 4 }, double: true, size: 54 }));
    dim = 1;
    m.set(rec(5, { kind: 'barrel' }));
    await m.flush();
    const file = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as { chests: ChestRecord[] };
    expect(file(join(dir, CHEST_FILE)).chests).toHaveLength(1);
    expect(file(join(dir, 'dim1', CHEST_FILE)).chests[0]!.kind).toBe('barrel');
    const back = new ChestMemory({ dir });
    expect(back.get({ x: 1, y: -60, z: 3 })).toEqual(rec(1, { partner: { x: 1, y: -60, z: 4 }, double: true, size: 54 }));
    // a broken record among good ones
    writeFileSync(join(dir, CHEST_FILE), JSON.stringify({ version: 1, chests: [rec(7), { x: 'no' }, { ...rec(8), kind: 3 }] }));
    const again = new ChestMemory({ dir });
    expect(again.all().map((r) => r.x)).toEqual([7]);
    // flushSync and a read-only memory
    again.set(rec(9));
    again.flushSync();
    expect(new ChestMemory({ dir }).size).toBe(2);
    const ro = new ChestMemory({ dir, readOnly: true });
    ro.set(rec(11));
    await ro.flush();
    expect(new ChestMemory({ dir }).size).toBe(2);
  });

  it('keeps at most `max` records (the oldest reads go first)', () => {
    const m = new ChestMemory({ max: 2 });
    m.set(rec(1, { readAt: 5 }));
    m.set(rec(2, { readAt: 1 }));
    m.set(rec(3, { readAt: 9 }));
    expect(m.all().map((r) => r.x).sort()).toEqual([1, 3]);
  });

  it('is part of the world cache and written with its flush', async () => {
    const dir = tmp();
    const c = new WorldCache({ dir, flushIntervalMs: 0 });
    c.chests.set(rec(4));
    await c.flush();
    expect(new ChestMemory({ dir }).get({ x: 4, y: -60, z: 3 })?.contents).toEqual({ coal: 20 });
    c.chests.set(rec(6));
    c.flushSync();
    expect(new ChestMemory({ dir }).size).toBe(2);
  });

  it('shulker boxes are container marks like chests and barrels', () => {
    for (const n of ['chest', 'trapped_chest', 'barrel', 'undyed_shulker_box', 'lime_shulker_box']) expect(isInteresting(n)).toBe(true);
  });
});
