// Track B3 (decision 0128, docs/build.md "Size"): a large build's sections planned off the main thread, the route
// worker's pattern (fly/route/worker.ts, decision 0089): this same file started as a `worker_threads` Worker with
// `workerData.bedrockbotBuildPlan` runs `planBuild` on a snapshot of the world around the section;
// `BuildPlannerClient` on the main thread sends one request at a time and resolves its plan.
//
// The snapshot is the box around the section's work area (PlanOptions.area, padded): a palette of the distinct
// blocks it holds (name, collision boxes, hardness, states) and one 16-bit index a cell (0xffff = not loaded),
// transferred, not copied. The shapes the planner asks for (a placed slab's or stair's boxes, PlanOptions.shapeOf)
// go along as a table of the section's own blocks. The bot keeps its ticks while a section of 4096 cells is planned.
import { isMainThread, parentPort, workerData, type MessagePort, type Worker } from 'node:worker_threads';
import { silentLogger, type Logger } from '../../log.ts';
import { startWorker } from '../../threads.ts'; // decision 0089: the wasm code GC guard
import { planBuild, type Plan, type PlanOptions } from './plan.ts';
import type { Area, BlockLike, BlockReader } from './sim.ts';
import { key, type BuildSpec, type Cell } from './types.ts';

/** Not loaded. */
const NONE = 0xffff;
/** Padding of the snapshot around the work area: sideways, under it (the column bases, the drops beside a stand), over it. */
export const SNAP_SIDE = 3;
export const SNAP_BELOW = 8;
export const SNAP_ABOVE = 4;
/** The most cells a snapshot holds (a larger box is planned on the main thread). */
export const SNAP_MAX = 4_000_000;

export interface WorldSnapshot {
  min: Cell;
  size: Cell;
  palette: BlockLike[];
  /** x fastest, then z, then y: index = (y * size.z + z) * size.x + x. */
  cells: Uint16Array;
}

/** The snapshot box for a plan's area. */
export function snapshotBox(area: Area): { min: Cell; size: Cell } {
  const min = { x: area.min.x - SNAP_SIDE, y: area.min.y - SNAP_BELOW, z: area.min.z - SNAP_SIDE };
  return { min, size: { x: area.max.x + SNAP_SIDE - min.x + 1, y: area.max.y + SNAP_ABOVE - min.y + 1, z: area.max.z + SNAP_SIDE - min.z + 1 } };
}

/** Read `world` over the box (one blockAt a cell; the palette by block identity, then by name and states). */
export function snapshotWorld(world: BlockReader, box: { min: Cell; size: Cell }): WorldSnapshot {
  const { min, size } = box;
  const cells = new Uint16Array(size.x * size.y * size.z);
  const palette: BlockLike[] = [];
  const byRef = new Map<BlockLike, number>();
  const byText = new Map<string, number>();
  let i = 0;
  for (let y = 0; y < size.y; y++) {
    for (let z = 0; z < size.z; z++) {
      for (let x = 0; x < size.x; x++) {
        const b = world.blockAt({ x: min.x + x, y: min.y + y, z: min.z + z });
        if (!b) {
          cells[i++] = NONE;
          continue;
        }
        let idx = byRef.get(b);
        if (idx === undefined) {
          const t = `${b.name}|${JSON.stringify(b.boxes)}|${b.hardness ?? ''}|${JSON.stringify(b.states ?? null)}`;
          idx = byText.get(t);
          if (idx === undefined) {
            idx = palette.length;
            if (idx >= NONE) throw new Error('build snapshot: more than 65535 kinds of block');
            palette.push({ name: b.name, boxes: b.boxes.map((bx) => [...bx]), ...(b.hardness !== undefined ? { hardness: b.hardness } : {}), ...(b.states ? { states: { ...b.states } } : {}) });
            byText.set(t, idx);
          }
          byRef.set(b, idx);
        }
        cells[i++] = idx;
      }
    }
  }
  return { min, size, palette, cells };
}

/** A BlockReader over a snapshot (cells outside it are not loaded). */
export function readerOf(s: WorldSnapshot): BlockReader {
  const { min, size, palette, cells } = s;
  return {
    blockAt(p) {
      const lx = p.x - min.x;
      const ly = p.y - min.y;
      const lz = p.z - min.z;
      if (lx < 0 || ly < 0 || lz < 0 || lx >= size.x || ly >= size.y || lz >= size.z) return undefined;
      const idx = cells[(ly * size.z + lz) * size.x + lx]!;
      return idx === NONE ? undefined : palette[idx];
    },
  };
}

