// Door collision boxes by state, measured on BDS 1.26.60.6 (docs/interaction.md "Door shapes").
// minecraft-data's bedrock blockCollisionShapes give every wooden_door state the same box
// (x 0..0.1825, the closed 'south' door), so the movement model and the nav grid see a door that never
// opens. Measured instead by walking the bot along +z into doors of every direction, open and closed,
// at x offsets 0.25 / 0.5 / 0.75, and reading where the server stopped it (truth:pos):
//
//   closed            panel on the edge clockwise of minecraft:cardinal_direction
//                     (north -> east edge, east -> south, south -> west, west -> north)
//   open, hinge 0     panel on the edge opposite the cardinal direction (north -> south edge ...)
//   open, hinge 1     panel on the cardinal direction's own edge (north -> north edge ...)
//   thickness 0.1825 (the stop distance 0.5175 = 0.8175 - 0.3 body half-width)
//
// The state lives in the LOWER half: the upper half keeps open_bit 0 when the door opens, so its
// shape must be read from the block below (`doorBoxes(upper, lower)`). Not wired into the nav grid
// or the physics here (skills/terrain belongs to the navigation track): see docs/interaction.md.
import type { BlockInfo, Box } from '../../world/types.ts';

export const DOOR_THICKNESS = 0.1825;

type Edge = 'north' | 'south' | 'west' | 'east';
const CLOCKWISE: Readonly<Record<Edge, Edge>> = { north: 'east', east: 'south', south: 'west', west: 'north' };
const OPPOSITE: Readonly<Record<Edge, Edge>> = { north: 'south', south: 'north', east: 'west', west: 'east' };

const bit = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true';

/** The cell edge the panel of a door with these (lower-half) states lies on. */
export function doorEdge(states: Readonly<Record<string, unknown>>): Edge {
  const raw = states['minecraft:cardinal_direction'];
  const dir = (typeof raw === 'string' ? raw : 'south') as Edge;
  const d: Edge = dir in CLOCKWISE ? dir : 'south';
  if (!bit(states.open_bit)) return CLOCKWISE[d];
  return bit(states.door_hinge_bit) ? d : OPPOSITE[d];
}

/** Block-local box of a panel on an edge. */
export function edgeBox(edge: Edge, t = DOOR_THICKNESS): Box {
  switch (edge) {
    case 'north':
      return [0, 0, 0, 1, 1, t];
    case 'south':
      return [0, 0, 1 - t, 1, 1, 1];
    case 'west':
      return [0, 0, 0, t, 1, 1];
    default:
      return [1 - t, 0, 0, 1, 1, 1];
  }
}

/**
 * Collision boxes of a door half. `lower` is the block below an upper half (the state holder);
 * without it an upper half is taken as closed. Undefined for blocks that are not doors.
 */
export function doorBoxes(info: BlockInfo, lower?: BlockInfo): readonly Box[] | undefined {
  if (!(info.name.endsWith('_door') || info.name === 'wooden_door')) return undefined;
  let states = info.states;
  if (bit(info.states.upper_block_bit)) {
    if (lower?.name === info.name && !bit(lower.states.upper_block_bit)) states = lower.states;
    else states = { ...info.states, open_bit: 0 };
  }
  return [edgeBox(doorEdge(states))];
}

/**
 * The body walks through the middle of a door cell along `axis` ('x' = east/west, 'z' = north/south):
 * the panel lies along that axis (on an edge parallel to the walk), not across it.
 */
export function doorPassable(states: Readonly<Record<string, unknown>>, axis: 'x' | 'z'): boolean {
  const e = doorEdge(states);
  return axis === 'z' ? e === 'west' || e === 'east' : e === 'north' || e === 'south';
}
