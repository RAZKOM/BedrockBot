// Dimensions (wave 10, Track AT; docs/nether.md): names, the per-dimension rules other modules ask
// about, the per-dimension waypoint names, and the client side of a dimension change.
//
// A dimension change on BDS 1.26.60.6 (recorded on bds-nether, docs/nether.md "Packets"), the same for a
// portal and for a script / command teleport across dimensions:
//   server  change_dimension { dimension, position, respawn: false, loading_screen_id }
//           (the overworld entities were removed just before with remove_entity; no respawn, no
//           play_status, no start_game). position: the arrival feet for a teleport; for a portal the
//           scaled source position (sometimes still at the old eye height): approximate only.
//   server  network_chunk_publisher_update (the first one still at the old position), level_chunk /
//           subchunk for the new dimension (`dimension` field = the new id)
//   server  player_action { action: 'dimension_change_ack', position 0 0 0 } 0.4 to 2.7 s later
//   client  player_action { action: 'dimension_change_ack', position 0 0 0, face 0 }   <- this module
//   server  move_player { mode: 'teleport' (or 'reset' after a portal) } with the exact eye position
// Until the client answers the server's ack, BDS ignores every player_auth_input (no correction, no
// movement: measured, the bot walked in place for 10 s); after it the server moves the player normally.
//
//   const dims = new DimensionWatcher(conn, { selfRuntimeId: () => world.self.runtimeId, dimension: () => world.self.dimension });
//   dims.onChange((e) => { if (e.phase === 'start') skills.cancel(); });
import { silentLogger, type Logger } from '../log.ts';
import type { PacketSource, Vec3 } from './types.ts';

export const OVERWORLD = 0;
export const NETHER = 1;
export const THE_END = 2;

const NAMES: Record<number, string> = { 0: 'overworld', 1: 'nether', 2: 'the_end' };
const IDS: Record<string, number> = { overworld: 0, nether: 1, the_nether: 1, the_end: 2, end: 2 };

/** `overworld` | `nether` | `the_end` (other ids as their number). */
export function dimensionName(d: number | undefined): string {
  if (d === undefined) return 'unknown';
  return NAMES[d] ?? String(d);
}

/** Dimension id of a name or number (`nether`, `minecraft:the_end`, `1`); undefined when unknown. */
export function dimensionIdOf(s: string | number | undefined): number | undefined {
  if (typeof s === 'number') return Number.isInteger(s) ? s : undefined;
  if (s === undefined) return undefined;
  const k = s.trim().toLowerCase().replace(/^minecraft:/, '');
  if (k in IDS) return IDS[k];
  return /^-?\d+$/.test(k) ? Number(k) : undefined;
}

// ---- per-dimension rules -------------------------------------------------------------------------

/** The sun moves (night safety, the night shelter and sleeping only make sense here). */
export function hasDayCycle(d: number): boolean {
  return d === OVERWORLD;
}

/** Beds can be slept in (they explode in the Nether and the End). */
export function bedsWork(d: number): boolean {
  return d === OVERWORLD;
}

/** "The surface" (sky above the head) exists: not under the Nether's bedrock ceiling. */
export function hasSurface(d: number): boolean {
  return d !== NETHER;
}

/** A water bucket can be emptied (water evaporates in the Nether). */
export function waterWorks(d: number): boolean {
  return d !== NETHER;
}

/** Below the lowest blocks is the void (the End): a fall over an edge is never survivable. */
export function voidBelow(d: number): boolean {
  return d === THE_END;
}

/** Why `!top` / the surface goal refuse here, or undefined when they work. */
export function surfaceRefusal(d: number | undefined): string | undefined {
  return d === NETHER ? 'there is no surface in the Nether (a bedrock ceiling at y 127); use !overworld to leave' : undefined;
}

// ---- per-dimension waypoints ---------------------------------------------------------------------
// The waypoint store (waypoints/store.ts) has one flat namespace per server. Overworld waypoints keep
// their plain names; the other dimensions' carry a prefix: `nether_portal`, `end_portal`.

const PREFIX: Record<number, string> = { 1: 'nether_', 2: 'end_' };

/** Store name of waypoint `name` in dimension `d` (`portal` in the Nether -> `nether_portal`). */
export function dimWaypointName(d: number, name: string): string {
  const p = PREFIX[d];
  return p ? `${p}${name}`.slice(0, 32) : name;
}

/** The dimension a stored waypoint name belongs to (by its prefix). */
export function waypointDimension(storeName: string): number {
  for (const [d, p] of Object.entries(PREFIX)) if (storeName.startsWith(p)) return Number(d);
  return OVERWORLD;
}

