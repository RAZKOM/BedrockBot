// e2e (tag @bds), Track E12 (docs/early-game.md "The mine's dangers (Track E12)", ADR 0119): the four ways Track E11's
// fresh-world bots died at their mine after the night, each as a built scene on the flat test server (bds-craft by
// default; CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER point it at another). One afk-task bot in its own area, the early kit (a
// stone sword, pickaxe and axe, 16 cobblestone, 6 bread), no armour, guard off, `mobReflex` as it ships, difficulty
// normal while a run lasts, noon with the clock frozen, no natural spawns; the undead are given fire resistance so the
// sun does not take them.
//   pillar   a creeper below a bot that digs down: the bot stands on a one-wide cobblestone pillar 8 high (a mine
//            walk's own way up), 4 iron ore in the ground beside its foot; `!mine iron_ore 4`; a creeper (and, with
//            E12_ZOMBIE=1, a zombie) waits at the pillar's foot. On a fresh world the walk dug its pillar down onto a
//            creeper there and the blast took the bot from 20 to 0
//   archers  two skeletons 12 blocks off with a line on a bot that mines 24 iron ore in the open (`!mine iron_ore 24`,
//            about 40 s of work)
//   archer   one skeleton 12 blocks off, the same mine (`workGuard` fights an archer only while it is the only one)
//   witch   one witch 8 blocks off (her throw range; from 10 she did not come in 2 runs of 2), the same mine
//   door     a job paused for the night in its night shell (`jobMorning` on), two skeletons 2 and 7 blocks from the
//            shell; the morning holds until its bound (150 s), the job goes on beside them to its ore 10 to 13 blocks
//            east; watched 45 s from there
//   parched  Track E13: one parched (the desert's skeleton) 12 blocks off, the same mine (the `archer` case with it)
// A run ends when the bot died, every mob of the case is dead, or E12_SECONDS (60) have passed (the door: 45 s after
// the job went on); the step's end is noted, not the run's (the bot still stands where the mobs are). With
// E12_UNTIL=step (Track E13) the mine cases end when the step ended instead (the bot died, or E12_SECONDS), so the
// row has the job's own time and its end line whatever the mobs did. Each
// run's row: deaths, the damage the server dealt (truth:hurtlog) by cause, the lowest health, flights, guard fights,
// reflex strikes, what the bot knew of each mob (the tick it first had it, its distance and height then, the process
// running then) and the process running at each hit it took.
//   E12_CASE    pillar,archers,archer,witch,door,parched (a subset; default all)
//   E12_N       runs a case (default 1)
//   E12_ARM     a label for the rows (before | after; default `run`)
//   E12_SET     settings for the runs, `k=v,k=v` (`!set` values; the arm's switches)
//   E12_ZOMBIE  1: the pillar case has a zombie at the foot too
//   E12_SECONDS a run's limit (default 60)
//   E12_UNTIL   step: a mine case's run ends when its step ended (Track E13: the job's time), not when its mobs died;
//               both: when its step ended and its mobs are dead (the job's time and every hit of the scene)
//   E12_EXPECT  1: assert no death in any run (the gate); default: record only
//   E12_OUT     a file each row is appended to; E12_LOG the bot's log
// Env: CRAFT_BDS_HOST / CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER (craft-truth.ts), CRAFT_VERBOSE=1.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { entityFeet } from '../../src/skills/combat/hostiles.ts';
import { clearArea, craftCmd, E2E, FEET_Y, loadKit, prepareServer, privateArea, sleep, startCraftBot, teleport, truthLoaded, until, type CraftBot } from './craft-truth.ts';

const F = FEET_Y;
const ONLY = process.env.E12_CASE;
const want = (c: string) => !ONLY || ONLY.split(',').includes(c);
const N = Number(process.env.E12_N ?? 1);
const ARM = process.env.E12_ARM ?? 'run';
const SECONDS = Number(process.env.E12_SECONDS ?? 60);
const EXPECT = process.env.E12_EXPECT === '1';
const ZOMBIE = process.env.E12_ZOMBIE === '1';
const UNTIL_STEP = process.env.E12_UNTIL === 'step';
const UNTIL_BOTH = process.env.E12_UNTIL === 'both';
const SETS: [string, string][] = (process.env.E12_SET ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const i = s.indexOf('=');
    return [s.slice(0, i), s.slice(i + 1)];
  });
