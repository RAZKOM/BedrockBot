// Skills facade (PLAN.md section 4.3): lookAt / goto / cancel on top of the InputLoop and the
// world model. dig / collect / openContainer / deposit are TODO stubs for Phase 4 (other tracks).
//
//   const world = new World(conn);
//   const loop = new InputLoop(conn, { world: flatWorld() });   // the skills swap in real terrain
//   loop.start();
//   const skills = new BotSkills({ loop, world });
//   await conn.connect(target);
//   await skills.goto({ type: 'xz', x: 30, z: -12 });
import { silentLogger, type Logger } from '../log.ts';
import type { World } from '../world/index.ts';
import type { ContainerView, ItemStack, Vec3 } from '../world/types.ts';
import type { InputLoop } from './input/inputLoop.ts';
import { PHYSICS } from './input/physics.ts';
import { Navigator, type GotoReport, type NavigatorOptions } from './nav/navigator.ts';
import { angleDiff, turnTowards, yawTowards } from './nav/follower.ts';
import { blockQueryOf, worldSource, type BlockStore } from './terrain/query.ts';
import type { Goal, GotoOptions, SkillResult, Skills } from './types.ts';

export type { Goal, GotoOptions, SkillResult, Skills } from './types.ts';

export interface BotSkillsOptions extends NavigatorOptions {
  loop: InputLoop;
  /** The world model (`World` satisfies it). */
  world: BlockStore & Pick<World, 'onBlockUpdate'> & { self: Pick<World['self'], 'health' | 'food'> };
  logger?: Logger;
  /** Point the InputLoop's physics at the world model's real block shapes (default true). */
  usePhysicsWorld?: boolean;
}

export interface DamageEvent {
  tick: bigint;
  from: number;
  to: number;
  /** The body landed from a fall of more than 3 blocks within the 20 ticks before (fall damage). */
  falling: boolean;
  /** Height of that fall, blocks. */
  fallDistance?: number;
}

export interface SkillsStatus {
  health: number;
  food: number;
  /** Recent health drops, newest last (at most 20). */
  damage: DamageEvent[];
  corrections: number;
  motions: number;
  teleports: number;
  inWater: boolean;
  inLava: boolean;
  busy: boolean;
  lastGoto: GotoReport | undefined;
}

/** Max yaw / pitch change per tick for lookAt (degrees). */
const LOOK_TURN = 30;

export class BotSkills implements Skills {
  readonly nav: Navigator;
  private readonly loop: InputLoop;
  private readonly world: BotSkillsOptions['world'];
  private readonly log: Logger;
  private readonly damage: DamageEvent[] = [];
  private lastHealth: number | undefined;
  private airTop: number | undefined;
  private landing: { tick: bigint; fall: number } | undefined;
  private look: { yaw: number; pitch: number; ticks: number; resolve: () => void } | undefined;
  private readonly unsubs: (() => void)[] = [];

  constructor(opts: BotSkillsOptions) {
    this.loop = opts.loop;
    this.world = opts.world;
    this.log = opts.logger ?? silentLogger;
    const source = worldSource(opts.world);
    if (opts.usePhysicsWorld ?? true) this.loop.world = blockQueryOf(source);
    this.nav = new Navigator(this.loop, { source, onBlockUpdate: (fn) => opts.world.onBlockUpdate(fn) }, { ...opts, logger: this.log });
    this.unsubs.push(
      this.loop.onBeforeStep((tick, s) => {
        this.trackFall(tick, s.onGround, s.pos.y, s.inWater);
        this.trackHealth(tick);
        this.stepLook();
      }),
    );
  }

  dispose(): void {
    this.cancel();
    this.nav.dispose();
    for (const u of this.unsubs.splice(0)) u();
  }

