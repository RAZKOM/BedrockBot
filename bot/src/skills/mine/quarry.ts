// `!quarry` and `!tunnel` (wave 11, Track BK; docs/mining.md "Quarry and tunnel", docs/decisions/0053):
// dig out a whole box for its stone. Built on the builder's clear (skills/build: planner + runner), the
// navigator's break rules and the miner's way back up; this file only cuts the box into slices, decides
// which cells are never dug, and runs one slice after the other.
//
//   slices     quarry: horizontal layers, top first; tunnel: cross-sections, nearest first. Each slice is
//              a `!build clear` of that box (build/plan.ts planBuildAsync: stands, nearest first; then
//              build/runner.ts BuildRunner: walk to a stand, dig, collect every 16 digs), planned on the
//              live world when the slice starts, and planned again after every pause (eat, fight,
//              the stash step), so a slice picks up where it was
//   refusals   every cell passes the navigator's break rules (nav/actions.ts breakBlocker) without the
//              protected area (the owner gave the box) but with the floor under the feet: built blocks,
//              containers, beds, spawners, ice, infested blocks, liquids and every cell next to one, a
//              gravity block right above or unsupported beside. On top of them: a built block by name
//              (a torch or rail has no collision box: the rules call it air), the support of what hangs
//              on the cell (a built block or a hard non-cube block on top: a wall, a door, a torch, a
//              chest; a built non-cube block on a side: a wall torch, a ladder, a sign), and a cell with
//              a player on it. A refused cell is shown to the planner as unbreakable, so it stays and
//              the planner stands around it. The rules are asked again right before each dig
//   liquids    a cell refused for a liquid (in it or next to it) stops its column: nothing under it is
//              dug in the later layers, so water and lava stay walled in (no sealing with blocks)
//   stairs     a quarry deeper than 1 keeps a staircase in its wall: one tread per layer along the
//              box's perimeter (a spiral when the depth is longer than the perimeter), starting at the
//              perimeter column nearest the bot; every tread one block lower than the last. The bot
//              walks out on it (unload trips, the end) without placing or digging, from the stair head
//              (the feet cell outside the box beside the first tread, where the job starts). A 1-wide
//              box deeper than its length + 1 (and a 1x1 box deeper than 1) is refused: no room for the
//              stairs. Before each layer the treads above it are read again (solid, the 3 cells over
//              each open or still diggable): a cave, a liquid or a refused cell there ends the job
//              (`no way out below y N`) before it goes deeper. The treads are the navigator's kept cells
//              while the job lives (Navigator.keptCells: no other walk digs them)
//   end        quarry: back up to the stair head before every end but a stop (done, no way out, no
//              pickaxe, inventory full, a failed slice), and before the stash step walks off: the treads
//              one by one (walkStairs: a cell left over a tread is dug first, no other walk digs inside
//              the base), else tunnel.ts climbTo (walk, pillar, a staircase dug inside the box under the
//              job's own refusals). Tunnel: the bot stays at the tunnel's end
//   tunnel     after each cross-section: the centre column (feet and head) must be open, else the tunnel
//              ends there with the reason; floor holes of the cross-section are filled with throwaway
//              blocks; a torch every TORCH_EVERY (8) blocks when torches are carried, on the floor of
//              the cross-section's left column (by the left wall of a tunnel 3 wide or more; in a
//              narrower one the first cell of the cross-section or the two behind it clear of the bot's
//              body). Not gated by `allowPlace` (that is the walker's pillar setting; branch mining's
//              torches still follow it): the owner asked for this tunnel and its torches
import { silentLogger, type Logger } from '../../log.ts';
import type { ItemStack, Vec3 } from '../../world/types.ts';
import { planBuildAsync, type Plan } from '../build/plan.ts';
import { BuildRunner, type RunnerDeps } from '../build/runner.ts';
import { isLiquid, type BlockLike, type BlockReader } from '../build/sim.ts';
import { fmtCell, isAirName, key, type BuildSpec } from '../build/types.ts';
import type { DigResult } from '../dig/digger.ts';
import type { NavGoal } from '../nav/goals.ts';
import type { PlaceOptions, PlaceResult } from '../place/place.ts';
import { THROWAWAY_BLOCKS } from '../survival/keeper.ts';
import { isBuiltBlock } from '../terrain/classify.ts';
import type { GotoOptions, SkillResult } from '../types.ts';
import { carriesPickaxe, carriesTorch, dirFromYaw, placeTorch, TORCH_EVERY, turnRight, type Dir } from './branch.ts';
import { climbTo, type TunnelWorld } from './tunnel.ts';

export interface Box {
  min: Vec3;
  max: Vec3;
}

/** The longest side of a quarry box (64 x 64 x 64 at most). */
export const QUARRY_MAX_SIDE = 64;
export const TUNNEL_MAX_LEN = 256;
export const TUNNEL_MAX_SIDE = 9;
export const TUNNEL_DEFAULT_SIZE = { w: 3, h: 3 } as const;
/** Farther from the slice than this (blocks): walk back to the job's entry before planning it. */
export const QUARRY_APPROACH = 24;
/** A quarry's first layer starts within this many blocks of the stair head (else the bot walks there first). */
export const QUARRY_NEAR_EXIT = 6;
/** A quarry box farther than this from the bot (blocks) is refused. */
export const QUARRY_MAX_AWAY = 64;

const colKey = (x: number, z: number) => `${x},${z}`;
const SIDES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

export function boxOf(a: Vec3, b: Vec3): Box {
  return { min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) }, max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) } };
}

/** Width (x), height (y), depth (z) of a box. */
export function boxSize(b: Box): { x: number; y: number; z: number } {
  return { x: b.max.x - b.min.x + 1, y: b.max.y - b.min.y + 1, z: b.max.z - b.min.z + 1 };
}

export function boxCells(b: Box): number {
  const s = boxSize(b);
  return s.x * s.y * s.z;
}

/** `8x4x8` (x, y, z). */
export function sizeLabel(b: Box): string {
  const s = boxSize(b);
  return `${s.x}x${s.y}x${s.z}`;
}

export function inBox(b: Box, p: Vec3): boolean {
  return p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z;
}

/** `north`, `n`, ... -> a direction; undefined for anything else. */
export function parseDir(s: string | undefined): Dir | undefined {
  switch ((s ?? '').toLowerCase()) {
    case 'north':
    case 'n':
      return [0, -1];
    case 'south':
    case 's':
      return [0, 1];
    case 'east':
    case 'e':
      return [1, 0];
    case 'west':
    case 'w':
      return [-1, 0];
    default:
      return undefined;
  }
}

