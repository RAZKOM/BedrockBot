// Track F4b (docs/flight.md "Corridor flight", ADR 0067): flight's prices on the coarse graph. FlightCost
// implements the coarse layer's CoarseCost (coarse-port.ts mirrors skills/coarse/types.ts), registered as
// `layer.setCost('fly', new FlightCost())`. Every price is in ticks, so the layer compares a fly leg with
// a walk leg directly (walking is about 4.6 ticks a block at 4.3 blocks a second).
//
// The numbers are the envelope's (docs/flight-envelope.md) and the measured flights' (docs/flight.md):
//  - open sky: the cruise at about 1.5 blocks a tick, 0.67 rockets per 100 blocks over long flights (the
//    climb rocket buys ROCKET_CRUISE_CLIMB 31 of height = 310 of glide at GLIDE_RATIO 10);
//  - underground: Track F2's tunnels flew 3 x 3 bores at about 1 block a tick with a rocket every 20 to 40
//    blocks (a 90-degree bend needs one in every bore); a 2-high bore is flyable only at pitch -10 and a
//    level glide sinks onto its floor within 10 blocks, so 2 high is a glide in or a landing, never a leg;
//  - a vertical shaft down is the hover's sink (0.149 a tick) after a brake approach (Track F1 / F3: the
//    1 x 1 shaft 10 deep landed with 0 damage); up it is the vertical takeoff (a rocket straight up climbs 31
//    to 40);
//  - a rocket is priced as the route planner prices it (ROCKET_COST, route/types.ts).
import { GLIDE_RATIO, ROCKET_CRUISE_CLIMB } from '../plan.ts';
import { ROCKET_COST } from '../route/types.ts';
import type { CoarseCost, CoarseMode, Portal, PortalOutcome, Volume, VolumeKind } from './coarse-port.ts';

/** The open-sky cruise speed (blocks a tick) and its rockets per block (0.67 per 100 blocks). */
export const SKY_SPEED = 1.5;
export const SKY_ROCKETS_PER_BLOCK = 1 / (ROCKET_CRUISE_CLIMB * GLIDE_RATIO * 0.5);
/** A rocket in ticks (the route planner's price, so the coarse and the fine plan agree). */
export const ROCKET_TICKS = ROCKET_COST;
/** Underground in a bore of 3 x 3 or more: speed (blocks a tick) and one rocket per this many blocks. */
export const TUNNEL_SPEED = 1.0;
export const TUNNEL_ROCKET_EVERY = 30;
/** A bore under 3 wide (no powered turn fits): the tunnel's ticks times this; 1 wide: times NARROW_1. */
export const NARROW_FACTOR = 1.5;
export const NARROW_1 = 2.5;
/** The least height for powered flight (a rocket, a turn) and for any flight at all (a glide in, a landing). */
export const POWERED_HEIGHT = 3;
export const GLIDE_HEIGHT = 2;
/** A 2-high opening or volume is flown at most this far (a glide in to a landing just inside). */
export const GLIDE_IN_MAX = 6;
/** Into a cave through a mouth from the sky: the brake landing just inside (Track F1's corridor landing) and the takeoff inside. */
export const MOUTH_ENTRY_TICKS = 160;
/** Out of a cave into the sky: the route takeoff's way out and the climb rocket. */
export const MOUTH_EXIT_TICKS = 30;
/** Down a shaft: the brake approach over it, then the hover's sink. */
export const SHAFT_ENTRY_TICKS = 60;
export const SHAFT_SINK = 0.149;
/** Up a shaft: the vertical takeoff (rising about 0.8 a tick under a rocket, one per VERTICAL_CLIMB blocks). */
export const SHAFT_RISE = 0.8;
export const VERTICAL_CLIMB = ROCKET_CRUISE_CLIMB;
/** A climb in the sky: one rocket per ROCKET_CRUISE_CLIMB blocks of the sky volumes' floors rising. */
export const CLIMB_PER_ROCKET = ROCKET_CRUISE_CLIMB;
/**
 * A portal the layer has not fully seen, one that worked. A portal the flight failed at is refused for flight
 * (Infinity, the layer's rule for every mode: the mark decays after 30 minutes and is the flight's own, so a
 * walk or mine leg may still take that opening).
 */
