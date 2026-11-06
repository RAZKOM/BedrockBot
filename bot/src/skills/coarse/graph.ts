// Track CB (ADR 0066, docs/coarse.md "The graph"): the coarse graph over every chunk the source knows,
// built lazily per chunk on demand and kept in an LRU (memory stays bounded whatever the cache holds).
// A chunk's volumes and intra-chunk portals are built together (chunk.ts); the portals across a chunk
// border are built when a search first steps over it and cached against both sides' build numbers;
// a chunk that loads or changes is dropped (`invalidate`) and rebuilt on the next lookup.
import type { Vec3 } from '../../world/types.ts';
import { borderPortals, buildKnownChunk, buildUnknownChunk, DIGGABLE_INTO, digPortal, labelAt, SKY, type ChunkGraph } from './chunk.ts';
import type { CoarseSource } from './source.ts';
import type { Portal, PortalAxis, PortalId, Volume, VolumeId } from './types.ts';

const OFF = 2 ** 21;
/** Numeric key of (dimension, cx, cz). */
export const chunkKey = (dim: number, cx: number, cz: number): number => (dim * 2 ** 22 + (cx + OFF)) * 2 ** 22 + (cz + OFF);

export interface CoarseGraphOptions {
  /** Chunk graphs kept in memory (LRU). Default 1024 (about 20 to 60 KB each on a generated world). */
  maxChunks?: number;
}

export interface CoarseGraphStats {
  builds: number;
  buildMs: number;
  borders: number;
  borderMs: number;
  evicted: number;
}

interface Border {
  buildA: number;
  buildB: number;
  portals: Portal[];
}

/** Which chunk and axis a cell-based portal id lives on. */
function parsePortalId(id: PortalId): { dim: number; axis: PortalAxis; x: number; y: number; z: number; dug: boolean } | undefined {
  const parts = id.split(':');
  if (parts.length < 5) return undefined;
  const axis = parts[1];
  if (axis !== 'x' && axis !== 'y' && axis !== 'z') return undefined;
  const dim = Number(parts[0]);
  const x = Number(parts[2]);
  const y = Number(parts[3]);
  const z = Number(parts[4]);
  if (![dim, x, y, z].every(Number.isInteger)) return undefined;
  return { dim, axis, x, y, z, dug: parts[5] === 'dig' };
}

function parseVolumeId(id: VolumeId): { dim: number; cx: number; cz: number } | undefined {
  const parts = id.split(':');
  if (parts.length !== 5) return undefined;
  const dim = Number(parts[0]);
  const cx = Number(parts[1]);
  const cz = Number(parts[2]);
  if (![dim, cx, cz].every(Number.isInteger)) return undefined;
  return { dim, cx, cz };
}

export class CoarseGraph {
  readonly source: CoarseSource;
  readonly stats: CoarseGraphStats = { builds: 0, buildMs: 0, borders: 0, borderMs: 0, evicted: 0 };
  private readonly maxChunks: number;
  private readonly chunks = new Map<number, ChunkGraph>();
  /** Border portals by (lower chunk key, axis). */
  private readonly borders = new Map<string, Border>();
  private builds = 0;
  private _revision = 0;

  constructor(source: CoarseSource, opts: CoarseGraphOptions = {}) {
    this.source = source;
    this.maxChunks = opts.maxChunks ?? 1024;
  }

  /** Bumped whenever a chunk's volumes or portals may have changed (`invalidate`). */
  get revision(): number {
    return this._revision;
  }

  /** Chunk graphs in memory. */
  get size(): number {
    return this.chunks.size;
  }

  /** The graph of chunk (cx, cz), built when needed. */
  chunk(cx: number, cz: number, dim: number): ChunkGraph {
    const k = chunkKey(dim, cx, cz);
    let g = this.chunks.get(k);
    if (g) {
      this.chunks.delete(k);
      this.chunks.set(k, g);
      return g;
    }
    const cells = this.source.chunk(cx, cz, dim);
    const build = ++this.builds;
    g = cells ? buildKnownChunk(cells, dim, cx, cz, this.source.minY, this.source.maxY, build) : buildUnknownChunk(dim, cx, cz, this.source.minY, this.source.maxY, build);
    this.stats.builds++;
    this.stats.buildMs += g.ms;
    this.chunks.set(k, g);
    while (this.chunks.size > this.maxChunks) {
      const first = this.chunks.keys().next().value!;
      const old = this.chunks.get(first)!;
      this.chunks.delete(first);
      this.dropBorders(old.dim, old.cx, old.cz);
      this.stats.evicted++;
    }
    return g;
  }

  /** The graph of a chunk if it is built (no build). */
  peek(cx: number, cz: number, dim: number): ChunkGraph | undefined {
    return this.chunks.get(chunkKey(dim, cx, cz));
  }

  /** Drop a chunk's graph (its cells changed); rebuilt on the next lookup. Returns true when one was dropped. */
  invalidate(cx: number, cz: number, dim: number): boolean {
    this._revision++;
    const had = this.chunks.delete(chunkKey(dim, cx, cz));
    this.dropBorders(dim, cx, cz);
    return had;
  }

  private dropBorders(dim: number, cx: number, cz: number): void {
    this.borders.delete(`${chunkKey(dim, cx, cz)}x`);
    this.borders.delete(`${chunkKey(dim, cx, cz)}z`);
    this.borders.delete(`${chunkKey(dim, cx - 1, cz)}x`);
    this.borders.delete(`${chunkKey(dim, cx, cz - 1)}z`);
  }

