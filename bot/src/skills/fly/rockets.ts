// Track R9 (ADR 0097, docs/flight.md "Rockets on hand"): rockets on hand. The bot flies on firework rockets and refills
// its hotbar from the fireworks box (`fireworksMin`); when the box ran dry every trip was walked. A crafted rocket is
// cheap: 1 paper and 1 gunpowder make 3 in the inventory's 2 x 2 grid; 3 sugar cane make 3 paper at a crafting table.
// Pure rules:
//
//   rocketRecipe    the duration choice: of the server's firework_rocket recipes, the one of 1 paper and ROCKET_FLIGHT (1)
//                   gunpowder with no firework star (BDS 1.26.60 sends exactly one such recipe, paper_sulphur_recipeId,
//                   whose output's NBT is `Fireworks {Explosions: [], Flight: 1}`; flight durations 2 and 3 are only in the
//                   game's multi recipes, which the recipe index does not keep). Measured (bds-fly2 / bds-fly3, 400 blocks
//                   flat, 3 a side): a crafted rocket climbs as far as two of the script API's plain ones.
//   rocketCounts    the rockets in every carried place: loose (hotbar and main slots), the fireworks box, the other
//                   carried boxes (the flight takes those out before a takeoff), never counted twice
//   planRockets     the stock rule: the rockets missing to `fireworksKeep`, the cheapest source first: rockets out of the
//                   chests at home (at home only), then crafts: gunpowder and paper loose, out of the carried boxes, out of
//                   the home chests (at home); paper made from sugar cane only when there is not enough paper and a
//                   crafting table is carried or near. Gunpowder is never farmed: with none anywhere the plan says so.
//   materialsReserve what the unloader keeps of the materials: one craft round to `fireworksKeep` from nothing
//                   (ceil(keep / 3) paper and gunpowder; sugar cane for the paper that is not carried)
import type { Recipe } from '../craft/recipes.ts';

export const ROCKET = 'firework_rocket';
export const PAPER = 'paper';
export const GUNPOWDER = 'gunpowder';
export const CANE = 'sugar_cane';
/** Rockets one craft makes (1 paper + 1 gunpowder). */
export const ROCKETS_PER_CRAFT = 3;
/** Paper one craft makes (3 sugar cane in a row, at a crafting table). */
export const PAPER_PER_CRAFT = 3;
/** The flight duration crafted (gunpowder a rocket): see the file comment. */
export const ROCKET_FLIGHT = 1;
/** Default `fireworksKeep`: one stack in every carried place together. */
export const DEFAULT_FIREWORKS_KEEP = 64;

const bare = (n: string): string => (n.startsWith('minecraft:') ? n.slice(10) : n);

/** The flight duration a firework_rocket recipe makes: its output's NBT, else the gunpowder it takes. */
export function recipeFlight(r: Pick<Recipe, 'input' | 'output'>): number {
  const f = r.output[0]?.flight;
  if (typeof f === 'number') return f;
  return r.input.reduce((a, i) => a + (i?.name !== undefined && bare(i.name) === GUNPOWDER ? i.count : 0), 0);
}

/** A firework_rocket recipe of paper and gunpowder only (no firework star), one paper. */
export function isPlainRocketRecipe(r: Pick<Recipe, 'input' | 'output'>): boolean {
  if (bare(r.output[0]?.name ?? '') !== ROCKET) return false;
  let paper = 0;
  let powder = 0;
  for (const i of r.input) {
    if (!i) continue;
    if (i.name === undefined) return false;
    const n = bare(i.name);
    if (n === PAPER) paper += i.count;
    else if (n === GUNPOWDER) powder += i.count;
    else return false;
  }
  return paper === 1 && powder >= 1;
}

/** The duration choice (see the file comment): the plain rocket recipe of `flight` gunpowder, the lowest priority first. */
export function rocketRecipe<R extends Pick<Recipe, 'input' | 'output' | 'priority'>>(recipes: readonly R[], flight = ROCKET_FLIGHT): R | undefined {
  return recipes.filter((r) => isPlainRocketRecipe(r) && recipeFlight(r) === flight).sort((a, b) => a.priority - b.priority)[0];
}

/** The rockets in every carried place (see the file comment). */
export interface RocketCounts {
  /** Hotbar and main slots (0..35). */
  loose: number;
  /** Inside the fireworks box. */
  box: number;
  /** Inside the other carried boxes. */
  boxed: number;
  total: number;
}

