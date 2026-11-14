// Track R1 (docs/pathfinding.md "Reachability (Track R1)"; decisions/0072-reachability.md): the reachability
// bench's closed loop. The REAL navigator (BotSkills.goto with the session's wiring: the dig way, digPenalty, the
// protected base, the long-fall policy, the planner worker with the live budgets, the coarse layer) walks a bench
// world (nav/bench/worlds.ts) offline: a real World fed chunk packets the way a server sends them (the columns
// within the load radius of the body, a few a tick, the far ones unloaded), FakeConnection -> InputLoop physics,
// fake dig / door actions that change the world through block updates, and the damage the body takes (falls,
// lava, drowning) applied to its health. Ticks run at full speed except while the worker searches: then at the
// server's rate scaled to the owner's Mac (`paceMs`), so a search costs the ticks it costs live.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger, type Logger } from '../../../src/log.ts';
import { attachCoarseLayer } from '../../../src/skills/coarse/index.ts';
import { breakTicks } from '../../../src/skills/dig/breakTime.ts';
import { DEFAULT_FALL_SETTINGS, type FallSettings } from '../../../src/skills/fall/clutch.ts';
import { fallDamage } from '../../../src/skills/fall/damage.ts';
import { BotSkills } from '../../../src/skills/index.ts';
import type { NavActions } from '../../../src/skills/nav/actions.ts';
import { Avoidance } from '../../../src/skills/nav/avoidance.ts';
import type { NavGoal } from '../../../src/skills/nav/goals.ts';
import type { BenchPair, BenchWorld } from '../../../src/skills/nav/bench/worlds.ts';
import { MIN_Y, V, VOX_BLOCKS, isDoor, isDoorLower, isGravityVox, toggledDoor, type Vox } from '../../../src/skills/nav/bench/vox.ts';
import type { SkillResult } from '../../../src/skills/types.ts';
import { WorldCache } from '../../../src/world/cache/index.ts';
import { World } from '../../../src/world/index.ts';
import type { Vec3 } from '../../../src/world/types.ts';
import { encodeSubChunk, fillSection, readyRegistry, recordedLogin, ReplaySource } from '../world/helpers.ts';
import { harness } from './fakes.ts';

export interface SimOptions {
  /** Hotbar tools (the oracle reads the same; default iron pickaxe and shovel). */
  tools?: readonly string[];
  /** The planner's ms budgets x this (the owner's M4 is about 1.25 x this PC on the planner; default 1.25). */
  speed?: number;
  /** Wall ms a tick lasts while the worker searches (default 50 x speed). */
  paceMs?: number;
  /** Columns sent per tick (default 8). */
  columnsPerTick?: number;
  /** The goto's timeout (the `!goto` command's 6000). */
  timeoutTicks?: number;
  /** The digWay setting (default on). */
  digWay?: boolean;
  /** Keep the navigator's log lines (default the last 60). */
  logLines?: number;
  logger?: Logger;
  /** Each tick's body position (the bench's `--detail` diagnostics). */
  trace?: (tick: number, pos: Readonly<Vec3>, onGround: boolean, nav: unknown) => void;
  /**
   * Track R2: the goto's allowBreak / allowPlace (the owner's live settings: both on). Default off: R1's configuration
   * (the `!goto` of a session whose settings say neither).
   */
  allowBreak?: boolean;
  allowPlace?: boolean;
  /** Track R2: ticks a dug block costs the planner (the setting digPenalty: 60 by default, the owner's 500). */
  digPenalty?: number;
  /** Track R2: throwaway blocks carried (the pillar places them, cobblestone before dirt as the PlaceSkill picks them). */
  blocks?: readonly { name: string; count: number }[];
  /** Track R2: every column sent once before the goto (its world cache knows the place: a session that walked there before). */
  preload?: boolean;
  /** The navigator's debug lines in the log too, each line with the body's position. */
  debug?: boolean;
  /** Track R2: the world as the run left it (before it is restored), the body's end, the cells (Vox.index) the run placed. */
  after?: (vox: Vox, end: Vec3, placed: ReadonlySet<number>) => void;
  /** Track R4: called every tick before the body moves: the "server" may add, move or remove entities (`src.emit`). */
  onTick?: (tick: number, src: ReplaySource, pos: Readonly<Vec3>) => void;
  /** Track R4: the fall settings (FallGuard.settings; default the session's defaults). */
  falls?: Partial<FallSettings>;
  /** Track R4: the health at the start (default 20). */
  health?: number;
  /** Track R4: Navigator.fallHoldTicks (default FALL_HOLD_TICKS; 0: the behaviour before R4). */
  fallHoldTicks?: number;
  /** Track R5: the body's feet at the start, exactly (default the pair's start cell's centre, at its y). */
  startPos?: Vec3;
  /** Track R5: ticks the body settles before the goto is asked (default 5). */
  settleTicks?: number;
  /** Track R5: the navigator's Navigator.settleTicks (default SETTLE_TICKS; 0: the behaviour before R5). */
  navSettleTicks?: number;
  /** Track R5: no perch starts (the behaviour before R5: the start is `locateNode`'s or none). */
  noPerch?: boolean;
  /** Track R6: no perch goals (the behaviour before R6: a goal on a fence's top is `not standable`). */
  noPerchGoal?: boolean;
  /** Track R6: the goto's goal (default the pair's goal cell as a `block` goal). */
  goal?: NavGoal;
}

