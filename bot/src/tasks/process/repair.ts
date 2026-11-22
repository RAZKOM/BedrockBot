// Track K7 (ADR 0121, docs/flight.md "Renewing an elytra at an anvil (Track K7)"): a worn elytra (or another carried item)
// renewed at an anvil, as processes (the shape of Track K4's elytra):
//
// - planRepair (pure): the operation the bot would pay for: the item's repair material (phantom membranes for an elytra)
//   when there is any (it spends no second item), else a combine with a second one; the base of a combine is the piece
//   whose enchantments the other lacks (skills/items/anvil.ts chooseBase); refused before anything moves when there is
//   nothing to gain, it would be too expensive, the levels are short, or it would be the item's last renewal (the next one
//   would cost 40 levels or more: the reply says the penalty and the next cost first; `last` pays it anyway).
// - RepairJob: the plan, then the means (membranes out of the carried boxes or the chests at home: Supply.ensure; a second
//   elytra out of a carried box or the chests at home: the elytra controller's own source), the plan again on what is now
//   carried, the walk to the anvil, a worn elytra taken off, the operation (skills/items/anvil-use.ts), the result put on
//   again where it was (on the back, or carried in the slot of the base).
// - RepairProcess (user, `!repair`).
// - RepairChore (auto, PRIORITY.chore, `autoRepair`, default off): by day, idle within REPAIR_HOME of home, no hostile
//   within REPAIR_THREAT, an anvil within ANVIL_NEAR, the elytra at hand under ELYTRA_LOW_USES uses over its worn limit,
//   without Mending (a Mending elytra is mended with experience: tasks/process/mend.ts, which never raises the penalty),
//   phantom membranes to hand and the levels: the membranes only (a combine spends an elytra: the owner's call), never the
//   last renewal. A pass that changed nothing waits REPAIR_BACKOFF_MS.
// - RepairController.tripHint: the takeoff's refusal for the elytra (chat/commands-fly.ts spareFor) offers `!repair` when
//   the renewal it would pay covers the trip.
import type { Vec3 } from '../../connection/types.ts';
import type { RuntimeSettings } from '../../config/settings.ts';
import { silentLogger, type Logger } from '../../log.ts';
import type { ItemStack } from '../../world/types.ts';
import { checkOp, chooseBase, combineOp, materialOp, penaltyLine, pieceOf, pieceText, renewalsLeft, repairMaterials, unitsNeeded, type AnvilOp, type AnvilPiece, type OpRefusal } from '../../skills/items/anvil.ts';
import type { AnvilOutcome, AnvilUse } from '../../skills/items/anvil-use.ts';
import { covers, ELYTRA, ELYTRA_LOW_USES, type ElytraNeed, type ElytraState } from '../../skills/supply/elytra.ts';
import { maxDurability } from '../../skills/survival/tools.ts';
import { BaseProcess, PRIORITY, type ProcessManager, type ProcessStatus, type StopReason } from './manager.ts';

/** An anvil this near the bot is walked to (blocks). */
export const ANVIL_NEAR = 24;
/** The chore runs only with the bot this near home (blocks, horizontal). */
export const REPAIR_HOME = 16;
/** A hostile this near: the chore does not start. */
export const REPAIR_THREAT = 16;
/** After a chore's pass that changed nothing, or a refusal (ms). */
export const REPAIR_BACKOFF_MS = 10 * 60_000;
const CHECK_MS = 1000;
const WINDOW_ARMOR = 120;

export type RepairMode = 'membranes' | 'combine';

export interface RepairAsk {
  /** `elytra` or another item with durability. */
  item: string;
  mode?: RepairMode;
  /** Pay for the item's last renewal (after it every operation would be too expensive). */
  last?: boolean;
}

/** A second piece to combine with, and where it is. */
export interface Spare {
  piece: AnvilPiece;
  /** Player slot (carried loose) or a carried box (`box`: its slot and the slot inside). */
  slot?: number;
  box?: { slot: number; inBox: number };
}

export interface RepairInput {
  target: AnvilPiece;
  /** The material and the units of it to hand (carried, in the carried boxes, in the chests at home when allowed). */
  material?: { name: string; have: number };
  spares: readonly Spare[];
  levels: number | undefined;
  mode?: RepairMode;
  last?: boolean;
}

export type RepairPlan =
  | { ok: true; op: AnvilOp; kind: 'material'; units: number }
  | { ok: true; op: AnvilOp; kind: 'combine'; spare: Spare; base: 'target' | 'spare'; why: string }
  | { ok: false; kind: OpRefusal['kind'] | 'no_means'; why: string; op?: AnvilOp };

const itemWord = (name: string): string => name.replace(/^minecraft:/, '').replace(/_/g, ' ');

