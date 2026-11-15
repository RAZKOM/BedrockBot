// The landing's look at hostile mobs (Track M3; docs/flight.md "The landing looks at hostile mobs",
// decisions/0086-landing-looks-at-mobs.md; the setting `flyLandMobs`, default off).
//
// A flight's last seconds are the ones in which the body cannot defend itself: the brake and the elevator hold it
// nearly still over one cell for 2 to 8 s, the guard is paused under the flight, and a body that sinks 0.15 to 0.3 a
// tick cannot step aside. A creeper's fuse lights when the body comes within about 3 blocks of it and runs 31 ticks
// (docs/pve.md "Creepers"): a creeper on or beside the landing cell goes off at the touchdown. So:
//
//   the search    a landing cell within CREEPER_REFUSE of a creeper is no landing; one within reach of other hostiles
//                 costs seconds (`cellPrice`), so that a cell without them a few blocks on is taken instead
//   the late look the cell is asked again while the flight comes down (`cellRefusal`): hostiles are known only where
//                 the server sends entities (about 5 chunks round the body) and they move
//   the brain     in the approach and the elevator (`touchdownThreat`): a creeper that is, or by the touchdown will be,
//                 within CREEPER_BLAST of where the feet come down moves the landing (`clearOf`) and the body goes
//                 round to it
//
// Everything here is a pure function of a list of `LandMob`s: with no hostile in the list every answer is `nothing`,
// and the callers do nothing they did not do before (the flights without mobs are tick for tick the same).
import { bareType, classify, entityFeet, isCreeper, isFlying, RANGED_TYPES } from '../combat/hostiles.ts';
import type { EntityInfo } from '../../world/types.ts';

export type LandMobKind = 'creeper' | 'melee' | 'ranged' | 'flying';

/** A hostile as the landing sees it: where its feet are, and what the server said of it last. */
export interface LandMob {
  id: bigint;
  /** The bare type (`creeper`, `zombie`). */
  type: string;
  kind: LandMobKind;
  x: number;
  y: number;
  z: number;
  /** A creeper whose fuse is lit (the `ignited` actor flag). */
  lit: boolean;
  /** The server says it targets the bot (`target_eid`). */
  hunting: boolean;
}

/**
 * The numbers (blocks, feet to feet, unless said). The creeper's are the server's as measured on BDS 1.26.60
 * (docs/pve.md "Creepers"): the fuse lights at 2.8 to 3.4, goes out at 6.65 to 7.26, the explosion 31 ticks after
 * it lit does 8.6 at 4 blocks and 2.0 at 5.5 to a body without armour.
 */
export const LAND_MOBS = Object.freeze({
  /** No touchdown with a live creeper this close: its blast range (beyond it a fuse goes out and an explosion does nothing). */
  blast: 7,
  /** The search refuses a cell with a creeper this close: the blast range and the 5 blocks a creeper walks in the 2.5 s an elevator takes at the least. */
  refuse: 12,
  /** A creeper follows a player it sees out to here; a cell inside it is priced. */
  follow: 16,
  /** ... and the price runs out here. */
  priceOut: 24,
  /** A landing moved for a creeper lies at least this far from every creeper known (outside what it follows, with room), ... */
  clear: 20,
  /** ... or, when no ground that far is known, at least this far. */
  clearMin: 12,
  /** A moved landing is looked for out to this far from the first one. */
  moveWithin: 40,
  /** Seconds: a creeper inside `follow` of the cell (it will come: the go-around it costs, weighed by how often). */
  creeperS: 10,
  /** Seconds: a melee mob on the cell (the fight it starts: 2 to 3 s a zombie with a blade, docs/pve.md), running out at `meleeOut`. */
  meleeS: 6,
  meleeOut: 10,
  /** Seconds: an archer or a witch that will shoot at the landing (a skeleton duel is 3.5 to 5.3 s), running out at `rangedOut`. */
  rangedS: 4,
  rangedOut: 16,
  /** The sum's cap (seconds): a field of mobs is no reason to walk a minute more. */
  capS: 20,
  /** A cell whose hostiles cost this much (a melee mob within about 3 blocks of it) is searched again: the goal itself gives way to a cell beside it, and a chosen cell is asked again when mobs have come to it, `relooks` times a flight at the most. */
  relookS: 5,
  relooks: 2,
  /** A creeper's walk (blocks a tick) when nothing better was measured from its own steps. */
  creeperSpeed: 0.1,
  /** Too low to go round: this close over the landing's top the body lands and the guard has the creeper (a rocket from here would be flown into the ground). */
  commit: 1.5,
  /** The elevator's sink the touchdown's time is counted with (blocks a tick, the slow end: brake.ts ELEVATOR_SINK_MIN). */
  sink: 0.149,
  /** Mob rounds a flight flies at the most (each a go-around to a moved landing). */
  rounds: 2,
  /** The mobs the look counts: within this of the place asked about (level). */
  scan: 48,
});

