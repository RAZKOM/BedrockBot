// e2e (tag @bds) for PLAN.md task 6.2: the RL bridge end to end from Node (the Python equivalent is
// rl/scripts/contract_test.py). Needs bds-rl (udp/19156, truth pack) and BDS_E2E=1:
//   BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e rl-bridge
// Starts the RL task in process (bridge on a free loopback port), connects with Node's WebSocket,
// resets, and drives 100 seeded-random v1 steps; every reply must be an `obs` that passes the zod
// schema. Prints steps/s, ticks per action, corrections and the reward distribution, and checks the
// bot's log count against truth:inv.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACTIONS_V1, ObsMsg, type ObsMessage } from '../../src/bridge/schema.ts';
import { rng } from './world-truth.ts';
import { BridgeClient, E2E, connectRlBot, runOrigin, type RlBot } from './rl-truth.ts';

/** Asymmetric matchers typed for object literals (they are `any` otherwise). */
const has = (s: string): string => {
  const m: unknown = expect.stringContaining(s);
  return m as string;
};

const STEPS = Number(process.env.RL_STEPS ?? 100);

describe.skipIf(!E2E)('@bds RL bridge against bds-rl (6.2)', () => {
  let bot: RlBot;
  let client: BridgeClient;
  const origin = runOrigin();

  beforeAll(async () => {
    bot = await connectRlBot('RlBridge', { origin });
    client = new BridgeClient(`ws://127.0.0.1:${bot.port}`);
    await client.open();
  }, 90_000);

  afterAll(async () => {
    client?.close();
    await bot?.close();
  });

  it('hello, reset, 100 random steps without a schema error', async () => {
    const hello = await client.hello;
    expect(hello).toMatchObject({ t: 'hello', protocol: 1, actions: [...ACTIONS_V1] });

    const parse = (m: unknown, what: string): ObsMessage => {
      const r = ObsMsg.safeParse(m);
      expect(r.success, `${what}: ${JSON.stringify(m).slice(0, 400)} ${r.success ? '' : JSON.stringify(r.error.issues)}`).toBe(true);
      return r.data!;
    };
    const t0 = performance.now();
    const first = parse(await client.request({ t: 'reset', scenario: 'forest_small', seed: 5 }), 'reset');
    const resetMs = performance.now() - t0;
    expect(first.obs.inventory).toEqual({ stone_axe: 1 });
    expect(first.obs.self.on_ground).toBe(true);
    expect(first.done).toBe(false);
    const resetInfo = first.info.reset as { checksum: string; start: { x: number; y: number; z: number } };
    expect(first.obs.self.pos[0]).toBeCloseTo(resetInfo.start.x, 2);
    expect(first.obs.self.pos[2]).toBeCloseTo(resetInfo.start.z, 2);

    const r = rng(1234);
    const ticks: number[] = [];
    const byKind = new Map<string, number[]>();
    const fails = new Map<string, number>();
    const rewards = new Map<number, number>();
    let corrections = 0;
    let logsPaid = 0;
    let resets = 1;
    let stepMs = 0;
    for (let i = 0; i < STEPS; i++) {
      const kind = ACTIONS_V1[Math.floor(r() * ACTIONS_V1.length)]!;
      const ts = performance.now();
      const m = parse(await client.request({ t: 'step', action: { kind } }), `step ${i} ${kind}`);
      stepMs += performance.now() - ts;
      expect(m.obs.last_skill.action).toBe(kind);
      ticks.push(m.reward_signals.ticks_used);
      byKind.set(kind, [...(byKind.get(kind) ?? []), m.reward_signals.ticks_used]);
      if (!m.obs.last_skill.ok) fails.set(`${kind}:${m.obs.last_skill.reason ?? '?'}`, (fails.get(`${kind}:${m.obs.last_skill.reason ?? '?'}`) ?? 0) + 1);
      corrections += m.info.corrections;
      logsPaid += m.reward_signals.logs_delta;
      rewards.set(m.reward_signals.logs_delta, (rewards.get(m.reward_signals.logs_delta) ?? 0) + 1);
      expect(m.reward_signals.ticks_used).toBeLessThanOrEqual(105);
      if (m.done) {
        parse(await client.request({ t: 'reset', scenario: 'forest_small', seed: 5 + resets }), 'reset');
        resets++;
        logsPaid = 0;
      }
    }
    // The paid logs equal the logs in the bot's inventory model, which equals truth:inv.
    const inv = await bot.truth.ok<{ counts: Record<string, number> }>('inv', [bot.name]);
    const truthLogs = Object.entries(inv.counts)
      .filter(([k]) => k.endsWith('_log'))
      .reduce((a, [, v]) => a + v, 0);
    expect(truthLogs).toBe(logsPaid);

    const mean = ticks.reduce((a, b) => a + b, 0) / ticks.length;
    const report = {
      steps: STEPS,
      resets,
      reset_ms: Math.round(resetMs),
      steps_per_s: +(STEPS / (stepMs / 1000)).toFixed(2),
      mean_ticks_per_action: +mean.toFixed(2),
      max_ticks_per_action: Math.max(...ticks),
      ticks_by_kind: Object.fromEntries([...byKind].map(([k, v]) => [k, { n: v.length, mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1), max: Math.max(...v) }])),
      corrections,
      logs_delta_histogram: Object.fromEntries([...rewards].sort((a, b) => a[0] - b[0])),
      skill_failures: Object.fromEntries(fails),
      truth_logs: truthLogs,
    };
    process.stdout.write(`[rl-bridge e2e] ${JSON.stringify(report, null, 2)}\n`);
    expect(bot.task.bridge.schemaErrors).toBe(0);
  }, 300_000);

  it('protocol errors are answered, a second client is refused, close ends the session', async () => {
    const bad = await client.request({ t: 'step', action: { kind: 'fly' } });
    expect(bad).toMatchObject({ t: 'error', message: has('unknown action kind') });
    const other = new BridgeClient(`ws://127.0.0.1:${bot.port}`);
    expect(await other.hello).toMatchObject({ t: 'error', message: has('busy') });
    other.close();
    const closed = await client.request({ t: 'close' });
    expect(closed).toMatchObject({ t: 'closed' });
  }, 60_000);
});
