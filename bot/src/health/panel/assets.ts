// The page's browser modules (docs/panel.md "Files", decision 0061): the TypeScript files under
// health/panel/client/ plus health/panel/shared.ts, type-stripped once at startup with Node's own
// module.stripTypeScriptTypes (no bundler, no dependency, nothing from the internet) and served as
// native ES modules from memory:
//
//   GET /ui/<hash>/client/main.ts    text/javascript, cache-control immutable (a year)
//
// <hash> covers every module, so a bot started with other code serves new URLs and a browser never
// mixes versions; the relative imports between the files (`./menu.ts`, `../shared.ts`) resolve under
// the same prefix, exactly as in the source tree. Loading checks what the browser would trip over: an
// import that is not one of these files (a server module, a Node built-in, an inline type-only import
// that strips to `import {} from`), a dynamic import, a module over its byte budget.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { gzipSync } from 'node:zlib';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HealthRoute } from '../map/routes.ts';
import { PANEL_BUDGETS } from './budgets.ts';

export const UI_PREFIX = '/ui/';
/** The page's entry module (the one <script type="module"> the page names). */
export const ENTRY_MODULE = 'client/boot.ts';
const PANEL_DIR = dirname(fileURLToPath(import.meta.url));

export interface ClientModule {
  /** Relative to health/panel: `shared.ts`, `client/main.ts`. */
  path: string;
  code: string;
  body: Buffer;
  /** The same, gzipped (sent when the browser accepts it). */
  gz: Buffer;
  /** Relative specifiers it imports, resolved to module paths. */
  imports: string[];
}

/** Strip the types of one module (Node's ExperimentalWarning for it is swallowed: one line per start otherwise). */
export function stripModule(src: string): string {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- put back as it was below; called with Reflect.apply on process
  const orig = process.emitWarning;
  process.emitWarning = (warning: string | Error, ...rest: unknown[]): void => {
    const m = typeof warning === 'string' ? warning : warning.message;
    if (m.includes('stripTypeScriptTypes')) return;
    Reflect.apply(orig, process, [warning, ...rest]);
  };
  try {
    return stripTypeScriptTypes(src, { mode: 'strip' });
  } finally {
    process.emitWarning = orig;
  }
}

/** Import / export-from specifiers of stripped code (statements at the start of a line). */
export function importSpecifiers(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/^\s*(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm)) out.push((m[1] ?? m[2])!);
  return out;
}

/** Stripped code with anything but comments and whitespace in it. */
const hasCode = (code: string): boolean => code.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').trim() !== '';

/** Read, strip and check the modules (throws with every problem listed); types-only files are left out. */
export function loadClientModules(dir = PANEL_DIR): ClientModule[] {
  const files = ['shared.ts', ...readdirSync(join(dir, 'client')).filter((f) => f.endsWith('.ts')).sort().map((f) => `client/${f}`)];
  const mods = files.map((path): ClientModule => {
    const code = stripModule(readFileSync(join(dir, path), 'utf8'));
    const body = Buffer.from(code, 'utf8');
    return { path, code, body, gz: gzipSync(body, { level: 9 }), imports: [] };
  });
  const known = new Set(files);
  const problems: string[] = [];
  for (const m of mods) {
    if (/\bimport\s*\(/.test(m.code)) problems.push(`${m.path}: dynamic import()`);
    if (/^\s*import\s*\{\s*\}\s*from/m.test(m.code)) problems.push(`${m.path}: an import that strips to \`import {} from\` (write \`import type\`)`);
    for (const spec of importSpecifiers(m.code)) {
      const target = spec.startsWith('.') ? posix.normalize(posix.join(posix.dirname(m.path), spec)) : spec;
      if (!known.has(target)) problems.push(`${m.path}: imports ${spec}, which is not a browser module (client/*.ts or shared.ts)`);
      else m.imports.push(target);
    }
    if (m.body.length > PANEL_BUDGETS.module) problems.push(`${m.path}: ${m.body.length} bytes, over the module budget of ${PANEL_BUDGETS.module} (docs/panel.md "Budgets")`);
  }
  // a types-only file (client/page.ts) strips to comments: not served, and no stripped code may import it
  const typeOnly = new Set(mods.filter((m) => m.path !== 'shared.ts' && !hasCode(m.code)).map((m) => m.path));
  for (const m of mods) for (const i of m.imports) if (typeOnly.has(i)) problems.push(`${m.path}: imports ${i}, which has only types (write \`import type\`)`);
  if (problems.length) throw new Error(`panel browser modules:\n  ${problems.join('\n  ')}`);
  return mods.filter((m) => !typeOnly.has(m.path));
}

export class ClientModules {
  readonly hash: string;
  readonly modules: ReadonlyMap<string, ClientModule>;

  constructor(mods: readonly ClientModule[] = loadClientModules()) {
    const h = createHash('sha256');
    for (const m of mods) h.update(m.path).update('\0').update(m.body);
    this.hash = h.digest('base64url').slice(0, 12);
    this.modules = new Map(mods.map((m) => [m.path, m]));
  }

  /** The URL of a module (`client/boot.ts` -> `/ui/<hash>/client/boot.ts`). */
  url(path: string): string {
    return `${UI_PREFIX}${this.hash}/${path}`;
  }

  /** Every module's URL, the entry first (for <link rel="modulepreload">). */
  urls(): string[] {
    return [ENTRY_MODULE, ...[...this.modules.keys()].filter((p) => p !== ENTRY_MODULE)].map((p) => this.url(p));
  }

  /** Total bytes of the modules. */
  bytes(gz = false): number {
    let n = 0;
    for (const m of this.modules.values()) n += gz ? m.gz.length : m.body.length;
    return n;
  }

  route(): HealthRoute {
    const prefix = `${UI_PREFIX}${this.hash}/`;
    const etag = `"${this.hash}"`;
    return (path, req, res) => {
      if (!path.startsWith(UI_PREFIX)) return false;
      const method = req.method ?? 'GET';
      const m = path.startsWith(prefix) ? this.modules.get(path.slice(prefix.length)) : undefined;
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(`${JSON.stringify({ error: 'GET only' })}\n`);
        return true;
      }
      if (!m) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(method === 'HEAD' ? undefined : `${JSON.stringify({ error: path.startsWith(prefix) ? 'no such module' : 'another version of the page: reload it' })}\n`);
        return true;
      }
      const head = { 'cache-control': 'private, max-age=31536000, immutable', etag, 'x-content-type-options': 'nosniff' };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, head);
        res.end();
        return true;
      }
      const zip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
      const out = zip ? m.gz : m.body;
      res.writeHead(200, { ...head, 'content-type': 'text/javascript; charset=utf-8', 'content-length': out.length, vary: 'accept-encoding', ...(zip ? { 'content-encoding': 'gzip' } : {}) });
      res.end(method === 'HEAD' ? undefined : out);
      return true;
    };
  }
}

let shared: ClientModules | undefined;
/** The modules of this process (loaded on the first call; the same object afterwards). */
export function clientModules(): ClientModules {
  shared ??= new ClientModules();
  return shared;
}
