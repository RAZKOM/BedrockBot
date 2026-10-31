// Chat style (docs/chat-style.md, decision 0050): colours, the Doc layout, the Chat hooks, the rich help,
// and the two guards that keep future work on the rails (every setting in a group; no stray section signs).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Chat, type CommandDef } from '../../../src/chat/chat.ts';
import { colorsDemo, registerStyleCommands } from '../../../src/chat/commands-style.ts';
import { settingGroups, SETTING_GROUPS } from '../../../src/chat/help.ts';
import { SETTING_DEFS, SETTING_KEYS } from '../../../src/config/settings.ts';
import { colorize, DOC_MESSAGE, Doc, fitWire, isStyled, MAX_WIRE, paint, strip } from '../../../src/chat/style.ts';
import { commandRequestPacket, fitsTellraw, SLASH_MAX, tellrawCommand, TellrawRoute } from '../../../src/chat/route.ts';
import { silentLogger } from '../../../src/log.ts';
import { connectAndSpawn, setup, type FakeClient } from '../connection-fakes.ts';

const S = '§';

/** Real reply shapes from the bot (docs, logs) plus awkward ones. */
const CORPUS = [
  'status: up 2s, session 2s, reconnects 0, kicks 0, pos 0.50 -60.00 0.50, version 1.26.51, tick 12, nudges 3',
  'build fill 5x3x5: done, 75 / 75 placed, 0 skipped in 56 s (80 blocks/min)',
  'goto: no path to 100 64 -50 (blacklisted, try !come)',
  'paused: gather (!resume to continue)',
  'unknown command !dance; try !help',
  'mine iron_ore: 3/10 (stopped)',
  'ok',
  '(just a note)',
  '!',
  'x'.repeat(300),
  `${'word '.repeat(60)}done`,
];

/** The last code in a string is a reset (nothing stays open past the message). */
function endsClosed(s: string): boolean {
  const codes = [...s.matchAll(/§(.)/g)].map((m) => m[1]);
  return codes.length === 0 || codes.at(-1) === 'r';
}

describe('colorize', () => {
  it('only adds codes: strip(colorize(x)) === x, and nothing is left open', () => {
    for (const x of CORPUS) {
      const c = colorize(x);
      expect(strip(c)).toBe(x);
      expect(endsClosed(c)).toBe(true);
    }
  });

  it('commands aqua, numbers gold, one verdict word, a trailing note gray with its command still aqua', () => {
    const c = colorize('goto: no path to 100 64 -50 (blacklisted, try !come)');
    expect(c).toContain(`${S}cno path${S}r`);
    expect(c).toContain(`${S}6100${S}r`);
    expect(c).toContain(`${S}6-50${S}r`);
    expect(c).toContain(` ${S}7(blacklisted, try ${S}b!come${S}r${S}7)${S}r`);
    expect(colorize('build fill 5x3x5: done, 75 / 75 placed')).toContain(`${S}adone${S}r`);
  });

  it('leaves versions, ids and sizes alone', () => {
    const c = colorize('version 1.26.60 build 5x3x5 oak_log2');
    expect(c).toBe('version 1.26.60 build 5x3x5 oak_log2');
  });

  it('looks for a verdict only near the start', () => {
    expect(colorize(`${'x'.repeat(70)} done`)).toBe(`${'x'.repeat(70)} done`);
  });

  it('returns styled text and the empty text unchanged', () => {
    expect(colorize(`${S}aalready${S}r`)).toBe(`${S}aalready${S}r`);
    expect(colorize('')).toBe('');
  });

  it('paint is a no-op without colour and resets after', () => {
    expect(paint('ok', 'x', false)).toBe('x');
    expect(paint('ok', 'x', true)).toBe(`${S}ax${S}r`);
    expect(paint('ok', '', true)).toBe('');
  });

  it('strip removes a dangling trailing sign too; fitWire falls back to the plain text', () => {
    expect(strip(`a${S}`)).toBe('a');
    const long = colorize('1 '.repeat(120).trim());
    expect(long.length).toBeGreaterThan(MAX_WIRE);
    const fit = fitWire(long, strip(long));
    expect(fit.length).toBeLessThanOrEqual(MAX_WIRE);
    expect(isStyled(fit)).toBe(false);
  });
});

