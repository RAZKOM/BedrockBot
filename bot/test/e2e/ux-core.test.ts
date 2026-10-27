// Wave 9 Track AM on bds-core (docs/ux.md, decision 0034): the UX layer on the real afk task and chat.
//   1. `!help` is at most 3 messages and names exactly the front-door commands registered here;
//      `!help cook` has the example and the auto line; `!help all` contains cook and mine;
//   2. `!mode careful` sets fleeHealth 12 (reply and `!set fleeHealth`), `!mode status` says careful,
//      `!set fleeHealth 9` makes it custom;
//   3. the welcome whisper reaches an owner once after their first chat line, and not again after
//      the bot reconnects with the same (in-memory) settings;
//   4. `!do what can you do` with the FakeProvider replies one line and starts nothing.
// Needs BDS_E2E=1 and bds-core with the truth pack (`node scripts/bds.mjs --profile core up` and `... pack`).
// Env: CORE_BDS_HOST / CORE_BDS_PORT / CORE_BDS_CONTAINER (core-truth.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FRONT_DOOR } from '../../src/chat/help.ts';
import { welcomeVersion } from '../../src/chat/welcome.ts';
import { RuntimeSettings } from '../../src/config/settings.ts';
import { FakeProvider } from '../../src/nl/fake.ts';
import { EXAMPLES } from '../../src/nl/prompt.ts';
import { NL_PROVIDER_KEY } from '../../src/nl/provider.ts';
import { connectPlayer, E2E, prepareServer, sleep, startCoreBot, uniqueName, until, type CoreBot } from './core-truth.ts';

type Player = Awaited<ReturnType<typeof connectPlayer>>;

