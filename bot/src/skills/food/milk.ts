// Track K1 (ADR 0096, docs/pve.md "Milk on hand"): milk on hand for Track M7's `milkCure` (a milk bucket clears the
// witch's poison in one drink and leaves an empty bucket). Pure rules plus the Milker skill:
//
//   planMilk     the stock rule: the milk buckets missing to `milkKeep`, the cheapest source first (the carried boxes,
//                the chests at home when the bot is there, then cows with the empty buckets, the buckets themselves
//                out of the boxes or the chests, and with no bucket anywhere one crafted from 3 iron ingots)
//   craftChoice  the early game: one bucket at most, only with no bucket of either kind carried, boxed or at home,
//                `milkCraft` on, 3 iron ingots on hand and a crafting table near (or one carried)
//   milkTargets  the refill choice: adult cows, mooshrooms and goats within the radius of the centre, at most MILK_DY
//                above or below it, not standing in water or lava, nearest to the bot first
//   Milker       one mob after the other: walk next to it (the normal walk with its safety rules, closeDoors; a gate of a
//                pen is closed behind and the pen left after), the empty bucket in the hand, look at it, and the
//                right click on a mob (breed.ts feedTransaction: the packet the feeding uses, verified for the bucket
//                on BDS 1.26.60 by the e2e home-milk: one empty bucket less, one milk bucket more within 2 to 3
//                ticks). A cow gives milk again at once (no cooldown in vanilla), so one cow fills every bucket.
//                A hostile within MILK_THREAT ends it (`hostile`): guard and flee take over as for any chore.
import { silentLogger, type Logger } from '../../log.ts';
import type { BlockInfo, EntityInfo, ItemStack, Vec3 } from '../../world/types.ts';
import { bareType, entityFeet, entitySize, isPlayerEntity } from '../combat/hostiles.ts';
import { EYE_HEIGHT, lookAngles } from '../dig/look.ts';
import { feedTransaction, type BreedHotbar, type BreedLoop, type BreedMover, type BreedPuller } from './breed.ts';
import { insidePen, inPenOrRim, type Pen } from './pen.ts';

export const MILK = 'milk_bucket';
export const BUCKET = 'bucket';
/** Mobs a bucket milks (Bedrock ids without the namespace). */
export const MILK_MOBS: readonly string[] = ['cow', 'mooshroom', 'goat'];
/** `!milk` and the chore milk only within this many blocks (horizontal) of their centre (the bot; home for the chore). */
export const MILK_RADIUS = 24;
/** ... and at most this many blocks above or below it (no cow in a cave under the base, none on a cliff over it). */
export const MILK_DY = 4;
/** Iron ingots a bucket takes. */
export const BUCKET_IRON = 3;
/** Eye to the mob's aim point for the click. */
export const MILK_REACH = 3;
/** A mob that did not give milk (or could not be reached) is left alone this long (ms). */
export const MILK_IGNORE_MS = 30_000;
/** A hostile this near ends the milking (guard and flee own the fight). */
export const MILK_THREAT = 16;

const bare = (n: string): string => (n.startsWith('minecraft:') ? n.slice(10) : n);

/** The milkable kind of an entity type (`minecraft:cow` -> `cow`), or undefined. */
export function milkKindOf(type: string): string | undefined {
  const t = bareType(type);
  return MILK_MOBS.includes(t) ? t : undefined;
}

/** Milk buckets and empty buckets in slots 0..35. */
export function bucketCounts(slots: readonly ({ name: string; count: number } | null | undefined)[]): { milk: number; empty: number } {
  let milk = 0;
  let empty = 0;
  for (let i = 0; i < Math.min(36, slots.length); i++) {
    const s = slots[i];
    if (!s || s.count <= 0) continue;
    const n = bare(s.name);
    if (n === MILK) milk += s.count;
    else if (n === BUCKET) empty += s.count;
  }
  return { milk, empty };
}

