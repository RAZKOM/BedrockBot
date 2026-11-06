// Track CB (ADR 0066, docs/coarse.md "The graph"): one chunk column of the coarse graph. Volumes are the
// connected components of passable cells (air or water, never avoid) per 16 x 16 x 16 section, plus one
// sky volume over the column tops; portals are the shared faces between volumes: inside the chunk
// (section borders, the sky contact, air / water contacts), across a chunk border (built on demand from
// both sides, `borderPortals`), and, for the mine mode only, synthetic dig portals through solid
// (`digPortals`). A never-seen chunk is one unknown volume per section with full-face portals.
//
// Cell indexing inside a section: (dy << 8) | (lz << 4) | lx, dy = y & 15. Labels: 0 = not passable,
// n >= 1 = volumes[n - 1]; the sky volume of a known chunk is always label 1.
import { CLS_AIR, CLS_SOLID, CLS_WATER, type CellClass } from '../../world/cache/types.ts';
import type { Vec3 } from '../../world/types.ts';
import type { ChunkCells } from './source.ts';
import type { Knowledge, Portal, PortalAxis, Volume, VolumeKind } from './types.ts';

/** Label of the sky volume in a known chunk. */
export const SKY = 1;
/** Headroom is counted up to this many clear cells. */
const HEADROOM_CAP = 8;
/** A floor counts when it is within this many cells below an opening. */
const FLOOR_REACH = 3;

export interface ChunkGraph {
  readonly dim: number;
  readonly cx: number;
  readonly cz: number;
  readonly known: boolean;
  /** Lowest y of the sky volume (the highest non-air cell + 1); maxY + 1 for an unknown chunk (no sky volume). */
  readonly skyY: number;
  /** Lowest section index (floor(minY / 16)). */
  readonly syMin: number;
  readonly minY: number;
  readonly maxY: number;
  /** Volumes by label - 1. */
  readonly volumes: Volume[];
  /** Per section (sy - syMin): the labels of its 4096 cells, or one label for the whole section (0 = all solid). Missing: sky (known) or nothing. */
  readonly labels: (Uint8Array | Uint16Array | number | undefined)[];
  /** Portals inside the chunk (section borders, the sky contact, air / water contacts). */
  readonly portals: Portal[];
  /** Intra-chunk portals by volume label. */
  readonly byLabel: Map<number, Portal[]>;
  /** Volumes by id. */
  readonly byId: Map<string, Volume>;
  /** The cells the chunk was built from (floor lookups of border portals). */
  readonly cells: ChunkCells | undefined;
  /** Build number (border portals are cached against the builds of both sides). */
  readonly build: number;
  /** Milliseconds the build took. */
  readonly ms: number;
}

/** The label of the cell at local (lx, lz) and absolute y; 0 outside the world or in solid. */
export function labelAt(g: ChunkGraph, lx: number, y: number, lz: number): number {
  if (y < g.minY || y > g.maxY) return 0;
  if (g.known && y >= g.skyY) return SKY;
  const l = g.labels[(y >> 4) - g.syMin];
  if (l === undefined) return 0;
  if (typeof l === 'number') return l;
  return l[((y & 15) << 8) | (lz << 4) | lx]!;
}

/** The volume holding local cell (lx, y, lz), if passable. */
export function volumeAtCell(g: ChunkGraph, lx: number, y: number, lz: number): Volume | undefined {
  const l = labelAt(g, lx, y, lz);
  return l === 0 ? undefined : g.volumes[l - 1];
}

export const volumeId = (dim: number, cx: number, cz: number, sy: number | 'sky', n: number): string => `${dim}:${cx}:${cz}:${sy}:${n}`;

/** A face group while scanning: the opening cells (world coordinates) between two labels along an axis. */
interface FaceGroup {
  axis: PortalAxis;
  a: number;
  b: number;
  cells: Vec3[];
}

/** Which cell below a world cell is solid (floor lookups), in world coordinates. */
export type SolidAt = (x: number, y: number, z: number) => boolean;

const passable = (c: number): boolean => c === CLS_AIR || c === CLS_WATER;

const SKY_MARK = 255;

// ---- known chunk --------------------------------------------------------------------------------

