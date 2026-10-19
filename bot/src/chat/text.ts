import type { TextPacket } from '../connection/types.ts';

export interface ChatLine {
  /** Packet text type: chat, announcement (console `say`), json (world.sendMessage), ... */
  type: TextPacket['type'];
  /** Player or sender name, '' when the packet has none. */
  source: string;
  /** Plain text. For json/rawtext messages the concatenated `text` parts. */
  message: string;
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

/** Normalise a `text` packet to a chat line. Handles chat, announcement, json rawtext and the rest. */
export function parseText(p: TextPacket): ChatLine {
  const source = p.source_name ?? '';
  switch (p.type) {
    case 'json':
    case 'json_whisper':
    case 'json_announcement':
      return { type: p.type, source, message: rawTextToPlain(p.message) };
    case 'translation':
    case 'popup':
    case 'jukebox_popup': {
      const params = p.parameters ?? [];
      return { type: p.type, source, message: params.length > 0 ? `${p.message} [${params.join(', ')}]` : p.message };
    }
    default:
      return { type: p.type, source, message: p.message };
  }
}

/** One-line display form, e.g. `<Steve> hi`, `[Server] hi`, `hi`. */
export function formatChatLine(line: ChatLine): string {
  if (!line.source) return line.message;
  // Console `say` arrives as an announcement whose message already starts with "[Server] ".
  if (line.message.startsWith(`[${line.source}]`)) return line.message;
  return line.type === 'chat' || line.type === 'whisper' ? `<${line.source}> ${line.message}` : `[${line.source}] ${line.message}`;
}
