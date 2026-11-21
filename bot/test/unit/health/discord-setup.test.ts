// Track D3 (ADR 0118 addendum D3, docs/discord.md "The set-up check"): `!discord setup`'s verdicts, step by step, for a
// good set-up and for each way one goes wrong (the switch, the token, 4004 / 401, 4014, the servers, a user sharing no
// server, a channel unseen (403), unknown (404), seen without the permissions, the notes, the slash commands missing or
// refused), the permission arithmetic, and the lines as chat says them. REST reads come from a table, never Discord.
import { describe, expect, it } from 'vitest';
import type { TokenState } from '../../../src/health/notify/discord-access.ts';
import type { GatewayStatus } from '../../../src/health/notify/discord-gateway.ts';
import type { RestResult } from '../../../src/health/notify/discord-rest.ts';
import { channelPermissions, missingPerms, PERM, setupCheck, setupLines, type SetupInput, type Step } from '../../../src/health/notify/discord-setup.ts';
import { SLASH_DEFS, type ScopeStatus } from '../../../src/health/notify/discord-slash.ts';
import { FAKE_TOKEN } from './discord-access.test.ts';

const OWNER = '111111111111111111';
const OWNER2 = '121212121212121212';
const CHAN = '333333333333333333';
const NOTES = '363636363636363636';
const GUILD = '444444444444444444';
const SELF = '1000000000000000001';
const ROLE = '505050505050505050';
const set: TokenState = { state: 'set', token: FAKE_TOKEN, source: 'file' };
const FOUR = String(1024 + 2048 + 16384 + 65536);

const gw = (o: Partial<GatewayStatus> = {}): GatewayStatus => ({ state: 'ready', since: 0, why: null, self: SELF, app: SELF, guilds: [GUILD], intents: 37376, sessions: 1, resumes: 0, reconnects: 0, lastClose: null, latencyMs: 40, received: 3, sent: 2, ...o });
const registered: ScopeStatus[] = [{ scope: 'global', state: 'ok', how: 'unchanged', at: 0 }, { scope: GUILD, state: 'ok', how: 'registered', at: 0 }];
const names = SLASH_DEFS.map((d) => ({ name: d.cmd.name }));

/** A REST table: path -> answer (absent: 404). */
function table(over: Record<string, RestResult> = {}) {
  const base: Record<string, RestResult> = {
    [`/channels/${CHAN}`]: { ok: true, status: 200, body: { id: CHAN, guild_id: GUILD, type: 0, permission_overwrites: [] } },
    [`/channels/${NOTES}`]: { ok: true, status: 200, body: { id: NOTES, guild_id: GUILD, type: 0, permission_overwrites: [] } },
    [`/guilds/${GUILD}`]: { ok: true, status: 200, body: { id: GUILD, owner_id: OWNER, roles: [{ id: GUILD, permissions: '0' }, { id: ROLE, permissions: FOUR }] } },
    [`/guilds/${GUILD}/members/${SELF}`]: { ok: true, status: 200, body: { roles: [ROLE] } },
    [`/guilds/${GUILD}/members/${OWNER}`]: { ok: true, status: 200, body: { roles: [] } },
    [`/applications/${SELF}/commands`]: { ok: true, status: 200, body: names },
    [`/applications/${SELF}/guilds/${GUILD}/commands`]: { ok: true, status: 200, body: names },
    ...over,
  };
  const calls: string[] = [];
  return { calls, call: (m: string, p: string) => (calls.push(`${m} ${p}`), Promise.resolve<RestResult>(base[p] ?? { ok: false, status: 404, why: 'Unknown' })) };
}

const input = (o: Partial<SetupInput> = {}, t = table()): SetupInput => ({ on: true, token: set, text: true, gateway: gw(), restStopped: false, users: [OWNER], channels: [CHAN], notes: 'dm', slash: registered, call: t.call, ...o });
const step = (steps: Step[], key: string): Step => steps.find((s) => s.key === key)!;

