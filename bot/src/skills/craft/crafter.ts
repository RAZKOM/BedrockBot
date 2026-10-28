// Track AW (wave 11, docs/crafting.md): crafting through the normal screens, as a vanilla client does.
// Verified on BDS 1.26.60.6 (bds-craft, probe recordings):
//
//   2 x 2   `interact open_inventory` -> container_open { window_type: 'inventory' } (the grid is
//           `crafting_input` slots 28..31, row-major)
//   3 x 3   the chest click (inventory_transaction item_use / click_block) on a crafting table ->
//           container_open { window_type: 'workbench', coordinates } (grid `crafting_input` 32..40);
//           no inventory_content follows for the window
//   fill    one item_stack_request with one `place` per grid cell (several in one request are fine):
//           { type_id: 'place', legacy_type_id: 1, count, source: hotbar|inventory slot, destination:
//           { container_id: 'crafting_input', slot, stack_id: 0 } } -> response ok with the grid slots'
//           new stack ids
//   craft   one item_stack_request: [{ type_id: 'craft_recipe', legacy_type_id: 12, recipe_network_id,
//           times_crafted }, one { type_id: 'consume', count: times, source: the grid slot with its stack
//           id } per cell, { type_id: 'place', count: times * output, source: { container_id:
//           'creative_output', slot: 50, stack_id: <this request's id> }, destination: an inventory slot }]
//           -> response ok: the grid slots at count 0 and the destination slot's count and stack id. No
//           inventory_slot follows: the response is the confirmation, the model predicts the output.
//   wire    the second header byte of every action is BDS's own ItemStackRequestActionType value
//           (craft_recipe = 12: minecraft-data 3.117.0's mapping lacks the two bundle actions 7 and 8,
//           so its `craft_recipe` is 10; sending 10/10 or 12/12 is answered with packet_violation_warning
//           "wrong const value for member Action type" and the connection is closed). `craft_recipe_auto`
//           (the recipe book) is not decodable by this server from minecraft-data's shape: not used.
//   limits  the fill and the craft cannot share one request (status 35: the grid is checked before the
//           fill lands); a craft whose grid does not match the recipe answers 35; a consume alone 3; a
//           take from the output alone 49; a craft without the result transfer 17. Items left in the
//           grid when the screen closes are DESTROYED by the server (the vanilla client moves them back
//           itself), so the crafter empties the grid before every close; a grid item can also be
//           dropped on the ground (`drop` from crafting_input: ok, an item entity at the feet).
//   speed   about 3 ticks per request (130 to 150 ms locally): a batch is 2 requests (fill, craft) for
//           up to 64 output items (`times_crafted` <= 64 / output count, every cell one stack).
import { silentLogger, type Logger } from '../../log.ts';
import type { ItemV4 } from '../../world/packets.ts';
import type { BlockInfo, ItemStack, PacketSource, Vec3 } from '../../world/types.ts';
import { clickBlockTransaction, maxStackOf } from '../container/chest.ts';
import { boxSpots } from '../container/stash.ts';
import type { CollectOptions, CollectResult } from '../collect/collect.ts';
import type { DigOptions, DigResult } from '../dig/digger.ts';
import { blockCenter, EYE_HEIGHT, faceToward, lookAngles } from '../dig/look.ts';
import type { NavGoal } from '../nav/goals.ts';
import type { PlaceOptions, PlaceResult } from '../place/place.ts';
import { wireItemOf } from '../place/place.ts';
import { isBuiltBlock } from '../terrain/classify.ts';
import type { GotoOptions, SkillResult } from '../types.ts';
import { gridSlots, OUTPUT_CONTAINER, OUTPUT_SLOT, planCraft, usedText, type CraftPlan, type PlanOptions, type RecipeIndex } from './recipes.ts';

/**
 * BDS 1.26 ItemStackRequestActionType value of CraftRecipe (the second header byte, see the file comment).
 * TODO(minecraft-data): the clean fix is a renumbered ItemStackRequest `type_id` mapping in
 * patches/minecraft-data@3.117.0.patch (7 place_in_item_container, 8 take_from_item_container, the rest
 * shifted by two); then this constant and `type_id: 'craft_recipe'` agree and craft_recipe_auto /
 * results_deprecated become sendable.
 */
export const CRAFT_RECIPE_WIRE_TYPE = 12;
/** Eye to the closest point of a table the bot opens without placing one. */
export const TABLE_REACH = 4.5;
/** Tables are looked for within this box around the bot (x/z, y -2..+3). */
export const TABLE_SCAN = 6;
/** Ticks a late item_stack_response is waited for after a request timed out, before the grid counts as unknown. */
export const LATE_RESPONSE_TICKS = 100;
const TABLE = 'crafting_table';

export interface StackResponseLike {
  status: 'ok' | 'error' | 'timeout' | number;
  request_id: number;
  containers?: { slot_type: { container_id: string | number }; slots: { slot: number; count: number; item_stack_id?: number }[] }[];
}

export const isOk = (r: { status: unknown }): boolean => r.status === 'ok' || r.status === 0;

const slotInfo = (containerId: string, slot: number, stackId: number | undefined): Record<string, unknown> => ({ slot_type: { container_id: containerId }, slot, stack_id: stackId ?? 0 });
const playerSlotInfo = (slot: number, stackId: number | undefined) => slotInfo(slot < 9 ? 'hotbar' : 'inventory', slot, stackId);

/**
 * Item stack requests with their own ids (from -400001 down: world/containers.ts counts from -1,
 * survival/screen.ts from -100001, food/cook.ts from -200001, combat/shield.ts from -300001). A
 * response that arrives after `send` gave up is handed to the `late` handler the sender registered.
 */
