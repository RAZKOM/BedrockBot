// The builder's view of the world (wave 9, Track AL; docs/build.md "Order rules"): the world model
// with the build's own changes laid over it (placed and dug cells), and the rules for where the bot
// may stand to work on a cell. Shared by the planner (plan.ts, on a simulated copy) and the runner
// (runner.ts, on the live world model).
//
//   stand f     feet cell f and head cell f+1 free (no collision box, no liquid), not cells the build
//               fills later (`blocked`), a full block top under the feet (f-1), no lava / fire / cactus
//               ... next to the body
//   reach       eye (f + 0.5, f.y + 1.62, f + 0.5) to the target's centre <= 4.5, the target not in
//               the body (f or f+1) and, for digging, not the block under the feet; for placing, a
//               clickable neighbour of the target within the click reach (5, eye to its closest point)
//   reachable   stands joined by 4-neighbour steps of at most one block up or down (both ways walkable,
//               so the bot never ends in a hole it cannot leave), seeded from the bot and from every
//               stand on the edge of the work area (assumed reachable from outside)
import { closestDistance, cornerDistance, DEFAULT_CLICK_REACH, isInteractive, REPLACEABLE, SERVER_CLICK_REACH } from '../place/place.ts';
import { EYE_HEIGHT } from '../dig/look.ts';
import type { Vec3 } from '../../world/types.ts';
import { chooseClick, type ClickChoice, type Placement } from './states.ts';
import { add, key, type Cell } from './types.ts';

/** A block as the builder reads it (world/types BlockInfo satisfies it). */
export interface BlockLike {
  name: string;
  boxes: readonly (readonly number[])[];
  hardness?: number;
  /** Track B1: the block's states (the runner verifies them). */
  states?: Readonly<Record<string, unknown>>;
}

export interface BlockReader {
  blockAt(p: Cell): BlockLike | undefined;
}

/** Eye-to-centre reach for choosing where to stand (docs/build.md). */
export const BUILD_REACH = 4.5;

const AIR: BlockLike = { name: 'air', boxes: [] };
const SOLID: BlockLike = { name: 'scaffold', boxes: [[0, 0, 0, 1, 1, 1]] };

const LIQUID = /(^|_)(water|lava)$/;
/** Blocks that hurt or trap a body standing next to / in them. */
const HAZARD = /^(lava|flowing_lava|fire|soul_fire|magma|campfire|soul_campfire|cactus|sweet_berry_bush|wither_rose|web|powder_snow|pointed_dripstone)$/;

export function isLiquid(b: BlockLike | undefined): boolean {
  return !!b && LIQUID.test(b.name);
}

/** Air-like: no collision box and not a liquid. */
export function passable(b: BlockLike | undefined): boolean {
  return !!b && b.name !== 'unknown' && b.boxes.length === 0 && !isLiquid(b);
}

/** A full-height top to stand on (slabs at the bottom half, fences and walls are not used). */
export function standTop(b: BlockLike | undefined): boolean {
  if (!b || b.boxes.length === 0 || b.name === 'unknown' || HAZARD.test(b.name)) return false;
  let top = 0;
  for (const bx of b.boxes) top = Math.max(top, bx[4] ?? 0);
  return top > 0.9 && top <= 1.0001;
}

/** A block a placement may click (solid, not interactive). */
export function clickable(b: BlockLike | undefined): boolean {
  return !!b && b.name !== 'unknown' && b.boxes.length > 0 && !REPLACEABLE.has(b.name) && !isInteractive(b.name);
}

/** A cell a block can be placed into. */
export function replaceable(b: BlockLike | undefined): boolean {
  return !!b && REPLACEABLE.has(b.name) && !(b.name.includes('lava') || b.name.includes('water'));
}

const SIDES: readonly Cell[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
];
const SIX: readonly Cell[] = [...SIDES, { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }];
export const NEIGHBOURS6 = SIX;

/**
 * The world model plus the build's own changes. `blocked` = cells the build will fill later (never
 * stood in, never used for scaffolding).
 */
