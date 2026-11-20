// The smelt shell (Track E3, docs/early-game.md "The furnace wait", ADR 0100): a smelt that will not end before dusk,
// or one started by night, waits inside a shell instead of in the open. With `smeltShell` on (default off: it builds and
// digs), and no shelter or home within SMELT_SHELL_SHELTER of the furnace (with one, the night rule takes the bot there
// and the smelt goes on from where it was left), the bot steps onto a cell next to the furnace (a cardinal neighbour at
// its height, two free cells and a full top under them), walls itself in with Track M1's shell (skills/survival/
// seal.ts; the furnace is one of its walls, so its window still opens), smelts, and at the end digs one side it placed
// open again: by day at once, by night at dawn (with a hostile within 16 then, after NIGHT_SHELL_DAWN_WAIT ticks at most,
// as the night shell). Measured on a fresh world (Track E2): the bot died at its furnace at dusk 186 s into a 33-item
// smelt (arrows, a witch's poison, a creeper; the flight at 1 health).
//
// The rule of when (for any world): the smelt takes 200 ticks an item in a furnace; it is shelled when it is night now
// (DUSK to DAWN) or the items' ticks plus SMELT_SHELL_MARGIN outlast the time left before dusk.
import type { Logger } from '../log.ts';
import { seal, sealCells, sealItems, type SealDeps } from '../skills/survival/seal.ts';
import { clearableCover } from '../skills/craft/table-spot.ts';
import type { BlockInfo, Vec3 } from '../world/types.ts';
import { DAWN, DUSK, isNight, timeOfDay } from './night.ts';
import { NIGHT_SHELL_DAWN_WAIT, shellExit } from './night-shell.ts';

/** Ticks a furnace takes an item. */
export const SMELT_TICKS = 200;
/** Ticks added to the smelt's own (the walk, the window, the shell itself). */
export const SMELT_SHELL_MARGIN = 400;
/** A shelter or home this close to the furnace: no shell (the night rule takes the bot there). */
export const SMELT_SHELL_SHELTER = 16;

const key = (p: Vec3): string => `${p.x},${p.y},${p.z}`;

/** Is the smelt of `items` to be shelled at time `t` (absolute or of day): night now, or it outlasts the day? */
export function smeltOutlastsDay(t: number | undefined, items: number, per = SMELT_TICKS, margin = SMELT_SHELL_MARGIN): boolean {
  if (t === undefined || items <= 0) return false;
  if (isNight(t)) return true;
  const tod = timeOfDay(t);
  const left = tod < DUSK ? DUSK - tod : DUSK + 24000 - tod; // after dawn (23000 to 24000) the day is ahead
  return items * per + margin > left;
}

/** The cell the bot waits in: a cardinal neighbour of the furnace at its height, feet and head free, a full top under it. */
export function shellStandCell(furnace: Vec3, solid: SealDeps['solid'], blockAt?: (p: Vec3) => BlockInfo | undefined, me?: Vec3): Vec3 | undefined {
  const out: { p: Vec3; d: number }[] = [];
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    const p = { x: furnace.x + dx, y: furnace.y, z: furnace.z + dz };
    const freeCell = (q: Vec3): boolean => solid(q.x, q.y, q.z) === false || (blockAt !== undefined && clearableCover(blockAt(q)));
    if (!freeCell(p) || !freeCell({ ...p, y: p.y + 1 }) || solid(p.x, p.y - 1, p.z) !== true) continue;
    const name = blockAt?.({ ...p, y: p.y - 1 })?.name ?? '';
    if (/water|lava|magma|campfire/.test(name)) continue;
    out.push({ p, d: me ? Math.hypot(p.x + 0.5 - me.x, p.z + 0.5 - me.z) : 0 });
  }
  return out.sort((a, b) => a.d - b.d)[0]?.p;
}

