// Command tiers, the help formats and the next-step hints (wave 9, Track AM; docs/ux.md, decision 0034).
//
//   !help              the front-door commands by group, one phrase each (at most 3 messages)
//   !help all          every command by group, names only (at most 4 messages); `!commands` too
//   !help <command>    syntax, description, example, the "also on its own" line
//   !help settings     the settings by group with their values, the mode first
//
// Every command carries `tier` / `group` / `example` / `auto` on its CommandDef (chat.ts); a command
// registered without them is `more` in the `control` group, unless its name is in FRONT_DOOR (the
// "needs walking" stubs register only name and help).
import { formatSettingValue, SETTING_DEFS, SETTING_KEYS, type SettingKey } from '../config/settings.ts';
import type { CommandDef, CommandGroup, CommandTier } from './chat.ts';

/**
 * The front door: what `!help` shows. After the wave-9 merge `build` (Track AL), `explore` (Track AI)
 * and `unload` (Track AG) join it (tag their CommandDef `tier: 'front'` and add them here).
 */
export const FRONT_DOOR: readonly string[] = ['come', 'follow', 'stop', 'home', 'get', 'guard', 'build', 'unload', 'status', 'do', 'help']; // merge: + build (Track AL), unload (Track AG)

export const GROUP_ORDER: readonly CommandGroup[] = ['go', 'work', 'fight', 'home', 'control', 'info'];

export interface CommandInfo {
  name: string;
  tier: CommandTier;
  group: CommandGroup;
  /** The registered help, unchanged. */
  help: string;
  /** The arguments part of help (`<item> [n] | stop | status`), may be empty. */
  syntax: string;
  /** The description (help's last parenthesis), or the whole help when it has none. */
  phrase: string;
  example?: string;
  auto?: string;
}

/** `<a> [b] (does this)` -> syntax `<a> [b]`, phrase `does this` (the last top-level parenthesis ending the text). */
export function splitHelp(help: string): { syntax: string; phrase: string } {
  const t = help.trim();
  if (!t.endsWith(')')) return { syntax: t, phrase: '' };
  let depth = 0;
  for (let i = t.length - 1; i >= 0; i--) {
    const c = t[i];
    if (c === ')') depth++;
    else if (c === '(') {
      depth--;
      if (depth === 0) return { syntax: t.slice(0, i).trim(), phrase: t.slice(i + 1, -1).trim() };
    }
  }
  return { syntax: t, phrase: '' };
}

export function commandInfo(def: Pick<CommandDef, 'name' | 'help' | 'tier' | 'group' | 'example' | 'auto'>): CommandInfo {
  const name = def.name.toLowerCase();
  const { syntax, phrase } = splitHelp(def.help);
  return {
    name,
    tier: def.tier ?? (FRONT_DOOR.includes(name) ? 'front' : 'more'),
    group: def.group ?? 'control',
    help: def.help,
    syntax,
    phrase: phrase || syntax,
    ...(def.example ? { example: def.example } : {}),
    ...(def.auto ? { auto: def.auto } : {}),
  };
}

/** What `!help settings` reads (the afk task's RuntimeSettings, and the current mode line from modes.ts). */
export interface HelpSettings {
  get(key: SettingKey): boolean | number | string;
  /** `careful` / `normal` / `bold` / `custom (...)`. */
  mode?: () => string;
}

/** Settings by group for `!help settings` and the panel (a key not listed lands in `other`). */
export const SETTING_GROUPS: readonly (readonly [string, readonly string[]])[] = [
  ['safety', ['fleeHealth', 'guardRadius', 'avoidMobRadius', 'avoidSpawnerRadius']],
  ['walking', ['allowBreak', 'allowPlace', 'closeDoors', 'sprint', 'followDistance', 'plannerThreads']],
  ['work', ['mineSeenOnly', 'mineTunnelLen', 'useBoneMeal', 'toolWearLimit', 'throwawayMin', 'stashChest', 'stashShulker']],
  ['food', ['autoFood', 'foodMin', 'foodLeave', 'autoBreed', 'chorePen']],
];

