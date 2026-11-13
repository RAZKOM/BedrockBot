// Track R4 (docs/pathfinding.md "A fall closed for a moment (Track R4)"; decisions/0072-reachability.md "R4") on bds-pve:
// a goto whose only way is a small fall that hurts, with a hostile near. A tower of planks 5 high (4 x 4: the dig way
// never digs a built block) on a grass floor; the bot on its top, the goal on the floor 10 blocks from its edge; night.
//   gone      a zombie on the floor 8 blocks out, taken away (struck down elsewhere, or gone) 2 to 10 s into the walk:
//             the goto holds (no fall that hurts with a hostile within 16), plans again once it is gone and arrives,
//             the fall its only damage
//   before    the same with Navigator.fallHoldTicks 0 (no hold, the behaviour before R4): unreachable at once
//   floor     a zombie on the floor 8 blocks out, which cannot climb to the bot: the goto holds FALL_HOLD_TICKS and
//             reports unreachable with what it waited for (hostileFallHp off, the default)
//   cap       the same with hostileFallHp 2: the 2 HP fall is taken with the zombie there, no hold
// R4_RUNS runs a case (default 5), R4_CASES a comma list (default all), R4_OUT a JSONL of the rows. The bot: an iron sword,
// no armour (a 5-block fall costs 2 HP). Needs BDS_E2E=1 and bds-pve with the truth pack.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FALL_HOLD_TICKS } from '../../src/skills/nav/navigator.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { armWithIronSword, botDamage, centre, E2E, FEET_Y, fill, prepareServer, privateArea, sleep, startPveBot, teleport, tracked, type PveBot } from './pve-truth.ts';

const RUNS = Number(process.env.R4_RUNS ?? 5);
const CASES = (process.env.R4_CASES ?? 'before,gone,floor,cap').split(',').map((s) => s.trim());
const OUT = process.env.R4_OUT;

function note(row: Record<string, unknown>): void {
  console.log(JSON.stringify(row));
  if (OUT) appendFileSync(OUT, `${JSON.stringify(row)}\n`);
}

describe.skipIf(!E2E)('nav: Track R4 a fall closed while a hostile is near', () => {
  let bot: PveBot | undefined;
  const area = privateArea();
  let spot = 0;

  /** A fresh tower: the bot on its top centre, returns the tower's corner and the goal. */
  async function tower(b: PveBot): Promise<{ x0: number; z0: number; goal: Vec3 }> {
    const i = spot++;
    const x0 = area.x + 200 + 40 * i;
    const z0 = area.z + 200;
    await teleport(b, centre({ x: x0 + 1, y: FEET_Y + 5, z: z0 + 1 }));
    await fill(b, { x: x0 - 16, y: FEET_Y - 1, z: z0 - 16 }, { x: x0 + 24, y: FEET_Y - 1, z: z0 + 16 }, 'grass_block');
    await fill(b, { x: x0 - 16, y: FEET_Y, z: z0 - 16 }, { x: x0 + 24, y: FEET_Y + 8, z: z0 + 16 }, 'air');
    await fill(b, { x: x0, y: FEET_Y, z: z0 }, { x: x0 + 3, y: FEET_Y + 4, z: z0 + 3 }, 'oak_planks');
    await teleport(b, centre({ x: x0 + 1, y: FEET_Y + 5, z: z0 + 1 }));
    await b.truth.clearAround(centre({ x: x0, y: FEET_Y, z: z0 }), 64);
    await b.truth.setHealth(b.name, 20);
    await b.truth.ok('setfood', [b.name, 20, 5]);
    await sleep(500);
    return { x0, z0, goal: { x: x0 + 13, y: FEET_Y, z: z0 + 1 } };
  }

  beforeAll(async () => {
    await prepareServer({ time: 'midnight' });
    bot = await startPveBot('R4Fall');
    await armWithIronSword(bot);
    await bot.truth.ok('give', [bot.name, 'bread', 16]);
    expect(bot.pve.settings.get('mobReflex')).toBe(true);
    expect(bot.pve.settings.get('longFalls')).toBe(true);
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      bot.pve.stop();
      await bot.truth.cleanup().catch(() => undefined);
      await bot.stop();
    }
  });

  async function run(kind: string, k: number): Promise<{ ok: boolean; reason?: string; note?: string; s: number; held: number; fall: number; mob: number; died: boolean }> {
    const b = bot!;
    b.pve.settings.set('hostileFallHp', kind === 'cap' ? 2 : 0);
    b.built.mobility!.skills.nav.fallHoldTicks = kind === 'before' ? 0 : FALL_HOLD_TICKS; // 'before': no hold, as before R4
    const { x0, z0, goal } = await tower(b);
    const deaths0 = b.built.respawn!.deaths;
    const since = await b.truth.now();
    const m = await b.truth.summon('zombie', { x: x0 + 1.5, y: FEET_Y, z: z0 + 12.5 });
    await tracked(b, m);
    const t0 = Date.now();
    const gone = kind === 'gone' ? 2 + 2 * (k % 5) : undefined;
    const timer = gone !== undefined ? setTimeout(() => void b.truth.cleanup().catch(() => undefined), gone * 1000) : undefined;
    const r = await b.pve.walk({ type: 'block', p: goal }, { explain: true }, 'r4 walk');
    const s = (Date.now() - t0) / 1000;
    if (timer) clearTimeout(timer);
    await sleep(500);
    const dmg = botDamage((await b.truth.hurtlog(since, b.name)).events, b.name);
    const held = b.built.mobility!.skills.nav.lastReport?.held ?? 0;
    const row = { case: kind, run: k, ...(gone !== undefined ? { goneS: gone } : {}), ok: r.ok, ...(r.ok ? {} : { reason: r.reason, note: r.note }), s: +s.toFixed(1), held, fall: dmg.byCause.fall ?? 0, mob: dmg.total - (dmg.byCause.fall ?? 0), died: b.built.respawn!.deaths !== deaths0, health: b.pve.health() };
    note(row);
    await b.truth.cleanup();
    return row;
  }

  for (const kind of ['before', 'gone', 'floor', 'cap']) {
    it.skipIf(!CASES.includes(kind))(`${kind}: ${RUNS} runs`, async () => {
      for (let k = 0; k < RUNS; k++) {
        const r = await run(kind, k);
        expect(r.died).toBe(false);
        if (kind === 'before') {
          expect(r.ok).toBe(false);
          expect(r.note).toMatch(/^rule falls: a 5-block fall \(2 HP\), no fall that hurts now: a hostile \d+ blocks away/);
          expect(r.held).toBe(0);
        } else if (kind === 'gone') {
          expect(r.ok, r.note).toBe(true);
          expect(r.fall).toBeLessThanOrEqual(2);
        } else if (kind === 'floor') {
          expect(r.ok).toBe(false);
          expect(r.note).toMatch(/no fall that hurts now: a hostile \d+ blocks away; held 30 s/);
          expect(r.held).toBeGreaterThanOrEqual(FALL_HOLD_TICKS);
        } else {
          expect(r.ok, r.note).toBe(true);
          expect(r.held).toBe(0);
          expect(r.fall).toBeLessThanOrEqual(2);
        }
      }
    }, RUNS * 120_000);
  }
});
