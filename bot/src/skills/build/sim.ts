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

/**
 * The top a body stands on: the highest box top, when a box at that top covers the cell's centre (the goto's floor rule,
 * terrain/classify.ts `floorShape`); undefined otherwise. Track B9 (decision 0134): an open trapdoor's panel is 1 high at
 * one side of its cell: taken as a floor, it gave a room a way out the goto did not have (the bot was shut in).
 */
function floorTop(b: BlockLike | undefined): number | undefined {
  if (!b || b.boxes.length === 0 || b.name === 'unknown' || HAZARD.test(b.name)) return undefined;
  let top = 0;
  for (const bx of b.boxes) top = Math.max(top, bx[4] ?? 0);
  const covers = b.boxes.some((bx) => (bx[4] ?? 0) === top && (bx[0] ?? 0) <= 0.5 && (bx[3] ?? 1) >= 0.5 && (bx[2] ?? 0) <= 0.5 && (bx[5] ?? 1) >= 0.5);
  return covers ? top : undefined;
}

/** A full-height top to stand on (slabs at the bottom half, fences and walls are not used). */
export function standTop(b: BlockLike | undefined): boolean {
  const top = floorTop(b);
  return top !== undefined && top > 0.9 && top <= 1.0001;
}

/**
 * Track B9 (decision 0134): a bottom half's top (a slab, a stair's low half): no stand of the plan (its eye would be half
 * a block lower than the plan's), but a walk crosses it (half a step up and down). A line of slabs on a floor walled the
 * floor's middle off from every walk the plan knew (a house's second layer, 307 cells out of reach).
 */
export function halfTop(b: BlockLike | undefined): boolean {
  const top = floorTop(b);
  return top !== undefined && top > 0.4 && top < 0.6;
}

/** Track B9: a feet cell a walk passes through: as canStand, on a half top (halfTop) as well as a full one. */
export function canCross(w: BlockReader, f: Cell, r: StandRules = {}): boolean {
  if (canStand(w, f, r)) return true;
  const head = add(f, 0, 1, 0);
  if (r.isBlocked?.(f) || r.isBlocked?.(head)) return false;
  if (!passable(w.blockAt(f)) || !passable(w.blockAt(head)) || !halfTop(w.blockAt(add(f, 0, -1, 0)))) return false;
  for (const s of SIDES) {
    for (const dy of [0, 1]) {
      const b = w.blockAt(add(f, s.x, dy, s.z));
      if (b && HAZARD.test(b.name)) return false;
    }
  }
  return true;
}

/** Track B9: the height the feet are at in feet cell `f` (on a full top f.y, on a half top half a block lower). */
function feetHeight(w: BlockReader, f: Cell): number | undefined {
  if (!passable(w.blockAt(f)) || !passable(w.blockAt(add(f, 0, 1, 0)))) return undefined;
  const under = w.blockAt(add(f, 0, -1, 0));
  return standTop(under) ? f.y : halfTop(under) ? f.y - 0.5 : undefined;
}

/** Track B9: the highest rise a walk climbs (a jump; the goto's own limit). */
export const STEP_RISE = 1.25;
/** Track B9: how far sideways a walk from a stand must get for the stand to have a way out (wayOut). */
export const WAY_OUT = 3;
/** Track B9: the cells wayOut looks through; a pocket that big is open enough. */
export const WAY_NODES = 64;
/** Track B9: with the build's footprint, the cells wayOut looks through before it takes the stand as open. */
export const WAY_NODES_FOOT = 4096;

