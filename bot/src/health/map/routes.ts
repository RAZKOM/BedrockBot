// Debug map routes for the health server (PLAN.md task 7.15): GET /map (the page) and GET /map.json
// (the data, schema.ts). Mounted with HealthServerOptions.routes (connection/health.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MapBuilder, parseMapQuery, type MapSource } from './data.ts';
import { MAP_PAGE } from './page.ts';

export type HealthRoute = (path: string, req: IncomingMessage, res: ServerResponse) => boolean;

/** Route handler: true when it answered the request. */
export function mapRoutes(src: MapSource): HealthRoute & { builder: MapBuilder } {
  const builder = new MapBuilder(src);
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
