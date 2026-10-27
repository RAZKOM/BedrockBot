// Home logistics chat commands (wave 9, Track AG; docs/home.md), owner-only like every command:
//
//   !unload [all]                      put what the bot carries into the chests at home (a user process):
//                                      `unloading 12 stacks into 5 known containers`, then
//                                      `unloaded: 64 coal -> chest 100 63 -48, 27 cobblestone -> barrel ...; kept ...`
//   !stock [item]                      from memory: `coal: 128 in chest 100 63 -48 (ores), 64 in barrel ...`
//   !chests                            the remembered containers around home
//   !chests scan                       walk to every container within homeChestRadius of home that was not
//                                      read in the last 10 minutes and look inside (a user process)
//   !chests label x y z <text>|none    give a container a label (`ores`, `wood`, `food`, `blocks`, `junk`, `tools`)
//
// The automatic part (tasks/process/unload.ts HomeChore, PRIORITY.chore): the first scan of a session
// when the bot first stands within 8 blocks of home, reading containers that appear within the radius
// (forgetting those that disappear), and with `autoUnload` on unloading when idle at home with more
// than 8 stacks of unloadable items or a full shulker box, or right after a `!get` job ended at home
// (the line `unloaded: ...` then follows the job's own reply). Registered by the afk task
// (tasks/registry.ts, one line, after !get); without walking every command answers `needs a task that can walk`.
import type { Vec3 } from '../connection/types.ts';
import type { Logger } from '../log.ts';
import { ChestMemory, type ChestMemoryStore } from '../world/cache/chests.ts';
import type { Containers } from '../world/containers.ts';
import { HomeLogistics, type ScanReport, unloadLine, type UnloadReport } from '../skills/home/logistics.ts';
import { isHomeContainer } from '../skills/home/discovery.ts';
import { chestKey, chestName, chestsLine, fmtPos, stockLine, unreadRecord } from '../skills/home/memory.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import { settingsMover } from '../tasks/process/goto.ts';
import { HomeChore, HomeJobProcess, type HomeJob, type HomeRunner } from '../tasks/process/unload.ts';
import { getControllerOf } from './commands-get.ts';

export const HOME_COMMANDS = ['unload', 'stock', 'chests'] as const;

export interface HomeExtra {
  /** The afk task's shared Containers (deposits are counted on it; inventory moves while a window is open). */
  containers?: Containers | undefined;
  logger?: Logger | undefined;
}

export interface HomeControl {
  logistics: HomeLogistics;
  chore: HomeChore;
  memory(): ChestMemoryStore;
  /** Start a job as a user process; the reply line when it ends. */
  start(job: HomeJob): HomeJobProcess;
}

const controls = new WeakMap<object, HomeControl>();

/** The home logistics of a task (tests, status). */
export function homeControlOf(task: object): HomeControl | undefined {
  return controls.get(task);
}

/** `chests: read 5 containers (2 read less than 10 min ago, 1 forgotten) in 12.3 s` */
export function scanLine(r: ScanReport): string {
  if (r.reason === 'no_home') return 'chests: no home set (!home set)';
  const parts = [`chests: read ${r.read.length} of ${r.found} container${r.found === 1 ? '' : 's'} within the radius`];
  if (r.fresh) parts.push(`${r.fresh} read less than 10 min ago`);
  if (r.forgotten) parts.push(`${r.forgotten} forgotten`);
  if (r.failed.length) parts.push(`could not open ${r.failed.map((f) => `${fmtPos(f.p)} (${f.reason})`).join(', ')}`);
  if (r.reason) parts.push(r.reason === 'interrupted' ? 'interrupted' : r.reason);
  return `${parts.join(', ')} in ${(r.ms / 1000).toFixed(1)} s`;
}

