// Survival-policy commands (wave 7, Track W: flee v2, trip readiness, sleeping; docs/survival.md
// "Sleep", docs/pve.md "Flee"). Stable @minecraft/server 2.10.0 only. Registered by main.ts through
// `gauntHandlers(deps)`.
//
//   bed x y z direction       both halves of a bed: the foot at (x, y, z), the head one block towards
//                             `direction` (0 south +z, 1 west -x, 2 north -z, 3 east +x: the `direction`
//                             block state) -> {foot, head, footStates, headStates}
//   sleeping playerName       -> {name, sleeping (Player.isSleeping), location, timeOfDay, day}
import { BlockPermutation, world, type Block, type Dimension } from '@minecraft/server';
import { TruthError, blockPos, box, int, type Box, type Vec3 } from './protocol.js';

/** What main.ts lends to these handlers. */
export interface GauntDeps {
  getBlock(dim: Dimension, p: Vec3): Block;
  assertLoaded(dim: Dimension, b: Box): void;
  overworld(): Dimension;
}

type GauntHandler = (args: string[]) => unknown;

/** Offset from the foot to the head for the bed `direction` state. */
export const BED_HEAD_OFFSET: readonly Vec3[] = [
  { x: 0, y: 0, z: 1 }, // 0 south
  { x: -1, y: 0, z: 0 }, // 1 west
  { x: 0, y: 0, z: -1 }, // 2 north
  { x: 1, y: 0, z: 0 }, // 3 east
];

export function gauntHandlers(deps: GauntDeps): Record<string, GauntHandler> {
  const { getBlock, assertLoaded, overworld } = deps;
  return {
    bed(args) {
      const foot = blockPos(args, 0);
      const dir = int(args[3], 'direction');
      const off = BED_HEAD_OFFSET[dir];
      if (!off) throw new TruthError('bad_args', 'direction must be 0..3 (south, west, north, east)');
      const head = { x: foot.x + off.x, y: foot.y, z: foot.z + off.z };
      const dim = overworld();
      assertLoaded(dim, box(foot, head));
      const fb = getBlock(dim, foot);
      const hb = getBlock(dim, head);
      fb.setPermutation(BlockPermutation.resolve('minecraft:bed', { direction: dir, head_piece_bit: false, occupied_bit: false }));
      hb.setPermutation(BlockPermutation.resolve('minecraft:bed', { direction: dir, head_piece_bit: true, occupied_bit: false }));
      return { foot, head, footStates: fb.permutation.getAllStates(), headStates: hb.permutation.getAllStates(), typeId: fb.typeId };
    },

    sleeping(args) {
      const name = args[0];
      if (!name) throw new TruthError('bad_args', 'usage: sleeping playerName');
      const p = world.getPlayers({ name })[0];
      if (!p) throw new TruthError('player_not_found', `no player ${name}`, { name });
      const l = p.location;
      return { name: p.name, sleeping: p.isSleeping, location: { x: l.x, y: l.y, z: l.z }, timeOfDay: world.getTimeOfDay(), day: world.getDay() };
    },
  };
}
