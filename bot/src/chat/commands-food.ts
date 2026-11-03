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
//
// Track AF (wave 8, food v2, docs/food.md):
//   !food [n] pen    the same, and animals inside pens may be taken too (never below 2 adults of a kind)
//   !food herds      the remembered herds within 200 blocks
//   !breed [type] [n] feed n pairs (default 1) of adult cows / sheep / mooshrooms (wheat), pigs (carrot,
//                    potato, beetroot), chickens (seeds), rabbits (dandelion, carrot) within 16 blocks
// The herd memory observes the entity tracker once a second; the breeding chore (settings autoBreed,
// chorePen) is wired here too.
import type { Vec3 } from '../connection/types.ts';
import { BabyTracker, foodKindOf, FOOD_ANIMALS, inventoryFoodPoints, rawFoodCounts } from '../skills/food/finder.ts';
import { Breeder, BREED_FOOD, breedItemCount, type BreedResult } from '../skills/food/breed.ts'; // Track AF
import { countsLine, HerdMemory, HERD_RANGE } from '../skills/food/herds.ts'; // Track AF
import { closePenGates, leavePen, PenDetector, type Pen } from '../skills/food/pen.ts'; // Track AF
import { entityFeet } from '../skills/combat/hostiles.ts'; // Track AF
import { Cooker, type CookContainers, type CookResult } from '../skills/food/cook.ts';
import { Hunter } from '../skills/food/hunter.ts';
import { FOODS } from '../skills/survival/eat.ts';
import { supplyOf } from '../skills/supply/supply.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import { BREED_RADIUS, DEFAULT_FOOD_ITEMS, FOOD_RADIUS, FoodController, parseChorePen, type FoodJobResult } from '../tasks/process/food.ts';
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

/** Track AF: the herd memory, pen detector, breeder and baby tracker of a controller (tests, status). */
export interface FoodExtras {
  herds: HerdMemory;
  pens: PenDetector;
  breeder: Breeder;
  babies: BabyTracker;
}
const extras = new WeakMap<FoodController, FoodExtras>();

export function foodExtrasOf(food: FoodController): FoodExtras | undefined {
  return extras.get(food);
}

