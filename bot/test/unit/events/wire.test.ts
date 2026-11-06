// The seams in wire.ts (decision 0059, docs/events.md "Seams"): connection lifecycle, owner commands
// (chat, console, panel), deaths with the late cause, damage batched before a death, containers.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandEvent } from '../../../src/chat/chat.ts';
import type { ChatLine } from '../../../src/chat/text.ts';
import type { AnyPacket, CloseInfo, Vec3 } from '../../../src/connection/types.ts';
import { currentActor, viaPanel } from '../../../src/events/actor.ts';
import { EventBus } from '../../../src/events/bus.ts';
import type { BotEvent } from '../../../src/events/registry.ts';
import { wireEvents, type EventWiring } from '../../../src/events/wire.ts';

class Hub<A extends unknown[]> {
  readonly fns = new Set<(...a: A) => void>();
  on = (fn: (...a: A) => void): (() => void) => {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  };
  fire(...a: A): void {
    for (const f of [...this.fns]) f(...a);
  }
}

describe('wireEvents', () => {
  let bus: EventBus;
  let seen: BotEvent[];
  let spawn: Hub<[]>;
  let close: Hub<[CloseInfo]>;
  let packets: Map<string, Hub<[AnyPacket]>>;
  let lines: Hub<[ChatLine]>;
  let commands: Hub<[CommandEvent]>;
  let respawn: Hub<[{ kind: 'death'; death: { n: number; cause: string; messages: string[]; at: Vec3 | undefined } } | { kind: 'respawn'; feet: Vec3 }]>;
  let hits: Hub<[{ type: string } | undefined, number, string?]>;
  let w: EventWiring;

  beforeEach(() => {
    bus = new EventBus();
    bus.strict = true;
    seen = [];
    bus.subscribe((e) => seen.push(e));
    spawn = new Hub();
    close = new Hub();
    packets = new Map();
    lines = new Hub();
    commands = new Hub();
    respawn = new Hub();
    hits = new Hub();
    const packet = (name: string): Hub<[AnyPacket]> => {
      let h = packets.get(name);
      if (!h) packets.set(name, (h = new Hub()));
      return h;
    };
    w = wireEvents({
      bus,
      server: '127.0.0.1:19132',
      conn: { onSpawn: spawn.on, onClose: close.on, on: (n, fn) => packet(n).on(fn), gameVersion: '1.26.60' },
      chat: { onLine: lines.on, onCommand: commands.on },
      respawn: { onEvent: respawn.on },
      hits: { onHit: hits.on },
      deathDelayMs: 20,
    });
  });
  afterEach(() => {
    w.stop();
  });

  const kinds = () => seen.map((e) => e.kind);

  it('connection: connected, a disconnect with a reconnect, a failed attempt (not recorded), reconnected, a kick, our own close (not recorded), lost', () => {
    spawn.fire();
    close.fire({ reason: 'timed out', kind: 'error', willReconnect: true, spawnedMs: 3_600_000, retryInMs: 2000 });
    close.fire({ reason: 'ping failed', kind: 'error', willReconnect: true, spawnedMs: 0, retryInMs: 4000 });
    spawn.fire();
    close.fire({ reason: 'kicked', kind: 'kick', kick: { reason: 'kicked', message: 'Kicked by an operator' }, willReconnect: true, spawnedMs: 10 });
    close.fire({ reason: 'client', kind: 'client', willReconnect: false });
    close.fire({ reason: 'outdated_client', kind: 'version', willReconnect: false, spawnedMs: 0 });
    expect(kinds()).toEqual(['connection.connected', 'connection.disconnected', 'connection.reconnected', 'connection.kicked', 'connection.lost']);
    expect(seen[0]!.data).toEqual({ server: '127.0.0.1:19132', version: '1.26.60' });
    expect(seen[1]!.data).toEqual({ reason: 'timed out', kind: 'error', sessionS: 3600, retryInS: 2 });
    expect(seen[3]!.data).toEqual({ reason: 'kicked', message: 'Kicked by an operator', willReconnect: true });
  });

  it('commands: the text, the source (chat, console, panel), and the actor during the synchronous run', async () => {
    const run = (sender: CommandEvent['sender'], body: string, panel = false) => {
      const go = () => {
        lines.fire({ type: 'chat', source: 'x', message: body, body, xuid: '', truth: false });
        commands.fire({ kind: 'run', name: body.slice(1).split(' ')[0]!, sender });
        return currentActor();
      };
      return panel ? viaPanel(go) : go();
    };
    const a = run({ kind: 'player', name: 'Steve', xuid: '1' }, '!kill zombie');
    expect(a).toEqual({ name: 'Steve', source: 'chat', command: 'kill' });
    run({ kind: 'console' }, '!stop');
    run({ kind: 'console' }, '!goto 100 64 -50', true);
    commands.fire({ kind: 'denied', name: 'quit', sender: { kind: 'player', name: 'Alex', xuid: '2' } });
    await Promise.resolve();
    expect(currentActor()).toBeUndefined();
    expect(seen.map((e) => e.data)).toEqual([
      { command: 'kill', text: '!kill zombie', source: 'chat', sender: 'Steve' },
      { command: 'stop', text: '!stop', source: 'console', sender: 'console' },
      { command: 'goto', text: '!goto 100 64 -50', source: 'panel', sender: 'console' },
    ]);
  });

  it('a death: the damage batch first, then the death with the cause that came after; the respawn', async () => {
    hits.fire({ type: 'minecraft:zombie' }, 4);
    hits.fire(undefined, 2, 'drowning');
    hits.fire(undefined, 0); // no damage: ignored
    const death = { n: 1, cause: 'health_zero', messages: [] as string[], at: { x: 100.04, y: 64, z: -50.26 } };
    respawn.fire({ kind: 'death', death });
    death.cause = 'death.attack.zombie'; // death_info arrived just after
    expect(kinds()).toEqual(['combat.damage']);
    await new Promise((r) => setTimeout(r, 40));
    respawn.fire({ kind: 'respawn', feet: { x: 0.5, y: 64, z: 0.5 } });
    expect(kinds()).toEqual(['combat.damage', 'life.died', 'life.respawned']);
    expect(seen[0]!.data).toMatchObject({ hits: 2, damage: 6, by: { zombie: 4, drowning: 2 } });
    expect(seen[1]!.data).toEqual({ n: 1, cause: 'death.attack.zombie', at: { x: 100, y: 64, z: -50.3 } });
  });

  it('a respawn before the delay records the death at once; stop() writes what is pending', () => {
    respawn.fire({ kind: 'death', death: { n: 2, cause: 'death.attack.fall', messages: ['Bot'], at: undefined } });
    respawn.fire({ kind: 'respawn', feet: { x: 1, y: 2, z: 3 } });
    hits.fire({ type: 'skeleton' }, 3);
    w.flush();
    expect(kinds()).toEqual(['life.died', 'life.respawned', 'combat.damage']);
    expect(seen[0]!.data).toEqual({ n: 2, cause: 'death.attack.fall', messages: ['Bot'] });
  });
});
