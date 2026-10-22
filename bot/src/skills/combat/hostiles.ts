// Entity knowledge for PvE (PLAN.md task 7.4, docs/pve.md): classify `entity_type` into hostile /
// neutral / passive / player / item, and track per-mob state the world model does not keep: health
// (`add_entity.attributes`, `update_attributes`), the creeper fuse (`set_entity_data` flag `ignited`),
// the mob's target (`set_entity_data` `target_eid` = the target's UNIQUE id), hurt and death
// animations (`entity_event`). From the bot's own health drops it keeps a `lastHitBy` guess.
//
// Verified on BDS 1.26.60.6 (docs/pve.md "Packets"): a zombie's health arrives in `update_attributes`
// (`minecraft:health`, current) after every hit; `entity_event hurt_animation` carries data 2 for a
// melee hit and 7 for fire; `target_eid` is set when the mob starts chasing a player.
import type { EntityInfo, Vec3 } from '../../world/types.ts';
import { angleDiff, yawTowards } from '../nav/follower.ts';

export type EntityClass = 'hostile' | 'neutral' | 'passive' | 'player' | 'item' | 'other';

/** Always attacked by guard mode. Bedrock ids without the namespace. */
export const HOSTILE_TYPES: ReadonlySet<string> = new Set([
  'zombie',
  'husk',
  'drowned',
  'zombie_villager',
  'zombie_villager_v2',
  'skeleton',
  'stray',
  'bogged',
  'parched',
  'wither_skeleton',
  'creeper',
  'spider',
  'cave_spider',
  'witch',
  'pillager',
  'vindicator',
  'evoker',
  'illusioner',
  'ravager',
  'vex',
  'slime',
  'magma_cube',
  'phantom',
  'blaze',
  'ghast',
  'guardian',
  'elder_guardian',
  'silverfish',
  'endermite',
  'shulker',
  'hoglin',
  'zoglin',
  'piglin_brute',
  'breeze',
  'creaking',
  'warden',
]);

/** Attacked only when they hit (or target) the bot, or by an explicit `!kill <type>`. */
export const NEUTRAL_TYPES: ReadonlySet<string> = new Set([
  'enderman',
  'piglin',
  'zombie_pigman', // Bedrock's id of the zombified piglin
  'zombified_piglin',
  'wolf',
  'bee',
  'iron_golem',
  'llama',
  'trader_llama',
  'panda',
  'polar_bear',
  'goat',
  'dolphin',
  'spider_jockey',
]);

/** Non-living or pick-up entities; never a target. */
export const ITEM_TYPES: ReadonlySet<string> = new Set([
  'item',
  'xp_orb',
  'arrow',
  'thrown_trident',
  'snowball',
  'egg',
  'ender_pearl',
  'fireball',
  'small_fireball',
  'wind_charge_projectile',
  'breeze_wind_charge_projectile',
  'splash_potion',
  'lingering_potion',
  'xp_bottle',
  'fishing_hook',
  'tnt',
  'falling_block',
  'armor_stand',
  'painting',
  'leash_knot',
  'boat',
  'chest_boat',
  'minecart',
  'chest_minecart',
  'hopper_minecart',
  'tnt_minecart',
  'command_block_minecart',
  'ender_crystal',
  'lightning_bolt',
  'area_effect_cloud',
  'evocation_fang',
  'shulker_bullet',
  'wither_skull',
  'wither_skull_dangerous',
  'llama_spit',
  'dragon_fireball',
  'eye_of_ender_signal',
  'fireworks_rocket',
  'agent',
  'npc',
  'tripod_camera',
]);

/** Mobs that attack from a distance (the bot is hurt while they are far away). */
export const RANGED_TYPES: ReadonlySet<string> = new Set(['skeleton', 'stray', 'bogged', 'parched', 'pillager', 'witch', 'blaze', 'ghast', 'breeze', 'drowned', 'shulker']);

/** Common names people type for Bedrock ids (`!kill zombified_piglin`). */
const ALIASES: Readonly<Record<string, string>> = {
  zombified_piglin: 'zombie_pigman',
  zombie_piglin: 'zombie_pigman',
  zombievillager: 'zombie_villager',
};

/** `minecraft:zombie` / `Zombie` / `zombie` -> `zombie`. */
export function bareType(type: string): string {
  const t = type.trim().toLowerCase();
  return t.startsWith('minecraft:') ? t.slice('minecraft:'.length) : t;
}

/** What a typed name means as a Bedrock id (aliases resolved), without the namespace. */
export function normalizeTypeName(name: string): string {
  const t = bareType(name).replace(/\s+/g, '_');
  return ALIASES[t] ?? t;
}

