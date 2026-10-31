// Hunting for food (PLAN.md task 7.16, Track X, docs/food.md): pick the next passive food mob
// (finder.ts: adults only, never below `leave` of a kind within the radius), walk to it with a `near`
// goal, kill it with the combat skill (which refuses players on its own) and pick up the drops with
// the collect skill. Stops after `want` food items, when no target is left, or when cancelled.
//
//   const h = new Hunter({ entities, position, mover, combat, inventory, isBaby, isDead });
//   const r = await h.hunt({ want: 6, center, leave: () => 2 }, () => token !== myToken);
import { silentLogger, type Logger } from '../../log.ts';
import type { EntityInfo, ItemStack, Vec3 } from '../../world/types.ts';
import type { FightResult } from '../combat/combat.ts';
import { entityFeet } from '../combat/hostiles.ts';
import type { Goal } from '../nav/goals.ts';
import type { GotoOptions, SkillResult } from '../types.ts';
import { countHerd, foodItemCount, pickTarget, type FoodTarget, type HerdCount } from './finder.ts';
import { inPenOrRim, insidePen, type Pen } from './pen.ts'; // Track AF
import type { CollectOptions } from '../collect/collect.ts'; // Track AQ
import { isFoodDrop, isFoodItem, sweepItems } from '../collect/sweep.ts'; // Track AQ

export interface HuntMover {
  goto(goal: Goal, opts?: GotoOptions): Promise<SkillResult>;
  collect(radius: number, timeoutTicks: number, opts?: CollectOptions): Promise<unknown>; // Track AQ: opts (the floor sweep's filter)
}

export interface HuntCombat {
  fight(runtimeId: bigint): Promise<FightResult>;
}

export interface HunterDeps {
  entities: () => ReadonlyMap<bigint, EntityInfo>;
  /** Feet. */
  position: () => Vec3;
  mover: HuntMover;
  combat: HuntCombat;
  inventory: { readonly slots: readonly (ItemStack | null)[] };
  isBaby(rid: bigint): boolean;
  isDead?(rid: bigint): boolean;
  /** Track AF: the pen a mob stands in (pen.ts PenDetector); without it every mob is wild. */
  penOf?(e: EntityInfo): Pen | undefined;
  /** Track AF: never hunted (fed for breeding within the last 5 minutes). */
  spare?(rid: bigint): boolean;
  /** Track AF: the pen around a feet position; after hunting in a pen the bot walks out and closes the gate. */
  penAt?(feet: Vec3): Pen | undefined;
  /** Track AF: walk out of a pen and close its gates (pen.ts leavePen). */
  leavePen?(pen: Pen, cancelled: () => boolean): Promise<{ ok: boolean; closed: number; reason?: string | undefined }>;
  /** Track AF: close the open gates of a pen within reach (pen.ts closePenGates); after walking into a pen. */
  closeGates?(pen: Pen, cancelled: () => boolean): Promise<number>;
  log?: Logger;
  now?: () => number;
}

export interface HuntOptions {
  /** Food items to gather (inventory delta). */
  want: number;
  /** Centre of the search (the bot when the job started). */
  center: Vec3;
  /** Search radius. Default 48. */
  radius?: number;
  /** Adults of each kind to leave within the radius (read every pick: the `foodLeave` setting). */
  leave: () => number;
  /** Drops are picked up within this radius after a kill. Default 8. */
  collectRadius?: number;
  /** Called after every kill with the running totals. */
  onKill?: (r: { kind: string; gained: number; killed: number }) => void;
  /** Track AF: may penned animals of `kind` in `pen` be taken (down to PEN_KEEP adults)? Default never. */
  penAllowed?: (pen: Pen, kind: string) => boolean;
}

export type HuntReason = 'done' | 'none_left' | 'interrupted';

export interface HuntResult {
  ok: boolean;
  reason: HuntReason;
  /** Food items gained (inventory delta, measured around every kill and pickup). */
  gained: number;
  killed: number;
  /** Kills by kind. */
  kinds: Record<string, number>;
  fights: { kind: string; reason: string; ticks: number }[];
}

