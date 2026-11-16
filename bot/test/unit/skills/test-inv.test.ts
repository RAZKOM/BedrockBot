// Track T3: `!test inv` (skills/test/inv.ts): what stays in place, the presets, the plans, and the runner against a fake
// server that runs /replaceitem, /give and /clear on a fake inventory the way BDS 1.26.60 does (docs/inventory.md).
import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../../../src/skills/test/command.ts';
import {
  carriedCounts,
  countsDiff,
  fitLine,
  freeOf,
  INV_PRESETS,
  InvTest,
  keptReason,
  parseInvArgs,
  planPreset,
  planRestore,
  presetStacks,
  restoreMismatches,
  snapshotInv,
  SWEEP,
  type InvSnapshot,
  type InvSource,
  type InvTestPorts,
  type PassLike,
  INV_SAVE_LIMIT_MS,
  RESTORE_WAIT_MS,
  AUTO_RETRY_MS,
} from '../../../src/skills/test/inv.ts';
import { silentLogger } from '../../../src/log.ts';
import type { ItemStack } from '../../../src/world/types.ts';
import { wireSize } from '../../../src/chat/style.ts';
import { inventoryFoodPoints } from '../../../src/skills/food/finder.ts';
import { shulkerContents } from '../../../src/skills/container/chest.ts';

// ---- wire items as the server sends them -----------------------------------------------------------------------------

const nbt = (value: Record<string, unknown>) => ({ extra: { has_nbt: 1, nbt: { version: 1, nbt: { type: 'compound', name: '', value } } } });
const plainRaw = () => ({ extra: { has_nbt: 0 } });
const rocketRaw = (flight = 1, explosions: unknown[] = []) => nbt({ Fireworks: { type: 'compound', value: { Explosions: { type: 'list', value: { type: 'end', value: explosions } }, Flight: { type: 'byte', value: flight } } } });
const damageRaw = (d: number) => nbt({ Damage: { type: 'int', value: d } });
const enchRaw = (d = 0) => nbt({ Damage: { type: 'int', value: d }, ench: { type: 'list', value: { type: 'compound', value: [{ id: { type: 'short', value: 9 }, lvl: { type: 'short', value: 5 } }] } } });
const namedRaw = (name: string, items: { Name: string; Count: number }[] = []) =>
  nbt({
    display: { type: 'compound', value: { Name: { type: 'string', value: name } } },
    ...(items.length ? { Items: { type: 'list', value: { type: 'compound', value: items.map((x, i) => ({ Name: { type: 'string', value: `minecraft:${x.Name}` }, Count: { type: 'byte', value: x.Count }, Slot: { type: 'byte', value: i } })) } } } : {}),
  });
const boxRaw = (items: { Name: string; Count: number }[]) =>
  items.length ? nbt({ Items: { type: 'list', value: { type: 'compound', value: items.map((x, i) => ({ Name: { type: 'string', value: `minecraft:${x.Name}` }, Count: { type: 'byte', value: x.Count }, Slot: { type: 'byte', value: i } })) } } }) : plainRaw();

interface Cell {
  name: string;
  count: number;
  metadata: number;
  raw: unknown;
}

const STACK: Record<string, number> = { stone_pickaxe: 1, stone_axe: 1, stone_shovel: 1, stone_sword: 1, crafting_table: 64, elytra: 1, netherite_sword: 1, green_shulker_box: 1, undyed_shulker_box: 1, potion: 1 };

/** A fake server and its inventory model in one: what the commands do on BDS (measured), the model updated at once. */
class FakeServer implements InvSource {
  cells: (Cell | null)[] = Array.from({ length: 36 }, () => null);
  armor: (ItemStack | null)[] = [null, null, null, null];
  off: (ItemStack | null)[] = [null];
  sent: string[] = [];
  /** The server's count differs from the model for this item (a slot update not in yet). */
  lag: Record<string, number> = {};
  unknown = new Set<string>(['not_an_item']);
  failAt = -1;

