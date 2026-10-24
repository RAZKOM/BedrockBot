// Food chat commands (PLAN.md task 7.16, Track X, docs/food.md), owner-only like every command:
//   !food [n]        hunt passive food mobs (cow, pig, sheep, chicken, rabbit, mooshroom) within 48
//                    blocks until n food items (default 8, 1..64) were picked up or none is left
//                    (never below `foodLeave` adults of a kind), then cook them when a furnace or smoker
//                    is within 16 blocks of home and fuel is carried
//   !food status     what the automatic chore sees (food points carried, foodMin, day, backoff)
//   !cook            walk to the furnace / smoker near home and cook every raw food carried
// Both run as user processes (!stop ends them; guard, flee and night pre-empt them). The automatic
// chore (settings autoFood, foodMin, foodLeave) is wired here too. Registered by the afk task
// (tasks/registry.ts, one line). Without walking every command answers `<cmd> needs a task that can walk`.
import type { Vec3 } from '../connection/types.ts';
import { BabyTracker, inventoryFoodPoints, rawFoodCounts } from '../skills/food/finder.ts';
import { Cooker, type CookContainers, type CookResult } from '../skills/food/cook.ts';
import { Hunter } from '../skills/food/hunter.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import { DEFAULT_FOOD_ITEMS, FOOD_RADIUS, FoodController, type FoodJobResult } from '../tasks/process/food.ts';
import { settingsMover } from '../tasks/process/goto.ts';
import { isNight } from '../tasks/night.ts';

export interface FoodCommandExtra {
  /** The afk task's Containers (world/containers.ts); without it `!cook` cannot open a furnace. */
  containers?: CookContainers | undefined;
  /** World clock (tasks/night.ts WorldClock): the chore runs by day. Unknown time counts as day. */
  clock?: { readonly time: number | undefined } | undefined;
}

/** The chore starts between dawn (23000) and 11500 (it pauses from then to the next dawn). */
export const CHORE_END = 11500;
export const CHORE_START = 23000;
const MAX_FOOD = 64;

export function isChoreTime(time: number | undefined): boolean {
  return time === undefined || !isNight(time, CHORE_END, CHORE_START);
}

/** Every food controller made by registerFoodCommands, by task (tests and !status read it). */
const controllers = new WeakMap<object, FoodController>();

export function foodControllerOf(task: object): FoodController | undefined {
  return controllers.get(task);
}

