// RlAgentTask (PLAN.md section 4.4, task 6.2): executes actions from the RL bridge and publishes an
// observation after each one. Python connects to ws://127.0.0.1:<bridge-port> (rl/bedrockbot_env).
//
//   bot --task rl --port 19156 --bridge-port 8765 [--arena-origin x,z]
//
// Stack: Connection -> World -> InputLoop -> BotSkills (tasks/mobility.ts) with a Hotbar attached for
// tool switching (plus a Digger / collect fallback should the facade's dig() / collect() be unavailable), RespawnController for deaths,
// CommandClient for `/scriptevent rl:reset` (the bot is an operator on the local BDS), and the
// bridge (bot/src/bridge). Actions run one at a time (goto and dig both steer yaw and pitch).
import type { Connection } from '../connection/connection.ts';
import { silentLogger, type Logger } from '../log.ts';
import { ActionExecutor, type ActionSkills } from '../bridge/actions.ts';
import { collectDrops } from '../bridge/collect.ts';
import { CommandClient } from '../bridge/commands.ts';
import type { EpisodeLimits } from '../bridge/episode.ts';
import { BridgeServer } from '../bridge/server.ts';
import { RlSession, type ResetRequest } from '../bridge/session.ts';
import { Digger } from '../skills/dig/index.ts';
import type { SkillResult } from '../skills/types.ts';
import { Hotbar } from '../world/hotbar.ts';
import type { Vec3 } from '../world/types.ts';
import type { RunningTask, TaskDefinition } from './base.ts';
import { createMobility, type Mobility } from './mobility.ts';
import { RespawnController } from './respawn.ts';

export interface RlAgentOptions {
  bridgePort: number;
  bridgeHost?: string;
  /** Arena origin for resets that do not name one (default 0,0: rl:reset's default). */
  origin?: [number, number];
  limits?: Partial<EpisodeLimits>;
  /** Timeout for the rl:reset reply (ms). */
  resetTimeoutMs?: number;
  log?: Logger;
}

export interface ResetInfo extends Record<string, unknown> {
  scenario: string;
  seed: number;
  checksum: string;
  box: { min: Vec3; max: Vec3 };
  start: Vec3;
  yaw: number;
  tool: string;
}

export class ResetError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RlAgentTask implements RunningTask {
  readonly name = 'rl';
  readonly bridge: BridgeServer;
  readonly session: RlSession;
  readonly commands: CommandClient;
  private readonly conn: Connection;
  private readonly mob: Mobility;
  private readonly respawn: RespawnController;
  private readonly ownRespawn: boolean;
  private readonly hotbar: Hotbar;
  private readonly log: Logger;
  private readonly opts: RlAgentOptions;
  private readonly executor: ActionExecutor;
  private digger: Digger | undefined;
  private collectCancelled = false;
  private lastReset: { ms: number; syncMs: number; info: ResetInfo } | undefined;

  constructor(conn: Connection, mob: Mobility, opts: RlAgentOptions, respawn?: RespawnController) {
    this.conn = conn;
    this.mob = mob;
    this.opts = opts;
    this.log = opts.log ?? silentLogger;
    this.ownRespawn = respawn === undefined;
    this.respawn = respawn ?? new RespawnController(conn, { respawnDelayMs: 1000, log: this.log, position: () => mob.position() });
    const world = mob.world;
    this.hotbar = new Hotbar(conn, { inventory: world.inventory, runtimeId: () => world.self.runtimeId });
    // Tool switching for the facade's dig().
    mob.skills.attach({ hotbar: this.hotbar, source: conn });
    this.commands = new CommandClient(conn);
    this.executor = new ActionExecutor({ world, loop: mob.loop, skills: this.actionSkills() });
    this.session = new RlSession(
      {
        world,
        loop: mob.loop,
        run: (a) => this.executor.run(a),
        reset: (req) => this.resetArena(req),
        deaths: () => this.respawn.deaths,
        release: () => this.release(),
      },
      { ...(opts.limits ? { limits: opts.limits } : {}), ...(opts.origin ? { origin: opts.origin } : {}), botName: conn.username },
    );
    this.bridge = new BridgeServer({ port: opts.bridgePort, ...(opts.bridgeHost ? { host: opts.bridgeHost } : {}), session: this.session, log: this.log });
  }