/** One way round of a combine with one second piece. */
interface Cand {
  spare: Spare;
  op: AnvilOp;
  base: 'target' | 'spare';
  why: string;
  refusal?: OpRefusal;
}

/** The operation to pay for, or why none (see the file comment). */
export function planRepair(i: RepairInput): RepairPlan {
  const t = i.target;
  const word = itemWord(t.name);
  const matWord = i.material ? itemWord(i.material.name) : undefined;
  if (i.mode !== 'combine' && i.material && i.material.have > 0) {
    const op = materialOp(t, i.material.name, i.material.have);
    if (!op) return { ok: false, kind: 'nothing', why: `nothing to gain: the ${word} is at ${t.left}/${t.max}` };
    const r = checkOp(op, i.levels, { last: i.last === true });
    return r ? { ok: false, kind: r.kind, why: r.why, op } : { ok: true, op, kind: 'material', units: op.units ?? 0 };
  }
  if (i.mode === 'membranes') return { ok: false, kind: 'no_means', why: `no ${matWord ?? `repair material for the ${word}`} carried, in the carried boxes or in the chests at home in reach` };
  if (i.spares.length === 0) {
    if (i.mode === 'combine') return { ok: false, kind: 'no_means', why: `no second ${word} to combine with (carried, in a carried box or in the chests at home in reach)` };
    return { ok: false, kind: 'no_means', why: `${matWord ? `no ${matWord}` : `the ${word} has no repair material I know`} and no second ${word} to combine with (carried, in the carried boxes or in the chests at home in reach)` };
  }
  if (t.left >= t.max && i.spares.every((s) => s.piece.enchants.every((e) => t.enchants.some((f) => f.id === e.id && f.lvl >= e.lvl)))) return { ok: false, kind: 'nothing', why: `nothing to gain: the ${word} is at ${t.left}/${t.max}` };
  // both ways round for each second piece: the same uses and enchantments, different levels (chooseBase says why)
  const cands: Cand[] = [];
  for (const spare of i.spares) {
    const c = chooseBase(t, spare.piece);
    const cheap = c.base === 'a' ? 'target' : 'spare';
    for (const [op, base] of [[combineOp(t, spare.piece), 'target'], [combineOp(spare.piece, t), 'spare']] as const) {
      const refusal = checkOp(op, i.levels, { last: i.last === true });
      const why = base === cheap ? c.why : `${base === 'target' ? 'it is the base' : 'the other one is the base'}: the other way round gains nothing`;
      cands.push({ spare, op, base, why, ...(refusal ? { refusal } : {}) });
    }
  }
  const rank = (a: Cand, b: Cand): number => b.op.result.left - a.op.result.left || b.op.result.enchants.length - a.op.result.enchants.length || a.op.cost - b.op.cost;
  const best = cands.filter((c) => !c.refusal).sort(rank)[0];
  if (best) return { ok: true, op: best.op, kind: 'combine', spare: best.spare, base: best.base, why: best.why };
  // (the refusal that names the real block first: too expensive, the levels, the last renewal, before nothing to gain)
  const worst = [...cands].sort((a, b) => Number(a.refusal!.kind === 'nothing') - Number(b.refusal!.kind === 'nothing') || a.op.cost - b.op.cost)[0]!;
  return { ok: false, kind: worst.refusal!.kind, why: worst.refusal!.why, op: worst.op };
}

/** `elytra 1 -> 432/432 with 4 phantom membranes for 4 levels` or `... combined with the spare (82/432) ...`. */
export function opLine(op: AnvilOp, paid?: number): string {
  const w = itemWord(op.target.name);
  const how = op.kind === 'material' ? `with ${op.units} ${itemWord(op.material ?? 'material')}${(op.units ?? 0) === 1 ? '' : 's'}` : op.kind === 'book' ? 'with an enchanted book' : `combined with ${pieceText(op.sacrifice!)}`;
  const levels = paid !== undefined && paid !== op.cost ? `${paid} levels (planned ${op.cost})` : `${op.cost} level${op.cost === 1 ? '' : 's'}`;
  return `${w} ${op.target.left} -> ${op.result.left}/${op.target.max} ${how} for ${levels}`;
}

export interface RepairReport {
  ok: boolean;
  item: string;
  /** The plan paid (or refused). */
  op?: AnvilOp;
  /** Levels the server took (before - after). */
  paid?: number;
  levels?: { before?: number | undefined; after?: number | undefined };
  /** The result as the server holds it. */
  after?: AnvilPiece;
  /** A combine's base and why. */
  base?: string;
  /** The means fetched first (`3 phantom membranes out of the chests at home`). */
  fetched?: string[];
  /** It was on the back and is again (false: it could not be put on again). */
  worn?: boolean;
  why?: string;
  reason: 'done' | 'refused' | 'failed' | 'interrupted';
}

