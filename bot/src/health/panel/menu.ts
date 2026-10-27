// Track AR (wave 10, docs/panel.md "Interaction", decision 0039): the panel's menu model. Pure
// functions that decide which actions an inventory cell, a map column, a setting, a process or a mode
// button offers, every action a chat command (the panel runs nothing else), plus the palette and log
// filters. Written once as plain JavaScript (MENU_JS): the page script embeds it verbatim (client.ts)
// and this module evaluates the same text for the server side and the unit tests, so what the tests
// check is exactly what the browser runs.
import type { PanelInventory, PanelItem } from './inventory.ts';

export interface MenuAction {
  id: string;
  label: string;
  /** The chat command it sends (absent for a local action such as `box`). */
  cmd?: string;
  /** Destructive: the first tap arms it, the second (within 4 s) sends. */
  confirm?: boolean;
  /** `cmd` has a `{name}` the page asks for first (the waypoint name). */
  prompt?: string;
}

export interface PaletteCommand {
  name: string;
  tier: string;
  group?: string;
  syntax?: string;
  help?: string;
  example?: string;
}

/** The menu model as JavaScript (ES2017, no imports); also embedded in the page script. */
export const MENU_JS = String.raw`
var MENU_ARMOUR = ['helmet', 'chestplate', 'leggings', 'boots'];
var MENU_OFFHAND = ['shield', 'totem_of_undying', 'arrow', 'tipped_arrow', 'spectral_arrow', 'firework_rocket', 'nautilus_shell', 'map', 'filled_map', 'empty_map'];
function menuNice(n) { return String(n).replace(/_/g, ' '); }
/** Actions for inventory cell key (s0..s35, a0..a3, off) holding it (or null), given the inventory block. */
function cellActions(key, it, inv) {
  var out = [];
  var main = key.charAt(0) === 's';
  var slot = main ? Number(key.slice(1)) : -1;
  var hot = main && slot >= 0 && slot < 9;
  var selected = inv ? inv.selected : -1;
  if (hot && slot !== selected) out.push({ id: 'select', label: 'Select (hold slot ' + (slot + 1) + ')', cmd: '!select ' + slot });
  if (!it) return out;
  if (key === 'off') { out.push({ id: 'offclear', label: 'Back into the inventory', cmd: '!offhand clear' }); return out; }
  if (!main) return out; // worn armour: no command takes one piece off
  var n = it.name;
  if (MENU_ARMOUR.indexOf(it.icon) >= 0) out.push({ id: 'equip', label: 'Equip (best armour)', cmd: '!equip' });
  if (MENU_OFFHAND.indexOf(n) >= 0) out.push({ id: 'offhand', label: 'To the offhand', cmd: '!offhand ' + n });
  if (it.icon === 'food') out.push({ id: 'eat', label: 'Eat (best food)', cmd: '!eat' });
  if (it.box) out.push({ id: 'box', label: 'Show contents' });
  var total = 0;
  if (inv) for (var i = 0; i < inv.slots.length; i++) { var s = inv.slots[i]; if (s && s.name === n) total += s.count; }
  if (total < it.count) total = it.count;
  if (it.count > 1) out.push({ id: 'drop1', label: 'Drop 1', cmd: '!drop ' + n + ' 1' });
  out.push({ id: 'dropstack', label: it.count > 1 ? 'Drop the stack (' + it.count + ')' : 'Drop', cmd: '!drop ' + n + ' ' + it.count, confirm: true });
  if (total > it.count) out.push({ id: 'dropall', label: 'Drop all ' + total + ' ' + menuNice(n), cmd: '!drop ' + n, confirm: true });
  out.push({ id: 'unload', label: 'Unload now', cmd: '!unload' });
  return out;
}
/** Actions for map column x z: sy = its surface y (null = unknown: the bot's y is used for walking). */
function mapActions(x, z, sy, botY) {
  x = Math.floor(x); z = Math.floor(z);
  var known = sy !== null && sy !== undefined && sy > -32768;
  var fy = known ? sy + 1 : (botY === null || botY === undefined ? null : Math.floor(botY));
  if (fy === null) return [];
  var at = x + ' ' + fy + ' ' + z;
  return [
    { id: 'walk', label: 'Walk here' + (known ? '' : ' (height unknown)'), cmd: '!goto ' + at },
    { id: 'home', label: 'Set home here', cmd: '!home set ' + at, confirm: true },
    { id: 'shelter', label: 'Set shelter here', cmd: '!shelter set ' + at, confirm: true },
    { id: 'wp', label: 'Set waypoint here...', cmd: '!wp set {name} ' + at, prompt: 'waypoint name (a-z 0-9 _ -)' }
  ];
}
/** A waypoint name as !wp takes it (1..32 of a-z 0-9 _ -), or null. */
function wpName(s) { s = String(s || '').trim().toLowerCase(); return /^[a-z0-9_-]{1,32}$/.test(s) ? s : null; }
/** A setting row's actions: reset to the default (only when it differs). */
function settingActions(key, value, def) {
  return value === def ? [] : [{ id: 'reset', label: 'Reset to ' + def, cmd: '!set ' + key + ' default' }];
}
/** The command a setting's input sends: booleans from a switch, the rest as typed. */
function setCommand(key, kind, v) { return '!set ' + key + ' ' + (kind === 'boolean' ? (v === true || v === 'on' ? 'on' : 'off') : String(v).trim()); }
/** Whether a settings row shows under the filters (changed only, a search over key / description / group). */
function settingVisible(row, value, changedOnly, q) {
  if (changedOnly && value === row.def) return false;
  q = String(q || '').trim().toLowerCase();
  return !q || (row.key + ' ' + (row.description || '') + ' ' + (row.group || '')).toLowerCase().indexOf(q) >= 0;
}
/** The mode the values match (careful / normal / bold), else custom. modes: [{name, values}], values: {key: string}. */
function modeOf(modes, values) {
  for (var i = 0; i < modes.length; i++) { var m = modes[i], same = true; for (var k in m.values) if (values[k] !== m.values[k]) same = false; if (same) return m.name; }
  return 'custom';
}
/** What !mode <name> would change: [{key, from, to}]. */
function modeChanges(modes, name, values) {
  var out = [];
  for (var i = 0; i < modes.length; i++) if (modes[i].name === name) for (var k in modes[i].values) if (values[k] !== modes[i].values[k]) out.push({ key: k, from: values[k], to: modes[i].values[k] });
  return out;
}
/** A process row's actions: Stop for a user process (!stop ends every user command). */
function stackActions(e) { return e.kind === 'user' ? [{ id: 'stop', label: 'Stop', cmd: '!stop' }] : []; }
/** Palette: commands matching q (name prefix first, then name or help containing it), grouped by tier (front door first). */
function paletteMatch(cmds, q, max) {
  q = String(q || '').trim().toLowerCase().replace(/^!/, '').split(' ')[0];
  max = max || 12;
  var scored = [];
  for (var i = 0; i < cmds.length; i++) {
    var c = cmds[i], n = c.name.toLowerCase(), h = ((c.help || '') + ' ' + (c.group || '')).toLowerCase();
    var sc = !q ? 2 : n === q ? 0 : n.indexOf(q) === 0 ? 1 : n.indexOf(q) >= 0 ? 2 : h.indexOf(q) >= 0 ? 3 : -1;
    if (sc >= 0) scored.push({ c: c, sc: sc + (c.tier === 'front' ? 0 : 0.5) });
  }
  scored.sort(function (a, b) { return a.sc - b.sc || (a.c.name < b.c.name ? -1 : 1); });
  scored = scored.slice(0, max);
  var groups = [];
  ['front', 'more'].forEach(function (t) { var items = scored.filter(function (x) { return (x.c.tier === 'front' ? 'front' : 'more') === t; }).map(function (x) { return x.c; }); if (items.length) groups.push({ tier: t, items: items }); });
  return groups;
}
/** A log line's level and module (the logger's format: ts LEVEL [module] text). */
function parseLog(line) { var m = /^\S+\s+(DEBUG|INFO|WARN|ERROR)\s+\[([^\]]+)\]/.exec(line); return m ? { level: m[1], module: m[2] } : { level: '', module: '' }; }
var LOG_RANK = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
/** Whether a log line shows: at least level (''=all), module (''=all), containing q. */
function logVisible(line, level, module, q) {
  var p = parseLog(line);
  if (level && (LOG_RANK[p.level] === undefined ? 1 : LOG_RANK[p.level]) < LOG_RANK[level]) return false;
  if (module && p.module !== module) return false;
  return !q || line.toLowerCase().indexOf(String(q).toLowerCase()) >= 0;
}
`;

