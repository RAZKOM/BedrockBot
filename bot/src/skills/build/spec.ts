// `!build` arguments -> BuildSpec (wave 9, Track AL; docs/build.md "Commands"). Coordinates are block
// coordinates; `~` is the bot's own feet coordinate and `~N` / `~-N` an offset from it.
//
//   fill x1 y1 z1 x2 y2 z2 <block>          every free cell of the box
//   clear x1 y1 z1 x2 y2 z2                 dig the box empty
//   replace x1 y1 z1 x2 y2 z2 <from> <to>   every <from> in the box becomes <to>
//   wall x1 y z1 x2 z2 <height> <block>     a straight (or diagonal) wall from (x1, z1) to (x2, z2), y up
//   floor x1 y z1 x2 z2 <block>             a one-block-high rectangle at y
//   pillar x y z <height> <block>           a column from y up
//   file <name> [x y z] [0|90|180|270]      a structure file, its min corner at the bot's feet or at x y z
//
// A trailing `fetch` (fill-type builds) runs `!get` for the missing blocks first.
import type { Structure } from './formats/mcstructure.ts';
import { parseRotation, placeStructure, type Rotation } from './formats/index.ts';
import { blockId, MAX_BUILD_CELLS, unsupportedBlock, type BuildBlock, type BuildKind, type BuildSpec, type Cell } from './types.ts';

export const BUILD_KINDS: readonly BuildKind[] = ['fill', 'clear', 'replace', 'wall', 'floor', 'pillar', 'file'];

export const BUILD_USAGE: Record<BuildKind, string> = {
  fill: 'fill x1 y1 z1 x2 y2 z2 <block>',
  clear: 'clear x1 y1 z1 x2 y2 z2',
  replace: 'replace x1 y1 z1 x2 y2 z2 <from> <to>',
  wall: 'wall x1 y z1 x2 z2 <height> <block>',
  floor: 'floor x1 y z1 x2 z2 <block>',
  pillar: 'pillar x y z <height> <block>',
  file: 'file <name> [x y z] [0|90|180|270]',
};

export interface SpecContext {
  /** The bot's feet (for `~` and `file` without coordinates). */
  feet?: Cell | undefined;
  /** Load a structure by name (formats/index.ts loadStructure). */
  load?: (name: string) => Structure;
}

export type SpecResult = { ok: true; spec: BuildSpec; fetch: boolean } | { ok: false; error: string };

const BLOCK_RE = /^(minecraft:)?[a-z][a-z0-9_]{1,63}$/i;

function coord(s: string | undefined, base: number | undefined, what: string): number {
  if (s === undefined) throw new Error(`missing ${what}`);
  if (s.startsWith('~')) {
    if (base === undefined) throw new Error(`${what}: ~ needs the bot's position`);
    const off = s.length > 1 ? Number(s.slice(1)) : 0;
    if (!Number.isInteger(off)) throw new Error(`${what} must be a whole number or ~N, got "${s}"`);
    return Math.floor(base) + off;
  }
  const n = Number(s);
  if (!Number.isFinite(n) || s.trim() === '') throw new Error(`${what} must be a number, got "${s}"`);
  return Math.floor(n);
}

function xyz(args: readonly string[], i: number, feet: Cell | undefined, tag = ''): Cell {
  return { x: coord(args[i], feet?.x, `x${tag}`), y: coord(args[i + 1], feet?.y, `y${tag}`), z: coord(args[i + 2], feet?.z, `z${tag}`) };
}

function block(s: string | undefined, what = 'block'): string {
  if (!s || !BLOCK_RE.test(s)) throw new Error(`${what} must be a block name, got "${s ?? ''}"`);
  const n = blockId(s);
  const why = unsupportedBlock(n);
  if (why) throw new Error(`${n}: ${why}`);
  return n;
}

