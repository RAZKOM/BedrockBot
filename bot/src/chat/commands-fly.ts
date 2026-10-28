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
import { FlightController } from '../skills/fly/controller.ts';
import { elytraWornLimit, flightKitMemoryOf, kitLine, kitReady, readKit, SupplyWatch } from '../skills/fly/kit.ts';
import { FlightKitOps } from '../skills/fly/kitops.ts';
import { APPROACH_HEIGHT, columnsAlong, cruiseHeight, flightSeconds, hdist, takeoffSky, walkMinutes, type CellQuery, type LandingTarget } from '../skills/fly/plan.ts';
import { pathBlocks, probePath } from '../skills/home/reach.ts'; // Track AU2: the walk from a landing cell to the goal
import { probeNavOf } from '../skills/combat/pathReach.ts';
import type { Goal, GotoOptions, SkillResult } from '../skills/types.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import { FlightProcess, FlyProcess, type FlyOutcome, type FlyTarget } from '../tasks/process/fly.ts';
import { waypointStoreOf, waypointGoal } from './commands-nav.ts';
import { survivalKitOf } from './commands-survival.ts';
import { NETHER, OVERWORLD } from '../world/dimension.ts';
import type { Containers } from '../world/containers.ts';
import type { Logger } from '../log.ts';