export class CraftRequests {
  private next = -400001;
  private readonly pending = new Map<number, (r: StackResponseLike) => void>();
  private readonly late = new Map<number, (r: StackResponseLike) => void>();
  private readonly off: () => void;
  private readonly source: Pick<PacketSource, 'on' | 'queue'>;
  private readonly waitTicks: (n: number) => Promise<void>;
  readonly stats = { sent: 0, ok: 0, error: 0, timeout: 0, late: 0 };

  constructor(source: Pick<PacketSource, 'on' | 'queue'>, waitTicks: (n: number) => Promise<void>) {
    this.source = source;
    this.waitTicks = waitTicks;
    this.off = source.on('item_stack_response', (p) => {
      for (const r of (p as unknown as { responses?: StackResponseLike[] }).responses ?? []) {
        const fn = this.pending.get(r.request_id);
        if (fn) {
          this.pending.delete(r.request_id);
          fn(r);
          continue;
        }
        const l = this.late.get(r.request_id);
        if (l) {
          this.late.delete(r.request_id);
          this.stats.late++;
          l(r);
        }
      }
    });
  }

  dispose(): void {
    this.off();
    this.pending.clear();
    this.late.clear();
  }

  /** The id the next `send` uses (the craft action names it as the output's stack id). */
  peekId(): number {
    return this.next;
  }

  /** Send one request; on a timeout the response (if it ever comes) goes to `onLate`. */
  async send(actions: Record<string, unknown>[], timeoutTicks = 60, onLate?: (r: StackResponseLike) => void): Promise<StackResponseLike> {
    const id = this.next;
    this.next -= 2;
    let got: StackResponseLike | undefined;
    this.pending.set(id, (r) => {
      got = r;
    });
    this.stats.sent++;
    this.source.queue('item_stack_request', { requests: [{ request_id: id, actions, custom_names: [], cause: 'chat_public' }] });
    for (let i = 0; i < timeoutTicks && !got; i++) await this.waitTicks(1);
    this.pending.delete(id);
    if (!got) {
      this.stats.timeout++;
      if (onLate) this.late.set(id, onLate);
      return { status: 'timeout', request_id: id };
    }
    if (isOk(got)) this.stats.ok++;
    else this.stats.error++;
    return got;
  }

  /** Wait up to `ticks` for the late response of request `id`; true when it came. */
  async waitLate(id: number, ticks: number): Promise<boolean> {
    for (let i = 0; i < ticks && this.late.has(id); i++) await this.waitTicks(1);
    return !this.late.has(id);
  }
}

export interface CrafterLoop {
  readonly state: { pos: Vec3; ready: boolean };
  setCommand(c: { yaw?: number; pitch?: number }): void;
  waitTicks(n: number): Promise<void>;
}

export interface CrafterInventory {
  readonly slots: readonly (ItemStack | null)[];
  readonly selected: number;
  window(id: number): { slots: readonly (ItemStack | null)[] } | undefined;
  setItem(window: number, slot: number, item: ItemStack | null, raw?: ItemV4): void;
  rawItem?(window: number, slot: number): ItemV4 | undefined;
}

export interface CrafterWorld {
  blockAt(p: Vec3): BlockInfo | undefined;
  readonly chunks: { runtimeIdAt(x: number, y: number, z: number): number | undefined };
  readonly inventory: CrafterInventory;
}

export interface CrafterContainers {
  readonly open: { id: number; type: string; pos: Vec3 } | undefined;
  onOpen(fn: (c: { id: number; type: string; pos: Vec3 }) => void): () => void;
  onClose(fn: (id: number, byServer: boolean) => void): () => void;
  close(id: number, type?: string): void;
}

/** The block skills a table needs (BotSkills: place, dig, collect; goto for a table out of reach). */
export interface CrafterBlockSkills {
  place(p: Vec3, opts?: PlaceOptions): Promise<PlaceResult>;
  dig(p: Vec3, opts?: DigOptions): Promise<DigResult>;
  collect(radius: number, timeoutTicks: number, opts?: CollectOptions): Promise<CollectResult>;
  goto?(goal: NavGoal, opts?: GotoOptions): Promise<SkillResult>;
}

export interface CrafterDeps {
  source: Pick<PacketSource, 'on' | 'queue'>;
  loop: CrafterLoop;
  world: CrafterWorld;
  containers: CrafterContainers;
  recipes: Pick<RecipeIndex, 'byOutput'>;
  /** Own runtime entity id (the target of `interact open_inventory`). */
  runtimeId: () => bigint;
  hotbar?: { rawItem(slot: number): ItemV4 | undefined; noteRaw?(slot: number, item: ItemV4 | undefined): void };
  skills?: CrafterBlockSkills;
  /** Items never consumed (keepOnDropItems, the flight kit). */
  keep?: (name: string) => boolean;
  /** Keep at least this many of an item (`craftReserve`). */
  reserve?: (name: string) => number;
  log?: Logger;
  now?: () => number;
}

export type CraftReason = 'done' | 'no_recipe' | 'missing' | 'no_table' | 'open_failed' | 'request_failed' | 'inventory_full' | 'interrupted' | 'not_ready' | 'busy' | 'table_left';

export interface CraftResult {
  ok: boolean;
  reason: CraftReason;
  item: string;
  /** Items asked for and items made. */
  wanted: number;
  crafted: number;
  /** Ingredients consumed, by name. */
  used: Record<string, number>;
  batches: number;
  requests: number;
  ms: number;
  /** The limiting ingredient when fewer than wanted were (or could be) made. */
  shortfall?: { name: string; have: number; need: number };
  /** A 3 x 3 recipe: the table used (`placed`: by the bot, now or in an earlier run). */
  table?: { pos: Vec3; placed: boolean; pickedUp?: boolean };
  /** The last item_stack_response status that was not ok ('timeout' for no response). */
  status?: unknown;
  /** Grid items dropped on the ground at the end: the inventory had no room for them, or their give-back was refused. */
  dropped?: Record<string, number>;
}

const samePos = (a: Vec3, b: Vec3) => a.x === b.x && a.y === b.y && a.z === b.z;
const fmt = (p: Vec3) => `${p.x} ${p.y} ${p.z}`;

