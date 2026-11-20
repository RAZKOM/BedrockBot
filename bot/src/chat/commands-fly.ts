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
import { glideKitReady, jumpTakeoff, ledgeTakeoff, planGlideDown, routeTakeoff, routeTakeoffOptions, smallPlatform, verticalTakeoff, type Ledge, type SimDeps } from '../skills/fly/glide.ts'; // Track BH, F9a
import { elytraWornLimit, flightKitMemoryOf, isRocket, kitLine, kitReady, readKit, ROCKET, rocketsForFlight, rocketsForWindow, SupplyWatch } from '../skills/fly/kit.ts';
import { burnSaid, kitBurnOf, openBurnOf, type BurnRange } from '../skills/fly/burn.ts'; // Track F9e round 2, Track F10
import { restockFromBoxes, supplyOf } from '../skills/supply/supply.ts';
import { FlightKitOps, refillEndLine } from '../skills/fly/kitops.ts';
import { APPROACH_HEIGHT, columnKey, columnsAlong, cruiseHeight, flightSeconds, hdist, takeoffSky, walkMinutes, yawTo, type CellQuery, type LandingTarget, type SkyCheck } from '../skills/fly/plan.ts';
import { cruiseOver, isTripCoverLine, tripCover, tripCoverLine } from '../skills/fly/wear.ts'; // Track F20; Track F21: cruiseOver
import { perched, standsOn } from '../skills/fly/ground.ts'; // Track F11
import { pathBlocks, probeOpenSky, probePath } from '../skills/home/reach.ts'; // Track AU2: the walk from a landing cell to the goal
import { probeNavOf } from '../skills/combat/pathReach.ts';
import { findLanding, isHazardName, isLiquidName, stillLandable, WET_ABOVE, type BlockLookup, type LandingPlan } from '../skills/fly/landing.ts'; // Track BF
import { landingProbe } from '../skills/fly/landprobe.ts'; // Track L2: the walk priced by the probe's path
import { TerrainMemo, type TerrainColumn } from '../skills/fly/terrain.ts'; // Track BL
import type { RouteGrid } from '../skills/fly/route/grid.ts'; // Track F3
import { planTakeoffRoute, type TakeoffRoute } from '../skills/fly/route/takeoff.ts'; // Track F3
import { RoutePlannerClient } from '../skills/fly/route/worker.ts'; // Track F3
import { matchEntries, matchExits, MATCH_NEAR } from '../skills/fly/learn/match.ts'; // Track F9b, F9c
import { chooseTouchdown, ENTRY_AIR, ENTRY_LAVA, ENTRY_SOLID, ENTRY_UNKNOWN, ENTRY_WATER, entryAim, entryTouchdowns, entryWorld, entryWorldSame, guideSpeed, type EntryAsked, type EntryLine, type EntryProof } from '../skills/fly/learn/entry.ts'; // Track F9c
import { guideLength, guidePoint, guideSaid } from '../skills/fly/learn/guide.ts'; // Track F9c, F9d
import { classify } from '../skills/terrain/classify.ts'; // Track F9c: a block's class as the world cache keeps it
import { cellClassOf } from '../world/cache/classes.ts'; // Track F9c
import { CLS_AIR, CLS_AVOID, CLS_WATER } from '../world/cache/types.ts'; // Track F9c
import { chooseDrawnEntry } from '../skills/fly/learn/drawin.ts'; // Track F9e
import { EXIT_FLOOD_MAX, EXIT_RADIUS, pickExitPiece, pickHop, hopTarget, scoutHop, type UnderPick, type UnderWorld } from '../skills/fly/learn/under.ts'; // Track F9e round 2
import { decideStanding, type StandingDeps } from '../skills/fly/learn/standing.ts'; // Track F22
import { addedSince, StandProcess } from '../tasks/process/stand.ts'; // Track F22
import { PathStore } from '../skills/fly/learn/store.ts'; // Track F9b
import { pathsDirOf } from './commands-learn.ts'; // Track F9b: where `!learn` keeps its paths
import { preferSite, RECHECK_EVERY_MS, RecheckState, SITE_BUDGET_MS, SITE_PROBES, SITE_SIMS, siteCandidates } from '../skills/fly/sites.ts'; // Track BL
import { searchFloors } from '../skills/fly/floors.ts'; // Track F15
import { wayFromHere, type FoundWay } from '../skills/nav/way.ts'; // Track W2 way: the landing probe's way handed to the walk
import type { Goal, GotoOptions, SkillResult } from '../skills/types.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import { FlightProcess, FlyProcess, landingLine, plannedArrival, plannedCruise, targetFromPlan, type EntryOffer, type FlyOutcome, type FlyTarget, type LandingHint } from '../tasks/process/fly.ts';
import { PRIORITY } from '../tasks/process/manager.ts';
import { waypointStoreOf, waypointGoal } from './commands-nav.ts';
import { survivalKitOf } from './commands-survival.ts';
import { elytraControlOf } from './commands-elytra.ts'; // Track K4
import { NETHER, OVERWORLD } from '../world/dimension.ts';
import type { Containers } from '../world/containers.ts';
import type { Logger } from '../log.ts';
import { inventorySlot, type StackRequests } from '../skills/survival/screen.ts';
import type { BlockInfo, ItemStack } from '../world/types.ts';
import { corridorAirborne, corridorProviderOf, corridorWanted } from '../skills/fly/corridor/registry.ts'; // Track F4b
import type { CorridorReport, SkyHint, StepOutcome } from '../skills/fly/corridor/executor.ts'; // Track F4b
import { CORRIDOR_HEALTH_MIN, corridorEndLine, flyWayWindow, REFILL_MOB_REACH, runCorridorTrip, stopCorridorTrip, type CorridorWiring, type TripStyle } from './commands-corridor.ts'; // Track F4b
import { nodeFeet, wayAt, wayGate, wayMobs, wayPrice, wayProven, WayScout, wayStretchOptions, WAY_ARM_NEAR, WAY_NEAR, WAY_OVER_S, WAY_PROVE_MS, WAY_PROVE_NODES, WAY_START_OFF, WAY_TICK_MS, type WayWindow } from '../skills/fly/cave/waywin.ts'; // Track F17
import { windowRequest } from '../skills/fly/corridor/drive.ts'; // Track F17
import { PATH_PACE } from '../skills/fly/landprice.ts'; // Track F17
import type { RoutePlan } from '../skills/fly/route/types.ts'; // Track F17
import type { PathNode } from '../skills/nav/astar.ts'; // Track F17
import { DEFAULT_COSTS } from '../skills/nav/costs.ts'; // Track F17
import { orderedRoute, shortcutRoute, WaypointProvider, type RoutePoint } from '../skills/fly/cave/route.ts'; // Track F5b
import { proveShortcutInWorker } from '../skills/fly/cave/proof.ts'; // Track F5b
import { CAVE_STYLE, caveExecutorOptions, caveStretchOptions } from '../skills/fly/cave/style.ts'; // Track F5b
import { takeoffWet } from '../skills/fly/takeoff-water.ts'; // Track F5a
import { cellPrice, LAND_MOBS, landMobsNear, landMobsSaid, type LandMob } from '../skills/fly/landmobs.ts'; // Track M3
import { FLEE_FLY, fleeAway, fleeBearings, fleeHeadings, fleeHomeClear, type FleeFlight } from '../skills/fly/flee.ts'; // Track M3

export const FLY_COMMANDS = ['fly', 'land'] as const;

/** Track BF: one probe plan of the landing search (nodes, ms) and the whole search's time budget (ms). */
export const LAND_PROBE_NODES = 6000;
export const LAND_PROBE_MS = 400;
export const LAND_BUDGET_MS = 6000;
/**
 * Track L2: the landing probe plans without the surface preference (landprobe.ts): on the owner's cave its first cells
 * took 41 000 nodes with it and 17 600 without, the same walk within 1 % of its ticks (docs/flight.md "L2").
 */
export const LAND_PROBE_SURFACE = false;
/** Track W2 way: the landing probes' whole ways kept for the walk after the landing (a search probes up to six cells, its flood a few more). */
export const FOUND_WAYS_KEPT = 32;
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
/**
 * Track F9c: a learned entry's recordings are kept this far before their last open sky (blocks: the whole of their open
 * part, which holds the hand-over window), open sky is this many free cells over a cell, at most this many takes are
 * proven for one flight (the nearest touchdowns first; each proof is some forty simulations of about a hundred ticks), and
 * no new take is begun once this long has gone. (Round 2: a take may be proven to up to three touchdown cells, so a take
 * costs up to 5 s and the takes of the owner's cave 8 to 9 s in all; a take begun before the limit is finished, so the
 * decision can come up to 5 s after it. It is made in the air, in slices, on a cruise of 30 s and more; a flight too
 * short for it flies without the entry: `comes too late`.)
 */
export const ENTRY_BEFORE = 200;
export const ENTRY_SKY = 64;
export const ENTRY_TAKES = 3;
export const ENTRY_BUDGET_MS = 10_000;
/** Track F9e round 2: a decision under a roof waits for the live model this many chunks each way round the body, at most this long (ms): a body that has just arrived has none. */
export const LIVE_WAIT_CHUNKS = 5;
export const LIVE_WAIT_MS = 3000;
/** Track F9e round 2: a drawn line is flown only by a body within this many blocks of where it was proven from (`runAuto`). */
export const DRAWN_START_OFF = 1;
/** Track F9e round 2: the pieces of a way flown at most for one trip. */
export const PIECES_MAX = 12;
/**
 * Track F22 (docs/flight.md "The hop asked from a walk (Track F22)"; decisions/0082 addendum 2): a hop that lost its line
 * (the flight ended `roof`: braked, down under the roof short of its touchdown) is asked again at once from where the
 * body stands, this many times a trip at most, when the flight cost no health and got HOP_LOST_FAR blocks or more from
 * where it began (a line lost at its start is lost there again).
 */
export const HOP_LOST_AGAIN = 2;
export const HOP_LOST_FAR = 16;
/** Track F22: the head room a walk is stopped under for a hop (a jump needs it to take a glide: learn/draw.ts DRAW_HEADROOM). */
export const HOP_STOP_HEADROOM = 3;
/**
 * Track F22, for the e2e only (test/e2e/fly-cave.test.ts FLY_CAVE_ONLY=hopwalk with FLY_HOP_BEFORE=1; FLY_HOP_LATE=0 for `late`
 * alone): each switch off flies the
 * trip as it was before the track, to measure what the rule changed (with glide.ts PROOF_SWITCH and learn/entry.ts
 * ENTRY_SWITCH for the touchdown). Nothing in the bot writes them.
 *   stand  a flight under a roof is decided with the body held and at rest (learn/standing.ts)
 *   scout  a walk's re-check asks whether a hop may be there (learn/under.ts scoutHop) and the hop is decided once, standing
 *   late   a hop's proof flies its line with a burn's end seen as late as this connection's rockets are (rocket.ts RocketLag)
 *   again  a hop that lost its line is asked again at once from where the body stands
 *   watch  a watched walk follows its own process (it followed whatever had the body when the walk was asked for)
 */
export const HOP_WALK = { stand: true, scout: true, late: true, again: true, watch: true };
/** Track F9e: a hop is asked for a goal farther than this (blocks, straight: a hop's least line, learn/hop.ts HOP_MIN): nearer, the walk is there before a proof is. */
export const HOP_ASK_MIN = 48;

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
  /** The latest `!fly` chain says nothing more and starts no further step; its corridor trip stops (the test harness, between runs). */
  supersede(): void;
  /** Track F5a: a corridor trip to a feet cell whatever its distance (the cave e2e's legs); undefined without a provider. */
  corridor(goal: Vec3, label: string): Promise<CorridorReport> | undefined;
  /**
   * Track M3 (docs/pve.md "The elytra flee"): the elytra flee as a flight mode. `fleeReady`: undefined when a flee can
   * take off where the body stands now, else why not (cheap: asked by the guard every look). `flee`: take off and land on
   * safe ground far from the hostiles; resolves when the body stands again, or at once when no takeoff was made.
   * `cancelFlee`: a flee on the ground is dropped, one in the air lands on the nearest safe ground; true when there was one.
   */
  fleeReady(): string | undefined;
  flee(why: string): Promise<FleeFlight>;
  cancelFlee(): boolean;
  fleeing(): boolean;
}

const controls = new WeakMap<object, FlyControl>();
/** Track F6: the liquids the route planner's grid treats as solid (a glide ends in water; lava is lava). */
const ROUTE_LIQUIDS: ReadonlySet<string> = new Set(['water', 'flowing_water', 'lava', 'flowing_lava']);
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
    case 'in_water':
      return 'fly: I am in water: swim up and stand on dry ground first';
    case 'glide_lost': // Track F20
      return `fly: the glide was lost in the air near ${at} (the elytra is at its last use: it is broken); I fell; ${stats}`;
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

/**
 * Track F15 (docs/flight.md "A landing where the body stands is not flown"): a landing within LAND_HERE_H blocks of the
 * body by the plane and less than LAND_HERE_DY levels above or below it is where the body stands: a flight there cannot
 * bring it nearer the goal than the walk does. The walk to such a cell is a few seconds (8 blocks at the sprint's 0.18 s
 * a block: 1.4 s, plus the stairs of up to 11 levels); a takeoff, a climb and a landing back onto it cost 15 to 22 s and 2
 * rockets on the Realm (2026-11-15, 2 trips of 12) and a go-around for want of a plan at 1 block out. 12 levels is what
 * makes a glide down a cliff a real flight: the least drop the ledge takeoff and the glide down take (LEDGE_MIN_DROP),
 * a fall no walk takes without hurt; a landing that far above or below stays a flight.
 */
/** Track F15: a floor search that led to a floor is not asked again within this many blocks, for this long (the refused takeoffs' memory). */
export const FLOOR_ONCE_R = 16;
export const FLOOR_ONCE_MS = 5 * 60_000;
export const LAND_HERE_H = 8;
export const LAND_HERE_DY = 12;
export function landingHere(from: Vec3, landing: { x: number; z: number; top: number }): boolean {
  return hdist(from, landing) <= LAND_HERE_H && Math.abs(landing.top - from.y) < LAND_HERE_DY;
}

/**
 * Track F15 (docs/flight.md "Takeoff from a floor the walk reaches"): the end of a trip that could take off neither where
 * it stood (`roof`, the takeoff's refusal) nor from a floor the walk reaches (`floors`, floors.ts searchFloors' words) and
 * whose walk found no way (`unreachable`, no progress, no path): the reply's note says the three, the takeoffs first. Any
 * other end (arrived, a flight, a timeout, interrupted) is returned as it is.
 */
