// Dimension commands (wave 10, Track AT; docs/nether.md "Truth commands"): read a player's dimension,
// teleport across dimensions, and read / write blocks in any dimension (the core commands in main.ts
// only touch the overworld). Stable @minecraft/server 2.10.0 only. Registered by main.ts through
// `netherHandlers(deps)`. `dim` is overworld | nether | the_end (also 0 | 1 | 2).
//
//   dimension playerName                      -> {name, dimension, id, location}
//   dimtp playerName dim x y z [yaw]          -> {name, from, dimension, to}: Player.teleport with `dimension`
//   dblock dim x y z                          -> {dimension, x, y, z, typeId, states}
//   dset dim x y z typeId                     -> {dimension, x, y, z, typeId}
//   dfill dim x1 y1 z1 x2 y2 z2 typeId        -> {dimension, from, to, volume, typeId} (at most 32768 blocks)
//   dfind dim x1 y1 z1 x2 y2 z2 pattern [max] -> {dimension, count, positions: [x, y, z][], byType}
//                                                (typeIds containing `pattern`, at most 32768 blocks scanned)
//   portal dim x y z axis [lit]               -> {dimension, frame: {from, to}, inside: {from, to}, lit}: an
//                                                obsidian frame 4 wide, 5 high whose lower-left corner is
//                                                (x, y, z), along x (axis x) or z (axis z); with `lit` (default
//                                                1) the 2 x 3 inside is filled with portal blocks
//                                                (fire set inside lights it), with 0 it is air
import { BlockPermutation, BlockVolume, world, type Block, type Dimension } from '@minecraft/server';
import { TruthError, blockPos, box, exactPos, int, iterateBox, nsId, num, type Box, type Vec3 } from './protocol.js';

/** What main.ts lends to these handlers. */
export interface NetherDeps {
  getBlock(dim: Dimension, p: Vec3): Block;
  assertLoaded(dim: Dimension, b: Box): void;
}

type NetherHandler = (args: string[]) => unknown;

const MAX_VOLUME = 32768;
const DIM_IDS: Record<string, string> = {
  overworld: 'overworld',
  '0': 'overworld',
  nether: 'nether',
  '1': 'nether',
  the_end: 'the_end',
  end: 'the_end',
  '2': 'the_end',
};

function dimOf(arg: string | undefined): Dimension {
  const id = DIM_IDS[(arg ?? '').replace(/^minecraft:/, '').toLowerCase()];
  if (!id) throw new TruthError('bad_args', `dimension must be overworld | nether | the_end, got ${arg}`);
  return world.getDimension(id);
}

function playerByName(name: string | undefined) {
  if (!name) throw new TruthError('bad_args', 'player name required');
  const p = world.getPlayers({ name })[0];
  if (!p) throw new TruthError('player_not_found', `no player ${name}`, { name });
  return p;
}

const short = (id: string): string => id.replace(/^minecraft:/, '');
const vec = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });

