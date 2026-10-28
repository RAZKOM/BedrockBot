// Track AG (wave 9, docs/home.md "Decision table"): where each carried stack goes when the bot unloads
// at home. Pure: the inventory and the chest memory in, a list of (slot, count, chest) moves out; the
// home logistics (logistics.ts) walks, opens and deposits, then plans again with what it saw.
//
// Per stack, the first rule that has a chest with room wins (and a stack may be split over chests):
//   1. same     a chest that already holds this item (the one holding most of it first)
//   2. label    a chest whose label names the item's category (ores, wood, food, blocks, junk, tools) or the item
//   3. emptiest the unlabelled chest with the most free slots
// A chest with no free slot and no partial stack of the item is skipped. What fits nowhere is overflow:
// the logistics then fills an empty shulker box from the box chest with it.
//
// Never unloaded: food, armour, tools and weapons (anything with durability), totems, ender chests
// (`keepOnDropItems`, the same list `!drop items` keeps), the throwaway reserve (16 blocks of
// cobblestone / dirt / cobbled deepslate / netherrack in all, cobblestone first) and one empty shulker
// box (the stash step's). Further empty boxes go to the box chest (the chest holding the most boxes);
// full boxes (NBT `Items` not empty) go there too, or with `all` are listed for emptying.
//
// Track AV (docs/home.md "Boxing at the chests"): boxes named `keepBoxName` (bot_loot) are kept and, when
// they hold items, listed for emptying (`emptyNamed`); with a named box carried no unnamed box is held back
// for the stash step. Rule 1 also counts what a chest's full boxes hold. When the chests holding an item
// cannot take what the bot carries of it and a spare empty box is known (carried, or in a chest), the plan
// starts with `box` steps: take up to 27 loose stacks of that item out of its chest, fill a spare box with
// them (topped up with the bot's own stacks), put the box back into that chest; the kinds with a home claim
// their room before the label / emptiest rules. Track AW's compaction (`compact`, crafting into blocks) is
// filled by its `compactPlanner` at the end and run by its `compactRunner` (logistics.ts doUnload).
import { keepOnDropItems } from '../../chat/commands-survival.ts';
import { DEFAULT_THROWAWAY_MIN, THROWAWAY_BLOCKS } from '../survival/keeper.ts';
import { isShulkerBox, maxStackOf } from '../container/chest.ts';
import type { Vec3 } from '../../world/types.ts';
import { labelMatches } from './categories.ts';
import { BOX_SLOTS, MAX_BOX_STEPS } from './boxing.ts'; // Track AV

/** One inventory slot as the planner sees it. */
export interface UnloadSlot {
  slot: number;
  name: string;
  count: number;
  /** Shulker boxes: slots used inside (NBT `Items`), 0 = empty. */
  boxUsed?: number;
  /** Track AU: the flight kit's fireworks box (never unloaded, never the box chest's). */
  flightKit?: boolean;
  /** Track AV: a box named `keepBoxName` (bot_loot): kept, emptied when it holds items. */
  named?: boolean;
  /** Track AV: a box whose wire item is unknown (name, contents): kept, never a spare, never stored. */
  unknown?: boolean;
}

/** A target container as the planner sees it (from the chest memory). */
export interface PlanChest {
  key: string;
  pos: Vec3;
  kind: string;
  label?: string | undefined;
  free: number;
  contents: Readonly<Record<string, number>>;
  room: Readonly<Record<string, number>>;
  boxes: { empty: number; full: number };
  /** Track AV: what the full boxes inside hold (rule 1 counts it; ChestRecord.inBoxes). */
  inBoxes?: Readonly<Record<string, number>> | undefined;
}

export type Rule = 'same' | 'label' | 'emptiest' | 'boxes';

export interface UnloadMove {
  slot: number;
  name: string;
  count: number;
  /** PlanChest.key */
  to: string;
  rule: Rule;
}

export type KeepReason = 'kept' | 'reserve' | 'stash_box' | 'flight_kit' | 'named_box' | 'unknown_box'; // Track AU: flight_kit; Track AV: named_box

/**
 * Track AV: a step that makes room before the deposits.
 *   box      take `stacks` loose stacks of `item` out of chest `chest`, fill a spare box with them and
 *            `produce` stacks the bot carries, put the full box into `chest`; `spare`: `carried` or the
 *            key of the chest the empty box comes from
 */
export interface UnloadStep {
  kind: 'box';
  item: string;
  chest: string;
  stacks: number;
  produce: number;
  spare: string;
}