  get slots(): (ItemStack | null)[] {
    return this.cells.map((c) => (c ? { name: c.name, count: c.count, metadata: c.metadata, networkId: 1 } : null));
  }
  rawItem(_w: number, i: number): unknown {
    return this.cells[i]?.raw;
  }
  window(id: number) {
    return id === 120 ? { slots: this.armor } : id === 119 ? { slots: this.off } : undefined;
  }
  put(i: number, name: string, count: number, raw: unknown = name === 'firework_rocket' ? rocketRaw() : plainRaw(), metadata = 0): void {
    this.cells[i] = { name, count, metadata, raw };
  }
  private given(name: string, data: number): unknown {
    if (name === 'firework_rocket') return rocketRaw();
    if (['stone_pickaxe', 'stone_axe', 'stone_shovel', 'stone_sword', 'elytra', 'netherite_sword'].includes(name)) return damageRaw(data);
    return plainRaw();
  }
  readonly run = (c: string): Promise<CommandResult> => Promise.resolve(this.exec(c));
  private exec(c: string): CommandResult {
    this.sent.push(c);
    const res = (ok: boolean, messageId: string, params: string[] = []): CommandResult => ({ command: c, ok, successCount: ok ? 1 : 0, messageId, params, ms: 1 });
    if (this.failAt >= 0 && this.sent.length - 1 >= this.failAt) return res(false, 'commands.generic.permission.selector');
    const w = c.split(' ');
    if (w[0] === '/clear') {
      const name = w[2]!;
      if (this.unknown.has(name)) return res(false, 'commands.generic.syntax');
      const n = this.cells.reduce((a, x) => a + (x?.name === name ? x.count : 0), 0) + (this.lag[name] ?? 0);
      return n > 0 ? res(true, 'commands.clear.testing', ['bot', String(n)]) : res(false, 'commands.clear.failure.no.items', ['bot']);
    }
    if (w[0] === '/replaceitem') {
      const i = (w[3] === 'slot.hotbar' ? 0 : 9) + Number(w[4]);
      let k = 5;
      const keep = w[k] === 'keep';
      if (keep || w[k] === 'destroy') k++;
      const name = w[k]!;
      const count = Number(w[k + 1] ?? 1);
      const data = Number(w[k + 2] ?? 0);
      if (this.unknown.has(name)) return res(false, 'commands.generic.syntax');
      if (count > (STACK[name] ?? 64)) return res(false, 'commands.generic.num.tooBig');
      if (keep && this.cells[i]) return res(false, 'commands.replaceitem.failed');
      this.cells[i] = name === 'air' ? null : { name, count, metadata: name === 'potion' ? data : 0, raw: this.given(name, data) };
      return res(true, 'commands.replaceitem.success.entity');
    }
    if (w[0] === '/give') {
      const i = this.cells.findIndex((x) => !x);
      if (i >= 0) this.cells[i] = { name: w[2]!, count: Number(w[3] ?? 1), metadata: Number(w[4] ?? 0), raw: this.given(w[2]!, 0) };
      return res(true, 'commands.give.success');
    }
    if (w[0] === '/kill') return res(false, 'commands.kill.no.targets');
    return res(false, 'commands.generic.unknown');
  }
}

/** The live bot's kind of inventory: gear, the elytra, a fireworks box, a named box, an enchanted sword, a flight-3 rocket stack, plain food and drops. */
function liveLike(): FakeServer {
  const s = new FakeServer();
  s.put(0, 'netherite_sword', 1, enchRaw(12));
  s.put(1, 'stone_pickaxe', 1, damageRaw(3));
  s.put(2, 'firework_rocket', 64);
  s.put(3, 'cooked_beef', 24);
  s.put(4, 'firework_rocket', 20, rocketRaw(3));
  s.put(9, 'elytra', 1, damageRaw(40));
  s.put(10, 'green_shulker_box', 1, boxRaw([{ Name: 'firework_rocket', Count: 64 }, { Name: 'firework_rocket', Count: 64 }]));
  s.put(11, 'undyed_shulker_box', 1, namedRaw('bot_loot', [{ Name: 'bone', Count: 12 }]));
  s.put(12, 'green_shulker_box', 1, plainRaw());
  s.put(13, 'bread', 7);
  s.put(14, 'potion', 1, plainRaw(), 5);
  s.put(20, 'cobblestone', 16);
  s.put(21, 'bone', 3);
  s.armor = [{ name: 'netherite_helmet', count: 1, metadata: 0, networkId: 1 }, null, null, null];
  return s;
}

describe('what stays in place', () => {
  it('gear, the elytra, boxes and items with NBT a command cannot make stay; plain items and Flight 1 rockets do not', () => {
    expect(keptReason({ name: 'cooked_beef' }, plainRaw())).toBeUndefined();
    expect(keptReason({ name: 'firework_rocket' }, rocketRaw(1))).toBeUndefined();
    expect(keptReason({ name: 'firework_rocket' }, rocketRaw(3))).toBe('rocket flight 3');
    expect(keptReason({ name: 'firework_rocket' }, rocketRaw(1, [{ x: 1 }]))).toBe('rocket with explosions');
    expect(keptReason({ name: 'green_shulker_box' }, plainRaw())).toBe('box');
    expect(keptReason({ name: 'undyed_shulker_box' }, namedRaw('bot_loot'))).toBe('box "bot_loot"');
    expect(keptReason({ name: 'elytra' }, damageRaw(0))).toBe('elytra');
    expect(keptReason({ name: 'stone_pickaxe' }, plainRaw())).toBe('gear'); // even plain: the owner's tools stay
    expect(keptReason({ name: 'enchanted_book' }, enchRaw())).toBe('enchanted');
    expect(keptReason({ name: 'diamond' }, namedRaw('gift'))).toBe('named');
    expect(keptReason({ name: 'filled_map' }, nbt({ map_uuid: { type: 'long', value: 3 } }))).toBe('nbt map_uuid');
    expect(keptReason({ name: 'bread' }, undefined)).toBe('not read');
    expect(keptReason({ name: 'unknown:999' }, plainRaw())).toBe('unknown item');
  });

  it('the snapshot keeps every slot with its kind, the boxes with their contents, the worn pieces', () => {
    const snap = snapshotInv(liveLike());
    expect(snap.slots.filter((x) => x?.kept).map((x) => [x!.slot, x!.kept])).toEqual([
      [0, 'enchanted'], [1, 'gear'], [4, 'rocket flight 3'], [9, 'elytra'], [10, 'box'], [11, 'box "bot_loot"'], [12, 'box'],
    ]);
    expect(snap.slots[10]!.boxed).toEqual({ firework_rocket: 128 });
    expect(snap.slots[14]).toMatchObject({ name: 'potion', metadata: 5 });
    expect(snap.worn.head).toBe('netherite_helmet');
    expect(snap.slots.filter((x) => x && !x.kept)).toHaveLength(6);
  });
});

