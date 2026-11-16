// Track T3 (docs/inventory.md "Test presets on a server with cheats"): `!test inv <preset>` and `!test inv restore`.
// The bot saves what it carries, clears the slots a command can give back exactly, fills them with a preset by
// /replaceitem, and later puts the saved inventory back. Everything a command cannot give back stays in its slot the whole
// time and is never cleared or overwritten.
//
// What Bedrock's commands carry (measured on BDS 1.26.60, bds-home, 2026-11-16; docs/inventory.md has the table):
//   /replaceitem entity @s <slot> [keep|destroy] <item> [count] [data] [components]
//     - name, count (at most the item's stack size: `commands.generic.num.tooBig`), data: the metadata of a potion and
//       the durability used up of a tool, armour or elytra (`Damage` in the item's NBT); `keep` fails on a taken slot
//       (`commands.replaceitem.failed`), `air` empties a slot
//     - components: only keep_on_death, item_lock, can_place_on, can_destroy
//     - a firework rocket comes with Flight 1 and no explosions (a crafted rocket of duration 2 or 3 cannot be made)
//     - a shulker box comes empty and unnamed
//   no command sets enchantments on a slot (/enchant works on the held item only, up to the enchantment's own level),
//   a custom name, a box's contents or any other NBT.
//   /clear @s <item> -1 0 counts without clearing (`commands.clear.testing` [player, n]); a name the server does not
//   know is `commands.generic.syntax`, one not carried `commands.clear.failure.no.items`.
//
// So a slot is restorable when its item has no NBT (or a plain Flight 1 rocket's) and is not gear, an elytra or a box:
// those are kept in place even when plain (the owner's tools stay where the hotbar puller put them). The rest of the
// slots (empty or restorable) are the preset's.
import type { ItemStack } from '../../world/types.ts';
import { itemDisplayName, itemEnchants } from '../../world/inventory.ts';
import { wireSize } from '../../chat/style.ts';
import { silentLogger, type Logger } from '../../log.ts';
import { isShulkerBox, shulkerContents } from '../container/chest.ts';
import { maxDurability } from '../survival/tools.ts';
import { foodInfo } from '../survival/eat.ts';
import { resultText, type CommandResult } from './command.ts';
import { inventorySlotName, WORN_SLOTS, type WornSlot } from './kit.ts';

export type InvPreset = 'full' | 'early' | 'split' | 'rockets' | 'fullbar';
export const INV_PRESETS: readonly InvPreset[] = ['full', 'early', 'split', 'rockets', 'fullbar'];
export const INV_SAVE_FILE = 'inv-saved.json';
/** A reply is cut to this many bytes (a Doc message is 440; the prefix and colour codes need the rest). */
export const INV_LINE_MAX = 400;

const ITEM_RE = /^[a-z][a-z0-9_]{0,63}$/;

// ---- what a slot is ------------------------------------------------------------------------------------------------

/** The parts of the inventory model read here (world/inventory.ts Inventory). */
export interface InvSource {
  readonly slots: readonly (ItemStack | null)[];
  rawItem?(window: number, slot: number): unknown;
  window?(id: number): { readonly slots: readonly (ItemStack | null)[] } | undefined;
}

type Nbt = Record<string, { type?: string; value?: unknown }>;
const nbtOf = (raw: unknown): Nbt | undefined => {
  const e = (raw as { extra?: { has_nbt?: unknown; nbt?: { nbt?: { value?: unknown } } } } | undefined)?.extra;
  if (!e?.has_nbt) return undefined;
  const v = e.nbt?.nbt?.value;
  return v && typeof v === 'object' ? (v as Nbt) : {};
};

/** A plain rocket's NBT (what /give and /replaceitem make): Fireworks {Flight 1, no explosions}. Else its flight, or 0 for explosions. */
function rocketFlight(n: Nbt): number | undefined {
  const keys = Object.keys(n);
  if (keys.length !== 1 || keys[0] !== 'Fireworks') return undefined;
  const fw = n.Fireworks?.value as Nbt | undefined;
  if (!fw || typeof fw !== 'object' || Object.keys(fw).some((k) => k !== 'Flight' && k !== 'Explosions')) return undefined;
  const ex = (fw.Explosions?.value as { value?: unknown } | undefined)?.value;
  if (Array.isArray(ex) && ex.length > 0) return 0;
  const f = fw.Flight?.value;
  return typeof f === 'number' ? f : 1;
}

/**
 * Why a slot stays in place (no command gives it back exactly, or it is gear, an elytra or a box), undefined when a
 * /replaceitem gives the same item back. A slot whose wire item was not read stays too.
 */
export function keptReason(s: Pick<ItemStack, 'name'>, raw: unknown): string | undefined {
  if (isShulkerBox(s.name)) {
    const label = itemDisplayName(raw);
    return label !== undefined ? `box "${label}"` : 'box';
  }
  if (s.name === 'elytra') return 'elytra';
  if (maxDurability(s.name) !== undefined) return itemEnchants(raw) ? 'enchanted' : itemDisplayName(raw) !== undefined ? 'named' : 'gear';
  if (!ITEM_RE.test(s.name)) return 'unknown item';
  if (raw === undefined || raw === null) return 'not read';
  const n = nbtOf(raw);
  if (n === undefined || Object.keys(n).length === 0) return undefined;
  if (itemEnchants(raw)) return 'enchanted';
  if (itemDisplayName(raw) !== undefined) return 'named';
  if (s.name === 'firework_rocket') {
    const f = rocketFlight(n);
    if (f === 1) return undefined;
    if (f !== undefined) return f === 0 ? 'rocket with explosions' : `rocket flight ${f}`;
  }
  return `nbt ${Object.keys(n).join(' ')}`;
}

/** A kept item's identity: name, metadata and its NBT without `Damage` (an elytra flown or a tool used is still itself). */
export function keptKey(name: string, metadata: number, raw: unknown): string {
  // a new tool has no NBT at all; after its first use it has {Damage}: both are the same item
  const { Damage: _wear, ...rest } = nbtOf(raw) ?? {};
  return `${name}|${metadata}|${Object.keys(rest).length ? JSON.stringify(rest) : '-'}`;
}

