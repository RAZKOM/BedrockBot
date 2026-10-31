// `!colors`: shows what the chat style looks like in the owner's own client (docs/chat-style.md).
//
// It prints in colour whatever `chatColor` / `chatLines` say, because its job is to answer "does my client
// draw this?" before the settings are turned on. The last line says what the two settings are now.
import type { Chat } from './chat.ts';
import { colorize, Doc, type StyleMode } from './style.ts';

const SHOWN: StyleMode = { color: true, lines: true };

type Route = ReturnType<Chat['routeStatus']>;

/** The one line about the reply route (chat or /tellraw), for the end of `!colors`. */
export function routeLine(route: Route | undefined, prefix = '!'): string {
  if (!route || (route.setting !== 'tellraw' && route.route.state === 'on')) {
    return `replies go out as player chat (chatVia chat; ${prefix}set chatVia tellraw sends /tellraw instead: no <name> in front, but the bot must be an operator)`;
  }
  if (route.via === 'tellraw') return 'replies go out as /tellraw (chatVia tellraw); if a line has no <name> in front, it works';
  const mins = Math.max(1, Math.round((route.route.retryInMs ?? 0) / 60_000));
  return `chatVia tellraw is set but the server refused /tellraw (${route.route.reason ?? 'failed'}): replies go out as chat, tellraw is tried again in ${mins} min (the bot must be an operator)`;
}

/** The messages `!colors` sends (exported for the tests). */
export function colorsDemo(current: StyleMode, prefix = '!', route?: Route): string[] {
  const d = new Doc(current.block ? { ...SHOWN, block: current.block } : SHOWN);
  d.title('chat colours', 'what your client draws');
  d.section('tones');
  d.item(`${prefix}command`, 'a command you can type');
  d.tone('ok', 'green: good news, on');
  d.tone('bad', 'red: bad news, a refusal');
  d.tone('warn', 'yellow: a question, something to look at');
  d.tone('num', '12 -60 340  gold: numbers and coordinates');
  d.tone('name', 'purple: a name (waypoint, item, player)');
  d.dim('gray: context, hints, off');
  d.section('layout', 'a settings block, as !set shows it');
  d.pairs([
    { key: 'fleeHealth', value: '12' },
    { key: 'guardRadius', value: '8' },
    { key: 'sprint', value: 'on' },
    { key: 'allowBreak', value: 'off' },
    { key: 'mineMode', value: 'baritone' },
  ]);
  d.note(`${prefix}set <key> explains one`);
  const replies = [
    'build fill 5x3x5: done, 75 / 75 placed, 0 skipped in 56 s (80 blocks/min)',
    'goto: no path to 100 64 -50 (blacklisted, try !come)',
    'paused: gather (!resume to continue)',
  ];
  const state = `chatColor ${current.color ? 'on' : 'off'}, chatLines ${current.lines ? 'on' : 'off'}`;
  const how = current.color && current.lines ? 'both are on' : `${prefix}set chatColor on and ${prefix}set chatLines on turn them on`;
  return [...d.messages(), replies.map((r) => colorize(r)).join('\n'), `${colorize(`${state} (${how})`)}\n${colorize(routeLine(route, prefix))}`];
}

export function registerStyleCommands(chat: Chat): void {
  chat.register({
    name: 'colors',
    help: '(show the chat colours and layout, to check your client draws them; then !set chatColor on / !set chatLines on)',
    tier: 'more',
    group: 'info',
    example: '!colors',
    run: ({ reply }) => {
      for (const m of colorsDemo(chat.styleMode(), chat.prefix, chat.routeStatus())) reply(m);
    },
  });
}