describe('the presets', () => {
  const all = Array.from({ length: 36 }, (_, i) => i);
  it('full fills every free slot; early and split keep their order and say what did not fit', () => {
    for (const p of INV_PRESETS) {
      const { stacks } = presetStacks(p, all);
      for (const s of stacks) expect(s.count).toBeLessThanOrEqual(STACK[s.item] ?? 64);
    }
    expect(presetStacks('full', all).stacks).toHaveLength(36);
    expect(presetStacks('early', all).stacks).toHaveLength(36);
    const early = presetStacks('early', all.slice(0, 30));
    expect(early.notFit).toBe(6);
    expect(early.stacks.slice(0, 4).map((s) => s.item)).toEqual(['stone_pickaxe', 'stone_axe', 'stone_shovel', 'stone_sword']);
    const e = presetStacks('early', all).stacks;
    expect(e.filter((s) => ['cobblestone', 'cobbled_deepslate', 'dirt', 'andesite', 'gravel', 'diorite', 'granite', 'tuff'].includes(s.item)).length).toBeGreaterThanOrEqual(10);
    expect(e.some((s) => s.item === 'rotten_flesh') && e.some((s) => s.item === 'string')).toBe(true);
    // split: every stackable kind in two stacks or more
    const split = presetStacks('split', all).stacks;
    const kinds = new Map<string, number>();
    for (const s of split) kinds.set(s.item, (kinds.get(s.item) ?? 0) + 1);
    for (const [k, n] of kinds) if (!k.startsWith('stone_') && k !== 'flint') expect([k, n >= 2]).toEqual([k, true]);
  });
  it('rockets: 7 stacks, 422 loose; fullbar: cobblestone in the main inventory only, both full', () => {
    const r = presetStacks('rockets', all).stacks;
    expect(r.filter((s) => s.item === 'firework_rocket').reduce((a, s) => a + s.count, 0)).toBe(422);
    expect(r.filter((s) => s.item === 'firework_rocket')).toHaveLength(7);
    expect(r).toHaveLength(36);
    const f = presetStacks('fullbar', all).stacks;
    expect(f).toHaveLength(36);
    expect(f.filter((s) => s.item === 'cobblestone').every((s) => s.slot >= 9)).toBe(true);
    expect(f.filter((s) => s.item === 'cobblestone')).toHaveLength(1);
    expect(f.filter((s) => s.slot < 9).every((s) => s.count === 1)).toBe(true);
  });
});