/** Track R2: the palette id a placed throwaway block becomes. */
const placedVox = (name: string): number => (name === 'cobblestone' ? V.cobble : name === 'stone' ? V.stone : V.dirt);

export interface PairRun {
  ok: boolean;
  reason?: string;
  note?: string;
  /** The navigator's last failure reason (report.why). */
  why?: string;
  /** Track R1: the unreachable cause class the goto reported, when it did (SkillResult `cause`). */
  cause?: string;
  /** The reply `!goto` would send. */
  reply: string;
  ticks: number;
  wallMs: number;
  damage: number;
  died: boolean;
  deathBy?: string;
  dug: number;
  doors: number;
  placed: number;
  endPos: Vec3;
  /** Horizontal distance from the goal cell's centre at the end. */
  endDist: number;
  plans: number;
  failures: number;
  corridor?: string;
  /** Track R2: the end is stranded (scripts/reach-bench.ts: no way back to the start without a hurting fall, one before). */
  stranded?: boolean;
  log: string[];
}

const DEFAULT_TOOLS = ['iron_pickaxe', 'iron_shovel'];

const reg = readyRegistry();
const RIDS: number[] = VOX_BLOCKS.map(([name, states]) => {
  const s = reg.stateIdOf(name, states);
  if (s === undefined) throw new Error(`no state ${name} ${JSON.stringify(states)}`);
  return reg.runtimeIdOf(s);
});

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

/** The chunk "server" of one pair: a World fed the bench world's columns around the body. */
class ChunkServer {
  readonly src = new ReplaySource();
  readonly world: World;
  readonly cache: WorldCache;
  private readonly dir: string;
  private readonly vox: Vox;
  private readonly radius: number;
  private readonly payloads: Map<number, Buffer[]>;
  private readonly loaded = new Set<number>();
  private centre = { cx: Number.NaN, cz: Number.NaN };

  constructor(vox: Vox, radius: number, payloads: Map<number, Buffer[]>) {
    this.vox = vox;
    this.radius = radius;
    this.payloads = payloads;
    this.world = new World(this.src, { logger: silentLogger, defer: (fn) => fn() });
    const { startGame, itemRegistry } = recordedLogin();
    this.src.emit('start_game', startGame);
    this.src.emit('item_registry', itemRegistry as unknown as Record<string, unknown>);
    this.dir = mkdtempSync(join(tmpdir(), 'reach-cache-'));
    this.cache = new WorldCache({ dir: this.dir, flushIntervalMs: 0, logger: silentLogger });
    this.cache.attach(this.world);
    const self = this.world.self as { health: number; healthKnown?: boolean };
    self.health = 20;
    self.healthKnown = true;
  }

