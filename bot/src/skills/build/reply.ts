// Track B5 (ADR 0130, docs/build.md "Replies that fit the chat"): every `!build` reply fits the chat. A reply is at most
// REPLY_LINES lines of at most LINE_BYTES bytes, summary first; what it leaves out it says (`+N more`) and keeps: the
// controller stores the full text, logs it, `!build more [page]` pages through it and the panel's GET /api/build
// returns it. Pure: strings in, lines out (the controller, chat/commands-build.ts, says them).
//
// Why 3 lines: the chat sends 8 messages in 10 s (Chat maxReplies / replyWindowMs); past that at most 16 wait
// (REPLY_QUEUE_MAX), the lines of one command joined while the joined text stays within 480 bytes (MAX_WIRE). A build
// line is up to 250 bytes, so two of them never join (250 + 3 + 250 > 480): every line takes a slot. Three lines a reply
// leave 5 of the 8 for everything else in the window, and 8 replies typed in one burst (24 lines) still fit 8 sent and
// 16 waiting. Before, `!build materials` of a 125-kind house said dozens of lines and the queue dropped all but 24.
import { BILL_LINE_MAX, billItemText, billSteps, packLines, stepWords, type Bill } from './bill.ts';
import { materialsNotes, type Materials } from './materials.ts';

/** Lines a `!build` reply says at most. */
export const REPLY_LINES = 3;
/** Bytes a line has at most (the chat cuts a reply at 256 characters; the hint and the colour codes fit after it). */
export const LINE_BYTES = BILL_LINE_MAX;
/** Lines a page of `!build more` says (one reply's worth). */
export const PAGE_LINES = REPLY_LINES;
/** Bytes a page's lines leave free on its last line for the page note (` (page 12 of 12: !build more 13)`). */
export const PAGE_NOTE_ROOM = 40;
/** Bytes a line of a full text has at most (packed to this width, a page's last line takes the note without a split). */
export const FULL_BYTES = LINE_BYTES - PAGE_NOTE_ROOM;
/** Lines of a full text kept at most (a 262 144-block build of 1 000 kinds is about 200). */
export const FULL_MAX_LINES = 400;
/** How a reply that was cut says where the rest is. */
export const MORE = '!build more';

export const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/** `s` cut to at most `max` bytes (whole characters), with `...` when cut. */
export function cutBytes(s: string, max: number): string {
  if (bytes(s) <= max) return s;
  let out = '';
  for (const ch of s) {
    if (bytes(`${out}${ch}...`) > max) break;
    out += ch;
  }
  return `${out}...`;
}

/**
 * A line as lines of at most `max` bytes, split after a list separator (`, `, `; `, ` | `), else after a space; a word
 * longer than a line is cut. A line that fits comes back as it is.
 */
export function wrapLine(text: string, max = LINE_BYTES): string[] {
  if (bytes(text) <= max) return [text];
  const out: string[] = [];
  let cur = '';
  const flush = (): void => {
    const t = cur.trimEnd();
    if (t) out.push(t);
    cur = '';
  };
  const add = (piece: string): void => {
    if (bytes(cur + piece.trimEnd()) <= max) {
      cur += piece;
      return;
    }
    flush();
    if (bytes(piece.trimEnd()) <= max) {
      cur = piece;
      return;
    }
    for (const w of piece.split(/(?<= )/)) {
      if (bytes(cur + w.trimEnd()) <= max) cur += w;
      else {
        flush();
        cur = bytes(w.trimEnd()) <= max ? w : `${cutBytes(w.trimEnd(), max)} `;
      }
    }
  };
  for (const p of text.split(/(?<=, |; | \| )/)) add(p);
  flush();
  return out;
}

/** Every line of a text wrapped to `max` bytes. */
export function wrapAll(lines: readonly string[], max = LINE_BYTES): string[] {
  return lines.flatMap((l) => wrapLine(l, max));
}

/**
 * `head` + as many `entries` as fit (joined by `sep`) + `, +K more` for the rest + `tail`, in at most `n` lines of `max`
 * bytes (`+K more steps` with a `noun`). With no room for one entry: `+K more` alone.
 */