describe('Doc', () => {
  it('lays out title, sections, pairs and a note; the plain form is the text without codes', () => {
    const build = (mode: { color: boolean; lines: boolean }) =>
      new Doc(mode).title('settings', '3').section('safety').pairs([{ key: 'fleeHealth', value: '12' }, { key: 'sprint', value: 'on' }]).note('!set <key> explains one').messages();
    expect(build({ color: false, lines: true })).toEqual(['settings 3\nsafety\nfleeHealth 12  sprint on\n!set <key> explains one']);
    const colored = build({ color: true, lines: true });
    expect(colored.map(strip)).toEqual(['settings 3\nsafety\nfleeHealth 12  sprint on\n!set <key> explains one']);
    expect(colored[0]).toContain(`${S}6${S}lsettings${S}r`); // title: gold bold
    expect(colored[0]).toContain(`sprint ${S}aon${S}r`); // on: green
    expect(colored[0]).toContain(`fleeHealth ${S}612${S}r`); // number: gold
  });

  it('packs into messages that fit, and no message starts without a heading', () => {
    const d = new Doc({ color: true, lines: true });
    d.title('big', 'test');
    for (let g = 0; g < 6; g++) {
      d.section(`g${g}`);
      d.pairs(Array.from({ length: 40 }, (_, i) => ({ key: `key${i}`, value: String(i) })));
    }
    d.note('!help <command> explains one');
    const msgs = d.messages();
    expect(msgs.length).toBeGreaterThan(3);
    for (const m of msgs) expect(m.length).toBeLessThanOrEqual(DOC_MESSAGE);
    for (const m of msgs.slice(1)) expect(strip(m.split('\n')[0]!)).toMatch(/^g\d( \(cont\.\))?$/);
    expect(strip(msgs.at(-1)!).endsWith('explains one')).toBe(true);
  });

  it('never splits a line and cuts one that is too long', () => {
    const msgs = new Doc({ color: false, lines: true }, { max: 60 }).line('y'.repeat(200)).messages();
    expect(msgs).toEqual([`${'y'.repeat(57)}...`]);
  });

  it('strips codes from what it is given: a player-chosen name cannot colour or break the block', () => {
    const msgs = new Doc({ color: true, lines: true }).section(`${S}cevil`).pairs([{ key: `k${S}a`, value: `${S}lv` }]).messages();
    const text = msgs.join('\n');
    expect(strip(text)).toBe('evil\nk v');
    expect(text.includes(`${S}cevil`)).toBe(false);
  });

  it('an empty Doc still yields one message', () => {
    expect(new Doc({ color: true, lines: true }).messages()).toEqual(['']);
  });
});

