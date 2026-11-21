// Who caused what (decision 0059, docs/events.md "Who did it"): an owner command runs synchronously
// inside Chat.handle, so the command listener (wire.ts) sets the actor before the command's handler
// runs and a microtask clears it after. A job started or stopped while it is set (`!kill zombie`,
// `!stop`) records `by`. The panel marks its own commands with `viaPanel(() => chat.handle(line))`; the Discord bot
// (Track D1, ADR 0118) its own with `viaDiscord`.
export type CommandSource = 'chat' | 'console' | 'panel' | 'discord';

export interface Actor {
  /** The sender label (`Steve`, `console`, the owner name the panel runs as). */
  name: string;
  source: CommandSource;
  command: string;
}

let actor: Actor | undefined;
let panelDepth = 0;

/** Run `fn` as a panel command (the commands it runs record source `panel`). */
export function viaPanel<T>(fn: () => T): T {
  panelDepth++;
  try {
    return fn();
  } finally {
    panelDepth--;
  }
}

/** Inside viaPanel. */
export function fromPanel(): boolean {
  return panelDepth > 0;
}

let discordDepth = 0;

/** Track D1: run `fn` as a command from Discord (the commands it runs record source `discord`). */
export function viaDiscord<T>(fn: () => T): T {
  discordDepth++;
  try {
    return fn();
  } finally {
    discordDepth--;
  }
}

/** Inside viaDiscord. */
export function fromDiscord(): boolean {
  return discordDepth > 0;
}

/** Where a command comes from: Discord, the panel, else the console or the game chat by its sender. */
export function sourceOf(sender: { kind: string }): CommandSource {
  return discordDepth > 0 ? 'discord' : panelDepth > 0 ? 'panel' : sender.kind === 'console' ? 'console' : 'chat';
}

/** The command being handled right now; cleared after the current synchronous run. */
export function setActor(a: Actor): void {
  actor = a;
  queueMicrotask(() => {
    if (actor === a) actor = undefined;
  });
}

export function currentActor(): Actor | undefined {
  return actor;
}
