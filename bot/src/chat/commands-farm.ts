// Farming and legit-mining chat commands (PLAN.md tasks 7.13 and 7.14, Track U; docs/farming.md,
// docs/mining.md), owner-only like every command:
//   !farm [radius]          farm the farmland within radius (default 8, 1..32) of where the bot stands:
//                           harvest, replant, bone meal, deposit into the nearest chest; until !farm stop
//   !farm stop | status
//   !mine <block> [n]       mine n (default 1, up to 256) seen blocks of that kind (`coal`, `iron_ore`, ...)
//   !mine stop | status
// Registered by the afk task (tasks/registry.ts) with the movement stack; without it every command
// answers "<cmd> needs a task that can walk (...)". Farming and mining exclude each other, and both
// stop the PvE foreground behaviour (follow, come, kill) first.
import type { Logger } from '../log.ts';
import { createFarmer } from '../skills/farm/index.ts';
import type { FarmTask } from '../skills/farm/farmer.ts';
import { resolveTargets, type MineTask } from '../skills/mine/miner.ts';
import type { OreMemory } from '../skills/mine/seen.ts';
import { createMinerFor } from '../skills/mine/wire.ts';
import { useCachedForests, type GatherWoodTask } from '../tasks/gatherWood.ts';
import type { Mobility } from '../tasks/mobility.ts';
import { FarmProcess } from '../tasks/process/farm.ts';
import type { ProcessManager } from '../tasks/process/manager.ts';
import { MineProcess } from '../tasks/process/mine.ts';
import { Containers } from '../world/containers.ts';
import { Hotbar } from '../world/hotbar.ts';
import type { PacketSource } from '../world/types.ts';
import type { Chat } from './chat.ts';

/** What the chat commands drive (unit tests fake it). */
export interface FarmController {
  /** Start farming; the reply. */
  farm(radius: number): string;
  farmStop(): string;
  farmStatus(): string;
  /** Start mining; `onEnd` gets the final line. The immediate reply. */
  mine(block: string, n: number, onEnd: (msg: string) => void): string;
  mineStop(): string;
  mineStatus(): string;
}

export const FARM_COMMANDS = ['farm', 'mine'] as const;
const NEEDS_WALK = 'needs a task that can walk (start with --walk, --home or --target realm)';
export const DEFAULT_FARM_RADIUS = 8;
export const MAX_FARM_RADIUS = 32;
export const MAX_MINE = 256;

export function registerFarmChat(chat: Chat, c: FarmController | undefined): void {
  if (!c) {
    for (const name of FARM_COMMANDS) {
      chat.register({
        name,
        help: '(needs walking)',
        run: ({ reply }) => {
          reply(`${name} ${NEEDS_WALK}`);
        },
      });
    }
    return;
  }
  chat.register({
    name: 'farm',
    help: `[radius] | stop | status (harvest, replant, bone meal; default radius ${DEFAULT_FARM_RADIUS})`,
    run: ({ reply, args }) => {
      const a = (args[0] ?? '').toLowerCase();
      if (a === 'stop') return reply(c.farmStop());
      if (a === 'status') return reply(c.farmStatus());
      const r = a === '' ? DEFAULT_FARM_RADIUS : Number(a);
      if (!Number.isInteger(r) || r < 1 || r > MAX_FARM_RADIUS) return reply(`usage: !farm [radius 1..${MAX_FARM_RADIUS}] | stop | status`);
      reply(c.farm(r));
    },
  });
  chat.register({
    name: 'mine',
    help: '<block> [n] | stop | status (mine blocks the bot has seen; no x-ray)',
    run: ({ reply, args }) => {
      const [block, count] = args;
      const a = (block ?? '').toLowerCase();
      if (a === 'stop') return reply(c.mineStop());
      if (a === 'status') return reply(c.mineStatus());
      if (!block || !/^[a-z0-9_:]+$/i.test(block)) return reply('usage: !mine <block> [n] | stop | status');
      const n = count === undefined ? 1 : Number(count);
      if (!Number.isInteger(n) || n < 1 || n > MAX_MINE) return reply(`usage: !mine <block> [n 1..${MAX_MINE}]`);
      reply(c.mine(block, n, (m) => reply(m)));
    },
  });
}

