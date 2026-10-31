// Track BI (docs/movement.md "Falls", "Water bucket clutch"): the FallGuard.
//
//   policy     the planner's long-fall policy, read live before every plan (Navigator.fallPolicy):
//              health, absorption, armour enchantments, burning, hostiles, the water bucket, settings.
//   clutch     every tick the body falls, the rest of the fall is simulated with the movement model
//              (InputLoop.engine over the live blocks, the current command) to the landing tick; the
//              counted fall (the server's: the drop up to the tick before the landing tick, damage.ts)
//              gives the damage on the landing block. When it matters (policy.ts shouldClutch: it would kill,
//              cross fallMargin or cost more than half the HP above it; not in creative, in the base or a
//              fight unless it kills; nothing armed while a ladder, cobweb, honey or Slow Falling slows the
//              fall) and a water bucket is in the
//              hotbar (not in the Nether, the landing block takes water where the feet end:
//              waterlog.ts clutchTarget), the bucket is selected and the view turned down; on the first
//              tick the landing block's top is within click reach (eye to its min corner <= 6.5, BDS
//              takes 7.19) or the landing is 2 ticks away, the click goes out (item_use / click_block on
//              the top face). It is queued before the tick's player_auth_input, so the server places the
//              water before it moves the body into it. The water is predicted in the movement model
//              until the server's update_block shows it.
//   recover    once the body is down (on the ground or in the water), the water is picked up with the
//              empty bucket (click_block on the cell holding it, face up), retried until the update_block
//              shows it gone (at most RECOVER_TRIES clicks); the previous hotbar slot and pitch come back.
//
// The planner's deliberate clutch drops (fall/plan.ts) are flown by the same code: the navigator walks off
// the edge, the FallGuard sees a hurting landing and clutches.
import { silentLogger, type Logger } from '../../log.ts';
import { waterWorks } from '../../world/dimension.ts';
import type { ItemV4 } from '../../world/packets.ts';
import type { BlockInfo, EntityInfo, ItemStack, PacketSource, Vec3 } from '../../world/types.ts';
import { classify as classifyEntity } from '../combat/hostiles.ts';
import { clickBlockTransaction } from '../container/chest.ts';
import { EYE_HEIGHT } from '../dig/look.ts';
import type { InputLoop, InputLoopState } from '../input/inputLoop.ts';
import { onClimbable, PHYSICS } from '../input/physics.ts';
import type { BlockQuery, BodyState, LiquidCell } from '../input/types.ts';
import { DEFAULT_COSTS, type PathCosts } from '../nav/costs.ts';
import { cellKey, type NavGrid } from '../nav/grid.ts';
import { acceptsDrop } from './plan.ts';
import { closestDistance, cornerDistance, SERVER_CLICK_REACH, wireItemOf } from '../place/place.ts';
import { BurnWatch } from '../survival/fire.ts';
import { damageForCounted, epfFactor, fallDamage, fallEpf, landingFactor } from './damage.ts';
import { fallPolicy, FALL_HOSTILE_RADIUS, shouldClutch, type FallPolicy } from './policy.ts';
import { clutchTarget, type ClutchTarget } from './waterlog.ts';

/** The settings the guard reads (config/settings.ts: longFalls, fallMargin, clutch, clutchMaxDrop). */
export interface FallSettings {
  longFalls: boolean;
  fallMargin: number;
  clutch: boolean;
  clutchMaxDrop: number;
}

export const DEFAULT_FALL_SETTINGS: Readonly<FallSettings> = Object.freeze({ longFalls: true, fallMargin: 8, clutch: true, clutchMaxDrop: 40 });

/** Eye to the clicked block's min corner at which the clutch clicks (BDS accepts up to 7.19). */
export const CLUTCH_REACH = 6.5;
/** Ticks the movement model is run ahead to find the landing. */
const PREDICT_TICKS = 160;
/** Pickup clicks before giving up, and the ticks between them. */
const RECOVER_TRIES = 6;
const RECOVER_GAP = 5;
/** Ticks after a pickup the flow around the landing takes to recede (the navigator's re-plans wait). */
const SETTLE_TICKS = 16;
/** Review M1: ticks a landing's predicted damage counts against the budget when no health drop shows it. */
const PENDING_TICKS = 40;
/** Review L1: ticks a drop the step-off check refused stays out of the plans. */
const REFUSED_DROP_TICKS = 200;
/** Longest the landed / recovering phase may last before the guard gives up (review H1). */
const RECOVER_TIMEOUT = 100;
/** A mob or anything else hurt the bot within this many ticks: in a fight (no clutch unless the fall kills). */
const HURT_COMBAT_TICKS = 60;
/** Own reach for the pickup click: eye to the closest point of the water cell. */
const PICKUP_REACH = 5;
/** Bedrock effect id of Slow Falling (mob_effect; verified in test/e2e/fall-clutch.test.ts). */
export const SLOW_FALLING_EFFECT = 27;
/** Blocks that slow a fall (or end it) without a landing the model sees: no clutch is armed in or next to them. */
const SLOWING_NAMES = new Set(['web', 'scaffolding', 'honey_block', 'powder_snow', 'sweet_berry_bush']);

