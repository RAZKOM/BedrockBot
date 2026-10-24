// Food gathering (PLAN.md task 7.16, Track X, docs/food.md): finder (targets, food values, furnaces),
// hunter (kill passive food mobs and pick up the drops), cook (furnace / smoker over item stack requests).
export * from './finder.ts';
export { Hunter, IGNORE_MS, type HuntOptions, type HuntResult, type HunterDeps } from './hunter.ts';
export { Cooker, CookRequests, cookTicksOf, inputSlotType, planFuel, FURNACE_FUEL, FURNACE_INPUT, FURNACE_OUTPUT, type CookResult, type CookerDeps, type FuelPlan } from './cook.ts';
