// The movement stack for tasks that walk (AFK with a home point or a shelter, gather-wood, ...):
// Connection -> World (chunks, block updates, self) -> InputLoop (physics, one player_auth_input per
// tick) -> BotSkills (goto, lookAt). Same wiring as bot/test/e2e/move-truth.ts. Create it BEFORE
// conn.connect() so the World and the InputLoop see start_game and the spawn.
import type { Connection } from '../connection/connection.ts';
import type { Vec3 } from '../connection/types.ts';
import { silentLogger, type Logger } from '../log.ts';
import { BotSkills } from '../skills/index.ts';
import { InputLoop, flatWorld } from '../skills/input/index.ts';
import type { SkillResult } from '../skills/types.ts';
import { World } from '../world/index.ts';
import type { DeathRecord, RespawnHook } from './respawn.ts';

export interface Mobility {
  world: World;
  loop: InputLoop;
  skills: BotSkills;
  /** Feet position from the input loop (the bot's own simulation), when ready. */
  position(): Vec3 | undefined;
  dispose(): void;
}

export function createMobility(conn: Connection, opts: { version: string; log?: Logger }): Mobility {
  const log = opts.log ?? silentLogger;
  const world = new World(conn, { version: opts.version, logger: log });
  // flatWorld() until the skills point the loop at the world model (BotSkills does that).
  const loop = new InputLoop(conn, { world: flatWorld(), logger: log, canSprint: () => world.self.food > 6 });
  const skills = new BotSkills({ loop, world, logger: log });
  loop.start();
  return {
    world,
    loop,
    skills,
    position: () => (loop.state.ready ? loop.state.pos : undefined),
    dispose: () => {
      skills.dispose();
      loop.stop();
      world.dispose();
    },
  };
}

/** Feet block -> goal for goto. */
export function blockGoal(p: Vec3): { type: 'block'; p: Vec3 } {
  return { type: 'block', p: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } };
}

export interface HomeHookOptions {
  skills: Pick<BotSkills, 'goto' | 'cancel'>;
  home: () => Vec3 | undefined;
  /** Skip (return true) e.g. while night safety wants the shelter. */
  skip?: () => boolean;
  /** Wait for chunks around the respawn point before planning. Default: 3 s of ticks via `settle`. */
  settle?: () => Promise<void>;
  log?: Logger;
  onResult?: (r: SkillResult, death: DeathRecord | undefined) => void;
  timeoutTicks?: number;
}

/** After-respawn hook: walk back to the home point (PLAN.md task 5.1 "return to the chest"). */
export function homeHook(o: HomeHookOptions): RespawnHook {
  const log = o.log ?? silentLogger;
  return async (_feet, death, signal) => {
    const home = o.home();
    if (!home || o.skip?.()) return;
    await o.settle?.();
    if (signal.aborted) return;
    log.info(`returning home to ${home.x} ${home.y} ${home.z} after death ${death?.n ?? '?'}`);
    const onAbort = () => {
      o.skills.cancel();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const r = await o.skills.goto(blockGoal(home), { timeoutTicks: o.timeoutTicks ?? 6000 });
      log[r.ok ? 'info' : 'warn'](`return home: ${r.ok ? 'arrived' : r.reason}`);
      o.onResult?.(r, death);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  };
}
