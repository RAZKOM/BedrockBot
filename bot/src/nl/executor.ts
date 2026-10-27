// The natural-language front end's executor (PLAN.md 7.18, Track Y; docs/natural-language.md):
//   request(text)  -> prompt the provider -> parse + validate the plan (nl/plan.ts) -> check it against
//                     what the owner said (waypoints known, numbers said, commands registered)
//                  -> a question / `not available: x` / the plan line and wait for !yes (nlConfirm)
//   yes()          -> run: each step is fed to the chat's own command handler as the owner
//                     (chat.handle with a copy of the owner's line), one at a time; the next starts when
//                     the previous one finished (its reply, or no user process left on the manager)
//   no()           -> drop the waiting plan, or the rest of a running one
// The model only picks commands; movement, targets and safety stay with the commands themselves.
import type { CommandEvent } from '../chat/chat.ts';
import type { ChatLine } from '../chat/text.ts';
import { silentLogger, type Logger } from '../log.ts';
import { COMMAND_SPECS, COMMON_FAIL, isTalk, parsePlan, planJsonSchema, planLine, stepChatName, stepCommand, type Plan, type Step, type TalkKind } from './plan.ts'; // Track AM: isTalk, TalkKind (answer steps)
import { buildSystemPrompt, buildUserMessage, type PromptContext } from './prompt.ts';
import type { NlProvider } from './provider.ts';

/** The parts of chat/chat.ts's Chat the front end uses (unit tests fake it). */
export interface NlChat {
  readonly prefix: string;
  commandNames(): string[];
  helpText(): string;
  handle(line: ChatLine): void;
  say(message: string): boolean;
  onCommand(fn: (e: CommandEvent) => void): () => void;
}

export interface NlProcesses {
  userProcesses(): readonly unknown[];
}

/** Who asked, and the line they typed (steps are dispatched as copies of it). */
export interface NlOrigin {
  line: ChatLine;
  /** `console` or the player's name. */
  sender: string;
}

export interface NlFrontEndOptions {
  chat: NlChat;
  /** undefined = natural language off (`nl.provider` none). */
  provider: NlProvider | undefined;
  /** The `nlConfirm` setting, read live. */
  confirm: () => boolean;
  processes?: NlProcesses | undefined;
  /** The prompt's view of the bot (without `sender`). */
  context: () => Omit<PromptContext, 'sender'>;
  log?: Logger;
  /** A plan waits this long for !yes. Default 60 s. */
  confirmMs?: number;
  /** One step may take this long. Default 10 min. */
  stepTimeoutMs?: number;
  /** A step that ends without a done reply counts as done after this. Default 400 ms. */
  settleMs?: number;
  pollMs?: number;
}

export type CheckResult = { kind: 'plan'; plan: Plan } | { kind: 'question'; text: string } | { kind: 'unavailable'; command: string };

/** Integers the owner typed (`go to 10 -60 3` -> 10, -60, 3). */
export function numbersIn(text: string): Set<number> {
  return new Set((text.match(/-?\d+/g) ?? []).map(Number));
}

/**
 * Check a valid plan against what the owner said and what the bot has: waypoint names must exist,
 * coordinates and radii must be numbers the owner typed, a named player must be in the text, every
 * command must be registered. A failed check becomes a question (or `not available`).
 */
export function checkPlan(plan: Plan, c: { text: string; sender: string; waypoints: readonly string[]; commands: readonly string[] }): CheckResult {
  const said = numbersIn(c.text);
  const lower = c.text.toLowerCase();
  const known = c.waypoints.map((w) => w.toLowerCase());
  const steps: Step[] = [];
  for (const s of plan.steps) {
    if (isTalk(s)) {
      steps.push(s);
      break;
    }
    const chat = stepChatName(s)!;
    if (!c.commands.includes(chat)) return { kind: 'unavailable', command: chat };
    if ((s.command === 'goto' || s.command === 'wp_del') && !known.includes(s.command === 'goto' ? s.waypoint : s.name)) {
      const name = s.command === 'goto' ? s.waypoint : s.name;
      return { kind: 'question', text: `I know no waypoint "${name}"${known.length ? ` (known: ${known.slice(0, 8).join(', ')})` : ''}. Which one, or which x y z?` };
    }
    const nums = s.command === 'goto_xyz' || s.command === 'wp_set' ? [s.x, s.y, s.z] : s.command === 'guard' || s.command === 'farm' ? [s.radius] : [];
    if (nums.some((n) => n !== undefined && !said.has(n))) {
      return { kind: 'question', text: s.command === 'guard' || s.command === 'farm' ? 'Which radius?' : 'Which coordinates? Say x y z.' };
    }
    if ((s.command === 'come' || s.command === 'follow') && s.player !== undefined) {
      if (s.player.toLowerCase() === c.sender.toLowerCase()) {
        steps.push({ command: s.command });
        continue;
      }
      if (!new RegExp(`\\b${s.player.toLowerCase()}\\b`).test(lower)) return { kind: 'question', text: `Who should I ${s.command === 'come' ? 'come to' : 'follow'}?` };
    }
    steps.push(s);
  }
  const only = steps[0];
  if (steps.length === 1 && only && isTalk(only)) return { kind: 'question', text: only.text }; // Track AM: an answer is said verbatim like a question, nothing runs
  return { kind: 'plan', plan: { steps } };
}

