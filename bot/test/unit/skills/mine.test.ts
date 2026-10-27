// Legit mining (PLAN.md task 7.14, Track U): exposure rule, ore memory, line of sight, target names,
// and the MineTask loop against a fake world and fake skills.
import { describe, expect, it } from 'vitest';
import { MineTask, eyeGoal, hasPickaxe, needsPickaxe, resolveTargets, type MineDeps } from '../../../src/skills/mine/miner.ts';
import { OreMemory, firstHit, isExposed, lineOfSight } from '../../../src/skills/mine/seen.ts';
import { blockInfoOf } from '../../../src/skills/terrain/shapes.ts';
import type { BlockInfo, ItemStack, Vec3 } from '../../../src/world/types.ts';

const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;

/** Solid stone everywhere in |x|,|z| <= 20, -20 <= y <= 20, except what is set; outside: unloaded. */
class Rock {
  readonly blocks = new Map<string, BlockInfo>();
  private fns: ((p: Vec3, before: BlockInfo | undefined, after: BlockInfo) => void)[] = [];
  set(p: Vec3, name: string): void {
    const before = this.blockAt(p);
    const after = blockInfoOf(name);
    this.blocks.set(key(p), after);
    for (const fn of this.fns) fn(p, before, after);
  }
  /** Set without block-update events (as decoded with a chunk). */
  load(p: Vec3, name: string): void {
    this.blocks.set(key(p), blockInfoOf(name));
  }
  fill(a: Vec3, b: Vec3, name: string): void {
    for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) for (let z = a.z; z <= b.z; z++) this.load({ x, y, z }, name);
  }
  blockAt(p: Vec3): BlockInfo | undefined {
    if (Math.abs(p.x) > 20 || Math.abs(p.z) > 20 || Math.abs(p.y) > 20) return undefined;
    return this.blocks.get(key(p)) ?? blockInfoOf('stone');
  }
  find(pred: (b: BlockInfo, p: Vec3) => boolean): Vec3[] {
    const out: Vec3[] = [];
    for (const [k, b] of this.blocks) {
      const [x, y, z] = k.split(',').map(Number) as [number, number, number];
      if (pred(b, { x, y, z })) out.push({ x, y, z });
    }
    return out;
  }
  onBlockUpdate(fn: (p: Vec3, before: BlockInfo | undefined, after: BlockInfo) => void): () => void {
    this.fns.push(fn);
    return () => (this.fns = this.fns.filter((f) => f !== fn));
  }
}

/** A corridor x -8..8, y 0..2, z -1..1 of air in the rock. */
function cave(): Rock {
  const r = new Rock();
  r.fill({ x: -8, y: 0, z: -1 }, { x: 8, y: 2, z: 1 }, 'air');
  return r;
}