// ---- the change itself ---------------------------------------------------------------------------

export type DimensionPhase = 'start' | 'arrived';

export interface DimensionChange {
  phase: DimensionPhase;
  from: number;
  to: number;
  /** change_dimension's position (approximate arrival, see the header). */
  position: Vec3;
  loadingScreenId: number | undefined;
  /** ms since the change_dimension (0 at 'start'). */
  ms: number;
}

export interface DimensionStats {
  changes: number;
  arrivals: number;
  /** ms from change_dimension to the server's ack, last change. */
  lastAckMs: number | undefined;
  /** The last change: from, to, when (ms clock). */
  last: { from: number; to: number; at: number } | undefined;
  /** Columns loaded when the last change dropped them (the chunk reset size). */
  lastColumnsDropped: number | undefined;
}

export interface DimensionWatcherOptions {
  /** The bot's runtime id (for the ack). */
  selfRuntimeId: () => bigint;
  /** The current dimension (World.self.dimension), read before the world model switches. */
  dimension: () => number;
  /** Loaded columns right now (the chunk reset size), optional. */
  loadedColumns?: () => number;
  logger?: Logger;
  now?: () => number;
}

interface PVec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Answers the server's dimension_change_ack and reports changes ('start' on change_dimension,
 * 'arrived' on the server's ack). Subscribe before the World so 'start' sees the old dimension.
 */
export class DimensionWatcher {
  readonly stats: DimensionStats = { changes: 0, arrivals: 0, lastAckMs: undefined, last: undefined, lastColumnsDropped: undefined };
  private readonly source: Pick<PacketSource, 'on' | 'queue'>;
  private readonly o: DimensionWatcherOptions;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly unsubs: (() => void)[] = [];
  private readonly listeners = new Set<(e: DimensionChange) => void>();
  private pending: { from: number; to: number; at: number; position: Vec3; loadingScreenId: number | undefined } | undefined;

  constructor(source: Pick<PacketSource, 'on' | 'queue'>, opts: DimensionWatcherOptions) {
    this.source = source;
    this.o = opts;
    this.log = opts.logger ?? silentLogger;
    this.now = opts.now ?? (() => performance.now());
    this.unsubs.push(
      source.on('change_dimension', (p) => {
        this.onChangeDimension(p as unknown as { dimension: number; position: PVec3; loading_screen_id?: number });
      }),
      source.on('player_action', (p) => {
        if ((p as { action?: unknown }).action === 'dimension_change_ack') this.onServerAck();
      }),
    );
  }

  /** A change is under way (change_dimension seen, the server's ack not yet). */
  get changing(): boolean {
    return this.pending !== undefined;
  }

  onChange(fn: (e: DimensionChange) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  dispose(): void {
    for (const u of this.unsubs.splice(0)) u();
    this.listeners.clear();
  }

  private onChangeDimension(p: { dimension: number; position: PVec3; loading_screen_id?: number }): void {
    const from = this.o.dimension();
    const at = this.now();
    const position = { x: p.position.x, y: p.position.y, z: p.position.z };
    this.pending = { from, to: p.dimension, at, position, loadingScreenId: p.loading_screen_id };
    this.stats.changes++;
    this.stats.last = { from, to: p.dimension, at };
    this.stats.lastColumnsDropped = this.o.loadedColumns?.();
    this.log.info(`dimension change ${dimensionName(from)} -> ${dimensionName(p.dimension)} (arrival about ${position.x.toFixed(1)} ${position.y.toFixed(1)} ${position.z.toFixed(1)})`);
    this.emit({ phase: 'start', from, to: p.dimension, position, loadingScreenId: p.loading_screen_id, ms: 0 });
  }

  private onServerAck(): void {
    const zero = { x: 0, y: 0, z: 0 };
    // without this answer BDS ignores the player's movement in the new dimension
    this.source.queue('player_action', { runtime_entity_id: this.o.selfRuntimeId(), action: 'dimension_change_ack', position: zero, result_position: zero, face: 0 });
    const p = this.pending;
    this.pending = undefined;
    if (!p) return; // an ack without a change we saw (joined mid-change): answered anyway
    const ms = this.now() - p.at;
    this.stats.arrivals++;
    this.stats.lastAckMs = Math.round(ms);
    this.log.info(`dimension change to ${dimensionName(p.to)} acknowledged after ${Math.round(ms)} ms`);
    this.emit({ phase: 'arrived', from: p.from, to: p.to, position: p.position, loadingScreenId: p.loadingScreenId, ms });
  }

  private emit(e: DimensionChange): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(e);
      } catch (err) {
        this.log.warn(`dimension listener threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
