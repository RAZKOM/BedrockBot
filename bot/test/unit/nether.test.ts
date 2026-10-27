// Track AT (docs/nether.md) on fakes: lava proximity costs in the planner, the fire escape, the portal
// helpers and a whole portal trip on a fake world, the piglin / gold rule, and the afk registry's
// dimension rules (night off, !top refused, !nether replies, the ack answered).
import { describe, expect, it, vi } from 'vitest';
import { Chat } from '../../src/chat/chat.ts';
import { fireProcessOf, portalEndLine } from '../../src/chat/commands-portal.ts';
import { Metrics } from '../../src/connection/metrics.ts';
import { RuntimeSettings, SETTINGS_VALUE_KEY } from '../../src/config/settings.ts';
import { silentLogger } from '../../src/log.ts';
import { MobTracker } from '../../src/skills/combat/hostiles.ts';
import { isThreat, wearsGold } from '../../src/skills/combat/targeting.ts';
import { Avoidance, costFunction, LavaIndex, lavaPenalty, SpawnerIndex, type AvoidanceSource } from '../../src/skills/nav/avoidance.ts';
import { findPath, NavGrid } from '../../src/skills/nav/index.ts';
import { BurnWatch, fireEscape } from '../../src/skills/survival/fire.ts';
import type { CommonTaskOptions, TaskContext } from '../../src/tasks/base.ts';
import { createMobility, type Mobility } from '../../src/tasks/mobility.ts';
import { NightSafety, WorldClock } from '../../src/tasks/night.ts';
import { ProcessManager } from '../../src/tasks/process/manager.ts';
import { findPortal, FireProcess, portalBase, portalSides, PortalProcess, type PortalDeps } from '../../src/tasks/process/portal.ts';
import { afkTask, type WalkingTask } from '../../src/tasks/registry.ts';
import { RespawnController } from '../../src/tasks/respawn.ts';
import { DimensionWatcher, type DimensionChange } from '../../src/world/dimension.ts';
import type { BlockInfo, EntityInfo, Vec3 } from '../../src/world/types.ts';
import { flatGen } from './skills/genworld.ts';
import { FakeSource, mob } from './skills/pve-fakes.ts';
import { flush, setup as connSetup, TARGET } from './connection-fakes.ts';