export function buildKnownChunk(cells: ChunkCells, dim: number, cx: number, cz: number, minY: number, maxY: number, build: number): ChunkGraph {
  const t0 = performance.now();
  const syMin = minY >> 4;
  // the highest non-air cell of the chunk
  let maxNonAir = minY - 1;
  const yTop = Math.min(cells.y0 + cells.rows - 1, maxY);
  const yBot = Math.max(cells.y0, minY);
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      for (let y = yTop; y > maxNonAir; y--) {
        if (cells.cls(x, y, z) !== CLS_AIR) {
          maxNonAir = y;
          break;
        }
      }
    }
  }
  const skyY = Math.max(maxNonAir + 1, yBot);
  const volumes: Volume[] = [];
  const bx = cx * 16;
  const bz = cz * 16;
  // the sky volume (label 1)
  if (skyY <= maxY) {
    let floorCells = 0;
    if (skyY - 1 >= minY) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) if (cells.cls(x, skyY - 1, z) === CLS_SOLID) floorCells++;
    const h = maxY - skyY + 1;
    volumes.push({
      id: volumeId(dim, cx, cz, 'sky', 0),
      kind: 'sky',
      dim,
      min: { x: bx, y: skyY, z: bz },
      max: { x: bx + 15, y: maxY, z: bz + 15 },
      cells: 256 * h,
      floorCells,
      ...(floorCells > 0 ? { headroom: { min: h, max: h } } : {}),
      minSpan: 16,
      known: 'known',
    });
  } else {
    // a column filled to the ceiling: no sky; a placeholder keeps label 1 reserved
    volumes.push({ id: volumeId(dim, cx, cz, 'sky', 0), kind: 'sky', dim, min: { x: bx, y: maxY + 1, z: bz }, max: { x: bx + 15, y: maxY, z: bz + 15 }, cells: 0, floorCells: 0, minSpan: 16, known: 'known' });
  }
  const syTop = (skyY - 1) >> 4;
  const nSections = Math.max(0, syTop - syMin + 1);
  const labels: (Uint16Array | number | undefined)[] = new Array<Uint16Array | number | undefined>(nSections).fill(undefined);
  const cls = new Uint8Array(4096);
  const stack = new Int32Array(4096);
  const minZ = new Int8Array(16);
  const maxZ = new Int8Array(16);
  const minX = new Int8Array(16);
  const maxX = new Int8Array(16);
  for (let sec = 0; sec < nSections; sec++) {
    const sy = syMin + sec;
    const y0 = sy * 16;
    let anyPassable = false;
    for (let dy = 0; dy < 16; dy++) {
      const y = y0 + dy;
      const row = dy << 8;
      if (y >= skyY || y < minY || y > maxY) {
        cls.fill(y >= skyY ? SKY_MARK : CLS_SOLID, row, row + 256);
        continue;
      }
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          const c = cells.cls(x, y, z);
          cls[row | (z << 4) | x] = c;
          if (passable(c)) anyPassable = true;
        }
      }
    }
    if (!anyPassable) {
      labels[sec] = 0;
      continue;
    }
    const lab = new Uint16Array(4096);
    labels[sec] = lab;
    for (let i0 = 0; i0 < 4096; i0++) {
      const c = cls[i0] as CellClass;
      if (!passable(c) || lab[i0] !== 0) continue;
      const label = volumes.length + 1;
      let n = 0;
      let floorCells = 0;
      let hMin = Infinity;
      let hMax = 0;
      let x0 = 16;
      let x1 = -1;
      let y0b = 16;
      let y1b = -1;
      let z0 = 16;
      let z1 = -1;
      minZ.fill(16);
      maxZ.fill(-1);
      minX.fill(16);
      maxX.fill(-1);
      let sp = 0;
      stack[sp++] = i0;
      lab[i0] = label;
      while (sp > 0) {
        const i = stack[--sp]!;
        n++;
        const x = i & 15;
        const z = (i >> 4) & 15;
        const dy = i >> 8;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (z < z0) z0 = z;
        if (z > z1) z1 = z;
        if (dy < y0b) y0b = dy;
        if (dy > y1b) y1b = dy;
        if (z < minZ[x]!) minZ[x] = z;
        if (z > maxZ[x]!) maxZ[x] = z;
        if (x < minX[z]!) minX[z] = x;
        if (x > maxX[z]!) maxX[z] = x;
        // a floor: the cell below is solid
        const below = dy > 0 ? cls[i - 256]! : y0 - 1 >= minY ? cells.cls(x, y0 - 1, z) : CLS_SOLID;
        if (below === CLS_SOLID && c === CLS_AIR) {
          floorCells++;
          let h = 1;
          while (h < HEADROOM_CAP) {
            const yy = y0 + dy + h;
            const cc = dy + h < 16 ? cls[i + (h << 8)]! : yy > maxY ? CLS_SOLID : cells.cls(x, yy, z);
            if (cc !== CLS_AIR && cc !== SKY_MARK) break;
            h++;
          }
          if (h < hMin) hMin = h;
          if (h > hMax) hMax = h;
        }
        // neighbours of the same class inside the section
        if (x > 0 && lab[i - 1] === 0 && cls[i - 1] === c) {
          lab[i - 1] = label;
          stack[sp++] = i - 1;
        }
        if (x < 15 && lab[i + 1] === 0 && cls[i + 1] === c) {
          lab[i + 1] = label;
          stack[sp++] = i + 1;
        }
        if (z > 0 && lab[i - 16] === 0 && cls[i - 16] === c) {
          lab[i - 16] = label;
          stack[sp++] = i - 16;
        }
        if (z < 15 && lab[i + 16] === 0 && cls[i + 16] === c) {
          lab[i + 16] = label;
          stack[sp++] = i + 16;
        }
        if (dy > 0 && lab[i - 256] === 0 && cls[i - 256] === c) {
          lab[i - 256] = label;
          stack[sp++] = i - 256;
        }
        if (dy < 15 && lab[i + 256] === 0 && cls[i + 256] === c) {
          lab[i + 256] = label;
          stack[sp++] = i + 256;
        }
      }
      // the narrowest cross-section across the longest horizontal axis
      let minSpan = 16;
      if (x1 - x0 >= z1 - z0) {
        for (let x = x0; x <= x1; x++) if (maxZ[x]! >= 0) minSpan = Math.min(minSpan, maxZ[x]! - minZ[x]! + 1);
      } else {
        for (let z = z0; z <= z1; z++) if (maxX[z]! >= 0) minSpan = Math.min(minSpan, maxX[z]! - minX[z]! + 1);
      }
      volumes.push({
        id: volumeId(dim, cx, cz, sy, label - 1),
        kind: c === CLS_WATER ? 'water' : 'cave',
        dim,
        min: { x: bx + x0, y: y0 + y0b, z: bz + z0 },
        max: { x: bx + x1, y: y0 + y1b, z: bz + z1 },
        cells: n,
        floorCells,
        ...(floorCells > 0 ? { headroom: { min: hMin, max: hMax } } : {}),
        minSpan,
        known: 'known',
      });
    }
  }
  // the volume numbers in the ids are per section: renumber the id's n as the component index inside its section
  renumber(volumes, dim, cx, cz);
  const g: ChunkGraph = {
    dim,
    cx,
    cz,
    known: true,
    skyY,
    syMin,
    minY,
    maxY,
    volumes,
    labels: compactLabels(labels, volumes.length),
    portals: [],
    byLabel: new Map(),
    byId: new Map(volumes.map((v) => [v.id, v])),
    cells,
    build,
    ms: 0,
  };
  // faces inside the chunk: +x, +z, +y of every passable cell below the sky
  const groups = new Map<number, FaceGroup>();
  for (let sec = 0; sec < nSections; sec++) {
    const lab = g.labels[sec];
    if (lab === undefined || typeof lab === 'number') continue;
    const sy = syMin + sec;
    const y0 = sy * 16;
    const next = g.labels[sec + 1];
    for (let i = 0; i < 4096; i++) {
      const a = lab[i]!;
      if (a === 0) continue;
      const x = i & 15;
      const z = (i >> 4) & 15;
      const dy = i >> 8;
      const y = y0 + dy;
      if (x < 15) {
        const b = lab[i + 1]!;
        if (b !== 0 && b !== a) addFace(groups, 'x', a, b, bx + x, y, bz + z);
      }
      if (z < 15) {
        const b = lab[i + 16]!;
        if (b !== 0 && b !== a) addFace(groups, 'z', a, b, bx + x, y, bz + z);
      }
      let up: number;
      if (y + 1 >= skyY) up = SKY;
      else if (dy < 15) up = lab[i + 256]!;
      else if (next === undefined) up = 0;
      else if (typeof next === 'number') up = next;
      else up = next[(z << 4) | x]!;
      if (up !== 0 && up !== a) addFace(groups, 'y', up, a, bx + x, y, bz + z);
    }
  }
  const solidAt: SolidAt = (x, y, z) => y < minY || cells.cls(x & 15, y, z & 15) === CLS_SOLID;
  for (const f of groups.values()) {
    for (const cells of openings(f)) {
      const p = portalOf(dim, f.axis, volumes[f.a - 1]!, volumes[f.b - 1]!, cells, solidAt, solidAt);
      g.portals.push(p);
      push(g.byLabel, f.a, p);
      push(g.byLabel, f.b, p);
    }
    if (f.axis === 'y' && f.a === SKY) {
      const v = volumes[f.b - 1]!;
      if (v.kind === 'cave') v.kind = 'surface';
    }
  }
  return { ...g, ms: performance.now() - t0 };
}

