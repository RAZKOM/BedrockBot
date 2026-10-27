// Survival-kit chat commands and wiring (PLAN.md task 7.11, Track S, docs/survival.md), owner-only:
//   !eat                 eat the best food now (the server refuses at food 20)
//   !equip               put on the best armour from the inventory now
//   !inv                 inventory summary (slots, held item, armour, food, throwaway blocks, tool wear)
//   !drop <item> [n]     drop n (default all) of an item (the owner may drop anything)
// `registerSurvivalCommands(deps)` is called once by the afk task (tasks/registry.ts). With the
// movement stack it builds the SurvivalKit (skills/survival) on it: a Containers instance for item
// stack requests, the Hotbar of the PvE controller, both attached to the skills (so the Digger switches
// tools and the PlaceSkill can fetch blocks), the hooks (tool wear, avoidance), and wraps the task's
// stop() / status(). Without walking every command answers "<cmd> needs a task that can walk".
import { silentLogger, type Logger } from '../log.ts';
import { armourSlotOf } from '../skills/survival/armour.ts';
import { foodInfo } from '../skills/survival/eat.ts';
import { SurvivalKit, type SurvivalSettings } from '../skills/survival/index.ts';
import { maxDurability } from '../skills/survival/tools.ts';
import type { Mobility } from '../tasks/mobility.ts';
import type { PveController } from '../tasks/pve.ts';
import { Containers } from '../world/containers.ts';
import type { PacketSource } from '../world/types.ts';
import type { Chat } from './chat.ts';

export const SURVIVAL_COMMANDS = ['eat', 'equip', 'inv', 'drop'] as const;
const NEEDS_WALK = 'needs a task that can walk (start with --walk, --home or --target realm)';

export interface SurvivalCommandDeps {
  chat: Chat;
  /** The Connection. */
  source: PacketSource;
  /** The movement stack (undefined without walking). */
  mob?: Mobility | undefined;
  /** The PvE controller (its combat skill and hotbar). */
  pve?: PveController | undefined;
  /** The running task: its stop() also disposes the kit, its status() gains `survival`. */
  task?: { stop(): void; status(): Record<string, unknown> };
  /** Dead or not spawned. */
  inactive?: () => boolean;
  settings?: () => Partial<SurvivalSettings>;
  /** Share the task's Containers (one item-stack request counter per connection); else the kit makes its own. */
  containers?: Containers | undefined;
  logger?: Logger;
}

const kits = new WeakMap<object, SurvivalKit>();

/** The kit built for a task (tests, status). */
export function survivalKitOf(task: object): SurvivalKit | undefined {
  return kits.get(task);
}

/** Build the kit on the movement stack (see the file comment). */
export function createSurvivalKit(deps: SurvivalCommandDeps): SurvivalKit | undefined {
  const { mob, pve, source } = deps;
  if (!mob || !pve) return undefined;
  const log = deps.logger ?? silentLogger;
  const ownContainers = !deps.containers;
  const containers = deps.containers ?? new Containers(source, mob.world.inventory, { logger: log });
  mob.skills.attach({ hotbar: pve.hotbar, containers, source });
  const kit = new SurvivalKit({
    skills: mob.skills,
    world: mob.world,
    loop: mob.loop,
    hotbar: pve.hotbar,
    containers,
    source,
    combat: pve.combat,
    ...(deps.inactive ? { inactive: deps.inactive } : {}),
    ...(deps.settings ? { settings: deps.settings } : {}),
    logger: log,
  });
  const task = deps.task;
  if (task) {
    kits.set(task, kit);
    const stop = task.stop.bind(task);
    task.stop = () => {
      kit.dispose();
      if (ownContainers) containers.dispose();
      stop();
    };
    const status = task.status.bind(task);
    task.status = () => ({ ...status(), survival: kit.status() });
  }
  return kit;
}

