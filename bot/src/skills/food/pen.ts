// Pen detection (Track AF, wave 8; docs/food.md "Pens"): is a mob standing inside a fenced area?
//
// A small flood fill on one layer (the mob's feet level) over the terrain classes of the loaded
// blocks, 4-connected, starting at the mob's cell. A cell is a wall when a mob cannot walk into it:
// a fence, wall or fence gate (open or closed: an open gate is still the owner's pen) or anything
// else at least 1.5 high, or a block with a collision box whose cell above also has one (a two-high
// wall). Everything else (air, grass, flowers, a single solid block a mob can hop onto, water) is open.
// The mob is penned when the fill stays within `PEN_RADIUS` (12) blocks of the start on both axes and
// at least one wall cell it touched is a fence, wall or gate (a cave pocket or a house without
// fences is not a pen). A cell that is not loaded counts as open (unknown: not a pen).
//
// The fill visits at most (2 x 12 + 1)^2 = 625 cells; the result is kept for every cell of the
// filled area (a second mob in the same pen costs one map lookup) for `ttlMs` (10 s), so fences
// built or broken are seen within that time.
import type { BlockInfo, Vec3 } from '../../world/types.ts';
import { classify, type TerrainClass } from '../terrain/classify.ts';
import type { Goal } from '../nav/goals.ts';
import type { GotoOptions, SkillResult } from '../types.ts';

export const PEN_RADIUS = 12;
/** A pen keeps at least this many adults of each kind (the hunt never goes below it). */
export const PEN_KEEP = 2;

export interface PenWorld {
  blockAt(p: Vec3): BlockInfo | undefined;
}

export interface Pen {
  /** `x,y,z` of the interior's lowest (x, then z) cell: the same for every mob of the pen. */
  id: string;
  /** Feet level of the interior. */
  y: number;
  min: { x: number; z: number };
  max: { x: number; z: number };
  /** Interior cells. */
  cells: number;
  /** Fence / wall / gate cells on the rim. */
  fences: number;
}

/** A fence, wall, fence gate, or anything as high as one (1.5). */
export function fenceLike(c: TerrainClass): boolean {
  return c.connect === 'fence' || c.openable === 'gate' || c.name.endsWith('_wall') || c.top > 1;
}

const ck = (x: number, z: number): string => `${x},${z}`;

/**
 * The pen around the feet position `feet` (a mob's), or undefined when the fill escapes, reaches an
 * unloaded block, or meets no fence. Pure apart from the world lookups.
 */
export function detectPen(world: PenWorld, feet: Vec3, radius = PEN_RADIUS, interior?: string[]): Pen | undefined {
  const x0 = Math.floor(feet.x);
  const z0 = Math.floor(feet.z);
  // a mob on a slab or a path block stands a little above its cell: the cell it is in
  const y = Math.floor(feet.y + 0.01);
  const cls = (x: number, yy: number, z: number): TerrainClass | null | undefined => {
    const b = world.blockAt({ x, y: yy, z });
    return b ? classify(b) : null;
  };
  /** 1 wall (fence-like), 2 wall (two-high), 0 open, -1 unknown. */
  const kind = (x: number, z: number): number => {
    const c = cls(x, y, z);
    if (c === null || c === undefined) return -1;
    if (fenceLike(c)) return 1; // an open gate (no collision box) is still the pen's wall
    if (c.boxes.length === 0) return 0;
    const up = cls(x, y + 1, z);
    if (up === null || up === undefined) return -1;
    return up.boxes.length > 0 ? 2 : 0;
  };
  const seen = new Set<string>([ck(x0, z0)]);
  const stack: [number, number][] = [[x0, z0]];
  const walls = new Set<string>();
  let fences = 0;
  let cells = 0;
  let minX = x0;
  let maxX = x0;
  let minZ = z0;
  let maxZ = z0;
  let first = { x: x0, z: z0 };
  while (stack.length) {
    const [x, z] = stack.pop()!;
    if (Math.abs(x - x0) > radius || Math.abs(z - z0) > radius) return undefined;
    cells++;
    interior?.push(ck(x, z));
    if (x < first.x || (x === first.x && z < first.z)) first = { x, z };
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const nz = z + dz;
      const k = ck(nx, nz);
      if (seen.has(k) || walls.has(k)) continue;
      const w = kind(nx, nz);
      if (w < 0) return undefined;
      if (w > 0) {
        walls.add(k);
        if (w === 1) fences++;
        continue;
      }
      seen.add(k);
      stack.push([nx, nz]);
    }
  }
  if (fences === 0) return undefined;
  return { id: `${first.x},${y},${first.z}`, y, min: { x: minX, z: minZ }, max: { x: maxX, z: maxZ }, cells, fences };
}

