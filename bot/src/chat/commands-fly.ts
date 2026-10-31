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
import { glideKitReady, jumpTakeoff, ledgeTakeoff, planGlideDown, smallPlatform, type Ledge, type SimDeps } from '../skills/fly/glide.ts'; // Track BH
import { elytraWornLimit, flightKitMemoryOf, kitLine, kitReady, readKit, SupplyWatch } from '../skills/fly/kit.ts';
import { FlightKitOps } from '../skills/fly/kitops.ts';
import { APPROACH_HEIGHT, columnsAlong, cruiseHeight, flightSeconds, hdist, takeoffSky, walkMinutes, type CellQuery, type LandingTarget, type SkyCheck } from '../skills/fly/plan.ts';
import { pathBlocks, probePath } from '../skills/home/reach.ts'; // Track AU2: the walk from a landing cell to the goal
import { probeNavOf } from '../skills/combat/pathReach.ts';
import { findLanding, isHazardName, isLiquidName, stillLandable, WET_ABOVE, type BlockLookup, type LandingPlan, type ProbeOutcome } from '../skills/fly/landing.ts'; // Track BF
import type { Goal, GotoOptions, SkillResult } from '../skills/types.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import { FlightProcess, FlyProcess, landingLine, targetFromPlan, type FlyOutcome, type FlyTarget } from '../tasks/process/fly.ts';
import { waypointStoreOf, waypointGoal } from './commands-nav.ts';
import { survivalKitOf } from './commands-survival.ts';
import { NETHER, OVERWORLD } from '../world/dimension.ts';
import type { Containers } from '../world/containers.ts';
import type { Logger } from '../log.ts';

export const FLY_COMMANDS = ['fly', 'land'] as const;

