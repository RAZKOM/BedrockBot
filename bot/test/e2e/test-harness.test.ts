// Track T1 (docs/runbook.md "The Realm as a test server (Track T1)", ADR 0075) on bds-fly3 (udp/19212, FLAT world, peaceful,
// allow-cheats on, default-player-permission-level operator: every bot joins as an operator; `deop <name>` from the console
// takes it away while the bot is online). The real afk task (fly-truth.ts startFlyBot) in a random private area 60 000 blocks
// out, records under a temporary BEDROCKBOT_TESTS_DIR:
//   1. op detection: start_game / update_abilities say operator, the probe answers, ops.ensure() is `op`
//   2. testMode off: a death sends no command and records no recovery; `!test` runs refuse
//   3. no op (console deop): `!test goto ...` and the death path refuse cleanly with the harness's line, no command sent
//   4. `!test goto ... 3`: three runs, each restored (tp, kit, a worn-out elytra replaced, rockets taken away given back, a
//      heal after damage), each arriving; the JSONL file has three runs and the summary
//   5. a forced death in a run (console kill, keepInventory off): respawn, the kit back, /tp to the start, the next run arrives
// Env: T1_BDS_PORT (19212), T1_BDS_CONTAINER (bds-fly3), or FLY_BDS_PORT / FLY_BDS_CONTAINER directly; FLY_VERBOSE=1 logs the bot.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunRecord, SeriesSummary } from '../../src/skills/test/series.ts';
import type { FlyBot } from './fly-truth.ts'; // types only: the module itself is imported below, after the env defaults

process.env.FLY_BDS_PORT ??= process.env.T1_BDS_PORT ?? '19212';
process.env.FLY_BDS_CONTAINER ??= process.env.T1_BDS_CONTAINER ?? 'bds-fly3';
const TESTS_DIR = mkdtempSync(join(tmpdir(), 'bedrockbot-t1-'));
process.env.BEDROCKBOT_TESTS_DIR = TESTS_DIR;

const ft = await import('./fly-truth.ts');
const { testControlOf } = await import('../../src/chat/commands-test.ts');
const { NEEDS_OP } = await import('../../src/skills/test/ops.ts');
const { E2E, FEET_Y, flyCmd, giveFlightKit, prepareServer, privateArea, sleep, startFlyBot, teleport, until } = ft;

