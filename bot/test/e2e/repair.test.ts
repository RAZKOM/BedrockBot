// e2e (tag @bds), Track K7: renewing a worn elytra at an anvil, on a flat, peaceful server with the truth pack (bds-craft by
// default; CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER point it at another, the track ran on bds-farm). The bot's own `!repair`:
// a worn elytra renewed with phantom membranes (taken off, repaired, put on again), two elytras combined (the Mending one
// the base), a refusal for too few levels, the penalty after four renewals and a refusal as too expensive (40 levels).
// REPAIR_PROBE=wire: the anvil over the protocol, one variant a run (REPAIR_WIRE), every packet the anvil touches logged to
// REPAIR_OUT. REPAIR_PROBE=ops: runs of operations (REPAIR_RUNS `setup|ops|levels|label;...`, see the probe) with the levels
// paid and the server's item after each (the measurements of docs/flight.md "Renewing an elytra at an anvil").
// Env: CRAFT_BDS_HOST / CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER (craft-truth.ts), CRAFT_VERBOSE=1, REPAIR_OUT=<file>.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/world/types.ts';
import { clickBlockTransaction } from '../../src/skills/container/chest.ts';
import { blockCenter, EYE_HEIGHT, faceToward, lookAngles } from '../../src/skills/dig/look.ts';
import { survivalKitOf } from '../../src/chat/commands-survival.ts';
import { clearArea, craftCmd, E2E, FEET_Y, prepareServer, privateArea, sleep, startCraftBot, teleport, truthLoaded, until, type CraftBot } from './craft-truth.ts';

const F = FEET_Y;
const PROBE = new Set((process.env.REPAIR_PROBE ?? '').split(',').filter((s) => s !== ''));
const OUT = process.env.REPAIR_OUT;

const json = (v: unknown, n = 600): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x))?.slice(0, n) ?? 'undefined';

