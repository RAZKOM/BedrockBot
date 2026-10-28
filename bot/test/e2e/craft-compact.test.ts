// e2e (tag @bds), wave 11 Track AW (docs/crafting.md "Compaction"): `!compact` and the compaction step
// of `!unload` on bds-craft (flat, peaceful, truth pack). One afk-task bot in its own random area.
//   compact   45 raw iron and a crafting table carried -> `!compact` -> 5 raw iron blocks (truth), no raw iron
//   unload    home set; a truth-built chest 3 blocks away holding 26 stacks of raw iron (1 free slot), a
//             crafting table standing 2 blocks away (the home's); the bot carries 27 raw iron ->
//             `!chests scan`; the unload plan carries the `compact` step (planUnload); the installed
//             `compactRunner` (what Track AV's unload job calls before its moves) crafts at the standing
//             table and answers `compacted 27 raw_iron into 3 raw_iron_block`; then `!unload` moves the
//             blocks: the inventory holds 0 raw iron, the chest gained raw iron blocks
//   off       compactOnUnload off: `!unload` with 9 raw iron into a chest with room moves them as they are
// Env: CRAFT_BDS_HOST / CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER (craft-truth.ts), CRAFT_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planChests } from '../../src/skills/home/memory.ts';
import { compactRunner, planUnload, type UnloadSlot } from '../../src/skills/home/unloader.ts';
import { clearArea, E2E, FEET_Y, loadKit, prepareServer, privateArea, startCraftBot, teleport, truthLoaded, type CraftBot } from './craft-truth.ts';

const F = FEET_Y;