const KIT: [string, number][] = [
  ['stone_sword', 1],
  ['stone_pickaxe', 1],
  ['stone_axe', 1],
  ['cobblestone', 16],
  ['bread', 6],
];

/** Track E13: the archers rule's counters (PveController.archerCounts), {} on a tree without them. */
function archerRuleCounts(b: CraftBot): Record<string, number> {
  return { ...((b.task.pve as unknown as { archerCounts?: Record<string, number> }).archerCounts ?? {}) };
}

function archerRuleDiff(a: Record<string, number>, b: Record<string, number>): string {
  return Object.entries(b)
    .map(([k, v]) => [k, v - (a[k] ?? 0)] as const)
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
}

interface Seen {
  type: string;
  /** Seconds from the run's start the bot's world first had it, its distance (3D) and height over the bot then, the process then. */
  at: number;
  d: number;
  dy: number;
  doing: string;
}

interface Row {
  arm: string;
  kase: string;
  run: number;
  died: boolean;
  cause: string;
  damage: number;
  byCause: string;
  lowest: number;
  flees: number;
  fights: number;
  reflex: number;
  /** Track E12 (`creeperRise`): rises from a creeper under the feet. */
  rises: number;
  seconds: number;
  end: string;
  /** Seconds the work (the step, the door's watch) ended at; -1: it did not. */
  stepEnd: number;
  mined: number;
  /** Track E13: the step's own end line (`mine iron_ore: 24/24 done`), when it said one. */
  stepLine: string;
  /** Track E13: the archers rule's counts in the run (`workArchers`), when there is one. */
  archerRule: string;
  seen: string;
  hits: string;
  nearest: string;
  lines: string;
}

