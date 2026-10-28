// Mining v3 in the MineTask loop (wave 10 Track AQ; docs/mining.md, decision 0038) with fake skills on a
// voxel world: the cheap walk probe decides walk or tunnel (a long detour tunnels), a blocked tunnel skips
// the ore with the reason at once and digs nothing, a shaft and the way back up (pillar with throwaway
// blocks), veins mined as one group (status `vein n/m`, one collect over the group, the quota stops it),
// several kinds with quotas nearest first across kinds, `ores`, the chat and !get forms, the NL steps.
import { describe, expect, it } from 'vitest';
import { isJobDrop, jobDropNames, kindNames, MineTask, type MineDeps, type MinePlan } from '../../../src/skills/mine/miner.ts';
import { OreMemory } from '../../../src/skills/mine/seen.ts';
import type { TunnelWorld } from '../../../src/skills/mine/tunnel.ts';
import { blockInfoOf } from '../../../src/skills/terrain/shapes.ts';
import type { BlockInfo, ItemStack, Vec3 } from '../../../src/world/types.ts';
import { parseMineArgs, mineEndLine } from '../../../src/chat/commands-farm.ts';
import { lookupMulti, lookup } from '../../../src/skills/items/catalog.ts';
import { stepCommand, STEP_SCHEMAS } from '../../../src/nl/plan.ts';
import { MineProcess } from '../../../src/tasks/process/mine.ts';

const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;
const LIQ = new Set(['water', 'lava']);

/** Stone below y 0, air from y 0 up, in |x|, |z| <= 30, y -30..30; overrides; outside unloaded. */
class World {
  readonly blocks = new Map<string, BlockInfo>();
  private fns: ((p: Vec3, before: BlockInfo | undefined, after: BlockInfo) => void)[] = [];
  set(p: Vec3, name: string): void {
    const before = this.blockAt(p);
    const after = blockInfoOf(name);
    this.blocks.set(key(p), after);
    for (const fn of this.fns) fn(p, before, after);
  }
  load(p: Vec3, name: string): void {
    this.blocks.set(key(p), blockInfoOf(name));
  }
  fill(a: Vec3, b: Vec3, name: string): void {
    for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) for (let z = a.z; z <= b.z; z++) this.load({ x, y, z }, name);
  }
  blockAt(p: Vec3): BlockInfo | undefined {
    if (Math.abs(p.x) > 30 || Math.abs(p.z) > 30 || Math.abs(p.y) > 30) return undefined;
    return this.blocks.get(key(p)) ?? blockInfoOf(p.y < 0 ? 'stone' : 'air');
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

const open = (b: BlockInfo | undefined) => !!b && b.boxes.length === 0 && !LIQ.has(b.name);

function tworld(w: World): TunnelWorld {
  return {
    blockAt: (p) => w.blockAt(p),
    cell: (p) => {
      const b = w.blockAt(p);
      if (!b) return undefined;
      return { open: open(b), solid: b.boxes.length > 0 && !LIQ.has(b.name), liquid: LIQ.has(b.name), gravity: b.name === 'sand' || b.name === 'gravel', dripstone: b.name === 'pointed_dripstone' };
    },
    breakRule: (p) => {
      const b = w.blockAt(p);
      if (!b) return 'unknown';
      if (open(b)) return 'air';
      if (LIQ.has(b.name)) return 'liquid';
      if (b.name === 'stone_bricks') return 'protected';
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) if (LIQ.has(w.blockAt({ x: p.x + dx, y: p.y + dy, z: p.z + dz })?.name ?? '')) return 'next_to_liquid';
      return undefined;
    },
  };
}

interface H {
  w: World;
  pos: Vec3;
  calls: string[];
  collects: { r: number; origin?: Vec3; filter: boolean }[];
  throwaway: number;
  probe: MinePlan | undefined;
  deps: MineDeps;
}

