// Temporary scaffold (docs/wood.md "Pillar-up", docs/decisions/0051): blocks a job places only to reach
// something (the feller's pillar next to a tall trunk, a pickup's pillar onto a ledge) are recorded cell by
// cell and dug again at the end of the job step. Only recorded cells are ever dug, and only while they
// still hold the block that was placed there (never a block the bot did not place).
//
//   record   ScaffoldRecord: the cells placed, with the block name each one got
//   pillar   pillarStep: one block under the feet (the PlaceSkill's pillar-up: jump, place, land)
//   cleanup  clearScaffold: standing on a recorded column, dig the block under the feet and drop one
//            (each fall 1 block: no damage), down to the ground; a column the bot does not stand on is
//            walked onto first (no digging or placing on the way) and dug down the same way; failing that,
//            a recorded cell in reach is dug from the side only while the bot stands on natural ground no
//            higher than the cell's top (so the scaffold is never its way down). Anything else is left and
//            logged: removing it would strand the bot (a drop deeper than `maxDrop`) or it is out of reach.
import { silentLogger, type Logger } from '../../log.ts';
import type { BlockInfo, Vec3 } from '../../world/types.ts';
import { checkReach, DEFAULT_REACH, EYE_HEIGHT } from '../dig/look.ts';
import type { DigOptions, DigResult } from '../dig/digger.ts';
import type { Goal } from '../nav/goals.ts';
import type { GotoOptions, SkillResult } from '../types.ts';

export interface ScaffoldCell {
  p: Vec3;
  /** The block the placement left there (only that block is ever dug again). */
  name: string;
}

const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;

/** The cells a job placed as scaffold, in placement order. */
export class ScaffoldRecord {
  private readonly byKey = new Map<string, ScaffoldCell>();

  add(p: Vec3, name: string): void {
    const c = { p: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }, name };
    this.byKey.set(key(c.p), c);
  }

  delete(p: Vec3): void {
    this.byKey.delete(key(p));
  }

  has(p: Vec3): boolean {
    return this.byKey.has(key(p));
  }

  get(p: Vec3): ScaffoldCell | undefined {
    return this.byKey.get(key(p));
  }

  get cells(): ScaffoldCell[] {
    return [...this.byKey.values()];
  }

  get size(): number {
    return this.byKey.size;
  }
}

export interface ScaffoldDeps {
  blockAt: (p: Vec3) => BlockInfo | undefined;
  /** Feet position; `onGround` when the body rests on something. */
  state: () => { pos: Vec3; onGround?: boolean };
  dig: (p: Vec3, opts?: DigOptions) => Promise<DigResult>;
  /** Walk only (the cleanup never digs or places on its way). Optional: without it only the column the bot stands on is cleared. */
  goto?: (goal: Goal, opts?: GotoOptions) => Promise<SkillResult>;
  waitTicks: (n: number) => Promise<void>;
  cancelled?: () => boolean;
  logger?: Logger;
}

export interface ClearOptions {
  /** Deepest fall the dig-down may cause (blocks of air under the dug cell). Default 3 (no fall damage). */
  maxDrop?: number;
  /** Eye to the closest point of a cell dug from the side. Default DEFAULT_REACH - 0.25. */
  reach?: number;
  /** goto timeout onto a column's top. Default 300 ticks. */
  gotoTicks?: number;
}

export interface ClearResult {
  /** Cells dug again. */
  removed: Vec3[];
  /** Recorded cells left in the world, with why. */
  left: { p: Vec3; why: string }[];
  /** Recorded cells that were gone already (or held another block: never dug). */
  gone: Vec3[];
  interrupted?: boolean;
}

const feetCell = (pos: Vec3): Vec3 => ({ x: Math.floor(pos.x), y: Math.floor(pos.y + 1e-3), z: Math.floor(pos.z) });
const empty = (b: BlockInfo | undefined) => !!b && b.boxes.length === 0 && b.name !== 'unknown';

/**
 * Air (no collision box) under cell `p` before something solid: how far a body standing on `p` falls once
 * `p` is dug. Infinity when it reaches unknown world within 64 blocks.
 */
export function dropUnder(blockAt: ScaffoldDeps['blockAt'], p: Vec3): number {
  for (let d = 0; d < 64; d++) {
    const b = blockAt({ x: p.x, y: p.y - 1 - d, z: p.z });
    if (!b) return Infinity;
    if (!empty(b)) return d;
  }
  return Infinity;
}

/**
 * One pillar step: place a block in the feet cell (the PlaceSkill jumps, places under the feet and lands).
 * Records the cell when the block is there afterwards.
 */
export async function pillarStep(
  record: ScaffoldRecord,
  deps: Pick<ScaffoldDeps, 'blockAt' | 'state'> & { place: (p: Vec3) => Promise<{ ok: boolean; reason?: string; block?: string }> },
): Promise<{ ok: boolean; reason?: string }> {
  const cell = feetCell(deps.state().pos);
  const r = await deps.place(cell);
  const now = deps.blockAt(cell);
  if (r.ok && now && !empty(now)) {
    record.add(cell, r.block ?? now.name);
    return { ok: true };
  }
  return { ok: false, reason: r.reason ?? 'not_placed' };
}