describe.skipIf(!E2E)('@bds early mine: the deaths at the mine (Track E12)', () => {
  const area = privateArea();
  const rows: Row[] = [];
  let bot: CraftBot | undefined;
  const c0 = { x: area.x + 0.5, y: F, z: area.z + 0.5 };

  const note = (s: string): void => {
    console.log(s);
    if (process.env.E12_OUT) appendFileSync(process.env.E12_OUT, `${new Date().toISOString()} ${s}\n`);
  };

  async function fresh(b: CraftBot, r = 20, h = 12): Promise<void> {
    await craftCmd('difficulty', 'peaceful');
    await craftCmd('time', 'set', '6000');
    await b.command('!stop');
    await b.command('!get stop');
    await sleep(1200);
    b.task.shelter!.set(undefined);
    b.task.home?.set(undefined);
    await b.truth.ok('clear', [b.name]);
    await teleport(b, { x: c0.x, y: F + h + 2, z: c0.z });
    await clearArea(b.truth, { x: area.x, z: area.z }, r, h);
    await craftCmd('kill', '@e[type=item]');
    await craftCmd('kill', '@e[type=arrow]');
  }

  beforeAll(async () => {
    await prepareServer();
    const b = await startCraftBot('EarlyMine');
    bot = b;
    b.settings.set('autoUnload', 'off');
    b.settings.set('autoFood', 'off');
    b.settings.set('shellBlocks', 'off');
    for (const [k, v] of SETS) b.settings.set(k as Parameters<CraftBot['settings']['set']>[0], v);
    await craftCmd('gamerule', 'keepinventory', 'true');
    await craftCmd('gamerule', 'doimmediaterespawn', 'false');
    await craftCmd('gamerule', 'mobgriefing', 'false'); // a blast hurts as it does; the scene stays for the next run
    await teleport(b, c0);
  }, 180_000);

  afterAll(async () => {
    if (bot) {
      await craftCmd('difficulty', 'peaceful').catch(() => undefined);
      await craftCmd('gamerule', 'mobgriefing', 'true').catch(() => undefined);
      await craftCmd('time', 'set', 'noon').catch(() => undefined);
      await bot.truth.cleanup().catch(() => undefined);
      await bot.truth.ok('clear', [bot.name]).catch(() => undefined);
      await teleport(bot, { x: c0.x, y: F + 14, z: c0.z }).catch(() => undefined);
      await clearArea(bot.truth, { x: area.x, z: area.z }, 24, 12).catch(() => undefined);
      await craftCmd('kill', '@e[type=item]').catch(() => undefined);
      await bot.stop();
    }
    if (process.env.E12_LOG && bot) appendFileSync(process.env.E12_LOG, `${bot.logs.join('\n')}\n`);
    const by = (k: string) => rows.filter((r) => r.kase === k);
    for (const k of ['pillar', 'archers', 'archer', 'witch', 'door', 'parched']) {
      const rs = by(k);
      if (rs.length === 0) continue;
      note(`[early-mine e2e] ${ARM} ${k}: ${rs.length} runs, ${rs.filter((r) => r.died).length} deaths, damage ${rs.map((r) => r.damage).join(' ')}, lowest ${rs.map((r) => r.lowest).join(' ')}, flights ${rs.map((r) => r.flees).join(' ')}, fights ${rs.map((r) => r.fights).join(' ')}, mined ${rs.map((r) => r.mined).join(' ')}, step end ${rs.map((r) => r.stepEnd).join(' ')} (area cell ${area.cell}; sets ${SETS.map((s) => s.join('=')).join(',') || 'none'}${UNTIL_STEP ? '; until the step' : UNTIL_BOTH ? '; until the step and the mobs' : ''})`);
    }
  }, 120_000);

  /**
   * One run: `start` builds the scene and starts the work, `mobs` places the case's mobs (their truth ids), then the run is
   * watched until the bot died, `ended` says the work is over, every mob is dead, or SECONDS pass.
   */
  async function watch(b: CraftBot, kase: string, run: number, mobs: () => Promise<string[]>, ended: () => boolean, done = 'step ended', limitS = SECONDS, endsRun = false): Promise<Row> {
    const pve = b.task.pve!;
    const world = b.built.mobility!.world;
    const resp = b.built.respawn!;
    const d0 = resp.deaths;
    const flees0 = pve.stats.flees;
    const fights0 = pve.stats.fights;
    const reflex0 = pve.reflex.totals.hits;
    const rises0 = pve.riseProcess.rises;
    const rule0 = archerRuleCounts(b);
    const s0 = b.said.length;
    const l0 = b.logs.length;
    const since = await b.truth.now();
    await craftCmd('difficulty', 'normal'); // before the summons: peaceful takes hostiles away at once
    const ids = await mobs();
    const uids = new Set(ids.map((id) => BigInt(id)));
    const t0 = Date.now();
    const sec = (): number => Math.round((Date.now() - t0) / 100) / 10;
    const doing = (): string => b.processes.active?.name ?? 'none';
    const seen = new Map<bigint, Seen>();
    const nearest = new Map<string, number>();
    const hitsAt: string[] = [];
    let lowest = pve.health();
    let lastH = lowest;
    let end = 'timeout';
    let lastTruth = 0;
    let stepEnd: number | undefined;
    while (Date.now() - t0 < limitS * 1000) {
      await sleep(100);
      const me = b.task.position();
      const h = pve.health();
      if (h < lastH - 0.01 && h > 0) hitsAt.push(`${sec()}s ${lastH.toFixed(0)}->${h.toFixed(0)} ${doing()}`);
      lastH = h;
      if (h > 0) lowest = Math.min(lowest, h);
      if (me) {
        for (const e of world.entities.values()) {
          if (e.uniqueId === undefined || !uids.has(e.uniqueId)) continue;
          const f = entityFeet(e);
          const d = Math.hypot(f.x - me.x, f.y - me.y, f.z - me.z);
          const type = e.type.replace(/^minecraft:/, '');
          if (!seen.has(e.uniqueId)) seen.set(e.uniqueId, { type, at: sec(), d: Math.round(d * 10) / 10, dy: Math.round((f.y - me.y) * 10) / 10, doing: doing() });
          nearest.set(type, Math.min(nearest.get(type) ?? 99, Math.round(d * 10) / 10));
        }
      }
      if (resp.deaths > d0) {
        end = 'died';
        lowest = 0;
        break;
      }
      // the work over is noted, not the run's end: the bot still stands where the mobs are (one witch run died 1 s
      // after its step ended); a case whose watch is the work's own (the door) ends with it
      if (stepEnd === undefined && ended()) {
        stepEnd = sec();
        if (endsRun) {
          end = done;
          break;
        }
      }
      // Track E13 (E12_UNTIL=step): the job's own time: the run goes on past the mobs' deaths until the step ended
      if (UNTIL_STEP && stepEnd !== undefined) {
        end = done;
        break;
      }
      if (!UNTIL_STEP && (!UNTIL_BOTH || stepEnd !== undefined) && Date.now() - lastTruth > 1000) {
        lastTruth = Date.now();
        let alive = 0;
        for (const id of ids) {
          const m = await b.truth.entity(id).catch(() => undefined);
          if (m && m.valid !== false && (m.health ?? 1) > 0) alive++;
        }
        if (ids.length > 0 && alive === 0) {
          end = UNTIL_BOTH ? `${done}, mobs dead` : 'mobs dead';
          await sleep(500);
          break;
        }
      }
    }
    const seconds = sec();
    await sleep(1200);
    const hurt = (await b.truth.hurtlog(since, '*')).events.filter((e) => e.victimName === b.name);
    const byCause: Record<string, number> = {};
    for (const e of hurt) {
      const k = `${e.cause}${e.damagerType ? `:${e.damagerType.replace(/^minecraft:/, '')}` : ''}`;
      byCause[k] = Math.round(((byCause[k] ?? 0) + e.damage) * 10) / 10;
    }
    await craftCmd('difficulty', 'peaceful');
    if (end !== 'died' && resp.deaths > d0) end = 'died';
    const died = end === 'died';
    if (died) lowest = 0;
    const row: Row = {
      arm: ARM,
      kase,
      run,
      died,
      cause: died ? (resp.history.at(-1)?.cause ?? '?') : '',
      damage: Math.round(hurt.reduce((a, e) => a + e.damage, 0) * 10) / 10,
      byCause: Object.entries(byCause)
        .map(([k, v]) => `${k} ${v}`)
        .join(', '),
      lowest: Math.round(lowest * 10) / 10,
      flees: pve.stats.flees - flees0,
      fights: pve.stats.fights - fights0,
      reflex: pve.reflex.totals.hits - reflex0,
      rises: pve.riseProcess.rises - rises0,
      seconds,
      end,
      stepEnd: stepEnd ?? -1,
      mined: world.inventory.count('raw_iron'),
      stepLine: b.said.slice(s0).filter((x) => /^mine \w+: |^get \w+: (done|stopped)/.test(x)).at(-1) ?? '',
      archerRule: archerRuleDiff(rule0, archerRuleCounts(b)),
      seen: [...seen.values()].map((s) => `${s.type} at ${s.at}s ${s.d} off dy ${s.dy} (${s.doing})`).join('; '),
      hits: hitsAt.join('; '),
      nearest: [...nearest.entries()].map(([k, v]) => `${k} ${v}`).join(', '),
      lines: b.logs
        .slice(l0)
        .filter((l) => /reflex: .* in reach|flee: health|flee: .*staying|flee: archers|guard: .*fighting|guard: .*ends|archers: |floor: (seal|opening)|rise: |died \(death|e12|creeper:|mine: stopped|dawn: going on|night shell: opened|morning: /.test(l))
        .slice(0, 20)
        .map((l) => l.replace(/^\S+ \w+ /, ''))
        .join(' | '),
    };
    rows.push(row);
    note(`[early-mine] ${JSON.stringify(row)}`);
    if (died) {
      await until(() => (b.task.position() && pve.health() > 0 ? true : undefined), 30_000, 'the respawn', 500).catch(() => undefined);
      await sleep(2500);
    }
    await b.command('!stop');
    await b.command('!get stop');
    await b.truth.cleanup().catch(() => undefined);
    await sleep(1000);
    return row;
  }

  /**
   * The kit, no effects, full health and food, at `feet`. Track REL3: the effects are cleared first, so a case starts
   * clean whatever ran before it (in the all-cases run a witch's poison carried from the witch case into the door case
   * and took 16 to 19 there before the job went on); the bot's own record of its poison must be gone too.
   */
  async function ready(b: CraftBot, feet: Vec3): Promise<void> {
    await teleport(b, feet);
    await loadKit(b, KIT);
    await craftCmd('kill', '@e[type=splash_potion]').catch(() => undefined);
    await craftCmd('kill', '@e[type=lingering_potion]').catch(() => undefined);
    await craftCmd('kill', '@e[type=area_effect_cloud]').catch(() => undefined);
    await craftCmd('effect', b.name, 'clear').catch(() => undefined); // an error when there is none to clear; the check below holds
    await b.truth.setHealth(b.name, 20);
    await b.truth.ok('setfood', [b.name, 20, 5]).catch(() => undefined);
    const pve = b.task.pve!;
    await until(() => (pve.mobs.selfPoison === undefined && pve.health() >= 20 ? true : undefined), 5000, 'no poison and full health at the start of the case', 100);
    await sleep(800);
  }

  async function undead(b: CraftBot, type: string, at: Vec3): Promise<string> {
    const m = await b.truth.summon(type, { x: at.x + 0.5, y: at.y, z: at.z + 0.5 });
    await b.truth.effect(m.entityId, 'fire_resistance', 600, 0).catch(() => undefined);
    return m.entityId;
  }

  const mineRunning = (b: CraftBot): boolean => b.processes.userProcesses().some((p) => p.name === 'mine');

  it.runIf(want('pillar'))(`pillar: a creeper at the foot of a pillar the bot digs down (${N} run(s), ${ARM})`, async () => {
    const b = bot!;
    for (let run = 1; run <= N; run++) {
      await fresh(b);
      const x = area.x;
      const z = area.z;
      await truthLoaded(b.truth, 'fill', [x, F, z, x, F + 7, z, 'cobblestone']);
      await truthLoaded(b.truth, 'fill', [x + 3, F - 1, z - 1, x + 4, F - 1, z, 'iron_ore']);
      await ready(b, { x: x + 0.5, y: F + 8, z: z + 0.5 });
      await b.command('!mine iron_ore 4');
      await until(() => (mineRunning(b) ? true : undefined), 15_000, 'the mine step', 100);
      await watch(
        b,
        'pillar',
        run,
        async () => {
          const ids = [(await b.truth.summon('creeper', { x: x + 1.5, y: F, z: z + 1.5 })).entityId];
          if (ZOMBIE) ids.push(await undead(b, 'zombie', { x: x - 1, y: F, z: z - 1 }));
          return ids;
        },
        () => !mineRunning(b),
      );
    }
    if (EXPECT) expect(rows.filter((r) => r.kase === 'pillar' && r.died)).toEqual([]);
  }, 60_000 + N * (SECONDS + 60) * 1000);

  /** 24 iron ore in the ground in a 6 x 4 patch under the bot (about 40 s of mining). */
  async function openMine(b: CraftBot): Promise<void> {
    await fresh(b, 22, 6);
    // (the patch crosses a chunk border: after a flight far off the chunk behind came back late once)
    await teleport(b, { x: c0.x, y: F + 1, z: c0.z });
    await sleep(1500);
    await truthLoaded(b.truth, 'fill', [area.x - 2, F - 1, area.z - 1, area.x + 3, F - 1, area.z + 2, 'iron_ore'], 60_000);
    await ready(b, c0);
    await b.command('!mine iron_ore 24');
    await until(() => (mineRunning(b) ? true : undefined), 15_000, 'the mine step', 100);
  }

  it.runIf(want('archers'))(`archers: two skeletons 12 off while the bot mines in the open (${N} run(s), ${ARM})`, async () => {
    const b = bot!;
    for (let run = 1; run <= N; run++) {
      await openMine(b);
      await watch(
        b,
        'archers',
        run,
        async () => [await undead(b, 'skeleton', { x: area.x - 12, y: F, z: area.z }), await undead(b, 'skeleton', { x: area.x - 8, y: F, z: area.z + 9 })],
        () => !mineRunning(b),
      );
    }
    if (EXPECT) expect(rows.filter((r) => r.kase === 'archers' && r.died)).toEqual([]);
  }, 60_000 + N * (SECONDS + 60) * 1000);

  it.runIf(want('archer'))(`archer: one skeleton 12 off while the bot mines in the open (${N} run(s), ${ARM})`, async () => {
    const b = bot!;
    for (let run = 1; run <= N; run++) {
      await openMine(b);
      await watch(b, 'archer', run, async () => [await undead(b, 'skeleton', { x: area.x - 12, y: F, z: area.z })], () => !mineRunning(b));
    }
    if (EXPECT) expect(rows.filter((r) => r.kase === 'archer' && r.died)).toEqual([]);
  }, 60_000 + N * (SECONDS + 60) * 1000);

  // Track E13: the desert's skeleton, as the `archer` case (one desert morning of Track E12 took 7 from one)
  it.runIf(want('parched'))(`parched: one parched 12 off while the bot mines in the open (${N} run(s), ${ARM})`, async () => {
    const b = bot!;
    for (let run = 1; run <= N; run++) {
      await openMine(b);
      await watch(b, 'parched', run, async () => [await undead(b, 'parched', { x: area.x - 12, y: F, z: area.z })], () => !mineRunning(b));
    }
    if (EXPECT) expect(rows.filter((r) => r.kase === 'parched' && r.died)).toEqual([]);
  }, 60_000 + N * (SECONDS + 60) * 1000);

  it.runIf(want('witch'))(`witch: a witch 8 off while the bot mines in the open (${N} run(s), ${ARM})`, async () => {
    const b = bot!;
    for (let run = 1; run <= N; run++) {
      await openMine(b);
      await watch(b, 'witch', run, async () => [(await b.truth.summon('witch', { x: area.x - 7.5, y: F, z: area.z + 3.5 })).entityId], () => !mineRunning(b));
    }
    if (EXPECT) expect(rows.filter((r) => r.kase === 'witch' && r.died)).toEqual([]);
  }, 60_000 + N * (SECONDS + 60) * 1000);

  // ---- the door at dawn ---------------------------------------------------------------------------------------------
  const shelter = { x: area.x - 6, y: F, z: area.z };
  const cells = (c: Vec3): Vec3[] => [
    ...[0, 1].flatMap((dy) => [
      { x: c.x + 1, y: c.y + dy, z: c.z },
      { x: c.x - 1, y: c.y + dy, z: c.z },
      { x: c.x, y: c.y + dy, z: c.z + 1 },
      { x: c.x, y: c.y + dy, z: c.z - 1 },
    ]),
    { x: c.x, y: c.y + 2, z: c.z },
  ];
  const solid = async (b: CraftBot, cs: Vec3[]): Promise<number> => {
    let n = 0;
    for (const q of cs) if ((await b.truth.block(q)).typeId !== 'minecraft:air') n++;
    return n;
  };

  it.runIf(want('door'))(`door: two skeletons at the night shell when the morning's bound runs out (${N} run(s), ${ARM})`, async () => {
    const b = bot!;
    for (let run = 1; run <= N; run++) {
      await fresh(b, 22, 6);
      b.task.shelter!.set(shelter);
      b.settings.set('protectRadius', '4');
      b.settings.set('nightShell', 'on');
      b.settings.set('jobDusk', 'on');
      b.settings.set('jobMorning', 'on');
      for (let i = 0; i < 8; i++) await truthLoaded(b.truth, 'fill', [area.x + 4 + (i % 4), F - 1, area.z - 6 + Math.floor(i / 4), area.x + 4 + (i % 4), F - 1, area.z - 6 + Math.floor(i / 4), 'iron_ore']);
      await ready(b, c0);
      await loadKit(b, [...KIT, ['crafting_table', 1], ['oak_planks', 8], ['coal', 2]]);
      await craftCmd('time', 'set', '11900');
      await sleep(300);
      const from = b.said.length;
      await b.command('!get iron_chestplate');
      await until(() => (mineRunning(b) && b.built.mobility!.world.inventory.count('raw_iron') >= 1 ? true : undefined), 60_000, 'the mine step with its first ore', 50);
      await craftCmd('time', 'set', '12100');
      await b.reply((x) => x.includes('paused for the night'), from, 60_000);
      await until(async () => ((await solid(b, cells(shelter))) >= 9 ? true : undefined), 60_000, 'the shell at the shelter', 1000);
      await b.truth.setHealth(b.name, 20);
      // the morning held by the skeletons (the clock frozen at 1500: past the burn, before the bound in ticks) until the
      // rule's wall-clock bound (150 s), then the job goes on beside them and the shell opens at once (a held dawn)
      let wentAt = 0;
      await watch(
        b,
        'door',
        run,
        async () => {
          const ids = [await undead(b, 'skeleton', { x: shelter.x + 2, y: F, z: shelter.z }), await undead(b, 'skeleton', { x: shelter.x, y: F, z: shelter.z - 7 })];
          await sleep(1500);
          await craftCmd('time', 'set', '1500');
          await b.reply((x) => x.includes('dawn: going on'), from, 200_000);
          wentAt = Date.now();
          return ids;
        },
        // 45 s after the job went on (the shell opened, the walk out, its ore), or the job's end
        () => Date.now() - wentAt > 45_000 || b.said.slice(from).some((x) => /^get iron_chestplate: (done|stopped)/.test(x)),
        'watched 45 s after going on',
        60,
        true,
      );
      b.settings.set('jobMorning', 'off');
      b.settings.set('nightShell', 'off');
      await craftCmd('time', 'set', '6000');
    }
    if (EXPECT) expect(rows.filter((r) => r.kase === 'door' && r.died)).toEqual([]);
  }, 60_000 + N * 400_000);
});