export function dirName(d: Dir): string {
  return d[0] === 1 ? 'east' : d[0] === -1 ? 'west' : d[1] === 1 ? 'south' : 'north';
}

/** Lateral offsets of a cross-section `w` wide around the centre column (an even width has the extra column on the right). */
function lateral(w: number): number[] {
  const lo = -Math.floor((w - 1) / 2);
  return Array.from({ length: w }, (_, i) => lo + i);
}

/**
 * `!quarry here <w> <d> <depth>`: the box in front of the feet cell going `dir` (the cardinal direction
 * the bot faces): `d` columns forward starting one block ahead, `w` wide around the bot's column (the
 * extra column of an even width on the right), from the block under the feet down `depth` layers.
 */
export function hereBox(feet: Vec3, dir: Dir, w: number, d: number, depth: number): Box {
  const r = turnRight(dir);
  const lat = lateral(w);
  const a = { x: feet.x + dir[0] + r[0] * lat[0]!, y: feet.y - 1, z: feet.z + dir[1] + r[1] * lat[0]! };
  const b = { x: feet.x + dir[0] * d + r[0] * lat[lat.length - 1]!, y: feet.y - depth, z: feet.z + dir[1] * d + r[1] * lat[lat.length - 1]! };
  return boxOf(a, b);
}

/** Why a quarry box is refused (too big, below the world, no room for the stairs), undefined when it is fine. */
export function checkQuarryBox(b: Box, minY = -64): string | undefined {
  const s = boxSize(b);
  if (s.x > QUARRY_MAX_SIDE || s.y > QUARRY_MAX_SIDE || s.z > QUARRY_MAX_SIDE) return `${sizeLabel(b)} is too big (at most ${QUARRY_MAX_SIDE} on every side)`;
  if (b.max.y < minY) return 'the box is below the world';
  const len = Math.max(s.x, s.z);
  if (Math.min(s.x, s.z) === 1 && s.y > 1) {
    // a 1-wide box has its staircase in a straight line, one tread per block of length
    if (len === 1) return `${sizeLabel(b)}: a 1x1 box can be 1 deep at most (no room for stairs out)`;
    if (s.y > len + 1) return `${sizeLabel(b)}: a 1-wide box can be its length + 1 (${len + 1}) deep at most (no room for stairs out)`;
  }
  return undefined;
}

/** Why a quarry box cannot be started from the feet cell `feet` (too far, not loaded), undefined when it can. */
export function checkQuarrySite(b: Box, feet: Vec3, blockAt: (p: Vec3) => unknown, minY = -64): string | undefined {
  const d = Math.hypot(Math.max(b.min.x - feet.x, 0, feet.x - b.max.x), Math.max(b.min.y - feet.y, 0, feet.y - b.max.y), Math.max(b.min.z - feet.z, 0, feet.z - b.max.z));
  if (d > QUARRY_MAX_AWAY) return `the box is ${Math.round(d)} blocks away (at most ${QUARRY_MAX_AWAY})`;
  for (const x of [b.min.x, b.max.x])
    for (const y of [Math.max(minY, b.min.y), b.max.y])
      for (const z of [b.min.z, b.max.z]) if (blockAt({ x, y, z }) === undefined) return `the box is not loaded (${fmtCell({ x, y, z })})`;
  return undefined;
}

/** A body with its feet at `feet` (0.6 wide, 1.8 high) reaches into cell c. */
export function overlapsBody(feet: Vec3, c: Vec3): boolean {
  return feet.x + 0.3 > c.x && feet.x - 0.3 < c.x + 1 && feet.z + 0.3 > c.z && feet.z - 0.3 < c.z + 1 && feet.y + 1.8 > c.y && feet.y < c.y + 1;
}

/** The first player (feet) standing in the box or on it (feet up to 2 blocks over its top), undefined when none. */
export function playerOver(b: Box, players: readonly Vec3[]): Vec3 | undefined {
  return players.find((p) => p.x + 0.3 > b.min.x && p.x - 0.3 < b.max.x + 1 && p.z + 0.3 > b.min.z && p.z - 0.3 < b.max.z + 1 && p.y + 1.8 > b.min.y && p.y < b.max.y + 3);
}

/** The cross-section `k` (0 = the one right in front) of a tunnel from feet cell `feet` going `dir`. */
export function tunnelSlice(feet: Vec3, dir: Dir, k: number, w: number, h: number): Box {
  const r = turnRight(dir);
  const lat = lateral(w);
  const c = { x: feet.x + dir[0] * (k + 1), z: feet.z + dir[1] * (k + 1) };
  return boxOf({ x: c.x + r[0] * lat[0]!, y: feet.y, z: c.z + r[1] * lat[0]! }, { x: c.x + r[0] * lat[lat.length - 1]!, y: feet.y + h - 1, z: c.z + r[1] * lat[lat.length - 1]! });
}

/** Horizontal layers of a box, top first. */
export function quarrySlices(b: Box): Box[] {
  const out: Box[] = [];
  for (let y = b.max.y; y >= b.min.y; y--) out.push({ min: { ...b.min, y }, max: { ...b.max, y } });
  return out;
}

/**
 * The perimeter columns of a box in walking order (consecutive cells side by side), starting at the
 * one nearest `near`. `cycle`: the last is next to the first (both sides at least 2); a 1-wide box gives
 * its line from the end nearest `near`, no cycle.
 */
export function ringOf(b: Box, near: Vec3): { cells: { x: number; z: number }[]; cycle: boolean } {
  const s = boxSize(b);
  const d = (c: { x: number; z: number }) => Math.hypot(c.x + 0.5 - near.x, c.z + 0.5 - near.z);
  if (s.x < 2 || s.z < 2) {
    const line: { x: number; z: number }[] = [];
    for (let x = b.min.x; x <= b.max.x; x++) for (let z = b.min.z; z <= b.max.z; z++) line.push({ x, z });
    if (d(line[line.length - 1]!) < d(line[0]!)) line.reverse();
    return { cells: line, cycle: false };
  }
  const ring: { x: number; z: number }[] = [];
  for (let x = b.min.x; x <= b.max.x; x++) ring.push({ x, z: b.min.z });
  for (let z = b.min.z + 1; z <= b.max.z; z++) ring.push({ x: b.max.x, z });
  for (let x = b.max.x - 1; x >= b.min.x; x--) ring.push({ x, z: b.max.z });
  for (let z = b.max.z - 1; z > b.min.z; z--) ring.push({ x: b.min.x, z });
  let best = 0;
  for (let i = 1; i < ring.length; i++) if (d(ring[i]!) < d(ring[best]!) - 1e-9) best = i;
  return { cells: [...ring.slice(best), ...ring.slice(0, best)], cycle: true };
}

