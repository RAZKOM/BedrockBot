// The flight-envelope harness (Track F0, docs/flight-envelope.md): a scripted control sequence (per-tick
// yaw, pitch, rocket use, hotbar slot, jump, extra input flags) flown by an e2e bot on bds-fly, the
// server's per-tick state sampled by truth:glidelog (position, velocity, the gliding / ground flags, the
// rotation of the input it follows, health, rockets near the body), and the model stepped from the
// server's state tick by tick (`compareRun`), with the client's corrections, glide flags, rocket entities,
// pose changes and the hurt log of the run.
//
// Alignment: every input's yaw carries a tag of (tick % 50) * 0.004 degrees (at most 0.2 degrees; the
// model is stepped with the same yaw, so the tag is part of the input, not noise); a server sample is
// matched to the input whose yaw and pitch it reports. Two inputs the server took in one of its ticks
// leave a gap (the pair is skipped).
import type { Vec3 } from '../../src/connection/types.ts';
import { skyQuery } from '../../src/skills/fly/controller.ts';
import { stepBody } from '../../src/skills/input/physics.ts';
import type { BlockQuery, BodyState, CorrectionEvent, InputLoopState, MoveCommand } from '../../src/skills/input/index.ts';
import { WINDOW_OFFHAND } from '../../src/world/inventory.ts';
import { wireItemOf } from '../../src/skills/place/place.ts';
import { useItemTransaction } from '../../src/skills/survival/eat.ts';
import { FEET_Y, hdist, sleep, type FlyBot } from './fly-truth.ts';
import type { HurtRecord } from './pve-truth.ts';

/** One tick of a script. */
export interface Ctl {
  yaw: number;
  pitch: number;
  /** Use a firework rocket this tick: from the selected hotbar slot (`true` / 'main'), or the offhand ('offhand': hand off_hand), or 'offhand-main' (the main-hand transaction with the offhand item). */
  fire?: boolean | 'main' | 'offhand' | 'offhand-main';
  /** The hotbar slot to fire from (selected first when another is selected). Default: the first slot with rockets. */
  fireSlot?: number;
  /** Select this hotbar slot this tick (mob_equipment). */
  select?: number;
  jump?: boolean;
  /** The glide wanted (default true). */
  glide?: boolean;
  forward?: number;
  sprint?: boolean;
  sneak?: boolean;
  /** Extra input_data flags for this tick only (e.g. start_gliding on a jump tick). */
  flags?: string[];
  /** Free label for the analysis (the phase). */
  mark?: string;
}

export interface ScriptCtx {
  /** The loop's state before this tick (after the previous one). */
  st: InputLoopState;
  /** Ticks since the script started (0 = the first). */
  i: number;
  /** The server confirmed the glide (the gliding flag) in this run. */
  glideConfirmed: boolean;
  /** Ticks since the glide was confirmed (undefined before). */
  sinceGlide: number | undefined;
  /** Ticks since the last rocket entity was removed (undefined: none removed). */
  sinceRocketGone: number | undefined;
  /** Rocket entities alive (added, not removed). */
  rocketsAlive: number;
  /** Local horizontal speed. */
  h: number;
  /** Mutable per-run scratch for the script. */
  mem: Record<string, number | boolean | string | undefined>;
}

/** The script: the control for tick `i`, or undefined when done. */
export type Script = (c: ScriptCtx) => Ctl | undefined;

export interface TickRec {
  /** The input tick. */
  tick: number;
  i: number;
  ctl: Ctl;
  /** The yaw sent (with the alignment tag). */
  yaw: number;
  fired: boolean;
  /** The loop's prediction after this tick (as predicted then, before any later correction). */
  local?: { pos: Vec3; vel: Vec3; gliding: boolean; boostTicks: number; onGround: boolean };
}

export interface ServerSample {
  tick: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  gliding: boolean;
  ground: boolean;
  pitch: number;
  yaw: number;
  hp: number | null;
  fw: number;
}

export interface RocketRec {
  uniqueId: string;
  /** Input tick when the add_entity arrived. */
  addedAt: number;
  removedAt?: number;
  /** The fire tick it belongs to (the last use before it, within 10 ticks). */
  firedAt?: number;
  metadata?: unknown;
  /** The add_entity packet's other fields (velocity, position). */
  add?: Record<string, unknown>;
}

