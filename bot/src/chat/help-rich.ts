// The multi-line forms of `!help` and `!set` (docs/chat-style.md, decision 0050): the same content as
// help.ts, laid out as a Doc (title, a heading per group, one command or a few settings per line, a footer
// note) instead of lines packed to 256 characters.
//
// Used when the `chatLines` setting is on (Chat.helpReplies, `!set`). The plain forms in help.ts stay as they
// are: they are what the tests and the panel compare, and what runs when `chatLines` is off.
//
// Nothing here is hand-listed per command or per setting: commands come from the registered CommandDefs
// (tier, group, help, example, auto) and settings from SETTING_DEFS grouped by SETTING_GROUPS. A new command
// or setting shows up with the right heading without anyone touching this file.
import { formatSettingValue, SETTING_KEYS } from '../config/settings.ts';
import { byGroup, FOOTER, settingGroups, type CommandInfo, type HelpOptions, type HelpSettings } from './help.ts';
import { Doc, type StyleMode } from './style.ts';

export interface RichHelpOptions extends HelpOptions {
  mode: StyleMode;
}

/** `!help`: the front door, a heading per group, one command per line with its phrase. */
export function richFront(infos: readonly CommandInfo[], o: RichHelpOptions): string[] {
  const p = o.prefix ?? '!';
  const d = new Doc(o.mode);
  d.title('commands', 'what you can ask me');
  for (const [g, list] of byGroup(infos.filter((c) => c.tier === 'front'))) {
    d.section(g);
    for (const c of list) d.item(`${p}${c.name}`, c.phrase);
  }
  d.note(FOOTER(p, infos.some((c) => c.name === 'mode')));
  return d.messages();
}

/** `!help all` / `!commands`: every command by group, names only, front-door names first in each group. */
export function richAll(infos: readonly CommandInfo[], o: RichHelpOptions): string[] {
  const p = o.prefix ?? '!';
  const d = new Doc(o.mode);
  d.title('all commands', `${infos.length}`);
  for (const [g, list] of byGroup(infos)) {
    const sorted = [...list].sort((a, b) => (a.tier === b.tier ? 0 : a.tier === 'front' ? -1 : 1));
    d.section(g);
    d.tokens(sorted.map((c) => `${p}${c.name}`));
  }
  d.note(`${p}help <command> explains one`);
  return d.messages();
}

/** `!help <command>`: the command, what it does, where it sits, an example, what it also does on its own. */
export function richCommand(info: CommandInfo, o: RichHelpOptions): string[] {
  const p = o.prefix ?? '!';
  const d = new Doc(o.mode);
  d.item(`${p}${info.name}`, info.syntax && info.syntax !== info.phrase ? info.syntax : '');
  d.line(info.phrase);
  d.dim(`${info.group} · ${info.tier === 'front' ? 'front door' : 'more'}`);
  d.line(`example: ${info.example ?? `${p}${info.name}`}`);
  if (info.auto) d.line(`also on its own: ${info.auto}`);
  return d.messages();
}

/** `!help settings` and a bare `!set`: the mode, then every setting by group with its value. */
export function richSettings(s: HelpSettings | undefined, o: RichHelpOptions): string[] {
  const p = o.prefix ?? '!';
  if (!s) return [`settings need a task with runtime settings (the afk task); ${p}help all lists the commands`];
  const d = new Doc(o.mode);
  const mode = s.mode?.();
  d.title('settings', `${SETTING_KEYS.length}${mode ? ` · mode ${mode}` : ''}`);
  for (const [g, keys] of settingGroups()) {
    d.section(g);
    d.pairs(keys.map((k) => ({ key: k, value: formatSettingValue(k, s.get(k)) })));
  }
  d.note(`${p}set <key> explains one · ${p}set <key> <value> changes it · ${p}set <key> default resets it`);
  return d.messages();
}

/** Every `!help` form, as Docs. Same dispatch as help.ts helpReplies. */
export function richHelpReplies(infos: readonly CommandInfo[], args: readonly string[], o: RichHelpOptions): string[] {
  const p = o.prefix ?? '!';
  const a = (args[0] ?? '').toLowerCase().replace(/^!+/, '');
  if (a === '') return richFront(infos, o);
  if (a === 'all' || a === 'commands') return richAll(infos, o);
  if (a === 'settings' || a === 'setting') return richSettings(o.settings, o);
  const info = infos.find((c) => c.name === a);
  if (!info) return [`no command ${p}${a}; ${p}help all lists every command`];
  return richCommand(info, o);
}
