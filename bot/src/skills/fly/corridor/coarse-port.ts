// Track F4b (docs/flight.md "Corridor flight", ADR 0067): the corridor executor's side of the coarse layer
// (Track CB, ADR 0066, docs/coarse.md). The layer's contract (skills/coarse/types.ts) is re-exported as it is,
// so FlightCost implements the layer's CoarseCost directly and the real CoarseLayer is a CorridorProvider
// without an adapter. The stub provider and the builders below are the tests' and the e2e's corridors.
import type { Vec3 } from '../../../world/types.ts';
import type { CoarseCost, CoarseMode, Corridor, CorridorLeg, CorridorStatus, Knowledge, PlanRequest, Portal, PortalAxis, PortalId, PortalOutcome, Volume, VolumeId, VolumeKind } from '../../coarse/types.ts';

export type { CoarseCost, CoarseLayer, CoarseMode, Corridor, CorridorLeg, CorridorStatus, Knowledge, PlanRequest, Portal, PortalAxis, PortalId, PortalOutcome, Volume, VolumeId, VolumeKind } from '../../coarse/types.ts';

// ---- the executor's port ------------------------------------------------------------------------------

/**
 * What the corridor executor uses of the layer: a structural subset of CoarseLayer, so the real layer is a
 * provider as it is (`setCorridorProvider(task, layer)`); the stub below is the other one.
 */
export interface CorridorProvider {
  plan(req: PlanRequest): Promise<Corridor>;
  markPortal(id: PortalId, mode: CoarseMode, outcome: PortalOutcome): void;
  volumeAt(p: Vec3, dim?: number): Volume | undefined;
  /** Where FlightCost is registered (`setCost('fly', ...)`) when the provider takes costs. */
  setCost?(mode: CoarseMode, cost: CoarseCost): void;
  readonly revision?: number;
  onChange?(fn: (chunks: readonly { cx: number; cz: number; dim: number }[]) => void): () => void;
}

// ---- the stub provider and the builders (tests, the e2e) -----------------------------------------------

export interface StubPlan {
  /** The corridors in the order of preference: `plan` answers the first whose portals none is marked failed for a mode it flies through. */
  corridors: readonly Corridor[];
  /** The volumes `volumeAt` answers from (the first whose box holds the cell; a sky volume holds every cell from its min.y up). */
  volumes?: readonly Volume[];
}

/** A hand-made corridor provider: fixed corridors, the executor's feedback recorded. */
export class StubCorridorProvider implements CorridorProvider {
  readonly requests: PlanRequest[] = [];
  readonly marks: { id: PortalId; mode: CoarseMode; outcome: PortalOutcome }[] = [];
  private readonly o: StubPlan;
  private rev = 1;
  private readonly listeners = new Set<(chunks: readonly { cx: number; cz: number; dim: number }[]) => void>();

  constructor(o: StubPlan) {
    this.o = o;
  }

  get revision(): number {
    return this.rev;
  }

  /** A portal is out for a mode while its last mark for that mode is `failed` (the layer's decay is not modelled). */
  failed(id: PortalId, mode: CoarseMode): boolean {
    for (let i = this.marks.length - 1; i >= 0; i--) {
      const m = this.marks[i]!;
      if (m.id === id && m.mode === mode) return m.outcome === 'failed';
    }
    return false;
  }

  plan(req: PlanRequest): Promise<Corridor> {
    this.requests.push({ ...req });
    const usable = this.o.corridors.find((c) => c.legs.every((l) => l.portals.every((p) => !this.failed(p.id, l.mode))));
    if (!usable) {
      const none: Corridor = { status: 'none', start: req.start, goal: req.goal, dim: req.dim ?? 0, legs: [], blocks: 0, cost: Infinity, unknownFraction: 0, reason: 'every stub corridor crosses a failed portal', expanded: 0, ms: 0, revision: this.rev };
      return Promise.resolve(none);
    }
    return Promise.resolve({ ...usable, start: req.start, revision: this.rev });
  }

  markPortal(id: PortalId, mode: CoarseMode, outcome: PortalOutcome): void {
    this.marks.push({ id, mode, outcome });
  }

  volumeAt(p: Vec3, dim?: number): Volume | undefined {
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    const z = Math.floor(p.z);
    for (const v of this.o.volumes ?? []) {
      if (dim !== undefined && v.dim !== dim) continue;
      if (x < v.min.x || x > v.max.x || z < v.min.z || z > v.max.z) continue;
      if (y < v.min.y || (v.kind !== 'sky' && y > v.max.y)) continue;
      return v;
    }
    return undefined;
  }