export function noTakeoffNote(r: SkillResult, roof: string, floors: string): SkillResult {
  if (r.ok) return r;
  const reason = r.reason;
  if (reason !== 'unreachable' && !/no progress|no path/.test(reason)) return r;
  // (a reply is 256 characters: the roof in two words, the walk's own words last)
  const plain = roof.replace(/^fly: /, '').replace(/; walk outside first$/, '');
  const m = /^no open sky here \(roof at y -?\d+, (\d+) blocks? up\)$/.exec(plain);
  const here = m ? `a roof ${m[1]} up` : plain;
  return { ...r, note: `no takeoff here (${here}) or from any floor the walk reaches (${floors}); the walk: ${r.note ?? reason}` };
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
   * the sea floor under 15 blocks of water, the highest solid of its column). `perch` false (the takeoff sites' ground: a
   * ledge is a good place to fly from): without Track F11's two rules for a place to come down on.
   */
  const groundAt = (x: number, z: number, fromY?: number, perch = d.settings.get('flyLandOver') === true): number | undefined => {
    const top = skyTop(x, z, fromY);
    if (top === undefined) return undefined;
    const b = world.blockAt({ x, y: top, z });
    if (b && isHazardName(b.name)) return undefined;
    // Track BH: never a canopy (the Realm, 2026-10-31: a `roof` end on oak leaves left the body prone in the tree): the open ground beyond or under it
    if (b && /leaves|azalea|vine/.test(b.name)) return undefined;
    // Track F11 (skills/fly/ground.ts): never a block a body does not stand on as on a floor: a fence, a wall, a gate (their
    // boxes reach half a block over the cell), a pane, bars, a post (the Realm, 2026-11-13: flights that ended on fence tops)
    if (perch && b && b.boxes.length > 0 && standsOn(b.boxes) !== 'floor') return undefined;
    if (wetAbove(x, z, top)) return undefined;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const t = skyTop(x + dx, z + dz, fromY);
      if (t !== undefined && Math.abs(t - top) > 1) return undefined; // a 1-wide column, or a hole (Track AU2: a goal 3 under the floor is not landed in)
    }
    // Track F11: nor a perch: a roof, a wall's top, a pillar: a top with a floor in reach under it that no walk leads down to
    // without a fall that hurts (a stepped roof has level neighbours too)
    if (!perch) return top + 1;
    const seen = new Map<number, number | undefined>();
    const feetAt = (cx: number, cz: number): number | undefined => {
      const k = columnKey(cx, cz);
      if (!seen.has(k)) {
        const t = skyTop(cx, cz, fromY);
        seen.set(k, t === undefined ? undefined : t + 1);
      }
      return seen.get(k);
    };
    if (perched(feetAt, x, z, top + 1, (cx, cz) => !wetAbove(cx, cz, feetAt(cx, cz)! - 1))) return undefined;
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
  /** Track AU2: a landable cell: safe ground whose top is the block under `feet` (within a block) with open sky above. (Track F11: `perch`: as a place to come down on, groundAt's two rules more; the takeoff sites ask without.) */
  const landable = (x: number, z: number, feet?: number, perch = false): number | undefined => {
    const top = groundAt(x, z, undefined, perch);
    if (top === undefined) return undefined;
    if (feet !== undefined && Math.abs(top - feet) > 1.5) return undefined;
    return openAbove(x, z, top) ? top : undefined;
  };
  /** Track BF: the live world model for the landing search (undefined = not loaded; the cache never counts). */
  const look: BlockLookup = (x, y, z) => world.blockAt({ x, y, z });
  // Track M3 (docs/flight.md "The landing looks at hostile mobs"): the hostiles the server has sent, as the landing reads
  // them (landmobs.ts): for the search, for the chosen cell's re-check and for the brain's look in the approach. On with
  // `flyLandMobs`, and in every elytra flee
  const landMobs = (near: { x: number; z: number }): readonly LandMob[] => landMobsNear(world.entities.values(), pve.mobs, near);
  const mobsOn = (): boolean => d.settings.get('flyLandMobs') === true || fleeTrip !== undefined;
  /** Track M3: the elytra flee in progress (from the ask until its flight has ended), if any. */
  let fleeTrip: { p?: FlyProcess; cancelled: boolean } | undefined;
  // Track F3 (docs/flight.md "Route landings and takeoffs"): the route planner: the grid over the live model (unknown =
  // solid, the sky check's rule), the search in the worker (RoutePlannerClient, the 0023 pattern: an in-thread search of
  // 300 ms stalled the loop 6 ticks on bds-fly3), off with `flyRoute off`
  // (Track F6: water and lava are obstacles to the planner too: a glide ends in water, so no plan flies through a pool)
  const routeGrid: RouteGrid = {
    solid: (x, y, z) => {
      const b = world.blockAt({ x, y, z });
      return b ? b.solid || ROUTE_LIQUIDS.has(b.name) : true;
    },
  };
  const routeClient = new RoutePlannerClient({ log });
  const routePlanner = routeClient.plannerOver(routeGrid);
  // Track F9b: the paths recorded with `!learn` (<config dir>/paths, read when a takeoff asks and a file has changed)
  const learnedPaths = new PathStore(() => pathsDirOf(d.settings.file));
  const routeOn = (): boolean => String(d.settings.get('flyRoute')) !== 'off';
  /**
   * Track F9e round 2: the burn of the rockets in the hotbar (skills/fly/burn.ts): a crafted rocket burns ten ticks longer
   * than the one the script API gives, and a line under a roof is proven and flown with the burn of the rockets at hand.
   * Undefined: the plain rocket's (9 to 21), as everything was before.
   */
  const kitBurn = (): BurnRange | undefined => kitBurnOf(inv.slots, isRocket);
  /**
   * Track F10 (docs/flight.md "The open-air flight on the burn of the rockets at hand"; decisions/0083): the burn the
   * flight in the open plans with: the kit's with `flyKitBurn` on (default off), else undefined, and then the climb, the
   * cruise, the route planner's plans and every takeoff's proof think in 9 to 21 as before. The lines under a roof take
   * the kit's burn whatever this says (`kitBurn`, Track F9e round 2).
   */
  const openBurn = (): BurnRange | undefined => openBurnOf(d.settings.get('flyKitBurn') === true, inv.slots, isRocket);
  /** The brain's options of a takeoff's simulation (the flight's own: tasks/process/fly.ts), for a cruise height. */
  const simOptions = (cruiseY: number): { cruiseY: number; margin: number; goArounds: number; burn?: BurnRange } => {
    const burn = openBurn();
    return { cruiseY, margin: d.settings.get('flyMargin'), goArounds: d.settings.get('flyGoArounds'), ...(burn ? { burn } : {}) };
  };
  /** Track W2 way (docs/flight.md "The walk after a landing takes the probe's way"): the whole ways the landing probes found, the newest last. */
  const foundWays: FoundWay[] = [];
  /**
   * Track BF (docs/flight.md "Landing v3"): the landing for a walk to `goal` (landing.ts findLanding): only
   * live cells, only dry ground, only a cell with a confirmed walking path (a bounded probe plan from its
   * feet, no digging or pillars), overhang cells with a simulated corridor approach; `exact` (the half
   * width) lands on the goal itself when it is landable (`!fly <x y z>`). The compact line goes to the log.
   */
  const landingFor = async (goal: Vec3, label: string, exact: number | undefined, hint?: LandingHint): Promise<LandingPlan> => {
    const nav = probeNavOf(pve.mover);
    // Track M3: the hostiles known round the goal, read once a search (none known: the search as it was)
    const hostiles = mobsOn() ? landMobsNear(world.entities.values(), pve.mobs, { x: goal.x + 0.5, z: goal.z + 0.5 }, d.settings.get('flyLandSearch') + LAND_MOBS.scan) : [];
    // Track L2: the probe answers with the walk's planned ticks (the walk priced by its path), and takes the longer budget
    // findLanding asks for the walk flood's first cells
    const onPath = (path: FoundWay['path']): void => {
      foundWays.push({ path, goal: { ...goal }, at: Date.now() });
      if (foundWays.length > FOUND_WAYS_KEPT) foundWays.splice(0, foundWays.length - FOUND_WAYS_KEPT);
    };
    const probe = nav ? landingProbe(nav, goal, { budget: { nodes: LAND_PROBE_NODES, ms: LAND_PROBE_MS }, surface: LAND_PROBE_SURFACE, onPath }) : undefined;
    const plan = await findLanding(
      goal,
      label,
      {
        look,
        obstacle: (x, y, z) => world.blockAt({ x, y, z })?.solid === true,
        ...(probe ? { probe } : {}),
        dryGround: (x, z) => landable(x, z, undefined, d.settings.get('flyLandOver') === true),
        ...(hostiles.length ? { mobs: (c: { x: number; z: number; feet: number }) => cellPrice(c, hostiles) } : {}),
        yieldNow: () => new Promise((r) => setImmediate(r)),
        // Track F14: the flight's own column tops, for the rim of a cell with something standing round it
        ...(d.settings.get('flyWayDown') === true ? { skyTop: (x: number, z: number) => skyTop(x, z), maxY: (x: number, z: number) => (world.chunks as Partial<typeof world.chunks> | undefined)?.topY?.(x, z) } : {}),
        // Track F3: the route planner for a precision goal the brake cannot land (a slot 2 high, a hole, a 1 x 1 shaft)
        ...(routeOn() ? { route: { grid: routeGrid, plan: routePlanner, rockets: Math.min(4, Math.max(2, readKit(inv, memory()).rocketsHotbar)), ...(openBurn() ? { kit: openBurn()! } : {}) } } : {}),
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
        ...(hint?.rim !== undefined ? { rim: hint.rim } : {}), // Track F8: the opening's rim over a corridor's landing cell
        ...(hint?.partial ? { partial: true } : {}), // Track L1: the hold's look answers from the loaded part
        ...(d.settings.get('flyWayDown') === true ? { sky: true } : {}), // Track F14: open sky is the sky, a way down to every cell, a cave's mouth however far
      },
    );
    log.info(`fly: ${plan.line}${hostiles.length ? `; hostiles known round it: ${landMobsSaid(hostiles, { x: goal.x + 0.5, y: goal.y, z: goal.z + 0.5 })}` : ''}`);
    return plan;
  };
  const cellOk = (c: { x: number; z: number; feet: number }): boolean => stillLandable(look, c, d.settings.get('flyHeadroom'));

  // ---- Track F9c (docs/flight.md "Learned entries (Track F9c)"; decisions/0080): the learned entry ----------------
  /**
   * A block as an entry's proof sees it (learn/entry.ts): the world cache's own four classes (world/cache/classes.ts
   * cellClassOf: air, anything with a collision box, water, and what is never entered: lava, fire, cactus ...), so that
   * a live block and the cache's stand-in for it are the same cell and a proof made on the cache can be held against the
   * live world cell by cell.
   */
  const entryClasses = new Map<number, number>();
  const entryClass = (b: BlockInfo): number => {
    let c = b.stateId >= 0 ? entryClasses.get(b.stateId) : ENTRY_SOLID;
    if (c === undefined) {
      const cls = cellClassOf(classify(b));
      c = cls === CLS_AIR ? ENTRY_AIR : cls === CLS_WATER ? ENTRY_WATER : cls === CLS_AVOID ? ENTRY_LAVA : ENTRY_SOLID;
      entryClasses.set(b.stateId, c);
    }
    return c;
  };
  /** The live model's cell for an entry's proof, ENTRY_UNKNOWN where it has none. */
  const entryLive = (x: number, y: number, z: number): number => {
    const b = world.blockAt({ x, y, z });
    return b ? entryClass(b) : ENTRY_UNKNOWN;
  };
  /** Powered and unpowered flight under a roof along a recording: with `flyCave` on and its own switch (default off), and the route planner's grid at hand. */
  const learnedEntryOn = (): boolean => String(d.settings.get('flyCave')) === 'on' && d.settings.get('flyLearnedEntry') === true && routeOn();
  /** Track F9e: and along a line drawn from the world where no recording gives one: with `flyCave` on and its own switch (default off). */
  const drawnEntryOn = (): boolean => String(d.settings.get('flyCave')) === 'on' && d.settings.get('flyCaveEntry') === true && routeOn();
  const entryOn = (): boolean => learnedEntryOn() || drawnEntryOn();
  /** Nothing solid, liquid or unknown over the cell up to ENTRY_SKY blocks over it (the live model, else the world cache). */
  const entrySky = (x: number, y: number, z: number): boolean => {
    for (let k = y + 1; k <= Math.min(319, y + ENTRY_SKY); k++) {
      const b = world.blockAt({ x, y: k, z }) ?? world.cache?.blockAt(x, k, z);
      if (!b || entryClass(b) !== ENTRY_AIR) return false;
    }
    return true;
  };
  /** The recorded ways in to a goal (matched by where they stand again and the roof over it, never by their names). */
  const entryMatches = (goal: Vec3): ReturnType<typeof matchEntries> => matchEntries(learnedPaths.all(), { x: goal.x + 0.5, y: goal.y, z: goal.z + 0.5 }, entrySky, { before: ENTRY_BEFORE });
  /**
   * The learned entry for a flight to `goal` (a feet cell): the recorded flights that came from under open sky and stood
   * again by it, each as its line with a lead-in (learn/entry.ts entryLine) and proven from every state the hand-over
   * allows (proveEntry) on the live model with the world cache where the live model has nothing yet; of those that
   * clear, the one whose flights kept the most room. One line for the decision. Undefined: none (the setting off, no
   * recording that ends there, every proof refused): nothing changes for the flight.
   */
  const entryFor = async (goal: Vec3, label: string): Promise<EntryOffer | undefined> => {
    if (!entryOn()) return undefined;
    // (Track F9e: a recording that matches first; then, with its own switch, the line drawn from the world)
    return (learnedEntryOn() ? await learnedEntryFor(goal, label) : undefined) ?? (drawnEntryOn() ? await drawnEntryFor(goal, label) : undefined);
  };
  /** The proof's world of an entry: the live model, the world cache where it has nothing (counted), an unknown cell a solid. */
  const entryProofWorld = (centre: Vec3): { w: ReturnType<typeof entryWorld>; cached: () => number } => {
    let cached = 0;
    const w = entryWorld((x, y, z) => {
      const b = world.blockAt({ x, y, z });
      if (b) return entryClass(b);
      const c = world.cache?.blockAt(x, y, z);
      cached++;
      return c ? entryClass(c) : ENTRY_SOLID;
    }, centre);
    return { w, cached: () => cached };
  };
  /** An entry's offer for a flight: where the cruise comes onto its line, and the test of its proof against the live world. */
  const entryOffer = (line: EntryLine, goal: Vec3, asked: EntryAsked, cached: number): EntryOffer => {
    const centre = { x: goal.x + 0.5, y: goal.y, z: goal.z + 0.5 };
    const aim = entryAim(line, { top: (x, z) => skyTop(x, z), clearance: d.settings.get('flyClearance') });
    return {
      target: { x: aim.x, z: aim.z, top: Math.round(aim.y) - APPROACH_HEIGHT, half: 2, bearing: aim.bearing, entry: { line, goal: { x: centre.x, z: centre.z, top: goal.y, half: 2 }, ...(cached ? { unconfirmed: true } : {}) } },
      confirm: () => {
        const r = entryWorldSame(asked, entryLive);
        return { same: r.same, line: r.same === 'same' ? `${asked.cells.size} cells the same` : r.same === 'changed' ? `the cell ${r.cell?.x} ${r.cell?.y} ${r.cell?.z} is not what the proof flew` : `${r.unknown} of ${asked.cells.size} cells not loaded yet` };
      },
    };
  };
  /**
   * Track F9e (docs/flight.md "Drawn lines, the way in and under one roof (Track F9e)"; decisions/0082): the DRAWN entry for
   * a flight to `goal` (a feet cell under a roof) that no recording leads into: the flood from a standable cell by the goal
   * out to the open sky, the line reversed, coming down all the way, with the hand-over window and the lead-in of a
   * recorded entry, proven from every state the hand-over allows and flown by the same flier (learn/drawin.ts). One line
   * for the decision. Undefined: none (no flood to the sky, the opening lies under the goal, every proof refused): the
   * landing as without it.
   */
  const drawnEntryFor = async (goal: Vec3, label: string): Promise<EntryOffer | undefined> => {
    const t0 = Date.now();
    const centre = { x: goal.x + 0.5, y: goal.y, z: goal.z + 0.5 };
    // (a goal under open sky needs no way in)
    if (entrySky(goal.x, goal.y, goal.z)) return undefined;
    const { w, cached } = entryProofWorld(centre);
    // the line is drawn on the same view of the world (the live model, else the cache; an unknown cell a solid), through
    // another memory than the proof's: the cells a proof made on the cache is confirmed by are the proof's own
    const draw: RouteGrid = {
      solid: (x, y, z) => {
        const b = world.blockAt({ x, y, z }) ?? world.cache?.blockAt(x, y, z);
        return !b || entryClass(b) !== ENTRY_AIR;
      },
    };
    const yieldNow = (): Promise<void> => new Promise((r) => setImmediate(r));
    const cells = entryTouchdowns((x, y, z) => (w.world.solidAt(x, y, z) ? ENTRY_SOLID : w.grid.solid(x, y, z) ? ENTRY_WATER : ENTRY_AIR), goal);
    const pick = await chooseDrawnEntry(w, draw, goal, cells, Math.min(319, goal.y + ENTRY_SKY), { yieldNow, spent: () => Date.now() - t0 > ENTRY_BUDGET_MS, ground: (x, z) => skyTop(x, z), clearance: d.settings.get('flyClearance') });
    const head = `fly: drawn entry: no recorded way in to ${label}: a flood of ${pick.cells} cells under the roof from the goal, ${pick.ways} to the open sky, ${pick.lines} line${pick.lines === 1 ? '' : 's'} drawn; ${pick.tried.join('; ')}`;
    if (!pick.line || !pick.proof || !pick.cell || !pick.entry) {
      log.info(`${head} -> no drawn entry: the landing as without it (${pick.sims} simulated, ${Date.now() - t0} ms)`);
      return undefined;
    }
    const { line } = pick;
    const gate = guidePoint(line.guide, line.from).pos;
    const n = cached();
    log.info(`${head} -> in along the drawn line ${line.guide.path}: onto its line ${Math.round(Math.hypot(gate.x - centre.x, gate.z - centre.z))} blocks from the goal and ${Math.round(gate.y - centre.y)} over it at about ${guideSpeed(line.guide, line.from).toFixed(1)} a tick, ${Math.round(line.open - line.from)} blocks of open air to its roof, ${Math.round(guideLength(line.guide) - line.open)} under it to the touchdown on ${pick.cell.x === goal.x && pick.cell.y === goal.y && pick.cell.z === goal.z ? "the goal's cell" : `the cell ${pick.cell.x - goal.x} ${pick.cell.y - goal.y} ${pick.cell.z - goal.z} from the goal's (every flight of the proof stood within ${pick.proof.far.toFixed(1)} of the goal)`} (${pick.sims} simulated, ${Date.now() - t0} ms${n ? `; ${n} cells from the world cache: to be confirmed on the live world before the line is committed to` : ''})`);
    return entryOffer(line, goal, w.asked, n);
  };
  const learnedEntryFor = async (goal: Vec3, label: string): Promise<EntryOffer | undefined> => {
    const t0 = Date.now();
    const found = entryMatches(goal);
    if (!found.matches.length) {
      if (found.near) log.info(`fly: learned entry: no recorded way in to ${label} (${found.flights} recorded flight${found.flights === 1 ? '' : 's'}, ${found.near} standing again within ${MATCH_NEAR} of it, none of them under a roof after open sky)`);
      return undefined;
    }
    const centre = { x: goal.x + 0.5, y: goal.y, z: goal.z + 0.5 };
    const tried: string[] = [];
    let sims = 0;
    let best: { line: EntryLine; proof: EntryProof; cell: Vec3; asked: EntryAsked; cached: number } | undefined;
    let proven = 0;
    for (const m of found.matches) {
      if (proven >= ENTRY_TAKES) break;
      if (tried.length && Date.now() - t0 > ENTRY_BUDGET_MS) {
        tried.push(`${m.guide.path}: not tried (${Date.now() - t0} ms gone)`);
        break;
      }
      // the proof's world: the live model, the world cache where it has nothing (counted: such a proof is confirmed on the
      // live world before the body commits to the line), an unknown cell a solid
      const { w, cached } = entryProofWorld(centre);
      const at = `${m.guide.path} (it stood again ${m.off.toFixed(1)} from the goal)`;
      // Round 2: the touchdown is the goal's own cell or, where the take does not fly to that, the nearest standable cell
      // within 2 blocks of it that it does fly to (learn/entry.ts chooseTouchdown: each cell the recording's own three states
      // first, then the whole proof; the cells asked through the proof's world, so the live confirmation covers them).
      // (ENTRY_TAKES is counted in takes that got a whole proof: one refused at its own states costs a few simulations.)
      const yieldNow = (): Promise<void> => new Promise((r) => setImmediate(r));
      const pick = await chooseTouchdown(w, m, goal, entryTouchdowns((x, y, z) => (w.world.solidAt(x, y, z) ? ENTRY_SOLID : w.grid.solid(x, y, z) ? ENTRY_WATER : ENTRY_AIR), goal), { yieldNow });
      sims += pick.sims;
      if (pick.proofs) proven++;
      tried.push(`${at}: ${pick.said}${pick.proof ? '' : ': refused'}`);
      if (pick.line && pick.proof && pick.cell && (!best || pick.proof.room > best.proof.room)) best = { line: pick.line, proof: pick.proof, cell: pick.cell, asked: w.asked, cached: cached() };
    }
    const head = `fly: learned entry: ${found.matches.length} recorded way${found.matches.length === 1 ? '' : 's'} in to ${label} (${found.flights} recorded flight${found.flights === 1 ? '' : 's'}, ${found.near} standing again within ${MATCH_NEAR} of it); ${tried.join('; ')}`;
    if (!best) {
      log.info(`${head} -> no learned entry: the landing as without a recording (${sims} simulated, ${Date.now() - t0} ms)`);
      return undefined;
    }
    const { line, asked, cached } = best;
    const gate = guidePoint(line.guide, line.from).pos;
    const under = guideLength(line.guide) - line.open;
    log.info(`${head} -> in along ${line.guide.path} (the most room: ${best.proof.room >= 1 ? '1 or more' : best.proof.room.toFixed(2)}): onto its line ${Math.round(Math.hypot(gate.x - centre.x, gate.z - centre.z))} blocks from the goal and ${Math.round(gate.y - centre.y)} over it at about ${guideSpeed(line.guide, line.from).toFixed(1)} a tick, ${Math.round(line.open - line.from)} blocks of open air to its roof, ${Math.round(under)} under it to the touchdown on ${best.cell.x === goal.x && best.cell.y === goal.y && best.cell.z === goal.z ? "the goal's cell" : `the cell ${best.cell.x - goal.x} ${best.cell.y - goal.y} ${best.cell.z - goal.z} from the goal's (${Math.hypot(best.cell.x - goal.x, best.cell.z - goal.z).toFixed(1)} beside it; every flight of the proof stood within ${best.proof.far.toFixed(1)} of the goal)`} (${sims} simulated, ${Date.now() - t0} ms${cached ? `; ${cached} cells from the world cache: to be confirmed on the live world before the line is committed to` : ''})`);
    return entryOffer(line, goal, asked, cached);
  };

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
    ...(kit ? { swap: (a: number, c: number) => swapSlots(kit.requests, inv, a, c) } : {}),
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
  /** Track F13: the rockets a takeoff, a hop or a route is simulated with: the loose ones, else what the refill before the takeoff gives (kit.ts rocketsForFlight). */
  const flightRockets = (k: ReturnType<typeof readKit>): number => rocketsForFlight(k, supplyOf(d.task)?.carried(ROCKET) ?? 0);
  /** Track F13: nothing loose and the box needed: why its refill cannot be made where the body stands (the line), else undefined. */
  const refillRefusal = (k: ReturnType<typeof readKit>): string | undefined => {
    if (k.rockets > 0 || k.boxRockets <= 0) return undefined;
    const why = kitOps.refillCheck();
    return why ? refillEndLine({ ok: false, taken: 0, pickedUp: false, reason: why }, 0) : undefined;
  };
  /**
   * Track F20 (docs/flight.md "A flight never outlasts its elytra (Track F20)"): does the elytra cover a flight of `distance`
   * blocks (wear.ts tripCover: the trip's uses against what is left over the worn limit)? `hold`: the goal's ground is not
   * loaded yet. The count is the inventory model's; the trip itself asks again once the elytra is on the back (FlyProcess.prepare).
   */
  // (Track F21: an Unbreaking elytra's trip is counted at its share of the uses: wear.ts useShare)
  // (Track F21: `cruise`: the climb and the cruise's height over the ground, where the cruise is known (the walk's re-check,
  // a new trip in the air): the same question as the flight's preparation asks; wear.ts tripUses)
  // (Track F21, the calibration: `cruise.arrive`, the height over the goal the flight reaches it at: plannedArrival)
  const coverOf = (k: ReturnType<typeof readKit>, distance: number, hold = false, cruise: { climb?: number; over?: number; arrive?: number } = {}) => tripCover(k.elytraLeft, elytraWornLimit(d.settings.get('toolWearLimit'), k), distance, { hold, ...cruise }, k.elytraUnbreaking ?? 0);
  /** Track F20: the line of a trip the elytra does not cover: logged, and said unless `quiet`, once for a goal and a count (a walk's re-checks ask every few blocks). */
  let coverSaid = '';
  let coverLogged = '';
  const noCover = (c: ReturnType<typeof coverOf>, distance: number, label: string, tail: string, quiet = false): string => {
    const line = `fly: ${tripCoverLine(c, distance)}${tail}`;
    const key = `${label}:${c.left}`;
    if (coverLogged !== key) log.info(`${line} (${label})`);
    coverLogged = key;
    if (!quiet && coverSaid !== key) {
      coverSaid = key;
      d.chat.say(line);
    }
    return line;
  };
  /**
   * Track K4 (docs/flight.md "An elytra on hand"): before a trip is refused for its elytra, a better one to hand is put on
   * (tasks/process/elytra.ts forTrip); what the refusal adds when none covers it. `walking`: a walk runs, only looked at.
   */
  const spareFor = async (distance: number, walking: boolean, hold = false, climb?: number, over?: number, arrive?: number): Promise<string> => {
    const ec = elytraControlOf(d.task);
    if (!ec) return '';
    try {
      return (await ec.forTrip(distance, { act: !walking, hold, ...(climb !== undefined ? { climb } : {}), ...(over !== undefined ? { over } : {}), ...(arrive !== undefined ? { arrive } : {}) })).line ?? '';
    } catch (err) {
      log.warn(`fly: the spare elytra: ${err instanceof Error ? err.message : String(err)}`);
      return '';
    }
  };
  processes.add(new FlightProcess(controller));
  let current: FlyProcess | undefined;
  /**
   * `adopt`: take over the flight in the air for this target (FlyProcess.adopt) instead of a takeoff; the trip before it hands over.
   * `home`: the trip home (the returnHome wrapper below): the FlyProcess runs as the home return (`home`, auto, PRIORITY.home).
   */
  const start = (target: FlyTarget, o: { adopt?: { cruiseY?: number }; home?: boolean; flee?: boolean } = {}): FlyProcess => {
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
      elytra: (distance, hold, climb, over, arrive) => spareFor(distance, false, hold, climb, over, arrive), // Track K4; Track F21: the climb, the cruise's height and the arrival of the second check
      ...(routeOn() ? { route: { grid: routeGrid, plan: routePlanner } } : {}), // Track F3
      ...(entryOn() ? { entry: entryFor } : {}), // Track F9c
      burn: openBurn, // Track F10
      mobs: landMobs, // Track M3
      waitTicks: (n) => loop.waitTicks(n),
      supply,
      log,
      // (Track M3: an elytra flee holds the body from the ask on: over the flight on foot and the guard, under the flight in the air)
    }, o.home ? { name: 'home', kind: 'auto', priority: PRIORITY.home } : o.flee ? { name: 'fleefly', kind: 'auto', priority: PRIORITY.flee + 0.5, flee: true } : {});
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
  // the chain of the latest `!fly` (its flight, the corridor, the rest of the trip); a new `!fly`, `!fly stop` or the test
  // harness supersedes it: an older chain says nothing more and starts no further step (the Realm, 2026-11-09: a run's
  // leftover walk ran on into the next runs and its end lines were read as theirs)
  let flyGen = 0;
  const supersede = (): void => {
    flyGen++;
    stopCorridorTrip(task);
  };
  const control: FlyControl = {
    controller,
    kitOps,
    supply,
    current: () => current,
    start,
    supersede,
    state: () => ({ gliding: loop.state.gliding, rockets: readKit(inv, memory()).rocketsHotbar, phase: controller.status().phase }),
    corridor: (goal, label) => {
      const provider = corridorProviderOf(task, skills.nav.coarseLayer);
      return provider ? runCorridorTrip(corridorWiring(), provider, goal, label, tripStyle()) : undefined; // Track F5b: the cave style with flyCave on
    },
    fleeReady: () => fleeReady(),
    flee: (why) => flee(why),
    cancelFlee: () => cancelFlee(),
    fleeing: () => fleeTrip !== undefined,
  };
  controls.set(task, control);
  // Track M3: the reflex strikes under a flight while the body comes down onto its landing and through the settle
  // (with a blade in the hotbar it is in the hand for those seconds when a hostile is within reach of them: a rocket, if the
  // flight needs one after all, takes the hand back by itself: rocket.ts fire)
  let bladeOut = false;
  pve.flightStrike = () => {
    const on = mobsOn() && controller.touchingDown();
    if (!on) bladeOut = false;
    else if (!bladeOut && pve.hasBlade() && landMobsNear(world.entities.values(), pve.mobs, loop.state.pos, 8).length > 0) {
      bladeOut = true;
      pve.combat.selectWeapon();
    }
    return on;
  };

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
  const ledgeFor = async (from: Vec3, target: LandingTarget, sky: SkyCheck, rockets: number, quiet = false, said?: string[]): Promise<Ledge | undefined> => {
    if (!d.settings.get('flyLedgeTakeoff')) return undefined;
    const small = smallPlatform(cell, from);
    if (sky.ok && !small) return undefined;
    const cz = cruiseHeight(from, target, skyTop, { clearance: d.settings.get('flyClearance'), margin: d.settings.get('flyMargin'), maxClimb: d.settings.get('flyMaxClimb') });
    const why = sky.ok ? 'a small platform' : sky.ahead === 0 ? `a roof ${sky.above} up` : `the run blocked ${sky.ahead} ahead`;
    const r = await ledgeTakeoff(simDeps(true), from, target, simOptions(cz.y), rockets);
    if (!quiet) log.info(`fly: ledge takeoff (${why}): ${r.line}`);
    if (!r.ledge) said?.push(r.line); // Track F15: why a floor's ledge takeoff failed, for the floor search's line
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
    const r = await verticalTakeoff(simDeps(true), from, target, simOptions(cz.y), rockets, d.settings.get('flyTakeoffRun'));
    if (!quiet) log.info(`fly: vertical takeoff: ${r.line}`);
    return r.top !== undefined && r.yaw !== undefined ? { vertical: r.top, takeoffYaw: r.yaw } : undefined;
  };
  /**
   * Track F3 (docs/flight.md "Route landings and takeoffs"): the route takeoff (route/takeoff.ts): the air around
   * the start flooded for the nearest cells under open sky, a plan from standing to one of them searched in the
   * worker; the last step of the chain before the walk-out legs (out of a hole, a low room, a stack's inner
   * platform when no ledge is clear). Undefined: no exit, or no plan (the line says).
   * Track F9a (docs/flight.md "Cave exit"): a plan is taken only with its proof: the whole takeoff simulated as the jump
   * and the vertical takeoff are (glide.ts routeTakeoff: the tracker out to the exit, then the climb that keeps the exit's
   * line and turns to the goal as the path clears, at the nominal burn and its extremes), the proven one with the least time to the goal; with `flyCave`
   * and `flyCaveExit` on and no exit's climb clearing, the ways out under the roof to the real sky (route/takeoff.ts waysOut).
   * Track F9b (docs/flight.md "Learned exits"): with `flyCave` and `flyLearned` on, a recorded flight that left the ground
   * where the bot stands is tried before all of that, flown along its own line and proven the same way.
   */
  const routeTakeoffFor = async (from: Vec3, target: LandingTarget, rockets: number, quiet = false): Promise<{ routeTakeoff: TakeoffRoute; takeoffYaw: number } | undefined> => {
    if (!routeOn()) return undefined;
    const cz = cruiseHeight(from, target, skyTop, { clearance: d.settings.get('flyClearance'), margin: d.settings.get('flyMargin'), maxClimb: d.settings.get('flyMaxClimb') });
    // the proof's world is the flight's own view: the live model, and the world cache's solids where the live model has nothing
    // (the flight's obstacle check sees those too: controller.ts cachedSolid). With the live model alone the simulated climb
    // flew into a hill only the cache knew, 100 blocks past the cave's mouth, and the proof refused it as terrain not loaded
    const base = simDeps(true);
    const raw: { solidAt(x: number, y: number, z: number): boolean | undefined } | undefined = loop.world;
    const deps = raw ? { ...base, world: { ...base.world, solidAt: (x: number, y: number, z: number) => raw.solidAt(x, y, z) ?? world.cache?.blockAt(x, y, z)?.solid === true } } : base;
    const goalYaw = yawTo(from, target);
    let sims = 0;
    const t0 = Date.now();
    const prove = async (route: TakeoffRoute) => {
      const r = await routeTakeoff(deps, from, target, simOptions(cz.y), rockets, { route: { grid: routeGrid, plan: routePlanner }, takeoff: routeTakeoffOptions(route, true) }, { planTicks: route.ticks });
      sims += r.sims;
      return r;
    };
    // Track F9d (docs/flight.md "Drawn lines"): with no recording that proves clear, a way out DRAWN from the flood under the
    // roof to the open sky, proven and flown as a recorded line is (learn/draw.ts). Powered flight underground with no
    // recording at all: only with flyCave on, and with its own switch, flyCaveExit, default off. It takes the place of the
    // searched ways out that switch asked for before (Track F9a's: waypoints for the route tracker, which their own proof
    // refused in the owner's cave every time); route/takeoff.ts still has them (`far`), nothing in the bot asks
    const top = Math.min(319, Math.ceil(cz.y));
    // (Track F9e round 2: as far as EXIT_RADIUS: the deep cave's way out is 413 blocks of line and the flood stopped at 128.
    // The grid is the live model's, so the flood's reach is what the server has sent)
    const drawn = String(d.settings.get('flyCave')) === 'on' && d.settings.get('flyCaveExit') ? { top, radius: EXIT_RADIUS, max: EXIT_FLOOD_MAX } : undefined;
    // Track F9b (docs/flight.md "Learned exits"): the recorded flights that left the ground where the bot stands and came out
    // under open sky (the paths of `!learn`, matched by where they begin, never by their names) are tried first, each with
    // the same proof. Powered flight under a roof as well: only with flyCave on, and with its own switch (default off)
    let learned: ReturnType<typeof matchExits> | undefined;
    if (String(d.settings.get('flyCave')) === 'on' && d.settings.get('flyLearned')) {
      const sky = (x: number, y: number, z: number): boolean => {
        for (let k = y + 1; k <= top; k++) if (routeGrid.solid(x, k, z)) return false;
        return true;
      };
      learned = matchExits(learnedPaths.all(), from, sky);
    }
    const burn = kitBurn();
    const r = await planTakeoffRoute(routeGrid, from, target, { rockets: Math.min(4, Math.max(1, rockets)), prove, ...(drawn ? { drawn } : {}), ...(learned?.matches.length ? { learned: { matches: learned.matches } } : {}), ...(burn ? { burn } : {}), ...(openBurn() ? { kit: openBurn()! } : {}) }, routePlanner);
    const g = r.route?.guide;
    if (!quiet) log.info(`fly: route takeoff: ${burn ? `rockets that burn ${burnSaid(burn)} ticks; ` : ''}${learned ? `${learned.matches.length} learned way${learned.matches.length === 1 ? '' : 's'} out from here (${learned.flights} recorded flight${learned.flights === 1 ? '' : 's'}, ${learned.near} leaving the ground within ${MATCH_NEAR}), ` : ''}${r.drawn ? `${r.drawn.lines} drawn way${r.drawn.lines === 1 ? '' : 's'} out (a flood of ${r.drawn.cells} cells under the roof, ${r.drawn.ways} to the open sky, drawn in ${Math.round(r.drawn.ms)} ms), ` : ''}${r.exits} exit${r.exits === 1 ? '' : 's'} under open sky${r.ways !== undefined ? `, ${r.ways} way${r.ways === 1 ? '' : 's'} out under the roof` : ''}; ${r.tried.length ? r.tried.join('; ') : 'none tried'}${r.route ? ` -> out ${g ? `along ${guideSaid(g.line)} ` : ''}to ${r.route.exit.x} ${r.route.exit.y} ${r.route.exit.z}, then the climb curving to heading ${Math.round(goalYaw)}` : ' -> no route takeoff'} (${sims} simulated, ${Date.now() - t0} ms)`);
    return r.route ? { routeTakeoff: r.route, takeoffYaw: r.route.yaw } : undefined;
  };
  /** Track F9e: powered flight between two places under one roof along a drawn line: with `flyCave` on and its own switch (default off), and the route planner's grid at hand. */
  const hopOn = (): boolean => String(d.settings.get('flyCave')) === 'on' && d.settings.get('flyCaveHop') === true && routeOn();
  /**
   * Track F9e (docs/flight.md "Drawn lines, the way in and under one roof (Track F9e)"; decisions/0082): the HOP for a trip
   * from under a roof to a goal under a roof: the flood by cost from the body's cell to a standable cell by the goal, the
   * line drawn on it (learn/hop.ts), and the whole flight proven from standing to standing at every burn, the mixes and a
   * first rocket that fires nothing (glide.ts routeHop). The flight's target carries the line as its entry and the hop as
   * its route takeoff: the follower flies it, the entry's flier lands it, and there is no climb and no cruise. One line
   * for the decision. Undefined: the start or the goal under open sky, no way, too short a line, nothing proven.
   */
  /** Track F9e round 2: the two layers of the bot's world for a flight under a roof (learn/under.ts): the live model, and the world cache behind it. */
  const underWorld: UnderWorld = {
    live: (x, y, z) => {
      const b = world.blockAt({ x, y, z });
      return b ? entryClass(b) : undefined;
    },
    cached: (x, y, z) => {
      const b = world.cache?.blockAt(x, y, z);
      return b ? entryClass(b) : undefined;
    },
  };
  /** The simulation's world for a line under a roof: the live model alone, an unknown cell a solid (nothing is proven into cells never seen live). */
  const liveSim = (): SimDeps => {
    const base = simDeps(true);
    const raw: { solidAt(x: number, y: number, z: number): boolean | undefined } | undefined = loop.world;
    return raw ? { ...base, world: { ...base.world, solidAt: (x: number, y: number, z: number) => raw.solidAt(x, y, z) ?? true } } : base;
  };
  /** A hop's flight target: its line as the entry, the hop as the route takeoff; a piece is labelled as one and its goal is its own cell. */
  const hopOffer = (pick: UnderPick, goal: Vec3, label: string, half: number): { target: FlyTarget; line: string; piece?: boolean } | undefined => {
    const h = pick.hop;
    if (!h) return undefined;
    const t = hopTarget(h.drawn, h.cell);
    const target: FlyTarget = { ...t, half: h.piece ? 2 : half, label: h.piece ? `${label} (a piece of the way)` : label, goal: h.piece ? { x: h.cell.x, y: h.cell.y, z: h.cell.z } : goal, routeTakeoff: h.route, takeoffYaw: h.drawn.guide.yaw };
    return { target, line: `flying ${h.length} blocks under the roof ${h.piece ? `towards ${label}, a piece of the way` : `to ${label}`} along a drawn line (walking would be ~${Math.round(walkMinutes(h.length))} min)`, ...(h.piece ? { piece: true } : {}) };
  };
  const underOptions = (from: Vec3, goalY: number, rockets: number) => {
    const burn = kitBurn();
    // (Track F22: and how late this connection's rockets are seen: the proof flies the line with a burn's end that late)
    return { rockets, ...(burn ? { burn } : {}), margin: d.settings.get('flyMargin'), top: Math.min(319, Math.max(Math.floor(from.y), goalY) + ENTRY_SKY), plan: routePlanner, ...(HOP_WALK.late ? { late: controller.lag.late } : {}) };
  };
  const hopFor = async (from: Vec3, goal: Vec3, label: string, half: number, rockets: number, quiet = false): Promise<{ target: FlyTarget; line: string; piece?: boolean } | undefined> => {
    const fc = { x: Math.floor(from.x), y: Math.floor(from.y + 1e-6), z: Math.floor(from.z) };
    if (entrySky(fc.x, fc.y, fc.z) || entrySky(goal.x, goal.y, goal.z)) return undefined;
    // (Track F9e round 2: the decision is learn/under.ts pickHop, the probes' too: the whole way when it lies in the live
    // model, else a piece of the way the cache knows, ending standing short of where the live model ends)
    const burn = kitBurn();
    const pick = await pickHop(underWorld, liveSim(), from, goal, label, underOptions(from, goal.y, rockets));
    if (!quiet) log.info(burn ? pick.said.replace('under the roof:', `under the roof (rockets that burn ${burnSaid(burn)} ticks):`) : pick.said);
    return hopOffer(pick, goal, label, half);
  };
  /**
   * Track F9e round 2: a piece of the way OUT from under a roof, when the route takeoff found none in the live model: a
   * hop along the way the cache knows to the open sky, as far as the live model goes (learn/under.ts pickExitPiece). The
   * trip asks again where it stands. With `flyCave` and `flyCaveExit` on, as the drawn way out itself.
   */
  const exitPieceFor = async (from: Vec3, label: string, half: number, rockets: number, quiet = false): Promise<{ target: FlyTarget; line: string; piece?: boolean } | undefined> => {
    if (String(d.settings.get('flyCave')) !== 'on' || !d.settings.get('flyCaveExit') || !routeOn()) return undefined;
    const fc = { x: Math.floor(from.x), y: Math.floor(from.y + 1e-6), z: Math.floor(from.z) };
    if (entrySky(fc.x, fc.y, fc.z)) return undefined;
    const pick = await pickExitPiece(underWorld, liveSim(), from, underOptions(from, fc.y, rockets));
    if (!quiet) log.info(pick.said);
    return hopOffer(pick, { x: fc.x, y: fc.y, z: fc.z }, label, half);
  };
  /** Track F9e round 2: a body that has just arrived (a teleport, a respawn, a reconnect) has no chunks round it: a decision under a roof waits for them, this many chunks each way, at most this long. */
  const liveRound = async (from: Vec3): Promise<void> => {
    if (typeof world.isLoaded !== 'function') return;
    const cx = Math.floor(from.x) >> 4;
    const cz = Math.floor(from.z) >> 4;
    const missing = (): number => {
      let n = 0;
      for (let dx = -LIVE_WAIT_CHUNKS; dx <= LIVE_WAIT_CHUNKS; dx++) for (let dz = -LIVE_WAIT_CHUNKS; dz <= LIVE_WAIT_CHUNKS; dz++) if (!world.isLoaded(cx + dx, cz + dz)) n++;
      return n;
    };
    const m0 = missing();
    if (!m0) return;
    const t0 = Date.now();
    while (missing() > 0 && Date.now() - t0 < LIVE_WAIT_MS) await loop.waitTicks(5);
    log.info(`fly: the live model round the body was not loaded (${m0} of ${(2 * LIVE_WAIT_CHUNKS + 1) ** 2} chunks missing): waited ${Date.now() - t0} ms for it (${missing()} still missing)`);
  };
  /**
   * Track BH: how this flight takes off: a ledge (ledgeFor), else the jump along the first heading whose
   * simulated climb meets no solid (the sky check's first, then 30 degrees apart: the Realm's takeoff into a
   * tree canopy, 2026-10-31), else straight up the open column over the bot (verticalFor), else (Track F3) a
   * route out through the planner (routeTakeoffFor), else refused with the line (walk out, or a takeoff site).
   */
  const takeoffFor = async (from: Vec3, target: LandingTarget, sky: SkyCheck, rockets: number, quiet = false, o: { route?: boolean; said?: string[] } = {}): Promise<{ ledge?: Ledge; takeoffYaw?: number; vertical?: number; routeTakeoff?: TakeoffRoute } | { refuse: string }> => {
    // (Track F15: `route` false: no route takeoff (the floor search's takeoffs, kept within its budget; the takeoff on arrival
    // there is the whole chain again); `said`: why the ledge takeoff failed, for the floor search's words)
    const routeFor = (): ReturnType<typeof routeTakeoffFor> => (o.route === false ? Promise.resolve(undefined) : routeTakeoffFor(from, target, rockets, quiet));
    // Track F5a: no takeoff of any family from water (the loop's flags count for the body's own cell)
    const here = loop.state.pos;
    const self = Math.abs(here.x - from.x) < 0.5 && Math.abs(here.y - from.y) < 0.5 && Math.abs(here.z - from.z) < 0.5;
    // (a loop without a world, the unit tests' fakes: the flags alone)
    const lw: Parameters<typeof takeoffWet>[0] | undefined = loop.world;
    const wq = lw ?? { solidAt: () => false };
    const wet = takeoffWet(wq, self ? { pos: from, inWater: loop.state.inWater, inLava: loop.state.inLava } : { pos: from });
    if (wet) {
      if (!quiet) log.info(`fly: no takeoff at ${from.x.toFixed(1)} ${from.y.toFixed(1)} ${from.z.toFixed(1)}: ${wet.replace(/^fly: /, '')}`);
      return { refuse: wet };
    }
    const ledge = await ledgeFor(from, target, sky, rockets, quiet, o.said);
    if (ledge) return { ledge };
    if (!sky.ok) {
      // the 3 x 3 or the run blocked leaves the column over the head (a roof right over it: verticalFor says so at once)
      return (await verticalFor(from, target, rockets, quiet)) ?? (await routeFor()) ?? { refuse: sky.line };
    }
    const cz = cruiseHeight(from, target, skyTop, { clearance: d.settings.get('flyClearance'), margin: d.settings.get('flyMargin'), maxClimb: d.settings.get('flyMaxClimb') });
    const yaws = [0, 30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180].map((o) => sky.yaw + o);
    // Track BL: any heading (the climbing turn back towards the goal is part of the simulation, its corridor checked with unknown-is-not-air)
    const r = await jumpTakeoff(simDeps(true), from, target, simOptions(cz.y), rockets, yaws);
    if (r.yaw !== undefined && r.yaw === sky.yaw) return { takeoffYaw: r.yaw };
    if (!quiet) log.info(`fly: the simulated climb: ${r.line}`);
    if (r.yaw !== undefined) return { takeoffYaw: r.yaw };
    const v = await verticalFor(from, target, rockets, quiet);
    if (v) return v;
    const rt = await routeFor();
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
    /** Track F15: a floor the walk reaches (floors.ts), not an open-sky cell: its cells and edge cells. */
    floor?: { cells: number; edges: number };
  }
  // (Track F22: `hop_ask`: a walk's re-check under a roof: a hop may be flown from about here; the walk stops and the hop is decided standing)
  type AutoFly = { kind: 'fly'; target: FlyTarget; line: string; said?: string | undefined; piece?: boolean } | { kind: 'site'; site: TakeoffSite; line: string } | { kind: 'walk_out'; roof: string } | { kind: 'hop_ask'; why: string };
  /**
   * Track F22 (learn/standing.ts): a decision made with the body held and at rest: the hold is a process of the trip's own
   * rank that stands (tasks/process/stand.ts), the decision is asked from where the body stands then, an answer whose
   * line begins more than DRAWN_START_OFF from the body when it comes is asked for once more, and a second stale answer
   * is given up with a line. `auto`: a trip the bot makes by itself (the home return). Without a process manager that
   * can hold (the unit tests' fakes), or with the switch off: asked from where the body is, as before.
   */
  const standing = async <T>(what: string, auto: boolean, decide: (from: Vec3) => Promise<T | undefined>, startOf: (answer: T) => Vec3 | undefined): Promise<T | undefined> => {
    const from = position();
    if (!from) return undefined;
    if (!HOP_WALK.stand || typeof (processes as { add?: unknown }).add !== 'function') return decide(from);
    // (who took the body from the stand, for the lines: the process control went to)
    let took: string | undefined;
    const off = typeof (processes as { onControl?: unknown }).onControl === 'function' ? processes.onControl((e) => {
      if (e.to && e.to !== 'stand') took = e.to;
    }) : undefined;
    const deps: StandingDeps = {
      hold: () => processes.add(new StandProcess({ label: `deciding ${what}`, still: () => loop.setCommand({ forward: 0, strafe: 0, jump: false, sneak: false, sprint: false }), auto })),
      position,
      still: () => loop.state.onGround && Math.hypot(loop.state.vel.x, loop.state.vel.z) < 0.003 && Math.abs(loop.state.vel.y) < 0.1,
      waitTicks: (n) => loop.waitTicks(n),
      log: (m) => log.info(m),
      holder: () => (processes.active && processes.active.name !== 'stand' ? processes.active.name : took),
    };
    try {
      return (await decideStanding(deps, what, DRAWN_START_OFF, decide, startOf)).answer;
    } finally {
      off?.();
    }
  };
  /** Track F22: where an automatic flight's answer was proven from: the first point of its drawn line (a hop, a piece, a drawn way out); any other answer holds from anywhere near. */
  const provenFrom = (f: AutoFly): Vec3 | undefined => {
    const line = f.kind === 'fly' ? f.target.routeTakeoff?.guide?.line : undefined;
    return line?.drawn ? line.points[0] : undefined;
  };
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
   * Track F15 (docs/flight.md "Takeoff from a floor the walk reaches"): the trip's last try, once the walk out has found no
   * way and no glide down was found either: a floor the walk reaches (up a ladder, through a hatch, a door, a stair) with a
   * ledge whose takeoff clears (floors.ts searchFloors, its own bounds). None: `said` says why, for the owner.
   */
  const floorSite = async (from: Vec3, goalTarget: FlyTarget, rockets: number): Promise<{ site?: TakeoffSite; line: string; said?: string }> => {
    const nav = probeNavOf(pve.mover);
    if (!nav) return { line: 'no probe planner', said: 'no probe planner' };
    const total = hdist(from, goalTarget);
    const ratio = d.settings.get('flyPreferRatio');
    const fl = await searchFloors<TakeoffSite['takeoff']>(
      {
        q: cell,
        probe: (goal, at, b) => probePath(nav, goal, at, { ...b, noLongFalls: true, body: true }),
        takeoff: async (at) => {
          const said: string[] = [];
          const tk = await takeoffFor(at, goalTarget, skyHere(at, goalTarget), rockets, true, { route: false, said });
          if ('refuse' in tk) return { ok: false, why: `${tk.refuse.replace(/^fly: /, '').replace(/; walk outside first$/, '')}${said.length ? `; ${said.join('; ')}` : ''}` };
          return { ok: true, takeoff: tk, how: tk.ledge ? `a ledge heading ${Math.round(tk.ledge.yaw)}` : tk.vertical !== undefined ? `straight up ${tk.vertical}, then heading ${Math.round(tk.takeoffYaw ?? 0)}` : `the jump heading ${Math.round(tk.takeoffYaw ?? 0)}` };
        },
        worth: (walk, at) => preferSite(total, walk, hdist(at, goalTarget), ratio),
        now: () => Date.now(),
        yieldNow: () => new Promise((r) => setImmediate(r)),
      },
      from,
    );
    if (fl.site) {
      const f = fl.site;
      const tk = f.takeoff;
      const site: TakeoffSite = { x: f.x, feet: f.feet, z: f.z, walk: f.walk, flyDist: hdist({ x: f.x + 0.5, z: f.z + 0.5 }, goalTarget), takeoff: tk, floor: { cells: f.cells, edges: f.edges } };
      return { site, line: fl.line };
    }
    return { line: fl.line, said: fl.said ?? fl.line };
  };
  /**
   * Track BF: the flight's target for a goal (the landing plan: the goal itself, a confirmed cell, the
   * nearest dry ground, or the goal held high while its ground is not loaded) and the reply line.
   */
  const planFlight = async (from: Vec3, goalBlock: Vec3, label: string, half: number, exact: boolean, hint?: LandingHint): Promise<{ target: FlyTarget; line: string; said: string | undefined }> => {
    const plan = await landingFor(goalBlock, label, exact ? half : undefined, hint);
    const target = targetFromPlan(plan, { label, goal: goalBlock, half, ...(exact ? { exact: half } : {}), ...(hint ?? {}) });
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
  const autoFly = async (goalBlock: Vec3, label: string, half: number, o: { site?: boolean; quiet?: boolean; walking?: boolean; auto?: boolean } = {}): Promise<AutoFly | undefined> => {
    if (!d.settings.get('autoFly')) return undefined;
    const from = position();
    if (!from || controller.active) return undefined;
    // Track F22: under a roof the flight is decided with the body held and at rest, from where it stands then (a line
    // under a roof is proven from the body's place, and another process walked the body on while the decision ran: the
    // Realm, 3 to 21 blocks). Not for a walk's own re-check (`walking`: that one asks only whether a hop may be there)
    // (the cheap questions first: a trip too near to fly, or with no elytra or no rocket at hand, is not stood for; the
    // decision itself asks them again, with the spare elytra and the boxes)
    const fc = { x: Math.floor(from.x), y: Math.floor(from.y + 1e-6), z: Math.floor(from.z) };
    const roofed = !o.walking && dim() === OVERWORLD && String(d.settings.get('flyCave')) === 'on' && !entrySky(fc.x, fc.y, fc.z);
    const far = (): boolean => {
      const dist = hdist(from, { x: goalBlock.x + 0.5, z: goalBlock.z + 0.5 });
      return dist > d.settings.get('flyMin') || (hopOn() && dist > HOP_ASK_MIN);
    };
    const kitted = (): boolean => {
      const k = readKit(inv, memory());
      return (k.elytraSlot >= 0 || k.elytraWorn) && (k.rockets >= d.settings.get('fireworksMin') || k.boxRockets > 0 || (supplyOf(d.task)?.carried(ROCKET) ?? 0) > 0);
    };
    if (roofed && far() && kitted()) return standing(`the flight to ${label}`, o.auto === true, (at) => autoFlyFrom(at, goalBlock, label, half, o), provenFrom);
    return autoFlyFrom(from, goalBlock, label, half, o);
  };
  /** The automatic flight decided from `from` (the body's place; `autoFly` holds the body there first under a roof). */
  const autoFlyFrom = async (from: Vec3, goalBlock: Vec3, label: string, half: number, o: { site?: boolean; quiet?: boolean; walking?: boolean }): Promise<AutoFly | undefined> => {
    if (controller.active) return undefined;
    const goalTarget: FlyTarget = { x: goalBlock.x + 0.5, z: goalBlock.z + 0.5, top: goalBlock.y, half, label };
    const distance = hdist(from, goalTarget);
    // (Track F9e: a hop is measured by its line, not by the straight distance: two places 100 blocks apart under a roof
    // may be 500 blocks of passage from each other. It is asked from HOP_ASK_MIN blocks on; every other flight from flyMin)
    const hopping = hopOn() && distance > HOP_ASK_MIN && dim() === OVERWORLD;
    if (distance <= d.settings.get('flyMin') && !hopping) return undefined;
    const spare = await spareFor(distance, o.walking === true); // Track K4: a better elytra to hand first (nothing moves while a walk runs)
    let k = readKit(inv, memory());
    const boxed = supplyOf(d.task)?.carried(ROCKET) ?? 0; // rockets in the other carried boxes come out before the takeoff
    if (!kitReady(k, d.settings.get('toolWearLimit'), boxed).ok) return undefined;
    if (k.rockets < d.settings.get('fireworksMin') && k.boxRockets === 0 && boxed === 0) return undefined;
    if (dim() !== OVERWORLD && !(dim() === NETHER && ceilingClear(from, goalTarget))) return undefined;
    // Track F20: a trip the elytra does not cover is walked, and the owner is told why (a far goal: no elytra covers it)
    const cover = coverOf(k, distance);
    if (!cover.ok) {
      noCover(cover, distance, label, `${spare}; walking`, o.quiet);
      return undefined;
    }
    // Track F9e: from under a roof to a goal under a roof, the hop first: a line drawn through the cave and proven from
    // standing to standing (the owner: underground to underground is tried before getting out). None proven: as before
    // (Track F9e round 2: under a roof the live model round the body is waited for first: a body that has just arrived has none)
    const fc0 = { x: Math.floor(from.x), y: Math.floor(from.y + 1e-6), z: Math.floor(from.z) };
    const roofed = dim() === OVERWORLD && String(d.settings.get('flyCave')) === 'on' && !entrySky(fc0.x, fc0.y, fc0.z);
    if (roofed) await liveRound(from);
    // Track F22: a walking body does not ask for a hop's proof (its answer would be for a place the body has left): it
    // asks whether a hop may be flown from about here (the way and a line, nothing simulated); the walk stops there and
    // the hop is decided once, standing (watchWalk)
    if (hopping && roofed && o.walking && HOP_WALK.scout) {
      if (!entrySky(goalBlock.x, goalBlock.y, goalBlock.z)) {
        const burn = kitBurn();
        const sc = scoutHop(underWorld, from, goalBlock, { ...(burn ? { burn } : {}), top: underOptions(from, goalBlock.y, 0).top });
        if (sc.may) return { kind: 'hop_ask', why: sc.why };
      }
    } else {
      const hop = hopping ? await hopFor(from, goalBlock, label, half, flightRockets(k), o.quiet) : undefined;
      if (hop) return { kind: 'fly', ...hop };
    }
    if (distance <= d.settings.get('flyMin')) return undefined;
    // the sky first (cheap); the landing cell (up to six probe plans) only when a takeoff is possible at all
    const sky = skyHere(from, goalTarget);
    // Track BH: a ledge takeoff where the jump takeoff is refused (an overhang, a blocked run) or the start is a small platform
    const tk = await takeoffFor(from, goalTarget, sky, flightRockets(k), o.quiet);
    if ('refuse' in tk) {
      // Track F9e round 2: under a roof with no way out in the live model: a piece of the way the cache knows, flown as far
      // as the live model goes; the trip asks again where it stands
      const piece = roofed ? await exitPieceFor(from, label, half, flightRockets(k), o.quiet) : undefined;
      if (piece) return { kind: 'fly', ...piece };
      refusedTakeoffs.push({ x: from.x, z: from.z, at: Date.now() });
      // Track BL: a takeoff site within walking distance (any direction) before the walk out towards the goal
      if (o.site !== false) {
        const s = await takeoffSite(from, goalTarget, flightRockets(k));
        log.info(`fly: the takeoff here is refused (${tk.refuse.replace(/^fly: /, '').replace(/; walk outside first$/, '')}); the takeoff-site search: ${s.line}`);
        if (s.site) return { kind: 'site', site: s.site, line: `walking ${Math.round(s.site.walk)} blocks to take off from ${s.site.x} ${s.site.feet} ${s.site.z}, then flying (${Math.round(distance)} blocks; walking would be ~${Math.round(walkMinutes(distance))} min)` };
      }
      return { kind: 'walk_out', roof: tk.refuse };
    }
    // Track F13: nothing loose and the box's refill cannot be made here: no flight (the walk, as for a kit that is not ready)
    const noRefill = refillRefusal(k);
    if (noRefill) {
      if (!o.quiet) log.info(`fly: no automatic flight to ${label}: ${noRefill.replace(/^fly: /, '')}`);
      return undefined;
    }
    // Track BF: the landing (a cell of the live model with a confirmed walk, or the goal held high until its ground loads)
    const f = await planFlight(from, goalBlock, label, half, false);
    // Track F15 (docs/flight.md "A landing where the body stands is not flown"): the landing found is where the body already
    // stands (the Realm, 2026-11-15: the walk's re-check out from under a roof 1 block from the cell it had just landed on, a
    // flight "(1 blocks)" round on 2 rockets back onto it): no flight; the spot counts as a refused takeoff, so the re-check
    // does not ask again there
    if (landingHere(from, f.target)) {
      refusedTakeoffs.push({ x: from.x, z: from.z, at: Date.now() });
      log.info(`fly: no flight to ${label}: its landing ${fmt(f.target)} is ${hdist(from, f.target).toFixed(1)} blocks from the body by the plane and ${(f.target.top - from.y).toFixed(0)} by height (within ${LAND_HERE_H} and ${LAND_HERE_DY}): walking`);
      return undefined;
    }
    // Track F20: asked again with the landing known (a goal whose ground is not loaded yet is held over: counted)
    // Track F21: and with the cruise the flight will plan (FlyProcess plannedCruise): the same question as its preparation, so a
    // walk's re-check does not start a flight the preparation refuses or one that lands as worn after its takeoff
    const pc = plannedCruise(from, f.target, skyTop, d.settings);
    const cruise = { climb: Math.max(0, pc.cruiseY - from.y), over: cruiseOver(pc.cruiseY, from.y, f.target.top), arrive: plannedArrival(from, f.target, pc.cruiseY, skyTop, d.settings) };
    let held = coverOf(k, hdist(from, f.target), f.target.hold === true, cruise);
    let heldSpare = '';
    if (!held.ok) {
      // Track K4: the hold over the goal and the cruise are counted now: a better elytra for them
      heldSpare = await spareFor(hdist(from, f.target), o.walking === true, f.target.hold === true, cruise.climb, cruise.over, cruise.arrive);
      k = readKit(inv, memory());
      held = coverOf(k, hdist(from, f.target), f.target.hold === true, cruise);
    }
    if (!held.ok) {
      noCover(held, hdist(from, f.target), label, `${heldSpare}; walking`, o.quiet);
      return undefined;
    }
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
    // no_glide too: the server let no glide start (rockets that fired nothing at the takeoff; the Realm, 2026-11-09, the trip
    // home ended there 520 blocks short): the walk goes on and looks for another takeoff on the way
    if (r.ok || r.reason === 'landed_off' || r.reason === 'roof' || r.reason === 'no_landing' || r.reason === 'no_glide' || r.reason?.startsWith('fly: no open sky')) return walk();
    if (r.reason === 'interrupted' || r.reason === 'replaced') return Promise.resolve({ ok: false, reason: 'interrupted' });
    // Track F20: the elytra did not cover the trip after all (the count with the elytra on the back), or the flight came down
    // on the worn landing short of its goal: the body stands on safe ground and the trip goes on on foot, said once
    if (isTripCoverLine(r.reason) || r.reason === 'elytra_worn') {
      d.chat.say(`${isTripCoverLine(r.reason) ? r.reason! : flyEndLine(r)}; walking the rest`);
      return walk();
    }
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
    // Track F20: a new trip the elytra does not cover from where the flight is: the flight is not sent on; it lands here and
    // the new trip starts from the ground (where the takeoff's question sends it on foot)
    const cruiseY = from ? cruiseHeight(from, target, skyTop, { clearance: d.settings.get('flyClearance'), margin: d.settings.get('flyMargin'), maxClimb: d.settings.get('flyMaxClimb') }).y : undefined;
    // (Track F21: from the height the flight will fly at over the goal: the flight's worn limit there and the spiral after a
    // hold, from the height it reaches the goal at: the calibration)
    const flyY = from ? Math.max(cruiseY ?? from.y, from.y) : 0;
    const cover = from ? coverOf(readKit(inv, memory()), hdist(from, target), target.hold === true, { over: cruiseOver(flyY, target.top, target.top), arrive: plannedArrival({ ...from, y: flyY }, target, flyY, skyTop, d.settings) }) : undefined;
    if (from && cover && !cover.ok) {
      noCover(cover, hdist(from, target), label, '; landing here first');
      old.land('stopped');
      return undefined;
    }
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
    const rockets = k.rocketsHotbar || k.rockets; // a glide down refills nothing (FlyProcess.prepare)
    const plan = await landingFor(goalBlock, label, undefined);
    const base = { label, goal: goalBlock, half };
    let target: FlyTarget | undefined;
    let why: string | undefined;
    if ((plan.kind === 'goal' || plan.kind === 'cell') && dist <= GLIDE_SIM_RANGE) {
      const g = await planGlideDown(simDeps(), from, plan.target, { minDrop: d.settings.get('glideDownMinDrop'), minDistance: d.settings.get('glideDownMinDistance'), rockets, flight: { margin: d.settings.get('flyMargin'), goArounds: d.settings.get('flyGoArounds'), ...(openBurn() ? { burn: openBurn()! } : {}) } });
      log.info(`fly: ${g.line}`);
      if (g.ok) target = { ...targetFromPlan(plan, base), ledge: g.ledge, glide: true };
      else why = g.why;
    } else if (plan.kind === 'fallback' || plan.kind === 'none') {
      why = `no landing near it with a walking path (${plan.kind === 'fallback' ? plan.why : 'no dry ground known'})`;
    } else if (kitReady(k, wear).ok && flightRockets(k) > 0) {
      // far (or its ground not loaded): a flight with rockets, the landing held until its ground loads, the takeoff simulated
      const t0 = targetFromPlan(plan, base);
      const sky = skyHere(from, t0);
      const tk = await takeoffFor(from, t0, sky, flightRockets(k)); // (Track F13: a powered flight refills first)
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
  /**
   * A takeoff that came straight down (the Realm, 2026-11-09: a rocket that fired nothing at tick 8 and the flight over 15
   * ticks later where it began; the whole trip then went on foot): flown once more from where the body stands.
   */
  const retryShort = async (r: FlyOutcome, at: Vec3 | undefined, g: Vec3, label: string, half: number): Promise<FlyOutcome> => {
    const here = position();
    if (r.reason !== 'landed_off' || !at || !here) return r;
    const came = hdist(at, here);
    if (came > SHORT_FLIGHT || hdist(here, { x: g.x + 0.5, z: g.z + 0.5 }) <= 2 * SHORT_FLIGHT) return r;
    const again = await autoFly(g, label, half, { site: false, quiet: true });
    if (again?.kind !== 'fly') return r;
    log.info(`fly: the flight came down ${Math.round(came)} blocks from its start; flying again`);
    d.chat.say(`the flight came down ${Math.round(came)} blocks from its start; flying again`);
    return start(again.target).result;
  };
  /**
   * The walk after a flight that came down short (a roof in the climb out of a cave, a takeoff that fell back): re-checked
   * for a takeoff on the way like any long walk (the Realm, 2026-11-09: the climb out of the cave hit its roof and the
   * bot walked all 1072 blocks home); the takeoff it came down from counts as refused.
   */
  const watched = (at: Vec3 | undefined, goal: () => Vec3 | undefined, label: string, half: number, walk: () => Promise<SkillResult>, legWalk: (leg: Goal) => Promise<SkillResult>) => (): Promise<SkillResult> => {
    const here = position();
    if (at && here && hdist(at, here) <= SHORT_FLIGHT) refusedTakeoffs.push({ x: at.x, z: at.z, at: Date.now() });
    return watchWalk(goal, label, half, walk, walk, legWalk);
  };
  const runAuto = async (f: AutoFly, goal: () => Vec3 | undefined, label: string, half: number, walk: () => Promise<SkillResult>, legWalk: (leg: Goal) => Promise<SkillResult>, pieces = 0, lost = 0): Promise<SkillResult> => {
    const g0 = goal();
    if (!g0) return walk();
    if (f.kind === 'walk_out') return walkOut(g0, label, half, f, walk, legWalk);
    // (Track F22: a walk's own answer, never a trip's first: the walk, watched, stops for it)
    if (f.kind === 'hop_ask') return watchWalk(goal, label, half, walk, walk, legWalk);
    if (f.kind === 'fly') {
      // Track F9e round 2 (the Realm): a drawn line is proven from where the body stood when the decision began. Another
      // process may walk the body on while the decision runs (a chore's walk, for the seconds of the live model's wait and
      // the proofs: 6 blocks on the Realm, and the takeoff found no glide): such a line is not flown from anywhere else. The
      // walk, watched, asks again from where it gets to
      const line0 = f.target.routeTakeoff?.guide?.line;
      const p0 = line0?.drawn ? line0.points[0] : undefined;
      const here0 = position();
      const moved = p0 && here0 ? Math.hypot(here0.x - p0.x, here0.y - p0.y, here0.z - p0.z) : 0;
      if (moved > DRAWN_START_OFF) {
        log.info(`fly: the body is ${moved.toFixed(1)} blocks from where ${guideSaid(line0!)} was proven (it was walked on while the decision ran): not flown; the walk to ${label} asks again`);
        return watchWalk(goal, label, half, walk, walk, legWalk);
      }
      sayFlight(f);
      const at = position();
      const health0 = world.self.health;
      const r = await retryShort(await start(f.target).result, at, g0, label, half);
      // Track F9e round 2: a piece of a way stood where it was to: the trip asks again at once from there (the next piece, the
      // rest of the way as one hop, the way out), PIECES_MAX times at most; else the walk, watched, as after any flight
      if (f.piece && r.ok && pieces < PIECES_MAX) {
        const again = await autoFly(goal() ?? g0, label, half);
        if (again) return runAuto(again, goal, label, half, walk, legWalk, pieces + 1, lost);
      }
      // Track F22: a hop that lost its line braked and came down under the roof short of its touchdown (`roof`). The trip
      // used to walk on from there and ask again a re-check later (the Realm: 71 and 46 blocks of walk, a witch on one of
      // them): now it asks at once from where the body stands, as after a piece: when the flight cost no health and got
      // somewhere (a line lost at its start is lost there again), HOP_LOST_AGAIN times a trip at most
      const here = position();
      const hurt = health0 !== undefined && world.self.health !== undefined && world.self.health < health0 - 0.5;
      if (HOP_WALK.again && f.target.routeTakeoff?.hop && !r.ok && r.reason === 'roof' && lost < HOP_LOST_AGAIN && pieces < PIECES_MAX && at && here && !hurt && Math.hypot(here.x - at.x, here.y - at.y, here.z - at.z) >= HOP_LOST_FAR) {
        log.info(`fly: the hop to ${label} lost its line ${Math.round(hdist(at, here))} blocks from its start and came down with no damage: asked again from where the body stands (${lost + 1} of ${HOP_LOST_AGAIN} a trip)`);
        const again = await autoFly(goal() ?? g0, label, half);
        if (again) return runAuto(again, goal, label, half, walk, legWalk, pieces + 1, lost + 1);
      }
      return afterFlight(r, watched(at, goal, label, half, walk, legWalk));
    }
    d.chat.say(f.line);
    const s = f.site;
    log.info(`fly: walking ${Math.round(s.walk)} blocks to the takeoff site ${s.x} ${s.feet} ${s.z}${s.floor ? ` (a floor the walk reaches: ${s.floor.cells} cells, ${s.floor.edges} on an edge)` : ''}, then flying ${Math.round(s.flyDist)} blocks to ${label}`);
    const r = await legWalk({ type: 'block', p: { x: s.x, y: s.feet, z: s.z } });
    if (!r.ok && r.reason === 'interrupted') return r;
    const g = goal() ?? g0;
    const again = r.ok ? await autoFly(g, label, half, { site: false }) : undefined;
    if (again?.kind === 'fly') {
      sayFlight(again);
      const at = position();
      return afterFlight(await retryShort(await start(again.target).result, at, g, label, half), watched(at, goal, label, half, walk, legWalk));
    }
    const here = position();
    if (here) refusedTakeoffs.push({ x: here.x, z: here.z, at: Date.now() });
    const why = !r.ok ? `the walk there failed (${r.reason ?? '?'})` : again?.kind === 'walk_out' ? again.roof.replace(/^fly: /, '').replace(/; walk outside first$/, '') : 'no flight from there';
    log.info(`fly: no takeoff from the site ${s.x} ${s.feet} ${s.z}: ${why}; walking to ${label}`);
    d.chat.say(`fly: no takeoff from ${s.x} ${s.feet} ${s.z} after all (${why}); walking to ${label}`);
    return watchWalk(goal, label, half, walk, walk, legWalk);
  };
  /** Track F22: `n` cells of air from the body's feet cell up (a jump's room to take a glide), by the live model. */
  const headRoom = (n: number): boolean => {
    const p = loop.state.pos;
    const x = Math.floor(p.x);
    const y = Math.floor(p.y + 1e-6);
    const z = Math.floor(p.z);
    for (let k = 1; k < n; k++) if (cell(x, y + k, z) === true) return false;
    return true;
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
    // (Track F9e: with the hop on, a walk under a roof is watched from a hop's least distance on, not from flyMin: a hop
    // that is not proven from the start is asked again as the walk gets on, and flown from where one is proven)
    const least = (): number => (hopOn() ? Math.min(HOP_ASK_MIN, d.settings.get('flyMin')) : d.settings.get('flyMin'));
    if (!d.settings.get('autoFly') || every <= 0 || !from || !g0 || hdist(from, goalAt(g0)) <= least() + every) return walking();
    // Track F22: the walk's OWN process is watched: the newest user process the walk added. It was whatever had the body
    // when the walk was asked for: with a fight on at that moment (the Realm: a witch) that was the guard, the walk's
    // process was never the one looked for, and the walk went 631 blocks without asking again
    const users0 = HOP_WALK.watch && typeof (processes as { userProcesses?: unknown }).userProcesses === 'function' ? new Set(processes.userProcesses()) : undefined;
    const res = walking();
    const own = users0 ? addedSince(users0, processes.userProcesses()) : undefined;
    const proc = own ?? (processes as { active?: unknown }).active;
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
      if (hdist(p, goalAt(g)) <= least()) return;
      const k = readKit(inv, memory());
      const kit = kitReady(k, d.settings.get('toolWearLimit')).ok && (k.rockets >= d.settings.get('fireworksMin') || k.boxRockets > 0);
      const due = state.due(p, kit, openAbove(Math.floor(p.x), Math.floor(p.z), Math.floor(p.y)), every, Date.now());
      if (!due) return;
      busy = true;
      void (async () => {
        try {
          const f = await autoFly(g, label, half, { quiet: true, walking: true });
          if (done || !f) return;
          if (f.kind === 'walk_out') {
            state.refused(p, Date.now());
            return;
          }
          // a safe spot to stop (not mid-jump, on a ladder or in water): up to 3 s more of the walk
          // (Track F22: for a hop, with a jump's head room over it: a stop under a low roof is a stop for nothing)
          const stopHere = (): boolean => safeStop() && (f.kind !== 'hop_ask' || headRoom(HOP_STOP_HEADROOM));
          for (let i = 0; i < 12 && !stopHere() && !done; i++) await loop.waitTicks(5);
          if (done || !stopHere() || processes.active !== proc) return;
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
    if (found.kind === 'hop_ask' || (found.kind === 'fly' && found.target.routeTakeoff?.hop)) {
      // Track F9e: a hop begins where the body stands: drawn and proven from where the walk stopped
      // (Track F22: once, with the body held and at rest there: learn/standing.ts)
      const k = readKit(inv, memory());
      const again = hopOn() ? await standing(`the hop to ${label}`, false, (at) => hopFor(at, g, label, half, flightRockets(k)), (a) => provenFrom({ kind: 'fly', ...a })) : undefined;
      if (!again) {
        state.refused(position() ?? here, Date.now());
        log.info('fly: no hop from where the walk stopped; walking on');
        return watchWalk(goal, label, half, rest, rest, legWalk);
      }
      return runAuto({ kind: 'fly', ...again }, goal, label, half, rest, legWalk);
    }
    if (found.kind === 'fly') {
      // the takeoff again from where the walk stopped (it walked on while the landing was searched)
      const k = readKit(inv, memory());
      const tk = await takeoffFor(here, found.target, skyHere(here, found.target), flightRockets(k));
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
  /** Track F15: where a floor search led to a floor and the trip did not arrive (FLOOR_ONCE_R blocks, FLOOR_ONCE_MS): not asked again there. */
  const floorTried: { x: number; z: number; at: number }[] = [];
  /**
   * Track F15 (docs/flight.md "Takeoff from a floor the walk reaches"): the trip had no takeoff where it stood, the walk out
   * found no way (`unreachable`, no progress, no path) and no glide down was found: the floors the walk reaches from where
   * the body stands now are searched (floorSite). A floor found: walked to and taken off from by the `site` path, as any
   * takeoff site. None: the reply's note says all three, the takeoffs first (noTakeoffNote). Once a place: a floor search
   * that led to a floor from which the trip did not arrive is not asked again within FLOOR_ONCE_R blocks for FLOOR_ONCE_MS,
   * so a trip cannot go round between a floor and a failing walk (a trip that arrived leaves no mark). Any other end of the walk is returned as it is: every trip that flies or walks today is untouched.
   */
  const floorFallback = async (r: SkillResult, roof: string, goalBlock: Vec3, label: string, half: number, walk: () => Promise<SkillResult>, legWalk: (leg: Goal) => Promise<SkillResult>): Promise<SkillResult> => {
    if (!noWay(r) || !d.settings.get('autoFly')) return r;
    const from = position();
    if (!from || controller.active || dim() !== OVERWORLD) return r;
    const busy = processes.active?.name;
    if (busy === 'flee' || busy === 'guard' || busy === 'fire' || busy === 'surface' || pve.combat.target) return r;
    const k = readKit(inv, memory());
    const boxed = supplyOf(d.task)?.carried(ROCKET) ?? 0;
    if (!kitReady(k, d.settings.get('toolWearLimit'), boxed).ok) return r;
    if (k.rockets < d.settings.get('fireworksMin') && k.boxRockets === 0 && boxed === 0) return r;
    const now = Date.now();
    const tried = floorTried.find((p) => now - p.at < FLOOR_ONCE_MS && hdist(from, p) <= FLOOR_ONCE_R);
    if (tried) {
      log.info(`fly: the walk to ${label} found no way; a floor the walk reaches was tried from here ${Math.round((now - tried.at) / 1000)} s ago: not again`);
      return noTakeoffNote(r, roof, `one was tried from here ${Math.round((now - tried.at) / 1000)} s ago`);
    }
    const goalTarget: FlyTarget = { x: goalBlock.x + 0.5, z: goalBlock.z + 0.5, top: goalBlock.y, half, label };
    const s = await floorSite(from, goalTarget, flightRockets(k));
    log.info(`fly: the walk to ${label} ended ${r.ok ? 'ok' : r.reason} and no glide down was found; the floors the walk reaches from ${fmt(from)}: ${s.line}`);
    if (!s.site) return noTakeoffNote(r, roof, s.said ?? s.line);
    const mark = { x: from.x, z: from.z, at: now };
    floorTried.push(mark);
    const distance = hdist(from, goalTarget);
    const site = s.site;
    const end = await runAuto({ kind: 'site', site, line: `walking ${Math.round(site.walk)} blocks to take off from ${site.x} ${site.feet} ${site.z}, then flying (${Math.round(distance)} blocks; walking would be ~${Math.round(walkMinutes(distance))} min)` }, () => goalBlock, label, half, walk, legWalk);
    // arrived: the floor did its work and a later trip from here may take it again; any other end is remembered
    if (end.ok) floorTried.splice(floorTried.indexOf(mark), 1);
    return end;
  };
  const walk0 = pve.walk.bind(pve);
  // ---- Track F17: windows beside the walk (docs/flight.md "Windows beside the walk (Track F17)"; decisions/0091) ----------
  /** Track F17: `flyCaveWindows` (with `flyCave on` and the route planner): a walk along a handed way flies the stretches a proven window is faster on. */
  const wayWindowsOn = (): boolean => caveOn() && d.settings.get('flyCaveWindows') === true && routeOn();
  /** Track F17: the proof of a way's window from `from` in the route worker, on the rockets at hand and their burn (as the hop plans). */
  const proveWayWindow = async (w: WayWindow, from: Vec3): Promise<{ plan: RoutePlan; loose: number; stretch: ReturnType<typeof wayStretchOptions> }> => {
    // (a window beside the walk refills nothing: it is proven on the rockets at hand, kit.ts rocketsForWindow)
    const loose = rocketsForWindow(readKit(inv, memory()), false);
    const kit = kitBurn();
    const stretch = wayStretchOptions(w.win, kit);
    const req = windowRequest(w.win, from, loose, { margin: stretch.margin ?? w.win.margin, maxMs: WAY_PROVE_MS, maxNodes: WAY_PROVE_NODES, ...(stretch.riskCost !== undefined ? { riskCost: stretch.riskCost } : {}), ...(stretch.pieces !== undefined ? { pieces: stretch.pieces } : {}), ...(kit ? { kit } : {}) });
    return { plan: await routePlanner(req), loose, stretch };
  };
  const cellLine = (p: { x: number; y: number; z: number }): string => `${Math.floor(p.x)} ${Math.floor(p.y + 1e-6)} ${Math.floor(p.z)}`;
  /**
   * Track F17: the walk along a handed way (W2) with a scout beside it (skills/fly/cave/waywin.ts WayScout): a window a few
   * seconds ahead of the body is proven in the route worker while the body walks; a proof that keeps the window's margin
   * (wayProven) and whose flight with its overhead and the landing's hostiles beats the walk's price (wayGate) arms it; the
   * body on its start, standing, the walk is stopped, the window proven again from where the body stands when it stopped
   * more than WAY_START_OFF off, and flown (commands-corridor.ts flyWayWindow); the walk then goes on along the same way
   * from the node the body stands on. Nothing is done while another process (the guard, a flee, a fight) has the body or a
   * flight is in the air, with a hostile within WAY_MOB_REACH, without a ready kit, after WAY_BAILS_MAX bail-outs, or once
   * the health is under CORRIDOR_HEALTH_MIN. A proof that fails or does not pay costs the worker's time, never the walk's.
   */
  const wayWalk = async (goal: Goal, opts: GotoOptions, label: string | undefined, way: readonly PathNode[]): Promise<SkillResult> => {
    const name = label?.replace(/^walking (to )?/, '') ?? 'the goal';
    // (the walk priced as the landing search priced it: the probe's ticks at PATH_PACE)
    const drop = probeNavOf(pve.mover)?.planOptions({ allowBreak: false, allowPlace: false, sprint: false }).costs?.irreversibleDrop ?? DEFAULT_COSTS.irreversibleDrop;
    const price = wayPrice(way, drop, PATH_PACE);
    const wiring = corridorWiring();
    const scout = new WayScout(way, { solid: wiring.solid, ...(wiring.floor ? { floor: wiring.floor } : {}), loaded: (x, z) => wiring.loaded(x >> 4, z >> 4), price });
    let windows = 0;
    let landed = 0;
    let unsafe = false;
    for (;;) {
      const res = walk0(goal, { ...opts, way }, label);
      const proc = processes.active;
      if (!proc || unsafe) return res;
      let node = (() => {
        const p = position();
        return p ? (wayAt(way, p, 0, 8) ?? 0) : 0;
      })();
      let proving = false;
      let done = false;
      let armed: { w: WayWindow; plan: RoutePlan; stretch: ReturnType<typeof wayStretchOptions>; line: string } | undefined;
      let stopFor: typeof armed;
      const mobsAt = (p: Vec3): readonly LandMob[] => landMobsNear(world.entities.values(), pve.mobs, p, LAND_MOBS.scan);
      const timer = setInterval(() => {
        if (done || stopFor) return;
        const p = position();
        if (!p || processes.active !== proc || controller.active || pve.combat.target) return;
        const at = wayAt(way, p, Math.max(0, node - 4));
        if (at !== undefined && at > node) node = at;
        if (armed) {
          const s = nodeFeet(way[armed.w.start]!);
          if (hdist(p, s) <= WAY_ARM_NEAR && Math.abs(p.y - s.y) < 0.6 && safeStop()) {
            stopFor = armed;
            armed = undefined;
            processes.stop(proc, 'replaced');
          } else if (node > armed.w.start + 1 && hdist(p, s) > WAY_NEAR) {
            log.info(`fly: the window from ${cellLine(s)} was passed by (the walk is ${(scout.along[node]! - scout.along[armed.w.start]!).toFixed(0)} blocks past its start); walking on`);
            armed = undefined;
          }
          return;
        }
        if (proving) return;
        const k = readKit(inv, memory());
        if (!kitReady(k, d.settings.get('toolWearLimit')).ok || rocketsForWindow(k, false) === 0) return;
        const w = scout.next(node);
        if (!w) return;
        proving = true;
        const from = w.from;
        void proveWayWindow(w, from)
          .then(({ plan, loose, stretch }) => {
            if (done) return;
            const along = `${scout.along[w.start]!.toFixed(0)} blocks along the way, ${w.win.blocks.toFixed(0)} blocks to ${cellLine(w.win.end)}`;
            const pr = wayProven(plan, w.win);
            if (!pr.ok) return log.info(`fly: the window from ${cellLine(from)} (${along}): ${pr.why}${!plan.complete && plan.why ? ` (${plan.why})` : ''} (${plan.expanded} expanded in ${plan.ms.toFixed(0)} ms); walked`);
            if (node >= w.start) return log.info(`fly: the window from ${cellLine(from)} (${along}) was proven after the walk passed its start (${plan.ms.toFixed(0)} ms); walked`);
            const here = position() ?? from;
            const m = wayMobs(here, { x: w.win.end.x, z: w.win.end.z, feet: w.win.end.y }, mobsAt(here), mobsOn());
            if (m.refuse) return log.info(`fly: the window from ${cellLine(from)} (${along}): ${m.refuse}; walked`);
            const g = wayGate({ walkS: price(w.start, w.land), flyS: plan.ticks / 20, rockets: plan.rockets, loose, overS: WAY_OVER_S + m.priceS });
            log.info(`fly: the window from ${cellLine(from)} (${along}, ${plan.ticks} ticks, ${plan.rockets} rockets, ${pr.why}${m.note ? `, the landing: ${m.note}` : ''}): ${g.line}`);
            if (g.take) armed = { w, plan, stretch, line: g.line };
          })
          .catch((e: unknown) => log.warn(`fly: the window's proof failed: ${e instanceof Error ? e.message : String(e)}`))
          .finally(() => {
            proving = false;
          });
      }, WAY_TICK_MS);
      (timer as { unref?: () => void }).unref?.();
      const r = await res;
      done = true;
      clearInterval(timer);
      const go = stopFor;
      if (!go || r.ok) return r;
      // stopped for the window: standing still first
      const settle = async (): Promise<void> => {
        for (let i = 0; i < 20 && Math.hypot(loop.state.vel.x, loop.state.vel.z) > 0.003; i++) await loop.waitTicks(1);
      };
      await settle();
      const start = go.w.from;
      // (the takeoff is the passage's middle by the node, wayMiddle: a step across to it first)
      const at0 = position();
      if (at0 && hdist(at0, start) > WAY_START_OFF) {
        const step = await walk0({ type: 'block', p: { x: Math.floor(start.x), y: Math.floor(start.y + 1e-6), z: Math.floor(start.z) } }, {}, `walking to the window's takeoff`);
        if (!step.ok && /^(stopped|interrupted|replaced)$/.test(step.reason ?? '')) return { ok: false, reason: 'interrupted' };
        await settle();
      }
      const here = position();
      if (!here) return r;
      let plan = go.plan;
      let stretch = go.stretch;
      let from = start;
      const off = Math.hypot(here.x - start.x, here.y - start.y, here.z - start.z);
      if (off > WAY_START_OFF) {
        // (the plan was proven from the takeoff cell's middle: from here it is proven again, its seconds counted against the window)
        const again = await proveWayWindow(go.w, { ...here });
        const pr = wayProven(again.plan, go.w.win);
        const m = wayMobs(here, { x: go.w.win.end.x, z: go.w.win.end.z, feet: go.w.win.end.y }, mobsAt(here), mobsOn());
        const g = wayGate({ walkS: price(go.w.start, go.w.land), flyS: again.plan.ticks / 20, proofS: again.plan.ms / 1000, rockets: again.plan.rockets, loose: again.loose, overS: WAY_OVER_S + m.priceS });
        if (!pr.ok || m.refuse || !g.take) {
          log.info(`fly: the walk to ${name} stopped ${off.toFixed(1)} off the window's start; proven again from there: ${!pr.ok ? pr.why : m.refuse ?? g.line}; walking on`);
          continue;
        }
        plan = again.plan;
        stretch = again.stretch;
        from = { ...here };
      }
      const m = wayMobs(here, { x: go.w.win.end.x, z: go.w.win.end.z, feet: go.w.win.end.y }, mobsAt(here), mobsOn());
      if (m.refuse) {
        log.info(`fly: the walk to ${name} stopped for a window: ${m.refuse}; walking on`);
        continue;
      }
      log.info(`fly: the walk to ${name} stopped at ${cellLine(here)} for a window under the roof to ${cellLine(go.w.win.end)} (${go.w.win.blocks.toFixed(0)} blocks, ${go.w.win.goals.length} goals, ${go.w.win.width} x ${go.w.win.height}, margin ${go.w.win.margin}; ${go.line})`);
      const out = await flyWayWindow(wiring, go.w.win, `to ${cellLine(go.w.win.end)}`, plan, from, stretch);
      windows++;
      if (out.ok) landed++;
      else scout.bailed();
      log.info(`fly: window ${windows} of the walk to ${name} ${out.ok ? 'landed' : `ended (${out.reason ?? '?'}${out.bailed ? ', bailed out' : ''})`} at ${cellLine(out.at ?? loop.state.pos)}, ${out.rockets ?? 0} rockets; ${landed} of ${windows} landed`);
      const h = world.self.health;
      if (h !== undefined && (h <= 0 || h < CORRIDOR_HEALTH_MIN)) unsafe = true;
      if (h !== undefined && h <= 0) return { ok: false, reason: 'died' };
      // (the owner's !stop, a death's drop: the trip ends; the guard's pause does not end a window, it waits)
      if (!out.ok && /^(stopped|interrupted|replaced)$/.test(out.reason ?? '')) return { ok: false, reason: 'interrupted' };
    }
  };
  pve.walk = async (goal: Goal, opts: GotoOptions = {}, label?: string): Promise<SkillResult> => {
    if (goal.type !== 'block') return walk0(goal, opts, label);
    const name = label?.replace(/^walking (to )?/, '') ?? fmt(goal.p);
    // Track W2 way: a walk that starts where a landing probe of this trip's goal started (the cell the flight landed on)
    // walks the probe's whole way (GotoOptions.way), read when the walk starts
    const plain = () => {
      const at = position();
      const way = at && !opts.way ? wayFromHere(foundWays, at, goal.p, Date.now()) : undefined;
      if (way) log.info(`walk: from the landing cell along the landing probe's way (${way.length} nodes, ${pathBlocks(way).toFixed(1)} blocks)`);
      // Track F17: with `flyCaveWindows` the stretches of the way a proven window is faster on are flown
      if (way && wayWindowsOn()) return wayWalk(goal, opts, label, way);
      return walk0(goal, way ? { ...opts, way } : opts, label);
    };
    // Track BH: the walk, and a glide down when it finds no way to a goal far below
    const walkOrGlide = async (): Promise<SkillResult> => glideFallback(await plain(), goal.p, name, 1, plain);
    const legWalk = (leg: Goal) => walk0(leg, opts, `walking to ${name} (to open sky)`);
    const air = await takeOver(goal.p, name, 1, false);
    if (air) return afterTakeOver(air, () => pve.walk(goal, opts, label), plain);
    const f = await autoFly(goal.p, name, 1);
    // Track BL: a walk that does not fly looks for a takeoff again on the way
    if (!f) return watchWalk(() => goal.p, name, 1, plain, plain, legWalk).then((r) => glideFallback(r, goal.p, name, 1, plain));
    const r = await runAuto(f, () => goal.p, name, 1, f.kind === 'walk_out' ? walkOrGlide : plain, legWalk);
    // Track F15: the walk out found no way and no glide down was found: a floor the walk reaches, last
    return f.kind === 'walk_out' ? floorFallback(r, f.roof, goal.p, name, 1, plain, legWalk) : r;
  };
  // ---- Track M3: the elytra flee (docs/pve.md "The elytra flee"; decisions/0086) ----------------------------------
  /** The head room over the body: no loaded solid from the head up to FLEE_FLY.headroom over the feet (the cheap look; the takeoff's simulation decides). */
  const fleeRoof = (from: Vec3): number | undefined => {
    const x = Math.floor(from.x);
    const z = Math.floor(from.z);
    const y0 = Math.floor(from.y + 1e-6);
    for (let y = y0 + 2; y <= y0 + FLEE_FLY.headroom; y++) if (cell(x, y, z) === true) return y - y0;
    return undefined;
  };
  /**
   * Why a flee cannot take off where the body stands (undefined: it can): a flight already in the air, another dimension,
   * the kit (the elytra, FLEE_FLY.rockets loose rockets: the fireworks box is not opened in a flee), water, a roof.
   */
  const fleeReady = (): string | undefined => {
    if (fleeTrip) return 'a flee is on its way';
    if (controller.active) return 'a flight is in the air';
    if (dim() !== OVERWORLD) return 'not in the overworld';
    const from = position();
    if (!from) return 'position unknown';
    const k = readKit(inv, memory());
    const ready = kitReady(k, d.settings.get('toolWearLimit'));
    if (!ready.ok) return ready.line.replace(/^fly: /, '');
    if (k.rockets < FLEE_FLY.rockets) return `${k.rockets} rockets at hand (a flee needs ${FLEE_FLY.rockets})`;
    if (loop.state.inWater || loop.state.inLava) return 'in water';
    const roof = fleeRoof(from);
    if (roof !== undefined) return `a roof ${roof} over the feet (a takeoff needs ${FLEE_FLY.headroom} open)`;
    return undefined;
  };
  /**
   * The flee's destination: home when it lies FLEE_FLY.homeMin to homeMax away, no hostile round the body stands on the
   * way to it (flee.ts fleeHomeClear) and none is known within FLEE_FLY.safe of it; else a point FLEE_FLY.far away, on the bearing away from the hostiles first and then round from
   * it (flee.ts fleeBearings), the first whose column is not known to be water or lava. Its ground is found in flight (the
   * landing search with the look at hostiles), so the takeoff waits for nothing.
   */
  const fleeGoal = (from: Vec3, mobs: readonly LandMob[]): { goal: Vec3; label: string; yaw: number } => {
    const away = fleeAway(from, mobs, loop.command.yaw);
    const h = task.home?.get();
    if (h) {
      const dHome = hdist(from, h);
      if (dHome >= FLEE_FLY.homeMin && dHome <= FLEE_FLY.homeMax && fleeHomeClear(from, h, mobs) && landMobsNear(world.entities.values(), pve.mobs, h, FLEE_FLY.safe).length === 0) return { goal: { x: Math.floor(h.x), y: Math.floor(h.y), z: Math.floor(h.z) }, label: 'home', yaw: away };
    }
    for (const yaw of fleeBearings(away)) {
      const x = Math.floor(from.x - Math.sin((yaw * Math.PI) / 180) * FLEE_FLY.far);
      const z = Math.floor(from.z + Math.cos((yaw * Math.PI) / 180) * FLEE_FLY.far);
      const top = skyTop(x, z);
      if (top !== undefined && (wetAbove(x, z, top) || isHazardName(world.blockAt({ x, y: top, z })?.name ?? ''))) continue;
      return { goal: { x, y: top !== undefined ? top + 1 : Math.floor(from.y), z }, label: 'safe ground', yaw: away };
    }
    return { goal: { x: Math.floor(from.x - Math.sin((away * Math.PI) / 180) * FLEE_FLY.far), y: Math.floor(from.y), z: Math.floor(from.z + Math.cos((away * Math.PI) / 180) * FLEE_FLY.far) }, label: 'safe ground', yaw: away };
  };
  /**
   * The elytra flee: a real flight, asked for by the guard (tasks/pve.ts). What a player does: jump, open the wings, a
   * rocket. The takeoff is the jump along the first heading away from the hostiles whose simulated climb is clear (flee.ts
   * fleeHeadings), else straight up the column over the body, else along any heading; none: no flee (a roof, a canopy), and
   * the other floors stay in charge. The flight never lands for low health, its landing is searched with the look at
   * hostiles, and it places no block. Resolves with what happened.
   */
  const flee = async (why: string): Promise<FleeFlight> => {
    const t0 = Date.now();
    const no = (reason: string): FleeFlight => ({ ok: false, flew: false, reason, line: `no elytra flee: ${reason}`, seconds: (Date.now() - t0) / 1000 });
    const not = fleeReady();
    if (not) return no(not);
    const from = position()!;
    const trip: NonNullable<typeof fleeTrip> = { cancelled: false };
    fleeTrip = trip;
    try {
      const mobs = landMobsNear(world.entities.values(), pve.mobs, from, FLEE_FLY.scan);
      const g = fleeGoal(from, mobs);
      const goalTarget: FlyTarget = { x: g.goal.x + 0.5, z: g.goal.z + 0.5, top: g.goal.y, half: 2, label: g.label };
      const k = readKit(inv, memory());
      const cz = cruiseHeight(from, goalTarget, skyTop, { clearance: d.settings.get('flyClearance'), margin: d.settings.get('flyMargin'), maxClimb: d.settings.get('flyMaxClimb') });
      const sky = skyHere(from, goalTarget);
      let tk: { takeoffYaw?: number; vertical?: number } | undefined;
      if (sky.ok) {
        const r = await jumpTakeoff(simDeps(true), from, goalTarget, simOptions(cz.y), k.rockets, fleeHeadings(g.yaw, 90));
        if (r.yaw !== undefined) tk = { takeoffYaw: r.yaw };
      }
      tk ??= await verticalFor(from, goalTarget, k.rockets, true);
      if (!tk && sky.ok) {
        const r = await jumpTakeoff(simDeps(true), from, goalTarget, simOptions(cz.y), k.rockets, fleeHeadings(g.yaw + 180, 60));
        if (r.yaw !== undefined) tk = { takeoffYaw: r.yaw };
      }
      if (!tk) return no(sky.ok ? 'no clear climb from here on any heading, none straight up' : sky.line.replace(/^fly: /, ''));
      if (trip.cancelled) return no('cancelled before the takeoff');
      if (controller.active) return no('a flight is in the air');
      // the goal held high: its landing is looked for from the air (tasks/process/fly.ts watchLanding), so the takeoff waits for no search
      const target: FlyTarget = { ...goalTarget, hold: true, goal: g.goal, ...tk };
      supersede();
      const p = start(target, { flee: true });
      trip.p = p;
      log.warn(`fly: elytra flee (${why}): ${tk.vertical !== undefined ? `straight up ${tk.vertical}, then heading ${Math.round(tk.takeoffYaw ?? 0)}` : `a jump heading ${Math.round(tk.takeoffYaw ?? 0)}`} to ${g.label} ${g.goal.x} ${g.goal.y} ${g.goal.z} (${Math.round(hdist(from, goalTarget))} blocks; ${landMobsSaid(mobs, from) ?? 'no hostile known'}; ${Date.now() - t0} ms to the takeoff's start)`);
      const r = await p.result;
      const at = r.report?.landedAt ?? position();
      const flew = r.report !== undefined && r.report.ticks > 0 && r.report.reason !== 'no_glide' && r.report.reason !== 'no_elytra' && r.report.reason !== 'in_water';
      const landed = flew && (r.ok || r.reason === 'landed_off' || r.reason === 'roof' || r.reason === 'no_landing' || r.reason === 'stopped' || r.reason === 'no_rockets');
      const near = at ? landMobsNear(world.entities.values(), pve.mobs, at, FLEE_FLY.scan) : [];
      const nearest = at ? near.reduce((m, h) => Math.min(m, Math.hypot(h.x - at.x, h.z - at.z)), Infinity) : Infinity;
      const line = flew
        ? `elytra flee: ${landed ? 'landed' : `ended (${r.reason ?? '?'})`}${at ? ` at ${Math.floor(at.x)} ${Math.floor(at.y)} ${Math.floor(at.z)}, ${Math.round(hdist(from, at))} blocks from where it began` : ''} after ${r.seconds} s, ${r.report?.rockets ?? 0} rockets; ${Number.isFinite(nearest) ? `the nearest hostile ${nearest.toFixed(0)} off` : 'no hostile known near'}`
        : `no elytra flee: ${r.reason ?? 'the takeoff failed'}`;
      log.warn(`fly: ${line}`);
      return { ok: landed, flew, ...(landed ? {} : { reason: r.reason ?? 'failed' }), line, seconds: (Date.now() - t0) / 1000, ...(at ? { landedAt: { ...at } } : {}), ...(flew ? { moved: at ? hdist(from, at) : 0, rockets: r.report?.rockets ?? 0, nearest } : {}) };
    } catch (e) {
      return no(e instanceof Error ? e.message : String(e));
    } finally {
      if (fleeTrip === trip) fleeTrip = undefined;
    }
  };
  /** Cancel the elytra flee: before the takeoff it is dropped; in the air it lands on the nearest safe ground (clear of creepers). */
  const cancelFlee = (): boolean => {
    const trip = fleeTrip;
    if (!trip) return false;
    trip.cancelled = true;
    const p = trip.p;
    if (p && !p.land('stopped') && !p.done) processes.stop(p, 'stopped');
    return true;
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
    const f = await autoFly(goal, 'home', 1, { site: false, quiet: true, auto: true });
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
  const corridorSky = async (cell: Vec3, label: string, hint?: SkyHint): Promise<StepOutcome> => {
    const from = position();
    if (!from) return { ok: false, reason: 'position unknown' };
    const k = readKit(inv, memory());
    // (Track F8: the sky check and the cruise height are measured from the rim over a cell under an opening)
    const aim: LandingTarget = { x: cell.x + 0.5, z: cell.z + 0.5, top: cell.y, half: 1, ...(hint?.rim !== undefined ? { rim: hint.rim } : {}) };
    const tk = await takeoffFor(from, aim, skyHere(from, aim), flightRockets(k));
    if ('refuse' in tk) return { ok: false, reason: tk.refuse, at: from };
    const f = await planFlight(from, cell, label, 1, true, hint);
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
    // Track F16: no refill under a roof with a hostile this near (feet to feet), and the refill's lines to the owner
    hostile: () => {
      const at = loop.state.pos;
      const m = landMobsNear(world.entities.values(), pve.mobs, at, REFILL_MOB_REACH).map((x) => ({ x, d: Math.hypot(x.x - at.x, x.y - at.y, x.z - at.z) })).filter((x) => x.d <= REFILL_MOB_REACH).sort((a, b) => a.d - b.d)[0];
      return m ? `a ${m.x.type} ${m.d.toFixed(1)} blocks away` : undefined;
    },
    say: (m) => d.chat.say(m),
    // the live model, else what the world cache saw (a mouth at the edge of the loaded chunks); the windows are cut by `loaded`.
    // Track F6: water is an obstacle to the flight (`solid`: no window through or into a pool), the real solids are its floors
    solid: (x, y, z) => {
      const b = world.blockAt({ x, y, z });
      if (b) return b.solid || ROUTE_LIQUIDS.has(b.name);
      const c = world.cache?.blockAt(x, y, z);
      return c ? c.solid || ROUTE_LIQUIDS.has(c.name) : undefined;
    },
    floor: (x, y, z) => world.blockAt({ x, y, z })?.solid ?? world.cache?.blockAt(x, y, z)?.solid,
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
  // Track F5b: the cave style on a corridor trip when `flyCave on` (powered flight underground, the style's windows and
  // rules); off: today's trip (the underground stretches walked)
  const caveOn = (): boolean => String(d.settings.get('flyCave')) === 'on';
  const tripStyle = (): TripStyle => {
    // (Track F10: with `flyKitBurn` the windows' trackers and their proofs plan on the burn of the rockets at hand)
    const kit = openBurn();
    if (caveOn()) return { executor: caveExecutorOptions(true), stretch: (w) => (kit ? { ...caveStretchOptions(w), kit } : caveStretchOptions(w)), prove: { maxMs: CAVE_STYLE.proveMs, maxNodes: CAVE_STYLE.proveNodes } };
    return { executor: caveExecutorOptions(false), ...(kit ? { stretch: () => ({ kit }) } : {}) };
  };
  /** A cell is covered (no open sky over it): the column's top is at or over it; unknown counts as covered. */
  const coveredCell = (cell: Vec3): boolean => {
    const top = skyTop(cell.x, cell.z);
    return top === undefined || top >= cell.y;
  };
  /** Track F5b: `!fly via <wp> ...` / `!fly route <prefix> [noshortcut]`: the waypoints as a corridor (skills/fly/cave/route.ts). */
  const flyRoute = async (args: readonly string[], reply: (s: string) => void): Promise<void> => {
    const store = waypointStoreOf(task);
    if (!store) {
      reply('fly: no waypoints here');
      return;
    }
    const pointOf = (w: { name: string; x: number; y: number | null; z: number }): RoutePoint | undefined => (w.y === null ? undefined : { name: w.name, cell: { x: w.x, y: w.y, z: w.z } });
    let points: RoutePoint[];
    let label: string;
    let shortcut: RoutePoint | undefined;
    if (args[0] === 'via') {
      const names = args.slice(1);
      if (names.length < 1) {
        reply('usage: !fly via <waypoint> <waypoint> ... (fly them in order; the corridor between them is the plan)');
        return;
      }
      const pts: RoutePoint[] = [];
      for (const n of names) {
        const w = store.get(n);
        const p = w ? pointOf(w) : undefined;
        if (!p) {
          reply(w ? `fly: waypoint ${w.name} has no height; set it again where you stand` : `fly: no waypoint "${n}" (!wp list)`);
          return;
        }
        pts.push(p);
      }
      points = pts;
      label = `via ${pts.map((p) => p.name).join(' ')}`;
    } else {
      const prefix = args[1];
      if (!prefix) {
        reply('usage: !fly route <prefix> [noshortcut] (flies <prefix>_start, <prefix>_1 .. <prefix>_N, <prefix>_end; a <prefix>_shortcut is taken when the planner proves it clean)');
        return;
      }
      const named = store.list().map(pointOf).filter((p): p is RoutePoint => p !== undefined);
      const route = orderedRoute(prefix, named);
      if (!route) {
        reply(`fly: no route ${prefix} (needs ${prefix}_start and ${prefix}_end; !wp list)`);
        return;
      }
      points = route;
      label = `route ${prefix} (${route.length} waypoints)`;
      if (!args.slice(2).some((a) => a.toLowerCase() === 'noshortcut')) shortcut = named.find((p) => p.name.toLowerCase() === `${prefix}_shortcut`.toLowerCase());
    }
    const k = readKit(inv, memory());
    const ready = kitReady(k, d.settings.get('toolWearLimit'), supplyOf(d.task)?.carried(ROCKET) ?? 0);
    if (!ready.ok) {
      reply(ready.line);
      return;
    }
    if (controller.active) {
      reply('fly: already flying');
      return;
    }
    const on = caveOn();
    const w = corridorWiring();
    if (shortcut) {
      // the optional waypoint: taken only when the planner proves the stretch through it clean with margin (the worker's search, a generous budget)
      if (!on) reply(`fly: ${shortcut.name} is skipped (flyCave is off: nothing is flown underground)`);
      else {
        const { points: short, branch } = shortcutRoute(points, shortcut);
        reply(`fly: proving the shortcut ${shortcut.name} from ${branch.name} on the model (a few seconds)`);
        const proof = await proveShortcutInWorker(w.grid, [branch.cell, shortcut.cell, short[short.length - 1]!.cell], { style: CAVE_STYLE, ...(openBurn() ? { kit: openBurn()! } : {}) }).catch((e: unknown) => ({ proven: false, windows: 0, lines: [], reason: e instanceof Error ? e.message : String(e) }));
        for (const line of proof.lines) log.info(`fly: shortcut ${shortcut.name}: ${line}`);
        if (proof.proven) {
          points = short;
          reply(`fly: the shortcut ${shortcut.name} from ${branch.name} is proven clean (${proof.windows} window${proof.windows === 1 ? '' : 's'}): taking it`);
        } else reply(`fly: the shortcut ${shortcut.name} is not proven (${proof.reason ?? '?'}): flying the full route`);
      }
    }
    const provider = new WaypointProvider(points, { covered: coveredCell, dim: dim() });
    const last = points[points.length - 1]!;
    reply(`flying ${label}${on ? ' (cave style)' : ' (flyCave off: walking underground)'}; ${kitLine(k)}`);
    const r = await runCorridorTrip(w, provider, last.cell, last.name, tripStyle());
    reply(corridorEndLine(r, last.name));
  };
  /** Track K4: the `!fly` runs whose spare elytra pass was made, and what their refusal adds (the run after the pass). */
  const spareAsked = new WeakSet<object>();
  const spareTails = new WeakMap<object, string>();
  /** Track F21: the flights a `!fly` started (its chain says the end line; `!fly stop` supersedes that chain and says it instead). */
  const flyOwned = new WeakSet<FlyProcess>();
  const flyDef: Parameters<typeof d.chat.register>[0] = {
    name: 'fly',
    help: '<x y z> | <waypoint> | <player> | home | via <wp> ... | route <prefix> [noshortcut] | stop | status | box [<slot>] (fly there with the elytra and land on it; via / route: fly the waypoints in order, the cave stretches flown with flyCave on; stop: land now)',
    tier: 'more', // Track AU2: come and goto fly on their own; the front door keeps !come
    group: 'go',
    example: '!fly home',
    auto: 'come and goto fly by themselves over flyMin blocks (autoFly), landing on the nearest landable cell and walking the rest; the flight kit (elytra, rockets, the fireworks box) is never dropped, stashed or unloaded',
    run: (ctx) => {
      const { args, sender } = ctx;
      const sub = args[0]?.toLowerCase();
      let gen = flyGen;
      const live = (): boolean => gen === flyGen;
      const reply = (m: string): void => {
        if (live()) ctx.reply(m);
        else log.info(`fly: a superseded trip's line not said: ${m}`);
      };
      if (sub === 'stop') {
        const p = current;
        gen = ++flyGen;
        const trip = stopCorridorTrip(task); // Track F4b: a corridor trip ends after its step in progress
        if (p?.land('stopped')) {
          reply('landing');
          // Track F21: the `!fly` this stops is superseded and says nothing more (no late line in a next trip, no walk on), so
          // its landing is told here, unless a newer trip supersedes this command too (a `!goto` or `!come` says its own end)
          if (flyOwned.has(p)) {
            void p.result.then(
              (r) => {
                if (r.reason !== 'interrupted' && r.reason !== 'replaced') reply(flyEndLine(r));
              },
              () => undefined,
            );
          }
        } else if (controller.active) {
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
      if (sub === 'via' || sub === 'route') {
        void flyRoute(args, reply); // Track F5b
        return;
      }
      const t = targetOf(args, sender.kind === 'player' ? sender.name : undefined);
      if ('error' in t) {
        reply(t.error);
        return;
      }
      // this trip supersedes the one before (its chain says nothing more; its corridor trip stops)
      gen = ++flyGen;
      stopCorridorTrip(task);
      // already in the air: the flight takes the new goal there (no landing first); after a landing it could not avoid, `!fly` again from the ground
      if (controller.active && current?.phase === 'flying') {
        void (async () => {
          const p = await takeOver(t.goal, t.label, t.half, true);
          if (!p) {
            reply('fly: the flight is landing; try again once it stands');
            return;
          }
          flyOwned.add(p);
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
      // Track K4 (docs/flight.md "An elytra on hand"): an elytra that does not cover the trip: a better one to hand is put
      // on first, then the command runs again (once); `spareTail` is what a refusal adds when none covers it
      const ec = elytraControlOf(task);
      const at = position();
      const ask = ec && at ? ec.ask(hdist(at, { x: t.goal.x + 0.5, z: t.goal.z + 0.5 })) : { act: false };
      if (ec && at && ask.act && !spareAsked.has(ctx)) {
        spareAsked.add(ctx);
        const mine = flyGen;
        void ec.forTrip(hdist(at, { x: t.goal.x + 0.5, z: t.goal.z + 0.5 })).then(
          (r) => {
            spareTails.set(ctx, r.line ?? '');
            if (flyGen === mine) void flyDef.run(ctx);
          },
          () => {
            if (flyGen === mine) void flyDef.run(ctx);
          },
        );
        return;
      }
      const spareTail = spareTails.get(ctx) ?? ask.line ?? '';
      const k = readKit(inv, memory());
      const ready = kitReady(k, d.settings.get('toolWearLimit'), supplyOf(d.task)?.carried(ROCKET) ?? 0);
      if (!ready.ok) {
        if (ready.reason === 'no_elytra' || ready.reason === 'elytra_worn') {
          reply(`${ready.line}${spareTail}`);
          return;
        }
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
      // Track F20: a trip the elytra does not cover is not started (a far goal: no elytra covers it, and the reply says so)
      const cover = coverOf(k, distance);
      if (!cover.ok) {
        reply(`fly: ${tripCoverLine(cover, distance)}${spareTail} (walk: !goto)`);
        return;
      }
      // the plain flight (a takeoff, the cruise, the landing, the walk for the rest); also the corridor's fallback below
      // the rest of the trip after a plain flight's landing: with flyCave on and a covered goal (a cave), the corridor from
      // the landing (its windows fly underground; the Realm's trips from home flew the plain way, then walked the cave in);
      // else the walk. `said`: the corridor's own end line was given
      let said = false;
      // (Track F9c: `stood`: the flight ended standing along a learned entry, on the goal's cell or a step from it: the walk
      // for what is left, no corridor from here)
      const rest = async (stood = false): Promise<SkillResult> => {
        if (!live()) return { ok: false, reason: 'interrupted' };
        const prov = corridorProviderOf(task, skills.nav.coarseLayer);
        const top = skyTop(t.goal.x, t.goal.z);
        if (!stood && caveOn() && prov && (top === undefined || top >= t.goal.y)) {
          const r = await runCorridorTrip(corridorWiring(), prov, t.goal, t.label, tripStyle());
          if (!noCorridorAtAll(r)) {
            said = true;
            reply(corridorEndLine(r, t.label));
            return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? 'failed' };
          }
        }
        return walk0({ type: 'block', p: t.goal }, {}, `walking to ${t.label}`);
      };
      const plain = async (): Promise<void> => {
      const from = position();
      if (!from) {
        reply('fly: position unknown');
        return;
      }
      // Track AU2: no takeoff under a roof (the owner's indoor flight hit the ceiling three times)
      const sky = skyHere(from, goalTarget);
      // Track BF: the same landing as goto / come (exact on the goal when it is landable, else a confirmed cell
      // near it, held high while its ground is not loaded), then the walk for the rest
      await (async () => {
        // Track BH: a ledge takeoff where the jump is refused (an overhang, a blocked run) or the start is a small platform
        // (and the jump along a heading whose simulated climb is clear: trees, walls)
        const tk = await takeoffFor(from, goalTarget, sky, flightRockets(k));
        if ('refuse' in tk) {
          if (t.player) {
            reply(tk.refuse);
            return;
          }
          // under a roof (indoors at home): the goto's way, a walk to a takeoff site and the flight from there (pve.walk
          // is the flying walk: autoFly, the site, the re-check on the way), the walk for the rest when none is found
          reply(`${tk.refuse.replace(/^fly: /, '').replace(/; walk outside first$/, '')}: walking to a takeoff site for ${t.label}`);
          const auto = await autoFly(t.goal, t.label, t.half);
          const w = auto ? await runAuto(auto, () => t.goal, t.label, t.half, rest, (leg) => walk0(leg, {}, `walking to ${t.label} (to open sky)`)) : await rest();
          if (said) return;
          if (w.ok) reply(`walked to ${t.label}`);
          else if (w.reason !== 'interrupted') reply(`fly: the trip to ${t.label} failed (${w.reason ?? 'failed'})`);
          return;
        }
        // Track F13: nothing loose and the box's refill cannot be made here: the reason, not `flying to` and then the refusal
        const noRefill = refillRefusal(k);
        if (noRefill) {
          reply(noRefill);
          return;
        }
        const f = await planFlight(from, t.goal, t.label, t.half, true);
        Object.assign(f.target, tk);
        if (controller.active) {
          reply('fly: already flying');
          return;
        }
        const p = start(f.target);
        flyOwned.add(p);
        const walking = f.target.cell && f.target.cell.kind !== 'goal' ? `, then walking ${Math.round(hdist(f.target, goalTarget))} blocks` : '';
        reply(`flying to ${t.label} (${Math.round(distance)} blocks, about ${flightSeconds(distance)} s${walking}; ${kitLine(k)})`);
        if (f.said) reply(f.said);
        const r = await retryShort(await p.result, from, t.goal, t.label, t.half);
        if (r.reason === 'interrupted' || r.reason === 'replaced') return;
        reply(flyEndLine(r));
        // on the goal itself (an exact landing that stood on it): nothing to walk. The server's slide goes on after the
        // settle (bds-fly: 0.6 to 1.0 blocks more, once to a 3x3 platform's edge, held there by the sneak): wait for
        // the body to stop, and walk back onto the goal block when it ended more than 0.8 from its centre
        for (let i = 0; i < 40 && Math.hypot(loop.state.vel.x, loop.state.vel.z) > 0.003; i++) await loop.waitTicks(1);
        const onGoal = r.ok && r.target.cell?.kind === 'goal' && r.report?.onTarget === true && hdist(loop.state.pos, goalTarget) <= 0.8;
        if (onGoal) return;
        // (Track F9c round 2: and after a learned entry that stood, however the flight was then called: the body is beside the goal)
        // (Track F20: and after the worn landing short of the goal: the body stands on safe ground)
        const walkable = r.ok || r.reason === 'landed_off' || r.reason === 'roof' || r.reason === 'no_landing' || r.reason === 'elytra_worn' || r.report?.entry?.end === 'landed';
        if (!walkable || !live()) return;
        const w = t.player ? await come0(t.player) : await rest(r.report?.entry?.end === 'landed');
        if (said) return;
        if (w.ok) reply(`walked to ${t.label}`);
        else if (w.reason !== 'interrupted') reply(`fly: landed, but the walk to ${t.label} failed (${w.reason ?? 'failed'})`);
      })();
      };
      // Track F4b: a long trip to a covered goal (a cave, a chamber) follows the coarse layer's corridor when the task has one
      const provider = corridorProviderOf(task, skills.nav.coarseLayer);
      const top = skyTop(t.goal.x, t.goal.z);
      // Track F9c: a goal with a recorded way in is flown the plain way (the flight carries the learned entry, proven in the
      // air; refused, it lands as the plain flight does and the rest goes on from there)
      const learnedIn = !t.player && learnedEntryOn() && entryMatches(t.goal).matches.length > 0;
      if (learnedIn) log.info(`fly: ${t.label} has a recorded way in: the plain flight, its end along the learned entry when that proves clear`);
      // Track F9e: and so is a goal under a roof while the drawn way in is on (the line is drawn and proven in the air)
      const drawnIn = !t.player && !learnedIn && drawnEntryOn() && !entrySky(t.goal.x, t.goal.y, t.goal.z);
      if (drawnIn) log.info(`fly: ${t.label} lies under a roof and no recording leads into it: the plain flight, its end along a drawn entry when one proves clear`);
      if (!t.player && !learnedIn && !drawnIn && provider && corridorWanted(String(d.settings.get('flyCorridor')), provider, distance, top === undefined || top >= t.goal.y)) {
        reply(`flying to ${t.label} along a corridor (${Math.round(distance)} blocks; ${kitLine(k)})`);
        void runCorridorTrip(corridorWiring(), provider, t.goal, t.label, tripStyle()).then((r) => {
          // a layer with no corridor at all from here (a start it cannot leave, such as a walled base) is no
          // answer for a flight: the plain flight walks to a takeoff site, flies and lands near the goal, then walks
          if (!live()) return;
          if (noCorridorAtAll(r)) {
            reply(`no corridor from here (${r.reason ?? 'none'}); flying the plain way`);
            void plain();
          } else reply(corridorEndLine(r, t.label));
        });
        return;
      }
      void plain();
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

/**
 * A corridor trip that ended on its first plan with no corridor at all (the layer's search found none from the start:
 * nothing flown or walked): the fly command flies the plain way instead.
 */
/** A flight that ended within this many blocks of its start (along the way) came straight down: it is flown again once. */
export const SHORT_FLIGHT = 50;

export function noCorridorAtAll(r: Pick<CorridorReport, 'ok' | 'reason' | 'legs' | 'cruises' | 'walks' | 'windows'>): boolean {
  return !r.ok && r.legs.length === 0 && r.cruises === 0 && r.walks === 0 && r.windows === 0 && (r.reason ?? '').startsWith('no corridor');
}

/**
 * Two player inventory slots exchanged by one swap item_stack_request (predicted, rolled back when refused); the caller
 * holds the inventory screen (kitops rocketsToHotbar runs under withScreen, which would wait on itself if nested).
 */
export async function swapSlots(
  requests: Pick<StackRequests, 'send'>,
  inv: { readonly slots: readonly (ItemStack | null | undefined)[]; setItem(w: number, s: number, it: ItemStack | null): void },
  a: number,
  b: number,
): Promise<{ ok: boolean; reason?: string }> {
  const A = inv.slots[a];
  const B = inv.slots[b];
  if (!A || !B) return { ok: false, reason: 'an empty slot' };
  inv.setItem(0, a, { ...B });
  inv.setItem(0, b, { ...A });
  const res = await requests.send([{ type_id: 'swap', legacy_type_id: 2, source: inventorySlot(a, A.stackId), destination: inventorySlot(b, B.stackId) }]);
  if (res.status === 'ok' || res.status === 0) return { ok: true };
  inv.setItem(0, a, A);
  inv.setItem(0, b, B);
  return { ok: false, reason: `the swap was refused (${String(res.status)})` };
}
