// Automatic waypoints (PLAN.md task 7.10, docs/waypoints.md):
//   death   the feet block where the bot died (tasks/respawn.ts death event, its last known position)
//   spawn   from `set_spawn_position`: the player's spawn point (a bed, /spawnpoint) when the server
//           names one, else the world spawn. BDS 1.26.60 sends it at the join with no position at all
//           (every coordinate -2^31; fixtures/1.26.60/login-idle), so until a real one arrives the
//           world spawn from `start_game.spawn_position` is used (only when there is no spawn
//           waypoint yet: a stored bed spawn survives a restart). y 32767 there means "no height".
//   home    follows `!home set` / `!home clear` (chat/commands-nav.ts wraps the task's home access)
import type { Vec3 } from '../connection/types.ts';
import type { Logger } from '../log.ts';
import { silentLogger } from '../log.ts';
import type { WaypointPos, WaypointStore } from './store.ts';

/** Feet block of a position. */
export function blockOf(p: Vec3): Vec3 {
  return { x: Math.floor(p.x), y: Math.floor(p.y + 1e-6), z: Math.floor(p.z) };
}

const LIMIT = 30_000_000;
/** BlockCoordinates' y is an unsigned varint on the wire: 2^32 - 60 means -60. */
const signed = (v: number): number => (v > 0x7fffffff ? v - 0x100000000 : v);

function coords(raw: unknown): WaypointPos | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const x = Number(r.x);
  const z = Number(r.z);
  let y: number | null = signed(Number(r.y));
  if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) >= LIMIT || Math.abs(z) >= LIMIT) return undefined;
  // a world spawn without a height (32767: "find the ground") or garbage: walk to the column only
  if (!Number.isFinite(y) || y < -64 || y > 320) y = null;
  return { x, y, z };
}

/** The spawn waypoint of a `set_spawn_position` packet, or undefined (no usable position). */
export function spawnPositionOf(p: Record<string, unknown>): WaypointPos | undefined {
  const type = p.spawn_type;
  const player = coords(p.player_position);
  const world = coords(p.world_position);
  if ((type === 'player' || type === 0) && player) return player;
  return world ?? player;
}

/** The world spawn of a `start_game` packet, or undefined. */
export function worldSpawnOf(p: Record<string, unknown>): WaypointPos | undefined {
  return coords(p.spawn_position);
}

export interface AutoWaypointDeps {
  store: WaypointStore;
  conn: { on(name: string, fn: (p: Record<string, unknown>) => void): () => void };
  respawn?: { onEvent(fn: (e: { kind: string; death?: { at?: Vec3 } }) => void): () => void };
  log?: Logger;
}

/** Keeps `death` and `spawn` up to date. Returns the unsubscribe function. */
export function attachAutoWaypoints(d: AutoWaypointDeps): () => void {
  const log = d.log ?? silentLogger;
  const offs: (() => void)[] = [];
  offs.push(
    d.conn.on('start_game', (p) => {
      const pos = worldSpawnOf(p);
      if (!pos || d.store.get('spawn')) return;
      const w = d.store.set('spawn', pos, { auto: true });
      log.info(`waypoint spawn: ${w.x} ${w.y ?? '?'} ${w.z} (world spawn, start_game)`);
    }),
    d.conn.on('set_spawn_position', (p) => {
      const pos = spawnPositionOf(p);
      if (!pos) return;
      const old = d.store.get('spawn');
      const w = d.store.set('spawn', pos, { auto: true });
      if (w !== old) log.info(`waypoint spawn: ${w.x} ${w.y ?? '?'} ${w.z} (${String(p.spawn_type)})`);
    }),
  );
  if (d.respawn) {
    offs.push(
      d.respawn.onEvent((e) => {
        const at = e.kind === 'death' ? e.death?.at : undefined;
        if (!at) return;
        const w = d.store.set('death', blockOf(at), { auto: true });
        log.info(`waypoint death: ${w.x} ${w.y ?? '?'} ${w.z}`);
      }),
    );
  }
  return () => {
    for (const off of offs.splice(0)) off();
  };
}