/** True when `entityType` is what a typed name means (`zombie_villager` matches `zombie_villager_v2`). */
export function typeMatches(entityType: string, typed: string): boolean {
  const a = bareType(entityType);
  const b = normalizeTypeName(typed);
  return a === b || a === `${b}_v2` || (b.endsWith('_v2') && a === b.slice(0, -3));
}

export function classify(type: string): EntityClass {
  const t = bareType(type);
  if (t === 'player') return 'player';
  if (HOSTILE_TYPES.has(t)) return 'hostile';
  if (NEUTRAL_TYPES.has(t)) return 'neutral';
  if (ITEM_TYPES.has(t) || t.endsWith('_minecart') || t.endsWith('_boat')) return 'item';
  if (PASSIVE_TYPES.has(t)) return 'passive';
  return 'other';
}

export const PASSIVE_TYPES: ReadonlySet<string> = new Set([
  'pig',
  'cow',
  'sheep',
  'chicken',
  'rabbit',
  'horse',
  'donkey',
  'mule',
  'skeleton_horse',
  'zombie_horse',
  'cat',
  'ocelot',
  'parrot',
  'fox',
  'villager',
  'villager_v2',
  'wandering_trader',
  'mooshroom',
  'squid',
  'glow_squid',
  'cod',
  'salmon',
  'tropicalfish',
  'pufferfish',
  'turtle',
  'bat',
  'snow_golem',
  'strider',
  'axolotl',
  'frog',
  'tadpole',
  'allay',
  'camel',
  'sniffer',
  'armadillo',
  'happy_ghast',
  'copper_golem',
  'nautilus',
]);

/** A player entity (by type or because it carries a username). Never a target, under any command. */
export function isPlayerEntity(e: Pick<EntityInfo, 'type' | 'username'>): boolean {
  return classify(e.type) === 'player' || e.username !== undefined;
}

/** Feet position of a tracked entity: players are sent at eye height (feet + 1.62), mobs at the feet. */
export function entityFeet(e: Pick<EntityInfo, 'type' | 'pos' | 'username'>): Vec3 {
  return isPlayerEntity(e) ? { x: e.pos.x, y: e.pos.y - 1.62, z: e.pos.z } : { ...e.pos };
}

/** Approximate collision box (width, height) by type; vanilla values, default 0.6 x 1.8. */
export function entitySize(type: string): { w: number; h: number } {
  switch (bareType(type)) {
    case 'zombie':
    case 'husk':
    case 'drowned':
    case 'zombie_villager':
    case 'zombie_villager_v2':
    case 'zombie_pigman':
    case 'piglin':
    case 'piglin_brute':
      return { w: 0.6, h: 1.9 };
    case 'skeleton':
    case 'stray':
    case 'bogged':
    case 'parched':
      return { w: 0.6, h: 1.99 };
    case 'wither_skeleton':
      return { w: 0.72, h: 2.5 };
    case 'creeper':
      return { w: 0.6, h: 1.7 };
    case 'spider':
      return { w: 1.4, h: 0.9 };
    case 'cave_spider':
      return { w: 0.7, h: 0.5 };
    case 'enderman':
      return { w: 0.6, h: 2.9 };
    case 'witch':
    case 'pillager':
    case 'vindicator':
    case 'evoker':
      return { w: 0.6, h: 1.95 };
    case 'slime':
    case 'magma_cube':
      return { w: 1.0, h: 1.0 };
    case 'phantom':
      return { w: 0.9, h: 0.5 };
    case 'pig':
      return { w: 0.9, h: 0.9 };
    case 'cow':
    case 'mooshroom':
      return { w: 0.9, h: 1.3 };
    case 'sheep':
      return { w: 0.9, h: 1.3 };
    case 'chicken':
      return { w: 0.6, h: 0.8 };
    case 'iron_golem':
      return { w: 1.4, h: 2.9 };
    case 'silverfish':
    case 'endermite':
      return { w: 0.4, h: 0.3 };
    default:
      return { w: 0.6, h: 1.8 };
  }
}

/** Point the bot aims at: the middle of the upper half of the target's box. */
export function aimPoint(e: Pick<EntityInfo, 'type' | 'pos' | 'username'>): Vec3 {
  const f = entityFeet(e);
  return { x: f.x, y: f.y + entitySize(e.type).h * 0.7, z: f.z };
}

