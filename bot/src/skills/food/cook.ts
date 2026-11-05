// Cooking in a furnace or smoker (PLAN.md task 7.16, Track X, docs/food.md "Furnace packets").
// Verified on BDS 1.26.60.6 (bds-food, probe and e2e):
//
//   open    look at the block, inventory_transaction item_use / click_block on it (the chest click of
//           skills/container/chest.ts) -> container_open { window_id: 2 (the next free id),
//           window_type: 'furnace' | 'smoker', coordinates, runtime_entity_id: -1 } + inventory_content
//           for that window: 3 slots, 0 input, 1 fuel, 2 output; container_set_data properties
//           0 cook progress, 1 burn time left, 2 burn duration of the current fuel (furnace: coal 1600,
//           smoker: 800), 3 (0)
//   input   item_stack_request place { source: hotbar|inventory slot, destination:
//           { container_id: 'furnace_ingredient' (smoker: 'smoker_ingredient'), slot: 0 } }
//   fuel    item_stack_request place { destination: { container_id: 'furnace_fuel', slot: 1 } } (both)
//   output  item_stack_request take  { source: { container_id: 'furnace_output', slot: 2 }, destination:
//           an empty or matching hotbar / inventory slot }
//   close   container_close { window_id, window_type, server: false } -> the server's container_close
//           (window_type 'none')
// Every request answered `ok` with the slots' new counts and stack ids; the server also sends
// inventory_slot for the window's slots on every change (one cooked item every 200 ticks in a furnace,
// 100 in a smoker). Main-inventory slots (9..35) work while the furnace window is open (no inventory
// screen needed, as with a chest).
import { silentLogger, type Logger } from '../../log.ts';
import type { ItemV4 } from '../../world/packets.ts';
import type { BlockInfo, ContainerView, ItemStack, PacketSource, Vec3 } from '../../world/types.ts';
import { clickBlockTransaction, maxStackOf } from '../container/chest.ts';
import { blockCenter, EYE_HEIGHT, faceToward, lookAngles } from '../dig/look.ts';
import type { NavGoal } from '../nav/goals.ts';
import { wireItemOf } from '../place/place.ts';
import type { GotoOptions, SkillResult } from '../types.ts';
import { cookedOf, findCookers, fuelRank, fuelValue, isCooker, rawFoodCounts, type CookerFinder } from './finder.ts';

export const FURNACE_INPUT = 0;
export const FURNACE_FUEL = 1;
export const FURNACE_OUTPUT = 2;

/** Ticks per item: furnace 200, smoker 100. */
export function cookTicksOf(block: string): number {
  return block.includes('smoker') ? 100 : 200;
}

/** The item stack request container id of a cooker's input slot. */
export function inputSlotType(block: string): string {
  return block.includes('smoker') ? 'smoker_ingredient' : 'furnace_ingredient';
}

export interface FuelPlan {
  /** Inventory slots and counts to put into the fuel slot (all the same item). */
  moves: { slot: number; count: number }[];
  name: string;
  count: number;
  /** Items the planned fuel smelts (with what is already in the fuel slot). */
  covers: number;
}

/**
 * The fuel to add for `items` more items: enough to smelt them all, counting what lies in the fuel
 * slot already. The best fuel (fuelRank) that can go into the slot (empty, or the same item with room).
 * Undefined when nothing is needed or nothing fits.
 */
