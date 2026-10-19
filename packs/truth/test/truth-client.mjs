// Test helpers: a throwaway bedrock-protocol client that completes the spawn handshake, and a
// TruthClient that issues /scriptevent truth:* through `docker exec <container> send-command`
// and resolves with the parsed '@truth' reply carrying the same request id.
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { ReplyParser, textOf } from '../src/protocol.ts';

const require = createRequire(import.meta.url);
const bedrock = require('bedrock-protocol');

/**
 * Connects an offline RakNet client and resolves once the server simulates it (after the
 * respawn state 2 answer and the loading-screen acks, see PLAN.md fact 2f / spikes/spikeC.js).
 * `onClient(client)` is called right after creation, before any packet is handled.
 */
export function connectBot({ host = '127.0.0.1', port = 19136, username = 'TruthBot', timeoutMs = 30000, onClient } = {}) {
  return new Promise((resolve, reject) => {
    const client = bedrock.createClient({
      host,
      port,
      username,
      offline: true,
      version: '1.26.51',
      raknetBackend: 'raknet-native',
    });
    onClient?.(client); // attach listeners (e.g. a TruthClient) before spawn so early events are seen
    let rid;
    const timer = setTimeout(() => {
      client.close?.();
      reject(new Error(`spawn timeout after ${timeoutMs} ms`));
    }, timeoutMs);
    client.on('start_game', (p) => {
      rid = p.runtime_entity_id;
    });
    client.on('respawn', (p) => {
      if (p.state === 1) client.queue('respawn', { position: p.position, state: 2, runtime_entity_id: rid ?? client.entityId });
    });
    client.on('play_status', (p) => {
      if (p.status === 'player_spawn') {
        client.queue('serverbound_loading_screen', { type: 1 });
        client.queue('serverbound_loading_screen', { type: 2 });
      }
    });
    client.on('spawn', () => {
      clearTimeout(timer);
      resolve(client);
    });
    client.on('kick', (p) => {
      clearTimeout(timer);
      reject(new Error(`kicked: ${JSON.stringify(p)}`));
    });
    client.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** Sends a server console command (no leading slash). */
export function consoleCommand(container, ...words) {
  return new Promise((resolve, reject) => {
    execFile('docker', ['exec', container, 'send-command', ...words], (err, stdout, stderr) => {
      if (err) reject(new Error(`send-command failed: ${err.message} ${stderr}`));
      else resolve(stdout);
    });
  });
}

export class TruthClient {
  /** @param {{ client: any, container?: string }} opts */
  constructor({ client, container = 'bds-truth' }) {
    this.container = container;
    this.parser = new ReplyParser();
    this.pending = new Map();
    this.events = [];
    this.eventWaiters = [];
    this.seq = 0;
    client.on('text', (p) => {
      const line = textOf(p);
      let reply;
      try {
        reply = this.parser.feed(line);
      } catch (e) {
        console.error('[truth] unparsable reply line', line.slice(0, 200), e);
        return;
      }
      if (!reply) return;
      if (reply.cmd === 'event') {
        this.events.push(reply);
        for (const w of [...this.eventWaiters]) {
          if (w.pred(reply.data)) {
            this.eventWaiters.splice(this.eventWaiters.indexOf(w), 1);
            w.resolve(reply);
          }
        }
        return;
      }
      const waiter = reply.id !== null ? this.pending.get(reply.id) : undefined;
      if (waiter) {
        this.pending.delete(reply.id);
        waiter.resolve(reply);
      }
    });
  }

  /** Issues truth:<name> with args; resolves with the reply envelope {cmd,id,ok,tick,data,reason?}. */
  cmd(name, args = [], { timeoutMs = 10000 } = {}) {
    const id = `t${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for truth:${name} #${id}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
      });
      consoleCommand(this.container, 'scriptevent', `truth:${name}`, `#${id}`, ...args.map(String)).catch((e) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  /** Like cmd() but throws unless ok, and returns data. */
  async ok(name, args = [], opts) {
    const r = await this.cmd(name, args, opts);
    if (!r.ok) throw new Error(`truth:${name} failed: ${r.reason} ${JSON.stringify(r.data)}`);
    return r.data;
  }

  /** Resolves with the next event whose data matches pred (also checks events already seen). */
  waitEvent(pred, { timeoutMs = 10000, since = 0 } = {}) {
    const seen = this.events.slice(since).find((e) => pred(e.data));
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      const timer = setTimeout(() => {
        this.eventWaiters.splice(this.eventWaiters.indexOf(w), 1);
        reject(new Error('timeout waiting for event'));
      }, timeoutMs);
      w.resolve = (e) => {
        clearTimeout(timer);
        resolve(e);
      };
      this.eventWaiters.push(w);
    });
  }
}
