// Track AL (docs/build.md "Formats"): the .mcstructure reader (a hand-built fixture, the truth pack's
// probe structure that BDS loads, a write / read round trip), the JSON layer format, rotation and the
// structure lookup.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDirs, loadStructure, placeStructure, readLayers, readMcstructure, StructureError, writeMcstructure } from '../../../src/skills/build/formats/index.ts';
import { mcIndex } from '../../../src/skills/build/formats/mcstructure.ts';
import type { BuildBlock } from '../../../src/skills/build/types.ts';

const FIXTURE = new URL('../fixtures/build/gate.mcstructure', import.meta.url);
const PROBE = new URL('../../../../packs/truth/structures/truth/probe.mcstructure', import.meta.url);
const sortBlocks = (b: readonly BuildBlock[]) => [...b].sort((p, q) => p.pos.x - q.pos.x || p.pos.y - q.pos.y || p.pos.z - q.pos.z);

describe('.mcstructure', () => {
  it('reads the hand-built fixture: size, palette with states, structure void and air skipped', () => {
    // gate.mcstructure: 3 x 3 x 2, written tag by tag with prismarine-nbt (not with writeMcstructure);
    // y0 + y1 cobblestone posts at x 0 and 2 (z 0, 1; (2, 1, 1) structure void), y2 an oak_log beam
    // (pillar_axis x) at z 0 and stone_brick_stairs (weirdo_direction 1) at (1, 2, 1)
    const s = readMcstructure(readFileSync(FIXTURE), 'gate');
    expect(s.size).toEqual({ x: 3, y: 3, z: 2 });
    expect(s.blocks).toHaveLength(11);
    const at = (x: number, y: number, z: number) => s.blocks.find((b) => b.pos.x === x && b.pos.y === y && b.pos.z === z);
    expect(at(0, 0, 0)?.name).toBe('cobblestone');
    expect(at(1, 0, 0)).toBeUndefined();
    expect(at(2, 1, 1)).toBeUndefined();
    expect(at(2, 1, 0)?.name).toBe('cobblestone');
    expect(at(1, 2, 0)).toEqual({ pos: { x: 1, y: 2, z: 0 }, name: 'oak_log', states: { pillar_axis: 'x' } });
    expect(at(1, 2, 1)).toEqual({ pos: { x: 1, y: 2, z: 1 }, name: 'stone_brick_stairs', states: { weirdo_direction: 1, upside_down_bit: 0 } });
    expect(at(0, 2, 1)).toBeUndefined();
  });

  it('reads the truth pack probe structure (the one BDS places with truth:place)', () => {
    const s = readMcstructure(readFileSync(PROBE), 'probe');
    expect(s.size).toEqual({ x: 3, y: 2, z: 3 });
    expect(s.blocks.filter((b) => b.name === 'oak_planks')).toHaveLength(8);
    expect(s.blocks.find((b) => b.name === 'cobblestone')?.pos).toEqual({ x: 1, y: 0, z: 1 });
    expect(s.blocks.find((b) => b.name === 'oak_log')).toEqual({ pos: { x: 1, y: 1, z: 1 }, name: 'oak_log', states: { pillar_axis: 'y' } });
  });

  it('round trip: write then read gives the same blocks', () => {
    const blocks: BuildBlock[] = [
      { pos: { x: 0, y: 0, z: 0 }, name: 'cobblestone' },
      { pos: { x: 3, y: 1, z: 2 }, name: 'oak_log', states: { pillar_axis: 'z' } },
      { pos: { x: 1, y: 4, z: 0 }, name: 'stone_brick_stairs', states: { weirdo_direction: 2, upside_down_bit: true } },
    ];
    const buf = writeMcstructure({ x: 4, y: 5, z: 3 }, blocks);
    const s = readMcstructure(buf, 'rt');
    expect(s.size).toEqual({ x: 4, y: 5, z: 3 });
    // booleans are written as bytes
    expect(sortBlocks(s.blocks)).toEqual(sortBlocks(blocks.map((b) => (b.name === 'stone_brick_stairs' ? { ...b, states: { weirdo_direction: 2, upside_down_bit: 1 } } : b))));
    // and the fixture survives read -> write -> read
    const g = readMcstructure(readFileSync(FIXTURE), 'gate');
    expect(sortBlocks(readMcstructure(writeMcstructure(g.size, g.blocks), 'gate2').blocks)).toEqual(sortBlocks(g.blocks));
  });

  it('index order is x outermost, z innermost', () => {
    expect(mcIndex({ y: 3, z: 2 }, 1, 2, 1)).toBe((1 * 3 + 2) * 2 + 1);
  });

  it('refuses broken files', () => {
    expect(() => readMcstructure(Buffer.from([1, 2, 3]), 'junk')).toThrow(StructureError);
    expect(() => writeMcstructure({ x: 1, y: 1, z: 1 }, [{ pos: { x: 1, y: 0, z: 0 }, name: 'stone' }])).toThrow(/outside/);
  });
});