export function planFuel(items: number, slots: readonly (ItemStack | null | undefined)[], inSlot: ItemStack | null | undefined): FuelPlan | undefined {
  const have = inSlot ? inSlot.count * fuelValue(inSlot.name) : 0;
  if (have >= items) return undefined;
  const byName = new Map<string, { slot: number; count: number }[]>();
  for (let i = 0; i < Math.min(slots.length, 36); i++) {
    const it = slots[i];
    if (!it || it.count <= 0 || fuelValue(it.name) <= 0) continue;
    if (inSlot && inSlot.name !== it.name) continue;
    const l = byName.get(it.name) ?? [];
    l.push({ slot: i, count: it.count });
    byName.set(it.name, l);
  }
  const names = [...byName.keys()].sort((a, b) => fuelRank(a) - fuelRank(b) || fuelValue(b) - fuelValue(a));
  const name = names[0];
  if (!name) return undefined;
  const value = fuelValue(name);
  const room = maxStackOf(name) - (inSlot?.count ?? 0);
  let want = Math.min(room, Math.ceil((items - have) / value));
  const moves: { slot: number; count: number }[] = [];
  let count = 0;
  for (const s of byName.get(name)!) {
    if (want <= 0) break;
    const n = Math.min(s.count, want);
    moves.push({ slot: s.slot, count: n });
    want -= n;
    count += n;
  }
  if (count === 0) return undefined;
  return { moves, name, count, covers: have + count * value };
}

// ---- requests ---------------------------------------------------------------------------------------

interface StackResponseLike {
  status: 'ok' | 'error' | number;
  request_id: number;
  containers?: { slot_type: { container_id: string | number }; slots: { slot: number; count: number; item_stack_id?: number }[] }[];
}

export const isOkResponse = (r: { status: unknown }): boolean => r.status === 'ok' || r.status === 0;

export function slotInfo(containerId: string, slot: number, stackId: number | undefined): Record<string, unknown> {
  return { slot_type: { container_id: containerId }, slot, stack_id: stackId ?? 0 };
}

const playerSlotType = (slot: number): string => (slot < 9 ? 'hotbar' : 'inventory');

/**
 * Item stack requests with their own ids (from -200001 down, a range the other senders never reach:
 * world/containers.ts counts from -1, skills/survival/screen.ts from -100001). Containers still
 * applies every ok response to the model.
 */
export class CookRequests {
  private next = -200001;
  private readonly pending = new Map<number, (r: StackResponseLike) => void>();
  private readonly off: () => void;
  private readonly source: Pick<PacketSource, 'on' | 'queue'>;
  private readonly waitTicks: (n: number) => Promise<void>;

  constructor(source: Pick<PacketSource, 'on' | 'queue'>, waitTicks: (n: number) => Promise<void>) {
    this.source = source;
    this.waitTicks = waitTicks;
    this.off = source.on('item_stack_response', (p) => {
      for (const r of (p as unknown as { responses?: StackResponseLike[] }).responses ?? []) {
        const fn = this.pending.get(r.request_id);
        if (fn) {
          this.pending.delete(r.request_id);
          fn(r);
        }
      }
    });
  }

  dispose(): void {
    this.off();
    this.pending.clear();
  }

  async send(action: Record<string, unknown>, timeoutTicks = 40): Promise<StackResponseLike | { status: 'timeout'; request_id: number }> {
    const id = this.next;
    this.next -= 2;
    let got: StackResponseLike | undefined;
    this.pending.set(id, (r) => {
      got = r;
    });
    this.source.queue('item_stack_request', { requests: [{ request_id: id, actions: [action], custom_names: [], cause: 'chat_public' }] });
    for (let i = 0; i < timeoutTicks && !got; i++) await this.waitTicks(1);
    this.pending.delete(id);
    return got ?? { status: 'timeout', request_id: id };
  }
}

// ---- the cooker -------------------------------------------------------------------------------------

export interface CookLoop {
  readonly state: { pos: Vec3; ready: boolean };
  setCommand(c: { yaw?: number; pitch?: number }): void;
  waitTicks(n: number): Promise<void>;
}

export interface CookWorld extends CookerFinder {
  blockAt(p: Vec3): BlockInfo | undefined;
  readonly chunks: { runtimeIdAt(x: number, y: number, z: number): number | undefined };
  readonly inventory: {
    readonly slots: readonly (ItemStack | null)[];
    readonly selected: number;
    window(id: number): ContainerView | undefined;
    setItem(window: number, slot: number, item: ItemStack | null, raw?: ItemV4): void;
  };
}

