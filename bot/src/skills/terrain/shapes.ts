// Per-state collision shapes from minecraft-data's bedrock `blockCollisionShapes` (the same 1.26.30
// block data the world registry uses; PLAN.md fact 3a). prismarine-registry does not attach these
// to bedrock blocks, so the world model's `BlockInfo.boxes` is a full cube for every block whose
// boundingBox is "block" (slabs, stairs, fences, carpets ...). Movement and pathfinding read the real
// shapes from here instead. See docs/pathfinding.md.
import { createRequire } from 'node:module';
import { blockHash } from '../../world/registry.ts';
import type { BlockInfo, Box } from '../../world/types.ts';

const require = createRequire(import.meta.url);

interface MdBlock {
  name: string;
  minStateId: number;
  maxStateId: number;
  defaultState: number;
  boundingBox: string;
  hardness?: number | null;
}

interface MdBlockState {
  name: string;
  states: Record<string, { type: string; value: unknown }>;
}

interface MinecraftData {
  blocksByName: Record<string, MdBlock | undefined>;
  blocksByStateId: Record<number, MdBlock | undefined>;
  blockStates: MdBlockState[];
  blockCollisionShapes?: { blocks: Record<string, number | number[]>; shapes: Record<string, number[][]> };
}

/**
 * minecraft-data version key whose block tables match the world registry (shims 1.26.51 and 1.26.60 ->
 * data 1.26.30). Stays `bedrock_1.26.51` after the default moved to 1.26.60 (2026-10-28): both keys
 * point at the same 1.26.30 blocks and collision shapes (docs/versions.md), and this one needs no patch.
 */
export const SHAPES_DATA_VERSION = 'bedrock_1.26.51';

const FULL: Box = Object.freeze([0, 0, 0, 1, 1, 1] as const);
const NONE: readonly Box[] = Object.freeze([]);

let md: MinecraftData | undefined;
function data(): MinecraftData {
  md ??= (require('minecraft-data') as (v: string) => MinecraftData)(SHAPES_DATA_VERSION);
  return md;
}

const byStateId: (readonly Box[] | undefined)[] = [];

/**
 * Collision boxes (block-local, y may exceed 1 for fences and walls) of a minecraft-data state id.
 * Undefined when the state id is unknown to the data.
 */
export function boxesOfState(stateId: number): readonly Box[] | undefined {
  if (stateId < 0) return undefined;
  const cached = byStateId[stateId];
  if (cached) return cached;
  const d = data();
  const block = d.blocksByStateId[stateId];
  if (!block) return undefined;
  const shapes = d.blockCollisionShapes;
  const entry = shapes?.blocks[block.name];
  let boxes: readonly Box[];
  if (isDoorName(block.name)) {
    // minecraft-data has one shape for every door state: derive it from the states instead
    boxes = doorBoxes(statesOf(d, stateId));
  } else if (entry === undefined || !shapes) {
    boxes = block.boundingBox === 'block' ? Object.freeze([FULL]) : NONE;
  } else {
    const id = typeof entry === 'number' ? entry : (entry[stateId - block.minStateId] ?? entry[0]);
    const raw = id === undefined ? undefined : shapes.shapes[String(id)];
    boxes = raw ? Object.freeze(raw.map((b): Box => Object.freeze([b[0]!, b[1]!, b[2]!, b[3]!, b[4]!, b[5]!] as const))) : NONE;
  }
  byStateId[stateId] = boxes;
  return boxes;
}

function statesOf(d: MinecraftData, stateId: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d.blockStates[stateId]?.states ?? {})) out[k] = v.value;
  return out;
}

// ---- doors ------------------------------------------------------------------------------------

/** Door panel thickness (Bedrock block data: 0.1825). */
export const DOOR_THICKNESS = 0.1825;

/** Doors (not trapdoors): `wooden_door`, `iron_door`, `spruce_door`, `copper_door` ... */
export function isDoorName(name: string): boolean {
  return name.endsWith('_door') && !name.endsWith('trapdoor');
}

