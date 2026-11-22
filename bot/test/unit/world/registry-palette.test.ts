// Wave 8, Track AC (decision 0024): the 1.26.60 runtime-id table from the BDS palette dump
// (bot/data/block-palette/1.26.60.json, tools/bump-version/dump-palette.mjs). Checks the file, the fast
// hash, that every recorded runtime id resolves (0 unknown), that states the block data has keep their
// state ids, and what palette-only states look like to the world model and the terrain layer. Since decision 0094
// the block data (minecraft-data 3.119.0, bedrock 1.26.60) holds every state of the 1.26.60 dump; palette-only
// states are those of other versions (1.26.51's, from minecraft-data's own 1.26.51 states).
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
/** The block data's states (minecraft-data 3.119.0, bedrock 1.26.60); palette states it lacks get ids from here up. */
const MD_STATES = 23960;
/** States of the 1.26.60 dump the block data lacks (7664 with minecraft-data 1.26.30's tables, before decision 0094). */
const EXTRA = 0;
/** minecraft-data's own 1.26.51 states the block data lacks: fire and redstone wire without connection states, a bare chorus plant. */
const EXTRA_1_26_51 = 33;

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
    expect(reg.blockDataStates).toBe(MD_STATES);
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
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(MD_STATES); // a block data state since decision 0094
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

  it('1.26.60 blocks the 1.26.30 data lacked are block data states with their own shapes and hardness', () => {
    const reg = registry();
    const info = (name: string, states?: Record<string, unknown>) => reg.blockInfo(reg.stateIdOf(name, states)!);
    // fences, panes and fire with minecraft:connection_* (unknown ids before Track AC, borrowed shapes before 0094)
    const fence = info('oak_fence', { 'minecraft:connection_east': 1 });
    expect(fence.name).toBe('oak_fence');
    expect(fence.stateId).toBeLessThan(MD_STATES);
    expect(Math.max(...fence.boxes.map((b) => b[4]))).toBe(1.5);
    expect(classify(fence).connect).toBe('fence');
    expect(classify(fence).unknown).toBe(false);
    expect(info('glass_pane').stateId).toBeLessThan(MD_STATES);
    expect(info('fire').solid).toBe(false);
    expect(info('poplar_planks')).toMatchObject({ name: 'poplar_planks', hardness: 2, solid: true, boxes: [[0, 0, 0, 1, 1, 1]] });
    const slab = info('white_wool_slab', { 'minecraft:vertical_half': 'bottom' });
    expect(slab.hardness).toBe(0.8);
    expect(classify(slab).boxes).toEqual([[0, 0, 0, 1, 0.5, 1]]);
    expect(classify(info('poplar_door')).openable).toBe('door');
    expect(info('poplar_sapling').solid).toBe(false);
    // blocks that had no relative were full solid cubes; the block data has their shapes now
    expect(info('icicle')).toMatchObject({ name: 'icicle', hardness: 0.5 });
    expect(classify(info('icicle')).fullCube).toBe(false);
  });

  it('palette-only states (1.26.51: minecraft-data own states) borrow hardness and shapes from the closest block data state', () => {
    const reg = registry('1.26.51');
    expect(reg.palette?.bds).toBe('minecraft-data bedrock_1.26.51');
    expect(reg.blockDataSource).toBe('palette 1.26.51 (minecraft-data bedrock_1.26.51)');
    expect(reg.extraStateCount).toBe(EXTRA_1_26_51);
    // fire without the 1.26.60 connection states: palette-only, borrows a fire state (no collision)
    const fire = reg.blockInfo(reg.stateIdOf('fire', { age: 3 })!);
    expect(fire.stateId).toBeGreaterThanOrEqual(MD_STATES);
    expect(reg.nameOf(reg.baseStateOf(fire.stateId))).toBe('fire');
    expect(fire).toMatchObject({ name: 'fire', states: { age: 3 }, solid: false });
    const chorus = reg.blockInfo(reg.stateIdOf('chorus_plant')!);
    expect(chorus.stateId).toBeGreaterThanOrEqual(MD_STATES);
    expect(chorus).toMatchObject({ name: 'chorus_plant', hardness: 0.4, solid: true });
    // the ids are the process's: a 1.26.60 registry built after it keeps them and does not reuse them
    const again = registry('1.26.51');
    expect(again.stateIdOf('fire', { age: 3 })).toBe(fire.stateId);
    expect(registry().stateIdFromRuntimeId(blockHash('fire', reg.typedStatesOf(fire.stateId)!))).toBe(-1);
    expect(registry().nameOf(fire.stateId)).toBe('fire');
    // shape donors by name suffix, for new blocks of a future dump
    expect(shapeDonor('poplar_planks')).toBe('oak_planks');
    expect(shapeDonor('icicle')).toBeUndefined();
  });

  it('the version is read at each build: one registry follows a reconnect that speaks another version', () => {
    let version = '1.26.60';
    const { startGame, itemRegistry } = recordedLogin();
    const reg = new BlockRegistry({ version: () => version, logger: silentLogger });
    reg.handleStartGame(startGame);
    reg.handleItemRegistry(itemRegistry);
    expect(reg.version).toBe('1.26.60');
    expect(reg.extraStateCount).toBe(EXTRA);
    version = '1.26.51';
    reg.handleStartGame(startGame);
    expect(reg.version).toBe('1.26.51');
    expect(reg.shim.gameVersions).toContain('1.26.51');
    expect(reg.extraStateCount).toBe(EXTRA_1_26_51);
    expect(reg.unknownRuntimeIds.size).toBe(0);
  });

  // Track REL3: its time (under 2 s) is checked in the perf project (test/perf/registry.perf.test.ts)
  it('builds the table again from scratch, every recorded id resolved', () => {
    expect(registry().unknownRuntimeIds.size).toBe(0);
  });
});