export interface CookContainers {
  readonly open: { id: number; type: string; pos: Vec3 } | undefined;
  onOpen(fn: (c: { id: number; type: string; pos: Vec3 }) => void): () => void;
  onClose(fn: (id: number, byServer: boolean) => void): () => void;
  close(id: number, type?: string): void;
}

export interface CookMover {
  goto(goal: NavGoal, opts?: GotoOptions): Promise<SkillResult>;
}

export interface CookerDeps {
  source: Pick<PacketSource, 'on' | 'queue'>;
  loop: CookLoop;
  world: CookWorld;
  containers: CookContainers;
  hotbar?: { rawItem(slot: number): ItemV4 | undefined; noteRaw?(slot: number, item: ItemV4 | undefined): void };
  mover: CookMover;
  /** Where furnaces are looked for (within `radius`); the bot's position without a home. */
  home: () => Vec3 | undefined;
  log?: Logger;
}

export interface CookOptions {
  /** Furnaces within this radius of home. Default 16. */
  radius?: number;
  /**
   * Furnaces within this many blocks of the bot only, wherever home is (the food job after its hunt: a hunt
   * far from home keeps its raw food instead of walking home to cook it; `!cook` there cooks it later).
   */
  near?: number;
  /** Give up waiting this many ticks after the expected end. Default 200. */
  slackTicks?: number;
}

export type CookReason = 'done' | 'nothing_to_cook' | 'no_furnace' | 'no_furnace_near' | 'no_fuel' | 'unreachable' | 'open_failed' | 'furnace_busy' | 'request_failed' | 'timeout' | 'interrupted' | 'not_ready';

export interface CookResult {
  ok: boolean;
  reason: CookReason;
  /** Cooked items taken out, by name. */
  cooked: Record<string, number>;
  furnace?: Vec3;
  block?: string;
  /** Fuel put in, by name. */
  fuel: Record<string, number>;
  ticks: number;
}

const samePos = (a: Vec3, b: Vec3) => a.x === b.x && a.y === b.y && a.z === b.z;

export class Cooker {
  private readonly d: CookerDeps;
  private readonly log: Logger;
  private readonly req: CookRequests;
  /** State line for !status. */
  phase = 'idle';
  private ticks = 0;

  constructor(deps: CookerDeps) {
    this.d = deps;
    this.log = deps.log ?? silentLogger;
    this.req = new CookRequests(deps.source, (n) => this.wait(n));
  }

  dispose(): void {
    this.req.dispose();
  }

  /** Furnaces / smokers within the radius of home (else the bot; `near`: of the bot), nearest to the bot first. */
  furnaces(radius = 16, near = false): Vec3[] {
    const me = this.d.loop.state.pos;
    const origin = near ? me : (this.d.home() ?? me);
    return findCookers(this.d.world, origin, radius).sort((a, b) => Math.hypot(a.x + 0.5 - me.x, a.z + 0.5 - me.z) - Math.hypot(b.x + 0.5 - me.x, b.z + 0.5 - me.z));
  }

  /** True when there is raw food to cook and a fuel item (in the inventory). */
  canCook(): boolean {
    const slots = this.d.world.inventory.slots;
    return rawFoodCounts(slots).size > 0 && slots.some((s) => s !== null && s.count > 0 && fuelValue(s.name) > 0);
  }

