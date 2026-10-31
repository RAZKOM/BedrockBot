// e2e (tag @bds) for pillar-up felling and temporary scaffold (decision 0051, docs/wood.md "Pillar-up") on
// the bds-wood container (BDS_E2E=1): truth-built tall trees whose top no ground cell reaches
//   spruce   a 20-high single trunk with a leaf canopy at the top
//   jungle   a 2 x 2 trunk 22 high (88 logs) with a canopy
//   ledge    a log lying on a 3 x 3 stone block 4 high: collect with `hard` (a walk that may dig and place)
// Each: every log felled and picked up, no log and no scaffold block left, the bot back on the ground, no
// damage, the throwaway blocks back in the inventory. The bot carries 32 cobblestone and 32 dirt and no
// pickaxe: the scaffold must be dirt (cobblestone dug by hand takes 10 s and drops nothing).
// WOOD_VERBOSE=1 logs every skill step.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { remainingLogs } from '../../src/skills/tree/tree.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { E2E_VERSION } from './env.ts';
import { E2E, WOOD_CONTAINER, WoodArea, buildLayout, connectWoodBot, consoleCommand, logsInBox, pollUntil, prepareServer, truthLoaded, type WoodBot } from './wood-truth.ts';
import { FEET_Y, type WoodLayout } from './wood-worlds.ts';

const STOCK = 32;
const KINDS = ['cobblestone', 'dirt'] as const;

interface TallTree {
  name: string;
  x: number;
  z: number;
  h: number;
  kind: 'spruce' | 'jungle';
  wide: boolean;
}

function pillarLayout(x0: number, z0: number): { layout: WoodLayout; trees: TallTree[]; ledge: { from: Vec3; to: Vec3; item: Vec3 } } {
  const trees: TallTree[] = [
    { name: 'spruce 20', x: x0, z: z0, h: 20, kind: 'spruce', wide: false },
    { name: 'jungle 2x2 22', x: x0 + 12, z: z0, h: 22, kind: 'jungle', wide: true },
  ];
  const blocks: WoodLayout['blocks'] = [];
  for (const t of trees) {
    const w = t.wide ? 1 : 0;
    // canopy first, the trunk through it
    blocks.push({ from: { x: t.x - 2, y: FEET_Y + t.h - 3, z: t.z - 2 }, to: { x: t.x + 2 + w, y: FEET_Y + t.h, z: t.z + 2 + w }, block: `${t.kind}_leaves` });
    blocks.push({ from: { x: t.x, y: FEET_Y, z: t.z }, to: { x: t.x + w, y: FEET_Y + t.h - 1, z: t.z + w }, block: `${t.kind}_log` });
  }
  const ledge = { from: { x: x0 + 5, y: FEET_Y, z: z0 + 9 }, to: { x: x0 + 7, y: FEET_Y + 3, z: z0 + 11 }, item: { x: x0 + 6.5, y: FEET_Y + 4.2, z: z0 + 10.5 } };
  blocks.push({ ...ledge, block: 'stone' });
  return {
    layout: { name: 'pillar-forest', from: { x: x0 - 8, y: FEET_Y, z: z0 - 10 }, to: { x: x0 + 22, y: FEET_Y + 26, z: z0 + 16 }, trees: [], blocks, start: { x: x0 + 6.5, y: FEET_Y, z: z0 - 6.5 } },
    trees,
    ledge,
  };
}

const logsOf = (t: TallTree): Vec3[] => {
  const out: Vec3[] = [];
  for (let y = FEET_Y; y < FEET_Y + t.h; y++) for (let dx = 0; dx <= (t.wide ? 1 : 0); dx++) for (let dz = 0; dz <= (t.wide ? 1 : 0); dz++) out.push({ x: t.x + dx, y, z: t.z + dz });
  return out;
};

