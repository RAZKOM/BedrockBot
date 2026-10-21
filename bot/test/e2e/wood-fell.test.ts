// e2e (tag @bds) for PLAN.md tasks 4.3 (tree model and felling) and 4.4 (collect): on the bds-wood
// container (BDS_E2E=1; docker/compose.wood.yml, truth pack deployed):
//   4.3  `fell-forest` (5 oak trees, 4..6 logs, two with touching canopies): every tree is detected
//        from one of its logs, felled bottom up, and no log is left below base + 6 (truth:find)
//   4.4  after felling and collect(), the inventory log count equals the logs broken
//        (truth:playerBreakBlock events) and equals truth:inv
// Prints corrections, re-paths and timings. WOOD_VERBOSE=1 logs every skill step.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { remainingLogs } from '../../src/skills/tree/tree.ts';
import { E2E_VERSION } from './env.ts';
import {
  E2E,
  WoodArea,
  buildLayout,
  connectWoodBot,
  logCount,
  logsInBox,
  pollUntil,
  prepareServer,
  type TruthInv,
  type WoodBot,
} from './wood-truth.ts';
import { FEET_Y, fellForest, totalLogs, treeLogs } from './wood-worlds.ts';

describe.skipIf(!E2E)('@bds wood: fell 5 trees and collect the logs (4.3, 4.4)', () => {
  let bot: WoodBot;
  const area = new WoodArea();
  const layout = fellForest(area.x0, area.z0);
  const notes: string[] = [];

  beforeAll(async () => {
    await prepareServer();
    bot = await connectWoodBot('Fell');
    await bot.teleport(layout.start);
    await buildLayout(bot.truth, layout);
    // the model sees the last tree
    const last = treeLogs(layout.trees.at(-1)!).at(-1)!;
    expect(await pollUntil(() => bot.world.blockAt(last)?.name === 'oak_log', 5_000)).toBeGreaterThanOrEqual(0);
    await bot.truth.ok('clear', [bot.name]);
    await bot.loop.waitTicks(10);
  }, 120_000);

  afterAll(async () => {
    process.stdout.write(`[wood-fell e2e] BDS ${E2E_VERSION}, area cell ${area.cell} (${area.x0}, ${area.z0})\n  ${notes.join('\n  ')}\n`);
    await bot?.close();
  });

  it('detects each tree from a log, fells all 5 bottom up, collects, and the counts match truth', async () => {
    const t0 = performance.now();
    const c0 = bot.loop.state.corrections;
    let broken = 0;
    for (const spec of layout.trees) {
      const logs = treeLogs(spec);
      // detect from a log in the middle of the trunk
      const tree = bot.skills.treeAt(logs[Math.floor(logs.length / 2)]!);
      expect(tree, `tree at ${spec.x} ${spec.z}`).toBeDefined();
      expect(tree!.kind).toBe('oak');
      expect(tree!.logs.length).toBe(spec.h);
      expect(tree!.base).toEqual({ x: spec.x, y: FEET_Y, z: spec.z });
      // felling order is bottom up
      expect(tree!.logs.map((p) => p.y)).toEqual([...tree!.logs.map((p) => p.y)].sort((a, b) => a - b));
      const ts = performance.now();
      const r = await bot.skills.fellTree(tree!);
      const c = await bot.skills.collect(8, 400, { origin: { x: spec.x + 0.5, y: FEET_Y, z: spec.z + 0.5 } });
      broken += r.broken.length;
      notes.push(
        `tree (${spec.x}, ${spec.z}) h ${spec.h}: fell ${r.ok ? 'ok' : r.reason} ${r.broken.length} logs, ${r.repaths} re-path(s), ${r.digFailures} dig failure(s), ` +
          `${r.corrections} correction(s), ${((performance.now() - ts) / 1000).toFixed(1)} s; collect ${c.ok ? 'ok' : c.reason} gained ${JSON.stringify(c.gained)}, ${c.skipped} skipped, in ${c.ticks} ticks`,
      );
      expect(r.ok, JSON.stringify({ ...r, broken: r.broken.length })).toBe(true);
      expect(remainingLogs((p) => bot.world.blockAt(p), tree!)).toEqual([]);
      // truth: no log left from the base up to base + 5 in the tree's column box
      const t = await logsInBox(bot.truth, { x: spec.x - 2, y: FEET_Y, z: spec.z - 2 }, { x: spec.x + 2, y: FEET_Y + 5, z: spec.z + 2 });
      expect(t.count, `logs left at tree (${spec.x}, ${spec.z}): ${JSON.stringify(t.positions)}`).toBe(0);
    }
    const corrections = bot.loop.state.corrections - c0;
    notes.push(`total: ${broken} logs broken of ${totalLogs(layout.trees)}, ${corrections} correction(s), ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    // the whole forest box is free of logs
    const all = await logsInBox(bot.truth, layout.from, { ...layout.to, y: FEET_Y + 6 });
    expect(all.count, JSON.stringify(all.positions)).toBe(0);
    // 4.4: logs broken (truth events) = logs in the inventory (model and truth)
    const logBreaks = bot.breaks.filter((b) => b.typeId.endsWith('_log')).length;
    expect(logBreaks).toBe(totalLogs(layout.trees));
    expect(broken).toBe(logBreaks);
    await pollUntil(() => bot.world.inventory.count('oak_log') === logBreaks, 3_000);
    const inv = await bot.truth.ok<TruthInv>('inv', [bot.name]);
    // diagnostics: drops still lying in the forest (model)
    const leftDrops = [...bot.world.entities.values()].filter((e) => e.type === 'minecraft:item' && e.pos.x >= layout.from.x && e.pos.x <= layout.to.x + 1 && e.pos.z >= layout.from.z && e.pos.z <= layout.to.z + 1);
    if (leftDrops.length) notes.push(`drops left: ${leftDrops.map((e) => `${e.item?.name} x${e.item?.count} at ${e.pos.x.toFixed(2)} ${e.pos.y.toFixed(2)} ${e.pos.z.toFixed(2)}`).join('; ')}`);
    notes.push(`inventory: model ${bot.world.inventory.count('oak_log')} oak_log, truth ${JSON.stringify(inv.counts)}, ${logBreaks} log breaks`);
    expect(logCount(inv.counts)).toBe(logBreaks);
    expect(bot.world.inventory.count('oak_log')).toBe(logBreaks);
    notes.push(`corrections over the test: ${bot.corrections.length}`);
  }, 600_000);
});