export function netherHandlers(deps: NetherDeps): Record<string, NetherHandler> {
  const { getBlock, assertLoaded } = deps;
  return {
    dimension(args) {
      const p = playerByName(args[0]);
      return { name: p.name, dimension: short(p.dimension.id), id: p.dimension.id, location: vec(p.location) };
    },

    dimtp(args) {
      const p = playerByName(args[0]);
      const dim = dimOf(args[1]);
      const to = exactPos(args, 2);
      const yaw = args[5];
      const from = short(p.dimension.id);
      p.teleport(to, { dimension: dim, ...(yaw !== undefined ? { rotation: { x: 0, y: num(yaw, 'yaw') } } : {}) });
      return { name: p.name, from, dimension: short(dim.id), to };
    },

    dblock(args) {
      const dim = dimOf(args[0]);
      const p = blockPos(args, 1);
      assertLoaded(dim, box(p, p));
      const b = getBlock(dim, p);
      return { dimension: short(dim.id), ...p, typeId: b.typeId, states: b.permutation.getAllStates() };
    },

    dset(args) {
      const dim = dimOf(args[0]);
      const p = blockPos(args, 1);
      const typeId = args[4];
      if (!typeId) throw new TruthError('bad_args', 'usage: dset dim x y z typeId');
      assertLoaded(dim, box(p, p));
      const b = getBlock(dim, p);
      b.setType(nsId(typeId));
      return { dimension: short(dim.id), ...p, typeId: b.typeId };
    },

    dfill(args) {
      const dim = dimOf(args[0]);
      const b = box(blockPos(args, 1), blockPos(args, 4));
      const typeId = args[7];
      if (!typeId) throw new TruthError('bad_args', 'usage: dfill dim x1 y1 z1 x2 y2 z2 typeId');
      if (b.volume > MAX_VOLUME) throw new TruthError('too_large', `volume ${b.volume} > ${MAX_VOLUME}`, { volume: b.volume, max: MAX_VOLUME });
      assertLoaded(dim, b);
      dim.fillBlocks(new BlockVolume(b.min, b.max), nsId(typeId));
      return { dimension: short(dim.id), from: b.min, to: b.max, volume: b.volume, typeId: nsId(typeId) };
    },

    dfind(args) {
      const dim = dimOf(args[0]);
      const b = box(blockPos(args, 1), blockPos(args, 4));
      const pattern = args[7];
      if (!pattern) throw new TruthError('bad_args', 'usage: dfind dim x1 y1 z1 x2 y2 z2 pattern [max]');
      const max = args[8] === undefined ? 4096 : int(args[8], 'max');
      if (b.volume > MAX_VOLUME) throw new TruthError('too_large', `volume ${b.volume} > ${MAX_VOLUME}`, { volume: b.volume, max: MAX_VOLUME });
      assertLoaded(dim, b);
      const positions: number[][] = [];
      const byType: Record<string, number> = {};
      let count = 0;
      for (const p of iterateBox(b)) {
        const id = getBlock(dim, p).typeId;
        if (!id.includes(pattern)) continue;
        count++;
        byType[short(id)] = (byType[short(id)] ?? 0) + 1;
        if (positions.length < max) positions.push([p.x, p.y, p.z]);
      }
      return { dimension: short(dim.id), count, positions, byType };
    },

    portal(args) {
      const dim = dimOf(args[0]);
      const o = blockPos(args, 1);
      const axis = (args[4] ?? 'x').toLowerCase();
      if (axis !== 'x' && axis !== 'z') throw new TruthError('bad_args', 'axis must be x or z');
      const lit = args[5] === undefined ? true : args[5] !== '0' && args[5] !== 'false';
      const ax = axis === 'x' ? 1 : 0;
      const az = axis === 'z' ? 1 : 0;
      const at = (i: number, j: number): Vec3 => ({ x: o.x + ax * i, y: o.y + j, z: o.z + az * i });
      const frame = box(at(0, 0), at(3, 4));
      assertLoaded(dim, frame);
      // the frame: columns 0 and 3, rows 0 and 4; the corners too (vanilla does not need them)
      for (let i = 0; i <= 3; i++) {
        for (let j = 0; j <= 4; j++) {
          const edge = i === 0 || i === 3 || j === 0 || j === 4;
          if (edge) getBlock(dim, at(i, j)).setType('minecraft:obsidian');
        }
      }
      const inside = box(at(1, 1), at(2, 3));
      const air = BlockPermutation.resolve('minecraft:air');
      for (const p of iterateBox(inside)) getBlock(dim, p).setPermutation(air);
      // Portal blocks set directly vanish again (BDS 1.26.60); fire placed inside a complete frame lights
      // it like flint and steel (the whole 2 x 3 inside turns into portal blocks in the same tick).
      if (lit) getBlock(dim, at(1, 1)).setType('minecraft:fire');
      const check = getBlock(dim, at(1, 1));
      return { dimension: short(dim.id), frame: { from: frame.min, to: frame.max }, inside: { from: inside.min, to: inside.max }, lit, typeId: check.typeId, states: check.permutation.getAllStates() };
    },
  };
}
