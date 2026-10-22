// Night shelter as a process (PLAN.md 7.8, Track Q; docs/processes.md). NightSafety (tasks/night.ts)
// keeps its clock and state machine and its 1 s timer (dusk / dawn transitions, attempt budget); this
// process only decides when it may move: it wants control from dusk to dawn while a shelter is set and
// the bot walks there, a retreat is due, or the bot is inside (it then holds the bot there: user
// commands wait until dawn). While unreachable or given up it does not want control, so guard and the
// owner's commands run. Pre-empted (a flight, a fight in place) = the retreat is cancelled without
// counting as a failed attempt and planned again when control comes back.
import type { NightSafety } from '../night.ts';
import { BaseProcess, PRIORITY, type ProcessStatus } from './manager.ts';
import { etaFor, navRemaining, type ProcessMover } from './goto.ts';
import type { Vec3 } from '../../connection/types.ts';

export class NightProcess extends BaseProcess {
  readonly name = 'night';
  readonly kind = 'auto' as const;
  private readonly night: NightSafety;
  private readonly mover: ProcessMover | undefined;
  private readonly position: () => Vec3 | undefined;

  constructor(night: NightSafety, opts: { mover?: ProcessMover; position?: () => Vec3 | undefined } = {}) {
    super();
    this.night = night;
    this.mover = opts.mover;
    this.position = opts.position ?? (() => undefined);
  }

  get priority(): number {
    return PRIORITY.night;
  }

  /** For NightSafety's `canMove` option. */
  get hasControl(): boolean {
    return this.controlled;
  }

  override wants(): boolean {
    return this.night.wantsControl();
  }

  protected run(): void {
    this.night.check();
  }

  tick(): void {
    this.night.check();
  }

  protected halt(): void {
    this.night.suspend();
  }

  protected override persistent = true;

  idle(): boolean {
    return !this.night.walking;
  }

  status(): ProcessStatus {
    const s = this.night.shelter;
    const st = this.night.state;
    if (this.night.walking && s) {
      const left = this.mover ? navRemaining(this.mover.nav, this.position()) : undefined;
      return {
        line: `night: going to the shelter ${s.x} ${s.y} ${s.z}${left !== undefined ? `, ${Math.round(left)} blocks left` : ''}`,
        etaS: this.mover ? etaFor(left, this.mover.nav.lastReport, true) : undefined,
      };
    }
    return { line: `night: ${st}` };
  }

  behaviour(): string {
    return this.night.walking ? 'going to the shelter' : this.night.state === 'sheltered' ? 'sheltered' : `night ${this.night.state}`;
  }
}
