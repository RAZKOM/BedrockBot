import { afterEach, describe, expect, it } from 'vitest';
import { ActionExecutor } from '../../../src/bridge/actions.ts';
import { BridgeServer } from '../../../src/bridge/server.ts';
import { RlSession, type ResetRequest } from '../../../src/bridge/session.ts';
import { ObsMsg, type Outbound } from '../../../src/bridge/schema.ts';
import { FrameDecoder, encodeFrame } from '../../../src/bridge/ws.ts';
import { FakeLoop, FakeSkills, FakeWorld } from './fakes.ts';

/** Asymmetric matchers typed for object literals (they are `any` otherwise). */
const has = (s: string): string => {
  const m: unknown = expect.stringContaining(s);
  return m as string;
};
const hasAll = (xs: string[]): string[] => {
  const m: unknown = expect.arrayContaining(xs);
  return m as string[];
};

function setup(limits?: { maxSteps?: number; targetLogs?: number }) {
  const world = new FakeWorld();
  const loop = new FakeLoop();
  const skills = new FakeSkills(loop, world);
  const ex = new ActionExecutor({ world, loop, skills });
  let deaths = 0;
  let released = 0;
  const resets: ResetRequest[] = [];
  const session = new RlSession(
    {
      world,
      loop,
      run: (a) => ex.run(a),
      reset: (req) => {
        resets.push(req);
        world.inventory.slots.fill(null);
        world.give(0, 'stone_axe', 1);
        loop.state.pos = { x: 0.5, y: -60, z: 0.5 };
        world.set(0, -59, 2, 'oak_log');
        return Promise.resolve({ checksum: 'abcd1234', seed: req.seed });
      },
      deaths: () => deaths,
      release: () => {
        released++;
      },
    },
    { limits: limits ?? {}, botName: 'T' },
  );
  return { world, loop, skills, session, resets, kill: () => deaths++, released: () => released };
}

const obsOf = (m: Outbound) => {
  const r = ObsMsg.safeParse(m);
  if (!r.success) throw new Error(`not an obs: ${JSON.stringify(m).slice(0, 300)}`);
  return r.data;
};

describe('RlSession', () => {
  it('step before reset is an error; reset gives a valid obs with the reset info', async () => {
    const { session, resets } = setup();
    expect(await session.handle({ t: 'step', id: 1, action: { kind: 'noop' } })).toMatchObject({ t: 'error', id: 1, message: has('reset') });
    const r = obsOf(await session.handle({ t: 'reset', id: 2, scenario: 'forest_small', seed: 7, options: { origin: [100, 200] } }));
    expect(resets).toEqual([{ scenario: 'forest_small', seed: 7, origin: [100, 200] }]);
    expect(r).toMatchObject({ id: 2, done: false, reward_signals: { logs_delta: 0, ticks_used: 0 }, info: { reset: { checksum: 'abcd1234' } } });
    expect(r.obs.inventory).toEqual({ stone_axe: 1 });
  });

  it('logs entering the inventory pay once; target logs terminate', async () => {
    const { session, world } = setup({ targetLogs: 3 });
    await session.handle({ t: 'reset', id: 1, scenario: 'forest_small', seed: 0 });
    const a = obsOf(await session.handle({ t: 'step', id: 2, action: { kind: 'dig_facing' } }));
    expect(a.obs.last_skill).toMatchObject({ ok: true, action: 'dig_facing_block' });
    expect(a.reward_signals).toMatchObject({ logs_delta: 0, ticks_used: 15 });
    world.give(1, 'oak_log', 2);
    const b = obsOf(await session.handle({ t: 'step', id: 3, action: { kind: 'collect' } }));
    expect(b.reward_signals.logs_delta).toBe(2);
    world.give(1, 'oak_log', 1); // lost one ...
    expect(obsOf(await session.handle({ t: 'step', id: 4, action: { kind: 'noop' } })).reward_signals.logs_delta).toBe(0);
    world.give(1, 'oak_log', 2); // ... and picked it up again: no pay
    expect(obsOf(await session.handle({ t: 'step', id: 5, action: { kind: 'noop' } })).reward_signals.logs_delta).toBe(0);
    world.give(2, 'birch_log', 1);
    const c = obsOf(await session.handle({ t: 'step', id: 6, action: { kind: 'noop' } }));
    expect(c).toMatchObject({ done: true, terminated: true, truncated: false, reward_signals: { logs_delta: 1 }, info: { reason: 'logs', logs: 3 } });
    expect(await session.handle({ t: 'step', id: 7, action: { kind: 'noop' } })).toMatchObject({ t: 'error', message: has('done') });
  });

  it('a death before the step does not end it; steps truncate; close releases', async () => {
    const s1 = setup();
    await s1.session.handle({ t: 'reset', id: 1, scenario: 'forest_small', seed: 0 });
    s1.kill();
    // the death happened before this step (counted at the previous one)
    const run = s1.session.handle({ t: 'step', id: 2, action: { kind: 'noop' } });
    expect(obsOf(await run)).toMatchObject({ done: false });
    const s2 = setup({ maxSteps: 2 });
    await s2.session.handle({ t: 'reset', id: 1, scenario: 'forest_small', seed: 0 });
    await s2.session.handle({ t: 'step', id: 2, action: { kind: 'noop' } });
    expect(obsOf(await s2.session.handle({ t: 'step', id: 3, action: { kind: 'noop' } }))).toMatchObject({ truncated: true, info: { reason: 'steps' } });
    expect(await s2.session.handle({ t: 'close', id: 4 })).toEqual({ t: 'closed', id: 4 });
    expect(s2.released()).toBe(1);
  });

  it('reports a death that happens while the action runs', async () => {
    const world = new FakeWorld();
    const loop = new FakeLoop();
    let deaths = 0;
    const session = new RlSession({
      world,
      loop,
      run: async (a) => {
        await loop.waitTicks(3);
        deaths++;
        return { ok: false, reason: 'interrupted', action: a.kind, ticks: 3 };
      },
      reset: () => Promise.resolve({}),
      deaths: () => deaths,
      release: () => {},
    });
    await session.handle({ t: 'reset', id: 1, scenario: 'forest_small', seed: 0 });
    expect(obsOf(await session.handle({ t: 'step', id: 2, action: { kind: 'noop' } }))).toMatchObject({ done: true, terminated: true, reward_signals: { died: true }, info: { reason: 'died' } });
  });

  it('a failed reset is an error reply', async () => {
    const world = new FakeWorld();
    const session = new RlSession({ world, loop: new FakeLoop(), run: () => Promise.reject(new Error('x')), reset: () => Promise.reject(new Error('rl:reset failed: unloaded_chunk')), deaths: () => 0, release: () => {} });
    expect(await session.handle({ t: 'reset', id: 1, scenario: 'forest_small', seed: 0 })).toEqual({ t: 'error', id: 1, message: 'rl:reset failed: unloaded_chunk' });
  });
});