/**
 * The brace for the cell over the furnace: that cell beside the furnace's top (to the bot's left or right), against the
 * head-ring block next to the bot's head. Undefined when the cell over the furnace is solid or no side fits.
 */
export function smeltShellBrace(furnace: Vec3, cell: Vec3, solid: SealDeps['solid']): Vec3 | undefined {
  const over = { x: furnace.x, y: furnace.y + 1, z: furnace.z };
  if (solid(over.x, over.y, over.z) === true) return undefined;
  const dx = furnace.x - cell.x;
  const dz = furnace.z - cell.z;
  for (const [px, pz] of [
    [dz, -dx],
    [-dz, dx],
  ] as const) {
    const diag = { x: over.x + px, y: over.y, z: over.z + pz };
    if (solid(diag.x, diag.y, diag.z) === true) return undefined; // braced already
    if (solid(cell.x + px, cell.y + 1, cell.z + pz) === true) return diag;
  }
  return undefined;
}

export interface SmeltShellDeps {
  enabled(): boolean;
  /** The seal's ports (pve's sealDeps), undefined without a placer. */
  deps(): SealDeps | undefined;
  /** World time (absolute ticks), undefined before the first sync. */
  time(): number | undefined;
  /** The shelter and home (a shell is not built within SMELT_SHELL_SHELTER of one). */
  shelters(): Vec3[];
  /** Walk onto a cell (the exact block). */
  walkTo(cell: Vec3, cancelled: () => boolean): Promise<boolean>;
  blockAt?: (p: Vec3) => BlockInfo | undefined;
  log: Logger;
}

export type SmeltShellReason = 'off' | 'day' | 'shelter' | 'no_placer' | 'no_cell' | 'walk_failed' | 'blocks' | 'closed' | 'open' | 'interrupted';

/** One shell for one smelt (the smelt job keeps it across a pause: a resume finds it standing). */
export class SmeltShell {
  private readonly d: SmeltShellDeps;
  /** Cells this shell placed (a side of them is dug open at the end). */
  readonly placed = new Set<string>();
  readonly stats = { closed: 0, opened: 0, refused: 0, dawnWaits: 0 };
  lastReason: SmeltShellReason | undefined;

  constructor(d: SmeltShellDeps) {
    this.d = d;
  }

  get closed(): boolean {
    return this.placed.size > 0;
  }

  /** Before the smelt: wall in next to the furnace when the rule says so; the reason either way. */
  async close(furnace: Vec3, items: number, cancelled: () => boolean): Promise<SmeltShellReason> {
    const r = await this.tryClose(furnace, items, cancelled);
    this.lastReason = r;
    if (r !== 'off' && r !== 'day') this.d.log.info(`smelt shell: ${r}${r === 'closed' ? ` (${this.placed.size} block(s) placed)` : ''}`);
    return r;
  }

