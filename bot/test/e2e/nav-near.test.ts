// Track R8 (docs/pathfinding.md "A `!goto` that stands as near as it gets (Track R8)"; decisions/0072-reachability.md
// "R8") on bds-pve: a `!goto` (GotoOptions.beside) whose goal's cell no walk gets into, 15 blocks off.
//   portal-*  the goal's cell is the lower cell of a lit nether portal, its frame's bottom row flush with the grass
//   pit-*     the goal's cell is open air where the ground was, over a pit 11 wide and 12 deep dug round it with one
//             post left standing in it, its top 3 under the cell (R7's `in the air` end: the node on the post)
//   *-live    allowBreak on (the live settings' digging; the default settings dig nothing)
//   *-before  Navigator.nearEnds off: the answer as before Track R8
// Per run: the reply, the ticks of the walk, `still` (the ticks from the body's last move to the answer), the end's
// distance from the goal's cell floor centre, the damage. R8_RUNS runs a case (default 10), R8_CASES a comma list,
// R8_OUT a JSONL of the rows. Needs BDS_E2E=1 and bds-pve with the truth pack (PVE_BDS_PORT / PVE_BDS_CONTAINER for
// another server with the pack: bds-core).
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/world/types.ts';
import { botDamage, centre, E2E, FEET_Y, fill, prepareServer, privateArea, pveCmd, sleep, startPveBot, teleport, type PveBot } from './pve-truth.ts';

const RUNS = Number(process.env.R8_RUNS ?? 10);
const ALL = ['portal', 'portal-live', 'pit', 'pit-live'].flatMap((k) => [`${k}-before`, k]);
const CASES = (process.env.R8_CASES ?? ALL.join(',')).split(',').map((s) => s.trim());
const OUT = process.env.R8_OUT;
/** The feet level on the sites: a platform of stone 14 over the flat world's grass, room for the pit under it. */
const F = FEET_Y + 14;

function note(row: Record<string, unknown>): void {
  console.log(JSON.stringify(row));
  if (OUT) appendFileSync(OUT, `${JSON.stringify(row)}\n`);
}