/** The kind of each type asked so far (the look reads every tracked entity a tick: the answer by type is kept; null: none). */
const KINDS = new Map<string, LandMobKind | null>();

/** The kind of a hostile for the landing (undefined: not one it counts). */
export function landMobKind(type: string): LandMobKind | undefined {
  let k = KINDS.get(type);
  if (k === undefined) {
    k = classify(type) !== 'hostile' ? null : isCreeper(type) ? 'creeper' : isFlying(type) ? 'flying' : RANGED_TYPES.has(bareType(type)) ? 'ranged' : 'melee';
    if (KINDS.size < 1024) KINDS.set(type, k);
  }
  return k ?? undefined;
}

/** What the mob tracker knows of a mob (skills/combat/hostiles.ts MobTracker), as far as the landing reads it. */
export interface LandMobStates {
  get(rid: bigint): { ignited?: boolean; dead?: boolean } | undefined;
  targetsUs?(rid: bigint): boolean;
}

/**
 * The hostiles within `within` blocks (level) of `near`, from the world's entity tracker and the mob tracker. A dead mob
 * (its death animation seen) is none. Players, neutral and passive mobs, items and projectiles are never in it.
 */
export function landMobsNear(entities: Iterable<EntityInfo>, states: LandMobStates | undefined, near: { x: number; z: number }, within: number = LAND_MOBS.scan): LandMob[] {
  const out: LandMob[] = [];
  for (const e of entities) {
    if (e.username !== undefined) continue;
    const kind = landMobKind(e.type);
    if (!kind) continue;
    const f = entityFeet(e);
    if (Math.hypot(f.x - near.x, f.z - near.z) > within) continue;
    const st = states?.get(e.runtimeId);
    if (st?.dead) continue;
    out.push({ id: e.runtimeId, type: bareType(e.type), kind, x: f.x, y: f.y, z: f.z, lit: st?.ignited === true, hunting: states?.targetsUs?.(e.runtimeId) === true });
  }
  return out;
}

const dist3 = (m: { x: number; y: number; z: number }, p: { x: number; y: number; z: number }): number => Math.hypot(m.x - p.x, m.y - p.y, m.z - p.z);

/** The nearest creeper to `p` (feet to feet) and how far, undefined when none is known. */
export function nearestCreeper(mobs: readonly LandMob[], p: { x: number; y: number; z: number }): { mob: LandMob; d: number } | undefined {
  let best: { mob: LandMob; d: number } | undefined;
  for (const m of mobs) {
    if (m.kind !== 'creeper') continue;
    const d = dist3(m, p);
    if (!best || d < best.d) best = { mob: m, d };
  }
  return best;
}

/** A linear price: `at` up to `full` blocks, running out at `out`. */
const taper = (d: number, at: number, full: number, out: number): number => (d <= full ? at : d >= out ? 0 : (at * (out - d)) / (out - full));

export interface CellPrice {
  /** The cell is no landing (the line says why). */
  refuse?: string;
  /** Seconds the hostiles round it cost. */
  priceS: number;
  /** What made the price, for the search's line (`creeper 14 off, 2 melee`). */
  note?: string;
}