export function fitEntries(head: string, entries: readonly string[], tail = '', n = 1, max = LINE_BYTES, sep = ', ', noun = ''): string[] {
  const text = (k: number): string => {
    const shown = entries.slice(0, k).join(sep);
    const rest = entries.length - k;
    return `${head}${shown}${rest > 0 ? `${shown ? sep : ''}+${rest} more${noun ? ` ${noun}` : ''}` : ''}${tail}`;
  };
  const fits = (k: number): boolean => wrapLine(text(k), max).length <= n;
  if (fits(entries.length)) return wrapLine(text(entries.length), max);
  // the most entries that fit (the lines grow with k; the `+K more` digits only shrink)
  let lo = 0;
  let hi = entries.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  const lines = wrapLine(text(lo), max);
  return lines.length <= n ? lines : wrapAll([cutBytes(text(lo), n * max)], max).slice(0, n);
}

/** `name n` entries of a count map, the biggest first. */
export function countEntries(m: Iterable<readonly [string, number]>, numberFirst = false): string[] {
  return [...m]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => (numberFirst ? `${n} ${k}` : `${k} ${n}`));
}

export interface Fitted {
  /** What the reply says (at most `n` lines of `max` bytes). */
  lines: string[];
  /** Something was left out (the full text is worth keeping). */
  cut: boolean;
}

/**
 * The generic fit: the lines wrapped; when they are more than `n`, the first `n - 1` and the `n`th cut where it is full
 * with `... (+K more lines: !build more)` (K: the lines left out, the cut one counting).
 */
export function fitLines(full: readonly string[], n = REPLY_LINES, max = LINE_BYTES, more = MORE): Fitted {
  const all = wrapAll(full, max);
  if (all.length <= n) return { lines: all, cut: false };
  const k = all.length - (n - 1);
  const tail = ` (+${k} more line${k === 1 ? '' : 's'}: ${more})`;
  const last = wrapLine(all[n - 1]!, max - bytes(tail) - 3)[0] ?? '';
  return { lines: [...all.slice(0, n - 1), `${last}...${tail}`], cut: true };
}

/** One page of a full text (PAGE_LINES lines; the last says `(page p of P: !build more p+1)`); page 1 is the first. */
export function pageLines(full: readonly string[], page: number, more = MORE): { lines: string[]; page: number; pages: number } {
  const all = wrapAll(full, FULL_BYTES);
  const pages = Math.max(1, Math.ceil(all.length / PAGE_LINES));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const lines = all.slice((p - 1) * PAGE_LINES, p * PAGE_LINES);
  if (lines.length === 0) lines.push('(nothing)');
  if (pages > 1) lines[lines.length - 1] = `${lines[lines.length - 1]!} (page ${p} of ${pages}${p < pages ? `: ${more} ${p + 1}` : ''})`;
  return { lines, page: p, pages };
}

// ---- the materials and the bill in a few lines ------------------------------------------------------------------

/**
 * The bill's steps but `cannot get` (the totals line says it), each short: with `top` its biggest entry and `+K more`
 * (`from home: 240 oak_log, +11 more`), else its count of kinds (`from home: 12 kinds`).
 */
export function compactSteps(b: Bill, top = true): string[] {
  const one = <T>(label: string, xs: readonly T[], n: (x: T) => number, text: (x: T) => string): string | undefined => {
    if (xs.length === 0) return undefined;
    const best = [...xs].sort((a, c) => n(c) - n(a))[0]!;
    if (xs.length === 1) return `${label}${text(best)}`;
    return top ? `${label}${text(best)}, +${xs.length - 1} more` : `${label}${xs.length} kinds`;
  };
  const madeFirst = b.crafts.filter((c) => !b.items.some((i) => i.item === c.item));
  return [
    one('from my boxes: ', b.unbox, (x) => x.n, (x) => `${x.n} ${x.item}`),
    one('from home: ', b.bring, (x) => x.n, (x) => `${x.n} ${x.item}`),
    one('!get ', b.get, (x) => x.n, (x) => `${x.item === x.command ? '' : `${x.command} for `}${x.n} ${x.item}`),
    one('craft first ', madeFirst, (x) => x.n, (x) => `${x.n} ${x.item}`),
    b.furnace ? (top ? 'a furnace (8 cobblestone)' : 'a furnace') : undefined,
    one('smelt ', b.smelts, (x) => x.n, (x) => `${x.n} ${x.input} -> ${x.output}`),
    one('fuel ', b.fuel, (x) => x.n, (x) => `${x.n} ${x.item}${x.from ? ` (from ${x.from.n} ${x.from.item})` : ''}`),
  ].filter((s): s is string => s !== undefined);
}

