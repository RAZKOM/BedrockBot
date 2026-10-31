// e2e (tag @bds), wave 11 Track AU2 (docs/flight.md "Takeoff and roofs"): no takeoff under a roof, the walk
// to open sky, the path ahead of the climb; on bds-fly (flat, peaceful, fall damage ON, truth pack). One
// afk-task bot (walking, the CLI's wiring) with the flight kit; truth-built structures in a private area:
//   roof      a room (roof 4 above the floor, a doorway) around the start: `!fly` refuses with the roof line;
//             `!goto` 300 blocks walks out of the room first and takes off once outside (the position changes
//             on foot, a flight starts, 0 damage, arrived)
//   tunnel    a tunnel 6 blocks under a raised surface with a stair up (the owner's underground case, review item 1):
//             `!goto` 300 blocks walks up to an open-sky cell on the surface first (`openSkyLeg`), then flies, arrives
//   tree      a tree-height obstacle (3 x 3, 8 high) 10 blocks ahead on the climb line: the sky check turns the
//             takeoff heading, the climb looks 20 ticks ahead: 0 damage, landed
// Env: FLY_BDS_HOST / FLY_BDS_PORT / FLY_BDS_CONTAINER (fly-truth.ts), FLY_AREA, FLY_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { E2E, FEET_Y, giveFlightKit, hdist, prepareServer, privateArea, sleep, startFlyBot, teleport, truthLoaded, until, type FlyBot } from './fly-truth.ts';

const F = FEET_Y;