describe('the set-up check', () => {
  it('a good set-up: every step ok, only GETs, the invite link with the application id', async () => {
    const t = table();
    const r = await setupCheck(input({}, t));
    expect(r.steps.map((s) => `${s.key} ${s.state}`)).toEqual(['switch ok', 'token ok', 'gateway ok', 'application ok', 'servers ok', 'users ok', `channel ...3333 ok`, 'notes ok', 'text ok', 'slash ok']);
    expect(t.calls.every((c) => c.startsWith('GET '))).toBe(true);
    expect(setupLines(r)).toEqual([
      'discord setup: 10 ok',
      'ok: switch, token, gateway, application, servers, users, channel ...3333, notes, text, slash',
      `invite: https://discord.com/oauth2/authorize?client_id=${SELF}&scope=bot+applications.commands&permissions=84992`,
    ]);
    for (const l of setupLines(r)) expect(l).not.toContain(FAKE_TOKEN);
  });

  it('the switch off, no token: missing with the fixes; nothing read', async () => {
    const t = table();
    const r = await setupCheck(input({ on: false, token: { state: 'unset' }, gateway: gw({ state: 'off', guilds: null, app: null, self: null }), call: undefined, slash: [] }, t));
    expect(step(r.steps, 'switch')).toMatchObject({ state: 'missing', fix: expect.stringMatching(/^!set discordBot on/) as string });
    expect(step(r.steps, 'token')).toMatchObject({ state: 'missing', fix: expect.stringMatching(/Bot > Reset Token, then put it in env BEDROCKBOT_DISCORD_TOKEN or discord-bot.token/) as string });
    expect(step(r.steps, 'gateway').state).toBe('off');
    expect(step(r.steps, 'application').state).toBe('unknown');
    expect(r.invite).toContain('client_id=<application id>');
    expect(t.calls).toEqual([]);
  });

  it('a token of the wrong shape; a token Discord refused (4004 / 401)', async () => {
    const bad = await setupCheck(input({ token: { state: 'refused', source: 'file', why: 'not the shape of a bot token (three parts joined by dots)' }, call: undefined }));
    expect(step(bad.steps, 'token')).toMatchObject({ state: 'missing', text: 'refused (discord-bot.token: not the shape of a bot token (three parts joined by dots))' });
    const t = table();
    const r = await setupCheck(input({ gateway: gw({ state: 'stopped', why: 'the token was refused (4004): make a new one in the developer portal', guilds: null }) }, t));
    expect(step(r.steps, 'token')).toMatchObject({ state: 'missing', text: 'set (discord-bot.token), but Discord refused it' });
    expect(step(r.steps, 'gateway')).toMatchObject({ state: 'missing', text: 'closed: the token was refused (4004 / 401)' });
    expect(t.calls).toEqual([]); // nothing sent with a refused token
    const rest = await setupCheck(input({ restStopped: true }));
    expect(step(rest.steps, 'token').state).toBe('missing');
  });

  it('4014: the intent switch named; with text commands off the intent is not needed', async () => {
    const r = await setupCheck(input({ gateway: gw({ state: 'stopped', why: 'disallowed intents (4014): switch on the Message Content intent ...' }) }));
    expect(step(r.steps, 'gateway')).toMatchObject({ state: 'missing', text: 'closed 4014: the Message Content intent is not switched on', fix: expect.stringContaining('Bot > Privileged Gateway Intents: Message Content Intent on, Save') as string });
    expect(step(r.steps, 'gateway').fix).toContain('!set discordText off');
    expect(step(r.steps, 'text').state).toBe('missing');
    const off = await setupCheck(input({ text: false, gateway: gw({ intents: 0 }) }));
    expect(step(off.steps, 'text')).toMatchObject({ state: 'ok', text: 'off: slash commands only, the Message Content intent not needed' });
    expect(step(off.steps, 'gateway').text).toBe('connected (no intents: slash commands only)');
  });

  it('the bot in no server; a user sharing none (no DM); not connected yet: unknown', async () => {
    const none = await setupCheck(input({ gateway: gw({ guilds: [] }) }));
    expect(step(none.steps, 'servers')).toMatchObject({ state: 'missing', fix: 'open the invite link below and choose your server' });
    const r = await setupCheck(input({ users: [OWNER, OWNER2] }));
    expect(step(r.steps, 'users')).toMatchObject({ state: 'missing', text: '...1212 shares no server with the bot: no direct message either way' });
    expect(step(r.steps, 'notes')).toMatchObject({ state: 'missing', text: 'notes by DM: ...1212 not reachable' });
    const early = await setupCheck(input({ gateway: gw({ state: 'connecting', guilds: null }) }));
    expect(step(early.steps, 'gateway').state).toBe('unknown');
    expect(step(early.steps, 'servers').state).toBe('unknown');
    expect(step(early.steps, 'users').state).toBe('unknown');
    const nobody = await setupCheck(input({ users: [] }));
    expect(step(nobody.steps, 'users')).toMatchObject({ state: 'missing', fix: expect.stringMatching(/^!set discordUsers <your Discord user id>/) as string });
  });

  it('a channel: 403 (invite it or give it the channel), 404 (a wrong id), seen without Send Messages', async () => {
    const forbidden = await setupCheck(input({}, table({ [`/channels/${CHAN}`]: { ok: false, status: 403, why: 'Missing Access' } })));
    expect(step(forbidden.steps, 'channel ...3333')).toMatchObject({ state: 'missing', text: 'the bot cannot see it (403)', fix: expect.stringMatching(/invite the bot to that server .* or give its role View Channel there/) as string });
    const unknown = await setupCheck(input({}, table({ [`/channels/${CHAN}`]: { ok: false, status: 404, why: 'Unknown Channel' } })));
    expect(step(unknown.steps, 'channel ...3333').text).toMatch(/^no such channel for the bot \(404\)/);
    const deny = await setupCheck(input({}, table({ [`/channels/${CHAN}`]: { ok: true, status: 200, body: { id: CHAN, guild_id: GUILD, permission_overwrites: [{ id: ROLE, type: 0, allow: '0', deny: String(2048) }] } } })));
    expect(step(deny.steps, 'channel ...3333')).toMatchObject({ state: 'missing', text: 'seen, but the bot may not Send Messages there', fix: "channel settings > Permissions: allow the bot's role Send Messages" });
    // slash commands only: the channel needs no permission of its own (an interaction's answer is not a channel message)
    const slashOnly = await setupCheck(input({ text: false }, table({ [`/channels/${CHAN}`]: { ok: true, status: 200, body: { id: CHAN, guild_id: GUILD, permission_overwrites: [{ id: ROLE, type: 0, allow: '0', deny: String(2048) }] } } })));
    expect(step(slashOnly.steps, 'channel ...3333').state).toBe('ok');
    const noChannel = await setupCheck(input({ channels: [] }));
    expect(step(noChannel.steps, 'channels')).toMatchObject({ state: 'ok', text: 'none listed: commands by direct message only' });
  });

  it('the notes: a channel the bot may not post embeds in; none is off', async () => {
    const r = await setupCheck(input({ notes: NOTES }, table({ [`/channels/${NOTES}`]: { ok: true, status: 200, body: { id: NOTES, guild_id: GUILD, permission_overwrites: [{ id: ROLE, type: 0, allow: '0', deny: String(16384) }] } } })));
    expect(step(r.steps, 'notes')).toMatchObject({ state: 'missing', text: 'channel ...3636: seen, but the bot may not Embed Links there' });
    const off = await setupCheck(input({ notes: 'none' }));
    expect(step(off.steps, 'notes').state).toBe('off');
  });

  it('the slash commands: not yet, refused (403: invite again), missing from a scope (sync again)', async () => {
    const early = await setupCheck(input({ slash: [] }));
    expect(step(early.steps, 'slash')).toMatchObject({ state: 'unknown', text: 'not registered yet (after the gateway is ready)' });
    const refused = await setupCheck(input({ slash: [{ scope: 'global', state: 'ok', at: 0 }, { scope: GUILD, state: 'failed', status: 403, why: 'Missing Access', at: 0 }] }));
    expect(step(refused.steps, 'slash')).toMatchObject({ state: 'missing', text: 'registering in server ...4444 failed (403 Missing Access)', fix: 'invite the bot again with the link below (it adds the applications.commands scope)' });
    const lack = await setupCheck(input({}, table({ [`/applications/${SELF}/guilds/${GUILD}/commands`]: { ok: true, status: 200, body: [{ name: 'status' }] } })));
    expect(step(lack.steps, 'slash')).toMatchObject({ state: 'missing', text: 'server ...4444 lacks /come, /goto, /queue, /run, /stop', fix: '!discord commands sync registers them again' });
  });

  it('the lines: the counts, each step not ok with its fix, the rest by name, the invite last; each fits a chat line', async () => {
    const r = await setupCheck(input({ gateway: gw({ state: 'stopped', why: 'disallowed intents (4014): ...' }) }, table({ [`/channels/${CHAN}`]: { ok: false, status: 403, why: 'Missing Access' } })));
    const lines = setupLines(r);
    expect(lines[0]).toBe('discord setup: 7 ok, 3 missing');
    expect(lines.slice(1, 4)).toEqual([
      'missing gateway: closed 4014: the Message Content intent is not switched on; fix: Developer Portal > your application > Bot > Privileged Gateway Intents: Message Content Intent on, Save, then !discord; or !set discordText off',
      'missing channel ...3333: the bot cannot see it (403); fix: invite the bot to that server with the link below, or give its role View Channel there',
      'missing text: on, but the Message Content intent is off; fix: the gateway step',
    ]);
    expect(lines.at(-2)).toBe('ok: switch, token, application, servers, users, notes, slash');
    expect(lines.at(-1)).toMatch(/^invite: https:\/\/discord\.com\/oauth2\/authorize\?client_id=/);
    for (const l of lines) expect(l.length, l).toBeLessThanOrEqual(256);
  });
});