export function rocketCounts(loose: number, box: number, boxed: number): RocketCounts {
  const l = Math.max(0, loose);
  const b = Math.max(0, box);
  const o = Math.max(0, boxed);
  return { loose: l, box: b, boxed: o, total: l + b + o };
}

/** Loose counts of the materials in slots 0..35. */
export function materialCounts(slots: readonly ({ name: string; count: number } | null | undefined)[]): { paper: number; gunpowder: number; cane: number; rockets: number } {
  const out = { paper: 0, gunpowder: 0, cane: 0, rockets: 0 };
  for (let i = 0; i < Math.min(36, slots.length); i++) {
    const s = slots[i];
    if (!s || s.count <= 0) continue;
    const n = bare(s.name);
    if (n === PAPER) out.paper += s.count;
    else if (n === GUNPOWDER) out.gunpowder += s.count;
    else if (n === CANE) out.cane += s.count;
    else if (n === ROCKET) out.rockets += s.count;
  }
  return out;
}

/** One material's counts by place. */
export interface Stock {
  loose: number;
  /** In the carried boxes (Supply.carried). */
  boxed: number;
  /** In the chests at home (the chest memory). */
  home: number;
}

/** What the stock rule reads. */
export interface RocketStockInput {
  /** `fireworksKeep` (or `!rockets n`). */
  keep: number;
  rockets: RocketCounts;
  /** Rockets in the chests at home. */
  homeRockets: number;
  paper: Stock;
  gunpowder: Stock;
  cane: Stock;
  /** Within reach of the home chests (HomeLogistics.atHome): the chests are a source only then. */
  atHome: boolean;
  /** A crafting table carried or near (the crafter's scan box): paper from sugar cane needs one. */
  table: boolean;
  /** The server's rocket recipe is known (rocketRecipe). */
  recipe: boolean;
}

export type RocketItem = typeof ROCKET | typeof PAPER | typeof GUNPOWDER | typeof CANE;

export type RocketStep =
  | { kind: 'boxes'; item: RocketItem; n: number }
  | { kind: 'home'; item: RocketItem; n: number }
  /** Paper made from sugar cane at a table (a multiple of 3). */
  | { kind: 'paper'; n: number }
  /** Rockets crafted (a multiple of 3). */
  | { kind: 'craft'; n: number };

export interface RocketPlan {
  /** Rockets carried now (every place) and the rockets missing to `keep`. */
  have: number;
  want: number;
  /** Crafts the plan makes (3 rockets each). */
  crafts: number;
  steps: RocketStep[];
  /** What stands in the way of `keep` (`!status`, `!rockets status`, the reply). */
  short?: string;
  /** The materials missing for the rest, by name (`gunpowder`, `paper`, `crafting table`). */
  missing: string[];
}

/** Take n of a material from where it is (loose first, then the carried boxes, then home when allowed). */
function takeSteps(item: RocketItem, n: number, s: Stock, home: boolean): RocketStep[] {
  const out: RocketStep[] = [];
  let need = Math.max(0, n - s.loose);
  const b = Math.min(need, s.boxed);
  if (b > 0) {
    out.push({ kind: 'boxes', item, n: b });
    need -= b;
  }
  const h = home ? Math.min(need, s.home) : 0;
  if (h > 0) out.push({ kind: 'home', item, n: h });
  return out;
}

const avail = (s: Stock, home: boolean): number => s.loose + s.boxed + (home ? s.home : 0);

/**
 * The stock rule (see the file comment). `home`: the chests at home may be used (the chore and `!rockets` at home); the
 * trip readiness passes false (only what is carried: loose and in the carried boxes).
 */