/** Distance from `eye` to the nearest point of the entity's box (vanilla reach is measured like this). */
export function reachDistance(eye: Vec3, e: Pick<EntityInfo, 'type' | 'pos' | 'username'>): number {
  const f = entityFeet(e);
  const { w, h } = entitySize(e.type);
  const half = w / 2;
  const cx = clamp(eye.x, f.x - half, f.x + half);
  const cy = clamp(eye.y, f.y, f.y + h);
  const cz = clamp(eye.z, f.z - half, f.z + half);
  return Math.hypot(eye.x - cx, eye.y - cy, eye.z - cz);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---- per-mob state from packets --------------------------------------------------------------

export interface MobState {
  runtimeId: bigint;
  health: number | undefined;
  maxHealth: number | undefined;
  /** Creeper fuse lit (`ignited` actor flag). */
  ignited: boolean;
  /** Unique id of the entity this mob targets (`target_eid`); 0 / undefined = none. */
  targetUid: bigint | undefined;
  /** Monotonic ms (now()) of the last hurt animation, and its data (2 = melee hit, 7 = fire). */
  lastHurtAt: number | undefined;
  lastHurtData: number | undefined;
  hurts: number;
  /** death_animation seen, or health 0. */
  dead: boolean;
}

export interface HitGuess {
  runtimeId: bigint;
  type: string;
  /** now() of the health drop. */
  at: number;
  /** How it was picked: the mob targets us, faces us within 4 blocks, or is a ranged mob in range. */
  why: 'target' | 'facing' | 'ranged' | 'nearest';
  damage: number;
}

/** What the tracker subscribes to (`Connection` satisfies it). */
export interface MobPacketSource {
  on(name: string, fn: (p: Record<string, unknown>) => void): () => void;
}

export interface MobTrackerOptions {
  /** The tracked entities (World.entities). */
  entities: () => ReadonlyMap<bigint, EntityInfo>;
  /** Own runtime id (World.self.runtimeId). */
  selfRuntimeId: () => bigint;
  /** Own feet position, for the attacker guess. */
  selfPos: () => Vec3 | undefined;
  now?: () => number;
}

interface AttrLike {
  name: string;
  current?: number;
  value?: number;
  max?: number;
}

interface MetaLike {
  key: string;
  value: unknown;
}

const toBig = (v: unknown): bigint => (typeof v === 'bigint' ? v : BigInt(v as number | string));

/**
 * Per-mob state the world model does not keep, plus the bot's own damage and a `lastHitBy` guess:
 * when the bot's health drops, the attacker is (1) the nearest mob within 6 blocks whose
 * `target_eid` is the bot, else (2) the nearest hostile within 4 blocks facing the bot (yaw within
 * 60 degrees), else (3) the nearest ranged hostile within 20 blocks, else (4) the nearest hostile
 * within 4 blocks.
 */
export class MobTracker {
  readonly mobs = new Map<bigint, MobState>();
  /** The bot's own unique id (start_game.entity_id); mobs name it in `target_eid`. */
  selfUniqueId: bigint | undefined;
  /** Own health from set_health / update_attributes. */
  selfHealth: number | undefined;
  lastHitBy: HitGuess | undefined;
  /** now() of the last own health drop. */
  lastDamageAt: number | undefined;
  private readonly o: MobTrackerOptions;
  private readonly now: () => number;
  private readonly unsubs: (() => void)[] = [];
  private readonly hitFns = new Set<(h: HitGuess | undefined, damage: number) => void>();

  constructor(source: MobPacketSource, opts: MobTrackerOptions) {
    this.o = opts;
    this.now = opts.now ?? (() => performance.now());
    this.unsubs.push(
      source.on('start_game', (p) => {
        this.mobs.clear();
        if (p.entity_id !== undefined) this.selfUniqueId = toBig(p.entity_id);
      }),
      source.on('add_entity', (p) => {
        const rid = toBig(p.runtime_id);
        const st = this.fresh(rid);
        for (const a of (p.attributes ?? []) as AttrLike[]) this.attr(st, a);
        this.meta(st, (p.metadata ?? []) as MetaLike[]);
      }),
      source.on('update_attributes', (p) => {
        const rid = toBig(p.runtime_entity_id);
        if (rid === this.o.selfRuntimeId()) {
          for (const a of (p.attributes ?? []) as AttrLike[]) if (a.name === 'minecraft:health') this.ownHealth(a.current ?? a.value);
          return;
        }
        const st = this.state(rid);
        for (const a of (p.attributes ?? []) as AttrLike[]) this.attr(st, a);
      }),
      source.on('set_health', (p) => {
        this.ownHealth(p.health as number | undefined);
      }),
      source.on('set_entity_data', (p) => {
        const rid = toBig(p.runtime_entity_id);
        if (rid === this.o.selfRuntimeId()) return;
        this.meta(this.state(rid), (p.metadata ?? []) as MetaLike[]);
      }),
      source.on('entity_event', (p) => {
        const rid = toBig(p.runtime_entity_id);
        if (rid === this.o.selfRuntimeId()) return;
        const st = this.state(rid);
        if (p.event_id === 'hurt_animation') {
          st.lastHurtAt = this.now();
          st.lastHurtData = typeof p.data === 'number' ? p.data : undefined;
          st.hurts++;
        } else if (p.event_id === 'death_animation') {
          st.dead = true;
        }
      }),
      source.on('remove_entity', () => {
        this.prune();
      }),
      source.on('respawn', (p) => {
        if (p.state === 1) this.selfHealth = undefined;
      }),
    );
  }

  dispose(): void {
    for (const u of this.unsubs.splice(0)) u();
  }

  /** Called with the guess (or undefined) on every own health drop. */
  onHit(fn: (h: HitGuess | undefined, damage: number) => void): () => void {
    this.hitFns.add(fn);
    return () => {
      this.hitFns.delete(fn);
    };
  }

  get(rid: bigint): MobState | undefined {
    return this.mobs.get(rid);
  }

  /** The mob targets the bot (`target_eid` = our unique id). */
  targetsUs(rid: bigint): boolean {
    const t = this.mobs.get(rid)?.targetUid;
    return t !== undefined && this.selfUniqueId !== undefined && t === this.selfUniqueId;
  }

  /** Forget mobs no longer tracked by the world model. */
  prune(): void {
    const ents = this.o.entities();
    for (const rid of [...this.mobs.keys()]) if (!ents.has(rid)) this.mobs.delete(rid);
  }

  /**
   * Who probably hit the bot just now (see the class comment); undefined when no candidate.
   * Exposed for unit tests; `onHit` listeners get it on every own health drop.
   */
  guessAttacker(damage = 0): HitGuess | undefined {
    const me = this.o.selfPos();
    if (!me) return undefined;
    const at = this.now();
    let best: { e: EntityInfo; d: number; why: HitGuess['why']; rank: number } | undefined;
    for (const e of this.o.entities().values()) {
      const cls = classify(e.type);
      if (cls === 'player' || cls === 'item' || cls === 'passive') continue;
      const f = entityFeet(e);
      const d = Math.hypot(f.x - me.x, f.y - me.y, f.z - me.z);
      let why: HitGuess['why'] | undefined;
      let rank = 9;
      if (d <= 6 && this.targetsUs(e.runtimeId)) {
        why = 'target';
        rank = 0;
      } else if (cls === 'hostile' && d <= 4 && facing(e, me)) {
        why = 'facing';
        rank = 1;
      } else if (cls === 'hostile' && d <= 20 && RANGED_TYPES.has(bareType(e.type))) {
        why = 'ranged';
        rank = 2;
      } else if (cls === 'hostile' && d <= 4) {
        why = 'nearest';
        rank = 3;
      }
      if (!why) continue;
      if (!best || rank < best.rank || (rank === best.rank && d < best.d)) best = { e, d, why, rank };
    }
    return best ? { runtimeId: best.e.runtimeId, type: best.e.type, at, why: best.why, damage } : undefined;
  }

  private ownHealth(h: number | undefined): void {
    if (h === undefined || !Number.isFinite(h)) return;
    const prev = this.selfHealth;
    this.selfHealth = h;
    if (prev !== undefined && h < prev && h > 0) {
      const damage = prev - h;
      this.lastDamageAt = this.now();
      const guess = this.guessAttacker(damage);
      if (guess) this.lastHitBy = guess;
      for (const fn of [...this.hitFns]) fn(guess, damage);
    }
  }

  private fresh(rid: bigint): MobState {
    const st: MobState = { runtimeId: rid, health: undefined, maxHealth: undefined, ignited: false, targetUid: undefined, lastHurtAt: undefined, lastHurtData: undefined, hurts: 0, dead: false };
    this.mobs.set(rid, st);
    return st;
  }

  private state(rid: bigint): MobState {
    return this.mobs.get(rid) ?? this.fresh(rid);
  }

  private attr(st: MobState, a: AttrLike): void {
    if (a.name !== 'minecraft:health') return;
    const v = a.current ?? a.value;
    if (typeof v === 'number') {
      st.health = v;
      if (v <= 0) st.dead = true;
    }
    if (typeof a.max === 'number') st.maxHealth = a.max;
  }

  private meta(st: MobState, list: MetaLike[]): void {
    for (const m of list) {
      if (m.key === 'flags' && m.value && typeof m.value === 'object') {
        st.ignited = (m.value as { ignited?: boolean }).ignited === true;
      } else if (m.key === 'target_eid') {
        const t = toBig(m.value);
        st.targetUid = t === 0n || t === -1n ? undefined : t;
      }
    }
  }
}

/** The entity looks at `p` within 60 degrees (head yaw if sent, else body yaw). */
export function facing(e: Pick<EntityInfo, 'pos' | 'yaw' | 'headYaw'>, p: Vec3, maxDeg = 60): boolean {
  const dx = p.x - e.pos.x;
  const dz = p.z - e.pos.z;
  if (Math.hypot(dx, dz) < 0.3) return true;
  const want = yawTowards(dx, dz);
  return Math.abs(angleDiff(e.headYaw, want)) <= maxDeg || Math.abs(angleDiff(e.yaw, want)) <= maxDeg;
}
