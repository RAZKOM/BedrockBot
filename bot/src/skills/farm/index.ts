// Farming and legit mining wired onto the bot's movement stack (PLAN.md tasks 7.13 and 7.14):
// `createFarmer` / `createMiner` build the tasks from BotSkills, the World, the InputLoop and the
// Hotbar / Containers, the way the chat commands (chat/commands-farm.ts) and the e2e tests use them.
import type { Logger } from '../../log.ts';
import type { Containers } from '../../world/containers.ts';
import type { Hotbar } from '../../world/hotbar.ts';
import type { World } from '../../world/index.ts';
import type { PacketSource, Vec3 } from '../../world/types.ts';
import type { BotSkills } from '../index.ts';
import type { InputLoop } from '../input/inputLoop.ts';
import { breakBlocker } from '../nav/actions.ts';
import { MineTask } from '../mine/miner.ts';
import { OreMemory } from '../mine/seen.ts';
import { ItemClicker } from './click.ts';
import { FarmTask } from './farmer.ts';

export interface FarmParts {
  skills: BotSkills;
  world: World;
  loop: InputLoop;
  source: Pick<PacketSource, 'queue'>;
  hotbar?: Hotbar;
  containers?: Containers;
  /** The bot can act (spawned, loop ready, alive). Default: loop ready and health > 0. */
  ready?: () => boolean;
  log?: Logger;
}

function readyOf(p: FarmParts): () => boolean {
  return p.ready ?? (() => p.loop.state.ready && p.world.self.health > 0);
}

/** FarmTask with its bone-meal clicker. `useBoneMeal` is read every round (default true). */
export function createFarmer(p: FarmParts, settings: { useBoneMeal?: () => boolean } = {}): { farm: FarmTask; clicker: ItemClicker } {
  const { skills, world, loop } = p;
  const clicker = new ItemClicker({
    source: p.source,
    loop,
    world: { blockAt: (q) => world.blockAt(q), onBlockUpdate: (fn) => world.onBlockUpdate(fn), chunks: world.chunks, inventory: world.inventory },
    ...(p.hotbar ? { hotbar: p.hotbar } : {}),
    ...(p.containers ? { containers: p.containers } : {}),
    runtimeId: () => world.self.runtimeId,
    ...(p.log ? { logger: p.log } : {}),
  });
  const farm = new FarmTask({
    skills,
    plan: (goal) => skills.nav.plan(goal),
    stand: (x, y, z) => skills.nav.grid.stand(x, y, z),
    world,
    click: (q, item) => clicker.useOn(q, item),
    cancelClick: () => clicker.cancel(),
    position: () => (loop.state.ready ? loop.state.pos : undefined),
    ready: readyOf(p),
    waitTicks: (n) => loop.waitTicks(n),
    ...(settings.useBoneMeal ? { useBoneMeal: settings.useBoneMeal } : {}),
    ...(p.log ? { log: p.log } : {}),
  });
  return { farm, clicker };
}

/** MineTask with its ore memory. `tunnelLen` (mineTunnelLen) is read for every target (default 32). */
export function createMiner(p: FarmParts, settings: { tunnelLen?: () => number } = {}): { mine: MineTask; memory: OreMemory } {
  const { skills, world, loop } = p;
  const memory = new OreMemory(world);
  const feetFloor = (): Vec3[] => {
    const s = loop.state.pos;
    return [{ x: Math.floor(s.x), y: Math.floor(s.y + 1e-6) - 1, z: Math.floor(s.z) }];
  };
  const mine = new MineTask({
    skills,
    memory,
    plan: (goal, opts) => skills.nav.plan(goal, undefined, opts),
    breakRule: (q) => breakBlocker(skills.nav.grid, q.x, q.y, q.z, skills.nav.breakRules(), feetFloor()),
    stand: (x, y, z) => skills.nav.grid.stand(x, y, z),
    blockAt: (q) => world.blockAt(q),
    inventory: world.inventory,
    position: () => (loop.state.ready ? loop.state.pos : undefined),
    health: () => world.self.health,
    ready: readyOf(p),
    waitTicks: (n) => loop.waitTicks(n),
    ...(settings.tunnelLen ? { tunnelLen: settings.tunnelLen } : {}),
    ...(p.log ? { log: p.log } : {}),
  });
  return { mine, memory };
}

export { FarmTask, workInReach, routeTramples, floorOf, eyeAt } from './farmer.ts';
export type { FarmOptions, FarmState, FarmStats, FarmDeps } from './farmer.ts';
export { ItemClicker } from './click.ts';
export { CROPS, scanField, fieldCell, growthOf, isMature, cropForSeed } from './crops.ts';
export { MineTask, resolveTargets } from '../mine/miner.ts';
export { OreMemory, isExposed, lineOfSight } from '../mine/seen.ts';
