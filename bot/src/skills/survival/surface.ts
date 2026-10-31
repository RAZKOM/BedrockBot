// Underwater recovery (wave 11, Track BF; docs/flight.md "Landing v3", docs/survival.md): a body under
// water with no start node for the planner (the planner swims on the surface only: nav/grid.ts swim
// wants two free cells over the water) swims straight up with the jump key held until its head is out
// of the water, then the walk can plan. The Realm, 2026-10-30: a flight's emergency landing put the
// bot on the sea floor 15 blocks down; every goto failed with `no standable node` and it sat there,
// alive only through Protection IV, Respiration, regeneration and eating.
//
// The water physics (Track AJ, input/physics.ts stepInLiquid): the jump key adds 0.04 a tick against
// a drag of 0.8 and gravity 0.005, a rise of about 0.135 blocks a tick (15 blocks in about 110 ticks).
import type { Vec3 } from '../../connection/types.ts';
import { PHYSICS } from '../input/physics.ts';

export interface SurfaceLoop {
  readonly state: { readonly pos: Vec3; readonly inWater: boolean };
  setCommand(c: Partial<{ forward: number; strafe: number; jump: boolean; sneak: boolean; sprint: boolean }>): void;
  onBeforeStep(fn: (tick: bigint, state: { pos: Vec3; inWater: boolean }) => void): () => void;
}

export type NameAt = (p: Vec3) => { name: string } | undefined;

const WATER = /^(flowing_)?water$|^bubble_column$|kelp|seagrass/;

/** The eyes are in a water cell (the server's air runs out there). */
export function headInWater(blockAt: NameAt, feet: Vec3): boolean {
  const b = blockAt({ x: Math.floor(feet.x), y: Math.floor(feet.y + PHYSICS.eyeHeight), z: Math.floor(feet.z) });
  return b !== undefined && WATER.test(b.name);
}

/** Ticks a swim up may take before it gives up (a 30-block column takes about 230). */
export const SURFACE_MAX_TICKS = 400;

/**
 * Swim straight up (the jump key held, no other key) until the head has been out of the water for 3
 * ticks, `maxTicks` pass or `cancelled()` says so. Resolves with whether the head came out.
 */
export function swimUp(loop: SurfaceLoop, blockAt: NameAt, o: { maxTicks?: number; cancelled?: () => boolean } = {}): Promise<{ ok: boolean; ticks: number; rose: number }> {
  const max = o.maxTicks ?? SURFACE_MAX_TICKS;
  const y0 = loop.state.pos.y;
  return new Promise((resolve) => {
    let ticks = 0;
    let dry = 0;
    const off = loop.onBeforeStep((_t, s) => {
      ticks++;
      dry = headInWater(blockAt, s.pos) ? 0 : dry + 1;
      const done = dry >= 3 || ticks >= max || o.cancelled?.() === true;
      if (done) {
        off();
        loop.setCommand({ jump: false });
        resolve({ ok: dry >= 3, ticks, rose: s.pos.y - y0 });
        return;
      }
      loop.setCommand({ jump: true, forward: 0, strafe: 0, sneak: false, sprint: false });
    });
  });
}
