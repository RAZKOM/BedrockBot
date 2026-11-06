// The synthetic worlds and the whole-trip harness of the landing tests (Track BF's fly-landing.test.ts,
// Track F1's fly-brake.test.ts): boxes of solids (and water) over the flat ground, the owner's farm
// replica, and the FlightBrain flying a trip on stepBody to a target.
import { FlightBrain, type BrainOptions } from '../../../src/skills/fly/brain.ts';
import { floorsOf, type BlockLookup, type CellBlock, type ProbeOutcome } from '../../../src/skills/fly/landing.ts';
import { cruiseHeight, type LandingTarget } from '../../../src/skills/fly/plan.ts';
import { flatWorld, GLIDE, IDLE_COMMAND, initialBody, stepBody, withBoxes, type BlockBox } from '../../../src/skills/input/index.ts';

export const FEET = -60;

/** A synthetic world: boxes of solids over the flat ground, plus water boxes (for the dryness rules). */
export function world(boxes: BlockBox[], water: BlockBox[] = []) {
  const solid = withBoxes(flatWorld(), boxes);
  const wet = (x: number, y: number, z: number) => water.some((w) => x >= w.from.x && x <= w.to.x && y >= w.from.y && y <= w.to.y && z >= w.from.z && z <= w.to.z);
  const look: BlockLookup = (x, y, z): CellBlock => {
    if (solid.solidAt(x, y, z)) return { name: 'stone', solid: true };
    return wet(x, y, z) ? { name: 'water', solid: false } : { name: 'air', solid: false };
  };
  const skyTop = (x: number, z: number): number => {
    for (let y = 200; y >= -64; y--) if (solid.solidAt(x, y, z)) return y;
    return -64;
  };
  /** Dry ground under open sky (feet), the brain's groundAt. */
  const dryGround = (x: number, z: number, fromY = 200): number | undefined => {
    const f = floorsOf(look, x, z, Math.floor(fromY), -64)?.[0];
    return f && !f.wet && !f.hazard ? f.feet : undefined;
  };
  return { solid, look, skyTop, dryGround };
}

/**
 * The owner's creeper farm (the Realm, 2026-10-31): a 9 x 7 platform floating 70 above the sea (its
 * top at `Y - 1`), a room under it with the goal (feet Y - 4) and a ladder up through a hole in the
 * platform, a 4 x 4 shaft rising 12 from the platform's west half and a 32 x 30 x 12 box on top of it
 * that overhangs the whole platform (its east edge one block past the platform's): no cell of the
 * platform has open sky; the corridor in is from the east (+x).
 */
export function farm(o: { island?: boolean } = {}) {
  const Y = FEET + 70;
  const cz = 300;
  const boxes: BlockBox[] = [
    // the room under the platform: a shell, hollowed
    { from: { x: -3, y: Y - 5, z: cz - 3 }, to: { x: 3, y: Y - 2, z: cz + 3 }, solid: true },
    { from: { x: -2, y: Y - 4, z: cz - 2 }, to: { x: 2, y: Y - 2, z: cz + 2 }, solid: false },
    // the platform (9 x 7) with the hole over the ladder
    { from: { x: -4, y: Y - 1, z: cz - 3 }, to: { x: 4, y: Y - 1, z: cz + 3 }, solid: true },
    { from: { x: 2, y: Y - 1, z: cz }, to: { x: 2, y: Y - 1, z: cz }, solid: false },
    // the shaft (4 x 4, hollow) up to the box
    { from: { x: -4, y: Y, z: cz - 2 }, to: { x: -1, y: Y + 11, z: cz + 1 }, solid: true },
    { from: { x: -3, y: Y, z: cz - 1 }, to: { x: -2, y: Y + 11, z: cz }, solid: false },
    // the spawning box: a shell 12 high, overhanging the platform to x = 5
    { from: { x: -26, y: Y + 12, z: cz - 15 }, to: { x: 5, y: Y + 23, z: cz + 14 }, solid: true },
    { from: { x: -25, y: Y + 13, z: cz - 14 }, to: { x: 4, y: Y + 22, z: cz + 13 }, solid: false },
  ];
  if (o.island) boxes.push({ from: { x: 40, y: FEET, z: cz - 10 }, to: { x: 52, y: FEET + 6, z: cz + 10 }, solid: true });
  // the sea: 5 deep over the flat ground everywhere around
  const water: BlockBox[] = [{ from: { x: -200, y: FEET, z: cz - 200 }, to: { x: 200, y: FEET + 4, z: cz + 200 }, solid: false }];
  const w = world(boxes, water);
  const goal = { x: 0, y: Y - 4, z: cz };
  /** The probe: a walk from the platform down the ladder (its path: to the hole, 4 down, to the goal); nothing else walks there. */
  const probe = (from: { x: number; y: number; z: number }): Promise<ProbeOutcome> =>
    Promise.resolve(from.y === Y ? { status: 'found', blocks: Math.abs(from.x - 2.5) + Math.abs(from.z - (cz + 0.5)) + 4 + 2.5 } : { status: 'none' });
  return { ...w, Y, cz, goal, probe };
}

