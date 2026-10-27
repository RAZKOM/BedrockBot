// Wave 8, Track AC (decision 0024): the 1.26.60 runtime-id table from the BDS palette dump
// (bot/data/block-palette/1.26.60.json, tools/bump-version/dump-palette.mjs). Checks the file, the fast
// hash, that every recorded runtime id resolves (0 unknown), that states minecraft-data has keep their
// state ids, and what the palette-only states look like to the world model and the terrain layer.
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../../src/log.ts';
import { classify } from '../../../src/skills/terrain/classify.ts';
import { resolveNewerState, stairBoxes, STAIRS_CORNER } from '../../../src/skills/terrain/shapes.ts';
import { BlockRegistry, blockHash, UNKNOWN_BLOCK_RUNTIME_ID } from '../../../src/world/registry.ts';
import { decodeSubChunk } from '../../../src/world/subchunk.ts';
import { fastBlockHash, loadPalette, palettePath, shapeDonor } from '../../../src/world/version-shims/palette.ts';
import { shimFor } from '../../../src/world/version-shims/index.ts';
import { decodedInbound, FIXTURE_VERSION, recordedLogin } from './helpers.ts';

/** Dump facts (BDS 1.26.60.6, 2026-10-29): 1480 block types; the Script API offers 66053 permutations, 23941 after dropping the legacy states the network hash leaves out. */
const TYPES = 1480;
const PERMUTATIONS = 23941;
/** minecraft-data 1.26.30's block states; palette states it lacks get ids from here up. */
const MD_STATES = 16913;
const EXTRA = 7664;

function registry(version = '1.26.60'): BlockRegistry {
  const { startGame, itemRegistry } = recordedLogin();
  const reg = new BlockRegistry({ version, logger: silentLogger });
  reg.handleStartGame(startGame);
  reg.handleItemRegistry(itemRegistry);
  return reg;
}