export const UNKNOWN_PORTAL_TICKS = 60;
export const OK_PORTAL_FACTOR = 0.9;
/** Unknown space: the flat price per block, and by height for an unknown section (high unknown sky is open air in practice). */
export const UNKNOWN_TICKS_PER_BLOCK = 8;
/** An unknown section entirely above this y is priced as sky (x UNKNOWN_SKY_FACTOR); between UNKNOWN_LOW_Y and it: UNKNOWN_MID_TICKS a block. */
export const UNKNOWN_SKY_Y = 192;
export const UNKNOWN_SKY_FACTOR = 1.15;
export const UNKNOWN_LOW_Y = 64;
export const UNKNOWN_MID_TICKS = 2.5;
/** Switching into flight: the takeoff (the kit swap, the jump, the first rocket) and the landing at the leg's end (priced here: a fly leg ends standing). */
export const TAKEOFF_TICKS = 60;
export const LANDING_TICKS = 100;

/** The kind of flight a volume asks for. */
export type FlightSpace = 'sky' | 'under' | 'none';

/** Sky (the cruise), under (the route planner in a bore), or none (water). An unknown section is sky when it lies above UNKNOWN_SKY_Y. */
export function flightSpace(v: Pick<Volume, 'kind' | 'min'>): FlightSpace {
  if (v.kind === 'water') return 'none';
  if (v.kind === 'sky') return 'sky';
  if (v.kind === 'unknown') return v.min.y >= UNKNOWN_SKY_Y ? 'sky' : 'under';
  return 'under';
}

/** The opening's height for the body: the vertical extent of an x / z portal; a y portal (a shaft) is any height (crossed vertically). */
function portalHeight(p: Portal): number {
  return p.axis === 'y' ? Infinity : p.clearance.height;
}

/** The opening's narrowest horizontal side. */
function portalWidth(p: Portal): number {
  return p.axis === 'y' ? Math.min(p.clearance.height, p.clearance.width) : p.clearance.width;
}

/** The ticks for `blocks` underground in a bore `height` high and `width` wide (Infinity: not flyable that far). */
export function tunnelTicks(blocks: number, height: number, width: number): number {
  if (height < GLIDE_HEIGHT || width < 1) return Infinity;
  if (height < POWERED_HEIGHT) return blocks <= GLIDE_IN_MAX ? blocks / TUNNEL_SPEED + 10 : Infinity;
  const factor = width >= 3 ? 1 : width >= 2 ? NARROW_FACTOR : NARROW_1;
  return (blocks / TUNNEL_SPEED) * factor + (blocks / TUNNEL_ROCKET_EVERY) * ROCKET_TICKS;
}

/** The ticks for `blocks` of open sky (the cruise, its top-up rockets). */
export function skyTicks(blocks: number): number {
  return blocks / SKY_SPEED + blocks * SKY_ROCKETS_PER_BLOCK * ROCKET_TICKS;
}

/** The search heuristic's slope for flight: the cruise's speed alone (the rockets add 0.13 a block), below every fly price per block. */
export const FLY_TICKS_PER_BLOCK = 1 / SKY_SPEED;

/** Flight's CoarseCost (mode 'fly'). */
export class FlightCost implements CoarseCost {
  readonly mode: CoarseMode = 'fly';
  /** A 2 x 1 opening can be glided into (a landing just inside); powered flight needs POWERED_HEIGHT. */
  readonly clearance = { height: GLIDE_HEIGHT, width: 1 };
  readonly unknownCost = UNKNOWN_TICKS_PER_BLOCK;
  readonly ticksPerBlock = FLY_TICKS_PER_BLOCK;

  allows(kind: VolumeKind): boolean {
    return kind !== 'water';
  }

  edgeCost(portal: Portal, from: Volume, to: Volume, blocks: number, outcome?: PortalOutcome): number {
    // a dig portal (mine only) is solid rock to a flight; a portal the flight failed at is refused until the mark decays
    if (portal.dug !== undefined || outcome === 'failed') return Infinity;
    if (!this.allows(from.kind) || !this.allows(to.kind)) return Infinity;
    const cross = this.crossing(portal, from, to);
    if (!Number.isFinite(cross)) return Infinity;
    const inside = this.travel(portal, from, to, blocks);
    if (!Number.isFinite(inside)) return Infinity;
    let cost = cross + inside;
    if (portal.known !== 'known') cost += UNKNOWN_PORTAL_TICKS;
    if (outcome === 'ok') cost *= OK_PORTAL_FACTOR;
    return cost;
  }