export interface TripOptions {
  seed?: number;
  retarget?: (t: number, pos: { x: number; y: number; z: number }) => LandingTarget | undefined;
  maxTicks?: number;
  /** Track F1: the landing family (flyLandStyle). */
  landStyle?: BrainOptions['landStyle'];
  /** Track F3: the route planner (the route landings' tracker, the route takeoff). */
  route?: BrainOptions['route'];
  routeTakeoff?: BrainOptions['routeTakeoff'];
  takeoffYaw?: number;
  rockets?: number;
}

/** The brain flying a whole trip on stepBody to `target` (the offline simulator; fly.test.ts flyTrip generalised). */
export function trip(w: ReturnType<typeof world>, start: { x: number; y: number; z: number }, target: LandingTarget, o: TripOptions = {}) {
  const notes: string[] = [];
  const cz = cruiseHeight(start, target, w.skyTop, {});
  const brain = new FlightBrain(target, { cruiseY: cz.y, groundAt: (x, z, fromY) => w.dryGround(x, z, fromY), skyTop: w.skyTop, obstacle: (x, y, z) => w.solid.solidAt(x, y, z) === true, seed: o.seed ?? 5, note: (m) => notes.push(m), ...(o.landStyle ? { landStyle: o.landStyle } : {}), ...(o.route ? { route: o.route } : {}), ...(o.routeTakeoff ? { routeTakeoff: o.routeTakeoff } : {}), ...(o.takeoffYaw !== undefined ? { takeoffYaw: o.takeoffYaw } : {}) });
  let body = initialBody(start, true);
  let cmd = { ...IDLE_COMMAND };
  const rockets0 = o.rockets ?? 64;
  let rockets = rockets0;
  let lastFire = -100;
  let lastAir = { vy: 0, h: 0 };
  let hits = 0;
  let minClear = Infinity;
  for (let t = 1; t < (o.maxTicks ?? 8000); t++) {
    const nt = o.retarget?.(t, body.pos);
    if (nt) brain.retarget(nt, { pos: body.pos, vel: body.vel, onGround: body.onGround, gliding: body.gliding ?? false, boostTicks: body.boostTicks ?? 0 });
    const out = brain.step({ tick: t, body: { pos: body.pos, vel: body.vel, onGround: body.onGround, gliding: body.gliding ?? false, boostTicks: body.boostTicks ?? 0 }, yaw: cmd.yaw, pitch: cmd.pitch, rockets, canFire: t - lastFire >= 4, health: 20, elytraLeft: 400 });
    const c = out.control;
    cmd = { ...cmd, yaw: c.yaw, pitch: c.pitch, jump: c.jump, glide: c.glide };
    const step = { ...cmd, ...(c.fire ? { boostStart: GLIDE.boostTicks } : {}) };
    if (c.fire) {
      rockets--;
      lastFire = t;
    }
    if (body.gliding) lastAir = { vy: body.vel.y, h: Math.hypot(body.vel.x, body.vel.z) };
    const before = body.vel;
    body = stepBody(body, step, w.solid).state;
    if (body.gliding && Math.hypot(before.x, before.z) > 0.6 && Math.hypot(body.vel.x, body.vel.z) < Math.hypot(before.x, before.z) * 0.3 && body.pos.y > FEET + 0.5) hits++;
    if (body.gliding) minClear = Math.min(minClear, body.pos.y - w.skyTop(Math.floor(body.pos.x), Math.floor(body.pos.z)));
    if (out.end) return { end: out.end, ticks: t, rockets: rockets0 - rockets, goArounds: brain.stats.goArounds, reasons: brain.stats.goAroundReasons, lastAir, hits, body, notes, holdTicks: brain.stats.holdTicks, descents: brain.stats.descents, stats: brain.stats, approachTicks: brain.stats.approachTicks };
  }
  throw new Error(`the flight never ended (${brain.phase}, notes ${notes.join(' | ')})`);
}
