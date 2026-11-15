// Track M3 (docs/flight.md "The landing looks at hostile mobs"): the offline harness of the landing's look at hostile
// mobs. The FlightBrain flies a whole trip on the physics engine (stepBody) as in fly-worlds.ts, with scripted hostiles
// on the ground round the landing and the trip's own late look (tasks/process/fly.ts watchLanding: the chosen cell asked
// against the hostiles, the landing searched again and the flight retargeted). The hostiles follow the server's rules
// as measured on BDS 1.26.60 (docs/pve.md), simplified to what a landing meets:
//
//   creeper   walks at 0.1 a tick to a body within 16; its fuse lights within 3 (feet to feet), goes out beyond 7,
//             and 30 ticks lit it explodes: (impact^2 + impact) / 2 * 42 + 1 with impact = 1 - d / 6 (8.6 at 4, 2.0 at 5.5)
//   zombie    walks at 0.12 a tick to a body within 35 (16 up); 20 health; hits for 3 every 20 ticks a body within 1.7 of
//             it level whose feet are no more than 3.2 over its own (it reaches up: on bds-gaunt and on the Realm a zombie
//             hit a body sinking in the elevator 2 to 4 blocks over the floor)
//   skeleton  stands; shoots a body within 16 every 61 ticks, the first 62 after it saw it: 4, and only a body slower
//             than 0.3 a tick is hit (measured: running across at 0.21 a tick 1 of 5, standing 3 of 3 at 10)
//   phantom   circles 12 over the landing and swoops every 100 ticks: 2 to a body slower than 0.35 a tick within 24
//
// The reflex is modelled as the server takes it: a strike on every hostile in reach (eye to box, here eye to the mob's
// middle less 0.3) once in 10 ticks: 3.9 on the ground, 5.5 while the flight comes down (tasks/pve.ts
// FLIGHT_STRIKE_REACH); the knockback 1.65 blocks along the level line from the body, none when the body is more than
// 1.5 over the mob (the line points down); the damage a fist's 1, or with `blade` a netherite sword's 8, 12 while the
// body falls (the server's critical hit). Without the look it works from 10 ticks after the touchdown (the settle,
// during which the flight holds the body); with it from the moment the body is coming down onto its landing
// (controller.ts touchingDown) on. Nothing else defends the body: after the touchdown it
// stands where it is for the rest of the run (the guard's hit and run is not modelled), so the numbers are the landing's.
import { FlightBrain } from '../../../src/skills/fly/brain.ts';
import { STRIKE_ABOVE, STRIKE_SPEED } from '../../../src/skills/fly/controller.ts';
import { cellsAround, ColumnView, findLanding, walkTarget, type LandingPlan } from '../../../src/skills/fly/landing.ts';
import { cellPrice, LAND_MOBS, type LandMob, type LandMobKind } from '../../../src/skills/fly/landmobs.ts';
import { cruiseHeight, hdist, type LandingTarget } from '../../../src/skills/fly/plan.ts';
import { GLIDE, IDLE_COMMAND, initialBody, stepBody, type BlockBox } from '../../../src/skills/input/index.ts';
import { FEET, world } from './fly-worlds.ts';

export interface SimMob {
  id: bigint;
  type: 'creeper' | 'zombie' | 'skeleton' | 'phantom';
  x: number;
  y: number;
  z: number;
  /** Creeper: ticks its fuse has burnt (undefined: out). */
  fuse?: number;
  /** Ticks since it last hit or shot; since it first saw the body. */
  cool: number;
  seen: number;
  hurt: number;
  dead: boolean;
  health: number;
}

export const simMob = (id: number, type: SimMob['type'], x: number, z: number, y = FEET): SimMob => ({ id: BigInt(id), type, x, y, z, cool: 0, seen: 0, hurt: 100, dead: false, health: 20 });

const KIND: Record<SimMob['type'], LandMobKind> = { creeper: 'creeper', zombie: 'melee', skeleton: 'ranged', phantom: 'flying' };
/** The server sends an entity when the body is within about this of it (level). */
export const ENTITY_RANGE = 72;

