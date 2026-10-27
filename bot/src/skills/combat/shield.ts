// Shield (wave 9, Track AH, docs/pve.md "Shield", decision 0029): a shield in the inventory goes to
// the offhand, and the combat skill raises it (sneaks) while an archer is about to shoot and the bot is
// not striking, and for 10 ticks after a creeper's fuse lights while backing off.
//
// Verified on BDS 1.26.60.6 (truth:stance / truth:blocklog, packs/truth/src/shield.ts):
// - offhand: with the inventory screen open (`interact open_inventory` -> container_open 'inventory')
//     item_stack_request { requests: [{ request_id, actions: [{ type_id: 'place', legacy_type_id: 1, count: 1,
//       source: { slot_type: { container_id: 'hotbar' | 'inventory' }, slot, stack_id },
//       destination: { slot_type: { container_id: 'offhand' }, slot: 1, stack_id: 0 } }],
//       custom_names: [], cause: 'chat_public' }] }
//   -> item_stack_response ok (containers hotbar slot count 0, offhand slot 1 count 1 with the stack id)
//      + inventory_content window 119 (offhand) [shield]. Without the screen: status 50 (refused).
// - raising it: the client only sneaks (player_auth_input sneak_down / sneaking / start_sneaking, what
//   MoveCommand.sneak sends). The server then stamps the offhand item's `blocking_tick` (inventory_content
//   119) and blocks attacks from the front: a zombie's hits did no damage and cost the shield 4
//   durability each, an arrow 5; a zombie hitting from behind still did 3. No other packet is needed.
// - the archer's draw is NOT visible to a client: a skeleton sends no flag or metadata while it draws
//   (only `target_eid` when it starts targeting), then `level_sound_event` 'bow' (entity_unique_id =
//   the skeleton) with the arrow's add_entity. On normal difficulty it shot every 61 ticks, the first
//   shot 62 ticks after `target_eid`. So the shot is predicted: from the last 'bow' sound (else from
//   when it started targeting us) every SHOT_PERIOD ticks, raised from SHOT_LEAD ticks before to
//   SHOT_TRAIL after; plus any arrow seen less than 20 ticks ago within 12 blocks flying at us.
import { silentLogger, type Logger } from '../../log.ts';
import type { EntityInfo, ItemStack, Vec3 } from '../../world/types.ts';
import type { HotbarMoveContainers } from '../container/hotbar-moves.ts';
import { bareType, entityFeet, isArcher, type MobTracker } from './hostiles.ts';

export const WINDOW_OFFHAND = 119;
/** Ticks between a skeleton's shots (normal difficulty, measured). */
export const SHOT_PERIOD = 61;
/** Raise the shield this many ticks before a predicted shot ... */
export const SHOT_LEAD = 14;
/** ... and keep it up this many after (the arrow flies 2 to 6 ticks over 10 blocks). */
export const SHOT_TRAIL = 8;
/** Archers farther than this are not watched. */
export const ARCHER_RANGE = 16;
/** After a creeper's fuse lights the shield is up this long while backing off. */
export const CREEPER_BLOCK_TICKS = 10;
/** A failed offhand move is not tried again for this long (ticks). */
const RETRY_TICKS = 600;

export interface ShieldInventory {
  readonly slots: readonly (ItemStack | null)[];
  window?(id: number): { slots: readonly (ItemStack | null)[] } | undefined;
  setItem?(window: number, slot: number, item: ItemStack | null): void;
}

export interface ShieldDeps {
  inventory: ShieldInventory;
  source: { queue(name: string, params: Record<string, unknown>): void; on?(name: string, fn: (p: Record<string, unknown>) => void): () => void };
  containers: () => Pick<HotbarMoveContainers, 'open' | 'onOpen' | 'onClose' | 'close'> | undefined;
  runtimeId: () => bigint;
  entities: () => ReadonlyMap<bigint, EntityInfo>;
  mobs: MobTracker;
  waitTicks: (n: number) => Promise<void>;
  logger?: Logger;
}

export interface ShieldEquipResult {
  ok: boolean;
  reason?: 'none' | 'occupied' | 'busy' | 'no_containers' | 'no_inventory_window' | 'refused' | 'timeout';
  status?: unknown;
}

/** An i64 as bedrock-protocol hands it over ([hi, lo], a bigint or a number). */
export function i64(v: unknown): bigint | undefined {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number') return BigInt.asIntN(64, (BigInt(v[0]) << 32n) | BigInt(v[1] >>> 0));
  return undefined;
}

/**
 * Is a shot due at tick `t` from an archer whose last shot (or the start of its targeting) was at
 * `base`? True from SHOT_LEAD before every predicted shot to SHOT_TRAIL after it.
 */
