// e2e (tag @bds), Track B9 (docs/build.md "What a fetch round gathers"; ADR 0134): a structure file
// someone shares, built to the end from the shulker boxes it came in, with a stop and a resume and a restart of the bot in
// the middle. On a flat, peaceful server with the truth pack (bds-build by default; BUILD_BDS_PORT / BUILD_BDS_CONTAINER
// point it at another one). Long (one to three hours): only with BUILD_HOUSE=1, and the files from the env (never
// committed):
//   BUILD_HOUSE_FILE    the structure file (any format `!build file` reads), copied into the test's build folder
//   BUILD_HOUSE_BOXES   the console commands that filled the boxes: `/setblock x y z <colour>_shulker_box`, then
//                       `/replaceitem block x y z slot.container <slot> <item> <count>` lines (the coordinates are
//                       moved to beside the bot here; `/setblock ... air destroy` and other lines are ignored)
//   BUILD_HOUSE_GIVE    more items given loose, `item:count,item:count` (default: the raw materials an owner hands over
//                       besides the boxes, and what the bill cannot make)
//   BUILD_HOUSE_HOME    items put in the first home chest at the start, `item:count,...` (default: the stripped logs the
//                       house's stripped wood needs, which the bot can neither get nor make and the slots have no room for)
//   BUILD_HOUSE_STOP    the share placed at the `!build stop` (default 0.25; 0: none)
//   BUILD_HOUSE_RESTART the share placed at the restart (default 0.6; 0: none)
//   BUILD_HOUSE_OUT     a file the run's lines are appended to as it goes (the progress every few minutes, the result)
//   BUILD_HOUSE_COLUMN  buildColumnMax (default 16)
//
// The kit, as a builder hands it over: the boxes made by the commands and dropped beside the bot (`!build ... fetch` picks
// them up), the bot carrying the Realm's kit (Track B10: 4 netherite tools, a bow and arrows, an elytra, bread, rockets,
// 26 cobblestone, 2 empty white boxes, the 6 red boxes the house places) and the loose items of BUILD_HOUSE_GIVE: 33 of
// 36 slots. The home is two chests beside the site holding BUILD_HOUSE_HOME. The
// boxes hold logs, not planks: the bot crafts the planks, slabs, stairs, trapdoors and the rest itself.
// Passes when the end line says `done`, every cell (the refused ones aside) matches with its states, no scaffold block,
// no box is left in the world, and every box is carried or in a home chest.
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { homeCounts } from '../../src/chat/commands-build.ts';
import { homeControlOf } from '../../src/chat/commands-home.ts';
import { smeltControlOf } from '../../src/chat/commands-smelt.ts';
import type { Vec3 } from '../../src/connection/types.ts';
import { readStructure, STRUCTURE_EXTENSIONS } from '../../src/skills/build/formats/index.ts';
import type { StructureFormat } from '../../src/skills/build/formats/mcstructure.ts';
import { resolveBlocks, stateText } from '../../src/skills/build/states.ts';
import { isShulkerBox, shulkerContents } from '../../src/skills/container/chest.ts';
import { supplyOf } from '../../src/skills/supply/supply.ts';
import { openWorldCache, type WorldCache } from '../../src/world/cache/index.ts';
import { buildCmd, clearArea, E2E, FEET_Y, prepareServer, privateArea, sleep, startBuildBot, teleport, truthLoaded, until, type BuildBot, type BuildBotExtra } from './build-truth.ts';

const F = FEET_Y;
const FILE = process.env.BUILD_HOUSE_FILE;
const BOXES = process.env.BUILD_HOUSE_BOXES;
const RUN = E2E && process.env.BUILD_HOUSE === '1' && !!FILE && !!BOXES;
const OUT = process.env.BUILD_HOUSE_OUT;
const STOP_AT = Number(process.env.BUILD_HOUSE_STOP ?? 0.25);
const RESTART_AT = Number(process.env.BUILD_HOUSE_RESTART ?? 0.6);
const COLUMN = Number(process.env.BUILD_HOUSE_COLUMN ?? 16);
// Track B10: with the Realm's kit 6 of the raw materials fit loose (33 of 36 slots once the boxes are in); the rest are
// in a home chest (the bill brings them)
const GIVE = process.env.BUILD_HOUSE_GIVE ?? 'oak_log:16,quartz:16,tuff:16,pale_oak_log:16,sand:16,coal:32';
/** Track B9: what neither the boxes hold nor the bot makes (stripped logs: no `!get`), past the 36 slots: in a home chest. */
const HOME = process.env.BUILD_HOUSE_HOME ?? 'stripped_pale_oak_log:8,copper_ore:9,clay_ball:16,cobbled_deepslate:32,gravel:16,snow_layer:24,candle:4,turtle_egg:2';
/** Track B10: empty white boxes carried besides the handed-over ones (11 white in all with the house's 9). */
const EMPTY_WHITE = Number(process.env.BUILD_HOUSE_EMPTY ?? 2);
/** A file the bot's world over the build's box (and 6 round it) is written to at the end, as JSON cells (diagnosis). */
const DUMP = process.env.BUILD_HOUSE_DUMP;
/**
 * Track B10: the restart gives back what the server says the bot carried (`server`, the default: a real server keeps
 * the inventory) or what the bot's own model says (`model`, as in Track B9: a stale model of a box's contents loses
 * items there).
 */
