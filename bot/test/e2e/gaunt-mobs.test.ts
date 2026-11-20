// Track M1 (docs/pve.md "Never die to common mobs (Track M1)", ADR 0079): the gauntlet table. On bds-gaunt (or bds-pve with
// GAUNT_BDS_PORT / GAUNT_BDS_CONTAINER), flat world, midnight with the clock frozen, no natural spawns: for each kit and
// cell, a fresh spot, the bot at full health and food with the kit, guard on (radius 16, as on the Realm), the home point
// where it stands; the cell's mobs are summoned in a ring 7 blocks round it (flying ones 10 up), the activity starts, and
// the cell runs until every summoned mob is gone or dead, the bot died, or MOBS_SECONDS (default 60). Per cell: deaths,
// damage (truth:hurtlog, the server's record), damage a minute, hits taken by mob type, the time to clear, mobs left, the
// reflex's hits, the floors taken, and whether the activity finished. One line per cell and a table at the end
// (`gauntlet:`), and one JSON line per cell to MOBS_OUT when set.
//
// Kits (MOBS_KITS, default bare,live,kb2): `bare` no weapon, no armour, 8 bread; `live` the netherite set, a netherite sword,
// a shield, 16 cooked beef, 32 cobblestone; `kb2` the live kit with Knockback II on the sword. Track M4, the early-game kits
// (16 bread each, no elytra): `none` nothing else; `stone` a stone sword, pickaxe, axe and shovel, no armour, no shield;
// `iron` an iron sword, the iron set, a shield, a stone pickaxe and shovel. Track M9: `mats` the `none` kit with 4 cobblestone,
// 2 sticks and 4 oak planks (a stone sword and its crafting table; PveRules craftBlade).
// Track M9: MOBS_TERRAIN=trees|walls lays cover round each spot, MOBS_TERRAIN=doors a room with a closed fence gate a side (layCover); every row has the long case's fields (endFromSpot,
// maxFromSpot, homeS, lastHitS, a 5 s track, the flight's and guard's lines); MOBS_SECONDS=240 for the long case.
// Cells (MOBS_CELLS: a comma list of names or prefixes, default all): `<mob>-1` one mob; `<mob>-2`, `<mob>-4` crowds of one
// type; `mixed-4`, `mixed-8`; `act-<activity>` a mixed crowd of 4 during goto / mine / eat / landed. MOBS_HARD=1 runs at hard.
// Track M4: MOBS_TIME=day runs at noon (the undead burn: no helmet on them), else midnight. The rules are on by default;
// MOBS_RULES=legHold=false,... sets PveController.rules for the run (Track M4's five false: the code before Track M4; Track
// M5 added shooterWay, poisonBite, witchCrowd, Track M6 volley, bareArcher); MOBS_AB_RULE=<rule>[,<rule>...] flips them all
// off / on between the repeats.
// The idle night (MOBS_NIGHT=1): natural spawning and the daylight cycle on from dusk to dawn (12 000 ticks, about 10 min),
// the bot idle in the open at its home point, each kit once.
// Never asserts the bars (it is the measurement); asserts only that the harness itself worked (every cell ran). About
// 25 min a kit for the full set.
// Track M8: every run starts from rest. After a death the respawn's return home (to the run before's spot) is waited for
// and stopped, and before the mobs are summoned no process may run and the bot must stand on its spot; else the run is a
// harness run (rerun, kept apart). Each row names the server it ran on (`server`: the container, its image's BDS build,
// the version the server advertised).
// Track M10: the kit `empty` (nothing at all, no food: the hunger case); MOBS_HOME_WAIT=1 keeps a cleared run going while
// the bot is out and not home yet; MOBS_START_OUT=<d> starts the run d blocks east of the home point. The track's points
// also carry the nearest mob's distance from the spot and the food; each row counts the walks home of `backHome`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import type { Vec3 } from '../../src/connection/types.ts';
import { flyControlOf } from '../../src/chat/commands-fly.ts';
import { survivalKitOf } from '../../src/chat/commands-survival.ts';
import { centre, E2E, FEET_Y, fill, gauntCmd, GAUNT_CONTAINER, prepareServer, privateArea, serverBuild, sleep, startGauntBot, teleport, uniqueName, until, type GauntBot, type HurtRecord } from './gaunt-truth.ts';
import { blockDamage, cleanSpot, harnessDeaths } from './pve-truth.ts';

