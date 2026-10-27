// LAN control panel routes (Track AE, docs/panel.md), mounted with HealthServer.use():
//   GET  /            the page (panel/page.ts)
//   GET  /api/state   PanelState JSON (panel/state.ts), polled every 2 s
//   POST /api/cmd     {"text":"!wp set panel"} -> {"ok":true,"replies":[...]}; 5 per second (429 beyond)
// The token check runs before these (HealthServerOptions.auth, panel/auth.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HealthRoute } from '../map/routes.ts';
import { RateLimiter } from './auth.ts';
import { renderPanelPage } from './page.ts';
import type { PanelState } from './state.ts';

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
}

/** Longest command line accepted (game chat is 512). */
export const MAX_COMMAND_LENGTH = 256;
const MAX_BODY = 4096;

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
        send(res, 200, deps.state(), method === 'HEAD');
      } catch (e) {
        send(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
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
