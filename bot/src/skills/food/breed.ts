// Breeding (Track AF, wave 8; docs/food.md "Breeding"): feed pairs of adult animals with their food so
// they make a baby. Per animal: walk next to it (a `near` goal, 1.8 blocks), put the food in the hand
// (select the hotbar slot, or pull it from the main inventory with the combat skill's HotbarPuller),
// look at it, and send the same packet the client sends for a right click on a mob:
//
//   interact { action_id: 'mouse_over_entity', target_entity_id, position }       (the hover, harmless)
//   inventory_transaction { transaction_type: 'item_use_on_entity', transaction_data: { entity_runtime_id,
//     action_type: 'interact', hotbar_slot, hand: 'main_hand', held_item (wire item), player_pos (eye),
//     click_pos (the aim point relative to the mob's position) } }
//
// The server takes one item and puts the mob in love mode (actor flag `inlove` in set_entity_data); two
// mobs in love near each other walk together and a baby appears (add_entity with the `baby` flag)
// a few seconds later. Verified on BDS 1.26.60.6 by the food-breed e2e (docs/food.md "Packets").
// After feeding, the bot steps 4 blocks away from the pair (it would stand in their way) and waits up
// to 10 s for the babies. Parents can breed again after 5 minutes (vanilla); fed mobs are remembered
// for that long and never fed twice, and the hunt spares them (Hunter `spare`).
import { silentLogger, type Logger } from '../../log.ts';
import type { ItemV4 } from '../../world/packets.ts';
import type { EntityInfo, ItemStack, Vec3 } from '../../world/types.ts';
import { bareType, entityFeet, entitySize, isPlayerEntity } from '../combat/hostiles.ts';
import { EYE_HEIGHT, lookAngles } from '../dig/look.ts';
import type { Goal } from '../nav/goals.ts';
import type { GotoOptions, SkillResult } from '../types.ts';
import { foodKindOf } from './finder.ts';
import { inPenOrRim, insidePen, type Pen } from './pen.ts';

/** What each food animal eats to breed (Bedrock item ids without the namespace), preferred first. */
export const BREED_FOOD: Readonly<Record<string, readonly string[]>> = {
  cow: ['wheat'],
  mooshroom: ['wheat'],
  sheep: ['wheat'],
  pig: ['carrot', 'potato', 'beetroot'],
  chicken: ['wheat_seeds', 'beetroot_seeds', 'pumpkin_seeds', 'melon_seeds', 'torchflower_seeds', 'pitcher_pod'],
  rabbit: ['dandelion', 'yellow_flower', 'carrot', 'golden_carrot'],
};

/** Parents cannot breed again for this long (vanilla 5 minutes). */
export const BREED_COOLDOWN_MS = 5 * 60_000;
/** Feeding distance (eye to the mob's position). */
const FEED_REACH = 3;
/** Babies are counted within this many blocks of a pair. */
const BABY_RADIUS = 8;

const short = (name: string): string => (name.startsWith('minecraft:') ? name.slice(10) : name);

/** The breeding items of a kind (empty for non-food mobs). */
export function breedFoodOf(kind: string): readonly string[] {
  return BREED_FOOD[bareType(kind)] ?? [];
}

/** Items carried (slots 0..35) that a kind breeds with. */
export function breedItemCount(slots: readonly (ItemStack | null | undefined)[], kind: string): number {
  const food = breedFoodOf(kind);
  let n = 0;
  for (let i = 0; i < Math.min(slots.length, 36); i++) {
    const it = slots[i];
    if (it && it.count > 0 && food.includes(short(it.name))) n += it.count;
  }
  return n;
}

/** Score for the hotbar puller: a breeding item of `kind` (preferred first), else 0. */
export function breedItemScore(kind: string): (it: ItemStack) => number {
  const food = breedFoodOf(kind);
  return (it) => {
    const i = food.indexOf(short(it.name));
    return i < 0 ? 0 : 100 - i;
  };
}

const AIR_ITEM: ItemV4 & { extra: unknown } = { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 0, can_place_on: [], can_destroy: [] } };

/** The packet of a right click on a mob with the held item (BDS 1.26.60 shape). */
export function feedTransaction(a: { target: bigint; hotbarSlot: number; held: ItemV4 | undefined; eye: Vec3; click: Vec3 }): Record<string, unknown> {
  return {
    transaction: {
      legacy: { legacy_request_id: 0 },
      transaction_type: 'item_use_on_entity',
      actions: [],
      transaction_data: {
        entity_runtime_id: a.target,
        action_type: 'interact',
        hotbar_slot: a.hotbarSlot,
        hand: 'main_hand',
        held_item: a.held && a.held.network_id !== 0 ? a.held : AIR_ITEM,
        player_pos: { ...a.eye },
        click_pos: { ...a.click },
      },
    },
  };
}

