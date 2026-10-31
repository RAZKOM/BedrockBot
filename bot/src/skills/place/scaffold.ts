// Temporary scaffold (docs/wood.md "Pillar-up", docs/decisions/0051): blocks a job places only to reach
// something (the feller's pillar next to a tall trunk, a pickup's pillar onto a ledge) are recorded cell by
// cell and dug again. Only recorded cells are ever dug, and only while they still hold the block that was
// placed there (never a block the bot did not place). The record lives on BotSkills (`skills.scaffold`), not
// in the job: a job cancelled on top of its pillar leaves the cells recorded, and the next skill that moves
// the bot (goto, collect, fellTree) digs them down first.
//
//   record   ScaffoldRecord: the cells placed, with the block name each one got
//   pillar   pillarStep: one block under the feet (the PlaceSkill's pillar-up: jump, place, land); a click the
//            server confirms late (a timeout under lag) is re-checked for a while and recorded when the block
//            shows up, so the dig-down never stops on an unrecorded block in mid-air
//   cleanup  clearScaffold: standing on a recorded column, sneaking, dig the block under the feet and drop one
//            block (no fall damage), down to the ground; on the way down every other recorded column within
//            reach is stripped from its top down to the feet level. A column the bot does not stand on is
//            walked onto first (no digging or placing on the way); when its top is out of reach (the bot fell
//            off, died, respawned) it pillars up beside it (with blocks it can harvest) and strips it on the
//            way down. A cell is dug from the side only while the bot stands on natural ground (not
//            scaffold) no higher than the cell (the topmost of its column). Anything else is left and logged:
//            a dig-down that would drop the bot more than `maxDrop` blocks, no blocks to climb beside it.
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

/**
 * The block now in a recorded cell is still the one placed there: the same name, or placed dirt that grass (or
 * mycelium) has grown over in the light (2026-10-30 e2e: the bottom pillar block next to a lawn turned to grass_block
 * within seconds and was never dug).
 */
export function sameScaffold(placed: string, now: string | undefined): boolean {
  if (now === placed) return true;
  return placed === 'dirt' && (now === 'grass_block' || now === 'mycelium' || now === 'podzol');
}

