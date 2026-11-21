// Track R9 (ADR 0097, docs/flight.md "Rockets on hand"): the rocket stock's pure rules (skills/fly/rockets.ts) and its
// job, process, chore and readiness pass (tasks/process/rockets.ts) on fakes.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SETTING_DEFS } from '../../../src/config/settings.ts';
import { SETTING_GROUPS } from '../../../src/chat/help.ts';
import { RecipeIndex, type CraftingDataPacket } from '../../../src/skills/craft/recipes.ts';
import { planUnload, type UnloadSlot } from '../../../src/skills/home/unloader.ts';
import { materialCounts, materialsReserve, planRockets, recipeFlight, rocketCounts, rocketRecipe, tripRocketNeed, type RocketStockInput, type Stock } from '../../../src/skills/fly/rockets.ts';
import { RocketJob, RocketsController, rocketsReply, type RocketDeps, type RocketSource } from '../../../src/tasks/process/rockets.ts';
import { ProcessManager } from '../../../src/tasks/process/manager.ts';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/crafting-rockets-1.26.60.json', import.meta.url), 'utf8')) as CraftingDataPacket & { items: Record<string, string> };
const index = new RecipeIndex((id) => fixture.items[String(id)]);
index.handle(fixture);

const none: Stock = { loose: 0, boxed: 0, home: 0 };
const input = (o: Partial<RocketStockInput> = {}): RocketStockInput => ({
  keep: 64,
  rockets: rocketCounts(0, 0, 0),
  homeRockets: 0,
  paper: none,
  gunpowder: none,
  cane: none,
  atHome: false,
  table: false,
  recipe: true,
  ...o,
});

describe('the duration choice (rocketRecipe)', () => {
  it('BDS 1.26.60: the one recipe of 1 paper and 1 gunpowder, flight 1 read from its output NBT; the firework star one is never picked', () => {
    const rs = index.byOutput('firework_rocket');
    expect(rs.length).toBe(2);
    const r = rocketRecipe(rs);
    expect(r?.id).toBe('paper_sulphur_recipeId');
    expect(r?.output[0]).toMatchObject({ count: 3, flight: 1 });
    expect(recipeFlight(r!)).toBe(1);
    expect(rocketRecipe(rs, 2)).toBeUndefined();
  });

  it('without the output NBT the gunpowder counts; 2 and 3 gunpowder recipes are flights 2 and 3; the lowest priority wins', () => {
    const mk = (id: string, powder: number, priority: number) => ({
      id,
      priority,
      input: [{ name: 'paper', metadata: 32767, count: 1 }, ...Array.from({ length: powder }, () => ({ name: 'gunpowder', metadata: 32767, count: 1 }))],
      output: [{ name: 'firework_rocket', count: 3, networkId: 529, metadata: 0, blockRuntimeId: 0 }],
    });
    const rs = [mk('g3', 3, 1), mk('g1b', 1, 60), mk('g1a', 1, 10), mk('g2', 2, 1)];
    expect(rocketRecipe(rs)?.id).toBe('g1a');
    expect(rocketRecipe(rs, 2)?.id).toBe('g2');
    expect(rocketRecipe(rs, 3)?.id).toBe('g3');
  });

  it('paper is 3 sugar cane in a row: a 3 x 1 shaped recipe that needs a table', () => {
    const p = index.byOutput('paper')[0]!;
    expect(p).toMatchObject({ shaped: true, width: 3, height: 1 });
    expect(p.output[0]!.count).toBe(3);
  });
});