export interface BreedMover {
  goto(goal: Goal, opts?: GotoOptions): Promise<SkillResult>;
}

export interface BreedLoop {
  readonly state: { readonly pos: Vec3 };
  setCommand(c: { yaw?: number; pitch?: number }): void;
  waitTicks(n: number): Promise<void>;
}

export interface BreedHotbar {
  select(slot: number): boolean;
  rawItem(slot: number): ItemV4 | undefined;
}

export interface BreedPuller {
  pull(job: string, score: (item: ItemStack) => number, opts?: { select?: boolean }): Promise<{ ok: boolean }> | undefined;
}

export interface BreederDeps {
  entities: () => ReadonlyMap<bigint, EntityInfo>;
  mover: BreedMover;
  loop: BreedLoop;
  inventory: { readonly slots: readonly (ItemStack | null)[]; readonly selected: number };
  hotbar: BreedHotbar;
  /** Main inventory -> hotbar moves (CombatController.puller). */
  puller?: BreedPuller | undefined;
  source: { queue(name: string, params: Record<string, unknown>): void };
  isBaby(rid: bigint): boolean;
  /** Love mode (the `inlove` flag); without it only the item count tells a feed worked. */
  isInLove?(rid: bigint): boolean;
  isDead?(rid: bigint): boolean;
  /** Babies first seen at or after `since` (performance.now() ms). */
  babiesSince?(since: number): bigint[];
  penOf?(e: EntityInfo): Pen | undefined;
  /** The pen around a feet position (the bot's: after feeding inside a pen it walks out, closing the gate). */
  penAt?(feet: Vec3): Pen | undefined;
  /** Walk out of a pen and close its gates (pen.ts leavePen). */
  leavePen?(pen: Pen, cancelled: () => boolean): Promise<{ ok: boolean; closed: number; reason?: string | undefined }>;
  /** Close the open gates of a pen within reach (pen.ts closePenGates); after walking into a pen. */
  closeGates?(pen: Pen, cancelled: () => boolean): Promise<number>;
  log?: Logger;
  now?: () => number;
}

export interface BreedOptions {
  /** Kind to breed (`cow`); default: the kind with the most adults that the bot has food for. */
  kind?: string | undefined;
  /** Pairs to feed (each pair makes one baby). */
  pairs: number;
  /** Where to look for adults, and how far (horizontal). */
  center: Vec3;
  radius: number;
  /** Only animals of this pen. */
  pen?: Pen | undefined;
  /** Wait this long for the babies after feeding (ticks). Default 200 (10 s). */
  waitTicks?: number;
}

export type BreedReason = 'done' | 'no_food' | 'no_pair' | 'interrupted' | 'refused';

export interface BreedResult {
  ok: boolean;
  reason: BreedReason;
  kind: string | undefined;
  /** Animals fed (the server took the item). */
  fed: number;
  /** Pairs fully fed. */
  pairs: number;
  /** Babies that appeared near the pairs within the wait. */
  babies: number;
  /** Feeds the server did not take (no item used, no love mode). */
  refused: number;
  ms: number;
}

/** Adult food mobs that may be fed now: not babies, not dead, not in love, not fed within the cooldown. */
export function breedable(
  entities: Iterable<EntityInfo>,
  q: { kind?: string | undefined; center: Vec3; radius: number; isBaby(rid: bigint): boolean; isDead?(rid: bigint): boolean; isInLove?(rid: bigint): boolean; fedRecently?(rid: bigint): boolean; inPen?(e: EntityInfo): boolean },
): Map<string, EntityInfo[]> {
  const out = new Map<string, EntityInfo[]>();
  for (const e of entities) {
    if (isPlayerEntity(e)) continue;
    const kind = foodKindOf(e.type);
    if (!kind || (q.kind && q.kind !== kind)) continue;
    const rid = e.runtimeId;
    if (q.isBaby(rid) || q.isDead?.(rid) || q.isInLove?.(rid) || q.fedRecently?.(rid)) continue;
    const f = entityFeet(e);
    if (Math.hypot(f.x - q.center.x, f.z - q.center.z) > q.radius || Math.abs(f.y - q.center.y) > 8) continue;
    if (q.inPen && !q.inPen(e)) continue;
    const list = out.get(kind) ?? [];
    list.push(e);
    out.set(kind, list);
  }
  return out;
}

