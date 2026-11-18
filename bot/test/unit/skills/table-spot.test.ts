// Track E1 (docs/early-game.md "Craft chains"): where the crafter sets a table down. Measured on a fresh world: a bot
// by the trees it had felled, every cell round its feet leaf litter or leaves and leaves over them, got "no free cell
// next to the bot for a crafting table" from the shulker box's rule (a lid needs an empty cell over it).
import { describe, expect, it } from 'vitest';
import { clearableCover, tableSpots } from '../../../src/skills/craft/table-spot.ts';
import type { BlockInfo, Vec3 } from '../../../src/world/types.ts';

const b = (name: string, solid = false): BlockInfo => ({ name, stateId: 0, states: {}, hardness: solid ? 1 : 0, solid, boxes: solid ? [[0, 0, 0, 1, 1, 1]] : [] });
const AIR = b('air');
const GRASS = b('grass_block', true);
const LEAVES = b('oak_leaves', true);
const LITTER = b('leaf_litter');

function world(cells: Record<string, BlockInfo>, ground = 68): (p: Vec3) => BlockInfo {
  return (p) => cells[`${p.x},${p.y},${p.z}`] ?? (p.y <= ground ? GRASS : AIR);
}
const feet = { x: 15.5, y: 69, z: 45.5 };

describe('table spots (Track E1)', () => {
  it('open ground: the four sides first, no cover', () => {
    const s = tableSpots(world({}), feet);
    expect(s.slice(0, 4).map((x) => x.p)).toEqual([
      { x: 16, y: 69, z: 45 },
      { x: 14, y: 69, z: 45 },
      { x: 15, y: 69, z: 46 },
      { x: 15, y: 69, z: 44 },
    ]);
    expect(s.every((x) => x.cover === undefined)).toBe(true);
  });

  it('leaves over the ring do not matter (a table has no lid)', () => {
    const cells: Record<string, BlockInfo> = {};
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) cells[`${15 + dx},70,${45 + dz}`] = LEAVES;
    expect(tableSpots(world(cells), feet)).toHaveLength(12);
  });

  it('the measured case: leaf litter round the feet is cleared first, leaves and a lower floor are skipped', () => {
    const cells: Record<string, BlockInfo> = {
      '16,69,45': LITTER,
      '14,69,45': LITTER,
      '15,69,44': LITTER,
      '15,69,46': LEAVES,
      '14,69,44': LITTER,
      '16,69,44': LITTER,
      '16,69,46': LEAVES,
      '14,68,46': b('short_grass'), // no full top under 14 69 46
      '14,69,46': AIR,
      '17,68,45': LITTER,
      '13,68,45': LITTER,
      '15,69,43': LITTER,
      '15,69,47': LEAVES,
    };
    const s = tableSpots(world(cells), feet);
    expect(s.length).toBeGreaterThan(0);
    expect(s[0]).toEqual({ p: { x: 16, y: 69, z: 45 }, cover: 'leaf_litter' });
    expect(s.some((x) => x.p.x === 15 && x.p.z === 46)).toBe(false);
    expect(s.some((x) => x.p.x === 14 && x.p.z === 46)).toBe(false);
  });

  it('a free cell is taken before a covered nearer one', () => {
    const s = tableSpots(world({ '16,69,45': LITTER }), feet);
    expect(s[0]!.cover).toBeUndefined();
    expect(s.find((x) => x.cover)?.p).toEqual({ x: 16, y: 69, z: 45 });
  });

  it('covers: plants and litter, never leaves, liquids, containers or a built floor', () => {
    expect(clearableCover(LITTER)).toBe(true);
    expect(clearableCover(b('poppy'))).toBe(true);
    expect(clearableCover(b('pink_petals'))).toBe(true);
    expect(clearableCover(b('oak_leaves'))).toBe(false);
    expect(clearableCover(b('water'))).toBe(false);
    expect(clearableCover(b('chest', true))).toBe(false);
    expect(clearableCover(AIR)).toBe(false);
    const built = tableSpots(world({}), feet, (n) => n === 'grass_block');
    expect(built).toEqual([]);
  });
});