describe('the stock rule (planRockets)', () => {
  it('counts every carried place once: loose, the fireworks box, other boxes; at the target nothing to do', () => {
    expect(rocketCounts(10, 40, 14).total).toBe(64);
    const p = planRockets(input({ rockets: rocketCounts(10, 40, 14), gunpowder: { loose: 9, boxed: 0, home: 0 }, paper: { loose: 9, boxed: 0, home: 0 } }), { home: true });
    expect(p).toMatchObject({ have: 64, want: 0, crafts: 0, steps: [] });
  });

  it('loose paper and gunpowder: ceil(want / 3) crafts in one step, a multiple of 3 rockets', () => {
    const p = planRockets(input({ rockets: rocketCounts(4, 0, 0), paper: { loose: 30, boxed: 0, home: 0 }, gunpowder: { loose: 30, boxed: 0, home: 0 } }), { home: false });
    expect(p.want).toBe(60);
    expect(p.crafts).toBe(20);
    expect(p.steps).toEqual([{ kind: 'craft', n: 60 }]);
    expect(p.short).toBeUndefined();
  });

  it('the cheapest source first: rockets from the chests at home, then loose, boxed and home materials (home only at home)', () => {
    const i = input({ rockets: rocketCounts(0, 10, 0), homeRockets: 24, paper: { loose: 2, boxed: 4, home: 20 }, gunpowder: { loose: 0, boxed: 5, home: 20 }, atHome: true });
    const p = planRockets(i, { home: true });
    // 54 missing: 24 rockets from home, 30 crafted (10 crafts)
    expect(p.steps).toEqual([
      { kind: 'home', item: 'firework_rocket', n: 24 },
      { kind: 'boxes', item: 'gunpowder', n: 5 },
      { kind: 'home', item: 'gunpowder', n: 5 },
      { kind: 'boxes', item: 'paper', n: 4 },
      { kind: 'home', item: 'paper', n: 4 },
      { kind: 'craft', n: 30 },
    ]);
    // away from home the chests are not a source: 5 crafts from the boxes
    const away = planRockets({ ...i, atHome: false }, { home: true });
    expect(away.steps.some((s) => s.kind === 'home')).toBe(false);
    expect(away.crafts).toBe(5);
    // the trip readiness never uses the chests, even at home
    expect(planRockets(i, { home: false }).steps.some((s) => s.kind === 'home')).toBe(false);
  });

  it('paper from sugar cane only without enough paper, in multiples of 3, and only with a table', () => {
    const i = input({ rockets: rocketCounts(55, 0, 0), paper: { loose: 1, boxed: 0, home: 0 }, gunpowder: { loose: 3, boxed: 0, home: 0 }, cane: { loose: 7, boxed: 0, home: 0 } });
    expect(planRockets({ ...i, table: true }, { home: false }).steps).toEqual([{ kind: 'paper', n: 3 }, { kind: 'craft', n: 9 }]);
    const noTable = planRockets(i, { home: false });
    expect(noTable.crafts).toBe(1);
    expect(noTable.missing).toEqual(['crafting table']);
    expect(noTable.short).toBe('6 short: sugar cane but no crafting table near for the paper');
  });

  it('no gunpowder: nothing crafted and the plan says so (never farmed)', () => {
    const p = planRockets(input({ paper: { loose: 30, boxed: 0, home: 0 } }), { home: true });
    expect(p.steps).toEqual([]);
    expect(p.missing).toEqual(['gunpowder']);
    expect(p.short).toBe('64 short: no gunpowder (carried or in the boxes; the chests at home only at home)');
    const atHome = planRockets(input({ atHome: true }), { home: true });
    expect(atHome.short).toBe('64 short: no gunpowder (carried, in the boxes or at home); no paper or sugar cane');
  });

  it('too little gunpowder: as many crafts as it allows, and the rest named', () => {
    const p = planRockets(input({ paper: { loose: 30, boxed: 0, home: 0 }, gunpowder: { loose: 4, boxed: 0, home: 0 } }), { home: false });
    expect(p.crafts).toBe(4);
    expect(p.short).toBe('52 short: gunpowder for 12 only');
  });

  it('no recipe yet: the plan waits for it', () => {
    expect(planRockets(input({ recipe: false, gunpowder: { loose: 9, boxed: 0, home: 0 } }), { home: false }).short).toMatch(/no rocket recipe yet/);
  });
});

