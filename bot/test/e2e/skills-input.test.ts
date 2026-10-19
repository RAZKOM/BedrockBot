// e2e (tag @bds) for the input loop (PLAN.md task 3.1) against the physics BDS: container bds-phys on
// udp/19144 (flat world, truth pack deployed, see docs/movement.md). Runs only with BDS_E2E=1:
//   BDS_E2E=1 pnpm --filter bot test:e2e
// Override the target with PHYS_BDS_HOST / PHYS_BDS_PORT / PHYS_BDS_CONTAINER.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Connection } from '../../src/connection/connection.ts';
import type { ConnectTarget, Vec3 } from '../../src/connection/types.ts';
import { createLogger, silentLogger } from '../../src/log.ts';
import { InputLoop, flatWorld, type CorrectionEvent } from '../../src/skills/input/index.ts';
import { Truth, consoleCommand } from './skills-truth.ts';

const E2E = process.env.BDS_E2E === '1';
const HOST = process.env.PHYS_BDS_HOST ?? '127.0.0.1';
const PORT = Number(process.env.PHYS_BDS_PORT ?? 19144);
const CONTAINER = process.env.PHYS_BDS_CONTAINER ?? 'bds-phys';
const TARGET: ConnectTarget = { kind: 'bds', host: HOST, port: PORT, transport: 'raknet', offline: true };
const NAME = 'InputE2E';
/** Flat world: grass top at y = -61, feet at -60. */
const FEET_Y = -60;

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const fmt = (v: Vec3): string => `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`;

