// Track BH (docs/pathfinding.md "Long falls"): what the planner may do with falls deeper than the 3
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
}

/** Defaults of the planner-side numbers. */
export const FALL_HP_COST = 40;
export const CLUTCH_COST = 40;
export const FALL_MAX_SCAN = 48;
/** Hostiles within this distance turn damaging falls and clutches off. */
export const FALL_HOSTILE_RADIUS = 16;

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
  /** Creative / spectator: no fall damage at all. */
  noDamage?: boolean;
  noWater?: FallPolicy['noWater'];
}

/** The policy for these inputs (undefined: long falls off). */
export function fallPolicy(i: FallPolicyInputs): FallPolicy | undefined {
  if (!i.enabled) return undefined;
  let blocked: string | undefined;
  if (!i.healthKnown) blocked = 'health unknown';
  else if (i.burning) blocked = 'on fire';
  else if (i.hostileDistance <= FALL_HOSTILE_RADIUS) blocked = `a hostile ${Math.round(i.hostileDistance)} blocks away`;
  const budget = i.noDamage ? 1000 : i.health + i.absorption - i.margin;
  if (!blocked && budget <= 0) blocked = `health ${fmtHp(i.health + i.absorption)} with margin ${i.margin}`;
  const clutch = !blocked && i.clutchOn && i.bucket && i.waterWorks && !i.noDamage;
  return {
    hpBudget: blocked ? 0 : budget,
    factor: epfFactor(i.epf),
    hpCost: FALL_HP_COST,
    maxScan: FALL_MAX_SCAN,
    clutch,
    clutchMax: i.clutchMax,
    clutchCost: CLUTCH_COST,
    ...(i.noWater ? { noWater: i.noWater } : {}),
    ...(blocked ? { blocked } : {}),
  };
}

function fmtHp(h: number): string {
  return Number.isInteger(h) ? String(h) : h.toFixed(1);
}