export interface RunRec {
  name: string;
  ticks: TickRec[];
  corrections: CorrectionEvent[];
  glides: { tick: number; at: number; gliding: boolean; refused?: true }[];
  rockets: RocketRec[];
  pose: { at: number; crawling?: boolean; swimming?: boolean; height?: number }[];
  motions: { at: number; v: Vec3 }[];
  server: ServerSample[];
  hurt: HurtRecord[];
  serverTick0: number;
  /** The yaw tag's step (degrees a tick). */
  tagStep: number;
  /** The truth state after the run's settle (before parking). */
  end?: { location: Vec3; isGliding: boolean; isOnGround: boolean; health: number | null };
}

const TAG_STEP = 0.004;
export const yawTag = (tick: number): number => (tick % 50) * TAG_STEP;

function wrap180(a: number): number {
  return ((((a + 180) % 360) + 360) % 360) - 180;
}

export interface RunOptions {
  /** Feet position to teleport to (the run starts in the air). */
  start: Vec3;
  yaw?: number;
  script: Script;
  /** Safety cap. Default 1200. */
  maxTicks?: number;
  /** Ticks after the script before reading the logs (the glide flag / remove_entity / hurt). Default 10. */
  settle?: number;
  /** The control during the settle (default: the script's last). */
  settleCtl?: Ctl;
  /** Skip the yaw alignment tag. */
  noTag?: boolean;
  /** The tag's step (default 0.004 degrees; 0.0005 keeps a precise line: 0.025 degrees at most). */
  tagStep?: number;
  /** Park on the ground at this feet position afterwards (default: the start column on the flat ground). */
  park?: Vec3 | false;
  /** Rockets put into hotbar slot 0 before the run (default 64; 0 = leave the inventory). */
  rockets?: number;
}

/**
 * Fly one script. Before: health 20, a fresh elytra in the chest slot, `rockets` rockets in hotbar slot 0
 * (selected), the glide log on. The teleport puts the body in the air at `start`; the script's first tick
 * follows the loop's adoption of the teleport.
 */
