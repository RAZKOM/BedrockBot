// Track AW (wave 11, docs/crafting.md): crafting commands and the compaction step of `!unload`.
//   !craft <item> [n]      make n (default 1) of an item through the normal screens: the inventory's
//                          2 x 2 grid, or a crafting table (one within reach, else the bot places the
//                          one it carries, or crafts one from planks, and picks it up again)
//   !compact [kind]        craft every compactable kind carried (raw iron / copper / gold, ingots, gems,
//                          coal, redstone, lapis: 9 -> 1 storage block), or one kind
// Both run as a user process (PRIORITY.user 40): `!stop` ends them between batches, a pre-emption
// (flee, guard, night) pauses them and the job runs again for what is left. The unload hook: the
// unload plan carries `compact` steps (skills/home/unloader.ts + skills/craft/compact.ts) and this
// module installs the runner that crafts them (`setCompactRunner`); the unload job runs it before its
// moves, under its own serial lock, and says `compacted 54 raw_iron into 6 raw_iron_block`.
// Never consumed: anything `!drop items` keeps (tools, armour, food, totems, shulker boxes, ender
// chests), the flight kit, and the `craftReserve` setting's counts.
import { parseReserve, type RuntimeSettings } from '../config/settings.ts';
import type { Logger } from '../log.ts';
import { compactAll, compactLine, installCompactPlanner, COMPACT_KINDS, type CompactDone } from '../skills/craft/compact.ts';
import { Crafter, craftLine, type CraftResult } from '../skills/craft/crafter.ts';
import { RecipeIndex, usedText } from '../skills/craft/recipes.ts';
import { isFlightKitItem } from '../skills/fly/kit.ts';
import { setCompactPlanner, setCompactRunner } from '../skills/home/unloader.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import { BaseProcess, PRIORITY, type ProcessKind, type ProcessManager, type ProcessStatus } from '../tasks/process/manager.ts';
import type { Containers } from '../world/containers.ts';
import { keepOnDropItems } from './commands-survival.ts';

export const CRAFT_COMMANDS = ['craft', 'compact'] as const;

export interface CraftExtra {
  /** The afk task's shared Containers (the screens are watched on it). */
  containers?: Containers | undefined;
  logger?: Logger | undefined;
}

export type CraftJob = { kind: 'craft'; item: string; n: number } | { kind: 'compact'; only?: string };

/** What the process drives (the Crafter in production, fakes in the unit tests). */
export interface CraftRunner {
  craft(cancelled: () => boolean, item: string, n: number): Promise<CraftResult>;
  /** Cancel the running skill (a pre-emption). */
  cancel(): void;
}

export interface CraftControl {
  crafter: Crafter;
  recipes: RecipeIndex;
  /** `!status` line. */
  status(): string;
}

const controls = new WeakMap<object, CraftControl>();

/** The crafting control of a task (tests, status). */
export function craftControlOf(task: object): CraftControl | undefined {
  return controls.get(task);
}

/** Items the crafter never consumes: `!drop items` keeps them, or they belong to the flight kit. */
export function neverConsume(name: string): boolean {
  return keepOnDropItems(name) || isFlightKitItem(name);
}

/** `!craft <item> [n]` -> { item, n } (n 1..2304), or undefined. */
export function parseCraftArgs(args: readonly string[]): { item: string; n: number } | undefined {
  const a = args.filter((x) => x !== '');
  if (a.length === 0 || a.length > 2) return undefined;
  let item = a[0]!.toLowerCase();
  let count: string | undefined = a[1];
  if (/^\d+$/.test(item) && a[1] !== undefined) {
    count = item;
    item = a[1].toLowerCase();
  }
  if (!/^(minecraft:)?[a-z][a-z0-9_]{0,63}$/.test(item)) return undefined;
  const n = count === undefined ? 1 : Number(count);
  if (!Number.isInteger(n) || n < 1 || n > 2304) return undefined;
  return { item: item.replace(/^minecraft:/, ''), n };
}

