// Melee combat skill (PLAN.md task 7.4, docs/pve.md). PvE ONLY: `attack` and `fight` refuse any
// player entity (type minecraft:player or an entity with a username), whatever the caller asks.
//
//   const combat = new CombatController({ loop, mover: skills, entities: () => world.entities, mobs,
//                                         inventory: world.inventory, hotbar, source: conn });
//   const r = await combat.fight(zombie.runtimeId);   // { ok: true, reason: 'killed', attacks, landed, ... }
//
// One fight at a time, driven from the InputLoop's before-step hook:
// - weapon: the best hotbar weapon (sword > axe > anything); with no sword or axe in the hotbar a
//   sword / axe from the main inventory is moved into the hotbar first (Track V, hotbar-moves.ts; the
//   approach goes on meanwhile, strikes wait for the move, at most 40 ticks);
// - far (more than 3.5 blocks horizontally, or another level): the navigator walks a `near` goal of
//   radius 2.5 around the target, re-planned when the target moved more than 1.5 blocks (sprint when
//   more than 8 blocks away, always against archers); the pitch follows the target meanwhile;
// - close: the navigator is cancelled and the controller steers itself: yaw (at most 40 degrees per
//   tick) and pitch towards the target's upper body, forward while farther than 2.2 blocks, back while
//   closer than 1.0;
// - strike when the eye is within 3.0 blocks of the target's box, the view is within 35 degrees and
//   10 ticks passed since the last strike (Bedrock has no attack cooldown, but a mob is invulnerable
//   for 10 ticks after a hit): `animate` swing + `inventory_transaction` item_use_on_entity attack;
// - stop when the target dies (death_animation / health 0), disappears, stays farther than
//   `maxRange` for 100 ticks, or the fight times out.
//
// Track V (wave 7, docs/pve.md "Creepers", "Ranged mobs", "Targeting"):
// - creeper protocol, hit and run: sprint in for the strike (sprint knockback), then sprint away until
//   8 blocks (measured on BDS: the fuse lights within about 3.5 blocks, so at every strike, and the
//   explosion follows 31 ticks later), wait until the fuse has been out 10 ticks, repeat; never more
//   than 10 ticks inside 3 blocks; a lit fuse within 7 blocks: run straight away.
//   Below health 10 creepers are not engaged: run until 11 blocks away, `creeper_avoided`.
// - a creeper coming within 6 blocks while fighting something else is fought first (an interlude),
//   then the fight goes back to its target.
// - flying mobs are never chased: struck only within reach; out of reach 20 ticks -> `unreachable`.
// - archers (skeleton, stray, bogged, parched, pillager, a drowned with a trident): sprint straight in;
//   below health 10 break line of sight instead: walk to the nearest cell within 6 blocks with a solid
//   obstacle between the mob and both body heights, then `took_cover`.
// - every own health drop while the nearest hostile is an archer counts as an arrow hit
//   (`totals.arrowHits`, `FightResult.arrowHits`).
//
// Track AH (wave 9, combat v3, docs/pve.md "Targeting" and "Shield", decision 0029):
// - re-targeting: on every strike cycle the fight re-picks its target among the threats within reach
//   (targeting.pickInReach: the mob that hit us in the last 10 s, then a creeper, then the nearest; the
//   current target keeps a 0.3-block bonus); a target that leaves reach while another threat is in
//   reach is dropped at once. When the target dies another one within reach is fought next; when a
//   switched-to target ends, the fight goes back to the requested one. `FightResult.retargets`.
//   Never while the target is a creeper (hit and run) or during a creeper interlude.
// - crowd rule: 3 or more melee threats within 4 blocks and health below 12 end the fight `crowded`
//   (the PvE controller's flee trigger); not again in a fight started within 3 s of the last one
//   (then no flight followed: the bot defends).
// - shield (shield.ts): a shield in the inventory goes to the offhand when no fight runs; in a fight
//   it is raised (sneak) while an archer's shot is due and the bot is not striking, and for 10 ticks
//   after a creeper's fuse lights (backing off facing it); never on a strike tick or within reach of
//   a melee target.
//
// Track AO (wave 9, docs/pve.md "Path-reachable targets", decision 0036): fast failure. An approach goto
// that ends `unreachable` ends the target at once (`approachTries`, default 1; was 3 gotos, each with the
// navigator's own 3 failed plans), and a target the bot neither gets 0.5 blocks closer to nor lands a hit
// on for `stallTicks` (60) while out of reach (or after 5 strikes in reach without a hit: a window or
// glass between) ends `unreachable` too (a partial plan that walks into a wall, a near goal reached on
// the wrong side of a fence). Creepers (hit and run) and flying mobs (their own rule) are left out.
//
// Packet shape verified on BDS 1.26.60.6 (docs/pve.md "Packets"): transaction_type
// 'item_use_on_entity', transaction_data { entity_runtime_id, action_type 'attack', hotbar_slot,
// hand 'main_hand', held_item (the wire item as the server sent it), player_pos (eye), click_pos 0 }.
import { hasMending } from '../survival/tools.ts';
import { silentLogger, type Logger } from '../../log.ts';
import { events } from '../../events/bus.ts'; // decision 0059: combat.fight / combat.kill
import type { ItemV4 } from '../../world/packets.ts';
import type { EntityInfo, ItemStack, Vec3 } from '../../world/types.ts';
import { containersOf, HotbarPuller, type HotbarMoveContainers } from '../container/hotbar-moves.ts';
import type { MoveCommand } from '../input/types.ts';
import { angleDiff, turnTowards, yawTowards } from '../nav/follower.ts';
import type { Goal } from '../nav/goals.ts';
import type { GotoOptions, SkillResult } from '../types.ts';
import { aimPoint, bareType, classify, entityFeet, isArcher, isCreeper, isFlying, isPlayerEntity, reachDistance, type MobTracker } from './hostiles.ts';
import { CREEPER_BLOCK_TICKS, ShieldController } from './shield.ts';
import { crowdOf, CROWD_COUNT, CROWD_HEALTH, inReach, pickInReach, type GridLike } from './targeting.ts';

export const EYE_HEIGHT = 1.62;

interface LoopState {
  pos: Vec3;
  onGround: boolean;
  collidedHorizontally: boolean;
  ready: boolean;
}

/** The InputLoop as the controller uses it. */
export interface CombatLoop {
  readonly state: LoopState;
  readonly command: Readonly<MoveCommand>;
  setCommand(c: Partial<MoveCommand>): void;
  release(): void;
  onBeforeStep(fn: (tick: bigint, state: LoopState) => void): () => void;
}

/** BotSkills as the controller uses it (goto for the approach, cancel to take over steering). */
export interface CombatMover {
  goto(goal: Goal, opts?: GotoOptions): Promise<SkillResult>;
  cancel(): void;
  readonly nav: { readonly busy: boolean };
  /** Decision 0051: on pending scaffold (a felling pillar) or digging down from it: strike, never step (BotSkills). */
  onScaffold?(): boolean;
  /** Decision 0051: dig down off pending scaffold (BotSkills.descendFirst). */
  descendFirst?(): Promise<void>;
}

export interface CombatHotbar {
  select(slot: number): boolean;
  rawItem(slot: number): ItemV4 | undefined;
  noteRaw?(slot: number, item: ItemV4 | undefined): void;
}

