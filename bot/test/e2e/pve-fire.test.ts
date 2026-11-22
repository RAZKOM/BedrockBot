// e2e (tag @bds), Track M11 (docs/survival.md "The fire escape (Track M11)", ADR 0126): the fire escape against built
// scenes, the bot's own rules, on a test server with the Nether (bds-pve: NETHER_BDS_PORT=19144
// NETHER_BDS_CONTAINER=bds-pve; nether-truth.ts). Difficulty normal, the clock frozen at noon, no natural spawns, fire
// spreading (doFireTick as the server has it: on), fire and fall damage on, keepInventory on. One afk-task bot; each run
// lays its scene, stands the bot in it at full health and food, sets the fire last and watches FIRE_SECONDS (45): the
// run ends at a death, or once the body has been out of every fire and lava cell and not burning for 3 s.
//   ledge  Track N2's death (the Nether): a netherrack ledge 3 over the floor along a cliff, fire in the bot's cell and in
//          both ledge cells beside it (fire on netherrack never goes out), a rail in front of it and, under the rail,
//          a closed pocket 2 down: the nearest cell clear of fire, which no walk reaches. The ledge goes on beyond the
//          fire both ways.
//   wood   an overworld fire on a wooden floor: 7 x 7 oak planks in the grass, fire on the 5 x 5 round the bot (it
//          spreads over the planks and burns them away)
//   lava   lava's fire next to the bot: a lava pool beside it (west), planks under the bot and east of it with fire on
//          them in the bot's cell and the cells north, south and east (a burnt plank opens a hole the lava flows into)
//   pit    the last resorts: lava in the feet cell of a 1 x 1 pit with cobblestone walls 3 high (no way out within the
//          escape's levels, nothing a strike puts out): with FIRE_POTION=1 the potion, else the pillar (not in the
//          default set: FIRE_CASE=pit)
//   probe  (a measurement, not a case) what Bedrock lets a player do about the fire in its own cell: strike the fire
//          block, strike the floor under it (its top face), place a block into it, pillar up out of it
// Per run: deaths, the damage the server dealt by cause (truth:hurtlog), the lowest health, the seconds the body burned
// (the server's `onfire` flag on the bot), the seconds until it stood out of fire, the escapes, the process lines.
// Env: FIRE_CASE (ledge,wood,lava; pit, probe), FIRE_N runs a case (default 1), FIRE_ARM a label (before | after),
// FIRE_SECONDS (45), FIRE_KIT live | iron (default live), FIRE_POTION=1 (a fire resistance potion carried), FIRE_OUT
// (JSONL rows), FIRE_EXPECT=1 (assert: no death, out within 20 s), FIRE_TRACE=1 (the bot's fire lines in each row).
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fireProcessOf } from '../../src/chat/commands-portal.ts';
import type { Vec3 } from '../../src/connection/types.ts';
import { dfill, dimTeleport, E2E, netherCmd, privateArea, sleep, startNetherBot, truthRetry, until, type Dim, type NetherBot } from './nether-truth.ts';

const ONLY = process.env.FIRE_CASE ?? 'ledge,wood,lava';
const want = (c: string): boolean => ONLY.split(',').includes(c);
const N = Number(process.env.FIRE_N ?? 1);
const ARM = process.env.FIRE_ARM ?? 'run';
const SECONDS = Number(process.env.FIRE_SECONDS ?? 45);
const KIT = process.env.FIRE_KIT ?? 'live';
const POTION = process.env.FIRE_POTION === '1';
const OUT = process.env.FIRE_OUT;
const EXPECT = process.env.FIRE_EXPECT === '1';
const TRACE = process.env.FIRE_TRACE === '1';
const r1 = (v: number): number => Math.round(v * 10) / 10;
const HOT = /fire|lava|magma|campfire/;

interface Row {
  arm: string;
  kase: string;
  run: number;
  kit: string;
  died: boolean;
  cause: string;
  damage: number;
  byCause: Record<string, number>;
  lowest: number;
  /** Seconds the server's `onfire` flag was on. */
  burnS: number;
  /** Seconds until the feet first stood in a cell with no fire and out of lava (-1: never). */
  outS: number;
  /** Seconds the run lasted. */
  seconds: number;
  escapes: number;
  noEscape: number;
  eats: number;
  /** Track M11: what the escape did (the FireProcess counters that moved: putOut, walks, failedWalks, handWalks, drinks, pillars) and how it ended last. */
  acts: string;
  end: string;
  where: string;
  lines?: string[];
}

