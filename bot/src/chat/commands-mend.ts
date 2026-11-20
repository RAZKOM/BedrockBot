// Track K5 (ADR 0110, docs/survival.md "Mending (Track K5)"): the bot mends what it can, owner-only like every command:
//   !mend [status]       which pieces have Mending and their wear, which do not (a worn-out piece without it cannot be mended)
//   !mend [<piece>] [min] experience gathered on purpose until every damaged Mending piece is mended (worst first) or the
//                        one piece named is, the time bound (default 15 min) or no source left (tasks/process/mend.ts)
//   !mend stop           the job and its step
// Also wired here: the hand (tasks/mend-hand.ts) that holds a carried damaged Mending piece at each furnace take (the
// cooker's hook) and while orbs near come with the hand free (setting mendOnTheWay, default on), and after each ore of a
// `!mend` mine step (the miner's hook). Registered by the afk task after the smelt commands (the cooker, the furnaces).
import { classify, entityFeet } from '../skills/combat/hostiles.ts';
import { canHarvestCarried } from '../skills/craft/table-spot.ts';
import { rawFoodCounts } from '../skills/food/finder.ts';
import { fuelItems } from '../skills/food/smelt.ts';
import { setAfterOre } from '../skills/mine/wire.ts';
import { supplyOf } from '../skills/supply/supply.ts';
import { gearPieces, mendStatusLine } from '../skills/survival/mend.ts';
import { MEND_THREAT, MendHand } from '../tasks/mend-hand.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import type { Process } from '../tasks/process/manager.ts';
import { MendJob, ORE_XP, parseMendArgs, SMELT_XP, type MendJobDeps } from '../tasks/process/mend.ts';
import type { Vec3 } from '../world/types.ts';
import type { ChatLine } from './text.ts';
import { OBTAIN_ABORT_ON } from './commands-kit.ts';
import { foodControllerOf } from './commands-food.ts';
import { homeControlOf } from './commands-home.ts';
import { smeltControlOf, smeltLine } from './commands-smelt.ts';
import { survivalKitOf } from './commands-survival.ts';

/** Ores within this many blocks of the bot are a `!mend` source. */
export const MEND_ORE_NEAR = 24;
/** A step's process must appear within this long of its command. */
const START_MS = 5000;
const POLL_MS = 250;

export interface MendControl {
  hand: MendHand;
  job(): MendJob | undefined;
  status(): string;
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
  const threat = (): string | undefined => {
    const at = mobility.loop.state.pos;
    for (const e of world.entities.values()) {
      if (classify(e.type) !== 'hostile' || (pve.mobs.get(e.runtimeId)?.dead ?? false)) continue;
      const f = entityFeet(e);
      const dd = Math.hypot(f.x - at.x, f.y - at.y, f.z - at.z);
      if (dd <= MEND_THREAT) return `a ${e.type.replace(/^minecraft:/, '')} ${dd.toFixed(0)} blocks away`;
    }
    return undefined;
  };
  const hand = new MendHand({
    inventory: inv,
    select: (slot) => void pve.hotbar.select(slot),
    swap: (a, b) => survivalKitOf(task)?.swapSlots(a, b) ?? Promise.resolve({ ok: false, reason: 'no survival kit' }),
    move: (a, b) => survivalKitOf(task)?.moveSlot(a, b) ?? Promise.resolve({ ok: false, reason: 'no survival kit' }),
    entities: () => world.entities,
    position: () => mobility.loop.state.pos,
    walkTo: async (p) => (await mobility.skills.goto({ type: 'near', p, r: 0.8 }, { allowBreak: false, timeoutTicks: 100 })).ok,
    threat,
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
  const jobDeps = (line: ChatLine): MendJobDeps => ({
    pieces,
    hand,
    furnaces: () => smeltControlOf(task)?.furnaces() ?? [],
    collect: async (at) => {
      const s = smeltControlOf(task);
      if (!s) return 0;
      const p = s.collect(at);
      stepProcess = p;
      const r = await p.result;
      log.info(`mend: ${smeltLine(r)}`);
      return Object.values(r.cook?.cooked ?? {}).reduce((a, b) => a + b, 0);
    },
    carried,
    rawFood: () => [...rawFoodCounts(inv.slots).values()].reduce((a, b) => a + b, 0),
    fuelItems: () => fuelItems(inv.slots),
    home: () => {
      const s = supplyOf(task);
      const inReach = homeControlOf(task)?.logistics.inReach().inReach ?? false;
      const m = new Map<string, number>();
      if (!s || !inReach) return m;
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
      const r = await s.ensure(item, before + n, { home: true, cancelled: () => job?.aborted !== undefined });
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
    run: async (command, name, ms, aborted) => {
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

  const control: MendControl = {
    hand,
    job: () => job,
    status: () => mendStatusLine(pieces()),
  };
  controls.set(task, control);
  const stop = task.stop.bind(task);
  task.stop = () => {
    offTick();
    offCommand();
    setAfterOre(world, undefined);
    cooker?.setMend(undefined);
    if (job) job.aborted = 'stopped';
    controls.delete(task);
    stop();
  };

  d.chat.register({
    name: 'mend',
    help: '[<piece>] [minutes] | status | stop (gather experience until the damaged Mending pieces are mended, worst first: furnace outputs, smelting what is carried or in the chests at home in reach, ores near; status: which pieces have Mending and their wear)',
    tier: 'more',
    group: 'home',
    example: '!mend elytra',
    auto: 'a Mending piece only carried (an elytra, a spare tool) is held in the hand at each furnace take and while orbs near come with no hostile near (mendOnTheWay); a Mending piece is set aside at mendAt % instead of being worn down to breaking',
    run: ({ reply, args, line }) => {
      const a = parseMendArgs(args);
      if (a.kind === 'error') {
        reply(`mend: ${a.why} (usage: !mend [<piece>] [minutes] | status | stop)`);
        return;
      }
      if (a.kind === 'status') {
        reply(`${mendStatusLine(pieces())}${job ? `; running: ${job.phase}` : ''}`);
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
      const j = new MendJob(jobDeps(line), a.want, a.minutes);
      job = j;
      reply(`mend: ${a.want ? `the ${a.want}` : 'every damaged Mending piece'} for up to ${a.minutes} min (${mendStatusLine(pieces()).replace(/^mend: /, '')})`);
      void j
        .run()
        .then((r) => reply(r.line))
        .catch((err: unknown) => reply(`mend: failed (${err instanceof Error ? err.message : String(err)})`))
        .finally(() => {
          if (job === j) job = undefined;
        });
    },
  });
  return control;
}