const NAMES = ['cellActions', 'mapActions', 'wpName', 'settingActions', 'setCommand', 'settingVisible', 'modeOf', 'modeChanges', 'stackActions', 'paletteMatch', 'parseLog', 'logVisible'] as const;

// eslint-disable-next-line @typescript-eslint/no-implied-eval -- the same text the page runs (see the file comment)
const build = new Function(`${MENU_JS}\nreturn { ${NAMES.join(', ')} };`) as () => unknown;
const api = build() as Record<(typeof NAMES)[number], (...a: unknown[]) => unknown>;

export interface SettingFilterRow {
  key: string;
  def: string;
  description?: string;
  group?: string;
}
export interface ModeDef {
  name: string;
  values: Record<string, string>;
}

export const cellActions = api.cellActions as (key: string, it: PanelItem | null, inv: Pick<PanelInventory, 'slots' | 'selected'> | null) => MenuAction[];
export const mapActions = api.mapActions as (x: number, z: number, surfaceY: number | null, botY?: number | null) => MenuAction[];
export const wpName = api.wpName as (s: string) => string | null;
export const settingActions = api.settingActions as (key: string, value: string, def: string) => MenuAction[];
export const setCommand = api.setCommand as (key: string, kind: string, v: string | boolean) => string;
export const settingVisible = api.settingVisible as (row: SettingFilterRow, value: string, changedOnly: boolean, q: string) => boolean;
export const modeOf = api.modeOf as (modes: readonly ModeDef[], values: Record<string, string>) => string;
export const modeChanges = api.modeChanges as (modes: readonly ModeDef[], name: string, values: Record<string, string>) => { key: string; from: string; to: string }[];
export const stackActions = api.stackActions as (e: { kind: string }) => MenuAction[];
export const paletteMatch = api.paletteMatch as (cmds: readonly PaletteCommand[], q: string, max?: number) => { tier: string; items: PaletteCommand[] }[];
export const parseLog = api.parseLog as (line: string) => { level: string; module: string };
export const logVisible = api.logVisible as (line: string, level: string, module: string, q: string) => boolean;