/**
 * The pair to feed from `list` (nearest to the bot first): the first animal with a partner in the same pen
 * (`penId`: undefined = not in a pen; two animals outside any pen pair up), and its nearest such partner.
 */
export function samePenPair(list: readonly EntityInfo[], penId: (e: EntityInfo) => string | undefined, dist: (a: Vec3, b: Vec3) => number): [EntityInfo, EntityInfo] | undefined {
  for (const a of list) {
    const id = penId(a);
    const fa = entityFeet(a);
    let best: EntityInfo | undefined;
    let bestD = Infinity;
    for (const b of list) {
      if (b === a || penId(b) !== id) continue;
      const dd = dist(entityFeet(b), fa);
      if (dd < bestD) {
        bestD = dd;
        best = b;
      }
    }
    if (best) return [a, best];
  }
  return undefined;
}

export class Breeder {
  private readonly d: BreederDeps;
  private readonly log: Logger;
  private readonly now: () => number;
  /** runtime id -> when it was fed (ms, deps.now()). */
  readonly fedAt = new Map<bigint, number>();
  /** Totals (status, measurements). */
  readonly totals = { fed: 0, refused: 0, pairs: 0, babies: 0 };
  /** The mob being fed right now. */
  current: { kind: string; runtimeId: bigint } | undefined;

  constructor(d: BreederDeps) {
    this.d = d;
    this.log = d.log ?? silentLogger;
    this.now = d.now ?? (() => performance.now());
  }

  /** Fed within the cooldown (the hunt spares it; it is not fed again). */
  fedRecently(rid: bigint): boolean {
    const t = this.fedAt.get(rid);
    return t !== undefined && this.now() - t < BREED_COOLDOWN_MS;
  }

  /** Breedable adults by kind around a point (for the chore and the replies). */
  candidates(o: Pick<BreedOptions, 'kind' | 'center' | 'radius' | 'pen'>): Map<string, EntityInfo[]> {
    const d = this.d;
    const pen = o.pen;
    return breedable(d.entities().values(), {
      kind: o.kind,
      center: o.center,
      radius: o.radius,
      isBaby: (r) => d.isBaby(r),
      isDead: (r) => d.isDead?.(r) ?? false,
      isInLove: (r) => d.isInLove?.(r) ?? false,
      fedRecently: (r) => this.fedRecently(r),
      ...(pen ? { inPen: (e: EntityInfo) => d.penOf?.(e)?.id === pen.id } : {}),
    });
  }

  /** The kind to breed: the given one, else the one with the most breedable adults (2+) and 2+ items carried. */
  chooseKind(o: Pick<BreedOptions, 'kind' | 'center' | 'radius' | 'pen'>): { kind: string | undefined; reason?: BreedReason } {
    const c = this.candidates(o);
    const slots = this.d.inventory.slots;
    if (o.kind) {
      if (breedItemCount(slots, o.kind) < 2) return { kind: o.kind, reason: 'no_food' };
      if ((c.get(o.kind)?.length ?? 0) < 2) return { kind: o.kind, reason: 'no_pair' };
      return { kind: o.kind };
    }
    let best: { kind: string; n: number } | undefined;
    let anyPair = false;
    for (const [kind, list] of c) {
      if (list.length < 2) continue;
      anyPair = true;
      if (breedItemCount(slots, kind) < 2) continue;
      if (!best || list.length > best.n) best = { kind, n: list.length };
    }
    if (best) return { kind: best.kind };
    return { kind: undefined, reason: anyPair ? 'no_food' : 'no_pair' };
  }