/** Chat replies are cut at 256 characters (chat.ts maxReplyLength): parts are packed into lines under REPLY_MAX. */
export const REPLY_MAX = 240;

/** `parts` joined with `; ` into as few lines as fit REPLY_MAX, each after the first starting with `head`. */
export function packLines(parts: readonly string[], head = 'repair: ', max = REPLY_MAX): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const p of parts) {
    if (cur === '') cur = p;
    else if (cur.length + 2 + p.length <= max) cur = `${cur}; ${p}`;
    else {
      lines.push(cur);
      cur = `${head}${p}`;
    }
  }
  if (cur !== '') lines.push(cur);
  return lines;
}

/** The reply of `!repair`: one line, or two when it does not fit one. */
export function repairLines(r: RepairReport): string[] {
  if (r.reason === 'interrupted') return [`repair: stopped${r.why ? ` (${r.why})` : ''}`];
  if (!r.ok) return packLines([`repair: ${r.why ?? 'failed'}`, ...(r.fetched?.length ? [`fetched ${r.fetched.join(', ')} (carried now)`] : [])]);
  const op = r.op!;
  const shown = { ...op, result: { ...op.result, ...(r.after ? { left: r.after.left, repairCost: r.after.repairCost } : {}) } };
  const lv = r.levels?.before !== undefined && r.levels.after !== undefined ? ` (level ${r.levels.before} -> ${r.levels.after})` : '';
  const parts = [`repair: ${opLine(shown, r.paid)}${lv}`, penaltyLine(shown)];
  if (r.worn === true) parts.push('on my back again');
  if (r.worn === false) parts.push('it could not be put on again: carried');
  if (r.base) parts.push(r.base);
  if (r.fetched?.length) parts.push(`fetched ${r.fetched.join(', ')}`);
  return packLines(parts);
}

/** The chore's log line (the reply's lines joined). */
export function repairReply(r: RepairReport): string {
  return repairLines(r).join(' | ');
}

export interface RepairDeps {
  processes: ProcessManager;
  settings: Pick<RuntimeSettings, 'get'>;
  inventory: { readonly slots: readonly (ItemStack | null)[]; window(id: number): { readonly slots: readonly (ItemStack | null)[] } | undefined; rawItem?(window: number, slot: number): unknown };
  /** Every elytra to hand (the elytra controller's state: the back, the kit, loose, boxes, the home count). */
  elytra(): ElytraState | undefined;
  /** The experience level, undefined until the server sent it. */
  level(): number | undefined;
  position(): Vec3;
  home(): Vec3 | undefined;
  /** Anvils within `radius` of `origin`, nearest first. */
  anvils(origin: Vec3, radius: number): Vec3[];
  /** Units of `names` to hand: loose, in the carried boxes, in the chests at home (and whether those are in reach). */
  available(names: readonly string[]): { loose: number; boxes: number; home: number; homeInReach: boolean };
  /** Make `n` of `names` loose (boxes, then the chests at home when `home`). */
  fetch(names: readonly string[], n: number, o: { home: boolean; cancelled: () => boolean }): Promise<{ loose: number; why?: string | undefined }>;
  /** A second elytra out of a carried box (its slot, the slot inside), or out of the chests at home (ranked by uses). */
  elytraFromBox?(slot: number, inBox: number, cancelled: () => boolean): Promise<{ got: number; why: string }>;
  elytraFromHome?(rank: (st: ItemStack) => number, cancelled: () => boolean): Promise<{ got: number; why?: string | undefined }>;
  walkTo(anvil: Vec3, cancelled: () => boolean): Promise<boolean>;
  /** The anvil within reach of the feet. */
  inReach(anvil: Vec3): boolean;
  anvil: { use(at: Vec3, u: AnvilUse, predict: (target: ItemStack) => ItemStack): Promise<AnvilOutcome>; takeOff(to: number): Promise<boolean> };
  /** The elytra in player slot `from` onto the back. */
  wear(from: number): Promise<{ ok: boolean; reason?: string }>;
  isDay(): boolean;
  threat(): string | undefined;
  cancel(): void;
  idle?(): boolean;
  afterJob?(): void;
  log?: Logger;
  now?: () => number;
}

/** Where the target is. */
interface Located {
  piece: AnvilPiece;
  /** Player slot, or undefined on the back. */
  slot?: number;
  worn: boolean;
}

const pieceFrom = (it: ItemStack | null | undefined, raw: unknown): AnvilPiece | undefined => (it && it.count > 0 ? pieceOf(it, raw) : undefined);
const sameName = (a: string, b: string): boolean => a.replace(/^minecraft:/, '') === b.replace(/^minecraft:/, '');

