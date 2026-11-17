// Guard (Track U1, docs/versions.md "1.26.65 and the npm releases"): the block and item tables the world model was
// measured on. Every key the bot loads from minecraft-data (the version shims' registryVersion, the collision shapes,
// the mining table, stack sizes, item names) resolves to minecraft-data's bedrock 1.26.30 data as shipped up to
// 3.118.0. minecraft-data 3.119.0 regenerated the bedrock block and item data (1.26.60: 1480 blocks, 23 960 states,
// 2080 items; obsidian hardness 50 -> 35, ladder bounding box `block` -> `empty`, new item ids) and changed the
// 1.26.30 files as well, so a dependency bump that brings it in changes state ids, shapes, dig times and stack sizes
// at once. This test fails on such a bump: moving to new block data is its own change, with the nav, flight and dig
// e2e suites run again, and these fingerprints updated in the same change.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
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

/** minecraft-data bedrock 1.26.30 (3.117.0 to 3.118.0): 1356 blocks, 16 913 states, 1933 items. */
const MEASURED = {
  counts: [1356, 16913, 1933],
  blocks: '8540470469adc76e',
  blockStates: '0469f10d9356f9bc',
  items: 'a4bf07c0d54b5c2a',
  shapes: 'dd68d407ab285dce',
  materials: '8e7e96ea1c220e58',
};

// data/mining.ts and skills/container/chest.ts load `bedrock_1.26.51` directly.
const KEYS = [...new Set([...SHIMS.map((s) => s.registryVersion), SHAPES_DATA_VERSION, REGISTRY_VERSION, 'bedrock_1.26.51'])];

describe('minecraft-data block and item data the world model was measured on', () => {
  it.each(KEYS)('%s resolves to the measured 1.26.30 tables', (key) => {
    const d = minecraftData(key);
    expect(d, `minecraft-data has no ${key}`).toBeTruthy();
    expect([d!.blocksArray.length, d!.blockStates.length, d!.itemsArray.length]).toEqual(MEASURED.counts);
    expect({
      blocks: fingerprint(d!.blocksArray),
      blockStates: fingerprint(d!.blockStates),
      items: fingerprint(d!.itemsArray),
      shapes: fingerprint(d!.blockCollisionShapes),
      materials: fingerprint(d!.materials),
    }).toEqual({ blocks: MEASURED.blocks, blockStates: MEASURED.blockStates, items: MEASURED.items, shapes: MEASURED.shapes, materials: MEASURED.materials });
  });
});