describe('block palette 1.26.70 (the preview dump on the 1.26.60 block data, Track U2)', () => {
  const palette = loadPalette('1.26.70');

  it.skipIf(!palette)('new blocks of 1.26.70: walls take the wall shape, stairs and slabs theirs, other new blocks are solid cubes the digger leaves', () => {
    const reg = new BlockRegistry({ version: '1.26.70', logger: silentLogger });
    reg.handleStartGame({ block_network_ids_are_hashes: true, itemstates: [] } as never);
    reg.handleItemRegistry({ itemstates: [] });
    expect(reg.extraStateCount).toBeGreaterThan(1000);
    const info = (name: string, states?: Record<string, unknown>) => reg.blockInfo(reg.stateIdOf(name, states)!);
    const arms = { wall_connection_type_east: 'tall', wall_connection_type_north: 'none', wall_connection_type_south: 'short', wall_connection_type_west: 'none', wall_post_bit: 1 };
    const wall = info('snow_brick_wall', arms);
    expect(wall.stateId).toBeGreaterThanOrEqual(reg.blockDataStates);
    expect(wall.boxes).toEqual(info('cobblestone_wall', arms).boxes);
    expect(classify(wall).top).toBe(1.5);
    expect(classify(info('calcite_wall')).top).toBe(1.5);
    const stairs = info('polished_calcite_stairs', { weirdo_direction: 1, upside_down_bit: 0, 'minecraft:corner': 'outer_left' });
    expect(classify(stairs).boxes).toEqual(stairBoxes({ weirdo_direction: 1, upside_down_bit: 0, 'minecraft:corner': 'outer_left' }));
    expect(classify(info('packed_ice_brick_slab', { 'minecraft:vertical_half': 'bottom' })).top).toBe(0.5);
    const bricks = info('snow_bricks');
    expect(classify(bricks)).toMatchObject({ top: 1, fullCube: true, unknown: false });
    expect(bricks.hardness).toBe(-1);
    expect(shapeDonor('snow_brick_wall')).toBe('cobblestone_wall');
    expect(shapeDonor('brittle_ice')).toBeUndefined();
  });
});
