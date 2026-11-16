// Track V1 (ADR 0090, docs/inventory.md): room in the inventory. A full inventory picks up nothing (an ore's drop, a
// mob's drop, the box of a refill: the flight kit's box needs a slot to come back to), and a pull or a placement that has
// to bring an item into a full hotbar has nowhere to park what it gives up. The owner's live bot carried 36 of 36 for
// hours: a netherite kit, seven stacks of loose rockets beside its fireworks box, five empty shulker boxes, seven kinds
// of food and mob drops; a new bot fills the same 36 slots with stone, dirt and mob drops.
//
// `planRoom` is the pure plan (the inventory in, a list of steps out); the idle chore (tasks/process/room.ts) runs it.
// Below ROOM_FLOOR free slots it plans the cheapest steps that lose nothing of worth, in the order a player takes them,
// until ROOM_TARGET slots are free (or nothing more can be done):
//
//   merge     partial stacks of one item (the same wire NBT) into one: no box, no walk; the main inventory's stack
//             into the hotbar's
//   junk      the keeper's junk (rotten flesh, poisonous potatoes, string, spider eyes: the list the keeper drops at 36
//             of 36 today) dropped before the inventory is full rather than at 36; never at home with chests (the
//             unload stores it)
//   rockets   loose rockets beyond ROCKETS_LOOSE (two stacks: no trip burns that many) into the fireworks box, whole
//             stacks from the main inventory first; the box stays rockets only, so it stays the fireworks box
//   box       only below the floor (a box is set down and picked up again): what the unload would put away (its plan
//             with no chest: not the gear, the food and seed reserves, the throwaway reserve, the flight kit, the
//             boxes) into a carried box that has room: a bot_loot box first, then one this chore filled before, then
//             an empty unnamed one (never the fireworks box, a box the bot cannot read, one owed to a chest, nor a box
//             holding other things: the owner's box of sand stays a box of sand); never the items a skill takes
//             loose (KEEP_LOOSE); never at home with chests, and never with `stashShulker` off
//   compact   redstone, lapis and emeralds into their blocks (9 -> 1; nothing the bot does takes them loose, and a
//             block crafts back into nine) when that frees a slot, only with a crafting table near (at home the
//             unload's own compaction does it: `compactOnUnload`)
//   stone     with `dropStone` above 0 (the setting's default 64): of each stone-like kind (cobblestone, dirt,
//             gravel, andesite, ...) that many kept and the rest dropped, after every step above (what the stash step
//             already does in a job with no chest and no box, there keeping 16); never at home with chests, never
//             what a `!get` job of the last hour was getting
//
// At home with chests (and `autoUnload` on) the unload is the step for the loot, the junk, the stone and the spare
// empty boxes (tasks/process/unload.ts: the chore's trigger counts free slots too); the plan there merges and moves
// rockets only. Nothing here drops the gear, the flight kit, food, the reserves, a box or anything outside the junk
// list, except the stone kinds the owner turned `dropStone` on for.
import { isShulkerBox, maxStackOf, shulkerContents, shulkerSlotsUsed } from '../container/chest.ts';
import { isFireworksBox, isRocket, ROCKET } from '../fly/kit.ts';
import { isKeptBox } from '../home/boxing.ts';
import { planUnload, type UnloadSlot } from '../home/unloader.ts';
import { DEFAULT_JUNK, neverDrop } from '../survival/keeper.ts';

/** Free inventory slots the bot keeps (see the file comment of tasks/process/room.ts for the reasons). */
export const ROOM_FLOOR = 4;
/** A pass plans steps until this many slots are free (two over the floor: the next pickup does not start it again). */
export const ROOM_TARGET = 6;
/** Loose rockets kept when the rest goes into the fireworks box: two stacks (a trip burns up to about 40). */
export const ROCKETS_LOOSE = 128;
/** Slots of a shulker box. */
export const BOX_SLOTS = 27;

