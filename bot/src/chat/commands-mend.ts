// Track K5 (ADR 0110, docs/survival.md "Mending (Track K5)"): the bot mends what it can, owner-only like every command:
//   !mend [status]       which pieces have Mending and their wear, which do not (a worn-out piece without it cannot be mended)
//   !mend [<piece>] [min] experience gathered on purpose until every damaged Mending piece is mended (worst first) or the
//                        one piece named is, the time bound (default 15 min) or no source left (tasks/process/mend.ts)
//   !mend stop           the job and its step
// Also wired here: the hand (tasks/mend-hand.ts) that holds a carried damaged Mending piece at each furnace take (the
// cooker's hook) and while orbs near come with the hand free (setting mendOnTheWay, default on), and after each ore of a
// `!mend` mine step (the miner's hook). Registered by the afk task after the smelt commands (the cooker, the furnaces).
import { gridOf } from '../skills/combat/targeting.ts';
import { canHarvestCarried } from '../skills/craft/table-spot.ts';
import { rawFoodCounts } from '../skills/food/finder.ts';
import { fuelItems } from '../skills/food/smelt.ts';
import { setAfterOre } from '../skills/mine/wire.ts';
import { supplyOf } from '../skills/supply/supply.ts';
import { gearPieces, mendStatusLine } from '../skills/survival/mend.ts';
import { HOLD_MAX_TICKS, MEND_THREAT, MendHand } from '../tasks/mend-hand.ts';
import { holdThreat, nearHostile, walkThreat, type HoldThreatDeps } from '../tasks/mend-threat.ts';
import { isNight } from '../tasks/night.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import type { Process } from '../tasks/process/manager.ts';
import { registerGoal } from '../tasks/goals.ts';
import { MEND_CHORE_HOME, MEND_CHORE_ITEMS_HOUR, MEND_CHORE_MINUTES, MEND_CHORE_SHARE, MendChore, MendJob, ORE_XP, parseMendArgs, postCheck, postWithinGround, SMELT_XP, type MendJobDeps, type PostInput, type PostResult } from '../tasks/process/mend.ts';
import { dimensionName } from '../world/dimension.ts';
import type { Vec3 } from '../world/types.ts';
import { isChoreTime } from './commands-food.ts';
import { respawnClaimed } from '../skills/test/recovery.ts';
import { heldBySave } from '../skills/test/guard.ts';
import type { ChatLine } from './text.ts';
import { OBTAIN_ABORT_ON } from './commands-kit.ts';
import { foodControllerOf } from './commands-food.ts';
import { homeControlOf } from './commands-home.ts';
import { smeltControlOf, smeltLine } from './commands-smelt.ts';
import { survivalKitOf } from './commands-survival.ts';

/** Ores within this many blocks of the bot are a `!mend` source. */
export const MEND_ORE_NEAR = 24;
/** The walk to orbs that lie: this many ticks at most (5 s). */
export const WALK_TICKS = 100;
/** Track K6: the post ends when the bot has been farther than POST_HOME_NEAR from home this long (a fight's chase). */
const POST_AWAY_MS = 30_000;
/** A step's process must appear within this long of its command. */
const START_MS = 5000;
const POLL_MS = 250;

export interface MendControl {
  hand: MendHand;
  job(): MendJob | undefined;
  /** Track K6: the autoMend chore. */
  chore: MendChore;
  status(): string;
  /** The hold rule now (tasks/mend-threat.ts): what would stop a hold, or undefined (tests, the log). */
  threat(): { why: string; pending: boolean } | undefined;
}

const controls = new WeakMap<object, MendControl>();

/** The mend control of a task (tests, `!status`). */
export function mendControlOf(task: object): MendControl | undefined {
  return controls.get(task);
}