describe.skipIf(!E2E)('@bds fire: the fire escape in built scenes (Track M11)', () => {
  let bot: NetherBot | undefined;
  const rows: Row[] = [];
  const area = privateArea();
  // the Nether's arena (its own far area: x / 8, z / 8 of the overworld area, 16-aligned)
  const NX = Math.round(area.x / 8 / 16) * 16;
  const NZ = Math.round(area.z / 8 / 16) * 16;

  const note = (s: string): void => {
    console.log(s);
  };

  beforeAll(async () => {
    for (const c of [
      ['difficulty', 'normal'],
      ['gamerule', 'dodaylightcycle', 'false'],
      ['gamerule', 'doweathercycle', 'false'],
      ['gamerule', 'domobspawning', 'false'],
      ['gamerule', 'keepinventory', 'true'],
      ['gamerule', 'doimmediaterespawn', 'false'],
      ['time', 'set', 'noon'],
      ['weather', 'clear'],
    ]) {
      await netherCmd(...c);
    }
    bot = await startNetherBot('Fire');
    note(`[pve-fire] overworld area ${area.x} ${area.z}, nether arena ${NX} ${NZ}`);
  }, 240_000);

  afterAll(async () => {
    const by = (k: string) => rows.filter((r) => r.kase === k);
    for (const k of ['ledge', 'wood', 'lava', 'pit']) {
      const rs = by(k);
      if (rs.length === 0) continue;
      note(
        `[pve-fire] ${ARM} ${k}: ${rs.length} runs, ${rs.filter((r) => r.died).length} deaths, damage ${rs.map((r) => r.damage).join(' ')}, lowest ${rs.map((r) => r.lowest).join(' ')}, burning s ${rs.map((r) => r.burnS).join(' ')}, out s ${rs.map((r) => r.outS).join(' ')}, escapes ${rs.map((r) => r.escapes).join(' ')}`,
      );
    }
    await netherCmd('time', 'set', '18000').catch(() => undefined);
    if (bot) {
      await clearScenes(bot).catch(() => undefined);
      await dimTeleport(bot, 'overworld', { x: 0.5, y: 100, z: 0.5 }).catch(() => undefined);
      await bot.stop();
    }
  }, 180_000);

  async function clearScenes(b: NetherBot): Promise<void> {
    await dfill(b, 'overworld', { x: area.x - 10, y: -60, z: area.z - 10 }, { x: area.x + 10, y: -54, z: area.z + 10 }, 'air').catch(() => undefined);
    await dfill(b, 'overworld', { x: area.x - 10, y: -61, z: area.z - 10 }, { x: area.x + 10, y: -61, z: area.z + 10 }, 'grass_block').catch(() => undefined);
  }

  async function setKit(b: NetherBot): Promise<void> {
    const t = b.truth;
    await t.ok('clear', [b.name]);
    await t.ok('unequip', [b.name]);
    await netherCmd('replaceitem', 'entity', b.name, 'slot.weapon.offhand', '0', 'air');
    const metal = KIT === 'iron' ? 'iron' : 'netherite';
    await t.ok('give', [b.name, `${metal}_sword`, 1]);
    await t.ok('give', [b.name, `${metal}_pickaxe`, 1]);
    for (const piece of ['helmet', 'chestplate', 'leggings', 'boots']) await t.ok('give', [b.name, `${metal}_${piece}`, 1]);
    await t.ok('give', [b.name, KIT === 'iron' ? 'bread' : 'cooked_beef', 16]);
    await t.ok('give', [b.name, 'cobblestone', 32]);
    await t.ok('give', [b.name, 'shield', 1]);
    if (POTION) await netherCmd('give', b.name, 'potion', '1', '12'); // fire resistance (3:00)
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

  async function full(b: NetherBot): Promise<void> {
    await b.truth.setHealth(b.name, 20);
    await b.truth.ok('setfood', [b.name, 20, 5]);
    await netherCmd('effect', b.name, 'clear').catch(() => undefined);
  }

  const dset = (b: NetherBot, dim: Dim, p: Vec3, block: string): Promise<unknown> => truthRetry(b, 'dset', [dim, p.x, p.y, p.z, block]);

  /** One run: `lay` builds the scene (the bot already standing at `feet`), `light` sets the fire; then watched; `clean` after. */
  async function run(b: NetherBot, kase: string, n: number, dim: Dim, feet: Vec3, lay: () => Promise<void>, light: () => Promise<void>, clean: () => Promise<void>): Promise<Row> {
    const w = b.built.mobility!.world;
    const loop = b.built.mobility!.loop;
    const fire = fireProcessOf(b.task)!;
    const watch = (fire as unknown as { d: { watch: { onFire: boolean } } }).d.watch;
    await dimTeleport(b, dim, { x: feet.x, y: feet.y + 6, z: feet.z }).catch(() => undefined);
    await lay();
    await dimTeleport(b, dim, feet).catch(async (e: unknown) => {
      // seen once in 30 runs: no chunk came after the teleports (25 of 25 columns missing for 60 s each): away (the flat
      // overworld's ground 160 off) and back, so the server sends them again
      if (!String(e).includes('waiting for chunks')) throw e;
      if (dim === 'overworld') await dimTeleport(b, dim, { x: feet.x + 160, y: -60, z: feet.z }).catch(() => undefined);
      await dimTeleport(b, dim, feet);
    });
    await setKit(b);
    await full(b);
    await sleep(1500);
    const resp = b.built.respawn!;
    const d0 = resp.deaths;
    const s0 = { ...fire.stats };
    const l0 = b.logs.length;
    const tick0 = await b.truth.now();
    const p0 = { ...loop.state.pos };
    await light().catch(async (e: unknown) => {
      // seen once in 10 runs: the scene's chunk not loaded for 30 s although the bot stood in it; stand there again
      if (!String(e).includes('unloaded_chunk')) throw e;
      await dimTeleport(b, dim, feet);
      await light();
    });
    const t0 = Date.now();
    const sec = (): number => r1((Date.now() - t0) / 1000);
    let lowest = 20;
    let burnMs = 0;
    let outAt: number | undefined;
    let clearSince: number | undefined;
    let end = 'timeout';
    let last = Date.now();
    while (Date.now() - t0 < SECONDS * 1000) {
      await sleep(100);
      const now = Date.now();
      if (watch.onFire) burnMs += now - last;
      last = now;
      const h = w.self.health;
      if (h > 0) lowest = Math.min(lowest, h);
      if (resp.deaths > d0) {
        end = 'died';
        break;
      }
      const p = loop.state.pos;
      const cell = { x: Math.floor(p.x), y: Math.floor(p.y + 1e-3), z: Math.floor(p.z) };
      const here = w.blockAt(cell)?.name ?? '?';
      const inHot = HOT.test(here) || loop.state.inLava;
      if (!inHot && outAt === undefined && Date.now() - t0 > 300) outAt = Date.now();
      if (!inHot && !watch.onFire) {
        clearSince ??= Date.now();
        if (Date.now() - clearSince >= 3000) {
          end = 'out';
          break;
        }
      } else clearSince = undefined;
    }
    const seconds = sec();
    await sleep(1500);
    const hurt = (await b.truth.hurtlog(tick0, b.name)).events.filter((e) => e.victimName === b.name);
    const byCause: Record<string, number> = {};
    for (const e of hurt) byCause[e.cause] = r1((byCause[e.cause] ?? 0) + e.damage);
    const died = end === 'died' || resp.deaths > d0;
    const me = loop.state.pos;
    const row: Row = {
      arm: ARM,
      kase,
      run: n,
      kit: KIT + (POTION ? '+potion' : ''),
      died,
      cause: died ? `${resp.history.at(-1)?.cause ?? '?'}` : '',
      damage: r1(hurt.reduce((s, e) => s + e.damage, 0)),
      byCause,
      lowest: died ? 0 : r1(lowest),
      burnS: r1(burnMs / 1000),
      outS: outAt === undefined ? -1 : r1((outAt - t0) / 1000),
      seconds,
      escapes: fire.stats.escapes - s0.escapes,
      noEscape: fire.stats.noEscape - s0.noEscape,
      eats: fire.stats.eats - s0.eats,
      acts: [...Object.entries(fire.stats).filter(([k, v]) => !['escapes', 'noEscape', 'eats'].includes(k) && v !== (s0 as Record<string, number>)[k]).map(([k, v]) => k + ' ' + (v - ((s0 as Record<string, number>)[k] ?? 0))), 'end ' + String((fire as { lastEnd?: string }).lastEnd)].join(', '),
      end: died ? 'died' : end,
      where: `lit at ${r1(p0.x - feet.x)},${r1(p0.y - feet.y)},${r1(p0.z - feet.z)}; ${died ? 'died' : `ended at ${r1(me.x - feet.x)},${r1(me.y - feet.y)},${r1(me.z - feet.z)}`}`,
    };
    if (TRACE || died || row.outS < 0)
      row.lines = b.logs
        .slice(l0)
        .filter((l) => /fire|goto .*(unreachable|failed|ok after)|no standable|process: fire|eat: |died|potion|pillar|extinguish/.test(l))
        .slice(0, 80)
        .map((l) => l.replace(`${b.name}:`, '').slice(0, 230));
    rows.push(row);
    note(`[pve-fire] ${JSON.stringify(row)}`);
    if (OUT) appendFileSync(OUT, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
    if (died) {
      await until(() => (w.self.health > 0 && b.task.position() ? true : undefined), 30_000, 'the respawn', 500).catch(() => undefined);
      await sleep(2500);
    }
    await b.command('!stop').catch(() => undefined);
    // back over the scene (a death respawned the bot far away: its chunks are not loaded) and clear it
    await dimTeleport(b, dim, { x: feet.x, y: feet.y + 8, z: feet.z }).catch(() => undefined);
    await clean().catch((e: unknown) => note(`[pve-fire] clean: ${String(e)}`));
    return row;
  }

  // ---- ledge (the Nether) ---------------------------------------------------------------------------------------------
  const LY = 103; // feet on the ledge
  async function layLedge(b: NetherBot): Promise<void> {
    const X = NX;
    const Z = NZ;
    await dfill(b, 'nether', { x: X - 8, y: 97, z: Z - 4 }, { x: X + 10, y: 112, z: Z + 6 }, 'netherrack');
    await dfill(b, 'nether', { x: X - 7, y: 100, z: Z }, { x: X + 9, y: 111, z: Z + 5 }, 'air');
    // the ledge along the cliff (z Z - 1 is the box's wall): 3 high, feet at LY
    await dfill(b, 'nether', { x: X - 7, y: 100, z: Z }, { x: X + 9, y: LY - 1, z: Z }, 'netherrack');
    // the rail in front of the bot's part of the ledge and the closed pocket under it, 2 down (bedrock: no walk or dig gets in)
    await dfill(b, 'nether', { x: X - 3, y: 100, z: Z + 1 }, { x: X + 3, y: LY + 1, z: Z + 2 }, 'bedrock');
    await dfill(b, 'nether', { x: X - 2, y: LY - 2, z: Z + 1 }, { x: X + 2, y: LY - 1, z: Z + 1 }, 'air');
    await dfill(b, 'nether', { x: X - 2, y: LY - 3, z: Z + 1 }, { x: X + 2, y: LY - 3, z: Z + 1 }, 'netherrack');
  }
  async function lightLedge(b: NetherBot): Promise<void> {
    await dfill(b, 'nether', { x: NX - 1, y: LY, z: NZ }, { x: NX + 1, y: LY, z: NZ }, 'fire');
  }

  it.runIf(want('ledge'))(`ledge: fire on a netherrack ledge, the nearest clear cell a closed pocket 2 down (${N} run(s), ${ARM})`, async () => {
    const b = bot!;
    for (let n = 1; n <= N; n++) {
      await run(b, 'ledge', n, 'nether', { x: NX + 0.5, y: LY, z: NZ + 0.5 }, () => layLedge(b), () => lightLedge(b), () => dfill(b, 'nether', { x: NX - 7, y: LY, z: NZ }, { x: NX + 9, y: LY + 2, z: NZ }, 'air'));
    }
    if (EXPECT) expect(rows.filter((r) => r.kase === 'ledge' && (r.died || r.outS < 0 || r.outS > 20))).toEqual([]);
  }, 60_000 + N * (SECONDS + 60) * 1000);

  // ---- wood (the overworld) -------------------------------------------------------------------------------------------
  const OY = -60;
  async function layGround(b: NetherBot): Promise<void> {
    await dfill(b, 'overworld', { x: area.x - 10, y: OY, z: area.z - 10 }, { x: area.x + 10, y: OY + 6, z: area.z + 10 }, 'air');
    await dfill(b, 'overworld', { x: area.x - 10, y: OY - 2, z: area.z - 10 }, { x: area.x + 10, y: OY - 2, z: area.z + 10 }, 'dirt');
    await dfill(b, 'overworld', { x: area.x - 10, y: OY - 1, z: area.z - 10 }, { x: area.x + 10, y: OY - 1, z: area.z + 10 }, 'grass_block');
    await netherCmd('kill', '@e[type=item]').catch(() => undefined);
  }
  it.runIf(want('wood'))(`wood: a fire spread on a wooden floor round the bot (${N} run(s), ${ARM})`, async () => {
    const b = bot!;
    for (let n = 1; n <= N; n++) {
      await run(
        b,
        'wood',
        n,
        'overworld',
        { x: area.x + 0.5, y: OY, z: area.z + 0.5 },
        async () => {
          await layGround(b);
          await dfill(b, 'overworld', { x: area.x - 3, y: OY - 1, z: area.z - 3 }, { x: area.x + 3, y: OY - 1, z: area.z + 3 }, 'oak_planks');
        },
        () => dfill(b, 'overworld', { x: area.x - 2, y: OY, z: area.z - 2 }, { x: area.x + 2, y: OY, z: area.z + 2 }, 'fire'),
        () => layGround(b),
      );
    }
    if (EXPECT) expect(rows.filter((r) => r.kase === 'wood' && (r.died || r.outS < 0 || r.outS > 20))).toEqual([]);
  }, 60_000 + N * (SECONDS + 60) * 1000);

  it.runIf(want('lava'))(`lava: lava's fire next to the bot (${N} run(s), ${ARM})`, async () => {
    const b = bot!;
    for (let n = 1; n <= N; n++) {
      await run(
        b,
        'lava',
        n,
        'overworld',
        { x: area.x + 0.5, y: OY, z: area.z + 0.5 },
        async () => {
          await layGround(b);
          await dfill(b, 'overworld', { x: area.x, y: OY - 1, z: area.z - 2 }, { x: area.x + 1, y: OY - 1, z: area.z + 2 }, 'oak_planks');
        },
        // the lava with the fire (laid before, the bot's own rules walked it off the lava's edge before the fire came)
        async () => {
          await dfill(b, 'overworld', { x: area.x, y: OY, z: area.z - 1 }, { x: area.x + 1, y: OY, z: area.z + 1 }, 'fire');
          await dfill(b, 'overworld', { x: area.x - 4, y: OY - 1, z: area.z - 2 }, { x: area.x - 1, y: OY - 1, z: area.z + 2 }, 'lava');
        },
        () => layGround(b),
      );
    }
    if (EXPECT) expect(rows.filter((r) => r.kase === 'lava' && (r.died || r.outS < 0 || r.outS > 20))).toEqual([]);
  }, 60_000 + N * (SECONDS + 60) * 1000);

  // ---- pit (Track M11's last resorts): lava in the feet cell of a 1 x 1 pit, walls 3 high round it: no way out, nothing
  // a strike puts out; with FIRE_POTION=1 the potion, else the pillar
  it.runIf(want('pit'))(`pit: lava in the feet cell of a closed pit (${N} run(s), ${ARM}${POTION ? ', a potion carried' : ''})`, async () => {
    const b = bot!;
    const at = { x: area.x + 4, y: OY, z: area.z + 4 };
    for (let n = 1; n <= N; n++) {
      await run(
        b,
        'pit',
        n,
        'overworld',
        { x: at.x + 0.5, y: OY, z: at.z + 0.5 },
        async () => {
          await layGround(b);
          await dfill(b, 'overworld', { x: at.x - 1, y: OY - 1, z: at.z - 1 }, { x: at.x + 1, y: OY + 2, z: at.z + 1 }, 'cobblestone');
          await dfill(b, 'overworld', { x: at.x, y: OY, z: at.z }, { x: at.x, y: OY + 2, z: at.z }, 'air');
        },
        () => dset(b, 'overworld', at, 'lava').then(() => undefined),
        () => layGround(b),
      );
    }
    if (EXPECT) expect(rows.filter((r) => r.kase === 'pit' && r.died)).toEqual([]);
  }, 60_000 + N * (SECONDS + 60) * 1000);

  // ---- probe: what the server lets a player do about the fire in its own cell -----------------------------------------
  it.runIf(want('probe'))('probe: strike the fire, strike its floor, place into it, pillar out of it', async () => {
    const b = bot!;
    const mob = b.built.mobility!;
    const skills = mob.skills;
    const at = { x: area.x, y: OY, z: area.z };
    const feet = { x: at.x + 0.5, y: OY, z: at.z + 0.5 };
    const fireAt = { x: at.x + 1, y: OY, z: at.z };
    const block = async (p: Vec3): Promise<string> => (await truthRetry<{ typeId: string }>(b, 'dblock', ['overworld', p.x, p.y, p.z])).typeId;
    const lines: string[] = [];
    await dimTeleport(b, 'overworld', { x: feet.x, y: feet.y + 4, z: feet.z }).catch(() => undefined);
    await layGround(b);
    await dfill(b, 'overworld', { x: at.x - 2, y: OY - 1, z: at.z - 2 }, { x: at.x + 2, y: OY - 1, z: at.z + 2 }, 'netherrack'); // fire on it does not go out
    await dimTeleport(b, 'overworld', feet);
    await setKit(b);
    await full(b);
    for (const [label, act] of [
      ['dig the fire block', () => skills.dig(fireAt)],
      ['dig the floor under it, face up', () => skills.dig({ x: fireAt.x, y: OY - 1, z: fireAt.z }, { face: 1, tool: 'current' })],
      ['place cobblestone into it', () => skills.placer!.place(fireAt, { item: 'cobblestone' })],
    ] as const) {
      await dset(b, 'overworld', fireAt, 'fire');
      await sleep(800);
      const before = await block(fireAt);
      const floorBefore = await block({ x: fireAt.x, y: OY - 1, z: fireAt.z });
      const r = await (act as () => Promise<{ ok: boolean; reason?: string }>)().catch((e: unknown) => ({ ok: false, reason: String(e) }));
      await sleep(800);
      const after = await block(fireAt);
      const floorAfter = await block({ x: fireAt.x, y: OY - 1, z: fireAt.z });
      lines.push(`${label}: ${r.ok ? 'ok' : r.reason}; the cell ${before} -> ${after}, its floor ${floorBefore} -> ${floorAfter}`);
      await dset(b, 'overworld', fireAt, 'air');
      await dset(b, 'overworld', { x: fireAt.x, y: OY - 1, z: fireAt.z }, 'netherrack');
    }
    // standing in the fire: pillar up (a block placed into the feet cell while the body rises over it)
    await full(b);
    await dset(b, 'overworld', at, 'fire');
    await sleep(1500);
    const h0 = mob.world.self.health;
    const r = await skills.placer!.place(at, { item: 'cobblestone' }).catch((e: unknown) => ({ ok: false, reason: String(e) }));
    await sleep(1500);
    const p = mob.loop.state.pos;
    lines.push(`pillar out of the fire: ${r.ok ? 'ok' : (r as { reason?: string }).reason}; the feet cell ${await block(at)}, feet now ${r1(p.y)} (from ${OY}), health ${r1(h0)} -> ${r1(mob.world.self.health)}`);
    await dfill(b, 'overworld', { x: at.x - 2, y: OY, z: at.z - 2 }, { x: at.x + 2, y: OY + 3, z: at.z + 2 }, 'air');
    for (const l of lines) note(`[pve-fire] probe: ${l}`);
    if (OUT) appendFileSync(OUT, `${JSON.stringify({ at: new Date().toISOString(), probe: lines })}\n`);
  }, 180_000);
});
