// `!build` arguments -> BuildSpec (wave 9, Track AL; docs/build.md "Commands"). Coordinates are block
// coordinates; `~` is the bot's own feet coordinate and `~N` / `~-N` an offset from it.
//
//   fill x1 y1 z1 x2 y2 z2 <block>          every free cell of the box
//   clear x1 y1 z1 x2 y2 z2                 dig the box empty
//   replace x1 y1 z1 x2 y2 z2 <from> <to>   every <from> in the box becomes <to>
//   wall x1 y z1 x2 z2 <height> <block>     a straight (or diagonal) wall from (x1, z1) to (x2, z2), y up
//   floor x1 y z1 x2 z2 <block>             a one-block-high rectangle at y
//   pillar x y z <height> <block>           a column from y up
//   file <name> [x y z] [0|90|180|270] [skip unknown]  a structure file, its min corner at the bot's feet or at x y z
//   file <name> map [x z | x y z] [valley] [skip unknown]  Track B7: a map art on the map grid (skills/build/mapart.ts);
//                                                    Track B8: valley = re-heighted to the least height, with supports
//
// A trailing `fetch` (fill-type builds) gets the missing blocks first: Track B2 brings, gathers, crafts and smelts them
// (chat/commands-build.ts, skills/build/bill.ts). Track B2: a file with blocks that have no Bedrock block (a Java file's
// mod blocks) is refused with them named; a trailing `skip unknown` builds it without them. Track B6: `fetch skip missing`
// builds without what the bill cannot get (skills/build/skip.ts), the rest fetched and built.
import type { Structure, UnknownBlock } from './formats/mcstructure.ts';
import { parseRotation, placeStructure, type Rotation } from './formats/index.ts';
import { TILE_SIDE } from './job.ts';
import { MAP_COLUMN_MAX, MAP_SUPPORT, mapArtObstacles, mapArtY, mapColourRefusals, mapCorner, mapLayout, mapSupports, mapText, valley, valleyText, type GroundTop, type SolidAt } from './mapart.ts';
import { unsupportedBlock } from './states.ts';
import { blockId, MAX_BUILD_CELLS, type BuildBlock, type BuildKind, type BuildSpec, type Cell } from './types.ts';

export const BUILD_KINDS: readonly BuildKind[] = ['fill', 'clear', 'replace', 'wall', 'floor', 'pillar', 'file'];

export const BUILD_USAGE: Record<BuildKind, string> = {
  fill: 'fill x1 y1 z1 x2 y2 z2 <block>',
  clear: 'clear x1 y1 z1 x2 y2 z2',
  replace: 'replace x1 y1 z1 x2 y2 z2 <from> <to>',
  wall: 'wall x1 y z1 x2 z2 <height> <block>',
  floor: 'floor x1 y z1 x2 z2 <block>',
  pillar: 'pillar x y z <height> <block>',
  file: 'file <name> [x y z] [0|90|180|270] [skip unknown] | file <name> map [x z | x y z] [valley]',
};

export interface SpecContext {
  /** The bot's feet (for `~` and `file` without coordinates). */
  feet?: Cell | undefined;
  /** Load a structure by name (formats/index.ts loadStructure). */
  load?: (name: string) => Structure;
  /** Track B2: a file with unknown blocks is not refused (`!build materials` lists them). */
  allowUnknown?: boolean;
  /** Track B7: the ground top of a column (`file <name> map` without a y). */
  ground?: GroundTop;
  /** Track B8: the world's blocks a placement can click (a valley map art's supports; without it the ground is flat). */
  solid?: SolidAt;
  /** Track B8: what stands in or over an art cell (mapart.ts standsAbove): a map art over it is refused. */
  above?: (x: number, z: number, y: number) => { y: number; name: string } | undefined;
}

/** Track B2: `unknown` are a file's blocks with no Bedrock block, left out of the spec (`skip unknown` or allowUnknown). */
/** Track B7: `args` are the arguments with what was chosen filled in (a map art's corner and y), for a resume. */
export type SpecResult = { ok: true; spec: BuildSpec; fetch: boolean; unknown?: UnknownBlock[]; args?: string[]; skipMissing?: boolean } | { ok: false; error: string };