export interface CombatDeps {
  loop: CombatLoop;
  mover: CombatMover;
  entities: () => ReadonlyMap<bigint, EntityInfo>;
  mobs: MobTracker;
  inventory: {
    readonly slots: readonly (ItemStack | null)[];
    readonly selected: number;
    /** Track AH: other windows (119 offhand) and model updates, for the shield. */
    window?(id: number): { slots: readonly (ItemStack | null)[] } | undefined;
    setItem?(window: number, slot: number, item: ItemStack | null): void;
  };
  /** Weapon switching and the held item of the attack packet; without it the bot hits with whatever it holds. */
  hotbar?: CombatHotbar;
  /** Where the attack packets go (the Connection). */
  source: { queue(name: string, params: Record<string, unknown>): void; on?(name: string, fn: (p: Record<string, unknown>) => void): () => void };
  /** Own runtime id (animate packet). */
  selfRuntimeId: () => bigint;
  /**
   * Track V: the task's Containers for main inventory -> hotbar moves. Default: the ones attached to
   * the mover (BotSkills, through `attach`), read at every pull. Never a second instance.
   */
  containers?: () => HotbarMoveContainers | undefined;
  /** Track V: the planner's grid (cover cells). Default: `mover.nav.grid`. */
  grid?: () => GridLike | undefined;
  logger?: Logger;
}

export interface FightOptions {
  /** Give up after this many ticks. Default 1200 (60 s). */
  timeoutTicks?: number;
  /** Farther than this (horizontal blocks) counts as out of range. Default 32. */
  maxRange?: number;
  /** Out of range this many ticks in a row ends the fight. Default 100. */
  outOfRangeTicks?: number;
  /** Ticks between strikes. Default 10. */
  cadence?: number;
  /** Max eye-to-box distance for a strike. Default 3.0 (vanilla survival reach). */
  reach?: number;
  /** Walk to the target. false = defend in place: only turn and strike within reach. Default true. */
  approach?: boolean;
  /** Distance kept from a creeper with a lit fuse. Default 7. */
  creeperSafe?: number;
  /** Below this own health creepers are avoided, not fought, and archers make the bot take cover. Default 10. */
  lowHealth?: number;
  /** Distance a creeper is avoided to before `creeper_avoided`. Default 11 (it keeps walking after us: 8 or more by the server a moment later). */
  creeperAvoid?: number;
  /** Fight a creeper that comes within 6 blocks first (then go back to the target). Default true. */
  creeperFirst?: boolean;
  /** Track AH: re-pick the target within reach on every strike cycle. Default: the controller's `retarget` (true). */
  retarget?: boolean;
  /** Track AH: the crowd rule ends the fight `crowded`. Default: the controller's `crowdRule` (true). */
  crowd?: boolean;
  /** Track AO: approach gotos ending `unreachable` before the target ends `unreachable`. Default 1 (was 3). */
  approachTries?: number;
  /** Track AO: ticks without getting 0.5 blocks closer or landing a hit before the target ends `unreachable`. Default 60; 0 = off. */
  stallTicks?: number;
}

export type FightOutcome =
  | 'killed'
  | 'gone'
  | 'exploded'
  | 'out_of_range'
  | 'timeout'
  | 'unreachable'
  | 'interrupted'
  | 'refused_player'
  | 'no_target'
  | 'creeper_avoided'
  | 'took_cover'
  | 'crowded';

export interface FightResult {
  ok: boolean;
  reason: FightOutcome;
  runtimeId: bigint;
  type: string;
  ticks: number;
  /** Attack packets sent. */
  attacks: number;
  /** Attacks followed by a melee hurt animation (data 2) of the target within 8 ticks. */
  landed: number;
  /** Own health lost during the fight (sum of drops). */
  damageTaken: number;
  weapon: string | null;
  /** Track V: own health drops while the nearest hostile was an archer. */
  arrowHits?: number;
  /** Track V: the weapon was moved from the main inventory into the hotbar for this fight. */
  pulled?: boolean;
  /** Track V: creepers fought in between (type, outcome). */
  interludes?: { type: string; reason: FightOutcome }[];
  /** Track AH: switches from a live target to another one within reach. */
  retargets?: number;
  /** Track AH: mobs killed in this fight (the target, others within reach, creepers in between). */
  kills?: number;
  /** Track AH: ticks the shield was up. */
  shieldTicks?: number;
}

/** Bedrock melee damage of weapons (sword > axe > anything else). */
const WEAPON_DAMAGE: Readonly<Record<string, number>> = {
  netherite_sword: 8,
  diamond_sword: 7,
  iron_sword: 6,
  stone_sword: 5,
  golden_sword: 4,
  wooden_sword: 4,
  netherite_axe: 7,
  diamond_axe: 6,
  iron_axe: 5,
  stone_axe: 4,
  golden_axe: 3,
  wooden_axe: 3,
};

/** Higher is better: swords first, then axes, then a trident or mace, then anything (fist 0). */
export function weaponScore(name: string | undefined): number {
  if (!name) return 0;
  const n = bareType(name);
  const d = WEAPON_DAMAGE[n];
  if (n.endsWith('_sword')) return 200 + (d ?? 4);
  if (n.endsWith('_axe')) return 100 + (d ?? 3);
  if (n === 'trident' || n === 'mace') return 50;
  if (n.endsWith('_pickaxe') || n.endsWith('_shovel') || n.endsWith('_hoe')) return 20; // better than a fist, far below a blade
  return 0; // food, blocks, torches: never a weapon (bds-pve 2026-10-30: a worn-out sword left the bot fighting with cooked beef, 21 damage taken)
}

/** Swords and axes only (what is worth moving from the main inventory). */
export function bladeScore(item: Pick<ItemStack, 'name'>): number {
  const s = weaponScore(item.name);
  return s >= 100 ? s : 0;
}

/** The hotbar slot (0..8) with the best weapon; the selected slot wins ties. undefined = empty hotbar. */
export function bestWeaponSlot(slots: readonly (ItemStack | null)[], selected: number, toolOk: (item: ItemStack) => boolean = () => true): number | undefined {
  // intact weapons and tools first (Track S: worn ones are spared); a worn blade is still the best thing in a fight for
  // the bot's life, so a second pass takes a worn sword or axe over bare hands: one without Mending first (a Mending
  // blade set aside to be mended is the owner's important one), then any
  for (const pass of [toolOk, (it: ItemStack) => bladeScore(it) > 0 && !hasMending(it), (it: ItemStack) => bladeScore(it) > 0]) {
    let best: number | undefined;
    let bestScore = 0;
    for (let i = 0; i < 9; i++) {
      const it = slots[i];
      if (!it || it.count <= 0 || !pass(it)) continue;
      const s = weaponScore(it.name) + (i === selected ? 0.5 : 0);
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    }
    if (best !== undefined) return best;
  }
  return undefined;
}

const AIR_ITEM: ItemV4 & { extra: unknown } = {
  network_id: 0,
  count: 0,
  metadata: 0,
  has_stack_id: false,
  block_runtime_id: 0,
  extra: { has_nbt: 0, can_place_on: [], can_destroy: [] },
};

