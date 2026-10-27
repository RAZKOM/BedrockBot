// Track AF (wave 8, docs/food.md "Herd memory", docs/decisions/0027): herd marks, the one mark kind
// of the world cache that is not a block. Every passive food mob the bot sees is recorded per 16-block
// cell (= chunk column) of its dimension: where the group stood (mean feet position), how many adults
// and babies of each kind, wild or inside a pen, and when it was seen. The food finder walks to the
// nearest marks when nothing is in range; a mark is dropped when the bot gets there and finds nothing.
//
// Block marks live inside the chunk summaries (summary.ts) and are rebuilt from the blocks whenever a
// column loads, so an animal (an entity, not a block) cannot ride on them. Herd marks are a small
// sidecar of the same cache directory instead: `<cache dir>[/dim<n>]/herds.json`, written atomically
// with the cache's flush (WorldCache.flush / flushSync) and read lazily on the first lookup. Without a
// directory (no world cache attached: tests, `BEDROCKBOT_CACHE=0`) the store is in memory only.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Vec3 } from '../types.ts';

export interface HerdCounts {
  adults: number;
  babies: number;
}

export interface HerdMark {
  /** Chunk column (16-block cell). */
  cx: number;
  cz: number;
  /** Mean feet position of the group (rounded to 0.1). */
  x: number;
  y: number;
  z: number;
  /** Mobs outside pens by kind (`cow`, `pig`, ...). */
  wild: Record<string, HerdCounts>;
  /** Mobs inside a pen by kind. */
  penned: Record<string, HerdCounts>;
  /** Wall-clock ms when it was last seen (Date.now()). */
  at: number;
}

/** What the food skills use (WorldCache.herds, or an in-memory HerdMarks). */
export interface HerdMarkStore {
  get(cx: number, cz: number): HerdMark | undefined;
  set(m: HerdMark): void;
  clear(cx: number, cz: number): boolean;
  /** Marks whose position lies within `radius` (horizontal) of `origin`, nearest first. */
  near(origin: Vec3, radius: number): HerdMark[];
  readonly size: number;
}

export const HERD_FILE = 'herds.json';
const FILE_VERSION = 1;

export interface HerdMarksOptions {
  /** The cache directory (`<config dir>/cache/<server id>`); undefined = in memory only. */
  dir?: string | undefined;
  /** The dimension lookups refer to. Default 0 (overworld). */
  dimension?: () => number;
  readOnly?: boolean;
  /** Marks kept per dimension (the oldest are dropped). Default 2048. */
  max?: number;
}

const key = (cx: number, cz: number): string => `${cx},${cz}`;

export class HerdMarks implements HerdMarkStore {
  private readonly dims = new Map<number, Map<string, HerdMark>>();
  private readonly dirty = new Set<number>();
  private readonly dir: string | undefined;
  private readonly dimension: () => number;
  private readonly readOnly: boolean;
  private readonly max: number;
  private writing: Promise<void> | undefined;
  /** Load / write failures (logged by the owner through `lastError`). */
  errors = 0;
  lastError: string | undefined;

  constructor(opts: HerdMarksOptions = {}) {
    this.dir = opts.dir;
    this.dimension = opts.dimension ?? (() => 0);
    this.readOnly = opts.readOnly ?? false;
    this.max = opts.max ?? 2048;
  }

  /** `dir` for the overworld, `dir/dim<n>` for the others (like the region files). */
  fileOf(dim: number): string | undefined {
    if (!this.dir) return undefined;
    return dim === 0 ? join(this.dir, HERD_FILE) : join(this.dir, `dim${dim}`, HERD_FILE);
  }

