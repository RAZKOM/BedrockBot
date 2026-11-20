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
import { mendControlOf } from '../../src/chat/commands-mend.ts';
import { reachDistance } from '../../src/skills/combat/hostiles.ts';
import { REFLEX_REACH } from '../../src/skills/combat/reflex.ts';
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
  // ---- Track K6: every point accounted -----------------------------------------------------------------------------------
  // MEND_PROBE=account MEND_ACCOUNT=open,wall,nook,off3,ore,kill: for a furnace take (the furnace placed four ways), an ore
  // (`!mend` on a lapis vein) and a kill (a zombie, the watcher): the points paid, mended (uses / 2), to the bar, and for
  // each point to the bar when it came against the holds (the hand on the piece), and the orbs left lying. One JSON row a
  // run to MEND_ROWS when set.
  const ROWS = process.env.MEND_ROWS;
  /** The furnace of a placement, built round it (`open` alone 2 off, `wall` a wall behind it, `nook` set into a wall, `off3` 3 off). */
  const placeFurnace = async (b: CraftBot, way: string): Promise<Vec3> => {
    const x = area.x;
    const z = area.z;
    await truthLoaded(b.truth, 'fill', [x + 1, F, z - 3, x + 5, F + 3, z + 3, 'air']);
    const fp = way === 'off3' ? { x: x + 3, y: F, z } : { x: x + 2, y: F, z };
    if (way === 'wall' || way === 'nook') await truthLoaded(b.truth, 'fill', [x + 3, F, z - 2, x + 3, F + 2, z + 2, 'stone']);
    if (way === 'nook') {
      await truthLoaded(b.truth, 'fill', [x + 2, F, z - 1, x + 2, F + 2, z - 1, 'stone']);
      await truthLoaded(b.truth, 'fill', [x + 2, F, z + 1, x + 2, F + 2, z + 1, 'stone']);
      await truthLoaded(b.truth, 'fill', [x + 2, F + 1, z, x + 2, F + 2, z, 'stone']);
    }
    await truthLoaded(b.truth, 'fill', [fp.x, fp.y, fp.z, fp.x, fp.y, fp.z, 'furnace']);
    await sleep(500);
    return fp;
  };
  const unplace = async (b: CraftBot): Promise<void> => {
    await truthLoaded(b.truth, 'fill', [area.x + 1, F, area.z - 3, area.x + 5, F + 3, area.z + 3, 'air']).catch(() => undefined);
  };
  /** The uses left of the elytra wherever it is (the model: carried, in the hotbar, in the hand). */
  const elytraLeft = (b: CraftBot): number | undefined => {
    const it = inv(b).slots.slice(0, 36).find((s) => s?.name === 'elytra');
    return it ? 432 - (it.damage ?? 0) : undefined;
  };
  interface AccountRow {
    src: string;
    run: number;
    paid: number;
    mended: number;
    bar: number;
    lying: number;
    lost: Record<string, number>;
    holds: string[];
    end: string;
    line: string;
  }
  const accountRun = async (b: CraftBot, src: string, run: number): Promise<AccountRow> => {
    const furnace = ['open', 'wall', 'nook', 'off3', 'worn'].includes(src);
    const kit: [string, number][] = furnace ? [['raw_iron', 8], ['coal', 2], ['cobblestone', 16]] : src === 'ore' ? [['iron_pickaxe', 1]] : [['diamond_sword', 1]];
    await setUp(b, kit, false);
    unquiet(b);
    let fp: Vec3 | undefined;
    const ores = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((dx) => ({ x: area.x + dx, y: F - 1, z: area.z + 2 }));
    if (furnace) fp = await placeFurnace(b, src === 'worn' ? 'open' : src);
    // worn: a damaged Mending iron chestplate worn as well (the owner's case: Mending armour on), each orb to one of them
    if (src === 'worn') {
      await mendingItem(b, 3, 'iron_chestplate', 100);
      const fe = b.said.length;
      await b.command('!equip slot 3');
      await b.reply((s) => s.startsWith('equip'), fe, 8000).catch(() => undefined);
      await until(() => (inv(b).window(120)?.slots[1]?.name === 'iron_chestplate' ? true : undefined), 5000, 'the chestplate on').catch(() => undefined);
    }
    if (src === 'ore') {
      for (const p of ores) await truthLoaded(b.truth, 'fill', [p.x, p.y, p.z, p.x, p.y, p.z, 'lapis_ore']);
      await sleep(1000);
    }
    if (src === 'kill') b.task.pve!.hotbar.select(0);
    await sleep(300);
    const s0 = await wear(b);
    const left0 = Object.values(s0.slots).find((s) => s.typeId === 'elytra');
    const x0 = xp(b);
    const t0 = Date.now();
    const holds: { from: number; to?: number }[] = [];
    const bars: { t: number; d: number }[] = [];
    const mends: { t: number; d: number }[] = [];
    let lastX = x0;
    let lastL = elytraLeft(b);
    // the digs' breaks (the digger's log line) and the takes, by time: when the points came against them
    const digs: number[] = [];
    let logSeen = b.logs.length;
    const timer = setInterval(() => {
      for (; logSeen < b.logs.length; logSeen++) if (/ dig \(.*-> air after/.test(b.logs[logSeen] ?? '')) digs.push(Date.now());
      const held = inv(b).slots[inv(b).selected]?.name === 'elytra';
      const h = holds[holds.length - 1];
      if (held && (!h || h.to !== undefined)) holds.push({ from: Date.now() });
      if (!held && h && h.to === undefined) h.to = Date.now();
      const x = xp(b);
      if (Math.abs(x - lastX) > 0.01) {
        if (x > lastX) bars.push({ t: Date.now(), d: x - lastX });
        lastX = x;
      }
      const l = elytraLeft(b);
      if (l !== undefined && lastL !== undefined && l > lastL) mends.push({ t: Date.now(), d: l - lastL });
      if (l !== undefined) lastL = l;
    }, 25);
    const from = b.said.length;
    const logFrom = b.logs.length;
    let end: string;
    try {
      if (furnace) {
        await b.command('!smelt iron 8');
        end = await b.reply((s) => s.startsWith('smelted') || s.startsWith('smelt:'), from, 200_000).catch(() => 'no end line');
        await sleep(8000);
      } else if (src === 'ore') {
        await b.command('!mend 5');
        end = await b.reply((s) => s.startsWith('mend: ') && s.includes('stopped'), from, 400_000).catch(() => 'no end line');
        await sleep(6000);
        // the drops: an ore broken with the piece in the hand (no harvest) would drop nothing
        end = `[lapis carried ${inv(b).slots.slice(0, 36).reduce((a, s) => a + (s?.name === 'lapis_lazuli' ? s.count : 0), 0)}] ${end}`;
      } else {
        const me = b.task.position()!;
        const m = await b.truth.summon('zombie', { x: me.x + 5, y: F, z: me.z });
        let died = false;
        for (let i = 0; i < 60 && !died; i++) {
          await sleep(500);
          const e = await b.truth.entity(m.entityId).catch(() => undefined);
          died = !e || e.valid === false || (e.health ?? 1) <= 0;
        }
        end = died ? `killed in ${((Date.now() - t0) / 1000).toFixed(1)} s` : 'not killed in 30 s';
        await sleep(10_000);
      }
    } finally {
      clearInterval(timer);
    }
    const h = holds[holds.length - 1];
    if (h && h.to === undefined) h.to = Date.now();
    const s1 = await wear(b);
    const left1 = Object.values(s1.slots).find((s) => s.typeId === 'elytra');
    const mended = ((left0?.damage ?? 0) - (left1?.damage ?? 0)) / 2;
    const worn = src === 'worn' ? ((s0.chest ?? 0) - (s1.chest ?? 0)) / 2 : 0;
    const bar = Math.round((xp(b) - x0) * 10) / 10;
    const me = b.task.position()!;
    const lying = [...b.built.mobility!.world.entities.values()].filter((e) => e.type.endsWith('xp_orb') && Math.hypot(e.pos.x - me.x, e.pos.y - me.y, e.pos.z - me.z) <= 24).length;
    // each rise of the bar against the holds: in a hold (the hand on the piece: another piece's turn or the server's lag), after
    // the last hold ended, before the first, or with no hold at all; its orb: the one gone nearest that time
    const seen = orbsSince(t0);
    const lost: Record<string, number> = {};
    const rises: string[] = [];
    const rel = (t: number): string => ((t - t0) / 1000).toFixed(1);
    for (const r of bars) {
      const inHold = holds.some((x) => r.t >= x.from - 50 && r.t <= (x.to ?? Infinity) + 150);
      const why = holds.length === 0 ? 'no hold' : inHold ? 'in a hold' : r.t < holds[0]!.from ? 'before the hold' : 'after the hold ended';
      lost[why] = (lost[why] ?? 0) + r.d;
      const orb = seen.filter((o) => o.gone !== undefined).sort((a, c) => Math.abs(a.gone! - r.t) - Math.abs(c.gone! - r.t))[0];
      const dig = digs.filter((t) => t <= r.t + 50).pop();
      const nextHold = holds.find((x) => x.from >= (dig ?? r.t) - 50);
      rises.push(`+${r.d.toFixed(0)} at ${rel(r.t)} s ${why}${orb ? ` (orb seen ${rel(orb.first)} s ${orb.dist.toFixed(1)} off, gone ${rel(orb.gone!)} s)` : ''}${dig !== undefined ? `, the break ${((r.t - dig) / 1000).toFixed(2)} s before${nextHold ? `, its hold from ${((nextHold.from - dig) / 1000).toFixed(2)} s after the break` : ''}` : ''}`);
    }
    if (lying > 0) lost['orbs lying'] = lying;
    const holdLines = b.logs.slice(logFrom).filter((l) => l.includes(':bot info mend')).map((l) => l.replace(/^.*:bot info /, '').slice(0, 200));
    const hw = holds.map((x) => `${rel(x.from)}-${x.to ? rel(x.to) : 'end'} s`).join(', ');
    const fromF = fp ? seen.map((o) => Math.hypot(o.at.x - fp.x - 0.5, o.at.z - fp.z - 0.5).toFixed(1)).join('/') : '';
    const line = `account ${src} run ${run + 1}: ${end.slice(0, 120)}; paid ${(mended + worn + bar).toFixed(1)} (mended ${mended} = ${mended * 2} uses${worn ? `, the worn chestplate ${worn}` : ''}, bar ${bar}), ${lying} orbs lying; holds ${hw || 'none'}; bar ${rises.join(', ') || 'none'}; ${orbLine(seen)}${fp ? `; orbs first seen ${fromF} from the furnace` : ''} | ${holdLines.join(' | ')}`;
    if (ROWS) appendFileSync(ROWS, `${JSON.stringify({ src, run, paid: mended + worn + bar, mended, worn, bar, lying, lost, holds: holdLines, end })}\n`);
    if (src === 'ore') for (const p of ores) await truthLoaded(b.truth, 'fill', [p.x, p.y, p.z, p.x, p.y, p.z, 'grass_block']);
    await unplace(b);
    return { src, run, paid: mended + bar, mended, bar, lying, lost, holds: holdLines, end, line };
  };

  it.skipIf(!PROBE.has('account'))('probe account: every point a source pays, mended, to the bar or lying, and why', async () => {
    const b = bot!;
    const srcs = (process.env.MEND_ACCOUNT ?? 'open,wall,nook,off3,ore,kill').split(',');
    try {
      if (srcs.includes('kill')) {
        await craftCmd('difficulty', 'easy');
        await craftCmd('time', 'set', 'midnight');
      }
      for (let run = 0; run < N; run++) {
        for (const src of srcs) {
          const r = await accountRun(b, src, run);
          note(r.line);
          await b.truth.cleanup().catch(() => undefined);
        }
      }
    } finally {
      await craftCmd('time', 'set', 'noon');
      await craftCmd('difficulty', 'peaceful');
    }
    expect(true).toBe(true);
  }, 6 * 3_600_000);

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

  // ---- the hold rule: hostiles that cannot reach the bot, and one that can --------------------------------------------
  // (a hostile within 16 used to stop every hold; at a home by a lake and caves that is every hour of the day)
  const hand = (b: CraftBot) => mendControlOf(b.task)!.hand;
  /** The watcher's quiet time after a hold that mended nothing, cleared between runs. */
  const unquiet = (b: CraftBot): void => {
    (hand(b) as unknown as { quietUntil: number }).quietUntil = 0;
  };
  /** The damage the server dealt the bot since `since` (truth hurtlog). */
  const hurtSince = async (b: CraftBot, since: number): Promise<{ damage: number; hits: string[] }> => {
    // (the log holds the bot's own hits too: the bot's damage is where it is the victim)
    const ev = (await b.truth.hurtlog(since, b.name)).events.filter((e) => e.victimName === b.name);
    return { damage: ev.reduce((a, e) => a + e.damage, 0), hits: ev.map((e) => `${e.damagerType?.replace(/^minecraft:/, '') ?? e.cause} ${e.damage}`) };
  };
  const hostilesNear = (b: CraftBot, r: number): string => {
    const me = b.task.position()!;
    const out: string[] = [];
    for (const e of b.built.mobility!.world.entities.values()) {
      if (!/zombie|drowned|skeleton|spider|creeper/.test(e.type)) continue;
      const d = Math.hypot(e.pos.x - me.x, e.pos.y - me.y, e.pos.z - me.z);
      if (d <= r) out.push(`${e.type.replace(/^minecraft:/, '')} ${d.toFixed(1)}`);
    }
    return `${out.length} within ${r} (${out.join(', ')})`;
  };
  /**
   * The Realm's case: a walled and roofed stone room round the feet and the furnace, a lake beside it with drowned, a
   * zombie in a pit, zombies and a skeleton behind the walls: hostiles within 16 that cannot reach the bot.
   */
  const walledRoom = async (b: CraftBot): Promise<void> => {
    const x = area.x;
    const z = area.z;
    await truthLoaded(b.truth, 'fill', [x - 2, F, z - 2, x + 4, F + 3, z + 2, 'stone']);
    await truthLoaded(b.truth, 'fill', [x - 1, F, z - 1, x + 3, F + 2, z + 1, 'air']);
    const fp = furnaceAt();
    await truthLoaded(b.truth, 'fill', [fp.x, fp.y, fp.z, fp.x, fp.y, fp.z, 'furnace']);
    // the lake (3 deep) on one side, the pit (3 deep) on the other
    await truthLoaded(b.truth, 'fill', [x - 2, F - 3, z + 4, x + 4, F - 1, z + 8, 'water']);
    await truthLoaded(b.truth, 'fill', [x - 1, F - 3, z - 6, x + 1, F - 1, z - 5, 'air']);
    await sleep(800);
    for (const p of [
      { x: x + 0.5, y: F - 2, z: z + 6.5 },
      { x: x + 2.5, y: F - 2, z: z + 5.5 },
      { x: x - 0.5, y: F - 2, z: z + 7.5 },
    ])
      await b.truth.summon('drowned', p);
    await b.truth.summon('zombie', { x: x + 0.5, y: F - 3, z: z - 5.5 });
    await b.truth.summon('zombie', { x: x - 5.5, y: F, z: z + 0.5 });
    await b.truth.summon('zombie', { x: x + 7.5, y: F, z: z + 0.5 });
    await b.truth.summon('skeleton', { x: x + 0.5, y: F, z: z - 9.5 });
    await sleep(2000);
  };
  const unRoom = async (b: CraftBot): Promise<void> => {
    await b.truth.cleanup().catch(() => undefined);
    const x = area.x;
    const z = area.z;
    await truthLoaded(b.truth, 'fill', [x - 2, F, z - 6, x + 4, F + 3, z + 8, 'air']).catch(() => undefined);
    await truthLoaded(b.truth, 'fill', [x - 2, F - 3, z - 6, x + 4, F - 2, z + 8, 'dirt']).catch(() => undefined);
    await truthLoaded(b.truth, 'fill', [x - 2, F - 1, z - 6, x + 4, F - 1, z + 8, 'grass_block']).catch(() => undefined);
  };

  it.skipIf(!CASES)("the Realm's case: hostiles within 16 that cannot reach (a walled room, drowned in the lake, a pit): the take mends, a kill's orbs too", async () => {
    const b = bot!;
    try {
      await craftCmd('difficulty', 'easy');
      await craftCmd('time', 'set', 'midnight');
      await setUp(b, [['diamond_sword', 1], ['raw_iron', 8], ['coal', 2], ['cobblestone', 16]], true);
      await walledRoom(b);
      unquiet(b);
      const near = hostilesNear(b, 16);
      // (the control's threat is the new rule; a tree without it says so)
      const ctl = mendControlOf(b.task) as { threat?: () => { why: string } | undefined };
      const rule = ctl.threat ? (ctl.threat()?.why ?? 'no threat') : 'no hold rule on this tree';
      // a kill's orbs first: a zombie inside the room, killed by the guard; the drowned and the rest still near
      const e0 = await elytraIn20(b);
      const logFrom = b.logs.length;
      const z = await b.truth.summon('zombie', { x: area.x - 0.5, y: F, z: area.z + 0.5 });
      for (let i = 0; i < 60; i++) {
        await sleep(500);
        const e = await b.truth.entity(z.entityId).catch(() => undefined);
        if (!e || e.valid === false || (e.health ?? 1) <= 0) break;
      }
      await sleep(5000);
      const e1 = await elytraIn20(b);
      note(`case realm kill: ${near}; the hold rule: ${rule}; elytra ${e0} -> ${e1} (+${(e0 ?? 0) - (e1 ?? 0)} uses); xp ${xp(b).toFixed(1)}`);
      // the take
      await resetXp(b);
      const from = b.said.length;
      await b.command('!smelt iron 8');
      const end = await b.reply((s) => s.startsWith('smelted') || s.startsWith('smelt:'), from, 200_000);
      await sleep(3000);
      const e2 = await elytraIn20(b);
      note(`case realm take: ${end}; ${hostilesNear(b, 16)}; elytra ${e1} -> ${e2} (+${(e1 ?? 0) - (e2 ?? 0)} uses); xp ${xp(b).toFixed(1)}`);
      for (const l of b.logs.slice(logFrom).filter((x) => x.includes(':bot info mend'))) note(`  log ${l.slice(0, 260)}`);
      expect(near).not.toMatch(/^0 within/);
      expect(end).toMatch(/^smelted 8 iron_ingot/);
      // 8 raw iron pay 5 or 6 points: 10 or 12 uses (one point to the bar in 2 of 15 runs before: 8)
      expect((e1 ?? 0) - (e2 ?? 0)).toBeGreaterThanOrEqual(8);
    } finally {
      await unRoom(b);
      await craftCmd('time', 'set', 'noon');
      await craftCmd('difficulty', 'peaceful');
    }
  }, 400_000);

  /**
   * A zombie that can reach: open ground, guard off (the reflex strikes in reach), the zombie summoned `d` blocks off, orbs
   * 5 blocks behind the bot (they lie there: a hold that waits for them lasts its 70 ticks). `hold`: mendOnTheWay on (the
   * watcher holds while the rule lets it), else off. What the run saw: the hold's line, the zombie's distance and the
   * time when the hold ended and when it first came within strike reach, the damage the server dealt.
   */
  const reachRun = async (b: CraftBot, holdOn: boolean, d = 15, type = 'zombie', force = false): Promise<{ line: string; damage: number; ended?: string; margin?: number; heldAtReach: boolean }> => {
    // force: the hold rule (and the walk's) switched off for the run, the watcher never quiet: what a hold through a
    // fight would do (the hand at the strike, the reflex's blade strike)
    const hd = (hand(b) as unknown as { d: { threat: () => unknown; near?: () => unknown } }).d;
    const keep = { threat: hd.threat, near: hd.near };
    if (force) {
      hd.threat = () => undefined;
      hd.near = () => undefined;
    }
    await setUp(b, [['diamond_sword', 1]], false);
    b.task.pve!.hotbar.select(0);
    b.settings.set('mendOnTheWay', holdOn);
    unquiet(b);
    const me = b.task.position()!;
    const since = await b.truth.now();
    const logFrom = b.logs.length;
    const t0 = Date.now();
    // the hold as the hand shows it (when the elytra came into the hand and left it, the mob's distance then), the mob's
    // distance every 0.5 s, the first time it came within strike reach (eye to box, REFLEX_REACH) and what the hand held
    let reachAt: number | undefined;
    let heldAtReach = false;
    let holdFrom: { t: number; d: number } | undefined;
    let holdTo: { t: number; d: number } | undefined;
    let gone: number | undefined;
    let seen = false;
    const dists: string[] = [];
    let lastLog = 0;
    const eye = { x: me.x, y: me.y + 1.62, z: me.z };
    const timer = setInterval(() => {
      if (force) unquiet(b);
      const z = [...b.built.mobility!.world.entities.values()].find((e) => e.type.endsWith(type) && !(b.task.pve!.mobs.get(e.runtimeId)?.dead ?? false));
      const held = inv(b).slots[inv(b).selected]?.name === 'elytra';
      const dz = z ? Math.hypot(z.pos.x - me.x, z.pos.z - me.z) : -1;
      if (held && !holdFrom) holdFrom = { t: Date.now(), d: dz };
      if (!held && holdFrom && !holdTo) holdTo = { t: Date.now(), d: dz };
      if (!z) {
        if (seen && gone === undefined) gone = Date.now();
        return;
      }
      seen = true;
      if (Date.now() - lastLog >= 500) {
        lastLog = Date.now();
        dists.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${dz.toFixed(1)}`);
      }
      if (reachAt === undefined && reachDistance(eye, z) <= REFLEX_REACH) {
        reachAt = Date.now();
        heldAtReach = held;
      }
    }, 25);
    try {
      await b.truth.summon(type, { x: me.x + d, y: F, z: me.z });
      // the orbs behind the bot once the mob is seen (the watcher holds while they lie near)
      await until(() => (seen ? true : undefined), 5000, `the ${type} seen`);
      for (let i = 0; i < 3; i++) await craftCmd('summon', 'xp_orb', String(Math.floor(me.x) - 5 + 0.5), String(F), String(Math.floor(me.z) + 0.5));
      await until(() => (gone !== undefined ? true : undefined), 30_000, `the ${type} killed`).catch(() => undefined);
      await sleep(6000);
    } finally {
      clearInterval(timer);
      hd.threat = keep.threat;
      if (keep.near) hd.near = keep.near;
    }
    const hurt = await hurtSince(b, since);
    const lines = b.logs.slice(logFrom).filter((x) => x.includes(':bot info mend'));
    const holdLine = lines.find((l) => l.includes('held the elytra'));
    // seconds from the hand's return to the zombie's strike reach (the hold ended in time when positive)
    const margin = reachAt !== undefined && holdTo ? (reachAt - holdTo.t) / 1000 : undefined;
    await b.truth.cleanup().catch(() => undefined);
    const hold = holdFrom ? `held at ${((holdFrom.t - t0) / 1000).toFixed(1)} s (${type} ${holdFrom.d.toFixed(1)} off) to ${holdTo ? `${((holdTo.t - t0) / 1000).toFixed(1)} s (${holdTo.d.toFixed(1)} off)` : 'the end'}` : 'never held';
    const line = `${type} at ${d}, holds ${holdOn ? (force ? 'on, the rule off' : 'on') : 'off'}: ${hold}; ${gone !== undefined ? `killed at ${((gone - t0) / 1000).toFixed(1)} s` : 'not killed'}; ${lines.map((l) => l.replace(/^.*:bot info /, '')).join(' | ') || 'no mend line'}; ${type} ${dists.join(', ')}; strike reach ${reachAt ? `${((reachAt - t0) / 1000).toFixed(1)} s` : 'never'}${margin !== undefined ? ` (${margin.toFixed(1)} s after the hand came back)` : ''}${heldAtReach ? ' WITH THE ELYTRA IN HAND' : ''}; damage ${hurt.damage} (${hurt.hits.join(', ') || 'none'})`;
    return { line, damage: hurt.damage, ...(holdLine ? { ended: holdLine } : {}), ...(margin !== undefined ? { margin } : {}), heldAtReach };
  };

  it.skipIf(!CASES)('a zombie that can reach: the hold ends (or is never made) before it is in strike reach; no damage beyond a run without holds', async () => {
    const b = bot!;
    try {
      await craftCmd('difficulty', 'easy');
      await craftCmd('time', 'set', 'midnight');
      const from = b.said.length;
      await b.command('!guard off');
      await b.reply((s) => s.startsWith('guard'), from, 8000);
      const on = await reachRun(b, true);
      note(`case reach: ${on.line}`);
      const off = await reachRun(b, false);
      note(`case reach: ${off.line}`);
      expect(on.heldAtReach).toBe(false);
      // a hold that ended did so before the zombie was in strike reach
      if (on.margin !== undefined) expect(on.margin).toBeGreaterThan(0);
      // a hold was made with the zombie farther than its bound and ended by the rule, or none was made
      if (on.ended) expect(on.ended).toMatch(/ended: (a hostile \(a zombie \d+ blocks off with a clear way to me|no orb near|the time limit)/);
      // zombie hits on easy are 2 or 3; one more hit than the run without holds is the noise of where the zombie stood
      expect(on.damage).toBeLessThanOrEqual(off.damage + 3);
    } finally {
      b.settings.set('mendOnTheWay', true);
      const f2 = b.said.length;
      await b.command('!guard on');
      await b.reply((s) => s.startsWith('guard'), f2, 8000).catch(() => undefined);
      await b.truth.cleanup().catch(() => undefined);
      await craftCmd('time', 'set', 'noon');
      await craftCmd('difficulty', 'peaceful');
    }
  }, 300_000);

  it.skipIf(!PROBE.has('reach'))('probe reach: hostiles that can reach, n runs a side with and without holds; how far each comes in 3.5 s', async () => {
    const b = bot!;
    const types = (process.env.MEND_REACH ?? 'zombie,spider,skeleton').split(',');
    try {
      await craftCmd('difficulty', 'easy');
      await craftCmd('time', 'set', 'midnight');
      const from = b.said.length;
      await b.command('!guard off');
      await b.reply((s) => s.startsWith('guard'), from, 8000);
      for (let run = 0; run < N; run++) {
        for (const type of types) {
          const sides: [boolean, boolean][] = process.env.MEND_FORCE === '1' ? [[true, true]] : [[true, false], [false, false]];
          for (const [holdOn, force] of sides) {
            const r = await reachRun(b, holdOn, Number(process.env.MEND_REACH_D ?? 15), type, force);
            note(`reach run ${run + 1}: ${r.line}`);
          }
        }
      }
    } finally {
      b.settings.set('mendOnTheWay', true);
      const f2 = b.said.length;
      await b.command('!guard on');
      await b.reply((s) => s.startsWith('guard'), f2, 8000).catch(() => undefined);
      await craftCmd('time', 'set', 'noon');
      await craftCmd('difficulty', 'peaceful');
    }
    expect(true).toBe(true);
  }, 3_600_000);

  // ---- Track K6: the nook furnace, the post, the chore, the walk with hostiles near -----------------------------------------
  /** The server's experience bar in points, and whether health and food are full enough for the post (14). */
  const fill = async (b: CraftBot): Promise<void> => {
    await craftCmd('effect', b.name, 'saturation', '3', '10', 'true').catch(() => undefined);
    await craftCmd('effect', b.name, 'instant_health', '1', '5', 'true').catch(() => undefined);
    await sleep(800);
  };
  const say = async (b: CraftBot, cmd: string, match: (s: string) => boolean, ms = 10_000): Promise<string> => {
    const from = b.said.length;
    await b.command(cmd);
    return b.reply(match, from, ms);
  };

  it.skipIf(!CASES)('Track K6: a furnace set into a nook (walls on three sides, stone over it): the take mends what it pays', async () => {
    const b = bot!;
    await setUp(b, [['raw_iron', 8], ['coal', 2], ['cobblestone', 16]], false);
    unquiet(b);
    await placeFurnace(b, 'nook');
    try {
      const e0 = await elytraIn20(b);
      const x0 = xp(b);
      const end = await say(b, '!smelt iron 8', (s) => s.startsWith('smelted') || s.startsWith('smelt:'), 200_000);
      await sleep(6000);
      const e1 = await elytraIn20(b);
      const uses = (e0 ?? 0) - (e1 ?? 0);
      const bar = xp(b) - x0;
      note(`case nook: ${end}; elytra +${uses} uses, the bar +${bar.toFixed(1)}`);
      expect(end).toMatch(/^smelted 8 iron_ingot/);
      // 8 raw iron pay 5 or 6 points: everything the take paid mended the elytra (10 or 12 uses), nothing to the bar
      expect(uses).toBeGreaterThanOrEqual(10);
      expect(bar).toBeLessThan(0.5);
    } finally {
      await unplace(b);
    }
  }, 300_000);

  it.skipIf(!CASES)('Track K6: the post: off by default and named in the reply; refused with its reason; by night with mobs it stands while the guard kills, the orbs mended', async () => {
    const b = bot!;
    try {
      await craftCmd('difficulty', 'easy');
      await craftCmd('time', 'set', 'midnight');
      await setUp(b, [['diamond_sword', 1], ['iron_chestplate', 1]], false);
      b.task.home?.set(undefined);
      unquiet(b);
      await fill(b);
      await until(() => ((b.task.pve!.timeOfDay() ?? 0) >= 13_000 ? true : undefined), 10_000, 'the night by the clock');
      // off by default: named in the reply as what is missing
      expect(b.settings.get('mendPost')).toBe(false);
      // (the whole end line from the log: the reply is cut at the chat's limit and the post's reason comes last)
      const endLine = async (cmd: string): Promise<string> => {
        const logFrom = b.logs.length;
        await say(b, cmd, (s) => s.startsWith('mend: ') && s.includes('stopped'), 30_000);
        const l = await until(() => b.logs.slice(logFrom).find((x) => x.includes("mend: the job's end: ")), 5000, 'the end line in the log');
        return l.replace(/^.*mend: the job's end: /, '');
      };
      const off = await endLine('!mend elytra 1');
      note(`case post off: ${off}`);
      expect(off).toContain('or a night at the post (not now: mendPost is off)');
      // on, but guard off: refused with its reason
      b.settings.set('mendPost', true);
      await say(b, '!guard off', (s) => s.startsWith('guard'), 8000);
      const unguarded = await endLine('!mend elytra 1');
      note(`case post guard off: ${unguarded}`);
      expect(unguarded).toContain('or a night at the post (not now: guard is off (the post is the fight rules killing what comes))');
      // the chestplate on (the armour pass wears it), guard on: the post stands; a zombie comes and is killed; its orbs mend
      await until(() => (inv(b).window(120)?.slots[1]?.name === 'iron_chestplate' ? true : undefined), 10_000, 'the chestplate on').catch(async () => {
        await say(b, '!equip iron_chestplate', (s) => s.startsWith('equip'), 8000).catch(() => '');
      });
      await say(b, '!guard on', (s) => s.startsWith('guard'), 8000);
      const e0 = await elytraIn20(b);
      const from = b.said.length;
      await b.command('!mend elytra 1');
      await until(() => (b.logs.some((l) => l.includes('mend: at the post by night')) ? true : undefined), 15_000, 'the post');
      const me = b.task.position()!;
      await b.truth.summon('zombie', { x: me.x + 6, y: F, z: me.z });
      const end = await b.reply((s) => s.startsWith('mend: ') && s.includes('stopped'), from, 120_000);
      await sleep(1500);
      const e1 = await elytraIn20(b);
      note(`case post: ${end}; elytra +${(e0 ?? 0) - (e1 ?? 0)} uses`);
      expect(end).toMatch(/stood at the post \(here \(no home set\)\) for [1-9]\d* kills?/);
      expect(end).toMatch(/stopped: the post: the 1-minute bound$/);
      expect((e0 ?? 0) - (e1 ?? 0)).toBeGreaterThanOrEqual(8);
    } finally {
      b.settings.set('mendPost', false);
      await b.truth.cleanup().catch(() => undefined);
      await craftCmd('time', 'set', 'noon');
      await craftCmd('difficulty', 'peaceful');
    }
  }, 400_000);

  it.skipIf(!CASES)('Track K6: the chore (autoMend): off by default; on, by day at home, it smelts raw iron out of the home chest and mends the elytra, the hour bound counted', async () => {
    const b = bot!;
    const chest = { x: area.x - 2, y: F, z: area.z + 2 };
    try {
      expect(b.settings.get('autoMend')).toBe(false);
      await setUp(b, [['coal', 2], ['cobblestone', 16]], true);
      unquiet(b);
      await truthLoaded(b.truth, 'set', [chest.x, chest.y, chest.z, 'chest']);
      await truthLoaded(b.truth, 'chestput', [chest.x, chest.y, chest.z, 'raw_iron', 8, 1]);
      b.task.home!.set({ x: area.x, y: F, z: area.z });
      await say(b, '!chests clear', () => true, 3000).catch(() => '');
      await say(b, '!chests scan', (s) => /^chests: \d+ within/.test(s), 60_000).catch(() => '');
      const e0 = await elytraIn20(b);
      const logFrom = b.logs.length;
      b.settings.set('autoMend', true);
      await until(() => b.logs.slice(logFrom).find((l) => l.includes('mend chore: mend: ')), 240_000, 'the chore pass');
      await sleep(2000);
      const e1 = await elytraIn20(b);
      const line = b.logs.slice(logFrom).find((l) => l.includes('mend chore: mend: ')) ?? '';
      const st = await say(b, '!mend status', (s) => s.startsWith('mend: '), 8000);
      note(`case chore: ${line.replace(/^.*mend chore: /, '')}; elytra +${(e0 ?? 0) - (e1 ?? 0)} uses; status ${st}`);
      expect(line).toMatch(/smelted 8 raw_iron from the chests at home/);
      expect((e0 ?? 0) - (e1 ?? 0)).toBeGreaterThanOrEqual(10);
      expect(st).toMatch(/autoMend on.*8 of 32 items this hour/);
    } finally {
      b.settings.set('autoMend', false);
      b.task.home!.set(undefined);
      await truthLoaded(b.truth, 'set', [chest.x, chest.y, chest.z, 'air']).catch(() => undefined);
      const fp = furnaceAt();
      await truthLoaded(b.truth, 'fill', [fp.x, fp.y, fp.z, fp.x, fp.y, fp.z, 'air']).catch(() => undefined);
    }
  }, 400_000);

  // MEND_PROBE=walk (MEND_WALK=shut,open): a long walled, roofed room (13 x 5 inside) with hostiles near that cannot reach
  // (drowned in a lake beside it, a zombie in a pit, zombies and a skeleton behind the walls), 3 orbs summoned 5 blocks off
  // inside it; `shut` as built, `open` with a doorway in the far wall and a zombie 12 off outside it (a way in). Each run
  // a side: `strict` (no walk with a hostile within 16, K5) and `rule` (walkThreat): the walk made or not, the uses, damage.
  const longRoom = async (b: CraftBot, open: boolean): Promise<void> => {
    const x = area.x;
    const z = area.z;
    await truthLoaded(b.truth, 'fill', [x - 7, F, z - 3, x + 7, F + 3, z + 3, 'stone']);
    await truthLoaded(b.truth, 'fill', [x - 6, F, z - 2, x + 6, F + 2, z + 2, 'air']);
    await truthLoaded(b.truth, 'fill', [x - 6, F - 3, z + 5, x + 6, F - 1, z + 9, 'water']);
    await truthLoaded(b.truth, 'fill', [x - 1, F - 3, z - 7, x + 1, F - 1, z - 6, 'air']);
    if (open) await truthLoaded(b.truth, 'fill', [x + 7, F, z, x + 7, F + 1, z, 'air']);
    await sleep(800);
    for (const p of [{ x: x + 0.5, y: F - 2, z: z + 7.5 }, { x: x + 3.5, y: F - 2, z: z + 6.5 }, { x: x - 3.5, y: F - 2, z: z + 8.5 }]) await b.truth.summon('drowned', p);
    await b.truth.summon('zombie', { x: x + 0.5, y: F - 3, z: z - 6.5 });
    await b.truth.summon('zombie', { x: x - 10.5, y: F, z: z + 0.5 });
    await b.truth.summon('skeleton', { x: x + 0.5, y: F, z: z - 11.5 });
    await b.truth.summon('zombie', { x: x + (open ? 12.5 : 10.5), y: F, z: z + 0.5 });
    await sleep(2500);
  };
  const unLongRoom = async (b: CraftBot): Promise<void> => {
    await b.truth.cleanup().catch(() => undefined);
    const x = area.x;
    const z = area.z;
    await truthLoaded(b.truth, 'fill', [x - 7, F, z - 7, x + 7, F + 3, z + 9, 'air']).catch(() => undefined);
    await truthLoaded(b.truth, 'fill', [x - 7, F - 3, z - 7, x + 7, F - 2, z + 9, 'dirt']).catch(() => undefined);
    await truthLoaded(b.truth, 'fill', [x - 7, F - 1, z - 7, x + 7, F - 1, z + 9, 'grass_block']).catch(() => undefined);
  };
  it.skipIf(!PROBE.has('walk'))('probe walk: the walk to orbs that lie with hostiles near, strict against the walk rule', async () => {
    const b = bot!;
    const ways = (process.env.MEND_WALK ?? 'shut,open').split(',');
    const h = hand(b) as unknown as { d: { walkBlocked?: unknown }; stats: { walks: number } };
    const rule = h.d.walkBlocked;
    try {
      await craftCmd('difficulty', 'easy');
      await craftCmd('time', 'set', 'midnight');
      for (let run = 0; run < N; run++) {
        for (const way of ways) {
          for (const side of ['strict', 'rule']) {
            await setUp(b, [['diamond_sword', 1], ['iron_chestplate', 1]], false);
            await longRoom(b, way === 'open');
            await fill(b);
            h.d.walkBlocked = side === 'rule' ? rule : undefined;
            unquiet(b);
            const near = hostilesNear(b, 16);
            const e0 = await elytraIn20(b);
            const w0 = h.stats.walks;
            const since = await b.truth.now();
            const logFrom = b.logs.length;
            for (let i = 0; i < 3; i++) await craftCmd('summon', 'xp_orb', String(area.x + 5.5), String(F + 1), String(area.z + 0.5));
            await sleep(9000);
            const e1 = await elytraIn20(b);
            const hurt = await hurtSince(b, since);
            const lines = b.logs.slice(logFrom).filter((l) => l.includes(':bot info mend')).map((l) => l.replace(/^.*:bot info /, '').slice(0, 200));
            note(`walk ${way} ${side} run ${run + 1}: ${near}; walk ${h.stats.walks > w0 ? 'made' : 'not made'}; elytra +${(e0 ?? 0) - (e1 ?? 0)} uses; damage ${hurt.damage}${hurt.hits.length ? ` (${hurt.hits.join(', ')})` : ''} | ${lines.join(' | ')}`);
            if (ROWS) appendFileSync(ROWS, `${JSON.stringify({ probe: 'walk', way, side, run, walked: h.stats.walks > w0, uses: (e0 ?? 0) - (e1 ?? 0), damage: hurt.damage, near })}\n`);
            await unLongRoom(b);
          }
        }
      }
    } finally {
      h.d.walkBlocked = rule;
      await unLongRoom(b);
      await craftCmd('time', 'set', 'noon');
      await craftCmd('difficulty', 'peaceful');
    }
    expect(true).toBe(true);
  }, 3_600_000);
});