export function planRockets(i: RocketStockInput, o: { home: boolean }): RocketPlan {
  const have = i.rockets.total;
  const want = Math.max(0, Math.floor(i.keep) - have);
  const plan: RocketPlan = { have, want, crafts: 0, steps: [], missing: [] };
  if (want <= 0) return plan;
  const home = o.home && i.atHome;
  let need = want;
  const fromHome = home ? Math.min(need, i.homeRockets) : 0;
  if (fromHome > 0) {
    plan.steps.push({ kind: 'home', item: ROCKET, n: fromHome });
    need -= fromHome;
  }
  if (need <= 0) return plan;
  if (!i.recipe) {
    plan.short = `${need} short: no rocket recipe yet (the server sends it at join)`;
    return plan;
  }
  const wantCrafts = Math.ceil(need / ROCKETS_PER_CRAFT);
  const powder = avail(i.gunpowder, home);
  const paper = avail(i.paper, home);
  const caneUsable = i.table ? Math.floor(avail(i.cane, home) / PAPER_PER_CRAFT) * PAPER_PER_CRAFT : 0;
  if (powder < wantCrafts) plan.missing.push(GUNPOWDER);
  if (paper + caneUsable < wantCrafts) plan.missing.push(!i.table && avail(i.cane, home) >= PAPER_PER_CRAFT ? 'crafting table' : PAPER);
  const crafts = Math.min(wantCrafts, powder, paper + caneUsable);
  plan.crafts = crafts;
  if (crafts > 0) {
    plan.steps.push(...takeSteps(GUNPOWDER, crafts, i.gunpowder, home));
    const paperUsed = Math.min(crafts, paper);
    plan.steps.push(...takeSteps(PAPER, paperUsed, i.paper, home));
    const fromCane = crafts - paperUsed;
    if (fromCane > 0) {
      const made = Math.ceil(fromCane / PAPER_PER_CRAFT) * PAPER_PER_CRAFT;
      plan.steps.push(...takeSteps(CANE, made, i.cane, home));
      plan.steps.push({ kind: 'paper', n: made });
    }
    plan.steps.push({ kind: 'craft', n: crafts * ROCKETS_PER_CRAFT });
  }
  const left = need - crafts * ROCKETS_PER_CRAFT;
  if (left > 0) plan.short = `${left} short: ${missingLine(plan.missing, i, home)}`;
  return plan;
}

/** `no gunpowder (carried, in the boxes or at home)`, `no paper or sugar cane`, `sugar cane but no crafting table near`. */
function missingLine(missing: readonly string[], i: RocketStockInput, home: boolean): string {
  const where = home ? 'carried, in the boxes or at home' : i.atHome ? 'carried or in the boxes' : 'carried or in the boxes; the chests at home only at home';
  const parts: string[] = [];
  if (missing.includes(GUNPOWDER)) parts.push(avail(i.gunpowder, home) === 0 ? `no gunpowder (${where})` : `gunpowder for ${avail(i.gunpowder, home) * ROCKETS_PER_CRAFT} only`);
  if (missing.includes('crafting table')) parts.push('sugar cane but no crafting table near for the paper');
  else if (missing.includes(PAPER)) parts.push(avail(i.paper, home) + avail(i.cane, home) === 0 ? 'no paper or sugar cane' : 'not enough paper or sugar cane');
  return parts.length ? parts.join('; ') : 'nothing more to craft from';
}

/**
 * What the unloader keeps of the materials (see the file comment), by name: one craft round to `keep` from nothing,
 * ceil(keep / 3) paper and gunpowder, and sugar cane (a multiple of 3) for the paper of that round not carried. 0 = none.
 */
export function materialsReserve(slots: readonly { name: string; count: number }[], keep = DEFAULT_FIREWORKS_KEEP): Map<string, number> {
  const out = new Map<string, number>();
  const round = Math.ceil(Math.max(0, Math.floor(keep)) / ROCKETS_PER_CRAFT);
  if (round <= 0) return out;
  let paper = 0;
  let powder = 0;
  let cane = 0;
  for (const s of slots) {
    if (s.count <= 0) continue;
    const n = bare(s.name);
    if (n === PAPER) paper += s.count;
    else if (n === GUNPOWDER) powder += s.count;
    else if (n === CANE) cane += s.count;
  }
  const p = Math.min(paper, round);
  if (p > 0) out.set(PAPER, p);
  const g = Math.min(powder, round);
  if (g > 0) out.set(GUNPOWDER, g);
  const c = Math.min(cane, Math.ceil((round - p) / PAPER_PER_CRAFT) * PAPER_PER_CRAFT);
  if (c > 0) out.set(CANE, c);
  return out;
}

/**
 * The trip readiness's need: the rockets a flight of `distance` blocks is likely to burn there and back, never under
 * `fireworksMin`; `estimate` is the energy model's (plan.ts estimateRockets) for the way out.
 */
export function tripRocketNeed(estimate: number, fireworksMin: number): number {
  return Math.max(fireworksMin, 2 * Math.max(0, estimate));
}
