// Fakes for the natural-language unit tests (Track Y): a chat with scripted commands and a process list.
import type { CommandEvent } from '../../../src/chat/chat.ts';
import type { ChatLine } from '../../../src/chat/text.ts';
import { NlFrontEnd, type NlChat, type NlFrontEndOptions } from '../../../src/nl/executor.ts';
import { FakeProvider, type FakeRule } from '../../../src/nl/fake.ts';
import type { PromptContext } from '../../../src/nl/prompt.ts';

export type FakeCommand = (args: string[], reply: (m: string) => void) => void;

export class FakeChat implements NlChat {
  readonly prefix = '!';
  readonly said: string[] = [];
  readonly handled: string[] = [];
  readonly commands = new Map<string, FakeCommand>();
  private readonly listeners = new Set<(e: CommandEvent) => void>();
  observer: ((m: string) => void) | undefined;

  commandNames(): string[] {
    return [...this.commands.keys()];
  }

  helpText(): string {
    return [...this.commands.keys()].map((n) => `!${n} (help of ${n})`).join(' | ');
  }

  handle(line: ChatLine): void {
    this.handled.push(line.body);
    const [name, ...args] = line.body.slice(1).split(' ');
    const def = this.commands.get(name!);
    if (!def) {
      this.say(`unknown command !${name}; try !help`);
      return;
    }
    for (const fn of this.listeners) fn({ kind: 'run', name: name!, sender: { kind: 'console' } });
    def(args, (m) => this.say(m));
  }

  /** An owner typing a command themselves (not through the plan). */
  ownerCommand(name: string): void {
    for (const fn of this.listeners) fn({ kind: 'run', name, sender: { kind: 'console' } });
  }

  say(m: string): boolean {
    this.said.push(m);
    this.observer?.(m);
    return true;
  }

  onCommand(fn: (e: CommandEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const consoleLine = (body: string): ChatLine => ({ type: 'whisper', source: 'Server', message: body, body, xuid: '', truth: false });
export const playerLine = (name: string, body: string): ChatLine => ({ type: 'chat', source: name, message: body, body, xuid: '', truth: false });

export const WAYPOINTS = ['home', 'base', 'farm', 'mine'];

export function context(): Omit<PromptContext, 'sender'> {
  return {
    botName: 'Bot',
    status: 'pos 0.5 -60.0 0.5, task afk, behaviour idle',
    stack: 'idle',
    waypoints: WAYPOINTS,
    inventory: 'inv 3/36, held 0 iron_sword x1',
    settings: 'guardRadius 16, nlConfirm on',
    help: new Map([['goto', '!goto <waypoint> | x y z (walk)']]),
  };
}

/** Every plan command answers at once (and the walking ones `arrived`); a user process list to fake waiting. */
export function standardCommands(chat: FakeChat): void {
  const instant = (reply: string): FakeCommand => (_a, r) => r(reply);
  chat.commands.set('goto', (a, r) => r(`arrived at ${a.join(' ')}`));
  chat.commands.set('come', (a, r) => r(`here (${a[0] ?? 'you'})`));
  chat.commands.set('follow', (a, r) => r(`following ${a[0] ?? 'you'}`));
  chat.commands.set('stop', instant('stopped (was idle); idle'));
  chat.commands.set('guard', (a, r) => r(`guard ${a[0]}`));
  chat.commands.set('kill', (a, r) => r(`kill ${a[0]}: ${a[1]}/${a[1]} done`));
  chat.commands.set('gather', (a, r) => r(`gathering ${a[0]} logs`));
  chat.commands.set('mine', (a, r) => r(`mine ${a[0]}: ${a[1]}/${a[1]} done`));
  chat.commands.set('farm', instant('farming r=8 around 0 -60 0'));
  chat.commands.set('eat', instant('ate bread: food 10 -> 15'));
  chat.commands.set('equip', instant('equip: wearing nothing new'));
  chat.commands.set('wp', (a, r) => r(`waypoint ${a[1]} set to 0 -60 0`));
  chat.commands.set('set', (a, r) => r(`${a[0]} = ${a[1]} (was x)`));
  chat.commands.set('pause', instant('nothing to pause'));
  chat.commands.set('resume', instant('nothing paused'));
  chat.commands.set('food', instant('getting food'));
  chat.commands.set('sleep', instant('sleeping'));
}

export function makeFrontEnd(rules: readonly FakeRule[], opts: Partial<NlFrontEndOptions> & { chat?: FakeChat; procs?: unknown[] } = {}) {
  const chat = opts.chat ?? new FakeChat();
  const procs = opts.procs ?? [];
  const provider = new FakeProvider(rules);
  const fe = new NlFrontEnd({
    chat,
    provider,
    confirm: () => true,
    processes: { userProcesses: () => procs },
    context,
    settleMs: 10,
    pollMs: 2,
    ...opts,
  });
  chat.observer = (m) => fe.observeReply(m);
  return { chat, fe, provider, procs };
}

export const until = async (fn: () => boolean, ms = 2000): Promise<void> => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 2));
  }
};
