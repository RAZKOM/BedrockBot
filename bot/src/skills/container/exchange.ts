// Track V1 (ADR 0090, docs/inventory.md "A full inventory and the hotbar"): the survival kit's exchange (two player slots
// swapped by one `swap` item_stack_request, predicted with each stack's wire item, rolled back when refused;
// SurvivalKit.exchange) found by the skills that bring an item into a full hotbar: the place skill's selectItem and the
// farm's click. The hotbar puller gets it as `puller.swap` (Track T2 follow-up 2); these two are built elsewhere (the
// placer by BotSkills, the clicker per farm job), so the kit registers its exchange under the inventory model they all
// share (one per bot). The caller holds the inventory screen.
export type ExchangeFn = (a: number, b: number) => Promise<{ ok: boolean; reason?: string }>;

const fns = new WeakMap<object, ExchangeFn>();

/** The survival kit registers (or, at dispose, removes) its exchange for `inventory`. */
export function setExchange(inventory: object, fn: ExchangeFn | undefined): void {
  if (fn) fns.set(inventory, fn);
  else fns.delete(inventory);
}

/** The exchange for `inventory`, if a survival kit runs on it. */
export function exchangeFor(inventory: object | undefined): ExchangeFn | undefined {
  return inventory ? fns.get(inventory) : undefined;
}

/** A failed fetch into the hotbar is said in the log at most once this long (ms) per skill and reason. */
export const FETCH_LOG_MS = 60_000;

/** Once a minute per key at most (the place skill's and the clicker's failed fetches). */
export class RateLimit {
  private readonly last = new Map<string, number>();
  private readonly now: () => number;
  private readonly everyMs: number;
  constructor(everyMs = FETCH_LOG_MS, now?: () => number) {
    this.everyMs = everyMs;
    this.now = now ?? (() => performance.now());
  }
  /** True when `key` may be said now (and remembers it). */
  ok(key: string): boolean {
    const t = this.now();
    if ((this.last.get(key) ?? -Infinity) + this.everyMs > t) return false;
    this.last.set(key, t);
    return true;
  }
}