/** `crafted 4 iron_block (36 iron_ingot used) in 2.1 s` (+ the table and the shortfall). */
export function craftLine(r: CraftResult): string {
  const used = Object.entries(r.used)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');
  const s = r.ms / 1000;
  const time = `${s >= 10 ? Math.round(s) : s.toFixed(1)} s`;
  const parts: string[] = [];
  if (r.crafted > 0) parts.push(`crafted ${r.crafted} ${r.item} (${used || 'nothing'} used) in ${time}`);
  else parts.push(`craft: made no ${r.item} (${r.reason}${r.status !== undefined ? ` status ${JSON.stringify(r.status)}` : ''})`);
  if (r.table?.placed) parts.push(r.table.pickedUp ? 'crafting table placed and picked up' : `crafting table left at ${fmt(r.table.pos)}`);
  if (r.shortfall && r.crafted < r.wanted) parts.push(`${Math.max(0, r.shortfall.need - r.shortfall.have)} ${r.shortfall.name} short for ${r.wanted}`);
  else if (r.crafted < r.wanted && r.reason !== 'done') parts.push(`stopped: ${r.reason}`);
  if (r.dropped) parts.push(`dropped ${Object.entries(r.dropped).map(([k, v]) => `${v} ${k}`).join(', ')} (could not be taken back)`);
  return parts.join('; ');
}

/** The output slot after a fill that empties `emptied` slots: a matching stack with room, else an empty slot (main inventory first). */
export function destinationSlot(slots: readonly (ItemStack | null)[], name: string, metadata: number, count: number, emptied: ReadonlySet<number> = new Set(), maxStack = maxStackOf): number | undefined {
  const max = maxStack(name);
  for (let i = 0; i < 36; i++) {
    const s = slots[i];
    if (!emptied.has(i) && s?.name === name && s.metadata === metadata && s.count + count <= max) return i;
  }
  for (let i = 9; i < 36; i++) if (!slots[i] || emptied.has(i)) return i;
  for (let i = 0; i < 9; i++) if (!slots[i] || emptied.has(i)) return i;
  return undefined;
}

export class Crafter {
  private readonly d: CrafterDeps;
  private readonly log: Logger;
  private readonly req: CraftRequests;
  private readonly now: () => number;
  private running = false;
  /** A table craft inside a 3 x 3 craft (the 2 x 2 recipe for the table itself). */
  private nested = false;
  /** Tables the bot placed and has not picked up yet (task state; retried at the next craft). */
  readonly pendingTables: Vec3[] = [];
  /** State line for !status. */
  phase = 'idle';
  readonly stats = { crafts: 0, items: 0, batches: 0, tablesPlaced: 0, tablesLeft: 0, dropped: 0 };

  constructor(deps: CrafterDeps) {
    this.d = deps;
    this.log = deps.log ?? silentLogger;
    this.now = deps.now ?? (() => performance.now());
    this.req = new CraftRequests(deps.source, (n) => deps.loop.waitTicks(n));
  }

  dispose(): void {
    this.req.dispose();
  }

  get busy(): boolean {
    return this.running;
  }

  private planOpts(): PlanOptions {
    const o: PlanOptions = { maxStack: maxStackOf };
    if (this.d.keep) o.keep = this.d.keep;
    if (this.d.reserve) o.reserve = this.d.reserve;
    return o;
  }

  /** The plan `craft` would follow now (no packets). */
  plan(item: string, n: number): CraftPlan | undefined {
    return planCraft(this.d.recipes, item, n, this.d.world.inventory.slots, this.planOpts());
  }

  /** Make `n` of `item` (as many as the inventory allows), batch by batch; `cancelled` is checked between batches. */
  async craft(item: string, n: number, cancelled: () => boolean = () => false): Promise<CraftResult> {
    const t0 = this.now();
    const res: CraftResult = { ok: false, reason: 'done', item, wanted: n, crafted: 0, used: {}, batches: 0, requests: 0, ms: 0 };
    const r0 = this.req.stats.sent;
    const done = (reason: CraftReason): CraftResult => {
      res.reason = reason;
      res.ok = reason === 'done' && res.crafted > 0;
      res.requests = this.req.stats.sent - r0;
      res.ms = this.now() - t0;
      this.phase = 'idle';
      return res;
    };
    if (this.running && !this.nested) return done('busy');
    if (!this.d.loop.state.ready) return done('not_ready');
    const first = this.plan(item, n);
    if (!first) return done('no_recipe');
    res.item = first.item;
    if (first.shortfall) res.shortfall = first.shortfall;
    if (first.crafts <= 0) return done('missing');
    const outer = !this.running;
    this.running = true;
    try {
      // a table left standing by an earlier run: pick it up first when it is near
      if (outer) await this.pickUpPending();
      let tableAt: Vec3 | undefined;
      let placed = false;
      if (first.table) {
        this.phase = `finding a crafting table for ${item}`;
        tableAt = await this.findTable(cancelled);
        if (cancelled()) return done('interrupted');
        if (tableAt && this.pendingTables.some((p) => samePos(p, tableAt!))) placed = true; // ours from an earlier run
        if (!tableAt) {
          const p = await this.placeTable(cancelled);
          if (cancelled()) return done('interrupted');
          if (!p) return done('no_table');
          tableAt = p;
          placed = true;
          this.pendingTables.push(p);
          this.stats.tablesPlaced++;
        }
        res.table = { pos: tableAt, placed };
      }
      try {
        const window = await this.open(tableAt);
        if (window === undefined) return done('open_failed');
        try {
          const r = await this.batches(window, item, n, res, cancelled);
          return done(r);
        } finally {
          await this.giveBack(window, res, true);
          await this.close(window);
        }
      } finally {
        if (placed && tableAt) {
          const up = await this.pickUpTable(tableAt);
          if (res.table) res.table.pickedUp = up;
          if (up) this.forgetTable(tableAt);
          else {
            this.stats.tablesLeft++;
            if (res.reason === 'done') res.reason = 'table_left';
            res.ok = false; // the craft may have made its items, but a table of ours stands in the world
          }
        }
      }
    } finally {
      if (outer) this.running = false;
      this.log.info(`craft ${item} x${n}: ${craftLine(res)} (${res.batches} batches, ${res.requests} requests)`);
    }
  }

