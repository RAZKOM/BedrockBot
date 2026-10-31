// Track AG (wave 9, docs/home.md "Chest memory"): what the bot knows about the containers at home.
// One record per container block the bot has found (chest, trapped chest, barrel, shulker box): its
// position and kind, what it held when the bot last looked inside (items by name, free slots, room on
// partial stacks, empty and full shulker boxes), whether it is a double chest (and its other half),
// when it was read, and the label the owner gave it (`!chests label x y z ores`).
//
// Like the herd marks (herds.ts) this is a small sidecar of the world cache's directory:
// `<cache dir>[/dim<n>]/chests.json`, written atomically with the cache's flush (WorldCache.flush /
// flushSync) and read lazily on the first lookup. Without a directory (no world cache attached:
// tests, `BEDROCKBOT_CACHE=0`) the memory lives in memory only.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Vec3 } from '../types.ts';

export interface ChestRecord {
  x: number;
  y: number;
  z: number;
  /** Block name: chest, trapped_chest, barrel, undyed_shulker_box ... */
  kind: string;
  /** The owner's label (`ores`, `wood`, `food`, `blocks`, `junk`, `tools`, or free text). */
  label?: string;
  /** Window size when read (27; a double chest 54); 0 = never opened. */
  size: number;
  /** Free slots when read. */
  free: number;
  /** Slots holding something when read. */
  stacks: number;
  /** Items by name when read. */
  contents: Record<string, number>;
  /** Room left on partial stacks by item name when read. */
  room: Record<string, number>;
  /** Shulker boxes inside: without items / with items. */
  boxes: { empty: number; full: number };
  /** Track AS: items inside the full shulker boxes by name (`!bring`, the `!get` hint); absent when none. */
  inBoxes?: Record<string, number>;
  /** Full stacks (count = max stack size) by item name when read (the tidy steps need 27 of them); absent when none. */
  fullStacks?: Record<string, number>;
  /** A double chest (54 slots). */
  double: boolean;
  /** The other half of a double chest (never a target of its own). */
  partner?: Vec3;
  /** Wall-clock ms of the last read (Date.now()); 0 = found but never opened. */
  readAt: number;
  /** Track AN: why the last scan could not get to it (`no path`, `path 40 blocks`, `goto: unreachable`); scans skip it for an hour (or until `!chests scan`). */
  unreachable?: string;
  /** Track AN: wall-clock ms when it was found unreachable. */
  unreachableAt?: number;
}

/** What the home skills use (WorldCache.chests, or an in-memory ChestMemory). */
export interface ChestMemoryStore {
  get(p: Vec3): ChestRecord | undefined;
  set(r: ChestRecord): void;
  delete(p: Vec3): boolean;
  /** Records within `radius` (3D, block centres) of `origin`, nearest first. */
  near(origin: Vec3, radius: number): ChestRecord[];
  all(): ChestRecord[];
  readonly size: number;
}

export const CHEST_FILE = 'chests.json';
const FILE_VERSION = 1;

export interface ChestMemoryOptions {
  /** The cache directory (`<config dir>/cache/<server id>`); undefined = in memory only. */
  dir?: string | undefined;
  /** The dimension lookups refer to. Default 0 (overworld). */
  dimension?: () => number;
  readOnly?: boolean;
  /** Records kept per dimension (the oldest reads are dropped). Default 512. */
  max?: number;
}

export const chestKey = (p: Vec3): string => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

export class ChestMemory implements ChestMemoryStore {
  private readonly dims = new Map<number, Map<string, ChestRecord>>();
  private readonly dirty = new Set<number>();
  private readonly dir: string | undefined;
  private readonly dimension: () => number;
  private readonly readOnly: boolean;
  private readonly max: number;
  private writing: Promise<void> | undefined;
  errors = 0;
  lastError: string | undefined;

  constructor(opts: ChestMemoryOptions = {}) {
    this.dir = opts.dir;
    this.dimension = opts.dimension ?? (() => 0);
    this.readOnly = opts.readOnly ?? false;
    this.max = opts.max ?? 512;
  }

