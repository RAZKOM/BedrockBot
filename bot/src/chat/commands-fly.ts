// Elytra flight commands (wave 11, Track AU; docs/flight.md), owner-only like every command:
//   !fly <x y z> | <waypoint> | <player> | home    fly there and land on it (a user process, tasks/process/fly.ts)
//   !fly stop | !land                              land now on the nearest safe ground
//   !fly status                                    the kit (elytra uses, rockets, the box) and the flight in progress
//   !fly box [<slot>|none]                         name the fireworks box (any shulker box in that inventory slot)
// and the automatic flight: `!come` and `!goto` fly instead of walking when the target is more than
// `flyMin` blocks away, the kit is ready and `autoFly` is on (the PveController's `walk` and `come`
// are wrapped here, the Track AT way); in the Nether only under a clear ceiling along the line.
// Registered once from tasks/registry.ts; the FlightProcess (control in the air, above flee) is
// added to the manager here.
import type { Vec3 } from '../connection/types.ts';
import { FlightController, skyQuery } from '../skills/fly/controller.ts';
import { glideKitReady, jumpTakeoff, ledgeTakeoff, planGlideDown, smallPlatform, verticalTakeoff, type Ledge, type SimDeps } from '../skills/fly/glide.ts'; // Track BH
import { elytraWornLimit, flightKitMemoryOf, kitLine, kitReady, readKit, ROCKET, SupplyWatch } from '../skills/fly/kit.ts';
import { restockFromBoxes, supplyOf } from '../skills/supply/supply.ts';
import { FlightKitOps } from '../skills/fly/kitops.ts';
import { APPROACH_HEIGHT, columnsAlong, cruiseHeight, flightSeconds, hdist, takeoffSky, walkMinutes, type CellQuery, type LandingTarget, type SkyCheck } from '../skills/fly/plan.ts';
import { pathBlocks, probeOpenSky, probePath } from '../skills/home/reach.ts'; // Track AU2: the walk from a landing cell to the goal
import { probeNavOf } from '../skills/combat/pathReach.ts';
import { findLanding, isHazardName, isLiquidName, stillLandable, WET_ABOVE, type BlockLookup, type LandingPlan, type ProbeOutcome } from '../skills/fly/landing.ts'; // Track BF
import { TerrainMemo, type TerrainColumn } from '../skills/fly/terrain.ts'; // Track BL
import type { RouteGrid } from '../skills/fly/route/grid.ts'; // Track F3
import { planTakeoffRoute, type TakeoffRoute } from '../skills/fly/route/takeoff.ts'; // Track F3
import { RoutePlannerClient } from '../skills/fly/route/worker.ts'; // Track F3
import { preferSite, RECHECK_EVERY_MS, RecheckState, SITE_BUDGET_MS, SITE_PROBES, SITE_SIMS, siteCandidates } from '../skills/fly/sites.ts'; // Track BL
import type { Goal, GotoOptions, SkillResult } from '../skills/types.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import { FlightProcess, FlyProcess, landingLine, targetFromPlan, type FlyOutcome, type FlyTarget } from '../tasks/process/fly.ts';
import { PRIORITY } from '../tasks/process/manager.ts';
import { waypointStoreOf, waypointGoal } from './commands-nav.ts';
import { survivalKitOf } from './commands-survival.ts';
import { NETHER, OVERWORLD } from '../world/dimension.ts';
import type { Containers } from '../world/containers.ts';
import type { Logger } from '../log.ts';
import { corridorAirborne, corridorProviderOf, corridorWanted } from '../skills/fly/corridor/registry.ts'; // Track F4b
import type { StepOutcome } from '../skills/fly/corridor/executor.ts'; // Track F4b
import { corridorEndLine, runCorridorTrip, stopCorridorTrip, type CorridorWiring } from './commands-corridor.ts'; // Track F4b

export const FLY_COMMANDS = ['fly', 'land'] as const;

/** Track BF: one probe plan of the landing search (nodes, ms) and the whole search's time budget (ms). */
export const LAND_PROBE_NODES = 6000;
export const LAND_PROBE_MS = 400;
export const LAND_BUDGET_MS = 6000;
/** Track BH: open-sky cells probed per leg of a walk out (each LAND_PROBE_NODES / LAND_PROBE_MS) before the plain `xz` leg. */
export const LEG_PROBES = 6;
/**
 * Track CA: the walk out's first leg is the nearest open sky by walking (`probeOpenSky`), not a cell on
 * the straight line: from the foot of a mineshaft the line's cell is over the bot's head and the only way
 * to it is up the shaft and back out (the owner, 2026-11-06). An exit nearer than this (path blocks) is
 * where the bot already stands: the straight-line legs instead.
 */
export const EXIT_MIN_BLOCKS = 4;
/** Track BH: a glide down is simulated to the end within this many blocks (a farther goal: the flight with rockets, its takeoff simulated). */
export const GLIDE_SIM_RANGE = 500;

export interface FlyExtra {
  containers?: Containers | undefined;
  logger?: Logger;
}

/** What the fly commands built for a task (tests, the panel, status). */
export interface FlyControl {
  controller: FlightController;
  kitOps: FlightKitOps;
  supply: SupplyWatch;
  /** The running trip, if any. */
  current(): FlyProcess | undefined;
  /** Start a trip to a target (a user process). */
  start(target: FlyTarget): FlyProcess;
  /** `gliding, 23 rockets` for the panel / status; undefined on the ground without a flight. */
  state(): { gliding: boolean; rockets: number; phase: string | undefined };
}

const controls = new WeakMap<object, FlyControl>();
export function flyControlOf(task: object): FlyControl | undefined {
  return controls.get(task);
}

const fmt = (p: { x: number; z: number; top?: number; y?: number }): string => `${Math.floor(p.x)} ${p.top ?? p.y ?? '?'} ${Math.floor(p.z)}`;

/** The reply line for a finished trip. */
export function flyEndLine(r: FlyOutcome): string {
  const rep = r.report;
  const at = rep?.landedAt ? `${rep.landedAt.x.toFixed(1)} ${rep.landedAt.y.toFixed(0)} ${rep.landedAt.z.toFixed(1)}` : '?';
  const stats = rep ? `${rep.rockets} rocket${rep.rockets === 1 ? '' : 's'}, ${rep.goArounds} go-around${rep.goArounds === 1 ? '' : 's'}, ${r.seconds} s` : `${r.seconds} s`;
  if (r.ok) return `landed at ${at}, ${rep?.off?.toFixed(1) ?? '?'} from the aim (${r.target.label}); ${stats}`;
  switch (r.reason) {
    case 'landed_off':
      return `fly: missed ${r.target.label} after ${rep?.goArounds ?? '?'} go-arounds; landed at ${at}, ${rep?.off?.toFixed(0) ?? '?'} blocks from it; ${stats}`;
    case 'stopped':
      return `landed (stopped) at ${at}; ${stats}`;
    case 'health':
      return `landed (health low) at ${at}; ${stats}`;
    case 'elytra_worn':
      return `landed (the elytra is worn) at ${at}; ${stats}`;
    case 'no_rockets':
      return `landed (out of rockets) at ${at}, ${rep?.off?.toFixed(0) ?? '?'} blocks short of ${r.target.label}; ${stats}`;
    case 'no_glide':
      return 'fly: the server did not let me glide (is the elytra on my back?)';
    case 'lost':
      return `landed (lost) at ${at}; ${stats}`;
    case 'roof':
      return `landed (no open sky ahead: a roof) at ${at}; walk outside first; ${stats}`;
    case 'no_landing':
      return `landed on the nearest dry ground at ${at} (no landing near ${r.target.label}); ${stats}`;
    default:
      return r.reason?.startsWith('fly: ') ? r.reason : `fly: ${r.reason ?? 'failed'}`;
  }
}

