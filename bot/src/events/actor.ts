// Who caused what (decision 0059, docs/events.md "Who did it"): an owner command runs synchronously
// inside Chat.handle, so the command listener (wire.ts) sets the actor before the command's handler
// runs and a microtask clears it after. A job started or stopped while it is set (`!kill zombie`,
// `!stop`) records `by`. The panel marks its own commands with `viaPanel(() => chat.handle(line))`.
export type CommandSource = 'chat' | 'console' | 'panel';

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
