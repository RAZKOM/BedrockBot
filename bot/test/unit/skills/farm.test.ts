// Farming (PLAN.md task 7.13, Track U): crop model, field scan, reach and trampling rules, and the
// FarmTask loop against a fake world and fake skills; plus the !farm / !mine chat parsing.
import { describe, expect, it } from 'vitest';
import type { Chat, CommandDef } from '../../../src/chat/chat.ts';
import { DEFAULT_FARM_RADIUS, registerFarmChat, type FarmController } from '../../../src/chat/commands-farm.ts';
import { CROPS, cropForSeed, fieldCell, growthOf, isMature, scanField } from '../../../src/skills/farm/crops.ts';
import { FarmTask, eyeAt, floorOf, routeTramples, workInReach, type FarmDeps, type FarmPlan } from '../../../src/skills/farm/farmer.ts';
import { blockInfoOf } from '../../../src/skills/terrain/shapes.ts';
import type { BlockInfo, ItemStack, Vec3 } from '../../../src/world/types.ts';

const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;
const SOIL = -61;
const FEET = -60;

class FakeWorld {
  readonly blocks = new Map<string, BlockInfo>();
  set(p: Vec3, name: string, states: Record<string, unknown> = {}): void {
    this.blocks.set(key(p), blockInfoOf(name, states));
  }
  blockAt(p: Vec3): BlockInfo {
    return this.blocks.get(key(p)) ?? (p.y < SOIL ? blockInfoOf('dirt') : p.y === SOIL ? blockInfoOf('grass_block') : blockInfoOf('air'));
  }
  find(pred: (b: BlockInfo, p: Vec3) => boolean): Vec3[] {
    const out: Vec3[] = [];
    for (const [k, b] of this.blocks) {
      const [x, y, z] = k.split(',').map(Number) as [number, number, number];
      if (pred(b, { x, y, z })) out.push({ x, y, z });
    }
    return out;
  }
}

class FakeInv {
  readonly slots: (ItemStack | null)[] = new Array<ItemStack | null>(36).fill(null);
  add(name: string, n: number): void {
    for (let left = n; left > 0; ) {
      let s = this.slots.findIndex((i) => i?.name === name && i.count < 64);
      if (s < 0) s = this.slots.findIndex((i) => !i);
      if (s < 0) return;
      const have = this.slots[s]?.count ?? 0;
      const put = Math.min(64 - have, left);
      this.slots[s] = { name, networkId: 1, count: have + put, metadata: 0 };
      left -= put;
    }
  }
  take(name: string, n = 1): boolean {
    const s = this.slots.findIndex((i) => i?.name === name);
    if (s < 0) return false;
    const i = this.slots[s]!;
    this.slots[s] = i.count > n ? { ...i, count: i.count - n } : null;
    return true;
  }
  freeSlots(): number[] {
    return this.slots.map((s, i) => (s ? -1 : i)).filter((i) => i >= 0);
  }
  count(name: string): number {
    return this.slots.reduce((a, s) => a + (s?.name === name ? s.count : 0), 0);
  }
}

/** A field of w x d farmland at (x0, SOIL, z0) with `crop` at `growth` (null = empty). */
function field(w: FakeWorld, x0: number, z0: number, wd: number, d: number, crop: string | null, growth = 7): void {
  for (let x = x0; x < x0 + wd; x++) {
    for (let z = z0; z < z0 + d; z++) {
      w.set({ x, y: SOIL, z }, 'farmland', { moisturized_amount: 7 });
      if (crop) w.set({ x, y: FEET, z }, crop, { growth });
    }
  }
}

