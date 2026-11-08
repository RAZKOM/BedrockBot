// Wave 9 Track AM (docs/ux.md): command tiers and the help formats on the real afk registry, !mode,
// the welcome whisper, the three hint rules, natural-language answers, the panel's Help data, and
// "!get never takes from chests".
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Chat } from '../../../src/chat/chat.ts';
import { FRONT_DOOR, frontHelp, hintFor, splitHelp, type HintFacts } from '../../../src/chat/help.ts';
import { MAX_WIRE, strip, wireSize } from '../../../src/chat/style.ts';
import { applyMode, currentMode, MODE_KEYS, modeCommand, modeLine, modeValues } from '../../../src/chat/modes.ts';
import { attachWelcome, welcomeLines, welcomeVersion } from '../../../src/chat/welcome.ts';
import type { Connection } from '../../../src/connection/connection.ts';
import { RuntimeSettings, SETTING_DEFS } from '../../../src/config/settings.ts';
import { panelRoutes } from '../../../src/health/panel/routes.ts';
import { buildPanelHelp, type PanelHelp } from '../../../src/health/panel/state.ts';
import { silentLogger } from '../../../src/log.ts';
import { checkPlan } from '../../../src/nl/executor.ts';
import { parsePlan } from '../../../src/nl/plan.ts';
import { buildSystemPrompt, EXAMPLES } from '../../../src/nl/prompt.ts';
import { lookup, unknownReply } from '../../../src/skills/items/catalog.ts';
import { GET_PROCESSES } from '../../../src/chat/commands-get.ts';
import { afkChat } from './afk-chat.ts'; // shared with the map screen's guard test (decision 0062)
import { context as nlContext, makeFrontEnd, standardCommands } from '../nl/helpers.ts';

/** A Chat on a fake spawned connection; `sent` collects the chat packets' text. */
function bareChat(maxReplyLength = 256) {
  const sent: string[] = [];
  const conn = { state: 'spawned', username: 'Bot', queue: (_n: string, p: { message?: string }) => sent.push(p.message ?? ''), on: () => () => undefined } as unknown as Connection;
  return { chat: new Chat(conn, { log: silentLogger, maxReplyLength, maxReplies: 100 }), sent };
}

