// GET / (Track AE, docs/panel.md): the control panel page. Server-rendered: the structure (the
// inventory grid's 41 cells, the status blocks, the quick buttons, the settings table) plus the
// current state as JSON; the page's browser modules (client/, decision 0061: type-stripped TypeScript
// served by assets.ts, the entry named in one <script type="module">) fill the nodes from that JSON at
// once and then from the push channel (/api/stream) or the poll. No build step, no external assets:
// the bot's machine may be offline from the internet (glyphs are inline SVG, fonts are the system's;
// the item pictures are the panel's own /icons/<name>.png, decision 0046, and a cell keeps its glyph
// without one). Track AR: the settings by group with switches, Reset and the mode bar, the menu /
// toast / palette containers and the panel's own map (a canvas drawn from /map.json while open).
import { clientModules, ENTRY_MODULE } from './assets.ts'; // decision 0061
import { THEME_KEY, VIEW_KEY } from './shared.ts';
import { MAP_LAYERS, MAP_OVERLAYS } from './client/mapdefs.ts'; // decision 0062: the map screen's switches
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

/** One inventory cell; the script sets the glyph, colour, letters, count and durability, and the picture when the server has one (decision 0046). */
function cell(slot: string, hint: string, extra = ''): string {
  return `<button type="button" class="cell empty${extra}" data-slot="${slot}" title="${hint}"><svg viewBox="0 0 16 16" aria-hidden="true"><use href="#g-item"></use></svg><img class="ic" alt="" hidden><b class="ab"></b><i class="ct"></i><span class="dur" hidden><span></span></span></button>`;
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

/**
 * Decision 0062: the map screen (client/mapview.ts; docs/map.md). A fixed full-screen layer over the
 * cards: the canvas, the HUD (health, food, job + ETA, Stop), the controls, the layers / overlays panel
 * (switches from mapdefs.ts, so a new overlay needs no markup), the Y-slice bar and the action sheet.
 */
function mapScreenHtml(): string {
  const btn = (id: string, label: string, aria: string, cls = ''): string => `<button type="button" id="${id}"${cls ? ` class="${cls}"` : ''} aria-label="${aria}" title="${aria}">${label}</button>`;
  const layers = MAP_LAYERS.map((l) => `<label><input type="radio" name="map-layer" data-layer="${l.id}"${l.id === 'surface' ? ' checked' : ''}> ${esc(l.label)}</label>`).join('');
  const ovs = MAP_OVERLAYS.map((o) => `<label><input type="checkbox" data-ov="${o.id}"${o.on ? ' checked' : ''}><i style="background:${o.colour}"></i>${esc(o.label)}</label>`).join('');
  return `<div id="mapscreen" class="mapscreen">
  <canvas id="mapcv" aria-label="map of the world around the bot"></canvas>
  <div class="hud" id="hud">
    <div class="hudrow"><span class="track"><span id="hud-hpbar" class="fill hp"></span></span><b id="hud-hp">-</b><span class="track"><span id="hud-foodbar" class="fill fd"></span></span><b id="hud-food">-</b></div>
    <div class="hudrow"><span id="hud-job" class="hudjob">idle</span>${btn('hud-stop', 'Stop', 'stop the current job (!stop)', 'danger')}</div>
  </div>
  <div class="mapctl">
    ${btn('view-cards', 'Cards', 'show the cards')}
    ${btn('map-follow', '&#9678;', 'follow the bot (re-centre)', 'on')}
    ${btn('map-zin', '+', 'zoom in')}
    ${btn('map-zout', '&minus;', 'zoom out')}
    ${btn('map-box', '&#9633;', 'box mode: drag a box for clear, fill, quarry')}
    ${btn('map-layers-btn', '&#9776;', 'layers and overlays')}
  </div>
  <div id="map-layers" class="maplayers small" hidden>
    <div class="lh">layer</div><div class="opts">${layers}</div>
    <div class="lh">overlays</div><div class="opts">${ovs}</div>
    <div class="opts"><label><input type="checkbox" id="map-tex" checked> textures when zoomed in</label> <a href="/map" target="_blank" rel="noopener">debug map</a></div>
  </div>
  <div id="map-slice" class="mapslice" hidden>${btn('map-ydown', '&minus;', 'one block lower')}<input type="range" id="map-y" min="-64" max="319" value="64" aria-label="slice height">${btn('map-yup', '+', 'one block higher')}<b id="map-yv">y 64</b></div>
  <div id="map-status" class="mapstatus small"></div>
  <div id="map-sheet" class="sheet" role="dialog" aria-label="map actions" hidden>
    <div class="sheethead"><b id="sheet-title"></b>${btn('sheet-close', '&times;', 'close')}</div>
    <div id="sheet-body" class="small"></div>
    <div id="sheet-box" class="small sheetbox" hidden><label>y <input id="box-y1" type="number" inputmode="numeric"></label><label>to <input id="box-y2" type="number" inputmode="numeric"></label><select id="box-block" aria-label="block to place"></select><span id="box-size" class="muted"></span></div>
    <div id="sheet-acts" class="acts"></div>
    <div id="sheet-confirm" class="confirm" hidden><input id="sheet-name" maxlength="32" autocapitalize="off" spellcheck="false" aria-label="name" hidden><pre id="sheet-cmd"></pre><div>${btn('sheet-send', 'Send', 'send this command', 'primary')} ${btn('sheet-cancel', 'Cancel', 'do not send')}</div></div>
    <pre id="sheet-reply" class="small muted"></pre>
  </div>
</div>`;
}

const THEME_BOOT = `(function(){var t=null;try{t=localStorage.getItem('${THEME_KEY}')}catch(e){}if(t!=='light'&&t!=='dark'){t=(window.matchMedia&&matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark'}document.documentElement.dataset.theme=t})();`;
/** Decision 0062: the view (map / cards) before the first paint, so the page does not flash the other one. */
const VIEW_BOOT = `(function(){var v=null;try{v=localStorage.getItem('${VIEW_KEY}')}catch(e){}document.documentElement.dataset.view=v==='cards'?'cards':'map'})();`;

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
  body.is-stale main > section:not(#panel-commands):not(#panel-link) { opacity: .55; transition: opacity .3s; }
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
  /* decision 0062: the map screen (fixed, full screen; the cards stay in the page behind it) */
  [data-view="map"] main { display: none; }
  [data-view="cards"] #mapscreen { display: none; }
  .mapscreen { position: fixed; inset: 0; z-index: 5; background: #0b0d10; color: #e6eaf0; overflow: hidden; touch-action: none; user-select: none; -webkit-user-select: none; }
  .mapscreen canvas { position: absolute; inset: 0; width: 100%; height: 100%; cursor: crosshair; touch-action: none; }
  .mapscreen button { background: #1b2027e6; color: #e6eaf0; border-color: #3a4350; min-width: 40px; min-height: 40px; padding: 4px 8px; }
  .mapscreen button.on { border-color: var(--accent); color: var(--accent); }
  .mapscreen button.danger { color: #ff7b72; } .mapscreen button.primary { border-color: var(--accent); }
  .hud { position: absolute; left: 8px; top: 8px; max-width: calc(100% - 72px); background: #111418d9; border: 1px solid #2c333d; border-radius: 8px; padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
  .hudrow { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .hud .track { width: 54px; height: 8px; background: #0d1014; border-radius: 4px; overflow: hidden; flex: none; }
  .hud .fill { display: block; height: 100%; width: 0; } .hud b { min-width: 18px; font-variant-numeric: tabular-nums; }
  .hudjob { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hud button { min-height: 30px; padding: 2px 10px; }
  .mapctl { position: absolute; right: 8px; top: 8px; display: flex; flex-direction: column; gap: 6px; }
  .maplayers { position: absolute; right: 60px; top: 8px; max-width: min(300px, calc(100% - 76px)); max-height: calc(100% - 16px); overflow-y: auto; background: #111418f0; border: 1px solid #2c333d; border-radius: 8px; padding: 8px 10px; }
  .maplayers[hidden], .mapslice[hidden], .sheet[hidden], .sheet [hidden] { display: none; }
  .maplayers .lh { color: #8a94a3; text-transform: uppercase; font-size: 11px; margin: 4px 0 2px; }
  .maplayers .opts { display: flex; flex-wrap: wrap; gap: 4px 10px; } .maplayers label { white-space: nowrap; }
  .maplayers i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin: 0 4px 0 2px; vertical-align: middle; border: 1px solid #0006; }
  .mapslice { position: absolute; left: 8px; right: 64px; bottom: 30px; display: flex; gap: 6px; align-items: center; background: #111418d9; border-radius: 8px; padding: 4px 6px; }
  .mapslice input { flex: 1; min-width: 0; }
  .mapstatus { position: absolute; left: 8px; bottom: 6px; color: #8a94a3; pointer-events: none; text-shadow: 0 0 2px #000; }
  .sheet { position: absolute; left: 0; right: 0; bottom: 0; max-height: 62%; overflow-y: auto; background: #1b2027f5; border-top: 1px solid #3a4350; border-radius: 12px 12px 0 0; padding: 10px 12px 14px; display: flex; flex-direction: column; gap: 8px; user-select: text; -webkit-user-select: text; }
  @media (min-width: 760px) { .sheet { left: auto; right: 64px; bottom: 8px; width: 380px; border-radius: 10px; border: 1px solid #3a4350; } }
  .sheethead { display: flex; align-items: center; gap: 8px; } .sheethead b { flex: 1; overflow-wrap: anywhere; }
  .sheet .acts { display: flex; flex-wrap: wrap; gap: 6px; }
  .sheetbox { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; } .sheetbox input { width: 76px; }
  .sheet .confirm { display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--accent); border-radius: 8px; padding: 8px; }
  .sheet pre { font-size: 13px; }
  /* inventory */
  .inv-card { container-type: inline-size; }
  .inv { display: flex; flex-direction: column; gap: 6px; }
  .equip, .grid9 { display: grid; grid-template-columns: repeat(9, minmax(0, 1fr)); gap: 3px; max-width: 440px; }
  .hotbar { margin-top: 6px; }
  @container (min-width: 430px) { .inv { flex-direction: row; align-items: flex-start; } .equip { grid-template-columns: 1fr; width: 44px; flex: none; } .slots { flex: 1; min-width: 0; } }
  .cell { position: relative; aspect-ratio: 1; min-width: 0; padding: 0; background: var(--cell); border: 1px solid var(--cellline); border-radius: 4px; overflow: hidden; }
  .cell svg { position: absolute; left: 17%; top: 17%; width: 66%; height: 66%; fill: currentColor; }
  .cell.empty svg { visibility: hidden; }
  .cell img.ic { position: absolute; left: 11%; top: 11%; width: 78%; height: 78%; object-fit: contain; image-rendering: pixelated; pointer-events: none; }
  .cell.empty img.ic, .cell.tex svg { visibility: hidden; }
  .cell.tex .ab { display: none; }
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
  /* the offline banner (docs/panel.md "When the bot is not connected"): the link state, greyed actions */
  .link { display: flex; gap: 12px; align-items: flex-start; border-color: var(--warn); box-shadow: inset 4px 0 0 var(--warn); }
  .link[hidden] { display: none; }
  .link.link-bad, .link.link-down { border-color: var(--bad); box-shadow: inset 4px 0 0 var(--bad); }
  .link .spin { flex: none; width: 18px; height: 18px; margin-top: 2px; border-radius: 50%; border: 3px solid var(--line); border-top-color: var(--warn); animation: spin 1s linear infinite; }
  .link.link-bad .spin, .link.link-down .spin { border-top-color: var(--bad); }
  .link.link-dead .spin { animation: none; border-color: var(--hp); }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .link .spin { animation: none; } }
  .link .lt { font-size: 16px; font-weight: 700; margin: 0 0 2px; }
  .link .kv { margin-top: 6px; }
  .link .signin { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; }
  .link .code { font: 700 18px/1.2 ui-monospace, Menlo, Consolas, monospace; letter-spacing: .12em; padding: 2px 8px; border: 1px dashed var(--accent); border-radius: 6px; }
  button:disabled { opacity: .45; cursor: not-allowed; border-color: var(--cellline); }
  body.is-offline #inventory .cell, body.is-offline #mapcv { opacity: .5; filter: grayscale(.7); }
  body.is-offline #btn-pause, body.is-offline #btn-resume { opacity: 1; }
  .menu .note { font-size: 12px; color: var(--warn); padding: 4px 8px; }
`;

/** Where the page's modules are: the entry and every module to preload (assets.ts ClientModules). */
export interface PageModules {
  entry: string;
  preload: string[];
}

/** The modules of this process. */
export function pageModules(): PageModules {
  const m = clientModules();
  return { entry: m.url(ENTRY_MODULE), preload: m.urls() };
}

export function renderPanelPage(s: PanelState, mods: PageModules = pageModules()): string {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>BedrockBot panel</title>
<script>${THEME_BOOT}${VIEW_BOOT}</script>
<style>${CSS}</style>
${mods.preload.map((u) => `<link rel="modulepreload" href="${esc(u)}">`).join('\n')}
</head>
<body data-panel="v${s.v}">
${glyphDefs()}
<main>
  <header class="wide">
    <h1><span id="dot" class="dot${s.bot.healthy ? ' ok' : ''}"></span><span id="botname">${esc(s.bot.name || 'BedrockBot')}</span></h1>
    <span class="muted"><span id="conn">${esc(s.bot.state)}</span> &middot; <span id="server">${esc(s.bot.server)}</span> &middot; task <span id="task">${esc(s.bot.task)}</span> &middot; <span id="ver">${esc(s.bot.gameVersion)}</span></span>
    <span id="stale" class="stale" hidden>stale</span><span id="err"></span>
    <span class="grow"></span><button type="button" id="view-map" class="small" aria-label="show the map">Map</button> <button type="button" id="theme" class="small" aria-label="switch theme">light</button>
  </header>
  <section id="panel-link" class="wide link" role="status" aria-live="polite"${s.link.phase === 'online' ? ' hidden' : ''}><span class="spin" aria-hidden="true"></span><div class="grow"><div class="lt" id="link-title">${esc(s.link.phase)}</div><div id="link-detail" class="small"></div><dl class="kv small" id="link-rows"></dl><div id="link-signin" class="signin" hidden><a id="link-url" target="_blank" rel="noopener noreferrer">open the sign-in page</a><span>code <span id="link-code" class="code"></span></span></div></div></section>
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
</main>
${mapScreenHtml()}
<div id="menu" class="menu" role="menu" hidden></div>
<div id="toast" class="toast" role="status" hidden></div>
<script type="application/json" id="modes-data">${scriptJson(modesData())}</script>
<script type="application/json" id="initial">${scriptJson(liteState(s))}</script>
<script type="module" src="${esc(mods.entry)}"></script>
</body>
</html>
`;
}