export async function runScript(bot: FlyBot, name: string, o: RunOptions): Promise<RunRec> {
  const mob = bot.built.mobility!;
  const loop = mob.loop;
  const inv = mob.world.inventory;
  const hotbar = bot.task.pve!.hotbar;
  const conn = bot.conn;
  const base = loop.world;
  await bot.truth.setHealth(bot.name, 20);
  await bot.truth.equip(bot.name, 'Chest', 'elytra');
  if ((o.rockets ?? 64) > 0) {
    await bot.truth.setslot(bot.name, 0, 'firework_rocket', o.rockets ?? 64);
    await waitUntil(() => inv.slots[0]?.name === 'firework_rocket' && inv.slots[0]?.count === (o.rockets ?? 64), 5000);
  }
  await waitUntil(() => inv.window(120)?.slots[1]?.name === 'elytra', 5000);
  if (inv.selected !== 0) hotbar.select(0);
  const serverTick0 = await bot.truth.now();
  await bot.truth.ok('glidelog', ['start', bot.name]);
  await bot.truth.tp(bot.name, o.start, o.yaw ?? 0, 0);
  await waitUntil(() => hdist(loop.state.pos, o.start) < 0.05 && Math.abs(loop.state.pos.y - o.start.y) < 0.5, 10_000);

  const tagStep = o.tagStep ?? TAG_STEP;
  const rec: RunRec = { name, ticks: [], corrections: [], glides: [], rockets: [], pose: [], motions: [], server: [], hurt: [], serverTick0, tagStep };
  const byTick = new Map<number, TickRec>();
  let lastFire: number | undefined;
  let rocketGoneAt: number | undefined;
  let confirmedAt: number | undefined;
  let extraFlags: string[] | undefined;
  const mem: ScriptCtx['mem'] = {};
  let i = 0;
  let doneResolve: () => void = () => undefined;
  const done = new Promise<void>((r) => {
    doneResolve = r;
  });
  let finished = false;
  let lastCtl: Ctl = { yaw: o.yaw ?? 0, pitch: 0 };
  const unsubs: (() => void)[] = [];
  loop.world = skyQuery(base);
  loop.setTickExtras((tick) => {
    if (!extraFlags) return undefined;
    const f = extraFlags;
    extraFlags = undefined;
    void tick;
    return { input_data: f };
  });
  const apply = (ctl: Ctl, tick: number, script: boolean): boolean => {
    const yaw = ctl.yaw + (o.noTag ? 0 : (tick % 50) * tagStep);
    loop.setCommand({ yaw, pitch: ctl.pitch, jump: ctl.jump ?? false, glide: ctl.glide ?? true, forward: ctl.forward ?? 0, strafe: 0, sprint: ctl.sprint ?? false, sneak: ctl.sneak ?? false });
    if (ctl.select !== undefined && inv.selected !== ctl.select) hotbar.select(ctl.select);
    if (ctl.flags) extraFlags = [...ctl.flags];
    let fired = false;
    if (ctl.fire) {
      const feet = loop.state.pos;
      const eye = { x: feet.x, y: feet.y + 1.62, z: feet.z };
      if (ctl.fire === 'offhand' || ctl.fire === 'offhand-main') {
        const off = inv.window(WINDOW_OFFHAND)?.slots[0];
        const held = wireItemOf(off, inv.rawItem(WINDOW_OFFHAND, 0));
        const t = useItemTransaction({ hotbarSlot: inv.selected, held, eye }) as { transaction: { transaction_data: Record<string, unknown> } };
        if (ctl.fire === 'offhand') t.transaction.transaction_data.hand = 'off_hand';
        conn.queue('inventory_transaction' as never, t as never);
      } else {
        const slot = ctl.fireSlot ?? inv.slots.slice(0, 9).findIndex((s) => s?.name === 'firework_rocket');
        if (slot >= 0) {
          if (inv.selected !== slot) hotbar.select(slot);
          const held = wireItemOf(inv.slots[slot], inv.rawItem(0, slot) ?? hotbar.rawItem(slot));
          conn.queue('inventory_transaction' as never, useItemTransaction({ hotbarSlot: slot, held, eye }) as never);
        }
      }
      loop.boost();
      fired = true;
      lastFire = tick;
    }
    if (script) {
      const r: TickRec = { tick, i, ctl, yaw, fired };
      rec.ticks.push(r);
      byTick.set(tick, r);
    }
    return fired;
  };
  unsubs.push(
    loop.onBeforeStep((tickB, st) => {
      const tick = Number(tickB);
      const prev = byTick.get(Number(st.tick));
      if (prev && !prev.local) prev.local = { pos: { ...st.pos }, vel: { ...st.vel }, gliding: st.gliding, boostTicks: st.boostTicks, onGround: st.onGround };
      if (finished) return;
      const alive = rec.rockets.filter((r) => r.removedAt === undefined).length;
      const ctl = i < (o.maxTicks ?? 1200)
        ? o.script({ st, i, glideConfirmed: confirmedAt !== undefined, sinceGlide: confirmedAt === undefined ? undefined : tick - confirmedAt, sinceRocketGone: rocketGoneAt === undefined ? undefined : tick - rocketGoneAt, rocketsAlive: alive, h: Math.hypot(st.vel.x, st.vel.z), mem })
        : undefined;
      if (!ctl) {
        finished = true;
        apply(o.settleCtl ?? { ...lastCtl, fire: false, select: undefined, flags: undefined }, tick, false);
        doneResolve();
        return;
      }
      lastCtl = ctl;
      apply(ctl, tick, true);
      i++;
    }),
    loop.onEvent((e) => {
      if (e.kind === 'correction') rec.corrections.push(e);
      if (e.kind === 'glide') {
        rec.glides.push({ tick: Number(e.tick), at: Number(loop.state.tick), gliding: e.gliding, ...(e.refused ? { refused: true as const } : {}) });
        if (e.gliding && confirmedAt === undefined) confirmedAt = Number(loop.state.tick);
      }
      if (e.kind === 'motion') rec.motions.push({ at: Number(loop.state.tick), v: e.velocity });
    }),
    (conn as unknown as { on(n: string, f: (p: unknown) => void): () => void }).on('add_entity', (p) => {
      const a = p as { entity_type?: string; unique_id?: bigint | number; runtime_id?: bigint | number; metadata?: unknown; position?: Vec3; velocity?: Vec3 };
      if (a.entity_type !== 'minecraft:fireworks_rocket') return;
      const at = Number(loop.state.tick);
      const r: RocketRec = { uniqueId: String(a.unique_id), addedAt: at, metadata: a.metadata, add: { position: a.position, velocity: a.velocity, runtime_id: String(a.runtime_id) } };
      if (lastFire !== undefined && at - lastFire <= 10) r.firedAt = lastFire;
      rec.rockets.push(r);
    }),
    (conn as unknown as { on(n: string, f: (p: unknown) => void): () => void }).on('remove_entity', (p) => {
      const id = String((p as { entity_id_self?: bigint | number }).entity_id_self);
      const r = rec.rockets.find((x) => x.uniqueId === id);
      if (!r) return;
      r.removedAt = Number(loop.state.tick);
      rocketGoneAt = r.removedAt;
      // the model's boost ends with the last live rocket (the controller's rule)
      if (rec.rockets.every((x) => x.removedAt !== undefined)) loop.endBoost();
    }),
    (conn as unknown as { on(n: string, f: (p: unknown) => void): () => void }).on('set_entity_data', (p) => {
      const d = p as { runtime_entity_id: bigint | number; metadata?: { key?: string; value?: unknown }[] };
      if (BigInt(d.runtime_entity_id) !== conn.runtimeId) return;
      const flags = d.metadata?.find((m) => m.key === 'flags')?.value as { crawling?: boolean; swimming?: boolean } | undefined;
      const h = d.metadata?.find((m) => m.key === 'boundingbox_height')?.value;
      if (flags || typeof h === 'number') rec.pose.push({ at: Number(loop.state.tick), crawling: flags?.crawling, swimming: flags?.swimming, height: typeof h === 'number' ? h : undefined });
    }),
  );
  try {
    await Promise.race([done, sleep(((o.maxTicks ?? 1200) + 200) * 50 + 20_000)]);
    finished = true;
    await loop.waitTicks(o.settle ?? 10);
    const g = await bot.truth.glide(bot.name);
    rec.end = { location: g.location, isGliding: g.isGliding, isOnGround: g.isOnGround, health: g.health };
  } finally {
    for (const u of unsubs) u();
    loop.setTickExtras(undefined);
  }
  const serverTick1 = await bot.truth.now();
  for (let from = serverTick0; from <= serverTick1; from += 800) {
    const r = await bot.truth.ok<{ entries: ServerSample[] }>('glidelog', ['read', from, Math.min(from + 799, serverTick1)], 30_000);
    rec.server.push(...r.entries);
  }
  rec.hurt = (await bot.truth.hurtlog(serverTick0, bot.name)).events.filter((e) => e.victimName === bot.name);
  await bot.truth.ok('glidelog', ['stop']);
  if (o.park !== false) {
    const park = o.park ?? { x: o.start.x, y: FEET_Y, z: o.start.z };
    loop.setCommand({ glide: false, jump: false, forward: 0, pitch: 0, sneak: false, sprint: false });
    await bot.truth.tp(bot.name, park, 0, 0);
    await waitUntil(() => hdist(loop.state.pos, park) < 0.05, 10_000).catch(() => undefined);
    await loop.waitTicks(10);
  }
  loop.world = base;
  return rec;
}

