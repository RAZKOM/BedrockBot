// A command's reply as Discord messages (Track D2, docs/discord.md "Replies"): the lines the game chat shows, laid out
// for a phone by a few rules on the shape of a line, never per command. The words stay the game chat's own; only the
// layout is Discord's.
//
//   replyMessages(['pos 10.50 64.00 -3.50'])          // ['pos 10.50 64.00 -3.50']
//   replyMessages(['status: up 1h02m, session ...'])  // ['**status**\n**up** 1h02m · **session** 12m03s\n...']
//
// The rules, in order (each line on its own, after the colour codes and control characters are taken out):
// 1. Code: a run of 2 or more lines laid out in columns (two spaces or more between words), or of 3 or more lines that
//    each hold a coordinate triple, is one code block: there the alignment is the content.
// 2. A list: a line longer than PHONE_WIDTH made of `;` parts (`head: a; b; c`) is the head in bold and a bullet per
//    part; a line `head: k v, k v, ...` of 5 or more one-word `key value` parts is the head and the pairs a few to a row
//    (ROW_WIDTH), each key in bold. Consecutive lists under the same head are one list (`!discord` says `discord bot:`
//    twice).
// 3. Anything else is one plain line, its markdown escaped (escapeMarkdown), so `diamond_sword` reads as typed.
// Then the lines are packed into at most REPLY_PARTS messages of CONTENT_MAX characters, split between lines; what does
// not fit is counted in the last line.
import { CONTENT_MAX, cutText, plainLine, REPLY_PARTS } from './discord-access.ts';
import { escapeMarkdown } from './discord.ts';

/** A line this long or shorter reads on one line of a phone: it stays as it is. */
export const PHONE_WIDTH = 60;
/** Parts at least in a `key value` list. */
export const PAIRS_MIN = 5;
/** A row of `key value` pairs at most (visible characters): what a phone shows on one line in Discord's font. */
export const ROW_WIDTH = 34;

/** Split at `sep` outside brackets: `a (b, c), d` -> [`a (b, c)`, `d`]. */
export function topSplit(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if ((ch === ')' || ch === ']' || ch === '}') && depth > 0) depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((p) => p.trim()).filter((p) => p !== '');
}

const HEAD_RE = /^([^:;,()[\]]{1,32}?): (.+)$/;
const PAIR_RE = /^([a-z][\w-]{0,15}) (\S.*)$/;
const LABEL_RE = /^([a-z][\w -]{0,15}): (.+)$/i;
const COLUMNS_RE = /\S {2,}\S/;
const COORDS_RE = /-?\d+(?:\.\d+)? -?\d+(?:\.\d+)? -?\d+(?:\.\d+)?/;

type Block = { kind: 'line'; text: string } | { kind: 'list'; head: string | undefined; lead: string | undefined; items: { key?: string; text: string }[] } | { kind: 'code'; lines: string[] };

/** A line as a list, or undefined (rule 2). */
function listOf(line: string): Extract<Block, { kind: 'list' }> | undefined {
  if (line.length <= PHONE_WIDTH) return undefined;
  const parts = topSplit(line, ';');
  if (parts.length >= 2) {
    const m = HEAD_RE.exec(parts[0]!);
    if (m) return { kind: 'list', head: m[1], lead: undefined, items: [m[2]!, ...parts.slice(1)].map((text) => ({ text })) };
    return { kind: 'list', head: undefined, lead: parts[0], items: parts.slice(1).map((text) => ({ text })) };
  }
  const m = HEAD_RE.exec(line);
  if (!m) return undefined;
  const pairs = topSplit(m[2]!, ',');
  if (pairs.length < PAIRS_MIN || !pairs.every((p) => PAIR_RE.test(p))) return undefined;
  return { kind: 'list', head: m[1], lead: undefined, items: pairs.map((p) => ({ key: PAIR_RE.exec(p)![1]!, text: PAIR_RE.exec(p)![2]! })) };
}

/** The reply's lines as blocks (rules 1 to 3). */
export function replyBlocks(lines: readonly string[]): Block[] {
  const clean = lines.flatMap((l) => plainLine(l).split('\n')).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '');
  const blocks: Block[] = [];
  for (let i = 0; i < clean.length; ) {
    // rule 1: a run of column lines (2+) or coordinate lines (3+)
    let j = i;
    while (j < clean.length && COLUMNS_RE.test(clean[j]!.trim())) j++;
    if (j - i >= 2) {
      blocks.push({ kind: 'code', lines: clean.slice(i, j) });
      i = j;
      continue;
    }
    j = i;
    while (j < clean.length && COORDS_RE.test(clean[j]!)) j++;
    if (j - i >= 3) {
      blocks.push({ kind: 'code', lines: clean.slice(i, j) });
      i = j;
      continue;
    }
    const line = clean[i]!;
    const list = listOf(line);
    const prev = blocks.at(-1);
    if (list && prev?.kind === 'list' && list.head !== undefined && prev.head === list.head) prev.items.push(...list.items);
    else blocks.push(list ?? { kind: 'line', text: line });
    i++;
  }
  return blocks;
}

