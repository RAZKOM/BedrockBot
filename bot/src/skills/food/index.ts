// Food gathering (PLAN.md task 7.16, Track X, docs/food.md): finder (targets, food values, furnaces),
// hunter (kill passive food mobs and pick up the drops), cook (furnace / smoker over item stack requests).
export * from './finder.ts';
export { Hunter, IGNORE_MS, type HuntOptions, type HuntResult, type HunterDeps } from './hunter.ts';
export { Cooker, CookRequests, cookTicksOf, inputSlotType, planFuel, FURNACE_FUEL, FURNACE_INPUT, FURNACE_OUTPUT, type CookResult, type CookerDeps, type FuelPlan } from './cook.ts';
// Track AF (food v2): pens, remembered herds, breeding.
export { detectPen, fenceLike, PenDetector, penContains, PEN_KEEP, PEN_RADIUS, type Pen, type PenWorld } from './pen.ts';
export { HerdMemory, HERD_RANGE, CLEAR_RADIUS, markOffers, countsLine, cellKey, type HerdMemoryDeps, type HerdWanted } from './herds.ts';
export { Breeder, BREED_FOOD, BREED_COOLDOWN_MS, breedFoodOf, breedItemCount, breedItemScore, breedable, feedTransaction, type BreedOptions, type BreedResult, type BreederDeps } from './breed.ts';