/** The shape table key of a block (PlanOptions.shapeOf's arguments). */
export const shapeKey = (name: string, states: Readonly<Record<string, unknown>> | undefined): string => `${name}|${JSON.stringify(states ?? null)}`;

/** The plan options that cross the thread: no functions (skip as its cells, shapeOf as a table). */
export type WirePlanOptions = Omit<PlanOptions, 'shapeOf' | 'skip'> & { skipKeys?: string[] };

interface PlanMessage {
  id: number;
  spec: BuildSpec;
  opts: WirePlanOptions;
  snap: WorldSnapshot;
  shapes: [string, readonly (readonly number[])[] | undefined][];
}

interface PlanAnswer {
  id: number;
  plan?: Plan;
  error?: string;
}

/** What the worker plans with: a request's options with its functions rebuilt. */
export function optionsOf(m: Pick<PlanMessage, 'opts' | 'shapes'>): PlanOptions {
  const { skipKeys, ...o } = m.opts;
  const shapes = new Map(m.shapes);
  const skip = skipKeys?.length ? new Set(skipKeys) : undefined;
  return { ...o, ...(shapes.size ? { shapeOf: (n: string, s: Readonly<Record<string, unknown>> | undefined) => shapes.get(shapeKey(n, s)) } : {}), ...(skip ? { skip: (c: Cell) => skip.has(key(c)) } : {}) };
}

/** The main-thread client: one worker, one plan at a time (the rest queue). */
export class BuildPlannerClient {
  private worker: Worker | undefined;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (p: Plan) => void; reject: (e: Error) => void }>();
  private readonly log: Logger;
  private readonly spawn: () => Worker;
  private stopped = false;

  constructor(o: { spawn?: () => Worker; log?: Logger } = {}) {
    this.log = o.log ?? silentLogger;
    this.spawn = o.spawn ?? (() => startWorker(new URL(import.meta.url), { workerData: { bedrockbotBuildPlan: true }, name: 'build-plan' }));
  }

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = this.spawn();
    w.on('message', (m: PlanAnswer) => {
      const p = this.waiting.get(m.id);
      if (!p) return;
      this.waiting.delete(m.id);
      if (m.plan) p.resolve(m.plan);
      else p.reject(new Error(m.error ?? 'build plan worker: no plan'));
    });
    w.on('error', (e: Error) => {
      this.log.warn(`build plan worker crashed: ${e.message}`);
      this.fail(e);
      this.worker = undefined;
    });
    w.on('exit', () => {
      this.fail(new Error('build plan worker exited'));
      this.worker = undefined;
    });
    // an idle worker does not keep the process alive
    (w as { unref?: () => void }).unref?.();
    this.worker = w;
    return w;
  }

  private fail(e: Error): void {
    for (const p of this.waiting.values()) p.reject(e);
    this.waiting.clear();
  }

  /** Plan `spec` in the worker over `snap` (its cells are transferred); `shapes` = the table PlanOptions.shapeOf answers from. */
  plan(spec: BuildSpec, opts: WirePlanOptions, snap: WorldSnapshot, shapes: [string, readonly (readonly number[])[] | undefined][] = []): Promise<Plan> {
    if (this.stopped) return Promise.reject(new Error('build plan worker stopped'));
    const id = this.nextId++;
    const w = this.ensure();
    return new Promise<Plan>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      const m: PlanMessage = { id, spec, opts, snap, shapes };
      w.postMessage(m, [snap.cells.buffer as ArrayBuffer]);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const w = this.worker;
    this.worker = undefined;
    this.fail(new Error('build plan worker stopped'));
    if (w) await w.terminate();
  }
}

/** The worker side. */
export function runBuildPlanWorker(port: MessagePort): void {
  port.on('message', (m: PlanMessage) => {
    try {
      const plan = planBuild(readerOf(m.snap), m.spec, optionsOf(m));
      const a: PlanAnswer = { id: m.id, plan };
      port.postMessage(a);
    } catch (e) {
      const a: PlanAnswer = { id: m.id, error: e instanceof Error ? e.message : String(e) };
      port.postMessage(a);
    }
  });
}

if (!isMainThread && parentPort && (workerData as { bedrockbotBuildPlan?: boolean } | null)?.bedrockbotBuildPlan) runBuildPlanWorker(parentPort);
