// Track AE: the control panel's token check, rate limit, bind plan and log ring (docs/panel.md).
import { describe, expect, it } from 'vitest';
import { checkRequest, isLoopbackHostHeader, isLoopbackInterface, parseCookies, RateLimiter, tokenEquals, type AuthRequest } from '../../../src/health/panel/auth.ts';
import { panelLine, panelUrls, planPanel } from '../../../src/health/panel/index.ts';
import { LogRing, redact } from '../../../src/health/panel/logRing.ts';

const TOKEN = 'Abcdefghijklmnopqrstuvwx';
const req = (p: Partial<AuthRequest> & { headers?: AuthRequest['headers'] } = {}): AuthRequest => ({ method: 'GET', url: '/api/state', ...p, headers: { host: '192.168.1.20:9464', ...p.headers } });

describe('panel token check', () => {
  it('missing token: 401', () => {
    expect(checkRequest(req(), TOKEN)).toEqual({ ok: false, status: 401, reason: 'token required' });
  });

  it('wrong token: 401 (bearer, query, cookie)', () => {
    expect(checkRequest(req({ headers: { authorization: 'Bearer nope' } }), TOKEN)).toMatchObject({ ok: false, status: 401 });
    expect(checkRequest(req({ headers: { authorization: `Basic ${TOKEN}` } }), TOKEN)).toMatchObject({ ok: false, status: 401 });
    expect(checkRequest(req({ url: '/?token=nope' }), TOKEN)).toMatchObject({ ok: false, status: 401 });
    expect(checkRequest(req({ headers: { cookie: 'bbpanel=nope' } }), TOKEN)).toMatchObject({ ok: false, status: 401 });
    expect(checkRequest(req({ headers: { authorization: `Bearer ${TOKEN}x` } }), TOKEN)).toMatchObject({ ok: false, status: 401 });
  });

  it('right token: bearer passes', () => {
    expect(checkRequest(req({ headers: { authorization: `Bearer ${TOKEN}` } }), TOKEN)).toEqual({ ok: true });
    expect(checkRequest(req({ headers: { authorization: `bearer   ${TOKEN}` } }), TOKEN)).toEqual({ ok: true });
  });

  it('?token= once: sets the cookie and redirects a GET to the URL without the token', () => {
    const v = checkRequest(req({ url: `/?token=${TOKEN}&x=1` }), TOKEN);
    expect(v).toEqual({ ok: true, setCookie: `bbpanel=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`, redirect: '/?x=1' });
    expect(checkRequest(req({ url: `/?token=${TOKEN}` }), TOKEN)).toMatchObject({ redirect: '/' });
  });

  it('cookie afterwards passes', () => {
    expect(checkRequest(req({ headers: { cookie: `other=1; bbpanel=${TOKEN}` } }), TOKEN)).toEqual({ ok: true });
    expect(parseCookies(`a=1; bbpanel=${TOKEN}; a=2`)).toEqual({ a: '1', bbpanel: TOKEN });
  });

  it('without a token only loopback Host headers pass (no DNS rebinding)', () => {
    expect(checkRequest(req({ headers: { host: '127.0.0.1:9464' } }), undefined)).toEqual({ ok: true });
    expect(checkRequest(req({ headers: { host: 'localhost:9464' } }), undefined)).toEqual({ ok: true });
    expect(checkRequest(req({ headers: { host: 'evil.example:9464' } }), undefined)).toMatchObject({ ok: false, status: 403 });
    expect(isLoopbackHostHeader('[::1]:9464')).toBe(true);
    expect(isLoopbackHostHeader(undefined)).toBe(false);
  });

  it('POST needs application/json and a same-origin Origin', () => {
    const post = (headers: AuthRequest['headers']) => checkRequest(req({ method: 'POST', url: '/api/cmd', headers: { authorization: `Bearer ${TOKEN}`, ...headers } }), TOKEN);
    expect(post({ 'content-type': 'application/json' })).toEqual({ ok: true });
    expect(post({ 'content-type': 'application/json; charset=utf-8', origin: 'http://192.168.1.20:9464' })).toEqual({ ok: true });
    expect(post({ 'content-type': 'text/plain' })).toMatchObject({ ok: false, status: 403 });
    expect(post({ 'content-type': 'application/json', origin: 'http://evil.example' })).toMatchObject({ ok: false, status: 403 });
    expect(post({ 'content-type': 'application/json', origin: 'null' })).toMatchObject({ ok: false, status: 403 });
  });

  it('tokenEquals is exact', () => {
    expect(tokenEquals(TOKEN, TOKEN)).toBe(true);
    expect(tokenEquals(TOKEN.toLowerCase(), TOKEN)).toBe(false);
    expect(tokenEquals(undefined, TOKEN)).toBe(false);
    expect(tokenEquals('', TOKEN)).toBe(false);
  });
});

