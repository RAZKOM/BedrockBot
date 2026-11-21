// Which command a line belongs to (Track D2, ADR 0118 addendum "Replies kept to their own command", docs/discord.md
// "Which lines are a command's"). Every command line Chat.handle runs gets a scope: the handler runs inside it, so what
// it says during the call, what its promises and timers say later, and what the user processes it added say (the
// process manager runs them in the scope they were added in) all carry it. A line said outside any scope (a chore, a
// reflex, the night, a reconnect) belongs to no command.
//
//   const s = newScope('discord', '!goto home');
//   chat.handle(line, true, s);           // the handler, its replies, its processes' lines: all in s
//   currentScope() === s                  // in the say() wrappers: is this line that command's?
//
// The scope rides on Node's AsyncLocalStorage, so it follows promise continuations and timers made inside it without
// any caller passing it on. The one way it goes wrong is a long-lived thing made inside a command (a task rebuilt by
// `!mode`, a socket opened by a reconnect): what that says later carries the command's scope. The users bound that by
// time (the Discord follow ends after FOLLOW_MS; a queued job's watch ends with the job) and the places known to do it
// open their resources outside any scope (outsideScope).
import { AsyncLocalStorage } from 'node:async_hooks';

/** Where a command line came from: the game chat, the server console, the panel, Discord, the job queue. */
export type ScopeVia = 'chat' | 'console' | 'panel' | 'discord' | 'queue';

export interface CommandScope {
  /** This run's sequence (never reused while the bot runs). */
  readonly id: number;
  readonly via: ScopeVia;
  /** The command line (cut to 120 characters; for the log and tests). */
  readonly command: string;
  readonly at: number;
}

const store = new AsyncLocalStorage<CommandScope>();
let nextId = 1;

export function newScope(via: ScopeVia, command: string, at = Date.now()): CommandScope {
  return { id: nextId++, via, command: command.length > 120 ? `${command.slice(0, 117)}...` : command, at };
}

/** The command the running code belongs to, or undefined (a line from nobody's command). */
export function currentScope(): CommandScope | undefined {
  return store.getStore();
}

/** Run `fn` in scope `s`; with no scope, outside every scope (so a line is never given to the caller's command). */
export function inScope<T>(s: CommandScope | undefined, fn: () => T): T {
  return s ? store.run(s, fn) : store.exit(fn);
}

/** Run `fn` outside every scope: what it starts (a socket, a timer) belongs to no command. */
export function outsideScope<T>(fn: () => T): T {
  return store.exit(fn);
}