export interface FallGuardDeps {
  loop: Pick<InputLoop, 'state' | 'command' | 'setCommand' | 'onBeforeStep' | 'engine'> & { world: BlockQuery };
  world: {
    self: { health: number; healthKnown?: boolean; absorption?: number; gameMode?: string; runtimeId?: bigint; dimension?: number };
    inventory?: { readonly slots: readonly (ItemStack | null)[]; readonly selected: number; window(id: number): { slots: readonly (ItemStack | null)[] } | undefined; rawItem?(window: number, slot: number): ItemV4 | undefined };
    entities?: ReadonlyMap<bigint, EntityInfo>;
    chunks?: { runtimeIdAt(x: number, y: number, z: number): number | undefined; stateIdAt?(x: number, y: number, z: number, layer?: number): number | undefined };
    blockAt?(p: Vec3): BlockInfo | undefined;
    registry?: { nameOf(stateId: number): string | undefined };
    onBlockUpdate(fn: (p: Vec3, before: BlockInfo | undefined, after: BlockInfo) => void): () => void;
  };
  grid: NavGrid;
  /** Where the transactions go (the Connection); `on` enables the burning flag. Read live (attached later). */
  source: () => (Pick<PacketSource, 'queue'> & Partial<Pick<PacketSource, 'on'>>) | undefined;
  hotbar: () => { select(slot: number): boolean; rawItem(slot: number): ItemV4 | undefined } | undefined;
  logger?: Logger;
}

export type ClutchPhase = 'idle' | 'armed' | 'placed' | 'landed' | 'recovering';

export interface ClutchRecord {
  tick: number;
  /** Predicted damage without the clutch. */
  predicted: number;
  counted: number;
  landing: string;
  target?: ClutchTarget;
  /** The click went out (tick), eye distance to the clicked block's corner. */
  clickTick?: number;
  clickDistance?: number;
  /** The server showed the water. */
  placed: boolean;
  /** Ticks from the click to the landing. */
  landedAfter?: number;
  /** The water was picked up again. */
  recovered: boolean;
  /** Pickup clicks sent. */
  pickups: number;
  /** Health before and after the landing (as the server reported it). */
  healthBefore: number;
  healthAfter?: number;
  /** Why no clutch was tried (refused) or why it failed. */
  reason?: string;
}

export class FallGuard {
  /** Settings, read live (registry wiring replaces it). */
  settings: () => FallSettings = () => DEFAULT_FALL_SETTINGS;
  /** The base around home: no planned clutch there, a reactive one only when the fall would kill (registry wiring). */
  protect: () => { x: number; y: number; z: number; r: number } | undefined = () => undefined;
  /** A fight runs (registry wiring: the combat controller is busy): no clutch unless the fall would kill. */
  inCombat: () => boolean = () => false;
  /** Track BH: a fall the flight means (an elytra flight runs: the ledge takeoff steps off an edge): never armed. */
  intended: () => boolean = () => false;
  /** The last clutch tried or refused (tests, status). */
  last: ClutchRecord | undefined;
  readonly stats = { clutches: 0, placed: 0, recovered: 0, refused: 0, waterLeft: 0 };
  private readonly d: FallGuardDeps;
  private readonly log: Logger;
  private burn: BurnWatch | undefined;
  private burnSource: unknown;
  private readonly unsubs: (() => void)[] = [];
  private prevY: number | undefined;
  /** The fall the server counts so far (downward movement since the body left the ground). */
  private counted = 0;
  private phase: ClutchPhase = 'idle';
  private rec: ClutchRecord | undefined;
  private target: Extract<ClutchTarget, { ok: true }> | undefined;
  private slot = -1;
  private prevSlot = -1;
  private prevPitch = 0;
  private wait = 0;
  private predicted: BlockQuery | undefined;
  private real: BlockQuery | undefined;
  private refusedNote: string | undefined;
  /** Ticks seen, and the tick until which the navigator's re-plans wait after a clutch (`settling`). */
  private ticks = 0;
  private settleUntil = 0;
  /** Tick (this.ticks) the landed phase began (the H1 timeout). */
  private landedAt = 0;
  /** Health seen last tick and the tick something last hurt the bot outside a fall landing. */
  private lastHealth: number | undefined;
  private hurtAt = -Infinity;
  /** Tick of the last landing from more than 3 blocks (its health drop is the fall, not a fight). */
  private fallLandAt = -Infinity;
  /** Review M1: damage of the last landing whose health packet has not come yet (subtracted from the health in the policy). */
  private pendingDamage = 0;
  /** Review L1: landing cells (cellKey) whose drop the step-off check refused, and until which tick. */
  private readonly refusedDrops = new Map<number, number>();
  /** Slow Falling on the bot (mob_effect for its own runtime id). */
  private slowFalling = false;
  private effectSource: unknown;
  private offEffect: (() => void) | undefined;

