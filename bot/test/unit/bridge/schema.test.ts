import { describe, expect, it } from 'vitest';
import { ACTIONS_V1, GRID_SIZE, ObsMsg, OutboundSchema, normaliseAction, parseInbound } from '../../../src/bridge/schema.ts';

/** Asymmetric matchers typed for object literals (they are `any` otherwise). */
const has = (s: string): string => {
  const m: unknown = expect.stringContaining(s);
  return m as string;
};

describe('bridge schema: inbound', () => {
  it('parses the PLAN 4.5 examples', () => {
    const r = parseInbound('{ "t": "reset", "id": 1, "scenario": "forest_small", "seed": 7 }');
    expect(r).toEqual({ ok: true, msg: { t: 'reset', id: 1, scenario: 'forest_small', seed: 7 } });
    const s = parseInbound('{ "t": "step", "id": 2, "action": { "kind": "goto_nearest", "block": "oak_log" } }');
    expect(s.ok).toBe(true);
    if (s.ok && s.msg.t === 'step') expect(normaliseAction(s.msg.action)).toEqual({ kind: 'goto_nearest_log', block: 'oak_log' });
    for (const [k, v] of [
      ['dig_facing', 'dig_facing_block'],
      ['collect', 'collect_drops'],
      ['noop', 'noop'],
    ]) {
      const m = parseInbound(JSON.stringify({ t: 'step', id: 3, action: { kind: k } }));
      expect(m.ok && m.msg.t === 'step' && normaliseAction(m.msg.action).kind).toBe(v);
    }
    expect(parseInbound('{ "t": "close", "id": 3 }')).toEqual({ ok: true, msg: { t: 'close', id: 3 } });
  });

  it('accepts every v1 action name and fills reset defaults', () => {
    for (const k of ACTIONS_V1) expect(parseInbound(JSON.stringify({ t: 'step', id: 1, action: { kind: k } })).ok).toBe(true);
    const r = parseInbound('{"t":"reset","id":4}');
    expect(r.ok && r.msg).toEqual({ t: 'reset', id: 4, scenario: 'forest_small', seed: 0 });
    const o = parseInbound('{"t":"reset","id":5,"seed":2,"options":{"origin":[1000,-64],"tool":"iron_axe"}}');
    expect(o.ok && o.msg.t === 'reset' && o.msg.options).toEqual({ origin: [1000, -64], tool: 'iron_axe' });
  });

  it('rejects bad messages with the id when there is one', () => {
    expect(parseInbound('nope')).toMatchObject({ ok: false, id: null });
    expect(parseInbound('{"t":"step","id":9,"action":{"kind":"fly"}}')).toMatchObject({ ok: false, id: 9, message: has('unknown action kind') });
    expect(parseInbound('{"t":"step","id":9}')).toMatchObject({ ok: false, id: 9 });
    expect(parseInbound('{"t":"reset","id":1,"scenario":"x; kill @a"}')).toMatchObject({ ok: false });
    expect(parseInbound('{"t":"reset","id":1,"options":{"tool":"axe kill"}}')).toMatchObject({ ok: false });
    expect(parseInbound('{"t":"reset","id":-1}')).toMatchObject({ ok: false, id: null });
    expect(parseInbound('{"t":"teleport","id":1}')).toMatchObject({ ok: false, id: 1 });
  });
});

describe('bridge schema: outbound', () => {
  const obs = {
    t: 'obs',
    id: 2,
    tick: 12345,
    obs: {
      grid: new Array<number>(GRID_SIZE).fill(0),
      self: { pos: [0.5, -60, 1.7], yaw: 0, pitch: 0, health: 20, food: 16, on_ground: true },
      inventory: { oak_log: 3, oak_sapling: 1 },
      nearest_log: { dx: 3, dy: 1, dz: -2, dist: 3.7, in_reach: true },
      last_skill: { ok: true },
    },
    reward_signals: { logs_delta: 1, died: false, ticks_used: 35, log_in_reach: true },
    done: false,
    terminated: false,
    truncated: false,
    info: { corrections: 0 },
  };

  it('accepts a PLAN 4.5 observation (plus the additive fields)', () => {
    expect(ObsMsg.safeParse(obs).success).toBe(true);
    expect(OutboundSchema.safeParse({ ...obs, obs: { ...obs.obs, nearest_log: null } }).success).toBe(true);
    expect(OutboundSchema.safeParse({ t: 'error', id: 2, message: 'unreachable' }).success).toBe(true);
    expect(OutboundSchema.safeParse({ t: 'closed', id: 3 }).success).toBe(true);
  });

  it('rejects wrong grid size, classes out of range and negative counts', () => {
    expect(ObsMsg.safeParse({ ...obs, obs: { ...obs.obs, grid: [0] } }).success).toBe(false);
    expect(ObsMsg.safeParse({ ...obs, obs: { ...obs.obs, grid: new Array<number>(GRID_SIZE).fill(9) } }).success).toBe(false);
    expect(ObsMsg.safeParse({ ...obs, obs: { ...obs.obs, inventory: { oak_log: -1 } } }).success).toBe(false);
    expect(ObsMsg.safeParse({ ...obs, reward_signals: { ...obs.reward_signals, logs_delta: -1 } }).success).toBe(false);
  });
});
