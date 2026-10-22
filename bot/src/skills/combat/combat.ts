// Melee combat skill (PLAN.md task 7.4, docs/pve.md). PvE ONLY: `attack` and `fight` refuse any
// player entity (type minecraft:player or an entity with a username), whatever the caller asks.
//
//   const combat = new CombatController({ loop, mover: skills, entities: () => world.entities, mobs,
//                                         inventory: world.inventory, hotbar, source: conn });
//   const r = await combat.fight(zombie.runtimeId);   // { ok: true, reason: 'killed', attacks, landed, ... }
//
// One fight at a time, driven from the InputLoop's before-step hook:
// - far (more than 3.5 blocks horizontally, or another level): the navigator walks a `near` goal of
//   radius 2.5 around the target, re-planned when the target moved more than 1.5 blocks (sprint when
//   more than 8 blocks away); the pitch follows the target meanwhile;
// - close: the navigator is cancelled and the controller steers itself: yaw (at most 40 degrees per
//   tick) and pitch towards the target's upper body, forward while farther than 2.2 blocks, back while
//   closer than 1.0;
// - strike when the eye is within 3.0 blocks of the target's box, the view is within 35 degrees and
//   10 ticks passed since the last strike (Bedrock has no attack cooldown, but a mob is invulnerable
//   for 10 ticks after a hit): `animate` swing + `inventory_transaction` item_use_on_entity attack;
// - creeper with a lit fuse (`ignited` flag) within 7 blocks: run straight away until 7 blocks, wait
//   until the fuse goes out, then resume; after each strike on a creeper back off for 8 ticks;
// - stop when the target dies (death_animation / health 0), disappears, stays farther than
//   `maxRange` for 100 ticks, or the fight times out.
//
// Packet shape verified on BDS 1.26.60.6 (docs/pve.md "Packets"): transaction_type
// 'item_use_on_entity', transaction_data { entity_runtime_id, action_type 'attack', hotbar_slot,
// hand 'main_hand', held_item (the wire item as the server sent it), player_pos (eye), click_pos 0 }.
import { silentLogger, type Logger } from '../../log.ts';
import type { ItemV4 } from '../../world/packets.ts';
import type { EntityInfo, ItemStack, Vec3 } from '../../world/types.ts';
import type { MoveCommand } from '../input/types.ts';
import { angleDiff, turnTowards, yawTowards } from '../nav/follower.ts';
import type { Goal } from '../nav/goals.ts';
import type { GotoOptions, SkillResult } from '../types.ts';
import { aimPoint, bareType, entityFeet, isPlayerEntity, reachDistance, type MobTracker } from './hostiles.ts';

export const EYE_HEIGHT = 1.62;

/** The InputLoop as the controller uses it. */
export interface CombatLoop {
  readonly state: { pos: Vec3; onGround: boolean; collidedHorizontally: boolean; ready: boolean };
  readonly command: Readonly<MoveCommand>;
  setCommand(c: Partial<MoveCommand>): void;
  release(): void;
  onBeforeStep(fn: (tick: bigint, state: { pos: Vec3; onGround: boolean; collidedHorizontally: boolean; ready: boolean }) => void): () => void;
}

/** BotSkills as the controller uses it (goto for the approach, cancel to take over steering). */
export interface CombatMover {
  goto(goal: Goal, opts?: GotoOptions): Promise<SkillResult>;
  cancel(): void;
  readonly nav: { readonly busy: boolean };
}

export interface CombatHotbar {
  select(slot: number): boolean;
  rawItem(slot: number): ItemV4 | undefined;
}

export interface CombatDeps {
  loop: CombatLoop;
  mover: CombatMover;
  entities: () => ReadonlyMap<bigint, EntityInfo>;
  mobs: MobTracker;
  inventory: { readonly slots: readonly (ItemStack | null)[]; readonly selected: number };
  /** Weapon switching and the held item of the attack packet; without it the bot hits with whatever it holds. */
  hotbar?: CombatHotbar;
  /** Where the attack packets go (the Connection). */
  source: { queue(name: string, params: Record<string, unknown>): void };
  /** Own runtime id (animate packet). */
  selfRuntimeId: () => bigint;
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
  | 'no_target';

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
  return 1;
}

