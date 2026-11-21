// A fake Discord for the Discord bot's tests (Track D1, docs/discord.md "Testing without Discord"): one HTTP server on
// the loopback that answers the REST calls the bot makes and speaks the gateway over a websocket (a minimal RFC 6455
// server: text frames, close, ping; no extensions). Never Discord: the bot reaches it through
// BEDROCKBOT_DISCORD_TEST_ORIGIN = http://127.0.0.1:<port>, and GET /api/v10/gateway/bot hands out ws://127.0.0.1:<port>.
//
//   const fake = await fakeDiscord({ token: TOKEN, ports: [0, 0] });          // [0, 0]: a free port; e2e: a fixed range
//   fake.message({ author: OWNER, channel: CHANNEL, guild: GUILD, content: '!pos' });   // a MESSAGE_CREATE
//   fake.press({ user: OWNER, customId, message });                                    // an INTERACTION_CREATE
//   fake.posts / fake.edits / fake.callbacks / fake.frames                             // what the bot sent
// Track D3: application commands (PUT / GET /applications/<app>[/guilds/<g>]/commands, kept in `registered`), slash
// commands and autocompletes as INTERACTION_CREATE (types 2 and 4), the follow-ups of a slash command (`followups`:
// PATCH .../messages/@original and POST /webhooks/<app>/<token>, no bot token), and the reads of the set-up check
// (GET /channels/<id>, /guilds/<g>, /guilds/<g>/members/<u>) from `channels`, `guildData` and `members`.
//   fake.slash({ user, name: 'goto', options: { place: 'home' }, channel, guild });
//   fake.autocomplete({ user, name: 'run', focused: 'line', options: { line: 'go' }, channel, guild });
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

export interface FakeRest {
  at: number;
  method: string;
  path: string;
  auth: string | undefined;
  body: Record<string, unknown>;
}

export interface FakeFrame {
  at: number;
  op: number;
  d: unknown;
}

export interface FakeDiscordOptions {
  /** The bot token the fake accepts (REST `Bot <token>`, IDENTIFY, RESUME). */
  token: string;
  /** A port range [lo, hi] to bind in. */
  ports: [number, number];
  /** The bot's own user id (READY). */
  self?: string;
  heartbeatMs?: number;
  /** Track D3: the application id (READY's application.id; default the bot's user id). */
  app?: string;
  /** Track D3: READY's servers. */
  guilds?: string[];
  /** Track D3: what GET /channels/<id> answers (a status 403 / 404 for one the bot cannot see; absent: 404). */
  channels?: Record<string, { status?: number; guild_id?: string; type?: number; permission_overwrites?: { id: string; type: number; allow: string; deny: string }[] }>;
  /** Track D3: GET /guilds/<g> (its owner and roles). */
  guildData?: Record<string, { owner_id: string; roles: { id: string; permissions: string }[] }>;
  /** Track D3: GET /guilds/<g>/members/<u> (absent: 404). */
  members?: Record<string, Record<string, { roles: string[] }>>;
}

interface Client {
  sock: Duplex;
  buf: Buffer;
  open: boolean;
  identified: boolean;
}

export interface FakeDiscord {
  server: Server;
  port: number;
  origin: string;
  posts: FakeRest[];
  edits: FakeRest[];
  callbacks: FakeRest[];
  rest: FakeRest[];
  frames: FakeFrame[];
  /** Track D3: the follow-ups of slash commands (PATCH @original, POST /webhooks/<app>/<token>). */
  followups: FakeRest[];
  /** Track D3: the PUTs of application commands. */
  puts: FakeRest[];
  /** Track D3: what each scope (`global` or a server id) holds now. */
  registered: Map<string, { name: string }[]>;
  /** Sockets connected so far (each a new connection). */
  connections: number;
  /** READY sent this many times; RESUMED this many. */
  readies: number;
  resumed: number;
  /** Answer each REST call with this (default: 200 / 204 with an id). */
  answer: (r: FakeRest) => { status: number; body?: unknown; headers?: Record<string, string> } | undefined;
  /** Ack heartbeats (false: a dead link the bot must notice). */
  ack: boolean;
  /** Send a dispatch to every identified socket. */
  dispatch(t: string, d: unknown): void;
  message(m: { author: string; channel: string; guild?: string; content: string; bot?: boolean; webhook?: string; type?: number }): string;
  press(p: { user: string; customId: string; message: { id: string; channel_id: string; content?: string }; guild?: string }): string;
  /** Track D3: a slash command (type 2); its interaction id (its token: tokenOf(id)). */
  slash(p: { user: string; name: string; options?: Record<string, string>; channel: string; guild?: string }): string;
  /** Track D3: an autocomplete (type 4) of the option being typed. */
  autocomplete(p: { user: string; name: string; focused: string; options: Record<string, string>; channel: string; guild?: string }): string;
  /** Close every socket with this code (the bot reconnects, or stops on a fatal code). */
  closeAll(code: number, reason?: string): void;
  /** Send a raw op to every open socket (7 RECONNECT, 9 INVALID SESSION). */
  op(op: number, d?: unknown): void;
  close(): Promise<void>;
}

