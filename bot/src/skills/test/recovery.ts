// Track T1 (ADR 0075): putting the bot back for the next run, behind `testMode` (default off).
//
//   restore(start)   between runs and after a death: health and food back (/effect instant_health, saturation), the kit
//                    back (kit.ts planKit: /replaceitem, /give, a fresh elytra for a worn one), then /tp to the run's
//                    start and the wait until the body is there, the chunks around it are in and it stands
//   heal()           in a run, below TEST_LIMITS.healBelow (series.ts): /effect instant_health (at most every HEAL_GAP_MS)
//   Recovery         the death path: death -> respawn (tasks/respawn.ts presses the button as always) -> restore at the
//                    series' start (or the kit alone outside a series) -> idle
//
// With testMode off nothing here runs: no command is sent, the after-respawn hook returns at once and the afk task's home
// return goes as before. With testMode on but no rights (ops.ts) the bot says NEEDS_OP once per death and sends nothing.
// While a series runs the recovery owns the respawn: the afk task's walk home is skipped (respawnClaimed, read by
// tasks/registry.ts), so the walk home and the /tp never race.
import type { Vec3 } from '../../connection/types.ts';
import { silentLogger, type Logger } from '../../log.ts';
import { resultText, type CommandResult } from './command.ts';
import { planKit, type KitEntry, type KitView } from './kit.ts';
import { NEEDS_OP, type OpStatus } from './ops.ts';

/** Two heals at least this far apart. */
export const HEAL_GAP_MS = 3000;
/** The body must reach the /tp target within this long. */
export const TP_WAIT_MS = 10_000;
/** After the /tp: chunks around the target and standing still, at most this long. */
export const SETTLE_MS = 15_000;
/** Within this distance (blocks) of the /tp target counts as there. */
export const TP_NEAR = 1.5;

const HEAL = ['/effect @s instant_health 1 4 true', '/effect @s saturation 1 4 true'];

// ---- the claim on the respawn (read by tasks/registry.ts's after-respawn walk home) -----------------------------------

const claims = new WeakMap<object, () => boolean>();

/** The test harness of `task` handles respawns now: the afk task's walk home after a respawn is skipped. */
export function claimRespawn(task: object, owns: () => boolean): void {
  claims.set(task, owns);
}

export function respawnClaimed(task: object): boolean {
  try {
    return claims.get(task)?.() ?? false;
  } catch {
    return false;
  }
}

// ---- restore -----------------------------------------------------------------------------------------------------------

export interface HarnessPorts {
  run(command: string): Promise<CommandResult>;
  /** Feet position (the input loop's), undefined when not known. */
  position(): Vec3 | undefined;
  health(): number | undefined;
  food(): number | undefined;
  onGround(): boolean;
  gliding(): boolean;
  /** What the bot carries (kit.ts kitView of the inventory model). */
  view(): KitView;
  /** Wait for the chunks around the body (world.waitForChunks), resolves on timeout too. */
  waitChunks(timeoutMs: number): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log: Logger;
}

export interface RestoreResult {
  ok: boolean;
  /** What was done: `healed`, `kit: elytra +1, firework_rocket +40`, `tp 10 -60 3 (1.2 s)`. */
  steps: string[];
  /** Why it failed (a refused command, no arrival). */
  why?: string;
  commands: number;
}

export const fmtCell = (p: Vec3): string => `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`;
const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export class Harness {
  private readonly p: HarnessPorts;
  private lastHeal = -Infinity;

  constructor(p: HarnessPorts) {
    this.p = p;
  }

  /** `/tp @s` to the centre of a feet cell. */
  static tpCommand(cell: Vec3): string {
    return `/tp @s ${Math.floor(cell.x) + 0.5} ${Math.floor(cell.y)} ${Math.floor(cell.z) + 0.5}`;
  }

  /** Health in a run fell low: instant health now (at most every HEAL_GAP_MS). True when a heal was sent and taken. */
  async heal(): Promise<boolean> {
    const t = this.p.now();
    if (t - this.lastHeal < HEAL_GAP_MS) return false;
    this.lastHeal = t;
    const r = await this.p.run(HEAL[0]!);
    return r.ok;
  }

  /** Health and food back, the kit back, then the /tp to `start` (when given) and the settle there. */
  async restore(start: Vec3 | undefined, kit: readonly KitEntry[] | undefined, elytraMin: number): Promise<RestoreResult> {
    const steps: string[] = [];
    let commands = 0;
    const send = async (c: string): Promise<CommandResult> => {
      commands++;
      return this.p.run(c);
    };
    const failed = (why: string): RestoreResult => ({ ok: false, steps, why, commands });
    if ((this.p.health() ?? 0) < 20 || (this.p.food() ?? 0) < 20) {
      for (const c of HEAL) {
        const r = await send(c);
        if (!r.ok) return failed(`${c}: ${resultText(r)}`);
      }
      this.lastHeal = this.p.now();
      steps.push('healed');
    }
    const plan = planKit(kit ?? [], this.p.view(), { elytraMin });
    for (const c of plan.commands) {
      const r = await send(c);
      if (!r.ok) return failed(`${c}: ${resultText(r)}`);
    }
    if (plan.notes.length) steps.push(`kit: ${plan.notes.join(', ')}`);
    if (!start) return { ok: true, steps, commands };
    const target = { x: Math.floor(start.x) + 0.5, y: Math.floor(start.y), z: Math.floor(start.z) + 0.5 };
    const t0 = this.p.now();
    const r = await send(Harness.tpCommand(start));
    if (!r.ok) return failed(`tp: ${resultText(r)}`);
    // the body follows the server's move_player (the input loop takes the teleport)
    for (;;) {
      const here = this.p.position();
      if (here && dist(here, target) <= TP_NEAR) break;
      if (this.p.now() - t0 > TP_WAIT_MS) return failed(`tp: still at ${here ? fmtCell(here) : '?'} after ${TP_WAIT_MS / 1000} s`);
      await this.p.sleep(100);
    }
    await this.p.waitChunks(SETTLE_MS);
    for (let i = 0; i < 50 && !(this.p.onGround() && !this.p.gliding()); i++) await this.p.sleep(100);
    steps.push(`tp ${fmtCell(start)} (${((this.p.now() - t0) / 1000).toFixed(1)} s)`);
    return { ok: true, steps, commands };
  }
}

