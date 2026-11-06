// Branch mining (wave 9, Track AI; docs/mining.md "Branch mining"): the Y table, the layout geometry,
// and BranchRun / branchMore on a fake voxel world (stone everywhere unless set): the staircase to the
// ore's Y, the tunnel and branches, turns at water, the stop rules, the ore left to the miner, the
// return to the surface.
import { describe, expect, it } from 'vitest';
import type { ItemStack, Vec3 } from '../../../src/world/types.ts';
import type { MineState } from '../../../src/skills/mine/miner.ts';
import {
  attachBranch,
  BRANCH_EVERY,
  BRANCH_LEN,
  branchMore,
  branchRunOf,
  BranchRun,
  branchTarget,
  dirFromYaw,
  flatStep,
  oreBase,
  stairCells,
  stairStep,
  tunnelCells,
  TORCH_RESTOCK,
  turnLeft,
  turnRight,
  type BranchHost,
  type BranchTask,
} from '../../../src/skills/mine/branch.ts';

const k = (p: Vec3) => `${p.x},${p.y},${p.z}`;

/** Stone everywhere below `surface` (air above), with overrides. */
class Voxels {
  readonly cells = new Map<string, string>();
  readonly surface: number;
  constructor(surface = 64) {
    this.surface = surface;
  }
  get(p: Vec3): string {
    return this.cells.get(k(p)) ?? (p.y < this.surface ? 'stone' : 'air');
  }
  set(p: Vec3, name: string): void {
    this.cells.set(k(p), name);
  }
}

const LIQ = new Set(['water', 'lava']);
const OPEN = new Set(['air', 'torch']);

function fakeHost(w: Voxels, start: Vec3, over: Partial<BranchHost> = {}) {
  let pos = { x: start.x + 0.5, y: start.y, z: start.z + 0.5 };
  const dug: Vec3[] = [];
  const walks: Vec3[] = [];
  const said: string[] = [];
  const returns: { start: Vec3; why: string; pickups: readonly Vec3[] }[] = [];
  let health = 20;
  let slots: (ItemStack | null)[] = [{ name: 'iron_pickaxe', count: 1, networkId: 1, metadata: 0 }, { name: 'torch', count: 16, networkId: 2, metadata: 0 }];
  const free = (p: Vec3) => OPEN.has(w.get(p));
  const host: BranchHost = {
    dig: (p) => {
      const b = w.get(p);
      w.set(p, 'air');
      dug.push({ ...p });
      return Promise.resolve({ ok: true, block: b });
    },
    goto: (g) => {
      if (g.type !== 'block') return Promise.resolve({ ok: false, reason: 'unreachable' });
      const p = g.p;
      if (!free(p) || !free({ ...p, y: p.y + 1 }) || OPEN.has(w.get({ ...p, y: p.y - 1 }))) return Promise.resolve({ ok: false, reason: 'unreachable' });
      walks.push({ ...p });
      pos = { x: p.x + 0.5, y: p.y, z: p.z + 0.5 };
      return Promise.resolve({ ok: true });
    },
    place: (p) => {
      w.set(p, 'torch');
      return Promise.resolve({ ok: true });
    },
    breakRule: (p) => {
      const n = w.get(p);
      if (OPEN.has(n)) return 'air';
      if (LIQ.has(n)) return 'liquid';
      for (const [dx, dy, dz] of [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
      ] as const)
        if (LIQ.has(w.get({ x: p.x + dx, y: p.y + dy, z: p.z + dz }))) return 'next_to_liquid';
      if (w.get({ ...p, y: p.y + 1 }) === 'gravel') return 'gravity_above';
      return undefined;
    },
    floor: (p) => !OPEN.has(w.get(p)) && !LIQ.has(w.get(p)),
    free,
    blockAt: (p) => ({ name: w.get(p) }) as never,
    position: () => pos,
    health: () => health,
    slots: () => slots,
    branchY: () => 'auto',
    tunnelLen: () => 32,
    allowPlace: () => false,
    waitTicks: () => Promise.resolve(),
    say: (m) => said.push(m),
    returnUp: (s, why, pickups) => returns.push({ start: s, why, pickups }),
    ...over,
  };
  return {
    host,
    dug,
    walks,
    said,
    returns,
    setHealth: (h: number) => {
      health = h;
    },
    setSlots: (s: (ItemStack | null)[]) => {
      slots = s;
    },
    pos: () => pos,
  };
}

