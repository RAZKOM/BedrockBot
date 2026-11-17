// Guard (Track U1, moved to new data by Track U2, decision 0094): the block and item tables the world model was
// measured on. Every module reads minecraft-data's block and item data through one key (data/blockData.ts: the
// world registry's state ids, the collision shapes, the mining table, stack sizes, item names), and that key resolves
// to minecraft-data 3.119.0's regenerated bedrock 1.26.60 data (1480 blocks, 23 960 states, 2080 items; materials
// from bedrock/1.26.51), measured against BDS 1.26.65.1 (docs/versions.md "minecraft-data 3.119.0"). A dependency
// bump that changes these tables changes state ids, shapes, dig times and stack sizes at once, so this test fails on
// it: moving to new block data is its own change. Diff the bot's view (bot/scripts/data-view.ts dump before and after,
// then diff), measure it on BDS (e2e data-truth and dig), run the nav and flight suites again, and update these
// fingerprints in the same change.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { BLOCK_DATA_KEY, BLOCK_DATA_VERSION, NEWER_ITEM_STACKS } from '../../../src/data/blockData.ts';
import { maxStackOf } from '../../../src/skills/container/chest.ts';
import { REGISTRY_VERSION } from '../../../src/skills/home/search.ts';
import { SHAPES_DATA_VERSION } from '../../../src/skills/terrain/shapes.ts';
import { SHIMS } from '../../../src/world/version-shims/index.ts';

const require = createRequire(import.meta.url);

interface Md {
  blocksArray: unknown[];
  blockStates: unknown[];
  itemsArray: unknown[];
  blockCollisionShapes: unknown;
  materials: unknown;
}
const minecraftData = require('minecraft-data') as (v: string) => Md | null;

const fingerprint = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16);

/** minecraft-data 3.119.0 bedrock 1.26.60: 1480 blocks, 23 960 states, 2080 items. */
const MEASURED = {
  counts: [1480, 23960, 2080],
  blocks: 'b94a85012925bf13',
  blockStates: 'd516bea3abd2923b',
  items: 'ac0cfd51e7731f9c',
  shapes: 'ee497776947c3e4c',
  materials: '51fbaddc12a2e6c7',
};

describe('minecraft-data block and item data the world model was measured on', () => {
  it('every module reads the one block data key', () => {
    expect(BLOCK_DATA_KEY).toBe(`bedrock_${BLOCK_DATA_VERSION}`);
    expect(SHAPES_DATA_VERSION).toBe(BLOCK_DATA_KEY);
    expect(REGISTRY_VERSION).toBe(BLOCK_DATA_KEY);
    // the shims name only where the server's states come from, never another block or item table
    for (const s of SHIMS) expect(Object.keys(s)).not.toContain('registryVersion');
  });

  it(`${BLOCK_DATA_KEY} resolves to the measured tables`, () => {
    const d = minecraftData(BLOCK_DATA_KEY);
    expect(d, `minecraft-data has no ${BLOCK_DATA_KEY}`).toBeTruthy();
    expect([d!.blocksArray.length, d!.blockStates.length, d!.itemsArray.length]).toEqual(MEASURED.counts);
    expect({
      blocks: fingerprint(d!.blocksArray),
      blockStates: fingerprint(d!.blockStates),
      items: fingerprint(d!.itemsArray),
      shapes: fingerprint(d!.blockCollisionShapes),
      materials: fingerprint(d!.materials),
    }).toEqual({ blocks: MEASURED.blocks, blockStates: MEASURED.blockStates, items: MEASURED.items, shapes: MEASURED.shapes, materials: MEASURED.materials });
  });

  it('stack sizes measured for items newer than the block data are only for items it lacks', () => {
    const names = new Set((minecraftData(BLOCK_DATA_KEY)!.itemsArray as { name: string }[]).map((i) => i.name));
    for (const [name, stack] of Object.entries(NEWER_ITEM_STACKS)) {
      expect(names.has(name), ` is in : drop it from NEWER_ITEM_STACKS`).toBe(false);
      expect(maxStackOf(name)).toBe(stack);
    }
    expect(maxStackOf('minecraft:ice_ball')).toBe(16);
  });
});
