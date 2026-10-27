// GET / (Track AE, docs/panel.md): the control panel page. Server-rendered from the current
// PanelState (status, vitals, quick buttons, settings table), then a little inline JS polls
// /api/state every 2 s and posts commands to /api/cmd. No build step, no external assets: the bot's
// machine may be offline from the internet. The debug map (/map) is embedded on demand.
import type { PanelState } from './state.ts';

export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** JSON for a <script type="application/json"> block (no `</script>` breakout). */
const scriptJson = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c');

function vitalsHtml(s: PanelState): string {
  const p = s.self.pos;
  const items: [string, string][] = [
    ['health', s.self.health === null ? '-' : String(s.self.health)],
    ['food', s.self.food === null ? '-' : String(s.self.food)],
    ['pos', p ? `${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}` : '-'],
    ['dimension', s.self.dimension ?? '-'],
    ['time', s.self.timeOfDay === null ? '-' : `${s.self.timeOfDay} (${s.self.phase ?? ''})`],
  ];
  return items.map(([k, v]) => `<div class="v"><span class="k">${k}</span><span id="v-${k}">${esc(v)}</span></div>`).join('');
}

function settingsHtml(s: PanelState): string {
  return s.settings
    .map((r) => {
      const input =
        r.kind === 'boolean'
          ? `<select data-key="${esc(r.key)}"><option${r.value === 'on' ? ' selected' : ''}>on</option><option${r.value === 'off' ? ' selected' : ''}>off</option></select>`
          : r.kind === 'text'
            ? `<input data-key="${esc(r.key)}" type="text" value="${esc(r.value)}" placeholder="${esc(r.values ?? '')}">`
            : `<input data-key="${esc(r.key)}" type="number" inputmode="decimal" value="${esc(r.value)}" min="${r.min ?? ''}" max="${r.max ?? ''}" step="any">`;
      const range = r.kind === 'boolean' ? 'on|off' : r.kind === 'text' ? (r.values ?? 'text') : `${r.min}..${r.max}${r.unit ? ` ${r.unit}` : ''}`;
      return `<tr><td><b>${esc(r.key)}</b><div class="muted small">${esc(r.description)}</div></td><td class="nowrap">${input} <button class="setbtn" data-key="${esc(r.key)}">set</button></td><td class="muted small nowrap">${esc(range)}<br>default ${esc(r.default)}<br><span data-src="${esc(r.key)}">${esc(r.source)}</span></td></tr>`;
    })
    .join('');
}

