// Track BJ (decision 0052, docs/build.md "Materials"): the build and the carried shulker boxes: the materials
// count what the boxes hold; the runner refills a block it ran out of on the ground (the box never on a cell of the
// build), tops up the column's places and scaffold blocks before a pillar (no box from a column top), and stows
// what it took out and did not use at the end.
import { describe, expect, it } from 'vitest';
import { materialsLine, materialsOf } from '../../../src/skills/build/materials.ts';
import { planBuild, type Plan } from '../../../src/skills/build/plan.ts';
import { BuildRunner, type RunnerSupply } from '../../../src/skills/build/runner.ts';
import { parseSpec } from '../../../src/skills/build/spec.ts';
import { type BuildSpec, type Cell } from '../../../src/skills/build/types.ts';
import { FakeBot, FakeInventory, FlatWorld } from './build-fakes.ts';

const F = -60;
const START: Cell = { x: 0, y: F, z: 0 };

function spec(args: string): BuildSpec {
  const r = parseSpec(args.split(' '), { feet: START });
  if (!r.ok) throw new Error(r.error);
  return r.spec;
}

/** A Supply over the fake bot: boxed items by name; each call logged with the bot's feet and whether the cell next to it is footprint. */
class FakeSupply implements RunnerSupply {
  readonly boxed = new Map<string, number>();
  readonly calls: string[] = [];
  private readonly bot: FakeBot;
  constructor(bot: FakeBot, init: Record<string, number>) {
    this.bot = bot;
    for (const [k, v] of Object.entries(init)) this.boxed.set(k, v);
  }
  private names(n: string | readonly string[]): string[] {
    return typeof n === 'string' ? [n] : [...n];
  }
  carried(n: string | readonly string[]): number {
    return this.names(n).reduce((a, k) => a + (this.boxed.get(k) ?? 0), 0);
  }
  ensure(n: string | readonly string[], target: number, opts: { avoid?: (p: Cell) => boolean }) {
    const ns = this.names(n);
    let loose = ns.reduce((a, k) => a + this.bot.inv.count(k), 0);
    let from = 0;
    for (const k of ns) {
      const take = Math.min(Math.max(0, target - loose), this.boxed.get(k) ?? 0);
      this.boxed.set(k, (this.boxed.get(k) ?? 0) - take);
      this.bot.inv.add(k, take);
      loose += take;
      from += take;
    }
    this.calls.push(`ensure ${ns.join('/')} ${target} at y ${this.bot.feet.y - F}${opts.avoid ? '' : ' (no avoid)'}`);
    return Promise.resolve({ ok: loose >= target, loose, fromBoxes: from });
  }
  /** Like Supply.stow: `keep` in all across the names, the surplus of the last names first. */
  stow(n: string | readonly string[], keep: number) {
    const ns = this.names(n);
    let extra = Math.max(0, ns.reduce((a, k) => a + this.bot.inv.count(k), 0) - keep);
    let stowed = 0;
    for (const k of [...ns].reverse()) {
      const m = Math.min(extra, this.bot.inv.count(k));
      this.bot.inv.add(k, -m);
      this.boxed.set(k, (this.boxed.get(k) ?? 0) + m);
      stowed += m;
      extra -= m;
    }
    this.calls.push(`stow ${ns.join('/')} keep ${keep}: ${stowed}`);
    return Promise.resolve({ stowed });
  }
}

