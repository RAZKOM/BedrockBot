// e2e (tag @bds), wave 11 Track AV (docs/home.md "Boxing at the chests", decisions/0044-boxing.md): boxing a
// full chest's stacks into spare shulker boxes at `!unload`, and the owner's named (`bot_loot`) boxes. On
// bds-home (flat, peaceful, truth pack with truth:chestput / namebox / nameinv / boxdrop), one afk-task bot
// in its own random area, `throwawayMin 0` (no reserve: "the bot carries 0 cobblestone"), autoUnload off.
//   (a) a chest full of cobblestone (27 stacks) + a chest of 3 empty boxes, the bot carries 10 stacks:
//       `!unload` boxes 27 stacks at the cobblestone chest (box from the box chest), then unloads; the
//       chest holds 1 full box + 10 stacks, the bot no cobblestone; memory, `!stock` and truth agree
//   (b) the bot carries 2 bot_loot boxes (one holding 27 stacks of sand, one empty) and 20 stacks of sand,
//       the sand chest holds 17 stacks (10 free), 3 spares in a chest: after `!unload` both bot_loot boxes
//       are carried and empty, all 64 stacks of sand are in the sand chest (loose and boxed), the reply
//       says `kept 2 bot_loot boxes`
//   (c) `!drop all` keeps the bot_loot boxes (an unnamed box and the cobblestone go)
//   (d) the stash step (inventory full) fills the bot_loot box, not the unnamed spare in a lower hotbar slot
//   (e) a full chest and no spare box anywhere: the reply says what is left and why
//   (f) packing (the owner: "will it put them back down and prioritize the sand?"): a bot_loot box holding
//       20 stacks of rotten flesh and 7 of sand, the inventory full of sand (one slot free): the stash step (job: sand)
//       re-packs it: the box holds 27 stacks of sand, the rotten flesh is on the floor
//   (g) fill steps (the owner: "if it has 5 bot_loot boxes half full of deepslate ... fill up one or more full shulkers"):
//       4 bot_loot boxes of 10 stacks of cobbled deepslate and 2 loose stacks, a chest with 5 stacks of it and plenty of
//       room, a chest of 3 empty boxes: `!unload` fills one spare with 27 x 64 and stores it in the deepslate chest, the
//       rest goes there loose; the spare chest holds 2 boxes, the bot its 4 bot_loot boxes (empty), nothing on the ground
//   (h) tidy steps (the owner: "if it sees a chest that has enough of the same item to fill a shulker, do it"): a double
//       chest (placed by the bot) holding 30 loose stacks of cobblestone, a chest of 3 empty boxes, the bot carrying none:
//       `!unload` leaves 1 full box (27 x 64) + 3 stacks in the double chest, the spare chest one box fewer
// Env: HOME_BDS_HOST / HOME_BDS_PORT / HOME_BDS_CONTAINER (home-truth.ts), HOME_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { isShulkerBox, shulkerContents } from '../../src/skills/container/chest.ts';
import { stashFor, stepLine } from '../../src/skills/container/stash.ts';
import { carriedBoxes } from '../../src/skills/home/boxing.ts';
import { clearAreaHome, E2E, FEET_Y, prepareServer, privateArea, sleep, startHomeBot, teleport, truthLoaded, until, type HomeBot } from './home-truth.ts';

const F = FEET_Y;
const at = (p: Vec3) => `${p.x} ${p.y} ${p.z}`;

