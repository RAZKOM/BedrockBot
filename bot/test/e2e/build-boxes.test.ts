// e2e (tag @bds), Track B4 (docs/build.md "Shulker boxes"; ADR 0129): a large build fed only from shulker boxes the test
// hands the bot, some of them holding raw materials the build crafts and smelts, with a `!build stop` while a box is set
// down and a `!build resume`, checked by truth:blocksdiff with states and by the box count. On a flat, peaceful server
// with the truth pack (bds-build by default; BUILD_BDS_PORT / BUILD_BDS_CONTAINER point it at another one). Long (about
// half an hour): only with BUILD_BOXES=1.
//
// The structure (castle.ts with smaller options, a Sponge .schem v3 by Track B2's writer), 41 x 14 x 33, 2 348 blocks:
//   a curtain wall 2 thick and 5 high with crenellations and a gate, no windows
//   a house 19 x 13 with an oak plank floor, oak plank walls 5 high with oak log corners and glass windows, under a
//     gable roof of oak stairs with a ridge of oak slabs (its top 12 above the ground)
//   a staircase of cobblestone stairs up the inside of the wall
// The home is 6 blocks south of the gate, outside the structure, with one chest; the bot starts east of the structure
// (out of the home's scan) with an iron pickaxe only. The materials: 8 shulker boxes dropped beside it (handed over:
// `!build ... fetch` picks them up first), and one more box in the home chest:
//   red     12 stacks of stone bricks           blue    12 stacks of stone bricks
//   green   3 stacks of oak logs                yellow  2 stacks of oak logs
//   red     2 stacks of oak planks (a second red box: two of one colour)
//   purple  3 stacks of cobblestone             white, black   empty
//   orange (in the home chest)  1 stack of sand
// So the planks, stairs and slabs are crafted from the logs, the glass smelted from the sand (`!bring sand ... home`
// brings the chest's box itself, the home's own rule, and the sand comes out of it on site), the furnace and the
// cobblestone stairs made of the cobblestone, which is also the scaffold. At a quarter, at the first moment a box stands
// in the world (a take or a stow), the build is stopped; the progress file must name the box then. With
// BUILD_BOXES_RESUME=quick the resume follows as soon as it is accepted (the box may still be out: the resumed job picks
// it up first), otherwise once the stop's own recovery is over (no box out). Then every cell is compared with its
// states; 9 boxes before and after (carried or in the chest) and none in the world.
//   BUILD_BOXES=1          run it
//   BUILD_BOXES_OUT        a file each run's summary line is appended to
//   BUILD_BOXES_RESUME     `quick`: resume at once after the stop (see above)
// Env: BUILD_BDS_HOST / BUILD_BDS_PORT / BUILD_BDS_CONTAINER (build-truth.ts), BUILD_VERBOSE=1.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { homeCounts } from '../../src/chat/commands-build.ts';
import { homeControlOf } from '../../src/chat/commands-home.ts';
import { smeltControlOf } from '../../src/chat/commands-smelt.ts';
import type { Vec3 } from '../../src/connection/types.ts';
import { readStructure } from '../../src/skills/build/formats/index.ts';
import { writeSchem } from '../../src/skills/build/formats/schem.ts';
import { resolveBlocks, stateText } from '../../src/skills/build/states.ts';
import { isShulkerBox, shulkerContents } from '../../src/skills/container/chest.ts';
import { supplyOf } from '../../src/skills/supply/supply.ts';
import { buildCmd, clearArea, E2E, FEET_Y, prepareServer, privateArea, sleep, startBuildBot, teleport, truthLoaded, until, type BuildBot, type BuildBotExtra } from './build-truth.ts';
import { castle, castleSize, type CastleOptions } from './castle.ts';

