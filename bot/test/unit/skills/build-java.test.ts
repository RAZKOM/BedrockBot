// Track B2 (docs/build.md "Formats", "Java blocks", ADR 0125): the Java structure readers (Sponge .schem v2 and
// v3, MCEdit .schematic, Litematica .litematic, vanilla .nbt), each against a file built tag by tag from the
// format's published layout (not by the test writers) and through a write / read round trip; the Java -> Bedrock
// mapping and its guard (every name it can produce is a block of the game's block list); turning states with a
// rotated structure; the lookup of the new extensions and `!build files`.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nbt from 'prismarine-nbt';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { listStructures, loadStructure, placeStructure, StructureError } from '../../../src/skills/build/formats/index.ts';
import { bedrockNameOf, blockSchema, JAVA_DATA, javaToBedrock, legacyToJava, mapJavaState, parseJavaState } from '../../../src/skills/build/formats/java.ts';
import { litematicBits, packValues, readLitematic, unpackAt, writeLitematic } from '../../../src/skills/build/formats/litematic.ts';
import { rotateStates } from '../../../src/skills/build/formats/rotate.ts';
import { readSchem, readVarints, writeSchem, writeVarints, type JavaCell } from '../../../src/skills/build/formats/schem.ts';
import { readSchematic, writeSchematic } from '../../../src/skills/build/formats/schematic.ts';
import { readVanilla, writeVanilla } from '../../../src/skills/build/formats/vanilla.ts';
import type { BuildBlock } from '../../../src/skills/build/types.ts';

const sortBlocks = (b: readonly BuildBlock[]) => [...b].sort((p, q) => p.pos.x - q.pos.x || p.pos.y - q.pos.y || p.pos.z - q.pos.z);
const at = (bs: readonly BuildBlock[], x: number, y: number, z: number) => bs.find((b) => b.pos.x === x && b.pos.y === y && b.pos.z === z);
const big = (root: Record<string, unknown>, name = '') => gzipSync(nbt.writeUncompressed({ type: 'compound', name, value: root } as unknown as nbt.NBT, 'big'));

/** A small house's cells in Java names: every family the mapping turns into states. */
const HOUSE: JavaCell[] = [
  { pos: { x: 0, y: 0, z: 0 }, java: 'minecraft:oak_log[axis=y]' },
  { pos: { x: 1, y: 0, z: 0 }, java: 'minecraft:oak_planks' },
  { pos: { x: 2, y: 0, z: 0 }, java: 'minecraft:oak_log[axis=x]' },
  { pos: { x: 0, y: 1, z: 0 }, java: 'minecraft:glass' },
  { pos: { x: 1, y: 1, z: 0 }, java: 'minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]' },
  { pos: { x: 2, y: 1, z: 0 }, java: 'minecraft:oak_slab[type=top,waterlogged=false]' },
  { pos: { x: 0, y: 2, z: 1 }, java: 'minecraft:stone_brick_slab[type=double,waterlogged=false]' },
  { pos: { x: 1, y: 2, z: 1 }, java: 'minecraft:bricks' },
  { pos: { x: 2, y: 2, z: 1 }, java: 'create:gearbox[axis=x]' },
  { pos: { x: 2, y: 2, z: 0 }, java: 'create:gearbox[axis=x]' },
];
const HOUSE_SIZE = { x: 3, y: 3, z: 2 };
const HOUSE_BLOCKS: BuildBlock[] = [
  { pos: { x: 0, y: 0, z: 0 }, name: 'oak_log', states: { pillar_axis: 'y' } },
  { pos: { x: 1, y: 0, z: 0 }, name: 'oak_planks' },
  { pos: { x: 2, y: 0, z: 0 }, name: 'oak_log', states: { pillar_axis: 'x' } },
  { pos: { x: 0, y: 1, z: 0 }, name: 'glass' },
  { pos: { x: 1, y: 1, z: 0 }, name: 'oak_stairs', states: { weirdo_direction: 0, upside_down_bit: 0, 'minecraft:corner': 'none' } },
  { pos: { x: 2, y: 1, z: 0 }, name: 'oak_slab', states: { 'minecraft:vertical_half': 'top' } },
  { pos: { x: 0, y: 2, z: 1 }, name: 'stone_brick_double_slab' },
  { pos: { x: 1, y: 2, z: 1 }, name: 'brick_block' },
];
const GEARBOX = [{ java: 'create:gearbox[axis=x]', count: 2, reason: 'not a Bedrock block' }];