type Side = 'north' | 'south' | 'west' | 'east';
const T = DOOR_THICKNESS;
/** Panel boxes named like Java's DoorBlock AABB constants (SOUTH_AABB is the panel at z 0..t). */
const PANEL: Record<Side, Box> = {
  south: Object.freeze([0, 0, 0, 1, 1, T] as const),
  north: Object.freeze([0, 0, 1 - T, 1, 1, 1] as const),
  west: Object.freeze([1 - T, 0, 0, 1, 1, 1] as const),
  east: Object.freeze([0, 0, 0, T, 1, 1] as const),
};
/** Bedrock `minecraft:cardinal_direction` of a door -> Java `facing` (Bedrock doors are rotated by 90 degrees). */
const BEDROCK_TO_JAVA_FACING: Record<string, Side> = { south: 'east', east: 'north', north: 'west', west: 'south' };
const doorCache = new Map<string, readonly Box[]>();

/**
 * Collision box of a door half from its states (Java DoorBlock.getShape with the Bedrock direction
 * mapping; the closed default `south` gives the panel at x 0..0.1825, minecraft-data's only door
 * shape). Bedrock keeps the door state on the lower half (the upper half's open_bit stays 0, measured by Track O):
 * pass the lower half as `lower` for an upper half. Closed: the panel on the edge clockwise of
 * `cardinal_direction`; open, hinge 0: the edge opposite the direction; open, hinge 1: the direction's own edge.
 */
export function doorBoxes(states: Record<string, unknown>, lower?: Record<string, unknown>): readonly Box[] {
  const src = lower ?? states;
  const cd = src['minecraft:cardinal_direction'];
  const facing = BEDROCK_TO_JAVA_FACING[typeof cd === 'string' ? cd : 'south'] ?? 'east';
  const open = Number(src.open_bit ?? 0) === 1;
  const right = Number(src.door_hinge_bit ?? 0) === 1;
  const key = `${facing}|${open}|${right}`;
  let hit = doorCache.get(key);
  if (hit) return hit;
  let side: Side;
  if (!open) side = facing;
  else if (facing === 'east') side = right ? 'north' : 'south';
  else if (facing === 'south') side = right ? 'east' : 'west';
  else if (facing === 'west') side = right ? 'south' : 'north';
  else side = right ? 'west' : 'east';
  hit = Object.freeze([PANEL[side]]);
  doorCache.set(key, hit);
  return hit;
}

// ---- fences, panes and bars: arms towards their neighbours -------------------------------------

/** Blocks whose collision depends on the 4 neighbours (Bedrock keeps no connection state for them). */
export type ConnectKind = 'fence' | 'pane';

export function connectKindOf(name: string): ConnectKind | undefined {
  if (name.endsWith('_fence')) return 'fence';
  if (name.endsWith('glass_pane') || name.endsWith('_bars')) return 'pane';
  return undefined;
}

/** Neighbour bits for `connectedBoxes`: north (-z), south (+z), west (-x), east (+x). */
export const CONNECT_NORTH = 1;
export const CONNECT_SOUTH = 2;
export const CONNECT_WEST = 4;
export const CONNECT_EAST = 8;

const connectCache = new Map<number, readonly Box[]>();

/**
 * Post plus arms of a fence (0.375..0.625 wide, 1.5 high) or a pane / bars (0.4375..0.5625, 1 high)
 * towards the neighbours in `mask` (CONNECT_* bits). Walls need none of this: Bedrock walls carry
 * their connections in the block state and minecraft-data has a shape per state.
 */
export function connectedBoxes(kind: ConnectKind, mask: number): readonly Box[] {
  const key = (kind === 'fence' ? 0 : 16) + mask;
  const hit = connectCache.get(key);
  if (hit) return hit;
  const a = kind === 'fence' ? 0.375 : 0.4375;
  const b = 1 - a;
  const h = kind === 'fence' ? 1.5 : 1;
  const out: Box[] = [Object.freeze([a, 0, a, b, h, b] as const)];
  if (mask & CONNECT_NORTH) out.push(Object.freeze([a, 0, 0, b, h, a] as const));
  if (mask & CONNECT_SOUTH) out.push(Object.freeze([a, 0, b, b, h, 1] as const));
  if (mask & CONNECT_WEST) out.push(Object.freeze([0, 0, a, a, h, b] as const));
  if (mask & CONNECT_EAST) out.push(Object.freeze([b, 0, a, 1, h, b] as const));
  const boxes = Object.freeze(out);
  connectCache.set(key, boxes);
  return boxes;
}