/** `!craft` and `!compact` as a user process: one craft (or the compaction list) per run; a resumed run makes what is still missing. */
export class CraftProcess extends BaseProcess {
  readonly name: string;
  readonly kind: ProcessKind = 'user';
  readonly result: Promise<CraftResult[] | undefined>;
  private resolve!: (r: CraftResult[] | undefined) => void;
  private readonly runner: CraftRunner;
  readonly job: CraftJob;
  /** Results so far (a resumed craft adds to the first one's count). */
  readonly results: CraftResult[] = [];
  private crafted = 0;
  private runs = 0;
  /** Compaction: the steps still to do. */
  private steps: { kind: string; block: string; blocks: number }[] | undefined;
  private readonly planSteps: () => { kind: string; block: string; blocks: number }[];

  constructor(runner: CraftRunner, job: CraftJob, planSteps: () => { kind: string; block: string; blocks: number }[] = () => []) {
    super();
    this.runner = runner;
    this.job = job;
    this.planSteps = planSteps;
    this.name = job.kind;
    this.result = new Promise((r) => {
      this.resolve = r;
    });
  }

  get priority(): number {
    return PRIORITY.user;
  }

  protected run(t: number): void {
    this.runs++;
    const cancelled = () => t !== this.token || this.done;
    void this.work(cancelled).then(
      (r) => {
        if (cancelled()) return;
        this.finish();
        this.resolve(r);
      },
      () => {
        if (cancelled()) return;
        this.finish();
        this.resolve(undefined);
      },
    );
  }

  private async work(cancelled: () => boolean): Promise<CraftResult[]> {
    if (this.job.kind === 'craft') {
      const left = this.job.n - this.crafted;
      if (left > 0) {
        const r = await this.runner.craft(cancelled, this.job.item, left);
        this.crafted += r.crafted;
        this.results.push(r);
      }
      return this.results;
    }
    this.steps ??= this.planSteps();
    while (this.steps.length > 0) {
      if (cancelled()) return this.results;
      const s = this.steps[0]!;
      const r = await this.runner.craft(cancelled, s.block, s.blocks);
      if (r.reason === 'interrupted' || cancelled()) {
        if (r.crafted > 0) s.blocks -= r.crafted;
        if (s.blocks <= 0) this.steps.shift();
        this.results.push(r);
        return this.results;
      }
      this.results.push(r);
      this.steps.shift();
    }
    return this.results;
  }

  protected halt(): void {
    this.runner.cancel();
  }

  protected override onStopped(): void {
    this.resolve(this.results.length ? this.results : undefined);
  }

  status(): ProcessStatus {
    const state = this.controlled ? 'running' : this.runs > 0 ? 'paused' : 'waiting';
    const what = this.job.kind === 'craft' ? `craft ${this.job.n} ${this.job.item}${this.crafted ? ` (${this.crafted} done)` : ''}` : `compact${this.job.only ? ` ${this.job.only}` : ''}`;
    return { line: `${what} (${state})` };
  }
}

/** The compaction results of a `!compact` run as one line. */
export function compactDone(results: readonly CraftResult[]): CompactDone[] {
  const out: CompactDone[] = [];
  for (const r of results) {
    if (r.crafted <= 0) continue;
    const [kind, uses] = Object.entries(r.used)[0] ?? ['?', 0];
    out.push({ kind, block: r.item, blocks: r.crafted, uses });
  }
  return out;
}

/**
 * The runner the unload job calls for `plan.compact` (unloader.ts `compactRunner`): crafts each kind's
 * blocks and answers the reply fragment. `craft` is the Crafter's craft (fakes in the unit tests).
 */
export function compactRunnerFor(
  craft: (block: string, blocks: number, cancelled: () => boolean) => Promise<CraftResult>,
  blockOf: (kind: string) => string | undefined,
  log?: Logger,
): (steps: readonly { kind: string; count: number }[], cancelled: () => boolean) => Promise<string | undefined> {
  return async (steps, cancelled) => {
    const done: CompactDone[] = [];
    for (const s of steps) {
      if (cancelled()) break;
      const blocks = Math.floor(s.count / 9);
      const block = blockOf(s.kind);
      if (!block || blocks <= 0) continue;
      log?.info(`unload: compacting ${s.count} ${s.kind} into ${blocks} ${block} first`);
      const r = await craft(block, blocks, cancelled);
      done.push(...compactDone([r]));
      if (!r.ok) log?.warn(`unload: compaction of ${s.kind}: ${craftLine(r)}`);
    }
    return done.length ? compactLine(done) : undefined;
  };
}

