// Track B7 (decision 0132, docs/build.md "Map art"): a sparse litematic read within its limits, the packed words, the
// tiled sections of a sparse build, the progress bitset deflated, the column-top support of the planner, the map grid
// maths and `!build file <name> map`.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nbt from 'prismarine-nbt';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { MAX_READ_BLOCKS, packValues, readLitematic, unpackAt, unpackWord, wordsOf } from '../../../src/skills/build/formats/litematic.ts';
import { MAX_SPARSE_VOLUME, MAX_VOLUME, readJavaNbt } from '../../../src/skills/build/formats/nbt.ts';
import type { Structure } from '../../../src/skills/build/formats/mcstructure.ts';
import { sparseBuild, tiles } from '../../../src/skills/build/job.ts';
import { MAP_COLOUR_DIFFERS, mapArtY, mapColourRefusals, mapCorner, mapLayout, mapText } from '../../../src/skills/build/mapart.ts';
import { planBuild } from '../../../src/skills/build/plan.ts';
import { BuildProgress, loadProgress, PROGRESS_DEFLATE_BYTES } from '../../../src/skills/build/progress.ts';
import { parseSpec } from '../../../src/skills/build/spec.ts';
import { SECTION_CELLS, type BuildBlock, type Cell } from '../../../src/skills/build/types.ts';
import { FLOOR_Y, FlatWorld } from './build-fakes.ts';

const F = FLOOR_Y + 1;

/** A litematic of one region, `size`, palette [air, ...kinds], the cell values given by `value(i)` (0 = air). */
function litematic(size: Cell, kinds: string[], fill: (longs: BigInt64Array, bits: number) => void): Buffer {
  const bits = Math.max(2, 32 - Math.clz32(kinds.length));
  const longs = new BigInt64Array(Math.ceil((size.x * size.y * size.z * bits) / 64));
  fill(longs, bits);
  const pair = (v: bigint): [number, number] => [Number(BigInt.asIntN(32, v >> 32n)), Number(BigInt.asIntN(32, v))];
  const int = (value: number) => ({ type: 'int', value });
  const xyz = (v: Cell) => ({ type: 'compound', value: { x: int(v.x), y: int(v.y), z: int(v.z) } });
  const root = {
    Version: int(6),
    MinecraftDataVersion: int(3955),
    Metadata: { type: 'compound', value: { Name: { type: 'string', value: 'art' }, EnclosingSize: xyz(size) } },
    Regions: {
      type: 'compound',
      value: {
        art: {
          type: 'compound',
          value: {
            Position: xyz({ x: 0, y: 0, z: 0 }),
            Size: xyz(size),
            BlockStatePalette: { type: 'list', value: { type: 'compound', value: ['minecraft:air', ...kinds].map((n) => ({ Name: { type: 'string', value: n } })) } },
            BlockStates: { type: 'longArray', value: Array.from(longs, pair) },
          },
        },
      },
    },
  };
  return gzipSync(nbt.writeUncompressed({ type: 'compound', name: '', value: root } as unknown as nbt.NBT, 'big'));
}

/** Set cell `i` to `v` in packed longs. */
function setCell(longs: BigInt64Array, bits: number, i: number, v: number): void {
  const start = i * bits;
  const a = Math.floor(start / 64);
  const off = BigInt(start % 64);
  longs[a] = BigInt.asIntN(64, BigInt.asUintN(64, longs[a]!) | (BigInt(v) << off));
  if ((start % 64) + bits > 64) longs[a + 1] = BigInt.asIntN(64, BigInt.asUintN(64, longs[a + 1]!) | (BigInt(v) >> (64n - off)));
}