/** Track B4: the multi-kind take and stow (Supply.takeMany / stowMany) over the fake bot; `slots` inventory slots in all. */
class BoxSupply extends FakeSupply {
  slots = 36;
  /** Each take's or stow's feet and whether the cells checked are avoided. */
  readonly avoided: { feet: Cell; cells: boolean[] }[] = [];
  probe: Cell[] = [];
  /** The first take answers no free cell (the bot beside a wall). */
  noCellOnce = false;
  private readonly fb: FakeBot;
  constructor(bot: FakeBot, init: Record<string, number>) {
    super(bot, init);
    this.fb = bot;
  }
  contents() {
    return new Map([...this.boxed].filter(([, n]) => n > 0));
  }
  freeSlots() {
    let used = 0;
    for (const [k, n] of this.fb.inv.items) if (n > 0) used += Math.ceil(n / (k.endsWith('_shulker_box') ? 1 : 64));
    return this.slots - used;
  }
  takeMany(want: Record<string, number>, o: { avoid?: (p: Cell) => boolean }) {
    this.avoided.push({ feet: { ...this.fb.feet }, cells: this.probe.map((c) => !!o.avoid?.(c)) });
    if (this.noCellOnce) {
      this.noCellOnce = false;
      this.calls.push('take: no free cell');
      return Promise.resolve({ taken: {}, boxes: 0, reason: 'no free cell for the box next to the bot' });
    }
    const taken: Record<string, number> = {};
    for (const [k, n] of Object.entries(want)) {
      const t = Math.min(n, this.boxed.get(k) ?? 0);
      if (t <= 0) continue;
      this.boxed.set(k, (this.boxed.get(k) ?? 0) - t);
      this.fb.inv.add(k, t);
      taken[k] = t;
    }
    this.calls.push(`take ${Object.entries(taken).map(([k, v]) => `${v} ${k}`).sort().join(', ')}`);
    return Promise.resolve({ taken, boxes: 1 });
  }
  stowMany(keep: Record<string, number>) {
    const stowed: Record<string, number> = {};
    for (const [k, n] of Object.entries(keep)) {
      const m = Math.max(0, this.fb.inv.count(k) - n);
      if (m <= 0) continue;
      this.fb.inv.add(k, -m);
      this.boxed.set(k, (this.boxed.get(k) ?? 0) + m);
      stowed[k] = m;
    }
    this.calls.push(`stowMany ${Object.entries(stowed).map(([k, v]) => `${v} ${k}`).join(', ')}`);
    return Promise.resolve({ stowed, boxes: 1 });
  }
}

/** A plan of place steps in this order (no stands: the runner finds them), along z = 2 from x = 2. */
function rowPlan(items: string[]): Plan {
  const steps = items.map((it, i) => ({ op: 'place' as const, pos: { x: 2 + i, y: F, z: 2 }, name: it, item: it }));
  const materials: Record<string, number> = {};
  for (const it of items) materials[it] = (materials[it] ?? 0) + 1;
  return { spec: { kind: 'file', label: 'row', places: steps.map((s) => ({ pos: s.pos, name: s.name })) }, steps, work: steps.length, already: 0, occupied: 0, skipped: [], scaffolds: 0, scaffoldPeak: 0, materials, ms: 0 };
}