/** One pass (see the file comment). */
export class RepairJob {
  readonly ask: RepairAsk;
  phase = 'planning';
  constructor(ask: RepairAsk) {
    this.ask = ask;
  }

  line(): string {
    return `repair ${itemWord(this.ask.item)} (${this.phase})`;
  }

  /** The target: the elytra at hand (on the back, else the kit's), or the most worn carried piece of the item. */
  locate(d: RepairDeps): Located | undefined {
    const inv = d.inventory;
    if (sameName(this.ask.item, ELYTRA)) {
      const c = d.elytra()?.current;
      if (!c) return undefined;
      return this.reread(d, c.source === 'back' ? { worn: true } : { slot: c.slot, worn: false });
    }
    let best: Located | undefined;
    inv.slots.slice(0, 36).forEach((it, i) => {
      if (!it || !sameName(it.name, this.ask.item)) return;
      const p = pieceFrom(it, inv.rawItem?.(0, i));
      if (p && (!best || p.left < best.piece.left)) best = { piece: p, slot: i, worn: false };
    });
    return best;
  }

  /** The piece at a place again (on the back, or a player slot). */
  reread(d: RepairDeps, at: { slot?: number | undefined; worn: boolean }): Located | undefined {
    const inv = d.inventory;
    if (at.worn) {
      const p = pieceFrom(inv.window(WINDOW_ARMOR)?.slots[1], inv.rawItem?.(WINDOW_ARMOR, 1));
      return p && sameName(p.name, this.ask.item) ? { piece: p, worn: true } : undefined;
    }
    if (at.slot === undefined) return undefined;
    const p = pieceFrom(inv.slots[at.slot], inv.rawItem?.(0, at.slot));
    return p && sameName(p.name, this.ask.item) ? { piece: p, slot: at.slot, worn: false } : undefined;
  }

  /** The second pieces carried loose (and, for the elytra, in the carried boxes). */
  spares(d: RepairDeps, target: Located): Spare[] {
    const inv = d.inventory;
    const out: Spare[] = [];
    inv.slots.slice(0, 36).forEach((it, i) => {
      if (i === target.slot || !it || !sameName(it.name, this.ask.item)) return;
      const p = pieceFrom(it, inv.rawItem?.(0, i));
      if (p) out.push({ piece: p, slot: i });
    });
    if (sameName(this.ask.item, ELYTRA)) {
      const max = maxDurability(ELYTRA) ?? 432;
      for (const s of d.elytra()?.spares ?? []) {
        if (s.source !== 'box' || s.slot === undefined) continue;
        const enchants = [...(s.unbreaking ? [{ id: 17, lvl: s.unbreaking }] : []), ...(s.mending ? [{ id: 26, lvl: 1 }] : [])];
        // (a boxed piece's prior-work tag is read once it is out: planned with 0)
        out.push({ piece: { name: ELYTRA, left: s.left, max, repairCost: 0, enchants }, box: { slot: s.slot, inBox: s.inBox ?? 0 } });
      }
    }
    return out;
  }

  /** The planner's input: `storage` counts the carried boxes and the chests at home in reach, else what is loose only. */
  input(d: RepairDeps, target: Located, storage: boolean): RepairInput {
    const mats = repairMaterials(this.ask.item);
    let material: RepairInput['material'];
    if (mats) {
      const a = d.available(mats);
      material = { name: mats[0]!, have: storage ? a.loose + a.boxes + (a.homeInReach ? a.home : 0) : a.loose };
    }
    const spares = this.spares(d, target);
    return { target: target.piece, ...(material ? { material } : {}), spares: storage ? spares : spares.filter((s) => s.slot !== undefined), levels: d.level(), ...(this.ask.mode ? { mode: this.ask.mode } : {}), ...(this.ask.last ? { last: true } : {}) };
  }