/** Track B9: the build's footprint (x and z): a walk that leaves it is out. */
export interface Footprint {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * Track B9 (decision 0134): feet cell `f` still has a way out once a block is at `t` (taken as a full block): a walk
 * from it gets WAY_OUT blocks sideways (steps of at most STEP_RISE up, drops of up to 3), or finds more than WAY_NODES
 * cells. The cells the build fills later are still air here (the bot walks through them now). On the house the runner
 * stood in a cell the build left open (a refused one) among blocks topped with bottom slabs (a rise of 1.5), placed
 * the last block beside it from there and could not walk out again: 20 minutes of `walk: unreachable`, a shulker box
 * set down beside it never picked up again, the build stopped `cannot get` at 5 778 of 9 384.
 * With the build's footprint `foot` the walk has to leave it, grown by WAY_OUT, instead (or find more than WAY_NODES_FOOT cells): 3 blocks
 * sideways were found inside a room of 13 cells whose last pane the runner placed from inside it.
 */
export function wayOut(w: BlockReader, f: Cell, t?: Cell, foot?: Footprint): boolean {
  // (with the footprint a block farther off may still shut the room's doorway: only one off the walk's heights is passed)
  if (t && ((!foot && Math.max(Math.abs(t.x - f.x), Math.abs(t.z - f.z)) > WAY_OUT) || t.y < f.y - 1 || t.y > f.y + 2)) return true;
  // the footprint grown by WAY_OUT (a pocket just outside a wall is shut in too)
  const m = WAY_OUT;
  const out = (n: Cell): boolean => (foot ? n.x < foot.minX - m || n.x > foot.maxX + m || n.z < foot.minZ - m || n.z > foot.maxZ + m : Math.max(Math.abs(n.x - f.x), Math.abs(n.z - f.z)) >= WAY_OUT);
  const cap = foot ? WAY_NODES_FOOT : WAY_NODES;
  if (foot && out(f)) return true;
  const tk = t ? key(t) : undefined;
  const view: BlockReader = { blockAt: (p) => (tk !== undefined && key(p) === tk ? SOLID : w.blockAt(p)) };
  const seen = new Set([key(f)]);
  const queue: { c: Cell; y: number }[] = [{ c: f, y: feetHeight(view, f) ?? f.y }];
  // the queue grows while it is walked (an array's iterator sees what is pushed)
  for (const { c, y } of queue) {
    if (queue.length > cap) return true;
    for (const s of SIDES) {
      for (const dy of [0, 1, -1, -2, -3]) {
        const n = add(c, s.x, dy, s.z);
        const k = key(n);
        if (seen.has(k)) continue;
        const ny = feetHeight(view, n);
        if (ny === undefined || ny - y > STEP_RISE) continue;
        if (dy > 0 && !passable(view.blockAt(add(c, 0, 2, 0)))) continue;
        let clear = true;
        for (let yy = n.y + 2; yy <= c.y + 1; yy++) if (!passable(view.blockAt({ x: n.x, y: yy, z: n.z }))) clear = false;
        if (!clear) continue;
        if (out(n)) return true;
        seen.add(k);
        queue.push({ c: n, y: ny });
      }
    }
  }
  return false;
}

/** Track B10: the cells a dig-out search (digWayOut) looks through at most. */
export const DIG_NODES = 20_000;
/** Track B10: the most cells a way out digs (a wall two thick, the head room of a step up). */
export const DIG_MAX = 8;

/** Track B10: a way out of a pocket: the cells to dig (in the order the walk meets them) and the feet cells walked. */
export interface DigWay {
  digs: Cell[];
  path: Cell[];
  /** The walk's steps from the start: the feet cell each ends in and the cells dug before it (beside the cell before). */
  steps: { to: Cell; digs: Cell[] }[];
  cost: number;
}

/**
 * Track B10 (decision 0135): the cheapest way out of a pocket, digging. The walk is wayOut's (steps of at most STEP_RISE
 * up, drops of up to 3, out of `foot` grown by WAY_OUT, or WAY_OUT sideways without it), but a cell in the way may be dug:
 * `cost(p, b)` says what digging the block `b` at `p` costs (undefined: never). A step costs 1 and each cell dug its cost;
 * at most `max` cells are dug. `strict` walks on full tops only and climbs 1 (a pocket the goto finds shut while the
 * plan's walk does not). `{ digs: [] }` when the walk gets out without digging, undefined when nothing gets out.
 */
export function digWayOut(w: BlockReader, f: Cell, foot: Footprint | undefined, cost: (p: Cell, b: BlockLike) => number | undefined, o: { max?: number; nodes?: number; strict?: boolean } = {}): DigWay | undefined {
  const max = o.max ?? DIG_MAX;
  const cap = o.nodes ?? DIG_NODES;
  const m = WAY_OUT;
  const out = (n: Cell): boolean => (foot ? n.x < foot.minX - m || n.x > foot.maxX + m || n.z < foot.minZ - m || n.z > foot.maxZ + m : Math.max(Math.abs(n.x - f.x), Math.abs(n.z - f.z)) >= WAY_OUT);
  if (foot && out(f)) return { digs: [], path: [f], steps: [], cost: 0 };
  const floorOf = (n: Cell): number | undefined => {
    const under = w.blockAt(add(n, 0, -1, 0));
    if (standTop(under)) return n.y;
    return !o.strict && halfTop(under) ? n.y - 0.5 : undefined;
  };
  const hazard = (n: Cell): boolean => {
    for (const s of [...SIDES, { x: 0, y: 0, z: 0 }]) {
      for (const dy of [0, 1]) {
        const b = w.blockAt(add(n, s.x, dy, s.z));
        if (b && (HAZARD.test(b.name) || (dy >= 0 && s.x === 0 && s.z === 0 && isLiquid(b)))) return true;
      }
    }
    return false;
  };
  interface Node {
    c: Cell;
    y: number;
    g: number;
    dug: number;
    prev: Node | undefined;
    digs: Cell[];
  }
  const rise = o.strict ? 1 : STEP_RISE;
  const best = new Map<string, number>();
  const start: Node = { c: f, y: (o.strict ? floorOf(f) : feetHeight(w, f)) ?? f.y, g: 0, dug: 0, prev: undefined, digs: [] };
  // a small binary heap on g
  const heap: Node[] = [start];
  const push = (n: Node): void => {
    heap.push(n);
    for (let i = heap.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (heap[p]!.g <= heap[i]!.g) break;
      [heap[p], heap[i]] = [heap[i]!, heap[p]!];
      i = p;
    }
  };
  const pop = (): Node | undefined => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length && last) {
      heap[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < heap.length && heap[l]!.g < heap[s]!.g) s = l;
        if (r < heap.length && heap[r]!.g < heap[s]!.g) s = r;
        if (s === i) break;
        [heap[s], heap[i]] = [heap[i]!, heap[s]!];
        i = s;
      }
    }
    return top;
  };
  best.set(key(f), 0);
  let expanded = 0;
  // the cells a walk reaches without digging: past wayOut's cap the pocket is open enough
  let open = 0;
  const openCap = foot ? WAY_NODES_FOOT : WAY_NODES;
  const done = (n: Node): DigWay => {
    const path: Cell[] = [];
    const digs: Cell[] = [];
    const seen = new Set<string>();
    const chain: Node[] = [];
    for (let k: Node | undefined = n; k; k = k.prev) chain.push(k);
    chain.reverse();
    const steps: { to: Cell; digs: Cell[] }[] = [];
    for (const k of chain) {
      path.push(k.c);
      const own: Cell[] = [];
      for (const d of k.digs) {
        if (seen.has(key(d))) continue;
        seen.add(key(d));
        digs.push(d);
        own.push(d);
      }
      if (k.prev) steps.push({ to: k.c, digs: own });
    }
    return { digs, path, steps, cost: n.g };
  };
  for (let cur = pop(); cur; cur = pop()) {
    if ((best.get(key(cur.c)) ?? Infinity) < cur.g) continue;
    if (out(cur.c)) return done(cur);
    if (cur.dug === 0 && ++open > openCap) return { digs: [], path: [f], steps: [], cost: 0 };
    if (++expanded > cap) return undefined;
    for (const s of SIDES) {
      for (const dy of [0, 1, -1, -2, -3]) {
        const n = add(cur.c, s.x, dy, s.z);
        const ny = floorOf(n);
        if (ny === undefined || ny - cur.y > rise || hazard(n)) continue;
        // what must be free: the body at n, the head room over the start of a jump, the column the body drops through
        const clear: Cell[] = [add(n, 0, 1, 0), n];
        if (dy > 0) clear.unshift(add(cur.c, 0, 2, 0));
        for (let yy = n.y + 2; yy <= cur.c.y + 1; yy++) clear.unshift({ x: n.x, y: yy, z: n.z });
        let g = cur.g + 1;
        let dug = cur.dug;
        const digs: Cell[] = [];
        let ok = true;
        for (const p of clear) {
          const b = w.blockAt(p);
          if (passable(b)) continue;
          if (!b || isLiquid(b)) {
            ok = false;
            break;
          }
          const c = cost(p, b);
          if (c === undefined) {
            ok = false;
            break;
          }
          g += c;
          dug++;
          digs.push(p);
        }
        if (!ok || dug > max) continue;
        const k = key(n);
        if ((best.get(k) ?? Infinity) <= g) continue;
        best.set(k, g);
        push({ c: n, y: ny, g, dug, prev: cur, digs });
      }
    }
  }
  return undefined;
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

