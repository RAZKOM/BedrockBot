// Realm target (PLAN.md task 1.6): option assembly and guard rails for joining a Realm with
// bedrock-protocol. Nothing here signs in or connects; it only builds the createClient options.
// The human runs the device-code sign-in once (docs/runbook.md, "Realm join"); the token cache lives
// in `profilesFolder`, outside the repository, and the bot never sees a password.
//
// Option names checked against the installed bedrock-protocol 3.60.1 (src/client/auth.js,
// src/createClient.js, src/client.js, index.d.ts) on 2026-10-28:
// - `realms: { realmId | realmInvite | pickRealm }` makes createClient call realmAuthenticate(),
//   which asks the Realms API for /worlds/<id>/join. A `NETHERNET_JSONRPC` answer sets
//   transport 'nethernet', nethernet.networkId and signalling 'services' (JSON-RPC protocol, plus a
//   regional signalling host, see docs/decisions/0004-protocol-pin.md for the #839 DNS fallback).
// - `authTitle` / `deviceType` / `flow` go to prismarine-auth's Authflow; without authTitle,
//   bedrock-protocol defaults to exactly these values (Nintendo Switch title, live flow).
// - `profilesFolder` is prismarine-auth's token cache directory; `username` is the cache key.
// - `onMsaCode` receives the device code prompt (default: printed with console.log).
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClientOptions } from 'bedrock-protocol';
import { authTitles } from './protocol.ts';
import type { RealmTarget } from './types.ts';

/** Repository root (bot/src/connection/../../..). */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export class RealmGuardError extends Error {
  override name = 'RealmGuardError';
}

/** Minimal shape of a prismarine-realms Realm that pickRealm looks at. */
export interface RealmSummary {
  id: number | string;
  name: string;
  [k: string]: unknown;
}

/** What prismarine-auth passes to onMsaCode (ServerDeviceCodeResponse). */
export interface DeviceCodePrompt {
  message?: string;
  verification_uri?: string;
  user_code?: string;
  expires_in?: number;
}

/** createClient options for a Realm. `flow` and `deviceType` are prismarine-auth options that bedrock-protocol passes through. */
export type RealmClientOptions = ClientOptions & {
  flow: 'live';
  deviceType: string;
  username: string;
  offline: false;
  profilesFolder: string;
  realms: NonNullable<ClientOptions['realms']>;
};

/**
 * Default token cache: %LOCALAPPDATA%\bedrockbot\profiles on Windows, ~/.bedrockbot/profiles elsewhere.
 * Never inside the repository.
 */
export function defaultProfilesFolder(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  if (platform === 'win32' && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'bedrockbot', 'profiles');
  return join(home, '.bedrockbot', 'profiles');
}

/** Resolve symlinks of the longest existing prefix of `p` (the rest may not exist yet). */
function realish(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) break;
    tail.unshift(head.slice(up.length).replace(/^[\\/]+/, ''));
    head = up;
  }
  try {
    head = realpathSync.native(head);
  } catch {
    // keep the resolved path
  }
  return join(head, ...tail);
}