  /** Into flight: a takeoff (and the landing the leg ends with); none from water, none under a ceiling under POWERED_HEIGHT (no jump glides under 2 of ceiling). */
  switchCost(from: CoarseMode, at: Volume, _near?: Portal): number {
    if (from === 'fly') return 0;
    if (at.kind === 'water') return Infinity;
    // underground: a route takeoff from standing needs a 3-high room somewhere in the volume (Track F3's room3); an unknown section is not taken off in
    if (flightSpace(at) === 'under' && (at.kind === 'unknown' || (at.headroom?.max ?? 0) < POWERED_HEIGHT)) return Infinity;
    return TAKEOFF_TICKS + ROCKET_TICKS + LANDING_TICKS;
  }

  /** The price of the opening itself (none inside one volume: the search's start pseudo-portal, a stub's chunk border). */
  private crossing(p: Portal, from: Volume, to: Volume): number {
    if (from.id === to.id) return 0;
    const a = flightSpace(from);
    const b = flightSpace(to);
    if (p.axis === 'y') {
      if (portalWidth(p) < 1) return Infinity;
      // a = the upper volume: from a to b is down the shaft (the brake over it, then the hover's sink inside `to`)
      const down = from.id === p.a || (from.id !== p.b && from.min.y >= to.min.y);
      if (a === 'sky' && b === 'sky') return 0; // a sky volume's floor seen from the next section up
      return down ? SHAFT_ENTRY_TICKS : MOUTH_EXIT_TICKS + ROCKET_TICKS;
    }
    if (portalHeight(p) < GLIDE_HEIGHT || portalWidth(p) < 1) return Infinity;
    if (a === 'sky' && b === 'under') return MOUTH_ENTRY_TICKS;
    if (a === 'under' && b === 'sky') return MOUTH_EXIT_TICKS + ROCKET_TICKS;
    if (a === 'sky' && b === 'sky' && to.min.y > from.min.y) return ((to.min.y - from.min.y) / CLIMB_PER_ROCKET) * ROCKET_TICKS;
    return 0;
  }

  /** The price of `blocks` inside `to`. */
  private travel(p: Portal, from: Volume, to: Volume, blocks: number): number {
    const space = flightSpace(to);
    if (to.kind === 'unknown') {
      if (to.min.y >= UNKNOWN_SKY_Y) return skyTicks(blocks) * UNKNOWN_SKY_FACTOR;
      if (to.min.y >= UNKNOWN_LOW_Y) return blocks * UNKNOWN_MID_TICKS;
      return blocks * this.unknownCost;
    }
    if (space === 'sky') return skyTicks(blocks);
    const shaft = p.axis === 'y' && from.id !== to.id;
    if (shaft && (from.id === p.a || (from.id !== p.b && from.min.y >= to.min.y))) {
      // down a shaft: the sink to its floor, then (rarely) on along a bore at its foot
      const height = to.headroom?.max ?? to.max.y - to.min.y + 1;
      const drop = Math.min(blocks, height);
      const along = Math.max(0, blocks - drop);
      const width = Math.min(portalWidth(p), to.minSpan);
      return drop / SHAFT_SINK + (along > 0 ? tunnelTicks(along, to.headroom?.min ?? height, width) : 0);
    }
    if (shaft) {
      // up a shaft: the vertical takeoff
      return blocks / SHAFT_RISE + Math.ceil(blocks / VERTICAL_CLIMB) * ROCKET_TICKS;
    }
    // along a bore (from a pseudo-portal inside the volume: the volume's own height and span)
    const ph = p.axis === 'y' ? Infinity : portalHeight(p);
    const pw = p.axis === 'y' ? Infinity : portalWidth(p);
    const height = Math.min(ph, to.headroom?.max ?? ph);
    const width = Math.min(pw, Math.max(1, to.minSpan));
    return tunnelTicks(blocks, Number.isFinite(height) ? height : POWERED_HEIGHT, Number.isFinite(width) ? width : 3);
  }
}
