// Track BF: SurfaceProcess, the underwater escape (docs/flight.md "Underwater recovery"). A body
// whose head stays under water (a flight's emergency landing in the sea, a fall into a lake, a
// knock-back) swims straight up and walks to the nearest dry ground, instead of sitting on the bottom
// until the air runs out (the Realm, 2026-10-30: the bot sat 15 blocks down for minutes because every
// goto failed with `no standable node`). Priority above flee, like the fire escape: drowning kills.
import type { Vec3 } from '../../connection/types.ts';
import { silentLogger, type Logger } from '../../log.ts';
import { headInWater, swimUp, type NameAt, type SurfaceLoop } from '../../skills/survival/surface.ts';
import type { ProcessMover } from './goto.ts';
import { BaseProcess, PRIORITY, type ProcessStatus } from './manager.ts';

export interface SurfaceGrid {
  stand(x: number, y: number, z: number): number | undefined;
  cls(x: number, y: number, z: number): { name: string; liquid?: string | undefined } | undefined;
}

export interface SurfaceDeps {
  loop: SurfaceLoop & { readonly state: { readonly ready?: boolean } };
  blockAt: NameAt;
  grid: SurfaceGrid;
  mover: ProcessMover;
  /** The server's air supply (0..300 ticks), when it sent one (MobTracker.selfAir). */
  air?: () => number | undefined;
  log?: Logger;
}

/** Ticks with the head under water before the escape starts (without an air value). */
export const SURFACE_AFTER_TICKS = 60;
/** With an air value: start once the air is below this (of 300; 10 s under water, 5 s left). */
export const SURFACE_AIR = 100;
/** How far the shore search looks (blocks). */
export const SHORE_RADIUS = 24;

/**
 * The nearest cell (by horizontal rings) a body stands in out of the water: a standable cell whose
 * feet and floor are not liquid, feet within -3..+3 of `from` (the surface), or undefined.
 */
export function shoreNear(grid: SurfaceGrid, from: Vec3, radius = SHORE_RADIUS): Vec3 | undefined {
  const fx = Math.floor(from.x);
  const fy = Math.floor(from.y + 1e-6);
  const fz = Math.floor(from.z);
  for (let r = 1; r <= radius; r++) {
    let best: Vec3 | undefined;
    let bestD = Infinity;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        for (const dy of [0, 1, -1, 2, -2, 3, -3]) {
          const x = fx + dx;
          const y = fy + dy;
          const z = fz + dz;
          const f = grid.stand(x, y, z);
          if (f === undefined || Number.isNaN(f)) continue;
          if (grid.cls(x, y, z)?.liquid || grid.cls(x, y - 1, z)?.liquid) continue;
          const d = Math.hypot(dx, dz) + Math.abs(dy) * 0.5;
          if (d < bestD) {
            bestD = d;
            best = { x, y, z };
          }
        }
      }
    }
    if (best) return best;
  }
  return undefined;
}

export class SurfaceProcess extends BaseProcess {
  readonly name = 'surface';
  readonly kind = 'auto' as const;
  protected override persistent = true;
  private readonly d: SurfaceDeps;
  private readonly log: Logger;
  private wetTicks = 0;
  private lastSample = -1;
  private episode: { phase: 'up' | 'shore'; to?: Vec3 } | undefined;
  readonly stats = { escapes: 0, surfaced: 0, shore: 0 };

  constructor(deps: SurfaceDeps) {
    super();
    this.d = deps;
    this.log = deps.log ?? silentLogger;
    this.d.loop.onBeforeStep((_t, s) => {
      this.wetTicks = headInWater(this.d.blockAt, s.pos) ? this.wetTicks + 1 : 0;
    });
  }

  get priority(): number {
    return PRIORITY.flee + 1;
  }

  override wants(): boolean {
    if (this.episode !== undefined) return true;
    if (this.d.loop.state.ready === false) return false;
    const air = this.d.air?.();
    if (air !== undefined) return this.wetTicks > 0 && air < SURFACE_AIR;
    return this.wetTicks >= SURFACE_AFTER_TICKS;
  }

  status(): ProcessStatus {
    const to = this.episode?.to;
    return { line: this.episode?.phase === 'shore' && to ? `out of the water to ${to.x} ${to.y} ${to.z}` : 'swimming up for air' };
  }

  protected run(t: number): void {
    const from = this.d.loop.state.pos;
    this.episode = { phase: 'up' };
    this.stats.escapes++;
    this.lastSample = this.wetTicks;
    const air = this.d.air?.();
    this.log.warn(
      `surface: head under water at ${from.x.toFixed(1)} ${from.y.toFixed(1)} ${from.z.toFixed(1)} for ${this.lastSample} ticks${air !== undefined ? `, air ${air}` : ''}: swimming up`,
    );
    void (async () => {
      this.d.mover.cancel();
      const up = await swimUp(this.d.loop, this.d.blockAt, { cancelled: () => t !== this.token });
      if (t !== this.token) return;
      if (up.ok) this.stats.surfaced++;
      const to = shoreNear(this.d.grid, this.d.loop.state.pos);
      this.log.info(`surface: ${up.ok ? 'surfaced' : 'still under water'} after ${up.ticks} ticks (rose ${up.rose.toFixed(1)}); ${to ? `shore at ${to.x} ${to.y} ${to.z}` : `no dry ground within ${SHORE_RADIUS}`}`);
      if (to) {
        this.episode = { phase: 'shore', to };
        const r = await this.d.mover.goto({ type: 'block', p: to }, { timeoutTicks: 1200 });
        if (t !== this.token) return;
        if (r.ok) this.stats.shore++;
        else this.log.info(`surface: walk to the shore failed (${r.reason})`);
      }
      this.episode = undefined;
      this.wetTicks = 0;
      this.yieldControl();
    })();
  }

  protected halt(): void {
    this.d.mover.cancel();
    this.d.loop.setCommand({ jump: false });
  }

  protected override reset(): void {
    this.episode = undefined;
  }
}