export interface UnloadPlan {
  moves: UnloadMove[];
  /** What stays in the inventory on purpose, by name. */
  kept: { name: string; count: number; why: KeepReason }[];
  /** Unloadable items no chest has room for. */
  overflow: { slot: number; name: string; count: number }[];
  /** `all`: slots of full shulker boxes to empty into the chests. */
  fullBoxes: number[];
  /** The chest that holds the most shulker boxes (where boxes go and come from), if any. */
  boxChest: string | undefined;
  /** Track AV: slots of named (bot_loot) boxes holding items: emptied into the inventory, kept. */
  emptyNamed: number[];
  /** Track AV: steps before the deposits (box), in order. */
  steps: UnloadStep[];
  /** Track AV: kinds whose chest is full and could not be boxed: `no_spare` (no empty box known), `boxes_full` (the chest holds no loose stack of it and no free slot for a box). */
  blocked: { item: string; chest: string; why: 'no_spare' | 'boxes_full' }[];
  /** Track AW: kinds to compact 9 -> 1 into blocks (skills/craft/compact.ts) before the moves, when their chest fills up or overflows; `count` = items. */
  compact?: { kind: string; count: number }[];
}

/** Track AW: fills `UnloadPlan.compact` (installed by skills/craft/compact.ts `installCompactPlanner`); undefined = no compaction step. */
export let compactPlanner: ((slots: readonly UnloadSlot[], plan: UnloadPlan, chests: readonly PlanChest[]) => { kind: string; count: number }[]) | undefined;
export function setCompactPlanner(fn: typeof compactPlanner): void {
  compactPlanner = fn;
}
/**
 * Track AW: runs the plan's `compact` steps (crafts the blocks; installed by chat/commands-craft.ts, reset when the task
 * stops). The unload job (logistics.ts doUnload, under its serial lock) calls it before the moves when installed and gets
 * the reply fragment back (`compacted 27 raw_iron into 3 raw_iron_block`), or undefined when nothing was compacted.
 */
export let compactRunner: ((steps: readonly { kind: string; count: number }[], cancelled: () => boolean) => Promise<string | undefined>) | undefined;
export function setCompactRunner(fn: typeof compactRunner): void {
  compactRunner = fn;
}

export interface PlanOptions {
  /** `!unload all`: full shulker boxes are emptied instead of stored. */
  all?: boolean;
  /** Throwaway blocks kept in all. Default 16 (DEFAULT_THROWAWAY_MIN). */
  reserve?: number;
  throwaway?: readonly string[];
  /** Keep one empty shulker box for the stash step. Default true. */
  keepBox?: boolean;
  /** Tie-break between equal chests: nearer to this point first. */
  origin?: Vec3;
  maxStack?: (name: string) => number;
  /** Track AV: plan `box` steps (default true). */
  boxing?: boolean;
  /** Track AV: box steps at most (default MAX_BOX_STEPS). */
  maxBoxSteps?: number;
  /** Track AV: item kinds not to box (a box step for them failed in this run). */
  noBox?: ReadonlySet<string>;
}

interface SimChest {
  c: PlanChest;
  free: number;
  room: Record<string, number>;
  contents: Record<string, number>;
  boxes: number;
  /** Track AV */
  inBoxes: Record<string, number>;
  empties: number;
}

/** Why an item is never unloaded (`keepOnDropItems`), without the shulker boxes (handled apart). */
export function keptItem(name: string): boolean {
  return !isShulkerBox(name) && keepOnDropItems(name);
}

/** Throwaway reserve per kind: `reserve` in all, the kinds in THROWAWAY_BLOCKS order (cobblestone first). */
export function reserveByKind(slots: readonly UnloadSlot[], reserve = DEFAULT_THROWAWAY_MIN, kinds: readonly string[] = THROWAWAY_BLOCKS): Map<string, number> {
  const out = new Map<string, number>();
  let left = reserve;
  for (const k of kinds) {
    if (left <= 0) break;
    const have = slots.filter((s) => s.name === k).reduce((a, s) => a + s.count, 0);
    const r = Math.min(have, left);
    if (r > 0) out.set(k, r);
    left -= r;
  }
  return out;
}

function capacity(s: SimChest, name: string, max: number): number {
  return (s.room[name] ?? 0) + s.free * max;
}