  private async tryClose(furnace: Vec3, items: number, cancelled: () => boolean): Promise<SmeltShellReason> {
    if (!this.d.enabled()) return 'off';
    const t = this.d.time();
    if (!this.closed && !smeltOutlastsDay(t, items)) return 'day';
    if (this.d.shelters().some((s) => Math.hypot(s.x - furnace.x, s.z - furnace.z) <= SMELT_SHELL_SHELTER && Math.abs(s.y - furnace.y) <= 8)) return 'shelter';
    const deps = this.d.deps();
    if (!deps) return 'no_placer';
    const me0 = deps.position();
    const cell = shellStandCell(furnace, deps.solid, this.d.blockAt, me0);
    if (!cell) return 'no_cell';
    const at = { x: Math.floor(me0.x), y: Math.floor(me0.y + 1e-3), z: Math.floor(me0.z) };
    const here = at.x === cell.x && at.y === cell.y && at.z === cell.z;
    const cells = sealCells({ x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }, deps.solid, [], deps.face);
    if (sealItems(deps.slots()).total < cells.length) {
      this.stats.refused++;
      return 'blocks';
    }
    if (!here) {
      for (const c of [cell, { ...cell, y: cell.y + 1 }]) {
        if (this.d.blockAt && clearableCover(this.d.blockAt(c))) await deps.dig(c).catch(() => undefined);
      }
      if (!(await this.d.walkTo(cell, cancelled))) return cancelled() ? 'interrupted' : 'walk_failed';
      if (deps.centre) await deps.centre(cell);
    }
    if (cancelled()) return 'interrupted';
    // covers in the shell's cells take no block: dug first (the night shell's rule)
    if (this.d.blockAt) {
      for (const c of sealCells(deps.position(), deps.solid)) if (clearableCover(this.d.blockAt(c))) await deps.dig(c).catch(() => undefined);
    }
    // no dig-in: the hole is not left again by this rule
    const { block: _noDigIn, ...surface } = deps;
    void _noDigIn;
    let r = await seal(surface, cancelled);
    for (const p of r.placed) this.placed.add(key(p));
    if (cancelled()) return 'interrupted';
    if (!r.ok) {
      // the cell over the furnace has no face to go against but the furnace's top, which a click opens instead (measured:
      // 6 placed, that cell, the roof's support and the roof open): a brace on its diagonal first, then the seal again
      const brace = smeltShellBrace(furnace, cell, deps.solid);
      if (brace) {
        const b = await deps.place(brace, { item: sealItems(deps.slots()).items, look: false, jump: false, timeoutTicks: 10 });
        if (b.ok) {
          this.placed.add(key(brace));
          r = await seal(surface, cancelled);
          for (const p of r.placed) this.placed.add(key(p));
          if (cancelled()) return 'interrupted';
        }
      }
    }
    if (r.ok) this.stats.closed++;
    else this.d.log.info(`smelt shell: ${r.open} cell(s) open (${r.reason ?? (r.openCells ?? []).map(key).join(' ')}), ${r.placed.length} placed`);
    return r.ok ? 'closed' : 'open';
  }

  /**
   * After the smelt: by night stay in until dawn (and while a hostile is within 16, NIGHT_SHELL_DAWN_WAIT ticks at
   * most), then dig one side this shell placed open. Cancelled (a pre-emption): the shell stays for the resume.
   */
  async open(cancelled: () => boolean): Promise<boolean> {
    if (!this.closed) return true;
    const deps = this.d.deps();
    if (!deps) return false;
    const wait = (n: number): Promise<void> => (deps.settle ? deps.settle(n) : new Promise((r) => setTimeout(r, n * 50)));
    let logged = false;
    while (isNight(this.d.time() ?? 0) && !cancelled()) {
      if (!logged) this.d.log.info(`smelt shell: night (time of day ${timeOfDay(this.d.time() ?? 0)}): staying in until ${DAWN}`);
      logged = true;
      await wait(20);
    }
    if (cancelled()) return false;
    if (deps.threats().length) {
      this.stats.dawnWaits++;
      let waited = 0;
      while (deps.threats().length && waited < NIGHT_SHELL_DAWN_WAIT && !cancelled()) {
        await wait(20);
        waited += 20;
      }
      if (cancelled()) return false;
    }
    const me = deps.position();
    const side = shellExit(me, this.placed, deps.solid, deps.threats());
    let dug = 0;
    for (const c of side ?? []) {
      if (deps.solid(c.x, c.y, c.z) !== true) continue;
      const r = await deps.dig(c).catch((e: unknown) => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }));
      if (r.ok) dug++;
      else this.d.log.warn(`smelt shell: could not dig ${key(c)} open (${r.reason ?? 'failed'})`);
    }
    this.stats.opened++;
    this.d.log.info(`smelt shell: opened (${dug} of ${side?.length ?? 0} cell(s) dug)`);
    this.placed.clear();
    return dug > 0 || (side?.length ?? 0) === 0;
  }
}