export interface SavedSlot {
  slot: number;
  name: string;
  count: number;
  metadata: number;
  /** Why it stays in place; undefined: cleared by a preset and given back by /replaceitem. */
  kept?: string;
  /** name|metadata|NBT without the wear (keptKey): finds a kept item again. */
  key: string;
  /** A box's contents. */
  boxed?: Record<string, number>;
  /** The durability used up (NBT `Damage`), when it has one. */
  wear?: number;
}

export interface InvSnapshot {
  version: 1;
  at: string;
  preset?: InvPreset;
  slots: (SavedSlot | null)[];
  worn: Record<WornSlot, string | null>;
}

const live = (s: ItemStack | null | undefined): s is ItemStack => !!s && s.count > 0;
const rawAt = (src: InvSource, i: number): unknown => src.rawItem?.(0, i);

export function savedSlot(src: InvSource, i: number): SavedSlot | null {
  const s = src.slots[i];
  if (!live(s)) return null;
  const raw = rawAt(src, i);
  const kept = keptReason(s, raw);
  const out: SavedSlot = { slot: i, name: s.name, count: s.count, metadata: s.metadata ?? 0, key: keptKey(s.name, s.metadata ?? 0, raw) };
  if (kept !== undefined) out.kept = kept;
  const wear = wearOf(raw);
  if (wear !== undefined) out.wear = wear;
  if (isShulkerBox(s.name)) out.boxed = shulkerContents(raw);
  return out;
}

export function wornOf(src: InvSource): Record<WornSlot, string | null> {
  const armor = src.window?.(120)?.slots ?? [];
  const off = src.window?.(119)?.slots ?? [];
  const n = (s: ItemStack | null | undefined): string | null => (live(s) ? s.name : null);
  return { head: n(armor[0]), chest: n(armor[1]), legs: n(armor[2]), feet: n(armor[3]), offhand: n(off[0]) };
}

export function snapshotInv(src: InvSource, at: Date = new Date()): InvSnapshot {
  const slots: (SavedSlot | null)[] = [];
  for (let i = 0; i < 36; i++) slots.push(savedSlot(src, i));
  return { version: 1, at: at.toISOString(), slots, worn: wornOf(src) };
}

/** Free slots of 36. */
export function freeOf(src: InvSource): number {
  let n = 0;
  for (let i = 0; i < 36; i++) if (!live(src.slots[i])) n++;
  return n;
}

/** Every item by name, loose, and inside the boxes as `boxed:<name>`; the worn pieces as `worn:<name>`. */
export function carriedCounts(src: InvSource): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (k: string, n: number) => (out[k] = (out[k] ?? 0) + n);
  for (let i = 0; i < 36; i++) {
    const s = src.slots[i];
    if (!live(s)) continue;
    add(s.name, s.count);
    if (isShulkerBox(s.name)) for (const [k, v] of Object.entries(shulkerContents(rawAt(src, i)))) add(`boxed:${k}`, v);
  }
  for (const w of Object.values(wornOf(src))) if (w) add(`worn:${w}`, 1);
  return out;
}

/** b - a by key (only the keys that changed). */
export function countsDiff(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if ((a[k] ?? 0) !== (b[k] ?? 0)) out[k] = (b[k] ?? 0) - (a[k] ?? 0);
  return out;
}

/** `cobblestone 498, dirt 73, ...` the biggest first, at most `max` entries. */
export function countsLine(c: Record<string, number>, max = 40, signed = false): string {
  const e = Object.entries(c).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]) || x[0].localeCompare(y[0]));
  const parts = e.slice(0, max).map(([k, v]) => `${k} ${signed && v > 0 ? '+' : ''}${v}`);
  if (e.length > max) parts.push(`${e.length - max} more`);
  return parts.join(', ') || 'nothing';
}

/** Cut a line to `max` bytes at a word (`...` at the end). */
export function fitLine(s: string, max = INV_LINE_MAX): string {
  if (wireSize(s) <= max) return s;
  let out = s;
  while (out.length > 0 && wireSize(`${out}...`) > max) out = out.slice(0, out.lastIndexOf(' ') > 0 ? out.lastIndexOf(' ') : out.length - 1);
  return `${out.replace(/[,;:]$/, '')}...`;
}

// ---- the presets --------------------------------------------------------------------------------------------------

type Stack = readonly [item: string, count: number];

