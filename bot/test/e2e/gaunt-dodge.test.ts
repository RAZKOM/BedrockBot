// Track M2 (docs/pve.md "Track M2", ADR 0079 addendum): the dodge (skills/combat/dodge.ts, setting `mobDodge`) on real ground,
// so it can be judged for on by default for a bot with no blade. On bds-gaunt (flat world), each cell built with the truth
// pack's fill round a fresh spot (nothing of any real world): trees, a slope, a cliff edge, water, a lava pool, a cave mouth,
// a narrow ledge. The bot bare-handed (no weapon, no armour, 8 bread), guard on (radius 16), `mobDodge` on, one or two
// skeletons placed so that the way across their line runs into the cell's hazard. Each run DODGE_SECONDS (default 40).
// Per run: death, damage by cause, the ticks the dodge steered, every tick on the ground whose feet cell was not a known
// safe cell (dodge.ts safeCell on the bot's own map), falls that cost health, fire or lava, the ticks with the feet in
// water and whether the body was out of it at the end. One line per run and one JSON line per run to MOBS_OUT.
// Asserts (the bar): no death, no fall or burn damage, never into lava, out of any water by the end.
// Env: DODGE_CELLS (a comma list, default all), DODGE_RUNS (default 3), DODGE_SECONDS, MOBS_SET (key=value settings),
// MOBS_OUT, MOBS_LABEL. About 1 min a run.
// DODGE_KIT: `live` (the default: the hillside cells, a witch, a spider or a skeleton below or above a bot with the netherite
// kit; none written off as unreachable, no fall: ADR 0079 decision 20) or `bare` (the dodge's cells above: a measurement, its
// bar is not met yet, the falls at a cliff and a cave mouth, docs/pve.md "Track M2"; `mobDodge` ships off).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import type { Vec3 } from '../../src/connection/types.ts';
import { safeCell } from '../../src/skills/combat/dodge.ts';
import { gridOf } from '../../src/skills/combat/targeting.ts';
import { centre, E2E, FEET_Y, fill, gauntCmd, prepareServer, privateArea, sleep, startGauntBot, teleport, uniqueName, until, type GauntBot } from './gaunt-truth.ts';

