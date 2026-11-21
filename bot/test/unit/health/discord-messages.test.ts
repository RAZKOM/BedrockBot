// Track D2 (docs/discord.md "What the messages look like", ADR 0118 addendum): the Discord messages as JSON, built by
// the real builders: a queue question with its buttons (the bot) and without (the webhook), the message edited to its
// outcome (a press, a typed answer, no answer, replaced, closed), a death alert (once and folded), a kick, a lost
// connection, an alert of any other kind, a test note; the reply rules (plain, lists, pairs a few to a row, code for
// columns and coordinate lists, markdown escaped, the limits). The snapshots are the payloads Discord gets.
import { describe, expect, it } from 'vitest';
import { EventBus } from '../../../src/events/bus.ts';
import type { BotEvent } from '../../../src/events/registry.ts';
import { CAUSE_MAX, causeLine, DISCORD_LIMITS, escapeMarkdown, payloadFor, shortDuration } from '../../../src/health/notify/discord.ts';
import { answeredPayload, askButtons } from '../../../src/health/notify/discord-bot.ts';
import { replyMessages, topSplit } from '../../../src/health/notify/discord-reply.ts';
import { NoteLimiter, noteFor } from '../../../src/health/panel/notes.ts';
import { AskBox } from '../../../src/tasks/ask.ts';

const T0 = Date.UTC(2026, 10, 21, 14, 2, 0);
const OWNER = '111111111111111111';

/** The queue's question as tasks/queue.ts askOwner asks it (onfail next), with a 5 min wait. */
function queueQuestion() {
  const box = new AskBox({ bus: new EventBus(), now: () => T0 });
  const q = box.ask({
    key: 'queue-fail',
    text: 'job #7 !goto zzqxtest failed (no waypoint zzqxtest): retry it, go on with the next, or pause the queue?',
    choices: [
      { id: 'retry', label: 'retry it (next in line)', aliases: ['yes', 'again'], short: 'Retry', done: 'Retried' },
      { id: 'next', label: 'go on with the next', aliases: ['no', 'skip', 'go'], short: 'Skip', done: 'Skipped' },
      { id: 'stop', label: 'pause the queue', aliases: ['pause'], short: 'Pause queue', done: 'Queue paused' },
    ],
    default: 'next',
    waitMs: 300_000,
    title: 'Job #7 failed: !goto zzqxtest',
    detail: 'no waypoint zzqxtest',
    push: 'Job #7 failed: retry, skip or pause the queue?',
  });
  const view = box.list()[0]!;
  const card = box.card(q.id);
  const ev = { id: 41, ts: T0, kind: 'ask.asked', sev: 'notable', data: { id: q.id, key: 'queue-fail', text: view.text, choices: ['retry', 'next', 'stop'], default: 'next', waitS: 300 } } as unknown as BotEvent;
  const note = new NoteLimiter().offer(noteFor(ev)!, T0)!;
  box.dispose();
  return { view, card, note };
}

const alert = (kind: string, data: Record<string, unknown>, sev = 'alert') => new NoteLimiter().offer(noteFor({ id: 42, ts: T0, kind, sev, data } as unknown as BotEvent)!, T0)!;

