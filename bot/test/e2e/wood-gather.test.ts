// e2e (tag @bds) for PLAN.md task 4.6: the GatherWood task started from the CLI
//   node src/index.ts --task gather --target-logs 64 --chest x,y,z --exit-when-done
// puts 64 logs into the chest of the `gather-forest` layout (24 trees, wood-worlds.ts) in under
// 15 minutes, unattended. An observer bot builds the forest, teleports the CLI bot into it, then
// steps aside; the chest is read with truth:container every 5 s.
// Prints the time to 64 logs, logs/hour, corrections, trips and failures from the CLI's own report.
// WOOD_GATHER_TARGET overrides 64 (shorter runs while debugging); WOOD_VERBOSE=1 streams the CLI log.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { E2E_VERSION } from './env.ts';
import {
  E2E,
  WoodArea,
  buildLayout,
  connectWoodBot,
  logCount,
  prepareServer,
  sleep,
  startGatherCli,
  waitOnline,
  type GatherCli,
  type TruthContainer,
  type WoodBot,
} from './wood-truth.ts';
import { FEET_Y, gatherForest, totalLogs, treeLogs } from './wood-worlds.ts';

const TARGET = Number(process.env.WOOD_GATHER_TARGET ?? 64);
const LIMIT_MS = 15 * 60_000;

describe.skipIf(!E2E)('@bds wood: GatherWood from the CLI (4.6)', () => {
  let obs: WoodBot;
  let cli: GatherCli | undefined;
  const area = new WoodArea();
  const layout = gatherForest(area.x0, area.z0, area.cell + 1);
  const chest = layout.chest!;
  const notes: string[] = [];

  beforeAll(async () => {
    await prepareServer();
    obs = await connectWoodBot('GObs');
    await obs.teleport(layout.start);
    await buildLayout(obs.truth, layout);
    notes.push(`forest: ${layout.trees.length} trees, ${totalLogs(layout.trees)} logs, chest at ${chest.x} ${chest.y} ${chest.z} (area cell ${area.cell})`);
  }, 180_000);

  afterAll(async () => {
    cli?.kill();
    process.stdout.write(`[wood-gather e2e] BDS ${E2E_VERSION}, target ${TARGET}\n  ${notes.join('\n  ')}\n`);
    await obs?.close();
  });

  it(`puts ${TARGET} logs into the chest in under 15 min, unattended`, async () => {
    cli = startGatherCli(['--target-logs', String(TARGET), '--chest', `${chest.x},${chest.y},${chest.z}`, '--exit-when-done', '--duration', String(LIMIT_MS / 1000 + 60)]);
    const c = cli;
    await waitOnline(obs.truth, c.name);
    // into the forest, next to the chest; the observer steps out of the way (still keeps the area loaded)
    await obs.truth.ok('tp', [c.name, layout.start.x, layout.start.y, layout.start.z, 0, 0]);
    await obs.teleport({ x: area.x0 + 0.5, y: FEET_Y, z: area.z0 + 30.5 });
    let reachedAt: number | undefined;
    let last = 0;
    let lastPrint = 0;
    let code: number | null | undefined;
    void c.exit.then((x) => (code = x));
    while (performance.now() - c.startedAt < LIMIT_MS + 30_000) {
      const t = await obs.truth.cmd('container', [chest.x, chest.y, chest.z]);
      if (t.ok) {
        last = logCount((t.data as TruthContainer).counts);
        if (last >= TARGET && reachedAt === undefined) reachedAt = performance.now();
      }
      const el = performance.now() - c.startedAt;
      if (el - lastPrint > 60_000) {
        lastPrint = el;
        notes.push(`  ${(el / 1000).toFixed(0)} s: ${last} logs in the chest`);
      }
      if (code !== undefined || reachedAt !== undefined) break;
      await sleep(5_000);
    }
    const exitCode = await Promise.race([c.exit, sleep(20_000).then(() => 'still running' as const)]);
    const out = c.output();
    const report = out.split('\n').filter((l) => / gather: (done|failed|stopped) after /.test(l) || /gather: tree at|goto chest|open chest|deposit:|paused|resumed/.test(l));
    const ms = reachedAt !== undefined ? reachedAt - c.startedAt : undefined;
    const logsAtEnd = logCount((await obs.truth.ok<TruthContainer>('container', [chest.x, chest.y, chest.z])).counts);
    // floating logs: any log left in the forest whose tree was touched is reported (not asserted)
    notes.push(
      `result: ${logsAtEnd} logs in the chest; time to ${TARGET}: ${ms !== undefined ? `${(ms / 1000).toFixed(1)} s (${((TARGET / ms) * 3_600_000).toFixed(0)} logs/h)` : 'not reached'}; CLI exit ${String(exitCode)}`,
      ...report.slice(-12).map((l) => `  cli: ${l.trim()}`),
    );
    const corr = /(\d+) corrections, (\d+) deaths/.exec(out);
    if (corr) notes.push(`corrections ${corr[1]}, deaths ${corr[2]}`);
    expect(ms, `chest has ${logsAtEnd} logs; CLI tail:\n${out.split('\n').slice(-40).join('\n')}`).toBeDefined();
    expect(ms!).toBeLessThan(LIMIT_MS);
    expect(logsAtEnd).toBeGreaterThanOrEqual(TARGET);
    expect(exitCode).toBe(0);
    // nothing but logs was dug: every tree that lost logs lost them bottom up (no log left floating
    // below base + 6 of a tree whose base log is gone)
    for (const t of layout.trees) {
      const logs = treeLogs(t);
      const truth = await obs.truth.cmd('find', [t.x, FEET_Y, t.z, t.x, FEET_Y + 5, t.z, '_log']);
      if (!truth.ok) continue;
      const left = (truth.data as { count: number }).count;
      if (left > 0 && left < logs.length) {
        const base = await obs.truth.ok<{ typeId: string }>('block', [t.x, FEET_Y, t.z]);
        expect(base.typeId, `tree (${t.x}, ${t.z}) lost its base but kept ${left} logs`).toMatch(/_log$/);
      }
    }
  }, LIMIT_MS + 240_000);
});
