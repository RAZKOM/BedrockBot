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
import { APPROACH_HEIGHT, columnsAlong, cruiseHeight, flightSeconds, hdist, walkMinutes, type LandingTarget } from '../skills/fly/plan.ts';
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
    default:
      return `fly: ${r.reason ?? 'failed'}`;
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

  /** The highest solid block of a column: the world model (loaded), else the cache. */
  const skyTop = (x: number, z: number): number | undefined => {
    const p0 = position();
    const from = Math.min(320, Math.floor((p0?.y ?? 64) + 80));
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
    return world.cache?.columnTop(x, z);
  };
  /** Safe ground for an emergency landing: a known column whose top is a plain solid block with level neighbours. */
  const groundAt = (x: number, z: number): number | undefined => {
    const top = skyTop(x, z);
    if (top === undefined) return undefined;
    const b = world.blockAt({ x, y: top, z });
    if (b && /lava|water|cactus|magma|fire|portal/.test(b.name)) return undefined;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const t = skyTop(x + dx, z + dz);
      if (t !== undefined && t < top - 1) return undefined; // a 1-wide column
    }
    return top + 1;
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
    const cz = cruiseHeight(from, target, skyTop, { clearance: d.settings.get('flyClearance'), cruise: d.settings.get('flyCruise') });
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
  /** Fly instead of walking? The target block, the reply line, or undefined (walk). */
  const autoFly = (goalBlock: Vec3, label: string): { target: FlyTarget; line: string } | undefined => {
    if (!d.settings.get('autoFly')) return undefined;
    const from = position();
    if (!from || controller.active) return undefined;
    const target: FlyTarget = { x: goalBlock.x + 0.5, z: goalBlock.z + 0.5, top: goalBlock.y, half: 1, label };
    const distance = hdist(from, target);
    if (distance <= d.settings.get('flyMin')) return undefined;
    const k = readKit(inv, memory());
    if (!kitReady(k, d.settings.get('toolWearLimit')).ok) return undefined;
    if (k.rockets < d.settings.get('fireworksMin') && k.boxRockets === 0) return undefined;
    if (dim() !== OVERWORLD && !(dim() === NETHER && ceilingClear(from, target))) return undefined;
    return { target, line: `flying (${Math.round(distance)} blocks; walking would be ~${Math.round(walkMinutes(distance))} min)` };
  };
  const walk0 = pve.walk.bind(pve);
  pve.walk = (goal: Goal, opts: GotoOptions = {}, label?: string): Promise<SkillResult> => {
    if (goal.type === 'block') {
      const f = autoFly(goal.p, label?.replace(/^walking to /, '') ?? fmt(goal.p));
      if (f) {
        d.chat.say(f.line);
        return start(f.target).result.then((r) => (r.ok || r.reason === 'landed_off' ? walk0(goal, opts, label) : r.reason === 'interrupted' || r.reason === 'replaced' ? { ok: false, reason: 'interrupted' } : { ok: false, reason: flyEndLine(r) }));
      }
    }
    return walk0(goal, opts, label);
  };
  const come0 = pve.come.bind(pve);
  pve.come = (name: string, o: { urgent?: boolean } = {}): Promise<SkillResult> => {
    const feet = pve.playerFeet(name);
    const f = feet ? autoFly({ x: Math.floor(feet.x), y: Math.round(feet.y), z: Math.floor(feet.z) }, name) : undefined;
    if (!f) return come0(name, o);
    d.chat.say(f.line);
    return start({ ...f.target, half: 2 }).result.then((r) => (r.ok || r.reason === 'landed_off' ? come0(name, o) : r.reason === 'interrupted' || r.reason === 'replaced' ? { ok: false, reason: 'interrupted' } : { ok: false, reason: flyEndLine(r) }));
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
    tier: 'front',
    group: 'go',
    example: '!fly home',
    auto: 'come and goto fly by themselves over flyMin blocks (autoFly); the flight kit (elytra, rockets, the fireworks box) is never dropped, stashed or unloaded',
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
