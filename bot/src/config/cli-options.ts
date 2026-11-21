// The command line's flags (Track REL2): the options every task takes and the afk task's own, in one place for the bot
// (src/index.ts) and `pnpm bot:check` (doctor/cli.ts), so the check reads the flags `pnpm bot:afk` would get the same
// way. Free of dependencies (node:util types only): the doctor parses with it before anything is installed.
import type { ParseArgsOptionsConfig } from 'node:util';

export const COMMON_OPTIONS = {
  config: { type: 'string' },
  'no-config': { type: 'boolean' },
  task: { type: 'string' },
  target: { type: 'string' },
  host: { type: 'string' },
  port: { type: 'string' },
  version: { type: 'string' },
  transport: { type: 'string' },
  signalling: { type: 'string' },
  'realm-name': { type: 'string' },
  'realm-invite': { type: 'string' },
  'realm-id': { type: 'string' },
  account: { type: 'string' },
  'profiles-folder': { type: 'string' },
  'no-record': { type: 'boolean' },
  username: { type: 'string' },
  record: { type: 'string' },
  'record-raw': { type: 'boolean' },
  duration: { type: 'string' },
  'exit-on-chat': { type: 'string' },
  'no-reconnect': { type: 'boolean' },
  'log-level': { type: 'string' },
  owner: { type: 'string', multiple: true },
  'no-console-owner': { type: 'boolean' },
  'nudge-interval': { type: 'string' },
  heartbeat: { type: 'boolean' },
  home: { type: 'string' },
  shelter: { type: 'string' },
  walk: { type: 'boolean' },
  'respawn-delay': { type: 'string' },
  'log-dir': { type: 'string' },
  'disconnect-log': { type: 'string' },
  'metrics-file': { type: 'string' },
  'metrics-interval': { type: 'string' },
  'health-port': { type: 'string' },
  'update-check-hours': { type: 'string' },
  settings: { type: 'string' }, // Track Q: runtime settings file (default <config dir>/settings.json)
  set: { type: 'string', multiple: true }, // Track Q: --set key=value (runtime setting at start-up)
  help: { type: 'boolean', short: 'h' },
} as const satisfies ParseArgsOptionsConfig;

/** The afk task's own flags (tasks/registry.ts registers the task with them). */
export const AFK_OPTIONS = { guard: { type: 'string' }, 'flee-health': { type: 'string' }, chest: { type: 'string' } } as const satisfies ParseArgsOptionsConfig;

/** The parseArgs option set: the common options plus every given task's own options. */
export function optionSetOf(tasks: readonly { name: string; cliOptions?: ParseArgsOptionsConfig | undefined }[]): ParseArgsOptionsConfig {
  const opts: ParseArgsOptionsConfig = { ...COMMON_OPTIONS };
  for (const t of tasks) {
    for (const [k, v] of Object.entries(t.cliOptions ?? {})) {
      if (k in COMMON_OPTIONS) throw new Error(`task ${t.name}: option --${k} clashes with a common option`);
      opts[k] = v;
    }
  }
  return opts;
}