/** [group, keys] for every setting key that exists (unknown names dropped, the rest in `other`). */
export function settingGroups(): [string, SettingKey[]][] {
  const known = new Set<string>(SETTING_KEYS);
  const used = new Set<string>();
  const out: [string, SettingKey[]][] = [];
  for (const [g, keys] of SETTING_GROUPS) {
    const ks = keys.filter((k) => known.has(k)) as SettingKey[];
    ks.forEach((k) => used.add(k));
    if (ks.length) out.push([g, ks]);
  }
  const rest = SETTING_KEYS.filter((k) => !used.has(k));
  if (rest.length) out.push(['other', rest]);
  return out;
}

/** Pack `parts` into lines of at most `max` characters; each line starts with `first` / `next`. */
export function pack(parts: readonly string[], max: number, first = '', next = '', sep = '; '): string[] {
  const lines: string[] = [];
  let cur = first;
  let fresh = true;
  for (const p of parts) {
    const add = fresh ? p : `${sep}${p}`;
    if (!fresh && cur.length + add.length > max) {
      lines.push(cur);
      cur = `${next}${p}`;
    } else {
      cur += add;
    }
    fresh = false;
  }
  if (!fresh || lines.length === 0) lines.push(cur);
  return lines.map((l) => (l.length > max ? `${l.slice(0, max - 3)}...` : l));
}

function byGroup(infos: readonly CommandInfo[]): [CommandGroup, CommandInfo[]][] {
  const out: [CommandGroup, CommandInfo[]][] = [];
  for (const g of GROUP_ORDER) {
    const list = infos.filter((c) => c.group === g);
    if (list.length) out.push([g, list]);
  }
  return out;
}

export interface HelpOptions {
  prefix?: string;
  /** One chat message (Chat.maxReplyLength). Default 256. */
  maxLength?: number;
  settings?: HelpSettings | undefined;
}

const FOOTER = (p: string, mode: boolean): string => `more: ${mode ? `${p}mode careful|normal|bold, ` : ''}${p}help settings, ${p}help all, ${p}help <command>`;

/** `!help`: the front door by group, one phrase each; the last line names `!help all` and `!help <command>`. At most 3 messages. */
export function frontHelp(infos: readonly CommandInfo[], o: HelpOptions = {}): string[] {
  const p = o.prefix ?? '!';
  const max = o.maxLength ?? 256;
  const front = infos.filter((c) => c.tier === 'front');
  const groups = byGroup(front);
  const footer = FOOTER(p, infos.some((c) => c.name === 'mode'));
  // the full form, then without phrases when the front door outgrows three messages (more front commands after a merge)
  const forms: ((c: CommandInfo) => string)[] = [(c) => `${p}${c.name} (${c.phrase})`, (c) => `${p}${c.name}`];
  let lines: string[] = [];
  for (const form of forms) {
    const parts = groups.map(([g, list]) => `${g}: ${list.map(form).join(', ')}`);
    const body = pack(parts, max, 'front door: ', '', ' | ');
    if (body.length <= 2) return [...body, footer]; // the footer on a line of its own
    lines = pack([...parts, footer], max, 'front door: ', '', ' | ');
    if (lines.length <= 3) break;
  }
  // never more than 3: the footer (the way to the rest) is kept as the last line
  return lines.length <= 3 ? lines : [...lines.slice(0, 2), footer];
}

/** `!help all` / `!commands`: every command by group, names only (front-door names first in each group). At most 4 messages. */
export function allHelp(infos: readonly CommandInfo[], o: HelpOptions = {}): string[] {
  const p = o.prefix ?? '!';
  const max = o.maxLength ?? 256;
  const parts = byGroup(infos).map(([g, list]) => {
    const sorted = [...list].sort((a, b) => (a.tier === b.tier ? 0 : a.tier === 'front' ? -1 : 1));
    return `${g}: ${sorted.map((c) => c.name).join(' ')}`;
  });
  const lines = pack(parts, max, `all commands (${infos.length}): `);
  const tail = `; ${p}help <command> explains one`;
  if (lines.length < 4 && lines[lines.length - 1]!.length + tail.length <= max) lines[lines.length - 1] += tail;
  return lines.slice(0, 4);
}

