// Track BI (docs/pathfinding.md "Long falls"): what the planner may do with falls deeper than the 3
// harmless blocks, read live before every plan (BotSkills -> Navigator.fallPolicy) and handed to the
// planner (also in the worker: a plain object). Built from the bot's health, absorption, armour
// enchantments, burning flag, nearby hostiles, the water bucket in the hotbar, the dimension and the
// settings (longFalls, fallMargin, clutch, clutchMaxDrop).
import { epfFactor } from './damage.ts';

export interface FallPolicy {
  /**
   * HP one planned fall may cost: health + absorption - margin (the health after the fall stays at or above
   * `fallMargin`). <= 0: no damaging falls. Landings that do no damage (hay from up to 12, honey up to 6,
   * a clutch) need no budget.
   */
  hpBudget: number;
  /** Damage factor of the worn armour's enchantments (damage.ts epfFactor: 1 = none, 0.2 at the cap). */
  factor: number;
  /** Planner ticks per HP lost (a 12-block fall, 8 HP, costs about 90 blocks of walking). */
  hpCost: number;
  /** Deepest fall the planner looks at (blocks below the feet). */
  maxScan: number;
  /** A water bucket is in the hotbar, clutching is on and water works here (not the Nether). */
  clutch: boolean;
  /** Highest fall the planner takes with a clutch (a failed clutch from higher would kill). */
  clutchMax: number;
  /** Planner ticks per clutch on top of the fall (aim, place, land, pick the water up). */
  clutchCost: number;
  /** No planned clutch inside this sphere (home: no water source is ever left there). */
  noWater?: { x: number; y: number; z: number; r: number };
  /** Why damaging falls (and clutches) are off, for the reply when a goto fails ("health 9 with margin 8"). */
  blocked?: string;
  /**
   * Track R4: `blocked` is a reason that passes by itself within seconds (a hostile near, burning, the health not sent
   * yet), or `hostileCap` holds the budget down: the budget the policy gives once it has passed. A goto whose only way
   * is such a fall holds and asks again (nav/navigator.ts `startHold`) instead of ending unreachable. Undefined: the
   * block does not pass by itself (the health is under the margin: it comes back with food, in minutes).
   */
  afterBlock?: number;
  /** Track R4: a hostile is within FALL_HOSTILE_RADIUS and `hostileFallHp` capped the budget to this (not blocked). */
  hostileCap?: number;
  /** Review L1: landing cells (nav/grid.ts cellKey) of drops the step-off check refused lately: not planned. */
  refused?: number[];
}

/** Defaults of the planner-side numbers. */
export const FALL_HP_COST = 40;
export const CLUTCH_COST = 40;
export const FALL_MAX_SCAN = 48;
/** Hostiles within this distance turn damaging falls and clutches off (Track R4: or cap them, `hostileFallHp`). */
export const FALL_HOSTILE_RADIUS = 16;
/**
 * Track R4: with a hostile near and `hostileFallHp` on, a fall must also leave this much above `fallMargin`: the
 * hardest single melee hit measured on the bot (an enderman, 7 a hit: docs/pve.md), so one more hit after the landing
 * still leaves the margin (8 by default, the flee health).
 */
export const HOSTILE_FALL_RESERVE = 7;

/** What the live policy reads. */
export interface FallPolicyInputs {
  /** Long falls are on (setting `longFalls`). */
  enabled: boolean;
  health: number;
  /** The server has sent the health (World.self.healthKnown). */
  healthKnown: boolean;
  absorption: number;
  /** HP to keep after a planned fall (setting `fallMargin`). */
  margin: number;
  /** Enchantment protection factor against falls of the worn armour (damage.ts fallEpf). */
  epf: number;
  burning: boolean;
  /** Distance to the nearest hostile mob (Infinity: none known). */
  hostileDistance: number;
  /** A water bucket is in the hotbar. */
  bucket: boolean;
  /** Clutching is on (setting `clutch`). */
  clutchOn: boolean;
  /** Water works in this dimension (world/dimension.ts waterWorks). */
  waterWorks: boolean;
  /** Setting `clutchMaxDrop`. */
  clutchMax: number;
  /**
   * Track R4, setting `hostileFallHp` (0: off, the rule before): HP a planned fall may cost while a hostile is within
   * FALL_HOSTILE_RADIUS, the health after it at least margin + HOSTILE_FALL_RESERVE; never a clutch then.
   */
  hostileFallHp?: number;
  /** Creative / spectator: no fall damage at all. */
  noDamage?: boolean;
  noWater?: FallPolicy['noWater'];
}

