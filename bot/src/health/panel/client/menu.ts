// Track AR (wave 10, docs/panel.md "Interaction", decision 0039): the panel's menu model. Pure
// functions that decide which actions an inventory cell, a map column, a setting, a process or a mode
// button offers, every action a chat command (the panel runs nothing else), plus the palette and log
// filters and the offline banner. Decision 0061: a typed browser module the page imports; the server
// (health/panel/menu.ts re-exports it), the unit tests and the panel-actions e2e import the same file,
// so what they check is exactly what the browser runs. No DOM, no Node API.
import type { PanelInventory, PanelItem, PanelLink } from '../shared.ts';

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

const MENU_ARMOUR = ['helmet', 'chestplate', 'leggings', 'boots'];
const MENU_OFFHAND = ['shield', 'totem_of_undying', 'arrow', 'tipped_arrow', 'spectral_arrow', 'firework_rocket', 'nautilus_shell', 'map', 'filled_map', 'empty_map'];
const menuNice = (n: string): string => n.replace(/_/g, ' ');

/** Actions for inventory cell key (s0..s35, a0..a3, off) holding it (or null), given the inventory block. */
export function cellActions(key: string, it: PanelItem | null, inv: Pick<PanelInventory, 'slots' | 'selected'> | null): MenuAction[] {
  const out: MenuAction[] = [];
  const main = key.startsWith('s');
  const slot = main ? Number(key.slice(1)) : -1;
  const hot = main && slot >= 0 && slot < 9;
  const selected = inv ? inv.selected : -1;
  if (hot && slot !== selected) out.push({ id: 'select', label: `Select (hold slot ${slot + 1})`, cmd: `!select ${slot}` });
  if (!it) return out;
  if (key === 'off') {
    out.push({ id: 'offclear', label: 'Back into the inventory', cmd: '!offhand clear' });
    return out;
  }
  if (!main) return out; // worn armour: no command takes one piece off
  const n = it.name;
  // this exact piece (an elytra too: its icon is the chestplate), worn even when worse; !equip = the best again
  if (MENU_ARMOUR.includes(it.icon)) {
    out.push({ id: 'wear', label: n === 'elytra' ? 'Wear this (chest slot)' : 'Wear this', cmd: `!equip slot ${slot}` });
    out.push({ id: 'equip', label: 'Wear the best armour', cmd: '!equip' });
  }
  if (MENU_OFFHAND.includes(n)) out.push({ id: 'offhand', label: 'To the offhand', cmd: `!offhand ${n}` });
  if (it.icon === 'food') out.push({ id: 'eat', label: 'Eat (best food)', cmd: '!eat' });
  if (it.box) out.push({ id: 'box', label: 'Show contents' });
  let total = 0;
  if (inv) for (const s of inv.slots) if (s?.name === n) total += s.count;
  if (total < it.count) total = it.count;
  if (it.count > 1) out.push({ id: 'drop1', label: 'Drop 1', cmd: `!drop ${n} 1` });
  out.push({ id: 'dropstack', label: it.count > 1 ? `Drop the stack (${it.count})` : 'Drop', cmd: `!drop slot ${slot}`, confirm: true }); // this slot only (a bot_loot box too)
  if (total > it.count) out.push({ id: 'dropall', label: `Drop all ${total} ${menuNice(n)}`, cmd: `!drop ${n}`, confirm: true });
  out.push({ id: 'unload', label: 'Unload now', cmd: '!unload' });
  return out;
}

/** A waypoint name as !wp takes it (1..32 of a-z 0-9 _ -), or null. */
export function wpName(s: string | null | undefined): string | null {
  const t = String(s ?? '').trim().toLowerCase();
  return /^[a-z0-9_-]{1,32}$/.test(t) ? t : null;
}

/** A setting row's actions: reset to the default (only when it differs). */
export function settingActions(key: string, value: string | undefined, def: string): MenuAction[] {
  return value === def ? [] : [{ id: 'reset', label: `Reset to ${def}`, cmd: `!set ${key} default` }];
}

