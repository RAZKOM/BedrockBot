// Track CB (ADR 0066, docs/coarse.md "Costs"): the walk and mine prices on the coarse graph, and the
// executor feedback (markPortal) with its decay. Every cost is in ticks. The numbers are rough on
// purpose: the corridor only has to rank ways; the fine planner prices the steps.
import type { CoarseCost, CoarseMode, Portal, PortalId, PortalOutcome, Volume, VolumeKind } from './types.ts';

/** Ticks per block walked (a sprint is 5.6 blocks / s = 3.6 ticks / block; a walk 4.3 / s = 4.7). */
export const WALK_TICKS = 4;
/**
 * Ticks per block swum (Track W1, measured on bds-fly: 8.6 on the surface, 10.5 under water across, 8 up a
 * column or a waterfall; the fine planner's `swim` / `dive` costs). A water volume does not say whether its
 * way runs on the surface or under it; the fine planner keeps the stretch under water within the air.
 */
export const SWIM_TICKS = 10;
/** The swim price as a factor of WALK_TICKS (kept for readers of the old constant). */
export const SWIM_FACTOR = SWIM_TICKS / WALK_TICKS;
/**
 * Track W1: a walker swims through an opening at least this big (the 1.8-high body: 2 cells high, 1 wide); the
 * same as walking, for a horizontal opening into or out of water and for one between two water volumes.
 */
export const SWIM_CLEARANCE = Object.freeze({ height: 2, width: 1 });
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
  if (to.kind === 'water') return blocks * SWIM_TICKS; // Track W1
  return blocks * WALK_TICKS;
}

/** Track W1: an opening the body swims through (SWIM_CLEARANCE). */
function swimmable(portal: Portal): boolean {
  return portal.clearance.height >= SWIM_CLEARANCE.height && portal.clearance.width >= SWIM_CLEARANCE.width;
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
  if (portal.axis !== 'y') {
    // Track W1: into, out of or between water volumes: an opening the body swims through, no floor needed
    if (from.kind === 'water' || to.kind === 'water') return swimmable(portal);
    return portal.clearance.height >= 2 && portal.clearance.width >= 1 && portal.floorY !== undefined;
  }
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