describe('crops', () => {
  it('knows the four crops, their seeds and growth', () => {
    expect(Object.keys(CROPS).sort()).toEqual(['beetroot', 'carrots', 'potatoes', 'wheat']);
    expect(cropForSeed('carrot')?.block).toBe('carrots');
    expect(cropForSeed('wheat_seeds')?.produce).toBe('wheat');
    expect(growthOf(blockInfoOf('wheat', { growth: 5 }))).toBe(5);
    expect(growthOf(blockInfoOf('dirt'))).toBeUndefined();
    expect(isMature(blockInfoOf('potatoes', { growth: 7 }))).toBe(true);
    expect(isMature(blockInfoOf('beetroot', { growth: 6 }))).toBe(false);
  });

  it('classifies field cells and remembers the crop for empty ones', () => {
    const w = new FakeWorld();
    field(w, 0, 0, 3, 1, 'wheat', 7);
    w.set({ x: 1, y: FEET, z: 0 }, 'carrots', { growth: 2 });
    w.set({ x: 2, y: FEET, z: 0 }, 'air');
    w.set({ x: 3, y: SOIL, z: 0 }, 'farmland');
    w.set({ x: 3, y: FEET, z: 0 }, 'stone');
    const at = (p: Vec3) => w.blockAt(p);
    expect(fieldCell(at, { x: 0, y: SOIL, z: 0 }).state).toBe('mature');
    expect(fieldCell(at, { x: 1, y: SOIL, z: 0 })).toMatchObject({ state: 'growing', growth: 2, kind: CROPS.carrots });
    expect(fieldCell(at, { x: 3, y: SOIL, z: 0 }).state).toBe('blocked');
    const scan = scanField(at, (pred) => w.find(pred), { x: 1.5, y: FEET, z: 0.5 }, 4);
    expect(scan.cells).toHaveLength(4);
    expect(scan.mature).toHaveLength(1);
    expect(scan.growing).toHaveLength(1);
    // the empty cell takes the most common crop of the field (a tie: the first)
    expect(scan.empty).toHaveLength(1);
    expect(scan.empty[0]!.kind).toBeDefined();
    const mem = new Map([['2,-61,0', CROPS.beetroot!]]);
    expect(scanField(at, (pred) => w.find(pred), { x: 1.5, y: FEET, z: 0.5 }, 4, mem).empty[0]!.kind).toBe(CROPS.beetroot);
    // outside the radius
    expect(scanField(at, (pred) => w.find(pred), { x: 10.5, y: FEET, z: 0.5 }, 4).cells).toHaveLength(0);
  });
});

describe('reach and trampling rules', () => {
  const cell = (x: number, z: number) => fieldCell((p) => (p.y === SOIL ? blockInfoOf('farmland') : blockInfoOf('wheat', { growth: 7 })), { x, y: SOIL, z });

  it('reaches the middle of a 9-wide field from its edge for harvest and planting, with the planning margin only for harvest', () => {
    // field x 0..8; the bot stands on the grass at x = -1 (feet -60)
    const eye = eyeAt(-1, FEET, 4);
    expect(workInReach(eye, 'harvest', cell(4, 4), 0)).toBe(true);
    expect(workInReach(eye, 'plant', cell(4, 4), 0)).toBe(true);
    expect(workInReach(eye, 'plant', cell(4, 4), 0.35)).toBe(false); // 4.78 + margin > 5
    expect(workInReach(eye, 'harvest', cell(5, 4), 0)).toBe(false);
  });

  it('finds the floor block of a node and refuses drops onto farmland', () => {
    expect(floorOf(0, SOIL, 0, SOIL + 0.9375)).toEqual({ x: 0, y: SOIL, z: 0 }); // standing on farmland
    expect(floorOf(0, FEET, 0, FEET)).toEqual({ x: 0, y: SOIL, z: 0 });
    const w = new FakeWorld();
    w.set({ x: 2, y: SOIL, z: 0 }, 'farmland');
    const at = (p: Vec3) => w.blockAt(p);
    const path = (move: string, x: number, y: number, feet: number) => [{ x: 0, y: FEET + 1, z: 0, feet: FEET + 1, move: 'start' }, { x, y, z: 0, feet, move }];
    expect(routeTramples(path('drop', 2, SOIL, SOIL + 0.9375), at)).toBe(true);
    expect(routeTramples(path('walk', 2, SOIL, SOIL + 0.9375), at)).toBe(false);
    expect(routeTramples(path('drop', 3, FEET, FEET), at)).toBe(false); // onto grass
    // the 0.0625 step from grass onto farmland is a 'drop' for the planner, not a fall
    expect(routeTramples([{ x: 1, y: FEET, z: 0, feet: FEET, move: 'start' }, { x: 2, y: SOIL, z: 0, feet: SOIL + 0.9375, move: 'drop' }], at)).toBe(false);
  });
});

// ---- the loop ---------------------------------------------------------------------------------------

