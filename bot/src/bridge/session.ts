// One RL environment session (PLAN.md 4.5): turns reset / step / close messages into observations.
// Transport-free (the WebSocket server feeds it), so it is unit-testable with fakes.
import type { ActionResult } from './actions.ts';
import { Episode, type EpisodeLimits } from './episode.ts';
import { buildObservation, logCount, type ObsWorld } from './observation.ts';
import {
  ACTIONS_V1,
  GRID_CLASSES,
  GRID_SHAPE,
  GRID_Y_MIN,
  PROTOCOL_VERSION,
  normaliseAction,
  type Action,
  type Inbound,
  type Observation,
  type Outbound,
} from './schema.ts';
import type { Vec3 } from '../world/types.ts';

export interface SessionLoop {
  readonly state: { pos: Vec3; onGround: boolean; tick: bigint; corrections: number };
  readonly command: { yaw: number; pitch: number };
}

export interface ResetRequest {
  scenario: string;
  seed: number;
  origin?: [number, number];
  tool?: string;
}

export interface SessionDeps {
  world: ObsWorld;
  loop: SessionLoop;
  run(action: Action): Promise<ActionResult>;
  /** Rebuilds the arena and puts the bot at its start; resolves with info for the reply. */
  reset(req: ResetRequest): Promise<Record<string, unknown>>;
  /** Deaths so far (monotonic). */
  deaths(): number;
  /** Stop moving and cancel skills (session end). */
  release(): void;
}

export interface SessionOptions {
  limits?: Partial<EpisodeLimits>;
  /** Defaults for reset messages that leave them out. */
  origin?: [number, number];
  botName?: string;
}

export class RlSession {
  readonly episode: Episode;
  private readonly deps: SessionDeps;
  private readonly opts: SessionOptions;
  private lastSkill: Observation['last_skill'] = { ok: true, action: 'reset' };
  private shapedReach = false;
  /** Stats for the task's status(). */
  stats = { resets: 0, steps: 0, errors: 0, lastResetMs: 0 };

  constructor(deps: SessionDeps, opts: SessionOptions = {}) {
    this.deps = deps;
    this.opts = opts;
    this.episode = new Episode(opts.limits);
  }

  /** The client went away: end the episode and stop moving. */
  abort(): void {
    this.episode.active = false;
    this.deps.release();
  }

  hello(): Outbound {
    const l = this.episode.limits;
    return {
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      actions: [...ACTIONS_V1],
      grid: { shape: [...GRID_SHAPE], order: 'x,z,y (index = (ix * 9 + iz) * 5 + iy; dx = ix - 4, dz = iz - 4, dy = iy - 1)', y_min: GRID_Y_MIN, classes: [...GRID_CLASSES] },
      episode: { max_steps: l.maxSteps, max_ticks: l.maxTicks, target_logs: l.targetLogs, action_ticks: 100 },
      bot: this.opts.botName ?? '',
    };
  }

  async handle(msg: Inbound): Promise<Outbound> {
    try {
      switch (msg.t) {
        case 'reset':
          return await this.reset(msg.id, msg.scenario, msg.seed, msg.options?.origin ?? this.opts.origin, msg.options?.tool);
        case 'step':
          return await this.step(msg.id, normaliseAction(msg.action));
        case 'close':
          this.episode.active = false;
          this.deps.release();
          return { t: 'closed', id: msg.id };
      }
    } catch (e) {
      this.stats.errors++;
      return { t: 'error', id: msg.id, message: e instanceof Error ? e.message : String(e) };
    }
  }

  private observe(): Observation {
    const s = this.deps.loop.state;
    const c = this.deps.loop.command;
    return buildObservation(this.deps.world, { pos: s.pos, yaw: c.yaw, pitch: c.pitch, onGround: s.onGround }, this.lastSkill).obs;
  }

  private async reset(id: number, scenario: string, seed: number, origin: [number, number] | undefined, tool: string | undefined): Promise<Outbound> {
    const t0 = performance.now();
    const req: ResetRequest = { scenario, seed };
    if (origin) req.origin = origin;
    if (tool) req.tool = tool;
    const info = await this.deps.reset(req);
    const s = this.deps.loop.state;
    this.episode.start(s.tick, logCount(this.deps.world.inventory.slots));
    this.episode.corrections = 0;
    this.lastSkill = { ok: true, action: 'reset' };
    this.shapedReach = false;
    const obs = this.observe();
    this.stats.resets++;
    this.stats.lastResetMs = performance.now() - t0;
    return {
      t: 'obs',
      id,
      tick: Number(s.tick),
      obs,
      reward_signals: { logs_delta: 0, died: false, ticks_used: 0, log_in_reach: obs.nearest_log?.in_reach ?? false },
      done: false,
      terminated: false,
      truncated: false,
      info: { corrections: 0, episode_corrections: 0, step: 0, episode_ticks: 0, logs: 0, reset: info, reset_ms: Math.round(performance.now() - t0) },
    };
  }

  private async step(id: number, action: Action): Promise<Outbound> {
    const ep = this.episode;
    if (!ep.active) throw new Error('no episode: send reset first');
    if (ep.done) throw new Error(`episode is done (${ep.reason}): send reset`);
    const deaths0 = this.deps.deaths();
    const corr0 = this.deps.loop.state.corrections;
    const r = await this.deps.run(action);
    this.lastSkill = { ok: r.ok, action: r.action, ticks: r.ticks, ...(r.reason !== undefined ? { reason: r.reason } : {}) };
    const died = this.deps.deaths() > deaths0;
    const s = this.deps.loop.state;
    const out = ep.step(s.tick, logCount(this.deps.world.inventory.slots), died);
    const corrections = Math.max(0, s.corrections - corr0);
    ep.corrections += corrections;
    const obs = this.observe();
    const inReach = obs.nearest_log?.in_reach ?? false;
    this.stats.steps++;
    return {
      t: 'obs',
      id,
      tick: Number(s.tick),
      obs,
      reward_signals: { logs_delta: out.logsDelta, died, ticks_used: out.ticksUsed, log_in_reach: inReach },
      done: out.done,
      terminated: out.terminated,
      truncated: out.truncated,
      info: {
        corrections,
        episode_corrections: ep.corrections,
        step: ep.steps,
        episode_ticks: ep.ticks,
        logs: ep.logs,
        first_log_in_reach: inReach && !this.shapedReach ? (this.shapedReach = true) : false,
        ...(out.reason ? { reason: out.reason } : {}),
        ...(r.target ? { target: [r.target.x, r.target.y, r.target.z] } : {}),
      },
    };
  }
}
