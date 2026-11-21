// Track D3 (ADR 0118 addendum D3, docs/discord.md "Slash commands"): the slash commands as pure functions: the
// registration bodies as JSON, the chat line each interaction stands for, the autocomplete answers, the registration's
// hash rule (a PUT only when a scope's set changed; kept in a file across restarts; a server no longer wanted emptied),
// the interaction door, the application id and the invite link.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commandInfo } from '../../../src/chat/help.ts';
import { appIdFromToken, interactionGate, INTERACTION_REFUSAL, inviteUrl, refusal, scrubToken } from '../../../src/health/notify/discord-access.ts';
import type { RestResult } from '../../../src/health/notify/discord-rest.ts';
import { autocomplete, CHOICES_MAX, commandsHash, COMMANDS_FILE, SLASH_DEFS, SlashRegistry, slashLine, slashPayload, slashText, syntaxWords } from '../../../src/health/notify/discord-slash.ts';

const OWNER = '111111111111111111';
const CHAN = '333333333333333333';
const GUILD = '444444444444444444';
const GUILD2 = '454545454545454545';
const APP = '1000000000000000001';

describe('the registration bodies (JSON)', () => {
  it('six commands; global ones only in DMs with the bot; guild ones plain; every option a string with autocomplete', () => {
    expect(JSON.stringify(slashPayload('guild'), null, 1)).toBe(JSON.stringify(
      [
        { name: 'status', type: 1, description: 'What the bot is doing now (!status)' },
        { name: 'stop', type: 1, description: 'Stop every command now; guard and night keep running (!stop)' },
        { name: 'come', type: 1, description: 'Walk to the owner in the game (!come)' },
        { name: 'goto', type: 1, description: 'Walk to a waypoint or to x y z (!goto)', options: [{ type: 3, name: 'place', description: 'A waypoint name (offered as you type), or x y z', required: true, autocomplete: true, max_length: 400 }] },
        { name: 'queue', type: 1, description: 'The job queue: show it, or add, pause, resume, clear (!queue)', options: [{ type: 3, name: 'do', description: 'Empty: show the queue; or add <command>, pause, resume, clear, retry <id>', autocomplete: true, max_length: 400 }] },
        { name: 'run', type: 1, description: 'Run any bot command line, as typed after ! in the game', options: [{ type: 3, name: 'line', description: 'The command and its arguments, e.g. get wood 16 (offered as you type)', required: true, autocomplete: true, max_length: 400 }] },
      ],
      null,
      1,
    ));
    const global = slashPayload('global');
    expect(global.map((c) => c.name)).toEqual(['status', 'stop', 'come', 'goto', 'queue', 'run']);
    for (const c of global) expect(c).toMatchObject({ contexts: [1], integration_types: [0] });
    // Discord's limits: names 1 to 32 lower-case, descriptions 1 to 100
    for (const c of [...slashPayload('guild'), ...SLASH_DEFS.flatMap((d) => d.cmd.options ?? [])]) {
      expect(c.name).toMatch(/^[a-z0-9_-]{1,32}$/);
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.description.length).toBeLessThanOrEqual(100);
    }
  });
});

