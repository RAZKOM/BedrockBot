// Track T3 follow-up (docs/inventory.md "While a save waits"): the one place the movers of items ask whether a
// `!test inv` save waits for its restore. A preset fills the inventory with made-up items (coal, logs, raw metals, ...);
// on the Realm (2026-11-16) the home chore unloaded 55 of those stacks into the owner's chests while the restore was
// refused. While a save waits:
//   - held (they wait for the restore): the home chore's unload, spares and tidy jobs, `!unload`, the logistics'
//     deposits behind them, the stash step's deposit, a walk home to unload (a full inventory's trip home);
//   - restore first (on its own, then the chore runs as before): the food chore, which would hunt away from the spot and
//     walk home; the saved inventory has the food;
//   - never held: the guard, the flee, the reflex, the eater, the night shelter and the room chore (what a preset tests).
// The test harness (chat/commands-test.ts) sets the guard of the task; without one nothing is held.

export interface SaveGuard {
  /**
   * The line naming the save that waits (`a !test inv early save from 09:30:31 waits for its restore`), undefined when
   * none waits. `who` (the mover that asked) is logged once a save: `test inv: <who> held until the restore`.
   */
  waiting(who?: string): string | undefined;
  /**
   * A chore that would take the bot away asks to run (`why`: its reason). True: a restore runs or was started now, on its
   * own; the chore waits for it and asks again after. False: no save waits, or no restore can run (testMode off, not an
   * operator): the chore goes on (safety first: food is never held).
   */
  restoreFirst(why: string): boolean;
}

const guards = new WeakMap<object, SaveGuard>();

/** The guard of a task (commands-test.ts registers it). */
export function setSaveGuard(key: object, g: SaveGuard | undefined): void {
  if (g) guards.set(key, g);
  else guards.delete(key);
}

export function saveGuardOf(key: object | undefined): SaveGuard | undefined {
  return key ? guards.get(key) : undefined;
}

/** Why `who` must wait (a save waits for its restore), undefined when it may go. */
export function heldBySave(key: object | undefined, who: string): string | undefined {
  return saveGuardOf(key)?.waiting(who);
}