describe.skipIf(!E2E)('@bds fly: roofs and the path ahead (Track AU2)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: FlyBot | undefined;
  const home: Vec3 = { x: area.x + 0.5, y: F, z: area.z + 0.5 };

  beforeAll(async () => {
    await prepareServer();
    bot = await startFlyBot('Roof');
    await teleport(bot, home);
  }, 120_000);

  afterAll(async () => {
    if (bot) await bot.stop();
    console.log(`[fly-roof e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 60_000);

  it('a room with the roof 4 above the floor: !fly refuses with the roof line; !goto 300 walks out and takes off outside with 0 damage', async () => {
    const b = bot!;
    const ax = area.x;
    const az = area.z;
    // the room: walls 1 thick around a 7 x 7 interior, the roof block at F + 4, a 2 x 2 doorway on the +z side (towards the goal)
    await teleport(b, { x: ax + 12.5, y: F, z: az + 0.5 });
    await truthLoaded(b.truth, 'fill', [ax - 4, F, az - 4, ax + 4, F + 4, az + 4, 'stone']);
    await truthLoaded(b.truth, 'fill', [ax - 3, F, az - 3, ax + 3, F + 3, az + 3, 'air']);
    await truthLoaded(b.truth, 'fill', [ax, F, az + 4, ax + 1, F + 1, az + 4, 'air']);
    await teleport(b, home);
    await giveFlightKit(b, { rockets: 64 });
    const target = { x: ax, y: F, z: az + 300 };
    let from = b.said.length;
    await b.command(`!fly ${target.x} ${target.y} ${target.z}`);
    const refused = await b.reply((s) => s.startsWith('fly: ') || s.startsWith('flying'), from);
    notes.push(`roof: !fly -> ${refused}`);
    expect(refused).toBe(`fly: no open sky here (roof at y ${F + 4}, 4 blocks up); walk outside first`);
    // !goto: the walk out, then the flight
    const since = await b.truth.now();
    const n0 = b.logs.length;
    from = b.said.length;
    await b.command(`!goto ${target.x} ${target.y} ${target.z}`);
    // (`walking to ...` is !goto's own first line; the flight's decision follows it)
    // Track BL: the takeoff-site search finds the open sky outside the door first (`walking N blocks to take off from X Y Z, then flying`)
    const first = await b.reply((s) => s.startsWith('fly: ') || s.startsWith('flying') || s.startsWith('goto: ') || s.startsWith('walking ') && s.includes('to take off from'), from, 15_000);
    notes.push(`roof: !goto -> ${first}`);
    expect(first).toMatch(/^fly: no open sky here \(roof at y -56, 4 blocks up\); walking towards \S+ \S+ \S+ and taking off outside$|^walking \d+ blocks to take off from -?\d+ -?\d+ -?\d+, then flying/);
    // on foot first: the position changes while no flight has started
    const moved = await until(async () => {
      const g = await b.truth.glide(b.name);
      return hdist(g.location, home) > 6 && !g.isGliding && b.logs.slice(n0).every((l) => !l.includes('flight: to')) ? g : undefined;
    }, 60_000, 'the walk out of the room', 200);
    notes.push(`roof: walked to ${moved.location.x.toFixed(1)} ${moved.location.y.toFixed(1)} ${moved.location.z.toFixed(1)} before any flight`);
    const flying = await b.reply((s) => s.startsWith('flying'), from, 120_000);
    notes.push(`roof: ${flying}`);
    expect(flying).toMatch(/^flying \(\d+ blocks; walking would be ~\d+ min\)$/);
    const fromFlying = b.said.indexOf(flying, from) + 1;
    const arrived = await b.reply((s) => s.startsWith('arrived at ') || s.startsWith('goto: ') || s.startsWith('fly: '), fromFlying, 180_000);
    const g = await b.truth.glide(b.name);
    const dmg = await b.truth.damageSince(since, b.name);
    const flight = b.logs.slice(n0).find((l) => l.includes('flight: landed') || l.includes('flight: ended'));
    notes.push(`roof: ${arrived} | truth ${g.location.x.toFixed(1)} ${g.location.y.toFixed(1)} ${g.location.z.toFixed(1)} damage ${dmg.total}${dmg.causes.length ? ` (${dmg.causes.join(',')})` : ''} | ${flight ?? 'no flight log'}`);
    expect(arrived).toBe(`arrived at ${target.x} ${target.y} ${target.z}`);
    expect(flight).toMatch(/flight: landed/);
    expect(hdist(g.location, { x: target.x + 0.5, z: target.z + 0.5 })).toBeLessThan(2.5);
    expect(dmg.total).toBe(0);
    // the room goes
    await teleport(b, { x: ax + 12.5, y: F, z: az + 0.5 });
    await truthLoaded(b.truth, 'fill', [ax - 4, F, az - 4, ax + 4, F + 4, az + 4, 'air']);
    await teleport(b, home);
  }, 420_000);

  it('a tunnel 6 blocks under the surface with a stair up: !goto 300 walks up to the surface first, then flies and arrives with 0 damage', async () => {
    const b = bot!;
    const tx = area.x + 120;
    const tz = area.z;
    await b.command('!stop');
    await sleep(1500);
    // the flat world's floor is 4 under the feet, so the surface is raised: a stone slab 7 thick (F .. F + 6) over
    // 21 x 21 blocks, the surface feet at F + 7; inside it the tunnel, 2 high at the old ground level (feet F) from
    // tz - 2 to tz + 2 (its last cell 3 high: the jump onto the first step needs the head room), then a covered
    // stair of one block up per block of z (3 high: feet, head, the jump) that comes out on the slab's top at tz + 9
    const surface = F + 7;
    await teleport(b, { x: tx + 0.5, y: F, z: tz + 0.5 });
    await truthLoaded(b.truth, 'fill', [tx - 10, F, tz - 10, tx + 10, F + 6, tz + 10, 'stone']);
    await truthLoaded(b.truth, 'fill', [tx, F, tz - 2, tx, F + 1, tz + 2, 'air']);
    await truthLoaded(b.truth, 'fill', [tx, F + 2, tz + 2, tx, F + 2, tz + 2, 'air']);
    for (let k = 1; k <= 6; k++) await truthLoaded(b.truth, 'fill', [tx, F + k, tz + 2 + k, tx, Math.min(F + 6, F + k + 2), tz + 2 + k, 'air']);
    const inside: Vec3 = { x: tx + 0.5, y: F, z: tz + 0.5 };
    await teleport(b, inside);
    await giveFlightKit(b, { rockets: 64 });
    const target = { x: tx, y: F, z: tz + 300 };
    const since = await b.truth.now();
    const n0 = b.logs.length;
    const from = b.said.length;
    await b.command(`!goto ${target.x} ${target.y} ${target.z}`);
    // Track BL: the takeoff-site search finds the slab's top up the stair first (`walking N blocks to take off from X Y Z, then flying`)
    const first = await b.reply((s) => s.startsWith('fly: ') || s.startsWith('flying') || s.startsWith('goto: ') || s.startsWith('walking ') && s.includes('to take off from'), from, 15_000);
    notes.push(`tunnel: !goto -> ${first}`);
    expect(first).toMatch(/^fly: no open sky here \(roof at y -58, 2 blocks up\); walking towards \S+ \S+ \S+ and taking off outside$|^walking \d+ blocks to take off from -?\d+ -?\d+ -?\d+, then flying/);
    // up to the surface (the slab's top) on foot before any flight
    const legs = () => b.logs.slice(n0).filter((l) => l.includes('fly: leg') || l.includes('goto') || l.includes('nav')).map((l) => l.replace(/^\S+ /, '')).slice(0, 12).join(' ; ');
    const up = await until(async () => {
      const g = await b.truth.glide(b.name);
      return g.location.y >= surface - 0.5 && !g.isGliding && b.logs.slice(n0).every((l) => !l.includes('flight: to')) ? g : undefined;
    }, 90_000, 'the walk up to the surface', 200).catch(async (e: unknown) => {
      const g = await b.truth.glide(b.name);
      notes.push(`tunnel: FAILED to reach the surface; at ${g.location.x.toFixed(1)} ${g.location.y.toFixed(1)} ${g.location.z.toFixed(1)}; said: ${b.said.slice(from).join(' | ')}; logs: ${legs()}`);
      throw e;
    });
    notes.push(`tunnel: on the surface at ${up.location.x.toFixed(1)} ${up.location.y.toFixed(1)} ${up.location.z.toFixed(1)} before any flight; legs: ${b.logs.slice(n0).filter((l) => l.includes('fly: leg')).map((l) => l.replace(/^\S+ info fly: /, '')).join(' ; ')}`);
    const flying = await b.reply((s) => s.startsWith('flying'), from, 120_000);
    expect(flying).toMatch(/^flying \(\d+ blocks; walking would be ~\d+ min\)$/);
    const fromFlying = b.said.indexOf(flying, from) + 1;
    const arrived = await b.reply((s) => s.startsWith('arrived at ') || s.startsWith('goto: ') || s.startsWith('fly: '), fromFlying, 180_000);
    const g = await b.truth.glide(b.name);
    const dmg = await b.truth.damageSince(since, b.name);
    const flight = b.logs.slice(n0).find((l) => l.includes('flight: landed') || l.includes('flight: ended'));
    notes.push(`tunnel: ${flying} | ${arrived} | truth ${g.location.x.toFixed(1)} ${g.location.y.toFixed(1)} ${g.location.z.toFixed(1)} damage ${dmg.total}${dmg.causes.length ? ` (${dmg.causes.join(',')})` : ''} | ${flight ?? 'no flight log'}`);
    expect(arrived).toBe(`arrived at ${target.x} ${target.y} ${target.z}`);
    expect(flight).toMatch(/flight: landed/);
    expect(dmg.total).toBe(0);
    await teleport(b, { x: tx + 0.5, y: surface, z: tz + 0.5 });
    await truthLoaded(b.truth, 'fill', [tx - 10, F, tz - 10, tx + 10, F + 6, tz + 10, 'air']);
    await teleport(b, home);
  }, 420_000);

  it('a tree-height obstacle 10 blocks ahead on the climb line: the takeoff heading turns, the climb steers clear: 0 damage, landed', async () => {
    const b = bot!;
    const sx = area.x + 60;
    const sz = area.z;
    const start: Vec3 = { x: sx + 0.5, y: F, z: sz + 0.5 };
    await b.command('!stop'); // whatever the room test left running
    await sleep(1500);
    await teleport(b, start);
    await truthLoaded(b.truth, 'fill', [sx - 1, F, sz + 9, sx + 1, F + 7, sz + 11, 'oak_log']);
    await giveFlightKit(b, { rockets: 64 });
    const target = { x: sx, y: F, z: sz + 300 };
    const since = await b.truth.now();
    const n0 = b.logs.length;
    const from = b.said.length;
    await b.command(`!fly ${target.x} ${target.y} ${target.z}`);
    const startLine = await b.reply((s) => s.startsWith('flying to ') || s.startsWith('fly: '), from);
    expect(startLine, 'the tree is ahead, not over the start: the flight starts').toMatch(/^flying to /);
    const end = await b.reply((s) => s.startsWith('landed') || s.startsWith('fly: '), from, 150_000);
    const g = await b.truth.glide(b.name);
    const dmg = await b.truth.damageSince(since, b.name);
    const begin = b.logs.slice(n0).find((l) => l.includes('flight: to'));
    const flight = b.logs.slice(n0).find((l) => l.includes('flight: landed') || l.includes('flight: ended'));
    notes.push(`tree: ${end} | ${begin ?? ''} | ${flight ?? ''} | damage ${dmg.total}${dmg.causes.length ? ` (${dmg.causes.join(',')})` : ''}`);
    expect(end).toMatch(/^landed at /);
    expect(begin).toMatch(/takeoff heading -?\d+/);
    expect(g.isOnGround).toBe(true);
    expect(dmg.total).toBe(0);
    expect(hdist(g.location, { x: target.x + 0.5, z: target.z + 0.5 })).toBeLessThan(3);
    await teleport(b, start);
    await truthLoaded(b.truth, 'fill', [sx - 1, F, sz + 9, sx + 1, F + 7, sz + 11, 'air']);
    await teleport(b, home);
  }, 300_000);
});