describe('the line a slash command stands for', () => {
  const data = (name: string, o: Record<string, string> = {}) => ({ name, options: Object.entries(o).map(([n, value]) => ({ name: n, type: 3, value })) });
  it('each command; a typed prefix taken off; control characters and doubled spaces gone; an unknown command none', () => {
    expect(slashLine(data('status'), '!')).toBe('!status');
    expect(slashLine(data('stop'), '!')).toBe('!stop');
    expect(slashLine(data('come'), '!')).toBe('!come');
    expect(slashLine(data('goto', { place: 'home' }), '!')).toBe('!goto home');
    expect(slashLine(data('goto', { place: ' 10  64\t-3 ' }), '!')).toBe('!goto 10 64 -3');
    expect(slashLine(data('queue'), '!')).toBe('!queue');
    expect(slashLine(data('queue', { do: 'add !get wood 16' }), '!')).toBe('!queue add !get wood 16');
    expect(slashLine(data('run', { line: '!!get wood 16' }), '!')).toBe('!get wood 16');
    expect(slashLine(data('run', { line: 'pos\nquit' }), '!')).toBe('!pos quit'); // one line, never two commands
    expect(slashLine(data('run', { line: '' }), '!')).toBeUndefined();
    expect(slashLine(data('quit'), '!')).toBeUndefined();
    expect(slashLine(undefined, '!')).toBeUndefined();
    expect(slashLine(data('goto', { place: 'base' }), '.')).toBe('.goto base');
  });

  it('the same refusals as a typed line: /run quit, /queue add of a refused line, /run set of a door key', () => {
    const r = (line: string) => {
      const l = slashLine(data('run', { line }), '!')!;
      const [name, ...args] = l.slice(1).split(' ');
      return refusal(name!, args);
    };
    expect(r('quit')).toMatch(/ends the bot/);
    expect(r('test cmd say hi')).toMatch(/test bench/);
    expect(r('set discordText off')).toMatch(/its own door/);
    expect(r('set discordUsers none')).toMatch(/its own door/);
    expect(r('queue add !quit')).toMatch(/^the queued line: it ends the bot/);
    expect(r('pos')).toBeUndefined();
  });
});

describe('autocomplete', () => {
  const cmds = [
    commandInfo({ name: 'goto', help: '<waypoint> | x y z [now] (walk to a waypoint or a feet block; now: before the night shelter)', group: 'go' }),
    commandInfo({ name: 'get', help: '<item> [n] | kit [iron] (get an item: mine, craft, smelt)', tier: 'front', group: 'work', example: '!get wood 16' }),
    commandInfo({ name: 'queue', help: '[add <command> | remove <id> | move <id> <pos> | clear [ended] | pause | resume | retry <id> | onfail next|stop] (jobs run one after another)', group: 'control' }),
    commandInfo({ name: 'status', help: '(what it is doing now)', tier: 'front', group: 'info' }),
    commandInfo({ name: 'quit', help: '(ends the bot)', group: 'control' }),
    commandInfo({ name: 'pos', help: '(where it stands)', group: 'info' }),
  ];
  const wps = ['home', 'base', 'mine_entrance', 'nether_portal'];
  const ac = (name: string, focused: string, value: string, extra: Record<string, string> = {}) => autocomplete({ data: { name, options: [{ name: focused, type: 3, value, focused: true }, ...Object.entries(extra).map(([n, v]) => ({ name: n, type: 3, value: v }))] }, commands: cmds, waypoints: wps, prefix: '!' });

  it('/goto: the waypoints, those starting with what is typed first, then those holding it; x y z kept as typed', () => {
    expect(ac('goto', 'place', '').map((c) => c.value)).toEqual(wps);
    expect(ac('goto', 'place', 'n').map((c) => c.value)).toEqual(['nether_portal', 'mine_entrance']);
    expect(ac('goto', 'place', '10 64 3')).toEqual([{ name: '10 64 3', value: '10 64 3' }]);
  });

  it('/run: the command names with their phrase (the front door first, never a refused one), then the arguments', () => {
    const names = ac('run', 'line', '');
    expect(names.map((c) => c.value)).toEqual(['get', 'status', 'goto', 'pos', 'queue']); // front first; quit never
    expect(names[0]).toEqual({ name: 'get: get an item: mine, craft, smelt', value: 'get' });
    expect(ac('run', 'line', '!st').map((c) => c.value)).toEqual(['status']);
    expect(ac('run', 'line', 'goto ').map((c) => c.value)).toEqual(['goto', 'goto home', 'goto base', 'goto mine_entrance', 'goto nether_portal']);
    expect(ac('run', 'line', 'goto ba').map((c) => c.value)).toEqual(['goto ba', 'goto base']);
    expect(ac('run', 'line', 'get ').map((c) => c.value)).toEqual(['get', 'get kit', 'get wood 16']);
    expect(ac('run', 'line', 'get w')).toEqual([{ name: 'get w', value: 'get w' }, { name: 'get wood 16 (the example)', value: 'get wood 16' }]);
    expect(ac('run', 'line', 'queue add go').map((c) => c.value)).toEqual(['queue add go', 'queue add goto']);
    expect(ac('run', 'line', 'nosuch thing')).toEqual([{ name: 'nosuch thing', value: 'nosuch thing' }]);
  });

  it('/queue: its own words, and `add` completes the queued line as /run does', () => {
    expect(ac('queue', 'do', '').map((c) => c.value)).toEqual(['add', 'remove', 'move', 'clear', 'pause', 'resume', 'retry', 'onfail']);
    expect(ac('queue', 'do', 'p').map((c) => c.value)).toEqual(['p', 'pause']);
    expect(ac('queue', 'do', 'add st').map((c) => c.value)).toEqual(['add status']);
    expect(syntaxWords('[add <command> | clear [ended] | onfail next|stop]')).toEqual(['add', 'clear', 'onfail']);
  });

  it('at most 25 choices of at most 100 characters; another option or command: none', () => {
    const many = Array.from({ length: 40 }, (_, i) => `wp${i}${'x'.repeat(120)}`);
    const got = autocomplete({ data: { name: 'goto', options: [{ name: 'place', value: 'wp', focused: true }] }, commands: cmds, waypoints: many, prefix: '!' });
    expect(got).toHaveLength(CHOICES_MAX);
    for (const c of got) expect(c.name.length <= 100 && c.value.length <= 100).toBe(true);
    expect(autocomplete({ data: { name: 'status' }, commands: cmds, waypoints: wps, prefix: '!' })).toEqual([]);
    expect(autocomplete({ data: undefined, commands: cmds, waypoints: wps, prefix: '!' })).toEqual([]);
  });
});