/** Volume ids carry the component index inside the section (stable while the section's cells do not change), not the chunk-wide label. */
function renumber(volumes: Volume[], dim: number, cx: number, cz: number): void {
  const perSection = new Map<number, number>();
  for (const v of volumes) {
    if (v.kind === 'sky') continue;
    const sy = v.min.y >> 4;
    const n = perSection.get(sy) ?? 0;
    perSection.set(sy, n + 1);
    v.id = volumeId(dim, cx, cz, sy, n);
  }
}

function compactLabels(labels: (Uint16Array | number | undefined)[], count: number): (Uint8Array | Uint16Array | number | undefined)[] {
  if (count > 255) return labels;
  return labels.map((l) => (l instanceof Uint16Array ? Uint8Array.from(l) : l));
}

function addFace(groups: Map<number, FaceGroup>, axis: PortalAxis, a: number, b: number, x: number, y: number, z: number): void {
  const key = ((axis === 'x' ? 0 : axis === 'z' ? 1 : 2) * 65536 + a) * 65536 + b;
  let f = groups.get(key);
  if (!f) {
    f = { axis, a, b, cells: [] };
    groups.set(key, f);
  }
  f.cells.push({ x, y, z });
}

/** A face group split into its connected openings (4-connected in the face plane): two gaps in one wall are two portals. */
function openings(f: FaceGroup): Vec3[][] {
  if (f.cells.length === 1) return [f.cells];
  const u = (c: Vec3): number => (f.axis === 'x' ? c.z : c.x);
  const v = (c: Vec3): number => (f.axis === 'y' ? c.z : c.y);
  const key = (uu: number, vv: number): number => (vv + 4096) * 8192 + (uu + 4096);
  const index = new Map<number, number>();
  f.cells.forEach((c, i) => index.set(key(u(c), v(c)), i));
  const seen = new Uint8Array(f.cells.length);
  const out: Vec3[][] = [];
  for (let i = 0; i < f.cells.length; i++) {
    if (seen[i]) continue;
    const comp: Vec3[] = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      const c = f.cells[j]!;
      comp.push(c);
      for (const [du, dv] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const k = index.get(key(u(c) + du, v(c) + dv));
        if (k !== undefined && !seen[k]) {
          seen[k] = 1;
          stack.push(k);
        }
      }
    }
    out.push(comp);
  }
  return out;
}

