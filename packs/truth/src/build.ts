// Builder commands (wave 9, Track AL; docs/build.md "Truth commands"). Stable @minecraft/server 2.10.0
// only. Registered by main.ts through `buildHandlers(deps)`.
//
//   blocksdiff x1 y1 z1 x2 y2 z2 <palette> <runs>
//       compare a box with an expected block list in the canonical order of `blocks` (y outermost,
//       then z, then x innermost). <palette> is a comma list of block ids (`air,cobblestone`, the
//       namespace is optional; `*` = any block), <runs> a comma list of `index*count` (`1*75` or
//       `0*3,1*2`; a bare `index` counts 1). The runs must cover the box exactly.
//       Track B1 (decision 0124): a palette entry may name states, `oak_stairs[weirdo_direction=1;upside_down_bit=0]`:
//       those states are compared too (the others are not); true / false and 1 / 0 are the same value.
//       -> {from, to, size, count, diffs, first: [{x, y, z, expected, actual}] (at most 20), actual: {typeId: n}}
//          (`actual` of a state difference carries the compared states: `minecraft:oak_stairs[weirdo_direction=2]`)
//   blockstates x1 y1 z1 x2 y2 z2
//       Track B1: every block of a box (at most 4096) with all its states, in the canonical order
//       -> {from, to, size, order: 'yzx', palette: [{typeId, states}], runs: [[index, count]]}
import type { Block, Dimension } from '@minecraft/server';
import { RleEncoder, TruthError, blockPos, box, iterateBox, nsId, type Box, type Vec3 } from './protocol.js';

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
/** Largest box `blockstates` reads (answered in the same tick, like `blocks`). */
export const MAX_STATE_BLOCKS = 4096;

type StateValue = string | number | boolean;

/** One expected cell: an id (`*` = any) and the states to compare (none: the id only). */
export interface Expected {
  id: string;
  states?: Record<string, string>;
}

