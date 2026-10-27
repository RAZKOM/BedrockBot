// `!bring` (wave 10, Track AS; docs/home.md "Bring", decision 0040), owner-only like every command: the
// second verb next to `!get`. `!get` makes new things and ends at home (`!unload`); `!bring` takes
// things already stored in the chests at home (by the chest memory, `!stock`) and carries them to the
// owner.
//
//   !bring <item> [n] [to <player>|home]   bringing 64 torches to Steve (from 2 chests)
//                                          ... brought 64 torches (from 2 chests)
//   !bring stop | status
//
// The item is any name the `!get` catalog knows (aliases too: `iron`, `wood`) or any item the chest
// memory or the inventory knows (`!bring shulker`, `!bring torches 64`). n defaults to one stack. What
// the bot carries counts first; then the nearest chests by the memory's counts; full shulker boxes
// holding the item only when the loose stacks are not enough (the whole box comes along; the reply
// says so). The delivery is `!come`'s walk (the tracked player, else the locator bar's position; a
// long trip eats first) and stops within 2 blocks; `home`, the console, or an owner who is not online:
// the bot carries the items home and says so. A user process (BringProcess): flee, guard and night
// pre-empt it as usual and it carries on afterwards.
//
// The `!get` hint: `!get iron 16` with at least 16 iron in the chests replies
// `getting 16 iron: the chests hold 128 (!bring iron 16 fetches it); mining iron_ore anyway` (setting
// `getSuggestsBring`); `!get` still never takes from chests.
import type { Vec3 } from '../connection/types.ts';
import type { RuntimeSettings } from '../config/settings.ts';
import type { Logger } from '../log.ts';
import type { ChestRecord } from '../world/cache/chests.ts';
import { bringMatches, defaultCount, itemsText, parseBringArgs, planBring, resolveBringItem, stockOf, type BringItem } from '../skills/home/bring.ts';
import type { WithdrawReport } from '../skills/home/logistics.ts';
import type { Lookup } from '../skills/items/catalog.ts';
import { BringProcess, type BringJob, type BringResult, type BringRunner, type DeliverResult } from '../tasks/process/bring.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import { navRemaining } from '../tasks/process/goto.ts';
import type { ProcessManager } from '../tasks/process/manager.ts';
import type { Sender } from './chat.ts';
import { getControllerOf } from './commands-get.ts';
import { homeControlOf } from './commands-home.ts';

export interface BringExtra {
  logger?: Logger | undefined;
}

/** What the controller needs (the afk task's parts; faked in the unit tests). */
export interface BringHost {
  processes: Pick<ProcessManager, 'add' | 'stop' | 'paused'>;
  /** The chest memory around home (HomeLogistics.records). */
  records(): ChestRecord[];
  /** Item names in the inventory (slots 0..35, with counts). */
  inventory(): { name: string; count: number }[];
  home(): Vec3 | undefined;
  runner: BringRunner;
  settings: Pick<RuntimeSettings, 'get'>;
}

type Found = Extract<Lookup, { command: string }>;

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Item names the memory and the inventory know (for the word -> names resolution). */
function knownNames(records: readonly ChestRecord[], inv: readonly { name: string }[]): Set<string> {
  const out = new Set<string>();
  for (const r of records) {
    for (const k of Object.keys(r.contents)) out.add(k);
    for (const k of Object.keys(r.inBoxes ?? {})) out.add(k);
  }
  for (const s of inv) out.add(s.name);
  return out;
}

/** `brought 64 torches (from 2 chests)`, `brought 1 shulker box holding 2 diamonds home (...)`, `bring: ...` */
export function endLine(job: BringJob, r: BringResult | undefined): string {
  if (!r) return 'bring: stopped';
  const w = r.withdraw;
  const word = job.item.word;
  const boxItems = w.boxes.reduce((a, b) => a + b.items, 0);
  const looseNames = Object.keys(w.taken).filter((k) => !w.boxes.some((b) => b.name === k) || job.item.boxes);
  const label = looseNames.length === 1 ? looseNames[0]! : job.item.names.length === 1 ? job.item.names[0]! : word;
  const loose = Math.min(w.carried, Math.max(0, job.want - boxItems));
  if (!r.deliver) {
    if (w.reason === 'no_home') return 'bring: no home set (!home set)';
    return `bring: found no ${word}: the chests held less than remembered (!chests scan reads them again; !get ${word} makes new ones)`;
  }
  const what: string[] = [];
  if (loose > 0 || w.boxes.length === 0) what.push(itemsText(loose, label));
  if (w.boxes.length) what.push(`${itemsText(w.boxes.length, w.boxes[0]!.name)} holding ${itemsText(boxItems, job.item.names[0] ?? word)}`);
  const text = what.join(' and ');
  const notes: string[] = [];
  notes.push(w.from.length ? `from ${plural(w.from.length, 'chest')}` : 'I carried them');
  const short = job.want - loose - boxItems;
  if (short > 0) notes.push(`${short} short: the chests hold no more`);
  if (w.boxes.length) notes.push(`the only source: a full shulker box out of ${[...new Set(w.boxes.map((b) => b.from))].join(', ')}`);
  if (w.reason === 'inventory_full') notes.push('my inventory is full');
  const d = r.deliver;
  if (!d.ok) return `bring: carrying ${text} but could not get to ${'player' in job.to ? job.to.player : 'home'}: ${d.reason ?? 'failed'}`;
  return `brought ${text}${d.at === 'home' ? ' home' : ''} (${notes.join('; ')})${d.fallback ? `; ${d.fallback}` : ''}`;
}

