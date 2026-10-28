// Wave 11 Track AV: named boxes and boxing at the chests (skills/home/boxing.ts, the `box` steps of
// skills/home/unloader.ts, world/inventory.ts itemDisplayName, the boxed counts of !stock). Pure.
import { describe, expect, it } from 'vitest';
import { boxesLine, carriedBoxes, isKeepName, isKeptBox, keepBoxNameOf, keepNameOf, keptBoxesLine, keptBoxSlots, placesExactly, plainName, setKeepBoxName } from '../../../src/skills/home/boxing.ts';
import { stockLine } from '../../../src/skills/home/memory.ts';
import { planUnload, setCompactPlanner, unloadableStacks, type PlanChest, type UnloadSlot } from '../../../src/skills/home/unloader.ts';
import { ChestMemory, type ChestRecord } from '../../../src/world/cache/chests.ts';
import { itemDisplayName } from '../../../src/world/inventory.ts';

/** The wire item shapes seen on BDS 1.26.60 (bds-home, 2026-10-30). */
const named = (name: string, items: { name: string; count: number }[] = []) => ({
  extra: {
    has_nbt: true,
    nbt: {
      version: 1,
      nbt: {
        type: 'compound',
        name: '',
        value: {
          ...(items.length ? { Items: { type: 'list', value: { type: 'compound', value: items.map((i, k) => ({ Count: { type: 'byte', value: i.count }, Name: { type: 'string', value: `minecraft:${i.name}` }, Slot: { type: 'byte', value: k } })) } } } : {}),
          display: { type: 'compound', value: { Name: { type: 'string', value: name } } },
        },
      },
    },
  },
});
const unnamed = (items: { name: string; count: number }[] = []) =>
  items.length ? { extra: { has_nbt: true, nbt: { version: 1, nbt: { type: 'compound', name: '', value: { Items: { type: 'list', value: { type: 'compound', value: items.map((i) => ({ Count: { value: i.count }, Name: { value: `minecraft:${i.name}` } })) } } } } } } } : { extra: { has_nbt: 0, can_place_on: [], can_destroy: [] } };
const sand27 = Array.from({ length: 27 }, () => ({ name: 'sand', count: 64 }));