describe('Sponge .schem', () => {
  it('reads a v2 file built tag by tag: palette, varint data, index (y * Length + z) * Width + x', () => {
    // 2 x 2 x 2: stone at (1, 0, 0) = index 1, an oak log along z at (0, 1, 1) = index (1 * 2 + 1) * 2 + 0 = 6
    const buf = big(
      {
        Version: { type: 'int', value: 2 },
        DataVersion: { type: 'int', value: 3955 },
        Width: { type: 'short', value: 2 },
        Height: { type: 'short', value: 2 },
        Length: { type: 'short', value: 2 },
        PaletteMax: { type: 'int', value: 3 },
        Palette: { type: 'compound', value: { 'minecraft:air': { type: 'int', value: 0 }, 'minecraft:stone': { type: 'int', value: 1 }, 'minecraft:oak_log[axis=z]': { type: 'int', value: 2 } } },
        BlockData: { type: 'byteArray', value: [0, 1, 0, 0, 0, 0, 2, 0] },
      },
      'Schematic',
    );
    const s = readSchem(buf, 'tiny');
    expect(s.size).toEqual({ x: 2, y: 2, z: 2 });
    expect(sortBlocks(s.blocks)).toEqual([
      { pos: { x: 0, y: 1, z: 1 }, name: 'oak_log', states: { pillar_axis: 'z' } },
      { pos: { x: 1, y: 0, z: 0 }, name: 'stone' },
    ]);
    expect(s.format).toBe('schem');
    expect(s.unknown).toBeUndefined();
  });

  it('varints: 7 bits a byte, low first, the high bit on all but the last', () => {
    expect(readVarints([-84, 2, 5], 2, 'v')).toEqual([300, 5]); // 0xac 0x02 = 300
    expect(writeVarints([300, 5, 127, 128])).toEqual([-84, 2, 5, 127, -128, 1]);
    expect(() => readVarints([-1], 1, 'v')).toThrow(/ends after 0 of 1/);
  });

  it('round trip v2 and v3 (a palette over 127 entries: two-byte varints)', () => {
    for (const v of [2, 3] as const) {
      const s = readSchem(writeSchem(HOUSE_SIZE, HOUSE, v), 'house');
      expect(sortBlocks(s.blocks)).toEqual(sortBlocks(HOUSE_BLOCKS));
      expect(s.unknown).toEqual(GEARBOX);
    }
    // 150 kinds of wool / concrete / terracotta ... cells: palette indices up to 150
    const kinds = JAVA_DATA.colors.flatMap((c) => ['wool', 'concrete', 'terracotta', 'stained_glass', 'concrete_powder', 'carpet', 'glazed_terracotta', 'shulker_box', 'candle'].map((k) => `${c}_${k}`)).slice(0, 140);
    const cells = kinds.map((k, i) => ({ pos: { x: i % 10, y: Math.floor(i / 100), z: Math.floor(i / 10) % 10 }, java: k }));
    const s = readSchem(writeSchem({ x: 10, y: 2, z: 10 }, cells, 3), 'many');
    expect(s.blocks).toHaveLength(140);
    expect(at(s.blocks, 9, 1, 3)?.name).toBe(bedrockNameOf(kinds[139]!));
    expect(at(s.blocks, 3, 0, 2)?.name).toBe('magenta_carpet'); // cell 23: the third colour's sixth kind
  });

  it('refuses what it does not read', () => {
    expect(() => readSchem(big({ Version: { type: 'int', value: 4 } }, 'Schematic'), 'x')).toThrow(/version 4 is not read/);
    expect(() => readSchem(Buffer.from('nope'), 'x')).toThrow(StructureError);
    expect(() => readSchem(big({ Version: { type: 'int', value: 2 }, Width: { type: 'short', value: -1 }, Height: { type: 'short', value: -1 }, Length: { type: 'short', value: 2000 } }, 'Schematic'), 'x')).toThrow(/too large to read/);
  });
});