describe('the permissions in a channel', () => {
  const base = { guildId: GUILD, roles: [{ id: GUILD, permissions: String(1024) }, { id: ROLE, permissions: String(2048 | 16384) }], memberId: SELF, memberRoles: [ROLE], overwrites: [] };
  it('@everyone and the roles; administrator and owner all; the overwrites in order: @everyone, roles, member', () => {
    expect(channelPermissions(base)).toBe(1024n | 2048n | 16384n);
    expect(missingPerms(channelPermissions(base), [PERM.view, PERM.send, PERM.embed, PERM.history])).toEqual(['Read Message History']);
    expect(channelPermissions({ ...base, roles: [{ id: GUILD, permissions: '0' }, { id: ROLE, permissions: '8' }] }) & PERM.history).toBe(PERM.history);
    expect(channelPermissions({ ...base, ownerId: SELF, roles: [] }) & PERM.send).toBe(PERM.send);
    const ow = (id: string, type: number, allow: number, deny: number) => ({ id, type, allow: String(allow), deny: String(deny) });
    expect(channelPermissions({ ...base, overwrites: [ow(GUILD, 0, 0, 1024)] }) & PERM.view).toBe(0n); // @everyone may not see it
    expect(channelPermissions({ ...base, overwrites: [ow(GUILD, 0, 0, 1024), ow(ROLE, 0, 1024, 0)] }) & PERM.view).toBe(PERM.view); // the role may
    expect(channelPermissions({ ...base, overwrites: [ow(ROLE, 0, 1024, 0), ow(SELF, 1, 0, 1024)] }) & PERM.view).toBe(0n); // the member's own wins
  });
});