  async run(d: RepairDeps, cancelled: () => boolean): Promise<RepairReport> {
    const word = itemWord(this.ask.item);
    const rep: RepairReport = { ok: false, item: this.ask.item, reason: 'refused' };
    const end = (why: string, reason: RepairReport['reason'] = 'refused'): RepairReport => {
      rep.why = why;
      rep.reason = reason;
      this.phase = 'done';
      return rep;
    };
    let target = this.locate(d);
    if (!target) return end(sameName(this.ask.item, ELYTRA) ? 'no elytra on my back or carried' : maxDurability(this.ask.item) === undefined ? `a ${word} has no uses to renew` : `no ${word} carried`);
    const at = { slot: target.slot, worn: target.worn };
    let plan = planRepair(this.input(d, target, true));
    // a second elytra only in the chests at home: fetched, then planned (its uses are read at the chest)
    const es = d.elytra();
    if (!plan.ok && plan.kind === 'no_means' && this.ask.mode !== 'membranes' && sameName(this.ask.item, ELYTRA) && es && es.home > 0 && es.homeInReach && d.elytraFromHome) {
      this.phase = 'a second elytra out of the chests at home';
      const got = await d.elytraFromHome((st) => (maxDurability(ELYTRA) ?? 432) - (st.damage ?? 0), cancelled);
      if (cancelled()) return end('', 'interrupted');
      if (got.got > 0) (rep.fetched ??= []).push('an elytra out of the chests at home');
      target = this.reread(d, at) ?? target;
      plan = planRepair(this.input(d, target, true));
    }
    if (!plan.ok) return end(plan.why);
    const anvil = d.anvils(d.position(), ANVIL_NEAR)[0];
    if (!anvil) return end(`no anvil within ${ANVIL_NEAR} blocks (I never place one)`);
    const mats = repairMaterials(this.ask.item) ?? [];
    const matWord = itemWord(mats[0] ?? 'material');
    // the means into the inventory
    if (plan.kind === 'material') {
      const loose = d.available(mats).loose;
      if (loose < plan.units) {
        this.phase = `${matWord}s out of storage`;
        const r = await d.fetch(mats, plan.units, { home: true, cancelled });
        if (cancelled()) return end('', 'interrupted');
        if (r.loose > loose) (rep.fetched ??= []).push(`${r.loose - loose} ${matWord}${r.loose - loose === 1 ? '' : 's'}`);
        if (r.loose < 1) return end(`could not fetch ${matWord}s${r.why ? ` (${r.why})` : ''}`, 'failed');
      }
    } else if (plan.spare.box) {
      this.phase = 'the second elytra out of a carried box';
      const r = d.elytraFromBox ? await d.elytraFromBox(plan.spare.box.slot, plan.spare.box.inBox, cancelled) : { got: 0, why: 'no supply layer' };
      if (cancelled()) return end('', 'interrupted');
      if (r.got <= 0) return end(`the carried box gave no elytra (${r.why})`, 'failed');
      (rep.fetched ??= []).push('an elytra out of a carried box');
    }
    // the plan again on what is carried now (the true tags, the units carried)
    target = this.reread(d, at);
    if (!target) return end(`the ${word} moved meanwhile`, 'failed');
    plan = planRepair({ ...this.input(d, target, false), mode: plan.kind === 'material' ? 'membranes' : 'combine' });
    if (!plan.ok) return end(plan.why);
    // the anvil
    if (!d.inReach(anvil)) {
      this.phase = `walking to the anvil at ${anvil.x} ${anvil.y} ${anvil.z}`;
      const ok = await d.walkTo(anvil, cancelled);
      if (cancelled()) return end('', 'interrupted');
      if (!ok || !d.inReach(anvil)) return end(`could not reach the anvil at ${anvil.x} ${anvil.y} ${anvil.z}`, 'failed');
    }
    // a worn elytra comes off first (the anvil does not take from the armour slot)
    let slot = target.slot;
    const tookOff = target.worn;
    if (tookOff) {
      this.phase = 'taking the elytra off';
      const free = freeSlot(d.inventory.slots);
      if (free === undefined) return end('no free inventory slot to take the elytra off into', 'failed');
      if (!(await d.anvil.takeOff(free))) return end('could not take the elytra off', 'failed');
      slot = free;
      // (a chestplate the armour pass puts on meanwhile changes nothing: the result goes on with a swap)
    }
    if (slot === undefined) return end(`the ${word} is not in a slot`, 'failed');
    let op = plan.op;
    let input = slot;
    let material: { slot: number; count: number };
    if (plan.kind === 'material') {
      const from = largestSlot(d.inventory.slots, mats);
      if (from === undefined) return this.putBack(d, rep, tookOff, slot, end(`no ${matWord} carried`, 'failed'));
      const have = d.inventory.slots[from]!.count;
      // (one stack goes in: at most the units of the largest one)
      if (have < plan.units) op = materialOp(op.target, mats[0]!, have) ?? op;
      material = { slot: from, count: op.units ?? plan.units };
    } else {
      const s = plan.spare.slot;
      if (s === undefined) return this.putBack(d, rep, tookOff, slot, end(`the second ${word} is not carried`, 'failed'));
      if (plan.base === 'spare') {
        input = s;
        material = { slot, count: 1 };
      } else material = { slot: s, count: 1 };
      rep.base = plan.base === 'spare' ? `the base was the other one (${shortPiece(plan.spare.piece)}): ${plan.why.replace(/^the other one is the base: /, '')}` : `the base was the ${tookOff ? 'worn' : 'carried'} one: ${plan.why.replace(/^it is the base:? ?/, '')}`;
    }
    rep.op = op;
    this.phase = 'at the anvil';
    const inv = d.inventory;
    const name = inv.slots[input]?.customName;
    const paid = op;
    const r = await d.anvil.use(anvil, { input, material, ...(name !== undefined ? { name } : {}) }, (t) => {
      const pred: ItemStack = { ...t, damage: Math.max(0, paid.target.max - paid.result.left), repairCost: paid.result.repairCost };
      if (paid.result.enchants.length) pred.enchants = paid.result.enchants.map((e) => ({ ...e }));
      return pred;
    });
    rep.levels = { before: r.levelsBefore, after: r.levelsAfter };
    if (!r.ok) {
      const why =
        r.reason === 'refused'
          ? `the anvil refused it (status ${String(r.status)}: too few levels or too expensive by the server's count; planned ${op.cost} levels at level ${r.levelsBefore ?? '?'})`
          : r.reason === 'open_failed'
            ? 'the anvil did not open'
            : r.reason === 'no_anvil'
              ? 'the anvil is gone'
              : `the anvil operation failed (${r.reason ?? 'unknown'})`;
      return this.putBack(d, rep, tookOff, slot, end(`${why}${r.left ? `; left in the anvil: ${r.left}` : ''}`, 'failed'));
    }
    rep.ok = true;
    rep.reason = 'done';
    if (r.levelsBefore !== undefined && r.levelsAfter !== undefined) rep.paid = r.levelsBefore - r.levelsAfter;
    const after = pieceFrom(inv.slots[input], inv.rawItem?.(0, input));
    if (after) rep.after = after;
    d.log?.info(`repair: ${opLine(op, rep.paid)}; the server holds ${after ? pieceText(after) : 'nothing in the slot'}${r.left ? `; left in the anvil: ${r.left}` : ''}`);
    this.phase = 'done';
    return this.putBack(d, rep, tookOff, input, rep);
  }

