// Track AP (docs/panel.md "Inventory" and "Statuses"): the state builder's new blocks: the inventory
// (shape, durability percentages, shulker contents from a raw item, icon classes and colours that do
// not change), the statuses, the memory counts, and the payload size with a full inventory.
import { describe, expect, it } from 'vitest';
import { BOX_KINDS_MAX, boxContents, buildInventory, durabilityOf, ICON_CLASSES, iconClassOf, itemAbbr, itemColour, panelItem } from '../../../src/health/panel/inventory.ts';
import { buildMemory, chestRows, FOREST_LOGS } from '../../../src/health/panel/memory.ts';
import { buildPanelState, liteState } from '../../../src/health/panel/state.ts';
import type { ChestRecord } from '../../../src/world/cache/chests.ts';
import type { HerdMark } from '../../../src/world/cache/herds.ts';
import { BOX_27, fullInventory, fullSource, fullState, rawBox, stack } from './panel-fixtures.ts';

describe('inventory block', () => {
  it('has 36 slots, 4 armour slots, the offhand, the selected slot, armour points and free slots', () => {
    const inv = buildInventory(fullInventory());
    expect(inv.slots).toHaveLength(36);
    expect(inv.slots.every((s) => s !== null)).toBe(true);
    expect(inv.free).toBe(0);
    expect(inv.selected).toBe(2);
    expect(inv.armour.map((a) => a?.name)).toEqual(['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']);
    expect(inv.armourPoints).toBe(15); // iron: 2 + 6 + 5 + 2
    expect(inv.offhand).toMatchObject({ name: 'shield', icon: 'shield', dur: { left: 300, max: 336, pct: 89 } });
    expect(inv.slots[0]).toEqual({ name: 'iron_sword', count: 1, icon: 'sword', colour: '#c9ccd1', abbr: 'ISw', dur: { left: 125, max: 250, pct: 50 } });
    expect(inv.slots[9]).toEqual({ name: 'cobblestone', count: 64, icon: 'block', colour: '#8d8f93', abbr: 'Co' });
    expect(inv.slots.filter((s) => s?.name === 'cobblestone').reduce((n, s) => n + s!.count, 0)).toBe(20 * 64);
  });

  it('empty and missing windows: nulls, armour 0, every slot free', () => {
    const inv = buildInventory({ slots: [], selected: 0, window: () => undefined, rawItem: () => undefined });
    expect(inv.slots).toEqual(Array.from({ length: 36 }, () => null));
    expect(inv.armour).toEqual([null, null, null, null]);
    expect(inv.offhand).toBeNull();
    expect(inv.free).toBe(36);
    expect(inv.armourPoints).toBe(0);
    expect(panelItem(stack('dirt', 0))).toBeNull();
  });

  it('durability percentages from the NBT Damage and the tables', () => {
    expect(durabilityOf({ name: 'iron_sword', damage: 125 })).toEqual({ left: 125, max: 250, pct: 50 });
    expect(durabilityOf({ name: 'diamond_chestplate' })).toEqual({ left: 528, max: 528, pct: 100 });
    expect(durabilityOf({ name: 'minecraft:wooden_pickaxe', damage: 58 })).toEqual({ left: 1, max: 59, pct: 2 });
    expect(durabilityOf({ name: 'iron_boots', damage: 400 })).toEqual({ left: 0, max: 195, pct: 0 });
    expect(durabilityOf({ name: 'cobblestone', damage: 3 })).toBeUndefined();
    const inv = buildInventory(fullInventory());
    expect(inv.armour[3]!.dur).toEqual({ left: 5, max: 195, pct: 3 });
    expect(inv.slots[1]!.dur).toEqual({ left: 1500, max: 1561, pct: 96 });
    expect(inv.slots[4]!.dur).toBeUndefined(); // bread
  });

  it('shulker box contents from the raw item (NBT Items), biggest first, at most 8 kinds', () => {
    expect(boxContents(rawBox([['cobblestone', 64], ['iron_ingot', 10], ['cobblestone', 30]]))).toEqual({ known: true, stacks: 3, items: [['cobblestone', 94], ['iron_ingot', 10]], more: 0 });
    expect(boxContents(rawBox([]))).toEqual({ known: true, stacks: 0, items: [], more: 0 });
    expect(boxContents(undefined)).toEqual({ known: false, stacks: 0, items: [], more: 0 });
    const big = boxContents(rawBox(BOX_27));
    expect(big.items).toHaveLength(BOX_KINDS_MAX);
    expect(big.items[0]).toEqual(['test_item_number_0', 64]);
    expect(big.more).toBe(27 - BOX_KINDS_MAX);
    expect(big.stacks).toBe(27);
    const inv = buildInventory(fullInventory());
    expect(inv.slots[32]).toMatchObject({ name: 'red_shulker_box', icon: 'box', box: { known: true, items: [['cobblestone', 128], ['iron_ingot', 10]] } });
    expect(inv.slots[33]!.box).toEqual({ known: true, stacks: 0, items: [], more: 0 });
    expect(inv.slots[34]!.box!.known).toBe(false);
    expect(inv.slots[0]!.box).toBeUndefined();
  });

  it('icon classes', () => {
    const cases: [string, string, number?][] = [
      ['iron_sword', 'sword'], ['netherite_sword', 'sword'], ['diamond_pickaxe', 'pickaxe'], ['stone_axe', 'axe'], ['golden_shovel', 'shovel'], ['wooden_hoe', 'hoe'],
      ['bow', 'bow'], ['crossbow', 'bow'], ['shield', 'shield'], ['iron_helmet', 'helmet'], ['turtle_helmet', 'helmet'], ['leather_chestplate', 'chestplate'],
      ['chainmail_leggings', 'leggings'], ['diamond_boots', 'boots'], ['bread', 'food'], ['cooked_beef', 'food'], ['cake', 'food'], ['cobblestone', 'block'],
      ['oak_planks', 'block'], ['some_modded_thing', 'block', 12], ['iron_ore', 'ore'], ['deepslate_diamond_ore', 'ore'], ['raw_iron', 'ore'], ['iron_ingot', 'ore'],
      ['undyed_shulker_box', 'box'], ['lime_shulker_box', 'box'], ['chest', 'box'], ['water_bucket', 'bucket'], ['bucket', 'bucket'], ['milk_bucket', 'bucket'],
      ['torch', 'torch'], ['soul_torch', 'torch'], ['stick', 'item'], ['minecraft:feather', 'item'],
    ];
    for (const [name, cls, brid] of cases) expect([name, iconClassOf(name, brid)]).toEqual([name, cls]);
    for (const [name, , brid] of cases) expect(ICON_CLASSES).toContain(iconClassOf(name, brid));
  });

  it('colours: deterministic, #rrggbb, materials share one, different names differ', () => {
    const names = ['stick', 'feather', 'string', 'gunpowder', 'bone', 'arrow', 'wheat_seeds', 'leather', 'paper', 'book', 'slime_ball', 'ender_pearl'];
    const first = names.map(itemColour);
    expect(names.map(itemColour)).toEqual(first);
    expect(names.map((n) => itemColour(`minecraft:${n}`))).toEqual(first);
    for (const c of first) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(first).size).toBeGreaterThanOrEqual(names.length - 2);
    // pinned: the same on every machine and every release (FNV-1a hue)
    expect(itemColour('feather')).toBe(itemColour('feather'));
    expect([itemColour('feather'), itemColour('gunpowder'), itemColour('ender_pearl')]).toEqual(['#40ba71', '#49ca6c', '#3d49b3']);
    expect(itemColour('iron_sword')).toBe(itemColour('iron_chestplate'));
    expect(itemColour('diamond_pickaxe')).toBe('#4fd8d0');
    expect(itemColour('golden_apple')).toBe('#f2c43d');
  });

  it('abbreviations: 2 to 3 letters', () => {
    expect(['cobblestone', 'iron_sword', 'undyed_shulker_box', 'oak_log', 'diamond', 'minecraft:water_bucket', 'a', 'light_blue_stained_glass_pane'].map(itemAbbr)).toEqual(['Co', 'ISw', 'USB', 'OLo', 'Di', 'WBu', 'A', 'LBS']);
  });
});