/** Track B6 (decision 0131): `skip missing` (with `fetch`): build without what the bill cannot get. */
export const SKIP_MISSING = 'skip missing';

/** Track B2: `house: 4 blocks have no Bedrock block: create:gearbox x 4 (not a Bedrock block); ...` */
export function unknownRefusal(name: string, unknown: readonly UnknownBlock[], max = 240): string {
  const n = unknown.reduce((a, u) => a + u.count, 0);
  const head = `${name}: ${n} block${n === 1 ? ' has' : 's have'} no Bedrock block: `;
  const tail = ' (add skip unknown to build without them; !build materials lists them)';
  const text = (shown: readonly string[]): string => `${head}${shown.join(', ')}${unknown.length > shown.length ? `, ${unknown.length - shown.length} more kind${unknown.length - shown.length === 1 ? '' : 's'}` : ''}${tail}`;
  // as many as fit in one chat reply (the chat cuts at 256 characters; `build: ` goes in front)
  const shown: string[] = [];
  for (const u of unknown) {
    const e = `${u.java} x ${u.count} (${u.reason})`;
    if (text([...shown, e]).length <= max) shown.push(e);
    else {
      if (shown.length === 0) shown.push(`${u.java.slice(0, Math.max(8, max - text(['']).length - (e.length - u.java.length) - 3))}... x ${u.count} (${u.reason})`);
      break;
    }
  }
  return text(shown);
}

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
  let skipUnknown = false; // Track B2
  let skipMissing = false; // Track B6
  for (;;) {
    const last = args[args.length - 1]?.toLowerCase();
    if (args.length > 1 && last === 'fetch' && !fetch) {
      fetch = true;
      args.pop();
    } else if (args.length > 2 && last === 'unknown' && args[args.length - 2]!.toLowerCase() === 'skip' && !skipUnknown) {
      skipUnknown = true;
      args.splice(-2);
    } else if (args.length > 2 && last === 'missing' && args[args.length - 2]!.toLowerCase() === 'skip' && !skipMissing) {
      skipMissing = true;
      args.splice(-2);
    } else break;
  }
  if (skipMissing && !fetch) return { ok: false, error: `${SKIP_MISSING} goes with fetch (!build ... fetch ${SKIP_MISSING}): without fetch a build missing blocks is refused` };
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
        return { ok: true, ...(skipMissing ? { skipMissing } : {}), fetch, spec: { kind, label: `fill ${dims(b)} ${name}`, places: boxCells(b, name), box: b } };
      }
      case 'clear': {
        if (args.length !== 7) throw new Error(BUILD_USAGE.clear);
        const b = boxOf(xyz(args, 1, feet, '1'), xyz(args, 4, feet, '2'));
        tooBig(volume(b));
        return { ok: true, ...(skipMissing ? { skipMissing } : {}), fetch: false, spec: { kind, label: `clear ${dims(b)}`, places: [], box: b } };
      }
      case 'replace': {
        if (args.length !== 9) throw new Error(BUILD_USAGE.replace);
        const b = boxOf(xyz(args, 1, feet, '1'), xyz(args, 4, feet, '2'));
        const from = blockId(args[7] ?? '');
        if (!BLOCK_RE.test(from)) throw new Error(`from must be a block name, got "${args[7] ?? ''}"`);
        const to = block(args[8], 'to');
        tooBig(volume(b));
        return { ok: true, ...(skipMissing ? { skipMissing } : {}), fetch, spec: { kind, label: `replace ${from} -> ${to} in ${dims(b)}`, places: [], box: b, replace: { from, to } } };
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
        return { ok: true, ...(skipMissing ? { skipMissing } : {}), fetch, spec: { kind, label: `wall ${cols.length}x${h} ${name}`, places } };
      }
      case 'floor': {
        if (args.length !== 7) throw new Error(BUILD_USAGE.floor);
        const y = coord(args[2], feet?.y, 'y');
        const b = boxOf({ x: coord(args[1], feet?.x, 'x1'), y, z: coord(args[3], feet?.z, 'z1') }, { x: coord(args[4], feet?.x, 'x2'), y, z: coord(args[5], feet?.z, 'z2') });
        const name = block(args[6]);
        tooBig(volume(b));
        return { ok: true, ...(skipMissing ? { skipMissing } : {}), fetch, spec: { kind, label: `floor ${b.max.x - b.min.x + 1}x${b.max.z - b.min.z + 1} ${name}`, places: boxCells(b, name), box: b } };
      }
      case 'pillar': {
        if (args.length !== 6) throw new Error(BUILD_USAGE.pillar);
        const at = xyz(args, 1, feet);
        const h = count(args[4], 'height', 64);
        const name = block(args[5]);
        const places = Array.from({ length: h }, (_, k) => ({ pos: { x: at.x, y: at.y + k, z: at.z }, name }));
        return { ok: true, ...(skipMissing ? { skipMissing } : {}), fetch, spec: { kind, label: `pillar ${h} ${name}`, places } };
      }
      case 'file': {
        if (args[2]?.toLowerCase() === 'map') return mapSpec(args, ctx, { fetch, skipUnknown });
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
        // Track B2: the file's size with its block count
        if (s.blocks.length > MAX_BUILD_CELLS) throw new Error(`${s.name}: ${s.blocks.length} blocks in ${s.size.x}x${s.size.y}x${s.size.z} is too big (at most ${MAX_BUILD_CELLS})`);
        // Track B2: blocks with no Bedrock block refuse the file unless `skip unknown`
        const unknown = s.unknown ?? [];
        if (unknown.length && !skipUnknown && !ctx.allowUnknown) throw new Error(unknownRefusal(s.name, unknown));
        // Track B1: the Bedrock blocks the builder refuses are listed by the planner and the rest is built (decision 0124)
        const places = placeStructure(s, at, rot);
        const skipped = unknown.reduce((a, u) => a + u.count, 0);
        const label = `file ${s.name} at ${at.x} ${at.y} ${at.z}${rot ? ` (${rot})` : ''}${skipped && skipUnknown ? `, ${skipped} unknown skipped` : ''}`;
        return { ok: true, ...(skipMissing ? { skipMissing } : {}), fetch, spec: { kind, label, places }, ...(unknown.length ? { unknown } : {}) };
      }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: false, error: 'unknown build' };
}