function fakeTask(names: string[], count = 3) {
  const fns = new Set<(s: MineState) => void>();
  const t = {
    names: new Set(names),
    state: 'scan' as MineState,
    stats: { mined: 0, startedAt: 1 as number | undefined },
    opts: { count },
    running: true,
    isPaused: false,
    onDone: (fn: (s: MineState) => void) => {
      fns.add(fn);
      return () => fns.delete(fn);
    },
    end: (s: MineState) => {
      t.running = false;
      t.state = s;
      for (const fn of [...fns]) fn(s);
    },
  };
  return t satisfies BranchTask & { end(s: MineState): void };
}

async function drive(run: BranchRun, max = 2000): Promise<number> {
  let n = 0;
  while (n < max && (await run.step())) n++;
  return n;
}

describe('branch mining: the Y table and the target', () => {
  it('maps every branch ore (and its deepslate / lit twins) to its base name', () => {
    expect(oreBase('iron_ore')).toBe('iron');
    expect(oreBase('deepslate_iron_ore')).toBe('iron');
    expect(oreBase('lit_deepslate_redstone_ore')).toBe('redstone');
    expect(oreBase('minecraft:lapis_ore')).toBe('lapis');
    expect(oreBase('nether_gold_ore')).toBeUndefined();
    expect(oreBase('ancient_debris')).toBeUndefined();
    expect(oreBase('stone')).toBeUndefined();
  });

  it('auto: the table; a number overrides; emerald only from the mountains; other blocks skip', () => {
    expect(branchTarget(['iron_ore', 'deepslate_iron_ore'], 'auto', 70)).toMatchObject({ y: 16, ore: 'iron' });
    expect(branchTarget(['coal_ore'], 'auto', 70)).toMatchObject({ y: 40 });
    expect(branchTarget(['copper_ore'], 'auto', 70)).toMatchObject({ y: 48 });
    expect(branchTarget(['gold_ore'], 'auto', 70)).toMatchObject({ y: -16 });
    expect(branchTarget(['redstone_ore'], 'auto', 70)).toMatchObject({ y: -58 });
    expect(branchTarget(['lapis_ore'], 'auto', 70)).toMatchObject({ y: 0 });
    expect(branchTarget(['diamond_ore'], 'auto', 70)).toMatchObject({ y: -58 });
    expect(branchTarget(['diamond_ore'], '-40', 70)).toMatchObject({ y: -40, why: 'mineBranchY -40' });
    expect(branchTarget(['emerald_ore'], 'auto', 70)).toHaveProperty('skip');
    expect(branchTarget(['emerald_ore'], 'auto', 250)).toMatchObject({ y: 232 });
    expect(branchTarget(['emerald_ore'], '100', 70)).toMatchObject({ y: 100 });
    expect(branchTarget(['stone'], 'auto', 70)).toEqual({ skip: 'not an ore for branch mining' });
  });

  it('yaw picks the first direction (Bedrock: 0 south, 90 west, 180 north, -90 east)', () => {
    expect(dirFromYaw(0)).toEqual([0, 1]);
    expect(dirFromYaw(90)).toEqual([-1, 0]);
    expect(dirFromYaw(180)).toEqual([0, -1]);
    expect(dirFromYaw(-180)).toEqual([0, -1]);
    expect(dirFromYaw(-90)).toEqual([1, 0]);
    expect(dirFromYaw(275)).toEqual([1, 0]);
    expect(dirFromYaw(undefined)).toEqual([1, 0]);
  });
});