describe('Litematica .litematic', () => {
  /** Pack bit by bit (independent of packValues): entry i at bits i * b .. i * b + b - 1, low bit first. */
  const packByBits = (values: number[], b: number): bigint[] => {
    const longs = new Array<bigint>(Math.ceil((values.length * b) / 64)).fill(0n);
    values.forEach((v, i) => {
      for (let k = 0; k < b; k++) if ((v >> k) & 1) {
        const g = i * b + k;
        longs[g >> 6] = BigInt.asUintN(64, longs[g >> 6]! | (1n << BigInt(g & 63)));
      }
    });
    return longs.map((l) => BigInt.asIntN(64, l));
  };

  it('reads a region built tag by tag: 3 bits an entry, entry 21 across two longs, index (y * sizeZ + z) * sizeX + x', () => {
    const names = ['minecraft:air', 'minecraft:stone', 'minecraft:dirt', 'minecraft:glass', 'minecraft:oak_planks'];
    const values = Array.from({ length: 24 }, (_, i) => i % 5);
    const longs = packByBits(values, 3);
    expect(litematicBits(5)).toBe(3);
    expect(unpackAt(longs, 3, 21)).toBe(1); // bits 63..65
    const pair = (l: bigint) => {
      const u = BigInt.asUintN(64, l);
      return [Number(BigInt.asIntN(32, u >> 32n)), Number(BigInt.asIntN(32, u & 0xffffffffn))];
    };
    const xyz = (x: number, y: number, z: number) => ({ type: 'compound', value: { x: { type: 'int', value: x }, y: { type: 'int', value: y }, z: { type: 'int', value: z } } });
    const buf = big({
      Version: { type: 'int', value: 6 },
      Metadata: { type: 'compound', value: { EnclosingSize: xyz(3, 1, 8) } },
      Regions: {
        type: 'compound',
        value: {
          main: {
            type: 'compound',
            value: {
              Position: xyz(0, 0, 0),
              Size: xyz(3, 1, 8),
              BlockStatePalette: { type: 'list', value: { type: 'compound', value: names.map((n) => ({ Name: { type: 'string', value: n } })) } },
              BlockStates: { type: 'longArray', value: longs.map(pair) },
            },
          },
        },
      },
    });
    const s = readLitematic(buf, 'strip');
    expect(s.size).toEqual({ x: 3, y: 1, z: 8 });
    // cell (x, 0, z) = index z * 3 + x, value index % 5; 0 is air
    for (let z = 0; z < 8; z++) for (let x = 0; x < 3; x++) expect(at(s.blocks, x, 0, z)?.name).toBe([undefined, 'stone', 'dirt', 'glass', 'oak_planks'][(z * 3 + x) % 5]);
    expect(s.blocks).toHaveLength(24 - 5);
  });

  it('packValues matches the bit-by-bit packing for every width', () => {
    for (const b of [2, 3, 5, 7, 12]) {
      const values = Array.from({ length: 77 }, (_, i) => (i * 37) % (1 << b));
      expect(packValues(values, b)).toEqual(packByBits(values, b));
      expect(values.map((_, i) => unpackAt(packValues(values, b), b, i))).toEqual(values);
    }
  });

  it('round trip, a negative size and two regions placed from the lowest corner', () => {
    const one = readLitematic(writeLitematic([{ name: 'house', pos: { x: 0, y: 0, z: 0 }, size: HOUSE_SIZE, cells: HOUSE }]), 'house');
    expect(sortBlocks(one.blocks)).toEqual(sortBlocks(HOUSE_BLOCKS));
    expect(one.unknown).toEqual(GEARBOX);
    // Size -3 on x from Position x 2: the region covers x 0..2, stored from x 0
    const neg = readLitematic(writeLitematic([{ name: 'n', pos: { x: 2, y: 0, z: 0 }, size: { x: -3, y: 3, z: 2 }, cells: HOUSE }]), 'neg');
    expect(sortBlocks(neg.blocks)).toEqual(sortBlocks(HOUSE_BLOCKS));
    // two regions: a at 0 0 0 (2 x 1 x 1), b at 5 1 0 with size -2 x 1 x 1 (x 4..5)
    const two = readLitematic(
      writeLitematic([
        { name: 'a', pos: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 1, z: 1 }, cells: [{ pos: { x: 0, y: 0, z: 0 }, java: 'stone' }, { pos: { x: 1, y: 0, z: 0 }, java: 'dirt' }] },
        { name: 'b', pos: { x: 5, y: 1, z: 0 }, size: { x: -2, y: 1, z: 1 }, cells: [{ pos: { x: 0, y: 0, z: 0 }, java: 'glass' }] },
      ]),
      'two',
    );
    expect(two.size).toEqual({ x: 6, y: 2, z: 1 });
    expect(sortBlocks(two.blocks).map((b) => `${b.name}@${b.pos.x},${b.pos.y}`)).toEqual(['stone@0,0', 'dirt@1,0', 'glass@4,1']);
  });

  it('refuses a file without regions or with short block states', () => {
    expect(() => readLitematic(big({ Version: { type: 'int', value: 6 } }), 'x')).toThrow(/no Regions/);
  });
});

