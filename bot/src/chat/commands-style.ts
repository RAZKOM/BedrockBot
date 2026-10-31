// `!colors`: shows what the chat style looks like in the owner's own client (docs/chat-style.md).
//
// It prints in colour whatever `chatColor` / `chatLines` say, because its job is to answer "does my client
// draw this?" before the settings are turned on. The last line says what the two settings are now.
import type { Chat } from './chat.ts';
import { ROUTE_INFO } from './route.ts';
import { colorize, Doc, type StyleMode } from './style.ts';

const SHOWN: StyleMode = { color: true, lines: true };

type Route = ReturnType<Chat['routeStatus']>;

/** What `chatVia` offers, one line, for `!colors` while replies still go out as player chat. */
function viaChoices(prefix: string): string {
  return `${prefix}set chatVia me (* Bot text, no operator needed), say ([Bot] text, operator) or tellraw (no name in front, operator)`;
}

/** The one line about the reply route (chat, /me, /say or /tellraw), for the end of `!colors`. */
export function routeLine(route: Route | undefined, prefix = '!'): string {
  if (!route || (route.setting === 'chat' && route.route.state === 'on')) {
    return `replies go out as player chat (chatVia chat; ${viaChoices(prefix)} instead)`;
  }
  if (route.via !== 'chat') {
    const info = ROUTE_INFO[route.via];
    return `replies go out as /${route.via} (chatVia ${route.via}; they look like "${info.shows}"${info.needsOp ? ', the bot has to be an operator' : ''}); a line that looks like that means it works`;
  }
  const mins = Math.max(1, Math.round((route.route.retryInMs ?? 0) / 60_000));
  const needs = route.setting === 'me' ? '' : ' (the bot must be an operator)';
  return `chatVia ${route.setting} is set but the server refused it (${route.route.reason ?? 'failed'}): replies go out as chat, it is tried again in ${mins} min or when you type ${prefix}colors${needs}`;
}

/** The messages `!colors` sends (exported for the tests). */
export function colorsDemo(current: StyleMode, prefix = '!', route?: Route): string[] {
  const d = new Doc(current.tellraw ? { ...SHOWN, tellraw: true } : SHOWN);
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
      chat.retryRoute(); // `!colors` is also the retest of chatVia tellraw: the demo below is the test message
      for (const m of colorsDemo(chat.styleMode(), chat.prefix, chat.routeStatus())) reply(m);
    },
  });
}