interface Harness {
  w: FakeWorld;
  inv: FakeInv;
  pos: Vec3;
  calls: string[];
  chest: Map<string, number>;
  deps: FarmDeps;
  boneMeal: boolean;
  /** goto targets whose route "drops onto farmland" (plan). */
  trampleAt: Set<string>;
}

function harness(): Harness {
  const w = new FakeWorld();
  const inv = new FakeInv();
  const h: Harness = { w, inv, pos: { x: -2.5, y: FEET, z: 0.5 }, calls: [], chest: new Map(), deps: undefined as never, boneMeal: true, trampleAt: new Set() };
  const skills: FarmDeps['skills'] = {
    goto: (g) => {
      const p = g.type === 'block' ? { x: g.p.x + 0.5, y: g.p.y, z: g.p.z + 0.5 } : g.type === 'near' ? { x: g.p.x, y: FEET, z: g.p.z } : { x: g.x, y: FEET, z: g.z };
      h.calls.push(`goto ${Math.floor(p.x)} ${Math.floor(p.z)}`);
      h.pos = p;
      return Promise.resolve({ ok: true });
    },
    dig: (p) => {
      const b = w.blockAt(p);
      h.calls.push(`dig ${p.x} ${p.z}`);
      w.set(p, 'air');
      if (b?.name === 'wheat' && Number(b.states.growth) >= 7) {
        inv.add('wheat', 1);
        inv.add('wheat_seeds', 2);
      }
      return Promise.resolve({ ok: true, block: b?.name, ticks: 1 });
    },
    place: (p, o) => {
      const item = String(o?.item);
      h.calls.push(`place ${p.x} ${p.z} ${item}`);
      if (!inv.take(item)) return Promise.resolve({ ok: false, reason: 'no_item' });
      w.set(p, cropForSeed(item)!.block, { growth: 0 });
      return Promise.resolve({ ok: true, ticks: 3 });
    },
    collect: () => Promise.resolve({ ok: true, gained: {}, pickedUp: 0, skipped: 0, ticks: 0, corrections: 0 }),
    open: () => Promise.resolve({ ok: true, view: { id: 2, slots: [] }, open: { id: 2, type: 'container', pos: { x: 0, y: 0, z: 0 } } as never }),
    deposit: (_v, filter) => {
      const moved: Record<string, number> = {};
      let total = 0;
      for (let s = 0; s < 36; s++) {
        const i = inv.slots[s];
        if (i && filter(i)) {
          moved[i.name] = (moved[i.name] ?? 0) + i.count;
          h.chest.set(i.name, (h.chest.get(i.name) ?? 0) + i.count);
          total += i.count;
          inv.slots[s] = null;
        }
      }
      return Promise.resolve({ ok: true, moved, total, requests: 1, errors: 0 });
    },
    closeContainer: () => Promise.resolve(true),
    cancel: () => h.calls.push('cancel'),
  };
  h.deps = {
    skills,
    plan: (g): FarmPlan => {
      const p = g.type === 'block' ? g.p : { x: 0, y: 0, z: 0 };
      return h.trampleAt.has(key(p)) ? { status: 'found', path: [{ x: -1, y: FEET + 1, z: 0, feet: FEET + 1, move: 'start' }, { x: 0, y: SOIL, z: 0, feet: SOIL + 0.9375, move: 'drop' }] } : { status: 'found', path: [] };
    },
    // the grass around the field is standable at feet -60, farmland at -60.0625 (node y -61)
    stand: (x, y, z) => {
      const floor = w.blockAt({ x, y, z });
      if (floor.name === 'farmland') return y + 0.9375;
      const below = w.blockAt({ x, y: y - 1, z });
      return y === FEET && floor.boxes.length === 0 && below.name !== 'farmland' ? y : NaN;
    },
    world: {
      blockAt: (p) => w.blockAt(p),
      find: (pred) => w.find(pred),
      inventory: inv,
    },
    click: (p, item) => {
      h.calls.push(`click ${p.x} ${p.z} ${item}`);
      const b = w.blockAt(p);
      if (item !== 'bone_meal' || !inv.take('bone_meal')) return Promise.resolve({ ok: false, reason: 'no_item' });
      w.set(p, b.name, { growth: Math.min(7, Number(b.states.growth) + 3) });
      return Promise.resolve({ ok: true });
    },
    position: () => h.pos,
    ready: () => true,
    waitTicks: () => {
      return new Promise((r) => setTimeout(r, 0));
    },
    useBoneMeal: () => h.boneMeal,
  };
  return h;
}