  constructor(deps: FallGuardDeps) {
    this.d = deps;
    this.log = deps.logger ?? silentLogger;
    this.unsubs.push(
      deps.loop.onBeforeStep((tick, s) => {
        try {
          this.step(tick, s);
        } catch (e) {
          this.log.warn(`fall guard: ${e instanceof Error ? e.message : String(e)}`);
          this.safeFinish('an error in the guard');
        }
      }),
      deps.world.onBlockUpdate((p) => {
        const t = this.target;
        if (t?.water.x === p.x && t.water.y === p.y && t.water.z === p.z) this.unpredict();
      }),
    );
    const onEvent = (deps.loop as { onEvent?: (fn: (e: { kind: string }) => void) => () => void }).onEvent;
    if (onEvent)
      this.unsubs.push(
        onEvent.call(deps.loop, (e) => {
          if (e.kind !== 'teleport') return;
          // a teleport ends the fall (review Low): nothing counted carries over, an armed clutch stops
          this.counted = 0;
          this.prevY = undefined;
          if (this.phase === 'armed') this.safeFinish('teleported');
        }),
      );
  }

  dispose(): void {
    if (this.phase !== 'idle') this.safeFinish('disposed');
    for (const u of this.unsubs.splice(0)) u();
    this.offEffect?.();
    this.burn?.dispose();
    this.unpredict();
  }

  /** finish() that never throws (an error or dispose mid-clutch: slot and pitch come back, the water is counted). */
  private safeFinish(reason: string): void {
    try {
      if (this.rec) this.rec.reason ??= reason;
      if (this.target && (this.phase === 'placed' || this.phase === 'landed' || this.phase === 'recovering') && this.waterAt(this.target) !== false) {
        this.giveUp(this.target);
        return;
      }
      this.finish();
    } catch (e) {
      this.log.warn(`fall guard: finish failed: ${e instanceof Error ? e.message : String(e)}`);
      this.reset();
    }
  }

  /** Slow Falling on the bot: tracked from mob_effect on the packet source once it is attached. */
  private watchEffects(): void {
    const src = this.d.source();
    if (!src?.on || src === this.effectSource) return;
    this.offEffect?.();
    this.effectSource = src;
    this.offEffect = src.on('mob_effect', (p) => {
      const q = p as { runtime_entity_id?: number | bigint; event_id?: string | number; effect_id?: number };
      if (q.runtime_entity_id === undefined || BigInt(q.runtime_entity_id) !== (this.d.world.self.runtimeId ?? -1n)) return;
      if (q.effect_id !== SLOW_FALLING_EFFECT) return;
      this.slowFalling = q.event_id !== 'remove' && q.event_id !== 3;
    });
  }

  /** The fall is slowed or caught where the model sees no landing: a climbable, cobweb, scaffolding, a honey wall, powder snow, Slow Falling (review B3). */
  private slowed(s: { pos: Vec3 }): boolean {
    if (this.slowFalling) return true;
    // a ladder / vine only in the feet cell, as the physics and the server count it (review M2: a vine wall beside
    // the fall does not slow it)
    if (onClimbable(this.d.loop.world, s.pos)) return true;
    const g = this.d.grid;
    const body = PHYSICS.width / 2;
    const wide = body + 0.1; // a honey wall slides the body from beside it
    const y0 = Math.floor(s.pos.y - 0.5);
    const y1 = Math.floor(s.pos.y + PHYSICS.height);
    for (let x = Math.floor(s.pos.x - wide); x <= Math.floor(s.pos.x + wide); x++)
      for (let z = Math.floor(s.pos.z - wide); z <= Math.floor(s.pos.z + wide); z++) {
        const inBody = x >= Math.floor(s.pos.x - body) && x <= Math.floor(s.pos.x + body) && z >= Math.floor(s.pos.z - body) && z <= Math.floor(s.pos.z + body);
        for (let y = y0; y <= y1; y++) {
          const n = g.cls(x, y, z)?.name;
          if (n === undefined) continue;
          if (n === 'honey_block' || (inBody && SLOWING_NAMES.has(n))) return true;
        }
      }
    return false;
  }

