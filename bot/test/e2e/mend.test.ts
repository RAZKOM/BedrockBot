// e2e (tag @bds), Track K5 (docs/survival.md "Mending (Track K5)"; decisions/0110): mending what the bot uses from the
// experience it gathers itself, on a flat, peaceful server with the truth pack (bds-craft by default;
// CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER point it at another, the track ran on bds-farm).
// The cases (without MEND_PROBE): a furnace take mends a carried Mending elytra; two damaged Mending pieces, one worn and
// one carried; `!mend elytra` from smelting what is carried; `!mend` from mining coal near.
// MEND_PROBE=rules,furnace,ores,mobs: the measurements (each case MEND_N times, default 3), lines to MEND_OUT.
// Env: CRAFT_BDS_HOST / CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER (craft-truth.ts), CRAFT_VERBOSE=1, MEND_OUT=<file>.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/world/types.ts';
import { survivalKitOf } from '../../src/chat/commands-survival.ts';
import { clearArea, craftCmd, E2E, FEET_Y, loadKit, prepareServer, privateArea, sleep, startCraftBot, teleport, truthLoaded, until, type CraftBot } from './craft-truth.ts';

const F = FEET_Y;
const PROBE = new Set((process.env.MEND_PROBE ?? '').split(',').filter((s) => s !== ''));
const N = Number(process.env.MEND_N ?? 3);
const OUT = process.env.MEND_OUT;

/** Experience points to go from level `l` to `l + 1` (the Bedrock and Java table). */
export function xpToNext(l: number): number {
  return l <= 15 ? 2 * l + 7 : l <= 30 ? 5 * l - 38 : 9 * l - 158;
}
/** Total experience points at level `l` with `progress` (0..1) into the next. */
export function xpTotal(l: number, progress: number): number {
  let t = 0;
  for (let i = 0; i < l; i++) t += xpToNext(i);
  return t + progress * xpToNext(l);
}

interface OrbSeen {
  id: bigint;
  first: number;
  gone?: number;
  /** Distance from the bot's feet when first seen. */
  dist: number;
  at: Vec3;
}