describe('JSON layers', () => {
  it('layer 0 at the bottom, rows are z, characters are x; . and space are no block', () => {
    const s = readLayers(JSON.stringify({ name: 'arch', layers: [['#.#', '# #'], ['###']], legend: { '#': 'cobblestone' } }));
    expect(s.name).toBe('arch');
    expect(s.size).toEqual({ x: 3, y: 2, z: 2 });
    expect(s.blocks.map((b) => `${b.pos.x}${b.pos.y}${b.pos.z}`)).toEqual(['000', '200', '001', '201', '010', '110', '210']);
  });

  it('legend objects and errors', () => {
    const s = readLayers(JSON.stringify({ layers: [['L']], legend: { L: { name: 'minecraft:oak_log', states: { pillar_axis: 'x' } } } }), 'f');
    expect(s.blocks[0]).toEqual({ pos: { x: 0, y: 0, z: 0 }, name: 'oak_log', states: { pillar_axis: 'x' } });
    expect(() => readLayers('{', 'x')).toThrow(/not JSON/);
    expect(() => readLayers(JSON.stringify({ layers: [['#?']], legend: { '#': 'stone' } }), 'x')).toThrow(/"\?" is not in the legend/);
    expect(() => readLayers(JSON.stringify({ layers: [], legend: {} }), 'x')).toThrow(/layers/);
    expect(() => readLayers(JSON.stringify({ layers: [['.']], legend: { '.': 'stone' } }), 'x')).toThrow(/reserved/);
  });
});

describe('rotation and lookup', () => {
  const s = { size: { x: 3, y: 1, z: 2 }, blocks: [{ pos: { x: 0, y: 0, z: 0 }, name: 'a' }, { pos: { x: 2, y: 0, z: 1 }, name: 'b' }] };
  it('rotates clockwise seen from above and keeps the min corner at the anchor', () => {
    const at = { x: 10, y: -60, z: 20 };
    const p = (rot: 0 | 90 | 180 | 270) => placeStructure(s, at, rot).map((b) => `${b.name}${b.pos.x - 10},${b.pos.z - 20}`);
    expect(p(0)).toEqual(['a0,0', 'b2,1']);
    expect(p(90)).toEqual(['a1,0', 'b0,2']); // east (+x) turns to south (+z)
    expect(p(180)).toEqual(['a2,1', 'b0,0']);
    expect(p(270)).toEqual(['a0,2', 'b1,0']);
  });

  it('finds .mcstructure and .json files in the build folders, first folder first', () => {
    const a = mkdtempSync(join(tmpdir(), 'builds-a-'));
    const b = mkdtempSync(join(tmpdir(), 'builds-b-'));
    try {
      writeFileSync(join(b, 'hut.json'), JSON.stringify({ layers: [['#']], legend: { '#': 'stone' } }));
      writeFileSync(join(a, 'gate.mcstructure'), readFileSync(FIXTURE));
      expect(loadStructure('hut', [a, b]).blocks).toHaveLength(1);
      expect(loadStructure('gate', [a, b]).file).toBe(join(a, 'gate.mcstructure'));
      expect(loadStructure('gate.mcstructure', [a, b]).blocks).toHaveLength(11);
      expect(() => loadStructure('nope', [a, b])).toThrow(/no structure "nope"/);
      expect(() => loadStructure('../x', [a, b])).toThrow(/bad structure name/);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('folders: values.builds, BEDROCKBOT_BUILDS, builds/ next to the config, worlds/', () => {
    const env = { BEDROCKBOT_BUILDS: '/env/builds', BEDROCKBOT_CONFIG: '/cfg/config.json' } as NodeJS.ProcessEnv;
    expect(buildDirs({ builds: '/v' }, env, '/cwd')).toEqual(['/v', '/env/builds', join(dirname(resolve('/cwd', '/cfg/config.json')), 'builds'), join('/cwd', 'worlds')]);
    expect(buildDirs({ 'no-config': true }, {}, '/cwd')).toEqual([join('/cwd', 'worlds')]);
  });
});