export function renderPanelPage(s: PanelState): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>BedrockBot panel</title>
<style>
  :root { color-scheme: dark; --bg: #111418; --panel: #1b2027; --line: #2c333d; --text: #d8dee6; --muted: #8a94a3; --accent: #f5c542; --ok: #4ce08a; --bad: #ff7b72; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, sans-serif; }
  main { max-width: 1100px; margin: 0 auto; padding: 12px 16px 40px; display: grid; gap: 12px; grid-template-columns: 1fr; }
  @media (min-width: 900px) { main { grid-template-columns: 1fr 1fr; } .wide { grid-column: 1 / -1; } }
  header { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: baseline; }
  h1 { font-size: 18px; margin: 0; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 8px; }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; min-width: 0; }
  .muted { color: var(--muted); } .small { font-size: 12px; } .nowrap { white-space: nowrap; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(--bad); margin-right: 6px; }
  .dot.ok { background: var(--ok); }
  .vitals { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px 12px; }
  .k { color: var(--muted); display: inline-block; min-width: 72px; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: 12px/1.4 ui-monospace, Menlo, Consolas, monospace; }
  #logs { max-height: 360px; overflow-y: auto; }
  #chat { max-height: 220px; overflow-y: auto; }
  button, input, select { font: inherit; color: var(--text); background: #2a313b; border: 1px solid #3a4350; border-radius: 6px; padding: 6px 10px; }
  button { cursor: pointer; } button:hover { border-color: var(--accent); }
  .quick { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  form.cmd { display: flex; gap: 6px; } form.cmd input { flex: 1; min-width: 0; }
  table { width: 100%; border-collapse: collapse; } td { border-top: 1px solid var(--line); padding: 6px 4px; vertical-align: top; }
  td input { width: 80px; } .tablewrap { max-height: 420px; overflow: auto; }
  #err { color: var(--bad); }
  iframe { width: 100%; height: 420px; border: 0; border-radius: 6px; background: #000; }
  ul.stack { margin: 6px 0 0; padding-left: 18px; }
</style>
</head>
<body data-panel="v${s.v}">
<main>
  <header class="wide">
    <h1><span id="dot" class="dot${s.bot.healthy ? ' ok' : ''}"></span><span id="botname">${esc(s.bot.name || 'BedrockBot')}</span></h1>
    <span class="muted"><span id="conn">${esc(s.bot.state)}</span> &middot; <span id="server">${esc(s.bot.server)}</span> &middot; task <span id="task">${esc(s.bot.task)}</span> &middot; <span id="ver">${esc(s.bot.gameVersion)}</span></span>
    <span id="err"></span>
  </header>
  <section class="wide" id="panel-status">
    <h2>Status</h2>
    <pre id="status">${esc(s.status.join('\n'))}</pre>
    <ul class="stack" id="stack"></ul>
  </section>
  <section class="wide"><h2>Bot</h2><div class="vitals">${vitalsHtml(s)}</div></section>
  <section id="panel-commands">
    <h2>Commands</h2>
    <div class="quick">${s.quick.map((q) => `<button class="q" data-cmd="${esc(q)}">${esc(q)}</button>`).join('')}</div>
    <form class="cmd" id="cmdform" autocomplete="off"><input id="cmd" placeholder="!goto 10 -60 10" aria-label="command" list="cmdlist" maxlength="256"><button>Send</button></form>
    <datalist id="cmdlist">${s.commands.map((c) => `<option value="!${esc(c)}">`).join('')}</datalist>
    <pre id="replies" class="muted" style="margin-top:8px"></pre>
    <h2 style="margin-top:12px">Bot chat</h2>
    <pre id="chat"></pre>
  </section>
  <section id="panel-logs"><h2>Log (last 50 lines)</h2><pre id="logs"></pre></section>
  <section class="wide" id="panel-settings"><h2>Settings (!set)</h2><div class="tablewrap"><table><tbody id="settings">${settingsHtml(s)}</tbody></table></div></section>
  <section class="wide" id="panel-help">
    <details id="helpbox"><summary><h2 style="display:inline">Help</h2> <span class="muted small">commands, settings, modes (!help in chat)</span></summary><div id="helpwrap" class="tablewrap"></div></details>
  </section>
  <section class="wide" id="panel-map">
    <details id="mapbox"><summary><h2 style="display:inline">Map</h2> <a href="/map" target="_blank" rel="noopener" class="small">open full page</a></summary><div id="mapwrap"></div></details>
  </section>
</main>
<script type="application/json" id="initial">${scriptJson(s)}</script>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const text = (id, v) => { const e = $(id); if (e && e.textContent !== v) e.textContent = v; };
  let last = JSON.parse($('initial').textContent);
  const atBottom = (e) => e.scrollHeight - e.scrollTop - e.clientHeight < 30;
  function render(s) {
    last = s;
    $('dot').className = 'dot' + (s.bot.healthy ? ' ok' : '');
    text('botname', s.bot.name || 'BedrockBot'); text('conn', s.bot.state); text('server', s.bot.server); text('task', s.bot.task); text('ver', s.bot.gameVersion);
    text('status', s.status.join('\\n'));
    const st = $('stack'); st.textContent = '';
    for (const e of s.stack) { const li = document.createElement('li'); li.textContent = '[' + e.state + '] ' + e.name + ' (' + e.kind + ' ' + e.priority + '): ' + e.line + (e.etaS != null ? ', eta ' + Math.round(e.etaS) + ' s' : ''); st.appendChild(li); }
    const p = s.self.pos;
    text('v-health', s.self.health == null ? '-' : String(s.self.health));
    text('v-food', s.self.food == null ? '-' : String(s.self.food));
    text('v-pos', p ? p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ' ' + p.z.toFixed(1) : '-');
    text('v-dimension', s.self.dimension || '-');
    text('v-time', s.self.timeOfDay == null ? '-' : s.self.timeOfDay + ' (' + (s.self.phase || '') + ')');
    const lg = $('logs'), lb = atBottom(lg); text('logs', s.logs.join('\\n')); if (lb) lg.scrollTop = lg.scrollHeight;
    const ch = $('chat'), cb = atBottom(ch);
    text('chat', s.chat.map((c) => new Date(c.ts).toLocaleTimeString() + ' ' + c.text + (c.sent ? '' : '  (not sent to the game)')).join('\\n'));
    if (cb) ch.scrollTop = ch.scrollHeight;
    for (const r of s.settings) {
      const src = document.querySelector('[data-src="' + r.key + '"]'); if (src) src.textContent = r.source;
      const inp = document.querySelector('[data-key="' + r.key + '"]:not(button)');
      if (inp && document.activeElement !== inp && !inp.dataset.dirty) inp.value = r.value;
    }
  }
  async function poll() {
    try {
      const res = await fetch('/api/state', { cache: 'no-store', credentials: 'same-origin' });
      if (res.status === 401) { location.href = '/'; return; }
      if (!res.ok) throw new Error('state ' + res.status);
      render(await res.json());
      text('err', '');
    } catch (e) { text('err', 'offline: ' + (e && e.message ? e.message : e)); }
  }
  async function send(cmd) {
    cmd = cmd.trim(); if (!cmd) return;
    $('replies').textContent = '> ' + cmd + '\\n...';
    try {
      const res = await fetch('/api/cmd', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ text: cmd }) });
      const r = await res.json();
      $('replies').textContent = '> ' + (r.command || cmd) + '\\n' + ((r.replies && r.replies.length) ? r.replies.join('\\n') : (r.error || (r.ok ? '(no reply yet; see bot chat)' : 'failed')));
    } catch (e) { $('replies').textContent = '> ' + cmd + '\\nerror: ' + (e && e.message ? e.message : e); }
    setTimeout(poll, 300);
  }
  $('cmdform').addEventListener('submit', (ev) => { ev.preventDefault(); const v = $('cmd').value; $('cmd').value = ''; send(v); });
  for (const b of document.querySelectorAll('button.q')) b.addEventListener('click', () => send(b.dataset.cmd));
  for (const b of document.querySelectorAll('button.setbtn')) b.addEventListener('click', () => {
    const inp = document.querySelector('[data-key="' + b.dataset.key + '"]:not(button)');
    if (!inp) return; delete inp.dataset.dirty; send('!set ' + b.dataset.key + ' ' + inp.value);
  });
  for (const i of document.querySelectorAll('#settings input, #settings select')) i.addEventListener('input', () => { i.dataset.dirty = '1'; });
  $('mapbox').addEventListener('toggle', () => {
    const w = $('mapwrap');
    if ($('mapbox').open && !w.firstChild) { const f = document.createElement('iframe'); f.src = '/map'; f.title = 'map'; w.appendChild(f); }
    else if (!$('mapbox').open) w.textContent = '';
  });
  // Track AM: the Help tab, fetched once when first opened (GET /api/help)
  function table(head, rows) {
    const t = document.createElement('table'), tr = document.createElement('tr');
    for (const h of head) { const th = document.createElement('td'); th.className = 'muted small'; th.textContent = h; tr.appendChild(th); }
    t.appendChild(tr);
    for (const r of rows) { const row = document.createElement('tr'); for (const c of r) { const td = document.createElement('td'); td.textContent = c; row.appendChild(td); } t.appendChild(row); }
    return t;
  }
  function h2(text) { const e = document.createElement('h2'); e.style.marginTop = '12px'; e.textContent = text; return e; }
  $('helpbox').addEventListener('toggle', async () => {
    const w = $('helpwrap');
    if (!$('helpbox').open || w.dataset.loaded) return;
    w.dataset.loaded = '1'; w.textContent = 'loading...';
    try {
      const res = await fetch('/api/help', { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) throw new Error('help ' + res.status);
      const h = await res.json();
      w.textContent = '';
      w.appendChild(h2('Commands'));
      w.appendChild(table(['tier', 'group', 'syntax', 'help', 'example', 'also on its own'], h.commands.map((c) => [c.tier === 'front' ? 'front door' : 'more', c.group, '!' + c.name + (c.syntax ? ' ' + c.syntax : ''), c.help, c.example, c.auto])));
      w.appendChild(h2('Modes (now: ' + h.mode + ')'));
      const keys = h.modes.length ? Object.keys(h.modes[0].values) : [];
      w.appendChild(table(['!mode'].concat(keys), h.modes.map((m) => [m.name].concat(keys.map((k) => m.values[k])))));
      w.appendChild(h2('Settings'));
      w.appendChild(table(['group', 'setting', 'value', 'default', 'description'], h.settings.map((s) => [s.group, s.key, s.value, s.default, s.description])));
    } catch (e) { delete w.dataset.loaded; w.textContent = 'help: ' + (e && e.message ? e.message : e); }
  });
  render(last);
  setInterval(poll, 2000);
})();
</script>
</body>
</html>
`;
}