function put(s: SimChest, name: string, n: number, max: number): void {
  const fromRoom = Math.min(s.room[name] ?? 0, n);
  if (fromRoom > 0) s.room[name] = (s.room[name] ?? 0) - fromRoom;
  const rest = n - fromRoom;
  if (rest > 0) {
    const slots = Math.ceil(rest / max);
    s.free -= slots;
    s.room[name] = (s.room[name] ?? 0) + slots * max - rest;
  }
  s.contents[name] = (s.contents[name] ?? 0) + n;
}

const dist = (c: PlanChest, o: Vec3 | undefined): number => (o ? Math.hypot(c.pos.x + 0.5 - o.x, c.pos.y + 0.5 - o.y, c.pos.z + 0.5 - o.z) : 0);

/** Pick the target for `name` by the rules; undefined when no chest has room. */
function pick(sims: readonly SimChest[], name: string, max: number, origin: Vec3 | undefined, boxUsed?: number): { s: SimChest; rule: Rule } | undefined {
  const box = isShulkerBox(name);
  const open = sims.filter((s) => capacity(s, name, max) > 0 && !(box && isShulkerBox(s.c.kind)));
  const near = (a: SimChest, b: SimChest) => dist(a.c, origin) - dist(b.c, origin);
  if (box) {
    // a box goes with boxes of the same state: empty boxes to the chest holding empty boxes, full ones to the chest holding
    // full ones (the owner: a chest of empty shulkers is not a chest of sand-filled shulkers, even when the box colours match)
    const full = (boxUsed ?? 0) > 0;
    const alike = open.filter((s) => (full ? s.c.boxes.full : s.c.boxes.empty) > 0).sort((a, b) => (full ? b.c.boxes.full - a.c.boxes.full : b.c.boxes.empty - a.c.boxes.empty) || near(a, b));
    if (alike[0]) return { s: alike[0], rule: 'boxes' };
  }
  const held = (s: SimChest) => (s.contents[name] ?? 0) + (s.inBoxes[name] ?? 0); // Track AV: the boxes' contents count
  const same = open.filter((s) => held(s) > 0).sort((a, b) => held(b) - held(a) || near(a, b));
  if (same[0]) return { s: same[0], rule: 'same' };
  const label = open.filter((s) => labelMatches(s.c.label, name)).sort((a, b) => b.free - a.free || near(a, b));
  if (label[0]) return { s: label[0], rule: 'label' };
  const empty = open.filter((s) => !s.c.label).sort((a, b) => b.free - a.free || near(a, b));
  if (empty[0]) return { s: empty[0], rule: 'emptiest' };
  return undefined;
}