export class SimWorld implements BlockReader {
  private readonly base: BlockReader;
  private readonly over = new Map<string, BlockLike>();
  readonly blocked = new Set<string>();
  /** Bumped by every change (the reachability cache compares it). */
  version = 0;

  constructor(base: BlockReader) {
    this.base = base;
  }

  blockAt(p: Cell): BlockLike | undefined {
    return this.over.get(key(p)) ?? this.base.blockAt(p);
  }

  /** A block appears (a target or a scaffold) / a cell is dug. Track B1: its shape and states when known (default a full block). */
  setSolid(p: Cell, name = 'scaffold', boxes?: readonly (readonly number[])[], states?: Readonly<Record<string, unknown>>): void {
    this.over.set(key(p), name === 'scaffold' ? SOLID : { name, boxes: boxes ?? SOLID.boxes, ...(states ? { states } : {}) });
    this.version++;
  }

  /** The cell holds a scaffold block the planner added. */
  isScaffold(p: Cell): boolean {
    return this.over.get(key(p)) === SOLID;
  }

  setAir(p: Cell): void {
    this.over.set(key(p), AIR);
    this.version++;
  }

  block(p: Cell): void {
    this.blocked.add(key(p));
    this.version++;
  }

  unblock(p: Cell): void {
    if (this.blocked.delete(key(p))) this.version++;
  }

  isBlocked(p: Cell): boolean {
    return this.blocked.has(key(p));
  }
}

export interface StandRules {
  /** Cells never stood in (future targets). */
  isBlocked?(p: Cell): boolean;
}

/** Feet cell `f` is a place the bot may stand (see the header). */
export function canStand(w: BlockReader, f: Cell, r: StandRules = {}): boolean {
  const head = add(f, 0, 1, 0);
  if (r.isBlocked?.(f) || r.isBlocked?.(head)) return false;
  if (!passable(w.blockAt(f)) || !passable(w.blockAt(head))) return false;
  if (!standTop(w.blockAt(add(f, 0, -1, 0)))) return false;
  for (const s of SIDES) {
    for (const dy of [0, 1]) {
      const b = w.blockAt(add(f, s.x, dy, s.z));
      if (b && HAZARD.test(b.name)) return false;
    }
  }
  return true;
}

export function eyeOf(f: Cell): Cell {
  return { x: f.x + 0.5, y: f.y + EYE_HEIGHT, z: f.z + 0.5 };
}

export function centreDistance(f: Cell, t: Cell): number {
  const e = eyeOf(f);
  return Math.hypot(t.x + 0.5 - e.x, t.y + 0.5 - e.y, t.z + 0.5 - e.z);
}

const same = (a: Cell, b: Cell) => a.x === b.x && a.y === b.y && a.z === b.z;

/** The cell overlaps the body standing at f. */
export function inBody(f: Cell, t: Cell): boolean {
  return t.x === f.x && t.z === f.z && (t.y === f.y || t.y === f.y + 1);
}

/** Clickable neighbours of `t` (the supports a placement into `t` may click). */
export function supportsOf(w: BlockReader, t: Cell): Cell[] {
  return SIX.map((d) => add(t, d.x, d.y, d.z)).filter((s) => clickable(w.blockAt(s)));
}

/** From stand f the bot can place into t: in reach, not in the body, a support it can click. */
export function canPlaceFrom(w: BlockReader, f: Cell, t: Cell, reach = BUILD_REACH): boolean {
  if (inBody(f, t) || centreDistance(f, t) > reach) return false;
  const eye = eyeOf(f);
  return supportsOf(w, t).some((s) => closestDistance(eye, s) <= DEFAULT_CLICK_REACH && cornerDistance(eye, s) <= SERVER_CLICK_REACH);
}

/**
 * Track B1 (decision 0124): the click that places `pl` into `t` with its states from eye `eye`, or undefined (in
 * reach as canPlaceFrom, a support of an allowed face, the eye where a six-way block needs it).
 */
