// A starter farm (Track E6, docs/farming.md "A starter farm", ADR 0102), owner-only like every command:
//   !farm new [n]     choose a plot of n x n (odd, 3 to 9; default 9) round one water cell next to home (skills/farm/plot.ts),
//                     get a hoe when none is carried (the obtain job: `!get stone_hoe`, else a wooden one), break grass for
//                     seeds, fill the bucket and pour the water into the middle, till, plant, get the fences and a gate
//                     (the obtain job, the wood kind of the nearest logs) and set them round the plot; the `farm` waypoint
//                     marks the middle. Run again it goes on with what is not done (a trampled cell, a gap in the fence).
//   !farm status      also says what the farm chore would do now (the `farmFood` setting).
// The farm chore (`farmFood`, default off: it harvests and replants by itself) and bread: tasks/process/farm-new.ts.
// `!farm new` lives under `!farm` (commands-farm.ts hands the words after `new` here): the field it makes is the field
// `!farm` works, and `!farm stop` stops both.
import type { Vec3 } from '../connection/types.ts';
import { HOES } from '../skills/farm/farmer.ts';
import { cropOf, isMature } from '../skills/farm/crops.ts';
import { BASE_DEPTH, checkSite, FARM_NEW_MAX, FENCE_RE, FARM_NEW_MIN, FARM_NEW_SIZE, FARM_SITE_RANGE, findPlotSite, onRim, ownBase, siteWhyText, type PlotSite } from '../skills/farm/plot.ts';
import { breakForSeeds, fenceItems, FarmPlotJob, hoeCarried, SEED_TOPUP_RANGE, type PlotJobDeps, type PlotPhase } from '../skills/farm/setup.ts';
import { FARMLAND } from '../skills/farm/crops.ts';
import { inventoryFoodPoints } from '../skills/food/finder.ts';
import { isBuiltBlock } from '../skills/terrain/classify.ts';
import { settingsMover } from '../tasks/process/goto.ts';
import { BREAD_WHEAT, FarmChore, FarmNewProcess, SEED_TOPUP_MS } from '../tasks/process/farm-new.ts';
import type { WorldClock } from '../tasks/night.ts';
import type { ChatLine } from './text.ts';
import { farmerOf, setFarmNewHook } from './commands-farm.ts';
import { foodControllerOf, isChoreTime } from './commands-food.ts';
import { craftControlOf } from './commands-craft.ts';
import { obtainControlOf } from './commands-kit.ts';
import { waypointStoreOf } from './commands-nav.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';

/** The waypoint at the middle (the water cell) of the bot's own farm; its y is the soil's. */
export const FARM_WAYPOINT = 'farm';
/** The anchor is home while the bot is within this of it, else where the bot stands. */
const HOME_ANCHOR = 96;

/** `!farm new` words: the size (odd, FARM_NEW_MIN..FARM_NEW_MAX), or an error. */
export function parseFarmNew(args: readonly string[]): { n: number } | { error: string } {
  const usage = `usage: !farm new [n: odd, ${FARM_NEW_MIN} to ${FARM_NEW_MAX}; default ${FARM_NEW_SIZE}]`;
  if (args.length === 0) return { n: FARM_NEW_SIZE };
  if (args.length > 1) return { error: usage };
  const n = Number(args[0]);
  if (!Number.isInteger(n) || n < FARM_NEW_MIN || n > FARM_NEW_MAX || n % 2 === 0) return { error: usage };
  return { n };
}

/** Planks a fence of `fences` posts and one gate take: 3 posts a craft of 4 planks and 2 sticks, the gate 2 planks and 4 sticks. */
export function fencePlanks(fences: number): number {
  const crafts = Math.ceil(fences / 3);
  return crafts * 4 + Math.ceil((crafts * 2 + 4) / 4) * 2 + 2;
}