  /** Walk to the nearest furnace near home, cook every raw food carried, take the output. */
  async cook(o: CookOptions, cancelled: () => boolean): Promise<CookResult> {
    const t0 = this.tick();
    const res: CookResult = { ok: false, reason: 'done', cooked: {}, fuel: {}, ticks: 0 };
    const done = (reason: CookReason): CookResult => {
      this.phase = 'idle';
      res.reason = reason;
      res.ok = reason === 'done';
      res.ticks = this.tick() - t0;
      return res;
    };
    const { world, loop } = this.d;
    if (!loop.state.ready) return done('not_ready');
    if (rawFoodCounts(world.inventory.slots).size === 0) return done('nothing_to_cook');
    const list = o.near !== undefined ? this.furnaces(o.near, true) : this.furnaces(o.radius ?? 16);
    if (list.length === 0) return done(o.near !== undefined ? 'no_furnace_near' : 'no_furnace');
    let opened: { id: number; type: string; block: string; pos: Vec3 } | undefined;
    for (const p of list) {
      if (cancelled()) return done('interrupted');
      this.phase = `walking to the ${world.blockAt(p)?.name ?? 'furnace'} at ${p.x} ${p.y} ${p.z}`;
      const walk = await this.d.mover.goto({ type: 'getToBlock', p, reach: 4 }, { timeoutTicks: 1200 });
      if (cancelled()) return done('interrupted');
      if (!walk.ok) {
        this.log.info(`cook: furnace ${p.x} ${p.y} ${p.z} unreachable (${walk.reason ?? '?'})`);
        continue;
      }
      opened = await this.open(p);
      if (opened) break;
    }
    if (!opened) return done(res.furnace ? 'open_failed' : 'unreachable');
    res.furnace = opened.pos;
    res.block = opened.block;
    try {
      // whatever lies in the output slot first (ours from an interrupted run, or anything else that fits)
      await this.takeOutput(opened, res);
      for (;;) {
        if (cancelled()) return done('interrupted');
        const r = await this.batch(opened, res, o, cancelled);
        if (r !== 'more') return done(r);
      }
    } finally {
      await this.close(opened);
    }
  }

  /** One input batch: put the largest raw stack kind in, fuel, wait, take out. */
  private async batch(w: { id: number; block: string; pos: Vec3 }, res: CookResult, o: CookOptions, cancelled: () => boolean): Promise<CookReason | 'more'> {
    const inv = this.d.world.inventory;
    const view = () => inv.window(w.id)?.slots ?? [];
    let input = view()[FURNACE_INPUT] ?? null;
    if (input && !cookedOf(input.name)) return 'furnace_busy';
    const raw = rawFoodCounts(inv.slots);
    if (!input) {
      const kinds = [...raw.entries()].sort((a, b) => b[1] - a[1]);
      const pick = kinds[0];
      if (!pick) return 'done';
      this.phase = `cooking ${pick[1]} ${pick[0]}`;
      const ok = await this.putInput(w, pick[0]);
      if (!ok) return 'request_failed';
    } else if ((raw.get(input.name) ?? 0) > 0) {
      // top up the stack that is cooking already
      if (!(await this.putInput(w, input.name))) return 'request_failed';
    }
    input = view()[FURNACE_INPUT] ?? null;
    if (!input) return 'done';
    const fuel = planFuel(input.count, inv.slots, view()[FURNACE_FUEL] ?? null);
    if (fuel) {
      for (const m of fuel.moves) {
        if (!(await this.place(w, m.slot, 'furnace_fuel', FURNACE_FUEL, m.count))) return 'request_failed';
      }
      res.fuel[fuel.name] = (res.fuel[fuel.name] ?? 0) + fuel.count;
    } else if (!view()[FURNACE_FUEL] && !this.burning(w)) {
      // nothing to burn: take the raw food back and keep it
      await this.takeBack(w, FURNACE_INPUT, inputSlotType(w.block));
      return 'no_fuel';
    }
    // wait until the input is used up (or the fuel ran out), taking the output as it grows
    const per = cookTicksOf(w.block);
    const deadline = this.tick() + input.count * per + (o.slackTicks ?? 200);
    let lastCount = input.count;
    let lastChange = this.tick();
    for (;;) {
      if (cancelled()) return 'interrupted';
      if (this.d.containers.open?.id !== w.id) return 'interrupted';
      await this.wait(10);
      const now = view()[FURNACE_INPUT] ?? null;
      const n = now?.count ?? 0;
      this.phase = `cooking ${now ? `${n} ${now.name}` : 'done'} (${res.block ?? 'furnace'})`;
      if (n !== lastCount) {
        lastCount = n;
        lastChange = this.tick();
      }
      if (n === 0) break;
      if (this.tick() > deadline) return 'timeout';
      // no progress for 2 items' time and nothing burning: out of fuel
      if (this.tick() - lastChange > 2 * per && !view()[FURNACE_FUEL]) {
        await this.takeOutput(w, res);
        await this.takeBack(w, FURNACE_INPUT, inputSlotType(w.block));
        return 'no_fuel';
      }
    }
    // the last item lands in the output slot with the input's last update
    await this.wait(2);
    await this.takeOutput(w, res);
    return rawFoodCounts(inv.slots).size > 0 ? 'more' : 'done';
  }

