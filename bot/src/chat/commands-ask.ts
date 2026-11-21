// `!answer` (Track P5, ADR 0116, docs/away.md "Ask the owner"): the owner answers a question the bot asked (tasks/ask.ts)
// from the game chat or the panel (the panel's card sends the same line through POST /api/cmd).
//
//   !answer                    the questions that wait, each with its choices and when the default is taken
//   !answer <choice>           the one open question: by its word (`retry`), its number (`1`) or an alias
//   !answer <id> <choice>      a question by its id (`!answer 3 stop`)
//
// `!yes` and `!no` (chat/commands-nl.ts) answer a question too when no `!do` plan waits and exactly one open question
// has a choice with that word. The box is the task's (askBoxOf): the queue asks through it (askOwner), the panel shows it.
import { sourceOf } from '../events/actor.ts';
import { AskBox, type AnswerHow } from '../tasks/ask.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import { senderLabel, type Sender } from './chat.ts';

const boxes = new WeakMap<object, AskBox>();

/** The task's question box (the queue, `!yes` / `!no`, the panel); undefined before registerAskCommands ran. */
export function askBoxOf(task: object): AskBox | undefined {
  return boxes.get(task);
}

/** How an answer came: Discord (Track D1), the panel's POST /api/cmd, the server console, the game chat. */
export const answerHow = (sender: Sender): AnswerHow => sourceOf(sender);

export function registerAskCommands(d: CommandDeps): AskBox {
  const box = new AskBox({ say: (m) => void d.chat.sayKept(m), log: d.log, prefix: d.chat.prefix });
  boxes.set(d.task, box);
  const stop = d.task.stop.bind(d.task);
  d.task.stop = () => {
    box.dispose();
    boxes.delete(d.task);
    stop();
  };
  d.chat.register({
    name: 'answer',
    help: '[id] <choice> (answer a question the bot asked: its word or number; alone: the questions that wait)',
    tier: 'more',
    group: 'control',
    example: '!answer 1 retry',
    auto: 'a question nobody answers takes its default when its wait runs out (askWaitS), the default being what the bot did before it asked',
    run: ({ reply, args, sender }) => {
      reply(box.answer(args, senderLabel(sender), answerHow(sender)));
    },
  });
  return box;
}