/** Track BF: one probe plan of the landing search (nodes, ms) and the whole search's time budget (ms). */
export const LAND_PROBE_NODES = 6000;
export const LAND_PROBE_MS = 400;
export const LAND_BUDGET_MS = 6000;
/** Track BH: open-sky cells probed per leg of a walk out (each LAND_PROBE_NODES / LAND_PROBE_MS) before the plain `xz` leg. */
export const LEG_PROBES = 6;
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
          const r = await probePath(nav, target, from, { nodes: LAND_PROBE_NODES, ms: LAND_PROBE_MS });
          if (!r) return { status: 'nostart' };
          if (r.status === 'found') return { status: 'found', blocks: pathBlocks(r.path) };
          return r.status === 'none' ? { status: 'none' } : { status: 'limited' };
        }
      : undefined;
    const plan = await findLanding(
      goal,
      label,
      { look, obstacle: (x, y, z) => world.blockAt({ x, y, z })?.solid === true, ...(probe ? { probe } : {}), dryGround: (x, z) => landable(x, z), yieldNow: () => new Promise((r) => setImmediate(r)) },
      {
        radius: d.settings.get('flyLandSearch'),
        headroom: d.settings.get('flyHeadroom'),
        maxUnder: d.settings.get('flyOverhangDepth'),
        probes: d.settings.get('flyLandProbes'),
        budgetMs: LAND_BUDGET_MS,
        ...(exact !== undefined ? { exact } : {}),
      },
    );
    log.info(`fly: ${plan.line}`);
    return plan;
  };
  const cellOk = (c: { x: number; z: number; feet: number }): boolean => stillLandable(look, c, d.settings.get('flyHeadroom'));

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
    log,
  });
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
  const start = (target: FlyTarget): FlyProcess => {
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
      waitTicks: (n) => loop.waitTicks(n),
      supply,
      log,
    });
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
  /** Track BH: the world for the flight simulations (unknown cells are air, as in the flight's own skyQuery). */
  const simDeps = (): SimDeps & { cell: CellQuery } => ({ world: loop.world ? skyQuery(loop.world) : { solidAt: (x, y, z) => cell(x, y, z) ?? false }, groundAt, skyTop, cell, yieldNow: () => new Promise((r) => setImmediate(r)) });
  /**
   * Track BH (docs/flight.md "Ledge takeoff"): a ledge of the start's platform to step off instead of the
   * jump, when the jump takeoff is refused (a roof over the start: an overhang, a blocked run) or the start
   * is a small platform; its takeoff simulated with the flight's options and rockets. Undefined: none (or
   * not wanted: the jump takeoff is fine).
   */
  const ledgeFor = async (from: Vec3, target: LandingTarget, sky: SkyCheck, rockets: number): Promise<Ledge | undefined> => {
    if (!d.settings.get('flyLedgeTakeoff')) return undefined;
    const small = smallPlatform(cell, from);
    if (sky.ok && !small) return undefined;
    const cz = cruiseHeight(from, target, skyTop, { clearance: d.settings.get('flyClearance'), margin: d.settings.get('flyMargin'), maxClimb: d.settings.get('flyMaxClimb') });
    const why = sky.ok ? 'a small platform' : sky.ahead === 0 ? `a roof ${sky.above} up` : `the run blocked ${sky.ahead} ahead`;
    const r = await ledgeTakeoff(simDeps(), from, target, { cruiseY: cz.y, margin: d.settings.get('flyMargin'), goArounds: d.settings.get('flyGoArounds') }, rockets);
    log.info(`fly: ledge takeoff (${why}): ${r.line}`);
    return r.ledge;
  };
  /**
   * Track BH: how this flight takes off: a ledge (ledgeFor), else the jump along the first heading whose
   * simulated climb meets no solid (the sky check's first, then 30 degrees apart: the Realm's takeoff into a
   * tree canopy, 2026-10-31), else refused with the line (walk out).
   */
  const takeoffFor = async (from: Vec3, target: LandingTarget, sky: SkyCheck, rockets: number): Promise<{ ledge?: Ledge; takeoffYaw?: number } | { refuse: string }> => {
    const ledge = await ledgeFor(from, target, sky, rockets);
    if (ledge) return { ledge };
    if (!sky.ok) return { refuse: sky.line };
    const cz = cruiseHeight(from, target, skyTop, { clearance: d.settings.get('flyClearance'), margin: d.settings.get('flyMargin'), maxClimb: d.settings.get('flyMaxClimb') });
    const yaws = [0, 30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180].map((o) => sky.yaw + o);
    const r = await jumpTakeoff(simDeps(), from, target, { cruiseY: cz.y, margin: d.settings.get('flyMargin'), goArounds: d.settings.get('flyGoArounds') }, rockets, yaws);
    if (r.yaw !== undefined && r.yaw === sky.yaw) return { takeoffYaw: r.yaw };
    log.info(`fly: the simulated climb: ${r.line}`);
    if (r.yaw !== undefined) return { takeoffYaw: r.yaw };
    return { refuse: 'fly: no clear climb from here (the simulated climb meets a solid on every heading: trees, a wall); walk outside first' };
  };
  type AutoFly = { kind: 'fly'; target: FlyTarget; line: string; said?: string | undefined } | { kind: 'walk_out'; roof: string };
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
  const autoFly = async (goalBlock: Vec3, label: string, half: number): Promise<AutoFly | undefined> => {
    if (!d.settings.get('autoFly')) return undefined;
    const from = position();
    if (!from || controller.active) return undefined;
    const goalTarget: FlyTarget = { x: goalBlock.x + 0.5, z: goalBlock.z + 0.5, top: goalBlock.y, half, label };
    const distance = hdist(from, goalTarget);
    if (distance <= d.settings.get('flyMin')) return undefined;
    const k = readKit(inv, memory());
    if (!kitReady(k, d.settings.get('toolWearLimit')).ok) return undefined;
    if (k.rockets < d.settings.get('fireworksMin') && k.boxRockets === 0) return undefined;
    if (dim() !== OVERWORLD && !(dim() === NETHER && ceilingClear(from, goalTarget))) return undefined;
    // the sky first (cheap); the landing cell (up to six probe plans) only when a takeoff is possible at all
    const sky = skyHere(from, goalTarget);
    // Track BH: a ledge takeoff where the jump takeoff is refused (an overhang, a blocked run) or the start is a small platform
    const tk = await takeoffFor(from, goalTarget, sky, k.rocketsHotbar || k.rockets);
    if ('refuse' in tk) return { kind: 'walk_out', roof: tk.refuse };
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
   * Track AU2: the leg of a walk to open sky: the nearest cell on the way to the goal (within `step`
   * blocks ahead, up to 4 beside the line, nearer first) that stands on its column's top under open sky
   * (`landable`): from a tunnel or a house that is the surface, so the walk comes up, not along. None
   * known: a plain `xz` leg `step` blocks along the line (the surface is not loaded or not landable).
   */
  const openSkyLeg = async (from: Vec3, goalBlock: Vec3, step: number): Promise<{ goal: Goal; tried: string[] }> => {
    const total = hdist(from, { x: goalBlock.x + 0.5, z: goalBlock.z + 0.5 });
    const ux = (goalBlock.x + 0.5 - from.x) / total;
    const uz = (goalBlock.z + 0.5 - from.z) / total;
    // Track BH: every candidate is probed from here first (the Realm, 2026-10-31: the "open-sky cell" was the top of the
    // farm's spawning box, 45 blocks over the platform, and the leg failed at once); at most LEG_PROBES, the nearest first
    const nav = probeNavOf(pve.mover);
    const tried: string[] = [];
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
        const r = await probePath(nav, { type: 'near', p: { x: x + 0.5, y: top, z: z + 0.5 }, r: 0.5 }, from, { nodes: LAND_PROBE_NODES, ms: LAND_PROBE_MS });
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
      const { goal: legGoal, tried } = await openSkyLeg(from, goalBlock, step);
      log.info(`fly: leg ${leg + 1} to ${legGoal.type === 'block' ? `the open-sky cell ${legGoal.p.x} ${legGoal.p.y} ${legGoal.p.z}` : legGoal.type === 'xz' ? `${legGoal.x} ${legGoal.z} (no ${tried.length ? 'reachable ' : ''}open-sky cell known ahead)` : 'the goal'}${tried.length ? ` (no path to ${tried.join(', ')})` : ''}`);
      const r = await legWalk(legGoal);
      if (!r.ok) return r.reason === 'interrupted' ? r : walk();
      const again = await autoFly(goalBlock, label, half);
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
  const walk0 = pve.walk.bind(pve);
  pve.walk = async (goal: Goal, opts: GotoOptions = {}, label?: string): Promise<SkillResult> => {
    if (goal.type !== 'block') return walk0(goal, opts, label);
    const name = label?.replace(/^walking (to )?/, '') ?? fmt(goal.p);
    const plain = () => walk0(goal, opts, label);
    // Track BH: the walk, and a glide down when it finds no way to a goal far below
    const walkOrGlide = async (): Promise<SkillResult> => glideFallback(await plain(), goal.p, name, 1, plain);
    const f = await autoFly(goal.p, name, 1);
    if (!f) return walkOrGlide();
    if (f.kind === 'walk_out') return walkOut(goal.p, name, 1, f, walkOrGlide, (leg) => walk0(leg, opts, `walking to ${name} (to open sky)`));
    sayFlight(f);
    return afterFlight(await start(f.target).result, plain);
  };
  const come0 = pve.come.bind(pve);
  pve.come = async (name: string, o: { urgent?: boolean } = {}): Promise<SkillResult> => {
    const feet = pve.playerFeet(name);
    const block = feet ? { x: Math.floor(feet.x), y: Math.round(feet.y), z: Math.floor(feet.z) } : undefined;
    const plain = () => come0(name, o);
    const f = block ? await autoFly(block, name, 2) : undefined;
    if (!block) return plain();
    if (!f) return glideFallback(await plain(), block, name, 2, plain);
    const walk = () => come0(name, o);
    if (f.kind === 'walk_out') return walkOut(block, name, 2, f, walk, (leg) => walk0(leg, {}, `walking to ${name} (to open sky)`));
    sayFlight(f);
    return afterFlight(await start(f.target).result, walk);
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

  d.chat.register({
    name: 'fly',
    help: '<x y z> | <waypoint> | <player> | home | stop | status | box [<slot>] (fly there with the elytra and land on it; stop: land now)',
    tier: 'more', // Track AU2: come and goto fly on their own; the front door keeps !come
    group: 'go',
    example: '!fly home',
    auto: 'come and goto fly by themselves over flyMin blocks (autoFly), landing on the nearest landable cell and walking the rest; the flight kit (elytra, rockets, the fireworks box) is never dropped, stashed or unloaded',
    run: ({ reply, args, sender }) => {
      const sub = args[0]?.toLowerCase();
      if (sub === 'stop') {
        const p = current;
        if (p?.land('stopped')) reply('landing');
        else if (controller.active) {
          controller.landNow('stopped');
          reply('landing');
        } else reply('fly: not flying');
        return;
      }
      if (sub === 'status') {
        const k = readKit(inv, memory());
        const c = controller.status();
        const flight = c.active ? `; flying to ${current?.target.label ?? '?'}: ${c.phase}, ${c.distance !== undefined ? `${Math.round(c.distance)} blocks to go, ` : ''}${c.rockets} rockets used, ${c.goArounds} go-arounds` : current ? `; ${current.status().line}` : '';
        const worn = k.elytraLeft !== undefined && k.elytraLeft <= elytraWornLimit(d.settings.get('toolWearLimit')) ? ' (worn: no flights)' : '';
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
      const k = readKit(inv, memory());
      const ready = kitReady(k, d.settings.get('toolWearLimit'));
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
  });
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