export function registerFoodCommands(d: CommandDeps, extra: FoodCommandExtra = {}): FoodController | undefined {
  const { pve, world, mobility, processes, skills } = d;
  if (!pve || !world || !mobility || !processes || !skills) {
    for (const name of ['food', 'cook', 'breed']) {
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
  // Track AF: pens, remembered herds, breeding
  const pens = new PenDetector({ blockAt: (p) => world.blockAt(p) });
  const penOf = (e: { type: string; pos: Vec3; username?: string }): Pen | undefined => pens.penAt(entityFeet(e));
  const isDead = (rid: bigint): boolean => pve.mobs.get(rid)?.dead ?? false;
  const penMove = { world, mover: pve.mover, position: () => mobility.loop.state.pos };
  const leave = (pen: Pen, cancelled: () => boolean) => leavePen(penMove, pen, cancelled);
  const closeGates = (pen: Pen, cancelled: () => boolean) => closePenGates(penMove, pen, cancelled);
  const chorePen = (): Pen | undefined => {
    const p = parseChorePen(d.settings.get('chorePen'));
    return p ? pens.penAt({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 }) : undefined;
  };
  const herds = new HerdMemory({
    entities: () => world.entities,
    isBaby: (rid) => babies.isBaby(rid),
    isDead,
    position: () => (mobility.loop.state.ready ? mobility.loop.state.pos : undefined),
    store: () => world.cache?.herds,
    penOf,
  });
  const breeder = new Breeder({
    entities: () => world.entities,
    mover: pve.mover,
    loop: mobility.loop,
    inventory: world.inventory,
    hotbar: pve.hotbar,
    puller: pve.combat.puller,
    source: d.conn,
    isBaby: (rid) => babies.isBaby(rid),
    isInLove: (rid) => babies.isInLove(rid),
    isDead,
    babiesSince: (t) => [...babies.bornSeen].filter(([, at]) => at >= t).map(([rid]) => rid),
    penOf,
    penAt: (p) => pens.penAt(p),
    leavePen: leave,
    closeGates,
    log,
  });
  const hunter = new Hunter({
    entities: () => world.entities,
    position: () => mobility.loop.state.pos,
    mover: pve.mover,
    combat: pve.combat,
    inventory: world.inventory,
    isBaby: (rid) => babies.isBaby(rid),
    isDead,
    penOf, // Track AF
    spare: (rid) => breeder.fedRecently(rid) || babies.isInLove(rid), // Track AF: never hunt a mob fed for breeding
    penAt: (p) => pens.penAt(p),
    leavePen: leave,
    closeGates,
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
    // the food in the carried boxes counts too (the eater takes it out when nothing is loose)
    boxedFoodPoints: () => {
      const s = supplyOf(d.task);
      if (!s) return 0;
      let total = 0;
      for (const [name, f] of Object.entries(FOODS)) if (!f.bad) total += s.carried(name) * f.nutrition;
      return total;
    },
    afterJob: () => {
      if (home()) void pve.returnHome('food', { ifIdle: true, timeoutTicks: 6000 });
    },
    log,
    herds, // Track AF
    chorePen,
    waitTicks: (n) => mobility.loop.waitTicks(n),
    breeder,
    entities: () => world.entities,
    penOf,
  });
  controllers.set(d.task, food);
  extras.set(food, { herds, pens, breeder, babies });
  // Track AF: the herd memory looks at the entity tracker once a second
  const observer = setInterval(() => {
    try {
      if (mobility.loop.state.ready) herds.observe();
    } catch (e) {
      log.warn(`herd memory: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, 1000);
  observer.unref();
  const stop = d.task.stop.bind(d.task);
  d.task.stop = () => {
    clearInterval(observer);
    food.dispose();
    cooker.dispose();
    babies.dispose();
    stop();
  };

  const herdLine = (): string => hunter.herdLine(mobility.loop.state.pos, FOOD_RADIUS);

  d.chat.register({
    name: 'food',
    help: `[n] [pen] | status | herds (hunt cows, pigs, sheep, chickens, rabbits within ${FOOD_RADIUS} blocks, then remembered herds within ${HERD_RANGE}, for n food items, default ${DEFAULT_FOOD_ITEMS}; pen: animals in pens too; then cook them at the furnace near home)`,
    group: 'work', example: '!food 8', auto: 'with autoFood on it hunts by day when the food carried is below foodMin (the food chore)', // Track AM
    run: ({ reply, args }) => {
      // Track AF: `pen` anywhere in the arguments lets the hunt take penned animals
      const words = args.map((w) => w.toLowerCase());
      const withPens = words.includes('pen') || words.includes('pens');
      const a = words.find((w) => w !== 'pen' && w !== 'pens') ?? '';
      if (a === 'herds') {
        const me = mobility.loop.state.pos;
        const list = herds.near(me, HERD_RANGE);
        if (list.length === 0) {
          reply(`food: no herds remembered within ${HERD_RANGE} blocks`);
          return;
        }
        const parts = list.slice(0, 6).map((m) => {
          const w = countsLine(m.wild);
          const p = countsLine(m.penned);
          const age = Math.round((Date.now() - m.at) / 60_000);
          return `${Math.round(m.x)} ${Math.round(m.y)} ${Math.round(m.z)} (${Math.round(Math.hypot(m.x - me.x, m.z - me.z))} blocks, ${age} min ago): ${w || ''}${w && p ? '; ' : ''}${p ? `pen ${p}` : ''}`;
        });
        reply(`food: ${list.length} herd(s) remembered: ${parts.join(' | ')}`);
        return;
      }
      if (a === 'status') {
        const c = food.chore.check();
        const last = food.chore.last;
        reply(
          `food: ${c.points} points carried (foodMin ${c.min}), auto ${c.auto ? 'on' : 'off'}, ${c.day ? 'day' : 'night'}` +
            `${food.chore.running ? ', chore running' : c.waitS > 0 ? `, next try in ${c.waitS} s` : ''}; ${herdLine()} within ${FOOD_RADIUS}` +
            `${last ? `; last chore: ${last.gained} items (${last.reason})` : ''}` +
            `; ${herds.near(mobility.loop.state.pos, HERD_RANGE).length} herd(s) remembered within ${HERD_RANGE}` + // Track AF
            `; autoBreed ${d.settings.get('autoBreed') ? 'on' : 'off'}, chorePen ${d.settings.get('chorePen')}${food.breedChore?.lastWhy ? ` (${food.breedChore.lastWhy})` : ''}`,
        );
        return;
      }
      const n = a === '' ? DEFAULT_FOOD_ITEMS : Number(a);
      if (!Number.isInteger(n) || n < 1 || n > MAX_FOOD) {
        reply(`usage: !food [n 1..${MAX_FOOD}] | status`);
        return;
      }
      const leave = d.settings.get('foodLeave');
      reply(`gathering ${n} food items (${herdLine()} within ${FOOD_RADIUS}; keeping ${leave} of each${withPens ? ', pens down to 2 of each' : ''})`);
      void food.food(n, withPens).result.then((r) => {
        reply(foodReply(r, n, leave));
      });
    },
  });

  d.chat.register({
    name: 'cook',
    help: '(cook the raw food carried in the furnace or smoker within 16 blocks of home)',
    group: 'work', example: '!cook', auto: 'after every hunt (!food, !get beef, the food chore) when it carries raw food and fuel and a furnace or smoker is within 16 blocks of home',
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
  // Track AF: !breed [type] [n]
  d.chat.register({
    name: 'breed',
    help: `[type] [n] (feed n pairs, default 1, of adult animals within ${BREED_RADIUS} blocks: cow / sheep / mooshroom wheat, pig carrot / potato / beetroot, chicken seeds, rabbit dandelion / carrot)`,
    group: 'work', example: '!breed cow 2', auto: 'with autoBreed on and chorePen set it breeds that pen by day every 10 minutes while a kind has fewer than 8 adults',
    run: ({ reply, args }) => {
      let kind: string | undefined;
      let n = 1;
      for (const w of args.map((x) => x.toLowerCase())) {
        const k = foodKindOf(w.replace(/s$/, '')) ?? foodKindOf(w);
        if (k) kind = k;
        else if (/^\d+$/.test(w)) n = Number(w);
        else {
          reply(`usage: !breed [${Object.keys(FOOD_ANIMALS).join('|')}] [n 1..8]`);
          return;
        }
      }
      if (n < 1 || n > 8) {
        reply('usage: !breed [type] [n 1..8]');
        return;
      }
      if (kind && breedItemCount(world.inventory.slots, kind) < 2) {
        reply(`breed: no ${BREED_FOOD[kind]!.join(' / ')} for the ${kind}s (2 per pair)`);
        return;
      }
      const p = food.breed(kind, n);
      if (!p) {
        reply('breed: not available');
        return;
      }
      reply(`breeding ${n} ${kind ?? 'animal'} pair${n === 1 ? '' : 's'}`);
      void p.result.then((r) => {
        reply(breedReply(r, n));
      });
    },
  });
  return food;
}

/** Track AF: the `!breed` result line. */
export function breedReply(r: BreedResult, want: number): string {
  const kind = r.kind ?? 'animal';
  switch (r.reason) {
    case 'no_food':
      return `breed: no food for ${r.kind ? `the ${kind}s (${BREED_FOOD[kind]?.join(' / ') ?? '?'})` : 'any kind with a pair nearby'}`;
    case 'no_pair':
      return `breed: no two ${r.kind ? `${kind}s` : 'adults of a kind'} ready within ${BREED_RADIUS} blocks (babies, and parents fed in the last 5 minutes, do not count)`;
    case 'refused':
      return `breed: the ${kind}s did not take the food`;
    case 'interrupted':
      return `breed: stopped after ${r.pairs}/${want} pairs`;
    default:
      return `breed: fed ${r.pairs}/${want} ${kind} pair${want === 1 ? '' : 's'}, ${r.babies} ${r.babies === 1 ? 'baby' : 'babies'} so far`;
  }
}

export function foodReply(r: FoodJobResult, want: number, leave: number): string {
  const kinds = Object.entries(r.kinds)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');
  let s: string;
  if (r.reason === 'interrupted') s = `food: stopped after ${r.gained}/${want} items`;
  else if (r.reason === 'none_left') s = `food: ${r.gained}/${want} items${kinds ? ` from ${kinds}` : ''}, nothing left to hunt within ${FOOD_RADIUS} blocks (keeping ${leave} of each)`;
  else s = `food: ${r.gained}/${want} items${kinds ? ` from ${kinds}` : ''}`;
  if (r.trips?.length) s += ` (${r.trips.length} walk${r.trips.length === 1 ? '' : 's'} to remembered herds)`; // Track AF
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