describe('the unload reserve (materialsReserve)', () => {
  it('one craft round to fireworksKeep: 22 paper and 22 gunpowder for 64; sugar cane only for the paper not carried', () => {
    const r = materialsReserve([{ name: 'paper', count: 64 }, { name: 'gunpowder', count: 40 }, { name: 'sugar_cane', count: 64 }]);
    expect([...r]).toEqual([['paper', 22], ['gunpowder', 22]]);
    const r2 = materialsReserve([{ name: 'minecraft:paper', count: 5 }, { name: 'gunpowder', count: 3 }, { name: 'sugar_cane', count: 64 }]);
    expect([...r2]).toEqual([['paper', 5], ['gunpowder', 3], ['sugar_cane', 18]]);
    expect(materialsReserve([{ name: 'paper', count: 64 }], 0).size).toBe(0);
  });

  it('the unload plan keeps that round (rocket_reserve) and stores the rest; the rockets themselves stay whole', () => {
    const slot = (s: number, name: string, count: number): UnloadSlot => ({ slot: s, name, count });
    const chest = { key: 'a', pos: { x: 3, y: 0, z: 0 }, kind: 'chest', free: 27, contents: {}, room: {}, boxes: { empty: 0, full: 0 } };
    const slots = [slot(10, 'paper', 64), slot(11, 'gunpowder', 30), slot(12, 'sugar_cane', 12), slot(13, 'firework_rocket', 40), slot(14, 'dirt', 64)];
    const plan = planUnload(slots, [chest], { fireworksKeep: 64, reserve: 0 });
    expect(plan.kept).toEqual(expect.arrayContaining([{ name: 'paper', count: 22, why: 'rocket_reserve' }, { name: 'gunpowder', count: 22, why: 'rocket_reserve' }]));
    const moved = (n: string) => plan.moves.filter((m) => m.name === n).reduce((a, m) => a + m.count, 0);
    expect(moved('paper')).toBe(42);
    expect(moved('gunpowder')).toBe(8);
    expect(moved('sugar_cane')).toBe(12); // the paper of the round is carried: no cane kept
    expect(moved('firework_rocket')).toBe(0);
    // fireworksKeep 0: the materials are loot like any other
    const off = planUnload(slots, [chest], { fireworksKeep: 0, reserve: 0 });
    expect(off.kept.some((k) => k.why === 'rocket_reserve')).toBe(false);
    expect(off.moves.filter((m) => m.name === 'paper').reduce((a, m) => a + m.count, 0)).toBe(64);
  });
});

describe('the settings', () => {
  it('fireworksKeep 64 (0 to 640), autoRockets off, both in the flight group', () => {
    expect(SETTING_DEFS.fireworksKeep.default).toBe(64);
    expect(SETTING_DEFS.fireworksKeep.kind === 'number' && SETTING_DEFS.fireworksKeep.max).toBe(640);
    expect(SETTING_DEFS.autoRockets.default).toBe(false);
    const flight = SETTING_GROUPS.find(([g]) => g === 'flight')?.[1] ?? [];
    expect(flight).toEqual(expect.arrayContaining(['fireworksKeep', 'autoRockets']));
  });
});

describe('counts and the trip need', () => {
  it('materialCounts reads slots 0..35 only; the trip need is twice the way out, never under fireworksMin', () => {
    const slots = [{ name: 'paper', count: 3 }, null, { name: 'firework_rocket', count: 10 }, ...Array.from({ length: 33 }, () => null), { name: 'paper', count: 64 }];
    expect(materialCounts(slots)).toEqual({ paper: 3, gunpowder: 0, cane: 0, rockets: 10 });
    expect(tripRocketNeed(3, 16)).toBe(16);
    expect(tripRocketNeed(12, 16)).toBe(24);
  });
});