  async breed(o: BreedOptions, cancelled: () => boolean): Promise<BreedResult> {
    const t0 = this.now();
    const res: BreedResult = { ok: false, reason: 'done', kind: undefined, fed: 0, pairs: 0, babies: 0, refused: 0, ms: 0 };
    const finish = (reason: BreedReason): BreedResult => {
      this.current = undefined;
      res.reason = reason;
      res.ok = reason === 'done' && res.pairs > 0;
      res.ms = this.now() - t0;
      return res;
    };
    const pick = this.chooseKind(o);
    res.kind = pick.kind;
    if (pick.reason || !pick.kind) return finish(pick.reason ?? 'no_pair');
    const kind = pick.kind;
    const babiesFrom = performance.now();
    const mids: Vec3[] = [];
    for (let p = 0; p < o.pairs; p++) {
      if (cancelled()) return finish('interrupted');
      if (breedItemCount(this.d.inventory.slots, kind) < 2) {
        if (res.pairs === 0) return finish('no_food');
        break;
      }
      const list = this.candidates({ ...o, kind }).get(kind) ?? [];
      if (list.length < 2) {
        if (res.pairs === 0) return finish('no_pair');
        break;
      }
      const me = this.d.loop.state.pos;
      const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      list.sort((a, b) => dist(entityFeet(a), me) - dist(entityFeet(b), me));
      // the two of a pair stand on the same side of every fence (both in one pen, or both outside any): a pair
      // split by a fence ate the food, made no baby and was locked out for 5 minutes
      const pair = samePenPair(list, (e) => this.d.penOf?.(e)?.id, dist);
      if (!pair) {
        if (res.pairs === 0) return finish('no_pair');
        break;
      }
      const [a, b] = pair;
      let fedPair = 0;
      for (const e of [a, b]) {
        const r = await this.feed(e, kind, cancelled);
        if (r === 'interrupted') return finish('interrupted');
        if (r === 'fed') {
          fedPair++;
          res.fed++;
        } else if (r === 'refused') res.refused++;
      }
      if (fedPair === 2) {
        res.pairs++;
        this.totals.pairs++;
        const pa = entityFeet(this.d.entities().get(a.runtimeId) ?? a);
        const pb = entityFeet(this.d.entities().get(b.runtimeId) ?? b);
        mids.push({ x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2, z: (pa.z + pb.z) / 2 });
      } else if (res.fed === 0 && res.refused >= 2) {
        return finish('refused');
      }
    }
    if (mids.length === 0) return finish(res.refused > 0 ? 'refused' : 'no_pair');
    // stand clear of the pairs (4 blocks from the first pair, on the bot's side)
    await this.standClear(mids[0]!, cancelled);
    if (cancelled()) return finish('interrupted');
    const want = res.pairs;
    const wait = o.waitTicks ?? 200;
    for (let t = 0; t < wait; t += 5) {
      res.babies = this.babiesNear(babiesFrom, mids);
      if (res.babies >= want || cancelled()) break;
      await this.d.loop.waitTicks(5);
    }
    res.babies = this.babiesNear(babiesFrom, mids);
    this.totals.babies += res.babies;
    this.log.info(`breed: ${res.pairs} ${kind} pair(s) fed, ${res.babies} baby(ies) after ${Math.round((this.now() - t0) / 100) / 10} s`);
    return finish(cancelled() ? 'interrupted' : 'done');
  }

  private babiesNear(since: number, mids: readonly Vec3[]): number {
    const ids = this.d.babiesSince?.(since) ?? [];
    let n = 0;
    for (const rid of ids) {
      const e = this.d.entities().get(rid);
      if (!e) continue;
      const f = entityFeet(e);
      if (mids.some((m) => Math.hypot(f.x - m.x, f.z - m.z) <= BABY_RADIUS)) n++;
    }
    return n;
  }