  private colKey(cx: number, cz: number): number {
    return cx * 4096 + cz;
  }

  private payload(cx: number, cz: number): Buffer[] {
    const k = this.colKey(cx, cz);
    let p = this.payloads.get(k);
    if (!p) {
      p = [];
      for (let s = 0; s < this.vox.height / 16; s++) {
        const y0 = MIN_Y + s * 16;
        p.push(encodeSubChunk([fillSection((lx, ly, lz) => RIDS[Math.max(0, this.vox.get(cx * 16 + lx, y0 + ly, cz * 16 + lz))]!)], { y: y0 >> 4 }));
      }
      this.payloads.set(k, p);
    }
    return p;
  }

  private send(cx: number, cz: number): void {
    const p = this.payload(cx, cz);
    this.src.emit('level_chunk', { x: cx, z: cz, dimension: 0, sub_chunk_count: 0, highest_subchunk_count: this.vox.height / 16, cache_enabled: false, blobs: [], payload: Buffer.alloc(0) });
    this.src.emit('subchunk', {
      cache_enabled: false,
      dimension: 0,
      origin: { x: cx, y: MIN_Y >> 4, z: cz },
      entries: p.map((payload, dy) => ({ dx: 0, dy, dz: 0, result: 'success', payload })),
    });
    this.loaded.add(this.colKey(cx, cz));
  }

  /** The body is at `pos`: a publisher update when its chunk changed, then up to `n` missing columns, nearest first. */
  pump(pos: Vec3, n: number): void {
    const cx = Math.floor(pos.x) >> 4;
    const cz = Math.floor(pos.z) >> 4;
    const R = this.radius;
    if (cx !== this.centre.cx || cz !== this.centre.cz) {
      this.centre = { cx, cz };
      this.src.emit('network_chunk_publisher_update', { coordinates: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }, radius: R * 16, saved_chunks: [] });
      // the store drops the columns beyond radius + 2
      for (const k of [...this.loaded]) {
        const kx = Math.floor(k / 4096);
        const kz = k - kx * 4096;
        if (Math.max(Math.abs(kx - cx), Math.abs(kz - cz)) > R + 2) this.loaded.delete(k);
      }
    }
    const want: [number, number, number][] = [];
    const mx = Math.ceil(this.vox.sx / 16);
    const mz = Math.ceil(this.vox.sz / 16);
    for (let dz = -R; dz <= R; dz++)
      for (let dx = -R; dx <= R; dx++) {
        const d = dx * dx + dz * dz;
        if (d > R * R) continue;
        const x = cx + dx;
        const z = cz + dz;
        if (x < 0 || z < 0 || x >= mx || z >= mz || this.loaded.has(this.colKey(x, z))) continue;
        want.push([d, x, z]);
      }
    want.sort((a, b) => a[0] - b[0]);
    for (const [, x, z] of want.slice(0, n)) this.send(x, z);
  }

  /** Track R2: every column once (the world cache records them all), then the view round `pos` (the far ones dropped). */
  preloadAll(pos: Vec3): void {
    const mx = Math.ceil(this.vox.sx / 16);
    const mz = Math.ceil(this.vox.sz / 16);
    // (a view over the whole world while they come, so the store keeps them until the real view drops the far ones)
    this.src.emit('network_chunk_publisher_update', { coordinates: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }, radius: 16 * (mx + mz), saved_chunks: [] });
    for (let x = 0; x < mx; x++) for (let z = 0; z < mz; z++) this.send(x, z);
    this.payloads.clear();
    this.loaded.clear();
    this.centre = { cx: Number.NaN, cz: Number.NaN };
  }

  /** A block changed: the world gets an update_block (when its column is loaded), the payload cache forgets the column. */
  setBlock(x: number, y: number, z: number, id: number): void {
    this.vox.set(x, y, z, id);
    const k = this.colKey(x >> 4, z >> 4);
    this.payloads.delete(k);
    if (this.loaded.has(k)) this.src.emit('update_block', { position: { x, y, z }, block_runtime_id: RIDS[id], flags: {}, layer: 0 });
  }

  close(): void {
    this.cache.close();
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {
      // the cache's files may still be open on Windows: the OS temp cleaner gets them
    }
  }
}