/**
 * Track B3 (decision 0128): the deepest fall one step off stand `f` leads to: for each open side (feet and head free)
 * the free cells under it, at most `cap`. A fall of more than 3 blocks costs health; the planner keeps its stands off
 * such edges (PlanOptions.safeEdge), so a slip or a push off a stand never hurts (a column top is no stand of the plan:
 * the bot pillars onto it and comes down it, it never walks there).
 */
export function edgeDrop(w: BlockReader, f: Cell, cap = 8): number {
  let worst = 0;
  for (const s of SIDES) {
    const n = add(f, s.x, 0, s.z);
    if (!passable(w.blockAt(n)) || !passable(w.blockAt(add(n, 0, 1, 0)))) continue;
    let k = 0;
    while (k < cap && passable(w.blockAt(add(n, 0, -(k + 1), 0)))) k++;
    if (k > worst) worst = k;
    if (worst >= cap) break;
  }
  return worst;
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
        // Track B9: across a half top too (in the set, never a stand: canStand is checked where a stand is chosen)
        if (!canCross(w, n, r)) continue;
        // from a half top a step up onto a full top is a rise of 1.5: no step
        if (dy === 1 && standTop(w.blockAt(add(n, 0, -1, 0))) && !standTop(w.blockAt(add(c, 0, -1, 0))) && halfTop(w.blockAt(add(c, 0, -1, 0)))) continue;
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
