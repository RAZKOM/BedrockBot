// Ask the owner (Track P5, ADR 0116, docs/away.md "Ask the owner"): a running job or the bot asks a question with a
// few choices and waits a bounded time for the answer. The answer comes from the panel (a card with the choices and a
// countdown: `!answer <id> <choice>` through POST /api/cmd) or from the game chat (`!answer [id] <choice|n>`, and
// `!yes` / `!no` when the question has those words); unanswered, the default is taken when the wait runs out. The
// default is always what the bot did before the question existed, so no answer never makes anything riskier and
// nothing waits for ever.
//
//   const q = box.ask({ key: 'queue-fail', text: 'job #4 failed: retry it?', choices: [...], default: 'next', waitMs: 120_000 });
//   const a = await q.answer;    // { choice: 'retry', how: 'panel', by: 'Steve', afterMs: 14_000 } or the default on timeout
//
// Rules (each has its reason in docs/away.md):
// - the wait is bounded: ASK_MIN_MS .. ASK_MAX_MS whatever the caller asks;
// - a second question with the same key replaces the first (it resolves with its default, `replaced`);
// - at most ASK_OPEN_MAX open at once: the oldest is closed with its default (`closed`);
// - every question and every answer is an event (ask.asked notable, ask.answered info) and a log line;
// - the question is said in the game chat too (the owner may be in the game).
import { events, type EventBus } from '../events/bus.ts';
import { clipText, durationText } from '../events/registry.ts';
import { silentLogger, type Logger } from '../log.ts';

export interface AskChoice {
  /** The word `!answer` takes (`retry`); lower case, no spaces. */
  id: string;
  /** What it does, for the card and the chat line (`retry it`). */
  label: string;
  /** Other words that pick it: `yes` / `no` make `!yes` / `!no` answer the question. */
  aliases?: readonly string[];
  /** Track D2: a button's label, one or two words (`Retry`); default: the id with a capital. */
  short?: string;
  /** Track D2: the outcome once chosen (`Retried`), for the answered message; default: `<short> chosen`. */
  done?: string;
}

export interface AskSpec {
  /** What the question is about (`queue-fail`); a new question with the same key replaces the open one. */
  key: string;
  /** The question (one line). */
  text: string;
  choices: readonly AskChoice[];
  /** The choice taken when nobody answers: what the bot did before questions existed. */
  default: string;
  waitMs: number;
  /** Track D2: the matter, as a message title (`Job #7 failed: !goto zzqxtest`); default: the text. */
  title?: string;
  /** Track D2: the cause in one line (`no waypoint zzqxtest`). */
  detail?: string;
  /** Track D2: what a phone's push shows (`Job #7 failed: retry, skip or pause the queue?`); default: the text. */
  push?: string;
}

/**
 * Track D2 (docs/discord.md "What the messages look like"): the words a message card uses, kept out of AskView (the
 * panel's state carries the views; the card goes only to the note sinks).
 */
export interface AskCard {
  title?: string;
  detail?: string;
  push?: string;
  /** Per choice id. */
  choices: Record<string, { short?: string; done?: string }>;
}

export type AskHow = 'panel' | 'chat' | 'console' | 'discord' | 'timeout' | 'replaced' | 'closed'; // Track D1: discord
/** Where an answer came from (a person's, not the timeout's). */
export type AnswerHow = 'panel' | 'chat' | 'console' | 'discord';

export interface AskAnswer {
  id: number;
  choice: string;
  how: AskHow;
  by?: string | undefined;
  afterMs: number;
}

/** What the panel shows (the card) and `!answer` lists. */
export interface AskView {
  id: number;
  key: string;
  text: string;
  choices: { id: string; label: string; n: number; yes: boolean; no: boolean }[];
  default: string;
  askedAt: number;
  /** Epoch ms the default is taken. */
  until: number;
}

/** Bounds of a question's wait. */
export const ASK_MIN_MS = 10_000;
export const ASK_MAX_MS = 30 * 60_000;
/** Open questions at most (the oldest is closed with its default). */
export const ASK_OPEN_MAX = 4;
/** A question's text and a choice's label at most (the chat line, the card). */
export const ASK_TEXT_MAX = 160;
export const ASK_LABEL_MAX = 40;
/** Track D2: a card's button label and outcome word, and its one-line cause, at most. */
export const ASK_SHORT_MAX = 24;
export const ASK_DETAIL_MAX = 200;

