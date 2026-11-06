// The seams the bot already has, turned into events (decision 0059, docs/events.md "Seams"). Called
// once from index.ts after the task exists; every hook here is a listener on an existing observer API,
// so no logic moves into the event module and nothing else changes:
//
//   Connection.onSpawn / onClose          connection.connected / reconnected / disconnected / kicked / lost
//   Chat.onLine + Chat.onCommand          command.received (and the actor jobs record as `by`)
//   RespawnController.onEvent             life.died (a second later, when death_info named the cause) / life.respawned
//   MobTracker.onHit                      combat.damage, batched per minute and before a death
//   container_open / container_close      container.deposit / withdraw (items.ts)
//   Inventory.onChange                    items.changed (items.ts), resource.low (resources.ts)
//
// The other kinds are one emit line at their site: combat.fight / combat.kill (skills/combat/combat.ts),
// combat.flee (tasks/pve.ts), job.* and home.arrived (tasks/process/manager.ts via jobs.ts).
import { senderLabel, type CommandEvent } from '../chat/chat.ts';
import type { ChatLine } from '../chat/text.ts';
import type { AnyPacket, CloseInfo, Vec3 } from '../connection/types.ts';
import { bareType as bare } from '../skills/combat/hostiles.ts';
import { fromPanel, setActor } from './actor.ts';
import { events as defaultBus, type EventBus } from './bus.ts';
import { ItemTally, SETTLE_MS, type TallyInventory } from './items.ts';
import { clipText as clip } from './registry.ts';
import { ResourceWatch } from './resources.ts';

export const DAMAGE_FLUSH_MS = 60_000;
/** A death is recorded this long after it (death_info with the cause may come just after). */
export const DEATH_DELAY_MS = 1000;

interface DeathLike {
  n: number;
  cause: string;
  messages: string[];
  at: Vec3 | undefined;
}

export interface WireDeps {
  conn: {
    onSpawn(fn: () => void): () => void;
    onClose(fn: (info: CloseInfo) => void): () => void;
    on(name: string, fn: (p: AnyPacket) => void): () => void;
    readonly gameVersion: string;
  };
  server: string;
  chat?: { onCommand(fn: (e: CommandEvent) => void): () => void; onLine(fn: (l: ChatLine) => void): () => void } | undefined;
  respawn?: { onEvent(fn: (e: { kind: 'death'; death: DeathLike } | { kind: 'respawn'; feet: Vec3 } | { kind: 'health' }) => void): () => void } | undefined;
  inventory?: TallyInventory | undefined;
  blockAt?: ((p: Vec3) => string | undefined) | undefined;
  hits?: { onHit(fn: (h: { type: string } | undefined, damage: number, cause?: string) => void): () => void } | undefined;
  toolWearLimit?: () => number;
  fireworksMin?: () => number;
  bus?: EventBus;
  damageFlushMs?: number;
  deathDelayMs?: number;
}

export interface EventWiring {
  /** Write the batches now (items, damage); the bot exits after this. */
  flush(): void;
  stop(): void;
}


