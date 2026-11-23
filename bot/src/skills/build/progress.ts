// Track B3 (decision 0128, docs/build.md "Resume"): a build's progress on disk, so `!build resume` (and a start after a
// restart, the `buildResume` setting) goes on where it stopped.
//
// The file is <config dir>/build/<server>.json (BEDROCKBOT_BUILD_DIR/<server>.json for tests; `buildProgress` in the CLI
// values names a file of its own; memory only with --no-config). It holds the command (its words and the feet it was
// typed at, so `~` and a file's default anchor come out the same), the label, a structure file's name and SHA-256, the
// targets' box, the cells done as a bitset over that box (base64), who started it (the fetch's commands run as them),
// and the state: `running` (the bot went away while building: a restart resumes it), `stopped` (`!build stop`, a death,
// a stop: only `!build resume` goes on) or `done`. Written atomically (a temp file, then a rename), at most every
// SAVE_MS while cells are done and at once when the state changes.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { waypointsLocation } from '../../waypoints/store.ts';
import type { BuildKind, Cell } from './types.ts';

/** Saves while cells are done: at most this often. */
export const SAVE_MS = 10_000;
/** A scaffold block placed is saved within this (a restart right after a pillar still knows its column). */
export const SCAFFOLD_SAVE_MS = 1000;
/** The most cells a progress box holds (8 Mi: a 1 MiB bitset). */
export const PROGRESS_MAX_CELLS = 8 * 1024 * 1024;

export type ProgressState = 'running' | 'stopped' | 'done';

export interface ProgressOwner {
  type: string;
  source: string;
  xuid: string;
}

export interface ProgressData {
  v: 1;
  /** The `!build` words (without `build`). */
  args: string[];
  /** The feet the command was typed at. */
  feet: Cell;
  label: string;
  kind: BuildKind;
  /** A structure file: its name and the SHA-256 of what was read (its bytes). */
  file?: { name: string; sha256: string };
  /** The targets' box (the bitset's cells, x fastest, then z, then y). */
  box: { min: Cell; max: Cell };
  /** Target cells (without the refused ones). */
  total: number;
  /** Cells done. */
  count: number;
  done: string;
  state: ProgressState;
  fetch: boolean;
  /** Scaffold blocks of the build out in the world (`x,y,z`): a resume digs those still there first. */
  scaffolds?: string[];
  owner?: ProgressOwner;
  /** ISO time of the save. */
  at: string;
}

/** The progress file: `buildProgress` in the values, BEDROCKBOT_BUILD_DIR/<server>.json, <config dir>/build/<server>.json, or none (--no-config). */
export function buildProgressFile(values: Readonly<Record<string, unknown>> | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!values) return undefined;
  if (typeof values.buildProgress === 'string' && values.buildProgress) return values.buildProgress;
  const loc = waypointsLocation(values, env);
  const name = `${loc.server.replace(/[^\w.-]/g, '_')}.json`;
  if (env.BEDROCKBOT_BUILD_DIR) return join(env.BEDROCKBOT_BUILD_DIR, name);
  return loc.file ? join(dirname(dirname(loc.file)), 'build', basename(name)) : undefined;
}

/** SHA-256 of a file's bytes, or of `fallback` when the file cannot be read (a structure made in a test). */
export function fileHash(file: string | undefined, fallback: () => string): string {
  const h = createHash('sha256');
  try {
    if (file && existsSync(file)) {
      h.update(readFileSync(file));
      return h.digest('hex');
    }
  } catch {
    // the fallback below
  }
  h.update(fallback());
  return h.digest('hex');
}

const volume = (b: { min: Cell; max: Cell }) => (b.max.x - b.min.x + 1) * (b.max.y - b.min.y + 1) * (b.max.z - b.min.z + 1);

/** The saved progress, or undefined (no file; unreadable: logged). */
export function loadProgress(file: string | undefined, warn: (m: string) => void = () => undefined): ProgressData | undefined {
  if (!file || !existsSync(file)) return undefined;
  try {
    const d = JSON.parse(readFileSync(file, 'utf8')) as ProgressData;
    if (d?.v === 1 && Array.isArray(d.args) && d.box && typeof d.done === 'string') return d;
    warn(`build: ${file} is not a build progress file (v 1)`);
  } catch (e) {
    warn(`build: ${file} could not be read (${e instanceof Error ? e.message : String(e)})`);
  }
  return undefined;
}

/** A build's cells done and its state, kept in memory and written to the file. */
export class BuildProgress {
  readonly data: ProgressData;
  private readonly bits: Uint8Array;
  private readonly sx: number;
  private readonly sz: number;
  private readonly file: string | undefined;
  private savedAt = -Infinity;
  private dirty = false;
  private readonly now: () => number;
  private readonly warn: (m: string) => void;
  private readonly scaff = new Set<string>();

