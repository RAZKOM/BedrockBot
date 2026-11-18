// e2e measure (tag @bds), Track E6 (docs/early-game.md "Food over days"): the bot left alone for game days on a
// freshly generated default world, one process a day. Skipped unless FRESH_DAYS=1 (it needs a fresh world, not the
// flat test servers). The world is reset outside this file (a fresh copy of one seed, the truth pack on).
//
//   FRESH_PHASE=setup   difficulty normal, the daylight cycle, mobs and weather on, the clock at 0; the iron kit given
//                       (the state `!get kit iron` ends in), `!home set` where the bot stands, `!bed`; with FRESH_FARM=on
//                       also `!farm new` and `farmFood` on
//   FRESH_PHASE=day     one game day: from the morning to the next morning (the night slept through or not), at most
//                       FRESH_MAX_MIN minutes; samples every 5 s to FRESH_OUT (JSONL), a summary line at the end
//   FRESH_PHASE=probe   connect, print the inventory and the position, disconnect (does the server keep them)
//
// The demand: Hunger (FRESH_HUNGER amplifier, default 2) on the bot the whole time, renewed every 60 s (a death and
// milk clear it): a bot standing at home uses almost no food, so without it the days only measure standing still.
// Env: FRESH_NAME (the bot's fixed name, the server keeps its inventory by it), FRESH_CFG (a config path in .work: the
// waypoints, home included, survive the processes), FRESH_CACHE (a world cache root: herd marks), FRESH_FARM,
// FRESH_SET (settings `k=v,k=v`), FRESH_WATER=1 (the kit's bucket full), CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER (the server), CRAFT_VERBOSE=1.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import bedrock from 'bedrock-protocol';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Chat, parseOwners } from '../../src/chat/chat.ts';
import { registerBuiltinCommands } from '../../src/chat/commands.ts';
import { craftControlOf } from '../../src/chat/commands-craft.ts';
import { foodControllerOf } from '../../src/chat/commands-food.ts';
import { FARM_WAYPOINT, farmNewControlOf, fieldCount, plotSizeAt } from '../../src/chat/commands-farm-new.ts';
import { waypointStoreOf } from '../../src/chat/commands-nav.ts';
import { RuntimeSettings, SETTINGS_VALUE_KEY } from '../../src/config/settings.ts';
import { Connection } from '../../src/connection/connection.ts';
import { Metrics } from '../../src/connection/metrics.ts';
import type { Vec3 } from '../../src/connection/types.ts';
import { createLogger, silentLogger } from '../../src/log.ts';
import { foodItemCount, inventoryFoodPoints } from '../../src/skills/food/finder.ts';
import { buildTaskContext, type BuiltContext } from '../../src/tasks/context.ts';
import { NightProcess } from '../../src/tasks/process/night.ts';
import { afkTask, type WalkingTask } from '../../src/tasks/registry.ts';
import { openWorldCache, type WorldCache } from '../../src/world/cache/index.ts';
import { CRAFT_CONTAINER, CRAFT_TARGET, CraftTruth, E2E, craftCmd, sleep, until } from './craft-truth.ts';
import { E2E_VERSION } from './env.ts';

const RUN = process.env.FRESH_DAYS === '1';
const PHASE = process.env.FRESH_PHASE ?? 'day';
const NAME = process.env.FRESH_NAME ?? 'E6Fresh';
const OUT = process.env.FRESH_OUT ?? '';
const MAX_MIN = Number(process.env.FRESH_MAX_MIN ?? 14);
const HUNGER = Number(process.env.FRESH_HUNGER ?? 2);
const FARM = process.env.FRESH_FARM === 'on';
const VERBOSE = process.env.CRAFT_VERBOSE === '1';

/** The iron kit as `!get kit iron` leaves it on top of the stone kit (worn armour put on by the armour pass). */
const IRON_KIT_STATE: readonly (readonly [string, number])[] = [
  ['iron_pickaxe', 1],
  ['iron_sword', 1],
  ['shield', 1],
  ['bucket', 1],
  ['iron_helmet', 1],
  ['iron_chestplate', 1],
  ['iron_leggings', 1],
  ['iron_boots', 1],
  ['bed', 1],
  ['stone_sword', 1],
  ['stone_pickaxe', 1],
  ['stone_axe', 1],
  ['crafting_table', 1],
  ['cobblestone', 16],
  ['cooked_beef', 6],
];

function out(rec: Record<string, unknown>): void {
  const line = JSON.stringify({ at: new Date().toISOString(), ...rec });
  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    appendFileSync(OUT, `${line}\n`);
  }
  console.log(line);
}

