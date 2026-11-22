// Track REL3 (docs/testing.md "CI"): the GitHub Actions workflow cannot run here (no network to GitHub), so its shape is
// held by this test: it parses (a small YAML reader for the subset the file uses: maps, lists, plain and quoted scalars,
// `|` blocks, no tabs), runs on push and pull request, sets up Node from .nvmrc and pnpm at the package.json pin through
// corepack, caches the pnpm store keyed on the lockfile, and runs exactly the steps the docs name, every one a script or
// file that exists, the unit tests only (no e2e, no perf).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const WORKFLOW = join(ROOT, '.github', 'workflows', 'ci.yml');

type Y = string | null | Y[] | { [k: string]: Y };
type YMap = Record<string, Y>;

/** A reader for the YAML subset of the workflow; throws on anything else (an indent it cannot place, a flow collection). */
function parseYaml(src: string): Y {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  const indentOf = (l: string): number => l.length - l.trimStart().length;
  const blank = (l: string): boolean => /^\s*(#.*)?$/.test(l);
  const skip = (): void => {
    while (i < lines.length && blank(lines[i]!)) i++;
  };
  const scalar = (v: string): string => {
    if (/^[[{]/.test(v)) throw new Error(`line ${i}: flow collections are not read: ${v}`);
    if (/^".*"$/.test(v)) return JSON.parse(v) as string;
    if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
    if (/\s#/.test(v)) throw new Error(`line ${i}: an inline comment is not read: ${v}`);
    return v;
  };
  const block = (keyIndent: number): string => {
    const out: string[] = [];
    let base = -1;
    while (i < lines.length && (lines[i]!.trim() === '' || indentOf(lines[i]!) > keyIndent)) {
      const l = lines[i]!;
      if (l.trim() !== '' && base < 0) base = indentOf(l);
      out.push(l.trim() === '' ? '' : l.slice(base));
      i++;
    }
    while (out.at(-1) === '') out.pop();
    return `${out.join('\n')}\n`;
  };
  const value = (rest: string | undefined, indent: number): Y => {
    if (rest === undefined || rest === '') return node(indent + 1);
    if (rest === '|') return block(indent);
    return scalar(rest);
  };
  const map = (indent: number): YMap => {
    const out: YMap = {};
    for (;;) {
      skip();
      if (i >= lines.length) return out;
      const l = lines[i]!;
      const ind = indentOf(l);
      if (ind < indent) return out;
      if (ind > indent) throw new Error(`line ${i + 1}: indent ${ind}, expected ${indent}: ${l}`);
      const t = l.trim();
      if (t.startsWith('- ') || t === '-') return out;
      const m = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(t);
      if (!m) throw new Error(`line ${i + 1}: not a key: ${l}`);
      const key = m[1]!;
      if (key in out) throw new Error(`line ${i + 1}: key ${key} twice`);
      i++;
      out[key] = value(m[2], ind);
    }
  };
  const list = (indent: number): Y[] => {
    const out: Y[] = [];
    for (;;) {
      skip();
      if (i >= lines.length) return out;
      const l = lines[i]!;
      const ind = indentOf(l);
      const t = l.trim();
      if (ind !== indent || !(t.startsWith('- ') || t === '-')) {
        if (ind > indent) throw new Error(`line ${i + 1}: indent ${ind} in a list at ${indent}: ${l}`);
        return out;
      }
      const rest = t === '-' ? '' : t.slice(2).trim();
      if (rest === '') {
        i++;
        out.push(node(indent + 1));
      } else if (/^[A-Za-z0-9_.-]+:(\s|$)/.test(rest)) {
        lines[i] = `${' '.repeat(indent + 2)}${rest}`; // the item's first key, at the item's indent
        out.push(map(indent + 2));
      } else {
        i++;
        out.push(scalar(rest));
      }
    }
  };
  const node = (minIndent: number): Y => {
    skip();
    if (i >= lines.length) return null;
    const l = lines[i]!;
    const ind = indentOf(l);
    if (ind < minIndent) return null;
    const t = l.trim();
    return t.startsWith('- ') || t === '-' ? list(ind) : map(ind);
  };
  if (src.includes('\t')) throw new Error('a tab in the YAML');
  const out = node(0);
  skip();
  if (i < lines.length) throw new Error(`line ${i + 1}: not read: ${lines[i]}`);
  return out;
}

const asMap = (y: Y | undefined, what: string): YMap => {
  if (!y || typeof y !== 'object' || Array.isArray(y)) throw new Error(`${what}: not a map`);
  return y;
};

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
}

describe('the CI workflow (.github/workflows/ci.yml)', () => {
  const text = readFileSync(WORKFLOW, 'utf8');
  const wf = asMap(parseYaml(text), 'workflow');
  const job = asMap(asMap(wf.jobs, 'jobs').check, 'jobs.check');
  const steps = job.steps as unknown as Step[];
  const runs = steps.map((s) => s.run?.trim()).filter((r): r is string => !!r);
  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string>; packageManager: string };
  const botPkg = JSON.parse(readFileSync(join(ROOT, 'bot', 'package.json'), 'utf8')) as { scripts: Record<string, string> };

  it('the reader reads what it should and refuses what it cannot', () => {
    expect(parseYaml('a: 1\nb:\n  - x\n  - k: v\n    l: w\nc: |\n  one\n  two\n')).toEqual({ a: '1', b: ['x', { k: 'v', l: 'w' }], c: 'one\ntwo\n' });
    expect(() => parseYaml('a:\n\tb: 1\n')).toThrow(/tab/);
    expect(() => parseYaml('a: 1\n   b: 2\n')).toThrow(/indent/);
    expect(() => parseYaml('a: [1, 2]\n')).toThrow(/flow/);
  });

  it('runs on push and pull request, read-only, with a time limit', () => {
    expect(Object.keys(asMap(wf.on, 'on')).sort()).toEqual(['pull_request', 'push']);
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(Number(job['timeout-minutes'])).toBeGreaterThan(0);
  });

  it('Node from .nvmrc, pnpm at the package.json pin through corepack, the pnpm store cached on the lockfile', () => {
    expect(steps[0]!.uses).toMatch(/^actions\/checkout@v\d+$/);
    const node = steps.find((s) => s.uses?.startsWith('actions/setup-node@'))!;
    expect(node.with?.['node-version-file']).toBe('.nvmrc');
    expect(readFileSync(join(ROOT, '.nvmrc'), 'utf8').trim()).toMatch(/^\d+/);
    expect(rootPkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(runs.some((r) => r.split('\n')[0] === 'corepack enable')).toBe(true);
    const cache = steps.find((s) => s.uses?.startsWith('actions/cache@'))!;
    expect(cache.with?.path).toBe('${{ steps.pnpm-store.outputs.dir }}');
    expect(cache.with?.key).toContain("hashFiles('pnpm-lock.yaml')");
    expect(runs).toContain('echo "dir=$(pnpm store path --silent)" >> "$GITHUB_OUTPUT"');
    for (const s of steps) if (s.uses) expect(s.uses, s.uses).toMatch(/^actions\/[a-z-]+@v\d+$/);
    // the order: the toolchain before the cache, the cache before the install
    const at = (f: (s: Step) => boolean) => steps.findIndex(f);
    expect(at((s) => !!s.uses?.startsWith('actions/setup-node@'))).toBeLessThan(at((s) => s.run?.startsWith('corepack enable') ?? false));
    expect(at((s) => !!s.uses?.startsWith('actions/cache@'))).toBeLessThan(at((s) => s.run === 'pnpm install --frozen-lockfile'));
  });

  it('runs install, lint, the unit tests, the docs index check and the no-config doctor, in that order', () => {
    const want = ['pnpm install --frozen-lockfile', 'pnpm lint', 'pnpm test', 'node scripts/docs-index.mjs --check', 'pnpm bot:check -- --no-config'];
    expect(runs.filter((r) => want.includes(r))).toEqual(want);
    for (const s of ['lint', 'test', 'bot:check']) expect(rootPkg.scripts[s], s).toBeDefined();
    expect(existsSync(join(ROOT, 'scripts', 'docs-index.mjs'))).toBe(true);
    // `pnpm test` is the unit project only: the bot's test script names it, no e2e and no perf
    expect(botPkg.scripts.test).toBe('vitest run --project unit');
    expect(text).not.toMatch(/BDS_E2E|test:e2e|--project e2e|test:perf|--project perf/);
  });
});
