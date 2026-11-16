// e2e (tag @bds), Track P1 (docs/versions.md "Packets the bot cannot read"): the Realm's two boxes swapped as the room
// chore swaps them (the survival kit's exchange, one `swap` item stack request with the inventory screen open), on
// bds-home. A green box named bot_loot with mixed loot (blocks, drops, a bow, copper armour) in main slot 15, a red box
// of 448 rockets in hotbar slot 5, the rest of the hotbar full. Each swap must be answered (ok), no packet may fail to
// parse, and the model must agree with the server's inventory (truth:inv) after every swap. The last case injects a
// parse failure of the swap's item_stack_response: the resync (world/resync.ts) must tell the swap done and the model
// must agree with the server within 3 s (P1_BEFORE=1 turns the resync off: that run fails, as main did).
// Env: HOME_BDS_PORT / HOME_BDS_CONTAINER (default bds-home on 19196), BDS_TRANSPORT, P1_SWAPS (default 4), P1_OUT (a
// JSONL file), P1_DUMP=1 (every inventory packet's bytes), P1_BOTHNAMED=1, P1_CASE3=1 (the third Realm case),
// P1_STRUCT=<structure id> (boxes with the Realm's NBT), P1_MISMATCH=1 (the inventory_mismatch probe), P1_BEFORE=1.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { survivalKitOf } from '../../src/chat/commands-survival.ts';
import type { ReadFailure } from '../../src/connection/readErrors.ts';
import type { Vec3 } from '../../src/connection/types.ts';
import { isShulkerBox, shulkerContents } from '../../src/skills/container/chest.ts';
import { itemDisplayName } from '../../src/world/inventory.ts';
import { clearAreaHome, E2E, FEET_Y, homeCmd, prepareServer, privateArea, sleep, startHomeBot, teleport, until, type HomeBot } from './home-truth.ts';

const SWAPS = Number(process.env.P1_SWAPS ?? 4);
const OUT = process.env.P1_OUT;
const centre = (p: Vec3): Vec3 => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 });
const bare = (s: string) => s.replace(/^minecraft:/, '');

/** The green box's loot (the Realm's, 2026-11-16: about 13 stacks). */
const LOOT: [string, number, number][] = [
  ['cobblestone', 64, 2], ['andesite', 40, 1], ['redstone', 17, 1], ['arrow', 15, 1], ['bone', 12, 1], ['gunpowder', 9, 1], ['feather', 6, 1],
  ['stick', 2, 1], ['bow', 1, 1], ['copper_helmet', 1, 1], ['copper_boots', 1, 1], ['tuff', 30, 1],
];