  onChange(fn: (chunks: readonly { cx: number; cz: number; dim: number }[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Tests: the layer saw chunks change (bumps the revision, tells the listeners). */
  changed(chunks: readonly { cx: number; cz: number; dim: number }[]): void {
    this.rev++;
    for (const fn of this.listeners) fn(chunks);
  }
}

/** A volume over an inclusive box. */
export function volumeOf(id: VolumeId, kind: VolumeKind, min: Vec3, max: Vec3, o: { dim?: number; known?: Knowledge; minSpan?: number; headroom?: { min: number; max: number } } = {}): Volume {
  const cells = (max.x - min.x + 1) * (max.y - min.y + 1) * (max.z - min.z + 1);
  const floorCells = kind === 'sky' || kind === 'water' ? 0 : (max.x - min.x + 1) * (max.z - min.z + 1);
  return {
    id,
    kind,
    dim: o.dim ?? 0,
    min: { ...min },
    max: { ...max },
    cells,
    floorCells,
    ...(o.headroom ? { headroom: o.headroom } : kind === 'cave' || kind === 'surface' ? { headroom: { min: max.y - min.y + 1, max: max.y - min.y + 1 } } : {}),
    minSpan: o.minSpan ?? (kind === 'sky' ? 16 : Math.min(max.x - min.x + 1, max.z - min.z + 1)),
    known: o.known ?? 'known',
  };
}

/**
 * A portal: for axis 'x' / 'z' an opening `width` across and `height` high whose lowest cell row is at
 * `center.y` (feet height) and whose plane is the cell column `center.x` (axis x) / `center.z` (axis z); for
 * axis 'y' an opening of `height` x `width` cells in the plane y = center.y (the larger side along x). The
 * centre is in cell coordinates as the layer gives it: the middle cell of an odd side, the border between the
 * two middle cells (.5) of an even one.
 */
export function portalOf(o: { a: VolumeId; b: VolumeId; axis: PortalAxis; center: Vec3; height: number; width: number; floorY?: number; dim?: number; known?: Knowledge }): Portal {
  const c = o.center;
  const span = (mid: number, n: number): [number, number] => {
    const lo = Math.round(mid - (n - 1) / 2);
    return [lo, lo + n - 1];
  };
  let min: Vec3;
  let max: Vec3;
  if (o.axis === 'y') {
    const [x0, x1] = span(c.x, Math.max(o.height, o.width));
    const [z0, z1] = span(c.z, Math.min(o.height, o.width));
    const y = Math.floor(c.y);
    min = { x: x0, y, z: z0 };
    max = { x: x1, y, z: z1 };
  } else {
    const y0 = Math.floor(c.y);
    const y1 = y0 + o.height - 1;
    if (o.axis === 'x') {
      const [z0, z1] = span(c.z, o.width);
      const x = Math.floor(c.x);
      min = { x, y: y0, z: z0 };
      max = { x, y: y1, z: z1 };
    } else {
      const [x0, x1] = span(c.x, o.width);
      const z = Math.floor(c.z);
      min = { x: x0, y: y0, z };
      max = { x: x1, y: y1, z };
    }
  }
  const dim = o.dim ?? 0;
  return {
    id: `${dim}:${o.axis}:${min.x}:${min.y}:${min.z}`,
    a: o.a,
    b: o.b,
    axis: o.axis,
    min,
    max,
    center: { ...c },
    clearance: { height: o.height, width: o.width },
    ...(o.floorY !== undefined ? { floorY: o.floorY } : {}),
    known: o.known ?? 'known',
  };
}

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** A leg through `portals` (in order) from `from` to `to`; the waypoints, the length, the tightest opening and the unknown share filled in. */
export function legOf(mode: CoarseMode, from: Vec3, to: Vec3, portals: readonly Portal[], volumes: readonly VolumeId[], o: { entry?: Portal; exit?: Portal; unknownFraction?: number; cost?: number } = {}): CorridorLeg {
  const waypoints = [{ ...from }, ...portals.map((p) => ({ ...p.center })), { ...to }];
  let blocks = 0;
  for (let i = 1; i < waypoints.length; i++) blocks += dist(waypoints[i - 1]!, waypoints[i]!);
  let h = Infinity;
  let w = Infinity;
  for (const p of portals) {
    h = Math.min(h, p.clearance.height);
    w = Math.min(w, p.clearance.width);
  }
  return {
    mode,
    from: { ...from },
    to: { ...to },
    ...(o.entry ? { entry: o.entry } : {}),
    ...(o.exit ? { exit: o.exit } : {}),
    portals: [...portals],
    volumes: [...volumes],
    waypoints,
    blocks,
    cost: o.cost ?? blocks,
    unknownFraction: o.unknownFraction ?? 0,
    minClearance: { height: Number.isFinite(h) ? h : 256, width: Number.isFinite(w) ? w : 256 },
  };
}

/** A found corridor over `legs` (totals summed; the unknown share weighted by length). */
export function corridorOf(legs: readonly CorridorLeg[], o: { status?: CorridorStatus; dim?: number; reason?: string } = {}): Corridor {
  const blocks = legs.reduce((s, l) => s + l.blocks, 0);
  const unknown = blocks > 0 ? legs.reduce((s, l) => s + l.blocks * l.unknownFraction, 0) / blocks : 0;
  return {
    status: o.status ?? 'found',
    start: legs[0] ? { ...legs[0].from } : { x: 0, y: 0, z: 0 },
    goal: legs.length ? { ...legs[legs.length - 1]!.to } : { x: 0, y: 0, z: 0 },
    dim: o.dim ?? 0,
    legs: [...legs],
    blocks,
    cost: legs.reduce((s, l) => s + l.cost, 0),
    unknownFraction: unknown,
    ...(o.reason ? { reason: o.reason } : {}),
    expanded: 0,
    ms: 0,
    revision: 1,
  };
}
