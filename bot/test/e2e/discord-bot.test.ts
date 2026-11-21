// Track D1 on bds-core (docs/discord.md, ADR 0118): the bot's own Discord bot from a real bot process, against a local
// fake Discord in this test (a websocket and REST server on the loopback, ports 10135 to 10139; never Discord). The bot
// reads an obviously fake token from BEDROCKBOT_DISCORD_TOKEN and reaches the fake through the test-only
// BEDROCKBOT_DISCORD_TEST_ORIGIN; GET /gateway/bot hands it the fake's ws:// URL.
//   connect   the gateway: IDENTIFY with the intents, READY
//   command   `!pos` from an allowed user in a listed channel: one reply in that channel with the position, the log
//             line `discord: !pos (as <owner>, from <id>)`, the command event with source discord; `!goto` a few
//             blocks off: the reply, then the later `arrived` line followed into the channel
//   ignored   the same from a stranger, from the allowed user in another channel, from a bot: no reply
//   refused   `!quit`: the reason, the bot still up
//   question  askOwner on, a queued `!craft diamond_sword` with nothing (queued from Discord): the question in the notes
//             channel with its choices as buttons; a stranger's press refused privately; the owner's press of `next`
//             answers it (how discord), the pressed message updated, the queue goes on
//   secret    the token in nothing the bot printed, /api/state, /api/events, the event store, the replies
// Env: D1_PANEL_PORT (default a random port in 10130..10134), D1_OUT=<file> (the measured lines appended),
// core-truth.ts (CORE_BDS_*). Needs BDS_E2E=1 and bds-core with the truth pack.
import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PanelAway } from '../../src/health/panel/away.ts';
import type { JobsSummary } from '../../src/health/panel/shared.ts';
import { DISCORD_INTENTS } from '../../src/health/notify/discord-gateway.ts';
import { fakeDiscord, type FakeDiscord, type FakeRest } from '../unit/health/fake-discord.ts';
import type { PveTruth } from './pve-truth.ts';
import { centre, clearArea, CORE_CONTAINER, CORE_TARGET, E2E, FEET_Y, prepareServer, privateArea, sleep, until, waitOnline, type CoreCli } from './core-truth.ts';
import { connectObserver, panelClient, quitPanelCli, startPanelCli, type Observer, type PanelCli } from './panel-e2e.ts';

const F = FEET_Y;
const panel = panelClient(Number(process.env.D1_PANEL_PORT ?? 10130 + randomInt(5))); // 10130..10134: the fake Discord has 10135..10139
/** Obviously fake, in a bot token's shape (three parts joined by dots); the bot never sees Discord in this test. */
const TOKEN = `NOT-A-REAL-TOKEN-e2e-d1-${randomInt(1000, 9999)}.fake00.NOT-A-REAL-TOKEN-just-for-this-test`;
const OWNER = '111111111111111111';
const STRANGER = '222222222222222222';
const CHAN = '333333333333333333';
const OTHER_CHAN = '343434343434343434';
const NOTES = '363636363636363636';
const GUILD = '444444444444444444';

function filesText(dir: string): string {
  let out = '';
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out += readFileSync(p, 'latin1');
    }
  };
  try {
    walk(dir);
  } catch {
    // no store yet
  }
  return out;
}