interface FreshBot {
  conn: Connection;
  chat: Chat;
  task: WalkingTask;
  settings: RuntimeSettings;
  truth: CraftTruth;
  cache: WorldCache | undefined;
  mob: NonNullable<BuiltContext['mobility']>;
  said: string[];
  logs: string[];
  command(text: string): Promise<void>;
  reply(match: (s: string) => boolean, from: number, timeoutMs?: number): Promise<string>;
  stop(): Promise<void>;
}

async function startFresh(): Promise<FreshBot> {
  const log = VERBOSE ? createLogger('info', NAME) : silentLogger;
  const logs: string[] = [];
  const capture = (scope: string) => {
    const base = VERBOSE ? createLogger('info', scope) : silentLogger;
    const keep = (lvl: string) => (m: string) => {
      logs.push(`${new Date().toISOString().slice(11, 19)} ${scope} ${lvl} ${m}`);
    };
    return { ...base, debug: (m: string) => base.debug(m), info: (m: string) => (keep('info')(m), base.info(m)), warn: (m: string) => (keep('warn')(m), base.warn(m)), error: (m: string) => (keep('error')(m), base.error(m)) };
  };
  // the same client ids every connection: the server keeps the player (inventory, position, spawn point) by them
  const id = createHash('sha1').update(NAME).digest('hex');
  const uuid = `${id.slice(0, 8)}-${id.slice(8, 12)}-4${id.slice(13, 16)}-8${id.slice(17, 20)}-${id.slice(20, 32)}`;
  const createClient = (opts: Record<string, unknown>) => bedrock.createClient({ ...opts, skinData: { SelfSignedId: uuid, DeviceId: uuid, PlayFabId: id.slice(0, 16) } } as Parameters<typeof bedrock.createClient>[0]);
  const conn = new Connection({ version: E2E_VERSION, username: NAME, logger: log, reconnect: false, createClient: createClient as never });
  const metrics = new Metrics();
  metrics.attach(conn);
  const chat = new Chat(conn, { log, owners: parseOwners([]), maxReplies: 50 });
  const settings = new RuntimeSettings();
  const ref: { task?: WalkingTask } = {};
  const values: Record<string, unknown> = { [SETTINGS_VALUE_KEY]: settings };
  if (process.env.FRESH_CFG) values.config = process.env.FRESH_CFG;
  else values['no-config'] = true;
  const built = buildTaskContext({
    name: 'afk',
    conn,
    metrics,
    chat,
    version: E2E_VERSION,
    options: { nudgeIntervalS: 240, heartbeat: false, home: undefined, shelter: undefined, walk: true, respawnDelayMs: 1000 },
    values,
    logger: (scope) => capture(`${scope}`),
    position: () => ref.task?.position(),
  });
  const t = afkTask.create(built.ctx) as WalkingTask;
  ref.task = t;
  registerBuiltinCommands(chat, { conn, metrics, position: () => t.position(), extraStatus: () => t.statusLine?.() ?? { task: 'afk' }, extraLines: () => t.processLines?.() ?? [], quit: () => undefined });
  const cache = process.env.FRESH_CACHE && built.mobility ? openWorldCache(built.mobility.world, { root: process.env.FRESH_CACHE, server: `127.0.0.1:${CRAFT_TARGET.kind === 'bds' ? CRAFT_TARGET.port : 0}` }) : undefined;
  const truth = new CraftTruth(conn, CRAFT_CONTAINER);
  const said: string[] = [];
  conn.on('text', (p) => {
    if ((p.source_name ?? '').startsWith(NAME)) said.push(p.message);
    else if (process.env.FRESH_TEXT === '1') console.log(`text ${JSON.stringify(p).slice(0, 300)}`);
  });
  for (const kv of (process.env.FRESH_SET ?? '').split(',').filter(Boolean)) {
    const [k, v] = kv.split('=');
    (settings.set as (k: string, v: string) => void).call(settings, k!, v!);
  }
  if (process.env.FRESH_TEXT === '1') {
    chat.onLine((l) => console.log(`line ${JSON.stringify(l)}`));
    chat.onCommand((e) => console.log(`command ${e.kind} ${e.name}`));
  }
  await t.start();
  chat.start();
  await conn.connect(CRAFT_TARGET);
  const mob = built.mobility!;
  await mob.world.waitForChunks(4, { timeoutMs: 60_000 });
  await mob.loop.waitTicks(20);
  const craft = craftControlOf(t);
  await until(() => ((craft?.recipes.size ?? 0) > 0 ? true : undefined), 30_000, 'the crafting_data packet');
  return {
    conn,
    chat,
    task: t,
    settings,
    truth,
    cache,
    mob,
    said,
    logs,
    command: (text) => craftCmd('tell', NAME, ...text.split(' ')),
    reply: (match, from, timeoutMs = 10_000) => until(() => said.slice(from).find(match), timeoutMs, `reply after line ${from} (said: ${said.slice(from).join(' | ')})`, 50),
    stop: async () => {
      t.stop();
      built.stop();
      cache?.close();
      chat.stop();
      await conn.disconnectAndFlush('day done');
    },
  };
}

