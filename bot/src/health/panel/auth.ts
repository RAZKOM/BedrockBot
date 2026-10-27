// LAN control panel (Track AE, docs/panel.md): the token check and the command rate limit.
//
// With a token (config panel.token or BEDROCKBOT_PANEL_TOKEN) every request except /healthz needs it:
//   Authorization: Bearer <token>        scripts, curl
//   ?token=<token>                       once from a browser: sets the `bbpanel` cookie (HttpOnly,
//                                        SameSite=Strict) and a GET is redirected to the same URL
//                                        without the query, so the token leaves the address bar
//   Cookie: bbpanel=<token>              the browser afterwards
// Without a token the panel serves on 127.0.0.1 only (panel/index.ts refuses another interface) and
// the Host header must name the loopback (no DNS rebinding from a web page).
// POST requests also need `content-type: application/json` and, when the browser sends an Origin,
// one that matches the Host: a cross-site page cannot send that without a CORS preflight, which the
// server never answers.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const PANEL_COOKIE = 'bbpanel';
/** Cookie lifetime: 30 days. */
const COOKIE_MAX_AGE_S = 30 * 24 * 3600;

export type AuthVerdict =
  | { ok: true; setCookie?: string; redirect?: string }
  | { ok: false; status: 401 | 403; reason: string };

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

/** Constant-time comparison (both sides hashed first, so lengths never leak through timing). */
export function tokenEquals(given: string | undefined, token: string): boolean {
  if (given === undefined) return false;
  return timingSafeEqual(digest(given), digest(token));
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in out)) out[k] = v;
  }
  return out;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** `127.0.0.1:9464` -> true; `evil.example:9464` -> false. */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]!;
  return LOOPBACK_HOSTS.has(name.toLowerCase()) || /^127\.\d+\.\d+\.\d+$/.test(name);
}

/** True for an interface that is the loopback (127.x, ::1, localhost). */
export function isLoopbackInterface(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

export interface AuthRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

function header(req: AuthRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Decide one request (pure; unit-tested). `token` undefined = loopback-only mode. */
export function checkRequest(req: AuthRequest, token: string | undefined): AuthVerdict {
  const method = req.method.toUpperCase();
  if (method === 'POST') {
    const ct = (header(req, 'content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (ct !== 'application/json') return { ok: false, status: 403, reason: 'POST needs content-type application/json' };
    const origin = header(req, 'origin');
    const host = header(req, 'host');
    if (origin !== undefined && origin !== 'null' && host !== undefined && origin.toLowerCase() !== `http://${host.toLowerCase()}`) {
      return { ok: false, status: 403, reason: 'cross-origin request' };
    }
    if (origin === 'null') return { ok: false, status: 403, reason: 'cross-origin request' };
  }
  if (token === undefined) {
    if (!isLoopbackHostHeader(header(req, 'host'))) return { ok: false, status: 403, reason: 'loopback only (no panel.token): use http://127.0.0.1:<port>/' };
    return { ok: true };
  }
  const auth = header(req, 'authorization');
  if (auth !== undefined) {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    return m && tokenEquals(m[1], token) ? { ok: true } : { ok: false, status: 401, reason: 'wrong token' };
  }
  const url = new URL(req.url, 'http://panel');
  const q = url.searchParams.get('token');
  if (q !== null) {
    if (!tokenEquals(q, token)) return { ok: false, status: 401, reason: 'wrong token' };
    url.searchParams.delete('token');
    const setCookie = `${PANEL_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`;
    return method === 'GET' ? { ok: true, setCookie, redirect: `${url.pathname}${url.search}` } : { ok: true, setCookie };
  }
  const cookie = parseCookies(header(req, 'cookie'))[PANEL_COOKIE];
  if (cookie !== undefined) return tokenEquals(cookie, token) ? { ok: true } : { ok: false, status: 401, reason: 'wrong token' };
  return { ok: false, status: 401, reason: 'token required' };
}

const LOGIN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>BedrockBot panel</title>
<style>body{margin:0;padding:24px 16px;background:#111418;color:#d8dee6;font:15px/1.5 system-ui,sans-serif}
input,button{font:inherit;padding:6px 10px;border-radius:6px;border:1px solid #3a4350;background:#1b2027;color:inherit}
form{display:flex;gap:8px;flex-wrap:wrap;max-width:420px}input{flex:1;min-width:0}</style></head>
<body><h1 style="font-size:18px">BedrockBot panel</h1><p>This panel needs its token (config <code>panel.token</code>).</p>
<form method="get" action="/"><input name="token" type="password" autocomplete="current-password" placeholder="token" aria-label="token"><button>Open</button></form>
</body></html>
`;

/** The HealthServerOptions.auth hook: answers 401/403 itself and returns false, or lets the request through. */
export function panelAuth(token: string | undefined): (path: string, req: IncomingMessage, res: ServerResponse) => boolean {
  return (path, req, res) => {
    const v = checkRequest({ method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers }, token);
    if (!v.ok) {
      const html = v.status === 401 && path === '/' && (req.method ?? 'GET') === 'GET';
      res.writeHead(v.status, { 'content-type': html ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html ? LOGIN_PAGE : `${JSON.stringify({ error: v.reason })}\n`);
      return false;
    }
    if (v.setCookie) res.setHeader('set-cookie', v.setCookie);
    if (v.redirect) {
      res.writeHead(303, { location: v.redirect, 'cache-control': 'no-store' });
      res.end();
      return false;
    }
    return true;
  };
}

/** At most `max` events per `windowMs` (sliding window). */
export class RateLimiter {
  private readonly times: number[] = [];
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(max = 5, windowMs = 1000, now: () => number = Date.now) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** True (and counted) when allowed. */
  take(): boolean {
    const t = this.now();
    while (this.times.length > 0 && t - this.times[0]! >= this.windowMs) this.times.shift();
    if (this.times.length >= this.max) return false;
    this.times.push(t);
    return true;
  }
}