describe('BridgeServer over a real WebSocket', () => {
  let server: BridgeServer | undefined;
  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  function client(port: number) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const inbox: Outbound[] = [];
    const waiters: ((m: Outbound) => void)[] = [];
    ws.addEventListener('message', (e: MessageEvent) => {
      const m = JSON.parse(String(e.data)) as Outbound;
      const w = waiters.shift();
      if (w) w(m);
      else inbox.push(m);
    });
    const next = () => (inbox.length ? Promise.resolve(inbox.shift()!) : new Promise<Outbound>((r) => waiters.push(r)));
    const closed = new Promise<number>((r) => ws.addEventListener('close', (e: CloseEvent) => r(e.code)));
    const opened = new Promise<void>((r) => ws.addEventListener('open', () => r()));
    return { ws, next, closed, opened };
  }

  it('hello, reset, steps, bad message, busy, close', async () => {
    const { session } = setup();
    server = new BridgeServer({ port: 0, session });
    const port = await server.start();
    const c = client(port);
    await c.opened;
    expect(await c.next()).toMatchObject({ t: 'hello', protocol: 1, actions: hasAll(['noop', 'jump_forward']) });
    // a second client is refused while the first is connected
    const d = client(port);
    expect(await d.next()).toMatchObject({ t: 'error', message: has('busy') });
    expect(await d.closed).toBe(1013);
    c.ws.send(JSON.stringify({ t: 'reset', id: 1, seed: 3 }));
    expect(obsOf(await c.next()).id).toBe(1);
    // pipelined requests are answered in order
    for (let i = 2; i <= 6; i++) c.ws.send(JSON.stringify({ t: 'step', id: i, action: { kind: i % 2 ? 'turn_left' : 'noop' } }));
    for (let i = 2; i <= 6; i++) expect((await c.next()) as { id: number }).toMatchObject({ t: 'obs', id: i });
    c.ws.send('{"t":"step","id":7,"action":{"kind":"teleport"}}');
    expect(await c.next()).toMatchObject({ t: 'error', id: 7 });
    // a large frame (16-bit length) round-trips
    c.ws.send(JSON.stringify({ t: 'step', id: 8, action: { kind: 'noop', pad: 'x'.repeat(70_000) } }));
    expect(await c.next()).toMatchObject({ t: 'obs', id: 8 });
    c.ws.send(JSON.stringify({ t: 'close', id: 9 }));
    expect(await c.next()).toEqual({ t: 'closed', id: 9 });
    expect(await c.closed).toBe(1000);
    // the slot is free again
    const e = client(port);
    expect(await e.next()).toMatchObject({ t: 'hello' });
    e.ws.close();
    await e.closed;
  });
});

describe('ws frames', () => {
  it('decodes masked, fragmented input and encodes 7/16/64-bit lengths', () => {
    const mask = Buffer.from([1, 2, 3, 4]);
    const frame = (fin: boolean, op: number, text: string) => {
      const p = Buffer.from(text);
      const m = Buffer.from(p.map((b, i) => b ^ mask[i & 3]!));
      return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | op, 0x80 | p.length]), mask, m]);
    };
    const d = new FrameDecoder();
    const all = Buffer.concat([frame(false, 1, 'hel'), frame(true, 0, 'lo')]);
    const out = [...d.push(all.subarray(0, 5)), ...d.push(all.subarray(5))];
    expect(out.map((f) => [f.fin, f.opcode, f.payload.toString()])).toEqual([
      [false, 1, 'hel'],
      [true, 0, 'lo'],
    ]);
    expect(() => new FrameDecoder().push(Buffer.from([0x81, 0x01, 0x61]))).toThrow(/masked/);
    expect(encodeFrame(1, Buffer.alloc(10))[1]).toBe(10);
    expect(encodeFrame(1, Buffer.alloc(300))[1]).toBe(126);
    expect(encodeFrame(1, Buffer.alloc(70_000))[1]).toBe(127);
  });
});