describe('lava costs (nav/avoidance.ts)', () => {
  const lava = (x: number, y: number, z: number): AvoidanceSource => ({ x, y, z, r: 0, zone: 0, flat: false, lava: true });

  it('lavaPenalty: near within Chebyshev 1, far at 2, levels y-1..y+1 only, the largest counts', () => {
    const cols = new Map<number, number[]>();
    const fn = costFunction([lava(10, -61, 10)])!;
    expect(fn(10, -60, 11)).toBe(60); // beside it at the floor level
    expect(fn(11, -60, 11)).toBe(60); // diagonal
    expect(fn(12, -60, 10)).toBe(8); // 2 away
    expect(fn(13, -60, 10)).toBe(0); // 3 away
    expect(fn(10, -57, 11)).toBe(0); // far above
    expect(fn(10, -62, 11)).toBe(60); // lava at the head level
    expect(lavaPenalty(cols, 0, 0, 0, 60, 8)).toBe(0);
  });

  it('lava and mob sources add up; the snapshot rides along for the worker', () => {
    const fn = costFunction([lava(0, -61, 0), { x: 0.5, y: -60, z: 0.5, r: 4, zone: 5, flat: true }])!;
    expect(fn(0, -60, 1)).toBeGreaterThan(60);
    expect(fn.avoidance?.sources).toHaveLength(2);
  });

  it('the planner keeps a free block between the path and a lava strip when there is room', () => {
    const w = flatGen();
    // a lava strip in the floor along z = 0 from x 2 to x 14; start and goal right beside it
    for (let x = 2; x <= 14; x++) w.put(x, -61, 0, 'lava');
    const sources: AvoidanceSource[] = [];
    for (let x = 2; x <= 14; x++) sources.push(lava(x, -61, 0));
    const grid = new NavGrid(w);
    const without = findPath(grid, { x: 0, y: -60, z: 1 }, { type: 'block', p: { x: 16, y: -60, z: 1 } });
    const withLava = findPath(new NavGrid(w), { x: 0, y: -60, z: 1 }, { type: 'block', p: { x: 16, y: -60, z: 1 } }, { cellCost: costFunction(sources) });
    expect(without.status).toBe('found');
    expect(withLava.status).toBe('found');
    const closest = (path: { x: number; z: number }[]) => Math.min(...path.map((n) => Math.min(...sources.map((s) => Math.max(Math.abs(n.x - s.x), Math.abs(n.z - s.z))))));
    expect(closest(without.path)).toBe(1); // straight along the lava
    expect(closest(withLava.path.slice(2, -2))).toBeGreaterThanOrEqual(2); // away from it between start and goal
  });

  it('LavaIndex keeps surface lava only, rescans on movement, forgets on a dimension change', () => {
    const self = { dimension: 0 };
    const cells: Vec3[] = [
      { x: 0, y: -61, z: 0 },
      { x: 0, y: -62, z: 0 }, // under the surface cell: dropped
      { x: 3, y: -61, z: 0 },
    ];
    const world = { self, find: vi.fn(() => cells) };
    let pos: Vec3 = { x: 0, y: -60, z: 0 };
    const idx = new LavaIndex(world, () => pos, { rescanMs: 0 });
    expect(idx.cells()).toEqual([cells[0], cells[2]]);
    expect(world.find).toHaveBeenCalledTimes(1);
    idx.cells();
    expect(world.find).toHaveBeenCalledTimes(1); // not moved
    pos = { x: 10, y: -60, z: 0 };
    idx.cells();
    expect(world.find).toHaveBeenCalledTimes(2);
    self.dimension = 1;
    world.find.mockReturnValueOnce([]);
    expect(idx.cells()).toEqual([]);
  });

  it('Avoidance adds lava sources when it has a world; SpawnerIndex forgets spawners in another dimension', () => {
    const self = { dimension: 0 };
    const world = { self, find: () => [{ x: 1, y: -61, z: 1 }], onBlockUpdate: () => () => undefined };
    const a = new Avoidance({ entities: () => new Map(), lavaWorld: world, origin: () => ({ x: 0, y: -60, z: 0 }) });
    expect(a.sources().filter((s) => s.lava)).toHaveLength(1);
    expect(a.last.lava).toBe(1);
    const sp = new SpawnerIndex({ find: () => [{ x: 5, y: -60, z: 5 }], onBlockUpdate: () => () => undefined, self } as never, () => ({ x: 0, y: -60, z: 0 }));
    expect(sp.spawners()).toHaveLength(1);
    self.dimension = 1;
    (sp as unknown as { world: { find: () => Vec3[] } }).world.find = () => [];
    expect(sp.spawners()).toEqual([]);
  });
});