/** One line for the end of a !mine run. */
export function mineEndLine(m: MineTask): string {
  const s = m.stats;
  const name = [...m.names][0] ?? m.opts?.block ?? '?';
  const want = m.opts?.count ?? 0;
  switch (m.state) {
    case 'done':
      return `mine ${name}: ${s.mined}/${want} done`;
    case 'none_left':
      return `mine ${name}: ${s.mined}/${want}, no seen ${name} left${s.unsafe.length ? ` (${s.unsafe.length} skipped as unsafe)` : ''}`;
    case 'low_health':
      return `mine ${name}: stopped at ${s.mined}/${want}, health low`;
    case 'no_pickaxe':
      return `mine ${name}: stopped at ${s.mined}/${want}, no pickaxe`;
    case 'stopped':
      return `mine ${name}: stopped after ${s.mined}/${want}`;
    default:
      return `mine ${name}: ${m.state} after ${s.mined}/${want}${m.lastError ? ` (${m.lastError})` : ''}`;
  }
}

export interface FarmCommandDeps {
  chat: Chat;
  /** The connection (Hotbar / Containers listen to it, clicks are queued on it). */
  conn: PacketSource;
  /** The movement stack; undefined when the task does not walk. */
  mob: Mobility | undefined;
  /** Stop other behaviours that move the bot (PvE follow / come / kill) before farming or mining. */
  stopOthers?: () => void;
  /** The bot can act besides being spawned and ready (e.g. not on the death screen). */
  alive?: () => boolean;
  logger?: (scope: string) => Logger;
  /** Settings (Track Q's registry can drive them): bone meal on/off, mining tunnel cap. */
  useBoneMeal?: () => boolean;
  mineTunnelLen?: () => number;
  /** Track Z: setting `mineSeenOnly` (default false: any known ore). */
  mineSeenOnly?: () => boolean;
  /**
   * Track Z: the afk task's process manager. With it `!farm` and `!mine` are user processes
   * (pre-empted by guard / flee / night and resumed, held by `!pause`, ended by `!stop`, shown by
   * `!status`); `stopOthers` is not used then (commands stack). Without it they run directly (tests).
   */
  processes?: ProcessManager;
  /** Track Z: the task's own Hotbar and Containers (already attached to the skills); one set per bot. */
  hotbar?: Hotbar;
  containers?: Containers;
  /** Track Z: passive ore scan over the world cache's marks every this many ticks (0 = off). Default 100. */
  oreScanTicks?: number;
  /** Track Z: the afk task's gather task (`!gather`): given the remembered forests (tasks/gatherWood.ts useCachedForests). */
  gather?: GatherWoodTask;
}

/** Track Z: passive ore scan radius (blocks around the bot). */
export const ORE_SCAN_RADIUS = 24;

export interface FarmCommandsResult {
  farm?: FarmTask;
  mine?: MineTask;
  memory?: OreMemory;
  /** The running processes (process mode). */
  farmProcess?(): FarmProcess | undefined;
  mineProcess?(): MineProcess | undefined;
}

/**
 * Register !farm and !mine on the afk task's movement stack. Uses the task's Hotbar and Containers
 * when given (Track Z: one Containers per bot, two would each log the other's item stack responses
 * as `unknown slot`); otherwise creates its own once, at registration (before connecting, so they see
 * the first inventory packets).
 */
