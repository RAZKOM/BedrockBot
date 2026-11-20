// Track K4 (ADR 0108, docs/flight.md "An elytra on hand"): a flyable elytra on hand, owner-only like every command:
//   !elytra           the stock rule now (skills/supply/elytra.ts chooseElytra): with the elytra at hand under
//                     ELYTRA_LOW_USES uses over its worn limit, a better one put on: carried loose, out of a carried box,
//                     out of the chests at home when they are in reach; the reply says which and where the worn one is
//   !elytra status    the elytra at hand, its uses and the blocks they cover, the spares and where they are, the chore
// Also wired here: the takeoff's hook (ElytraController.forTrip: chat/commands-fly.ts, tasks/process/fly.ts ask it before a
// trip is refused for its elytra), the trip readiness's elytra step (tasks/pve.ts trip stock: carried spares only), the
// elytra chore (autoElytra, default off) and the `!status` part. Registered by the afk task after the rockets.
import { classify, entityFeet } from '../skills/combat/hostiles.ts';
import { ELYTRA, elytraPieces, type ElytraState } from '../skills/supply/elytra.ts';
import { supplyOf } from '../skills/supply/supply.ts';
import { heldBySave } from '../skills/test/guard.ts';
import { respawnClaimed } from '../skills/test/recovery.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import { ELYTRA_THREAT, ElytraController, elytraReply } from '../tasks/process/elytra.ts';
import type { TripStock } from '../tasks/process/readiness.ts';
import { isChoreTime } from './commands-food.ts';
import { homeControlOf } from './commands-home.ts';
import { survivalKitOf } from './commands-survival.ts';

export interface ElytraCommandExtra {
  /** World clock (tasks/night.ts WorldClock): the chore runs by day. Unknown time counts as day. */
  clock?: { readonly time: number | undefined } | undefined;
}

const controllers = new WeakMap<object, ElytraController>();

/** The elytra controller of a task (the takeoff's hook, tests, `!status`, the panel). */
export function elytraControlOf(task: object | undefined): ElytraController | undefined {
  return task ? controllers.get(task) : undefined;
}

/** `58/432 (covers about 600 blocks); no spare ...` for the `!status` line; undefined with no elytra at all. */
export function elytraStatusOf(task: object): string | undefined {
  try {
    return controllers.get(task)?.statusPart();
  } catch {
    return undefined;
  }
}

export function registerElytraCommands(d: CommandDeps, extra: ElytraCommandExtra = {}): ElytraController | undefined {
  const { pve, world, mobility, processes } = d;
  if (!pve || !world || !mobility || !processes) {
    d.chat.register({ name: 'elytra', help: '(needs walking)', run: ({ reply }) => reply(d.needsWalking('elytra')) });
    return undefined;
  }
  const log = d.log;
  const task = d.task;
  const inv = world.inventory;
  const threat = (): string | undefined => {
    const at = mobility.loop.state.pos;
    let best: { name: string; d: number } | undefined;
    for (const e of world.entities.values()) {
      if (classify(e.type) !== 'hostile' || (pve.mobs.get(e.runtimeId)?.dead ?? false)) continue;
      const f = entityFeet(e);
      const dd = Math.hypot(f.x - at.x, f.y - at.y, f.z - at.z);
      if (dd <= ELYTRA_THREAT && (!best || dd < best.d)) best = { name: e.type.replace(/^minecraft:/, ''), d: dd };
    }
    return best ? `a ${best.name} ${best.d.toFixed(0)} blocks away` : undefined;
  };
  const state = (): ElytraState => {
    const s = supplyOf(task);
    const boxes = s?.boxes().map((b) => b.slot) ?? [];
    const home = s?.available(ELYTRA).home ?? 0;
    return elytraPieces(inv, boxes, { count: home, inReach: home > 0 && (homeControlOf(task)?.logistics.inReach().inReach ?? false) });
  };
  const controller = new ElytraController({
    processes,
    settings: d.settings,
    source: {
      state,
      wear: async (from) => {
        const kit = survivalKitOf(task);
        if (!kit) return { ok: false, reason: 'no survival kit' };
        const worn = kit.armour.worn()[1];
        // (the flight kit's own move: no pin, so the automatic armour pass may put the chestplate back after a flight)
        const ok = await kit.armour.wear({ slot: 1, from, item: ELYTRA, replaces: worn?.name ?? null });
        return ok ? { ok } : { ok, reason: kit.armour.busy ? 'the armour is busy' : 'the item stack request was refused' };
      },
      swap: (a, b) => survivalKitOf(task)?.swapSlots(a, b) ?? Promise.resolve({ ok: false, reason: 'no survival kit' }),
      fromBox: async (slot, inBox, cancelled) => {
        const s = supplyOf(task);
        if (!s) return { got: 0, why: 'no supply layer' };
        return s.takeFromBox(slot, ELYTRA, inBox, { cancelled });
      },
      fromHome: async (pick, cancelled) => {
        const s = supplyOf(task);
        if (!s) return { got: 0, why: 'no supply layer' };
        const before = s.loose(ELYTRA);
        const r = await s.ensure(ELYTRA, before + 1, { cancelled, home: true, boxes: false, pick });
        return { got: Math.max(0, r.loose - before), why: r.reason };
      },
    },
    position: () => mobility.loop.state.pos,
    home: () => task.home?.get(),
    isDay: () => isChoreTime(extra.clock?.time),
    threat,
    cancel: () => {
      if (pve.mover.nav.busy) pve.mover.cancel();
      d.skills?.cancel();
    },
    waitTicks: (n) => mobility.loop.waitTicks(n),
    afterJob: () => {
      if (task.home?.get()) void pve.returnHome('elytra', { ifIdle: true, timeoutTicks: 6000 });
    },
    idle: () => !respawnClaimed(task) && !heldBySave(task, 'the elytra chore'),
    log,
  });
  controllers.set(task, controller);
  // the trip readiness (tasks/pve.ts): a carried spare put on before a long trip that may fly
  let tripDistance: number | undefined;
  const tripStock: TripStock = {
    name: 'elytra',
    needed: (to) => {
      const at = mobility.loop.state.pos;
      tripDistance = to ? Math.hypot(to.x - at.x, to.z - at.z) : undefined;
      return controller.tripNeeded(tripDistance);
    },
    run: async (alive) => {
      if (tripDistance !== undefined) await controller.tripRun(tripDistance, alive);
    },
  };
  pve.addTripStock(tripStock);
  const stop = task.stop.bind(task);
  task.stop = () => {
    controller.dispose();
    pve.removeTripStock(tripStock);
    controllers.delete(task);
    stop();
  };

  d.chat.register({
    name: 'elytra',
    help: '| status (an elytra low on uses: put on a better one, carried loose, out of a carried box or out of the chests at home in reach; the worn one is carried back)',
    group: 'work',
    example: '!elytra status',
    auto: 'a trip the elytra on my back does not cover first puts on a better one I carry (or one from the chests at home when I am there); with autoElytra on I also swap one at home by day',
    run: ({ reply, args }) => {
      const a = args[0]?.toLowerCase() ?? '';
      if (a === 'status') {
        reply(controller.statusLine());
        return;
      }
      if (a !== '') {
        reply('usage: !elytra [status]');
        return;
      }
      if (processes.userProcesses().some((p) => p.name === 'elytra')) {
        reply('elytra: busy already (!stop ends it)');
        return;
      }
      void controller.elytra().result.then((r) => reply(elytraReply(r, state(), d.settings.get('toolWearLimit'))));
    },
  });
  return controller;
}