  /** The elytra taken off goes on again (the result, or the target after a failure, in slot `slot`). */
  private async putBack(d: RepairDeps, rep: RepairReport, tookOff: boolean, slot: number, out: RepairReport): Promise<RepairReport> {
    if (!tookOff) return out;
    const it = d.inventory.slots[slot];
    if (!it || !sameName(it.name, ELYTRA)) {
      rep.worn = false;
      return out;
    }
    const w = await d.wear(slot);
    rep.worn = w.ok;
    if (!w.ok) d.log?.warn(`repair: the elytra could not be put on again (${w.reason ?? 'refused'})`);
    return out;
  }
}

/** `82/432, Mending, penalty 3`. */
function shortPiece(p: AnvilPiece): string {
  return pieceText(p).replace(/^\S+ /, '').replace(/ \((.*)\)$/, ', $1');
}

function freeSlot(slots: readonly (ItemStack | null)[]): number | undefined {
  for (let i = 9; i < 36; i++) if (!slots[i]) return i;
  for (let i = 0; i < 9; i++) if (!slots[i]) return i;
  return undefined;
}

function largestSlot(slots: readonly (ItemStack | null)[], names: readonly string[]): number | undefined {
  let best: number | undefined;
  for (let i = 0; i < 36; i++) {
    const s = slots[i];
    if (!s || s.count <= 0 || !names.some((n) => sameName(n, s.name))) continue;
    if (best === undefined || s.count > slots[best]!.count) best = i;
  }
  return best;
}

/** `!repair`: a user process around one RepairJob. */
export class RepairProcess extends BaseProcess {
  readonly kind = 'user' as const;
  readonly name = 'repair';
  readonly result: Promise<RepairReport>;
  private resolve!: (r: RepairReport) => void;
  private job: RepairJob;
  private readonly c: RepairController;

  constructor(c: RepairController, ask: RepairAsk) {
    super();
    this.c = c;
    this.job = new RepairJob(ask);
    this.result = new Promise((r) => {
      this.resolve = r;
    });
  }

  get priority(): number {
    return PRIORITY.user;
  }

  protected run(t: number): void {
    const job = new RepairJob(this.job.ask);
    this.job = job;
    void this.c.serial(() => job.run(this.c.d, () => t !== this.token)).then(
      (r) => {
        if (t !== this.token) return;
        this.finish();
        this.resolve(r);
      },
      (err: unknown) => {
        this.c.d.log?.warn(`repair: ${err instanceof Error ? err.message : String(err)}`);
        this.finish();
        this.resolve({ ok: false, item: job.ask.item, reason: 'failed', why: err instanceof Error ? err.message : String(err) });
      },
    );
  }

  protected halt(): void {
    this.c.d.cancel();
  }

