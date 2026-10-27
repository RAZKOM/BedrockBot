// Health endpoint (PLAN.md task 5.4): a tiny HTTP server on 127.0.0.1 only.
//   GET /healthz  200 {"ok":true,...} while the bot is spawned, 503 otherwise (connecting, dead,
//                 closed). A dead bot (death screen) counts as unhealthy until it respawns.
//   GET /metrics  200 JSON: the metrics.json snapshot plus a `summary` block with the numbers an
//                 operator looks at first (uptime, session uptime, corrections/min, reconnects,
//                 kicks by reason, deaths, nudges, logs/hour, game version, server).
// It binds 127.0.0.1 unless `host` says otherwise (Track AE: the LAN control panel, health/panel,
// docs/panel.md, which only passes another interface together with a token check in `auth`).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { silentLogger, type Logger } from '../log.ts';
import type { Metrics, MetricsSnapshot } from './metrics.ts';

export const HEALTH_HOST = '127.0.0.1';

export interface HealthSummary {
  healthy: boolean;
  state: string;
  uptimeS: number;
  sessionUptimeS: number | null;
  correctionsPerMin: number;
  reconnects: number;
  kicksByReason: Record<string, number>;
  deaths: number;
  nudges: number;
  /** Logs gathered per hour, from the task's status (`logsPerHour`); null for tasks that gather nothing. */
  logsPerHour: number | null;
  gameVersion: string;
  server: string | null;
  task: string | null;
}

export interface HealthServerOptions {
  port: number;
  metrics: Pick<Metrics, 'snapshot'>;
  /** Extra health condition (e.g. not on the death screen). Default: always true. */
  alive?: () => boolean;
  log?: Logger;
  /** Track T: extra GET routes (the debug map: health/map/routes.ts); true = answered. */
  routes?: (path: string, req: IncomingMessage, res: ServerResponse) => boolean;
  /** Track AE: interface to bind (default 127.0.0.1); health/panel passes another one only with a token. */
  host?: string;
  /** Track AE: token check for every path except /healthz; false = it already answered (401). */
  auth?: (path: string, req: IncomingMessage, res: ServerResponse) => boolean;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function summarize(snap: MetricsSnapshot, alive = true): HealthSummary {
  const taskStatus = (snap.taskStatus ?? {}) as Record<string, unknown>;
  return {
    healthy: snap.state === 'spawned' && alive,
    state: snap.state,
    uptimeS: snap.uptimeS,
    sessionUptimeS: snap.session?.uptimeS ?? null,
    correctionsPerMin: snap.rates.correctionsPerMin,
    reconnects: snap.reconnects,
    kicksByReason: snap.kicks.byReason,
    deaths: snap.counters.deaths ?? 0,
    nudges: snap.counters.nudges ?? 0,
    logsPerHour: num(taskStatus.logsPerHour),
    gameVersion: snap.gameVersion,
    server: typeof snap.server === 'string' ? snap.server : null,
    task: typeof snap.task === 'string' ? snap.task : null,
  };
}

export class HealthServer {
  private server: Server | undefined;
  private readonly o: HealthServerOptions;
  private readonly log: Logger;
  requests = 0;
  private readonly extra: NonNullable<HealthServerOptions['routes']>[] = []; // Track AE: use()

  constructor(opts: HealthServerOptions) {
    this.o = opts;
    this.log = opts.log ?? silentLogger;
  }

  /** Track AE: register a route for every method (POST too), asked before the built-in ones. */
  use(route: NonNullable<HealthServerOptions['routes']>): void {
    this.extra.push(route);
  }

  /** Listen on <host, default 127.0.0.1>:<port> (0 = any free port). Resolves with the bound port. */
  start(): Promise<number> {
    const server = createServer((req, res) => {
      this.handle(req, res);
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      const host = this.o.host ?? HEALTH_HOST; // Track AE
      server.listen(this.o.port, host, () => {
        server.off('error', reject);
        server.unref();
        const port = (server.address() as AddressInfo).port;
        this.log.info(`health endpoint on http://${host}:${port}/healthz and /metrics`);
        resolve(port);
      });
    });
  }

  stop(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    if (!s) return Promise.resolve();
    return new Promise((resolve) => {
      s.close(() => {
        resolve();
      });
      s.closeAllConnections();
    });
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    this.requests++;
    const path = (req.url ?? '/').split('?')[0];
    if (path !== '/healthz' && this.o.auth && !this.o.auth(path ?? '/', req, res)) return; // Track AE: token
    for (const r of this.extra) if (r(path ?? '/', req, res)) return; // Track AE: panel routes
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      this.send(res, 405, { error: 'method not allowed' });
      return;
    }
    if (this.o.routes?.(path ?? '/', req, res)) return; // Track T: /map, /map.json
    let snap: MetricsSnapshot;
    try {
      snap = this.o.metrics.snapshot();
    } catch (e) {
      this.send(res, 500, { error: e instanceof Error ? e.message : String(e) });
      return;
    }
    const summary = summarize(snap, this.o.alive?.() ?? true);
    if (path === '/healthz') {
      this.send(res, summary.healthy ? 200 : 503, { ok: summary.healthy, state: summary.state, sessionUptimeS: summary.sessionUptimeS, ts: snap.ts });
    } else if (path === '/metrics') {
      this.send(res, 200, { summary, ...snap });
    } else {
      this.send(res, 404, { error: 'not found', paths: ['/healthz', '/metrics'] });
    }
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n';
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(text);
  }
}
