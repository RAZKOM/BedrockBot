// dig(p) (PLAN.md tasks 4.1 and 4.2): server-authoritative block breaking through
// `player_auth_input.block_action` on BDS 1.26.51. Per tick, driven by the input loop's extras hook:
//
//   aim      select the tool slot (mob_equipment), turn to the block; wait out the break cooldown
//   tick 0   [start_break(p, face)]                    + input flag 'block_action'
//   1..N-1   [continue_break(p, face)]
//   N        [predict_break(p, face), stop_break(p, face)]   (N = the break-time table)
//   then     nothing; wait for update_block at p (not the original block) until ceil(1.5 N) ticks
//            after tick 0, else abort_break and { ok: false, reason: 'timeout' }
//   broken   [abort_break(p, face)] on the next tick ("button released"; see below)
//   cancel() [abort_break(p, face)] on the next tick, { ok: false, reason: 'interrupted' }
//
// Measured on BDS 1.26.51 (docs/digging.md): the server runs its own break timer from start_break
// and removes the block when it completes, even without continue/predict; an early predict_break is
// answered with an update_block restoring the block, and the server still finishes on time. The
// server keeps mining the position (like a held mouse button) until abort_break: without it, a block
// placed there later is broken immediately and the next dig there finishes early.
import type { Vec3 } from '../../connection/types.ts';
import { blockMining, toolOf } from '../../data/mining.ts';
import { silentLogger, type Logger } from '../../log.ts';
import type { BlockInfo, ItemStack } from '../../world/types.ts';
import type { TickExtrasProvider } from '../input/inputLoop.ts';
import type { SkillResult } from '../types.ts';
import { estimateBreak, type BreakConditions } from './breakTime.ts';
import { EYE_HEIGHT, blockCenter, checkReach, faceToward, lookAngles, type Face } from './look.ts';
import { HOTBAR_SIZE } from './tools.ts';
import { bestTool } from '../nav/baritone/helper.ts'; // Track BB: the shared break rule set's tool choice (Baritone ToolSet.getBestSlot)

/** Survival delay between two breaks (250 ms, Minecraft Wiki "Breaking" / Mojang build-action guide). */
export const BREAK_COOLDOWN_TICKS = 5;
/** Timeout factor from PLAN.md 4.1. */
export const TIMEOUT_FACTOR = 1.5;
/** Floor for the timeout so near-instant blocks still get a round trip (1.5 N >= N + 4 from N = 8 on). */
export const MIN_TIMEOUT_SLACK = 4;

/** The parts of InputLoop the digger uses. */
export interface DigLoop {
  readonly state: { pos: Vec3; tick: bigint; ready: boolean };
  setCommand(c: { yaw?: number; pitch?: number }): void;
  setTickExtras(fn: TickExtrasProvider | undefined): void;
}

/** The parts of World the digger uses. */
export interface DigWorld {
  blockAt(p: Vec3): BlockInfo | undefined;
  onBlockUpdate(fn: (p: Vec3, before: BlockInfo | undefined, after: BlockInfo) => void): () => void;
  readonly inventory: { readonly slots: readonly (ItemStack | null)[]; readonly selected: number };
}

/** Hotbar slot switching (world/hotbar.ts). */
export interface SlotSelector {
  select(slot: number): boolean;
}

export interface DigOptions {
  /** 'best' (default) = chooseTool over the hotbar; a number = use that hotbar slot; 'current' = no switch. */
  tool?: 'best' | 'current' | number;
  /** Block face to report; default the face seen from the eye. */
  face?: Face;
  /** Own reach (eye to closest point of the block); default look.ts DEFAULT_REACH (5). */
  reach?: number;
  /** server-authoritative-block-breaking-pick-range-scalar of the server; default 1.5. */
  pickRangeScalar?: number;
  /** Fail with 'no_tool' instead of breaking a block the chosen tool cannot harvest. Default false. */
  requireHarvest?: boolean;
  /** Speed conditions for the table (effects, water, airborne). Default none. */
  conditions?: BreakConditions;
  /** Override the expected tick count (tests). */
  expectedTicks?: number;
}