function harness(w: World, start: Vec3 = { x: 0, y: 0, z: 0 }): H {
  const m = new OreMemory(w);
  const slots: (ItemStack | null)[] = [{ name: 'iron_pickaxe', networkId: 1, count: 1, metadata: 0 }];
  const tw = tworld(w);
  const h: H = { w, pos: { x: start.x + 0.5, y: start.y, z: start.z + 0.5 }, calls: [], collects: [], throwaway: 0, probe: { status: 'none', path: [] }, deps: undefined as never };
  const feet = () => ({ x: Math.floor(h.pos.x), y: Math.floor(h.pos.y), z: Math.floor(h.pos.z) });
  h.deps = {
    skills: {
      goto: (g, o) => {
        if (g.type === 'block') {
          h.calls.push(`goto block ${key(g.p)}${o?.allowPlace ? ' place' : ''}`);
          if (o?.allowPlace !== true && g.p.y > feet().y + 1) return Promise.resolve({ ok: false, reason: 'unreachable' }); // no way up without a pillar
          if (o?.allowPlace) h.throwaway -= Math.max(0, g.p.y - feet().y);
          h.pos = { x: g.p.x + 0.5, y: g.p.y, z: g.p.z + 0.5 };
          return Promise.resolve({ ok: true });
        }
        if (g.type === 'near') {
          h.calls.push(`goto near ${Math.floor(g.p.x)} ${Math.floor(g.p.z)}`);
          h.pos = { x: Math.floor(g.p.x) - 0.5, y: 0, z: Math.floor(g.p.z) + 0.5 };
          return Promise.resolve({ ok: true });
        }
        return Promise.resolve({ ok: false, reason: 'unreachable' });
      },
      dig: (p) => {
        h.calls.push(`dig ${key(p)}`);
        w.set(p, 'air');
        const f = feet();
        if (p.x === f.x && p.z === f.z && p.y === f.y - 1) h.pos = { ...h.pos, y: p.y }; // dug under the feet: drop
        return Promise.resolve({ ok: true, ticks: 8 });
      },
      collect: (r, _t, o) => {
        h.collects.push({ r, ...(o?.origin ? { origin: o.origin } : {}), filter: !!o?.filter });
        const gained: Record<string, number> = {};
        if (o?.origin) gained.diamond = 1;
        return Promise.resolve({ ok: true, gained, pickedUp: 0, skipped: 0, ticks: 1, corrections: 0 });
      },
      cancel: () => undefined,
    },
    memory: m,
    plan: () => ({ status: 'none', path: [] }),
    walkProbe: () => Promise.resolve(h.probe),
    tunnelWorld: tw,
    throwaways: () => h.throwaway,
    breakRule: (p) => {
      const r = tw.breakRule(p);
      if (r === 'air') return 'air';
      const f = feet();
      if (p.x === f.x && p.z === f.z && p.y === f.y - 1) return 'under_feet';
      return r;
    },
    stand: () => undefined,
    blockAt: (p) => w.blockAt(p),
    inventory: { slots },
    position: () => h.pos,
    health: () => 20,
    ready: () => true,
    waitTicks: () => Promise.resolve(),
  };
  return h;
}

/** A stone wall x 2..14, y 0..6, z -4..4 in front of the bot at the origin. */
function wall(): World {
  const w = new World();
  w.fill({ x: 2, y: 0, z: -4 }, { x: 14, y: 6, z: 4 }, 'stone');
  return w;
}