describe('the plans', () => {
  it('a preset clears and fills only the free and restorable slots: keep into an empty one, never a kept one', () => {
    const s = liveLike();
    const snap = snapshotInv(s);
    const plan = planPreset(snap, 'full');
    const kept = new Set([0, 1, 4, 9, 10, 11, 12]);
    const food = new Set([3, 13]); // Track T3 follow-up: the cooked beef and the bread stay where they are
    expect(plan.free).toHaveLength(27);
    expect(plan.fed.map((f) => f.slot)).toEqual([3, 13]);
    for (const c of plan.commands) {
      expect(kept.has(c.slot) || food.has(c.slot)).toBe(false);
      const empty = !snap.slots[c.slot];
      expect(c.command.includes(' keep ')).toBe(empty);
    }
    expect(plan.commands).toHaveLength(27);
  });

  it('Track T3 follow-up: no preset takes the food below what the bot carried (fullbar gave none on the Realm), and the restore is still exact', async () => {
    for (const p of INV_PRESETS) {
      const s = liveLike();
      s.put(8, 'golden_carrot', 20); // food in the hotbar too (fullbar fills the hotbar with odds)
      s.put(30, 'rotten_flesh', 4); // bad food: no food the bot eats, cleared as before
      const before = inventoryFoodPoints(s.slots);
      const snap = snapshotInv(s);
      const plan = planPreset(snap, p);
      expect(plan.fed.map((f) => f.name)).toEqual(['cooked_beef', 'golden_carrot', 'bread']);
      for (const c of plan.commands) expect((await s.run(c.command)).ok).toBe(true);
      expect([p, inventoryFoodPoints(s.slots) >= before]).toEqual([p, true]);
      for (const k of [3, 8, 13]) expect(s.cells[k]?.name).toBe(snap.slots[k]!.name);
      // the bot eats meanwhile: the restore gives the saved count back
      s.cells[3] = { ...s.cells[3]!, count: 20 };
      for (const c of planRestore(snap, s).commands) await s.run(c);
      expect(restoreMismatches(snap, s)).toEqual([]);
    }
  });

  it('the restore of an untouched preset puts every restorable slot back; nothing on the kept ones', async () => {
    const s = liveLike();
    const snap = snapshotInv(s);
    const before = carriedCounts(s);
    for (const c of planPreset(snap, 'early').commands) expect((await s.run(c.command)).ok).toBe(true);
    expect(freeOf(s)).toBe(0);
    const r = planRestore(snap, s);
    for (const c of r.commands) await s.run(c);
    expect(restoreMismatches(snap, s)).toEqual([]);
    expect(countsDiff(before, carriedCounts(s))).toEqual({});
    expect(r.notes).toEqual([]);
    expect(r.commands.every((c) => /slot\.(hotbar|inventory) /.test(c))).toBe(true);
    // the potion's metadata comes back as data
    expect(r.commands.some((c) => c.endsWith('potion 1 5'))).toBe(true);
    // Track T3 follow-up: every slot to empty before any saved stack (no saved partial stack beside a preset's stack of its item)
    const lastAir = r.commands.map((c) => c.endsWith(' air')).lastIndexOf(true);
    const firstSet = r.commands.findIndex((c) => !c.endsWith(' air'));
    expect(lastAir).toBeGreaterThanOrEqual(0);
    expect(lastAir).toBeLessThan(firstSet);
  });

  it('what the chore did: a kept sword moved onto a cleared slot is never overwritten; rockets boxed are a note', async () => {
    const s = liveLike();
    const snap = snapshotInv(s);
    for (const c of planPreset(snap, 'rockets').commands) await s.run(c.command);
    // the hotbar puller swaps the sword (slot 0, kept) with slot 3 (the preset's); 128 loose rockets go into the fireworks box
    const sword = s.cells[0]!;
    s.cells[0] = s.cells[3]!;
    s.cells[3] = sword;
    s.cells[10] = { ...s.cells[10]!, raw: boxRaw([{ Name: 'firework_rocket', Count: 64 }, { Name: 'firework_rocket', Count: 64 }, { Name: 'firework_rocket', Count: 64 }, { Name: 'firework_rocket', Count: 64 }]) };
    s.cells[5] = null;
    s.cells[6] = null;
    const r = planRestore(snap, s);
    expect(r.commands.some((c) => c.includes('slot.hotbar 3 '))).toBe(false); // the sword's slot now
    expect(r.commands).toContain('/replaceitem entity @s slot.hotbar 0 air'); // the preset's stack on the sword's old slot
    expect(r.commands).toContain('/give @s cooked_beef 24');
    expect(r.notes.join('; ')).toMatch(/slot 3 holds netherite_sword \(enchanted\): 24 cooked_beef given by \/give/);
    expect(r.notes.join('; ')).toMatch(/netherite_sword \(enchanted\) moved from slot 0 to 3/);
    expect(r.notes.join('; ')).toMatch(/the boxes hold firework_rocket \+128/);
    for (const c of r.commands) await s.run(c);
    expect(s.cells[3]?.name).toBe('netherite_sword');
    const total = carriedCounts(s);
    expect(total.cooked_beef).toBe(24);
    expect(total.netherite_sword).toBe(1);
  });

  it('Track V1c: a box the room chore picked up into a lower slot: the displaced stack is given after every /replaceitem (before: it landed on a slot cleared next)', async () => {
    const s = liveLike();
    const snap = snapshotInv(s);
    for (const c of planPreset(snap, 'rockets').commands) await s.run(c.command);
    // the box step: the plain box (slot 12) set down, filled, picked up into slot 3 (the beef's slot, freed by a stack it
    // took); slot 5 freed by the rockets it took
    s.cells[3] = s.cells[12]!;
    s.cells[12] = null;
    s.cells[5] = null;
    const r = planRestore(snap, s);
    const give = r.commands.findIndex((c) => c.startsWith('/give'));
    expect(give).toBeGreaterThanOrEqual(0);
    expect(r.commands.slice(give).every((c) => c.startsWith('/give'))).toBe(true);
    for (const c of r.commands) await s.run(c);
    expect(carriedCounts(s).cooked_beef).toBe(24);
  });

  it('the preset\'s stone tools go; the owner\'s worn stone pickaxe swapped with the preset\'s new one stays', async () => {
    const s = liveLike();
    const snap = snapshotInv(s);
    const before = carriedCounts(s);
    for (const c of planPreset(snap, 'early').commands) await s.run(c.command);
    expect(s.cells[2]).toMatchObject({ name: 'stone_pickaxe' }); // the preset's, Damage 0
    // the hotbar puller swaps the owner's (slot 1, Damage 3) with the preset's (slot 2)
    const own = s.cells[1]!;
    s.cells[1] = s.cells[2]!;
    s.cells[2] = own;
    const r = planRestore(snap, s);
    expect(r.commands).toContain('/replaceitem entity @s slot.hotbar 1 air'); // the preset's new one, on the kept slot
    expect(r.commands.some((c) => c.startsWith('/replaceitem entity @s slot.hotbar 2 '))).toBe(false);
    for (const c of r.commands) await s.run(c);
    const picks = s.cells.filter((c) => c?.name === 'stone_pickaxe');
    expect(picks).toHaveLength(1);
    expect(picks[0]!.raw).toEqual(damageRaw(3));
    expect(countsDiff(before, carriedCounts(s))).toEqual({});
  });

  it('a new tool (no NBT) used once ({Damage: 1}) is still the owner\'s: never emptied; gear no preset gives is never taken', () => {
    const s = liveLike();
    s.put(1, 'netherite_pickaxe', 1, plainRaw()); // set by a script or new: no NBT at all
    const snap = snapshotInv(s);
    s.put(1, 'netherite_pickaxe', 1, damageRaw(1)); // a dig
    s.put(30, 'diamond_axe', 1, damageRaw(0)); // gear not in the save and no preset's kind (picked up meanwhile)
    const r = planRestore(snap, s);
    expect(r.commands.some((c) => c.includes('slot.hotbar 1 '))).toBe(false);
    expect(r.commands.some((c) => c.includes('slot.inventory 21 '))).toBe(false);
    expect(r.notes).toEqual([]);
  });

  it('worn pieces changed and a kept item gone are notes; a worn elytra is still the same item', () => {
    const s = liveLike();
    const snap = snapshotInv(s);
    s.cells[9] = null; // the elytra worn now
    s.armor = [null, { name: 'elytra', count: 1, metadata: 0, networkId: 1 }, null, null];
    const r = planRestore(snap, s);
    expect(r.notes).toContain('elytra (elytra) from slot 9 is gone');
    expect(r.notes).toContain('worn head: netherite_helmet -> nothing');
    expect(r.notes).toContain('worn chest: nothing -> elytra');
    // a flown elytra (more damage) in its slot is still itself
    const t = liveLike();
    const snap2 = snapshotInv(t);
    t.put(9, 'elytra', 1, damageRaw(90));
    expect(planRestore(snap2, t).notes).toEqual([]);
  });
});