/** A fake source: counts in memory; crafting consumes them; the box takes what it is given. */
function fakeSource(o: { loose?: number; box?: number; paper?: number; gunpowder?: number; homePaper?: number; homePowder?: number; atHome?: boolean; boxCarried?: boolean }) {
  const s = { loose: o.loose ?? 0, box: o.box ?? 0, paper: o.paper ?? 0, gunpowder: o.gunpowder ?? 0, homePaper: o.homePaper ?? 0, homePowder: o.homePowder ?? 0 };
  const calls: string[] = [];
  const source: RocketSource = {
    input: (keep) => input({ keep, rockets: rocketCounts(s.loose, s.box, 0), paper: { loose: s.paper, boxed: 0, home: s.homePaper }, gunpowder: { loose: s.gunpowder, boxed: 0, home: s.homePowder }, atHome: o.atHome ?? false }),
    counts: () => rocketCounts(s.loose, s.box, 0),
    fromBoxes: async (item, n) => {
      await Promise.resolve();
      calls.push(`boxes ${n} ${item}`);
      return { got: 0, why: 'none' };
    },
    fromHome: async (item, n) => {
      await Promise.resolve();
      calls.push(`home ${n} ${item}`);
      if (item === 'paper') {
        const g = Math.min(n, s.homePaper);
        s.homePaper -= g;
        s.paper += g;
        return { got: g };
      }
      const g = Math.min(n, s.homePowder);
      s.homePowder -= g;
      s.gunpowder += g;
      return { got: g };
    },
    craft: async (item, n) => {
      await Promise.resolve();
      calls.push(`craft ${n} ${item}`);
      const crafts = Math.min(Math.ceil(n / 3), s.paper, s.gunpowder);
      s.paper -= crafts;
      s.gunpowder -= crafts;
      s.loose += crafts * 3;
      return { made: crafts * 3, line: `crafted ${crafts * 3} firework_rocket` };
    },
    stow: async (n) => {
      await Promise.resolve();
      calls.push(`stow ${n}`);
      if (!o.boxCarried) return { moved: 0, why: 'no fireworks box carried' };
      const m = Math.min(n, s.loose);
      s.loose -= m;
      s.box += m;
      return { moved: m };
    },
  };
  return { s, calls, source };
}

function deps(source: RocketSource, settings: Record<string, unknown> = {}): RocketDeps & { processes: ProcessManager } {
  const values: Record<string, unknown> = { fireworksKeep: 64, autoRockets: false, autoFly: true, fireworksMin: 16, flyMin: 200, ...settings };
  return {
    processes: new ProcessManager(),
    settings: { get: ((k: string) => values[k]) as never },
    source,
    position: () => ({ x: 0, y: 64, z: 0 }),
    home: () => ({ x: 0, y: 64, z: 0 }),
    isDay: () => true,
    threat: () => undefined,
    canFly: () => true,
    estimate: (d) => Math.ceil(d / 300),
    cancel: () => {},
  };
}