describe('FarmTask', () => {
  it('harvests a mature 3 x 3 field from off-field cells and replants every crop', async () => {
    const h = harness();
    field(h.w, 0, 0, 3, 3, 'wheat', 7);
    h.inv.add('wheat_seeds', 2);
    const f = new FarmTask(h.deps);
    const done = f.start({ center: { x: 1.5, y: FEET, z: 1.5 }, radius: 1, maxRounds: 3, waitTicks: 20 });
    expect(await done).toBe('idle');
    expect(f.stats.harvested).toBe(9);
    expect(f.stats.planted).toBe(9);
    for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) expect(h.w.blockAt({ x, y: FEET, z })).toMatchObject({ name: 'wheat', states: { growth: 0 } });
    // never stood on the farmland: every goto target is off the 3 x 3
    for (const c of h.calls.filter((c) => c.startsWith('goto'))) {
      const [, x, z] = c.split(' ').map(Number) as [number, number, number];
      expect(x >= 0 && x <= 2 && z >= 0 && z <= 2, c).toBe(false);
    }
    expect(h.inv.count('wheat')).toBe(9);
  });

  it('bone meals growing crops until mature, then harvests and replants; not with useBoneMeal() false', async () => {
    const h = harness();
    field(h.w, 0, 0, 1, 1, 'wheat', 0);
    h.inv.add('bone_meal', 5);
    h.boneMeal = false;
    const f = new FarmTask(h.deps);
    await f.start({ center: { x: 0.5, y: FEET, z: 0.5 }, radius: 0, maxRounds: 2, waitTicks: 20 });
    expect(f.stats.boneMealUsed).toBe(0);
    expect(f.stats.waits).toBe(2);
    h.boneMeal = true;
    await f.start({ center: { x: 0.5, y: FEET, z: 0.5 }, radius: 0, maxRounds: 4, waitTicks: 20 });
    // 0 -> 3 -> 6 -> 7 (3 bone meal), harvest, replant; then 2 more: 0 -> 3 -> 6, out of bone meal
    expect(f.stats.boneMealUsed).toBe(5);
    expect(f.stats.boneMealGrown).toBe(1);
    expect(f.stats.harvested).toBe(1);
    expect(f.stats.planted).toBe(1);
    expect(h.w.blockAt({ x: 0, y: FEET, z: 0 })).toMatchObject({ name: 'wheat', states: { growth: 6 } });
  });

  it('deposits crops and surplus seeds into the nearest chest when the inventory is full, keeping one seed stack', async () => {
    const h = harness();
    field(h.w, 0, 0, 2, 1, 'wheat', 7);
    h.w.set({ x: -4, y: FEET, z: 0 }, 'chest');
    for (let i = 0; i < 31; i++) h.inv.add('cobblestone', 64);
    h.inv.slots[31] = { name: 'wheat_seeds', networkId: 1, count: 64, metadata: 0 };
    h.inv.slots[32] = { name: 'wheat_seeds', networkId: 1, count: 10, metadata: 0 };
    h.inv.slots[33] = { name: 'wheat', networkId: 1, count: 5, metadata: 0 };
    const f = new FarmTask(h.deps);
    await f.start({ center: { x: 0.5, y: FEET, z: 0.5 }, radius: 2, maxRounds: 2, waitTicks: 20, minFreeSlots: 3 });
    expect(f.stats.trips).toBeGreaterThanOrEqual(1);
    expect(h.chest.get('wheat')).toBeGreaterThanOrEqual(5);
    expect(h.chest.get('wheat_seeds')).toBeGreaterThanOrEqual(10); // the 10-stack, and later surplus
    expect(h.chest.get('cobblestone')).toBeUndefined();
    expect(h.inv.count('wheat_seeds')).toBeGreaterThanOrEqual(62);
  });

  it('refuses a standing cell whose route drops onto farmland', async () => {
    const h = harness();
    field(h.w, 0, 0, 1, 1, 'wheat', 7);
    const f = new FarmTask(h.deps);
    // every standing cell but the one east of the crop has a route that drops onto farmland
    h.pos = { x: 2.5, y: FEET, z: 0.5 };
    for (let z = -4; z <= 4; z++) for (let x = -4; x <= 4; x++) if (!(x === 1 && z === 0)) h.trampleAt.add(key({ x, y: FEET, z }));
    await f.start({ center: { x: 0.5, y: FEET, z: 0.5 }, radius: 0, maxRounds: 1, waitTicks: 20 });
    expect(f.stats.trampleRoutesRefused).toBeGreaterThan(0);
    expect(f.stats.harvested).toBe(1);
    const g = h.calls.find((c) => c.startsWith('goto'))!;
    expect(g).toBe('goto 1 0');
  });

  it('stop() ends the loop and cancels the skills', async () => {
    const h = harness();
    field(h.w, 0, 0, 1, 1, 'wheat', 2);
    h.boneMeal = false;
    const f = new FarmTask(h.deps);
    const run = f.start({ center: { x: 0.5, y: FEET, z: 0.5 }, radius: 0, waitTicks: 1_000_000 });
    await new Promise((r) => setTimeout(r, 5));
    expect(f.state).toBe('waiting');
    f.stop();
    expect(await run).toBe('stopped');
    expect(h.calls).toContain('cancel');
  });

  // ---- Track Z ----

  it('harvests everything in reach first and waits for a fresh seed drop next to the body before planting', async () => {
    const h = harness();
    field(h.w, 0, 0, 3, 1, 'wheat', 7);
    h.inv.add('wheat_seeds', 4);
    const ents = new Map<bigint, { type: string; pos: Vec3; item?: ItemStack }>();
    (h.deps.world as { entities?: typeof ents }).entities = ents;
    const dig0 = h.deps.skills.dig.bind(h.deps.skills);
    let n = 0n;
    h.deps.skills.dig = async (p, o) => {
      const r = await dig0(p, o);
      // the drop lands on the body: picked up after a few ticks
      const id = ++n;
      ents.set(id, { type: 'minecraft:item', pos: { ...h.pos }, item: { name: 'wheat_seeds', networkId: 1, count: 1, metadata: 0 } });
      setTimeout(() => ents.delete(id), 15);
      return r;
    };
    const f = new FarmTask(h.deps);
    expect(await f.start({ center: { x: 1.5, y: FEET, z: 0.5 }, radius: 1, maxRounds: 2, waitTicks: 20 })).toBe('idle');
    expect(f.stats.planted).toBe(3);
    expect(f.stats.settleTicks).toBeGreaterThan(0);
    const order = h.calls.filter((c) => c.startsWith('dig') || c.startsWith('place')).map((c) => c.split(' ')[0]);
    expect(order.indexOf('place')).toBeGreaterThan(order.lastIndexOf('dig'));
  });

  it('pause() cancels the running skill and holds the loop; resume() goes on', async () => {
    const h = harness();
    field(h.w, 0, 0, 3, 3, 'wheat', 7);
    h.inv.add('wheat_seeds', 2);
    const f = new FarmTask(h.deps);
    const run = f.start({ center: { x: 1.5, y: FEET, z: 1.5 }, radius: 1, maxRounds: 3, waitTicks: 20 });
    f.pause();
    expect(f.state).toBe('paused');
    expect(h.calls).toContain('cancel');
    await new Promise((r) => setTimeout(r, 20));
    const harvested = f.stats.harvested;
    await new Promise((r) => setTimeout(r, 20));
    expect(f.stats.harvested).toBe(harvested);
    expect(f.state).toBe('paused');
    f.resume();
    expect(await run).toBe('idle');
    expect(f.stats.harvested).toBe(9);
    expect(f.stats.planted).toBe(9);
    expect(f.stats.pauses).toBe(1);
  });
});

