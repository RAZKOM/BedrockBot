// Track F5a (docs/flight.md "Real-cave benchmark (Track F5a)", "No flight from water"; ADR 0068): no takeoff from
// water. On the Realm (2026-11-06) a route takeoff was planned and flown from a body standing in a cave's water:
// the local model glided where the server would not (a body with its feet less than 0.4 under the surface moves
// with air physics locally, physics.ts LIQUID.waterInset, while the server ends a glide in water), so the climb
// fired 20 rockets into a glide the server never confirmed and ended `no_glide`. Every takeoff family (the run,
// the ledge, the vertical, the route takeoff) asks `takeoffWet` first (commands-fly.ts takeoffFor), the flight
// controller refuses to start one from water (`in_water`), and the controller stops firing rockets once
// UNANSWERED_ROCKETS have gone without the server ever confirming the glide.
import type { Vec3 } from '../../world/types.ts';
import { liquidContact, PHYSICS } from '../input/physics.ts';
import type { BlockQuery } from '../input/types.ts';

/** The refusal (`!fly` replies it; the takeoff-site search and the walk out take over). */
export const WET_TAKEOFF = 'fly: I am in water: swim up and stand on dry ground first';
/** Rockets fired before the server ever confirmed the glide; no more after these (the takeoff ends `no_glide` on its timeout). */
export const UNANSWERED_ROCKETS = 2;

/** What the guard reads of a body: its feet and the loop's water flags (the input loop's state). */
export interface WetBody {
  pos: Vec3;
  inWater?: boolean;
  inLava?: boolean;
}

/**
 * The liquid the body is in or touches anywhere from the feet to the head (the whole standing box, no inset: a body
 * standing in shallow water is in water for the server's glide), or undefined when dry. `body.inWater` (the input
 * loop's own physics) counts as well; without `liquidAt` in the query only the flags are read.
 */
export function wetAt(world: BlockQuery, body: WetBody): 'water' | 'lava' | undefined {
  if (body.inWater) return 'water';
  if (body.inLava) return 'lava';
  const c = liquidContact(world, body.pos, PHYSICS.height);
  return c.water ? 'water' : c.lava ? 'lava' : undefined;
}

/** The refusal line when a takeoff from `body` is in a liquid, else undefined. */
export function takeoffWet(world: BlockQuery, body: WetBody): string | undefined {
  const wet = wetAt(world, body);
  if (!wet) return undefined;
  return wet === 'water' ? WET_TAKEOFF : 'fly: I am in lava: get out first';
}