/** The cells placed as scaffold and not dug again yet, in placement order. */
export class ScaffoldRecord {
  private readonly byKey = new Map<string, ScaffoldCell>();
  /** Cells given up on (left in the world), counted over the record's life. */
  lost = 0;

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

/**
 * Natural terrain a walk that may dig (a pickup's hard walk) may break: stone and its kinds, dirt, sand, gravel,
 * ores, leaves, snow ... Never logs, cobblestone, planks, glass or anything else a player may have built with
 * (2026-10-30 review: a pickup walk outside home dug through whatever was in its way).
 */
const NATURAL = new Set([
  'stone', 'granite', 'diorite', 'andesite', 'deepslate', 'tuff', 'calcite', 'dripstone_block', 'netherrack', 'basalt', 'blackstone', 'end_stone',
  'dirt', 'coarse_dirt', 'rooted_dirt', 'grass_block', 'podzol', 'mycelium', 'mud', 'clay', 'moss_block', 'dirt_with_roots',
  'sand', 'red_sand', 'gravel', 'snow', 'snow_layer', 'powder_snow', 'soul_sand', 'soul_soil', 'magma',
  'terracotta', 'hardened_clay', 'crimson_nylium', 'warped_nylium', 'smooth_basalt', 'pointed_dripstone',
]);
export function isNaturalTerrain(name: string): boolean {
  const n = name.startsWith('minecraft:') ? name.slice(10) : name;
  return NATURAL.has(n) || n.endsWith('_ore') || n.endsWith('_leaves') || (n.endsWith('_terracotta') && !n.endsWith('glazed_terracotta')) || n === 'tallgrass' || n === 'short_grass';
}

export interface ScaffoldDeps {
  blockAt: (p: Vec3) => BlockInfo | undefined;
  /** Feet position; `onGround` when the body rests on something. */
  state: () => { pos: Vec3; onGround?: boolean };
  dig: (p: Vec3, opts?: DigOptions) => Promise<DigResult>;
  /** Walk only (the cleanup never digs or places on its way). Optional: without it only the column the bot stands on is cleared. */
  goto?: (goal: Goal, opts?: GotoOptions) => Promise<SkillResult>;
  waitTicks: (n: number) => Promise<void>;
  /** Pillar-up beside a column whose top is out of reach (the PlaceSkill's pillar, with harvestable throwaway blocks). Optional. */
  place?: (p: Vec3) => Promise<{ ok: boolean; reason?: string; block?: string }>;
  /** Blocks `place` can use. */
  throwaways?: () => number;
  /** Hold sneak (true) while standing on scaffold, release (false) on the ground. */
  sneak?: (on: boolean) => void;
  /** True when the cleanup must stop (disposed, dead). A dig interrupted otherwise is tried again. */
  cancelled?: () => boolean;
  /** A hostile mob near (checked on every pass): the dig-down stops 1 block above the ground (lowEnough 1). */
  hostileNear?: () => boolean;
  logger?: Logger;
}

export interface ClearOptions {
  /** Deepest fall the dig-down may cause, blocks (fall damage starts above 3). Default 3. */
  maxDrop?: number;
  /** Eye to the closest point of a cell dug from the side or stripped. Default DEFAULT_REACH - 0.6 (the sneaking eye is lower). */
  reach?: number;
  /** goto timeout onto a column's top / to its foot. Default 300 ticks. */
  gotoTicks?: number;
  /** Only dig down the column the bot stands on; other pending cells stay recorded (BotSkills.descendFirst). */
  downOnly?: boolean;
  /**
   * Stop (the rest stays recorded) once the bot stands this many blocks or less above the ground under its column:
   * a hostile at the foot hits the bot and spoils every dig (2026-10-30 e2e: the bottom block was left after 3 tries).
   */
  lowEnough?: number;
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
 * Air (no collision box) under cell `p` before something solid. A body standing on `p` falls this + 1 blocks once
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

/** The body stands on a recorded cell (that still holds its block). */
export function onScaffold(record: ScaffoldRecord, deps: Pick<ScaffoldDeps, 'blockAt' | 'state'>): boolean {
  const f = feetCell(deps.state().pos);
  const under = { x: f.x, y: f.y - 1, z: f.z };
  const c = record.get(under);
  return !!c && sameScaffold(c.name, deps.blockAt(under)?.name);
}

/** A click answered late: the block may show up after the placer gave up (re-checked up to this many ticks). */
export const LATE_PLACE_TICKS = 40;

/**
 * Record cell `p` when it holds a block now that it did not hold before the click (`kinds`: the names that may
 * show up). With `waitTicks`, a click that timed out or was interrupted is re-checked for LATE_PLACE_TICKS.
 */
export async function recordPlaced(
  record: ScaffoldRecord,
  p: Vec3,
  r: { ok: boolean; reason?: string; block?: string },
  deps: { blockAt: ScaffoldDeps['blockAt']; waitTicks?: (n: number) => Promise<void> },
  kinds?: readonly string[],
): Promise<boolean> {
  const fits = (b: BlockInfo | undefined) => !!b && !empty(b) && (!kinds || kinds.includes(b.name));
  const now = deps.blockAt(p);
  if (fits(now)) {
    record.add(p, now!.name);
    return true;
  }
  const maybe = r.ok || r.reason === 'timeout' || r.reason === 'interrupted';
  if (!maybe || !deps.waitTicks) return false;
  for (let i = 0; i < LATE_PLACE_TICKS; i += 2) {
    await deps.waitTicks(2);
    const b = deps.blockAt(p);
    if (fits(b)) {
      record.add(p, b!.name);
      return true;
    }
  }
  return false;
}

/**
 * One pillar step: place a block in the feet cell (the PlaceSkill jumps, places under the feet and lands).
 * Records the cell when the block is there afterwards, also when the server confirmed it late.
 */
export async function pillarStep(
  record: ScaffoldRecord,
  deps: Pick<ScaffoldDeps, 'blockAt' | 'state'> & { place: (p: Vec3) => Promise<{ ok: boolean; reason?: string; block?: string }>; waitTicks?: (n: number) => Promise<void>; kinds?: readonly string[] },
): Promise<{ ok: boolean; reason?: string }> {
  const cell = feetCell(deps.state().pos);
  if (!empty(deps.blockAt(cell))) return { ok: false, reason: 'occupied' };
  const r = await deps.place(cell);
  if (await recordPlaced(record, cell, r, deps, deps.kinds)) return { ok: true };
  return { ok: false, reason: r.reason ?? 'not_placed' };
}

/** Dig every recorded scaffold cell that is still there and safe to remove (see the file comment). */
export async function clearScaffold(record: ScaffoldRecord, deps: ScaffoldDeps, opts: ClearOptions = {}): Promise<ClearResult> {
  const log = deps.logger ?? silentLogger;
  const maxDrop = opts.maxDrop ?? 3;
  const reach = opts.reach ?? DEFAULT_REACH - 0.6;
  const out: ClearResult = { removed: [], left: [], gone: [] };
  const given = new Set<string>(); // columns given up on
  const climbed = new Set<string>(); // columns climbed beside already
  const ours = (c: ScaffoldCell) => sameScaffold(c.name, deps.blockAt(c.p)?.name);
  const col = (p: Vec3) => `${p.x},${p.z}`;
  const leave = (c: ScaffoldCell, why: string) => {
    out.left.push({ p: c.p, why });
    record.delete(c.p);
    record.lost++;
    log.warn(`scaffold: leaving ${key(c.p)} (${c.name}): ${why}`);
  };
  /** Stop on column `p` without giving it up: its cells stay recorded (pending), reported as left with why. */
  const keep = (p: Vec3, why: string) => {
    given.add(col(p));
    for (const c of record.cells) if (col(c.p) === col(p)) out.left.push({ p: c.p, why: `pending: ${why}` });
    log.warn(`scaffold: the column at ${col(p)} stays pending: ${why}`);
  };
  let interruptions = 0;
  const fails = new Map<string, number>();
  /** Count a failed dig of cell p; the count so far. */
  const failed = (p: Vec3): number => {
    const n = (fails.get(key(p)) ?? 0) + 1;
    fails.set(key(p), n);
    return n;
  };
  /** Dig a recorded cell; an interrupted dig (another skill took the digger) is tried again unless cancelled. */
  const dig = async (p: Vec3): Promise<'ok' | 'failed' | 'interrupted'> => {
    for (;;) {
      const r = await deps.dig(p, { tool: 'best' });
      if (r.ok) return 'ok';
      if (r.reason !== 'interrupted' && r.reason !== 'busy' && r.reason !== 'not_ready') return 'failed';
      if (deps.cancelled?.() || ++interruptions > 20) return 'interrupted';
      await deps.waitTicks(2);
    }
  };
  /** Tops of the recorded columns, highest cell per column. */
  const tops = (): ScaffoldCell[] => {
    const m = new Map<string, ScaffoldCell>();
    for (const c of record.cells) {
      if (given.has(col(c.p))) continue;
      const t = m.get(col(c.p));
      if (!t || c.p.y > t.p.y) m.set(col(c.p), c);
    }
    return [...m.values()];
  };
  const eyeOf = (pos: Vec3) => ({ x: pos.x, y: pos.y + EYE_HEIGHT - 0.35, z: pos.z }); // sneaking eye (conservative)

  try {
    for (let guard = 0; guard < 6 * record.size + 24 && record.size > 0; guard++) {
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
      if (tops().length === 0) break;
      const s = deps.state();
      const feet = feetCell(s.pos);
      const under = { x: feet.x, y: feet.y - 1, z: feet.z };
      const below = record.get(under);
      if (below && !given.has(col(under))) {
        deps.sneak?.(true);
        const lowEnough = opts.lowEnough ?? (deps.hostileNear?.() ? 1 : undefined); // checked on every pass
        if (lowEnough !== undefined) {
          // height over the first block under the column that is not ours
          let g = under.y;
          while (g > under.y - 64 && (record.has({ x: under.x, y: g, z: under.z }) || empty(deps.blockAt({ x: under.x, y: g, z: under.z })))) g--;
          if (feet.y - g - 1 <= lowEnough) break;
        }
        // strip the other columns in reach from the top down to the feet level first
        const strip = tops().find((t) => col(t.p) !== col(under) && t.p.y >= feet.y - 1 && checkReach(eyeOf(s.pos), t.p, reach).ok);
        if (strip) {
          const r = await dig(strip.p);
          if (r === 'interrupted') {
            out.interrupted = true;
            break;
          }
          if (r === 'ok') {
            out.removed.push(strip.p);
            record.delete(strip.p);
          } else if (failed(strip.p) >= 3) leave(strip, 'dig failed 3 times');
          continue;
        }
        // then dig down one block, land on the next one
        const fall = dropUnder(deps.blockAt, under) + 1;
        if (fall > maxDrop) {
          // never given up while the bot stands on it: it stays pending (it is the bot's floor)
          keep(under, `digging it would drop the bot ${fall === Infinity ? 'into unknown world' : `${fall} blocks`}`);
          break;
        }
        const y0 = s.pos.y;
        const r = await dig(under);
        if (r === 'interrupted') {
          out.interrupted = true;
          break;
        }
        if (r === 'failed') {
          // a hit (knockback) or a correction spoils a dig: look again (the body may be off the column now); after 3
          // failures back off a second; after 6 stop with the column still pending (the next dig-down tries again).
          // The cell under the feet is never given up (2026-10-31 review: given up, nothing ever dug the bot down).
          const n = failed(under);
          if (n % 3 === 0) await deps.waitTicks(20);
          if (n < 6) continue;
          keep(under, `dig failed ${n} times`);
          break;
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
      if (opts.downOnly) break; // only off the column it stands on (the rest stays pending)
      deps.sneak?.(false);
      // the column whose top is nearest
      const dist = (c: ScaffoldCell) => Math.hypot(c.p.x + 0.5 - s.pos.x, c.p.y + 1 - s.pos.y, c.p.z + 0.5 - s.pos.z);
      const top = tops().sort((a, b) => dist(a) - dist(b))[0]!;
      // walk onto the column (no digging, no placing), then the dig-down above takes over
      const onTop = { x: top.p.x, y: top.p.y + 1, z: top.p.z };
      if (deps.goto && empty(deps.blockAt(onTop)) && empty(deps.blockAt({ ...onTop, y: onTop.y + 1 }))) {
        const g = await deps.goto({ type: 'block', p: onTop }, { allowBreak: false, allowPlace: false, timeoutTicks: opts.gotoTicks ?? 300 });
        if (g.ok && feetCell(deps.state().pos).y === onTop.y) continue;
        if (!g.ok && g.reason === 'interrupted' && deps.cancelled?.()) {
          out.interrupted = true;
          break;
        }
      }
      // from the side: the topmost cell, from natural ground no higher than it (the scaffold is never the way down)
      const groundCell = deps.blockAt(under);
      const onNatural = !record.has(under) && !!groundCell && !empty(groundCell) && s.onGround !== false;
      if (onNatural && feet.y <= top.p.y + 1 && checkReach({ x: s.pos.x, y: s.pos.y + EYE_HEIGHT, z: s.pos.z }, top.p, reach).ok) {
        const r = await dig(top.p);
        if (r === 'ok') {
          out.removed.push(top.p);
          record.delete(top.p);
          continue;
        }
        if (r === 'interrupted') {
          out.interrupted = true;
          break;
        }
        if (failed(top.p) < 3) continue;
      }
      // out of reach: pillar up beside the column (once per column), then strip it on the way down
      if (deps.place && deps.goto && !climbed.has(col(top.p)) && (deps.throwaways?.() ?? 0) > 0) {
        climbed.add(col(top.p));
        const low = Math.min(...record.cells.filter((c) => col(c.p) === col(top.p)).map((c) => c.p.y));
        let foot: Vec3 | undefined;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const f = { x: top.p.x + dx, y: low, z: top.p.z + dz };
          for (let y = low + 3; y >= low - 3; y--) {
            const c = { ...f, y };
            if (empty(deps.blockAt(c)) && empty(deps.blockAt({ ...c, y: y + 1 })) && !empty(deps.blockAt({ ...c, y: y - 1 })) && !record.has({ ...c, y: y - 1 })) {
              foot = c;
              break;
            }
          }
          if (foot) break;
        }
        if (foot) {
          const g = await deps.goto({ type: 'block', p: foot }, { allowBreak: false, allowPlace: false, timeoutTicks: opts.gotoTicks ?? 300 });
          const at = feetCell(deps.state().pos);
          if (g.ok && at.x === foot.x && at.z === foot.z) {
            log.info(`scaffold: climbing beside ${key(top.p)} to dig it down`);
            let fails = 0;
            while (!checkReach(eyeOf(deps.state().pos), top.p, reach).ok && feetCell(deps.state().pos).y <= top.p.y + 1 && (deps.throwaways?.() ?? 0) > 0 && fails < 3) {
              if (deps.cancelled?.()) break;
              const h = deps.state().pos;
              const head = { x: Math.floor(h.x), y: Math.floor(h.y + 1e-3) + 2, z: Math.floor(h.z) };
              if (!empty(deps.blockAt(head)) || !empty(deps.blockAt({ ...head, y: head.y + 1 }))) break;
              const r = await pillarStep(record, { blockAt: deps.blockAt, state: deps.state, place: deps.place, waitTicks: deps.waitTicks });
              if (!r.ok) fails++;
              else deps.sneak?.(true);
            }
            if (onScaffold(record, deps)) continue; // the dig-down strips the column on the way
          }
        }
      }
      for (const c of record.cells.filter((c) => col(c.p) === col(top.p))) leave(c, 'out of reach (no way onto it, no blocks to climb beside it)');
      given.add(col(top.p));
    }
  } finally {
    if (!onScaffold(record, deps)) deps.sneak?.(false);
  }
  for (const c of record.cells) if (!given.has(col(c.p)) && !out.left.some((l) => key(l.p) === key(c.p))) out.left.push({ p: c.p, why: out.interrupted ? 'interrupted' : 'not reached' });
  if (out.removed.length || out.left.length) log.info(`scaffold: ${out.removed.length} block(s) dug again, ${out.left.length} left${out.left.length ? ` (${out.left.map((l) => key(l.p)).join(' ')})` : ''}`);
  return out;
}
