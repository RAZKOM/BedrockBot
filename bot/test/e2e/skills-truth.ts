// Minimal truth-pack client for the skills e2e tests (packs/truth/README.md): sends
// `scriptevent truth:<cmd> #<id> ...` through `docker exec <container> send-command` and resolves
// with the '@truth {...}' reply that arrives as a `text` packet on the bot's own connection.
import { execFile } from 'node:child_process';
import type { Connection } from '../../src/connection/connection.ts';
import type { TextPacket, Vec3 } from '../../src/connection/types.ts';

export interface TruthReply<T = Record<string, unknown>> {
  cmd: string;
  id: string | null;
  ok: boolean;
  tick: number;
  data: T;
  reason?: string;
}

export interface TruthPos {
  name: string;
  location: Vec3;
  isOnGround: boolean;
  velocity: Vec3;
  rotation: { pitch: number; yaw: number };
  tick: number;
}

const MARKER = '@truth ';

function textOf(p: TextPacket): string {
  if (p.type === 'json' || p.type === 'json_whisper' || p.type === 'json_announcement') {
    try {
      const parsed = JSON.parse(p.message) as { rawtext?: { text?: string }[] };
      return (parsed.rawtext ?? []).map((r) => r.text ?? '').join('');
    } catch {
      return p.message;
    }
  }
  return p.message;
}

export function consoleCommand(container: string, ...words: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('docker', ['exec', container, 'send-command', ...words], (err, _stdout, stderr) => {
      if (err) reject(new Error(`send-command failed: ${err.message} ${stderr}`));
      else resolve();
    });
  });
}

export class Truth {
  private seq = 0;
  private readonly pending = new Map<string, (r: TruthReply) => void>();
  private readonly tag = Math.random().toString(36).slice(2, 6);

  private readonly container: string;

  constructor(conn: Connection, container: string) {
    this.container = container;
    conn.on('text', (p) => {
      const line = textOf(p);
      if (!line.startsWith(MARKER)) return;
      let reply: TruthReply;
      try {
        reply = (JSON.parse(line.slice(MARKER.length)) as { truth: TruthReply }).truth;
      } catch {
        return;
      }
      const fn = reply.id !== null ? this.pending.get(reply.id) : undefined;
      if (fn && reply.id !== null) {
        this.pending.delete(reply.id);
        fn(reply);
      }
    });
  }

  cmd<T = Record<string, unknown>>(name: string, args: (string | number)[] = [], timeoutMs = 10_000): Promise<TruthReply<T>> {
    const id = `${this.tag}${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for truth:${name} #${id}`));
      }, timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r as TruthReply<T>);
      });
      consoleCommand(this.container, 'scriptevent', `truth:${name}`, `#${id}`, ...args.map(String)).catch((e: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  async ok<T = Record<string, unknown>>(name: string, args: (string | number)[] = [], timeoutMs?: number): Promise<T> {
    const r = await this.cmd<T>(name, args, timeoutMs);
    if (!r.ok) throw new Error(`truth:${name} failed: ${r.reason ?? '?'} ${JSON.stringify(r.data)}`);
    return r.data;
  }

  pos(name: string): Promise<TruthPos> {
    return this.ok<TruthPos>('pos', [name]);
  }

  fill(from: Vec3, to: Vec3, block: string): Promise<unknown> {
    return this.ok('fill', [from.x, from.y, from.z, to.x, to.y, to.z, block], 20_000);
  }

  tp(name: string, feet: Vec3, yaw = 0, pitch = 0): Promise<unknown> {
    return this.ok('tp', [name, feet.x, feet.y, feet.z, yaw, pitch]);
  }
}
