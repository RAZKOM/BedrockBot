// e2e (tag @bds), Track F13 (docs/flight.md "A flight from the box alone (Track F13)"): `!fly` with no loose rockets
// and the fireworks box carried, and the kit cases next to it. Rockets with the NBT a `/give` or the crafting table
// puts on them (the box is filled with /replaceitem, as on the Realm; the truth pack's setslot makes rockets with
// none). Each case sets the kit up, sends `!fly` 70 blocks away and records every line with its time from the
// command, the time to the takeoff (the body gliding), the kit's log lines and the packets sent.
//   boxonly    0 loose, the box in a hotbar slot
//   boxinv     0 loose, the box in a main inventory slot
//   one        1 loose rocket in the hotbar and the box
//   hotbarfull 0 loose, the hotbar full of dirt, the box in a main slot
//   invfull    0 loose, every slot full (dirt), the box in the hotbar: no slot for the rockets that leaves one for the box
//   invroom    the same with one main slot free
//   nobox      0 loose and no box: the refusal at once
//   worn       0 loose, the box, the elytra already worn
//   ledge      0 loose, the box, the body on a 1 x 1 column top 12 up (no cell to set the box down on)
//   ledgeone   the same with 1 loose rocket
//   cave       0 loose, the box, a low roof over the body (no takeoff from here)
//   goto       0 loose, the box in the hotbar, `!goto` 250 blocks away (over flyMin: the automatic flight)
// Env: F13_CASES (default all), F13_RUNS (runs a case, default 1), F13_OUT (a JSONL file with each run's lines, kit
// lines, packet counts and log), F13_EXPECT=0 (record only), the FLY_BDS_* of fly-truth.ts.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { E2E, FEET_Y, flyCmd, giveFlightKit, prepareServer, privateArea, sleep, startFlyBot, teleport, truthLoaded, until, type FlyBot } from './fly-truth.ts';

