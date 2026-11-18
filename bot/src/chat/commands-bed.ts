// A bed (Track E3, docs/early-game.md "A bed", ADR 0100), owner-only like every command:
//   !bed          set the carried bed down where the night rule sleeps in it: by home (the bot walks there first), else
//                 by the shelter, else here (and the `bed` waypoint is set at it, unless the owner set one); by day it
//                 is clicked once so the respawn point moves to it; nothing is placed when a bed is known there
//   !bed status   the beds the night rule knows and the beds carried
// Registered by the afk task after the PvE commands (the night process and its bed clicker; tasks/registry.ts).
import type { Vec3 } from '../connection/types.ts';
import { BED, bedReasonText, bedsCarried, placeBed, type BedPlaceResult } from '../skills/survival/bed-place.ts';
import { inSleepWindow } from '../skills/survival/sleep.ts';
import { isBuiltBlock } from '../skills/terrain/classify.ts';
import { BedProcess, type BedJobDeps, type BedJobResult } from '../tasks/process/bed.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import { settingsMover } from '../tasks/process/goto.ts';
import { NightProcess } from '../tasks/process/night.ts';
import { waypointStoreOf } from './commands-nav.ts';

const fmt = (p: Vec3): string => `${p.x} ${p.y} ${p.z}`;

/** The end line of `!bed`. */
export function bedLine(r: BedJobResult, where: string): string {
  const p = r.place;
  if (!p) return `bed: ${r.reason}`;
  if (!p.ok) return `bed: ${bedReasonText(p.reason, p.detail)}`;
  if (p.already) return `bed: one stands at ${fmt(p.head)} already`;
  const extra = [r.spawnSet ? 'respawn point set' : 'the night click sets the respawn point', ...(r.marked ? ['bed waypoint set'] : [])];
  return `bed placed at ${fmt(p.head)} ${where} (${extra.join(', ')})`;
}

export interface BedControl {
  /** Beds the night rule knows (by the shelter, home, the bed waypoint). */
  beds(): Vec3[];
  start(): BedProcess;
  /** Where a bed goes now (`by home`, `by the shelter`, `here`). */
  where(): string;
}

const controls = new WeakMap<object, BedControl>();

/** The bed control of a task (the obtain job, tests). */
export function bedControlOf(task: object): BedControl | undefined {
  return controls.get(task);
}

/** Register `!bed` (tasks/registry.ts, after the PvE commands). */
export function registerBedCommands(d: CommandDeps): BedControl | undefined {
  const { processes, skills, world, mobility, pve } = d;
  const night = processes?.find('night').find((x): x is NightProcess => x instanceof NightProcess);
  if (!processes || !skills || !world || !mobility || !pve || !night) {
    d.chat.register({ name: 'bed', help: '(needs walking)', run: ({ reply }) => reply(d.needsWalking('bed')) });
    return undefined;
  }
  const log = d.log;
  const mover = settingsMover(skills, d.settings);
  const centre = (): Vec3 | undefined => d.task.home?.get() ?? d.task.shelter?.get();
  const where = (): string => (d.task.home?.get() ? 'by home' : d.task.shelter?.get() ? 'by the shelter' : 'here');
  const place = (cancelled: () => boolean): Promise<BedPlaceResult> =>
    placeBed(
      {
        world,
        loop: mobility.loop,
        skills: { place: (p, o) => skills.place(p, o), dig: (p) => skills.dig(p), goto: (g, o) => mover.goto(g, o) },
        centre,
        beds: () => night.beds(),
        built: isBuiltBlock,
        log,
      },
      cancelled,
    );
  const deps: BedJobDeps = {
    place,
    night: () => inSleepWindow(night.timeOfDay()),
    click: async (head) => {
      const s = night.sleeper;
      if (!s) return { ok: false, reason: 'no_sleeper' };
      const r = await s.sleep(head);
      if (r.ok) s.wake(); // asleep by day cannot happen; out of the window the night rule owns the bed
      return r;
    },
    mark: (head) => {
      night.bedsChanged();
      if (centre()) return false;
      const store = waypointStoreOf(d.task);
      const old = store?.get('bed');
      if (!store || (old && !old.auto)) return false;
      store.set('bed', head, { auto: true });
      return true;
    },
    cancel: () => {
      if (pve.mover.nav.busy) pve.mover.cancel();
      skills.cancel();
    },
    log,
  };
  const control: BedControl = {
    beds: () => night.beds(),
    start: () => processes.add(new BedProcess(deps)),
    where,
  };
  controls.set(d.task, control);

  d.chat.register({
    name: 'bed',
    group: 'home',
    example: '!bed',
    auto: '!get bed and !get kit iron run it as a step; at night the bed is slept in (!sleep, autoSleep)',
    help: '[status] (set the bed I carry down where I sleep: by home, else by the shelter, else here with the bed waypoint; by day I click it so I respawn there)',
    run: ({ args, reply }) => {
      const a = (args[0] ?? '').toLowerCase();
      if (a === 'status') {
        const list = night.beds();
        return reply(`bed: ${list.length ? `${list.length} where I sleep (${list.slice(0, 3).map(fmt).join(', ')})` : 'none where I sleep'}; ${bedsCarried(world.inventory.slots)} carried`);
      }
      if (args.length > 0) return reply('usage: !bed [status]');
      const there = night.beds()[0];
      if (there) return reply(`bed: one stands at ${fmt(there)} already`);
      if (bedsCarried(world.inventory.slots) === 0) return reply(`bed: ${bedReasonText('no_bed_item')}`);
      const w = where();
      reply(`bed: placing the ${BED} I carry ${w}${processes.paused ? ' (held: !resume)' : ''}`);
      void control.start().result.then((r) => reply(bedLine(r, w)));
    },
  });
  return control;
}