  /** The cooker block is lit (fuel burning). */
  private burning(w: { pos: Vec3 }): boolean {
    return this.d.world.blockAt(w.pos)?.name.startsWith('lit_') ?? false;
  }

  /** Ticks waited by this cooker (its own clock: every wait goes through wait()). */
  private tick(): number {
    return this.ticks;
  }

  private async wait(n: number): Promise<void> {
    await this.d.loop.waitTicks(n);
    this.ticks += n;
  }

  /** Move every stack of `name` from the inventory into the input slot (up to a full stack). */
  private async putInput(w: { id: number; block: string }, name: string): Promise<boolean> {
    const inv = this.d.world.inventory;
    const max = maxStackOf(name);
    for (let slot = 0; slot < 36; slot++) {
      const it = inv.slots[slot];
      if (it?.name !== name) continue;
      const cur = inv.window(w.id)?.slots[FURNACE_INPUT] ?? null;
      if (cur && cur.name !== name) return false;
      const room = max - (cur?.count ?? 0);
      if (room <= 0) break;
      if (!(await this.place(w, slot, inputSlotType(w.block), FURNACE_INPUT, Math.min(room, it.count)))) return false;
    }
    return true;
  }

  /** place `count` from player slot `slot` into the furnace slot; the model is predicted and reconciled. */
  private async place(w: { id: number }, slot: number, containerId: string, dst: number, count: number): Promise<boolean> {
    const inv = this.d.world.inventory;
    const it = inv.slots[slot];
    if (!it) return false;
    const cur = inv.window(w.id)?.slots[dst] ?? null;
    const before = cur;
    // predict the destination so the response's counts land on a known slot
    const predicted: ItemStack = cur ? { ...cur, count: cur.count + count } : { ...it, count };
    if (!cur) delete predicted.stackId;
    inv.setItem(w.id, dst, predicted);
    const r = await this.req.send({ type_id: 'place', legacy_type_id: 1, count, source: slotInfo(playerSlotType(slot), slot, it.stackId), destination: slotInfo(containerId, dst, cur?.stackId) });
    if (!isOkResponse(r)) {
      inv.setItem(w.id, dst, before);
      this.log.warn(`cook: place ${count} ${it.name} ${slot} -> ${containerId} ${dst}: ${String(r.status)}`);
      return false;
    }
    if (slot < 9) this.d.hotbar?.noteRaw?.(slot, wireItemOf(inv.slots[slot], undefined));
    return true;
  }

  /** Take the output stack into the inventory (a matching stack with room, else an empty slot). */
  private async takeOutput(w: { id: number }, res: CookResult): Promise<void> {
    const out = this.d.world.inventory.window(w.id)?.slots[FURNACE_OUTPUT] ?? null;
    if (!out) return;
    const n = await this.take(w, FURNACE_OUTPUT, 'furnace_output', out);
    if (n > 0) res.cooked[out.name] = (res.cooked[out.name] ?? 0) + n;
  }