describe('the door for an interaction', () => {
  const rules = { users: new Set([OWNER]), channels: new Set([CHAN]) };
  it('an allowed user in a listed channel or a DM; a stranger anywhere; another channel', () => {
    expect(interactionGate({ userId: OWNER, guildId: GUILD, channelId: CHAN }, rules)).toEqual({ run: true, dm: false });
    expect(interactionGate({ userId: OWNER, channelId: '919191919191919191' }, rules)).toEqual({ run: true, dm: true });
    expect(interactionGate({ userId: '222222222222222222', guildId: GUILD, channelId: CHAN }, rules)).toEqual({ run: false, why: 'stranger' });
    expect(interactionGate({ userId: '222222222222222222', channelId: '919191919191919191' }, rules)).toEqual({ run: false, why: 'stranger' });
    expect(interactionGate({ userId: OWNER, guildId: GUILD, channelId: '343434343434343434' }, rules)).toEqual({ run: false, why: 'channel' });
    expect(interactionGate({ userId: '', channelId: CHAN }, rules)).toEqual({ run: false, why: 'stranger' });
    expect(INTERACTION_REFUSAL.stranger).not.toMatch(/\d{17}/); // nothing about the set-up
  });

  it('the application id from a token\'s first part; the invite link; a follow-up URL scrubbed', () => {
    const id = '123456789012345678';
    const tok = `${Buffer.from(id).toString('base64').replace(/=+$/, '')}.abcdef.${'x'.repeat(27)}`;
    expect(appIdFromToken(tok)).toBe(id);
    expect(appIdFromToken('NOT-A-REAL-TOKEN-unit-test-d1.fake00.NOT-A-REAL-TOKEN-just-for-the-tests')).toBeUndefined();
    expect(appIdFromToken(undefined)).toBeUndefined();
    expect(inviteUrl(id)).toBe(`https://discord.com/oauth2/authorize?client_id=${id}&scope=bot+applications.commands&permissions=84992`);
    expect(inviteUrl(undefined)).toContain('client_id=<application id>');
    expect(scrubToken(`POST /webhooks/${APP}/aW50ZXJhY3Rpb246MTIzOmFiY2RlZg/messages/@original`)).toBe(`POST /webhooks/${APP}/***/messages/@original`);
  });
});

