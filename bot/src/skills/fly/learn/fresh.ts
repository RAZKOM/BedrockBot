// Track F9c round 2 (docs/flight.md "Learned entries", "The cave changes"): is a cave fixture as new as the recordings
// that are flown in it?
//
// A recorded flight is flown through the cave as it was when it was recorded. A fixture exported before that (the world
// cache's export of the cave) is another cave: the bot's own blocks, a dug wall, a block somebody set beside the goal.
// Round 1 proved two takes clear in a fixture three days older than the takes; on the Realm both were refused, rightly.
// The probe and the cave e2e print this line first, so a stale fixture is seen before any number is read.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Freshness {
  /** When the fixture was exported and when the newest recording was made (ISO strings; undefined: not stated). */
  exportedAt: string | undefined;
  newest: string | undefined;
  /** The fixture is older than a recording: what is flown in it is not the cave the recording was made in. */
  stale: boolean;
  /** The fixture's age is not known (no export time, or no recording with a time): nothing can be said. */
  unknown: boolean;
  line: string;
}

/** A fixture's export time against the recordings' times: stale when any recording is newer than the fixture. */
export function fixtureFreshness(exportedAt: string | undefined, recorded: readonly (string | undefined)[]): Freshness {
  const at = exportedAt !== undefined ? Date.parse(exportedAt) : NaN;
  const times = recorded.map((r) => (r !== undefined ? Date.parse(r) : NaN)).filter((t) => Number.isFinite(t));
  const last = times.length ? Math.max(...times) : NaN;
  const newest = Number.isFinite(last) ? new Date(last).toISOString() : undefined;
  const said = `the fixture was exported ${exportedAt ?? 'at a time it does not state'}; the newest of ${recorded.length} recording${recorded.length === 1 ? '' : 's'} is from ${newest ?? 'a time it does not state'}`;
  if (!Number.isFinite(at) || !Number.isFinite(last)) return { exportedAt, newest, stale: false, unknown: true, line: `${said}: whether the fixture is the cave the recordings were made in cannot be told` };
  const newer = times.filter((t) => t > at).length;
  if (newer === 0) return { exportedAt, newest, stale: false, unknown: false, line: `${said}: the fixture is newer than every recording` };
  const hours = (last - at) / 3_600_000;
  return {
    exportedAt,
    newest,
    stale: true,
    unknown: false,
    line: `WARNING: STALE FIXTURE: ${said}, ${hours >= 48 ? `${(hours / 24).toFixed(1)} days` : `${hours.toFixed(1)} hours`} after it (${newer} recording${newer === 1 ? '' : 's'} newer than the fixture). What flies here was not recorded in this cave: export the cave again before reading any result`,
  };
}

/** The `exportedAt` of a fixture folder's extract (the world cache's export writes it), undefined when it has none. */
export function fixtureExportedAt(dir: string, file = 'extract.json'): string | undefined {
  const path = join(dir, file);
  if (!existsSync(path)) return undefined;
  try {
    const at = (JSON.parse(readFileSync(path, 'utf8')) as { exportedAt?: unknown }).exportedAt;
    return typeof at === 'string' ? at : undefined;
  } catch {
    return undefined;
  }
}
