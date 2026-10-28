// GET / (Track AE, docs/panel.md): the control panel page. Server-rendered: the structure (the
// inventory grid's 41 cells, the status blocks, the quick buttons, the settings table) plus the
// current state as JSON; the inline script (client.ts, Track AP) fills the nodes from that JSON at
// once and then from /api/state every 2 s. No build step, no external assets: the bot's machine may
// be offline from the internet (glyphs are inline SVG, fonts are the system's). Track AR: the
// settings by group with switches, Reset and the mode bar, the menu / toast / palette containers and
// the panel's own map (a canvas the script draws from /map.json while the section is open).
import { PANEL_SCRIPT } from './client.ts'; // Track AP
import { glyphDefs } from './glyphs.ts'; // Track AP
import { liteState, type PanelSetting, type PanelState } from './state.ts';
import { settingGroups } from '../../chat/help.ts'; // Track AR: the settings groups
import { MODE_KEYS, MODE_NAMES, modeValues } from '../../chat/modes.ts'; // Track AR: the mode selector
import { formatSettingValue } from '../../config/settings.ts'; // Track AR

export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** JSON for a <script type="application/json"> block (no `</script>` breakout). */
const scriptJson = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c');

/** Status blocks (Track AP): the section ids the page always has (tests look for them). */
export const STATUS_BLOCKS = ['panel-inventory', 'panel-vitals', 'panel-status', 'panel-combat', 'panel-memory', 'panel-planner', 'panel-conn'] as const;

/** One inventory cell; the script sets the glyph, colour, letters, count and durability. */
function cell(slot: string, hint: string, extra = ''): string {
  return `<button type="button" class="cell empty${extra}" data-slot="${slot}" title="${hint}"><svg viewBox="0 0 16 16" aria-hidden="true"><use href="#g-item"></use></svg><b class="ab"></b><i class="ct"></i><span class="dur" hidden><span></span></span></button>`;
}

function inventoryHtml(): string {
  const equip = ['head', 'chest', 'legs', 'feet'].map((n, i) => cell(`a${i}`, n, ' eq')).join('') + cell('off', 'offhand', ' eq');
  let main = '';
  for (let i = 9; i < 36; i++) main += cell(`s${i}`, `inventory ${i}`);
  let hot = '';
  for (let i = 0; i < 9; i++) hot += cell(`s${i}`, `hotbar ${i + 1}`);
  return `<div class="inv" id="inventory"><div class="equip" aria-label="armour and offhand">${equip}</div><div class="slots"><div class="grid9" aria-label="inventory">${main}</div><div class="grid9 hotbar" aria-label="hotbar">${hot}</div></div></div>`;
}

const kv = (rows: [string, string][]): string => `<dl class="kv">${rows.map(([id, k]) => `<dt>${k}</dt><dd id="${id}">-</dd>`).join('')}</dl>`;
const bar = (id: string, k: string, cls: string): string => `<div class="bar"><span class="k">${k}</span><span class="track"><span id="b-${id}" class="fill ${cls}"></span></span><span id="v-${id}" class="n">-</span></div>`;

function vitalsHtml(): string {
  return `${bar('health', 'health', 'hp')}${bar('food', 'food', 'fd')}${bar('sat', 'saturation', 'st')}${bar('armour', 'armour', 'ar')}
    <div class="clockrow"><svg id="clock" class="clock" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9"/><path class="sky" d="M1 10a9 9 0 0 1 18 0z"/><line id="clock-hand" x1="10" y1="10" x2="10" y2="3"/></svg>${kv([
      ['v-time', 'time'],
      ['v-pos', 'pos'],
      ['v-dimension', 'dimension'],
      ['v-weather', 'weather'],
      ['v-flight', 'flight'], // Track AU
      ['v-deaths', 'deaths'],
      ['v-lastdeath', 'last death'],
    ])}</div>`;
}

/** Track AR: a text setting whose values are a few words (`reach|near|all`) gets a select. */
export const enumValues = (values: string | undefined): string[] | undefined => (values && /^[a-z]+(\|[a-z]+)+$/.test(values) && !values.includes('version') ? values.split('|') : undefined);

