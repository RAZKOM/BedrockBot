// Builder types (wave 9, Track AL; docs/build.md). A build is a list of placements (cell, block name,
// optional states) and / or digs; the planner (plan.ts) turns it into ordered steps with scaffold
// cells, the runner (runner.ts) executes them on the bot.
import type { Vec3 } from '../../world/types.ts';

export type Cell = Vec3;

export interface BuildBlock {
  pos: Cell;
  /** Block name without namespace (`cobblestone`). */
  name: string;
  /** Block states from a structure file: the click gives them and the runner verifies them (states.ts, decision 0124). */
  states?: Readonly<Record<string, unknown>>;
}

export type BuildKind = 'fill' | 'clear' | 'replace' | 'wall' | 'floor' | 'pillar' | 'file';

/** What a `!build` command asks for, before planning. */
export interface BuildSpec {
  kind: BuildKind;
  /** `fill 5x3x5 cobblestone`, `file arch at 10 -60 3 (90)`. */
  label: string;
  /** Cells to fill (place kinds). */
  places: BuildBlock[];
  /** Box to clear (clear) or to replace in (replace). */
  box?: { min: Cell; max: Cell };
  /** replace: from -> to. */
  replace?: { from: string; to: string };
}

/** The largest build accepted (cells to place or dig). */
export const MAX_BUILD_CELLS = 4096;

export const key = (p: Cell): string => `${p.x},${p.y},${p.z}`;
export const cellOf = (p: Vec3): Cell => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
export const fmtCell = (p: Cell): string => `${p.x} ${p.y} ${p.z}`;
export const add = (p: Cell, dx: number, dy: number, dz: number): Cell => ({ x: p.x + dx, y: p.y + dy, z: p.z + dz });

/** Strip `minecraft:` and lower-case. */
export function blockId(name: string): string {
  const n = name.trim().toLowerCase();
  return n.startsWith('minecraft:') ? n.slice(10) : n;
}

/** Blocks a structure file uses for "no block here" (never placed, nothing required). */
export function isAirName(name: string): boolean {
  const n = blockId(name);
  return n === 'air' || n === 'cave_air' || n === 'void_air' || n === 'structure_void';
}

// The item that places a block (`itemFor`, with Track B2's banner and sign rows) and the builder's refusals
// (`unsupportedBlock`) live in states.ts with the block states (decision 0124).