  // ---- batches -----------------------------------------------------------------------------------------

  private async batches(window: number, item: string, n: number, res: CraftResult, cancelled: () => boolean): Promise<CraftReason> {
    let retried = false;
    while (res.crafted < n) {
      if (cancelled()) return 'interrupted';
      const plan = this.plan(item, n - res.crafted);
      if (!plan) return 'no_recipe';
      if (plan.shortfall && !res.shortfall) res.shortfall = plan.shortfall; // the first plan's numbers (before anything was consumed)
      if (plan.crafts <= 0) return res.crafted > 0 ? 'done' : 'missing';
      const times = Math.min(plan.crafts, plan.batchMax, Math.max(1, Math.ceil((n - res.crafted) / plan.outputPer)));
      this.phase = `crafting ${times * plan.outputPer} ${plan.item} (${res.crafted}/${n})`;
      const r = await this.batch(window, plan, times);
      res.batches++;
      this.stats.batches++;
      if (r.ok) {
        res.crafted += r.made;
        for (const [k, v] of Object.entries(r.used)) res.used[k] = (res.used[k] ?? 0) + v;
        this.stats.crafts += times;
        this.stats.items += r.made;
        retried = false;
        continue;
      }
      res.status = r.status;
      if (r.reason === 'inventory_full') return 'inventory_full';
      if (r.reason === 'missing') return res.crafted > 0 ? 'done' : 'missing';
      this.log.warn(`craft ${plan.item}: batch failed (${r.reason}${r.status !== undefined ? ` status ${JSON.stringify(r.status)}` : ''})${retried || r.status === 'timeout' ? '' : ', retrying once'}`);
      if (retried || r.status === 'timeout') return 'request_failed';
      retried = true;
      if (!(await this.giveBack(window, res, false))) return 'request_failed';
      if (this.d.containers.open?.id !== window) return 'open_failed';
    }
    return 'done';
  }

  /** The grid slot of each plan cell: shaped recipes by the pattern cell (holes stay empty), shapeless in order. */
  private cellSlots(plan: CraftPlan): number[] {
    const slots = gridSlots(plan.recipe, plan.table);
    return plan.cells.map((c, i) => slots[plan.recipe.shaped ? c.cell : i]).filter((s): s is number => s !== undefined);
  }