  fileOf(dim: number): string | undefined {
    if (!this.dir) return undefined;
    return dim === 0 ? join(this.dir, CHEST_FILE) : join(this.dir, `dim${dim}`, CHEST_FILE);
  }

  private records(dim = this.dimension()): Map<string, ChestRecord> {
    let m = this.dims.get(dim);
    if (m) return m;
    m = new Map();
    this.dims.set(dim, m);
    const file = this.fileOf(dim);
    if (file && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as { version?: number; chests?: unknown };
        if (raw.version === FILE_VERSION && Array.isArray(raw.chests)) {
          for (const v of raw.chests) {
            const r = parseRecord(v);
            if (r) m.set(chestKey(r), r);
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
    return this.records().size;
  }

  get(p: Vec3): ChestRecord | undefined {
    return this.records().get(chestKey(p));
  }

  set(r: ChestRecord): void {
    const dim = this.dimension();
    const m = this.records(dim);
    const k = chestKey(r);
    m.delete(k);
    m.set(k, r);
    while (m.size > this.max) {
      let oldest: string | undefined;
      let at = Infinity;
      for (const [kk, v] of m) {
        if (v.readAt < at) {
          at = v.readAt;
          oldest = kk;
        }
      }
      if (oldest === undefined) break;
      m.delete(oldest);
    }
    this.dirty.add(dim);
  }

  delete(p: Vec3): boolean {
    const dim = this.dimension();
    const had = this.records(dim).delete(chestKey(p));
    if (had) this.dirty.add(dim);
    return had;
  }

  near(origin: Vec3, radius: number): ChestRecord[] {
    const out: { r: ChestRecord; d: number }[] = [];
    for (const r of this.records().values()) {
      const d = Math.hypot(r.x + 0.5 - origin.x, r.y + 0.5 - origin.y, r.z + 0.5 - origin.z);
      if (d <= radius) out.push({ r, d });
    }
    out.sort((a, b) => a.d - b.d);
    return out.map((o) => o.r);
  }

  all(): ChestRecord[] {
    return [...this.records().values()];
  }

  private snapshot(dim: number): string {
    return `${JSON.stringify({ version: FILE_VERSION, chests: [...(this.dims.get(dim)?.values() ?? [])] })}\n`;
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

function numbers(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, c] of Object.entries(v as Record<string, unknown>)) {
    const n = Number(c);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

function parseRecord(v: unknown): ChestRecord | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const n = ['x', 'y', 'z', 'size', 'free', 'stacks', 'readAt'].map((k) => Number(o[k] ?? 0));
  if (!n.every((x) => Number.isFinite(x)) || typeof o.kind !== 'string') return undefined;
  const b = (o.boxes ?? {}) as { empty?: unknown; full?: unknown };
  const p = o.partner as Vec3 | undefined;
  const partner = p && [p.x, p.y, p.z].every((x) => Number.isFinite(Number(x))) ? { x: Number(p.x), y: Number(p.y), z: Number(p.z) } : undefined;
  return {
    x: n[0]!,
    y: n[1]!,
    z: n[2]!,
    kind: o.kind,
    ...(typeof o.label === 'string' && o.label ? { label: o.label } : {}),
    size: n[3]!,
    free: n[4]!,
    stacks: n[5]!,
    contents: numbers(o.contents),
    room: numbers(o.room),
    boxes: { empty: Number(b.empty ?? 0) || 0, full: Number(b.full ?? 0) || 0 },
    ...(o.inBoxes && typeof o.inBoxes === 'object' && Object.keys(numbers(o.inBoxes)).length ? { inBoxes: numbers(o.inBoxes) } : {}), // Track AS
    ...(o.fullStacks && typeof o.fullStacks === 'object' && Object.keys(numbers(o.fullStacks)).length ? { fullStacks: numbers(o.fullStacks) } : {}),
    double: o.double === true,
    ...(partner ? { partner } : {}),
    readAt: n[6]!,
    ...(typeof o.unreachable === 'string' && o.unreachable ? { unreachable: o.unreachable, unreachableAt: Number(o.unreachableAt) || 0 } : {}), // Track AN
  };
}