/** The command a setting's input sends: booleans from a switch, the rest as typed. */
export function setCommand(key: string, kind: string, v: string | boolean): string {
  return `!set ${key} ${kind === 'boolean' ? (v === true || v === 'on' ? 'on' : 'off') : String(v).trim()}`;
}

/** Whether a settings row shows under the filters (changed only, a search over key / description / group). */
export function settingVisible(row: SettingFilterRow, value: string, changedOnly: boolean, q: string): boolean {
  if (changedOnly && value === row.def) return false;
  const t = String(q || '').trim().toLowerCase();
  return !t || `${row.key} ${row.description ?? ''} ${row.group ?? ''}`.toLowerCase().includes(t);
}

/** The mode the values match (careful / normal / bold), else custom. */
export function modeOf(modes: readonly ModeDef[], values: Record<string, string | undefined>): string {
  for (const m of modes) {
    let same = true;
    for (const k in m.values) if (values[k] !== m.values[k]) same = false;
    if (same) return m.name;
  }
  return 'custom';
}

/** What !mode <name> would change: [{key, from, to}]. */
export function modeChanges(modes: readonly ModeDef[], name: string, values: Record<string, string | undefined>): { key: string; from: string | undefined; to: string }[] {
  const out: { key: string; from: string | undefined; to: string }[] = [];
  for (const m of modes) if (m.name === name) for (const k in m.values) if (values[k] !== m.values[k]) out.push({ key: k, from: values[k], to: m.values[k]! });
  return out;
}

/** A process row's actions: Stop for a user process (!stop ends every user command). */
export function stackActions(e: { kind: string }): MenuAction[] {
  return e.kind === 'user' ? [{ id: 'stop', label: 'Stop', cmd: '!stop' }] : [];
}

/** Palette: commands matching q (name prefix first, then name or help containing it), grouped by tier (front door first). */
export function paletteMatch<C extends PaletteCommand>(cmds: readonly C[], q: string, max = 12): { tier: string; items: C[] }[] {
  const t = String(q || '').trim().toLowerCase().replace(/^!/, '').split(' ')[0]!;
  let scored: { c: C; sc: number }[] = [];
  for (const c of cmds) {
    const n = c.name.toLowerCase();
    const h = `${c.help ?? ''} ${c.group ?? ''}`.toLowerCase();
    const sc = !t ? 2 : n === t ? 0 : n.startsWith(t) ? 1 : n.includes(t) ? 2 : h.includes(t) ? 3 : -1;
    if (sc >= 0) scored.push({ c, sc: sc + (c.tier === 'front' ? 0 : 0.5) });
  }
  scored.sort((a, b) => a.sc - b.sc || (a.c.name < b.c.name ? -1 : 1));
  scored = scored.slice(0, max);
  const groups: { tier: string; items: C[] }[] = [];
  for (const tier of ['front', 'more']) {
    const items = scored.filter((x) => (x.c.tier === 'front' ? 'front' : 'more') === tier).map((x) => x.c);
    if (items.length) groups.push({ tier, items });
  }
  return groups;
}

/** A duration in ms as the banner says it: 12 s, 3 min, 1 h 5 min. */
function menuDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

/** Commands that still work while the bot is not in the game (they answer from the bot's own state). */
const OFFLINE_OK = ['status', 'help', 'set', 'mode', 'panel', 'stop', 'pause', 'resume'];
export function offlineOk(cmd: string | null | undefined): boolean {
  const w = String(cmd ?? '').trim().replace(/^!/, '').split(/\s+/)[0]!.toLowerCase();
  return OFFLINE_OK.includes(w);
}

/** The offline banner. */
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

/**
 * The connection banner for state.link at now (epoch ms); downSince = the first failed poll (the panel
 * itself does not answer), else null. actions: inventory and map actions work; commands: every command
 * (else only OFFLINE_OK ones).
 */