/** What the stock rule reads (the inventory, the carried boxes, the chest memory at home, the iron and the table). */
export interface MilkStockInput {
  /** `milkKeep` (or more: `!milk` fills every empty bucket carried). */
  keep: number;
  /** Loose (slots 0..35). */
  milk: number;
  empty: number;
  /** Inside the carried shulker boxes (Supply.carried). */
  boxedMilk: number;
  boxedEmpty: number;
  /** In the chests at home (the chest memory: Supply.available). */
  homeMilk: number;
  homeEmpty: number;
  /** Within reach of the home chests (HomeLogistics.atHome): the chests are a source only then. */
  atHome: boolean;
  /** Loose iron ingots. */
  iron: number;
  /** `milkCraft`. */
  craft: boolean;
  /** A crafting table near (the crafter's scan box) or one carried. */
  table: boolean;
}

export type MilkStep =
  | { kind: 'boxes'; item: typeof MILK | typeof BUCKET; n: number }
  | { kind: 'home'; item: typeof MILK | typeof BUCKET; n: number }
  | { kind: 'craft'; n: 1 }
  | { kind: 'cows'; n: number };

export interface MilkPlan {
  /** Milk buckets missing to `keep` now. */
  want: number;
  steps: MilkStep[];
  /** Why the steps do not reach `keep` (the status and the reply say it). */
  short?: string;
}

/** The early game's bucket: craft one, or why not. */
export function craftChoice(i: Pick<MilkStockInput, 'craft' | 'iron' | 'table'> & { anyBucket: boolean }): { craft: true } | { craft: false; why: string } {
  if (i.anyBucket) return { craft: false, why: 'a bucket is carried or at home' };
  if (!i.craft) return { craft: false, why: 'no bucket (milkCraft is off)' };
  if (i.iron < BUCKET_IRON) return { craft: false, why: `no bucket and no iron (${BUCKET_IRON} iron ingots make one)` };
  if (!i.table) return { craft: false, why: 'no bucket and no crafting table near' };
  return { craft: true };
}

/**
 * The stock rule (see the file comment). `cows`: the plan may milk (and fetch or craft buckets for it); without it (the
 * trip readiness) only milk out of the boxes and the chests is taken.
 */
export function planMilk(i: MilkStockInput, o: { cows: boolean }): MilkPlan {
  const want = Math.max(0, Math.floor(i.keep) - i.milk);
  const plan: MilkPlan = { want, steps: [] };
  if (want <= 0) return plan;
  let need = want;
  const boxed = Math.min(need, i.boxedMilk);
  if (boxed > 0) {
    plan.steps.push({ kind: 'boxes', item: MILK, n: boxed });
    need -= boxed;
  }
  const home = i.atHome ? Math.min(need, i.homeMilk) : 0;
  if (home > 0) {
    plan.steps.push({ kind: 'home', item: MILK, n: home });
    need -= home;
  }
  if (need <= 0) return plan;
  if (!o.cows) {
    plan.short = `${need} more from a cow (!milk)`;
    return plan;
  }
  let buckets = Math.min(need, i.empty);
  const fromBoxes = Math.min(need - buckets, i.boxedEmpty);
  if (fromBoxes > 0) {
    plan.steps.push({ kind: 'boxes', item: BUCKET, n: fromBoxes });
    buckets += fromBoxes;
  }
  const fromHome = i.atHome ? Math.min(need - buckets, i.homeEmpty) : 0;
  if (fromHome > 0) {
    plan.steps.push({ kind: 'home', item: BUCKET, n: fromHome });
    buckets += fromHome;
  }
  if (buckets === 0) {
    const anyBucket = i.milk + i.empty + i.boxedMilk + i.boxedEmpty + i.homeMilk + i.homeEmpty > 0;
    const c = craftChoice({ craft: i.craft, iron: i.iron, table: i.table, anyBucket });
    if (c.craft) {
      plan.steps.push({ kind: 'craft', n: 1 });
      buckets = 1;
    } else {
      const atHomeN = i.atHome ? 0 : i.homeMilk + i.homeEmpty;
      plan.short = !anyBucket ? c.why : atHomeN > 0 ? `${need} more: ${atHomeN} bucket${atHomeN === 1 ? '' : 's'} in the chests at home, taken there` : `${need} more need a bucket`;
      return plan;
    }
  }
  plan.steps.push({ kind: 'cows', n: buckets });
  if (buckets < need) plan.short ??= `${need - buckets} more need a bucket`;
  return plan;
}

