// Track W1 (docs/pathfinding.md "Water (Track W1)", decisions/0070-water-travel.md): the one place that says
// whether the body is in water, whether its head is under water, how much air it has left and how long a plan
// may keep it under water. The planner (astar.ts dive nodes, NavGrid.dive / submerged), the navigator (start
// node, holding the depth while a plan is searched, the air clock) and the follower (the dive controller) read
// these rules. Left outside it (other owners): survival/surface.ts `headInWater` (the SurfaceProcess, by block
// name), fall/damage.ts and fly/landing.ts (liquid names for landings).
//
// Sources of truth, measured on BDS 1.26.60 (bds-fly, the W1 probe):
// - water physics: InputLoopState.inWater (input/physics.ts: the body box shrunk by 0.4 at both ends touches a
//   water cell); it matches the server (no corrections idle, sinking, rising or swimming in still water). A body
//   bobbing at the surface leaves that test for a tick or two, so "the body is in water" also looks at the
//   cells at and just under the feet (`bodyInWater`).
// - head under water: the eye (feet + 1.62) below the surface of the water in its cell (`headUnderWater`).
//   The server's air (set_entity_data `air`, 0..300) runs down 1 a tick then (measured: 300 -> 13 in about
//   290 ticks under water without Respiration) and refills within a few seconds at the surface.
// - the server's own value (MobTracker.selfAir) when the session wires it (Navigator.air), else `AirClock`.
import type { Vec3 } from '../../world/types.ts';
import { PHYSICS } from '../input/physics.ts';
import type { TerrainClass } from '../terrain/classify.ts';

/** Full air supply (ticks). */
export const AIR_MAX = 300;
/**
 * A plan from a breathing start keeps this much air at the end of every stretch under water: above the
 * SurfaceProcess threshold (tasks/process/surface.ts SURFACE_AIR 100), so the escape never cuts a planned dive.
 */
export const AIR_KEEP = 110;
/** Planned ticks under water count this much (the follower takes longer than the move costs say). */
export const AIR_MARGIN = 1.5;
/** A start already under water keeps only this much (it has to reach air first). */
export const AIR_FLOOR = 20;
/** A start under water may always plan at least this long submerged (7 blocks up at 8 ticks; else no way up is found at all). */
export const AIR_MIN_BUDGET = 60;
/** Air the local clock gains per tick with the head out of the water (Java's rate; BDS refills within seconds). */
export const AIR_REFILL = 4;
/** The eye height over the feet. */
export const EYE = PHYSICS.eyeHeight;

export type CellOf = (x: number, y: number, z: number) => TerrainClass | undefined;

/**
 * Water the body moves through under water (a dive node's cells): any water block (a source, flowing or
 * falling water, kelp, seagrass) without a collision box or hazard; not a bubble column (its push is not
 * modelled).
 */
export function diveWater(c: TerrainClass): boolean {
  return c.liquid === 'water' && c.name !== 'bubble_column' && c.boxes.length === 0 && !c.danger;
}

/** An eye at height `eyeY` in a cell of class `c` is under that cell's water surface (source 8/9, falling 1). */
export function eyeUnder(c: TerrainClass | undefined, eyeY: number): boolean {
  if (c?.liquid !== 'water') return false;
  return eyeY - Math.floor(eyeY) < c.liquidHeight;
}

/** The head of a body with feet `pos` is under water (the server's air runs down). */
export function headUnderWater(cls: CellOf, pos: Vec3): boolean {
  const ey = pos.y + EYE;
  return eyeUnder(cls(Math.floor(pos.x), Math.floor(ey), Math.floor(pos.z)), ey);
}

/**
 * The body is in water for planning: the water physics test (`inWater`), or water in the feet cell, or in
 * the cell under it while the feet are less than 0.6 above that cell's top (a body bobbing at the surface
 * leaves the physics test for a tick or two).
 */
export function bodyInWater(cls: CellOf, s: { pos: Vec3; inWater?: boolean }): boolean {
  if (s.inWater) return true;
  const x = Math.floor(s.pos.x);
  const z = Math.floor(s.pos.z);
  const fy = Math.floor(s.pos.y + 1e-3);
  if (cls(x, fy, z)?.liquid === 'water') return true;
  return s.pos.y - fy < 0.6 && cls(x, fy - 1, z)?.liquid === 'water';
}

/**
 * Ticks a plan may keep the head under water in one stretch. From a breathing start (the air refills
 * there): (AIR_MAX - AIR_KEEP) / AIR_MARGIN. From a start under water: (air - AIR_FLOOR) / AIR_MARGIN, at
 * least AIR_MIN_BUDGET. `air` undefined = a full supply.
 */
export function airBudget(air: number | undefined, startUnder: boolean): number {
  if (!startUnder) return (AIR_MAX - AIR_KEEP) / AIR_MARGIN;
  return Math.max(AIR_MIN_BUDGET, ((air ?? AIR_MAX) - AIR_FLOOR) / AIR_MARGIN);
}

/**
 * Ticks a plan may keep the head under water to a goal under water and back up to air from there (a `near` goal
 * around a point under the surface: a waypoint on a pool's floor, a player diving). The same as `airBudget`, but
 * a start under water gets no AIR_MIN_BUDGET: that floor is there so a way up is always found, not a way down.
 */
export function diveGoalBudget(air: number | undefined, startUnder: boolean): number {
  if (!startUnder) return airBudget(air, false);
  return ((air ?? AIR_MAX) - AIR_FLOOR) / AIR_MARGIN;
}

/** The point p is under the water surface: its cell and the one above it hold water. */
export function underSurface(cls: CellOf, p: Vec3): boolean {
  const x = Math.floor(p.x);
  const y = Math.floor(p.y);
  const z = Math.floor(p.z);
  return cls(x, y, z)?.liquid === 'water' && cls(x, y + 1, z)?.liquid === 'water';
}

/**
 * The local air estimate when the server's value is not wired: down 1 a tick with the head under water
 * (to -20: drowning), up AIR_REFILL a tick out of it, never above AIR_MAX. Conservative with Respiration
 * or water breathing (the real supply lasts longer).
 */
export class AirClock {
  air = AIR_MAX;
  /** Ticks in a row with the head under water. */
  under = 0;

  step(headUnder: boolean): void {
    if (headUnder) {
      this.air = Math.max(-20, this.air - 1);
      this.under++;
    } else {
      this.air = Math.min(AIR_MAX, this.air + AIR_REFILL);
      this.under = 0;
    }
  }
}