/** Register `!craft` and `!compact` on the afk task (tasks/registry.ts, one line, after the home logistics). */
export function registerCraftCommands(d: CommandDeps, extra: CraftExtra = {}): CraftControl | undefined {
  const { processes, mobility: mob, pve, world, skills } = d;
  const containers = extra.containers;
  if (!processes || !mob || !pve || !world || !skills || !containers) {
    for (const name of CRAFT_COMMANDS) d.chat.register({ name, help: '(needs walking)', run: ({ reply }) => reply(d.needsWalking(name)) });
    return undefined;
  }
  const log = extra.logger ?? d.log;
  const settings: RuntimeSettings = d.settings;
  const reserve = (name: string): number => parseReserve(settings.get('craftReserve')).get(name) ?? 0;
  const recipes = new RecipeIndex((id) => world.registry.itemName(id), d.conn);
  const crafter = new Crafter({
    source: d.conn,
    loop: mob.loop,
    world: { blockAt: (p) => world.blockAt(p), chunks: world.chunks, inventory: world.inventory },
    containers,
    recipes,
    runtimeId: () => world.self.runtimeId,
    hotbar: pve.hotbar,
    skills: { place: (p, o) => skills.place(p, o), dig: (p, o) => skills.dig(p, o), collect: (r, t, o) => skills.collect(r, t, o), goto: (g, o) => skills.goto(g, o) },
    keep: neverConsume,
    reserve,
    log,
  });
  const runner: CraftRunner = {
    craft: (cancelled, item, n) => crafter.craft(item, n, cancelled),
    cancel: () => skills.cancel(),
  };
  const planOpts = () => ({ keep: neverConsume, reserve });
  // the unload plan's compaction step and its runner (reset when the task stops)
  installCompactPlanner(() => (settings.get('compactOnUnload') ? planOpts() : { keep: () => true }));
  setCompactRunner(compactRunnerFor((block, blocks, cancelled) => crafter.craft(block, blocks, cancelled), (kind) => compactAll(world.inventory.slots, planOpts(), kind)[0]?.block, log));
  const control: CraftControl = {
    crafter,
    recipes,
    status: () => `craft: ${crafter.phase}; ${recipes.size} recipes; ${crafter.stats.items} items in ${crafter.stats.crafts} crafts, ${crafter.stats.tablesPlaced} tables placed${crafter.pendingTables.length ? `, ${crafter.pendingTables.length} left standing` : ''}`,
  };
  controls.set(d.task, control);
  const stop = d.task.stop.bind(d.task);
  d.task.stop = () => {
    setCompactPlanner(undefined);
    setCompactRunner(undefined);
    crafter.dispose();
    recipes.dispose();
    stop();
  };

  d.chat.register({
    name: 'craft',
    tier: 'more',
    group: 'work',
    example: '!craft iron_block 4',
    auto: '!unload crafts raw iron, ingots, gems, coal, redstone and lapis into blocks when their chest cannot take the load (compactOnUnload)',
    help: '<item> [n] (craft n of an item from what I carry; a crafting table is placed and picked up for 3x3 recipes)',
    run: ({ args, reply }) => {
      const a = parseCraftArgs(args);
      if (!a) return reply('usage: !craft <item> [n] (e.g. !craft iron_block 4, !craft 32 oak_planks)');
      if (recipes.size === 0) return reply('craft: no recipes yet (the server sends them at join)');
      if (processes.userProcesses().some((p) => p.name === 'craft' || p.name === 'compact')) return reply('craft: busy crafting already (!stop ends it)');
      const plan = crafter.plan(a.item, a.n);
      if (!plan) return reply(`craft: no recipe for ${a.item} I can use (crafting table and inventory recipes only)`);
      if (plan.crafts <= 0) {
        const s = plan.shortfall;
        return reply(`craft: no ${s?.name ?? 'ingredients'} for ${plan.item}${s ? ` (need ${s.need}, have ${s.have})` : ''}`);
      }
      const make = Math.min(a.n, plan.crafts * plan.outputPer);
      const short = plan.shortfall && make < a.n ? `; ${Math.max(0, plan.shortfall.need - plan.shortfall.have)} ${plan.shortfall.name} short for ${a.n}` : '';
      reply(`crafting ${make} ${plan.item} (${usedText(plan.perCraft, plan.crafts)}${plan.table ? ', crafting table' : ''}${short})${processes.paused ? ' (held: !resume)' : ''}`);
      const p = processes.add(new CraftProcess(runner, { kind: 'craft', item: a.item, n: a.n }));
      void p.result.then((rs) => {
        if (!rs || rs.length === 0) return reply('craft: stopped');
        const total: CraftResult = { ...rs[0]!, crafted: rs.reduce((x, r) => x + r.crafted, 0), used: {}, batches: rs.reduce((x, r) => x + r.batches, 0), requests: rs.reduce((x, r) => x + r.requests, 0), ms: rs.reduce((x, r) => x + r.ms, 0) };
        for (const r of rs) for (const [k, v] of Object.entries(r.used)) total.used[k] = (total.used[k] ?? 0) + v;
        const last = rs[rs.length - 1]!;
        total.reason = last.reason;
        if (last.shortfall) total.shortfall = last.shortfall;
        else delete total.shortfall;
        if (last.table) total.table = last.table;
        delete total.dropped;
        for (const r of rs) for (const [k, v] of Object.entries(r.dropped ?? {})) (total.dropped ??= {})[k] = (total.dropped[k] ?? 0) + v;
        reply(craftLine(total));
      });
    },
  });

  d.chat.register({
    name: 'compact',
    tier: 'more',
    group: 'work',
    example: '!compact',
    auto: '!unload compacts a kind by itself when its chest cannot take the load (compactOnUnload)',
    help: '[kind] (craft raw iron / copper / gold, ingots, gems, coal, redstone and lapis I carry into storage blocks, 9 -> 1)',
    run: ({ args, reply }) => {
      if (args.length > 1) return reply('usage: !compact [kind]');
      const only = args[0]?.toLowerCase().replace(/^minecraft:/, '');
      if (recipes.size === 0) return reply('compact: no recipes yet (the server sends them at join)');
      if (processes.userProcesses().some((p) => p.name === 'craft' || p.name === 'compact')) return reply('compact: busy crafting already (!stop ends it)');
      const steps = compactAll(world.inventory.slots, planOpts(), only);
      if (steps.length === 0) return reply(`compact: nothing to compact${only ? ` for ${only}` : ''} (9 or more of ${COMPACT_KINDS.slice(0, 6).join(', ')}, ...)`);
      reply(`compacting ${steps.map((s) => `${s.uses} ${s.kind} -> ${s.blocks} ${s.block}`).join(', ')}${processes.paused ? ' (held: !resume)' : ''}`);
      const p = processes.add(new CraftProcess(runner, { kind: 'compact', ...(only ? { only } : {}) }, () => compactAll(world.inventory.slots, planOpts(), only).map((s) => ({ kind: s.kind, block: s.block, blocks: s.blocks }))));
      void p.result.then((rs) => {
        if (!rs) return reply('compact: stopped');
        const done = compactDone(rs);
        const failed = rs.filter((r) => r.crafted <= 0);
        reply(done.length ? `${compactLine(done)}${failed.length ? `; ${failed.map((r) => `${r.item}: ${r.reason}`).join(', ')}` : ''}` : `compact: nothing compacted (${rs.map((r) => `${r.item}: ${r.reason}`).join(', ')})`);
      });
    },
  });
  log.info(`craft: !craft, !compact ready (${recipes.size} recipes known so far)`);
  return control;
}

export type { ProcessManager };
