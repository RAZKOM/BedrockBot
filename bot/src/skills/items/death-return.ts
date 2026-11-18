// Track E4 (docs/early-game.md "Wear and setbacks", ADR 0101): after a death in an obtain job, whether to walk back to
// the death spot for the drops, and what came back. Pure: the death, the respawn and the clock in, the answer out.
//
// Behind `deathReturn` (default off: it walks back into where the bot died). The rules, all of them:
//   - the spot is known (the last feet position before the death) and not in the void (under y -64);
//   - the cause did not burn the drops (lava, fire) or drop them out of the world;
//   - by day, with a minute of daylight left at least (the night rule would take the bot to its shelter);
//   - within DEATH_RETURN_RANGE of where the bot respawned (blocks, horizontally);
//   - the drops are still there when it arrives: items despawn 5 minutes after they fall (in loaded chunks), so the
//     walk (at DEATH_RETURN_SPEED blocks a second, plus the collect) must fit in what is left of that;
//   - at most DEATH_RETURN_MAX returns a job (a death on the way back, or a second death in the same place, ends it).
// The walk is the normal nav (its lava, fall and protect rules), a user process: the flee and a guard fight pre-empt
// it as any command. Nothing here loosens a survival rule.
import type { ItemStack, Vec3 } from '../../world/types.ts';
import { isNight } from '../../tasks/night.ts';

/** Items on the ground despawn this long after they fell (ms; 6000 ticks). */
export const DROP_DESPAWN_MS = 300_000;
/** The death spot is walked back to within this many blocks (horizontal) of the respawn point. */
export const DEATH_RETURN_RANGE = 160;
/** Blocks a second the walk-back estimate uses (a walk with turns and climbs, under the sprint's 5.6). */
export const DEATH_RETURN_SPEED = 3;
/** Ms the collect at the spot is given (in the despawn budget). */
export const DEATH_COLLECT_MS = 20_000;
/** Returns a job makes at most. */
export const DEATH_RETURN_MAX = 2;
/** Daylight that must be left (ticks) when the walk starts. */
export const DEATH_RETURN_DAYLIGHT = 1200;
/** Items within this many blocks of the spot are collected. */
export const DEATH_COLLECT_RADIUS = 8;

/** Causes whose drops are gone (Bedrock `death_info.cause` keys). */
const LOST = /lava|fire|onfire|infire|outofworld|void|magma/i;

export interface DeathReturnInput {
  /** The death spot (DeathRecord.at). */
  at: Vec3 | undefined;
  /** DeathRecord.cause. */
  cause: string;
  /** Where the bot respawned. */
  feet: Vec3;
  /** Ms since the death. */
  sinceMs: number;
  /** The world clock (undefined: unknown, counts as day). */
  time: number | undefined;
  /** Returns this job made already. */
  returns: number;
}

export type DeathReturnPlan = { go: true; distance: number; walkTicks: number; collectTicks: number } | { go: false; why: string };

/** Whether to walk back for the drops, and with what budget. */
export function deathReturnPlan(i: DeathReturnInput): DeathReturnPlan {
  if (i.returns >= DEATH_RETURN_MAX) return { go: false, why: `${i.returns} returns in this job already` };
  const at = i.at;
  if (!at) return { go: false, why: 'the death spot is not known' };
  if (at.y < -64) return { go: false, why: 'it died in the void' };
  if (LOST.test(i.cause)) return { go: false, why: `the drops are gone (${i.cause.replace(/^death\.attack\./, '')})` };
  if (i.time !== undefined && (isNight(i.time) || isNight(i.time + DEATH_RETURN_DAYLIGHT))) return { go: false, why: 'it is night or near dusk (deathReturn walks back by day only)' };
  const distance = Math.hypot(at.x - i.feet.x, at.z - i.feet.z);
  if (distance > DEATH_RETURN_RANGE) return { go: false, why: `the death spot is ${Math.round(distance)} blocks away (deathReturn walks back within ${DEATH_RETURN_RANGE})` };
  const left = DROP_DESPAWN_MS - i.sinceMs - DEATH_COLLECT_MS;
  const walkMs = (distance / DEATH_RETURN_SPEED) * 1000;
  if (walkMs > left) return { go: false, why: `the drops despawn before I get there (${Math.round(distance)} blocks, ${Math.max(0, Math.round((DROP_DESPAWN_MS - i.sinceMs) / 1000))} s left)` };
  // the walk may take what is left of the despawn time (a slow way still finds the drops), at least 30 s
  const walkTicks = Math.max(600, Math.floor(left / 50));
  return { go: true, distance, walkTicks, collectTicks: Math.floor(DEATH_COLLECT_MS / 50) };
}

/**
 * Stacks recovered: each stack the bot had at the death (main inventory, armour, offhand) counts when what is carried
 * now (the same places) still holds that many of its item after the stacks before it took theirs. `of`: stacks then.
 */
export function stacksRecovered(then: readonly (ItemStack | null | undefined)[], now: readonly (ItemStack | null | undefined)[]): { got: number; of: number; lost: Record<string, number> } {
  const pool = new Map<string, number>();
  for (const s of now) if (s && s.count > 0) pool.set(s.name, (pool.get(s.name) ?? 0) + s.count);
  let got = 0;
  let of = 0;
  const lost: Record<string, number> = {};
  for (const s of then) {
    if (!s || s.count <= 0) continue;
    of++;
    const have = pool.get(s.name) ?? 0;
    if (have >= s.count) {
      got++;
      pool.set(s.name, have - s.count);
    } else {
      pool.set(s.name, 0);
      lost[s.name] = (lost[s.name] ?? 0) + s.count - have;
    }
  }
  return { got, of, lost };
}