describe('statuses', () => {
  it('the new blocks of a full state', () => {
    const s = fullState();
    expect(s.self).toMatchObject({ health: 17.5, food: 18, saturation: 4.8, weather: 'rain', day: 12, deaths: 1, timeOfDay: 6000, phase: 'day' });
    expect(s.self.lastDeath).toEqual({ cause: 'death.attack.mob', ts: '2026-10-29T18:00:00.000Z', messages: ['%entity.zombie.name'] });
    expect(s.job).toEqual({ name: 'get', state: 'active', line: 'getting 32 oak_log: 12/32 (fell 3 trees)', etaS: 95 });
    expect(s.stack.map((e) => `${e.state} ${e.name} ${e.priority}`)).toEqual(['active get 40', 'idle guard 60', 'held build 40']);
    expect(s.combat).toMatchObject({ fights: 14, kills: 12, retargets: 3, damageTaken: 37.5 });
    expect(s.memory!.chests).toEqual({ known: 9, reachable: 8, unreachable: 1, read: 7 });
    expect(s.planner).toMatchObject({ plans: 120, interims: 14, forwardMs: 230.4 });
    expect(s.conn).toMatchObject({ reconnects: 1, kicks: 0, version: '1.26.60' });
    expect(s.inventory!.slots).toHaveLength(36);
  });

  it('a held user process is still the job when nothing is active', () => {
    const s = fullState({ stack: () => [{ name: 'build', kind: 'user', priority: 40, state: 'paused', held: true, line: 'build wall: 40/120', etaS: undefined }] });
    expect(s.job).toEqual({ name: 'build', state: 'held', line: 'build wall: 40/120', etaS: null });
  });

  it('throwing or missing Track AP sources give null', () => {
    const boom = (): never => {
      throw new Error('x');
    };
    const s = fullState({ inventory: boom, saturation: boom, weather: boom, day: boom, deaths: boom, combat: boom, memory: boom, planner: boom, conn: boom });
    expect([s.inventory, s.combat, s.memory, s.planner, s.conn, s.self.saturation, s.self.weather, s.self.day, s.self.deaths, s.self.lastDeath]).toEqual(Array(10).fill(null));
    const broken = fullState({ inventory: () => ({ slots: [], selected: 0, window: boom, rawItem: boom }) });
    expect(broken.inventory).toBeNull();
    const bare = buildPanelState({ ...fullSource(), inventory: undefined, combat: undefined, memory: undefined, planner: undefined, conn: undefined });
    expect([bare.inventory, bare.combat, bare.memory, bare.planner, bare.conn]).toEqual([null, null, null, null, null]);
  });

  it('payload under 20 KB with 36 stacks, armour, offhand, boxes, 50 log lines and 30 chat lines', () => {
    const s = fullState();
    const full = Buffer.byteLength(JSON.stringify(s));
    const lite = liteState(s);
    const bytes = Buffer.byteLength(JSON.stringify(lite));
    const inv = Buffer.byteLength(JSON.stringify(s.inventory));
    console.log(`panel state: poll (?lite=1) ${bytes} bytes, full ${full} (inventory ${inv}, logs ${Buffer.byteLength(JSON.stringify(s.logs))}, settings ${Buffer.byteLength(JSON.stringify(s.settings))} full / ${Buffer.byteLength(JSON.stringify(lite.settings))} lite)`);
    expect(bytes).toBeLessThan(20_000); // what the page polls every 2 s
    expect(full).toBeLessThan(35_000); // GET /api/state for scripts: everything (Track BJ: foodReserve and seedReserve, about 300 bytes; Track AU: six flight settings with their descriptions ride along, about 1.5 KB; Track BD: the mineMode row, 175 bytes, took main's 27 957 over 28 000; Track BG: the closeTrapdoors row took it to 28 685; Track BF: five landing settings, about 750 bytes more; Track BI: four fall / clutch settings, about 650 bytes; Track BH: four glide settings, about 600 bytes; Track BH: four glide/ledge settings with the chat-style rows took it to 31 933; Track BL: five flight settings (flyHighCruise, flyDescent, flyRecheckBlocks, flyPreferRatio, flySiteSearch), about 900 bytes, took it to 33 857)
    expect(inv).toBeLessThan(6_000);
    expect(lite.settings.find((r) => r.key === 'guardRadius')).toEqual({ key: 'guardRadius', value: '16', source: 'default' });
    expect(Object.keys(lite)).not.toContain('commands');
    expect(lite.lite).toBe(true);
    expect(lite.inventory).toEqual(s.inventory);
  });
});