const flushAll = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('InvTest against a fake server', () => {
  const setup = (s = liveLike(), over: Partial<Omit<InvTestPorts, 'passes'>> & { passes?: PassLike[] } = {}) => {
    let file: InvSnapshot | undefined;
    const said: string[] = [];
    const order: string[] = [];
    const { passes: passes0, ...ports } = over;
    const passes: PassLike[] = passes0 ?? [];
    let held = 0;
    const logs: string[] = [];
    const announced: string[] = [];
    const clock = { t: Date.parse('2026-11-16T09:30:00Z') };
    const t = new InvTest({
      now: () => clock.t,
      sleep: (ms) => {
        clock.t += ms;
        return Promise.resolve();
      },
      log: { ...silentLogger, info: (m: string) => void logs.push(m), warn: (m: string) => void logs.push(`warn ${m}`) },
      announce: (m) => void announced.push(m),
      run: async (c) => {
        order.push(`cmd ${c.split(' ')[0]}`);
        return s.run(c);
      },
      inventory: () => s,
      busy: over.busy ?? (() => undefined),
      hold: over.hold ?? (() => {
        held++;
        return Promise.resolve(() => void held--);
      }),
      fireworksBox: () => 10,
      passes: () => passes,
      persist: (snap) => {
        file = snap ? (JSON.parse(JSON.stringify(snap)) as InvSnapshot) : undefined;
        return 'inv-saved.json';
      },
      load: () => file,
      settle: () => Promise.resolve(),
      ...ports,
    });
    const say = (m: string) => {
      said.push(m);
      order.push(`say ${m.slice(0, 30)}`);
    };
    return { s, t, said, order, say, passes, file: () => file, held: () => held, logs, announced, clock };
  };

  it('Track T3 follow-up 2: the preset items the room chore boxed come back out (only what the box gained); the box holds what it held', async () => {
    const s = liveLike();
    const boxes0 = { 10: shulkerContents(s.cells[10]!.raw), 11: shulkerContents(s.cells[11]!.raw) };
    const asked: { slot: number; want: Record<string, number> }[] = [];
    // the fake unbox: take `want` out of the box's NBT into the first free slots (as the box's take would)
    const unbox = (slot: number, want: Readonly<Record<string, number>>) => {
      asked.push({ slot, want: { ...want } });
      const c = shulkerContents(s.cells[slot]!.raw);
      const taken: Record<string, number> = {};
      for (const [k, v] of Object.entries(want)) {
        let n = Math.min(v, c[k] ?? 0);
        c[k] = (c[k] ?? 0) - n;
        taken[k] = n;
        while (n > 0) {
          const i = s.cells.findIndex((x) => !x);
          const m = Math.min(64, n);
          s.put(i, k, m);
          n -= m;
        }
      }
      const items = Object.entries(c).flatMap(([k, v]) => Array.from({ length: Math.ceil(v / 64) }, (_, j) => ({ Name: k, Count: Math.min(64, v - j * 64) }))).filter((x) => x.Count > 0);
      s.cells[slot] = { ...s.cells[slot]!, raw: slot === 11 ? namedRaw('bot_loot', items) : boxRaw(items) };
      return Promise.resolve({ taken });
    };
    const { t, said, say } = setup(s, { unbox });
    await t.start('early', say);
    // the room chore boxed 192 cobblestone and 20 coal into bot_loot, 64 rockets into the fireworks box
    s.cells[11] = { ...s.cells[11]!, raw: namedRaw('bot_loot', [{ Name: 'bone', Count: 12 }, { Name: 'cobblestone', Count: 64 }, { Name: 'cobblestone', Count: 64 }, { Name: 'cobblestone', Count: 64 }, { Name: 'coal', Count: 20 }]) };
    s.cells[10] = { ...s.cells[10]!, raw: boxRaw([{ Name: 'firework_rocket', Count: 64 }, { Name: 'firework_rocket', Count: 64 }, { Name: 'firework_rocket', Count: 64 }]) };
    await t.restore(say);
    expect(asked.map((a) => a.want)).toEqual([{ firework_rocket: 64 }, { cobblestone: 192, coal: 20 }]);
    expect(shulkerContents(s.cells[10].raw)).toEqual(boxes0[10]);
    expect(shulkerContents(s.cells[11].raw)).toEqual(boxes0[11]);
    expect(restoreMismatches(t.saved() ?? snapshotInv(liveLike()), s)).toEqual([]);
    expect(said.at(-1)).toMatch(/^test inv restore: .*took back out of the boxes cobblestone 192, firework_rocket 64, coal 20/);
    expect(said.at(-1)).not.toMatch(/the boxes hold/);
    expect(t.saved()).toBeUndefined();
  });

  it('Track T3 follow-up 2: without the unbox port (or nothing taken) the boxed items stay and are said', async () => {
    const s = liveLike();
    const { t, said, say } = setup(s, { unbox: () => Promise.resolve({ taken: {}, why: 'no free cell for the box next to the bot' }) });
    await t.start('early', say);
    s.cells[11] = { ...s.cells[11]!, raw: namedRaw('bot_loot', [{ Name: 'bone', Count: 12 }, { Name: 'coal', Count: 20 }]) };
    await t.restore(say);
    expect(said.at(-1)).toMatch(/took back out of the boxes nothing; still in the boxes coal 20 \(no free cell for the box next to the bot\)/);
  });

  it('says what stays before the first slot is cleared, fills, saves to the file; the restore gives it back and removes the file', async () => {
    const { s, t, said, order, say, file, held } = setup();
    const before = carriedCounts(s);
    await t.start('full', say);
    expect(said[0]).toMatch(/^test inv full: saved; 27 slots cleared and given back exactly by !test inv restore, 7 stay in place \(netherite_sword \(enchanted\), stone_pickaxe, firework_rocket \(rocket flight 3\), elytra, green_shulker_box, undyed_shulker_box \(box "bot_loot"\), green_shulker_box\); the food stays \(2 stacks\)/);
    const firstReplace = order.findIndex((o) => o === 'cmd /replaceitem');
    const firstSay = order.findIndex((o) => o.startsWith('say '));
    expect(firstSay).toBeLessThan(firstReplace);
    expect(said[1]).toMatch(/^test inv full: 23 -> 0 free in/);
    expect(freeOf(s)).toBe(0);
    expect(file()?.preset).toBe('full');
    expect(held()).toBe(0);
    for (const k of [0, 1, 4, 9, 10, 11, 12]) expect(s.cells[k]?.name).toBe(before && snapshotInv(liveLike()).slots[k]!.name);
    // a second preset waits for the restore
    await t.start('early', say);
    expect(said[2]).toMatch(/is not back yet: !test inv restore first/);
    await t.restore(say);
    expect(said[3]).toMatch(/^test inv restore: 0 -> 23 free in .*every slot as saved/);
    expect(countsDiff(before, carriedCounts(s))).toEqual({});
    expect(file()).toBeUndefined();
    await t.restore(say);
    expect(said[4]).toBe('test inv: nothing saved to restore');
  });

  it('refuses while something runs; nothing is sent; every refusal is said at once and is one INFO line with its reason', async () => {
    let busy: string | undefined = 'a flight runs';
    const { s, t, said, say, logs } = setup(liveLike(), { busy: () => busy });
    void t.start('early', say);
    expect(said).toEqual(['test inv: not now: a flight runs']); // synchronous: the panel's command route sees it
    await t.restore(say);
    expect(said[1]).toBe('test inv: nothing saved to restore');
    busy = undefined;
    await t.start('early', say);
    s.sent.length = 0;
    busy = 'a flight runs';
    void t.restore(say);
    expect(said.at(-1)).toBe('test inv: not now: a flight runs');
    busy = undefined;
    await t.start('full', say);
    expect(said.at(-1)).toMatch(/is not back yet: !test inv restore first/);
    expect(s.sent).toEqual([]);
    expect(logs.filter((l) => l.startsWith('test inv: refused: '))).toEqual([
      'test inv: refused: test inv: not now: a flight runs',
      'test inv: refused: test inv: nothing saved to restore',
      'test inv: refused: test inv: not now: a flight runs',
      expect.stringMatching(/^test inv: refused: test inv: the inventory saved for early at .* is not back yet/),
    ]);
  });

  it('Track T3 follow-up: a restore during a fight waits for the guard to hand back (said at once), then runs; a second restore meanwhile is refused', async () => {
    let fight = 0;
    const { s, t, said, say, file } = setup(liveLike(), { restoreBlock: () => (fight > 0 ? (fight--, { line: 'the fight', wait: true }) : undefined) });
    await t.start('early', say);
    fight = 6; // three seconds of polls
    const p = t.restore(say);
    expect(said.at(-1)).toBe('test inv restore: waiting for the fight to end (at most 3 min), then the restore');
    expect(t.restoring).toBe(true);
    await t.restore(say);
    expect(said.at(-1)).toBe('test inv restore: a restore already waits for the fight to end');
    await p;
    expect(said.at(-1)).toMatch(/^test inv restore: 0 -> \d+ free in .*every slot as saved/);
    expect(file()).toBeUndefined();
    expect(restoreMismatches(snapshotInv(liveLike()), s)).toEqual([]);
  });

  it('Track T3 follow-up: the wait is bounded: still fighting after RESTORE_WAIT_MS, it says so and keeps the save; nothing sent', async () => {
    const { s, t, said, say, file, clock } = setup(liveLike(), { restoreBlock: () => ({ line: 'guard', wait: true }) });
    await t.start('split', say); // (the block is the restore's: a preset reads busy())
    s.sent.length = 0;
    const t0 = clock.t;
    await t.restore(say);
    expect(clock.t - t0).toBeGreaterThanOrEqual(RESTORE_WAIT_MS);
    expect(said.at(-1)).toBe('test inv restore: guard still after 3 min; the save is kept (!test inv restore again)');
    expect(s.sent).toEqual([]);
    expect(file()).toBeDefined();
    expect(t.restoring).toBe(false);
  });

  it('Track T3 follow-up: a refusing block (a series, a flight, the owner\'s command) is not waited for', async () => {
    const { t, said, say } = setup(liveLike(), { restoreBlock: () => ({ line: 'goto runs (!stop)', wait: false }) });
    await t.start('split', say);
    await t.restore(say);
    expect(said.at(-1)).toBe('test inv: not now: goto runs (!stop)');
  });

  it('Track T3 follow-up: past the time limit the save is restored on its own, said in chat; a failed one waits AUTO_RETRY_MS', async () => {
    let no: string | undefined = 'testMode is off (!set testMode on)';
    const { t, say, file, clock, announced, logs } = setup(liveLike(), { canCommand: () => Promise.resolve(no) });
    await t.start('rockets', say);
    t.tick();
    expect(announced).toEqual([]);
    clock.t += INV_SAVE_LIMIT_MS;
    t.tick();
    expect(announced[0]).toBe('test inv: restoring the saved inventory on my own (the save waited 10 min, the limit is 10 min)');
    await flushAll();
    expect(announced[1]).toBe('test inv: no restore of my own: testMode is off (!set testMode on)');
    expect(file()).toBeDefined();
    t.tick(); // within AUTO_RETRY_MS: not again
    expect(announced).toHaveLength(2);
    no = undefined;
    clock.t += AUTO_RETRY_MS;
    t.tick();
    await flushAll();
    expect(announced.at(-1)).toMatch(/^test inv restore: 0 -> \d+ free in /);
    expect(file()).toBeUndefined();
    expect(logs.some((l) => l.startsWith('test inv: restoring on my own (the save waited'))).toBe(true);
  });

  it('Track T3 follow-up: a save from a file (a restart) counts from its time; the restore of its own takes it back', async () => {
    const a = setup(liveLike());
    await a.t.start('full', a.say);
    const saved = a.file()!;
    const b = setup(a.s, { load: () => saved, persist: () => 'inv-saved.json' });
    b.clock.t = Date.parse(saved.at) + INV_SAVE_LIMIT_MS - 1000;
    b.t.tick();
    expect(b.announced).toEqual([]);
    b.clock.t += 1000;
    b.t.tick();
    await flushAll();
    expect(b.announced.at(-1)).toMatch(/^test inv restore: 0 -> 23 free in .*every slot as saved/);
    expect(b.t.saved()).toBeUndefined();
  });

  it('Track T3 follow-up: restoreFirst (the food chore): no save false; a save: true and the restore runs on its own; true while it runs; false after', async () => {
    const { t, say, announced, file } = setup(liveLike());
    expect(t.restoreFirst('the food chore: 0 food points carried (< 10)')).toBe(false);
    await t.start('fullbar', say);
    expect(t.restoreFirst('the food chore: 0 food points carried (< 10)')).toBe(true);
    expect(announced[0]).toBe('test inv: restoring the saved inventory on my own (restore first: the food chore: 0 food points carried (< 10))');
    expect(t.restoreFirst('the food chore: 0 food points carried (< 10)')).toBe(true); // it runs: still wait
    expect(announced).toHaveLength(1);
    await flushAll();
    expect(announced.at(-1)).toMatch(/^test inv restore: 0 -> 23 free/);
    expect(file()).toBeUndefined();
    expect(t.restoreFirst('the food chore: 0 food points carried (< 10)')).toBe(false);
  });

  it('Track T3 follow-up: restoreFirst after a restore of its own failed a moment ago: false (the food chore goes on: food is never held)', async () => {
    const { t, say, clock } = setup(liveLike(), { canCommand: () => Promise.resolve('not an operator') });
    await t.start('early', say);
    expect(t.restoreFirst('food')).toBe(true);
    await flushAll();
    expect(t.saved()).toBeDefined();
    expect(t.restoreFirst('food')).toBe(false);
    clock.t += AUTO_RETRY_MS;
    expect(t.restoreFirst('food')).toBe(true);
  });

  it('Track T3 follow-up: waiting() names the save while one waits, logs each mover once a save', async () => {
    const { t, say, logs } = setup(liveLike());
    expect(t.waiting('the home chore')).toBeUndefined();
    await t.start('early', say);
    const line = t.waiting('the home chore');
    expect(line).toBe('a !test inv early save from 09:30:00 UTC waits for its restore');
    t.waiting('the home chore');
    t.waiting('the stash step');
    expect(logs.filter((l) => l.includes(' held until the restore '))).toEqual([
      `test inv: the home chore held until the restore (${line})`,
      `test inv: the stash step held until the restore (${line})`,
    ]);
    await t.restore(say);
    expect(t.waiting('the home chore')).toBeUndefined();
  });

  it('the hold cannot be had (something keeps control): nothing is sent, nothing saved', async () => {
    const { s, t, said, say, file } = setup(liveLike(), { hold: () => Promise.resolve('flee keeps control') });
    await t.start('full', say);
    expect(said).toEqual(['test inv: not now: flee keeps control']);
    expect(s.sent).toEqual([]);
    expect(file()).toBeUndefined();
    expect(t.busy).toBe(false);
  });

  it('the server and the model disagree on a count: nothing cleared, nothing saved', async () => {
    const s = liveLike();
    s.lag.bread = 2;
    const { t, said, say, file } = setup(s);
    await t.start('early', say);
    expect(said).toEqual(['test inv: nothing cleared: the server counts 9 bread, my inventory 7; try again in a moment']);
    expect(s.sent.every((c) => c.startsWith('/clear') && c.endsWith(' -1 0'))).toBe(true);
    expect(file()).toBeUndefined();
  });

  it('an item the server does not know by that name stays in place', async () => {
    const s = liveLike();
    s.put(22, 'not_an_item', 5);
    const { t, say } = setup(s);
    await t.start('full', say);
    expect(s.cells[22]?.name).toBe('not_an_item');
    expect(t.saved()?.slots[22]?.kept).toBe('not a command item');
  });

  it('a refused command stops the fill; the save stays for the restore; the first one refused: nothing to restore', async () => {
    const s = liveLike();
    const { t, said, say, file } = setup(s);
    s.failAt = 6 + 5; // the six /clear counts, then five slots
    await t.start('early', say);
    expect(said[1]).toMatch(/^test inv early: stopped after 5 of \d+ commands: .*permission.*!test inv restore gives the saved inventory back/);
    expect(file()).toBeDefined();
    s.failAt = -1;
    await t.restore(say);
    expect(restoreMismatches(t.saved() ?? file() ?? snapshotInv(liveLike()), s)).toEqual([]);
    const u = setup(liveLike());
    u.s.failAt = 6;
    await u.t.start('early', u.say);
    expect(u.said[1]).toMatch(/^test inv early: nothing cleared: /);
    expect(u.file()).toBeUndefined();
  });

  it('a pickup into an empty slot meanwhile is not overwritten (keep), said; restore sweep runs the sweep first, its failure is fine', async () => {
    const s = liveLike();
    const { t, said, say } = setup(s);
    const run0 = s.run;
    let n = 0;
    (s as { run: typeof s.run }).run = async (c) => {
      if (c.startsWith('/replaceitem') && n++ === 0) s.put(26, 'apple', 3); // a pickup lands in slot 26 (empty at the save)
      return run0(c);
    };
    await t.start('full', say);
    expect(said[1]).toMatch(/1 slot taken meanwhile, not filled \(slot\.inventory 17 keep /);
    expect(s.cells[26]?.name).toBe('apple');
    s.sent.length = 0;
    await t.restore(say, { sweep: true });
    expect(s.sent[0]).toBe(SWEEP);
    expect(said[2]).toMatch(/^test inv restore: /);
    expect(s.cells[26]).toBeNull(); // empty at the save
  });

  it('no sweep while a kept item of the save is missing (it may lie on the ground)', async () => {
    const s = liveLike();
    const { t, said, say } = setup(s);
    await t.start('early', say);
    s.cells[1] = null; // the owner's pickaxe left the inventory
    s.sent.length = 0;
    await t.restore(say, { sweep: true });
    expect(s.sent).not.toContain(SWEEP);
    expect(said[2]).toMatch(/no sweep: stone_pickaxe not carried \(on the ground nearby\?\), the items on the ground stay; stone_pickaxe \(gear\) from slot 1 is gone/);
  });

  it('status: what the room chore did since the preset, from its passes', async () => {
    const passes: PassLike[] = [{ freeBefore: 0, freeAfter: 2, ms: 900, steps: [{ ok: true, line: 'inventory: merged 3 bread (slot 9 -> 3)' }] }];
    const { s, t, say } = setup(liveLike(), { passes });
    expect(t.status()).toBe('test inv: no preset on');
    await t.start('split', say);
    expect(t.status()).toMatch(/^test inv split \(\d+ s\): 0 -> 0 free; restored on my own in 10 min; no room chore pass yet; changed nothing$/);
    passes.push({ freeBefore: 0, freeAfter: 8, ms: 4100, steps: [{ ok: true, line: 'inventory: merged 30 cobblestone (slot 20 -> 19)' }, { ok: true, line: 'inventory: dropped 434 cobblestone (dropStone 64)' }] });
    s.cells[30] = null;
    const line = t.status();
    expect(line).toMatch(/room chore 1 pass \(0 -> 8 in 4\.1 s\): merged 30 cobblestone \(slot 20 -> 19\); dropped 434 cobblestone \(dropStone 64\); changed /);
    expect(wireSize(line)).toBeLessThanOrEqual(400);
  });
});

describe('arguments and lines', () => {
  it('parses presets, restore [sweep], status', () => {
    expect(parseInvArgs([])).toEqual({ kind: 'status' });
    expect(parseInvArgs(['status'])).toEqual({ kind: 'status' });
    expect(parseInvArgs(['Early'])).toEqual({ kind: 'preset', preset: 'early' });
    expect(parseInvArgs(['restore'])).toEqual({ kind: 'restore', sweep: false });
    expect(parseInvArgs(['restore', 'sweep'])).toEqual({ kind: 'restore', sweep: true });
    expect(parseInvArgs(['big'])).toEqual({ error: 'usage: !test inv full | early | split | rockets | fullbar | restore [sweep] | status' });
  });
  it('lines are cut to the byte limit at a word', () => {
    const l = fitLine(`a ${'§aword '.repeat(200)}`);
    expect(wireSize(l)).toBeLessThanOrEqual(400);
    expect(l.endsWith('...')).toBe(true);
  });
});