export function wireEvents(d: WireDeps): EventWiring {
  const bus = d.bus ?? defaultBus;
  const unsubs: (() => void)[] = [];
  const timers: NodeJS.Timeout[] = [];
  const tally = d.inventory ? new ItemTally({ inventory: d.inventory, bus, ...(d.blockAt ? { blockAt: d.blockAt } : {}) }) : undefined;
  const watch = d.inventory ? new ResourceWatch({ inventory: d.inventory, bus, ...(d.toolWearLimit ? { toolWearLimit: d.toolWearLimit } : {}), ...(d.fireworksMin ? { fireworksMin: d.fireworksMin } : {}) }) : undefined;
  let watchTimer: NodeJS.Timeout | undefined;

  // ---- connection
  let spawned = false;
  let closedAt: number | undefined;
  unsubs.push(
    d.conn.onSpawn(() => {
      const now = Date.now();
      if (!spawned) bus.emit('connection.connected', { server: d.server, version: d.conn.gameVersion });
      else bus.emit('connection.reconnected', { server: d.server, offlineS: closedAt === undefined ? 0 : Math.round((now - closedAt) / 1000) });
      spawned = true;
      closedAt = undefined;
      tally?.reset();
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => watch?.enable(), SETTLE_MS + 1000); // after the inventory arrived
      watchTimer.unref();
    }),
    d.conn.onClose((info) => {
      closedAt ??= Date.now();
      watch?.enable(false);
      tally?.reset();
      if (info.kind === 'client') return; // our own disconnect (!quit, a signal, --duration): the command is already recorded
      if (info.kind === 'kick') {
        bus.emit('connection.kicked', { reason: clip(info.kick?.reason ?? info.reason), ...(info.kick?.message ? { message: clip(info.kick.message) } : {}), willReconnect: info.willReconnect });
      } else if (!info.willReconnect) {
        bus.emit('connection.lost', { reason: clip(info.reason), kind: info.kind });
      } else if ((info.spawnedMs ?? 0) > 0) {
        // a failed attempt while offline (never spawned) is not news: the first loss is
        bus.emit('connection.disconnected', { reason: clip(info.reason), kind: info.kind, sessionS: Math.round((info.spawnedMs ?? 0) / 1000), ...(info.retryInMs !== undefined ? { retryInS: Math.round(info.retryInMs / 1000) } : {}) });
      }
    }),
  );

  // ---- owner commands
  if (d.chat) {
    let last: ChatLine | undefined;
    unsubs.push(
      d.chat.onLine((l) => {
        last = l;
      }),
      d.chat.onCommand((e) => {
        if (e.kind !== 'run') return;
        const source = fromPanel() ? 'panel' : e.sender.kind === 'console' ? 'console' : 'chat';
        const sender = senderLabel(e.sender);
        setActor({ name: sender, source, command: e.name });
        bus.emit('command.received', { command: e.name, text: clip((last?.body ?? `!${e.name}`).trim()), source, sender });
      }),
    );
  }

  // ---- damage (batched)
  let dmg = { hits: 0, damage: 0, by: {} as Record<string, number>, since: Date.now() };
  const flushDamage = (): void => {
    if (dmg.hits > 0) bus.emit('combat.damage', { hits: dmg.hits, damage: Math.round(dmg.damage * 10) / 10, by: dmg.by, periodS: Math.round((Date.now() - dmg.since) / 1000) });
    dmg = { hits: 0, damage: 0, by: {}, since: Date.now() };
  };
  if (d.hits) {
    unsubs.push(
      d.hits.onHit((h, damage, cause) => {
        if (!(damage > 0)) return;
        dmg.hits++;
        dmg.damage += damage;
        const who = h ? bare(h.type) : (cause ?? 'unknown');
        dmg.by[who] = Math.round(((dmg.by[who] ?? 0) + damage) * 10) / 10;
      }),
    );
    const t = setInterval(flushDamage, d.damageFlushMs ?? DAMAGE_FLUSH_MS);
    t.unref();
    timers.push(t);
  }

  // ---- deaths
  let pending: { death: DeathLike; timer: NodeJS.Timeout } | undefined;
  const recordDeath = (): void => {
    const p = pending;
    if (!p) return;
    pending = undefined;
    clearTimeout(p.timer);
    const { death } = p;
    bus.emit('life.died', {
      n: death.n,
      cause: clip(death.cause),
      ...(death.messages.length ? { messages: death.messages.slice(0, 8).map((m) => clip(String(m))) } : {}),
      ...(death.at ? { at: { x: Math.round(death.at.x * 10) / 10, y: Math.round(death.at.y * 10) / 10, z: Math.round(death.at.z * 10) / 10 } } : {}),
    });
  };
  if (d.respawn) {
    unsubs.push(
      d.respawn.onEvent((e) => {
        if (e.kind === 'death') {
          flushDamage(); // the hits that killed it come first
          recordDeath();
          const timer = setTimeout(recordDeath, d.deathDelayMs ?? DEATH_DELAY_MS);
          timer.unref();
          pending = { death: e.death, timer };
        } else if (e.kind === 'respawn') {
          recordDeath();
          bus.emit('life.respawned', { at: { x: Math.round(e.feet.x * 10) / 10, y: Math.round(e.feet.y * 10) / 10, z: Math.round(e.feet.z * 10) / 10 } });
        }
      }),
    );
  }

  // ---- containers
  if (tally) {
    unsubs.push(
      d.conn.on('container_open', (p) => {
        const c = p.coordinates as Vec3 | undefined;
        if (c) tally.containerOpen(c, String(p.window_type));
      }),
      d.conn.on('container_close', () => {
        tally.containerClose();
      }),
    );
  }

  return {
    flush() {
      recordDeath();
      flushDamage();
      tally?.flush();
    },
    stop() {
      recordDeath();
      flushDamage();
      clearTimeout(watchTimer);
      for (const t of timers.splice(0)) clearInterval(t);
      for (const u of unsubs.splice(0)) u();
      tally?.stop();
      watch?.stop();
    },
  };
}