describe('Track B4 (decision 0129): the runner loads the stretch ahead out of the boxes', () => {
  it('two kinds in one take at the start; no box on a cell of the build, a planned stand or a cell the job names', async () => {
    const w = new FlatWorld();
    const places: { pos: Cell; name: string }[] = [];
    for (let x = 2; x <= 6; x++) for (let z = 2; z <= 6; z++) places.push({ pos: { x, y: F, z }, name: x <= 3 ? 'stone_bricks' : 'oak_planks' });
    const p = planBuild(w, { kind: 'file', label: 'floor', places }, { start: START });
    const bot = new FakeBot(w, new FakeInventory({ dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const sup = new BoxSupply(bot, { stone_bricks: 64, oak_planks: 64 });
    const standOf = (s: Plan['steps'][number]): Cell | undefined => ('stand' in s ? s.stand : undefined);
    const stand = p.steps.map(standOf).find((st) => st && !places.some((b) => b.pos.x === st.x && b.pos.z === st.z));
    expect(stand).toBeDefined();
    sup.probe = [{ x: 2, y: F, z: 2 }, stand!, { x: 20, y: F, z: 20 }, { x: -3, y: F, z: -3 }];
    const r = new BuildRunner(p, { ...bot.deps(), supply: sup, avoid: (c) => c.x === 20 });
    expect(await r.run()).toEqual({ state: 'done' });
    expect(r.stats.placed).toBe(25);
    expect(sup.calls).toEqual(['take 10 stone_bricks, 15 oak_planks']);
    expect(sup.avoided[0]!.cells).toEqual([true, true, true, false]);
    expect(r.stats).toMatchObject({ refills: 1, refilled: 25 });
  });

  it('the stretch is what fits: with one stack of room the first 64, the rest when out', async () => {
    const w = new FlatWorld();
    const p = rowPlan(Array.from({ length: 100 }, () => 'stone_bricks'));
    const bot = new FakeBot(w, new FakeInventory({ dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const sup = new BoxSupply(bot, { stone_bricks: 128 });
    sup.slots = 6; // dirt 1, 5 free, 4 kept: 1 stack
    const r = new BuildRunner(p, { ...bot.deps(), supply: sup });
    expect(await r.run()).toEqual({ state: 'done' });
    expect(r.stats.placed).toBe(100);
    expect(sup.calls).toEqual(['take 64 stone_bricks', 'take 36 stone_bricks']);
  });

  it('the take needs room: the loose build items the stretch does not use go into a box first, and come out when their turn comes', async () => {
    const w = new FlatWorld();
    const p = rowPlan([...Array.from({ length: 64 }, () => 'stone_bricks'), ...Array.from({ length: 4 }, () => 'oak_planks')]);
    const bot = new FakeBot(w, new FakeInventory({ dirt: 16, oak_planks: 64 }), { x: 0.5, y: F, z: 0.5 });
    const sup = new BoxSupply(bot, { stone_bricks: 64 });
    sup.slots = 6; // dirt and planks 2, 4 free, 4 kept: none
    const r = new BuildRunner(p, { ...bot.deps(), supply: sup });
    expect(await r.run()).toEqual({ state: 'done' });
    expect(r.stats.placed).toBe(68);
    expect(sup.calls.slice(0, 3)).toEqual(['stowMany 64 oak_planks', 'take 64 stone_bricks', 'take 4 oak_planks']);
  });

  it('no free cell for the box beside the bot: it walks to a stand nearby with one and takes again', async () => {
    const w = new FlatWorld();
    const p = rowPlan(['stone_bricks', 'stone_bricks']);
    const bot = new FakeBot(w, new FakeInventory({ dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const sup = new BoxSupply(bot, { stone_bricks: 10 });
    sup.noCellOnce = true;
    const r = new BuildRunner(p, { ...bot.deps(), supply: sup });
    expect(await r.run()).toEqual({ state: 'done' });
    expect(sup.calls).toEqual(['take: no free cell', 'take 2 stone_bricks']);
    expect(sup.avoided[1]!.feet).not.toEqual(sup.avoided[0]!.feet);
  });

  it('Track B9: deep inside a wide build (no free cell within 6 of any stand): the nearest stand off it within 32, then the take', async () => {
    const w = new FlatWorld();
    const p = rowPlan(['stone_bricks', 'stone_bricks']);
    const bot = new FakeBot(w, new FakeInventory({ dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const sup = new BoxSupply(bot, { stone_bricks: 10 });
    sup.noCellOnce = true;
    // every cell within 15 of the bot is a cell of the build (a house's ground floor of 31 x 31)
    const wide = (c: Cell) => Math.abs(c.x) <= 15 && Math.abs(c.z) <= 15;
    const r = new BuildRunner(p, { ...bot.deps(), supply: sup, avoid: wide });
    expect(await r.run()).toEqual({ state: 'done' });
    expect(sup.calls).toEqual(['take: no free cell', 'take 2 stone_bricks']);
    const at = sup.avoided[1]!.feet;
    expect(Math.max(Math.abs(Math.floor(at.x)), Math.abs(Math.floor(at.z)))).toBeGreaterThanOrEqual(15);
  });

  it('after a fetch round (reload) the stretch ahead is loaded again before the next step', async () => {
    const w = new FlatWorld();
    const p = rowPlan(Array.from({ length: 10 }, () => 'stone_bricks'));
    const bot = new FakeBot(w, new FakeInventory({ dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const sup = new BoxSupply(bot, { stone_bricks: 4 });
    let n = 0;
    bot.onStep = () => {
      if (++n === 3) r.pause();
    };
    const r = new BuildRunner(p, { ...bot.deps(), supply: sup });
    expect(await r.run()).toEqual({ state: 'paused' });
    sup.boxed.set('stone_bricks', 20); // what a round put into the boxes
    r.reload();
    expect(await r.run()).toEqual({ state: 'done' });
    expect(sup.calls[0]).toBe('take 4 stone_bricks');
    expect(sup.calls.filter((c) => c.startsWith('take')).length).toBeGreaterThanOrEqual(2);
    expect(r.stats.placed).toBe(10);
  });

  it("Track B9: a stretch's take that fills the inventory before the box of the block the build is out of: the other kinds go back, then the block", async () => {
    const w = new FlatWorld();
    const p = rowPlan(['dead_fire_coral_block', ...Array.from({ length: 500 }, () => 'green_wool')]);
    const bot = new FakeBot(w, new FakeInventory({ dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    // a box's items come out in part stacks (two slots a stack, which the runner's count of free slots does not know),
    // the box holding most of the want first, two slots kept free
    class SplitSupply extends BoxSupply {
      private readonly split = new Set<string>();
      private realFree() {
        let used = 0;
        for (const [k, n] of bot.inv.items) if (n > 0) used += Math.ceil(n / 64) * (this.split.has(k) ? 2 : 1);
        return this.slots - used;
      }
      room(): number {
        return Math.max(0, Math.floor((this.realFree() - 2) / 2)) * 64;
      }
      override takeMany(want: Record<string, number>) {
        const taken: Record<string, number> = {};
        let reason: string | undefined;
        for (const [k, n] of Object.entries(want).sort((a, b) => b[1] - a[1])) {
          const t = Math.min(n, this.boxed.get(k) ?? 0, this.room());
          if (t < Math.min(n, this.boxed.get(k) ?? 0)) reason = 'my inventory is full';
          if (t <= 0) continue;
          this.split.add(k);
          this.boxed.set(k, (this.boxed.get(k) ?? 0) - t);
          bot.inv.add(k, t);
          taken[k] = t;
        }
        this.calls.push(`take ${Object.entries(taken).map(([k, v]) => `${v} ${k}`).sort().join(', ')}`);
        return Promise.resolve({ taken, boxes: 1, ...(reason ? { reason } : {}) });
      }
    }
    const sup = new SplitSupply(bot, { dead_fire_coral_block: 99, green_wool: 500 });
    sup.slots = 14;
    const r = new BuildRunner(p, { ...bot.deps(), supply: sup });
    expect(await r.run()).toEqual({ state: 'done' });
    expect(r.stats.placed).toBe(501);
    // before: `my inventory is full (my shulker boxes still hold 99 dead_fire_coral_block)` after the first take
    expect(sup.calls.slice(0, 4)).toEqual(['take 320 green_wool', 'take ', 'stowMany 320 green_wool', 'ensure dead_fire_coral_block 1 at y 0']);
  });

  it('Track B9: out of a block with a full inventory and no multi-kind take: the build\'s other loose kinds into the boxes, then the block', async () => {
    const w = new FlatWorld();
    const p = rowPlan(['dead_fire_coral_block', ...Array.from({ length: 10 }, () => 'green_wool')]);
    const bot = new FakeBot(w, new FakeInventory({ dirt: 16, green_wool: 512 }), { x: 0.5, y: F, z: 0.5 });
    class RoomSupply extends FakeSupply {
      room(): number {
        let used = 0;
        for (const [, n] of bot.inv.items) if (n > 0) used += Math.ceil(n / 64);
        return Math.max(0, 10 - used - 2) * 64;
      }
      stowMany(keep: Record<string, number>) {
        const stowed: Record<string, number> = {};
        for (const [k, n] of Object.entries(keep)) {
          const m = Math.max(0, bot.inv.count(k) - n);
          if (m <= 0) continue;
          bot.inv.add(k, -m);
          this.boxed.set(k, (this.boxed.get(k) ?? 0) + m);
          stowed[k] = m;
        }
        this.calls.push(`stowMany ${Object.entries(stowed).map(([k, v]) => `${v} ${k}`).join(', ')}`);
        return Promise.resolve({ stowed, boxes: 1 });
      }
    }
    const sup = new RoomSupply(bot, { dead_fire_coral_block: 99 });
    const r = new BuildRunner(p, { ...bot.deps(), supply: sup });
    expect(await r.run()).toEqual({ state: 'done' });
    expect(r.stats.placed).toBe(11);
    expect(sup.calls[0]).toBe('stowMany 512 green_wool');
    expect(sup.calls[1]).toMatch(/^ensure dead_fire_coral_block/);
  });
});

describe('build materials with carried boxes', () => {
  it('the boxes count; the line says what comes out of them', () => {
    const w = new FlatWorld();
    const p = planBuild(w, spec(`fill 2 ${F} 2 6 ${F + 2} 6 cobblestone`), { start: START });
    const inv = new FakeInventory({ cobblestone: 20, dirt: 16 });
    expect(materialsOf(p, inv, { throwawayMin: 16 }).ok).toBe(false);
    const m = materialsOf(p, inv, { throwawayMin: 16 }, (n) => (n === 'cobblestone' ? 100 : 0));
    expect(m.ok).toBe(true);
    expect(m.lines[0]).toEqual({ item: 'cobblestone', need: 75, have: 120, missing: 0, boxed: 100 });
    expect(materialsLine(p.spec.label, m)).toBe('materials for fill 5x3x5 cobblestone: 75 cobblestone; have everything (out of my shulker boxes as needed: 55 cobblestone)');
  });
});

describe('build runner with carried boxes', () => {
  it('out of cobblestone on the ground: the rest of the build out of a box, off the footprint; the build completes', async () => {
    const w = new FlatWorld();
    const p = planBuild(w, spec(`fill 2 ${F} 2 6 ${F + 2} 6 cobblestone`), { start: START });
    const bot = new FakeBot(w, new FakeInventory({ cobblestone: 20, dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const sup = new FakeSupply(bot, { cobblestone: 100 });
    let avoidOk = false;
    const deps = { ...bot.deps(), supply: sup };
    const ensure = sup.ensure.bind(sup);
    sup.ensure = (n, t, o) => {
      avoidOk = !!o.avoid?.({ x: 2, y: F, z: 2 }) && !o.avoid({ x: 0, y: F, z: 0 }); // a build cell yes, the bot's start no
      return ensure(n, t, o);
    };
    const r = new BuildRunner(p, deps);
    expect(await r.run()).toEqual({ state: 'done' });
    expect(r.stats.placed).toBe(75);
    expect(sup.calls).toEqual(['ensure cobblestone 55 at y 0']);
    expect(avoidOk).toBe(true);
    expect(sup.boxed.get('cobblestone')).toBe(45);
    expect(r.stats).toMatchObject({ refills: 1, refilled: 55 });
    expect(bot.inv.count('dirt')).toBe(16);
  });

  it('a pillar: the column top block and the scaffold block come out of the boxes on the ground, the scaffold goes back at the end', async () => {
    const w = new FlatWorld();
    const p = planBuild(w, spec(`pillar 3 ${F} 0 7 cobblestone`), { start: START });
    const bot = new FakeBot(w, new FakeInventory({ cobblestone: 6 }), { x: 0.5, y: F, z: 0.5 });
    bot.throwawayMin = 0;
    const sup = new FakeSupply(bot, { cobblestone: 10, dirt: 64 });
    const r = new BuildRunner(p, { ...bot.deps(), supply: sup });
    expect(await r.run()).toEqual({ state: 'done' });
    for (let y = F; y < F + 7; y++) expect(w.name({ x: 3, y, z: 0 })).toBe('cobblestone');
    // every refill on the ground (y 0), none from the column top
    expect(sup.calls.filter((c) => c.startsWith('ensure')).every((c) => c.endsWith('at y 0'))).toBe(true);
    expect(sup.calls).toContain('ensure cobblestone 1 at y 0');
    expect(r.stats.placed).toBe(7);
    // the scaffold block (dirt: a kind the build does not use) came back when the column was dug: stowed again
    expect(sup.calls).toEqual(['ensure cobblestone 1 at y 0', 'ensure dirt/cobbled_deepslate/netherrack/cobblestone 2 at y 0', 'stow cobblestone/dirt/cobbled_deepslate/netherrack keep 0: 1']);
    expect(bot.inv.count('dirt')).toBe(0);
    expect(sup.boxed.get('dirt')).toBe(64);
    expect(w.name({ x: 2, y: F, z: 0 })).toBe('air'); // the scaffold column is gone
  });

  it('a refill takes no more than fits loose (a big wall must not fill the inventory)', async () => {
    const w = new FlatWorld();
    const p = planBuild(w, spec(`fill 2 ${F} 2 6 ${F + 2} 6 cobblestone`), { start: START });
    const bot = new FakeBot(w, new FakeInventory({ cobblestone: 20, dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const sup = new FakeSupply(bot, { cobblestone: 100 });
    const room = Object.assign(sup, { room: () => 30 });
    const r = new BuildRunner(p, { ...bot.deps(), supply: room });
    const end = await r.run();
    expect(sup.calls[0]).toBe('ensure cobblestone 30 at y 0'); // 55 needed, 30 fit
    expect(end).toEqual({ state: 'done' }); // refilled again when out
    expect(sup.calls.filter((c) => c.startsWith('ensure'))).toEqual(['ensure cobblestone 30 at y 0', 'ensure cobblestone 25 at y 0']); // the remaining 25
  });

  it('!stop (a pause) during a refill: the run after it recovers the box first (on the ground)', async () => {
    const w = new FlatWorld();
    const p = planBuild(w, spec(`fill 2 ${F} 2 6 ${F + 2} 6 cobblestone`), { start: START });
    const bot = new FakeBot(w, new FakeInventory({ cobblestone: 20, dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const sup = new FakeSupply(bot, { cobblestone: 100 });
    const r = new BuildRunner(p, { ...bot.deps(), supply: sup });
    const ensure = sup.ensure.bind(sup);
    let paused = false;
    sup.ensure = (n, t, o) => {
      if (!paused) {
        paused = true;
        r.pause(); // the box stays behind (the fake's ensure gives nothing)
        return Promise.resolve({ ok: false, loose: 0, fromBoxes: 0, reason: 'interrupted' });
      }
      return ensure(n, t, o);
    };
    const recovered: string[] = [];
    Object.assign(sup, {
      recover: () => {
        recovered.push(`recover at y ${bot.feet.y - F}`);
        return Promise.resolve();
      },
    });
    expect(await r.run()).toEqual({ state: 'paused' });
    expect(recovered).toEqual(['recover at y 0']);
    expect(await r.run()).toEqual({ state: 'done' });
    expect(recovered).toEqual(['recover at y 0', 'recover at y 0']);
    expect(r.stats.placed).toBe(75);
  });

  it('paused on a column top: the run after it does not recover boxes there (no walk off the column); the column completes', async () => {
    const w = new FlatWorld();
    const p = planBuild(w, spec(`pillar 3 ${F} 0 7 cobblestone`), { start: START });
    const bot = new FakeBot(w, new FakeInventory({ cobblestone: 7, dirt: 64 }), { x: 0.5, y: F, z: 0.5 });
    bot.throwawayMin = 0;
    const sup = new FakeSupply(bot, {});
    const recovered: number[] = [];
    Object.assign(sup, {
      recover: () => {
        recovered.push(bot.feet.y - F);
        bot.feet = { x: 12.5, y: F, z: 12.5 }; // a box left far away: the walk to it
        return Promise.resolve();
      },
    });
    const r = new BuildRunner(p, { ...bot.deps(), supply: sup });
    let paused = false;
    bot.onStep = () => {
      if (!paused && bot.feet.y > F) {
        paused = true;
        r.pause();
      }
    };
    expect(await r.run()).toEqual({ state: 'paused' });
    const top = bot.feet.y - F;
    expect(top).toBe(1); // on the pillar
    expect(await r.run()).toEqual({ state: 'done' });
    expect(recovered).toEqual([0]); // the first run only (on the ground); never on the column
    for (let y = F; y < F + 7; y++) expect(w.name({ x: 3, y, z: 0 })).toBe('cobblestone');
    expect(r.stats.placed).toBe(7);
  });

  it('nothing more fits loose but the boxes hold it: the stop says the inventory is full', async () => {
    const w = new FlatWorld();
    const p = planBuild(w, spec(`fill 2 ${F} 2 6 ${F + 2} 6 cobblestone`), { start: START });
    const bot = new FakeBot(w, new FakeInventory({ cobblestone: 20, dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const sup = Object.assign(new FakeSupply(bot, { cobblestone: 100 }), { room: () => 0 });
    const r = new BuildRunner(p, { ...bot.deps(), supply: sup });
    expect(await r.run()).toEqual({ state: 'stopped', reason: 'my inventory is full (my shulker boxes still hold 100 cobblestone)' });
  });

  it('without a supply nothing changes: out of a block stops the build', async () => {
    const w = new FlatWorld();
    const p = planBuild(w, spec(`fill 2 ${F} 2 6 ${F + 2} 6 cobblestone`), { start: START });
    const bot = new FakeBot(w, new FakeInventory({ cobblestone: 20, dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const r = new BuildRunner(p, bot.deps());
    expect(await r.run()).toEqual({ state: 'stopped', reason: 'out of cobblestone' });
  });
});