  protected override onStopped(_reason: StopReason): void {
    this.resolve({ ok: false, item: this.job.ask.item, reason: 'interrupted' });
  }

  behaviour(): string {
    return this.job.line();
  }

  status(): ProcessStatus {
    return { line: this.job.line() };
  }
}

/** The background renewal (auto, PRIORITY.chore; see the file comment). Registered once; never done. */
export class RepairChore extends BaseProcess {
  readonly kind = 'auto' as const;
  readonly name = 'repair';
  private job: RepairJob | undefined;
  private lastCheck = -Infinity;
  nextTry = -Infinity;
  readonly stats = { checks: 0, started: 0, finished: 0 };
  last: RepairReport | undefined;
  lastWhy = '';
  private readonly c: RepairController;

  constructor(c: RepairController) {
    super();
    this.c = c;
    this.persistent = true;
  }

  get priority(): number {
    return PRIORITY.chore;
  }

  get running(): boolean {
    return this.job !== undefined;
  }

  /** Why the chore would not renew the elytra now (undefined: it would). */
  reason(): string | undefined {
    const d = this.c.d;
    const s = d.elytra();
    const cur = s?.current;
    if (!cur) return 'no elytra at hand';
    const tw = d.settings.get('toolWearLimit');
    if (covers(cur, tw, { uses: ELYTRA_LOW_USES })) return `the elytra has ${ELYTRA_LOW_USES} uses or more over its worn limit`;
    if (cur.mending) return 'the elytra has Mending: it is mended with experience (!mend)';
    if (d.anvils(d.position(), ANVIL_NEAR).length === 0) return `no anvil within ${ANVIL_NEAR} blocks`;
    const job = new RepairJob({ item: ELYTRA, mode: 'membranes' });
    const t = job.locate(d);
    if (!t) return 'no elytra at hand';
    const p = planRepair(job.input(d, t, true));
    return p.ok ? undefined : p.why;
  }

  override wants(): boolean {
    const d = this.c.d;
    if (this.job) return d.isDay() && !d.threat();
    const now = this.c.now();
    if (now - this.lastCheck < CHECK_MS || now < this.nextTry) return false;
    this.lastCheck = now;
    if (!d.settings.get('autoRepair')) return false;
    if (!d.isDay() || d.processes.userProcesses().length > 0 || !(d.idle?.() ?? true)) return false;
    const home = d.home();
    if (!home) {
      this.lastWhy = 'no home set';
      return false;
    }
    const me = d.position();
    if (Math.hypot(me.x - home.x, me.z - home.z) > REPAIR_HOME || d.threat()) return false;
    const cur = d.elytra()?.current;
    if (!cur || covers(cur, d.settings.get('toolWearLimit'), { uses: ELYTRA_LOW_USES })) return false;
    this.stats.checks++;
    const why = this.reason();
    if (why) {
      this.lastWhy = why;
      this.nextTry = now + REPAIR_BACKOFF_MS;
      return false;
    }
    this.job = new RepairJob({ item: ELYTRA, mode: 'membranes' });
    this.stats.started++;
    this.lastWhy = '';
    d.log?.info(`repair chore: the elytra at ${cur.left} uses: renewing it with phantom membranes`);
    return true;
  }

  drop(): void {
    if (!this.job) return;
    this.job = undefined;
    this.token++;
    if (this.controlled) this.c.d.cancel();
  }

  protected run(t: number): void {
    const job = this.job;
    if (!job) return;
    const fresh = new RepairJob(job.ask);
    this.job = fresh;
    void this.c.serial(() => fresh.run(this.c.d, () => t !== this.token || this.job !== fresh)).then(
      (r) => {
        if (this.job !== fresh || r.reason === 'interrupted') return;
        this.end(r);
      },
      (err: unknown) => {
        this.c.d.log?.warn(`repair chore: ${err instanceof Error ? err.message : String(err)}`);
        if (this.job === fresh) this.end(undefined);
      },
    );
  }

  private end(r: RepairReport | undefined): void {
    this.job = undefined;
    this.last = r;
    this.stats.finished++;
    this.nextTry = this.c.now() + (r?.ok ? CHECK_MS : REPAIR_BACKOFF_MS);
    if (r && !r.ok) this.lastWhy = r.why ?? 'failed';
    const d = this.c.d;
    d.log?.info(`repair chore: done, ${r ? repairReply(r) : 'error'}`);
    d.afterJob?.();
  }

  protected halt(): void {
    this.c.d.cancel();
  }

  protected override reset(): void {
    this.job = undefined;
  }

  behaviour(): string {
    return this.job ? `${this.job.line()} (auto)` : 'repair (auto)';
  }