/** The attack transaction (inventory_transaction params), BDS 1.26.60 shape. */
export function attackTransaction(a: { target: bigint; hotbarSlot: number; held: ItemV4 | undefined; eye: Vec3 }): Record<string, unknown> {
  return {
    transaction: {
      legacy: { legacy_request_id: 0 },
      transaction_type: 'item_use_on_entity',
      actions: [],
      transaction_data: {
        entity_runtime_id: a.target,
        action_type: 'attack',
        hotbar_slot: a.hotbarSlot,
        hand: 'main_hand',
        held_item: a.held && a.held.network_id !== 0 ? a.held : AIR_ITEM,
        player_pos: { ...a.eye },
        click_pos: { x: 0, y: 0, z: 0 },
      },
    },
  };
}

/** The arm swing that goes with an attack. */
export function swingPacket(self: bigint): Record<string, unknown> {
  return { action_id: 'swing_arm', runtime_entity_id: self, data: 0, has_swing_source: true, swing_source: 'attack', hand: 'main_hand' };
}

// ---- cover from archers -------------------------------------------------------------------------

/** A cell that blocks a line of sight: a collision box reaching the top of the block (not leaves). */
function solid(grid: GridLike, x: number, y: number, z: number): boolean {
  const c = grid.cls(x, y, z);
  return !!c && c.boxes.length > 0 && c.top >= 1 && !c.leaves;
}

/** The segment a -> b passes through a solid cell (sampled every 0.2 blocks, the end cells excluded). */
export function blocked(grid: GridLike, a: Vec3, b: Vec3): boolean {
  const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const n = Math.max(2, Math.ceil(d / 0.2));
  const ka = `${Math.floor(a.x)},${Math.floor(a.y)},${Math.floor(a.z)}`;
  const kb = `${Math.floor(b.x)},${Math.floor(b.y)},${Math.floor(b.z)}`;
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const x = Math.floor(a.x + (b.x - a.x) * t);
    const y = Math.floor(a.y + (b.y - a.y) * t);
    const z = Math.floor(a.z + (b.z - a.z) * t);
    const k = `${x},${y},${z}`;
    if (k === ka || k === kb) continue;
    if (solid(grid, x, y, z)) return true;
  }
  return false;
}

/**
 * The nearest standable cell within `r` blocks (horizontally, one level up or down) that puts a solid
 * obstacle between the mob's eye and both the feet (+0.4) and the eye (+1.5) of a body standing there.
 * Returns the cell (block position) or undefined.
 */
export function coverCell(grid: GridLike, me: Vec3, mobEye: Vec3, r = 6): Vec3 | undefined {
  const bx = Math.floor(me.x);
  const by = Math.floor(me.y + 1e-3);
  const bz = Math.floor(me.z);
  let best: { p: Vec3; d: number } | undefined;
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      const hd = Math.hypot(dx, dz);
      if (hd > r || (best && hd >= best.d)) continue;
      for (const dy of [0, -1, 1]) {
        const x = bx + dx;
        const y = by + dy;
        const z = bz + dz;
        const s = grid.stand(x, y, z);
        if (s === undefined || Number.isNaN(s)) continue;
        const feet = { x: x + 0.5, y: s, z: z + 0.5 };
        if (!blocked(grid, mobEye, { ...feet, y: s + 0.4 }) || !blocked(grid, mobEye, { ...feet, y: s + 1.5 })) continue;
        const d = Math.hypot(feet.x - me.x, feet.z - me.z);
        if (!best || d < best.d) best = { p: { x, y, z }, d };
        break;
      }
    }
  }
  return best?.p;
}

// ---- the fight ----------------------------------------------------------------------------------

/** Per-target state (the fight's target, or a creeper fought in between). */
interface Target {
  rid: bigint;
  type: string;
  creeper: boolean;
  flying: boolean;
  pending: { t: number; hurts: number }[];
  farTicks: number;
  gotoAt: Vec3 | undefined;
  gotoT: number;
  gotoFails: number;
  evading: boolean;
  calm: number;
  retreat: boolean;
  stuck: number;
  closeTicks: number;
  outOfReach: number;
  wasIgnited: number;
  lastHealth: number | undefined;
  dead: boolean;
  avoiding: boolean;
  cover: Vec3 | undefined;
  coverFrom: Vec3 | undefined;
  /** Track AH: tick the creeper's fuse last lit (shield up for 10 ticks after), and the fuse last tick. */
  litAt: number;
  lastIgnited: boolean;
  /** Track AH: tick of our last strike on it (its knockback is not "leaving reach"). */
  struckAt: number;
  /** Track AO: the stall watchdog: tick of the last progress (-1 = not started), closest reach since, hits landed (seen), strikes since. */
  progressT: number;
  best: number;
  landedN: number;
  landedSeen: number;
  strikesSince: number;
}

interface Fight {
  main: Target;
  tg: Target;
  o: Required<FightOptions>;
  t: number;
  lastStrike: number;
  attacks: number;
  landed: number;
  ourGoto: boolean;
  damageTaken: number;
  arrowHits: number;
  weapon: string | null;
  pulling: number | undefined;
  pulled: boolean;
  interludes: { type: string; reason: FightOutcome }[];
  /** Creepers not to fight in between again until the tick (an unreachable one would loop). */
  skip: Map<bigint, number>;
  resolve: (r: FightResult) => void;
  /** Track AH: the target the caller asked for, and whether it died. */
  req: { rid: bigint; type: string };
  reqDead: boolean;
  retargets: number;
  kills: number;
  /** Earlier targets with strikes still waiting for their hurt animation. */
  retired: Target[];
  /** The crowd rule is off for this fight (it started right after a `crowded` end: no flight came). */
  crowdOff: boolean;
  /** This tick: the bot strikes or is within reach of its melee target (no shield). */
  striking: boolean;
  /** This tick: runFrom wants the shield up (a creeper's fuse just lit). */
  blockNow: boolean;
  /** The shield is up (we set sneak). */
  blocking: boolean;
  /** The target just changed within reach: face it at once this tick. */
  snap: boolean;
  shieldTicks: number;
}

/** Max yaw change per tick while fighting (degrees). */
const TURN = 40;
const MELEE_RANGE = 3.5;
/** After a strike on a creeper, run until this far (feet, horizontal) before closing in again. */
const CREEPER_RETREAT = 8;
/** Never more than this many ticks within 3 blocks of a creeper. */
const CREEPER_CLOSE_TICKS = 10;
/** A creeper this close (3D, feet) is fought first. */
const CREEPER_FIRST = 6;
/** Strikes wait at most this long for a weapon move. */
const PULL_WAIT = 40;
/** A flying target out of reach this long ends the fight `unreachable`. */
const FLYING_OUT_OF_REACH = 20;
/** Track AH: a fight starting this soon (ticks) after a `crowded` end does not apply the crowd rule. */
const CROWD_REPEAT_TICKS = 60;
/** Track AO: no progress this long (ticks) ends the target `unreachable` (FightOptions.stallTicks default). */
export const STALL_TICKS = 60;
/** Track AO: getting this much closer (eye to box) counts as progress. */
const STALL_GAIN = 0.5;
/** Track AO: in reach, this many strikes without a hit landing count as no progress. */
const STALL_STRIKES = 5;

