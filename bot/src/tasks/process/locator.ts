// Where far players are (wave 7, Track W; docs/pve.md "Trip readiness"). BDS only sends a player as an
// entity (add_player, move_player) within about 75 blocks (measured on bds-gaunt: tracked at 70, not at
// 80, whatever chunk radius the client asks for), so `!come` from farther away had no position. The
// locator bar fills the gap (BDS 1.26.60.6, verified): for every other player the server sends
//
//   player_location { entity_unique_id, type: 'coordinates', position: <eye, feet + 1.62> }
//   locator_bar { waypoints: [{ waypoint: { world_position: { position, dimension_id }, actor_unique_id }, action }] }
//
// at the join and whenever the player moved (seen at 20, 120 and 300 blocks); player_list `add`
// records map the username to the unique id. A player_list `remove` forgets it; `type_hide` (sent when
// the player comes into entity range) keeps the last position.
import type { Vec3 } from '../../connection/types.ts';

const EYE = 1.62;

const toBig = (v: unknown): bigint | undefined => {
  try {
    return BigInt(v as bigint | number | string);
  } catch {
    return undefined;
  }
};

export interface LocatedPlayer {
  feet: Vec3;
  /** performance.now() of the last update. */
  at: number;
}

export class PlayerLocator {
  private readonly byName = new Map<string, bigint>();
  private readonly byUuid = new Map<string, bigint>();
  private readonly pos = new Map<bigint, LocatedPlayer>();
  private readonly unsubs: (() => void)[] = [];
  /** Updates received (both packets). */
  updates = 0;

  constructor(source: { on(name: string, fn: (p: Record<string, unknown>) => void): () => void }) {
    this.unsubs.push(
      source.on('player_list', (p) => {
        const recs = (p.records as { records?: unknown[] } | unknown[] | undefined) ?? [];
        const list = Array.isArray(recs) ? recs : (recs.records ?? []);
        for (const r of list as Record<string, unknown>[]) {
          const uuid = typeof r.uuid === 'string' ? r.uuid : undefined;
          if (r.type === 'add' && typeof r.username === 'string') {
            const uid = toBig(r.entity_unique_id);
            if (uid === undefined) continue;
            this.byName.set(clean(r.username), uid);
            if (uuid) this.byUuid.set(uuid, uid);
          } else if (r.type === 'remove' && uuid) {
            const uid = this.byUuid.get(uuid);
            this.byUuid.delete(uuid);
            if (uid !== undefined) {
              this.pos.delete(uid);
              for (const [n, u] of this.byName) if (u === uid) this.byName.delete(n);
            }
          }
        }
      }),
      source.on('player_location', (p) => {
        const uid = toBig(p.entity_unique_id);
        if (uid === undefined) return;
        const v = p.position as Vec3 | undefined;
        if (p.type === 'coordinates' && v) this.set(uid, v);
        // type_hide: the player came into entity range (the bar hides it); keep the last position, it is still the best guess once out of range again
      }),
      source.on('locator_bar', (p) => {
        for (const w of (p.waypoints ?? []) as { waypoint?: { world_position?: { position?: Vec3; dimension_id?: number }; actor_unique_id?: unknown }; action?: string }[]) {
          const uid = toBig(w.waypoint?.actor_unique_id);
          const v = w.waypoint?.world_position?.position;
          if (uid !== undefined && v && (w.waypoint?.world_position?.dimension_id ?? 0) === 0) this.set(uid, v);
        }
      }),
      source.on('start_game', () => {
        this.pos.clear();
      }),
    );
  }

  dispose(): void {
    for (const u of this.unsubs.splice(0)) u();
  }

  private set(uid: bigint, eye: Vec3): void {
    if (Math.abs(eye.y) > 4096) return; // the first one at a join is at y 32769 (not placed yet)
    this.updates++;
    this.pos.set(uid, { feet: { x: eye.x, y: eye.y - EYE, z: eye.z }, at: performance.now() });
  }

  /** Feet of a player by name from the locator, if the server told us. */
  find(name: string): LocatedPlayer | undefined {
    const uid = this.byName.get(clean(name));
    return uid === undefined ? undefined : this.pos.get(uid);
  }
}

function clean(name: string): string {
  return name.replace(/§./g, '').toLowerCase();
}
