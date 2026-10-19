// Writes structures/truth/probe.mcstructure (structure id "truth:probe"), a tiny known structure
// used by the e2e test of `truth:place`. It is also a minimal reference for the .mcstructure format
// (little-endian NBT) if the project later generates scenario structures from code.
//
// Layout, size 3 x 2 x 3 (x, y, z):
//   y=0: oak_planks everywhere except cobblestone at the centre (1,0,1)
//   y=1: oak_log (pillar_axis y) at the centre (1,1,1), air elsewhere
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const nbt = require('prismarine-nbt');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'structures', 'truth', 'probe.mcstructure');

// Block data version 1.21.60.33 (a valid shipped version; newer servers upgrade it on load).
const BLOCK_VERSION = 18168865;
const size = [3, 2, 3];

const palette = [
  { name: 'minecraft:oak_planks', states: {} },
  { name: 'minecraft:cobblestone', states: {} },
  { name: 'minecraft:oak_log', states: { pillar_axis: { type: 'string', value: 'y' } } },
  { name: 'minecraft:air', states: {} },
];

function blockAt(x, y, z) {
  if (y === 0) return x === 1 && z === 1 ? 1 : 0;
  return x === 1 && z === 1 ? 2 : 3;
}

// .mcstructure index order: x outermost, then y, then z innermost.
const layer0 = [];
for (let x = 0; x < size[0]; x++) for (let y = 0; y < size[1]; y++) for (let z = 0; z < size[2]; z++) layer0.push(blockAt(x, y, z));
const layer1 = layer0.map(() => -1); // no waterlogging layer

const intList = (arr) => ({ type: 'list', value: { type: 'int', value: arr } });

const root_ = {
  type: 'compound',
  name: '',
  value: {
    format_version: { type: 'int', value: 1 },
    size: intList(size),
    structure_world_origin: intList([0, 0, 0]),
    structure: {
      type: 'compound',
      value: {
        block_indices: { type: 'list', value: { type: 'list', value: [{ type: 'int', value: layer0 }, { type: 'int', value: layer1 }] } },
        entities: { type: 'list', value: { type: 'compound', value: [] } },
        palette: {
          type: 'compound',
          value: {
            default: {
              type: 'compound',
              value: {
                block_palette: {
                  type: 'list',
                  value: {
                    type: 'compound',
                    value: palette.map((b) => ({
                      name: { type: 'string', value: b.name },
                      states: { type: 'compound', value: b.states },
                      version: { type: 'int', value: BLOCK_VERSION },
                    })),
                  },
                },
                block_position_data: { type: 'compound', value: {} },
              },
            },
          },
        },
      },
    },
  },
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, nbt.writeUncompressed(root_, 'little'));
console.log(`wrote ${out}`);