/** Food, drops, odds: one partial stack each (the `full` preset's first slots). */
const MIX: readonly Stack[] = [
  ['cooked_beef', 24], ['bread', 12], ['golden_carrot', 20], ['cooked_chicken', 10], ['apple', 5], ['carrot', 32], ['potato', 8],
  ['bone', 12], ['arrow', 15], ['redstone', 17], ['gunpowder', 9], ['stick', 2], ['wheat_seeds', 4], ['feather', 6],
];
/** Stone-like full stacks (the room chore's stone step keeps dropStone of each kind). */
const STONE: readonly Stack[] = [
  ['cobblestone', 64], ['dirt', 64], ['andesite', 64], ['cobbled_deepslate', 64], ['diorite', 64], ['granite', 64], ['tuff', 64], ['gravel', 64],
];
/** Full stacks of things the chore neither drops nor merges (not stone, not junk, not compacted). */
const FILLER: readonly Stack[] = [
  ['oak_log', 64], ['oak_planks', 64], ['glass', 64], ['coal', 64], ['bone', 64], ['gunpowder', 64], ['arrow', 64],
  ['paper', 64], ['stick', 64], ['feather', 64], ['raw_iron', 64], ['raw_copper', 64], ['wheat', 64], ['leather', 64],
];
/** Stone tools after an hour of mining (Track V1's early-game inventory; 36 stacks, the ones that matter first). */
const EARLY: readonly Stack[] = [
  ['stone_pickaxe', 1], ['stone_axe', 1], ['stone_shovel', 1], ['stone_sword', 1], ['torch', 23], ['cobblestone', 64], ['bread', 6], ['crafting_table', 1], ['coal', 41],
  ['rotten_flesh', 5], ['string', 2], ['raw_iron', 23], ['raw_copper', 37], ['flint', 3], ['bone', 3], ['oak_log', 10], ['lapis_lazuli', 11],
  ['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 30], ['cobblestone', 20],
  ['cobbled_deepslate', 64], ['cobbled_deepslate', 64], ['cobbled_deepslate', 12], ['dirt', 64], ['dirt', 9], ['gravel', 14], ['andesite', 64], ['andesite', 22],
  ['diorite', 31], ['granite', 18], ['tuff', 40],
];
/** The same kinds in split stacks (the merge step's case). */
const SPLIT: readonly Stack[] = [
  ['stone_pickaxe', 1], ['stone_axe', 1], ['stone_shovel', 1], ['stone_sword', 1], ['torch', 12], ['torch', 11], ['bread', 3], ['bread', 3],
  ['coal', 20], ['coal', 21], ['rotten_flesh', 3], ['rotten_flesh', 2], ['string', 1], ['string', 1], ['raw_iron', 12], ['raw_iron', 11],
  ['bone', 2], ['bone', 1], ['cobblestone', 30], ['cobblestone', 30], ['cobblestone', 20], ['cobblestone', 20], ['cobblestone', 10],
  ['cobbled_deepslate', 32], ['cobbled_deepslate', 32], ['dirt', 40], ['dirt', 24], ['andesite', 33], ['andesite', 31], ['gravel', 7], ['gravel', 7],
  ['oak_log', 5], ['oak_log', 5], ['raw_copper', 20], ['raw_copper', 17], ['flint', 3],
];
/** Seven stacks of loose rockets, 422 (the live bot's, beside its fireworks box). */
const ROCKETS: readonly Stack[] = [...Array.from({ length: 6 }, (): Stack => ['firework_rocket', 64]), ['firework_rocket', 38]];
/** The hotbar of the place and farm exchange case: nine kinds no job asks for. */
const ODDS: readonly Stack[] = [['stick', 1], ['feather', 1], ['gunpowder', 1], ['paper', 1], ['leather', 1], ['flint', 1], ['clay_ball', 1], ['brick', 1], ['bone', 1]];

export const PRESET_HELP: Readonly<Record<InvPreset, string>> = {
  full: 'every free slot: food, drops, then stone-like stacks (36 of 36)',
  early: 'stone tools, torches, bread, coal, ores, rotten flesh, string, 19 stacks of stone-like blocks',
  split: 'the early kinds in split stacks',
  rockets: '422 loose rockets in 7 stacks beside the fireworks box, the rest full stacks the chore keeps',
  fullbar: 'the hotbar odds, the main inventory full stacks with 32 cobblestone in it only (the place / farm exchange)',
};

/** The tools the presets give: the only gear a restore may take away (unless the save claims it as the owner's). */
export const PRESET_GEAR: ReadonlySet<string> = new Set([...EARLY, ...SPLIT, ...MIX, ...STONE, ...FILLER, ...ROCKETS, ...ODDS].map((s) => s[0]).filter((n) => maxDurability(n) !== undefined));

export interface PresetSlot {
  slot: number;
  item: string;
  count: number;
}

/** The preset's stack for each of the `free` slots (ascending), and how many of its stacks did not fit. */
export function presetStacks(preset: InvPreset, free: readonly number[]): { stacks: PresetSlot[]; notFit: number } {
  const slots = [...free].sort((a, b) => a - b);
  const take = (list: readonly Stack[], into: readonly number[], pad?: readonly Stack[]): { stacks: PresetSlot[]; notFit: number } => {
    const stacks: PresetSlot[] = [];
    into.forEach((slot, k) => {
      const s = k < list.length ? list[k] : pad?.length ? pad[(k - list.length) % pad.length] : undefined;
      if (s) stacks.push({ slot, item: s[0], count: s[1] });
    });
    return { stacks, notFit: Math.max(0, list.length - into.length) };
  };
  switch (preset) {
    case 'full':
      return take(MIX, slots, STONE);
    case 'early':
      return take(EARLY, slots);
    case 'split':
      return take(SPLIT, slots);
    case 'rockets':
      return take(ROCKETS, slots, FILLER);
    case 'fullbar': {
      const bar = take(ODDS, slots.filter((s) => s < 9), ODDS);
      const main = take([['cobblestone', 32]], slots.filter((s) => s >= 9), FILLER);
      return { stacks: [...bar.stacks, ...main.stacks], notFit: main.notFit };
    }
  }
}

// ---- the plans ------------------------------------------------------------------------------------------------------

const spec = (item: string, count: number, metadata = 0): string => `${item} ${count}${metadata ? ` ${metadata}` : ''}`;
export const replaceCommand = (slot: number, what: string, mode?: 'keep'): string => `/replaceitem entity @s ${inventorySlotName(slot)}${mode ? ` ${mode}` : ''} ${what}`;

/**
 * Track T3 follow-up: food the bot eats stays in its slot through a preset (still restorable: the restore puts its saved
 * count back). On the Realm (2026-11-16) `fullbar` cleared every food slot and gave none: 19 s later the food chore
 * started (nothing to eat), the bot walked home for food and the home chore unloaded the preset into the owner's chests.
 * A preset never takes the food below what the bot carried, so the food chore has no reason to start.
 */
export function isKeptFood(name: string): boolean {
  const f = foodInfo(name);
  return !!f && !f.bad;
}

export interface PresetPlan {
  preset: InvPreset;
  /** The slots cleared or filled (empty or restorable at the save, not food). */
  free: number[];
  kept: SavedSlot[];
  /** The food left in place (restorable: the restore gives its count back). */
  fed: SavedSlot[];
  stacks: PresetSlot[];
  notFit: number;
  /** One command a slot: the preset's stack (`keep` into an empty slot, so a pickup meanwhile is not overwritten) or air. */
  commands: { slot: number; command: string }[];
  /** What the bot should carry after the fill (loose, by name; the kept slots included). */
  expect: Record<string, number>;
}

export function planPreset(snap: InvSnapshot, preset: InvPreset): PresetPlan {
  const kept = snap.slots.filter((s): s is SavedSlot => !!s && s.kept !== undefined);
  const fed = snap.slots.filter((s): s is SavedSlot => !!s && s.kept === undefined && isKeptFood(s.name));
  const free = snap.slots.flatMap((s, i) => (s?.kept === undefined && !(s && isKeptFood(s.name)) ? [i] : []));
  const { stacks, notFit } = presetStacks(preset, free);
  const by = new Map(stacks.map((s) => [s.slot, s]));
  const commands: { slot: number; command: string }[] = [];
  const expect: Record<string, number> = {};
  for (const k of [...kept, ...fed]) expect[k.name] = (expect[k.name] ?? 0) + k.count;
  for (const i of free) {
    const p = by.get(i);
    const had = snap.slots[i];
    if (p) {
      commands.push({ slot: i, command: replaceCommand(i, spec(p.item, p.count), had ? undefined : 'keep') });
      expect[p.item] = (expect[p.item] ?? 0) + p.count;
    } else if (had) commands.push({ slot: i, command: replaceCommand(i, 'air') });
  }
  return { preset, free, kept, fed, stacks, notFit, commands, expect };
}

/**
 * The slots a restore never overwrites: every kept item of the save (by its identity, keptKey: in its own slot first,
 * then wherever the hotbar puller or a swap took it), and anything of the kept kinds a preset never gives (a box, an
 * elytra, an enchanted or named item: something picked up meanwhile). Gear beyond the save's own (the stone tools of
 * `early` and `split`) is the preset's and goes.
 */
export function protectedSlots(snap: InvSnapshot, now: InvSource): Set<number> {
  return claimKept(snap, now).protect;
}

/** protectedSlots, and the kept items of the save found in no slot (on the ground, in a chest, gone). */
export function claimKept(snap: InvSnapshot, now: InvSource): { protect: Set<number>; missing: SavedSlot[]; claimed: Map<number, number> } {
  const out = new Set<number>();
  const claimed = new Map<number, number>(); // the save's slot -> the slot it is in now
  const at = (i: number): { key: string; wear: number | undefined; name: string } | undefined => {
    const c = now.slots[i];
    if (!live(c)) return undefined;
    const raw = rawAt(now, i);
    return { key: keptKey(c.name, c.metadata ?? 0, raw), wear: wearOf(raw), name: c.name };
  };
  // each kept item of the save claims one slot: its own with the same wear, any with the same wear, its own, any
  let open = snap.slots.filter((s): s is SavedSlot => s?.kept !== undefined);
  const same = (s: SavedSlot, i: number, exact: boolean): boolean => {
    const c = at(i);
    if (!c) return false;
    if (s.boxed) return c.name === s.name && (!exact || c.key === s.key); // a box whose contents changed is still the box
    // with the wear changed only by use: worn more, never less (a mending tool is enchanted, so its key differs from a
    // preset's new one); a preset's new stone pickaxe is not the owner's worn one
    return c.key === s.key && (exact ? c.wear === s.wear : (c.wear ?? 0) >= (s.wear ?? 0));
  };
  for (const [exact, own] of [[true, true], [true, false], [false, true], [false, false]] as const) {
    open = open.filter((s) => {
      const slots = own ? [s.slot] : Array.from({ length: 36 }, (_, i) => i);
      const i = slots.find((k) => !out.has(k) && same(s, k, exact));
      if (i === undefined) return true;
      out.add(i);
      claimed.set(s.slot, i);
      return false;
    });
  }
  // the kinds a preset never gives stay wherever they are: only a plain tool of a kind a preset gives (stone tools) may go
  for (let i = 0; i < 36; i++) {
    const c = now.slots[i];
    if (!live(c) || out.has(i)) continue;
    const why = keptReason(c, rawAt(now, i));
    if (why !== undefined && !(why === 'gear' && PRESET_GEAR.has(c.name))) out.add(i);
  }
  return { protect: out, missing: open, claimed };
}

const wearOf = (raw: unknown): number | undefined => {
  const v = nbtOf(raw)?.Damage?.value;
  return typeof v === 'number' ? v : undefined;
};

export interface RestorePlan {
  commands: string[];
  /** What cannot be put back as it was (said in the reply and the log). */
  notes: string[];
}

const sameAsSaved = (s: ItemStack | null | undefined, raw: unknown, saved: SavedSlot | null): boolean => {
  if (!live(s)) return !saved;
  if (!saved) return false;
  return s.name === saved.name && s.count === saved.count && (s.metadata ?? 0) === saved.metadata && keptReason(s, raw) === undefined;
};

/**
 * The commands that put `snap` back on what the bot carries now (pure). A slot that held a restorable stack or nothing
 * gets it back by /replaceitem; a slot holding a kept item now (gear the hotbar puller moved there, a box) is never
 * overwritten: its saved stack is given by /give. A kept slot holding a restorable stack now is emptied (that stack is
 * the preset's or comes back in its own slot). Kept items not in their slot, a box's changed contents and changed worn
 * pieces are notes.
 */
export function planRestore(snap: InvSnapshot, now: InvSource): RestorePlan {
  const commands: string[] = [];
  // Track V1c: the /give commands go last: /give takes the first empty slot, which a later /replaceitem could clear
  // (a box the room chore picked up into a lower slot: its displaced stack was given and then overwritten)
  const gives: string[] = [];
  const sets: string[] = [];
  const notes: string[] = [];
  const { protect, claimed } = claimKept(snap, now);
  for (let i = 0; i < 36; i++) {
    const saved = snap.slots[i] ?? null;
    const cur = now.slots[i];
    const raw = rawAt(now, i);
    if (saved?.kept !== undefined) {
      if (live(cur) && !protect.has(i)) commands.push(replaceCommand(i, 'air'));
      continue;
    }
    if (live(cur) && protect.has(i)) {
      const curKept = keptReason(cur, raw) ?? 'kept';
      if (saved) {
        gives.push(`/give @s ${spec(saved.name, saved.count, saved.metadata)}`);
        notes.push(`slot ${i} holds ${cur.name} (${curKept}): ${saved.count} ${saved.name} given by /give`);
      }
      continue;
    }
    if (sameAsSaved(cur, raw, saved)) continue;
    if (saved) sets.push(replaceCommand(i, spec(saved.name, saved.count, saved.metadata)));
    else commands.push(replaceCommand(i, 'air'));
  }
  // Track T3 follow-up: the slots to empty go first, then the saved stacks: a saved partial stack never sits beside a
  // preset's stack of the same item while the restore runs (on bds-farm, 2026-11-16, 3 of 8 `full` runs ended with
  // 48 of a preset's cobblestone on the owner's restored 16, moved there between two commands)
  commands.push(...sets);
  commands.push(...gives);
  // the kept items: in their slot, moved, or gone
  for (const s of snap.slots) {
    if (s?.kept === undefined) continue;
    const at = claimed.get(s.slot);
    if (at === undefined) notes.push(`${s.name} (${s.kept}) from slot ${s.slot} is gone`);
    else if (at !== s.slot) notes.push(`${s.name} (${s.kept}) moved from slot ${s.slot} to ${at}`);
    else if (!s.boxed && now.slots[at]!.count !== s.count) notes.push(`slot ${s.slot} ${s.name}: ${s.count} -> ${now.slots[at]!.count}`);
  }
  // the boxes: what they hold now against the save (a command cannot take it out)
  const boxedSaved: Record<string, number> = {};
  for (const s of snap.slots) if (s?.boxed) for (const [k, v] of Object.entries(s.boxed)) boxedSaved[k] = (boxedSaved[k] ?? 0) + v;
  const boxedNow: Record<string, number> = {};
  for (const [k, v] of Object.entries(carriedCounts(now))) if (k.startsWith('boxed:')) boxedNow[k.slice(6)] = v;
  const savedBoxes = snap.slots.filter((s) => s?.boxed).length;
  const nowBoxes = now.slots.slice(0, 36).filter((s) => live(s) && isShulkerBox(s.name)).length;
  if (nowBoxes !== savedBoxes) notes.push(`${savedBoxes} box${savedBoxes === 1 ? '' : 'es'} saved, ${nowBoxes} carried`);
  const d = countsDiff(boxedSaved, boxedNow);
  if (Object.keys(d).length) notes.push(`the boxes hold ${countsLine(d, 6, true)} (a command cannot take it out)`);
  const worn = wornOf(now);
  for (const w of WORN_SLOTS) if (worn[w] !== snap.worn[w]) notes.push(`worn ${w}: ${snap.worn[w] ?? 'nothing'} -> ${worn[w] ?? 'nothing'}`);
  return { commands, notes };
}

/** The restorable slots that do not match the save now (after a restore: should be none but the noted ones). */
export function restoreMismatches(snap: InvSnapshot, now: InvSource): string[] {
  const out: string[] = [];
  for (let i = 0; i < 36; i++) {
    const saved = snap.slots[i] ?? null;
    if (saved?.kept !== undefined) continue;
    const cur = now.slots[i];
    if (sameAsSaved(cur, rawAt(now, i), saved)) continue;
    out.push(`slot ${i}: ${saved ? `${saved.count} ${saved.name}` : 'empty'} saved, ${live(cur) ? `${cur.count} ${cur.name}` : 'empty'} now`);
  }
  return out;
}

// ---- the runner -----------------------------------------------------------------------------------------------------

/** A room chore pass as `!test inv status` reads it (tasks/process/room.ts RoomPass). */
export interface PassLike {
  freeBefore: number;
  freeAfter: number;
  ms: number;
  steps: readonly { line: string; ok: boolean }[];
}

export interface InvTestPorts {
  /** One command, paced under the runner's rate limit (command.ts `pace`). */
  run(command: string): Promise<CommandResult>;
  /** The inventory model. */
  inventory(): InvSource;
  /** Why not now (a trip, a fight, another test, something in control); undefined when the bot is free. */
  busy(): string | undefined;
  /** Keep every chore off while the commands go out (a user process that does nothing); resolves with its release, or a reason. */
  hold(): Promise<(() => void) | string>;
  /** The fireworks box's slot, -1 when none (fly/kit.ts readKit). */
  fireworksBox(): number;
  /** The room chore's passes so far (the newest last), empty without one. */
  passes(): readonly PassLike[];
  /** Write the save (undefined: remove it); the file's name, or undefined when there is no tests folder. */
  persist(snap: InvSnapshot | undefined): string | undefined;
  /** A save left by an earlier session (the file). */
  load(): InvSnapshot | undefined;
  /** Wait for the server's slot updates to reach the model. */
  settle(): Promise<void>;
  /**
   * Track T3 follow-up: why a restore cannot go now. `wait`: the restore waits for it to end (a fight, the guard, the flee,
   * the night shelter, a room pass: what keeps the bot safe is never cut short), else it is refused (a series, a flight,
   * the owner's command). A chore below the owner's commands (the food chore, the home return) is no reason: the restore's
   * hold takes control from it. Without it: busy(), refused.
   */
  restoreBlock?(): { line: string; wait: boolean } | undefined;
  /** Lines of a restore nobody asked for (the time limit's, the food chore's): chat. Without it: the log only. */
  announce?(m: string): void;
  /** Before a restore of the bot's own: why no command can go now (testMode off, not an operator); undefined: it can. */
  canCommand?(): Promise<string | undefined>;
  sleep?(ms: number): Promise<void>;
  /** How long a save may wait before the bot restores it on its own (ms; INV_SAVE_LIMIT_MS). */
  limitMs?: number;
  /** How long a restore waits out a fight (ms; RESTORE_WAIT_MS). */
  waitMs?: number;
  log?: Logger;
  now?: () => number;
}

/**
 * Track T3 follow-up: a save waits at most this long, then the bot restores it on its own, so a forgotten preset never
 * stays (and never holds the unload for good). A fill takes 5 to 9 s and a room pass 2 to 9 s (docs/inventory.md), and
 * the Realm series of 2026-11-16 waited 25 s before its restore; ten minutes leaves time to read `!test inv status` and
 * to try a skill by hand.
 */
export const INV_SAVE_LIMIT_MS = 10 * 60_000;
/**
 * A restore asked while the bot fights (or flees, or shelters) waits this long for the guard to hand back, then says so
 * and keeps the save: long enough for a fight with a few mobs, short enough that the owner hears back.
 */
export const RESTORE_WAIT_MS = 3 * 60_000;
/** After a restore of its own that could not run, the next one waits this long (ms), so the food chore is not held by it. */
export const AUTO_RETRY_MS = 60_000;
/** How often a waiting restore looks again (ms). */
const WAIT_POLL_MS = 500;

interface Active {
  snap: InvSnapshot;
  preset: InvPreset;
  since: number;
  /** The passes before the preset (by identity: the chore keeps 20). */
  seen: Set<PassLike>;
  after: Record<string, number>;
  freeAfter: number;
}

/** `!test inv restore sweep`: the items on the ground within 8 blocks go first (the stone and junk the chore dropped). */
export const SWEEP = '/kill @e[type=item,r=8]';

const ago = (ms: number): string => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

export class InvTest {
  private readonly p: InvTestPorts;
  private readonly log: Logger;
  private readonly now: () => number;
  private active: Active | undefined;
  private running = false;
  /** The file's save (read once: every write goes through `persist`); null: none. */
  private loaded: InvSnapshot | null | undefined;
  /** What a restore waits for (a fight); undefined: none waits. */
  private queued: string | undefined;
  /** Why the restore of the bot's own (the time limit, the food chore) runs; undefined: none. */
  private auto: string | undefined;
  /** No restore of its own before this time (one could not run a moment ago). */
  private autoAfter = 0;
  /** The movers logged as held for this save (one line each). */
  private readonly told = new Set<string>();
  private readonly sleep: (ms: number) => Promise<void>;
  /** How long a save may wait before the bot restores it on its own (ms; the e2e shortens it). */
  limitMs: number;

  constructor(p: InvTestPorts) {
    this.p = p;
    this.limitMs = p.limitMs ?? INV_SAVE_LIMIT_MS;
    this.log = p.log ?? silentLogger;
    this.now = p.now ?? Date.now;
    this.sleep = (ms) => (p.sleep ? p.sleep(ms) : new Promise((r) => setTimeout(r, ms)));
  }

  /** The save waiting for a restore (this session's, else the file's). */
  saved(): InvSnapshot | undefined {
    if (this.active) return this.active.snap;
    if (this.loaded === undefined) this.loaded = this.p.load() ?? null;
    return this.loaded ?? undefined;
  }

  get preset(): InvPreset | undefined {
    return this.saved()?.preset;
  }

  get busy(): boolean {
    return this.running;
  }

  /** A restore waits (for a fight to end) or runs. */
  get restoring(): boolean {
    return this.queued !== undefined || this.auto !== undefined;
  }

  private persist(snap: InvSnapshot | undefined): string | undefined {
    this.loaded = snap ?? null;
    this.told.clear();
    return this.p.persist(snap);
  }

  /** A refusal: said and one INFO line with its reason (the Realm's were silent in the log, 2026-11-16). */
  private refuse(say: (m: string) => void, line: string): void {
    this.log.info(`test inv: refused: ${line}`);
    say(line);
  }

  private refusal(): string | undefined {
    if (this.running) return 'test inv: a preset or a restore is going out';
    const b = this.p.busy();
    return b ? `test inv: not now: ${b}` : undefined;
  }

  private block(): { line: string; wait: boolean } | undefined {
    if (this.p.restoreBlock) return this.p.restoreBlock();
    const b = this.p.busy();
    return b ? { line: b, wait: false } : undefined;
  }

  /**
   * Track T3 follow-up (skills/test/guard.ts): the line naming the save that waits, undefined when none; `who` is logged
   * once a save as held.
   */
  waiting(who?: string): string | undefined {
    const s = this.saved();
    if (!s) return undefined;
    const line = `a !test inv${s.preset ? ` ${s.preset}` : ''} save from ${s.at.slice(11, 19)} UTC waits for its restore`;
    if (who && !this.told.has(who)) {
      this.told.add(who);
      this.log.info(`test inv: ${who} held until the restore (${line})`);
    }
    return line;
  }

  /**
   * A chore that would leave the spot asks to run (the food chore): the restore runs first, on its own. True: the chore
   * waits (a restore runs or waits for a fight); false: no save, or a restore of its own failed within AUTO_RETRY_MS (the
   * chore goes on: food is never held).
   */
  restoreFirst(why: string): boolean {
    if (!this.saved()) return false;
    if (this.running || this.restoring) return true;
    if (this.now() < this.autoAfter) return false;
    this.restoreOnMyOwn(`restore first: ${why}`);
    return true;
  }

  /** Track T3 follow-up: call every few seconds; past the time limit the save is restored on its own. */
  tick(): void {
    const snap = this.saved();
    if (!snap || this.running || this.restoring || this.now() < this.autoAfter) return;
    const since = this.active?.since ?? Date.parse(snap.at);
    const age = this.now() - since;
    const limit = this.limitMs;
    if (!(age >= limit)) return;
    this.restoreOnMyOwn(`the save waited ${ago(age)}, the limit is ${ago(limit)}`);
  }

  private restoreOnMyOwn(why: string): void {
    this.auto = why;
    const say = (m: string): void => this.p.announce?.(m);
    this.log.info(`test inv: restoring on my own (${why})`);
    say(fitLine(`test inv: restoring the saved inventory on my own (${why})`));
    // after the caller's turn (the food chore asks from the manager's arbitration; the restore adds its hold process)
    queueMicrotask(() => {
      void (async () => {
        const no = await this.p.canCommand?.();
        if (no) return this.refuse(say, `test inv: no restore of my own: ${no}`);
        await this.restore(say, { own: true });
      })()
        .catch((e: unknown) => this.log.warn(`test inv: the restore of my own failed: ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => {
          this.auto = undefined;
          if (this.saved()) this.autoAfter = this.now() + AUTO_RETRY_MS;
        });
    });
  }

  /**
   * Run the commands (under the hold taken by `held`); the first failure ends it, except a `keep` into a slot something
   * took meanwhile (a pickup: skipped, said) and an `optional` one (the sweep finds no item: fine). Waits for the model.
   */
  private async send(commands: readonly string[], optional: ReadonlySet<string> = new Set()): Promise<{ sent: number; failed?: string; skipped: string[] }> {
    const skipped: string[] = [];
    let sent = 0;
    try {
      for (const c of commands) {
        const r = await this.p.run(c);
        sent++;
        if (r.ok || optional.has(c)) continue;
        if (r.messageId === 'commands.replaceitem.failed' && c.includes(' keep ')) {
          skipped.push(c.replace(/^\/replaceitem entity @s /, ''));
          continue;
        }
        return { sent: sent - 1, failed: `${c}: ${resultText(r)}`, skipped };
      }
      return { sent, skipped };
    } finally {
      await this.p.settle();
    }
  }

  /** `fn` with every chore held off from before the save to after the last command (nothing moves items meanwhile). */
  private async held(say: (m: string) => void, fn: () => Promise<void>): Promise<void> {
    this.running = true;
    try {
      const release = await this.p.hold();
      if (typeof release === 'string') return this.refuse(say, `test inv: not now: ${release}`);
      try {
        await fn();
      } finally {
        release();
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Save, check, say what stays, clear and fill. `say` gets the plan line before anything is cleared, then the end line.
   */
  async start(preset: InvPreset, say: (m: string) => void): Promise<void> {
    const no = this.refusal();
    if (no) return this.refuse(say, no);
    const waiting = this.saved();
    if (waiting) return this.refuse(say, `test inv: the inventory saved ${waiting.preset ? `for ${waiting.preset} ` : ''}at ${waiting.at.slice(11, 19)} is not back yet: !test inv restore first`);
    return this.held(say, async () => {
      const inv = this.p.inventory();
      const snap = snapshotInv(inv, new Date(this.now()));
      snap.preset = preset;
      // the server's own count of every restorable item: the model must agree before anything is cleared
      const want = new Map<string, number>();
      for (const s of snap.slots) if (s && s.kept === undefined) want.set(s.name, 0);
      const all = carriedCounts(inv);
      const notCommand: string[] = [];
      for (const name of want.keys()) {
        const r = await this.p.run(`/clear @s ${name} -1 0`);
        const model = (all[name] ?? 0) + (all[`worn:${name}`] ?? 0);
        if (r.messageId === 'commands.generic.syntax') {
          notCommand.push(name);
          continue;
        }
        const n = r.ok && r.messageId === 'commands.clear.testing' ? Number(r.params[1]) : r.messageId === 'commands.clear.failure.no.items' ? 0 : NaN;
        if (!Number.isFinite(n)) return this.refuse(say, `test inv: nothing cleared: the count of ${name} failed (${resultText(r)})`);
        if (n !== model) return this.refuse(say, `test inv: nothing cleared: the server counts ${n} ${name}, my inventory ${model}; try again in a moment`);
      }
      for (const s of snap.slots) if (s && s.kept === undefined && notCommand.includes(s.name)) s.kept = 'not a command item';
      const plan = planPreset(snap, preset);
      const file = this.persist(snap);
      this.autoAfter = 0;
      const kept = plan.kept.map((k) => `${k.name}${k.kept === 'gear' || k.kept === 'box' || k.kept === 'elytra' ? '' : ` (${k.kept})`}`);
      const box = this.p.fireworksBox();
      const rocketNote = preset === 'rockets' && box < 0 ? '; no fireworks box carried: the rockets stay loose' : '';
      const free0 = freeOf(inv);
      const fed = plan.fed.length ? `; the food stays (${plan.fed.length} stack${plan.fed.length === 1 ? '' : 's'})` : '';
      const limit = ago(this.limitMs);
      this.log.info(`test inv ${preset}: before: ${free0} free; carried ${countsLine(all)}; kept in place ${plan.kept.length}: ${kept.join(', ') || 'none'}; food in place ${plan.fed.length}${file ? `; saved to ${file}` : '; saved in memory only'}; restored on my own after ${limit}`);
      say(fitLine(`test inv ${preset}: saved${file ? '' : ' (memory only)'}; ${plan.free.length} slots cleared and given back exactly by !test inv restore, ${plan.kept.length} stay in place (${kept.join(', ') || 'none'})${fed}; what goes into a box stays there${plan.notFit ? `; ${plan.notFit} stacks do not fit` : ''}${rocketNote}; no unload until the restore (on my own after ${limit})`));
      const t0 = this.now();
      const r = await this.send(plan.commands.map((c) => c.command));
      const after = carriedCounts(this.p.inventory());
      const free1 = freeOf(this.p.inventory());
      const secs = ((this.now() - t0) / 1000).toFixed(1);
      const skipped = r.skipped.length ? `; ${r.skipped.length} slot${r.skipped.length === 1 ? '' : 's'} taken meanwhile, not filled (${r.skipped.join(', ')})` : '';
      this.log.info(`test inv ${preset}: after: ${free1} free (${r.sent} of ${plan.commands.length} commands, ${secs} s); carried ${countsLine(after)}${skipped}${r.failed ? `; stopped: ${r.failed}` : ''}`);
      if (r.failed && r.sent === 0) {
        this.persist(undefined); // nothing changed: nothing to restore
        return say(fitLine(`test inv ${preset}: nothing cleared: ${r.failed}`));
      }
      this.active = { snap, preset, since: this.now(), seen: new Set(this.p.passes()), after, freeAfter: free1 };
      if (r.failed) say(fitLine(`test inv ${preset}: stopped after ${r.sent} of ${plan.commands.length} commands: ${r.failed}; !test inv restore gives the saved inventory back`));
      else say(fitLine(`test inv ${preset}: ${free0} -> ${free1} free in ${secs} s (${plan.commands.length} commands)${skipped}; !test inv status, !test inv restore`));
    });
  }

  /**
   * Put the save back. `sweep`: remove the items on the ground within 8 first (what the chore dropped). Track T3 follow-up:
   * during a fight (the guard, the flee, the night shelter, a room pass) it waits up to RESTORE_WAIT_MS and says so, then
   * goes; a chore below the owner's commands is paused by its hold; a series, a flight or the owner's command refuses it.
   * `own`: the bot's own restore (the time limit, the food chore).
   */
  async restore(say: (m: string) => void, opts: { sweep?: boolean; own?: boolean } = {}): Promise<void> {
    if (this.running) return this.refuse(say, 'test inv: a preset or a restore is going out');
    if (this.queued !== undefined) return this.refuse(say, `test inv restore: a restore already waits for ${this.queued} to end`);
    if (this.auto !== undefined && !opts.own) return this.refuse(say, `test inv restore: I am restoring on my own already (${this.auto})`);
    if (!this.saved()) return this.refuse(say, 'test inv: nothing saved to restore');
    let b = this.block();
    if (b && !b.wait) return this.refuse(say, `test inv: not now: ${b.line}`);
    if (b) {
      const waitMs = this.p.waitMs ?? RESTORE_WAIT_MS;
      const t0 = this.now();
      this.queued = b.line;
      this.log.info(`test inv restore: waiting for ${b.line} to end (at most ${ago(waitMs)})`);
      say(`test inv restore: waiting for ${b.line} to end (at most ${ago(waitMs)}), then the restore`);
      try {
        while (b?.wait && this.now() - t0 < waitMs) {
          await this.sleep(WAIT_POLL_MS);
          b = this.block();
        }
      } finally {
        this.queued = undefined;
      }
      if (b) return this.refuse(say, b.wait ? `test inv restore: ${b.line} still after ${ago(this.now() - t0)}; the save is kept (!test inv restore again)` : `test inv: not now: ${b.line}`);
      this.log.info(`test inv restore: ${ago(this.now() - t0)} waited, restoring`);
    }
    const snap = this.saved();
    if (!snap) return this.refuse(say, 'test inv: nothing saved to restore');
    return this.held(say, async () => {
      const before = carriedCounts(this.p.inventory());
      const free0 = freeOf(this.p.inventory());
      const plan = planRestore(snap, this.p.inventory());
      // the sweep never runs while a kept item of the save is missing: it may lie on the ground within reach
      const missing = claimKept(snap, this.p.inventory()).missing;
      const sweep = opts.sweep === true && missing.length === 0;
      if (opts.sweep && !sweep) plan.notes.unshift(`no sweep: ${missing.map((m) => m.name).join(', ')} not carried (on the ground nearby?), the items on the ground stay`);
      const commands = [...(sweep ? [SWEEP] : []), ...plan.commands];
      this.log.info(`test inv restore: before: ${free0} free; carried ${countsLine(before)}; ${plan.commands.length} commands${plan.notes.length ? `; ${plan.notes.join('; ')}` : ''}`);
      const t0 = this.now();
      const r = await this.send(commands, new Set([SWEEP]));
      const inv = this.p.inventory();
      const after = carriedCounts(inv);
      const off = restoreMismatches(snap, inv);
      const secs = ((this.now() - t0) / 1000).toFixed(1);
      this.log.info(`test inv restore: after: ${freeOf(inv)} free (${r.sent} of ${commands.length} commands, ${secs} s); carried ${countsLine(after)}${off.length ? `; not as saved: ${off.join('; ')}` : ''}${r.failed ? `; stopped: ${r.failed}` : ''}`);
      if (r.failed) return say(fitLine(`test inv restore: stopped after ${r.sent} of ${commands.length} commands: ${r.failed}; the save is kept (!test inv restore again)`));
      this.active = undefined;
      this.persist(undefined);
      const notes = [...plan.notes, ...off];
      say(fitLine(`test inv restore: ${free0} -> ${freeOf(inv)} free in ${secs} s (${plan.commands.length} commands); ${notes.length ? notes.join('; ') : 'every slot as saved'}`));
    });
  }

  /** What the room chore did since the preset. */
  status(): string {
    const a = this.active;
    if (!a) {
      const f = this.saved();
      return f ? `test inv: an inventory saved at ${f.at.slice(0, 19).replace('T', ' ')} UTC${f.preset ? ` (${f.preset})` : ''} waits: !test inv restore` : 'test inv: no preset on';
    }
    const left = Math.max(0, this.limitMs - (this.now() - a.since));
    const restoring = this.queued !== undefined ? `; the restore waits for ${this.queued}` : this.auto !== undefined ? '; restoring on my own' : `; restored on my own in ${ago(left)}`;
    const inv = this.p.inventory();
    const passes = this.p.passes().filter((x) => !a.seen.has(x));
    const steps = passes.flatMap((x) => x.steps.map((s) => `${s.ok ? '' : 'failed: '}${s.line.replace(/^inventory: /, '')}`));
    const d = countsDiff(a.after, carriedCounts(inv));
    const passLine = passes.length ? `room chore ${passes.length} pass${passes.length === 1 ? '' : 'es'} (${passes.map((x) => `${x.freeBefore} -> ${x.freeAfter} in ${(x.ms / 1000).toFixed(1)} s`).join(', ')}): ${steps.join('; ') || 'no step'}` : 'no room chore pass yet';
    return fitLine(`test inv ${a.preset} (${ago(this.now() - a.since)}): ${a.freeAfter} -> ${freeOf(inv)} free${restoring}; ${passLine}; changed ${countsLine(d, 8, true)}`);
  }
}

/** `!test inv ...` arguments. */
export function parseInvArgs(args: readonly string[]): { kind: 'preset'; preset: InvPreset } | { kind: 'restore'; sweep: boolean } | { kind: 'status' } | { error: string } {
  const a = args.map((x) => x.toLowerCase());
  const usage = `usage: !test inv ${INV_PRESETS.join(' | ')} | restore [sweep] | status`;
  if (a.length === 0 || (a[0] === 'status' && a.length === 1)) return { kind: 'status' };
  if (a[0] === 'restore') {
    if (a.length === 1) return { kind: 'restore', sweep: false };
    if (a.length === 2 && a[1] === 'sweep') return { kind: 'restore', sweep: true };
    return { error: usage };
  }
  if (a.length === 1 && (INV_PRESETS as readonly string[]).includes(a[0]!)) return { kind: 'preset', preset: a[0] as InvPreset };
  return { error: usage };
}