/** True when `child` is `parent` or inside it (case-insensitive on Windows, after resolving symlinks). */
export function isInside(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  let c = realish(child);
  let p = realish(parent);
  if (platform === 'win32') {
    c = c.toLowerCase();
    p = p.toLowerCase();
  }
  const rel = relative(p, c);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Check a Realm target before anything touches the network. Throws RealmGuardError with every
 * problem found. Returns the absolute profilesFolder.
 */
export function validateRealmTarget(target: RealmTarget, opts: { repoRoot?: string; platform?: NodeJS.Platform } = {}): string {
  const problems: string[] = [];
  const selectors = [target.realmName, target.realmInvite, target.realmId].filter((v) => v !== undefined && v !== '');
  if (selectors.length !== 1) problems.push(`give exactly one of realmName, realmInvite, realmId (got ${selectors.length})`);
  if (!target.accountName || !/^[\w.-]{1,64}$/.test(target.accountName)) {
    problems.push(`accountName "${target.accountName ?? ''}" must be 1-64 characters of letters, digits, '_', '.', '-' (it is only a local cache key)`);
  }
  // A Realm needs a signed-in account; an offline-mode option must never reach a Realm target.
  if ((target as { offline?: unknown }).offline !== undefined) problems.push('offline mode is not allowed for a Realm target');
  let folder = '';
  if (!target.profilesFolder) {
    problems.push('profilesFolder is required');
  } else {
    folder = resolve(target.profilesFolder);
    const repo = opts.repoRoot ?? REPO_ROOT;
    if (isInside(folder, repo, opts.platform)) {
      problems.push(`profilesFolder ${folder} is inside the repository (${resolve(repo)}); the token cache must live outside it (default ${defaultProfilesFolder()})`);
    }
  }
  if (problems.length > 0) throw new RealmGuardError(`refusing Realm target: ${problems.join('; ')}`);
  return folder;
}

/** pickRealm callback: the Realm whose name equals `name`, else the only case-insensitive match. */
export function pickRealmByName(name: string): (realms: RealmSummary[]) => RealmSummary {
  return (realms) => {
    const exact = realms.filter((r) => r.name === name);
    if (exact.length === 1) return exact[0]!;
    const folded = realms.filter((r) => r.name.toLowerCase() === name.toLowerCase());
    if (exact.length === 0 && folded.length === 1) return folded[0]!;
    const names = realms.map((r) => `"${r.name}"`).join(', ') || 'none';
    const why = exact.length > 1 || folded.length > 1 ? 'more than one Realm is called' : 'no Realm called';
    throw new RealmGuardError(`${why} "${name}" for this account (Realms: ${names}); use --realm-id or --realm-invite`);
  };
}

export interface RealmOptionsInput {
  /** Game version to speak (must equal the Realm's version). */
  version: string;
  viewDistance: number;
  conLog?: (...args: unknown[]) => void;
  /** Shows the device-code prompt to the human. */
  onMsaCode?: (prompt: DeviceCodePrompt) => void;
  repoRoot?: string;
  platform?: NodeJS.Platform;
}

/** Validate the target and build bedrock-protocol createClient options for it. Pure: no I/O besides path checks. */
export function buildRealmClientOptions(target: RealmTarget, input: RealmOptionsInput): RealmClientOptions {
  const profilesFolder = validateRealmTarget(target, { repoRoot: input.repoRoot, platform: input.platform });
  const realms: RealmClientOptions['realms'] = target.realmId
    ? { realmId: target.realmId }
    : target.realmInvite
      ? { realmInvite: target.realmInvite }
      : { pickRealm: pickRealmByName(target.realmName!) as unknown as NonNullable<ClientOptions['realms']>['pickRealm'] };
  const title = authTitles.MinecraftNintendoSwitch;
  if (!title) throw new Error('prismarine-auth has no MinecraftNintendoSwitch title');
  const opts: RealmClientOptions = {
    username: target.accountName,
    offline: false,
    version: input.version,
    profilesFolder,
    authTitle: title,
    deviceType: 'Nintendo',
    flow: 'live',
    realms,
    // Realms answer NETHERNET_JSONRPC; realmAuthenticate sets networkId and the signalling host.
    transport: 'nethernet',
    nethernet: { signalling: 'services' },
    raknetBackend: 'raknet-native',
    skipPing: true,
    viewDistance: target.viewDistance ?? input.viewDistance,
  };
  if (input.conLog) opts.conLog = input.conLog;
  if (input.onMsaCode) opts.onMsaCode = input.onMsaCode;
  // Belt and braces: whatever happens above, a Realm client is never offline.
  if ((opts.offline as boolean) !== false) throw new RealmGuardError('refusing an offline Realm client');
  return opts;
}

/** Human-readable label for logs, e.g. `realm "My Realm" (nethernet/services)`. */
export function realmLabel(target: RealmTarget): string {
  const which = target.realmName !== undefined ? `"${target.realmName}"` : target.realmId !== undefined ? `id ${target.realmId}` : 'invite';
  return `realm ${which} (nethernet/services)`;
}
