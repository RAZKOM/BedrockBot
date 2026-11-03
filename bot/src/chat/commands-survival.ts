// Survival-kit chat commands and wiring (PLAN.md task 7.11, Track S, docs/survival.md), owner-only:
//   !eat                 eat the best food now (the server refuses at food 20)
//   !equip               put on the best armour from the inventory now (forgets the manual choices)
//   !equip slot <0..35>  wear exactly that piece or the elytra, even a worse one (the panel's "Wear
//   !equip <item>        this"); the automatic armour pass keeps it on (survival/armour.ts pins)
//   !inv                 inventory summary (slots, held item, armour, food, throwaway blocks, tool wear)
//   !drop <item> [n]     drop n (default all) of an item (the owner may drop anything)
// `registerSurvivalCommands(deps)` is called once by the afk task (tasks/registry.ts). With the
// movement stack it builds the SurvivalKit (skills/survival) on it: a Containers instance for item
// stack requests, the Hotbar of the PvE controller, both attached to the skills (so the Digger switches
// tools and the PlaceSkill can fetch blocks), the hooks (tool wear, avoidance), and wraps the task's
// stop() / status(). Without walking every command answers "<cmd> needs a task that can walk".
import { silentLogger, type Logger } from '../log.ts';
import { ARMOUR_SLOT_NAMES, armourSlotOf, wearSlotOf } from '../skills/survival/armour.ts';
import type { ItemStack } from '../world/types.ts';
import { foodInfo } from '../skills/survival/eat.ts';
import { SurvivalKit, type SurvivalSettings } from '../skills/survival/index.ts';
import { durabilityLeft, hasMending, maxDurability, mendReserve, setAsideForMending } from '../skills/survival/tools.ts';
import type { Mobility } from '../tasks/mobility.ts';
import type { PveController } from '../tasks/pve.ts';
import { Containers } from '../world/containers.ts';
import type { PacketSource, Vec3 } from '../world/types.ts';
import { findPlayer } from '../skills/follow/follow.ts';
import { entityFeet } from '../skills/combat/hostiles.ts';
import type { Chat } from './chat.ts';
import { ELYTRA, flightKitMemoryOf, flightKitSlots, isElytra, keptKitLine, readKit, ROCKET, type KitInventory } from '../skills/fly/kit.ts'; // Track AU: the flight kit is kept by !drop all / items
import { keepBoxNameOf, keepNameOf, keptBoxesLine, keptBoxSlots } from '../skills/home/boxing.ts'; // Track AV: the named (bot_loot) boxes are kept by !drop all / items