describe('approach: walk probe, then walk or tunnel', () => {
  it('no walk: a direct tunnel straight into the wall, the ore mined', async () => {
    const w = wall();
    w.load({ x: 9, y: 1, z: 0 }, 'coal_ore');
    const h = harness(w);
    const t = new MineTask(h.deps);
    expect(await t.start({ block: 'coal_ore', count: 1 })).toBe('done');
    expect(t.stats.tunnels[0]).toMatchObject({ mode: 'stairs', ok: true, dug: 14 });
    expect(t.stats.probes).toBe(1);
    expect(w.blockAt({ x: 9, y: 1, z: 0 })?.name).toBe('air');
    expect(h.calls.filter((c) => c.startsWith('goto near'))).toEqual([]);
  });

  it('a short walk: walked, no tunnel', async () => {
    const w = new World();
    w.load({ x: 6, y: 0, z: 0 }, 'coal_ore');
    const h = harness(w);
    h.probe = { status: 'found', path: [0, 1, 2, 3, 4].map((x) => ({ x, z: 0, feet: 0 })) };
    const t = new MineTask(h.deps);
    h.deps.plan = () => ({ status: 'found', path: [{}, {}] });
    expect(await t.start({ block: 'coal_ore', count: 1 })).toBe('done');
    expect(t.stats.tunnels).toEqual([]);
    expect(h.calls.some((c) => c.startsWith('goto near'))).toBe(true);
  });

  it('a long detour (more than 3 x the straight line + 8): the tunnel instead', async () => {
    const w = wall();
    w.load({ x: 9, y: 1, z: 0 }, 'coal_ore');
    const h = harness(w);
    const around = [...Array.from({ length: 30 }, (_, i) => ({ x: 0, z: -i, feet: 0 })), ...Array.from({ length: 30 }, (_, i) => ({ x: i, z: -30, feet: 0 }))];
    h.probe = { status: 'found', path: around };
    const t = new MineTask(h.deps);
    expect(await t.start({ block: 'coal_ore', count: 1 })).toBe('done');
    expect(t.stats.tunnels).toHaveLength(1);
  });

  it('a blocked tunnel skips the ore with the reason at once and digs nothing', async () => {
    const w = wall();
    w.load({ x: 9, y: 1, z: 0 }, 'coal_ore');
    w.load({ x: 5, y: 1, z: 0 }, 'stone_bricks');
    const h = harness(w);
    const t = new MineTask(h.deps);
    expect(await t.start({ block: 'coal_ore', count: 1 })).toBe('none_left');
    expect(t.stats.skipped[0]?.why).toMatch(/^tunnel blocked: protected at 5 1 0/);
    expect(t.stats.unreachable.map(key)).toEqual(['9,1,0']);
    expect(h.calls.filter((c) => c.startsWith('dig'))).toEqual([]);
    expect(t.lastError).toMatch(/protected/);
    expect(mineEndLine(t)).toMatch(/1 skipped: tunnel blocked: protected/);
  });

  it('mineDirect off: the walk approach as before (no tunnel)', async () => {
    const w = wall();
    w.load({ x: 9, y: 1, z: 0 }, 'coal_ore');
    const h = harness(w);
    const t = new MineTask({ ...h.deps, direct: () => false });
    expect(await t.start({ block: 'coal_ore', count: 1 })).toBe('none_left');
    expect(t.stats.tunnels).toEqual([]);
  });
});

describe('shaft and the way back up', () => {
  it('an ore 10 straight down: a shaft, then a pillar back up with the throwaway blocks', async () => {
    const w = new World();
    w.load({ x: 0, y: -11, z: 0 }, 'coal_ore');
    const h = harness(w);
    h.throwaway = 20;
    const t = new MineTask(h.deps);
    expect(await t.start({ block: 'coal_ore', count: 1 })).toBe('done');
    expect(t.stats.tunnels.map((x) => x.mode)).toEqual(['shaft', 'climb']);
    expect(t.stats.tunnels[1]).toMatchObject({ ok: true, placed: 11 });
    expect(h.pos.y).toBe(0);
    expect(h.calls).toContain('goto block 0,0,0 place');
  });

  it('without throwaway blocks: a staircase dug back up', async () => {
    const w = new World();
    w.load({ x: 0, y: -11, z: 0 }, 'coal_ore');
    const h = harness(w);
    const t = new MineTask(h.deps);
    expect(await t.start({ block: 'coal_ore', count: 1 })).toBe('done');
    expect(t.stats.tunnels.map((x) => x.mode)).toEqual(['shaft', 'climb']);
    expect(t.stats.tunnels[1]!.dug).toBeGreaterThan(0);
    expect(h.pos.y).toBe(0);
  });

  it('lava 2 under the ore: skipped with the reason', async () => {
    const w = new World();
    w.load({ x: 0, y: -11, z: 0 }, 'coal_ore');
    w.load({ x: 0, y: -13, z: 0 }, 'lava');
    const h = harness(w);
    const t = new MineTask(h.deps);
    expect(await t.start({ block: 'coal_ore', count: 1 })).toBe('none_left');
    expect(t.stats.skipped[0]?.why).toMatch(/liquid_below/);
    expect(h.calls.filter((c) => c.startsWith('dig'))).toEqual([]);
  });
});