/** A target that failed is skipped this long (ms). */
export const IGNORE_MS = 30_000;
/** Closer than this the fight approaches by itself; farther, a near goal first. */
const APPROACH_FROM = 4;

export class Hunter {
  private readonly d: HunterDeps;
  private readonly log: Logger;
  private readonly now: () => number;
  /** runtime id -> skip until (ms). */
  readonly ignore = new Map<bigint, number>();
  /** The mob being hunted right now. */
  current: FoodTarget | undefined;
  /** Track AF: the pen of the last penned target. */
  private lastPen: Pen | undefined;

  constructor(deps: HunterDeps) {
    this.d = deps;
    this.log = deps.log ?? silentLogger;
    this.now = deps.now ?? (() => performance.now());
  }

  isBaby(rid: bigint): boolean {
    return this.d.isBaby(rid);
  }

  /** `cow 4+1 babies, pig 2` within `radius` of `center` (dead mobs left out); Track AF: `; in pens cow 2` for penned ones. */
  herdLine(center: Vec3, radius = 48): string {
    const pens = new Map<string, Map<string, HerdCount>>();
    const penOf = this.d.penOf?.bind(this.d);
    const herd = countHerd(this.d.entities().values(), { center, radius, isBaby: (rid) => this.d.isBaby(rid), isDead: (rid) => this.d.isDead?.(rid) ?? false, ...(penOf ? { penOf } : {}) }, pens);
    const line = (m: Map<string, HerdCount>): string[] => [...m.entries()].map(([k, c]) => `${k} ${c.adults}${c.babies ? `+${c.babies} ${c.babies === 1 ? 'baby' : 'babies'}` : ''}`);
    const parts = line(herd);
    const penned = new Map<string, HerdCount>();
    for (const m of pens.values()) {
      for (const [k, c] of m) {
        const t = penned.get(k) ?? { adults: 0, babies: 0 };
        t.adults += c.adults;
        t.babies += c.babies;
        penned.set(k, t);
      }
    }
    const p = line(penned);
    if (!parts.length && !p.length) return 'no food mobs';
    return `${parts.length ? parts.join(', ') : 'no wild food mobs'}${p.length ? `; in pens ${p.join(', ')}` : ''}`;
  }

  /** The target the next pick would choose (no side effects). */
  peek(o: Pick<HuntOptions, 'center' | 'radius' | 'leave' | 'penAllowed'>): FoodTarget | undefined {
    const now = this.now();
    const penOf = this.d.penOf?.bind(this.d);
    return pickTarget(this.d.entities().values(), {
      center: o.center,
      radius: o.radius ?? 48,
      leave: o.leave(),
      me: this.d.position(),
      isBaby: (rid) => this.d.isBaby(rid),
      isDead: (rid) => this.d.isDead?.(rid) ?? false,
      ignored: (rid) => (this.ignore.get(rid) ?? 0) > now || (this.d.spare?.(rid) ?? false),
      ...(penOf ? { penOf } : {}),
      ...(o.penAllowed ? { penAllowed: o.penAllowed } : {}),
    });
  }

  /** Track AF: walk towards a remembered herd (the normal walk; a fight or flight pre-empts the process). */
  walkTo(p: Vec3, r: number, timeoutTicks: number): Promise<SkillResult> {
    return this.d.mover.goto({ type: 'near', p: { x: p.x, y: Math.floor(p.y), z: p.z }, r }, { timeoutTicks });
  }