describe('fire escape (skills/survival/fire.ts)', () => {
  it('fireEscape: the nearest standable cell with nothing burning around it', () => {
    const w = flatGen();
    w.put(0, -60, 0, 'fire');
    w.put(1, -60, 0, 'fire');
    w.put(-1, -61, 0, 'magma');
    const to = fireEscape(new NavGrid(w), { x: 0.5, y: -60, z: 0.5 });
    expect(to).toBeDefined();
    const d = Math.max(Math.abs(to!.x - 0), Math.abs(to!.z - 0));
    expect(d).toBe(2); // ring 1 touches the fire or the magma
    for (const [x, y, z] of [[0, -60, 0], [1, -60, 0], [-1, -61, 0]] as const) expect(Math.max(Math.abs(to!.x - x), Math.abs(to!.y - y), Math.abs(to!.z - z))).toBeGreaterThan(1);
  });

  it('fireEscape: undefined when nothing within the radius is safe', () => {
    const w = flatGen();
    w.fill({ x: -8, y: -61, z: -8 }, { x: 8, y: -61, z: 8 }, 'magma');
    expect(fireEscape(new NavGrid(w), { x: 0.5, y: -60, z: 0.5 }, 3)).toBeUndefined();
  });

  it('FireProcess: wants control only while hurt by fire and not on a clear cell; walks out and eats once', async () => {
    const w = flatGen();
    w.put(0, -60, 0, 'fire');
    w.put(1, -60, 0, 'fire');
    let pos: Vec3 = { x: 0.5, y: -60, z: 0.5 };
    let hurt = true;
    const watch = { sample: () => undefined, hurtByFire: () => hurt, burning: () => true, onFire: true } as unknown as BurnWatch;
    const gotos: Vec3[] = [];
    let eats = 0;
    const fire = new FireProcess({
      watch,
      grid: new NavGrid(w),
      mover: {
        goto: (g) => {
          const p = (g as { p: Vec3 }).p;
          gotos.push(p);
          pos = { x: p.x + 0.5, y: p.y, z: p.z + 0.5 };
          return Promise.resolve({ ok: true });
        },
        cancel: () => undefined,
        nav: { busy: false },
      },
      position: () => pos,
      eat: () => {
        eats++;
        return Promise.resolve();
      },
    });
    expect(fire.priority).toBe(101);
    expect(fire.wants()).toBe(true);
    const m = new ProcessManager();
    m.add(fire);
    for (let i = 0; i < 10; i++) {
      m.tick();
      await new Promise((r) => setImmediate(r));
    }
    expect(gotos).toHaveLength(1);
    expect(Math.max(Math.abs(gotos[0]!.x), Math.abs(gotos[0]!.z))).toBeGreaterThanOrEqual(2);
    expect(eats).toBe(1);
    expect(fire.wants()).toBe(false); // still burning, but on a clear cell
    hurt = false;
    expect(fire.wants()).toBe(false);
    expect(fire.stats).toEqual({ escapes: 1, noEscape: 0, eats: 1 });
  });

  it('BurnWatch: the onfire flag of the bot only, hurts while burning, lava contact', () => {
    const src = new FakeSource();
    let health = 20;
    let inLava = false;
    let t = 0;
    const w = new BurnWatch(src, { selfRuntimeId: () => 7n, health: () => health, inLava: () => inLava, now: () => t });
    src.emit('set_entity_data', { runtime_entity_id: 9n, metadata: [{ key: 'flags', value: { onfire: true } }] });
    expect(w.onFire).toBe(false);
    src.emit('set_entity_data', { runtime_entity_id: 7n, metadata: [{ key: 'flags', value: { onfire: true } }] });
    expect(w.onFire).toBe(true);
    w.sample();
    health = 19;
    t = 100;
    w.sample();
    expect(w.hurtByFire()).toBe(true);
    t = 5000;
    expect(w.hurtByFire()).toBe(false);
    src.emit('set_entity_data', { runtime_entity_id: 7n, metadata: [{ key: 'flags', value: { onfire: false } }] });
    inLava = true;
    health = 15;
    w.sample();
    expect(w.hurtByFire()).toBe(true);
    expect(w.stats).toEqual({ burns: 1, fireHurts: 2 });
    src.emit('respawn', { state: 1 });
    inLava = false;
    expect(w.burning()).toBe(false);
    w.dispose();
  });
});

// ---- portals -------------------------------------------------------------------------------------

interface FakePortalWorld {
  self: { dimension: number; pos: Vec3 };
  blocks: Map<string, BlockInfo>;
  listeners: Set<(e: DimensionChange) => void>;
}

const info = (name: string, states: Record<string, unknown> = {}): BlockInfo => ({ name, stateId: 1, states, hardness: 0, solid: false, boxes: [] });
const k = (p: Vec3) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