export function clickFor(w: BlockReader, eye: Vec3, t: Cell, pl: Placement, o: { isScaffold?: (p: Cell) => boolean; margin?: number } = {}): ClickChoice | undefined {
  return chooseClick(w, eye, t, pl.need, { clickable: (s) => clickable(w.blockAt(s)), ...(o.isScaffold ? { isScaffold: o.isScaffold } : {}), ...(o.margin !== undefined ? { margin: o.margin } : {}) });
}

/** Track B1: from stand f the bot can place `pl` into t with its states (the extra cells out of the body too). */
export function canPlaceWith(w: BlockReader, f: Cell, t: Cell, pl: Placement, reach = BUILD_REACH, isScaffold?: (p: Cell) => boolean): ClickChoice | undefined {
  if (inBody(f, t) || centreDistance(f, t) > reach) return undefined;
  for (const e of pl.extra) if (inBody(f, add(t, e.offset.x, e.offset.y, e.offset.z))) return undefined;
  return clickFor(w, eyeOf(f), t, pl, isScaffold ? { isScaffold } : {});
}

/** From stand f the bot can dig t: in reach, not in the body, not the block under the feet. */
export function canDigFrom(f: Cell, t: Cell, reach = BUILD_REACH): boolean {
  return !inBody(f, t) && !same(t, add(f, 0, -1, 0)) && centreDistance(f, t) <= reach;
}

export interface Area {
  min: Cell;
  max: Cell;
}

/** The work area around a set of cells: `h` blocks sideways, `v` up and down. */
export function areaAround(cells: readonly Cell[], h = 6, v = 4, extra?: Cell): Area {
  const all = extra ? [...cells, extra] : cells;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const c of all) {
    min.x = Math.min(min.x, c.x);
    min.y = Math.min(min.y, c.y);
    min.z = Math.min(min.z, c.z);
    max.x = Math.max(max.x, c.x);
    max.y = Math.max(max.y, c.y);
    max.z = Math.max(max.z, c.z);
  }
  return { min: { x: min.x - h, y: min.y - v, z: min.z - h }, max: { x: max.x + h, y: max.y + v, z: max.z + h } };
}

const inArea = (a: Area, p: Cell) => p.x >= a.min.x && p.x <= a.max.x && p.y >= a.min.y && p.y <= a.max.y && p.z >= a.min.z && p.z <= a.max.z;

/**
 * Stands reachable inside `area` (see the header): from `start` (the bot's feet cell, taken as is)
 * and from every stand on the area's side faces.
 */
export function reachableStands(w: BlockReader, area: Area, start: Cell | undefined, r: StandRules = {}): Set<string> {
  const seen = new Set<string>();
  const queue: Cell[] = [];
  const push = (c: Cell) => {
    const k = key(c);
    if (seen.has(k)) return;
    seen.add(k);
    queue.push(c);
  };
  if (start && inArea(area, start)) push(start);
  for (let y = area.min.y; y <= area.max.y; y++) {
    for (let x = area.min.x; x <= area.max.x; x++) {
      for (const z of [area.min.z, area.max.z]) if (canStand(w, { x, y, z }, r)) push({ x, y, z });
    }
    for (let z = area.min.z + 1; z < area.max.z; z++) {
      for (const x of [area.min.x, area.max.x]) if (canStand(w, { x, y, z }, r)) push({ x, y, z });
    }
  }
  for (const c of queue) {
    for (const s of SIDES) {
      for (const dy of [0, 1, -1]) {
        const n = { x: c.x + s.x, y: c.y + dy, z: c.z + s.z };
        if (!inArea(area, n) || seen.has(key(n))) continue;
        if (!canStand(w, n, r)) continue;
        // a step up needs the cell over the head free where the jump starts; a step down the cell
        // over the head at the arrival (the body passes through it)
        if (dy === 1 && !passable(w.blockAt(add(c, 0, 2, 0)))) continue;
        if (dy === -1 && !passable(w.blockAt(add(n, 0, 2, 0)))) continue;
        push(n);
      }
    }
  }
  return seen;
}

export function parseKey(k: string): Cell {
  const [x, y, z] = k.split(',').map(Number);
  return { x: x!, y: y!, z: z! };
}