describe('branch mining: layout geometry', () => {
  it('a step down clears the next column at the old head, the old feet and the new feet; never straight down', () => {
    const s = stairStep({ x: 0, y: 10, z: 0 }, [1, 0], -1);
    expect(s.feet).toEqual({ x: 1, y: 9, z: 0 });
    expect(s.dig).toEqual([
      { x: 1, y: 11, z: 0 },
      { x: 1, y: 10, z: 0 },
      { x: 1, y: 9, z: 0 },
    ]);
    expect(s.floor).toEqual({ x: 1, y: 8, z: 0 });
    for (const c of s.dig) expect(c.x).not.toBe(0);
  });

  it('a step up clears the head room above and the next column', () => {
    const s = stairStep({ x: 0, y: 10, z: 0 }, [0, 1], 1);
    expect(s.feet).toEqual({ x: 0, y: 11, z: 1 });
    expect(s.dig).toEqual([
      { x: 0, y: 12, z: 0 },
      { x: 0, y: 12, z: 1 },
      { x: 0, y: 11, z: 1 },
    ]);
  });

  it('tunnels are 2 high; branches every 3 blocks, 16 long, to both sides', () => {
    expect(flatStep({ x: 0, y: 16, z: 0 }, [0, -1]).dig).toEqual([
      { x: 0, y: 17, z: -1 },
      { x: 0, y: 16, z: -1 },
    ]);
    expect(stairCells({ x: 0, y: 70, z: 0 }, [1, 0], 16)).toHaveLength(54);
    const t = tunnelCells({ x: 0, y: 16, z: 0 }, [1, 0], 2);
    expect(t.main).toHaveLength(2 * BRANCH_EVERY);
    expect(t.branches).toHaveLength(4);
    expect(t.branches[0]![BRANCH_LEN - 1]!.feet).toEqual({ x: 3, y: 16, z: -16 });
    expect(t.branches[1]![BRANCH_LEN - 1]!.feet).toEqual({ x: 3, y: 16, z: 16 });
    expect(turnLeft([1, 0])).toEqual([0, -1]);
    expect(turnRight([1, 0])).toEqual([0, 1]);
  });
});