describe('the registration and its hash', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const fakeCall = (answer: (m: string, p: string) => RestResult = () => ({ ok: true, status: 200, body: [] })) => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    return { calls, call: (method: string, path: string, body?: unknown) => (calls.push({ method, path, body }), Promise.resolve(answer(method, path))) };
  };

  it('registers global and each server once; nothing again after a restart; a change re-registers only that scope; a server dropped is emptied', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bb-d3-'));
    const file = join(dir, COMMANDS_FILE);
    const f = fakeCall();
    const reg = new SlashRegistry({ file, call: f.call });
    const st = await reg.sync(APP, [GUILD]);
    expect(f.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`PUT /applications/${APP}/commands`, `PUT /applications/${APP}/guilds/${GUILD}/commands`]);
    expect(f.calls[0]!.body).toEqual(slashPayload('global'));
    expect(f.calls[1]!.body).toEqual(slashPayload('guild'));
    expect(st.map((s) => `${s.scope} ${s.state} ${s.how}`)).toEqual([`global ok registered`, `${GUILD} ok registered`]);
    expect(slashText(st)).toBe('6 for DMs and 1 server');
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { v: number; scopes: Record<string, string> };
    expect(saved).toEqual({ v: 1, scopes: { global: commandsHash(APP, 'global', slashPayload('global')), [GUILD]: commandsHash(APP, GUILD, slashPayload('guild')) } });
    // the same set: no call; a new registry (a restart) reads the file
    await reg.sync(APP, [GUILD]);
    const again = new SlashRegistry({ file, call: f.call });
    expect((await again.sync(APP, [GUILD])).map((s) => s.how)).toEqual(['unchanged', 'unchanged']);
    expect(f.calls).toHaveLength(2);
    // another server instead: that one registered, the old one emptied
    await again.sync(APP, [GUILD2]);
    expect(f.calls.slice(2).map((c) => `${c.method} ${c.path} ${JSON.stringify(c.body).length}`)).toEqual([`PUT /applications/${APP}/guilds/${GUILD2}/commands ${JSON.stringify(slashPayload('guild')).length}`, `PUT /applications/${APP}/guilds/${GUILD}/commands 2`]);
    expect(again.known().sort()).toEqual([GUILD2, 'global'].sort());
    // another application (a new bot): all again; force: all again
    await again.sync('1000000000000000002', [GUILD2]);
    expect(f.calls).toHaveLength(6);
    await again.sync('1000000000000000002', [GUILD2], true);
    expect(f.calls).toHaveLength(8);
  });

  it('a failed PUT is not remembered (tried at the next sync) and says why; remove empties every scope; no file: memory only', async () => {
    let fail = true;
    const f = fakeCall((m, p) => (fail && p.includes('/guilds/') ? { ok: false, status: 403, why: 'Missing Access' } : { ok: true, status: 200, body: [] }));
    const reg = new SlashRegistry({ call: f.call });
    const st = await reg.sync(APP, [GUILD]);
    expect(st[1]).toMatchObject({ scope: GUILD, state: 'failed', status: 403, why: 'Missing Access' });
    expect(slashText(st)).toBe('6 for DMs; 1 failed (403 Missing Access)');
    fail = false;
    await reg.sync(APP, [GUILD]);
    expect(f.calls.map((c) => c.path)).toEqual([`/applications/${APP}/commands`, `/applications/${APP}/guilds/${GUILD}/commands`, `/applications/${APP}/guilds/${GUILD}/commands`]);
    const gone = await reg.remove(APP);
    expect(gone.map((s) => `${s.scope} ${s.state}`)).toEqual(['global removed', `${GUILD} removed`]);
    expect(f.calls.slice(-2).map((c) => c.body)).toEqual([[], []]);
    expect(reg.known()).toEqual([]);
  });

  it('a broken file is read as nothing registered', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bb-d3-'));
    const file = join(dir, COMMANDS_FILE);
    writeFileSync(file, '{ not json');
    const f = fakeCall();
    await new SlashRegistry({ file, call: f.call }).sync(APP, []);
    expect(f.calls).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ v: 1 });
  });
});
