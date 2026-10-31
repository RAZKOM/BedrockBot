// collect(radius, timeoutTicks) (PLAN.md task 4.4): walk over item entities (drops) near the bot
// until none is left that can be picked up. Pickup itself is the server's: it hands an item to a
// player whose box (expanded by about 1 block horizontally) touches it, then sends
// take_item_entity (the EntityTracker removes the actor) and the inventory update.
//
// Inventory full: an item whose kind does not fit (no empty slot and no partial stack with room) is
// skipped; when only such items are left the result is { ok: false, reason: 'inventory_full' }.
//
// Hard to reach (`hard`, decision 0051): an item the plain walk cannot reach (on a ledge, in a hole, behind
// leaves) gets one walk that may dig and place (the navigator's allowBreak / allowPlace under the same rules:
// protected area, digPenalty, throwaway blocks), bounded by `hardBlocks` blocks dug + placed and `hardTicks`.
// The blocks that walk placed are scaffold: they are dug again after the pickup (place/scaffold.ts), unless
// removing them would strand the bot (then they stay and the log says so).
import { silentLogger, type Logger } from '../../log.ts';
import type { EntityInfo, ItemStack, Vec3 } from '../../world/types.ts';
import { maxStackOf } from '../container/chest.ts';
import type { NavGoal } from '../nav/goals.ts';
import { ScaffoldRecord, type ClearResult } from '../place/scaffold.ts';
import type { GotoOptions, SkillResult } from '../types.ts';

export interface CollectDeps {
  entities: () => ReadonlyMap<bigint, EntityInfo>;
  state: () => { pos: Vec3; corrections: number; tick: bigint };
  goto: (goal: NavGoal, opts?: GotoOptions) => Promise<SkillResult>;
  waitTicks: (n: number) => Promise<void>;
  /** Player inventory (for room and the gained counts). */
  inventory: { readonly slots: readonly (ItemStack | null)[]; room(name: string, maxStack?: number): number; count(name: string): number };
  cancelled: () => boolean;
  logger?: Logger;
  /** Clock of EntityInfo.updatedAt (performance.now by default). */
  now?: () => number;
  /** A walk that may dig and place, recording the blocks it places and stopping after `maxBlocks` (BotSkills.scaffoldGoto). */
  hardGoto?: (goal: NavGoal, opts: GotoOptions, record: ScaffoldRecord, maxBlocks: number) => Promise<SkillResult>;
  /** Item actors such a walk was tried for already, kept across collect calls (one walk per item: the sweeps run before every target). */
  hardTried?: Set<bigint>;
  /** Dig the recorded scaffold again (BotSkills.clearScaffold). */
  clearScaffold?: (record: ScaffoldRecord) => Promise<ClearResult>;
}

export interface CollectOptions {
  /** Only these items (default all). */
  filter?: (item: ItemStack) => boolean;
  /** Centre of the search (default the bot's position at the start). */
  origin?: Vec3;
  /** goto 'near' radius around an item. Default 0.8. */
  near?: number;
  /** Give up on an item after this many approaches. Default 2. */
  attemptsPerItem?: number;
  /**
   * An item whose position changed within this many ms is still moving (falling from a log higher
   * up, bouncing): wait for it to settle before planning a path to it. Default 250.
   */
  settleMs?: number;
  /** Wait at most this many ticks per item for it to settle. Default 60. */
  maxSettleTicks?: number;
  /**
   * Do not report "nothing to collect" before this many ticks: the drop of the block broken last
   * (add_item_entity) arrives a moment after its update_block, so a collect started right after a
   * dig would otherwise miss it. Default 10.
   */
  graceTicks?: number;
  /** An item the plain walk cannot reach gets one walk that may dig and place (scaffold dug again after). Default false. */
  hard?: boolean;
  /** Only these items get that walk (default every item the collect takes). */
  hardFilter?: (item: ItemStack) => boolean;
  /** Blocks dug + placed by that walk at most. Default 8. */
  hardBlocks?: number;
  /** Ticks for that walk at most (on top of `timeoutTicks`). Default 300. */
  hardTicks?: number;
}