describe('exposure and ore memory', () => {
  it('records exposed ores only; buried ones never; a dug neighbour exposes', () => {
    const r = cave();
    r.load({ x: 2, y: 1, z: -2 }, 'coal_ore'); // wall, exposed
    r.load({ x: 4, y: 1, z: -4 }, 'coal_ore'); // two deep
    r.load({ x: -3, y: 3, z: 0 }, 'iron_ore'); // ceiling, exposed
    const at = (p: Vec3) => r.blockAt(p);
    expect(isExposed(at, { x: 2, y: 1, z: -2 })).toBe(true);
    expect(isExposed(at, { x: 4, y: 1, z: -4 })).toBe(false);
    const m = new OreMemory(r);
    m.scan({ x: 0, y: 1, z: 0 }, 32);
    expect(m.all().map((o) => key(o.p)).sort()).toEqual(['-3,3,0', '2,1,-2']);
    expect(m.lastBuried).toBe(1);
    // digging the wall block in front of the buried ore: (4,1,-2), then (4,1,-3) exposes it
    r.set({ x: 4, y: 1, z: -2 }, 'air');
    expect(m.has({ x: 4, y: 1, z: -4 })).toBe(false);
    r.set({ x: 4, y: 1, z: -3 }, 'air');
    expect(m.has({ x: 4, y: 1, z: -4 })).toBe(true);
    // a mined ore is forgotten
    r.set({ x: 2, y: 1, z: -2 }, 'air');
    expect(m.has({ x: 2, y: 1, z: -2 })).toBe(false);
    // water is not air: an ore facing only water is not seen
    r.load({ x: 6, y: 1, z: -2 }, 'coal_ore');
    r.set({ x: 6, y: 1, z: -1 }, 'water');
    expect(isExposed(at, { x: 6, y: 1, z: -2 })).toBe(false); // its only open face is behind water
    m.scan({ x: 0, y: 1, z: 0 }, 32);
    expect(m.has({ x: 6, y: 1, z: -2 })).toBe(false);
    m.dispose();
  });

  it('targets: only the asked names, nearest first, unloaded ones left out', () => {
    const r = cave();
    for (const x of [-6, 0, 5]) r.load({ x, y: 1, z: -2 }, 'coal_ore');
    r.load({ x: 1, y: 1, z: 2 }, 'iron_ore');
    const m = new OreMemory(r);
    m.scan({ x: 0, y: 1, z: 0 }, 32);
    expect(m.targets(new Set(['coal_ore']), { x: 4, y: 1, z: 0 }).map((o) => o.p.x)).toEqual([5, 0, -6]);
    expect(m.targets(new Set(['iron_ore']), { x: 0, y: 0, z: 0 })).toHaveLength(1);
  });

  it('line of sight: clear across the corridor, blocked through rock', () => {
    const r = cave();
    const at = (p: Vec3) => r.blockAt(p);
    r.load({ x: 2, y: 1, z: -2 }, 'coal_ore');
    expect(lineOfSight(at, { x: 2.5, y: 1.62, z: 1.5 }, { x: 2, y: 1, z: -2 }).clear).toBe(true);
    // from outside the cave (x 10, behind rock)
    const s = lineOfSight(at, { x: 10.5, y: 1.62, z: -1.5 }, { x: 2, y: 1, z: -2 });
    expect(s.clear).toBe(false);
    expect(s.blocker).toEqual({ x: 9, y: 1, z: -2 });
    expect(firstHit(at, { x: 0.5, y: 1.5, z: 0.5 }, { x: 0.5, y: 1.5, z: -1.5 }, { x: 0, y: 1, z: -2 })).toBeUndefined();
  });
});

describe('target names and tools', () => {
  it('resolves short names and deepslate twins', () => {
    expect([...resolveTargets('coal')].sort()).toEqual(['coal_ore', 'deepslate_coal_ore']);
    expect([...resolveTargets('minecraft:iron_ore')].sort()).toEqual(['deepslate_iron_ore', 'iron_ore']);
    expect([...resolveTargets('deepslate_gold_ore')].sort()).toEqual(['deepslate_gold_ore', 'gold_ore']);
    expect([...resolveTargets('stone')]).toEqual(['stone']);
    expect(needsPickaxe('coal_ore')).toBe(true);
    expect(needsPickaxe('dirt')).toBe(false);
    const it = (name: string): ItemStack => ({ name, networkId: 1, count: 1, metadata: 0 });
    expect(hasPickaxe([it('stone_pickaxe')])).toBe(true);
    expect(hasPickaxe([it('stone_axe'), null])).toBe(false);
    const g = eyeGoal({ x: 3, y: 5, z: -2 });
    expect(g).toEqual({ type: 'near', p: { x: 3.5, y: 5.5 - 1.62, z: -1.5 }, r: 3.5 });
  });
});

// ---- the loop ---------------------------------------------------------------------------------------

interface H {
  r: Rock;
  m: OreMemory;
  pos: Vec3;
  calls: string[];
  health: number;
  slots: (ItemStack | null)[];
  digFails: Set<string>;
  tunnel: number;
  deps: MineDeps;
}