export type DigResult = SkillResult & {
  /** Block name before the dig. */
  block?: string;
  /** Hotbar slot used and the item in it (null = empty hand). */
  slot?: number;
  item?: string | null;
  /** Table ticks and the timeout used. */
  expected?: number;
  timeoutTicks?: number;
  /** Ticks from the start_break input to the tick the update_block arrived. */
  ticks?: number;
  /** update_block answers that restored the block (a rejected predict_break). */
  restores?: number;
  /** The tick of the start_break input. */
  startTick?: bigint;
  /** Wall-clock ms from queuing the start_break input to the update_block. */
  ms?: number;
};

type Phase = 'aim' | 'breaking' | 'waiting' | 'done';

interface BlockAction {
  action: string;
  position: Vec3;
  face: number;
}

interface Job {
  p: Vec3;
  face: Face;
  original: string;
  expected: number;
  timeoutTicks: number;
  reach: number | undefined;
  scalar: number | undefined;
  aimUntil: bigint;
  phase: Phase;
  startTick: bigint | undefined;
  startedAt: number;
  restores: number;
  result: Omit<DigResult, 'ok' | 'reason'>;
  finish: (r: DigResult) => void;
}

const sameBlock = (a: Vec3, b: Vec3) => a.x === b.x && a.y === b.y && a.z === b.z;

export class Digger {
  private readonly loop: DigLoop;
  private readonly world: DigWorld;
  private readonly hotbar: SlotSelector | undefined;
  private readonly log: Logger;
  private job: Job | undefined;
  private lastBreakTick: bigint | undefined;
  /** Closing actions (stop_break / abort_break) for a finished job, sent with the next input. */
  private pending: BlockAction[] = [];
  /** Track S: tool choice skips slots whose item fails this (worn tools, skills/survival/tools.ts); default all ok. */
  toolOk: (item: ItemStack) => boolean;
  pullTool?: (block: string) => Promise<unknown> | undefined; // Track V: pulls a better pickaxe / axe / shovel from the main inventory (skills/container/hotbar-moves.ts HotbarPuller.digHook); undefined = nothing to pull

  constructor(opts: { loop: DigLoop; world: DigWorld; hotbar?: SlotSelector; logger?: Logger; toolOk?: (item: ItemStack) => boolean }) {
    this.toolOk = opts.toolOk ?? (() => true); // Track S
    this.loop = opts.loop;
    this.world = opts.world;
    this.hotbar = opts.hotbar;
    this.log = opts.logger ?? silentLogger;
  }

  get busy(): boolean {
    return this.job !== undefined;
  }

  /** Eye position from the input loop's feet position. */
  eye(): Vec3 {
    const f = this.loop.state.pos;
    return { x: f.x, y: f.y + EYE_HEIGHT, z: f.z };
  }

  /** Turn the view to a point (block centre for a block position with integer coordinates). */
  lookAt(p: Vec3): { yaw: number; pitch: number } {
    const a = lookAngles(this.eye(), p);
    this.loop.setCommand(a);
    return a;
  }

  /** Abort a running dig (abort_break is sent with the next input). */
  cancel(): void {
    const job = this.job;
    if (!job || job.phase === 'done') return;
    // Resolve now: the loop may not tick any more (disconnected). The abort rides on the next input.
    this.complete(job, { ok: false, reason: 'interrupted' }, job.startTick !== undefined ? 'abort_break' : undefined);
  }