export class CombatController {
  private readonly d: CombatDeps;
  private readonly log: Logger;
  private active: Fight | undefined;
  private readonly unsubs: (() => void)[] = [];
  private n = 0;
  private readonly waiters: { left: number; resolve: () => void }[] = [];
  /** Totals over all fights (metrics). */
  readonly totals = { fights: 0, kills: 0, attacks: 0, landed: 0, arrowHits: 0, pulls: 0, creepersAvoided: 0, cover: 0, retargets: 0, crowded: 0, shieldTicks: 0 };
  /** Track AH: re-pick the target within reach on every strike cycle (FightOptions.retarget default). */
  retarget = true;
  /** Track AH: the crowd rule (FightOptions.crowd default; targeting.crowded reads it too, for the flight). */
  crowdRule = true;
  /** Track AH: offhand shield (equip, archer shot prediction). */
  readonly shield: ShieldController;
  private lastCrowdedN = -Infinity;
  /** Track S: weapon choice skips items failing this (worn weapons, skills/survival/tools.ts); default all ok. */
  toolOk: (item: ItemStack) => boolean = () => true;
  /** Track V: main inventory -> hotbar moves (weapons here, pickaxes / axes / shovels for the Digger). */
  readonly puller: HotbarPuller;

  constructor(deps: CombatDeps & { toolOk?: (item: ItemStack) => boolean }) {
    if (deps.toolOk) this.toolOk = deps.toolOk; // Track S
    this.d = deps;
    this.log = deps.logger ?? silentLogger;
    this.puller = new HotbarPuller({
      containers: () => (deps.containers ? deps.containers() : containersOf(deps.mover)),
      hotbar: () => deps.hotbar,
      inventory: () => deps.inventory,
      toolOk: () => this.toolOk,
      queue: (name, params) => deps.source.queue(name, params),
      runtimeId: deps.selfRuntimeId,
      waitTicks: (k) => this.waitTicks(k),
      logger: this.log,
    });
    this.shield = new ShieldController({
      inventory: deps.inventory,
      source: deps.source,
      containers: () => (deps.containers ? deps.containers() : containersOf(deps.mover)),
      runtimeId: deps.selfRuntimeId,
      entities: deps.entities,
      mobs: deps.mobs,
      waitTicks: (k) => this.waitTicks(k),
      logger: this.log,
    });
    this.unsubs.push(
      deps.loop.onBeforeStep((_tick, s) => {
        this.stepWaiters();
        if (++this.n % 20 === 0) this.installDiggerHook();
        this.shield.tick(s.ready ? s.pos : undefined, !this.active);
        this.onTick(s);
        this.applyShield(s);
      }),
      deps.mobs.onHit((_g, damage) => {
        const archer = this.nearestHostileIsArcher();
        if (archer) this.totals.arrowHits++;
        if (this.active) {
          this.active.damageTaken += damage;
          if (archer) this.active.arrowHits++;
        }
      }),
    );
  }

  get busy(): boolean {
    return this.active !== undefined;
  }

  /** Track AH: a fight ended `crowded` in the last 5 ticks (the flee trigger, targeting.crowded). */
  get crowdedRecently(): boolean {
    return this.n - this.lastCrowdedN <= 5;
  }

  /** Runtime id and type of the current target (a creeper fought in between while that runs). */
  get target(): { runtimeId: bigint; type: string } | undefined {
    return this.active ? { runtimeId: this.active.tg.rid, type: this.active.tg.type } : undefined;
  }

  dispose(): void {
    this.cancel();
    this.shield.dispose();
    for (const u of this.unsubs.splice(0)) u();
    for (const w of this.waiters.splice(0)) w.resolve();
  }

  cancel(): void {
    if (this.active) this.finish(this.active, 'interrupted');
  }

  /** Select the best weapon in the hotbar (sword > axe > anything). Returns its name, or null. */
  selectWeapon(): string | null {
    const inv = this.d.inventory;
    const slot = bestWeaponSlot(inv.slots, inv.selected, this.toolOk); // Track S
    if (slot === undefined) return null;
    if (slot !== inv.selected) this.d.hotbar?.select(slot);
    return inv.slots[slot]?.name ?? null;
  }

  /**
   * A sword or axe in the hotbar: when there is none but the main inventory has one (not worn), move it
   * in and select it. Resolves with the weapon name, or undefined when nothing was moved.
   */
  async pullWeapon(): Promise<string | undefined> {
    const p = this.weaponPull();
    if (!p) return undefined;
    const r = await p;
    return r.ok && r.moved ? r.item : undefined;
  }

  /**
   * One strike now, if the target is a non-player within reach. Returns false when refused or out of
   * reach. Does not turn: call it while facing the target (fight() does both).
   */
  attack(rid: bigint, opts: { reach?: number } = {}): boolean {
    const e = this.d.entities().get(rid);
    if (!e || isPlayerEntity(e)) return false;
    const s = this.d.loop.state;
    const eye = { x: s.pos.x, y: s.pos.y + EYE_HEIGHT, z: s.pos.z };
    if (reachDistance(eye, e) > (opts.reach ?? 3.0)) return false;
    this.strike(rid, eye);
    return true;
  }

  /** Fight one entity until it dies or the fight ends (see the file comment). Cancels a running fight. */
  fight(rid: bigint, opts: FightOptions = {}): Promise<FightResult> {
    this.cancel();
    const e = this.d.entities().get(rid);
    const base = { runtimeId: rid, type: e?.type ?? '?', ticks: 0, attacks: 0, landed: 0, damageTaken: 0, weapon: null };
    if (!e) return Promise.resolve({ ok: false, reason: 'no_target', ...base });
    if (isPlayerEntity(e)) {
      this.log.warn(`combat: refusing to fight player ${e.username ?? e.type} (PvE only)`);
      return Promise.resolve({ ok: false, reason: 'refused_player', ...base });
    }
    const weapon = this.selectWeapon();
    this.totals.fights++;
    const pull = this.weaponPull();
    this.log.info(`combat: fighting ${bareType(e.type)} (runtime id ${rid}) with ${weapon ?? 'bare hands'}${pull ? ' (fetching a weapon from the inventory)' : ''}`);
    return new Promise((resolve) => {
      const f: Fight = {
        main: this.newTarget(e),
        tg: undefined as unknown as Target,
        o: {
          timeoutTicks: opts.timeoutTicks ?? 1200,
          maxRange: opts.maxRange ?? 32,
          outOfRangeTicks: opts.outOfRangeTicks ?? 100,
          cadence: opts.cadence ?? 10,
          reach: opts.reach ?? 3.0,
          approach: opts.approach ?? true,
          creeperSafe: opts.creeperSafe ?? 7,
          lowHealth: opts.lowHealth ?? 10,
          creeperAvoid: opts.creeperAvoid ?? 11,
          creeperFirst: opts.creeperFirst ?? true,
          retarget: opts.retarget ?? this.retarget,
          crowd: opts.crowd ?? this.crowdRule,
          approachTries: opts.approachTries ?? 1, // Track AO
          stallTicks: opts.stallTicks ?? STALL_TICKS,
        },
        t: 0,
        lastStrike: -Infinity,
        attacks: 0,
        landed: 0,
        ourGoto: false,
        damageTaken: 0,
        arrowHits: 0,
        weapon,
        pulling: pull ? 0 : undefined,
        pulled: false,
        interludes: [],
        skip: new Map(),
        resolve,
        req: { rid, type: e.type },
        reqDead: false,
        retargets: 0,
        kills: 0,
        retired: [],
        crowdOff: this.n - this.lastCrowdedN < CROWD_REPEAT_TICKS,
        striking: false,
        blockNow: false,
        blocking: false,
        snap: false,
        shieldTicks: 0,
      };
      f.tg = f.main;
      this.active = f;
      if (pull) {
        void pull.then((r) => {
          if (this.active !== f) return;
          f.pulling = undefined;
          if (r.ok && r.moved) {
            f.pulled = true;
            this.totals.pulls++;
            f.weapon = this.selectWeapon();
          }
        });
      }
    });
  }