  /** Something hurt the bot recently outside a fall landing (a mob, an arrow): in a fight. */
  private fighting(): boolean {
    return this.inCombat() || this.ticks - this.hurtAt < HURT_COMBAT_TICKS;
  }

  /** The clutch is under way (armed, waiting for the landing, recovering the water). */
  get busy(): boolean {
    return this.phase !== 'idle';
  }

  /**
   * The clutch's water is down or still flowing around the landing: busy, or within SETTLE_TICKS after the
   * pickup (the flow recedes). The navigator holds its re-plans meanwhile (a plan from inside the flow finds
   * no move: the cells around are flowing water).
   */
  /** The body is down and the water is being picked up: the navigator's follower holds still (the pickup's reach). */
  get recovering(): boolean {
    return this.phase === 'landed' || this.phase === 'recovering';
  }

  /** Review B1 / Medium: the planned long drop from `from` into `to` still holds with the live policy (fall/plan.ts acceptsDrop). */
  acceptsDrop(from: { y: number; feet: number }, to: { x: number; y: number; z: number }, costs: PathCosts = DEFAULT_COSTS): boolean {
    const ok = acceptsDrop(this.d.grid, costs, this.policy(), from, to);
    // review L1: a refused drop stays out of the re-plans for a while (no plan / refuse loop on a borderline budget)
    if (!ok) this.refusedDrops.set(cellKey(to.x, to.y, to.z), this.ticks + REFUSED_DROP_TICKS);
    return ok;
  }

  get settling(): boolean {
    return (this.phase !== 'idle' && this.phase !== 'armed') || this.ticks < this.settleUntil;
  }

  // ---- the policy --------------------------------------------------------------------------------

  /** The burning flag (BurnWatch on the packet source, built once it is attached). */
  private burning(): boolean {
    const src = this.d.source();
    if (src?.on && src !== this.burnSource) {
      this.burn?.dispose();
      this.burnSource = src;
      const self = this.d.world.self;
      this.burn = new BurnWatch(src as Pick<PacketSource, 'on'>, { selfRuntimeId: () => self.runtimeId ?? 0n, health: () => self.health, inLava: () => this.d.loop.state.inLava });
    }
    return this.burn?.burning() ?? this.d.loop.state.inLava;
  }

  private nearestHostile(): number {
    const ents = this.d.world.entities;
    if (!ents) return Infinity;
    const p = this.d.loop.state.pos;
    let best = Infinity;
    for (const e of ents.values()) {
      if (classifyEntity(e.type) !== 'hostile') continue;
      const d = Math.hypot(e.pos.x - p.x, e.pos.y - p.y, e.pos.z - p.z);
      if (d < best) best = d;
    }
    return best;
  }

  /** The hotbar slot of a water bucket (the selected one first), or -1. */
  bucketSlot(name = 'water_bucket'): number {
    const inv = this.d.world.inventory;
    if (!inv) return -1;
    if (inv.slots[inv.selected]?.name === name) return inv.selected;
    for (let s = 0; s < 9; s++) if (inv.slots[s]?.name === name && (inv.slots[s]?.count ?? 0) > 0) return s;
    return -1;
  }

  /** The damage factor of the worn armour's enchantments. */
  factor(): number {
    const worn = this.d.world.inventory?.window(120)?.slots ?? [];
    return epfFactor(fallEpf(worn));
  }

  private dimension(): number {
    return this.d.world.self.dimension ?? 0;
  }

  /** Creative / spectator: no fall damage (World.self.gameMode as the server sent it, a name or a number). */
  private noDamage(): boolean {
    const mode = String(this.d.world.self.gameMode ?? '');
    return mode === 'creative' || mode === '1' || mode === 'spectator' || mode === '6';
  }

  /** The planner's long-fall policy now (undefined: off). */
  policy(): FallPolicy | undefined {
    const st = this.settings();
    const self = this.d.world.self;
    const worn = this.d.world.inventory?.window(120)?.slots ?? [];
    for (const [k, until] of this.refusedDrops) if (until <= this.ticks) this.refusedDrops.delete(k);
    const p = fallPolicy({
      enabled: st.longFalls,
      health: self.health - this.pendingDamage, // review M1: a landing whose health packet is still on its way
      healthKnown: self.healthKnown === true,
      absorption: self.absorption ?? 0,
      margin: st.fallMargin,
      epf: fallEpf(worn),
      burning: this.burning(),
      hostileDistance: this.nearestHostile(),
      bucket: this.bucketSlot() >= 0,
      clutchOn: st.clutch,
      waterWorks: waterWorks(this.dimension()),
      clutchMax: st.clutchMaxDrop,
      noDamage: this.noDamage(),
      ...(this.protect() ? { noWater: this.protect()! } : {}),
    });
    if (p && this.refusedDrops.size) p.refused = [...this.refusedDrops.keys()]; // review L1
    return p;
  }