describe('named boxes (boxing.ts, itemDisplayName)', () => {
  it('reads the display name from the item NBT (verified shape) and compares it without case, colour and spaces', () => {
    expect(itemDisplayName(named('bot_loot'))).toBe('bot_loot');
    expect(itemDisplayName(named('§6Bot_Loot', sand27))).toBe('§6Bot_Loot');
    expect(itemDisplayName(unnamed())).toBeUndefined();
    expect(itemDisplayName(undefined)).toBeUndefined();
    expect(plainName(' §6§lBot_Loot ')).toBe('bot_loot');
    expect(isKeepName('§6Bot_Loot')).toBe(true);
    expect(isKeepName('bot loot')).toBe(false);
    expect(isKeepName('Mine', 'mine')).toBe(true);
    expect(keepNameOf(undefined)).toBe('bot_loot');
    expect(keepNameOf('  ')).toBe('bot_loot');
    expect(isKeptBox('undyed_shulker_box', named('BOT_LOOT'))).toBe(true);
    expect(isKeptBox('red_shulker_box', named('bot_loot', sand27))).toBe(true);
    expect(isKeptBox('chest', named('bot_loot'))).toBe(false); // a named chest item is no box
    expect(isKeptBox('undyed_shulker_box', unnamed())).toBe(false);
  });

  it('carried boxes: named, spares, the flight kit; the drop keep set and its line', () => {
    const slots = [{ name: 'undyed_shulker_box', count: 1 }, { name: 'undyed_shulker_box', count: 1 }, { name: 'stone', count: 64 }, { name: 'red_shulker_box', count: 1 }, { name: 'undyed_shulker_box', count: 1 }];
    const raws: unknown[] = [named('bot_loot'), unnamed(), undefined, named('§cbot_loot', sand27), unnamed([{ name: 'firework_rocket', count: 64 }])];
    const inv = { slots, rawItem: (_w: number, s: number) => raws[s] };
    const b = carriedBoxes(inv);
    expect(b.map((x) => `${x.slot}:${x.named ? 'named' : x.flightKit ? 'kit' : x.used ? 'full' : 'spare'}`)).toEqual(['0:named', '1:spare', '3:named', '4:kit']);
    expect(b[2]!.contents).toEqual({ sand: 1728 });
    expect([...keptBoxSlots(inv)]).toEqual([0, 3]);
    expect(keptBoxesLine(2)).toBe('kept 2 bot_loot boxes');
    expect(keptBoxesLine(1, '§6Mine')).toBe('kept 1 mine box');
    const task = {};
    expect(keepBoxNameOf(task)).toBe('bot_loot');
    setKeepBoxName(task, () => 'Loot');
    expect(keepBoxNameOf(task)).toBe('loot');
  });

  it('placesExactly: a hotbar box (selected), or the first main-inventory box of its colour when the hotbar has none', () => {
    const box = { name: 'undyed_shulker_box', count: 1 };
    const inv = Array.from({ length: 36 }, () => null as { name: string; count: number } | null);
    inv[12] = box;
    inv[20] = box;
    expect(placesExactly(inv, 12)).toBe(true);
    expect(placesExactly(inv, 20)).toBe(false);
    inv[3] = box;
    expect(placesExactly(inv, 3)).toBe(true);
    expect(placesExactly(inv, 12)).toBe(false);
  });

  it('!boxes: spares carried and in the chests, the named boxes carried', () => {
    const rec = (x: number, empty: number, extra: Partial<ChestRecord> = {}): ChestRecord => ({ x, y: 0, z: 0, kind: 'chest', size: 27, free: 20, stacks: 7, contents: {}, room: {}, boxes: { empty, full: 0 }, double: false, readAt: 1, ...extra });
    const slots = [{ name: 'undyed_shulker_box', count: 1 }, { name: 'undyed_shulker_box', count: 1 }, { name: 'undyed_shulker_box', count: 1 }];
    const raws: unknown[] = [named('bot_loot'), named('bot_loot', sand27), unnamed()];
    const carried = carriedBoxes({ slots, rawItem: (_w, s) => raws[s] });
    expect(boxesLine(carried, [rec(1, 3), rec(2, 0), rec(3, 1, { unreachable: 'no path' })])).toBe('boxes: 4 spare (1 carried, 3 in chest 1 0 0); carrying 2 bot_loot boxes (1 empty, 1 holding 1728 sand)');
    expect(boxesLine([], [])).toBe('boxes: no spare empty box known (carried or in the chests I know); no bot_loot box carried');
  });
});

let n = 0;
const chest = (o: Partial<PlanChest> & { key?: string }): PlanChest => {
  const i = n++;
  return { key: o.key ?? `c${i}`, pos: o.pos ?? { x: i * 3, y: 0, z: 0 }, kind: o.kind ?? 'chest', label: o.label, free: o.free ?? 27, contents: o.contents ?? {}, room: o.room ?? {}, boxes: o.boxes ?? { empty: 0, full: 0 }, ...(o.inBoxes ? { inBoxes: o.inBoxes } : {}) };
};
const s = (slot: number, name: string, count = 64, extra: Partial<UnloadSlot> = {}): UnloadSlot => ({ slot, name, count, ...extra });
const stacks = (from: number, k: number, name: string): UnloadSlot[] => Array.from({ length: k }, (_, i) => s(from + i, name));

