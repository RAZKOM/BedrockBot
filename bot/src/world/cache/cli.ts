// Inspect a world cache directory (PLAN.md task 7.12; docs/world-cache.md). Read-only.
//   node src/world/cache/cli.ts info <dir>                 regions, chunks, bytes, marks by name
//   node src/world/cache/cli.ts checksum <dir> [--chunks]   aggregate checksum over every chunk's summary
//                                                            (FNV-1a over sorted "cx,cz:checksum" lines)
//   node src/world/cache/cli.ts chunk <dir> <cx> <cz>        one chunk: rows, tops, marks
//   node src/world/cache/cli.ts surface <dir> <cx> <cz>      one chunk's surface layer per column (Track PC)
// <dir> is one server's directory (`<config dir>/cache/<server id>`); add --dim <n> for other dimensions.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fnv1a32 } from '../registry.ts';
import { WorldCache } from './cache.ts';
import { CLASS_NAMES } from './types.ts';

const REGION_RE = /^r\.(-?\d+)\.(-?\d+)\.bin$/;

export interface CacheDirSummary {
  regions: number;
  chunks: number;
  bytes: number;
  checksum: string;
  perChunk: Map<string, string>;
  marks: Record<string, number>;
  /** Track PC: chunks whose record has the surface layer. */
  surfaceChunks: number;
}

/** Reads every region of a cache directory with a fresh read-only cache. */
export function summarizeCacheDir(dir: string, dim = 0): CacheDirSummary {
  const cache = new WorldCache({ dir, readOnly: true, maxChunks: 64, maxRegions: 4 });
  cache.useDimension(dim);
  const ddir = cache.dimDir(dim);
  let files: string[];
  try {
    files = readdirSync(ddir).filter((f) => REGION_RE.test(f));
  } catch {
    files = [];
  }
  const perChunk = new Map<string, string>();
  const marks: Record<string, number> = {};
  let bytes = 0;
  let surfaceChunks = 0;
  for (const f of files) {
    const m = REGION_RE.exec(f)!;
    const rx = Number(m[1]);
    const rz = Number(m[2]);
    bytes += statSync(join(ddir, f)).size;
    cache.loadRegion(rx, rz, dim);
    for (const { cx, cz } of cache.storedChunks(dim)) {
      if (cx >> 5 !== rx || cz >> 5 !== rz) continue;
      const s = cache.cachedSummary(cx, cz);
      if (!s) continue;
      perChunk.set(`${cx},${cz}`, s.checksum());
      for (const mk of s.marks.values()) marks[mk.name] = (marks[mk.name] ?? 0) + 1;
      if (s.surf) surfaceChunks++;
    }
  }
  const lines = [...perChunk.entries()].map(([k, v]) => `${k}:${v}`).sort();
  const checksum = (fnv1a32(Buffer.from(lines.join('\n'), 'utf8')) >>> 0).toString(16).padStart(8, '0');
  return { regions: files.length, chunks: perChunk.size, bytes, checksum, perChunk, marks, surfaceChunks };
}

function main(argv: string[]): number {
  const dimAt = argv.indexOf('--dim');
  const dim = dimAt >= 0 ? Number(argv.splice(dimAt, 2)[1]) : 0;
  const [cmd, dir, ...rest] = argv;
  if (!cmd || !dir) {
    console.error('usage: node src/world/cache/cli.ts info|checksum|chunk|surface <dir> [...]');
    return 2;
  }
  if (cmd === 'info' || cmd === 'checksum') {
    const s = summarizeCacheDir(dir, dim);
    const out: Record<string, unknown> = { dir, dimension: dim, regions: s.regions, chunks: s.chunks, bytes: s.bytes, bytesPerChunk: s.chunks ? Math.round(s.bytes / s.chunks) : 0, checksum: s.checksum };
    if (cmd === 'info') {
      out.marks = s.marks;
      out.surfaceChunks = s.surfaceChunks;
    }
    if (rest.includes('--chunks')) out.perChunk = Object.fromEntries(s.perChunk);
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }
  if (cmd === 'chunk') {
    const cx = Number(rest[0]);
    const cz = Number(rest[1]);
    const cache = new WorldCache({ dir, readOnly: true });
    cache.useDimension(dim);
    const s = cache.cachedSummary(cx, cz);
    if (!s) {
      console.error(`chunk ${cx},${cz} not cached`);
      return 1;
    }
    const counts = [0, 0, 0, 0];
    for (let y = s.y0; y < s.y0 + s.rows; y++) for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) counts[s.cls(x, y, z)]!++;
    console.log(
      JSON.stringify(
        {
          cx,
          cz,
          y0: s.y0,
          rows: s.rows,
          updatedAt: new Date(s.updatedAt).toISOString(),
          checksum: s.checksum(),
          cells: Object.fromEntries(CLASS_NAMES.map((n, i) => [n, counts[i]])),
          top: [...s.top],
          marks: s.markList(),
        },
        null,
        1,
      ),
    );
    return 0;
  }
  if (cmd === 'surface') {
    const cx = Number(rest[0]);
    const cz = Number(rest[1]);
    const cache = new WorldCache({ dir, readOnly: true });
    cache.useDimension(dim);
    const s = cache.cachedSummary(cx, cz);
    if (!s) {
      console.error(`chunk ${cx},${cz} not cached`);
      return 1;
    }
    const columns: Record<string, unknown>[] = [];
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) columns.push({ x: cx * 16 + x, z: cz * 16 + z, top: s.surfaceAt(x, z) ?? null, ...(s.surf?.under ? { under: s.surfaceAt(x, z, 'under') ?? null } : {}) });
    console.log(JSON.stringify({ cx, cz, surface: s.surf !== undefined, names: s.surf?.names ?? [], columns }));
    return 0;
  }
  console.error(`unknown command ${cmd}`);
  return 2;
}

const entry = process.argv[1]?.replaceAll('\\', '/') ?? '';
if (entry.endsWith('cache/cli.ts')) process.exit(main(process.argv.slice(2)));
