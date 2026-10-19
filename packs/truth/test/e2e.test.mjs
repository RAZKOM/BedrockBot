// e2e: the truth pack on a running BDS (container bds-truth, UDP 19136, flat world, pack deployed).
//
//   node scripts/deploy.mjs --restart bds-truth     # once, after changes to the pack
//   node --test --test-concurrency=1 test/e2e.test.mjs
//
// Env: TRUTH_CONTAINER (default bds-truth), TRUTH_PORT (default 19136).
// Every block the suite changes is restored at the end of its test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { rleDecode } from '../src/protocol.ts';
import { TruthClient, connectBot } from './truth-client.mjs';

const CONTAINER = process.env.TRUTH_CONTAINER ?? 'bds-truth';
const PORT = Number(process.env.TRUTH_PORT ?? 19136);
const BOT = 'TruthBot';
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const PACK_VERSION = manifest.header.version.join('.');

/** @type {any} */
let client;
/** @type {TruthClient} */
let truth;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  client = await connectBot({
    port: PORT,
    username: BOT,
    onClient: (c) => {
      truth = new TruthClient({ client: c, container: CONTAINER });
    },
  });
  await sleep(1500); // let the server finish loading the chunks around the spawn
});

after(() => {
  client?.disconnect();
});

describe('truth pack on bds-truth', () => {
  it('ping round-trips with the request id', async () => {
    const r = await truth.cmd('ping', ['hello']);
    assert.equal(r.cmd, 'ping');
    assert.ok(r.id && r.id.startsWith('t'));
    assert.equal(r.ok, true);
    assert.equal(typeof r.tick, 'number');
    assert.equal(r.data.pong, true);
    assert.equal(r.data.pack, PACK_VERSION);
    assert.equal(r.data.api, '2.10.0');
    assert.deepEqual(r.data.echo, ['hello']);
    assert.ok(r.data.players.includes(BOT));
  });

  it('saw the playerSpawn event for the bot', async () => {
    const e = await truth.waitEvent((d) => d.type === 'playerSpawn' && d.player === BOT, { timeoutMs: 3000 });
    assert.equal(e.id, null);
  });

  it('block 0 -61 0 is grass_block on the flat world', async () => {
    const d = await truth.ok('block', [0, -61, 0]);
    assert.equal(d.typeId, 'minecraft:grass_block');
    assert.deepEqual([d.x, d.y, d.z], [0, -61, 0]);
  });

  it('set then block round-trips', async () => {
    await truth.ok('set', [2, -60, 2, 'oak_log']);
    assert.equal((await truth.ok('block', [2, -60, 2])).typeId, 'minecraft:oak_log');
    await truth.ok('set', [2, -60, 2, 'minecraft:air']);
    assert.equal((await truth.ok('block', [2, -60, 2])).typeId, 'minecraft:air');
  });

  it('blocks returns run-length encoded typeIds in y,z,x order', async () => {
    const d = await truth.ok('blocks', [-2, -64, -2, 2, -60, 2]);
    assert.deepEqual(d.size, { x: 5, y: 5, z: 5 });
    assert.equal(d.order, 'yzx');
    const flat = rleDecode(d.palette, d.runs);
    assert.equal(flat.length, 125);
    const layer = (y) => flat.slice((y + 64) * 25, (y + 65) * 25);
    assert.ok(layer(-64).every((t) => t === 'minecraft:bedrock'));
    assert.ok(layer(-63).every((t) => t === 'minecraft:dirt'));
    assert.ok(layer(-61).every((t) => t === 'minecraft:grass_block'));
    assert.ok(layer(-60).every((t) => t === 'minecraft:air'));
  });

  it('fill sets a volume and checksum sees it', async () => {
    const box = [3, -60, 3, 5, -58, 5];
    const before = await truth.ok('checksum', box);
    const f = await truth.ok('fill', [...box, 'stone']);
    assert.equal(f.volume, 27);
    const d = await truth.ok('blocks', box);
    assert.deepEqual(d.palette, ['minecraft:stone']);
    assert.deepEqual(d.runs, [[0, 27]]);
    const changed = await truth.ok('checksum', box);
    assert.notEqual(changed.hash, before.hash);
    await truth.ok('fill', [...box, 'air']);
    assert.equal((await truth.ok('checksum', box)).hash, before.hash);
  });

  it('checksum is stable across two calls', async () => {
    const box = [-8, -64, -8, 8, -56, 8];
    const a = await truth.ok('checksum', box);
    const b = await truth.ok('checksum', box);
    assert.equal(a.count, 17 * 9 * 17);
    assert.match(a.hash, /^[0-9a-f]{8}$/);
    assert.equal(a.hash, b.hash);
  });

  it('pos returns the bot at about y -60', async () => {
    const d = await truth.ok('pos', [BOT]);
    assert.equal(d.name, BOT);
    assert.ok(Math.abs(d.location.y - -60) < 0.1, `y = ${d.location.y}`);
    assert.equal(typeof d.isOnGround, 'boolean');
    for (const k of ['x', 'y', 'z']) assert.equal(typeof d.velocity[k], 'number');
    assert.equal(typeof d.rotation.yaw, 'number');
    assert.equal(typeof d.tick, 'number');
    // no name: the only player online
    assert.equal((await truth.ok('pos')).name, BOT);
  });

  it('give / inv / clear round-trip', async () => {
    await truth.ok('clear', [BOT]);
    const g = await truth.ok('give', [BOT, 'oak_log', 5]);
    assert.equal(g.given, 5);
    await truth.ok('give', [BOT, 'cobblestone', 70]);
    const inv = await truth.ok('inv', [BOT]);
    assert.equal(inv.size, 36);
    assert.equal(inv.slots.length, 36);
    assert.equal(typeof inv.selectedSlot, 'number');
    assert.equal(inv.counts['minecraft:oak_log'], 5);
    assert.equal(inv.counts['minecraft:cobblestone'], 70);
    const logSlot = inv.slots.find((s) => s && s.typeId === 'minecraft:oak_log');
    assert.equal(logSlot.amount, 5);
    assert.equal(inv.slots.filter((s) => s && s.typeId === 'minecraft:cobblestone').length, 2);
    const c = await truth.ok('clear', [BOT]);
    assert.equal(c.removed, 75);
    assert.deepEqual((await truth.ok('inv', [BOT])).counts, {});
  });

  it('tp moves the bot', async () => {
    await truth.ok('tp', [BOT, 4.5, -60, 6.5]);
    await sleep(300);
    const d = await truth.ok('pos', [BOT]);
    assert.ok(Math.abs(d.location.x - 4.5) < 0.01 && Math.abs(d.location.z - 6.5) < 0.01, JSON.stringify(d.location));
    await truth.ok('tp', [BOT, 0.5, -60, 0.5]);
  });

  it('time day|night|ticks', async () => {
    assert.equal((await truth.ok('time', ['night'])).timeOfDay, 13000);
    assert.equal((await truth.ok('time', [6000])).timeOfDay, 6000);
    assert.equal((await truth.ok('time', ['day'])).timeOfDay, 1000);
  });

  it('spawnitem drops item entities', async () => {
    const d = await truth.ok('spawnitem', [-6.5, -59, -6.5, 'diamond', 3]);
    assert.equal(d.typeId, 'minecraft:diamond');
    assert.equal(d.entities.length, 1);
    assert.equal(d.entities[0].amount, 3);
    assert.equal(typeof d.entities[0].entityId, 'string');
  });

  it('save + place copies a region identically', async () => {
    const src = [0, -61, -6, 2, -60, -4];
    const dst = [10, -61, -6, 12, -60, -4];
    const dstBefore = await truth.ok('checksum', dst);
    await truth.ok('set', [1, -60, -5, 'oak_log']);
    const s = await truth.ok('save', ['e2e_copy', ...src]);
    assert.equal(s.structure, 'mystructure:e2e_copy');
    assert.deepEqual(s.size, { x: 3, y: 2, z: 3 });
    assert.ok((await truth.ok('structures')).world.includes('mystructure:e2e_copy'));
    await truth.ok('place', ['e2e_copy', 10, -61, -6]);
    assert.equal((await truth.ok('checksum', dst)).hash, (await truth.ok('checksum', src)).hash);
    assert.equal((await truth.ok('block', [11, -60, -5])).typeId, 'minecraft:oak_log');
    await truth.ok('set', [1, -60, -5, 'air']);
    await truth.ok('set', [11, -60, -5, 'air']);
    assert.equal((await truth.ok('checksum', dst)).hash, dstBefore.hash);
  });

  it('place puts the pack structure truth:probe', async () => {
    assert.ok((await truth.ok('structures')).pack.includes('truth:probe'));
    const p = await truth.ok('place', ['truth:probe', 12, -60, 0]);
    assert.deepEqual(p.size, { x: 3, y: 2, z: 3 });
    assert.equal((await truth.ok('block', [12, -60, 0])).typeId, 'minecraft:oak_planks');
    assert.equal((await truth.ok('block', [13, -60, 1])).typeId, 'minecraft:cobblestone');
    const log = await truth.ok('block', [13, -59, 1]);
    assert.equal(log.typeId, 'minecraft:oak_log');
    assert.equal(log.states.pillar_axis, 'y');
    await truth.ok('fill', [12, -60, 0, 14, -59, 2, 'air']);
  });

  it('errors carry reasons', async () => {
    const far = await truth.cmd('block', [100000, -61, 100000]);
    assert.equal(far.ok, false);
    assert.equal(far.reason, 'unloaded_chunk');
    const farBox = await truth.cmd('checksum', [100000, -61, 100000, 100001, -61, 100001]);
    assert.equal(farBox.reason, 'unloaded_chunk');
    assert.equal((await truth.cmd('block', [0, 500, 0])).reason, 'out_of_bounds');
    assert.equal((await truth.cmd('blocks', [0, -64, 0, 20, -50, 20])).reason, 'volume_too_large');
    assert.equal((await truth.cmd('block', [0, 'x', 0])).reason, 'bad_args');
    assert.equal((await truth.cmd('pos', ['NoSuchPlayer'])).reason, 'player_not_found');
    assert.equal((await truth.cmd('give', [BOT, 'not_an_item_xyz', 1])).reason, 'unknown_item');
    assert.equal((await truth.cmd('place', ['nope_missing', 0, -60, 0])).reason, 'unknown_structure');
    const u = await truth.cmd('frobnicate');
    assert.equal(u.ok, false);
    assert.equal(u.reason, 'unknown_command');
  });

  it('kill emits a playerDie event (runs last: the bot stays dead)', async () => {
    const since = truth.events.length;
    const k = await truth.ok('kill', [BOT]);
    assert.equal(k.killed, true);
    const e = await truth.waitEvent((d) => d.type === 'playerDie' && d.player === BOT, { since, timeoutMs: 5000 });
    assert.equal(e.cmd, 'event');
    assert.equal(e.ok, true);
  });
});
