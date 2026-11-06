// Track CB (ADR 0066, docs/coarse.md): the coarse layer as its users see it (`CoarseLayer`, types.ts):
// the graph (graph.ts) over a source (source.ts), the registered costs (walk and mine shipped, flight
// registers its own), the executors' portal feedback (costs.ts PortalMarks) and the sliced search
// (search.ts). `attachCoarseLayer` wires it to the world model: a column that loads, a re-sent section
// or a block whose class changes drops that chunk's graph, bumps the revision and notifies `onChange`
// once per event-loop turn.
import { silentLogger, type Logger } from '../../log.ts';
import { cellClassOf } from '../../world/cache/classes.ts';
import type { BlockInfo, Vec3 } from '../../world/types.ts';
import { classify } from '../terrain/classify.ts';
import { mineCost, PortalMarks, walkCost } from './costs.ts';
import { CoarseGraph, type CoarseGraphStats } from './graph.ts';
import { planCorridor } from './search.ts';
import { cacheSource, type CacheLike, type CoarseSource } from './source.ts';
import type { CoarseCost, CoarseLayer, CoarseMode, Corridor, PlanRequest, Portal, PortalId, PortalOutcome, Volume } from './types.ts';

export interface CoarseLayerOptions {
  /** Chunk graphs kept in memory (LRU). Default 1024. */
  maxChunks?: number;
  /** How long a failed portal stays refused (ms). Default 30 minutes. */
  decayMs?: number;
  /** The clock of the marks (tests). */
  now?: () => number;
  /** The dimension of requests without one. Default 0. */
  dim?: () => number;
  logger?: Logger;
}

type ChangeListener = (chunks: readonly { cx: number; cz: number; dim: number }[]) => void;

export interface CoarsePlanStats {
  plans: number;
  planMs: number;
  found: number;
  partial: number;
  none: number;
  marks: number;
}

export class CoarseLayerImpl implements CoarseLayer {
  readonly graph: CoarseGraph;
  readonly marks: PortalMarks;
  private readonly costs = new Map<CoarseMode, CoarseCost>();
  private readonly listeners = new Set<ChangeListener>();
  private readonly pending = new Map<string, { cx: number; cz: number; dim: number }>();
  private scheduled = false;
  private readonly dim: () => number;
  private readonly log: Logger;
  /** Plans made and their total search time (status pages). */
  readonly stats: CoarsePlanStats = { plans: 0, planMs: 0, found: 0, partial: 0, none: 0, marks: 0 };

  constructor(source: CoarseSource, opts: CoarseLayerOptions = {}) {
    this.graph = new CoarseGraph(source, { maxChunks: opts.maxChunks });
    this.marks = new PortalMarks({ decayMs: opts.decayMs, now: opts.now });
    this.dim = opts.dim ?? (() => 0);
    this.log = opts.logger ?? silentLogger;
    this.costs.set('walk', walkCost());
    this.costs.set('mine', mineCost());
  }

  get revision(): number {
    return this.graph.revision;
  }

  /** The registered modes. */
  modes(): CoarseMode[] {
    return [...this.costs.keys()];
  }

  async plan(req: PlanRequest): Promise<Corridor> {
    const dim = req.dim ?? this.dim();
    const c = await planCorridor({ graph: this.graph, costs: this.costs, marks: this.marks }, req, dim, this.revision);
    this.stats.plans++;
    this.stats.planMs += c.ms;
    this.stats[c.status]++;
    this.log.debug(
      `coarse: plan ${c.status} ${fmt(req.start)} -> ${fmt(req.goal)} [${req.modes.join(' ')}]: ${c.legs.length} leg(s), ${Math.round(c.blocks)} blocks, cost ${Math.round(c.cost)}, unknown ${(c.unknownFraction * 100).toFixed(0)} %, ${c.expanded} expanded, ${c.ms.toFixed(1)} ms${c.reason ? ` (${c.reason})` : ''}`,
    );
    return c;
  }