  /** Builds the movement stack and the task; call before conn.connect(). */
  static create(conn: Connection, opts: RlAgentOptions & { version: string }): RlAgentTask {
    return new RlAgentTask(conn, createMobility(conn, { version: opts.version, log: opts.log }), opts);
  }

  async start(): Promise<void> {
    if (this.ownRespawn) this.respawn.start();
    await this.bridge.start();
  }

  stop(): void {
    this.release();
    void this.bridge.stop();
    if (this.ownRespawn) this.respawn.stop();
    this.commands.dispose();
    this.hotbar.dispose();
  }

  /** The bot's world model (what the observations are built from). */
  get world(): Mobility['world'] {
    return this.mob.world;
  }

  /** Resolves once spawned with the chunks around the bot loaded and the input loop running. */
  async ready(timeoutMs = 30_000): Promise<void> {
    const { world, loop } = this.mob;
    await world.waitForChunks(2, { timeoutMs });
    const t0 = performance.now();
    while (!loop.state.ready) {
      if (performance.now() - t0 > timeoutMs) throw new Error('input loop not ready');
      await sleep(50);
    }
    await loop.waitTicks(5);
  }

  position(): Vec3 | undefined {
    return this.mob.position();
  }

  alive(): boolean {
    return !this.respawn.dead;
  }

  status(): Record<string, unknown> {
    const ep = this.session.episode;
    return {
      task: 'rl',
      bridge: this.bridge.address,
      client: this.bridge.busy,
      connections: this.bridge.connections,
      ...this.session.stats,
      episode: { active: ep.active, steps: ep.steps, ticks: ep.ticks, logs: ep.logs, done: ep.done, reason: ep.reason ?? null },
      lastReset: this.lastReset ? { ms: Math.round(this.lastReset.ms), syncMs: Math.round(this.lastReset.syncMs), seed: this.lastReset.info.seed, checksum: this.lastReset.info.checksum } : null,
      deaths: this.respawn.deaths,
    };
  }

  statusLine(): Record<string, string | number> {
    const ep = this.session.episode;
    return { task: 'rl', resets: this.session.stats.resets, steps: this.session.stats.steps, logs: ep.logs };
  }

  private release(): void {
    this.collectCancelled = true;
    this.mob.skills.cancel();
    this.digger?.cancel();
    this.mob.loop.release();
  }

  /** Skills for the executor: the facade, with a Digger / collect fallback while those are stubs. */
  private actionSkills(): ActionSkills {
    const { skills, loop, world } = this.mob;
    return {
      goto: (goal, o) => skills.goto(goal, o),
      lookAt: (p) => skills.lookAt(p),
      dig: async (p): Promise<SkillResult> => {
        const r = await skills.dig(p, { tool: 'best' });
        if (r.ok || (r.reason !== 'not_implemented' && r.reason !== 'no_digger')) return r;
        this.digger ??= new Digger({ loop, world, hotbar: this.hotbar, logger: this.log });
        return this.digger.dig(p, { tool: 'best' });
      },
      collect: async (radius, timeoutTicks): Promise<SkillResult> => {
        const r = await skills.collect(radius, timeoutTicks);
        if (r.ok || (r.reason !== 'not_implemented' && r.reason !== 'no_entities')) return r;
        this.collectCancelled = false;
        return collectDrops({ world, loop, goto: (g, o) => skills.goto(g, o), cancelled: () => this.collectCancelled }, radius, timeoutTicks);
      },
      cancel: () => {
        this.collectCancelled = true;
        skills.cancel();
        this.digger?.cancel();
      },
    };
  }