async function waitUntil(fn: () => boolean, ms: number): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await sleep(25);
  }
}

// ---- analysis ---------------------------------------------------------------------------------

export interface Aligned {
  tick: number;
  s: ServerSample;
}

/**
 * The server samples matched to input ticks (the first sample of each input). A sample reports the
 * rotation of the input BEFORE the one its position follows (measured: the sample whose yaw tag is
 * input t's sits exactly on the model's position after input t + 1, 0.00001 in a steady glide), so a
 * sample whose rotation matches input t belongs to input t + 1.
 */
export const ROTATION_LAG = 1;

export function align(run: RunRec): Aligned[] {
  const ticks = run.ticks;
  const out: Aligned[] = [];
  const tol = (run.tagStep ?? TAG_STEP) / 3;
  let j = 0;
  const seen = new Set<number>();
  for (const s of run.server) {
    // forward search from the last match (at most 12 inputs ahead; the first match anywhere)
    const lim = out.length === 0 ? ticks.length : Math.min(ticks.length, j + 12);
    for (let k = j; k < lim; k++) {
      const t = ticks[k]!;
      const next = ticks[k + ROTATION_LAG];
      if (next?.tick !== t.tick + ROTATION_LAG) continue;
      // (the position check keeps a sample from before the run off an input with the same tag)
      const near = !next.local || Math.hypot(next.local.pos.x - s.x, next.local.pos.y - s.y, next.local.pos.z - s.z) < 3;
      if (near && Math.abs(wrap180(s.yaw - t.yaw)) < tol && Math.abs(s.pitch - t.ctl.pitch) < 0.0015) {
        if (!seen.has(next.tick)) {
          out.push({ tick: next.tick, s });
          seen.add(next.tick);
        }
        j = k;
        break;
      }
    }
  }
  return out;
}