function push(m: Map<number, Portal[]>, k: number, p: Portal): void {
  const l = m.get(k);
  if (l) l.push(p);
  else m.set(k, [p]);
}

// ---- unknown chunk ------------------------------------------------------------------------------

export function buildUnknownChunk(dim: number, cx: number, cz: number, minY: number, maxY: number, build: number): ChunkGraph {
  const t0 = performance.now();
  const syMin = minY >> 4;
  const syMax = maxY >> 4;
  const bx = cx * 16;
  const bz = cz * 16;
  const volumes: Volume[] = [];
  const labels: number[] = [];
  for (let sy = syMin; sy <= syMax; sy++) {
    const y0 = Math.max(sy * 16, minY);
    const y1 = Math.min(sy * 16 + 15, maxY);
    volumes.push({
      id: volumeId(dim, cx, cz, sy, 0),
      kind: 'unknown',
      dim,
      min: { x: bx, y: y0, z: bz },
      max: { x: bx + 15, y: y1, z: bz + 15 },
      cells: 256 * (y1 - y0 + 1),
      floorCells: 0,
      minSpan: 16,
      known: 'unknown',
    });
    labels.push(volumes.length);
  }
  const g: ChunkGraph = { dim, cx, cz, known: false, skyY: maxY + 1, syMin, minY, maxY, volumes, labels, portals: [], byLabel: new Map(), byId: new Map(volumes.map((v) => [v.id, v])), cells: undefined, build, ms: 0 };
  // full-face portals between consecutive sections (a = upper)
  for (let i = 0; i + 1 < volumes.length; i++) {
    const lower = volumes[i]!;
    const upper = volumes[i + 1]!;
    const y = lower.max.y;
    const cells: Vec3[] = [];
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) cells.push({ x: bx + x, y, z: bz + z });
    const p = portalOf(dim, 'y', upper, lower, cells, () => false, () => false);
    g.portals.push(p);
    push(g.byLabel, i + 1, p);
    push(g.byLabel, i + 2, p);
  }
  return { ...g, ms: performance.now() - t0 };
}