/**
 * The staircase a quarry keeps (never dug): tread p (0 = first) at perimeter column p (round the ring
 * again when the box is deeper than its perimeter), one block under the last tread: its top is where the
 * feet stand, one lower per step, the first one block under the box's top layer, the last one standing
 * on the bottom layer's floor (depth - 1 treads). A spiral comes round to a column every perimeter
 * (at least 4) blocks: the 3 cells over each tread stay open for the body.
 */
export function staircase(b: Box, near: Vec3): Vec3[] {
  const depth = b.max.y - b.min.y + 1;
  const { cells, cycle } = ringOf(b, near);
  const out: Vec3[] = [];
  for (let p = 0; p < depth - 1; p++) {
    if (!cycle && p >= cells.length) break;
    const c = cells[p % cells.length]!;
    out.push({ x: c.x, y: b.max.y - 1 - p, z: c.z });
  }
  return out;
}

/**
 * The stair head of a quarry: the feet cell outside the box beside the first tread's column, on the
 * ground at the box's top (y max + 1): an open one (`open`: feet and head clear) first, then the side
 * nearest `near`. The bot steps from it down onto the first tread, and climbs back to it at the end.
 */
export function stairHead(b: Box, near: Vec3, open?: (p: Vec3) => boolean): Vec3 {
  const c = ringOf(b, near).cells[0]!;
  const out: Vec3[] = [];
  for (const [dx, dz] of SIDES) {
    const x = c.x + dx;
    const z = c.z + dz;
    if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) out.push({ x, y: b.max.y + 1, z });
  }
  const d = (p: Vec3) => Math.hypot(p.x + 0.5 - near.x, p.z + 0.5 - near.z) + (open && !open(p) ? 1000 : 0);
  out.sort((p, q) => d(p) - d(q));
  return out[0]!;
}

export type QuarryKind = 'quarry' | 'tunnel';

/** What a `!quarry` / `!tunnel` digs. */
export interface QuarrySpec {
  kind: QuarryKind;
  /** `quarry 8x4x8`, `tunnel east 20 (3x3)`. */
  label: string;
  box: Box;
  slices: Box[];
  /** Cells kept for the staircase. */
  keep: Vec3[];
  /** Feet cell where the job started. */
  start: Vec3;
  /** Quarry: the stair head (stairHead), where the job starts digging and climbs back to. */
  exit?: Vec3;
  /** `!quarry here`: the direction the box goes (said in the start reply). */
  dir?: Dir;
  /** Tunnel: the direction, the size and the feet height of the lane. */
  tunnel?: { dir: Dir; w: number; h: number; len: number };
}

export type ParseResult = { spec: QuarrySpec } | { error: string };

export const QUARRY_USAGE = `usage: !quarry here <w> <d> <depth> [north|south|east|west] | <x1> <y1> <z1> <x2> <y2> <z2> | stop | status (at most ${QUARRY_MAX_SIDE} on every side)`;
export const TUNNEL_USAGE = `usage: !tunnel <here|north|south|east|west> <length 1..${TUNNEL_MAX_LEN}> [<w>x<h>, default ${TUNNEL_DEFAULT_SIZE.w}x${TUNNEL_DEFAULT_SIZE.h}] | stop | status`;

const int = (s: string | undefined): number | undefined => {
  if (s === undefined || !/^-?\d+$/.test(s)) return undefined;
  return Number(s);
};

/** A quarry spec over a box, with the staircase from the corner nearest `feet` (`open`: stairHead's). */
export function quarrySpec(box: Box, feet: Vec3, open?: (p: Vec3) => boolean): QuarrySpec {
  const near = { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 };
  return { kind: 'quarry', label: `quarry ${sizeLabel(box)}`, box, slices: quarrySlices(box), keep: staircase(box, near), start: { ...feet }, exit: stairHead(box, near, open) };
}

/** `!quarry` arguments (without stop / status). `yaw`: the bot's (the direction of `here` without one); `open`: stairHead's. */
export function parseQuarryArgs(args: readonly string[], feet: Vec3, yaw: number | undefined, open?: (p: Vec3) => boolean): ParseResult {
  let box: Box;
  let facing: Dir | undefined;
  if ((args[0] ?? '').toLowerCase() === 'here') {
    if (args.length < 4 || args.length > 5) return { error: QUARRY_USAGE };
    const [w, d, depth] = [int(args[1]), int(args[2]), int(args[3])];
    if (w === undefined || d === undefined || depth === undefined || w < 1 || d < 1 || depth < 1) return { error: QUARRY_USAGE };
    const dir = args[4] !== undefined ? parseDir(args[4]) : dirFromYaw(yaw);
    if (!dir) return { error: `quarry: "${args[4]}" is no direction (north, south, east, west)` };
    box = hereBox(feet, dir, w, d, depth);
    facing = dir;
  } else {
    if (args.length !== 6) return { error: QUARRY_USAGE };
    const n = args.map(int);
    if (n.some((v) => v === undefined)) return { error: QUARRY_USAGE };
    box = boxOf({ x: n[0]!, y: n[1]!, z: n[2]! }, { x: n[3]!, y: n[4]!, z: n[5]! });
  }
  const why = checkQuarryBox(box);
  if (why) return { error: `quarry: ${why}` };
  const spec = quarrySpec(box, feet, open);
  return { spec: facing ? { ...spec, dir: facing } : spec };
}

/** `!tunnel` arguments (without stop / status). */
export function parseTunnelArgs(args: readonly string[], feet: Vec3, yaw: number | undefined): ParseResult {
  if (args.length < 2 || args.length > 3) return { error: TUNNEL_USAGE };
  const a = args[0]!.toLowerCase();
  const dir = a === 'here' ? dirFromYaw(yaw) : parseDir(a);
  if (!dir) return { error: TUNNEL_USAGE };
  const len = int(args[1]);
  if (len === undefined || len < 1 || len > TUNNEL_MAX_LEN) return { error: TUNNEL_USAGE };
  let w: number = TUNNEL_DEFAULT_SIZE.w;
  let h: number = TUNNEL_DEFAULT_SIZE.h;
  if (args[2] !== undefined) {
    const m = /^(\d+)x(\d+)$/i.exec(args[2]);
    if (!m) return { error: TUNNEL_USAGE };
    w = Number(m[1]);
    h = Number(m[2]);
    if (w < 1 || w > TUNNEL_MAX_SIDE || h < 2 || h > TUNNEL_MAX_SIDE) return { error: `tunnel: ${w}x${h}: width 1..${TUNNEL_MAX_SIDE}, height 2..${TUNNEL_MAX_SIDE}` };
  }
  return { spec: tunnelSpec(feet, dir, len, w, h) };
}

