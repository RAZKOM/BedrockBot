// Natural-language chat commands (PLAN.md 7.18, Track Y; docs/natural-language.md), owner-only like
// every command:
//   !do <text>        ask the model (nl.provider) for a plan of commands; with nlConfirm on (default)
//                     the bot answers `plan: goto home, then guard on (!yes to run, !no to drop)`
//   !yes              run the waiting plan (within 60 s)
//   !no               drop the waiting plan, or the rest of the running one
// and owner chat addressed to the bot (`<botname>, go home`, `@<botname> go home`) goes the same way
// when nl.provider is not `none`. The provider comes from the `nl` config block (config/resolve.ts puts
// it into the task's values under `$nl`); tests inject one under `$nlProvider`.
import { formatSettingValue, SETTING_KEYS } from '../config/settings.ts';
import { NlFrontEnd } from '../nl/executor.ts';
import { addressedText } from '../nl/executor.ts';
import { OllamaProvider } from '../nl/ollama.ts';
import { helpByCommand, type PromptContext } from '../nl/prompt.ts';
import { isNlProvider, NL_PROVIDER_KEY, NL_VALUE_KEY, resolveNlConfig, type NlConfig, type NlProvider } from '../nl/provider.ts';
import { survivalKitOf } from './commands-survival.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import { senderLabel, senderOf } from './chat.ts';

export const NL_COMMANDS = ['do', 'yes', 'no'] as const;

/** The provider for these task values: an injected one, else the `nl` config's (undefined = off). */
export function nlProviderFrom(values: Readonly<Record<string, unknown>>): NlProvider | undefined {
  const injected = values[NL_PROVIDER_KEY];
  if (isNlProvider(injected)) return injected;
  const cfg = (values[NL_VALUE_KEY] as NlConfig | undefined) ?? resolveNlConfig(undefined);
  return cfg.provider === 'ollama' ? new OllamaProvider({ url: cfg.url, model: cfg.model, timeoutMs: cfg.timeoutMs }) : undefined;
}

/** The prompt's view of the bot, read when a request comes in. */
export function nlContext(d: CommandDeps): Omit<PromptContext, 'sender'> {
  const p = d.position();
  const line = d.task.statusLine?.() ?? {};
  const status = [p ? `pos ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}` : 'pos unknown', ...Object.entries(line).map(([k, v]) => `${k} ${v}`)].join(', ');
  const nav = (d.task.status() as { nav?: { waypoints?: { name: string }[] } }).nav;
  return {
    botName: d.selfName(),
    status,
    stack: d.task.processLines?.()[0]?.replace(/^processes: /, '') ?? 'none',
    waypoints: nav?.waypoints?.map((w) => w.name) ?? [],
    inventory: survivalKitOf(d.task)?.summary() ?? 'unknown',
    settings: SETTING_KEYS.map((k) => `${k} ${formatSettingValue(k, d.settings.get(k))}`).join(', '),
    help: helpByCommand(d.chat.helpText(), d.chat.prefix),
  };
}

/** Registers !do, !yes, !no and the addressed-chat listener. Returns the front end (tests). */
export function registerNlCommands(d: CommandDeps, values: Readonly<Record<string, unknown>>): NlFrontEnd {
  const { chat } = d;
  const provider = nlProviderFrom(values);
  const fe = new NlFrontEnd({
    chat,
    provider,
    confirm: () => d.settings.get('nlConfirm'),
    processes: d.processes,
    context: () => nlContext(d),
    log: d.log,
  });
  // every reply goes through chat.say: the executor watches them to know when a step finished
  const say = chat.say.bind(chat);
  chat.say = (m: string) => {
    fe.observeReply(m);
    return say(m);
  };
  const doRe = new RegExp(`^\\s*${chat.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*do\\b`, 'i');
  chat.register({
    name: 'do',
    help: '<text> (plain words -> a plan of commands; !yes runs it; docs/natural-language.md)',
    run: ({ line, sender }) => {
      void fe.request(line.body.replace(doRe, '').trim(), { line, sender: senderLabel(sender) });
    },
  });
  chat.register({
    name: 'yes',
    help: '(run the plan !do proposed)',
    run: ({ sender }) => {
      fe.yes(senderLabel(sender));
    },
  });
  chat.register({
    name: 'no',
    help: '(drop the proposed plan, or the rest of a running one)',
    run: () => {
      fe.no();
    },
  });
  const offLine = provider
    ? chat.onLine((line) => {
        const sender = senderOf(line, d.selfName());
        if (!sender || !d.isOwner(sender)) return;
        const text = addressedText(line.body, d.selfName(), chat.prefix);
        if (text) void fe.request(text, { line, sender: senderLabel(sender) });
      })
    : () => undefined;
  if (provider) d.log.info(`natural language: ${provider.label} (!do, or "${d.selfName()}, ...")`);
  const stop = d.task.stop.bind(d.task);
  d.task.stop = () => {
    offLine();
    fe.dispose();
    stop();
  };
  return fe;
}