export function shotDue(t: number, base: number, shot: boolean): boolean {
  const since = t - base;
  if (since < 0) return false;
  if (shot && since <= SHOT_TRAIL) return true; // the arrow just left
  const phase = since % SHOT_PERIOD;
  return phase >= SHOT_PERIOD - SHOT_LEAD || (since >= SHOT_PERIOD && phase <= SHOT_TRAIL);
}

export class ShieldController {
  private readonly d: ShieldDeps;
  private readonly log: Logger;
  private t = 0;
  private running = false;
  private failedUntil = -Infinity;
  private nextRequest = -300001;
  private readonly pending = new Map<number, (r: { status: unknown; containers?: unknown }) => void>();
  /** Per archer runtime id: when it started targeting us; per unique id: its last shot. */
  private readonly targetSince = new Map<bigint, number>();
  private readonly lastShot = new Map<bigint, number>();
  /** Arrows by runtime id: the tick they were first seen. */
  private readonly arrows = new Map<bigint, number>();
  private readonly unsubs: (() => void)[] = [];
  readonly stats = { equips: 0, failed: 0, shotsHeard: 0, raisedTicks: 0 };

  constructor(deps: ShieldDeps) {
    this.d = deps;
    this.log = deps.logger ?? silentLogger;
    const on = deps.source.on?.bind(deps.source);
    if (on) {
      this.unsubs.push(
        on('level_sound_event', (p) => {
          const id = typeof p.sound_id === 'string' ? p.sound_id : '';
          if (!/bow|crossbow|shoot/.test(id) || id.includes('hit')) return;
          const uid = i64(p.entity_unique_id);
          if (uid === undefined) return;
          this.lastShot.set(uid, this.t);
          this.stats.shotsHeard++;
        }),
        on('item_stack_response', (p) => {
          for (const r of ((p as { responses?: { request_id: number; status: unknown }[] }).responses ?? [])) {
            const fn = this.pending.get(r.request_id);
            if (fn) {
              this.pending.delete(r.request_id);
              fn(r);
            }
          }
        }),
      );
    }
  }

  dispose(): void {
    for (const u of this.unsubs.splice(0)) u();
    this.pending.clear();
  }

  get busy(): boolean {
    return this.running;
  }

  /** A shield is in the offhand (the model of window 119). */
  equipped(): boolean {
    return this.d.inventory.window?.(WINDOW_OFFHAND)?.slots[0]?.name === 'shield';
  }

  /** The inventory slot (0..35) of a shield, if any. */
  shieldSlot(): number | undefined {
    const i = this.d.inventory.slots.findIndex((s, k) => k < 36 && s?.name === 'shield' && s.count > 0);
    return i >= 0 ? i : undefined;
  }

  /**
   * Every tick (the combat skill's before-step hook): watch archers and arrows; every 20 ticks, with
   * `idle` (no fight, no other screen), put a shield from the inventory into an empty offhand.
   */
  tick(me: Vec3 | undefined, idle: boolean): void {
    this.t++;
    const ents = this.d.entities();
    for (const e of ents.values()) {
      if (bareType(e.type) === 'arrow' && !this.arrows.has(e.runtimeId)) this.arrows.set(e.runtimeId, this.t);
      if (!isArcher(e, this.d.mobs)) continue;
      if (this.d.mobs.targetsUs(e.runtimeId)) {
        if (!this.targetSince.has(e.runtimeId)) this.targetSince.set(e.runtimeId, this.t);
      } else {
        this.targetSince.delete(e.runtimeId);
      }
    }
    if (this.t % 100 === 0) {
      for (const k of [...this.targetSince.keys()]) if (!ents.has(k)) this.targetSince.delete(k);
      for (const k of [...this.arrows.keys()]) if (!ents.has(k)) this.arrows.delete(k);
      for (const [k, at] of [...this.lastShot]) if (this.t - at > 1200) this.lastShot.delete(k);
    }
    if (this.t % 20 === 0 && idle && me && !this.running && this.t >= this.failedUntil && !this.equipped() && this.shieldSlot() !== undefined) {
      const off = this.d.inventory.window?.(WINDOW_OFFHAND)?.slots[0];
      if (!off) void this.equip();
    }
  }

