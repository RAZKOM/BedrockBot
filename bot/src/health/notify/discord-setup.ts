// `!discord setup` (Track D3, ADR 0118 addendum D3, docs/discord.md "The set-up check"): each step of the set-up with
// ok / missing / unknown / off and the one-line fix, so a user who missed one step (the intent, the invite, an id, the
// token) is told which. What it reads: the switch, the token's state (never the token), the gateway's state and READY's
// servers, and a few REST reads (GET only: each listed channel, its server's roles and the bot's member, each listed
// user's member in the bot's servers, the registered slash commands). It sends nothing and changes nothing.
//
//   const r = await setupCheck({ on, token, text, gateway, users, channels, notes, slash, call });
//   setupLines(r)   // 'discord setup: 8 ok, 1 missing' / 'missing gateway: ...; fix: ...' / 'ok: ...' / 'invite: ...'
import { appIdFromToken, inviteUrl, notesText, SNOWFLAKE_RE, tokenText, type TokenState } from './discord-access.ts';
import type { GatewayStatus } from './discord-gateway.ts';
import type { RestResult } from './discord-rest.ts';
import { scopePath, SLASH_DEFS, slashText, type ScopeStatus } from './discord-slash.ts';

export type StepState = 'ok' | 'missing' | 'unknown' | 'off';

export interface Step {
  key: string;
  state: StepState;
  text: string;
  fix?: string;
}

/** Discord's permission bits the bot needs in a channel it answers in (text commands, notes). */
export const PERM = { admin: 1n << 3n, view: 1n << 10n, send: 1n << 11n, embed: 1n << 14n, history: 1n << 16n } as const;
const PERM_NAMES: [bigint, string][] = [
  [PERM.view, 'View Channel'],
  [PERM.send, 'Send Messages'],
  [PERM.embed, 'Embed Links'],
  [PERM.history, 'Read Message History'],
];

export interface Overwrite {
  id: string;
  /** 0 a role, 1 a member. */
  type: number;
  allow: string;
  deny: string;
}

const big = (s: unknown): bigint => {
  try {
    return typeof s === 'string' || typeof s === 'number' ? BigInt(s) : 0n;
  } catch {
    return 0n;
  }
};

/**
 * The bot's permissions in a channel, as Discord computes them: the @everyone role and the bot's roles, all for an
 * administrator or the server's owner; then the channel's overwrites: @everyone's, the roles' (denies, then allows), the
 * member's own.
 */
export function channelPermissions(o: { guildId: string; ownerId?: string | undefined; roles: readonly { id: string; permissions: string }[]; memberId: string; memberRoles: readonly string[]; overwrites: readonly Overwrite[] }): bigint {
  const all = (1n << 53n) - 1n;
  if (o.ownerId && o.ownerId === o.memberId) return all;
  const role = new Map(o.roles.map((r) => [r.id, big(r.permissions)]));
  let p = role.get(o.guildId) ?? 0n;
  for (const r of o.memberRoles) p |= role.get(r) ?? 0n;
  if (p & PERM.admin) return all;
  const ev = o.overwrites.find((w) => w.id === o.guildId);
  if (ev) p = (p & ~big(ev.deny)) | big(ev.allow);
  let allow = 0n;
  let deny = 0n;
  for (const w of o.overwrites) if (w.type === 0 && o.memberRoles.includes(w.id)) {
    allow |= big(w.allow);
    deny |= big(w.deny);
  }
  p = (p & ~deny) | allow;
  const me = o.overwrites.find((w) => w.type === 1 && w.id === o.memberId);
  if (me) p = (p & ~big(me.deny)) | big(me.allow);
  return p;
}

/** The names of the bits in `need` that `have` lacks. */
export function missingPerms(have: bigint, need: readonly bigint[]): string[] {
  return PERM_NAMES.filter(([b]) => need.includes(b) && (have & b) === 0n).map(([, n]) => n);
}

export interface SetupInput {
  on: boolean;
  /** Why nothing may connect (the test origin refused). */
  blocked?: string | undefined;
  token: TokenState;
  /** `discordText`. */
  text: boolean;
  gateway: GatewayStatus;
  /** A 401 stopped every REST call (the token refused). */
  restStopped: boolean;
  users: readonly string[];
  channels: readonly string[];
  /** `discordNotes`: dm, none or a channel id. */
  notes: string;
  /** The registration's last result (SlashRegistry.status). */
  slash: readonly ScopeStatus[];
  /** A REST GET (DiscordRest.call); undefined: no REST read (no token, or refused). */
  call?: ((method: string, path: string) => Promise<RestResult>) | undefined;
  /** Servers at most whose members are read for each user. */
  guildsMax?: number;
}

export interface SetupResult {
  steps: Step[];
  app: string | undefined;
  invite: string;
}

