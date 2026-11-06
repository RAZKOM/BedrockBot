// Track F5a (docs/flight.md "Real-cave benchmark (Track F5a)", decisions/0068): a box of cells to rebuild on the
// server (a real cave from the bot's world cache: bot/src/world/cache/export.ts) as pure data. No @minecraft/server
// imports: the bot cuts the cells into boxes and encodes them (bot/test/e2e/fly-cave.test.ts), the pack decodes and
// fills them (cave.ts `truth:cave`). The cells never live in the pack or the repository: they come over the
// scriptevent messages of one build.
//
// The box is filled with stone first; then the boxes of air and of water (greedy boxes: the longest run along x, as
// many rows along z, as many layers along y as stay of one class) are filled over it. Each box is 7 numbers (the
// block, the min corner relative to the box's min, the size less one), written as base-32 digits in a 64-letter
// alphabet (6 bits a letter: 5 of value, 1 for "more follows"), no separators. A message holds whole boxes.
import type { Vec3 } from './protocol.js';

/** The blocks of a cave build (index = the code in the stream). */
export const CAVE_BLOCKS = ['air', 'stone', 'water'] as const;
export type CaveBlock = (typeof CAVE_BLOCKS)[number];
export const CAVE_AIR = 0;
export const CAVE_STONE = 1;
export const CAVE_WATER = 2;

/** A box of one block, corners inclusive, relative to the build's min corner. */
export interface CaveBox {
  b: number;
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const INDEX: Record<string, number> = Object.fromEntries([...ALPHABET].map((c, i) => [c, i]));

function putNum(out: string[], n: number): void {
  let v = n;
  for (;;) {
    const d = v & 31;
    v >>>= 5;
    out.push(ALPHABET[v ? d | 32 : d]!);
    if (!v) return;
  }
}

/** The boxes as letters (see the file comment). */
export function encodeBoxes(boxes: readonly CaveBox[]): string {
  const out: string[] = [];
  for (const q of boxes) for (const n of [q.b, q.x0, q.y0, q.z0, q.x1 - q.x0, q.y1 - q.y0, q.z1 - q.z0]) putNum(out, n);
  return out.join('');
}

/** The inverse of encodeBoxes. Throws on a letter outside the alphabet or a stream that ends inside a box. */
export function decodeBoxes(s: string): CaveBox[] {
  const nums: number[] = [];
  let v = 0;
  let shift = 0;
  for (const c of s) {
    const d = INDEX[c];
    if (d === undefined) throw new Error(`cave: bad letter ${c}`);
    v += (d & 31) * 2 ** shift;
    if (d & 32) shift += 5;
    else {
      nums.push(v);
      v = 0;
      shift = 0;
    }
  }
  if (nums.length % 7 !== 0 || shift !== 0) throw new Error('cave: the stream ends inside a box');
  const out: CaveBox[] = [];
  for (let i = 0; i < nums.length; i += 7) {
    const [b, x0, y0, z0, dx, dy, dz] = nums.slice(i, i + 7) as [number, number, number, number, number, number, number];
    out.push({ b, x0, y0, z0, x1: x0 + dx, y1: y0 + dy, z1: z0 + dz });
  }
  return out;
}

/** The encoded boxes cut into messages of at most `maxChars` letters, at box boundaries. */
export function boxMessages(boxes: readonly CaveBox[], maxChars: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const q of boxes) {
    const e = encodeBoxes([q]);
    if (cur.length + e.length > maxChars && cur) {
      out.push(cur);
      cur = '';
    }
    cur += e;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * The cells of class `want` of a size.x x size.y x size.z box as greedy boxes: in y, z, x order, a cell not yet
 * covered grows along x while the class holds, then along z while the whole run does, then along y while the whole
 * rectangle does.
 */
export function greedyBoxes(size: Vec3, code: (x: number, y: number, z: number) => number, want: number): CaveBox[] {
  const { x: sx, y: sy, z: sz } = size;
  const done = new Uint8Array(sx * sy * sz);
  const at = (x: number, y: number, z: number): number => (y * sz + z) * sx + x;
  const free = (x: number, y: number, z: number): boolean => !done[at(x, y, z)] && code(x, y, z) === want;
  const out: CaveBox[] = [];
  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        if (!free(x, y, z)) continue;
        let x1 = x;
        while (x1 + 1 < sx && free(x1 + 1, y, z)) x1++;
        let z1 = z;
        const rowFree = (zz: number, yy: number): boolean => {
          for (let xx = x; xx <= x1; xx++) if (!free(xx, yy, zz)) return false;
          return true;
        };
        while (z1 + 1 < sz && rowFree(z1 + 1, y)) z1++;
        let y1 = y;
        const layerFree = (yy: number): boolean => {
          for (let zz = z; zz <= z1; zz++) if (!rowFree(zz, yy)) return false;
          return true;
        };
        while (y1 + 1 < sy && layerFree(y1 + 1)) y1++;
        for (let yy = y; yy <= y1; yy++) for (let zz = z; zz <= z1; zz++) for (let xx = x; xx <= x1; xx++) done[at(xx, yy, zz)] = 1;
        out.push({ b: want, x0: x, y0: y, z0: z, x1, y1, z1 });
      }
    }
  }
  return out;
}

/** The blocks the boxes cover. */
export function boxesVolume(boxes: readonly CaveBox[]): number {
  let n = 0;
  for (const q of boxes) n += (q.x1 - q.x0 + 1) * (q.y1 - q.y0 + 1) * (q.z1 - q.z0 + 1);
  return n;
}