/** Items a skill takes loose from the inventory (never boxed by the room chore): the clutch's bucket, torches, bone meal, the crafting table, pearls. */
export const KEEP_LOOSE: ReadonlySet<string> = new Set(['water_bucket', 'bucket', 'lava_bucket', 'powder_snow_bucket', 'torch', 'soul_torch', 'bone_meal', 'crafting_table', 'ender_pearl', 'chest']);

/** Track V1: what the compact step makes (9 -> 1, and back): nothing the bot does takes these loose. */
export const ROOM_COMPACT: Readonly<Record<string, string>> = { redstone: 'redstone_block', lapis_lazuli: 'lapis_block', emerald: 'emerald_block' };

/** Stone-like blocks the `dropStone` limit applies to (filler a mining run and a dig through terrain picks up). */
export const STONE_LIKE: readonly string[] = [
  'cobblestone', 'cobbled_deepslate', 'dirt', 'coarse_dirt', 'grass_block', 'podzol', 'gravel', 'sand', 'red_sand', 'andesite', 'diorite', 'granite', 'tuff', 'calcite', 'stone', 'deepslate', 'netherrack', 'blackstone', 'basalt', 'dripstone_block', 'mud',
];

const bare = (n: string): string => (n.startsWith('minecraft:') ? n.slice(10) : n);

/** One inventory slot as the room plan sees it (the unloader's slot with the merge key and the debt mark). */
export interface RoomSlot extends UnloadSlot {
  /** What a merge compares: the item with its wire NBT. Undefined: not known (never merged). */
  key?: string;
  /** A box owed to a chest (an extract's box not back yet): never a box target. */
  owed?: boolean;
}

export interface RoomOptions {
  floor?: number;
  target?: number;
  /** The keeper's junk list (DEFAULT_JUNK). */
  junk?: readonly string[];
  rocketsLoose?: number;
  /** The fireworks box's slot (fly/kit.ts readKit), if one is carried. */
  kitBox?: number;
  /** At home with chests and `autoUnload` on: the unload takes the loot, the junk and the stone. */
  home?: boolean;
  /** `dropStone`: of each stone-like kind this many are kept, the rest dropped; 0 = never (the default here). */
  stoneKeep?: number;
  /** Never dropped as stone: what a `!get` job of the last hour was getting (`!get cobblestone 256` stays 256). */
  protect?: ReadonlySet<string>;
  /** A crafting table is near (the compact step may run). */
  table?: boolean;
  /** `stashShulker`: a carried box may be placed for loot (default true). */
  boxing?: boolean;
  /** Prints (`boxPrint`) of unnamed boxes this chore filled: they take more loot (a box holding anything else never does). */
  ownBoxes?: ReadonlySet<string>;
  /** A pass is under way: plan on to `target` (a pass starts only below `floor`). */
  started?: boolean;
  /** Steps not to plan (one failed a moment ago). */
  skip?: ReadonlySet<RoomStep['kind']>;
  /** The unloader's keep rules: the throwaway reserve, the food and seed reserves, the armour worn. */
  reserve?: number;
  foodReserve?: number;
  seedReserve?: number;
  worn?: readonly string[];
  maxStack?: (name: string) => number;
}

export type RoomStep =
  | { kind: 'merge'; from: number; to: number; name: string; count: number }
  | { kind: 'junk'; name: string; count: number; slots: number }
  | { kind: 'rockets'; box: number; moves: { slot: number; count: number }[]; count: number }
  | { kind: 'box'; box: number; moves: { slot: number; count: number; name: string }[] }
  | { kind: 'compact'; item: string; block: string; count: number; frees: number }
  | { kind: 'stone'; name: string; count: number; keep: number; slots: number };

export interface RoomPlan {
  /** Free slots now. */
  free: number;
  /** Free slots once the steps ran (the plan's own count). */
  after: number;
  steps: RoomStep[];
  /** Fewer than `floor` free after the steps: what stood in the way, for the log and the one line to the owner. */
  short?: string[];
}

interface Sim {
  slot: number;
  name: string;
  count: number;
  key?: string | undefined;
}

/**
 * The room plan (see the file comment). Nothing is planned with `floor` or more slots free; then steps in order until
 * `target` are free. Pure: the slots as given, the steps as the chore runs them (it plans again after each step).
 */
