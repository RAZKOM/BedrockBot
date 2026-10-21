// Per-state collision shapes from minecraft-data's bedrock `blockCollisionShapes` (the same 1.26.30
// block data the world registry uses; PLAN.md fact 3a). prismarine-registry does not attach these
// to bedrock blocks, so the world model's `BlockInfo.boxes` is a full cube for every block whose
// boundingBox is "block" (slabs, stairs, fences, carpets ...). Movement and pathfinding read the real
// shapes from here instead. See docs/pathfinding.md.
import { createRequire } from 'node:module';
import type { BlockInfo, Box } from '../../world/types.ts';

const require = createRequire(import.meta.url);

interface MdBlock {
  name: string;
  minStateId: number;
  maxStateId: number;
  defaultState: number;
  boundingBox: string;
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
  if (entry === undefined || !shapes) {
    boxes = block.boundingBox === 'block' ? Object.freeze([FULL]) : NONE;
  } else {
    const id = typeof entry === 'number' ? entry : (entry[stateId - block.minStateId] ?? entry[0]);
    const raw = id === undefined ? undefined : shapes.shapes[String(id)];
    boxes = raw ? Object.freeze(raw.map((b): Box => Object.freeze([b[0]!, b[1]!, b[2]!, b[3]!, b[4]!, b[5]!] as const))) : NONE;
  }
  byStateId[stateId] = boxes;
  return boxes;
}

/** Collision boxes of a world BlockInfo: real shapes for known states, a full cube for unknown blocks. */
export function boxesOf(info: BlockInfo): readonly Box[] {
  if (info.stateId < 0) return info.solid ? [FULL] : NONE;
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
