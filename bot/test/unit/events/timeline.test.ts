// Track P5: the away timeline's grouping and summary (events/timeline.ts; ADR 0116, docs/away.md "The timeline").
import { describe, expect, it } from 'vitest';
import { EVENT_KINDS, type BotEvent, type EventData, type EventKind } from '../../../src/events/registry.ts';
import { awayLine, buildTimeline, GROUPS_MAX, HEAD_MAX, hourStart } from '../../../src/events/timeline.ts';

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 20, 9, 0, 0); // a whole hour
const at = { x: 1, y: 64, z: 2 };

function events() {
  const list: BotEvent[] = [];
  let id = 100;
  const add = <K extends EventKind>(ms: number, kind: K, data: EventData<K>): void => {
    list.push({ id: id++, ts: T0 + ms, kind, sev: EVENT_KINDS[kind].severity, data });
  };
  return { list, add };
}

describe('the timeline', () => {
  it('groups by queued job with the time between by hour, newest first; the summary counts the window', () => {
    const { list, add } = events();
    add(60_000, 'connection.connected', { server: 's', version: '1.26.60' });
    add(120_000, 'items.changed', { gained: { oak_log: 4 }, lost: {}, jobs: [], periodS: 60 });
    add(10 * 60_000, 'queue.started', { id: 1, command: '!goto 1 2 3', by: 'Steve' });
    add(10 * 60_000 + 50, 'job.started', { job: 'goto', kind: 'user', line: 'goto 1 2 3', by: 'Steve' });
    add(11 * 60_000, 'job.finished', { job: 'goto', result: 'arrived', durationS: 60 });
    add(11 * 60_000 + 10, 'queue.finished', { id: 1, command: '!goto 1 2 3', state: 'done', end: 'arrived at 1 2 3', durationS: 60 });
    add(12 * 60_000, 'queue.started', { id: 2, command: '!get kit iron', by: 'Steve' });
    add(13 * 60_000, 'combat.fight', { mob: 'zombie', outcome: 'killed', ticks: 80, attacks: 5, landed: 4, damageTaken: 3, kills: 1 });
    add(13 * 60_000 + 1, 'combat.kill', { mob: 'zombie' });
    add(13 * 60_000 + 2, 'combat.damage', { hits: 2, damage: 3.5, by: { zombie: 3.5 }, periodS: 60 });
    add(14 * 60_000, 'life.died', { n: 1, cause: 'death.attack.zombie', at });
    add(14 * 60_000 + 5, 'life.respawned', { at });
    add(15 * 60_000, 'queue.failed', { id: 2, command: '!get kit iron', end: 'get kit iron: the bot died', durationS: 180 });
    add(15 * 60_000 + 1, 'ask.asked', { id: 1, key: 'queue-fail', text: 'retry?', choices: ['retry', 'next', 'stop'], default: 'next', waitS: 120 });
    add(17 * 60_000, 'ask.answered', { id: 1, choice: 'next', how: 'timeout', afterS: 120 });
    add(70 * 60_000, 'connection.disconnected', { reason: 'timeout', kind: 'error', sessionS: 3600, retryInS: 5 });
    add(71 * 60_000, 'connection.reconnected', { server: 's', offlineS: 60 });
    add(72 * 60_000, 'job.started', { job: 'milk', kind: 'auto', line: 'milk', by: 'auto' });
    add(73 * 60_000, 'job.started', { job: 'goto', kind: 'user', line: 'goto', by: 'Steve' });
    add(74 * 60_000, 'job.failed', { job: 'goto', reason: 'unreachable', durationS: 60 });
    const t = buildTimeline(list, { since: T0, now: T0 + 2 * H, group: 'job' });
    expect(t.groups.map((g) => `${g.kind} ${g.title} ${g.state ?? ''}`.trim())).toEqual(['hour', 'hour', 'job #2 !get kit iron failed', 'job #1 !goto 1 2 3 done', 'hour']);
    const [h10, after, kit, walk, h9] = t.groups;
    expect(h9!.from).toBe(T0);
    expect(h9!.folded).toEqual({ n: 2, text: '1 connect, 1 item change' });
    expect(h9!.facts).toBe('+oak_log x4');
    expect(walk!.end).toBe('arrived at 1 2 3');
    expect(walk!.ids).toEqual([102, 105]);
    expect(kit!.head.map((l) => l.kind)).toEqual(['life.died', 'queue.failed']);
    expect(kit!.facts).toBe('1 fight, 1 kill, 3.5 damage');
    expect(kit!.end).toBe('get kit iron: the bot died');
    // the question after the job's end is the time between jobs (the 9:00 hour, after the job groups)
    expect(after!.from).toBe(T0);
    expect(after!.head.map((l) => l.kind)).toEqual(['ask.asked']);
    expect(h10!.from).toBe(T0 + H);
    expect(h10!.head.map((l) => l.kind)).toEqual(['connection.disconnected', 'connection.reconnected', 'job.failed']);
    expect(h10!.facts).toBe('chores: milk 1 · 1 command started');
    expect(t.counts).toMatchObject({ jobs: { done: 1, failed: 2, cancelled: 0 }, chores: 1, deaths: 1, reconnects: 1, disconnects: 1, fights: 1, kills: 1, damage: 3.5, questions: 1, unanswered: 1 });
    // the job inside the queued job is not counted twice; the plain goto outside one is (it failed)
    expect(t.line).toBe('1 job done, 2 failed, 1 death, 1 reconnect, 1 question (1 unanswered)');
  });

  it('groups by hour alone; the hour is the page\'s own (tz minutes east of UTC)', () => {
    const { list, add } = events();
    add(10 * 60_000, 'queue.started', { id: 1, command: '!goto 1 2 3', by: 'Steve' });
    add(50 * 60_000, 'life.died', { n: 1, cause: 'x', at });
    add(65 * 60_000, 'queue.failed', { id: 1, command: '!goto 1 2 3', end: 'died', durationS: 3300 });
    const t = buildTimeline(list, { since: T0, now: T0 + 2 * H, group: 'hour' });
    expect(t.groups.map((g) => g.from)).toEqual([T0 + H, T0]);
    expect(t.counts.jobs.failed).toBe(1);
    // UTC+5:30: 09:10 UTC is 14:40 there, its hour starts at 08:30 UTC
    expect(hourStart(T0 + 10 * 60_000, 330)).toBe(T0 - 30 * 60_000);
    const india = buildTimeline(list, { since: T0, now: T0 + 2 * H, group: 'hour', tzMin: 330 });
    expect(india.groups.map((g) => g.from)).toEqual([T0 + 30 * 60_000, T0 - 30 * 60_000]);
  });

  it('keeps the newest HEAD_MAX notable lines of a group and the newest GROUPS_MAX groups', () => {
    const { list, add } = events();
    for (let i = 0; i < HEAD_MAX + 3; i++) add(i * 1000, 'job.failed', { job: 'mine', reason: `r${i}`, durationS: 1 });
    for (let i = 0; i < GROUPS_MAX + 4; i++) add(H + i * H, 'life.respawned', { at });
    const t = buildTimeline(list, { since: T0, now: T0 + 60 * H });
    expect(t.groups.length).toBe(GROUPS_MAX);
    expect(t.olderGroups).toBe(5);
    const all = buildTimeline(list.slice(0, HEAD_MAX + 3), { since: T0, now: T0 + H });
    expect(all.groups[0]!.head.length).toBe(HEAD_MAX);
    expect(all.groups[0]!.moreHead).toBe(3);
    expect(all.groups[0]!.head[0]!.text).toMatch(/r3/);
  });

  it('a job still running at the window\'s end is `running`; an empty window says nothing happened', () => {
    const { list, add } = events();
    add(0, 'queue.started', { id: 9, command: '!get bed', by: 'Steve' });
    const t = buildTimeline(list, { since: T0, now: T0 + H, truncated: true });
    expect(t.groups[0]).toMatchObject({ kind: 'job', state: 'running', title: '#9 !get bed' });
    expect(t.truncated).toBe(true);
    expect(buildTimeline([], { since: T0, now: T0 + H }).line).toBe('0 jobs done, 0 failed, 0 deaths, 0 reconnects');
  });

  it('the summary line says the plurals right and leaves out what is zero beyond the four always said', () => {
    const c = { jobs: { done: 5, failed: 1, cancelled: 2 }, chores: 0, deaths: 0, reconnects: 1, disconnects: 1, kicks: 2, fights: 0, kills: 0, flees: 0, damage: 0, questions: 2, unanswered: 0 };
    expect(awayLine(c)).toBe('5 jobs done, 1 failed, 2 cancelled, 0 deaths, 1 reconnect, 2 kicks, 2 questions');
  });
});