export type CollectResult = SkillResult & {
  /** Items gained by name (inventory deltas over the call). */
  gained: Record<string, number>;
  /** Item actors that disappeared after an approach. */
  pickedUp: number;
  /** Items ignored: unreachable, did not fit, or not picked up after the approaches. */
  skipped: number;
  ticks: number;
  corrections: number;
  /** Walks that may dig and place (`hard`), scaffold blocks they placed and left in the world. */
  hardWalks?: number;
  scaffoldPlaced?: number;
  scaffoldLeft?: number;
};

const ITEM = 'minecraft:item';

function totals(slots: readonly (ItemStack | null)[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of slots) if (s) m.set(s.name, (m.get(s.name) ?? 0) + s.count);
  return m;
}

export async function collectItems(radius: number, timeoutTicks: number, deps: CollectDeps, opts: CollectOptions = {}): Promise<CollectResult> {
  const log = deps.logger ?? silentLogger;
  const origin = opts.origin ?? { ...deps.state().pos };
  const before = totals(deps.inventory.slots);
  const c0 = deps.state().corrections;
  const attempts = new Map<bigint, number>();
  const settleWaits = new Map<bigint, number>();
  const now = deps.now ?? (() => performance.now());
  const skip = new Set<bigint>();
  const tick0 = deps.state().tick;
  const elapsed = () => Number(deps.state().tick - tick0);
  let ticks = 0;
  let pickedUp = 0;
  const hardTried = deps.hardTried ?? new Set<bigint>();
  let hardWalks = 0;
  let scaffoldPlaced = 0;
  let scaffoldLeft = 0;
  const result = (r: SkillResult): CollectResult => {
    const after = totals(deps.inventory.slots);
    const gained: Record<string, number> = {};
    for (const [n, c] of after) {
      const d = c - (before.get(n) ?? 0);
      if (d > 0) gained[n] = d;
    }
    const out: CollectResult = { ...r, gained, pickedUp, skipped: skip.size, ticks: elapsed(), corrections: deps.state().corrections - c0 };
    if (hardWalks) Object.assign(out, { hardWalks, scaffoldPlaced, scaffoldLeft });
    const hard = hardWalks ? `, ${hardWalks} hard walk(s) (${scaffoldPlaced} scaffold placed, ${scaffoldLeft} left)` : '';
    log.info(`collect r=${radius}: ${r.ok ? 'ok' : r.reason}, gained ${JSON.stringify(gained)}, ${pickedUp} picked up, ${skip.size} skipped, ${ticks} ticks${hard}`);
    return out;
  };
  const candidates = (): EntityInfo[] =>
    [...deps.entities().values()].filter(
      (e) =>
        e.type === ITEM &&
        e.item !== undefined &&
        !skip.has(e.runtimeId) &&
        (!opts.filter || opts.filter(e.item)) &&
        Math.hypot(e.pos.x - origin.x, e.pos.y - origin.y, e.pos.z - origin.z) <= radius,
    );

  let hardTicks = 0; // ticks spent in hard walks and their cleanup: on top of timeoutTicks
  while ((ticks = elapsed()) - hardTicks < timeoutTicks) {
    if (deps.cancelled()) return result({ ok: false, reason: 'interrupted' });
    const all = candidates();
    const fits = all.filter((e) => deps.inventory.room(e.item!.name, maxStackOf(e.item!.name)) > 0);
    if (all.length === 0) {
      if (elapsed() >= (opts.graceTicks ?? 10)) return result({ ok: true });
      await deps.waitTicks(2);
      continue;
    }
    if (fits.length === 0) return result({ ok: false, reason: 'inventory_full' });
    const pos = deps.state().pos;
    fits.sort((a, b) => Math.hypot(a.pos.x - pos.x, a.pos.y - pos.y, a.pos.z - pos.z) - Math.hypot(b.pos.x - pos.x, b.pos.y - pos.y, b.pos.z - pos.z));
    const e = fits[0]!;
    // A drop still falling (its y keeps changing) has no reachable floor yet.
    const waited = settleWaits.get(e.runtimeId) ?? 0;
    if (now() - e.updatedAt < (opts.settleMs ?? 250) && waited < (opts.maxSettleTicks ?? 60)) {
      settleWaits.set(e.runtimeId, waited + 2);
      await deps.waitTicks(2);
      continue;
    }
    const n = (attempts.get(e.runtimeId) ?? 0) + 1;
    attempts.set(e.runtimeId, n);
    if (n > (opts.attemptsPerItem ?? 2)) {
      skip.add(e.runtimeId);
      log.info(`collect: giving up on ${e.item!.name} x${e.item!.count} at ${e.pos.x.toFixed(1)} ${e.pos.y.toFixed(1)} ${e.pos.z.toFixed(1)}`);
      continue;
    }
    // Item actors rest about 0.125 above the floor they lie on. The server picks an item up when the player's box
    // grown by 1 block sideways and 0.5 up and down touches it, so the bot does not need to stand in the item's cell:
    // the cell itself when it can stand there, else one of the cells around it, below it (the drop in the hole an ore
    // left in a wall or a ceiling) or on top of it. A 3D `near` goal sent the bot 16 blocks around a cave for a
    // diamond 1 block away (Realm, 2026-10-30: 3 of 7 diamonds left in their holes).
    const cell = { x: Math.floor(e.pos.x), y: Math.floor(e.pos.y + 0.01), z: Math.floor(e.pos.z) };
    const goal: NavGoal = { type: 'any', goals: [{ type: 'near', p: { x: e.pos.x, y: cell.y, z: e.pos.z }, r: opts.near ?? 0.8 }, { type: 'getToBlock', p: cell, reach: 1.6, face: false, low: 2 }] };
    const g = await deps.goto(goal, { timeoutTicks: Math.max(20, Math.min(400, timeoutTicks - ticks)) });
    if (!g.ok && g.reason === 'interrupted') return result({ ok: false, reason: 'interrupted' });
    if (!g.ok && g.reason === 'unreachable' && opts.hard && deps.hardGoto && !hardTried.has(e.runtimeId) && (!opts.hardFilter || opts.hardFilter(e.item!))) {
      // on a ledge, in a hole: one walk that may dig and place, its scaffold dug again after the pickup
      hardTried.add(e.runtimeId);
      hardWalks++;
      const h0 = elapsed();
      const record = new ScaffoldRecord();
      const left = opts.hardTicks ?? 300; // on top of the collect's own time: a pillar of 4 takes about 60 ticks plus the walk
      const h = await deps.hardGoto(goal, { allowBreak: true, allowPlace: true, timeoutTicks: left }, record, opts.hardBlocks ?? 8);
      log.info(`collect: ${e.item!.name} at ${e.pos.x.toFixed(1)} ${e.pos.y.toFixed(1)} ${e.pos.z.toFixed(1)}: walk with digging / placing ${h.ok ? 'ok' : h.reason}, ${record.size} scaffold block(s)`);
      if (h.ok) {
        for (let i = 0; i < 10 && deps.entities().has(e.runtimeId); i++) await deps.waitTicks(1);
        if (!deps.entities().has(e.runtimeId)) pickedUp++;
      }
      scaffoldPlaced += record.size;
      if (record.size > 0 && deps.clearScaffold) scaffoldLeft += (await deps.clearScaffold(record)).left.length;
      else scaffoldLeft += record.size;
      hardTicks += elapsed() - h0;
      if (deps.cancelled()) return result({ ok: false, reason: 'interrupted' });
      continue;
    }
    if (!g.ok && g.reason === 'unreachable') {
      // e.g. on top of leaves; try again later (leaves decay), then give up on it
      log.info(`collect: ${e.item!.name} at ${e.pos.x.toFixed(1)} ${e.pos.y.toFixed(1)} ${e.pos.z.toFixed(1)} unreachable (attempt ${n})`);
      await deps.waitTicks(10);
      continue;
    }
    // Pickup follows within a few ticks of touching it.
    for (let i = 0; i < 10 && deps.entities().has(e.runtimeId); i++) await deps.waitTicks(1);
    if (!deps.entities().has(e.runtimeId)) pickedUp++;
  }
  return result({ ok: false, reason: 'timeout' });
}
