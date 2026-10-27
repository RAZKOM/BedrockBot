// PLAN.md 7.18 (Track Y): the plan schema accepts the existing commands only, with bounded arguments.
import { describe, expect, it } from 'vitest';
import { COMMAND_SPECS, parsePlan, planJsonSchema, planLine, PlanSchema, STEP_KINDS, stepCommand, type Plan } from '../../../src/nl/plan.ts';
import { buildSystemPrompt, buildUserMessage, EXAMPLES, helpByCommand } from '../../../src/nl/prompt.ts';
import { context } from './helpers.ts';

const ok = (v: unknown) => PlanSchema.safeParse(v).success;
const one = (s: Record<string, unknown>) => ({ steps: [s] });

describe('plan schema', () => {
  it('accepts every command with valid arguments', () => {
    const valid = [
      { command: 'goto', waypoint: 'home' },
      { command: 'goto_xyz', x: 10, y: -60, z: -3 },
      { command: 'come' },
      { command: 'come', player: 'Alex' },
      { command: 'follow' },
      { command: 'stop' },
      { command: 'guard', mode: 'off' },
      { command: 'guard', mode: 'on', radius: 64 },
      { command: 'kill', type: 'zombie', count: 64 },
      { command: 'gather', count: 1 },
      { command: 'mine', block: 'iron_ore', count: 256 },
      { command: 'farm', radius: 32 },
      { command: 'food' },
      { command: 'eat' },
      { command: 'equip' },
      { command: 'wp_set', name: 'base' },
      { command: 'wp_set', name: 'base', x: 1, y: 2, z: 3 },
      { command: 'wp_del', name: 'old-base' },
      { command: 'set', key: 'allowBreak', value: true },
      { command: 'set', key: 'guardRadius', value: '8' },
      { command: 'sleep' },
      { command: 'pause' },
      { command: 'resume' },
      { command: 'get', item: 'oak_log', count: 20 }, // Track AD
      { command: 'food', pen: true }, // Track AK
      { command: 'breed' }, // Track AK
      { command: 'breed', type: 'chicken', pairs: 8 },
      { command: 'panel' },
      { command: 'drop', what: 'all' },
      { command: 'drop', what: 'items' },
      { command: 'question', text: 'Which one?' },
    ];
    for (const s of valid) expect(ok(one(s)), JSON.stringify(s)).toBe(true);
    expect(new Set(valid.map((s) => s.command))).toEqual(new Set(STEP_KINDS));
  });

  it('rejects a made-up command and extra fields', () => {
    expect(ok(one({ command: 'fly', to: 'moon' }))).toBe(false);
    expect(ok(one({ command: 'op', player: 'Steve' }))).toBe(false);
    expect(ok(one({ command: 'tp', x: 1, y: 2, z: 3 }))).toBe(false);
    expect(ok(one({ command: 'stop', force: true }))).toBe(false);
    expect(ok({ steps: [{ command: 'stop' }], note: 'hi' })).toBe(false);
    expect(ok({ steps: [] })).toBe(false);
    expect(ok({ steps: Array.from({ length: 9 }, () => ({ command: 'stop' })) })).toBe(false);
    expect(parsePlan('stop please')).toEqual({ ok: false, error: 'the answer is not JSON' });
    const r = parsePlan('{"steps":[{"command":"fly"}]}');
    expect(r.ok).toBe(false);
  });

  it('rejects out-of-range and malformed arguments', () => {
    const bad = [
      { command: 'kill', type: 'zombie', count: 0 },
      { command: 'kill', type: 'zombie', count: 65 },
      { command: 'kill', type: 'zombie', count: 2.5 },
      { command: 'kill', type: 'player', count: 1 },
      { command: 'kill', type: '@a', count: 1 },
      { command: 'gather', count: 5000 },
      { command: 'mine', block: 'iron_ore', count: 257 },
      { command: 'mine', block: 'iron ore; /op me', count: 1 },
      { command: 'guard', mode: 'on', radius: 1 },
      { command: 'guard', mode: 'on', radius: 65 },
      { command: 'guard', mode: 'off', radius: 10 },
      { command: 'guard', mode: 'maybe' },
      { command: 'farm', radius: 33 },
      { command: 'goto', waypoint: 'Home Base' },
      { command: 'goto_xyz', x: 1, y: 999, z: 3 },
      { command: 'goto_xyz', x: 1, y: 2 },
      { command: 'wp_set', name: 'a', x: 1 },
      { command: 'come', player: 'two words' },
      { command: 'set', key: 'guardRadius', value: 500 },
      { command: 'set', key: 'allowBreak', value: 'perhaps' },
      { command: 'set', key: 'nlConfirm', value: false },
      { command: 'set', key: 'noSuchKey', value: 1 },
      { command: 'question', text: '' },
      { command: 'breed', type: 'zombie' }, // Track AK
      { command: 'breed', type: 'cow', pairs: 9 },
      { command: 'breed', pairs: 0 },
      { command: 'drop', what: 'diamond' },
      { command: 'drop' },
      { command: 'panel', open: true },
      { command: 'food', pen: 'yes' },
    ];
    for (const s of bad) expect(ok(one(s)), JSON.stringify(s)).toBe(false);
  });

  it('endless commands and questions only as the last step', () => {
    expect(ok({ steps: [{ command: 'follow' }, { command: 'stop' }] })).toBe(false);
    expect(ok({ steps: [{ command: 'farm' }, { command: 'eat' }] })).toBe(false);
    expect(ok({ steps: [{ command: 'question', text: 'x?' }, { command: 'stop' }] })).toBe(false);
    expect(ok({ steps: [{ command: 'goto', waypoint: 'farm' }, { command: 'farm' }] })).toBe(true);
  });

  it('formats the chat commands and the plan line', () => {
    const plan: Plan = {
      steps: [
        { command: 'goto', waypoint: 'home' },
        { command: 'guard', mode: 'on' },
        { command: 'set', key: 'allowBreak', value: false },
        { command: 'wp_set', name: 'x', x: 1, y: -60, z: 2 },
        { command: 'question', text: 'Then what?' },
      ],
    };
    expect(plan.steps.map(stepCommand)).toEqual(['goto home', 'guard on', 'set allowBreak off', 'wp set x 1 -60 2', 'Then what?']);
    expect(planLine(plan)).toBe('plan: goto home, then guard on, then set allowBreak off, then wp set x 1 -60 2, then ask "Then what?"');
  });

  it('Track AK: breed, panel, drop, food pen format as their chat commands', () => {
    const plan: Plan = {
      steps: [
        { command: 'food', pen: true },
        { command: 'food', pen: false },
        { command: 'breed' },
        { command: 'breed', type: 'pig' },
        { command: 'breed', type: 'cow', pairs: 3 },
        { command: 'breed', pairs: 2 },
        { command: 'drop', what: 'items' },
        { command: 'panel' },
      ],
    };
    expect(plan.steps.map(stepCommand)).toEqual(['food pen', 'food', 'breed', 'breed pig', 'breed cow 3', 'breed 2', 'drop items', 'panel']);
    expect(COMMAND_SPECS.breed.done!.test('breed: fed 1/1 cow pair, 1 baby so far')).toBe(true);
    expect(COMMAND_SPECS.breed.fail!.test('breed: fed 1/1 cow pair, 1 baby so far')).toBe(false);
    expect(COMMAND_SPECS.breed.fail!.test('breed: no two cows ready within 16 blocks')).toBe(true);
    expect(COMMAND_SPECS.drop.done!.test('dropped 12 items of 3 kinds')).toBe(true);
    expect(COMMAND_SPECS.drop.done!.test('drop: inventory empty')).toBe(true);
    expect(COMMAND_SPECS.drop.fail!.test('dropped 3 items of 1 kinds (stopped at dirt: timeout)')).toBe(true);
  });

  it('the JSON schema for the model is closed', () => {
    const s = planJsonSchema() as { properties: { steps: { items: { oneOf: { properties: { command: { const: string } }; additionalProperties: boolean }[] } } }; additionalProperties: boolean };
    expect(s.additionalProperties).toBe(false);
    const items = s.properties.steps.items.oneOf;
    expect(items.map((i) => i.properties.command.const).sort()).toEqual([...STEP_KINDS].sort());
    expect(items.every((i) => i.additionalProperties === false)).toBe(true);
  });
});