describe.skipIf(!E2E)('@bds input loop against bds-phys', () => {
  let conn: Connection;
  let loop: InputLoop;
  let truth: Truth;
  const corrections: CorrectionEvent[] = [];
  const summary: string[] = [];

  /** Teleport to `feet` facing `yaw`, wait until the loop has adopted it and settled. */
  async function teleport(feet: Vec3, yaw = 0): Promise<void> {
    const seen = new Promise<void>((resolve) => {
      const off = loop.onEvent((e) => {
        if (e.kind === 'teleport' && dist(e.to, feet) < 0.01) {
          off();
          resolve();
        }
      });
    });
    await truth.tp(NAME, feet, yaw, 0);
    await seen;
    loop.setCommand({ yaw, pitch: 0 });
    await loop.waitTicks(20);
  }

  /** Runs `body` and returns the corrections that arrived during it plus 10 more ticks. */
  async function measure(label: string, body: () => Promise<void>): Promise<CorrectionEvent[]> {
    const before = corrections.length;
    await body();
    await loop.waitTicks(10);
    const got = corrections.slice(before);
    summary.push(
      `${label}: ${got.length} correction(s)` +
        got.map((c) => ` [tick ${c.tick}: local ${c.local ? fmt(c.local) : '?'} server ${fmt(c.server)} err ${c.error?.toFixed(4) ?? '?'}]`).join(''),
    );
    return got;
  }

  async function truthMatches(label: string, tolerance = 0.05): Promise<void> {
    const t = await truth.pos(NAME);
    const local = loop.state.pos;
    const d = dist(t.location, local);
    summary.push(`${label}: local ${fmt(local)} truth ${fmt(t.location)} diff ${d.toFixed(5)}`);
    expect(d, `${label}: local ${fmt(local)} vs truth ${fmt(t.location)}`).toBeLessThanOrEqual(tolerance);
  }

  beforeAll(async () => {
    // Mobs push and hit the player (server-side knockback = corrections): keep the test world peaceful and at noon.
    for (const c of [['difficulty', 'peaceful'], ['gamerule', 'domobspawning', 'false'], ['gamerule', 'dodaylightcycle', 'false'], ['time', 'set', 'noon']]) {
      await consoleCommand(CONTAINER, ...c);
    }
    // Reconnect only covers a quick rerun (server_id_conflict while the previous session still lingers).
    conn = new Connection({ version: '1.26.51', username: NAME, logger: silentLogger, reconnect: { enabled: true, maxAttempts: 4, baseMs: 2_000 } });
    loop = new InputLoop(conn, { world: flatWorld(), logger: process.env.PHYS_VERBOSE ? createLogger('info', 'input') : silentLogger });
    loop.onEvent((e) => {
      if (e.kind === 'correction') corrections.push(e);
    });
    truth = new Truth(conn, CONTAINER);
    loop.start();
    await conn.connect(TARGET);
    await loop.waitTicks(20);
    expect(loop.state.ready).toBe(true);
    await teleport({ x: 0.5, y: FEET_Y, z: 0.5 });
  });

  afterAll(() => {
    conn?.disconnect('test done');
    // The numbers for docs/decisions/0003-physics.md.
    console.log(`[skills-input e2e]\n  ${summary.join('\n  ')}`);
  });

  it('(a) idles 60 ticks with zero corrections and an unchanged truth position', async () => {
    const t0 = await truth.pos(NAME);
    const got = await measure('idle 60', () => loop.waitTicks(60));
    expect(got).toHaveLength(0);
    const t1 = await truth.pos(NAME);
    expect(dist(t0.location, t1.location)).toBeLessThan(1e-3);
    expect(t1.isOnGround).toBe(true);
    await truthMatches('idle 60');
  });

  it('spike C: a 6-tick walk is accepted without corrections', async () => {
    await teleport({ x: 4.5, y: FEET_Y, z: 0.5 });
    const got = await measure('walk 6', async () => {
      loop.setCommand({ forward: 1 });
      await loop.waitTicks(6);
      loop.release();
      await loop.waitTicks(20);
    });
    expect(got).toHaveLength(0);
    await truthMatches('walk 6');
  });

  it('(b) walks forward 100 ticks, coasts 20: zero corrections, truth within 0.05', async () => {
    await teleport({ x: 0.5, y: FEET_Y, z: -10.5 });
    const start = loop.state.pos;
    const got = await measure('walk 100 + coast 20', async () => {
      loop.setCommand({ forward: 1 });
      await loop.waitTicks(100);
      loop.release();
      await loop.waitTicks(20);
    });
    expect(got).toHaveLength(0);
    expect(loop.state.pos.z - start.z).toBeGreaterThan(20); // ~0.2159 blocks/tick
    await truthMatches('walk 100 + coast 20');
  });

  it('(c) turns to yaw 90 and walks 50 ticks: zero corrections, truth within 0.05', async () => {
    await teleport({ x: 10.5, y: FEET_Y, z: 0.5 });
    const start = loop.state.pos;
    const got = await measure('yaw 90 walk 50 + coast 20', async () => {
      loop.setCommand({ yaw: 90 });
      await loop.waitTicks(2);
      loop.setCommand({ forward: 1 });
      await loop.waitTicks(50);
      loop.release();
      await loop.waitTicks(20);
    });
    expect(got).toHaveLength(0);
    // yaw 90 faces -x
    expect(start.x - loop.state.pos.x).toBeGreaterThan(9);
    expect(Math.abs(loop.state.pos.z - start.z)).toBeLessThan(1e-3);
    await truthMatches('yaw 90 walk 50 + coast 20');
  });

  it('(d) a 3-block position jump without inputs is corrected exactly once and snaps back', async () => {
    await teleport({ x: 0.5, y: FEET_Y, z: 0.5 });
    const before = loop.state.pos;
    const got = await measure('nudge +3 z', async () => {
      loop.nudge({ x: 0, y: 0, z: 3 });
      await loop.waitTicks(40);
    });
    expect(got).toHaveLength(1);
    expect(got[0]!.error).toBeCloseTo(3, 2);
    expect(dist(loop.state.pos, before)).toBeLessThan(0.01);
    await truthMatches('nudge +3 z');
  });

  it('(e) jumps in place: at most 1 correction, back on the ground within 20 ticks', async () => {
    await teleport({ x: -4.5, y: FEET_Y, z: 0.5 });
    let peak = -Infinity;
    const off = conn.onTick(() => {
      peak = Math.max(peak, loop.state.pos.y);
    });
    let onGroundAfter: boolean | undefined;
    const got = await measure('jump in place', async () => {
      // a key tap: jump held 3 ticks (the jump happens on the first; the 10-tick cooldown stops a second one)
      loop.setCommand({ jump: true });
      await loop.waitTicks(3);
      loop.release();
      await loop.waitTicks(17);
      onGroundAfter = (await truth.pos(NAME)).isOnGround;
    });
    off();
    summary.push(`jump in place: local peak ${(peak - FEET_Y).toFixed(4)} blocks`);
    expect(got.length).toBeLessThanOrEqual(1);
    expect(peak - FEET_Y).toBeGreaterThan(1.2); // vanilla jump apex ~1.25
    expect(onGroundAfter).toBe(true);
    expect(loop.state.onGround).toBe(true);
    await truthMatches('jump in place');
  });
});