/**
 * A landing cell (its centre, the feet height) against the hostiles: refused within LAND_MOBS.refuse of a creeper, else
 * priced: a creeper out to `priceOut`, melee mobs out to `meleeOut`, shooters out to `rangedOut`, the sum capped. A mob
 * more than 8 blocks over or under the cell is on another level (a cave under the landing, a roof over it) and counts
 * for nothing but a creeper's refusal, which is measured in 3D. Flying mobs are not tied to a cell: no price.
 */
export function cellPrice(cell: { x: number; z: number; feet: number }, mobs: readonly LandMob[]): CellPrice {
  if (mobs.length === 0) return { priceS: 0 };
  const p = { x: cell.x + 0.5, y: cell.feet, z: cell.z + 0.5 };
  let price = 0;
  let creepers = 0;
  let melee = 0;
  let ranged = 0;
  let nearest: number | undefined;
  for (const m of mobs) {
    const d = dist3(m, p);
    if (m.kind === 'creeper') {
      if (d < LAND_MOBS.refuse) return { refuse: `a creeper ${d.toFixed(0)} off`, priceS: Infinity };
      const s = taper(d, LAND_MOBS.creeperS, LAND_MOBS.follow, LAND_MOBS.priceOut);
      if (s > 0) {
        price += s;
        creepers++;
        nearest = Math.min(nearest ?? Infinity, d);
      }
      continue;
    }
    if (Math.abs(m.y - p.y) > 8) continue;
    if (m.kind === 'melee') {
      const s = taper(d, LAND_MOBS.meleeS, 2, LAND_MOBS.meleeOut);
      if (s > 0) {
        price += s;
        melee++;
      }
    } else if (m.kind === 'ranged') {
      const s = taper(d, LAND_MOBS.rangedS, 8, LAND_MOBS.rangedOut);
      if (s > 0) {
        price += s;
        ranged++;
      }
    }
  }
  if (price === 0) return { priceS: 0 };
  const parts = [creepers ? `${creepers === 1 ? 'a creeper' : `${creepers} creepers`} ${nearest!.toFixed(0)} off` : '', melee ? `${melee} melee` : '', ranged ? `${ranged} shooting` : ''].filter(Boolean);
  return { priceS: Math.min(LAND_MOBS.capS, price), note: parts.join(', ') };
}

/** The late look's answer for a chosen cell: why it is no landing any more (a creeper inside LAND_MOBS.refuse), else undefined. */
export function cellRefusal(cell: { x: number; z: number; feet: number }, mobs: readonly LandMob[]): string | undefined {
  if (mobs.length === 0) return undefined;
  return cellPrice(cell, mobs).refuse;
}

/** One line of what is known round a place, for the logs (`2 creepers (nearest 9), 3 melee, 1 shooting, 1 flying`), undefined with nothing. */
export function landMobsSaid(mobs: readonly LandMob[], p?: { x: number; y: number; z: number }): string | undefined {
  if (mobs.length === 0) return undefined;
  const n = { creeper: 0, melee: 0, ranged: 0, flying: 0 };
  for (const m of mobs) n[m.kind]++;
  const c = p ? nearestCreeper(mobs, p) : undefined;
  const parts = [n.creeper ? `${n.creeper} creeper${n.creeper === 1 ? '' : 's'}${c ? ` (nearest ${c.d.toFixed(0)})` : ''}` : '', n.melee ? `${n.melee} melee` : '', n.ranged ? `${n.ranged} shooting` : '', n.flying ? `${n.flying} flying` : ''].filter(Boolean);
  return parts.join(', ');
}

/** Where each creeper was a few ticks ago and how fast it closed on the touchdown then (the brain's own memory). */
export type CreeperTrack = Map<bigint, { x: number; y: number; z: number; tick: number; closing: number }>;
/** A creeper's speed is read over this many ticks. */
export const TRACK_TICKS = 5;

export interface TouchdownThreat {
  mob: LandMob;
  /** Feet to feet from the touchdown now, and at the touchdown when it keeps walking as it did. */
  d: number;
  atTouchdown: number;
  /** Blocks a tick it closed on the touchdown since the look before (0 when it stood or walked away). */
  closing: number;
}