function harness(r: Rock): H {
  const m = new OreMemory(r);
  const h: H = { r, m, pos: { x: 0.5, y: 0, z: 0.5 }, calls: [], health: 20, slots: [{ name: 'stone_pickaxe', networkId: 1, count: 1, metadata: 0 }], digFails: new Set(), tunnel: 0, deps: undefined as never };
  h.deps = {
    skills: {
      goto: (g) => {
        if (g.type !== 'near') throw new Error('near goals only');
        h.calls.push(`goto ${Math.floor(g.p.x)} ${Math.floor(g.p.z)}`);
        // stand in the corridor in front of the target column
        h.pos = { x: Math.max(-8, Math.min(8, Math.floor(g.p.x))) + 0.5, y: 0, z: Math.max(-1, Math.min(1, Math.floor(g.p.z))) + 0.5 };
        return Promise.resolve({ ok: true });
      },
      dig: (p) => {
        h.calls.push(`dig ${key(p)}`);
        if (h.digFails.has(key(p))) return Promise.resolve({ ok: false, reason: 'timeout' });
        r.set(p, 'air');
        return Promise.resolve({ ok: true, ticks: 23 });
      },
      // the sweeps for the job's own drops (filter set) find nothing in this world; the per-dig collect finds the drop
      collect: (_r: number, _t: number, o?: { filter?: unknown }) => {
        const gained: Record<string, number> = o?.filter ? {} : { coal: 1 };
        return Promise.resolve({ ok: true, gained, pickedUp: o?.filter ? 0 : 1, skipped: 0, ticks: o?.filter ? 1 : 5, corrections: 0 });
      },
      cancel: () => h.calls.push('cancel'),
    },
    memory: m,
    plan: () => ({ status: 'found', path: [{ act: { dig: Array.from({ length: h.tunnel }, () => ({ x: 0, y: 0, z: 0 })) } }] }),
    breakRule: (p) => {
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
        const n = r.blockAt({ x: p.x + dx, y: p.y + dy, z: p.z + dz });
        if (n?.name === 'lava' || n?.name === 'water') return 'next_to_liquid';
      }
      return undefined;
    },
    blockAt: (p) => r.blockAt(p),
    inventory: { slots: h.slots },
    position: () => h.pos,
    health: () => h.health,
    ready: () => true,
    waitTicks: () => Promise.resolve(),
  };
  return h;
}

