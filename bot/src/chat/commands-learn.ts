// `!learn` (docs/flight.md "Learned paths"): record a flight path the owner flies while the bot watches, and keep it by
// name in <config dir>/paths/<name>.json (the owner's coordinates: never in the repository).
//
//   !learn <name> [player]   start recording that player (the sender by default; from the panel, the one player in view)
//   !learn stop              end the recording now and save it (it also ends by itself 8 s after the player has landed)
//   !learn list | show <name> | delete <name>
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from '../log.ts';
import { pathLine, PathRecorder, validPathName, type LearnedPath } from '../skills/fly/learn/recorder.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';

export interface LearnExtra {
  /** Where the paths go (tests: a temp dir); default <dir of the settings file>/paths, or BEDROCKBOT_PATHS_DIR. */
  pathsDir?: string;
  logger?: Logger;
}

export function pathsDirOf(settingsFile: string | undefined, option?: string, env: string | undefined = process.env.BEDROCKBOT_PATHS_DIR): string | undefined {
  if (option) return option;
  if (env) return env;
  return settingsFile ? join(dirname(settingsFile), 'paths') : undefined;
}

/** The saved paths in `dir`, by name (unreadable files skipped). */
export function loadPaths(dir: string | undefined): LearnedPath[] {
  if (!dir || !existsSync(dir)) return [];
  const out: LearnedPath[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const p = JSON.parse(readFileSync(join(dir, f), 'utf8')) as LearnedPath;
      if (p.version === 1 && Array.isArray(p.samples)) out.push(p);
    } catch {
      // a broken file is not a path
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function registerLearnCommands(d: CommandDeps, extra: LearnExtra = {}): void {
  const { chat, settings } = d;
  const log = extra.logger ?? d.log;
  const dir = (): string | undefined => pathsDirOf(settings.file, extra.pathsDir);
  let rec: PathRecorder | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let say: ((m: string) => void) | undefined;

  const save = (why: string): void => {
    const r = rec;
    if (!r) return;
    rec = undefined;
    if (timer) clearInterval(timer);
    timer = undefined;
    const path = r.stop(why);
    const folder = dir();
    const line = pathLine(path);
    if (path.samples.length < 2) {
      say?.(`learn: ${path.name}: nothing recorded (I never saw ${path.player} move; stay within my view)`);
      return;
    }
    if (!folder) {
      say?.(`learn: ${line} (not saved: no config directory)`);
      return;
    }
    try {
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, `${path.name}.json`), `${JSON.stringify(path)}\n`, 'utf8');
    } catch (e) {
      say?.(`learn: could not save ${path.name} (${e instanceof Error ? e.message : String(e)})`);
      return;
    }
    log.info(`learn: saved ${line} (${path.ended})`);
    say?.(`learn: saved ${line}${why === 'landed' ? ' (you landed)' : why === 'limit' ? ' (10 min limit)' : ''}`);
  };

  chat.register({
    name: 'learn',
    help: '<name> [player] | stop | list | show <name> | delete <name> (record a flight path you fly while I watch from where I stand; it ends 8 s after you land)',
    group: 'go',
    tier: 'more',
    example: '!learn cave_in',
    run: ({ args, reply, sender }) => {
      const sub = args[0]?.toLowerCase();
      if (!sub) {
        reply(rec ? `learn: recording ${rec.player} as ${rec.name} (!learn stop to end)` : 'usage: !learn <name> [player] | stop | list | show <name> | delete <name>');
        return;
      }
      if (sub === 'stop') {
        if (!rec) {
          reply('learn: not recording');
          return;
        }
        say = reply;
        save('stop');
        return;
      }
      if (sub === 'list') {
        const all = loadPaths(dir());
        reply(all.length ? `learn: ${all.length} path${all.length === 1 ? '' : 's'}: ${all.map((p) => p.name).join(', ')}` : 'learn: no paths yet (!learn <name>, then fly it)');
        return;
      }
      if (sub === 'show' || sub === 'delete') {
        const name = args[1];
        const p = name ? loadPaths(dir()).find((x) => x.name.toLowerCase() === name.toLowerCase()) : undefined;
        if (!p) {
          reply(`learn: no path "${name ?? ''}" (!learn list)`);
          return;
        }
        if (sub === 'show') {
          reply(`learn: ${pathLine(p)}; recorded ${p.recorded.slice(0, 16).replace('T', ' ')} UTC from ${p.player}`);
          return;
        }
        rmSync(join(dir()!, `${p.name}.json`), { force: true });
        reply(`learn: deleted ${p.name}`);
        return;
      }
      const name = args[0]!;
      if (!validPathName(name)) {
        reply('learn: a path name is letters, digits, _ and - (up to 32)');
        return;
      }
      if (rec) {
        reply(`learn: already recording ${rec.player} as ${rec.name} (!learn stop first)`);
        return;
      }
      const world = d.world;
      if (!world) {
        reply('learn: no world model in this task');
        return;
      }
      const self = d.selfName().toLowerCase();
      const inView = [...world.entityTracker.entities.values()].filter((e) => e.type === 'minecraft:player' && e.username && e.username.toLowerCase() !== self);
      const player = args[1] ?? (sender.kind === 'player' && sender.name.toLowerCase() !== self ? sender.name : inView.length === 1 ? inView[0]!.username! : undefined);
      if (!player) {
        reply(`learn: whose flight? ${inView.length ? `I see ${inView.map((e) => e.username).join(', ')}` : 'I see no player'} (!learn ${name} <player>)`);
        return;
      }
      const r = new PathRecorder(name, player, { entities: () => world.entityTracker.entities.values(), onAdd: (fn) => world.entityTracker.onAdd(fn), now: () => performance.now() });
      if (!r.visible()) {
        r.stop();
        reply(`learn: I cannot see ${player} from here (bring me near the path: /tp ${d.selfName()} <you>, then fly it)`);
        return;
      }
      rec = r;
      say = reply;
      const exists = loadPaths(dir()).some((p) => p.name.toLowerCase() === name.toLowerCase());
      timer = setInterval(() => {
        const ended = rec?.tick();
        if (ended) save(ended);
      }, 25);
      timer.unref?.();
      log.info(`learn: recording ${player} as ${name}`);
      reply(`learn: recording ${player} as ${name}${exists ? ' (replaces the saved one)' : ''}: fly it now; it ends 8 s after you land, or !learn stop`);
    },
  });
}
