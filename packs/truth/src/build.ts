// Builder commands (wave 9, Track AL; docs/build.md "Truth commands"). Stable @minecraft/server 2.10.0
// only. Registered by main.ts through `buildHandlers(deps)`.
//
//   blocksdiff x1 y1 z1 x2 y2 z2 <palette> <runs>
//       compare a box with an expected block list in the canonical order of `blocks` (y outermost,
//       then z, then x innermost). <palette> is a comma list of block ids (`air,cobblestone`, the
//       namespace is optional; `*` = any block), <runs> a comma list of `index*count` (`1*75` or
//       `0*3,1*2`; a bare `index` counts 1). The runs must cover the box exactly.
//       -> {from, to, size, count, diffs, first: [{x, y, z, expected, actual}] (at most 20), actual: {typeId: n}}
import type { Block, Dimension } from '@minecraft/server';
import { TruthError, blockPos, box, iterateBox, nsId, type Box, type Vec3 } from './protocol.js';

/** What main.ts lends to these handlers. */
export interface BuildDeps {
  getBlock(dim: Dimension, p: Vec3): Block;
  assertLoaded(dim: Dimension, b: Box): void;
  overworld(): Dimension;
}

type BuildHandler = (args: string[]) => unknown;

/** Largest box `blocksdiff` compares in one tick. */
export const MAX_DIFF_BLOCKS = 32_768;
/** Differences listed in the reply. */
export const MAX_DIFFS_LISTED = 20;

/** Parse `<palette> <runs>` into a flat expected list (namespaced ids, `*` kept). */
export function parseExpected(palette: string | undefined, runs: string | undefined, volume: number): string[] {
  if (!palette || !runs) throw new TruthError('bad_args', 'usage: blocksdiff x1 y1 z1 x2 y2 z2 <palette> <runs>');
  const names = palette.split(',').map((s) => (s === '*' ? '*' : nsId(s.trim())));
  const out: string[] = [];
  for (const part of runs.split(',')) {
    const m = /^(\d+)(?:\*(\d+))?$/.exec(part.trim());
    if (!m) throw new TruthError('bad_args', `bad run "${part}" (index*count)`);
    const name = names[Number(m[1])];
    if (name === undefined) throw new TruthError('bad_args', `run index ${m[1]} outside the palette (${names.length})`);
    const n = m[2] === undefined ? 1 : Number(m[2]);
    if (out.length + n > volume) throw new TruthError('bad_args', `runs cover more than the box (${volume})`);
    for (let k = 0; k < n; k++) out.push(name);
  }
  if (out.length !== volume) throw new TruthError('bad_args', `runs cover ${out.length} blocks, the box has ${volume}`);
  return out;
}

export interface BlockDiff {
  x: number;
  y: number;
  z: number;
  expected: string;
  actual: string;
}

/** Compare expected ids (`*` = any) with the actual ones, both in canonical order over `cells`. */
export function diffBlocks(cells: readonly Vec3[], expected: readonly string[], actual: readonly string[]): { diffs: number; first: BlockDiff[] } {
  let diffs = 0;
  const first: BlockDiff[] = [];
  for (let i = 0; i < cells.length; i++) {
    const e = expected[i]!;
    const a = actual[i]!;
    if (e === '*' || e === a) continue;
    diffs++;
    if (first.length < MAX_DIFFS_LISTED) first.push({ ...cells[i]!, expected: e, actual: a });
  }
  return { diffs, first };
}

export function buildHandlers(deps: BuildDeps): Record<string, BuildHandler> {
  const { getBlock, assertLoaded, overworld } = deps;
  return {
    blocksdiff(args) {
      const b = box(blockPos(args, 0), blockPos(args, 3));
      if (b.volume > MAX_DIFF_BLOCKS) throw new TruthError('volume_too_large', `volume ${b.volume} > ${MAX_DIFF_BLOCKS}`, { volume: b.volume, max: MAX_DIFF_BLOCKS });
      const expected = parseExpected(args[6], args[7], b.volume);
      const dim = overworld();
      assertLoaded(dim, b);
      const cells = [...iterateBox(b)];
      const actual = cells.map((p) => getBlock(dim, p).typeId);
      const counts: Record<string, number> = {};
      for (const a of actual) counts[a] = (counts[a] ?? 0) + 1;
      const { diffs, first } = diffBlocks(cells, expected, actual);
      return { from: b.min, to: b.max, size: b.size, count: cells.length, diffs, first, actual: counts };
    },
  };
}