describe('MineTask', () => {
  it('mines the seen ores nearest first, skips the lava-adjacent one, ignores the buried one', async () => {
    const r = cave();
    const exposed = [
      { x: -5, y: 1, z: -2 },
      { x: 3, y: 0, z: 2 },
      { x: 6, y: 2, z: -2 },
    ];
    for (const p of exposed) r.load(p, 'coal_ore');
    r.load({ x: 1, y: 0, z: -2 }, 'coal_ore');
    r.load({ x: 1, y: 0, z: -3 }, 'lava');
    r.load({ x: 0, y: 1, z: 4 }, 'coal_ore'); // buried
    const h = harness(r);
    const t = new MineTask({ ...h.deps, seenOnly: () => true }); // Track Z: the legit rule is the `mineSeenOnly` option
    const end = await t.start({ block: 'coal', count: 10 });
    expect(end).toBe('none_left');
    expect(t.stats.mined).toBe(3);
    expect(new Set(t.stats.minedAt.map(key))).toEqual(new Set(exposed.map(key)));
    expect(t.stats.targeted.map(key)).not.toContain('0,1,4');
    expect(t.stats.unsafe).toEqual([{ p: { x: 1, y: 0, z: -2 }, why: 'next_to_liquid' }]);
    expect(r.blockAt({ x: 0, y: 1, z: 4 })?.name).toBe('coal_ore');
    expect(t.stats.collected.coal).toBe(3);
  });

  it('stops at n, on low health and without a pickaxe', async () => {
    const r = cave();
    for (const x of [-6, -2, 2, 6]) r.load({ x, y: 1, z: -2 }, 'coal_ore');
    const h = harness(r);
    const t = new MineTask(h.deps);
    expect(await t.start({ block: 'coal_ore', count: 2 })).toBe('done');
    expect(t.stats.mined).toBe(2);
    h.health = 7;
    expect(await t.start({ block: 'coal_ore', count: 2 })).toBe('low_health');
    h.health = 20;
    h.slots.splice(0);
    expect(await t.start({ block: 'coal_ore', count: 2 })).toBe('no_pickaxe');
  });

  it('blacklists a target after 3 failures, and at once when its tunnel is longer than mineTunnelLen', async () => {
    const r = cave();
    r.load({ x: 2, y: 1, z: -2 }, 'coal_ore');
    r.load({ x: 7, y: 1, z: -2 }, 'coal_ore');
    const h = harness(r);
    h.digFails.add('2,1,-2');
    let len = 32;
    h.deps.tunnelLen = () => len;
    const t = new MineTask(h.deps);
    expect(await t.start({ block: 'coal_ore', count: 2 })).toBe('none_left');
    expect(t.stats.mined).toBe(1);
    expect(t.stats.blacklisted).toEqual([{ x: 2, y: 1, z: -2 }]);
    expect(h.calls.filter((c) => c === 'dig 2,1,-2')).toHaveLength(3);
    // tunnel cap
    r.load({ x: -7, y: 1, z: -2 }, 'coal_ore');
    h.tunnel = 5;
    len = 4;
    expect(await t.start({ block: 'coal_ore', count: 1 })).toBe('none_left');
    expect(t.stats.mined).toBe(0);
    expect(t.stats.blacklisted.map(key)).toContain('-7,1,-2');
  });

  it('digs a block in the line of sight first', async () => {
    const r = cave();
    // ore behind one stone, exposed to a pocket above it
    r.load({ x: 0, y: 1, z: -3 }, 'coal_ore');
    r.load({ x: 0, y: 2, z: -3 }, 'air');
    const h = harness(r);
    h.deps.skills.goto = () => {
      h.pos = { x: 0.5, y: 0, z: 0.5 }; // in the corridor, the stone at (0,1,-2) between
      return Promise.resolve({ ok: true });
    };
    const t = new MineTask(h.deps);
    expect(await t.start({ block: 'coal_ore', count: 1 })).toBe('done');
    expect(t.stats.sightDigs).toBe(1);
    expect(h.calls.filter((c) => c.startsWith('dig'))).toEqual(['dig 0,1,-2', 'dig 0,1,-3']);
  });

  it('walks next to the hole when the first collect picked nothing up', async () => {
    const r = cave();
    r.load({ x: 3, y: 1, z: -2 }, 'coal_ore'); // wall, head height: the drop stays in the hole
    const h = harness(r);
    let n = 0;
    const nothing: Record<string, number> = {};
    h.deps.skills.collect = (_r: number, _t: number, o?: { filter?: unknown }) => {
      if (o?.filter) return Promise.resolve({ ok: true, gained: nothing, pickedUp: 0, skipped: 0, ticks: 1, corrections: 0 }); // the drop sweeps see nothing
      return Promise.resolve({ ok: true, gained: n++ === 0 ? nothing : { coal: 1 }, pickedUp: n === 1 ? 0 : 1, skipped: 0, ticks: 5, corrections: 0 });
    };
    const gotos: string[] = [];
    h.deps.skills.goto = (g) => {
      gotos.push(g.type === 'block' ? `block ${key(g.p)}` : g.type);
      return Promise.resolve({ ok: true });
    };
    // the corridor floor cells are standable (feet y 0)
    h.deps.stand = (x, y, z) => (Math.abs(x) <= 8 && Math.abs(z) <= 1 && y === 0 ? 0 : NaN);
    h.pos = { x: 3.5, y: 0, z: 0.5 };
    const t = new MineTask(h.deps);
    expect(await t.start({ block: 'coal_ore', count: 1 })).toBe('done');
    expect(t.stats.pickupWalks).toBe(1);
    expect(gotos).toEqual(['block 3,0,-1']);
    expect(t.stats.collected.coal).toBe(1);
  });

  it('stop() cancels at once', async () => {
    const r = cave();
    r.load({ x: 3, y: 1, z: -2 }, 'coal_ore');
    const h = harness(r);
    let release: (() => void) | undefined;
    h.deps.skills.dig = () => new Promise((res) => (release = () => res({ ok: false, reason: 'interrupted' })));
    const t = new MineTask(h.deps);
    const run = t.start({ block: 'coal_ore', count: 1 });
    await new Promise((r2) => setTimeout(r2, 5));
    expect(t.state).toBe('dig');
    t.stop();
    expect(t.state).toBe('stopped');
    release?.();
    expect(await run).toBe('stopped');
    expect(h.calls.filter((c) => c === 'cancel')).toHaveLength(2);
  });

  // ---- Track Z ----

  it('mineSeenOnly off: a buried ore is a target too, dug to through the rock', async () => {
    const r = cave();
    r.load({ x: 0, y: 1, z: 4 }, 'coal_ore'); // buried two blocks behind the south wall
    const h = harness(r);
    h.pos = { x: 0.5, y: 0, z: 1.5 };
    const t = new MineTask({ ...h.deps, seenOnly: () => false });
    expect(await t.start({ block: 'coal_ore', count: 1 })).toBe('done');
    expect(t.stats.minedAt).toEqual([{ x: 0, y: 1, z: 4 }]);
    expect(t.stats.sightDigs).toBeGreaterThanOrEqual(1);
    // on: never
    r.load({ x: 2, y: 1, z: 4 }, 'coal_ore');
    const t2 = new MineTask({ ...harness(r).deps, seenOnly: () => true });
    expect(await t2.start({ block: 'coal_ore', count: 1 })).toBe('none_left');
  });

  it('an ore whose plan makes no progress is skipped after ONE plan and blacklisted for the session', async () => {
    const r = cave();
    r.load({ x: 5, y: 1, z: -2 }, 'coal_ore'); // nearest: "unreachable"
    r.load({ x: -7, y: 1, z: -2 }, 'coal_ore');
    const h = harness(r);
    const plans: string[] = [];
    const bl = new Set<string>();
    const deps: MineDeps = {
      ...h.deps,
      plan: (g) => {
        const near = g.type === 'near' && Math.floor(g.p.x) === 5;
        plans.push(near ? 'bad' : 'good');
        // the navigator's "no progress possible": a partial plan that never leaves the start node
        return near ? { status: 'partial', path: [{}] } : { status: 'found', path: [{}, {}] };
      },
      blacklist: { failBlock: (p) => (bl.add(key(p)), true), blocked: (p) => bl.has(key(p)), failures: 1 },
    };
    const t = new MineTask(deps);
    expect(await t.start({ block: 'coal_ore', count: 1 })).toBe('done');
    expect(t.stats.minedAt).toEqual([{ x: -7, y: 1, z: -2 }]);
    expect(plans.filter((p) => p === 'bad')).toHaveLength(1);
    expect(t.stats.unreachable).toEqual([{ x: 5, y: 1, z: -2 }]);
    expect(bl.has('5,1,-2')).toBe(true);
    expect(h.calls.filter((c) => c.startsWith('goto 5'))).toHaveLength(0);
    // the next run of the session skips it without planning
    plans.length = 0;
    r.load({ x: -6, y: 1, z: -2 }, 'coal_ore');
    expect(await t.start({ block: 'coal_ore', count: 1 })).toBe('done');
    expect(plans).not.toContain('bad');
  });

  it('a goto that never got a segment going marks the ore unreachable at once', async () => {
    const r = cave();
    r.load({ x: 5, y: 1, z: -2 }, 'coal_ore');
    const h = harness(r);
    let gotos = 0;
    h.deps.skills.goto = () => {
      gotos++;
      return Promise.resolve({ ok: false, reason: 'unreachable' });
    };
    h.deps.skills.status = () => ({ lastGoto: { actions: { dig: 0 }, segments: 0 } });
    const t = new MineTask(h.deps);
    expect(await t.start({ block: 'coal_ore', count: 1 })).toBe('none_left');
    expect(gotos).toBe(1);
    expect(t.stats.unreachable).toEqual([{ x: 5, y: 1, z: -2 }]);
  });

  it('pause() cancels the dig without counting a failure; resume() goes on', async () => {
    const r = cave();
    r.load({ x: 3, y: 1, z: -2 }, 'coal_ore');
    const h = harness(r);
    let first = true;
    const dig0 = h.deps.skills.dig.bind(h.deps.skills);
    let release: (() => void) | undefined;
    h.deps.skills.dig = (p, o) => {
      if (!first) return dig0(p, o);
      first = false;
      return new Promise((res) => (release = () => res({ ok: false, reason: 'interrupted' })));
    };
    const ticks: (() => void)[] = [];
    h.deps.waitTicks = () => new Promise((res) => ticks.push(res));
    const t = new MineTask(h.deps);
    const run = t.start({ block: 'coal_ore', count: 1 });
    await new Promise((r2) => setTimeout(r2, 5));
    expect(t.state).toBe('dig');
    t.pause();
    expect(t.state).toBe('paused');
    release?.();
    await new Promise((r2) => setTimeout(r2, 5));
    expect(t.stats.failures).toBe(0);
    t.resume();
    for (let i = 0; i < 20 && ticks.length; i++) {
      ticks.shift()!();
      await new Promise((r2) => setTimeout(r2, 1));
    }
    h.deps.waitTicks = () => Promise.resolve();
    for (const f of ticks.splice(0)) f();
    expect(await run).toBe('done');
    expect(t.stats.failures).toBe(0);
  });
});

