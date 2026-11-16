// e2e (tag @bds), Track V1 (ADR 0090, docs/inventory.md): room in the inventory on bds-home (flat, peaceful, truth
// pack). One afk-task bot (walking, the CLI's wiring, settings in memory) in its own random area. Each inventory is set
// slot by slot by truth (truth:setslot; the fireworks box is dropped by truth:boxdrop and picked up into the last free
// slot) while a held user process keeps every chore off; then the hold goes and the room chore acts on its own.
//   late       the Realm bot's inventory away from home (36 of 36: netherite kit worn and carried, elytra, 6 x 64 + 38
//              loose rockets beside a fireworks box of 165, 5 empty boxes, 7 kinds of food, mob drops, three split
//              stacks): free slots before and after, every item counted (loose and boxed), nothing dropped
//   home       the same inventory at home with chests and a chest of spare boxes: the unload starts below 4 free with
//              6 stacks to unload (under the old bar of 8), 4 of the 5 empty boxes go back to the chest of spares
//   early      stone tools after an hour of mining (36 of 36: stone kinds, ores, coal, junk, no box, no home): the junk and
//              the stone beyond 64 a kind go, nothing of worth; 4 more stacks of cobblestone given: room again, never
//              36 of 36 once idle; the drops are not picked up again
//   faults     place and the farm click with 36 of 36 and the item in the main inventory: before (the exchange taken
//              away: what main does, and now said in the log) move_failed; after: the item exchanged into the hotbar
// Env: HOME_BDS_HOST / HOME_BDS_PORT / HOME_BDS_CONTAINER (home-truth.ts; default bds-home on 19196), HOME_VERBOSE=1,
// ROOM_RUNS (default 5: the runs of each case).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { isShulkerBox, shulkerContents } from '../../src/skills/container/chest.ts';
import { exchangeFor, setExchange } from '../../src/skills/container/exchange.ts';
import { ItemClicker } from '../../src/skills/farm/click.ts';
import { BaseProcess, PRIORITY, type ProcessKind } from '../../src/tasks/process/manager.ts';
import type { Containers } from '../../src/world/containers.ts';
import type { Hotbar } from '../../src/world/hotbar.ts';
import { buildHome, clearAreaHome, E2E, FEET_Y, prepareServer, privateArea, removeHome, sleep, startHomeBot, teleport, truthLoaded, until, type HomeBot, type HomeLayout } from './home-truth.ts';

const F = FEET_Y;
const RUNS = Number(process.env.ROOM_RUNS ?? 5);
const centre = (p: Vec3): Vec3 => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 });

/** A user process that does nothing: while it is there no chore starts (the inventory is set up meanwhile). */
class Hold extends BaseProcess {
  readonly name = 'hold';
  readonly kind: ProcessKind = 'user';
  get priority(): number {
    return PRIORITY.user;
  }
  protected run(): void {}
  protected halt(): void {}
  status() {
    return { line: 'hold: the test sets the inventory up' };
  }
}

type Slot = [item: string, count: number];

/** The late-game inventory (slot 17 is left for the fireworks box, picked up last). */
const LATE: Slot[] = [
  ['netherite_sword', 1], ['netherite_pickaxe', 1], ['netherite_shovel', 1], ['netherite_axe', 1], ['firework_rocket', 64], ['cooked_beef', 24], ['bow', 1], ['cobblestone', 16], ['golden_carrot', 20],
  ['arrow', 15], ['elytra', 1], ['firework_rocket', 64], ['firework_rocket', 64], ['firework_rocket', 64], ['firework_rocket', 64], ['firework_rocket', 64], ['firework_rocket', 38], ['air', 0],
  ['green_shulker_box', 1], ['green_shulker_box', 1], ['green_shulker_box', 1], ['green_shulker_box', 1], ['green_shulker_box', 1], ['bread', 12], ['cooked_chicken', 10], ['carrot', 32], ['potato', 8],
  ['apple', 5], ['cooked_beef', 7], ['bone', 12], ['bone', 7], ['redstone', 17], ['stick', 2], ['wheat_seeds', 4], ['grass_block', 1], ['bread', 3],
];

