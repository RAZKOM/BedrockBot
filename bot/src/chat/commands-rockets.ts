// Track R9 (ADR 0097, docs/flight.md "Rockets on hand"): rockets on hand, owner-only like every command:
//   !rockets [n]      craft rockets up to fireworksKeep (or n) rockets carried in every place (loose, the fireworks box,
//                     the other carried boxes): rockets out of the chests at home when the bot is there, then 1 paper and
//                     1 gunpowder a craft (3 rockets, flight duration 1) from the inventory, the carried boxes and the home
//                     chests; paper from sugar cane at a crafting table carried or near; the crafted rockets into the
//                     fireworks box when one is carried; the reply says what it made and what is missing
//   !rockets status   the counts by place, the materials, the chore, what the next pass would do
// Also wired here: the rockets chore (autoRockets, default off; tasks/process/rockets.ts), the trip readiness's rocket
// step (tasks/pve.ts trip stock: before a long trip that may fly, rockets crafted from what is carried) and the
// `!status` part (`rockets 40/64 (no gunpowder ...)`). Registered by the afk task after the crafter (tasks/registry.ts).
import { classify, entityFeet } from '../skills/combat/hostiles.ts';
import { craftLine } from '../skills/craft/crafter.ts';
import { elytraWornLimit, flightKitMemoryOf, readKit } from '../skills/fly/kit.ts';
import { estimateRockets } from '../skills/fly/plan.ts';
import { CANE, GUNPOWDER, isPlainRocketRecipe, materialCounts, PAPER, planRockets, recipeFlight, ROCKET, ROCKET_FLIGHT, rocketCounts, rocketRecipe, type RocketItem, type RocketStockInput } from '../skills/fly/rockets.ts';
import { supplyOf } from '../skills/supply/supply.ts';
import { heldBySave } from '../skills/test/guard.ts';
import { respawnClaimed } from '../skills/test/recovery.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import type { TripStock } from '../tasks/process/readiness.ts';
import { ROCKETS_THREAT, RocketsController, rocketsReply } from '../tasks/process/rockets.ts';
import { craftControlOf } from './commands-craft.ts';
import { isChoreTime } from './commands-food.ts';
import { homeControlOf } from './commands-home.ts';

export interface RocketCommandExtra {
  /** World clock (tasks/night.ts WorldClock): the chore runs by day. Unknown time counts as day. */
  clock?: { readonly time: number | undefined } | undefined;
}

const controllers = new WeakMap<object, RocketsController>();

/** The rockets controller of a task (tests, `!status`, the panel). */
export function rocketsControllerOf(task: object): RocketsController | undefined {
  return controllers.get(task);
}

/** `40/64 (...)` for the `!status` line; undefined without the controller or with fireworksKeep 0 and no rockets. */
export function rocketsStatusOf(task: object): string | undefined {
  try {
    return controllers.get(task)?.statusPart();
  } catch {
    return undefined;
  }
}

const MAX_ROCKETS = 640;
/** The rocket recipe the stock crafts (skills/fly/rockets.ts rocketRecipe): 1 paper and 1 gunpowder, no star. */
const plainRocket = { recipe: (r: Parameters<typeof isPlainRocketRecipe>[0]) => isPlainRocketRecipe(r) && recipeFlight(r) === ROCKET_FLIGHT };