export function tunnelSpec(feet: Vec3, dir: Dir, len: number, w: number, h: number): QuarrySpec {
  const slices = Array.from({ length: len }, (_, k) => tunnelSlice(feet, dir, k, w, h));
  const first = slices[0]!;
  const last = slices[slices.length - 1]!;
  const box = { min: boxOf(first.min, last.min).min, max: boxOf(first.max, last.max).max };
  return { kind: 'tunnel', label: `tunnel ${dirName(dir)} ${len} (${w}x${h})`, box, slices, keep: [], start: { ...feet }, tunnel: { dir, w, h, len } };
}

// ---- running a job --------------------------------------------------------------------------------

/** What a quarry job needs from the bot (chat/commands-quarry.ts wires it; the unit tests fake it). */
export interface QuarryHost {
  blockAt(p: Vec3): BlockLike | undefined;
  /** The navigator's break rules without the protected area, with the floor under the feet (nav/actions.ts breakBlocker): undefined = may, `air` = open, else the reason. */
  breakRule(p: Vec3): string | undefined;
  /** Feet of the other players in range (a cell under one is never dug). */
  players?(): readonly Vec3[];
  /** Hold (on) or release the stair treads as cells no walk digs (Navigator.keptCells). */
  keepCells?(cells: readonly Vec3[], on: boolean): void;
  position(): Vec3 | undefined;
  onGround(): boolean;
  goto(goal: NavGoal, opts?: GotoOptions): Promise<SkillResult>;
  place(p: Vec3, opts: PlaceOptions): Promise<PlaceResult>;
  dig(p: Vec3): Promise<DigResult>;
  /** `take`: only items it accepts (undefined = all). */
  collect(radius: number, timeoutTicks: number, take?: (name: string) => boolean): Promise<SkillResult>;
  waitTicks(n: number): Promise<void>;
  inventory: { count(name: string): number };
  slots(): readonly (ItemStack | null)[];
  /** The keeper's throwaway reserve (`throwawayMin`). */
  throwawayMin(): number;
  /** Cancel the running skill (pause / stop). */
  cancel(): void;
  /** The climb back up at the end of a quarry (the miner's rules, with the protected area). */
  tunnelWorld?: TunnelWorld;
  throwaways?(): number;
  log?: Logger;
  now?(): number;
}

export type QuarryState = 'idle' | 'run' | 'climb' | 'paused' | 'done' | 'blocked' | 'stopped' | 'failed';

export interface QuarryStats {
  startedAt: number | undefined;
  /** Blocks dug, by block name. */
  dug: number;
  dugBy: Record<string, number>;
  /** Cells left in the box, with the reason (the first reason per cell). */
  skipped: Map<string, string>;
  /** Stair treads kept. */
  kept: number;
  slicesDone: number;
  torches: number;
  floors: number;
  plans: number;
  planMs: number;
  /** The end climb (quarry). */
  climb?: { ok: boolean; why?: string; dug: number; placed: number };
}

/** Solid blocks (a box) in the slices from `from` on, for the ETA; yields to the event loop every `chunk` cells (a 64 x 64 x 64 box is 262 144). */
export async function solidCells(h: Pick<QuarryHost, 'blockAt'>, slices: readonly Box[], from = 0, chunk = 4096): Promise<number> {
  let n = 0;
  let seen = 0;
  for (let i = from; i < slices.length; i++) {
    const b = slices[i]!;
    for (let y = b.min.y; y <= b.max.y; y++)
      for (let x = b.min.x; x <= b.max.x; x++)
        for (let z = b.min.z; z <= b.max.z; z++) {
          if (++seen % chunk === 0) await new Promise<void>((r) => setImmediate(r));
          const c = h.blockAt({ x, y, z });
          if (c && c.boxes.length > 0 && !isLiquid(c)) n++;
        }
  }
  return n;
}

/** A single full cube (a stone, a plank), not a slab, a fence, a torch or a chest. */
function fullCube(b: BlockLike): boolean {
  const x = b.boxes[0];
  return b.boxes.length === 1 && x?.[0] === 0 && x[1] === 0 && x[2] === 0 && x[3] === 1 && x[4] === 1 && x[5] === 1;
}

/** Natural non-cube blocks that may sit on a dug cell (they drop): hardness up to this (plants 0, snow layers 0.1, glow lichen and sculk veins 0.2). */
const LOOSE_HARDNESS = 0.2;
/** Natural non-cube blocks harder than that, dug over like a cube (they fall or drop). */
const LOOSE_NAMES: ReadonlySet<string> = new Set(['mud', 'soul_sand', 'dirt_path', 'grass_path', 'farmland']);

const UNBREAKABLE: Pick<BlockLike, 'hardness'> = { hardness: -1 };

/** One `!quarry` / `!tunnel` run. */
export class QuarryJob {
  readonly spec: QuarrySpec;
  readonly stats: QuarryStats = { startedAt: undefined, dug: 0, dugBy: {}, skipped: new Map(), kept: 0, slicesDone: 0, torches: 0, floors: 0, plans: 0, planMs: 0 };
  state: QuarryState = 'idle';
  /** Why it ended (blocked, failed). */
  lastError: string | undefined;
  /** The slice being dug. */
  index = 0;
  /** Solid cells at the start (the ETA; the box's cells until they are counted). */
  total = 0;
  /** The runner's collects take only these items (QuarryProcess: no stone with quarryKeepStone off); undefined = all. */
  take: ((name: string) => boolean) | undefined;
  private readonly h: QuarryHost;
  private readonly log: Logger;
  private readonly keep: Set<string>;
  /** Columns (x,z) stopped at a y by a liquid: nothing below it is dug. */
  private readonly stopped = new Map<string, number>();
  private epoch = 0;
  private runner: BuildRunner | undefined;
  private resolve: ((s: QuarryState) => void) | undefined;
  private activeSince: number | undefined;
  private activeMs = 0;
  private counted = false;
  private holding = false;
  /** abort(): the reason the job ends with once it is out of the pit. */
  private aborting: string | undefined;
  /** The tunnel's own torches (on the floor, not on a wall: the cells beside them may be dug). */
  private readonly ownTorches = new Set<string>();