describe('ore memory persisted in the world cache (Track Z)', () => {
  it('records flag the cache mark; recall() brings them back in a new memory without seeing them', () => {
    const r = cave();
    r.load({ x: 2, y: 1, z: -2 }, 'coal_ore');
    const marks = new Map<string, { x: number; y: number; z: number; name: string; exposed: boolean; seen?: boolean }>();
    marks.set('2,1,-2', { x: 2, y: 1, z: -2, name: 'coal_ore', exposed: true });
    const cache = {
      markSeen: (p: Vec3, name: string) => {
        const m = marks.get(key(p));
        if (m?.name !== name) return false;
        m.seen = true;
        return true;
      },
      seenMarks: () => [...marks.values()].filter((m) => m.seen),
      loadedMarks: () => [...marks.values()],
    };
    const world = Object.assign(r, { cache });
    const m1 = new OreMemory(world);
    m1.scan({ x: 0, y: 1, z: 0 }, 32);
    expect(m1.persisted).toBe(1);
    expect(marks.get('2,1,-2')?.seen).toBe(true);
    // "restart": a new memory, the ore now buried (the opening walled up) - it is still remembered
    r.fill({ x: 2, y: 1, z: -1 }, { x: 2, y: 1, z: -1 }, 'stone');
    const m2 = new OreMemory(world);
    expect(m2.recall({ x: 0, y: 1, z: 0 }, 64)).toBe(1);
    expect(m2.targets(new Set(['coal_ore']), { x: 0, y: 1, z: 0 }, { seenOnly: true }).map((o) => o.how)).toEqual(['cache']);
  });

  it('scanMarks records exposed marks of loaded columns only', () => {
    const r = cave();
    r.load({ x: 2, y: 1, z: -2 }, 'coal_ore');
    r.load({ x: 2, y: 1, z: -5 }, 'coal_ore'); // buried
    const cache = {
      markSeen: () => true,
      loadedMarks: () => [
        { x: 2, y: 1, z: -2, name: 'coal_ore', exposed: true },
        { x: 2, y: 1, z: -5, name: 'coal_ore', exposed: false },
      ],
    };
    const m = new OreMemory(Object.assign(r, { cache }));
    expect(m.scanMarks({ x: 0, y: 1, z: 0 }, 24)).toBe(1);
    expect(m.has({ x: 2, y: 1, z: -2 })).toBe(true);
    expect(m.has({ x: 2, y: 1, z: -5 })).toBe(false);
    expect(new OreMemory(cave()).scanMarks({ x: 0, y: 1, z: 0 }, 24)).toBe(-1);
  });
});