function count(s: string | undefined, what: string, max: number): number {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${what} must be 1..${max}, got "${s ?? ''}"`);
  return n;
}

function boxOf(a: Cell, b: Cell): { min: Cell; max: Cell } {
  return { min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) }, max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) } };
}

const dims = (b: { min: Cell; max: Cell }) => `${b.max.x - b.min.x + 1}x${b.max.y - b.min.y + 1}x${b.max.z - b.min.z + 1}`;
const volume = (b: { min: Cell; max: Cell }) => (b.max.x - b.min.x + 1) * (b.max.y - b.min.y + 1) * (b.max.z - b.min.z + 1);

function boxCells(b: { min: Cell; max: Cell }, name: string): BuildBlock[] {
  const out: BuildBlock[] = [];
  for (let y = b.min.y; y <= b.max.y; y++) for (let x = b.min.x; x <= b.max.x; x++) for (let z = b.min.z; z <= b.max.z; z++) out.push({ pos: { x, y, z }, name });
  return out;
}

/** The columns of a straight line from (x1, z1) to (x2, z2) (Bresenham, 8-connected). */
export function lineColumns(x1: number, z1: number, x2: number, z2: number): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  const dx = Math.abs(x2 - x1);
  const dz = Math.abs(z2 - z1);
  const sx = x1 < x2 ? 1 : -1;
  const sz = z1 < z2 ? 1 : -1;
  let err = dx - dz;
  let x = x1;
  let z = z1;
  for (;;) {
    out.push({ x, z });
    if (x === x2 && z === z2) break;
    const e2 = 2 * err;
    if (e2 > -dz) {
      err -= dz;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      z += sz;
    }
  }
  return out;
}

function tooBig(n: number): void {
  if (n > MAX_BUILD_CELLS) throw new Error(`${n} cells is too big (at most ${MAX_BUILD_CELLS})`);
}

/** Parse `!build <kind> ...` (args without `build`). */
export function parseSpec(argsIn: readonly string[], ctx: SpecContext = {}): SpecResult {
  const args = [...argsIn];
  let fetch = false;
  if (args.length > 1 && args[args.length - 1]!.toLowerCase() === 'fetch') {
    fetch = true;
    args.pop();
  }
  const kind = (args[0] ?? '').toLowerCase() as BuildKind;
  if (!BUILD_KINDS.includes(kind)) return { ok: false, error: `unknown build "${args[0] ?? ''}" (${BUILD_KINDS.join(', ')})` };
  const feet = ctx.feet;
  try {
    switch (kind) {
      case 'fill': {
        if (args.length !== 8) throw new Error(BUILD_USAGE.fill);
        const b = boxOf(xyz(args, 1, feet, '1'), xyz(args, 4, feet, '2'));
        const name = block(args[7]);
        tooBig(volume(b));
        return { ok: true, fetch, spec: { kind, label: `fill ${dims(b)} ${name}`, places: boxCells(b, name), box: b } };
      }
      case 'clear': {
        if (args.length !== 7) throw new Error(BUILD_USAGE.clear);
        const b = boxOf(xyz(args, 1, feet, '1'), xyz(args, 4, feet, '2'));
        tooBig(volume(b));
        return { ok: true, fetch: false, spec: { kind, label: `clear ${dims(b)}`, places: [], box: b } };
      }
      case 'replace': {
        if (args.length !== 9) throw new Error(BUILD_USAGE.replace);
        const b = boxOf(xyz(args, 1, feet, '1'), xyz(args, 4, feet, '2'));
        const from = blockId(args[7] ?? '');
        if (!BLOCK_RE.test(from)) throw new Error(`from must be a block name, got "${args[7] ?? ''}"`);
        const to = block(args[8], 'to');
        tooBig(volume(b));
        return { ok: true, fetch, spec: { kind, label: `replace ${from} -> ${to} in ${dims(b)}`, places: [], box: b, replace: { from, to } } };
      }
      case 'wall': {
        if (args.length !== 8) throw new Error(BUILD_USAGE.wall);
        const x1 = coord(args[1], feet?.x, 'x1');
        const y = coord(args[2], feet?.y, 'y');
        const z1 = coord(args[3], feet?.z, 'z1');
        const x2 = coord(args[4], feet?.x, 'x2');
        const z2 = coord(args[5], feet?.z, 'z2');
        const h = count(args[6], 'height', 64);
        const name = block(args[7]);
        const cols = lineColumns(x1, z1, x2, z2);
        tooBig(cols.length * h);
        const places: BuildBlock[] = [];
        for (let k = 0; k < h; k++) for (const c of cols) places.push({ pos: { x: c.x, y: y + k, z: c.z }, name });
        return { ok: true, fetch, spec: { kind, label: `wall ${cols.length}x${h} ${name}`, places } };
      }
      case 'floor': {
        if (args.length !== 7) throw new Error(BUILD_USAGE.floor);
        const y = coord(args[2], feet?.y, 'y');
        const b = boxOf({ x: coord(args[1], feet?.x, 'x1'), y, z: coord(args[3], feet?.z, 'z1') }, { x: coord(args[4], feet?.x, 'x2'), y, z: coord(args[5], feet?.z, 'z2') });
        const name = block(args[6]);
        tooBig(volume(b));
        return { ok: true, fetch, spec: { kind, label: `floor ${b.max.x - b.min.x + 1}x${b.max.z - b.min.z + 1} ${name}`, places: boxCells(b, name), box: b } };
      }
      case 'pillar': {
        if (args.length !== 6) throw new Error(BUILD_USAGE.pillar);
        const at = xyz(args, 1, feet);
        const h = count(args[4], 'height', 64);
        const name = block(args[5]);
        const places = Array.from({ length: h }, (_, k) => ({ pos: { x: at.x, y: at.y + k, z: at.z }, name }));
        return { ok: true, fetch, spec: { kind, label: `pillar ${h} ${name}`, places } };
      }
      case 'file': {
        const name = args[1];
        if (!name || (args.length !== 2 && args.length !== 3 && args.length !== 5 && args.length !== 6)) throw new Error(BUILD_USAGE.file);
        let at = feet ? { x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) } : undefined;
        let rot: Rotation = 0;
        if (args.length >= 5) at = xyz(args, 2, feet);
        const r = args.length === 3 ? args[2] : args.length === 6 ? args[5] : undefined;
        if (r !== undefined) {
          const p = parseRotation(r);
          if (p === undefined) throw new Error(`rotation must be 0, 90, 180 or 270, got "${r}"`);
          rot = p;
        }
        if (!at) throw new Error('file: the bot position is unknown; give x y z');
        if (!ctx.load) throw new Error('file: no structure folder');
        const s = ctx.load(name);
        tooBig(s.blocks.length);
        for (const b of s.blocks) {
          const why = unsupportedBlock(b.name);
          if (why) throw new Error(`${s.name}: ${b.name} at ${b.pos.x} ${b.pos.y} ${b.pos.z} (structure): ${why}`);
        }
        const places = placeStructure(s, at, rot);
        return { ok: true, fetch, spec: { kind, label: `file ${s.name} at ${at.x} ${at.y} ${at.z}${rot ? ` (${rot})` : ''}`, places } };
      }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: false, error: 'unknown build' };
}

/** A `build` step of a natural-language plan (nl/plan.ts) as typed fields. */
export interface BuildStepFields {
  shape: 'fill' | 'clear' | 'wall' | 'floor' | 'pillar' | 'file';
  x?: number | undefined;
  y?: number | undefined;
  z?: number | undefined;
  x2?: number | undefined;
  y2?: number | undefined;
  z2?: number | undefined;
  height?: number | undefined;
  block?: string | undefined;
  name?: string | undefined;
}

/**
 * The chat text of a `build` plan step (no prefix): `build wall 1 -60 2 10 2 4 cobblestone`. Fields the
 * request did not give become `?`, which `!build` answers with an error (the step fails).
 */
export function buildStepText(s: BuildStepFields): string {
  const v = (n: number | string | undefined) => (n === undefined ? '?' : String(n));
  const at = s.x === undefined && s.y === undefined && s.z === undefined ? '~ ~ ~' : `${v(s.x)} ${v(s.y)} ${v(s.z)}`;
  switch (s.shape) {
    case 'fill':
      return `build fill ${at} ${v(s.x2)} ${v(s.y2)} ${v(s.z2)} ${v(s.block)}`;
    case 'clear':
      return `build clear ${at} ${v(s.x2)} ${v(s.y2)} ${v(s.z2)}`;
    case 'wall':
      return `build wall ${at} ${v(s.x2)} ${v(s.z2)} ${v(s.height)} ${v(s.block)}`;
    case 'floor':
      return `build floor ${at} ${v(s.x2)} ${v(s.z2)} ${v(s.block)}`;
    case 'pillar':
      return `build pillar ${at} ${v(s.height)} ${v(s.block)}`;
    case 'file':
      return s.x === undefined ? `build file ${v(s.name)}` : `build file ${v(s.name)} ${at}`;
  }
}