describe('branch mining: BranchRun on a fake world', () => {
  it('digs the staircase to the Y, then 3 main, a 16-block branch each side, and stops after mineTunnelLen blocks without a find', async () => {
    const w = new Voxels(64);
    const start = { x: 0, y: 64, z: 0 };
    const f = fakeHost(w, start);
    const task = fakeTask(['iron_ore', 'deepslate_iron_ore']);
    const run = new BranchRun(f.host, task, start, [1, 0], 'iron', 60);
    await drive(run);
    const s = run.stats;
    expect(s.stairSteps).toBe(4);
    expect(s.reachedYMs).toBeDefined();
    expect(s.end).toBe('exhausted');
    expect(s.mainLen + s.branchLen).toBe(32);
    expect(s.mainLen).toBe(3);
    expect(s.branches).toBe(2);
    expect(s.branchLen).toBe(29);
    // stairs: 3 cells each (the first two steps start in the air above the surface); tunnel 2 per block
    expect(s.dug).toBe(1 + 2 + 3 + 3 + 32 * 2);
    expect(f.pos().y).toBe(60);
    // never a cell straight under the feet: every dug cell is beside or above a walked cell
    for (const c of f.dug) expect(f.walks.some((p) => p.x === c.x && p.z === c.z && p.y - 1 === c.y)).toBe(false);
  });

  it('a find resets the count: the run goes on while the miner mines ore', async () => {
    const w = new Voxels(64);
    const f = fakeHost(w, { x: 0, y: 64, z: 0 }, { tunnelLen: () => 10 });
    const task = fakeTask(['coal_ore']);
    const run = new BranchRun(f.host, task, { x: 0, y: 64, z: 0 }, [1, 0], 'coal', 62);
    for (let i = 0; i < 12; i++) await run.step();
    task.stats.mined = 1; // the miner mined one
    await drive(run);
    expect(run.stats.finds).toBe(1);
    expect(run.stats.mainLen + run.stats.branchLen).toBeGreaterThan(10);
    expect(run.stats.sinceFind).toBe(10);
  });

  it('turns when a step would open a cell next to water; ends blocked when every way is', async () => {
    const w = new Voxels(64);
    w.set({ x: 3, y: 62, z: 0 }, 'water'); // next to the second step's cells (x 2)
    const f = fakeHost(w, { x: 0, y: 64, z: 0 });
    const run = new BranchRun(f.host, fakeTask(['iron_ore']), { x: 0, y: 64, z: 0 }, [1, 0], 'iron', 58);
    for (let i = 0; i < 6; i++) await run.step();
    expect(run.stats.turns).toBeGreaterThanOrEqual(1);
    expect(run.stats.blockedSteps[0]!.why).toMatch(/next_to_liquid/);
    for (const c of f.dug) expect(Math.abs(c.x - 3) + Math.abs(c.y - 62) + Math.abs(c.z)).toBeGreaterThan(1);
    // boxed in by lava on every side of the bottom
    const w2 = new Voxels(64);
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const)
      w2.set({ x: 2 * dx, y: 63, z: 2 * dz }, 'lava');
    const f2 = fakeHost(w2, { x: 0, y: 64, z: 0 });
    const run2 = new BranchRun(f2.host, fakeTask(['iron_ore']), { x: 0, y: 64, z: 0 }, [1, 0], 'iron', 50);
    await drive(run2);
    expect(run2.stats.end).toBe('blocked');
    expect(f2.dug).toHaveLength(0);
  });

  it('a step over a cave floor gap turns; gravel above a cell is never dug under', async () => {
    const w = new Voxels(64);
    w.set({ x: 1, y: 62, z: 0 }, 'air'); // no floor under the first step east
    w.set({ x: 0, y: 64, z: 1 }, 'gravel'); // gravel over the first step's top cell south (x 0, y 64? above 63)
    w.set({ x: 0, y: 65, z: 1 }, 'gravel');
    const f = fakeHost(w, { x: 0, y: 64, z: 0 });
    const run = new BranchRun(f.host, fakeTask(['iron_ore']), { x: 0, y: 64, z: 0 }, [1, 0], 'iron', 60);
    await run.step();
    expect(run.stats.blockedSteps.map((b) => b.why)).toEqual([expect.stringMatching(/no floor/), expect.stringMatching(/gravity_above/)]);
    expect(run.stats.stairSteps).toBe(1);
    expect(run.dir).toEqual([0, -1]);
  });

  it('stops below health 10 and without a pickaxe', async () => {
    const w = new Voxels(64);
    const f = fakeHost(w, { x: 0, y: 64, z: 0 });
    const run = new BranchRun(f.host, fakeTask(['iron_ore']), { x: 0, y: 64, z: 0 }, [1, 0], 'iron', 16);
    await run.step();
    f.setHealth(9);
    expect(await run.step()).toBe(false);
    expect(run.stats.end).toBe('low_health');
    const f2 = fakeHost(new Voxels(64), { x: 0, y: 64, z: 0 });
    f2.setSlots([null]);
    const run2 = new BranchRun(f2.host, fakeTask(['iron_ore']), { x: 0, y: 64, z: 0 }, [1, 0], 'iron', 16);
    expect(await run2.step()).toBe(false);
    expect(run2.stats.end).toBe('no_pickaxe');
  });

  it('leaves an ore in the way to the miner once, digs it the second time', async () => {
    const w = new Voxels(64);
    w.set({ x: 1, y: 63, z: 0 }, 'iron_ore');
    const f = fakeHost(w, { x: 0, y: 64, z: 0 });
    const run = new BranchRun(f.host, fakeTask(['iron_ore']), { x: 0, y: 64, z: 0 }, [1, 0], 'iron', 60);
    expect(await run.step()).toBe(true);
    expect(run.stats.stairSteps).toBe(0);
    expect(w.get({ x: 1, y: 63, z: 0 })).toBe('iron_ore');
    expect(await run.step()).toBe(true);
    expect(run.stats.stairSteps).toBe(1);
  });

  it('walks into the hole of a mined ore whose drop the miner left there, once', async () => {
    const w = new Voxels(64);
    const hole = { x: 0, y: 60, z: 2 };
    w.set(hole, 'air');
    w.set({ ...hole, y: 61 }, 'air');
    let items = 1;
    const f = fakeHost(w, { x: 0, y: 60, z: 0 }, { itemsNear: () => items });
    const task = { ...fakeTask(['iron_ore']), stats: { mined: 0, startedAt: 1, minedAt: [] as Vec3[] } };
    const run = new BranchRun(f.host, task, { x: 0, y: 60, z: 0 }, [1, 0], 'iron', 60);
    await run.step();
    expect(run.stats.pickupWalks).toBe(0);
    task.stats.mined = 1;
    task.stats.minedAt.push(hole);
    await run.step();
    expect(run.stats.pickupWalks).toBe(1);
    expect(f.walks).toContainEqual(hole);
    expect(run.leftDrops()).toEqual([hole]);
    items = 0;
    expect(run.leftDrops()).toEqual([]);
    await run.step();
    expect(run.stats.pickupWalks).toBe(1);
  });

  it('places a torch every 8 blocks of tunnel with allowPlace on', async () => {
    const w = new Voxels(64);
    const f = fakeHost(w, { x: 0, y: 60, z: 0 }, { allowPlace: () => true, tunnelLen: () => 20 });
    const run = new BranchRun(f.host, fakeTask(['iron_ore']), { x: 0, y: 60, z: 0 }, [1, 0], 'iron', 60);
    await drive(run);
    expect(run.stats.reachedYMs).toBeDefined();
    expect(run.stats.torches).toBe(2);
  });

  it('no torch loose: takes torches out of a carried box (once), then places them', async () => {
    const w = new Voxels(64);
    const f = fakeHost(w, { x: 0, y: 60, z: 0 }, { allowPlace: () => true, tunnelLen: () => 20 });
    const slots: (ItemStack | null)[] = [{ name: 'iron_pickaxe', count: 1, networkId: 1, metadata: 0 }];
    f.setSlots(slots);
    const asked: [string, number][] = [];
    f.host.restock = (item, n) => {
      asked.push([item, n]);
      slots[1] = { name: 'torch', count: n, networkId: 2, metadata: 0 };
      return Promise.resolve(true);
    };
    const run = new BranchRun(f.host, fakeTask(['iron_ore']), { x: 0, y: 60, z: 0 }, [1, 0], 'iron', 60);
    await drive(run);
    expect(asked).toEqual([['torch', TORCH_RESTOCK]]);
    expect(run.stats.torches).toBe(2);
  });
});

