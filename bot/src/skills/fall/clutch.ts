// Track BI (docs/movement.md "Falls", "Water bucket clutch"): the FallGuard.
//
//   policy     the planner's long-fall policy, read live before every plan (Navigator.fallPolicy):
//              health, absorption, armour enchantments, burning, hostiles, the water bucket, settings.
//   clutch     every tick the body falls, the rest of the fall is simulated with the movement model
//              (InputLoop.engine over the live blocks, the current command) to the landing tick; the
//              counted fall (the server's: the drop up to the tick before the landing tick, damage.ts)
//              gives the damage on the landing block. When it would hurt and a water bucket is in the
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
import { PHYSICS } from '../input/physics.ts';
import type { BlockQuery, BodyState, LiquidCell } from '../input/types.ts';
import type { NavGrid } from '../nav/grid.ts';
import { cornerDistance, SERVER_CLICK_REACH, wireItemOf } from '../place/place.ts';
import { BurnWatch } from '../survival/fire.ts';
import { damageForCounted, epfFactor, fallDamage, fallEpf, landingFactor } from './damage.ts';
import { fallPolicy, FALL_HOSTILE_RADIUS, type FallPolicy } from './policy.ts';
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
  /** The base around home: no planned clutch there, a reactive one always recovers (registry wiring). */
  protect: () => { x: number; y: number; z: number; r: number } | undefined = () => undefined;
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
  private tries = 0;
  private predicted: BlockQuery | undefined;
  private real: BlockQuery | undefined;
  private refusedNote: string | undefined;
  /** Ticks seen, and the tick until which the navigator's re-plans wait after a clutch (`settling`). */
  private ticks = 0;
  private settleUntil = 0;

  constructor(deps: FallGuardDeps) {
    this.d = deps;
    this.log = deps.logger ?? silentLogger;
    this.unsubs.push(
      deps.loop.onBeforeStep((tick, s) => {
        try {
          this.step(tick, s);
        } catch (e) {
          this.log.warn(`fall guard: ${e instanceof Error ? e.message : String(e)}`);
          this.reset();
        }
      }),
      deps.world.onBlockUpdate((p) => {
        const t = this.target;
        if (t?.water.x === p.x && t.water.y === p.y && t.water.z === p.z) this.unpredict();
      }),
    );
  }

  dispose(): void {
    for (const u of this.unsubs.splice(0)) u();
    this.burn?.dispose();
    this.unpredict();
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

  /** The planner's long-fall policy now (undefined: off). */
  policy(): FallPolicy | undefined {
    const st = this.settings();
    const self = this.d.world.self;
    const worn = this.d.world.inventory?.window(120)?.slots ?? [];
    const mode = String(self.gameMode ?? '');
    return fallPolicy({
      enabled: st.longFalls,
      health: self.health,
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
      noDamage: mode === 'creative' || mode === '1' || mode === 'spectator' || mode === '6',
      ...(this.protect() ? { noWater: this.protect()! } : {}),
    });
  }

  // ---- the clutch --------------------------------------------------------------------------------

  private reset(): void {
    this.unpredict();
    this.phase = 'idle';
    this.target = undefined;
    this.wait = 0;
    this.tries = 0;
  }

  private step(tick: bigint, s: InputLoopState): void {
    this.ticks++;
    if (!s.ready) {
      this.prevY = undefined;
      return;
    }
    // the fall the server counts: downward movement since the body last stood, swam or climbed
    const grounded = s.onGround || s.inWater || s.inLava || s.gliding;
    if (grounded) {
      this.counted = 0;
      this.refusedNote = undefined; // a refusal is noted once per fall
    } else if (this.prevY !== undefined && s.pos.y < this.prevY) this.counted += this.prevY - s.pos.y;
    this.prevY = s.pos.y;
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
    if (!st.clutch || this.d.loop.command.glide) return;
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
    const why = slot < 0 ? 'no water bucket in the hotbar' : !waterWorks(this.dimension()) ? 'water evaporates here' : undefined;
    const target = why ? ({ ok: false, reason: why } as const) : clutchTarget(land.block.x, land.block.y, land.block.z, land.floor, land.above);
    const rec: ClutchRecord = { tick: Number(tick), predicted: damage, counted: land.counted, landing: land.name, target, placed: false, recovered: false, pickups: 0, healthBefore: self.health };
    if (!target.ok) {
      const note = `${land.name}@${land.block.x},${land.block.y},${land.block.z}:${target.reason}`;
      if (note !== this.refusedNote) {
        this.refusedNote = note;
        this.stats.refused++;
        this.last = { ...rec, reason: target.reason };
        this.log.info(`fall of ${land.counted.toFixed(1)} onto ${land.name} (${damage.toFixed(1)} HP): no clutch, ${target.reason}`);
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
    if (this.wait > 0) {
      this.wait--;
      return;
    }
    rec.healthAfter ??= this.d.world.self.health;
    const water = this.waterAt(t);
    if (water === false) {
      if (this.phase === 'recovering' || rec.pickups > 0) {
        rec.recovered = true;
        this.stats.recovered++;
        this.log.info(`clutch: water at ${fmt(t.water)} picked up (${rec.pickups} clicks)`);
      } else if (++this.tries <= 10) {
        return; // the update_block may still be on its way
      } else {
        rec.reason ??= 'the server placed no water';
        this.log.warn(`clutch: no water at ${fmt(t.water)} after the landing`);
      }
      this.finish();
      return;
    }
    if (water === undefined) {
      this.finish();
      return;
    }
    rec.placed = true;
    if (this.phase === 'landed') this.tries = 0;
    const inv = this.d.world.inventory;
    const src = this.d.source();
    if (!inv || !src) return this.finish();
    const slot = this.bucketSlot('bucket');
    if (slot < 0) {
      // the server has not turned the bucket into an empty one yet
      if (++this.tries > 20) {
        rec.reason = 'no empty bucket';
        this.giveUp(t);
      }
      return;
    }
    if (rec.pickups >= (this.inBase(t) ? 3 * RECOVER_TRIES : RECOVER_TRIES)) { // inside the base: no water source is ever left there, try longer
      rec.reason = 'the pickup clicks did not take the water';
      this.giveUp(t);
      return;
    }
    if (inv.selected !== slot) this.d.hotbar()?.select(slot);
    const held = wireItemOf(inv.slots[slot], inv.rawItem?.(0, slot) ?? this.d.hotbar()?.rawItem(slot));
    const eye = { x: s.pos.x, y: s.pos.y + EYE_HEIGHT, z: s.pos.z };
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
      if (n.pos.y < b.pos.y) counted += b.pos.y - n.pos.y;
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
