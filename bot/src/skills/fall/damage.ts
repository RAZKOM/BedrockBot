// Track BH (docs/movement.md "Falls"): the Bedrock fall damage model, measured on BDS 1.26.60.6
// (bds-gaunt, truth:hurtlog, 2026-10-30; test/e2e/fall-damage.test.ts):
//
//   counted   the fall distance the server counts is the drop up to the tick BEFORE the landing tick:
//             the landing tick's clipped move is not part of it. A body falling from rest (walking off
//             an edge, a teleport) is at D(t) = sum of (v - 0.08) x 0.98 after t ticks; it lands on the
//             first tick with D(t) >= h, and the server counts D(t - 1).
//   base      ceil(counted x landing - 3): 4 blocks -> 1, 5 -> 2, 11 -> 8, 12 -> 8 (D(17) = 10.81, the
//             18th tick reaches 12.002), 13 -> 10, 20 -> 16, 22 -> 19 (each height twice, identical).
//   landing   a factor on the counted distance (not on the damage): hay_block 0.2 (22 blocks -> 2),
//             honey_block 0.5 (12 -> 3, 22 -> 8), a bed 0.5 (plus a bounce: 22 -> 8 + 1), slime, water
//             (any depth, also a waterlogged bottom slab) and powder snow 0. Leaves, slabs and the
//             other floors 1. Cobwebs and scaffolding were 0 or the full damage depending on whether
//             the body's tick ends inside them: counted as 1 here.
//   armour    no reduction from armour points; enchantments: EPF = 3 x Feather Falling (boots) + the
//             Protection levels of every worn piece, capped at 20; damage x (1 - 0.04 x EPF): FF IV
//             0.52, FF I 0.88, Protection IV boots 0.84, FF IV + P IV 0.36, FF IV + 4 x P IV 0.2 (cap).
//             The damage is then fractional (health is a float: 20 - 2.6 = 17.4).
//
// Health after the fall = health + absorption - damage (absorption takes the damage first).
import { PHYSICS } from '../input/physics.ts';

/** Fall distance that does no damage (Bedrock and Java). */
export const SAFE_FALL = 3;
/** Enchantment protection factor cap and the reduction per point. */
export const EPF_CAP = 20;
export const EPF_STEP = 0.04;
/** Bedrock enchantment ids (item NBT `ench[].id`): protection 0, feather falling 2 (verified on BDS 1.26.60). */
export const ENCH_PROTECTION = 0;
export const ENCH_FEATHER_FALLING = 2;

/** D(t): blocks fallen from rest after t ticks (t = 0..400). */
const FALLEN: readonly number[] = (() => {
  const out = [0];
  let y = 0;
  let v = 0;
  for (let t = 1; t <= 400; t++) {
    v = (v - PHYSICS.gravity) * PHYSICS.drag;
    y += v;
    out.push(-y);
  }
  return out;
})();

/** Landing tolerance: the 18th tick of a fall reaches 12.0017 and lands on a floor 12 below (measured). */
const LAND_EPS = 1e-3;

/**
 * The fall distance the server counts for a drop of `height` blocks from rest: D(t - 1) of the landing
 * tick t (the first with D(t) >= height). 0 for heights <= 0.
 */
export function countedFall(height: number): number {
  if (height <= 0) return 0;
  for (let t = 1; t < FALLEN.length; t++) if (FALLEN[t]! >= height - LAND_EPS) return FALLEN[t - 1]!;
  return height;
}

/** Ticks until a body falling from rest lands `height` blocks lower. */
export function landingTick(height: number): number {
  if (height <= 0) return 0;
  for (let t = 1; t < FALLEN.length; t++) if (FALLEN[t]! >= height - LAND_EPS) return t;
  return Infinity;
}

/** Factor on the counted fall distance for landing on (or in) the block `name` (without namespace). */
export function landingFactor(name: string | undefined): number {
  if (name === undefined) return 1;
  const n = name.startsWith('minecraft:') ? name.slice(10) : name;
  if (n === 'water' || n === 'flowing_water' || n === 'bubble_column' || n === 'slime' || n === 'powder_snow') return 0;
  if (n === 'hay_block') return 0.2;
  if (n === 'honey_block' || n === 'bed' || n.endsWith('_bed')) return 0.5;
  return 1;
}

/** Damage factor of an enchantment protection factor (1 = none, 0.2 at the cap). */
export function epfFactor(epf: number): number {
  return 1 - Math.min(EPF_CAP, Math.max(0, epf)) * EPF_STEP;
}

/** Damage (HP, may be fractional with enchantments) for a counted fall distance. */
export function damageForCounted(counted: number, landing = 1, factor = 1): number {
  const base = Math.max(0, Math.ceil(counted * landing - SAFE_FALL - 1e-6));
  return base * factor;
}

/**
 * Damage (HP) of a drop of `height` blocks from rest onto `landingName` with damage factor `factor`
 * (epfFactor of the worn armour).
 */
export function fallDamage(height: number, landingName?: string, factor = 1): number {
  return damageForCounted(countedFall(height), landingFactor(landingName), factor);
}

/** The highest drop (whole blocks, from rest, factor-1 floor) whose damage stays within `hp`. */
export function maxDropFor(hp: number, factor = 1): number {
  let h = SAFE_FALL;
  while (h < 400 && fallDamage(h + 1, undefined, factor) <= hp + 1e-9) h++;
  return h;
}

/** An enchantment of an item (NBT `ench`; world/inventory.ts itemEnchants reads it into ItemStack.enchants). */
export interface Enchant {
  id: number;
  lvl: number;
}

/** EPF against falls of the worn armour (window 120: head, chest, legs, feet). */
export function fallEpf(worn: readonly ({ name: string; enchants?: readonly Enchant[] | undefined } | null | undefined)[]): number {
  let epf = 0;
  worn.forEach((it, slot) => {
    for (const e of it?.enchants ?? []) {
      if (e.id === ENCH_PROTECTION) epf += e.lvl;
      else if (e.id === ENCH_FEATHER_FALLING && slot === 3) epf += 3 * e.lvl;
    }
  });
  return Math.min(EPF_CAP, epf);
}