// ---- portals ------------------------------------------------------------------------------------

/** Largest rectangle of set bits in a w x h bitmap (histogram method); returns [u0, v0, width, height]. */
export function largestRectangle(bits: Uint8Array, w: number, h: number): [number, number, number, number] {
  const heights = new Int32Array(w);
  let best: [number, number, number, number] = [0, 0, 0, 0];
  let bestArea = 0;
  const stack: number[] = [];
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) heights[u] = bits[v * w + u] ? heights[u]! + 1 : 0;
    stack.length = 0;
    for (let u = 0; u <= w; u++) {
      const cur = u < w ? heights[u]! : 0;
      while (stack.length && heights[stack[stack.length - 1]!]! >= cur) {
        const top = stack.pop()!;
        const hh = heights[top]!;
        const left = stack.length ? stack[stack.length - 1]! + 1 : 0;
        const ww = u - left;
        const area = ww * hh;
        if (area > bestArea || (area === bestArea && area > 0 && Math.min(ww, hh) > Math.min(best[2], best[3]))) {
          bestArea = area;
          best = [left, v - hh + 1, ww, hh];
        }
      }
      stack.push(u);
    }
  }
  return best;
}

/**
 * The portal between volumes `a` and `b` along `axis` from its opening cells (world coordinates, the
 * cells on the lower-coordinate side; for axis y the lower volume's cells). `solidA` answers for the
 * opening cells' side, `solidB` for the far side (both the same chunk inside a chunk).
 */
