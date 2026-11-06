// The whole-trip harness of the flight unit tests (wave 11 Track AU / AU2, Track BL): the FlightBrain flies a
// trip on stepBody over a flat world with boxes (platforms, walls, trees, roofs, mountains), the obstacle the
// brain sees optionally blind to `unknown` columns (the physics still has them) or cache-only columns.
import { FlightBrain } from '../../../src/skills/fly/brain.ts';
import { cruiseHeight, type LandingTarget } from '../../../src/skills/fly/plan.ts';
import { flatWorld, GLIDE, IDLE_COMMAND, initialBody, stepBody, withBoxes, type BlockQuery } from '../../../src/skills/input/index.ts';

export const FEET = -60;

export function flyTrip(o: { dist: number; up: number; half: number; startUp?: number; wall?: boolean; house?: number; seed?: number; retargetFrom?: LandingTarget; retargetWithin?: number; retargetBeyond?: number; walls?: boolean; tree?: boolean; roof?: boolean; rockets?: number; life?: number; takeoffYaw?: number; descent?: 'auto' | 'dive' | 'spiral'; terrain?: boolean; extra?: { from: { x: number; y: number; z: number }; to: { x: number; y: number; z: number }; solid: boolean }[]; unknown?: (x: number, z: number) => boolean; cacheOnly?: (x: number, z: number) => boolean; highCruise?: boolean; notes?: string[]; view?: number; landStyle?: 'auto' | 'flare' | 'brake' }) {
  const tx = 0;
  const tz = o.dist;
  const top = FEET + o.up;
  const boxes = [] as { from: { x: number; y: number; z: number }; to: { x: number; y: number; z: number }; solid: boolean }[];
  if (o.up > 0) boxes.push({ from: { x: tx - o.half, y: top - 1, z: tz - o.half }, to: { x: tx + o.half, y: top - 1, z: tz + o.half }, solid: true });
  if (o.wall) boxes.push({ from: { x: tx - 3, y: top - 1, z: tz - o.half - 10 }, to: { x: tx + 3, y: top + 11, z: tz - o.half - 10 }, solid: true });
  if (o.walls) {
    // Track AU2: 20-high walls 10 blocks from the centre on three sides (left, right, far)
    boxes.push({ from: { x: tx - 10, y: top - 1, z: tz - 10 }, to: { x: tx - 10, y: top + 18, z: tz + 10 }, solid: true });
    boxes.push({ from: { x: tx + 10, y: top - 1, z: tz - 10 }, to: { x: tx + 10, y: top + 18, z: tz + 10 }, solid: true });
    boxes.push({ from: { x: tx - 10, y: top - 1, z: tz + 10 }, to: { x: tx + 10, y: top + 18, z: tz + 10 }, solid: true });
  }
  if (o.tree) boxes.push({ from: { x: -1, y: FEET, z: 9 }, to: { x: 1, y: FEET + 7, z: 11 }, solid: true }); // Track AU2: a tree 10 blocks ahead on the climb line
  if (o.roof) boxes.push({ from: { x: -40, y: FEET + 6, z: -40 }, to: { x: 40, y: FEET + 6, z: 60 }, solid: true }); // Track AU2: a wide roof 6 above the start (the flight is already in the air under it)
  if (o.startUp) boxes.push({ from: { x: -1, y: FEET, z: -1 }, to: { x: 1, y: FEET + o.startUp - 1, z: 1 }, solid: true });
  if (o.house !== undefined) {
    // Track AU2 review: the fly-walk house (7 x 7, walls 3 high, the roof on top, a doorway towards the start) its centre o.house blocks beyond the target
    const hz = tz + o.house;
    boxes.push({ from: { x: tx - 3, y: FEET, z: hz - 3 }, to: { x: tx + 3, y: FEET + 3, z: hz + 3 }, solid: true });
    boxes.push({ from: { x: tx - 2, y: FEET, z: hz - 2 }, to: { x: tx + 2, y: FEET + 2, z: hz + 2 }, solid: false });
    boxes.push({ from: { x: tx, y: FEET, z: hz - 3 }, to: { x: tx, y: FEET + 1, z: hz - 3 }, solid: false });
  }
  if (o.extra) boxes.push(...o.extra);
  const world: BlockQuery = withBoxes(flatWorld(), boxes);
  const skyTop = (x: number, z: number): number => {
    for (let y = 330; y >= -64; y--) if (world.solidAt(x, y, z)) return y;
    return -64;
  };
  const groundBelow = (x: number, z: number, fromY = 330): number => {
    for (let y = Math.floor(fromY); y >= -64; y--) if (world.solidAt(x, y, z)) return y + 1;
    return -63;
  };
  const target: LandingTarget = { x: tx + 0.5, z: tz + 0.5, top, half: o.half, ground: FEET };
  const start = { x: 0.5, y: FEET + (o.startUp ?? 0), z: 0.5 };
  const cz = cruiseHeight(start, target, o.roof ? () => FEET - 1 : skyTop, {});
  // Track BL: the column query (live, the cache only, unknown) and the obstacle the brain sees (unknown cells are air there, cache-only columns solid to their top)
  // Track BL: `view`: an unknown column becomes known when the body comes within this many blocks (the chunks load as it flies)
  let at = { x: 0.5, z: 0.5 };
  const unknown0 = o.unknown;
  const blind = unknown0 ? (x: number, z: number): boolean => unknown0(x, z) && (o.view === undefined || Math.hypot(x - at.x, z - at.z) > o.view) : undefined;
  o = { ...o, ...(blind ? { unknown: blind } : {}) };
  const terrain = o.terrain ? (x: number, z: number) => (o.unknown?.(x, z) ? { top: undefined, src: 'unknown' as const } : { top: skyTop(x, z), src: o.cacheOnly?.(x, z) ? ('cache' as const) : ('live' as const) }) : undefined;
  const seen = (x: number, y: number, z: number): boolean => (o.unknown?.(x, z) ? false : o.cacheOnly?.(x, z) ? y <= skyTop(x, z) : world.solidAt(x, y, z) === true);
  const brain = new FlightBrain(target, { cruiseY: o.highCruise ? 328 : cz.y, groundAt: groundBelow, skyTop: (x, z) => (o.unknown?.(x, z) ? undefined : skyTop(x, z)), obstacle: seen, seed: o.seed ?? 5, takeoffYaw: o.takeoffYaw, descent: o.descent ?? 'spiral', ...(terrain ? { terrain } : {}), ...(o.highCruise ? { highCruise: true } : {}), ...(o.notes ? { note: (m: string) => o.notes!.push(m) } : {}), ...(o.landStyle ? { landStyle: o.landStyle } : {}) });
  let body = initialBody(start, true);
  let cmd = { ...IDLE_COMMAND };
  let rockets = o.rockets ?? 64;
  let lastFire = -100;
  let lastAir = { vy: 0, h: 0 };
  let hits = 0;
  let retargeted = 0;
  for (let t = 1; t < 6000; t++) {
    if (o.retargetFrom && !retargeted && Math.hypot(body.pos.x - target.x, body.pos.z - target.z) <= o.retargetWithin! && t % 10 === 0 && (o.retargetBeyond === undefined || body.pos.z > target.z + o.retargetBeyond)) retargeted = brain.retarget(o.retargetFrom, { pos: body.pos, vel: body.vel, onGround: body.onGround, gliding: body.gliding ?? false, boostTicks: body.boostTicks ?? 0 }) ? t : 0;
    const out = brain.step({
      tick: t,
      body: { pos: body.pos, vel: body.vel, onGround: body.onGround, gliding: body.gliding ?? false, boostTicks: body.boostTicks ?? 0 },
      yaw: cmd.yaw,
      pitch: cmd.pitch,
      rockets,
      canFire: t - lastFire >= 4,
      health: 20,
      elytraLeft: 400,
    });
    const c = out.control;
    cmd = { ...cmd, yaw: c.yaw, pitch: c.pitch, jump: c.jump, glide: c.glide };
    const step = { ...cmd, ...(c.fire ? { boostStart: Math.min(GLIDE.boostTicks, o.life ?? 15) } : {}) };
    if (c.fire) {
      rockets--;
      lastFire = t;
    }
    if (body.gliding) lastAir = { vy: body.vel.y, h: Math.hypot(body.vel.x, body.vel.z) };
    const before = body.vel;
    body = stepBody(body, step, world).state;
    at = { x: body.pos.x, z: body.pos.z };
    // Track AU2: a collision in the air (the speed vanishes without the brain's doing) is what the path-ahead check must prevent
    if (body.gliding && Math.hypot(before.x, before.z) > 0.6 && Math.hypot(body.vel.x, body.vel.z) < Math.hypot(before.x, before.z) * 0.3 && body.pos.y > FEET + 0.5) hits++;
    if (out.end) return { avoidances: brain.stats.avoidances, dives: brain.stats.dives, startY: start.y, retargeted, end: out.end, ticks: t, rockets: (o.rockets ?? 64) - rockets, by: brain.stats.rocketsBy, goArounds: brain.stats.goArounds, lastAir, maxY: brain.stats.maxY, cruiseY: cz.y, descents: brain.stats.descents, steered: brain.stats.steered, hits, body, stats: brain.stats };
  }
  throw new Error('the flight never ended');
}

