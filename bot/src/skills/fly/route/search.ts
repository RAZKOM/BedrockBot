// Track F2: hybrid A* over the glide state with motion primitives as edges (docs/flight.md "Route planner").
//
// The state is continuous (position, velocity, the boost range, the rockets, the waypoints passed); the
// closed set lives on a lattice over it (half-block cells, 15-degree heading buckets, speed and sink buckets,
// a boost bucket) so the search does not expand the same place at the same energy twice. Edges come from
// `edgeOf` (primitives.ts): every primitive of the library flown from the node's exact state through the grid.
// Cost: ticks + ROCKET_COST per rocket + RISK_COST per tick flown within RISK_RANGE of a solid. Heuristic: the
// chained distance through the remaining goals over the boosted speed, plus the rockets the climb needs
// beyond the body's energy height (a body without a rocket cannot reach a point above its energy height;
// infeasible when the rockets in the hand cannot buy it). Budgets in nodes and ms; a partial plan (the node
// nearest the next goal) when they run out.
import { routeLibrary } from '../maneuvers-route.ts'; // Track F3: the landing library by name
import { HEURISTIC_SPEED, edgeOf, libraryFor, replay } from './primitives.ts';
import { boxClear, type RouteGrid } from './grid.ts';
import { EDGE_TICKS, RISK_COST, RISK_RANGE, ROCKET_COST, goalPoint, hspeed, type Maneuver, type RouteControl, type RouteEdge, type RoutePlan, type RouteRequest, type RouteState } from './types.ts';

/** Blocks of height one rocket can buy at most (straight up: 22 while burning, coasting to 33; at -55 with the momentum 44). */
export const ROCKET_UP = 45;
/** The height a flare converts the horizontal speed into, per (blocks a tick)^2 (from 1.5 b/t a -45 flare gains 24). */
export const ZOOM_PER_H2 = 11;

/**
 * The energy height of a body: how far above its feet it can get without a rocket (the climb its vertical
 * momentum carries, vy^2 / 0.08 as the brain's climbMomentum, plus the zoom climb of its speed).
 */
export function energyHeight(s: Readonly<RouteState>): number {
  const up = s.vel.y > 0 ? (s.vel.y * s.vel.y) / 0.08 : 0;
  const h = hspeed(s.vel);
  return up + ZOOM_PER_H2 * h * h;
}

interface Node {
  s: RouteState;
  g: number;
  f: number;
  h: number;
  parent: Node | undefined;
  edge: RouteEdge | undefined;
  tick: number;
}

