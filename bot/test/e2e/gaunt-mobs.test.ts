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
// a shield, 16 cooked beef, 32 cobblestone; `kb2` the live kit with Knockback II on the sword.
// Cells (MOBS_CELLS: a comma list of names or prefixes, default all): `<mob>-1` one mob; `<mob>-2`, `<mob>-4` crowds of one
// type; `mixed-4`, `mixed-8`; `act-<activity>` a mixed crowd of 4 during goto / mine / eat / landed. MOBS_HARD=1 runs at hard.
// The idle night (MOBS_NIGHT=1): natural spawning and the daylight cycle on from dusk to dawn (12 000 ticks, about 10 min),
// the bot idle in the open at its home point, each kit once.
// Never asserts the bars (it is the measurement); asserts only that the harness itself worked (every cell ran). About
// 25 min a kit for the full set.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import type { Vec3 } from '../../src/connection/types.ts';
import { centre, E2E, FEET_Y, fill, gauntCmd, prepareServer, privateArea, sleep, startGauntBot, teleport, uniqueName, until, type GauntBot, type HurtRecord } from './gaunt-truth.ts';

const KITS = (process.env.MOBS_KITS ?? 'bare,live,kb2').split(',').map((s) => s.trim()).filter(Boolean);
const CELL_FILTER = (process.env.MOBS_CELLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const SECONDS = Number(process.env.MOBS_SECONDS ?? 60);
const CLEAR_AT = process.env.MOBS_CLEAR_AT ? Number(process.env.MOBS_CLEAR_AT) : undefined; // the cell's mobs removed at this second (the seal-in's way out)
const HARD = process.env.MOBS_HARD === '1';
const NIGHT = process.env.MOBS_NIGHT === '1';
const OUT = process.env.MOBS_OUT;
const LABEL = process.env.MOBS_LABEL ?? 'run';
const TRACE = process.env.MOBS_TRACE; // a JSON line per death: the last 10 s by tick (state) and the server's hurt log
const SEAL_TRACE = (process.env.MOBS_SET ?? '').includes('sealIn=true'); // keep 2 min of trace and dump it when a seal-in was tried
const SETTINGS = (process.env.MOBS_SET ?? '').split(',').map((s) => s.trim()).filter(Boolean); // key=value pairs applied at the start

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
  label: string;
  kit: string;
  cell: string;
  activity: string;
  hard: boolean;
  seconds: number;
  died: boolean;
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
  reflexHits: number;
  /** Side steps from a witch's potion in the run (tasks/pve.ts potionStep). */
  potionSteps: number;
  floors: Record<string, number>;
  activityDone: string;
  friendly: number;
  /** What the friendly hits were on (type x count). */
  friendlyOn?: Record<string, number>;
  /** The seal-in, when it went up: seconds from the start to sealed and to out, the damage and health inside, the bites. */
  seal?: { sealedS: number; outS: number | null; damageInside: number; healthIn: number; healthMax: number; bites: number; dugIn: boolean; build: { placed: number; open: number; reason?: string; tries: number } | null };
}

const r1 = (v: number): number => Math.round(v * 10) / 10;
const HOSTILE_RE = /zombie|skeleton|creeper|spider|phantom|witch|husk|drowned|stray|slime|enderman|pillager|bogged/;

