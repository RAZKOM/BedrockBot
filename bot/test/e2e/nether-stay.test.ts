// e2e (tag @bds), Track N2 (docs/survival.md "The Nether for experience (Track N2)"): the Nether's hazards against the
// bot's own rules, measured before a quartz trip is built (NETHER_PROBE=stay). Mob spawning ON for the run (set back off
// at its end), difficulty normal, the clock frozen at noon (the overworld side), fall and fire damage as the server has
// them (on), keepInventory on (a death is counted, the kit is not lost). For each site (STAY_SITES of them from
// STAY_FIRST; site k's overworld area is STAY_AREA + k x 2400 east, so its Nether side is 300 blocks from the next): a
// stone platform at y 150 with a lit portal (truth:portal), the kit, `!nether` (the server links or builds the Nether
// portal: a real arrival), a census of the arrival (floor blocks, lava, quartz), then STAY_SECONDS (default 300) of
// `!mine quartz_ore 5` typed again 2 s after each end (5 s after one ended at low health), as an owner would, and
// `!overworld` back. Per site: deaths and their causes, the damage by cause and by the damaging mob (truth:hurtlog, the
// server's record), the lowest health, the points gained (the experience bar: no Mending piece carried), the quartz
// mined, the time, how far the bot strayed from the portal, the mobs seen, the ones that targeted the bot, the guard
// fights, the flights, the fire escapes, the way back. One JSON line per site to STAY_OUT.
// Env: NETHER_BDS_* (nether-truth.ts; bds-pve: NETHER_BDS_PORT=19144 NETHER_BDS_CONTAINER=bds-pve), STAY_KIT live|iron,
// STAY_AREA "x,z" (pin it for a before / after on the same sites), STAY_SITES (2), STAY_FIRST (0), STAY_SECONDS (300),
// STAY_SET key=value,... (runtime settings), STAY_LABEL, STAY_OUT, STAY_BUDGET_S (no site starts after this many seconds of
// the run: 420), STAY_TRACE=1 (a line every 5 s), STAY_SUMMON / STAY_SUMMON_AT (the summoned cells, below).
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { waypointStoreOf } from '../../src/chat/commands-nav.ts';
import { fireProcessOf } from '../../src/chat/commands-portal.ts';
import type { Vec3 } from '../../src/connection/types.ts';
import { bareType, classify } from '../../src/skills/combat/hostiles.ts';
import type { MineProcess } from '../../src/tasks/process/mine.ts';
import type { HurtRecord } from './pve-truth.ts';
import { dimTeleport, E2E, netherCmd, privateArea, sleep, startNetherBot, truthRetry, until, type NetherBot } from './nether-truth.ts';

const PROBE = (process.env.NETHER_PROBE ?? '').split(',').includes('stay');
const KIT = process.env.STAY_KIT ?? 'live';
const SITES = Number(process.env.STAY_SITES ?? 2);
const FIRST = Number(process.env.STAY_FIRST ?? 0);
const STAY_MS = Number(process.env.STAY_SECONDS ?? 300) * 1000;
const BUDGET_MS = Number(process.env.STAY_BUDGET_S ?? 420) * 1000;
const MINE_N = Number(process.env.STAY_MINE ?? 5);
const LABEL = process.env.STAY_LABEL ?? 'before';
const OUT = process.env.STAY_OUT;
const TRACE = process.env.STAY_TRACE === '1';
const SETTINGS = (process.env.STAY_SET ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const SPACING = 2400;
/**
 * The summoned cells (STAY_SUMMON=ghast,piglin:3,...): natural spawning gave few mobs near a site, so the Nether's own mobs
 * are also summoned (by the console, `execute as <bot> at @s run summon`, named so they are removed at the stay's end; a named mob never despawns, and after a death the kill cannot reach it) STAY_SUMMON_AT
 * seconds into the stay: walkers on standable cells 10 to 14 blocks from the bot, a ghast in open air 16 to 24 off and 3 to 10
 * up (a blaze 8 to 12 off, 2 to 5 up). Several cells, one a site in turn: `ghast;piglin:3;hoglin:2` (site i gets cell i mod n).
 */
type SummonSpec = { type: string; n: number }[];
const CELLS: SummonSpec[] = (process.env.STAY_SUMMON ?? '').split(';').map((cell) =>
  cell
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [type, n] = s.split(':');
      return { type: type!, n: Math.max(1, Number(n ?? 1) || 1) };
    }),
);
const SUMMON_AT_MS = Number(process.env.STAY_SUMMON_AT ?? 20) * 1000;
/** STAY_GOLD=1: a golden helmet instead of the kit's (piglins leave a player who wears a golden piece alone). */
const GOLD = process.env.STAY_GOLD === '1';