describe('Chat.say, layout and the rich help', () => {
  let client: FakeClient;
  let chat: Chat;
  let mode = { color: false, lines: false };
  let via = 'chat';

  beforeEach(async () => {
    vi.useFakeTimers();
    const { conn, clients } = setup({ username: 'Bot' });
    client = await connectAndSpawn(conn, clients);
    chat = new Chat(conn, { log: silentLogger, maxReplies: 1000 });
    chat.styleSource = { color: () => mode.color, lines: () => mode.lines, via: () => via };
    mode = { color: false, lines: false };
    via = 'chat';
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** What went on the wire (the connection flushes its queue on a timer, as in chat.test.ts). */
  const sent = async (): Promise<string[]> => {
    await vi.advanceTimersByTimeAsync(100);
    return client.sentOf('text').map((p) => String(p.message));
  };

  it('with both switches off a reply goes out exactly as written (the tests and the old behaviour)', async () => {
    chat.say('goto: no path to 100 64 -50 (try !come)');
    chat.say('x'.repeat(300));
    expect(await sent()).toEqual(['goto: no path to 100 64 -50 (try !come)', `${'x'.repeat(253)}...`]);
  });

  it('with chatColor on a reply is coloured, and strip gives back the text', async () => {
    mode = { color: true, lines: false };
    chat.say('goto: no path to 100 64 -50 (try !come)');
    const [m] = await sent();
    expect(m).toContain(`${S}cno path${S}r`);
    expect(strip(m!)).toBe('goto: no path to 100 64 -50 (try !come)');
  });

  it('a reply whose codes would pass the wire limit goes out plain, never over it', async () => {
    mode = { color: true, lines: false };
    chat.say('1 '.repeat(120).trim());
    const [m] = await sent();
    expect(m!.length).toBeLessThanOrEqual(MAX_WIRE);
    expect(isStyled(m!)).toBe(false);
  });

  it('a message that is already styled is not coloured twice, with the switches on or off', async () => {
    chat.say(`${S}aok${S}r`);
    mode = { color: true, lines: true };
    chat.say(`${S}bcmd${S}r 12`);
    expect(await sent()).toEqual([`${S}aok${S}r`, `${S}bcmd${S}r 12`]);
  });

  it('a multi-line block is cut at 256 with chatLines off and goes through (to 440) with it on', async () => {
    const block = 'line\n'.repeat(80).trim(); // 399 characters
    chat.say(block);
    mode = { color: false, lines: true };
    chat.say(block);
    const [off, on] = await sent();
    expect(off).toHaveLength(256);
    expect(on).toBe(block);
  });

  it('paint is colour with chatColor on and the text itself with it off', async () => {
    expect(chat.paint('bad', 'refused')).toBe('refused');
    mode = { color: true, lines: false };
    expect(chat.paint('bad', 'refused')).toBe(`${S}crefused${S}r`);
    chat.say(`${chat.paint('bad', 'refused')}: no chest within 12`);
    const [m] = await sent();
    expect(m).toBe(`${S}crefused${S}r: no chest within 12`); // a painted reply is sent as written: no second pass
    expect(strip(m!)).toBe('refused: no chest within 12');
  });

  it('layout gives the plain lines with chatLines off and the Doc with it on', () => {
    const build = (d: Doc) => {
      d.title('stock').pairs([{ key: 'coal', value: '12' }]);
    };
    expect(chat.layout(['stock: coal 12'], build)).toEqual(['stock: coal 12']);
    expect(chat.layout(() => ['lazy'], build)).toEqual(['lazy']);
    mode = { color: false, lines: true };
    expect(chat.layout(['stock: coal 12'], build)).toEqual(['stock\ncoal 12']);
  });

  it('the rich help lists what is registered, by group, in messages that fit', () => {
    const defs: Pick<CommandDef, 'name' | 'help' | 'tier' | 'group'>[] = [
      { name: 'come', help: '(come to you)', tier: 'front', group: 'go' },
      { name: 'get', help: '<item> [n] (get new items)', tier: 'front', group: 'work' },
      { name: 'colors', help: '(demo)', tier: 'more', group: 'info' },
    ];
    for (const d of defs) chat.register({ ...d, run: () => {} });
    chat.helpSettings = { get: (k) => SETTING_DEFS[k].default };
    mode = { color: true, lines: true };

    const front = chat.helpReplies([]).map(strip).join('\n');
    expect(front).toMatch(/^commands what you can ask me\n/);
    expect(front).toContain('go\n!come  come to you');
    expect(front).toContain('work\n!get  get new items'); // the command, then its phrase
    expect(front).not.toContain('!colors'); // a `more` command stays out of the front door

    const all = chat.helpReplies(['all']).map(strip).join('\n');
    expect(all).toContain('!colors');

    const one = chat.helpReplies(['get']).map(strip).join('\n');
    expect(one).toContain('!get');
    expect(one).toContain('work · front door');

    const settings = chat.helpReplies(['settings']);
    expect(settings.length).toBeLessThanOrEqual(6);
    for (const m of settings) expect(m.length).toBeLessThanOrEqual(MAX_WIRE);
    const text = settings.map(strip).join('\n');
    for (const k of SETTING_KEYS) expect(text, `setting ${k} missing from the rich settings list`).toContain(`${k} `);
  });

  it('!colors prints in colour whatever the switches say, in messages that fit, and names the switches', () => {
    const msgs = colorsDemo({ color: false, lines: false });
    for (const m of msgs) expect(m.length).toBeLessThanOrEqual(MAX_WIRE);
    expect(msgs.every(isStyled)).toBe(true);
    const text = msgs.map(strip).join('\n');
    expect(text).toContain('chat colours');
    expect(text).toContain('chatColor off, chatLines off');
    expect(text).toContain('!set chatColor on');
    expect(text).toContain('replies go out as player chat'); // and which route they take
  });

  describe('the /tellraw route (chatVia)', () => {
    const OUTPUT_REFUSED = (uuid: string) => ({ origin: { uuid }, output_type: 'error', success_count: 0, output: [{ success: false, message_id: 'commands.generic.permission.selector', parameters: [] }] });
    const commands = (): string[] => client.sentOf('command_request').map((p) => String(p.command));
    const uuidOf = (i: number): string => (client.sentOf('command_request')[i]?.origin as { uuid: string }).uuid;
    const flushed = () => vi.advanceTimersByTimeAsync(100);

    beforeEach(() => {
      chat.start();
      via = 'tellraw';
    });

    it('sends /tellraw @a with the text as JSON, not a chat packet; special characters survive the JSON', async () => {
      const nasty = `${S}aquote " back \\ brace { } at @a bang ! line1\nline2 ${S}r`;
      chat.say(nasty);
      await flushed();
      expect(client.sentOf('text')).toHaveLength(0);
      const [cmd] = commands();
      expect(cmd).toMatch(/^\/tellraw @a \{"rawtext":\[\{"text":".*"\}\]\}$/);
      expect(cmd!.length).toBeLessThanOrEqual(480);
      expect(cmd).not.toContain('\n'); // the newline travels as \n inside the JSON
      const json = JSON.parse(cmd!.slice('/tellraw @a '.length)) as { rawtext: { text: string }[] };
      expect(json.rawtext[0]!.text).toBe(nasty);
    });

    it('is the only command the bot ever sends this way, whatever the reply says', async () => {
      for (const say of ['/op Bot', '/stop', '!help', 'said /kill @a']) chat.say(say);
      mode = { color: true, lines: true };
      for (const m of chat.helpReplies(['settings'])) chat.say(m);
      await flushed();
      expect(commands().length).toBeGreaterThan(4);
      for (const c of commands()) expect(c).toMatch(/^\/tellraw @a \{"rawtext":\[\{"text":"/);
    });

    it('a command that would pass the safe length goes out as chat instead (512 characters drops the connection)', async () => {
      chat.say('y'.repeat(256)); // fits: 256 + 37
      chat.say('"'.repeat(300)); // finish() cuts at 256 characters; each quote doubles in the JSON, so the command passes 480
      await flushed();
      expect(commands()).toHaveLength(1);
      expect(client.sentOf('text')).toHaveLength(1);
      for (const c of commands()) expect(c.length).toBeLessThanOrEqual(480);
    });

    it('a refused /tellraw is resent as chat once, the route pauses, and later replies go out as chat', async () => {
      chat.say('first');
      await flushed();
      expect(commands()).toHaveLength(1);
      client.receive('command_output', OUTPUT_REFUSED(uuidOf(0)));
      chat.say('second');
      await flushed();
      expect(client.sentOf('text').map((p) => p.message)).toEqual(['first', 'second']);
      expect(commands()).toHaveLength(1);
      const st = chat.routeStatus();
      expect(st.setting).toBe('tellraw');
      expect(st.via).toBe('chat');
      expect(st.route.state).toBe('refused');
      expect(st.route.reason).toBe('commands.generic.permission.selector');
      expect(colorsDemo(chat.styleMode(), '!', st).map(strip).join('\n')).toContain('commands.generic.permission.selector');
    });

    it('a burst that was all refused is resent in order', async () => {
      for (const m of ['one', 'two', 'three']) chat.say(m);
      await flushed();
      for (let i = 0; i < 3; i++) client.receive('command_output', OUTPUT_REFUSED(uuidOf(i)));
      await flushed();
      expect(client.sentOf('text').map((p) => p.message)).toEqual(['one', 'two', 'three']);
    });

    it('tries /tellraw again by itself after a minute (the owner may have made the bot an operator meanwhile)', async () => {
      chat.say('first');
      await flushed();
      client.receive('command_output', OUTPUT_REFUSED(uuidOf(0)));
      await vi.advanceTimersByTimeAsync(30_000);
      chat.say('too soon');
      await flushed();
      expect(commands()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(31_000);
      chat.say('later');
      await flushed();
      expect(commands()).toHaveLength(2);
      expect(chat.routeStatus().route.state).toBe('on');
    });

    it('tells the owner once, after the replies, when the test is refused; the automatic retries refuse quietly', async () => {
      chat.say('one');
      chat.say('two');
      await flushed();
      client.receive('command_output', OUTPUT_REFUSED(uuidOf(0)));
      client.receive('command_output', OUTPUT_REFUSED(uuidOf(1)));
      await vi.advanceTimersByTimeAsync(600);
      const texts = client.sentOf('text').map((p) => String(p.message));
      expect(texts.slice(0, 2)).toEqual(['one', 'two']); // the refused replies first
      expect(texts).toHaveLength(3);
      expect(texts[2]).toContain('refused by the server (commands.generic.permission.selector)');
      expect(texts[2]).toContain('!colors tries again');
      await vi.advanceTimersByTimeAsync(61_000); // the automatic retry is refused too: no second warning
      chat.say('three');
      await flushed();
      client.receive('command_output', OUTPUT_REFUSED(uuidOf(2)));
      await vi.advanceTimersByTimeAsync(600);
      expect(client.sentOf('text').map((p) => String(p.message)).slice(3)).toEqual(['three']);
    });

    it('does not warn when the test goes through (success is silent)', async () => {
      chat.say('one');
      await vi.advanceTimersByTimeAsync(2000);
      expect(client.sentOf('text')).toHaveLength(0);
    });

    it('retryRoute (what !colors does) and switching chatVia to tellraw try at once, not after the pause', async () => {
      chat.say('first');
      await flushed();
      client.receive('command_output', OUTPUT_REFUSED(uuidOf(0)));
      chat.say('paused');
      await flushed();
      expect(commands()).toHaveLength(1);
      chat.retryRoute();
      chat.say('retry');
      await flushed();
      expect(commands()).toHaveLength(2);
      client.receive('command_output', OUTPUT_REFUSED(uuidOf(1)));
      chat.say('paused again');
      via = 'chat';
      chat.say('as chat');
      via = 'tellraw'; // the switch back is the test
      chat.say('switched');
      await flushed();
      expect(commands()).toHaveLength(3);
      expect(String(client.sentOf('command_request')[2]?.command)).toContain('switched');
    });

    it('!colors is the retest: the demo goes out as the test message', async () => {
      registerStyleCommands(chat);
      chat.say('first');
      await flushed();
      client.receive('command_output', OUTPUT_REFUSED(uuidOf(0)));
      const before = commands().length;
      client.receive('text', { needs_translation: false, category: 'authored', type: 'announcement', source_name: 'Server', message: '[Server] !colors', xuid: '' });
      await flushed();
      expect(commands().length).toBeGreaterThan(before); // not paused: tried again at once
    });

    it('ignores the output of other commands (whispers, anything it did not send) and successes', async () => {
      chat.say('first');
      await flushed();
      client.receive('command_output', OUTPUT_REFUSED('someone-elses-uuid'));
      client.receive('command_output', { origin: { uuid: uuidOf(0) }, output_type: 'success', success_count: 1, output: [] });
      client.receive('command_output', {});
      await flushed();
      expect(client.sentOf('text')).toHaveLength(0);
      expect(chat.routeStatus().route.state).toBe('on');
    });

    it('while it is on, blocks are smaller so their command fits; when it is off or paused they are the usual size', () => {
      mode = { color: true, lines: true };
      expect(chat.styleMode().block).toBe(420);
      for (const m of chat.helpReplies(['settings'])) expect(tellrawCommand(m).length).toBeLessThanOrEqual(480);
      via = 'chat';
      expect(chat.styleMode().block).toBeUndefined();
    });

    it('chatVia chat (the default) never sends a command', async () => {
      via = 'chat';
      chat.say('hello');
      await flushed();
      expect(commands()).toHaveLength(0);
      expect(client.sentOf('text')).toHaveLength(1);
    });
  });
});

describe('route.ts', () => {
  it('tellrawCommand builds /tellraw @a {"rawtext":[{"text":...}]} and keeps section signs as they are', () => {
    expect(tellrawCommand(`${S}aok${S}r`)).toBe(`/tellraw @a {"rawtext":[{"text":"${S}aok${S}r"}]}`);
    expect(tellrawCommand('a"b\\c\nd')).toBe('/tellraw @a {"rawtext":[{"text":"a\\"b\\\\c\\nd"}]}');
  });

  it('fitsTellraw is the length check that keeps the server from dropping the connection', () => {
    const wrap = tellrawCommand('').length;
    expect(fitsTellraw('x'.repeat(SLASH_MAX - wrap))).toBe(true);
    expect(fitsTellraw('x'.repeat(SLASH_MAX - wrap + 1))).toBe(false);
    expect(SLASH_MAX).toBeLessThan(512);
  });

  it('commandRequestPacket has the 1.26.x shape: version "latest", player_entity_id present, one slash', () => {
    const p = commandRequestPacket('tell Steve hi', 'u-1');
    expect(p.command).toBe('/tell Steve hi');
    expect(commandRequestPacket('/tell Steve hi').command).toBe('/tell Steve hi');
    expect(p.version).toBe('latest');
    expect(p.origin).toEqual({ type: 'player', uuid: 'u-1', request_id: '', player_entity_id: 0n });
  });

  it('TellrawRoute: a failure for a tracked uuid returns its text and pauses; everything else is ignored', () => {
    let t = 1000;
    const r = new TellrawRoute(() => t, 5000);
    r.track('a', 'text a');
    r.track('b', 'text b');
    expect(r.onOutput('zzz', 0, 'x')).toBeUndefined();
    expect(r.onOutput(undefined, 0)).toBeUndefined();
    expect(r.onOutput('a', 1)).toBeUndefined(); // success
    expect(r.usable()).toBe(true);
    expect(r.onOutput('a', 0, 'm')).toBeUndefined(); // already answered
    expect(r.onOutput('b', 0, 'commands.generic.syntax')).toBe('text b');
    expect(r.usable()).toBe(false);
    expect(r.status()).toEqual({ state: 'refused', reason: 'commands.generic.syntax', retryInMs: 5000 });
    t += 5000;
    expect(r.usable()).toBe(true);
    expect(r.status()).toEqual({ state: 'on' });
  });

  it('TellrawRoute forgets what it never heard back about (success is silent), so it cannot grow', () => {
    let t = 0;
    const r = new TellrawRoute(() => t);
    for (let i = 0; i < 200; i++) {
      r.track(`u${i}`, 't');
      t += 100;
    }
    expect(r.onOutput('u0', 0)).toBeUndefined(); // long forgotten
    expect(r.onOutput('u199', 0)).toBe('t');
  });
});

describe('guards for future work', () => {
  it('every setting is in a group, none twice, none stale (add a new setting to SETTING_GROUPS in chat/help.ts)', () => {
    const grouped = SETTING_GROUPS.flatMap(([, keys]) => keys);
    expect(grouped.filter((k, i) => grouped.indexOf(k) !== i), 'a setting is in two groups').toEqual([]);
    expect(SETTING_KEYS.filter((k) => !grouped.includes(k)), 'settings in no group: add them to SETTING_GROUPS in chat/help.ts').toEqual([]);
    expect(grouped.filter((k) => !(SETTING_KEYS as string[]).includes(k)), 'SETTING_GROUPS names a setting that does not exist').toEqual([]);
    expect(settingGroups().map(([g]) => g)).not.toContain('other');
  });

  it('only chat/style.ts builds section-sign codes; the other files that mention one only strip them from names', () => {
    // Files that touch a section sign today, and why. A new file here is a smell: use style.ts (docs/chat-style.md).
    const ALLOWED: Record<string, string> = {
      'chat/style.ts': 'the style module',
      'chat/text.ts': 'stripFormatting of relayed names',
      'chat/welcome.ts': 'strips a name',
      'chat/commands-bring.ts': 'strips a name',
      'chat/commands-pve.ts': 'strips a name',
      'chat/commands-survival.ts': 'strips a name',
      'skills/follow/follow.ts': 'strips a name',
      'skills/home/boxing.ts': 'strips a box name',
      'world/inventory.ts': 'a comment about item names',
      'tasks/pve.ts': 'strips a player name',
      'tasks/process/locator.ts': 'strips a player name',
    };
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../../../src');
    const offenders: string[] = [];
    for (const rel of readdirSync(srcDir, { recursive: true, encoding: 'utf8' })) {
      if (!rel.endsWith('.ts')) continue;
      const file = rel.split(sep).join('/');
      const src = readFileSync(join(srcDir, rel), 'utf8');
      if ((src.includes('§') || /\\u00a7|\\xa7/i.test(src)) && !(file in ALLOWED)) offenders.push(file);
    }
    expect(offenders, 'these files build colour codes by hand: use the style module instead (docs/chat-style.md)').toEqual([]);
  });
});