/** The plan for one unload (see the file comment). */
export function planUnload(slots: readonly UnloadSlot[], chests: readonly PlanChest[], opts: PlanOptions = {}): UnloadPlan {
  const maxOf = opts.maxStack ?? maxStackOf;
  const sims: SimChest[] = chests.map((c) => ({ c, free: c.free, room: { ...c.room }, contents: { ...c.contents }, boxes: c.boxes.empty + c.boxes.full, inBoxes: { ...(c.inBoxes ?? {}) }, empties: c.boxes.empty }));
  const plan: UnloadPlan = { moves: [], kept: [], overflow: [], fullBoxes: [], boxChest: undefined, emptyNamed: [], steps: [], blocked: [] };
  const keep = (name: string, count: number, why: KeepReason) => {
    const k = plan.kept.find((x) => x.name === name && x.why === why);
    if (k) k.count += count;
    else plan.kept.push({ name, count, why });
  };
  const move = (slot: number, name: string, count: number, to: string, rule: Rule) => {
    const m = plan.moves.find((x) => x.slot === slot && x.to === to && x.name === name);
    if (m) m.count += count;
    else plan.moves.push({ slot, name, count, to, rule });
  };
  // the box chest: most shulker boxes inside (a box placed as a block is never one)
  const boxSims = sims.filter((s) => s.boxes > 0 && !isShulkerBox(s.c.kind)).sort((a, b) => b.boxes - a.boxes || dist(a.c, opts.origin) - dist(b.c, opts.origin));
  plan.boxChest = boxSims[0]?.c.key;
  const toBoxChest = (slot: number, name: string): void => {
    const target = [...boxSims, ...sims.filter((s) => !isShulkerBox(s.c.kind) && !boxSims.includes(s)).sort((a, b) => b.free - a.free || dist(a.c, opts.origin) - dist(b.c, opts.origin))].find((s) => s.free > 0);
    if (!target) {
      plan.overflow.push({ slot, name, count: 1 });
      return;
    }
    target.free--;
    target.boxes++;
    target.contents[name] = (target.contents[name] ?? 0) + 1;
    move(slot, name, 1, target.c.key, 'boxes');
  };

  const reserve = reserveByKind(slots, opts.reserve ?? DEFAULT_THROWAWAY_MIN, opts.throwaway ?? THROWAWAY_BLOCKS);
  // hold the reserve back from the last slots of each kind
  const movable = new Map<number, number>();
  for (const s of slots) movable.set(s.slot, s.count);
  for (const [kind, r] of reserve) {
    let hold = r;
    for (const s of [...slots].filter((x) => x.name === kind).sort((a, b) => b.slot - a.slot)) {
      if (hold <= 0) break;
      const h = Math.min(hold, s.count);
      movable.set(s.slot, s.count - h);
      hold -= h;
    }
    keep(kind, r, 'reserve');
  }

  // Track AV: a named box carried serves the stash step: no unnamed box is held back for it
  let boxKept = !(opts.keepBox ?? true) || slots.some((s) => s.named && !s.flightKit && s.count > 0);
  const spareSlots = slots.filter((s) => isShulkerBox(s.name) && !s.named && !s.flightKit && !s.unknown && (s.boxUsed ?? 0) === 0 && s.count > 0).sort((a, b) => a.slot - b.slot);
  const carriedSpares = (boxKept ? spareSlots : spareSlots.slice(1)).map((s) => s.slot);
  const usedSpares = new Set<number>();
  if (opts.boxing ?? true) planBoxSteps(slots, sims, movable, carriedSpares, usedSpares, plan, opts, maxOf);
  // Track AV: kinds with a home (rule 1) claim their room first
  const home = (name: string) => sims.some((x) => (x.contents[name] ?? 0) + (x.inBoxes[name] ?? 0) > 0);
  for (const s of [...slots].sort((a, b) => Number(!home(a.name)) - Number(!home(b.name)) || a.slot - b.slot)) {
    if (s.count <= 0) continue;
    if (s.flightKit) {
      keep(s.name, s.count, 'flight_kit'); // Track AU: the fireworks box stays with the bot
      continue;
    }
    if (s.unknown && isShulkerBox(s.name)) {
      keep(s.name, 1, 'unknown_box'); // Track AV: name and contents unknown: it stays
      continue;
    }
    if (s.named && isShulkerBox(s.name)) {
      keep(s.name, 1, 'named_box'); // Track AV: the bot's own box stays; its items are unloaded after emptying it
      if ((s.boxUsed ?? 0) > 0) plan.emptyNamed.push(s.slot);
      continue;
    }
    if (usedSpares.has(s.slot)) continue; // Track AV: a spare a box step fills
    if (isShulkerBox(s.name)) {
      if ((s.boxUsed ?? 0) > 0) {
        if (opts.all) plan.fullBoxes.push(s.slot);
        else toBoxChest(s.slot, s.name);
        continue;
      }
      if (!boxKept) {
        boxKept = true;
        keep(s.name, 1, 'stash_box');
        continue;
      }
      toBoxChest(s.slot, s.name);
      continue;
    }
    if (keptItem(s.name)) {
      keep(s.name, s.count, 'kept');
      continue;
    }
    let left = movable.get(s.slot) ?? s.count;
    const max = maxOf(s.name);
    while (left > 0) {
      const t = pick(sims, s.name, max, opts.origin, s.boxUsed);
      if (!t) {
        plan.overflow.push({ slot: s.slot, name: s.name, count: left });
        break;
      }
      const n = Math.min(left, capacity(t.s, s.name, max));
      put(t.s, s.name, n, max);
      move(s.slot, s.name, n, t.s.c.key, t.rule);
      left -= n;
    }
  }
  const compact = compactPlanner?.(slots, plan, chests); // Track AW: the compaction step
  if (compact?.length) plan.compact = compact;
  return plan;
}

/** Stacks of unloadable items carried (the autoUnload trigger counts these) and full shulker boxes. */
export function unloadableStacks(slots: readonly UnloadSlot[], opts: Pick<PlanOptions, 'reserve' | 'throwaway'> = {}): { stacks: number; fullBoxes: number } {
  const plan = planUnload(slots, [], { ...opts, keepBox: true, boxing: false });
  const stacks = new Set(plan.overflow.filter((o) => !isShulkerBox(o.name)).map((o) => o.slot)).size;
  const fullBoxes = slots.filter((s) => isShulkerBox(s.name) && (s.boxUsed ?? 0) > 0 && !s.flightKit).length; // Track AV: not the fireworks box
  return { stacks, fullBoxes };
}