export function planRoom(slots: readonly RoomSlot[], opts: RoomOptions = {}): RoomPlan {
  const floor = opts.floor ?? ROOM_FLOOR;
  const target = Math.max(floor, opts.target ?? ROOM_TARGET);
  const maxOf = opts.maxStack ?? maxStackOf;
  const skip = opts.skip ?? new Set();
  const inv = new Map<number, Sim>();
  for (const s of slots) if (s.count > 0 && s.slot >= 0 && s.slot < 36) inv.set(s.slot, { slot: s.slot, name: bare(s.name), count: s.count, key: s.key });
  const free = (): number => 36 - inv.size;
  const plan: RoomPlan = { free: free(), after: free(), steps: [] };
  if (free() >= (opts.started ? target : floor)) return plan;
  const need = (): boolean => free() < target;
  const short: string[] = [];

  const junk = new Set((opts.junk ?? DEFAULT_JUNK).map(bare));

  // 1. merge partial stacks of one item (not the junk the next step drops)
  if (!skip.has('merge')) {
    const groups = new Map<string, Sim[]>();
    for (const s of inv.values()) {
      if (s.key === undefined || isShulkerBox(s.name) || maxOf(s.name) <= 1 || (!opts.home && junk.has(s.name) && !neverDrop(s.name))) continue;
      const g = groups.get(s.key) ?? [];
      g.push(s);
      groups.set(s.key, g);
    }
    for (const g of [...groups.values()].filter((x) => x.length > 1).sort((a, b) => a[0]!.slot - b[0]!.slot)) {
      const max = maxOf(g[0]!.name);
      // targets: the hotbar first, then the fuller stacks; the source: the last of that order (a main slot, the smallest)
      const order = (): Sim[] => g.filter((s) => inv.has(s.slot)).sort((a, b) => Number(b.slot < 9) - Number(a.slot < 9) || b.count - a.count || a.slot - b.slot);
      while (need()) {
        const o = order();
        if (o.length < 2) break;
        const src = o[o.length - 1]!;
        const into = o.slice(0, -1);
        const room = into.reduce((a, s) => a + Math.max(0, max - s.count), 0);
        if (room < src.count) break;
        let left = src.count;
        for (const t of into) {
          if (left <= 0) break;
          const n = Math.min(left, max - t.count);
          if (n <= 0) continue;
          plan.steps.push({ kind: 'merge', from: src.slot, to: t.slot, name: src.name, count: n });
          t.count += n;
          left -= n;
        }
        inv.delete(src.slot);
      }
    }
  }

  // 2. the keeper's junk, before the inventory is full
  if (need() && !opts.home && !skip.has('junk')) {
    const kinds = new Map<string, { count: number; slots: number }>();
    for (const s of inv.values()) {
      if (!junk.has(s.name) || neverDrop(s.name)) continue;
      const k = kinds.get(s.name) ?? { count: 0, slots: 0 };
      k.count += s.count;
      k.slots++;
      kinds.set(s.name, k);
    }
    for (const [name, k] of [...kinds].sort((a, b) => b[1].slots - a[1].slots || a[0].localeCompare(b[0]))) {
      if (!need()) break;
      plan.steps.push({ kind: 'junk', name, count: k.count, slots: k.slots });
      for (const s of [...inv.values()]) if (s.name === name) inv.delete(s.slot);
    }
  }

  // 3. loose rockets beyond two stacks into the fireworks box
  if (need() && !skip.has('rockets')) {
    const rockets = [...inv.values()].filter((s) => isRocket(s.name));
    const loose = rockets.reduce((a, s) => a + s.count, 0);
    const keepLoose = opts.rocketsLoose ?? ROCKETS_LOOSE;
    const box = opts.kitBox !== undefined ? slots.find((s) => s.slot === opts.kitBox && isShulkerBox(s.name) && !s.unknown) : undefined;
    if (loose > keepLoose) {
      if (!box) short.push('no fireworks box for the loose rockets');
      else {
        const room = BOX_SLOTS - (box.boxUsed ?? 0);
        // kept: the hotbar's stacks, then the fullest; moved: the rest, the main inventory's first
        let kept = 0;
        const keep = new Set<number>();
        for (const s of [...rockets].sort((a, b) => Number(b.slot < 9) - Number(a.slot < 9) || b.count - a.count || a.slot - b.slot)) {
          if (kept >= keepLoose) break;
          keep.add(s.slot);
          kept += s.count;
        }
        const moves = rockets
          .filter((s) => !keep.has(s.slot))
          .sort((a, b) => Number(a.slot < 9) - Number(b.slot < 9) || a.count - b.count || b.slot - a.slot)
          .slice(0, Math.max(0, room))
          .map((s) => ({ slot: s.slot, count: s.count }));
        if (moves.length === 0) short.push(room <= 0 ? 'the fireworks box is full' : 'no rocket stack to move');
        else {
          plan.steps.push({ kind: 'rockets', box: box.slot, moves, count: moves.reduce((a, m) => a + m.count, 0) });
          for (const m of moves) inv.delete(m.slot);
        }
      }
    }
  }

  // 4. what the unload would put away into a carried box with room (a box is placed: only below the floor)
  if (free() < floor && !opts.home && !skip.has('box')) {
    const loot = lootSlots(slots, inv, opts, junk);
    if (loot.length > 0) {
      const own = (s: RoomSlot): boolean => (s.boxUsed ?? 0) > 0 && !!opts.ownBoxes?.has(boxPrint(s.boxItems));
      const boxes = slots.filter((s) => isShulkerBox(s.name) && inv.has(s.slot) && !s.flightKit && !s.unknown && !s.owed && s.slot !== opts.kitBox && (s.boxUsed ?? 0) < BOX_SLOTS && (!!s.named || (s.boxUsed ?? 0) === 0 || own(s)));
      // a bot_loot box first, then one this chore filled before, then an empty one
      const rank = (s: RoomSlot): number => (s.named ? 0 : own(s) ? 1 : 2);
      const box = boxes.sort((a, b) => rank(a) - rank(b) || (a.boxUsed ?? 0) - (b.boxUsed ?? 0) || a.slot - b.slot)[0];
      if (opts.boxing === false) short.push('stashShulker is off (no box placed for loot)');
      else if (!box) short.push('no carried box with room for the loot (a bot_loot box or an empty one)');
      else {
        const room = BOX_SLOTS - (box.boxUsed ?? 0);
        const moves = loot.slice(0, room).map((s) => ({ slot: s.slot, count: s.count, name: s.name }));
        plan.steps.push({ kind: 'box', box: box.slot, moves });
        for (const m of moves) inv.delete(m.slot);
      }
    } else short.push('nothing loose to put away (gear, food, reserves and the flight kit stay)');
  }

  // 5. compact redstone, lapis and emeralds when it frees a slot (a crafting table near)
  if (need() && opts.table && !opts.home && !skip.has('compact')) {
    for (const [item, block] of Object.entries(ROOM_COMPACT)) {
      if (!need()) break;
      const mine = [...inv.values()].filter((s) => s.name === item);
      const have = mine.reduce((a, s) => a + s.count, 0);
      const blocks = Math.floor(have / 9);
      if (blocks <= 0) continue;
      const blockSlots = [...inv.values()].filter((s) => s.name === block);
      const blocksHad = blockSlots.reduce((a, s) => a + s.count, 0);
      const rest = have - blocks * 9;
      const frees = mine.length + blockSlots.length - Math.ceil(rest / maxOf(item)) - Math.ceil((blocksHad + blocks) / maxOf(block));
      if (frees < 1) continue;
      plan.steps.push({ kind: 'compact', item, block, count: blocks * 9, frees });
      // the simulation: `frees` of the kind's slots go
      for (const s of mine.slice(0, frees)) inv.delete(s.slot);
    }
  }

  // 6. stone-like blocks beyond `dropStone` of each kind (the owner turned it on)
  const stoneKeep = opts.stoneKeep ?? 0;
  if (need() && !opts.home && !skip.has('stone')) {
    if (stoneKeep > 0) {
      const kinds = STONE_LIKE.filter((name) => !opts.protect?.has(name)).map((name) => {
        const mine = [...inv.values()].filter((s) => s.name === name);
        const have = mine.reduce((a, s) => a + s.count, 0);
        const after = Math.ceil(Math.min(have, stoneKeep) / maxOf(name));
        return { name, mine, have, frees: mine.length - after };
      }).filter((k) => k.have > stoneKeep && k.frees > 0);
      for (const k of kinds.sort((a, b) => b.frees - a.frees || a.name.localeCompare(b.name))) {
        if (!need()) break;
        plan.steps.push({ kind: 'stone', name: k.name, count: k.have - stoneKeep, keep: stoneKeep, slots: k.frees });
        // the keeper drops the main inventory's smallest stacks first
        for (const s of [...k.mine].sort((a, b) => Number(a.slot < 9) - Number(b.slot < 9) || a.count - b.count).slice(0, k.frees)) inv.delete(s.slot);
      }
    } else if ([...inv.values()].some((s) => STONE_LIKE.includes(s.name) && s.count >= maxOf(s.name))) short.push('stone-like blocks kept (dropStone 0)');
  }

  plan.after = free();
  if (free() < floor) plan.short = short.length ? short : ['nothing more to free without losing something'];
  return plan;
}

