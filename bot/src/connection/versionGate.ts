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
    const newest = Object.keys(supported).at(-1) ?? 'none';
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