  // ---- the clutch --------------------------------------------------------------------------------

  private reset(): void {
    this.unpredict();
    this.phase = 'idle';
    this.target = undefined;
    this.wait = 0;
  }

  private step(tick: bigint, s: InputLoopState): void {
    this.ticks++;
    this.watchEffects();
    if (!s.ready) {
      this.prevY = undefined;
      this.counted = 0;
      return;
    }
    // a health drop that is not a fall landing (the fall guard's own counted fall is 0 on the ground then): in a fight
    const h = this.d.world.self.health;
    if (this.lastHealth !== undefined && h < this.lastHealth) {
      if (this.ticks - this.fallLandAt > 20) this.hurtAt = this.ticks;
      else this.pendingDamage = 0; // review M1: the landing's health packet came; the health is current again
    }
    this.lastHealth = h;
    if (this.pendingDamage > 0 && this.ticks - this.fallLandAt > PENDING_TICKS) this.pendingDamage = 0;
    // the fall the server counts: downward movement since the body last stood, swam or climbed (a ladder,
    // cobweb, scaffolding, honey wall or Slow Falling ends it too: review B3)
    const slowed = !s.onGround && this.slowed(s);
    const grounded = s.onGround || s.inWater || s.inLava || s.gliding || slowed;
    if (grounded && this.counted > 3) {
      this.fallLandAt = this.ticks; // the health drop of this landing is the fall's
      // review M1: until its health packet arrives, the damage this landing will cost counts against the budget
      if (s.onGround && !s.inWater && this.phase === 'idle') {
        const b = this.landingBlock(s.pos);
        const name = b ? this.d.grid.cls(b.x, b.y, b.z)?.name : undefined;
        this.pendingDamage = damageForCounted(this.counted, landingFactor(name), this.factor());
      }
    }
    if (grounded) {
      this.counted = 0;
      this.refusedNote = undefined; // a refusal is noted once per fall
    } else if (this.prevY !== undefined && s.pos.y < this.prevY) this.counted += this.prevY - s.pos.y;
    this.prevY = s.pos.y;
    if (slowed && this.phase === 'armed') {
      this.safeFinish('the fall is slowed (climbable, cobweb, scaffolding, honey, Slow Falling)');
      return;
    }
    if (!grounded && this.phase === 'idle' && s.vel.y < 0) this.arm(tick, s);
    if (this.phase === 'armed' || this.phase === 'placed') {
      if (grounded) {
        if (this.rec) {
          this.rec.landedAfter = this.rec.clickTick !== undefined ? Number(tick) - this.rec.clickTick : undefined;
        }
        if (this.phase === 'armed') {
          // landed before the click went out (the fall ended sooner than predicted)
          if (this.rec) this.rec.reason ??= 'landed before the click';
          this.finish();
          return;
        }
        this.phase = 'landed';
        this.landedAt = this.ticks;
        this.wait = 2;
        return;
      }
      if (this.phase === 'armed') this.aimAndClick(tick, s);
      return;
    }
    if (this.phase === 'landed' || this.phase === 'recovering') this.recover(tick, s);
  }