  lookAt(p: Vec3): Promise<void> {
    const s = this.loop.state;
    const eye = { x: s.pos.x, y: s.pos.y + PHYSICS.eyeHeight, z: s.pos.z };
    const dx = p.x - eye.x;
    const dy = p.y - eye.y;
    const dz = p.z - eye.z;
    const yaw = Math.hypot(dx, dz) > 1e-6 ? yawTowards(dx, dz) : this.loop.command.yaw;
    const pitch = (-Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI;
    this.look?.resolve();
    return new Promise((resolve) => {
      this.look = { yaw, pitch, ticks: 0, resolve };
    });
  }

  goto(goal: Goal, opts?: GotoOptions): Promise<SkillResult> {
    return this.nav.goto(goal, opts);
  }

  // TODO(Phase 4, task 4.1): block breaking inside player_auth_input (another track).
  dig(_p: Vec3, _opts?: { tool?: 'best' | number }): Promise<SkillResult> {
    return Promise.resolve({ ok: false, reason: 'not_implemented' });
  }

  // TODO(Phase 4, task 4.4): walk over item entities.
  collect(_radius: number, _timeoutTicks: number): Promise<SkillResult> {
    return Promise.resolve({ ok: false, reason: 'not_implemented' });
  }

  // TODO(Phase 4, task 4.5).
  openContainer(_p: Vec3): Promise<ContainerView> {
    return Promise.reject(new Error('openContainer: not implemented'));
  }

  // TODO(Phase 4, task 4.5).
  deposit(_view: ContainerView, _filter: (i: ItemStack) => boolean): Promise<SkillResult> {
    return Promise.resolve({ ok: false, reason: 'not_implemented' });
  }

  cancel(): void {
    this.nav.cancel();
    this.look?.resolve();
    this.look = undefined;
  }

  status(): SkillsStatus {
    const s = this.loop.state;
    return {
      health: this.world.self.health,
      food: this.world.self.food,
      damage: [...this.damage],
      corrections: s.corrections,
      motions: s.motions,
      teleports: s.teleports,
      inWater: s.inWater,
      inLava: s.inLava,
      busy: this.nav.busy,
      lastGoto: this.nav.lastReport,
    };
  }

  private trackHealth(tick: bigint): void {
    const h = this.world.self.health;
    if (this.lastHealth !== undefined && h < this.lastHealth) {
      const l = this.landing;
      const falling = l !== undefined && l.fall > 3 && tick - l.tick <= 20n;
      const e: DamageEvent = { tick, from: this.lastHealth, to: h, falling, ...(falling ? { fallDistance: +l.fall.toFixed(3) } : {}) };
      this.damage.push(e);
      if (this.damage.length > 20) this.damage.shift();
      this.log.info(`health ${e.from} -> ${e.to}${e.falling ? ' (fall)' : ''}`);
    }
    this.lastHealth = h;
  }

  private trackFall(tick: bigint, onGround: boolean, y: number, inWater: boolean): void {
    if (inWater) {
      this.airTop = undefined;
      return;
    }
    if (!onGround) {
      this.airTop = Math.max(this.airTop ?? y, y);
    } else if (this.airTop !== undefined) {
      this.landing = { tick, fall: this.airTop - y };
      this.airTop = undefined;
    }
  }

  private stepLook(): void {
    const l = this.look;
    if (!l) return;
    const cmd = this.loop.command;
    const yaw = turnTowards(cmd.yaw, l.yaw, LOOK_TURN);
    const dp = l.pitch - cmd.pitch;
    const pitch = Math.abs(dp) <= LOOK_TURN ? l.pitch : cmd.pitch + Math.sign(dp) * LOOK_TURN;
    this.loop.setCommand({ yaw, pitch });
    l.ticks++;
    if ((Math.abs(angleDiff(yaw, l.yaw)) < 0.01 && Math.abs(pitch - l.pitch) < 0.01) || l.ticks > 40) {
      this.look = undefined;
      l.resolve();
    }
  }
}

export { Navigator } from './nav/navigator.ts';
export type { GotoReport, NavWorld, NavigatorOptions } from './nav/navigator.ts';