describe('the job (RocketJob) on a fake source', () => {
  it('at home with the materials in a home chest and the box low: fetched, crafted to the target, into the fireworks box', async () => {
    const f = fakeSource({ box: 4, homePaper: 30, homePowder: 30, atHome: true, boxCarried: true });
    const r = await new RocketJob({ keep: 64, home: true, stow: true }).run(deps(f.source), () => false);
    expect(f.calls).toEqual(['home 20 gunpowder', 'home 20 paper', 'craft 60 firework_rocket', 'stow 60']);
    expect(r).toMatchObject({ ok: true, before: 4, after: 64, crafted: 60, stowed: 60, fetched: { gunpowder: 20, paper: 20 }, reason: 'done' });
    expect(f.s).toMatchObject({ loose: 0, box: 64 });
    expect(rocketsReply(r)).toBe('rockets: 64 carried (60 crafted, 20 gunpowder, 20 paper fetched, 60 into the fireworks box)');
  });

  it('the trip readiness: carried materials only, the rockets kept loose', async () => {
    const f = fakeSource({ loose: 6, paper: 4, gunpowder: 4, homePaper: 30, homePowder: 30, atHome: true, boxCarried: true });
    const d = deps(f.source);
    const c = new RocketsController(d);
    expect(c.tripNeeded({ x: 600, y: 64, z: 0 })).toBe(true);
    expect(c.tripNeeded({ x: 100, y: 64, z: 0 })).toBe(false); // under flyMin: it walks
    const r = await c.tripRun(() => true);
    expect(f.calls).toEqual(['craft 12 firework_rocket']);
    expect(r).toMatchObject({ after: 18, crafted: 12, stowed: 0 });
    expect(rocketsReply(r)).toBe('rockets: 18 carried (12 crafted); 46 short of 64: gunpowder for 12 only; not enough paper or sugar cane');
    c.dispose();
  });

  it('no fly, no readiness: autoFly off, no elytra, fireworksKeep 0', () => {
    const f = fakeSource({ paper: 9, gunpowder: 9 });
    for (const s of [{ autoFly: false }, { fireworksKeep: 0 }]) {
      const c = new RocketsController(deps(f.source, s));
      expect(c.tripNeeded({ x: 600, y: 64, z: 0 })).toBe(false);
      c.dispose();
    }
    const d = deps(f.source);
    d.canFly = () => false;
    const c = new RocketsController(d);
    expect(c.tripNeeded({ x: 600, y: 64, z: 0 })).toBe(false);
    c.dispose();
  });

  it('the status part and the panel line say what is missing', () => {
    const f = fakeSource({ loose: 10, box: 30 });
    const c = new RocketsController(deps(f.source));
    expect(c.statusPart()).toBe('40/64 (no gunpowder; no paper or sugar cane)');
    expect(c.panelLine()).toBe('40 of 64 (10 loose, 30 in the box), 0 gunpowder, 0 paper');
    c.dispose();
  });

  it('Track REL2: no rockets line for a newcomer (no rockets, no elytra, autoRockets off), in !status and on the panel', () => {
    const none = fakeSource({});
    const newcomer = deps(none.source);
    newcomer.canFly = () => false;
    const c = new RocketsController(newcomer);
    expect(c.statusPart()).toBeUndefined(); // was `0/64 (no gunpowder; no paper or sugar cane)`
    expect(c.panelLine()).toBeUndefined(); // was `0 of 64 (0 loose), 0 gunpowder, 0 paper`
    c.dispose();
    const flies = new RocketsController(deps(none.source)); // an elytra that may fly: 0 rockets is news
    expect(flies.panelLine()).toBe('0 of 64 (0 loose), 0 gunpowder, 0 paper');
    flies.dispose();
    const chore = { ...deps(none.source, { autoRockets: true }), canFly: () => false };
    const on = new RocketsController(chore);
    expect(on.statusPart()).toMatch(/^0\/64/);
    on.dispose();
    const carried = { ...deps(fakeSource({ loose: 3 }).source), canFly: () => false };
    const some = new RocketsController(carried);
    expect(some.panelLine()).toBe('3 of 64 (3 loose), 0 gunpowder, 0 paper');
    some.dispose();
  });
});

describe('the chore (autoRockets)', () => {
  it('off by default; on, at home by day under the target with a step: it runs; with nothing to craft from it waits 10 minutes', () => {
    let now = 0;
    const f = fakeSource({ box: 4, homePaper: 30, homePowder: 30, atHome: true, boxCarried: true });
    const d = { ...deps(f.source), now: () => now };
    const c = new RocketsController(d);
    expect(c.chore.wants()).toBe(false);
    const on = { ...deps(f.source, { autoRockets: true }), now: () => now };
    const c2 = new RocketsController(on);
    now = 5000;
    expect(c2.chore.wants()).toBe(true);
    const empty = fakeSource({ atHome: true });
    const c3 = new RocketsController({ ...deps(empty.source, { autoRockets: true }), now: () => now });
    expect(c3.chore.wants()).toBe(false);
    expect(c3.chore.lastWhy).toMatch(/no gunpowder/);
    expect(c3.chore.nextTry).toBe(now + 10 * 60_000);
    for (const x of [c, c2, c3]) x.dispose();
  });
});