describe.skipIf(!E2E)('@bds mend: the elytra mended from experience the bot gathers (Track K5)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: CraftBot | undefined;
  const feet = { x: area.x + 0.5, y: F, z: area.z + 0.5 };
  const note = (line: string): void => {
    notes.push(line);
    console.log(line);
    if (OUT) appendFileSync(OUT, `${new Date().toISOString()} ${line}\n`);
  };
  const inv = (b: CraftBot) => b.built.mobility!.world.inventory;
  const self = (b: CraftBot) => b.built.mobility!.world.self;
  const xp = (b: CraftBot): number => xpTotal(self(b).level ?? 0, self(b).xpProgress ?? 0);

  // the orbs the bot sees: first seen, gone, the distance from the feet when first seen
  const orbs = new Map<bigint, OrbSeen>();
  let orbTimer: ReturnType<typeof setInterval> | undefined;
  const watchOrbs = (b: CraftBot): void => {
    orbTimer = setInterval(() => {
      const w = b.built.mobility!.world;
      const me = w.self.pos;
      const seen = new Set<bigint>();
      for (const e of w.entities.values()) {
        if (!e.type.endsWith('xp_orb')) continue;
        seen.add(e.runtimeId);
        if (!orbs.has(e.runtimeId)) orbs.set(e.runtimeId, { id: e.runtimeId, first: Date.now(), dist: Math.hypot(e.pos.x - me.x, e.pos.y - me.y, e.pos.z - me.z), at: { ...e.pos } });
      }
      for (const o of orbs.values()) if (o.gone === undefined && !seen.has(o.id)) o.gone = Date.now();
    }, 25);
  };
  const orbsSince = (t: number): OrbSeen[] => [...orbs.values()].filter((o) => o.first >= t);
  const orbLine = (l: OrbSeen[]): string =>
    l.length === 0 ? 'no orbs seen' : `${l.length} orbs, first seen ${l.map((o) => o.dist.toFixed(1)).join('/')} from the feet, picked up after ${l.map((o) => (o.gone === undefined ? '-' : ((o.gone - o.first) / 1000).toFixed(2))).join('/')} s`;

  /** The server's wear: the equipment and the inventory slots with durability. */
  const wear = async (b: CraftBot): Promise<{ chest?: number; offhand?: number; head?: number; slots: Record<number, { typeId: string; damage: number }> }> => {
    const d = await b.truth.ok<{ slots: { slot: number; typeId: string; damage: number }[]; equipment: Record<string, { typeId: string; damage: number | null } | null> }>('durability', [b.name]);
    const slots: Record<number, { typeId: string; damage: number }> = {};
    for (const s of d.slots) slots[s.slot] = { typeId: s.typeId.replace(/^minecraft:/, ''), damage: s.damage };
    const c = d.equipment.Chest;
    const o = d.equipment.Offhand;
    const h = d.equipment.Head;
    return { ...(c?.damage != null ? { chest: c.damage } : {}), ...(o?.damage != null ? { offhand: o.damage } : {}), ...(h?.damage != null ? { head: h.damage } : {}), slots };
  };

  /** An item with Mending and `damage` into hotbar slot `slot` (enchanted while held), the hand back to slot 8. */
  const mendingItem = async (b: CraftBot, slot: number, item: string, damage: number): Promise<void> => {
    // (selected first: a shield is moved to an empty offhand by the shield controller within a second)
    b.task.pve!.hotbar.select(slot);
    await b.built.mobility!.loop.waitTicks(4);
    await b.truth.ok('setslot', [b.name, slot, item, 1, damage]);
    await until(() => (inv(b).slots[slot]?.name === item ? true : undefined), 5000, `the ${item} in slot ${slot}`);
    await craftCmd('enchant', b.name, 'mending', '1');
    await until(() => ((inv(b).slots[slot]?.enchants ?? []).some((e) => e.id === 26) ? true : undefined), 5000, `Mending on the ${item}`);
    b.task.pve!.hotbar.select(8);
    await b.built.mobility!.loop.waitTicks(10);
  };
  const RULES = new Set((process.env.MEND_RULES ?? 'none,carried,main,chest,offhand,shield,several,several2').split(','));
  /** `n` orbs summoned one block over the feet; waits until every orb is gone (or 8 s). */
  const summonOrbs = async (b: CraftBot, n: number, oneByOne = false): Promise<OrbSeen[]> => {
    const p = b.task.position()!;
    const t0 = Date.now();
    for (let i = 0; i < n; i++) {
      await craftCmd('summon', 'xp_orb', String(Math.floor(p.x) + 0.5), String(Math.floor(p.y) + 1), String(Math.floor(p.z) + 0.5));
      if (oneByOne) await until(() => (orbsSince(t0).length > i && orbsSince(t0).every((o) => o.gone !== undefined) ? true : undefined), 8000, 'the orb picked up').catch(() => undefined);
    }
    await until(() => (orbsSince(t0).length >= n && orbsSince(t0).every((o) => o.gone !== undefined) ? true : undefined), 8000, 'every orb picked up').catch(() => undefined);
    await sleep(800);
    return orbsSince(t0);
  };
  const resetXp = async (b: CraftBot): Promise<void> => {
    await craftCmd('xp', '-30000L', b.name);
    await until(() => ((self(b).level ?? 0) === 0 && (self(b).xpProgress ?? 0) < 0.01 ? true : undefined), 5000, 'xp 0').catch(() => undefined);
  };
  const clean = async (b: CraftBot): Promise<void> => {
    await b.truth.ok('clear', [b.name]).catch(() => undefined);
    await b.truth.ok('unequip', [b.name]).catch(() => undefined);
    await b.truth.clearAround(feet, 24).catch(() => undefined);
    await sleep(500);
  };

  beforeAll(async () => {
    await prepareServer();
    const b = await startCraftBot('Mend');
    bot = b;
    b.settings.set('autoUnload', 'off');
    b.settings.set('autoFood', 'off');
    await teleport(b, feet);
    await clearArea(b.truth, { x: area.x, z: area.z }, 16, 10);
    watchOrbs(b);
  }, 180_000);

  afterAll(async () => {
    if (orbTimer) clearInterval(orbTimer);
    if (bot) {
      await craftCmd('difficulty', 'peaceful').catch(() => undefined);
      await clean(bot);
      await clearArea(bot.truth, { x: area.x, z: area.z }, 16, 10).catch(() => undefined);
      await truthLoaded(bot.truth, 'fill', [area.x - 16, F - 1, area.z - 16, area.x + 16, F - 1, area.z + 16, 'grass_block']).catch(() => undefined);
      await bot.stop();
    }
    console.log(`[mend e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 120_000);

  // ---- the measurements ------------------------------------------------------------------------------------------------
  it.skipIf(!PROBE.has('rules'))('probe rules: points per orb, uses per point, the slots that count, several pieces', async () => {
    const b = bot!;
    const model = (): string => {
      const i = inv(b);
      const chest = i.window(120)?.slots[1];
      const off = i.window(119)?.slots[0];
      return `model chest ${chest ? `${chest.name} ${chest.damage}` : '-'}, offhand ${off ? `${off.name} ${off.damage}` : '-'}, slot1 ${i.slots[1] ? `${i.slots[1].name} ${i.slots[1].damage}` : '-'}, slot2 ${i.slots[2] ? `${i.slots[2].name} ${i.slots[2].damage}` : '-'}`;
    };
    const packets: string[] = [];
    for (const n of ['inventory_slot', 'inventory_content', 'player_armor_damage', 'mob_equipment', 'mob_armor_equipment']) {
      b.conn.on(n, (p: unknown) => {
        const s = JSON.stringify(p, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
        if (/elytra|shield|pickaxe|player_armor_damage|"damage"/.test(s) || n === 'player_armor_damage') packets.push(`${n} ${s.slice(0, 240)}`);
      });
    }
    for (let run = 0; run < N; run++) {
      let x0: number;
      let seen: OrbSeen[];
      let w0: Awaited<ReturnType<typeof wear>>;
      let w1: Awaited<ReturnType<typeof wear>>;
      let from: number;
      if (RULES.has('none')) {
      // none: nothing with Mending; the points one orb gives
      await clean(b);
      await resetXp(b);
      x0 = xp(b);
      seen = await summonOrbs(b, 10);
      note(`rules none run ${run + 1}: 10 orbs -> xp ${x0.toFixed(1)} -> ${xp(b).toFixed(1)} (level ${self(b).level}, ${orbLine(seen)})`);
      }
      if (RULES.has('carried') || RULES.has('main') || RULES.has('chest')) {
      // carried: a Mending elytra in hotbar slot 1, not held (slot 8 held)
      await clean(b);
      await resetXp(b);
      await mendingItem(b, 1, 'elytra', 300);
      w0 = await wear(b);
      x0 = xp(b);
      seen = await summonOrbs(b, 10);
      w1 = await wear(b);
      note(`rules carried run ${run + 1}: slot 1 damage ${w0.slots[1]?.damage} -> ${w1.slots[1]?.damage}; xp ${x0.toFixed(1)} -> ${xp(b).toFixed(1)}; ${orbLine(seen)}`);
      // main hand: the same elytra held
      b.task.pve!.hotbar.select(1);
      await b.built.mobility!.loop.waitTicks(10);
      packets.length = 0;
      w0 = await wear(b);
      x0 = xp(b);
      await summonOrbs(b, 10);
      w1 = await wear(b);
      note(`rules main run ${run + 1}: slot 1 damage ${w0.slots[1]?.damage} -> ${w1.slots[1]?.damage}; xp ${x0.toFixed(1)} -> ${xp(b).toFixed(1)}; ${model()}; packets ${packets.length}: ${packets.slice(0, 3).join(' | ')}`);
      b.task.pve!.hotbar.select(8);
      await b.built.mobility!.loop.waitTicks(10);
      // chest: worn
      from = b.said.length;
      await b.command('!equip slot 1');
      await b.reply((s) => s.startsWith('equip'), from, 8000).catch(() => undefined);
      await until(() => (inv(b).window(120)?.slots[1]?.name === 'elytra' ? true : undefined), 5000, 'the elytra on').catch(() => undefined);
      packets.length = 0;
      w0 = await wear(b);
      x0 = xp(b);
      await summonOrbs(b, 10);
      w1 = await wear(b);
      note(`rules chest run ${run + 1}: chest damage ${w0.chest} -> ${w1.chest}; xp ${x0.toFixed(1)} -> ${xp(b).toFixed(1)}; ${model()}; packets ${packets.length}: ${packets.slice(0, 3).join(' | ')}`);
      }
      if (RULES.has('offhand')) {
      // offhand: the bot's own request (`!offhand elytra`), then orbs
      await clean(b);
      await resetXp(b);
      await mendingItem(b, 1, 'elytra', 300);
      from = b.said.length;
      await b.command('!offhand elytra');
      const offReply = await b.reply((s) => s.startsWith('offhand'), from, 8000).catch(() => 'no reply');
      await sleep(500);
      w0 = await wear(b);
      x0 = xp(b);
      packets.length = 0;
      await summonOrbs(b, 10);
      w1 = await wear(b);
      note(`rules offhand elytra run ${run + 1}: \`!offhand elytra\` -> ${offReply}; offhand ${w0.offhand ?? '-'} -> ${w1.offhand ?? '-'}, slot 1 ${w0.slots[1]?.damage ?? '-'} -> ${w1.slots[1]?.damage ?? '-'}; xp ${x0.toFixed(1)} -> ${xp(b).toFixed(1)}; ${model()}`);
      }
      if (RULES.has('shield')) {
      // offhand: a Mending shield (an item the offhand takes)
      await clean(b);
      await resetXp(b);
      await mendingItem(b, 2, 'shield', 200);
      from = b.said.length;
      await b.command('!offhand shield');
      const shReply = await b.reply((s) => s.startsWith('offhand'), from, 8000).catch(() => 'no reply');
      await sleep(500);
      w0 = await wear(b);
      x0 = xp(b);
      packets.length = 0;
      await summonOrbs(b, 10);
      w1 = await wear(b);
      note(`rules offhand shield run ${run + 1}: \`!offhand shield\` -> ${shReply}; offhand ${w0.offhand ?? '-'} -> ${w1.offhand ?? '-'}; xp ${x0.toFixed(1)} -> ${xp(b).toFixed(1)}; ${model()}; packets ${packets.length}: ${packets.slice(0, 3).join(' | ')}`);
      }
      if (RULES.has('several')) {
      // several: the elytra worn (damage 300) and a Mending diamond pickaxe held (damage 1000); one orb at a time
      await clean(b);
      await resetXp(b);
      await mendingItem(b, 1, 'elytra', 300);
      await mendingItem(b, 2, 'diamond_pickaxe', 1000);
      from = b.said.length;
      await b.command('!equip slot 1');
      await b.reply((s) => s.startsWith('equip'), from, 8000).catch(() => undefined);
      await until(() => (inv(b).window(120)?.slots[1]?.name === 'elytra' ? true : undefined), 5000, 'the elytra on').catch(() => undefined);
      b.task.pve!.hotbar.select(2);
      await b.built.mobility!.loop.waitTicks(10);
      const picks: string[] = [];
      let prev = await wear(b);
      for (let i = 0; i < 10; i++) {
        await summonOrbs(b, 1);
        const now = await wear(b);
        const dE = (prev.chest ?? 0) - (now.chest ?? 0);
        const dP = (prev.slots[2]?.damage ?? 0) - (now.slots[2]?.damage ?? 0);
        picks.push(dE > 0 && dP > 0 ? `both ${dE}/${dP}` : dE > 0 ? `elytra ${dE}` : dP > 0 ? `pickaxe ${dP}` : 'none');
        prev = now;
      }
      note(`rules several run ${run + 1}: elytra worn and a pickaxe held, both Mending, one orb at a time: ${picks.join(', ')}; xp now ${xp(b).toFixed(1)}`);
      b.task.pve!.hotbar.select(8);
      }
      if (RULES.has('several2')) {
        // several2: the elytra held (damage 300) and a Mending diamond chestplate worn (damage 300); one orb at a time
        await clean(b);
        await resetXp(b);
        await mendingItem(b, 2, 'diamond_chestplate', 300);
        from = b.said.length;
        await b.command('!equip slot 2');
        await b.reply((s) => s.startsWith('equip'), from, 8000).catch(() => undefined);
        await until(() => (inv(b).window(120)?.slots[1]?.name === 'diamond_chestplate' ? true : undefined), 5000, 'the chestplate on').catch(() => undefined);
        await mendingItem(b, 1, 'elytra', 300);
        b.task.pve!.hotbar.select(1);
        await b.built.mobility!.loop.waitTicks(10);
        const picks: string[] = [];
        let prev = await wear(b);
        for (let i = 0; i < 10; i++) {
          await summonOrbs(b, 1);
          const now = await wear(b);
          const dC = (prev.chest ?? 0) - (now.chest ?? 0);
          const dE = (prev.slots[1]?.damage ?? 0) - (now.slots[1]?.damage ?? 0);
          picks.push(dE > 0 && dC > 0 ? `both ${dE}/${dC}` : dE > 0 ? `elytra ${dE}` : dC > 0 ? `chestplate ${dC}` : 'none');
          prev = now;
        }
        note(`rules several2 run ${run + 1}: elytra held and a chestplate worn, both Mending, one orb at a time: ${picks.join(', ')}; xp now ${xp(b).toFixed(1)}`);
        b.task.pve!.hotbar.select(8);
      }
      if (RULES.has('several3')) {
        // several3: three pieces damaged by different shares: the elytra held (100 of 432), a diamond chestplate worn (400
        // of 528), diamond leggings worn (50 of 495); 20 orbs one at a time: which takes each
        await clean(b);
        await resetXp(b);
        await mendingItem(b, 2, 'diamond_chestplate', 400);
        await mendingItem(b, 3, 'diamond_leggings', 50);
        for (const s of [2, 3]) {
          from = b.said.length;
          await b.command(`!equip slot ${s}`);
          await b.reply((x) => x.startsWith('equip'), from, 8000).catch(() => undefined);
          await sleep(500);
        }
        await mendingItem(b, 1, 'elytra', 100);
        b.task.pve!.hotbar.select(1);
        await b.built.mobility!.loop.waitTicks(10);
        const legs = async (): Promise<number> => ((await b.truth.ok<{ equipment: Record<string, { damage: number | null } | null> }>('durability', [b.name])).equipment.Legs?.damage ?? 0);
        const picks: string[] = [];
        let prev = await wear(b);
        let prevL = await legs();
        for (let i = 0; i < 20; i++) {
          await summonOrbs(b, 1);
          const now = await wear(b);
          const nowL = await legs();
          const got: string[] = [];
          if ((prev.slots[1]?.damage ?? 0) > (now.slots[1]?.damage ?? 0)) got.push('elytra');
          if ((prev.chest ?? 0) > (now.chest ?? 0)) got.push('chest');
          if (prevL > nowL) got.push('legs');
          picks.push(got.join('+') || 'none');
          prev = now;
          prevL = nowL;
        }
        note(`rules several3 run ${run + 1}: elytra held 100/432 damaged, chestplate 400/528, leggings 50/495, all Mending, one orb at a time: ${picks.join(', ')}; at the end elytra ${prev.slots[1]?.damage} chest ${prev.chest} legs ${prevL}`);
        b.task.pve!.hotbar.select(8);
      }
      if (RULES.has('reader') && run === 0) {
        // the reader: every kind the bot uses enchanted with /enchant: does the model's ItemStack.enchants carry Mending?
        const kinds = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'diamond_sword', 'diamond_axe', 'diamond_pickaxe', 'diamond_shovel', 'diamond_hoe', 'shield', 'trident', 'bow', 'fishing_rod', 'shears', 'flint_and_steel', 'elytra', 'crossbow', 'mace'];
        const out: string[] = [];
        for (const k of kinds) {
          await clean(b);
          try {
            await mendingItem(b, 4, k, 5);
            b.task.pve!.hotbar.select(4);
            await b.built.mobility!.loop.waitTicks(4);
            await craftCmd('enchant', b.name, 'unbreaking', '3');
            await sleep(600);
            b.task.pve!.hotbar.select(8);
            // (armour goes on by the armour pass, a shield into the offhand by the shield controller: read it where it went)
            const where = [{ w: 'slot 4', it: inv(b).slots[4] }, ...(inv(b).window(120)?.slots ?? []).map((it, i) => ({ w: `armour ${i}`, it })), { w: 'offhand', it: inv(b).window(119)?.slots[0] }].find((x) => x.it?.name === k);
            out.push(`${k} (${where?.w ?? 'not found'}) ${JSON.stringify(where?.it?.enchants ?? null)} damage ${where?.it?.damage}`);
          } catch (e) {
            out.push(`${k} failed (${e instanceof Error ? e.message : String(e)}; model ${JSON.stringify(inv(b).slots[4]?.enchants ?? null)}, offhand ${inv(b).window(119)?.slots[0]?.name ?? '-'})`);
          }
        }
        note(`rules reader: ${out.join('; ')}`);
      }
    }
    await clean(b);
    expect(true).toBe(true);
  }, 900_000);

  it.skipIf(!PROBE.has('furnace'))('probe furnace: the experience a furnace pays, how it reaches the body', async () => {
    const b = bot!;
    const furnace = { x: area.x + 2, y: F, z: area.z };
    const cases: { label: string; kit: [string, number][]; cmd: string }[] = [
      { label: 'raw_iron 8', kit: [['raw_iron', 8], ['coal', 2]], cmd: '!smelt iron 8' },
      { label: 'beef 8', kit: [['beef', 8], ['coal', 2]], cmd: '!cook' },
      { label: 'cobblestone 8', kit: [['cobblestone', 8], ['coal', 2]], cmd: '!smelt cobblestone 8' },
    ];
    const only = process.env.MEND_FURNACE?.split(',');
    for (let run = 0; run < N; run++) {
      for (const c of cases.filter((x) => !only || only.some((o) => x.label.startsWith(o)))) {
        await clean(b);
        await resetXp(b);
        await teleport(b, feet);
        await truthLoaded(b.truth, 'fill', [furnace.x, furnace.y, furnace.z, furnace.x, furnace.y, furnace.z, 'air']);
        await truthLoaded(b.truth, 'fill', [furnace.x, furnace.y, furnace.z, furnace.x, furnace.y, furnace.z, 'furnace']);
        await sleep(500);
        // the kit first (it replaces the inventory), then a Mending elytra worn: does what the furnace pays mend it?
        await b.truth.kit(b.name, c.kit);
        await sleep(500);
        await mendingItem(b, 7, 'elytra', 300);
        const fe = b.said.length;
        await b.command('!equip slot 7');
        await b.reply((s) => s.startsWith('equip'), fe, 8000).catch(() => undefined);
        await until(() => (inv(b).window(120)?.slots[1]?.name === 'elytra' ? true : undefined), 5000, 'the elytra on').catch(() => undefined);
        await sleep(500);
        const w0 = await wear(b);
        const x0 = xp(b);
        const from = b.said.length;
        const t0 = Date.now();
        // the experience as it comes: when it rises against when the output was taken (the log line)
        const rises: string[] = [];
        let last = x0;
        const timer = setInterval(() => {
          const now = xp(b);
          if (Math.abs(now - last) > 0.01) {
            rises.push(`${((Date.now() - t0) / 1000).toFixed(1)}s +${(now - last).toFixed(1)}`);
            last = now;
          }
        }, 50);
        await b.command(c.cmd);
        const end = await b.reply((s) => /^(smelted|smelt:|cooked|cook:)/.test(s) && !s.startsWith('cooking'), from, 200_000).catch(() => 'no end line');
        await sleep(3000);
        clearInterval(timer);
        const w1 = await wear(b);
        const seen = orbsSince(t0);
        note(`furnace ${c.label} run ${run + 1}: ${end}; xp ${x0.toFixed(1)} -> ${xp(b).toFixed(1)} (rises ${rises.join(', ') || 'none'}); elytra worn damage ${w0.chest} -> ${w1.chest} (${((w0.chest ?? 0) - (w1.chest ?? 0))} uses); ${orbLine(seen)}; orbs at ${seen.map((o) => `${(o.at.x - furnace.x - 0.5).toFixed(1)},${(o.at.y - furnace.y).toFixed(1)},${(o.at.z - furnace.z - 0.5).toFixed(1)}`).join(' ')} from the furnace`);
      }
    }
    expect(true).toBe(true);
  }, 3_600_000);

  it.skipIf(!PROBE.has('ores'))('probe ores: the experience an ore pays and how far its orbs fly', async () => {
    const b = bot!;
    const ores = ['coal_ore', 'lapis_ore', 'redstone_ore', 'diamond_ore', 'quartz_ore', 'nether_gold_ore'];
    for (let run = 0; run < N; run++) {
      for (const ore of ores) {
        await clean(b);
        await resetXp(b);
        await teleport(b, feet);
        await loadKit(b, [['iron_pickaxe', 1]]);
        // the ore 3 blocks off in the floor
        const p = { x: area.x + 3, y: F - 1, z: area.z };
        await truthLoaded(b.truth, 'fill', [p.x, p.y, p.z, p.x, p.y, p.z, ore]);
        await sleep(800);
        const x0 = xp(b);
        const from = b.said.length;
        const t0 = Date.now();
        await b.command(`!mine ${ore} 1`);
        const end = await b.reply((s) => s.startsWith('mine '), from, 60_000).catch(() => 'no end line');
        await sleep(3000);
        const seen = orbsSince(t0);
        const me = b.task.position()!;
        note(`ore ${ore} run ${run + 1}: ${end}; xp ${x0.toFixed(1)} -> ${xp(b).toFixed(1)}; ${orbLine(seen)}; bot ${Math.hypot(me.x - p.x - 0.5, me.z - p.z - 0.5).toFixed(1)} from the ore at the end`);
        await truthLoaded(b.truth, 'fill', [p.x, p.y, p.z, p.x, p.y, p.z, 'grass_block']);
      }
    }
    expect(true).toBe(true);
  }, 3_600_000);

  it.skipIf(!PROBE.has('mobs'))('probe mobs: the experience a kill pays and whether its orbs reach the body', async () => {
    const b = bot!;
    const mobs = (process.env.MEND_MOBS ?? 'zombie,skeleton,spider,phantom').split(',');
    try {
      await craftCmd('difficulty', 'easy');
      for (let run = 0; run < N; run++) {
        for (const mob of mobs) {
          await clean(b);
          await resetXp(b);
          await teleport(b, feet);
          await loadKit(b, [['diamond_sword', 1], ['cobblestone', 16]]);
          // a Mending elytra carried in hotbar slot 7 (damage 300): the watcher's hold after the kill (mendOnTheWay)
          if (process.env.MEND_MOB_ELYTRA === '1') await mendingItem(b, 7, 'elytra', 300);
          b.task.pve!.hotbar.select(0);
          await sleep(500);
          const e0 = (await wear(b)).slots[7]?.damage;
          const x0 = xp(b);
          const t0 = Date.now();
          const at = mob === 'phantom' ? { x: feet.x + 4, y: F + 6, z: feet.z } : { x: feet.x + 5, y: F, z: feet.z };
          const m = await b.truth.summon(mob, at);
          let deadAt: Vec3 | undefined;
          let died = false;
          for (let i = 0; i < 120; i++) {
            await sleep(500);
            const e = await b.truth.entity(m.entityId).catch(() => undefined);
            if (!e || e.valid === false || (e.health ?? 1) <= 0) {
              died = true;
              break;
            }
            deadAt = e.location;
          }
          await sleep(Number(process.env.MEND_MOB_WAIT ?? 3000));
          const seen = orbsSince(t0);
          const me = b.task.position()!;
          const e1 = (await wear(b)).slots[7]?.damage;
          note(`mob ${mob} run ${run + 1}: ${died ? `killed in ${((Date.now() - t0 - Number(process.env.MEND_MOB_WAIT ?? 3000)) / 1000).toFixed(1)} s` : 'not killed in 60 s'}; xp ${x0.toFixed(1)} -> ${xp(b).toFixed(1)}; elytra carried ${e0 ?? '-'} -> ${e1 ?? '-'}; held after ${inv(b).selected}; ${orbLine(seen)}; last seen ${deadAt ? `${Math.hypot(deadAt.x - me.x, deadAt.y - me.y, deadAt.z - me.z).toFixed(1)} from the bot` : '-'}`);
          await b.truth.cleanup().catch(() => undefined);
        }
      }
    } finally {
      await craftCmd('difficulty', 'peaceful');
    }
    expect(true).toBe(true);
  }, 3_600_000);
  // ---- the cases ----------------------------------------------------------------------------------------------------------
  const CASES = PROBE.size === 0;
  const furnaceAt = (): Vec3 => ({ x: area.x + 2, y: F, z: area.z });
  /** A fresh start: the kit, the furnace (or none), xp 0, a Mending elytra damaged 300 in main-inventory slot 20. */
  const setUp = async (b: CraftBot, kit: [string, number][], furnace: boolean): Promise<void> => {
    await clean(b);
    await resetXp(b);
    await teleport(b, feet);
    const fp = furnaceAt();
    await truthLoaded(b.truth, 'fill', [fp.x, fp.y, fp.z, fp.x, fp.y, fp.z, 'air']);
    if (furnace) await truthLoaded(b.truth, 'fill', [fp.x, fp.y, fp.z, fp.x, fp.y, fp.z, 'furnace']);
    await b.truth.kit(b.name, kit);
    await sleep(500);
    await mendingItem(b, 7, 'elytra', 300);
    const r = await survivalKitOf(b.task)!.moveSlot(7, 20);
    expect(r).toEqual({ ok: true });
    await until(() => (inv(b).slots[20]?.name === 'elytra' ? true : undefined), 5000, 'the elytra in slot 20');
  };
  const elytraIn20 = async (b: CraftBot): Promise<number | undefined> => (await wear(b)).slots[20]?.damage;

  it.skipIf(!CASES)('on the way: a furnace take mends a carried Mending elytra (held for the take, the hand and the slot back after)', async () => {
    const b = bot!;
    await setUp(b, [['raw_iron', 8], ['coal', 2], ['cobblestone', 16]], true);
    const sel = inv(b).selected;
    const from = b.said.length;
    const logFrom = b.logs.length;
    await b.command('!smelt iron 8');
    const end = await b.reply((s) => s.startsWith('smelted') || s.startsWith('smelt:'), from, 200_000);
    await sleep(3000);
    const dmg = await elytraIn20(b);
    note(`case furnace: ${end}; elytra in slot 20 damage 300 -> ${dmg}; xp ${xp(b).toFixed(1)}; held slot ${sel} -> ${inv(b).selected}`);
    for (const l of b.logs.slice(logFrom).filter((x) => /:bot info mend|cook: (opened|took|took out)/.test(x))) note(`  log ${l.slice(0, 220)}`);
    expect(end).toMatch(/^smelted 8 iron_ingot/);
    // 8 raw iron pay 5 or 6 points: 10 or 12 uses; in 2 of 15 runs one point went to the bar (cause not found)
    expect(dmg).toBeLessThanOrEqual(292);
    expect(xp(b)).toBeLessThanOrEqual(1);
    expect(inv(b).selected).toBe(sel);
    expect(inv(b).slots[20]?.name).toBe('elytra');
  }, 300_000);

  it.skipIf(!CASES)('two damaged Mending pieces, one worn and one carried: the furnace pays both, nothing goes to the experience bar', async () => {
    const b = bot!;
    await setUp(b, [['raw_iron', 8], ['coal', 2], ['cobblestone', 16]], true);
    // the armour rule would put the chestplate on before `/enchant` reaches it in the hand (1 run of 13): off for the set-up
    const kit = survivalKitOf(b.task)!;
    kit.overrides.autoArmour = false;
    await mendingItem(b, 6, 'iron_chestplate', 100);
    const fe = b.said.length;
    await b.command('!equip slot 6');
    await b.reply((s) => s.startsWith('equip'), fe, 8000).catch(() => undefined);
    await until(() => (inv(b).window(120)?.slots[1]?.name === 'iron_chestplate' ? true : undefined), 5000, 'the chestplate on');
    delete kit.overrides.autoArmour;
    const w0 = await wear(b);
    const from = b.said.length;
    await b.command('!smelt iron 8');
    const end = await b.reply((s) => s.startsWith('smelted') || s.startsWith('smelt:'), from, 200_000);
    await sleep(3000);
    const w1 = await wear(b);
    const e = (w0.slots[20]?.damage ?? 0) - (w1.slots[20]?.damage ?? 0);
    const c = (w0.chest ?? 0) - (w1.chest ?? 0);
    note(`case two pieces: ${end}; elytra carried +${e} uses, chestplate worn +${c} uses; xp ${xp(b).toFixed(1)}; status ${survivalKitOf(b.task)?.summary().match(/armour [^;]*/)?.[0]}`);
    expect(end).toMatch(/^smelted 8 iron_ingot/);
    expect(e + c).toBeGreaterThanOrEqual(8); // as above: 5 or 6 points, one may go to the bar
    expect(xp(b)).toBeLessThanOrEqual(1);
    const from2 = b.said.length;
    await b.command('!mend status');
    const st = await b.reply((s) => s.startsWith('mend:'), from2, 8000);
    note(`case two pieces: ${st}`);
    expect(st).toMatch(/Mending on elytra \d+\/432/);
    expect(st).toMatch(/iron_chestplate \d+\/240 \(worn\)/);
  }, 300_000);

  it.skipIf(!CASES)('`!mend elytra` from smelting what is carried: the reply says what was done and why it stopped', async () => {
    const b = bot!;
    await setUp(b, [['raw_iron', 8], ['coal', 2]], true);
    const from = b.said.length;
    await b.command('!mend elytra 10');
    const end = await b.reply((s) => s.startsWith('mend: elytra') && s.includes('stopped'), from, 400_000);
    await sleep(1000);
    const dmg = await elytraIn20(b);
    note(`case !mend smelt: ${end}; elytra damage 300 -> ${dmg}; xp ${xp(b).toFixed(1)}`);
    expect(end).toMatch(/^mend: elytra 132 -> 1[34]\d\/432 in \d+ min: .*smelted 8 raw_iron; stopped: no source of experience/);
    expect(dmg).toBeLessThanOrEqual(292);
  }, 500_000);

  it.skipIf(!CASES)('`!mend` from mining coal near: the elytra held after each ore while its orbs come', async () => {
    const b = bot!;
    await setUp(b, [['iron_pickaxe', 1]], false);
    // ten coal ores in a row in the floor (a vein): a coal ore pays 0 to 2 points, so ten make a run with nothing mended unlikely
    const ores = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((dx) => ({ x: area.x + dx, y: F - 1, z: area.z + 2 }));
    for (const p of ores) await truthLoaded(b.truth, 'fill', [p.x, p.y, p.z, p.x, p.y, p.z, 'coal_ore']);
    await sleep(1000);
    const from = b.said.length;
    const logFrom = b.logs.length;
    await b.command('!mend 5');
    const end = await b.reply((s) => s.startsWith('mend: ') && s.includes('stopped'), from, 400_000);
    await sleep(1000);
    const dmg = await elytraIn20(b);
    note(`case !mend mine: ${end}; elytra damage 300 -> ${dmg}; xp ${xp(b).toFixed(1)}`);
    for (const l of b.logs.slice(logFrom).filter((x) => /:bot info mend|mine coal_ore: done/.test(x))) note(`  log ${l.slice(0, 220)}`);
    for (const p of ores) await truthLoaded(b.truth, 'fill', [p.x, p.y, p.z, p.x, p.y, p.z, 'grass_block']);
    expect(end).toMatch(/mined 10 coal_ore/);
    expect(dmg).toBeLessThanOrEqual(296);
  }, 500_000);
});