/** `Bot, go home` / `@Bot go home` / `bot: go home` -> `go home`; anything else undefined. */
export function addressedText(body: string, botName: string, prefix = '!'): string | undefined {
  const t = body.trim();
  if (!botName || t.startsWith(prefix)) return undefined;
  const n = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^@${n}(?![\\w])[,:]?\\s*(.+)$`, 'i').exec(t) ?? new RegExp(`^${n}\\s*[,:]\\s*(.+)$`, 'i').exec(t);
  const text = m?.[1]?.trim() ?? '';
  return text.length > 0 ? text : undefined;
}

/** Owner commands that end a running plan (they replace or stop what it started). */
const ABORT_ON = new Set(['stop', 'goto', 'come', 'follow', 'kill', 'gather', 'mine', 'farm', 'food', 'sleep', 'home', 'top', 'nether', 'overworld']); // Track AT: nether, overworld

interface Pending {
  plan: Plan;
  origin: NlOrigin;
  timer: ReturnType<typeof setTimeout>;
}

interface Running {
  plan: Plan;
  step: number;
  aborted: boolean;
}

export type StepResult = { ok: true } | { ok: false; reason: string };

export class NlFrontEnd {
  private readonly o: NlFrontEndOptions;
  private readonly log: Logger;
  private pending: Pending | undefined;
  private running: Running | undefined;
  private thinking = false;
  private dispatching = false;
  /** Replies seen while a step runs. */
  private replies: string[] | undefined;
  private readonly offCommand: () => void;

  constructor(o: NlFrontEndOptions) {
    this.o = o;
    this.log = o.log ?? silentLogger;
    this.offCommand = o.chat.onCommand((e) => {
      if (e.kind !== 'run' || this.dispatching || !this.running || !ABORT_ON.has(e.name)) return;
      this.running.aborted = true;
      this.log.info(`plan dropped by !${e.name}`);
    });
  }

  get enabled(): boolean {
    return this.o.provider !== undefined;
  }

  /** A plan waiting for !yes. */
  get waiting(): Plan | undefined {
    return this.pending?.plan;
  }

  get busy(): boolean {
    return this.running !== undefined;
  }

  /** Every reply the bot sends (commands-nl.ts wraps chat.say); collected while a step runs. */
  observeReply(message: string): void {
    this.replies?.push(message);
  }

  private say(m: string): void {
    this.o.chat.say(m);
  }

  /** Ask the model; reply with a question, `not available`, or the plan (and run it when confirmation is off). */
  async request(text: string, origin: NlOrigin): Promise<CheckResult | undefined> {
    const provider = this.o.provider;
    if (!provider) {
      this.say('natural language is off (nl.provider is none; docs/natural-language.md)');
      return undefined;
    }
    if (this.running) {
      this.say('busy with a plan (!no drops the rest)');
      return undefined;
    }
    if (this.thinking) {
      this.say('still thinking about the last request');
      return undefined;
    }
    if (!text.trim()) {
      this.say('usage: !do <what to do>');
      return undefined;
    }
    this.thinking = true;
    const t0 = Date.now();
    let answer: string;
    const ctx = this.o.context();
    try {
      answer = await provider.complete({
        system: buildSystemPrompt({ ...ctx, sender: origin.sender }),
        user: buildUserMessage(origin.sender, text),
        schema: planJsonSchema(),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn(`nl: ${provider.label} failed after ${Date.now() - t0} ms: ${msg}`);
      this.say(`nl: ${msg}`);
      return undefined;
    } finally {
      this.thinking = false;
    }
    this.log.info(`nl: "${text}" -> ${answer} (${provider.label}, ${Date.now() - t0} ms)`);
    const parsed = parsePlan(answer);
    if (!parsed.ok) {
      this.log.warn(`nl: invalid plan: ${parsed.error}`);
      this.say(`I could not make a plan of that (${parsed.error.slice(0, 120)}); the ! commands work as usual (!help)`);
      return undefined;
    }
    const checked = checkPlan(parsed.plan, { text, sender: origin.sender, waypoints: ctx.waypoints, commands: this.o.chat.commandNames() });
    if (checked.kind === 'question') {
      this.say(checked.text);
      return checked;
    }
    if (checked.kind === 'unavailable') {
      this.say(`not available: ${checked.command}`);
      return checked;
    }
    this.dropPending();
    if (this.o.confirm()) {
      const timer = setTimeout(() => {
        if (this.pending?.timer !== timer) return;
        this.pending = undefined;
        this.say(`plan dropped (no ${this.o.chat.prefix}yes within ${Math.round((this.o.confirmMs ?? 60_000) / 1000)} s)`);
      }, this.o.confirmMs ?? 60_000);
      timer.unref?.();
      this.pending = { plan: checked.plan, origin, timer };
      this.say(`${planLine(checked.plan)} (${this.o.chat.prefix}yes to run, ${this.o.chat.prefix}no to drop)`);
    } else {
      this.say(planLine(checked.plan));
      void this.run(checked.plan, origin);
    }
    return checked;
  }

  /** `!yes`: run the waiting plan of this sender. */
  yes(sender: string): void {
    const p = this.pending;
    if (!p) {
      this.say(`no plan waiting (${this.o.chat.prefix}do <what to do>)`);
      return;
    }
    if (p.origin.sender.toLowerCase() !== sender.toLowerCase()) {
      this.say(`the waiting plan is ${p.origin.sender}'s`);
      return;
    }
    this.dropPending();
    void this.run(p.plan, p.origin);
  }

  /** `!no`: drop the waiting plan, or the rest of the running one (the running command keeps going; !stop ends it). */
  no(): void {
    if (this.pending) {
      this.dropPending();
      this.say('plan dropped');
      return;
    }
    if (this.running) {
      this.running.aborted = true;
      this.say(`plan dropped after step ${this.running.step}/${this.running.plan.steps.length} (the running command goes on; ${this.o.chat.prefix}stop ends it)`);
      return;
    }
    this.say('nothing to drop');
  }

  private dropPending(): void {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = undefined;
  }

  /** Run the steps one by one. Resolves when the plan ended (done, failed, dropped). */
  async run(plan: Plan, origin: NlOrigin): Promise<{ done: number; ok: boolean; reason?: string }> {
    const r: Running = { plan, step: 0, aborted: false };
    this.running = r;
    const n = plan.steps.length;
    try {
      for (const [i, s] of plan.steps.entries()) {
        if (r.aborted) return { done: i, ok: false, reason: 'dropped' };
        r.step = i + 1;
        if (isTalk(s)) {
          this.say(s.text);
          return { done: i, ok: true };
        }
        const name = stepChatName(s)!;
        if (!this.o.chat.commandNames().includes(name)) {
          this.say(`not available: ${name}`);
          return { done: i, ok: false, reason: 'not available' };
        }
        const res = await this.runStep(s, origin, r);
        if (!res.ok) {
          if (res.reason !== 'dropped') this.say(`plan stopped at step ${i + 1}/${n} (${stepCommand(s)}): ${res.reason}`);
          this.log.info(`nl: plan ended at step ${i + 1}/${n}: ${res.reason}`);
          return { done: i, ok: false, reason: res.reason };
        }
      }
      if (n > 1) this.say(`plan done (${n} steps)`);
      return { done: n, ok: true };
    } finally {
      if (this.running === r) this.running = undefined;
    }
  }

  private async runStep(s: Exclude<Step, { command: TalkKind }>, origin: NlOrigin, r: Running): Promise<StepResult> {
    const spec = COMMAND_SPECS[s.command];
    const text = `${this.o.chat.prefix}${stepCommand(s)}`;
    const seen: string[] = [];
    this.replies = seen;
    const settle = this.o.settleMs ?? 400;
    const poll = this.o.pollMs ?? 100;
    const timeout = this.o.stepTimeoutMs ?? 600_000;
    this.log.info(`nl: step ${r.step}/${r.plan.steps.length}: ${text}`);
    try {
      this.dispatching = true;
      try {
        this.o.chat.handle({ ...origin.line, body: text, message: text });
      } finally {
        this.dispatching = false;
      }
      const t0 = Date.now();
      let checked = 0;
      for (;;) {
        for (; checked < seen.length; checked++) {
          const m = seen[checked]!;
          if (COMMON_FAIL.test(m) || spec.fail?.test(m)) return { ok: false, reason: m };
          if (spec.done?.test(m)) return { ok: true };
        }
        if (r.aborted) return { ok: false, reason: 'dropped' };
        const elapsed = Date.now() - t0;
        if (elapsed >= settle) {
          if (spec.wait === 'none' || spec.wait === 'endless') return { ok: true };
          if (spec.wait === 'process' && (!this.o.processes || this.o.processes.userProcesses().length === 0)) return { ok: true };
        }
        if (elapsed > timeout) return { ok: false, reason: `no end within ${Math.round(timeout / 1000)} s` };
        await new Promise((res) => setTimeout(res, poll));
      }
    } finally {
      if (this.replies === seen) this.replies = undefined;
    }
  }

  dispose(): void {
    this.dropPending();
    if (this.running) this.running.aborted = true;
    this.offCommand();
  }
}