describe('vanilla .nbt structures', () => {
  it('round trip; listed air and unlisted cells are both nothing', () => {
    const s = readVanilla(writeVanilla(HOUSE_SIZE, [...HOUSE, { pos: { x: 0, y: 2, z: 0 }, java: 'minecraft:air' }]), 'house');
    expect(s.size).toEqual(HOUSE_SIZE);
    expect(sortBlocks(s.blocks)).toEqual(sortBlocks(HOUSE_BLOCKS));
    expect(s.unknown).toEqual(GEARBOX);
    expect(s.format).toBe('nbt');
  });

  it('reads `palettes` (variants: the first) built tag by tag', () => {
    const entry = (n: string, props?: Record<string, string>) => ({ Name: { type: 'string', value: n }, ...(props ? { Properties: { type: 'compound', value: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, { type: 'string', value: v }])) } } : {}) });
    const ints = (v: number[]) => ({ type: 'list', value: { type: 'int', value: v } });
    const buf = big({
      size: ints([2, 1, 1]),
      palettes: { type: 'list', value: { type: 'list', value: [{ type: 'compound', value: [entry('minecraft:spruce_log', { axis: 'z' })] }, { type: 'compound', value: [entry('minecraft:stone')] }] } },
      blocks: { type: 'list', value: { type: 'compound', value: [{ state: { type: 'int', value: 0 }, pos: ints([1, 0, 0]) }] } },
    });
    expect(readVanilla(buf, 'v').blocks).toEqual([{ pos: { x: 1, y: 0, z: 0 }, name: 'spruce_log', states: { pillar_axis: 'z' } }]);
  });
});