describe('block palette 1.26.60 (registry from the BDS dump)', () => {
  const palette = loadPalette('1.26.60')!;

  it('loads the checked-in dump keyed by version, and only for versions that have one', () => {
    expect(palette).toBeDefined();
    expect(palettePath('1.26.60')).toMatch(/bot[\\/]data[\\/]block-palette[\\/]1\.26\.60\.json$/);
    expect(palette.version).toBe('1.26.60');
    expect(palette.bds).toBe('1.26.60.6');
    expect(palette.types).toBe(TYPES);
    expect(palette.entries).toHaveLength(PERMUTATIONS);
    expect(new Set(palette.entries.map((e) => e.name)).size).toBe(TYPES);
    expect(palette.entries.filter((e) => e.isDefault)).toHaveLength(TYPES);
    expect(loadPalette('1.26.51')).toBeUndefined();
    expect(shimFor('1.26.60')?.blockPalette).toBe('1.26.60');
    expect(shimFor('1.26.51')?.blockPalette).toBeUndefined();
    console.log(`[palette] 1.26.60: ${palette.types} types, ${palette.entries.length} states, loaded in ${palette.loadMs.toFixed(1)} ms`);
  });

  it('fastBlockHash equals the prismarine-nbt hash (blockHash) for every state', () => {
    for (const e of palette.entries) expect(fastBlockHash(e.name, e.states), e.name).toBe(blockHash(e.name, e.states));
  });

  it('every palette state resolves to its own name and states; minecraft-data states keep their ids', () => {
    const reg = registry();
    expect(reg.stateCount).toBe(MD_STATES + EXTRA);
    expect(reg.extraStateCount).toBe(EXTRA);
    let kept = 0;
    for (const e of palette.entries) {
      const rid = fastBlockHash(e.name, e.states);
      const s = reg.stateIdFromRuntimeId(rid);
      expect(s, e.name).toBeGreaterThanOrEqual(0);
      expect(reg.nameOf(s)).toBe(e.name);
      expect(reg.runtimeIdOf(s)).toBe(rid);
      expect(blockHash(e.name, reg.typedStatesOf(s)!)).toBe(rid);
      if (s < MD_STATES) kept++;
    }
    expect(kept).toBe(PERMUTATIONS - EXTRA);
    expect(reg.unknownRuntimeIds.size).toBe(0);
  });

  it(`resolves every runtime id of the recorded ${FIXTURE_VERSION} world (0 unknown)`, () => {
    const reg = registry(FIXTURE_VERSION);
    const seen = new Set<number>();
    for (const p of decodedInbound('world-chunks.jsonl.gz')) {
      if (p.name === 'update_block') seen.add((p.params.block_runtime_id as number) | 0);
      if (p.name === 'subchunk') {
        for (const e of p.params.entries as { result: string; payload?: Buffer }[]) {
          if (e.result !== 'success' || !e.payload) continue;
          decodeSubChunk(e.payload, (rid) => {
            seen.add(rid);
            return reg.stateIdFromRuntimeId(rid);
          });
        }
      }
    }
    expect(seen.size).toBeGreaterThan(3);
    for (const rid of seen) expect(reg.stateIdFromRuntimeId(rid), String(rid)).toBeGreaterThanOrEqual(0);
    expect(reg.unknownRuntimeIds.size).toBe(0);
  });

  it('knows 1.26.60 stairs with minecraft:corner (the hash BDS sends for a plain oak staircase)', () => {
    const reg = registry();
    const s = reg.stateIdFromRuntimeId(-122484237);
    expect(s).toBeGreaterThanOrEqual(MD_STATES);
    const info = reg.blockInfo(s);
    expect(info).toMatchObject({ name: 'oak_stairs', states: { [STAIRS_CORNER]: 'none', upside_down_bit: 0, weirdo_direction: 0 }, hardness: 2, solid: true });
    expect(info.boxes).toHaveLength(2);
    // a bare name gives the server's default state, with the new state
    expect(reg.stateIdOf('oak_stairs')).toBe(s);
    expect(reg.blockInfo(reg.stateIdOf('oak_stairs', { [STAIRS_CORNER]: 'outer_left', weirdo_direction: 2 })!).states).toEqual({ [STAIRS_CORNER]: 'outer_left', upside_down_bit: 0, weirdo_direction: 2 });
    // minecraft-data-only state names still resolve (fallback)
    expect(reg.stateIdOf('oak_log', { pillar_axis: 'x' })).toBeLessThan(MD_STATES);
  });

  it('maps runtime id -2 (how BDS 1.26.60.6 sends minecraft:unknown) to the unknown block', () => {
    const reg = registry();
    const s = reg.stateIdFromRuntimeId(UNKNOWN_BLOCK_RUNTIME_ID);
    expect(UNKNOWN_BLOCK_RUNTIME_ID).toBe(-2);
    expect(reg.blockInfo(s)).toMatchObject({ name: 'unknown', solid: true });
    expect(reg.unknownRuntimeIds.size).toBe(0);
  });

  it('terrain classes: stairs from the palette match the stairs special case (resolveNewerState), now redundant', () => {
    const reg = registry();
    let n = 0;
    for (const [name] of [...new Set(palette.entries.map((e) => e.name))].map((x) => [x])) {
      if (!name!.endsWith('_stairs') || !reg.stateIdOf(name!)) continue;
      for (const e of palette.entries.filter((x) => x.name === name)) {
        const rid = fastBlockHash(e.name, e.states);
        const info = reg.blockInfo(reg.stateIdFromRuntimeId(rid));
        expect(classify(info).boxes).toEqual(stairBoxes(info.states));
        // what the terrain layer made of the same id while it was unknown (Track AA special case)
        const old = resolveNewerState(reg.unknownInfo(rid));
        if (old) expect(classify(info).boxes).toEqual(classify(reg.unknownInfo(rid)).boxes);
        n++;
      }
    }
    expect(n).toBeGreaterThan(3000);
  });

  it('palette-only states borrow hardness and shapes; new blocks without a relative are full solid cubes', () => {
    const reg = registry();
    const info = (name: string, states?: Record<string, unknown>) => reg.blockInfo(reg.stateIdOf(name, states)!);
    // fences, panes and fire gained minecraft:connection_* (were unknown, 1.5-high obstacles, before)
    const fence = info('oak_fence', { 'minecraft:connection_east': 1 });
    expect(fence.name).toBe('oak_fence');
    expect(fence.stateId).toBeGreaterThanOrEqual(MD_STATES);
    expect(Math.max(...fence.boxes.map((b) => b[4]))).toBe(1.5);
    expect(classify(fence).connect).toBe('fence');
    expect(classify(fence).unknown).toBe(false);
    expect(info('glass_pane').stateId).toBeGreaterThanOrEqual(MD_STATES);
    expect(info('fire').solid).toBe(false);
    // new 1.26.60 blocks: shape donors
    expect(shapeDonor('poplar_planks')).toBe('oak_planks');
    expect(info('poplar_planks')).toMatchObject({ name: 'poplar_planks', hardness: 2, solid: true, boxes: [[0, 0, 0, 1, 1, 1]] });
    const slab = info('white_wool_slab', { 'minecraft:vertical_half': 'bottom' });
    expect(slab.boxes).toEqual([[0, 0, 0, 1, 0.5, 1]]);
    expect(classify(info('poplar_door')).openable).toBe('door');
    expect(info('poplar_sapling').solid).toBe(false);
    // no relative: a full solid cube, as unknown ids were (but with the real name)
    expect(info('icicle')).toMatchObject({ name: 'icicle', solid: true, hardness: -1, boxes: [[0, 0, 0, 1, 1, 1]] });
  });

  it('without a palette (1.26.51) the table is minecraft-data alone', () => {
    const reg = registry('1.26.51');
    expect(reg.palette).toBeUndefined();
    expect(reg.stateCount).toBe(MD_STATES);
    expect(reg.blockDataSource).toBe('minecraft-data 1.26.30');
    expect(reg.stateIdFromRuntimeId(-122484237)).toBe(-1);
  });

  it('builds the table in well under a tick-sized budget per state', () => {
    const t0 = performance.now();
    registry();
    const ms = performance.now() - t0;
    console.log(`[palette] registry build (prismarine + palette): ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(2000);
  });
});