export function portalOf(dim: number, axis: PortalAxis, a: Volume, b: Volume, cells: readonly Vec3[], solidA: SolidAt, solidB: SolidAt): Portal {
  let min: Vec3 = { x: Infinity, y: Infinity, z: Infinity };
  let max: Vec3 = { x: -Infinity, y: -Infinity, z: -Infinity };
  let first = cells[0]!;
  for (const c of cells) {
    if (c.x < min.x) min = { ...min, x: c.x };
    if (c.y < min.y) min = { ...min, y: c.y };
    if (c.z < min.z) min = { ...min, z: c.z };
    if (c.x > max.x) max = { ...max, x: c.x };
    if (c.y > max.y) max = { ...max, y: c.y };
    if (c.z > max.z) max = { ...max, z: c.z };
    if (c.y < first.y || (c.y === first.y && (c.z < first.z || (c.z === first.z && c.x < first.x)))) first = c;
  }
  // the bitmap of the opening projected along the axis: u across, v up (x / z) or z (y)
  const uOf = (c: Vec3): number => (axis === 'x' ? c.z - min.z : c.x - min.x);
  const vOf = (c: Vec3): number => (axis === 'y' ? c.z - min.z : c.y - min.y);
  const w = axis === 'x' ? max.z - min.z + 1 : max.x - min.x + 1;
  const h = axis === 'y' ? max.z - min.z + 1 : max.y - min.y + 1;
  const bits = new Uint8Array(w * h);
  for (const c of cells) bits[vOf(c) * w + uOf(c)] = 1;
  const [u0, v0, rw, rh] = largestRectangle(bits, w, h);
  let center: Vec3;
  let clearance: { height: number; width: number };
  if (axis === 'y') {
    center = { x: min.x + u0 + (rw - 1) / 2, y: min.y, z: min.z + v0 + (rh - 1) / 2 };
    clearance = { height: Math.max(rw, rh), width: Math.min(rw, rh) };
  } else if (axis === 'x') {
    center = { x: min.x, y: min.y + v0, z: min.z + u0 + (rw - 1) / 2 };
    clearance = { height: rh, width: rw };
  } else {
    center = { x: min.x + u0 + (rw - 1) / 2, y: min.y + v0, z: min.z };
    clearance = { height: rh, width: rw };
  }
  const floorY = floorOf(axis, cells, center, min, solidA, solidB);
  const known: Knowledge = a.known === 'unknown' || b.known === 'unknown' ? 'unknown' : a.known === 'partial' || b.known === 'partial' ? 'partial' : 'known';
  return {
    id: `${dim}:${axis}:${first.x}:${first.y}:${first.z}`,
    a: a.id,
    b: b.id,
    axis,
    min,
    max,
    center,
    clearance,
    ...(floorY === undefined ? {} : { floorY }),
    known,
  };
}

/**
 * The lowest standable floor under an opening (feet y), within FLOOR_REACH below it. Axis x / z: an
 * opening cell with solid under it on both sides of the face (the far side's cell is one step along
 * the axis), else the clear rectangle's centre column scanned down on both sides. Axis y: the centre
 * column of the lower side scanned down, else any opening cell with solid under it.
 */
function floorOf(axis: PortalAxis, cells: readonly Vec3[], center: Vec3, min: Vec3, solidA: SolidAt, solidB: SolidAt): number | undefined {
  const cxI = Math.floor(center.x);
  const czI = Math.floor(center.z);
  if (axis === 'y') {
    // a floor directly under an opening cell (standing in the opening: a staircase, a cave mouth) first
    for (const c of cells) if (solidA(c.x, c.y - 1, c.z)) return min.y;
    for (let d = 2; d <= FLOOR_REACH; d++) {
      if (solidA(cxI, min.y - d, czI)) return min.y - d + 1;
    }
    return undefined;
  }
  const dx = axis === 'x' ? 1 : 0;
  const dz = axis === 'z' ? 1 : 0;
  let best: number | undefined;
  for (const c of cells) {
    if ((best === undefined || c.y < best) && solidA(c.x, c.y - 1, c.z) && solidB(c.x + dx, c.y - 1, c.z + dz)) best = c.y;
  }
  if (best !== undefined) return best;
  const y = Math.floor(center.y);
  let fa: number | undefined;
  let fb: number | undefined;
  for (let d = 1; d <= FLOOR_REACH && fa === undefined; d++) if (solidA(cxI, y - d, czI)) fa = y - d + 1;
  for (let d = 1; d <= FLOOR_REACH && fb === undefined; d++) if (solidB(cxI + dx, y - d, czI + dz)) fb = y - d + 1;
  if (fa === undefined || fb === undefined) return undefined;
  return Math.min(fa, fb);
}

// ---- border portals -----------------------------------------------------------------------------

/**
 * The portals across the border between chunk `a` and its +x or +z neighbour `b` (both graphs built):
 * face cells where both sides are passable, grouped by the volume pair; the opening cells are a's.
 */
