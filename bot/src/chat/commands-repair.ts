// Track K7 (ADR 0121, docs/flight.md "Renewing an elytra at an anvil (Track K7)"): an item renewed at an anvil, owner-only
// like every command:
//   !repair [elytra|<item>] [membranes|combine] [last]
//                     the elytra at hand (on the back, else the one the kit puts on) or the most worn carried <item>, at an
//                     anvil within 24 blocks (walked to; never placed): its repair material (phantom membranes) out of the
//                     inventory, the carried boxes or the chests at home in reach, else a second one combined; the levels
//                     and the cost checked before it pays, and the item's last renewal (after it every operation would be
//                     too expensive) only with `last`; a worn elytra goes on again afterwards
//   !repair status    the elytra's uses, its prior-work penalty and the renewals left, the membranes, the levels, the anvil,
//                     the chore
// Also wired here: the renewal chore (autoRepair, default off, its goal row) and the takeoff's hint (repairHintFor:
// chat/commands-fly.ts offers `!repair` when an elytra refuses a trip). Registered by the afk task after the elytra.
import { isAnvil } from '../skills/items/anvil.ts';
import { ANVIL_REACH, anvilDistance, AnvilUser } from '../skills/items/anvil-use.ts';
import { classify, entityFeet } from '../skills/combat/hostiles.ts';
import { ELYTRA, type ElytraNeed } from '../skills/supply/elytra.ts';
import { supplyOf } from '../skills/supply/supply.ts';
import { maxDurability } from '../skills/survival/tools.ts';
import { heldBySave } from '../skills/test/guard.ts';
import { respawnClaimed } from '../skills/test/recovery.ts';
import { registerGoal } from '../tasks/goals.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import { ANVIL_NEAR, REPAIR_THREAT, RepairController, repairLines, type RepairAsk, type RepairMode } from '../tasks/process/repair.ts';
import type { Vec3 } from '../world/types.ts';
import { elytraControlOf } from './commands-elytra.ts';
import { isChoreTime } from './commands-food.ts';
import { homeControlOf } from './commands-home.ts';
import { survivalKitOf } from './commands-survival.ts';

export interface RepairCommandExtra {
  /** The shared container tracker (tasks/registry.ts): the anvil's window. */
  containers?: ConstructorParameters<typeof AnvilUser>[0]['containers'] | undefined;
  /** World clock (tasks/night.ts WorldClock): the chore runs by day. Unknown time counts as day. */
  clock?: { readonly time: number | undefined } | undefined;
}

const controllers = new WeakMap<object, RepairController>();

/** The repair controller of a task (tests, the takeoff's hint). */
export function repairControlOf(task: object | undefined): RepairController | undefined {
  return task ? controllers.get(task) : undefined;
}

/** The takeoff's refusal tail for the elytra (chat/commands-fly.ts): `; !repair renews it at an anvil (...)` or ''. */
export function repairHintFor(task: object | undefined, need: ElytraNeed): string {
  return repairControlOf(task)?.tripHint(need) ?? '';
}

const USAGE = 'usage: !repair [elytra|<item>] [membranes|combine] [last] | status';

/** `!repair` arguments: the item (default elytra), the mode, `last`; `{ error }` (the reply) when they do not parse. */
export function parseRepairArgs(args: readonly string[]): RepairAsk | 'status' | { error: string } {
  const words = args.map((a) => a.toLowerCase());
  if (words.length === 1 && words[0] === 'status') return 'status';
  let item: string | undefined;
  let mode: RepairMode | undefined;
  let last = false;
  for (const w of words) {
    if (w === 'membranes' || w === 'membrane' || w === 'material' || w === 'phantom_membrane') mode = 'membranes';
    else if (w === 'combine') mode = 'combine';
    else if (w === 'last') last = true;
    else if (item === undefined) {
      const name = w.replace(/^minecraft:/, '');
      if (maxDurability(name) === undefined) return { error: `repair: ${name} has no uses to renew; ${USAGE}` };
      item = name;
    } else return { error: USAGE };
  }
  return { item: item ?? ELYTRA, ...(mode ? { mode } : {}), ...(last ? { last: true } : {}) };
}