const records = (): (RunRecord | SeriesSummary)[][] =>
  readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((f) => readFileSync(join(TESTS_DIR, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as RunRecord | SeriesSummary));

describe.skipIf(!E2E)('test harness: op detection, recovery, repeated runs (Track T1)', () => {
  let bot: FlyBot | undefined;
  const area = privateArea();
  const START = { x: area.x, y: FEET_Y, z: area.z };
  const GOAL = { x: area.x + 24, y: FEET_Y, z: area.z };
  const FAR = { x: area.x + 64, y: FEET_Y, z: area.z };
  const ctl = () => testControlOf(bot!.task)!;

  beforeAll(async () => {
    await prepareServer();
    bot = await startFlyBot('T1Harness');
    console.log(`area ${area.x} ${area.z} (cell ${area.cell}); records in ${TESTS_DIR}`);
  }, 120_000);

  afterAll(async () => {
    if (bot) await flyCmd('op', bot.name).catch(() => undefined);
    await flyCmd('gamerule', 'keepinventory', 'true').catch(() => undefined);
    await bot?.stop();
    rmSync(TESTS_DIR, { recursive: true, force: true });
  });

  it('detects op from the server packets and the probe', async () => {
    const c = ctl();
    const before = c.ops.status();
    console.log(`signals at spawn: ${JSON.stringify(before.signals)}; verdict ${before.state}`);
    expect(before.signals).toMatchObject({ permissionLevel: 'operator', commandPermission: 'operator', commandsEnabled: true, achievementsDisabled: true });
    const s = await c.ops.ensure();
    expect(s.state).toBe('op');
    expect(s.probe).toMatchObject({ ok: true, messageId: 'commands.testfor.success' });
    console.log(`op: ${s.line}`);
  }, 30_000);

  it('testMode off: a death sends no command, nothing is recovered, !test runs refuse', async () => {
    const b = bot!;
    const c = ctl();
    expect(b.settings.get('testMode')).toBe(false);
    const sent0 = c.runner.counts.sent;
    const from = b.said.length;
    await b.command(`!test goto ${GOAL.x} ${GOAL.y} ${GOAL.z} from ${START.x} ${START.y} ${START.z} 3`);
    await b.reply((m) => m.startsWith('test: testMode is off'), from);
    const deaths = b.built.respawn!.deaths;
    await flyCmd('kill', b.name);
    await until(() => (b.built.respawn!.deaths > deaths && !b.built.respawn!.dead ? true : undefined), 20_000, 'death and respawn');
    await sleep(3000);
    expect(c.runner.counts.sent).toBe(sent0);
    expect(c.recovery.history).toEqual([]);
    expect(c.recovery.phase).toBe('idle');
  }, 60_000);

  it('without op: the runs and the death path refuse cleanly, no command is sent', async () => {
    const b = bot!;
    const c = ctl();
    b.settings.set('testMode', 'on');
    await flyCmd('deop', b.name);
    await until(() => (c.ops.status().state === 'not_op' ? true : undefined), 10_000, 'update_abilities member');
    console.log(`after deop: ${c.ops.status().line}`);
    const sent0 = c.runner.counts.sent;
    let from = b.said.length;
    await b.command(`!test goto ${GOAL.x} ${GOAL.y} ${GOAL.z} from ${START.x} ${START.y} ${START.z} 3`);
    const line = await b.reply((m) => m.startsWith('test: '), from);
    expect(line).toContain(NEEDS_OP);
    console.log(`refusal: ${line}`);
    from = b.said.length;
    const deaths = b.built.respawn!.deaths;
    await flyCmd('kill', b.name);
    const told = await b.reply((m) => m.startsWith('test: no recovery after the death'), from, 20_000);
    console.log(`death without op: ${told}`);
    expect(b.built.respawn!.deaths).toBe(deaths + 1);
    expect(c.recovery.phase).toBe('refused');
    expect(c.runner.counts.sent).toBe(sent0); // the server's word was enough: not even a probe
    expect(c.current()).toBeUndefined();
    await flyCmd('op', b.name);
    await until(() => (c.ops.status().signals.commandPermission === 'operator' ? true : undefined), 10_000, 'update_abilities operator');
    expect((await c.ops.ensure()).state).toBe('op');
  }, 60_000);

  it('!test goto ... 3: tp, re-kit (a worn-out elytra, rockets taken away), a heal, three arrivals, the JSONL file', async () => {
    const b = bot!;
    const c = ctl();
    const inv = b.built.mobility!.world.inventory;
    await teleport(b, { x: START.x + 0.5, y: START.y, z: START.z + 0.5 });
    await giveFlightKit(b, { rockets: 32, elytraDamage: 400 }); // 32 uses left: under TEST_LIMITS.elytraMin 100
    expect(inv.slots[9]?.damage).toBe(400);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command(`!test goto ${GOAL.x} ${GOAL.y} ${GOAL.z} from ${START.x} ${START.y} ${START.z} 3`);
    const startLine = await b.reply((m) => m.startsWith('test goto'), from, 30_000);
    console.log(startLine);
    const series = await until(() => c.current(), 10_000, 'the series');
    // run 1: take 10 rockets away (the next restore gives them back)
    await until(() => (series.current === 1 && b.processes.userProcesses().length > 0 ? true : undefined), 30_000, 'run 1 walking');
    await flyCmd('clear', b.name, 'firework_rocket', '0', '10');
    // run 2: 8 damage (20 -> 12, under TEST_LIMITS.healBelow 14): a heal
    await until(() => (series.current === 2 && b.processes.userProcesses().length > 0 ? true : undefined), 60_000, 'run 2 walking');
    await flyCmd('damage', b.name, '8');
    const sum = await c.done();
    console.log(`summary after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${JSON.stringify(sum)}`);
    for (const r of series.records) console.log(`run ${r.run}: ${r.end} ${r.seconds} s, end ${r.endDistance} from the goal, damage ${r.damage}, heals ${r.heals}, path ${r.pathBlocks}; restore: ${r.restore.join('; ')}`);
    expect(sum).toMatchObject({ runs: 3, planned: 3, arrived: 3, deaths: 0, ends: { arrived: 3 } });
    const [r1, r2, r3] = series.records;
    expect(r1!.restore.join('; ')).toMatch(/elytra in slot 9 \(fresh: 32 uses left\)/);
    expect(r1!.restore.some((s) => s.startsWith(`tp ${START.x} ${START.y} ${START.z}`))).toBe(true);
    expect(r2!.restore.join('; ')).toMatch(/firework_rocket \+10/);
    expect(r2!.heals).toBeGreaterThanOrEqual(1);
    expect(r2!.damage).toBeGreaterThanOrEqual(7);
    expect(r3!.restore.join('; ')).toMatch(/healed|tp /);
    for (const r of series.records) {
      expect(r.arrived).toBe(true);
      expect(r.endDistance).toBeLessThanOrEqual(2.5);
      expect(r.pathBlocks).toBeGreaterThan(20);
      expect(r.flownShare).toBe(0);
    }
    expect(inv.slots.filter((s) => s?.name === 'elytra').every((s) => (s?.damage ?? 0) === 0)).toBe(true);
    const counts = await b.truth.counts(b.name);
    expect(counts.firework_rocket).toBe(32);
    const files = records();
    const mine = files.find((f) => f.some((r) => r.type === 'run' && r.series.startsWith('goto') && r.of === 3 && r.end === 'arrived'))!;
    expect(mine.filter((r) => r.type === 'run')).toHaveLength(3);
    expect(mine[mine.length - 1]).toMatchObject({ type: 'summary', arrived: 3 });
    const lines = b.said.slice(from);
    expect(lines.filter((m) => /^test goto \S+ \S+ \S+ \d\/3: arrived/.test(m))).toHaveLength(3);
    expect(lines.some((m) => /^test goto .+: 3\/3 arrived/.test(m))).toBe(true);
  }, 300_000);

  it('a forced death in a run: respawn, the kit back, /tp to the start, the series goes on', async () => {
    const b = bot!;
    const c = ctl();
    await flyCmd('gamerule', 'keepinventory', 'false');
    const deaths0 = b.built.respawn!.deaths;
    const from = b.said.length;
    await b.command(`!test goto ${FAR.x} ${FAR.y} ${FAR.z} from ${START.x} ${START.y} ${START.z} 2`);
    const series = await until(() => c.current(), 30_000, 'the series');
    await until(() => {
      const p = b.task.position();
      return series.current === 1 && p && p.x > START.x + 6 ? true : undefined;
    }, 60_000, 'run 1 under way');
    const killedAt = b.task.position()!;
    await flyCmd('kill', b.name);
    const sum = await c.done();
    for (const r of series.records) console.log(`run ${r.run}: ${r.end} ${r.seconds} s, deaths ${r.deaths}, end at ${JSON.stringify(r.endAt)}; restore: ${r.restore.join('; ')}`);
    console.log(`recovery: ${JSON.stringify(c.recovery.history[c.recovery.history.length - 1])}`);
    expect(b.built.respawn!.deaths).toBe(deaths0 + 1);
    expect(series.records.map((r) => r.end)).toEqual(['died', 'arrived']);
    expect(series.records[0]!.endAt!.x).toBeCloseTo(killedAt.x, -1);
    const rec = c.recovery.history[c.recovery.history.length - 1]!;
    expect(rec.phase).toBe('idle');
    expect(rec.steps.join('; ')).toMatch(/kit: .*iron_chestplate|kit: .*chest iron_chestplate/);
    expect(rec.steps.some((s) => s.startsWith(`tp ${START.x} ${START.y} ${START.z}`))).toBe(true);
    expect(sum).toMatchObject({ runs: 2, arrived: 1, deaths: 1, ends: { died: 1, arrived: 1 } });
    const counts = await b.truth.counts(b.name);
    expect(counts.elytra ?? 0).toBeGreaterThanOrEqual(1);
    expect(counts.firework_rocket ?? 0).toBeGreaterThanOrEqual(32);
    expect((await b.truth.chestSlot(b.name))?.typeId).toBe('minecraft:iron_chestplate');
    expect(b.said.slice(from).some((m) => /^test goto .+ 1\/2: died/.test(m))).toBe(true);
  }, 300_000);
});