const last4 = (id: string): string => `...${id.slice(-4)}`;
const PORTAL = 'Developer Portal > your application';

/** One channel: seen by the bot, in which server, and what it may do there. */
async function probeChannel(id: string, need: readonly bigint[], i: SetupInput, self: string | null): Promise<Step> {
  const key = `channel ${last4(id)}`;
  const r = await i.call!('GET', `/channels/${id}`);
  if (!r.ok) {
    if (r.status === 403) return { key, state: 'missing', text: 'the bot cannot see it (403)', fix: 'invite the bot to that server with the link below, or give its role View Channel there' };
    if (r.status === 404) return { key, state: 'missing', text: 'no such channel for the bot (404): a wrong id, or a server the bot is not in', fix: 'Copy Channel ID again (Developer Mode), or invite the bot with the link below' };
    return { key, state: 'unknown', text: `not read (${r.status ?? 'no answer'} ${r.why})` };
  }
  const ch = (r.body ?? {}) as { guild_id?: unknown; type?: unknown; permission_overwrites?: unknown };
  const guild = typeof ch.guild_id === 'string' ? ch.guild_id : undefined;
  if (!guild) return { key, state: 'missing', text: 'a direct-message channel, not a server channel', fix: 'list a server channel in discordChannels; direct messages are always taken' };
  if (!need.length) return { key, state: 'ok', text: `seen, in server ${last4(guild)}` };
  if (!self) return { key, state: 'unknown', text: `seen, in server ${last4(guild)}; its permissions need the gateway first` };
  const [g, m] = await Promise.all([i.call!('GET', `/guilds/${guild}`), i.call!('GET', `/guilds/${guild}/members/${self}`)]);
  if (!g.ok || !m.ok) return { key, state: 'unknown', text: `seen, in server ${last4(guild)}; its permissions not read (${(!g.ok ? g : m).status ?? 'no answer'})` };
  const gb = (g.body ?? {}) as { owner_id?: unknown; roles?: unknown };
  const roles = Array.isArray(gb.roles) ? (gb.roles as { id?: unknown; permissions?: unknown }[]).filter((x) => typeof x?.id === 'string').map((x) => ({ id: x.id as string, permissions: typeof x.permissions === 'string' || typeof x.permissions === 'number' ? String(x.permissions) : '0' })) : [];
  const mr = Array.isArray((m.body as { roles?: unknown } | undefined)?.roles) ? (m.body as { roles: unknown[] }).roles.filter((x): x is string => typeof x === 'string') : [];
  const ow = Array.isArray(ch.permission_overwrites) ? (ch.permission_overwrites as Partial<Overwrite>[]).filter((w) => typeof w?.id === 'string').map((w) => ({ id: w.id!, type: Number(w.type ?? 0), allow: String(w.allow ?? '0'), deny: String(w.deny ?? '0') })) : [];
  const have = channelPermissions({ guildId: guild, ownerId: typeof gb.owner_id === 'string' ? gb.owner_id : undefined, roles, memberId: self, memberRoles: mr, overwrites: ow });
  const lack = missingPerms(have, need);
  if (lack.length) return { key, state: 'missing', text: `seen, but the bot may not ${lack.join(', ')} there`, fix: `channel settings > Permissions: allow the bot's role ${lack.join(', ')}` };
  return { key, state: 'ok', text: `seen and writable, in server ${last4(guild)}` };
}

/** Does each user share a server with the bot (needed for DMs both ways)? */
async function probeUsers(i: SetupInput, guilds: readonly string[]): Promise<Map<string, 'yes' | 'no' | 'unknown'>> {
  const out = new Map<string, 'yes' | 'no' | 'unknown'>();
  for (const u of i.users) {
    let v: 'yes' | 'no' | 'unknown' = guilds.length ? 'no' : 'unknown';
    for (const g of guilds.slice(0, i.guildsMax ?? 5)) {
      const r = await i.call!('GET', `/guilds/${g}/members/${u}`);
      if (r.ok) {
        v = 'yes';
        break;
      }
      if (r.status !== 404) v = 'unknown';
    }
    out.set(u, v);
  }
  return out;
}