export function registerFoodCommands(d: CommandDeps, extra: FoodCommandExtra = {}): FoodController | undefined {
  const { pve, world, mobility, processes, skills } = d;
  if (!pve || !world || !mobility || !processes || !skills) {
    for (const name of ['food', 'cook']) {
      d.chat.register({
        name,
        help: '(needs walking)',
        run: ({ reply }) => {
          reply(d.needsWalking(name));
        },
      });
    }
    return undefined;
  }
  const log = d.log;
  const babies = new BabyTracker(d.conn);
  const home = (): Vec3 | undefined => d.task.home?.get();
  const hunter = new Hunter({
    entities: () => world.entities,
    position: () => mobility.loop.state.pos,
    mover: pve.mover,
    combat: pve.combat,
    inventory: world.inventory,
    isBaby: (rid) => babies.isBaby(rid),
    isDead: (rid) => pve.mobs.get(rid)?.dead ?? false,
    log,
  });
  const noContainers: CookContainers = { open: undefined, onOpen: () => () => undefined, onClose: () => () => undefined, close: () => undefined };
  const cooker = new Cooker({
    source: d.conn,
    loop: mobility.loop,
    world,
    containers: extra.containers ?? noContainers,
    hotbar: pve.hotbar,
    mover: settingsMover(skills, d.settings),
    home,
    log,
  });
  const food = new FoodController({
    processes,
    settings: d.settings,
    hunter,
    cooker,
    position: () => mobility.loop.state.pos,
    inventory: world.inventory,
    isDay: () => isChoreTime(extra.clock?.time),
    cancel: () => {
      if (pve.combat.busy) pve.combat.cancel();
      if (pve.mover.nav.busy) pve.mover.cancel();
    },
    afterJob: () => {
      if (home()) void pve.returnHome('food', { ifIdle: true, timeoutTicks: 6000 });
    },
    log,
  });
  controllers.set(d.task, food);
  const stop = d.task.stop.bind(d.task);
  d.task.stop = () => {
    food.dispose();
    cooker.dispose();
    babies.dispose();
    stop();
  };

  const herdLine = (): string => hunter.herdLine(mobility.loop.state.pos, FOOD_RADIUS);

  d.chat.register({
    name: 'food',
    help: `[n] | status (hunt cows, pigs, sheep, chickens, rabbits within ${FOOD_RADIUS} blocks for n food items, default ${DEFAULT_FOOD_ITEMS}; then cook them at the furnace near home)`,
    run: ({ reply, args }) => {
      const a = (args[0] ?? '').toLowerCase();
      if (a === 'status') {
        const c = food.chore.check();
        const last = food.chore.last;
        reply(
          `food: ${c.points} points carried (foodMin ${c.min}), auto ${c.auto ? 'on' : 'off'}, ${c.day ? 'day' : 'night'}` +
            `${food.chore.running ? ', chore running' : c.waitS > 0 ? `, next try in ${c.waitS} s` : ''}; ${herdLine()} within ${FOOD_RADIUS}` +
            `${last ? `; last chore: ${last.gained} items (${last.reason})` : ''}`,
        );
        return;
      }
      const n = a === '' ? DEFAULT_FOOD_ITEMS : Number(a);
      if (!Number.isInteger(n) || n < 1 || n > MAX_FOOD) {
        reply(`usage: !food [n 1..${MAX_FOOD}] | status`);
        return;
      }
      const leave = d.settings.get('foodLeave');
      reply(`gathering ${n} food items (${herdLine()} within ${FOOD_RADIUS}; keeping ${leave} of each)`);
      void food.food(n).result.then((r) => {
        reply(foodReply(r, n, leave));
      });
    },
  });

  d.chat.register({
    name: 'cook',
    help: '(cook the raw food carried in the furnace or smoker within 16 blocks of home)',
    run: ({ reply }) => {
      const raw = rawFoodCounts(world.inventory.slots);
      if (raw.size === 0) {
        reply('cook: no raw food');
        return;
      }
      const list = [...raw.entries()].map(([k, v]) => `${v} ${k}`).join(', ');
      reply(`cooking ${list}`);
      void food.cook().result.then((r) => {
        reply(r.reason === 'interrupted' && !r.cook ? 'cook: stopped' : cookReply(r.cook, inventoryFoodPoints(world.inventory.slots)));
      });
    },
  });
  return food;
}

export function foodReply(r: FoodJobResult, want: number, leave: number): string {
  const kinds = Object.entries(r.kinds)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');
  let s: string;
  if (r.reason === 'interrupted') s = `food: stopped after ${r.gained}/${want} items`;
  else if (r.reason === 'none_left') s = `food: ${r.gained}/${want} items${kinds ? ` from ${kinds}` : ''}, nothing left to hunt within ${FOOD_RADIUS} blocks (keeping ${leave} of each)`;
  else s = `food: ${r.gained}/${want} items${kinds ? ` from ${kinds}` : ''}`;
  if (r.cook) {
    const c = Object.entries(r.cook.cooked).map(([k, v]) => `${v} ${k}`);
    if (c.length) s += `; cooked ${c.join(', ')}`;
    else if (r.cook.reason !== 'done') s += `; cook: ${cookReason(r.cook.reason)}`;
  }
  return s;
}

export function cookReply(c: CookResult | undefined, points: number): string {
  if (!c) return 'cook: nothing to cook';
  const cooked = Object.entries(c.cooked).map(([k, v]) => `${v} ${k}`);
  const fuel = Object.entries(c.fuel).map(([k, v]) => `${v} ${k}`);
  const where = c.furnace ? ` in the ${c.block ?? 'furnace'} at ${c.furnace.x} ${c.furnace.y} ${c.furnace.z}` : '';
  if (c.ok) return `cooked ${cooked.join(', ') || 'nothing'}${where} (${Math.round(c.ticks / 20)} s${fuel.length ? `, fuel ${fuel.join(', ')}` : ''}); food carried ${points} points`;
  return `cook: ${cookReason(c.reason)}${cooked.length ? ` (cooked ${cooked.join(', ')} first)` : ''}${where}`;
}

function cookReason(r: string): string {
  switch (r) {
    case 'no_furnace':
      return 'no furnace or smoker within 16 blocks of home';
    case 'no_fuel':
      return 'no fuel (coal, charcoal, planks, logs, dried kelp blocks)';
    case 'nothing_to_cook':
      return 'no raw food';
    case 'furnace_busy':
      return 'the furnace holds something else';
    default:
      return r.replace(/_/g, ' ');
  }
}