  /**
   * The archer about to shoot at us (within 16 blocks, targeting us or heard shooting in the last
   * minute, a shot due: `shotDue`), or the shooter side of an arrow flying at us; undefined = none.
   */
  threat(me: Vec3): { from: Vec3; why: 'shot_due' | 'arrow'; e?: EntityInfo } | undefined {
    const ents = this.d.entities();
    for (const e of ents.values()) {
      if (!isArcher(e, this.d.mobs) || this.d.mobs.get(e.runtimeId)?.dead) continue;
      const f = entityFeet(e);
      if (Math.hypot(f.x - me.x, f.y - me.y, f.z - me.z) > ARCHER_RANGE) continue;
      const shot = this.lastShot.get(e.uniqueId);
      const since = this.targetSince.get(e.runtimeId);
      const base = shot ?? since;
      if (base === undefined) continue;
      if (shotDue(this.t, base, shot !== undefined)) return { from: f, why: 'shot_due', e };
    }
    for (const [rid, seen] of this.arrows) {
      if (this.t - seen > 20) continue;
      const a = ents.get(rid);
      if (!a) continue;
      const v = a.vel;
      const sp = Math.hypot(v.x, v.y, v.z);
      const dx = me.x - a.pos.x;
      const dy = me.y + 1 - a.pos.y;
      const dz = me.z - a.pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > 12 || sp < 0.3) continue;
      if ((v.x * dx + v.y * dy + v.z * dz) / (sp * Math.max(d, 1e-3)) > 0.8) return { from: { x: a.pos.x, y: a.pos.y, z: a.pos.z }, why: 'arrow' };
    }
    return undefined;
  }

  /** Count a tick with the shield up (stats). */
  noteRaised(): void {
    this.stats.raisedTicks++;
  }

  /** Move the inventory's shield into the empty offhand (inventory screen open for the request). */
  async equip(): Promise<ShieldEquipResult> {
    if (this.running) return { ok: false, reason: 'busy' };
    const slot = this.shieldSlot();
    if (slot === undefined) return { ok: false, reason: 'none' };
    if (this.d.inventory.window?.(WINDOW_OFFHAND)?.slots[0]) return { ok: false, reason: 'occupied' };
    const c = this.d.containers();
    if (!c) return { ok: false, reason: 'no_containers' };
    if (c.open) return { ok: false, reason: 'busy' };
    this.running = true;
    try {
      const r = await this.withScreen(c, async (): Promise<ShieldEquipResult> => {
        const item = this.d.inventory.slots[slot];
        if (item?.name !== 'shield') return { ok: false, reason: 'none' };
        const id = this.nextRequest;
        this.nextRequest -= 2;
        const box: { got?: { status: unknown } } = {};
        this.pending.set(id, (x) => {
          box.got = x;
        });
        this.d.source.queue('item_stack_request', {
          requests: [
            {
              request_id: id,
              actions: [
                {
                  type_id: 'place',
                  legacy_type_id: 1,
                  count: 1,
                  source: { slot_type: { container_id: slot < 9 ? 'hotbar' : 'inventory' }, slot, stack_id: item.stackId ?? 0 },
                  destination: { slot_type: { container_id: 'offhand' }, slot: 1, stack_id: 0 },
                },
              ],
              custom_names: [],
              cause: 'chat_public',
            },
          ],
        });
        for (let i = 0; i < 40 && !box.got; i++) await this.d.waitTicks(1);
        this.pending.delete(id);
        const got = box.got;
        if (!got) return { ok: false, reason: 'timeout' };
        if (got.status !== 'ok' && got.status !== 0) return { ok: false, reason: 'refused', status: got.status };
        // the server also sends inventory_content 119; keep the model right meanwhile
        this.d.inventory.setItem?.(WINDOW_OFFHAND, 0, { ...item, count: 1 });
        if (this.d.inventory.slots[slot]?.name === 'shield') this.d.inventory.setItem?.(0, slot, item.count > 1 ? { ...item, count: item.count - 1 } : null);
        return { ok: true };
      });
      if (r.ok) {
        this.stats.equips++;
        this.log.info(`shield: moved from slot ${slot} to the offhand`);
      } else {
        this.stats.failed++;
        this.failedUntil = this.t + RETRY_TICKS;
        this.log.warn(`shield: offhand move failed (${r.reason}${r.status !== undefined ? ` ${JSON.stringify(r.status)}` : ''})`);
      }
      return r;
    } finally {
      this.running = false;
    }
  }

  private async withScreen(c: Pick<HotbarMoveContainers, 'open' | 'onOpen' | 'onClose' | 'close'>, fn: () => Promise<ShieldEquipResult>): Promise<ShieldEquipResult> {
    let opened: { id: number; type: string } | undefined;
    const offOpen = c.onOpen((o) => {
      if (o.type === 'inventory') opened = o;
    });
    this.d.source.queue('interact', { action_id: 'open_inventory', target_entity_id: this.d.runtimeId(), has_position: false });
    for (let i = 0; i < 20 && !opened; i++) await this.d.waitTicks(1);
    offOpen();
    if (!opened) return { ok: false, reason: 'no_inventory_window' };
    try {
      return await fn();
    } finally {
      const id = opened.id;
      let closed = false;
      const offClose = c.onClose((cid) => {
        if (cid === id) closed = true;
      });
      c.close(id, 'inventory');
      for (let i = 0; i < 20 && !closed; i++) await this.d.waitTicks(1);
      offClose();
    }
  }
}
