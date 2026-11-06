// LAN control panel routes (Track AE, docs/panel.md), mounted with HealthServer.use():
//   GET  /            the page (panel/page.ts)
//   GET  /api/state   PanelState JSON (panel/state.ts); ?lite=1 = without the static parts (Track AP): the page's fallback poll
//   GET  /api/stream  the push channel (panel/stream.ts, decision 0061; mounted by index.ts, not here)
//   GET  /ui/<hash>/* the page's browser modules (panel/assets.ts, decision 0061; mounted by index.ts)
//   GET  /api/help    PanelHelp JSON (panel/state.ts buildPanelHelp), fetched once by the Help tab (Track AM)
//   GET  /api/chests  the remembered containers (panel/memory.ts chestRows), the memory block's list (Track AP)
//   GET  /api/marks  chests and herds near the bot (panel/marks.ts), the panel map's markers (Track AR)
//   GET  /icons/<item>.png  the item's picture for the inventory cells (panel/icons/, decision 0046); 404 = the cell keeps its glyph
//   POST /api/cmd    {"text":"!wp set panel"} -> {"ok":true,"replies":[...]}; 5 per second (429 beyond)
// The token check runs before these (HealthServerOptions.auth, panel/auth.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HealthRoute } from '../map/routes.ts';
import { RateLimiter } from './auth.ts';
import { renderPanelPage } from './page.ts';
import { liteState, type PanelState } from './state.ts';

export interface CommandResult {
  ok: boolean;
  /** Replies said while the command ran (later ones show in the state's `chat`). */
  replies: string[];
  error?: string;
}

export interface PanelRouteDeps {
  state: () => PanelState;
  run: (text: string) => CommandResult;
  limiter?: RateLimiter;
  /** Track AM: GET /api/help (the Help tab fetches it once). */
  help?: () => unknown;
  /** Track AP: GET /api/chests (the remembered containers, panel/memory.ts chestRows). */
  chests?: () => unknown;
  /** Track AR: GET /api/marks (panel/marks.ts mapMarks: chests and herds for the map). */
  marks?: () => unknown;
  /** GET /icons/<item>.png: the item's picture (panel/icons/book.ts IconBook.png), undefined = no art for it (404). */
  icon?: (name: string) => Promise<Buffer | undefined>;
}

/** Longest command line accepted (game chat is 512). */
export const MAX_COMMAND_LENGTH = 256;
const MAX_BODY = 4096;
/** `/icons/iron_sword.png`: an item name is lower-case words and digits (the namespace is left off). */
const ICON_PATH = /^\/icons\/([a-z0-9_]{1,64})\.png$/;

function send(res: ServerResponse, status: number, body: unknown, head = false): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(head ? undefined : `${JSON.stringify(body, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}\n`);
}

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/** Parse the POST body: {"text": "..."}; the leading `!` is added when missing. */
export function parseCommandBody(body: string): { text: string } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { error: 'body must be JSON {"text":"!..."}' };
  }
  const text = typeof raw === 'object' && raw !== null ? (raw as { text?: unknown }).text : undefined;
  if (typeof text !== 'string' || text.trim() === '') return { error: 'body must be JSON {"text":"!..."}' };
  const t = text.trim().replace(/[\r\n]+/g, ' ');
  if (t.length > MAX_COMMAND_LENGTH) return { error: `command longer than ${MAX_COMMAND_LENGTH} characters` };
  return { text: t.startsWith('!') ? t : `!${t}` };
}

export function panelRoutes(deps: PanelRouteDeps): HealthRoute {
  const limiter = deps.limiter ?? new RateLimiter(5, 1000);
  return (path: string, req: IncomingMessage, res: ServerResponse): boolean => {
    const method = req.method ?? 'GET';
    const read = method === 'GET' || method === 'HEAD';
    if (path === '/' || path === '/index.html') {
      if (!read) {
        send(res, 405, { error: 'method not allowed' });
        return true;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
      res.end(method === 'HEAD' ? undefined : renderPanelPage(deps.state()));
      return true;
    }
    if (path === '/api/state') {
      if (!read) {
        send(res, 405, { error: 'method not allowed' });
        return true;
      }
      try {
        const lite = /[?&]lite=1(&|$)/.test(req.url ?? ''); // Track AP: the page's poll leaves out the static parts
        send(res, 200, lite ? liteState(deps.state()) : deps.state(), method === 'HEAD');
      } catch (e) {
        send(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }
    if (path === '/api/help' && deps.help && read) { // Track AM: commands, settings, modes for the Help tab
      try {
        send(res, 200, deps.help(), method === 'HEAD');
      } catch (e) {
        send(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }
    if (path === '/api/chests' && deps.chests && read) { // Track AP: the remembered containers (the memory block's link)
      try {
        send(res, 200, deps.chests(), method === 'HEAD');
      } catch (e) {
        send(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }
    if (path === '/api/marks' && deps.marks && read) { // Track AR: chests and herds for the panel's map
      try {
        send(res, 200, deps.marks(), method === 'HEAD');
      } catch (e) {
        send(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }
    const icon = deps.icon && read ? ICON_PATH.exec(path) : null;
    if (icon) {
      deps.icon!(icon[1]!).then(
        (png) => {
          if (png) {
            res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length, 'cache-control': 'private, max-age=86400' });
            res.end(method === 'HEAD' ? undefined : png);
          } else {
            res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, max-age=300' });
            res.end(method === 'HEAD' ? undefined : `${JSON.stringify({ error: 'no icon for this item' })}\n`);
          }
        },
        (e: unknown) => {
          if (!res.headersSent) send(res, 500, { error: e instanceof Error ? e.message : String(e) });
        },
      );
      return true;
    }
    if (path === '/api/cmd') {
      if (method !== 'POST') {
        send(res, 405, { error: 'POST {"text":"!..."}' });
        return true;
      }
      if (!limiter.take()) {
        send(res, 429, { error: 'too many commands (5 per second)' });
        return true;
      }
      readBody(req, MAX_BODY).then(
        (body) => {
          const p = parseCommandBody(body);
          if ('error' in p) {
            send(res, 400, { ok: false, error: p.error });
            return;
          }
          let r: CommandResult;
          try {
            r = deps.run(p.text);
          } catch (e) {
            r = { ok: false, replies: [], error: e instanceof Error ? e.message : String(e) };
          }
          send(res, r.ok ? 200 : 409, { command: p.text, ...r });
        },
        (e: unknown) => {
          if (!res.headersSent) send(res, 413, { error: e instanceof Error ? e.message : String(e) });
        },
      );
      return true;
    }
    return false;
  };
}
