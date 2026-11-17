// Track K1 (ADR 0096, docs/pve.md "Milk on hand"): milk on hand for Track M7's `milkCure`, owner-only like every command:
//   !milk [n]       fill every empty bucket carried at the cows, mooshrooms and goats within 24 blocks, and stock up to
//                   milkKeep (or n) milk buckets: out of the carried boxes, the chests at home when the bot is there, a
//                   bucket crafted from 3 iron ingots with none anywhere (milkCraft); the reply says what it got
//   !milk status    the counts (carried, in the boxes, at home), the mobs near, the chore, what the next pass would do
// Also wired here: the milk chore (autoMilk, default off; tasks/process/milk.ts), the trip readiness's milk step
// (tasks/pve.ts tripStock: before a long trip, milk out of the boxes and the chests at home) and the `!status` part
// (`milk 1/2 (1 empty bucket)`). Registered by the afk task after the home logistics and the crafter (tasks/registry.ts).
import type { Vec3 } from '../connection/types.ts';
import { classify, entityFeet } from '../skills/combat/hostiles.ts';
import { BabyTracker } from '../skills/food/finder.ts';
import { BUCKET, bucketCounts, MILK, MILK_RADIUS, MILK_THREAT, Milker, type MilkStockInput } from '../skills/food/milk.ts';
import { closePenGates, leavePen, PenDetector, type Pen } from '../skills/food/pen.ts';
import { craftLine } from '../skills/craft/crafter.ts';
import { supplyOf } from '../skills/supply/supply.ts';
import { heldBySave } from '../skills/test/guard.ts';
import { respawnClaimed } from '../skills/test/recovery.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import { MilkController, milkReply } from '../tasks/process/milk.ts';
import { craftControlOf } from './commands-craft.ts';
import { foodControllerOf, foodExtrasOf, isChoreTime } from './commands-food.ts';
import { homeControlOf } from './commands-home.ts';

export interface MilkCommandExtra {
  /** World clock (tasks/night.ts WorldClock): the chore runs by day. Unknown time counts as day. */
  clock?: { readonly time: number | undefined } | undefined;
}

const controllers = new WeakMap<object, MilkController>();

/** The milk controller of a task (tests, `!status`, the panel). */
export function milkControllerOf(task: object): MilkController | undefined {
  return controllers.get(task);
}

/** `1/2 (1 empty bucket)` for the `!status` line; undefined without the controller or with milkKeep 0 and no milk. */
export function milkStatusOf(task: object): string | undefined {
  try {
    return controllers.get(task)?.statusPart();
  } catch {
    return undefined;
  }
}

const MAX_MILK = 9;

