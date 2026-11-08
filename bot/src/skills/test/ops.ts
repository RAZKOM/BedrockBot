// Track T1 (ADR 0075): may the bot run commands? Two sources, both read live:
//
//   what the server says   start_game.permission_level (visitor | member | operator | custom), start_game.enable_commands
//                          (false: cheats off) and achievements_disabled (true once cheats were on), then every
//                          update_abilities (permission_level + command_permission: normal | operator | ...), which the
//                          server sends again on /op and /deop while the player is online
//   a probe                `/testfor @s` (the same operator level as /tp, /give, /effect and /replaceitem) and its
//                          command_output: success = the bot can run the harness's commands
//
// Measured on BDS 1.26.60.6 (bds-fly3, allow-cheats on, 2026-11-08): an operator gets start_game operator,
// enable_commands true, achievements_disabled true, then update_abilities operator / operator twice and an
// available_commands with give, effect, replaceitem, testfor, kill (82 commands); a console `deop` while online sends
// update_abilities member / normal at once (no new start_game) and the probe answers commands.generic.permission.selector;
// `op` sends operator / operator again. On the Realm the bot logs the same values at every spawn ("ops: ..."), so the
// first Realm session with cheats on says what the Realm sends.
//
// The verdict: `op` only after a successful probe that no later update_abilities contradicts; `not_op` when the probe was
// refused, commands are off, or the server demoted the bot (command_permission normal) since; `unknown` before any probe.
import { silentLogger, type Logger } from '../../log.ts';
import { isPermissionRefusal, resultText, type CommandResult } from './command.ts';

/** The one refusal line of the harness without rights. */
export const NEEDS_OP = 'the test harness needs cheats on and the bot op\'d';

/** The probe: harmless, needs the operator level of /tp and /give, answers with a success message. */
export const PROBE_COMMAND = '/testfor @s';

/** A successful probe is trusted this long (a de-op also arrives as update_abilities and voids it at once). */
export const PROBE_TTL_MS = 10 * 60_000;

export interface PermissionSignals {
  /** start_game / update_abilities `permission_level`: visitor | member | operator | custom. */
  permissionLevel?: string;
  /** update_abilities `command_permission`: normal | operator | automation | host | owner | internal. */
  commandPermission?: string;
  /** start_game `enable_commands` (and set_commands_enabled): false = cheats off. */
  commandsEnabled?: boolean;
  /** start_game `achievements_disabled`: true once cheats were turned on in that world. */
  achievementsDisabled?: boolean;
  /** Date.now() of the last update_abilities (or start_game). */
  at?: number;
}

export interface ProbeRecord {
  ok: boolean;
  at: number;
  messageId?: string;
  error?: string;
}

export type OpState = 'op' | 'not_op' | 'unknown';

export interface OpStatus {
  state: OpState;
  /** One line for chat and the log. */
  line: string;
  signals: PermissionSignals;
  probe?: ProbeRecord;
}

const COMMAND_LEVELS = ['normal', 'operator', 'automation', 'host', 'owner', 'internal'];

/** The command level the server gave is at least operator. Undefined when it said nothing. */
export function signalsSayOp(s: PermissionSignals): boolean | undefined {
  if (s.commandsEnabled === false) return false;
  if (s.commandPermission !== undefined) return COMMAND_LEVELS.indexOf(s.commandPermission) >= 1;
  if (s.permissionLevel !== undefined) return s.permissionLevel === 'operator';
  return undefined;
}

/** `operator/operator, commands on, achievements off` for the log. */
export function signalsText(s: PermissionSignals): string {
  const parts = [`permission ${s.permissionLevel ?? '?'}`, `commands ${s.commandPermission ?? '?'}`];
  if (s.commandsEnabled !== undefined) parts.push(s.commandsEnabled ? 'cheats on' : 'cheats off');
  if (s.achievementsDisabled !== undefined) parts.push(s.achievementsDisabled ? 'achievements off' : 'achievements on');
  return parts.join(', ');
}

/** The verdict from the signals and the last probe (pure; `now` for the probe's age). */
export function judgeOp(s: PermissionSignals, probe: ProbeRecord | undefined, now: number): OpStatus {
  const said = signalsSayOp(s);
  const base = { signals: { ...s }, ...(probe ? { probe: { ...probe } } : {}) };
  if (s.commandsEnabled === false) return { state: 'not_op', line: `${NEEDS_OP}: commands are off on this world (cheats off)`, ...base };
  // a demotion after the probe (a /deop while online) wins over the probe
  if (said === false && (!probe || (s.at ?? 0) >= probe.at)) return { state: 'not_op', line: `${NEEDS_OP}: the server gives me ${s.permissionLevel ?? 'member'} rights (${signalsText(s)})`, ...base };
  if (probe && now - probe.at <= PROBE_TTL_MS) {
    if (probe.ok) return { state: 'op', line: `op: commands work (${PROBE_COMMAND} answered; ${signalsText(s)})`, ...base };
    if (probe.error === undefined) return { state: 'not_op', line: `${NEEDS_OP}: ${PROBE_COMMAND} was refused (${probe.messageId ?? 'no message'})`, ...base };
  }
  return { state: 'unknown', line: `op: not probed yet (${signalsText(s)})`, ...base };
}