describe('Track D2: the notes', () => {
  it('(a) a queue question on the bot: the push line asks it, the title is the matter, one cause line, the default once by a Discord timestamp; short buttons, the default primary', () => {
    const { view, card, note } = queueQuestion();
    expect({ ...payloadFor(note, { bot: 'Bot', ask: view, card, buttons: true, now: T0 }), components: askButtons('0a1b2c3d', view, card) }).toMatchInlineSnapshot(`
      {
        "allowed_mentions": {
          "parse": [],
        },
        "components": [
          {
            "components": [
              {
                "custom_id": "bb:0a1b2c3d:1:retry",
                "label": "Retry",
                "style": 2,
                "type": 2,
              },
              {
                "custom_id": "bb:0a1b2c3d:1:next",
                "label": "Skip",
                "style": 1,
                "type": 2,
              },
              {
                "custom_id": "bb:0a1b2c3d:1:stop",
                "label": "Pause queue",
                "style": 2,
                "type": 2,
              },
            ],
            "type": 1,
          },
        ],
        "content": "Job #7 failed: retry, skip or pause the queue?",
        "embeds": [
          {
            "color": 15773006,
            "description": "No waypoint zzqxtest
      Unanswered: Skip <t:1795270020:R>",
            "footer": {
              "text": "Bot",
            },
            "timestamp": "2026-11-21T14:02:00.000Z",
            "title": "Job #7 failed: !goto zzqxtest",
          },
        ],
      }
    `);
  });

  it('(a) the same by the webhook: no buttons, one line of how to answer', () => {
    const { view, card, note } = queueQuestion();
    expect(payloadFor(note, { bot: 'Bot', ask: view, card, now: T0 })).toMatchInlineSnapshot(`
      {
        "allowed_mentions": {
          "parse": [],
        },
        "content": "Job #7 failed: retry, skip or pause the queue?",
        "embeds": [
          {
            "color": 15773006,
            "description": "No waypoint zzqxtest
      Unanswered: Skip <t:1795270020:R>
      Answer: \`!answer 1 retry\`, \`next\` or \`stop\` in the game or the panel",
            "footer": {
              "text": "Bot",
            },
            "timestamp": "2026-11-21T14:02:00.000Z",
            "title": "Job #7 failed: !goto zzqxtest",
          },
        ],
      }
    `);
  });

  it('(b) after the answer: the outcome said, grey, no buttons, no push line; a press names the presser, a typed answer where it came from', () => {
    const { view, card, note } = queueQuestion();
    expect(answeredPayload({ note, view, card, answer: { choice: 'retry', how: 'discord', by: 'Steve', afterS: 48, user: OWNER } }, 'Bot')).toMatchInlineSnapshot(`
      {
        "allowed_mentions": {
          "parse": [],
        },
        "components": [],
        "content": "",
        "embeds": [
          {
            "color": 10070709,
            "description": "No waypoint zzqxtest
      **Retried** by <@111111111111111111> · 48 s",
            "footer": {
              "text": "Bot",
            },
            "timestamp": "2026-11-21T14:02:00.000Z",
            "title": "Job #7 failed: !goto zzqxtest",
          },
        ],
      }
    `);
    const line = (answer: Parameters<typeof answeredPayload>[0]['answer']) => answeredPayload({ note, view, card, answer }, 'Bot').embeds[0]!.description;
    expect(line({ choice: 'stop', how: 'chat', by: 'Steve', afterS: 125 })).toBe('No waypoint zzqxtest\n**Queue paused** by Steve in the game · 2 min 5 s');
    expect(line({ choice: 'retry', how: 'panel', by: 'Steve', afterS: 9 })).toBe('No waypoint zzqxtest\n**Retried** by Steve in the panel · 9 s');
    expect(line({ choice: 'next', how: 'discord', by: 'Steve', afterS: 30 })).toBe('No waypoint zzqxtest\n**Skipped** by Steve on Discord · 30 s'); // typed `!answer` on Discord: no press
    expect(line({ choice: 'next', how: 'timeout', afterS: 300 })).toBe('No waypoint zzqxtest\nNo answer: skipped');
    expect(line({ choice: 'next', how: 'replaced', afterS: 3 })).toBe('No waypoint zzqxtest\nClosed by a newer question: skipped');
    expect(line({ choice: 'next', how: 'closed', afterS: 3 })).toBe('No waypoint zzqxtest\nClosed: skipped');
    expect(line(undefined)).toBe('No waypoint zzqxtest\nClosed');
  });

  it('(c) a death: the push line says what killed it and where; the title the matter, the cause in one line, the time as the embed timestamp, the bot name in the footer', () => {
    const d = alert('life.died', { n: 1, cause: 'death.attack.mob', messages: ['%entity.zombie.name'], at: { x: 10.4, y: 64, z: -3.2 } });
    expect(payloadFor(d, { bot: 'Bot' })).toMatchInlineSnapshot(`
      {
        "allowed_mentions": {
          "parse": [],
        },
        "content": "The bot died: zombie at 10 64 -4",
        "embeds": [
          {
            "color": 14242639,
            "description": "Zombie at 10 64 -4",
            "footer": {
              "text": "Bot",
            },
            "timestamp": "2026-11-21T14:02:00.000Z",
            "title": "The bot died",
          },
        ],
      }
    `);
    expect(payloadFor(alert('life.died', { n: 1, cause: 'death.attack.arrow', messages: ['%entity.skeleton.name'], at: { x: 4, y: 70, z: 2 } })).content).toBe('The bot died: skeleton (arrow) at 4 70 2');
    expect(payloadFor(alert('life.died', { n: 1, cause: 'death.attack.fall' })).content).toBe('The bot died: fell');
    expect(payloadFor(alert('life.died', { n: 1, cause: 'death.attack.generic', at: { x: 1, y: 2, z: 3 } })).content).toBe('The bot died: killed at 1 2 3'); // /kill
    expect(payloadFor(alert('life.died', { n: 1, cause: 'death.attack.explosion.player', messages: ['%entity.creeper.name'] })).content).toBe('The bot died: creeper (blown up)');
    expect(payloadFor(alert('life.died', { n: 1, cause: 'death.attack.sonicBoom' })).content).toBe('The bot died: sonicBoom'); // an id not listed: as it is
    const folded = { ...d, n: 3, title: 'the bot died (3 times in 1 min 12 s)' };
    expect(payloadFor(folded).embeds[0]).toEqual({ title: 'The bot died (3 times in 1 min 12 s)', description: 'The last: zombie at 10 64 -4', color: 0xd9534f, timestamp: '2026-11-21T14:02:00.000Z' });
  });

  it('the other alerts and the test note: the matter, what to do when something is to be done, no event kind anywhere', () => {
    const kicked = payloadFor(alert('connection.kicked', { reason: 'disconnect', message: 'Server closed', willReconnect: true }), { bot: 'Bot' });
    expect(kicked.content).toBe('The bot was kicked: Server closed: it reconnects by itself');
    expect(payloadFor(alert('connection.kicked', { reason: 'disconnect', willReconnect: false })).embeds[0]!.description).toBe('Disconnect: start it again on its machine');
    expect(payloadFor(alert('connection.lost', { reason: 'gave up', attempts: 10 })).content).toBe('The bot lost the connection for good: start it again on its machine');
    const other = payloadFor({ title: 'nav: stuck for 30 s at 1 64 2', body: "The panel's Away view has the rest.", ts: T0, ask: null, kind: 'nav.stuck', n: 1 }, { bot: 'Bot' });
    expect(other).toEqual({ content: 'Nav: stuck for 30 s at 1 64 2', embeds: [{ title: 'Nav: stuck for 30 s at 1 64 2', color: 0xd9534f, timestamp: '2026-11-21T14:02:00.000Z', footer: { text: 'Bot' } }], allowed_mentions: { parse: [] } });
    expect(payloadFor({ title: 'test notification', body: 'nothing to do', ts: T0, ask: null, kind: 'notify.test', n: 1 }, { bot: 'Bot', test: true })).toMatchInlineSnapshot(`
      {
        "allowed_mentions": {
          "parse": [],
        },
        "content": "Test from Bot: notes arrive here",
        "embeds": [
          {
            "color": 5793266,
            "description": "Nothing to do",
            "footer": {
              "text": "Bot",
            },
            "timestamp": "2026-11-21T14:02:00.000Z",
            "title": "Test notification",
          },
        ],
      }
    `);
    for (const p of [kicked, other]) expect(JSON.stringify(p)).not.toMatch(/connection\.kicked|nav\.stuck|notify\.test/);
  });

  it('the limits: a button label at most 80, 5 buttons a row, 5 rows; the whole embed at most 6 000', () => {
    const view = { id: 3, key: 'k', text: 'x'.repeat(500), choices: Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, label: 'l', n: i + 1, yes: false, no: false })), default: 'c0', askedAt: 0, until: 1 };
    const rows = askButtons('0a1b2c3d', view, { choices: { c1: { short: 'y'.repeat(200) } } });
    expect(rows.every((r) => r.components.length <= 5)).toBe(true);
    expect(rows.flatMap((r) => r.components).every((b) => b.label.length <= 80)).toBe(true);
    const e = payloadFor({ title: 't', body: 'b', ts: 0, ask: 3, kind: 'ask.asked', n: 1 }, { ask: view, card: { title: 'z'.repeat(9000), detail: 'q'.repeat(9000), choices: {} }, bot: 'b'.repeat(3000) }).embeds[0]!;
    expect((e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text.length ?? 0)).toBeLessThanOrEqual(DISCORD_LIMITS.embedTotal);
  });
});