/** detectPen with a per-cell memory (`ttlMs`), for many mobs every second. */
export class PenDetector {
  private readonly world: PenWorld;
  private readonly now: () => number;
  private readonly ttlMs: number;
  /** `x,y,z` -> pen (or null = not penned) and when it was computed. */
  private readonly memo = new Map<string, { pen: Pen | null; at: number }>();
  /** Fills run (tests and status). */
  fills = 0;

  constructor(world: PenWorld, opts: { now?: () => number; ttlMs?: number } = {}) {
    this.world = world;
    this.now = opts.now ?? (() => performance.now());
    this.ttlMs = opts.ttlMs ?? 10_000;
  }

  /** The pen around a feet position, or undefined. */
  penAt(feet: Vec3): Pen | undefined {
    const x = Math.floor(feet.x);
    const y = Math.floor(feet.y + 0.01);
    const z = Math.floor(feet.z);
    const k = `${x},${y},${z}`;
    const now = this.now();
    const m = this.memo.get(k);
    if (m && now - m.at < this.ttlMs) return m.pen ?? undefined;
    this.fills++;
    const interior: string[] = [];
    const pen = detectPen(this.world, feet, PEN_RADIUS, interior) ?? null;
    if (this.memo.size > 20_000) this.memo.clear();
    // every interior cell answers for the whole pen (a second mob in it costs one lookup)
    if (pen) for (const c of interior) this.memo.set(`${c.slice(0, c.indexOf(','))},${y},${c.slice(c.indexOf(',') + 1)}`, { pen, at: now });
    else this.memo.set(k, { pen: null, at: now });
    return pen ?? undefined;
  }

  /** Forget everything (blocks changed a lot, tests). */
  clear(): void {
    this.memo.clear();
  }
}

/** Is block position `p` inside pen `pen` (its box, at its level +-2)? */
export function penContains(pen: Pen, p: Vec3): boolean {
  const x = Math.floor(p.x);
  const z = Math.floor(p.z);
  return x >= pen.min.x && x <= pen.max.x && z >= pen.min.z && z <= pen.max.z && Math.abs(Math.floor(p.y) - pen.y) <= 2;
}

/** Is the feet position inside the pen or on its rim (the fence line, e.g. standing in the open gate)? */
export function inPenOrRim(pen: Pen, p: Vec3): boolean {
  return p.x >= pen.min.x - 1 && p.x < pen.max.x + 2 && p.z >= pen.min.z - 1 && p.z < pen.max.z + 2 && Math.abs(Math.floor(p.y + 0.01) - pen.y) <= 2;
}

/** Fence gates on the pen's rim (its fence line), open or closed. */
export function penGates(world: PenWorld, pen: Pen): { p: Vec3; open: boolean }[] {
  const out: { p: Vec3; open: boolean }[] = [];
  const at = (x: number, z: number): void => {
    const p = { x, y: pen.y, z };
    const b = world.blockAt(p);
    if (!b) return;
    const c = classify(b);
    if (c.openable === 'gate') out.push({ p, open: c.open });
  };
  for (let x = pen.min.x - 1; x <= pen.max.x + 1; x++) {
    at(x, pen.min.z - 1);
    at(x, pen.max.z + 1);
  }
  for (let z = pen.min.z; z <= pen.max.z; z++) {
    at(pen.min.x - 1, z);
    at(pen.max.x + 1, z);
  }
  return out;
}