const KITS = (process.env.MOBS_KITS ?? 'bare,live,kb2').split(',').map((s) => s.trim()).filter(Boolean);
/** Track M7: milk buckets given on top of the kit (MOBS_MILK, default 0). */
const MILK = Number(process.env.MOBS_MILK ?? '0') || 0;
const CELL_FILTER = (process.env.MOBS_CELLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const SECONDS = Number(process.env.MOBS_SECONDS ?? 60);
const CLEAR_AT = process.env.MOBS_CLEAR_AT ? Number(process.env.MOBS_CLEAR_AT) : undefined; // the cell's mobs removed at this second (the seal-in's way out)
const HARD = process.env.MOBS_HARD === '1';
const NIGHT = process.env.MOBS_NIGHT === '1';
/**
 * Track K6: MOBS_NIGHT_MEND=post|watch: a Mending elytra damaged 300 carried in main-inventory slot 20 through the idle
 * night; post: mendPost on and `!mend elytra 15` typed at dusk (the post source), watch: no command (the holds on the way
 * only). The row adds the uses mended, the job's end line and the kills.
 */
const NIGHT_MEND = process.env.MOBS_NIGHT_MEND;
const OUT = process.env.MOBS_OUT;
const LABEL = process.env.MOBS_LABEL ?? 'run';
const TRACE = process.env.MOBS_TRACE; // a JSON line per death: the last 10 s by tick (state) and the server's hurt log
const SEAL_TRACE = (process.env.MOBS_SET ?? '').includes('sealIn=true'); // keep 2 min of trace and dump it when a seal-in was tried
const TRACE_ALL = process.env.MOBS_TRACE_ALL === '1'; // Track M2: the whole run's trace for every run, not only a death's last 10 s
/** Track M5: the ticks a death's trace keeps (default 200: its last 10 s). */
const TRACE_TICKS = Number(process.env.MOBS_TRACE_TICKS ?? 200);
const SETTINGS = (process.env.MOBS_SET ?? '').split(',').map((s) => s.trim()).filter(Boolean); // key=value pairs applied at the start
/** Track M2: each cell this many times in a row (the fair trials: 30 runs a side). */
const REPEAT = Math.max(1, Number(process.env.MOBS_REPEAT ?? 1));
/** Track M2: a boolean setting flipped off / on between the repeats of a cell (off first), so both sides run on the same server, spots and order. */
const AB = process.env.MOBS_AB;
/** Track M4: a rule of PveController.rules flipped off / on between the repeats (as MOBS_AB for a setting), and rules set for the whole run (`legHold=true,...`). */
const AB_RULE = process.env.MOBS_AB_RULE;
const RULES = (process.env.MOBS_RULES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
/** Track M2: the spots' row (40 blocks a row), so that a second run on the same server keeps its distance from the first. */
const ROW = Number(process.env.MOBS_ROW ?? 0);
/** Track M3: every kit also carries the flight kit (an elytra in the inventory, 64 rockets), for the elytra flee (`MOBS_SET=fleeFly=true` or `MOBS_AB=fleeFly`). */
const ELYTRA = process.env.MOBS_ELYTRA === '1';
/** Track M4: the clock frozen at `noon` (day: the undead burn in the sun) or `midnight` (the default). */
const TIME = process.env.MOBS_TIME === 'day' || process.env.MOBS_TIME === 'noon' ? 'noon' : 'midnight';
/** Track M5: a run the harness spoiled is run again this many times before it stands (marked) in the table. */
const HARNESS_RETRIES = Number(process.env.MOBS_HARNESS_RETRIES ?? 2);
/**
 * Track M7: a cleared run goes on while the bot is still poisoned (up to MOBS_SECONDS from the start), so that the lowest
 * health is the one the poison leaves, not the one at the last kill. Without it a `seal-5` run that cleared at 17 s with
 * 30 s of poison left said "lowest 12".
 */
const POISON_WAIT = process.env.MOBS_POISON_WAIT === '1';
/**
 * Track M10: a cleared run (every mob gone or dead) goes on, up to MOBS_SECONDS, while the bot has been 20 or more out and is
 * not home again: whether it gets home once the mobs are gone, and when (`homeS`, `clearS`). Without it the run ended at the
 * clear and the long case's skeleton rows could not show the way home.
 */
const HOME_WAIT = process.env.MOBS_HOME_WAIT === '1';
/**
 * Track M10: MOBS_START_OUT=<d>: the run starts d blocks east of the spot (home stays the spot) and the mobs are summoned round
 * the bot there, so an archer that follows has home ahead of the bot, not behind it (with MOBS_TERRAIN=doors: outside the
 * room, whose east gate is between the bot and home).
 */
const START_OUT = Number(process.env.MOBS_START_OUT ?? 0) || 0;
/** Track M9: cover laid round each spot before the run (`trees`, `walls`; see layCover), none by default. */
const TERRAIN = process.env.MOBS_TERRAIN;
/** Track M9: the cover reaches this far from the spot (blocks) and keeps this far off it (the mobs are summoned 7 out). */
const COVER_R = 44;
const COVER_CLEAR = 10;
/** Track M9: MOBS_TERRAIN=doors: the room's half side (blocks from the spot to its walls). */
const ROOM_HALF = 12;
/** Track M9: the bot's lines kept in a run's row (`lines`). */
const LINE_RE = /^(flee|guard|floor|pve|home|shelter|craft|blade)\b/;
let lineSink: ((msg: string) => void) | undefined;

interface MobSpec {
  type: string;
  event?: string;
  /** Anger it at the bot after the summon (an enderman that attacked). */
  anger?: boolean;
  flying?: boolean;
}

interface Cell {
  name: string;
  mobs: MobSpec[];
  activity: 'idle' | 'goto' | 'mine' | 'eat' | 'landed';
}

const M = (type: string, extra: Partial<MobSpec> = {}): MobSpec => ({ type, ...extra });
const SINGLE: Record<string, MobSpec> = {
  zombie: M('zombie'),
  husk: M('husk'),
  baby: M('zombie', { event: 'minecraft:as_baby' }),
  drowned: M('drowned'),
  zvillager: M('zombie_villager_v2'),
  skeleton: M('skeleton'),
  stray: M('stray'),
  creeper: M('creeper'),
  spider: M('spider'),
  cavespider: M('cave_spider'),
  phantom: M('phantom', { flying: true }),
  witch: M('witch'),
  enderman: M('enderman', { anger: true }),
  pillager: M('pillager'),
  slime: M('slime'),
};
const MIXED = [SINGLE.zombie!, SINGLE.skeleton!, SINGLE.creeper!, SINGLE.spider!, SINGLE.phantom!, SINGLE.baby!, SINGLE.witch!, SINGLE.husk!];

function cells(): Cell[] {
  const out: Cell[] = [];
  for (const [k, m] of Object.entries(SINGLE)) out.push({ name: `${k}-1`, mobs: [m], activity: 'idle' });
  for (const k of ['zombie', 'skeleton', 'creeper', 'spider', 'phantom']) {
    for (const n of [2, 4]) out.push({ name: `${k}-${n}`, mobs: Array.from({ length: n }, () => SINGLE[k]!), activity: 'idle' });
  }
  out.push({ name: 'witch-2', mobs: [SINGLE.witch!, SINGLE.witch!], activity: 'idle' });
  // the seal-in's cell (run it with MOBS_SET=sealIn=true and the `blocks` or `bare` kit): 4 skeletons and a witch
  out.push({ name: 'seal-5', mobs: [SINGLE.skeleton!, SINGLE.skeleton!, SINGLE.skeleton!, SINGLE.skeleton!, SINGLE.witch!], activity: 'idle' });
  out.push({ name: 'mixed-4', mobs: MIXED.slice(0, 4), activity: 'idle' });
  out.push({ name: 'mixed-8', mobs: MIXED.slice(0, 8), activity: 'idle' });
  for (const a of ['goto', 'mine', 'eat', 'landed'] as const) out.push({ name: `act-${a}`, mobs: MIXED.slice(0, 4), activity: a });
  return CELL_FILTER.length ? out.filter((c) => CELL_FILTER.some((f) => c.name === f || c.name.startsWith(f))) : out;
}

interface CellResult {
  /** Track M3: the elytra flee in this cell: the times the floor was asked, how its flights ended, the last one's line, how far from the spot the bot stood at the cell's end. */
  fleeFly?: { asked: number; landed: number; ended: number; refused: number; last: string | null; fromSpot: number };
  label: string;
  /** Track M8: the server the run ran on (`bds-pve 1.26.60.6 (pong 1.26.60)`). */
  server?: string;
  /** The A/B setting's value in this run (MOBS_AB), and the repeat's index. */
  ab?: string;
  rep?: number;
  kit: string;
  cell: string;
  activity: string;
  hard: boolean;
  /** Track M4: `noon` or `midnight`. */
  time: string;
  seconds: number;
  died: boolean;
  /** Track M5: the death messages of the run's deaths (`death.attack.mob`, `death.attack.inWall`, ...). */
  deathCauses?: string[];
  /**
   * Track M5: the run measured the harness, not the bot: a death no mob caused (a block in its cells, the ground) or damage
   * from blocks (suffocation). Such a run is no row's run: it is run again (MOBS_HARNESS_RETRIES, default 2) and kept apart.
   */
  harness?: string;
  damage: number;
  perMinute: number;
  hitsByType: Record<string, number>;
  damageByType: Record<string, number>;
  /** Damage by the server's cause (entity_attack, projectile, magic, entity_explosion, ...). */
  damageByCause: Record<string, number>;
  cleared: boolean;
  clearS: number | null;
  left: number;
  minHealth: number;
  /** Track M7: seconds of the witch's poison still on the bot when the run ended (none: 0, left out), and the health then. */
  poisonLeftS?: number;
  endHealth?: number;
  /** Track M7: guard's rushes on a witch in the run (`pve.witchRush`). */
  rushes?: number;
  /** Track M7: milk drunk against the poison in the run (`pve.cure`). */
  cures?: number;
  reflexHits: number;
  /** Side steps from a witch's potion in the run (tasks/pve.ts potionStep). */
  potionSteps: number;
  /** Track M2: the witch's potions that ended in the run, those that ended within 4 of the bot (a splash reaches 4), and each one's distance. */
  potions: number;
  potionsNear: number;
  potionEnds: number[];
  floors: Record<string, number>;
  activityDone: string;
  friendly: number;
  /** What the friendly hits were on (type x count). */
  friendlyOn?: Record<string, number>;
  /**
   * Track M9 (the long case): how far from the spot the bot stood at the end and at most; the first second it stood within
   * 3 of the spot (home) again after it had been 20 or more out; the second of the last hit on it; every 5 s a sample
   * `[s, from the spot, the nearest live summoned mob's distance (the server's place; -1 none), the process, health]`; the
   * flight's and guard's lines with their second (`flee: gave up (60 s) ...`), at most 300.
   */
  endFromSpot?: number;
  maxFromSpot?: number;
  homeS?: number | null;
  /** Track M10: walks home the `backHome` rule started in the run. */
  backHomes?: number;
  lastHitS?: number | null;
  /** Track M10: a sixth field, the nearest mob's own distance from the spot (-1 none), and a seventh, the bot's food. */
  track?: [number, number, number, string, number, number?, number?][];
  lines?: string[];
  /** Track M9: the cover laid round the spot (MOBS_TERRAIN), when any. */
  terrain?: string;
  /** Track M9 (MOBS_TERRAIN=doors): every 5 s, the room's gates open and the mobs still inside it (`s:open N,inside M`). */
  doors?: string[];
  /** The seal-in, when it went up: seconds from the start to sealed and to out, the damage and health inside, the bites. */
  seal?: { sealedS: number; outS: number | null; damageInside: number; healthIn: number; healthMax: number; bites: number; dugIn: boolean; build: { placed: number; open: number; reason?: string; tries: number } | null };
}

const r1 = (v: number): number => Math.round(v * 10) / 10;
/** One tick of the trace (MOBS_TRACE): the bot's state, kept for the last ticks and dumped on a death. */
interface TraceRow { tick: number; ms: number; hp: number; food: number; shield: boolean; eating: boolean; proc: string; phase: string; sprint: boolean; reflex: number; fight: string; poison?: number; x: number; y: number; z: number; near: string }

/** A trace row now (positions relative to `c`). */
function traceRow(b: GauntBot, c: Vec3, tk: bigint, t0: number): TraceRow {
  const loop = b.built.mobility!.loop as unknown as { command: { sneak?: boolean; sprint?: boolean } };
  const me = b.pve.position();
  const near = [...b.built.mobility!.world.entities.values()]
    .filter((e) => !e.type.includes('player') && !e.type.includes('item') && !e.type.includes('xp_orb') && !e.type.includes('arrow'))
    .map((e) => ({ t: e.type.replace('minecraft:', ''), d: Math.hypot(e.pos.x - me.x, e.pos.z - me.z) }))
    .filter((e) => e.d < 16)
    .sort((a, b2) => a.d - b2.d)
    .slice(0, 5)
    .map((e) => `${e.t}@${e.d.toFixed(1)}`)
    .join(' ');
  const kit = b.pve.kit?.() as { busy?: boolean } | undefined;
  const flee = b.task.processes?.find('flee')[0] as unknown as { ep?: { phase?: string } } | undefined;
  return { tick: Number(tk), ms: Date.now() - t0, hp: r1(b.pve.health()), food: b.pve.food(), shield: loop.command.sneak === true, eating: kit?.busy === true, proc: b.task.processes?.active?.name ?? '-', phase: flee?.ep?.phase ?? '-', sprint: loop.command.sprint === true, reflex: reflexHits(b), fight: b.pve.combat.target?.type.replace('minecraft:', '') ?? '-', ...(poisoned(b) ? { poison: poisonLeftS(b) } : {}), x: r1(me.x - c.x), y: Math.round((me.y - FEET_Y) * 100) / 100, z: r1(me.z - c.z), near };
}
const HOSTILE_RE = /zombie|skeleton|creeper|spider|phantom|witch|husk|drowned|stray|slime|enderman|pillager|bogged/;

describe.skipIf(!E2E)('gaunt: the mob gauntlet (Track M1)', () => {
  let bot: GauntBot | undefined;
  const ownerName = uniqueName('GmbOwner');
  const area = privateArea();
  const results: CellResult[] = [];
  const harnessRuns: CellResult[] = [];
  let server = ''; // Track M8: `<container> <BDS build> (pong <version>)`, set once connected
  let spot = 0;
  const nextSpot = (): Vec3 => {
    const i = spot++;
    // a line of spots 40 blocks apart (the ground at each is checked and repaired before use)
    return { x: area.x - 1000 + 40 * (i % 50), y: FEET_Y, z: area.z - 1000 + 40 * (Math.floor(i / 50) + ROW) };
  };

  const say = (b: GauntBot, body: string): void => {
    b.chat.handle({ type: 'chat', source: ownerName, xuid: '', message: body, body, truth: false });
  };

  async function setKit(b: GauntBot, kit: string): Promise<void> {
    const t = b.truth;
    await t.ok('clear', [b.name]);
    await t.ok('unequip', [b.name]);
    await gauntCmd('replaceitem', 'entity', b.name, 'slot.weapon.offhand', '0', 'air');
    if (ELYTRA) {
      // (the rockets first: the hotbar's first slot; the elytra into the main inventory, worn by the flee itself)
      await t.give(b.name, 'firework_rocket', 64);
      await t.ok('setslot', [b.name, 30, 'elytra', 1]);
    }
    // Track M10: `empty` nothing at all, not even food (a first day; the long case's hunger: the sprint stops under 6 food)
    if (kit === 'empty') return;
    if (kit === 'bare' || kit === 'blocks') {
      await t.give(b.name, 'bread', 8);
      if (kit === 'blocks') await t.give(b.name, 'cobblestone', 32); // the seal-in's kit: bare with blocks for the shell
      return;
    }
    // Track M4: the early-game kits. `none` nothing but bread; `stone` a stone sword and stone tools, no armour, no shield;
    // `iron` an iron sword, the iron set and a shield (and stone tools). Bread in all three, no elytra (unless MOBS_ELYTRA).
    if (kit === 'none') {
      await t.give(b.name, 'bread', 16);
      return;
    }
    // Track M9: `mats` the `none` kit with a sword's materials (2 cobblestone and a stick) and a table's (4 oak planks)
    if (kit === 'mats') {
      await t.give(b.name, 'bread', 16);
      await t.give(b.name, 'cobblestone', 4);
      await t.give(b.name, 'stick', 2);
      await t.give(b.name, 'oak_planks', 4);
      return;
    }
    if (kit === 'stone') {
      for (const item of ['stone_sword', 'stone_pickaxe', 'stone_axe', 'stone_shovel']) await t.give(b.name, item, 1);
      await t.give(b.name, 'bread', 16);
      return;
    }
    if (kit === 'iron') {
      await t.give(b.name, 'iron_sword', 1);
      for (const piece of ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']) await t.give(b.name, piece, 1);
      for (const item of ['stone_pickaxe', 'stone_shovel']) await t.give(b.name, item, 1);
      await t.give(b.name, 'bread', 16);
      await t.give(b.name, 'shield', 1);
    } else {
      if (kit === 'kb2') await t.ok('givekb', [b.name, 'netherite_sword', 2, 0]);
      else await t.give(b.name, 'netherite_sword', 1);
      for (const piece of ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots']) await t.give(b.name, piece, 1);
      await t.give(b.name, 'cooked_beef', 16);
      await t.give(b.name, 'cobblestone', 32);
      await t.give(b.name, 'shield', 1);
    }
    // Track M7: MOBS_MILK=<n> milk buckets on top of any kit (the milkCure rule's measurement; a bucket does not stack)
    for (let i = 0; i < MILK; i++) await t.give(b.name, 'milk_bucket', 1);
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
  }

  /**
   * Track M8: nothing left running from the run before (a respawn's return home walks to that run's spot: started during
   * the next run's setup it took the bot 11 blocks off its spot, out of the pillager's reach, before the mobs came).
   */
  async function settle(b: GauntBot): Promise<void> {
    for (const t0 = Date.now(); Date.now() - t0 < 5_000; ) {
      b.pve.stop();
      if (!b.task.processes?.active) return;
      await sleep(100);
    }
  }

  /**
   * Track M8: after a death (in a run, or after its end while the harness cleaned up) the respawn's return home starts once
   * the chunks are in, up to 10 s after the respawn: wait for it and stop it before the next run is set up.
   */
  let deathsSettled = 0;
  async function respawned(b: GauntBot): Promise<void> {
    const r = b.built.respawn!;
    if (!r.dead && r.deaths <= deathsSettled) return;
    await until(() => (!r.dead ? true : undefined), 30_000, 'respawned').catch(() => undefined);
    await until(() => ((b.task.processes?.find('home').length ?? 0) > 0 ? true : undefined), 12_000, 'the return home', 100).catch(() => undefined);
    await settle(b);
    deathsSettled = r.deaths;
  }

  /**
   * Track M9 (MOBS_TERRAIN): cover round the spot, from COVER_CLEAR to COVER_R out (the air over that square cleared first, so
   * no earlier run's cover stays), laid from a seed of the spot so the two sides of an A/B series see the same kind of ground:
   * `trees` a log column 4 high (a trunk; leaves are no cover for the line of sight) in about half of the 7 x 7 cells;
   * `walls` a cobblestone wall 3 high and 4 to 7 long, along x or z, in about half of the 9 x 9 cells.
   */
  async function layCover(b: GauntBot, c: Vec3, kind: string, seed: number): Promise<void> {
    const R = COVER_R;
    const x0 = Math.floor(c.x);
    const z0 = Math.floor(c.z);
    for (const [ax, bx] of [
      [-R, 0],
      [1, R],
    ] as const) {
      for (const [az, bz] of [
        [-R, 0],
        [1, R],
      ] as const) {
        await fill(b, { x: x0 + ax, y: FEET_Y, z: z0 + az }, { x: x0 + bx, y: FEET_Y + 5, z: z0 + bz }, 'air');
      }
    }
    if (kind === 'doors') {
      // Track M9 (`fleeDoors`): a roofless room of cobblestone 4 high, ROOM_HALF from the spot each way, with a closed fence
      // gate in the middle of each side (the gate at the feet, the cell over it open, the wall over that); neither a pillager
      // nor a skeleton opens a gate
      const H = ROOM_HALF;
      await fill(b, { x: x0 - H, y: FEET_Y, z: z0 - H }, { x: x0 + H, y: FEET_Y + 3, z: z0 + H }, 'cobblestone');
      await fill(b, { x: x0 - H + 1, y: FEET_Y, z: z0 - H + 1 }, { x: x0 + H - 1, y: FEET_Y + 3, z: z0 + H - 1 }, 'air');
      for (const [gx, gz, dir] of [
        [x0 + H, z0, 'east'],
        [x0 - H, z0, 'west'],
        [x0, z0 + H, 'south'],
        [x0, z0 - H, 'north'],
      ] as const) {
        await fill(b, { x: gx, y: FEET_Y + 1, z: gz }, { x: gx, y: FEET_Y + 1, z: gz }, 'air');
        for (let k = 0; ; k++) {
          const r = await b.truth.cmd('setblock', [gx, FEET_Y, gz, 'fence_gate', `minecraft:cardinal_direction=${dir}`], 30_000);
          if (r.ok) break;
          if (k >= 10) throw new Error(`truth:setblock fence_gate failed: ${r.reason}`);
          await sleep(500);
        }
      }
      return;
    }
    let s = seed >>> 0 || 1;
    const rnd = (): number => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const step = kind === 'walls' ? 9 : 7;
    let laid = 0;
    for (let gx = -R; gx + step <= R + 1; gx += step) {
      for (let gz = -R; gz + step <= R + 1; gz += step) {
        if (rnd() < 0.5) continue;
        const x = x0 + gx + Math.floor(rnd() * step);
        const z = z0 + gz + Math.floor(rnd() * step);
        if (Math.hypot(x + 0.5 - c.x, z + 0.5 - c.z) < COVER_CLEAR) continue;
        if (kind === 'walls') {
          const len = 4 + Math.floor(rnd() * 4);
          const alongX = rnd() < 0.5;
          const to = alongX ? { x: x + len - 1, z } : { x, z: z + len - 1 };
          if (Math.hypot(to.x + 0.5 - c.x, to.z + 0.5 - c.z) < COVER_CLEAR) continue;
          await fill(b, { x, y: FEET_Y, z }, { x: to.x, y: FEET_Y + 2, z: to.z }, 'cobblestone');
        } else {
          await fill(b, { x, y: FEET_Y, z }, { x, y: FEET_Y + 3, z }, 'oak_log');
        }
        laid++;
      }
    }
    if (laid === 0) throw new Error(`no cover laid (${kind})`);
  }

  async function freshSpot(b: GauntBot): Promise<Vec3> {
    const at = nextSpot();
    const c = centre(at);
    await respawned(b);
    await settle(b);
    await teleport(b, c);
    // repair the ground (a creeper may have cratered a neighbour spot, an earlier run's seal-in left its walls) and clear the
    // air; Track M5: the spot's cells are read back and a dirty one refused
    await cleanSpot(b, c, { r: 14, up: 6, entities: 40 });
    if (TERRAIN) await layCover(b, c, TERRAIN, (Math.floor(at.x) * 73856093) ^ (Math.floor(at.z) * 19349663) ^ (ROW * 83492791));
    b.task.home!.set(at);
    await b.truth.ok('cleareffects', [b.name]).catch(() => undefined); // a witch's poison from the cell before
    await b.truth.setFood(b.name, 20, 5);
    // the health (set again when it does not show: a set right after a hurt can be lost)
    for (let i = 0; ; i++) {
      await b.truth.setHealth(b.name, 20);
      const ok = await until(() => (b.pve.health() >= 19.9 ? true : undefined), 4_000, 'health 20').catch(() => undefined);
      if (ok) break;
      if (i >= 3) throw new Error(`health ${b.pve.health()} after 4 sets`);
    }
    await settle(b);
    return c;
  }

  async function runCell(b: GauntBot, kit: string, cell: Cell): Promise<CellResult> {
    const c = await freshSpot(b);
    b.pve.setGuard({ on: true, radius: 16 });
    const deaths0 = b.built.respawn!.deaths;
    const reflex0 = reflexHits(b);
    const potion0 = potionSteps(b);
    const floors0 = floorCounts(b);
    const fly0 = fleeFlyCounts(b);
    const rush0 = b.metrics.snapshot().counters['pve.witchRush'] ?? 0; // Track M7
    const cure0 = b.metrics.snapshot().counters['pve.cure'] ?? 0;
    const backHome0 = b.pve.backHomes; // Track M10
    const since = await b.truth.now();
    // the mine cell lays its sand first (a 2-deep line of 12 east of the bot)
    if (cell.activity === 'mine') await fill(b, { x: c.x - 0.5 + 2, y: FEET_Y - 1, z: c.z - 0.5 }, { x: c.x - 0.5 + 13, y: FEET_Y - 1, z: c.z - 0.5 }, 'sand');
    if (cell.activity === 'eat') await b.truth.setFood(b.name, 6, 0);
    if (cell.activity === 'landed') {
      // the bot drops in from 3 blocks up right as the mobs appear (the walk after a landing)
      await b.truth.tp(b.name, { x: c.x, y: FEET_Y + 3, z: c.z }, 0, 0);
    }
    // Track M10 (MOBS_START_OUT): the run starts out of the spot, home ahead
    const s0 = START_OUT ? { x: c.x + START_OUT, y: c.y, z: c.z } : c;
    if (START_OUT) {
      await teleport(b, s0);
      await settle(b);
    }
    // Track M8: the run starts from rest on its spot (the landed cell drops in from 3 up by design)
    const me0 = b.pve.position();
    const off0 = Math.hypot(me0.x - s0.x, me0.z - s0.z);
    const proc0 = b.task.processes?.active?.name;
    const notAtStart = off0 > 1 || proc0 !== undefined ? `not at rest at the start (${r1(off0)} from the spot${proc0 ? `, ${proc0} running` : ''})` : undefined;
    const ids: string[] = [];
    const n = cell.mobs.length;
    for (let i = 0; i < n; i++) {
      const m = cell.mobs[i]!;
      const a = (2 * Math.PI * i) / n + 0.4;
      const at = { x: s0.x + 7 * Math.cos(a), y: FEET_Y + (m.flying ? 10 : 0), z: s0.z + 7 * Math.sin(a) };
      const r = await b.truth.ok<{ entityId: string }>('summonx', [m.type, at.x.toFixed(2), at.y, at.z.toFixed(2), b.truth.runTag, m.event ?? '-']);
      ids.push(r.entityId);
      if (m.anger) await b.truth.ok('anger', [r.entityId, b.name]).catch(() => undefined);
    }
    const t0 = Date.now();
    // Track M9: the run's flee / guard / floor lines
    const lines: string[] = [];
    lineSink = (msg) => {
      if (lines.length < 300 && LINE_RE.test(msg)) lines.push(`${r1((Date.now() - t0) / 1000)} ${msg.slice(0, 220)}`);
    };
    // the trace: the bot's state every tick (kept 220 ticks), dumped on a death
    const ring: TraceRow[] = [];
    const loop = b.built.mobility!.loop as unknown as { onBeforeStep(fn: (t: bigint) => void): () => void };
    const offTrace = TRACE
      ? loop.onBeforeStep((tk) => {
          ring.push(traceRow(b, c, tk, t0));
          if (ring.length > (SEAL_TRACE || TRACE_ALL ? Math.max(2400, SECONDS * 20 + 400) : TRACE_TICKS + 20)) ring.shift();
        })
      : () => undefined;
    // Track M2: the witch's potions as the bot saw them: each splash potion's last place before it went, against the bot's feet
    const potionLast = new Map<bigint, { x: number; y: number; z: number; d: number }>();
    const potionEnds: number[] = [];
    const offPotions = loop.onBeforeStep(() => {
      const me = b.pve.position();
      const ents = b.built.mobility!.world.entities;
      for (const [rid, e] of ents) {
        if (!/splash_potion|lingering_potion/.test(e.type)) continue;
        potionLast.set(rid, { x: e.pos.x, y: e.pos.y, z: e.pos.z, d: Math.hypot(e.pos.x - me.x, e.pos.y - (me.y + 0.9), e.pos.z - me.z) });
      }
      for (const [rid, l] of potionLast) {
        if (ents.has(rid)) continue;
        potionEnds.push(r1(Math.hypot(l.x - me.x, l.y - (me.y + 0.9), l.z - me.z)));
        potionLast.delete(rid);
      }
    });
    let activityDone = 'none';
    let act: Promise<string> | undefined;
    if (cell.activity === 'goto') {
      const goal = { x: Math.floor(c.x) + 40, y: FEET_Y, z: Math.floor(c.z) };
      act = b.pve.walk({ type: 'block', p: goal }, {}, 'gauntlet walk').then((r) => (r.ok ? `arrived ${r1((Date.now() - t0) / 1000)} s` : `failed ${r.reason ?? '?'}`));
    } else if (cell.activity === 'mine') {
      const said0 = b.said.length;
      say(b, '!mine sand 12');
      const jobs = (): number => b.task.processes?.find('mine').length ?? 0;
      act = (async () => {
        await until(() => (jobs() > 0 ? true : undefined), 5_000, 'the mine job', 100).catch(() => undefined);
        await until(() => (jobs() === 0 ? true : undefined), SECONDS * 1000 + 60_000, 'the mine job end', 250).catch(() => undefined);
        const last = b.said.slice(said0).pop() ?? 'no reply';
        return `${jobs() === 0 ? 'ended' : 'still running'} after ${r1((Date.now() - t0) / 1000)} s (${last.slice(0, 80)})`;
      })();
    } else if (cell.activity === 'eat') {
      const kit0 = b.pve.kit?.();
      act = (async () => {
        let bites = 0;
        for (let i = 0; i < 8 && b.pve.food() < 20; i++) {
          const r = await kit0?.eat();
          if (r?.ok) bites++;
          await sleep(200);
        }
        return `food ${b.pve.food()} after ${bites} bites`;
      })();
    }
    let minHealth = 20;
    let clearS: number | null = null;
    let died = false;
    // the seal-in: when the flee process's episode is sealed, and when it is over
    let sealed: { tick: number; s: number; hp: number; max: number; dugIn: boolean; bites: number; build?: { placed: number; open: number; reason?: string; tries: number } } | undefined;
    let outAt: { tick: number; s: number } | undefined;
    interface SealEp {
      phase?: string;
      dugIn?: boolean;
      bites?: number;
      seal?: { placed: number; open: number; reason?: string; tries: number; openCells?: Vec3[] };
    }
    const fleeEp = (): SealEp | undefined => (b.task.processes?.find('flee')[0] as unknown as { ep?: SealEp } | undefined)?.ep;
    let cleared = false;
    // Track M9: the long case's samples
    const track: [number, number, number, string, number, number?, number?][] = [];
    let maxFromSpot = 0;
    let homeS: number | null = null;
    let wasOut = false;
    let nextSample = 0;
    const doorTrack: string[] = [];
    while (Date.now() - t0 < SECONDS * 1000) {
      minHealth = Math.min(minHealth, b.pve.health());
      {
        const me = b.pve.position();
        const from = Math.hypot(me.x - c.x, me.z - c.z);
        maxFromSpot = Math.max(maxFromSpot, from);
        if (from >= 20) wasOut = true;
        else if (wasOut && homeS === null && from <= 3) homeS = r1((Date.now() - t0) / 1000);
      }
      if (CLEAR_AT !== undefined && !cleared && Date.now() - t0 >= CLEAR_AT * 1000) {
        cleared = true;
        await b.truth.cleanup();
      }
      const ep = fleeEp();
      if (!sealed && ep?.phase === 'sealed') sealed = { tick: await b.truth.now(), s: r1((Date.now() - t0) / 1000), hp: r1(b.pve.health()), max: b.pve.health(), dugIn: ep.dugIn === true, bites: ep.bites ?? 0, build: ep.seal };
      if (sealed && !outAt) {
        if (ep?.phase === 'sealed') {
          sealed.max = Math.max(sealed.max, b.pve.health());
          sealed.bites = ep.bites ?? sealed.bites;
        } else outAt = { tick: await b.truth.now(), s: r1((Date.now() - t0) / 1000) };
      }
      if (b.built.respawn!.deaths > deaths0) {
        died = true;
        break;
      }
      const left = await Promise.all(ids.map((id) => b.truth.entity(id)));
      if (Date.now() - t0 >= nextSample) {
        nextSample += 5000;
        const me = b.pve.position();
        const live = left.filter((x) => x.valid !== false && (x.health ?? 1) > 0 && x.location);
        const near = live.reduce((m, x) => Math.min(m, Math.hypot(x.location.x - me.x, x.location.z - me.z)), Infinity);
        const nm = live.reduce<{ d: number; x?: { location: { x: number; z: number } } }>((m, x) => ((d) => (d < m.d ? { d, x } : m))(Math.hypot(x.location.x - me.x, x.location.z - me.z)), { d: Infinity });
        track.push([r1((Date.now() - t0) / 1000), r1(Math.hypot(me.x - c.x, me.z - c.z)), near === Infinity ? -1 : r1(near), b.task.processes?.active?.name ?? '-', r1(b.pve.health()), nm.x ? r1(Math.hypot(nm.x.location.x - c.x, nm.x.location.z - c.z)) : -1, b.pve.food()]);
        if (TERRAIN === 'doors') {
          // Track M9: the room's gates open and the mobs still inside it
          const x0 = Math.floor(c.x);
          const z0 = Math.floor(c.z);
          const gates = [
            [x0 + ROOM_HALF, z0],
            [x0 - ROOM_HALF, z0],
            [x0, z0 + ROOM_HALF],
            [x0, z0 - ROOM_HALF],
          ] as const;
          let open = 0;
          for (const [gx, gz] of gates) {
            const g = await b.truth.ok<{ states?: Record<string, unknown> }>('block', [gx, FEET_Y, gz]).catch(() => undefined);
            if (g?.states?.open_bit === true || g?.states?.open_bit === 1) open++;
          }
          const inside = live.filter((x) => Math.abs(x.location.x - c.x) < ROOM_HALF && Math.abs(x.location.z - c.z) < ROOM_HALF).length;
          doorTrack.push(`${r1((Date.now() - t0) / 1000)}:open ${open},inside ${inside}`);
        }
      }
      if (left.every((x) => x.valid === false || (x.health ?? 1) <= 0)) {
        clearS ??= r1((Date.now() - t0) / 1000);
        // sealed in: watch it come out; Track M7 (MOBS_POISON_WAIT): the witch's poison still on the bot takes the health on
        // down after the last mob died, so the run's lowest health is read until it ends (within MOBS_SECONDS)
        if (!act && !(sealed && !outAt) && !(POISON_WAIT && poisoned(b)) && !(HOME_WAIT && wasOut && homeS === null)) break;
      }
      if (act && clearS !== null) {
        const done = await Promise.race([act, sleep(100).then(() => undefined)]);
        if (done !== undefined) break;
      }
      await sleep(400);
    }
    offTrace();
    offPotions();
    lineSink = undefined;
    const seconds = r1((Date.now() - t0) / 1000);
    const meEnd = b.pve.position();
    const endFromSpot = r1(Math.hypot(meEnd.x - c.x, meEnd.z - c.z));
    const poisonLeft = poisonLeftS(b); // Track M7
    const endHealth = r1(b.pve.health());
    if (act) activityDone = (await Promise.race([act, sleep(30_000).then(() => 'still running')])) ?? 'none';
    const states = await Promise.all(ids.map((id) => b.truth.entity(id)));
    const left = states.filter((x) => x.valid !== false && (x.health ?? 1) > 0).length;
    const hurt: HurtRecord[] = (await b.truth.hurtlog(since)).events;
    const mine = hurt.filter((h) => h.victimName === b.name);
    const damage = r1(mine.reduce((s, h) => s + h.damage, 0));
    const hitsByType: Record<string, number> = {};
    const damageByType: Record<string, number> = {};
    const damageByCause: Record<string, number> = {};
    for (const h of mine) {
      const k = (h.damagerType ?? h.cause).replace('minecraft:', '');
      hitsByType[k] = (hitsByType[k] ?? 0) + 1;
      damageByType[k] = r1((damageByType[k] ?? 0) + h.damage);
      damageByCause[h.cause] = r1((damageByCause[h.cause] ?? 0) + h.damage);
    }
    // Track M5: a death no mob caused, or any damage from blocks, is the harness's (the spot was not clean), not the row's
    const deathCauses = b.built.respawn!.history.filter((d) => d.n > deaths0).map((d) => d.cause);
    const notMob = died ? harnessDeaths(b, deaths0, hurt) : [];
    const fromBlocks = blockDamage(hurt, b.name);
    const harness = notAtStart ?? (notMob.length ? `died of ${notMob.join(', ')}` : fromBlocks > 0 ? `${fromBlocks} damage from blocks` : undefined);
    const sealTried = (floorCounts(b).seal ?? 0) > (floors0.seal ?? 0);
    if ((died || TRACE_ALL || (SEAL_TRACE && sealTried)) && TRACE) {
      const lastTick = mine.length ? Math.max(...mine.map((h) => h.tick)) : 0;
      const hits = mine.filter((h) => h.tick >= lastTick - (SEAL_TRACE || TRACE_ALL ? 2400 : TRACE_TICKS)).map((h) => ({ tick: h.tick - lastTick, damage: h.damage, cause: h.cause, by: (h.damagerType ?? '-').replace('minecraft:', ''), after: h.healthAfter }));
      const byBot = hurt.filter((h) => h.damagerName === b.name && h.tick >= lastTick - 200).map((h) => ({ tick: h.tick - lastTick, victim: h.victimType.replace('minecraft:', ''), damage: h.damage }));
      appendFileSync(TRACE, `${JSON.stringify({ label: LABEL, ab: AB ? `${AB}=${String(b.pve.settings.get(AB as never))}` : AB_RULE ? `${AB_RULE}=${(b.pve.rules as unknown as Record<string, boolean>)[AB_RULE.split(',')[0]!.trim()] ? 'on' : 'off'}` : undefined, kit, cell: cell.name, died, since, rows: ring, hits, byBot, allHits: SEAL_TRACE || TRACE_ALL ? mine.map((h) => ({ tick: h.tick - since, damage: h.damage, cause: h.cause, by: (h.damagerType ?? '-').replace('minecraft:', '') })) : undefined })}\n`, 'utf8');
    }
    // friendly fire: any hit by the bot on something it did not summon as a hostile
    // (a hostile the cell did not summon, a phantom spawned by the night, is not friendly fire)
    const friendlyHits = hurt.filter((h) => h.damagerName === b.name && !ids.includes(h.victimId) && !HOSTILE_RE.test(h.victimType));
    const friendly = friendlyHits.length;
    const friendlyOn: Record<string, number> = {};
    for (const h of friendlyHits) friendlyOn[`${h.victimType.replace('minecraft:', '')}${h.victimName ? ` "${h.victimName}"` : ''}`] = (friendlyOn[`${h.victimType.replace('minecraft:', '')}${h.victimName ? ` "${h.victimName}"` : ''}`] ?? 0) + 1;
    const res: CellResult = {
      label: LABEL,
      ...(server ? { server } : {}),
      kit,
      cell: cell.name,
      activity: cell.activity,
      hard: HARD,
      time: TIME,
      seconds,
      died,
      ...(deathCauses.length ? { deathCauses } : {}),
      ...(harness ? { harness } : {}),
      damage,
      perMinute: r1((damage * 60) / Math.max(1, seconds)),
      hitsByType,
      damageByType,
      damageByCause,
      cleared: left === 0,
      clearS,
      left,
      minHealth: r1(minHealth),
      ...(poisonLeft > 0 ? { poisonLeftS: poisonLeft } : {}),
      endHealth,
      rushes: (b.metrics.snapshot().counters['pve.witchRush'] ?? 0) - rush0,
      cures: (b.metrics.snapshot().counters['pve.cure'] ?? 0) - cure0,
      reflexHits: reflexHits(b) - reflex0,
      potionSteps: potionSteps(b) - potion0,
      potions: potionEnds.length,
      potionsNear: potionEnds.filter((d) => d <= 4).length,
      potionEnds,
      floors: diffCounts(floorCounts(b), floors0),
      endFromSpot,
      maxFromSpot: r1(maxFromSpot),
      homeS,
      ...(b.pve.backHomes > backHome0 ? { backHomes: b.pve.backHomes - backHome0 } : {}),
      lastHitS: mine.length ? r1((Math.max(...mine.map((h) => h.tick)) - since) / 20) : null,
      track,
      lines,
      ...(TERRAIN ? { terrain: TERRAIN } : {}),
      ...(doorTrack.length ? { doors: doorTrack } : {}),
      activityDone,
      friendly,
      ...(friendly ? { friendlyOn } : {}),
      ...(sealed
        ? {
            seal: {
              sealedS: sealed.s,
              outS: outAt?.s ?? null,
              damageInside: r1(mine.filter((h) => h.tick >= sealed.tick && (!outAt || h.tick <= outAt.tick)).reduce((s2, h) => s2 + h.damage, 0)),
              healthIn: sealed.hp,
              healthMax: r1(sealed.max),
              bites: sealed.bites,
              dugIn: sealed.dugIn,
              build: sealed.build ?? null,
            },
          }
        : {}),
    };
    // Track M3: the elytra flee of this cell (asked, how it ended), and a flight still in the air brought down before the next
    const fly1 = fleeFlyCounts(b);
    const asked = (floorCounts(b).fly ?? 0) - (floors0.fly ?? 0);
    if (asked > 0 || fly1.landed + fly1.ended + fly1.refused > fly0.landed + fly0.ended + fly0.refused) {
      const me = b.pve.position();
      res.fleeFly = { asked, landed: fly1.landed - fly0.landed, ended: fly1.ended - fly0.ended, refused: fly1.refused - fly0.refused, last: b.pve.lastFleeFlight?.line ?? null, fromSpot: r1(Math.hypot(me.x - c.x, me.z - c.z)) };
    }
    b.pve.setGuard({ on: false });
    const control = flyControlOf(b.task);
    if (control && (control.fleeing() || control.controller.active)) {
      control.cancelFlee();
      control.supersede();
      if (control.controller.active) control.controller.landNow('stopped');
      await until(() => (!control.controller.active && !control.fleeing() ? true : undefined), 60_000, 'the flight down').catch(() => undefined);
    }
    b.pve.stop();
    await b.truth.cleanup();
    await sleep(500);
    await respawned(b);
    return res;
  }

  const fmtRow = (r: CellResult): string =>
    `${r.label}${r.ab ? ` [${r.ab}]` : ''}${r.rep !== undefined && REPEAT > 1 ? ` #${r.rep + 1}` : ''} ${r.kit} ${r.cell}${r.hard ? ' (hard)' : ''}${r.time === 'noon' ? ' (day)' : ''}: ${r.harness ? `HARNESS FAILURE (${r.harness}), not counted; ` : ''}${r.died ? `DIED${r.deathCauses?.length ? ` (${r.deathCauses.join(', ')})` : ''}` : 'alive'} after ${r.seconds} s, damage ${r.damage} (${r.perMinute}/min, lowest ${r.minHealth}), hits ${Object.entries(r.hitsByType).map(([k, v]) => `${k} ${v}`).join(' ') || 'none'}, ${r.cleared ? `cleared in ${r.clearS} s` : `${r.left} left`}${r.poisonLeftS ? `, poisoned ${r.poisonLeftS} s more at the end (health ${r.endHealth})` : ''}${r.rushes ? `, rushes ${r.rushes}` : ''}${r.cures ? `, milk ${r.cures}` : ''}, reflex ${r.reflexHits}${r.potions ? `, potions ${r.potionsNear}/${r.potions} near (steps ${r.potionSteps})` : ''}, floors ${Object.entries(r.floors).map(([k, v]) => `${k} ${v}`).join(' ') || 'none'}${r.endFromSpot !== undefined ? `, end ${r.endFromSpot} from the spot (at most ${r.maxFromSpot})${r.homeS != null ? `, home again at ${r.homeS} s` : ''}${r.lastHitS != null ? `, last hit at ${r.lastHitS} s` : ''}` : ''}${r.activity !== 'idle' ? `, ${r.activity}: ${r.activityDone}` : ''}${r.friendly ? `, FRIENDLY ${r.friendly}` : ''}${r.seal ? `, sealed at ${r.seal.sealedS} s${r.seal.dugIn ? ' (dug in)' : ''} health ${r.seal.healthIn} -> ${r.seal.healthMax}, ${r.seal.bites} bites, ${r.seal.damageInside} damage inside, ${r.seal.outS !== null ? `out at ${r.seal.outS} s` : 'still in'}` : ''}${r.fleeFly ? `, elytra flee asked ${r.fleeFly.asked} (${r.fleeFly.landed} landed, ${r.fleeFly.ended} ended otherwise, ${r.fleeFly.refused} refused), ${r.fleeFly.fromSpot} from the spot at the end${r.fleeFly.last ? `: ${r.fleeFly.last.slice(0, 160)}` : ''}` : ''}`;

  beforeAll(async () => {
    await prepareServer({ time: TIME });
    if (HARD) await gauntCmd('difficulty', 'hard');
    bot = await startGauntBot('GtMobs', {}, { owners: [ownerName], values: { guard: '16' }, onLine: (_scope, msg) => lineSink?.(msg) });
    const sv = await serverBuild(GAUNT_CONTAINER);
    server = `${sv.container} ${sv.build} (pong ${bot.conn.gameVersion})`;
    console.log(`gauntlet server: ${server}, image ${sv.image}`);
    for (const kv of SETTINGS) {
      const [k, v] = kv.split('=');
      if (k && v !== undefined) bot.pve.settings.set(k as never, v);
    }
    for (const kv of RULES) {
      const [k, v] = kv.split('=');
      if (k && k in bot.pve.rules) (bot.pve.rules as unknown as Record<string, boolean>)[k] = v !== 'false';
    }
    await teleport(bot, centre({ x: area.x - 1000, y: FEET_Y, z: area.z - 1000 }));
  }, 120_000);

  afterAll(async () => {
    if (HARD) await gauntCmd('difficulty', 'normal').catch(() => undefined);
    if (bot) {
      bot.pve.setGuard({ on: false });
      bot.pve.stop();
      await bot.truth.cleanup().catch(() => undefined);
      await bot.stop();
    }
    console.log(`gauntlet:\n  ${results.map(fmtRow).join('\n  ')}`);
    console.log(`gauntlet harness failures: ${harnessRuns.length}${harnessRuns.length ? `\n  ${harnessRuns.map(fmtRow).join('\n  ')}` : ''}`);
  });

  for (const kit of KITS) {
    it(`kit ${kit}: ${cells().length} cells`, async () => {
      const b = bot!;
      let ran = 0;
      const sides = AB || AB_RULE ? 2 : 1;
      for (const cell of cells()) {
        for (let rep = 0; rep < REPEAT * sides; rep++) {
          const side = AB || AB_RULE ? (rep % 2 === 0 ? 'off' : 'on') : undefined;
          if (AB) b.pve.settings.set(AB as never, side === 'on' ? 'true' : 'false');
          if (AB_RULE) for (const k of AB_RULE.split(',')) (b.pve.rules as unknown as Record<string, boolean>)[k.trim()] = side === 'on';
          // Track M5: a run the harness spoiled (a death no mob caused, damage from blocks) is written apart and run again
          for (let tries = 0; ; tries++) {
            await setKit(b, kit);
            const r = await runCell(b, kit, cell);
            if (side) r.ab = `${AB ?? AB_RULE}=${side}`;
            if (REPEAT > 1) r.rep = Math.floor(rep / sides);
            console.log(fmtRow(r));
            if (OUT) appendFileSync(OUT, `${JSON.stringify(r)}\n`, 'utf8');
            if (r.harness) harnessRuns.push(r);
            if (r.harness && tries < HARNESS_RETRIES) continue;
            results.push(r);
            break;
          }
          ran++;
        }
      }
      expect(ran).toBe(cells().length * REPEAT * sides);
    }, cells().length * REPEAT * (AB || AB_RULE ? 2 : 1) * (SECONDS + 90) * 1000);
  }

  it.skipIf(!NIGHT)('the idle night: dusk to dawn in the open, each kit', async () => {
    const b = bot!;
    for (const kit of KITS) {
      await setKit(b, kit);
      const c = await freshSpot(b);
      b.pve.setGuard({ on: true, radius: 16 });
      // Track K6: the Mending elytra (enchanted while held in hotbar slot 8, then moved to slot 20)
      let elytra0: number | undefined;
      if (NIGHT_MEND) {
        b.pve.hotbar.select(8);
        await b.built.mobility!.loop.waitTicks(4);
        await b.truth.ok('setslot', [b.name, 8, 'elytra', 1, 300]);
        await until(() => (b.built.mobility!.world.inventory.slots[8]?.name === 'elytra' ? true : undefined), 5000, 'the elytra in slot 8');
        await gauntCmd('enchant', b.name, 'mending', '1');
        await until(() => ((b.built.mobility!.world.inventory.slots[8]?.enchants ?? []).some((e) => e.id === 26) ? true : undefined), 5000, 'Mending on the elytra');
        b.pve.hotbar.select(0);
        await b.built.mobility!.loop.waitTicks(10);
        await survivalKitOf(b.task)!.moveSlot(8, 20);
        await until(() => (b.built.mobility!.world.inventory.slots[20]?.name === 'elytra' ? true : undefined), 5000, 'the elytra in slot 20');
        elytra0 = await elytraDamage(b);
        b.pve.settings.set('mendPost' as never, NIGHT_MEND === 'post' ? 'true' : 'false');
      }
      await gauntCmd('gamerule', 'domobspawning', 'true');
      await gauntCmd('gamerule', 'dodaylightcycle', 'true');
      await gauntCmd('time', 'set', '12500');
      const said0 = b.said.length;
      if (NIGHT_MEND === 'post') {
        // (the night process's clock must read night first: the post refuses `the time of day is not known`)
        await until(() => ((b.pve.timeOfDay() ?? 0) >= 12_000 ? true : undefined), 10_000, 'the night by the clock').catch(() => undefined);
        say(b, '!mend elytra 15');
      }
      const deaths0 = b.built.respawn!.deaths;
      const reflex0 = reflexHits(b);
      const floors0 = floorCounts(b);
      const since = await b.truth.now();
      const t0 = Date.now();
      let minHealth = 20;
      // Track M2: the trace of each death in the night (the last 400 ticks before it and the server's hits in them)
      const ring: TraceRow[] = [];
      const loop = b.built.mobility!.loop as unknown as { onBeforeStep(fn: (t: bigint) => void): () => void };
      let deathsSeen = deaths0;
      const offTrace = TRACE
        ? loop.onBeforeStep((tk) => {
            if (b.built.respawn!.deaths > deathsSeen || b.built.respawn!.dead) return; // keep the rows before the death
            ring.push(traceRow(b, c, tk, t0));
            if (ring.length > 400) ring.shift();
          })
        : () => undefined;
      for (;;) {
        await sleep(2000);
        if (TRACE && b.built.respawn!.deaths > deathsSeen) {
          deathsSeen = b.built.respawn!.deaths;
          const ev = (await b.truth.hurtlog(since)).events.filter((h) => h.victimName === b.name);
          const lastTick = ev.length ? Math.max(...ev.map((h) => h.tick)) : 0;
          const hits = ev.filter((h) => h.tick >= lastTick - 400).map((h) => ({ tick: h.tick - lastTick, damage: h.damage, cause: h.cause, by: (h.damagerType ?? '-').replace('minecraft:', ''), after: h.healthAfter }));
          appendFileSync(TRACE, `${JSON.stringify({ label: LABEL, night: kit, death: deathsSeen - deaths0, rows: ring.splice(0), hits })}
`, 'utf8');
          await until(() => (!b.built.respawn!.dead ? true : undefined), 30_000, 'respawned').catch(() => undefined);
        }
        minHealth = Math.min(minHealth, b.pve.health());
        const t = (await b.truth.time()).timeOfDay;
        if (t >= 23_500 || t < 12_000 || Date.now() - t0 > 15 * 60_000) break;
      }
      offTrace();
      await gauntCmd('gamerule', 'domobspawning', 'false');
      await gauntCmd('gamerule', 'dodaylightcycle', 'false');
      const hurt = (await b.truth.hurtlog(since)).events;
      const mine = hurt.filter((h) => h.victimName === b.name);
      const byType: Record<string, number> = {};
      for (const h of mine) byType[(h.damagerType ?? h.cause).replace('minecraft:', '')] = (byType[(h.damagerType ?? h.cause).replace('minecraft:', '')] ?? 0) + 1;
      const kills = hurt.filter((h) => h.damagerName === b.name && (h.healthAfter ?? 1) <= 0).length;
      const friendlyHits = hurt.filter((h) => h.damagerName === b.name && h.victimType && !HOSTILE_RE.test(h.victimType));
      const friendly = friendlyHits.length;
      const friendlyOn = [...new Set(friendlyHits.map((h) => `${h.victimType.replace('minecraft:', '')}${h.cause ? `/${h.cause}` : ''}`))].join(' ');
      let mendPart = '';
      if (NIGHT_MEND) {
        const e1 = await elytraDamage(b);
        const end = b.said.slice(said0).filter((s) => s.startsWith('mend: ') && /stopped|busy|nothing/.test(s)).pop() ?? 'no end line';
        mendPart = `, mend ${NIGHT_MEND}: elytra +${elytra0 !== undefined && e1 !== undefined ? elytra0 - e1 : '?'} uses (${elytra0 !== undefined ? 432 - elytra0 : '?'} -> ${e1 !== undefined ? 432 - e1 : '?'}), ${end.slice(0, 220)}`;
        say(b, '!mend stop');
      }
      const line = `${LABEL} night ${kit}: ${b.built.respawn!.deaths > deaths0 ? `DIED ${b.built.respawn!.deaths - deaths0}x` : 'alive'} after ${r1((Date.now() - t0) / 1000)} s, damage ${r1(mine.reduce((s, h) => s + h.damage, 0))}, lowest ${r1(minHealth)}, hits ${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(' ') || 'none'}, kills ${kills}, reflex ${reflexHits(b) - reflex0}, floors ${Object.entries(diffCounts(floorCounts(b), floors0)).map(([k, v]) => `${k} ${v}`).join(' ') || 'none'}${friendly ? `, FRIENDLY ${friendly} (${friendlyOn})` : ''}${mendPart}`;
      console.log(line);
      if (OUT) appendFileSync(OUT, `${JSON.stringify({ label: LABEL, night: kit, line })}\n`, 'utf8');
      b.pve.setGuard({ on: false });
      b.pve.stop();
      await b.truth.clearAround(c, 96);
      await gauntCmd('time', 'set', 'midnight');
      if (b.built.respawn!.dead) await until(() => (!b.built.respawn!.dead ? true : undefined), 30_000, 'respawned').catch(() => undefined);
    }
  }, Math.max(60, KITS.length * 17) * 60_000);
});

/** Track K6: the damage of the elytra carried (the server's truth), or undefined. */
async function elytraDamage(b: GauntBot): Promise<number | undefined> {
  const d = await b.truth.ok<{ slots: { slot: number; typeId: string; damage: number }[] }>('durability', [b.name]);
  return d.slots.find((s) => s.typeId.endsWith('elytra'))?.damage;
}

/** Track M7: the bot's own poison is still on (MobTracker.selfPoison). */
function poisoned(b: GauntBot): boolean {
  const p = (b.pve.mobs as unknown as { selfPoison?: { until: number } }).selfPoison;
  return p !== undefined && p.until > performance.now();
}

/** Track M7: seconds of the bot's poison left (0 with none). */
function poisonLeftS(b: GauntBot): number {
  const p = (b.pve.mobs as unknown as { selfPoison?: { until: number } }).selfPoison;
  return p ? Math.max(0, Math.round((p.until - performance.now()) / 100) / 10) : 0;
}

/** The reflex's hit count, when the controller has one (0 on the code before Track M1). */
function reflexHits(b: GauntBot): number {
  const r = (b.pve as unknown as { reflex?: { totals?: { hits?: number } } }).reflex;
  return r?.totals?.hits ?? 0;
}

/** The potion side steps so far (0 on code without them). */
function potionSteps(b: GauntBot): number {
  return (b.pve as unknown as { potionSteps?: number }).potionSteps ?? 0;
}

/** The floor counters (`pve.floor.*` metrics) and flights. */
/** Track M3: the elytra flees so far: landed, ended otherwise after a takeoff, refused before one (tasks/pve.ts flyNow's counters). */
function fleeFlyCounts(b: GauntBot): { landed: number; ended: number; refused: number } {
  const c = b.metrics.snapshot().counters;
  return { landed: c['pve.fleefly.landed'] ?? 0, ended: c['pve.fleefly.ended'] ?? 0, refused: c['pve.fleefly.refused'] ?? 0 };
}

function floorCounts(b: GauntBot): Record<string, number> {
  const c = b.metrics.snapshot().counters;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(c)) {
    if (k.startsWith('pve.floor.')) out[k.slice('pve.floor.'.length)] = v;
    if (k === 'pve.flees') out.flee = v;
  }
  return out;
}

function diffCounts(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(a)) if (v - (b[k] ?? 0) > 0) out[k] = v - (b[k] ?? 0);
  return out;
}
