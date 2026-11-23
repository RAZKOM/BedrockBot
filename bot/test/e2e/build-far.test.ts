// e2e (tag @bds), Track B6 (docs/build.md "Trips, chores and a full inventory"; ADR 0131): a fetch build that runs by
// itself, on the build-boxes harness (build-boxes.test.ts: boxes made, filled and broken by the console, the home chest
// filled through the bot). On a flat, peaceful server with the truth pack (bds-build by default). Only with BUILD_FAR=1.
//
// 1. A far site: the structure 100 blocks from home (flyMin 40), the bot there with the flight kit and an iron pickaxe;
//    the home chest holds a full white shulker box of stone bricks and loose oak logs and cobblestone; autoUnload on.
//    Passes when every trip farther than flyMin flew or the log says why not, no chore got the body from the command to
//    the end (the unload chore wants a carried full box at home), the box's stone bricks were fetched, the end is
//    `done` and every cell matches.
// 2. A nearly full inventory (item 8): 33 of 36 slots: 11 white boxes (8 full: one of stone bricks, seven of dirt; 3
//    empty), the 6 red shulker boxes the build places, 3 tools, 72 rockets, bread, 4 stacks of stone bricks, 2 of
//    cobblestone and 4 of andesite loose. The build needs crafts and smelts from the home chest (planks and stairs from
//    logs, iron bars from ingots, glass from sand). Passes when it ends `done`, every cell matches, no step said
//    `changed nothing` or `inventory is full`, and nothing the fetch brought went back into the chest.
//   BUILD_FAR=1        run it
//   BUILD_FAR_ONLY     `far` or `full`: one case only
//   BUILD_FAR_OUT      a file each case's summary line is appended to
// Env: BUILD_BDS_HOST / BUILD_BDS_PORT / BUILD_BDS_CONTAINER (build-truth.ts), BUILD_VERBOSE=1.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { homeCounts } from '../../src/chat/commands-build.ts';
import { homeControlOf } from '../../src/chat/commands-home.ts';
import { smeltControlOf } from '../../src/chat/commands-smelt.ts';
import type { Vec3 } from '../../src/connection/types.ts';
import { readStructure } from '../../src/skills/build/formats/index.ts';
import { writeSchem, type JavaCell } from '../../src/skills/build/formats/schem.ts';
import { resolveBlocks, stateText } from '../../src/skills/build/states.ts';
import { isShulkerBox, shulkerContents } from '../../src/skills/container/chest.ts';
import { buildCmd, clearArea, E2E, FEET_Y, prepareServer, privateArea, sleep, startBuildBot, teleport, truthLoaded, until, type BuildBot } from './build-truth.ts';

const F = FEET_Y;
const RUN = E2E && process.env.BUILD_FAR === '1';
const ONLY = process.env.BUILD_FAR_ONLY;
const OUT = process.env.BUILD_FAR_OUT;
const centre = (p: Vec3): Vec3 => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 });
/** A process that is a chore (or any automatic work that takes the body for itself). */
const CHORE = /chore|unload|mend|rocket|food|hunt|milk|breed|elytra|repair|sleep|room/;

/** Case 1: a hut 7 x 4 x 7: an oak plank floor, stone brick walls 3 high with a door gap. */
function hut(): { size: Vec3; cells: JavaCell[] } {
  const cells: JavaCell[] = [];
  for (let x = 0; x < 7; x++) {
    for (let z = 0; z < 7; z++) {
      cells.push({ pos: { x, y: 0, z }, java: 'oak_planks' });
      if (x === 0 || x === 6 || z === 0 || z === 6) for (let y = 1; y <= 3; y++) if (!(z === 0 && x === 3 && y <= 2)) cells.push({ pos: { x, y, z }, java: 'stone_bricks' });
    }
  }
  return { size: { x: 7, y: 4, z: 7 }, cells };
}

/** Case 2: a 9 x 2 x 5 platform of stone bricks with a row of each made kind on it and the 6 red boxes. */
function yard(): { size: Vec3; cells: JavaCell[] } {
  const cells: JavaCell[] = [];
  for (let x = 0; x < 9; x++) for (let z = 0; z < 5; z++) cells.push({ pos: { x, y: 0, z }, java: 'stone_bricks' });
  for (let x = 0; x < 6; x++) cells.push({ pos: { x: x + 1, y: 1, z: 0 }, java: 'red_shulker_box' });
  for (let x = 0; x < 8; x++) cells.push({ pos: { x, y: 1, z: 2 }, java: 'iron_bars' });
  for (let x = 0; x < 4; x++) cells.push({ pos: { x: 2 * x, y: 1, z: 4 }, java: 'oak_stairs' });
  for (let x = 0; x < 4; x++) cells.push({ pos: { x: 2 * x + 1, y: 1, z: 4 }, java: 'glass' });
  return { size: { x: 9, y: 2, z: 5 }, cells };
}

