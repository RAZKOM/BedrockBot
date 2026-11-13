// Track R5 (docs/pathfinding.md "A walk starts from wherever the body stands (Track R5)"; decisions/0072-reachability.md
// "R5") on bds-pve: a walk that begins with the body on a fence's top. A spruce fence line along z on the grass (the
// server joins it north and south), the goal on the grass 20 blocks off; noon, no mobs.
//   before   the Realm's spot on a post with Navigator.perch off and no settling wait (the behaviour before R5):
//            no standable node three times, unreachable with no plan
//   post     on a post's centre               rail   on the rail between two posts
//   realm    the Realm's spot (0.46, 0.30 in the post's block)   edge   0.01 over the post's side   end   the line's end
//   landing  teleported 1 block over a post and the walk asked at once (the body is still falling onto it)
//   stair    the fence on a wall of planks 4 high, a stair of planks down beside it: the stair, no damage
//   drop     the same wall with no stair: the 5.5-block drop under the fall rules, its damage only
// R5_RUNS runs a case (default 10), R5_CASES a comma list (default all), R5_OUT a JSONL of the rows. Needs BDS_E2E=1 and
// bds-pve with the truth pack.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SETTLE_TICKS } from '../../src/skills/nav/navigator.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { botDamage, centre, E2E, FEET_Y, fill, hdist, prepareServer, privateArea, pveCmd, sleep, startPveBot, teleport, type PveBot } from './pve-truth.ts';

const RUNS = Number(process.env.R5_RUNS ?? 10);
const CASES = (process.env.R5_CASES ?? 'before,post,rail,realm,edge,end,landing,stair,drop').split(',').map((s) => s.trim());
const OUT = process.env.R5_OUT;

function note(row: Record<string, unknown>): void {
  console.log(JSON.stringify(row));
  if (OUT) appendFileSync(OUT, `${JSON.stringify(row)}\n`);
}

/** Where on the post block (x, z fractions) each case puts the body, run k of n (a small spread along the line). */
function spot(kind: string, k: number, n: number): { fx: number; fz: number } {
  const j = n > 1 ? -0.08 + (0.16 * k) / (n - 1) : 0;
  switch (kind) {
    case 'rail':
      return { fx: 0.5 + j, fz: 1.0 };
    case 'realm':
      return { fx: 0.46, fz: 0.3 + j };
    case 'edge':
      return { fx: 0.915 - 0.1 * (k / Math.max(1, n - 1)), fz: 0.5 + j };
    default:
      return { fx: 0.5 + j, fz: 0.5 };
  }
}