function nightOf(b: FreshBot): NightProcess | undefined {
  return b.task.processes?.find('night').find((x): x is NightProcess => x instanceof NightProcess);
}

/** As `!home set` where the bot stands (the CLI's hardening commands are not registered here); the waypoint file keeps it. */
function setHome(b: FreshBot): void {
  const p = b.mob.loop.state.pos;
  b.task.home!.set({ x: Math.floor(p.x), y: Math.floor(p.y + 1e-6), z: Math.floor(p.z) });
}

const r1 = (n: number): number => Math.round(n * 10) / 10;

describe.skipIf(!E2E || !RUN)('@bds fresh days: the bot left alone on a fresh world (Track E6)', () => {
  it(`phase ${PHASE}`, async () => {
    const b = await startFresh();
    const mob = b.mob;
    const world = mob.world;
    const inv = world.inventory;
    const feet = (): Vec3 => mob.loop.state.pos;
    try {
      if (PHASE === 'probe') {
        out({ phase: 'probe', pos: feet(), inv: inv.slots.filter(Boolean).map((s) => `${s!.count} ${s!.name}`), home: b.task.home?.get() });
        if (process.env.FRESH_PROBE_GIVE === '1') {
          await b.truth.kit(NAME, [['dirt', 3]]);
          setHome(b);
          await sleep(2000);
        }
        return;
      }
      if (PHASE === 'setup') {
        b.settings.set('autoFood', 'off'); // the kit first: the chore would hunt with nothing carried
        for (const c of [
          ['difficulty', 'normal'],
          ['gamerule', 'dodaylightcycle', 'true'],
          ['gamerule', 'domobspawning', 'true'],
          ['gamerule', 'doweathercycle', 'true'],
          ['gamerule', 'keepinventory', 'false'],
          ['time', 'set', '0'],
        ])
          await craftCmd(...c);
        // FRESH_WATER=1: the kit's bucket full (filled on an earlier trip): a watered plot where no water is near
        await b.truth.kit(NAME, process.env.FRESH_WATER === '1' ? IRON_KIT_STATE.map(([n, c]) => [n === 'bucket' ? 'water_bucket' : n, c] as const) : IRON_KIT_STATE);
        await sleep(3000);
        setHome(b);
        const f2 = b.said.length;
        await b.command('!bed');
        const bed = await b.reply((s) => s.startsWith('bed placed') || s.startsWith('bed: ') && !s.startsWith('bed: placing'), f2, 60_000);
        out({ phase: 'setup', home: b.task.home?.get(), bed, pos: feet(), inv: inv.slots.filter(Boolean).map((s) => `${s!.count} ${s!.name}`) });
        if (process.env.FRESH_ASK === '1') {
          // what the farm and food commands say with no farm (each answered before the next)
          for (const c of ['!farm status', '!food status', '!get bread', '!get wheat', '!farm']) {
            const f = b.said.length;
            await b.command(c);
            await sleep(c === '!farm' || c.startsWith('!get') ? 20_000 : 3000);
            out({ ask: c, said: b.said.slice(f) });
            await b.command('!stop');
            await sleep(2000);
          }
        }
        if (FARM) {
          const f3 = b.said.length;
          const t0 = Date.now();
          await b.command('!farm new');
          const end = await b.reply((s) => /^farm new: (done|stopped|no |failed|already)/.test(s), f3, MAX_MIN * 60_000);
          out({ phase: 'farm', s: r1((Date.now() - t0) / 1000), end, said: b.said.slice(f3), inv: inv.slots.filter(Boolean).map((s) => `${s!.count} ${s!.name}`) });
        }
        return;
      }
      // a day: from now to the next morning
      const night = nightOf(b);
      const home = b.task.home?.get();
      const food = foodControllerOf(b.task);
      const t0 = Date.now();
      let sawNight = false;
      let deaths = 0;
      let wasDead = false;
      let lowHp = 20;
      let lowFood = 20;
      let starveS = 0;
      let lastEffect = 0;
      let lastSample = 0;
      let lastFarm = 0;
      // the farm (Track E6): its cells and ripe crops when loaded, the farm chore's counters and why it waits
      const farmOf = (): Record<string, unknown> | undefined => {
        const w = waypointStoreOf(b.task)?.get(FARM_WAYPOINT);
        if (typeof w?.y !== 'number') return undefined;
        const water = { x: w.x, y: w.y, z: w.z };
        const blockAt = (p: Vec3) => world.blockAt(p);
        const n = plotSizeAt(blockAt, water);
        const fc = farmNewControlOf(b.task)?.chore;
        // the wheat's growth stages (0 to 7, 7 ripe), how many crops at each: how far a dry plot has grown
        const stages = [0, 0, 0, 0, 0, 0, 0, 0];
        const h = (n - 1) / 2;
        for (let dx = -h; dx <= h; dx++) {
          for (let dz = -h; dz <= h; dz++) {
            const c = world.blockAt({ x: water.x + dx, y: water.y + 1, z: water.z + dz });
            const g = c?.name === 'wheat' ? Number(c.states.growth ?? -1) : -1;
            if (g >= 0 && g <= 7) stages[g]!++;
          }
        }
        const moist = world.blockAt(water)?.name.includes('water') ?? false;
        return { n, field: fieldCount(blockAt, water, n) ?? 'unloaded', stages, moist, dist: r1(Math.hypot(feet().x - water.x, feet().z - water.z)), chore: fc ? { ...fc.stats } : undefined, why: fc?.why() };
      };
      const start = { points: inventoryFoodPoints(inv.slots), items: foodItemCount(inv.slots), tod: night?.timeOfDay(), farm: farmOf() };
      const lines0 = b.logs.length;
      while (Date.now() - t0 < MAX_MIN * 60_000) {
        const now = Date.now();
        if (now - lastEffect >= 60_000) {
          lastEffect = now;
          if (HUNGER >= 0) await craftCmd('effect', NAME, 'hunger', '90', String(HUNGER), 'true').catch(() => undefined);
        }
        const hp = world.self.health;
        const dead = hp <= 0;
        if (dead && !wasDead) {
          deaths++;
          out({ event: 'death', s: r1((now - t0) / 1000), tod: night?.timeOfDay(), pos: feet(), last: b.logs.slice(-6) });
        }
        wasDead = dead;
        if (!dead) {
          lowHp = Math.min(lowHp, hp);
          lowFood = Math.min(lowFood, world.self.food ?? 20);
          if ((world.self.food ?? 20) <= 0) starveS += 1;
        }
        const tod = night?.timeOfDay();
        if (tod !== undefined && tod >= 12000) sawNight = true;
        if (now - lastSample >= 5000) {
          lastSample = now;
          const top = b.task.processes?.active;
          out({
            s: r1((now - t0) / 1000),
            tod,
            hp: r1(hp),
            hunger: world.self.food,
            points: inventoryFoodPoints(inv.slots),
            items: foodItemCount(inv.slots),
            wheat: inv.count('wheat'),
            seeds: inv.count('wheat_seeds'),
            bread: inv.count('bread'),
            home: home ? r1(Math.hypot(feet().x - home.x, feet().z - home.z)) : null,
            top: top ? top.status().line : null,
            chore: food?.chore.stats,
            ...(now - lastFarm >= 60_000 ? ((lastFarm = now), { farm: farmOf() }) : {}),
          });
        }
        if (sawNight && tod !== undefined && tod < 6000) break;
        await sleep(1000);
      }
      const chore = food?.chore;
      out({
        summary: true,
        minutes: r1((Date.now() - t0) / 60_000),
        morning: sawNight,
        deaths,
        lowHp: r1(lowHp),
        lowHunger: lowFood,
        starveS,
        start,
        end: { points: inventoryFoodPoints(inv.slots), items: foodItemCount(inv.slots), wheat: inv.count('wheat'), seeds: inv.count('wheat_seeds'), bread: inv.count('bread'), farm: farmOf() },
        chore: chore?.stats,
        last: chore?.last,
        foodLines: b.logs.slice(lines0).filter((l) => / food | farm|bread|hunt/.test(l)).slice(-60),
      });
      expect(true).toBe(true);
    } finally {
      if (OUT) appendFileSync(OUT.replace(/\.jsonl$/, '.log'), `${b.logs.join('\n')}\n--- said\n${b.said.join('\n')}\n`);
      await b.stop();
    }
  }, (MAX_MIN + 5) * 60_000);
});
