// e2e (tag @bds), wave 11 Track AU (docs/flight.md "The kit"): the flight kit's rules on bds-fly
// (flat, peaceful, truth pack). One afk-task bot (walking, the CLI's wiring):
//   drop      `!drop all` keeps the elytra, the rockets and the fireworks box and says so
//   unload    `!unload` at a truth-built chest never moves them
//   stash     the stash step with a full inventory never places the fireworks box (no shulker step)
//   refill    a flight with 8 rockets in the hotbar and a box of 64 refills the hotbar from the box first
//   whisper   a landing with 9 rockets and no box says the fireworks-low line once
//   worn      `!fly` refuses with an elytra at 25 uses
//   autoFly   `!goto` 300 blocks flies when autoFly is on and walks when it is off
// Env: FLY_BDS_HOST / FLY_BDS_PORT / FLY_BDS_CONTAINER (fly-truth.ts), FLY_AREA, FLY_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { stashFor } from '../../src/skills/container/stash.ts';
import { carriedBoxes, E2E, FEET_Y, giveFlightKit, hdist, prepareServer, privateArea, sleep, startFlyBot, teleport, truthLoaded, until, type FlyBot } from './fly-truth.ts';

const F = FEET_Y;

describe.skipIf(!E2E)('@bds fly: the flight kit rules (Track AU)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: FlyBot | undefined;
  const home: Vec3 = { x: area.x + 0.5, y: F, z: area.z + 0.5 };

  beforeAll(async () => {
    await prepareServer();
    bot = await startFlyBot('Kit');
    await teleport(bot, home);
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.clearAround(home, 24).catch(() => undefined);
      await bot.stop();
    }
    console.log(`[fly-kit e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 60_000);

  it('!drop all keeps the elytra, the rockets and the fireworks box', async () => {
    const b = bot!;
    await teleport(b, home);
    await giveFlightKit(b, { rockets: 23, boxRockets: 64 });
    await b.truth.ok('give', [b.name, 'cobblestone', 10]);
    await until(async () => ((await b.truth.counts(b.name)).cobblestone === 10 ? true : undefined), 5_000, 'the cobblestone');
    await sleep(300);
    const from = b.said.length;
    await b.command('!drop all');
    const r = await b.reply((s) => s.startsWith('dropped ') || s.startsWith('drop: '), from, 30_000);
    notes.push(`drop all: ${r}`);
    expect(r).toContain('kept the flight kit (elytra, 23 rockets, the fireworks box); !drop flightkit drops it');
    await sleep(500);
    const counts = await b.truth.counts(b.name);
    expect(counts.elytra).toBe(1);
    expect(counts.firework_rocket).toBe(23);
    expect(Object.entries(counts).filter(([k]) => k.endsWith('shulker_box')).reduce((a, [, v]) => a + v, 0)).toBe(1);
    expect(counts.cobblestone ?? 0).toBe(0);
    await b.truth.clearAround(home, 8);
  }, 90_000);

  it('!unload at a chest never moves the kit', async () => {
    const b = bot!;
    await teleport(b, home);
    const chest = { x: area.x + 3, y: F, z: area.z };
    await truthLoaded(b.truth, 'set', [chest.x, chest.y, chest.z, 'chest']);
    b.task.home!.set({ x: area.x, y: F, z: area.z });
    await giveFlightKit(b, { rockets: 23, boxRockets: 64 });
    await b.truth.ok('give', [b.name, 'cobblestone', 64]);
    await b.truth.ok('give', [b.name, 'cobblestone', 64]);
    await until(async () => ((await b.truth.counts(b.name)).cobblestone === 128 ? true : undefined), 5_000, 'the cobblestone');
    await sleep(300);
    const from = b.said.length;
    await b.command('!chests scan');
    await b.reply((s) => s.startsWith('chests: '), from, 60_000);
    await b.command('!unload');
    const start = await b.reply((s) => s.startsWith('unloading ') || s.startsWith('unload: '), from, 30_000);
    const end = start.startsWith('unload: ') ? start : await b.reply((s) => s.startsWith('unloaded: ') || s.startsWith('unload: '), from, 120_000);
    notes.push(`unload: ${start} -> ${end}`);
    const inv = await b.truth.blockInv(chest);
    const counts = await b.truth.counts(b.name);
    expect(inv.counts['minecraft:elytra'] ?? 0).toBe(0);
    expect(inv.counts['minecraft:firework_rocket'] ?? 0).toBe(0);
    expect(Object.keys(inv.counts).some((k) => k.endsWith('shulker_box'))).toBe(false);
    expect(counts.elytra).toBe(1);
    expect(counts.firework_rocket).toBe(23);
    expect(Object.entries(counts).filter(([k]) => k.endsWith('shulker_box')).reduce((a, [, v]) => a + v, 0)).toBe(1);
    expect(inv.counts['minecraft:cobblestone'] ?? 0).toBeGreaterThan(0);
    await truthLoaded(b.truth, 'set', [chest.x, chest.y, chest.z, 'air']);
    b.task.home!.set(undefined);
  }, 240_000);

  it('the stash step with a full inventory never places the fireworks box', async () => {
    const b = bot!;
    await teleport(b, home);
    await giveFlightKit(b, { rockets: 23, boxRockets: 64 });
    const inv = b.built.mobility!.world.inventory;
    for (let i = 0; i < 40 && inv.freeSlots().length > 0; i++) await b.truth.ok('give', [b.name, 'cobblestone', 64]).catch(() => undefined);
    await until(() => (inv.freeSlots().length === 0 ? true : undefined), 10_000, 'a full inventory in the model');
    await sleep(300);
    const stash = stashFor(b.processes)!;
    const n0 = stash.attempts.length;
    const ok = await stash.ifFull({ label: 'fly-kit test' });
    const attempt = stash.attempts[n0];
    notes.push(`stash: ok ${ok}; steps ${JSON.stringify(attempt?.steps.map((s) => ({ kind: s.kind, ok: s.ok, reason: s.reason })))}`);
    expect(attempt).toBeDefined();
    expect(attempt!.steps.some((s) => s.kind === 'shulker')).toBe(false);
    const counts = await b.truth.counts(b.name);
    expect(counts.elytra).toBe(1);
    expect(counts.firework_rocket).toBe(23);
    const boxes = carriedBoxes(b);
    expect(boxes.length).toBe(1);
    expect(boxes[0]!.contents).toEqual({ firework_rocket: 64 });
    await b.truth.clearAround(home, 8);
  }, 120_000);

  it('a flight with 8 rockets in the hotbar refills from the box first', async () => {
    const b = bot!;
    await teleport(b, home);
    await giveFlightKit(b, { rockets: 8, boxRockets: 64 });
    const target = { x: area.x, y: F, z: area.z - 100 };
    const from = b.said.length;
    await b.command(`!fly ${target.x} ${target.y} ${target.z}`);
    const start = await b.reply((s) => s.startsWith('flying to ') || s.startsWith('fly: ') || s.startsWith('elytra worn'), from);
    expect(start).toMatch(/^flying to /);
    const end = await b.reply((s) => s.startsWith('landed') || s.startsWith('fly: '), from, 90_000);
    const refill = b.logs.find((l) => l.includes('flight kit: refill'));
    notes.push(`refill: ${end}; ${refill ?? 'no refill log line'}`);
    expect(end).toMatch(/^landed at /);
    expect(refill).toMatch(/refill ok: took 56 firework_rocket/);
    const boxes = carriedBoxes(b);
    expect(boxes.length).toBe(1);
    expect(boxes[0]!.contents).toEqual({ firework_rocket: 8 });
    const counts = await b.truth.counts(b.name);
    expect(counts.firework_rocket).toBeGreaterThanOrEqual(64 - 4);
    await b.truth.clearAround(home, 8);
  }, 150_000);

  it('a landing with 9 rockets and no box says the fireworks-low line once', async () => {
    const b = bot!;
    await teleport(b, home);
    await giveFlightKit(b, { rockets: 9 });
    const target = { x: area.x, y: F, z: area.z + 100 };
    const from = b.said.length;
    await b.command(`!fly ${target.x} ${target.y} ${target.z}`);
    const end = await b.reply((s) => s.startsWith('landed') || s.startsWith('fly: '), from, 90_000);
    expect(end).toMatch(/^landed at /);
    const low = await b.reply((s) => s.startsWith('fireworks low: '), from, 10_000);
    notes.push(`whisper: ${low}`);
    expect(low).toMatch(/^fireworks low: [1-9] rockets? left and the box is empty; give me more \(drop them or !bring fireworks_rocket 64\)$/);
    await sleep(2000);
    expect(b.said.slice(from).filter((s) => s.startsWith('fireworks low: ')).length).toBe(1);
  }, 150_000);

  it('!fly refuses with an elytra at 25 uses', async () => {
    const b = bot!;
    await teleport(b, home);
    await giveFlightKit(b, { rockets: 64, elytraDamage: 432 - 25 });
    const from = b.said.length;
    await b.command(`!fly ${area.x} ${F} ${area.z + 100}`);
    const r = await b.reply((s) => s.startsWith('elytra worn') || s.startsWith('flying') || s.startsWith('fly: '), from);
    notes.push(`worn: ${r}`);
    expect(r).toBe('elytra worn: 25 uses left; I will not fly until it is mended or replaced');
  }, 60_000);

  it('!goto 300 blocks flies when autoFly is on and walks when it is off', async () => {
    const b = bot!;
    await teleport(b, home);
    await giveFlightKit(b, { rockets: 64 });
    const target = { x: area.x, y: F, z: area.z + 300 };
    let from = b.said.length;
    await b.command(`!goto ${target.x} ${target.y} ${target.z}`);
    const flying = await b.reply((s) => s.startsWith('flying (') || s.startsWith('goto: '), from, 15_000);
    notes.push(`goto on: ${flying}`);
    expect(flying).toMatch(/^flying \(300 blocks; walking would be ~1 min\)$/);
    const arrived = await b.reply((s) => s.startsWith('arrived at ') || s.startsWith('goto: '), from, 150_000);
    expect(arrived).toBe(`arrived at ${target.x} ${target.y} ${target.z}`);
    const g = await b.truth.glide(b.name);
    expect(hdist(g.location, { x: target.x + 0.5, z: target.z + 0.5 })).toBeLessThan(2.5);
    // off: it walks
    await teleport(b, home);
    await giveFlightKit(b, { rockets: 64 });
    from = b.said.length;
    await b.command('!set autoFly off');
    await b.reply((s) => s.includes('autoFly'), from);
    await b.command(`!goto ${target.x} ${target.y} ${target.z}`);
    const walking = await b.reply((s) => s.startsWith('walking to '), from, 10_000);
    await sleep(4000);
    const said = b.said.slice(from);
    notes.push(`goto off: ${walking}; later: ${said.slice(1).join(' | ')}`);
    expect(said.some((s) => s.startsWith('flying ('))).toBe(false);
    await b.command('!stop');
    await b.reply((s) => s.startsWith('stopped'), from, 10_000);
    await b.command('!set autoFly on');
  }, 240_000);
});
