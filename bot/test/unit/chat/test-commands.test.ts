// Track T1 (ADR 0075): `!test` on the real afk registry (chat/commands-test.ts): the arguments, the kit sources, the files,
// and the guard: with testMode off nothing is sent and the respawn is not claimed.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MAX_RUNS, parseTestArgs, recordFileName, resolveKit, testControlOf, testsDirOf } from '../../../src/chat/commands-test.ts';
import { settingGroups } from '../../../src/chat/help.ts';
import type { ChatLine } from '../../../src/chat/text.ts';
import type { Vec3 } from '../../../src/connection/types.ts';
import { respawnClaimed } from '../../../src/skills/test/recovery.ts';
import { afkChat } from './afk-chat.ts';

const WP: Record<string, Vec3> = { cave_start: { x: 10, y: 40, z: 10 }, cave_end: { x: 90, y: 30, z: 12 }, r1_start: { x: 1, y: 2, z: 3 }, r1_end: { x: 4, y: 5, z: 6 }, base: { x: 7, y: 64, z: 8 } };
const point = (w: readonly string[]): Vec3 | string => {
  if (w.length === 3) return w.every((x) => Number.isFinite(Number(x))) ? { x: Number(w[0]), y: Number(w[1]), z: Number(w[2]) } : 'bad';
  return w.length === 1 && WP[w[0]!] ? WP[w[0]!]! : `test: no waypoint "${w.join(' ')}" (!wp list)`;
};
const here = () => ({ x: 0.7, y: 64, z: -3.2 });