/**
 * The slots the box step may take: whole slots the unload would put away (its plan with no chest: overflow), not
 * shulker boxes, not the keeper's junk (dropped instead), not what a skill takes loose; the main inventory first.
 */
function lootSlots(slots: readonly RoomSlot[], inv: ReadonlyMap<number, Sim>, opts: RoomOptions, junk: ReadonlySet<string>): Sim[] {
  const live = slots.filter((s) => inv.has(s.slot));
  const p = planUnload(live, [], {
    keepBox: true,
    boxing: false,
    filling: false,
    ...(opts.reserve !== undefined ? { reserve: opts.reserve } : {}),
    ...(opts.foodReserve !== undefined ? { foodReserve: opts.foodReserve } : {}),
    ...(opts.seedReserve !== undefined ? { seedReserve: opts.seedReserve } : {}),
    ...(opts.worn ? { worn: opts.worn } : {}),
  });
  const out: Sim[] = [];
  for (const o of p.overflow) {
    const s = inv.get(o.slot);
    if (!s || isShulkerBox(s.name) || o.count !== s.count || junk.has(s.name) || KEEP_LOOSE.has(s.name)) continue;
    out.push(s);
  }
  // things of value before filler (a box with little room takes the ores, not the cobblestone), the main inventory first
  const filler = (n: string): number => Number(STONE_LIKE.includes(n));
  return out.sort((a, b) => filler(a.name) - filler(b.name) || Number(a.slot < 9) - Number(b.slot < 9) || b.slot - a.slot);
}