describe.skipIf(!E2E)('core: UX (wave 9 Track AM)', () => {
  const settings = new RuntimeSettings(); // in memory (no config dir), shared by both bot connections
  const answer = EXAMPLES.find((e) => e.request === 'what can you do')!.plan;
  const provider = new FakeProvider([['what can you do', answer]]);
  const measurements: string[] = [];
  let bot: CoreBot | undefined;
  let owner: Player | undefined;
  const whispers: string[] = [];

  /** Every line said after `from` until the chat has been quiet for `quietMs`. */
  async function burst(b: CoreBot, from: number, quietMs = 1200): Promise<string[]> {
    await until(() => (b.said.length > from ? true : undefined), 10_000, 'a reply', 50);
    let n = b.said.length;
    for (;;) {
      await sleep(quietMs);
      if (b.said.length === n) return b.said.slice(from);
      n = b.said.length;
    }
  }

  const start = () => startCoreBot('CoreUx', {}, { values: { 'no-config': true, [NL_PROVIDER_KEY]: provider }, settings });

  beforeAll(async () => {
    await prepareServer();
    bot = await start();
  }, 180_000);

  afterAll(async () => {
    await owner?.close().catch(() => undefined);
    await bot?.stop().catch(() => undefined);
    console.log(`measurements:\n  ${measurements.join('\n  ')}`);
  }, 60_000);

  it('!help: at most 3 messages, exactly the front door; !help cook; !help all', async () => {
    const b = bot!;
    let n = b.said.length;
    const t0 = Date.now();
    await b.command('!help');
    const help = await burst(b, n);
    const ms = Date.now() - t0;
    console.log(help.join('\n'));
    expect(help.length).toBeLessThanOrEqual(3);
    for (const l of help) expect(l.length).toBeLessThanOrEqual(256);
    expect(help[0]).toMatch(/^front door: /);
    expect(help.at(-1)).toMatch(/!help all, !help <command>$/);
    const named = new Set([...help.join(' ').matchAll(/!([a-z]+) \(/g)].map((m) => m[1]!));
    const present = FRONT_DOOR.filter((c) => b.chat.has(c));
    expect([...named].sort()).toEqual([...present].sort());
    expect(present.length).toBe(FRONT_DOOR.length);

    n = b.said.length;
    await b.command('!help cook');
    const cook = await burst(b, n);
    console.log(cook.join('\n'));
    expect(cook[0]).toMatch(/^!cook: cook the raw food/);
    expect(cook).toContain('example: !cook');
    expect(cook.some((l) => l.startsWith('also on its own: after every hunt'))).toBe(true);

    n = b.said.length;
    await b.command('!help all');
    const all = await burst(b, n);
    console.log(all.join('\n'));
    expect(all.length).toBeLessThanOrEqual(4);
    const words = new Set(all.join(' ').split(/[\s:;,()]+/));
    expect(words.has('cook')).toBe(true);
    expect(words.has('mine')).toBe(true);
    measurements.push(`!help: ${help.length} messages (${help.map((l) => l.length).join(', ')} chars) in ${ms} ms; !help cook ${cook.length}; !help all ${all.length}`);
  }, 60_000);

  it('!mode careful / status / custom', async () => {
    const b = bot!;
    let n = b.said.length;
    await b.command('!mode careful');
    const r = await b.reply((s) => s.startsWith('mode careful:'), n);
    expect(r).toMatch(/^mode careful: fleeHealth 12, guardRadius 8, avoidMobRadius 8, avoidSpawnerRadius 16, allowBreak off, allowPlace off \(was normal\)/);
    expect(b.settings.get('fleeHealth')).toBe(12);
    n = b.said.length;
    await b.command('!set fleeHealth');
    expect(await b.reply((s) => s.startsWith('fleeHealth '), n)).toMatch(/^fleeHealth 12 \(0\.\.20 health, default 8\)/);
    n = b.said.length;
    await b.command('!mode status');
    expect(await b.reply((s) => s.startsWith('mode '), n)).toMatch(/^mode careful \(/);
    n = b.said.length;
    await b.command('!set fleeHealth 9');
    await b.reply((s) => s.startsWith('fleeHealth = 9'), n);
    n = b.said.length;
    await b.command('!mode status');
    const custom = await b.reply((s) => s.startsWith('mode '), n);
    expect(custom).toMatch(/^mode custom \(careful but fleeHealth 9 instead of 12\)/);
    n = b.said.length;
    await b.command('!mode normal');
    await b.reply((s) => s.startsWith('mode normal:'), n);
    expect(b.settings.get('fleeHealth')).toBe(8);
    measurements.push(`!mode: careful -> fleeHealth 12; status careful; after !set fleeHealth 9: "${custom}"`);
  }, 60_000);

  it('the welcome whisper: once after the owner\'s first chat line, not after a reconnect', async () => {
    const b = bot!;
    const name = uniqueName('UxOwner');
    owner = await connectPlayer(name);
    // the whisper arrives as type `whisper` from the bot (BDS also sends a json `commands.message.display.outgoing` echo of it)
    owner.conn.on('text', (p) => {
      if (p.type === 'whisper' && (p.source_name ?? '').startsWith('CoreUx')) whispers.push(p.message);
    });
    await until(() => (b.built.mobility ? true : undefined), 5_000, 'mobility');
    await sleep(1500); // the bot saw the player join while not an owner yet: nothing
    expect(whispers).toEqual([]);
    expect(settings.get('lastWelcomed')).toBe('none');
    (b.chat.owners.names as string[]).push(name);
    const t0 = Date.now();
    owner.say('hello bot');
    await until(() => (whispers.length >= 4 ? true : undefined), 15_000, '4 welcome lines');
    const ms = Date.now() - t0;
    await sleep(1500);
    console.log(whispers.join('\n'));
    expect(whispers).toHaveLength(4);
    expect(whispers[0]).toBe(`BedrockBot ${welcomeVersion()} is here`);
    expect(whispers[3]).toBe('try !get wood, !come, !do <sentence>; !help for more');
    expect(settings.get('lastWelcomed')).toBe(welcomeVersion());
    owner.say('hello again');
    await sleep(2000);
    expect(whispers).toHaveLength(4);

    // the bot reconnects (a new connection, the same settings): no second welcome
    await b.stop();
    bot = await start();
    (bot.chat.owners.names as string[]).push(name);
    owner.say('are you back');
    await sleep(4000);
    expect(whispers).toHaveLength(4);
    expect(settings.get('lastWelcomed')).toBe(welcomeVersion());
    measurements.push(`welcome: 4 lines ${ms} ms after the owner's first chat line; none after more chat and a bot reconnect (lastWelcomed ${settings.get('lastWelcomed')})`);
  }, 120_000);

  it('!do what can you do: one answer line, nothing runs', async () => {
    const b = bot!;
    let n = b.said.length;
    await b.command('!do what can you do');
    const lines = await burst(b, n, 1500);
    console.log(lines.join('\n'));
    expect(lines).toEqual([(answer.steps[0] as { text: string }).text]);
    expect(b.processes.userProcesses()).toHaveLength(0);
    n = b.said.length;
    await b.command('!status');
    const st = await burst(b, n);
    expect(st[0]).toMatch(/behaviour idle/);
    expect(st[1]).toBe('processes: idle');
    measurements.push(`!do what can you do: "${lines[0]}"; !status: ${st[1]}`);
  }, 60_000);
});
