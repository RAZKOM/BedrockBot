// Track F4b (docs/flight.md "Corridor flight", ADR 0067): a long `!fly` along a coarse corridor. commands-fly.ts
// hands over to `runCorridorTrip` when `corridorWanted` (skills/fly/corridor/registry.ts) says so: the task has
// a corridor provider (the coarse layer, Track CB, or the e2e's stub), `flyCorridor` is not off, and the goal
// is far and covered. The executor (skills/fly/corridor/executor.ts) gets its ports here: the cruise (the
// FlyProcess built as `!fly` builds it, passed in by commands-fly), the underground windows (UnderFlyProcess on
// the chain of trackers, the worker's planner), the walk (the navigator's unwrapped walk), the live model's
// cells and chunks. The chestplate goes back on at the end.
import type { Vec3 } from '../connection/types.ts';
import type { Logger } from '../log.ts';
import type { FlightLoop } from '../skills/fly/controller.ts';
import { readKit, type FlightKitMemory, type KitInventory } from '../skills/fly/kit.ts';
import type { FlightKitOps } from '../skills/fly/kitops.ts';
import type { RocketDeps } from '../skills/fly/rocket.ts';
import type { RouteGrid } from '../skills/fly/route/grid.ts';
import type { Planner } from '../skills/fly/route/tracker.ts';
import type { CorridorProvider } from '../skills/fly/corridor/coarse-port.ts';
import { flyStretch, proofOf, windowRequest, type StretchOptions } from '../skills/fly/corridor/drive.ts';
import { CorridorExecutor, type CorridorReport, type ExecutorOptions, type StepOutcome, type WindowProof } from '../skills/fly/corridor/executor.ts';
import type { RoutePlan } from '../skills/fly/route/types.ts';
import { corridorUnderFly, setCorridorAirborne } from '../skills/fly/corridor/registry.ts';
import type { Window } from '../skills/fly/corridor/stretches.ts';
import { UnderFlyProcess } from '../tasks/process/corridor.ts';
import type { ProcessManager } from '../tasks/process/manager.ts';

export interface CorridorWiring extends Omit<RocketDeps, 'loop' | 'inventory'> {
  task: object;
  loop: FlightLoop & { readonly state: { ready?: boolean } };
  inventory: KitInventory & RocketDeps['inventory'];
  memory: () => FlightKitMemory;
  kitOps: Pick<FlightKitOps, 'wearElytra' | 'rocketsToHotbar' | 'wearChestplate'>;
  processes: Pick<ProcessManager, 'add'>;
  /** The live model's cell: true solid, false air, undefined not loaded. */
  solid: (x: number, y: number, z: number) => boolean | undefined;
  loaded: (cx: number, cz: number) => boolean;
  dim: () => number;
  /** The body's health (hotfix 2026-11-06: the trip ends on a death or below CORRIDOR_HEALTH_MIN). */
  health?: () => number | undefined;
  columnLoaded?: (fn: (cx: number, cz: number) => void) => () => void;
  /** The route grid over the live model (unknown solid) and the worker's planner over it. */
  grid: RouteGrid;
  plan: Planner;
  /** The cruise to an exact feet cell (commands-fly: the takeoff chain, planFlight, a FlyProcess). */
  flySky: (cell: Vec3, label: string) => Promise<StepOutcome>;
  /** Walk to a feet cell (the navigator's own walk, not the fly-wrapped one). */
  walk: (cell: Vec3, label: string) => Promise<StepOutcome>;
  log: Logger;
}

/** Hotfix 2026-11-06 (a Realm death in a cave): a corridor trip ends when the health falls under this, or on a death. */
export const CORRIDOR_HEALTH_MIN = 12;

const trips = new WeakMap<object, { stop(): void }>();

/** `!fly stop` while a corridor trip runs: it ends after the step in progress (a window in the air lands first). */
export function stopCorridorTrip(task: object): boolean {
  const t = trips.get(task);
  if (!t) return false;
  t.stop();
  return true;
}

/**
 * Track F5b: what the cave style adds to a trip (skills/fly/cave/style.ts): the executor's windows, each window's stretch
 * options (the margin, the goals a tracker, the rules), and the proof of a window before its takeoff (the plan from
 * standing in the route worker at the style's budget).
 */
export interface TripStyle {
  executor?: ExecutorOptions;
  stretch?: (w: Window) => Partial<StretchOptions>;
  prove?: { maxMs: number; maxNodes: number };
}