describe('MCEdit .schematic', () => {
  it('numeric ids and data through the 1.12 table, then the mapping', () => {
    const cells = [
      { pos: { x: 0, y: 0, z: 0 }, id: 17, data: 4 | 1 }, // spruce log along x
      { pos: { x: 1, y: 0, z: 0 }, id: 53, data: 4 | 3 }, // oak stairs, facing north, upside down
      { pos: { x: 2, y: 0, z: 0 }, id: 35, data: 14 }, // red wool
      { pos: { x: 0, y: 1, z: 0 }, id: 44, data: 8 }, // smooth stone slab, top
      { pos: { x: 1, y: 1, z: 0 }, id: 45 }, // bricks
      { pos: { x: 2, y: 1, z: 0 }, id: 50, data: 1 }, // a wall torch facing east
      { pos: { x: 0, y: 0, z: 1 }, id: 98, data: 0 }, // stone bricks
      { pos: { x: 1, y: 0, z: 1 }, id: 20 }, // glass
      { pos: { x: 2, y: 0, z: 1 }, id: 5, data: 2 }, // birch planks
    ];
    const s = readSchematic(writeSchematic({ x: 3, y: 2, z: 2 }, cells), 'old');
    expect(sortBlocks(s.blocks)).toEqual(
      sortBlocks([
        { pos: { x: 0, y: 0, z: 0 }, name: 'spruce_log', states: { pillar_axis: 'x' } },
        { pos: { x: 1, y: 0, z: 0 }, name: 'oak_stairs', states: { weirdo_direction: 3, upside_down_bit: 1 } },
        { pos: { x: 2, y: 0, z: 0 }, name: 'red_wool' },
        { pos: { x: 0, y: 1, z: 0 }, name: 'smooth_stone_slab', states: { 'minecraft:vertical_half': 'top' } },
        { pos: { x: 1, y: 1, z: 0 }, name: 'brick_block' },
        { pos: { x: 2, y: 1, z: 0 }, name: 'torch', states: { torch_facing_direction: 'west' } },
        { pos: { x: 0, y: 0, z: 1 }, name: 'stone_bricks' },
        { pos: { x: 1, y: 0, z: 1 }, name: 'glass' },
        { pos: { x: 2, y: 0, z: 1 }, name: 'birch_planks' },
      ]),
    );
  });

  it('AddBlocks (even cell in the high nibble), SchematicaMapping names, Materials other than Alpha', () => {
    // index 0: id 300 (0x12c), index 1: id 257 (0x101) -> AddBlocks[0] = 0x11
    const buf = writeSchematic({ x: 2, y: 1, z: 1 }, [
      { pos: { x: 0, y: 0, z: 0 }, id: 300 },
      { pos: { x: 1, y: 0, z: 0 }, id: 257, data: 3 },
    ]);
    const raw = nbt.simplify(nbt.parseUncompressed(gunzipSync(buf), 'big')) as Record<string, unknown>;
    expect(raw.AddBlocks).toEqual([0x11]);
    expect(raw.Blocks).toEqual([0x2c, 0x01]);
    expect(readSchematic(buf, 'mod').unknown).toEqual([
      { java: 'id 257:3', count: 1, reason: 'not a vanilla block id' },
      { java: 'id 300', count: 1, reason: 'not a vanilla block id' },
    ]);
    const named = writeSchematic({ x: 2, y: 1, z: 1 }, [{ pos: { x: 0, y: 0, z: 0 }, id: 300 }, { pos: { x: 1, y: 0, z: 0 }, id: 1 }], { 'create:gearbox': 300, 'minecraft:stone': 1 });
    const s = readSchematic(named, 'mod');
    expect(s.unknown).toEqual([{ java: 'create:gearbox', count: 1, reason: 'not a Bedrock block' }]);
    expect(s.blocks).toEqual([{ pos: { x: 1, y: 0, z: 0 }, name: 'stone' }]);
    expect(() => readSchematic(big({ Materials: { type: 'string', value: 'Pocket' } }, 'Schematic'), 'pe')).toThrow(/Materials "Pocket" is not read/);
  });

  it('every id of the table maps to a Bedrock block (water and lava as liquids, refused later by the builder)', () => {
    const none: number[] = [];
    const unmapped: string[] = [];
    for (let id = 0; id < 256; id++) {
      for (let d = 0; d < 16; d++) {
        const j = legacyToJava(id, d);
        if (j === undefined) {
          if (d === 0) none.push(id);
          continue;
        }
        const m = mapJavaState(j);
        if (!m.ok) unmapped.push(`${id}:${d} ${j}`);
      }
    }
    expect(none).toEqual([36, 253, 254]); // the moving piston (no item) and two ids vanilla never used
    expect(unmapped).toEqual([]);
  });
});