describe.skipIf(!E2E)('@bds wood: pillar up to fell tall trees, scaffold dug again (decision 0051)', () => {
  let bot: WoodBot;
  const area = new WoodArea();
  const L = pillarLayout(area.x0, area.z0);
  const notes: string[] = [];

  /** Throwaway blocks in a box (from FEET_Y up: the floor is grass on dirt). */
  const scaffoldIn = async (from: Vec3, to: Vec3) => {
    let n = 0;
    for (const k of KINDS) n += (await truthLoaded<{ count: number; positions: number[][] }>(bot.truth, 'find', [from.x, from.y, from.z, to.x, to.y, to.z, k])).count;
    return n;
  };
  const stock = async () => {
    for (const k of KINDS) {
      const have = bot.world.inventory.count(k);
      if (have < STOCK) await give(k, STOCK - have);
    }
  };
  const stocked = async () => {
    await pollUntil(() => KINDS.every((k) => bot.world.inventory.count(k) >= STOCK), 3_000);
    for (const k of KINDS) expect(bot.world.inventory.count(k), k).toBe(STOCK);
  };
  const carried = () => KINDS.map((k) => `${k} ${bot.world.inventory.count(k)}`).join(', ');
  const give = async (item: string, n: number) => {
    const before = bot.world.inventory.count(item);
    await consoleCommand(WOOD_CONTAINER, 'give', bot.name, item, String(n));
    await pollUntil(() => bot.world.inventory.count(item) >= before + n, 5_000);
  };

  beforeAll(async () => {
    await prepareServer();
    bot = await connectWoodBot('Pillar');
    await bot.teleport(L.layout.start);
    await buildLayout(bot.truth, L.layout);
    const last = logsOf(L.trees.at(-1)!).at(-1)!;
    expect(await pollUntil(() => bot.world.blockAt(last)?.name === 'jungle_log', 10_000)).toBeGreaterThanOrEqual(0);
    await bot.truth.ok('clear', [bot.name]);
    await bot.loop.waitTicks(10);
    await give('diamond_axe', 1);
  }, 180_000);

  afterAll(async () => {
    process.stdout.write(`[wood-pillar e2e] BDS ${E2E_VERSION}, area cell ${area.cell} (${area.x0}, ${area.z0})\n  ${notes.join('\n  ')}\n`);
    await bot?.close();
  });

  for (const i of [0, 1]) {
    it(`fells a ${L.trees[i]!.name} tree with a pillar and leaves no log and no scaffold`, async () => {
      const t = L.trees[i]!;
      const logs = logsOf(t);
      await stock();
      const log0 = bot.world.inventory.count(`${t.kind}_log`);
      const health0 = bot.world.self.health;
      const dmg0 = bot.skills.status().damage.length;
      const tree = bot.skills.treeAt(logs[0]!);
      expect(tree, t.name).toBeDefined();
      expect(tree!.logs.length).toBe(logs.length);
      const ts = performance.now();
      const r = await bot.skills.fellTree(tree!);
      const c = await bot.skills.collect(10, 600, { origin: { x: t.x + 0.5, y: FEET_Y, z: t.z + 0.5 } });
      const pos = bot.loop.state.pos;
      notes.push(
        `${t.name}: fell ${r.ok ? 'ok' : r.reason} ${r.broken.length}/${logs.length} logs, ${r.pillars} pillar(s), scaffold ${r.scaffoldPlaced} placed / ${r.scaffoldRemoved} dug again / ${r.scaffoldLeft?.length} left, ` +
          `${r.leavesDug} leaves, ${r.repaths} re-path(s), ${r.corrections} correction(s), ${((performance.now() - ts) / 1000).toFixed(1)} s; collect ${c.ok ? 'ok' : c.reason} ${JSON.stringify(c.gained)}; ` +
          `end ${pos.x.toFixed(2)} ${pos.y.toFixed(2)} ${pos.z.toFixed(2)}, health ${health0} -> ${bot.world.self.health}, ${carried()}`,
      );
      expect(r.ok, JSON.stringify({ ...r, broken: r.broken.length })).toBe(true);
      expect(remainingLogs((p) => bot.world.blockAt(p), tree!)).toEqual([]);
      expect(r.pillars).toBeGreaterThanOrEqual(1);
      expect(r.scaffoldLeft).toEqual([]);
      const box = { from: { x: t.x - 4, y: FEET_Y, z: t.z - 4 }, to: { x: t.x + 5, y: FEET_Y + t.h + 2, z: t.z + 5 } };
      const left = await logsInBox(bot.truth, box.from, box.to);
      expect(left.count, JSON.stringify(left.positions)).toBe(0);
      expect(await scaffoldIn(box.from, box.to)).toBe(0);
      expect(Math.abs(pos.y - FEET_Y)).toBeLessThan(0.01); // back on the ground
      expect(bot.skills.status().damage.length).toBe(dmg0);
      expect(bot.world.self.health).toBeGreaterThanOrEqual(health0);
      await pollUntil(() => bot.world.inventory.count(`${t.kind}_log`) - log0 >= logs.length, 3_000);
      expect(bot.world.inventory.count(`${t.kind}_log`) - log0).toBe(logs.length);
      await stocked();
    }, 600_000);
  }

  it('picks up a log lying on a 4-high ledge (a walk that may dig and place) and digs its scaffold again', async () => {
    await stock();
    await bot.teleport({ x: L.ledge.item.x - 4, y: FEET_Y, z: L.ledge.item.z - 4 });
    const health0 = bot.world.self.health;
    const n0 = bot.world.inventory.count('birch_log');
    await truthLoaded(bot.truth, 'spawnitem', [L.ledge.item.x, L.ledge.item.y, L.ledge.item.z, 'birch_log', 1]);
    await pollUntil(() => [...bot.world.entities.values()].some((e) => e.type === 'minecraft:item' && e.item?.name === 'birch_log'), 5_000);
    await bot.loop.waitTicks(20); // let it settle
    const ts = performance.now();
    const c = await bot.skills.collect(10, 200, { origin: L.ledge.item, hard: true, filter: (i) => i.name === 'birch_log' });
    const pos = bot.loop.state.pos;
    const rep = bot.skills.status().lastGoto;
    notes.push(
      `ledge: collect ${c.ok ? 'ok' : c.reason} ${JSON.stringify(c.gained)}, ${c.hardWalks ?? 0} hard walk(s), scaffold ${c.scaffoldPlaced ?? 0} placed / ${c.scaffoldLeft ?? 0} left, ` +
        `${((performance.now() - ts) / 1000).toFixed(1)} s, last goto ${JSON.stringify(rep?.result)} places ${rep?.actions.place} digs ${rep?.actions.dig}; end ${pos.x.toFixed(2)} ${pos.y.toFixed(2)} ${pos.z.toFixed(2)}, ${carried()}`,
    );
    expect(bot.world.inventory.count('birch_log') - n0).toBe(1);
    expect(c.hardWalks).toBe(1);
    expect(c.ok, c.ok ? '' : c.reason).toBe(true);
    expect(c.scaffoldLeft ?? 0).toBe(0);
    const from = { x: L.ledge.from.x - 3, y: FEET_Y, z: L.ledge.from.z - 3 };
    const to = { x: L.ledge.to.x + 3, y: FEET_Y + 8, z: L.ledge.to.z + 3 };
    expect(await scaffoldIn(from, to)).toBe(0);
    expect(bot.world.self.health).toBeGreaterThanOrEqual(health0);
    await stocked();
  }, 300_000);
});