describe.skipIf(!E2E)('@bds repair: a worn elytra renewed at an anvil (Track K7)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: CraftBot | undefined;
  const feet = { x: area.x + 0.5, y: F, z: area.z + 0.5 };
  const anvilAt: Vec3 = { x: area.x + 2, y: F, z: area.z };
  const note = (line: string): void => {
    notes.push(line);
    console.log(line);
    if (OUT) appendFileSync(OUT, `${new Date().toISOString()} ${line}\n`);
  };
  const inv = (b: CraftBot) => b.built.mobility!.world.inventory;
  const self = (b: CraftBot) => b.built.mobility!.world.self;

  beforeAll(async () => {
    await prepareServer();
    const b = await startCraftBot('Repair');
    bot = b;
    b.settings.set('autoUnload', 'off');
    b.settings.set('autoFood', 'off');
    await teleport(b, feet);
    await clearArea(b.truth, { x: area.x, z: area.z }, 8, 6);
  }, 180_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.ok('clear', [bot.name]).catch(() => undefined);
      await clearArea(bot.truth, { x: area.x, z: area.z }, 8, 6).catch(() => undefined);
      await truthLoaded(bot.truth, 'fill', [area.x - 8, F - 1, area.z - 8, area.x + 8, F - 1, area.z + 8, 'grass_block']).catch(() => undefined);
      await bot.stop();
    }
    console.log(`[repair e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 120_000);

  // ---- the bot's own `!repair` -----------------------------------------------------------------------------------------
  interface KitItem {
    slot: number;
    name: string;
    count?: number;
    damage?: number;
  }
  /** An empty inventory, these items, exactly `levels` levels, the hand on the empty slot 8. */
  const kit = async (b: CraftBot, items: readonly KitItem[], levels: number): Promise<void> => {
    await b.truth.ok('clear', [b.name]);
    await craftCmd('xp', '-30000L', b.name);
    await sleep(300);
    for (const it of items) await b.truth.ok('setslot', [b.name, it.slot, it.name, it.count ?? 1, ...(it.damage !== undefined ? [it.damage] : [])]);
    if (levels > 0) await craftCmd('xp', `${levels}L`, b.name);
    b.task.pve!.hotbar.select(8);
    await until(() => (items.every((it) => inv(b).slots[it.slot]?.name === it.name && inv(b).slots[it.slot]?.count === (it.count ?? 1)) ? true : undefined), 5000, 'the kit');
    await until(() => ((self(b).level ?? 0) === levels ? true : undefined), 5000, `level ${levels}`);
  };
  /** A fresh anvil 2 blocks off (an anvil wears down and breaks after enough uses). */
  const freshAnvil = async (b: CraftBot): Promise<void> => {
    await truthLoaded(b.truth, 'fill', [anvilAt.x, anvilAt.y, anvilAt.z, anvilAt.x, anvilAt.y, anvilAt.z, 'air']);
    await truthLoaded(b.truth, 'fill', [anvilAt.x, anvilAt.y, anvilAt.z, anvilAt.x, anvilAt.y, anvilAt.z, 'anvil']);
    await until(() => (b.built.mobility!.world.blockAt(anvilAt)?.name === 'anvil' ? true : undefined), 5000, 'the anvil in the model');
  };
  /** Enchant the item in hotbar slot `s` (selected for the command). */
  const enchant = async (b: CraftBot, s: number, ench: string, lvl: number): Promise<void> => {
    const n = (inv(b).slots[s]?.enchants ?? []).length;
    b.task.pve!.hotbar.select(s);
    await b.built.mobility!.loop.waitTicks(4);
    await craftCmd('enchant', b.name, ench, String(lvl));
    await until(() => ((inv(b).slots[s]?.enchants ?? []).length > n ? true : undefined), 5000, `${ench} on slot ${s}`);
    b.task.pve!.hotbar.select(8);
    await b.built.mobility!.loop.waitTicks(6);
  };
  /** A command and its reply starting with `prefix` (a reply of two lines joined with ` | `). */
  const ask = async (b: CraftBot, text: string, prefix = 'repair', timeoutMs = 45_000): Promise<string> => {
    const from = b.said.length;
    await b.command(text);
    await b.reply((s) => s.startsWith(prefix), from, timeoutMs);
    await sleep(1500);
    const r = b.said.slice(from).filter((s) => s.startsWith(prefix)).join(' | ');
    note(`${text} -> ${r}`);
    return r;
  };
  const durability = (b: CraftBot) => b.truth.ok<{ slots: { slot: number; typeId: string; amount: number; damage: number }[]; equipment: Record<string, { typeId: string; damage: number | null } | undefined> }>('durability', [b.name]);

  it.skipIf(PROBE.size > 0)('a worn elytra renewed with phantom membranes: taken off, repaired, put on again', async () => {
    const b = bot!;
    await kit(b, [{ slot: 1, name: 'elytra', damage: 300 }, { slot: 2, name: 'phantom_membrane', count: 4 }], 30);
    await freshAnvil(b);
    await ask(b, '!equip slot 1', 'equip', 10_000);
    await until(() => (inv(b).window(120)?.slots[1]?.name === 'elytra' ? true : undefined), 5000, 'the elytra on the back');
    const r = await ask(b, '!repair');
    expect(r).toMatch(/^repair: elytra 132 -> 432\/432 with 3 phantom membranes for 3 levels \(level 30 -> 27\)/);
    expect(r).toContain('level 30 -> 27');
    expect(r).toContain('prior-work penalty 0 -> 1');
    expect(r).toContain('on my back again');
    const d = await durability(b);
    note(`membranes: the server holds ${json(d)}`);
    expect(d.equipment.Chest?.typeId).toBe('minecraft:elytra');
    expect(d.equipment.Chest?.damage).toBe(0);
    expect((await b.truth.craftinv(b.name)).counts.phantom_membrane).toBe(1);
    expect(self(b).level).toBe(27);
    expect(inv(b).window(120)?.slots[1]?.repairCost).toBe(1);
  }, 120_000);

  it.skipIf(PROBE.size > 0)('two elytras combined: the Mending one is the base and Mending stays', async () => {
    const b = bot!;
    await kit(b, [{ slot: 1, name: 'elytra', damage: 300 }, { slot: 3, name: 'elytra', damage: 350 }], 30);
    await enchant(b, 3, 'mending', 1);
    await freshAnvil(b);
    const r = await ask(b, '!repair');
    expect(r).toMatch(/^repair: elytra 82 -> 265\/432 combined with elytra 132\/432 for 2 levels/);
    expect(r).toContain('the base was the other one (82/432, Mending): its Mending stays at no cost (2 levels, the other way round 6)');
    const d = await durability(b);
    note(`combine: the server holds ${json(d)}`);
    const elytras = d.slots.filter((s) => s.typeId === 'minecraft:elytra');
    expect(elytras).toEqual([expect.objectContaining({ slot: 3, damage: 167 })]);
    expect(self(b).level).toBe(28);
    expect((inv(b).slots[3]?.enchants ?? []).map((e) => e.id)).toEqual([26]);
  }, 120_000);

  it.skipIf(PROBE.size > 0)('refused with too few levels: nothing is sent, nothing changes', async () => {
    const b = bot!;
    await kit(b, [{ slot: 1, name: 'elytra', damage: 300 }, { slot: 2, name: 'phantom_membrane', count: 4 }], 1);
    await freshAnvil(b);
    const r = await ask(b, '!repair');
    expect(r).toBe('repair: not enough levels: it costs 3 and I have 1');
    const d = await durability(b);
    expect(d.slots.find((s) => s.slot === 1)).toEqual(expect.objectContaining({ typeId: 'minecraft:elytra', damage: 300 }));
    expect((await b.truth.craftinv(b.name)).counts.phantom_membrane).toBe(4);
    expect(self(b).level).toBe(1);
  }, 120_000);

  it.skipIf(PROBE.size > 0)('the penalty after repeats (1, 2, 4, 8 levels), then refused as too expensive (40 levels)', async () => {
    const b = bot!;
    await kit(b, [{ slot: 1, name: 'elytra', damage: 431 }], 100);
    // four renewals of one membrane each: the prior-work penalty 0 -> 1 -> 3 -> 7 -> 15, the cost 1, 2, 4, 8
    const renew = async (expectCost: number, before: number, after: number): Promise<void> => {
      await b.truth.ok('setslot', [b.name, 2, 'phantom_membrane', 1]);
      await until(() => (inv(b).slots[2]?.name === 'phantom_membrane' ? true : undefined), 5000, 'the membrane');
      await freshAnvil(b);
      const r = await ask(b, '!repair membranes');
      expect(r).toContain(`with 1 phantom membrane for ${expectCost} level${expectCost === 1 ? '' : 's'}`);
      expect(r).toContain(`prior-work penalty ${before} -> ${after}`);
    };
    const series = async (): Promise<void> => {
      await renew(1, 0, 1);
      await renew(2, 1, 3);
      await renew(4, 3, 7);
      await renew(8, 7, 15);
    };
    await series();
    expect(inv(b).slots[1]?.repairCost).toBe(15);
    // that one with Mending and Unbreaking III goes to slot 3; a second one through the same four
    await enchant(b, 1, 'mending', 1);
    await enchant(b, 1, 'unbreaking', 3);
    const mv = await survivalKitOf(b.task)!.moveSlot(1, 3);
    expect(mv.ok).toBe(true);
    await b.truth.ok('setslot', [b.name, 1, 'elytra', 1, 431]);
    await until(() => (inv(b).slots[1]?.name === 'elytra' ? true : undefined), 5000, 'the second elytra');
    await series();
    const lv = self(b).level;
    expect(lv).toBe(70);
    // 15 + 15 + Mending 4 + Unbreaking III 6 = 40: the anvil refuses 40 or more, so the bot does not try
    await freshAnvil(b);
    const r = await ask(b, '!repair combine');
    expect(r).toMatch(/^repair: too expensive: it would cost 40 levels and the anvil refuses 40 or more/);
    expect(self(b).level).toBe(lv);
    const d = await durability(b);
    expect(d.slots.filter((s) => s.typeId === 'minecraft:elytra').map((s) => s.slot)).toEqual([1, 3]);
    note(`status: ${await ask(b, '!repair status')}`);
  }, 300_000);

  // ---- the measurements ------------------------------------------------------------------------------------------------
  it.skipIf(!PROBE.has('wire'))('probe wire: the anvil screen, its slots and the request that takes the result', async () => {
    const b = bot!;
    const mob = b.built.mobility!;
    const variant = process.env.REPAIR_WIRE ?? 'a';
    const log: string[] = [];
    const t0 = Date.now();
    const rel = (): string => `${((Date.now() - t0) / 1000).toFixed(2)}s`;
    for (const n of ['container_open', 'container_close', 'inventory_content', 'inventory_slot', 'item_stack_response', 'container_set_data', 'packet_violation_warning', 'disconnect', 'update_attributes', 'player_enchant_options', 'level_event', 'level_sound_event', 'anvil_damage', 'update_block', 'inventory_transaction']) {
      b.conn.on(n, (p: unknown) => {
        if (n === 'update_attributes') {
          const a = (p as { attributes?: { name: string; current: number }[] }).attributes?.filter((x) => /level|experience/.test(x.name));
          if (!a?.length) return;
          log.push(`${rel()} ${n} ${json(a)}`);
          return;
        }
        if (n === 'inventory_content' && (p as { window_id?: unknown }).window_id === 'inventory') {
          log.push(`${rel()} ${n} inventory (${(p as { input: unknown[] }).input.length} slots)`);
          return;
        }
        if (n === 'level_sound_event' && !/anvil|random/i.test(json(p))) return;
        if (n === 'update_block' && !/anvil/i.test(json(p))) return;
        log.push(`${rel()} ${n} ${json(p, 1500)}`);
      });
    }
    // the kit: a worn elytra in hotbar slot 1, membranes in slot 2, 30 levels; hand on slot 8 (empty)
    await b.truth.ok('clear', [b.name]);
    await craftCmd('xp', '-30000L', b.name);
    await sleep(300);
    const damage = Number(process.env.REPAIR_DAMAGE ?? 300);
    const membranes = Number(process.env.REPAIR_MEMBRANES ?? 2);
    const levels = Number(process.env.REPAIR_LEVELS ?? 30);
    await b.truth.ok('setslot', [b.name, 1, 'elytra', 1, damage]);
    if (membranes > 0) await b.truth.ok('setslot', [b.name, 2, 'phantom_membrane', membranes]);
    if (variant.includes('combine')) await b.truth.ok('setslot', [b.name, 3, 'elytra', 1, Number(process.env.REPAIR_DAMAGE2 ?? 350)]);
    if (levels > 0) await craftCmd('xp', `${levels}L`, b.name);
    b.task.pve!.hotbar.select(8);
    await until(() => (inv(b).slots[1]?.name === 'elytra' && (membranes === 0 || inv(b).slots[2]?.name === 'phantom_membrane') ? true : undefined), 5000, 'the kit');
    await until(() => ((self(b).level ?? 0) === levels ? true : undefined), 5000, `level ${levels}`).catch(() => undefined);
    note(`wire ${variant}: kit: elytra ${inv(b).slots[1]?.damage} damage, ${inv(b).slots[2]?.count ?? 0} membranes, level ${self(b).level}; raw elytra ${json(inv(b).rawItem(0, 1), 800)}`);
    // the anvil, 2 blocks off
    await truthLoaded(b.truth, 'fill', [anvilAt.x, anvilAt.y, anvilAt.z, anvilAt.x, anvilAt.y, anvilAt.z, 'air']);
    await truthLoaded(b.truth, 'fill', [anvilAt.x, anvilAt.y, anvilAt.z, anvilAt.x, anvilAt.y, anvilAt.z, process.env.REPAIR_ANVIL ?? 'anvil']);
    await until(() => ((mob.world.blockAt(anvilAt)?.name ?? '').includes('anvil') ? true : undefined), 5000, 'the anvil in the model');
    note(`wire ${variant}: anvil block ${mob.world.blockAt(anvilAt)?.name} ${json(mob.world.blockAt(anvilAt))}`);
    // open it: the chest click
    const pos = mob.loop.state.pos;
    const eye = { x: pos.x, y: pos.y + EYE_HEIGHT, z: pos.z };
    mob.loop.setCommand(lookAngles(eye, blockCenter(anvilAt)));
    await mob.loop.waitTicks(3);
    let opened: { id: number; type: string } | undefined;
    const offOpen = b.conn.on('container_open', (raw) => {
      const p = raw as unknown as { window_id: unknown; window_type: unknown };
      opened = { id: Number(p.window_id), type: String(p.window_type) };
    });
    b.conn.queue('inventory_transaction', clickBlockTransaction({ pos: anvilAt, face: faceToward(eye, anvilAt), hotbarSlot: inv(b).selected, held: b.task.pve!.hotbar.rawItem(inv(b).selected), eye, blockRuntimeId: mob.world.chunks.runtimeIdAt(anvilAt.x, anvilAt.y, anvilAt.z) ?? 0 }));
    await until(() => opened, 4000, 'container_open').catch(() => undefined);
    offOpen();
    note(`wire ${variant}: opened ${json(opened)}`);
    expect(opened).toBeDefined();
    // requests of our own (ids from -900001 down)
    let next = -900001;
    const responses = new Map<number, unknown>();
    b.conn.on('item_stack_response', (raw) => {
      for (const r of (raw as unknown as { responses: { request_id: number }[] }).responses) responses.set(r.request_id, r);
    });
    const send = async (actions: Record<string, unknown>[], names: string[] = [], cause = 'chat_public'): Promise<{ id: number; r: unknown }> => {
      const id = next;
      next -= 2;
      b.conn.queue('item_stack_request', { requests: [{ request_id: id, actions, custom_names: names, cause }] });
      await until(() => (responses.has(id) ? true : undefined), 3000, `response ${id}`).catch(() => undefined);
      return { id, r: responses.get(id) };
    };
    const slot = (container: string, s: number, stack: number | undefined) => ({ slot_type: { container_id: container }, slot: s, stack_id: stack ?? 0 });
    const player = (s: number) => slot(s < 9 ? 'hotbar' : 'inventory', s, inv(b).slots[s]?.stackId);
    // 1. the inputs: the elytra into anvil_input (UI slot 1), the material into anvil_material (UI slot 2)
    const inSlot = Number(process.env.REPAIR_IN_SLOT ?? 1);
    const matSlot = Number(process.env.REPAIR_MAT_SLOT ?? 2);
    const matFrom = variant.includes('combine') ? 3 : 2;
    const matCount = variant.includes('combine') ? 1 : membranes;
    const elytraStack = inv(b).slots[1]?.stackId;
    const matStack = inv(b).slots[matFrom]?.stackId;
    const fill = await send([
      { type_id: 'place', legacy_type_id: 1, count: 1, source: player(1), destination: slot('anvil_input', inSlot, 0) },
      ...(matCount > 0 ? [{ type_id: 'place', legacy_type_id: 1, count: matCount, source: player(matFrom), destination: slot('anvil_material', matSlot, 0) }] : []),
    ]);
    note(`wire ${variant}: fill ${json(fill.r, 1200)}`);
    await mob.loop.waitTicks(4);
    // the stack ids the fill gave the slots
    const fr = fill.r as { containers?: { slot_type: { container_id: string }; slots: { slot: number; item_stack_id: number; count: number }[] }[] } | undefined;
    const sid = (c: string, s: number): number | undefined => fr?.containers?.find((x) => x.slot_type.container_id === c)?.slots.find((x) => x.slot === s)?.item_stack_id;
    const inId = sid('anvil_input', inSlot) ?? elytraStack;
    const matId = sid('anvil_material', matSlot) ?? matStack;
    // 2. the craft: CraftRecipeOptional, the consumes, the result out of created_output (UI slot 50) into hotbar slot 1
    const recipe = Number(process.env.REPAIR_RECIPE ?? 0);
    const legacy = Number(process.env.REPAIR_LEGACY ?? 15);
    const typeId = process.env.REPAIR_TYPE ?? 'optional';
    const names = (process.env.REPAIR_NAMES ?? '').split('|').filter((s, i, a) => !(a.length === 1 && s === ''));
    const index = Number(process.env.REPAIR_INDEX ?? (names.length ? 0 : -1));
    const cause = process.env.REPAIR_CAUSE ?? (names.length ? 'anvil_text' : 'chat_public');
    const outId = next;
    const dst = Number(process.env.REPAIR_DST ?? 1);
    const craftActions: Record<string, unknown>[] = [
      { type_id: typeId, legacy_type_id: legacy, recipe_network_id: recipe, filtered_string_index: index },
      { type_id: 'consume', legacy_type_id: 5, count: 1, source: slot('anvil_input', inSlot, inId) },
      ...(matCount > 0 ? [{ type_id: 'consume', legacy_type_id: 5, count: Number(process.env.REPAIR_CONSUME ?? matCount), source: slot('anvil_material', matSlot, matId) }] : []),
      { type_id: process.env.REPAIR_OUT_ACTION ?? 'place', legacy_type_id: process.env.REPAIR_OUT_ACTION === 'take' ? 0 : 1, count: 1, source: slot('creative_output', 50, outId), destination: slot(dst < 9 ? 'hotbar' : 'inventory', dst, 0) },
    ];
    const lv0 = self(b).level;
    const craft = await send(craftActions, names, cause);
    note(`wire ${variant}: craft (recipe ${recipe}, legacy ${legacy}, names ${json(names)}, index ${index}, cause ${cause}) -> ${json(craft.r, 1200)}`);
    await sleep(1500);
    note(`wire ${variant}: level ${lv0} -> ${self(b).level}; model slot ${dst} ${json(inv(b).slots[dst])}, slot ${matFrom} ${json(inv(b).slots[matFrom])}`);
    // 3. the screen closed; the server's view
    b.built.mobility!.world.inventory.requestResync('repair probe');
    await sleep(500);
    b.conn.queue('container_close', { window_id: opened!.id, window_type: opened!.type, server: false });
    await sleep(1500);
    const d = await b.truth.ok<{ slots: { slot: number; typeId: string; amount: number; damage: number }[] }>('durability', [b.name]);
    note(`wire ${variant}: the server's slots ${json(d.slots)}; truth counts ${json(await b.truth.craftinv(b.name))}`);
    note(`wire ${variant}: model after the resync: slot ${dst} ${json(inv(b).slots[dst])} raw ${json(inv(b).rawItem(0, dst), 900)}`);
    note(`wire ${variant}: the anvil now ${json(await b.truth.block(anvilAt))}`);
    for (const l of log) note(`  pkt ${l}`);
  }, 180_000);

  // REPAIR_PROBE=ops: a sequence of anvil operations on one elytra, each measured (the levels paid, the damage, the
  // prior-work tag, the enchantments, the name). REPAIR_SETUP: `431` (the elytra's damage in slot 1), `431m` with
  // Mending; `,b350` a second elytra in slot 3 (`b350m` with Mending, `b350u` with Unbreaking III); `,n4` membranes in
  // slot 2. REPAIR_OPS: `m<k>` k membranes placed (`m4/3`: 4 placed, 3 consumed), `c` the second elytra as the
  // sacrifice, `r<Name>` a rename, `l<n>` the levels set to n before the next op. REPAIR_LEVELS: the levels at the start.
  it.skipIf(!PROBE.has('ops'))('probe ops: what each anvil operation costs and makes', async () => {
    const b = bot!;
    const mob = b.built.mobility!;
    // REPAIR_RUNS: `setup|ops|levels|label` runs separated by `;` (else one run from REPAIR_SETUP, REPAIR_OPS, REPAIR_LEVELS)
    const runs = (process.env.REPAIR_RUNS ?? `${process.env.REPAIR_SETUP ?? '431,n4'}|${process.env.REPAIR_OPS ?? 'm1'}|${process.env.REPAIR_LEVELS ?? 30}|`).split(';').filter((r) => r.trim() !== '');
    let next = -910001;
    const responses = new Map<number, { status: unknown; containers?: { slot_type: { container_id: string }; slots: { slot: number; count: number; item_stack_id?: number; durability_correction?: number }[] }[] }>();
    b.conn.on('item_stack_response', (raw) => {
      for (const r of (raw as unknown as { responses: { request_id: number; status: unknown }[] }).responses) responses.set(r.request_id, r);
    });
    for (const run of runs) {
    const [setupS, opsS, levelsS, labelS] = run.split('|');
    const setup = (setupS ?? '431,n4').split(',');
    const ops = (opsS ?? 'm1').split(',');
    const levels = Number(levelsS ?? 30);
    const label = labelS !== undefined && labelS !== '' ? labelS : `${setup.join(',')} ${ops.join(',')}`;
    await b.truth.ok('clear', [b.name]);
    await craftCmd('xp', '-30000L', b.name);
    await sleep(300);
    const send = async (actions: Record<string, unknown>[], names: string[] = [], cause = 'chat_public') => {
      const id = next;
      next -= 2;
      b.conn.queue('item_stack_request', { requests: [{ request_id: id, actions, custom_names: names, cause }] });
      await until(() => (responses.has(id) ? true : undefined), 3000, `response ${id}`).catch(() => undefined);
      return { id, r: responses.get(id) };
    };
    const slotRef = (container: string, s: number, stack: number | undefined) => ({ slot_type: { container_id: container }, slot: s, stack_id: stack ?? 0 });
    const player = (s: number, stack: number | undefined) => slotRef(s < 9 ? 'hotbar' : 'inventory', s, stack);
    const enchantSlot = async (s: number, ench: string, lvl: string): Promise<void> => {
      b.task.pve!.hotbar.select(s);
      await mob.loop.waitTicks(4);
      await craftCmd('enchant', b.name, ench, lvl);
      await until(() => ((inv(b).slots[s]?.enchants ?? []).length > 0 ? true : undefined), 5000, `${ench} on slot ${s}`);
      b.task.pve!.hotbar.select(8);
      await mob.loop.waitTicks(6);
    };
    for (const s of setup) {
      const m = /^(b?)(\d+)([mu]*)$/.exec(s);
      if (m) {
        const slot = m[1] ? 3 : 1;
        await b.truth.ok('setslot', [b.name, slot, 'elytra', 1, Number(m[2])]);
        await until(() => (inv(b).slots[slot]?.name === 'elytra' ? true : undefined), 5000, `the elytra in slot ${slot}`);
        if (m[3]!.includes('m')) await enchantSlot(slot, 'mending', '1');
        if (m[3]!.includes('u')) await enchantSlot(slot, 'unbreaking', '3');
        continue;
      }
      const n = /^n(\d+)$/.exec(s);
      if (n) await b.truth.ok('setslot', [b.name, 2, 'phantom_membrane', Number(n[1])]);
      if (s === 'bk') {
        // a Mending book into slot 3: /enchant on an enchanted book first, else loot rolls of a library chest
        await b.truth.ok('setslot', [b.name, 3, 'enchanted_book', 1]);
        await until(() => (inv(b).slots[3]?.name === 'enchanted_book' ? true : undefined), 5000, 'the book').catch(() => undefined);
        await enchantSlot(3, 'mending', '1').catch(() => undefined);
        note(`ops setup bk: /enchant mending on an enchanted_book in slot 3 -> ${json(inv(b).slots[3])}`);
        if (!(inv(b).slots[3]?.enchants ?? []).some((e) => e.id === 26)) {
          await b.truth.ok('setslot', [b.name, 3, 'book', 1]);
          await sleep(300);
          await enchantSlot(3, 'mending', '1').catch(() => undefined);
          note(`ops setup bk: /enchant mending on a book in slot 3 -> ${json(inv(b).slots[3])}`);
        }
        const table = process.env.REPAIR_LOOT ?? 'chests/stronghold_library';
        let rolls = 0;
        const seen: Record<string, number> = {};
        while (!(inv(b).slots[3]?.enchants ?? []).some((e) => e.id === 26) && rolls < Number(process.env.REPAIR_ROLLS ?? 120)) {
          rolls++;
          await b.truth.ok('setslot', [b.name, 3, 'air']);
          await craftCmd('loot', 'give', b.name, 'loot', table);
          await sleep(400);
          let found = -1;
          for (let i = 0; i < 36; i++) {
            const it = inv(b).slots[i];
            if (i === 1 || !it) continue;
            if (it.name === 'enchanted_book') for (const e of it.enchants ?? []) seen[`${e.id}:${e.lvl}`] = (seen[`${e.id}:${e.lvl}`] ?? 0) + 1;
            if (found < 0 && it.name === 'enchanted_book' && (it.enchants ?? []).length === 1 && it.enchants![0]!.id === 26) found = i;
          }
          if (found >= 0 && found !== 3) {
            const r = await send([{ type_id: 'place', legacy_type_id: 1, count: 1, source: player(found, inv(b).slots[found]?.stackId), destination: player(3, 0) }]);
            await mob.loop.waitTicks(4);
            note(`ops setup bk: a Mending book after ${rolls} rolls of ${table}, moved from slot ${found}: ${json(r.r?.status)}`);
          }
          for (let i = 0; i < 36; i++) if (i !== 1 && i !== 3 && inv(b).slots[i]) await b.truth.ok('setslot', [b.name, i, 'air']);
          await sleep(200);
        }
        note(`ops setup bk: slot 3 ${json(inv(b).slots[3])} after ${rolls} rolls; books seen ${json(seen)}`);
      }
    }
    if (levels > 0) await craftCmd('xp', `${levels}L`, b.name);
    b.task.pve!.hotbar.select(8);
    await until(() => ((self(b).level ?? 0) === levels ? true : undefined), 5000, `level ${levels}`).catch(() => undefined);
    await truthLoaded(b.truth, 'fill', [anvilAt.x, anvilAt.y, anvilAt.z, anvilAt.x, anvilAt.y, anvilAt.z, 'air']);
    await truthLoaded(b.truth, 'fill', [anvilAt.x, anvilAt.y, anvilAt.z, anvilAt.x, anvilAt.y, anvilAt.z, 'anvil']);
    await until(() => ((mob.world.blockAt(anvilAt)?.name ?? '').includes('anvil') ? true : undefined), 5000, 'the anvil in the model');
    /** The server's view of slot `s`: damage, RepairCost, enchantments, name (a resync's inventory_content). */
    const serverItem = async (s: number): Promise<string> => {
      const gen = inv(b).contentGeneration;
      inv(b).requestResync('repair probe');
      await until(() => (inv(b).contentGeneration > gen ? true : undefined), 3000, 'the resync').catch(() => undefined);
      const raw = inv(b).rawItem(0, s) as { extra?: { nbt?: { nbt?: { value?: Record<string, { value: unknown }> } } } } | undefined;
      const v = raw?.extra?.nbt?.nbt?.value ?? {};
      const it = inv(b).slots[s];
      return it ? `${it.name} damage ${json(v.Damage?.value ?? 0)} RepairCost ${json(v.RepairCost?.value ?? '-')} ench ${json(it.enchants ?? [])} name ${json((v.display?.value as { Name?: { value: unknown } } | undefined)?.Name?.value ?? null)}` : 'empty';
    };
    const open = async (): Promise<{ id: number; type: string } | undefined> => {
      const pos = mob.loop.state.pos;
      const eye = { x: pos.x, y: pos.y + EYE_HEIGHT, z: pos.z };
      mob.loop.setCommand(lookAngles(eye, blockCenter(anvilAt)));
      await mob.loop.waitTicks(3);
      let opened: { id: number; type: string } | undefined;
      const off = b.conn.on('container_open', (raw) => {
        const p = raw as unknown as { window_id: unknown; window_type: unknown };
        opened = { id: Number(p.window_id), type: String(p.window_type) };
      });
      b.conn.queue('inventory_transaction', clickBlockTransaction({ pos: anvilAt, face: faceToward(eye, anvilAt), hotbarSlot: inv(b).selected, held: b.task.pve!.hotbar.rawItem(inv(b).selected), eye, blockRuntimeId: mob.world.chunks.runtimeIdAt(anvilAt.x, anvilAt.y, anvilAt.z) ?? 0 }));
      await until(() => opened, 4000, 'container_open').catch(() => undefined);
      off();
      return opened;
    };
    note(`ops ${label}: start: slot 1 ${await serverItem(1)}; slot 3 ${await serverItem(3)}; level ${self(b).level}`);
    for (const op of ops) {
      const lv = /^l(\d+)$/.exec(op);
      if (lv) {
        await craftCmd('xp', '-30000L', b.name);
        await sleep(200);
        if (Number(lv[1]) > 0) await craftCmd('xp', `${lv[1]}L`, b.name);
        await until(() => ((self(b).level ?? 0) === Number(lv[1]) ? true : undefined), 5000, `level ${lv[1]}`).catch(() => undefined);
        note(`ops ${label}: levels set to ${self(b).level}`);
        continue;
      }
      const en = /^e:(\w+):(\d)$/.exec(op);
      if (en) {
        await enchantSlot(1, en[1]!, en[2]!);
        note(`ops ${label}: ${op}: slot 1 now ${await serverItem(1)}`);
        continue;
      }
      if (op === 'a') {
        // the elytra in slot 1 onto the back (the armour container's chest slot), under the inventory screen
        let scr: { id: number; type: string } | undefined;
        const offScr = b.conn.on('container_open', (raw) => {
          const q = raw as unknown as { window_id: unknown; window_type: unknown };
          scr = { id: Number(q.window_id), type: String(q.window_type) };
        });
        b.conn.queue('interact', { action_id: 'open_inventory', target_entity_id: mob.world.self.runtimeId, has_position: false });
        await until(() => scr, 3000, 'the inventory screen').catch(() => undefined);
        offScr();
        const r = await send([{ type_id: 'place', legacy_type_id: 1, count: 1, source: player(1, inv(b).slots[1]?.stackId), destination: slotRef('armor', 1, 0) }]);
        if (scr) b.conn.queue('container_close', { window_id: scr.id, window_type: scr.type, server: false });
        await mob.loop.waitTicks(10);
        note(`ops ${label}: a: slot 1 onto the back ${json(r.r?.status)}; worn ${json(inv(b).window(120)?.slots[1] ?? null)}`);
        continue;
      }
      if (op === 's') {
        // slots 1 and 3 exchanged (one swap request)
        const a = inv(b).slots[1];
        const c = inv(b).slots[3];
        const r = await send([{ type_id: 'swap', legacy_type_id: 2, source: player(1, a?.stackId), destination: player(3, c?.stackId) }]);
        await mob.loop.waitTicks(4);
        note(`ops ${label}: s: slots 1 and 3 swapped ${json(r.r?.status)}; slot 1 now ${await serverItem(1)}; slot 3 ${await serverItem(3)}`);
        continue;
      }
      const w = await open();
      if (!w) {
        note(`ops ${label}: ${op}: the anvil did not open (block ${mob.world.blockAt(anvilAt)?.name})`);
        break;
      }
      // `@` first: the input from the armour's chest slot and the result back there; `~Name` last: that name sent
      const worn = op.startsWith('@');
      const core = (worn ? op.slice(1) : op).split('~')[0]!;
      const sentName = op.includes('~') ? op.slice(op.indexOf('~') + 1) : undefined;
      const target = worn ? inv(b).window(120)?.slots[1] : inv(b).slots[1];
      const srcRef = worn ? slotRef('armor', 1, target?.stackId) : player(1, target?.stackId);
      const dstRef = worn ? slotRef('armor', 1, 0) : player(1, 0);
      const mm = /^m(\d+)(?:\/(\d+))?$/.exec(core);
      const placed = mm ? Number(mm[1]) : core === 'c' ? 1 : 0;
      const consumed = mm ? Number(mm[2] ?? mm[1]) : placed;
      const matFrom = core === 'c' ? 3 : 2;
      const mat = inv(b).slots[matFrom];
      const fill = await send([
        { type_id: 'place', legacy_type_id: 1, count: 1, source: srcRef, destination: slotRef('anvil_input', 1, 0) },
        ...(placed > 0 ? [{ type_id: 'place', legacy_type_id: 1, count: placed, source: player(matFrom, mat?.stackId), destination: slotRef('anvil_material', 2, 0) }] : []),
      ]);
      const sid = (c: string, s: number) => fill.r?.containers?.find((x) => x.slot_type.container_id === c)?.slots.find((x) => x.slot === s)?.item_stack_id;
      const inId = sid('anvil_input', 1);
      const matId = sid('anvil_material', 2);
      const rename = core.startsWith('r') ? core.slice(1) : sentName;
      const names = rename !== undefined ? [rename] : [];
      const lv0 = self(b).level ?? 0;
      const craft = await send(
        [
          { type_id: 'optional', legacy_type_id: 15, recipe_network_id: 0, filtered_string_index: names.length ? 0 : -1 },
          { type_id: 'consume', legacy_type_id: 5, count: 1, source: slotRef('anvil_input', 1, inId) },
          ...(placed > 0 ? [{ type_id: 'consume', legacy_type_id: 5, count: consumed, source: slotRef('anvil_material', 2, matId) }] : []),
          { type_id: 'place', legacy_type_id: 1, count: 1, source: slotRef('creative_output', 50, next), destination: dstRef },
        ],
        names,
        names.length ? 'anvil_text' : 'chat_public',
      );
      await mob.loop.waitTicks(10);
      const lv1 = self(b).level ?? 0;
      const out = craft.r?.containers?.find((x) => x.slot_type.container_id === (worn ? 'armor' : 'hotbar'))?.slots.find((x) => x.slot === 1);
      // what is left in the anvil goes back (the input after a refused craft, the material not consumed)
      const left = craft.r?.status === 'ok' ? craft.r.containers?.find((x) => x.slot_type.container_id === 'anvil_material')?.slots.find((x) => x.slot === 2) : undefined;
      const back: Record<string, unknown>[] = [];
      if (craft.r?.status !== 'ok') back.push({ type_id: 'place', legacy_type_id: 1, count: 1, source: slotRef('anvil_input', 1, inId), destination: dstRef });
      const matLeft = craft.r?.status === 'ok' ? (left?.count ?? 0) : placed;
      if (matLeft > 0) back.push({ type_id: 'place', legacy_type_id: 1, count: matLeft, source: slotRef('anvil_material', 2, left?.item_stack_id ?? matId), destination: player(matFrom, inv(b).slots[matFrom]?.stackId) });
      const giveBack = back.length ? await send(back) : undefined;
      b.conn.queue('container_close', { window_id: w.id, window_type: w.type, server: false });
      await sleep(600);
      note(`ops ${label}: ${op} (level ${lv0}): ${craft.r?.status === 'ok' ? `ok: paid ${lv0 - lv1} levels, damage -> ${out?.durability_correction}` : `refused ${json(craft.r?.status)}`}${matLeft ? `; ${matLeft} material left in the slot, given back ${json(giveBack?.r?.status)}` : ''}; slot 1 now ${await serverItem(1)}${worn ? `; worn ${json(inv(b).window(120)?.slots[1] ?? null)}` : ''}; slot ${matFrom} ${await serverItem(matFrom)}; level ${self(b).level}; anvil ${mob.world.blockAt(anvilAt)?.name}`);
    }
    const d = await b.truth.ok<{ slots: { slot: number; typeId: string; amount: number; damage: number }[] }>('durability', [b.name]);
    note(`ops ${label}: end: the server's slots ${json(d.slots)}; counts ${json((await b.truth.craftinv(b.name)).counts)}`);
    }
  }, 3_600_000);
});