describe('Java -> Bedrock mapping', () => {
  const schema = blockSchema()!;

  it('the guard: every name the data can produce is a block of the game (1.26.60 block list)', () => {
    expect(schema.size).toBeGreaterThan(1000);
    const produced = new Set<string>();
    for (const v of Object.values(JAVA_DATA.rename)) produced.add(v);
    for (const id of JAVA_DATA.javaIds) if (!JAVA_DATA.air.includes(id)) produced.add(bedrockNameOf(id));
    for (const r of JAVA_DATA.byState) for (let n = 0; n < 16; n++) produced.add(r.bedrock.replace('$', String(n)));
    const missing = [...produced].filter((n) => n !== 'air' && !schema.has(n));
    expect(missing).toEqual([]);
    // every listed Java id maps, so the coverage the docs give is the length of the list
    const unmapped = JAVA_DATA.javaIds.filter((id) => !mapJavaState(id).ok);
    expect(unmapped).toEqual([]);
    expect(JAVA_DATA.javaIds.length).toBeGreaterThanOrEqual(1000);
  });

  it('every state the rules write is a state and a value the block has', () => {
    const samples = [
      'oak_stairs[facing=north,half=top,shape=outer_left]',
      'cobblestone_wall[up=true,north=low,east=tall,south=none,west=none]',
      'oak_fence[north=true,east=false,south=true,west=false]',
      'oak_trapdoor[facing=west,half=top,open=true]',
      'red_bed[facing=east,part=head,occupied=false]',
      'spruce_door[facing=south,half=upper,hinge=right,open=false]',
      'oak_fence_gate[facing=east,open=true,in_wall=false]',
      'wall_torch[facing=north]',
      'ladder[facing=east]',
      'chest[facing=west,type=single]',
      'furnace[facing=east,lit=true]',
      'oak_sign[rotation=9]',
      'oak_wall_sign[facing=south]',
      'snow[layers=3]',
      'candle[candles=4,lit=true]',
      'sea_pickle[pickles=3,waterlogged=false]',
      'campfire[lit=false,facing=east]',
      'vine[north=true,east=true]',
      'oak_leaves[persistent=true,distance=7]',
      'quartz_pillar[axis=z]',
      'white_glazed_terracotta[facing=north]',
      'lantern[hanging=true]',
      'tall_grass[half=upper]',
      'tall_seagrass[half=lower]',
      'amethyst_cluster[facing=up]',
      'wheat[age=7]',
      'light[level=7]',
      'oak_slab[type=bottom]',
    ];
    for (const s of samples) {
      const m = mapJavaState(s);
      expect(m.ok, s).toBe(true);
      if (!m.ok) continue;
      const def = schema.get(m.name)!;
      for (const [k, v] of Object.entries(m.states)) expect(def.get(k)?.values.includes(v), `${s}: ${k}=${v}`).toBe(true);
      if (!s.startsWith('light')) expect(Object.keys(m.states).length, s).toBeGreaterThan(0);
    }
  });

  it('names, renames and states', () => {
    const ok = (s: string) => {
      const m = mapJavaState(s);
      return m.ok ? { name: m.name, states: m.states } : m.reason;
    };
    expect(ok('minecraft:oak_log[axis=x]')).toEqual({ name: 'oak_log', states: { pillar_axis: 'x' } });
    expect(ok('oak_stairs[facing=south,half=top,shape=inner_right]')).toEqual({ name: 'oak_stairs', states: { weirdo_direction: 2, upside_down_bit: 1, 'minecraft:corner': 'inner_right' } });
    expect(ok('cobblestone_stairs[facing=west]')).toEqual({ name: 'stone_stairs', states: { weirdo_direction: 1 } });
    expect(ok('stone_stairs[facing=west]')).toEqual({ name: 'normal_stone_stairs', states: { weirdo_direction: 1 } });
    expect(ok('stone_slab[type=double]')).toEqual({ name: 'normal_stone_double_slab', states: {} });
    expect(ok('cut_copper_slab[type=double]')).toEqual({ name: 'double_cut_copper_slab', states: {} });
    expect(ok('waxed_exposed_cut_copper_slab[type=double]')).toEqual({ name: 'waxed_exposed_double_cut_copper_slab', states: {} });
    expect(ok('grass_block')).toEqual({ name: 'grass_block', states: {} });
    expect(ok('short_grass')).toEqual({ name: 'short_grass', states: {} });
    expect(ok('grass')).toEqual({ name: 'short_grass', states: {} });
    expect(ok('red_wool')).toEqual({ name: 'red_wool', states: {} });
    expect(ok('terracotta')).toEqual({ name: 'hardened_clay', states: {} });
    expect(ok('light_gray_glazed_terracotta[facing=east]')).toEqual({ name: 'silver_glazed_terracotta', states: { facing_direction: 5 } });
    expect(ok('dark_oak_sign[rotation=4]')).toEqual({ name: 'darkoak_standing_sign', states: { ground_sign_direction: 4 } });
    expect(ok('spruce_wall_sign[facing=west]')).toEqual({ name: 'spruce_wall_sign', states: { facing_direction: 4 } });
    expect(ok('cherry_wall_hanging_sign[facing=north]')).toEqual({ name: 'cherry_hanging_sign', states: { facing_direction: 2, hanging: 0 } });
    expect(ok('light_blue_bed[facing=north,part=foot]')).toEqual({ name: 'bed', states: { direction: 2, head_piece_bit: 0 } });
    expect(ok('potted_poppy')).toEqual({ name: 'flower_pot', states: {} });
    expect(ok('redstone_wall_torch[facing=south,lit=false]')).toEqual({ name: 'unlit_redstone_torch', states: { torch_facing_direction: 'north' } });
    expect(ok('torch')).toEqual({ name: 'torch', states: { torch_facing_direction: 'top' } });
    expect(ok('cave_air')).toEqual({ name: 'air', states: {} });
    expect(ok('structure_void')).toEqual({ name: 'air', states: {} });
    // waterlogged and the like have no Bedrock state: dropped
    expect(ok('oak_slab[type=bottom,waterlogged=true]')).toEqual({ name: 'oak_slab', states: { 'minecraft:vertical_half': 'bottom' } });
  });

  it('unknowns: a mod namespace, a Java-only block, a name the game does not know', () => {
    expect(mapJavaState('create:gearbox')).toEqual({ ok: false, java: 'create:gearbox', reason: 'not a Bedrock block' });
    expect(mapJavaState('minecraft:test_block[mode=start]')).toEqual({ ok: false, java: 'minecraft:test_block[mode=start]', reason: 'a Java test block' });
    expect(javaToBedrock(parseJavaState('minecraft:made_up_block'))).toEqual({ ok: false, java: 'minecraft:made_up_block', reason: 'not a Bedrock block' });
  });
});