/** The registered commands: each scope's list read back and compared by name. */
async function probeSlash(i: SetupInput, app: string): Promise<Step> {
  const want = SLASH_DEFS.map((d) => d.cmd.name).sort();
  const scopes = i.slash.filter((s) => s.state !== 'removed').map((s) => s.scope);
  if (!scopes.length) return { key: 'slash', state: 'unknown', text: 'not registered yet (after the gateway is ready)', fix: 'wait for the gateway, then !discord setup again; or !discord commands sync' };
  const failed = i.slash.filter((s) => s.state === 'failed');
  if (failed.length) {
    const f = failed[0]!;
    const where = f.scope === 'global' ? 'for DMs' : `in server ${last4(f.scope)}`;
    return { key: 'slash', state: 'missing', text: `registering ${where} failed (${[f.status ?? 'no answer', f.why].filter(Boolean).join(' ')})`, fix: f.status === 403 ? 'invite the bot again with the link below (it adds the applications.commands scope)' : '!discord commands sync tries again' };
  }
  for (const s of scopes) {
    const r = await i.call!('GET', scopePath(app, s));
    if (!r.ok) return { key: 'slash', state: 'unknown', text: `${slashText(i.slash)}; not read back (${r.status ?? 'no answer'})` };
    const names = Array.isArray(r.body) ? (r.body as { name?: unknown }[]).map((c) => c?.name).filter((n): n is string => typeof n === 'string').sort() : [];
    const lack = want.filter((n) => !names.includes(n));
    if (lack.length) return { key: 'slash', state: 'missing', text: `${s === 'global' ? 'DMs' : `server ${last4(s)}`} lacks /${lack.join(', /')}`, fix: '!discord commands sync registers them again' };
  }
  return { key: 'slash', state: 'ok', text: `/${want.join(', /')}: ${slashText(i.slash)}` };
}

