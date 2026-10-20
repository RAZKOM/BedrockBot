import type { TextPacket } from '../connection/types.ts';

export interface ChatLine {
  /** Packet text type: chat, announcement (console `say`), whisper (`tell`), json (world.sendMessage), ... */
  type: TextPacket['type'];
  /** Player or sender name without § formatting codes, '' when the packet has none. */
  source: string;
  /** Plain text. For json/rawtext messages the concatenated `text` parts. */
  message: string;
  /** What the sender typed: `message` without the "[Source] " prefix that `say` adds. */
  body: string;
  /** Sender XUID ('' for the console and for offline-mode players). */
  xuid: string;
  /** A truth-pack reply or event (`@truth {...}`, packs/truth/README.md). Never a command. */
  truth: boolean;
}

interface RawTextPart {
  text?: string;
  translate?: string;
  with?: string[] | { rawtext?: RawTextPart[] };
  rawtext?: RawTextPart[];
  selector?: string;
  score?: { name?: string; objective?: string };
}

function flattenRawText(parts: RawTextPart[] | undefined): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => {
      if (typeof part.text === 'string') return part.text;
      if (Array.isArray(part.rawtext)) return flattenRawText(part.rawtext);
      if (typeof part.translate === 'string') {
        const args = Array.isArray(part.with) ? part.with.join(', ') : flattenRawText(part.with?.rawtext);
        return args ? `${part.translate}(${args})` : part.translate;
      }
      if (typeof part.selector === 'string') return part.selector;
      return '';
    })
    .join('');
}

/** Plain text of a rawtext JSON string (`{"rawtext":[{"text":"..."}]}`); the input itself if it is not JSON. */
export function rawTextToPlain(json: string): string {
  try {
    const parsed = JSON.parse(json) as { rawtext?: RawTextPart[] };
    if (parsed && Array.isArray(parsed.rawtext)) return flattenRawText(parsed.rawtext);
  } catch {
    // not JSON: fall through
  }
  return json;
}

/** Remove § formatting codes (BDS appends "§r" to relayed player names). */
export function stripFormatting(s: string): string {
  return s.replace(/§./g, '');
}

/** Marker that starts every truth-pack chat line (`@truth {...}` or `@truth+ <key> i/n ...`). */
export const TRUTH_PREFIX = '@truth';

export function isTruthLine(message: string): boolean {
  return message.startsWith(`${TRUTH_PREFIX} `) || message.startsWith(`${TRUTH_PREFIX}+ `);
}

/**
 * Parse one complete truth reply line (`@truth {"truth":{...}}`). Returns undefined for anything
 * else, including fragments (`@truth+`), which only occur above 256 KiB.
 */
export function parseTruthReply(message: string): TruthReply | undefined {
  if (!message.startsWith(`${TRUTH_PREFIX} `)) return undefined;
  try {
    const parsed = JSON.parse(message.slice(TRUTH_PREFIX.length + 1).trim()) as { truth?: TruthReply };
    return parsed.truth && typeof parsed.truth.cmd === 'string' ? parsed.truth : undefined;
  } catch {
    return undefined;
  }
}

export interface TruthReply {
  cmd: string;
  id: string | null;
  ok: boolean;
  tick: number;
  data: Record<string, unknown>;
  reason?: string;
}

/** Normalise a `text` packet to a chat line. Handles chat, announcement, whisper, json rawtext and the rest. */
export function parseText(p: TextPacket): ChatLine {
  const source = stripFormatting(p.source_name ?? '');
  const xuid = p.xuid ?? '';
  let message: string;
  switch (p.type) {
    case 'json':
    case 'json_whisper':
    case 'json_announcement':
      message = rawTextToPlain(p.message).replace(/\n$/, '');
      break;
    case 'translation':
    case 'popup':
    case 'jukebox_popup': {
      const params = p.parameters ?? [];
      message = params.length > 0 ? `${p.message} [${params.join(', ')}]` : p.message;
      break;
    }
    default:
      message = p.message;
  }
  let body = message;
  // `say` (console or player) arrives as an announcement whose message starts with "[<source>] ".
  if (p.type === 'announcement' && source && message.startsWith(`[${source}] `)) body = message.slice(source.length + 3);
  return { type: p.type, source, message, body, xuid, truth: isTruthLine(message) };
}

/** One-line display form, e.g. `<Steve> hi`, `[Server] hi`, `hi`. */
export function formatChatLine(line: Pick<ChatLine, 'type' | 'source' | 'message'>): string {
  if (!line.source) return line.message;
  // Console `say` arrives as an announcement whose message already starts with "[Server] ".
  if (line.message.startsWith(`[${line.source}]`)) return line.message;
  if (line.type === 'whisper') return `${line.source} whispers: ${line.message}`;
  return line.type === 'chat' ? `<${line.source}> ${line.message}` : `[${line.source}] ${line.message}`;
}