  /**
   * One batch: the output slot is chosen first (counting the slots the fill empties: `inventory_full`
   * before anything moves), then the grid is filled (one or more requests), then craft + consume +
   * place the output (one request). The model is predicted before each request and corrected from
   * the response's counts.
   */
  private async batch(window: number, plan: CraftPlan, times: number): Promise<{ ok: true; made: number; used: Record<string, number> } | { ok: false; reason: CraftReason; status?: unknown }> {
    const inv = this.d.world.inventory;
    const slots = this.cellSlots(plan);
    const gridItems = new Map<number, ItemStack>(); // grid slot -> the item there (with the server's stack id once known)
    const out = plan.recipe.output[0]!;
    const made = times * plan.outputPer;
    // what the fill needs per grid slot
    const need = new Map<number, { item: string; left: number }>();
    plan.cells.forEach((c, i) => {
      const slot = slots[i];
      if (slot === undefined) return;
      const cur = need.get(slot);
      if (cur) cur.left += times;
      else need.set(slot, { item: c.item, left: times });
    });
    // the output slot, with the fill simulated: the slots it empties are free for the output
    {
      const sim = inv.slots.map((s) => (s ? s.count : 0));
      const emptied = new Set<number>();
      for (const x of need.values()) {
        let left = x.left;
        while (left > 0) {
          let best: number | undefined;
          for (let i = 0; i < 36; i++) {
            const s = inv.slots[i];
            if (s?.name !== x.item || sim[i]! <= 0 || this.d.keep?.(s.name)) continue;
            if (best === undefined || sim[i]! > sim[best]!) best = i;
          }
          if (best === undefined) return { ok: false, reason: 'missing' };
          const k = Math.min(left, sim[best]!);
          sim[best]! -= k;
          if (sim[best] === 0) emptied.add(best);
          left -= k;
        }
      }
      if (destinationSlot(inv.slots, out.name, out.metadata, made, emptied) === undefined) return { ok: false, reason: 'inventory_full' };
    }
    // fill
    for (let round = 0; round < 12 && [...need.values()].some((x) => x.left > 0); round++) {
      const actions: Record<string, unknown>[] = [];
      const predicted: { slot: number; before: ItemStack | null; beforeRaw: ItemV4 | undefined }[] = [];
      const gridBefore = new Map<number, ItemStack | undefined>();
      for (const [gslot, x] of need) {
        if (x.left <= 0) continue;
        const src = this.sourceSlot(x.item);
        if (src === undefined) return { ok: false, reason: 'missing' };
        const s = inv.slots[src]!;
        const k = Math.min(x.left, s.count);
        const g = gridItems.get(gslot);
        actions.push({ type_id: 'place', legacy_type_id: 1, count: k, source: playerSlotInfo(src, s.stackId), destination: slotInfo('crafting_input', gslot, g?.stackId) });
        predicted.push({ slot: src, before: s, beforeRaw: inv.rawItem?.(0, src) });
        inv.setItem(0, src, s.count - k > 0 ? { ...s, count: s.count - k } : null);
        gridBefore.set(gslot, g);
        const next: ItemStack = g ? { ...g, count: g.count + k } : { ...s, count: k };
        if (!g) delete next.stackId;
        gridItems.set(gslot, next);
        inv.setItem(window, gslot, next);
        x.left -= k;
      }
      if (actions.length === 0) break;
      const r = await this.req.send(actions, 60, (late) => {
        // the fill happened (or not) after we stopped waiting: the response says which
        if (isOk(late)) this.applyResponse(late, window, gridItems);
        else this.rollbackFill(window, predicted, gridBefore, gridItems);
      });
      if (r.status === 'timeout') {
        this.log.warn(`craft ${plan.item}: no answer to the grid fill, waiting ${LATE_RESPONSE_TICKS} more ticks`);
        const came = await this.req.waitLate(r.request_id, LATE_RESPONSE_TICKS);
        // no answer: the prediction stands (the give-back then asks the server; a refusal means nothing was there)
        return { ok: false, reason: 'request_failed', status: came ? 'late' : 'timeout' };
      }
      if (!isOk(r)) {
        this.rollbackFill(window, predicted, gridBefore, gridItems); // the request is atomic on BDS: nothing moved
        return { ok: false, reason: 'request_failed', status: r.status };
      }
      this.applyResponse(r, window, gridItems);
      for (const p of predicted) this.noteHotbar(p.slot);
    }
    // craft
    const dst = destinationSlot(inv.slots, out.name, out.metadata, made);
    if (dst === undefined) return { ok: false, reason: 'inventory_full' };
    const dstBefore = inv.slots[dst] ?? null;
    const dstRaw = inv.rawItem?.(0, dst);
    const id = this.req.peekId();
    const actions: Record<string, unknown>[] = [{ type_id: 'craft_recipe', legacy_type_id: CRAFT_RECIPE_WIRE_TYPE, recipe_network_id: plan.recipe.networkId, times_crafted: times }];
    for (const [gslot, g] of gridItems) actions.push({ type_id: 'consume', legacy_type_id: 5, count: g.count, source: slotInfo('crafting_input', gslot, g.stackId) });
    actions.push({ type_id: 'place', legacy_type_id: 1, count: made, source: slotInfo(OUTPUT_CONTAINER, OUTPUT_SLOT, id), destination: playerSlotInfo(dst, dstBefore?.stackId) });
    const predictedOut: ItemStack = dstBefore ? { ...dstBefore, count: dstBefore.count + made } : { name: out.name, networkId: out.networkId, count: made, metadata: out.metadata, blockRuntimeId: out.blockRuntimeId };
    if (!dstBefore) delete predictedOut.stackId;
    const gridBeforeCraft = new Map(gridItems);
    inv.setItem(0, dst, predictedOut);
    for (const gslot of gridItems.keys()) inv.setItem(window, gslot, null);
    gridItems.clear();
    const r = await this.req.send(actions, 60, (late) => {
      if (isOk(late)) {
        this.applyResponse(late, window, gridItems);
        this.noteHotbar(dst);
      } else {
        inv.setItem(0, dst, dstBefore, dstRaw);
        for (const [gslot, g] of gridBeforeCraft) {
          gridItems.set(gslot, g);
          inv.setItem(window, gslot, g);
        }
      }
    });
    if (r.status === 'timeout') {
      this.log.warn(`craft ${plan.item}: no answer to the craft, waiting ${LATE_RESPONSE_TICKS} more ticks`);
      const came = await this.req.waitLate(r.request_id, LATE_RESPONSE_TICKS);
      if (!came) {
        // unknown: assume the craft did not happen for the count, keep the grid as filled so the give-back asks the server
        inv.setItem(0, dst, dstBefore, dstRaw);
        for (const [gslot, g] of gridBeforeCraft) {
          gridItems.set(gslot, g);
          inv.setItem(window, gslot, g);
        }
        return { ok: false, reason: 'request_failed', status: 'timeout' };
      }
      if (inv.slots[dst]?.name !== out.name) return { ok: false, reason: 'request_failed', status: 'late' };
    } else if (!isOk(r)) {
      inv.setItem(0, dst, dstBefore, dstRaw);
      for (const [gslot, g] of gridBeforeCraft) {
        gridItems.set(gslot, g);
        inv.setItem(window, gslot, g);
      }
      return { ok: false, reason: 'request_failed', status: r.status };
    } else {
      this.applyResponse(r, window, gridItems);
      this.noteHotbar(dst);
    }
    const used: Record<string, number> = {};
    for (const [k, v] of Object.entries(plan.perCraft)) used[k] = v * times;
    // the delta: the destination grew by `made` (or the response said so)
    const after = inv.slots[dst]?.count ?? 0;
    const grew = after - (dstBefore?.count ?? 0);
    if (grew !== made) this.log.warn(`craft ${plan.item}: expected +${made} in slot ${dst}, model shows +${grew}`);
    return { ok: true, made, used };
  }

  private rollbackFill(window: number, predicted: readonly { slot: number; before: ItemStack | null; beforeRaw: ItemV4 | undefined }[], gridBefore: ReadonlyMap<number, ItemStack | undefined>, gridItems: Map<number, ItemStack>): void {
    const inv = this.d.world.inventory;
    for (const p of predicted) inv.setItem(0, p.slot, p.before, p.beforeRaw);
    for (const [gslot, g] of gridBefore) {
      if (g) gridItems.set(gslot, g);
      else gridItems.delete(gslot);
      inv.setItem(window, gslot, g ?? null);
    }
  }

  /** A source slot holding `item` (the largest stack first). */
  private sourceSlot(item: string): number | undefined {
    const slots = this.d.world.inventory.slots;
    let best: number | undefined;
    for (let i = 0; i < 36; i++) {
      const s = slots[i];
      if (!s || s.count <= 0 || s.name !== item || this.d.keep?.(s.name)) continue;
      if (best === undefined || s.count > slots[best]!.count) best = i;
    }
    return best;
  }