export interface TickCompare {
  tick: number;
  i: number;
  mark?: string;
  /** Position error of the model stepped from the server's previous state (the better boost variant while unsure). */
  err: number;
  /** Velocity error, same step. */
  verr: number;
  /** The boosted variant fitted better (only judged while gliding). */
  boosted: boolean;
  /** The error of the other variant (how sure the boost call is). */
  errOther: number;
  server: ServerSample;
  model: { pos: Vec3; vel: Vec3; gliding: boolean; onGround: boolean };
}

/**
 * Step the model from each matched server sample with the next input and compare with the next sample.
 * The start velocity is the server's position delta over the input before (the model's end-of-tick
 * velocity is the move it made; getVelocity is rounded to the position's float32 grid) when that input
 * has a sample and moved freely, else getVelocity.
 */
export function compareRun(run: RunRec, world: BlockQuery): TickCompare[] {
  const al = align(run);
  const at = new Map(al.map((a) => [a.tick, a.s]));
  const byTick = new Map(run.ticks.map((t) => [t.tick, t]));
  const out: TickCompare[] = [];
  const sky = skyQuery(world);
  for (let k = 1; k < al.length; k++) {
    const a = al[k - 1]!;
    const b = al[k]!;
    if (b.tick !== a.tick + 1) continue;
    const t = byTick.get(b.tick)!;
    const p0 = at.get(a.tick - 1);
    const vel = p0 && !a.s.ground && !p0.ground && a.s.gliding ? { x: a.s.x - p0.x, y: a.s.y - p0.y, z: a.s.z - p0.z } : { x: a.s.vx, y: a.s.vy, z: a.s.vz };
    const prev: BodyState = {
      pos: { x: a.s.x, y: a.s.y, z: a.s.z },
      vel,
      onGround: a.s.ground,
      collidedHorizontally: false,
      collidedVertically: false,
      jumpTicks: 0,
      sprinting: false,
      sneaking: false,
      gliding: a.s.gliding,
      boostTicks: 0,
    };
    const cmd: MoveCommand = { forward: t.ctl.forward ?? 0, strafe: 0, yaw: t.yaw, pitch: t.ctl.pitch, jump: t.ctl.jump ?? false, sneak: t.ctl.sneak ?? false, sprint: t.ctl.sprint ?? false, glide: t.ctl.glide ?? true };
    const no = stepBody(prev, cmd, sky).state;
    const yes = a.s.gliding ? stepBody({ ...prev, boostTicks: 1 }, cmd, sky).state : no;
    const e = (m: BodyState) => Math.hypot(m.pos.x - b.s.x, m.pos.y - b.s.y, m.pos.z - b.s.z);
    const ev = (m: BodyState) => Math.hypot(m.vel.x - b.s.vx, m.vel.y - b.s.vy, m.vel.z - b.s.vz);
    const en = e(no) + ev(no);
    const ey = e(yes) + ev(yes);
    const boosted = a.s.gliding && ey < en;
    const m = boosted ? yes : no;
    out.push({
      tick: b.tick,
      i: t.i,
      ...(t.ctl.mark ? { mark: t.ctl.mark } : {}),
      err: e(m),
      verr: ev(m),
      boosted,
      errOther: boosted ? e(no) : e(yes),
      server: b.s,
      model: { pos: m.pos, vel: m.vel, gliding: m.gliding ?? false, onGround: m.onGround },
    });
  }
  return out;
}

/**
 * The server's burns: runs of ticks where the boost call is sure (the better variant within 0.003, the
 * other at least 5 times off), bridged over missing or unsure ticks (at most 3). `exact`: the ticks just
 * before `from` and just after `to` are sure unboosted calls, so the length is exact; else it is within
 * the gap.
 */
