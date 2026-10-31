// Chat style: colours and multi-line blocks for the bot's chat replies.
// Guide: docs/chat-style.md. Decision: docs/decisions/0050-chat-style.md. READ THE GUIDE before you
// print more than one line or want a colour.
//
// The rules in one screen (the guide has the recipes):
//   1. This is the ONLY file that builds section-sign codes. Never type one in a reply (a unit test,
//      test/unit/chat/style.test.ts, fails on any other file that has one, except the ones that only
//      STRIP codes from names).
//   2. A one-line reply needs nothing: `reply('text')`. When the owner turns `chatColor` on, Chat.say()
//      runs colorize() over it (commands, numbers, done / failed words, a trailing note in gray).
//   3. A reply of several lines or parts (a list, a table, help) is a Doc, built with
//      `chat.layout(plainLines, (d) => { ... })`, which returns the Doc's messages when `chatLines` is on
//      and `plainLines` untouched when it is off. Write both once; never branch on the modes yourself.
//   4. The text stays readable with every code removed: strip(message) is what the tests compare, and what
//      the bot logs. Colour only ever adds emphasis, never information.
//   5. Server limits (measured on BDS 1.26.60.6, docs/chat-style.md "Limits"): a chat message of 503
//      characters is relayed, 523 is DROPPED WITHOUT AN ERROR. Every message that leaves Chat.say() is
//      at most MAX_WIRE characters, codes included; Doc packs to that.

const S = '§';

/** The section sign, for the rare place that must test for "already styled" (Chat.say). */
export const SECTION = S;

/** Hard cap for one chat message with its codes (the server drops longer ones silently). */
export const MAX_WIRE = 480;

/** Default size of one Doc message (visible text plus codes). Leaves room for the codes up to MAX_WIRE. */
export const DOC_MESSAGE = 440;

/** What a piece of text means. One place decides how each looks (CODE below). */
export type Tone =
  | 'cmd' //  a command the owner can type: !get, !help settings
  | 'ok' //    good news: done, saved, on
  | 'bad' //   bad news: failed, no path, refused
  | 'warn' //  needs attention: a question, stopped, low
  | 'num' //   a number, a coordinate, a count
  | 'dim' //   context: hints, notes, units, off
  | 'head' //  the title of a block
  | 'sub' //   a section heading inside a block
  | 'name'; // a name of something: a waypoint, an item, a player

/** Dark colours (0, 1, 8) are left out on purpose: the chat background is dark. */
const CODE: Readonly<Record<Tone, string>> = {
  cmd: `${S}b`,
  ok: `${S}a`,
  bad: `${S}c`,
  warn: `${S}e`,
  num: `${S}6`,
  dim: `${S}7`,
  head: `${S}6${S}l`,
  sub: `${S}e${S}l`,
  name: `${S}d`,
};

const RESET = `${S}r`;

/** Which switches are on (the settings `chatColor` and `chatLines`). */
export interface StyleMode {
  /** Add colour codes. */
  color: boolean;
  /** Use multi-line blocks (Doc) for long answers instead of the one-line packed ones. */
  lines: boolean;
  /** Size of one Doc message when it is not DOC_MESSAGE: smaller on the tellraw route, whose command wraps the text (route.ts). */
  block?: number;
}

export const PLAIN_MODE: StyleMode = { color: false, lines: false };

/** `text` in a tone when colour is on, else `text`. The code ends with a reset: nothing leaks into the next word. */
export function paint(tone: Tone, text: string, color: boolean): string {
  return color && text.length > 0 ? `${CODE[tone]}${text}${RESET}` : text;
}

/** Remove every code (the form the logs, the tests and the model see). Also a dangling trailing sign. */
export function strip(s: string): string {
  return s.replace(/§[\s\S]?/g, '');
}

/** True when the text carries codes. */
export function isStyled(s: string): boolean {
  return s.includes(S);
}

// ---- automatic colour for one-line replies --------------------------------------------------------

/** Words that colour a reply by what it says; only looked for near its start (a verdict opens a reply). */
const OK_WORDS = /\b(?:done|ok|saved|started|arrived|resumed|success(?:ful)?|completed?|ready|finished)\b/i;
const BAD_WORDS = /\b(?:failed|fail|cannot|can't|couldn't|could not|refused|unreachable|no path|not available|unknown|error|stuck|died|not safe)\b/i;
const WARN_WORDS = /\b(?:stopped|paused|cancelled|canceled|nothing to|no command|missing|low)\b/i;
const VERDICT_WINDOW = 60;