/** Experience points to go from level `l` to `l + 1`. */
const xpToNext = (l: number): number => (l <= 15 ? 2 * l + 7 : l <= 30 ? 5 * l - 38 : 9 * l - 158);
const xpTotal = (l: number, progress: number): number => {
  let t = 0;
  for (let i = 0; i < l; i++) t += xpToNext(i);
  return t + progress * xpToNext(l);
};
const r1 = (v: number): number => Math.round(v * 10) / 10;
const NOT_MOB = /player|item|xp_orb|arrow|fireball|small_fireball|wither_skull|fireworks/;

/** A site's row. */
interface SiteRow {
  label: string;
  kit: string;
  site: number;
  overworld: { x: number; z: number };
  arrival?: Vec3;
  /** The portal trip's end line and its seconds. */
  there: string;
  thereS: number;
  /** The arrival: floor-block counts in 25 x 9 x 25 round it, the biome guess, lava cells within 16 and the nearest, quartz ores with a face open to air within 32, the portal on a generated platform. */
  census?: { floor: Record<string, number>; biome: string; lava16: number; lavaNearest: number | null; quartzOpen: number; platform: boolean };
  stayS: number;
  deaths: number;
  deathCauses: string[];
  /** Damage the server recorded, by cause and by the damaging entity's type. */
  damage: number;
  byCause: Record<string, number>;
  byDamager: Record<string, number>;
  minHealth: number;
  points: number;
  quartz: number;
  mineCmds: number;
  mineEnds: string[];
  maxFromPortal: number;
  endFromPortal: number | null;
  /** Mobs seen within 32 (distinct, by type), the nearest each came, those that targeted the bot. */
  mobs: Record<string, { n: number; nearest: number }>;
  targeted: Record<string, number>;
  fights: number;
  kills: number;
  flees: number;
  fireEscapes: number;
  /** `!overworld` at the end: its end line, seconds, the damage on the way. */
  back: string;
  backS: number;
  backDamage: number;
  /** truth:hurtlog pulls that failed (a row with any is not a clean count). */
  pullFails: number;
  /** The bot's own record of its health drops (the mob tracker's hit guess): drops and damage by the guessed type or cause. */
  ownHits: number;
  ownByGuess: Record<string, number>;
  /** The fire watch: times the body caught fire, health drops while burning. */
  burns: number;
  fireHurts: number;
  /** The summoned cell (`ghast:1`, `piglin:3`, `natural`) and the mobs: type and where, relative to the bot then; `none` when no cell was found. */
  cell: string;
  summoned?: string[];
  trace?: string[];
  lines?: string[];
}

