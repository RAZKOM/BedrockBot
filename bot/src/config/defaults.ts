// Built-in defaults shared by the CLI, the config file loader and the update notifier.
// The game version and the BDS build move together (PLAN.md section 7, docs/versions.md); change
// them only through the version-bump playbook (tools/bump-version/playbook.md).

/**
 * Game version the bot prefers: protocol 2225 (bedrock-protocol 3.61.0, minecraft-data 3.119.0). BDS and clients
 * 1.26.60 to 1.26.65 all speak 2225; bedrock-protocol checks only the number (docs/versions.md "1.26.65"). With no
 * pinned version it is the first candidate of `auto` (config/resolve.ts autoVersions; docs/versions.md "One build,
 * two protocols"), the one a Realm is tried with before any version has spawned.
 */
export const DEFAULT_VERSION = '1.26.60';
/** BDS build of the local servers (docker/compose.*.yml VERSION); the notifier reads compose.dev.yml first. */
export const DEFAULT_BDS_BUILD = '1.26.65.1';
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 19132;
export const DEFAULT_NUDGE_INTERVAL_S = 240;
export const DEFAULT_METRICS_INTERVAL_S = 60;