const F = FEET_Y;
const ALL = ['boxonly', 'boxinv', 'one', 'hotbarfull', 'invfull', 'invroom', 'nobox', 'worn', 'ledge', 'ledgeone', 'cave', 'goto'] as const;
type Case = (typeof ALL)[number];
const CASES = (process.env.F13_CASES?.split(',').filter((c) => (ALL as readonly string[]).includes(c)) ?? [...ALL]) as Case[];
const RUNS = Number(process.env.F13_RUNS ?? 1);
const OUT = process.env.F13_OUT;
/** F13_EXPECT=0: record only (the tree before the change). */
const EXPECT = process.env.F13_EXPECT !== '0';
/** The first line of every case within this (docs/flight.md "A flight from the box alone (Track F13)"). */
const ANSWER_MS = 5_000;
/** The cases that must take off (the kit can be made ready where the body stands). */
const FLIES: readonly Case[] = ['boxonly', 'boxinv', 'one', 'hotbarfull', 'invroom', 'worn', 'ledgeone', 'goto'];
/** The refusal each refused case ends with. */
const REFUSED: Partial<Record<Case, RegExp>> = {
  nobox: /^fly: no firework rockets/,
  invfull: /^fly: no rockets at hand and the refill from the fireworks box failed \(the inventory is full/,
  ledge: /^fly: no rockets at hand and the refill from the fireworks box failed \(no free cell next to me for the box\)/ };

interface Run {
  kase: Case;
  run: number;
  lines: { ms: number; line: string }[];
  /** ms from the command to the body gliding */
  takeoff?: number;
  end: string;
  kit: string[];
  sent: Record<string, number>;
  /** ms from the command to the last packet sent before the end (a silence shows as an early value) */
  lastSent?: number;
  boxBack: boolean;
}

describe.skipIf(!E2E)('@bds fly: a flight from the box alone (Track F13)', () => {
  const area = privateArea();
  let bot: FlyBot | undefined;
  const home: Vec3 = { x: area.x + 0.5, y: F, z: area.z + 0.5 };
  const runs: Run[] = [];
  let rec: { on: boolean; t0: number; sent: Record<string, number>; last?: number } = { on: false, t0: 0, sent: {} };

  beforeAll(async () => {
    await prepareServer();
    bot = await startFlyBot('Box');
    await teleport(bot, home);
    const b = bot;
    const orig: (n: string, p: Record<string, unknown>) => void = b.conn.queue.bind(b.conn);
    (b.conn as { queue: (n: string, p: object) => void }).queue = (n: string, p: object) => {
      if (rec.on) {
        rec.sent[n] = (rec.sent[n] ?? 0) + 1;
        if (n !== 'player_auth_input' && n !== 'tick_sync' && n !== 'network_stack_latency') rec.last = Date.now() - rec.t0;
      }
      orig(n, p as Record<string, unknown>);
    };
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.clearAround(home, 24).catch(() => undefined);
      await bot.stop();
    }
    console.log(`[fly-box-only e2e] area cell ${area.cell}; ${runs.map((r) => `${r.kase}#${r.run}: ${r.takeoff !== undefined ? `took off at ${r.takeoff} ms` : `no takeoff`}, first line ${r.lines[0] ? `${r.lines[0].ms} ms` : 'none'}`).join('; ')}`);
  }, 60_000);

  const put = (b: FlyBot, where: 'hotbar' | 'inventory', i: number, item: string, n: number) => flyCmd('replaceitem', 'entity', b.name, `slot.${where}`, String(i), item, String(n));

  /** A box of 64 rockets with the NBT, broken next to the body and picked up (it lands in the first free slot). */
  async function giveBox(b: FlyBot): Promise<void> {
    const inv = b.built.mobility!.world.inventory;
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
  }

  /** The kit of a case; the feet where the flight starts. */
  async function setup(b: FlyBot, kase: Case, run: number): Promise<Vec3> {
    const inv = b.built.mobility!.world.inventory;
    const base = { x: area.x + 40 * (ALL.indexOf(kase) + 1), z: area.z + 8 * run };
    let start: Vec3 = { x: base.x + 0.5, y: F, z: base.z + 0.5 };
    await teleport(b, start);
    await giveFlightKit(b, { rockets: 0 });
    if (kase === 'one' || kase === 'ledgeone') await put(b, 'hotbar', 0, 'firework_rocket', 1);
    if (kase === 'boxinv' || kase === 'hotbarfull') for (let i = 0; i < 9; i++) await put(b, 'hotbar', i, 'dirt', 16);
    if (kase !== 'nobox') await giveBox(b);
    if (kase === 'boxinv') for (let i = 0; i < 9; i++) await put(b, 'hotbar', i, 'air', 1);
    if (kase === 'invfull' || kase === 'invroom') {
      const box = inv.slots.findIndex((s, i) => i < 36 && s?.name.endsWith('shulker_box') === true);
      for (let i = 0; i < 36; i++) if (i !== 9 && i !== box && !(kase === 'invroom' && i === 20)) await (i < 9 ? put(b, 'hotbar', i, 'dirt', 16) : put(b, 'inventory', i - 9, 'dirt', 16));
      await until(() => (inv.slots.slice(0, 36).filter((s) => !s).length === (kase === 'invroom' ? 1 : 0) ? true : undefined), 10_000, 'the inventory filled in the model');
    }
    if (kase === 'worn') {
      await b.truth.equip(b.name, 'Chest', 'elytra');
      await put(b, 'inventory', 0, 'air', 1);
      await until(() => (inv.window(120)?.slots[1]?.name === 'elytra' && !inv.slots[9] ? true : undefined), 10_000, 'the elytra worn in the model');
    }
    if (kase === 'ledge' || kase === 'ledgeone') {
      // the top of a 1 x 1 stone column 12 up, air all round down to the floor: no cell beside the body has a top to set the box on
      const y = F + 12;
      await truthLoaded(b.truth, 'fill', [base.x, F, base.z, base.x, y - 1, base.z, 'stone']);
      start = { x: base.x + 0.5, y, z: base.z + 0.5 };
      await teleport(b, start);
    }
    if (kase === 'cave') {
      // a room 7 x 7 with its roof 3 over the floor (2 of head room over the body): no takeoff from here, the box placed and picked up
      await truthLoaded(b.truth, 'fill', [base.x - 3, F + 2, base.z - 3, base.x + 3, F + 2, base.z + 3, 'stone']);
      await truthLoaded(b.truth, 'fill', [base.x - 4, F, base.z - 4, base.x + 4, F + 2, base.z - 4, 'stone']);
      await truthLoaded(b.truth, 'fill', [base.x - 4, F, base.z + 4, base.x + 4, F + 2, base.z + 4, 'stone']);
      await truthLoaded(b.truth, 'fill', [base.x - 4, F, base.z - 4, base.x - 4, F + 2, base.z + 4, 'stone']);
      await truthLoaded(b.truth, 'fill', [base.x + 4, F, base.z - 4, base.x + 4, F + 2, base.z + 4, 'stone']);
    }
    await b.built.mobility!.loop.waitTicks(10);
    return start;
  }

  async function cleanup(b: FlyBot, kase: Case, run: number): Promise<void> {
    const base = { x: area.x + 40 * (ALL.indexOf(kase) + 1), z: area.z + 8 * run };
    if (kase === 'ledge' || kase === 'ledgeone') await truthLoaded(b.truth, 'fill', [base.x, F, base.z, base.x, F + 11, base.z, 'air']).catch(() => undefined);
    if (kase === 'cave') await truthLoaded(b.truth, 'fill', [base.x - 4, F, base.z - 4, base.x + 4, F + 2, base.z + 4, 'air']).catch(() => undefined);
  }

  it.each(CASES)('%s: !fly answers in time', async (kase) => {
    const b = bot!;
    const mob = b.built.mobility!;
    const inv = mob.world.inventory;
    for (let run = 0; run < RUNS; run++) {
      const start = await setup(b, kase, run);
      const boxes0 = inv.slots.slice(0, 36).filter((s) => s?.name.endsWith('shulker_box')).length;
      const far = kase === 'goto' ? 250 : 70;
      const goal = { x: Math.floor(start.x), z: Math.floor(start.z) + (run % 2 === 0 ? far : -far) };
      const logFrom = b.logs.length;
      const from = b.said.length;
      const t0 = Date.now();
      rec = { on: true, t0, sent: {} };
      let takeoff: number | undefined;
      const watch = setInterval(() => {
        if (takeoff === undefined && mob.loop.state.gliding) takeoff = Date.now() - t0;
      }, 25);
      const lines: Run['lines'] = [];
      const seen = (): void => {
        for (const l of b.said.slice(from + lines.length)) lines.push({ ms: Date.now() - t0, line: l });
      };
      const tick = setInterval(seen, 25);
      await b.command(`!${kase === 'goto' ? 'goto' : 'fly'} ${goal.x} ${F} ${goal.z}`);
      // the end: a landing, the walk's end, a refusal (`fly: ...`), or 90 s with none of those (a line that starts a flight
      // or a walk is no end)
      const endOf = (s: string) => (kase === 'goto' ? /^(arrived at|goto: |fly: )/ : /^(landed|walked|fly: )/).test(s);
      const end = await b.reply(endOf, from, 90_000).catch((e: Error) => `timeout: ${e.message.slice(0, 100)}`);
      await sleep(500);
      seen();
      clearInterval(watch);
      clearInterval(tick);
      rec.on = false;
      const boxBack = kase === 'nobox' || inv.slots.slice(0, 36).filter((s) => s?.name.endsWith('shulker_box')).length >= boxes0;
      const r: Run = { kase, run, lines, ...(takeoff !== undefined ? { takeoff } : {}), end, kit: b.logs.slice(logFrom).filter((l) => /flight kit|fly:|refill/.test(l)).map((l) => l.replace(/^\S+ /, '').slice(0, 400)), sent: rec.sent, ...(rec.last !== undefined ? { lastSent: rec.last } : {}), boxBack };
      runs.push(r);
      if (OUT) appendFileSync(OUT, `${JSON.stringify({ ...r, log: b.logs.slice(logFrom).map((l) => l.slice(0, 600)) })}\n`);
      console.log(`[f13] ${kase} ${run}: ${takeoff !== undefined ? `takeoff ${takeoff} ms` : 'no takeoff'}; lines ${lines.map((l) => `${l.ms}: ${l.line}`).join(' | ')}; box back ${boxBack}; sent ${JSON.stringify(rec.sent)}`);
      await b.command('!fly stop');
      await b.command('!stop');
      await sleep(500);
      await until(() => (mob.loop.state.onGround ? true : undefined), 30_000, 'standing again').catch(() => undefined);
      await cleanup(b, kase, run);
      await flyCmd('kill', '@e[type=item]').catch(() => undefined);
    }
    const mine = runs.filter((r) => r.kase === kase);
    if (EXPECT) {
      for (const r of mine) {
        const tag = `${kase}#${r.run} (${r.lines.map((l) => `${l.ms}: ${l.line}`).join(' | ')})`;
        expect(r.lines.length, `${tag}: a line`).toBeGreaterThan(0);
        expect(r.lines[0]!.ms, `${tag}: the first line in time`).toBeLessThan(ANSWER_MS);
        expect(r.end.startsWith('timeout'), `${tag}: an end line`).toBe(false);
        expect(r.boxBack, `${tag}: the box carried again`).toBe(true);
        if (FLIES.includes(kase)) {
          expect(r.takeoff, `${tag}: the takeoff`).toBeDefined();
          expect(r.end, tag).toMatch(kase === 'goto' ? /^arrived at/ : /^landed at/);
        }
        const refused = REFUSED[kase];
        if (refused) {
          expect(r.end, tag).toMatch(refused);
          expect(r.takeoff, `${tag}: no takeoff`).toBeUndefined();
        }
      }
    }
  }, 3_600_000);
});
