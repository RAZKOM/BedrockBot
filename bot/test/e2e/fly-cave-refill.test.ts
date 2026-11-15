// e2e (tag @bds), Track F16 (docs/flight.md "A window under a roof refills from the box (Track F16)"): a corridor trip
// that starts underground, in the corridor world of fly-corridor (test/unit/skills/fly-corridor-world.ts: a 3 x 3 bore
// 140 long, a bend, 30 more, a 2-high section, a closed chamber round the goal), with `flyCave on` (the windows
// flown in the cave style, each proven before its takeoff) and the live `fireworksMin` 32. The body is put 3 blocks
// inside the mouth, so no cruise (and no open-air refill) comes before the first window. Each run: the kit set up,
// `!fly` to the chamber, the trip's end line, then what is carried (the boxes, the rockets loose and in the box).
//   boxonly  0 loose, the fireworks box of 64 (before: `no rockets in the hotbar`; after: the first window refills)
//   runout   F16_LOOSE (default 3) loose and the box: a window refills when the loose ones are fewer than its proof needs
//   nocell   0 loose, the box, the floor round the start a path block (no full top for the box): the refusal before
//            anything is placed, the window walked to its first goal, the refill from there
//   invfull  0 loose, the box, every other slot full: Track F13's refusal (no slot that leaves one for the box)
// Seen first: the build, a scripted fly-over into a fresh world cache and the coarse layer over it (as fly-corridor).
// Env: F16_CASES (default all), F16_RUNS (runs a case, default 1), F16_OUT (a JSONL file of the runs), F16_EXPECT=0
// (record only: the tree before the change), F16_LOOSE, the FLY_BDS_* of fly-truth.ts, FLY_AREA, FLY_VERBOSE=1.
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { silentLogger } from '../../src/log.ts';
import { attachCoarseLayer, type CoarseLayerImpl } from '../../src/skills/coarse/index.ts';
import { setCorridorProvider } from '../../src/skills/fly/corridor/registry.ts';
import { readKit } from '../../src/skills/fly/kit.ts';
import { WorldCache } from '../../src/world/cache/cache.ts';
import { corridorWorld, type CorridorWorld } from '../unit/skills/fly-corridor-world.ts';
import { carriedBoxes, E2E, FEET_Y, flyCmd, giveFlightKit, prepareServer, privateArea, sleep, startFlyBot, teleport, truthLoaded, until, type FlyBot } from './fly-truth.ts';

const F = FEET_Y;
const ALL = ['boxonly', 'runout', 'nocell', 'invfull'] as const;
type Case = (typeof ALL)[number];
const CASES = (process.env.F16_CASES?.split(',').filter((c) => (ALL as readonly string[]).includes(c)) ?? [...ALL]) as Case[];
const RUNS = Number(process.env.F16_RUNS ?? 1);
const OUT = process.env.F16_OUT;
const EXPECT = process.env.F16_EXPECT !== '0';
const LOOSE = Number(process.env.F16_LOOSE ?? 3);
/** A trip ends within this (the walk of the whole corridor takes about 100 s). */
const TRIP_MS = 300_000;

interface Run {
  kase: Case;
  run: number;
  end: string;
  ms: number;
  inChamber: boolean;
  windows: number;
  walks: number;
  rocketsFired: number;
  refills: string[];
  refusals: string[];
  /** The window ends (`corridor: window ...`) and the proofs (`the proof of the window ...`), short. */
  steps: string[];
  boxesBefore: number;
  boxesAfter: number;
  rocketsBefore: { loose: number; box: number };
  rocketsAfter: { loose: number; box: number };
  damage: number;
}

