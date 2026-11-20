// The obtain job at dusk (Track E7, docs/early-game.md "Dusk", ADR 0104). On five fresh worlds a `!get kit iron` that
// ran into the evening died there 6 times (every one an arrow): with a shelter set the night rule took the bot there and
// held it with the step paused, and the step's 10-minute limit then ended the job in the night anyway. With `jobDusk` on,
// a step that walks or waits (a mine, a gather, a hunt, the food step, a smelt, a cook, a walk to a herd) is ended when
// the night task's own dusk comes (NightSafety's DUSK), the job keeps its targets, steps and notes, the bot goes where it
// spends the night (shelterPlan), and at dawn the job goes on by itself:
//
//   get kit iron: paused for the night at step 6 (mine iron_ore 33: 15 of 33), at the shelter 10 64 3; resuming at dawn
//   get kit iron: dawn: going on (paused at !mine iron_ore 33)
//
// Crafts, the furnace and the bed are short and run on (a bed set down is where the night is slept). A job started by
// night pauses at the next dusk only. A smelt stopped at dusk leaves its input in the furnace, which smelts on; at dawn
// the job takes the output first (the Track E4 collect) and then plans. With nowhere to spend the night (no shelter, no
// home, no bed, no roofed spot near, and no night shell to build) the job works on as before.
//
// Track E7 also keeps the shell's blocks (`shellBlocks`, skills/survival/shell-blocks.ts): from REFILL_LEAD ticks before
// dusk a job short of them ends its step and digs them, and a job that ends short digs them before its end line.
import type { Vec3 } from '../connection/types.ts';
import { isNight, timeOfDay } from '../tasks/night.ts';
import type { Process } from '../tasks/process/manager.ts';
import type { RefillResult } from '../skills/survival/shell-blocks.ts';
import type { ObtainAction } from '../skills/items/obtain.ts';

/** The step kinds a dusk ends (they walk off or stand and wait); crafts, the furnace and the bed run on. */
export const DUSK_STOPS: ReadonlySet<string> = new Set(['gather', 'mine', 'hunt', 'food', 'smelt', 'cook', 'goto']);
/** Track E7: from this many ticks before dusk a job short of the shell's blocks digs them (60 s). */
export const REFILL_LEAD = 1200;
/** Poll while paused for the night (ms). */
export const NIGHT_POLL_MS = 1000;

/** What the dusk rule needs from the bot (chat/commands-kit.ts wires it). */
export interface ObtainNight {
  /** The `jobDusk` setting. */
  enabled(): boolean;
  /** The world time (ticks), undefined while unknown. */
  time(): number | undefined;
  /** The night task's window (NightSafety's dusk and dawn). */
  readonly dusk: number;
  readonly dawn: number;
  /** Where the bot would spend the night now (shelterPlan); changes nothing. */
  plan(): ShelterPlan;
  /** Take that plan: sets the night rule's shelter for tonight when the plan names one. */
  enter(plan: ShelterPlan): void;
  /** The night rule gave the walk to its shelter up for tonight (unreachable). */
  gaveUp(): boolean;
  /** The plan from where the bot stands now, the shelter and home left out (after gaveUp). */
  fallback(): ShelterPlan;
  /** Dawn: the night rule's shelter back as the owner left it. */
  release(): void;
  /** The night process wants the bot (on the way, inside, asleep, its shell still shut). */
  busy(): boolean;
}

/** Track E7: the shell's blocks (`shellBlocks`). */
export interface ObtainBlocks {
  enabled(): boolean;
  /** Blocks the shell is short of now. */
  short(): number;
  /** Dig them (the `blocks` user process). */
  refill(): { process?: Process; result: Promise<RefillResult | undefined> };
}

/** Is it the night task's night (DUSK to DAWN)? Unknown time: no. */
export function nightNow(n: Pick<ObtainNight, 'time' | 'dusk' | 'dawn'>): boolean {
  const t = n.time();
  return t !== undefined && isNight(t, n.dusk, n.dawn);
}

/** The refill window: REFILL_LEAD ticks before dusk, up to dusk. */
export function beforeDusk(n: Pick<ObtainNight, 'time' | 'dusk'>, lead = REFILL_LEAD): boolean {
  const t = n.time();
  if (t === undefined) return false;
  const tod = timeOfDay(t);
  const from = (((n.dusk - lead) % 24000) + 24000) % 24000;
  return from <= n.dusk ? tod >= from && tod < n.dusk : tod >= from || tod < n.dusk;
}

