// Sleeping in a bed (wave 7, Track W; docs/survival.md "Sleep"). Verified on BDS 1.26.60.6 with the
// truth pack (`truth:bed`, `truth:sleeping` = Player.isSleeping):
//
//   click   inventory_transaction item_use / click_block on either half of the bed (the chest / door
//           click of docs/interaction.md, whatever the hand holds)
//   always  set_spawn_position { spawn_type: 'player', world_position: the bed's head } and the text
//           `tile.bed.respawnSet` (the respawn point moves to the bed even when sleeping is refused)
//   asleep  level_event_generic 19602 { ableToSleep, overworldPlayerCount, sleepingPlayerCount },
//           own set_entity_data { player_flags: 2 (bit 1 = sleeping), player_bed_position: the head
//           block }, update_block of the head (occupied_bit), the body at the head block's centre,
//           0.70625 above its floor (the eye 0.2 higher: feet + 0.90625 is what the server expects)
//   refused text (json rawtext translate) `tile.bed.noSleep` (time of day outside [12542, 23459)),
//           `tile.bed.notSafe` (monsters near), `tile.bed.obstructed` (no room around the bed),
//           `tile.bed.tooFar` (more than about 3 blocks away), `tile.bed.occupied`; nothing else changes
//   wake    the server wakes the player itself: animate wake_up, set_entity_data player_flags 0, the
//           head's occupied_bit cleared, a correction to a cell next to the bed. That happens when
//           every player in the overworld has slept 100 ticks (the night is skipped: time of day -> 0
//           with the daylight cycle on), or when the time is set to morning. To get up earlier the client
//           sends player_action { action: 'stop_sleeping' } (the same answer follows within 2 ticks).
//
// While asleep the movement model does not know the sleeping pose: the input loop would report its
// own body (1 correction per 16 ticks, measured: 37 in 30 s). The controller therefore holds the
// reported position at the server's (InputLoop.setTickExtras, one provider at a time: nothing digs in
// bed): 0 corrections while asleep.
import { silentLogger, type Logger } from '../../log.ts';
import type { ItemV4 } from '../../world/packets.ts';
import type { BlockInfo, ItemStack, Vec3 } from '../../world/types.ts';
import { clickBlockTransaction } from '../container/chest.ts';
import { blockCenter, EYE_HEIGHT, faceToward, lookAngles } from '../dig/look.ts';
import { wireItemOf } from '../place/place.ts';

/** Sleeping is allowed from this time of day ... */
export const SLEEP_FROM = 12542;
/** ... until (exclusive) this one. Measured: 12400 refused, 12550 slept, 23400 slept, 23500 refused. */
export const SLEEP_UNTIL = 23459;
/** Body height above the bed block's y while asleep: the eye position the server expects (y + 0.90625). */
export const SLEEP_EYE_ABOVE = 0.90625;
/** player_flags bit for sleeping. */
const SLEEPING_BIT = 2;

export function inSleepWindow(timeOfDay: number | undefined): boolean {
  if (timeOfDay === undefined) return false;
  const t = ((Math.floor(timeOfDay) % 24000) + 24000) % 24000;
  return t >= SLEEP_FROM && t < SLEEP_UNTIL;
}

export type SleepReason = 'not_night' | 'monsters' | 'obstructed' | 'too_far' | 'occupied' | 'not_a_bed' | 'unloaded' | 'timeout' | 'not_ready' | 'busy' | 'interrupted';

/** `tile.bed.<key>` refusal texts -> reasons (respawnSet is information, not a refusal). */
export const BED_TEXTS: Readonly<Record<string, SleepReason>> = {
  noSleep: 'not_night',
  notSafe: 'monsters',
  obstructed: 'obstructed',
  tooFar: 'too_far',
  occupied: 'occupied',
};