export function registerRepairCommands(d: CommandDeps, extra: RepairCommandExtra = {}): RepairController | undefined {
  const { pve, world, mobility, processes } = d;
  const containers = extra.containers;
  if (!pve || !world || !mobility || !processes || !containers) {
    d.chat.register({ name: 'repair', help: '(needs walking)', run: ({ reply }) => reply(d.needsWalking('repair')) });
    return undefined;
  }
  const log = d.log;
  const task = d.task;
  const inv = world.inventory;
  const anvil = new AnvilUser({
    source: d.conn,
    loop: mobility.loop,
    world: { blockAt: (p) => world.blockAt(p), chunks: world.chunks, inventory: inv, self: world.self },
    containers,
    hotbar: pve.hotbar,
    // the survival kit's requests, looked up when used (the inventory screen for a worn elytra taken off)
    screen: {
      send: (actions, timeoutTicks) => survivalKitOf(task)?.requests.send(actions, timeoutTicks) ?? Promise.resolve({ status: 'timeout' as const, request_id: 0 }),
      withScreen: <T>(fn: () => Promise<T>) => survivalKitOf(task)?.requests.withScreen(fn) ?? Promise.resolve({ ok: false as const, reason: 'no_inventory_window' as const }),
    },
    log,
  });
  const threat = (): string | undefined => {
    const at = mobility.loop.state.pos;
    let best: { name: string; d: number } | undefined;
    for (const e of world.entities.values()) {
      if (classify(e.type) !== 'hostile' || (pve.mobs.get(e.runtimeId)?.dead ?? false)) continue;
      const f = entityFeet(e);
      const dd = Math.hypot(f.x - at.x, f.y - at.y, f.z - at.z);
      if (dd <= REPAIR_THREAT && (!best || dd < best.d)) best = { name: e.type.replace(/^minecraft:/, ''), d: dd };
    }
    return best ? `a ${best.name} ${best.d.toFixed(0)} blocks away` : undefined;
  };
  const homeInReach = (): boolean => homeControlOf(task)?.logistics.inReach().inReach ?? false;
  const controller = new RepairController({
    processes,
    settings: d.settings,
    inventory: inv,
    elytra: () => elytraControlOf(task)?.d.source.state(),
    level: () => world.self.level,
    position: () => mobility.loop.state.pos,
    home: () => task.home?.get(),
    anvils: (origin: Vec3, radius: number) => world.find((b) => isAnvil(b.name), { origin, radius, max: 4 }).map((p) => ({ x: p.x, y: p.y, z: p.z })),
    available: (names) => {
      const s = supplyOf(task);
      const a = s?.available(names);
      return { loose: a?.loose ?? 0, boxes: a?.carried ?? 0, home: a?.home ?? 0, homeInReach: (a?.home ?? 0) > 0 && homeInReach() };
    },
    fetch: async (names, n, o) => {
      const s = supplyOf(task);
      if (!s) return { loose: 0, why: 'no supply layer' };
      const r = await s.ensure(names, n, { cancelled: o.cancelled, home: o.home && homeInReach() });
      return { loose: r.loose, why: r.reason };
    },
    elytraFromBox: async (slot, inBox, cancelled) => {
      const src = elytraControlOf(task)?.d.source;
      return src ? src.fromBox(slot, inBox, cancelled) : { got: 0, why: 'no elytra controller' };
    },
    elytraFromHome: async (rank, cancelled) => {
      const src = elytraControlOf(task)?.d.source;
      return src ? src.fromHome({ accept: () => true, rank }, cancelled) : { got: 0, why: 'no elytra controller' };
    },
    walkTo: async (p) => (await mobility.skills.goto({ type: 'getToBlock', p, reach: ANVIL_REACH - 0.5 }, { allowBreak: false, timeoutTicks: 1200 })).ok,
    inReach: (p) => anvilDistance(mobility.loop.state.pos, p) <= ANVIL_REACH,
    anvil,
    wear: async (from) => {
      const kit = survivalKitOf(task);
      if (!kit) return { ok: false, reason: 'no survival kit' };
      const worn = kit.armour.worn()[1];
      const ok = await kit.armour.wear({ slot: 1, from, item: ELYTRA, replaces: worn?.name ?? null });
      return ok ? { ok } : { ok, reason: kit.armour.busy ? 'the armour is busy' : 'the item stack request was refused' };
    },
    isDay: () => isChoreTime(extra.clock?.time),
    threat,
    cancel: () => {
      if (pve.mover.nav.busy) pve.mover.cancel();
      d.skills?.cancel();
    },
    idle: () => !respawnClaimed(task) && !heldBySave(task, 'the repair chore'),
    afterJob: () => {
      if (task.home?.get()) void pve.returnHome('repair', { ifIdle: true, timeoutTicks: 6000 });
    },
    log,
  });
  controllers.set(task, controller);
  registerGoal(task, { id: 'repair', label: 'elytra renewal', setting: 'autoRepair', process: controller.chore.name, target: () => `an elytra without Mending under 100 uses over its worn limit renewed with phantom membranes at an anvil within ${ANVIL_NEAR} blocks of home` });
  const stop = task.stop.bind(task);
  task.stop = () => {
    controller.dispose();
    anvil.dispose();
    controllers.delete(task);
    stop();
  };

  d.chat.register({
    name: 'repair',
    help: '[elytra|<item>] [membranes|combine] [last] | status (renew a worn elytra at an anvil within 24 blocks: phantom membranes, else a second elytra combined; checks the levels and the cost first)',
    group: 'work',
    example: '!repair elytra membranes',
    auto: 'with autoRepair on I renew an elytra without Mending low on uses with phantom membranes at an anvil near home by day; a trip my elytra does not cover says when !repair would',
    run: ({ reply, args }) => {
      const ask = parseRepairArgs(args);
      if (ask === 'status') {
        for (const line of controller.statusLines()) reply(line);
        return;
      }
      if ('error' in ask) {
        reply(ask.error);
        return;
      }
      if (processes.userProcesses().some((p) => p.name === 'repair')) {
        reply('repair: busy already (!stop ends it)');
        return;
      }
      void controller.repair(ask).result.then((r) => {
        for (const line of repairLines(r)) reply(line);
      });
    },
  });
  return controller;
}