describe('tiers and !help on the afk registry', () => {
  const { chat } = afkChat();
  const infos = chat.commandInfo();
  const byName = new Map(infos.map((c) => [c.name, c]));

  it('the front door is exactly FRONT_DOOR; every command has a group and an example', () => {
    expect(infos.filter((c) => c.tier === 'front').map((c) => c.name).sort()).toEqual([...FRONT_DOOR].sort());
    const missing = infos.filter((c) => !c.example).map((c) => c.name);
    expect(missing).toEqual([]);
    for (const n of ['gather', 'mine', 'food', 'cook', 'farm', 'breed', 'kill', 'eat', 'equip', 'sleep', 'drop', 'inv', 'wp', 'shelter', 'pause', 'resume', 'set', 'pos', 'quit', 'health', 'top', 'goto', 'mode', 'commands']) {
      expect(byName.get(n)?.tier, n).toBe('more');
    }
  });

  it('the auto lines are on the commands the bot really runs by itself', () => {
    for (const n of ['cook', 'eat', 'equip', 'sleep', 'food', 'get', 'drop', 'home', 'shelter', 'breed', 'wp']) expect(byName.get(n)?.auto, n).toBeTruthy();
    // the deletion candidates of docs/ux.md: `more` without an automatic trigger
    const candidates = infos.filter((c) => c.tier === 'more' && !c.auto).map((c) => c.name).sort();
    expect(candidates).toEqual(['colors', 'commands', 'farm', 'gather', 'goto', 'health', 'inv', 'kill', 'land', 'mine', 'mode', 'nether', 'no', 'overworld', 'pause', 'pos', 'quarry', 'quit', 'resume', 'set', 'stock', 'top', 'tunnel', 'yes']); // merge: + stock (Track AG; unload and chests have auto lines); Track AT: + nether, overworld (portal has an auto line); Track AU: + land (fly has the auto line); chat style: + colors (a demo, nothing runs by itself)
  });

  it('!help: at most 4 messages of 256, the front door only, ending with !help all and !help <command>', () => {
    const lines = chat.helpReplies([]);
    console.log(lines.join('\n'));
    expect(lines.length).toBeLessThanOrEqual(4);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(256);
    const text = lines.join(' ');
    for (const n of FRONT_DOOR) expect(text, n).toContain(`!${n} `);
    for (const n of ['cook', 'mine', 'gather', 'kill', 'pause']) expect(text).not.toContain(`!${n} `);
    expect(lines.at(-1)).toMatch(/!help all, !help <command>$/);
    expect(lines.at(-1)).toContain('!mode careful|normal|bold');
  });

  it('!help shortens itself when the front door grows (after the merge)', () => {
    const more = [...infos, ...['build', 'explore', 'unload'].map((n) => ({ name: n, tier: 'front' as const, group: 'work' as const, help: `x (a long description of ${n} that takes up a good part of a chat line by itself)`, syntax: 'x', phrase: `a long description of ${n} that takes up a good part of a chat line by itself` }))];
    const lines = frontHelp(more);
    expect(lines.length).toBeLessThanOrEqual(4);
    for (const n of ['build', 'explore', 'unload', ...FRONT_DOOR]) expect(lines.join(' ')).toContain(`!${n}`);
  });

  it('!help all and !commands: every command by group, names only, at most 4 messages', () => {
    const lines = chat.helpReplies(['all']);
    console.log(lines.join('\n'));
    expect(lines.length).toBeLessThanOrEqual(4);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(256);
    const words = new Set(lines.join(' ').split(/[\s:;,()]+/));
    for (const c of infos) expect(words.has(c.name), c.name).toBe(true);
    expect(chat.helpReplies(['commands'])).toEqual(lines);
    const said: string[] = [];
    chat.commandInfo();
    const def = (chat as unknown as { commands: Map<string, { run(c: unknown): void }> }).commands.get('commands')!;
    def.run({ args: [], reply: (m: string) => said.push(m) });
    expect(said).toEqual(lines);
  });

  it('!help <command>: syntax and description, the example, the auto line', () => {
    const cook = chat.helpReplies(['cook']);
    console.log(cook.join('\n'));
    expect(cook[0]).toBe('!cook: cook the raw food carried in the furnace or smoker within 16 blocks of home [work, more]');
    expect(cook[1]).toBe('example: !cook');
    expect(cook[2]).toMatch(/^also on its own: after every hunt/);
    const get = chat.helpReplies(['!get']);
    expect(get[0]).toMatch(/^!get <item> \[n\] \[<item> n \.\.\.\] \| ores n \| stop \| status: makes wood.*never from chests \[work, front door\]$/); // Track AQ: several kinds per trip
    expect(get[1]).toBe('example: !get wood 16');
    expect(chat.helpReplies(['dance'])).toEqual(['no command !dance; !help all lists every command']);
  });

  it('!help settings: the mode first, then the settings by group with values', () => {
    const { chat: c2 } = afkChat();
    const lines = c2.helpReplies(['settings']);
    console.log(lines.join('\n'));
    expect(lines[0]).toMatch(/^settings: mode normal \(!mode careful\|normal\|bold\); safety: fleeHealth 8, guardRadius 16/);
    expect(lines.join(' ')).toContain('lastWelcomed none');
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(256);
  });

  it('splitHelp takes the last top-level parenthesis', () => {
    expect(splitHelp('<a> [b] (does (this))')).toEqual({ syntax: '<a> [b]', phrase: 'does (this)' });
    expect(splitHelp('(only words)')).toEqual({ syntax: '', phrase: 'only words' });
    expect(splitHelp('x y z')).toEqual({ syntax: 'x y z', phrase: '' });
  });

  it('the natural-language reference carries the auto lines in the same `!name help` form', () => {
    const t = chat.helpText();
    expect(t).toContain('!wp [list] | set <name> [x y z] | del <name> | <name> (waypoints) (also on its own: ');
    expect(t).toContain('!cook (cook the raw food carried in the furnace or smoker within 16 blocks of home) (also on its own: after every hunt');
  });
});