export function registerHomeCommands(d: CommandDeps, extra: HomeExtra = {}): HomeControl | undefined {
  const { processes, mobility: mob, world } = d;
  if (!processes || !mob || !world) {
    for (const name of HOME_COMMANDS) d.chat.register({ name, help: '(needs walking)', run: ({ reply }) => reply(d.needsWalking(name)) });
    return undefined;
  }
  const log = extra.logger ?? d.log;
  const mover = settingsMover(mob.skills, d.settings);
  const local = new ChestMemory();
  const memory = (): ChestMemoryStore => world.cache?.chests ?? local;
  const home = (): Vec3 | undefined => d.task.home?.get();
  const chest = () => mob.skills.chest;
  const containers = extra.containers;
  const logistics = new HomeLogistics({
    skills: {
      goto: (g, o) => mover.goto(g, o),
      open: (p) => mob.skills.open(p),
      closeContainer: (v) => mob.skills.closeContainer(v),
      snapshot: (v) => chest()?.snapshot(v),
      depositSlots: (v, m) => chest()?.depositSlots(v, m) ?? Promise.resolve({ ok: false, reason: 'no_containers', moved: {}, total: 0, requests: 0, errors: 0 }),
      take: (v, s, n, prefer) => chest()?.take(v, s, n, prefer) ?? Promise.resolve({ ok: false, reason: 'no_containers', moved: 0 }),
      place: (p, o) => mob.skills.place(p, o),
      dig: (p, o) => mob.skills.dig(p, o),
      collect: (r, t, o) => mob.skills.collect(r, t, o),
      cancel: () => mob.skills.cancel(),
    },
    inventory: world.inventory,
    world: { find: (pred, o) => world.find(pred, o), blockAt: (p) => world.blockAt(p) },
    position: () => mob.position(),
    home,
    memory,
    settings: d.settings,
    ...(containers ? { containers } : {}),
    ...(d.pve ? { selectHotbar: (slot: number) => void d.pve!.hotbar.select(slot) } : {}),
    log,
  });
  const runner: HomeRunner = {
    unload: (c, o) => logistics.unload(c, o),
    scan: (c, o) => logistics.scan(c, o),
    cancel: () => mob.skills.cancel(),
  };
  // the !get job the chore has seen end (once per job)
  let seenJob: object | undefined;
  const chore = processes.add(
    new HomeChore({
      runner,
      atHome: () => logistics.atHome(),
      idle: () => processes.userProcesses().length === 0,
      autoUnload: () => d.settings.get('autoUnload'),
      load: () => logistics.load(),
      known: () => logistics.records().filter((r) => r.readAt > 0).length,
      getEnded: () => {
        const job = getControllerOf(d.task)?.job;
        if (!job || job === seenJob || !job.process?.done) return false;
        seenJob = job;
        return true;
      },
      onGetUnload: (r: UnloadReport) => {
        if (r.moved.length > 0 || r.boxes > 0) d.chat.say(unloadLine(r));
      },
      log,
    }),
  );
  // containers appearing / disappearing within the radius of home (not the bot's own box placing)
  const offBlocks = world.onBlockUpdate((p, before, after) => {
    if (logistics.busy) return;
    const h = home();
    if (!h) return;
    const was = !!before && isHomeContainer(before.name);
    const is = isHomeContainer(after.name);
    if (was === is) return;
    if (Math.hypot(p.x + 0.5 - (h.x + 0.5), p.y - h.y, p.z + 0.5 - (h.z + 0.5)) > d.settings.get('homeChestRadius')) return;
    if (is) chore.appeared(p);
    else if (memory().delete(p)) log.info(`chests: ${before?.name ?? 'container'} at ${fmtPos(p)} is gone, forgotten`);
  });
  const offSpawn = d.conn.onSpawn(() => chore.newSession());
  const stop = d.task.stop.bind(d.task);
  d.task.stop = () => {
    offBlocks();
    offSpawn();
    stop();
  };

  const start = (job: HomeJob): HomeJobProcess => processes.add(new HomeJobProcess(runner, job));
  const control: HomeControl = { logistics, chore, memory, start };
  controls.set(d.task, control);

  d.chat.register({
    name: 'unload',
    help: '[all] (put what I carry into the chests at home: same item first, then a chest labelled for it, then the emptiest; spare shulker boxes when the chests are full)',
    run: ({ args, reply }) => {
      const a = (args[0] ?? '').toLowerCase();
      if (args.length > 1 || (a !== '' && a !== 'all')) return reply('usage: !unload [all]');
      if (!home()) return reply('unload: no home set (!home set)');
      const known = logistics.records().filter((r) => r.readAt > 0).length;
      if (known === 0) return reply('unload: I know no chest near home yet (!chests scan)');
      const load = logistics.load();
      reply(`unloading ${load.stacks} stack${load.stacks === 1 ? '' : 's'}${load.fullBoxes ? ` and ${load.fullBoxes} full shulker box${load.fullBoxes === 1 ? '' : 'es'}` : ''} into ${known} known container${known === 1 ? '' : 's'}${processes.paused ? ' (held: !resume)' : ''}`);
      const p = start({ kind: 'unload', all: a === 'all' });
      void p.result.then((r) => reply(r?.kind === 'unload' ? unloadLine(r.report) : 'unload: stopped'));
    },
  });

  d.chat.register({
    name: 'stock',
    help: '[item] (what the chests at home hold, from memory; `!stock shulker` counts shulker boxes)',
    run: ({ args, reply }) => {
      if (args.length > 1) return reply('usage: !stock [item]');
      const h = home();
      reply(stockLine(memory(), args[0], h ? { x: h.x + 0.5, y: h.y, z: h.z + 0.5 } : undefined, h ? d.settings.get('homeChestRadius') + 1 : Infinity));
    },
  });

  d.chat.register({
    name: 'chests',
    help: '[scan | label x y z <text>|none] (the containers at home; scan: look inside again)',
    run: ({ args, reply }) => {
      const a = (args[0] ?? '').toLowerCase();
      const h = home();
      if (a === '') {
        const at = h ? { x: h.x + 0.5, y: h.y, z: h.z + 0.5 } : mob.position();
        reply(chestsLine(at ? memory().near(at, d.settings.get('homeChestRadius') + 1) : memory().all(), Date.now(), at));
        return;
      }
      if (a === 'scan') {
        if (args.length > 1) return reply('usage: !chests scan');
        if (!h) return reply('chests: no home set (!home set)');
        reply(`chests: reading the containers within ${d.settings.get('homeChestRadius')} blocks of home${processes.paused ? ' (held: !resume)' : ''}`);
        const p = start({ kind: 'scan' });
        void p.result.then((r) => reply(r?.kind === 'scan' ? scanLine(r.report) : 'chests: scan stopped'));
        return;
      }
      if (a === 'label') {
        const pos = d.parseBlock(args.slice(1, 4));
        const text = args.slice(4).join(' ').trim();
        if (!pos || !text || text.length > 32) return reply('usage: !chests label x y z <text, up to 32 characters>|none');
        const mem = memory();
        let rec = mem.get(pos);
        if (!rec) {
          const b = world.blockAt(pos);
          if (!b || !isHomeContainer(b.name)) return reply(`chests: no container known at ${fmtPos(pos)}`);
          rec = unreadRecord(pos, b.name);
        }
        const next = { ...rec };
        if (text.toLowerCase() === 'none') delete next.label;
        else next.label = text.toLowerCase();
        mem.set(next);
        reply(next.label ? `chests: ${chestName(next)} labelled` : `chests: label of ${chestName(next)} removed`);
        return;
      }
      reply('usage: !chests [scan | label x y z <text>|none]');
    },
  });
  log.info(`home: !unload, !stock, !chests ready (memory ${world.cache?.chests ? 'in the world cache' : 'in memory'}, ${memory().size} remembered: ${memory().all().slice(0, 3).map((r) => chestKey(r)).join(' ')})`);
  return control;
}
