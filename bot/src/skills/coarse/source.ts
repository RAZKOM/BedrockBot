// Track CB (ADR 0066, docs/coarse.md): what the coarse graph reads. One 2-bit class per cell (the world
// cache's: air / solid / water / avoid, world/cache/types.ts) for every chunk column ever seen, and
// nothing for the rest (unknown). Two adapters: the persistent world cache (live summaries of the loaded
// columns, decoded records of the others: `WorldCache.summary`) for the bot, and any `TerrainSource` (a
// generated test world) classified on the fly.
import { classify } from '../terrain/classify.ts';
import type { TerrainSource } from '../terrain/query.ts';
import { cellClassOf } from '../../world/cache/classes.ts';
import { CLS_AIR, type CellClass } from '../../world/cache/types.ts';
import type { BlockInfo } from '../../world/types.ts';

/** The cells of one chunk column as the graph builder reads them (`ChunkSummary` satisfies it). */
export interface ChunkCells {
  /** Lowest stored y. */
  readonly y0: number;
  /** Rows stored from y0; everything above is air. */
  readonly rows: number;
  /** Class at local (x, z) and absolute y; outside the stored rows: air. */
  cls(x: number, y: number, z: number): CellClass;
}

export interface CoarseSource {
  /** The dimension's floor and ceiling (cells outside are solid for the graph). */
  readonly minY: number;
  readonly maxY: number;
  /** The cells of chunk (cx, cz) in dimension `dim`, or undefined when never seen (an unknown chunk). */
  chunk(cx: number, cz: number, dim: number): ChunkCells | undefined;
}

/** What the world cache adapter needs (`WorldCache` and `World.chunks` satisfy it). */
export interface CacheLike {
  readonly dimension: number;
  summary(cx: number, cz: number): ChunkCells | undefined;
}

/** The world cache as a CoarseSource: live summaries of loaded columns first, then the decoded records; other dimensions are unknown. */
export function cacheSource(cache: CacheLike, dims: { readonly minY: number; readonly maxY: number }): CoarseSource {
  return {
    get minY() {
      return dims.minY;
    },
    get maxY() {
      return dims.maxY;
    },
    chunk(cx, cz, dim) {
      if (dim !== cache.dimension) return undefined;
      return cache.summary(cx, cz);
    },
  };
}

/** A dense class grid of one chunk column (1 byte per cell), built once from a block source. */
export class ClassGrid implements ChunkCells {
  readonly y0: number;
  readonly rows: number;
  readonly cells: Uint8Array;
  constructor(y0: number, rows: number) {
    this.y0 = y0;
    this.rows = rows;
    this.cells = new Uint8Array(rows * 256);
  }
  cls(x: number, y: number, z: number): CellClass {
    const r = y - this.y0;
    if (r < 0 || r >= this.rows) return CLS_AIR;
    return this.cells[r * 256 + ((z << 4) | x)] as CellClass;
  }
}

/** Options of `terrainSource`. */
export interface TerrainSourceOptions {
  /** Chunks the source answers for; others are unknown. Default: every chunk with at least one loaded cell. */
  known?: (cx: number, cz: number) => boolean;
  /** Dimension of the source. Default 0. */
  dim?: number;
}

/**
 * A TerrainSource (a generated test world, the live world without a cache) as a CoarseSource: a chunk
 * is known when `blockAt` answers for its cells; unanswered cells of a known chunk are solid. The class
 * of every block is the world cache's (`cellClassOf(classify(block))`), so tests see what the bot sees.
 */
export function terrainSource(src: TerrainSource & { readonly minY: number; readonly maxY: number }, opts: TerrainSourceOptions = {}): CoarseSource & { reset(cx?: number, cz?: number): void } {
  const dim = opts.dim ?? 0;
  const classes = new WeakMap<BlockInfo, CellClass>();
  const clsOf = (b: BlockInfo): CellClass => {
    let c = classes.get(b);
    if (c === undefined) {
      c = cellClassOf(classify(b));
      classes.set(b, c);
    }
    return c;
  };
  const built = new Map<string, ClassGrid | null>();
  return {
    minY: src.minY,
    maxY: src.maxY,
    chunk(cx, cz, d) {
      if (d !== dim) return undefined;
      if (opts.known && !opts.known(cx, cz)) return undefined;
      const k = `${cx},${cz}`;
      let g = built.get(k);
      if (g === undefined) {
        g = null;
        const rows = src.maxY - src.minY + 1;
        const grid = new ClassGrid(src.minY, rows);
        let any = false;
        for (let r = 0; r < rows; r++) {
          const y = src.minY + r;
          for (let z = 0; z < 16; z++) {
            for (let x = 0; x < 16; x++) {
              const b = src.blockAt(cx * 16 + x, y, cz * 16 + z);
              if (b) {
                any = true;
                grid.cells[r * 256 + ((z << 4) | x)] = clsOf(b);
              } else grid.cells[r * 256 + ((z << 4) | x)] = 1; // CLS_SOLID: outside the box
            }
          }
        }
        if (any) g = grid;
        built.set(k, g);
      }
      return g ?? undefined;
    },
    /** Forget the built grid of one chunk (or all): blocks changed in the source. The graph must be invalidated too. */
    reset(cx, cz) {
      if (cx === undefined || cz === undefined) built.clear();
      else built.delete(`${cx},${cz}`);
    },
  };
}