describe('veins', () => {
  const vein = [
    { x: 2, y: 1, z: 0 },
    { x: 2, y: 0, z: 0 },
    { x: 3, y: 1, z: 0 },
    { x: 3, y: 2, z: 1 },
    { x: 4, y: 1, z: -1 },
  ];
  it('the whole group from where the bot stands, then one collect over it', async () => {
    const w = wall();
    for (const p of vein) w.load(p, 'diamond_ore');
    w.load({ x: 4, y: 0, z: -1 }, 'deepslate_diamond_ore'); // same kind
    const h = harness(w);
    h.probe = { status: 'found', path: [{ x: 0, z: 0, feet: 0 }] };
    h.deps.plan = () => ({ status: 'found', path: [{}, {}] });
    h.deps.skills.goto = (g) => {
      h.calls.push(`goto ${g.type}`);
      h.pos = { x: 1.5, y: 0, z: 0.5 };
      return Promise.resolve({ ok: true });
    };
    const t = new MineTask(h.deps);
    const seen: string[] = [];
    const dig = h.deps.skills.dig.bind(h.deps.skills);
    h.deps.skills.dig = (p, o) => {
      if (t.vein) seen.push(`${t.vein.done}/${t.vein.size}`);
      return dig(p, o);
    };
    expect(await t.start({ block: 'diamond', count: 6 })).toBe('done');
    expect(t.stats.mined).toBe(6);
    expect(t.stats.veins).toHaveLength(1);
    expect(t.stats.veins[0]).toMatchObject({ size: 6, mined: 6 });
    expect(seen[0]).toBe('1/6');
    expect(t.vein).toBeUndefined();
    // one collect over the group (origin at its centre), not one per block
    expect(h.collects.filter((c) => c.origin).length).toBe(1);
  });

  it('the quota ends the group: `!mine diamond 3` takes 3 of a vein of 5', async () => {
    const w = wall();
    for (const p of vein) w.load(p, 'diamond_ore');
    const h = harness(w);
    h.deps.skills.goto = () => {
      h.pos = { x: 1.5, y: 0, z: 0.5 };
      return Promise.resolve({ ok: true });
    };
    h.probe = { status: 'found', path: [{ x: 0, z: 0, feet: 0 }] };
    h.deps.plan = () => ({ status: 'found', path: [{}, {}] });
    const t = new MineTask(h.deps);
    expect(await t.start({ block: 'diamond_ore', count: 3 })).toBe('done');
    expect(t.stats.mined).toBe(3);
  });
});