describe('branch mining: branchMore (the miner hook)', () => {
  it('does nothing without a host or for a block that is not a branch ore', async () => {
    const skills = {};
    expect(await branchMore(fakeTask(['iron_ore']), skills)).toBe(false);
    const f = fakeHost(new Voxels(64), { x: 0, y: 64, z: 0 });
    const off = attachBranch(skills, f.host);
    expect(await branchMore(fakeTask(['stone']), skills)).toBe(false);
    off();
  });

  it('runs one layout step per call, announces the run once, and walks back up when the run ends by itself', async () => {
    const skills = {};
    const f = fakeHost(new Voxels(64), { x: 0, y: 64, z: 0 }, { yaw: () => 0, tunnelLen: () => 4 });
    attachBranch(skills, f.host);
    const task = fakeTask(['iron_ore', 'deepslate_iron_ore']);
    let n = 0;
    while (await branchMore(task, skills)) n++;
    const run = branchRunOf(task)!;
    expect(run.dir).toEqual([0, 1]); // yaw 0: south
    expect(run.stats.targetY).toBe(16);
    expect(run.stats.stairSteps).toBe(48);
    expect(run.stats.end).toBe('exhausted');
    expect(n).toBeGreaterThan(48);
    expect(f.said[0]).toBe('branch mining iron_ore: none known, digging down to y 16 (staircase from 0 64 0)');
    task.end('none_left');
    expect(f.said[1]).toMatch(/^branch iron_ore: 0\/3 in \d+ s; iron at y 16: staircase 48 steps, tunnel 3 \+ 1 in 1 branches, 0 finds, 149 blocks dug, 4 blocks of tunnel without iron/);
    expect(f.returns).toEqual([{ start: { x: 0, y: 64, z: 0 }, why: 'exhausted', pickups: [] }]);
  });

  it('a stopped run (!stop) says nothing and does not walk back', async () => {
    const skills = {};
    const f = fakeHost(new Voxels(64), { x: 0, y: 64, z: 0 });
    attachBranch(skills, f.host);
    const task = fakeTask(['coal_ore']);
    await branchMore(task, skills);
    await branchMore(task, skills);
    task.end('stopped');
    expect(f.said).toHaveLength(1);
    expect(f.returns).toHaveLength(0);
  });
});