describe.skipIf(!E2E || !PROBE)('@bds nether: the hazards of a quartz stay near a portal (Track N2, a measurement)', () => {
  let bot: NetherBot | undefined;
  const rows: SiteRow[] = [];
  const t0Run = Date.now();
  const base = ((): { x: number; z: number } => {
    const p = process.env.STAY_AREA?.split(',').map(Number);
    if (p?.length === 2 && p.every(Number.isFinite)) return { x: p[0]!, z: p[1]! };
    const a = privateArea();
    return { x: a.x, z: a.z };
  })();

  beforeAll(async () => {
    for (const c of [
      ['difficulty', 'normal'],
      ['gamerule', 'dodaylightcycle', 'false'],
      ['gamerule', 'doweathercycle', 'false'],
      ['gamerule', 'keepinventory', 'true'],
      ['gamerule', 'doimmediaterespawn', 'false'],
      ['gamerule', 'domobspawning', 'true'],
      ['time', 'set', 'noon'],
      ['weather', 'clear'],
    ]) {
      await netherCmd(...c);
    }
    bot = await startNetherBot('Stay', {}, { guard: '16' });
    for (const kv of SETTINGS) {
      const [k, v] = kv.split('=');
      if (k && v !== undefined) bot.settings.set(k as never, v);
    }
  }, 240_000);

  afterAll(async () => {
    await netherCmd('gamerule', 'domobspawning', 'false').catch(() => undefined);
    await netherCmd('time', 'set', '18000').catch(() => undefined);
    for (const r of rows) console.log(`[nether-stay] ${JSON.stringify(r)}`);
    if (bot) {
      await dimTeleport(bot, 'overworld', { x: 0.5, y: 100, z: 0.5 }).catch(() => undefined);
      await bot.stop();
    }
  }, 120_000);

  async function setKit(b: NetherBot): Promise<void> {
    const t = b.truth;
    await t.ok('clear', [b.name]);
    await t.ok('unequip', [b.name]);
    await netherCmd('replaceitem', 'entity', b.name, 'slot.weapon.offhand', '0', 'air');
    const metal = KIT === 'iron' ? 'iron' : 'netherite';
    await t.ok('give', [b.name, `${metal}_sword`, 1]);
    await t.ok('give', [b.name, `${metal}_pickaxe`, 1]);
    for (const piece of ['helmet', 'chestplate', 'leggings', 'boots']) await t.ok('give', [b.name, piece === 'helmet' && GOLD ? 'golden_helmet' : `${metal}_${piece}`, 1]);
    await t.ok('give', [b.name, KIT === 'iron' ? 'bread' : 'cooked_beef', 16]);
    await t.ok('give', [b.name, 'cobblestone', 32]);
    await t.ok('give', [b.name, 'shield', 1]);
    await until(
      async () => {
        const eq = (await t.ok<{ equipment: Record<string, { typeId: string } | undefined> }>('durability', [b.name])).equipment;
        const st = await t.ok<{ offhand: { typeId: string } | null }>('stance', [b.name]);
        return eq.Head && eq.Chest && eq.Legs && eq.Feet && st.offhand?.typeId === 'minecraft:shield' ? true : undefined;
      },
      30_000,
      'the armour worn and the shield in the offhand',
      500,
    );
    await t.setHealth(b.name, 20);
    await t.ok('setfood', [b.name, 20, 5]);
  }

  /** The arrival's surroundings in the bot's world model. */
  function census(b: NetherBot, at: Vec3): SiteRow['census'] {
    const w = b.built.mobility!.world;
    const floor: Record<string, number> = {};
    const KEEP = /nylium|wart_block|soul_s|basalt|blackstone|netherrack|magma|gravel|nether_brick|lava|obsidian|glowstone|shroomlight|bone_block|ancient_debris|gold_block|chest/;
    let lava16 = 0;
    let lavaNearest: number | null = null;
    let quartzOpen = 0;
    for (let dx = -32; dx <= 32; dx++) {
      for (let dz = -32; dz <= 32; dz++) {
        for (let dy = -32; dy <= 32; dy++) {
          const p = { x: Math.floor(at.x) + dx, y: Math.floor(at.y) + dy, z: Math.floor(at.z) + dz };
          const d = Math.hypot(dx, dy, dz);
          if (d > 32) continue;
          const name = w.blockAt(p)?.name;
          if (!name) continue;
          if (Math.abs(dx) <= 12 && Math.abs(dz) <= 12 && Math.abs(dy) <= 4 && KEEP.test(name)) floor[name] = (floor[name] ?? 0) + 1;
          if (name.includes('lava') && d <= 16) {
            lava16++;
            if (lavaNearest === null || d < lavaNearest) lavaNearest = r1(d);
          }
          if (name === 'quartz_ore') {
            const open = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([ox, oy, oz]) => w.blockAt({ x: p.x + ox!, y: p.y + oy!, z: p.z + oz! })?.name === 'air');
            if (open) quartzOpen++;
          }
        }
      }
    }
    const score = (re: RegExp): number => Object.entries(floor).reduce((s, [k, v]) => (re.test(k) ? s + v : s), 0);
    const biomes: [string, number][] = [
      ['crimson forest', score(/crimson_nylium|nether_wart_block/)],
      ['warped forest', score(/warped_nylium|warped_wart_block/)],
      ['soul sand valley', score(/soul_s/)],
      ['basalt deltas', score(/basalt|blackstone/)],
      ['nether wastes', score(/netherrack/) / 4],
    ];
    biomes.sort((a, c) => c[1] - a[1]);
    const below = w.blockAt({ x: Math.floor(at.x), y: Math.floor(at.y) - 1, z: Math.floor(at.z) })?.name ?? '?';
    return { floor, biome: biomes[0]![0], lava16, lavaNearest, quartzOpen, platform: below === 'obsidian' };
  }

  /** The summoned cell round the bot at `me` (see CELLS); the lines of what was summoned where. */
  async function summonCell(b: NetherBot, me: Vec3, tag: string, SUMMON: SummonSpec): Promise<string[]> {
    const w = b.built.mobility!.world;
    const name = (p: Vec3): string => w.blockAt(p)?.name ?? '';
    const solid = (p: Vec3): boolean => {
      const k = w.blockAt(p);
      return !!k && k.boxes.length > 0 && !/lava|magma|fire/.test(k.name);
    };
    const air = (p: Vec3): boolean => {
      const k = w.blockAt(p);
      return !!k && k.boxes.length === 0 && !/lava|fire|portal/.test(k.name);
    };
    const used: Vec3[] = [];
    const free = (p: Vec3): boolean => used.every((u) => Math.hypot(u.x - p.x, u.z - p.z) >= 2);
    const pick = (type: string, i: number): Vec3 | undefined => {
      const fx = Math.floor(me.x);
      const fy = Math.floor(me.y);
      const fz = Math.floor(me.z);
      const a0 = (i * 2.4) % (2 * Math.PI);
      for (let step = 0; step < 48; step++) {
        const a = a0 + (step * Math.PI) / 24;
        if (type === 'ghast') {
          for (const r of [20, 16, 24]) {
            for (const up of [6, 3, 10]) {
              const p = { x: fx + Math.round(Math.cos(a) * r), y: fy + up, z: fz + Math.round(Math.sin(a) * r) };
              let ok = true;
              for (let dx = -2; dx <= 2 && ok; dx++) for (let dy = 0; dy <= 4 && ok; dy++) for (let dz = -2; dz <= 2 && ok; dz++) if (!air({ x: p.x + dx, y: p.y + dy, z: p.z + dz })) ok = false;
              if (ok && free(p)) return p;
            }
          }
          continue;
        }
        const rs = type === 'blaze' ? [10, 8, 12] : [12, 10, 14];
        for (const r of rs) {
          for (let dy = -4; dy <= 4; dy++) {
            const p = { x: fx + Math.round(Math.cos(a) * r), y: fy + dy + (type === 'blaze' ? 3 : 0), z: fz + Math.round(Math.sin(a) * r) };
            const ground = type === 'blaze' ? air({ x: p.x, y: p.y - 1, z: p.z }) || solid({ x: p.x, y: p.y - 1, z: p.z }) : solid({ x: p.x, y: p.y - 1, z: p.z });
            if (ground && air(p) && air({ x: p.x, y: p.y + 1, z: p.z }) && !name({ x: p.x, y: p.y - 1, z: p.z }).includes('lava') && free(p)) return p;
          }
        }
      }
      return undefined;
    };
    const out: string[] = [];
    const cells: { type: string; p: Vec3; i: number }[] = [];
    let i = 0;
    for (const s of SUMMON) {
      for (let n = 0; n < s.n; n++, i++) {
        const p = pick(s.type, i);
        if (!p) {
          out.push(`${s.type}: none`);
          continue;
        }
        used.push(p);
        // (at the bot: its dimension, its chunks loaded; `execute in nether` from the console found no loaded chunk)
        await netherCmd('execute', 'as', b.name, 'at', '@s', 'run', 'summon', s.type, String(p.x + 0.5), String(p.y), String(p.z + 0.5), '0', '0', 'minecraft:entity_spawned', tag).catch(() => undefined);
        cells.push({ type: s.type, p, i: out.length });
        out.push(`${s.type} ${r1(p.x - me.x)},${r1(p.y - me.y)},${r1(p.z - me.z)}`);
      }
    }
    // each summoned mob seen in the bot's entity list (within 6 of its cell; a ghast or a blaze drifts: within 16), else marked
    await sleep(2000);
    for (const c of cells) {
      const r = c.type === 'ghast' || c.type === 'blaze' ? 16 : 6;
      const seen = [...w.entities.values()].some((e) => e.type.replace(/^minecraft:/, '') === c.type && Math.hypot(e.pos.x - c.p.x - 0.5, e.pos.y - c.p.y, e.pos.z - c.p.z - 0.5) < r);
      if (!seen) out[c.i] += ' (not seen)';
    }
    return out;
  }

  async function oneSite(b: NetherBot, k: number, SUMMON: SummonSpec): Promise<SiteRow> {
    const w = b.built.mobility!.world;
    const pve = b.task.pve!;
    const ow = { x: base.x + k * SPACING, z: base.z };
    const row: SiteRow = {
      label: LABEL, kit: KIT, site: k, cell: SUMMON.map((s) => `${s.type}:${s.n}`).join(',') || 'natural', overworld: ow, there: '', thereS: 0, stayS: 0, deaths: 0, deathCauses: [], damage: 0, byCause: {}, byDamager: {},
      minHealth: 20, points: 0, quartz: 0, mineCmds: 0, mineEnds: [], maxFromPortal: 0, endFromPortal: null, mobs: {}, targeted: {}, fights: 0, kills: 0, flees: 0, fireEscapes: 0, back: '', backS: 0, backDamage: 0, pullFails: 0, ownHits: 0, ownByGuess: {}, burns: 0, fireHurts: 0,
    };
    // the overworld side: a platform high over the flat ground and a lit portal on it
    await dimTeleport(b, 'overworld', { x: ow.x + 0.5, y: 152, z: ow.z + 0.5 }, -90).catch(() => undefined);
    await truthRetry(b, 'fill', [ow.x - 6, 150, ow.z - 6, ow.x + 6, 150, ow.z + 6, 'stone']);
    await truthRetry(b, 'fill', [ow.x - 6, 151, ow.z - 6, ow.x + 6, 156, ow.z + 6, 'air']);
    await truthRetry(b, 'portal', ['overworld', ow.x + 3, 150, ow.z - 1, 'z']);
    await dimTeleport(b, 'overworld', { x: ow.x + 0.5, y: 151, z: ow.z + 0.5 }, -90);
    const store = waypointStoreOf(b.task)!;
    store.delete('portal');
    store.delete('nether_portal');
    await setKit(b);
    await netherCmd('xp', '-30000L', b.name);
    await sleep(1500);
    // through the portal: the server links to a Nether portal near (x / 8, z / 8) or builds one
    let from = b.said.length;
    let t = Date.now();
    await b.command('!nether');
    row.there = await b.reply((s) => s.startsWith('in the nether') || s.startsWith('nether:'), from, 120_000).catch(() => 'no end line in 120 s');
    row.thereS = r1((Date.now() - t) / 1000);
    if (!row.there.startsWith('in the nether')) return row;
    await w.waitForChunks(3, { timeoutMs: 60_000 }).catch(() => undefined);
    await sleep(2000);
    const np = store.get('nether_portal');
    const arrival = b.task.position()!;
    row.arrival = { x: r1(arrival.x), y: r1(arrival.y), z: r1(arrival.z) };
    const portalAt = np ? { x: np.x + 0.5, y: np.y ?? arrival.y, z: np.z + 0.5 } : arrival;
    row.census = census(b, arrival);
    // the stay
    const deaths0 = b.built.respawn!.deaths;
    const stats0 = { ...pve.stats };
    const fire0 = fireProcessOf(b.task)?.stats.escapes ?? 0;
    const watch = (fireProcessOf(b.task) as unknown as { d?: { watch?: { stats: { burns: number; fireHurts: number } } } } | undefined)?.d?.watch;
    const burn0 = { ...(watch?.stats ?? { burns: 0, fireHurts: 0 }) };
    const logs0 = b.logs.length;
    const offHit = pve.mobs.onHit((guess, damage, cause) => {
      row.ownHits++;
      const k = guess ? bareType(guess.type) : (cause ?? 'unknown');
      row.ownByGuess[k] = r1((row.ownByGuess[k] ?? 0) + damage);
      const h = pve.mobs.selfHealth;
      if (h !== undefined && h > 0) row.minHealth = Math.min(row.minHealth, h);
    });
    const quartz0 = w.inventory.slots.slice(0, 36).reduce((s, x) => s + (x?.name === 'quartz' ? x.count : 0), 0);
    const xp0 = xpTotal(w.self.level ?? 0, w.self.xpProgress ?? 0);
    const tick0 = await b.truth.now();
    const hurt = new Map<string, HurtRecord>();
    const pull = async (): Promise<void> => {
      const r = await b.truth.hurtlog(tick0, b.name).catch(() => undefined);
      if (!r) row.pullFails++;
      for (const h of r?.events ?? []) if (h.victimName === b.name) hurt.set(`${h.tick}:${h.cause}:${h.damage}:${h.damagerId ?? '-'}`, h);
    };
    const seen = new Map<string, Map<bigint, number>>();
    const targeted = new Map<string, Set<bigint>>();
    const trace: string[] = [];
    const t0 = Date.now();
    let mp: MineProcess | undefined;
    let nextAt = 0;
    let lastPull = 0;
    let lastTrace = 0;
    const tag = `n2${Math.random().toString(36).slice(2, 7)}`;
    let summonedAt = SUMMON.length ? undefined : 0;
    from = b.said.length;
    while (Date.now() - t0 < STAY_MS) {
      if (b.built.respawn!.deaths > deaths0) break;
      if (w.self.dimension !== 1) break;
      const me = b.task.position();
      if (summonedAt === undefined && Date.now() - t0 >= SUMMON_AT_MS && me) {
        summonedAt = Date.now();
        row.summoned = await summonCell(b, me, tag, SUMMON);
      }
      const hp = w.self.health;
      if (hp > 0) row.minHealth = Math.min(row.minHealth, hp);
      if (me) {
        const d = Math.hypot(me.x - portalAt.x, me.y - portalAt.y, me.z - portalAt.z);
        row.maxFromPortal = Math.max(row.maxFromPortal, r1(d));
        for (const e of w.entities.values()) {
          if (NOT_MOB.test(e.type)) continue;
          const c = classify(e.type);
          if (c === 'item' || c === 'player') continue;
          const de = Math.hypot(e.pos.x - me.x, e.pos.y - me.y, e.pos.z - me.z);
          if (de > 32) continue;
          const ty = bareType(e.type);
          const m = seen.get(ty) ?? new Map<bigint, number>();
          m.set(e.runtimeId, Math.min(m.get(e.runtimeId) ?? Infinity, de));
          seen.set(ty, m);
          if (pve.mobs.targetsUs(e.runtimeId)) {
            const s = targeted.get(ty) ?? new Set<bigint>();
            s.add(e.runtimeId);
            targeted.set(ty, s);
          }
        }
      }
      // the mine job: typed again after each end
      if (mp?.done) {
        const state = await mp.result;
        const end = b.said.slice(from).find((m) => m.startsWith('mine quartz'));
        row.mineEnds.push(`${Math.round((Date.now() - t0) / 1000)}s ${state} ${mp.task.stats.mined}${end ? `: ${end}` : ''}`.slice(0, 200));
        nextAt = Date.now() + (state === 'low_health' ? 5000 : 2000);
        mp = undefined;
      }
      if (!mp && Date.now() >= nextAt && !b.processes.userProcesses().some((p) => p.name === 'mine')) {
        from = b.said.length;
        await b.command(`!mine quartz_ore ${MINE_N}`);
        row.mineCmds++;
        mp = (await until(() => b.processes.find('mine')[0] as MineProcess | undefined, 5_000, 'the mine process').catch(() => undefined)) ?? undefined;
        if (!mp) nextAt = Date.now() + 5000;
      }
      if (Date.now() - lastPull > 10_000) {
        lastPull = Date.now();
        await pull();
      }
      if (TRACE && Date.now() - lastTrace > 5000 && me) {
        lastTrace = Date.now();
        const near = [...w.entities.values()]
          .filter((e) => !NOT_MOB.test(e.type) && classify(e.type) !== 'item')
          .map((e) => ({ t: bareType(e.type), d: Math.hypot(e.pos.x - me.x, e.pos.y - me.y, e.pos.z - me.z) }))
          .filter((e) => e.d < 24)
          .sort((a, c) => a.d - c.d)
          .slice(0, 5)
          .map((e) => `${e.t}@${e.d.toFixed(0)}`)
          .join(' ');
        trace.push(`${Math.round((Date.now() - t0) / 1000)}s hp ${r1(hp)} food ${pve.food()} ${b.processes.active?.name ?? '-'} ${r1(me.x - portalAt.x)},${r1(me.y - portalAt.y)},${r1(me.z - portalAt.z)} ${near}`);
      }
      await sleep(500);
    }
    row.stayS = r1((Date.now() - t0) / 1000);
    if (SUMMON.length) await netherCmd('kill', `@e[name=${tag}]`).catch(() => undefined);
    const alive = b.built.respawn!.deaths === deaths0 && w.self.dimension === 1;
    if (mp && !mp.done) {
      const f = b.said.length;
      await b.command('!mine stop');
      await b.reply((s) => s.startsWith('mine') || s.startsWith('not mining'), f, 10_000).catch(() => undefined);
    }
    await until(() => (b.processes.userProcesses().length === 0 ? true : undefined), 15_000, 'idle').catch(() => undefined);
    const me = b.task.position();
    row.endFromPortal = alive && me ? r1(Math.hypot(me.x - portalAt.x, me.y - portalAt.y, me.z - portalAt.z)) : null;
    row.points = r1(xpTotal(w.self.level ?? 0, w.self.xpProgress ?? 0) - xp0);
    row.quartz = w.inventory.slots.slice(0, 36).reduce((s, x) => s + (x?.name === 'quartz' ? x.count : 0), 0) - quartz0;
    // the way back
    if (alive) {
      await pull();
      const before = new Set(hurt.keys());
      from = b.said.length;
      t = Date.now();
      await b.command('!overworld');
      row.back = await b.reply((s) => s.startsWith('in the overworld') || s.startsWith('overworld:'), from, 180_000).catch(() => 'no end line in 180 s');
      row.backS = r1((Date.now() - t) / 1000);
      await sleep(1000);
      await pull();
      row.backDamage = r1([...hurt].filter(([key]) => !before.has(key)).reduce((s, [, h]) => s + h.damage, 0));
    } else {
      await sleep(4000);
      await pull();
    }
    const fresh = b.built.respawn!.history.filter((d) => d.n > deaths0);
    row.deaths = b.built.respawn!.deaths - deaths0;
    row.deathCauses = fresh.map((d) => `${d.cause}${d.messages.length ? ` (${d.messages.join(' ')})` : ''}`);
    for (const h of hurt.values()) {
      row.damage += h.damage;
      row.byCause[h.cause] = r1((row.byCause[h.cause] ?? 0) + h.damage);
      const k2 = (h.damagerType ?? '-').replace('minecraft:', '');
      row.byDamager[k2] = r1((row.byDamager[k2] ?? 0) + h.damage);
    }
    row.damage = r1(row.damage);
    for (const [ty, m] of seen) row.mobs[ty] = { n: m.size, nearest: r1(Math.min(...m.values())) };
    for (const [ty, s] of targeted) row.targeted[ty] = s.size;
    row.fights = pve.stats.guardTriggers - stats0.guardTriggers;
    row.kills = pve.stats.kills - stats0.kills;
    row.flees = pve.stats.flees - stats0.flees;
    row.fireEscapes = (fireProcessOf(b.task)?.stats.escapes ?? 0) - fire0;
    offHit();
    row.burns = (watch?.stats.burns ?? 0) - burn0.burns;
    row.fireHurts = (watch?.stats.fireHurts ?? 0) - burn0.fireHurts;
    if (TRACE) {
      row.trace = trace;
      row.lines = b.logs
        .slice(logs0)
        .filter((l) => /\b(fire|flee|guard|pve|mend|blade|portal|dimension change):? /.test(l) && !/reflex: .* down \(|process: guard started|combat: fighting /.test(l))
        .slice(0, 160)
        .map((l) => l.replace(`${b.name}:`, '').slice(0, 220));
    }
    return row;
  }

  it('a stay of mining quartz at each site, the hazards counted', async () => {
    const b = bot!;
    // STAY_BACK="x,y,z[;x,y,z...]": the way back only, from a Nether cell where a stay ended (a failed `!overworld`
    // seen in the series), with the planner's and the portal's log lines
    const back = (process.env.STAY_BACK ?? '').split(';').filter(Boolean).map((s) => s.split(',').map(Number));
    for (const p of back) {
      await setKit(b);
      await dimTeleport(b, 'nether', { x: p[0]!, y: p[1]!, z: p[2]! });
      await b.built.mobility!.world.waitForChunks(3, { timeoutMs: 60_000 }).catch(() => undefined);
      await sleep(3000);
      const logs0 = b.logs.length;
      const from = b.said.length;
      const t = Date.now();
      await b.command('!overworld');
      const end = await b.reply((s) => s.startsWith('in the overworld') || s.startsWith('overworld:'), from, 180_000).catch(() => 'no end line in 180 s');
      console.log(`[nether-stay] back from ${p.join(' ')}: ${end} in ${r1((Date.now() - t) / 1000)} s`);
      console.log(b.logs.slice(logs0).filter((l) => /nav|portal|goto|plan|unreach|path|move|dig|place|pillar|bridge/.test(l)).slice(-120).join('\n'));
      // the blocks round the portal the trip looked for and round the start (STAY_BACK_PORTAL="x,y,z")
      const w = b.built.mobility!.world;
      const map = (c: number[], r: number, h: number): string => {
        const rows: string[] = [];
        for (let dy = h; dy >= -h; dy--) {
          for (let dz = -r; dz <= r; dz++) {
            let s = '';
            for (let dx = -r; dx <= r; dx++) {
              const n = w.blockAt({ x: c[0]! + dx, y: c[1]! + dy, z: c[2]! + dz })?.name ?? '?';
              s += n === 'air' ? '.' : n === 'portal' ? 'P' : n === 'obsidian' ? 'O' : n.includes('lava') ? 'L' : n === 'quartz_ore' ? 'q' : n === '?' ? '?' : n.includes('basalt') ? 'b' : n.includes('blackstone') ? 'k' : n === 'netherrack' ? '#' : n === 'magma' ? 'M' : n.includes('fire') ? 'f' : 'x';
            }
            rows.push(`y${c[1]! + dy} z${c[2]! + dz} ${s}`);
          }
        }
        return rows.join('\n');
      };
      const pp = process.env.STAY_BACK_PORTAL?.split(',').map(Number);
      if (pp?.length === 3) console.log(`round the portal ${pp.join(' ')} (x ${pp[0]! - 4}..${pp[0]! + 4}):\n${map(pp, 4, 3)}`);
      const me = b.task.position()!;
      console.log(`round the bot ${r1(me.x)} ${r1(me.y)} ${r1(me.z)}:\n${map([Math.floor(me.x), Math.floor(me.y), Math.floor(me.z)], 3, 3)}`);
      // a plain walk to the arrival cell and one to a cell 4 off the portal, for the planner's reasons
      for (const goal of pp?.length === 3 ? [{ type: 'near' as const, p: { x: pp[0]!, y: pp[1]!, z: pp[2]! }, r: 3 }] : []) {
        const r = await b.built.mobility!.skills.goto(goal, { timeoutTicks: 1200 });
        console.log(`goto ${JSON.stringify(goal)}: ${r.ok ? 'ok' : r.reason}`);
      }
      // short hops (STAY_BACK_HOPS="x,y,z;..."): each a short plan, then `!overworld` again
      for (const h of (process.env.STAY_BACK_HOPS ?? '').split(';').filter(Boolean).map((s) => s.split(',').map(Number))) {
        const r = await b.built.mobility!.skills.goto({ type: 'near', p: { x: h[0]!, y: h[1]!, z: h[2]! }, r: 1.5 }, { timeoutTicks: 1200 });
        const m = b.task.position()!;
        console.log(`hop to ${h.join(' ')}: ${r.ok ? 'ok' : r.reason}; now ${r1(m.x)} ${r1(m.y)} ${r1(m.z)}`);
      }
      if (process.env.STAY_BACK_HOPS) {
        const from2 = b.said.length;
        await b.command('!overworld');
        const end2 = await b.reply((s) => s.startsWith('in the overworld') || s.startsWith('overworld:'), from2, 180_000).catch(() => 'no end line in 180 s');
        console.log(`[nether-stay] back after the hops: ${end2}`);
      }
    }
    if (back.length) return;
    for (let i = 0; i < SITES; i++) {
      if (Date.now() - t0Run > BUDGET_MS) {
        console.log(`[nether-stay] site ${FIRST + i}: not started (the run's budget of ${BUDGET_MS / 1000} s)`);
        continue;
      }
      const row = await oneSite(b, FIRST + i, CELLS[i % CELLS.length] ?? []);
      rows.push(row);
      const line = `${row.label} ${row.kit} site ${row.site} ${row.cell}${row.summoned ? ` [${row.summoned.join('; ')}]` : ''} (${row.overworld.x} ${row.overworld.z}): ${row.there} in ${row.thereS} s; ${row.census?.biome ?? '?'}; stay ${row.stayS} s: deaths ${row.deaths}${row.deathCauses.length ? ` (${row.deathCauses.join('; ')})` : ''}, damage ${row.damage} ${JSON.stringify(row.byDamager)} ${JSON.stringify(row.byCause)}, lowest ${row.minHealth}, +${row.points} points, ${row.quartz} quartz, ${row.mineCmds} !mine, out to ${row.maxFromPortal}; back: ${row.back} in ${row.backS} s (${row.backDamage} damage)`;
      console.log(`[nether-stay] ${line}`);
      if (OUT) appendFileSync(OUT, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
    }
    expect(rows.length).toBeGreaterThan(0);
  }, 30 * 60_000);
});