  // ---- internals ---------------------------------------------------------------------------------

  private newTarget(e: EntityInfo): Target {
    return {
      rid: e.runtimeId,
      type: e.type,
      creeper: isCreeper(e.type),
      flying: isFlying(e.type),
      pending: [],
      farTicks: 0,
      gotoAt: undefined,
      gotoT: -Infinity,
      gotoFails: 0,
      evading: false,
      calm: 0,
      retreat: false,
      stuck: 0,
      closeTicks: 0,
      outOfReach: 0,
      wasIgnited: -Infinity,
      lastHealth: this.d.mobs.get(e.runtimeId)?.health,
      dead: false,
      avoiding: false,
      cover: undefined,
      coverFrom: undefined,
      litAt: -Infinity,
      lastIgnited: false,
      struckAt: -Infinity,
      progressT: -1, // Track AO
      best: Infinity,
      landedN: 0,
      landedSeen: 0,
      strikesSince: 0,
    };
  }

  /** A sword / axe move from the main inventory, when the hotbar has none. */
  private weaponPull(): ReturnType<HotbarPuller['pull']> {
    const inv = this.d.inventory;
    for (let i = 0; i < 9; i++) {
      const it = inv.slots[i];
      if (it && it.count > 0 && bladeScore(it) > 0 && this.toolOk(it)) return undefined;
    }
    return this.puller.pull('weapon', bladeScore, { select: true });
  }

  private ownHealth(): number {
    return this.d.mobs.selfHealth ?? 20;
  }

  private nearestHostileIsArcher(): boolean {
    const s = this.d.loop.state;
    if (!s.ready) return false;
    let best: { e: EntityInfo; d: number } | undefined;
    for (const e of this.d.entities().values()) {
      if (classify(e.type) !== 'hostile' || this.d.mobs.get(e.runtimeId)?.dead) continue;
      const f = entityFeet(e);
      const d = Math.hypot(f.x - s.pos.x, f.y - s.pos.y, f.z - s.pos.z);
      if (d <= 32 && (!best || d < best.d)) best = { e, d };
    }
    return best !== undefined && isArcher(best.e, this.d.mobs);
  }

  private grid(): GridLike | undefined {
    if (this.d.grid) return this.d.grid();
    const g = (this.d.mover.nav as { grid?: GridLike }).grid;
    return g && typeof g.stand === 'function' ? g : undefined;
  }

  private waitTicks(k: number): Promise<void> {
    return new Promise((resolve) => {
      // the loop may stop ticking (disconnect): a timer ends the wait anyway
      const w = {
        left: k,
        resolve: (): void => {
          clearTimeout(timer);
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve();
        },
      };
      const timer = setTimeout(() => w.resolve(), k * 50 + 2000);
      this.waiters.push(w);
    });
  }

  private stepWaiters(): void {
    for (const w of [...this.waiters]) if (--w.left <= 0) w.resolve();
  }

  /** The Digger (re-created by BotSkills now and then) gets the pickaxe / axe / shovel pull hook. */
  private installDiggerHook(): void {
    let dg: { pullTool?: (block: string) => Promise<unknown> | undefined } | undefined;
    try {
      dg = (this.d.mover as unknown as { digger?: { pullTool?: (block: string) => Promise<unknown> | undefined } }).digger;
    } catch {
      return;
    }
    if (dg && typeof dg === 'object' && dg.pullTool !== this.puller.digHook) dg.pullTool = this.puller.digHook;
  }

  private strike(rid: bigint, eye: Vec3): void {
    const slot = this.d.inventory.selected;
    this.d.source.queue('animate', swingPacket(this.d.selfRuntimeId()));
    this.d.source.queue('inventory_transaction', attackTransaction({ target: rid, hotbarSlot: slot, held: this.d.hotbar?.rawItem(slot), eye }));
    this.totals.attacks++;
  }

  private finish(f: Fight, reason: FightOutcome): void {
    if (this.active !== f) return;
    this.active = undefined;
    if (f.ourGoto && this.d.mover.nav.busy) this.d.mover.cancel();
    this.d.loop.release();
    // pending strikes that already show a hurt count as landed
    this.settle(f, f.tg, true);
    for (const old of f.retired) this.settle(f, old, true);
    this.totals.shieldTicks += f.shieldTicks;
    const r: FightResult = {
      ok: reason === 'killed',
      reason,
      runtimeId: f.req.rid,
      type: f.req.type,
      ticks: f.t,
      attacks: f.attacks,
      landed: f.landed,
      damageTaken: +f.damageTaken.toFixed(2),
      weapon: f.weapon,
      arrowHits: f.arrowHits,
      pulled: f.pulled,
      interludes: f.interludes,
      retargets: f.retargets,
      kills: f.kills,
      shieldTicks: f.shieldTicks,
    };
    this.log.info(
      `combat: ${bareType(f.req.type)} ${reason} after ${f.t} ticks, ${f.attacks} attack(s), ${f.landed} landed, ${r.damageTaken} damage taken` +
        `${f.arrowHits ? `, ${f.arrowHits} arrow hit(s)` : ''}${f.interludes.length ? `, in between: ${f.interludes.map((i) => `${bareType(i.type)} ${i.reason}`).join(', ')}` : ''}` +
        `, ${f.retargets} retarget(s), ${f.kills} kill(s)${f.shieldTicks ? `, shield up ${f.shieldTicks} ticks` : ''}`,
    );
    events.emit('combat.fight', { mob: bareType(f.req.type), outcome: reason, ticks: f.t, attacks: f.attacks, landed: f.landed, damageTaken: r.damageTaken, kills: f.kills }); // decision 0059
    f.resolve(r);
  }

  /** The current target ended: back to the fight's target after an interlude, else the fight ends. */
  private endTarget(f: Fight, reason: FightOutcome): void {
    if (reason === 'killed') {
      this.settle(f, f.tg, true);
      this.totals.kills++;
      f.kills++;
      events.emit('combat.kill', { mob: bareType(f.tg.type) }); // decision 0059
    }
    if (reason === 'creeper_avoided') this.totals.creepersAvoided++;
    if (reason === 'took_cover') this.totals.cover++;
    if (f.tg === f.main) {
      // Track AH: another threat within reach next; else back to the requested target
      if (f.main.rid === f.req.rid && reason === 'killed') f.reqDead = true;
      const next = reason === 'killed' || reason === 'gone' || ((reason === 'out_of_range' || reason === 'unreachable') && f.main.rid !== f.req.rid);
      if (f.o.retarget && next && this.nextTarget(f, reason)) return;
      this.finish(f, f.reqDead && (reason === 'killed' || reason === 'gone') ? 'killed' : reason);
      return;
    }
    f.interludes.push({ type: f.tg.type, reason });
    if (reason === 'unreachable' || reason === 'out_of_range') f.skip.set(f.tg.rid, f.t + 200);
    this.log.info(`combat: ${bareType(f.tg.type)} (in between) ${reason}; back to ${bareType(f.main.type)}`);
    if (f.ourGoto && this.d.mover.nav.busy) this.d.mover.cancel();
    f.ourGoto = false;
    f.tg = f.main;
    f.main.gotoT = -Infinity;
    f.main.gotoAt = undefined;
  }

