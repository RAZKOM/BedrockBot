// Track F5a (docs/flight.md "Real-cave benchmark (Track F5a)", "No flight from water"): no takeoff from water, and
// no more than UNANSWERED_ROCKETS into a glide the server never confirms. The Realm, 2026-11-06: a route takeoff
// from a cave's water fired 20 climb rockets and ended `no_glide`.
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../src/connection/types.ts';
import { FlightController, type FlightLoop } from '../../../src/skills/fly/controller.ts';
import { takeoffWet, UNANSWERED_ROCKETS, WET_TAKEOFF, wetAt } from '../../../src/skills/fly/takeoff-water.ts';
import type { InputLoopEvent, InputLoopState } from '../../../src/skills/input/inputLoop.ts';
import type { BlockQuery } from '../../../src/skills/input/types.ts';

/** Water in the cells with y <= `surface` inside the 10 x 10 pool at the origin (a source block's height). */
function pool(surface: number): BlockQuery {
  return {
    solidAt: (_x, y) => y < 60,
    liquidAt: (x, y, z) => (x >= 0 && x < 10 && z >= 0 && z < 10 && y >= 60 && y <= surface ? { liquid: 'water', height: 8 / 9 } : null),
  };
}

describe('takeoffWet (takeoff-water.ts)', () => {
  const w = pool(60);
  it('refuses with the feet, the legs or only the head in water, and on the loop flag alone', () => {
    expect(takeoffWet(w, { pos: { x: 5.5, y: 60, z: 5.5 } })).toBe(WET_TAKEOFF); // feet in the water
    expect(takeoffWet(w, { pos: { x: 5.5, y: 59.5, z: 5.5 } })).toBe(WET_TAKEOFF); // standing low in it
    expect(takeoffWet(pool(61), { pos: { x: 5.5, y: 60.2, z: 5.5 } })).toBe(WET_TAKEOFF); // the head in the water too
    expect(takeoffWet({ solidAt: () => false }, { pos: { x: 0, y: 0, z: 0 }, inWater: true })).toBe(WET_TAKEOFF); // no liquids in the query: the loop's flag
    expect(wetAt({ solidAt: () => false }, { pos: { x: 0, y: 0, z: 0 }, inLava: true })).toBe('lava');
  });
  it('lets a dry body take off, beside the pool and over it on a ledge', () => {
    expect(takeoffWet(w, { pos: { x: 12.5, y: 60, z: 5.5 } })).toBeUndefined();
    expect(takeoffWet(w, { pos: { x: 5.5, y: 61, z: 5.5 } })).toBeUndefined(); // standing on a block over the water
  });
});

/**
 * A FlightLoop stand-in: the local model glides as soon as it is asked to in the air (the Realm's body at the water's
 * surface), the server never confirms it (no `glide` event), and a rocket's boost is taken back when no rocket entity
 * comes (RocketHand: it fired nothing).
 */
function fakeLoop(start: Vec3, world: BlockQuery, inWater: boolean) {
  const state = { pos: { ...start }, vel: { x: 0, y: 0, z: 0 }, onGround: true, collidedHorizontally: false, collidedVertically: false, corrections: 0, motions: 0, sprinting: false, inWater, inLava: false, gliding: false, boostTicks: 0, teleports: 0 } as unknown as InputLoopState;
  const steps = new Set<(t: bigint, s: InputLoopState) => void>();
  const events = new Set<(e: InputLoopEvent) => void>();
  const cmd = { yaw: 0, pitch: 0, jump: false, glide: false };
  let t = 0n;
  const loop: FlightLoop = {
    state,
    world,
    command: cmd,
    setCommand: (c) => Object.assign(cmd, c),
    onBeforeStep: (fn) => (steps.add(fn), () => steps.delete(fn)),
    onEvent: (fn) => (events.add(fn), () => events.delete(fn)),
    boost: () => {
      state.boostTicks = 15;
    },
    endBoost: () => {
      state.boostTicks = 0;
    },
    waitTicks: () => Promise.resolve(),
  };
  const tick = (): void => {
    t++;
    for (const fn of [...steps]) fn(t, state);
    // the local model: the jump leaves the ground, the glide asked for in the air is "taken" locally
    if (cmd.jump && state.onGround) {
      state.onGround = false;
      state.vel = { x: 0, y: 0.42, z: 0 };
    } else if (!state.onGround) {
      state.vel = { x: 0, y: state.gliding ? 0.05 : state.vel.y - 0.08, z: 0 };
      if (cmd.glide && state.vel.y < 0.3) state.gliding = true;
    }
    state.pos = { x: state.pos.x, y: state.pos.y + state.vel.y, z: state.pos.z };
    if (state.boostTicks > 0) state.boostTicks--;
  };
  return { loop, tick };
}

function controllerOn(loop: FlightLoop, fired: { n: number }): FlightController {
  const slots = [{ name: 'firework_rocket', count: 64, networkId: 1000 }, ...Array.from({ length: 35 }, () => null)];
  return new FlightController({
    loop,
    queue: (name) => {
      if (name === 'inventory_transaction') fired.n++;
    },
    inventory: { slots, selected: 0, rawItem: () => undefined } as never,
    hotbar: { select: () => true, rawItem: () => undefined },
    entities: { onAdd: () => () => {}, onRemove: () => () => {} },
    health: () => 20,
    elytraLeft: () => 400,
  });
}

describe('the flight controller and water (controller.ts)', () => {
  const target = { x: 300.5, z: 0.5, top: 60, half: 1 };

  it('does not take off from water: the flight ends `in_water` at once, no rocket', async () => {
    const w = pool(60);
    const { loop, tick } = fakeLoop({ x: 5.5, y: 60, z: 5.5 }, w, true);
    const fired = { n: 0 };
    const c = controllerOn(loop, fired);
    const r = c.flyTo(target, { cruiseY: 120, vertical: { top: 30 } });
    for (let i = 0; i < 10; i++) tick();
    const rep = await r;
    expect(rep.ok).toBe(false);
    expect(rep.reason).toBe('in_water');
    expect(fired.n).toBe(0);
    expect(c.active).toBe(false);
  });

  it(`stops firing after ${UNANSWERED_ROCKETS} rockets the server never answered with a glide, and ends no_glide`, async () => {
    // dry ground (the guard passes), but the server never confirms the glide: the Realm's 20 rockets
    const { loop, tick } = fakeLoop({ x: 20.5, y: 60, z: 5.5 }, pool(60), false);
    const fired = { n: 0 };
    const c = controllerOn(loop, fired);
    const r = c.flyTo(target, { cruiseY: 120, vertical: { top: 30 } });
    for (let i = 0; i < 200 && c.active; i++) tick();
    const rep = await r;
    expect(rep.reason).toBe('no_glide');
    expect(fired.n).toBe(UNANSWERED_ROCKETS);
  });
});