/** One settings row (Track AR): switch / number with bounds / text or choice, the default, Reset, the source. */
function settingRow(r: PanelSetting, group: string): string {
  const k = esc(r.key);
  const choices = r.kind === 'text' ? enumValues(r.values) : undefined;
  const input =
    r.kind === 'boolean'
      ? `<label class="sw"><input type="checkbox" data-key="${k}"${r.value === 'on' ? ' checked' : ''} aria-label="${k}"><span></span></label>`
      : choices
        ? `<select data-key="${k}">${choices.map((c) => `<option${c === r.value ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>`
        : r.kind === 'text'
          ? `<input data-key="${k}" type="text" value="${esc(r.value)}" placeholder="${esc(r.values ?? '')}"> <button class="setbtn" data-key="${k}">set</button>`
          : `<input data-key="${k}" type="number" inputmode="decimal" value="${esc(r.value)}" min="${r.min ?? ''}" max="${r.max ?? ''}" step="any"> <button class="setbtn" data-key="${k}">set</button>`;
  const range = r.kind === 'boolean' ? '' : r.kind === 'text' ? (choices ? '' : (r.values ?? 'text')) : `${r.min}..${r.max}${r.unit ? ` ${r.unit}` : ''}`;
  const changed = r.value !== r.default;
  return `<tr data-row="${k}" data-def="${esc(r.default)}" data-kind="${r.kind}" data-group="${esc(group)}"${changed ? ' class="changed"' : ''}><td><b>${k}</b> <span class="badge" data-src="${k}">${esc(r.source)}</span><div class="muted small">${esc(r.description)}</div></td><td class="nowrap">${input}</td><td class="muted small">${range ? `${esc(range)}<br>` : ''}default ${esc(r.default)} <button class="reset small" data-reset="${k}"${changed ? '' : ' hidden'}>reset</button></td></tr>`;
}

/** The settings by `!help settings` group (Track AR). */
function settingsHtml(s: PanelState): string {
  const byKey = new Map(s.settings.map((r) => [r.key, r]));
  return settingGroups()
    .map(([g, keys]) => {
      const rows = keys.map((k) => byKey.get(k)).filter((r): r is PanelSetting => r !== undefined);
      return rows.length ? `<tr class="grp" data-grp="${esc(g)}"><td colspan="3">${esc(g)}</td></tr>${rows.map((r) => settingRow(r, g)).join('')}` : '';
    })
    .join('');
}

/** The modes as the page compares them (Track AR): [{name, values: {key: "12"}}]. */
export function modesData(): { name: string; values: Record<string, string> }[] {
  return MODE_NAMES.map((m) => {
    const v = modeValues(m);
    return { name: m, values: Object.fromEntries(MODE_KEYS.map((k) => [k, formatSettingValue(k, v[k])])) };
  });
}

/** The map's legend (Track AR; the colours are the script's MAP_COL). */
const LEGEND: [string, string][] = [
  ['#ffffff', 'bot'],
  ['#f5c542', 'path / goal'],
  ['#4ce08a', 'home'],
  ['#c08cff', 'shelter'],
  ['#5cd6ff', 'waypoint'],
  ['#b5793a', 'chest'],
  ['#b0e57c', 'herd'],
  ['#ff5050', 'hostile'],
  ['#e8e8e8', 'player'],
];

function mapHtml(): string {
  return `<div class="maptools small"><label><input type="checkbox" id="map-follow" checked> follow bot</label> <button type="button" id="map-zin" aria-label="zoom in">+</button><button type="button" id="map-zout" aria-label="zoom out">&minus;</button> <select id="map-r" aria-label="radius"><option>4</option><option selected>8</option><option>12</option><option>16</option></select> chunks <span id="map-info" class="muted"></span></div>
    <div id="mapview" class="mapview"><canvas id="mapcv"></canvas><div id="maptip" class="tip" hidden></div></div>
    <div class="legend small muted">${LEGEND.map(([c, n]) => `<span><i style="background:${c}"></i>${n}</span>`).join('')} <span>right-click or long-press: walk here, home, shelter, waypoint</span></div>`;
}

const THEME_BOOT = `(function(){var t=null;try{t=localStorage.getItem('bbpanel-theme')}catch(e){}if(t!=='light'&&t!=='dark'){t=(window.matchMedia&&matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark'}document.documentElement.dataset.theme=t})();`;

const CSS = `
  :root, [data-theme="dark"] { color-scheme: dark; --bg: #111418; --panel: #1b2027; --line: #2c333d; --text: #d8dee6; --muted: #8a94a3; --accent: #f5c542; --ok: #4ce08a; --warn: #f2b134; --bad: #ff7b72;
    --cell: #262c35; --cellline: #3a4350; --input: #2a313b; --track: #0d1014; --hp: #e5534b; --fd: #c98a3c; --st: #e7c64a; --ar: #8fa6c4; --sky: #2f5d8c; }
  [data-theme="light"] { color-scheme: light; --bg: #f2f4f7; --panel: #ffffff; --line: #d9dee5; --text: #1d232b; --muted: #5b6573; --accent: #b07d00; --ok: #1f9d55; --warn: #b7791f; --bad: #cf222e;
    --cell: #e8ebef; --cellline: #c4cad2; --input: #ffffff; --track: #dde1e6; --hp: #d1343a; --fd: #b06f1c; --st: #c9a213; --ar: #5f7ea6; --sky: #8cc4f0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  body { overflow-x: hidden; }
  main { max-width: 1400px; margin: 0 auto; padding: 12px 16px 40px; display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr); }
  @media (min-width: 760px) { main { grid-template-columns: repeat(2, minmax(0, 1fr)); } .wide { grid-column: 1 / -1; } }
  @media (min-width: 1200px) { main { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  header { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; }
  h1 { font-size: 18px; margin: 0; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 8px; }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; min-width: 0; }
  .muted { color: var(--muted); } .small { font-size: 12px; } .nowrap { white-space: nowrap; }
  .grow { flex: 1; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(--bad); margin-right: 6px; }
  .dot.ok { background: var(--ok); }
  .stale { background: var(--bad); color: #fff; border-radius: 10px; padding: 1px 8px; font-size: 12px; font-weight: 600; }
  body.is-stale main > section:not(#panel-commands) { opacity: .55; transition: opacity .3s; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: 12px/1.4 ui-monospace, Menlo, Consolas, monospace; }
  #logs { max-height: 360px; overflow-y: auto; }
  #chat { max-height: 220px; overflow-y: auto; }
  button, input, select { font: inherit; color: var(--text); background: var(--input); border: 1px solid var(--cellline); border-radius: 6px; padding: 6px 10px; }
  button { cursor: pointer; } button:hover { border-color: var(--accent); }
  .quick { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  form.cmd { display: flex; gap: 6px; } form.cmd input { flex: 1; min-width: 0; }
  table { width: 100%; border-collapse: collapse; } td { border-top: 1px solid var(--line); padding: 6px 4px; vertical-align: top; }
  td input { width: 80px; } .tablewrap { max-height: 420px; overflow: auto; }
  #err { color: var(--bad); font-size: 12px; }
  /* Track AR: menus, toast, switches, palette, filters, map */
  .small button, button.small { padding: 3px 8px; font-size: 12px; }
  .menu { position: fixed; z-index: 20; min-width: 200px; max-width: min(300px, calc(100vw - 8px)); background: var(--panel); border: 1px solid var(--cellline); border-radius: 8px; box-shadow: 0 6px 24px #0008; padding: 4px; display: flex; flex-direction: column; gap: 2px; }
  .menu[hidden], .tip[hidden], .pal[hidden], .toast[hidden] { display: none; }
  .menu .mt { font-size: 12px; color: var(--muted); padding: 4px 8px; overflow-wrap: anywhere; }
  .menu .mi { text-align: left; min-height: 40px; border-color: transparent; background: transparent; }
  .menu .mi:hover, .menu .mi:focus { background: var(--cell); }
  .menu .danger { color: var(--bad); } .menu .armed { background: var(--bad); color: #fff; }
  .menu input { margin: 4px; }
  .toast { position: fixed; z-index: 30; left: 50%; bottom: 16px; transform: translateX(-50%); max-width: calc(100vw - 32px); background: var(--text); color: var(--bg); border-radius: 8px; padding: 8px 14px; font-size: 13px; white-space: pre-wrap; box-shadow: 0 4px 16px #0006; }
  .sw { position: relative; display: inline-block; width: 40px; height: 22px; vertical-align: middle; }
  .sw input { opacity: 0; width: 0; height: 0; position: absolute; }
  .sw span { position: absolute; inset: 0; background: var(--track); border: 1px solid var(--cellline); border-radius: 11px; transition: background .2s; }
  .sw span::after { content: ""; position: absolute; left: 2px; top: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--muted); transition: transform .2s; }
  .sw input:checked + span { background: var(--ok); } .sw input:checked + span::after { transform: translateX(18px); background: #fff; }
  .sw input:focus-visible + span { outline: 2px solid var(--accent); }
  tr.grp td { color: var(--accent); text-transform: uppercase; font-size: 12px; letter-spacing: .05em; padding-top: 12px; }
  tr.changed > td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
  .filters, .modes, .maptools, .logtools { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; margin-bottom: 8px; }
  .filters input[type=search], .logtools input { flex: 1; min-width: 120px; }
  button.mode.on { border-color: var(--accent); color: var(--accent); }
  .cmdwrap { position: relative; }
  .pal { position: absolute; z-index: 10; left: 0; right: 0; top: 100%; max-height: 300px; overflow-y: auto; background: var(--panel); border: 1px solid var(--cellline); border-radius: 6px; box-shadow: 0 6px 20px #0007; }
  .pal .ph { font-size: 11px; color: var(--muted); text-transform: uppercase; padding: 4px 8px; }
  .pal button { display: block; width: 100%; text-align: left; border: 0; border-radius: 0; background: transparent; padding: 6px 8px; }
  .pal button:hover { background: var(--cell); }
  .stopbtn { margin-left: 6px; padding: 1px 8px; font-size: 12px; color: var(--bad); }
  .mapview { position: relative; height: 380px; border-radius: 6px; overflow: hidden; background: #0b0d10; touch-action: none; }
  .mapview canvas { position: absolute; inset: 0; width: 100%; height: 100%; cursor: crosshair; }
  .tip { position: absolute; z-index: 5; pointer-events: none; background: #000c; color: #fff; font-size: 12px; padding: 3px 7px; border-radius: 4px; white-space: nowrap; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 6px; }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: middle; border: 1px solid #0006; }
  /* inventory */
  .inv-card { container-type: inline-size; }
  .inv { display: flex; flex-direction: column; gap: 6px; }
  .equip, .grid9 { display: grid; grid-template-columns: repeat(9, minmax(0, 1fr)); gap: 3px; max-width: 440px; }
  .hotbar { margin-top: 6px; }
  @container (min-width: 430px) { .inv { flex-direction: row; align-items: flex-start; } .equip { grid-template-columns: 1fr; width: 44px; flex: none; } .slots { flex: 1; min-width: 0; } }
  .cell { position: relative; aspect-ratio: 1; min-width: 0; padding: 0; background: var(--cell); border: 1px solid var(--cellline); border-radius: 4px; overflow: hidden; }
  .cell svg { position: absolute; left: 17%; top: 17%; width: 66%; height: 66%; fill: currentColor; }
  .cell.empty svg { visibility: hidden; }
  .cell.eq.empty { background-image: linear-gradient(135deg, transparent 46%, var(--cellline) 47%, var(--cellline) 53%, transparent 54%); }
  .cell.sel { border: 2px solid var(--accent); }
  .cell.picked { box-shadow: 0 0 0 2px var(--text) inset; }
  .cell .ab { position: absolute; left: 2px; top: 1px; font: 600 9px/1 system-ui, sans-serif; color: var(--text); opacity: .8; }
  .cell .ct { position: absolute; right: 2px; bottom: 3px; font: 700 11px/1 system-ui, sans-serif; font-style: normal; color: #fff; text-shadow: 0 0 2px #000, 1px 1px 0 #000; }
  .cell .dur { position: absolute; left: 3px; right: 3px; bottom: 2px; height: 3px; background: #000a; border-radius: 2px; }
  .cell .dur > span { display: block; height: 100%; border-radius: 2px; }
  .iteminfo { margin-top: 8px; min-height: 2.8em; white-space: pre-wrap; }
  /* statuses */
  .bar { display: grid; grid-template-columns: 78px minmax(0, 1fr) auto; gap: 8px; align-items: center; margin: 3px 0; }
  .bar .track { height: 10px; background: var(--track); border-radius: 5px; overflow: hidden; }
  .bar .fill { display: block; height: 100%; width: 0; border-radius: 5px; transition: width .4s; }
  .bar .n { font-variant-numeric: tabular-nums; min-width: 52px; text-align: right; }
  .hp { background: var(--hp); } .fd { background: var(--fd); } .st { background: var(--st); } .ar { background: var(--ar); }
  .k { color: var(--muted); }
  .kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 2px 10px; margin: 0; }
  .kv dt { color: var(--muted); } .kv dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .clockrow { display: flex; gap: 12px; align-items: flex-start; margin-top: 8px; }
  .clock { width: 44px; height: 44px; flex: none; }
  .clock circle { fill: var(--track); stroke: var(--line); }
  .clock .sky { fill: var(--sky); opacity: .55; }
  .clock line { stroke: var(--accent); stroke-width: 2; stroke-linecap: round; }
  .clock.night line, .clock.dusk line { stroke: var(--muted); }
  .job { font-weight: 600; margin-bottom: 6px; overflow-wrap: anywhere; }
  ol.stack { margin: 6px 0 8px; padding-left: 20px; } ol.stack li { margin: 3px 0; overflow-wrap: anywhere; }
  .badge { display: inline-block; font-size: 11px; padding: 0 6px; border-radius: 8px; background: var(--cell); border: 1px solid var(--cellline); }
  .st-active { border-color: var(--ok); color: var(--ok); } .st-held, .st-paused { border-color: var(--warn); color: var(--warn); }
  a { color: var(--accent); }
`;

export function renderPanelPage(s: PanelState): string {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>BedrockBot panel</title>
<script>${THEME_BOOT}</script>
<style>${CSS}</style>
</head>
<body data-panel="v${s.v}">
${glyphDefs()}
<main>
  <header class="wide">
    <h1><span id="dot" class="dot${s.bot.healthy ? ' ok' : ''}"></span><span id="botname">${esc(s.bot.name || 'BedrockBot')}</span></h1>
    <span class="muted"><span id="conn">${esc(s.bot.state)}</span> &middot; <span id="server">${esc(s.bot.server)}</span> &middot; task <span id="task">${esc(s.bot.task)}</span> &middot; <span id="ver">${esc(s.bot.gameVersion)}</span></span>
    <span id="stale" class="stale" hidden>stale</span><span id="err"></span>
    <span class="grow"></span><button type="button" id="theme" class="small" aria-label="switch theme">light</button>
  </header>
  <section id="panel-inventory" class="inv-card"><h2>Inventory <span id="inv-sum" class="muted small"></span></h2>${inventoryHtml()}<div id="iteminfo" class="iteminfo muted small">tap or right-click a slot: actions and details</div></section>
  <section id="panel-vitals"><h2>Bot</h2>${vitalsHtml()}</section>
  <section id="panel-status">
    <h2>Status</h2>
    <div class="job" id="job">-</div>
    <div class="small"><button type="button" id="btn-pause">Pause</button> <button type="button" id="btn-resume">Resume</button> <span id="paused" class="muted"></span></div>
    <ol class="stack" id="stack"></ol>
    <pre id="status" class="muted">${esc(s.status.join('\n'))}</pre>
  </section>
  <section id="panel-commands">
    <h2>Commands</h2>
    <div class="quick" id="quick">${s.quick.map((q) => `<button class="q" data-cmd="${esc(q)}">${esc(q)}</button>`).join('')}</div>
    <div class="small" style="margin:-4px 0 8px"><button type="button" id="quick-edit" class="small">edit buttons</button></div>
    <div id="quickbox" hidden><textarea id="quick-text" rows="6" style="width:100%" aria-label="quick buttons, one command per line"></textarea><div class="small"><button type="button" id="quick-save">save</button> <button type="button" id="quick-reset">defaults</button> <span class="muted">one command per line, kept in this browser</span></div></div>
    <div class="cmdwrap"><form class="cmd" id="cmdform" autocomplete="off"><input id="cmd" placeholder="type to search commands, e.g. !goto 10 -60 10" aria-label="command" maxlength="256" autocapitalize="off" spellcheck="false"><button>Send</button></form><div id="palette" class="pal" hidden></div></div>
    <pre id="replies" class="muted" style="margin-top:8px"></pre>
    <h2 style="margin-top:12px">Bot chat</h2>
    <pre id="chat"></pre>
  </section>
  <section id="panel-combat"><h2>Combat</h2>${kv([
    ['c-fights', 'fights'],
    ['c-kills', 'kills'],
    ['c-retargets', 'retargets'],
    ['c-flees', 'flees'],
    ['c-guard', 'guard triggers'],
    ['c-damage', 'damage taken'],
    ['c-lasthit', 'last hit'],
  ])}</section>
  <section id="panel-memory"><h2>Memory</h2>${kv([
    ['m-chests', 'chests'],
    ['m-read', 'chests read'],
    ['m-herds', 'herds'],
    ['m-forests', 'forests'],
    ['m-ores', 'ores seen'],
  ])}<details id="chestbox"><summary class="small"><a href="/api/chests" onclick="return false">chest list</a></summary><div id="chestwrap" class="tablewrap small"></div></details></section>
  <section id="panel-planner"><h2>Planner</h2>${kv([
    ['p-threads', 'threads'],
    ['p-plans', 'plans'],
    ['p-forward', 'forwarding'],
    ['p-crashes', 'crashes'],
  ])}</section>
  <section id="panel-conn"><h2>Connection</h2>${kv([
    ['k-server', 'server'],
    ['k-version', 'version'],
    ['k-state', 'state'],
    ['k-uptime', 'uptime'],
    ['k-reconnects', 'reconnects'],
    ['k-kicks', 'kicks'],
    ['k-last', 'last disconnect'],
  ])}</section>
  <section id="panel-logs"><h2>Log (last 50 lines)</h2><div class="logtools small"><select id="log-level" aria-label="level"><option value="">all levels</option><option value="INFO">info and up</option><option value="WARN">warnings and errors</option><option value="ERROR">errors</option></select><select id="log-mod" aria-label="module"><option value="">all modules</option></select><input id="log-q" type="search" placeholder="filter" aria-label="filter the log"></div><pre id="logs"></pre></section>
  <section class="wide" id="panel-settings"><h2>Settings (!set)</h2>
    <div class="modes">mode <b id="mode-now">-</b> ${MODE_NAMES.map((m) => `<button type="button" class="mode" data-mode="${m}">${m}</button>`).join('')}<span id="mode-diff" class="small muted"></span></div>
    <div class="filters small"><label><input type="checkbox" id="set-changed"> changed only</label><input id="set-q" type="search" placeholder="search settings" aria-label="search settings"></div>
    <div class="tablewrap"><table><tbody id="settings">${settingsHtml(s)}</tbody></table></div></section>
  <section class="wide" id="panel-help">
    <details id="helpbox"><summary><h2 style="display:inline">Help</h2> <span class="muted small">commands, settings, modes (!help in chat)</span></summary><div id="helpwrap" class="tablewrap"></div></details>
  </section>
  <section class="wide" id="panel-map">
    <details id="mapbox"><summary><h2 style="display:inline">Map</h2> <a href="/map" target="_blank" rel="noopener" class="small">open full page</a></summary><div id="mapwrap">${mapHtml()}</div></details>
  </section>
</main>
<div id="menu" class="menu" role="menu" hidden></div>
<div id="toast" class="toast" role="status" hidden></div>
<script type="application/json" id="modes-data">${scriptJson(modesData())}</script>
<script type="application/json" id="initial">${scriptJson(liteState(s))}</script>
<script>
${PANEL_SCRIPT}
</script>
</body>
</html>
`;
}
