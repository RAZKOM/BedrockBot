// e2e (tag @bds), Track F12 (docs/flight.md "The first rocket after the kit moved rockets"): the flight's first
// rocket after the kit's own item stack requests put rockets into the hotbar. On the Realm the first rocket fired
// nothing in 6 of 8 flights after a box refill or a swap and in 0 of 132 otherwise. Each case sets the kit up,
// flies a short way and counts the first rockets that fired nothing; the packets round the first use (what the
// bot sent, what the server answered, the bot's copy of the slot) go to F12_OUT as JSONL when it is set.
//   topup    8 rockets in hotbar slot 0 and a box of 64: the refill tops slot 0 up (the Realm's case)
//   swap     a full inventory, 64 rockets in a main slot: the kit swaps them with a hotbar item
//   move     64 rockets in a main slot, free hotbar slots: the kit moves them into the hotbar
//   control  64 rockets put in hotbar slot 0 by the server (no stack request)
// Env: F12_CASES (default all), F12_RUNS (runs a case, default 3), F12_OUT (a JSONL file), the FLY_BDS_* of
// fly-truth.ts.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { swapSlots } from '../../src/chat/commands-fly.ts';
import { survivalKitOf } from '../../src/chat/commands-survival.ts';
import type { Vec3 } from '../../src/connection/types.ts';
import { E2E, FEET_Y, flyCmd, giveFlightKit, prepareServer, privateArea, sleep, startFlyBot, teleport, until, type FlyBot } from './fly-truth.ts';

const F = FEET_Y;
const ALL = ['topup', 'swap', 'move', 'control'] as const;
type Case = (typeof ALL)[number];
const CASES = (process.env.F12_CASES?.split(',').filter((c) => (ALL as readonly string[]).includes(c)) ?? [...ALL]) as Case[];
const RUNS = Number(process.env.F12_RUNS ?? 3);
const OUT = process.env.F12_OUT;

/** A compact view of a wire item (the parts the server compares). */
function brief(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw ?? null;
  const r = raw as { network_id?: number; count?: number; stack_id?: number; has_stack_id?: boolean; block_runtime_id?: number; extra?: { has_nbt?: number; nbt?: unknown } };
  return { nid: r.network_id, n: r.count, sid: r.has_stack_id ? r.stack_id : undefined, brid: r.block_runtime_id, nbt: r.extra?.has_nbt ?? 0 };
}

interface Run {
  kase: Case;
  run: number;
  first?: number;
  dud: boolean;
  end: string;
  kit: string[];
  /** the bot's copy of the rocket slot at the first use */
  atUse?: { slot: number; model: unknown; invRaw: unknown; hotbarRaw: unknown; selected: number };
  packets: unknown[];
}