describe('!mode', () => {
  it('careful, status, a single !set makes it custom, normal resets, bold', () => {
    const s = new RuntimeSettings();
    expect(modeLine(s)).toBe('normal');
    expect(modeCommand(s, ['careful'])).toBe('mode careful: fleeHealth 12, guardRadius 8, avoidMobRadius 8, avoidSpawnerRadius 16, allowBreak off, allowPlace off (was normal), not saved (no settings file)');
    expect(s.get('fleeHealth')).toBe(12);
    expect(modeCommand(s, ['status'])).toBe('mode careful (!mode careful|normal|bold; !help settings lists every setting)');
    s.set('fleeHealth', '9');
    expect(currentMode(s)).toEqual({ mode: 'custom', nearest: 'careful', differ: ['fleeHealth'] });
    expect(modeLine(s)).toBe('custom (careful but fleeHealth 9 instead of 12)');
    applyMode(s, 'normal');
    for (const k of MODE_KEYS) {
      expect(s.get(k)).toBe(SETTING_DEFS[k].default);
      expect(s.source(k)).toBe('default');
    }
    applyMode(s, 'bold');
    expect(modeValues('bold')).toEqual({ fleeHealth: 6, guardRadius: 24, avoidMobRadius: 3, avoidSpawnerRadius: 8, allowBreak: true, allowPlace: true });
    expect(MODE_KEYS.map((k) => s.get(k))).toEqual([6, 24, 3, 8, true, true]);
    expect(modeCommand(s, ['loud'])).toBe('usage: !mode careful | normal | bold | status');
  });

  it('is registered on the afk task and listed by !help settings', () => {
    const { chat, settings } = afkChat();
    expect(chat.has('mode')).toBe(true);
    const said: string[] = [];
    (chat as unknown as { commands: Map<string, { run(c: unknown): void }> }).commands.get('mode')!.run({ args: ['careful'], reply: (m: string) => said.push(m) });
    expect(said[0]).toMatch(/^mode careful: fleeHealth 12/);
    expect(settings.get('guardRadius')).toBe(8);
    expect(chat.helpReplies(['settings'])[0]).toMatch(/^settings: mode careful/);
  });
});

