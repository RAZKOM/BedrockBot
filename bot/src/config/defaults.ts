// Built-in defaults shared by the CLI, the config file loader and the update notifier.
// The game version and the BDS build move together (PLAN.md section 7, docs/versions.md); change
// them only through the version-bump playbook (tools/bump-version/playbook.md).

/** Game version the bot speaks by default (bedrock-protocol + patches/minecraft-data@3.117.0.patch). */
export const DEFAULT_VERSION = '1.26.60';
/** BDS build of the local servers (docker/compose.*.yml VERSION); the notifier reads compose.dev.yml first. */
export const DEFAULT_BDS_BUILD = '1.26.60.6';
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 19132;
export const DEFAULT_NUDGE_INTERVAL_S = 240;
export const DEFAULT_METRICS_INTERVAL_S = 60;
