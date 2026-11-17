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
//   Track K3 (ADR 0096 decision 13): cows farther out. MilkSightings remembers the milkable adults that went out of
//                view (where they were, MILK_SEEN_MS); farChoice picks the nearest within a range (`milkRange`) in view
//                or seen; beyond MILK_RADIUS the Milker walks there first (walkFar: the normal walk, its time from the
//                distance, stopped by a hostile within MILK_THREAT or the night), at most MILK_FAR_WALKS walks a run.
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
/** Track K3: `milkRange` at most (blocks, horizontal; the setting's max). */
export const MILK_RANGE_MAX = 96;
/** Track K3: a mob farther than MILK_RADIUS is looked for at most this many blocks above or below the centre (terrain, not a cave). */
export const MILK_FAR_DY = 16;
/** Track K3: a mob seen and gone out of view is remembered where it was this long (ms). */
export const MILK_SEEN_MS = 30 * 60_000;
/** Track K3: the far walk's time budget (ticks per block of straight line, and at least). */
export const MILK_WALK_TICKS_PER_BLOCK = 20;
export const MILK_WALK_MIN_TICKS = 300;
/** Track K3: far walks per run at most (a mob that keeps walking off, sightings that were empty). */
export const MILK_FAR_WALKS = 4;

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
  /** The chests at home are in reach (homeChestReach; HomeLogistics.atHome counts too): they are a source only then. */
  atHome: boolean;
  /** Why they are out of reach (homeChestReach's `why`), for the plan's short. */
  homeWhy?: string | undefined;
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

/**
 * Track K2 (ADR 0096 addendum): are the chests at home in reach of `!milk`, the chore and the trip readiness (`!milk`
 * took nothing next to 213 buckets with the bot outside the logistics' 8 blocks)? Track K3: the rule lives with the home
 * logistics (home/reach.ts), whose withdrawal makes room first by the same rule.
 */
export { HOME_REACH_DY as MILK_HOME_DY, HOME_REACH_EXTRA as MILK_HOME_EXTRA, homeChestReach } from '../home/reach.ts';

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
      plan.short = !anyBucket ? c.why : atHomeN > 0 ? `${need} more: ${atHomeN} bucket${atHomeN === 1 ? '' : 's'} in the chests at home, ${i.homeWhy ? `out of reach: ${i.homeWhy}` : 'taken there'}` : `${need} more need a bucket`;
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
  /** Track K3: blocks above or below the centre (default MILK_DY; a far look: MILK_FAR_DY). */
  dy?: number;
}

/** The refill choice (see the file comment): the mobs to milk, nearest to the bot first. */
export function milkTargets(entities: Iterable<EntityInfo>, q: MilkTargetQuery): EntityInfo[] {
  const out: { e: EntityInfo; d: number }[] = [];
  for (const e of entities) {
    if (isPlayerEntity(e) || !milkKindOf(e.type)) continue;
    const rid = e.runtimeId;
    if (q.isBaby(rid) || q.isDead?.(rid) || q.ignored?.(rid)) continue;
    const f = entityFeet(e);
    if (Math.hypot(f.x - q.center.x, f.z - q.center.z) > q.radius || Math.abs(f.y - q.center.y) > (q.dy ?? MILK_DY)) continue;
    if (q.blockAt && wetCell(q.blockAt, f)) continue;
    out.push({ e, d: Math.hypot(f.x - q.me.x, f.y - q.me.y, f.z - q.me.z) });
  }
  return out.sort((a, b) => a.d - b.d).map((x) => x.e);
}

/** Track K3: a milkable mob seen and gone out of view: where it was last, when. */
export interface MilkSighting {
  rid: bigint;
  kind: string;
  feet: Vec3;
  /** ms (the sightings' clock). */
  at: number;
}

/**
 * Track K3 (ADR 0096 decision 13): the milkable adults the bot has seen, by where they were when they went out of view
 * (the server removes an entity beyond its view range; a cow grazes within a few blocks of where it was). Kept
 * MILK_SEEN_MS; a mob back in view is the live entity again; one gone dead, or not there when the bot came, is forgotten.
 */
export class MilkSightings {
  private readonly seen = new Map<bigint, MilkSighting>();
  private readonly now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  /** An entity went out of view: remembered when it is a milkable adult (`baby`, `dead`: what the trackers knew then). */
  gone(e: EntityInfo, baby: boolean, dead: boolean): void {
    const kind = milkKindOf(e.type);
    if (!kind || isPlayerEntity(e) || baby || dead) return;
    this.seen.set(e.runtimeId, { rid: e.runtimeId, kind, feet: entityFeet(e), at: this.now() });
  }

  forget(rid: bigint): void {
    this.seen.delete(rid);
  }

