// Track BJ (decision 0052, docs/build.md "Materials"): the build and the carried shulker boxes: the materials
// count what the boxes hold; the runner refills a block it ran out of on the ground (the box never on a cell of the
// build), tops up the column's places and scaffold blocks before a pillar (no box from a column top), and stows
// what it took out and did not use at the end.
import { describe, expect, it } from 'vitest';
import { materialsLine, materialsOf } from '../../../src/skills/build/materials.ts';
import { planBuild } from '../../../src/skills/build/plan.ts';
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

  it('without a supply nothing changes: out of a block stops the build', async () => {
    const w = new FlatWorld();
    const p = planBuild(w, spec(`fill 2 ${F} 2 6 ${F + 2} 6 cobblestone`), { start: START });
    const bot = new FakeBot(w, new FakeInventory({ cobblestone: 20, dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
    const r = new BuildRunner(p, bot.deps());
    expect(await r.run()).toEqual({ state: 'stopped', reason: 'out of cobblestone' });
  });
});