const F = FEET_Y;
const RUN = E2E && process.env.BUILD_BOXES === '1';
const OUT = process.env.BUILD_BOXES_OUT;
const QUICK = process.env.BUILD_BOXES_RESUME === 'quick';
const FORT: CastleOptions = { w: 41, d: 33, h: 14, wallH: 5, thick: 2, tower: false, wallGlass: false, stair: 'cobblestone_stairs', house: [6, 24, 6, 18], houseH: 5, houseFloor: 'oak_planks' };
const SIZE = castleSize(FORT);
const [W, H, D] = [SIZE.x, SIZE.y, SIZE.z];
const centre = (p: Vec3): Vec3 => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 });
/** The boxes dropped by the home: colour, contents (item, stacks of 64). */
const HANDED: [string, [string, number][]][] = [
  ['red', [['stone_bricks', 12]]],
  ['blue', [['stone_bricks', 12]]],
  ['green', [['oak_log', 3]]],
  ['yellow', [['oak_log', 2]]],
  ['red', [['oak_planks', 2]]],
  ['purple', [['cobblestone', 3]]],
  ['white', []],
  ['black', []],
];
const IN_CHEST: [string, [string, number][]] = ['orange', [['sand', 1]]];

const placedOf = (s: string): number | undefined => {
  const m = /(\d+) \/ (\d+) placed/.exec(s);
  return m ? Number(m[1]) : undefined;
};