  /** `/scriptevent rl:reset`, then wait until the bot's own model shows the new arena. */
  async resetArena(req: ResetRequest): Promise<Record<string, unknown>> {
    const { loop, world } = this.mob;
    if (this.executor.busy) throw new ResetError('an action is still running');
    this.release();
    if (this.conn.state !== 'spawned') throw new ResetError(`not spawned (${this.conn.state})`);
    // A dead player cannot be teleported: wait for the respawn (pressed by the RespawnController).
    for (let t = 0; this.respawn.dead; t += 100) {
      if (t > 15_000) throw new ResetError('still dead 15 s after dying');
      await sleep(100);
    }
    const args: (string | number)[] = [req.scenario, req.seed];
    const origin = req.origin ?? this.opts.origin;
    if (origin) args.push(`origin=${origin[0]},${origin[1]}`);
    if (req.tool) args.push(`tool=${req.tool}`);
    const t0 = performance.now();
    const reply = await this.commands.scriptevent('rl:reset', args, this.opts.resetTimeoutMs ?? 30_000);
    const replyMs = performance.now() - t0;
    if (!reply.ok) {
      const d = reply.data as { message?: string } | null;
      throw new ResetError(`rl:reset failed: ${reply.reason ?? 'error'} ${d?.message ?? ''}`.trim());
    }
    const info = reply.data as ResetInfo;
    // 1. The teleport reached the input loop.
    const atStart = () => {
      const p = loop.state.pos;
      return Math.hypot(p.x - info.start.x, p.z - info.start.z) < 0.05 && Math.abs(p.y - info.start.y) < 0.1;
    };
    await this.until(atStart, 3_000, 'teleport to the start');
    loop.setCommand({ yaw: info.yaw, pitch: 0 });
    // 2. The world model has the arena (same checksum as the plan).
    let modelSum: string | undefined;
    await this.until(() => (modelSum = world.checksum(info.box.min, info.box.max)) === info.checksum, 5_000, () => `arena blocks (model ${modelSum ?? 'not loaded'} vs ${info.checksum})`);
    // 3. The inventory model holds just the tool.
    const tool = info.tool.replace(/^minecraft:/, '');
    await this.until(() => world.inventory.slots.filter((s) => s !== null).every((s) => s.name === tool) && world.inventory.slots[0]?.name === tool, 3_000, 'inventory = tool only');
    // 4. Standing still on the ground.
    await this.until(() => loop.state.onGround && atStart(), 2_000, 'on the ground at the start');
    await loop.waitTicks(2);
    const ms = performance.now() - t0;
    this.lastReset = { ms, syncMs: ms - replyMs, info };
    return { ...info, reply_ms: Math.round(replyMs), sync_ms: Math.round(ms - replyMs) };
  }

  private async until(cond: () => boolean, timeoutMs: number, what: string | (() => string)): Promise<void> {
    const t0 = performance.now();
    while (!cond()) {
      if (performance.now() - t0 > timeoutMs) throw new ResetError(`reset: timed out waiting for ${typeof what === 'string' ? what : what()}`);
      if (this.conn.state !== 'spawned') throw new ResetError('disconnected during reset');
      await this.mob.loop.waitTicks(1);
    }
  }
}

/** CLI registration (tasks/registry.ts style); index.ts may also construct the task directly. */
export const rlTaskDefinition: TaskDefinition = {
  name: 'rl',
  summary: 'RL agent: serve the Gymnasium bridge on --bridge-port (PLAN.md 6.2)',
  cliOptions: { 'bridge-port': { type: 'string' }, 'arena-origin': { type: 'string' } },
  usage: '  --bridge-port <port>     WebSocket port for the RL bridge (default 8765, loopback only)\n  --arena-origin <x,z>     arena origin for rl:reset (default 0,0)',
  defaultUsername: 'RlBot',
  create(ctx) {
    const port = Number(ctx.values['bridge-port'] ?? 8765);
    const origin = parseOrigin(ctx.values['arena-origin'] as string | undefined);
    const task = new RlAgentTask(ctx.conn, ctx.mobility(), { bridgePort: port, ...(origin ? { origin } : {}), log: ctx.logger('rl') }, ctx.respawn());
    return task;
  },
};

export function parseOrigin(s: string | undefined): [number, number] | undefined {
  if (s === undefined || s === '') return undefined;
  const m = /^(-?\d+),(-?\d+)$/.exec(s.trim());
  if (!m) throw new Error(`bad --arena-origin "${s}" (expected x,z)`);
  return [Number(m[1]), Number(m[2])];
}
