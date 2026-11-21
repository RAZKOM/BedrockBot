// Track REL2 on bds-core (docs/chat-style.md "The reply queue"): a real bot process (`--task afk --walk --no-config`,
// the owner a plain player connection) gets 5 commands typed within 1 s whose replies are more than the chat's 8
// messages in 10 s. Before the queue the replies past the limit were dropped (`chat rate limit, dropping: ...`, nothing
// in the game); now every command's reply arrives, oldest first, never more than 8 messages in 10 s on the wire, no kick.
// Env: core-truth.ts (CORE_BDS_*); QUEUE_OUT=<file> appends the measured line. Needs BDS_E2E=1 and bds-core.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MERGE_SEP } from '../../src/chat/chat.ts';
import { connectPlayer, E2E, sleep, startCli, uniqueName, until, type CoreCli } from './core-truth.ts';

/** The commands typed, and a pattern each one's first reply line matches. */
const BURST: [string, RegExp][] = [
  ['!help all', /^all commands \(\d+\): /],
  ['!help settings', /^settings: mode /],
  ['!status', /^status: up /],
  ['!pos', /^pos -?\d/],
  ['!help', /^front door: /],
];

describe.skipIf(!E2E)('core: the reply queue (Track REL2)', () => {
  const ownerName = uniqueName('QOwner');
  let cli: CoreCli | undefined;
  let owner: Awaited<ReturnType<typeof connectPlayer>> | undefined;

  beforeAll(async () => {
    owner = await connectPlayer(ownerName);
    cli = startCli(['--no-config', '--walk', '--owner', ownerName, '--nudge-interval', '0'], uniqueName('QueueBot'));
    await until(() => (cli!.output().includes(`spawned as ${cli!.name}`) ? true : undefined), 60_000, 'the bot spawned');
    await sleep(3_000); // the start-up lines, if any, out of the window
  }, 90_000);

  afterAll(async () => {
    cli?.kill();
    await cli?.exit;
    await owner?.close();
  }, 30_000);

  it('5 commands typed in 1 s: every reply arrives, in order, at most 8 messages in 10 s, no kick, nothing dropped', async () => {
    const from = cli!.name;
    const t0 = Date.now();
    const at: { t: number; m: string }[] = [];
    const mark = owner!.heard.length;
    owner!.conn.on('text', (p) => {
      if ((p.source_name ?? '').replace(/§./g, '') === from && p.type === 'chat') at.push({ t: Date.now() - t0, m: p.message.replace(/§./g, '') });
    });
    for (const [c] of BURST) {
      owner!.say(c);
      await sleep(200);
    }
    const typedMs = Date.now() - t0;
    // the last command's reply is the last to arrive
    const split = () => at.flatMap((x) => x.m.split(MERGE_SEP));
    await until(() => (split().some((l) => l.startsWith('front door: ')) ? true : undefined), 60_000, 'the last reply (!help)');
    await sleep(2_000);
    const lines = split();
    const firstIndex = BURST.map(([, re]) => lines.findIndex((l) => re.test(l)));
    let busiest = 0;
    for (const a of at) busiest = Math.max(busiest, at.filter((b) => b.t >= a.t && b.t < a.t + 9_500).length);
    const out = cli!.output();
    const line = `chat-queue: typed 5 in ${typedMs} ms; ${at.length} messages (${lines.length} lines) in ${at.at(-1)!.t} ms; first lines at ${firstIndex.join(', ')}; busiest 9.5 s window ${busiest}; waited ${(out.match(/waiting for a slot/g) ?? []).length}, dropped ${(out.match(/dropping/g) ?? []).length}; bot ${cli!.child.exitCode === null ? 'online' : `exited ${cli!.child.exitCode}`}, owner ${owner!.conn.state}`;
    console.log(line);
    if (process.env.QUEUE_OUT) appendFileSync(process.env.QUEUE_OUT, `${new Date().toISOString()} ${line}\n`);
    expect(owner!.heard.length).toBeGreaterThan(mark);
    for (const [i, [c]] of BURST.entries()) expect([c, firstIndex[i]! >= 0]).toEqual([c, true]);
    expect([...firstIndex].sort((a, b) => a - b)).toEqual(firstIndex); // oldest first
    expect(out).toMatch(/chat rate limit, waiting for a slot/); // the burst was past the limit: the queue was used
    expect(busiest).toBeLessThanOrEqual(8);
    expect(out).not.toMatch(/dropping/);
    expect(out).not.toMatch(/kicked/i);
    expect(cli!.child.exitCode).toBeNull();
    expect(owner!.conn.state).toBe('spawned');
  }, 120_000);
});