/** The parts of Connection the detector reads. */
export interface OpSource {
  on(name: string, fn: (p: unknown) => void): () => void;
}

export interface OpDetectorOptions {
  /** Send one command and read its answer (command.ts CommandRunner.run). */
  run: (command: string) => Promise<CommandResult>;
  log?: Logger;
  now?: () => number;
}

export class OpDetector {
  private readonly src: OpSource;
  private readonly o: OpDetectorOptions;
  private readonly log: Logger;
  private readonly now: () => number;
  private signals: PermissionSignals = {};
  private probeRec: ProbeRecord | undefined;
  private probing: Promise<OpStatus> | undefined;
  private readonly unsubs: (() => void)[] = [];
  private readonly listeners = new Set<(s: OpStatus) => void>();

  constructor(src: OpSource, o: OpDetectorOptions) {
    this.src = src;
    this.o = o;
    this.log = o.log ?? silentLogger;
    this.now = o.now ?? Date.now;
  }

  start(): void {
    if (this.unsubs.length) return;
    this.unsubs.push(
      this.src.on('start_game', (raw) => {
        const p = raw as { permission_level?: unknown; enable_commands?: unknown; achievements_disabled?: unknown };
        // a new session: what the last one learnt no longer holds
        this.signals = {
          ...(typeof p.permission_level === 'string' ? { permissionLevel: p.permission_level } : {}),
          ...(typeof p.enable_commands === 'boolean' ? { commandsEnabled: p.enable_commands } : {}),
          ...(typeof p.achievements_disabled === 'boolean' ? { achievementsDisabled: p.achievements_disabled } : {}),
          at: this.now(),
        };
        this.probeRec = undefined;
        this.log.info(`ops: start_game ${signalsText(this.signals)}`);
      }),
      this.src.on('set_commands_enabled', (raw) => {
        const p = raw as { enabled?: unknown };
        if (typeof p.enabled !== 'boolean' || p.enabled === this.signals.commandsEnabled) return;
        this.signals = { ...this.signals, commandsEnabled: p.enabled, at: this.now() };
        this.log.info(`ops: commands ${p.enabled ? 'enabled' : 'disabled'} by the server`);
        this.emit();
      }),
      this.src.on('update_abilities', (raw) => {
        const p = raw as { permission_level?: unknown; command_permission?: unknown };
        const level = typeof p.permission_level === 'string' ? p.permission_level : this.signals.permissionLevel;
        const cmd = typeof p.command_permission === 'string' ? p.command_permission : this.signals.commandPermission;
        const changed = level !== this.signals.permissionLevel || cmd !== this.signals.commandPermission;
        this.signals = { ...this.signals, ...(level !== undefined ? { permissionLevel: level } : {}), ...(cmd !== undefined ? { commandPermission: cmd } : {}), at: this.now() };
        if (!changed) return;
        this.log.info(`ops: update_abilities ${signalsText(this.signals)}`);
        // promoted: the next ensure() probes again; demoted: judgeOp says not_op at once
        if (signalsSayOp(this.signals) === true && this.probeRec && !this.probeRec.ok) this.probeRec = undefined;
        this.emit();
      }),
    );
  }

  stop(): void {
    for (const u of this.unsubs.splice(0)) u();
  }

  onChange(fn: (s: OpStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  status(): OpStatus {
    return judgeOp(this.signals, this.probeRec, this.now());
  }

  /** Is the bot op now? Probes when the verdict is unknown or old; a fresh verdict is returned as it is. */
  async ensure(): Promise<OpStatus> {
    const s = this.status();
    if (s.state !== 'unknown') return s;
    return this.probe();
  }

  /** Send the probe now (`!test op`). */
  probe(): Promise<OpStatus> {
    this.probing ??= (async () => {
      try {
        const r = await this.o.run(PROBE_COMMAND);
        this.probeRec = { ok: r.ok, at: this.now(), ...(r.messageId ? { messageId: r.messageId } : {}), ...(r.error ? { error: r.error } : {}) };
        const s = this.status();
        this.log.info(`ops: probe ${resultText(r)}${isPermissionRefusal(r) ? ' (no rights)' : ''}: ${s.state}`);
        this.emit();
        return s;
      } finally {
        this.probing = undefined;
      }
    })();
    return this.probing;
  }

  private emit(): void {
    const s = this.status();
    for (const fn of [...this.listeners]) {
      try {
        fn(s);
      } catch {
        /* a listener's problem */
      }
    }
  }
}
