// Debug map routes for the health server (PLAN.md task 7.15): GET /map (the page) and GET /map.json
// (the data, schema.ts). Mounted with HealthServerOptions.routes (connection/health.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MapBuilder, parseMapQuery, type MapSource } from './data.ts';
import { MAP_PAGE } from './page.ts';

export type HealthRoute = (path: string, req: IncomingMessage, res: ServerResponse) => boolean;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Track AR (the panel's map legend): the afk task's status carries the waypoints under `nav.waypoints`
 * (commands-nav.ts, y may be null) and the shelter under `night.shelter`; lift them to the top-level
 * `waypoints` / `shelter` data.ts reads, when the status has none of its own.
 */
export function liftTaskStatus(s: unknown): unknown {
  if (!isRec(s)) return s;
  const out: Rec = { ...s };
  const nav = isRec(s.nav) ? s.nav : undefined;
  if (out.waypoints === undefined && Array.isArray(nav?.waypoints)) out.waypoints = (nav.waypoints as unknown[]).filter(isRec).map((w) => ({ ...w, y: typeof w.y === 'number' ? w.y : 0 }));
  const night = isRec(s.night) ? s.night : undefined;
  if (out.shelter === undefined && night?.shelter !== undefined) out.shelter = night.shelter;
  return out;
}

/** Route handler: true when it answered the request. */
export function mapRoutes(src: MapSource): HealthRoute & { builder: MapBuilder } {
  const task = src.taskStatus;
  const builder = new MapBuilder(task ? { ...src, taskStatus: () => liftTaskStatus(task()) } : src); // Track AR: waypoints and shelter on the map
  const handler = (path: string, req: IncomingMessage, res: ServerResponse): boolean => {
    if (path === '/map' || path === '/map/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : MAP_PAGE);
      return true;
    }
    if (path === '/map.json') {
      let body: string;
      let status = 200;
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        body = JSON.stringify(builder.build(parseMapQuery(url.searchParams)));
      } catch (e) {
        status = 500;
        body = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
      }
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
      return true;
    }
    return false;
  };
  return Object.assign(handler, { builder });
}