describe.skipIf(!RUN)('@bds build: a fetch build that runs by itself: a far site, the chores held, a full inventory (Track B6)', () => {
  const area = privateArea();
  const notes: string[] = [];
  const builds = RUN ? mkdtempSync(join(tmpdir(), 'bedrockbot-builds-')) : '';
  let bot: BuildBot | undefined;
  const c = area;
  const L = {
    home: { x: c.x, y: F, z: c.z + 60 },
    chest: { x: c.x - 3, y: F, z: c.z + 62 },
    /** Where the boxes for the chest are made: beyond the home's scan (16). */
    make: { x: c.x + 20, y: F, z: c.z + 70 },
    /** Case 1: the hut, 100 blocks north of home. */
    far: { x: c.x - 3, y: F, z: c.z - 40 },
    /** Case 2: the yard by home (no flight), and where its boxes are dropped (within 8 of the bot). */
    yard: { x: c.x - 4, y: F, z: c.z + 40 },
    stand: { x: c.x + 8, y: F, z: c.z + 42 },
  };
  const control: { at: number; to: string }[] = [];
  /** The ground round home and the yard, and round the far site (each cleared with the bot near it: loaded chunks). */
  const nearHome = { x: c.x, z: c.z + 50 };
  const nearFar = { x: c.x, z: c.z - 37 };
  async function clearAll(b: BuildBot): Promise<void> {
    await teleport(b, centre(L.home));
    await clearArea(b.truth, nearHome, 26, 8);
    await teleport(b, centre({ x: nearFar.x, y: F, z: nearFar.z }));
    await clearArea(b.truth, nearFar, 14, 8);
    await teleport(b, centre(L.home));
  }

  /** A `colour` shulker box holding `contents` (item, stacks), made as a block and broken by the console: it drops. */
  async function dropBox(b: BuildBot, at: Vec3, colour: string, contents: [string, number][]): Promise<void> {
    await truthLoaded(b.truth, 'set', [at.x, at.y, at.z, `${colour}_shulker_box`]);
    for (const [item, stacks] of contents) await truthLoaded(b.truth, 'chestput', [at.x, at.y, at.z, item, 64, stacks]);
    const want = contents.reduce((a, [, n]) => a + 64 * n, 0);
    await until(async () => {
      const r = await b.truth.ok<{ counts?: Record<string, number> }>('container', [at.x, at.y, at.z]);
      return Object.values(r.counts ?? {}).reduce((a, v) => a + v, 0) === want ? true : undefined;
    }, 10_000, `the ${colour} box holds ${want}`);
    await buildCmd('setblock', String(at.x), String(at.y), String(at.z), 'air', '[]', 'destroy');
  }

  /** A box made, broken and picked up by the bot, then put in the home chest by it. */
  async function boxIntoChest(b: BuildBot, colour: string, contents: [string, number][]): Promise<void> {
    const mob = b.built.mobility!;
    await teleport(b, centre({ x: L.make.x, y: F, z: L.make.z - 2 }));
    await truthLoaded(b.truth, 'set', [L.make.x, L.make.y, L.make.z, `${colour}_shulker_box`]);
    for (const [item, stacks] of contents) await truthLoaded(b.truth, 'chestput', [L.make.x, L.make.y, L.make.z, item, 64, stacks]);
    // (the box in the bot's own world first: a dig of a cell it still reads as air is `unreachable`)
    await until(() => (isShulkerBox(String(mob.world.blockAt(L.make)?.name ?? '').replace(/^minecraft:/, '')) ? true : undefined), 10_000, 'the box block seen by the bot').catch(() => undefined);
    let dg = await mob.skills.dig(L.make);
    for (let i = 0; i < 4 && !dg.ok; i++) {
      await teleport(b, centre({ x: L.make.x - 1 + i, y: F, z: L.make.z - 2 }));
      await sleep(1000);
      dg = await mob.skills.dig(L.make);
    }
    if (!dg.ok) throw new Error(`breaking the chest's box: ${dg.reason}`);
    const first = contents[0]![0];
    const slot = (): number => mob.world.inventory.slots.findIndex((x, k) => k < 36 && !!x && isShulkerBox(x.name) && (shulkerContents(mob.world.inventory.rawItem(0, k))[first] ?? 0) > 0);
    for (let i = 0; i < 3 && slot() < 0; i++) {
      await mob.skills.collect(5 + 3 * i, 100, { origin: centre(L.make), filter: (it) => isShulkerBox(it.name) });
      await until(() => (slot() >= 0 ? true : undefined), 4_000, 'the box in the inventory').catch(() => undefined);
    }
    const k = slot();
    if (k < 0) throw new Error('the box for the chest was not picked up');
    await teleport(b, centre({ x: L.chest.x, y: F, z: L.chest.z - 2 }));
    const o = await mob.skills.open(L.chest);
    if (!o.ok) throw new Error(`opening the chest: ${o.reason}`);
    const dep = await mob.skills.chest!.depositSlots(o.view, [{ slot: k, count: 1 }]);
    await mob.skills.closeContainer(o.view);
    if (dep.total !== 1) throw new Error(`storing the box: ${dep.reason}`);
  }

  /** The home chest: emptied, then `loose` (item, stacks of 64 or a count under 64) and the boxes. */
  async function fillChest(b: BuildBot, loose: [string, number][], boxes: [string, [string, number][]][]): Promise<void> {
    await truthLoaded(b.truth, 'set', [L.chest.x, L.chest.y, L.chest.z, 'chest']);
    await truthLoaded(b.truth, 'container', [L.chest.x, L.chest.y, L.chest.z, 'clear']);
    await b.truth.ok('clear', [b.name]);
    for (const [colour, contents] of boxes) await boxIntoChest(b, colour, contents);
    for (const [item, n] of loose) {
      if (n >= 64) await truthLoaded(b.truth, 'chestput', [L.chest.x, L.chest.y, L.chest.z, item, 64, Math.floor(n / 64)]);
      if (n % 64) await truthLoaded(b.truth, 'chestput', [L.chest.x, L.chest.y, L.chest.z, item, n % 64, 1]);
    }
  }

  /** Every cell of `s` at `at` compared with its states; a furnace the fetch set down counts as any block. */
  async function compare(b: BuildBot, file: string, at: Vec3): Promise<{ diffs: number; compared: number; first: unknown[] }> {
    const s = readStructure(readFileSync(join(builds, file)), 'schem', file);
    const resolved = resolveBlocks(s.blocks);
    const furnaceAt = new Set((smeltControlOf(b.task)?.furnaces() ?? []).map((p) => `${p.x - at.x},${p.y - at.y},${p.z - at.z}`));
    const want = new Map<string, (typeof s.blocks)[number]>(s.blocks.map((blk) => [`${blk.pos.x},${blk.pos.y},${blk.pos.z}`, blk] as const));
    const keysAt = new Map<string, string[]>();
    for (const r of resolved.cells) {
      const p = r.placement;
      keysAt.set(`${r.block.pos.x},${r.block.pos.y},${r.block.pos.z}`, [...new Set([...Object.keys(p.check), ...Object.keys(p.final), ...Object.keys(p.derived)])]);
    }
    const entry = (p: Vec3): string => {
      const k = `${p.x - at.x},${p.y - at.y},${p.z - at.z}`;
      const w = want.get(k);
      if (!w) return furnaceAt.has(k) ? '*' : 'air';
      const st = (keysAt.get(k) ?? []).filter((n) => w.states?.[n] !== undefined).map((n) => `${n}=${stateText(w.states![n])}`);
      return st.length ? `${w.name}[${st.join(';')}]` : w.name;
    };
    let diffs = 0;
    let compared = 0;
    const first: unknown[] = [];
    for (let y = 0; y < s.size.y; y++) {
      const d = await b.truth.blocksDiff({ x: at.x, y: at.y + y, z: at.z }, { x: at.x + s.size.x - 1, y: at.y + y, z: at.z + s.size.z - 1 }, entry);
      diffs += d.diffs;
      compared += d.count;
      first.push(...d.first.slice(0, 10));
    }
    return { diffs, compared, first };
  }

  /** Run `!build file <name> <at> fetch` to its end line; the control changes and the build log lines of the run. */
  async function runBuild(b: BuildBot, name: string, at: Vec3, timeoutMs: number): Promise<{ end: string; s: number; chores: string[]; replies: string[]; logs: string[] }> {
    const label = `file ${name} at ${at.x} ${at.y} ${at.z}`;
    const from = b.said.length;
    const logFrom = b.logs.length;
    const c0 = control.length;
    const t0 = Date.now();
    await b.command(`!build ${label.replace(' at ', ' ')} fetch`);
    // (the end line: not the fetch's own `build <label>: fetching first: ...`)
    const end = await b.reply((x) => (x.startsWith(`build ${label}:`) && !x.startsWith(`build ${label}: fetching`)) || /^build: (nothing fetched|fetch for .* stopped)/.test(x), from, timeoutMs);
    await until(() => (b.processes.userProcesses().length === 0 ? true : undefined), 120_000, 'the build over', 500);
    const s = (Date.now() - t0) / 1000;
    const chores = control.slice(c0).filter((e) => CHORE.test(e.to)).map((e) => `${((e.at - t0) / 1000).toFixed(0)} s ${e.to}`);
    return { end, s, chores, replies: b.said.slice(from), logs: b.logs.slice(logFrom) };
  }

  beforeAll(async () => {
    const h = hut();
    const y = yard();
    writeFileSync(join(builds, 'hut.schem'), writeSchem(h.size, h.cells, 3));
    writeFileSync(join(builds, 'yard.schem'), writeSchem(y.size, y.cells, 3));
    await prepareServer();
    bot = await startBuildBot('Far', builds, { home: L.home }, { settings: { autoUnload: false, autoMend: false, flyMin: 40, autoFly: true } });
    bot.processes.onControl((e) => {
      if (e.to) control.push({ at: Date.now(), to: e.to });
    });
    await teleport(bot, centre(L.home));
  }, 180_000);

  afterAll(async () => {
    if (bot) {
      await truthLoaded(bot.truth, 'container', [L.chest.x, L.chest.y, L.chest.z, 'clear']).catch(() => undefined);
      await clearAll(bot).catch(() => undefined);
      await bot.truth.ok('clear', [bot.name]).catch(() => undefined);
      await bot.stop().catch(() => undefined);
    }
    rmSync(builds, { recursive: true, force: true });
    if (OUT) appendFileSync(OUT, `  notes: ${notes.join('\n  ')}\n`);
    console.log(`[build-far e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 300_000);

  it.skipIf(ONLY === 'full')('a far site: trips home and back flown (or why not), no chore during the build, the box in the home chest fetched, done', async () => {
    const b = bot!;
    await clearAll(b);
    await b.truth.ok('clearmobs', [c.x + 0.5, F, c.z + 0.5, 100]);
    b.settings.set('autoUnload', false);
    await fillChest(b, [['oak_log', 16], ['cobblestone', 64]], [['white', [['stone_bricks', 27]]]]);
    await teleport(b, centre(L.home));
    await b.truth.ok('clear', [b.name]);
    const scan = await homeControlOf(b.task)!.logistics.scan(() => false, { force: true, retry: true });
    notes.push(`far: scan ${scan.found} found, ${scan.read.length} read; home holds ${JSON.stringify(Object.fromEntries(homeCounts(b.task)))}`);
    expect(homeCounts(b.task).get('stone_bricks')).toBe(27 * 64);
    // the flight kit and a pickaxe, at the site
    await teleport(b, centre({ x: L.far.x + 3, y: F, z: L.far.z - 4 }));
    await b.truth.ok('clear', [b.name]);
    await b.truth.ok('equip', [b.name, 'Chest', 'iron_chestplate', 1]);
    await b.truth.ok('setslot', [b.name, 0, 'firework_rocket', 64]);
    await b.truth.ok('setslot', [b.name, 9, 'elytra', 1]);
    await b.truth.ok('give', [b.name, 'iron_pickaxe', 1]);
    await sleep(1500);
    b.settings.set('autoUnload', true);

    const r = await runBuild(b, 'hut', L.far, 1_800_000);
    await until(() => (b.processes.userProcesses().length === 0 ? true : undefined), 120_000, 'the build over', 500);
    const trips = r.logs.filter((l) => l.includes(' build: trip '));
    const fetched = b.build.fetched;
    const cmp = await compare(b, 'hut.schem', L.far);
    const line = `far: ${r.end} (${r.s.toFixed(0)} s); trips ${trips.length}: ${trips.map((l) => l.replace(/^.* build: trip /, '')).join(' || ')}; chores during the build ${JSON.stringify(r.chores)}; fetch steps ${fetched.join(' | ')}; blocksdiff ${cmp.diffs} of ${cmp.compared} ${JSON.stringify(cmp.first)}`;
    notes.push(line);
    notes.push(`far replies: ${r.replies.join(' || ')}`);
    notes.push(`far logs: ${r.logs.filter((l) => / build: (fetch|trip|job|time|section|the home chests)/.test(l)).slice(-40).join(' || ')}`);
    if (OUT) appendFileSync(OUT, `${new Date().toISOString()} ${line}\n`);
    expect(r.end).toMatch(/: done, /);
    expect(cmp.diffs).toBe(0);
    expect(r.chores).toEqual([]);
    expect(fetched.some((x) => /^bring stone_bricks \d+ home$/.test(x))).toBe(true);
    // every trip farther than flyMin flew, or says why not
    expect(trips.length).toBeGreaterThanOrEqual(2);
    for (const l of trips) expect(l).toMatch(/: \d+ blocks: (flew|walked \(no flight: .+\))/);
  }, 2_400_000);

  it.skipIf(ONLY === 'far')('a nearly full inventory with boxes: the fetch steps do not undo each other; crafts and smelts from the home chest; done', async () => {
    const b = bot!;
    await clearAll(b);
    await b.truth.ok('clearmobs', [c.x + 0.5, F, c.z + 0.5, 100]);
    b.settings.set('autoUnload', false);
    await fillChest(b, [['oak_log', 16], ['iron_ingot', 95], ['sand', 64], ['coal', 32]], []);
    await teleport(b, centre(L.home));
    await b.truth.ok('clear', [b.name]);
    const scan = await homeControlOf(b.task)!.logistics.scan(() => false, { force: true, retry: true });
    notes.push(`full: scan ${scan.found} found, ${scan.read.length} read; home holds ${JSON.stringify(Object.fromEntries(homeCounts(b.task)))}`);
    // the 11 white boxes dropped by the stand (the fetch picks them up first), then the loose items
    await teleport(b, centre(L.stand));
    const boxes: [string, [string, number][]][] = [['white', [['stone_bricks', 27]]], ...Array.from({ length: 7 }, (): [string, [string, number][]] => ['white', [['dirt', 27]]]), ['white', []], ['white', []], ['white', []]];
    for (const [i, [colour, contents]] of boxes.entries()) await dropBox(b, { x: L.stand.x + 3 + (i % 4), y: F, z: L.stand.z - 1 + Math.floor(i / 4) }, colour, contents);
    // (one give a stack, one a box: the red boxes do not stack)
    for (const [item, n, per] of [['red_shulker_box', 6, 1], ['iron_pickaxe', 1, 1], ['iron_axe', 1, 1], ['iron_shovel', 1, 1], ['firework_rocket', 72, 64], ['bread', 32, 64], ['stone_bricks', 256, 64], ['cobblestone', 128, 64], ['andesite', 256, 64]] as const) {
      for (let left = n; left > 0; left -= per) await b.truth.ok('give', [b.name, item, Math.min(per, left)]);
    }
    await sleep(1500);
    const used = (): number => b.built.mobility!.world.inventory.slots.slice(0, 36).filter(Boolean).length;
    notes.push(`full: ${used()} of 36 slots before the pickup`);
    b.settings.set('autoUnload', true);

    const r = await runBuild(b, 'yard', L.yard, 2_400_000);
    await until(() => (b.processes.userProcesses().length === 0 ? true : undefined), 120_000, 'the build over', 500);
    const fetched = b.build.fetched;
    const cmp = await compare(b, 'yard.schem', L.yard);
    const bad = r.replies.filter((x) => /changed nothing|inventory is full/.test(x));
    const unloads = r.logs.filter((l) => /made room: unloaded [1-9]/.test(l));
    const line = `full: ${r.end} (${r.s.toFixed(0)} s); chores during the build ${JSON.stringify(r.chores)}; fetch steps ${fetched.join(' | ')}; room made at home ${unloads.length}: ${unloads.map((l) => l.replace(/^.*made room: /, '')).join(' || ')}; blocksdiff ${cmp.diffs} of ${cmp.compared} ${JSON.stringify(cmp.first)}`;
    notes.push(line);
    notes.push(`full replies: ${r.replies.join(' || ')}`);
    notes.push(`full logs: ${r.logs.filter((l) => / build: (fetch|trip|job|time|section|the home chests|.*shulker box)|withdraw: /.test(l)).slice(-50).join(' || ')}`);
    if (OUT) appendFileSync(OUT, `${new Date().toISOString()} ${line}\n`);
    expect(r.end).toMatch(/: done, /);
    expect(cmp.diffs).toBe(0);
    expect(bad).toEqual([]);
    expect(r.chores).toEqual([]);
    // what the fetch needs is never unloaded to make room for its next take
    for (const l of unloads) expect(l).not.toMatch(/oak_log|iron_ingot|sand|coal|oak_planks|stone_bricks|glass|iron_bars|oak_stairs/);
  }, 3_000_000);
});