export function borderPortals(a: ChunkGraph, b: ChunkGraph, axis: 'x' | 'z'): Portal[] {
  const groups = new Map<number, FaceGroup>();
  const bx = a.cx * 16;
  const bz = a.cz * 16;
  const minY = Math.max(a.minY, b.minY);
  const maxY = Math.min(a.maxY, b.maxY);
  // above both skies every cell is sky on both sides: one band, handled without scanning each row
  const skyBand = a.known && b.known ? Math.max(a.skyY, b.skyY) : maxY + 1;
  for (let y = minY; y <= maxY; y++) {
    const inBand = y >= skyBand;
    for (let u = 0; u < 16; u++) {
      const la = inBand ? SKY : axis === 'x' ? labelAt(a, 15, y, u) : labelAt(a, u, y, 15);
      if (la === 0) continue;
      const lb = inBand ? SKY : axis === 'x' ? labelAt(b, 0, y, u) : labelAt(b, u, y, 0);
      if (lb === 0) continue;
      addFace(groups, axis, la, lb, axis === 'x' ? bx + 15 : bx + u, y, axis === 'x' ? bz + u : bz + 15);
    }
  }
  const solidOf = (g: ChunkGraph): SolidAt => (x, y, z) => y < g.minY || g.cells?.cls(x & 15, y, z & 15) === CLS_SOLID;
  const sa = solidOf(a);
  const sb = solidOf(b);
  const out: Portal[] = [];
  for (const f of groups.values()) for (const cells of openings(f)) out.push(portalOf(a.dim, f.axis, a.volumes[f.a - 1]!, b.volumes[f.b - 1]!, cells, sa, sb));
  return out;
}

// ---- dig portals (mine) --------------------------------------------------------------------------

/**
 * Synthetic portals for the mine mode from volume `v` (label `label` in `g`) to every volume of a
 * neighbouring section (`others`, with the axis towards them) that no real portal joins: the opening
 * is one cell in the solid between them, `dug` the rough number of solid blocks to dig.
 */
export function digPortal(dim: number, v: Volume, w: Volume, axis: PortalAxis, real: readonly Portal[]): Portal | undefined {
  for (const p of real) if ((p.a === v.id && p.b === w.id) || (p.a === w.id && p.b === v.id)) return undefined;
  // the gap between the two bounding boxes along the axis (at least one solid cell)
  const gapOf = (k: 'x' | 'y' | 'z'): number => Math.max(0, w.min[k] - v.max[k] - 1, v.min[k] - w.max[k] - 1);
  const gap = Math.max(1, gapOf(axis)) + (axis === 'y' ? 0 : Math.round(0.25 * (gapOf('x') + gapOf('z') - gapOf(axis))));
  // the opening cell: the centre of w clamped into v's box, one step towards w along the axis
  const cx = clamp((w.min.x + w.max.x) / 2, v.min.x, v.max.x);
  const cy = clamp((w.min.y + w.max.y) / 2, v.min.y, v.max.y);
  const cz = clamp((w.min.z + w.max.z) / 2, v.min.z, v.max.z);
  const towards = (k: 'x' | 'y' | 'z', c: number): number => (w.min[k] > v.max[k] ? v.max[k] + 1 : w.max[k] < v.min[k] ? v.min[k] - 1 : Math.floor(c));
  const cell: Vec3 = { x: axis === 'x' ? towards('x', cx) : Math.floor(cx), y: axis === 'y' ? towards('y', cy) : Math.floor(cy), z: axis === 'z' ? towards('z', cz) : Math.floor(cz) };
  const lower = axis === 'y' ? (v.min.y > w.max.y ? w : v) : axis === 'x' ? (v.min.x <= w.min.x ? v : w) : v.min.z <= w.min.z ? v : w;
  const upper = lower === v ? w : v;
  const a = axis === 'y' ? upper : lower;
  const b = axis === 'y' ? lower : upper;
  return {
    id: `${dim}:${axis}:${cell.x}:${cell.y}:${cell.z}:dig`,
    a: a.id,
    b: b.id,
    axis,
    min: cell,
    max: cell,
    center: { x: cell.x, y: cell.y, z: cell.z },
    clearance: { height: 2, width: 1 },
    known: v.known === 'unknown' || w.known === 'unknown' ? 'unknown' : 'known',
    dug: gap,
  };
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The kinds a dig portal may lead into (never water: a dug wall floods). */
export const DIGGABLE_INTO: ReadonlySet<VolumeKind> = new Set<VolumeKind>(['sky', 'surface', 'cave', 'unknown']);