/** Track AV: the slots a box takes when `items` are split into stacks of `max`. */
const stacksOf = (items: number, max: number): number => Math.ceil(items / max);

/**
 * Track AV: the `box` steps (see the file comment). Per item kind with a home (a chest holding it, loose or
 * boxed) whose chests cannot take what the bot carries: while they cannot and a spare is known, one box of
 * up to 27 stacks: the target chest's loose stacks first (27 slots freed for 1), topped up with the bot's
 * own. The simulation moves the stacks into the box (the chest gains the freed slots, the bot's slots lose
 * the boxed items), so the moves after it go to the chest.
 */
function planBoxSteps(slots: readonly UnloadSlot[], sims: SimChest[], movable: Map<number, number>, carriedSpares: number[], usedSpares: Set<number>, plan: UnloadPlan, opts: PlanOptions, maxOf: (name: string) => number): void {
  const maxSteps = opts.maxBoxSteps ?? MAX_BOX_STEPS;
  const kinds: string[] = [];
  for (const s of [...slots].sort((a, b) => a.slot - b.slot)) if (!kinds.includes(s.name) && !isShulkerBox(s.name) && !s.flightKit && !keptItem(s.name)) kinds.push(s.name);
  const spareChests = sims.filter((x) => x.empties > 0 && !isShulkerBox(x.c.kind));
  for (const name of kinds) {
    const max = maxOf(name);
    if (max <= 1 || opts.noBox?.has(name)) continue; // unstackable items gain nothing from a box
    const carried = (): number => slots.filter((s) => s.name === name).reduce((a, s) => a + (movable.get(s.slot) ?? s.count), 0);
    const same = (): SimChest[] => sims.filter((x) => !isShulkerBox(x.c.kind) && (x.contents[name] ?? 0) + (x.inBoxes[name] ?? 0) > 0);
    const fits = (): number => same().reduce((a, x) => a + capacity(x, name, max), 0);
    if (same().length === 0 || carried() <= fits()) continue;
    // the chest that holds most of it (loose first: those are the stacks a box frees)
    const target = same().sort((a, b) => (b.contents[name] ?? 0) - (a.contents[name] ?? 0) || (b.inBoxes[name] ?? 0) - (a.inBoxes[name] ?? 0) || dist(a.c, opts.origin) - dist(b.c, opts.origin))[0]!;
    while (carried() > fits()) {
      if (plan.steps.length >= maxSteps) break;
      const loose = target.contents[name] ?? 0;
      const looseSlots = loose > 0 ? Math.max(1, Math.round((loose + (target.room[name] ?? 0)) / max)) : 0;
      const t = Math.min(looseSlots, BOX_SLOTS);
      const p = Math.min(BOX_SLOTS - t, stacksOf(carried(), max));
      if (t + p < 2 || target.free + t < 1) {
        plan.blocked.push({ item: name, chest: target.c.key, why: 'boxes_full' });
        break;
      }
      let spare: string | undefined;
      const mine = carriedSpares.find((x) => !usedSpares.has(x));
      if (mine !== undefined) {
        usedSpares.add(mine);
        spare = 'carried';
      } else {
        const from = spareChests.filter((x) => x.empties > 0).sort((a, b) => Number(b === target) - Number(a === target) || dist(a.c, target.c.pos) - dist(b.c, target.c.pos))[0];
        if (from) {
          from.empties--;
          from.boxes--;
          from.free++;
          spare = from.c.key;
        }
      }
      if (!spare) {
        plan.blocked.push({ item: name, chest: target.c.key, why: 'no_spare' });
        break;
      }
      plan.steps.push({ kind: 'box', item: name, chest: target.c.key, stacks: t, produce: p, spare });
      // the chest: t loose stacks out (full ones first), one box in
      const taken = t >= looseSlots ? loose : Math.min(loose, t * max);
      target.contents[name] = loose - taken;
      if (target.contents[name] === 0) {
        delete target.contents[name];
        delete target.room[name];
      }
      const produced = Math.min(carried(), p * max);
      target.free += t - 1;
      target.boxes++;
      target.inBoxes[name] = (target.inBoxes[name] ?? 0) + taken + produced;
      // the bot: `produced` items into the box, from the last slots of the kind
      let left = produced;
      for (const s of [...slots].filter((x) => x.name === name).sort((a, b) => b.slot - a.slot)) {
        if (left <= 0) break;
        const m = movable.get(s.slot) ?? s.count;
        const n = Math.min(m, left);
        movable.set(s.slot, m - n);
        left -= n;
      }
    }
  }
}
