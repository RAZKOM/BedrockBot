// Which game version and transport the e2e suites speak. Defaults are the dev setup (1.26.60 over
// RakNet since 2026-10-28); hosts, ports and containers have their own env vars in chat-helpers.ts
// (BDS_*), world-truth.ts (BDS_WORLD_*), skills-input.test.ts (PHYS_BDS_*), move-truth.ts (MOVE_BDS_*),
// dig-truth.ts (DIG_BDS_*) and fly-truth.ts (FLY_BDS_*, Track AU).
//   BOT_VERSION=1.26.51            the previous game version (rollback path, server bds-dev51)
//   BDS_TRANSPORT=nethernet        NetherNet with LAN signalling (discovery on UDP 7551)
// `node scripts/e2e-profile.ts dev51|nn` sets all of them for one container (see docs/versions.md).
import { supportedVersions } from '../../src/connection/protocol.ts';
import type { BdsTarget, Transport } from '../../src/connection/types.ts';

export const E2E_VERSION = process.env.BOT_VERSION ?? '1.26.60';

function transport(v: string | undefined): Transport {
  if (v === undefined || v === '' || v === 'raknet') return 'raknet';
  if (v === 'nethernet') return 'nethernet';
  throw new Error(`BDS_TRANSPORT must be raknet or nethernet, got "${v}"`);
}

export const E2E_TRANSPORT: Transport = transport(process.env.BDS_TRANSPORT);

/** Protocol number of E2E_VERSION (what the server should advertise). */
export const E2E_PROTOCOL: number | undefined = supportedVersions[E2E_VERSION];

export function bdsTarget(host: string, port: number): BdsTarget {
  return { kind: 'bds', host, port, transport: E2E_TRANSPORT, offline: true };
}

/** CLI flags that make `node src/index.ts` speak the same version and transport. */
// --no-config: a user's %LOCALAPPDATA%/bedrockbot/config.json must never redirect an e2e CLI run.
export const CLI_TARGET_ARGS: readonly string[] = ['--no-config', '--version', E2E_VERSION, '--transport', E2E_TRANSPORT];

/** Options for a raw bedrock-protocol createClient (test observers) on the same transport. */
export function rawClientTransport(): Record<string, unknown> {
  return E2E_TRANSPORT === 'nethernet' ? { transport: 'nethernet', nethernet: { signalling: 'lan' } } : { transport: 'raknet', raknetBackend: 'raknet-native' };
}