  /** The sightings still fresh and not in view now (`live`: the tracked entities). */
  list(live: ReadonlyMap<bigint, unknown>): MilkSighting[] {
    const t = this.now();
    const out: MilkSighting[] = [];
    for (const [rid, s] of this.seen) {
      if (t - s.at > MILK_SEEN_MS) this.seen.delete(rid);
      else if (!live.has(rid)) out.push(s);
    }
    return out;
  }

  get size(): number {
    return this.seen.size;
  }
}

/** Track K3: one candidate of the range choice (a mob in view, or a sighting). */
export interface FarCandidate {
  rid: bigint;
  kind: string;
  feet: Vec3;
  /** Horizontal distance from the centre. */
  d: number;
  /** In view now (false: a sighting, `ago` ms old). */
  live: boolean;
  ago?: number;
}

/**
 * Track K3 (ADR 0096 decision 13): the range choice of `!milk far` (and the chore with `milkRange` raised): the nearest
 * milkable adult within `range` of the centre (horizontal; at most MILK_FAR_DY up or down), in view or seen there
 * within MILK_SEEN_MS, not standing in water or lava (a mob in view), not ignored; `nearest` is the nearest one known at
 * any distance (the reply names it when none is within the range).
 */
export function farChoice(live: Iterable<EntityInfo>, sightings: readonly MilkSighting[], q: MilkTargetQuery & { now: number }): { target?: FarCandidate; nearest?: FarCandidate } {
  const all: FarCandidate[] = [];
  const dy = q.dy ?? MILK_FAR_DY;
  for (const e of milkTargets(live, { ...q, radius: Infinity, dy: Infinity })) {
    const f = entityFeet(e);
    all.push({ rid: e.runtimeId, kind: milkKindOf(e.type)!, feet: f, d: Math.hypot(f.x - q.center.x, f.z - q.center.z), live: true });
  }
  for (const s of sightings) {
    if (q.ignored?.(s.rid) || q.isDead?.(s.rid)) continue;
    all.push({ rid: s.rid, kind: s.kind, feet: s.feet, d: Math.hypot(s.feet.x - q.center.x, s.feet.z - q.center.z), live: false, ago: Math.max(0, q.now - s.at) });
  }
  all.sort((a, b) => a.d - b.d || Number(b.live) - Number(a.live));
  const target = all.find((c) => c.d <= q.radius && Math.abs(c.feet.y - q.center.y) <= dy);
  return { ...(target ? { target } : {}), ...(all[0] ? { nearest: all[0] } : {}) };
}

/** `a cow 80 blocks away` / `a goat 52 blocks away (seen 3 min ago)`. */
export function candidateLine(c: FarCandidate): string {
  const ago = c.live || c.ago === undefined ? '' : ` (seen ${c.ago < 60_000 ? `${Math.max(1, Math.round(c.ago / 1000))} s` : `${Math.round(c.ago / 60_000)} min`} ago)`;
  return `a ${c.kind} ${Math.round(c.d)} blocks away${ago}`;
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
  /** Track K3: day (a walk beyond MILK_RADIUS runs by day only); without it, always day. */
  isDay?(): boolean;
  /** Track K3: stop the running walk (the hostile or night watch of a far walk). */
  stopWalk?(): void;
  log?: Logger;
  now?: () => number;
}

export interface MilkOptions {
  center: Vec3;
  radius: number;
  /** Milk buckets wanted (at most the empty buckets carried). */
  want: number;
  /**
   * Track K3: `!milk far`: the mobs seen within `radius` count too (MilkSightings: walked to where they were), the
   * vertical limit is MILK_FAR_DY, and the nearest known one is named when none is within the radius.
   */
  far?: boolean;
}