const LIQUID = /water|lava/;

/** A cell the walk should not go into for a mob: water or lava at its feet or under them. */
export function wetCell(blockAt: (p: Vec3) => BlockInfo | undefined, feet: Vec3): boolean {
  const f = { x: Math.floor(feet.x), y: Math.floor(feet.y + 1e-6), z: Math.floor(feet.z) };
  for (const p of [f, { ...f, y: f.y - 1 }]) {
    const b = blockAt(p);
    if (b && LIQUID.test(bare(b.name))) return true;
  }
  return false;
}

export interface MilkTargetQuery {
  center: Vec3;
  radius: number;
  /** The bot's feet (nearest first). */
  me: Vec3;
  isBaby(rid: bigint): boolean;
  isDead?(rid: bigint): boolean;
  /** Left alone for now (did not give milk, or could not be reached). */
  ignored?(rid: bigint): boolean;
  blockAt?: (p: Vec3) => BlockInfo | undefined;
}

/** The refill choice (see the file comment): the mobs to milk, nearest to the bot first. */
export function milkTargets(entities: Iterable<EntityInfo>, q: MilkTargetQuery): EntityInfo[] {
  const out: { e: EntityInfo; d: number }[] = [];
  for (const e of entities) {
    if (isPlayerEntity(e) || !milkKindOf(e.type)) continue;
    const rid = e.runtimeId;
    if (q.isBaby(rid) || q.isDead?.(rid) || q.ignored?.(rid)) continue;
    const f = entityFeet(e);
    if (Math.hypot(f.x - q.center.x, f.z - q.center.z) > q.radius || Math.abs(f.y - q.center.y) > MILK_DY) continue;
    if (q.blockAt && wetCell(q.blockAt, f)) continue;
    out.push({ e, d: Math.hypot(f.x - q.me.x, f.y - q.me.y, f.z - q.me.z) });
  }
  return out.sort((a, b) => a.d - b.d).map((x) => x.e);
}

/** The click on a mob with the bucket (the same packet as the feeding: a right click on a mob, `interact`). */
export const milkTransaction = feedTransaction;

export interface MilkerDeps {
  entities: () => ReadonlyMap<bigint, EntityInfo>;
  mover: BreedMover;
  loop: BreedLoop;
  inventory: { readonly slots: readonly (ItemStack | null)[]; readonly selected: number };
  hotbar: BreedHotbar;
  /** Main inventory -> hotbar moves (CombatController.puller). */
  puller?: BreedPuller | undefined;
  source: { queue(name: string, params: Record<string, unknown>): void };
  isBaby(rid: bigint): boolean;
  isDead?(rid: bigint): boolean;
  blockAt?(p: Vec3): BlockInfo | undefined;
  /** The pen of a mob, and the pen around a feet position (food/pen.ts). */
  penOf?(e: EntityInfo): Pen | undefined;
  penAt?(feet: Vec3): Pen | undefined;
  leavePen?(pen: Pen, cancelled: () => boolean): Promise<{ ok: boolean; closed: number; reason?: string | undefined }>;
  closeGates?(pen: Pen, cancelled: () => boolean): Promise<number>;
  /** A hostile near (its name and distance), or undefined. */
  threat?(): string | undefined;
  log?: Logger;
  now?: () => number;
}

export interface MilkOptions {
  center: Vec3;
  radius: number;
  /** Milk buckets wanted (at most the empty buckets carried). */
  want: number;
}

export type MilkReason = 'done' | 'no_bucket' | 'no_mob' | 'hostile' | 'refused' | 'interrupted';

export interface MilkResult {
  ok: boolean;
  reason: MilkReason;
  milked: number;
  /** By kind (`cow`: 2). */
  kinds: Record<string, number>;
  /** Clicks the server did not answer with milk. */
  refused: number;
  /** The hostile that ended it. */
  threat?: string;
  ms: number;
}

const short = (s: number): string => `${Math.round(s / 100) / 10} s`;