describe.skipIf(!E2E)('nav: Track R5 a walk that starts on a fence top', () => {
  let bot: PveBot | undefined;
  const area = privateArea();
  let next = 0;

  /** A fresh site: grass, air over it, the fence line (on a wall of planks `wall` high), the goal 20 blocks off. */
  async function site(b: PveBot, wall: number, stair: boolean): Promise<{ x0: number; z0: number; top: number; goal: Vec3 }> {
    const i = next++;
    const x0 = area.x + 40 * (i % 6) - 100;
    const z0 = area.z + 40 * Math.floor(i / 6) - 100;
    await teleport(b, centre({ x: x0 - 3, y: FEET_Y, z: z0 }));
    await fill(b, { x: x0 - 8, y: FEET_Y - 1, z: z0 - 8 }, { x: x0 + 24, y: FEET_Y - 1, z: z0 + 12 }, 'grass_block');
    await fill(b, { x: x0 - 8, y: FEET_Y, z: z0 - 8 }, { x: x0 + 24, y: FEET_Y + 8, z: z0 + 12 }, 'air');
    if (wall > 0) await fill(b, { x: x0, y: FEET_Y, z: z0 - 4 }, { x: x0, y: FEET_Y + wall - 1, z: z0 + 4 }, 'oak_planks');
    // the fence by the console's fill (the server joins the posts, as a player's placing does)
    await pveCmd('fill', `${x0}`, `${FEET_Y + wall}`, `${z0 - 4}`, `${x0}`, `${FEET_Y + wall}`, `${z0 + 4}`, 'spruce_fence');
    if (stair) for (let k = 0; k < wall; k++) await fill(b, { x: x0 + 1 + k, y: FEET_Y, z: z0 }, { x: x0 + 1 + k, y: FEET_Y + wall - 1 - k, z: z0 }, 'oak_planks');
    await sleep(300);
    await b.truth.clearAround({ x: x0, y: FEET_Y, z: z0 }, 48);
    await b.truth.setHealth(b.name, 20);
    await b.truth.ok('setfood', [b.name, 20, 5]);
    return { x0, z0, top: FEET_Y + wall + 1.5, goal: { x: x0 + 20, y: FEET_Y, z: z0 } };
  }

  beforeAll(async () => {
    await prepareServer({ time: 'noon' });
    bot = await startPveBot('R5Perch');
    await bot.truth.ok('clear', [bot.name]);
    await bot.truth.ok('give', [bot.name, 'bread', 16]);
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      bot.pve.stop();
      await bot.truth.cleanup().catch(() => undefined);
      await bot.stop();
    }
  });

  async function run(kind: string, k: number): Promise<Record<string, unknown> & { ok: boolean; plans: number; perch: number; fall: number; died: boolean; s: number }> {
    const b = bot!;
    const nav = b.built.mobility!.skills.nav;
    nav.perch = kind !== 'before';
    nav.settleTicks = kind === 'before' ? 0 : SETTLE_TICKS;
    const high = kind === 'stair' || kind === 'drop';
    const { x0, z0, top, goal } = await site(b, high ? 4 : 0, kind === 'stair');
    const { fx, fz } = spot(kind, k, RUNS);
    const zPost = kind === 'end' ? z0 + 4 : z0;
    const at = { x: x0 + fx, y: top, z: zPost + fz };
    const w = b.built.mobility!.world;
    const post = w.blockAt({ x: x0, y: Math.floor(top - 1.5), z: zPost });
    const states = post ? Object.entries(post.states).filter(([s]) => s.includes('connection')).map(([s, v]) => `${s.replace('minecraft:connection_', '')}=${String(v)}`).join(',') : 'unloaded';
    if (kind === 'landing') {
      // 1 over the post, and the walk at once: the body is in the air when the goto starts
      await b.truth.tp(b.name, { ...at, y: top + 1 }, 0, 0);
      const t1 = Date.now();
      while (Date.now() - t1 < 5000 && hdist(b.task.position() ?? at, at) > 0.05) await sleep(20);
    } else {
      await teleport(b, at);
    }
    const startPos = b.task.position()!;
    const startOnGround = b.built.mobility!.loop.state.onGround;
    const deaths0 = b.built.respawn!.deaths;
    const since = await b.truth.now();
    const t0 = Date.now();
    const r = await b.pve.walk({ type: 'block', p: goal }, { explain: true }, 'r5 walk');
    const s = (Date.now() - t0) / 1000;
    await sleep(500);
    const dmg = botDamage((await b.truth.hurtlog(since, b.name)).events, b.name);
    const rep = nav.lastReport;
    const end = b.task.position()!;
    const row = {
      case: kind,
      run: k,
      fence: states,
      start: `${(startPos.x - x0).toFixed(3)},${(startPos.y - FEET_Y).toFixed(3)},${(startPos.z - zPost).toFixed(3)}`,
      startOnGround,
      ok: r.ok,
      ...(r.ok ? {} : { reason: r.reason, note: r.note }),
      s: +s.toFixed(1),
      ticks: rep?.ticks ?? 0,
      plans: rep?.plans.length ?? 0,
      failures: rep?.failures ?? 0,
      perch: rep?.perchStarts ?? 0,
      settle: rep?.settleTicks ?? 0,
      fall: dmg.byCause.fall ?? 0,
      damage: dmg.total,
      endDist: +hdist(end, { x: goal.x + 0.5, z: goal.z + 0.5 }).toFixed(2),
      died: b.built.respawn!.deaths !== deaths0,
    };
    note(row);
    return row;
  }

  for (const kind of ['before', 'post', 'rail', 'realm', 'edge', 'end', 'landing', 'stair', 'drop']) {
    it.skipIf(!CASES.includes(kind))(`${kind}: ${RUNS} runs`, async () => {
      for (let k = 0; k < RUNS; k++) {
        const r = await run(kind, k);
        expect(r.died).toBe(false);
        if (kind === 'before') {
          expect(r.ok).toBe(false);
          expect(r.plans).toBe(0);
        } else {
          expect(r.ok, String(r.note ?? r.reason)).toBe(true);
          expect(r.perch).toBeGreaterThanOrEqual(1);
          if (kind === 'drop') expect(r.fall).toBeLessThanOrEqual(3);
          else expect(r.damage).toBe(0);
        }
      }
    }, RUNS * 120_000);
  }
});