describe.skipIf(!E2E)('core: the Discord bot (Track D1)', () => {
  const area = privateArea();
  const HOME = { x: area.x, y: F, z: area.z };
  const notes: string[] = [];
  let observer: Observer | undefined;
  let truth: PveTruth | undefined;
  let run: PanelCli | undefined;
  let cli: CoreCli | undefined;
  let fake: FakeDiscord | undefined;
  let t0 = 0;

  const cmd = async (text: string): Promise<string[]> => {
    const r = await panel.cmd(text);
    expect(r.status, text).toBe(200);
    return r.body.replies;
  };
  const postsTo = (ch: string, since = 0): FakeRest[] => fake!.posts.filter((p) => p.path === `/channels/${ch}/messages` && p.at >= since);
  const text = (p: FakeRest): string => (typeof p.body.content === 'string' ? p.body.content : '');
  const note = (line: string): void => {
    notes.push(line);
    console.log(`[d1] ${line}`);
  };

  beforeAll(async () => {
    fake = await fakeDiscord({ token: TOKEN, ports: [10135, 10139] });
    await prepareServer({ time: 'noon' });
    observer = await connectObserver(`D1Obs${randomInt(1000, 9999)}`, CORE_TARGET, CORE_CONTAINER);
    truth = observer.truth;
    await truth.tp(observer.name, { x: HOME.x + 0.5, y: F, z: HOME.z - 40 + 0.5 }, 0, 0);
    await clearArea(truth, HOME, 12, 6);
    await truth.fill({ x: HOME.x - 12, y: F - 1, z: HOME.z - 12 }, { x: HOME.x + 12, y: F - 1, z: HOME.z + 12 }, 'grass_block');
    const keep = { origin: process.env.BEDROCKBOT_DISCORD_TEST_ORIGIN, token: process.env.BEDROCKBOT_DISCORD_TOKEN };
    process.env.BEDROCKBOT_DISCORD_TEST_ORIGIN = fake.origin;
    process.env.BEDROCKBOT_DISCORD_TOKEN = TOKEN;
    t0 = Date.now();
    try {
      run = startPanelCli(panel, {
        prefix: 'bot-e2e-d1-',
        args: ['--walk', '--respawn-delay', '1', '--set', 'discordBot=on', '--set', `discordUsers=${OWNER}`, '--set', `discordChannels=${CHAN}`, '--set', `discordNotes=${NOTES}`],
        events: true,
      });
    } finally {
      const put = (k: string, v: string | undefined): void => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      };
      put('BEDROCKBOT_DISCORD_TEST_ORIGIN', keep.origin);
      put('BEDROCKBOT_DISCORD_TOKEN', keep.token);
    }
    cli = run.cli;
    await waitOnline(truth, cli.name);
    await panel.healthy();
    await until(async () => ((await panel.get<JobsSummary>('/api/jobs')).on ? true : undefined), 20_000, 'the queue on the panel');
    await truth.tp(cli.name, centre(HOME), 0, 0);
    await cmd('!set autoFood off');
    await cmd('!set notify off');
  }, 120_000);

  afterAll(async () => {
    await quitPanelCli(panel, cli).catch(() => undefined);
    cli?.kill();
    await truth?.cleanup().catch(() => undefined);
    await clearArea(truth!, HOME, 12, 6).catch(() => undefined);
    await truth?.fill({ x: HOME.x - 12, y: F - 1, z: HOME.z - 12 }, { x: HOME.x + 12, y: F - 1, z: HOME.z + 12 }, 'grass_block').catch(() => undefined);
    await observer?.close();
    run?.cleanup();
    await fake?.close();
    const out = `[discord-bot e2e] port ${panel.port}, fake Discord ${fake?.port}, area cell ${area.cell}\n  ${notes.join('\n  ')}\n`;
    console.log(out);
    if (process.env.D1_OUT) appendFileSync(process.env.D1_OUT, out);
  }, 90_000);

  it('connect: IDENTIFY with the intents, READY', async () => {
    await until(() => Promise.resolve(fake!.readies >= 1 ? true : undefined), 30_000, 'READY at the fake gateway', 100);
    const id = fake!.frames.find((f) => f.op === 2)!;
    expect(id.d).toMatchObject({ token: TOKEN, intents: DISCORD_INTENTS });
    const status = (await cmd('!discord')).join(' | ');
    expect(status).toMatch(/discord bot: on, token set \(BEDROCKBOT_DISCORD_TOKEN\); gateway ready/);
    expect(status).toMatch(/1 user, 1 channel, notes channel \.\.\.3636/);
    expect(status).not.toContain(OWNER);
    note(`connect: IDENTIFY ${((id.at - t0) / 1000).toFixed(1)} s after the start; ${status}`);
  }, 60_000);

  it('command: !pos runs as the first owner marked discord and its reply comes back; !goto follows with the arrival', async () => {
    const t = Date.now();
    const mid = fake!.message({ author: OWNER, channel: CHAN, guild: GUILD, content: '!pos' });
    const p = await until(() => Promise.resolve(postsTo(CHAN, t)[0]), 10_000, 'the reply to !pos', 50);
    expect(text(p)).toMatch(/^```\npos -?\d+(\.\d+)? -?\d+(\.\d+)? -?\d+(\.\d+)?/);
    expect(p.body.allowed_mentions).toEqual({ parse: [] });
    expect(p.body.message_reference).toEqual({ message_id: mid, fail_if_not_exists: false });
    expect(cli!.output()).toMatch(new RegExp(`discord: !pos \\(as [^,]+, from ${OWNER}\\)`));
    const ev = await panel.get<{ events: { kind: string; data: { source?: string; command?: string } }[] }>('/api/events?since=0&limit=1000');
    const got = ev.events.filter((e) => e.kind === 'command.received' && e.data.command === 'pos');
    expect(got.at(-1)?.data.source).toBe('discord');
    note(`command: !pos reply ${((p.at - t) / 1000).toFixed(2)} s after the message: ${text(p).replace(/\n/g, ' ')}; the command event source ${got.at(-1)?.data.source}`);
    const t2 = Date.now();
    fake!.message({ author: OWNER, channel: CHAN, guild: GUILD, content: `!goto ${HOME.x + 8} ${F} ${HOME.z + 6}` });
    const arrived = await until(() => Promise.resolve(postsTo(CHAN, t2).find((x) => /arrived/i.test(text(x)))), 45_000, 'the arrival followed into the channel', 100);
    const all = postsTo(CHAN, t2).map((x) => text(x).replace(/\n/g, ' '));
    note(`command: !goto ${all.length} messages, the arrival ${((arrived.at - t2) / 1000).toFixed(1)} s after the message: ${all.join(' | ').slice(0, 300)}`);
  }, 90_000);

  it('ignored: a stranger, the allowed user in another channel, a bot: no reply', async () => {
    const t = Date.now();
    fake!.message({ author: STRANGER, channel: CHAN, guild: GUILD, content: '!pos' });
    fake!.message({ author: STRANGER, channel: '919191919191919191', content: '!pos' });
    fake!.message({ author: OWNER, channel: OTHER_CHAN, guild: GUILD, content: '!pos' });
    fake!.message({ author: OWNER, channel: CHAN, guild: GUILD, content: '!pos', bot: true });
    await sleep(4000);
    expect(fake!.posts.filter((p) => p.at >= t)).toHaveLength(0);
    note('ignored: 4 messages (a stranger in the channel and in a DM, the owner in another channel, a bot): 0 replies in 4 s');
  }, 30_000);

  it('refused: !quit says why and the bot stays up', async () => {
    const t = Date.now();
    fake!.message({ author: OWNER, channel: CHAN, guild: GUILD, content: '!quit' });
    const p = await until(() => Promise.resolve(postsTo(CHAN, t)[0]), 10_000, 'the refusal', 50);
    expect(text(p)).toMatch(/!quit is not taken from Discord: it ends the bot/);
    await sleep(1500);
    expect(cli!.child.exitCode).toBeNull();
    await panel.healthy(5000);
    note(`refused: ${text(p).replace(/\n/g, ' ')}; the bot still up`);
  }, 30_000);

  it('question: buttons in the notes channel; a stranger refused privately; the owner\'s press answers it (discord)', async () => {
    const t = Date.now();
    // the switches from the panel (the owner's 5 commands in 20 s from Discord are spent by the cases above), the job from Discord
    for (const c of ['!queue onfail next', '!set askWaitS 60', '!set askOwner on']) await cmd(c);
    fake!.message({ author: OWNER, channel: CHAN, guild: GUILD, content: '!queue add !craft diamond_sword' });
    const added = await until(() => Promise.resolve(postsTo(CHAN, t).find((p) => text(p).includes('queue: added'))), 10_000, 'the job added from Discord', 50);
    expect(added).toBeDefined();
    const qn = await until(() => Promise.resolve(postsTo(NOTES, t).find((p) => Array.isArray(p.body.components))), 60_000, 'the question in the notes channel', 100).catch((e: unknown) => {
      note(`question: no note; the replies ${postsTo(CHAN, t).map((p) => text(p).replace(/\n/g, ' ')).join(' | ')}; the notes channel ${postsTo(NOTES, t).length}; the bot said: ${cli!.output().split('\n').filter((l) => /queue|ask|discord|notify|craft/i.test(l)).slice(-25).join(' // ')}`);
      throw e;
    });
    const away = await panel.get<PanelAway>('/api/away');
    const q = away.asks[0]!;
    expect(q).toBeDefined();
    const rows = qn.body.components as { components: { custom_id: string; label: string }[] }[];
    const buttons = rows.flatMap((r) => r.components);
    expect(buttons.map((b) => b.label.split(':')[0])).toEqual(['retry', 'next', 'stop']);
    const nextBtn = buttons.find((b) => b.label.startsWith('next'))!;
    const message = { id: '808080808080808080', channel_id: NOTES, content: text(qn) };
    const c0 = fake!.callbacks.length;
    fake!.press({ user: STRANGER, customId: nextBtn.custom_id, message, guild: GUILD });
    await until(() => Promise.resolve(fake!.callbacks.length > c0 ? true : undefined), 5000, 'the stranger\'s answer', 50);
    expect(fake!.callbacks[c0]!.body).toMatchObject({ type: 4, data: { flags: 64 } });
    expect((await panel.get<PanelAway>('/api/away')).asks).toHaveLength(1);
    const tp = Date.now();
    fake!.press({ user: OWNER, customId: nextBtn.custom_id, message, guild: GUILD });
    await until(() => Promise.resolve(fake!.callbacks.length > c0 + 1 ? true : undefined), 5000, 'the owner\'s answer', 20);
    const cb = fake!.callbacks[c0 + 1]!;
    expect(cb.body.type).toBe(7);
    const fields = (cb.body.data as { embeds: { fields: { name: string; value: string }[] }[]; components: unknown[] }).embeds[0]!.fields;
    expect(fields[1]!.name).toBe('Answered');
    expect(fields[1]!.value).toMatch(/^next by .+ \(discord\) after /);
    await until(async () => ((await panel.get<PanelAway>('/api/away')).asks.length === 0 ? true : undefined), 5000, 'the question gone', 100);
    const ev = await panel.get<{ events: { kind: string; data: { how?: string; id?: number } }[] }>('/api/events?since=0&limit=1000');
    expect(ev.events.filter((e) => e.kind === 'ask.answered' && e.data.id === q.id).at(-1)?.data.how).toBe('discord');
    await cmd('!set askOwner off');
    note(`question: the note ${((qn.at - q.askedAt) / 1000).toFixed(2)} s after the question #${q.id}; buttons ${buttons.map((b) => b.label).join(', ')}; the stranger's press type 4 ephemeral; the owner's press answered in ${((cb.at - tp) / 1000).toFixed(2)} s (type 7): ${fields[1]!.value}`);
  }, 120_000);

  it('secret: the token is in no output, state, reply or stored event', async () => {
    const replies = [...(await cmd('!set')), ...(await cmd('!set discordBot')), ...(await cmd('!discord')), ...(await cmd('!notify'))];
    await sleep(500);
    const get = async (path: string): Promise<string> => (await fetch(`${panel.base}${path}`, { headers: panel.auth })).text();
    const views: [string, string][] = [
      ['replies', replies.join('\n')],
      ['/api/state', await get('/api/state')],
      ['/api/state?lite=1', await get('/api/state?lite=1')],
      ['/api/away', await get('/api/away')],
      ['/api/events', await get('/api/events?since=0&limit=1000')],
      ['the event store', filesText(join(run!.dir, 'events'))],
      ['the bot output', cli!.output()],
      ['the messages to Discord', JSON.stringify([...fake!.posts, ...fake!.edits, ...fake!.callbacks].map((p) => p.body))],
    ];
    for (const [what, t] of views) expect(t.includes(TOKEN), what).toBe(false);
    // the chat's replies show the last 4 digits; the panel's settings editor (behind its token) holds the value it edits
    expect(views[0]![1].includes(OWNER), 'replies: the whole id').toBe(false);
    expect(cli!.output()).toMatch(/discord bot: token set \(BEDROCKBOT_DISCORD_TOKEN\)/);
    note(`secret: the token in none of ${views.map(([w, t]) => `${w} (${t.length} chars)`).join(', ')}`);
  }, 60_000);
});