export function registerMendCommands(d: CommandDeps): MendControl | undefined {
  const { pve, world, mobility, processes } = d;
  if (!pve || !world || !mobility || !processes) {
    d.chat.register({ name: 'mend', help: '(needs walking)', run: ({ reply }) => reply(d.needsWalking('mend')) });
    return undefined;
  }
  const task = d.task;
  const log = d.log;
  const inv = world.inventory;
  const limits = (): { toolWearLimit: number; mendAt: number } => ({ toolWearLimit: d.settings.get('toolWearLimit'), mendAt: d.settings.get('mendAt') });
  const pieces = () => {
    const s = limits();
    return gearPieces(inv, s.toolWearLimit, s.mendAt);
  };
  // the hold rule (tasks/mend-threat.ts): a hostile that can hurt the bot during a hold, by the fight's own tests (its
  // mob tracker, the planner's grid for lines of sight, the guard's path probes); the strict rule where the body walks away
  const threatDeps: HoldThreatDeps = { entities: () => world.entities, mobs: pve.mobs, world, grid: () => gridOf(pve.mover), path: () => pve.pathReach };
  const threat = () => holdThreat(threatDeps, mobility.loop.state.pos, HOLD_MAX_TICKS);
  const near = (): string | undefined => nearHostile(threatDeps, mobility.loop.state.pos, MEND_THREAT);
  // Track K6: the walk to orbs that lie: with no hostile within 16 as before; with some, only when the hold rule's tests
  // over the hold and the walk (walkThreat) find none of them able to reach or shoot the bot or the orbs
  const walkBlocked = (to: Vec3): { why: string; pending?: boolean } | undefined => {
    const n = near();
    if (!n) return undefined;
    const t = walkThreat(threatDeps, mobility.loop.state.pos, to, HOLD_MAX_TICKS + WALK_TICKS, MEND_THREAT);
    if (t) return { why: t.why, ...(t.pending ? { pending: true } : {}) };
    log.info(`mend: the walk to the orbs with ${n}: none within ${MEND_THREAT} can reach me or the orbs`);
    return undefined;
  };
  const hand = new MendHand({
    inventory: inv,
    select: (slot) => void pve.hotbar.select(slot),
    swap: (a, b) => survivalKitOf(task)?.swapSlots(a, b) ?? Promise.resolve({ ok: false, reason: 'no survival kit' }),
    move: (a, b) => survivalKitOf(task)?.moveSlot(a, b) ?? Promise.resolve({ ok: false, reason: 'no survival kit' }),
    entities: () => world.entities,
    position: () => mobility.loop.state.pos,
    walkTo: async (p) => (await mobility.skills.goto({ type: 'near', p, r: 0.8 }, { allowBreak: false, timeoutTicks: WALK_TICKS })).ok,
    threat,
    near,
    walkBlocked,
    handFree: () => {
      const s = mobility.loop.state;
      // no user process (a job's own steps hold at their takes; a mine or a walk keeps its hand), no fight, no walk, the kit idle
      return s.ready && !s.gliding && world.self.health > 0 && processes.userProcesses().length === 0 && !pve.combat.busy && !mobility.skills.nav.busy && !(survivalKitOf(task)?.busy ?? false);
    },
    settings: () => ({ on: d.settings.get('mendOnTheWay'), ...limits() }),
    waitTicks: (n) => mobility.loop.waitTicks(n),
    log,
  });
  // the furnace's takes (the cooker of the food commands)
  const cooker = foodControllerOf(task)?.d.cooker;
  cooker?.setMend({
    before: () => hand.prepare(),
    take: async (h, act) => {
      const prep = h as Awaited<ReturnType<MendHand['prepare']>>;
      if (!prep) return act();
      const r = await hand.hold(prep, 'furnace', act);
      return r.value as Awaited<ReturnType<typeof act>>;
    },
    after: (h) => hand.finish(h as Awaited<ReturnType<MendHand['prepare']>>),
  });
  // after each ore of a `!mend` mine step
  setAfterOre(world, () => hand.afterOre());
  // Track K6: the piece in the hand as the ore's break goes out (its orbs come before the dig's answer is back)
  mobility.skills.digPredict = (block) => {
    if (ORE_XP[block] !== undefined) hand.preselect();
  };
  const offTick = mobility.loop.onBeforeStep(() => hand.tick());

  // ---- the job ----------------------------------------------------------------------------------------------------------
  let job: MendJob | undefined;
  let stepProcess: Process | undefined;
  let dispatching = false;
  let lastReply: ((m: string) => void) | undefined;
  const say = d.chat.say.bind(d.chat);
  d.chat.say = (m: string) => {
    if (!m.startsWith('mend')) lastReply?.(m);
    return say(m);
  };
  const offCommand = d.chat.onCommand((e) => {
    if (e.kind !== 'run' || dispatching || !job || job.aborted) return;
    if (e.name === 'mend' || !OBTAIN_ABORT_ON.has(e.name)) return;
    job.aborted = `!${e.name}`;
    if (stepProcess && !stepProcess.done) processes.stop(stepProcess, 'stopped');
  });
  const carried = (): Map<string, number> => {
    const m = new Map<string, number>();
    for (const s of inv.slots.slice(0, 36)) if (s && s.count > 0) m.set(s.name, (m.get(s.name) ?? 0) + s.count);
    return m;
  };
  // ---- Track K6: the post (mendPost) -------------------------------------------------------------------------------------
  const night = (): boolean | undefined => {
    const t = pve.timeOfDay();
    return t === undefined ? undefined : isNight(t);
  };
  const nightProcess = () => processes.find('night')[0];
  const postInput = (): PostInput => {
    const home = task.home?.get();
    const me = mobility.loop.state.pos;
    const chest = inv.window(120)?.slots[1]?.name ?? '';
    const np = nightProcess();
    const nightRules = pve.d.night?.wantsShelter() ? 'the night shelter' : np && processes.active === np ? 'the bed' : undefined;
    return {
      dimension: dimensionName(world.self.dimension),
      night: night(),
      guard: pve.guard.on,
      blade: pve.carriesBlade(),
      chestplate: chest.endsWith('chestplate'),
      health: pve.health(),
      food: pve.food(),
      nightRules,
      ...(home ? { home: Math.hypot(me.x - (home.x + 0.5), me.z - (home.z + 0.5)) } : {}),
    };
  };
  const post = (): ReturnType<typeof postCheck> | undefined => {
    if (!d.settings.get('mendPost')) return night() ? { ok: false, why: 'mendPost is off' } : undefined;
    return postCheck(postInput());
  };
  const stand = async (stop: () => string | undefined): Promise<PostResult> => {
    const t0 = Date.now();
    const k0 = pve.stats.kills;
    const f0 = pve.stats.flees;
    const res = (why: string): PostResult => ({ kills: pve.stats.kills - k0, why, ms: Date.now() - t0 });
    log.info(`mend: at the post by night (${postInput().home !== undefined ? 'home' : 'here'}): guard and the reflex kill what comes`);
    // (a guard fight takes the bot off home and walks it back: away from home ends the post only after POST_AWAY_MS)
    let away: number | undefined;
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS * 2));
      const s = stop();
      if (s) return res(s);
      if (world.self.health <= 0) return res('a death');
      if (pve.stats.flees > f0) return res('a flight on foot (the post is not safe tonight)');
      const input = postInput();
      const c = postCheck(input);
      if (c.ok) away = undefined;
      else if (c.why.startsWith('home is')) {
        // within the guard's ground (its radius round home + 8) the bot is fighting for the post; farther, 30 s
        if (postWithinGround(input.home, pve.guard.radius)) away = undefined;
        else {
          away ??= Date.now();
          if (Date.now() - away > POST_AWAY_MS) return res(c.why);
        }
      } else return res(c.why);
    }
  };

  const jobDeps = (line: ChatLine | undefined): MendJobDeps => ({
    pieces,
    hand,
    // (the chore: only the furnace a smelt left its input in, the output known to wait there; a typed job opens each once)
    furnaces: () => {
      const s = smeltControlOf(task);
      if (line) return s?.furnaces() ?? [];
      const h = s?.held();
      return h ? [h] : [];
    },
    collect: async (at) => {
      const s = smeltControlOf(task);
      if (!s) return 0;
      // the chore's job runs inside its own process (a process of the collect's would pre-empt it)
      if (!line) {
        const r = await s.inline({ at }, choreCancelled);
        log.info(`mend chore: ${smeltLine(r)}`);
        return Object.values(r.cook?.cooked ?? {}).reduce((a, b) => a + b, 0);
      }
      const p = s.collect(at);
      stepProcess = p;
      const r = await p.result;
      log.info(`mend: ${smeltLine(r)}`);
      return Object.values(r.cook?.cooked ?? {}).reduce((a, b) => a + b, 0);
    },
    post,
    stand,
    carried,
    rawFood: () => [...rawFoodCounts(inv.slots).values()].reduce((a, b) => a + b, 0),
    fuelItems: () => fuelItems(inv.slots),
    home: () => {
      const s = supplyOf(task);
      const inReach = homeControlOf(task)?.logistics.inReach().inReach ?? false;
      const m = new Map<string, number>();
      if (!s || !inReach) return m;
      // the chore smelts on a furnace already standing where the cooker looks (it never crafts or sets one down)
      if (!line && (smeltControlOf(task)?.furnaces().length ?? 0) === 0) return m;
      for (const k of Object.keys(SMELT_XP)) {
        const n = s.available(k).home;
        if (n > 0) m.set(k, n);
      }
      return m;
    },
    withdraw: async (item, n) => {
      const s = supplyOf(task);
      if (!s) return 0;
      const before = s.loose(item);
      const r = await s.ensure(item, before + n, { home: true, cancelled: () => (line ? job : chore.current)?.aborted !== undefined });
      return Math.max(0, r.loose - before);
    },
    ore: () => {
      const me = mobility.loop.state.pos;
      const area = mobility.skills.nav.breakRules().protectedArea;
      const inBase = (p: Vec3): boolean => !!area && Math.hypot(p.x + 0.5 - area.x, p.y + 0.5 - area.y, p.z + 0.5 - area.z) <= area.r;
      const kit = survivalKitOf(task);
      const tools = inv.slots.slice(0, 36).map((s) => (s && (kit?.toolOk(s) ?? true) ? s : null));
      const by = new Map<string, number>();
      for (const p of world.find((b, q) => ORE_XP[b.name] !== undefined && !inBase(q), { origin: me, radius: MEND_ORE_NEAR, max: 64 })) {
        const name = world.blockAt(p)?.name;
        if (name && canHarvestCarried(tools, name)) by.set(name, (by.get(name) ?? 0) + 1);
      }
      const best = [...by].sort((a, b) => b[1] * ORE_XP[b[0]]! - a[1] * ORE_XP[a[0]]!)[0];
      return best ? { block: best[0], count: best[1] } : undefined;
    },
    // the mine source walks and digs away from where the bot stands: the strict rule (no hostile within MEND_THREAT)
    oreBlocked: near,
    run: async (command, name, ms, aborted) => {
      // the chore: a smelt run inline (its only command step)
      if (!line) {
        const s = smeltControlOf(task);
        const m = /^smelt (\S+) (\d+)$/.exec(command);
        if (!s || !m) return undefined;
        const r = await s.inline({ names: [m[1]!], n: Number(m[2]) }, () => aborted() || choreCancelled());
        return smeltLine(r);
      }
      const before = new Set(processes.userProcesses());
      let last: string | undefined;
      const seen = (m: string): void => {
        last = m;
      };
      lastReply = seen;
      try {
        dispatching = true;
        try {
          d.chat.handle({ ...line, body: `${d.chat.prefix}${command}`, message: `${d.chat.prefix}${command}` });
        } finally {
          dispatching = false;
        }
        const t0 = Date.now();
        let p: Process | undefined;
        while (!p && Date.now() - t0 < START_MS && !aborted()) {
          p = processes.userProcesses().find((x) => !before.has(x) && x.name === name);
          if (!p) await new Promise((r) => setTimeout(r, 100));
        }
        if (!p) return last;
        stepProcess = p;
        while (!p.done && !aborted() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, POLL_MS));
        if (!p.done) processes.stop(p, 'stopped');
        await new Promise((r) => setTimeout(r, 300));
        return last;
      } finally {
        stepProcess = undefined;
        if (lastReply === seen) lastReply = undefined;
      }
    },
    now: () => Date.now(),
    log,
  });

  // ---- Track K6: the chore (autoMend) ------------------------------------------------------------------------------------
  const chore: MendChore = processes.add(
    new MendChore({
      processes,
      settings: { get: (k) => d.settings.get(k) },
      isDay: () => isChoreTime(pve.timeOfDay()),
      home: () => task.home?.get(),
      position: () => mobility.loop.state.pos,
      threat: () => nearHostile(threatDeps, mobility.loop.state.pos, MEND_CHORE_HOME),
      idle: () => !respawnClaimed(task) && !heldBySave(task, 'the mend chore') && !pve.combat.busy && !(survivalKitOf(task)?.busy ?? false),
      pieces,
      busy: () => job !== undefined,
      job: (c) => new MendJob(jobDeps(undefined), undefined, MEND_CHORE_MINUTES, c),
      cancel: () => {
        if (pve.mover.nav.busy) pve.mover.cancel();
        d.skills?.cancel();
      },
      log,
    }),
  );
  // Track P4's standing goals (tasks/goals.ts): the chore is listed with the others in `!goals` and the panel's Jobs view.
  registerGoal(task, { id: 'mend', label: 'mending', setting: 'autoMend', process: chore.name, target: () => `a Mending piece at or under ${Math.round(MEND_CHORE_SHARE * 100)} % of its uses; at most ${MEND_CHORE_ITEMS_HOUR} items an hour` });
  /** The chore's pass is over or pre-empted (its inline smelt stops). */
  const choreCancelled = (): boolean => {
    const j = chore.current;
    return !j || j.aborted !== undefined;
  };

  const control: MendControl = {
    hand,
    job: () => job,
    chore,
    status: () => mendStatusLine(pieces()),
    threat: () => threat(),
  };
  controls.set(task, control);
  const stop = task.stop.bind(task);
  task.stop = () => {
    offTick();
    offCommand();
    setAfterOre(world, undefined);
    mobility.skills.digPredict = undefined;
    cooker?.setMend(undefined);
    if (job) job.aborted = 'stopped';
    chore.drop();
    controls.delete(task);
    stop();
  };

  d.chat.register({
    name: 'mend',
    help: '[<piece>] [minutes] | status | stop (gather experience until the damaged Mending pieces are mended, worst first: furnace outputs, smelting what is carried or in the chests at home in reach, ores near; status: which pieces have Mending and their wear)',
    tier: 'more',
    group: 'home',
    example: '!mend elytra',
    auto: 'a Mending piece only carried (an elytra, a spare tool) is held in the hand at each furnace take and while orbs near come with no hostile able to reach the bot (mendOnTheWay); a Mending piece is set aside at mendAt % instead of being worn down to breaking',
    run: ({ reply, args, line }) => {
      const a = parseMendArgs(args);
      if (a.kind === 'error') {
        reply(`mend: ${a.why} (usage: !mend [<piece>] [minutes] | status | stop)`);
        return;
      }
      if (a.kind === 'status') {
        reply(`${mendStatusLine(pieces())}${job ? `; running: ${job.phase}` : ''}; ${chore.line()}`);
        return;
      }
      if (a.kind === 'stop') {
        if (!job) reply('mend: nothing running');
        else {
          job.aborted = '!mend stop';
          if (stepProcess && !stepProcess.done) processes.stop(stepProcess, 'stopped');
          reply('mend: stopping');
        }
        return;
      }
      if (job) {
        reply(`mend: busy already (${job.phase}; !mend stop ends it)`);
        return;
      }
      // a typed `!mend` ends the chore's pass (the user process pre-empts it too)
      chore.drop();
      const j = new MendJob(jobDeps(line), a.want, a.minutes);
      job = j;
      reply(`mend: ${a.want ? `the ${a.want}` : 'every damaged Mending piece'} for up to ${a.minutes} min (${mendStatusLine(pieces()).replace(/^mend: /, '')})`);
      void j
        .run()
        .then((r) => {
          // the whole line in the log (the reply may be cut at the chat's limit: the post's reason comes last)
          log.info(`mend: the job's end: ${r.line}`);
          reply(r.line);
        })
        .catch((err: unknown) => reply(`mend: failed (${err instanceof Error ? err.message : String(err)})`))
        .finally(() => {
          if (job === j) job = undefined;
        });
    },
  });
  return control;
}
