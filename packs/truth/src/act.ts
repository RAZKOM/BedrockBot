// Interaction commands and events (PLAN.md Phase 7 task 7.3, Track O: placing and using blocks).
// Stable @minecraft/server 2.10.0 only. Registered by main.ts through `actHandlers(deps)` and
// `actEvents(emit)`; see ../README.md ("Interaction commands").
//
//   setblock x y z typeId [state=value ...]   one block with block states (BlockPermutation.resolve);
//                                             values: true/false -> boolean, integers -> number, else string
//   door x y z typeId direction [hinge] [open] both halves of a door (lower at y, upper at y + 1);
//                                             direction = minecraft:cardinal_direction (north|south|east|west)
//   events playerPlaceBlock {player, x, y, z, typeId, states}
//          playerInteractWithBlock {player, x, y, z, typeId, face, item, first}
import { BlockPermutation, world, type Block, type Dimension } from '@minecraft/server';
import { TruthError, blockPos, box, nsId, type Box, type Vec3 } from './protocol.js';

/** What main.ts lends to these handlers. */
export interface ActDeps {
  getBlock(dim: Dimension, p: Vec3): Block;
  assertLoaded(dim: Dimension, b: Box): void;
  overworld(): Dimension;
}

type ActHandler = (args: string[]) => unknown;
type StateValue = boolean | number | string;

/** `key=value` tokens to a block-state record. */
export function parseStates(tokens: string[]): Record<string, StateValue> {
  const out: Record<string, StateValue> = {};
  for (const t of tokens) {
    const eq = t.indexOf('=');
    if (eq <= 0) throw new TruthError('bad_args', `state must be key=value: ${t}`);
    const k = t.slice(0, eq);
    const v = t.slice(eq + 1);
    out[k] = v === 'true' ? true : v === 'false' ? false : /^-?\d+$/.test(v) ? Number(v) : v;
  }
  return out;
}

function permutation(typeId: string, states: Record<string, StateValue>): BlockPermutation {
  try {
    return BlockPermutation.resolve(nsId(typeId), states);
  } catch (e) {
    throw new TruthError('bad_states', `cannot resolve ${typeId} ${JSON.stringify(states)}: ${String(e)}`, { typeId, states });
  }
}

export function actHandlers(deps: ActDeps): Record<string, ActHandler> {
  const { getBlock, assertLoaded, overworld } = deps;
  return {
    setblock(args) {
      const p = blockPos(args, 0);
      const typeId = args[3];
      if (!typeId) throw new TruthError('bad_args', 'usage: setblock x y z typeId [state=value ...]');
      const dim = overworld();
      assertLoaded(dim, box(p, p));
      const b = getBlock(dim, p);
      b.setPermutation(permutation(typeId, parseStates(args.slice(4))));
      return { ...p, typeId: b.typeId, states: b.permutation.getAllStates() };
    },

    door(args) {
      const p = blockPos(args, 0);
      const typeId = args[3];
      const direction = args[4];
      if (!typeId || !direction) throw new TruthError('bad_args', 'usage: door x y z typeId direction [hinge 0|1] [open 0|1]');
      const hinge = args[5] === '1' || args[5] === 'true';
      const open = args[6] === '1' || args[6] === 'true';
      const dim = overworld();
      const top = { ...p, y: p.y + 1 };
      assertLoaded(dim, box(p, top));
      const states = { 'minecraft:cardinal_direction': direction, door_hinge_bit: hinge, open_bit: open };
      // Upper half first: setting the lower half alone next to air would let the game drop it.
      const upper = getBlock(dim, top);
      upper.setPermutation(permutation(typeId, { ...states, upper_block_bit: true }));
      const lower = getBlock(dim, p);
      lower.setPermutation(permutation(typeId, { ...states, upper_block_bit: false }));
      return {
        lower: { ...p, typeId: lower.typeId, states: lower.permutation.getAllStates() },
        upper: { ...top, typeId: upper.typeId, states: upper.permutation.getAllStates() },
      };
    },
  };
}

/** Subscribes the interaction events; `emit` is main.ts's event sender. */
export function actEvents(emit: (type: string, data: Record<string, unknown>) => void): void {
  world.afterEvents.playerPlaceBlock.subscribe((ev) => {
    const b = ev.block;
    emit('playerPlaceBlock', { player: ev.player.name, x: b.location.x, y: b.location.y, z: b.location.z, typeId: b.typeId, states: b.permutation.getAllStates() });
  });
  world.afterEvents.playerInteractWithBlock.subscribe((ev) => {
    const b = ev.block;
    emit('playerInteractWithBlock', {
      player: ev.player.name,
      x: b.location.x,
      y: b.location.y,
      z: b.location.z,
      typeId: b.typeId,
      states: b.permutation.getAllStates(),
      face: String(ev.blockFace),
      item: ev.itemStack?.typeId ?? null,
      first: ev.isFirstEvent,
    });
  });
}