export type MilkReason = 'done' | 'no_bucket' | 'no_mob' | 'hostile' | 'refused' | 'interrupted' | 'night' | 'walk_failed';

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
  /** Track K3: the farthest walk beyond MILK_RADIUS this run made (to a mob in view or to where one was seen). */
  walked?: FarCandidate;
  /** Track K3: with none within the radius, the nearest one known (`!milk far`'s reply names it). */
  nearest?: FarCandidate;
  /** Track K3: why a far walk ended short (`walk_failed`). */
  walkWhy?: string;
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
  /** Track K2: the pens of the mobs this run went to (by id): left and closed at the end. */
  private readonly pens = new Map<string, Pen>();
  /** Track K3: the milkable adults seen and gone out of view (commands-milk.ts feeds it from the entity tracker). */
  readonly sightings: MilkSightings;

  constructor(d: MilkerDeps) {
    this.d = d;
    this.log = d.log ?? silentLogger;
    this.now = d.now ?? (() => performance.now());
    this.sightings = new MilkSightings(this.now);
  }

  ignored(rid: bigint): boolean {
    const t = this.ignoredUntil.get(rid);
    return t !== undefined && this.now() < t;
  }

  private query(center: Vec3, radius: number, dy?: number): MilkTargetQuery {
    const d = this.d;
    return {
      center,
      radius,
      me: d.loop.state.pos,
      isBaby: (r) => d.isBaby(r),
      isDead: (r) => d.isDead?.(r) ?? false,
      ignored: (r) => this.ignored(r),
      ...(d.blockAt ? { blockAt: (p: Vec3) => d.blockAt!(p) } : {}),
      ...(dy !== undefined ? { dy } : {}),
    };
  }

  /** The mobs `milk` would go to now (the refill choice), nearest first; beyond MILK_RADIUS (Track K3) up to MILK_FAR_DY up or down. */
  targets(center: Vec3, radius: number): EntityInfo[] {
    const near = milkTargets(this.d.entities().values(), this.query(center, Math.min(radius, MILK_RADIUS)));
    if (radius <= MILK_RADIUS || near.length > 0) return near;
    return milkTargets(this.d.entities().values(), this.query(center, radius, MILK_FAR_DY));
  }

  /** Track K3: the range choice (farChoice) around `center`: in view and seen. */
  farChoice(center: Vec3, radius: number): { target?: FarCandidate; nearest?: FarCandidate } {
    const live = this.d.entities();
    return farChoice(live.values(), this.sightings.list(live), { ...this.query(center, radius, MILK_FAR_DY), now: this.now() });
  }

  /**
   * Track K3: the walk to a mob beyond MILK_RADIUS (or to where one was seen): the normal walk and its safety rules
   * (closeDoors), its time from the distance, watched every 5 ticks for a hostile within MILK_THREAT and for the night,
   * either of which stops it.
   */
  private async walkFar(c: FarCandidate, cancelled: () => boolean): Promise<{ r: 'arrived' | 'hostile' | 'night' | 'failed' | 'interrupted'; why?: string }> {
    const d = this.d;
    const me = d.loop.state.pos;
    const dist = Math.hypot(c.feet.x - me.x, c.feet.z - me.z);
    const timeoutTicks = Math.max(MILK_WALK_MIN_TICKS, Math.ceil(dist * MILK_WALK_TICKS_PER_BLOCK));
    this.log.info(`milk: walking to ${candidateLine({ ...c, d: dist })} (${timeoutTicks} ticks at most)`);
    let settled = false;
    let stop: { r: 'hostile' | 'night'; why: string } | undefined;
    const walk = d.mover.goto({ type: 'near', p: { x: c.feet.x, y: Math.floor(c.feet.y), z: c.feet.z }, r: 3 }, { timeoutTicks, closeDoors: true }).finally(() => {
      settled = true;
    });
    while (!settled) {
      await d.loop.waitTicks(5);
      if (settled) break;
      if (cancelled()) {
        d.stopWalk?.();
        break;
      }
      const t = d.threat?.();
      if (t) stop = { r: 'hostile', why: t };
      else if (d.isDay && !d.isDay()) stop = { r: 'night', why: 'night fell' };
      if (stop) {
        d.stopWalk?.();
        break;
      }
    }
    const r = await walk;
    if (cancelled()) return { r: 'interrupted' };
    if (stop) return stop;
    const left = Math.hypot(c.feet.x - d.loop.state.pos.x, c.feet.z - d.loop.state.pos.z);
    this.log.info(`milk: the walk to the ${c.kind} ended ${r.ok ? 'there' : `(${r.reason ?? 'failed'})`}, ${left.toFixed(1)} blocks from it`);
    if (!r.ok && left > MILK_RADIUS / 2) return { r: 'failed', why: r.reason ?? 'failed' };
    return { r: 'arrived' };
  }

  async milk(o: MilkOptions, cancelled: () => boolean): Promise<MilkResult> {
    const t0 = this.now();
    this.totals.runs++;
    this.pens.clear();
    const res: MilkResult = { ok: false, reason: 'done', milked: 0, kinds: {}, refused: 0, ms: 0 };
    const finish = async (reason: MilkReason): Promise<MilkResult> => {
      this.current = undefined;
      // inside a pen: out of it, closing the gate behind (the animals stay in)
      if (reason !== 'interrupted' && !cancelled()) await this.leavePen(cancelled);
      res.reason = reason;
      res.ok = res.milked > 0 && (reason === 'done' || res.milked >= o.want);
      res.ms = this.now() - t0;
      this.log.info(`milk: ${res.milked} of ${o.want} milked (${kindsLine(res.kinds)}; ${reason}${res.threat ? `: ${res.threat}` : ''}${res.walked ? `; walked to ${candidateLine(res.walked)}` : ''}) in ${short(res.ms)}`);
      return res;
    };
    // Track K3: the sightings walked to in this run (not there: forgotten; never twice), the far walks made
    const tried = new Set<bigint>();
    let walks = 0;
    const noMore = (): MilkReason => (res.milked > 0 ? 'done' : res.walkWhy ? 'walk_failed' : res.refused > 0 ? 'refused' : 'no_mob');
    while (res.milked < o.want) {
      if (cancelled()) return finish('interrupted');
      const threat = this.d.threat?.();
      if (threat) {
        res.threat = threat;
        return finish('hostile');
      }
      if (bucketCounts(this.d.inventory.slots).empty <= 0) return finish(res.milked > 0 ? 'done' : 'no_bucket');
      const target = this.targets(o.center, o.radius)[0];
      // Track K3: none in view within the radius: where one was seen (`!milk far`)
      if (!target && o.far) {
        const ch = this.farChoice(o.center, o.radius);
        const seen = ch.target && !ch.target.live && !tried.has(ch.target.rid) ? ch.target : undefined;
        if (!seen) {
          if (res.milked === 0 && ch.nearest && !ch.target) res.nearest = ch.nearest;
          return finish(noMore());
        }
        if (walks++ >= MILK_FAR_WALKS) return finish(noMore());
        tried.add(seen.rid);
        if (this.d.isDay && !this.d.isDay()) return finish('night');
        const w = await this.walkFar(seen, cancelled);
        if (w.r === 'interrupted') return finish('interrupted');
        if (w.r === 'hostile' || w.r === 'night') {
          if (w.r === 'hostile') res.threat = w.why!;
          return finish(w.r);
        }
        if (!res.walked || seen.d > res.walked.d) res.walked = seen;
        if (w.r === 'failed') {
          res.walkWhy = w.why!;
          this.ignoredUntil.set(seen.rid, this.now() + MILK_IGNORE_MS);
          continue;
        }
        // there: the mob is in view again (the live target next round), or it is gone from there
        if (!this.d.entities().has(seen.rid)) {
          this.sightings.forget(seen.rid);
          this.log.info(`milk: no ${seen.kind} where one was seen`);
        }
        continue;
      }
      if (!target) return finish(noMore());
      // Track K3: a mob in view beyond MILK_RADIUS: the far walk first (watched for hostiles and the night)
      const tf = entityFeet(target);
      const me = this.d.loop.state.pos;
      const away = Math.hypot(tf.x - me.x, tf.z - me.z);
      if (away > MILK_RADIUS) {
        if (this.d.isDay && !this.d.isDay()) return finish('night');
        if (walks++ >= MILK_FAR_WALKS) return finish(noMore());
        const c: FarCandidate = { rid: target.runtimeId, kind: milkKindOf(target.type) ?? bareType(target.type), feet: tf, d: Math.hypot(tf.x - o.center.x, tf.z - o.center.z), live: true };
        const w = await this.walkFar(c, cancelled);
        if (w.r === 'interrupted') return finish('interrupted');
        if (w.r === 'hostile' || w.r === 'night') {
          if (w.r === 'hostile') res.threat = w.why!;
          return finish(w.r);
        }
        if (!res.walked || c.d > res.walked.d) res.walked = c;
        if (w.r === 'failed') {
          res.walkWhy = w.why!;
          this.ignoredUntil.set(target.runtimeId, this.now() + MILK_IGNORE_MS);
        }
        continue; // the target again from nearer (it may have moved)
      }
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
      const pen0 = d.penOf?.(e); // before the walk: the gate is still closed (an open one lets the fill escape)
      if (pen0) this.pens.set(pen0.id, pen0);
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
        const pen = d.penOf?.(d.entities().get(rid) ?? e) ?? pen0;
        if (pen) this.pens.set(pen.id, pen);
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
    // Track K2: the pens of the mobs milked count too: a bot that milked from the open gateway stands on the rim,
    // where the pen's fill from its own cell escapes through the gate (penAt undefined), and the gate stayed open
    const pens = [this.d.penAt?.(me), ...this.pens.values()].filter((p): p is Pen => !!p);
    const pen = pens.find((p) => inPenOrRim(p, me));
    if (pen && this.d.leavePen) {
      const r = await this.d.leavePen(pen, cancelled);
      this.log.info(`milk: left the pen (${r.ok ? 'ok' : (r.reason ?? 'failed')}, ${r.closed} gate(s) closed)`);
      return;
    }
    // outside every pen: a gate it opened and walked back out of is closed when within reach
    for (const p of this.pens.values()) {
      if (cancelled() || !this.d.closeGates) break;
      const n = await this.d.closeGates(p, cancelled);
      if (n > 0) this.log.info(`milk: closed ${n} gate(s) of the pen`);
    }
  }
}