/** A portal (axis x) at x 10..11, y -60..-58, z 5 in both dimensions; the server moves the bot after 80 ticks inside. */
function portalWorld(opts: { portal?: boolean } = {}) {
  const fw: FakePortalWorld = { self: { dimension: 0, pos: { x: 10.5, y: -60, z: 1.5 } }, blocks: new Map(), listeners: new Set() };
  if (opts.portal !== false) for (const x of [10, 11]) for (const y of [-60, -59, -58]) fw.blocks.set(`${x},${y},5`, info('portal', { portal_axis: 'x' }));
  let t = 0;
  let inside = 0;
  const pos = fw.self.pos;
  const world: PortalDeps['world'] = {
    self: fw.self,
    blockAt: (p) => fw.blocks.get(k(p)) ?? info('air'),
    find: (pred, o) => {
      const out: Vec3[] = [];
      for (const [key, b] of fw.blocks) {
        const [x, y, z] = key.split(',').map(Number) as [number, number, number];
        if (Math.hypot(x - o.origin.x, y - o.origin.y, z - o.origin.z) <= o.radius && pred(b, { x, y, z })) out.push({ x, y, z });
      }
      return out;
    },
    dimensions: { onChange: (fn) => (fw.listeners.add(fn), () => fw.listeners.delete(fn)), changing: false },
    waitForChunks: () => Promise.resolve(),
  };
  const loop: PortalDeps['loop'] = {
    state: { pos, ready: true },
    setCommand: (c) => {
      cmd = { ...cmd, ...c };
    },
    release: () => {
      cmd = { forward: 0, yaw: cmd.yaw };
    },
    waitTicks: (n) => {
      for (let i = 0; i < n; i++) {
        t += 50;
        if (cmd.forward) {
          const yaw = ((cmd.yaw ?? 0) * Math.PI) / 180;
          pos.x += -Math.sin(yaw) * 0.2 * cmd.forward;
          pos.z += Math.cos(yaw) * 0.2 * cmd.forward;
        }
        if (fw.blocks.get(k(pos))?.name === 'portal' && fw.self.dimension === 0) {
          if (++inside >= 80) {
            fw.self.dimension = 1;
            for (const fn of fw.listeners) fn({ phase: 'arrived', from: 0, to: 1, position: { ...pos }, loadingScreenId: 1, ms: 500 });
          }
        } else inside = 0;
      }
      return Promise.resolve();
    },
  };
  let cmd: { forward?: number; yaw?: number } = {};
  const gotos: unknown[] = [];
  const mover: PortalDeps['mover'] = {
    goto: (goal) => {
      gotos.push(goal);
      const g = goal as { type: string; p?: Vec3; goals?: { p: Vec3 }[] };
      const p = g.p ?? g.goals?.[0]?.p;
      if (p) {
        pos.x = p.x + 0.5;
        pos.y = p.y;
        pos.z = p.z + 0.5;
      }
      return Promise.resolve({ ok: true });
    },
    cancel: () => undefined,
    nav: { busy: false },
  };
  const wps = new Map<string, { x: number; y: number | null; z: number }>();
  const deps: PortalDeps = {
    world,
    loop,
    mover,
    grid: { stand: (x, y, z) => (fw.blocks.get(`${x},${y},${z}`)?.name === 'portal' ? Number.NaN : y) },
    waypoints: { get: (n) => wps.get(n), set: (n, p) => void wps.set(n, { ...p }) },
    position: () => pos,
    now: () => t,
  };
  return { fw, deps, wps, gotos };
}

async function runProcess(p: PortalProcess): Promise<Awaited<PortalProcess['result']>> {
  const m = new ProcessManager();
  m.add(p);
  for (let i = 0; i < 2000 && !p.done; i++) {
    m.tick();
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  }
  return p.result;
}

describe('portal helpers and the trip (tasks/process/portal.ts)', () => {
  it('portalBase / portalSides / findPortal', () => {
    const { deps } = portalWorld();
    expect(portalBase(deps.world, { x: 10, y: -58, z: 5 })).toEqual({ x: 10, y: -60, z: 5 });
    expect(portalSides(deps.world, { x: 10, y: -60, z: 5 })).toEqual([
      { x: 10, y: -60, z: 4 },
      { x: 10, y: -60, z: 6 },
    ]);
    expect(findPortal(deps.world, { x: 10.5, y: -60, z: 1.5 }, 16)).toEqual({ x: 10, y: -60, z: 5 });
    expect(findPortal(deps.world, { x: 100, y: -60, z: 100 }, 16)).toBeUndefined();
  });

  it('no portal known: fails with what is missing', async () => {
    const { deps } = portalWorld({ portal: false });
    const r = await runProcess(new PortalProcess(1, deps));
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toMatch(/^no nether portal known in the overworld: no portal waypoint and no portal block within 64 blocks/);
  });

  it('walks to the portal, steps in, waits for the change and records both portal waypoints', async () => {
    const { deps, wps, fw } = portalWorld();
    const p = new PortalProcess(1, deps);
    const r = await runProcess(p);
    expect(r).toMatchObject({ ok: true, from: 0, to: 1, departure: { x: 10, y: -60, z: 5 }, arrival: { x: 10, y: -60, z: 5 } });
    expect(fw.self.dimension).toBe(1);
    expect(wps.get('portal')).toEqual({ x: 10, y: -60, z: 5 });
    expect(wps.get('nether_portal')).toEqual({ x: 10, y: -60, z: 5 });
    expect(portalEndLine(r, 1)).toMatch(/^in the nether at the portal 10 -60 5 \(left through 10 -60 5\), [\d.]+ s in the portal$/);
    expect(portalEndLine({ ok: false, reason: 'no nether portal known' }, 1)).toBe('nether: no nether portal known');
  });
});