/** Dig every recorded scaffold cell that is still there and safe to remove (see the file comment). */
export async function clearScaffold(record: ScaffoldRecord, deps: ScaffoldDeps, opts: ClearOptions = {}): Promise<ClearResult> {
  const log = deps.logger ?? silentLogger;
  const maxDrop = opts.maxDrop ?? 3;
  const reach = opts.reach ?? DEFAULT_REACH - 0.25;
  const out: ClearResult = { removed: [], left: [], gone: [] };
  const given = new Set<string>(); // columns given up on
  const ours = (c: ScaffoldCell) => deps.blockAt(c.p)?.name === c.name;
  const col = (p: Vec3) => `${p.x},${p.z}`;
  const leave = (c: ScaffoldCell, why: string) => {
    out.left.push({ p: c.p, why });
    record.delete(c.p);
    log.warn(`scaffold: leaving ${key(c.p)} (${c.name}): ${why}`);
  };

  for (let guard = 0; guard < 4 * record.size + 16 && record.size > 0; guard++) {
    if (deps.cancelled?.()) {
      out.interrupted = true;
      break;
    }
    // drop cells that are gone or hold another block now (never dug)
    for (const c of record.cells) {
      if (!ours(c)) {
        out.gone.push(c.p);
        record.delete(c.p);
      }
    }
    const live = record.cells.filter((c) => !given.has(col(c.p)));
    if (live.length === 0) break;
    const s = deps.state();
    const feet = feetCell(s.pos);
    const under = { x: feet.x, y: feet.y - 1, z: feet.z };
    const below = record.get(under);
    if (below && !given.has(col(under))) {
      // standing on our own column: dig down one block, land on the next one
      const drop = dropUnder(deps.blockAt, under);
      if (drop > maxDrop) {
        for (const c of record.cells.filter((c) => col(c.p) === col(under))) leave(c, `digging it would drop the bot ${drop === Infinity ? 'into unknown world' : `${drop} blocks`}`);
        given.add(col(under));
        continue;
      }
      const y0 = s.pos.y;
      const r = await deps.dig(under);
      if (!r.ok) {
        if (r.reason === 'interrupted') {
          out.interrupted = true;
          break;
        }
        leave(below, `dig failed: ${r.reason}`);
        given.add(col(under));
        continue;
      }
      out.removed.push(under);
      record.delete(under);
      // fall and land (a block takes about 8 ticks; at most 30)
      for (let i = 0; i < 30; i++) {
        await deps.waitTicks(1);
        const st = deps.state();
        if (st.pos.y < y0 - 0.5 && st.onGround !== false) break;
      }
      continue;
    }
    // the highest live cell of the column whose top is nearest
    const tops = new Map<string, ScaffoldCell>();
    for (const c of live) {
      const t = tops.get(col(c.p));
      if (!t || c.p.y > t.p.y) tops.set(col(c.p), c);
    }
    const dist = (c: ScaffoldCell) => Math.hypot(c.p.x + 0.5 - s.pos.x, c.p.y + 1 - s.pos.y, c.p.z + 0.5 - s.pos.z);
    const top = [...tops.values()].sort((a, b) => dist(a) - dist(b))[0]!;
    // walk onto the column (no digging, no placing), then the dig-down above takes over
    const onTop = { x: top.p.x, y: top.p.y + 1, z: top.p.z };
    if (deps.goto && empty(deps.blockAt(onTop)) && empty(deps.blockAt({ ...onTop, y: onTop.y + 1 }))) {
      const g = await deps.goto({ type: 'block', p: onTop }, { allowBreak: false, allowPlace: false, timeoutTicks: opts.gotoTicks ?? 300 });
      if (g.ok) continue;
      if (g.reason === 'interrupted') {
        out.interrupted = true;
        break;
      }
    }
    // from the side: only from natural ground no higher than the column's top (the scaffold is not the way down)
    const eye = { x: s.pos.x, y: s.pos.y + EYE_HEIGHT, z: s.pos.z };
    const standsOnOwn = record.has(under);
    if (!standsOnOwn && s.pos.y <= top.p.y + 1 + 1e-3 && checkReach(eye, top.p, reach).ok) {
      const r = await deps.dig(top.p);
      if (r.ok) {
        out.removed.push(top.p);
        record.delete(top.p);
        continue;
      }
      if (r.reason === 'interrupted') {
        out.interrupted = true;
        break;
      }
    }
    for (const c of record.cells.filter((c) => col(c.p) === col(top.p))) leave(c, 'not reachable without stranding the bot');
    given.add(col(top.p));
  }
  for (const c of record.cells) if (!out.left.some((l) => key(l.p) === key(c.p))) out.left.push({ p: c.p, why: out.interrupted ? 'interrupted' : 'not reached' });
  if (out.removed.length || out.left.length) log.info(`scaffold: ${out.removed.length} block(s) dug again, ${out.left.length} left${out.left.length ? ` (${out.left.map((l) => key(l.p)).join(' ')})` : ''}`);
  return out;
}