export function registerFarmCommands(deps: FarmCommandDeps): FarmCommandsResult {
  const { mob, conn } = deps;
  if (!mob) {
    registerFarmChat(deps.chat, undefined);
    return {};
  }
  const log = deps.logger?.('farm');
  useCachedForests(deps.gather, mob.world, mob.skills.nav.blacklist); // Track Z: !gather walks to remembered forests
  let hotbar = deps.hotbar;
  let containers = deps.containers;
  if (!hotbar || !containers) {
    hotbar ??= new Hotbar(conn, { inventory: mob.world.inventory, runtimeId: () => mob.world.self.runtimeId });
    containers ??= new Containers(conn, mob.world.inventory, log ? { logger: log } : {});
    mob.skills.attach({ hotbar, containers, source: conn });
  }
  const parts = {
    skills: mob.skills,
    world: mob.world,
    loop: mob.loop,
    source: conn,
    hotbar,
    containers,
    ready: () => mob.loop.state.ready && mob.world.self.health > 0 && (deps.alive?.() ?? true),
    ...(log ? { log } : {}),
  };
  const { farm } = createFarmer(parts, deps.useBoneMeal ? { useBoneMeal: deps.useBoneMeal } : {});
  const { mine, memory } = createMinerFor(parts, {
    ...(deps.mineTunnelLen ? { tunnelLen: deps.mineTunnelLen } : {}),
    ...(deps.mineSeenOnly ? { seenOnly: deps.mineSeenOnly } : {}),
  });
  const here = () => {
    const p = mob.position();
    return p ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : undefined;
  };
  // Track Z: passive ore memory (only with a world cache: its marks make the scan cheap)
  const every = deps.oreScanTicks ?? 100;
  if (every > 0) {
    let n = 0;
    mob.loop.onBeforeStep(() => {
      if (++n % every !== 0 || !mob.world.cache || !parts.ready()) return;
      const p = mob.position();
      if (p) memory.scanMarks(p, ORE_SCAN_RADIUS);
    });
  }
  const pm = deps.processes;
  if (pm) {
    let fp: FarmProcess | undefined;
    let mp: MineProcess | undefined;
    const live = <P extends { done: boolean }>(p: P | undefined) => (p && !p.done ? p : undefined);
    registerFarmChat(deps.chat, {
      farm: (radius) => {
        const at = here();
        if (!at) return 'farm: not ready yet';
        const m = live(mp);
        if (m) pm.stop(m, 'stopped'); // farming and mining exclude each other
        fp = pm.add(new FarmProcess(farm, { center: { x: at.x + 0.5, y: at.y, z: at.z + 0.5 }, radius }));
        return `farming r=${radius} around ${at.x} ${at.y} ${at.z}${pm.paused ? ' (held: !resume)' : ''}`;
      },
      farmStop: () => {
        const p = live(fp);
        if (!p) return 'not farming';
        pm.stop(p, 'stopped');
        return `stopped; ${farm.summary()}`;
      },
      farmStatus: () => `${farm.summary()}${live(fp) ? '' : ' (no farm process)'}`,
      mine: (block, n, onEnd) => {
        if (!here()) return 'mine: not ready yet';
        const f = live(fp);
        if (f) pm.stop(f, 'stopped');
        const p = new MineProcess(mine, { block, count: n });
        mp = pm.add(p);
        void p.result.then((s) => {
          if (s !== 'stopped') onEnd(mineEndLine(mine));
        });
        return `mining ${n} ${[...resolveTargets(block)].join('/')}${pm.paused ? ' (held: !resume)' : ''}`;
      },
      mineStop: () => {
        const p = live(mp);
        if (!p) return 'not mining';
        pm.stop(p, 'stopped');
        return mineEndLine(mine);
      },
      mineStatus: () => `${mine.summary()}, ${memory.size} seen (${memory.recalled} remembered)`,
    });
    return { farm, mine, memory, farmProcess: () => live(fp), mineProcess: () => live(mp) };
  }
  registerFarmChat(deps.chat, {
    farm: (radius) => {
      const at = here();
      if (!at) return 'farm: not ready yet';
      mine.stop();
      deps.stopOthers?.();
      void farm.start({ center: { x: at.x + 0.5, y: at.y, z: at.z + 0.5 }, radius });
      return `farming r=${radius} around ${at.x} ${at.y} ${at.z}`;
    },
    farmStop: () => {
      const was = farm.running;
      farm.stop();
      return was ? `stopped; ${farm.summary()}` : 'not farming';
    },
    farmStatus: () => farm.summary(),
    mine: (block, n, onEnd) => {
      if (!here()) return 'mine: not ready yet';
      farm.stop();
      deps.stopOthers?.();
      const run = mine.start({ block, count: n });
      const names = [...mine.names].join('/');
      void run.then(() => {
        if (mine.state !== 'stopped') onEnd(mineEndLine(mine));
      });
      return `mining ${n} ${names}`;
    },
    mineStop: () => {
      const was = mine.running;
      mine.stop();
      return was ? mineEndLine(mine) : 'not mining';
    },
    mineStatus: () => `${mine.summary()}, ${mine.status().seen as number} seen`,
  });
  return { farm, mine, memory };
}
