// e2e (tag @bds) for PLAN.md task 4.5 (chest: open via inventory_transaction, move stacks via
// item_stack_request, close) on bds-wood, in the `chest-room` layout (wood-worlds.ts):
//   - 10 logs from a hotbar slot end in the chest per the truth pack (truth:container), the
//     inventory has none left (model and truth:inv), dirt (filtered out) stays
//   - the same from a main-inventory slot (>= 9) onto the existing chest stack
//   - the window opens with container_open at the chest and closes with the server's container_close
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { E2E_VERSION } from './env.ts';
import {
  E2E,
  WoodArea,
  buildLayout,
  connectWoodBot,
  logCount,
  pollUntil,
  prepareServer,
  type TruthContainer,
  type TruthInv,
  type WoodBot,
} from './wood-truth.ts';
import { chestRoom } from './wood-worlds.ts';

describe.skipIf(!E2E)('@bds wood: chest deposit (4.5)', () => {
  let bot: WoodBot;
  const area = new WoodArea();
  const layout = chestRoom(area.x0, area.z0);
  const chest = layout.chest!;
  const notes: string[] = [];

  const chestTruth = () => bot.truth.ok<TruthContainer>('container', [chest.x, chest.y, chest.z]);

  async function walkToChest(): Promise<void> {
    const g = await bot.skills.goto({ type: 'near', p: { x: chest.x + 0.5, y: chest.y, z: chest.z + 0.5 }, r: 2 });
    expect(g, 'goto chest').toEqual({ ok: true });
  }

  /** Empty inventory, then the items in order (truth:give fills the first free slot). */
  async function loadout(items: [string, number][]): Promise<void> {
    await bot.truth.ok('clear', [bot.name]);
    for (const [name, n] of items) await bot.truth.ok('give', [bot.name, name, n]);
    const want = items.reduce((a, [, n]) => a + n, 0);
    const ok = await pollUntil(() => bot.world.inventory.slots.reduce((a, s) => a + (s?.count ?? 0), 0) === want, 3_000);
    expect(ok, `inventory model: ${JSON.stringify(bot.world.inventory.slots.filter(Boolean))}`).toBeGreaterThanOrEqual(0);
  }

  beforeAll(async () => {
    await prepareServer();
    bot = await connectWoodBot('Chest');
    await bot.teleport(layout.start);
    await buildLayout(bot.truth, layout);
    expect(await pollUntil(() => bot.world.blockAt(chest)?.name === 'chest', 5_000)).toBeGreaterThanOrEqual(0);
    await bot.loop.waitTicks(10);
  }, 120_000);

  afterAll(async () => {
    process.stdout.write(`[wood-chest e2e] BDS ${E2E_VERSION}, area cell ${area.cell}\n  ${notes.join('\n  ')}\n`);
    await bot?.close();
  });

  it('10 logs from the hotbar end in the chest; dirt stays', async () => {
    await loadout([
      ['oak_log', 10],
      ['dirt', 5],
    ]);
    expect(bot.world.inventory.slots[0]).toMatchObject({ name: 'oak_log', count: 10 });
    await walkToChest();
    const opens = bot.containers.stats.opens;
    const t0 = performance.now();
    const open = await bot.skills.open(chest);
    expect(open.ok, JSON.stringify(open)).toBe(true);
    if (!open.ok) return;
    const tOpen = performance.now() - t0;
    expect(bot.containers.stats.opens).toBe(opens + 1);
    expect(bot.containers.open?.pos).toEqual(chest);
    expect(open.view.slots.length).toBe(27);
    const d = await bot.skills.deposit(open.view, (i) => i.name.endsWith('_log'));
    expect(d).toMatchObject({ ok: true, total: 10, errors: 0 });
    const closed = await bot.skills.closeContainer(open.view);
    expect(closed).toBe(true);
    expect(bot.containers.open).toBeUndefined();
    notes.push(`hotbar: opened in ${tOpen.toFixed(0)} ms (window ${open.open.id}), ${d.requests} request(s), moved ${JSON.stringify(d.moved)}, closed ${closed}`);

    const c = await chestTruth();
    notes.push(`truth chest: ${JSON.stringify(c.counts)}`);
    expect(c.counts['minecraft:oak_log']).toBe(10);
    expect(logCount(c.counts)).toBe(10);
    expect(c.counts['minecraft:dirt']).toBeUndefined();
    const inv = await bot.truth.ok<TruthInv>('inv', [bot.name]);
    expect(logCount(inv.counts)).toBe(0);
    expect(inv.counts['minecraft:dirt']).toBe(5);
    expect(bot.world.inventory.count('oak_log')).toBe(0);
    expect(bot.world.inventory.count('dirt')).toBe(5);
  }, 60_000);

  it('logs from a main-inventory slot (>= 9) go onto the chest stack', async () => {
    // nine single-item stacks fill the hotbar, so the logs land in slot 9
    const filler: [string, number][] = ['dirt', 'sand', 'stick', 'stone', 'gravel', 'cobblestone', 'oak_planks', 'glass', 'torch'].map((n) => [n, 1]);
    await loadout([...filler, ['birch_log', 7], ['oak_log', 3]]);
    expect(bot.world.inventory.slots[9]).toMatchObject({ name: 'birch_log', count: 7 });
    expect(bot.world.inventory.slots[10]).toMatchObject({ name: 'oak_log', count: 3 });
    const before = await chestTruth();
    const open = await bot.skills.open(chest);
    expect(open.ok, JSON.stringify(open)).toBe(true);
    if (!open.ok) return;
    // the model shows the 10 oak logs from the first case
    expect(open.view.slots.find((s) => s?.name === 'oak_log')?.count).toBe(before.counts['minecraft:oak_log']);
    const d = await bot.skills.deposit(open.view, (i) => i.name.endsWith('_log'));
    expect(d).toMatchObject({ ok: true, total: 10, errors: 0 });
    expect(await bot.skills.closeContainer(open.view)).toBe(true);
    const c = await chestTruth();
    notes.push(`main inventory: moved ${JSON.stringify(d.moved)}; truth chest ${JSON.stringify(c.counts)}`);
    expect(c.counts['minecraft:oak_log']).toBe((before.counts['minecraft:oak_log'] ?? 0) + 3);
    expect(c.counts['minecraft:birch_log']).toBe(7);
    // oak went onto the existing stack: still one oak slot
    expect(c.slots.filter((s) => s?.typeId === 'minecraft:oak_log').length).toBe(1);
    const inv = await bot.truth.ok<TruthInv>('inv', [bot.name]);
    expect(logCount(inv.counts)).toBe(0);
    expect(Object.values(inv.counts).reduce((a, b) => a + b, 0)).toBe(9);
  }, 60_000);

  it('refuses to open a block that is not a container, and one out of reach', async () => {
    const notChest = await bot.skills.open({ x: chest.x + 1, y: chest.y, z: chest.z });
    expect(notChest).toMatchObject({ ok: false });
    await bot.skills.goto({ type: 'block', p: { x: Math.floor(layout.start.x), y: layout.start.y, z: Math.floor(layout.start.z) + 3 } });
    const far = await bot.skills.open(chest);
    expect(far).toEqual({ ok: false, reason: 'unreachable' });
  }, 60_000);
});