describe('piglins and gold (skills/combat/targeting.ts)', () => {
  const gold = { inventory: { window: (id: number) => (id === 120 ? { slots: [{ name: 'golden_helmet' }, null, null, null] } : undefined) } };
  const iron = { inventory: { window: () => ({ slots: [{ name: 'iron_helmet' }, null, null, null] }) } };

  it('wearsGold reads the armour window', () => {
    expect(wearsGold(gold)).toBe(true);
    expect(wearsGold(iron)).toBe(false);
    expect(wearsGold({})).toBe(false);
  });

  it('a piglin is a threat only once it targets the bot, and never while the bot wears gold; brutes always', () => {
    const src = new FakeSource();
    const entities = new Map<bigint, EntityInfo>();
    const piglin = mob(3n, 'minecraft:piglin', { x: 2, y: -60, z: 0 });
    const brute = mob(4n, 'minecraft:piglin_brute', { x: 3, y: -60, z: 0 });
    entities.set(3n, piglin);
    entities.set(4n, brute);
    const mobs = new MobTracker(src, { entities: () => entities, selfRuntimeId: () => 1n, selfPos: () => ({ x: 0, y: -60, z: 0 }) });
    src.emit('start_game', { entity_id: -42n });
    expect(isThreat({ mobs, d: { world: iron } }, piglin)).toBe(false);
    src.emit('set_entity_data', { runtime_entity_id: 3n, metadata: [{ key: 'target_eid', value: -42n }] });
    expect(mobs.targetsUs(3n)).toBe(true);
    expect(isThreat({ mobs, d: { world: iron } }, piglin)).toBe(true);
    expect(isThreat({ mobs, d: { world: gold } }, piglin)).toBe(false);
    expect(isThreat({ mobs }, piglin)).toBe(true); // no world: the plain neutral rule
    expect(isThreat({ mobs, d: { world: gold } }, brute)).toBe(true);
  });
});

// ---- the afk registry ----------------------------------------------------------------------------

async function afkBot() {
  vi.useFakeTimers();
  const { conn, clients } = connSetup();
  const chat = new Chat(conn, { log: silentLogger, maxReplies: 100 });
  let m: Mobility | undefined;
  const COMMON: CommonTaskOptions = { nudgeIntervalS: 240, heartbeat: false, home: { x: 5, y: -60, z: 5 }, shelter: undefined, walk: true, respawnDelayMs: 2000 };
  const settings = new RuntimeSettings();
  const ctx: TaskContext = {
    name: 'afk',
    conn,
    metrics: new Metrics(),
    chat,
    log: silentLogger,
    version: '1.26.60',
    options: COMMON,
    values: { 'no-config': true, [SETTINGS_VALUE_KEY]: settings },
    taskConfig: {},
    logger: () => silentLogger,
    respawn: () => new RespawnController(conn),
    mobility: () => (m ??= createMobility(conn, { version: '1.26.60' })),
    clock: () => new WorldClock(conn),
  };
  const task = afkTask.create(ctx) as WalkingTask;
  const p = conn.connect(TARGET);
  await flush();
  const client = clients[0]!;
  client.spawn(7n);
  await p;
  const said: string[] = [];
  const origSay = chat.say.bind(chat);
  chat.say = (msg: string) => {
    said.push(msg);
    return origSay(msg);
  };
  const command = (text: string) => chat.handle({ type: 'announcement', source: 'Server', message: `[Server] ${text}`, body: text, xuid: '', truth: false });
  return { conn, client, chat, task, mob: m!, said, command, settings };
}