/** Collision boxes of a world BlockInfo: real shapes for known states, a full cube for unknown blocks. */
export function boxesOf(info: BlockInfo): readonly Box[] {
  if (info.stateId < 0) return info.solid ? [FULL] : NONE;
  if (isStairsName(info.name)) {
    const corner = info.states[STAIRS_CORNER];
    if (typeof corner === 'string' && corner !== 'none') return stairBoxes(info.states);
  }
  return boxesOfState(info.stateId) ?? info.boxes;
}

const infoCache = new Map<string, BlockInfo>();

/**
 * A BlockInfo built from minecraft-data alone (no connection), for tests and generated worlds.
 * `states` are plain values (`{ 'minecraft:vertical_half': 'top' }`); missing ones take the default.
 */
export function blockInfoOf(name: string, states: Record<string, unknown> = {}): BlockInfo {
  const key = `${name}|${JSON.stringify(states)}`;
  const hit = infoCache.get(key);
  if (hit) return hit;
  const d = data();
  const block = d.blocksByName[name];
  if (!block) throw new Error(`unknown block ${name}`);
  const plain = (s: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(d.blockStates[s]?.states ?? {})) out[k] = v.value;
    return out;
  };
  let stateId = block.defaultState;
  if (Object.keys(states).length) {
    const want = { ...plain(block.defaultState), ...states };
    let found: number | undefined;
    for (let s = block.minStateId; s <= block.maxStateId && found === undefined; s++) {
      const have = plain(s);
      if (Object.entries(want).every(([k, v]) => have[k] === v)) found = s;
    }
    if (found === undefined) throw new Error(`no state of ${name} matches ${JSON.stringify(states)}`);
    stateId = found;
  }
  const boxes = boxesOfState(stateId) ?? NONE;
  const info: BlockInfo = Object.freeze({
    name,
    stateId,
    states: Object.freeze(plain(stateId)),
    hardness: -1,
    solid: boxes.length > 0,
    boxes,
  });
  infoCache.set(key, info);
  return info;
}

// ---- stairs: corner shapes and the 1.26.60 `minecraft:corner` state --------------------------------

/** Bedrock 1.26.60 stairs state (none, inner_left, inner_right, outer_left, outer_right); the 1.26.30 data has no such state. */
export const STAIRS_CORNER = 'minecraft:corner';
export const STAIRS_CORNERS = ['none', 'inner_left', 'inner_right', 'outer_left', 'outer_right'] as const;

export function isStairsName(name: string): boolean {
  return name.endsWith('_stairs');
}

/**
 * The direction (dx, dz) a body walks to climb a stairs block (towards its high half), by
 * `weirdo_direction` 0..3: high half east, west, south, north (measured on BDS 1.26.60.6; the same as
 * minecraft-data's shapes).
 */
export const STAIRS_UP: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Java StairBlock's top quarters (bits: 1 north-west, 2 north-east, 4 south-west, 8 south-east) by
 * shape * 4 + Java facing (south 0, west 1, north 2, east 3); shapes in STAIRS_CORNERS order.
 */
const QUARTERS_BY_SHAPE = [12, 5, 3, 10, 14, 13, 7, 11, 13, 7, 11, 14, 8, 4, 1, 2, 4, 1, 2, 8];
/** weirdo_direction -> Java facing value. */
const JAVA_FACING = [3, 1, 0, 2];
const stairCache = new Map<string, readonly Box[]>();

/**
 * Collision boxes of a stairs state with its `minecraft:corner` shape: a half-height slab (the upper
 * half when `upside_down_bit`) plus the step's quarters (Java's StairBlock shapes; Bedrock names the
 * corners like Java: outer when the block behind the high half is a stairs block facing sideways,
 * inner when the block in front of the low half is, left = counter-clockwise; measured on BDS
 * 1.26.60.6). Straight stairs give minecraft-data's two boxes.
 */