class Heap {
  private a: Node[] = [];
  get size(): number {
    return this.a.length;
  }
  push(n: Node): void {
    const a = this.a;
    a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]!.f <= a[i]!.f) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): Node | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]!.f < a[m]!.f) m = l;
        if (r < a.length && a[r]!.f < a[m]!.f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

/** The lattice key of a state (the closed set). */
export function latticeKey(s: Readonly<RouteState>): string {
  const cx = Math.floor(s.pos.x * 2);
  const cy = Math.floor(s.pos.y * 2);
  const cz = Math.floor(s.pos.z * 2);
  const h = hspeed(s.vel);
  const hb = Math.floor(((((h < 0.05 ? s.yaw : (Math.atan2(-s.vel.x, s.vel.z) * 180) / Math.PI) % 360) + 360) % 360) / 15);
  const sb = Math.floor(h / 0.25);
  const vb = Math.floor(s.vel.y / 0.2);
  const bb = s.boost.nom === 0 ? 0 : s.boost.nom <= 5 ? 1 : 2;
  return `${cx},${cy},${cz},${hb},${sb},${vb},${bb},${Math.min(s.rockets, 8)},${s.wp},${s.gliding ? 1 : 0}`;
}

/** The heuristic: ticks to the end through the remaining goals, plus the rockets the climb needs; Infinity when the rockets cannot buy it. */
export function heuristic(s: Readonly<RouteState>, req: RouteRequest): number {
  if (s.wp >= req.goals.length) return 0;
  let d = 0;
  let from = s.pos;
  let top = s.pos.y + energyHeight(s);
  let climb = 0;
  // Track F3: the slow leg of a landing with a `via` point (down a shaft, into a slot), in ticks
  let slow = 0;
  for (let i = s.wp; i < req.goals.length; i++) {
    const g = req.goals[i]!;
    const p = goalPoint(g);
    const via = g.kind === 'landing' && g.via && i === req.goals.length - 1 ? g.via : undefined;
    // (the body is past the via point once it is no farther from the cell than the point is and not above it: inside the shaft, inside the slot)
    const past = via !== undefined && i === s.wp && Math.hypot(p.x - from.x, p.z - from.z) <= Math.hypot(p.x - via.pos.x, p.z - via.pos.z) + 0.3 && from.y <= via.pos.y + 0.5;
    if (via && !past) {
      d += Math.hypot(via.pos.x - from.x, via.pos.y - from.y, via.pos.z - from.z);
      slow += Math.hypot(p.x - via.pos.x, p.y - via.pos.y, p.z - via.pos.z) / Math.max(0.05, via.speed);
      if (via.pos.y > top) {
        climb += via.pos.y - top;
        top = via.pos.y;
      }
      from = via.pos;
      continue;
    }
    d += Math.hypot(p.x - from.x, p.y - from.y, p.z - from.z);
    if (p.y > top) {
      climb += p.y - top;
      top = p.y;
    }
    from = p;
  }
  let h = d / HEURISTIC_SPEED + slow;
  if (climb > 0) {
    const need = Math.ceil(climb / ROCKET_UP);
    if (need > s.rockets) return Infinity;
    h += need * (req.rocketCost ?? ROCKET_COST);
  }
  const last = req.goals[req.goals.length - 1]!;
  if (last.kind === 'landing') {
    // a landing must arrive slowly and come down gently: the speed to bleed (about 6 ticks per block a tick of a
    // brake) and the height to lose at the fastest gentle sink (not admissible in the strict sense: a weighted A*)
    const hs = hspeed(s.vel);
    h += LANDING_BLEED * Math.max(0, hs - (last.maxSpeed ?? 0.3));
    h = Math.max(h, Math.max(0, s.pos.y - last.top) / LANDING_SINK);
  }
  return h;
}

/** Ticks of the landing heuristic per block a tick of speed over the touchdown speed. */
export const LANDING_BLEED = 6;
/** The sink a tick the landing heuristic lets the body lose height at. */
export const LANDING_SINK = 0.2;

function unwind(n: Node, req: RouteRequest, effort: { nodes: number; expanded: number; ms: number; budget: RoutePlan['budget'] }, complete: boolean, why?: string): RoutePlan {
  const chain: Node[] = [];
  for (let c: Node | undefined = n; c; c = c.parent) chain.push(c);
  chain.reverse();
  const controls: RouteControl[] = [];
  const edges: RoutePlan['edges'] = [];
  let rockets = 0;
  let clearance = RISK_RANGE;
  let robust = true;
  for (const c of chain) {
    if (!c.edge) continue;
    edges.push({ name: c.edge.name, at: controls.length, ticks: c.edge.ticks });
    rockets += c.edge.rockets;
    if (c.edge.clearance < clearance) clearance = c.edge.clearance;
    if (!c.edge.robust) robust = false;
    controls.push(...c.edge.controls);
  }
  // the per-tick states: the controls re-flown from the start on the nominal burn
  const states = replay(req.start, controls, req.goals, req.stackRockets === true);
  return {
    controls,
    states,
    edges,
    ticks: controls.length,
    rockets,
    cost: n.g,
    clearance,
    complete,
    reached: n.s.wp,
    robust: edges.length > 0 && robust,
    nodes: effort.nodes,
    expanded: effort.expanded,
    ms: effort.ms,
    budget: effort.budget,
    ...(why ? { why } : {}),
  };
}

/** The margin the first edges from `start` keep: the request's, or half the body's real clearance when it is already within the margin of a solid. */
export function startMarginFor(grid: RouteGrid, start: Readonly<RouteState>, margin: number): number {
  if (!start.gliding) return 0; // a takeoff starts on the floor: the first edges are checked on the bare box
  const c = boxClear(grid, start.pos, 0).clearance;
  return c < margin ? Math.max(0, c * 0.5) : margin;
}

export interface SearchOptions {
  /** The library (default libraryFor(req.families); the takeoff yaws come from the first goal's bearing). */
  library?: Maneuver[];
}

/**
 * Track F3: the edge set a request names (`RouteRequest.library`): `landing` is F2's glides, turns and rockets
 * (no brake, hover, settle or takeoff of its own) with Track F1's manoeuvres and the brake landing's approaches
 * and settles onto every landing goal; `minimal` (default) is F2's whole library.
 */
export function libraryNamed(req: RouteRequest, edgeTicks: number, takeoffYaws: readonly number[]): Maneuver[] {
  // (Track F4a: a standing start gets F2's jump takeoffs too: a leg from a ledge to a landing, the obstacle course's finish)
  if (req.library === 'landing') return [...libraryFor(['glide', 'turn', 'rocket', 'takeoff'], edgeTicks, takeoffYaws, req.goals), ...(routeLibrary(req.goals) as Maneuver[])];
  return libraryFor(req.families, edgeTicks, takeoffYaws, req.goals);
}

/**
 * Plan a route for `req` on `grid`. Deterministic; the budgets end it with the best partial plan. The first
 * search sweeps the burn branches (robust by construction); when it finds no complete plan, a second one
 * without them gets the rest of the budget and its plan says `robust: false`.
 */
export function planRoute(req: RouteRequest, grid: RouteGrid, o: SearchOptions = {}): RoutePlan {
  if (req.burnBranches === false) return searchOnce(req, grid, o);
  const t0 = performance.now();
  const robust = searchOnce({ ...req, burnBranches: true }, grid, o);
  // (a plan without rockets has no branches, unless a burn already runs from the start: Track F4a)
  const burning = req.start.boost.max > 0 && req.start.boost.min < req.start.boost.max;
  if (robust.complete || (robust.rockets === 0 && !burning)) return robust;
  const left = req.maxMs - (performance.now() - t0);
  if (left < 5) return robust;
  const plain = searchOnce({ ...req, burnBranches: false, maxMs: left, maxNodes: Math.max(1, req.maxNodes - robust.nodes) }, grid, o);
  plain.nodes += robust.nodes;
  plain.expanded += robust.expanded;
  plain.ms += robust.ms;
  if (!plain.complete && plain.reached <= robust.reached) return robust;
  return plain;
}

function searchOnce(req: RouteRequest, grid: RouteGrid, o: SearchOptions): RoutePlan {
  const t0 = performance.now();
  const edgeTicks = req.edgeTicks ?? EDGE_TICKS;
  const first = req.goals[0] ? goalPoint(req.goals[0]) : undefined;
  const bearing = first ? (Math.atan2(-(first.x - req.start.pos.x), first.z - req.start.pos.z) * 180) / Math.PI : 0;
  const takeoffYaws = req.start.gliding ? [] : [bearing, bearing + 30, bearing - 30, bearing + 60, bearing - 60, bearing + 90, bearing - 90];
  const lib = o.library ?? libraryNamed(req, edgeTicks, takeoffYaws);
  const ctx = { grid, margin: req.margin, goals: req.goals, stackRockets: req.stackRockets === true, burnBranches: req.burnBranches !== false };
  // a body already within the margin of a solid (the tracker re-planning from a grazing state) still gets edges:
  // the first edges keep half its real clearance, the rest of the plan the full margin
  const startMargin = startMarginFor(grid, req.start, req.margin);
  const ctx0 = startMargin < req.margin ? { ...ctx, margin: startMargin } : ctx;
  const rocketCost = req.rocketCost ?? ROCKET_COST;
  const riskCost = req.riskCost ?? RISK_COST;
  const weight = req.weight ?? 1;
  const open = new Heap();
  const closed = new Set<string>();
  const h0 = heuristic(req.start, req);
  // Track F4a: a burn already running whose end is unknown (the tracker re-plans mid-burn: its range is [min, max]) is
  // branched from the start, as a rocket fired in the plan is, so the plan clears for its every end
  const b0 = req.start.boost;
  const s0 = ctx.burnBranches && b0.max > 0 && b0.min < b0.max && !req.start.early ? { ...req.start, early: { pos: { ...req.start.pos }, vel: { ...req.start.vel } }, late: { pos: { ...req.start.pos }, vel: { ...req.start.vel } } } : req.start;
  const start: Node = { s: s0, g: 0, f: weight * h0, h: h0, parent: undefined, edge: undefined, tick: 0 };
  const effort = { nodes: 1, expanded: 0, ms: 0, budget: 'none' as RoutePlan['budget'] };
  if (!Number.isFinite(h0)) {
    effort.ms = performance.now() - t0;
    return unwind(start, req, effort, false, 'the goal is above what the rockets in the hand can buy');
  }
  if (req.goals.length === 0) {
    effort.ms = performance.now() - t0;
    return unwind(start, req, effort, true);
  }
  open.push(start);
  let best = start; // the node nearest the end (most goals, then the least heuristic)
  const better = (n: Node): boolean => n.s.wp > best.s.wp || (n.s.wp === best.s.wp && n.h < best.h);
  while (open.size) {
    if (effort.nodes >= req.maxNodes) {
      effort.budget = 'nodes';
      break;
    }
    if ((effort.expanded & 63) === 0 && performance.now() - t0 > req.maxMs) {
      effort.budget = 'ms';
      break;
    }
    const n = open.pop()!;
    if (n.s.wp >= req.goals.length) {
      effort.ms = performance.now() - t0;
      return unwind(n, req, effort, true);
    }
    const key = latticeKey(n.s);
    if (closed.has(key)) continue;
    closed.add(key);
    effort.expanded++;
    for (const m of lib) {
      const e = edgeOf(m, n.s, n.parent ? ctx : ctx0);
      if (!e) continue;
      const h = heuristic(e.out, req);
      if (!Number.isFinite(h)) continue;
      const g = n.g + e.ticks + e.rockets * rocketCost + e.risk * riskCost;
      const child: Node = { s: e.out, g, f: g + weight * h, h, parent: n, edge: e, tick: n.tick + e.ticks };
      effort.nodes++;
      if (child.s.wp >= req.goals.length) {
        effort.ms = performance.now() - t0;
        return unwind(child, req, effort, true);
      }
      if (closed.has(latticeKey(child.s))) continue;
      if (better(child)) best = child;
      open.push(child);
    }
  }
  effort.ms = performance.now() - t0;
  const why = effort.budget === 'none' ? 'no route: the open list emptied (every primitive from every reached state hits)' : `the ${effort.budget} budget ran out ${best.s.wp} of ${req.goals.length} goals in`;
  return unwind(best, req, effort, false, why);
}
