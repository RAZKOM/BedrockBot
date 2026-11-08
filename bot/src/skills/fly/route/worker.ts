// Track F2: the route search off the main thread, the planner worker's pattern (nav/worker.ts, decisions/0023):
// this same file started as a `worker_threads` Worker with `workerData.bedrockbotRoute` runs `planRoute` on a
// grid snapshot; `RoutePlannerClient` on the main thread sends one request at a time and resolves its plan.
//
// A route problem is local (a tunnel, a field of a few hundred blocks), so the grid crosses the thread as a
// dense snapshot of the box around the start and the goals (`snapshotFor`: one byte per cell, 1 = solid or
// unknown; cells outside the box are solid), transferred, not copied. The tracker keeps flying its old plan
// (or holds) until the answer arrives (tracker.ts).
import { isMainThread, parentPort, Worker, workerData, type MessagePort } from 'node:worker_threads';
import type { Vec3 } from '../../../connection/types.ts';
import { silentLogger, type Logger } from '../../../log.ts';
import { gridOfCells, type RouteGrid } from './grid.ts';
import { planRoute } from './search.ts';
import { goalPoint, type RoutePlan, type RouteRequest } from './types.ts';

export interface GridSnapshot {
  min: Vec3;
  size: Vec3;
  /** x fastest, then z, then y: index = (y * size.z + z) * size.x + x. */
  data: Uint8Array;
}

/** The blocks around the start and the goals the snapshot covers (a plan may swing wide of the straight line). */
export const SNAPSHOT_PAD = 24;
/** The snapshot's largest side (blocks): a request beyond it is clipped (its cells outside count as solid). */
export const SNAPSHOT_MAX = 256;

/** A snapshot of `grid` over the box `min` .. `min + size` (exclusive). */
export function snapshotGrid(grid: RouteGrid, min: Vec3, size: Vec3): GridSnapshot {
  const data = new Uint8Array(size.x * size.y * size.z);
  let i = 0;
  for (let y = 0; y < size.y; y++) for (let z = 0; z < size.z; z++) for (let x = 0; x < size.x; x++) data[i++] = grid.solid(min.x + x, min.y + y, min.z + z) ? 1 : 0;
  return { min, size, data };
}

/** The snapshot a request needs: the box of the start and the goals, padded by SNAPSHOT_PAD, at most SNAPSHOT_MAX a side. */
export function snapshotFor(grid: RouteGrid, req: RouteRequest, pad = SNAPSHOT_PAD): GridSnapshot {
  const pts = [req.start.pos, ...req.goals.map(goalPoint)];
  const lo = { x: Infinity, y: Infinity, z: Infinity };
  const hi = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of pts) {
    lo.x = Math.min(lo.x, p.x);
    lo.y = Math.min(lo.y, p.y);
    lo.z = Math.min(lo.z, p.z);
    hi.x = Math.max(hi.x, p.x);
    hi.y = Math.max(hi.y, p.y);
    hi.z = Math.max(hi.z, p.z);
  }
  const min = { x: Math.floor(lo.x - pad), y: Math.floor(lo.y - pad), z: Math.floor(lo.z - pad) };
  const size = {
    x: Math.min(SNAPSHOT_MAX, Math.ceil(hi.x + pad) - min.x + 1),
    y: Math.min(SNAPSHOT_MAX, Math.ceil(hi.y + pad) - min.y + 1),
    z: Math.min(SNAPSHOT_MAX, Math.ceil(hi.z + pad) - min.z + 1),
  };
  return snapshotGrid(grid, min, size);
}

/** A RouteGrid over a snapshot (cells outside it are solid). */
export function gridOfSnapshot(s: GridSnapshot): RouteGrid {
  const { min, size, data } = s;
  const g = gridOfCells((x, y, z) => {
    const lx = x - min.x;
    const ly = y - min.y;
    const lz = z - min.z;
    if (lx < 0 || ly < 0 || lz < 0 || lx >= size.x || ly >= size.y || lz >= size.z) return true;
    return data[(ly * size.z + lz) * size.x + lx] === 1;
  });
  g.bounds = { min: { ...min }, size: { ...size } }; // Track F6: the distance field stays inside the snapshot
  return g;
}

interface PlanMessage {
  id: number;
  req: RouteRequest;
  snap: GridSnapshot;
}

interface PlanAnswer {
  id: number;
  plan?: RoutePlan;
  error?: string;
}

/** The main-thread client: one worker, one search at a time (the rest queue). */
export class RoutePlannerClient {
  private worker: Worker | undefined;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (p: RoutePlan) => void; reject: (e: Error) => void }>();
  private readonly log: Logger;
  private readonly spawn: () => Worker;
  private stopped = false;

  constructor(o: { spawn?: () => Worker; log?: Logger } = {}) {
    this.log = o.log ?? silentLogger;
    this.spawn = o.spawn ?? (() => new Worker(new URL(import.meta.url), { workerData: { bedrockbotRoute: true }, name: 'route' }));
  }

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = this.spawn();
    w.on('message', (m: PlanAnswer) => {
      const p = this.waiting.get(m.id);
      if (!p) return;
      this.waiting.delete(m.id);
      if (m.plan) p.resolve(m.plan);
      else p.reject(new Error(m.error ?? 'route worker: no plan'));
    });
    w.on('error', (e: Error) => {
      this.log.warn(`route worker crashed: ${e.message}`);
      this.fail(e);
      this.worker = undefined;
    });
    w.on('exit', () => {
      this.fail(new Error('route worker exited'));
      this.worker = undefined;
    });
    this.worker = w;
    return w;
  }

  private fail(e: Error): void {
    for (const p of this.waiting.values()) p.reject(e);
    this.waiting.clear();
  }

  /** Plan `req` in the worker over `snap` (its data is transferred). */
  plan(req: RouteRequest, snap: GridSnapshot): Promise<RoutePlan> {
    if (this.stopped) return Promise.reject(new Error('route worker stopped'));
    const id = this.nextId++;
    const w = this.ensure();
    return new Promise<RoutePlan>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      const m: PlanMessage = { id, req, snap };
      w.postMessage(m, [snap.data.buffer as ArrayBuffer]);
    });
  }

  /** A planner for the tracker over `grid`: the snapshot is taken on the main thread at each request. */
  plannerOver(grid: RouteGrid): (req: RouteRequest) => Promise<RoutePlan> {
    return (req) => this.plan(req, snapshotFor(grid, req));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const w = this.worker;
    this.worker = undefined;
    this.fail(new Error('route worker stopped'));
    if (w) await w.terminate();
  }
}

/** The worker side. */
export function runRouteWorker(port: MessagePort): void {
  port.on('message', (m: PlanMessage) => {
    try {
      const plan = planRoute(m.req, gridOfSnapshot(m.snap));
      const a: PlanAnswer = { id: m.id, plan };
      port.postMessage(a);
    } catch (e) {
      const a: PlanAnswer = { id: m.id, error: e instanceof Error ? e.message : String(e) };
      port.postMessage(a);
    }
  });
}

if (!isMainThread && parentPort && (workerData as { bedrockbotRoute?: boolean } | null)?.bedrockbotRoute) runRouteWorker(parentPort);