/** `!help <command>`: syntax and description, the example, the "also on its own" line. */
export function commandHelp(info: CommandInfo, o: HelpOptions = {}): string[] {
  const p = o.prefix ?? '!';
  const max = o.maxLength ?? 256;
  const head = `${p}${info.name}${info.syntax && info.syntax !== info.phrase ? ` ${info.syntax}` : ''}: ${info.phrase} [${info.group}, ${info.tier === 'front' ? 'front door' : 'more'}]`;
  const lines = [head];
  lines.push(`example: ${info.example ?? `${p}${info.name}`}`);
  if (info.auto) lines.push(`also on its own: ${info.auto}`);
  return lines.map((l) => (l.length > max ? `${l.slice(0, max - 3)}...` : l));
}

/** `!help settings`: the mode first, then the settings by group with their current values. */
export function settingsHelp(s: HelpSettings | undefined, o: HelpOptions = {}): string[] {
  const p = o.prefix ?? '!';
  const max = o.maxLength ?? 256;
  if (!s) return [`settings need a task with runtime settings (the afk task); ${p}help all lists the commands`];
  const parts = [`mode ${s.mode?.() ?? 'unknown'} (${p}mode careful|normal|bold)`];
  for (const [g, keys] of settingGroups()) parts.push(`${g}: ${keys.map((k) => `${k} ${formatSettingValue(k, s.get(k))}`).join(', ')}`);
  const lines = pack(parts, max, 'settings: ');
  const tail = `; ${p}set <key> explains one`;
  if (lines[lines.length - 1]!.length + tail.length <= max) lines[lines.length - 1] += tail;
  return lines;
}

/** Every `!help` form. */
export function helpReplies(infos: readonly CommandInfo[], args: readonly string[], o: HelpOptions = {}): string[] {
  const p = o.prefix ?? '!';
  const a = (args[0] ?? '').toLowerCase().replace(/^!+/, '');
  if (a === '') return frontHelp(infos, o);
  if (a === 'all' || a === 'commands') return allHelp(infos, o);
  if (a === 'settings' || a === 'setting') return settingsHelp(o.settings, o);
  const info = infos.find((c) => c.name === a);
  if (!info) return [`no command ${p}${a}; ${p}help all lists every command`];
  return commandHelp(info, o);
}

// ---- next-step hints (exactly three rules; docs/ux.md "Hints") ------------------------------------

/** What the hint rules look at besides the reply text (read live when a reply goes out). */
export interface HintFacts {
  /** Free slots of the 36 inventory slots. */
  freeSlots: number;
  /** Raw food items carried. */
  rawFood: number;
  /** A furnace or smoker is known within 16 blocks of home. */
  furnaceNearHome: boolean;
  /** `!unload` exists (Track AG, after the merge). */
  hasUnload: boolean;
}

/** End of a !mine / !gather / !food job (the replies those jobs end with). */
const JOB_END = /^(mine \S+: (\d+\/\d+|stopped)|gather \w+: \d+\/\d+ logs|food: (\d+\/\d+ items|stopped after))/;
const FOOD_END = /^food: \d+\/\d+ items/;
const GET_UNKNOWN = 'get: I do not know how to get ';

/**
 * The hint to append to `reply`, or undefined (pure):
 *   1. a mine / gather / food job ends with fewer than 4 free slots: `(!unload at home)`, or
 *      `(inventory nearly full)` while `!unload` does not exist;
 *   2. a food run ends with raw food carried and no furnace within 16 of home: `(no furnace within 16 of home: raw)`;
 *   3. `!get <unknown>`: nothing (its categories line already says what works; it stays one message).
 * Rule 1 wins over rule 2 (one hint per reply).
 */
export function hintFor(reply: string, f: HintFacts, prefix = '!'): string | undefined {
  if (reply.startsWith(GET_UNKNOWN)) return undefined; // rule 3
  if (!JOB_END.test(reply)) return undefined;
  if (f.freeSlots < 4) return f.hasUnload ? `(${prefix}unload at home)` : '(inventory nearly full)'; // rule 1
  if (FOOD_END.test(reply) && f.rawFood > 0 && !f.furnaceNearHome && !reply.includes('no furnace')) return '(no furnace within 16 of home: raw)'; // rule 2
  return undefined;
}

/** One setting's row for the panel's Help tab. */
export function settingDescription(key: SettingKey): string {
  return SETTING_DEFS[key].description;
}