let snow = 1_100_000_000_000_000_000n;
export const nextId = (): string => String(++snow);
/** An interaction's token (Track D3: it is in the follow-ups' paths). */
export const tokenOf = (id: string): string => `fake-interaction-token-${id}-abcdefghijklmnopqrstuvwxyz0123456789`;

function frame(op: number, payload: Buffer): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | op, 127]), (() => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(n));
    return b;
  })()]);
  return Buffer.concat([head, payload]);
}

export async function fakeDiscord(o: FakeDiscordOptions): Promise<FakeDiscord> {
  const self = o.self ?? '1000000000000000001';
  const app = o.app ?? self;
  const clients = new Set<Client>();
  let seq = 0;
  const session = `fake-session-${Math.floor(Math.random() * 1e6)}`;
  const f: FakeDiscord = {
    server: undefined as unknown as Server,
    port: 0,
    origin: '',
    posts: [],
    edits: [],
    callbacks: [],
    rest: [],
    frames: [],
    followups: [],
    puts: [],
    registered: new Map(),
    connections: 0,
    readies: 0,
    resumed: 0,
    answer: () => undefined,
    ack: true,
    dispatch(t, d) {
      for (const c of clients) if (c.open && c.identified) send(c, { op: 0, t, s: ++seq, d });
    },
    message(m) {
      const id = nextId();
      f.dispatch('MESSAGE_CREATE', { id, channel_id: m.channel, ...(m.guild ? { guild_id: m.guild } : {}), author: { id: m.author, username: `user${m.author.slice(-4)}`, ...(m.bot ? { bot: true } : {}) }, ...(m.webhook ? { webhook_id: m.webhook } : {}), type: m.type ?? 0, content: m.content });
      return id;
    },
    press(p) {
      const id = nextId();
      const user = { id: p.user, username: `user${p.user.slice(-4)}` };
      f.dispatch('INTERACTION_CREATE', { id, application_id: app, type: 3, token: tokenOf(id), channel_id: p.message.channel_id, ...(p.guild ? { guild_id: p.guild, member: { user } } : { user }), data: { custom_id: p.customId, component_type: 2 }, message: p.message });
      return id;
    },
    slash(p) {
      const id = nextId();
      const user = { id: p.user, username: `user${p.user.slice(-4)}` };
      const options = Object.entries(p.options ?? {}).map(([name, value]) => ({ name, type: 3, value }));
      f.dispatch('INTERACTION_CREATE', { id, application_id: app, type: 2, token: tokenOf(id), channel_id: p.channel, channel: { id: p.channel }, ...(p.guild ? { guild_id: p.guild, member: { user } } : { user }), data: { id: nextId(), name: p.name, type: 1, ...(options.length ? { options } : {}) } });
      return id;
    },
    autocomplete(p) {
      const id = nextId();
      const user = { id: p.user, username: `user${p.user.slice(-4)}` };
      const options = Object.entries(p.options).map(([name, value]) => ({ name, type: 3, value, ...(name === p.focused ? { focused: true } : {}) }));
      f.dispatch('INTERACTION_CREATE', { id, application_id: app, type: 4, token: tokenOf(id), channel_id: p.channel, ...(p.guild ? { guild_id: p.guild, member: { user } } : { user }), data: { id: nextId(), name: p.name, type: 1, options } });
      return id;
    },
    closeAll(code, reason = '') {
      for (const c of clients) closeClient(c, code, reason);
    },
    op(op, d = null) {
      for (const c of clients) if (c.open) send(c, { op, d });
    },
    close: () =>
      new Promise<void>((r) => {
        for (const c of clients) c.sock.destroy();
        f.server.close(() => r());
      }),
  };

  const send = (c: Client, obj: unknown): void => {
    if (!c.open) return;
    c.sock.write(frame(1, Buffer.from(JSON.stringify(obj))));
  };
  const closeClient = (c: Client, code: number, reason: string): void => {
    if (!c.open) return;
    const p = Buffer.alloc(2 + Buffer.byteLength(reason));
    p.writeUInt16BE(code, 0);
    p.write(reason, 2);
    c.sock.write(frame(8, p));
    c.open = false;
    c.sock.end();
    clients.delete(c);
  };

  const onText = (c: Client, text: string): void => {
    let m: { op: number; d: unknown };
    try {
      m = JSON.parse(text) as { op: number; d: unknown };
    } catch {
      closeClient(c, 4002, 'decode error');
      return;
    }
    f.frames.push({ at: Date.now(), op: m.op, d: m.d });
    const d = (m.d ?? {}) as { token?: string; session_id?: string };
    if (m.op === 1) {
      if (f.ack) send(c, { op: 11 });
    } else if (m.op === 2) {
      if (d.token !== o.token) return closeClient(c, 4004, 'Authentication failed.');
      c.identified = true;
      f.readies++;
      send(c, { op: 0, t: 'READY', s: ++seq, d: { v: 10, session_id: session, resume_gateway_url: f.origin.replace('http:', 'ws:'), user: { id: self, username: 'FakeBot', bot: true }, application: { id: app, flags: 0 }, guilds: (o.guilds ?? []).map((id) => ({ id, unavailable: true })) } });
    } else if (m.op === 6) {
      if (d.token !== o.token) return closeClient(c, 4004, 'Authentication failed.');
      if (d.session_id !== session) {
        send(c, { op: 9, d: false });
        return;
      }
      c.identified = true;
      f.resumed++;
      send(c, { op: 0, t: 'RESUMED', s: ++seq, d: {} });
    }
  };

  const onData = (c: Client, chunk: Buffer): void => {
    c.buf = Buffer.concat([c.buf, chunk]);
    for (;;) {
      if (c.buf.length < 2) return;
      const b0 = c.buf[0]!;
      const b1 = c.buf[1]!;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let at = 2;
      if (len === 126) {
        if (c.buf.length < 4) return;
        len = c.buf.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (c.buf.length < 10) return;
        len = Number(c.buf.readBigUInt64BE(2));
        at = 10;
      }
      const need = at + (masked ? 4 : 0) + len;
      if (c.buf.length < need) return;
      const mask = masked ? c.buf.subarray(at, at + 4) : undefined;
      const data = Buffer.from(c.buf.subarray(at + (masked ? 4 : 0), need));
      if (mask) for (let i = 0; i < data.length; i++) data[i] = data[i]! ^ mask[i & 3]!;
      c.buf = c.buf.subarray(need);
      if (op === 1) onText(c, data.toString('utf8'));
      else if (op === 8) {
        if (c.open) {
          c.sock.write(frame(8, data.subarray(0, 2)));
          c.open = false;
        }
        c.sock.end();
        clients.delete(c);
        return;
      } else if (op === 9) c.sock.write(frame(10, data));
    }
  };

  const onUpgrade = (req: IncomingMessage, sock: Duplex): void => {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      sock.destroy();
      return;
    }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const c: Client = { sock, buf: Buffer.alloc(0), open: true, identified: false };
    clients.add(c);
    f.connections++;
    sock.on('data', (d: Buffer) => onData(c, d));
    sock.on('error', () => clients.delete(c));
    sock.on('close', () => {
      c.open = false;
      clients.delete(c);
    });
    send(c, { op: 10, d: { heartbeat_interval: o.heartbeatMs ?? 41_250 } });
  };

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    let b = '';
    req.on('data', (d: Buffer) => (b += d.toString()));
    req.on('end', () => {
      const path = (req.url ?? '').replace(/^\/api\/v10/, '');
      let body: Record<string, unknown>;
      try {
        body = b ? (JSON.parse(b) as Record<string, unknown>) : {};
      } catch {
        body = { unparsed: b.slice(0, 80) };
      }
      const r: FakeRest = { at: Date.now(), method: req.method ?? 'GET', path, auth: req.headers.authorization, body };
      f.rest.push(r);
      const reply = (status: number, out?: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(out === undefined ? '' : JSON.stringify(out));
      };
      const isCallback = /^\/interactions\/\d+\/[^/]+\/callback$/.test(path);
      const isFollowup = /^\/webhooks\/\d+\/[^/]+(\/messages\/@original)?$/.test(path); // Track D3: authorised by the interaction's token
      if (!isCallback && !isFollowup && r.auth !== `Bot ${o.token}`) return reply(401, { message: '401: Unauthorized', code: 0 });
      if (isCallback) f.callbacks.push(r);
      if (isFollowup) f.followups.push(r);
      const cmds = /^\/applications\/(\d+)(?:\/guilds\/(\d+))?\/commands$/.exec(path);
      if (cmds && r.method === 'PUT') f.puts.push(r);
      const post = /^\/channels\/(\d+)\/messages$/.exec(path);
      const edit = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(path);
      if (r.method === 'POST' && post) f.posts.push(r);
      if (r.method === 'PATCH' && edit) f.edits.push(r);
      const custom = f.answer(r);
      if (custom) return reply(custom.status, custom.body, custom.headers);
      if (r.method === 'GET' && path === '/gateway/bot') return reply(200, { url: f.origin.replace('http:', 'ws:'), shards: 1, session_start_limit: { total: 1000, remaining: 999, reset_after: 0, max_concurrency: 1 } });
      if (r.method === 'POST' && path === '/users/@me/channels') return reply(200, { id: `9${(typeof body.recipient_id === 'string' ? body.recipient_id : '').slice(1)}`, type: 1 });
      if (r.method === 'POST' && post) return reply(200, { id: nextId(), channel_id: post[1], content: body.content });
      if (r.method === 'PATCH' && edit) return reply(200, { id: edit[2], channel_id: edit[1] });
      if (isCallback) return reply(204);
      // Track D3: the slash commands and the set-up check
      if (isFollowup) return reply(200, { id: nextId(), content: body.content });
      if (cmds) {
        if (cmds[1] !== app) return reply(403, { message: 'Missing Access', code: 50001 });
        const scope = cmds[2] ?? 'global';
        if (r.method === 'PUT') {
          const list = (Array.isArray(body) ? body : []) as { name: string }[];
          f.registered.set(scope, list.map((c) => ({ ...c, id: nextId() })));
          return reply(200, f.registered.get(scope));
        }
        if (r.method === 'GET') return reply(200, f.registered.get(scope) ?? []);
      }
      const chan = /^\/channels\/(\d+)$/.exec(path);
      if (r.method === 'GET' && chan) {
        const c = o.channels?.[chan[1]!];
        if (!c) return reply(404, { message: 'Unknown Channel', code: 10003 });
        if (c.status && c.status !== 200) return reply(c.status, { message: c.status === 403 ? 'Missing Access' : 'Unknown Channel', code: c.status === 403 ? 50001 : 10003 });
        return reply(200, { id: chan[1], type: c.type ?? 0, ...(c.guild_id ? { guild_id: c.guild_id } : {}), permission_overwrites: c.permission_overwrites ?? [] });
      }
      const guild = /^\/guilds\/(\d+)$/.exec(path);
      if (r.method === 'GET' && guild) {
        const g = o.guildData?.[guild[1]!];
        return g ? reply(200, { id: guild[1], ...g }) : reply(404, { message: 'Unknown Guild', code: 10004 });
      }
      const member = /^\/guilds\/(\d+)\/members\/(\d+)$/.exec(path);
      if (r.method === 'GET' && member) {
        const m = o.members?.[member[1]!]?.[member[2]!];
        return m ? reply(200, { user: { id: member[2] }, roles: m.roles }) : reply(404, { message: 'Unknown Member', code: 10007 });
      }
      reply(404, { message: 'Unknown', code: 0 });
    });
  };

  const [lo, hi] = o.ports;
  for (let port = lo; port <= hi; port++) {
    const server = createServer(onRequest);
    server.on('upgrade', (req, sock) => onUpgrade(req, sock));
    const ok = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (ok) {
      // [0, 0]: a free port the system picks (the unit tests: two runs on one host never collide)
      const bound = (server.address() as { port: number }).port;
      f.server = server;
      f.port = bound;
      f.origin = `http://127.0.0.1:${bound}`;
      return f;
    }
  }
  throw new Error(`no free port in ${lo}..${hi}`);
}