export const SURVIVAL_COMMANDS = ['eat', 'equip', 'inv', 'drop', 'mend'] as const;
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
  // ---- Mending (the owner: a Mending tool or elytra is not worn down to breaking; it is set aside and mended) ----
  const mob = deps.mob!;
  const inv = mob.world.inventory;
  const mendLimit = (): { limit: number; pct: number } => {
    const s = kit.settings();
    return { limit: s.toolWearLimit, pct: s.mendAt };
  };
  /** Every carried, worn or held Mending item: where it is, its uses left, and whether it is set aside. */
  const mendItems = (): { item: ItemStack; where: string; left: number | undefined; max: number | undefined; aside: boolean }[] => {
    const out: { item: ItemStack; where: string; left: number | undefined; max: number | undefined; aside: boolean }[] = [];
    const { limit, pct } = mendLimit();
    const add = (it: ItemStack | null | undefined, where: string): void => {
      if (!it || it.count <= 0 || !hasMending(it)) return;
      const left = durabilityLeft(it);
      out.push({ item: it, where, left, max: maxDurability(it.name), aside: !!setAsideForMending(it, limit, pct) || (left !== undefined && left <= Math.max(limit, mendReserve(it.name, pct))) });
    };
    inv.slots.slice(0, 36).forEach((it, i) => add(it, `slot ${i}`));
    (inv.window?.(120)?.slots ?? []).forEach((it) => add(it, 'worn'));
    add(inv.window?.(119)?.slots[0], 'offhand');
    return out;
  };
  const mendStatus = (): string => {
    const items = mendItems();
    if (items.length === 0) return 'mend: nothing with Mending carried, worn or held';
    const list = items.map((m) => `${m.item.name} ${m.left ?? '?'}/${m.max ?? '?'} (${m.where}${m.aside ? ', set aside: !mend ' + m.item.name : ''})`);
    return `mend: ${list.join(', ')}; the XP the bot picks up repairs what it wears and holds (fights, mining coal / redstone / lapis / quartz ore, smelting); set aside at ${mendLimit().pct}% (mendAt)`;
  };
  // tell the owner once when an item goes below its reserve
  const told = new Set<string>();
  let tick = 0;
  mob.loop.onBeforeStep(() => {
    if (++tick % 200 !== 0) return;
    for (const m of mendItems()) {
      const k = `${m.item.name}:${m.where}`;
      if (!m.aside) {
        told.delete(k);
        continue;
      }
      if (told.has(k)) continue;
      told.add(k);
      chat.say(`${m.item.name} has Mending and is down to ${m.left ?? '?'} uses: set aside so it does not break; !mend ${m.item.name} to repair it`);
    }
  });
  chat.register({
    name: 'mend',
    help: '[<item>] (Mending items: what is set aside; with an item: hold it in the offhand so the XP picked up repairs it)',
    tier: 'more',
    group: 'home',
    example: '!mend diamond_pickaxe',
    auto: `a tool, weapon, armour piece or elytra with Mending is set aside (not used) at mendAt % of its durability instead of being worn down to breaking`,
    run: ({ reply, args, line }) => {
      const want = args[0]?.toLowerCase().replace(/^minecraft:/, '');
      if (!want || want === 'status') {
        reply(mendStatus());
        return;
      }
      const m = mendItems().find((x) => x.item.name === want);
      if (!m) {
        reply(`mend: no ${want} with Mending carried (${mendStatus().replace(/^mend: /, '')})`);
        return;
      }
      if (m.where === 'worn' || m.where === 'offhand') {
        reply(`mend: the ${want} is ${m.where === 'worn' ? 'worn' : 'in the offhand'}: every XP orb the bot picks up repairs it (${m.left ?? '?'}/${m.max ?? '?'})`);
        return;
      }
      if (armourSlotOf(want) !== undefined || isElytra(want)) {
        reply(`mend: wear it to repair it (!equip ${m.where}): worn pieces are repaired by the XP the bot picks up`);
        return;
      }
      // a tool or weapon: into the offhand (the shield goes back only into an empty offhand: !offhand clear when done)
      chat.handle({ ...line, body: `${chat.prefix}offhand ${want}`, message: `${chat.prefix}offhand ${want}` });
      reply(`mend: holding the ${want} in the offhand: the XP the bot picks up repairs it (guard fights, mining coal / redstone / lapis / quartz ore, smelting); !offhand clear when it is mended`);
    },
  });
  chat.register({
    name: 'equip',
    help: '[slot <0..35> | <item>] (wear the best armour from the inventory; with a slot or an item: wear exactly that piece or the elytra, kept on until !equip)',
    group: 'home', example: '!equip slot 12', auto: 'it puts on better armour as soon as it carries some, except over a piece worn by hand',
    run: ({ reply, args }) => {
      const want = parseEquipArgs(args, deps.mob?.world.inventory.slots ?? []);
      if (want.kind === 'error') {
        reply(want.reason);
        return;
      }
      if (want.kind === 'slot') {
        void kit.wear(want.slot).then((r) => reply(wearReply(r, want.slot)));
        return;
      }
      void kit.equip({ reset: true }).then((r) => {
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
    help: '<item> [n] | all | items | flightkit | slot <0..35> | bot_loot [n] (drop an item, everything, everything except food, armour, tools and weapons, the flight kit, one inventory slot, or the named boxes; all and items keep the flight kit and the bot_loot boxes)',
    group: 'home', example: '!drop items', auto: 'junk (rotten flesh, string, ...) is dropped when the inventory is full',
    run: ({ reply, args, sender }) => {
      const [item, count] = args;
      const facing = (): Promise<void> => faceForDrop(deps.mob, sender.kind === 'player' ? sender.name.replace(/§./g, '') : undefined);
      if (!item) {
        reply('usage: !drop <item> [n] | all | items | flightkit | slot <0..35> | bot_loot [n]');
        return;
      }
      if (item === 'flightkit') {
        // Track AU: the flight kit (elytra, rockets, the fireworks box) is kept by all and items; this drops it
        void facing().then(() => dropFlightKit(kit, deps.mob?.world.inventory, deps.task)).then(reply);
        return;
      }
      // an explicit slot (the panel's Drop) or `bot_loot`: the owner's own choice, so the kept boxes and the flight kit go too
      if (item === 'slot' || item === keepNameOf(keepBoxNameOf(deps.task)).toLowerCase()) {
        const inv = deps.mob?.world.inventory;
        if (!inv) {
          reply('drop: no inventory');
          return;
        }
        let slots: number[];
        if (item === 'slot') {
          const i = Number(count);
          if (!Number.isInteger(i) || i < 0 || i > 35) {
            reply('usage: !drop slot <0..35>');
            return;
          }
          slots = [i];
        } else {
          const n = count === undefined ? Infinity : Number(count);
          if (!(n >= 1)) {
            reply(`usage: !drop ${item} [n >= 1]`);
            return;
          }
          slots = [...keptBoxSlots(inv, keepBoxNameOf(deps.task))].sort((a, b) => a - b).slice(0, n);
        }
        void (async () => {
          await facing();
          const out: string[] = [];
          for (const i of slots) {
            const st = inv.slots[i];
            if (!st || st.count <= 0) continue;
            // every other slot of that name is skipped: only this one goes
            const others = new Set(inv.slots.slice(0, 36).map((x, j) => (j !== i && x?.name === st.name ? j : -1)).filter((j) => j >= 0));
            const r = await kit.drop(st.name, st.count, others);
            if (!r.ok) {
              out.push(`${st.name} (slot ${i}): ${r.reason ?? 'failed'}`);
              break;
            }
            out.push(`${r.dropped} ${r.item}`);
          }
          reply(out.length ? `dropped ${out.join(', ')}` : item === 'slot' ? `drop: slot ${count} is empty` : `drop: no ${item} box carried`);
        })();
        return;
      }
      if (item === 'all' || item === 'items') {
        // `all` also sheds the worn armour and the offhand (kit.dropWorn); `items` keeps them on
        const names = new Set<string>();
        const inv = deps.mob?.world.inventory;
        const flightKit = inv ? flightKitSlots(inv, deps.task) : new Set<number>(); // Track AU: kept by both
        const loot = inv ? keptBoxSlots(inv, keepBoxNameOf(deps.task)) : new Set<number>(); // Track AV: kept by both
        const keptSlots = new Set([...flightKit, ...loot]);
        const keptLoot = loot.size ? `; ${keptBoxesLine(loot.size, keepBoxNameOf(deps.task))}` : '';
        inv?.slots.slice(0, 36).forEach((st, i) => {
          if (!st || st.count <= 0) return;
          if (keptSlots.has(i)) return;
          if (item === 'items' && keepOnDropItems(st.name)) return;
          names.add(st.name);
        });
        const worn = item === 'all' ? [120, 119].flatMap((w) => deps.mob?.world.inventory.window(w)?.slots.filter((st) => !!st && st.count > 0 && !isElytra(st.name)) ?? []) : [];
        const keptKit = inv && (flightKit.size > 0 || readKit(inv).elytraWorn) ? keptKitLine(readKit(inv, flightKitMemoryOf(deps.task))) : '';
        if (names.size === 0 && worn.length === 0) {
          reply(item === 'all' ? `drop: inventory empty${keptKit ? `; ${keptKit}` : ''}${keptLoot}` : `drop: nothing but food, armour, elytra, tools and weapons${keptLoot}`);
          return;
        }
        void (async () => {
          await facing();
          let dropped = 0;
          let kinds = 0;
          let failed: string | undefined;
          for (const name of names) {
            const r = await kit.drop(name, undefined, keptSlots); // Track AV: never from a kept slot of the same name
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
          reply(`dropped ${dropped} items of ${kinds} kinds${failed ? ` (stopped at ${failed})` : ''}${wornLine}${keptKit ? `; ${keptKit}` : ''}${keptLoot}`);
        })();
        return;
      }
      const n = count === undefined ? undefined : Number(count);
      if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 36 * 64)) {
        reply('usage: !drop <item> [n >= 1]');
        return;
      }
      // Track AV: `!drop <colour>_shulker_box` never throws the bot_loot boxes either (rename one to drop it)
      const invAll = deps.mob?.world.inventory;
      const loot1 = invAll ? keptBoxSlots(invAll, keepBoxNameOf(deps.task)) : new Set<number>();
      const keptLoot1 = [...loot1].filter((i) => invAll?.slots[i]?.name === item.replace(/^minecraft:/, '')).length;
      const tail = keptLoot1 ? `; ${keptBoxesLine(keptLoot1, keepBoxNameOf(deps.task))}` : '';
      void facing().then(() => kit.drop(item, n, loot1)).then((r) => {
        if (r.ok) reply(`dropped ${r.dropped} ${r.item}${tail}`);
        else if (r.reason === 'none') reply(`drop: no ${r.item}${tail}`);
        else reply(`drop ${r.item}: ${r.reason ?? 'failed'} after ${r.dropped}${tail}`);
      });
    },
  });
  return kit;
}

/**
 * Before a drop: face the player who asked (else straight ahead) and aim over their head, so the stacks fly
 * towards them and away from the bot's feet (it looked straight down and picked its own drop up again).
 * Skipped while a skill runs: a job's walk or dig keeps its view.
 */
async function faceForDrop(mob: Mobility | undefined, player: string | undefined): Promise<void> {
  const me = mob?.position();
  if (!mob || !me || mob.skills.status().busy) return;
  const e = player ? findPlayer(mob.world.entities, player) : undefined;
  let to: Vec3;
  if (e && Math.hypot(entityFeet(e).x - me.x, entityFeet(e).z - me.z) > 0.5) {
    const f = entityFeet(e);
    to = { x: f.x, y: f.y + 3, z: f.z };
  } else {
    const yaw = (mob.loop.command.yaw * Math.PI) / 180;
    to = { x: me.x - Math.sin(yaw) * 4, y: me.y + 1.62 + 1.5, z: me.z + Math.cos(yaw) * 4 };
  }
  await mob.skills.lookAt(to);
}

export type EquipArgs = { kind: 'best' } | { kind: 'slot'; slot: number } | { kind: 'error'; reason: string };

const EQUIP_USAGE = 'usage: !equip | !equip slot <0..35> | !equip <item> (an armour piece or elytra)';

/** `!equip` arguments: none = the best armour; `slot <n>`; an item name = the first inventory slot holding it (hotbar first). */
export function parseEquipArgs(args: readonly string[], slots: readonly (ItemStack | null | undefined)[]): EquipArgs {
  const [a, b] = args;
  if (a === undefined) return { kind: 'best' };
  if (a === 'slot') {
    const n = Number(b);
    return b !== undefined && /^\d{1,2}$/.test(b) && n >= 0 && n <= 35 ? { kind: 'slot', slot: n } : { kind: 'error', reason: EQUIP_USAGE };
  }
  const name = a.toLowerCase().replace(/^minecraft:/, '');
  if (wearSlotOf(name) === undefined) return { kind: 'error', reason: `equip: ${name} is not armour or an elytra; ${EQUIP_USAGE}` };
  for (let i = 0; i < Math.min(36, slots.length); i++) if (slots[i]?.name === name && slots[i]!.count > 0) return { kind: 'slot', slot: i };
  return { kind: 'error', reason: `equip: no ${name} in the inventory` };
}

/** The reply to `!equip slot <n>`. */
export function wearReply(r: { ok: boolean; item?: string; slot?: number; replaces?: string | null; reason?: string }, from: number): string {
  if (!r.ok) return `equip: ${r.item ? `${r.item}: ` : ''}${r.reason ?? 'failed'}`;
  const where = r.slot !== undefined ? ARMOUR_SLOT_NAMES[r.slot] : 'armour';
  return `equip: wearing ${r.item} (${where})${r.replaces ? `, ${r.replaces} into slot ${from}` : ''}; kept on until !equip`;
}

/** Track AU: `!drop flightkit`: the elytra (worn too), every rocket and the fireworks box. */
async function dropFlightKit(kit: SurvivalKit, inv: KitInventory | undefined, task: object | undefined): Promise<string> {
  if (!inv) return 'drop: no inventory';
  const k = readKit(inv, flightKitMemoryOf(task));
  const dropped: string[] = [];
  if (k.rockets > 0) dropped.push(`${(await kit.drop(ROCKET)).dropped} rockets`);
  if (k.boxSlot >= 0) {
    const name = inv.slots[k.boxSlot]?.name;
    // Track AV: only the fireworks box, never another box of its colour (a bot_loot box)
    const others = new Set(inv.slots.slice(0, 36).map((st, i) => (i !== k.boxSlot && st?.name === name ? i : -1)).filter((i) => i >= 0));
    if (name) dropped.push(`the fireworks box (${(await kit.drop(name, 1, others)).dropped})`);
  }
  if (k.elytraSlot >= 0) dropped.push(`${(await kit.drop(ELYTRA)).dropped} elytra`);
  if (k.elytraWorn) {
    const w = await kit.dropWorn();
    dropped.push(w.dropped.includes('elytra') ? 'the worn elytra' : 'the worn elytra: refused');
  }
  return dropped.length ? `dropped the flight kit: ${dropped.join(', ')}` : 'drop: no flight kit (elytra, rockets, fireworks box)';
}

/** `!drop items` keeps these: anything with durability (tools, weapons, armour, elytra, shields), armour, real food (not rotten flesh and the like), totems, shulker boxes, ender chests. */
const isRealFood = (n: string): boolean => { const f = foodInfo(n); return f !== undefined && !f.bad; };
export function keepOnDropItems(name: string): boolean {
  const n = name.startsWith('minecraft:') ? name.slice(10) : name;
  return maxDurability(n) !== undefined || armourSlotOf(n) !== undefined || isRealFood(n) || n === 'totem_of_undying' || n.endsWith('shulker_box') || n === 'ender_chest' || n === ROCKET; // Track AU: the rockets
}