const BACK = process.env.BUILD_HOUSE_BACK ?? 'server';
/** Track B10: the kinds whose every item is accounted for at the restart and the end (nothing makes them). */
const ACCOUNT = process.env.BUILD_HOUSE_ACCOUNT ?? 'smooth_quartz,pale_oak_shelf,moss_block,green_wool,light_blue_glazed_terracotta,dead_fire_coral_block,iron_block';
/** A wait of the test is a loop of polls; it says where the build is at least this often (ms). */
const SAY_EVERY = 5 * 60_000;
const centre = (p: Vec3): Vec3 => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 });
const FORMATS: Record<string, StructureFormat> = Object.fromEntries(STRUCTURE_EXTENSIONS);

const placedOf = (s: string): number | undefined => {
  const m = /(\d+) \/ (\d+) placed/.exec(s);
  return m ? Number(m[1]) : undefined;
};

/** The boxes of the commands file: colour, and per slot the item and count. */
function boxesOf(text: string): { colour: string; slots: [string, number][] }[] {
  const out: { colour: string; slots: [string, number][] }[] = [];
  for (const l of text.split(/\r?\n|\r/)) {
    const s = /^\/?setblock \S+ \S+ \S+ (?:minecraft:)?(\w+)_shulker_box\b/.exec(l.trim());
    if (s) out.push({ colour: s[1]!, slots: [] });
    const m = /^\/?replaceitem block \S+ \S+ \S+ slot\.container \d+ (?:minecraft:)?(\S+) (\d+)/.exec(l.trim());
    if (m && out.length) out.at(-1)!.slots.push([m[1]!, Number(m[2])]);
  }
  return out;
}