export function boostRuns(cmp: TickCompare[]): { from: number; to: number; ticks: number; gap: boolean }[] {
  const sure = cmp.filter((c) => c.err < 0.003 && c.errOther > 5 * Math.max(c.err, 0.002));
  const out: { from: number; to: number; ticks: number; gap: boolean }[] = [];
  let cur: { from: number; to: number; ticks: number; gap: boolean } | undefined;
  let prev: TickCompare | undefined;
  for (const c of sure) {
    if (c.boosted) {
      if (cur && c.tick - cur.to <= 4 && !(prev && !prev.boosted && prev.tick > cur.to)) {
        cur.to = c.tick;
        cur.ticks = cur.to - cur.from + 1;
      } else {
        cur = { from: c.tick, to: c.tick, ticks: 1, gap: !(prev && !prev.boosted && prev.tick === c.tick - 1) };
        out.push(cur);
      }
    } else if (cur && cur.to === prev?.tick && prev.boosted) {
      if (c.tick !== cur.to + 1) cur.gap = true;
      cur = undefined;
    }
    prev = c;
  }
  if (cur) cur.gap = true;
  return out;
}

export interface RunSummary {
  name: string;
  ticks: number;
  matched: number;
  compared: number;
  /** Max / mean per-tick position error of the model from the server's state, over the marked ticks (all when no mark is given). */
  maxErr: number;
  meanErr: number;
  over001: number;
  over01: number;
  corrections: number;
  maxCorrection: number;
  damage: number;
  causes: string[];
  glideEnded: boolean;
  end?: RunRec['end'];
}

export function summarize(run: RunRec, cmp: TickCompare[], mark?: string): RunSummary {
  const sel = mark ? cmp.filter((c) => c.mark === mark) : cmp;
  const errs = sel.map((c) => c.err);
  const ticks = new Set(run.ticks.filter((t) => !mark || t.ctl.mark === mark).map((t) => t.tick));
  const cors = run.corrections.filter((c) => ticks.has(Number(c.tick)));
  return {
    name: run.name,
    ticks: ticks.size,
    matched: align(run).length,
    compared: sel.length,
    maxErr: errs.length ? Math.max(...errs) : NaN,
    meanErr: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : NaN,
    over001: errs.filter((e) => e > 0.001).length,
    over01: errs.filter((e) => e > 0.01).length,
    corrections: cors.length,
    maxCorrection: cors.reduce((a, c) => Math.max(a, c.error ?? 0), 0),
    damage: run.hurt.reduce((a, h) => a + h.damage, 0),
    causes: [...new Set(run.hurt.map((h) => h.cause))],
    glideEnded: run.glides.some((g) => !g.gliding && !g.refused),
    ...(run.end ? { end: run.end } : {}),
  };
}

/** Horizontal speed of a server sample. */
export const sh = (s: ServerSample): number => Math.hypot(s.vx, s.vz);

/** The server sample matched to input tick `tick` (undefined when that input had none). */
export function sampleAt(run: RunRec, tick: number): ServerSample | undefined {
  return align(run).find((a) => a.tick === tick)?.s;
}

/** The matched server samples by input tick. */
export function serverByTick(run: RunRec): Map<number, ServerSample> {
  return new Map(align(run).map((a) => [a.tick, a.s]));
}

export interface LoopPoint {
  tick: number;
  model: BodyState;
  server?: ServerSample;
}

/**
 * The model flown open loop from the server's state at input `from` (velocity from the position delta
 * over the input before) with the recorded inputs up to `to` (default: the last scripted tick). Rockets:
 * a fire boosts from its tick for `burns.get(fireTick)` ticks (default 15, the model's nominal).
 */
export function openLoop(run: RunRec, world: BlockQuery, from: number, o: { to?: number; burns?: Map<number, number> } = {}): LoopPoint[] {
  const at = serverByTick(run);
  const s0 = at.get(from);
  const sp = at.get(from - 1);
  if (!s0) return [];
  const sky = skyQuery(world);
  let body: BodyState = {
    pos: { x: s0.x, y: s0.y, z: s0.z },
    vel: sp && !s0.ground ? { x: s0.x - sp.x, y: s0.y - sp.y, z: s0.z - sp.z } : { x: s0.vx, y: s0.vy, z: s0.vz },
    onGround: s0.ground,
    collidedHorizontally: false,
    collidedVertically: false,
    jumpTicks: 0,
    sprinting: false,
    sneaking: false,
    gliding: s0.gliding,
    boostTicks: 0,
  };
  const out: LoopPoint[] = [{ tick: from, model: body, server: s0 }];
  const to = o.to ?? run.ticks.at(-1)!.tick;
  for (const t of run.ticks) {
    if (t.tick <= from || t.tick > to) continue;
    const cmd: MoveCommand = { forward: t.ctl.forward ?? 0, strafe: 0, yaw: t.yaw, pitch: t.ctl.pitch, jump: t.ctl.jump ?? false, sneak: t.ctl.sneak ?? false, sprint: t.ctl.sprint ?? false, glide: t.ctl.glide ?? true };
    if (t.fired) cmd.boostStart = o.burns?.get(t.tick) ?? 15;
    body = stepBody(body, cmd, sky).state;
    out.push({ tick: t.tick, model: body, server: at.get(t.tick) });
  }
  return out;
}