  async hunt(o: HuntOptions, cancelled: () => boolean): Promise<HuntResult> {
    const res: HuntResult = { ok: false, reason: 'done', gained: 0, killed: 0, kinds: {}, fights: [] };
    let penHunt = false; // Track AF: a penned target was hunted: leave the pen at the end
    const inv = this.d.inventory;
    while (res.gained < o.want) {
      if (cancelled()) return { ...res, reason: 'interrupted' };
      // Track AQ (collect/sweep.ts): food lying within 8 blocks first (a drop left after a kill, the owner's)
      const had = foodItemCount(inv.slots);
      if (await sweepItems((r, t2, c) => this.d.mover.collect(r, t2, c), isFoodDrop, { entities: this.d.entities, position: this.d.position, hard: isFoodItem })) res.gained += Math.max(0, foodItemCount(inv.slots) - had);
      if (cancelled()) return { ...res, reason: 'interrupted' };
      if (res.gained >= o.want) break;
      const t = this.peek(o);
      if (!t) {
        res.reason = 'none_left';
        break;
      }
      this.current = t;
      if (t.pen) {
        penHunt = true;
        this.lastPen = t.pen;
      }
      const before = foodItemCount(inv.slots);
      const rid = t.entity.runtimeId;
      if (t.distance > APPROACH_FROM) {
        const f = entityFeet(t.entity);
        const r = await this.d.mover.goto({ type: 'near', p: { x: f.x, y: Math.floor(f.y), z: f.z }, r: t.pen ? 1.5 : 2.5 }, { timeoutTicks: 400, ...(t.pen ? { closeDoors: true } : {}) }); // Track AF: into a pen: close the gate behind
        if (cancelled()) return { ...res, reason: 'interrupted' };
        // Track AF: walked into a pen: close the gate behind (a walk that ends just inside leaves it open)
        if (t.pen && this.d.closeGates && insidePen(t.pen, this.d.position())) await this.d.closeGates(t.pen, cancelled);
        if (cancelled()) return { ...res, reason: 'interrupted' };
        // a near goal on a wandering mob may time out or end beside it; only a failed plan skips it
        if (!r.ok && r.reason === 'unreachable') {
          this.log.info(`food: ${t.kind} #${rid} unreachable (${r.reason}), skipped for ${IGNORE_MS / 1000} s`);
          this.ignore.set(rid, this.now() + IGNORE_MS);
          continue;
        }
      }
      const fight = await this.d.combat.fight(rid);
      if (cancelled()) return { ...res, reason: 'interrupted' };
      res.fights.push({ kind: t.kind, reason: fight.reason, ticks: fight.ticks });
      if (!fight.ok) {
        if (fight.reason === 'interrupted') return { ...res, reason: 'interrupted' };
        this.log.info(`food: fight with ${t.kind} #${rid} ended ${fight.reason}, skipped for ${IGNORE_MS / 1000} s`);
        this.ignore.set(rid, this.now() + IGNORE_MS);
        continue;
      }
      res.killed++;
      res.kinds[t.kind] = (res.kinds[t.kind] ?? 0) + 1;
      await this.d.mover.collect(o.collectRadius ?? 8, 200);
      if (cancelled()) {
        res.gained += Math.max(0, foodItemCount(inv.slots) - before);
        return { ...res, reason: 'interrupted' };
      }
      res.gained += Math.max(0, foodItemCount(inv.slots) - before);
      this.log.info(`food: killed ${t.kind}, ${res.gained}/${o.want} food items`);
      o.onKill?.({ kind: t.kind, gained: res.gained, killed: res.killed });
    }
    this.current = undefined;
    res.ok = res.gained >= o.want;
    if (res.ok) res.reason = 'done';
    if (penHunt) await this.leavePen(cancelled);
    return res;
  }

  /** Track AF: inside a pen (or in its gate): walk out of it and close its gate, so the animals stay in. */
  async leavePen(cancelled: () => boolean): Promise<boolean> {
    const me = this.d.position();
    const pen = this.d.penAt?.(me) ?? this.lastPen;
    this.lastPen = undefined;
    if (!pen || !inPenOrRim(pen, me) || cancelled() || !this.d.leavePen) return false;
    const r = await this.d.leavePen(pen, cancelled);
    this.log.info(`food: left the pen (${r.ok ? 'ok' : (r.reason ?? 'failed')}, ${r.closed} gate(s) closed)`);
    return r.ok;
  }
}