  private marks(dim = this.dimension()): Map<string, HerdMark> {
    let m = this.dims.get(dim);
    if (m) return m;
    m = new Map();
    this.dims.set(dim, m);
    const file = this.fileOf(dim);
    if (file && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as { version?: number; marks?: unknown };
        if (raw.version === FILE_VERSION && Array.isArray(raw.marks)) {
          for (const v of raw.marks) {
            const h = parseMark(v);
            if (h) m.set(key(h.cx, h.cz), h);
          }
        }
      } catch (e) {
        this.errors++;
        this.lastError = `reading ${file}: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    return m;
  }

  get size(): number {
    return this.marks().size;
  }

  get(cx: number, cz: number): HerdMark | undefined {
    return this.marks().get(key(cx, cz));
  }

  set(h: HerdMark): void {
    const dim = this.dimension();
    const m = this.marks(dim);
    const k = key(h.cx, h.cz);
    m.delete(k); // newest last: eviction drops the oldest insertion
    m.set(k, h);
    while (m.size > this.max) {
      let oldest: string | undefined;
      let at = Infinity;
      for (const [kk, v] of m) {
        if (v.at < at) {
          at = v.at;
          oldest = kk;
        }
      }
      if (oldest === undefined) break;
      m.delete(oldest);
    }
    this.dirty.add(dim);
  }

  clear(cx: number, cz: number): boolean {
    const dim = this.dimension();
    const had = this.marks(dim).delete(key(cx, cz));
    if (had) this.dirty.add(dim);
    return had;
  }

  near(origin: Vec3, radius: number): HerdMark[] {
    const out: { h: HerdMark; d: number }[] = [];
    for (const h of this.marks().values()) {
      const d = Math.hypot(h.x - origin.x, h.z - origin.z);
      if (d <= radius) out.push({ h, d });
    }
    out.sort((a, b) => a.d - b.d);
    return out.map((o) => o.h);
  }

  /** Every mark of the current dimension (status, tests). */
  all(): HerdMark[] {
    return [...this.marks().values()];
  }

  private snapshot(dim: number): string {
    return `${JSON.stringify({ version: FILE_VERSION, marks: [...(this.dims.get(dim)?.values() ?? [])] })}\n`;
  }

  /** Writes the changed dimensions (async, temp file + rename). */
  async flush(): Promise<void> {
    if (this.readOnly || !this.dir || this.dirty.size === 0) return;
    if (this.writing) await this.writing;
    const dims = [...this.dirty];
    this.dirty.clear();
    const p = (async () => {
      for (const dim of dims) {
        const file = this.fileOf(dim)!;
        const tmp = `${file}.${process.pid}.tmp`;
        try {
          await mkdir(dirname(file), { recursive: true });
          await writeFile(tmp, this.snapshot(dim), 'utf8');
          await rename(tmp, file);
        } catch (e) {
          this.dirty.add(dim);
          this.errors++;
          this.lastError = `writing ${file}: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
    })();
    this.writing = p;
    await p;
    if (this.writing === p) this.writing = undefined;
  }

  /** Synchronous write of the changed dimensions (exit). */
  flushSync(): void {
    if (this.readOnly || !this.dir) return;
    for (const dim of [...this.dirty]) {
      const file = this.fileOf(dim)!;
      try {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, this.snapshot(dim), 'utf8');
        renameSync(tmp, file);
        this.dirty.delete(dim);
      } catch (e) {
        this.errors++;
        this.lastError = `writing ${file}: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }
}

function counts(v: unknown): Record<string, HerdCounts> {
  const out: Record<string, HerdCounts> = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, c] of Object.entries(v as Record<string, unknown>)) {
    const o = c as { adults?: unknown; babies?: unknown } | null;
    const a = Number(o?.adults ?? 0);
    const b = Number(o?.babies ?? 0);
    if (Number.isFinite(a) && Number.isFinite(b)) out[k] = { adults: a, babies: b };
  }
  return out;
}

function parseMark(v: unknown): HerdMark | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const n = ['cx', 'cz', 'x', 'y', 'z', 'at'].map((k) => Number(o[k]));
  if (!n.every((x) => Number.isFinite(x))) return undefined;
  return { cx: n[0]!, cz: n[1]!, x: n[2]!, y: n[3]!, z: n[4]!, at: n[5]!, wild: counts(o.wild), penned: counts(o.penned) };
}
