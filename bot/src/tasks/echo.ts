// Echo task (PLAN.md task 0.3): print every chat line and the bot's own position.
import { formatChatLine, parseText, type ChatLine } from '../chat/text.ts';
import { EYE_HEIGHT, type Connection } from '../connection/connection.ts';
import type { Vec3 } from '../connection/types.ts';

export type EchoEvent =
  | { kind: 'chat'; line: ChatLine; text: string }
  | { kind: 'position'; feet: Vec3; source: 'respawn' | 'move_player' | 'correction' };

export interface EchoTaskOptions {
  /** Where output lines go (default: stdout). */
  print?: (line: string) => void;
}

const fmt = (v: Vec3) => `${v.x.toFixed(2)} ${v.y.toFixed(2)} ${v.z.toFixed(2)}`;

export function eyeToFeet(eye: Vec3): Vec3 {
  return { x: eye.x, y: eye.y - EYE_HEIGHT, z: eye.z };
}

export class EchoTask {
  readonly name = 'echo';
  /** Last known feet position (from respawn, own move_player, or a correction). */
  feet: Vec3 | undefined;
  private readonly print: (line: string) => void;
  private readonly listeners = new Set<(e: EchoEvent) => void>();
  private readonly unsubs: (() => void)[] = [];
  private readonly conn: Connection;

  constructor(conn: Connection, opts: EchoTaskOptions = {}) {
    this.conn = conn;
    this.print = opts.print ?? ((line) => { process.stdout.write(line + '\n'); });
  }

  /** Observe what the task prints, for tests. */
  onEvent(fn: (e: EchoEvent) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  start(): void {
    const conn = this.conn;
    this.unsubs.push(
      conn.on('text', (p) => {
        const line = parseText(p);
        const text = formatChatLine(line);
        this.print(`[chat:${line.type}] ${text}`);
        this.emit({ kind: 'chat', line, text });
      }),
      conn.on('respawn', (p) => {
        if (p.state === 1) this.setPosition(eyeToFeet(p.position), 'respawn');
      }),
      conn.on('move_player', (p) => {
        if (BigInt(p.runtime_id) === conn.runtimeId) this.setPosition(eyeToFeet(p.position), 'move_player');
      }),
      conn.on('correct_player_move_prediction', (p) => {
        if (p.prediction_type === 'player') this.setPosition(eyeToFeet(p.position), 'correction');
      }),
      conn.onSpawn(() => {
        this.print(`[spawn] ${conn.username} runtime id ${conn.runtimeId}${this.feet ? ` feet ${fmt(this.feet)}` : ''}`);
      }),
    );
  }

  stop(): void {
    for (const u of this.unsubs.splice(0)) u();
  }

  status(): Record<string, unknown> {
    return { state: this.conn.state, feet: this.feet };
  }

  private setPosition(feet: Vec3, source: 'respawn' | 'move_player' | 'correction'): void {
    this.feet = feet;
    this.print(`[pos:${source}] feet ${fmt(feet)}`);
    this.emit({ kind: 'position', feet, source });
  }

  private emit(e: EchoEvent): void {
    for (const fn of [...this.listeners]) fn(e);
  }
}