  constructor(spec: QuarrySpec, host: QuarryHost) {
    this.spec = spec;
    this.h = host;
    this.log = host.log ?? silentLogger;
    this.keep = new Set(spec.keep.map(key));
  }

  private now(): number {
    return this.h.now?.() ?? Date.now();
  }

  get running(): boolean {
    return this.state === 'run' || this.state === 'climb' || this.state === 'paused';
  }

  start(): Promise<QuarryState> {
    this.stats.startedAt = this.now();
    this.stats.kept = this.spec.keep.length;
    this.total = boxCells(this.spec.box) - this.spec.keep.length; // counted at the first slice (loop)
    if (this.spec.keep.length && this.h.keepCells) {
      this.h.keepCells(this.spec.keep, true);
      this.holding = true;
    }
    const p = new Promise<QuarryState>((r) => {
      this.resolve = r;
    });
    void this.loop();
    return p;
  }

  pause(): void {
    if (this.state !== 'run' && this.state !== 'climb') return;
    this.epoch++;
    this.state = 'paused';
    this.tickClock();
    this.runner?.pause();
    this.h.cancel();
  }

  resume(): void {
    if (this.state !== 'paused') return;
    void this.loop();
  }

  stop(): void {
    if (!this.running && this.state !== 'idle') return;
    this.epoch++;
    this.runner?.pause();
    this.h.cancel();
    this.end('stopped');
  }

  private end(s: QuarryState, why?: string): void {
    this.tickClock();
    if (this.holding) {
      this.holding = false;
      this.h.keepCells?.(this.spec.keep, false);
    }
    this.state = s;
    if (why) this.lastError = why;
    this.log.info(`${this.spec.label}: ${s}${why ? ` (${why})` : ''}; ${this.summary()}`);
    const r = this.resolve;
    this.resolve = undefined;
    r?.(s);
  }

  private tickClock(): void {
    if (this.activeSince !== undefined) this.activeMs += this.now() - this.activeSince;
    this.activeSince = undefined;
  }

  /** Seconds left at the rate so far, undefined before the first block. */
  etaS(): number | undefined {
    const ms = this.activeMs + (this.activeSince !== undefined ? this.now() - this.activeSince : 0);
    if (this.stats.dug === 0 || ms <= 0) return undefined;
    return (Math.max(0, this.total - this.stats.dug - this.stats.skipped.size) * ms) / this.stats.dug / 1000;
  }

  /** `layer 2/4, 120 dug, 3 skipped` / `block 7/20, 63 dug, 0 skipped` */
  progress(): string {
    const n = this.spec.slices.length;
    const what = this.spec.kind === 'quarry' ? 'layer' : 'block';
    const at = this.state === 'climb' || this.state === 'done' ? `${n}/${n}` : `${Math.min(n, this.index + 1)}/${n}`;
    return `${what} ${at}, ${this.stats.dug} dug, ${this.stats.skipped.size} skipped`;
  }