export function registerFlyCommands(d: CommandDeps, extra: FlyExtra = {}): FlyControl | undefined {
  const { world, mobility: mob, processes, skills, pve, task } = d;
  if (!world || !mob || !processes || !skills || !pve) {
    for (const name of FLY_COMMANDS) d.chat.register({ name, help: '(needs walking)', run: ({ reply }) => reply(d.needsWalking(name)) });
    return undefined;
  }
  const log = extra.logger ?? d.log;
  const loop = mob.loop;
  const inv = world.inventory;
  const memory = () => flightKitMemoryOf(task);
  const position = (): Vec3 | undefined => (loop.state.ready ? loop.state.pos : undefined);

  /** The highest solid block of a column: the world model (loaded), else the cache; `fromY` (Track AU2) looks down from there (under a roof the roof is not the ground). */
  const skyTop = (x: number, z: number, fromY?: number): number | undefined => {
    const p0 = position();
    const from = Math.min(319, Math.floor(fromY ?? (p0?.y ?? 64) + 80));
    if (fromY === undefined && world.blockAt({ x, y: from, z })?.solid) {
      // the cell at `from` already solid (a mountain more than 80 above, the bot deep underground): that is the
      // inside of the mass, not its top (Track AU2 review): the highest known solid up to the world's top, the
      // cells the model has not received skipped; `from` itself when everything above is known air
      let unknownAbove = false;
      for (let y = 319; y > from; y--) {
        const b = world.blockAt({ x, y, z });
        if (b === undefined) unknownAbove = true;
        else if (b.solid) return y;
      }
      return unknownAbove ? world.cache?.columnTop(x, z) : from;
    }
    let known = false;
    for (let y = from; y >= -64; y--) {
      const b = world.blockAt({ x, y, z });
      if (b === undefined) {
        if (known) return undefined;
        break;
      }
      known = true;
      if (b.solid) return y;
    }
    return fromY === undefined ? world.cache?.columnTop(x, z) : undefined;
  };
  /** Track BF: a liquid in the body's cells over a column top (the live model, else the cache's stand-ins): the sea floor is no ground. */
  const wetAbove = (x: number, z: number, top: number): boolean => {
    for (let y = top + 1; y <= top + WET_ABOVE; y++) {
      const b = world.blockAt({ x, y, z }) ?? world.cache?.blockAt(x, y, z);
      if (b && isLiquidName(b.name)) return true;
    }
    return false;
  };
  /**
   * Safe ground for a landing: a known column whose top is a plain solid block with level neighbours (within a block: neither
   * a 1-wide column nor the bottom of a hole); Track BF: and dry (no liquid in the body's cells: the Realm's flight "landed" on
   * the sea floor under 15 blocks of water, the highest solid of its column).
   */
  const groundAt = (x: number, z: number, fromY?: number): number | undefined => {
    const top = skyTop(x, z, fromY);
    if (top === undefined) return undefined;
    const b = world.blockAt({ x, y: top, z });
    if (b && isHazardName(b.name)) return undefined;
    // Track BH: never a canopy (the Realm, 2026-10-31: a `roof` end on oak leaves left the body prone in the tree): the open ground beyond or under it
    if (b && /leaves|azalea|vine/.test(b.name)) return undefined;
    if (wetAbove(x, z, top)) return undefined;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const t = skyTop(x + dx, z + dz, fromY);
      if (t !== undefined && Math.abs(t - top) > 1) return undefined; // a 1-wide column, or a hole (Track AU2: a goal 3 under the floor is not landed in)
    }
    return top + 1;
  };
  /** Track AU2: a cell of the world model for the sky check (true = solid, false = air, undefined = not loaded). */
  const cell: CellQuery = (x, y, z) => {
    const b = world.blockAt({ x, y, z });
    return b === undefined ? undefined : b.solid;
  };
  /** Track AU2: open sky over a landing cell: no loaded solid within 20 blocks above the feet. */
  const openAbove = (x: number, z: number, feet: number): boolean => {
    for (let y = feet; y <= feet + 20; y++) if (cell(x, y, z) === true) return false;
    return true;
  };
  /** Track AU2: a landable cell: safe ground whose top is the block under `feet` (within a block) with open sky above. */
  const landable = (x: number, z: number, feet?: number): number | undefined => {
    const top = groundAt(x, z);
    if (top === undefined) return undefined;
    if (feet !== undefined && Math.abs(top - feet) > 1.5) return undefined;
    return openAbove(x, z, top) ? top : undefined;
  };
  /** Track BF: the live world model for the landing search (undefined = not loaded; the cache never counts). */
  const look: BlockLookup = (x, y, z) => world.blockAt({ x, y, z });
  // Track F3 (docs/flight.md "Route landings and takeoffs"): the route planner: the grid over the live model (unknown =
  // solid, the sky check's rule), the search in the worker (RoutePlannerClient, the 0023 pattern: an in-thread search of
  // 300 ms stalled the loop 6 ticks on bds-fly3), off with `flyRoute off`
  const routeGrid: RouteGrid = { solid: (x, y, z) => world.blockAt({ x, y, z })?.solid ?? true };
  const routeClient = new RoutePlannerClient({ log });
  const routePlanner = routeClient.plannerOver(routeGrid);
  const routeOn = (): boolean => String(d.settings.get('flyRoute')) !== 'off';
  /**
   * Track BF (docs/flight.md "Landing v3"): the landing for a walk to `goal` (landing.ts findLanding): only
   * live cells, only dry ground, only a cell with a confirmed walking path (a bounded probe plan from its
   * feet, no digging or pillars), overhang cells with a simulated corridor approach; `exact` (the half
   * width) lands on the goal itself when it is landable (`!fly <x y z>`). The compact line goes to the log.
   */
  const landingFor = async (goal: Vec3, label: string, exact: number | undefined): Promise<LandingPlan> => {
    const nav = probeNavOf(pve.mover);
    const target = { type: 'near' as const, p: { x: goal.x + 0.5, y: goal.y, z: goal.z + 0.5 }, r: 1.5 };
    const probe = nav
      ? async (from: Vec3): Promise<ProbeOutcome> => {
          const r = await probePath(nav, target, from, { nodes: LAND_PROBE_NODES, ms: LAND_PROBE_MS, noLongFalls: true });
          if (!r) return { status: 'nostart' };
          if (r.status === 'found') return { status: 'found', blocks: pathBlocks(r.path) };
          return r.status === 'none' ? { status: 'none' } : { status: 'limited' };
        }
      : undefined;
    const plan = await findLanding(
      goal,
      label,
      {
        look,
        obstacle: (x, y, z) => world.blockAt({ x, y, z })?.solid === true,
        ...(probe ? { probe } : {}),
        dryGround: (x, z) => landable(x, z),
        yieldNow: () => new Promise((r) => setImmediate(r)),
        // Track F3: the route planner for a precision goal the brake cannot land (a slot 2 high, a hole, a 1 x 1 shaft)
        ...(routeOn() ? { route: { grid: routeGrid, plan: routePlanner, rockets: Math.min(4, Math.max(2, readKit(inv, memory()).rocketsHotbar)) } } : {}),
      },
      {
        radius: d.settings.get('flyLandSearch'),
        headroom: d.settings.get('flyHeadroom'),
        maxUnder: d.settings.get('flyOverhangDepth'),
        probes: d.settings.get('flyLandProbes'),
        budgetMs: LAND_BUDGET_MS,
        style: String(d.settings.get('flyLandStyle')) as 'auto' | 'flare' | 'brake', // Track F1: the precision goal, the brake's corridors
        ...(exact !== undefined ? { exact } : {}),
        ...(position() ? { from: position()! } : {}), // Track F3: a route landing comes in from the body's side
      },
    );
    log.info(`fly: ${plan.line}`);
    return plan;
  };
  const cellOk = (c: { x: number; z: number; feet: number }): boolean => stillLandable(look, c, d.settings.get('flyHeadroom'));

  /**
   * Track BL (docs/flight.md "Terrain-safe cruise"): a column's highest solid block and where it came from:
   * the live model when the chunk is loaded (subchunks not received above a solid count as unknown: the
   * cache's top, when higher, is taken), else the world cache, else unknown. Overworld only (the Nether's
   * bedrock roof is no terrain to fly over: its flights keep the ceiling check).
   */
  const terrainColumn = (x: number, z: number): TerrainColumn => {
    if (dim() !== OVERWORLD) return { top: undefined, src: 'unknown' };
    if (typeof world.isLoaded === 'function' && !world.isLoaded(x >> 4, z >> 4)) {
      const t = world.cache?.columnTop(x, z);
      return t === undefined ? { top: undefined, src: 'unknown' } : { top: t, src: 'cache' };
    }
    let unknownAbove = false;
    for (let y = 319; y >= -64; y--) {
      const b = world.blockAt({ x, y, z });
      if (b === undefined) {
        unknownAbove = true;
        continue;
      }
      if (b.solid) return { top: unknownAbove ? Math.max(y, world.cache?.columnTop(x, z) ?? y) : y, src: 'live' };
    }
    return { top: -65, src: 'live' };
  };
  const terrain = new TerrainMemo(terrainColumn);
  // the memo forgets a chunk's columns when the chunk (or one of its subchunks) arrives
  (world.chunks as Partial<typeof world.chunks> | undefined)?.onColumnLoaded?.((cx, cz) => terrain.invalidateChunk(cx, cz));
  (world.chunks as Partial<typeof world.chunks> | undefined)?.onSection?.((col) => terrain.invalidateChunk(col.cx, col.cz));
  /** Track BL, the crash notes: what the model believes about a cell (live, else unknown with the cache's view). */
  const describeCell = (x: number, y: number, z: number): string => {
    const b = world.blockAt({ x, y, z });
    if (b) return `live ${b.name.replace(/^minecraft:/, '')}`;
    const loaded = typeof world.isLoaded === 'function' && world.isLoaded(x >> 4, z >> 4);

    const c = world.cache?.blockAt(x, y, z);
    const top = world.cache?.columnTop(x, z);
    return `unknown (${loaded ? 'its subchunk not received' : `chunk ${x >> 4} ${z >> 4} not loaded`}; cache: ${c ? `${c.name.replace(/^minecraft:/, '')}, column top ${top ?? '?'}` : 'nothing'})`;
  };
  const controller = new FlightController({
    loop,
    queue: (n, p) => d.conn.queue(n as never, p as never),
    inventory: inv,
    hotbar: pve.hotbar,
    entities: world.entityTracker,
    health: () => world.self.health,
    elytraLeft: () => readKit(inv, memory()).elytraLeft,
    groundAt,
    skyTop,
    sneakLanding: () => d.settings.get('flySneakLand') === true,
    terrain: { query: terrain.query, tick: () => terrain.tick() }, // Track BL
    cachedSolid: (x, y, z) => world.cache?.blockAt(x, y, z)?.solid === true,
    describeCell,
    log,
  });
  // Track BH: the ledge takeoff's step-off is a fall the flight means: Track BI's clutch never arms while a flight runs
  const falls = (mob.skills as { falls?: { intended: () => boolean } } | undefined)?.falls;
  if (falls) falls.intended = () => controller.active || corridorAirborne(task); // Track F4b: a corridor window in the air
  const kit = survivalKitOf(task);
  const containers = extra.containers;
  const kitOps = new FlightKitOps({
    inventory: inv,
    armour: kit?.armour ?? { wear: () => Promise.resolve(false), worn: () => [null, null, null, null] },
    requests: kit?.requests ?? { withScreen: (fn) => fn() },
    move: (src, dst, n) => containers?.move(src, dst, n) ?? Promise.resolve({ ok: false, reason: 'no containers' }),
    skills: {
      open: (p) => skills.open(p),
      closeContainer: (v) => skills.closeContainer(v),
      place: (p, o) => skills.place(p, o),
      dig: (p) => skills.dig(p),
      collect: (r, t, o) => skills.collect(r, t, o),
      take: (v, s, n, prefer) => skills.chest?.take(v, s, n, prefer) ?? Promise.resolve({ ok: false, reason: 'no containers', moved: 0 }),
    },
    blockAt: (p) => world.blockAt(p),
    position,
    waitTicks: (n) => loop.waitTicks(n),
    memory,
    log,
  });
  const supply = new SupplyWatch();
  processes.add(new FlightProcess(controller));
  let current: FlyProcess | undefined;
  /**
   * `adopt`: take over the flight in the air for this target (FlyProcess.adopt) instead of a takeoff; the trip before it hands over.
   * `home`: the trip home (the returnHome wrapper below): the FlyProcess runs as the home return (`home`, auto, PRIORITY.home).
   */
  const start = (target: FlyTarget, o: { adopt?: { cruiseY?: number }; home?: boolean } = {}): FlyProcess => {
    if (!o.adopt) terrain.clear(); // Track BL: a flight reads the columns afresh (a taken-over flight keeps what it read)

    const p = new FlyProcess(target, {
      controller,
      kitOps,
      inventory: inv,
      memory,
      settings: d.settings,
      position,
      skyTop,
      cell,
      landing: landingFor,
      cellOk,
      walkTo: (p) => skills.goto({ type: 'block', p }, {}), // Track BH: to the ledge's edge cell
      prone: () => loop.state.prone === true,
      unprone: () => (skills as { unprone?: () => Promise<{ ok: boolean; dug: string[]; why?: string }> }).unprone?.() ?? Promise.resolve({ ok: false, dug: [], why: 'no digging' }),
      say: (m) => d.chat.say(m),
      restock: (item, n) => restockFromBoxes(d.task, item, n),
      ...(routeOn() ? { route: { grid: routeGrid, plan: routePlanner } } : {}), // Track F3
      waitTicks: (n) => loop.waitTicks(n),
      supply,
      log,
    }, o.home ? { name: 'home', kind: 'auto', priority: PRIORITY.home } : {});
    if (o.adopt) {
      current?.handOver(); // replaced below without landing: the flight is this trip's now
      p.adopt(o.adopt.cruiseY);
    }
    current = p;
    processes.add(p);
    void p.result.finally(() => {
      if (current === p) current = undefined;
    });
    return p;
  };
  const control: FlyControl = {
    controller,
    kitOps,
    supply,
    current: () => current,
    start,
    state: () => ({ gliding: loop.state.gliding, rockets: readKit(inv, memory()).rocketsHotbar, phase: controller.status().phase }),
  };
  controls.set(task, control);

  // ---- the automatic flight: !come and !goto over flyMin ----------------------------------------
  const dim = (): number => world.self.dimension;
  /** The Nether: every known column along the line must leave the cruise height clear (unknown columns: walk). */
  const ceilingClear = (from: Vec3, target: LandingTarget): boolean => {
    const cz = cruiseHeight(from, target, skyTop, { clearance: d.settings.get('flyClearance'), margin: d.settings.get('flyMargin'), maxClimb: d.settings.get('flyMaxClimb') });
    let unknown = 0;
    const cols = columnsAlong(from, target);
    for (let i = 0; i < cols.length; i += 4) {
      const c = cols[i]!;
      let known = false;
      for (let y = Math.floor(cz.y); y <= Math.floor(cz.y) + 3; y++) {
        const b = world.blockAt({ x: c.x, y, z: c.z });
        if (b === undefined) continue;
        known = true;
        if (b.solid) return false;
      }
      if (!known) unknown++;
    }
    return unknown <= cols.length / 8;
  };
  /** Track AU2: the sky over the takeoff towards `target` from here (the FlyProcess checks again before it jumps). */
  const skyHere = (from: Vec3, target: LandingTarget) => {
    const cz = cruiseHeight(from, target, skyTop, { clearance: d.settings.get('flyClearance'), margin: d.settings.get('flyMargin'), maxClimb: d.settings.get('flyMaxClimb') });
    return takeoffSky(from, target, cz.y, d.settings.get('flyTakeoffRun'), cell);
  };
  /**
   * Track BH: the world for the flight simulations (unknown cells are air, as in the flight's own skyQuery).
   * Track BL: `strict` (a takeoff of a flight with rockets) adds the terrain columns: the simulated climb
   * keeps the terrain floor, and its climbing turn into terrain the live model does not know is a hit.
   */
  const simDeps = (strict = false): SimDeps & { cell: CellQuery } => ({
    world: loop.world ? skyQuery(loop.world) : { solidAt: (x, y, z) => cell(x, y, z) ?? false },
    groundAt,
    skyTop,
    cell,
    yieldNow: () => new Promise((r) => setImmediate(r)),
    ...(strict && dim() === OVERWORLD ? { terrain: terrain.query } : {}),
  });
  /**
   * Track BH (docs/flight.md "Ledge takeoff"): a ledge of the start's platform to step off instead of the
   * jump, when the jump takeoff is refused (a roof over the start: an overhang, a blocked run) or the start
   * is a small platform; its takeoff simulated with the flight's options and rockets. Undefined: none (or
   * not wanted: the jump takeoff is fine).
   */
  const ledgeFor = async (from: Vec3, target: LandingTarget, sky: SkyCheck, rockets: number, quiet = false): Promise<Ledge | undefined> => {
    if (!d.settings.get('flyLedgeTakeoff')) return undefined;
    const small = smallPlatform(cell, from);
    if (sky.ok && !small) return undefined;
    const cz = cruiseHeight(from, target, skyTop, { clearance: d.settings.get('flyClearance'), margin: d.settings.get('flyMargin'), maxClimb: d.settings.get('flyMaxClimb') });
    const why = sky.ok ? 'a small platform' : sky.ahead === 0 ? `a roof ${sky.above} up` : `the run blocked ${sky.ahead} ahead`;
    const r = await ledgeTakeoff(simDeps(true), from, target, { cruiseY: cz.y, margin: d.settings.get('flyMargin'), goArounds: d.settings.get('flyGoArounds') }, rockets);
    if (!quiet) log.info(`fly: ledge takeoff (${why}): ${r.line}`);
    return r.ledge;
  };
  /**
   * The vertical takeoff (glide.ts verticalTakeoff): straight up the open column over the bot, then the climb
   * from above the trees or walls around it. Tried when the jump takeoff is refused on every heading, and when
   * the sky check refused for the 3 x 3 or the run (not for a roof right over the head).
   */
  const verticalFor = async (from: Vec3, target: LandingTarget, rockets: number, quiet = false): Promise<{ vertical: number; takeoffYaw: number } | undefined> => {
    if (!d.settings.get('flyVerticalTakeoff')) return undefined;
    const cz = cruiseHeight(from, target, skyTop, { clearance: d.settings.get('flyClearance'), margin: d.settings.get('flyMargin'), maxClimb: d.settings.get('flyMaxClimb') });
    const r = await verticalTakeoff(simDeps(true), from, target, { cruiseY: cz.y, margin: d.settings.get('flyMargin'), goArounds: d.settings.get('flyGoArounds') }, rockets, d.settings.get('flyTakeoffRun'));
    if (!quiet) log.info(`fly: vertical takeoff: ${r.line}`);
    return r.top !== undefined && r.yaw !== undefined ? { vertical: r.top, takeoffYaw: r.yaw } : undefined;
  };
  /**
   * Track F3 (docs/flight.md "Route landings and takeoffs"): the route takeoff (route/takeoff.ts): the air around
   * the start flooded for the nearest cells under open sky, a plan from standing to one of them searched in the
   * worker; the last step of the chain before the walk-out legs (out of a hole, a low room, a stack's inner
   * platform when no ledge is clear). Undefined: no exit, or no plan (the line says).
   */
  const routeTakeoffFor = async (from: Vec3, target: LandingTarget, rockets: number, quiet = false): Promise<{ routeTakeoff: TakeoffRoute; takeoffYaw: number } | undefined> => {
    if (!routeOn()) return undefined;
    const r = await planTakeoffRoute(routeGrid, from, target, { rockets: Math.min(4, Math.max(1, rockets)) }, routePlanner);
    if (!quiet) log.info(`fly: route takeoff: ${r.exits} exit${r.exits === 1 ? '' : 's'} under open sky; ${r.tried.length ? r.tried.join('; ') : 'none tried'}`);
    return r.route ? { routeTakeoff: r.route, takeoffYaw: r.route.yaw } : undefined;
  };
  /**
   * Track BH: how this flight takes off: a ledge (ledgeFor), else the jump along the first heading whose
   * simulated climb meets no solid (the sky check's first, then 30 degrees apart: the Realm's takeoff into a
   * tree canopy, 2026-10-31), else straight up the open column over the bot (verticalFor), else (Track F3) a
   * route out through the planner (routeTakeoffFor), else refused with the line (walk out, or a takeoff site).
   */
  const takeoffFor = async (from: Vec3, target: LandingTarget, sky: SkyCheck, rockets: number, quiet = false): Promise<{ ledge?: Ledge; takeoffYaw?: number; vertical?: number; routeTakeoff?: TakeoffRoute } | { refuse: string }> => {
    const ledge = await ledgeFor(from, target, sky, rockets, quiet);
    if (ledge) return { ledge };
    if (!sky.ok) {
      // the 3 x 3 or the run blocked leaves the column over the head (a roof right over it: verticalFor says so at once)
      return (await verticalFor(from, target, rockets, quiet)) ?? (await routeTakeoffFor(from, target, rockets, quiet)) ?? { refuse: sky.line };
    }
    const cz = cruiseHeight(from, target, skyTop, { clearance: d.settings.get('flyClearance'), margin: d.settings.get('flyMargin'), maxClimb: d.settings.get('flyMaxClimb') });
    const yaws = [0, 30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180].map((o) => sky.yaw + o);
    // Track BL: any heading (the climbing turn back towards the goal is part of the simulation, its corridor checked with unknown-is-not-air)
    const r = await jumpTakeoff(simDeps(true), from, target, { cruiseY: cz.y, margin: d.settings.get('flyMargin'), goArounds: d.settings.get('flyGoArounds') }, rockets, yaws);
    if (r.yaw !== undefined && r.yaw === sky.yaw) return { takeoffYaw: r.yaw };
    if (!quiet) log.info(`fly: the simulated climb: ${r.line}`);
    if (r.yaw !== undefined) return { takeoffYaw: r.yaw };
    const v = await verticalFor(from, target, rockets, quiet);
    if (v) return v;
    const rt = await routeTakeoffFor(from, target, rockets, quiet);
    if (rt) return rt;
    return { refuse: 'fly: no clear climb from here (the simulated climb meets a solid on every heading: trees, a wall, none straight up and no route out); walk outside first' };
  };
  /** Track BL: a takeoff site to walk to (sites.ts): the cell, the walk there (blocks of the probed path), the flight from there and its takeoff. */
  interface TakeoffSite {
    x: number;
    feet: number;
    z: number;
    walk: number;
    flyDist: number;
    takeoff: { ledge?: Ledge; takeoffYaw?: number };
  }
  type AutoFly = { kind: 'fly'; target: FlyTarget; line: string; said?: string | undefined } | { kind: 'site'; site: TakeoffSite; line: string } | { kind: 'walk_out'; roof: string };
  /** Track BL: the refused takeoffs of this task (sites.ts RecheckState: no new try near one for a while). */
  const refusedTakeoffs: { x: number; z: number; at: number }[] = [];
  /**
   * Track BL (docs/flight.md "Takeoff sites"): the takeoff from here is refused: the open-sky cells within
   * flySiteSearch blocks in any direction (sites.ts siteCandidates, cheapest walk + flight first), the takeoff
   * simulated from each (any heading, the climbing turn's corridor with unknown-is-not-air), the walk probed
   * to those that clear; the first whose walk + flight beats walking the whole way by flyPreferRatio wins.
   * Bounded: SITE_SIMS simulations, SITE_PROBES probes, SITE_BUDGET_MS. Undefined site: none (the line says why).
   */
  const takeoffSite = async (from: Vec3, goalTarget: FlyTarget, rockets: number): Promise<{ site?: TakeoffSite; line: string }> => {
    const radius = d.settings.get('flySiteSearch');
    const nav = probeNavOf(pve.mover);
    if (radius <= 0) return { line: 'the site search is off (flySiteSearch 0)' };
    if (!nav) return { line: 'no probe planner' };
    const t0 = Date.now();
    const memo = new RecheckState(refusedTakeoffs);
    // a cell standing on a thin roof or a canopy (air two and three under its top block) is no ground to walk to
    const ground = (x: number, z: number): number | undefined => {
      const f = landable(x, z);
      if (f === undefined || (cell(x, f - 2, z) === false && cell(x, f - 3, z) === false)) return undefined;
      return f;
    };
    const cands = siteCandidates(from, goalTarget, radius, ground, (x, z) => memo.nearRefused({ x: x + 0.5, z: z + 0.5 }, t0) && hdist(from, { x: x + 0.5, z: z + 0.5 }) < 8);
    // a cell beside one whose walk was not found is not probed again (the same pocket)
    const noPath: { x: number; z: number }[] = [];
    const total = hdist(from, goalTarget);
    const ratio = d.settings.get('flyPreferRatio');
    const notes: string[] = [];
    let sims = 0;
    let probes = 0;
    for (const c of cands) {
      if (sims >= SITE_SIMS || probes >= SITE_PROBES || Date.now() - t0 > SITE_BUDGET_MS) break;
      if (!preferSite(total, c.dist, c.flyDist, ratio)) continue;
      if (noPath.some((p) => Math.abs(p.x - c.x) <= 6 && Math.abs(p.z - c.z) <= 6)) continue;
      const at = { x: c.x + 0.5, y: c.feet, z: c.z + 0.5 };
      const name = `${c.x} ${c.feet} ${c.z}`;
      sims++;
      const tk = await takeoffFor(at, goalTarget, skyHere(at, goalTarget), rockets, true);
      if ('refuse' in tk) {
        notes.push(`${name}: no takeoff`);
        continue;
      }
      probes++;
      const r = await probePath(nav, { type: 'near', p: { x: at.x, y: c.feet, z: at.z }, r: 0.5 }, from, { nodes: LAND_PROBE_NODES, ms: LAND_PROBE_MS, noLongFalls: true });
      if (r?.status !== 'found') {
        noPath.push({ x: c.x, z: c.z });
        notes.push(`${name}: no path (${r ? r.status : 'nostart'})`);

        continue;
      }
      const walk = pathBlocks(r.path);
      if (!preferSite(total, walk, c.flyDist, ratio)) {
        notes.push(`${name}: a ${Math.round(walk)}-block walk, not worth it`);
        continue;
      }
      const site: TakeoffSite = { x: c.x, feet: c.feet, z: c.z, walk, flyDist: c.flyDist, takeoff: tk };
      return { site, line: `${cands.length} open-sky cells within ${radius}, ${sims} takeoffs simulated, ${probes} walks probed in ${Date.now() - t0} ms: ${name} (${Math.round(walk)} blocks walk, ${tk.ledge ? `a ledge heading ${Math.round(tk.ledge.yaw)}` : `heading ${Math.round(tk.takeoffYaw ?? 0)}`})${notes.length ? `; ${notes.join(', ')}` : ''}` };
    }
    return { line: `${cands.length} open-sky cells within ${radius}, ${sims} takeoffs simulated, ${probes} walks probed in ${Date.now() - t0} ms: none worth it${notes.length ? ` (${notes.join(', ')})` : ''}` };
  };
  /**
   * Track BF: the flight's target for a goal (the landing plan: the goal itself, a confirmed cell, the
   * nearest dry ground, or the goal held high while its ground is not loaded) and the reply line.
   */
  const planFlight = async (from: Vec3, goalBlock: Vec3, label: string, half: number, exact: boolean): Promise<{ target: FlyTarget; line: string; said: string | undefined }> => {
    const plan = await landingFor(goalBlock, label, exact ? half : undefined);
    const target = targetFromPlan(plan, { label, goal: goalBlock, half, ...(exact ? { exact: half } : {}) });
    const distance = hdist(from, { x: goalBlock.x + 0.5, z: goalBlock.z + 0.5 });
    const walk = plan.kind === 'cell' || plan.kind === 'fallback' ? plan.walk : 0;
    const line = walk > 0 ? `flying ${Math.round(hdist(from, target))} blocks to ${Math.round(walk)} blocks from ${label}, then walking` : `flying (${Math.round(distance)} blocks; walking would be ~${Math.round(walkMinutes(distance))} min)`;
    return { target, line, said: plan.kind === 'fallback' ? landingLine(target, walk) : undefined };
  };
  /**
   * Fly instead of walking? `fly`: the landing target (the goal when it is landable, else the nearest
   * landable cell within flyLandSearch: fly-then-walk) and the reply line; `walk_out` (Track AU2): the
   * flight would be worth it but the sky over the start is closed: walk towards the goal and try the
   * takeoff again every flyRetryBlocks; undefined: walk.
   */
  const autoFly = async (goalBlock: Vec3, label: string, half: number, o: { site?: boolean; quiet?: boolean } = {}): Promise<AutoFly | undefined> => {
    if (!d.settings.get('autoFly')) return undefined;
    const from = position();
    if (!from || controller.active) return undefined;
    const goalTarget: FlyTarget = { x: goalBlock.x + 0.5, z: goalBlock.z + 0.5, top: goalBlock.y, half, label };
    const distance = hdist(from, goalTarget);
    if (distance <= d.settings.get('flyMin')) return undefined;
    const k = readKit(inv, memory());
    const boxed = supplyOf(d.task)?.carried(ROCKET) ?? 0; // rockets in the other carried boxes come out before the takeoff
    if (!kitReady(k, d.settings.get('toolWearLimit'), boxed).ok) return undefined;
    if (k.rockets < d.settings.get('fireworksMin') && k.boxRockets === 0 && boxed === 0) return undefined;
    if (dim() !== OVERWORLD && !(dim() === NETHER && ceilingClear(from, goalTarget))) return undefined;
    // the sky first (cheap); the landing cell (up to six probe plans) only when a takeoff is possible at all
    const sky = skyHere(from, goalTarget);
    // Track BH: a ledge takeoff where the jump takeoff is refused (an overhang, a blocked run) or the start is a small platform
    const tk = await takeoffFor(from, goalTarget, sky, k.rocketsHotbar || k.rockets, o.quiet);
    if ('refuse' in tk) {
      refusedTakeoffs.push({ x: from.x, z: from.z, at: Date.now() });
      // Track BL: a takeoff site within walking distance (any direction) before the walk out towards the goal
      if (o.site !== false) {
        const s = await takeoffSite(from, goalTarget, k.rocketsHotbar || k.rockets);
        log.info(`fly: the takeoff here is refused (${tk.refuse.replace(/^fly: /, '').replace(/; walk outside first$/, '')}); the takeoff-site search: ${s.line}`);
        if (s.site) return { kind: 'site', site: s.site, line: `walking ${Math.round(s.site.walk)} blocks to take off from ${s.site.x} ${s.site.feet} ${s.site.z}, then flying (${Math.round(distance)} blocks; walking would be ~${Math.round(walkMinutes(distance))} min)` };
      }
      return { kind: 'walk_out', roof: tk.refuse };
    }
    // Track BF: the landing (a cell of the live model with a confirmed walk, or the goal held high until its ground loads)
    const f = await planFlight(from, goalBlock, label, half, false);
    Object.assign(f.target, tk);
    return { kind: 'fly', ...f };
  };
  /** Track BF: the reply line of a flight and, for a landing on unconfirmed dry ground, the line saying so. */
  const sayFlight = (f: { line: string; said?: string | undefined }): void => {
    d.chat.say(f.line);
    if (f.said) d.chat.say(f.said);
  };
  /** After the flight: the walk for the rest (also after a miss or a roof landing), or the flight's failure. */
  const afterFlight = (r: FlyOutcome, walk: () => Promise<SkillResult>): Promise<SkillResult> => {
    if (r.ok || r.reason === 'landed_off' || r.reason === 'roof' || r.reason === 'no_landing' || r.reason?.startsWith('fly: no open sky')) return walk();
    if (r.reason === 'interrupted' || r.reason === 'replaced') return Promise.resolve({ ok: false, reason: 'interrupted' });
    return Promise.resolve({ ok: false, reason: flyEndLine(r) });
  };
  /**
   * A new trip (`!goto`, `!come`, `!fly`) while a flight is in the air: the flight takes the new goal there
   * (the landing found as for any flight, the cruise raised when the new trip needs more) instead of landing
   * first; the trip that started it ends `replaced` and its walk never runs (it used to run after the
   * landing and replace the new walk, so the bot went where it was first sent). Undefined when nothing is
   * in the air (or the flight landed while the landing was looked for): the trip starts from the ground.
   */
  const takeOver = async (goalBlock: Vec3, label: string, half: number, exact: boolean): Promise<FlyProcess | undefined> => {
    const old = current;
    if (!controller.active || old?.phase !== 'flying') return undefined;
    const plan = await landingFor(goalBlock, label, exact ? half : undefined);
    if (!controller.active || current !== old || old.phase !== 'flying') return undefined;
    const target = targetFromPlan(plan, { label, goal: goalBlock, half, ...(exact ? { exact: half } : {}) });
    const from = position();
    const cruiseY = from ? cruiseHeight(from, target, skyTop, { clearance: d.settings.get('flyClearance'), margin: d.settings.get('flyMargin'), maxClimb: d.settings.get('flyMaxClimb') }).y : undefined;
    const p = start(target, { adopt: cruiseY !== undefined ? { cruiseY } : {} });
    const walk = plan.kind === 'cell' || plan.kind === 'fallback' ? plan.walk : 0;
    const dist = from ? Math.round(hdist(from, target)) : undefined;
    if (p.retargeted) d.chat.say(`flying on to ${label}${dist !== undefined ? ` (${dist} blocks)` : ''}${walk > 0 ? `, then walking ${Math.round(walk)} blocks` : ''}`);
    else d.chat.say(`fly: too close to the landing to turn now; landing first, then going to ${label}`);
    if (p.retargeted && plan.kind === 'fallback') {
      const line = landingLine(target, walk);
      if (line) d.chat.say(line);
    }
    return p;
  };
  /**
   * The rest of a trip that took over a flight: the walk after the landing as after any flight; a flight
   * that could not be turned (`retargeted` false) landed where it was going, so the trip starts again from
   * the ground (`again`: it may fly again).
   */
  const afterTakeOver = async (p: FlyProcess, again: () => Promise<SkillResult>, walk: () => Promise<SkillResult>): Promise<SkillResult> => {
    const r = await p.result;
    const landed = r.ok || r.reason === 'landed_off' || r.reason === 'roof' || r.reason === 'no_landing';
    if (!p.retargeted && landed) return again();
    return afterFlight(r, walk);
  };
  /**
   * Track AU2: the leg of a walk to open sky: the nearest cell on the way to the goal (within `step`
   * blocks ahead, up to 4 beside the line, nearer first) that stands on its column's top under open sky
   * (`landable`): from a tunnel or a house that is the surface, so the walk comes up, not along. None
   * known: a plain `xz` leg `step` blocks along the line (the surface is not loaded or not landable).
   */
  const openSkyLeg = async (from: Vec3, goalBlock: Vec3, step: number): Promise<{ goal: Goal; tried: string[]; exit?: number }> => {
    const total = hdist(from, { x: goalBlock.x + 0.5, z: goalBlock.z + 0.5 });
    const ux = (goalBlock.x + 0.5 - from.x) / total;
    const uz = (goalBlock.z + 0.5 - from.z) / total;
    // Track BH: every candidate is probed from here first (the Realm, 2026-10-31: the "open-sky cell" was the top of the
    // farm's spawning box, 45 blocks over the platform, and the leg failed at once); at most LEG_PROBES, the nearest first
    const nav = probeNavOf(pve.mover);
    const tried: string[] = [];
    // Track CA: the nearest open sky the bot can walk to (a mineshaft: its top, wherever that is), when it is not right here
    if (nav) {
      const exit = await probeOpenSky(nav, from);
      if ('at' in exit && exit.blocks >= EXIT_MIN_BLOCKS) return { goal: { type: 'block', p: exit.at }, tried, exit: Math.round(exit.blocks) };
      if ('why' in exit) tried.push(`surface:${exit.why}`);
    }
    const seen = new Set<number>();
    for (let i = 4; i <= step; i++) {
      for (const side of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
        const x = Math.floor(from.x + ux * i - uz * side);
        const z = Math.floor(from.z + uz * i + ux * side);
        const top = landable(x, z);
        if (top === undefined || top < from.y - 1) continue;
        const goal: Goal = { type: 'block', p: { x, y: top, z } };
        if (!nav) return { goal, tried };
        const k = x * 65536 + z;
        if (seen.has(k)) continue;
        seen.add(k);
        const r = await probePath(nav, { type: 'near', p: { x: x + 0.5, y: top, z: z + 0.5 }, r: 0.5 }, from, { nodes: LAND_PROBE_NODES, ms: LAND_PROBE_MS, noLongFalls: true });
        if (r?.status === 'found') return { goal, tried };
        tried.push(`${x} ${top} ${z}:${r ? r.status : 'nostart'}`);
        if (tried.length >= LEG_PROBES) return { goal: { type: 'xz', x: Math.floor(from.x + ux * step), z: Math.floor(from.z + uz * step) }, tried };
      }
    }
    return { goal: { type: 'xz', x: Math.floor(from.x + ux * step), z: Math.floor(from.z + uz * step) }, tried };
  };
  /**
   * Track AU2: the sky over the start is closed (indoors, underground, under trees): walk towards the
   * goal in legs of flyRetryBlocks (each to an open-sky cell on the way, `openSkyLeg`) and try the
   * takeoff again after each; `walk` walks the whole way (the goal's own goto / come) when the legs
   * cannot be planned or the flight is never worth it.
   */
  const walkOut = async (goalBlock: Vec3, label: string, half: number, first: { roof: string }, walk: () => Promise<SkillResult>, legWalk: (leg: Goal) => Promise<SkillResult>): Promise<SkillResult> => {
    d.chat.say(`${first.roof.replace(/; walk outside first$/, '')}; walking towards ${label} and taking off outside`);
    log.info(`fly: ${first.roof} -> walking out towards ${label}, a takeoff try every ${d.settings.get('flyRetryBlocks')} blocks`);
    for (let leg = 0; leg < 64; leg++) {
      const from = position();
      if (!from) return walk();
      const step = d.settings.get('flyRetryBlocks');
      const total = hdist(from, { x: goalBlock.x + 0.5, z: goalBlock.z + 0.5 });
      if (total <= Math.max(step, d.settings.get('flyMin'))) return walk();
      const { goal: legGoal, tried, exit } = await openSkyLeg(from, goalBlock, step);
      log.info(`fly: leg ${leg + 1} to ${exit !== undefined && legGoal.type === 'block' ? `the nearest open sky by walking ${legGoal.p.x} ${legGoal.p.y} ${legGoal.p.z} (${exit} blocks)` : legGoal.type === 'block' ? `the open-sky cell ${legGoal.p.x} ${legGoal.p.y} ${legGoal.p.z}` : legGoal.type === 'xz' ? `${legGoal.x} ${legGoal.z} (no ${tried.length ? 'reachable ' : ''}open-sky cell known ahead)` : 'the goal'}${tried.length ? ` (no path to ${tried.join(', ')})` : ''}`);
      const r = await legWalk(legGoal);
      if (!r.ok) return r.reason === 'interrupted' ? r : walk();
      const again = await autoFly(goalBlock, label, half, { site: false });
      if (again?.kind === 'fly') {
        sayFlight(again);
        return afterFlight(await start(again.target).result, walk);
      }
      if (!again) return walk();
    }
    return walk();
  };
  /** Track BH: the walk ended where the planner has no way on (`unreachable`, `no progress possible`): a glide down may help. */
  const noWay = (r: SkillResult): boolean => !r.ok && ((r as { reason?: string }).reason === 'unreachable' || /no progress|no path/.test((r as { reason?: string }).reason ?? ''));
  /**
   * Track BH (docs/flight.md "Glide down"): a walk to `goalBlock` failed with no way on and the goal is
   * glideDownMinDrop or more below and glideDownMinDistance or more away (a peak, a cliff, a tower, a
   * floating platform): glide down with the elytra to the landing findLanding confirms (dry, a walking
   * path to the goal), stepping off an edge of the platform, when the whole flight simulated from that
   * edge (rockets as carried, none needed) lands on it; then `walk` for the rest. A goal farther than
   * GLIDE_SIM_RANGE (or not loaded) is flown to with rockets from a simulated ledge (or jump) takeoff.
   * Never while fleeing or fighting, never for a goal above; otherwise the walk's failure stands and the
   * owner is told why no glide. The planner's own reason goes into the log line.
   */
  const glideFallback = async (r: SkillResult, goalBlock: Vec3, label: string, half: number, walk: () => Promise<SkillResult>): Promise<SkillResult> => {
    if (!noWay(r) || !d.settings.get('glideDown')) return r;
    const from = position();
    if (!from || controller.active || dim() !== OVERWORLD) return r;
    const busy = processes.active?.name;
    if (busy === 'flee' || busy === 'guard' || busy === 'fire' || busy === 'surface' || pve.combat.target) return r;
    const drop = from.y - goalBlock.y;
    const goalAt = { x: goalBlock.x + 0.5, z: goalBlock.z + 0.5 };
    const dist = hdist(from, goalAt);
    if (drop < d.settings.get('glideDownMinDrop') || dist < d.settings.get('glideDownMinDistance')) return r;
    const k = readKit(inv, memory());
    const wear = d.settings.get('toolWearLimit');
    const kitOk = glideKitReady(k, wear);
    if (!kitOk.ok) {
      if (kitOk.line !== 'no elytra') d.chat.say(`fly: no glide down to ${label}: ${kitOk.line}`);
      return r;
    }
    const navWhy = (pve.mover as { nav?: { lastReport?: { why?: string } } }).nav?.lastReport?.why;
    log.info(`fly: the walk to ${label} ended ${r.ok ? "ok" : r.reason}${navWhy ? ` (${navWhy})` : ''}; the goal is ${drop.toFixed(0)} below and ${dist.toFixed(0)} away: looking for a glide down (${kitLine(k)})`);
    const rockets = k.rocketsHotbar || k.rockets;
    const plan = await landingFor(goalBlock, label, undefined);
    const base = { label, goal: goalBlock, half };
    let target: FlyTarget | undefined;
    let why: string | undefined;
    if ((plan.kind === 'goal' || plan.kind === 'cell') && dist <= GLIDE_SIM_RANGE) {
      const g = await planGlideDown(simDeps(), from, plan.target, { minDrop: d.settings.get('glideDownMinDrop'), minDistance: d.settings.get('glideDownMinDistance'), rockets, flight: { margin: d.settings.get('flyMargin'), goArounds: d.settings.get('flyGoArounds') } });
      log.info(`fly: ${g.line}`);
      if (g.ok) target = { ...targetFromPlan(plan, base), ledge: g.ledge, glide: true };
      else why = g.why;
    } else if (plan.kind === 'fallback' || plan.kind === 'none') {
      why = `no landing near it with a walking path (${plan.kind === 'fallback' ? plan.why : 'no dry ground known'})`;
    } else if (kitReady(k, wear).ok && rockets > 0) {
      // far (or its ground not loaded): a flight with rockets, the landing held until its ground loads, the takeoff simulated
      const t0 = targetFromPlan(plan, base);
      const sky = skyHere(from, t0);
      const tk = await takeoffFor(from, t0, sky, rockets);
      if (!('refuse' in tk)) target = { ...t0, ...tk };
      else why = `no takeoff from here (${tk.refuse.replace(/^fly: /, '').replace(/; walk outside first$/, '')}; no ledge with a clear fall)`;
    } else {
      why = `the goal is ${Math.round(dist)} blocks away, beyond a glide without rockets`;
    }
    if (!target) {
      d.chat.say(`fly: no glide down to ${label}: ${why ?? '?'}`);
      return r;
    }
    const lg = target.ledge;
    d.chat.say(`${target.glide ? 'gliding down' : 'flying'} to ${label} (${Math.round(dist)} blocks, ${Math.round(drop)} down; the walk found no way${lg ? `; stepping off at ${lg.x} ${lg.feet} ${lg.z}` : ''}${target.then ? `; ${target.then}` : ''})`);
    return afterFlight(await start(target).result, walk);
  };
  /**
   * Track BL: carry out an automatic flight's decision: fly from here; walk to the takeoff site and fly
   * from there (the takeoff checked again on arrival: refused, the walk goes on, watched); walk out
   * towards the goal in legs (Track AU2, the fallback when no site is worth it).
   */
  const runAuto = async (f: AutoFly, goal: () => Vec3 | undefined, label: string, half: number, walk: () => Promise<SkillResult>, legWalk: (leg: Goal) => Promise<SkillResult>): Promise<SkillResult> => {
    const g0 = goal();
    if (!g0) return walk();
    if (f.kind === 'walk_out') return walkOut(g0, label, half, f, walk, legWalk);
    if (f.kind === 'fly') {
      sayFlight(f);
      return afterFlight(await start(f.target).result, walk);
    }
    d.chat.say(f.line);
    const s = f.site;
    log.info(`fly: walking ${Math.round(s.walk)} blocks to the takeoff site ${s.x} ${s.feet} ${s.z}, then flying ${Math.round(s.flyDist)} blocks to ${label}`);
    const r = await legWalk({ type: 'block', p: { x: s.x, y: s.feet, z: s.z } });
    if (!r.ok && r.reason === 'interrupted') return r;
    const g = goal() ?? g0;
    const again = r.ok ? await autoFly(g, label, half, { site: false }) : undefined;
    if (again?.kind === 'fly') {
      sayFlight(again);
      return afterFlight(await start(again.target).result, walk);
    }
    const here = position();
    if (here) refusedTakeoffs.push({ x: here.x, z: here.z, at: Date.now() });
    const why = !r.ok ? `the walk there failed (${r.reason ?? '?'})` : again?.kind === 'walk_out' ? again.roof.replace(/^fly: /, '').replace(/; walk outside first$/, '') : 'no flight from there';
    log.info(`fly: no takeoff from the site ${s.x} ${s.feet} ${s.z}: ${why}; walking to ${label}`);
    d.chat.say(`fly: no takeoff from ${s.x} ${s.feet} ${s.z} after all (${why}); walking to ${label}`);
    return watchWalk(goal, label, half, walk, walk, legWalk);
  };
  /** Track BL: a safe place to stop a walk for a takeoff: standing, dry, not on a ladder, a vine or scaffolding. */
  const safeStop = (): boolean => {
    const s = loop.state;
    if (!s.onGround || s.inWater || s.inLava || Math.abs(s.vel.y) > 0.1) return false;
    const at = world.blockAt({ x: Math.floor(s.pos.x), y: Math.floor(s.pos.y), z: Math.floor(s.pos.z) });
    return !at || !/ladder|vine|scaffolding|water|lava/.test(at.name);
  };
  /**
   * Track BL (docs/flight.md "Flight re-check on long walks"): a walk that did not fly (the kit or the rockets
   * missing, the sky closed, no site worth it) looks for a takeoff again while it walks (sites.ts
   * RecheckState: every flyRecheckBlocks blocks walked, when the kit becomes ready, when the walk comes out
   * from under a roof; the cheap gates first, the takeoff and the landing search at most every
   * RECHECK_SEARCH_MS, never near a refused takeoff). A chance found: the walk is stopped at a safe spot
   * (standing, dry, no ladder), the takeoff is checked again from there and the flight (or the walk to its
   * site) goes; else the walk resumes. Never while another process (flee, guard, a fight) has control.
   */
  const watchWalk = async (goal: () => Vec3 | undefined, label: string, half: number, walking: () => Promise<SkillResult>, rest: () => Promise<SkillResult>, legWalk: (leg: Goal) => Promise<SkillResult>): Promise<SkillResult> => {
    const every = d.settings.get('flyRecheckBlocks');
    const from = position();
    const g0 = goal();
    const goalAt = (g: Vec3) => ({ x: g.x + 0.5, z: g.z + 0.5 });
    if (!d.settings.get('autoFly') || every <= 0 || !from || !g0 || hdist(from, goalAt(g0)) <= d.settings.get('flyMin') + every) return walking();
    const res = walking();
    const proc = (processes as { active?: unknown }).active;
    if (!proc || typeof (processes as { stop?: unknown }).stop !== 'function') return res;
    const state = new RecheckState(refusedTakeoffs);
    let found: Exclude<AutoFly, { kind: 'walk_out' }> | undefined;
    let why = '';
    let busy = false;
    let done = false;
    const timer = setInterval(() => {
      if (busy || done || found) return;
      const p = position();
      const g = goal();
      if (!p || !g || processes.active !== proc || controller.active || pve.combat.target) return;
      if (hdist(p, goalAt(g)) <= d.settings.get('flyMin')) return;
      const k = readKit(inv, memory());
      const kit = kitReady(k, d.settings.get('toolWearLimit')).ok && (k.rockets >= d.settings.get('fireworksMin') || k.boxRockets > 0);
      const due = state.due(p, kit, openAbove(Math.floor(p.x), Math.floor(p.z), Math.floor(p.y)), every, Date.now());
      if (!due) return;
      busy = true;
      void (async () => {
        try {
          const f = await autoFly(g, label, half, { quiet: true });
          if (done || !f) return;
          if (f.kind === 'walk_out') {
            state.refused(p, Date.now());
            return;
          }
          // a safe spot to stop (not mid-jump, on a ladder or in water): up to 3 s more of the walk
          for (let i = 0; i < 12 && !safeStop() && !done; i++) await loop.waitTicks(5);
          if (done || !safeStop() || processes.active !== proc) return;
          found = f;
          why = due === 'kit' ? 'the flight kit is ready' : due === 'sky' ? 'out from under the roof' : `${every} blocks on`;
          processes.stop(proc as Parameters<typeof processes.stop>[0], 'replaced');
        } finally {
          busy = false;
        }
      })();
    }, RECHECK_EVERY_MS);
    (timer as { unref?: () => void }).unref?.();
    const r = await res;
    done = true;
    clearInterval(timer);
    if (!found || r.ok) return r;
    const g = goal();
    const here = position();
    if (!g || !here) return rest();
    log.info(`fly: the walk to ${label} stopped at ${fmt(here)} for a flight (${why})`);
    if (found.kind === 'fly') {
      // the takeoff again from where the walk stopped (it walked on while the landing was searched)
      const k = readKit(inv, memory());
      const tk = await takeoffFor(here, found.target, skyHere(here, found.target), k.rocketsHotbar || k.rockets);
      if ('refuse' in tk) {
        state.refused(here, Date.now());
        log.info(`fly: no takeoff where the walk stopped (${tk.refuse}); walking on`);
        return watchWalk(goal, label, half, rest, rest, legWalk);
      }
      delete found.target.ledge;
      delete found.target.takeoffYaw;
      delete found.target.vertical;
      delete found.target.routeTakeoff;
      Object.assign(found.target, tk);
    }
    return runAuto(found, goal, label, half, rest, legWalk);
  };
  const walk0 = pve.walk.bind(pve);
  pve.walk = async (goal: Goal, opts: GotoOptions = {}, label?: string): Promise<SkillResult> => {
    if (goal.type !== 'block') return walk0(goal, opts, label);
    const name = label?.replace(/^walking (to )?/, '') ?? fmt(goal.p);
    const plain = () => walk0(goal, opts, label);
    // Track BH: the walk, and a glide down when it finds no way to a goal far below
    const walkOrGlide = async (): Promise<SkillResult> => glideFallback(await plain(), goal.p, name, 1, plain);
    const legWalk = (leg: Goal) => walk0(leg, opts, `walking to ${name} (to open sky)`);
    const air = await takeOver(goal.p, name, 1, false);
    if (air) return afterTakeOver(air, () => pve.walk(goal, opts, label), plain);
    const f = await autoFly(goal.p, name, 1);
    // Track BL: a walk that does not fly looks for a takeoff again on the way
    if (!f) return watchWalk(() => goal.p, name, 1, plain, plain, legWalk).then((r) => glideFallback(r, goal.p, name, 1, plain));
    return runAuto(f, () => goal.p, name, 1, f.kind === 'walk_out' ? walkOrGlide : plain, legWalk);
  };
  // the trips home the bot makes by itself (dawn, respawn, after a guard fight, after a food or branch mining job): they
  // fly too, over flyMin, as the low-priority home return (the owner: far from home it walked the whole way back)
  const returnHome0 = pve.returnHome.bind(pve);
  pve.returnHome = async (why: string, opts: { timeoutTicks?: number; ifIdle?: boolean } = {}): Promise<SkillResult> => {
    const h = task.home?.get();
    if (!h || controller.active) return returnHome0(why, opts);
    const busy = (): boolean => !!opts.ifIdle && processes.userProcesses().length > 0;
    if (busy()) return { ok: false, reason: 'busy' };
    const goal = { x: Math.floor(h.x), y: Math.floor(h.y), z: Math.floor(h.z) };
    const f = await autoFly(goal, 'home', 1, { site: false, quiet: true });
    if (f?.kind !== 'fly' || controller.active) return returnHome0(why, opts);
    if (busy()) return { ok: false, reason: 'busy' }; // a command came while the landing was looked for
    for (const p of processes.find('home')) processes.stop(p, 'replaced');
    log.info(`${why}: flying home to ${goal.x} ${goal.y} ${goal.z} (${f.line})`);
    const r = await start(f.target, { home: true }).result;
    return afterFlight(r, () => returnHome0(why, { ...opts, ifIdle: false }));
  };
  const come0 = pve.come.bind(pve);
  pve.come = async (name: string, o: { urgent?: boolean } = {}): Promise<SkillResult> => {
    const playerBlock = (): Vec3 | undefined => {
      const feet = pve.playerFeet(name);
      return feet ? { x: Math.floor(feet.x), y: Math.round(feet.y), z: Math.floor(feet.z) } : undefined;
    };
    const block = playerBlock();
    const plain = () => come0(name, o);
    if (!block) return plain();
    const air = await takeOver(block, name, 2, false);
    if (air) return afterTakeOver(air, () => pve.come(name, o), plain);
    const f = await autoFly(block, name, 2);
    const legWalk = (leg: Goal) => walk0(leg, {}, `walking to ${name} (to open sky)`);
    if (!f) return watchWalk(playerBlock, name, 2, plain, plain, legWalk).then((r) => glideFallback(r, block, name, 2, plain));
    return runAuto(f, playerBlock, name, 2, plain, legWalk);
  };


  // ---- status ----------------------------------------------------------------------------------
  const baseLine = task.statusLine?.bind(task);
  task.statusLine = () => {
    const s = control.state();
    return { ...(baseLine?.() ?? { task: task.name }), ...(s.phase ? { flying: s.phase } : {}), ...(s.gliding ? { gliding: 'yes' } : {}) };
  };
  const stop = task.stop.bind(task);
  task.stop = () => {
    controller.dispose();
    void routeClient.stop(); // Track F3: the route worker
    stop();
  };

  // ---- commands ----------------------------------------------------------------------------------
  /** The goal of `!fly`: a block (x y z, a waypoint, home) or a player, the half width of an exact landing on it, the label. */
  interface FlyGoal {
    goal: Vec3;
    half: number;
    label: string;
    player?: string;
  }
  const targetOf = (args: readonly string[], senderName: string | undefined): FlyGoal | { error: string } => {
    if (args.length === 3) {
      const p = d.parseBlock(args);
      if (!p) return { error: 'usage: !fly <x y z> | <waypoint> | <player> | home' };
      return { goal: { x: p.x, y: p.y, z: p.z }, half: 1, label: `${p.x} ${p.y} ${p.z}` };
    }
    if (args.length !== 1) return { error: 'usage: !fly <x y z> | <waypoint> | <player> | home | stop | status | box [<slot>]' };
    const what = args[0]!;
    if (what.toLowerCase() === 'home') {
      const h = task.home?.get();
      if (!h) return { error: 'fly: no home set (!home set)' };
      return { goal: { x: Math.floor(h.x), y: Math.round(h.y), z: Math.floor(h.z) }, half: 2, label: 'home' };
    }
    const w = waypointStoreOf(task)?.get(what);
    if (w) {
      const g = waypointGoal(w);
      if (g.type !== 'block') return { error: `fly: waypoint ${w.name} has no height; set it again where you stand` };
      return { goal: { x: g.p.x, y: g.p.y, z: g.p.z }, half: 1, label: w.name };
    }
    const name = what.toLowerCase() === 'me' ? senderName : what;
    const feet = name ? pve.playerFeet(name) : undefined;
    if (feet && name) return { goal: { x: Math.floor(feet.x), y: Math.round(feet.y), z: Math.floor(feet.z) }, half: 2, label: name, player: name };
    return { error: `fly: no waypoint or player "${what}" (!wp list; a player must be in sight or on the locator bar)` };
  };

  // Track F4b: the corridor trip's ports (chat/commands-corridor.ts): the cruise as `!fly` builds it (an exact cell), the
  // navigator's own walk, the live model, the route grid and the worker's planner
  const corridorSky = async (cell: Vec3, label: string): Promise<StepOutcome> => {
    const from = position();
    if (!from) return { ok: false, reason: 'position unknown' };
    const k = readKit(inv, memory());
    const aim: LandingTarget = { x: cell.x + 0.5, z: cell.z + 0.5, top: cell.y, half: 1 };
    const tk = await takeoffFor(from, aim, skyHere(from, aim), k.rocketsHotbar || k.rockets);
    if ('refuse' in tk) return { ok: false, reason: tk.refuse, at: from };
    const f = await planFlight(from, cell, label, 1, true);
    Object.assign(f.target, tk);
    if (controller.active) return { ok: false, reason: 'already flying', at: from };
    const r = await start(f.target).result;
    for (let i = 0; i < 40 && Math.hypot(loop.state.vel.x, loop.state.vel.z) > 0.003; i++) await loop.waitTicks(1);
    const rep = r.report;
    return { ok: r.ok, ...(r.ok ? {} : { reason: r.reason ?? 'failed' }), at: { ...loop.state.pos }, rockets: rep?.rockets ?? 0, corrections: rep?.corrections ?? 0, held: rep?.held ?? 0 };
  };
  const corridorWiring = (): CorridorWiring => ({
    task,
    loop,
    queue: (n, p) => d.conn.queue(n as never, p as never),
    inventory: inv,
    hotbar: pve.hotbar,
    entities: world.entityTracker,
    memory,
    kitOps,
    processes,
    // the live model, else what the world cache saw (a mouth at the edge of the loaded chunks); the windows are cut by `loaded`
    solid: (x, y, z) => world.blockAt({ x, y, z })?.solid ?? world.cache?.blockAt(x, y, z)?.solid,
    loaded: (cx, cz) => typeof world.isLoaded !== 'function' || world.isLoaded(cx, cz),
    dim,
    health: () => world.self.health, // hotfix 2026-11-06: a death or low health ends the trip
    ...((world.chunks as Partial<typeof world.chunks> | undefined)?.onColumnLoaded ? { columnLoaded: (fn: (cx: number, cz: number) => void) => world.chunks.onColumnLoaded(fn) } : {}),
    grid: routeGrid,
    plan: routePlanner,
    flySky: corridorSky,
    walk: async (cell, label) => {
      const r = await walk0({ type: 'block', p: cell }, {}, label);
      return { ok: r.ok, ...(r.ok ? {} : { reason: r.reason ?? 'failed' }), at: { ...loop.state.pos } };
    },
    log,
  });
  const flyDef: Parameters<typeof d.chat.register>[0] = {
    name: 'fly',
    help: '<x y z> | <waypoint> | <player> | home | stop | status | box [<slot>] (fly there with the elytra and land on it; stop: land now)',
    tier: 'more', // Track AU2: come and goto fly on their own; the front door keeps !come
    group: 'go',
    example: '!fly home',
    auto: 'come and goto fly by themselves over flyMin blocks (autoFly), landing on the nearest landable cell and walking the rest; the flight kit (elytra, rockets, the fireworks box) is never dropped, stashed or unloaded',
    run: (ctx) => {
      const { reply, args, sender } = ctx;
      const sub = args[0]?.toLowerCase();
      if (sub === 'stop') {
        const p = current;
        const trip = stopCorridorTrip(task); // Track F4b: a corridor trip ends after its step in progress
        if (p?.land('stopped')) reply('landing');
        else if (controller.active) {
          controller.landNow('stopped');
          reply('landing');
        } else reply(trip ? 'fly: the corridor trip stops after this step' : 'fly: not flying');
        return;
      }
      if (sub === 'status') {
        const k = readKit(inv, memory());
        const c = controller.status();
        const flight = c.active ? `; flying to ${current?.target.label ?? '?'}: ${c.phase}, ${c.distance !== undefined ? `${Math.round(c.distance)} blocks to go, ` : ''}${c.rockets} rockets used, ${c.goArounds} go-arounds` : current ? `; ${current.status().line}` : '';
        const worn = k.elytraLeft !== undefined && k.elytraLeft <= elytraWornLimit(d.settings.get('toolWearLimit'), k) ? (k.elytraMending ? ' (set aside to be mended: no flights)' : ' (worn: no flights)') : '';
        reply(`fly: ${kitLine(k)}${worn}${memory().namedBoxSlot !== undefined ? `, box named: slot ${memory().namedBoxSlot}` : ''}${flight}`);
        return;
      }
      if (sub === 'box') {
        const m = memory();
        const a = args[1];
        if (a === undefined) {
          const held = inv.selected;
          m.namedBoxSlot = held;
          reply(`fly: the fireworks box is the shulker box in slot ${held} (${inv.slots[held]?.name ?? 'empty now'})`);
          return;
        }
        if (a.toLowerCase() === 'none') {
          m.namedBoxSlot = undefined;
          reply('fly: no named box (any shulker box holding only fireworks counts)');
          return;
        }
        const slot = Number(a);
        if (!Number.isInteger(slot) || slot < 0 || slot > 35) {
          reply('usage: !fly box [<slot 0..35>|none]');
          return;
        }
        m.namedBoxSlot = slot;
        reply(`fly: the fireworks box is the shulker box in slot ${slot} (${inv.slots[slot]?.name ?? 'empty now'})`);
        return;
      }
      const t = targetOf(args, sender.kind === 'player' ? sender.name : undefined);
      if ('error' in t) {
        reply(t.error);
        return;
      }
      // already in the air: the flight takes the new goal there (no landing first); after a landing it could not avoid, `!fly` again from the ground
      if (controller.active && current?.phase === 'flying') {
        void (async () => {
          const p = await takeOver(t.goal, t.label, t.half, true);
          if (!p) {
            reply('fly: the flight is landing; try again once it stands');
            return;
          }
          const r = await p.result;
          const landed = r.ok || r.reason === 'landed_off' || r.reason === 'roof' || r.reason === 'no_landing';
          if (!p.retargeted && landed) {
            void flyDef.run(ctx);
            return;
          }
          if (r.reason === 'interrupted' || r.reason === 'replaced') return;
          reply(flyEndLine(r));
          if (!landed || (r.ok && r.target.cell?.kind === 'goal' && r.report?.onTarget === true)) return;
          const w = t.player ? await come0(t.player) : await walk0({ type: 'block', p: t.goal }, {}, `walking to ${t.label}`);
          if (w.ok) reply(`walked to ${t.label}`);
          else if (w.reason !== 'interrupted') reply(`fly: landed, but the walk to ${t.label} failed (${w.reason ?? 'failed'})`);
        })();
        return;
      }
      const k = readKit(inv, memory());
      const ready = kitReady(k, d.settings.get('toolWearLimit'), supplyOf(d.task)?.carried(ROCKET) ?? 0);
      if (!ready.ok) {
        reply(ready.line);
        for (const line of supply.check(k, d.settings.get('fireworksMin'), d.settings.get('toolWearLimit'))) if (line !== ready.line) reply(line);
        return;
      }
      const from = position();
      if (!from) {
        reply('fly: position unknown');
        return;
      }
      const goalTarget: LandingTarget = { x: t.goal.x + 0.5, z: t.goal.z + 0.5, top: t.goal.y, half: t.half };
      const distance = hdist(from, goalTarget);
      if (dim() === NETHER && !ceilingClear(from, goalTarget)) {
        reply(`fly: the Nether ceiling is too low along the way to ${t.label} (walk: !goto)`);
        return;
      }
      // Track F4b: a long trip to a covered goal (a cave, a chamber) follows the coarse layer's corridor when the task has one
      const provider = corridorProviderOf(task, skills.nav.coarseLayer);
      const top = skyTop(t.goal.x, t.goal.z);
      if (!t.player && provider && corridorWanted(String(d.settings.get('flyCorridor')), provider, distance, top === undefined || top >= t.goal.y)) {
        reply(`flying to ${t.label} along a corridor (${Math.round(distance)} blocks; ${kitLine(k)})`);
        void runCorridorTrip(corridorWiring(), provider, t.goal, t.label).then((r) => reply(corridorEndLine(r, t.label)));
        return;
      }
      // Track AU2: no takeoff under a roof (the owner's indoor flight hit the ceiling three times)
      const sky = skyHere(from, goalTarget);
      // Track BF: the same landing as goto / come (exact on the goal when it is landable, else a confirmed cell
      // near it, held high while its ground is not loaded), then the walk for the rest
      void (async () => {
        // Track BH: a ledge takeoff where the jump is refused (an overhang, a blocked run) or the start is a small platform
        // (and the jump along a heading whose simulated climb is clear: trees, walls)
        const tk = await takeoffFor(from, goalTarget, sky, k.rocketsHotbar || k.rockets);
        if ('refuse' in tk) {
          reply(tk.refuse);
          return;
        }
        const f = await planFlight(from, t.goal, t.label, t.half, true);
        Object.assign(f.target, tk);
        if (controller.active) {
          reply('fly: already flying');
          return;
        }
        const p = start(f.target);
        const walking = f.target.cell && f.target.cell.kind !== 'goal' ? `, then walking ${Math.round(hdist(f.target, goalTarget))} blocks` : '';
        reply(`flying to ${t.label} (${Math.round(distance)} blocks, about ${flightSeconds(distance)} s${walking}; ${kitLine(k)})`);
        if (f.said) reply(f.said);
        const r = await p.result;
        if (r.reason === 'interrupted' || r.reason === 'replaced') return;
        reply(flyEndLine(r));
        // on the goal itself (an exact landing that stood on it): nothing to walk. The server's slide goes on after the
        // settle (bds-fly: 0.6 to 1.0 blocks more, once to a 3x3 platform's edge, held there by the sneak): wait for
        // the body to stop, and walk back onto the goal block when it ended more than 0.8 from its centre
        for (let i = 0; i < 40 && Math.hypot(loop.state.vel.x, loop.state.vel.z) > 0.003; i++) await loop.waitTicks(1);
        const onGoal = r.ok && r.target.cell?.kind === 'goal' && r.report?.onTarget === true && hdist(loop.state.pos, goalTarget) <= 0.8;
        if (onGoal) return;
        const walkable = r.ok || r.reason === 'landed_off' || r.reason === 'roof' || r.reason === 'no_landing';
        if (!walkable) return;
        const w = t.player ? await come0(t.player) : await walk0({ type: 'block', p: t.goal }, {}, `walking to ${t.label}`);
        if (w.ok) reply(`walked to ${t.label}`);
        else if (w.reason !== 'interrupted') reply(`fly: landed, but the walk to ${t.label} failed (${w.reason ?? 'failed'})`);
      })();
    },
  };
  d.chat.register(flyDef);
  d.chat.register({
    name: 'land',
    help: '(land now on the nearest safe ground)',
    group: 'go',
    example: '!land',
    run: ({ reply }) => {
      if (current?.land('stopped') || controller.active) {
        if (controller.active && !current) controller.landNow('stopped');
        reply('landing');
      } else reply('land: not flying');
    },
  });
  return control;
}

/** The approach entry height above a target (docs): exported for the status tests. */
export const FLY_APPROACH_HEIGHT = APPROACH_HEIGHT;
