// Track M7 (docs/pve.md "Track M7: the live kit's margin", ADR 0079 addendum): what the rules stand on. The full task (the
// survival kit drinks the milk), on bds-gaunt by default (GAUNT_BDS_PORT / GAUNT_BDS_CONTAINER pick another server).
//   rush   the live kit (netherite set and sword, a shield), a witch summoned 7 off with a zombie 2 off and a skeleton 10 off
//          (both slowed so they stay where they are), guard on, 25 s a side: with `witchRush` guard rushes the witch (the
//          metric `pve.witchRush`) and she dies in the 25 s; off, no rush. The time to her death and the poison are logged
//          (one run a side is no measurement: the gauntlet's A/B rows are)
//   milk   the live kit and a milk bucket, poisoned for 30 s by the server, no mob near: with `milkCure` the poison is gone
//          within 6 s and the bucket is empty; off, it is still on after 6 s
// Needs BDS_E2E=1 and the server with the truth pack.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/world/types.ts';
import { centre, E2E, FEET_Y, prepareServer, privateArea, sleep, startGauntBot, teleport, tracked, uniqueName, until, type GauntBot } from './gaunt-truth.ts';
import { cleanSpot, expectAlive } from './pve-truth.ts';

function note(line: string): void {
  console.log(line);
  if (process.env.M7_OUT) appendFileSync(process.env.M7_OUT, `${line}\n`);
}

