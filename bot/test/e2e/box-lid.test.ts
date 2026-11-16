// e2e (tag @bds), Track V1c (docs/inventory.md, ADR 0090 decision 12): which blocks over a shulker box's lid keep it from
// opening on BDS (bds-home: flat, peaceful, cheats, the truth pack). One bot places a box facing up next to it, the truth
// pack sets a block in the cell over the lid, the bot opens it (container_open or not), the box goes. Then the rule the
// box cells use (container/stash.ts lidOpen) against what the server did.
// Env: HOME_BDS_PORT / HOME_BDS_CONTAINER (default bds-home on 19196), BOX_LID_OUT (a file for the notes).
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { isShulkerBox } from '../../src/skills/container/chest.ts';
import { lidOpen } from '../../src/skills/container/stash.ts';
import { clearAreaHome, E2E, FEET_Y, prepareServer, privateArea, sleep, startHomeBot, teleport, until, type HomeBot } from './home-truth.ts';

/** Blocks over the lid: what a box cell may have there in the world (plants, snow, torches, slabs, glass, leaves). */
const LIDS = ['air', 'short_grass', 'fern', 'snow_layer', 'torch', 'dandelion', 'white_carpet', 'oak_slab', 'glass', 'oak_leaves', 'stone', 'vine', 'web', 'rail', 'oak_sign'];

describe.skipIf(!E2E)('@bds a shulker box opens only with the lid cell free (Track V1c)', () => {
  const area = privateArea();
  const at = { x: area.x + 40, y: FEET_Y, z: area.z };
  const notes: string[] = [];
  let bot: HomeBot | undefined;
  const note = (s: string) => {
    notes.push(s);
    if (process.env.BOX_LID_OUT) appendFileSync(process.env.BOX_LID_OUT, `${s}\n`);
  };
  const centre = (p: Vec3): Vec3 => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 });

  beforeAll(async () => {
    await prepareServer();
    bot = await startHomeBot('Lid');
    await teleport(bot, centre(at));
    await clearAreaHome(bot.truth, at, 6, 4);
  }, 300_000);

  afterAll(async () => {
    if (bot) {
      await clearAreaHome(bot.truth, at, 6, 4).catch(() => undefined);
      await bot.stop();
    }
    console.log(`[box-lid e2e] area cell ${area.cell}\n  ${notes.join('\n  ')}`);
  }, 120_000);

  it('each block over the lid: opened or not, and the rule agrees', async () => {
    const b = bot!;
    const sk = b.built.mobility!.skills;
    const inv = b.built.mobility!.world.inventory;
    const p = { x: at.x + 1, y: FEET_Y, z: at.z };
    const results: { lid: string; opened: boolean; rule: boolean }[] = [];
    for (const lid of LIDS) {
      await teleport(b, centre(at));
      await b.truth.ok('clear', [b.name]);
      await b.truth.ok('give', [b.name, 'undyed_shulker_box', 1]);
      await until(() => (inv.slots.some((s) => !!s && isShulkerBox(s.name)) ? true : undefined), 10_000, 'the box in the inventory');
      const placed = await sk.place(p, { face: 'up', item: 'undyed_shulker_box' });
      expect(placed.ok, `place under ${lid}`).toBe(true);
      await b.truth.ok('set', [p.x, p.y + 1, p.z, lid]).catch((e: unknown) => note(`${lid}: set failed ${String(e)}`));
      await sleep(600);
      const seen = b.built.mobility!.world.blockAt({ ...p, y: p.y + 1 });
      const o = await sk.open(p);
      if (o.ok) await sk.closeContainer(o.view);
      const rule = lidOpen(seen);
      results.push({ lid, opened: o.ok, rule });
      note(`${lid} (model ${seen?.name ?? '?'}): ${o.ok ? 'opened' : `not opened (${o.reason})`}; lidOpen ${rule}`);
      await b.truth.ok('set', [p.x, p.y + 1, p.z, 'air']).catch(() => undefined);
      await b.truth.ok('set', [p.x, p.y, p.z, 'air']).catch(() => undefined);
      await b.truth.clearAround(centre(at), 6).catch(() => undefined);
      await sleep(400);
    }
    // the rule never says open where the server did not open (a box set down there is lost time and a failed step)
    for (const r of results) if (r.rule) expect([r.lid, r.opened]).toEqual([r.lid, true]);
    expect(results.find((r) => r.lid === 'air')?.opened).toBe(true);
  }, 900_000);
});