  /** The portals across the border between chunk (cx, cz) and its +axis neighbour. */
  border(cx: number, cz: number, dim: number, axis: 'x' | 'z'): Portal[] {
    const a = this.chunk(cx, cz, dim);
    const b = axis === 'x' ? this.chunk(cx + 1, cz, dim) : this.chunk(cx, cz + 1, dim);
    const key = `${chunkKey(dim, cx, cz)}${axis}`;
    const have = this.borders.get(key);
    if (have?.buildA === a.build && have.buildB === b.build) return have.portals;
    const t0 = performance.now();
    const portals = borderPortals(a, b, axis);
    this.stats.borders++;
    this.stats.borderMs += performance.now() - t0;
    this.borders.set(key, { buildA: a.build, buildB: b.build, portals });
    return portals;
  }

  /** The chunk and label of a volume. */
  private locate(v: Volume): { g: ChunkGraph; label: number } | undefined {
    const p = parseVolumeId(v.id);
    if (!p) return undefined;
    const g = this.chunk(p.cx, p.cz, p.dim);
    const label = g.volumes.indexOf(v) + 1;
    if (label > 0) return { g, label };
    // the same volume from an older build: match by id
    const cur = g.byId.get(v.id);
    return cur ? { g, label: g.volumes.indexOf(cur) + 1 } : undefined;
  }

  /** Every real portal of a volume: inside its chunk and across the chunk's four borders. */
  portalsOf(v: Volume): Portal[] {
    const at = this.locate(v);
    if (!at) return [];
    const { g } = at;
    const out: Portal[] = [...(g.byLabel.get(at.label) ?? [])];
    const id = g.volumes[at.label - 1]!.id;
    const mine = (ps: readonly Portal[]): void => {
      for (const p of ps) if (p.a === id || p.b === id) out.push(p);
    };
    mine(this.border(g.cx, g.cz, g.dim, 'x'));
    mine(this.border(g.cx, g.cz, g.dim, 'z'));
    mine(this.border(g.cx - 1, g.cz, g.dim, 'x'));
    mine(this.border(g.cx, g.cz - 1, g.dim, 'z'));
    return out;
  }

  /**
   * Synthetic dig portals from `v` (mine mode): to every other volume of its chunk (the sky included)
   * and to the volumes of the neighbouring chunks' sections at its height, where no real portal joins
   * them, never into water.
   */
  digPortalsOf(v: Volume, real: readonly Portal[]): Portal[] {
    const at = this.locate(v);
    if (!at) return [];
    const { g } = at;
    const me = g.volumes[at.label - 1]!;
    const out: Portal[] = [];
    const add = (w: Volume, axis: PortalAxis): void => {
      if (w === me || !DIGGABLE_INTO.has(w.kind) || w.cells === 0) return;
      const p = digPortal(g.dim, me, w, axis, real);
      if (p) out.push(p);
    };
    const syOf = (w: Volume): number => w.min.y >> 4;
    const sy = me.kind === 'sky' ? (me.min.y - 1) >> 4 : syOf(me);
    for (const w of g.volumes) {
      if (w.kind === 'sky' || me.kind === 'sky' || syOf(w) !== sy) {
        if (w.kind === 'sky' || me.kind === 'sky' || Math.abs(syOf(w) - sy) === 1) add(w, 'y');
        continue;
      }
      // the same section: sideways along the axis the two boxes are farther apart on
      const dx = (w.min.x + w.max.x - me.min.x - me.max.x) / 2;
      const dz = (w.min.z + w.max.z - me.min.z - me.max.z) / 2;
      add(w, Math.abs(dx) >= Math.abs(dz) ? 'x' : 'z');
    }
    const side = (nx: number, nz: number, axis: 'x' | 'z'): void => {
      const n = this.chunk(nx, nz, g.dim);
      for (const w of n.volumes) if (w.kind !== 'sky' && (me.kind === 'sky' ? true : Math.abs(syOf(w) - sy) <= 0)) add(w, axis);
    };
    if (me.kind !== 'sky') {
      side(g.cx + 1, g.cz, 'x');
      side(g.cx - 1, g.cz, 'x');
      side(g.cx, g.cz + 1, 'z');
      side(g.cx, g.cz - 1, 'z');
    }
    return out;
  }

  /** The volume holding cell p (feet cell), or undefined when p is solid or outside the world. */
  volumeAt(p: Vec3, dim: number): Volume | undefined {
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    const z = Math.floor(p.z);
    if (y < this.source.minY || y > this.source.maxY) return undefined;
    const g = this.chunk(x >> 4, z >> 4, dim);
    const l = labelAt(g, x & 15, y, z & 15);
    return l === 0 ? undefined : g.volumes[l - 1];
  }

  /** A volume by id (its chunk built when needed), if it still exists. */
  volume(id: VolumeId): Volume | undefined {
    const p = parseVolumeId(id);
    if (!p) return undefined;
    return this.chunk(p.cx, p.cz, p.dim).byId.get(id);
  }

  /** The volume on the other side of a portal from `v`. */
  across(p: Portal, v: Volume): Volume | undefined {
    return this.volume(p.a === v.id ? p.b : p.a);
  }

  /** A real portal by id: its opening's first cell names the chunk; dig portals are not found. */
  portal(id: PortalId): Portal | undefined {
    const p = parsePortalId(id);
    if (!p || p.dug) return undefined;
    const cx = p.x >> 4;
    const cz = p.z >> 4;
    const g = this.chunk(cx, cz, p.dim);
    for (const q of g.portals) if (q.id === id) return q;
    const lx = p.x & 15;
    const lz = p.z & 15;
    if (p.axis === 'x' && lx === 15) for (const q of this.border(cx, cz, p.dim, 'x')) if (q.id === id) return q;
    if (p.axis === 'z' && lz === 15) for (const q of this.border(cx, cz, p.dim, 'z')) if (q.id === id) return q;
    return undefined;
  }

  /** The sky volume's label (exported for tests). */
  static readonly SKY = SKY;
}
