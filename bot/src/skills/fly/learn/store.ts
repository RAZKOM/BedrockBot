// Track F9b (docs/flight.md "Learned exits (Track F9b)"): the recorded paths as the flight reads them. `!learn` writes
// one JSON a path into <config dir>/paths (chat/commands-learn.ts; never the repository: the files hold the owner's
// coordinates). The store reads that folder for a takeoff and reads a file again only when it changed, so asking at
// every takeoff costs a directory listing.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { LearnedPath, LearnSample } from './recorder.ts';

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A path file's content as a recording, or undefined when it is not one (another version, a broken file, no samples). */
export function parsePath(raw: unknown): LearnedPath | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const p = raw as Partial<LearnedPath>;
  if (p.version !== 1 || typeof p.name !== 'string' || !Array.isArray(p.samples)) return undefined;
  const samples: LearnSample[] = [];
  for (const s of p.samples as Partial<LearnSample>[]) {
    if (typeof s !== 'object' || s === null || !num(s.t) || !num(s.x) || !num(s.y) || !num(s.z)) return undefined;
    samples.push({ t: s.t, x: s.x, y: s.y, z: s.z, yaw: num(s.yaw) ? s.yaw : 0, pitch: num(s.pitch) ? s.pitch : 0, ground: s.ground === true });
  }
  if (samples.length < 2) return undefined;
  const rockets = (Array.isArray(p.rockets) ? p.rockets : []).filter((r) => typeof r === 'object' && r !== null && num(r.t)).map((r) => ({ t: r.t, x: num(r.x) ? r.x : 0, y: num(r.y) ? r.y : 0, z: num(r.z) ? r.z : 0 }));
  const gaps = (Array.isArray(p.gaps) ? p.gaps : []).filter((g) => typeof g === 'object' && g !== null && num(g.from) && num(g.to)).map((g) => ({ from: g.from, to: g.to }));
  return { version: 1, name: p.name, player: typeof p.player === 'string' ? p.player : '', recorded: typeof p.recorded === 'string' ? p.recorded : '', samples, rockets, gaps, ended: typeof p.ended === 'string' ? p.ended : '' };
}

/** The recorded paths of one folder, each file read once until it changes (its size or its time). */
export class PathStore {
  private readonly dir: () => string | undefined;
  private readonly seen = new Map<string, { stamp: string; path: LearnedPath | undefined }>();

  constructor(dir: string | undefined | (() => string | undefined)) {
    this.dir = typeof dir === 'function' ? dir : () => dir;
  }

  /** Every readable recording in the folder, by file name. */
  all(): LearnedPath[] {
    const dir = this.dir();
    if (!dir || !existsSync(dir)) return [];
    const out: LearnedPath[] = [];
    const files = new Set<string>();
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith('.json')) continue;
      const file = join(dir, f);
      files.add(file);
      try {
        const st = statSync(file);
        const stamp = `${st.size}:${st.mtimeMs}`;
        let e = this.seen.get(file);
        if (e?.stamp !== stamp) {
          e = { stamp, path: parsePath(JSON.parse(readFileSync(file, 'utf8'))) };
          this.seen.set(file, e);
        }
        if (e.path) out.push(e.path);
      } catch {
        this.seen.delete(file); // a file that cannot be read is not a path (and is tried again next time)
      }
    }
    for (const file of this.seen.keys()) if (!files.has(file)) this.seen.delete(file);
    return out;
  }
}
