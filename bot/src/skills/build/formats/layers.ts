// The JSON layer format (wave 9, Track AL; docs/build.md "Formats"): a structure the owner can write
// by hand.
//
//   { "name": "arch",
//     "layers": [ ["#.#", "#.#"],          // layer 0 = the bottom (y 0); one string per row (z 0, 1, ...)
//                 ["###", "###"] ],        // one character per column (x 0, 1, ...)
//     "legend": { "#": "cobblestone", "p": { "name": "oak_planks" } } }
//
// `.` and ` ` (space) are "no block" (nothing placed, nothing required); every other character must
// be in the legend. Rows may differ in length (missing columns are no block).
import { blockId, isAirName, type BuildBlock } from '../types.ts';
import { StructureError, type Structure } from './mcstructure.ts';

const EMPTY = new Set(['.', ' ']);

type LegendValue = string | { name: string; states?: Record<string, unknown> };

export function readLayers(text: string, fallbackName = 'structure'): Structure {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new StructureError(`${fallbackName}: not JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!raw || typeof raw !== 'object') throw new StructureError(`${fallbackName}: expected an object with "layers" and "legend"`);
  const o = raw as { name?: unknown; layers?: unknown; legend?: unknown };
  const name = typeof o.name === 'string' && o.name ? o.name : fallbackName;
  if (!Array.isArray(o.layers) || o.layers.length === 0) throw new StructureError(`${name}: "layers" must be a non-empty list of layers (lists of row strings)`);
  if (!o.legend || typeof o.legend !== 'object' || Array.isArray(o.legend)) throw new StructureError(`${name}: "legend" must map characters to block names`);
  const legend = new Map<string, { name: string; states?: Record<string, unknown> }>();
  for (const [ch, v] of Object.entries(o.legend as Record<string, LegendValue>)) {
    if ([...ch].length !== 1) throw new StructureError(`${name}: legend key "${ch}" must be one character`);
    if (EMPTY.has(ch)) throw new StructureError(`${name}: "${ch}" is reserved for "no block"`);
    if (typeof v === 'string' && v) legend.set(ch, { name: blockId(v) });
    else if (v && typeof v === 'object' && typeof v.name === 'string' && v.name) legend.set(ch, { name: blockId(v.name), ...(v.states ? { states: v.states } : {}) });
    else throw new StructureError(`${name}: legend "${ch}" must be a block name or { "name": ... }`);
  }
  const blocks: BuildBlock[] = [];
  let sx = 0;
  let sz = 0;
  o.layers.forEach((layer, y) => {
    if (!Array.isArray(layer) || !layer.every((r) => typeof r === 'string')) throw new StructureError(`${name}: layer ${y} must be a list of row strings`);
    sz = Math.max(sz, layer.length);
    layer.forEach((row: string, z) => {
      const chars = [...row];
      sx = Math.max(sx, chars.length);
      chars.forEach((ch, x) => {
        if (EMPTY.has(ch)) return;
        const b = legend.get(ch);
        if (!b) throw new StructureError(`${name}: layer ${y} row ${z} column ${x}: "${ch}" is not in the legend`);
        if (isAirName(b.name)) return;
        blocks.push({ pos: { x, y, z }, name: b.name, ...(b.states ? { states: b.states } : {}) });
      });
    });
  });
  return { name, size: { x: sx, y: o.layers.length, z: sz }, blocks };
}