/**
 * Track B7 (decision 0132): `file <name> map [x z | x y z]`: the file's first map square on the grid square holding x z
 * (the bot's feet without them), the noob line north of it; without a y, every column's lowest block above its ground.
 */
function mapSpec(argsIn: readonly string[], ctx: SpecContext, o: { fetch: boolean; skipUnknown: boolean }): SpecResult {
  // Track B8 (decision 0133): `valley` re-heights the art (the same map, the least height) and adds its supports
  const isValley = argsIn.length > 3 && argsIn[argsIn.length - 1]!.toLowerCase() === 'valley';
  const args = isValley ? argsIn.slice(0, -1) : argsIn;
  const name = args[1]!;
  const feet = ctx.feet;
  if (args.length !== 3 && args.length !== 5 && args.length !== 6) throw new Error('usage: file <name> map [x z | x y z] [valley]');
  const x = args.length === 3 ? (feet ? Math.floor(feet.x) : undefined) : coord(args[3], feet?.x, 'x');
  const z = args.length === 3 ? (feet ? Math.floor(feet.z) : undefined) : coord(args[args.length - 1], feet?.z, 'z');
  if (x === undefined || z === undefined) throw new Error('map: the bot position is unknown; give x z');
  if (!ctx.load) throw new Error('file: no structure folder');
  const s = ctx.load(name);
  if (s.blocks.length > MAX_BUILD_CELLS) throw new Error(`${s.name}: ${s.blocks.length} blocks in ${s.size.x}x${s.size.y}x${s.size.z} is too big (at most ${MAX_BUILD_CELLS})`);
  // blocks with no Bedrock block, and those with another map colour on Bedrock, refuse the file unless `skip unknown`
  const colours = mapColourRefusals(s.blocks);
  const unknown = [...(s.unknown ?? []), ...colours];
  if (unknown.length && !o.skipUnknown && !ctx.allowUnknown) throw new Error(unknownRefusal(s.name, unknown).replace('have no Bedrock block', 'have no Bedrock block or map colour'));
  const layout = mapLayout(s.size, mapCorner(x, z));
  const skip = new Set(colours.map((c) => c.java));
  const kept = skip.size ? s.blocks.filter((b) => !skip.has(b.name)) : s.blocks;
  // Track B8: the valley heights (the same pixels on a Bedrock map: the parity of a step of 1 is the world's)
  const v = isValley ? valley(kept, { at: { x: layout.x, z: layout.z } }) : undefined;
  const blocks = v ? v.blocks : kept;
  const high = v ? v.after : s.size.y;
  let y = args.length === 6 ? coord(args[4], feet?.y, 'y') : undefined;
  let groundNote = '';
  if (y === undefined) {
    if (!ctx.ground) throw new Error('map: the ground is unknown here; give x y z');
    const g = mapArtY(blocks, layout.x, layout.z, ctx.ground);
    if (g.unloaded) throw new Error(`map: the ground of ${g.unloaded} of ${g.columns} columns is not loaded (stand nearer the art's middle, or give x y z)`);
    if (g.y === undefined) throw new Error('map: the file has no blocks');
    y = g.y;
    if (g.low !== undefined && g.high !== undefined) groundNote = `; y ${y} over ground ${g.low}..${g.high}`;
  }
  if (y < -64 || y + high - 1 > 319) throw new Error(`map: y ${y} puts the art outside -64..319 (it is ${high} high)`);
  const at = { x: layout.x, y, z: layout.z };
  const places = placeStructure({ ...s, blocks, size: { ...s.size, y: high } }, at, 0);
  // Track B8: what stands in or over the art's cells (trees: the ground is taken under them) refuses it
  if (ctx.above) {
    const ob = mapArtObstacles(places, ctx.above);
    if (ob.n) {
      const kinds = [...ob.kinds].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${n} ${k}`);
      throw new Error(`map: ${ob.n} block${ob.n === 1 ? ' stands' : 's stand'} in or over the art (${kinds.join(', ')}${ob.kinds.size > 3 ? `, +${ob.kinds.size - 3} more` : ''}; ${ob.first.map((f) => `${f.pos.x} ${f.pos.y} ${f.pos.z} ${f.name}`).join(', ')}): clear them first or give a higher y`);
    }
  }
  // Track B8: the supports under the art's blocks that have nothing to click (never seen on the map), as build cells
  const supports = v ? mapSupports(places, { side: TILE_SIDE, origin: { x: at.x, z: at.z }, solid: ctx.solid }) : [];
  const skipped = unknown.reduce((a, u) => a + u.count, 0);
  const label = `file ${s.name} map${v ? ' valley' : ''} at ${at.x} ${at.y} ${at.z} (${mapText(layout)})${skipped && o.skipUnknown ? `, ${skipped} unknown skipped` : ''}`;
  const resolved = ['file', name, 'map', String(layout.corner.x), String(y), String(layout.corner.z), ...(v ? ['valley'] : []), ...(o.skipUnknown ? ['skip', 'unknown'] : []), ...(o.fetch ? ['fetch'] : [])];
  const note = v ? `${valleyText(v)}${groundNote}; ${supports.length} ${MAP_SUPPORT} supports under blocks with nothing to click` : undefined;
  const spec: BuildSpec = { kind: 'file', label, places: [...places, ...supports.map((c) => ({ pos: c, name: MAP_SUPPORT }))], ...(v ? { free: true, column: Math.min(MAP_COLUMN_MAX, Math.max(1, high - 3)) } : {}), ...(note ? { note } : {}) };
  return { ok: true, fetch: o.fetch, spec, args: resolved, ...(unknown.length ? { unknown } : {}) };
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
