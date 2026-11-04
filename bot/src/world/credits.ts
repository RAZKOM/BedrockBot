// The end credits (docs/nether.md "The end credits"): the client side of `show_credits`.
//
// When a player walks into the End's exit portal (the fountain at 0 ~63 0 once the dragon is dead) the server
// plays the credits and parks the player until the client says they are over:
//   server  show_credits { runtime_entity_id: self, status: 0 (start) }
//   client  show_credits { runtime_entity_id: self, status: 1 (end) }    <- this module, at once
//   server  change_dimension -> overworld (the spawn point), as for any dimension change (dimension.ts)
// Until the client answers, the player stays in the portal block and the server refuses its slash commands:
// on the Realm (2026-11-04) every `/me` reply was answered with the kick `invalid_command_request_packet`, and
// since the player is still in the portal after a rejoin, every reconnect started the same loop. So the answer
// goes out at once, and `showing` lets chat hold its slash route until the server moves the player.
//
//   const credits = new CreditsWatcher(conn, { selfRuntimeId: () => world.self.runtimeId });
//   chat.slashHold = () => credits.showing;
import { silentLogger, type Logger } from '../log.ts';
import type { PacketSource } from './types.ts';

/** show_credits status values (protocol: zigzag32). */
export const CREDITS_START = 0;
export const CREDITS_END = 1;

/** Give up holding chat this long after a start the server never followed up (no change_dimension). */
export const CREDITS_HOLD_MS = 30_000;

export interface CreditsStats {
  /** show_credits starts seen for the bot. */
  shown: number;
  /** Ends the bot sent. */
  answered: number;
}

export interface CreditsWatcherOptions {
  /** The bot's runtime id (0n before start_game: then every show_credits counts as ours). */
  selfRuntimeId: () => bigint;
  logger?: Logger;
  now?: () => number;
}

/** Answers the server's credits at once and reports whether they are still showing. */
export class CreditsWatcher {
  readonly stats: CreditsStats = { shown: 0, answered: 0 };
  private readonly source: Pick<PacketSource, 'on' | 'queue'>;
  private readonly o: CreditsWatcherOptions;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly unsubs: (() => void)[] = [];
  private since: number | undefined;

  constructor(source: Pick<PacketSource, 'on' | 'queue'>, opts: CreditsWatcherOptions) {
    this.source = source;
    this.o = opts;
    this.log = opts.logger ?? silentLogger;
    this.now = opts.now ?? (() => performance.now());
    this.unsubs.push(
      source.on('show_credits', (p) => {
        this.onShowCredits(p as { runtime_entity_id?: bigint | number; status?: number });
      }),
      // the server moves the player out (overworld spawn) or a new session starts: the credits are over
      source.on('change_dimension', () => {
        this.since = undefined;
      }),
      source.on('start_game', () => {
        this.since = undefined;
      }),
    );
  }

  /** The server started the credits and has not moved the player out yet (capped at CREDITS_HOLD_MS). */
  get showing(): boolean {
    if (this.since === undefined) return false;
    if (this.now() - this.since > CREDITS_HOLD_MS) {
      this.since = undefined;
      return false;
    }
    return true;
  }

  dispose(): void {
    for (const u of this.unsubs.splice(0)) u();
  }

  private onShowCredits(p: { runtime_entity_id?: bigint | number; status?: number }): void {
    if (p.status !== CREDITS_START) return;
    const self = this.o.selfRuntimeId();
    const id = p.runtime_entity_id === undefined ? undefined : BigInt(p.runtime_entity_id);
    if (self !== 0n && id !== undefined && id !== self) return; // someone else's credits
    this.stats.shown++;
    this.since = this.now();
    this.source.queue('show_credits', { runtime_entity_id: self !== 0n ? self : (id ?? 0n), status: CREDITS_END });
    this.stats.answered++;
    this.log.info(`end credits started (exit portal): skipped them (show_credits end sent), waiting for the move to the overworld`);
  }
}
