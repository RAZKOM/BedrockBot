// Track AR (wave 10, docs/panel.md "Interaction", decision 0039): the panel's menu model. Pure
// functions that decide which actions an inventory cell, a map column, a setting, a process or a mode
// button offers, every action a chat command (the panel runs nothing else), plus the palette and log
// filters. Written once as plain JavaScript (MENU_JS): the page script embeds it verbatim (client.ts)
// and this module evaluates the same text for the server side and the unit tests, so what the tests
// check is exactly what the browser runs.
import type { PanelInventory, PanelItem } from './inventory.ts';
import type { PanelLink } from './state.ts';

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
  // this exact piece (an elytra too: its icon is the chestplate), worn even when worse; !equip = the best again
  if (MENU_ARMOUR.indexOf(it.icon) >= 0) {
    out.push({ id: 'wear', label: n === 'elytra' ? 'Wear this (chest slot)' : 'Wear this', cmd: '!equip slot ' + slot });
    out.push({ id: 'equip', label: 'Wear the best armour', cmd: '!equip' });
  }
  if (MENU_OFFHAND.indexOf(n) >= 0) out.push({ id: 'offhand', label: 'To the offhand', cmd: '!offhand ' + n });
  if (it.icon === 'food') out.push({ id: 'eat', label: 'Eat (best food)', cmd: '!eat' });
  if (it.box) out.push({ id: 'box', label: 'Show contents' });
  var total = 0;
  if (inv) for (var i = 0; i < inv.slots.length; i++) { var s = inv.slots[i]; if (s && s.name === n) total += s.count; }
  if (total < it.count) total = it.count;
  if (it.count > 1) out.push({ id: 'drop1', label: 'Drop 1', cmd: '!drop ' + n + ' 1' });
  out.push({ id: 'dropstack', label: it.count > 1 ? 'Drop the stack (' + it.count + ')' : 'Drop', cmd: '!drop slot ' + slot, confirm: true }); // this slot only (a bot_loot box too)
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
/** A duration in ms as the banner says it: 12 s, 3 min, 1 h 5 min. */
function menuDur(ms) { var s = Math.max(0, Math.round(ms / 1000)); if (s < 60) return s + ' s'; if (s < 3600) return Math.floor(s / 60) + ' min'; return Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min'; }
/** Commands that still work while the bot is not in the game (they answer from the bot's own state). */
var OFFLINE_OK = ['status', 'help', 'set', 'mode', 'panel', 'stop', 'pause', 'resume'];
function offlineOk(cmd) { var w = String(cmd || '').trim().replace(/^!/, '').split(/\s+/)[0].toLowerCase(); return OFFLINE_OK.indexOf(w) >= 0; }
/**
 * The connection banner for state.link at now (epoch ms); downSince = the first failed poll (the panel
 * itself does not answer), else null. actions: inventory and map actions work; commands: every command
 * (else only OFFLINE_OK ones).
 */
function linkView(link, now, downSince) {
  var rows = [], ago = function (t) { return menuDur(now - t) + ' ago'; };
  var last = link && link.lastDisconnect;
  var lastLine = last ? last.kind + ': ' + last.reason + (Date.parse(last.ts) ? ' (' + ago(Date.parse(last.ts)) + ')' : '') : null;
  if (downSince !== null && downSince !== undefined) {
    rows.push(['no answer for', menuDur(now - downSince)]);
    return { show: true, kind: 'down', title: 'Panel not answering', detail: 'The bot process does not answer (restarting or stopped). This page keeps trying and comes back by itself.', rows: rows, signIn: null, actions: false, commands: false };
  }
  var p = link ? link.phase : 'online';
  if (p === 'online') return { show: false, kind: 'online', title: '', detail: '', rows: rows, signIn: null, actions: true, commands: true };
  var since = link.since, v = { show: true, kind: 'wait', title: '', detail: '', rows: rows, signIn: null, actions: false, commands: false };
  if (p === 'dead') {
    v.kind = 'dead'; v.commands = true;
    v.title = 'Dead: respawning';
    v.detail = 'Died' + (link.death ? ' (' + link.death.cause + ')' : '') + '. Inventory and map actions wait for the respawn; commands still go through.';
    if (since) rows.push(['died', ago(since)]);
    rows.push(['respawn', link.retryAt === null ? 'automatic respawn is off (respawn delay negative)' : link.retryAt > now ? 'in ' + menuDur(link.retryAt - now) : 'pressed, waiting for the server']);
    return v;
  }
  if (p === 'signin') {
    var si = link.signIn || {};
    v.title = 'Not signed in';
    v.detail = 'The Realm join waits for the Microsoft sign-in: open the sign-in page and enter the code (the bot keeps the token afterwards).';
    if (si.code) rows.push(['code', si.code]);
    if (si.expiresAt) rows.push(['code expires', si.expiresAt > now ? 'in ' + menuDur(si.expiresAt - now) : 'expired (a new one comes with the next attempt)']);
    if (since) rows.push(['waiting', menuDur(now - since)]);
    v.signIn = { url: si.url || null, code: si.code || null };
    return v;
  }
  if (p === 'offline') {
    v.kind = 'bad'; v.title = 'Offline';
    v.detail = 'The connection is closed and is not retried (the bot is stopping). Start the bot again; this page comes back by itself.';
    if (since) rows.push(['closed', ago(since)]);
    if (lastLine) rows.push(['last disconnect', lastLine]);
    return v;
  }
  if (p === 'reconnecting') {
    v.kind = last && last.kind === 'kick' ? 'bad' : 'wait';
    v.title = (last && last.kind === 'kick' ? 'Kicked' : 'Disconnected') + ': reconnecting';
    v.detail = 'The bot is not in the game. Inventory, map and most commands come back when it has spawned again.';
    if (lastLine) rows.push(['last disconnect', lastLine]);
    rows.push(['next try', link.retryAt && link.retryAt > now ? 'in ' + menuDur(link.retryAt - now) + ' (attempt ' + link.attempt + ')' : 'attempt ' + link.attempt + ' running']);
    if (since) rows.push(['state since', ago(since)]);
    return v;
  }
  v.title = 'Connecting';
  v.detail = 'Joining the server. Inventory, map and most commands come back when the bot has spawned.';
  if (since) rows.push(['for', menuDur(now - since)]);
  if (lastLine) rows.push(['last disconnect', lastLine]);
  return v;
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

const NAMES = ['cellActions', 'mapActions', 'wpName', 'settingActions', 'setCommand', 'settingVisible', 'modeOf', 'modeChanges', 'stackActions', 'paletteMatch', 'parseLog', 'logVisible', 'linkView', 'offlineOk'] as const;

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

/** The offline banner (linkView in MENU_JS). */
export interface LinkView {
  show: boolean;
  kind: 'online' | 'wait' | 'bad' | 'dead' | 'down';
  title: string;
  detail: string;
  rows: [string, string][];
  signIn: { url: string | null; code: string | null } | null;
  /** Inventory and map actions work. */
  actions: boolean;
  /** Every command works (else only the offlineOk ones). */
  commands: boolean;
}
export const linkView = api.linkView as (link: PanelLink | null, now: number, downSince: number | null) => LinkView;
export const offlineOk = api.offlineOk as (cmd: string) => boolean;