  /** Counts and stack ids from an ok response onto the predicted slots (player inventory and the grid). */
  private applyResponse(r: StackResponseLike, window: number, grid: Map<number, ItemStack>): void {
    const inv = this.d.world.inventory;
    for (const c of r.containers ?? []) {
      const id = c.slot_type.container_id;
      for (const s of c.slots) {
        if (id === 'hotbar' || id === 'inventory' || id === 28 || id === 29) {
          const cur = inv.slots[s.slot] ?? null;
          if (s.count <= 0) inv.setItem(0, s.slot, null);
          else if (cur) inv.setItem(0, s.slot, { ...cur, count: s.count, ...(s.item_stack_id !== undefined ? { stackId: s.item_stack_id } : {}) });
        } else if (id === 'crafting_input' || id === 13) {
          const g = grid.get(s.slot) ?? inv.window(window)?.slots[s.slot] ?? undefined;
          if (s.count <= 0) {
            grid.delete(s.slot);
            inv.setItem(window, s.slot, null);
          } else if (g) {
            const next: ItemStack = { ...g, count: s.count, ...(s.item_stack_id !== undefined ? { stackId: s.item_stack_id } : {}) };
            grid.set(s.slot, next);
            inv.setItem(window, s.slot, next);
          }
        }
      }
    }
  }

  private noteHotbar(slot: number): void {
    if (slot < 9) this.d.hotbar?.noteRaw?.(slot, wireItemOf(this.d.world.inventory.slots[slot], undefined));
  }

  /** The grid cells the model shows as filled. */
  private gridLeft(window: number): { gslot: number; item: ItemStack }[] {
    const out: { gslot: number; item: ItemStack }[] = [];
    for (let gslot = 28; gslot <= 40; gslot++) {
      const g = this.d.world.inventory.window(window)?.slots[gslot];
      if (g && g.count > 0) out.push({ gslot, item: g });
    }
    return out;
  }

  /**
   * Move whatever the model shows in the grid back into the inventory (the server destroys grid items
   * on close): destinations are planned with their counts so cells of one item merge where they fit.
   * `final` (before the close): a refused request is retried cell by cell, and a cell with no room,
   * or one still refused, is dropped on the ground (`drop` from crafting_input) rather than lost at
   * close. Mid-craft (before a retry) only the one request is tried. True when the grid is empty.
   */
  private async giveBack(window: number, res: CraftResult | undefined, final: boolean): Promise<boolean> {
    const inv = this.d.world.inventory;
    if (!inv.window(window)) return true;
    let left = this.gridLeft(window);
    if (left.length === 0) return true;
    // round 1: everything in one request
    const r1 = await this.giveBackMoves(window, left);
    left = this.gridLeft(window);
    if (left.length === 0) return true;
    if (!final) {
      this.log.warn(`craft: giving the grid back failed (${r1}); no retry of the craft`);
      return false;
    }
    if (r1 !== 'ok') this.log.warn(`craft: giving the grid back failed (${r1}), retrying cell by cell`);
    // round 2: cell by cell
    for (const cell of left) {
      await this.giveBackMoves(window, [cell]);
    }
    left = this.gridLeft(window);
    if (left.length === 0) return true;
    // last resort: drop what has no room or is still refused, as a player would, instead of losing it at close
    for (const cell of left) {
      const r = await this.req.send([{ type_id: 'drop', legacy_type_id: 3, count: cell.item.count, source: slotInfo('crafting_input', cell.gslot, cell.item.stackId), randomly: false }]);
      if (isOk(r)) {
        inv.setItem(window, cell.gslot, null);
        this.stats.dropped += cell.item.count;
        if (res) {
          res.dropped ??= {};
          res.dropped[cell.item.name] = (res.dropped[cell.item.name] ?? 0) + cell.item.count;
        }
        this.log.warn(`craft: dropped ${cell.item.count} ${cell.item.name} from the grid (no room in the inventory)`);
      } else {
        // the server refuses to move or drop it (49 for a stack id it does not know: a fill without an answer): nothing
        // more can be sent for it; the cell is taken as empty (a stale prediction), or lost at close as on a disconnect
        inv.setItem(window, cell.gslot, null);
        this.log.warn(`craft: grid slot ${cell.gslot} (${cell.item.count} ${cell.item.name} in the model) cannot be moved or dropped (${JSON.stringify(r.status)}); treating it as empty`);
      }
    }
    return true;
  }

  /** One give-back request for `cells`: planned destinations (counts tracked), prediction, response. */
  private async giveBackMoves(window: number, cells: readonly { gslot: number; item: ItemStack }[]): Promise<string> {
    const inv = this.d.world.inventory;
    const planned = new Map<number, { name: string; metadata: number; count: number }>();
    inv.slots.forEach((s, i) => {
      if (s && i < 36) planned.set(i, { name: s.name, metadata: s.metadata, count: s.count });
    });
    const actions: Record<string, unknown>[] = [];
    const moves: { gslot: number; dst: number; item: ItemStack; dstBefore: ItemStack | null; dstRaw: ItemV4 | undefined }[] = [];
    for (const { gslot, item } of cells) {
      const max = maxStackOf(item.name);
      let dst: number | undefined;
      for (let i = 0; i < 36 && dst === undefined; i++) {
        const p = planned.get(i);
        if (p?.name === item.name && p.metadata === item.metadata && p.count + item.count <= max) dst = i;
      }
      for (let i = 9; i < 36 && dst === undefined; i++) if (!planned.has(i)) dst = i;
      for (let i = 0; i < 9 && dst === undefined; i++) if (!planned.has(i)) dst = i;
      if (dst === undefined) continue; // no room: left for the drop
      const p = planned.get(dst);
      planned.set(dst, { name: item.name, metadata: item.metadata, count: (p?.count ?? 0) + item.count });
      const dstBefore = inv.slots[dst] ?? null;
      actions.push({ type_id: 'place', legacy_type_id: 1, count: item.count, source: slotInfo('crafting_input', gslot, item.stackId), destination: playerSlotInfo(dst, dstBefore?.stackId) });
      moves.push({ gslot, dst, item, dstBefore, dstRaw: inv.rawItem?.(0, dst) });
    }
    if (actions.length === 0) return 'no_room';
    // prediction (several cells may land on one destination, in order)
    for (const m of moves) {
      inv.setItem(window, m.gslot, null);
      const cur = inv.slots[m.dst] ?? null;
      const next: ItemStack = cur ? { ...cur, count: cur.count + m.item.count } : { ...m.item };
      if (!cur) delete next.stackId;
      inv.setItem(0, m.dst, next);
    }
    const r = await this.req.send(actions, 60, (late) => {
      if (isOk(late)) this.applyResponse(late, window, new Map());
      else for (const m of [...moves].reverse()) this.undoMove(window, m);
    });
    if (r.status === 'timeout') {
      await this.req.waitLate(r.request_id, LATE_RESPONSE_TICKS);
      return this.gridLeft(window).length === 0 ? 'ok' : 'timeout';
    }
    if (!isOk(r)) {
      for (const m of [...moves].reverse()) this.undoMove(window, m);
      return String(r.status);
    }
    this.applyResponse(r, window, new Map());
    for (const m of moves) this.noteHotbar(m.dst);
    return 'ok';
  }