  /** Predict the landing; arm the clutch when it would hurt. */
  private arm(tick: bigint, s: InputLoopState): void {
    const st = this.settings();
    if (!st.clutch || this.d.loop.command.glide || this.intended()) return;
    const land = this.predictLanding(s);
    if (!land) return;
    const self = this.d.world.self;
    const factor = this.factor();
    const damage = damageForCounted(land.counted, landingFactor(land.name), factor);
    if (damage <= 0) {
      this.refusedNote = undefined;
      return;
    }
    const slot = this.bucketSlot();
    const t0 = clutchTarget(land.block.x, land.block.y, land.block.z, land.floor, land.above);
    // review B4: only a clutch that matters (the margin, a life), never in creative, in the base or in a fight unless it kills
    const verdict = shouldClutch({
      damage,
      health: self.health,
      absorption: self.absorption ?? 0,
      margin: st.fallMargin,
      noDamage: this.noDamage(),
      inBase: t0.ok && this.inBase(t0),
      inCombat: this.fighting(),
    });
    const why = !verdict.yes ? verdict.reason : slot < 0 ? 'no water bucket in the hotbar' : !waterWorks(this.dimension()) ? 'water evaporates here' : undefined;
    const target = why ? ({ ok: false, reason: why } as const) : t0;
    const rec: ClutchRecord = { tick: Number(tick), predicted: damage, counted: land.counted, landing: land.name, target, placed: false, recovered: false, pickups: 0, healthBefore: self.health };
    if (!target.ok) {
      const note = `${land.name}@${land.block.x},${land.block.y},${land.block.z}:${target.reason}`;
      if (note !== this.refusedNote) {
        this.refusedNote = note;
        this.stats.refused++;
        this.last = { ...rec, reason: target.reason };
        const line = `fall of ${land.counted.toFixed(1)} onto ${land.name} (${damage.toFixed(1)} HP): no clutch, ${target.reason}`;
        if (verdict.yes) this.log.info(line);
        else this.log.debug(line);
      }
      return;
    }
    this.refusedNote = undefined;
    this.stats.clutches++;
    this.rec = rec;
    this.last = rec;
    this.target = target;
    this.slot = slot;
    const inv = this.d.world.inventory!;
    this.prevSlot = inv.selected;
    this.prevPitch = this.d.loop.command.pitch;
    if (inv.selected !== slot) this.d.hotbar()?.select(slot);
    this.d.loop.setCommand({ pitch: 90 });
    this.phase = 'armed';
    this.log.info(`fall of ${land.counted.toFixed(1)} predicted onto ${land.name} at ${fmt(land.block)} (${damage.toFixed(1)} HP, landing in ${land.ticks} ticks): clutch armed`);
    this.aimAndClick(tick, s);
  }

  private aimAndClick(tick: bigint, s: InputLoopState): void {
    const rec = this.rec!;
    const land = this.predictLanding(s);
    // the landing moves while the walk's command changes in the air (the follower lets go of forward): follow it until the click
    if (land && (land.block.x !== this.target!.click.x || land.block.y !== this.target!.click.y || land.block.z !== this.target!.click.z)) {
      const nt = clutchTarget(land.block.x, land.block.y, land.block.z, land.floor, land.above);
      rec.target = nt;
      rec.landing = land.name;
      if (!nt.ok) {
        rec.reason = `the landing moved: ${nt.reason}`;
        this.finish();
        return;
      }
      this.target = nt;
    }
    const t = this.target!;
    const eye = { x: s.pos.x, y: s.pos.y + EYE_HEIGHT, z: s.pos.z };
    const dist = cornerDistance(eye, t.click);
    const soon = land !== undefined && land.ticks <= 2;
    if (dist > CLUTCH_REACH && !(soon && dist <= SERVER_CLICK_REACH - 0.05)) return;
    const src = this.d.source();
    const inv = this.d.world.inventory;
    if (!src || !inv) {
      rec.reason = 'no packet source';
      this.finish();
      return;
    }
    const stack = inv.slots[this.slot];
    if (stack?.name !== 'water_bucket') {
      rec.reason = 'the water bucket left the slot';
      this.finish();
      return;
    }
    if (inv.selected !== this.slot) this.d.hotbar()?.select(this.slot);
    const held = wireItemOf(stack, inv.rawItem?.(0, this.slot) ?? this.d.hotbar()?.rawItem(this.slot));
    src.queue(
      'inventory_transaction',
      clickBlockTransaction({ pos: t.click, face: 1, hotbarSlot: this.slot, held, eye, blockRuntimeId: this.d.world.chunks?.runtimeIdAt(t.click.x, t.click.y, t.click.z) ?? 0 }),
    );
    rec.clickTick = Number(tick);
    rec.clickDistance = +dist.toFixed(3);
    this.phase = 'placed';
    this.predict(t.water);
  }