describe.skipIf(!E2E)('pve: Track M7 rules', () => {
  let bot: GauntBot | undefined;
  const ownerName = uniqueName('M7Owner');
  const area = privateArea();
  let spot = 0;
  const nextSpot = (): Vec3 => {
    const i = spot++;
    return { x: area.x + 420 + 80 * i, y: FEET_Y, z: area.z - 760 };
  };

  async function quiet(b: GauntBot): Promise<void> {
    b.pve.setGuard({ on: false });
    await b.truth.cleanup();
    await b.truth.setHealth(b.name, 20);
    const t0 = Date.now();
    do {
      b.pve.stop();
      await sleep(250);
    } while (b.pve.processes.active?.name === 'flee' && Date.now() - t0 < 5000);
  }

  async function fresh(b: GauntBot): Promise<Vec3> {
    const at = nextSpot();
    const c = centre(at);
    await quiet(b);
    await teleport(b, c).catch(async () => {
      await sleep(1000);
      await teleport(b, c);
    });
    await cleanSpot(b, c, { r: 16, up: 6, entities: 50 });
    await b.truth.ok('cleareffects', [b.name]).catch(() => undefined);
    await until(() => (b.pve.mobs.selfPoison === undefined ? true : undefined), 5000, 'no poison').catch(() => undefined);
    await b.truth.setHealth(b.name, 20);
    await b.truth.setFood(b.name, 20, 5);
    b.task.home?.set(at);
    return c;
  }

  const counter = (b: GauntBot, name: string): number => b.metrics.snapshot().counters[name] ?? 0;

  beforeAll(async () => {
    await prepareServer({ time: 'midnight' });
    bot = await startGauntBot('PveM7', {}, { owners: [ownerName], values: { guard: '16' } });
    const b = bot;
    await b.truth.ok('clear', [b.name]);
    await b.truth.ok('unequip', [b.name]);
    await b.truth.give(b.name, 'netherite_sword', 1);
    for (const piece of ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots']) await b.truth.give(b.name, piece, 1);
    await b.truth.give(b.name, 'cooked_beef', 16);
    await b.truth.give(b.name, 'shield', 1);
    await until(
      async () => {
        const eq = (await b.truth.ok<{ equipment: Record<string, { typeId: string } | undefined> }>('durability', [b.name])).equipment;
        const st = await b.truth.ok<{ offhand: { typeId: string } | null }>('stance', [b.name]);
        return eq.Head && eq.Chest && eq.Legs && eq.Feet && st.offhand?.typeId === 'minecraft:shield' ? true : undefined;
      },
      30_000,
      'the live kit worn',
      500,
    );
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      bot.pve.setGuard({ on: false });
      bot.pve.stop();
      await bot.truth.cleanup().catch(() => undefined);
      await bot.stop();
    }
  });

  it('rush: a witch 7 off, a zombie 2 off, a skeleton 10 off: on, guard rushes her and she dies; off, no rush', async () => {
    const b = bot!;
    const out: Record<string, { rushes: number; deadS: number | null; poisoned: boolean }> = {};
    for (const on of [false, true]) {
      const c = await fresh(b);
      b.pve.rules.witchRush = on;
      const deaths0 = b.built.respawn!.deaths;
      const rush0 = counter(b, 'pve.witchRush');
      const z = await b.truth.summon('zombie', { x: c.x - 2, y: FEET_Y, z: c.z });
      const s = await b.truth.summon('skeleton', { x: c.x, y: FEET_Y, z: c.z - 10 });
      for (const m of [z, s]) await b.truth.effect(m.entityId, 'slowness', 60, 255);
      const w = await b.truth.summon('witch', { x: c.x + 7, y: FEET_Y, z: c.z });
      const wid = await tracked(b, w);
      await tracked(b, z);
      await tracked(b, s);
      b.pve.setGuard({ on: true, radius: 16 });
      const t0 = Date.now();
      let deadS: number | null = null;
      let poisoned = false;
      while (Date.now() - t0 < 25_000 && b.built.respawn!.deaths === deaths0) {
        if (b.pve.mobs.selfPoison) poisoned = true;
        const e = b.built.mobility!.world.entities.get(wid);
        if (deadS === null && (!e || b.pve.mobs.get(wid)?.dead)) deadS = (Date.now() - t0) / 1000;
        if (deadS !== null) break;
        await sleep(100);
      }
      out[on ? 'on' : 'off'] = { rushes: counter(b, 'pve.witchRush') - rush0, deadS, poisoned };
      note(`rush (witchRush ${on ? 'on' : 'off'}): rushes ${out[on ? 'on' : 'off']!.rushes}, the witch dead after ${deadS?.toFixed(1) ?? '-'} s, poisoned ${poisoned}`);
      expectAlive(b, deaths0, `rush, witchRush ${on ? 'on' : 'off'}`);
      await quiet(b);
    }
    b.pve.rules.witchRush = true;
    expect(out.off!.rushes).toBe(0);
    expect(out.on!.rushes).toBeGreaterThanOrEqual(1);
    expect(out.on!.deadS).not.toBeNull();
  }, 150_000);

  it('milk: poisoned for 30 s with a milk bucket and no mob near: on, the poison is gone within 6 s; off, it stays', async () => {
    const b = bot!;
    const out: Record<string, { cured: boolean; bucket: boolean }> = {};
    for (const on of [false, true]) {
      await fresh(b);
      b.pve.rules.milkCure = on;
      const inv = b.built.mobility!.world.inventory;
      if (!inv.slots.some((it) => it?.name === 'milk_bucket')) {
        for (let i = 0; i < 36; i++) if (inv.slots[i]?.name === 'bucket') await b.truth.ok('setslot', [b.name, i, 'air', 1]).catch(() => undefined);
        await b.truth.give(b.name, 'milk_bucket', 1);
        await until(() => (inv.slots.some((it) => it?.name === 'milk_bucket') ? true : undefined), 5000, 'the milk in the inventory model');
      }
      const cures0 = counter(b, 'pve.cure');
      await b.truth.effect(b.name, 'poison', 30, 0);
      await until(() => (b.pve.mobs.selfPoison ? true : undefined), 5000, 'poisoned');
      const t0 = Date.now();
      let cured = false;
      while (Date.now() - t0 < 6000) {
        if (counter(b, 'pve.cure') > cures0 && !b.pve.mobs.selfPoison) cured = true;
        if (cured) break;
        await sleep(100);
      }
      const bucket = inv.slots.some((it) => it?.name === 'bucket');
      out[on ? 'on' : 'off'] = { cured, bucket };
      note(`milk (milkCure ${on ? 'on' : 'off'}): ${cured ? `poison gone after ${((Date.now() - t0) / 1000).toFixed(1)} s` : 'still poisoned after 6 s'}, an empty bucket ${bucket}, health ${b.pve.health().toFixed(1)}`);
      await b.truth.ok('cleareffects', [b.name]).catch(() => undefined);
    }
    b.pve.rules.milkCure = true;
    expect(out.off!.cured).toBe(false);
    expect(out.on!.cured).toBe(true);
    expect(out.on!.bucket).toBe(true);
  }, 120_000);
});
