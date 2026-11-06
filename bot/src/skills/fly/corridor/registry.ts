// Track F4b (docs/flight.md "Corridor flight"): where a task's coarse layer is found by the flight: a provider
// registered for the task (`setCorridorProvider(task, p)`: the e2e's stub), else the navigator's coarse layer
// (Track CB, `skills.nav.coarseLayer`); the flight's costs go to it once (`setCost('fly', new FlightCost())`). `!fly` asks `corridorWanted`
// before its own takeoff: with the setting `flyCorridor auto`, a provider, a goal farther than CORRIDOR_MIN and
// covered (no open sky over it: a cave, a chamber, a tunnel), the trip follows a corridor (chat/commands-corridor.ts).
import type { CorridorProvider } from './coarse-port.ts';
import { FlightCost } from './cost.ts';

/** A `!fly` goal farther than this (blocks) may follow a corridor: beyond what one route plan or one cruise landing covers. */
export const CORRIDOR_MIN = 96;

const providers = new WeakMap<object, CorridorProvider>();
const costed = new WeakSet<CorridorProvider>();
const airborne = new WeakMap<object, () => boolean>();

/** Flight's prices go to a provider once (the layer keeps one cost per mode). */
function withFlightCost(provider: CorridorProvider): CorridorProvider {
  if (!costed.has(provider)) {
    costed.add(provider);
    provider.setCost?.('fly', new FlightCost());
  }
  return provider;
}

/** Register (or with undefined drop) a task's corridor provider (a test's stub, a layer of its own); flight's costs are registered with it. */
export function setCorridorProvider(task: object, provider: CorridorProvider | undefined): void {
  if (!provider) {
    providers.delete(task);
    return;
  }
  providers.set(task, withFlightCost(provider));
}

/**
 * The task's corridor provider: the one registered for it, else `layer` (the navigator's coarse layer,
 * `skills.nav.coarseLayer`, wired by index.ts over the world cache), flight's costs registered with it on first use.
 */
export function corridorProviderOf(task: object, layer?: CorridorProvider): CorridorProvider | undefined {
  return providers.get(task) ?? (layer ? withFlightCost(layer) : undefined);
}

const underFly = new WeakMap<object, boolean>();

/**
 * Track F5a: fly the underground stretches of this task's corridor trips (true) or walk them (false); undefined (the
 * default) leaves the executor's UNDER_FLY. The cave e2e turns it on for its measured runs; nothing else sets it.
 */
export function setCorridorUnderFly(task: object, on: boolean | undefined): void {
  if (on === undefined) underFly.delete(task);
  else underFly.set(task, on);
}

export function corridorUnderFly(task: object): boolean | undefined {
  return underFly.get(task);
}

/** The corridor trip's "a window is in the air" (the falls clutch stays off while it flies, as for the controller). */
export function setCorridorAirborne(task: object, fn: () => boolean): void {
  airborne.set(task, fn);
}

export function corridorAirborne(task: object): boolean {
  return airborne.get(task)?.() === true;
}

/** `!fly` follows a corridor: the setting is not off, a provider is registered, the goal is far and has no open sky over it. */
export function corridorWanted(setting: string, provider: CorridorProvider | undefined, distance: number, covered: boolean): boolean {
  return setting !== 'off' && provider !== undefined && distance > CORRIDOR_MIN && covered;
}