/**
 * The bill's steps (but `cannot get`) in one line: in full when they fit (the house of the e2e: `from home: 24 oak_log,
 * 3 sand, ...; craft first 1 crafting_table; a furnace ...`), else each with its biggest entry, else each with its count
 * of kinds, as many as fit (`+K more steps`).
 */
export function stepsLine(head: string, b: Bill, tail = ''): string {
  const full = billSteps(b).filter((s) => !s.startsWith('cannot get '));
  for (const steps of [full, compactSteps(b, true)]) {
    const line = `${head}${steps.join('; ')}${tail}`;
    if (bytes(line) <= LINE_BYTES) return line;
  }
  return fitEntries(head, compactSteps(b, false), tail, 1, LINE_BYTES, '; ', 'steps')[0]!;
}

export interface MaterialsSummary {
  /** `materials for ` (the materials reply) or `build: ` (a refusal). */
  prefix: string;
  label: string;
  /** What the build places, by item (the plan's materials). */
  materials: Readonly<Record<string, number>>;
  m: Materials;
  /** The bill (when something is missing). */
  bill?: Bill;
  refused?: readonly { name: string; reason: string }[];
  unknown?: readonly { java: string; count: number; reason: string }[];
  /** At the end of the last line: where the rest is, and a hint (`(add fetch ...)`). */
  tail: string;
}

/** The totals line: `materials for X: 9573 blocks, 125 kinds: 2012 have (1500 at home), 2380 to make or !get, 5181 cannot get (smooth_quartz 2297, ..., +18 more)`. */
export function totalsLine(s: MaterialsSummary, cannotAs: 'list' | 'count' | 'none' = 'list', tail = ''): string {
  const total = Object.values(s.materials).reduce((a, n) => a + n, 0);
  const kinds = Object.keys(s.materials).length;
  const head = `${s.prefix}${s.label}: ${total} block${total === 1 ? '' : 's'}, ${kinds} kind${kinds === 1 ? '' : 's'}: `;
  const b = s.bill;
  if (s.m.ok || !b) {
    const boxed = s.m.lines.reduce((a, l) => a + Math.min(l.boxed ?? 0, Math.max(0, l.need - (l.have - (l.boxed ?? 0)))), 0);
    return fitEntries(head, [`have everything${boxed ? ` (${boxed} out of my shulker boxes)` : ''}`], tail)[0]!;
  }
  const have = b.items.reduce((a, i) => a + i.loose + i.boxed + i.home, 0);
  const home = b.items.reduce((a, i) => a + i.home, 0);
  const make = b.items.reduce((a, i) => a + i.make, 0);
  const parts = [`${have} have${home ? ` (${home} at home)` : ''}`];
  if (make) parts.push(`${make} to make or !get`);
  const cannot = b.cannot.reduce((a, c) => a + c.n, 0);
  if (cannotAs === 'count' && cannot) parts.push(`${cannot} cannot get`);
  if (cannotAs !== 'list' || cannot === 0) return fitEntries(head, parts, tail)[0]!;
  return fitEntries(`${head}${parts.join(', ')}, ${cannot} cannot get (`, countEntries(b.cannot.map((c) => [c.item, c.n] as const)), `)${tail}`)[0]!;
}

/** The biggest items by count: `most: smooth_quartz 2297, stone_bricks 900, ..., +115 more`. */
export function mostLine(materials: Readonly<Record<string, number>>, tail = ''): string {
  return fitEntries('most: ', countEntries(Object.entries(materials)), tail)[0]!;
}