describe.skipIf(!RUN)('@bds build: a shared house built to the end from the shulker boxes it came in (Track B9)', () => {
  const area = privateArea();
  const notes: string[] = [];
  const builds = RUN ? mkdtempSync(join(tmpdir(), 'bedrockbot-builds-')) : '';
  const progressFile = join(builds, 'progress.json');
  const ext = FILE ? extname(FILE).toLowerCase() : '';
  const name = FILE ? basename(FILE, ext).replace(/[^\w.-]/g, '_') : 'house';
  let bot: BuildBot | undefined;
  const c = area;
  let size = { x: 1, y: 1, z: 1 };
  let X = { x: c.x, y: F, z: c.z };
  const L = { home: { x: 0, y: F, z: 0 }, chests: [] as Vec3[], start: { x: 0, y: F, z: 0 }, drop: { x: 0, y: F, z: 0 } };
  const cacheRoot = join(builds, 'cache');
  let cache: WorldCache | undefined;
  const extra: BuildBotExtra = {
    values: { buildProgress: progressFile },
    settings: { buildColumnMax: COLUMN, autoUnload: false, autoMend: false, homeChestRadius: 6 },
    attach: (built) => {
      cache = openWorldCache(built.mobility!.world, { root: cacheRoot, server: 'b9-house' });
    },
  };
  const say = (l: string): void => {
    notes.push(l);
    if (OUT) appendFileSync(OUT, `${new Date().toISOString()} ${l}\n`);
  };
  const radius = () => Math.ceil(Math.max(size.x, size.z) / 2) + 14;

  /** Shulker boxes and cobblestone (scaffold) on or above the ground in and round the site. */
  const leftIn = async (b: BuildBot): Promise<{ boxes: number; scaffold: number }> => {
    const out = { boxes: 0, scaffold: 0 };
    const r = radius();
    for (let y = F; y <= F + size.y + 4; y++) {
      for (let z = c.z - r; z <= c.z + r; z += 32) {
        const d = await b.truth.blocksDiff({ x: c.x - r, y, z }, { x: c.x + r, y, z: Math.min(c.z + r, z + 31) }, () => '*');
        for (const [k, n] of Object.entries(d.actual)) {
          const id = k.replace(/^minecraft:/, '');
          if (isShulkerBox(id)) out.boxes += n;
        }
      }
    }
    return out;
  };
  const boxItems = async (b: BuildBot): Promise<number> => {
    const r = await b.truth.ok<{ items: { typeId: string; amount: number }[] }>('boxitems', [c.x + 0.5, F, c.z + 0.5, 100]);
    return r.items.filter((i) => isShulkerBox(i.typeId.replace(/^minecraft:/, ''))).reduce((a, i) => a + i.amount, 0);
  };
  /** Boxes in the bot's inventory (by its own view) with what each holds, and the loose items. */
  const inventory = (b: BuildBot): { boxes: { slot: number; name: string; holds: Record<string, number> }[]; loose: Record<string, number>; used: number } => {
    const inv = b.built.mobility!.world.inventory;
    const boxes: { slot: number; name: string; holds: Record<string, number> }[] = [];
    const loose: Record<string, number> = {};
    let used = 0;
    for (let k = 0; k < 36; k++) {
      const s = inv.slots[k];
      if (!s || s.count <= 0) continue;
      used++;
      if (isShulkerBox(s.name)) boxes.push({ slot: k, name: s.name, holds: shulkerContents(inv.rawItem(0, k)) });
      else loose[s.name] = (loose[s.name] ?? 0) + s.count;
    }
    return { boxes, loose, used };
  };
  /**
   * Track B10: the bot's inventory as the server has it (truth:getinv): the boxes with what each holds (by slot) and the
   * loose items. The restart rebuilds the boxes from this, not from the bot's model of them (a stale model loses items).
   */
  const serverInv = async (b: BuildBot): Promise<{ boxes: { slot: number; name: string; holds: Record<string, number> }[]; loose: Record<string, number> }> => {
    const strip = (k: string) => k.replace(/^minecraft:/, '');
    const r = await b.truth.ok<{ slots: ({ slot: number; typeId: string; amount: number } | null)[] }>('getinv', [b.name]);
    // the truth pack cannot read a carried box's contents (no inventory component on the box item, docs/get.md): the
    // boxes are the server's (slot and kind), what each holds is the item data the server sent the bot for that slot
    const model = inventory(b).boxes;
    const boxes: { slot: number; name: string; holds: Record<string, number> }[] = [];
    const loose: Record<string, number> = {};
    for (const s of r.slots) {
      if (!s || s.slot >= 36) continue;
      const name = strip(s.typeId);
      if (isShulkerBox(name)) boxes.push({ slot: s.slot, name, holds: model.find((x) => x.slot === s.slot && x.name === name)?.holds ?? {} });
      else loose[name] = (loose[name] ?? 0) + s.amount;
    }
    return { boxes, loose };
  };
  /** Track B10: item totals (loose and in boxes) of an inventory view. */
  const totalsOf = (v: { boxes: { holds: Record<string, number> }[]; loose: Record<string, number> }): Map<string, number> => {
    const m = new Map<string, number>();
    for (const [k, n] of Object.entries(v.loose)) m.set(k, (m.get(k) ?? 0) + n);
    for (const bx of v.boxes) for (const [k, n] of Object.entries(bx.holds)) m.set(k, (m.get(k) ?? 0) + n);
    return m;
  };
  /** Track B10: `item model-server` for every item the two views disagree on (empty: they agree). */
  const viewDiff = (model: Map<string, number>, server: Map<string, number>): string[] => {
    const out: string[] = [];
    for (const k of new Set([...model.keys(), ...server.keys()])) {
      const d = (model.get(k) ?? 0) - (server.get(k) ?? 0);
      if (d !== 0) out.push(`${k} ${d > 0 ? '+' : ''}${d}`);
    }
    return out;
  };
  /**
   * Track B10: where every item of `kinds` is now, against what was handed over: placed in the build's box, carried (the
   * server's view), in the home chests, lying about. A kind nothing makes must add up; one that does not was lost.
   */
  const account = async (b: BuildBot, kinds: readonly string[], start: ReadonlyMap<string, number>): Promise<string> => {
    const strip = (k: string) => k.replace(/^minecraft:/, '');
    const placed = new Map<string, number>();
    for (let y = X.y; y < X.y + size.y; y++) {
      for (let z = X.z; z < X.z + size.z; z += 26) {
        const d = await b.truth.blocksDiff({ x: X.x, y, z }, { x: X.x + size.x - 1, y, z: Math.min(X.z + size.z - 1, z + 25) }, () => '*');
        for (const [k, n] of Object.entries(d.actual)) placed.set(strip(k), (placed.get(strip(k)) ?? 0) + n);
      }
    }
    const carried = totalsOf(await serverInv(b));
    const chests = new Map<string, number>();
    for (const p of L.chests) {
      const r = await truthLoaded<{ counts?: Record<string, number> }>(b.truth, 'container', [p.x, p.y, p.z]);
      for (const [k, v] of Object.entries(r.counts ?? {})) chests.set(strip(k), (chests.get(strip(k)) ?? 0) + v);
    }
    const lying = new Map<string, number>();
    const li = await b.truth.ok<{ items: { typeId: string; amount: number; contents?: { counts?: Record<string, number> } }[] }>('boxitems', [c.x + 0.5, F, c.z + 0.5, 100]);
    for (const it of li.items) {
      lying.set(strip(it.typeId), (lying.get(strip(it.typeId)) ?? 0) + it.amount);
      for (const [k, v] of Object.entries(it.contents?.counts ?? {})) lying.set(strip(k), (lying.get(strip(k)) ?? 0) + v);
    }
    return kinds
      .map((k) => {
        const now = (placed.get(k) ?? 0) + (carried.get(k) ?? 0) + (chests.get(k) ?? 0) + (lying.get(k) ?? 0);
        return `${k}: start ${start.get(k) ?? 0}, now ${now} (placed ${placed.get(k) ?? 0}, carried ${carried.get(k) ?? 0}, chests ${chests.get(k) ?? 0}, lying ${lying.get(k) ?? 0})`;
      })
      .join('; ');
  };
  const chestBoxes = async (b: BuildBot): Promise<number> => {
    let n = 0;
    for (const p of L.chests) {
      const r = await truthLoaded<{ counts?: Record<string, number> }>(b.truth, 'container', [p.x, p.y, p.z]);
      for (const [k, v] of Object.entries(r.counts ?? {})) if (isShulkerBox(k.replace(/^minecraft:/, ''))) n += v;
    }
    return n;
  };
  /** A box of `colour` with these slots made at `at`, filled and broken by the console: it drops with its contents. */
  async function dropBox(b: BuildBot, at: Vec3, colour: string, slots: [string, number][]): Promise<void> {
    await truthLoaded(b.truth, 'set', [at.x, at.y, at.z, `${colour}_shulker_box`]);
    for (const [item, n] of slots) await truthLoaded(b.truth, 'chestput', [at.x, at.y, at.z, item, n, 1]);
    const want = slots.reduce((a, [, n]) => a + n, 0);
    await until(async () => {
      const r = await b.truth.ok<{ counts?: Record<string, number> }>('container', [at.x, at.y, at.z]);
      return Object.values(r.counts ?? {}).reduce((a, v) => a + v, 0) === want ? true : undefined;
    }, 10_000, `the ${colour} box holds ${want}`);
    await buildCmd('setblock', String(at.x), String(at.y), String(at.z), 'air', '[]', 'destroy');
  }
  /** Shulker boxes lying round the bot picked up (a restart's boxes given back). */
  async function pickUpBoxes(b: BuildBot, n: number): Promise<void> {
    const mob = b.built.mobility!;
    const have = () => inventory(b).boxes.length;
    for (let i = 0; i < 6 && have() < n; i++) {
      await mob.skills.collect(6 + 2 * i, 200, { filter: (it) => isShulkerBox(it.name) });
      await sleep(500);
    }
  }
  /** Wait for `fn`, saying where the build is every SAY_EVERY (no wait of more than that without a line). */
  async function waitFor<T>(b: () => BuildBot, fn: () => T | undefined, maxMs: number, what: string): Promise<T> {
    const t0 = Date.now();
    for (;;) {
      const v = await until(fn, SAY_EVERY, what, 1000).catch(() => undefined);
      if (v !== undefined) return v;
      const bb = b();
      say(`  waiting for ${what} (${((Date.now() - t0) / 60_000).toFixed(0)} min): ${bb.build.status()} | ${bb.processes.userProcesses().map((p) => p.name).join(',')} | ${inventory(bb).used} slots used`);
      if (Date.now() - t0 > maxMs) throw new Error(`timed out after ${maxMs} ms waiting for ${what}`);
    }
  }

  beforeAll(async () => {
    if (!RUN) return;
    copyFileSync(FILE, join(builds, `${name}${ext}`));
    const s = readStructure(readFileSync(FILE), FORMATS[ext] ?? 'litematic', name);
    size = s.size;
    X = { x: c.x - Math.floor(size.x / 2), y: F, z: c.z - Math.floor(size.z / 2) };
    const south = X.z + size.z + 5;
    L.home = { x: c.x, y: F, z: south + 2 };
    L.chests = [{ x: c.x - 2, y: F, z: south + 4 }, { x: c.x + 2, y: F, z: south + 4 }];
    L.start = { x: c.x + 6, y: F, z: south + 2 };
    L.drop = { x: c.x + 10, y: F, z: south + 1 };
    await prepareServer();
    bot = await startBuildBot('House', builds, { home: L.home }, extra);
    await teleport(bot, centre(L.home));
  }, 300_000);

  afterAll(async () => {
    if (bot) {
      for (const p of L.chests) await truthLoaded(bot.truth, 'container', [p.x, p.y, p.z, 'clear']).catch(() => undefined);
      await clearArea(bot.truth, c, radius(), size.y + 6).catch(() => undefined);
      await bot.truth.clearAround(centre(L.home), 100).catch(() => undefined);
      await bot.truth.ok('clear', [bot.name]).catch(() => undefined);
      await bot.stop().catch(() => undefined);
    }
    cache?.close();
    if (builds) rmSync(builds, { recursive: true, force: true });
    console.log(`[build-house e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 600_000);

  it('builds it all from the boxes, through a stop, a resume and a restart; every cell matches; no box or scaffold left', async () => {
    let b = bot!;
    const s = readStructure(readFileSync(join(builds, `${name}${ext}`)), FORMATS[ext] ?? 'litematic', name);
    const resolved = resolveBlocks(s.blocks);
    const refusedAt = new Set(resolved.refused.map((r) => `${r.block.pos.x},${r.block.pos.y},${r.block.pos.z}`));
    const toPlace = s.blocks.length - resolved.refused.length;
    const boxes = boxesOf(readFileSync(BOXES!, 'utf8'));
    say(`structure ${name}: ${s.blocks.length} blocks in ${size.x}x${size.y}x${size.z}, ${resolved.refused.length} refused, ${toPlace} to place; ${boxes.length} boxes of ${boxes.reduce((a, x) => a + x.slots.length, 0)} stacks`);

    // the ground, the two empty home chests, read by the bot
    await clearArea(b.truth, c, radius(), size.y + 6);
    await b.truth.ok('clearmobs', [c.x + 0.5, F, c.z + 0.5, 100]);
    for (const p of L.chests) {
      await truthLoaded(b.truth, 'set', [p.x, p.y, p.z, 'chest']);
      await truthLoaded(b.truth, 'container', [p.x, p.y, p.z, 'clear']);
    }
    const homeItems = HOME.split(',').filter(Boolean).map((x): [string, number] => [x.split(':')[0]!, Number(x.split(':')[1] ?? 1)]);
    for (const [item, n] of homeItems) await truthLoaded(b.truth, 'chestput', [L.chests[0]!.x, L.chests[0]!.y, L.chests[0]!.z, item, n, 1]);
    await teleport(b, centre(L.home));
    const scan = await homeControlOf(b.task)!.logistics.scan(() => false, { force: true, retry: true });
    say(`scan: ${scan.found} found, ${scan.read.length} read; home holds ${JSON.stringify(Object.fromEntries(homeCounts(b.task)))}`);

    // the kit carried, then the boxes dropped beside the bot
    await teleport(b, centre(L.start));
    await b.truth.ok('clear', [b.name]);
    // Track B10: the kit the bot carries on the Realm (4 tools, a bow and arrows, an elytra, food, rockets, a throwaway
    // stack, empty white boxes to 11 with the handed-over ones, the 6 red boxes the house places)
    const kit: [string, number, number][] = [
      ['netherite_pickaxe', 1, 1],
      ['netherite_axe', 1, 1],
      ['netherite_shovel', 1, 1],
      ['netherite_sword', 1, 1],
      ['bow', 1, 1],
      ['arrow', 64, 64],
      ['elytra', 1, 1],
      ['bread', 32, 64],
      ['firework_rocket', 64, 64],
      ['cobblestone', 26, 64],
      ['white_shulker_box', EMPTY_WHITE, 1],
      ['red_shulker_box', 6, 1],
      ...GIVE.split(',').filter(Boolean).map((x): [string, number, number] => [x.split(':')[0]!, Number(x.split(':')[1] ?? 1), 64]),
    ];
    for (const [item, n, per] of kit) for (let left = n; left > 0; left -= per) await b.truth.ok('give', [b.name, item, Math.min(per, left)]);
    await sleep(1500);
    for (const [i, bx] of boxes.entries()) await dropBox(b, { x: L.drop.x + (i % 4), y: F, z: L.drop.z + Math.floor(i / 4) }, bx.colour, bx.slots);
    const lying = await until(async () => {
      const n = await boxItems(b);
      return n >= boxes.length ? n : undefined;
    }, 20_000, 'the boxes lying by the bot').catch(async () => boxItems(b));
    say(`kit: ${inventory(b).used} of 36 slots used before the pickup (${JSON.stringify(inventory(b).loose)}); ${lying} boxes lying by the bot`);
    expect(lying).toBe(boxes.length);
    const boxesIn = boxes.length + EMPTY_WHITE + 6;
    // Track B10: what was handed over, by item (the boxes, the loose kit, the home chest), for the account
    const startTotals = new Map<string, number>();
    for (const bx of boxes) for (const [k, n] of bx.slots) startTotals.set(k, (startTotals.get(k) ?? 0) + n);
    for (const [k, n] of [...kit.map(([item, n]): [string, number] => [item, n]), ...homeItems]) startTotals.set(k, (startTotals.get(k) ?? 0) + n);
    const accountKinds = ACCOUNT.split(',').filter(Boolean);

    const at = `${X.x} ${X.y} ${X.z}`;
    const label = `file ${name} at ${at}`;
    const t0 = Date.now();
    const since = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;
    const trace: string[] = [];
    let last = 0;
    const poll = setInterval(() => {
      const n = placedOf(bot?.build.status() ?? '');
      if (n !== undefined && n - last >= 500) {
        last = n;
        trace.push(`${since()} ${n}`);
      }
    }, 2000);
    const placedNow = (): number => placedOf(bot?.build.status() ?? '') ?? 0;
    const fetchedAll: string[] = [];
    const logsAll: string[] = [];
    try {
      let from = b.said.length;
      await b.command(`!build file ${name} ${at} fetch`);
      const start = await b.reply((x) => x.startsWith(`building ${label}`) || (x.startsWith('build: ') && !x.startsWith('build: picked')), from, 600_000);
      say(`start (${since()}): ${b.said.slice(from).join(' || ')}`);
      expect(start).toMatch(/^building file .*: \d+ to place in \d+ sections?/);
      // the end line, or a fetch that refused (a resume's `build: nothing fetched: ...`: the build never starts again)
      const ended = (bb: BuildBot): string | undefined => bb.said.find((x) => (x.startsWith(`build ${label}:`) && !x.startsWith(`build ${label}: fetching`)) || x.startsWith('build: nothing fetched'));

      // the stop and the resume
      if (STOP_AT > 0) {
        const n = await waitFor(() => b, () => (placedNow() >= toPlace * STOP_AT || ended(b) ? true : undefined), 4 * 3_600_000, `${Math.round(STOP_AT * 100)} % placed`);
        expect(ended(b)).toBeUndefined();
        void n;
        const stopPlaced = placedNow();
        from = b.said.length;
        await b.command('!build stop');
        const stopped = await b.reply((x) => x.startsWith('stopped build ') || x.startsWith('build: '), from, 30_000);
        await waitFor(() => b, () => (b.processes.userProcesses().length === 0 ? true : undefined), 600_000, 'the stop to end');
        say(`stop at ${since()} (${stopPlaced} placed): ${stopped} | boxes in the world ${JSON.stringify(await leftIn(b))}, lying ${await boxItems(b)}`);
        from = b.said.length;
        await b.command('!build resume');
        const resumed = await b.reply((x) => x.startsWith('resuming build ') || x.startsWith('build: '), from, 60_000);
        say(`resume at ${since()}: ${resumed}`);
        expect(resumed).toMatch(/^resuming build file .*: \d+ of \d+ done/);
      }

      // the restart: the bot goes away where it stands and comes back as the same player, with what it carried
      if (RESTART_AT > 0) {
        await waitFor(() => b, () => (placedNow() >= toPlace * RESTART_AT || ended(b) ? true : undefined), 4 * 3_600_000, `${Math.round(RESTART_AT * 100)} % placed`);
        expect(ended(b)).toBeUndefined();
        // (not while a box stands or lies about for a take: the server would keep it in the world; a fetch step is fine)
        await waitFor(() => b, () => {
          const o = supplyOf(b.task)?.outstanding();
          return o && o.standing.length + o.left.length === 0 && b.built.mobility!.loop.state.onGround && !b.build.perched() ? true : undefined;
        }, 1_800_000, 'no box out');
        const goneAt = since();
        const goneFeet = b.task.position();
        const before = b.build.status();
        const modelInv = inventory(b);
        const real = await serverInv(b);
        // Track B10: the bot's model of what it carries against the server's, box by box
        const boxDiffs: string[] = [];
        for (const rb of real.boxes) {
          const mb = modelInv.boxes.find((x) => x.slot === rb.slot);
          const d = viewDiff(new Map(Object.entries(mb?.holds ?? {})), new Map(Object.entries(rb.holds)));
          if (mb?.name !== rb.name || d.length) boxDiffs.push(`slot ${rb.slot} ${rb.name}${mb && mb.name !== rb.name ? ` (model ${mb.name})` : ''}: ${d.join(', ') || 'same'}`);
        }
        for (const mb of modelInv.boxes) if (!real.boxes.some((x) => x.slot === mb.slot)) boxDiffs.push(`slot ${mb.slot} ${mb.name}: in the model only`);
        say(`restart: the model against the server: ${viewDiff(totalsOf(modelInv), totalsOf(real)).join(', ') || 'the same totals'}; boxes: ${boxDiffs.join(' | ') || 'the same'}`);
        say(`restart: account ${await account(b, accountKinds, startTotals)}`);
        const inv = BACK === 'model' ? modelInv : { ...real, used: modelInv.used };
        fetchedAll.push(...b.build.fetched);
        logsAll.push(...b.logs);
        await cache?.flush();
        cache?.close();
        cache = undefined;
        const who = b.name;
        await b.stop();
        bot = undefined;
        const saved = existsSync(progressFile) ? (JSON.parse(readFileSync(progressFile, 'utf8')) as { state: string; count: number }) : undefined;
        say(`restart at ${goneAt}: ${before} | saved ${saved?.state} ${saved?.count} done | carried ${inv.boxes.length} boxes, loose ${JSON.stringify(inv.loose)}`);
        expect(saved?.state).toBe('running');
        await sleep(8000);
        b = await startBuildBot('House', builds, { home: L.home }, { ...extra, settings: { ...extra.settings, buildResume: false }, name: who, ...(goneFeet ? { at: { x: goneFeet.x, y: Math.ceil(goneFeet.y - 0.01), z: goneFeet.z } } : {}) });
        bot = b;
        await b.truth.ok('clear', [b.name]);
        for (const [k, v] of Object.entries(inv.loose)) for (let n = v; n > 0; n -= 64) await b.truth.ok('give', [b.name, k, Math.min(64, n)]);
        // the boxes as they were, dropped at the bot's feet and picked up (this server's returning players come back empty)
        const me = b.task.position()!;
        // open spots round the bot: a full block under, air in the cell and over it and on its four sides (a box that
        // pops in a furnished room lands on a shelf or in a corner the bot cannot reach: the next spot then)
        const w = b.built.mobility!.world;
        const air = (p: Vec3) => w.blockAt(p)?.name.includes('air') === true;
        const full = (p: Vec3) => {
          const bb = w.blockAt(p)?.boxes ?? [];
          return bb.length === 1 && bb[0]![0] === 0 && bb[0]![1] === 0 && bb[0]![2] === 0 && bb[0]![3] === 1 && bb[0]![4] === 1 && bb[0]![5] === 1;
        };
        const spots: Vec3[] = [];
        // first over the bot's head: the box falls onto the bot (picked up where it stands, no walk)
        const head = { x: Math.floor(me.x), y: Math.floor(me.y + 0.01) + 2, z: Math.floor(me.z) };
        if (air(head) && air({ ...head, y: head.y + 1 })) spots.push(head);
        for (let r = 1; r <= 6; r++) {
          for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
              if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
              for (const dy of [0, -1, 1]) {
                const p = { x: Math.floor(me.x) + dx, y: Math.floor(me.y + 0.01) + dy, z: Math.floor(me.z) + dz };
                const side = [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([sx, sz]) => air({ x: p.x + sx!, y: p.y, z: p.z + sz! }));
                if (air(p) && air({ ...p, y: p.y + 1 }) && full({ ...p, y: p.y - 1 }) && side) spots.push(p);
              }
            }
          }
        }
        let spot = 0;
        for (const [i, bx] of inv.boxes.entries()) {
          const slots: [string, number][] = [];
          for (const [k, v] of Object.entries(bx.holds)) for (let n = v; n > 0; n -= 64) slots.push([k, Math.min(64, n)]);
          for (let tries = 0; tries < 4 && inventory(b).boxes.length < i + 1 && spots.length; tries++) {
            const p = spots[spot % spots.length]!;
            await dropBox(b, p, bx.name.replace(/_shulker_box$/, ''), slots);
            await pickUpBoxes(b, i + 1);
            if (inventory(b).boxes.length >= i + 1) break;
            // a box the bot could not pick up is taken away again (it must not be picked up later in another's place)
            // and the next spot gets it
            await buildCmd('kill', `@e[type=item,x=${Math.floor(me.x)},y=${Math.floor(me.y)},z=${Math.floor(me.z)},r=12]`);
            spot++;
          }
        }
        say(`back at ${since()}: ${inventory(b).boxes.length} of ${inv.boxes.length} boxes, ${inventory(b).used} slots used`);
        from = 0;
        b.settings.set('buildResume', true);
        const auto = await b.reply((x) => x.startsWith('resuming build ') || x.startsWith('build: '), from, 180_000);
        say(`after the restart (${since()}): ${auto}`);
        expect(auto).toMatch(/^resuming build file .*: \d+ of \d+ done/);
      }

      const end = await waitFor(() => b, () => ended(b) ?? b.said.find((x) => / fetch round \d+: /.test(x) && x.startsWith(`build ${label}`)), 6 * 3_600_000, 'the end line');
      const totalS = (Date.now() - t0) / 1000;
      await waitFor(() => b, () => (b.processes.userProcesses().length === 0 ? true : undefined), 600_000, 'the boxes back after the end');
      fetchedAll.push(...b.build.fetched);
      logsAll.push(...b.logs);
      say(`end: ${end} (${totalS.toFixed(0)} s from the command)`);
      say(`progress: ${trace.join(' | ')}`);
      const kinds = (re: RegExp) => fetchedAll.filter((x) => re.test(x)).length;
      const stats = { commands: fetchedAll.length, takes: kinds(/^take out of my boxes/), stows: kinds(/^stow into my boxes/), parks: kinds(/^park at home/), crafts: kinds(/^craft /), smelts: kinds(/^smelt /), brings: kinds(/^bring /), furnaces: kinds(/^furnace/), gets: kinds(/^get /) };
      const rounds = logsAll.filter((l) => / build: fetch round \d+ for .* done in /.test(l));
      say(`fetch steps ${JSON.stringify(stats)}; rounds ${rounds.length}: ${rounds.map((l) => l.replace(/^.* build: fetch round /, '')).join(' || ')}`);
      say(`commands: ${fetchedAll.join(' | ')}`);
      say(`logs: ${logsAll.filter((l) => / build: (time |fetch round \d+|job |section \d+ of \d+ \(|resum|.*left out|.*parked|.* trip )/.test(l)).slice(-80).join(' || ')}`);
      if (!end.includes(': done, ')) say(`last logs: ${logsAll.slice(-60).join(' || ')}`);
      // Track B10: where the accounted kinds are, the model against the server, the home memory against the chests
      say(`end: account ${await account(b, accountKinds, startTotals)}`);
      say(`end: the model against the server: ${viewDiff(totalsOf(inventory(b)), totalsOf(await serverInv(b))).join(', ') || 'the same totals'}`);
      {
        const strip = (k: string) => k.replace(/^minecraft:/, '');
        const chests = new Map<string, number>();
        for (const p of L.chests) {
          const r = await truthLoaded<{ counts?: Record<string, number> }>(b.truth, 'container', [p.x, p.y, p.z]);
          for (const [k, v] of Object.entries(r.counts ?? {})) chests.set(strip(k), (chests.get(strip(k)) ?? 0) + v);
        }
        say(`end: the home memory against the chests: ${viewDiff(new Map(homeCounts(b.task)), chests).join(', ') || 'the same'}`);
      }

      // every cell with the states that matter (a refused cell, a furnace the fetch set down: any block)
      await sleep(2000);
      const furnaceAt = new Set((smeltControlOf(b.task)?.furnaces() ?? []).map((p) => `${p.x - X.x},${p.y - X.y},${p.z - X.z}`));
      const want = new Map<string, (typeof s.blocks)[number]>(s.blocks.map((blk) => [`${blk.pos.x},${blk.pos.y},${blk.pos.z}`, blk] as const));
      const keysAt = new Map<string, string[]>();
      for (const r of resolved.cells) {
        const p = r.placement;
        keysAt.set(`${r.block.pos.x},${r.block.pos.y},${r.block.pos.z}`, [...new Set([...Object.keys(p.check), ...Object.keys(p.final), ...Object.keys(p.derived)])]);
        for (const e of p.extra) keysAt.set(`${r.block.pos.x + e.offset.x},${r.block.pos.y + e.offset.y},${r.block.pos.z + e.offset.z}`, Object.keys(e.check));
      }
      const entry = (x: number, y: number, z: number): string => {
        const k = `${x},${y},${z}`;
        if (refusedAt.has(k) || furnaceAt.has(k)) return '*';
        const w = want.get(k);
        if (!w) return 'air';
        const st = (keysAt.get(k) ?? []).filter((n) => w.states?.[n] !== undefined).map((n) => `${n}=${stateText(w.states![n])}`);
        return st.length ? `${w.name}[${st.join(';')}]` : w.name;
      };
      const diffWith = async (at: (x: number, y: number, z: number) => string, firsts: unknown[]): Promise<{ diffs: number; compared: number }> => {
        let diffs = 0;
        let compared = 0;
        for (let y = 0; y < size.y; y++) {
          for (let z = 0; z < size.z; ) {
            let z2 = z;
            for (;;) {
              const palette = new Set<string>();
              let runs = 0;
              for (let zz = z; zz <= z2 + 1 && zz < size.z; zz++) {
                let prev = '';
                for (let x = 0; x < size.x; x++) {
                  const e = at(x, y, zz);
                  palette.add(e);
                  if (e !== prev) runs++;
                  prev = e;
                }
              }
              if (z2 + 1 >= size.z || [...palette].join(',').length + runs * 7 > 1200) break;
              z2++;
            }
            const d = await b.truth.blocksDiff({ x: X.x, y: X.y + y, z: X.z + z }, { x: X.x + size.x - 1, y: X.y + y, z: X.z + z2 }, (p) => at(p.x - X.x, p.y - X.y, p.z - X.z));
            diffs += d.diffs;
            compared += d.count;
            if (firsts.length < 30) firsts.push(...d.first.slice(0, 30 - firsts.length));
            z = z2 + 1;
          }
        }
        return { diffs, compared };
      };
      const firsts: unknown[] = [];
      const all = await diffWith(entry, firsts);
      // dirt placed by the build turns to grass beside grass in the light (the game's random ticks, not the builder):
      // a dirt cell that is grass now matches (a second pass counts the dirt cells that are not grass)
      const isDirt = (x: number, y: number, z: number): boolean => entry(x, y, z) === 'dirt';
      let dirtCells = 0;
      for (let y = 0; y < size.y; y++) for (let z = 0; z < size.z; z++) for (let x = 0; x < size.x; x++) if (isDirt(x, y, z)) dirtCells++;
      const notGrass = dirtCells ? (await diffWith((x, y, z) => (isDirt(x, y, z) ? 'grass_block' : '*'), [])).diffs : 0;
      const grassNow = dirtCells - notGrass;
      const diffs = all.diffs - grassNow;
      const compared = all.compared;
      say(`dirt cells ${dirtCells}, grass now ${grassNow} (matched), blocksdiff ${all.diffs} before`);
      // the bot's world (what the planner reads) against the server's over the build's box; a cell it has not loaded differs
      const model = b.built.mobility!.world;
      const mfirst: unknown[] = [];
      const md = await diffWith((x, y, z) => model.blockAt({ x: X.x + x, y: X.y + y, z: X.z + z })?.name.replace(/^minecraft:/, '') ?? 'not_loaded', mfirst);
      say(`model: ${md.diffs} of ${md.compared} cells differ from the server | first ${JSON.stringify(mfirst)}`);
      if (DUMP) {
        const cells: [number, number, number, string, Record<string, unknown> | undefined][] = [];
        for (let y = -1; y < size.y + 3; y++) {
          for (let z = -6; z < size.z + 6; z++) {
            for (let x = -6; x < size.x + 6; x++) {
              const blk = model.blockAt({ x: X.x + x, y: X.y + y, z: X.z + z });
              if (blk?.name !== 'air') cells.push([x, y, z, blk?.name ?? 'not_loaded', blk?.states]);
            }
          }
        }
        writeFileSync(DUMP, JSON.stringify(cells));
      }
      const left = await leftIn(b);
      const lyingEnd = await boxItems(b);
      const invEnd = inventory(b);
      const inChest = await chestBoxes(b);
      const placedEnd = placedOf(end) ?? 0;
      const line = `${placedEnd} of ${toPlace} placed, ${totalS.toFixed(0)} s from the command (${((placedEnd * 3600) / totalS).toFixed(0)} blocks an hour), blocksdiff ${diffs} of ${compared}, boxes ${invEnd.boxes.length} carried + ${inChest} in the chests (handed over and carried ${boxesIn}, the build places ${resolved.cells.filter((r) => isShulkerBox(r.placement.item)).length}), ${left.boxes} standing in the world (the build's own included), ${lyingEnd} lying; steps ${JSON.stringify(stats)}, ${rounds.length} rounds; loose at the end ${JSON.stringify(invEnd.loose)}; home ${JSON.stringify(Object.fromEntries(homeCounts(b.task)))}`;
      say(`result: ${line} | first diffs ${JSON.stringify(firsts)}`);
      expect(end).toMatch(/: done, /);
      expect(placedEnd).toBeGreaterThan(0);
      expect(diffs).toBe(0);
      expect(lyingEnd).toBe(0);
    } finally {
      clearInterval(poll);
    }
  }, 12 * 3_600_000);
});