describe.skipIf(!E2E)('@bds read errors: the Realm boxes swapped (Track P1)', () => {
  const area = privateArea();
  const at = { x: area.x + 40, y: FEET_Y, z: area.z };
  let bot: HomeBot | undefined;
  const failures: ReadFailure[] = [];
  const out = (o: unknown) => {
    if (OUT) appendFileSync(OUT, `${JSON.stringify(o, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))}\n`);
  };
  const inv = (b: HomeBot) => b.built.mobility!.world.inventory;
  // (the Script API cannot read a box item's contents: two boxes of one colour look the same to truth:inv)
  const model = (b: HomeBot) => inv(b).slots.slice(0, 36).map((s) => (s && s.count > 0 ? `${s.name} x${s.count}` : '-'));
  const server = async (b: HomeBot) => (await b.truth.ok<{ slots: ({ typeId: string; amount: number } | null)[] }>('inv', [b.name])).slots.slice(0, 36).map((s) => (s ? `${bare(s.typeId)} x${s.amount}` : '-'));
  const boxAt = (b: HomeBot, pred: (i: number) => boolean) => inv(b).slots.slice(0, 36).findIndex((s, i) => !!s && isShulkerBox(s.name) && pred(i));

  async function pickUp(b: HomeBot, cmd: string, args: (string | number)[], want: (i: number) => boolean, what: string): Promise<number> {
    const feet = b.task.position()!;
    const p = { x: Math.floor(feet.x) + 2, y: Math.floor(feet.y), z: Math.floor(feet.z) };
    await b.truth.ok(cmd, [p.x, p.y, p.z, ...args]);
    await sleep(1200);
    if (boxAt(b, want) < 0) await b.built.mobility!.skills.collect(4, 160, { origin: centre(p), filter: (it) => isShulkerBox(it.name) });
    return until(() => {
      const k = boxAt(b, want);
      return k >= 0 ? k : undefined;
    }, 15_000, what);
  }

  beforeAll(async () => {
    await prepareServer();
    const b = await startHomeBot('P1');
    bot = b;
    b.conn.onReadError((f) => {
      failures.push(f);
      out({ kase: 'read_error', ...f, bytes: f.bytes?.toString('base64') });
    });
    // the raw bytes of every item_stack_response (P1_DUMP=1)
    if (process.env.P1_DUMP === '1') {
      const c = (b.conn as unknown as { client?: { on(e: string, f: (d: { data: { name: string; params: unknown }; fullBuffer?: Buffer }) => void): void } }).client;
      c?.on('packet', (d) => {
        if (/item_stack_response|inventory_slot|inventory_content|container_open/.test(d.data.name)) out({ kase: 'packet', name: d.data.name, hex: d.fullBuffer?.toString('hex'), params: d.data.params });
      });
    }
    await teleport(b, centre(at));
    await clearAreaHome(b.truth, at, 8, 4);
  }, 300_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.clearAround(centre(at), 16).catch(() => undefined);
      await clearAreaHome(bot.truth, at, 8, 4).catch(() => undefined);
      await bot.truth.ok('clear', [bot.name]).catch(() => undefined);
      await bot.stop();
    }
  }, 120_000);

  it('the named loot box and the rockets box swapped back and forth: every swap answered, no packet unreadable, the model as the server', async () => {
    const b = bot!;
    await b.truth.ok('clear', [b.name]);
    await until(() => (inv(b).slots.slice(0, 36).every((s) => !s) ? true : undefined), 10_000, 'an empty inventory');
    const odds = ['torch', 'bread', 'oak_planks', 'cooked_beef', 'golden_carrot', null, 'stone_pickaxe', 'wheat_seeds', 'coal'];
    for (let i = 0; i < 9; i++) if (odds[i]) await b.truth.ok('setslot', [b.name, i, odds[i]!, odds[i] === 'stone_pickaxe' ? 1 : 10]);
    // the red box of rockets into hotbar slot 5 (the only free one)
    const red = await pickUp(b, 'boxdrop', ['firework_rocket', 64, 7], (i) => i === 5, 'the rockets box in hotbar slot 5');
    expect(red).toBe(5);
    for (let i = 9; i < 15; i++) await b.truth.ok('setslot', [b.name, i, ['dirt', 'gravel', 'granite', 'diorite', 'raw_iron', 'string'][i - 9]!, 20]);
    // the green box: mixed loot, then named bot_loot, into main slot 15
    const specs = LOOT.flatMap(([id, n, k]) => [id, n, k]);
    const green = await pickUp(b, 'boxmix', specs, (i) => i === 15, 'the loot box in slot 15');
    await b.truth.ok('nameinv', [b.name, green, 'bot_loot']);
    await until(() => (itemDisplayName(inv(b).rawItem(0, green)) === 'bot_loot' ? true : undefined), 10_000, 'the box named bot_loot');
    if (process.env.P1_BOTHNAMED === '1') {
      await b.truth.ok('nameinv', [b.name, red, 'bot_loot']);
      await until(() => (itemDisplayName(inv(b).rawItem(0, red)) === 'bot_loot' ? true : undefined), 10_000, 'the red box named bot_loot');
    }
    out({ kase: 'setup', red: shulkerContents(inv(b).rawItem(0, red)), green: shulkerContents(inv(b).rawItem(0, green)) });
    expect(model(b)).toEqual(await server(b));
    const kit = survivalKitOf(b.task)!;
    const results: { run: number; ok: boolean; reason?: string; failures: number; agree: boolean }[] = [];
    for (let run = 0; run < SWAPS; run++) {
      const before = failures.length;
      const r = await kit.swapSlots(15, 5);
      await sleep(1500);
      const m = model(b);
      const s = await server(b);
      const res = { run, ok: r.ok, ...(r.reason ? { reason: r.reason } : {}), failures: failures.length - before, agree: JSON.stringify(m) === JSON.stringify(s), model: [m[5], m[15]], server: [s[5], s[15]] };
      results.push(res);
      out({ kase: 'swap', ...res });
      console.log(`[p1] swap ${run}: ${JSON.stringify(res)}`);
    }
    for (const r of results) {
      expect(r.failures).toBe(0);
      expect(r.ok).toBe(true);
      expect(r.agree).toBe(true);
    }
  }, 600_000);

  // The third Realm case (2026-11-16): two boxes named bot_loot, one of stone-like blocks, one of mixed loot with an
  // iron sword, main slot 17 and hotbar slot 3 (P1_CASE3=1; box colour is not settable here: both undyed).
  it.skipIf(process.env.P1_CASE3 !== '1')('two named boxes of many items, main 17 and hotbar 3, swapped back and forth', async () => {
    const b = bot!;
    await teleport(b, centre(at));
    await b.truth.ok('clear', [b.name]);
    await until(() => (inv(b).slots.slice(0, 36).every((s) => !s) ? true : undefined), 10_000, 'an empty inventory');
    for (let i = 0; i < 9; i++) if (i !== 3) await b.truth.ok('setslot', [b.name, i, ['torch', 'bread', 'oak_planks', null, 'cooked_beef', 'golden_carrot', 'stone_pickaxe', 'wheat_seeds', 'coal'][i]!, 5]);
    const stone = ['cobblestone', 64, 5, 'andesite', 64, 3, 'diorite', 50, 2, 'granite', 64, 2, 'tuff', 40, 2, 'cobbled_deepslate', 64, 4];
    const hb = await pickUp(b, 'boxmix', stone, (i) => i === 3, 'the stone box in hotbar slot 3');
    for (let i = 9; i < 17; i++) await b.truth.ok('setslot', [b.name, i, ['dirt', 'gravel', 'sand', 'string', 'flint', 'clay_ball', 'rotten_flesh', 'apple'][i - 9]!, 7]);
    const loot = ['coal', 23, 1, 'glass', 12, 1, 'oak_log', 30, 1, 'oak_planks', 41, 1, 'leather', 5, 1, 'wheat', 9, 1, 'raw_iron', 14, 1, 'raw_copper', 27, 1, 'feather', 6, 1, 'stick', 13, 1, 'paper', 3, 1, 'arrow', 18, 1, 'gunpowder', 11, 1, 'bone', 8, 1, 'iron_sword', 1, 1];
    const main = await pickUp(b, 'boxmix', loot, (i) => i === 17, 'the loot box in slot 17');
    for (const k of [hb, main]) {
      await b.truth.ok('nameinv', [b.name, k, 'bot_loot']);
      await until(() => (itemDisplayName(inv(b).rawItem(0, k)) === 'bot_loot' ? true : undefined), 10_000, `box ${k} named bot_loot`);
    }
    out({ kase: 'case3-setup', hb: shulkerContents(inv(b).rawItem(0, hb)), main: shulkerContents(inv(b).rawItem(0, main)) });
    const kit = survivalKitOf(b.task)!;
    const results: { run: number; ok: boolean; failures: number }[] = [];
    for (let run = 0; run < SWAPS; run++) {
      const before = failures.length;
      const r = await kit.swapSlots(17, 3);
      await sleep(1500);
      const res = { run, ok: r.ok, ...(r.reason ? { reason: r.reason } : {}), failures: failures.length - before, agree: JSON.stringify(model(b)) === JSON.stringify(await server(b)) };
      results.push(res);
      out({ kase: 'case3-swap', ...res });
      console.log(`[p1] case3 swap ${run}: ${JSON.stringify(res)}`);
    }
    for (const r of results) expect(r).toMatchObject({ ok: true, failures: 0, agree: true });
  }, 600_000);

  it.skipIf(!process.env.P1_STRUCT)('boxes with the Realm NBT (a structure): swapped back and forth', async () => {
    const b = bot!;
    await teleport(b, centre(at));
    await b.truth.ok('clear', [b.name]);
    await until(() => (inv(b).slots.slice(0, 36).every((s) => !s) ? true : undefined), 10_000, 'an empty inventory');
    const odds = ['torch', 'bread', 'oak_planks', 'cooked_beef', 'golden_carrot', null, 'stone_pickaxe', 'wheat_seeds', 'coal'];
    for (let i = 0; i < 9; i++) if (odds[i]) await b.truth.ok('setslot', [b.name, i, odds[i]!, odds[i] === 'stone_pickaxe' ? 1 : 10]);
    for (let i = 9; i < 15; i++) await b.truth.ok('setslot', [b.name, i, ['dirt', 'gravel', 'granite', 'diorite', 'raw_iron', 'string'][i - 9]!, 20]);
    const feet = b.task.position()!;
    const p = { x: Math.floor(feet.x) + 2, y: Math.floor(feet.y), z: Math.floor(feet.z) };
    await b.truth.ok('place', [process.env.P1_STRUCT!, p.x, p.y, p.z]);
    await sleep(500);
    await homeCmd('setblock', String(p.x), String(p.y), String(p.z), 'air', '[]', 'destroy');
    await sleep(1500);
    await b.built.mobility!.skills.collect(4, 160, { origin: centre(p) });
    await sleep(1500);
    const green = await until(() => {
      const k = boxAt(b, (i) => itemDisplayName(inv(b).rawItem(0, i)) === 'bot_loot');
      return k >= 0 ? k : undefined;
    }, 15_000, 'the bot_loot box');
    const red = await until(() => {
      const k = inv(b).slots.slice(0, 36).findIndex((s) => s?.name === 'red_shulker_box');
      return k >= 0 ? k : undefined;
    }, 15_000, 'the red box');
    out({ kase: 'setup-struct', green, red, model: model(b), failuresSoFar: failures.length });
    const kit = survivalKitOf(b.task)!;
    const results: { run: number; ok: boolean; reason?: string; failures: number; agree: boolean }[] = [];
    for (let run = 0; run < SWAPS; run++) {
      const before = failures.length;
      const r = await kit.swapSlots(green, red);
      await sleep(1500);
      const m = model(b);
      const s = await server(b);
      const res = { run, ok: r.ok, ...(r.reason ? { reason: r.reason } : {}), failures: failures.length - before, agree: JSON.stringify(m) === JSON.stringify(s), model: [m[green], m[red]], server: [s[green], s[red]] };
      results.push(res);
      out({ kase: 'swap-struct', ...res });
      console.log(`[p1] struct swap ${run}: ${JSON.stringify(res)}`);
    }
    expect(failures).toEqual([]);
    for (const r of results) {
      expect(r.ok).toBe(true);
      expect(r.agree).toBe(true);
    }
  }, 600_000);

  it.skipIf(process.env.P1_MISMATCH !== '1')('probe: what the server sends for an inventory_mismatch transaction', async () => {
    const b = bot!;
    const seen: { t: number; name: string; window?: unknown; n?: number }[] = [];
    const t0 = Date.now();
    const offs = ['inventory_content', 'inventory_slot', 'player_hotbar', 'mob_equipment'].map((n) =>
      b.conn.on(n, (p: Record<string, unknown>) => {
        seen.push({ t: Date.now() - t0, name: n, window: p.window_id, n: Array.isArray(p.input) ? (p.input as unknown[]).length : undefined });
      }),
    );
    b.conn.queue('inventory_transaction', { transaction: { legacy: { legacy_request_id: 0 }, transaction_type: 'inventory_mismatch', actions: [] } });
    await sleep(3000);
    for (const o of offs) o();
    out({ kase: 'mismatch', seen });
    console.log(`[p1] mismatch: ${JSON.stringify(seen)}`);
  }, 60_000);

  it('a lost item_stack_response (injected parse failure): the swap is told done, the model as the server within 3 s', async () => {
    const b = bot!;
    // the next item_stack_response (id 148) fails to parse, as on the Realm
    const client = (b.conn as unknown as { client?: { deserializer: { parsePacketBuffer(buf: Buffer): unknown } } }).client!;
    const parser = client.deserializer;
    const orig = parser.parsePacketBuffer.bind(parser);
    let armed = true;
    // P1_BEFORE=1: the resync rule off (the behaviour before Track P1)
    if (process.env.P1_BEFORE === '1') b.built.mobility!.world.resync.enabled = false;
    parser.parsePacketBuffer = (buf: Buffer) => {
      if (armed && buf[0] === 0x94 && buf[1] === 0x01) {
        armed = false;
        throw new Error('Read error for undefined : Missing characters in string, found size is 69 expected size was 241 (injected)');
      }
      return orig(buf);
    };
    try {
      const kit = survivalKitOf(b.task)!;
      // a box with a stack of another kind (truth:inv tells them apart; two boxes of one colour it cannot)
      const x = inv(b).slots.slice(0, 36).findIndex((s) => !!s && isShulkerBox(s.name));
      const y = inv(b).slots.slice(9, 36).findIndex((s) => !!s && !isShulkerBox(s.name)) + 9;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(9);
      const before = failures.length;
      const logFrom = b.logs.length;
      const t0 = Date.now();
      const r = await kit.swapSlots(x, y);
      const ms = Date.now() - t0;
      const agreeAt = await until(async () => (JSON.stringify(model(b)) === JSON.stringify(await server(b)) ? Date.now() - t0 : undefined), 6000, 'the model as the server').catch(() => -1);
      const lines = b.logs.slice(logFrom).filter((l) => /inventory: |hotbar: /.test(l));
      const res = { ok: r.ok, reason: r.reason, swapMs: ms, agreeMs: agreeAt, failures: failures.length - before, armed, lines };
      out({ kase: 'injected', ...res });
      console.log(`[p1] injected: ${JSON.stringify(res)}`);
      expect(armed).toBe(false);
      expect(failures.length - before).toBe(1);
      expect(r.ok).toBe(true);
      expect(agreeAt).toBeGreaterThanOrEqual(0);
      expect(agreeAt).toBeLessThan(3000);
    } finally {
      parser.parsePacketBuffer = orig;
      b.built.mobility!.world.resync.enabled = true;
    }
  }, 120_000);
});