/** The hostiles as the landing reads them (landmobs.ts LandMob): those the server has sent the body. */
export function seenMobs(mobs: readonly SimMob[], body: { x: number; z: number }, near: { x: number; z: number }): LandMob[] {
  const out: LandMob[] = [];
  for (const m of mobs) {
    if (m.dead || Math.hypot(m.x - body.x, m.z - body.z) > ENTITY_RANGE || Math.hypot(m.x - near.x, m.z - near.z) > LAND_MOBS.scan) continue;
    out.push({ id: m.id, type: m.type, kind: KIND[m.type], x: m.x, y: m.y, z: m.z, lit: m.fuse !== undefined, hunting: m.seen > 0 && m.type !== 'skeleton' });
  }
  return out;
}

export interface MobRun {
  landed: boolean;
  reason: string | undefined;
  /** Where the body stood at the end, how far from the first landing's centre. */
  at: { x: number; y: number; z: number };
  fromFirst: number;
  /** Ticks of the flight (to the touchdown). */
  ticks: number;
  rockets: number;
  goArounds: number;
  mobRounds: number;
  /** Health lost, by what; the explosions that hurt. */
  damage: number;
  byType: Record<string, number>;
  explosions: number;
  /** The nearest live creeper at the touchdown (feet to feet), Infinity with none. */
  creeperAtTouchdown: number;
  /** Strikes the reflex model made while the body was still in the air. */
  airStrikes: number;
  retargets: number;
  notes: string[];
}

export interface MobTripOptions {
  /** The look on (the setting `flyLandMobs`): the search's refusals and prices, the late look, the brain's look, the reflex while coming down. */
  look: boolean;
  seed?: number;
  /** Ticks simulated after the touchdown (the body standing where it landed). */
  after?: number;
  maxTicks?: number;
  wayDown?: boolean;
  /** A netherite sword in the hotbar (the live kit); default bare hands. */
  blade?: boolean;
}

/** A yard on flat ground with roofs round it (fly-land-clear.test.ts): the landing is the brake over them and the elevator down. */
export function yardBoxes(Z: number): BlockBox[] {
  const box = (x0: number, z0: number, x1: number, z1: number, height: number): BlockBox => ({ from: { x: x0, y: FEET, z: z0 }, to: { x: x1, y: FEET + height - 1, z: z1 }, solid: true });
  return [box(-1, -1, 1, 1, 70), box(-15, Z - 6, -7, Z + 5, 8), box(7, Z - 5, 13, Z + 5, 6), box(11, Z - 1, 12, Z, 11), box(-3, Z - 12, 2, Z - 8, 5), box(-15, Z - 4, -14, Z - 3, 25)];
}

/** The start pillar alone: open flat ground round the landing. */
export function openBoxes(): BlockBox[] {
  return [{ from: { x: -1, y: FEET, z: -1 }, to: { x: 1, y: FEET + 69, z: 1 }, solid: true }];
}

/**
 * One trip from the pillar's top to the goal cell (0, FEET, Z) with `mobs` on the ground: the brain on stepBody, the
 * late look every 10 ticks, the hostiles and the reflex model stepped every tick, `after` ticks on the ground.
 */