describe('prompt', () => {
  it('carries the state, the command reference and six valid examples', () => {
    const p = buildSystemPrompt({ ...context(), sender: 'Steve' });
    expect(p).toContain('status: pos 0.5 -60.0 0.5, task afk, behaviour idle');
    expect(p).toContain('waypoints: home, base, farm, mine');
    expect(p).toContain('inventory: inv 3/36');
    expect(p).toContain('settings: guardRadius 16');
    expect(p).toContain('[chat: !goto <waypoint> | x y z (walk)]');
    expect(p).toContain('!sleep (not available on this bot)');
    expect(EXAMPLES).toHaveLength(10); // Track AD: + get; Track AK: + breed, drop, food pen
    for (const e of EXAMPLES) {
      expect(PlanSchema.safeParse(e.plan).success).toBe(true);
      expect(p).toContain(JSON.stringify(e.plan));
    }
    expect(buildUserMessage('Steve', 'go\nhome ')).toBe('request from Steve: go home');
  });

  it('splits the chat help into commands', () => {
    const m = helpByCommand('!guard [status] | on | off | <radius> (fight) | !wp [list] | set <name> | !stop (stop)');
    expect([...m.keys()]).toEqual(['guard', 'wp', 'stop']);
    expect(m.get('guard')).toBe('!guard [status] | on | off | <radius> (fight)');
  });
});