export const FLY_COMMANDS = ['fly', 'land'] as const;

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
    let from = Math.min(319, Math.floor(fromY ?? (p0?.y ?? 64) + 80));
    // the cell at `from` already solid (a mountain more than 80 above, the bot deep underground): that is the
    // inside of the mass, not its top; scan from the world's top instead (Track AU2 review)
    if (fromY === undefined && world.blockAt({ x, y: from, z })?.solid) from = 319;
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
  /** Safe ground for a landing: a known column whose top is a plain solid block with level neighbours (within a block: neither a 1-wide column nor the bottom of a hole). */
  const groundAt = (x: number, z: number, fromY?: number): number | undefined => {
    const top = skyTop(x, z, fromY);
    if (top === undefined) return undefined;
    const b = world.blockAt({ x, y: top, z });
    if (b && /lava|water|cactus|magma|fire|portal/.test(b.name)) return undefined;
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
  /**
   * Track AU2, fly-then-walk: the landing cell for a goal: the goal itself when it is landable, else the
   * landable cell within `radius` with the shortest walk to the goal (a bounded probe plan for the
   * nearest few when the ground there is loaded, the straight distance otherwise). Undefined when
   * nothing landable is known near the goal (then the goal is flown to as before).
   */
  /**
   * ... Returns `undefined` when the goal's ground is not known at all (not loaded, nothing cached), `null`
   * when it is loaded and nothing landable lies within `radius` (the flight then aims at the goal itself
   * and stops looking), else the cell.
   */
  const landingNear = async (goal: Vec3, radius: number): Promise<{ x: number; z: number; top: number; walk: number; loaded: boolean } | null | undefined> => {
    // `loaded`: the goal's cell is in the live world model; a verdict from the world cache alone is provisional
    // (the cache may predate a structure built there) and the flight looks again when the chunks arrive
    const loaded = world.blockAt(goal) !== undefined;
    const own = landable(goal.x, goal.z, goal.y);
    if (own !== undefined) return { x: goal.x, z: goal.z, top: own, walk: 0, loaded };
    const found: { x: number; z: number; top: number; walk: number }[] = [];
    let bestWalk = Infinity;
    for (let r = 1; r <= radius; r++) {
      // a cell of ring r walks at least r: once the best found walks less than r no farther ring can beat it
      // (a roof's cells fill the inner rings before the ground cells beside the walls are seen)
      if (r > bestWalk) break;
      const step = r > 8 ? 2 : 1;
      for (let dx = -r; dx <= r; dx += step) {
        for (let dz = -r; dz <= r; dz += step) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const top = landable(goal.x + dx, goal.z + dz);
          if (top === undefined) continue;
          // the walk: the straight distance plus three per block of height (stairs, drops and the way round)
          const walk = Math.hypot(dx, dz) + 3 * Math.abs(top - goal.y);
          found.push({ x: goal.x + dx, z: goal.z + dz, top, walk });
          if (walk < bestWalk) bestWalk = walk;
        }
      }
    }
    if (found.length === 0) return loaded ? null : undefined;
    found.sort((a, b) => a.walk - b.walk);
    const nav = probeNavOf(pve.mover);
    const best = found.slice(0, 6).map((c) => ({ ...c, loaded }));
    if (nav && loaded) {
      for (const c of best) {
        const r = await probePath(nav, { type: 'near', p: goal, r: 1.5 }, { x: c.x + 0.5, y: c.top, z: c.z + 0.5 });
        c.walk = r?.status === 'found' ? pathBlocks(r.path) : c.walk * 2 + 16; // no path within the budget: well behind the ones with one
      }
      best.sort((a, b) => a.walk - b.walk);
    }
    return best[0];
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
      landingNear: (goal) => landingNear(goal, d.settings.get('flyLandSearch')),
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
  type AutoFly = { kind: 'fly'; target: FlyTarget; line: string } | { kind: 'walk_out'; roof: string };
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
    if (!sky.ok) return { kind: 'walk_out', roof: sky.line };
    const near = await landingNear(goalBlock, d.settings.get('flyLandSearch'));
    // the goal's ground not in the live model (too far to be loaded; the cache may be stale): fly at the goal
    // (or the cell the cache suggests) and look again within RETARGET_WITHIN blocks (FlyProcess.retargetNear);
    // loaded with nothing landable near it (null): fly at the goal and do not look again
    const landing: FlyTarget = near && near.walk > 0 ? { x: near.x + 0.5, z: near.z + 0.5, top: near.top, half: 1, label, then: `then walking ${Math.round(near.walk)} blocks` } : goalTarget;
    const target: FlyTarget = near === null || near?.loaded ? landing : { ...landing, goal: goalBlock };
    log.info(`fly: landing cell for ${label}: ${near ? `${near.walk > 0 ? `${near.x} ${near.top} ${near.z}, ${Math.round(near.walk)} blocks of walk` : 'the goal itself'} (${near.loaded ? 'loaded' : 'from the cache: checked again in flight'})` : near === null ? 'nothing landable near it (loaded): the goal itself' : 'nothing known there: checked again in flight'}`);
    const line = near && near.walk > 0 ? `flying ${Math.round(hdist(from, target))} blocks to ${Math.round(near.walk)} blocks from ${label}, then walking` : `flying (${Math.round(distance)} blocks; walking would be ~${Math.round(walkMinutes(distance))} min)`;
    return { kind: 'fly', target, line };
  };
  /** After the flight: the walk for the rest (also after a miss or a roof landing), or the flight's failure. */
  const afterFlight = (r: FlyOutcome, walk: () => Promise<SkillResult>): Promise<SkillResult> => {
    if (r.ok || r.reason === 'landed_off' || r.reason === 'roof' || r.reason?.startsWith('fly: no open sky')) return walk();
    if (r.reason === 'interrupted' || r.reason === 'replaced') return Promise.resolve({ ok: false, reason: 'interrupted' });
    return Promise.resolve({ ok: false, reason: flyEndLine(r) });
  };
  /**
   * Track AU2: the leg of a walk to open sky: the nearest cell on the way to the goal (within `step`
   * blocks ahead, up to 4 beside the line, nearer first) that stands on its column's top under open sky
   * (`landable`): from a tunnel or a house that is the surface, so the walk comes up, not along. None
   * known: a plain `xz` leg `step` blocks along the line (the surface is not loaded or not landable).
   */
  const openSkyLeg = (from: Vec3, goalBlock: Vec3, step: number): Goal => {
    const total = hdist(from, { x: goalBlock.x + 0.5, z: goalBlock.z + 0.5 });
    const ux = (goalBlock.x + 0.5 - from.x) / total;
    const uz = (goalBlock.z + 0.5 - from.z) / total;
    for (let i = 4; i <= step; i++) {
      for (const side of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
        const x = Math.floor(from.x + ux * i - uz * side);
        const z = Math.floor(from.z + uz * i + ux * side);
        const top = landable(x, z);
        if (top !== undefined && top >= from.y - 1) return { type: 'block', p: { x, y: top, z } };
      }
    }
    return { type: 'xz', x: Math.floor(from.x + ux * step), z: Math.floor(from.z + uz * step) };
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
      const legGoal = openSkyLeg(from, goalBlock, step);
      log.info(`fly: leg ${leg + 1} to ${legGoal.type === 'block' ? `the open-sky cell ${legGoal.p.x} ${legGoal.p.y} ${legGoal.p.z}` : legGoal.type === 'xz' ? `${legGoal.x} ${legGoal.z} (no open-sky cell known ahead)` : 'the goal'}`);
      const r = await legWalk(legGoal);
      if (!r.ok) return r.reason === 'interrupted' ? r : walk();
      const again = await autoFly(goalBlock, label, half);
      if (again?.kind === 'fly') {
        d.chat.say(again.line);
        return afterFlight(await start(again.target).result, walk);
      }
      if (!again) return walk();
    }
    return walk();
  };
  const walk0 = pve.walk.bind(pve);
  pve.walk = async (goal: Goal, opts: GotoOptions = {}, label?: string): Promise<SkillResult> => {
    if (goal.type !== 'block') return walk0(goal, opts, label);
    const name = label?.replace(/^walking to /, '') ?? fmt(goal.p);
    const f = await autoFly(goal.p, name, 1);
    if (!f) return walk0(goal, opts, label);
    const walk = () => walk0(goal, opts, label);
    if (f.kind === 'walk_out') return walkOut(goal.p, name, 1, f, walk, (leg) => walk0(leg, opts, `walking to ${name} (to open sky)`));
    d.chat.say(f.line);
    return afterFlight(await start(f.target).result, walk);
  };
  const come0 = pve.come.bind(pve);
  pve.come = async (name: string, o: { urgent?: boolean } = {}): Promise<SkillResult> => {
    const feet = pve.playerFeet(name);
    const block = feet ? { x: Math.floor(feet.x), y: Math.round(feet.y), z: Math.floor(feet.z) } : undefined;
    const f = block ? await autoFly(block, name, 2) : undefined;
    if (!f || !block) return come0(name, o);
    const walk = () => come0(name, o);
    if (f.kind === 'walk_out') return walkOut(block, name, 2, f, walk, (leg) => walk0(leg, {}, `walking to ${name} (to open sky)`));
    d.chat.say(f.line);
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
  const targetOf = (args: readonly string[], senderName: string | undefined): { target: FlyTarget } | { error: string } => {
    if (args.length === 3) {
      const p = d.parseBlock(args);
      if (!p) return { error: 'usage: !fly <x y z> | <waypoint> | <player> | home' };
      return { target: { x: p.x + 0.5, z: p.z + 0.5, top: p.y, half: 1, label: `${p.x} ${p.y} ${p.z}` } };
    }
    if (args.length !== 1) return { error: 'usage: !fly <x y z> | <waypoint> | <player> | home | stop | status | box [<slot>]' };
    const what = args[0]!;
    if (what.toLowerCase() === 'home') {
      const h = task.home?.get();
      if (!h) return { error: 'fly: no home set (!home set)' };
      return { target: { x: h.x + 0.5, z: h.z + 0.5, top: h.y, half: 2, label: 'home' } };
    }
    const w = waypointStoreOf(task)?.get(what);
    if (w) {
      const g = waypointGoal(w);
      if (g.type !== 'block') return { error: `fly: waypoint ${w.name} has no height; set it again where you stand` };
      return { target: { x: g.p.x + 0.5, z: g.p.z + 0.5, top: g.p.y, half: 1, label: w.name } };
    }
    const name = what.toLowerCase() === 'me' ? senderName : what;
    const feet = name ? pve.playerFeet(name) : undefined;
    if (feet && name) return { target: { x: Math.floor(feet.x) + 0.5, z: Math.floor(feet.z) + 0.5, top: Math.round(feet.y), half: 2, label: name } };
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
      const distance = from ? hdist(from, t.target) : 0;
      if (dim() === NETHER && from && !ceilingClear(from, t.target)) {
        reply(`fly: the Nether ceiling is too low along the way to ${t.target.label} (walk: !goto)`);
        return;
      }
      // Track AU2: no takeoff under a roof (the owner's indoor flight hit the ceiling three times)
      if (from) {
        const sky = skyHere(from, t.target);
        if (!sky.ok) {
          reply(sky.line);
          return;
        }
      }
      const p = start(t.target);
      reply(`flying to ${t.target.label} (${Math.round(distance)} blocks, about ${flightSeconds(distance)} s; ${kitLine(k)})`);
      void p.result.then((r) => {
        if (r.reason !== 'interrupted' && r.reason !== 'replaced') reply(flyEndLine(r));
      });
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