/** Track M2: the kit, `bare` (the dodge's cells) or `live` (the hillside cells: a mob below the bot down the hill). */
const KIT = process.env.DODGE_KIT === 'bare' ? 'bare' : 'live';
const CELLS = (process.env.DODGE_CELLS ?? (KIT === 'live' ? 'slope-witch,steps-witch,steps-spider,steps-skeleton,ledge-witch,ledge-spider' : 'trees,slope,cliff,water,lava,cave,ledge')).split(',').map((s) => s.trim()).filter(Boolean);
const RUNS = Number(process.env.DODGE_RUNS ?? 3);
const SECONDS = Number(process.env.DODGE_SECONDS ?? 40);
const OUT = process.env.MOBS_OUT;
const LABEL = process.env.MOBS_LABEL ?? 'dodge';
const SETTINGS = (process.env.MOBS_SET ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const r1 = (v: number): number => Math.round(v * 10) / 10;

/** A cell: how it is built round the spot (integer feet cell `at` at FEET_Y) and where the bot and the shooters stand. */
interface DodgeCell {
  name: string;
  /** The bot's feet level above FEET_Y. */
  up: number;
  build(b: GauntBot, at: Vec3): Promise<void>;
  /** Shooter feet positions (relative x, absolute level offset, z). */
  shooters: { dx: number; up: number; dz: number; type?: string }[];
  /** The cell is for this kit only (DODGE_KIT); the default list leaves the other kit's cells out. */
  kit?: 'bare' | 'live';
}

const R = 16; // the cell's half-size
/** The ground falling 1 block a block towards -z from level 6 at the bot (steps), or 1 every 2 (a slope). */
async function hillside(b: GauntBot, at: Vec3, perBlock: 1 | 2): Promise<void> {
  for (let z = -R; z <= R; z++) {
    const top = Math.max(1, Math.min(12, 6 + Math.floor(z / perBlock)));
    await fillRel(b, at, -R, 0, z, R, top - 1, z, 'stone');
  }
}
/** The feet level above FEET_Y of a hillside cell's ground at relative z. */
const hillUp = (dz: number, perBlock: 1 | 2): number => Math.max(1, Math.min(12, 6 + Math.floor(dz / perBlock)));
const box = (at: Vec3, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => [{ x: at.x + x0, y: FEET_Y + y0, z: at.z + z0 }, { x: at.x + x1, y: FEET_Y + y1, z: at.z + z1 }] as const;
async function fillRel(b: GauntBot, at: Vec3, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, block: string): Promise<void> {
  const [a, c] = box(at, x0, y0, z0, x1, y1, z1);
  // the chunks round a spot the bot was just sent to load a moment later (unloaded_chunk): try again for up to 10 s
  for (let i = 0; ; i++) {
    try {
      await fill(b, a, c, block);
      return;
    } catch (e) {
      if (i >= 20 || !String(e).includes('unloaded_chunk')) throw e;
      await sleep(500);
    }
  }
}
/** A plateau of stone with its top (the floor) at `up - 1` over the whole cell. */
const plateau = (b: GauntBot, at: Vec3, up: number, x0 = -R, z0 = -R, x1 = R, z1 = R): Promise<void> => fillRel(b, at, x0, 0, z0, x1, up - 1, z1, 'stone');

const CELL_DEFS: Record<string, DodgeCell> = {
  // oak trees (a trunk 4 high and leaves round its top) every few blocks round the bot, the shooter 11 off
  trees: {
    name: 'trees',
    up: 0,
    build: async (b, at) => {
      for (const [dx, dz] of [[3, 3], [-3, 3], [3, -3], [-3, -3], [0, 5], [0, -5], [5, 0], [-5, 0], [7, 4], [-6, -7], [2, 8], [-2, -9]] as const) {
        await fillRel(b, at, dx - 1, 3, dz - 1, dx + 1, 4, dz + 1, 'oak_leaves');
        await fillRel(b, at, dx, 0, dz, dx, 3, dz, 'oak_log');
      }
    },
    shooters: [{ dx: 11, up: 0, dz: 0 }],
  },
  // the ground rising 1 block every 2 blocks towards +z and falling towards -z (a hillside), the shooter level with the bot
  slope: {
    name: 'slope',
    up: 6,
    build: async (b, at) => {
      for (let z = -R; z <= R; z++) {
        const top = Math.max(1, Math.min(12, 6 + Math.floor(z / 2)));
        await fillRel(b, at, -R, 0, z, R, top - 1, z, 'stone');
      }
    },
    shooters: [{ dx: 10, up: 6, dz: 0 }],
  },
  // Track M2 (the Realm's hillside, live kit): the mob below the bot down the hill: a witch, a spider, a skeleton, on a slope
  // (1 block every 2) and on steps (1 a block); the bot with a blade closes in (guard's first target for the witch)
  'slope-witch': { name: 'slope-witch', kit: 'live', up: 6, build: (b, at) => hillside(b, at, 2), shooters: [{ dx: 1, up: hillUp(-7, 2), dz: -7, type: 'witch' }] },
  'steps-witch': { name: 'steps-witch', kit: 'live', up: 6, build: (b, at) => hillside(b, at, 1), shooters: [{ dx: 1, up: hillUp(-6, 1), dz: -6, type: 'witch' }] },
  'steps-spider': { name: 'steps-spider', kit: 'live', up: 6, build: (b, at) => hillside(b, at, 1), shooters: [{ dx: 1, up: hillUp(-6, 1), dz: -6, type: 'spider' }, { dx: -2, up: hillUp(-5, 1), dz: -5, type: 'spider' }] },
  'steps-skeleton': { name: 'steps-skeleton', kit: 'live', up: 6, build: (b, at) => hillside(b, at, 1), shooters: [{ dx: 2, up: hillUp(-8, 1), dz: -8, type: 'skeleton' }, { dx: -3, up: hillUp(-7, 1), dz: -7, type: 'skeleton' }] },
  // the Realm's case: the bot on a ledge 5 high, 1 block from its edge, the witch at its foot 4 out; the way down is a stair
  // 8 to 10 blocks to the side (the walk there goes farther from her first)
  'ledge-witch': {
    name: 'ledge-witch',
    kit: 'live',
    up: 5,
    build: async (b, at) => {
      await plateau(b, at, 5, -R, -1, R, R);
      for (let k = 1; k <= 4; k++) await fillRel(b, at, 8, 0, -1 - k, 10, 4 - k, -1 - k, 'stone');
    },
    shooters: [{ dx: 0, up: 0, dz: -4, type: 'witch' }],
  },
  'ledge-spider': {
    name: 'ledge-spider',
    kit: 'live',
    up: 5,
    build: async (b, at) => {
      await plateau(b, at, 5, -R, -1, R, R);
      for (let k = 1; k <= 4; k++) await fillRel(b, at, 8, 0, -1 - k, 10, 4 - k, -1 - k, 'stone');
    },
    shooters: [{ dx: 0, up: 0, dz: -4, type: 'spider' }],
  },
  // the bot 3 blocks from the edge of an 8-high cliff (+z), the shooter on the top
  cliff: {
    name: 'cliff',
    up: 8,
    build: (b, at) => plateau(b, at, 8, -R, -R, R, 2),
    shooters: [{ dx: 10, up: 8, dz: 0 }],
  },
  // water 2 deep on both sides from 2 blocks out (the bot on a strip 3 wide along the line of fire)
  water: {
    name: 'water',
    up: 0,
    build: async (b, at) => {
      await fillRel(b, at, -R, -2, 2, R, -1, R, 'water');
      await fillRel(b, at, -R, -2, -R, R, -1, -2, 'water');
    },
    shooters: [{ dx: 11, up: 0, dz: 0 }],
  },
  // a lava pool 1 deep on both sides from 3 blocks out
  lava: {
    name: 'lava',
    up: 0,
    build: async (b, at) => {
      await fillRel(b, at, -R, -1, 3, R, -1, 10, 'lava');
      await fillRel(b, at, -R, -1, -10, R, -1, -3, 'lava');
    },
    shooters: [{ dx: 11, up: 0, dz: 0 }],
  },
  // a plateau 8 high with a shaft 4 wide and 7 deep 2 blocks from the bot (+z), roofed on its far half (a cave's mouth)
  cave: {
    name: 'cave',
    up: 8,
    build: async (b, at) => {
      await plateau(b, at, 8);
      await fillRel(b, at, -6, 1, 2, 6, 7, 5, 'air');
      await fillRel(b, at, -6, 1, 6, 6, 4, 10, 'air'); // the cave going in under the far side
    },
    shooters: [{ dx: 10, up: 8, dz: 0 }, { dx: 9, up: 8, dz: -6 }],
  },
  // a ledge 1 wide and 8 high along x (the line of fire), the shooter on a 3 x 3 pillar at its end
  ledge: {
    name: 'ledge',
    up: 8,
    build: async (b, at) => {
      await plateau(b, at, 8, -12, 0, 12, 0);
      await plateau(b, at, 8, 9, -1, 11, 1);
    },
    shooters: [{ dx: 10, up: 8, dz: 0 }],
  },
};

interface DodgeResult {
  label: string;
  cell: string;
  run: number;
  died: boolean;
  damage: number;
  damageByCause: Record<string, number>;
  dodgeTicks: number;
  /** Ticks on the ground with the feet on a cell that was not known safe (dodge.ts safeCell). */
  unsafeTicks: number;
  unsafeWhileDodging: number;
  fallDamage: number;
  burnDamage: number;
  waterTicks: number;
  inWaterAtEnd: boolean;
  lowestY: number;
  minHealth: number;
  floors: Record<string, number>;
  /** The cell's mobs still alive at the end, and when they were all dead (the live kit's cells). */
  left: number;
  clearS: number | null;
  lines: string[];
}

describe.skipIf(!E2E)('gaunt: the dodge on real ground (Track M2)', () => {
  let bot: GauntBot | undefined;
  const ownerName = uniqueName('GdgOwner');
  const area = privateArea();
  const results: DodgeResult[] = [];
  let spot = 0;
  const nextSpot = (): Vec3 => {
    const i = spot++;
    return { x: area.x - 900 + 48 * (i % 20), y: FEET_Y, z: area.z + 900 + 48 * Math.floor(i / 20) };
  };

  async function runCell(b: GauntBot, def: DodgeCell, run: number): Promise<DodgeResult> {
    let at = nextSpot();
    // a clean cell: dirt and grass to the flat level, air above, then the cell's own build. After a run that ended off a
    // plateau the server sometimes did not send the next spot's chunks (unloaded_chunk on the fill): a new spot, sent again
    for (let tries = 0; ; tries++) {
      try {
        b.pve.stop();
        // the bot waits on a glass block over the cell while it is built (it fell into the build and died in a wall once)
        await teleport(b, centre({ x: at.x, y: FEET_Y + 17, z: at.z }));
        await fillRel(b, at, 0, 16, 0, 0, 16, 0, 'glass');
        await teleport(b, centre({ x: at.x, y: FEET_Y + 17, z: at.z }));
        await fillRel(b, at, -R, -3, -R, R, -2, R, 'dirt');
        await fillRel(b, at, -R, -1, -R, R, -1, R, 'grass_block');
        await fillRel(b, at, -R, 0, -R, R, 14, R, 'air');
        await def.build(b, at);
        break;
      } catch (e) {
        if (tries >= 3 || !/unloaded_chunk|waiting for chunks/.test(String(e))) throw e;
        console.log(`${LABEL} dodge ${def.name} #${run}: the spot's chunks did not load (${String(e).slice(0, 120)}); another spot`);
        await sleep(3000);
        at = nextSpot();
      }
    }
    const c = centre({ x: at.x, y: FEET_Y + def.up, z: at.z });
    await teleport(b, c);
    await fillRel(b, at, 0, 16, 0, 0, 16, 0, 'air');
    await b.truth.clearAround(c, 40);
    b.task.home!.set({ x: at.x, y: FEET_Y + def.up, z: at.z });
    await b.truth.ok('cleareffects', [b.name]).catch(() => undefined);
    await b.truth.setFood(b.name, 20, 5);
    for (let i = 0; ; i++) {
      await b.truth.setHealth(b.name, 20);
      if (await until(() => (b.pve.health() >= 19.9 ? true : undefined), 4_000, 'health 20').catch(() => undefined)) break;
      if (i >= 3) throw new Error(`health ${b.pve.health()} after 4 sets`);
    }
    await sleep(1500); // the bot's map has the cell
    b.pve.setGuard({ on: true, radius: 16 });
    const deaths0 = b.built.respawn!.deaths;
    const floors0 = floorCounts(b);
    const since = await b.truth.now();
    const ids: string[] = [];
    for (const s of def.shooters) {
      const m = await b.truth.ok<{ entityId?: string }>('summonx', [s.type ?? 'skeleton', (at.x + 0.5 + s.dx).toFixed(2), FEET_Y + s.up, (at.z + 0.5 + s.dz).toFixed(2), b.truth.runTag, '-']);
      if (m.entityId) ids.push(m.entityId);
    }
    // Track M2: guard's verdicts on the cell's mobs (an `unreachable` that wrote a witch off on the Realm's hillside)
    const verdicts = new Map<string, string>();
    b.pve.ignore.clear();
    b.pve.ignoreWhy.clear();
    const bareName = (t: string | undefined): string => (t ?? '?').replace('minecraft:', '');
    const loop = b.built.mobility!.loop as unknown as { onBeforeStep(fn: () => void): () => void; state: { onGround: boolean } };
    let dodgeTicks = 0;
    let unsafeTicks = 0;
    let unsafeWhileDodging = 0;
    let waterTicks = 0;
    let lowestY = Infinity;
    const lines: string[] = [];
    // a drop of 2 or more: where the body left the ground, what had it then (the process and the flee's phase), how far it fell
    let lastGround: { y: number; x: number; z: number; what: string } | undefined;
    let wasOnGround = true;
    const off = loop.onBeforeStep(() => {
      if (b.built.respawn!.dead) return;
      const me = b.pve.position();
      lowestY = Math.min(lowestY, me.y - FEET_Y);
      const flee = b.task.processes?.find('flee')[0] as unknown as { ep?: { phase?: string } } | undefined;
      const dodging = flee?.ep?.phase === 'dodge';
      const what = `${b.task.processes?.active?.name ?? '-'}/${flee?.ep?.phase ?? '-'}`;
      if (loop.state.onGround) {
        if (!wasOnGround && lastGround && lastGround.y - me.y >= 2) lines.push(`drop ${r1(lastGround.y - me.y)} from ${r1(lastGround.x - at.x - 0.5)} ${r1(lastGround.y - FEET_Y)} ${r1(lastGround.z - at.z - 0.5)} (${lastGround.what})`);
        lastGround = { y: me.y, x: me.x, z: me.z, what };
      }
      wasOnGround = loop.state.onGround;
      for (const [rid, note] of b.pve.ignoreWhy) {
        const key = `${bareName(note.type)} #${rid}`;
        if (!verdicts.has(key)) verdicts.set(key, `${note.reason} at ${r1((Date.now() - t0) / 1000)} s`);
      }
      if (dodging) dodgeTicks++;
      const g = gridOf(b.pve.mover);
      const y = Math.floor(me.y + 1e-3);
      const feet = g?.cls(Math.floor(me.x), y, Math.floor(me.z));
      if (feet?.liquid) waterTicks++;
      if (loop.state.onGround && g && !safeCell(g, me.x, y, me.z)) {
        // the body's box can stand on the next cell's edge: unsafe only when no cell under any corner of the box is safe
        const corners = [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]].some(([ox, oz]) => safeCell(g, me.x + ox!, y, me.z + oz!));
        if (!corners) {
          unsafeTicks++;
          if (dodging) unsafeWhileDodging++;
          if (unsafeTicks <= 3) lines.push(`unsafe at ${r1(me.x - at.x - 0.5)} ${r1(me.y - FEET_Y)} ${r1(me.z - at.z - 0.5)}${dodging ? ' (dodging)' : ''}`);
        }
      }
    });
    const t0 = Date.now();
    let minHealth = 20;
    let died = false;
    const alive = async (): Promise<number> => (await Promise.all(ids.map((id) => b.truth.entity(id)))).filter((x) => x.valid !== false && (x.health ?? 1) > 0).length;
    let clearS: number | null = null;
    let n = 0;
    while (Date.now() - t0 < SECONDS * 1000) {
      minHealth = Math.min(minHealth, b.pve.health());
      if (b.built.respawn!.deaths > deaths0) {
        died = true;
        break;
      }
      // the live kit's cells end when its mobs are dead (the time to clear); the dodge's run the whole time
      if (def.kit === 'live' && ++n % 8 === 0 && (await alive()) === 0) {
        clearS = r1((Date.now() - t0) / 1000);
        break;
      }
      await sleep(250);
    }
    off();
    const left = await alive();
    for (const [k, v] of verdicts) lines.push(`${k} ${v}`);
    const me = b.pve.position();
    const g = gridOf(b.pve.mover);
    const inWaterAtEnd = !died && (g?.cls(Math.floor(me.x), Math.floor(me.y + 1e-3), Math.floor(me.z))?.liquid ? true : false);
    const hurt = (await b.truth.hurtlog(since)).events.filter((h) => h.victimName === b.name);
    const damageByCause: Record<string, number> = {};
    for (const h of hurt) damageByCause[h.cause] = r1((damageByCause[h.cause] ?? 0) + h.damage);
    const sumOf = (re: RegExp): number => r1(hurt.filter((h) => re.test(h.cause)).reduce((s, h) => s + h.damage, 0));
    const res: DodgeResult = {
      label: LABEL,
      cell: def.name,
      run,
      died,
      damage: r1(hurt.reduce((s, h) => s + h.damage, 0)),
      damageByCause,
      dodgeTicks,
      unsafeTicks,
      unsafeWhileDodging,
      fallDamage: sumOf(/fall/i),
      burnDamage: sumOf(/fire|lava|magma/i),
      waterTicks,
      inWaterAtEnd,
      lowestY: r1(lowestY),
      minHealth: r1(minHealth),
      floors: diffCounts(floorCounts(b), floors0),
      left,
      clearS,
      lines,
    };
    b.pve.setGuard({ on: false });
    b.pve.stop();
    await b.truth.cleanup();
    if (died) await until(() => (!b.built.respawn!.dead ? true : undefined), 30_000, 'respawned').catch(() => undefined);
    // take the cell down (the next spot is 48 off; a lava pool left would burn the area)
    await fillRel(b, at, -R, -3, -R, R, -2, R, 'dirt');
    await fillRel(b, at, -R, -1, -R, R, -1, R, 'grass_block');
    await fillRel(b, at, -R, 0, -R, R, 16, R, 'air');
    await sleep(300);
    return res;
  }

  const fmt = (r: DodgeResult): string =>
    `${r.label} dodge ${r.cell} #${r.run}: ${r.died ? 'DIED' : 'alive'}, damage ${r.damage} (${Object.entries(r.damageByCause).map(([k, v]) => `${k} ${v}`).join(' ') || 'none'}), lowest ${r.minHealth}, dodge ${r.dodgeTicks} ticks, unsafe ${r.unsafeTicks} (${r.unsafeWhileDodging} dodging), fall ${r.fallDamage}, burn ${r.burnDamage}, water ${r.waterTicks} ticks${r.inWaterAtEnd ? ' (STILL IN)' : ''}, lowest y ${r.lowestY}, ${r.clearS !== null ? `cleared in ${r.clearS} s` : `${r.left} left`}, floors ${Object.entries(r.floors).map(([k, v]) => `${k} ${v}`).join(' ') || 'none'}${r.lines.length ? `; ${r.lines.join('; ')}` : ''}`;

  beforeAll(async () => {
    await prepareServer({ time: 'midnight' });
    bot = await startGauntBot('GtDodge', {}, { owners: [ownerName], values: { guard: '16' } });
    bot.pve.settings.set('mobDodge', true);
    for (const kv of SETTINGS) {
      const [k, v] = kv.split('=');
      if (k && v !== undefined) bot.pve.settings.set(k as never, v);
    }
    const t = bot.truth;
    await t.ok('clear', [bot.name]);
    await t.ok('unequip', [bot.name]);
    await gauntCmd('replaceitem', 'entity', bot.name, 'slot.weapon.offhand', '0', 'air');
    if (KIT === 'live') {
      // the live kit (as the gauntlet's): a netherite sword and armour, a shield, food and blocks
      await t.give(bot.name, 'netherite_sword', 1);
      for (const piece of ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots']) await t.give(bot.name, piece, 1);
      await t.give(bot.name, 'cooked_beef', 16);
      await t.give(bot.name, 'cobblestone', 32);
      await t.give(bot.name, 'shield', 1);
      await until(
        async () => {
          const eq = (await t.ok<{ equipment: Record<string, { typeId: string } | undefined> }>('durability', [bot!.name])).equipment;
          const st = await t.ok<{ offhand: { typeId: string } | null }>('stance', [bot!.name]);
          return eq.Head && eq.Chest && eq.Legs && eq.Feet && st.offhand?.typeId === 'minecraft:shield' ? true : undefined;
        },
        30_000,
        'netherite worn and the shield in the offhand',
        500,
      );
    } else await t.give(bot.name, 'bread', 8);
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      bot.pve.setGuard({ on: false });
      bot.pve.stop();
      await bot.truth.cleanup().catch(() => undefined);
      await bot.stop();
    }
    console.log(`dodge on real ground:\n  ${results.map(fmt).join('\n  ')}`);
  });

  for (const name of CELLS) {
    const def = CELL_DEFS[name];
    if (!def || (def.kit ?? 'bare') !== KIT) continue;
    it(`cell ${name}: ${RUNS} runs`, async () => {
      const b = bot!;
      for (let run = 1; run <= RUNS; run++) {
        const r = await runCell(b, def, run);
        results.push(r);
        console.log(fmt(r));
        if (OUT) appendFileSync(OUT, `${JSON.stringify(r)}\n`, 'utf8');
      }
      const mine = results.filter((r) => r.cell === name);
      expect(mine.filter((r) => r.died)).toEqual([]);
      expect(mine.reduce((s, r) => s + r.fallDamage + r.burnDamage, 0)).toBe(0);
      expect(mine.filter((r) => r.inWaterAtEnd)).toEqual([]);
      // the live kit's hillside: every mob below the bot dealt with, none written off as unreachable
      if (def.kit === 'live') {
        expect(mine.map((r) => r.left)).toEqual(mine.map(() => 0));
        expect(mine.flatMap((r) => r.lines.filter((l) => l.includes('unreachable')))).toEqual([]);
      }
    }, RUNS * (SECONDS + 60) * 1000);
  }
});

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