describe('parseTestArgs', () => {
  it('cave and cavestart', () => {
    expect(parseTestArgs(['cave', '3'], point, here)).toEqual({ spec: { kind: 'cave', name: 'cave', start: WP.cave_start, goal: WP.cave_end, command: 'fly cave_end' }, runs: 3 });
    expect(parseTestArgs(['cavestart'], point, here)).toMatchObject({ spec: { kind: 'cavestart', start: here(), goal: WP.cave_start, command: 'fly cave_start' }, runs: 1 });
    expect(parseTestArgs(['cavestart', '2', 'from', 'base'], point, here)).toMatchObject({ spec: { start: WP.base }, runs: 2 });
    expect(parseTestArgs(['cavestart', 'from', '1', '2', '3'], point, here)).toMatchObject({ spec: { start: { x: 1, y: 2, z: 3 } }, runs: 1 });
    expect(parseTestArgs(['cave', String(MAX_RUNS + 1)], point, here)).toEqual({ error: `test: runs must be 1..${MAX_RUNS}` });
  });
  it('route and goto', () => {
    expect(parseTestArgs(['route', 'r1', '5', 'noshortcut'], point, here)).toEqual({ spec: { kind: 'route', name: 'route r1', start: WP.r1_start, goal: WP.r1_end, command: 'fly route r1 noshortcut' }, runs: 5 });
    expect(parseTestArgs(['route', 'zz'], point, here)).toEqual({ error: 'test: no waypoint "zz_start" (!wp list)' });
    expect(parseTestArgs(['goto', 'base', 'from', '0', '64', '0', '3'], point, here)).toEqual({ spec: { kind: 'goto', name: 'goto base', start: { x: 0, y: 64, z: 0 }, goal: WP.base, command: 'goto base' }, runs: 3 });
    expect(parseTestArgs(['goto', '5', '64', '5', 'from', 'base'], point, here)).toMatchObject({ spec: { command: 'goto 5 64 5', start: WP.base }, runs: 1 });
    expect(parseTestArgs(['goto', '5', '64', '5', 'from', 'base', '2'], point, here)).toMatchObject({ runs: 2 });
    expect(JSON.stringify(parseTestArgs(['goto', 'base'], point, here))).toMatch(/^\{"error":"usage: !test goto/);
    expect(JSON.stringify(parseTestArgs(['fly'], point, here))).toMatch(/^\{"error":"usage: !test/);
  });
});

describe('kit sources and files', () => {
  const dir = mkdtempSync(join(tmpdir(), 't1-kit-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it('start = the snapshot, file = tests/kit.json, else the list', () => {
    const snap = [{ item: 'elytra', count: 1 }];
    expect(resolveKit('start', () => snap, dir)).toEqual({ kit: snap, from: 'start' });
    expect(resolveKit('elytra, firework_rocket 64', () => snap, undefined)).toEqual({ kit: [{ item: 'elytra', count: 1 }, { item: 'firework_rocket', count: 64 }], from: 'testKit' });
    expect(() => resolveKit('file', () => snap, dir)).toThrow(/no kit\.json/);
    writeFileSync(join(dir, 'kit.json'), JSON.stringify(['diamond_chestplate @chest', 'cooked_beef 32']));
    expect(resolveKit('file', () => snap, dir).kit).toEqual([{ item: 'diamond_chestplate', count: 1, slot: 'chest' }, { item: 'cooked_beef', count: 32 }]);
    expect(() => resolveKit('file', () => snap, undefined)).toThrow(/no tests folder/);
  });
  it('the tests folder sits next to settings.json; one file per series', () => {
    expect(testsDirOf(join('home', '.bedrockbot', 'settings.json'), undefined, undefined)).toBe(join('home', '.bedrockbot', 'tests'));
    expect(testsDirOf(undefined, undefined, undefined)).toBeUndefined();
    expect(testsDirOf(undefined, undefined, 'x')).toBe('x');
    expect(recordFileName('route r1', new Date(2026, 10, 8, 21, 5, 9))).toBe('20261108-210509-route-r1.jsonl');
    expect(recordFileName('goto 1 -60 2', new Date(2026, 0, 2, 3, 4, 5))).toBe('20260102-030405-goto-1-60-2.jsonl');
  });
});

describe('!test on the afk registry', () => {
  const consoleLine = (body: string): ChatLine => ({ type: 'announcement', source: 'Server', message: `[Server] ${body}`, body, xuid: '', truth: false });
  const setup = () => {
    const a = afkChat();
    const said: string[] = [];
    const say = a.chat.say.bind(a.chat);
    a.chat.say = (m: string) => {
      said.push(m);
      return say(m);
    };
    return { ...a, said };
  };

  it('is registered with the settings group `test`', () => {
    const { chat } = setup();
    expect(chat.has('test')).toBe(true);
    expect(settingGroups().find(([g]) => g === 'test')?.[1]).toEqual(['testMode', 'testKit']);
  });

  it('testMode off (the default): runs refused, no command sent, the respawn not claimed', () => {
    const { chat, task, said, settings } = setup();
    expect(settings.get('testMode')).toBe(false);
    for (const c of ['!test cave 3', '!test goto base from 0 64 0 3', '!test route r1', '!test cavestart']) chat.handle(consoleLine(c));
    expect(said.every((m) => m.startsWith('test: testMode is off'))).toBe(true);
    expect(said).toHaveLength(4);
    chat.handle(consoleLine('!test'));
    expect(said[4]).toMatch(/^test: testMode off; op: not probed yet/);
    const ctl = testControlOf(task)!;
    expect(ctl.runner.counts).toEqual({ sent: 0, ok: 0, refused: 0, errors: 0 });
    expect(respawnClaimed(task)).toBe(false);
    expect(ctl.current()).toBeUndefined();
  });

  it('testMode on, not spawned: the probe cannot run, so nothing starts', async () => {
    const { chat, task, said, settings } = setup();
    settings.set('testMode', 'on');
    chat.handle(consoleLine('!test goto 5 64 5 from 0 64 0 2'));
    await new Promise((r) => setTimeout(r, 20));
    expect(said[0]).toMatch(/^test: the test harness needs cheats on and the bot op'd/);
    expect(testControlOf(task)!.current()).toBeUndefined();
    expect(respawnClaimed(task)).toBe(false); // claimed only while a series runs
  });
});