describe('!farm as a process (Track Z)', () => {
  it('is pre-empted by a higher process, resumed afterwards, and !stop-able', async () => {
    const { ProcessManager, BaseProcess, PRIORITY } = await import('../../../src/tasks/process/manager.ts');
    const { FarmProcess } = await import('../../../src/tasks/process/farm.ts');
    class Guard extends BaseProcess {
      readonly name = 'guard';
      readonly kind = 'auto' as const;
      on = false;
      get priority(): number {
        return PRIORITY.guard;
      }
      override wants(): boolean {
        return this.on;
      }
      protected run(): void {}
      protected halt(): void {}
      status() {
        return { line: 'guard' };
      }
    }
    const pm = new ProcessManager();
    const g = pm.add(new Guard());
    const h = harness();
    field(h.w, 0, 0, 3, 3, 'wheat', 7);
    h.inv.add('wheat_seeds', 2);
    const f = new FarmTask(h.deps);
    const p = pm.add(new FarmProcess(f, { center: { x: 1.5, y: FEET, z: 1.5 }, radius: 1, waitTicks: 20 }));
    expect(pm.stack().map((e) => `${e.name}:${e.state}`)).toEqual(['farm:active']);
    g.on = true;
    pm.tick();
    expect(pm.stack().map((e) => `${e.name}:${e.state}`)).toEqual(['guard:active', 'farm:paused']);
    expect(f.state).toBe('paused');
    g.on = false;
    pm.tick();
    expect(pm.stack()[0]).toMatchObject({ name: 'farm', state: 'active' });
    for (let i = 0; i < 200 && f.stats.planted < 9; i++) await new Promise((r) => setTimeout(r, 2));
    expect(f.stats.harvested).toBe(9);
    expect(f.stats.planted).toBe(9);
    expect(p.status().line).toMatch(/^farm r=1 at 1 -60 1: 9 harvested, 9 planted/);
    expect(pm.stopUser()).toHaveLength(1);
    expect(await p.result).toBe('stopped');
    expect(f.state).toBe('stopped');
  });
});

