// Decision 0061 guards: the page's browser modules (health/panel/client/*.ts plus shared.ts) are
// served type-stripped as native ES modules, so a browser loads exactly these files and nothing else.
// What would break the page silently is checked here, on the sources:
//   - a client module imports only ./<module>.ts inside client/ or ../shared.ts;
//   - shared.ts has no runtime import (only `export type ... from`, erased by stripping);
//   - no client module but boot.ts touches a browser or Node global (they come through start(env));
//   - the server imports only the pure client modules (delta.ts, menu.ts), and those import no dom.ts;
//   - every module is reachable from the entry (boot.ts), so none is dead weight on the wire;
//   - loadClientModules() refuses what a browser would trip over.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENTRY_MODULE, importSpecifiers, loadClientModules, stripModule } from '../../../src/health/panel/assets.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../../../src');
const PANEL = join(SRC, 'health/panel');
const CLIENT = join(PANEL, 'client');
const clientFiles = readdirSync(CLIENT).filter((f) => f.endsWith('.ts')).sort();
const read = (p: string): string => readFileSync(p, 'utf8');
/** Source specifiers, type-only imports included (they must stay inside the browser set too). */
const sourceImports = (src: string): string[] => [...src.matchAll(/^\s*(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm)].map((m) => (m[1] ?? m[2])!);
/** The code without comments and string contents (for the globals check). */
const codeOnly = (src: string): string =>
  stripModule(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');

function allTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...allTs(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('panel browser modules (decision 0061)', () => {
  it('client modules import only each other and ../shared.ts', () => {
    const bad: string[] = [];
    for (const f of clientFiles) {
      for (const spec of sourceImports(read(join(CLIENT, f)))) {
        const ok = (/^\.\/[a-z]+\.ts$/.test(spec) && clientFiles.includes(spec.slice(2))) || spec === '../shared.ts';
        if (!ok) bad.push(`client/${f}: ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('shared.ts has no runtime import: only `export type ... from` (and `import type`)', () => {
    const src = read(join(PANEL, 'shared.ts'));
    const lines = src.split('\n').filter((l) => /^\s*(?:import|export)\b.*\bfrom\b/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l, l).toMatch(/^\s*(?:export|import) type\b/);
    expect(importSpecifiers(stripModule(src))).toEqual([]);
  });

  it('no client module but boot.ts reads a browser or Node global (they come through start(env))', () => {
    const globals = /\b(?:window|document|globalThis|self|navigator|localStorage|sessionStorage|location|history|fetch|XMLHttpRequest|EventSource|WebSocket|setTimeout|setInterval|clearTimeout|clearInterval|requestAnimationFrame|performance|atob|btoa|console|process|require|Buffer|__dirname)\b/g;
    const bad: string[] = [];
    for (const f of clientFiles.filter((x) => x !== 'boot.ts')) {
      const code = codeOnly(read(join(CLIENT, f)));
      for (const m of code.matchAll(globals)) {
        const before = code.slice(Math.max(0, m.index - 1), m.index);
        if (before === '.' || /\w/.test(before)) continue; // env.fetch, ui.doc, a property
        const after = code.slice(m.index + m[0].length).trimStart();
        if (after.startsWith(':')) continue; // an object key or a type annotation left by a parameter name
        bad.push(`client/${f}: ${m[0]} at ${code.slice(Math.max(0, m.index - 20), m.index + 20).replace(/\s+/g, ' ')}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the server imports only the pure client modules (delta.ts, menu.ts, paint.ts, mapdefs.ts); those import no dom.ts', () => {
    const pure = new Set(['delta.ts', 'menu.ts', 'paint.ts', 'mapdefs.ts']); // decision 0062: the painting and the map's registries
    const bad: string[] = [];
    for (const p of allTs(SRC)) {
      if (p.startsWith(CLIENT + sep)) continue;
      const from = relative(SRC, p).split(sep).join('/');
      for (const spec of sourceImports(read(p))) {
        if (!spec.startsWith('.')) continue;
        const target = posix.normalize(posix.join(posix.dirname(from), spec));
        const m = /^health\/panel\/client\/(.+)$/.exec(target);
        if (m && !pure.has(m[1]!)) bad.push(`${from}: ${spec}`);
      }
    }
    expect(bad).toEqual([]);
    for (const f of pure) expect(sourceImports(read(join(CLIENT, f))).filter((s) => s !== '../shared.ts' && !pure.has(s.replace(/^\.\//, '')))).toEqual([]); // each other and shared.ts only
  });

  it('every module is reachable from the entry, and loading them gives the import graph', () => {
    const mods = loadClientModules();
    const byPath = new Map(mods.map((m) => [m.path, m]));
    // every file but the type-only ones (page.ts: nothing left after stripping, so not served)
    const typeOnly = clientFiles.filter((f) => codeOnly(read(join(CLIENT, f))).trim() === '');
    expect(typeOnly).toEqual(['page.ts']);
    expect([...byPath.keys()].sort()).toEqual(['shared.ts', ...clientFiles.filter((f) => !typeOnly.includes(f)).map((f) => `client/${f}`)].sort());
    const seen = new Set<string>();
    const walk = (p: string): void => {
      if (seen.has(p)) return;
      seen.add(p);
      for (const i of byPath.get(p)!.imports) walk(i);
    };
    walk(ENTRY_MODULE);
    expect([...byPath.keys()].filter((p) => !seen.has(p))).toEqual([]);
    for (const m of mods) {
      expect(m.code).not.toMatch(/^\s*import type\b/m); // stripped
      expect(m.code).not.toMatch(/:\s*(?:string|number|boolean)\b[,)=]/); // no annotations left
    }
  });

  it('loadClientModules refuses a server import, a dynamic import, and an import that strips to nothing', () => {
    const dir = join(tmpdir(), `bbpanel-mods-${process.pid}-${Date.now()}`);
    mkdirSync(join(dir, 'client'), { recursive: true });
    writeFileSync(join(dir, 'shared.ts'), 'export const A = 1;\n');
    writeFileSync(join(dir, 'client/boot.ts'), "import { A } from '../shared.ts';\nimport { start } from './main.ts';\nstart(A);\n");
    writeFileSync(join(dir, 'client/main.ts'), 'export function start(n: number): number { return n; }\n');
    expect(loadClientModules(dir).map((m) => m.path)).toEqual(['shared.ts', 'client/boot.ts', 'client/main.ts']);
    writeFileSync(join(dir, 'client/bad.ts'), "import { readFileSync } from 'node:fs';\nimport { state } from '../state.ts';\nimport { type El } from './main.ts';\nexport const f = () => import('./main.ts');\nexport const g = (x: El) => [readFileSync, state, x];\n");
    let err = '';
    try {
      loadClientModules(dir);
    } catch (e) {
      err = (e as Error).message;
    }
    expect(err).toContain('client/bad.ts: imports node:fs');
    expect(err).toContain('client/bad.ts: imports ../state.ts');
    expect(err).toContain('import {} from');
    expect(err).toContain('dynamic import()');
  });
});