/** `name` or `name[k=v;k=v]` -> Expected (namespaced id; `*` kept). */
export function parseEntry(s: string): Expected {
  const t = s.trim();
  if (t === '*') return { id: '*' };
  const m = /^([^[\]]+)(?:\[([^\]]*)\])?$/.exec(t);
  if (!m) throw new TruthError('bad_args', `bad palette entry "${s}" (name or name[k=v;k=v])`);
  const id = nsId(m[1]!.trim());
  if (m[2] === undefined) return { id };
  const states: Record<string, string> = {};
  for (const part of m[2].split(';')) {
    if (!part.trim()) continue;
    const eq = part.indexOf('=');
    if (eq <= 0) throw new TruthError('bad_args', `bad state "${part}" in "${s}" (k=v)`);
    states[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return { id, states };
}

/** Parse `<palette> <runs>` into a flat expected list (namespaced ids, `*` kept). */
export function parseExpected(palette: string | undefined, runs: string | undefined, volume: number): string[] {
  return parseExpectedStates(palette, runs, volume).map((e) => (e.states ? `${e.id}[${Object.entries(e.states).map(([k, v]) => `${k}=${v}`).join(';')}]` : e.id));
}

/** parseExpected with the states of each entry. */
export function parseExpectedStates(palette: string | undefined, runs: string | undefined, volume: number): Expected[] {
  if (!palette || !runs) throw new TruthError('bad_args', 'usage: blocksdiff x1 y1 z1 x2 y2 z2 <palette> <runs>');
  const entries = palette.split(',').map(parseEntry);
  const out: Expected[] = [];
  for (const part of runs.split(',')) {
    const m = /^(\d+)(?:\*(\d+))?$/.exec(part.trim());
    if (!m) throw new TruthError('bad_args', `bad run "${part}" (index*count)`);
    const e = entries[Number(m[1])];
    if (e === undefined) throw new TruthError('bad_args', `run index ${m[1]} outside the palette (${entries.length})`);
    const n = m[2] === undefined ? 1 : Number(m[2]);
    if (out.length + n > volume) throw new TruthError('bad_args', `runs cover more than the box (${volume})`);
    for (let k = 0; k < n; k++) out.push(e);
  }
  if (out.length !== volume) throw new TruthError('bad_args', `runs cover ${out.length} blocks, the box has ${volume}`);
  return out;
}

/** A state value as text for comparing: booleans and 0 / 1 bytes alike (`1` / `0`). */
export function stateText(v: unknown): string {
  if (v === true || v === 'true') return '1';
  if (v === false || v === 'false') return '0';
  return String(v);
}

export interface BlockDiff {
  x: number;
  y: number;
  z: number;
  expected: string;
  actual: string;
}

/** An actual block as the comparison sees it. */
export interface Actual {
  typeId: string;
  states?: Readonly<Record<string, StateValue>>;
}

const entryText = (e: Expected): string => (e.states ? `${e.id}[${Object.entries(e.states).map(([k, v]) => `${k}=${v}`).join(';')}]` : e.id);

/** Some state of `want` that `have` does not match. */
function stateMismatch(want: Record<string, string>, have: Readonly<Record<string, StateValue>> | undefined): boolean {
  for (const [k, v] of Object.entries(want)) if (stateText(have?.[k]) !== stateText(v)) return true;
  return false;
}

/**
 * Compare expected ids (`*` = any) with the actual ones, both in canonical order over `cells`. A string list is
 * the old form (ids only); Expected / Actual entries compare the listed states too.
 */
export function diffBlocks(cells: readonly Vec3[], expected: readonly (string | Expected)[], actual: readonly (string | Actual)[]): { diffs: number; first: BlockDiff[] } {
  let diffs = 0;
  const first: BlockDiff[] = [];
  for (let i = 0; i < cells.length; i++) {
    const e: Expected = typeof expected[i] === 'string' ? { id: expected[i] as string } : (expected[i] as Expected);
    const a: Actual = typeof actual[i] === 'string' ? { typeId: actual[i] as string } : (actual[i] as Actual);
    if (e.id === '*') continue;
    const same = e.id === a.typeId && (!e.states || !stateMismatch(e.states, a.states));
    if (same) continue;
    diffs++;
    if (first.length < MAX_DIFFS_LISTED) {
      const shown = e.states && e.id === a.typeId ? `${a.typeId}[${Object.keys(e.states).map((k) => `${k}=${stateText(a.states?.[k])}`).join(';')}]` : a.typeId;
      first.push({ ...cells[i]!, expected: entryText(e), actual: shown });
    }
  }
  return { diffs, first };
}

export function buildHandlers(deps: BuildDeps): Record<string, BuildHandler> {
  const { getBlock, assertLoaded, overworld } = deps;
  return {
    blocksdiff(args) {
      const b = box(blockPos(args, 0), blockPos(args, 3));
      if (b.volume > MAX_DIFF_BLOCKS) throw new TruthError('volume_too_large', `volume ${b.volume} > ${MAX_DIFF_BLOCKS}`, { volume: b.volume, max: MAX_DIFF_BLOCKS });
      const expected = parseExpectedStates(args[6], args[7], b.volume);
      const dim = overworld();
      assertLoaded(dim, b);
      const cells = [...iterateBox(b)];
      const withStates = expected.some((e) => e.states);
      const actual: Actual[] = cells.map((p) => {
        const blk = getBlock(dim, p);
        return withStates ? { typeId: blk.typeId, states: blk.permutation.getAllStates() } : { typeId: blk.typeId };
      });
      const counts: Record<string, number> = {};
      for (const a of actual) counts[a.typeId] = (counts[a.typeId] ?? 0) + 1;
      const { diffs, first } = diffBlocks(cells, expected, actual);
      return { from: b.min, to: b.max, size: b.size, count: cells.length, diffs, first, actual: counts };
    },

    blockstates(args) {
      const b = box(blockPos(args, 0), blockPos(args, 3));
      if (b.volume > MAX_STATE_BLOCKS) throw new TruthError('volume_too_large', `volume ${b.volume} > ${MAX_STATE_BLOCKS}`, { volume: b.volume, max: MAX_STATE_BLOCKS });
      const dim = overworld();
      assertLoaded(dim, b);
      const rle = new RleEncoder();
      const palette: { typeId: string; states: Record<string, StateValue> }[] = [];
      const seen = new Map<string, number>();
      for (const p of iterateBox(b)) {
        const blk = getBlock(dim, p);
        const states = blk.permutation.getAllStates();
        const k = `${blk.typeId}${JSON.stringify(states)}`;
        if (!seen.has(k)) {
          seen.set(k, palette.length);
          palette.push({ typeId: blk.typeId, states });
        }
        rle.push(k);
      }
      // the encoder's own palette holds the keys in first-seen order, the same order as `palette`
      return { from: b.min, to: b.max, size: b.size, order: 'yzx', palette, runs: rle.runs };
    },
  };
}