  private undoMove(window: number, m: { gslot: number; dst: number; item: ItemStack; dstBefore: ItemStack | null; dstRaw: ItemV4 | undefined }): void {
    const inv = this.d.world.inventory;
    inv.setItem(window, m.gslot, m.item);
    inv.setItem(0, m.dst, m.dstBefore, m.dstRaw);
  }

  // ---- screens -----------------------------------------------------------------------------------------

  private eye(): Vec3 {
    const f = this.d.loop.state.pos;
    return { x: f.x, y: f.y + EYE_HEIGHT, z: f.z };
  }

  /** Open the inventory screen (no table) or click the table; the window id, or undefined. */
  private async open(table: Vec3 | undefined): Promise<number | undefined> {
    const { containers, loop, source, world } = this.d;
    const stale = containers.open;
    if (stale) await this.close(stale.id, stale.type);
    let opened: { id: number; type: string; pos: Vec3 } | undefined;
    const off = containers.onOpen((c) => {
      if (table ? samePos(c.pos, table) : c.type === 'inventory') opened = c;
    });
    if (table) {
      loop.setCommand(lookAngles(this.eye(), blockCenter(table)));
      await loop.waitTicks(2);
      const slot = world.inventory.selected;
      source.queue('inventory_transaction', clickBlockTransaction({ pos: table, face: faceToward(this.eye(), table), hotbarSlot: slot, held: this.d.hotbar?.rawItem(slot), eye: this.eye(), blockRuntimeId: world.chunks.runtimeIdAt(table.x, table.y, table.z) ?? 0 }));
    } else {
      source.queue('interact', { action_id: 'open_inventory', target_entity_id: this.d.runtimeId(), has_position: false });
    }
    for (let i = 0; i < 40 && !opened; i++) await loop.waitTicks(1);
    off();
    if (!opened) {
      this.log.info(`craft: ${table ? `the table at ${fmt(table)}` : 'the inventory screen'} did not open`);
      return undefined;
    }
    this.log.debug(`craft: opened ${opened.type} window ${opened.id}`);
    return opened.id;
  }

  private async close(id: number, type?: string): Promise<void> {
    const { containers, loop } = this.d;
    if (containers.open?.id !== id) return;
    let closed = false;
    const off = containers.onClose((cid) => {
      if (cid === id) closed = true;
    });
    containers.close(id, type ?? containers.open.type);
    for (let i = 0; i < 20 && !closed; i++) await loop.waitTicks(1);
    off();
  }

  // ---- the table ---------------------------------------------------------------------------------------