/** The commonest log kind of `names` (`birch_log` x 30, `oak_log` x 4 -> `birch_log`), or undefined. */
export function commonLog(names: readonly string[]): string | undefined {
  const m = new Map<string, number>();
  for (const n of names) if (n.endsWith('_log')) m.set(n, (m.get(n) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * The wood kind for a fence of `fences` posts: a kind whose planks and logs carried make the whole fence, else the
 * commonest logs round the plot (what the obtain job's wood trip will cut: measured, a trip for oak_fence in a birch
 * wood brought birch logs and the job stopped), else the kind carried most, else oak.
 */
export function fenceKind(slots: readonly ({ name: string; count: number } | null)[], nearLog: string | undefined, fences = 0): string {
  const ranked = woodCarried(slots);
  const enough = ranked.find(([, planks]) => planks >= fencePlanks(fences));
  if (enough) return enough[0];
  return /^(?:stripped_)?(.+)_log$/.exec(nearLog ?? '')?.[1] ?? ranked[0]?.[0] ?? 'oak';
}

/** The wood kinds carried as planks (a log is 4), most first: `[['birch', 48], ['oak', 22]]`. */
export function woodCarried(slots: readonly ({ name: string; count: number } | null)[]): [string, number][] {
  const m = new Map<string, number>();
  for (const s of slots) {
    if (!s || s.count <= 0) continue;
    const k = /^(.+)_planks$/.exec(s.name)?.[1] ?? /^(?:stripped_)?(.+)_log$/.exec(s.name)?.[1];
    if (k) m.set(k, (m.get(k) ?? 0) + s.count * (s.name.endsWith('_log') ? 4 : 1));
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/** The fence spec for the fence step: `kind`'s posts and gate first, then every other wood's posts and gates carried. */
export function woodKindsOfFences(slots: readonly ({ name: string; count: number } | null)[], kind: string): { fence: string; gate: string; more: string[] } {
  const own = fenceItems(kind);
  const more = [...new Set(slots.filter((s) => !!s && s.count > 0 && /_fence(_gate)?$|^fence_gate$/.test(s.name) && s.name !== own.fence && s.name !== own.gate && s.name !== 'nether_brick_fence').map((s) => s!.name))];
  return { ...own, more };
}

/**
 * A fence of mixed wood from what is carried, when no one kind makes it all (a mixed wood: a fresh world's trip brought
 * 12 birch and 5 oak logs for 35 posts, 16 logs of one kind): the gate from the kind carried most, then each kind's
 * posts as far as its own planks go (a craft of 3 posts takes 4 planks and 2 sticks, 5 planks in all; the gate 2 and
 * 4 sticks, 4 in all). Fences of different woods join. The posts and gates carried already count. The targets are
 * what is to be carried (the obtain job's sense).
 */
export function mixedFence(slots: readonly ({ name: string; count: number } | null)[], posts: number, gate: boolean): { item: string; n: number }[] {
  const have = (item: string): number => slots.reduce((a, s) => a + (s?.name === item ? s.count : 0), 0);
  const out: { item: string; n: number }[] = [];
  let left = posts - slots.reduce((a, s) => a + (s?.name.endsWith('_fence') ? s.count : 0), 0);
  let gateLeft = gate && !slots.some((s) => s?.name.endsWith('fence_gate') && s.count > 0);
  for (const [k, planks] of woodCarried(slots)) {
    let p = planks;
    if (gateLeft && p >= 4) {
      out.push({ item: fenceItems(k).gate, n: have(fenceItems(k).gate) + 1 });
      p -= 4;
      gateLeft = false;
    }
    const n = Math.min(left, 3 * Math.floor(p / 5));
    if (n > 0) {
      out.push({ item: fenceItems(k).fence, n: have(fenceItems(k).fence) + n });
      left -= n;
    }
    if (left <= 0 && !gateLeft) break;
  }
  return out;
}

/** Ripe crops and farmland cells of the plot round `water` (size n); undefined when a cell is not loaded. */
export function fieldCount(
  blockAt: (p: Vec3) => { name: string; states: Record<string, unknown> } | undefined,
  water: Vec3,
  n: number,
): { ripe: number; cells: number; crops: number; bare: number } | undefined {
  const h = (n - 1) / 2;
  let ripe = 0;
  let cells = 0;
  let crops = 0;
  let bare = 0;
  for (let dx = -h; dx <= h; dx++) {
    for (let dz = -h; dz <= h; dz++) {
      const g = blockAt({ x: water.x + dx, y: water.y, z: water.z + dz });
      if (!g || g.name === 'unknown') return undefined;
      if (g.name !== FARMLAND) continue;
      cells++;
      const top = blockAt({ x: water.x + dx, y: water.y + 1, z: water.z + dz });
      if (top && cropOf(top.name)) crops++;
      else if (top?.name === 'air') bare++; // Track E8: a cell the seed top-up plants
      if (isMature(top as never)) ripe++;
    }
  }
  return { ripe, cells, crops, bare };
}

/** The plot's size read off the field round its water cell: the farthest ring with farmland (default FARM_NEW_SIZE). */
export function plotSizeAt(blockAt: (p: Vec3) => { name: string } | undefined, water: Vec3): number {
  for (let h = (FARM_NEW_MAX - 1) / 2; h >= 1; h--) {
    for (let i = -h; i <= h; i++) {
      for (const [dx, dz] of [[i, -h], [i, h], [-h, i], [h, i]] as const) {
        if (blockAt({ x: water.x + dx, y: water.y, z: water.z + dz })?.name === FARMLAND) return 2 * h + 1;
      }
    }
  }
  return FARM_NEW_SIZE;
}

export interface FarmNewControl {
  chore: FarmChore;
  /** The running `!farm new`, if any. */
  busy(): boolean;
  last: string | undefined;
}

const controls = new WeakMap<object, FarmNewControl>();
export function farmNewControlOf(task: object): FarmNewControl | undefined {
  return controls.get(task);
}

/**
 * Register `!farm new` and the farm chore (tasks/registry.ts, after the farm, food, crafting, obtain and bed commands).
 * Without walking or the obtain job `!farm new` says what it needs.
 */
export function registerFarmNewCommands(d: CommandDeps, extra: { clock?: WorldClock } = {}): FarmNewControl | undefined {
  const { processes, skills, world, mobility, pve } = d;
  const farmer = farmerOf(d.chat);
  if (!processes || !skills || !world || !mobility || !pve || !farmer) {
    setFarmNewHook(d.chat, { run: (_l, _a, reply) => reply(`farm new ${d.needsWalking('farm new').replace(/^farm new /, '')}`) });
    return undefined;
  }
  const log = d.log;
  const mover = settingsMover(skills, d.settings);
  const blockAt = (p: Vec3) => world.blockAt(p);
  const pos = (): Vec3 | undefined => (mobility.loop.state.ready ? mobility.loop.state.pos : undefined);
  const cancel = (): void => {
    if (pve.mover.nav.busy) pve.mover.cancel();
    skills.cancel();
  };
  const store = (): ReturnType<typeof waypointStoreOf> => waypointStoreOf(d.task);
  const farmSite = (): { water: Vec3; n: number } | undefined => {
    const w = store()?.get(FARM_WAYPOINT);
    if (typeof w?.y !== 'number') return undefined;
    const water = { x: w.x, y: w.y, z: w.z };
    return { water, n: plotSizeAt(blockAt, water) };
  };
  const jobDeps: PlotJobDeps & { cancel(): void } = {
    // Track E8: water remembered by the world cache's map layer (read at call time: the cache opens after the join)
    world: { blockAt, find: (pred, o) => world.find(pred, o), inventory: world.inventory, surfaceAt: (x, z) => world.cache?.surfaceAt?.(x, z) },
    skills: { goto: (g, o) => mover.goto(g, o), dig: (p, o) => skills.dig(p, o), place: (p, o) => skills.place(p, o), collect: (r, t, o) => skills.collect(r, t, o) },
    click: (p, item) => farmer.clicker.useOn(p, item),
    farm: farmer.farm,
    position: pos,
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
    cancel,
  };
  const breadOf = async (cancelled: () => boolean): Promise<number> => {
    const craft = craftControlOf(d.task);
    const n = Math.floor(world.inventory.count('wheat') / BREAD_WHEAT);
    if (!craft || n <= 0) return 0;
    // out of the plot first: inside it every cell round the feet is a crop or a fence, no cell for a crafting table
    // (measured: `craft: no free cell next to the bot for a crafting table`, 24 wheat carried and no bread)
    const f = farmSite();
    const me = pos();
    if (f && me && Math.max(Math.abs(me.x - (f.water.x + 0.5)), Math.abs(me.z - (f.water.z + 0.5))) <= (f.n - 1) / 2 + 1.5) {
      const home = d.task.home?.get();
      const out = home && Math.hypot(home.x - f.water.x, home.z - f.water.z) <= 32 ? home : { x: f.water.x + (f.n - 1) / 2 + 3, y: f.water.y + 1, z: f.water.z };
      await mover.goto({ type: 'near', p: { x: out.x + 0.5, y: out.y, z: out.z + 0.5 }, r: 2 }, { timeoutTicks: 1200 });
      if (cancelled()) return 0;
    }
    const b0 = world.inventory.count('bread');
    const r = await craft.crafter.craft('bread', n, cancelled);
    const got = Math.max(0, world.inventory.count('bread') - b0);
    log.info(`farm chore: bread ${got} of ${n} (${r.reason})`);
    return got;
  };
  /** Drops in the middle water cell, picked up from the farmland cells beside it (the pickup box reaches 1.3 out). */
  const inWater = (w: Vec3): bigint[] =>
    [...world.entities.values()].filter((e) => !!e.item && Math.floor(e.pos.x) === w.x && Math.floor(e.pos.z) === w.z && e.pos.y >= w.y - 0.5 && e.pos.y <= w.y + 1.5).map((e) => e.runtimeId);
  const pickMiddle = async (w: Vec3, cancelled: () => boolean): Promise<number> => {
    const before = inWater(w).length;
    if (before === 0) return 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      if (inWater(w).length === 0 || cancelled()) break;
      await mover.goto({ type: 'near', p: { x: w.x + dx + 0.5, y: w.y + 1, z: w.z + dz + 0.5 }, r: 0.3 }, { timeoutTicks: 200 });
      if (cancelled()) break;
      await new Promise((r) => setTimeout(r, 600));
    }
    const left = inWater(w).length;
    log.info(`farm chore: ${before - left} of ${before} drops picked up out of the middle water`);
    return before - left;
  };
  const chore = processes.add(
    new FarmChore({
      processes,
      settings: d.settings,
      farm: farmSite,
      position: pos,
      isDay: () => isChoreTime(extra.clock?.time),
      foodPoints: () => inventoryFoodPoints(world.inventory.slots),
      field: (w, n) => fieldCount(blockAt, w, n),
      wheat: () => world.inventory.count('wheat'),
      // Track E8: the seed top-up, the plot job's grass pass over a wider ring (the set-up pass took what was near)
      seeds: () => world.inventory.count('wheat_seeds'),
      seedPass: async (w, _n, want, cancelled) => {
        const s0 = world.inventory.count('wheat_seeds');
        const t0 = performance.now();
        const stats = { grassBroken: 0 };
        await breakForSeeds(jobDeps, { centre: w, range: SEED_TOPUP_RANGE, want, until: () => performance.now() - t0 >= SEED_TOPUP_MS }, cancelled, stats);
        log.info(`farm chore: ${stats.grassBroken} grass broken for seeds in ${Math.round((performance.now() - t0) / 1000)} s`);
        return Math.max(0, world.inventory.count('wheat_seeds') - s0);
      },
      foodBusy: () => foodControllerOf(d.task)?.chore.running ?? false,
      farmer: farmer.farm,
      pickMiddle,
      bread: breadOf,
      cancel,
      afterJob: () => {
        if (d.task.home?.get()) void pve.returnHome('farm chore', { ifIdle: true, timeoutTicks: 6000 });
      },
      log,
    }),
  );
  // the food chore lets the farm feed the bot first (the hunt only when the farm has nothing to give)
  const food = foodControllerOf(d.task);
  if (food) food.chore.farmFirst = () => chore.canFeed();

  let running: Promise<void> | undefined;
  let proc: FarmNewProcess | undefined;
  /** `!farm stop` during this run: no second fence try. */
  let stopAsked = false;
  const control: FarmNewControl = { chore, busy: () => running !== undefined, last: undefined };

  /** Run the plot job's phases as a user process; the result line. */
  const runPhases = async (site: PlotSite, phases: PlotPhase[], fence?: FarmPlotJob['fence']): Promise<FarmPlotJob> => {
    const job = new FarmPlotJob(site, phases);
    if (fence) job.fence = fence;
    const p = new FarmNewProcess(jobDeps, job);
    proc = p;
    processes.add(p);
    await p.result;
    return job;
  };

  /** Why the site lies outside protectRadius (the start line), else empty. */
  let baseNote = '';
  /** The site: the farm set up before when it still passes, else the nearest one. */
  const chooseSite = (n: number): PlotSite | string => {
    const me = pos();
    if (!me) return 'not ready yet';
    const home = d.task.home?.get();
    const anchor = home && Math.hypot(home.x - me.x, home.z - me.z) <= HOME_ANCHOR ? home : me;
    const prior = farmSite();
    const radius = d.settings.get('protectRadius');
    let protect: { home: Vec3; radius: number } | undefined;
    let foreign = '';
    baseNote = '';
    if (home && radius > 0) {
      const built = world.find((b, p) => p.y >= home.y - BASE_DEPTH && isBuiltBlock(b.name), { origin: home, radius, max: 64 }).map((p) => ({ p, name: world.blockAt(p)?.name ?? '' }));
      const o = ownBase(built, (p) => !!prior && onRim(prior.water, prior.n, p), home.y);
      if (!o.own) {
        protect = { home, radius };
        const f0 = o.foreign[0]!;
        foreign = `${o.foreign.length}${o.foreign.length >= 64 ? '+' : ''} built block${o.foreign.length === 1 ? '' : 's'} within ${radius} of home, ${f0.name} at ${f0.p.x} ${f0.p.y} ${f0.p.z}`;
        baseNote = `; outside the base: ${foreign}`;
        log.info(`farm new: not the bot's own base: ${o.foreign.slice(0, 8).map((b) => `${b.name} ${b.p.x} ${b.p.y} ${b.p.z}`).join(', ')}`);
      }
    }
    const opts = { n, built: isBuiltBlock, ...(protect ? { protect, range: protect.radius + n + FARM_SITE_RANGE } : {}) };
    if (prior?.n === n) {
      const s = checkSite(blockAt, prior.water, n, opts, anchor);
      if (typeof s !== 'string') return s;
      log.info(`farm new: the farm at ${prior.water.x} ${prior.water.y} ${prior.water.z} no longer fits (${s}): a new site`);
    }
    const s = findPlotSite(blockAt, anchor, opts);
    if ('reason' in s) return `no ${n}x${n} site of flat grass or dirt within ${opts.range ?? FARM_SITE_RANGE} of ${anchor === home ? 'home' : 'here'}${protect ? `, outside the base (${foreign})` : ''} (${s.tried} tried: ${siteWhyText(s.why) || 'nothing loaded'}); try a smaller n`;
    return s;
  };

  const farmNew = async (line: ChatLine, n: number, reply: (m: string) => void): Promise<string> => {
    const t0 = performance.now();
    const took = (): string => `${Math.round((performance.now() - t0) / 1000)} s`;
    const site = chooseSite(n);
    if (typeof site === 'string') return `farm new: ${site}`;
    const w = site.water;
    reply(`farm new: a ${n}x${n} plot round ${w.x} ${w.y} ${w.z} (${Math.round(site.dist)} from ${d.task.home?.get() ? 'home' : 'here'}; ${site.farmland} of ${site.soil.length} tilled already, ${site.watered ? 'watered' : 'no water yet'}${baseNote})`);
    store()?.set(FARM_WAYPOINT, w, { auto: true });
    const kit = obtainControlOf(d.task);
    // the hoe
    const untilled = site.soil.filter((c) => blockAt(c)?.name !== FARMLAND).length;
    if (untilled > 0 && !hoeCarried((x) => world.inventory.count(x))) {
      if (!kit) return `farm new: no hoe carried and no way to get one (the obtain job is off)`;
      for (const hoe of ['stone_hoe', 'wooden_hoe']) {
        const targets = [{ item: hoe, n: 1 }];
        if (kit.check(targets).kind === 'stuck') continue;
        const job = kit.start(line, hoe, targets, reply);
        if (job) await job.result;
        break;
      }
      if (!hoeCarried((x) => world.inventory.count(x))) return `farm new: stopped after ${took()}: no hoe (${HOES.slice(-2).join(' or ')}: ${kit.check([{ item: 'wooden_hoe', n: 1 }]).kind === 'stuck' ? 'not craftable' : 'the job got none'})`;
    }
    // seeds, water, clear, till, plant
    const job = await runPhases(site, ['seeds', 'water', 'clear', 'till', 'plant']);
    const s = job.stats;
    const farmlandNow = (): number => site.soil.filter((c) => blockAt(c)?.name === FARMLAND).length;
    const head = (): string => `${farmlandNow()} of ${site.soil.length} tilled, ${s.planted} planted (${s.seedsGot} seeds from ${s.grassBroken} grass), water ${s.water ?? 'not done'}${s.waterWhy && s.water !== 'already' ? ` (${s.waterWhy})` : ''}`;
    if (job.phase !== 'done') return `farm new: stopped after ${took()} in the ${job.phase} step; ${head()}`;
    if (job.stop) return `farm new: stopped after ${took()}: ${job.stop}; ${head()}`;
    // the fence: what the free rim cells need, crafted by the obtain job (its wood trip), then placed
    const gate = site.gate;
    // an open gate has no collision box (the walk home through it leaves it open): a fence or a gate is never free
    const open = (c: Vec3): boolean => {
      const b = blockAt(c);
      return !!b && !FENCE_RE.test(b.name) && b.boxes.length === 0;
    };
    const free = site.rim.filter((c) => !(c.x === gate.x && c.z === gate.z) && open(c)).length;
    const gateFree = open(gate);
    let fenceLine = 'no fence needed';
    if (free > 0 || gateFree) {
      const nearLog = commonLog(world.find((b) => b.name.endsWith('_log'), { origin: w, radius: 32, max: 48 }).map((p) => world.blockAt(p)?.name ?? ''));
      let kind = fenceKind(world.inventory.slots, nearLog, free);
      let items = fenceItems(kind);
      const wantOf = (): { item: string; n: number }[] => [...(free > 0 ? [{ item: items.fence, n: free }] : []), ...(gateFree ? [{ item: items.gate, n: 1 }] : [])];
      const fencesCarried = (): number => world.inventory.slots.reduce((a, x) => a + (x?.name.endsWith('_fence') ? x.count : 0), 0);
      const gateCarried = (): boolean => world.inventory.slots.some((x) => !!x?.name.endsWith('fence_gate') && x.count > 0);
      const missing = (): boolean => fencesCarried() < free || (gateFree && !gateCarried());
      let short = '';
      // two tries: the job's wood trip takes the trees it finds, so with no logs round the plot the first kind (oak)
      // can be the wrong one (a fresh world's mixed wood: `!gather 8 got nothing (gather done: 17/8 logs)` with 12
      // birch and 5 oak logs carried); the second try uses the wood the trip brought back, one kind when it makes the
      // whole fence, else mixed (mixedFence)
      for (let attempt = 0; attempt < 2 && missing(); attempt++) {
        if (!kit) {
          short = 'the obtain job is off';
          break;
        }
        let want = wantOf();
        if (attempt > 0) {
          if (stopAsked) break;
          const again = fenceKind(world.inventory.slots, nearLog, free);
          const whole = woodCarried(world.inventory.slots).some(([k, p]) => k === again && p >= fencePlanks(free));
          if (whole && again !== kind) {
            kind = again;
            items = fenceItems(kind);
            want = wantOf();
          } else want = mixedFence(world.inventory.slots, free, gateFree);
          if (want.length === 0) break;
          log.info(`farm new: the fence again from the wood carried: ${want.map((t) => `${t.n} ${t.item}`).join(', ')}`);
        }
        const first = kit.check(want);
        if (first.kind === 'stuck') {
          short = first.reason;
          continue;
        }
        const ob = kit.start(line, attempt > 0 ? 'fence' : `${kind} fence`, want, reply);
        if (ob) short = (await ob.result).replace(/^get [^:]*: /, '');
      }
      const kinds = woodKindsOfFences(world.inventory.slots, kind);
      if (fencesCarried() > 0 || gateCarried()) {
        const f = await runPhases(site, ['fence'], kinds);
        fenceLine = `${f.stats.fenced} of ${free} fences${f.stats.gate ? ' and the gate' : gateFree ? ', no gate' : ''}${f.stats.fenceFailed ? ` (${f.stats.fenceFailed} failed)` : ''}${f.phase !== 'done' ? ` (stopped in the fence step)` : ''}`;
      } else fenceLine = `no fence (${short || `no ${items.fence} got`})`;
    }
    return `farm new: done in ${took()}: ${head()}; ${fenceLine}; !farm harvests it${d.settings.get('farmFood') ? ', the farm chore keeps it' : ' (farmFood off: no farm chore)'}`;
  };

  setFarmNewHook(d.chat, {
    run: (line, args, reply) => {
      const p = parseFarmNew(args);
      if ('error' in p) return reply(p.error);
      if (running) return reply(`farm new: already running (${proc && !proc.done ? proc.status().line : 'getting things'}); !farm stop`);
      chore.drop();
      stopAsked = false;
      const r = farmNew(line, p.n, reply).then(
        (end) => {
          control.last = end;
          log.info(end);
          reply(end);
          // the plot may lie a walk from home (outside the base): back home when nothing else is queued
          if (d.task.home?.get()) void pve.returnHome('farm new', { ifIdle: true, timeoutTicks: 6000 });
        },
        (e: unknown) => reply(`farm new: failed (${e instanceof Error ? e.message : String(e)})`),
      );
      running = r.finally(() => {
        running = undefined;
      });
    },
    stop: () => {
      let did = false;
      if (running) stopAsked = true;
      if (proc && !proc.done) {
        processes.stop(proc, 'stopped');
        did = true;
      }
      if (running) {
        obtainControlOf(d.task)?.stop('stopped');
        did = true;
      }
      return did ? 'farm new stopped' : undefined;
    },
    status: () => {
      const parts: string[] = [];
      if (proc && !proc.done) parts.push(proc.status().line);
      const f = farmSite();
      if (f) parts.push(`farm at ${f.water.x} ${f.water.y} ${f.water.z} (${f.n}x${f.n})`);
      parts.push(`farm chore: ${chore.running ? chore.behaviour() : chore.why()}${chore.stats.started ? ` (${chore.stats.started} runs, ${chore.stats.harvested} harvested, ${chore.stats.bread} bread)` : ''}`);
      return parts.join('; ');
    },
  });
  controls.set(d.task, control);
  return control;
}