describe.skipIf(!RUN)('@bds build: a large structure fed from shulker boxes, crafted and smelted from what they hold, stopped with a box out and resumed (Track B4)', () => {
  const area = privateArea();
  const notes: string[] = [];
  const builds = RUN ? mkdtempSync(join(tmpdir(), 'bedrockbot-builds-')) : '';
  const progressFile = join(builds, 'progress.json');
  let bot: BuildBot | undefined;
  const c = area;
  /** The structure's min corner: centred on the area. */
  const X = { x: c.x - 20, y: F, z: c.z - 16 };
  const L = {
    home: { x: X.x + 20, y: F, z: X.z + 39 },
    chest: { x: X.x + 16, y: F, z: X.z + 41 },
    /** Where the bot stands at the command, east of the structure, and where the boxes are dropped by it: both beyond
     * the home's scan (16), whose walk to a box block the drop puts there would pick one up. */
    start: { x: X.x + 50, y: F, z: X.z + 16 },
    /** (3 to 6 blocks east of it: out of the game's own pickup, within the 8 `!build ... fetch` looks in) */
    drop: { x: X.x + 53, y: F, z: X.z + 17 },
    /** Where the chest's box is made (and broken by the bot) before it goes into the chest: beyond the home's scan (16). */
    make: { x: X.x + 20, y: F, z: X.z + 62 },
  };
  const extra: BuildBotExtra = {
    values: { buildProgress: progressFile },
    settings: { buildColumnMax: 12, autoUnload: false, autoMend: false },
  };
  /** Shulker boxes and scaffold blocks (cobblestone) on or above the ground in and round the structure and the home. */
  const leftIn = async (b: BuildBot): Promise<{ boxes: number; scaffold: number; furnaces: number }> => {
    const out = { boxes: 0, scaffold: 0, furnaces: 0 };
    for (let y = F; y <= F + H + 4; y++) {
      const d = await b.truth.blocksDiff({ x: X.x - 4, y, z: X.z - 4 }, { x: X.x + W + 3, y, z: X.z + D + 12 }, () => '*');
      for (const [k, n] of Object.entries(d.actual)) {
        if (isShulkerBox(k.replace(/^minecraft:/, ''))) out.boxes += n;
        if (k === 'minecraft:cobblestone') out.scaffold += n; // (the structure has none: any cobblestone on the ground or above is scaffold left)
        if (k.endsWith('furnace')) out.furnaces += n;
      }
    }
    return out;
  };
  /** Shulker box items lying on the ground round it all. */
  const boxItems = async (b: BuildBot): Promise<number> => {
    const r = await b.truth.ok<{ items: { typeId: string; amount: number }[] }>('boxitems', [c.x + 0.5, F, c.z + 0.5, 80]);
    return r.items.filter((i) => isShulkerBox(i.typeId.replace(/^minecraft:/, ''))).reduce((a, i) => a + i.amount, 0);
  };
  /** The carried boxes: how many and what they hold in all. */
  const carried = async (b: BuildBot): Promise<{ n: number; holds: Record<string, number>; inv: Record<string, number> }> => {
    const g = await b.truth.ok<{ counts: Record<string, number>; boxes: { typeId: string; counts: Record<string, number> }[] }>('getinv', [b.name]);
    const holds: Record<string, number> = {};
    for (const bx of g.boxes) for (const [k, v] of Object.entries(bx.counts)) holds[k.replace(/^minecraft:/, '')] = (holds[k.replace(/^minecraft:/, '')] ?? 0) + v;
    const inv: Record<string, number> = {};
    let n = 0;
    for (const [k, v] of Object.entries(g.counts)) {
      const name = k.replace(/^minecraft:/, '');
      if (isShulkerBox(name)) n += v;
      else inv[name] = v;
    }
    return { n, holds, inv };
  };
  /** Shulker boxes in the home chest. */
  const chestBoxes = async (): Promise<number> => {
    const chest = await truthLoaded<{ counts?: Record<string, number> }>(bot!.truth, 'container', [L.chest.x, L.chest.y, L.chest.z]);
    return Object.entries(chest.counts ?? {}).filter(([k]) => isShulkerBox(k.replace(/^minecraft:/, ''))).reduce((a, [, v]) => a + v, 0);
  };
  /** A shulker box of `colour` holding `contents`, filled as a block and broken by the console (it drops with its contents). */
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

  beforeAll(async () => {
    writeFileSync(join(builds, 'fort.schem'), writeSchem(SIZE, castle(FORT), 3));
    await prepareServer();
    bot = await startBuildBot('Boxes', builds, { home: L.home }, extra);
    await teleport(bot, centre(L.home));
  }, 180_000);

  afterAll(async () => {
    if (bot) {
      await truthLoaded(bot.truth, 'container', [L.chest.x, L.chest.y, L.chest.z, 'clear']).catch(() => undefined);
      await clearArea(bot.truth, c, 34, 18).catch(() => undefined);
      await bot.truth.clearAround(centre(L.home), 64).catch(() => undefined);
      await bot.truth.ok('clear', [bot.name]).catch(() => undefined);
      await bot.stop().catch(() => undefined);
    }
    rmSync(builds, { recursive: true, force: true });
    console.log(`[build-boxes e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 300_000);

  it('builds it all from the boxes, through a stop with a box out and a resume; every cell matches; the boxes all back', async () => {
    const b = bot!;
    const mob = b.built.mobility!;
    const s = readStructure(readFileSync(join(builds, 'fort.schem')), 'schem', 'fort');
    expect(s.unknown ?? []).toEqual([]);
    const resolved = resolveBlocks(s.blocks);
    expect(resolved.refused).toEqual([]);
    const items = new Map<string, number>();
    for (const r of resolved.cells) items.set(r.placement.item, (items.get(r.placement.item) ?? 0) + 1 + r.placement.merges);
    const total = s.blocks.length;
    notes.push(`structure: ${total} blocks in ${W}x${H}x${D}, items ${JSON.stringify(Object.fromEntries(items))}`);
    expect(total).toBeGreaterThan(2000);

    // the ground, the home chest with the orange box of sand in it (made, broken and picked up by the bot, put in)
    await clearArea(b.truth, c, 34, 18);
    await b.truth.ok('clearmobs', [c.x + 0.5, F, c.z + 0.5, 80]); // stray items of earlier runs
    await truthLoaded(b.truth, 'set', [L.chest.x, L.chest.y, L.chest.z, 'chest']);
    await teleport(b, centre({ x: L.make.x, y: F, z: L.make.z - 2 }));
    await b.truth.ok('clear', [b.name]);
    await sleep(500);
    {
      const [colour, contents] = IN_CHEST;
      await truthLoaded(b.truth, 'set', [L.make.x, L.make.y, L.make.z, `${colour}_shulker_box`]);
      for (const [item, stacks] of contents) await truthLoaded(b.truth, 'chestput', [L.make.x, L.make.y, L.make.z, item, 64, stacks]);
      await sleep(300);
      let dg = await mob.skills.dig(L.make);
      for (let i = 0; i < 3 && !dg.ok; i++) {
        await sleep(1000);
        dg = await mob.skills.dig(L.make);
      }
      if (!dg.ok) throw new Error(`breaking the chest's box: ${dg.reason}`);
      const slot = (): number | undefined => mob.world.inventory.slots.findIndex((x, k) => k < 36 && !!x && isShulkerBox(x.name) && (shulkerContents(mob.world.inventory.rawItem(0, k)).sand ?? 0) > 0);
      for (let i = 0; i < 3 && (slot() ?? -1) < 0; i++) {
        await mob.skills.collect(5 + 3 * i, 100, { origin: centre(L.make), filter: (it) => isShulkerBox(it.name) });
        await until(() => ((slot() ?? -1) >= 0 ? true : undefined), 4_000, 'the box in the inventory').catch(() => undefined);
      }
      const k = slot() ?? -1;
      if (k < 0) throw new Error('the box for the chest was not picked up');
      await teleport(b, centre({ x: L.chest.x, y: F, z: L.chest.z - 2 }));
      const o = await mob.skills.open(L.chest);
      if (!o.ok) throw new Error(`opening the chest: ${o.reason}`);
      const dep = await mob.skills.chest!.depositSlots(o.view, [{ slot: k, count: 1 }]);
      await mob.skills.closeContainer(o.view);
      if (dep.total !== 1) throw new Error(`storing the box: ${dep.reason}`);
    }
    await teleport(b, centre(L.home));
    await b.truth.ok('clear', [b.name]);
    await b.truth.ok('give', [b.name, 'iron_pickaxe', 1]);
    await sleep(800);
    // the chest read again (the home's own scan read it empty when it appeared, fresh for 10 min, or probed it while the
    // test moved the bot and remembered it unreachable)
    const scan = await homeControlOf(b.task)!.logistics.scan(() => false, { force: true, retry: true });
    const home = homeCounts(b.task);
    notes.push(`scan: ${scan.found} found, ${scan.read.length} read; home holds ${JSON.stringify(Object.fromEntries(home))}`);
    expect(home.get('sand')).toBe(64);
    // the 8 boxes handed over: dropped by the bot where it stands, each on its own cell
    await teleport(b, centre(L.start));
    for (const [i, [colour, contents]] of HANDED.entries()) await dropBox(b, { x: L.drop.x + (i % 4), y: F, z: L.drop.z - Math.floor(i / 4) }, colour, contents);
    const lying = await until(async () => {
      const n = await boxItems(b);
      return n >= HANDED.length ? n : undefined;
    }, 15_000, 'the handed-over boxes lying by the bot').catch(async () => boxItems(b));
    const before = await carried(b);
    const kinds = (await b.truth.ok<{ items: { typeId: string; amount: number }[] }>('boxitems', [c.x + 0.5, F, c.z + 0.5, 80])).items.map((i) => i.typeId.replace(/^minecraft:/, ''));
    notes.push(`handed over: ${lying} boxes lying by the bot (${kinds.join(', ')}), ${before.n} carried`);
    expect(lying).toBe(HANDED.length);
    expect(before.n).toBe(0);
    let from: number;

    const at = `${X.x} ${X.y} ${X.z}`;
    const label = `file fort at ${at}`;
    const t0 = Date.now();
    const trace: string[] = [];
    let last = 0;
    const poll = setInterval(() => {
      const n = placedOf(bot?.build.status() ?? '');
      if (n !== undefined && n - last >= 250) {
        last = n;
        trace.push(`${((Date.now() - t0) / 1000).toFixed(0)} s ${n}`);
      }
    }, 2000);
    const placedNow = (): number => placedOf(b.build.status()) ?? 0;
    try {
      from = b.said.length;
      await b.command(`!build file fort ${at} fetch`);
      const picked = await b.reply((x) => x.startsWith('build: picked up ') || x.startsWith(`building ${label}`) || (x.startsWith('build: ') && !x.startsWith('build: picked')), from, 180_000);
      notes.push(`pickup: ${picked}`);
      expect(picked).toBe(`build: picked up ${HANDED.length} shulker boxes lying near me (${HANDED.length} carried now)`);
      const start = await b.reply((x) => x.startsWith(`building ${label}`) || (x.startsWith('build: ') && !x.startsWith('build: picked')), from, 300_000);
      notes.push(`start: ${start}`);
      expect(start).toMatch(/^building file fort at .*: \d+ to place in \d+ sections?; fetching in rounds as it goes$/);
      const afterPickup = await carried(b);
      // (what the boxes hold as the bot reads them: the truth pack's getinv does not see a carried box's contents)
      notes.push(`carried after the pickup: ${afterPickup.n} boxes holding ${JSON.stringify(Object.fromEntries(supplyOf(b.task)?.contents() ?? []))}, ${supplyOf(b.task)?.boxRoom() ?? 0} free box slots`);
      expect(afterPickup.n).toBe(HANDED.length);

      // a quarter, then the first moment a box stands in the world: !build stop
      await until(() => (placedNow() >= total / 4 ? true : undefined), 3_600_000, 'a quarter placed', 1000);
      const sup = supplyOf(b.task)!;
      await until(() => (sup.outstanding().standing.length > 0 ? true : undefined), 2_400_000, 'a box set down after a quarter', 20);
      const stopPlaced = placedNow();
      const stopAt = (Date.now() - t0) / 1000;
      const out = sup.outstanding();
      const stopped = b.build.stop();
      const saved = existsSync(progressFile) ? (JSON.parse(readFileSync(progressFile, 'utf8')) as { state: string; boxes?: { standing: string[]; left: string[] } }) : undefined;
      notes.push(`stop at ${stopAt.toFixed(0)} s (${stopPlaced} placed) with a box out at ${JSON.stringify(out)}: ${stopped} | saved: ${saved?.state}, boxes ${JSON.stringify(saved?.boxes)} | ${b.build.status()}`);
      expect(saved?.boxes?.standing.length ?? 0).toBeGreaterThan(0);
      let resumed: string;
      if (QUICK) {
        // the resume as soon as it is taken (the stopped job winding down first)
        const replies: string[] = [];
        await until(() => {
          replies.length = 0;
          b.build.resume(undefined, (m) => replies.push(m));
          return replies[0] && !replies[0].startsWith('build: a build is running') ? replies[0] : undefined;
        }, 120_000, 'the resume taken', 50);
        resumed = replies[0]!;
        notes.push(`quick resume ${((Date.now() - t0) / 1000 - stopAt).toFixed(1)} s after the stop: ${resumed}`);
      } else {
        await until(() => (b.processes.userProcesses().length === 0 && sup.outstanding().standing.length + sup.outstanding().left.length === 0 ? true : undefined), 300_000, 'the stop and its box recovery to end', 250);
        const back = { world: await leftIn(b), lying: await boxItems(b), carried: (await carried(b)).n, chest: await chestBoxes() };
        const file = JSON.parse(readFileSync(progressFile, 'utf8')) as { boxes?: unknown };
        notes.push(`after the stop (${((Date.now() - t0) / 1000 - stopAt).toFixed(1)} s): ${JSON.stringify(back)}; file boxes ${JSON.stringify(file.boxes)}; logs ${b.logs.filter((l) => /shulker box(es)? (left out|after the stop)/.test(l)).join(' || ')}`);
        expect(back.world.boxes + back.lying).toBe(0);
        expect(back.carried + back.chest).toBe(HANDED.length + 1);
        expect(file.boxes).toBeUndefined();
        from = b.said.length;
        await b.command('!build resume');
        resumed = await b.reply((x) => x.startsWith('resuming build ') || x.startsWith('build: '), from, 60_000);
        notes.push(`resume: ${resumed}`);
      }
      expect(resumed).toMatch(/^resuming build file fort at .*: \d+ of \d+ done/);

      const end = QUICK ? await until(() => b.said.find((x) => x.startsWith(`build ${label}:`)), 7_200_000, 'the end line', 1000) : await b.reply((x) => x.startsWith(`build ${label}:`), from, 7_200_000);
      const totalS = (Date.now() - t0) / 1000;
      await until(() => (b.processes.userProcesses().length === 0 ? true : undefined), 300_000, 'the boxes back after the end', 500);
      notes.push(`end: ${end} (${totalS.toFixed(0)} s from the command)`);
      notes.push(`progress: ${trace.join(' | ')}`);
      const fetched = b.build.fetched;
      const kinds = (re: RegExp) => fetched.filter((x) => re.test(x)).length;
      const stats = { commands: fetched.length, takes: kinds(/^take out of my boxes/), stows: kinds(/^stow into my boxes/), crafts: kinds(/^craft /), smelts: kinds(/^smelt /), brings: kinds(/^bring /), furnaces: kinds(/^furnace/) };
      notes.push(`fetch steps ${JSON.stringify(stats)}: ${fetched.join(' | ')}`);
      const loads = b.logs.filter((l) => / out of \d+ shulker box(es)? for the next /.test(l));
      const makeRoom = b.logs.filter((l) => l.includes(' into my shulker boxes to make room'));
      notes.push(`runner loads: ${loads.length}, stows to make room: ${makeRoom.length}; ${loads.slice(0, 6).join(' || ')}`);
      notes.push(`logs: ${b.logs.filter((l) => / build: (time |fetch round \d+ .* done|job |section \d+ of \d+ \(|resum|.*shulker box|.*left out)/.test(l)).slice(-60).join(' || ')}`);

      // every cell with the states that matter (a furnace the fetch set down off the build: any block there)
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
        const w = want.get(k);
        if (!w) return furnaceAt.has(k) ? '*' : 'air';
        const st = (keysAt.get(k) ?? []).filter((n) => w.states?.[n] !== undefined).map((n) => `${n}=${stateText(w.states![n])}`);
        return st.length ? `${w.name}[${st.join(';')}]` : w.name;
      };
      let diffs = 0;
      let compared = 0;
      const firsts: unknown[] = [];
      for (let y = 0; y < H; y++) {
        for (let z = 0; z < D; ) {
          let z2 = z;
          for (;;) {
            const palette = new Set<string>();
            let runs = 0;
            for (let zz = z; zz <= z2 + 1 && zz < D; zz++) {
              let prev = '';
              for (let x = 0; x < W; x++) {
                const e = entry(x, y, zz);
                palette.add(e);
                if (e !== prev) runs++;
                prev = e;
              }
            }
            if (z2 + 1 >= D || [...palette].join(',').length + runs * 7 > 1200) break;
            z2++;
          }
          const d = await b.truth.blocksDiff({ x: X.x, y: X.y + y, z: X.z + z }, { x: X.x + W - 1, y: X.y + y, z: X.z + z2 }, (p) => entry(p.x - X.x, p.y - X.y, p.z - X.z));
          diffs += d.diffs;
          compared += d.count;
          if (firsts.length < 20) firsts.push(...d.first.slice(0, 20 - firsts.length));
          z = z2 + 1;
        }
      }
      const left = await leftIn(b);
      const lyingEnd = await boxItems(b);
      const end2 = await carried(b);
      const inChest = await chestBoxes();
      const placedEnd = placedOf(end) ?? 0;
      const line = `${total} blocks, ${totalS.toFixed(0)} s from the command (${((totalS * 1000) / total).toFixed(0)} s per 1000 blocks), blocksdiff ${diffs} of ${compared}, boxes ${end2.n} carried + ${inChest} in the chest (before ${HANDED.length} + 1), ${left.boxes} standing, ${lyingEnd} lying, scaffold blocks left ${left.scaffold}, furnaces ${left.furnaces}, ${QUICK ? 'quick resume' : 'resume after the recovery'}; steps ${JSON.stringify(stats)}, runner loads ${loads.length}, stows to make room ${makeRoom.length}; the boxes hold ${JSON.stringify(Object.fromEntries(supplyOf(b.task)?.contents() ?? []))}, loose ${JSON.stringify(end2.inv)}`;
      notes.push(`result: ${line} | ${JSON.stringify(firsts)}`);
      if (OUT) appendFileSync(OUT, `${new Date().toISOString()} ${line} | stop: ${stopped} | resume: ${resumed} | ${end} | ${trace.join(' | ')}\n`);
      expect(end).toMatch(/: done, /);
      expect(placedEnd).toBeGreaterThan(0);
      expect(diffs).toBe(0);
      expect(left.scaffold).toBe(0);
      expect(left.boxes).toBe(0);
      expect(lyingEnd).toBe(0);
      // the box count as before: `!bring sand ... home` brings the chest's box itself (the home's own rule), so it may be carried
      expect(end2.n + inChest).toBe(HANDED.length + 1);
    } finally {
      clearInterval(poll);
    }
  }, 10_800_000);
});
