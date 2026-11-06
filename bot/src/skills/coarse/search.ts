// Track CB (ADR 0066, docs/coarse.md "The search"): A* over the coarse graph. A node is "standing at a
// portal's centre, about to cross it into a volume, in a mode"; an edge crosses that portal and travels
// inside the volume to one of its other portals (the next node), priced by the entered mode's
// CoarseCost.edgeCost plus the switch cost when the mode changes. The start is a pseudo-portal at the
// start point, the goal a terminal node in the goal's volume. The search runs in slices of a few ms with
// the event loop between them (the owner's physics tick never waits for it).
import type { Vec3 } from '../../world/types.ts';
import { coarseDistance as dist, type PortalMarks } from './costs.ts';
import type { CoarseGraph } from './graph.ts';
import type { CoarseCost, CoarseMode, Corridor, CorridorLeg, PlanRequest, Portal, Volume } from './types.ts';

/** Default search limits (PlanRequest.maxNodes / maxMs). */
export const DEFAULT_MAX_NODES = 200_000;
export const DEFAULT_MAX_MS = 500;
/** One slice of search (ms); the event loop runs between slices. */
export const SLICE_MS = 6;
/** Mode switch price without a `switchCost` (PlanRequest.modeSwitchCost). */
export const DEFAULT_SWITCH_COST = 40;
/** The heuristic's slope for a cost without `ticksPerBlock`. */
export const DEFAULT_TICKS_PER_BLOCK = 0.5;
/**
 * Weighted A* (f = g + HEURISTIC_WEIGHT x h, Baritone's greedy search): a corridor at most this factor
 * dearer than the cheapest, for a fraction of the nodes (plain A* across 64 x 64 hilly chunks expanded
 * 48 000 nodes and built every chunk; at 1.5 a few thousand). The corridor is rough anyway.
 */
export const HEURISTIC_WEIGHT = 1.5;
/** A start or goal cell inside solid is looked for up to this many cells above / below. */
const SNAP = 2;
/**
 * Unknown space is unbounded, so it is searched only inside an ellipse round the start and the goal:
 * a portal into an unknown volume is taken when its distance to both summed is at most
 * UNKNOWN_REACH_FACTOR x the straight-line distance + UNKNOWN_REACH_MARGIN blocks. Beyond, unknown
 * chunks count as impassable for the plan (a `none` is exhaustive over the known world plus that ellipse).
 */
export const UNKNOWN_REACH_FACTOR = 1.5;
export const UNKNOWN_REACH_MARGIN = 64;

interface Node {
  key: string;
  /** The portal about to be crossed (the start pseudo-portal for the first node, the goal pseudo-portal for the terminal). */
  portal: Portal;
  /** The volume on this side and the one entered. */
  from: Volume;
  to: Volume;
  mode: CoarseMode;
  g: number;
  h: number;
  parent: Node | undefined;
  terminal: boolean;
}

/** A binary min-heap on f = g + h. */
class Heap {
  private readonly a: Node[] = [];
  get size(): number {
    return this.a.length;
  }
  push(n: Node): void {
    const a = this.a;
    a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (f(a[p]!) <= f(n)) break;
      a[i] = a[p]!;
      i = p;
    }
    a[i] = n;
  }
  pop(): Node | undefined {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length && last) {
      let i = 0;
      const n = a.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        let fm = f(last);
        if (l < n && f(a[l]!) < fm) {
          m = l;
          fm = f(a[l]!);
        }
        if (r < n && f(a[r]!) < fm) m = r;
        if (m === i) break;
        a[i] = a[m]!;
        i = m;
      }
      a[i] = last;
    }
    return top;
  }
}

const f = (n: Node): number => n.g + HEURISTIC_WEIGHT * n.h;

export interface SearchDeps {
  graph: CoarseGraph;
  costs: ReadonlyMap<CoarseMode, CoarseCost>;
  marks: PortalMarks;
}

