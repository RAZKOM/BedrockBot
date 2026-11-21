#!/usr/bin/env node
// The docs index (docs/README.md): its list of decisions is made from the ADR files' own titles, so it cannot drift;
// the guides are grouped by hand (one line each, written for a reader), and this script checks none is missing.
//
//   node scripts/docs-index.mjs            print what --check would say
//   node scripts/docs-index.mjs --write    rewrite the decisions list between the markers in docs/README.md
//   node scripts/docs-index.mjs --check    exit 1 when the list is stale, a guide or decision is not linked,
//                                          or a link in the index points at no file
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docs = join(root, 'docs');
const indexFile = join(docs, 'README.md');
export const START = '<!-- decisions:start (made by scripts/docs-index.mjs --write) -->';
export const END = '<!-- decisions:end -->';

/** `- [0007](decisions/0007-config.md): config file outside the repository`, one per ADR, by number. */
export function decisionsList(dir = join(docs, 'decisions')) {
  const files = readdirSync(dir).filter((f) => /^\d{4}-.*\.md$/.test(f)).sort();
  return files.map((f) => {
    const first = readFileSync(join(dir, f), 'utf8').split(/\r?\n/, 1)[0] ?? '';
    const m = /^#\s*(\d{4})\s*:\s*(.*)$/.exec(first);
    const num = f.slice(0, 4);
    const title = m ? m[2].trim() : first.replace(/^#+\s*/, '').trim() || f;
    return `- [${num}](decisions/${f}): ${title}`;
  });
}

export function withDecisions(index, list) {
  const a = index.indexOf(START);
  const b = index.indexOf(END);
  if (a < 0 || b < a) throw new Error(`docs/README.md has no decisions markers (${START} ... ${END})`);
  return `${index.slice(0, a + START.length)}\n${list.join('\n')}\n${index.slice(b)}`;
}

/** Problems with the index: a stale decisions list, a guide or decision not linked, a link to a missing file. */
export function problems(index = readFileSync(indexFile, 'utf8')) {
  const out = [];
  if (index.includes(START) && index.includes(END)) {
    if (withDecisions(index, decisionsList()) !== index) out.push('the decisions list is stale: run node scripts/docs-index.mjs --write');
  } else out.push('no decisions markers in docs/README.md');
  const links = new Set([...index.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map((m) => m[1]));
  for (const f of readdirSync(docs).filter((f) => f.endsWith('.md') && f !== 'README.md').sort()) {
    if (!links.has(f)) out.push(`guide not in the index: docs/${f}`);
  }
  for (const f of readdirSync(join(docs, 'decisions')).filter((f) => f.endsWith('.md')).sort()) {
    if (!links.has(`decisions/${f}`)) out.push(`decision not in the index: docs/decisions/${f}`);
  }
  for (const l of links) {
    if (/^[a-z]+:/i.test(l)) continue; // an outside link: not checked (never fetched)
    if (!existsSync(join(docs, l))) out.push(`link to a missing file: ${l}`);
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? '';
  if (mode === '--write') {
    const index = readFileSync(indexFile, 'utf8');
    const next = withDecisions(index, decisionsList());
    if (next !== index) writeFileSync(indexFile, next);
    console.log(next === index ? 'docs/README.md: decisions list up to date' : `docs/README.md: decisions list written (${decisionsList().length})`);
  }
  const p = problems();
  for (const line of p) console.log(line);
  if (!p.length) console.log(`docs index ok: ${readdirSync(docs).filter((f) => f.endsWith('.md')).length - 1} guides, ${decisionsList().length} decisions`);
  if (mode === '--check' && p.length) process.exit(1);
}