describe.skipIf(!E2E)('nav: Track R8 a !goto that stands as near as it gets', () => {
  let bot: PveBot | undefined;
  const area = privateArea();
  let next = 0;

  beforeAll(async () => {
    await prepareServer({ time: 'noon' });
    bot = await startPveBot('R8Near');
    await bot.truth.ok('clear', [bot.name]);
    await bot.truth.ok('give', [bot.name, 'bread', 16]);
    await bot.truth.ok('give', [bot.name, 'iron_pickaxe', 1]);
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      bot.pve.stop();
      bot.built.mobility!.skills.nav.nearEnds = true;
      await bot.truth.cleanup().catch(() => undefined);
      await bot.stop();
    }
  });

  /** A fresh site: grass at F - 1 over stone, air over it; the case's shape round (x0, z0); the goal's cell. */
  async function site(b: PveBot, shape: 'portal' | 'pit'): Promise<{ x0: number; z0: number; goal: Vec3 }> {
    const i = next++;
    const x0 = area.x + 40 * (i % 6) - 100;
    const z0 = area.z + 40 * Math.floor(i / 6) - 100;
    await teleport(b, centre({ x: x0 + 15, y: FEET_Y, z: z0 + 16 })); // beside the site, off the cells the fill fills
    await fill(b, { x: x0 - 10, y: FEET_Y - 1, z: z0 - 10 }, { x: x0 + 28, y: F - 2, z: z0 + 10 }, 'stone');
    await fill(b, { x: x0 - 10, y: F - 1, z: z0 - 10 }, { x: x0 + 28, y: F - 1, z: z0 + 10 }, 'grass_block');
    await fill(b, { x: x0 - 10, y: F, z: z0 - 10 }, { x: x0 + 28, y: F + 8, z: z0 + 10 }, 'air');
    if (shape === 'portal') {
      // the frame along x: obsidian x0-1 .. x0+2, F-1 .. F+3; the portal x0 .. x0+1, F .. F+2
      await fill(b, { x: x0 - 1, y: F - 1, z: z0 }, { x: x0 + 2, y: F + 3, z: z0 }, 'obsidian');
      await pveCmd('fill', `${x0}`, `${F}`, `${z0}`, `${x0 + 1}`, `${F + 2}`, `${z0}`, 'portal', '["portal_axis"="x"]');
    } else {
      // the pit: x0-5 .. x0+5, its stone floor at F-13; the post x0, z0 up to F-4 (feet on it F-3)
      await fill(b, { x: x0 - 5, y: F - 12, z: z0 - 5 }, { x: x0 + 5, y: F - 1, z: z0 + 5 }, 'air');
      await fill(b, { x: x0, y: F - 12, z: z0 }, { x: x0, y: F - 4, z: z0 }, 'stone');
    }
    await sleep(300);
    await b.truth.clearAround({ x: x0, y: F, z: z0 }, 48);
    await b.truth.setHealth(b.name, 20);
    await b.truth.ok('setfood', [b.name, 20, 5]);
    return { x0, z0, goal: { x: x0, y: F, z: z0 } };
  }

  for (const kase of ALL) {
    it.skipIf(!CASES.includes(kase))(`${kase}: ${RUNS} runs`, async () => {
      const b = bot!;
      const nav = b.built.mobility!.skills.nav;
      const before = kase.endsWith('-before');
      const live = kase.includes('-live');
      const shape = kase.startsWith('portal') ? 'portal' : 'pit';
      for (let k = 0; k < RUNS; k++) {
        nav.nearEnds = !before;
        const { x0, z0, goal } = await site(b, shape);
        const j = RUNS > 1 ? -0.08 + (0.16 * k) / (RUNS - 1) : 0;
        await teleport(b, { x: x0 + 15.5, y: F, z: z0 + 0.5 + j });
        const loop = b.built.mobility!.loop;
        const deaths0 = b.built.respawn!.deaths;
        const since = await b.truth.now();
        let ticks = 0;
        let moved = 0;
        let last = loop.state.pos;
        const off = loop.onBeforeStep((_t, s) => {
          ticks++;
          if (Math.hypot(s.pos.x - last.x, s.pos.y - last.y, s.pos.z - last.z) > 0.01) moved = ticks;
          last = { ...s.pos };
        });
        const t0 = Date.now();
        const r = await b.pve.walk({ type: 'block', p: goal }, { explain: true, beside: true, ...(live ? { allowBreak: true } : {}) }, 'r8 walk');
        const s = (Date.now() - t0) / 1000;
        off();
        await sleep(500);
        const dmg = botDamage((await b.truth.hurtlog(since, b.name)).events, b.name);
        const rep = nav.lastReport;
        const end = b.task.position()!;
        const row = {
          case: kase,
          run: k,
          ok: r.ok,
          ...(r.note ? { note: r.note } : {}),
          ...(r.ok ? {} : { reason: r.reason }),
          s: +s.toFixed(1),
          ticks: rep?.ticks ?? 0,
          still: ticks - moved,
          ...(rep?.nearTicks !== undefined ? { near: rep.nearTicks } : {}),
          plans: rep?.plans.length ?? 0,
          failures: rep?.failures ?? 0,
          ...(rep?.beside ? { beside: `${rep.beside.kind} ${rep.beside.dist ?? ''}` } : {}),
          ...(rep?.short ? { short: `${rep.short.dist} eye ${rep.short.eye}${rep.short.within ? ' within' : ''}` } : {}),
          end: `${(end.x - x0).toFixed(2)},${(end.y - F).toFixed(3)},${(end.z - z0).toFixed(2)}`,
          fromGoal: +Math.hypot(end.x - (goal.x + 0.5), end.y - goal.y, end.z - (goal.z + 0.5)).toFixed(2),
          damage: dmg.total,
          died: b.built.respawn!.deaths !== deaths0,
        };
        note(row);
        expect(row.died).toBe(false);
        expect(row.damage).toBe(0);
        if (before) {
          expect(r.ok).toBe(false);
          continue;
        }
        if (shape === 'portal') {
          expect(r.ok, String(r.note ?? row.reason)).toBe(true);
          expect(r.note ?? '').toMatch(/\(portal\) cannot be stood on \(portal: a cell the walk never enters\)/);
        } else {
          expect(r.ok, String(r.note ?? row.reason)).toBe(false);
          expect(row.reason).toBe('stopped short');
          expect(r.note ?? '').toMatch(/blocks from the goal's cell .* \(air, 3 over the floor\): the rest needs a block placed/);
        }
        expect(row.fromGoal).toBeLessThanOrEqual(8);
      }
      nav.nearEnds = true;
    }, RUNS * 180_000);
  }
});