/** `merged 7 cooked_beef (slot 30 -> 2)`, `boxed 19 bone, 17 redstone`, ... for the log and the reply. */
export function stepLine(s: RoomStep): string {
  switch (s.kind) {
    case 'merge':
      return `merged ${s.count} ${s.name} (slot ${s.from} -> ${s.to})`;
    case 'junk':
      return `dropped ${s.count} ${s.name} (junk)`;
    case 'rockets':
      return `${s.count} ${ROCKET} into the fireworks box (${s.moves.length} stack${s.moves.length === 1 ? '' : 's'})`;
    case 'box':
      return `boxed ${countsLine(s.moves)} into the shulker box in slot ${s.box}`;
    case 'compact':
      return `compacted ${s.count} ${s.item} into ${s.count / 9} ${s.block}`;
    case 'stone':
      return `dropped ${s.count} ${s.name} (dropStone ${s.keep})`;
  }
}

/**
 * The one line that asks the owner for room (a plan short of the floor with no step left), or undefined. The bot does
 * not craft and place a chest of its own (ADR 0090: it cannot tell a build from open ground): it asks.
 */
export function roomAskLine(plan: RoomPlan, ctx: { home: boolean; chests: boolean; radius: number; atHome?: boolean }): string | undefined {
  if (plan.steps.length > 0 || plan.after >= ROOM_FLOOR) return undefined;
  const why = plan.short ?? [];
  const parts = [`inventory: ${plan.after} slot${plan.after === 1 ? '' : 's'} free and nothing I may drop or box`];
  if (!ctx.home) parts.push('a home with a chest (!home set, a chest within reach of it) would let me unload');
  else if (!ctx.chests) parts.push(`I know no chest at home: a chest within ${ctx.radius} blocks of it (then !chests scan) would let me unload`);
  else if (ctx.atHome) parts.push('the chests at home take none of what is left (!unload says what stays)');
  else parts.push('I unload when I am home (!unload there)');
  if (why.some((w) => w.startsWith('stone-like'))) parts.push('or !set dropStone 64 to keep 64 of each stone kind');
  else if (why.some((w) => w.startsWith('no carried box'))) parts.push('or give me an empty shulker box');
  return parts.join('; ');
}