describe.skipIf(!E2E)('@bds home: boxing at the chests and bot_loot boxes (Track AV)', () => {
  const area = privateArea();
  const c = { x: area.x, z: area.z };
  const home: Vec3 = { x: c.x, y: F, z: c.z };
  const notes: string[] = [];
  const placed: Vec3[] = [];
  let bot: HomeBot | undefined;

  const chestAt = async (p: Vec3) => {
    await truthLoaded(bot!.truth, 'set', [p.x, p.y, p.z, 'chest']);
    placed.push(p);
  };
  const removeChest = async (p: Vec3) => {
    await truthLoaded(bot!.truth, 'container', [p.x, p.y, p.z, 'clear']).catch(() => undefined);
    await truthLoaded(bot!.truth, 'set', [p.x, p.y, p.z, 'air']).catch(() => undefined);
  };
  const scan = async () => {
    const b = bot!;
    await teleport(b, { x: home.x + 0.5, y: F, z: home.z + 0.5 });
    const from = b.said.length;
    await b.command('!chests scan');
    return b.reply((s) => /^chests: \d+ within /.test(s), from, 120_000);
  };
  const ask = async (cmd: string, match: (s: string) => boolean, timeoutMs = 10_000) => {
    const b = bot!;
    const from = b.said.length;
    await b.command(cmd);
    return b.reply(match, from, timeoutMs);
  };
  /** The boxes in a container with their contents, read by the bot from the chest window (the server's NBT). */
  const boxesIn = async (p: Vec3): Promise<Record<string, number>[]> => {
    const b = bot!;
    const mob = b.built.mobility!;
    await teleport(b, { x: home.x + 0.5, y: F, z: home.z + 0.5 });
    let o = await mob.skills.open(p);
    if (!o.ok) o = await mob.skills.open(p); // a container closed a moment ago sometimes misses one click
    if (!o.ok) throw new Error(`open ${at(p)}: ${o.reason}`);
    const out: Record<string, number>[] = [];
    o.view.slots.forEach((s, i) => {
      if (s && isShulkerBox(s.name)) out.push(shulkerContents(mob.world.inventory.rawItem(o.view.id, i)));
    });
    await mob.skills.closeContainer(o.view);
    return out;
  };
  const unload = async (): Promise<{ end: string; ms: number }> => {
    const b = bot!;
    await teleport(b, { x: home.x + 0.5, y: F, z: home.z + 0.5 });
    await sleep(300);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!unload');
    const first = await b.reply((s) => s.startsWith('unloading ') || s.startsWith('unload: '), from);
    const end = first.startsWith('unload: ') ? first : await b.reply((s) => s.startsWith('unloaded: ') || s.startsWith('unload: '), from, 300_000);
    const ms = Date.now() - t0;
    const rep = b.home.logistics.lastUnload!;
    notes.push(`!unload: ${first} -> ${end} (${(ms / 1000).toFixed(1)} s; ${rep.requests} requests, ${rep.shared} shared, ${rep.chests} chest trips; boxed ${JSON.stringify(rep.boxed ?? [])})`);
    if (VERBOSE_LOG) notes.push(`log:\n    ${b.logs.filter((x) => !x.includes(':nav info')).slice(-60).join('\n    ')}`);
    return { end, ms };
  };
  const VERBOSE_LOG = process.env.HOME_VERBOSE === '1';
  /** A clean home: every chest of the earlier cases gone, no item or box left around, the chore idle. */
  const fresh = async () => {
    const b = bot!;
    for (const p of placed.splice(0)) await removeChest(p);
    await clearAreaHome(b.truth, c, 14, 6);
    await b.truth.clearAround({ x: c.x + 0.5, y: F, z: c.z + 0.5 }, 24);
    await teleport(b, { x: home.x + 0.5, y: F, z: home.z + 0.5 });
    await sleep(2000); // the chore's first scan of the session starts when the bot stands at home
    await until(() => (b.home.logistics.busy ? undefined : true), 60_000, 'the chore idle');
  };
  const named = () => carriedBoxes(bot!.built.mobility!.world.inventory, 'bot_loot');

  beforeAll(async () => {
    await prepareServer();
    const b = await startHomeBot('Boxing');
    bot = b;
    b.settings.set('autoUnload', 'off');
    b.settings.set('throwawayMin', '0');
    await teleport(b, { x: home.x + 0.5, y: F, z: home.z + 0.5 });
    await clearAreaHome(b.truth, c, 14, 6);
    b.task.home!.set(home);
  }, 240_000);

  afterAll(async () => {
    if (bot) {
      for (const p of placed) await removeChest(p);
      await clearAreaHome(bot.truth, c, 14, 6).catch(() => undefined);
      await bot.truth.clearAround({ x: c.x + 0.5, y: F, z: c.z + 0.5 }, 24).catch(() => undefined);
      await bot.truth.ok('clear', [bot.name]).catch(() => undefined);
      await bot.stop();
    }
    console.log(`[home-boxing e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 120_000);

  it('(a) a chest full of cobblestone: 27 stacks boxed into a spare from the box chest, the box stored there, then the 10 stacks', async () => {
    const b = bot!;
    await fresh();
    const mob = b.built.mobility!;
    const A = { x: c.x + 2, y: F, z: c.z - 1 };
    const B = { x: c.x - 2, y: F, z: c.z + 1 };
    await chestAt(A);
    await chestAt(B);
    await b.truth.chestPut(A, 'cobblestone', 64, 'all');
    await b.truth.chestPut(B, 'undyed_shulker_box', 1, 3);
    notes.push(`(a) scan: ${await scan()}`);
    expect(await ask('!boxes', (s) => s.startsWith('boxes: '))).toBe(`boxes: 3 spare (3 in chest ${at(B)}); no bot_loot box carried`);
    await b.truth.ok('clear', [b.name]);
    await b.truth.stuff(b.name, 'cobblestone', 10);
    await until(() => (mob.world.inventory.count('cobblestone') === 640 ? true : undefined), 10_000, '10 stacks in the model');
    const { end } = await unload();
    expect(end).toContain(`boxed 27 stacks of cobblestone from chest ${at(A)} into a shulker (box from chest ${at(B)})`);
    const rep = b.home.logistics.lastUnload!;
    expect(rep.left).toEqual([]);
    notes.push(`(a) box step: ${rep.boxed![0]!.ms} ms, ${rep.boxed![0]!.rounds} rounds, ${rep.boxed![0]!.took} stacks out of the chest`);
    // truth: the chest holds 1 box + 10 stacks; the bot no cobblestone
    const a = await b.truth.box(A);
    notes.push(`(a) truth chest A: ${JSON.stringify(a.counts)} free ${a.free}; inventory ${JSON.stringify(await b.truth.counts(b.name))}`);
    expect(a.counts).toEqual({ cobblestone: 640, undyed_shulker_box: 1 });
    expect((await b.truth.counts(b.name)).cobblestone).toBeUndefined();
    expect(await boxesIn(A)).toEqual([{ cobblestone: 1728 }]);
    expect((await b.truth.box(B)).counts).toEqual({ undyed_shulker_box: 2 });
    // memory and !stock agree
    expect(b.home.memory().get(A)).toMatchObject({ contents: { cobblestone: 640, undyed_shulker_box: 1 }, inBoxes: { cobblestone: 1728 }, boxes: { empty: 0, full: 1 }, free: 16 });
    expect(await ask('!stock cobblestone', (s) => s.startsWith('cobblestone: '))).toBe(`cobblestone: 2368 in chest ${at(A)} (1728 in boxes)`);
    // no box or drop left in the world
    expect((await b.truth.boxItems({ x: c.x + 0.5, y: F, z: c.z + 0.5 }, 12)).filter((i) => i.typeId.endsWith('shulker_box'))).toHaveLength(0);
    await removeChest(A);
    await removeChest(B);
  }, 400_000);

  it('(b) bot_loot boxes: the full one is emptied, its sand and the loose sand go into the sand chest (boxed as needed), both boxes kept, empty', async () => {
    const b = bot!;
    await fresh();
    const mob = b.built.mobility!;
    const inv = mob.world.inventory;
    const S = { x: c.x + 2, y: F, z: c.z + 1 };
    const B = { x: c.x - 2, y: F, z: c.z - 1 };
    await teleport(b, { x: home.x + 0.5, y: F, z: home.z + 0.5 });
    await b.truth.ok('clear', [b.name]);
    // a box holding 27 stacks of sand (dropped by truth, picked up), an empty one; both named bot_loot
    // (before the chests appear: the chore reads a new container at once and its walk cancels a collect)
    await until(() => (b.home.logistics.busy ? undefined : true), 60_000, 'the chore idle');
    const drop = { x: c.x, y: F, z: c.z + 3 };
    await b.truth.ok('boxdrop', [drop.x, drop.y, drop.z, 'sand', 64, 27]);
    await sleep(500);
    for (let i = 0; i < 3 && !carriedBoxes(inv).some((x) => x.used === 27); i++) {
      await mob.skills.collect(5, 160, { origin: { x: drop.x + 0.5, y: F, z: drop.z + 0.5 }, filter: (it) => isShulkerBox(it.name) });
    }
    await until(() => (carriedBoxes(inv).some((x) => x.used === 27) ? true : undefined), 10_000, 'the full box in the inventory');
    await chestAt(S);
    await chestAt(B);
    await b.truth.chestPut(S, 'sand', 64, 17);
    await b.truth.chestPut(B, 'undyed_shulker_box', 1, 3);
    await b.truth.ok('give', [b.name, 'undyed_shulker_box', 1]);
    await until(() => (carriedBoxes(inv).length === 2 ? true : undefined), 10_000, '2 boxes');
    await b.truth.nameInv(b.name, 'boxes', 'bot_loot');
    await until(() => (named().filter((x) => x.named).length === 2 ? true : undefined), 10_000, 'both boxes named in the model');
    await b.truth.stuff(b.name, 'sand', 20);
    await until(() => (inv.count('sand') === 1280 ? true : undefined), 10_000, '20 stacks of sand');
    notes.push(`(b) scan: ${await scan()}`);
    const boxes = await ask('!boxes', (s) => s.startsWith('boxes: '));
    notes.push(`(b) ${boxes}`);
    expect(boxes).toBe(`boxes: 3 spare (3 in chest ${at(B)}); carrying 2 bot_loot boxes (1 empty, 1 holding 1728 sand)`);
    const { end } = await unload();
    expect(end).toContain('kept 2 bot_loot boxes');
    const rep = b.home.logistics.lastUnload!;
    expect(rep.left).toEqual([]);
    expect(rep.emptiedNamed).toBe(1);
    // both bot_loot boxes carried and empty (the model's NBT), no sand
    const after = named();
    notes.push(`(b) carried boxes: ${JSON.stringify(after)}`);
    expect(after.filter((x) => x.named)).toHaveLength(2);
    expect(after.every((x) => x.used === 0)).toBe(true);
    const counts = await b.truth.counts(b.name);
    expect(counts).toEqual({ undyed_shulker_box: 2 });
    // all 64 stacks of sand in the sand chest: loose + boxed
    const s = await b.truth.box(S);
    const inBoxes = await boxesIn(S);
    notes.push(`(b) truth sand chest: ${JSON.stringify(s.counts)} free ${s.free}; boxes ${JSON.stringify(inBoxes)}`);
    expect((s.counts.sand ?? 0) + inBoxes.reduce((a, x) => a + (x.sand ?? 0), 0)).toBe(64 * 64);
    expect(inBoxes.length).toBe(rep.boxed!.length + (rep.filled?.length ?? 0)); // the box steps' boxes and the fill step's (47 stacks carried: one full box's worth)
    expect(b.home.memory().get(S)!.inBoxes?.sand).toBe(inBoxes.reduce((a, x) => a + (x.sand ?? 0), 0));
    await removeChest(S);
    await removeChest(B);
  }, 500_000);

  it('(c) !drop all keeps the bot_loot boxes', async () => {
    const b = bot!;
    await fresh();
    const inv = b.built.mobility!.world.inventory;
    await b.truth.ok('clear', [b.name]);
    await b.truth.ok('give', [b.name, 'undyed_shulker_box', 2]);
    await until(() => (inv.count('undyed_shulker_box') === 2 ? true : undefined), 10_000, '2 boxes');
    await b.truth.nameInv(b.name, 'boxes', 'bot_loot');
    await until(() => (named().filter((x) => x.named).length === 2 ? true : undefined), 10_000, 'both named');
    await b.truth.ok('give', [b.name, 'undyed_shulker_box', 1]); // an unnamed box: dropped
    await b.truth.stuff(b.name, 'cobblestone', 3);
    await until(() => (inv.count('cobblestone') === 192 && inv.count('undyed_shulker_box') === 3 ? true : undefined), 10_000, 'the inventory');
    const r = await ask('!drop all', (s) => s.startsWith('dropped ') || s.startsWith('drop'), 30_000);
    notes.push(`(c) !drop all: ${r}`);
    await b.truth.clearAround({ x: c.x + 0.5, y: F, z: c.z + 0.5 }, 24);
    expect(r).toContain('kept 2 bot_loot boxes');
    expect(r).toMatch(/^dropped 193 items of 2 kinds/);
    expect((await b.truth.counts(b.name)).undyed_shulker_box).toBe(2);
    expect(named().filter((x) => x.named)).toHaveLength(2);
    // the owner's explicit drops: one slot (the panel's Drop), then `!drop bot_loot` (2026-10-31: no way to drop them)
    const slot = named().find((x) => x.named)!.slot;
    const r1 = await ask(`!drop slot ${slot}`, (s) => s.startsWith('dropped ') || s.startsWith('drop'), 30_000);
    notes.push(`(c) !drop slot ${slot}: ${r1}`);
    expect(r1).toBe('dropped 1 undyed_shulker_box');
    expect(b.built.mobility!.loop.command.pitch).toBeLessThan(10); // faced the asker, aimed up: never straight down
    await until(() => (inv.count('undyed_shulker_box') === 1 ? true : undefined), 10_000, 'one box left');
    const r2 = await ask('!drop bot_loot', (s) => s.startsWith('dropped ') || s.startsWith('drop'), 30_000);
    notes.push(`(c) !drop bot_loot: ${r2}`);
    await b.truth.clearAround({ x: c.x + 0.5, y: F, z: c.z + 0.5 }, 24);
    expect(r2).toBe('dropped 1 undyed_shulker_box');
    expect((await b.truth.counts(b.name)).undyed_shulker_box ?? 0).toBe(0);
  }, 120_000);

  it('(d) the stash step fills the bot_loot box before an unnamed spare', async () => {
    const b = bot!;
    await fresh();
    const inv = b.built.mobility!.world.inventory;
    await teleport(b, { x: home.x + 0.5, y: F, z: home.z + 0.5 });
    await b.truth.ok('clear', [b.name]);
    await b.truth.ok('give', [b.name, 'iron_pickaxe', 1]); // slot 0
    await b.truth.ok('give', [b.name, 'undyed_shulker_box', 1]); // slot 1: the unnamed spare (the lower slot)
    await b.truth.ok('give', [b.name, 'undyed_shulker_box', 1]); // slot 2: named below
    await until(() => (inv.count('undyed_shulker_box') === 2 ? true : undefined), 10_000, '2 boxes');
    await b.truth.nameInv(b.name, 2, 'bot_loot');
    await until(() => (named().some((x) => x.named) ? true : undefined), 10_000, 'the named box in the model');
    await b.truth.stuff(b.name, 'cobblestone', 33);
    await until(() => (inv.freeSlots().length === 0 ? true : undefined), 10_000, 'a full inventory');
    const stash = stashFor(b.processes);
    expect(stash).toBeDefined();
    const t0 = Date.now();
    expect(await stash!.ifFull({ label: 'boxing-e2e' })).toBe(true);
    const a = stash!.attempts.at(-1)!;
    notes.push(`(d) stash: ${JSON.stringify(a.steps.map((s) => ({ kind: s.kind, moved: s.moved, ok: s.ok, reason: s.reason })))} in ${Date.now() - t0} ms`);
    await until(() => (carriedBoxes(inv).length === 2 ? true : undefined), 10_000, 'both boxes carried');
    const boxes = named();
    notes.push(`(d) boxes: ${JSON.stringify(boxes)}`);
    expect(boxes.find((x) => x.named)!.contents).toEqual({ cobblestone: 1728 });
    expect(boxes.find((x) => !x.named)!.used).toBe(0);
  }, 180_000);

  it('(e) a full chest and no spare box anywhere: the reply says what is left', async () => {
    const b = bot!;
    await fresh();
    const mob = b.built.mobility!;
    const E = { x: c.x + 2, y: F, z: c.z };
    await chestAt(E);
    await b.truth.chestPut(E, 'cobblestone', 64, 'all');
    await b.truth.ok('clear', [b.name]);
    await b.truth.stuff(b.name, 'cobblestone', 3);
    await until(() => (mob.world.inventory.count('cobblestone') === 192 ? true : undefined), 10_000, '3 stacks');
    notes.push(`(e) scan: ${await scan()}`);
    const { end } = await unload();
    expect(end).toBe(`unload: nothing moved; left 192 cobblestone (no room; chest ${at(E)} is full and no spare shulker box is known)`);
    expect((await b.truth.counts(b.name)).cobblestone).toBe(192);
    await removeChest(E);
  }, 300_000);

  it('(f) the stash step re-packs a bot_loot box holding junk: 27 stacks of sand inside, the junk on the floor', async () => {
    const b = bot!;
    await fresh();
    const mob = b.built.mobility!;
    const inv = mob.world.inventory;
    await b.truth.ok('clear', [b.name]);
    const drop = { x: c.x, y: F, z: c.z + 3 };
    await b.truth.ok('boxmix', [drop.x, drop.y, drop.z, 'rotten_flesh', 64, 20, 'sand', 64, 7]);
    await sleep(500);
    for (let i = 0; i < 3 && !carriedBoxes(inv).some((x) => x.used === 27); i++) {
      await mob.skills.collect(5, 160, { origin: { x: drop.x + 0.5, y: F, z: drop.z + 0.5 }, filter: (it) => isShulkerBox(it.name) });
    }
    await until(() => (carriedBoxes(inv).some((x) => x.used === 27) ? true : undefined), 10_000, 'the mixed box in the inventory');
    await b.truth.nameInv(b.name, 'boxes', 'bot_loot');
    await until(() => (named().some((x) => x.named) ? true : undefined), 10_000, 'the box named');
    await teleport(b, { x: home.x + 0.5, y: F, z: home.z + 0.5 });
    await b.truth.stuff(b.name, 'sand', 34); // 1 slot free: the stash step starts below 2 (MIN_FREE_SLOTS)
    await until(() => (inv.freeSlots().length === 1 ? true : undefined), 10_000, 'a full inventory');
    const t0 = Date.now();
    const said = b.said.length;
    expect(await stashFor(b.processes)!.ifFull({ label: 'boxing-e2e', wanted: (n) => n === 'sand' })).toBe(true);
    const ms = Date.now() - t0;
    const a = stashFor(b.processes)!.attempts.at(-1)!;
    const step = a.steps.find((x) => x.kind === 'shulker');
    notes.push(`(f) stash: ${JSON.stringify(a.steps.map((x) => ({ kind: x.kind, moved: x.moved, ok: x.ok, reason: x.reason, repacked: x.repacked, requests: x.requests })))} in ${ms} ms; said ${JSON.stringify(b.said.slice(said))}`);
    const floor = await b.truth.boxItems({ x: c.x + 0.5, y: F, z: c.z + 0.5 }, 12);
    const flesh = floor.filter((x) => x.typeId.endsWith('rotten_flesh')).reduce((n, x) => n + x.amount, 0);
    notes.push(`(f) floor: ${flesh} rotten flesh; boxes ${JSON.stringify(named())}`);
    expect(step?.repacked).toBeDefined();
    expect(named().find((x) => x.named)!.contents).toEqual({ sand: 1728 });
    expect(step!.repacked!.dropped).toBe(1280);
    expect(stepLine(step!)).toContain('re-packed 1 box: dropped 1280 junk, boxed 20 stacks of sand');
    // on the floor (the bot may walk over a few stacks and pick them up again: open point in docs/home.md)
    expect(flesh).toBeGreaterThanOrEqual(1280 - ((await b.truth.counts(b.name)).rotten_flesh ?? 0));
    expect(flesh).toBeGreaterThan(0);
    await b.truth.clearAround({ x: c.x + 0.5, y: F, z: c.z + 0.5 }, 24);
  }, 180_000);

  it('(g) 4 bot_loot boxes of deepslate and 2 loose stacks: one full box filled from a spare and stored in the deepslate chest, the rest loose', async () => {
    const b = bot!;
    await fresh();
    const mob = b.built.mobility!;
    const inv = mob.world.inventory;
    const deep = 'cobbled_deepslate';
    const D = { x: c.x + 2, y: F, z: c.z + 1 };
    const B = { x: c.x - 2, y: F, z: c.z - 1 };
    await teleport(b, { x: home.x + 0.5, y: F, z: home.z + 0.5 });
    await b.truth.ok('clear', [b.name]);
    // 4 boxes of 10 stacks each (dropped by truth, picked up one by one, before the chests appear), then named bot_loot
    await until(() => (b.home.logistics.busy ? undefined : true), 60_000, 'the chore idle');
    const drop = { x: c.x, y: F, z: c.z + 3 };
    for (let k = 1; k <= 4; k++) {
      await b.truth.ok('boxdrop', [drop.x, drop.y, drop.z, deep, 64, 10]);
      await sleep(500);
      for (let i = 0; i < 3 && carriedBoxes(inv).length < k; i++) {
        await mob.skills.collect(5, 160, { origin: { x: drop.x + 0.5, y: F, z: drop.z + 0.5 }, filter: (it) => isShulkerBox(it.name) });
      }
      await until(() => (carriedBoxes(inv).length === k ? true : undefined), 10_000, `box ${k} in the inventory`);
    }
    await b.truth.nameInv(b.name, 'boxes', 'bot_loot');
    await until(() => (named().filter((x) => x.named).length === 4 ? true : undefined), 10_000, 'the 4 boxes named in the model');
    await b.truth.stuff(b.name, deep, 2);
    await until(() => (inv.count(deep) === 128 ? true : undefined), 10_000, '2 loose stacks');
    await chestAt(D);
    await chestAt(B);
    await b.truth.chestPut(D, deep, 64, 5);
    await b.truth.chestPut(B, 'undyed_shulker_box', 1, 3);
    notes.push(`(g) scan: ${await scan()}`);
    const boxes = await ask('!boxes', (s) => s.startsWith('boxes: '));
    notes.push(`(g) ${boxes}`);
    expect(boxes).toBe(`boxes: 3 spare (3 in chest ${at(B)}); carrying 4 bot_loot boxes (${Array.from({ length: 4 }, () => `1 holding 640 ${deep}`).join(', ')})`);
    const { end, ms } = await unload();
    expect(end).toContain(`boxed 1 full box of ${deep} into chest ${at(D)}`);
    expect(end).toContain('kept 4 bot_loot boxes');
    const rep = b.home.logistics.lastUnload!;
    expect(rep.left).toEqual([]);
    expect(rep.filled).toHaveLength(1);
    notes.push(`(g) fill step: ${JSON.stringify(rep.filled)}; the whole !unload ${(ms / 1000).toFixed(1)} s`);
    // truth: the deepslate chest holds 1 box of 27 x 64 and the rest loose (5 + 40 + 2 - 27 = 20 stacks)
    const d = await b.truth.box(D);
    const inD = await boxesIn(D);
    notes.push(`(g) truth chest D: ${JSON.stringify(d.counts)} free ${d.free}; boxes ${JSON.stringify(inD)}`);
    expect(inD).toEqual([{ [deep]: 1728 }]);
    expect(d.counts).toEqual({ [deep]: 5 * 64 + 4 * 640 + 128 - 1728, undyed_shulker_box: 1 });
    expect((await b.truth.box(B)).counts).toEqual({ undyed_shulker_box: 2 });
    // the bot: its 4 bot_loot boxes, empty, and nothing else
    const after = named();
    expect(after.filter((x) => x.named)).toHaveLength(4);
    expect(after.every((x) => x.used === 0)).toBe(true);
    expect(await b.truth.counts(b.name)).toEqual({ undyed_shulker_box: 4 });
    // memory agrees; no box or drop left in the world
    expect(b.home.memory().get(D)).toMatchObject({ inBoxes: { [deep]: 1728 }, boxes: { empty: 0, full: 1 } });
    expect((await b.truth.boxItems({ x: c.x + 0.5, y: F, z: c.z + 0.5 }, 12)).filter((i) => i.typeId.endsWith('shulker_box'))).toHaveLength(0);
    await removeChest(D);
    await removeChest(B);
  }, 500_000);

  it("(h) a home chest's own 30 stacks of cobblestone: 27 of them boxed there at !unload, 3 stay loose", async () => {
    const b = bot!;
    await fresh();
    const mob = b.built.mobility!;
    const T = { x: c.x + 3, y: F, z: c.z - 1 };
    const T2 = { x: c.x + 3, y: F, z: c.z };
    const B = { x: c.x - 2, y: F, z: c.z + 2 };
    await teleport(b, { x: home.x + 0.5, y: F, z: home.z + 0.5 });
    await b.truth.ok('clear', [b.name]);
    // the double chest: two chests placed by the bot from the same side (they pair)
    await b.truth.ok('give', [b.name, 'chest', 2]);
    await until(() => (mob.world.inventory.count('chest') >= 2 ? true : undefined), 10_000, '2 chests');
    for (const p of [T, T2]) {
      const r = await mob.skills.place(p, { item: 'chest', face: 'up' });
      if (!r.ok) throw new Error(`placing the double chest half at ${at(p)}: ${r.reason}`);
      placed.push(p);
    }
    expect((await b.truth.box(T)).size).toBe(54);
    await chestAt(B);
    await b.truth.chestPut(T, 'cobblestone', 64, 30);
    await b.truth.chestPut(B, 'undyed_shulker_box', 1, 3);
    await b.truth.ok('clear', [b.name]);
    await b.truth.ok('give', [b.name, 'iron_pickaxe', 1]);
    notes.push(`(h) scan: ${await scan()}`);
    expect(b.home.logistics.tidyDue()).toBe(true);
    const { end, ms } = await unload();
    expect(end).toMatch(/boxed 27 stacks of cobblestone from (double )?chest -?\d+ -?\d+ -?\d+ into a shulker \(box from chest /);
    const rep = b.home.logistics.lastUnload!;
    notes.push(`(h) tidy step: ${JSON.stringify(rep.boxed)}; the whole !unload ${(ms / 1000).toFixed(1)} s`);
    const t = await b.truth.box(T);
    const inT = await boxesIn(T);
    notes.push(`(h) truth double chest: ${JSON.stringify(t.counts)} free ${t.free}; boxes ${JSON.stringify(inT)}`);
    expect(inT).toEqual([{ cobblestone: 1728 }]);
    expect(t.counts).toEqual({ cobblestone: 3 * 64, undyed_shulker_box: 1 });
    expect((await b.truth.box(B)).counts).toEqual({ undyed_shulker_box: 2 });
    expect(await b.truth.counts(b.name)).toEqual({ iron_pickaxe: 1 });
    expect(b.home.logistics.tidyDue()).toBe(false);
    expect((await b.truth.boxItems({ x: c.x + 0.5, y: F, z: c.z + 0.5 }, 12)).filter((i) => i.typeId.endsWith('shulker_box'))).toHaveLength(0);
    for (const p of [T, T2, B]) await removeChest(p);
  }, 500_000);
});