/** Runs one pair of a bench world. The world's voxels are restored afterwards. */
export async function runPair(bw: BenchWorld, pair: BenchPair, payloads: Map<number, Buffer[]>, o: SimOptions = {}): Promise<PairRun> {
  const speed = o.speed ?? 1.25;
  const paceMs = o.paceMs ?? 50 * speed;
  const tools = o.tools ?? DEFAULT_TOOLS;
  const vox = bw.vox;
  const undo: [number, number, number, number][] = [];
  const server = new ChunkServer(vox, bw.loadRadius, payloads);
  const set = (x: number, y: number, z: number, id: number): void => {
    undo.push([x, y, z, vox.get(x, y, z)]);
    server.setBlock(x, y, z, id);
  };
  const start = o.startPos ? { ...o.startPos } : { x: pair.start.x + 0.5, y: pair.start.y, z: pair.start.z + 0.5 };
  if (o.preload) server.preloadAll(start);
  server.pump(start, 10_000);
  const { conn, loop } = harness(start);
  const log: string[] = [];
  const keep = o.logLines ?? 60;
  const push = (m: string): void => {
    const b = loop.state.pos;
    log.push(o.debug ? `@${b.x.toFixed(1)},${b.y.toFixed(1)},${b.z.toFixed(1)} ${m}` : m);
    if (log.length > keep) log.shift();
  };
  const logger: Logger = o.logger ?? { ...silentLogger, info: push, warn: push, ...(o.debug ? { debug: push } : {}) };
  let dug = 0;
  let doors = 0;
  let placed = 0;
  const placedCells = new Set<number>();
  // Track R2: the throwaway stacks (counted down as the pillar places them), after the tools in the hotbar
  const blocks = (o.blocks ?? []).map((b) => ({ ...b })).sort((a, b) => (a.name === 'cobblestone' ? -1 : 0) - (b.name === 'cobblestone' ? -1 : 0));
  const actions: NavActions = {
    dig: async (p, opts) => {
      const id = vox.get(p.x, p.y, p.z);
      if (id <= 0) return { ok: true };
      let t = Infinity;
      for (const tool of [null, ...tools]) t = Math.min(t, breakTicks(VOX_BLOCKS[id]![0], tool, opts?.conditions) ?? Infinity);
      if (!Number.isFinite(t) || id === V.water || id === V.lava) return { ok: false, reason: 'unbreakable' };
      push(`[sim] dig ${p.x},${p.y},${p.z} ${VOX_BLOCKS[id]![0]} from ${loop.state.pos.x.toFixed(2)},${loop.state.pos.y.toFixed(2)},${loop.state.pos.z.toFixed(2)}`);
      await loop.waitTicks(Math.max(1, Math.ceil(t)));
      set(p.x, p.y, p.z, V.air);
      dug++;
      // a gravity column over the cell falls into it
      let y = p.y;
      while (isGravityVox(vox.get(p.x, y + 1, p.z))) {
        set(p.x, y, p.z, vox.get(p.x, y + 1, p.z));
        set(p.x, y + 1, p.z, V.air);
        y++;
      }
      return { ok: true };
    },
    // Track R2: the pillar's place (as Track O's PlaceSkill: the body jumps, the block goes into the feet cell once the
    // feet are over it, the body lands on it)
    place: async (p) => {
      const stack = blocks.find((b) => b.count > 0);
      if (!stack) return { ok: false, reason: 'no_item' };
      if (vox.get(p.x, p.y, p.z) !== V.air) return { ok: false, reason: 'occupied' };
      loop.setCommand({ forward: 0, strafe: 0, sprint: false, jump: true });
      for (let i = 0; i < 20 && loop.state.pos.y < p.y + 1.05; i++) await loop.waitTicks(1);
      loop.setCommand({ jump: false });
      if (loop.state.pos.y < p.y + 1.05) return { ok: false, reason: 'not_above' };
      push(`[sim] place ${p.x},${p.y},${p.z} ${stack.name}`);
      set(p.x, p.y, p.z, placedVox(stack.name));
      stack.count--;
      placed++;
      placedCells.add(vox.index(p.x, p.y, p.z));
      return { ok: true };
    },
    useBlock: async (p) => {
      const id = vox.get(p.x, p.y, p.z);
      if (!isDoor(id)) return { ok: false, reason: 'not usable' };
      const lowY = isDoorLower(id) ? p.y : p.y - 1;
      await loop.waitTicks(2);
      set(p.x, lowY, p.z, toggledDoor(vox.get(p.x, lowY, p.z)));
      set(p.x, lowY + 1, p.z, toggledDoor(vox.get(p.x, lowY + 1, p.z)));
      doors++;
      return { ok: true };
    },
  };
  const skills = new BotSkills({
    loop,
    world: server.world,
    actions,
    logger,
    mainMs: Math.round(40 * speed),
    workerBudgets: { mainMs: Math.round(2000 * speed), segmentMs: Math.round(300 * speed) },
    inventory: () => ({ slots: [...tools.map((name) => ({ name, count: 1 })), ...blocks.filter((b) => b.count > 0).map((b) => ({ name: b.name, count: b.count }))], selected: 0 }),
    digWay: o.digWay ?? true,
  });
  const home = bw.home;
  const protect = home && bw.protectRadius ? { x: home.x + 0.5, y: home.y, z: home.z + 0.5, r: bw.protectRadius } : undefined;
  skills.nav.setProtect(() => protect);
  skills.nav.setDigPenalty(() => o.digPenalty ?? 60);
  skills.falls.protect = () => protect;
  if (o.falls) skills.falls.settings = () => ({ ...DEFAULT_FALL_SETTINGS, ...o.falls });
  if (o.fallHoldTicks !== undefined) skills.nav.fallHoldTicks = o.fallHoldTicks;
  if (o.navSettleTicks !== undefined) skills.nav.settleTicks = o.navSettleTicks; // Track R5
  if (o.noPerch) skills.nav.perch = false;
  if (o.noPerchGoal) skills.nav.perchGoals = false; // Track R6
  // the survival layer's avoidance (skills/survival: lava proximity costs, no mobs here)
  const avoidance = new Avoidance({ entities: () => server.world.entities, origin: () => (loop.state.ready ? loop.state.pos : undefined), lavaWorld: server.world });
  skills.nav.cellCost = () => avoidance.costFn();
  skills.nav.attachPlanner(server.world, { threads: () => 1 });
  const coarse = bw.coarse ? attachCoarseLayer(server.world) : undefined;
  if (coarse) skills.nav.attachCoarse(coarse.layer, { minBlocks: () => 96 });
  const t0 = performance.now();
  while (!skills.nav.planner?.ready) {
    if (performance.now() - t0 > 30_000) throw new Error('planner worker did not start');
    await flush();
  }
  conn.tick(o.settleTicks ?? 5);
  let result: SkillResult | undefined;
  const p = skills.goto(o.goal ?? { type: 'block', p: pair.goal }, { timeoutTicks: o.timeoutTicks ?? 6000, allowBreak: o.allowBreak ?? false, allowPlace: o.allowPlace ?? false, closeDoors: false, explain: true }).then((r) => (result = r));
  const self = server.world.self as { health: number };
  let health = o.health ?? 20;
  self.health = health;
  let damage = 0;
  let died = false;
  let deathBy: string | undefined;
  let peak = loop.state.pos.y;
  let air = 300;
  let ticks = 0;
  const wall0 = performance.now();
  const hurt = (hp: number, by: string): void => {
    if (hp <= 0) return;
    damage += hp;
    health -= hp;
    self.health = Math.max(0, health);
    if (health <= 0 && !died) {
      died = true;
      deathBy = by;
    }
  };
  const max = (o.timeoutTicks ?? 6000) + 600;
  // (while the skill's goto is pending too: it surfaces and retries after a goto that ended in water, BotSkills.surfaceAndRetry)
  while ((skills.nav.busy || result === undefined) && ticks < max && !died) {
    o.onTick?.(ticks, server.src, loop.state.pos);
    conn.tick();
    ticks++;
    const s = loop.state;
    server.pump(s.pos, o.columnsPerTick ?? 8);
    // damage: falls (from the highest point since the last ground or water contact), lava, drowning
    if (s.inWater || s.inLava) peak = s.pos.y;
    else if (s.onGround) {
      const h = peak - s.pos.y;
      if (h > 0) hurt(fallDamage(h, VOX_BLOCKS[Math.max(0, vox.get(Math.floor(s.pos.x), Math.floor(s.pos.y - 0.01), Math.floor(s.pos.z)))]![0]), 'fall');
      peak = s.pos.y;
    } else peak = Math.max(peak, s.pos.y);
    o.trace?.(ticks, s.pos, s.onGround, skills.nav);
    if (s.inLava) hurt(20, 'lava');
    const eye = vox.get(Math.floor(s.pos.x), Math.floor(s.pos.y + 1.62), Math.floor(s.pos.z));
    if (eye === V.water) {
      air--;
      if (air <= -20) {
        air = 0;
        hurt(2, 'drowning');
      }
    } else air = Math.min(300, air + 4);
    // the server's clock while the worker searches; full speed otherwise
    if (skills.nav.awaitingWorker) {
      const w0 = performance.now();
      while (skills.nav.awaitingWorker && performance.now() - w0 < paceMs) await flush();
    } else await flush();
  }
  const wallMs = performance.now() - wall0;
  skills.cancel();
  // (a skill step after the goto, the swim up, ends on the cancel at its next tick: ticked until it does)
  for (let k = 0; k < 400 && result === undefined; k++) {
    conn.tick();
    await flush();
  }
  await p;
  const rep = skills.nav.lastReport;
  const r = result ?? { ok: false as const, reason: died ? 'died' : 'cut off' };
  const end = loop.state.pos;
  const run: PairRun = {
    ok: r.ok && !died,
    ...(r.ok ? (r.note ? { note: r.note } : {}) : { reason: r.reason, ...(r.note ? { note: r.note } : {}) }), // (Track R6: an arrival's note)
    ...(rep?.why ? { why: rep.why } : {}),
    ...(!r.ok && (r as { cause?: string }).cause ? { cause: (r as { cause?: string }).cause } : {}),
    reply: r.ok ? 'arrived' : `goto: ${r.reason}${r.note ? ` (${r.note})` : ''}`,
    ticks,
    wallMs: Math.round(wallMs),
    damage,
    died,
    ...(deathBy ? { deathBy } : {}),
    dug,
    doors,
    placed,
    endPos: { x: +end.x.toFixed(2), y: +end.y.toFixed(2), z: +end.z.toFixed(2) },
    endDist: +Math.hypot(end.x - (pair.goal.x + 0.5), end.z - (pair.goal.z + 0.5)).toFixed(2),
    plans: rep?.plans.length ?? 0,
    failures: rep?.failures ?? 0,
    ...(rep?.corridor ? { corridor: `${rep.corridor.status ?? 'pending'} ${rep.corridor.requests}req ${rep.corridor.passed}passed ${rep.corridor.failed}failed` } : {}),
    log,
  };
  skills.dispose();
  coarse?.detach();
  server.close();
  o.after?.(vox, { x: end.x, y: end.y, z: end.z }, placedCells);
  for (let i = undo.length - 1; i >= 0; i--) {
    const [x, y, z, id] = undo[i]!;
    vox.set(x, y, z, id);
    payloads.delete((x >> 4) * 4096 + (z >> 4));
  }
  return run;
}
