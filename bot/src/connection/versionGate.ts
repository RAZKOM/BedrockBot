import { supportedVersions } from './protocol.ts';

export type VersionCheck =
  | { ok: true; version: string; protocol: number }
  | { ok: false; reason: 'unsupported_version' | 'protocol_mismatch'; message: string };

/**
 * Refuse to connect when the requested game version is not one bedrock-protocol supports, or when
 * the server advertises a different protocol than the requested version speaks (the server would
 * answer with outdated_client / outdated_server anyway, but only after a full login).
 */
export function checkVersion(
  requested: string,
  serverProtocol?: number,
  supported: Readonly<Record<string, number>> = supportedVersions,
): VersionCheck {
  const protocol = supported[requested];
  if (protocol === undefined) {
    // The highest protocol (bedrock-protocol lists its versions newest first, so the last key is the oldest).
    const newest = Object.entries(supported).reduce<[string, number] | undefined>((a, e) => (!a || e[1] > a[1] ? e : a), undefined)?.[0] ?? 'none';
    return {
      ok: false,
      reason: 'unsupported_version',
      message: `game version ${requested} is not supported by bedrock-protocol (newest supported: ${newest})`,
    };
  }
  if (serverProtocol !== undefined && Number.isFinite(serverProtocol) && serverProtocol !== protocol) {
    const serverVersion = Object.entries(supported).find(([, p]) => p === serverProtocol)?.[0];
    return {
      ok: false,
      reason: 'protocol_mismatch',
      message: `server speaks protocol ${serverProtocol}${serverVersion ? ` (${serverVersion})` : ' (unknown to bedrock-protocol)'} but ${requested} is protocol ${protocol}`,
    };
  }
  return { ok: true, version: requested, protocol };
}

/** A session version chosen by pickVersion: `fromPing` when the server's advertised protocol decided it. */
export interface VersionPicked {
  ok: true;
  version: string;
  protocol: number;
  fromPing: boolean;
}
export type VersionPick = VersionPicked | Extract<VersionCheck, { ok: false }>;

export interface PickContext {
  /** The protocol the server advertises (RakNet pong, NetherNet LAN discovery response); undefined: no ping (a Realm). */
  protocol?: number | undefined;
  /** The version of the last session that spawned. */
  spawned?: string | undefined;
  /** Versions the server refused since the last spawn. */
  refused?: ReadonlySet<string>;
}

/**
 * The game version a session speaks, out of `candidates` (the preferred one first; each supported by bedrock-protocol).
 * - The server advertises a protocol: the candidate of that protocol, else a refusal (a single candidate gets
 *   checkVersion's own message, so a pinned version behaves as before).
 * - It does not: the version that last spawned, else the first candidate the server has not refused, else the
 *   preferred one.
 */
export function pickVersion(candidates: readonly string[], ctx: PickContext = {}, supported: Readonly<Record<string, number>> = supportedVersions): VersionPick {
  const first = candidates[0];
  if (first === undefined) return { ok: false, reason: 'unsupported_version', message: 'no game version configured' };
  const p = ctx.protocol;
  if (p !== undefined && Number.isFinite(p)) {
    if (candidates.length === 1) {
      const r = checkVersion(first, p, supported);
      return r.ok ? { ...r, fromPing: true } : r;
    }
    const match = candidates.find((v) => supported[v] === p);
    if (match !== undefined) return { ok: true, version: match, protocol: p, fromPing: true };
    const serverVersion = Object.entries(supported).find(([, n]) => n === p)?.[0];
    return {
      ok: false,
      reason: 'protocol_mismatch',
      message: `server speaks protocol ${p}${serverVersion ? ` (${serverVersion})` : ' (unknown to bedrock-protocol)'} but the bot speaks ${candidates.map((v) => `${v} (${supported[v] ?? '?'})`).join(', ')}`,
    };
  }
  const order = [ctx.spawned, ...candidates].filter((v): v is string => v !== undefined && candidates.includes(v));
  const version = order.find((v) => !ctx.refused?.has(v)) ?? first;
  const r = checkVersion(version, undefined, supported);
  return r.ok ? { ...r, fromPing: false } : r;
}