  /** Count strikes whose target showed a melee hurt animation since. */
  private settle(f: Fight, tg: Target, all = false): void {
    const ms = this.d.mobs.get(tg.rid);
    const hurts = ms?.hurts ?? 0;
    tg.pending = tg.pending.filter((p) => {
      if (hurts > p.hurts && ms?.lastHurtData === 2) {
        f.landed++;
        tg.landedN++; // Track AO
        this.totals.landed++;
        return false;
      }
      if (tg.dead && (hurts > p.hurts || f.t - p.t <= 8)) {
        // the killing blow shows as death_animation, not as a hurt animation
        f.landed++;
        tg.landedN++;
        this.totals.landed++;
        return false;
      }
      return !all && f.t - p.t <= 8;
    });
  }

  /** A creeper within 6 blocks (not the target, alive, not a player). */
  private nearCreeper(pos: Vec3, except: bigint): EntityInfo | undefined {
    let best: { e: EntityInfo; d: number } | undefined;
    for (const e of this.d.entities().values()) {
      if (e.runtimeId === except || !isCreeper(e.type) || isPlayerEntity(e) || this.d.mobs.get(e.runtimeId)?.dead) continue;
      const f = entityFeet(e);
      const d = Math.hypot(f.x - pos.x, f.y - pos.y, f.z - pos.z);
      if (d <= CREEPER_FIRST && (!best || d < best.d)) best = { e, d };
    }
    return best?.e;
  }