/** The `tile.bed.*` key of a text packet's message (json rawtext or plain), if any. */
export function bedTextKey(message: string): string | undefined {
  const m = /tile\.bed\.([A-Za-z]+)/.exec(message);
  return m?.[1];
}

export function isBed(b: BlockInfo | undefined): boolean {
  return b !== undefined && (b.name === 'bed' || b.name.endsWith('_bed'));
}

/** Head block of a bed half (`direction` 0 south +z, 1 west -x, 2 north -z, 3 east +x; the head lies that way from the foot). */
export function bedHead(p: Vec3, b: BlockInfo): Vec3 {
  if (b.states.head_piece_bit === 1 || b.states.head_piece_bit === true) return { ...p };
  const d = Number(b.states.direction ?? 0) & 3;
  const off = [
    { x: 0, z: 1 },
    { x: -1, z: 0 },
    { x: 0, z: -1 },
    { x: 1, z: 0 },
  ][d]!;
  return { x: p.x + off.x, y: p.y, z: p.z + off.z };
}

export interface BedWorld {
  blockAt(p: Vec3): BlockInfo | undefined;
}

/** Bed blocks within `r` (horizontal) and `dy` (vertical) of `centre`, nearest first (one per bed: the head). */
export function findBeds(world: BedWorld, centre: Vec3, r = 8, dy = 3): Vec3[] {
  const cx = Math.floor(centre.x);
  const cy = Math.floor(centre.y);
  const cz = Math.floor(centre.z);
  const seen = new Set<string>();
  const out: { p: Vec3; d: number }[] = [];
  for (let x = cx - r; x <= cx + r; x++) {
    for (let z = cz - r; z <= cz + r; z++) {
      if (Math.hypot(x - cx, z - cz) > r + 0.5) continue;
      for (let y = cy - dy; y <= cy + dy; y++) {
        const p = { x, y, z };
        const b = world.blockAt(p);
        if (!isBed(b)) continue;
        const h = bedHead(p, b!);
        const k = `${h.x},${h.y},${h.z}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ p: h, d: Math.hypot(h.x + 0.5 - centre.x, h.y - centre.y, h.z + 0.5 - centre.z) });
      }
    }
  }
  return out.sort((a, b) => a.d - b.d).map((o) => o.p);
}

export interface SleepResult {
  ok: boolean;
  reason?: SleepReason | (string & {});
  /** The `tile.bed.*` text that came back, if any. */
  text?: string;
  /** Ticks from the click to the answer. */
  ticks?: number;
  bed?: Vec3;
}

export interface SleepLoop {
  readonly state: { pos: Vec3; ready: boolean };
  setCommand(c: { yaw?: number; pitch?: number }): void;
  waitTicks(n: number): Promise<void>;
  setTickExtras?(fn: ((tick: bigint) => Record<string, unknown> | undefined) | undefined): void;
}

export interface SleepWorld extends BedWorld {
  readonly chunks: { runtimeIdAt(x: number, y: number, z: number): number | undefined };
  readonly inventory: { readonly slots: readonly (ItemStack | null)[]; readonly selected: number; rawItem(window: number, slot: number): ItemV4 | undefined };
}

export interface SleepDeps {
  source: { on(name: string, fn: (p: Record<string, unknown>) => void): () => void; queue(name: string, params: Record<string, unknown>): void };
  loop: SleepLoop;
  world: SleepWorld;
  selfRuntimeId: () => bigint;
  rawHotbarItem?: (slot: number) => ItemV4 | undefined;
  logger?: Logger;
}

export type SleepEvent = { kind: 'asleep'; bed: Vec3 | undefined } | { kind: 'awake'; ms: number } | { kind: 'refused'; reason: string; text: string };

const toBig = (v: unknown): bigint => {
  try {
    return BigInt(v as bigint | number | string);
  } catch {
    return -1n;
  }
};

/**
 * Clicks beds and tracks the own sleeping state (player_flags) and the server's refusal texts. One
 * per connection; `dispose()` unsubscribes.
 */
export class SleepController {
  private readonly d: SleepDeps;
  private readonly log: Logger;
  private readonly unsubs: (() => void)[] = [];
  private readonly listeners = new Set<(e: SleepEvent) => void>();
  private asleep = false;
  private since = 0;
  private bedPos: Vec3 | undefined;
  private hold: Vec3 | undefined;
  private holding = false;
  private running = false;
  private cancelled = false;
  /** Last refusal text key and when (performance.now()). */
  lastText: { key: string; at: number } | undefined;
  readonly stats = { clicks: 0, slept: 0, refused: 0, woke: 0 };

  constructor(deps: SleepDeps) {
    this.d = deps;
    this.log = deps.logger ?? silentLogger;
    const s = deps.source;
    this.unsubs.push(
      s.on('set_entity_data', (p) => {
        if (toBig(p.runtime_entity_id) !== deps.selfRuntimeId()) return;
        let flags: number | undefined;
        let bed: Vec3 | undefined;
        for (const m of (p.metadata ?? []) as { key: string; value: unknown }[]) {
          if (m.key === 'player_flags' && typeof m.value === 'number') flags = m.value;
          else if (m.key === 'player_bed_position' && m.value && typeof m.value === 'object') {
            const v = m.value as Vec3;
            bed = { x: v.x, y: v.y, z: v.z };
          }
        }
        if (bed) this.bedPos = bed;
        if (flags !== undefined) this.setAsleep((flags & SLEEPING_BIT) !== 0);
      }),
      s.on('correct_player_move_prediction', (p) => {
        if (!this.asleep || p.prediction_type !== 'player') return;
        const v = p.position as Vec3 | undefined;
        if (v) this.hold = { x: v.x, y: v.y, z: v.z };
      }),
      s.on('text', (p) => {
        const key = bedTextKey(typeof p.message === 'string' ? p.message : '');
        if (!key || key === 'respawnSet') return;
        this.lastText = { key, at: performance.now() };
        const reason = BED_TEXTS[key] ?? key;
        this.stats.refused++;
        this.log.info(`sleep: refused (tile.bed.${key})`);
        this.emit({ kind: 'refused', reason, text: key });
      }),
      s.on('start_game', () => {
        this.setAsleep(false);
      }),
    );
  }

  dispose(): void {
    for (const u of this.unsubs.splice(0)) u();
    this.release();
  }

  /** The server says the bot is asleep (player_flags). */
  get sleeping(): boolean {
    return this.asleep;
  }

  get busy(): boolean {
    return this.running;
  }

  /** The bed the server put the bot in (player_bed_position), while asleep. */
  get bed(): Vec3 | undefined {
    return this.asleep ? this.bedPos : undefined;
  }

  /** Milliseconds asleep so far (0 when awake). */
  get asleepMs(): number {
    return this.asleep ? performance.now() - this.since : 0;
  }

  onEvent(fn: (e: SleepEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  cancel(): void {
    if (this.running) this.cancelled = true;
  }

  /**
   * Click the bed at `p` and wait for the answer: asleep (`ok`), a refusal text, or `timeout`. The
   * caller walks within reach first (about 2 blocks; `too_far` beyond 3).
   */
  async sleep(p: Vec3, opts: { timeoutTicks?: number } = {}): Promise<SleepResult> {
    if (this.running) return { ok: false, reason: 'busy' };
    if (this.asleep) return { ok: true, bed: this.bedPos, ticks: 0 };
    const { loop, world, source } = this.d;
    if (!loop.state.ready) return { ok: false, reason: 'not_ready' };
    const bp = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    const b = world.blockAt(bp);
    if (!b) return { ok: false, reason: 'unloaded' };
    if (!isBed(b)) return { ok: false, reason: 'not_a_bed' };
    this.running = true;
    this.cancelled = false;
    try {
      const eye0 = this.eye();
      loop.setCommand(lookAngles(eye0, blockCenter(bp)));
      await loop.waitTicks(2);
      if (this.cancelled) return { ok: false, reason: 'interrupted' };
      const eye = this.eye();
      const slot = world.inventory.selected;
      const held = wireItemOf(world.inventory.slots[slot], world.inventory.rawItem(0, slot) ?? this.d.rawHotbarItem?.(slot));
      const sentAt = performance.now();
      this.stats.clicks++;
      source.queue('inventory_transaction', clickBlockTransaction({ pos: bp, face: faceToward(eye, bp), hotbarSlot: slot, held, eye, blockRuntimeId: world.chunks.runtimeIdAt(bp.x, bp.y, bp.z) ?? 0 }));
      const timeout = opts.timeoutTicks ?? 20;
      for (let i = 1; i <= timeout; i++) {
        await loop.waitTicks(1);
        if (this.asleep) {
          this.log.info(`sleep: asleep in the bed at ${bp.x} ${bp.y} ${bp.z} after ${i} ticks`);
          return { ok: true, ticks: i, bed: this.bedPos ?? bp };
        }
        const t = this.lastText;
        if (t && t.at >= sentAt) return { ok: false, reason: BED_TEXTS[t.key] ?? t.key, text: t.key, ticks: i, bed: bp };
        if (this.cancelled) return { ok: false, reason: 'interrupted' };
      }
      return { ok: false, reason: 'timeout', bed: bp };
    } finally {
      this.running = false;
    }
  }

  /** Leave the bed now (player_action stop_sleeping; the server answers with wake_up and player_flags 0). */
  wake(): void {
    if (!this.asleep) return;
    this.log.info('sleep: leaving the bed');
    this.d.source.queue('player_action', { runtime_entity_id: this.d.selfRuntimeId(), action: 'stop_sleeping', position: { x: 0, y: 0, z: 0 }, result_position: { x: 0, y: 0, z: 0 }, face: 0 });
  }

  /** Resolves when the server wakes the bot (or at once when awake); false on timeout. */
  async waitAwake(timeoutTicks = Infinity): Promise<boolean> {
    for (let i = 0; this.asleep; i++) {
      if (i >= timeoutTicks) return false;
      await this.d.loop.waitTicks(1);
    }
    return true;
  }

  private eye(): Vec3 {
    const f = this.d.loop.state.pos;
    return { x: f.x, y: f.y + EYE_HEIGHT, z: f.z };
  }

  private setAsleep(v: boolean): void {
    if (v === this.asleep) {
      if (v && this.bedPos && !this.holding) this.install();
      return;
    }
    this.asleep = v;
    if (v) {
      this.since = performance.now();
      this.stats.slept++;
      this.install();
      this.emit({ kind: 'asleep', bed: this.bedPos });
    } else {
      const ms = performance.now() - this.since;
      this.stats.woke++;
      this.release();
      this.log.info(`sleep: awake after ${(ms / 1000).toFixed(1)} s`);
      this.emit({ kind: 'awake', ms });
    }
  }

  /** Report the server's sleeping position every tick (no movement) while asleep. */
  private install(): void {
    const b = this.bedPos;
    if (!b || !this.d.loop.setTickExtras) return;
    this.hold = { x: b.x + 0.5, y: b.y + SLEEP_EYE_ABOVE, z: b.z + 0.5 };
    this.holding = true;
    const zero = { x: 0, y: 0, z: 0 };
    this.d.loop.setTickExtras(() => (this.hold ? { position: this.hold, delta: zero, move_vector: { x: 0, z: 0 }, raw_move_vector: { x: 0, z: 0 } } : undefined));
  }

  private release(): void {
    this.hold = undefined;
    if (this.holding) this.d.loop.setTickExtras?.(undefined);
    this.holding = false;
  }

  private emit(e: SleepEvent): void {
    for (const fn of [...this.listeners]) fn(e);
  }
}