/**
 * A spot 3 blocks outside the fence: straight out of the gate nearest to `me` when there is one,
 * else past the side nearest to `me`.
 */
export function penExit(pen: Pen, me: Vec3, gates: readonly Vec3[] = []): Vec3 {
  const g = [...gates].sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))[0];
  if (g) {
    const dx = g.x < pen.min.x ? -3 : g.x > pen.max.x ? 3 : 0;
    const dz = g.z < pen.min.z ? -3 : g.z > pen.max.z ? 3 : 0;
    return { x: g.x + dx + 0.5, y: pen.y, z: g.z + dz + 0.5 };
  }
  const cx = (pen.min.x + pen.max.x) / 2 + 0.5;
  const cz = (pen.min.z + pen.max.z) / 2 + 0.5;
  const sides = [
    { d: me.x - pen.min.x, x: pen.min.x - 4 + 0.5, z: cz },
    { d: pen.max.x - me.x, x: pen.max.x + 4 + 0.5, z: cz },
    { d: me.z - pen.min.z, x: cx, z: pen.min.z - 4 + 0.5 },
    { d: pen.max.z - me.z, x: cx, z: pen.max.z + 4 + 0.5 },
  ].sort((a, b) => a.d - b.d);
  return { x: sides[0]!.x, y: pen.y, z: sides[0]!.z };
}

export interface PenLeaveDeps {
  world: PenWorld;
  mover: { goto(goal: Goal, opts?: GotoOptions): Promise<SkillResult>; useBlock?(p: Vec3, opts?: { want?: 'open' | 'closed' | 'toggle' }): Promise<SkillResult> };
  position(): Vec3;
}

/**
 * Out of a pen the bot stands in (or in whose gate it stands): walk 3 blocks out through the nearest
 * gate (`closeDoors`: the planner closes a gate it opened), then close every open gate of the pen
 * within reach (a gate that was already open is not closed by the walk). The animals stay in.
 */
export async function leavePen(d: PenLeaveDeps, pen: Pen, cancelled: () => boolean): Promise<{ ok: boolean; walked: boolean; closed: number; reason?: string | undefined }> {
  const me = d.position();
  if (!inPenOrRim(pen, me) || cancelled()) return { ok: true, walked: false, closed: 0 };
  const gates = penGates(d.world, pen);
  const r = await d.mover.goto({ type: 'near', p: penExit(pen, me, gates.map((g) => g.p)), r: 1 }, { timeoutTicks: 400, closeDoors: true });
  if (cancelled()) return { ok: false, walked: r.ok, closed: 0, reason: 'interrupted' };
  const closed = await closePenGates(d, pen, cancelled);
  return { ok: r.ok, walked: true, closed, reason: r.ok ? undefined : r.reason };
}

/** Close every open gate of the pen within reach (4.5 blocks) of the bot. Returns how many were closed. */
export async function closePenGates(d: PenLeaveDeps, pen: Pen, cancelled: () => boolean): Promise<number> {
  let closed = 0;
  for (const g of penGates(d.world, pen)) {
    const here = d.position();
    if (!g.open || !d.mover.useBlock || Math.hypot(g.p.x + 0.5 - here.x, g.p.z + 0.5 - here.z) > 4.5) continue;
    const u = await d.mover.useBlock(g.p, { want: 'closed' });
    if (u.ok) closed++;
    if (cancelled()) break;
  }
  return closed;
}

/** Strictly inside the pen's interior box (not on the fence line). */
export function insidePen(pen: Pen, p: Vec3): boolean {
  return p.x >= pen.min.x && p.x < pen.max.x + 1 && p.z >= pen.min.z && p.z < pen.max.z + 1 && Math.abs(Math.floor(p.y + 0.01) - pen.y) <= 2;
}
