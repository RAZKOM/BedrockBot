// The welcome whisper (wave 9, Track AM; docs/ux.md "Welcome", decision 0034): the first time an
// owner is seen after a new bot version, in chat or joining (a player_list `add`), the bot whispers
// them at most 4 lines: the version, two new things, and what to try. `lastWelcomed = <version>` is
// stored in the runtime settings (settings.json when there is one), so it never repeats for that
// version, also not after a reconnect or a restart. It goes through the update notifier's path
// (commands.ts whisperOwners: `/tell "<owner>" ...` as a command_request), never a new chat channel.
import { readFileSync } from 'node:fs';
import type { RuntimeSettings } from '../config/settings.ts';
import type { Connection } from '../connection/connection.ts';
import { silentLogger, type Logger } from '../log.ts';
import { isOwner, senderOf, type Chat } from './chat.ts';
import { whisperOwners } from './commands.ts';

/**
 * What is new in this version (two lines) and its tag. The welcome key is `<package version>+<tag>`:
 * bot/package.json says 0.0.0 for now, so a new release bumps the tag (or the package version).
 */
export const WELCOME_NEWS = {
  tag: 'w9',
  news: ['!help is short now; !help all lists everything, !help <command> explains one', '!mode careful|normal|bold switches the safety settings at once'],
} as const;

let pkgVersion: string | undefined;

/** bot/package.json's version (`0.0.0` when unreadable). */
export function botPackageVersion(): string {
  if (pkgVersion === undefined) {
    try {
      pkgVersion = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? '0.0.0';
    } catch {
      pkgVersion = '0.0.0';
    }
  }
  return pkgVersion;
}

/** The version string the welcome is keyed on, e.g. `0.0.0+w9`. */
export function welcomeVersion(): string {
  return `${botPackageVersion()}+${WELCOME_NEWS.tag}`;
}

/** The whisper, at most 4 lines. */
export function welcomeLines(version: string, news: readonly string[] = WELCOME_NEWS.news, prefix = '!'): string[] {
  return [`BedrockBot ${version} is here`, ...news.slice(0, 2).map((n) => `new: ${n}`), `try ${prefix}get wood, ${prefix}come, ${prefix}do <sentence>; ${prefix}help for more`];
}

export interface WelcomeOptions {
  chat: Pick<Chat, 'owners' | 'prefix' | 'onLine'>;
  conn: Pick<Connection, 'state' | 'queue' | 'username' | 'on'>;
  settings: Pick<RuntimeSettings, 'get' | 'set'>;
  log?: Logger;
  version?: string;
  /** Retry while not spawned (a player_list arrives before the spawn). Default 1 s, up to 60 tries. */
  retryMs?: number;
}

/** Watches chat lines and player_list adds; returns the detach function. */
export function attachWelcome(o: WelcomeOptions): () => void {
  const log = o.log ?? silentLogger;
  const version = o.version ?? welcomeVersion();
  const retryMs = o.retryMs ?? 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tries = 0;
  const done = (): boolean => o.settings.get('lastWelcomed') === version;
  const ownerName = (name: string): boolean => o.chat.owners.names.some((n) => n.toLowerCase() === name.toLowerCase());

  const welcome = (name: string): void => {
    if (done() || timer) return;
    if (o.conn.state !== 'spawned') {
      if (tries++ < 60) {
        timer = setTimeout(() => {
          timer = undefined;
          welcome(name);
        }, retryMs);
        timer.unref?.();
      }
      return;
    }
    const lines = welcomeLines(version, WELCOME_NEWS.news, o.chat.prefix);
    let sent = 0;
    for (const l of lines) sent += whisperOwners(o.conn, [name], l).length;
    if (sent === 0) return;
    try {
      o.settings.set('lastWelcomed', version);
    } catch (e) {
      log.warn(`welcome: could not store lastWelcomed: ${e instanceof Error ? e.message : String(e)}`);
    }
    log.info(`welcome: whispered ${name} the ${version} welcome (${lines.length} lines)`);
  };

  const offLine = o.chat.onLine((line) => {
    if (done()) return;
    const sender = senderOf(line, o.conn.username);
    if (sender?.kind !== 'player' || !isOwner(sender, o.chat.owners)) return;
    welcome(sender.name);
  });
  const offList = o.conn.on('player_list', (p: Record<string, unknown>) => {
    if (done()) return;
    const recs = (p.records as { records?: unknown[] } | unknown[] | undefined) ?? [];
    const list = (Array.isArray(recs) ? recs : (recs.records ?? [])) as Record<string, unknown>[];
    for (const r of list) {
      if (r.type !== 'add' || typeof r.username !== 'string') continue;
      const name = r.username.replace(/§./g, '');
      if (name.toLowerCase() !== o.conn.username.toLowerCase() && ownerName(name)) {
        welcome(name);
        return;
      }
    }
  });
  return () => {
    offLine();
    offList();
    clearTimeout(timer);
    timer = undefined;
  };
}