/**
 * Track V1 follow-up: the live inventory at home after the room chore's pass (the Realm, 2026-11-15: 0 -> 5 free): two
 * stacks of rockets loose (the rest in the fireworks box), 5 free, the 5 empty boxes still carried.
 */
const LATE5: Slot[] = LATE.map((x, i): Slot => (i >= 12 && i <= 16 ? ['air', 0] : x));

/** Stone tools after an hour of mining: 36 of 36. */
const EARLY: Slot[] = [
  ['stone_pickaxe', 1], ['stone_axe', 1], ['stone_shovel', 1], ['stone_sword', 1], ['torch', 23], ['cobblestone', 64], ['bread', 6], ['crafting_table', 1], ['coal', 41],
  ['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 30], ['cobblestone', 20], ['cobbled_deepslate', 64],
  ['cobbled_deepslate', 64], ['cobbled_deepslate', 12], ['dirt', 64], ['dirt', 9], ['gravel', 14], ['andesite', 64], ['andesite', 22], ['diorite', 31], ['granite', 18],
  ['tuff', 40], ['raw_iron', 23], ['raw_copper', 37], ['flint', 3], ['rotten_flesh', 5], ['bone', 3], ['string', 2], ['oak_log', 10], ['lapis_lazuli', 11],
];

describe.skipIf(!E2E)('@bds home: room in the inventory (Track V1)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: HomeBot | undefined;
  let layout: HomeLayout | undefined;
  const c = area;
  const away = { x: c.x + 60, y: F, z: c.z }; // out of home's reach

  const inv = (b: HomeBot) => b.built.mobility!.world.inventory;
  const free = (b: HomeBot) => inv(b).slots.slice(0, 36).filter((s) => !s || s.count <= 0).length;
  /** Every item the bot carries by name, loose and inside its boxes (`boxed:` names), the boxes themselves too. */
  const carried = (b: HomeBot): Record<string, number> => {
    const out: Record<string, number> = {};
    inv(b)
      .slots.slice(0, 36)
      .forEach((s, i) => {
        if (!s || s.count <= 0) return;
        out[s.name] = (out[s.name] ?? 0) + s.count;
        if (isShulkerBox(s.name)) for (const [k, v] of Object.entries(shulkerContents(inv(b).rawItem(0, i)))) out[`boxed:${k}`] = (out[`boxed:${k}`] ?? 0) + v;
      });
    return out;
  };
  /** Loose and boxed of one item together. */
  const total = (m: Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(m)) {
      const n = k.replace(/^boxed:/, '');
      out[n] = (out[n] ?? 0) + v;
    }
    return out;
  };
  const diff = (a: Record<string, number>, b: Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if ((a[k] ?? 0) !== (b[k] ?? 0)) out[k] = (b[k] ?? 0) - (a[k] ?? 0);
    return out;
  };

  const given = (list: readonly Slot[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [k, v] of list) if (k !== 'air') out[k] = (out[k] ?? 0) + v;
    return out;
  };

  async function fill(b: HomeBot, list: readonly Slot[], fireworks?: number): Promise<void> {
    await b.truth.ok('clear', [b.name]);
    await until(() => (inv(b).slots.slice(0, 36).every((s) => !s) ? true : undefined), 10_000, 'an empty inventory');
    for (let i = 0; i < list.length; i++) {
      const [item, n] = list[i]!;
      if (item !== 'air') await b.truth.ok('setslot', [b.name, i, item, n]);
    }
    const want = list.filter(([it]) => it !== 'air').length;
    await until(() => (36 - free(b) >= want ? true : undefined), 15_000, `${want} slots in the model`);
    if (fireworks) {
      const feet = b.task.position()!;
      const at = { x: Math.floor(feet.x) + 1, y: Math.floor(feet.y), z: Math.floor(feet.z) };
      await b.truth.ok('boxdrop', [at.x, at.y, at.z, 'firework_rocket', Math.ceil(fireworks / 3), 3]);
      const has = () => (inv(b).slots.slice(0, 36).some((s, k) => !!s && isShulkerBox(s.name) && shulkerContents(inv(b).rawItem(0, k)).firework_rocket) ? true : undefined);
      await sleep(1200);
      if (!has()) await b.built.mobility!.skills.collect(4, 160, { origin: centre(at), filter: (it) => isShulkerBox(it.name) });
      await until(has, 10_000, 'the fireworks box in the inventory');
    }
    await b.built.mobility!.loop.waitTicks(10);
  }

  /** Release the hold and wait for the room chore's pass line (or `ms`). */
  async function roomPass(b: HomeBot, hold: Hold, ms = 90_000): Promise<{ line: string; s: number }> {
    const from = b.logs.length;
    const t0 = Date.now();
    b.processes.stop(hold);
    const line = await until(() => b.logs.slice(from).find((l) => /inventory: \d+ -> \d+ slots free in/.test(l)), ms, 'the room pass line').catch((e: unknown) => {
      const recent = b.logs.slice(from).filter((l) => /inventory|keeper|supply/.test(l)).slice(-6);
      throw new Error(`${e instanceof Error ? e.message : String(e)}; ${free(b)} free; recent: ${recent.join(' | ') || 'none'}`);
    });
    return { line: line.replace(/^\S+ info /, ''), s: (Date.now() - t0) / 1000 };
  }

  const held = (b: HomeBot): Hold => b.processes.add(new Hold());

  beforeAll(async () => {
    await prepareServer();
    const b = await startHomeBot('Room');
    bot = b;
    await teleport(b, centre(away));
    await clearAreaHome(b.truth, away, 10, 5);
    await b.truth.ok('equip', [b.name, 'Head', 'netherite_helmet']);
    await b.truth.ok('equip', [b.name, 'Chest', 'netherite_chestplate']);
    await b.truth.ok('equip', [b.name, 'Legs', 'netherite_leggings']);
    await b.truth.ok('equip', [b.name, 'Feet', 'netherite_boots']);
  }, 300_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.clearAround(centre(away), 24).catch(() => undefined);
      await clearAreaHome(bot.truth, away, 10, 5).catch(() => undefined);
      if (layout) await removeHome(bot, layout, c).catch(() => undefined);
      await bot.stop();
    }
    console.log(`[home-room e2e] area cell ${area.cell} (${area.x}, ${area.z}), ${RUNS} runs a case\n  ${notes.join('\n  ')}`);
  }, 120_000);

  it('late game away from home: 0 free -> the rockets beyond two stacks into the fireworks box, every item counted', async () => {
    const b = bot!;
    for (let run = 1; run <= RUNS; run++) {
      const hold = held(b);
      await teleport(b, centre(away));
      await b.truth.clearAround(centre(away), 12).catch(() => undefined);
      await fill(b, LATE, 165);
      const before = carried(b);
      const f0 = free(b);
      const r = await roomPass(b, hold);
      await sleep(3000); // anything dropped would be picked up again meanwhile
      const after = carried(b);
      const f1 = free(b);
      notes.push(`late ${run}: ${f0} -> ${f1} free in ${r.s.toFixed(1)} s; ${r.line}; loose rockets ${after.firework_rocket ?? 0}, boxed ${after['boxed:firework_rocket'] ?? 0}; changed ${JSON.stringify(diff(before, after))}`);
      expect(f0).toBe(0);
      expect(f1).toBeGreaterThanOrEqual(4);
      expect(diff(total(before), total(after))).toEqual({}); // nothing lost, nothing dropped
      expect(after.firework_rocket).toBe(128);
      expect(after['boxed:firework_rocket']).toBe(165 + 294);
      for (const k of ['netherite_sword', 'elytra', 'bow', 'arrow', 'bone', 'redstone', 'cooked_beef', 'golden_carrot', 'carrot', 'potato', 'wheat_seeds', 'cobblestone', 'green_shulker_box']) expect(after[k]).toBe(before[k]);
    }
  }, 900_000);

  it('early game away from home: the junk and the stone beyond 64 a kind go, nothing of worth; room again after more stacks', async () => {
    const b = bot!;
    const worth = ['stone_pickaxe', 'stone_axe', 'stone_shovel', 'stone_sword', 'torch', 'bread', 'crafting_table', 'coal', 'raw_iron', 'raw_copper', 'flint', 'bone', 'oak_log', 'lapis_lazuli'];
    for (let run = 1; run <= RUNS; run++) {
      const hold = held(b);
      await teleport(b, centre(away));
      await b.truth.clearAround(centre(away), 12).catch(() => undefined);
      await fill(b, EARLY);
      // what was given (the keeper may drop the junk at 36 of 36 while the slots are set: that is main's rule)
      const before = given(EARLY);
      const f0 = free(b);
      const r = await roomPass(b, hold);
      await sleep(4000);
      const mid = carried(b);
      const f1 = free(b);
      // more stacks of cobblestone (a mining run's pickups) until 2 are free: room again
      const hold2 = held(b);
      const more = Math.max(0, f1 - 2);
      for (let i = 0; i < more; i++) await b.truth.ok('give', [b.name, 'cobblestone', 64]);
      await until(() => ((carried(b).cobblestone ?? 0) >= (mid.cobblestone ?? 0) + 64 * more ? true : undefined), 10_000, 'the cobblestone given');
      const f2 = free(b);
      const r2 = await roomPass(b, hold2);
      await sleep(4000);
      const after = carried(b);
      const f3 = free(b);
      notes.push(`early ${run}: ${f0} -> ${f1} free in ${r.s.toFixed(1)} s (${r.line}); dropped ${JSON.stringify(diff(before, mid))}; +${more} stacks: ${f2} -> ${f3} free (${r2.line})`);
      expect(f0).toBeLessThanOrEqual(2); // the keeper drops the junk at 36 of 36 while the slots are set (main's rule)
      expect(f1).toBeGreaterThanOrEqual(4);
      expect(f3).toBeGreaterThanOrEqual(4);
      for (const k of worth) expect([k, mid[k]]).toEqual([k, before[k]]);
      for (const k of worth) expect([k, after[k]]).toEqual([k, before[k]]);
      for (const [k, v] of Object.entries(diff(before, mid))) {
        expect(['rotten_flesh', 'string', 'cobblestone', 'cobbled_deepslate', 'dirt', 'andesite']).toContain(k);
        expect(v).toBeLessThan(0);
      }
      for (const k of ['cobblestone', 'cobbled_deepslate', 'dirt', 'andesite', 'diorite', 'granite', 'tuff', 'gravel']) expect(after[k] ?? 0).toBeGreaterThanOrEqual(Math.min(64, before[k] ?? 0));
    }
  }, 900_000);

  it('faults: place and the farm click with 36 of 36, before (no exchange: said once a minute) and after (exchanged in)', async () => {
    const b = bot!;
    const mob = b.built.mobility!;
    const world = mob.world;
    const parts = (mob.skills as unknown as { parts: { containers?: Containers; hotbar?: Hotbar } }).parts;
    if (!parts.containers || !parts.hotbar) throw new Error('no containers or hotbar on the skills');
    const clicker = new ItemClicker({
      source: b.conn,
      loop: mob.loop,
      world: { blockAt: (q) => world.blockAt(q), onBlockUpdate: (fn) => world.onBlockUpdate(fn), chunks: world.chunks, inventory: world.inventory },
      hotbar: parts.hotbar,
      containers: parts.containers,
      runtimeId: () => world.self.runtimeId,
      logger: { debug() {}, info: (m: string) => b.logs.push(`test:click info ${m}`), warn: (m: string) => b.logs.push(`test:click warn ${m}`), error() {} },
    });
    const swap = exchangeFor(world.inventory);
    if (!swap) throw new Error('no exchange registered by the survival kit');
    // the hotbar: 9 kinds no job asks for; the main inventory full of dirt; the wanted item in slot 20
    const FULL: Slot[] = [['stick', 1], ['feather', 1], ['gunpowder', 1], ['paper', 1], ['leather', 1], ['flint', 1], ['clay_ball', 1], ['brick', 1], ['bone', 1], ...Array.from({ length: 27 }, (): Slot => ['dirt', 64])];
    for (let run = 1; run <= RUNS; run++) {
      for (const [what, item] of [['place', 'cobblestone'], ['click', 'stone_hoe']] as const) {
        for (const phase of ['before', 'after'] as const) {
          const hold = held(b);
          await teleport(b, centre(away));
          await b.truth.clearAround(centre(away), 12).catch(() => undefined);
          await clearAreaHome(b.truth, away, 4, 3);
          const list = FULL.map((s, i): Slot => (i === 20 ? [item, item === 'cobblestone' ? 5 : 1] : s));
          await fill(b, list);
          const before = carried(b);
          if (phase === 'before') setExchange(world.inventory, undefined);
          const from = b.logs.length;
          const target = { x: away.x + 2, y: F, z: away.z };
          let ok: boolean;
          let reason: string | undefined;
          try {
            if (what === 'place') {
              const r = await mob.skills.place(target, { item: 'cobblestone', face: 'up' });
              ok = r.ok;
              reason = r.ok ? undefined : r.reason;
            } else {
              const dirt = { x: away.x + 1, y: F - 1, z: away.z };
              await truthLoaded(b.truth, 'set', [dirt.x, dirt.y, dirt.z, 'dirt']);
              await mob.loop.waitTicks(5);
              const r = await clicker.useOn(dirt, 'stone_hoe');
              ok = r.ok;
              reason = r.ok ? undefined : r.reason;
            }
          } finally {
            setExchange(world.inventory, swap);
          }
          const after = carried(b);
          const logs = b.logs.slice(from).filter((l) => /(place|click): (no hotbar slot|.* moved from slot)/.test(l)).map((l) => l.replace(/^\S+ /, ''));
          b.processes.stop(hold);
          notes.push(`${what} ${phase} ${run}: ${ok ? 'ok' : reason}; slot 20 ${inv(b).slots[20]?.name}; ${logs.join(' | ') || 'no line'}`);
          if (phase === 'before') {
            expect([what, phase, ok, reason]).toEqual([what, phase, false, 'move_failed']);
            if (run === 1) expect(logs.some((l) => l.includes('no exchange is wired'))).toBe(true); // then once a minute at most
            expect(diff(before, after)).toEqual({});
          } else {
            expect([what, phase, ok]).toEqual([what, phase, true]);
            expect(logs.some((l) => l.includes(`${item} moved from slot 20 to`))).toBe(true);
            // the item given up is in slot 20 now, nothing lost (a placed block is one cobblestone less)
            expect(diff(before, after)).toEqual(what === 'place' ? { cobblestone: -1 } : {});
          }
        }
      }
    }
  }, 900_000);

  /** The home (built once): the chests of home-truth's layout, read by a scan. */
  async function homeReady(b: HomeBot): Promise<HomeLayout> {
    if (layout) return layout;
    const hold0 = held(b);
    await b.truth.ok('clear', [b.name]);
    await until(() => (inv(b).slots.slice(0, 36).every((x) => !x) ? true : undefined), 10_000, 'an empty inventory');
    layout = await buildHome(b, c);
    b.task.home!.set(layout.home);
    b.settings.set('autoUnload', 'on');
    await teleport(b, centre(layout.home));
    b.processes.stop(hold0);
    const from0 = b.said.length;
    await b.command('!chests scan');
    notes.push(`home scan: ${await b.reply((s) => /^chests: \d+ within /.test(s), from0, 120_000)}`);
    return layout;
  }

  /** The chests as buildHome left them (the unload's targets emptied, 3 empty boxes in the chest of spares), read again. */
  async function resetChests(b: HomeBot, L: HomeLayout, spares = 3): Promise<void> {
    for (const p of [L.empty, L.coal, L.wood, L.barrel]) await truthLoaded(b.truth, 'container', [p.x, p.y, p.z, 'clear']).catch(() => undefined);
    await b.truth.chestPut(L.coal, 'coal', 20);
    await b.truth.chestPut(L.coal, 'iron_ingot', 10);
    await b.truth.chestPut(L.wood, 'oak_log', 32);
    await b.truth.chestPut(L.barrel, 'dirt', 5);
    await truthLoaded(b.truth, 'container', [L.boxes.x, L.boxes.y, L.boxes.z, 'clear']);
    if (spares > 0) await b.truth.chestPut(L.boxes, 'undyed_shulker_box', 1, spares);
    const fromClear = b.said.length;
    await b.command('!chests clear');
    await b.reply(() => true, fromClear, 10_000).catch(() => undefined);
    const fromScan = b.said.length;
    await b.command('!chests scan');
    await b.reply((x) => /^chests: \d+ within /.test(x), fromScan, 120_000);
  }

  it('at home with chests and a chest of spares: below 4 free the unload starts (6 stacks), the spare boxes go back', async () => {
    const b = bot!;
    const L = await homeReady(b);
    const chests = [L.coal, L.wood, L.empty, L.boxes, L.barrel];
    const stored = async (): Promise<Record<string, number>> => {
      const out: Record<string, number> = {};
      for (const p of chests) for (const [k, v] of Object.entries((await b.truth.box(p)).counts)) out[k] = (out[k] ?? 0) + v;
      return out;
    };
    for (let run = 1; run <= RUNS; run++) {
      const hold = held(b);
      await teleport(b, centre(L.home));
      await fill(b, LATE, 165);
      await sleep(500);
      const before = carried(b);
      const chestsBefore = await stored();
      const boxesBefore = (await b.truth.box(L.boxes)).counts;
      const f0 = free(b);
      const load = b.home.logistics.load();
      const t0 = Date.now();
      const fromLogs = b.logs.length;
      b.processes.stop(hold);
      await until(() => (!b.home.logistics.busy && b.processes.active === undefined && free(b) >= 4 ? true : undefined), 180_000, 'the unload done');
      await sleep(5000);
      const s = (Date.now() - t0) / 1000;
      const after = carried(b);
      const chestsAfter = await stored();
      const boxesAfter = (await b.truth.box(L.boxes)).counts;
      const f1 = free(b);
      const moved = diff(before, after);
      const spares = (boxesAfter.green_shulker_box ?? 0) - (boxesBefore.green_shulker_box ?? 0);
      const unloadLines = b.logs.slice(fromLogs).filter((l) => /unload|inventory: /.test(l)).map((l) => l.replace(/^\S+ \w+ /, '')).slice(0, 6);
      notes.push(`home ${run}: load ${JSON.stringify(load)}; ${f0} -> ${f1} free in ${s.toFixed(0)} s; spare boxes back ${spares}; carried changed ${JSON.stringify(moved)}; ${unloadLines.join(' | ')}`);
      expect(f0).toBe(0);
      expect(load.stacks).toBeLessThanOrEqual(8); // under the old bar: it was the slot trigger
      expect(f1).toBeGreaterThanOrEqual(4);
      expect(spares).toBe(4);
      expect(after.green_shulker_box).toBe(1); // the stash step's one
      // every item counted: what left the inventory is in the chests
      const all0 = total(before);
      const all1 = total(after);
      for (const [k, v] of Object.entries(chestsBefore)) all0[k] = (all0[k] ?? 0) + v;
      for (const [k, v] of Object.entries(chestsAfter)) all1[k] = (all1[k] ?? 0) + v;
      expect(diff(all0, all1)).toEqual({});
      for (const k of ['netherite_sword', 'elytra', 'cobblestone', 'firework_rocket']) expect(after[k]).toBe(before[k]);
      await resetChests(b, L); // the unload's targets empty again for the next run
    }
  }, 1_800_000);

  // Track V1 follow-up (ADR 0090 decision 11): on the Realm the live bot at home freed 5 slots by its room pass and then
  // kept its 5 empty boxes (5 free and 6 stacks meet neither unload bar). Now the spare boxes go back on their own.
  it('at home with 5 free (the live inventory after its pass): the spare boxes go back to the chest of spares, nothing else moves', async () => {
    const b = bot!;
    const L = await homeReady(b);
    const stored = async (): Promise<Record<string, number>> => {
      const out: Record<string, number> = {};
      for (const p of [L.coal, L.wood, L.empty, L.boxes, L.barrel]) for (const [k, v] of Object.entries((await b.truth.box(p)).counts)) out[k] = (out[k] ?? 0) + v;
      return out;
    };
    for (let run = 1; run <= RUNS; run++) {
      const hold = held(b);
      await teleport(b, centre(L.home));
      await fill(b, LATE5, 165);
      await sleep(500);
      const before = carried(b);
      const chestsBefore = await stored();
      const f0 = free(b);
      const load = b.home.logistics.load();
      const t0 = Date.now();
      const fromLogs = b.logs.length;
      b.processes.stop(hold);
      const line = await until(() => b.logs.slice(fromLogs).find((l) => l.includes('unload (spare boxes): ')), 60_000, 'the spares job');
      await until(() => (!b.home.logistics.busy && b.processes.active === undefined ? true : undefined), 60_000, 'the spares job done');
      await sleep(4000); // anything else the chores would do meanwhile
      const s = (Date.now() - t0) / 1000;
      const after = carried(b);
      const chestsAfter = await stored();
      const f1 = free(b);
      const others = b.logs.slice(fromLogs).filter((l) => /(unload: unloaded|inventory: \d+ -> )/.test(l)).length; // a full unload or a room pass
      notes.push(`spares ${run}: load ${JSON.stringify(load)}; ${f0} -> ${f1} free in ${s.toFixed(0)} s; carried changed ${JSON.stringify(diff(before, after))}; chests changed ${JSON.stringify(diff(chestsBefore, chestsAfter))}; other unloads or passes ${others}; ${line.replace(/^\S+ \w+ /, '')}`);
      expect(f0).toBe(5);
      expect(load.stacks).toBeLessThanOrEqual(8);
      expect(load.spares).toBe(4);
      expect(diff(before, after)).toEqual({ green_shulker_box: -4 }); // the boxes, nothing else
      expect(diff(chestsBefore, chestsAfter)).toEqual({ green_shulker_box: 4 });
      expect(f1).toBe(9);
      expect(others).toBe(0);
      await resetChests(b, L);
    }
  }, 1_800_000);

  it('at home with no chest of spares: the spare boxes stay and the bot says so once', async () => {
    const b = bot!;
    const L = await homeReady(b);
    await resetChests(b, L, 0); // no chest holds an empty box, none is labelled for boxes
    const hold = held(b);
    await teleport(b, centre(L.home));
    await fill(b, LATE5, 165);
    await sleep(500);
    const before = carried(b);
    const fromSaid = b.said.length;
    b.processes.stop(hold);
    const kept = await until(() => b.said.slice(fromSaid).find((l) => l.includes('spare shulker box')), 30_000, 'the kept-spares line');
    await sleep(15_000); // more chore checks: said once, nothing moved
    const after = carried(b);
    const lines = b.said.slice(fromSaid).filter((l) => l.includes('spare shulker box'));
    notes.push(`no chest of spares: ${lines.length} line(s): ${kept}; carried changed ${JSON.stringify(diff(before, after))}`);
    expect(kept).toContain('I keep 4 spare shulker boxes: I know no chest of spares at home');
    expect(lines).toHaveLength(1);
    expect(diff(before, after)).toEqual({});
    await resetChests(b, L);
  }, 600_000);
});