  private onTick(s: LoopState): void {
    const f = this.active;
    if (!f || !s.ready) return;
    f.t++;
    if (f.pulling !== undefined && ++f.pulling > PULL_WAIT) f.pulling = undefined;
    f.striking = false;
    f.blockNow = false;
    for (const old of f.retired) this.settle(f, old);
    if (f.retired.length) f.retired = f.retired.filter((x) => x.pending.length > 0);

    // Track AH: the crowd rule (the PvE controller turns `crowded` into a flight)
    if (f.o.crowd && !f.crowdOff && this.ownHealth() < CROWD_HEALTH) {
      const crowd = crowdOf(this.d.entities().values(), this.d.mobs, s.pos);
      if (crowd.length >= CROWD_COUNT) {
        this.lastCrowdedN = this.n;
        this.totals.crowded++;
        this.log.warn(`combat: ${crowd.length} melee mobs within 4 blocks at health ${this.ownHealth()}: crowded`);
        this.finish(f, 'crowded');
        return;
      }
    }

    // a creeper coming close is fought first (the fight goes back to its target afterwards)
    if (f.tg === f.main && !f.main.creeper && f.o.approach && f.o.creeperFirst) {
      const c = this.nearCreeper(s.pos, f.main.rid);
      if (c && (f.skip.get(c.runtimeId) ?? 0) <= f.t) {
        this.log.info(`combat: ${bareType(c.type)} #${c.runtimeId} within ${CREEPER_FIRST} blocks: fighting it first`);
        if (f.ourGoto && this.d.mover.nav.busy) this.d.mover.cancel();
        f.ourGoto = false;
        f.tg = this.newTarget(c);
      }
    }

    // Track AH: re-pick the target within reach (strike cycle; at once when it left reach)
    if (f.o.retarget && f.tg === f.main && !f.main.creeper) this.retargetInReach(f, s);

    const tg = f.tg;
    const e = this.d.entities().get(tg.rid);
    const ms = this.d.mobs.get(tg.rid);
    if (ms) {
      if (ms.health !== undefined) tg.lastHealth = ms.health;
      if (ms.dead) tg.dead = true;
      if (ms.ignited) tg.wasIgnited = f.t;
      if (tg.creeper && ms.ignited && !tg.lastIgnited) tg.litAt = f.t; // Track AH: the shield's 10 ticks
      tg.lastIgnited = ms.ignited;
    }
    this.settle(f, tg);
    if (!e) {
      this.endTarget(f, tg.dead || (tg.lastHealth !== undefined && tg.lastHealth <= 0) ? 'killed' : tg.creeper && f.t - tg.wasIgnited <= 5 ? 'exploded' : 'gone');
      return;
    }
    if (isPlayerEntity(e)) {
      this.finish(f, 'refused_player');
      return;
    }
    if (tg.dead) {
      this.endTarget(f, 'killed');
      return;
    }
    if (f.t > f.o.timeoutTicks) {
      this.finish(f, 'timeout');
      return;
    }
    const loop = this.d.loop;
    const eye = { x: s.pos.x, y: s.pos.y + EYE_HEIGHT, z: s.pos.z };
    const feet = entityFeet(e);
    const dx = feet.x - s.pos.x;
    const dz = feet.z - s.pos.z;
    const hd = Math.hypot(dx, dz);
    const dy = feet.y - s.pos.y;
    const aim = aimPoint(e);
    const wantYaw = hd > 1e-3 ? yawTowards(dx, dz) : loop.command.yaw;
    const wantPitch = (-Math.atan2(aim.y - eye.y, Math.max(hd, 1e-3)) * 180) / Math.PI;
    const away = hd > 1e-3 ? yawTowards(-dx, -dz) : loop.command.yaw + 180;
    const low = this.ownHealth() < f.o.lowHealth;
    const reachNow = reachDistance(eye, e);

    if (hd > f.o.maxRange) {
      tg.farTicks++;
      if (tg.farTicks >= f.o.outOfRangeTicks) {
        this.endTarget(f, 'out_of_range');
        return;
      }
    } else {
      tg.farTicks = 0;
    }

    // below health 10 a creeper is not engaged: run until it is creeperAvoid blocks away
    if (tg.creeper && f.o.approach && (low || tg.avoiding)) {
      if (!tg.avoiding) this.log.info(`combat: health ${this.ownHealth()} < ${f.o.lowHealth}: avoiding ${bareType(tg.type)} #${tg.rid}`);
      tg.avoiding = true;
      if (hd >= f.o.creeperAvoid) {
        this.endTarget(f, 'creeper_avoided');
        return;
      }
      this.runFrom(f, tg, s, away, feet);
      return;
    }

    // creeper hit and run: after every strike sprint away until 8 blocks (the fuse lights within
    // about 3.5 blocks, i.e. at every strike; it goes out once we are far enough), then wait for it
    if (tg.creeper && tg.retreat && f.o.approach) {
      if (hd < CREEPER_RETREAT) {
        this.runFrom(f, tg, s, away, feet);
        return;
      }
      tg.retreat = false;
      if ((ms?.ignited ?? false) || f.t - tg.wasIgnited < 20) {
        tg.evading = true;
        tg.calm = 0;
      }
    }

    // creeper with a lit fuse: get away, wait for the fuse to go out
    if (tg.creeper && (ms?.ignited ?? false) && hd < f.o.creeperSafe) {
      tg.evading = true;
      tg.calm = 0;
      this.runFrom(f, tg, s, away, feet);
      return;
    }
    if (tg.evading) {
      // stand, face it, wait until the fuse has been out for 10 ticks
      if (!(ms?.ignited ?? false)) tg.calm++;
      loop.setCommand({ yaw: turnTowards(loop.command.yaw, wantYaw, TURN), pitch: wantPitch, forward: 0, strafe: 0, sprint: false, jump: false });
      if (tg.calm < 10) return;
      tg.evading = false;
    }

    // archers below health 10: break the line of sight
    const archer = isArcher(e, this.d.mobs);
    if (archer && low && f.o.approach && reachNow > f.o.reach) {
      if (this.takeCover(f, tg, s.pos, e)) return;
    }

    // Track AO: the stall watchdog (no 0.5 blocks closer, no hit landed): a wall, glass or a fence between
    if (f.o.approach && f.o.stallTicks > 0 && !tg.flying && !tg.creeper) {
      if (tg.progressT < 0 || tg.landedN > tg.landedSeen || reachNow < tg.best - STALL_GAIN) {
        tg.progressT = f.t;
        tg.best = reachNow;
        tg.landedSeen = tg.landedN;
        tg.strikesSince = 0;
      } else if (f.t - tg.progressT >= f.o.stallTicks && (reachNow > f.o.reach + 0.3 || tg.strikesSince >= STALL_STRIKES)) {
        this.log.info(`combat: no progress on ${bareType(tg.type)} #${tg.rid} for ${f.t - tg.progressT} ticks (closest ${tg.best.toFixed(1)}, now ${reachNow.toFixed(1)}, ${tg.strikesSince} strike(s) without a hit): unreachable`);
        this.endTarget(f, 'unreachable');
        return;
      }
    }

    let yaw: number;
    if (tg.flying) {
      // never chased: face it, strike within reach, give up when it stays out of reach
      this.takeOver(f);
      yaw = f.snap ? wantYaw : turnTowards(loop.command.yaw, wantYaw, TURN);
      const perch = this.d.mover.onScaffold?.() ?? false; // decision 0051: on a pillar: keep sneaking
      loop.setCommand({ yaw, pitch: wantPitch, forward: 0, strafe: 0, sprint: false, sneak: perch, jump: false });
      tg.outOfReach = reachNow > f.o.reach + 0.2 ? tg.outOfReach + 1 : 0;
      if (tg.outOfReach >= FLYING_OUT_OF_REACH) {
        this.endTarget(f, 'unreachable');
        return;
      }
    } else if ((hd <= MELEE_RANGE && Math.abs(dy) < 1.2) || !f.o.approach) {
      this.takeOver(f);
      // Track AH: a new target within reach is faced at once (a 180-degree turn at 40 per tick cost 5 ticks per switch)
      yaw = f.snap && reachNow <= f.o.reach ? wantYaw : turnTowards(loop.command.yaw, wantYaw, TURN);
      let forward = 0;
      let sprint = false;
      if (f.o.approach) {
        if (tg.creeper) {
          // sprint in for the strike (sprint knockback); never more than 10 ticks within 3 blocks
          tg.closeTicks = hd < 3 ? tg.closeTicks + 1 : 0;
          if (tg.closeTicks > CREEPER_CLOSE_TICKS) {
            tg.retreat = true;
            this.runFrom(f, tg, s, away, feet);
            return;
          }
          forward = 1;
          sprint = true;
        } else if (hd > 2.2) {
          forward = 1;
          sprint = archer;
        } else if (hd < 1.0) forward = -1;
      }
      // decision 0051: on pending scaffold (a 1 x 1 pillar top, or digging down from it) strike only, never step
      const perch = this.d.mover.onScaffold?.() ?? false;
      if (perch) {
        forward = 0;
        sprint = false;
      }
      loop.setCommand({ yaw, pitch: wantPitch, forward, strafe: 0, sprint, sneak: perch, jump: forward > 0 && s.collidedHorizontally && s.onGround });
    } else {
      // approach with the navigator; it steers yaw, we steer the pitch
      const moved = tg.gotoAt ? Math.hypot(feet.x - tg.gotoAt.x, feet.z - tg.gotoAt.z) : Infinity;
      if ((!this.d.mover.nav.busy || moved > 1.5) && f.t - tg.gotoT >= 10) this.approach(f, tg, feet, hd > 8 || archer || tg.creeper);
      loop.setCommand({ pitch: wantPitch });
      yaw = loop.command.yaw;
    }

    f.snap = false;
    if (!tg.creeper && reachNow <= f.o.reach + 0.3) f.striking = true; // Track AH: no shield within reach of a melee target
    if (f.pulling === undefined && f.t - f.lastStrike >= f.o.cadence && Math.abs(angleDiff(yaw, wantYaw)) <= 35 && reachNow <= f.o.reach) {
      f.striking = true;
      f.lastStrike = f.t;
      f.attacks++;
      tg.pending.push({ t: f.t, hurts: ms?.hurts ?? 0 });
      tg.struckAt = f.t;
      tg.strikesSince++; // Track AO
      this.strike(tg.rid, eye);
      if (tg.creeper) tg.retreat = true;
    }
  }

  /**
   * Sprint straight away from the target (yaw at most 90 degrees per tick). Against a wall for 6 ticks
   * (a crater, a ledge): the navigator walks to a point 10 blocks away instead, then steering resumes.
   */
  private runFrom(f: Fight, tg: Target, s: LoopState, away: number, mob: Vec3): void {
    if (tg.creeper && f.t - tg.litAt < CREEPER_BLOCK_TICKS && this.shield.equipped()) {
      // Track AH: the fuse just lit: back off facing it with the shield up, then run
      this.takeOver(f);
      f.blockNow = true;
      this.d.loop.setCommand({ yaw: turnTowards(this.d.loop.command.yaw, away + 180, 90), pitch: 0, forward: -1, strafe: 0, sprint: false, jump: false });
      return;
    }
    tg.stuck = s.collidedHorizontally ? tg.stuck + 1 : 0;
    if (tg.stuck >= 6 || (f.ourGoto && this.d.mover.nav.busy)) {
      if (!this.d.mover.nav.busy && f.t - tg.gotoT >= 10) {
        tg.gotoT = f.t;
        f.ourGoto = true;
        const dx = s.pos.x - mob.x;
        const dz = s.pos.z - mob.z;
        const d = Math.hypot(dx, dz) || 1;
        const p = { x: s.pos.x + (dx / d) * 10, y: Math.round(s.pos.y), z: s.pos.z + (dz / d) * 10 };
        void this.d.mover.goto({ type: 'near', p, r: 3 }, { timeoutTicks: 200, sprint: true }).then(() => {
          if (this.active === f) tg.stuck = 0;
        });
      }
      this.d.loop.setCommand({ pitch: 0 });
      return;
    }
    this.takeOver(f);
    this.d.loop.setCommand({ yaw: turnTowards(this.d.loop.command.yaw, away, 90), pitch: 0, forward: 1, strafe: 0, sprint: true, sneak: false, jump: s.collidedHorizontally && s.onGround });
  }