/** Follow corridors from where the bot stands to `goal` (a feet cell). */
export async function runCorridorTrip(w: CorridorWiring, provider: CorridorProvider, goal: Vec3, label: string, style: TripStyle = {}): Promise<CorridorReport> {
  let stopped = false;
  let under: UnderFlyProcess | undefined;
  trips.set(w.task, {
    stop: () => {
      stopped = true;
      under?.stopNow();
    },
  });
  // hotfix 2026-11-06: watch the health every tick; a death or low health stops the trip (the window in the air lands first)
  let done = false;
  let unsafe: string | undefined;
  const watch = async (): Promise<void> => {
    while (!done && !stopped) {
      const h = w.health?.();
      if (h !== undefined && (h <= 0 || h < CORRIDOR_HEALTH_MIN)) {
        unsafe = h <= 0 ? 'died' : `health ${h.toFixed(1)} under ${CORRIDOR_HEALTH_MIN}`;
        w.log.warn(`corridor: stopping the trip (${unsafe})`);
        stopped = true;
        under?.stopNow();
        return;
      }
      await w.loop.waitTicks(1);
    }
  };
  setCorridorAirborne(w.task, () => under?.phase === 'flying' && (w.loop.state.gliding || !w.loop.state.onGround));
  const flyUnder = async (win: Window, l: string, plan?: RoutePlan): Promise<StepOutcome> => {
    const p = new UnderFlyProcess(win, l, {
      kitOps: w.kitOps,
      inventory: w.inventory,
      memory: w.memory,
      fly: (x) => flyStretch({ loop: w.loop, queue: w.queue, inventory: w.inventory, hotbar: w.hotbar, entities: w.entities, grid: w.grid, plan: w.plan, ...(w.columnLoaded ? { columnLoaded: w.columnLoaded } : {}), log: w.log }, { goals: x.goals, margin: x.margin, ...(style.stretch?.(x) ?? {}), ...(plan ? { firstPlan: plan } : {}) }),
      airborne: () => w.loop.state.gliding || !w.loop.state.onGround,
      waitTicks: (n) => w.loop.waitTicks(n),
      log: w.log,
    });
    under = p;
    w.processes.add(p);
    const r = await p.result;
    under = undefined;
    return { ...r, at: r.at ?? { ...w.loop.state.pos } };
  };
  const waitLoaded = async (points: readonly Vec3[], timeoutMs: number): Promise<boolean> => {
    const t0 = Date.now();
    for (;;) {
      if (points.every((p) => w.loaded(Math.floor(p.x) >> 4, Math.floor(p.z) >> 4))) return true;
      if (Date.now() - t0 > timeoutMs || stopped) return false;
      await w.loop.waitTicks(5);
    }
  };
  const ex = new CorridorExecutor({
    provider,
    position: () => (w.loop.state.ready === false ? undefined : { ...w.loop.state.pos }),
    dim: w.dim,
    solid: w.solid,
    loaded: (x, z) => w.loaded(x >> 4, z >> 4),
    waitLoaded,
    flySky: w.flySky,
    flyUnder,
    // Track F5b: the proof of a window before its takeoff: the plan from where the body stands, in the route worker
    ...(style.prove
      ? {
          proveWindow: async (win: Window): Promise<WindowProof> => {
            const from = { ...w.loop.state.pos };
            const rockets = readKit(w.inventory, w.memory()).rocketsHotbar || readKit(w.inventory, w.memory()).rockets;
            const req = windowRequest(win, from, rockets, { margin: style.stretch?.(win).margin ?? win.margin, maxMs: style.prove!.maxMs, maxNodes: style.prove!.maxNodes });
            const p = await w.plan(req);
            w.log.info(`corridor: the proof of the window to ${Math.floor(win.end.x)} ${Math.floor(win.end.y)} ${Math.floor(win.end.z)}: ${p.complete ? 'complete' : `partial (${p.why ?? '?'})`} ${p.reached}/${win.goals.length} goals, ${p.ticks} ticks, ${p.rockets} rockets, clearance ${p.clearance.toFixed(2)}, ${p.expanded} expanded in ${p.ms.toFixed(0)} ms`);
            return proofOf(p);
          },
        }
      : {}),
    walk: w.walk,
    stopped: () => stopped,
    log: w.log,
  }, { ...(style.executor ?? {}), ...(corridorUnderFly(w.task) !== undefined ? { underFly: corridorUnderFly(w.task)! } : {}) }); // Track F5b style; Track F5a: the cave e2e's measured runs override
  void watch();
  try {
    const r = await ex.run(goal, label);
    return unsafe ? { ...r, ok: false, reason: `stopped: ${unsafe}` } : r;
  } finally {
    done = true;
    trips.delete(w.task);
    setCorridorAirborne(w.task, () => false);
    // the windows keep the elytra on between them; the walk at the end and whatever follows want the chestplate
    if (readKit(w.inventory, w.memory()).elytraWorn) await w.kitOps.wearChestplate().catch(() => undefined);
  }
}

/** The chat line of a finished corridor trip. */
export function corridorEndLine(r: CorridorReport, label: string): string {
  const legs = r.legs.map((l) => `${l.how} ${l.blocks}`).join(', ');
  const stats = `${r.rockets} rocket${r.rockets === 1 ? '' : 's'}, ${r.cruises} cruise${r.cruises === 1 ? '' : 's'}, ${r.windows} underground${r.bailouts ? ` (${r.bailouts} bailed out)` : ''}, ${r.walks} walk${r.walks === 1 ? '' : 's'}, ${r.replans} re-plan${r.replans === 1 ? '' : 's'}, ${r.seconds} s`;
  return r.ok ? `arrived at ${label} along a corridor (${legs}); ${stats}` : `fly: the corridor to ${label} failed: ${r.reason ?? '?'} (${legs || 'no legs'}); ${stats}`;
}