  /** Feed one mob: approach, hold the food, look, click. */
  private async feed(e0: EntityInfo, kind: string, cancelled: () => boolean): Promise<'fed' | 'refused' | 'gone' | 'interrupted'> {
    const d = this.d;
    const rid = e0.runtimeId;
    this.current = { kind, runtimeId: rid };
    for (let attempt = 0; attempt < 3; attempt++) {
      const e = d.entities().get(rid);
      if (!e || d.isDead?.(rid)) return 'gone';
      const f = entityFeet(e);
      const eye = (): Vec3 => {
        const p = d.loop.state.pos;
        return { x: p.x, y: p.y + EYE_HEIGHT, z: p.z };
      };
      const aim = (): Vec3 => {
        const cur = d.entities().get(rid) ?? e;
        const ff = entityFeet(cur);
        return { x: ff.x, y: ff.y + entitySize(cur.type).h * 0.6, z: ff.z };
      };
      if (Math.hypot(aim().x - eye().x, aim().y - eye().y, aim().z - eye().z) > FEED_REACH - 0.5) {
        const r = await d.mover.goto({ type: 'near', p: { x: f.x, y: Math.floor(f.y), z: f.z }, r: 1.8 }, { timeoutTicks: 300, closeDoors: true });
        if (cancelled()) return 'interrupted';
        if (!r.ok && r.reason === 'unreachable') return 'gone';
        // walked into the pen: close the gate behind
        const pen = d.penOf?.(d.entities().get(rid) ?? e);
        if (pen && d.closeGates && insidePen(pen, d.loop.state.pos)) await d.closeGates(pen, cancelled);
        if (cancelled()) return 'interrupted';
      }
      // the food in the hand
      const slot = await this.holdFood(kind);
      if (cancelled()) return 'interrupted';
      if (slot === undefined) return 'refused';
      const target = aim();
      if (Math.hypot(target.x - eye().x, target.y - eye().y, target.z - eye().z) > FEED_REACH) continue; // it walked off: approach again
      d.loop.setCommand(lookAngles(eye(), target));
      await d.loop.waitTicks(2);
      if (cancelled()) return 'interrupted';
      const before = breedItemCount(d.inventory.slots, kind);
      const now = aim();
      const cur = d.entities().get(rid) ?? e;
      d.source.queue('interact', { action_id: 'mouse_over_entity', target_entity_id: rid, has_position: true, position: { ...now } });
      d.source.queue('inventory_transaction', feedTransaction({ target: rid, hotbarSlot: slot, held: d.hotbar.rawItem(slot), eye: eye(), click: { x: now.x - cur.pos.x, y: now.y - cur.pos.y, z: now.z - cur.pos.z } }));
      for (let i = 0; i < 20; i++) {
        await d.loop.waitTicks(1);
        if (breedItemCount(d.inventory.slots, kind) < before || d.isInLove?.(rid)) {
          this.fedAt.set(rid, this.now());
          this.totals.fed++;
          this.log.info(`breed: fed ${kind} #${rid} (${i + 1} ticks; in love ${d.isInLove?.(rid) ?? '?'})`);
          return 'fed';
        }
        if (cancelled()) return 'interrupted';
      }
      this.totals.refused++;
      this.log.info(`breed: ${kind} #${rid} did not take the food (attempt ${attempt + 1})`);
    }
    return 'refused';
  }

  /** Select a hotbar slot with the kind's food (pulling it from the main inventory when needed). */
  private async holdFood(kind: string): Promise<number | undefined> {
    const d = this.d;
    const score = breedItemScore(kind);
    const sel = d.inventory.slots[d.inventory.selected];
    if (sel && sel.count > 0 && score(sel) > 0) return d.inventory.selected;
    let best: { slot: number; s: number } | undefined;
    for (let i = 0; i < 9; i++) {
      const it = d.inventory.slots[i];
      if (!it || it.count <= 0) continue;
      const s = score(it);
      if (s > 0 && (!best || s > best.s)) best = { slot: i, s };
    }
    if (!best && d.puller) {
      const r = await d.puller.pull(`breed ${kind}`, score, { select: true });
      if (r?.ok) {
        const s2 = d.inventory.slots[d.inventory.selected];
        if (s2 && score(s2) > 0) return d.inventory.selected;
      }
      for (let i = 0; i < 9; i++) {
        const it = d.inventory.slots[i];
        if (it && it.count > 0 && score(it) > 0) best = { slot: i, s: score(it) };
      }
    }
    if (!best) return undefined;
    if (best.slot !== d.inventory.selected) {
      d.hotbar.select(best.slot);
      await d.loop.waitTicks(2);
    }
    return best.slot;
  }

  private async standClear(mid: Vec3, cancelled: () => boolean): Promise<void> {
    const me = this.d.loop.state.pos;
    // inside a pen: out of it, 2 blocks past its nearest side, closing the gate behind (animals stay in)
    // (the pair's pen; the bot counts as inside on its rim too, e.g. standing in the open gate)
    const pen = this.d.penAt?.(mid) ?? this.d.penAt?.(me);
    if (pen && inPenOrRim(pen, me) && this.d.leavePen) {
      const r = await this.d.leavePen(pen, cancelled);
      this.log.info(`breed: left the pen (${r.ok ? 'ok' : (r.reason ?? 'failed')}, ${r.closed} gate(s) closed)`);
      return;
    }
    let dx = me.x - mid.x;
    let dz = me.z - mid.z;
    const len = Math.hypot(dx, dz);
    if (len >= 4) return;
    if (len < 0.1) {
      dx = 1;
      dz = 0;
    } else {
      dx /= len;
      dz /= len;
    }
    const p = { x: mid.x + dx * 4, y: Math.floor(me.y), z: mid.z + dz * 4 };
    if (cancelled()) return;
    await this.d.mover.goto({ type: 'near', p, r: 1 }, { timeoutTicks: 100 });
  }
}