export interface PresimPoint {
  i: number;
  ctl: Ctl;
  state: BodyState;
}

/**
 * The script flown offline on the model from a standstill at `start` (the teleport), the way runScript
 * flies it: the glide confirmed `confirmLag` ticks after the model starts it, a rocket burning
 * `boostTicks` and its entity gone `removeLag` ticks after that. For placing structures where a
 * deterministic script will meet them (no rocket: the model matches the server within 1e-4 a tick).
 */
export function presim(script: Script, start: Vec3, world: BlockQuery, o: { maxTicks?: number; confirmLag?: number; boostTicks?: number; removeLag?: number } = {}): PresimPoint[] {
  const sky = skyQuery(world);
  let body: BodyState = { pos: { ...start }, vel: { x: 0, y: 0, z: 0 }, onGround: false, collidedHorizontally: false, collidedVertically: false, jumpTicks: 0, sprinting: false, sneaking: false, gliding: false, boostTicks: 0 };
  const mem: ScriptCtx['mem'] = {};
  const out: PresimPoint[] = [];
  let glidingSince: number | undefined;
  let boostEnd: number | undefined;
  for (let i = 0; i < (o.maxTicks ?? 1200); i++) {
    const st: InputLoopState = { pos: body.pos, vel: body.vel, onGround: body.onGround, collidedHorizontally: body.collidedHorizontally, collidedVertically: body.collidedVertically, corrections: 0, motions: 0, sprinting: body.sprinting, inWater: false, inLava: false, gliding: body.gliding ?? false, boostTicks: body.boostTicks ?? 0, teleports: 0, tick: BigInt(i), ready: true };
    const confirmed = glidingSince !== undefined && i - glidingSince >= (o.confirmLag ?? 2);
    const gone = boostEnd !== undefined && i >= boostEnd + (o.removeLag ?? 3);
    const ctl = script({ st, i, glideConfirmed: confirmed, sinceGlide: confirmed ? i - glidingSince! - (o.confirmLag ?? 2) : undefined, sinceRocketGone: gone ? i - boostEnd! - (o.removeLag ?? 3) : undefined, rocketsAlive: (body.boostTicks ?? 0) > 0 || (boostEnd !== undefined && !gone) ? 1 : 0, h: Math.hypot(body.vel.x, body.vel.z), mem });
    if (!ctl) break;
    const cmd: MoveCommand = { forward: ctl.forward ?? 0, strafe: 0, yaw: ctl.yaw, pitch: ctl.pitch, jump: ctl.jump ?? false, sneak: ctl.sneak ?? false, sprint: ctl.sprint ?? false, glide: ctl.glide ?? true };
    if (ctl.fire) cmd.boostStart = o.boostTicks ?? 15;
    const wasBoost = (body.boostTicks ?? 0) > 0 || cmd.boostStart !== undefined;
    body = stepBody(body, cmd, sky).state;
    if (body.gliding && glidingSince === undefined) glidingSince = i;
    if (wasBoost && (body.boostTicks ?? 0) === 0) boostEnd = i;
    out.push({ i, ctl, state: body });
  }
  return out;
}

export interface BoostCall {
  tick: number;
  boosted: boolean;
  /** The chosen pattern's position error at the sample that closed the span. */
  err: number;
  /** The best other pattern's error (how sure the call is). */
  other: number;
  /** The tick had no sample of its own (inferred across a gap). */
  inferred: boolean;
}

