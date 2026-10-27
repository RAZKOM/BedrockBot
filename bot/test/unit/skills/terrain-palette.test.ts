// Wave 9, Track AK (decision 0031): the terrain layer on the BDS 1.26.60 palette's own state ids
// (bot/data/block-palette/1.26.60.json; states minecraft-data 1.26.30 lacks get ids from 16913 up).
//   - every palette-only door, trapdoor, fence gate, stairs and slab state gets the state-dependent shape
//     of its minecraft-data relative with the same states (by name suffix), not the registry's borrowed one;
//   - fences, panes and bars with `minecraft:connection_*` states take their arms from the states,
//     not from the neighbours; minecraft-data fences (no such states) still look at the neighbours.
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../../src/log.ts';
import { armsOf, classify } from '../../../src/skills/terrain/classify.ts';
import { boxesAtCell } from '../../../src/skills/terrain/query.ts';
import { blockInfoOf, CONNECT_EAST, CONNECT_NORTH, CONNECT_WEST, connectedBoxes, doorBoxes, partialBoxes } from '../../../src/skills/terrain/shapes.ts';
import { BlockRegistry } from '../../../src/world/registry.ts';
import type { BlockInfo } from '../../../src/world/types.ts';
import { recordedLogin } from '../world/helpers.ts';

const MD_STATES = 16913;

function registry(): BlockRegistry {
  const { startGame, itemRegistry } = recordedLogin();
  const reg = new BlockRegistry({ version: '1.26.60', logger: silentLogger });
  reg.handleStartGame(startGame);
  reg.handleItemRegistry(itemRegistry);
  return reg;
}

/** The minecraft-data block whose states a palette-only block of this name shares. */
function relative(name: string): string | undefined {
  if (name.endsWith('_door') && !name.endsWith('trapdoor')) return 'wooden_door';
  if (name.endsWith('_trapdoor')) return 'trapdoor';
  if (name.endsWith('_fence_gate')) return 'fence_gate';
  if (name.endsWith('_stairs')) return 'oak_stairs';
  if (name.endsWith('_double_slab')) return 'oak_double_slab';
  if (name.endsWith('_slab')) return 'oak_slab';
  return undefined;
}

describe('palette-only partial blocks: state-dependent shapes by name suffix', () => {
  const reg = registry();
  const info = (name: string, states?: Record<string, unknown>): BlockInfo => reg.blockInfo(reg.stateIdOf(name, states)!);

  it('poplar door, trapdoor, gate, stairs and slab (palette ids) have the shape of their states', () => {
    const door = info('poplar_door', { 'minecraft:cardinal_direction': 'east', door_hinge_bit: 1, open_bit: 1, upper_block_bit: 0 });
    expect(door.stateId).toBeGreaterThanOrEqual(MD_STATES);
    // minecraft-data has one door box for every state (what the registry borrows); the panel follows the states
    expect(classify(door).boxes).toEqual(doorBoxes(door.states));
    expect(classify(door).boxes).not.toEqual(door.boxes);
    expect(classify(door).boxes).toEqual(classify(blockInfoOf('wooden_door', { 'minecraft:cardinal_direction': 'east', door_hinge_bit: 1, open_bit: 1 })).boxes);
    const closed = info('poplar_door', { 'minecraft:cardinal_direction': 'north', open_bit: 0, upper_block_bit: 0 });
    expect(classify(closed).boxes).toEqual(classify(blockInfoOf('wooden_door', { 'minecraft:cardinal_direction': 'north' })).boxes);

    const trap = info('poplar_trapdoor', { direction: 2, open_bit: 1 });
    expect(trap.stateId).toBeGreaterThanOrEqual(MD_STATES);
    expect(classify(trap).boxes).toEqual(classify(blockInfoOf('trapdoor', { direction: 2, open_bit: 1 })).boxes);
    expect(classify(info('poplar_trapdoor', { upside_down_bit: 1, open_bit: 0 })).boxes).toEqual([[0, 0.8175, 0, 1, 1, 1]]); // Bedrock trapdoors are 0.1825 thick

    expect(classify(info('poplar_fence_gate', { open_bit: 1 })).boxes).toEqual([]);
    expect(classify(info('poplar_fence_gate', { open_bit: 0 })).top).toBe(1.5);

    expect(classify(info('poplar_slab', { 'minecraft:vertical_half': 'top' })).boxes).toEqual([[0, 0.5, 0, 1, 1, 1]]);
    expect(classify(info('poplar_double_slab')).boxes).toEqual([[0, 0, 0, 1, 1, 1]]);
    const stairs = info('poplar_stairs', { weirdo_direction: 1, upside_down_bit: 1, 'minecraft:corner': 'none' });
    expect(classify(stairs).boxes).toEqual(classify(blockInfoOf('oak_stairs', { weirdo_direction: 1, upside_down_bit: 1 })).boxes);
  });

  it('every palette-only door, trapdoor, gate, stairs and slab state matches its minecraft-data relative with the same states', () => {
    let n = 0;
    const kinds = new Set<string>();
    for (let id = MD_STATES; id < reg.stateCount; id++) {
      const b = reg.blockInfo(id);
      const rel = relative(b.name);
      if (!rel) continue;
      const relStates = blockInfoOf(rel).states;
      // the relative's state with the same values (doors: each half by its own states; stairs: corners by stairBoxes)
      const want = Object.fromEntries(Object.entries(b.states).filter(([k]) => k in relStates));
      const relBoxes = rel === 'oak_stairs' ? partialBoxes('oak_stairs', b.states)! : classify(blockInfoOf(rel, want)).boxes;
      expect(classify(b).boxes, `${b.name} ${JSON.stringify(b.states)}`).toEqual(relBoxes);
      kinds.add(rel);
      n++;
    }
    console.log(`[terrain-palette] ${n} palette-only partial-block states checked (${[...kinds].join(', ')})`);
    expect(kinds.size).toBe(6);
    expect(n).toBeGreaterThan(1000);
  });

  it('other blocks keep minecraft-data shapes or the borrowed boxes', () => {
    expect(partialBoxes('poplar_planks', {})).toBeUndefined();
    expect(partialBoxes('oak_fence', {})).toBeUndefined();
    expect(classify(info('poplar_planks')).boxes).toEqual([[0, 0, 0, 1, 1, 1]]);
    // a minecraft-data state keeps its data shape
    expect(classify(info('oak_slab', { 'minecraft:vertical_half': 'top' })).boxes).toEqual([[0, 0.5, 0, 1, 1, 1]]);
  });
});