  /** `quarry 8x4x8: layer 2/4, 120 dug, 3 skipped (most: next_to_liquid)` */
  summary(): string {
    const reasons = new Map<string, number>();
    for (const r of this.stats.skipped.values()) reasons.set(r, (reasons.get(r) ?? 0) + 1);
    const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, c]) => `${c} ${r}`);
    return `${this.spec.label}: ${this.progress()}${top.length ? ` (${top.join(', ')})` : ''}`;
  }

  /** Fewer throwaway blocks than the keeper's reserve (`throwawayMin`) in the inventory. */
  throwawayShort(): boolean {
    return (this.h.throwaways?.() ?? THROWAWAY_BLOCKS.reduce((a, n) => a + this.h.inventory.count(n), 0)) < this.h.throwawayMin();
  }

  /** Items the job's blocks drop so far (the stash step's produce). */
  dugNames(): string[] {
    return Object.keys(this.stats.dugBy);
  }

  private skip(p: Vec3, why: string): void {
    const k = key(p);
    if (!this.stats.skipped.has(k)) this.stats.skipped.set(k, why);
  }

  /**
   * Why the job leaves cell p (stairs, a stopped column, a built block, the break rules, what hangs on
   * it, a player on it); undefined when it may dig it, `air` when there is nothing to dig.
   */
  refusal(p: Vec3): string | undefined {
    if (this.keep.has(key(p))) return 'stairs';
    const stop = this.stopped.get(colKey(p.x, p.z));
    if (stop !== undefined && p.y < stop) return 'stopped column (liquid)';
    const here = this.h.blockAt(p);
    if (here && isBuiltBlock(here.name)) return 'protected'; // a torch, a rail, a carpet: the break rules call it air
    const rule = this.h.breakRule(p);
    if (rule === 'liquid' || rule === 'next_to_liquid') {
      const was = this.stopped.get(colKey(p.x, p.z));
      if (was === undefined || p.y > was) this.stopped.set(colKey(p.x, p.z), p.y);
    }
    if (rule !== undefined) return rule;
    return this.hangs(p);
  }

  /** What hangs on cell p: a block on top, a wall block beside, a player on it (the reason), undefined when nothing. */
  private hangs(p: Vec3): string | undefined {
    const up = { ...p, y: p.y + 1 };
    const top = this.h.blockAt(up);
    if (top && !isAirName(top.name) && !isLiquid(top) && (isBuiltBlock(top.name) || (!fullCube(top) && (top.hardness ?? 0) > LOOSE_HARDNESS && !LOOSE_NAMES.has(top.name)))) return 'supports a block';
    for (const [dx, dz] of SIDES) {
      const q = { x: p.x + dx, y: p.y, z: p.z + dz };
      const s = this.h.blockAt(q);
      if (s && isBuiltBlock(s.name) && !fullCube(s) && !this.ownTorches.has(key(q))) return 'holds a wall block'; // a wall torch, a ladder, a sign, a button
    }
    if (this.h.players?.().some((f) => overlapsBody(f, up))) return 'player on it';
    return undefined;
  }

  /**
   * The climb's rule: inside the box the job's own refusals (a staircase out may be dug there), outside
   * the miner's (the protected area too) and what hangs on the cell. The floor under the feet is not a
   * reason here (the climb checks its own floor); `way`: a player on the cell is not one either (it moves
   * on, wayOut asks whether the stairs can be made walkable).
   */
  private climbRule(p: Vec3, way = false): string | undefined {
    const why = inBox(this.spec.box, p) ? this.refusal(p) : (this.h.tunnelWorld?.breakRule(p) ?? this.hangs(p));
    return why === 'under_feet' || (way && why === 'player on it') ? undefined : why;
  }

  /**
   * Quarry, before layer i: the treads above it still make a way out. Each solid (no cave, no liquid),
   * the 3 cells over it (feet, head, the step up) open, or solid and diggable (inside the box: not
   * refused; outside: the climb's rule). The reason when not, undefined when they do.
   */
  wayOut(i: number): string | undefined {
    const exit = this.spec.exit;
    if (exit && i > 0)
      for (const c of [exit, { ...exit, y: exit.y + 1 }]) {
        const a = this.h.blockAt(c);
        if (!a) return `the stair head ${fmtCell(c)} is not loaded`;
        if (isLiquid(a)) return `${a.name} at the stair head ${fmtCell(c)}`;
        const why = a.boxes.length > 0 ? this.climbRule(c, true) : undefined;
        if (why !== undefined && why !== 'air') return `${a.name} at the stair head ${fmtCell(c)} stays (${why})`;
      }
    for (const t of this.spec.keep.slice(0, i)) {
      const b = this.h.blockAt(t);
      if (!b) return `the tread at ${fmtCell(t)} is not loaded`;
      if (isLiquid(b)) return `${b.name} in the tread at ${fmtCell(t)}`;
      if (b.boxes.length === 0) return `the tread at ${fmtCell(t)} is open (${b.name})`;
      for (let dy = 1; dy <= 3; dy++) {
        const c = { ...t, y: t.y + dy };
        const a = this.h.blockAt(c);
        if (!a) return `${fmtCell(c)} over the tread is not loaded`;
        if (isLiquid(a)) return `${a.name} over the tread at ${fmtCell(t)}`;
        if (a.boxes.length === 0) continue;
        const why = this.climbRule(c, true);
        if (why !== undefined && why !== 'air') return `${a.name} over the tread at ${fmtCell(t)} stays (${why})`;
      }
    }
    return undefined;
  }

  /** The world as the slice's planner sees it: every refused cell unbreakable (the planner leaves it and may stand on it). */
  private view(slice: Box): BlockReader {
    const refused = new Set<string>();
    for (let y = slice.max.y; y >= slice.min.y; y--)
      for (let x = slice.min.x; x <= slice.max.x; x++)
        for (let z = slice.min.z; z <= slice.max.z; z++) {
          const p = { x, y, z };
          const b = this.h.blockAt(p);
          if (!b || isAirName(b.name) || isLiquid(b)) continue; // air (a liquid: the planner skips it, the loop below stops its column)
          const why = this.refusal(p);
          if (why === undefined || why === 'air' || why === 'under_feet') continue; // under the feet now, not when the runner digs it (it stands elsewhere then)
          refused.add(key(p));
          if (why !== 'stairs') this.skip(p, why);
        }
    // liquids in the slice stop their columns too
    for (let x = slice.min.x; x <= slice.max.x; x++)
      for (let z = slice.min.z; z <= slice.max.z; z++)
        for (let y = slice.max.y; y >= slice.min.y; y--) {
          const b = this.h.blockAt({ x, y, z });
          if (b && isLiquid(b)) {
            const was = this.stopped.get(colKey(x, z));
            if (was === undefined || y > was) this.stopped.set(colKey(x, z), y);
            this.skip({ x, y, z }, 'liquid');
          }
        }
    return {
      blockAt: (p) => {
        const b = this.h.blockAt(p);
        return b && refused.has(key(p)) ? { ...b, ...UNBREAKABLE } : b;
      },
    };
  }

  private runnerDeps(epoch: number): RunnerDeps {
    const h = this.h;
    return {
      blockAt: (p) => h.blockAt(p),
      position: () => h.position(),
      onGround: () => h.onGround(),
      goto: (g, o) => h.goto(g, o),
      place: (p, o) => h.place(p, o),
      // the rules again right before each dig (water may have flowed, sand fallen since the plan)
      dig: async (p) => {
        const why = this.refusal(p);
        if (why === 'air') return { ok: false, reason: 'no_block' };
        if (why !== undefined) {
          this.skip(p, why);
          return { ok: false, reason: `refused: ${why}` };
        }
        const name = h.blockAt(p)?.name;
        const r = await h.dig(p);
        if (r.ok && epoch === this.epoch) {
          this.stats.dug++;
          this.stats.skipped.delete(key(p)); // left by an earlier plan (out of reach, a failed walk), dug after all
          const n = (r.block ?? name ?? 'unknown').replace(/^minecraft:/, '');
          this.stats.dugBy[n] = (this.stats.dugBy[n] ?? 0) + 1;
        }
        return r;
      },
      collect: (r, t) => h.collect(r, t, this.take),
      waitTicks: (n) => h.waitTicks(n),
      inventory: h.inventory,
      reserve: () => ({ throwawayMin: h.throwawayMin() }),
      cancel: () => h.cancel(),
      log: this.log,
    };
  }

  private feet(): Vec3 | undefined {
    const p = this.h.position();
    return p ? { x: Math.floor(p.x), y: Math.floor(p.y + 1e-3), z: Math.floor(p.z) } : undefined;
  }

  private alive(epoch: number): boolean {
    return epoch === this.epoch && (this.state === 'run' || this.state === 'climb');
  }

  private async loop(): Promise<void> {
    const e = ++this.epoch;
    // a runner of the pause may still be winding down (its skill was cancelled)
    while (this.runner?.busy && e === this.epoch) await this.h.waitTicks(1);
    if (e !== this.epoch) return;
    this.state = this.index >= this.spec.slices.length ? 'climb' : 'run';
    this.activeSince = this.now();
    try {
      if (!this.counted) {
        const n = await solidCells(this.h, this.spec.slices);
        if (e !== this.epoch) return;
        this.counted = true;
        this.total = n - this.spec.keep.filter((p) => (this.h.blockAt(p)?.boxes.length ?? 0) > 0).length;
      }
      if (this.aborting) return await this.leave(e, 'failed', this.aborting);
      while (this.index < this.spec.slices.length) {
        if (!carriesPickaxe(this.h.slots())) return await this.leave(e, 'failed', 'no pickaxe');
        const way = this.spec.kind === 'quarry' ? this.wayOut(this.index) : undefined;
        // the stairs are broken under the layers dug so far: no deeper, out while it can
        if (way) return await this.leave(e, 'blocked', `no way out below y ${this.spec.box.max.y - this.index + 1}: ${way}`);
        const r = await this.slice(this.index, e);
        if (!this.alive(e)) return;
        if (r !== 'ok') return await this.leave(e, r.end, r.why);
        this.index++;
        this.stats.slicesDone = this.index;
      }
      await this.leave(e, 'done');
    } catch (err) {
      if (e !== this.epoch) return;
      const why = err instanceof Error ? err.message : String(err);
      try {
        await this.leave(e, 'failed', why);
      } catch {
        if (e === this.epoch) this.end('failed', why);
      }
    }
  }

  /** End the job (not a stop): a quarry climbs out of its pit first (inside the base no other walk digs it out). */
  private async leave(e: number, s: QuarryState, why?: string): Promise<void> {
    if (this.spec.kind === 'quarry') {
      this.state = 'climb';
      await this.climbOut(e);
      if (!this.alive(e)) return;
    }
    this.end(s, why);
  }

  /** End the job with `why` (the stash step found the inventory still full): a quarry climbs out first. */
  abort(why: string): void {
    if (!this.running) return;
    this.aborting = why;
    if (this.state !== 'paused') this.pause();
    void this.loop();
  }

  /**
   * Paused (the stash step is about to walk to a chest): a quarry climbs out of its pit first, so that
   * walk starts on the surface (inside the base it digs nothing, and a cell left over a tread would trap
   * it). Paused again after; a pre-emption meanwhile pauses the climb.
   */
  async surface(): Promise<void> {
    if (this.state !== 'paused' || this.spec.kind !== 'quarry') return;
    const e = ++this.epoch;
    while (this.runner?.busy && e === this.epoch) await this.h.waitTicks(1);
    if (e !== this.epoch || this.state !== 'paused') return;
    this.state = 'climb';
    try {
      await this.climbOut(e);
    } finally {
      if (e === this.epoch && this.state === 'climb') {
        this.epoch++;
        this.state = 'paused';
      }
    }
  }

  /**
   * Far from the slice (an unload trip, a fight): walk back to the job first (no digging, no placing).
   * A quarry's first layer starts at the stair head (a box given by corners may be away from the bot).
   */
  private async approach(slice: Box, e: number): Promise<string | undefined> {
    const pos = this.h.position();
    if (!pos) return 'no position';
    const exit = this.spec.exit;
    if (exit && this.index === 0) {
      if (Math.hypot(exit.x + 0.5 - pos.x, exit.y - pos.y, exit.z + 0.5 - pos.z) <= QUARRY_NEAR_EXIT) return undefined;
    } else {
      const cx = Math.max(slice.min.x, Math.min(slice.max.x, Math.floor(pos.x)));
      const cy = Math.max(slice.min.y, Math.min(slice.max.y, Math.floor(pos.y)));
      const cz = Math.max(slice.min.z, Math.min(slice.max.z, Math.floor(pos.z)));
      if (Math.hypot(cx + 0.5 - pos.x, cy - pos.y, cz + 0.5 - pos.z) <= QUARRY_APPROACH) return undefined;
    }
    const to = this.entry();
    this.log.info(`${this.spec.label}: back to the job at ${fmtCell(to)}`);
    const r = await this.h.goto({ type: 'block', p: to }, { allowBreak: false, allowPlace: false, timeoutTicks: 6000 });
    if (!this.alive(e)) return undefined;
    return r.ok ? undefined : `cannot get back to the job at ${fmtCell(to)}: ${r.reason ?? 'failed'}`;
  }

  /** Where the job is walked back to: a quarry's stair head, a tunnel's last cleared lane cell. */
  private entry(): Vec3 {
    const t = this.spec.tunnel;
    if (!t) return this.spec.exit ?? this.spec.start;
    if (this.index === 0) return this.spec.start;
    const s = this.spec.start;
    return { x: s.x + t.dir[0] * this.index, y: s.y, z: s.z + t.dir[1] * this.index };
  }

  private async slice(i: number, e: number): Promise<'ok' | { end: QuarryState; why: string }> {
    const box = this.spec.slices[i]!;
    const far = await this.approach(box, e);
    if (!this.alive(e)) return 'ok';
    if (far) return { end: 'failed', why: far };
    const start = this.feet();
    if (!start) return { end: 'failed', why: 'no position' };
    const view = this.view(box);
    const spec: BuildSpec = { kind: 'clear', label: `${this.spec.label} ${this.spec.kind === 'quarry' ? `layer y ${box.min.y}` : `block ${i + 1}`}`, places: [], box };
    const t0 = this.now();
    const plan: Plan = await planBuildAsync(view, spec, { start, scaffold: false });
    this.stats.plans++;
    this.stats.planMs += this.now() - t0;
    if (!this.alive(e)) return 'ok';
    for (const s of plan.skipped) if (!this.keep.has(key(s.pos))) this.skip(s.pos, s.reason); // the refused cells keep their own reason (the first one wins)
    this.log.info(`${spec.label}: ${plan.work} to dig, ${plan.already} open, ${plan.skipped.length} left`);
    const runner = new BuildRunner(plan, this.runnerDeps(e));
    this.runner = runner;
    const end = await runner.run();
    for (const s of runner.stats.skipped) this.skip(s.pos, s.reason.replace(/^dig: (refused: )?/, ''));
    if (!this.alive(e) || end.state === 'paused') return 'ok';
    if (end.state === 'stopped') return { end: 'failed', why: end.reason };
    if (this.spec.tunnel) return this.afterCrossSection(i, e);
    return 'ok';
  }

  /** Tunnel: the lane open, the floor holes filled, a torch every TORCH_EVERY blocks. */
  private async afterCrossSection(i: number, e: number): Promise<'ok' | { end: QuarryState; why: string }> {
    const t = this.spec.tunnel!;
    const s = this.spec.start;
    const lane = { x: s.x + t.dir[0] * (i + 1), y: s.y, z: s.z + t.dir[1] * (i + 1) };
    for (const c of [lane, { ...lane, y: lane.y + 1 }]) {
      const b = this.h.blockAt(c);
      if (b && b.boxes.length > 0) return { end: 'blocked', why: `blocked at ${fmtCell(c)} (${this.stats.skipped.get(key(c)) ?? b.name})` };
      if (b && isLiquid(b)) return { end: 'blocked', why: `liquid at ${fmtCell(c)}` };
    }
    const r = turnRight(t.dir);
    for (const o of lateral(t.w)) {
      const f = { x: lane.x + r[0] * o, y: lane.y - 1, z: lane.z + r[1] * o };
      const b = this.h.blockAt(f);
      if (!b || b.boxes.length > 0) continue;
      if (isLiquid(b)) {
        if (o === 0) return { end: 'blocked', why: `liquid under the lane at ${fmtCell(f)}` };
        continue;
      }
      const ok = await this.fillFloor(f);
      if (!this.alive(e)) return 'ok';
      if (!ok && o === 0) return { end: 'blocked', why: `no floor at ${fmtCell(f)} (no throwaway block placed)` };
    }
    if ((i + 1) % TORCH_EVERY === 0 && carriesTorch(this.h.slots())) {
      const at = this.torchCell(i);
      if (at) {
        const p = await placeTorch((q, o) => this.h.place(q, o ?? {}), at);
        if (!this.alive(e)) return 'ok';
        if (p.ok) {
          this.stats.torches++;
          this.ownTorches.add(key(at));
        } else this.log.info(`${this.spec.label}: torch at ${fmtCell(at)}: ${p.reason ?? 'failed'}`);
      } else this.log.info(`${this.spec.label}: no open floor cell for the torch at block ${i + 1}`);
    }
    return 'ok';
  }

  /**
   * Where block i's torch goes (on the floor): the cross-section's columns from the left, the first open
   * one on a solid floor and clear of the bot's body (the PlaceSkill refuses a cell the body is in); in
   * a tunnel narrower than 3 the bot may fill the cross-section, so the two behind it come next.
   */
  private torchCell(i: number): Vec3 | undefined {
    const t = this.spec.tunnel!;
    const s = this.spec.start;
    const r = turnRight(t.dir);
    const pos = this.h.position();
    for (let k = i; k >= Math.max(0, i - 2); k--)
      for (const o of lateral(t.w)) {
        const c = { x: s.x + t.dir[0] * (k + 1) + r[0] * o, y: s.y, z: s.z + t.dir[1] * (k + 1) + r[1] * o };
        const b = this.h.blockAt(c);
        const f = this.h.blockAt({ ...c, y: c.y - 1 });
        if (!b || !isAirName(b.name) || !f || f.boxes.length === 0 || isLiquid(f)) continue;
        if (pos && overlapsBody(pos, c)) continue;
        return c;
      }
    return undefined;
  }

  /** A throwaway block into a floor hole (the keeper's reserve may be used: the tunnel gives it back). */
  private async fillFloor(f: Vec3): Promise<boolean> {
    const items = THROWAWAY_BLOCKS.filter((n) => this.h.inventory.count(n) > 0);
    if (items.length === 0) return false;
    const r = await this.h.place(f, { item: items.slice(0, 1), jump: false });
    if (r.ok) this.stats.floors++;
    else this.log.info(`${this.spec.label}: floor at ${fmtCell(f)}: ${r.reason ?? 'failed'}`);
    return r.ok;
  }

  /** Quarry: back up to the stair head (the treads, else tunnel.ts climbTo's pillar or dug staircase). */
  private async climbOut(e: number): Promise<void> {
    const top = this.spec.exit ?? this.spec.start;
    const pos = this.h.position();
    if (!pos || pos.y >= top.y - 0.5) return;
    this.log.info(`${this.spec.label}: back up to ${fmtCell(top)}`);
    const up = await this.walkStairs(e, top);
    if (!this.alive(e)) return;
    if (up) {
      this.stats.climb = { ok: true, dug: 0, placed: 0 };
      return;
    }
    // the climb's staircase is planned and dug under the job's rules (inside the box) too
    const tw = this.h.tunnelWorld;
    const w: TunnelWorld | undefined = tw && { breakRule: (p) => this.climbRule(p), cell: (p) => tw.cell(p), blockAt: (p) => tw.blockAt(p) };
    const r = await climbTo(
      {
        dig: (p) => this.h.dig(p),
        goto: (g, o) => this.h.goto(g, o),
        breakRule: (p) => this.climbRule(p),
        free: (p) => w?.cell(p)?.open,
        position: () => this.h.position(),
        waitTicks: (n) => this.h.waitTicks(n),
        alive: () => this.alive(e),
        ...(this.h.throwaways ? { throwaways: () => this.h.throwaways?.() ?? 0 } : {}),
      },
      w,
      top,
      { log: (m) => this.log.info(`${this.spec.label}: ${m}`) },
    );
    if (r.interrupted) return;
    this.stats.climb = { ok: r.ok, dug: r.dug, placed: r.placed, ...(r.reason ? { why: r.reason } : {}) };
  }

  /**
   * Up the treads one at a time (walks that dig and place nothing), from the first one at or above the
   * feet to the stair head. A walk that fails gets the solid cells over its tread dug (those the job may
   * dig: a cell the plan left) and one more try. True when at the stair head.
   */
  private async walkStairs(e: number, top: Vec3): Promise<boolean> {
    const pos = this.h.position();
    if (!pos || this.spec.keep.length === 0) return false;
    const y = Math.floor(pos.y + 1e-3);
    const steps = [...this.spec.keep.filter((t) => t.y + 1 >= y).map((t) => ({ ...t, y: t.y + 1 })).reverse(), top];
    for (const s of steps) {
      let r = await this.h.goto({ type: 'block', p: s }, { allowBreak: false, allowPlace: false, timeoutTicks: 400 });
      if (!this.alive(e)) return false;
      if (r.ok) continue;
      let dug = 0;
      for (let dy = 0; dy <= 2; dy++) {
        const c = { ...s, y: s.y + dy };
        const b = this.h.blockAt(c);
        if (!b || b.boxes.length === 0 || this.climbRule(c) !== undefined) continue;
        const d = await this.h.dig(c);
        if (!this.alive(e)) return false;
        if (d.ok) dug++;
      }
      if (dug === 0) return false;
      this.log.info(`${this.spec.label}: dug ${dug} over the tread under ${fmtCell(s)}`);
      r = await this.h.goto({ type: 'block', p: s }, { allowBreak: false, allowPlace: false, timeoutTicks: 400 });
      if (!this.alive(e) || !r.ok) return false;
    }
    return true;
  }
}