// ---- the death path ----------------------------------------------------------------------------------------------------

export type RecoveryPhase = 'idle' | 'dead' | 'recovering' | 'refused' | 'failed';

export type RecoveryEvent =
  | { kind: 'death' }
  | { kind: 'respawn'; enabled: boolean }
  | { kind: 'op'; state: OpStatus['state'] }
  | { kind: 'done'; ok: boolean };

/**
 * The recovery's state machine (pure). A death from any phase is `dead`; the respawn with testMode off is `idle` (nothing
 * to do), else the op check decides: `recovering` (restore runs) or `refused`; the restore ends `idle` or `failed`.
 * `refused` and `failed` last until the next death.
 */
export function recoveryStep(phase: RecoveryPhase, e: RecoveryEvent): RecoveryPhase {
  switch (e.kind) {
    case 'death':
      return 'dead';
    case 'respawn':
      return phase === 'dead' ? (e.enabled ? 'dead' : 'idle') : phase; // still `dead` until the op check
    case 'op':
      return phase === 'dead' ? (e.state === 'op' ? 'recovering' : 'refused') : phase;
    case 'done':
      return phase === 'recovering' ? (e.ok ? 'idle' : 'failed') : phase;
  }
}

export interface RecoveryPorts {
  /** `testMode`. */
  enabled(): boolean;
  ensureOp(): Promise<OpStatus>;
  /** The restore after a respawn: at the series' start with its kit, or the kit alone outside a series. */
  restore(): Promise<RestoreResult>;
  say(line: string): void;
  log?: Logger;
}

export interface RecoveryRecord {
  at: string;
  phase: RecoveryPhase;
  steps: string[];
  why?: string;
}

export class Recovery {
  phase: RecoveryPhase = 'idle';
  readonly history: RecoveryRecord[] = [];
  private readonly p: RecoveryPorts;
  private readonly log: Logger;
  private done: Promise<void> = Promise.resolve();
  private release: (() => void) | undefined;

  constructor(p: RecoveryPorts) {
    this.p = p;
    this.log = p.log ?? silentLogger;
  }

  private step(e: RecoveryEvent): void {
    const next = recoveryStep(this.phase, e);
    if (next !== this.phase) this.log.debug(`test recovery: ${this.phase} -> ${next} (${e.kind})`);
    this.phase = next;
    if (next !== 'dead' && next !== 'recovering') {
      this.release?.();
      this.release = undefined;
    }
  }

  /** The phase as it is now (read again after an await). */
  private now(): RecoveryPhase {
    return this.phase;
  }

  /** Resolves once a death in progress is recovered (or refused / failed); at once when there is none. */
  settled(): Promise<void> {
    return this.done;
  }

  /** True between a death and the end of its recovery. */
  get busy(): boolean {
    return this.phase === 'dead' || this.phase === 'recovering';
  }

  onDeath(): void {
    if (!this.busy) this.done = new Promise<void>((r) => (this.release = r));
    this.step({ kind: 'death' });
  }

  /** The after-respawn hook (tasks/respawn.ts afterRespawn). */
  async onRespawn(signal?: AbortSignal): Promise<void> {
    const enabled = this.p.enabled();
    this.step({ kind: 'respawn', enabled });
    if (!enabled || this.phase !== 'dead') return;
    const op = await this.p.ensureOp();
    if (signal?.aborted) return;
    this.step({ kind: 'op', state: op.state });
    if (this.now() === 'refused') {
      this.p.say(`test: no recovery after the death: ${op.line}`);
      this.history.push({ at: new Date().toISOString(), phase: 'refused', steps: [], why: op.state === 'unknown' ? op.line : NEEDS_OP });
      this.trim();
      return;
    }
    let r: RestoreResult;
    try {
      r = await this.p.restore();
    } catch (e) {
      r = { ok: false, steps: [], why: e instanceof Error ? e.message : String(e), commands: 0 };
    }
    if (signal?.aborted && this.now() !== 'recovering') return;
    this.step({ kind: 'done', ok: r.ok });
    this.history.push({ at: new Date().toISOString(), phase: this.phase, steps: r.steps, ...(r.why ? { why: r.why } : {}) });
    this.trim();
    this.log[r.ok ? 'info' : 'warn'](`test: recovery after the death ${r.ok ? 'done' : `failed (${r.why ?? '?'})`}${r.steps.length ? `: ${r.steps.join('; ')}` : ''}`);
    if (!r.ok) this.p.say(`test: recovery after the death failed: ${r.why ?? '?'}`);
  }

  private trim(): void {
    while (this.history.length > 20) this.history.shift();
  }
}