describe('!farm and !mine', () => {
  function fakeChat() {
    const defs = new Map<string, CommandDef>();
    const chat = { register: (d: CommandDef) => defs.set(d.name, d) } as unknown as Chat;
    const run = (name: string, args: string[]) => {
      const out: string[] = [];
      defs.get(name)!.run({ line: {} as never, sender: { kind: 'console' }, args, reply: (m) => out.push(m) });
      return out;
    };
    return { chat, run, defs };
  }

  it('without walking both say so', () => {
    const c = fakeChat();
    registerFarmChat(c.chat, undefined);
    expect([...c.defs.keys()].sort()).toEqual(['farm', 'mine']);
    expect(c.run('mine', ['coal'])[0]).toMatch(/^mine needs a task that can walk/);
  });

  it('parses radius, counts and the stop / status words', () => {
    const calls: string[] = [];
    let end: ((m: string) => void) | undefined;
    const ctl: FarmController = {
      farm: (r) => (calls.push(`farm ${r}`), `farming r=${r}`),
      farmStop: () => (calls.push('farm stop'), 'stopped'),
      farmStatus: () => 'farm: idle',
      mine: (b, n, onEnd) => {
        calls.push(`mine ${b} ${n}`);
        end = onEnd;
        return `mining ${n} ${b}`;
      },
      mineStop: () => (calls.push('mine stop'), 'mine stopped'),
      mineStatus: () => 'mine: idle',
    };
    const c = fakeChat();
    registerFarmChat(c.chat, ctl);
    expect(c.run('farm', [])).toEqual([`farming r=${DEFAULT_FARM_RADIUS}`]);
    expect(c.run('farm', ['12'])).toEqual(['farming r=12']);
    expect(c.run('farm', ['0'])[0]).toMatch(/^usage/);
    expect(c.run('farm', ['x'])[0]).toMatch(/^usage/);
    expect(c.run('farm', ['stop'])).toEqual(['stopped']);
    expect(c.run('farm', ['status'])).toEqual(['farm: idle']);
    expect(c.run('mine', [])[0]).toMatch(/^usage/);
    expect(c.run('mine', ['coal_ore', '0'])[0]).toMatch(/^usage/);
    expect(c.run('mine', ['coal_ore', '8'])).toEqual(['mining 8 coal_ore']);
    expect(c.run('mine', ['iron'])).toEqual(['mining 1 iron']);
    expect(c.run('mine', ['STOP'])).toEqual(['mine stopped']);
    expect(c.run('mine', ['status'])).toEqual(['mine: idle']);
    expect(calls).toEqual(['farm 8', 'farm 12', 'farm stop', 'mine coal_ore 8', 'mine iron 1', 'mine stop']);
    expect(end).toBeDefined();
  });
});