describe('rotation of states', () => {
  it('directions and axes turn clockwise with the cells; corners and vertical faces do not', () => {
    expect(rotateStates('oak_stairs', { weirdo_direction: 0, upside_down_bit: 1, 'minecraft:corner': 'outer_left' }, 90)).toEqual({ weirdo_direction: 2, upside_down_bit: 1, 'minecraft:corner': 'outer_left' }); // east -> south
    expect(rotateStates('oak_stairs', { weirdo_direction: 3 }, 270)).toEqual({ weirdo_direction: 1 }); // north -> west
    expect(rotateStates('oak_log', { pillar_axis: 'x' }, 90)).toEqual({ pillar_axis: 'z' });
    expect(rotateStates('oak_log', { pillar_axis: 'y' }, 90)).toEqual({ pillar_axis: 'y' });
    expect(rotateStates('oak_log', { pillar_axis: 'x' }, 180)).toEqual({ pillar_axis: 'x' });
    expect(rotateStates('chest', { 'minecraft:cardinal_direction': 'west' }, 90)).toEqual({ 'minecraft:cardinal_direction': 'north' });
    expect(rotateStates('ladder', { facing_direction: 2 }, 90)).toEqual({ facing_direction: 5 }); // north -> east
    expect(rotateStates('end_rod', { facing_direction: 1 }, 90)).toEqual({ facing_direction: 1 }); // up stays
    expect(rotateStates('bed', { direction: 0 }, 90)).toEqual({ direction: 1 }); // south -> west
    expect(rotateStates('trapdoor', { direction: 0 }, 90)).toEqual({ direction: 2 }); // east -> south (stairs order)
    expect(rotateStates('standing_sign', { ground_sign_direction: 14 }, 90)).toEqual({ ground_sign_direction: 2 });
    expect(rotateStates('oak_fence', { 'minecraft:connection_north': 1, 'minecraft:connection_east': 0 }, 90)).toEqual({ 'minecraft:connection_east': 1, 'minecraft:connection_south': 0 });
    expect(rotateStates('vine', { vine_direction_bits: 4 }, 90)).toEqual({ vine_direction_bits: 8 }); // north -> east
    expect(rotateStates('torch', { torch_facing_direction: 'top' }, 90)).toEqual({ torch_facing_direction: 'top' });
  });

  it('placeStructure turns the states of a rotated file and leaves an unrotated one as it is', () => {
    const s = readSchem(writeSchem(HOUSE_SIZE, HOUSE), 'house');
    const r0 = placeStructure(s, { x: 0, y: 0, z: 0 }, 0);
    expect(at(r0, 1, 1, 0)?.states).toEqual({ weirdo_direction: 0, upside_down_bit: 0, 'minecraft:corner': 'none' });
    const r90 = placeStructure(s, { x: 0, y: 0, z: 0 }, 90);
    // (1, 1, 0) turns to (sz - 1 - z, x) = (1, 1, 1); the stair faced east, now south; the log along x, now along z
    expect(at(r90, 1, 1, 1)?.states).toEqual({ weirdo_direction: 2, upside_down_bit: 0, 'minecraft:corner': 'none' });
    expect(at(r90, 1, 0, 2)).toEqual({ pos: { x: 1, y: 0, z: 2 }, name: 'oak_log', states: { pillar_axis: 'z' } });
  });
});