describe('fence and pane arms from the connection states', () => {
  const reg = registry();
  const info = (name: string, states?: Record<string, unknown>): BlockInfo => reg.blockInfo(reg.stateIdOf(name, states)!);
  const stone = blockInfoOf('stone');
  const air = blockInfoOf('air');

  it('reads CONNECT_* bits from minecraft:connection_*, undefined without them', () => {
    expect(armsOf({ 'minecraft:connection_east': 1, 'minecraft:connection_west': 0, 'minecraft:connection_north': 0, 'minecraft:connection_south': 0 })).toBe(CONNECT_EAST);
    expect(armsOf({ 'minecraft:connection_north': true, 'minecraft:connection_west': 1 })).toBe(CONNECT_NORTH | CONNECT_WEST);
    expect(armsOf({ 'minecraft:connection_north': 0 })).toBe(0);
    expect(armsOf({})).toBeUndefined();
  });

  it('a palette fence / pane uses its states, not its neighbours', () => {
    const fence = info('oak_fence', { 'minecraft:connection_east': 1 });
    const c = classify(fence);
    expect(c).toMatchObject({ connect: 'fence', arms: CONNECT_EAST, top: 1.5 });
    expect(c.boxes).toEqual(connectedBoxes('fence', CONNECT_EAST));
    // stone north and west of it, nothing east: the server's states win
    const at = (x: number, _y: number, z: number): BlockInfo | undefined => (x === 0 && z === 0 ? fence : (x === -1 && z === 0) || (x === 0 && z === -1) ? stone : air);
    expect(boxesAtCell({ blockAt: at }, 0, 0, 0)).toEqual(connectedBoxes('fence', CONNECT_EAST));
    const pane = classify(info('glass_pane', { 'minecraft:connection_east': 1, 'minecraft:connection_west': 1 }));
    expect(pane).toMatchObject({ connect: 'pane', arms: CONNECT_EAST | CONNECT_WEST, top: 1 });
    expect(classify(info('poplar_fence')).arms).toBe(0);
  });

  it('a minecraft-data fence (no connection states) still takes its arms from the neighbours', () => {
    const fence = blockInfoOf('oak_fence');
    expect(classify(fence).arms).toBeUndefined();
    const at = (x: number, _y: number, z: number): BlockInfo | undefined => (x === 0 && z === 0 ? fence : x === -1 && z === 0 ? stone : air);
    expect(boxesAtCell({ blockAt: at }, 0, 0, 0)).toEqual(connectedBoxes('fence', CONNECT_WEST));
  });
});