export async function setupCheck(i: SetupInput): Promise<SetupResult> {
  const steps: Step[] = [];
  const g = i.gateway;
  const tok = i.token.state === 'set' ? i.token.token : undefined;
  const app = g.app ?? appIdFromToken(tok) ?? undefined;
  const why = g.why ?? '';
  const refused = i.restStopped || why.includes('(4004)') || why.includes('(401)');
  const intentOff = g.state === 'stopped' && why.includes('(4014)');
  // the switch
  if (i.blocked) steps.push({ key: 'switch', state: 'missing', text: i.blocked });
  else steps.push(i.on ? { key: 'switch', state: 'ok', text: 'discordBot on' } : { key: 'switch', state: 'missing', text: 'discordBot off', fix: '!set discordBot on (in the game, the panel or settings.json)' });
  // the token
  if (i.token.state === 'unset') steps.push({ key: 'token', state: 'missing', text: 'not set', fix: `${PORTAL} > Bot > Reset Token, then put it in env BEDROCKBOT_DISCORD_TOKEN or discord-bot.token next to config.json` });
  else if (i.token.state === 'refused') steps.push({ key: 'token', state: 'missing', text: tokenText(i.token), fix: 'put the bot token itself there (three parts joined by dots), never in chat' });
  else if (refused) steps.push({ key: 'token', state: 'missing', text: `${tokenText(i.token)}, but Discord refused it`, fix: `${PORTAL} > Bot > Reset Token, put the new one in place, then !discord` });
  else steps.push({ key: 'token', state: 'ok', text: `${tokenText(i.token)}, the shape of a bot token` });
  // the gateway
  const want = i.text ? 'intents: messages and their content' : 'no intents: slash commands only';
  if (!i.on) steps.push({ key: 'gateway', state: 'off', text: 'not connected (the switch is off)' });
  else if (g.state === 'ready') steps.push({ key: 'gateway', state: 'ok', text: `connected (${want})` });
  else if (intentOff) steps.push({ key: 'gateway', state: 'missing', text: 'closed 4014: the Message Content intent is not switched on', fix: `${PORTAL} > Bot > Privileged Gateway Intents: Message Content Intent on, Save, then !discord; or !set discordText off` });
  else if (g.state === 'stopped' && refused) steps.push({ key: 'gateway', state: 'missing', text: 'closed: the token was refused (4004 / 401)', fix: 'a new token (the token step)' });
  else if (g.state === 'stopped') steps.push({ key: 'gateway', state: 'missing', text: `stopped: ${g.why ?? 'no reason'}`, fix: '!set discordBot off, then on, once the cause is fixed' });
  else steps.push({ key: 'gateway', state: 'unknown', text: `${g.state}${g.lastClose ? ` (last: ${g.lastClose})` : ''}`, fix: 'wait a few seconds, then !discord setup again' });
  // the application id
  steps.push(app ? { key: 'application', state: 'ok', text: `id ${app} (not a secret: it is in the invite link)` } : { key: 'application', state: 'unknown', text: 'not known before the gateway is ready', fix: `${PORTAL} > OAuth2: the Client ID` });
  // the servers
  const guilds = g.guilds;
  if (guilds === null) steps.push({ key: 'servers', state: 'unknown', text: 'known once the gateway is ready' });
  else if (!guilds.length) steps.push({ key: 'servers', state: 'missing', text: 'the bot is in no server', fix: 'open the invite link below and choose your server' });
  else steps.push({ key: 'servers', state: 'ok', text: `in ${guilds.length} server${guilds.length === 1 ? '' : 's'}` });
  const rest = i.call && !refused && i.token.state === 'set';
  // the users
  if (!i.users.length) steps.push({ key: 'users', state: 'missing', text: 'nobody may command the bot', fix: '!set discordUsers <your Discord user id> (Developer Mode, then right-click your name > Copy User ID)' });
  let share = new Map<string, 'yes' | 'no' | 'unknown'>();
  if (i.users.length) {
    if (!rest || !guilds) steps.push({ key: 'users', state: 'unknown', text: `${i.users.length} listed; whether each shares a server with the bot needs the gateway and the token` });
    else {
      share = await probeUsers(i, guilds);
      const no = i.users.filter((u) => share.get(u) === 'no');
      const unk = i.users.filter((u) => share.get(u) === 'unknown');
      if (no.length) steps.push({ key: 'users', state: 'missing', text: `${no.map(last4).join(', ')} shares no server with the bot: no direct message either way`, fix: 'join a server the bot is in, or invite the bot to yours' });
      else if (unk.length) steps.push({ key: 'users', state: 'unknown', text: `${unk.map(last4).join(', ')}: not read` });
      else steps.push({ key: 'users', state: 'ok', text: `${i.users.length} listed, each in a server with the bot` });
    }
  }
  // the channels: text replies need the four permissions; a slash command's answer needs none
  const need = i.text ? [PERM.view, PERM.send, PERM.embed, PERM.history] : [];
  if (!i.channels.length) steps.push({ key: 'channels', state: 'ok', text: 'none listed: commands by direct message only' });
  else if (!rest) steps.push({ key: 'channels', state: 'unknown', text: `${i.channels.length} listed; not read without a working token` });
  else for (const c of i.channels) steps.push(await probeChannel(c, need, i, g.self));
  // the notes
  if (i.notes === 'none') steps.push({ key: 'notes', state: 'off', text: 'discordNotes none: no notes to Discord' });
  else if (i.notes === 'dm') {
    if (!i.users.length) steps.push({ key: 'notes', state: 'missing', text: 'notes by DM, but no user is listed', fix: '!set discordUsers <your id>' });
    else if (!rest || !guilds) steps.push({ key: 'notes', state: 'unknown', text: 'notes by DM; known with the gateway and the token' });
    else {
      const no = i.users.filter((u) => share.get(u) !== 'yes');
      steps.push(no.length ? { key: 'notes', state: share.get(no[0]!) === 'no' ? 'missing' : 'unknown', text: `notes by DM: ${no.map(last4).join(', ')} not reachable`, fix: 'a shared server (the users step); or !set discordNotes <channel id>' } : { key: 'notes', state: 'ok', text: `notes by DM to ${i.users.length} (a user's privacy settings may still refuse them: !discord test)` });
    }
  } else if (!SNOWFLAKE_RE.test(i.notes)) steps.push({ key: 'notes', state: 'unknown', text: `discordNotes ${i.notes}` });
  else if (!rest) steps.push({ key: 'notes', state: 'unknown', text: `notes to ${notesText(i.notes)}; not read without a working token` });
  else {
    const s = await probeChannel(i.notes, [PERM.view, PERM.send, PERM.embed], i, g.self);
    steps.push({ ...s, key: 'notes', text: `${notesText(i.notes)}: ${s.text}` });
  }
  // text commands and the intent
  if (!i.text) steps.push({ key: 'text', state: 'ok', text: 'off: slash commands only, the Message Content intent not needed' });
  else if (intentOff) steps.push({ key: 'text', state: 'missing', text: 'on, but the Message Content intent is off', fix: 'the gateway step' });
  else steps.push({ key: 'text', state: g.state === 'ready' ? 'ok' : 'unknown', text: g.state === 'ready' ? 'on (the Message Content intent is on)' : 'on: needs the Message Content intent (known once connected)' });
  // the slash commands
  if (!rest || !app) steps.push({ key: 'slash', state: 'unknown', text: 'not checked without a working token and the application id' });
  else steps.push(await probeSlash(i, app));
  return { steps, app, invite: inviteUrl(app) };
}

/** The check as chat lines: the counts, each step not ok with its fix, the ok ones by name, the invite link. */
export function setupLines(r: SetupResult): string[] {
  const n = (s: StepState): number => r.steps.filter((x) => x.state === s).length;
  const counts = (['ok', 'missing', 'unknown', 'off'] as const).filter((s) => n(s) > 0).map((s) => `${n(s)} ${s}`).join(', ');
  const out = [`discord setup: ${counts}`];
  for (const s of r.steps) if (s.state !== 'ok') out.push(`${s.state} ${s.key}: ${s.text}${s.fix ? `; fix: ${s.fix}` : ''}`);
  const ok = r.steps.filter((s) => s.state === 'ok');
  if (ok.length) out.push(`ok: ${ok.map((s) => s.key).join(', ')}`);
  out.push(`invite: ${r.invite}`);
  return out;
}