describe.skipIf(!E2E)('@bds fly: the first rocket after the kit moved rockets (Track F12)', () => {
  const area = privateArea();
  let bot: FlyBot | undefined;
  const home: Vec3 = { x: area.x + 0.5, y: F, z: area.z + 0.5 };
  const runs: Run[] = [];
  let rec: { on: boolean; t0: number; list: unknown[]; atUse?: Run['atUse'] } = { on: false, t0: 0, list: [] };

  beforeAll(async () => {
    await prepareServer();
    bot = await startFlyBot('Rkt');
    await teleport(bot, home);
    const b = bot;
    const inv = b.built.mobility!.world.inventory;
    const hotbar = b.task.pve!.hotbar;
    const tick = () => Number(b.conn.tick);
    for (const name of ['inventory_slot', 'inventory_content', 'inventory_transaction', 'item_stack_response', 'mob_equipment', 'player_hotbar', 'container_open', 'container_close']) {
      b.conn.on(name, (p: Record<string, unknown>) => {
        if (!rec.on) return;
        let x: unknown = p;
        if (name === 'inventory_slot') x = { w: p.window_id, slot: p.slot, item: brief(p.item) };
        else if (name === 'inventory_content') x = { w: p.window_id, hotbar: (p.input as unknown[]).slice(0, 9).map(brief) };
        else if (name === 'mob_equipment') x = { slot: p.slot, sel: p.selected_slot, item: brief(p.item), rid: String(p.runtime_entity_id) };
        else if (name === 'inventory_transaction') {
          const t = p.transaction as { transaction_type: string; actions?: { window_id?: unknown; slot: number; new_item: unknown; old_item: unknown }[] };
          x = { type: t.transaction_type, actions: t.actions?.map((a) => ({ w: a.window_id, slot: a.slot, old: brief(a.old_item), new: brief(a.new_item) })) };
        }
        rec.list.push({ t: tick() - rec.t0, dir: 'in', name, p: x });
      });
    }
    b.conn.on('add_entity', (p: Record<string, unknown>) => {
      if (rec.on && p.entity_type === 'minecraft:fireworks_rocket') rec.list.push({ t: tick() - rec.t0, dir: 'in', name: 'add_entity', p: { type: p.entity_type } });
    });
    const orig: (n: string, p: Record<string, unknown>) => void = b.conn.queue.bind(b.conn);
    const q = (n: string, p: object): void => {
      orig(n, p as Record<string, unknown>);
    };
    (b.conn as { queue: (n: string, p: object) => void }).queue = (n: string, p: object) => {
      if (rec.on && (n === 'inventory_transaction' || n === 'mob_equipment' || n === 'item_stack_request')) {
        let x: unknown = p;
        const o = p as Record<string, unknown>;
        if (n === 'mob_equipment') x = { slot: o.slot, item: brief(o.item) };
        else if (n === 'inventory_transaction') {
          const d = (o.transaction as { transaction_type: string; transaction_data?: { action_type?: string; hotbar_slot?: number; held_item?: unknown } }).transaction_type === 'item_use' ? (o.transaction as { transaction_data: { action_type: string; hotbar_slot: number; held_item: unknown } }).transaction_data : undefined;
          x = d ? { use: d.action_type, slot: d.hotbar_slot, held: brief(d.held_item) } : { type: (o.transaction as { transaction_type: string }).transaction_type };
          if (d && !rec.atUse && inv.slots[d.hotbar_slot]?.name === 'firework_rocket') {
            const s = d.hotbar_slot;
            rec.atUse = { slot: s, model: inv.slots[s] ? { name: inv.slots[s].name, n: inv.slots[s].count, sid: inv.slots[s].stackId } : null, invRaw: brief(inv.rawItem(0, s)), hotbarRaw: brief(hotbar.rawItem(s)), selected: inv.selected };
          }
        }
        rec.list.push({ t: tick() - rec.t0, dir: 'out', name: n, p: x });
      }
      q(n, p);
    };
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.clearAround(home, 24).catch(() => undefined);
      await bot.stop();
    }
    const byCase = new Map<Case, { n: number; dud: number }>();
    for (const r of runs) {
      const c = byCase.get(r.kase) ?? { n: 0, dud: 0 };
      if (r.first !== undefined) c.n++;
      if (r.dud) c.dud++;
      byCase.set(r.kase, c);
    }
    console.log(`[fly-first-rocket e2e] area cell ${area.cell}; ${[...byCase].map(([k, c]) => `${k}: ${c.dud} of ${c.n} first rockets fired nothing`).join('; ')}`);
  }, 60_000);

  /**
   * The kit with rockets as /give and the crafting table make them (NBT `Fireworks {Flight 1, Explosions []}`, the
   * Realm's); the truth pack's setslot and boxdrop make rockets with no NBT, on which the fault does not show.
   */
  async function setup(b: FlyBot, kase: Case): Promise<void> {
    const inv = b.built.mobility!.world.inventory;
    const { name } = b;
    await giveFlightKit(b, { rockets: 0 });
    const put = (where: 'hotbar' | 'inventory', i: number, item: string, n: number) => flyCmd('replaceitem', 'entity', name, `slot.${where}`, String(i), item, String(n));
    if (kase === 'topup') {
      await put('hotbar', 0, 'firework_rocket', 8);
      const feet = b.task.position()!;
      const at = { x: Math.floor(feet.x) + 2, y: Math.floor(feet.y), z: Math.floor(feet.z) };
      const xyz = [String(at.x), String(at.y), String(at.z)];
      await flyCmd('setblock', ...xyz, 'undyed_shulker_box');
      await sleep(200);
      await flyCmd('replaceitem', 'block', ...xyz, 'slot.container', '0', 'firework_rocket', '64');
      await sleep(200);
      await flyCmd('setblock', ...xyz, 'air', 'destroy');
      const hasBox = () => (inv.slots.slice(0, 36).some((s) => s?.name.endsWith('shulker_box')) ? true : undefined);
      await sleep(1000);
      if (!hasBox()) await b.built.mobility!.skills.collect(4, 160, { origin: { x: at.x + 0.5, y: at.y, z: at.z + 0.5 } });
      await until(hasBox, 10_000, 'the fireworks box in the inventory');
      await until(() => (inv.slots[0]?.count === 8 ? true : undefined), 10_000, 'the rockets in slot 0');
    } else if (kase === 'control') {
      await put('hotbar', 0, 'firework_rocket', 64);
      await until(() => (inv.slots[0]?.count === 64 ? true : undefined), 10_000, 'the rockets in slot 0');
    } else {
      await put('inventory', 5, 'firework_rocket', 64); // slot 14
      const fill = kase === 'swap' ? [...Array(36).keys()].filter((i) => i !== 9 && i !== 14) : [0, 1, 2, 3];
      for (const i of fill) await (i < 9 ? put('hotbar', i, 'dirt', 16) : put('inventory', i - 9, 'dirt', 16));
      await until(() => (inv.slots[14]?.name === 'firework_rocket' && fill.every((i) => inv.slots[i]?.name === 'dirt') ? true : undefined), 10_000, 'the kit in the model');
    }
    await b.built.mobility!.loop.waitTicks(5);
  }

  it.each(CASES)('%s: the first rockets', async (kase) => {
    const b = bot!;
    for (let run = 0; run < RUNS; run++) {
      await teleport(b, home);
      await setup(b, kase);
      const z = area.z + (run % 2 === 0 ? 70 : -70);
      const logFrom = b.logs.length;
      const from = b.said.length;
      rec = { on: true, t0: Number(b.conn.tick), list: [] };
      await b.command(`!fly ${area.x} ${F} ${z}`);
      const end = await b.reply((s) => s.startsWith('landed') || s.startsWith('fly: '), from, 90_000).catch((e: Error) => `timeout: ${e.message.slice(0, 80)}`);
      await sleep(300);
      rec.on = false;
      const lines = b.logs.slice(logFrom);
      const firstLine = lines.find((l) => /flight: the first rocket at tick \d+/.test(l));
      const first = firstLine ? Number(/the first rocket at tick (\d+)/.exec(firstLine)![1]) : undefined;
      const dud = first !== undefined && lines.some((l) => l.includes(`the rocket used at tick ${first} fired nothing`));
      const r: Run = { kase, run, ...(first !== undefined ? { first } : {}), dud, end, kit: lines.filter((l) => l.includes('flight kit:')).map((l) => l.replace(/^\S+ /, '')), ...(rec.atUse ? { atUse: rec.atUse } : {}), packets: rec.list };
      runs.push(r);
      const big = (_k: string, v: unknown) => (typeof v === 'bigint' ? String(v) : v);
      if (OUT) appendFileSync(OUT, `${JSON.stringify(r, big)}\n`);
      console.log(`[f12] ${kase} ${run}: first ${first ?? '-'} ${dud ? 'FIRED NOTHING' : 'fired'}; ${end}; at use ${JSON.stringify(rec.atUse, big)}`);
      await b.command('!stop');
      await sleep(500);
    }
    const mine = runs.filter((r) => r.kase === kase);
    expect(mine.filter((r) => r.first !== undefined).length).toBeGreaterThan(0);
    if (process.env.F12_EXPECT_CLEAN === '1') expect(mine.filter((r) => r.dud).length).toBe(0);
  }, 3_600_000);

  // Another item with NBT moved by the bot's own request: a shulker box with contents swapped from a main slot into a
  // full hotbar (the kit's and the survival kit's swap), then placed. F12_BOXSWAP runs (default 0: skipped).
  const BOXSWAP = Number(process.env.F12_BOXSWAP ?? 0);
  it.skipIf(BOXSWAP <= 0)('a box swapped into the hotbar, then placed', async () => {
    const b = bot!;
    const inv = b.built.mobility!.world.inventory;
    const requests = survivalKitOf(b.task)!.requests;
    const results: { run: number; ok: boolean; reason?: string; held?: unknown; contents?: Record<string, number> }[] = [];
    for (let run = 0; run < BOXSWAP; run++) {
      await teleport(b, home);
      await giveFlightKit(b, { rockets: 0 });
      const put = (where: 'hotbar' | 'inventory', i: number, item: string, n: number) => flyCmd('replaceitem', 'entity', b.name, `slot.${where}`, String(i), item, String(n));
      for (let i = 0; i < 9; i++) await put('hotbar', i, 'dirt', 16);
      const feet = b.task.position()!;
      const at = { x: Math.floor(feet.x) + 2, y: Math.floor(feet.y), z: Math.floor(feet.z) };
      const xyz = [String(at.x), String(at.y), String(at.z)];
      await flyCmd('setblock', ...xyz, 'undyed_shulker_box');
      await sleep(200);
      await flyCmd('replaceitem', 'block', ...xyz, 'slot.container', '0', 'cobblestone', '7');
      await sleep(200);
      await flyCmd('setblock', ...xyz, 'air', 'destroy');
      const boxSlot = () => inv.slots.findIndex((s, i) => i < 36 && s?.name.endsWith('shulker_box') === true);
      await sleep(1000);
      if (boxSlot() < 0) await b.built.mobility!.skills.collect(4, 160, { origin: { x: at.x + 0.5, y: at.y, z: at.z + 0.5 } });
      await until(() => (boxSlot() >= 9 ? true : undefined), 10_000, 'the box in a main slot');
      const from = boxSlot();
      const sw = await requests.withScreen(() => swapSlots(requests, inv, from, 4));
      if (!('ok' in sw) || !sw.ok) throw new Error(`swap failed: ${JSON.stringify(sw)}`);
      await b.built.mobility!.loop.waitTicks(4);
      rec = { on: true, t0: Number(b.conn.tick), list: [] };
      const spot = { x: at.x, y: at.y, z: at.z };
      const p = await b.built.mobility!.skills.place(spot, { face: 'up', item: inv.slots[4]!.name });
      rec.on = false;
      const use = rec.list.find((x) => (x as { dir: string; name: string; p: { held?: unknown } }).dir === 'out' && (x as { name: string }).name === 'inventory_transaction') as { p: { held?: unknown } } | undefined;
      const r: (typeof results)[number] = { run, ok: p.ok, ...(p.reason ? { reason: p.reason } : {}), held: use?.p.held };
      if (p.ok) r.contents = (await b.truth.blockInv(spot)).counts;
      results.push(r);
      console.log(`[f12] boxswap ${run}: ${JSON.stringify(r)}`);
      if (OUT) appendFileSync(OUT, `${JSON.stringify({ kase: 'boxswap', ...r, packets: rec.list })}\n`);
      await flyCmd('setblock', ...xyz, 'air');
    }
    expect(results.length).toBe(BOXSWAP);
    if (process.env.F12_EXPECT_CLEAN === '1') expect(results.filter((r) => !r.ok).length).toBe(0);
  }, 3_600_000);
});