export function registerSurvivalCommands(deps: SurvivalCommandDeps): SurvivalKit | undefined {
  const { chat } = deps;
  const kit = createSurvivalKit(deps);
  if (!kit) {
    for (const name of SURVIVAL_COMMANDS) {
      chat.register({
        name,
        help: '(needs walking)',
        run: ({ reply }) => {
          reply(`${name} ${NEEDS_WALK}`);
        },
      });
    }
    return undefined;
  }
  chat.register({
    name: 'eat',
    help: '(eat the best food now)',
    group: 'home', example: '!eat', auto: 'it eats when food drops below 18 or health is low', // Track AM
    run: ({ reply }) => {
      void kit.eat().then((r) => {
        if (r.ok) reply(`ate ${r.item}: food ${r.foodBefore} -> ${r.foodAfter}`);
        else if (r.reason === 'no_food') reply('eat: no food');
        else if (r.reason === 'not_hungry') reply(`eat: not hungry (food ${r.foodBefore})`);
        else reply(`eat: ${r.reason ?? 'failed'}${r.item ? ` (${r.item})` : ''}`);
      });
    },
  });
  chat.register({
    name: 'equip',
    help: '(wear the best armour from the inventory)',
    group: 'home', example: '!equip', auto: 'it puts on better armour as soon as it carries some',
    run: ({ reply }) => {
      void kit.equip().then((r) => {
        if (r.reason) reply(`equip: ${r.reason}`);
        else if (r.equipped.length === 0 && r.failed.length === 0) reply(`equip: nothing better (${kit.armour.worn().map((w) => w?.name ?? '-').join(', ')})`);
        else reply(`equip: wearing ${r.equipped.join(', ') || 'nothing new'}${r.failed.length ? `; failed ${r.failed.join(', ')}` : ''}`);
      });
    },
  });
  chat.register({
    name: 'inv',
    help: '(inventory summary)',
    group: 'info', example: '!inv',
    run: ({ reply }) => {
      reply(kit.summary());
    },
  });
  chat.register({
    name: 'drop',
    help: '<item> [n] | all | items (drop an item, everything, or everything except food, armour, elytra, tools and weapons)',
    group: 'home', example: '!drop items', auto: 'junk (rotten flesh, string, ...) is dropped when the inventory is full',
    run: ({ reply, args }) => {
      const [item, count] = args;
      if (!item) {
        reply('usage: !drop <item> [n] | all | items');
        return;
      }
      if (item === 'all' || item === 'items') {
        // `all` also sheds the worn armour and the offhand (kit.dropWorn); `items` keeps them on
        const names = new Set<string>();
        for (const st of deps.mob?.world.inventory.slots.slice(0, 36) ?? []) {
          if (!st || st.count <= 0) continue;
          if (item === 'items' && keepOnDropItems(st.name)) continue;
          names.add(st.name);
        }
        const worn = item === 'all' ? [120, 119].flatMap((w) => deps.mob?.world.inventory.window(w)?.slots.filter((st) => !!st && st.count > 0) ?? []) : [];
        if (names.size === 0 && worn.length === 0) {
          reply(item === 'all' ? 'drop: inventory empty' : 'drop: nothing but food, armour, elytra, tools and weapons');
          return;
        }
        void (async () => {
          let dropped = 0;
          let kinds = 0;
          let failed: string | undefined;
          for (const name of names) {
            const r = await kit.drop(name);
            dropped += r.dropped;
            if (r.ok) kinds++;
            else if (r.reason !== 'none') {
              failed = `${name}: ${r.reason ?? 'failed'}`;
              break;
            }
          }
          let wornLine = '';
          if (item === 'all' && worn.length > 0 && !failed) {
            const w = await kit.dropWorn();
            wornLine = `; worn: ${w.dropped.length > 0 ? `dropped ${w.dropped.join(', ')}` : 'nothing dropped'}${w.refused.length > 0 ? ` (refused: ${w.refused.join(', ')})` : ''}`;
          }
          reply(`dropped ${dropped} items of ${kinds} kinds${failed ? ` (stopped at ${failed})` : ''}${wornLine}`);
        })();
        return;
      }
      const n = count === undefined ? undefined : Number(count);
      if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 36 * 64)) {
        reply('usage: !drop <item> [n >= 1]');
        return;
      }
      void kit.drop(item, n).then((r) => {
        if (r.ok) reply(`dropped ${r.dropped} ${r.item}`);
        else if (r.reason === 'none') reply(`drop: no ${r.item}`);
        else reply(`drop ${r.item}: ${r.reason ?? 'failed'} after ${r.dropped}`);
      });
    },
  });
  return kit;
}

/** `!drop items` keeps these: anything with durability (tools, weapons, armour, elytra, shields), armour, real food (not rotten flesh and the like), totems, shulker boxes, ender chests. */
const isRealFood = (n: string): boolean => { const f = foodInfo(n); return f !== undefined && !f.bad; };
export function keepOnDropItems(name: string): boolean {
  const n = name.startsWith('minecraft:') ? name.slice(10) : name;
  return maxDurability(n) !== undefined || armourSlotOf(n) !== undefined || isRealFood(n) || n === 'totem_of_undying' || n.endsWith('shulker_box') || n === 'ender_chest';
}