describe('unloader: box steps (Track AV)', () => {
  it("the owner's cobblestone: a full chest of it, spares in another chest: box its loose stacks, then the bot's go there", () => {
    const cobble = chest({ key: 'cobble', free: 0, contents: { cobblestone: 27 * 64 } });
    const spares = chest({ key: 'spares', free: 24, contents: { undyed_shulker_box: 3 }, boxes: { empty: 3, full: 0 } });
    const p = planUnload(stacks(0, 10, 'cobblestone'), [cobble, spares], { reserve: 0 });
    expect(p.steps).toEqual([{ kind: 'box', item: 'cobblestone', chest: 'cobble', stacks: 27, produce: 0, spare: 'spares' }]);
    // after the box: 26 free slots in the cobblestone chest, all 10 stacks go there (not to the emptier spare chest)
    expect(p.moves.every((m) => m.to === 'cobble' && m.rule === 'same')).toBe(true);
    expect(p.moves.reduce((a, m) => a + m.count, 0)).toBe(640);
    expect(p.overflow).toEqual([]);
    expect(p.blocked).toEqual([]);
  });

  it('sand: the chest has 10 free slots, the bot carries 20 stacks: one box (17 loose stacks topped up with 10 of the bot) is enough; a carried spare first', () => {
    const sand = chest({ key: 'sand', free: 10, contents: { sand: 17 * 64 } });
    const spares = chest({ key: 'spares', free: 24, boxes: { empty: 3, full: 0 }, contents: { undyed_shulker_box: 3 } });
    const p = planUnload([...stacks(0, 20, 'sand'), s(30, 'undyed_shulker_box', 1, { boxUsed: 0 }), s(31, 'undyed_shulker_box', 1, { boxUsed: 0 })], [sand, spares], { reserve: 0 });
    expect(p.steps).toEqual([{ kind: 'box', item: 'sand', chest: 'sand', stacks: 17, produce: 10, spare: 'carried' }]);
    // 10 stacks boxed from the inventory, 10 into the chest's 26 free slots; one carried box kept for the stash step, none sent away
    expect(p.moves.filter((m) => m.name === 'sand').reduce((a, m) => a + m.count, 0)).toBe(640);
    expect(p.kept).toContainEqual({ name: 'undyed_shulker_box', count: 1, why: 'stash_box' });
    expect(p.moves.filter((m) => m.name === 'undyed_shulker_box')).toEqual([]);
  });

  it('named boxes: kept, listed for emptying when they hold items, never spares; with one carried no unnamed box is held for the stash', () => {
    const sand = chest({ key: 'sand', free: 0, contents: { sand: 27 * 64 } });
    const slots = [s(0, 'undyed_shulker_box', 1, { named: true, boxUsed: 27 }), s(1, 'undyed_shulker_box', 1, { named: true, boxUsed: 0 }), s(2, 'undyed_shulker_box', 1, { boxUsed: 0 }), ...stacks(3, 5, 'sand')];
    const p = planUnload(slots, [sand], { reserve: 0 });
    expect(p.emptyNamed).toEqual([0]);
    expect(p.kept).toEqual([{ name: 'undyed_shulker_box', count: 2, why: 'named_box' }]);
    // the unnamed one is a spare: it boxes the chest's sand
    expect(p.steps).toEqual([{ kind: 'box', item: 'sand', chest: 'sand', stacks: 27, produce: 0, spare: 'carried' }]);
    expect(p.moves.some((m) => m.slot === 0 || m.slot === 1 || m.slot === 2)).toBe(false);
    // the autoUnload trigger counts the named box holding items (it is emptied at unload), not the fireworks box
    expect(unloadableStacks([s(0, 'undyed_shulker_box', 1, { named: true, boxUsed: 3 }), s(1, 'red_shulker_box', 1, { flightKit: true, boxUsed: 2 })]).fullBoxes).toBe(1);
  });

  it('no spare anywhere, or a chest holding only boxes and no free slot: blocked, the rest goes by the other rules or is left', () => {
    const cobble = chest({ key: 'cobble', free: 0, contents: { cobblestone: 27 * 64 } });
    const p = planUnload(stacks(0, 3, 'cobblestone'), [cobble], { reserve: 0 });
    expect(p.steps).toEqual([]);
    expect(p.blocked).toEqual([{ item: 'cobblestone', chest: 'cobble', why: 'no_spare' }]);
    expect(p.overflow.reduce((a, o) => a + o.count, 0)).toBe(192);
    const boxed = chest({ key: 'boxed', free: 0, contents: { undyed_shulker_box: 27 }, inBoxes: { cobblestone: 27 * 27 * 64 }, boxes: { empty: 0, full: 27 } });
    const spares = chest({ key: 'spares', free: 0, contents: { undyed_shulker_box: 27 }, boxes: { empty: 27, full: 0 } });
    const q = planUnload(stacks(0, 3, 'cobblestone'), [boxed, spares], { reserve: 0 });
    expect(q.steps).toEqual([]);
    expect(q.blocked).toEqual([{ item: 'cobblestone', chest: 'boxed', why: 'boxes_full' }]);
  });

  it('a chest holding the item only in boxes is its home (rule 1); the produce alone is boxed when that chest is short of slots', () => {
    const home = chest({ key: 'home', free: 2, contents: { undyed_shulker_box: 3 }, inBoxes: { cobblestone: 3 * 27 * 64 }, boxes: { empty: 0, full: 3 } });
    const other = chest({ key: 'other', free: 27 });
    const spares = chest({ key: 'spares', free: 0, boxes: { empty: 5, full: 0 }, contents: { undyed_shulker_box: 5, stone: 22 * 64 } });
    const p = planUnload(stacks(0, 30, 'cobblestone'), [home, other, spares], { reserve: 0 });
    // 27 stacks into one box (2 free slots -> 1), then the last 3 stacks into a second one (the chest's last slot): all of it stays together
    expect(p.steps).toEqual([
      { kind: 'box', item: 'cobblestone', chest: 'home', stacks: 0, produce: 27, spare: 'spares' },
      { kind: 'box', item: 'cobblestone', chest: 'home', stacks: 0, produce: 3, spare: 'spares' },
    ]);
    expect(p.moves.filter((m) => m.name === 'cobblestone')).toEqual([]);
    expect(p.overflow).toEqual([]);
  });

  it('never boxes kept items, unstackable items or the reserve; at most maxBoxSteps; boxing off; the compact planner (Track AW)', () => {
    const food = chest({ key: 'food', free: 0, contents: { bread: 27 * 64 } });
    const spares = chest({ key: 'spares', free: 20, boxes: { empty: 9, full: 0 } });
    expect(planUnload([s(0, 'bread', 64)], [food, spares]).steps).toEqual([]);
    const picks = chest({ key: 'picks', free: 0, contents: { iron_pickaxe: 27 } });
    expect(planUnload([s(0, 'iron_pickaxe', 1)], [picks, spares]).steps).toEqual([]);
    const cobble = chest({ key: 'cobble', free: 0, contents: { cobblestone: 27 * 64 } });
    expect(planUnload([s(0, 'cobblestone', 16)], [cobble, spares]).steps).toEqual([]); // the reserve (16) is not unloaded
    const big = planUnload(stacks(0, 30, 'cobblestone'), [chest({ key: 'c', free: 0, contents: { cobblestone: 27 * 64 } }), spares], { reserve: 0, maxBoxSteps: 1 });
    expect(big.steps).toHaveLength(1);
    expect(planUnload(stacks(0, 3, 'cobblestone'), [cobble, spares], { reserve: 0, boxing: false }).steps).toEqual([]);
    expect(planUnload(stacks(0, 3, 'cobblestone'), [cobble, spares], { reserve: 0, noBox: new Set(['cobblestone']) }).steps).toEqual([]);
    // Track AW's planner fills plan.compact at the end (setCompactPlanner)
    const iron = chest({ key: 'iron', free: 0, contents: { iron_ingot: 27 * 64 } });
    setCompactPlanner((sl) => [{ kind: 'iron_ingot', count: sl.filter((x) => x.name === 'iron_ingot').length * 63 }]);
    try {
      const c = planUnload(stacks(0, 2, 'iron_ingot'), [iron, spares], { reserve: 0 });
      expect(c.compact).toEqual([{ kind: 'iron_ingot', count: 126 }]);
      expect(c.steps[0]).toMatchObject({ kind: 'box', item: 'iron_ingot' });
    } finally {
      setCompactPlanner(undefined);
    }
  });
});

describe('!stock counts boxed items (Track AV)', () => {
  it('loose plus inside the full boxes, per chest and in all', () => {
    const m = new ChestMemory();
    m.set({ x: 1, y: 0, z: 0, kind: 'chest', size: 27, free: 16, stacks: 11, contents: { cobblestone: 640, undyed_shulker_box: 1 }, room: {}, boxes: { empty: 0, full: 1 }, inBoxes: { cobblestone: 1728 }, double: false, readAt: 1 });
    m.set({ x: 5, y: 0, z: 0, kind: 'chest', size: 27, free: 26, stacks: 1, contents: { undyed_shulker_box: 1 }, room: {}, boxes: { empty: 0, full: 1 }, inBoxes: { sand: 64 }, double: false, readAt: 1 });
    expect(stockLine(m, 'cobblestone')).toBe('cobblestone: 2368 in chest 1 0 0 (1728 in boxes)');
    expect(stockLine(m, 'sand')).toBe('sand: 64 in chest 5 0 0 (all in boxes)');
    expect(stockLine(m, undefined)).toBe('stock: 2 containers: 2368 cobblestone, 64 sand, 2 undyed_shulker_box');
  });
});