/**
 * The brain's look in the last seconds: the creeper that is inside LAND_MOBS.blast of where the feet come down
 * (`touchdown`), or will be when they do: its distance now less what it walks in `ticksLeft` at the speed it closed on
 * the touchdown since the last look (`track`, updated here; a creeper that targets the bot and has not been seen walking
 * yet counts at LAND_MOBS.creeperSpeed). A lit creeper counts with its fuse: inside `blast` it is a threat whatever it
 * does next. Undefined: no creeper will be in its blast range at the touchdown.
 */
export function touchdownThreat(mobs: readonly LandMob[], touchdown: { x: number; y: number; z: number }, ticksLeft: number, tick: number, track: CreeperTrack): TouchdownThreat | undefined {
  let worst: TouchdownThreat | undefined;
  for (const m of mobs) {
    if (m.kind !== 'creeper') continue;
    const d = dist3(m, touchdown);
    const was = track.get(m.id);
    let closing: number;
    if (!was) {
      closing = m.hunting ? LAND_MOBS.creeperSpeed : 0;
      track.set(m.id, { x: m.x, y: m.y, z: m.z, tick, closing });
    } else if (tick - was.tick >= TRACK_TICKS) {
      // (a look every tick: the speed over the last few ticks, not one tick's jitter: a mob's moves come in bursts)
      closing = Math.max(0, (dist3(was, touchdown) - d) / (tick - was.tick));
      track.set(m.id, { x: m.x, y: m.y, z: m.z, tick, closing });
    } else closing = was.closing;
    const atTouchdown = Math.max(0, d - closing * Math.max(0, ticksLeft));
    if (atTouchdown >= LAND_MOBS.blast) continue;
    if (!worst || atTouchdown < worst.atTouchdown) worst = { mob: m, d, atTouchdown, closing };
  }
  for (const id of [...track.keys()]) if (!mobs.some((m) => m.id === id)) track.delete(id);
  return worst;
}

/** `p` is at least `clear` from every creeper known (3D, feet to feet). */
export function clearOfCreepers(p: { x: number; y: number; z: number }, mobs: readonly LandMob[], clear: number): boolean {
  for (const m of mobs) if (m.kind === 'creeper' && dist3(m, p) < clear) return false;
  return true;
}

/**
 * A landing moved away from the creepers: the nearest ground to `from` (the landing given up) that is at least
 * LAND_MOBS.clear from every creeper, else at least `clearMin`, looked for on rings out to `moveWithin` (every 4 blocks
 * out, 16 bearings); `ground(x, z)` is the flight's safe ground (the feet height, undefined: unknown or unsafe). Ground
 * more than 12 over or under the first landing is another place (a roof, a pit). Undefined: none known.
 */
export function clearGround(from: { x: number; z: number; top: number }, mobs: readonly LandMob[], ground: (x: number, z: number) => number | undefined): { x: number; z: number; top: number; clear: number } | undefined {
  for (const clear of [LAND_MOBS.clear, LAND_MOBS.clearMin]) {
    for (let r = 4; r <= LAND_MOBS.moveWithin; r += 4) {
      let best: { x: number; z: number; top: number; clear: number; score: number } | undefined;
      for (let k = 0; k < 16; k++) {
        const a = (k * Math.PI) / 8;
        const x = Math.floor(from.x + Math.cos(a) * r);
        const z = Math.floor(from.z + Math.sin(a) * r);
        const top = ground(x, z);
        if (top === undefined || Math.abs(top - from.top) > 12) continue;
        const p = { x: x + 0.5, y: top, z: z + 0.5 };
        if (!clearOfCreepers(p, mobs, clear)) continue;
        // the farthest from the creepers on this ring (the ring is the walk back; the bearing is free)
        const c = nearestCreeper(mobs, p);
        const score = c ? c.d : Infinity;
        if (!best || score > best.score) best = { x: p.x, z: p.z, top, clear, score };
      }
      if (best) return { x: best.x, z: best.z, top: best.top, clear: best.clear };
    }
  }
  return undefined;
}
