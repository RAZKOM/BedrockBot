// Track F22: a cave fixture cut down to the box of another one (the private fixtures of Track F5a: bot/fixtures-private).
// The replica on the test server stands in the box of the first fixtures, and the truth pack builds a box of that size
// (a wider one's ticking areas do not load); a fresh export of the wider box is cut to it, so that the replica holds the
// cave as it is now. Reads `--from <dir>` (the fresh, wider fixture) and `--like <dir>` (a fixture with the box and the
// tops rectangle wanted), writes `--out <dir>` (extract.json, and the waypoints and pairs of `--from` as they are).
// Prints sizes and counts only.
//
//   node scripts/cave-crop.ts --from fixtures-private/cave-wide --like fixtures-private/cave --out fixtures-private/cave-new
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { decodeExtract, EXTRACT_FORMAT, EXTRACT_VERSION, TOP_UNKNOWN, type CacheExtractFile } from '../src/world/cache/export.ts';
import { CLS_AIR } from '../src/world/cache/types.ts';

const arg = (name: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) throw new Error(`--${name} <dir> is needed`);
  return v;
};
const fromDir = arg('from');
const likeDir = arg('like');
const outDir = arg('out');
const fromFile = JSON.parse(readFileSync(join(fromDir, 'extract.json'), 'utf8')) as CacheExtractFile;
const likeFile = JSON.parse(readFileSync(join(likeDir, 'extract.json'), 'utf8')) as CacheExtractFile;
const src = decodeExtract(fromFile);
const like = decodeExtract(likeFile);
const box = likeFile.box;
const inside = (b: typeof box, o: typeof box): boolean => b.min.x >= o.min.x && b.max.x <= o.max.x && b.min.y >= o.min.y && b.max.y <= o.max.y && b.min.z >= o.min.z && b.max.z <= o.max.z;
if (src.dim !== like.dim || !inside(box, src.box)) throw new Error('the box wanted does not lie inside the fixture it is cut from');
const sx = box.max.x - box.min.x + 1;
const sy = box.max.y - box.min.y + 1;
const sz = box.max.z - box.min.z + 1;
const packed = new Uint8Array(Math.ceil((sx * sy * sz) / 4));
const counts = { air: 0, solid: 0, water: 0, avoid: 0 };
const names = ['air', 'solid', 'water', 'avoid'] as const;
const unknown: [number, number][] = [];
for (let cx = box.min.x >> 4; cx <= box.max.x >> 4; cx++) for (let cz = box.min.z >> 4; cz <= box.max.z >> 4; cz++) if (src.unknownChunk(cx, cz)) unknown.push([cx, cz]);
const unknownSet = new Set(unknown.map(([cx, cz]) => `${cx},${cz}`));
let differ = 0;
for (let y = box.min.y; y <= box.max.y; y++) {
  for (let z = box.min.z; z <= box.max.z; z++) {
    for (let x = box.min.x; x <= box.max.x; x++) {
      if (unknownSet.has(`${x >> 4},${z >> 4}`)) continue;
      const c = src.cls(x, y, z)!;
      counts[names[c]]++;
      if (c !== like.cls(x, y, z)) differ++;
      if (c === CLS_AIR) continue;
      const i = ((y - box.min.y) * sz + (z - box.min.z)) * sx + (x - box.min.x);
      packed[i >> 2] = packed[i >> 2]! | (c << ((i & 3) * 2));
    }
  }
}
const out: CacheExtractFile = { format: EXTRACT_FORMAT, version: EXTRACT_VERSION, dim: src.dim, box, cells: deflateRawSync(packed, { level: 9 }).toString('base64'), unknown, counts, exportedAt: fromFile.exportedAt };
const rect = likeFile.tops?.rect;
if (rect) {
  // the tops of the rectangle wanted: the fresh fixture's where it has them, the other one's elsewhere
  const tx = rect.max.x - rect.min.x + 1;
  const tz = rect.max.z - rect.min.z + 1;
  const data = new Int16Array(tx * tz);
  for (let z = rect.min.z; z <= rect.max.z; z++) for (let x = rect.min.x; x <= rect.max.x; x++) data[(z - rect.min.z) * tx + (x - rect.min.x)] = src.top(x, z) ?? like.top(x, z) ?? TOP_UNKNOWN;
  out.tops = { rect, data: deflateRawSync(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { level: 9 }).toString('base64') };
}
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'extract.json'), JSON.stringify(out));
for (const f of ['waypoints.json', 'fixture.json']) if (existsSync(join(fromDir, f))) copyFileSync(join(fromDir, f), join(outDir, f));
console.log(`cut to a box of ${sx} x ${sy} x ${sz} (${sx * sy * sz} cells) from one of ${src.size.x} x ${src.size.y} x ${src.size.z}; ${unknown.length} chunks never seen; ${differ} cells differ from the fixture the box was taken from; exported ${fromFile.exportedAt}`);