  /** Walk to (or stand in) a cell out of the archer's sight; true while that is what happens. */
  private takeCover(f: Fight, tg: Target, me: Vec3, e: EntityInfo): boolean {
    const grid = this.grid();
    if (!grid) return false;
    const mf = entityFeet(e);
    const mobEye = { x: mf.x, y: mf.y + 1.5, z: mf.z };
    if (!tg.cover || !tg.coverFrom || Math.hypot(mf.x - tg.coverFrom.x, mf.z - tg.coverFrom.z) > 3) {
      tg.cover = coverCell(grid, me, mobEye);
      tg.coverFrom = { ...mf };
      if (!tg.cover) return false;
      this.log.info(`combat: health ${this.ownHealth()}: taking cover from ${bareType(tg.type)} at ${tg.cover.x} ${tg.cover.y} ${tg.cover.z}`);
      tg.gotoT = -Infinity;
    }
    const c = tg.cover;
    if (Math.hypot(me.x - (c.x + 0.5), me.z - (c.z + 0.5)) < 0.6 && Math.abs(me.y - c.y) < 1.1) {
      this.endTarget(f, 'took_cover');
      return true;
    }
    if (!this.d.mover.nav.busy && f.t - tg.gotoT >= 10) {
      tg.gotoT = f.t;
      f.ourGoto = true;
      void this.d.mover.goto({ type: 'block', p: c }, { timeoutTicks: 200, sprint: true }).then((r) => {
        if (this.active !== f || f.tg !== tg) return;
        if (!r.ok && r.reason !== 'interrupted') tg.cover = undefined; // try another cell (or fight on)
      });
    }
    return true;
  }

  // ---- Track AH: re-targeting, the shield ---------------------------------------------------------

  /** The threats within reach now (eye to box 3.2), creepers only when they may be engaged. */
  private reachCandidates(f: Fight, s: LoopState): ReturnType<typeof inReach> {
    const eye = { x: s.pos.x, y: s.pos.y + EYE_HEIGHT, z: s.pos.z };
    const noCreepers = !f.o.approach || this.ownHealth() < f.o.lowHealth;
    return inReach(this.d.entities().values(), this.d.mobs, eye, { noCreepers }).filter((c) => !isPlayerEntity(c.e) && !this.d.mobs.get(c.e.runtimeId)?.dead && (f.skip.get(c.e.runtimeId) ?? 0) <= f.t);
  }

  /** Make `e` the fight's target (the main one). */
  private switchTo(f: Fight, e: EntityInfo, why: string, live: boolean): void {
    const old = f.main;
    if (old.pending.length) f.retired.push(old);
    if (f.ourGoto && this.d.mover.nav.busy) this.d.mover.cancel();
    f.ourGoto = false;
    f.main = this.newTarget(e);
    f.tg = f.main;
    f.snap = true;
    if (live) {
      f.retargets++;
      this.totals.retargets++;
    }
    this.log.info(`combat: ${live ? 'retarget' : 'next'} ${bareType(old.type)} #${old.rid} -> ${bareType(e.type)} #${e.runtimeId} (${why})`);
  }

  /**
   * On every strike cycle, and at once when the target is out of reach (unless our own strike knocked it
   * there less than a cycle ago): the best threat within reach (targeting.pickInReach) becomes the
   * target. Nothing in reach: the existing rules go on.
   */
  private retargetInReach(f: Fight, s: LoopState): void {
    const cur = f.main;
    if (cur.dead || this.d.mobs.get(cur.rid)?.dead || !this.d.entities().has(cur.rid)) return; // ends as killed / gone first
    const ready = f.pulling === undefined && f.t - f.lastStrike >= f.o.cadence;
    const cands = this.reachCandidates(f, s);
    if (cands.length === 0) return;
    const curIn = cands.some((c) => c.e.runtimeId === cur.rid);
    if (curIn && !ready) return;
    // knocked out of reach by our own strike: it comes back; decide on the next strike cycle (switching at
    // once made the bot alternate between two zombies on every knockback: 13 hits taken against 5, docs/pve.md)
    if (!curIn && !ready && f.t - cur.struckAt < f.o.cadence) return;
    const best = pickInReach(cands, cur.rid);
    if (!best || best.e.runtimeId === cur.rid) return;
    const why = curIn ? (best.hitUs ? `it hit us, strike cycle` : best.creeper ? 'creeper, strike cycle' : 'nearer, strike cycle') : `${bareType(cur.type)} out of reach`;
    this.switchTo(f, best.e, why, true);
  }

  /** The fight's target ended (`reason`): fight a threat within reach next, else go back to the requested target. */
  private nextTarget(f: Fight, reason: FightOutcome): boolean {
    const s = this.d.loop.state;
    const ended = f.main.rid;
    const best = pickInReach(this.reachCandidates(f, s).filter((c) => c.e.runtimeId !== ended), undefined);
    if (best) {
      this.switchTo(f, best.e, `${bareType(f.main.type)} ${reason}, within reach`, false);
      return true;
    }
    if (!f.reqDead && ended !== f.req.rid) {
      const e = this.d.entities().get(f.req.rid);
      if (e && !this.d.mobs.get(f.req.rid)?.dead) {
        this.switchTo(f, e, `${bareType(f.main.type)} ${reason}, back to the target`, false);
        return true;
      }
    }
    return false;
  }

  /**
   * After every tick of a fight: the shield (sneak) is up while runFrom backs off a freshly lit creeper,
   * or an archer's shot is due (shield.threat) and the bot is not striking. Only our own sneak is
   * lowered again; finish() releases the loop anyway.
   */
  private applyShield(s: LoopState): void {
    const f = this.active;
    if (!f || !s.ready) return;
    let want = false;
    if (this.shield.equipped()) want = f.blockNow || (!f.striking && this.shield.threat(s.pos) !== undefined);
    if (want) {
      this.d.loop.setCommand({ sneak: true, sprint: false });
      f.shieldTicks++;
      this.shield.noteRaised();
    } else if (f.blocking) {
      this.d.loop.setCommand({ sneak: false });
    }
    f.blocking = want;
  }

  /** Stop our approach goto (or anybody's) so the controller steers. */
  private takeOver(f: Fight): void {
    if (this.d.mover.nav.busy) this.d.mover.cancel();
    f.ourGoto = false;
  }

  private approach(f: Fight, tg: Target, feet: Vec3, sprint: boolean): void {
    tg.gotoAt = { ...feet };
    tg.gotoT = f.t;
    f.ourGoto = true;
    const goal: Goal = { type: 'near', p: { x: feet.x, y: Math.round(feet.y), z: feet.z }, r: 2.5 };
    void this.d.mover.goto(goal, { timeoutTicks: 400, sprint }).then((r) => {
      if (this.active !== f || f.tg !== tg) return;
      if (!r.ok && r.reason === 'unreachable') {
        tg.gotoFails++;
        if (tg.gotoFails >= f.o.approachTries) this.endTarget(f, 'unreachable'); // Track AO: at once by default (was 3)
      } else if (r.ok) {
        tg.gotoFails = 0;
      }
    });
  }
}