describe('Track B7: a sparse litematic', () => {
  it('reads packed words as unpackAt does, over long boundaries, for 2 to 13 bits', () => {
    for (let bits = 2; bits <= 13; bits++) {
      const values = Array.from({ length: 300 }, (_, i) => (i * 7919 + bits) % (1 << bits));
      const longs = packValues(values, bits);
      // as prismarine-nbt gives longs: [hi, lo] pairs of signed 32-bit ints, or bigints
      const pairs = longs.map((v) => [Number(BigInt.asIntN(32, v >> 32n)), Number(BigInt.asIntN(32, v))]);
      for (const words of [wordsOf(pairs), wordsOf(longs)]) for (let i = 0; i < values.length; i++) expect(unpackWord(words, bits, i)).toBe(unpackAt(longs, bits, i));
    }
  });

  it('reads a map art box of 256 x 145 x 257 with one block a column (over the dense formats limit), quickly', () => {
    const size = { x: 256, y: 145, z: 257 };
    expect(size.x * size.y * size.z).toBeGreaterThan(MAX_VOLUME);
    expect(size.x * size.y * size.z).toBeLessThanOrEqual(MAX_SPARSE_VOLUME);
    const height = (x: number, z: number) => (x * 3 + z * 5) % 145;
    const buf = litematic(size, ['minecraft:stone', 'minecraft:white_wool'], (longs, bits) => {
      for (let z = 0; z < size.z; z++) for (let x = 0; x < size.x; x++) setCell(longs, bits, (height(x, z) * size.z + z) * size.x + x, 1 + ((x + z) & 1));
    });
    const t0 = performance.now();
    const s = readLitematic(buf, 'art');
    const ms = performance.now() - t0;
    expect(s.blocks.length).toBe(size.x * size.z);
    expect(s.size).toEqual(size);
    const at = (x: number, z: number) => s.blocks.find((b) => b.pos.x === x && b.pos.z === z);
    expect(at(10, 20)).toMatchObject({ pos: { x: 10, y: height(10, 20), z: 20 }, name: 'stone' });
    expect(at(11, 20)?.name).toBe('white_wool');
    expect(ms).toBeLessThan(5000);
  });

  it('refuses a box over the sparse limit, and more blocks than it reads, with the reason', () => {
    expect(() => readLitematic(litematic({ x: 1024, y: 64, z: 257 }, ['minecraft:stone'], () => undefined), 'big')).toThrow(/too large/);
    // every cell stone: 0b01 in each 2 bits
    const full = { x: 1024, y: 1, z: Math.ceil((MAX_READ_BLOCKS + 1) / 1024) };
    expect(() => readLitematic(litematic(full, ['minecraft:stone'], (longs) => longs.fill(0x5555555555555555n)), 'full')).toThrow(new RegExp(`more than ${MAX_READ_BLOCKS} blocks`));
  });

  it('refuses NBT that unpacks to more bytes than allowed', () => {
    const buf = litematic({ x: 64, y: 64, z: 64 }, ['minecraft:stone'], () => undefined);
    expect(() => readJavaNbt(buf, 'x', 10_000)).toThrow(/more than 10000 bytes unpacked is too large to read/);
    expect(() => readJavaNbt(buf, 'x')).not.toThrow();
  });
});

describe('Track B7: tiled sections of a sparse build', () => {
  const cells: BuildBlock[] = [];
  for (let z = 0; z < 100; z++) for (let x = 0; x < 100; x++) cells.push({ pos: { x, y: (x + z) % 40, z }, name: 'stone' });
  const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 99, y: 39, z: 99 } };

  it('is sparse for a one-block-a-column footprint over a section, not for a solid box', () => {
    expect(sparseBuild(cells.length, box)).toBe(true);
    expect(sparseBuild(100 * 100 * 40, box)).toBe(false);
    expect(sparseBuild(SECTION_CELLS, { min: { x: 0, y: 0, z: 0 }, max: { x: 63, y: 0, z: 63 } })).toBe(false);
  });

  it('cuts 32 x 32 column tiles from the corner nearest the bot, serpentine, each low to high', () => {
    const t = tiles(cells, box, { x: 99, y: 0, z: 0 }, SECTION_CELLS);
    expect(t.flat().length).toBe(cells.length);
    expect(t.length).toBe(16);
    // the first tile holds the north-east corner's columns
    expect(t[0]!.every((c) => c.pos.x >= 68 && c.pos.z < 32)).toBe(true);
    // the next one is beside it (serpentine), not across the box
    expect(t[1]!.every((c) => c.pos.z < 32)).toBe(true);
    for (const part of t) for (let i = 1; i < part.length; i++) expect(part[i]!.pos.y).toBeGreaterThanOrEqual(part[i - 1]!.pos.y);
    // a section cut at `max`
    expect(Math.max(...tiles(cells, box, { x: 0, y: 0, z: 0 }, 500).map((p) => p.length))).toBeLessThanOrEqual(500);
  });
});

describe('Track B7: the progress bitset of a large box', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-b7-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('is deflated in the file past PROGRESS_DEFLATE_BYTES and reads back the same', () => {
    const file = join(dir, 'p.json');
    const box = { min: { x: 0, y: -60, z: 0 }, max: { x: 255, y: 84, z: 256 } };
    const p = new BuildProgress(file, { args: ['file', 'art', 'map', '0', '-60', '0'], feet: { x: 0, y: -60, z: 0 }, label: 'file art', kind: 'file', box, total: 65_792, fetch: true });
    const marked: Cell[] = [];
    for (let i = 0; i < 2000; i++) marked.push({ x: (i * 37) % 256, y: -60 + (i % 145), z: (i * 91) % 257 });
    for (const c of marked) p.mark(c);
    p.setState('stopped');
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { z?: number; done: string };
    expect(raw.z).toBe(1);
    expect(raw.done.length).toBeLessThan(PROGRESS_DEFLATE_BYTES);
    const back = new BuildProgress(file, loadProgress(file)!);
    for (const c of marked) expect(back.has(c)).toBe(true);
    expect(back.has({ x: 1, y: -59, z: 2 })).toBe(false);
    expect(back.count).toBe(p.count);
  });
});