/** The hotbar slot (0..8) with the best weapon; the selected slot wins ties. undefined = empty hotbar. */
export function bestWeaponSlot(slots: readonly (ItemStack | null)[], selected: number, toolOk: (item: ItemStack) => boolean = () => true): number | undefined {
  let best: number | undefined;
  let bestScore = 0;
  for (let i = 0; i < 9; i++) {
    const it = slots[i];
    if (!it || it.count <= 0 || !toolOk(it)) continue; // Track S: worn weapons skipped
    const s = weaponScore(it.name) + (i === selected ? 0.5 : 0);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  return best;
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

interface Fight {
  rid: bigint;
  type: string;
  creeper: boolean;
  o: Required<FightOptions>;
  t: number;
  lastStrike: number;
  attacks: number;
  landed: number;
  pending: { t: number; hurts: number }[];
  farTicks: number;
  gotoAt: Vec3 | undefined;
  gotoT: number;
  gotoFails: number;
  ourGoto: boolean;
  evading: boolean;
  calm: number;
  backoffUntil: number;
  wasIgnited: number;
  lastHealth: number | undefined;
  dead: boolean;
  damageTaken: number;
  weapon: string | null;
  resolve: (r: FightResult) => void;
}

/** Max yaw change per tick while fighting (degrees). */
const TURN = 40;
const MELEE_RANGE = 3.5;

export class CombatController {
  private readonly d: CombatDeps;
  private readonly log: Logger;
  private active: Fight | undefined;
  private readonly unsubs: (() => void)[] = [];
  /** Totals over all fights (metrics). */
  readonly totals = { fights: 0, kills: 0, attacks: 0, landed: 0 };
  /** Track S: weapon choice skips items failing this (worn weapons, skills/survival/tools.ts); default all ok. */
  toolOk: (item: ItemStack) => boolean = () => true;

  constructor(deps: CombatDeps & { toolOk?: (item: ItemStack) => boolean }) {
    if (deps.toolOk) this.toolOk = deps.toolOk; // Track S
    this.d = deps;
    this.log = deps.logger ?? silentLogger;
    this.unsubs.push(
      deps.loop.onBeforeStep((_tick, s) => {
        this.onTick(s);
      }),
      deps.mobs.onHit((_g, damage) => {
        if (this.active) this.active.damageTaken += damage;
      }),
    );
  }

  get busy(): boolean {
    return this.active !== undefined;
  }

  /** Runtime id and type of the current target. */
  get target(): { runtimeId: bigint; type: string } | undefined {
    return this.active ? { runtimeId: this.active.rid, type: this.active.type } : undefined;
  }

  dispose(): void {
    this.cancel();
    for (const u of this.unsubs.splice(0)) u();
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
    this.log.info(`combat: fighting ${bareType(e.type)} (runtime id ${rid}) with ${weapon ?? 'bare hands'}`);
    return new Promise((resolve) => {
      this.active = {
        rid,
        type: e.type,
        creeper: bareType(e.type) === 'creeper',
        o: {
          timeoutTicks: opts.timeoutTicks ?? 1200,
          maxRange: opts.maxRange ?? 32,
          outOfRangeTicks: opts.outOfRangeTicks ?? 100,
          cadence: opts.cadence ?? 10,
          reach: opts.reach ?? 3.0,
          approach: opts.approach ?? true,
          creeperSafe: opts.creeperSafe ?? 7,
        },
        t: 0,
        lastStrike: -Infinity,
        attacks: 0,
        landed: 0,
        pending: [],
        farTicks: 0,
        gotoAt: undefined,
        gotoT: -Infinity,
        gotoFails: 0,
        ourGoto: false,
        evading: false,
        calm: 0,
        backoffUntil: 0,
        wasIgnited: -Infinity,
        lastHealth: this.d.mobs.get(rid)?.health,
        dead: false,
        damageTaken: 0,
        weapon,
        resolve,
      };
    });
  }

  // ---- internals ---------------------------------------------------------------------------------

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
    this.settle(f, true);
    if (reason === 'killed') this.totals.kills++;
    const r: FightResult = {
      ok: reason === 'killed',
      reason,
      runtimeId: f.rid,
      type: f.type,
      ticks: f.t,
      attacks: f.attacks,
      landed: f.landed,
      damageTaken: +f.damageTaken.toFixed(2),
      weapon: f.weapon,
    };
    this.log.info(`combat: ${bareType(f.type)} ${reason} after ${f.t} ticks, ${f.attacks} attack(s), ${f.landed} landed, ${r.damageTaken} damage taken`);
    f.resolve(r);
  }

  /** Count strikes whose target showed a melee hurt animation since. */
  private settle(f: Fight, all = false): void {
    const ms = this.d.mobs.get(f.rid);
    const hurts = ms?.hurts ?? 0;
    f.pending = f.pending.filter((p) => {
      if (hurts > p.hurts && ms?.lastHurtData === 2) {
        f.landed++;
        this.totals.landed++;
        return false;
      }
      if (f.dead && (hurts > p.hurts || f.t - p.t <= 8)) {
        // the killing blow shows as death_animation, not as a hurt animation
        f.landed++;
        this.totals.landed++;
        return false;
      }
      return !all && f.t - p.t <= 8;
    });
  }

  private onTick(s: { pos: Vec3; onGround: boolean; collidedHorizontally: boolean; ready: boolean }): void {
    const f = this.active;
    if (!f || !s.ready) return;
    f.t++;
    const e = this.d.entities().get(f.rid);
    const ms = this.d.mobs.get(f.rid);
    if (ms) {
      if (ms.health !== undefined) f.lastHealth = ms.health;
      if (ms.dead) f.dead = true;
      if (ms.ignited) f.wasIgnited = f.t;
    }
    this.settle(f);
    if (!e) {
      this.finish(f, f.dead || (f.lastHealth !== undefined && f.lastHealth <= 0) ? 'killed' : f.creeper && f.t - f.wasIgnited <= 5 ? 'exploded' : 'gone');
      return;
    }
    if (isPlayerEntity(e)) {
      this.finish(f, 'refused_player');
      return;
    }
    if (f.dead) {
      this.finish(f, 'killed');
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

    if (hd > f.o.maxRange) {
      f.farTicks++;
      if (f.farTicks >= f.o.outOfRangeTicks) {
        this.finish(f, 'out_of_range');
        return;
      }
    } else {
      f.farTicks = 0;
    }

    // creeper with a lit fuse: get away, wait for the fuse to go out
    if (f.creeper && (ms?.ignited ?? false) && hd < f.o.creeperSafe) {
      f.evading = true;
      f.calm = 0;
      this.takeOver(f);
      const away = hd > 1e-3 ? yawTowards(-dx, -dz) : loop.command.yaw + 180;
      const yaw = turnTowards(loop.command.yaw, away, 90);
      loop.setCommand({ yaw, pitch: 0, forward: 1, strafe: 0, sprint: true, sneak: false, jump: s.collidedHorizontally && s.onGround });
      return;
    }
    if (f.evading) {
      // stand, face it, wait until the fuse has been out for 10 ticks
      if (!(ms?.ignited ?? false)) f.calm++;
      loop.setCommand({ yaw: turnTowards(loop.command.yaw, wantYaw, TURN), pitch: wantPitch, forward: 0, strafe: 0, sprint: false, jump: false });
      if (f.calm < 10) return;
      f.evading = false;
    }

    const melee = hd <= MELEE_RANGE && Math.abs(dy) < 1.2;
    let yaw: number;
    if (melee || !f.o.approach) {
      this.takeOver(f);
      yaw = turnTowards(loop.command.yaw, wantYaw, TURN);
      let forward = 0;
      if (f.o.approach) {
        if (f.creeper && f.t < f.backoffUntil) forward = -1;
        else if (hd > 2.2) forward = 1;
        else if (hd < 1.0) forward = -1;
      }
      loop.setCommand({ yaw, pitch: wantPitch, forward, strafe: 0, sprint: false, sneak: false, jump: forward > 0 && s.collidedHorizontally && s.onGround });
    } else {
      // approach with the navigator; it steers yaw, we steer the pitch
      const moved = f.gotoAt ? Math.hypot(feet.x - f.gotoAt.x, feet.z - f.gotoAt.z) : Infinity;
      if ((!this.d.mover.nav.busy || moved > 1.5) && f.t - f.gotoT >= 10) this.approach(f, feet, hd);
      loop.setCommand({ pitch: wantPitch });
      yaw = loop.command.yaw;
    }

    if (f.t - f.lastStrike >= f.o.cadence && Math.abs(angleDiff(yaw, wantYaw)) <= 35 && reachDistance(eye, e) <= f.o.reach) {
      f.lastStrike = f.t;
      f.attacks++;
      f.pending.push({ t: f.t, hurts: ms?.hurts ?? 0 });
      this.strike(f.rid, eye);
      if (f.creeper) f.backoffUntil = f.t + 8;
    }
  }

  /** Stop our approach goto (or anybody's) so the controller steers. */
  private takeOver(f: Fight): void {
    if (this.d.mover.nav.busy) this.d.mover.cancel();
    f.ourGoto = false;
  }

  private approach(f: Fight, feet: Vec3, hd: number): void {
    f.gotoAt = { ...feet };
    f.gotoT = f.t;
    f.ourGoto = true;
    const goal: Goal = { type: 'near', p: { x: feet.x, y: Math.round(feet.y), z: feet.z }, r: 2.5 };
    void this.d.mover.goto(goal, { timeoutTicks: 400, sprint: hd > 8 }).then((r) => {
      if (this.active !== f) return;
      if (!r.ok && r.reason === 'unreachable') {
        f.gotoFails++;
        if (f.gotoFails >= 3) this.finish(f, 'unreachable');
      } else if (r.ok) {
        f.gotoFails = 0;
      }
    });
  }
}