/**
 * Per input tick: did the server boost? The matched samples are walked in order; across each span of
 * 1 to 4 inputs to the next sample every boost pattern a burn can make (none, all, a start or an end
 * inside) is stepped on the model from the state at the span's start, and the one closest to the next
 * sample wins. The velocity at a sample is its position delta when the input before has a sample, else
 * the chosen model step's (the model matches a clean tick within 1e-4).
 */
export function inferBoosts(run: RunRec, world: BlockQuery): BoostCall[] {
  const al = align(run);
  const at = new Map(al.map((a) => [a.tick, a.s]));
  const byTick = new Map(run.ticks.map((t) => [t.tick, t]));
  const sky = skyQuery(world);
  const out: BoostCall[] = [];
  let vel: Vec3 | undefined;
  for (let k = 0; k + 1 < al.length; k++) {
    const a = al[k]!;
    const b = al[k + 1]!;
    const p0 = at.get(a.tick - 1);
    if (p0 && !a.s.ground) vel = { x: a.s.x - p0.x, y: a.s.y - p0.y, z: a.s.z - p0.z };
    const span = b.tick - a.tick;
    if (!vel || span < 1 || span > 4 || !a.s.gliding) {
      vel = undefined;
      continue;
    }
    const patterns: boolean[][] = [];
    for (let j = 0; j <= span; j++) {
      patterns.push(Array.from({ length: span }, (_x, i) => i < j)); // B^j N^(span-j): an end inside
      if (j > 0 && j < span) patterns.push(Array.from({ length: span }, (_x, i) => i >= j)); // N^j B^(span-j): a start inside
    }
    let best: { e: number; pat: boolean[]; vel: Vec3 } | undefined;
    let second = Infinity;
    for (const pat of patterns) {
      let body: BodyState = { pos: { x: a.s.x, y: a.s.y, z: a.s.z }, vel: { ...vel }, onGround: false, collidedHorizontally: false, collidedVertically: false, jumpTicks: 0, sprinting: false, sneaking: false, gliding: true, boostTicks: 0 };
      let ok = true;
      for (let i = 0; i < span; i++) {
        const t = byTick.get(a.tick + 1 + i);
        if (!t) {
          ok = false;
          break;
        }
        const cmd: MoveCommand = { forward: 0, strafe: 0, yaw: t.yaw, pitch: t.ctl.pitch, jump: t.ctl.jump ?? false, sneak: false, sprint: false, glide: t.ctl.glide ?? true };
        body = stepBody({ ...body, boostTicks: pat[i] ? 1 : 0 }, cmd, sky).state;
      }
      if (!ok) break;
      const e = Math.hypot(body.pos.x - b.s.x, body.pos.y - b.s.y, body.pos.z - b.s.z);
      if (!best || e < best.e) {
        if (best) second = Math.min(second, best.e);
        best = { e, pat, vel: body.vel };
      } else second = Math.min(second, e);
    }
    if (!best) {
      vel = undefined;
      continue;
    }
    for (let i = 0; i < span; i++) out.push({ tick: a.tick + 1 + i, boosted: best.pat[i]!, err: best.e, other: second, inferred: i < span - 1 });
    vel = best.vel;
  }
  return out;
}

/** Burns from inferBoosts: runs of boosted ticks; `sure` when every call in it and its two edges was clear (the error under 0.003, the other pattern 5 times off). */
export function burnRuns(calls: BoostCall[]): { from: number; to: number; ticks: number; sure: boolean }[] {
  const out: { from: number; to: number; ticks: number; sure: boolean }[] = [];
  const clear = (c: BoostCall | undefined) => c !== undefined && c.err < 0.003 && c.other > 5 * Math.max(c.err, 0.002);
  let cur: { from: number; to: number; ticks: number; sure: boolean } | undefined;
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i]!;
    const prev = calls[i - 1];
    const contiguous = prev?.tick === c.tick - 1;
    if (c.boosted) {
      if (cur && contiguous && prev.boosted) {
        cur.to = c.tick;
        cur.ticks = cur.to - cur.from + 1;
        cur.sure &&= clear(c);
      } else {
        cur = { from: c.tick, to: c.tick, ticks: 1, sure: clear(c) && contiguous && clear(prev) };
        out.push(cur);
      }
    } else if (cur && contiguous && prev.boosted) {
      cur.sure &&= clear(c);
      cur = undefined;
    } else if (cur && !contiguous) {
      cur.sure = false;
      cur = undefined;
    }
  }
  if (cur) cur.sure = false;
  return out;
}
