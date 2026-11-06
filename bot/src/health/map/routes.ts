// Debug map routes for the health server (PLAN.md task 7.15): GET /map (the page) and GET /map.json
// (the data, schema.ts). Mounted with HealthServerOptions.routes (connection/health.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { buildWithColours, MapBuilder, parseMapQuery, type MapSource } from './data.ts';
import { installedBlockColours } from '../panel/icons/colours.ts'; // Track PC: the palette's map colours
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

/** Track PC: /map.json bodies at least this long are gzipped for clients that accept it. */
export const GZIP_MIN = 4096;

/** Route handler: true when it answered the request. `src.colours` undefined = the installed package's block colours (null: none). */
export function mapRoutes(src: MapSource): HealthRoute & { builder: MapBuilder } {
  const task = src.taskStatus;
  const colours = src.colours === undefined ? installedBlockColours() : src.colours; // Track PC
  const withColours: MapSource = { ...src, colours };
  const builder = new MapBuilder(task ? { ...withColours, taskStatus: () => liftTaskStatus(task()) } : withColours); // Track AR: waypoints and shelter on the map
  const handler = (path: string, req: IncomingMessage, res: ServerResponse): boolean => {
    if (path === '/map' || path === '/map/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : MAP_PAGE);
      return true;
    }
    if (path === '/map.json') {
      const answer = (status: number, body: string): void => {
        // Track PC: gzip when the client takes it (base64 of mostly uniform columns shrinks 3 to 5 times)
        const gz = body.length >= GZIP_MIN && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(gz ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}) });
        res.end(req.method === 'HEAD' ? undefined : gz ? gzipSync(body, { level: 6 }) : body);
      };
      const fail = (e: unknown): void => answer(500, JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        // Track PC: answered once the palette's colours are known (the first request reads the art)
        buildWithColours(builder, colours, parseMapQuery(url.searchParams)).then((j) => answer(200, JSON.stringify(j)), fail);
      } catch (e) {
        fail(e);
      }
      return true;
    }
    return false;
  };
  return Object.assign(handler, { builder });
}