interface Open {
  view: AskView;
  card: AskCard | undefined;
  aliases: Map<string, string>;
  resolve: (a: AskAnswer) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface AskBoxOptions {
  /** One line to the owner in the game (past the chat's rate limit). */
  say?: (m: string) => void;
  log?: Logger;
  now?: () => number;
  /** The command prefix (`!`). */
  prefix?: string;
  /** Where the ask.* events go (the bot's bus; a test's own). */
  bus?: Pick<EventBus, 'emit'>;
}

const word = (s: string): string => s.trim().toLowerCase().replace(/^#/, '');

export class AskBox {
  private readonly o: AskBoxOptions;
  private readonly log: Logger;
  private readonly open = new Map<number, Open>();
  private nextId = 1;
  private readonly listeners = new Set<() => void>();
  readonly stats = { asked: 0, answered: 0, timedOut: 0 };

  constructor(o: AskBoxOptions = {}) {
    this.o = o;
    this.log = o.log ?? silentLogger;
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private get pre(): string {
    return this.o.prefix ?? '!';
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private changed(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {
        /* a listener's fault is not the box's */
      }
    }
  }

  /** Ask; the promise resolves with the answer, or with the default when the wait runs out (it never rejects). */
  ask(spec: AskSpec): { id: number; answer: Promise<AskAnswer> } {
    const choices = spec.choices.filter((c) => c.id).slice(0, 6);
    if (!choices.some((c) => c.id === spec.default)) throw new Error(`ask: the default ${spec.default} is not one of the choices`);
    for (const o of [...this.open.values()]) if (o.view.key === spec.key) this.settle(o, o.view.default, 'replaced');
    while (this.open.size >= ASK_OPEN_MAX) {
      const oldest = [...this.open.values()].sort((a, b) => a.view.id - b.view.id)[0]!;
      this.settle(oldest, oldest.view.default, 'closed');
    }
    const id = this.nextId++;
    const now = this.now();
    const waitMs = Math.max(ASK_MIN_MS, Math.min(ASK_MAX_MS, Math.round(spec.waitMs)));
    const aliases = new Map<string, string>();
    choices.forEach((c, i) => {
      aliases.set(c.id, c.id);
      aliases.set(String(i + 1), c.id);
      for (const a of c.aliases ?? []) aliases.set(word(a), c.id);
    });
    const view: AskView = {
      id,
      key: spec.key,
      text: clipText(spec.text, ASK_TEXT_MAX),
      choices: choices.map((c, i) => ({ id: c.id, label: clipText(c.label, ASK_LABEL_MAX), n: i + 1, yes: (c.aliases ?? []).includes('yes'), no: (c.aliases ?? []).includes('no') })),
      default: spec.default,
      askedAt: now,
      until: now + waitMs,
    };
    let resolve!: (a: AskAnswer) => void;
    const answer = new Promise<AskAnswer>((r) => {
      resolve = r;
    });
    const timer = setTimeout(() => {
      const o = this.open.get(id);
      if (o) this.settle(o, o.view.default, 'timeout');
    }, waitMs);
    timer.unref?.();
    const cardChoices: AskCard['choices'] = {};
    for (const c of choices) if (c.short || c.done) cardChoices[c.id] = { ...(c.short ? { short: clipText(c.short, ASK_SHORT_MAX) } : {}), ...(c.done ? { done: clipText(c.done, ASK_SHORT_MAX) } : {}) };
    const card: AskCard | undefined = spec.title || spec.detail || spec.push || Object.keys(cardChoices).length ? { ...(spec.title ? { title: clipText(spec.title, ASK_TEXT_MAX) } : {}), ...(spec.detail ? { detail: clipText(spec.detail, ASK_DETAIL_MAX) } : {}), ...(spec.push ? { push: clipText(spec.push, ASK_TEXT_MAX) } : {}), choices: cardChoices } : undefined;
    this.open.set(id, { view, card, aliases, resolve, timer });
    this.stats.asked++;
    (this.o.bus ?? events).emit('ask.asked', { id, key: clipText(spec.key, 60), text: view.text, choices: view.choices.map((c) => c.id), default: spec.default, waitS: Math.round(waitMs / 1000) });
    this.log.info(`ask: #${id} ${view.text} (${view.choices.map((c) => `${c.n} ${c.id}`).join(', ')}; unanswered in ${durationText(waitMs / 1000)}: ${spec.default})`);
    this.o.say?.(this.chatLine(view));
    this.changed();
    return { id, answer };
  }

  /** `ask #3: <text> !answer 3 retry|next|stop (!yes retry, !no next; in 2 min: next)` */
  chatLine(v: AskView): string {
    const yes = v.choices.find((c) => c.yes);
    const no = v.choices.find((c) => c.no);
    const yn = [yes ? `${this.pre}yes ${yes.id}` : '', no ? `${this.pre}no ${no.id}` : ''].filter(Boolean).join(', ');
    return `ask #${v.id}: ${v.text} ${this.pre}answer ${v.id} ${v.choices.map((c) => c.id).join('|')}${yn ? ` (${yn})` : ''}; in ${durationText(Math.max(0, v.until - this.now()) / 1000)}: ${v.default}`;
  }

  private settle(o: Open, choice: string, how: AskHow, by?: string): AskAnswer {
    clearTimeout(o.timer);
    this.open.delete(o.view.id);
    const afterMs = Math.max(0, this.now() - o.view.askedAt);
    const a: AskAnswer = { id: o.view.id, choice, how, ...(by ? { by } : {}), afterMs };
    if (how === 'timeout') this.stats.timedOut++;
    else if (how !== 'replaced' && how !== 'closed') this.stats.answered++;
    (this.o.bus ?? events).emit('ask.answered', { id: o.view.id, choice, how, ...(by ? { by: clipText(by, 60) } : {}), afterS: Math.round(afterMs / 100) / 10 });
    this.log.info(how === 'timeout' ? `ask: #${o.view.id} unanswered after ${durationText(afterMs / 1000)}: ${choice} (the default)` : `ask: #${o.view.id} ${how === 'replaced' || how === 'closed' ? how : `answered ${choice}${by ? ` by ${by}` : ''} (${how})`} after ${durationText(afterMs / 1000)}`);
    o.resolve(a);
    this.changed();
    return a;
  }

  /** Track D2: the card words of an open question (undefined: none given, or not open). */
  card(id: number): AskCard | undefined {
    return this.open.get(id)?.card;
  }

  /** The open questions, oldest first. */
  list(): AskView[] {
    return [...this.open.values()].map((o) => o.view).sort((a, b) => a.id - b.id);
  }

  get size(): number {
    return this.open.size;
  }

  /** `!yes` / `!no` answer a question: exactly one open question has a choice with that word. */
  takes(w: 'yes' | 'no'): AskView | undefined {
    const hits = this.list().filter((v) => v.choices.some((c) => (w === 'yes' ? c.yes : c.no)));
    return hits.length === 1 ? hits[0] : undefined;
  }

  /**
   * Answer from the words after `!answer`: `[id] <choice>`, the choice by its word, its number or an alias. With one open
   * question the id may be left out. Returns the reply line.
   */
  answer(args: readonly string[], by: string | undefined, how: AnswerHow): string {
    const list = this.list();
    const a = args.map(word).filter(Boolean);
    if (a.length === 0) {
      if (!list.length) return 'ask: no question waits';
      return list.map((v) => this.chatLine(v)).join(' | ');
    }
    let target: Open | undefined;
    let choiceWord: string | undefined;
    if (a.length >= 2 && /^\d+$/.test(a[0]!)) {
      target = this.open.get(Number(a[0]));
      choiceWord = a[1];
      if (!target) return `ask: no question #${a[0]} waits${list.length ? ` (open: ${list.map((v) => `#${v.id}`).join(', ')})` : ''}`;
    } else {
      if (!list.length) return 'ask: no question waits';
      if (list.length > 1) return `ask: ${list.length} questions wait (${list.map((v) => `#${v.id}`).join(', ')}): ${this.pre}answer <id> <choice>`;
      target = this.open.get(list[0]!.id);
      choiceWord = a[0];
    }
    const o = target!;
    const choice = o.aliases.get(choiceWord!);
    if (!choice) return `ask: #${o.view.id} has no choice ${choiceWord} (${o.view.choices.map((c) => `${c.n} ${c.id}`).join(', ')})`;
    this.settle(o, choice, how, by);
    return `ask: #${o.view.id} answered: ${choice}`;
  }

  /** `!yes` / `!no` on the one question that takes the word (takes() said so). */
  answerWord(w: 'yes' | 'no', by: string | undefined, how: AnswerHow): string {
    const v = this.takes(w);
    if (!v) return `ask: no question takes ${this.pre}${w}`;
    return this.answer([String(v.id), w], by, how);
  }

  /** Close the open question of `key` with its default (the asker no longer needs it). */
  close(key: string): void {
    for (const o of [...this.open.values()]) if (o.view.key === key) this.settle(o, o.view.default, 'closed');
  }

  /** The bot stops: every open question takes its default. */
  dispose(): void {
    for (const o of [...this.open.values()]) this.settle(o, o.view.default, 'closed');
    this.listeners.clear();
  }
}