describe.skipIf(!E2E)('@bds fly: a corridor window under a roof refills from the box (Track F16)', () => {
  const area = privateArea();
  let bot: FlyBot | undefined;
  let cache: WorldCache | undefined;
  let cacheDir: string | undefined;
  let coarse: { layer: CoarseLayerImpl; detach: () => void } | undefined;
  let offNav: (() => void) | undefined;
  const w: CorridorWorld = corridorWorld({ x: area.x, z: area.z });
  const home: Vec3 = { x: w.start.x + 0.5, y: F, z: w.start.z + 0.5 };
  /** Beside the corridor (outside every hull), where every fill's chunks are loaded. */
  const site: Vec3 = { x: w.mouthX + 72.5, y: F, z: w.start.z - 11.5 };
  /** 3 blocks inside the mouth, in the bore's middle lane. */
  const inside: Vec3 = { x: w.mouthX + 3.5, y: F, z: w.start.z + 0.5 };
  const runs: Run[] = [];

  const fill = (a: Vec3, b: Vec3, block: string) => truthLoaded(bot!.truth, 'fill', [a.x, a.y, a.z, b.x, b.y, b.z, block], 60_000);
  const put = (b: FlyBot, where: 'hotbar' | 'inventory', i: number, item: string, n: number) => flyCmd('replaceitem', 'entity', b.name, `slot.${where}`, String(i), item, String(n));

  async function flyOver(): Promise<void> {
    const b = bot!;
    await teleport(b, { x: home.x - 260, y: F, z: home.z });
    for (const x of [w.start.x + 60, w.mouthX, w.mouthX + 72, w.mouthX + 144]) await teleport(b, { x: x + 0.5, y: F, z: w.start.z - 11.5 });
    await teleport(b, { x: w.bendX + 12.5, y: F, z: w.goal.z + 0.5 });
    await b.built.mobility!.loop.waitTicks(20);
    await teleport(b, home);
  }

  /** A box of 64 rockets with the NBT (/replaceitem), broken next to the body and picked up. */
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

  const counts = (b: FlyBot): { boxes: number; loose: number; box: number } => {
    const inv = b.built.mobility!.world.inventory;
    const boxes = carriedBoxes(b);
    const k = readKit(inv);
    return { boxes: boxes.length, loose: k.rockets, box: boxes.reduce((a, x) => a + (x.contents.firework_rocket ?? 0), 0) };
  };

  /** The floor round the start (5 x 3, the body's own cell kept) a path block: no cell beside the body has a full top. */
  const pathFloor = (block: string) => fill({ x: Math.floor(inside.x) - 2, y: F - 1, z: w.start.z - 1 }, { x: Math.floor(inside.x) + 2, y: F - 1, z: w.start.z + 1 }, block);

  async function setup(b: FlyBot, kase: Case): Promise<void> {
    const inv = b.built.mobility!.world.inventory;
    await b.command('!stop');
    await sleep(500);
    await teleport(b, inside, -90);
    await giveFlightKit(b, { rockets: 0 });
    // (the loose rockets first: the box goes into the first free slot)
    if (kase === 'runout') {
      await put(b, 'hotbar', 0, 'firework_rocket', LOOSE);
      await until(() => (readKit(inv).rockets === LOOSE ? true : undefined), 10_000, 'the loose rockets in the model');
    }
    await giveBox(b);
    if (kase === 'invfull') {
      const box = inv.slots.findIndex((s, i) => i < 36 && s?.name.endsWith('shulker_box') === true);
      for (let i = 0; i < 36; i++) if (i !== 9 && i !== box) await (i < 9 ? put(b, 'hotbar', i, 'dirt', 16) : put(b, 'inventory', i - 9, 'dirt', 16));
      await until(() => (inv.slots.slice(0, 36).filter((s) => !s).length === 0 ? true : undefined), 10_000, 'the inventory filled in the model');
    }
    if (kase === 'nocell') {
      await pathFloor('grass_path');
      await fill({ x: Math.floor(inside.x), y: F - 1, z: w.start.z }, { x: Math.floor(inside.x), y: F - 1, z: w.start.z }, 'grass_block');
      await teleport(b, inside, -90);
    }
    await b.built.mobility!.loop.waitTicks(10);
  }

  beforeAll(async () => {
    await prepareServer();
    bot = await startFlyBot('Rf');
    bot.settings.set('flyCave', 'on');
    bot.settings.set('fireworksMin', 32); // the live setting
    setCorridorProvider(bot.task, undefined); // the layer's own corridor
    cacheDir = mkdtempSync(join(tmpdir(), 'bb-refill-e2e-'));
    cache = new WorldCache({ dir: cacheDir, flushIntervalMs: 0, logger: silentLogger });
    cache.attach(bot.built.mobility!.world);
    await teleport(bot, site);
    for (const f of w.fills) await fill(f.from, f.to, f.block);
    await bot.built.mobility!.loop.waitTicks(10);
    await flyOver();
    const mob = bot.built.mobility!;
    coarse = attachCoarseLayer(mob.world);
    if (!coarse) throw new Error('no coarse layer: the world has no cache');
    offNav = mob.skills.nav.attachCoarse(coarse.layer, { minBlocks: () => 96 });
  }, 300_000);

  afterAll(async () => {
    offNav?.();
    coarse?.detach();
    if (bot) await bot.stop();
    cache?.close();
    if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
    const by = (k: Case) => runs.filter((r) => r.kase === k);
    console.log(`[fly-cave-refill e2e] area cell ${area.cell}\n  ${ALL.filter((k) => by(k).length).map((k) => `${k}: ${by(k).filter((r) => r.inChamber).length}/${by(k).length} in the chamber, windows ${by(k).map((r) => r.windows).join(' ')}, refills ${by(k).map((r) => r.refills.length).join(' ')}, boxes left ${by(k).reduce((a, r) => a + Math.max(0, r.boxesBefore - r.boxesAfter), 0)}`).join('\n  ')}`);
  }, 60_000);

  it.each(CASES)('%s', async (kase) => {
    const b = bot!;
    for (let run = 0; run < RUNS; run++) {
      await setup(b, kase);
      const c0 = counts(b);
      const since = await b.truth.now();
      const n0 = b.logs.length;
      const from = b.said.length;
      const t0 = Date.now();
      await b.command(`!fly ${w.goal.x} ${w.goal.y} ${w.goal.z}`);
      const end = await b.reply((s) => (s.startsWith('arrived at') && s.includes('along a corridor')) || s.startsWith('fly: the corridor'), from, TRIP_MS).catch((e: Error) => `timeout: ${e.message.slice(0, 100)}`);
      const ms = Date.now() - t0;
      await sleep(1500);
      const logs = b.logs.slice(n0).map((l) => l.replace(/^\S+ (info|warn|error) /, ''));
      const line = logs.find((l) => l.startsWith('corridor: arrived at') || l.startsWith('corridor: gave up on')) ?? '';
      const num = (re: RegExp): number => Number(re.exec(line)?.[1] ?? -1);
      const g = await b.truth.glide(b.name);
      const dmg = await b.truth.damageSince(since, b.name);
      const p = g.location;
      const inChamber = Math.abs(p.x - (w.goal.x + 0.5)) <= 4.5 && p.z >= w.goal.z - 4 && p.z <= w.goal.z + 5 && Math.abs(p.y - F) < 0.1;
      const c1 = counts(b);
      const r: Run = {
        kase,
        run,
        end,
        ms,
        inChamber,
        windows: num(/, (\d+) windows underground/),
        walks: num(/, (\d+) walks/),
        rocketsFired: num(/, (\d+) rockets/),
        refills: logs.filter((l) => /flight kit: refill|corridor: refill|window refill/.test(l)).map((l) => l.slice(0, 300)),
        refusals: logs.filter((l) => /cannot be made|no rockets in the hotbar|no refill/.test(l)).map((l) => l.slice(0, 300)),
        steps: logs.filter((l) => /^corridor: (window|the proof|no complete plan|leg \d+: underground)/.test(l)).map((l) => l.slice(0, 220)),
        boxesBefore: c0.boxes,
        boxesAfter: c1.boxes,
        rocketsBefore: { loose: c0.loose, box: c0.box },
        rocketsAfter: { loose: c1.loose, box: c1.box },
        damage: dmg.total,
      };
      runs.push(r);
      if (OUT) appendFileSync(OUT, `${JSON.stringify({ ...r, log: logs.filter((l) => /^(corridor|fly|flight kit|walk|goto)/.test(l)).map((l) => l.slice(0, 500)) })}\n`);
      console.log(`[f16] ${kase} ${run}: ${end} | ${ms} ms | chamber ${inChamber} | windows ${r.windows} walks ${r.walks} fired ${r.rocketsFired} | refills ${r.refills.length} | boxes ${r.boxesBefore}->${r.boxesAfter} | rockets ${JSON.stringify(r.rocketsBefore)}->${JSON.stringify(r.rocketsAfter)} | damage ${r.damage}`);
      await b.command('!fly stop');
      await b.command('!stop');
      await sleep(500);
      await until(() => (b.built.mobility!.loop.state.onGround ? true : undefined), 30_000, 'standing again').catch(() => undefined);
      if (kase === 'nocell') await pathFloor('grass_block').catch(() => undefined);
      await flyCmd('kill', '@e[type=item]').catch(() => undefined);
      if (EXPECT) {
        const tag = `${kase}#${run}: ${end}`;
        expect(r.boxesAfter, `${tag}: the box carried again`).toBe(r.boxesBefore);
        expect(r.rocketsAfter.loose + r.rocketsAfter.box + r.rocketsFired, `${tag}: no rocket lost`).toBe(r.rocketsBefore.loose + r.rocketsBefore.box);
        expect(r.end.startsWith('timeout'), tag).toBe(false);
        if (kase === 'boxonly' || kase === 'runout') {
          expect(r.inChamber, tag).toBe(true);
          expect(r.windows, tag).toBeGreaterThan(0);
          // (a run-out trip whose windows each planned on fewer rockets than it had loose needs no refill: its proofs say
          // so, and that is a pass too; a box-only trip has nothing loose and must refill)
          const none = kase === 'runout' && r.refusals.some((l) => l.includes('no refill needed'));
          expect(r.refills.some((l) => l.includes('refill ok')) || none, `${tag}: a refill, or none needed`).toBe(true);
        }
        if (kase === 'nocell') expect(r.refusals.some((l) => l.includes('no free cell next to me for the box')), `${tag}: the refusal`).toBe(true);
        if (kase === 'invfull') expect(r.refusals.some((l) => l.includes('the inventory is full')), `${tag}: the refusal`).toBe(true);
      }
    }
  }, 7_200_000);
});