describe('memory counts', () => {
  const rec = (x: number, extra: Partial<ChestRecord> = {}): ChestRecord => ({ x, y: -60, z: 0, kind: 'chest', size: 27, free: 20, stacks: 7, contents: { coal: 20, oak_log: 64, dirt: 3 }, room: {}, boxes: { empty: 0, full: 0 }, double: false, readAt: 1, ...extra });
  const herd = (cx: number, wild: number, penned: number): HerdMark => ({ cx, cz: 0, x: cx * 16, y: -60, z: 0, wild: { cow: { adults: wild, babies: 1 } }, penned: { sheep: { adults: penned, babies: 0 } }, at: 1 });
  const mark = (name: string, x: number, seen = false) => ({ x, y: -60, z: 3, name, exposed: true, seen });

  it('chests (partners left out, unreachable, read), herds and animals, forests, seen ores', () => {
    const chests = [rec(0, { double: true, size: 54, partner: { x: 1, y: -60, z: 0 } }), rec(1), rec(5, { unreachable: 'no path', unreachableAt: 2 }), rec(9, { readAt: 0, size: 0, stacks: 0, contents: {} })];
    const marks = new Map<string, ReturnType<typeof mark>[]>([
      ['0,0', Array.from({ length: FOREST_LOGS }, (_, i) => mark('oak_log', i))],
      ['1,0', [mark('birch_log', 17), mark('stripped_oak_log', 18), ...Array.from({ length: FOREST_LOGS - 2 }, (_, i) => mark('birch_log', 20 + i))]],
      ['2,0', Array.from({ length: 10 }, (_, i) => mark('spruce_log', 33 + i))],
      ['40,0', Array.from({ length: 10 }, (_, i) => mark('spruce_log', 640 + i))], // too far
    ]);
    const seen = [mark('iron_ore', 3, true), mark('iron_ore', 4, true), mark('deepslate_diamond_ore', 5, true), mark('chest', 6, true)];
    const m = buildMemory(
      { chests: { all: () => chests }, herds: { all: () => [herd(0, 3, 2), herd(1, 0, 4)] }, marks: (cx, cz) => marks.get(`${cx},${cz}`) ?? [], known: (cx, cz) => marks.has(`${cx},${cz}`), seenMarks: () => seen },
      { x: 8, y: -60, z: 8 },
    );
    expect(m.chests).toEqual({ known: 3, reachable: 2, unreachable: 1, read: 2 });
    expect(m.herds).toBe(2);
    expect(m.animals).toBe(3 + 1 + 2 + 0 + 1 + 4);
    expect(m.forests).toBe(2); // column 1 has FOREST_LOGS - 1 unstripped logs; 40 is out of range
    expect(m.ores).toBe(3);
    expect(m.oreKinds).toEqual({ iron_ore: 2, deepslate_diamond_ore: 1 });
    expect(m.ms).toBeGreaterThanOrEqual(0);
    expect(buildMemory({}, undefined)).toMatchObject({ chests: { known: 0, reachable: 0, unreachable: 0, read: 0 }, herds: 0, animals: 0, forests: 0, ores: 0 });
  });

  it('chest rows for GET /api/chests: nearest first, partners out, top 4 kinds', () => {
    const rows = chestRows([rec(30), rec(2, { label: 'ores', partner: { x: 3, y: -60, z: 0 } }), rec(3), rec(10, { unreachable: 'path 40 blocks' })], { x: 0, y: -60, z: 0 });
    expect(rows.map((r) => r.x)).toEqual([2, 10, 30]);
    expect(rows[0]).toMatchObject({ label: 'ores', stacks: 7, size: 27, top: [['oak_log', 64], ['coal', 20], ['dirt', 3]], unreachable: null });
    expect(rows[1]!.unreachable).toBe('path 40 blocks');
  });
});