  status(): ProcessStatus {
    return { line: this.behaviour() };
  }
}

/** Builds the chore, starts `!repair`, gives the status and the takeoff's hint. */
export class RepairController {
  readonly chore: RepairChore;
  readonly d: RepairDeps;
  private readonly log: Logger;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(d: RepairDeps) {
    this.d = d;
    this.log = d.log ?? silentLogger;
    this.chore = d.processes.add(new RepairChore(this));
  }

  now(): number {
    return (this.d.now ?? (() => performance.now()))();
  }

  serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** `!repair ...`. */
  repair(ask: RepairAsk): RepairProcess {
    this.chore.drop();
    return this.d.processes.add(new RepairProcess(this, ask));
  }

  /** What `!repair` would do now for the elytra (nothing moves): the plan, or why none. */
  preview(ask: RepairAsk = { item: ELYTRA }): RepairPlan | undefined {
    const job = new RepairJob(ask);
    const t = job.locate(this.d);
    return t ? planRepair(job.input(this.d, t, true)) : undefined;
  }

  /**
   * The takeoff's refusal for the elytra (chat/commands-fly.ts): `; !repair renews it at an anvil (3 phantom membranes,
   * 4 levels: 432/432)` when the renewal `!repair` would pay covers the trip; the levels it lacks when only they are
   * short; empty otherwise.
   */
  tripHint(need: ElytraNeed): string {
    try {
      const job = new RepairJob({ item: ELYTRA });
      const t = job.locate(this.d);
      if (!t) return '';
      const input = job.input(this.d, t, true);
      const p = planRepair({ ...input, last: true });
      const tw = this.d.settings.get('toolWearLimit');
      const after = (op: AnvilOp): boolean => covers({ left: op.result.left, mending: op.result.enchants.some((e) => e.id === 26), unbreaking: op.result.enchants.find((e) => e.id === 17)?.lvl ?? 0 }, tw, need);
      const how = (op: AnvilOp): string => (op.kind === 'material' ? `${op.units} phantom membrane${op.units === 1 ? '' : 's'}` : 'combined with the second elytra');
      if (p.ok) return after(p.op) ? `; !repair renews it at an anvil (${how(p.op)}, ${p.op.cost} level${p.op.cost === 1 ? '' : 's'}: ${p.op.result.left}/${p.op.target.max})` : '';
      if (p.kind === 'levels' && p.op && after(p.op)) return `; !repair at an anvil would cover it with ${p.op.cost} levels (I have ${input.levels ?? '?'})`;
      return '';
    } catch (err) {
      this.log.warn(`repair: the trip hint: ${err instanceof Error ? err.message : String(err)}`);
      return '';
    }
  }

  /** `!repair status` (one line joined). */
  statusLine(): string {
    return this.statusLines().join(' | ');
  }

  /** `!repair status`: one line, or two when it does not fit one. */
  statusLines(): string[] {
    const job = new RepairJob({ item: ELYTRA });
    const t = job.locate(this.d);
    const lv = this.d.level();
    const anvil = this.d.anvils(this.d.position(), ANVIL_NEAR)[0];
    const mats = this.d.available(repairMaterials(ELYTRA) ?? []);
    const parts: string[] = [];
    if (t) {
      const left = renewalsLeft(t.piece.repairCost);
      parts.push(`${pieceText(t.piece)}${t.worn ? ' on my back' : ' carried'}, ${left > 0 ? `${left} renewal${left === 1 ? '' : 's'} left before too expensive` : 'too expensive to renew'}`);
      const units = unitsNeeded(t.piece);
      if (units > 0) parts.push(`full with ${units} phantom membrane${units === 1 ? '' : 's'} for ${t.piece.repairCost + units} levels`);
    } else parts.push('no elytra at hand');
    parts.push(`phantom membranes ${mats.loose} carried${mats.boxes ? `, ${mats.boxes} boxed` : ''}${mats.home ? `, ${mats.home} at home` : ''}`);
    parts.push(`level ${lv ?? '?'}`);
    parts.push(anvil ? `anvil at ${anvil.x} ${anvil.y} ${anvil.z}` : `no anvil within ${ANVIL_NEAR} blocks`);
    const ch = this.chore;
    const waitS = Math.max(0, Math.ceil((ch.nextTry - this.now()) / 1000));
    parts.push(`autoRepair ${this.d.settings.get('autoRepair') ? 'on' : 'off'}${ch.running ? ', running' : waitS > 0 ? `, next look in ${waitS} s` : ''}${ch.lastWhy ? ` (${ch.lastWhy})` : ''}`);
    return packLines([`repair: ${parts[0]!}`, ...parts.slice(1)]);
  }

  dispose(): void {
    this.d.processes.stop(this.chore);
  }
}