describe.skipIf(!E2E)('@bds craft: !compact and the compaction step of !unload (Track AW)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: CraftBot | undefined;
  const home = { x: area.x, y: F, z: area.z };
  const feet = { x: area.x + 0.5, y: F, z: area.z + 0.5 };
  const chest = { x: area.x + 3, y: F, z: area.z };
  const table = { x: area.x - 2, y: F, z: area.z };

  beforeAll(async () => {
    await prepareServer();
    const b = await startCraftBot('Compact');
    bot = b;
    b.settings.set('autoUnload', 'off');
    await teleport(b, feet);
    await clearArea(b.truth, { x: area.x, z: area.z }, 10, 6);
    b.task.home!.set(home);
  }, 180_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.ok('clear', [bot.name]).catch(() => undefined);
      await truthLoaded(bot.truth, 'container', [chest.x, chest.y, chest.z, 'clear']).catch(() => undefined);
      await clearArea(bot.truth, { x: area.x, z: area.z }, 10, 6).catch(() => undefined);
      await bot.stop();
    }
    console.log(`[craft-compact e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 120_000);

  it('!compact: 45 raw iron -> 5 raw iron blocks', async () => {
    const b = bot!;
    await loadKit(b, [['raw_iron', 45], ['crafting_table', 1]]);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!compact');
    expect(await b.reply((s) => s.startsWith('compacting ') || s.startsWith('compact: '), from)).toBe('compacting 45 raw_iron -> 5 raw_iron_block');
    const end = await b.reply((s) => s.startsWith('compacted ') || s.startsWith('compact: '), from, 60_000);
    notes.push(`compact: ${end} (${((Date.now() - t0) / 1000).toFixed(1)} s from the command)`);
    expect(end).toBe('compacted 45 raw_iron into 5 raw_iron_block');
    expect((await b.truth.craftinv(b.name)).counts).toEqual({ raw_iron_block: 5, crafting_table: 1 });
    const f2 = b.said.length;
    await b.command('!compact');
    expect(await b.reply((s) => s.startsWith('compact'), f2)).toMatch(/^compact: nothing to compact \(9 or more of raw_iron, /);
  }, 120_000);

  it('!unload into a chest with one free slot compacts the 27 raw iron first; the chest gains blocks', async () => {
    const b = bot!;
    await truthLoaded(b.truth, 'set', [chest.x, chest.y, chest.z, 'chest']);
    await b.truth.table(table);
    await b.truth.chestPut(chest, 'raw_iron', 64, 26);
    expect((await b.truth.box(chest)).free).toBe(1);
    await loadKit(b, [['raw_iron', 27]]);
    let from = b.said.length;
    await b.command('!chests clear'); // a chest read less than 10 min ago is not read again by a scan
    await b.reply((s) => s.startsWith('chests: forgot'), from);
    from = b.said.length;
    await b.command('!chests scan');
    const scan = await b.reply((s) => /^chests: \d+ within /.test(s), from, 120_000);
    notes.push(`scan: ${scan}`);
    expect(b.home.memory().get(chest)?.free).toBe(1);
    // the plan carries the compaction step; the runner (installed by commands-craft.ts) crafts it, as the unload job does before its moves
    const model = b.built.mobility!.world.inventory;
    const slots: UnloadSlot[] = model.slots.flatMap((s, i) => (s && i < 36 ? [{ slot: i, name: s.name, count: s.count }] : []));
    const plan = planUnload(slots, planChests(b.home.logistics.records()));
    expect(plan.compact).toEqual([{ kind: 'raw_iron', count: 27 }]);
    expect(compactRunner).toBeDefined();
    const t0 = Date.now();
    const compacted = await compactRunner!(plan.compact!, () => false);
    notes.push(`unload, step 1 (the runner): ${compacted} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    expect(compacted).toBe('compacted 27 raw_iron into 3 raw_iron_block');
    expect((await b.truth.craftinv(b.name)).counts).toEqual({ raw_iron_block: 3 });
    from = b.said.length;
    await b.command('!unload');
    expect(await b.reply((s) => s.startsWith('unloading ') || s.startsWith('unload: '), from)).toBe('unloading 1 stack into 1 known container');
    const end = await b.reply((s) => s.startsWith('unloaded: ') || s.startsWith('unload: '), from, 120_000);
    notes.push(`unload, step 2: ${end} (${((Date.now() - t0) / 1000).toFixed(1)} s from the command)`);
    expect(end).toContain(`3 raw_iron_block -> chest ${chest.x} ${chest.y} ${chest.z}`);
    const box = await b.truth.box(chest);
    notes.push(`chest after: ${JSON.stringify(box.counts)}, free ${box.free}`);
    expect(box.counts).toEqual({ raw_iron: 26 * 64, raw_iron_block: 3 });
    const inv = await b.truth.craftinv(b.name);
    notes.push(`inventory after: ${JSON.stringify(inv.counts)}`);
    expect(inv.counts).toEqual({});
    expect((await b.truth.block(table)).typeId).toBe('minecraft:crafting_table'); // the home's table stays
    const line = b.logs.filter((x) => x.includes(':craft info craft raw_iron_block')).at(-1);
    notes.push(`log: ${line}`);
  }, 240_000);

  it('a chest with room: no compaction step; compactOnUnload off: none either', async () => {
    const b = bot!;
    await truthLoaded(b.truth, 'container', [chest.x, chest.y, chest.z, 'clear']);
    await b.truth.chestPut(chest, 'raw_iron', 64, 10);
    await loadKit(b, [['raw_iron', 18]]);
    let from = b.said.length;
    await b.command('!chests clear');
    await b.reply((s) => s.startsWith('chests: forgot'), from);
    from = b.said.length;
    await b.command('!chests scan');
    await b.reply((s) => /^chests: \d+ within /.test(s), from, 120_000);
    const model = b.built.mobility!.world.inventory;
    const slotsOf = (): UnloadSlot[] => model.slots.flatMap((s, i) => (s && i < 36 ? [{ slot: i, name: s.name, count: s.count }] : []));
    expect(planUnload(slotsOf(), planChests(b.home.logistics.records())).compact).toBeUndefined();
    from = b.said.length;
    await b.command('!unload');
    const end = await b.reply((s) => s.startsWith('unloaded: ') || s.startsWith('unload: '), from, 120_000);
    notes.push(`room: ${end}`);
    expect(end).toContain(`18 raw_iron -> chest ${chest.x} ${chest.y} ${chest.z}`);
    expect(b.said.slice(from).some((s) => s.startsWith('compacted '))).toBe(false);
    expect((await b.truth.box(chest)).counts).toEqual({ raw_iron: 10 * 64 + 18 });
    // off: a full chest and 27 raw iron -> no compaction, the 27 go into the last free slot
    b.settings.set('compactOnUnload', 'off');
    await truthLoaded(b.truth, 'container', [chest.x, chest.y, chest.z, 'clear']);
    await b.truth.chestPut(chest, 'raw_iron', 64, 26);
    await loadKit(b, [['raw_iron', 27]]);
    from = b.said.length;
    await b.command('!chests clear');
    await b.reply((s) => s.startsWith('chests: forgot'), from);
    from = b.said.length;
    await b.command('!chests scan');
    await b.reply((s) => /^chests: \d+ within /.test(s), from, 120_000);
    expect(planUnload(slotsOf(), planChests(b.home.logistics.records())).compact).toBeUndefined(); // off: the planner keeps everything
    b.settings.set('compactOnUnload', 'on');
    expect(planUnload(slotsOf(), planChests(b.home.logistics.records())).compact).toEqual([{ kind: 'raw_iron', count: 27 }]);
    b.settings.set('compactOnUnload', 'off');
    from = b.said.length;
    await b.command('!unload');
    const end2 = await b.reply((s) => s.startsWith('unloaded: ') || s.startsWith('unload: '), from, 120_000);
    notes.push(`off: ${end2}`);
    expect(end2).toContain(`27 raw_iron -> chest ${chest.x} ${chest.y} ${chest.z}`);
    expect(b.said.slice(from).some((s) => s.startsWith('compacted '))).toBe(false);
    b.settings.set('compactOnUnload', 'on');
  }, 240_000);
});