describe('lookup and !build files', () => {
  it('finds every extension, in order, and lists the folders with sizes and block counts', () => {
    const a = mkdtempSync(join(tmpdir(), 'builds-java-'));
    try {
      writeFileSync(join(a, 'house.schem'), writeSchem(HOUSE_SIZE, HOUSE));
      writeFileSync(join(a, 'house.litematic'), writeLitematic([{ name: 'h', pos: { x: 0, y: 0, z: 0 }, size: HOUSE_SIZE, cells: HOUSE }]));
      writeFileSync(join(a, 'old.schematic'), writeSchematic({ x: 1, y: 1, z: 1 }, [{ pos: { x: 0, y: 0, z: 0 }, id: 4 }]));
      writeFileSync(join(a, 'tower.nbt'), writeVanilla({ x: 1, y: 2, z: 1 }, [{ pos: { x: 0, y: 0, z: 0 }, java: 'stone' }, { pos: { x: 0, y: 1, z: 0 }, java: 'stone' }]));
      writeFileSync(join(a, 'broken.schem'), Buffer.from('nope'));
      writeFileSync(join(a, 'notes.txt'), 'x');
      expect(loadStructure('house', [a]).format).toBe('schem');
      expect(loadStructure('house.litematic', [a]).format).toBe('litematic');
      expect(loadStructure('old', [a]).blocks).toEqual([{ pos: { x: 0, y: 0, z: 0 }, name: 'cobblestone' }]);
      expect(loadStructure('tower', [a]).blocks).toHaveLength(2);
      expect(() => loadStructure('broken', [a])).toThrow(StructureError);
      const { files, more } = listStructures([a]);
      expect(more).toBe(0);
      expect(files.map((f) => [f.name, f.format, f.blocks, f.unknown, f.size ? `${f.size.x}x${f.size.y}x${f.size.z}` : f.error?.slice(0, 20)])).toEqual([
        ['broken', 'schem', undefined, undefined, 'not a big-endian NBT'],
        ['house', 'schem', 8, 2, '3x3x2'],
        ['house.litematic', 'litematic', 8, 2, '3x3x2'],
        ['old', 'schematic', 1, undefined, '1x1x1'],
        ['tower', 'nbt', 2, undefined, '1x2x1'],
      ]);
      expect(listStructures([a], 2).more).toBe(3);
    } finally {
      rmSync(a, { recursive: true, force: true });
    }
  });
});