describe('the afk registry in another dimension (chat/commands-portal.ts)', () => {
  it('answers the server ack, turns night safety off, refuses !top, keeps home out of the Nether, stops user processes, adds the fire process', async () => {
    const nightWants = vi.spyOn(NightSafety.prototype, 'wantsControl').mockReturnValue(true); // dusk with a shelter
    const b = await afkBot();
    try {
      const world = b.mob.world;
      const night = b.task.processes!.find('night')[0]!;
      expect(night.wants()).toBe(true);
      expect(b.task.pve!.d.home()).toEqual({ x: 5, y: -60, z: 5 });
      expect(fireProcessOf(b.task)).toBeDefined();
      expect(b.task.processes!.find('fire')).toHaveLength(1);
      // a user process that must not survive the change
      void b.task.processes!.add(new PortalProcess(1, { world, loop: b.mob.loop, mover: b.mob.skills, grid: b.mob.skills.nav.grid, position: () => undefined }));
      b.client.receive('change_dimension', { dimension: 1, position: { x: 100.5, y: 70, z: 50.5 }, respawn: false, loading_screen_id: 3 });
      expect(world.self.dimension).toBe(1);
      expect(b.task.processes!.find('portal')).toHaveLength(1); // the portal trip itself stays
      b.client.receive('player_action', { runtime_entity_id: 7n, action: 'dimension_change_ack', position: { x: 0, y: 0, z: 0 }, result_position: { x: 0, y: 0, z: 0 }, face: 0 });
      await vi.advanceTimersByTimeAsync(60); // queued packets go out on the next tick
      expect(b.client.sentOf('player_action').filter((s) => s.action === 'dimension_change_ack')).toHaveLength(1);
      expect(night.wants()).toBe(false);
      expect(b.task.pve!.d.home()).toBeUndefined();
      expect(b.mob.skills.nav.costsOverride?.()).toBeUndefined();
      b.command('!top');
      expect(b.said.at(-1)).toMatch(/^top: there is no surface in the Nether/);
      b.command('!goto home');
      expect(b.said.at(-1)).toBe('waypoint home is in the overworld, not in the nether (!overworld first)');
      b.command('!wp set base 1 70 2');
      expect(b.said.at(-1)).toBe('waypoint nether_base set to 1 70 2');
      b.command('!wp set home');
      expect(b.said.at(-1)).toMatch(/^home is an overworld point/);
      b.command('!nether');
      expect(b.said.at(-1)).toBe('already in the nether');
      b.command('!portal');
      expect(b.said.at(-1)).toMatch(/^in the nether; portal none, nether_portal none; changes 1, last overworld -> nether, ack after \d+ ms/);
      const r = await b.task.home!.go!();
      expect(r.ok ? '' : r.reason).toMatch(/^home is in the overworld/);
      // the End: no irreversible drops
      b.client.receive('change_dimension', { dimension: 2, position: { x: 0, y: 70, z: 0 }, respawn: false, loading_screen_id: 4 });
      expect(b.mob.skills.nav.costsOverride?.()).toEqual({ maxDrop: 1 });
      b.command('!overworld');
      expect(b.said.at(-1)).toMatch(/^in the End: the way out is the exit portal/);
    } finally {
      nightWants.mockRestore();
      b.task.stop();
      b.conn.disconnect();
      vi.useRealTimers();
    }
  });

  it('!nether in the overworld with no portal anywhere replies what is missing', async () => {
    const b = await afkBot();
    try {
      b.command('!nether');
      expect(b.said.at(-1)).toMatch(/^going to the nether/);
      for (let i = 0; i < 20 && !b.said.some((s) => s.startsWith('nether: ')); i++) {
        b.task.processes!.tick();
        await vi.advanceTimersByTimeAsync(50);
      }
      expect(b.said.find((s) => s.startsWith('nether: '))).toMatch(/^nether: no nether portal known in the overworld/);
    } finally {
      b.task.stop();
      b.conn.disconnect();
      vi.useRealTimers();
    }
  });
});

describe('DimensionWatcher with a recorded packet sequence', () => {
  it('portal arrival: move_player reset first, then the server ack (answered once)', () => {
    const src = new FakeSource();
    let dim = 0;
    const w = new DimensionWatcher(src, { selfRuntimeId: () => 32n, dimension: () => dim });
    const phases: string[] = [];
    w.onChange((e) => phases.push(`${e.phase}:${e.to}`));
    src.emit('change_dimension', { dimension: 1, position: { x: 1116.5, y: 58.5, z: 495.5 }, respawn: false, loading_screen_id: 13 });
    dim = 1;
    src.emit('move_player', { runtime_id: 32, position: { x: 1115.5, y: 59.62, z: 495.5 }, mode: 'reset', tick: 383n });
    src.emit('player_action', { runtime_entity_id: 32n, action: 'dimension_change_ack' });
    expect(phases).toEqual(['start:1', 'arrived:1']);
    expect(src.sent).toEqual([{ name: 'player_action', params: { runtime_entity_id: 32n, action: 'dimension_change_ack', position: { x: 0, y: 0, z: 0 }, result_position: { x: 0, y: 0, z: 0 }, face: 0 } }]);
  });
});