  /** Is the straight line from the eye to the centre of `target`'s nearest face free of solid blocks? */
  visible(target: Vec3): boolean {
    const eye = this.eye();
    const face = faceToward(eye, target);
    const c = blockCenter(target);
    const off: Record<number, Vec3> = { 0: { x: 0, y: -0.5, z: 0 }, 1: { x: 0, y: 0.5, z: 0 }, 2: { x: 0, y: 0, z: -0.5 }, 3: { x: 0, y: 0, z: 0.5 }, 4: { x: -0.5, y: 0, z: 0 }, 5: { x: 0.5, y: 0, z: 0 } };
    const o = off[face] ?? { x: 0, y: 0, z: 0 };
    const to = { x: c.x + o.x * 0.98, y: c.y + o.y * 0.98, z: c.z + o.z * 0.98 };
    const d = Math.hypot(to.x - eye.x, to.y - eye.y, to.z - eye.z);
    const steps = Math.max(1, Math.ceil(d / 0.2));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const p = { x: Math.floor(eye.x + (to.x - eye.x) * t), y: Math.floor(eye.y + (to.y - eye.y) * t), z: Math.floor(eye.z + (to.z - eye.z) * t) };
      if (samePos(p, target)) continue;
      const b = this.d.world.blockAt(p);
      if (b?.solid) return false;
    }
    return true;
  }

  /** Crafting tables around the bot, nearest first: within `reach` of the eye and with a clear line to a face. */
  nearbyTable(reach = TABLE_REACH): Vec3 | undefined {
    return this.tablesAround().find((t) => t.d <= reach && this.visible(t.p))?.p;
  }

  /** Every crafting table in the scan box, with the eye-to-block distance, nearest first. */
  tablesAround(): { p: Vec3; d: number }[] {
    const eye = this.eye();
    const f = { x: Math.floor(eye.x), y: Math.floor(this.d.loop.state.pos.y), z: Math.floor(eye.z) };
    const gap = (e: number, lo: number) => Math.max(lo - e, 0, e - (lo + 1));
    const out: { p: Vec3; d: number }[] = [];
    for (let dx = -TABLE_SCAN; dx <= TABLE_SCAN; dx++)
      for (let dy = -2; dy <= 3; dy++)
        for (let dz = -TABLE_SCAN; dz <= TABLE_SCAN; dz++) {
          const p = { x: f.x + dx, y: f.y + dy, z: f.z + dz };
          if (this.d.world.blockAt(p)?.name !== TABLE) continue;
          out.push({ p, d: Math.hypot(gap(eye.x, p.x), gap(eye.y, p.y), gap(eye.z, p.z)) });
        }
    return out.sort((a, b) => a.d - b.d);
  }

  /** A table in reach with a clear line; else walk to the nearest one in the scan box (when the skills can walk). */
  private async findTable(cancelled: () => boolean): Promise<Vec3 | undefined> {
    const near = this.nearbyTable();
    if (near) return near;
    const sk = this.d.skills;
    if (!sk?.goto) return undefined;
    for (const t of this.tablesAround().slice(0, 2)) {
      if (cancelled()) return undefined;
      this.phase = `walking to the crafting table at ${fmt(t.p)}`;
      const r = await sk.goto({ type: 'getToBlock', p: t.p, reach: 3 }, { timeoutTicks: 600 });
      if (!r.ok) {
        this.log.info(`craft: table at ${fmt(t.p)}: ${r.reason ?? 'unreachable'}`);
        continue;
      }
      const again = this.nearbyTable();
      if (again) return again;
    }
    return undefined;
  }

  /** Cells next to the feet a table may go: empty, empty above, a full non-built, non-container block below. */
  tableSpots(): Vec3[] {
    const feet = this.d.loop.state.pos;
    return boxSpots((q) => this.d.world.blockAt(q), feet).filter((p) => {
      const below = this.d.world.blockAt({ x: p.x, y: p.y - 1, z: p.z });
      return !!below && !isBuiltBlock(below.name);
    });
  }

  /** Place a carried crafting table (crafting one from planks first when none is carried) on a free cell. */
  private async placeTable(cancelled: () => boolean): Promise<Vec3 | undefined> {
    const sk = this.d.skills;
    if (!sk) return undefined;
    const inv = this.d.world.inventory;
    const carried = () => inv.slots.some((s, i) => i < 36 && s?.name === TABLE && s.count > 0);
    if (!carried()) {
      const p = this.plan(TABLE, 1);
      if (!p || p.crafts <= 0 || p.table) {
        this.log.info('craft: no crafting table carried and none craftable (planks needed)');
        return undefined;
      }
      this.nested = true; // the nested craft (2 x 2, in the inventory screen) runs inside this one
      try {
        const r = await this.craft(TABLE, 1, cancelled);
        if (!r.ok) return undefined;
      } finally {
        this.nested = false;
      }
      if (!carried()) return undefined;
    }
    const spots = this.tableSpots();
    if (spots.length === 0) {
      this.log.info('craft: no free cell next to the bot for a crafting table');
      return undefined;
    }
    for (const p of spots.slice(0, 3)) {
      if (cancelled()) return undefined;
      this.phase = `placing a crafting table at ${fmt(p)}`;
      const r = await sk.place(p, { face: 'up', item: TABLE });
      if (r.ok) {
        this.log.info(`craft: crafting table placed at ${fmt(p)}`);
        return p;
      }
      this.log.info(`craft: place table at ${fmt(p)}: ${r.reason ?? 'failed'}`);
      if (r.reason === 'interrupted') return undefined;
    }
    return undefined;
  }

  private forgetTable(p: Vec3): void {
    const i = this.pendingTables.findIndex((q) => samePos(q, p));
    if (i >= 0) this.pendingTables.splice(i, 1);
  }

  /** Tables placed by earlier runs and left standing: pick up the ones within reach now (a pre-empted pick-up is retried here). */
  async pickUpPending(): Promise<void> {
    for (const p of [...this.pendingTables]) {
      const b = this.d.world.blockAt(p);
      if (!b) continue; // unloaded: keep it for later
      if (b.name !== TABLE) {
        this.forgetTable(p); // someone else took it
        continue;
      }
      const eye = this.eye();
      const gap = (e: number, lo: number) => Math.max(lo - e, 0, e - (lo + 1));
      if (Math.hypot(gap(eye.x, p.x), gap(eye.y, p.y), gap(eye.z, p.z)) > TABLE_REACH) continue;
      if (await this.pickUpTable(p)) this.forgetTable(p);
    }
  }

  /** Break the table the bot placed and pick it up; true when a table is back in the inventory. */
  private async pickUpTable(p: Vec3): Promise<boolean> {
    const sk = this.d.skills;
    if (!sk) return false;
    const inv = this.d.world.inventory;
    const count = () => inv.slots.reduce((a, s, i) => a + (i < 36 && s?.name === TABLE ? s.count : 0), 0);
    const before = count();
    if (this.d.world.blockAt(p)?.name !== TABLE) {
      this.log.warn(`craft: the table at ${fmt(p)} is gone (${this.d.world.blockAt(p)?.name ?? 'unloaded'})`);
      return count() > before;
    }
    this.phase = `picking up the crafting table at ${fmt(p)}`;
    const d = await sk.dig(p);
    if (!d.ok) {
      this.log.warn(`craft: breaking the table at ${fmt(p)}: ${d.reason ?? 'failed'} (kept in the pending list)`);
      return false;
    }
    for (let i = 0; i < 20 && count() <= before; i++) await this.d.loop.waitTicks(1); // it often lands at the feet
    if (count() <= before) await sk.collect(3, 100, { filter: (it) => it.name === TABLE });
    const ok = count() > before;
    this.log.info(`craft: table at ${fmt(p)} ${ok ? 'picked up' : 'NOT picked up'}`);
    return ok;
  }
}

export { usedText };
