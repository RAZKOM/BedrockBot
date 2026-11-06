// Track CB (ADR 0066, docs/coarse.md "Costs"): the walk and mine prices on the coarse graph, and the
// executor feedback (markPortal) with its decay. Every cost is in ticks. The numbers are rough on
// purpose: the corridor only has to rank ways; the fine planner prices the steps.
import type { CoarseCost, CoarseMode, Portal, PortalId, PortalOutcome, Volume, VolumeKind } from './types.ts';

/** Ticks per block walked (a sprint is 5.6 blocks / s = 3.6 ticks / block; a walk 4.3 / s = 4.7). */
export const WALK_TICKS = 4;
/** Ticks per block swum. */
export const SWIM_FACTOR = 3;
/** Ticks added per portal crossed (a doorway, a step, a turn). */
export const PORTAL_TICKS = 10;
/** Ticks per block through unknown space (walk / mine): high, so a known way of 4 x the length still wins. */
export const UNKNOWN_TICKS = 16;
/** Ticks per solid block dug (stone with an iron pickaxe is 15 ticks; `digPenalty` adds 60 by default). */
export const DIG_TICKS = 80;
/** Ticks a landing (fly to walk / mine) or a takeoff (walk / mine to fly) is priced at by the walk side. */
export const LAND_TICKS = 20;

/** A failed portal is refused for this long (ms) before it is tried again. */
export const FAILED_DECAY_MS = 30 * 60_000;

/** The executors' feedback per portal and mode, with the decay of failures. */
export class PortalMarks {
  private readonly marks = new Map<string, { outcome: PortalOutcome; at: number }>();
  private readonly decayMs: number;
  private readonly now: () => number;

  constructor(opts: { decayMs?: number; now?: () => number } = {}) {
    this.decayMs = opts.decayMs ?? FAILED_DECAY_MS;
    this.now = opts.now ?? Date.now;
  }

  set(id: PortalId, mode: CoarseMode, outcome: PortalOutcome): void {
    this.marks.set(`${id}|${mode}`, { outcome, at: this.now() });
  }

  /** The current outcome for a portal and mode: a failure older than the decay no longer counts. */
  get(id: PortalId, mode: CoarseMode): PortalOutcome | undefined {
    const m = this.marks.get(`${id}|${mode}`);
    if (!m) return undefined;
    if (m.outcome === 'failed' && this.now() - m.at >= this.decayMs) {
      this.marks.delete(`${id}|${mode}`);
      return undefined;
    }
    return m.outcome;
  }

  get size(): number {
    return this.marks.size;
  }
}

const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** The ticks of `blocks` inside volume `to` for a walker: swimming is slow, unknown space is expensive. */
function travelTicks(to: Volume, blocks: number, unknownCost: number): number {
  if (to.kind === 'unknown') return blocks * unknownCost;
  if (to.kind === 'water') return blocks * WALK_TICKS * SWIM_FACTOR;
  return blocks * WALK_TICKS;
}

/**
 * Can a walker cross a real portal from `from` into `to`? A 2 x 1 opening with a floor (x / z); along y a
 * drop with a floor within 3 (down) or a floor in the opening itself and something to stand on above
 * (up; swimming up out of water counts). The sky only where it has a floor.
 */
export function walkable(portal: Portal, from: Volume, to: Volume): boolean {
  if (portal.dug !== undefined) return false;
  if (to.kind === 'sky' && to.floorCells === 0) return false;
  if (to.kind === 'unknown' || from.kind === 'unknown') return true;
  if (portal.axis !== 'y') return portal.clearance.height >= 2 && portal.clearance.width >= 1 && (portal.floorY !== undefined || from.kind === 'water' || to.kind === 'water');
  const down = portal.a === from.id;
  if (down) return portal.floorY !== undefined || to.kind === 'water';
  if (from.kind === 'water') return to.floorCells > 0 || to.kind === 'water';
  return portal.floorY === portal.min.y && to.floorCells > 0;
}

/** Landing: possible only onto a floor (the portal's, else the volume's floor cells). */
function landCost(from: CoarseMode, at: Volume, near?: Portal): number {
  if (from === 'walk' || from === 'mine') return 0;
  if (near ? near.floorY !== undefined : at.floorCells > 0) return LAND_TICKS;
  return Infinity;
}

/** The walk cost: open ways only, no digging, no placing. */
export function walkCost(opts: { unknownCost?: number } = {}): CoarseCost {
  const unknownCost = opts.unknownCost ?? UNKNOWN_TICKS;
  return {
    mode: 'walk',
    clearance: { height: 2, width: 1 },
    ticksPerBlock: WALK_TICKS,
    unknownCost,
    allows: (_kind: VolumeKind) => true,
    edgeCost(portal, from, to, blocks, outcome) {
      if (outcome === 'failed') return Infinity;
      if (!walkable(portal, from, to)) return Infinity;
      return PORTAL_TICKS + travelTicks(to, blocks, unknownCost);
    },
    switchCost: landCost,
  };
}

/** The mine cost: walking that may dig: dig portals, too-narrow openings widened, shafts dug or pillared. */
export function mineCost(opts: { unknownCost?: number; digTicks?: number } = {}): CoarseCost {
  const unknownCost = opts.unknownCost ?? UNKNOWN_TICKS;
  const digTicks = opts.digTicks ?? DIG_TICKS;
  return {
    mode: 'mine',
    clearance: { height: 1, width: 1 },
    ticksPerBlock: WALK_TICKS,
    unknownCost,
    allows: () => true,
    edgeCost(portal, from, to, blocks, outcome) {
      if (outcome === 'failed') return Infinity;
      if (to.kind === 'water' && portal.dug !== undefined) return Infinity;
      let dig = 0;
      if (portal.dug !== undefined) dig = portal.dug;
      else if (!walkable(portal, from, to)) {
        if (to.kind === 'sky' && to.floorCells === 0) return Infinity;
        // widen a narrow opening, dig or pillar a shaft, dig down a drop too deep to take
        dig = portal.axis === 'y' ? Math.max(2, Math.abs(portal.min.y - (portal.floorY ?? portal.min.y - 3))) : 2;
      }
      return PORTAL_TICKS + dig * digTicks + travelTicks(to, blocks, unknownCost);
    },
    switchCost: landCost,
  };
}

export { dist as coarseDistance };