export function linkView(link: PanelLink | null | undefined, now: number, downSince: number | null): LinkView {
  const rows: [string, string][] = [];
  const ago = (t: number): string => `${menuDur(now - t)} ago`;
  const last = link?.lastDisconnect;
  const lastLine = last ? `${last.kind}: ${last.reason}${Date.parse(last.ts) ? ` (${ago(Date.parse(last.ts))})` : ''}` : null;
  if (downSince !== null && downSince !== undefined) {
    rows.push(['no answer for', menuDur(now - downSince)]);
    return { show: true, kind: 'down', title: 'Panel not answering', detail: 'The bot process does not answer (restarting or stopped). This page keeps trying and comes back by itself.', rows, signIn: null, actions: false, commands: false };
  }
  if (!link || link.phase === 'online') return { show: false, kind: 'online', title: '', detail: '', rows, signIn: null, actions: true, commands: true };
  const p = link.phase;
  const since = link.since;
  const v: LinkView = { show: true, kind: 'wait', title: '', detail: '', rows, signIn: null, actions: false, commands: false };
  if (p === 'dead') {
    v.kind = 'dead';
    v.commands = true;
    v.title = 'Dead: respawning';
    v.detail = `Died${link.death ? ` (${link.death.cause})` : ''}. Inventory and map actions wait for the respawn; commands still go through.`;
    if (since) rows.push(['died', ago(since)]);
    rows.push(['respawn', link.retryAt === null ? 'automatic respawn is off (respawn delay negative)' : link.retryAt > now ? `in ${menuDur(link.retryAt - now)}` : 'pressed, waiting for the server']);
    return v;
  }
  if (p === 'signin') {
    const si = link.signIn ?? { url: null, code: null, expiresAt: null, message: null };
    v.title = 'Not signed in';
    v.detail = 'The Realm join waits for the Microsoft sign-in: open the sign-in page and enter the code (the bot keeps the token afterwards).';
    if (si.code) rows.push(['code', si.code]);
    if (si.expiresAt) rows.push(['code expires', si.expiresAt > now ? `in ${menuDur(si.expiresAt - now)}` : 'expired (a new one comes with the next attempt)']);
    if (since) rows.push(['waiting', menuDur(now - since)]);
    v.signIn = { url: si.url === '' ? null : si.url, code: si.code === '' ? null : si.code };
    return v;
  }
  if (p === 'offline') {
    v.kind = 'bad';
    v.title = 'Offline';
    v.detail = 'The connection is closed and is not retried (the bot is stopping). Start the bot again; this page comes back by itself.';
    if (since) rows.push(['closed', ago(since)]);
    if (lastLine) rows.push(['last disconnect', lastLine]);
    return v;
  }
  if (p === 'reconnecting') {
    v.kind = last?.kind === 'kick' ? 'bad' : 'wait';
    v.title = `${last?.kind === 'kick' ? 'Kicked' : 'Disconnected'}: reconnecting`;
    v.detail = 'The bot is not in the game. Inventory, map and most commands come back when it has spawned again.';
    if (lastLine) rows.push(['last disconnect', lastLine]);
    rows.push(['next try', link.retryAt && link.retryAt > now ? `in ${menuDur(link.retryAt - now)} (attempt ${link.attempt})` : `attempt ${link.attempt} running`]);
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
export function parseLog(line: string): { level: string; module: string } {
  const m = /^\S+\s+(DEBUG|INFO|WARN|ERROR)\s+\[([^\]]+)\]/.exec(line);
  return m ? { level: m[1]!, module: m[2]! } : { level: '', module: '' };
}

const LOG_RANK: Record<string, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

/** Whether a log line shows: at least level (''=all), module (''=all), containing q. */
export function logVisible(line: string, level: string, module: string, q: string): boolean {
  const p = parseLog(line);
  if (level && (LOG_RANK[p.level] ?? 1) < (LOG_RANK[level] ?? 0)) return false;
  if (module && p.module !== module) return false;
  return !q || line.toLowerCase().includes(String(q).toLowerCase());
}