/** `2 milk_bucket from a cow` / `1 from a cow and 1 from a goat`. */
export function kindsLine(kinds: Readonly<Record<string, number>>): string {
  const parts = Object.entries(kinds).map(([k, v]) => `${v} from a ${k}`);
  return parts.length ? parts.join(' and ') : 'none';
}

export class Milker {
  private readonly d: MilkerDeps;
  private readonly log: Logger;
  private readonly now: () => number;
  /** runtime id -> left alone until (ms, deps.now()). */
  private readonly ignoredUntil = new Map<bigint, number>();
  readonly totals = { milked: 0, refused: 0, runs: 0 };
  /** The mob being milked now. */
  current: { kind: string; runtimeId: bigint } | undefined;

  constructor(d: MilkerDeps) {
    this.d = d;
    this.log = d.log ?? silentLogger;
    this.now = d.now ?? (() => performance.now());
  }

  ignored(rid: bigint): boolean {
    const t = this.ignoredUntil.get(rid);
    return t !== undefined && this.now() < t;
  }

  /** The mobs `milk` would go to now (the refill choice), nearest first. */
  targets(center: Vec3, radius: number): EntityInfo[] {
    const d = this.d;
    return milkTargets(d.entities().values(), {
      center,
      radius,
      me: d.loop.state.pos,
      isBaby: (r) => d.isBaby(r),
      isDead: (r) => d.isDead?.(r) ?? false,
      ignored: (r) => this.ignored(r),
      ...(d.blockAt ? { blockAt: (p: Vec3) => d.blockAt!(p) } : {}),
    });
  }

  async milk(o: MilkOptions, cancelled: () => boolean): Promise<MilkResult> {
    const t0 = this.now();
    this.totals.runs++;
    const res: MilkResult = { ok: false, reason: 'done', milked: 0, kinds: {}, refused: 0, ms: 0 };
    const finish = async (reason: MilkReason): Promise<MilkResult> => {
      this.current = undefined;
      // inside a pen: out of it, closing the gate behind (the animals stay in)
      if (reason !== 'interrupted' && !cancelled()) await this.leavePen(cancelled);
      res.reason = reason;
      res.ok = res.milked > 0 && (reason === 'done' || res.milked >= o.want);
      res.ms = this.now() - t0;
      this.log.info(`milk: ${res.milked} of ${o.want} milked (${kindsLine(res.kinds)}; ${reason}${res.threat ? `: ${res.threat}` : ''}) in ${short(res.ms)}`);
      return res;
    };
    while (res.milked < o.want) {
      if (cancelled()) return finish('interrupted');
      const threat = this.d.threat?.();
      if (threat) {
        res.threat = threat;
        return finish('hostile');
      }
      if (bucketCounts(this.d.inventory.slots).empty <= 0) return finish(res.milked > 0 ? 'done' : 'no_bucket');
      const target = this.targets(o.center, o.radius)[0];
      if (!target) return finish(res.milked > 0 ? 'done' : res.refused > 0 ? 'refused' : 'no_mob');
      const kind = milkKindOf(target.type) ?? bareType(target.type);
      const r = await this.milkOne(target, kind, cancelled);
      if (r === 'interrupted') return finish('interrupted');
      if (r === 'milked') {
        res.milked++;
        res.kinds[kind] = (res.kinds[kind] ?? 0) + 1;
      } else {
        if (r === 'refused') res.refused++;
        this.ignoredUntil.set(target.runtimeId, this.now() + MILK_IGNORE_MS);
      }
    }
    return finish('done');
  }

