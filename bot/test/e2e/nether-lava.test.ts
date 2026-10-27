// e2e (tag @bds), wave 10 Track AT (docs/nether.md): Nether safety on bds-nether. One afk-task bot
// teleported (truth:dimtp) into closed netherrack arenas built in a random far area of the Nether at y 100:
//   lava    a lava lake (11 x 9, touching the north wall) between the bot and the goal, room to the
//           south: `!goto` across ends with 0 damage (truth:hurtlog), every cell of the plans 2 blocks
//           (Chebyshev, horizontally) off the lava, and the body centre more than 1.2 blocks from it
//           (a diagonal step around the lake's corner passes the corner of a cell 1 off it)
//   magma   a magma strip across the way with a 2-block gap at one end: `!goto` across never stands on
//           magma and takes 0 damage
//   fire    fire set in and around the bot's cell: the fire process (chat/commands-portal.ts) walks it
//           out to a cell clear of fire
// Env: NETHER_BDS_HOST / NETHER_BDS_PORT / NETHER_BDS_CONTAINER (nether-truth.ts), NETHER_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { fireProcessOf } from '../../src/chat/commands-portal.ts';
import { dfill, dimTeleport, E2E, hurtsSince, prepareServer, privateArea, serverTick, sleep, startNetherBot, teleport, until, type NetherBot } from './nether-truth.ts';