export class BringController {
  private readonly h: BringHost;
  job: { job: BringJob; process: BringProcess; startedAt: number } | undefined;
  last: { job: BringJob; result: BringResult | undefined; line: string } | undefined;

  constructor(h: BringHost) {
    this.h = h;
  }

  /** The `!get` hint (undefined when the chests do not hold n, or getSuggestsBring is off). */
  hint(f: Found, typed: string): string | undefined {
    if (!this.h.settings.get('getSuggestsBring') || f.count <= 0) return undefined;
    const records = this.h.records();
    const item = resolveBringItem(typed, knownNames(records, []));
    const s = stockOf(records, item);
    const total = s.loose + s.boxed;
    if (total < f.count) return undefined;
    return `getting ${f.count} ${typed}: the chests hold ${total} (!bring ${typed} ${f.count} fetches it)`;
  }

  run(sender: Sender, args: readonly string[], reply: (m: string) => void): void {
    const a = (args[0] ?? '').toLowerCase();
    if (args.length === 0) return reply('usage: !bring <item> [n] [to <player>|home] | stop | status');
    if (args.length === 1 && a === 'stop') return reply(this.stop());
    if (args.length === 1 && a === 'status') return reply(this.status());
    const p = parseBringArgs(args);
    if ('error' in p) return reply(`usage: !bring <item> [n] [to <player>|home] (${p.error})`);
    const home = this.h.home();
    let to: BringJob['to'];
    let note = '';
    if (p.to === 'home') to = { home: true };
    else if (p.to) to = { player: p.to };
    else if (sender.kind === 'player') to = { player: sender.name.replace(/§./g, '') };
    else {
      to = { home: true };
      note = ' (the console has no position)';
    }
    if (!home) return reply('bring: no home set (!home set)');
    const records = this.h.records();
    const inv = this.h.inventory();
    const item: BringItem = resolveBringItem(p.name, knownNames(records, inv));
    const want = p.count ?? defaultCount(item);
    let carried = 0;
    for (const s of inv) if (bringMatches(item, s.name)) carried += s.count;
    const plan = planBring(records, item, want, carried);
    const known = records.filter((r) => r.readAt > 0).length;
    if (carried === 0 && plan.loose + plan.boxed === 0) {
      if (known === 0) return reply('bring: I know no chest near home yet (!chests scan)');
      return reply(`bring: no ${item.word} in the ${plural(known, 'container')} I know (!stock ${item.word}; !get ${item.word} makes new ones)`);
    }
    const job: BringJob = { item, want, to };
    const parts: string[] = [];
    const chests = new Set(plan.sources.map((s) => s.key)).size;
    if (plan.carried > 0) parts.push(`${Math.min(plan.carried, want)} carried`);
    if (chests > 0) parts.push(`from ${plural(chests, 'chest')}`);
    if (plan.sources.some((s) => s.box)) parts.push('a full shulker box comes along: the only source');
    if (plan.short > 0) parts.push(`only ${want - plan.short} known: ${plan.short} short`);
    const who = 'player' in to ? to.player : 'home';
    reply(`bringing ${itemsText(want, item.boxes ? 'shulker_box' : item.word)} to ${who}${parts.length ? ` (${parts.join(', ')})` : ''}${note}${this.h.processes.paused ? ' (held: !resume)' : ''}`);
    const proc = this.h.processes.add(new BringProcess(this.h.runner, job));
    const entry = { job, process: proc, startedAt: Date.now() };
    this.job = entry;
    void proc.result.then((r) => {
      const line = endLine(job, r);
      this.last = { job, result: r, line };
      if (this.job === entry) this.job = undefined;
      reply(line);
    });
  }

  stop(): string {
    const j = this.job;
    if (!j || j.process.done) return 'bring: nothing to stop';
    const line = j.process.status().line;
    this.h.processes.stop(j.process, 'stopped');
    return `stopped ${line}`;
  }