  private async takeBack(w: { id: number }, slot: number, containerId: string): Promise<void> {
    const it = this.d.world.inventory.window(w.id)?.slots[slot] ?? null;
    if (it) await this.take(w, slot, containerId, it);
  }

  /** take from a furnace slot into the player inventory; returns the count moved. */
  private async take(w: { id: number }, src: number, containerId: string, item: ItemStack): Promise<number> {
    const inv = this.d.world.inventory;
    const max = maxStackOf(item.name);
    let dst = inv.slots.findIndex((s, i) => i < 36 && s !== null && s.name === item.name && s.metadata === item.metadata && s.count < max);
    if (dst < 0) dst = inv.slots.findIndex((s, i) => i < 36 && s === null);
    if (dst < 0) {
      this.log.warn(`cook: no room for ${item.count} ${item.name}`);
      return 0;
    }
    const cur = inv.slots[dst] ?? null;
    const n = Math.min(item.count, max - (cur?.count ?? 0));
    const predicted: ItemStack = cur ? { ...cur, count: cur.count + n } : { ...item, count: n };
    if (!cur) delete predicted.stackId;
    inv.setItem(0, dst, predicted);
    const r = await this.req.send({ type_id: 'take', legacy_type_id: 0, count: n, source: slotInfo(containerId, src, item.stackId), destination: slotInfo(playerSlotType(dst), dst, cur?.stackId) });
    if (!isOkResponse(r)) {
      inv.setItem(0, dst, cur);
      this.log.warn(`cook: take ${n} ${item.name} ${containerId} ${src} -> ${dst}: ${String(r.status)}`);
      return 0;
    }
    if (dst < 9) this.d.hotbar?.noteRaw?.(dst, wireItemOf(inv.slots[dst], undefined));
    return n;
  }

  /** Click the furnace and wait for its window and contents. */
  async open(pos: Vec3): Promise<{ id: number; type: string; block: string; pos: Vec3 } | undefined> {
    const { loop, world, containers, source } = this.d;
    const p = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
    const block = world.blockAt(p);
    if (!block || !isCooker(block)) return undefined;
    const stale = containers.open;
    if (stale) await this.close({ id: stale.id, type: stale.type });
    const eye = () => ({ x: loop.state.pos.x, y: loop.state.pos.y + EYE_HEIGHT, z: loop.state.pos.z });
    loop.setCommand(lookAngles(eye(), blockCenter(p)));
    await this.wait(2);
    let opened: { id: number; type: string; pos: Vec3 } | undefined;
    const off = containers.onOpen((c) => {
      if (samePos(c.pos, p)) opened = c;
    });
    const slot = world.inventory.selected;
    source.queue(
      'inventory_transaction',
      clickBlockTransaction({ pos: p, face: faceToward(eye(), p), hotbarSlot: slot, held: this.d.hotbar?.rawItem(slot), eye: eye(), blockRuntimeId: world.chunks.runtimeIdAt(p.x, p.y, p.z) ?? 0 }),
    );
    for (let i = 0; i < 40 && !opened; i++) await this.wait(1);
    off();
    if (!opened) {
      this.log.info(`cook: ${block.name} at ${p.x} ${p.y} ${p.z} did not open`);
      return undefined;
    }
    const id = opened.id;
    for (let i = 0; i < 20 && !world.inventory.window(id); i++) await this.wait(1);
    if (!world.inventory.window(id)) return undefined;
    this.log.info(`cook: opened ${block.name} at ${p.x} ${p.y} ${p.z} (window ${id}, ${opened.type})`);
    return { id, type: opened.type, block: block.name, pos: p };
  }

  async close(w: { id: number; type: string }): Promise<void> {
    const c = this.d.containers;
    if (c.open?.id !== w.id) return;
    let closed = false;
    const off = c.onClose((id) => {
      if (id === w.id) closed = true;
    });
    c.close(w.id, w.type);
    for (let i = 0; i < 20 && !closed; i++) await this.wait(1);
    off();
  }
}