describe('welcome whisper', () => {
  function fakes(state = 'spawned') {
    const queued: { name: string; params: Record<string, unknown> }[] = [];
    const listeners = new Map<string, ((p: Record<string, unknown>) => void)[]>();
    const conn = {
      state,
      username: 'Bot',
      queue: (name: string, params: Record<string, unknown>) => queued.push({ name, params }),
      on: (name: string, fn: (p: Record<string, unknown>) => void) => {
        listeners.set(name, [...(listeners.get(name) ?? []), fn]);
        return () => listeners.set(name, (listeners.get(name) ?? []).filter((f) => f !== fn));
      },
    };
    const lineFns: ((l: unknown) => void)[] = [];
    const chat = { owners: { names: ['Steve'], xuids: [], allowConsole: true }, prefix: '!', onLine: (fn: (l: unknown) => void) => (lineFns.push(fn), () => undefined) };
    const say = (source: string, body: string) => lineFns.forEach((f) => f({ type: 'chat', source, message: body, body, xuid: '', truth: false }));
    const list = (username: string) => (listeners.get('player_list') ?? []).forEach((f) => f({ records: { type: 'add', records: [{ type: 'add', username, uuid: 'u' }] } }));
    const tells = () => queued.filter((q) => q.name === 'command_request').map((q) => String(q.params.command));
    return { conn, chat, say, list, tells, queued };
  }

  it('4 lines at most: version, two new things, what to try', () => {
    const l = welcomeLines('0.0.0+w9');
    expect(l).toHaveLength(4);
    expect(l[0]).toBe('BedrockBot 0.0.0+w9 is here');
    expect(l[3]).toBe('try !get wood, !come, !do <sentence>; !help for more');
    expect(welcomeVersion()).toMatch(/^\d+\.\d+\.\d+\+w9$/);
  });

  it('once per version: the owner chats, not again after a reconnect (same settings)', () => {
    const settings = new RuntimeSettings();
    const f = fakes();
    const off = attachWelcome({ chat: f.chat as never, conn: f.conn as never, settings, version: '1.2.3+w9' });
    f.say('Alex', 'hello'); // not an owner
    expect(f.tells()).toEqual([]);
    f.say('Steve', 'hi bot');
    expect(f.tells()).toHaveLength(4);
    expect(f.tells()[0]).toBe('/tell "Steve" BedrockBot 1.2.3+w9 is here');
    expect(settings.get('lastWelcomed')).toBe('1.2.3+w9');
    f.say('Steve', 'again');
    f.list('Steve');
    expect(f.tells()).toHaveLength(4);
    off();
    const g = fakes();
    attachWelcome({ chat: g.chat as never, conn: g.conn as never, settings, version: '1.2.3+w9' });
    g.list('Steve');
    g.say('Steve', 'back');
    expect(g.tells()).toEqual([]);
    // a new version welcomes again
    const h = fakes();
    attachWelcome({ chat: h.chat as never, conn: h.conn as never, settings, version: '1.2.4+w9' });
    h.list('Steve');
    expect(h.tells()).toHaveLength(4);
  });

  it('a player_list add before the spawn waits for the spawn', () => {
    vi.useFakeTimers();
    try {
      const settings = new RuntimeSettings();
      const f = fakes('connecting');
      attachWelcome({ chat: f.chat as never, conn: f.conn as never, settings, version: 'v1', retryMs: 100 });
      f.list('steve');
      expect(f.tells()).toEqual([]);
      f.conn.state = 'spawned';
      vi.advanceTimersByTime(150);
      expect(f.tells()).toHaveLength(4);
      expect(f.tells()[0]).toBe('/tell "steve" BedrockBot v1 is here');
      expect(settings.get('lastWelcomed')).toBe('v1');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('next-step hints (three rules)', () => {
  const facts = (o: Partial<HintFacts> = {}): HintFacts => ({ freeSlots: 20, rawFood: 0, furnaceNearHome: true, hasUnload: false, ...o });

  it('rule 1: a mine / gather / food job ending with fewer than 4 free slots', () => {
    for (const r of ['mine coal_ore: 8/8 done', 'mine iron_ore: stopped at 3/8, no pickaxe', 'gather done: 24/20 logs', 'food: 6/6 items from 2 cow']) {
      expect(hintFor(r, facts({ freeSlots: 3 })), r).toBe('(inventory nearly full)');
      expect(hintFor(r, facts({ freeSlots: 3, hasUnload: true })), r).toBe('(!unload at home)');
      expect(hintFor(r, facts({ freeSlots: 4 })), r).toBeUndefined();
    }
    for (const r of ['mining 8 coal_ore', 'food: 0 points carried (foodMin 10)', 'getting 16 oak_log: gathering wood', 'status: up 1s']) expect(hintFor(r, facts({ freeSlots: 0 })), r).toBeUndefined();
  });

  it('rule 2: a food run ending with raw food and no furnace near home', () => {
    expect(hintFor('food: 6/6 items from 2 cow', facts({ rawFood: 6, furnaceNearHome: false }))).toBe('(no furnace within 16 of home: raw)');
    expect(hintFor('food: 6/6 items from 2 cow', facts({ rawFood: 6, furnaceNearHome: true }))).toBeUndefined();
    expect(hintFor('food: 6/6 items from 2 cow; cook: no furnace or smoker within 16 blocks of home', facts({ rawFood: 6, furnaceNearHome: false }))).toBeUndefined();
    expect(hintFor('mine coal_ore: 8/8 done', facts({ rawFood: 6, furnaceNearHome: false }))).toBeUndefined();
  });

  it('rule 3: !get <unknown> stays its one categories message', () => {
    const r = unknownReply('bread');
    expect(hintFor(r, facts({ freeSlots: 0 }))).toBeUndefined();
    const { chat, sent } = bareChat();
    chat.hinter = (m) => hintFor(m, facts({ freeSlots: 0 }));
    chat.say(unknownReply('a_very_long_item_name_nobody_knows'));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.length).toBeLessThanOrEqual(256);
  });

  it('Chat.say appends the hint when it fits in one message', () => {
    const { chat, sent } = bareChat();
    chat.hinter = (m) => hintFor(m, facts({ freeSlots: 1, hasUnload: chat.has('unload') }));
    chat.say('mine coal_ore: 8/8 done');
    expect(sent).toEqual(['mine coal_ore: 8/8 done (inventory nearly full)']);
    chat.register({ name: 'unload', help: '(x)', run: () => undefined });
    chat.say('gather done: 24/20 logs');
    expect(sent[1]).toBe('gather done: 24/20 logs (!unload at home)');
    chat.say(`mine coal_ore: 8/8 done ${'x'.repeat(240)}`);
    expect(sent[2]).not.toContain('unload');
  });
});

describe('natural-language answers', () => {
  it('`what can you do` is one answer step: said verbatim, nothing runs', async () => {
    const answer = EXAMPLES.find((e) => e.request === 'what can you do')!.plan;
    const { chat, fe } = makeFrontEnd([['what can you do', answer]]);
    standardCommands(chat);
    const r = await fe.request('what can you do', { line: { type: 'whisper', source: 'Server', message: '', body: '', xuid: '', truth: false }, sender: 'console' });
    expect(r?.kind).toBe('question');
    expect(chat.said).toEqual([(answer.steps[0] as { text: string }).text]);
    expect(chat.handled).toEqual([]);
    expect(fe.waiting).toBeUndefined();
  });

  it('`Bot, can you cook?` (addressed chat) answers from the reference', async () => {
    const answer = EXAMPLES.find((e) => e.request === 'can you cook?')!.plan;
    const { chat, fe } = makeFrontEnd([['cook', answer]]);
    await fe.request('can you cook?', { line: { type: 'chat', source: 'Steve', message: '', body: '', xuid: '', truth: false }, sender: 'Steve' });
    expect(chat.said).toHaveLength(1);
    expect(chat.said[0]).toMatch(/^Yes: after a hunt I cook/);
    expect(chat.handled).toEqual([]);
  });

  it('the schema rejects an answer mixed with actions and answers over 200 characters', () => {
    expect(parsePlan(JSON.stringify({ steps: [{ command: 'answer', text: 'sure' }, { command: 'stop' }] })).ok).toBe(false);
    expect(parsePlan(JSON.stringify({ steps: [{ command: 'come' }, { command: 'answer', text: 'on my way' }] })).ok).toBe(false);
    expect(parsePlan(JSON.stringify({ steps: [{ command: 'answer', text: 'x'.repeat(201) }] })).ok).toBe(false);
    const ok = parsePlan(JSON.stringify({ steps: [{ command: 'answer', text: 'I can get wood.' }] }));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(checkPlan(ok.plan, { text: 'what can you do', sender: 'console', waypoints: [], commands: [] })).toEqual({ kind: 'question', text: 'I can get wood.' });
  });

  it('the prompt tells the model to answer from the reference, never invent, prefer a plan for actions', () => {
    const p = buildSystemPrompt({ ...nlContext(), help: new Map([['cook', '!cook (cook) (also on its own: after every hunt)']]), sender: 'Steve' });
    expect(p).toContain('Never invent abilities');
    expect(p).toContain('When the person asks for an action, answer a plan, not an answer step.');
    expect(p).toContain('- !cook (cook) (also on its own: after every hunt)');
    expect(p).toContain('{"command":"answer","text":"..."}');
  });
});

describe('panel Help tab data', () => {
  it('buildPanelHelp: the registry (front door first), settings with values and descriptions, the modes', () => {
    const { chat, settings } = afkChat();
    const h = buildPanelHelp({ commands: () => chat.commandInfo(), settings });
    expect(h.commands.slice(0, FRONT_DOOR.length).every((c) => c.tier === 'front')).toBe(true);
    const cook = h.commands.find((c) => c.name === 'cook')!;
    expect(cook).toMatchObject({ tier: 'more', group: 'work', example: '!cook' });
    expect(cook.auto).toMatch(/^after every hunt/);
    expect(h.settings.find((s) => s.key === 'fleeHealth')).toMatchObject({ group: 'safety', value: '8', default: '8' });
    expect(h.modes.map((m) => m.name)).toEqual(['careful', 'normal', 'bold']);
    expect(h.modes[0]!.values.fleeHealth).toBe('12');
    expect(h.mode).toBe('normal');
  });

  it('GET /api/help serves it', () => {
    const body: string[] = [];
    let status = 0;
    const res = { writeHead: (s: number) => (status = s), end: (b?: string) => body.push(b ?? ''), headersSent: false };
    const route = panelRoutes({ state: () => ({}) as never, run: () => ({ ok: true, replies: [] }), help: () => ({ commands: [], settings: [], modes: [], mode: 'normal' }) satisfies PanelHelp });
    expect(route('/api/help', { method: 'GET' } as never, res as never)).toBe(true);
    expect(status).toBe(200);
    expect(JSON.parse(body[0]!)).toEqual({ commands: [], settings: [], modes: [], mode: 'normal' });
  });
});

describe('!get never takes from chests', () => {
  it('every catalog strategy makes things: gather, mine, hunt, farm; the command is one of those processes', () => {
    const names = ['wood', 'oak_log', 'coal', 'iron', 'iron_ingot', 'diamond', 'diamonds', 'gold', 'emerald', 'stone', 'cobblestone', 'dirt', 'sand', 'gravel', 'flint', 'clay', 'beef', 'pork', 'food', 'string', 'wheat', 'carrots', 'potatoes', 'bread', 'chest', 'shulker_box', 'iron_sword'];
    for (const n of names) {
      const f = lookup(n);
      expect(['gather', 'mine', 'hunt', 'farm', 'unknown'], n).toContain(f.strategy);
      if (f.strategy !== 'unknown') expect(Object.keys(GET_PROCESSES), n).toContain((f as { command: string }).command.split(' ')[0]);
    }
  });

  it('no code path of !get or the stash step takes items out of a container', () => {
    // the chest skill has open / deposit / close only; the stash deposits; the catalog and !get never open one
    const src = (p: string) => readFileSync(new URL(`../../../src/${p}`, import.meta.url), 'utf8');
    // chest.ts has a generic `take` since Track AG (home logistics: !unload, spare boxes); the stash and !get never import or call it
    expect(src('skills/container/stash.ts')).not.toMatch(/\b(withdraw|takeOut|take)\s*\(/);
    expect(src('skills/container/stash.ts')).not.toMatch(/import \{[^}]*\btake\b[^}]*\} from '\.\/chest\.ts'/);
    expect(src('skills/items/catalog.ts')).not.toMatch(/container|chest\.|\.open\(/i);
    expect(src('chat/commands-get.ts')).not.toMatch(/\.open\(|withdraw/);
  });
});

describe('chat style on the afk registry (docs/chat-style.md)', () => {
  it('chatLines on: !help, !help all and !help settings are multi-line messages that fit, and cover everything registered', () => {
    const { chat, settings } = afkChat();
    expect(chat.has('colors')).toBe(true);
    // off (the default): the packed one-line forms, as before
    expect(chat.helpReplies([]).some((l) => l.startsWith('front door: '))).toBe(true);
    settings.set('chatLines', 'on');
    settings.set('chatColor', 'on');

    const front = chat.helpReplies([]);
    expect(front.length).toBeLessThanOrEqual(4);
    for (const m of front) expect(wireSize(m)).toBeLessThanOrEqual(MAX_WIRE);
    const frontText = front.map(strip).join('\n');
    for (const n of FRONT_DOOR) expect(frontText, n).toContain(`!${n} `);
    expect(frontText).not.toContain('!colors'); // a `more` command stays off the front door

    const all = chat.helpReplies(['all']);
    expect(all.length).toBeLessThanOrEqual(4);
    for (const m of all) expect(wireSize(m)).toBeLessThanOrEqual(MAX_WIRE);
    const allText = all.map(strip).join('\n');
    for (const n of chat.commandNames()) expect(allText, n).toContain(`!${n}`);

    const sets = chat.helpReplies(['settings']);
    expect(sets.length).toBeLessThanOrEqual(8); // Track BH: four glide / ledge settings took the list to 7 messages; Track T1: the test group (testMode, testKit) to 8
    for (const m of sets) expect(wireSize(m)).toBeLessThanOrEqual(MAX_WIRE);
    const setsText = sets.map(strip).join('\n');
    for (const k of Object.keys(SETTING_DEFS)) expect(setsText, k).toContain(`${k} `);
  });
});