  /** One mob: approach, the bucket in the hand, look, click, wait for the milk. */
  private async milkOne(e0: EntityInfo, kind: string, cancelled: () => boolean): Promise<'milked' | 'refused' | 'gone' | 'interrupted'> {
    const d = this.d;
    const rid = e0.runtimeId;
    this.current = { kind, runtimeId: rid };
    for (let attempt = 0; attempt < 3; attempt++) {
      const e = d.entities().get(rid);
      if (!e || d.isDead?.(rid)) return 'gone';
      const eye = (): Vec3 => {
        const p = d.loop.state.pos;
        return { x: p.x, y: p.y + EYE_HEIGHT, z: p.z };
      };
      const aim = (): Vec3 => {
        const cur = d.entities().get(rid) ?? e;
        const ff = entityFeet(cur);
        return { x: ff.x, y: ff.y + entitySize(cur.type).h * 0.6, z: ff.z };
      };
      const far = (): number => Math.hypot(aim().x - eye().x, aim().y - eye().y, aim().z - eye().z);
      if (far() > MILK_REACH - 0.5) {
        const f = entityFeet(e);
        const r = await d.mover.goto({ type: 'near', p: { x: f.x, y: Math.floor(f.y), z: f.z }, r: 1.8 }, { timeoutTicks: 300, closeDoors: true });
        if (cancelled()) return 'interrupted';
        if (!r.ok && r.reason === 'unreachable') return 'gone';
        const pen = d.penOf?.(d.entities().get(rid) ?? e);
        if (pen && d.closeGates && insidePen(pen, d.loop.state.pos)) await d.closeGates(pen, cancelled);
        if (cancelled()) return 'interrupted';
      }
      const slot = await this.holdBucket();
      if (cancelled()) return 'interrupted';
      if (slot === undefined) return 'refused';
      if (far() > MILK_REACH) continue; // it walked off: approach again
      d.loop.setCommand(lookAngles(eye(), aim()));
      await d.loop.waitTicks(2);
      if (cancelled()) return 'interrupted';
      const before = bucketCounts(d.inventory.slots).milk;
      const now = aim();
      const cur = d.entities().get(rid) ?? e;
      d.source.queue('interact', { action_id: 'mouse_over_entity', target_entity_id: rid, has_position: true, position: { ...now } });
      d.source.queue('inventory_transaction', milkTransaction({ target: rid, hotbarSlot: slot, held: d.hotbar.rawItem(slot), eye: eye(), click: { x: now.x - cur.pos.x, y: now.y - cur.pos.y, z: now.z - cur.pos.z } }));
      for (let i = 0; i < 20; i++) {
        await d.loop.waitTicks(1);
        if (bucketCounts(d.inventory.slots).milk > before) {
          this.totals.milked++;
          this.log.info(`milk: ${kind} #${rid} milked (${i + 1} ticks)`);
          return 'milked';
        }
        if (cancelled()) return 'interrupted';
      }
      this.totals.refused++;
      this.log.info(`milk: ${kind} #${rid} gave no milk (attempt ${attempt + 1})`);
    }
    return 'refused';
  }

  /** Select a hotbar slot with an empty bucket (pulling one from the main inventory when needed). */
  private async holdBucket(): Promise<number | undefined> {
    const d = this.d;
    const isBucket = (it: ItemStack | null | undefined): boolean => !!it && it.count > 0 && bare(it.name) === BUCKET;
    if (isBucket(d.inventory.slots[d.inventory.selected])) return d.inventory.selected;
    let slot: number | undefined;
    for (let i = 0; i < 9 && slot === undefined; i++) if (isBucket(d.inventory.slots[i])) slot = i;
    if (slot === undefined && d.puller) {
      const r = await d.puller.pull('milk', (it) => (bare(it.name) === BUCKET ? 100 : 0), { select: true });
      if (r?.ok && isBucket(d.inventory.slots[d.inventory.selected])) return d.inventory.selected;
      for (let i = 0; i < 9 && slot === undefined; i++) if (isBucket(d.inventory.slots[i])) slot = i;
    }
    if (slot === undefined) return undefined;
    if (slot !== d.inventory.selected) {
      d.hotbar.select(slot);
      await d.loop.waitTicks(2);
    }
    return slot;
  }

  private async leavePen(cancelled: () => boolean): Promise<void> {
    const me = this.d.loop.state.pos;
    const pen = this.d.penAt?.(me);
    if (!pen || !inPenOrRim(pen, me) || !this.d.leavePen) return;
    const r = await this.d.leavePen(pen, cancelled);
    this.log.info(`milk: left the pen (${r.ok ? 'ok' : (r.reason ?? 'failed')}, ${r.closed} gate(s) closed)`);
  }
}