/**
 * `!build materials` (and a build refused for its blocks) in REPLY_LINES lines: the totals with what cannot be got, the
 * biggest items, then the bill's steps, the refused and the unknown blocks and the tail.
 */
export function materialsSummary(s: MaterialsSummary): string[] {
  const lines = [totalsLine(s), mostLine(s.materials)];
  const extra: string[] = [];
  if (s.refused?.length) extra.push(`${s.refused.length} refused (${new Set(s.refused.map((r) => r.reason)).size} reason${new Set(s.refused.map((r) => r.reason)).size === 1 ? '' : 's'})`);
  if (s.unknown?.length) {
    const n = s.unknown.reduce((a, u) => a + u.count, 0);
    extra.push(`${n} unknown (${s.unknown.length} kind${s.unknown.length === 1 ? '' : 's'})`);
  }
  const more = extra.length ? `; ${extra.join('; ')}` : '';
  if (s.bill && !s.bill.ok && compactSteps(s.bill).length) lines.push(stepsLine('bill: ', s.bill, `${more}${s.tail}`));
  else if (extra.length) lines.push(fitEntries('', extra, s.tail, 1, LINE_BYTES, '; ')[0]!);
  else lines[1] = mostLine(s.materials, s.tail);
  return lines.map((l) => cutBytes(l, LINE_BYTES));
}

/**
 * The full text of a large materials reply (what `!build more` pages through; the reply itself is materialsSummary): the
 * totals and the notes, the refused blocks in full, the bill's entries but those nothing has or makes (the cannot step
 * names them, one reason for all), the bill's steps, every unknown block. Each fact once, packed to `max` bytes a line.
 */
export function materialsFullDense(s: MaterialsSummary & { scaffolds?: number; refusedText?: string }, max = FULL_BYTES): string[] {
  const notes = materialsNotes(s.m, s.scaffolds ?? 0);
  const out = [`${totalsLine({ ...s, tail: '' }, 'count')}${notes.length ? `; ${notes.join('; ')}` : ''}`];
  if (s.refusedText) out.push(`build: ${s.refusedText}`);
  const b = s.bill;
  if (b && !b.ok) {
    const shown = b.items.filter((it) => !(it.short >= it.need));
    const none = b.items.length - shown.length;
    const entries = shown.map(billItemText);
    out.push(...packLines([`bill for ${s.label}${none ? ` (${none} kind${none === 1 ? '' : 's'} nothing has or makes: see cannot get)` : ''}:`, ...entries.map((e, i) => (i < entries.length - 1 ? `${e} |` : e))], max));
    out.push(...packLines(['bill:', ...stepWords(billSteps(b))], max));
  }
  // the unknown blocks one reason covers together, the reason once
  const by = new Map<string, string[]>();
  for (const u of s.unknown ?? []) by.set(u.reason, [...(by.get(u.reason) ?? []), `${u.java} x ${u.count}`]);
  for (const [why, xs] of by) out.push(...packLines([`unknown (${why}):`, ...xs.map((x, i) => (i < xs.length - 1 ? `${x},` : x))], max));
  return out;
}

/** What cannot be got, grouped (a refused fetch): `cannot get 5181 blocks of 21 kinds (no recipe ...): smooth_quartz 2297, ..., +18 more`. */
export function cannotLine(head: string, cannot: readonly { item: string; n: number; why: string }[], tail = ''): string {
  const n = cannot.reduce((a, c) => a + c.n, 0);
  const by = new Map<string, number>();
  for (const c of cannot) by.set(c.why, (by.get(c.why) ?? 0) + c.n);
  const main = [...by.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const entries = [...cannot].sort((a, b) => b.n - a.n || a.item.localeCompare(b.item)).map((c) => `${c.n} ${c.item}${c.why === main ? '' : ` (${c.why})`}`);
  const what = cannot.length === 1 ? '' : ` ${n} blocks of ${cannot.length} kinds (${by.size === 1 ? main : `mostly: ${main}`})`;
  if (cannot.length === 1) return fitEntries(`${head}cannot get `, [`${entries[0]!} (${main})`], tail)[0]!;
  return fitEntries(`${head}cannot get${what}: `, entries, tail)[0]!;
}