  dig(pos: Vec3, opts: DigOptions = {}): Promise<DigResult> {
    if (this.job) return Promise.resolve({ ok: false, reason: 'busy' });
    const p = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
    if (!this.loop.state.ready) return Promise.resolve({ ok: false, reason: 'not_ready' });
    const block = this.world.blockAt(p);
    if (!block) return Promise.resolve({ ok: false, reason: 'unloaded' });
    if (block.name === 'air' || block.name === 'unknown') return Promise.resolve({ ok: false, reason: 'no_block', block: block.name });
    const mining = blockMining(block.name);
    if (!mining) return Promise.resolve({ ok: false, reason: 'unknown_block', block: block.name });
    if (mining.hardness < 0) return Promise.resolve({ ok: false, reason: 'unbreakable', block: block.name });

    const eye = this.eye();
    const reach = checkReach(eye, p, opts.reach, opts.pickRangeScalar);
    if (!reach.ok) {
      this.log.info(`dig ${fmt(p)}: out of reach (${reach.reason}, ${reach.distance.toFixed(2)} / server ${reach.serverDistance.toFixed(2)})`);
      return Promise.resolve({ ok: false, reason: 'unreachable', block: block.name });
    }

    // Tool.
    const pulling = opts.tool === undefined || opts.tool === 'best' ? this.pullTool?.(block.name) : undefined; if (pulling) return pulling.then(() => this.dig(pos, opts), () => this.dig(pos, opts)); // Track V
    const inv = this.world.inventory;
    let slot = inv.selected;
    if (opts.tool === undefined || opts.tool === 'best') {
      slot = bestTool(mining.name, inv.slots, inv.selected, opts.conditions, this.toolOk)?.slot ?? inv.selected; // Track S: worn tools count as an empty hand; Track BB: helper bestTool
    } else if (typeof opts.tool === 'number') {
      if (!Number.isInteger(opts.tool) || opts.tool < 0 || opts.tool >= HOTBAR_SIZE) return Promise.resolve({ ok: false, reason: 'bad_slot' });
      slot = opts.tool;
    }
    const item = inv.slots[slot]?.name ?? null;
    const est = estimateBreak(mining, toolOf(item), opts.conditions);
    if (opts.requireHarvest && !est.canHarvest) return Promise.resolve({ ok: false, reason: 'no_tool', block: block.name, slot, item });
    if (slot !== inv.selected) {
      if (!this.hotbar) return Promise.resolve({ ok: false, reason: 'no_hotbar', block: block.name });
      this.hotbar.select(slot);
    }

    const expected = opts.expectedTicks ?? est.ticks;
    const timeoutTicks = Math.max(Math.ceil(TIMEOUT_FACTOR * expected), expected + MIN_TIMEOUT_SLACK);
    const face = opts.face ?? faceToward(eye, p);
    this.lookAt(blockCenter(p));

    const now = this.loop.state.tick;
    // One input carries the new look (and follows the mob_equipment) before start_break; the
    // survival cooldown since the previous break must also have passed.
    let aimUntil = now + 2n;
    if (this.lastBreakTick !== undefined) {
      const ready = this.lastBreakTick + BigInt(BREAK_COOLDOWN_TICKS);
      if (ready > aimUntil) aimUntil = ready;
    }

    return new Promise<DigResult>((resolve) => {
      const job: Job = {
        p,
        face,
        original: block.name,
        expected,
        timeoutTicks,
        reach: opts.reach,
        scalar: opts.pickRangeScalar,
        aimUntil,
        phase: 'aim',
        startTick: undefined,
        startedAt: 0,
        restores: 0,
        result: { block: block.name, slot, item, expected, timeoutTicks },
        finish: resolve,
      };
      this.job = job;
      const offUpdate = this.world.onBlockUpdate((q, _before, after) => {
        if (!sameBlock(q, p) || job.phase === 'done' || job.startTick === undefined) return;
        if (after.name === job.original) {
          job.restores++;
          this.log.debug(`dig ${fmt(p)}: server restored ${after.name} (restore #${job.restores})`);
          return;
        }
        const ticks = Number(this.loop.state.tick - job.startTick);
        const ms = performance.now() - job.startedAt;
        this.lastBreakTick = this.loop.state.tick;
        this.log.info(`dig ${fmt(p)}: ${job.original} -> ${after.name} after ${ticks} ticks (expected ${expected}, slot ${slot} ${item ?? 'hand'})`);
        // Release the button: BDS keeps mining the position until abort_break (stop_break and
        // predict_break do not end it), so a block placed there later would break at once.
        this.complete(job, { ok: true, ...job.result, ticks, ms }, 'abort_break');
      });
      const prevFinish = job.finish;
      job.finish = (r) => {
        offUpdate();
        prevFinish(r);
      };
      this.install();
    });
  }