describe.skipIf(!E2E)('gaunt: the mob gauntlet (Track M1)', () => {
  let bot: GauntBot | undefined;
  const ownerName = uniqueName('GmbOwner');
  const area = privateArea();
  const results: CellResult[] = [];
  let spot = 0;
  const nextSpot = (): Vec3 => {
    const i = spot++;
    // a line of spots 40 blocks apart (the ground at each is checked and repaired before use)
    return { x: area.x - 1000 + 40 * (i % 50), y: FEET_Y, z: area.z - 1000 + 40 * Math.floor(i / 50) };
  };

  const say = (b: GauntBot, body: string): void => {
    b.chat.handle({ type: 'chat', source: ownerName, xuid: '', message: body, body, truth: false });
  };

  async function setKit(b: GauntBot, kit: string): Promise<void> {
    const t = b.truth;
    await t.ok('clear', [b.name]);
    await t.ok('unequip', [b.name]);
    await gauntCmd('replaceitem', 'entity', b.name, 'slot.weapon.offhand', '0', 'air');
    if (kit === 'bare' || kit === 'blocks') {
      await t.give(b.name, 'bread', 8);
      if (kit === 'blocks') await t.give(b.name, 'cobblestone', 32); // the seal-in's kit: bare with blocks for the shell
      return;
    }
    if (kit === 'kb2') await t.ok('givekb', [b.name, 'netherite_sword', 2, 0]);
    else await t.give(b.name, 'netherite_sword', 1);
    for (const piece of ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots']) await t.give(b.name, piece, 1);
    await t.give(b.name, 'cooked_beef', 16);
    await t.give(b.name, 'cobblestone', 32);
    await t.give(b.name, 'shield', 1);
    await until(
      async () => {
        const eq = (await t.ok<{ equipment: Record<string, { typeId: string } | undefined> }>('durability', [b.name])).equipment;
        const st = await t.ok<{ offhand: { typeId: string } | null }>('stance', [b.name]);
        return eq.Head && eq.Chest && eq.Legs && eq.Feet && st.offhand?.typeId === 'minecraft:shield' ? true : undefined;
      },
      30_000,
      'netherite worn and the shield in the offhand',
      500,
    );
  }

  async function freshSpot(b: GauntBot): Promise<Vec3> {
    const at = nextSpot();
    const c = centre(at);
    await teleport(b, c);
    // repair the ground (a creeper may have cratered a neighbour spot) and clear the air
    await fill(b, { x: at.x - 14, y: FEET_Y - 3, z: at.z - 14 }, { x: at.x + 14, y: FEET_Y - 2, z: at.z + 14 }, 'dirt');
    await fill(b, { x: at.x - 14, y: FEET_Y - 1, z: at.z - 14 }, { x: at.x + 14, y: FEET_Y - 1, z: at.z + 14 }, 'grass_block');
    await fill(b, { x: at.x - 14, y: FEET_Y, z: at.z - 14 }, { x: at.x + 14, y: FEET_Y + 6, z: at.z + 14 }, 'air');
    await b.truth.clearAround(c, 40);
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
    return c;
  }

  async function runCell(b: GauntBot, kit: string, cell: Cell): Promise<CellResult> {
    const c = await freshSpot(b);
    b.pve.setGuard({ on: true, radius: 16 });
    const deaths0 = b.built.respawn!.deaths;
    const reflex0 = reflexHits(b);
    const potion0 = potionSteps(b);
    const floors0 = floorCounts(b);
    const since = await b.truth.now();
    // the mine cell lays its sand first (a 2-deep line of 12 east of the bot)
    if (cell.activity === 'mine') await fill(b, { x: c.x - 0.5 + 2, y: FEET_Y - 1, z: c.z - 0.5 }, { x: c.x - 0.5 + 13, y: FEET_Y - 1, z: c.z - 0.5 }, 'sand');
    if (cell.activity === 'eat') await b.truth.setFood(b.name, 6, 0);
    if (cell.activity === 'landed') {
      // the bot drops in from 3 blocks up right as the mobs appear (the walk after a landing)
      await b.truth.tp(b.name, { x: c.x, y: FEET_Y + 3, z: c.z }, 0, 0);
    }
    const ids: string[] = [];
    const n = cell.mobs.length;
    for (let i = 0; i < n; i++) {
      const m = cell.mobs[i]!;
      const a = (2 * Math.PI * i) / n + 0.4;
      const at = { x: c.x + 7 * Math.cos(a), y: FEET_Y + (m.flying ? 10 : 0), z: c.z + 7 * Math.sin(a) };
      const r = await b.truth.ok<{ entityId: string }>('summonx', [m.type, at.x.toFixed(2), at.y, at.z.toFixed(2), b.truth.runTag, m.event ?? '-']);
      ids.push(r.entityId);
      if (m.anger) await b.truth.ok('anger', [r.entityId, b.name]).catch(() => undefined);
    }
    const t0 = Date.now();
    // the trace: the bot's state every tick (kept 220 ticks), dumped on a death
    interface TraceRow { tick: number; ms: number; hp: number; shield: boolean; eating: boolean; proc: string; reflex: number; fight: string; x: number; y: number; z: number; near: string }
    const ring: TraceRow[] = [];
    const loop = b.built.mobility!.loop as unknown as { onBeforeStep(fn: (t: bigint) => void): () => void; command: { sneak?: boolean } };
    const offTrace = TRACE
      ? loop.onBeforeStep((tk) => {
          const me = b.pve.position();
          const near = [...b.built.mobility!.world.entities.values()]
            .filter((e) => ids.length && !e.type.includes('player') && !e.type.includes('item'))
            .map((e) => ({ t: e.type.replace('minecraft:', ''), d: Math.hypot(e.pos.x - me.x, e.pos.z - me.z) }))
            .filter((e) => e.d < 16)
            .sort((a, b2) => a.d - b2.d)
            .slice(0, 4)
            .map((e) => `${e.t}@${e.d.toFixed(1)}`)
            .join(' ');
          const kit = b.pve.kit?.() as { busy?: boolean } | undefined;
          ring.push({ tick: Number(tk), ms: Date.now() - t0, hp: r1(b.pve.health()), shield: loop.command.sneak === true, eating: kit?.busy === true, proc: b.task.processes?.active?.name ?? '-', reflex: reflexHits(b), fight: b.pve.combat.target?.type.replace('minecraft:', '') ?? '-', x: r1(me.x - c.x), y: Math.round((me.y - FEET_Y) * 100) / 100, z: r1(me.z - c.z), near });
          if (ring.length > (SEAL_TRACE ? 2400 : 220)) ring.shift();
        })
      : () => undefined;
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
    while (Date.now() - t0 < SECONDS * 1000) {
      minHealth = Math.min(minHealth, b.pve.health());
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
      if (left.every((x) => x.valid === false || (x.health ?? 1) <= 0)) {
        clearS ??= r1((Date.now() - t0) / 1000);
        if (!act && !(sealed && !outAt)) break; // sealed in: watch it come out
      }
      if (act && clearS !== null) {
        const done = await Promise.race([act, sleep(100).then(() => undefined)]);
        if (done !== undefined) break;
      }
      await sleep(400);
    }
    offTrace();
    const seconds = r1((Date.now() - t0) / 1000);
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
    const sealTried = (floorCounts(b).seal ?? 0) > (floors0.seal ?? 0);
    if ((died || (SEAL_TRACE && sealTried)) && TRACE) {
      const lastTick = mine.length ? Math.max(...mine.map((h) => h.tick)) : 0;
      const hits = mine.filter((h) => h.tick >= lastTick - (SEAL_TRACE ? 2400 : 200)).map((h) => ({ tick: h.tick - lastTick, damage: h.damage, cause: h.cause, by: (h.damagerType ?? '-').replace('minecraft:', ''), after: h.healthAfter }));
      const byBot = hurt.filter((h) => h.damagerName === b.name && h.tick >= lastTick - 200).map((h) => ({ tick: h.tick - lastTick, victim: h.victimType.replace('minecraft:', ''), damage: h.damage }));
      appendFileSync(TRACE, `${JSON.stringify({ label: LABEL, kit, cell: cell.name, died, since, rows: ring, hits, byBot, allHits: SEAL_TRACE ? mine.map((h) => ({ tick: h.tick - since, damage: h.damage, cause: h.cause, by: (h.damagerType ?? '-').replace('minecraft:', '') })) : undefined })}\n`, 'utf8');
    }
    // friendly fire: any hit by the bot on something it did not summon as a hostile
    // (a hostile the cell did not summon, a phantom spawned by the night, is not friendly fire)
    const friendlyHits = hurt.filter((h) => h.damagerName === b.name && !ids.includes(h.victimId) && !HOSTILE_RE.test(h.victimType));
    const friendly = friendlyHits.length;
    const friendlyOn: Record<string, number> = {};
    for (const h of friendlyHits) friendlyOn[`${h.victimType.replace('minecraft:', '')}${h.victimName ? ` "${h.victimName}"` : ''}`] = (friendlyOn[`${h.victimType.replace('minecraft:', '')}${h.victimName ? ` "${h.victimName}"` : ''}`] ?? 0) + 1;
    const res: CellResult = {
      label: LABEL,
      kit,
      cell: cell.name,
      activity: cell.activity,
      hard: HARD,
      seconds,
      died,
      damage,
      perMinute: r1((damage * 60) / Math.max(1, seconds)),
      hitsByType,
      damageByType,
      damageByCause,
      cleared: left === 0,
      clearS,
      left,
      minHealth: r1(minHealth),
      reflexHits: reflexHits(b) - reflex0,
      potionSteps: potionSteps(b) - potion0,
      floors: diffCounts(floorCounts(b), floors0),
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
    b.pve.setGuard({ on: false });
    b.pve.stop();
    await b.truth.cleanup();
    if (died) await until(() => (!b.built.respawn!.dead ? true : undefined), 30_000, 'respawned').catch(() => undefined);
    await sleep(500);
    return res;
  }

  const fmtRow = (r: CellResult): string =>
    `${r.label} ${r.kit} ${r.cell}${r.hard ? ' (hard)' : ''}: ${r.died ? 'DIED' : 'alive'} after ${r.seconds} s, damage ${r.damage} (${r.perMinute}/min, lowest ${r.minHealth}), hits ${Object.entries(r.hitsByType).map(([k, v]) => `${k} ${v}`).join(' ') || 'none'}, ${r.cleared ? `cleared in ${r.clearS} s` : `${r.left} left`}, reflex ${r.reflexHits}, floors ${Object.entries(r.floors).map(([k, v]) => `${k} ${v}`).join(' ') || 'none'}${r.activity !== 'idle' ? `, ${r.activity}: ${r.activityDone}` : ''}${r.friendly ? `, FRIENDLY ${r.friendly}` : ''}${r.seal ? `, sealed at ${r.seal.sealedS} s${r.seal.dugIn ? ' (dug in)' : ''} health ${r.seal.healthIn} -> ${r.seal.healthMax}, ${r.seal.bites} bites, ${r.seal.damageInside} damage inside, ${r.seal.outS !== null ? `out at ${r.seal.outS} s` : 'still in'}` : ''}`;

  beforeAll(async () => {
    await prepareServer({ time: 'midnight' });
    if (HARD) await gauntCmd('difficulty', 'hard');
    bot = await startGauntBot('GtMobs', {}, { owners: [ownerName], values: { guard: '16' } });
    for (const kv of SETTINGS) {
      const [k, v] = kv.split('=');
      if (k && v !== undefined) bot.pve.settings.set(k as never, v);
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
  });

  for (const kit of KITS) {
    it(`kit ${kit}: ${cells().length} cells`, async () => {
      const b = bot!;
      let ran = 0;
      for (const cell of cells()) {
        await setKit(b, kit);
        const r = await runCell(b, kit, cell);
        results.push(r);
        ran++;
        console.log(fmtRow(r));
        if (OUT) appendFileSync(OUT, `${JSON.stringify(r)}\n`, 'utf8');
      }
      expect(ran).toBe(cells().length);
    }, cells().length * (SECONDS + 90) * 1000);
  }

  it.skipIf(!NIGHT)('the idle night: dusk to dawn in the open, each kit', async () => {
    const b = bot!;
    for (const kit of KITS) {
      await setKit(b, kit);
      const c = await freshSpot(b);
      b.pve.setGuard({ on: true, radius: 16 });
      await gauntCmd('gamerule', 'domobspawning', 'true');
      await gauntCmd('gamerule', 'dodaylightcycle', 'true');
      await gauntCmd('time', 'set', '12500');
      const deaths0 = b.built.respawn!.deaths;
      const reflex0 = reflexHits(b);
      const floors0 = floorCounts(b);
      const since = await b.truth.now();
      const t0 = Date.now();
      let minHealth = 20;
      for (;;) {
        await sleep(2000);
        minHealth = Math.min(minHealth, b.pve.health());
        const t = (await b.truth.time()).timeOfDay;
        if (t >= 23_500 || t < 12_000 || Date.now() - t0 > 15 * 60_000) break;
      }
      await gauntCmd('gamerule', 'domobspawning', 'false');
      await gauntCmd('gamerule', 'dodaylightcycle', 'false');
      const hurt = (await b.truth.hurtlog(since)).events;
      const mine = hurt.filter((h) => h.victimName === b.name);
      const byType: Record<string, number> = {};
      for (const h of mine) byType[(h.damagerType ?? h.cause).replace('minecraft:', '')] = (byType[(h.damagerType ?? h.cause).replace('minecraft:', '')] ?? 0) + 1;
      const kills = hurt.filter((h) => h.damagerName === b.name && (h.healthAfter ?? 1) <= 0).length;
      const friendly = hurt.filter((h) => h.damagerName === b.name && h.victimType && !/zombie|skeleton|creeper|spider|phantom|witch|husk|drowned|stray|slime|enderman|pillager|bogged/.test(h.victimType)).length;
      const line = `${LABEL} night ${kit}: ${b.built.respawn!.deaths > deaths0 ? `DIED ${b.built.respawn!.deaths - deaths0}x` : 'alive'} after ${r1((Date.now() - t0) / 1000)} s, damage ${r1(mine.reduce((s, h) => s + h.damage, 0))}, lowest ${r1(minHealth)}, hits ${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(' ') || 'none'}, kills ${kills}, reflex ${reflexHits(b) - reflex0}, floors ${Object.entries(diffCounts(floorCounts(b), floors0)).map(([k, v]) => `${k} ${v}`).join(' ') || 'none'}${friendly ? `, FRIENDLY ${friendly}` : ''}`;
      console.log(line);
      if (OUT) appendFileSync(OUT, `${JSON.stringify({ label: LABEL, night: kit, line })}\n`, 'utf8');
      b.pve.setGuard({ on: false });
      b.pve.stop();
      await b.truth.clearAround(c, 96);
      await gauntCmd('time', 'set', 'midnight');
      if (b.built.respawn!.dead) await until(() => (!b.built.respawn!.dead ? true : undefined), 30_000, 'respawned').catch(() => undefined);
    }
  }, 60 * 60_000);
});

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
