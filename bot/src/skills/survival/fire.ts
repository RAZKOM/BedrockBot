// Fire and lava reactions (wave 10, Track AT; docs/nether.md "Fire"): when the bot burns (its own
// `set_entity_data` flag `onfire`, or the body touches lava / fire) and loses health, it walks to the
// nearest cell that is not burning and not next to fire or lava, then eats (tasks/process/portal.ts
// FireProcess runs it as a process above flee). No water bucket: it would evaporate in the Nether and the
// bot carries none on purpose.
//
//   const watch = new BurnWatch(conn, { selfRuntimeId, health: () => world.self.health });
//   if (watch.hurtByFire()) { const to = fireEscape(grid, pos); ... }
import type { PacketSource, Vec3 } from '../../world/types.ts';

/** Blocks that set the body on fire or hurt it by heat (the planner already never stands in or on them). */
export const HOT_BLOCKS: ReadonlySet<string> = new Set(['fire', 'soul_fire', 'lava', 'flowing_lava', 'magma', 'campfire', 'soul_campfire', 'lava_cauldron']);

/** What fireEscape reads (NavGrid satisfies it). */
export interface FireGrid {
  /** Feet height of a body standing in cell (x, y, z); NaN = blocked, undefined = not loaded. */
  stand(x: number, y: number, z: number): number | undefined;
  cls(x: number, y: number, z: number): { name: string; liquid?: string | undefined } | undefined;
}

function hot(grid: FireGrid, x: number, y: number, z: number): boolean {
  const c = grid.cls(x, y, z);
  return !!c && (c.liquid === 'lava' || HOT_BLOCKS.has(c.name));
}

/**
 * The fire / lava reaction's target: the nearest feet cell (Chebyshev rings out to `radius`, feet levels
 * y - 2 .. y + 2) where the body can stand and no block of the 3 x 3 x 3 cells around the feet (floor,
 * feet and head levels) burns. Undefined when none is known (the caller then just eats and waits).
 */
export function fireEscape(grid: FireGrid, from: Vec3, radius = 6): Vec3 | undefined {
  const fx = Math.floor(from.x);
  const fy = Math.floor(from.y + 1e-6);
  const fz = Math.floor(from.z);
  let best: Vec3 | undefined;
  let bestD = Infinity;
  for (let r = 0; r <= radius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        for (const dy of [0, 1, -1, 2, -2]) {
          const x = fx + dx;
          const y = fy + dy;
          const z = fz + dz;
          const f = grid.stand(x, y, z);
          if (f === undefined || Number.isNaN(f)) continue;
          let burning = false;
          for (let ax = -1; ax <= 1 && !burning; ax++) for (let az = -1; az <= 1 && !burning; az++) for (let ay = -1; ay <= 1 && !burning; ay++) burning = hot(grid, x + ax, y + ay, z + az);
          if (burning) continue;
          const d = Math.hypot(dx, dy, dz);
          if (d < bestD) {
            bestD = d;
            best = { x, y, z };
          }
        }
      }
    }
    if (best) return best; // the nearest ring with a safe cell
  }
  return best;
}

export interface BurnWatchOptions {
  selfRuntimeId: () => bigint;
  health: () => number;
  /** The body touches lava (InputLoop state.inLava), optional. */
  inLava?: () => boolean;
  now?: () => number;
}

/** Tracks the bot's own `onfire` flag and its health drops. */
export class BurnWatch {
  /** The server's `onfire` flag for the bot (set_entity_data flags). */
  onFire = false;
  /** now() of the last health drop while burning (or touching lava). */
  lastFireHurtAt = -Infinity;
  readonly stats = { burns: 0, fireHurts: 0 };
  private readonly o: BurnWatchOptions;
  private readonly now: () => number;
  private lastHealth: number | undefined;
  private readonly unsubs: (() => void)[] = [];

  constructor(source: Pick<PacketSource, 'on'>, opts: BurnWatchOptions) {
    this.o = opts;
    this.now = opts.now ?? (() => performance.now());
    this.unsubs.push(
      source.on('set_entity_data', (p) => {
        const rid = p.runtime_entity_id;
        if (rid === undefined || BigInt(rid as number | bigint) !== this.o.selfRuntimeId()) return;
        for (const m of (p.metadata ?? []) as { key?: string; value?: { onfire?: boolean } }[]) {
          if (m.key !== 'flags' || typeof m.value?.onfire !== 'boolean') continue;
          if (m.value.onfire && !this.onFire) this.stats.burns++;
          this.onFire = m.value.onfire;
        }
      }),
      source.on('respawn', (p) => {
        if (p.state === 1) {
          this.onFire = false;
          this.lastHealth = undefined;
        }
      }),
    );
  }

  /** Burning: the flag, or the body in lava. */
  burning(): boolean {
    return this.onFire || (this.o.inLava?.() ?? false);
  }

  /** Call every few ticks: notes a health drop while burning. */
  sample(): void {
    const h = this.o.health();
    const prev = this.lastHealth;
    this.lastHealth = h;
    if (prev !== undefined && h < prev && this.burning()) {
      this.lastFireHurtAt = this.now();
      this.stats.fireHurts++;
    }
  }

  /** Burning and hurt by it within the last `ms`. */
  hurtByFire(ms = 3000): boolean {
    return this.burning() && this.now() - this.lastFireHurtAt <= ms;
  }

  dispose(): void {
    for (const u of this.unsubs.splice(0)) u();
  }
}