  /** Pick the water up again once the body is down. */
  private recover(tick: bigint, s: InputLoopState): void {
    const t = this.target!;
    const rec = this.rec!;
    const water = this.waterAt(t);
    // review H1: the landed phase is bounded (a bucket that never empties, a cell out of reach, a lost update)
    const limit = this.inBase(t) ? 3 * RECOVER_TIMEOUT : RECOVER_TIMEOUT;
    if (this.ticks - this.landedAt > limit) {
      rec.reason ??= `no pickup within ${limit} ticks`;
      if (water === false && rec.pickups > 0) rec.recovered = true;
      if (water === false) this.finish();
      else this.giveUp(t);
      return;
    }
    if (this.wait > 0) {
      this.wait--;
      return;
    }
    rec.healthAfter ??= this.d.world.self.health;
    if (water === false) {
      if (this.phase === 'recovering' || rec.pickups > 0) {
        rec.recovered = true;
        this.stats.recovered++;
        this.log.info(`clutch: water at ${fmt(t.water)} picked up (${rec.pickups} clicks)`);
      } else if (this.ticks - this.landedAt <= 12) {
        return; // the update_block may still be on its way
      } else {
        rec.reason ??= 'the server placed no water';
        this.log.warn(`clutch: no water at ${fmt(t.water)} after the landing`);
      }
      this.finish();
      return;
    }
    if (water === undefined) {
      rec.reason ??= 'the water cell is not loaded';
      this.giveUp(t); // logged and counted: it may still be there
      return;
    }
    rec.placed = true;
    const inv = this.d.world.inventory;
    const src = this.d.source();
    if (!inv || !src) {
      rec.reason ??= 'no packet source';
      this.giveUp(t);
      return;
    }
    const slot = this.bucketSlot('bucket');
    if (slot < 0) return; // the server has not turned the bucket into an empty one yet (bounded by the timeout above)
    if (rec.pickups >= (this.inBase(t) ? 3 * RECOVER_TRIES : RECOVER_TRIES)) { // inside the base: no water source is ever left there, try longer
      rec.reason = 'the pickup clicks did not take the water';
      this.giveUp(t);
      return;
    }
    const eye = { x: s.pos.x, y: s.pos.y + EYE_HEIGHT, z: s.pos.z };
    if (closestDistance(eye, t.water) > PICKUP_REACH || cornerDistance(eye, t.water) > SERVER_CLICK_REACH) return; // out of reach: wait (the follower is held meanwhile)
    if (inv.selected !== slot) this.d.hotbar()?.select(slot);
    const held = wireItemOf(inv.slots[slot], inv.rawItem?.(0, slot) ?? this.d.hotbar()?.rawItem(slot));
    src.queue('inventory_transaction', clickBlockTransaction({ pos: t.water, face: 1, hotbarSlot: slot, held, eye, blockRuntimeId: this.d.world.chunks?.runtimeIdAt(t.water.x, t.water.y, t.water.z) ?? 0 }));
    rec.pickups++;
    this.phase = 'recovering';
    this.wait = RECOVER_GAP;
    void tick;
  }

  private giveUp(t: Extract<ClutchTarget, { ok: true }>): void {
    this.stats.waterLeft++;
    this.log.warn(`clutch: water left at ${fmt(t.water)}${this.inBase(t) ? ' INSIDE the protected base' : ''}: ${this.rec?.reason ?? '?'}`);
    this.finish();
  }

  /** The water cell is inside the base (home's protectRadius). */
  private inBase(t: Extract<ClutchTarget, { ok: true }>): boolean {
    const home = this.protect();
    return !!home && Math.hypot(t.water.x + 0.5 - home.x, t.water.y - home.y, t.water.z + 0.5 - home.z) <= home.r;
  }

  /** Water in the target cell per the world model: true / false, undefined when unknown. */
  private waterAt(t: Extract<ClutchTarget, { ok: true }>): boolean | undefined {
    const w = this.d.world;
    if (t.layer === 1) {
      // a waterlogged block: the water is in the cell's second layer (world/subchunk.ts)
      const id = w.chunks?.stateIdAt?.(t.water.x, t.water.y, t.water.z, 1);
      const name = id === undefined ? undefined : w.registry?.nameOf(id);
      return name === undefined ? undefined : isWaterName(name);
    }
    const b = w.blockAt?.(t.water);
    return b ? isWaterName(b.name) : undefined;
  }

  private finish(): void {
    const inv = this.d.world.inventory;
    if (inv && this.prevSlot >= 0 && this.prevSlot !== inv.selected) this.d.hotbar()?.select(this.prevSlot);
    if (this.phase !== 'idle') this.d.loop.setCommand({ pitch: this.prevPitch });
    if (this.rec) {
      if (this.rec.placed) {
        this.stats.placed++;
        this.settleUntil = this.ticks + SETTLE_TICKS;
      }
      this.last = this.rec;
    }
    this.rec = undefined;
    this.prevSlot = -1;
    this.reset();
  }

  // ---- prediction --------------------------------------------------------------------------------