describe('Track B7: the planner reaches a block high over open ground from a column beside it', () => {
  it('places a lone block 20 up on a scaffold support at the column top, and takes both down', () => {
    const w = new FlatWorld();
    const places: BuildBlock[] = [{ pos: { x: 5, y: F + 20, z: 5 }, name: 'stone' }];
    const p = planBuild(w, { kind: 'file', label: 'file lone', places }, { start: { x: 0, y: F, z: 0 }, maxColumn: 32 });
    expect(p.work).toBe(1);
    expect(p.skipped ?? []).toEqual([]);
    const ops = p.steps.map((s) => s.op);
    expect(ops).toContain('place');
    expect(ops.filter((o) => o === 'scaffold').length).toBe(ops.filter((o) => o === 'unscaffold').length);
  });

  it('places sand only on a block that stays: on the ground or its own column, not over air', () => {
    const w = new FlatWorld();
    const places: BuildBlock[] = [
      { pos: { x: 5, y: F, z: 5 }, name: 'sand' },
      { pos: { x: 5, y: F + 1, z: 5 }, name: 'sand' },
      { pos: { x: 8, y: F + 6, z: 5 }, name: 'white_concrete_powder' },
    ];
    const p = planBuild(w, { kind: 'file', label: 'file sand', places }, { start: { x: 0, y: F, z: 0 }, maxColumn: 32 });
    expect(p.work).toBe(2);
    expect(p.skipped).toEqual([{ pos: { x: 8, y: F + 6, z: 5 }, reason: 'it falls (nothing under it)' }]);
  });
});

describe('Track B7: the map grid', () => {
  it('finds the map square holding x z: from 128 k - 64 to 128 k + 63 (measured the same on Bedrock)', () => {
    expect(mapCorner(0, 0)).toEqual({ x: -64, z: -64 });
    expect(mapCorner(63, 63)).toEqual({ x: -64, z: -64 });
    expect(mapCorner(64, -65)).toEqual({ x: 64, z: -192 });
    expect(mapCorner(41_023, 41_024)).toEqual({ x: 40_896, z: 41_024 });
    expect(mapCorner(-300, -700)).toEqual({ x: -320, z: -704 });
    expect(mapCorner(-64.5, 0.9)).toEqual({ x: -192, z: -64 });
  });

  it('lays a 2 x 2 map art with its noob line north of the first map row', () => {
    const l = mapLayout({ x: 256, z: 257 }, { x: 1984, z: -64 });
    expect(l).toMatchObject({ maps: { x: 2, z: 2 }, noob: true, whole: true, x: 1984, z: -65 });
    expect(mapText(l)).toBe('2x2 maps from 1984 -64, noob line north');
    expect(mapLayout({ x: 128, z: 128 }, { x: 0, z: 0 })).toMatchObject({ noob: false, whole: true, z: 0 });
    expect(mapText(mapLayout({ x: 100, z: 128 }, { x: 0, z: 0 }))).toBe('1x1 map from 0 0, not whole maps');
  });

  it('chooses the y that puts every column above its ground, or says how many columns are unknown', () => {
    const blocks = [
      { pos: { x: 0, y: 0, z: 0 } },
      { pos: { x: 0, y: 5, z: 0 } },
      { pos: { x: 1, y: 3, z: 0 } },
    ];
    // the ground: 10 under the first column, 20 under the second; the second column's lowest block 3 up
    expect(mapArtY(blocks, 100, 100, (x) => (x === 100 ? 10 : 20))).toEqual({ y: 18, unloaded: 0, columns: 2 });
    expect(mapArtY(blocks, 100, 100, (x) => (x === 100 ? 10 : undefined))).toEqual({ y: 11, unloaded: 1, columns: 2 });
  });

  it('refuses the kinds whose Bedrock map colour is not their Java one', () => {
    expect(MAP_COLOUR_DIFFERS.white_wool).toBeUndefined();
    expect(mapColourRefusals([{ name: 'grass_block' }, { name: 'stone' }, { name: 'purple_concrete' }, { name: 'purple_concrete' }])).toEqual([
      { java: 'purple_concrete', count: 2, reason: `another map colour: ${MAP_COLOUR_DIFFERS.purple_concrete}` },
      { java: 'grass_block', count: 1, reason: `another map colour: ${MAP_COLOUR_DIFFERS.grass_block}` },
    ]);
  });
});