describe('panel rate limit', () => {
  it('5 per second, sliding', () => {
    let t = 1000;
    const rl = new RateLimiter(5, 1000, () => t);
    expect([1, 2, 3, 4, 5, 6].map(() => rl.take())).toEqual([true, true, true, true, true, false]);
    t += 999;
    expect(rl.take()).toBe(false);
    t += 500;
    expect([1, 2, 3, 4, 5, 6].map(() => rl.take())).toEqual([true, true, true, true, true, false]);
    t += 999;
    expect(rl.take()).toBe(false);
  });
});

describe('panel bind plan', () => {
  const panel = (p: Partial<{ host: string; port: number; token: string }>) => ({ host: '127.0.0.1', port: undefined, token: undefined, ...p });

  it('off without any port; shared on the health port; separate on its own port', () => {
    expect(planPanel(undefined, panel({}))).toMatchObject({ mode: 'off', port: undefined });
    expect(planPanel(9464, panel({}))).toEqual({ mode: 'shared', host: '127.0.0.1', port: 9464, token: undefined });
    expect(planPanel(9464, panel({ port: 9464 }))).toMatchObject({ mode: 'shared' });
    expect(planPanel(9464, panel({ port: 9466, host: '0.0.0.0', token: TOKEN }))).toEqual({ mode: 'separate', host: '0.0.0.0', port: 9466, token: TOKEN });
    expect(planPanel(undefined, panel({ port: 9466 }))).toMatchObject({ mode: 'separate', port: 9466 });
  });

  it('refuses a LAN interface without a token (falls back to 127.0.0.1)', () => {
    const p = planPanel(9464, panel({ host: '0.0.0.0' }));
    expect(p.host).toBe('127.0.0.1');
    expect(p.refused).toMatch(/refusing to serve on 0\.0\.0\.0 without panel\.token/);
    expect(isLoopbackInterface('127.0.0.1')).toBe(true);
    expect(isLoopbackInterface('192.168.1.2')).toBe(false);
  });

  it('URLs: every LAN IPv4 address for 0.0.0.0, the host otherwise', () => {
    const ifaces = {
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en0: [
        { address: '192.168.1.20', family: 'IPv4', internal: false },
        { address: 'fe80::1', family: 'IPv6', internal: false },
      ],
    } as unknown as Parameters<typeof panelUrls>[2];
    expect(panelUrls('0.0.0.0', 9464, ifaces)).toEqual(['http://192.168.1.20:9464/', 'http://127.0.0.1:9464/']);
    expect(panelUrls('127.0.0.1', 9464, ifaces)).toEqual(['http://127.0.0.1:9464/']);
  });

  it('commands run as the first owner name, else xuid, else the console', () => {
    expect(panelLine({ names: ['Steve', 'Alex'], xuids: ['1'], allowConsole: true }, '!pos')).toMatchObject({ type: 'chat', source: 'Steve', body: '!pos', xuid: '' });
    expect(panelLine({ names: [], xuids: ['253'], allowConsole: false }, '!pos')).toMatchObject({ type: 'chat', source: 'panel', xuid: '253' });
    expect(panelLine({ names: [], xuids: [], allowConsole: true }, '!pos')).toMatchObject({ type: 'announcement', source: 'Server', body: '!pos' });
    expect(panelLine({ names: [], xuids: [], allowConsole: false }, '!pos')).toBeUndefined();
  });
});

describe('panel log ring', () => {
  it('keeps complete lines, joins partial writes, drops the oldest', () => {
    const r = new LogRing(3);
    r.push('a\nb');
    expect(r.tail()).toEqual(['a']);
    r.push('c\n\nd\ne\n');
    expect(r.tail()).toEqual(['bc', 'd', 'e']);
    expect(r.tail(2)).toEqual(['d', 'e']);
    expect(r.total).toBe(4);
  });

  it('taps console.error-like targets without changing what they write, and untaps', () => {
    const written: unknown[][] = [];
    const target = { error: (...a: unknown[]) => void written.push(a) };
    const r = new LogRing();
    const untap = r.tap(target);
    target.error('one');
    target.error('two %d', 2, { a: 1 });
    untap();
    target.error('three');
    expect(written).toEqual([['one'], ['two %d', 2, { a: 1 }], ['three']]);
    expect(r.tail()).toEqual(['one', 'two 2 { a: 1 }']);
  });

  it('redacts tokens and sign-in codes', () => {
    expect(redact('GET /?token=abc123 ok')).toBe('GET /?token=*** ok');
    expect(redact('Authorization: Bearer abc.def')).toBe('Authorization: Bearer ***');
    expect(redact('To sign in, use a web browser to open the page and enter the code ABCD-1234 to authenticate')).toContain('enter the code ***');
    expect(redact('"token": "xyz"')).toBe('"token": "***"');
    expect(redact('walking to home 1 2 3')).toBe('walking to home 1 2 3');
  });
});
