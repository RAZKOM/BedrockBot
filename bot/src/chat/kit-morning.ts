// The morning after a job's night (Track E9, docs/early-game.md "The way home and the morning after", ADR 0111).
// Track E7's job goes on at the night rule's dawn (23000), when nothing burns yet: on open ground a zombie or a
// skeleton takes its first fire damage between 23446 and 23640 and is gone 400 to 600 ticks later (measured, six
// summoned on a plain: four burned down, one walked into a cave, one never caught fire). Bots that left their
// shelter in that first minute met the night as it was: one left its shell 13 s after dawn into two creepers, three
// skeletons and a zombie, one walked 77 blocks to its mine and was shot there by skeletons at full health, one left
// when the shell's 90 s were over with a witch still 4 blocks off. With `jobMorning` on, a job that waited out the
// night goes on only once the morning is clear (morningBlock), and the night rule keeps the bot in its shelter until
// then (NightSafety.hold):
//
//   get kit iron: morning: waiting (the sun is not up)
//   get kit iron: dawn: going on after 53 s (paused at !mine iron_ore 33)
//
// The rule waits and nothing else: it places and digs nothing and changes no fight rule. What comes at the bot while
// it waits, and on the walk back out, is met by the flee and reflex rules as they are (docs/pve.md).
import { timeOfDay } from '../tasks/night.ts';

/**
 * The undead burn from here (time of day): the end of the sleep window (skills/survival/sleep.ts: a bed is refused
 * from 23460), 460 ticks after the night rule's dawn. Measured: the first fire damage at 23446 to 23640.
 */
export const MORNING_SUN = 23460;
/** Ticks until the ones that burn are gone (measured: the last at 39 of the day, 579 after MORNING_SUN): open ground is clear of them at MORNING_SUN + this. */
export const MORNING_BURN = 600;
/** A hostile this near holds the job past that (a creeper, a witch, a spider, a husk, a zombie in the shade): the night shell's own dawn radius. */
export const MORNING_NEAR = 16;
/**
 * The longest wait, in ticks from the night rule's dawn: 3000 takes the clock to 2000 (150 s). A mob that stays near
 * longer than that (a witch at a shell it cannot see into, a zombie in the shade) does not leave by itself, and the
 * day is 12000 ticks.
 */
export const MORNING_MAX = 3000;
/** The log's census at dawn and when the job goes on looks this far (blocks). */
export const MORNING_CENSUS = 32;
/** A hurt animation by fire this fresh (ms) says the mob burns (hostiles.ts MobState.lastHurtData 7: one a second while it does). */
export const BURNING_MS = 2500;

// ---- Track E11 (`morningWay`, off): the walk back out after the night ------------------------------------------------
// What does not burn (a creeper, a spider, a witch, a husk) or stands in shade is still 16 to 32 blocks off when the job
// goes on, and the step's first walk goes straight through that ring to the mine (Track E9: 31 to 135 blocks). The
// navigator already prices cells near a hostile (skills/nav/avoidance.ts, `avoidMobRadius`, 4 by default: melee reach
// and a margin); for the first MORNING_WAY_MS after a night the job's plans price them out to MORNING_WAY_RADIUS
// instead, so a way that keeps 16 from what stands near is taken when one exists. Nothing else changes: no fight rule,
// no flee rule, the zones stay passable (a goal inside one is still reached), and what follows the bot still follows.

/** The avoidance radius of the walk out (blocks): an archer's and a witch's reach, the morning rule's own MORNING_NEAR. */
export const MORNING_WAY_RADIUS = 16;
/** How long the walk out keeps it (ms): the window Track E9 counted the morning's damage in. */
export const MORNING_WAY_MS = 120_000;

/**
 * Track E11: the radius the walk out plans with, or undefined when the rule does not apply: off, or the owner's own
 * radius already as wide. Not tied to what is near when the job goes on: a plan prices the hostiles known when it is
 * made, and the first fresh-world morning measured was ended by two skeletons 90 blocks out, in no census at the shelter.
 */
export function morningWayRadius(i: { on: boolean; base: number }): number | undefined {
  if (!i.on) return undefined;
  return i.base >= MORNING_WAY_RADIUS ? undefined : MORNING_WAY_RADIUS;
}

/** A hostile as the rule sees it. */
export interface MorningMob {
  /** The bare type (`creeper`). */
  type: string;
  /** Blocks from the bot's feet. */
  dist: number;
  /** It burns now (the sun has it): said in the census. It holds the job like any other while it lives. */
  burning: boolean;
}

/** Ticks since the night rule's dawn (0 at `dawn`, 1000 at the day's start for a dawn of 23000). */
export function ticksSinceDawn(time: number, dawn: number): number {
  return (((timeOfDay(time) - dawn) % 24000) + 24000) % 24000;
}

/**
 * Why a job that waited out the night does not go on yet, in words; undefined: it goes on.
 *  - before MORNING_SUN the sun is not up and nothing burns; for MORNING_BURN ticks after it the undead are burning;
 *  - after that, a live hostile within MORNING_NEAR: named with its distance;
 *  - never past MORNING_MAX ticks after dawn, and never by night or with the time unknown (the night is the dusk rule's).
 */
export function morningBlock(i: { time: number | undefined; dawn: number; dusk: number; mobs: readonly MorningMob[] }): string | undefined {
  if (i.time === undefined) return undefined;
  const since = ticksSinceDawn(i.time, i.dawn);
  if (since >= MORNING_MAX) return undefined;
  const sun = ticksSinceDawn(MORNING_SUN, i.dawn);
  if (since < sun) return 'the sun is not up';
  if (since < sun + MORNING_BURN) return 'the undead are burning';
  const near = nearestHolding(i.mobs);
  return near ? `${article(near.type)} ${near.type} ${Math.round(near.dist)} blocks off` : undefined;
}

/** The nearest hostile within MORNING_NEAR. */
export function nearestHolding(mobs: readonly MorningMob[]): MorningMob | undefined {
  let best: MorningMob | undefined;
  for (const m of mobs) {
    if (m.dist > MORNING_NEAR) continue;
    if (!best || m.dist < best.dist) best = m;
  }
  return best;
}

const article = (word: string): string => (/^[aeiou]/.test(word) ? 'an' : 'a');

/** The hostiles near in a few words, nearest first, for the log: `creeper 9, zombie 14 (burning), skeleton 21`; `none`. */
export function censusText(mobs: readonly MorningMob[], max = 8): string {
  if (mobs.length === 0) return 'none';
  const sorted = [...mobs].sort((a, b) => a.dist - b.dist);
  const head = sorted.slice(0, max).map((m) => `${m.type} ${Math.round(m.dist)}${m.burning ? ' (burning)' : ''}`);
  return head.join(', ') + (sorted.length > max ? `, ${sorted.length - max} more` : '');
}