export function registerRocketCommands(d: CommandDeps, extra: RocketCommandExtra = {}): RocketsController | undefined {
  const { pve, world, mobility, processes } = d;
  if (!pve || !world || !mobility || !processes) {
    d.chat.register({ name: 'rockets', help: '(needs walking)', run: ({ reply }) => reply(d.needsWalking('rockets')) });
    return undefined;
  }
  const log = d.log;
  const task = d.task;
  const inv = world.inventory;
  const kit = () => readKit(inv, flightKitMemoryOf(task));
  const threat = (): string | undefined => {
    const at = mobility.loop.state.pos;
    let best: { name: string; d: number } | undefined;
    for (const e of world.entities.values()) {
      if (classify(e.type) !== 'hostile' || (pve.mobs.get(e.runtimeId)?.dead ?? false)) continue;
      const f = entityFeet(e);
      const dd = Math.hypot(f.x - at.x, f.y - at.y, f.z - at.z);
      if (dd <= ROCKETS_THREAT && (!best || dd < best.d)) best = { name: e.type.replace(/^minecraft:/, ''), d: dd };
    }
    return best ? `a ${best.name} ${best.d.toFixed(0)} blocks away` : undefined;
  };
  const take = async (item: RocketItem, n: number, cancelled: () => boolean, home: boolean): Promise<{ got: number; why?: string | undefined; room?: string | undefined }> => {
    const s = supplyOf(task);
    if (!s) return { got: 0, why: 'no supply layer' };
    const before = s.loose(item);
    // Track K3: a material taken from home is crafted next: one free slot for the crafted stack (two for sugar cane: the
    // paper, then the rockets), made at home first with the take's room when the inventory is full
    const spare = !home || item === ROCKET ? 0 : item === CANE ? 2 : 1;
    const r = await s.ensure(item, before + n, { cancelled, home, ...(spare > 0 ? { spare } : {}) });
    return { got: Math.max(0, r.loose - before), why: r.reason, ...(r.room ? { room: r.room } : {}) };
  };
  const counts = () => {
    const k = kit();
    return rocketCounts(materialCounts(inv.slots).rockets, k.boxSlot >= 0 ? k.boxRockets : 0, supplyOf(task)?.carried(ROCKET) ?? 0);
  };
  const controller = new RocketsController({
    processes,
    settings: d.settings,
    source: {
      input: (keep): RocketStockInput => {
        const m = materialCounts(inv.slots);
        const s = supplyOf(task);
        const stock = (item: string, loose: number) => {
          const a = s?.available(item);
          return { loose, boxed: a?.carried ?? 0, home: a?.home ?? 0 };
        };
        const cc = craftControlOf(task);
        return {
          keep,
          rockets: counts(),
          homeRockets: s?.available(ROCKET).home ?? 0,
          paper: stock(PAPER, m.paper),
          gunpowder: stock(GUNPOWDER, m.gunpowder),
          cane: stock(CANE, m.cane),
          atHome: homeControlOf(task)?.logistics.inReach().inReach ?? false, // Track K3: the chests at home in reach (homeChestReach), as for the milk
          table: inv.slots.slice(0, 36).some((x) => x?.name === 'crafting_table' && x.count > 0) || (cc?.crafter.tablesAround().length ?? 0) > 0,
          recipe: !!cc && rocketRecipe(cc.recipes.byOutput(ROCKET)) !== undefined,
        };
      },
      counts,
      fromBoxes: (item, n, cancelled) => take(item, n, cancelled, false),
      fromHome: (item, n, cancelled) => take(item, n, cancelled, true),
      craft: async (item, n, cancelled) => {
        const cc = craftControlOf(task);
        if (!cc) return { made: 0, line: 'no crafter' };
        const r = await cc.crafter.craft(item, n, cancelled, item === ROCKET ? plainRocket : undefined);
        return { made: r.crafted, line: craftLine(r) };
      },
      stow: async (n, cancelled) => {
        const s = supplyOf(task);
        const k = kit();
        if (!s || k.boxSlot < 0) return { moved: 0, why: 'no fireworks box carried' };
        const main = () => inv.slots.slice(9, 36).reduce((a, x) => a + (x?.name === ROCKET ? x.count : 0), 0);
        const start = main();
        const moves = () => {
          let left = Math.min(n - Math.max(0, start - main()), main());
          const out: { slot: number; count: number; name: string }[] = [];
          for (let i = 35; i >= 9 && left > 0; i--) {
            const x = inv.slots[i];
            if (x?.name !== ROCKET || x.count <= 0) continue;
            const c = Math.min(x.count, left);
            out.push({ slot: i, count: c, name: x.name });
            left -= c;
          }
          return out;
        };
        const r = await s.putInto(k.boxSlot, moves, { cancelled });
        return { moved: Math.max(0, start - main()), why: r.reason };
      },
    },
    position: () => mobility.loop.state.pos,
    home: () => task.home?.get(),
    isDay: () => isChoreTime(extra.clock?.time),
    threat,
    canFly: () => {
      const k = kit();
      if (!k.elytraWorn && k.elytraSlot < 0) return false;
      return k.elytraLeft === undefined || k.elytraLeft > elytraWornLimit(d.settings.get('toolWearLimit'), k);
    },
    estimate: (dist) => estimateRockets(dist, Math.min(d.settings.get('flyMaxClimb'), dist / 10 + 12)),
    idle: () => !respawnClaimed(task) && !heldBySave(task, 'the rockets chore'),
    cancel: () => {
      if (pve.mover.nav.busy) pve.mover.cancel();
      d.skills?.cancel();
    },
    afterJob: () => {
      if (task.home?.get()) void pve.returnHome('rockets', { ifIdle: true, timeoutTicks: 6000 });
    },
    log,
  });
  controllers.set(task, controller);
  // the trip readiness (tasks/pve.ts): rockets crafted from what is carried before a long trip that may fly
  const tripStock: TripStock = {
    name: 'rockets',
    needed: (to) => controller.tripNeeded(to),
    run: async (alive) => {
      await controller.tripRun(alive);
    },
  };
  pve.addTripStock(tripStock);
  const stop = task.stop.bind(task);
  task.stop = () => {
    controller.dispose();
    pve.removeTripStock(tripStock);
    stop();
  };

  d.chat.register({
    name: 'rockets',
    help: '[n] | status (keep fireworksKeep rockets carried: out of the chests at home, else crafted from 1 paper and 1 gunpowder for 3, paper from sugar cane at a crafting table; the crafted ones go into the fireworks box)',
    group: 'work',
    example: '!rockets',
    auto: 'a long trip that may fly first crafts rockets from what I carry when I hold fewer than the flight needs; with autoRockets on I also craft them at home by day from the home chests',
    run: ({ reply, args }) => {
      const a = args[0]?.toLowerCase() ?? '';
      if (a === 'status') {
        reply(controller.statusLine());
        return;
      }
      const n = a === '' ? undefined : Number(a);
      if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > MAX_ROCKETS)) {
        reply(`usage: !rockets [n 1..${MAX_ROCKETS}] | status`);
        return;
      }
      const want = n ?? controller.keep();
      const have = counts().total;
      if (want <= have) {
        reply(`rockets: ${have} carried already (fireworksKeep ${controller.keep()})`);
        return;
      }
      if (processes.userProcesses().some((p) => p.name === 'rockets')) {
        reply('rockets: busy already (!stop ends it)');
        return;
      }
      const plan = planRockets(controller.d.source.input(want), { home: true });
      if (plan.steps.length === 0) {
        reply(`rockets: ${have} of ${want} carried; ${plan.short ?? 'nothing to do'}`);
        return;
      }
      reply(`rockets: ${have} of ${want} carried; getting ${want - have}${processes.paused ? ' (held: !resume)' : ''}`);
      void controller.rockets(want).result.then((r) => reply(rocketsReply(r)));
    },
  });
  return controller;
}