describe('Track D2: the reply rules', () => {
  it('(d) a short reply: one plain line', () => {
    expect(replyMessages(['pos 10.50 64.00 -3.50'])).toEqual(['pos 10.50 64.00 -3.50']);
    expect(replyMessages(['arrived at home'])).toEqual(['arrived at home']);
    expect(replyMessages(['§cno§r waypoint zzqxtest (!wp list)'])).toEqual(['no waypoint zzqxtest (!wp list)']);
  });

  it('(e) a status of key value pairs: the head in bold, the pairs a few to a row; a process stack of `;` parts: a bullet each', () => {
    const status = [
      'status: up 1h02m, session 12m03s, reconnects 1, kicks 0, pos 10.50 64.00 -3.50, version 1.26.51, tick 14460, task afk, behaviour guard on, rockets 40/64, elytra 58/432 (covers about 600 blocks), nudges 3, corrections 0, deaths 1',
      'processes: [active] walking to 10 -60 3, 24 blocks left, eta 6 s; [paused] gather 3/10 logs',
    ];
    expect(replyMessages(status)).toMatchInlineSnapshot(`
      [
        "**status**
      **up** 1h02m · **session** 12m03s
      **reconnects** 1 · **kicks** 0
      **pos** 10.50 64.00 -3.50
      **version** 1.26.51 · **tick** 14460
      **task** afk · **behaviour** guard on
      **rockets** 40/64
      **elytra** 58/432 (covers about 600 blocks)
      **nudges** 3 · **corrections** 0
      **deaths** 1
      **processes**
      - [active] walking to 10 -60 3, 24 blocks left, eta 6 s
      - [paused] gather 3/10 logs",
      ]
    `);
  });

  it('(f) `!discord`: two lines under one head become one list; a short label in bold; the token variable\'s underscores escaped', () => {
    const lines = [
      'discord bot: on, token set (BEDROCKBOT_DISCORD_TOKEN); gateway ready for 12 min 3 s (1 session, 0 resumed, 0 reconnects, heartbeat 41 ms)',
      'discord bot: 1 user, 1 channel, notes channel ...8587; in: 3 run, 1 presses, 0 refused, 0 rate-limited, 2 ignored; out: 9 sent, 0 failed, 0 waiting',
    ];
    expect(replyMessages(lines)).toMatchInlineSnapshot(`
      [
        "**discord bot**
      - on, token set (BEDROCKBOT\\_DISCORD\\_TOKEN)
      - gateway ready for 12 min 3 s (1 session, 0 resumed, 0 reconnects, heartbeat 41 ms)
      - 1 user, 1 channel, notes channel ...8587
      - **in:** 3 run, 1 presses, 0 refused, 0 rate-limited, 2 ignored
      - **out:** 9 sent, 0 failed, 0 waiting",
      ]
    `);
  });

  it('a sentence with commas stays a sentence; a `;` line with no head: the first part, then a bullet each; short lines stay as they are', () => {
    expect(replyMessages(['no way to get bread yet: it needs wheat, which is not gathered, mined, hunted or crafted from those'])).toEqual(['no way to get bread yet: it needs wheat, which is not gathered, mined, hunted or crafted from those']);
    expect(replyMessages(['#3 !goto zzqxtest is left to it; !queue resume goes on with #4 !get kit iron'])).toEqual(['#3 !goto zzqxtest is left to it\n- !queue resume goes on with #4 !get kit iron']);
    expect(replyMessages(['queue: a; b'])).toEqual(['queue: a; b']);
  });

  it('code blocks only where alignment is the content: lines in columns, a list of coordinates', () => {
    expect(replyMessages(['name    x    y', 'home    1    64', 'mine    5    12'])).toEqual(['```\nname    x    y\nhome    1    64\nmine    5    12\n```']);
    expect(replyMessages(['home 1 64 2', 'mine 5 12 -40', 'farm -3 70 9', 'that is all'])).toEqual(['```\nhome 1 64 2\nmine 5 12 -40\nfarm -3 70 9\n```\nthat is all']);
    expect(replyMessages(['home 1 64 2', 'mine 5 12 -40'])).toEqual(['home 1 64 2\nmine 5 12 -40']); // two: plain
  });

  it('markdown is escaped, a URL is not; mentions and timestamps stay text', () => {
    expect(escapeMarkdown('!craft diamond_sword *2* ~x~ |a| `b`')).toBe('!craft diamond\\_sword \\*2\\* \\~x\\~ \\|a\\| \\`b\\`');
    expect(escapeMarkdown('- not a list\n# not a heading\n> not a quote\n1. not a number')).toBe('\\- not a list\n\\# not a heading\n\\> not a quote\n1\\. not a number');
    expect(escapeMarkdown('see <@123> <t:1:R> [x](http://a_b)')).toBe('see \\<@123> \\<t:1:R> \\[x\\](http://a_b)');
    expect(escapeMarkdown('panel http://127.0.0.1:9920/x_y ok_z')).toBe('panel http://127.0.0.1:9920/x_y ok\\_z');
  });

  it("a question's cause: one short line, the matter before its detail (as the e2e's failed craft said it)", () => {
    const craft = 'craft: no oak_log for diamond_sword (2 oak_log, 1 diamond_block missing; it would craft 8 oak_planks, 1 crafting_table, 9 diamond, 4 stick first; !get diamond_sword gets it all)';
    expect(causeLine(craft)).toBe('craft: no oak_log for diamond_sword');
    expect(causeLine('no waypoint "zzqxtest" (!wp list)')).toBe('no waypoint "zzqxtest" (!wp list)');
    expect(causeLine('x'.repeat(10) + ' (' + 'y '.repeat(80))).toMatch(/^x{10} \(y( y)*\.\.\.$/);
    expect(causeLine('word '.repeat(40)).length).toBeLessThanOrEqual(CAUSE_MAX);
  });

  it('the pieces: a split outside brackets, a short duration', () => {
    expect(topSplit('a (b, c), d [e, f], g', ',')).toEqual(['a (b, c)', 'd [e, f]', 'g']);
    expect([48, 60, 312, 7380].map(shortDuration)).toEqual(['48 s', '1 min', '5 min 12 s', '2 h 3 min']);
  });
});
