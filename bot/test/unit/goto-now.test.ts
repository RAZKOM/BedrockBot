// Wave 9, Track AK (decision 0031): `!goto <waypoint> | x y z now` is urgent like `!come now`: the walk
// gets `urgent`, the goto process is marked so the night process yields to it; a lone `!goto now` is
// still the waypoint called "now".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Chat, parseOwners } from '../../src/chat/chat.ts';
import { markUrgent, registerNavChat } from '../../src/chat/commands-nav.ts';
import type { TextPacket } from '../../src/connection/types.ts';
import { silentLogger } from '../../src/log.ts';
import type { NavGoal } from '../../src/skills/nav/goals.ts';
import { WaypointStore } from '../../src/waypoints/store.ts';
import { connectAndSpawn, setup, type FakeClient } from './connection-fakes.ts';

const consoleSay = (msg: string): TextPacket => ({ needs_translation: false, category: 'authored', type: 'announcement', source_name: 'Server', message: `[Server] ${msg}`, xuid: '' });

describe('!goto ... now (Track AK)', () => {
  let client: FakeClient;
  let walks: { goal: NavGoal; label: string; urgent: boolean }[];
  let store: WaypointStore;

  beforeEach(async () => {
    vi.useFakeTimers();
    const { conn, clients } = setup({ username: 'Bot' });
    const chat = new Chat(conn, { owners: parseOwners([]), log: silentLogger, maxReplies: 100 });
    walks = [];
    store = new WaypointStore();
    registerNavChat(chat, {
      store,
      position: () => ({ x: 1.5, y: -60, z: 2.5 }),
      walk: (goal, _opts, label, o) => {
        walks.push({ goal, label, urgent: o?.urgent === true });
        return Promise.resolve({ ok: true });
      },
    });
    chat.start();
    client = await connectAndSpawn(conn, clients);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function say(msg: string): Promise<string[]> {
    client.sent = [];
    client.receive('text', consoleSay(msg));
    await vi.advanceTimersByTimeAsync(60);
    return client.sentOf('text').map((p) => String(p.message));
  }

  it('a trailing now makes the walk urgent; without it the walk is not', async () => {
    store.set('base', { x: 10, y: -60, z: 20 });
    expect(await say('!goto base now')).toEqual(['walking to base (10 -60 20) now', 'arrived at base (10 -60 20)']);
    expect(walks[0]).toEqual({ goal: { type: 'block', p: { x: 10, y: -60, z: 20 } }, label: 'walking to base (10 -60 20)', urgent: true });
    expect(await say('!goto 1 -60 2 NOW')).toEqual(['walking to 1 -60 2 now', 'arrived at 1 -60 2']);
    expect(walks[1]).toMatchObject({ goal: { type: 'block', p: { x: 1, y: -60, z: 2 } }, urgent: true });
    expect(await say('!goto base')).toEqual(['walking to base (10 -60 20)', 'arrived at base (10 -60 20)']);
    expect(walks[2]!.urgent).toBe(false);
  });

  it('a lone !goto now is the waypoint "now"; a bad argument list still gets the usage', async () => {
    store.set('now', { x: 5, y: -60, z: 5 });
    expect(await say('!goto now')).toEqual(['walking to now (5 -60 5)', 'arrived at now (5 -60 5)']);
    expect(walks[0]!.urgent).toBe(false);
    expect(await say('!goto 1 2 now')).toEqual(['usage: !goto <waypoint> | x y z']);
  });

  it('markUrgent sets the flag the night process yields to', () => {
    const p: { name: string; urgent?: boolean } = { name: 'goto' };
    expect(markUrgent(p)).toBe(true);
    expect(p.urgent).toBe(true);
    expect(markUrgent(undefined)).toBe(false);
  });
});