export async function mobTrip(boxes: BlockBox[], Z: number, mobs: SimMob[], o: MobTripOptions): Promise<MobRun> {
  const w = world(boxes);
  const start = { x: 0.5, y: FEET + 70, z: 0.5 };
  const goal = { x: 0, y: FEET, z: Z };
  const view = new ColumnView(w.look, FEET);
  const cell0 = { x: 0, z: Z, feet: FEET, kind: 'open' as const };
  const first = walkTarget(cell0, cellsAround(view, cell0, 'open', 5, 4), { walkS: 0, walkKnown: true });
  const notes: string[] = [];
  let body = initialBody(start, true);
  const cz = cruiseHeight(start, first, w.skyTop, {});
  const brain = new FlightBrain(first, {
    cruiseY: cz.y,
    groundAt: (x, z, fromY) => w.dryGround(x, z, fromY),
    skyTop: w.skyTop,
    obstacle: (x, y, z) => w.solid.solidAt(x, y, z) === true,
    seed: o.seed ?? 5,
    note: (m) => notes.push(m),
    ...(o.wayDown ? { wayDown: true } : {}),
    ...(o.look ? { landMobs: (near: { x: number; z: number }) => seenMobs(mobs, body.pos, near) } : {}),
  });
  // the trip's own landing search (commands-fly.ts landingFor), with the hostiles the body knows of
  const search = (): Promise<LandingPlan> => {
    const hostiles = seenMobs(mobs, body.pos, { x: goal.x + 0.5, z: goal.z + 0.5 });
    return findLanding(
      goal,
      'the goal',
      {
        look: w.look,
        obstacle: (x, y, z) => w.solid.solidAt(x, y, z) === true,
        probe: (from) => Promise.resolve({ status: 'found', blocks: Math.hypot(from.x - goal.x - 0.5, from.z - goal.z - 0.5) }),
        dryGround: (x, z) => w.dryGround(x, z),
        ...(hostiles.length ? { mobs: (c: { x: number; z: number; feet: number }) => cellPrice(c, hostiles) } : {}),
      },
      { radius: 32, headroom: 4, maxUnder: 8, probes: 16, budgetMs: 6000 },
    );
  };
  let cell: { x: number; z: number; feet: number } | undefined = cell0;
  let target: LandingTarget = first;
  let cmd = { ...IDLE_COMMAND };
  let rockets = 64;
  let lastFire = -100;
  let health = 20;
  const byType: Record<string, number> = {};
  let explosions = 0;
  let airStrikes = 0;
  let retargets = 0;
  let lastMobLook = -1000;
  let mobMoves = 0;
  let touchdown: number | undefined;
  let creeperAtTouchdown = Infinity;
  let landed = false;
  let reason: string | undefined;
  const hurt = (type: string, n: number): void => {
    health -= n;
    byType[type] = (byType[type] ?? 0) + n;
  };
  const struck = new Map<bigint, number>();
  const after = o.after ?? 60;
  for (let t = 1; t < (o.maxTicks ?? 8000); t++) {
    const flying = touchdown === undefined;
    const b = { pos: body.pos, vel: body.vel, onGround: body.onGround, gliding: body.gliding ?? false, boostTicks: body.boostTicks ?? 0 };
    // the trip's late look (watchLanding): the chosen cell against the hostiles, every 10 ticks; refused: searched again
    if (flying && o.look && cell && t % 10 === 0 && t - lastMobLook >= 20 && brain.target === target && hdist(body.pos, target) >= 6) {
      const price = cellPrice(cell, seenMobs(mobs, body.pos, target));
      const why = price.refuse ?? (price.priceS >= LAND_MOBS.relookS && mobMoves < LAND_MOBS.relooks ? `hostiles that cost ${price.priceS.toFixed(0)} s` : undefined);
      if (why) {
        if (!price.refuse) mobMoves++;
        lastMobLook = t;
        const plan = await search();
        if (plan.kind === 'cell' || plan.kind === 'goal' || plan.kind === 'fallback') {
          if (brain.retarget(plan.target, b)) {
            notes.push(`late look at tick ${t}: the cell has ${why}: retargeted to ${plan.cell.x} ${plan.cell.z}`);
            target = plan.target;
            cell = plan.cell;
            retargets++;
          } else notes.push(`late look at tick ${t}: the cell has ${why}: the landing could not be moved now (${brain.phase})`);
        }
      }
    }
    if (flying) {
      const out = brain.step({ tick: t, body: b, yaw: cmd.yaw, pitch: cmd.pitch, rockets, canFire: t - lastFire >= 4, health: 20, elytraLeft: 400 });
      const c = out.control;
      cmd = { ...cmd, yaw: c.yaw, pitch: c.pitch, jump: c.jump, glide: c.glide };
      const step = { ...cmd, ...(c.fire ? { boostStart: GLIDE.boostTicks } : {}) };
      if (c.fire) {
        rockets--;
        lastFire = t;
      }
      body = stepBody(body, step, w.solid).state;
      if (out.end) {
        touchdown = t;
        landed = out.end.ok;
        reason = out.end.ok ? undefined : out.end.reason;
        creeperAtTouchdown = mobs.filter((m) => m.type === 'creeper' && !m.dead).reduce((d, m) => Math.min(d, Math.hypot(m.x - body.pos.x, m.y - body.pos.y, m.z - body.pos.z)), Infinity);
      }
    } else if (t - touchdown! > after) break;
    // ---- the reflex model (its strike goes out before the mobs move: a strike in reach lands before the swing) ----
    const p = body.pos;
    const speed = Math.hypot(body.vel.x, body.vel.z);
    const comingDown = flying && (brain.phase === 'approach' || brain.phase === 'land') && body.pos.y - brain.aim.top < STRIKE_ABOVE && speed < STRIKE_SPEED;
    const reflex = o.look ? comingDown || !flying : !flying && t - touchdown! >= 10;
    if (reflex) {
      for (const m of mobs) {
        if (m.dead || m.type === 'phantom') continue;
        const d3 = Math.hypot(p.x - m.x, p.y + 1.62 - (m.y + 0.9), p.z - m.z) - 0.3;
        if (d3 > (o.look && flying ? 5.5 : 3.9) || t - (struck.get(m.id) ?? -100) < 10) continue;
        struck.set(m.id, t);
        m.hurt = 0;
        if (flying) airStrikes++;
        m.health -= o.blade ? (flying && body.vel.y < 0 ? 12 : 8) : 1;
        if (m.health <= 0) {
          m.dead = true;
          continue;
        }
        if (p.y - m.y > 1.5) continue; // struck from above: nothing pushes it aside
        const level = Math.max(0.2, Math.hypot(m.x - p.x, m.z - p.z));
        const kb = m.type === 'creeper' ? 1.29 : 1.65;
        m.x += ((m.x - p.x) / level) * kb;
        m.z += ((m.z - p.z) / level) * kb;
      }
    }
    // ---- the hostiles ----
    for (const m of mobs) {
      if (m.dead) continue;
      m.cool++;
      m.hurt++;
      const dx = p.x - m.x;
      const dz = p.z - m.z;
      const level = Math.hypot(dx, dz);
      const d3 = Math.hypot(dx, p.y - m.y, dz);
      const walk = (v: number): void => {
        if (level < 0.3 || m.hurt < 10) return;
        m.x += (dx / level) * Math.min(v, level);
        m.z += (dz / level) * Math.min(v, level);
      };
      if (m.type === 'creeper') {
        if (d3 <= 16) m.seen++;
        if (d3 <= 16 && d3 > 2.5) walk(0.1);
        if (m.fuse === undefined && d3 <= 3) m.fuse = 0;
        else if (m.fuse !== undefined && d3 > 7) m.fuse = undefined;
        if (m.fuse !== undefined && ++m.fuse >= 30) {
          m.dead = true;
          const impact = Math.max(0, 1 - (d3 + 0.6) / 6);
          const dmg = impact > 0 ? ((impact * impact + impact) / 2) * 42 + 1 : 0;
          if (dmg > 0) {
            hurt('creeper', dmg);
            explosions++;
          }
        }
      } else if (m.type === 'zombie') {
        if (level <= 35 && Math.abs(p.y - m.y) <= 16) {
          m.seen++;
          if (level > 1) walk(0.12);
        }
        if (level <= 1.7 && p.y - m.y <= 3.2 && p.y - m.y >= -1 && m.cool >= 20 && m.hurt >= 10) {
          m.cool = 0;
          hurt('zombie', 3);
        }
      } else if (m.type === 'skeleton') {
        if (d3 <= 16) {
          m.seen++;
          if (m.seen >= 62 && m.cool >= 61) {
            m.cool = 0;
            if (speed < 0.3) hurt('skeleton', 4);
          }
        } else m.seen = 0;
      } else {
        // a phantom: over the landing, a swoop every 100 ticks at a slow body in range
        if (level <= 24 && m.cool >= 100) {
          m.cool = 0;
          if (speed < 0.35) hurt('phantom', 2);
        }
      }
    }
    if (health <= 0) break;
  }
  if (touchdown === undefined) throw new Error(`the flight never ended (${brain.phase}; ${notes.slice(-6).join(' | ')})`);
  return {
    landed,
    reason,
    at: { ...body.pos },
    fromFirst: hdist(body.pos, first),
    ticks: touchdown,
    rockets: 64 - rockets,
    goArounds: brain.stats.goArounds,
    mobRounds: brain.stats.mobRounds ?? 0,
    damage: 20 - health,
    byType,
    explosions,
    creeperAtTouchdown,
    airStrikes,
    retargets,
    notes,
  };
}