/** `15 of 33`: how far the step came, by the item it was for (`gained` items otherwise). */
export function stepProgress(a: ObtainAction, before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>, gained: number): string {
  if (a.kind === 'mine' || a.kind === 'hunt' || a.kind === 'smelt') {
    const item = a.kind === 'smelt' ? a.input : a.item;
    if (a.kind === 'smelt') return `${Math.max(0, (before.get(item) ?? 0) - (after.get(item) ?? 0))} of ${a.n} in the furnace`;
    return `${Math.max(0, (after.get(item) ?? 0) - (before.get(item) ?? 0))} of ${a.n}`;
  }
  if (a.kind === 'gather' || a.kind === 'food' || a.kind === 'cook') return `${gained} of ${a.n}`;
  return `${gained} item${gained === 1 ? '' : 's'}`;
}

/** The night shelter's plan (shelterPlan's inputs). */
export interface ShelterInputs {
  /** A bed where the night rule sleeps. */
  bed: Vec3 | undefined;
  shelter: Vec3 | undefined;
  home: Vec3 | undefined;
  feet: Vec3 | undefined;
  /** The night shell would wall in tonight (`nightShell` on and its blocks carried). */
  shellOn: boolean;
  /** Is the sky open over this feet cell (night-shell.ts underOpenSky)? */
  openSky(p: Vec3): boolean;
  /** The nearest enclosed spot the body can walk to from this point (night-shell.ts enclosedSpot), if any. */
  enclosed(near: Vec3): Vec3 | undefined;
}

export interface ShelterPlan {
  /** `none`: nowhere to spend the night (the job works on). */
  kind: 'bed' | 'shelter' | 'home' | 'enclosed' | 'here' | 'none';
  /** The night rule's shelter for tonight (with a bed: where it stands if the bed is refused); undefined: leave it as it is. */
  set: Vec3 | undefined;
  /** For the pause line. */
  text: string;
}

const fmt = (p: Vec3): string => `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`;

/**
 * Where a job's night is spent, for any world: a bed where the night rule sleeps; else the shelter, or home when no
 * shelter is set (the night shell walls in there when `nightShell` is on and the sky is open over it: the night rule's
 * own doing). With neither a shelter nor a home: the nearest enclosed spot the bot can walk to (a roof and the cells
 * round the body solid but for one side); else where it stands when the shell walls in there (the open sky over it);
 * else nowhere (`none`: standing still all night in the open or in a cave is no safer than working on).
 */
export function shelterPlan(i: ShelterInputs): ShelterPlan {
  const stand = standPlan(i);
  // a bed: the night rule sleeps there; the shelter below is where it stands when the bed is refused (monsters near)
  if (i.bed) return { kind: 'bed', set: stand.kind === 'none' ? undefined : stand.set, text: `in the bed at ${fmt(i.bed)}` };
  return stand;
}

function standPlan(i: ShelterInputs): ShelterPlan {
  if (i.shelter) return { kind: 'shelter', set: undefined, text: `at the shelter ${fmt(i.shelter)}` };
  if (i.home) return { kind: 'home', set: i.home, text: `at home ${fmt(i.home)}` };
  return herePlan(i);
}

/** The plan from where the bot stands (no shelter, no home, or neither reachable tonight). */
export function herePlan(i: Pick<ShelterInputs, 'feet' | 'shellOn' | 'openSky' | 'enclosed'>): ShelterPlan {
  const near = i.feet;
  if (!near) return { kind: 'none', set: undefined, text: 'nowhere to shelter (position unknown)' };
  const e = i.enclosed(near);
  if (e) return { kind: 'enclosed', set: e, text: `in the roofed spot at ${fmt(e)}` };
  const cell = { x: Math.floor(near.x), y: Math.floor(near.y + 1e-3), z: Math.floor(near.z) };
  if (i.shellOn && i.openSky(cell)) return { kind: 'here', set: cell, text: `walled in where it stands (${fmt(cell)})` };
  return { kind: 'none', set: undefined, text: 'nowhere to shelter (no shelter, home or bed, no roofed spot near, no night shell)' };
}
