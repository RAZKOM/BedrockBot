// WebSocket bridge (PLAN.md task 6.2): one env per connection, one connection per bot at a time.
// Messages of a connection are handled strictly in order (an action finishes before the next message
// is looked at). Every outbound message is validated against the schema before it is sent, so a
// schema bug shows up as an `error` reply plus a log line, not as a malformed observation.
import { silentLogger, type Logger } from '../log.ts';
import { OutboundSchema, parseInbound, type Outbound } from './schema.ts';
import type { RlSession } from './session.ts';
import { WsServer, type WsConnection } from './ws.ts';

export interface BridgeOptions {
  host?: string;
  port: number;
  session: RlSession;
  log?: Logger;
  /** Validate outbound messages with zod (default true). */
  validate?: boolean;
}

export class BridgeServer {
  readonly session: RlSession;
  private readonly ws = new WsServer();
  private readonly log: Logger;
  private readonly host: string;
  private readonly port: number;
  private readonly validate: boolean;
  private active: WsConnection | undefined;
  private boundPort = 0;
  connections = 0;
  schemaErrors = 0;

  constructor(opts: BridgeOptions) {
    this.session = opts.session;
    this.log = opts.log ?? silentLogger;
    this.host = opts.host ?? '127.0.0.1';
    this.port = opts.port;
    this.validate = opts.validate ?? true;
    this.ws.onConnection((c) => this.accept(c));
  }

  get address(): string {
    return `ws://${this.host}:${this.boundPort}`;
  }

  get busy(): boolean {
    return this.active !== undefined;
  }

  async start(): Promise<number> {
    this.boundPort = await this.ws.listen(this.port, this.host);
    this.log.info(`rl bridge listening on ${this.address}`);
    return this.boundPort;
  }

  stop(): Promise<void> {
    return this.ws.close();
  }

  private send(c: WsConnection, m: Outbound): void {
    if (this.validate) {
      const r = OutboundSchema.safeParse(m);
      if (!r.success) {
        this.schemaErrors++;
        const message = `outbound schema error: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
        this.log.error(message);
        c.send(JSON.stringify({ t: 'error', id: 'id' in m && typeof m.id === 'number' ? m.id : null, message }));
        return;
      }
    }
    c.send(JSON.stringify(m));
  }

  private accept(c: WsConnection): void {
    if (this.active) {
      c.send(JSON.stringify({ t: 'error', id: null, message: 'bridge busy: one env per bot, another client is connected' }));
      c.close(1013, 'busy');
      return;
    }
    this.active = c;
    this.connections++;
    this.log.info(`rl client connected from ${c.remote}`);
    let chain = Promise.resolve();
    c.onMessage((text) => {
      chain = chain.then(async () => {
        if (!c.isOpen) return;
        const p = parseInbound(text);
        if (!p.ok) {
          this.send(c, { t: 'error', id: p.id, message: p.message });
          return;
        }
        const out = await this.session.handle(p.msg);
        this.send(c, out);
        if (out.t === 'closed') c.close(1000, 'closed');
      });
    });
    c.onClose((code, reason) => {
      this.log.info(`rl client disconnected (${code}${reason ? ` ${reason}` : ''})`);
      void chain.then(() => {
        if (this.active === c) this.active = undefined;
        this.session.abort();
      });
    });
    this.send(c, this.session.hello());
  }
}
