// Task registry for the CLI (`bot --task <name>`). Each task is a `TaskDefinition` (tasks/base.ts).
// To add one: write `tasks/<name>.ts` exporting a TaskDefinition (or a factory) and register it, either
// here with `registerTask(...)` at the bottom, or from bot/src/index.ts's "task registrations" block.
import type { Chat } from '../chat/chat.ts';
import { formatChatLine } from '../chat/text.ts';
import { AfkTask } from './afk.ts';
import type { RunningTask, TaskContext, TaskDefinition } from './base.ts';
import { EchoTask } from './echo.ts';
import { homeHook } from './mobility.ts';
import { NightSafety } from './night.ts';
import type { Vec3 } from '../connection/types.ts';

const TASKS = new Map<string, TaskDefinition>();

export function registerTask(def: TaskDefinition): void {
  if (TASKS.has(def.name)) throw new Error(`task "${def.name}" is registered twice`);
  TASKS.set(def.name, def);
}

export function getTask(name: string): TaskDefinition | undefined {
  return TASKS.get(name);
}

export function taskNames(): string[] {
  return [...TASKS.keys()];
}

export function allTasks(): TaskDefinition[] {
  return [...TASKS.values()];
}

/** Home/shelter access for the !home and !shelter chat commands (tasks that walk). */
export interface PointAccess {
  get(): Vec3 | undefined;
  set(p: Vec3 | undefined): void;
}

export interface WalkingTask extends RunningTask {
  home?: PointAccess;
  shelter?: PointAccess & { state(): string };
}

// ---- built-in tasks ---------------------------------------------------------------------------

export const echoTask: TaskDefinition = {
  name: 'echo',
  summary: 'print chat and position',
  defaultUsername: 'EchoBot',
  create(ctx) {
    const echo = new EchoTask(ctx.conn);
    return {
      name: 'echo',
      start: () => {
        echo.start();
      },
      stop: () => {
        echo.stop();
      },
      status: () => echo.status(),
      position: () => echo.feet,
    };
  },
};

export const afkTask: TaskDefinition = {
  name: 'afk',
  summary: 'stay online: keepalive nudges, auto-respawn, optional home point and night shelter',
  defaultUsername: 'AfkBot',
  create(ctx: TaskContext): WalkingTask {
    const o = ctx.options;
    const log = ctx.log;
    const respawn = ctx.respawn();
    const clock = ctx.clock();
    const walking = o.walk || o.home !== undefined || o.shelter !== undefined;
    const mob = walking ? ctx.mobility() : undefined;
    let home = o.home;
    const afk = new AfkTask(ctx.conn, {
      nudgeIntervalMs: o.nudgeIntervalS * 1000,
      heartbeat: o.heartbeat,
      metrics: ctx.metrics,
      log,
      respawn,
      loop: mob?.loop,
      busy: () => mob?.skills.nav.busy ?? false,
    });
    let night: NightSafety | undefined;
    if (mob) {
      const n = new NightSafety({
        clock,
        mover: mob.skills,
        position: () => mob.position(),
        inactive: () => respawn.dead || ctx.conn.state !== 'spawned',
        shelter: o.shelter,
        home: () => home,
        log: ctx.logger('night'),
        metrics: ctx.metrics,
      });
      night = n;
      respawn.onEvent((e) => {
        if (e.kind === 'death') mob.skills.cancel();
      });
      respawn.afterRespawn(
        homeHook({
          skills: mob.skills,
          home: () => home,
          skip: () => n.wantsShelter(),
          settle: async () => {
            await mob.world.waitForChunks(2, { timeoutMs: 10_000 }).catch(() => undefined);
            await mob.loop.waitTicks(10);
          },
          log,
          onResult: (r) => {
            ctx.metrics.inc(r.ok ? 'home.returns' : 'home.failed');
          },
        }),
      );
    }
    log.info(
      `afk: nudge every ${o.nudgeIntervalS > 0 ? `${o.nudgeIntervalS} s` : 'never'}${o.heartbeat ? ', heartbeat every tick' : ''}` +
        (mob ? `, walking (home ${fmt(home)}, shelter ${fmt(o.shelter)})` : ''),
    );
    const task: WalkingTask = {
      name: 'afk',
      start: () => {
        afk.start();
        night?.start();
      },
      stop: () => {
        night?.stop();
        afk.stop();
        mob?.dispose();
      },
      status: () => ({
        ...afk.status(),
        respawn: respawn.status(),
        clock: clock.status(),
        night: night?.status() ?? null,
        home: home ?? null,
        lastGoto: mob?.skills.nav.lastReport?.result ?? null,
      }),
      position: () => mob?.position() ?? afk.feet,
      statusLine: () => ({ task: 'afk', nudges: afk.nudges, corrections: afk.corrections, deaths: respawn.deaths }),
      alive: () => !respawn.dead,
    };
    if (mob && night) {
      const n = night;
      task.home = {
        get: () => home,
        set: (p) => {
          home = p;
          log.info(p ? `home set to ${fmt(p)}` : 'home cleared');
        },
      };
      task.shelter = {
        get: () => n.shelter,
        set: (p) => {
          n.setShelter(p);
        },
        state: () => String(n.status().state),
      };
    }
    return task;
  },
};

function fmt(p: Vec3 | undefined): string {
  return p ? `${p.x} ${p.y} ${p.z}` : 'none';
}

/** `--exit-on-chat <s>`: call `fn` once a chat line (as printed by echo) contains `s`. */
export function onChatContaining(chat: Chat, s: string, fn: () => void): () => void {
  return chat.onLine((line) => {
    if (formatChatLine(line).includes(s) || line.message.includes(s)) fn();
  });
}

registerTask(echoTask);
registerTask(afkTask);