/** A list item: `- **in:** 3 run, ...` (a short label in bold), `- **up** 1h02m` (a pair's key in bold), else `- text`. */
function itemText(it: { key?: string; text: string }): string {
  if (it.key) return `- **${escapeMarkdown(it.key)}** ${escapeMarkdown(it.text)}`;
  const m = LABEL_RE.exec(it.text);
  return m ? `- **${escapeMarkdown(m[1]!)}:** ${escapeMarkdown(m[2]!)}` : `- ${escapeMarkdown(it.text)}`;
}

/**
 * `key value` pairs a few to a row (`**up** 1h02m · **session** 12m03s`), a row at most ROW_WIDTH visible characters, so a
 * row never wraps on a phone and a pair never breaks across rows; a longer pair has a row of its own.
 */
function pairRows(items: readonly { key: string; text: string }[]): string[] {
  const rows: string[] = [];
  let cur: string[] = [];
  let width = 0;
  for (const it of items) {
    const w = it.key.length + 1 + it.text.length;
    if (cur.length && width + 3 + w > ROW_WIDTH) {
      rows.push(cur.join(' · '));
      cur = [];
      width = 0;
    }
    width += (cur.length ? 3 : 0) + w;
    cur.push(`**${escapeMarkdown(it.key)}** ${escapeMarkdown(it.text)}`);
  }
  if (cur.length) rows.push(cur.join(' · '));
  return rows;
}

/** The blocks as units: lines that may end one message and start the next (a code block is one unit, or a few fenced pieces). */
function unitsOf(blocks: readonly Block[], max: number): string[] {
  const out: string[] = [];
  const room = max - 8; // a fence's two lines
  for (const b of blocks) {
    if (b.kind === 'line') out.push(cutText(escapeMarkdown(b.text), max));
    else if (b.kind === 'list') {
      if (b.head !== undefined) out.push(cutText(`**${escapeMarkdown(b.head)}**`, max));
      if (b.lead !== undefined) out.push(cutText(escapeMarkdown(b.lead), max));
      if (b.items.every((it) => it.key !== undefined)) out.push(...pairRows(b.items as { key: string; text: string }[]).map((r) => cutText(r, max)));
      else for (const it of b.items) out.push(cutText(itemText(it), max));
    } else {
      let cur: string[] = [];
      let size = 0;
      for (const raw of b.lines) {
        const l = cutText(raw, room);
        if (cur.length && size + 1 + l.length > room) {
          out.push(`\`\`\`\n${cur.join('\n')}\n\`\`\``);
          cur = [];
          size = 0;
        }
        size += (cur.length ? 1 : 0) + l.length;
        cur.push(l);
      }
      if (cur.length) out.push(`\`\`\`\n${cur.join('\n')}\n\`\`\``);
    }
  }
  return out;
}

/**
 * The lines a command said, as Discord messages (the rules above): at most `parts` messages of at most `max` characters,
 * split between units; the last says how many units were left out.
 */
export function replyMessages(lines: readonly string[], parts = REPLY_PARTS, max = CONTENT_MAX): string[] {
  const units = unitsOf(replyBlocks(lines), max);
  if (!units.length) return [];
  const tail = (n: number): string => `... ${n} more line${n === 1 ? '' : 's'} (the game chat and the panel have them)`;
  const out: string[] = [];
  let cur: string[] = [];
  let size = 0;
  let i = 0;
  for (; i < units.length; i++) {
    const u = units[i]!;
    const add = (cur.length ? 1 : 0) + u.length;
    if (cur.length && size + add > max) {
      if (out.length === parts - 1) break;
      out.push(cur.join('\n'));
      cur = [];
      size = 0;
    }
    size += (cur.length ? 1 : 0) + u.length;
    cur.push(u);
  }
  if (i < units.length) {
    let left = units.length - i;
    while (cur.length && size + 1 + tail(left + 1).length > max) {
      size -= cur.pop()!.length + (cur.length ? 1 : 0);
      left++;
    }
    cur.push(tail(left));
  }
  if (cur.length) out.push(cur.join('\n'));
  return out;
}