/** The policy for these inputs (undefined: long falls off). */
export function fallPolicy(i: FallPolicyInputs): FallPolicy | undefined {
  if (!i.enabled) return undefined;
  let blocked: string | undefined;
  // Track R4: the three blocks below pass by themselves within seconds (the server sends the health, the fire goes
  // out, the hostile leaves or is struck down): `afterBlock` says what the budget is then
  let passes = false;
  let hostileCap: number | undefined;
  const budget = i.noDamage ? 1000 : i.health + i.absorption - i.margin;
  if (!i.healthKnown) {
    blocked = 'health unknown';
    passes = true;
  } else if (i.burning) {
    blocked = 'on fire';
    passes = true;
  } else if (i.hostileDistance <= FALL_HOSTILE_RADIUS) {
    // Track R4: a fall that costs little against the health at hand stays allowed when `hostileFallHp` says so
    const cap = i.noDamage ? 0 : Math.min(i.hostileFallHp ?? 0, budget - HOSTILE_FALL_RESERVE);
    if (cap > 0) hostileCap = cap;
    else {
      blocked = `a hostile ${Math.round(i.hostileDistance)} blocks away`;
      passes = true;
    }
  }
  if (!blocked && budget <= 0) blocked = `health ${fmtHp(i.health + i.absorption)} with margin ${i.margin}`;
  const clutch = !blocked && hostileCap === undefined && i.clutchOn && i.bucket && i.waterWorks && !i.noDamage;
  return {
    hpBudget: blocked ? 0 : (hostileCap ?? budget),
    factor: epfFactor(i.epf),
    hpCost: FALL_HP_COST,
    maxScan: FALL_MAX_SCAN,
    clutch,
    clutchMax: i.clutchMax,
    clutchCost: CLUTCH_COST,
    ...(i.noWater ? { noWater: i.noWater } : {}),
    ...(blocked ? { blocked } : {}),
    ...(((blocked && passes) || hostileCap !== undefined) && budget > 0 ? { afterBlock: budget } : {}),
    ...(hostileCap !== undefined ? { hostileCap } : {}),
  };
}

/** The planner's half of the clutch rule: the FallGuard will clutch a planned damage drop of `damage` HP (more than half the budget). */
export function clutchHelps(damage: number, p: Pick<FallPolicy, 'hpBudget'>): boolean {
  return damage > Math.max(0, p.hpBudget) / 2 + 1e-9;
}

/** What the reactive clutch weighs (review B4). */
export interface ClutchSituation {
  /** Predicted damage of the fall (HP). */
  damage: number;
  health: number;
  absorption: number;
  /** Setting `fallMargin`. */
  margin: number;
  /** Creative / spectator. */
  noDamage?: boolean;
  /** The landing is inside the base (home's protectRadius). */
  inBase?: boolean;
  /** A fight runs or a mob hurt the bot in the last seconds (the weapon stays in hand). */
  inCombat?: boolean;
}

/**
 * Clutch this fall? Only when it matters: the fall would kill, leave less than `fallMargin`, or cost more than
 * half of what is above the margin (health + absorption - margin). Never in creative / spectator; inside the
 * base and in a fight only when the fall would kill. `reason` says why not.
 */
export function shouldClutch(s: ClutchSituation): { yes: boolean; reason?: string } {
  if (s.noDamage) return { yes: false, reason: 'no fall damage in this game mode' };
  const kills = s.damage >= s.health + s.absorption - 1e-9;
  if (s.inBase && !kills) return { yes: false, reason: 'inside the base (only a fall that would kill)' };
  if (s.inCombat && !kills) return { yes: false, reason: 'in a fight (only a fall that would kill)' };
  const above = Math.max(0, s.health + s.absorption - s.margin);
  if (kills || s.damage > above / 2 + 1e-9) return { yes: true };
  return { yes: false, reason: `${fmtHp(+s.damage.toFixed(1))} HP leaves enough above the margin` };
}

function fmtHp(h: number): string {
  return Number.isInteger(h) ? String(h) : h.toFixed(1);
}