describe.skipIf(!E2E)('@bds nether: lava and magma in the planner (Track AT)', () => {
  const notes: string[] = [];
  let bot: NetherBot | undefined;
  let X = 0;
  let Z = 0;

  /** A closed netherrack box with an air room x0..x1 / z0..z1, floor y 99, room y 100..104. */
  async function arena(b: NetherBot, x0: number, z0: number, x1: number, z1: number): Promise<void> {
    await dfill(b, 'nether', { x: x0 - 1, y: 98, z: z0 - 1 }, { x: x1 + 1, y: 105, z: z1 + 1 }, 'netherrack');
    await dfill(b, 'nether', { x: x0, y: 100, z: z0 }, { x: x1, y: 104, z: z1 }, 'air');
  }

  /**
   * Walk with `!goto`, sampling every tick the feet cell, the body centre and the navigator's planned
   * nodes (its internal `active.path`, read-only); returns the reply, the samples and the hurt events.
   */
  async function walk(b: NetherBot, to: Vec3): Promise<{ reply: string; cells: Vec3[]; centres: Vec3[]; nodes: Vec3[]; hurts: { damage: number; cause: string }[]; ms: number }> {
    const mob = b.built.mobility!;
    const tick0 = await serverTick(b);
    const cells: Vec3[] = [];
    const centres: Vec3[] = [];
    const nodes = new Map<string, Vec3>();
    const off = mob.loop.onBeforeStep((_t, s) => {
      const c = { x: Math.floor(s.pos.x), y: Math.floor(s.pos.y + 1e-3), z: Math.floor(s.pos.z) };
      centres.push({ ...s.pos });
      const last = cells.at(-1);
      if (last?.x !== c.x || last.y !== c.y || last.z !== c.z) cells.push(c);
      for (const n of (mob.skills.nav as unknown as { active?: { path: Vec3[] } }).active?.path ?? []) nodes.set(`${n.x},${n.y},${n.z}`, { x: n.x, y: n.y, z: n.z });
    });
    const from = b.said.length;
    const t0 = Date.now();
    await b.command(`!goto ${to.x} ${to.y} ${to.z}`);
    const reply = await b.reply((s) => s.startsWith('arrived') || s.startsWith('goto:'), from, 90_000);
    off();
    await sleep(1000);
    return { reply, cells, centres, nodes: [...nodes.values()], hurts: await hurtsSince(b, tick0), ms: Date.now() - t0 };
  }

  beforeAll(async () => {
    await prepareServer();
    const a = privateArea();
    X = Math.round(a.x / 8 / 16) * 16;
    Z = Math.round(a.z / 8 / 16) * 16;
    bot = await startNetherBot('Lava');
    const b = bot;
    await dimTeleport(b, 'nether', { x: X + 1.5, y: 100, z: Z + 2.5 }, -90).catch(() => undefined);
    // the lava arena: room X-2..X+22 / Z-2..Z+14, the lake X+5..X+15 / Z-2..Z+6 in the floor
    await arena(b, X - 2, Z - 2, X + 22, Z + 14);
    await dfill(b, 'nether', { x: X + 5, y: 99, z: Z - 2 }, { x: X + 15, y: 99, z: Z + 6 }, 'lava');
    // the magma arena 40 blocks east: room X+38..X+52 / Z-2..Z+8, magma X+43..X+45 / Z-2..Z+6 (gap Z+7..Z+8)
    await arena(b, X + 38, Z - 2, X + 52, Z + 8);
    await dfill(b, 'nether', { x: X + 43, y: 99, z: Z - 2 }, { x: X + 45, y: 99, z: Z + 6 }, 'magma');
    await teleport(b, { x: X + 1.5, y: 100, z: Z + 2.5 }, -90);
    await sleep(6000); // any fire from the arrival is out
    notes.push(`nether arenas at ${X} ${Z}`);
  }, 240_000);

  afterAll(async () => {
    console.log(`[nether-lava] ${notes.join('\n[nether-lava] ')}`);
    await bot?.stop();
  }, 60_000);

  it('!goto past a lava lake: 0 damage, every planned cell 2 blocks off the lava, the body never next to it', async () => {
    const b = bot!;
    /** Chebyshev distance (whole blocks) from a cell to the lake. */
    const cellGap = (c: Vec3) => {
      const dx = c.x < X + 5 ? X + 5 - c.x : c.x > X + 15 ? c.x - (X + 15) : 0;
      const dz = c.z < Z - 2 ? Z - 2 - c.z : c.z > Z + 6 ? c.z - (Z + 6) : 0;
      return Math.max(dx, dz);
    };
    /** Horizontal distance from the body centre to the lake's blocks (their boxes). */
    const bodyGap = (p: Vec3) => Math.hypot(Math.max(X + 5 - p.x, 0, p.x - (X + 16)), Math.max(Z - 2 - p.z, 0, p.z - (Z + 7)));
    const r = await walk(b, { x: X + 19, y: 100, z: Z + 2 });
    const planned = Math.min(...r.nodes.map(cellGap));
    const stood = Math.min(...r.cells.map(cellGap));
    const body = Math.min(...r.centres.map(bodyGap));
    notes.push(`lava: "${r.reply}" in ${(r.ms / 1000).toFixed(1)} s; ${r.nodes.length} planned cells, closest ${planned} blocks (Chebyshev) to the lava; ${r.cells.length} cells stood in, closest ${stood}; body centre at least ${body.toFixed(2)} from the lava; hurts ${JSON.stringify(r.hurts)}; avoidance ${JSON.stringify((b.task.status() as { survival?: { avoidance?: unknown } }).survival?.avoidance)}`);
    notes.push(`lava: stood in ${r.cells.map((c) => `${c.x - X},${c.z - Z}:${cellGap(c)}`).join(' ')}`);
    expect(r.reply).toMatch(/^arrived at /);
    expect(r.hurts).toEqual([]);
    expect(r.nodes.length).toBeGreaterThan(5);
    expect(planned).toBeGreaterThanOrEqual(2);
    // a diagonal step between two cells 2 off the lava passes the corner of a cell 1 off it: the body centre stays more than 1.2 blocks away (measured 1.35)
    expect(body).toBeGreaterThan(1.2);
  }, 120_000);

  it('!goto across a magma strip: never stands on magma, 0 damage', async () => {
    const b = bot!;
    const mob = b.built.mobility!;
    await teleport(b, { x: X + 39.5, y: 100, z: Z + 2.5 }, -90);
    const r = await walk(b, { x: X + 50, y: 100, z: Z + 2 });
    const onMagma = r.cells.filter((c) => mob.world.blockAt({ x: c.x, y: c.y - 1, z: c.z })?.name === 'magma');
    notes.push(`magma: "${r.reply}" in ${(r.ms / 1000).toFixed(1)} s, ${r.cells.length} cells, ${onMagma.length} on magma, hurts ${JSON.stringify(r.hurts)}`);
    expect(r.reply).toMatch(/^arrived at /);
    expect(onMagma).toEqual([]);
    expect(r.hurts).toEqual([]);
  }, 120_000);

  it('set on fire: the fire escape walks to a cell clear of fire', async () => {
    const b = bot!;
    const mob = b.built.mobility!;
    const fire = fireProcessOf(b.task)!;
    const before = fire.stats.escapes;
    await teleport(b, { x: X + 49.5, y: 100, z: Z + 4.5 }, 90);
    const tick0 = await serverTick(b);
    // fire in the bot's cell and around it (west side), as a blaze's fireball leaves it
    await dfill(b, 'nether', { x: X + 48, y: 100, z: Z + 3 }, { x: X + 49, y: 100, z: Z + 5 }, 'fire');
    const t0 = Date.now();
    const escaped = await until(
      () => {
        const p = mob.loop.state.pos;
        const clear = p.x >= X + 51 || p.z >= Z + 7 || p.z <= Z + 1;
        return fire.stats.escapes > before && clear && fire.wants() === false ? { ...p } : undefined;
      },
      20_000,
      'the fire escape',
      100,
    ).catch(() => undefined);
    const hurts = await hurtsSince(b, tick0);
    notes.push(`fire: ${escaped ? `escaped to ${escaped.x.toFixed(1)} ${escaped.z.toFixed(1)}` : 'no escape'} after ${((Date.now() - t0) / 1000).toFixed(1)} s; escapes ${fire.stats.escapes - before}, eats ${fire.stats.eats}; hurts ${hurts.map((h) => `${h.cause} ${h.damage}`).join(', ')}`);
    expect(escaped).toBeDefined();
  }, 60_000);
});