const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

/** A volume at p, or within SNAP cells above or below it (a slab, a carpet, a feet position inside a block). */
function snapVolume(graph: CoarseGraph, p: Vec3, dim: number): Volume | undefined {
  const direct = graph.volumeAt(p, dim);
  if (direct) return direct;
  for (let d = 1; d <= SNAP; d++) {
    const up = graph.volumeAt({ x: p.x, y: p.y + d, z: p.z }, dim);
    if (up) return up;
    const down = graph.volumeAt({ x: p.x, y: p.y - d, z: p.z }, dim);
    if (down) return down;
  }
  return undefined;
}

const cellOf = (p: Vec3): Vec3 => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });

function pseudoPortal(id: string, p: Vec3, v: Volume, standing: boolean): Portal {
  const c = cellOf(p);
  return { id, a: v.id, b: v.id, axis: 'y', min: c, max: c, center: { x: p.x, y: p.y, z: p.z }, clearance: { height: 16, width: 16 }, ...(standing ? { floorY: c.y } : {}), known: v.known };
}

/** Plan a corridor. Never throws: a failure is a `none` / `partial` corridor with a reason. */
export async function planCorridor(deps: SearchDeps, req: PlanRequest, dim: number, revision: number): Promise<Corridor> {
  const t0 = performance.now();
  const start = { x: req.start.x, y: req.start.y, z: req.start.z };
  const goal = { x: req.goal.x, y: req.goal.y, z: req.goal.z };
  const base = (status: Corridor['status'], reason: string, extra: Partial<Corridor> = {}): Corridor => ({ status, start, goal, dim, legs: [], blocks: 0, cost: 0, unknownFraction: 0, reason, expanded: 0, ms: performance.now() - t0, revision, ...extra });
  const modes = req.modes.filter((m) => deps.costs.has(m));
  if (modes.length === 0) return base('none', `no cost registered for ${req.modes.join(', ') || 'any mode'}`);
  const { graph, marks } = deps;
  let v0: Volume | undefined;
  let vGoal: Volume | undefined;
  try {
    v0 = snapVolume(graph, start, dim);
    vGoal = snapVolume(graph, goal, dim);
  } catch (e) {
    return base('none', `graph build failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!v0) return base('none', `the start ${fmt(start)} is inside solid`);
  if (!vGoal) return base('none', `the goal ${fmt(goal)} is inside solid`);
  const startMode: CoarseMode = req.startMode ?? 'walk';
  const goalStanding = req.goalStanding ?? true;
  const switchDefault = req.modeSwitchCost ?? DEFAULT_SWITCH_COST;
  const maxNodes = req.maxNodes ?? DEFAULT_MAX_NODES;
  const maxMs = req.maxMs ?? DEFAULT_MAX_MS;
  let slope = Infinity;
  for (const m of modes) slope = Math.min(slope, deps.costs.get(m)!.ticksPerBlock ?? DEFAULT_TICKS_PER_BLOCK);
  const h = (p: Vec3): number => dist(p, goal) * slope;
  const reach = UNKNOWN_REACH_FACTOR * dist(start, goal) + UNKNOWN_REACH_MARGIN;
  const inReach = (p: Vec3): boolean => dist(p, start) + dist(p, goal) <= reach;

  const open = new Heap();
  const closed = new Map<string, number>();
  const startPortal = pseudoPortal(`${dim}:start`, start, v0, startMode !== 'fly');
  const goalPortal = pseudoPortal(`${dim}:goal`, goal, vGoal, goalStanding);
  const root: Node = { key: 'start', portal: startPortal, from: v0, to: v0, mode: startMode, g: 0, h: h(start), parent: undefined, terminal: false };
  open.push(root);
  let best = root;
  let expanded = 0;
  let searchMs = 0;
  let limit: string | undefined;
  let done: Node | undefined;
  let sliceStart = performance.now();

  const relax = (n: Node, q: Portal, w: Volume, blocks: number, terminal: boolean): void => {
    for (const m of modes) {
      const cost = deps.costs.get(m)!;
      if (!cost.allows(n.to.kind)) continue;
      let sw = 0;
      if (m !== n.mode) {
        sw = cost.switchCost ? cost.switchCost(n.mode, n.from, n.parent ? n.portal : undefined) : switchDefault;
        if (!Number.isFinite(sw)) continue;
      }
      if (terminal && goalStanding && m === 'fly' && n.to.floorCells === 0) continue;
      const c = cost.edgeCost(n.portal, n.from, n.to, blocks, marks.get(n.portal.id, m));
      if (!Number.isFinite(c) || c < 0) continue;
      const g = n.g + sw + c;
      const key = terminal ? `goal|${m}` : `${q.id}|${w.id}|${m}`;
      const seen = closed.get(key);
      if (seen !== undefined && seen <= g) continue;
      closed.set(key, g);
      const node: Node = { key, portal: q, from: n.to, to: w, mode: m, g, h: terminal ? 0 : h(q.center), parent: n, terminal };
      open.push(node);
    }
  };

  try {
    for (;;) {
      const n = open.pop();
      if (!n) break;
      if (closed.get(n.key) !== n.g && n !== root) continue; // a stale duplicate
      if (n.terminal) {
        done = n;
        break;
      }
      expanded++;
      if (n.h < best.h || (n.h === best.h && n.g < best.g)) best = n;
      const at = n.portal.center;
      // the goal volume: a terminal edge straight to the goal point
      if (n.to.id === vGoal.id) relax(n, goalPortal, vGoal, dist(at, goal), true);
      const real = graph.portalsOf(n.to);
      const list = modes.includes('mine') ? real.concat(graph.digPortalsOf(n.to, real)) : real;
      for (const q of list) {
        if (q.id === n.portal.id) continue;
        const w = graph.across(q, n.to);
        if (!w) continue;
        if (w.kind === 'unknown' && !inReach(q.center)) continue;
        relax(n, q, w, dist(at, q.center), false);
      }
      if (expanded >= maxNodes) {
        limit = `${maxNodes} nodes`;
        break;
      }
      const now = performance.now();
      if (now - sliceStart >= SLICE_MS) {
        searchMs += now - sliceStart;
        if (searchMs >= maxMs) {
          limit = `${maxMs} ms`;
          break;
        }
        await yieldLoop();
        sliceStart = performance.now();
      }
    }
  } catch (e) {
    return base('none', `search failed: ${e instanceof Error ? e.message : String(e)}`, { expanded });
  }
  searchMs += performance.now() - sliceStart;
  if (done) return assemble(done, dim, revision, start, goal, expanded, searchMs, 'found', undefined);
  if (!limit) return base('none', `no corridor to ${fmt(goal)} in ${modes.join(' / ')} (${expanded} volumes expanded)`, { expanded, ms: searchMs });
  if (best === root) return base('partial', `search limit hit (${limit}) with no progress from the start`, { expanded, ms: searchMs });
  return assemble(best, dim, revision, start, goal, expanded, searchMs, 'partial', `search limit hit (${limit}): corridor ends ${Math.round(dist(best.portal.center, goal))} blocks from the goal`);
}

/**
 * The corridor along a node chain. Step k (chain[k + 1]) arrives at its portal q_k in mode m_k, having
 * crossed the previous node's portal (q_{k-1}, the start pseudo-portal for k = 0) and travelled inside
 * step k's `from` volume; the terminal step arrives at the goal. A leg is a maximal run of steps in one
 * mode: it enters through q_{i-1} (the switch happens there, before the crossing), crosses q_i .. q_{j-1}
 * and leaves by q_j (the next leg's entry); its waypoints are from, the centres of q_i .. q_{j-1}, to.
 */
function assemble(end: Node, dim: number, revision: number, start: Vec3, goal: Vec3, expanded: number, ms: number, status: Corridor['status'], reason: string | undefined): Corridor {
  const chain: Node[] = [];
  for (let n: Node | undefined = end; n; n = n.parent) chain.push(n);
  chain.reverse();
  const steps = chain.slice(1);
  const last = steps.length - 1;
  const pointOf = (k: number): Vec3 => (k < 0 ? start : steps[k]!.terminal ? goal : steps[k]!.portal.center);
  const legs: CorridorLeg[] = [];
  let i = 0;
  while (i <= last) {
    const mode = steps[i]!.mode;
    let j = i;
    while (j + 1 <= last && steps[j + 1]!.mode === mode) j++;
    const endsAtGoal = steps[j]!.terminal;
    const entry = i === 0 ? undefined : steps[i - 1]!.portal;
    // the portal the leg leaves by; a partial corridor ends at its last portal (no exit, but the portal is listed)
    const exit = endsAtGoal || j === last ? undefined : steps[j]!.portal;
    const from = entry ? switchPoint(entry) : start;
    const to = endsAtGoal ? goal : switchPoint(steps[j]!.portal);
    const portals: Portal[] = [];
    if (entry) portals.push(entry);
    for (let k = i; k < j; k++) portals.push(steps[k]!.portal);
    if (!endsAtGoal) portals.push(steps[j]!.portal);
    const waypoints: Vec3[] = [{ ...from }];
    for (let k = i; k < j; k++) waypoints.push({ ...pointOf(k) });
    waypoints.push({ ...to });
    let blocks = 0;
    let unknown = 0;
    let prev = from;
    const volumes: string[] = [];
    for (let k = i; k <= j; k++) {
      const pt = k === j ? to : pointOf(k);
      const d = dist(prev, pt);
      blocks += d;
      if (steps[k]!.from.kind === 'unknown') unknown += d;
      volumes.push(steps[k]!.from.id);
      prev = pt;
    }
    let minH = Infinity;
    let minW = Infinity;
    for (const p of portals) {
      if (p.clearance.height < minH) minH = p.clearance.height;
      if (p.clearance.width < minW) minW = p.clearance.width;
    }
    legs.push({
      mode,
      from: { ...from },
      to: { ...to },
      ...(entry ? { entry } : {}),
      ...(exit ? { exit } : {}),
      portals,
      volumes: dedupe(volumes),
      waypoints: dedupeWaypoints(waypoints),
      blocks,
      cost: steps[j]!.g - (i === 0 ? 0 : steps[i - 1]!.g),
      unknownFraction: blocks > 0 ? unknown / blocks : 0,
      minClearance: { height: minH === Infinity ? 16 : minH, width: minW === Infinity ? 16 : minW },
    });
    i = j + 1;
  }
  const blocks = legs.reduce((a, l) => a + l.blocks, 0);
  const unknown = legs.reduce((a, l) => a + l.blocks * l.unknownFraction, 0);
  return {
    status,
    start,
    goal,
    dim,
    legs,
    blocks,
    cost: end.g,
    unknownFraction: blocks > 0 ? unknown / blocks : 0,
    ...(reason ? { reason } : {}),
    expanded,
    ms,
    revision,
  };
}

/** Where a mode switch at a portal happens: its centre lowered to its floor (a landing, a takeoff stand). */
function switchPoint(p: Portal): Vec3 {
  return { x: p.center.x, y: p.floorY ?? p.center.y, z: p.center.z };
}

function dedupe(ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) if (out[out.length - 1] !== id) out.push(id);
  return out;
}

function dedupeWaypoints(w: Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  for (const p of w) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-9 && Math.abs(last.y - p.y) < 1e-9 && Math.abs(last.z - p.z) < 1e-9) continue;
    out.push(p);
  }
  return out;
}

const fmt = (p: Vec3): string => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
