// Navigation grid (PLAN.md task 3.5): where can the body stand, and is a column of cells free for it?
// A node is the integer cell (x, y, z) that contains the feet: feet height in [y, y + 1). The floor
// is either a partial block inside that cell (slab, carpet, snow layer, soul sand ...) or a block
// with a top of exactly 1 in the cell below. See docs/pathfinding.md.
import { classify, type TerrainClass } from '../terrain/classify.ts';
import type { TerrainSource } from '../terrain/query.ts';
import { PHYSICS } from '../input/physics.ts';

/** Packs integer block coordinates into one exact double (x, z within +-2^20, y within +-512). */
export function cellKey(x: number, y: number, z: number): number {
  return ((x + 1048576) * 2097152 + (z + 1048576)) * 1024 + (y + 512);
}

/** Result of `stand()`: a feet height, `BLOCKED`, or `UNKNOWN` (some block is not loaded). */
export const BLOCKED = Number.NaN;
export const UNKNOWN = undefined;

export class NavGrid {
  readonly source: TerrainSource;
  private readonly cells = new Map<number, TerrainClass>();
  /** stand() results (feet or NaN); unknown results are not cached. */
  private readonly stands = new Map<number, number>();
  /** Lookups served (for perf reports). */
  lookups = 0;

  constructor(source: TerrainSource) {
    this.source = source;
  }

  /** Classification of a cell, cached; undefined = not loaded. */
  cls(x: number, y: number, z: number): TerrainClass | undefined {
    this.lookups++;
    const k = cellKey(x, y, z);
    const hit = this.cells.get(k);
    if (hit) return hit;
    const b = this.source.blockAt(x, y, z);
    if (!b) return undefined; // not cached: chunks arrive later
    const c = classify(b);
    this.cells.set(k, c);
    return c;
  }

  /** Forget a cell (block update). */
  invalidate(x: number, y: number, z: number): void {
    this.cells.delete(cellKey(x, y, z));
    // stand(x, y', z) reads cells y' - 1 .. y' + 2 of its column
    for (let dy = -2; dy <= 1; dy++) this.stands.delete(cellKey(x, y + dy, z));
  }

  clear(): void {
    this.cells.clear();
    this.stands.clear();
  }

  /** The body may occupy this cell: no collision, no liquid, no hazard. undefined = unknown. */
  free(x: number, y: number, z: number): boolean | undefined {
    const c = this.cls(x, y, z);
    if (!c) return undefined;
    return c.boxes.length === 0 && !c.liquid && !c.danger;
  }

  /** Cells y0..y1 (inclusive) of a column are all free. undefined = some unknown. */
  freeColumn(x: number, y0: number, y1: number, z: number): boolean | undefined {
    for (let y = y0; y <= y1; y++) {
      const f = this.free(x, y, z);
      if (f !== true) return f;
    }
    return true;
  }

  /**
   * Feet height of a body standing in node (x, y, z), or BLOCKED (NaN), or UNKNOWN (undefined).
   * Checks the floor, the cell itself and the head room for a 1.8 high body.
   */
  stand(x: number, y: number, z: number): number | undefined {
    const k = cellKey(x, y, z);
    const hit = this.stands.get(k);
    if (hit !== undefined) return hit;
    const f = this.computeStand(x, y, z);
    if (f !== undefined) this.stands.set(k, f);
    return f;
  }

  private computeStand(x: number, y: number, z: number): number | undefined {
    const c = this.cls(x, y, z);
    if (!c) return UNKNOWN;
    let feet: number;
    if (c.boxes.length) {
      if (!c.floor || c.top >= 1) return BLOCKED;
      feet = y + c.top;
    } else {
      if (c.liquid || c.danger) return BLOCKED;
      const below = this.cls(x, y - 1, z);
      if (!below) return UNKNOWN;
      if (!below.floor || below.top !== 1) return BLOCKED;
      feet = y;
    }
    const headTop = Math.floor(feet + PHYSICS.height - 1e-6);
    for (let cy = y + 1; cy <= headTop; cy++) {
      const f = this.free(x, cy, z);
      if (f !== true) return f === undefined ? UNKNOWN : BLOCKED;
    }
    return feet;
  }

  /** Extra cost of standing in node (x, y, z) (leaves, soul sand, ice ... below the feet). */
  penalty(x: number, y: number, z: number, feet: number): number {
    const floorY = feet > y + 1e-9 ? y : y - 1;
    return this.cls(x, floorY, z)?.penalty ?? 0;
  }
}