/** Matches that colour on their own: `!command`, and a number that is not part of a word or a version. */
const TOKENS = /(?<![\w/])!(?<cmd>[a-z][\w-]*)|(?<![\w.])(?<num>-?\d+(?:\.\d+)?)(?![\w.])/g;

interface Span {
  start: number;
  end: number;
  tone: Tone;
}

function spans(text: string, words: boolean): Span[] {
  const found: Span[] = [];
  for (const m of text.matchAll(TOKENS)) {
    const tone: Tone = m.groups?.cmd !== undefined ? 'cmd' : 'num';
    found.push({ start: m.index, end: m.index + m[0].length, tone });
  }
  if (words) {
    const head = text.slice(0, VERDICT_WINDOW);
    for (const [re, tone] of [[BAD_WORDS, 'bad'], [OK_WORDS, 'ok'], [WARN_WORDS, 'warn']] as const) {
      const m = re.exec(head);
      if (m && !found.some((f) => m.index < f.end && m.index + m[0].length > f.start)) {
        found.push({ start: m.index, end: m.index + m[0].length, tone });
        break; // one verdict per reply: the worst news first
      }
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** `text` with its spans painted; `base` is the tone the surrounding text is in (it is re-opened after each span). */
function paintSpans(text: string, words: boolean, base?: Tone): string {
  let out = '';
  let at = 0;
  for (const sp of spans(text, words)) {
    out += text.slice(at, sp.start) + `${CODE[sp.tone]}${text.slice(sp.start, sp.end)}${RESET}${base ? CODE[base] : ''}`;
    at = sp.end;
  }
  return out + text.slice(at);
}

/**
 * The automatic colour of a one-line reply (Chat.say calls it when `chatColor` is on):
 * `!commands` aqua, numbers gold, one verdict word green / red / yellow near the start, and a note in
 * parentheses at the end gray. A text that already carries codes is returned unchanged. strip(colorize(x)) === x.
 */
export function colorize(text: string): string {
  if (isStyled(text) || text.length === 0) return text;
  const note = /\s\([^()]*\)$/.exec(text);
  const main = note ? text.slice(0, note.index) : text;
  const tail = note ? ` ${CODE.dim}${paintSpans(note[0].trim(), false, 'dim')}${RESET}` : '';
  return paintSpans(main, true) + tail;
}

/** `styled` when it fits the wire limit, else the plain fallback cut to fit (the server would drop a longer one). */
export function fitWire(styled: string, fallback: string): string {
  if (styled.length <= MAX_WIRE) return styled;
  const plain = strip(fallback);
  return plain.length <= MAX_WIRE ? plain : `${plain.slice(0, MAX_WIRE - 3)}...`;
}

// ---- Doc: a multi-line answer ----------------------------------------------------------------------

/** A value in a pairs table: `key value`, the value in a tone (default: by what it looks like). */
export interface Pair {
  key: string;
  value: string;
  tone?: Tone;
}

/** The tone a bare value gets: on green, off gray, a number gold, anything else none. */
export function valueTone(v: string): Tone | undefined {
  if (v === 'on' || v === 'true') return 'ok';
  if (v === 'off' || v === 'false' || v === 'none') return 'dim';
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return 'num';
  return undefined;
}

interface Section {
  heading?: string;
  headingPlain?: string;
  lines: string[];
}

/**
 * A structured answer that prints as a few multi-line messages: a title, sections with a heading each,
 * lines under them, a footer note. Build it, then `messages()`. It packs sections into messages of at
 * most `max` characters, never splits a line, and when a section runs over to the next message it
 * repeats the heading there with `(cont.)`, so no message is a headless blob.
 *
 *   const d = new Doc({ color: true, lines: true });
 *   d.title('settings', '64 settings');
 *   d.section('safety');
 *   d.pairs([{ key: 'fleeHealth', value: '12' }]);
 *   d.note('!set <key> explains one');
 *   for (const m of d.messages()) reply(m);
 *
 * Prefer `chat.layout(plain, build)`, which makes the Doc with the live modes and falls back to `plain`.
 */
export class Doc {
  readonly mode: StyleMode;
  private readonly max: number;
  private readonly width: number;
  private titleLine: string | undefined;
  private readonly sections: Section[] = [{ lines: [] }];
  private footer: string | undefined;

  constructor(mode: StyleMode, o: { max?: number; width?: number } = {}) {
    this.mode = mode;
    this.max = Math.min(o.max ?? mode.block ?? DOC_MESSAGE, MAX_WIRE);
    this.width = o.width ?? 46;
  }

  private p(tone: Tone, text: string): string {
    return paint(tone, text, this.mode.color);
  }

  /** Text with its commands and numbers coloured (colour off: unchanged). */
  private rich(text: string, base?: Tone): string {
    if (!this.mode.color) return text;
    const body = paintSpans(text, false, base);
    return base ? `${CODE[base]}${body}${RESET}` : body;
  }

  /** The block's title, once, at the top: `settings` + gray context. */
  title(text: string, meta?: string): this {
    this.titleLine = this.p('head', strip(text)) + (meta ? ` ${this.p('dim', strip(meta))}` : '');
    return this;
  }

  /** A new section with a heading line; the lines added next belong to it. */
  section(name: string, meta?: string): this {
    this.sections.push({
      heading: this.p('sub', strip(name)) + (meta ? ` ${this.p('dim', strip(meta))}` : ''),
      headingPlain: strip(name),
      lines: [],
    });
    return this;
  }

  private add(line: string): this {
    this.sections[this.sections.length - 1]!.lines.push(line);
    return this;
  }

  // Every method below strips codes from the text it is given: a name a player chose (a waypoint, a box,
  // a setting value) cannot inject colour or break the layout.

  /** `!come  come to you`: a command and what it does (commands and numbers in the text are coloured). */
  item(command: string, text = ''): this {
    return this.add(`${this.p('cmd', strip(command))}${text ? `  ${this.rich(strip(text))}` : ''}`);
  }

  /** One free line; `!commands` and numbers in it are coloured. */
  line(text: string): this {
    return this.add(this.rich(strip(text)));
  }

  /** One gray line (context: where a thing belongs, a unit, a caveat). */
  dim(text: string): this {
    return this.add(this.p('dim', strip(text)));
  }

  /** One line wholly in a tone (`d.tone('bad', 'no path to the mine')`). Use it when YOU know the meaning; the words are not guessed. */
  tone(tone: Tone, text: string): this {
    return this.add(this.p(tone, strip(text)));
  }

  /** Tokens (names, commands) side by side, wrapped to the block's width. */
  tokens(items: readonly string[], tone: Tone = 'cmd'): this {
    return this.wrap(items.map((t) => ({ plain: strip(t), shown: this.p(tone, strip(t)) })), ' ');
  }

  /** `key value  key value` pairs wrapped to the block's width; the value's tone by what it is (valueTone). */
  pairs(entries: readonly Pair[]): this {
    return this.wrap(
      entries.map((e) => {
        const value = strip(e.value);
        const tone = e.tone ?? valueTone(value);
        return { plain: `${strip(e.key)} ${value}`, shown: `${strip(e.key)} ${tone ? this.p(tone, value) : value}` };
      }),
      '  ',
    );
  }

  private wrap(parts: readonly { plain: string; shown: string }[], sep: string): this {
    let plainLen = 0;
    let line = '';
    for (const part of parts) {
      if (line && plainLen + sep.length + part.plain.length > this.width) {
        this.add(line);
        line = '';
        plainLen = 0;
      }
      line += (line ? sep : '') + part.shown;
      plainLen += (plainLen ? sep.length : 0) + part.plain.length;
    }
    return line ? this.add(line) : this;
  }

  /** The footer: gray, last, with the commands in it coloured. */
  note(text: string): this {
    this.footer = this.rich(strip(text), 'dim');
    return this;
  }

  /** The finished messages (each at most `max` characters, codes included); at least one. */
  messages(): string[] {
    const out: string[] = [];
    let cur: string[] = [];
    let curLen = 0;
    const push = (): void => {
      if (cur.length) out.push(cur.join('\n'));
      cur = [];
      curLen = 0;
    };
    const room = (line: string): boolean => curLen + (cur.length ? 1 : 0) + line.length <= this.max;
    const put = (line: string): void => {
      const l = line.length > this.max ? `${strip(line).slice(0, this.max - 3)}...` : line;
      if (!room(l)) push();
      curLen += (cur.length ? 1 : 0) + l.length;
      cur.push(l);
    };
    if (this.titleLine) put(this.titleLine);
    for (const sec of this.sections) {
      if (sec.heading === undefined && sec.lines.length === 0) continue;
      if (sec.heading !== undefined) {
        // a heading is never left alone at the end of a message: keep it with its first line
        if (sec.lines.length && !room(`${sec.heading}\n${sec.lines[0]!}`)) push();
        put(sec.heading);
      }
      sec.lines.forEach((l, i) => {
        if (i > 0 && !room(l) && sec.heading !== undefined) {
          push();
          put(`${this.p('sub', sec.headingPlain ?? '')} ${this.p('dim', '(cont.)')}`);
        }
        put(l);
      });
    }
    if (this.footer) put(this.footer);
    push();
    return out.length ? out : [''];
  }
}