describe('several kinds in one trip', () => {
  it('nearest first across kinds; a kind drops out when its quota is met; the counts', async () => {
    const w = new World();
    // on the floor along x: coal 3, iron 5, coal 7, diamond 9, iron 11
    const at = (x: number) => ({ x, y: 0, z: 0 });
    w.load(at(3), 'coal_ore');
    w.load(at(5), 'iron_ore');
    w.load(at(7), 'coal_ore');
    w.load(at(9), 'diamond_ore');
    w.load(at(11), 'iron_ore');
    const h = harness(w);
    h.probe = { status: 'found', path: [{ x: 0, z: 0, feet: 0 }] };
    h.deps.plan = () => ({ status: 'found', path: [{}, {}] });
    const t = new MineTask(h.deps);
    const end = await t.start({ block: 'iron_ore', count: 3, kinds: [{ block: 'iron_ore', count: 2 }, { block: 'coal_ore', count: 1 }, { block: 'diamond', count: 1 }] });
    expect(end).toBe('done');
    expect(t.opts?.count).toBe(4);
    // coal 3 first (nearest), then iron 5; coal 7 is skipped (coal's quota met), then diamond 9, iron 11
    expect(t.stats.minedAt.map((p) => p.x)).toEqual([3, 5, 9, 11]);
    expect(t.quotaLine()).toBe('iron 2/2, coal 1/1, diamond 1/1');
    expect(w.blockAt(at(7))?.name).toBe('coal_ore');
    expect(mineEndLine(t)).toBe('mine iron+coal+diamond: iron 2/2, coal 1/1, diamond 1/1 done');
    const p = new MineProcess(t, { block: 'iron_ore', count: 4 });
    expect(p.status().line).toMatch(/^mine: iron 2\/2, coal 1\/1, diamond 1\/1 \(/);
  });

  it('`ores` is every ore kind, deepslate twins included', () => {
    const n = kindNames('ores');
    for (const x of ['coal_ore', 'deepslate_iron_ore', 'diamond_ore', 'lit_redstone_ore', 'copper_ore']) expect(n.has(x), x).toBe(true);
    expect(n.has('stone')).toBe(false);
  });

  it('!mine arguments: one kind as before, several with a count each, errors', () => {
    expect(parseMineArgs(['coal_ore'])).toEqual({ kinds: [{ block: 'coal_ore', count: 1 }] });
    expect(parseMineArgs(['coal_ore', '8'])).toEqual({ kinds: [{ block: 'coal_ore', count: 8 }] });
    expect(parseMineArgs(['iron_ore', '8', 'coal_ore', '16', 'diamond_ore', '4'])).toEqual({
      kinds: [
        { block: 'iron_ore', count: 8 },
        { block: 'coal_ore', count: 16 },
        { block: 'diamond_ore', count: 4 },
      ],
    });
    expect(parseMineArgs(['ores', '32'])).toEqual({ kinds: [{ block: 'ores', count: 32 }] });
    expect('error' in parseMineArgs(['iron_ore', '8', 'coal_ore'])).toBe(true);
    expect('error' in parseMineArgs(['iron_ore', '8', 'iron', '4'])).toBe(true);
    expect('error' in parseMineArgs(['iron_ore', '0'])).toBe(true);
  });

  it('!get: several ores with a count each are one !mine; `ores n`; wood with ores is refused', () => {
    expect(lookupMulti(['iron', '8', 'coal', '16'])).toMatchObject({ command: 'mine iron_ore 8 coal_ore 16' });
    expect(lookupMulti(['8', 'iron', 'and', '16', 'coal'])).toMatchObject({ command: 'mine iron_ore 8 coal_ore 16' });
    expect(lookupMulti(['iron', '8'])).toBeUndefined();
    expect(lookupMulti(['iron', '8', 'oak_log', '4'])).toMatchObject({ error: 'several items in one !get are ores and mined blocks only (oak_log is gathering wood)' });
    expect(lookup('ores', 32)).toMatchObject({ strategy: 'mine', command: 'mine ores 32' });
  });

  it('the NL steps: mine and get with `more`', () => {
    const m = STEP_SCHEMAS.mine.parse({ command: 'mine', block: 'iron_ore', count: 8, more: [{ block: 'coal_ore', count: 64 }] });
    expect(stepCommand(m)).toBe('mine iron_ore 8 coal_ore 64');
    const g = STEP_SCHEMAS.get.parse({ command: 'get', item: 'iron', count: 8, more: [{ item: 'coal', count: 64 }] });
    expect(stepCommand(g)).toBe('get iron 8 coal 64');
  });
});

describe('job drops (a !get sand job picks up sand, not only ore drops)', () => {
  it('jobDropNames: the kinds themselves plus what they drop', () => {
    const d = jobDropNames(['sand', 'minecraft:stone', 'gravel', 'grass_block']);
    for (const n of ['sand', 'stone', 'cobblestone', 'gravel', 'flint', 'grass_block', 'dirt']) expect(d.has(n)).toBe(true);
    expect(d.has('coal')).toBe(false);
  });
  it('isJobDrop: ore drops always, the job kinds too, other items never', () => {
    const d = jobDropNames(['sand']);
    expect(isJobDrop(d, 'minecraft:sand')).toBe(true);
    expect(isJobDrop(d, 'raw_iron')).toBe(true);
    expect(isJobDrop(d, 'deepslate_coal_ore')).toBe(true);
    expect(isJobDrop(d, 'cobblestone')).toBe(false);
    expect(isJobDrop(d, 'rotten_flesh')).toBe(false);
  });
});