  constructor(file: string | undefined, data: Omit<ProgressData, 'v' | 'done' | 'count' | 'at' | 'state'> & Partial<Pick<ProgressData, 'done' | 'count' | 'state'>>, o: { now?: () => number; warn?: (m: string) => void } = {}) {
    const n = volume(data.box);
    if (n > PROGRESS_MAX_CELLS) throw new Error(`a box of ${n} cells is too big to keep progress for`);
    this.file = file;
    this.now = o.now ?? Date.now;
    this.warn = o.warn ?? (() => undefined);
    this.sx = data.box.max.x - data.box.min.x + 1;
    this.sz = data.box.max.z - data.box.min.z + 1;
    this.bits = new Uint8Array(Math.ceil(n / 8));
    if (data.done) {
      const b = Buffer.from(data.done, 'base64');
      this.bits.set(b.subarray(0, this.bits.length));
    }
    for (const k of data.scaffolds ?? []) if (/^-?\d+,-?\d+,-?\d+$/.test(k)) this.scaff.add(k);
    this.data = { v: 1, ...data, done: '', count: 0, state: data.state ?? 'running', at: new Date(this.now()).toISOString() };
    delete this.data.scaffolds;
    let c = 0;
    for (const byte of this.bits) for (let k = byte; k; k &= k - 1) c++;
    this.data.count = c;
  }

  private index(c: Cell): number {
    const { min, max } = this.data.box;
    if (c.x < min.x || c.y < min.y || c.z < min.z || c.x > max.x || c.y > max.y || c.z > max.z) return -1;
    return ((c.y - min.y) * this.sz + (c.z - min.z)) * this.sx + (c.x - min.x);
  }

  has(c: Cell): boolean {
    const i = this.index(c);
    return i >= 0 && (this.bits[i >> 3]! & (1 << (i & 7))) !== 0;
  }

  /** A cell done (saved within SAVE_MS). */
  mark(c: Cell): void {
    const i = this.index(c);
    if (i < 0 || (this.bits[i >> 3]! & (1 << (i & 7))) !== 0) return;
    this.bits[i >> 3]! |= 1 << (i & 7);
    this.data.count++;
    this.dirty = true;
    if (this.now() - this.savedAt >= SAVE_MS) this.save();
  }

  /** A done cell not done any more (a resume found it changed: placed again). */
  unmark(c: Cell): void {
    const i = this.index(c);
    if (i < 0 || (this.bits[i >> 3]! & (1 << (i & 7))) === 0) return;
    this.bits[i >> 3]! &= ~(1 << (i & 7));
    this.data.count--;
    this.dirty = true;
  }

  get count(): number {
    return this.data.count;
  }

  /** A scaffold block of the build placed (`up`) or dug. */
  scaffold(c: Cell, up: boolean): void {
    const k = `${c.x},${c.y},${c.z}`;
    if (up === this.scaff.has(k)) return;
    if (up) this.scaff.add(k);
    else this.scaff.delete(k);
    this.dirty = true;
    if (up && this.now() - this.savedAt >= SCAFFOLD_SAVE_MS) this.save();
  }

  /** The scaffold blocks out, as cells. */
  scaffoldCells(): Cell[] {
    return [...this.scaff].map((k) => {
      const [x, y, z] = k.split(',').map(Number) as [number, number, number];
      return { x, y, z };
    });
  }

  /** Every cell done, in box order. */
  *cells(): Generator<Cell> {
    const { min } = this.data.box;
    for (let i = 0; i < this.bits.length; i++) {
      const byte = this.bits[i]!;
      if (!byte) continue;
      for (let k = 0; k < 8; k++) {
        if (!(byte & (1 << k))) continue;
        const n = i * 8 + k;
        const x = n % this.sx;
        const z = Math.floor(n / this.sx) % this.sz;
        const y = Math.floor(n / (this.sx * this.sz));
        yield { x: min.x + x, y: min.y + y, z: min.z + z };
      }
    }
  }

  setState(state: ProgressState): void {
    if (this.data.state === state && !this.dirty && this.savedAt !== -Infinity) return;
    this.data.state = state;
    this.save();
  }

  /** Write the file now (nothing without a file). */
  save(): void {
    this.savedAt = this.now();
    this.dirty = false;
    if (!this.file) return;
    this.data.at = new Date(this.now()).toISOString();
    this.data.done = Buffer.from(this.bits).toString('base64');
    if (this.scaff.size) this.data.scaffolds = [...this.scaff];
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(this.data)}\n`);
      renameSync(tmp, this.file);
    } catch (e) {
      this.warn(`build: progress not saved to ${this.file}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.data.done = '';
      delete this.data.scaffolds;
    }
  }

  /** Write what is not written yet. */
  flush(): void {
    if (this.dirty) this.save();
  }
}