  /**
   * The rest of this fall per the movement model: the landing tick, the counted fall at it (the server's:
   * this fall so far plus the predicted drops before the landing tick) and the block landed on. Undefined
   * when the model cannot see the landing (unknown blocks, no landing within PREDICT_TICKS, in water).
   */
  predictLanding(s: InputLoopState): { ticks: number; counted: number; pos: Vec3; name: string; block: Vec3; floor: ClutchBlockLike | undefined; above: ClutchBlockLike | undefined } | undefined {
    const loop = this.d.loop;
    const cmd = { ...loop.command, jump: false };
    let b: BodyState = { pos: { ...s.pos }, vel: { ...s.vel }, onGround: false, collidedHorizontally: s.collidedHorizontally, collidedVertically: s.collidedVertically, jumpTicks: 0, sprinting: s.sprinting, sneaking: cmd.sneak, inWater: s.inWater, inLava: s.inLava, gliding: s.gliding, boostTicks: s.boostTicks };
    let counted = this.counted;
    for (let k = 1; k <= PREDICT_TICKS; k++) {
      const r = loop.engine.step(b, cmd, this.real ?? loop.world);
      if (!r.simulated) return undefined;
      const n = r.state;
      if (n.inWater || n.inLava) return undefined;
      if (n.onGround) {
        const block = this.landingBlock(n.pos);
        if (!block) return undefined;
        const g = this.d.grid;
        const floor = g.cls(block.x, block.y, block.z);
        const own = Math.abs(block.y + (floor?.top ?? 1) - n.pos.y) < 1e-3 && (floor?.top ?? 1) < 1 - 1e-6;
        const above = own ? undefined : g.cls(block.x, block.y + 1, block.z);
        return { ticks: k, counted, pos: n.pos, name: floor?.name ?? 'unknown', block, floor, above };
      }
      if (this.slowed(n)) counted = 0; // a ladder / web / honey wall on the way ends the counted fall
      else if (n.pos.y < b.pos.y) counted += b.pos.y - n.pos.y;
      b = n;
    }
    return undefined;
  }

  /** The block under the landed feet: the column of the body's centre if its top is at the feet, else the highest under the footprint. */
  private landingBlock(p: Vec3): Vec3 | undefined {
    const g = this.d.grid;
    const w = PHYSICS.width / 2 - 1e-3;
    const cols: [number, number][] = [[Math.floor(p.x), Math.floor(p.z)]];
    for (const [ox, oz] of [
      [-w, -w],
      [-w, w],
      [w, -w],
      [w, w],
    ] as const) {
      const c: [number, number] = [Math.floor(p.x + ox), Math.floor(p.z + oz)];
      if (!cols.some((k) => k[0] === c[0] && k[1] === c[1])) cols.push(c);
    }
    for (const [x, z] of cols) {
      // the feet rest on a box top: in the feet's own cell (a slab) or the cell below (a full block)
      for (const y of [Math.floor(p.y - 1e-4), Math.floor(p.y - 1e-4) - 1]) {
        const c = g.cls(x, y, z);
        if (c?.boxes.length && Math.abs(y + c.top - p.y) < 1e-3) return { x, y, z };
      }
    }
    return undefined;
  }

  /** The water cell in the movement model until the server's update_block shows it. */
  private predict(p: Vec3): void {
    const loop = this.d.loop;
    const real = loop.world;
    const at = (x: number, y: number, z: number) => x === p.x && y === p.y && z === p.z;
    const water: LiquidCell = { liquid: 'water', height: 8 / 9 };
    const q: BlockQuery = { ...real, solidAt: (x, y, z) => real.solidAt(x, y, z) };
    q.liquidAt = (x, y, z) => (at(x, y, z) ? water : real.liquidAt?.(x, y, z));
    if (real.boxesAt) q.boxesAt = (x, y, z) => real.boxesAt!(x, y, z);
    this.real = real;
    this.predicted = q;
    loop.world = q;
  }

  private unpredict(): void {
    const loop = this.d.loop;
    if (this.predicted && loop.world === this.predicted && this.real) loop.world = this.real;
    this.predicted = undefined;
    this.real = undefined;
  }

  // ---- explaining a failed goto ------------------------------------------------------------------

  /** A short note on the damage of a drop of `height` onto `landing` with the worn armour. */
  damageOf(height: number, landing?: string): number {
    return fallDamage(height, landing, this.factor());
  }

  /** Hostiles within FALL_HOSTILE_RADIUS (for messages). */
  hostileNear(): boolean {
    return this.nearestHostile() <= FALL_HOSTILE_RADIUS;
  }
}

/** What clutchTarget reads (TerrainClass satisfies it). */
interface ClutchBlockLike { name: string; top: number; fullCube: boolean; floor: boolean; liquid?: 'water' | 'lava' | undefined }

function isWaterName(n: string | undefined): boolean {
  return n === 'water' || n === 'flowing_water';
}

function fmt(p: Vec3): string {
  return `(${p.x}, ${p.y}, ${p.z})`;
}