describe('Track B7: !build file <name> map', () => {
  /** A 2 x 1 map art of 256 x 3 x 129: a noob line row and one block a column, two of them purple. */
  const art = (purple = false): Structure => {
    const blocks: BuildBlock[] = [];
    for (let z = 0; z < 129; z++) for (let x = 0; x < 256; x++) blocks.push({ pos: { x, y: (x + z) % 3, z }, name: purple && x === 7 && z < 2 ? 'purple_concrete' : 'white_wool' });
    return { name: 'art', size: { x: 256, y: 3, z: 129 }, blocks };
  };
  const err = (r: ReturnType<typeof parseSpec>): string => (r.ok ? '' : r.error);
  const ctx = (s: Structure, ground?: (x: number, z: number) => number | undefined) => ({ feet: { x: 1000, y: 64, z: -10 }, load: () => s, ...(ground ? { ground } : {}) });

  it('puts the first map square on the grid square of the feet, the noob line north, the y over the ground', () => {
    const r = parseSpec(['file', 'art', 'map'], ctx(art(), () => 70));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.label).toBe('file art map at 960 71 -65 (2x1 maps from 960 -64, noob line north)');
    expect(r.args).toEqual(['file', 'art', 'map', '960', '71', '-64']);
    const ys = r.spec.places.map((p) => p.pos.y);
    expect(Math.min(...ys)).toBe(71);
    expect(Math.min(...r.spec.places.map((p) => p.pos.z))).toBe(-65);
    expect(Math.min(...r.spec.places.map((p) => p.pos.x))).toBe(960);
  });

  it('takes x z (any cell of the square), or x y z, and keeps fetch and skip unknown in the resolved args', () => {
    const a = parseSpec(['file', 'art', 'map', '100', '-500', 'fetch'], ctx(art(), () => -61));
    expect(a.ok && a.spec.label).toBe('file art map at 64 -60 -577 (2x1 maps from 64 -576, noob line north)');
    expect(a.ok && a.fetch).toBe(true);
    expect(a.ok && a.args).toEqual(['file', 'art', 'map', '64', '-60', '-576', 'fetch']);
    const b = parseSpec(['file', 'art', 'map', '100', '5', '-500'], ctx(art()));
    expect(b.ok && b.spec.label).toBe('file art map at 64 5 -577 (2x1 maps from 64 -576, noob line north)');
    // the resolved args parse to the same build without the ground
    if (a.ok) {
      const again = parseSpec(a.args!, ctx(art()));
      expect(again.ok && again.spec.label).toBe(a.spec.label);
    }
    const c = parseSpec(['file', 'art', 'map', '~', '~'], ctx(art(), () => 0));
    expect(c.ok && c.spec.label).toMatch(/^file art map at 960 1 -65 /);
  });

  it('refuses without the ground, with unloaded columns, out of the world, and with a rotation', () => {
    expect(parseSpec(['file', 'art', 'map'], ctx(art()))).toEqual({ ok: false, error: 'map: the ground is unknown here; give x y z' });
    expect(err(parseSpec(['file', 'art', 'map'], ctx(art(), (x) => (x < 1000 ? 0 : undefined))))).toMatch(/^map: the ground of \d+ of 33024 columns is not loaded/);
    expect(err(parseSpec(['file', 'art', 'map', '0', '318', '0'], ctx(art())))).toMatch(/outside -64..319/);
    expect(err(parseSpec(['file', 'art', 'map', '90'], ctx(art())))).toMatch(/^usage: file <name> map/);
  });

  it('refuses blocks of another map colour unless skip unknown, then builds without them', () => {
    const r = parseSpec(['file', 'art', 'map', '0', '0', '0'], ctx(art(true)));
    expect(err(r)).toMatch(/^art: 2 blocks have no Bedrock block or map colour: purple_concrete x 2 \(another map colour/);
    const s = parseSpec(['file', 'art', 'map', '0', '0', '0', 'skip', 'unknown'], ctx(art(true)));
    expect(s.ok && s.spec.places.length).toBe(256 * 129 - 2);
    expect(s.ok && s.spec.label).toMatch(/, 2 unknown skipped$/);
    expect(s.ok && s.args).toEqual(['file', 'art', 'map', '-64', '0', '-64', 'skip', 'unknown']);
  });
});
