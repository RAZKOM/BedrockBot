// The bot's history (decision 0059, guide docs/events.md): a typed event registry, one bus, a JSONL
// store with retention, a query API and a live subscription.
//
//   import { events } from '../events/index.ts';
//   events.emit('job.finished', { job: 'mine', result: 'done', durationS: 42 });   // one line at the seam
//   const off = events.subscribe((e) => ...);                                       // live (the panel's push later)
//   await events.query({ since: Date.now() - 8 * 3600_000, min: 'notable' });
//
// index.ts opens the store (`openEventStore`) and wires the seams (`wireEvents`); the panel mounts
// `eventRoutes()` (GET /api/events, /api/events/summary, /api/events/kinds).
import { join } from 'node:path';
import type { Logger } from '../log.ts';
import { serverIdFor } from '../world/cache/index.ts';
import { events } from './bus.ts';
import { EventStore } from './store.ts';

export { events, EventBus, RING_SIZE, RATE_PER_MIN, type EventListener, type EventSink } from './bus.ts';
export { EVENT_KINDS, EVENT_KIND_NAMES, eventTable, formatEvent, kindList, type BotEvent, type EventData, type EventKind, type Severity } from './registry.ts';
export { viaPanel, currentActor, type Actor, type CommandSource } from './actor.ts';
export { eventRoutes } from './routes.ts';
export { summarize, type EventSummary } from './summary.ts';
export { wireEvents, type EventWiring, type WireDeps } from './wire.ts';
export { EventStore, DEFAULT_DAYS, DEFAULT_MAX_MB } from './store.ts';
export type { EventQuery, QueryResult } from './query.ts';

/**
 * Where the files go: env BEDROCKBOT_EVENTS_DIR, else `<config dir>/events` next to the world cache;
 * undefined (memory only) with BEDROCKBOT_EVENTS=0, or with --no-config and no env (tests, like the
 * runtime settings).
 */
export function eventsRoot(o: { env: NodeJS.ProcessEnv; configPath: string | undefined; noConfig: boolean; defaultConfigPath: string }): string | undefined {
  if (o.env.BEDROCKBOT_EVENTS === '0') return undefined;
  if (o.env.BEDROCKBOT_EVENTS_DIR) return o.env.BEDROCKBOT_EVENTS_DIR;
  if (o.noConfig) return undefined;
  return join(o.configPath ?? o.defaultConfigPath, '..', 'events');
}

export interface OpenEventsOptions {
  /** eventsRoot(); undefined = memory only. */
  root: string | undefined;
  /** Connection target label (the same server id as the world cache). */
  server: string;
  /** Settings eventsDays / eventsMaxMb (read at every retention pass). */
  settings?: { get(key: 'eventsDays' | 'eventsMaxMb'): number | boolean | string };
  log: Logger;
}

/** Open the store for this server and attach it to the bus (ids continue after the stored ones). */
export function openEventStore(o: OpenEventsOptions): EventStore | undefined {
  if (!o.root) {
    events.attach(undefined, { log: o.log });
    o.log.info('events: in memory only (no config file, or BEDROCKBOT_EVENTS=0; docs/events.md)');
    return undefined;
  }
  const dir = join(o.root, serverIdFor(o.server));
  const store = EventStore.open({
    dir,
    log: o.log,
    ...(o.settings
      ? {
          days: () => Number(o.settings!.get('eventsDays')),
          maxBytes: () => Number(o.settings!.get('eventsMaxMb')) * 1024 * 1024,
        }
      : {}),
  });
  events.attach(store.memoryOnly ? undefined : store, { lastId: store.lastId, log: o.log });
  if (!store.memoryOnly) o.log.info(`events: ${dir} (continuing after id ${store.lastId})`);
  return store;
}