/** `19 bone, 17 redstone` (counts by name, in order). */
export function countsLine(moves: readonly { name: string; count: number }[]): string {
  const m = new Map<string, number>();
  for (const x of moves) m.set(x.name, (m.get(x.name) ?? 0) + x.count);
  return [...m].map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing';
}

/** The inventory model as `roomSlotsOf` reads it (world/inventory.ts satisfies it). */
export interface RoomInventory {
  readonly slots: readonly ({ name: string; count: number; metadata?: number } | null)[];
  rawItem?(window: number, slot: number): unknown;
}

/**
 * The inventory as the room plan sees it: every slot 0..35 holding something, with its merge key, and for shulker boxes
 * what the unloader marks (slots used, contents, the fireworks box, a bot_loot box, a box whose wire item is unknown) and
 * `owed` for a box owed to a chest (HomeLogistics.owedSlots).
 */
export function roomSlotsOf(inv: RoomInventory, opts: { keepName?: string; owed?: ReadonlySet<number> } = {}): RoomSlot[] {
  const out: RoomSlot[] = [];
  inv.slots.slice(0, 36).forEach((s, i) => {
    if (!s || s.count <= 0) return;
    const raw = inv.rawItem?.(0, i);
    const box = isShulkerBox(s.name);
    const used = box ? shulkerSlotsUsed(raw) : 0;
    const key = box ? undefined : stackKey(s.name, s.metadata ?? 0, raw);
    out.push({
      slot: i,
      name: bare(s.name),
      count: s.count,
      ...(key !== undefined ? { key } : {}),
      ...(box ? { boxUsed: used } : {}),
      ...(box && used > 0 ? { boxItems: shulkerContents(raw) } : {}),
      ...(isFireworksBox(s.name, raw) ? { flightKit: true } : {}),
      ...(isKeptBox(s.name, raw, opts.keepName) ? { named: true } : {}),
      ...(box && raw === undefined ? { unknown: true } : {}),
      ...(opts.owed?.has(i) ? { owed: true } : {}),
    });
  });
  return out;
}

/** What a box holds, as one string (`bone:19,redstone:17`): how the chore knows a box it filled. */
export function boxPrint(items: Readonly<Record<string, number>> | undefined): string {
  return Object.entries(items ?? {})
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}:${v}`)
    .join(',');
}

/** BigInt-safe JSON (the wire NBT holds longs). */
function json(v: unknown): string {
  return JSON.stringify(v ?? null, (_k, x: unknown) => (typeof x === 'bigint' ? `${x}n` : x));
}

/**
 * The merge key of a stack: its name, metadata and the wire item's NBT (a crafted rocket's flight, an enchantment, a
 * custom name: stacks that differ there never stack on the server). Undefined without a wire item.
 */
export function stackKey(name: string, metadata: number, raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const extra = (raw as { extra?: { has_nbt?: unknown; nbt?: unknown } }).extra;
  return `${bare(name)}|${metadata}|${extra?.has_nbt ? json(extra.nbt) : '-'}`;
}
