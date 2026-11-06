// Guards of the event registry (decision 0059, docs/events.md): the guide's table is the registry's,
// every kind is well formed, has a sample that validates and formats, and is emitted somewhere; every
// emit in the source names a registered kind; an unknown kind or a wrong payload does not compile.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus, RATE_PER_MIN } from '../../../src/events/bus.ts';
import { CATEGORIES, checkPayload, EVENT_KIND_NAMES, EVENT_KINDS, eventTable, formatEvent, isEventKind, SEVERITIES, type EventData, type EventKind } from '../../../src/events/registry.ts';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const SRC = join(ROOT, 'bot', 'src');
const at = { x: 100, y: 64, z: -50 };

/** One valid payload per kind (a new kind without a sample does not compile). */
export const SAMPLES: { [K in EventKind]: EventData<K> } = {
  'connection.connected': { server: '127.0.0.1:19132', version: '1.26.60' },
  'connection.reconnected': { server: '127.0.0.1:19132', offlineS: 42 },
  'connection.disconnected': { reason: 'timeout', kind: 'error', sessionS: 3600, retryInS: 5 },
  'connection.kicked': { reason: 'kicked', message: 'You were kicked', willReconnect: true },
  'connection.lost': { reason: 'outdated_client', kind: 'version' },
  'life.died': { n: 1, cause: 'death.attack.zombie', messages: ['Bot', 'Zombie'], at },
  'life.respawned': { at },
  'combat.fight': { mob: 'zombie', outcome: 'killed', ticks: 80, attacks: 5, landed: 4, damageTaken: 3, kills: 1 },
  'combat.kill': { mob: 'zombie' },
  'combat.flee': { why: 'low', from: 'skeleton', health: 6.5 },
  'combat.damage': { hits: 3, damage: 7.5, by: { zombie: 7.5 }, periodS: 60 },
  'job.started': { job: 'kill', kind: 'user', line: 'kill zombie 0/1', by: 'console' },
  'job.finished': { job: 'kill', result: 'done (killed 1, want 1)', durationS: 4.2 },
  'job.failed': { job: 'mine', reason: 'no_pickaxe', durationS: 185 },
  'job.stopped': { job: 'goto', reason: 'stopped', durationS: 12, by: 'Steve' },
  'items.changed': { gained: { cobblestone: 32 }, lost: { torch: 4 }, jobs: ['mine'], periodS: 60 },
  'container.deposit': { at, block: 'chest', items: { cobblestone: 64 } },
  'container.withdraw': { at, items: { bread: 16 } },
  'home.arrived': { durationS: 20 },
  'resource.low': { resource: 'food', left: 0, detail: 'no food carried' },
  'command.received': { command: 'kill', text: '!kill zombie', source: 'panel', sender: 'console' },
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (f.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('event registry (decision 0059)', () => {
  it('docs/events.md carries the generated table', () => {
    const doc = readFileSync(join(ROOT, 'docs', 'events.md'), 'utf8').replace(/\r\n/g, '\n');
    const m = /<!-- events:kinds -->\n([\s\S]*?)\n<!-- \/events:kinds -->/.exec(doc);
    expect(m, 'docs/events.md needs the <!-- events:kinds --> markers').not.toBeNull();
    if (m![1] !== eventTable()) console.log(`paste this between the events:kinds markers of docs/events.md:\n${eventTable()}`);
    expect(m![1]).toBe(eventTable());
  });

  it('every kind: category = the part before the dot, a known severity, a doc line', () => {
    for (const k of EVENT_KIND_NAMES) {
      const d = EVENT_KINDS[k];
      expect(k).toMatch(/^[a-z]+\.[a-z]+$/);
      expect(k.split('.')[0], k).toBe(d.category);
      expect(CATEGORIES).toContain(d.category);
      expect(SEVERITIES).toContain(d.severity);
      expect(d.doc.length, k).toBeGreaterThan(10);
    }
  });

  it('every sample validates against its schema and formats to one line; a broken one does not', () => {
    for (const k of EVENT_KIND_NAMES) {
      expect(checkPayload(k, SAMPLES[k]), k).toBeUndefined();
      const line = formatEvent({ kind: k, data: SAMPLES[k] });
      expect(line.length, k).toBeGreaterThan(3);
      expect(line).not.toContain('\n');
      expect(line).not.toContain('undefined');
      expect(checkPayload(k, { ...SAMPLES[k], [Object.keys(SAMPLES[k])[0]!]: Symbol('bad') }), k).toBeDefined();
    }
    expect(checkPayload('job.started', { job: 'x', kind: 'other', line: '' })).toMatch(/kind/);
    expect(formatEvent({ kind: 'gone.kind', data: {} })).toBe('gone.kind'); // an old line of a removed kind
  });

  it('every registered kind is emitted somewhere in the source, and every emit names a registered kind', () => {
    const files = sourceFiles(SRC).filter((f) => !f.endsWith(join('events', 'registry.ts')));
    const text = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    const emitted = [...text.matchAll(/\.emit\('([a-z]+\.[a-z]+)'/g)].map((m) => m[1]!);
    for (const k of EVENT_KIND_NAMES) expect(emitted.includes(k), `${k} is registered but nothing emits it`).toBe(true);
    for (const k of emitted) expect(isEventKind(k), `emit of unregistered kind ${k}`).toBe(true);
  });

  it('nothing in skills/fly emits (flight is recorded at the process level)', () => {
    for (const f of sourceFiles(join(SRC, 'skills', 'fly'))) expect(readFileSync(f, 'utf8')).not.toMatch(/events\/(bus|index)\.ts/);
  });

  it('an unknown kind or a wrong payload does not compile', () => {
    const bus = new EventBus();
    bus.strict = true;
    const never = (): void => {
      // @ts-expect-error: not a registered kind
      bus.emit('job.exploded', { job: 'x' });
      // @ts-expect-error: missing field
      bus.emit('job.finished', { job: 'x', durationS: 1 });
      // @ts-expect-error: wrong type
      bus.emit('combat.kill', { mob: 3 });
    };
    expect(typeof never).toBe('function');
  });
});

describe('event bus', () => {
  let bus: EventBus;
  beforeEach(() => {
    bus = new EventBus(5);
  });
  afterEach(() => {
    bus.reset();
  });

  it('ids increase, the ring keeps the newest, subscribers see every event in order', () => {
    const seen: number[] = [];
    const off = bus.subscribe((e) => seen.push(e.id));
    for (let i = 0; i < 8; i++) bus.emit('combat.kill', { mob: `m${i}` });
    off();
    bus.emit('combat.kill', { mob: 'late' });
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(bus.recent().map((e) => e.id)).toEqual([5, 6, 7, 8, 9]);
    expect(bus.recent()[0]!.sev).toBe('info');
  });

  it('strict: an invalid payload throws; not strict: kept and counted', () => {
    bus.strict = true;
    expect(() => bus.emit('combat.kill', { mob: 5 } as unknown as { mob: string })).toThrow(/schema/);
    bus.strict = false;
    expect(bus.emit('combat.kill', { mob: 5 } as unknown as { mob: string })).toBeDefined();
    expect(bus.stats.invalid).toBe(2);
  });

  it('a subscriber that throws does not break the emit', () => {
    bus.subscribe(() => {
      throw new Error('boom');
    });
    expect(bus.emit('combat.kill', { mob: 'zombie' })?.id).toBe(1);
  });

  it('the rate guard drops a kind beyond RATE_PER_MIN a minute', () => {
    let t = 1_762_300_000_000;
    bus.now = () => t;
    for (let i = 0; i < RATE_PER_MIN + 10; i++) bus.emit('combat.kill', { mob: 'zombie' });
    expect(bus.stats.dropped['combat.kill']).toBe(10);
    expect(bus.emit('combat.fight', { mob: 'z', outcome: 'killed', ticks: 1, attacks: 1, landed: 1, damageTaken: 0, kills: 1 })).toBeDefined();
    t += 60_000;
    expect(bus.emit('combat.kill', { mob: 'zombie' })).toBeDefined();
  });

  it('attach renumbers events emitted before the store opened after the stored ids', () => {
    bus.emit('combat.kill', { mob: 'early' });
    bus.attach(undefined, { lastId: 41 });
    expect(bus.recent()[0]!.id).toBe(42);
    expect(bus.emit('combat.kill', { mob: 'next' })?.id).toBe(43);
  });
});