  setCost(mode: CoarseMode, cost: CoarseCost): void {
    this.costs.set(mode, cost);
  }

  markPortal(id: PortalId, mode: CoarseMode, outcome: PortalOutcome): void {
    this.stats.marks++;
    this.marks.set(id, mode, outcome);
  }

  volumeAt(p: Vec3, dim?: number): Volume | undefined {
    return this.graph.volumeAt(p, dim ?? this.dim());
  }

  portal(id: PortalId): Portal | undefined {
    return this.graph.portal(id);
  }

  onChange(fn: ChangeListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** A chunk's cells changed: drop its graph, bump the revision, notify once per turn. */
  invalidate(cx: number, cz: number, dim = this.dim()): void {
    this.graph.invalidate(cx, cz, dim);
    this.pending.set(`${dim}:${cx}:${cz}`, { cx, cz, dim });
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      const list = [...this.pending.values()];
      this.pending.clear();
      for (const fn of [...this.listeners]) {
        try {
          fn(list);
        } catch (e) {
          this.log.warn(`coarse: onChange listener failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    });
  }

  /** Counts for status pages. */
  info(): { chunks: number; revision: number; marks: number; graph: CoarseGraphStats; plans: CoarsePlanStats } {
    return { chunks: this.graph.size, revision: this.revision, marks: this.marks.size, graph: this.graph.stats, plans: this.stats };
  }
}

/** What `attachCoarseLayer` needs from the world model (`World` with a WorldCache attached satisfies it). */
export interface CoarseWorld {
  chunks: {
    readonly dimension: number;
    readonly minY: number;
    readonly maxY: number;
    onColumnLoaded(fn: (cx: number, cz: number) => void): () => void;
    onSection(fn: (col: { cx: number; cz: number; loaded: boolean }, rel: number) => void): () => void;
    onBlockSet(fn: (col: { cx: number; cz: number }, rel: number, i: number, before: number, after: number) => void): () => void;
  };
  /** The persistent world cache (`World.cache`); the layer needs a `WorldCache` (its `summary`). */
  readonly cache?: unknown;
  registry?: { blockInfo(stateId: number, runtimeId?: number): BlockInfo };
}

const isCacheLike = (c: unknown): c is CacheLike => typeof c === 'object' && c !== null && typeof (c as { summary?: unknown }).summary === 'function' && typeof (c as { dimension?: unknown }).dimension === 'number';

/**
 * The layer over the world's cache, kept current by the chunk store's events. undefined without a
 * WorldCache (the navigator then plans as before). Returns the layer and the function that detaches it.
 */
export function attachCoarseLayer(world: CoarseWorld, opts: Omit<CoarseLayerOptions, 'dim'> = {}): { layer: CoarseLayerImpl; detach: () => void } | undefined {
  const cache = world.cache;
  if (!isCacheLike(cache)) return undefined;
  const chunks = world.chunks;
  const layer = new CoarseLayerImpl(cacheSource(cache, chunks), { ...opts, dim: () => chunks.dimension });
  const classOf = (stateId: number): number | undefined => {
    if (stateId < 0 || !world.registry) return undefined;
    try {
      return cellClassOf(classify(world.registry.blockInfo(stateId)));
    } catch {
      return undefined;
    }
  };
  const unsubs = [
    chunks.onColumnLoaded((cx, cz) => {
      layer.invalidate(cx, cz, chunks.dimension);
    }),
    chunks.onSection((col) => {
      if (col.loaded) layer.invalidate(col.cx, col.cz, chunks.dimension);
    }),
    chunks.onBlockSet((col, _rel, _i, before, after) => {
      const a = classOf(before);
      const b = classOf(after);
      if (a !== undefined && a === b) return; // the class the graph reads did not change
      layer.invalidate(col.cx, col.cz, chunks.dimension);
    }),
  ];
  return {
    layer,
    detach: () => {
      for (const u of unsubs.splice(0)) u();
    },
  };
}

const fmt = (p: Vec3): string => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