  status(): string {
    const j = this.job;
    if (j && !j.process.done) return `bring: ${j.process.status().line}`;
    return `bring: idle${this.last ? ` (last: ${this.last.line})` : ''}`;
  }
}

const controllers = new WeakMap<object, BringController>();

/** The `!bring` controller of a task (tests, status). */
export function bringControllerOf(task: object): BringController | undefined {
  return controllers.get(task);
}

/** Register `!bring` on the afk task (tasks/registry.ts, one line, after the home logistics). */
export function registerBringCommands(d: CommandDeps, extra: BringExtra = {}): BringController | undefined {
  const { processes, mobility: mob, pve } = d;
  const home = homeControlOf(d.task);
  if (!processes || !mob || !pve || !home) {
    d.chat.register({ name: 'bring', help: '(needs walking)', run: ({ reply }) => reply(d.needsWalking('bring')) });
    return undefined;
  }
  const log = extra.logger ?? d.log;
  const logistics = home.logistics;
  const homePoint = (): Vec3 | undefined => d.task.home?.get();
  const interrupted = (at: DeliverResult['at']): DeliverResult => ({ ok: false, reason: 'interrupted', at });
  const goHome = async (cancelled: () => boolean, fallback?: string): Promise<DeliverResult> => {
    const h = homePoint();
    if (!h) return { ok: false, reason: 'no home set', at: 'home', ...(fallback ? { fallback } : {}) };
    const r = await pve.mover.goto({ type: 'near', p: { x: h.x + 0.5, y: h.y, z: h.z + 0.5 }, r: 2 }, { timeoutTicks: 6000 });
    if (cancelled()) return interrupted('home');
    return { ok: r.ok, ...(r.ok ? {} : { reason: r.reason ?? 'failed' }), at: 'home', ...(fallback ? { fallback } : {}) };
  };
  const runner: BringRunner = {
    withdraw: (cancelled, job): Promise<WithdrawReport> => logistics.withdraw(cancelled, { item: job.item, want: job.want }),
    deliver: async (cancelled, job) => {
      if ('home' in job.to) return goHome(cancelled);
      const name = job.to.player;
      let feet = pve.playerFeet(name);
      if (!feet) return goHome(cancelled, `${name} is not online, so I took them home`);
      // trip readiness (come's rule): a long trip with food or health below 14 eats first
      if (pve.prepNeeded(feet)) await pve.prepare(() => !cancelled(), () => undefined);
      if (cancelled()) return interrupted('player');
      for (let leg = 0; leg < 5; leg++) {
        if (pve.trackedPlayerFeet(name)) {
          const r = await pve.follower.come(name);
          if (cancelled()) return interrupted('player');
          if (r.ok) return { ok: true, at: 'player' };
          if (r.reason !== 'not_found') return { ok: false, reason: r.reason ?? 'failed', at: 'player' };
        }
        // beyond the entity range: the locator bar, else where the player was last known
        feet = pve.locator.find(name)?.feet ?? feet;
        if (!feet) break;
        log.info(`bring: ${name} is beyond the entity range; walking to ${feet.x.toFixed(1)} ${feet.y.toFixed(1)} ${feet.z.toFixed(1)}`);
        const r = await pve.mover.goto({ type: 'near', p: { x: feet.x, y: Math.round(feet.y), z: feet.z }, r: 2 }, { timeoutTicks: 2400, sprint: true });
        if (cancelled()) return interrupted('player');
        if (!r.ok && !pve.trackedPlayerFeet(name)) return { ok: false, reason: r.reason ?? 'failed', at: 'player' };
        if (r.ok && !pve.trackedPlayerFeet(name)) return { ok: false, reason: `${name} was not there`, at: 'player' };
      }
      return { ok: false, reason: 'not_found', at: 'player' };
    },
    cancel: () => {
      pve.follower.stop();
      mob.skills.cancel();
    },
    remaining: () => navRemaining(mob.skills.nav, mob.position()),
  };
  const c = new BringController({
    processes,
    records: () => logistics.records(),
    inventory: () => mob.world.inventory.slots.slice(0, 36).filter((s): s is NonNullable<typeof s> => !!s && s.count > 0).map((s) => ({ name: s.name, count: s.count })),
    home: homePoint,
    runner,
    settings: d.settings,
  });
  controllers.set(d.task, c);
  const g = getControllerOf(d.task);
  if (g) g.stockHint = (f, typed) => c.hint(f, typed); // the !get hint
  d.chat.register({
    name: 'bring',
    help: '<item> [n] [to <player>|home] | stop | status (stored items to you)',
    tier: 'front', group: 'home', example: '!bring torch 64', // Track AS
    run: ({ sender, args, reply }) => {
      c.run(sender, args, reply);
    },
  });
  log.info('bring: !bring ready');
  return c;
}