  // ---- internals ------------------------------------------------------------------------------

  private install(): void {
    this.loop.setTickExtras((tick) => this.onTick(tick));
  }

  private complete(job: Job, r: DigResult, close: 'stop_break' | 'abort_break' | undefined): void {
    if (job.phase === 'done') return;
    job.phase = 'done';
    if (this.job === job) this.job = undefined;
    if (close) this.pending.push({ action: close, position: job.p, face: job.face });
    job.finish({ ...job.result, restores: job.restores, startTick: job.startTick, ...r });
  }

  private onTick(tick: bigint): ReturnType<TickExtrasProvider> {
    const closing = this.pending.splice(0);
    const own = this.step(tick);
    const actions = [...closing, ...((own?.block_action as BlockAction[] | undefined) ?? [])];
    if (!this.job) this.loop.setTickExtras(undefined);
    return actions.length ? { input_data: ['block_action'], block_action: actions } : undefined;
  }

  /** This tick's block actions for the running job. */
  private step(tick: bigint): ReturnType<TickExtrasProvider> {
    const job = this.job;
    if (!job || job.phase === 'done') return undefined;
    const act = (action: string) => ({ action, position: job.p, face: job.face });

    if (job.phase === 'aim') {
      if (tick < job.aimUntil) return undefined;
      // Still in reach (the bot may have been moved while aiming)?
      if (!checkReach(this.eye(), job.p, job.reach, job.scalar).ok) {
        this.complete(job, { ok: false, reason: 'unreachable' }, undefined);
        return undefined;
      }
      job.startTick = tick;
      job.startedAt = performance.now();
      job.phase = job.expected <= 0 ? 'waiting' : 'breaking';
      this.log.debug(`dig ${fmt(job.p)}: start_break at tick ${tick}, face ${job.face}, expect ${job.expected} ticks`);
      const actions = job.expected <= 0 ? [act('start_break'), act('predict_break'), act('stop_break')] : [act('start_break')];
      return { input_data: ['block_action'], block_action: actions };
    }

    const rel = Number(tick - job.startTick!);
    if (rel > job.timeoutTicks) {
      this.log.info(`dig ${fmt(job.p)}: timeout after ${rel} ticks (expected ${job.expected}); ${job.restores} restore(s)`);
      this.complete(job, { ok: false, reason: 'timeout' }, undefined);
      return { input_data: ['block_action'], block_action: [act('abort_break')] };
    }
    if (job.phase === 'breaking') {
      // Moved out of reach while breaking (teleport, knockback): the server would ignore the break.
      if (!checkReach(this.eye(), job.p, job.reach, job.scalar).ok) {
        this.complete(job, { ok: false, reason: 'unreachable' }, undefined);
        return { input_data: ['block_action'], block_action: [act('abort_break')] };
      }
      if (rel >= job.expected) {
        job.phase = 'waiting';
        return { input_data: ['block_action'], block_action: [act('predict_break'), act('stop_break')] };
      }
      return { input_data: ['block_action'], block_action: [act('continue_break')] };
    }
    return undefined;
  }
}

function fmt(p: Vec3): string {
  return `(${p.x}, ${p.y}, ${p.z})`;
}