export function stairBoxes(states: Readonly<Record<string, unknown>>): readonly Box[] {
  const dir = Number(states.weirdo_direction ?? 0) & 3;
  const down = states.upside_down_bit === true || Number(states.upside_down_bit ?? 0) === 1;
  const cornerName = states[STAIRS_CORNER];
  const shape = Math.max(0, STAIRS_CORNERS.indexOf((typeof cornerName === 'string' ? cornerName : 'none') as (typeof STAIRS_CORNERS)[number]));
  const key = `${dir}|${down}|${shape}`;
  const hit = stairCache.get(key);
  if (hit) return hit;
  const bits = QUARTERS_BY_SHAPE[shape * 4 + JAVA_FACING[dir]!]!;
  const [s0, s1] = down ? [0.5, 1] : [0, 0.5];
  const [q0, q1] = down ? [0, 0.5] : [0.5, 1];
  const out: Box[] = [Object.freeze([0, s0, 0, 1, s1, 1] as const)];
  const part = (x0: number, z0: number, x1: number, z1: number): Box => Object.freeze([x0, q0, z0, x1, q1, z1] as const);
  // pairs of quarters as halves (the straight shapes), the rest as quarters
  let rest = bits;
  for (const [mask, box] of [
    [3, part(0, 0, 1, 0.5)],
    [12, part(0, 0.5, 1, 1)],
    [5, part(0, 0, 0.5, 1)],
    [10, part(0.5, 0, 1, 1)],
    [1, part(0, 0, 0.5, 0.5)],
    [2, part(0.5, 0, 1, 0.5)],
    [4, part(0, 0.5, 0.5, 1)],
    [8, part(0.5, 0.5, 1, 1)],
  ] as const) {
    if ((rest & mask) === mask) {
      out.push(box);
      rest &= ~mask;
    }
  }
  const boxes = Object.freeze(out);
  stairCache.set(key, boxes);
  return boxes;
}

// ---- block states newer than the block data ----------------------------------------------------

let newerStates: Map<number, BlockInfo> | undefined;

/**
 * Hashed runtime ids of states the 1.26.30 block data does not have, for blocks whose shape the
 * terrain layer knows: every stairs block with the 1.26.60 `minecraft:corner` state. BDS 1.26.60
 * sends stairs as {minecraft:corner, upside_down_bit, weirdo_direction} (verified: the hash of
 * oak_stairs {corner none, upside_down_bit 0, weirdo_direction 0} is the runtime id the server sends,
 * -122484237); the world registry, built from the 1.26.30 states, reports them as `unknown`. Built
 * once, on the first unknown block.
 */
function newerStateTable(): Map<number, BlockInfo> {
  if (newerStates) return newerStates;
  const table = new Map<number, BlockInfo>();
  const d = data();
  for (const block of Object.values(d.blocksByName)) {
    if (!block || !isStairsName(block.name)) continue;
    for (let s = block.minStateId; s <= block.maxStateId; s++) {
      const typed = d.blockStates[s]?.states;
      if (!typed || STAIRS_CORNER in typed) continue;
      const plain: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(typed)) plain[k] = v.value;
      for (const corner of STAIRS_CORNERS) {
        const rid = blockHash(block.name, { ...typed, [STAIRS_CORNER]: { type: 'string', value: corner } });
        const states = Object.freeze({ ...plain, [STAIRS_CORNER]: corner });
        table.set(rid, Object.freeze({ name: block.name, stateId: s, states, hardness: block.hardness ?? -1, solid: true, boxes: stairBoxes(states) }));
      }
    }
  }
  newerStates = table;
  return table;
}

/**
 * The block behind an `unknown` BlockInfo (a runtime id the world registry could not resolve) when
 * the terrain layer knows the newer state (stairs with `minecraft:corner`), else undefined. The
 * result carries the 1.26.30 state id without the new state (names, break times) and the shape of
 * the full state.
 */
export function resolveNewerState(info: BlockInfo): BlockInfo | undefined {
  if (info.stateId >= 0) return undefined;
  const rid = info.states.runtime_id;
  if (typeof rid !== 'number') return undefined;
  return newerStateTable().get(rid | 0);
}
