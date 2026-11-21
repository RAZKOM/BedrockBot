// Track REL1: the docs index (docs/README.md) links every guide and every decision, and its decisions list is the one
// scripts/docs-index.mjs makes from the files. A new guide or ADR without a line in the index fails here.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const DOCS = join(ROOT, 'docs');
const index = readFileSync(join(DOCS, 'README.md'), 'utf8');
const links = new Set([...index.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map((m) => m[1] ?? ''));

describe('docs index', () => {
  it('links every guide in docs/', () => {
    const guides = readdirSync(DOCS).filter((f) => f.endsWith('.md') && f !== 'README.md');
    expect(guides.length).toBeGreaterThan(30);
    expect(guides.filter((g) => !links.has(g))).toEqual([]);
  });

  it('links every decision with its title, in number order', () => {
    const adrs = readdirSync(join(DOCS, 'decisions')).filter((f) => f.endsWith('.md')).sort();
    expect(adrs.filter((f) => !links.has(`decisions/${f}`))).toEqual([]);
    const listed = [...index.matchAll(/^- \[(\d{4})\]\(decisions\/([^)]+)\): (.+)$/gm)];
    expect(listed.map((m) => m[2] ?? '')).toEqual(adrs);
    for (const m of listed) {
      const first = readFileSync(join(DOCS, 'decisions', m[2] ?? ''), 'utf8').split(/\r?\n/, 1)[0];
      expect(first).toContain(m[3] ?? '');
    }
  });

  it('has no link to a missing file', () => {
    const missing = [...links].filter((l) => !/^[a-z]+:/i.test(l) && !existsSync(join(DOCS, l)));
    expect(missing).toEqual([]);
  });

  it('the README links the index, the first guide and media that exist', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    expect(readme).toContain('docs/README.md');
    expect(readme).toContain('docs/getting-started.md');
    const media = [...readme.matchAll(/\]\((docs\/media\/[^)]+)\)/g)].map((m) => m[1] ?? '');
    expect(media.length).toBeGreaterThan(4);
    expect(media.filter((m) => !existsSync(join(ROOT, m)))).toEqual([]);
  });

  it('scripts/docs-index.mjs --check passes', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'docs-index.mjs'), '--check'], { encoding: 'utf8' });
    expect(r.stdout + r.stderr).toMatch(/docs index ok/);
    expect(r.status).toBe(0);
  });
});