export function registerMilkCommands(d: CommandDeps, extra: MilkCommandExtra = {}): MilkController | undefined {
  const { pve, world, mobility, processes } = d;
  if (!pve || !world || !mobility || !processes) {
    d.chat.register({ name: 'milk', help: '(needs walking)', run: ({ reply }) => reply(d.needsWalking('milk')) });
    return undefined;
  }
  const log = d.log;
  const task = d.task;
  // the food commands' pens and baby flags when they run (they do on the afk task), else our own
  const fx = (() => {
    const f = foodControllerOf(task);
    return f ? foodExtrasOf(f) : undefined;
  })();
  const ownBabies = fx ? undefined : new BabyTracker(d.conn);
  const babies = fx?.babies ?? ownBabies!;
  const pens = fx?.pens ?? new PenDetector({ blockAt: (p) => world.blockAt(p) });
  const penOf = (e: { type: string; pos: Vec3; username?: string }): Pen | undefined => pens.penAt(entityFeet(e));
  const penMove = { world, mover: pve.mover, position: () => mobility.loop.state.pos };
  const isDead = (rid: bigint): boolean => pve.mobs.get(rid)?.dead ?? false;
  const threat = (): string | undefined => {
    const at = mobility.loop.state.pos;
    let best: { name: string; d: number } | undefined;
    for (const e of world.entities.values()) {
      if (classify(e.type) !== 'hostile' || isDead(e.runtimeId)) continue;
      const f = entityFeet(e);
      const dd = Math.hypot(f.x - at.x, f.y - at.y, f.z - at.z);
      if (dd <= MILK_THREAT && (!best || dd < best.d)) best = { name: e.type.replace(/^minecraft:/, ''), d: dd };
    }
    return best ? `a ${best.name} ${best.d.toFixed(0)} blocks away` : undefined;
  };
  const milker = new Milker({
    entities: () => world.entities,
    mover: pve.mover,
    loop: mobility.loop,
    inventory: world.inventory,
    hotbar: pve.hotbar,
    puller: pve.combat.puller,
    source: d.conn,
    isBaby: (rid) => babies.isBaby(rid),
    isDead,
    blockAt: (p) => world.blockAt(p),
    penOf,
    penAt: (p) => pens.penAt(p),
    leavePen: (pen, cancelled) => leavePen(penMove, pen, cancelled),
    closeGates: (pen, cancelled) => closePenGates(penMove, pen, cancelled),
    threat,
    log,
  });
  const loose = (name: string): number => world.inventory.slots.slice(0, 36).reduce((a, s) => a + (s?.name.replace(/^minecraft:/, '') === name ? s.count : 0), 0);
  const take = async (item: string, n: number, cancelled: () => boolean, home: boolean): Promise<{ got: number; why?: string | undefined }> => {
    const s = supplyOf(task);
    if (!s) return { got: 0, why: 'no supply layer' };
    const before = s.loose(item);
    const r = await s.ensure(item, before + n, { cancelled, home });
    return { got: Math.max(0, r.loose - before), why: r.reason };
  };
  const controller = new MilkController({
    processes,
    settings: d.settings,
    milker,
    source: {
      input: (keep): MilkStockInput => {
        const c = bucketCounts(world.inventory.slots);
        const s = supplyOf(task);
        const hm = s?.available(MILK);
        const hb = s?.available(BUCKET);
        const cc = craftControlOf(task);
        return {
          keep,
          milk: c.milk,
          empty: c.empty,
          boxedMilk: hm?.carried ?? 0,
          boxedEmpty: hb?.carried ?? 0,
          homeMilk: hm?.home ?? 0,
          homeEmpty: hb?.home ?? 0,
          atHome: homeControlOf(task)?.logistics.atHome() ?? false,
          iron: loose('iron_ingot'),
          craft: d.settings.get('milkCraft') && !!cc,
          table: loose('crafting_table') > 0 || (cc?.crafter.tablesAround().length ?? 0) > 0,
        };
      },
      fromBoxes: (item, n, cancelled) => take(item, n, cancelled, false),
      fromHome: (item, n, cancelled) => take(item, n, cancelled, true),
      craft: async (cancelled) => {
        const cc = craftControlOf(task);
        if (!cc) return { ok: false, line: 'no crafter' };
        const r = await cc.crafter.craft(BUCKET, 1, cancelled);
        return { ok: r.crafted > 0, line: craftLine(r) };
      },
    },
    position: () => mobility.loop.state.pos,
    home: () => task.home?.get(),
    inventory: world.inventory,
    isDay: () => isChoreTime(extra.clock?.time),
    threat,
    idle: () => !respawnClaimed(task) && !heldBySave(task, 'the milk chore'),
    cancel: () => {
      if (pve.mover.nav.busy) pve.mover.cancel();
      d.skills?.cancel();
    },
    afterJob: () => {
      if (task.home?.get()) void pve.returnHome('milk', { ifIdle: true, timeoutTicks: 6000 });
    },
    log,
  });
  controllers.set(task, controller);
  // the trip readiness (tasks/pve.ts TripPrep): milk out of the boxes and the chests at home before a long trip
  pve.tripStock = {
    needed: () => controller.tripNeeded(),
    run: async (alive) => {
      await controller.tripRun(alive);
    },
  };
  const stop = task.stop.bind(task);
  task.stop = () => {
    controller.dispose();
    ownBabies?.dispose();
    if (pve.tripStock) pve.tripStock = undefined;
    stop();
  };

  d.chat.register({
    name: 'milk',
    help: `[n] | status (fill the empty buckets I carry at a cow, mooshroom or goat within ${MILK_RADIUS} blocks and keep milkKeep milk buckets: out of my boxes, the chests at home, a bucket crafted from 3 iron ingots; milk is drunk against a witch's poison)`,
    group: 'work',
    example: '!milk',
    auto: `a long trip first takes the milk buckets missing to milkKeep out of my boxes and the chests at home; with autoMilk on it also fills them at the cows within ${MILK_RADIUS} of home by day`,
    run: ({ reply, args }) => {
      const a = args[0]?.toLowerCase() ?? '';
      if (a === 'status') {
        reply(controller.statusLine());
        return;
      }
      const n = a === '' ? undefined : Number(a);
      if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > MAX_MILK)) {
        reply(`usage: !milk [n 1..${MAX_MILK}] | status`);
        return;
      }
      const c = bucketCounts(world.inventory.slots);
      const want = n ?? Math.max(controller.keep(), c.milk + c.empty);
      if (want <= c.milk) {
        reply(`milk: ${c.milk} milk bucket${c.milk === 1 ? '' : 's'} carried already (milkKeep ${controller.keep()})`);
        return;
      }
      reply(`milk: ${c.milk} of ${want} carried, ${c.empty} empty bucket${c.empty === 1 ? '' : 's'}; getting ${want - c.milk}${processes.paused ? ' (held: !resume)' : ''}`);
      void controller.milk(want).result.then((r) => reply(milkReply(r)));
    },
  });
  return controller;
}
