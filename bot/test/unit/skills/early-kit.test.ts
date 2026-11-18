// Track M4 (docs/pve.md "Track M4: early-game kits", ADR 0079 addendum): the guard tests for this track's rules.
import { describe, expect, it } from 'vitest';
import { POISON_EFFECT, poisonLeft } from '../../../src/skills/combat/hostiles.ts';
import { ARCHER_DUEL_HOME, ARCHER_DUEL_MIN, SHOOTER_HOME, FLEE_AWAY, FLEE_FAR, FLEE_LONG, fleeRadius, FLEE_LEG_BAND, FLEE_LEG_HOLD_MS, FLEE_URGENT, fleeLeg, PveController, PVE_RULES_DEFAULT, type FleeLegInput } from '../../../src/tasks/pve.ts';
import { Inventory } from '../../../src/world/inventory.ts';
import type { EntityInfo, ItemStack, Vec3 } from '../../../src/world/types.ts';
import { FakeLoop, FakeMover, FakeSource, mob } from './pve-fakes.ts';

const stack = (name: string, count: number): ItemStack => ({ name, networkId: 1, count, metadata: 0 });
/** The rules are on by default (PVE_RULES_DEFAULT); these tests start from the code before Track M4. */
const allOff = (pve: PveController): void => {
  for (const k of Object.keys(pve.rules) as (keyof typeof pve.rules)[]) pve.rules[k] = false;
};

/** Track M9's rules and their defaults (m9-rules.test.ts): the ones that ship off stay off. */
const M9_DEFAULTS: Record<string, boolean> = { followRun: true, sprintJump: false, craftBlade: false };
/** Track M10's rules and their defaults (m10-rules.test.ts). */
const M10_DEFAULTS: Record<string, boolean> = { backHome: true, followHome: false };
const OWN_DEFAULTS: Record<string, boolean> = { ...M9_DEFAULTS, ...M10_DEFAULTS };

it('the rules are on by default (Tracks M9 and M10: their own defaults)', () => {
  const rules = PVE_RULES_DEFAULT as unknown as Record<string, boolean>;
  expect(Object.entries(rules).every(([k, v]) => (k in OWN_DEFAULTS ? v === OWN_DEFAULTS[k] : v))).toBe(true);
  expect(Object.keys(PVE_RULES_DEFAULT).sort()).toEqual(['archerDuel', 'bareArcher', 'fleeLong', 'legHold', 'poison', 'poisonBite', 'shooterHome', 'shooterWay', 'volley', 'witchCrowd', 'witchRush', 'milkCure', ...Object.keys(OWN_DEFAULTS)].sort()); // Track M5: + shooterWay, poisonBite, witchCrowd (m5-rules.test.ts); Track M6: + volley, bareArcher (m6-rules.test.ts); Track M7: + witchRush, milkCure (m7-rules.test.ts); Track M9: + followRun, sprintJump, craftBlade (m9-rules.test.ts); Track M10: + backHome, followHome (m10-rules.test.ts)
});

describe('the archer at home (archerDuel)', () => {
  function setup(health: number, o: { home?: Vec3; shelter?: Vec3 } = {}) {
    const src = new FakeSource();
    const loop = new FakeLoop();
    const ents = new Map<bigint, EntityInfo>();
    const inventory = new Inventory(() => null, () => 1n);
    const me = loop.pos;
    const home = o.home ?? { x: Math.floor(me.x), y: Math.floor(me.y), z: Math.floor(me.z) };
    const pve = new PveController({ source: src, world: { entities: ents, inventory, self: { runtimeId: 1n, health } }, loop, skills: Object.assign(new FakeMover(), { collect: () => Promise.resolve({ ok: true }) }), home: () => home, shelter: () => o.shelter, inactive: () => false, options: { guard: { on: true, radius: 16 } } });
    pve.settings.set('mobReflex', false);
    allOff(pve); // each test turns on the rule it is about
    src.emit('start_game', { entity_id: -42n });
    src.emit('set_health', { health });
    inventory.setItem(0, 0, stack('stone_sword', 1));
    // the last hit an arrow of 4: 2 x 4 = 8 > 6, so the duel of Track M1 is refused
    pve.lastHit = { damage: 4, at: performance.now() };
    return { ents, pve, me, inventory };
  }
  const at = (me: { x: number; y: number; z: number }, dx: number, dz = 0) => ({ x: me.x + dx, y: me.y, z: me.z + dz });

  it('off: the case the gauntlet saw (6 health, a skeleton at 12 from home): no duel, no flee, nothing picked', () => {
    const s = setup(6);
    s.ents.set(7n, mob(7n, 'minecraft:skeleton', at(s.me, 12)));
    expect(s.pve.canDuel(s.me)).toBe(false);
    expect(s.pve.fleeReason(s.me)).toBeUndefined(); // the threat is farther than 6 from home
    expect(s.pve.pickThreat(s.me, s.pve.low())).toBeUndefined(); // guard in place does not walk to it
    s.pve.dispose();
  });

  it('on: the archer is a duel and guard walks to it (not in place)', () => {
    const s = setup(6);
    s.pve.rules.archerDuel = true;
    s.ents.set(7n, mob(7n, 'minecraft:skeleton', at(s.me, 12)));
    expect(s.pve.archerDuelTarget(s.me)?.runtimeId).toBe(7n);
    expect(s.pve.canDuel(s.me)).toBe(true);
    expect(s.pve.fleeReason(s.me)).toBeUndefined();
    const pick = s.pve.pickThreat(s.me, s.pve.low());
    expect(pick?.e.runtimeId).toBe(7n);
    expect(pick?.inPlace).toBe(false);
    s.pve.dispose();
  });

  it('on, but not for: a third archer, a melee mob or a witch with them, no blade, health not low, far from home, a shelter', () => {
    const cases: [string, (s: ReturnType<typeof setup>) => void, number?][] = [
      ['three archers', (s) => { s.ents.set(8n, mob(8n, 'minecraft:stray', at(s.me, -10))); s.ents.set(9n, mob(9n, 'minecraft:skeleton', at(s.me, 0, 10))); }],
      ['a zombie', (s) => s.ents.set(8n, mob(8n, 'minecraft:zombie', at(s.me, -10)))],
      ['a witch', (s) => s.ents.set(8n, mob(8n, 'minecraft:witch', at(s.me, -10)))],
      ['a creeper', (s) => s.ents.set(8n, mob(8n, 'minecraft:creeper', at(s.me, -12)))],
      ['no blade', (s) => s.inventory.setItem(0, 0, null)],
      ['health 10', () => undefined, 10],
    ];
    for (const [why, add, health] of cases) {
      const s = setup(health ?? 6);
      s.pve.rules.archerDuel = true;
      s.ents.set(7n, mob(7n, 'minecraft:skeleton', at(s.me, 12)));
      add(s);
      expect(s.pve.archerDuelTarget(s.me), why).toBeUndefined();
      s.pve.dispose();
    }
    const far = setup(6, { home: { x: 100, y: -60, z: 100 } });
    far.pve.rules.archerDuel = true;
    far.ents.set(7n, mob(7n, 'minecraft:skeleton', at(far.me, 12)));
    expect(far.pve.archerDuelTarget(far.me), `farther than ${ARCHER_DUEL_HOME} from home`).toBeUndefined();
    far.pve.dispose();
    const sh = setup(6, { shelter: { x: 0, y: -60, z: 0 } });
    sh.pve.rules.archerDuel = true;
    sh.ents.set(7n, mob(7n, 'minecraft:skeleton', at(sh.me, 12)));
    expect(sh.pve.archerDuelTarget(sh.me), 'a shelter').toBeUndefined();
    sh.pve.dispose();
  });

  it(`not at ${ARCHER_DUEL_MIN} health or under, nor when the poison will leave that: the flight on foot`, () => {
    const s = setup(ARCHER_DUEL_MIN);
    s.pve.rules.archerDuel = true;
    s.ents.set(7n, mob(7n, 'minecraft:skeleton', at(s.me, 12)));
    expect(s.pve.archerDuelTarget(s.me)).toBeUndefined();
    s.pve.dispose();
    const p = setup(7);
    p.pve.rules.archerDuel = true;
    p.pve.rules.poison = true;
    p.ents.set(7n, mob(7n, 'minecraft:skeleton', at(p.me, 12)));
    expect(p.pve.archerDuelTarget(p.me)?.runtimeId).toBe(7n);
    p.pve.mobs.selfPoison = { amplifier: 0, until: performance.now() + 10_000 };
    expect(p.pve.archerDuelTarget(p.me)).toBeUndefined();
    p.pve.dispose();
  });

  it('shooterHome: at home, an archer with a line on the bot is fled from at low health (the at-home exception does not hold)', () => {
    const s = setup(4);
    s.ents.set(7n, mob(7n, 'minecraft:skeleton', at(s.me, 12)));
    expect(s.pve.fleeReason(s.me)).toBeUndefined(); // at home, the threat farther than 6
    s.pve.rules.shooterHome = true;
    expect(s.pve.fleeReason(s.me)?.threat.runtimeId).toBe(7n);
    s.pve.dispose();
    // a witch is not: she walks after a bot that runs, and guard at home fights her
    const w = setup(4);
    w.pve.rules.shooterHome = true;
    w.ents.set(8n, mob(8n, 'minecraft:witch', at(w.me, 12)));
    expect(w.pve.fleeReason(w.me)).toBeUndefined();
    w.pve.dispose();
  });

  it('two archers: the nearer is the target', () => {
    const s = setup(6);
    s.pve.rules.archerDuel = true;
    s.ents.set(7n, mob(7n, 'minecraft:skeleton', at(s.me, 12)));
    s.ents.set(8n, mob(8n, 'minecraft:pillager', at(s.me, 0, -9)));
    expect(s.pve.archerDuelTarget(s.me)?.runtimeId).toBe(8n);
    expect(s.pve.firstTarget(s.ents.get(8n)!, s.me)).toBe(true);
    expect(s.pve.firstTarget(s.ents.get(7n)!, s.me)).toBe(false);
    s.pve.dispose();
  });
});

describe('the length of a leg (fleeRadius, fleeLong)', () => {
  it('off: as before; on: FLEE_LONG more, never past FLEE_FAR', () => {
    expect(fleeRadius('away', 3, false)).toBe(FLEE_AWAY + 4);
    expect(fleeRadius('far', 3, false)).toBe(FLEE_AWAY + 4);
    expect(fleeRadius('far', 20, false)).toBe(26);
    expect(fleeRadius('far', 60, false)).toBe(FLEE_FAR);
    expect(fleeRadius('away', 3, true)).toBe(FLEE_AWAY + 4 + FLEE_LONG);
    expect(fleeRadius('far', 20, true)).toBe(26 + FLEE_LONG);
    expect(fleeRadius('far', 60, true)).toBe(FLEE_FAR);
  });

  it('a leg on: more than the 8 blocks of path the walk needs left to sprint, from a threat at reach', () => {
    // the bot at 3 from the threat: the leg's path is at least r - 3 long
    expect(fleeRadius('away', 3, false) - 3).toBeLessThanOrEqual(13);
    expect(fleeRadius('away', 3, true) - 3 - 8).toBeGreaterThanOrEqual(FLEE_LONG + 2);
  });
});

describe('the leg of the flight on foot (fleeLeg)', () => {
  const base: FleeLegInput = { phase: 'away', dest: true, nearest: 5, homeOk: false, farEnough: false, sinceLeg: 10_000, hold: true };
  const leg = (o: Partial<FleeLegInput>) => fleeLeg({ ...base, ...o });

  it('without the hold: the rule of Track W, unchanged', () => {
    const off = (o: Partial<FleeLegInput>) => leg({ hold: false, ...o });
    expect(off({})).toBe('away');
    expect(off({ nearest: FLEE_AWAY, homeOk: true })).toBe('home');
    expect(off({ nearest: FLEE_AWAY })).toBe('far');
    expect(off({ phase: 'far', nearest: 3 })).toBe('far');
    expect(off({ phase: 'home', nearest: 3, homeOk: true })).toBe('home');
    expect(off({ phase: 'home', nearest: 10, homeOk: false })).toBe('away');
    expect(off({ phase: 'far', nearest: FLEE_AWAY, farEnough: true })).toBe('home');
    expect(off({ nearest: FLEE_AWAY, dest: false, homeOk: true })).toBe('far');
  });

  it('the flapping the gauntlet saw (a husk at 10 to 12, a skeleton in and out of view at 15) keeps one leg', () => {
    // the trace: home -> away -> home -> away every 15 ticks with the nearest threat at 10.2 to 12.2
    let phase: FleeLegInput['phase'] = 'home';
    let legAt = 0;
    let homeOkAt: number | undefined;
    const seen: string[] = [];
    for (let t = 0; t < 20_000; t += 750) {
      const nearest = t % 1500 === 0 ? 12.2 : 10.4;
      const homeOk = t % 1500 === 0;
      // as FleeProcess keeps it: since when home has been clear without a break
      if (!homeOk) homeOkAt = undefined;
      else homeOkAt ??= t;
      const next = fleeLeg({ phase, dest: true, nearest, homeOk, farEnough: false, sinceLeg: t - legAt, homeOkMs: homeOkAt === undefined ? 0 : t - homeOkAt, hold: true });
      if (next !== phase) {
        legAt = t;
        seen.push(next);
      }
      phase = next;
    }
    // without the hold it changes 26 times in 20 s; with it at most once every FLEE_LEG_HOLD_MS, and never into away
    expect(seen.length).toBeLessThanOrEqual(20_000 / FLEE_LEG_HOLD_MS);
    expect(seen).not.toContain('away');
    let flips = 0;
    phase = 'home';
    for (let t = 0; t < 20_000; t += 750) {
      const next = fleeLeg({ phase, dest: true, nearest: t % 1500 === 0 ? 12.2 : 10.4, homeOk: t % 1500 === 0, farEnough: false, sinceLeg: 0, hold: false });
      if (next !== phase) flips++;
      phase = next;
    }
    expect(flips).toBeGreaterThan(20);
  });

  it('a new leg is held FLEE_LEG_HOLD_MS unless a threat is within FLEE_URGENT; far stays far (Track W)', () => {
    expect(leg({ phase: 'away', nearest: 13, sinceLeg: 100 })).toBe('away');
    expect(leg({ phase: 'away', nearest: 13 })).toBe('far');
    expect(leg({ phase: 'away', nearest: 13, homeOk: true, sinceLeg: FLEE_LEG_HOLD_MS })).toBe('home');
    expect(leg({ phase: 'far', nearest: FLEE_URGENT, sinceLeg: 100 })).toBe('far');
    expect(leg({ phase: 'far', nearest: 2 })).toBe('far');
    // home with a clear home and the threat inside the band: home (it walks round it: Track W)
    expect(leg({ phase: 'home', nearest: FLEE_AWAY - FLEE_LEG_BAND - 1, homeOk: true })).toBe('home');
  });

  it('never on towards a home that is no longer clear, hold or not', () => {
    expect(leg({ phase: 'home', nearest: 14, homeOk: false, sinceLeg: 100 })).toBe('far');
    expect(leg({ phase: 'home', nearest: 7, homeOk: false, sinceLeg: 100 })).toBe('away');
    expect(leg({ phase: 'home', nearest: 10, homeOk: false })).toBe('far');
    expect(leg({ phase: 'home', nearest: 10, homeOk: true })).toBe('home');
  });

  it('a held far leg does not turn home on one look of a clear home; after the hold it does', () => {
    expect(leg({ phase: 'far', nearest: 14, homeOk: true, sinceLeg: 500 })).toBe('far');
    expect(leg({ phase: 'far', nearest: 14, homeOk: true, sinceLeg: FLEE_LEG_HOLD_MS })).toBe('home');
    expect(leg({ phase: 'far', nearest: 14, homeOk: true, sinceLeg: FLEE_LEG_HOLD_MS, homeOkMs: 0 })).toBe('far');
    expect(leg({ phase: 'far', nearest: 14, homeOk: true, sinceLeg: FLEE_LEG_HOLD_MS, homeOkMs: FLEE_LEG_HOLD_MS })).toBe('home');
    // without the hold the clear look is taken at once, as before
    expect(leg({ phase: 'far', nearest: 14, homeOk: true, sinceLeg: 0, homeOkMs: 0, hold: false })).toBe('home');
  });
});

describe("the bot's own poison (poison)", () => {
  it('poisonLeft: one every 25 ticks at level I (12 at II) until it ends, never below 1 health', () => {
    const now = 1000;
    expect(poisonLeft(undefined, now, 20)).toBe(0);
    expect(poisonLeft({ amplifier: 0, until: now + 45_000 }, now, 20)).toBe(19); // 36 ticks of damage, stopped at 1 health
    expect(poisonLeft({ amplifier: 0, until: now + 10_000 }, now, 20)).toBe(8); // 200 ticks / 25
    expect(poisonLeft({ amplifier: 1, until: now + 10_000 }, now, 20)).toBe(16); // 200 / 12
    expect(poisonLeft({ amplifier: 0, until: now - 1 }, now, 20)).toBe(0);
    expect(poisonLeft({ amplifier: 0, until: now + 45_000 }, now, 1)).toBe(0);
  });

  function setup(health: number) {
    const src = new FakeSource();
    const loop = new FakeLoop();
    const ents = new Map<bigint, EntityInfo>();
    const inventory = new Inventory(() => null, () => 1n);
    const me = loop.pos;
    const pve = new PveController({ source: src, world: { entities: ents, inventory, self: { runtimeId: 1n, health } }, loop, skills: Object.assign(new FakeMover(), { collect: () => Promise.resolve({ ok: true }) }), home: () => undefined, shelter: () => undefined, inactive: () => false, options: { guard: { on: true, radius: 16 } } });
    pve.settings.set('mobReflex', false);
    allOff(pve); // each test turns on the rule it is about
    src.emit('start_game', { entity_id: -42n });
    src.emit('set_health', { health });
    inventory.setItem(0, 0, stack('stone_sword', 1));
    return { src, ents, pve, me };
  }

  it("a tick of the poison is not a skeleton's hit with the rule on (no duel input); off, as before", () => {
    for (const on of [false, true]) {
      const s = setup(16);
      s.pve.rules.poison = on;
      s.ents.set(7n, mob(7n, 'minecraft:skeleton', { x: s.me.x + 10, y: s.me.y, z: s.me.z }));
      s.src.emit('mob_effect', { runtime_entity_id: 1n, event_id: 'add', effect_id: POISON_EFFECT, amplifier: 0, duration: 900 });
      s.pve.lastHit = { damage: 4, at: performance.now() };
      s.src.emit('set_health', { health: 15 });
      expect(s.pve.lastHit?.damage, `rule ${on}`).toBe(on ? 4 : 1);
      expect(s.pve.mobs.lastHitBy?.runtimeId, `rule ${on}`).toBe(on ? undefined : 7n);
      expect(s.pve.taken.poison ?? 0).toBe(on ? 1 : 0);
      s.pve.dispose();
    }
  });

  it('the duel counts what the poison will leave; low health is the health itself', () => {
    const s = setup(14);
    s.ents.set(7n, mob(7n, 'minecraft:skeleton', { x: s.me.x + 10, y: s.me.y, z: s.me.z }));
    s.pve.lastHit = { damage: 4, at: performance.now() };
    s.src.emit('mob_effect', { runtime_entity_id: 1n, event_id: 'add', effect_id: POISON_EFFECT, amplifier: 0, duration: 900 });
    expect(s.pve.low()).toBe(false); // off: 14 is not low
    expect(s.pve.canDuel(s.me)).toBe(true); // 14 > 2 x 4
    s.pve.rules.poison = true;
    expect(s.pve.healthAfterPoison()).toBe(1);
    expect(s.pve.low()).toBe(false); // not a flee from the witch who poisoned it: she walks after a bot that runs
    expect(s.pve.canDuel(s.me)).toBe(false);
    // another entity's poison, or the effect removed: nothing
    s.src.emit('mob_effect', { runtime_entity_id: 7n, event_id: 'add', effect_id: POISON_EFFECT, amplifier: 0, duration: 900 });
    s.src.emit('mob_effect', { runtime_entity_id: 1n, event_id: 'remove', effect_id: POISON_EFFECT, amplifier: 0, duration: 0 });
    expect(s.pve.healthAfterPoison()).toBe(14);
    expect(s.pve.low()).toBe(false);
    s.pve.dispose();
  });
});

describe('no flight home into the archers (shooterHome)', () => {
  const base: FleeLegInput = { phase: 'far', dest: true, nearest: 14, homeOk: true, farEnough: true, sinceLeg: 10_000, hold: true };
  it('with an archer or a witch near home: no home leg, not when home looks clear, not when far enough out', () => {
    expect(fleeLeg(base)).toBe('home');
    expect(fleeLeg({ ...base, homeShot: true })).toBe('far');
    expect(fleeLeg({ ...base, phase: 'home', homeShot: true })).toBe('far');
    expect(fleeLeg({ ...base, phase: 'home', nearest: 5, homeShot: true })).toBe('away');
    expect(fleeLeg({ ...base, hold: false, homeShot: true })).toBe('far');
  });

  it('shooterNear: archers and witches within the radius of the point, seen or not; not melee mobs', () => {
    const src = new FakeSource();
    const loop = new FakeLoop();
    const ents = new Map<bigint, EntityInfo>();
    const pve = new PveController({ source: src, world: { entities: ents, inventory: new Inventory(() => null, () => 1n), self: { runtimeId: 1n, health: 6 } }, loop, skills: Object.assign(new FakeMover(), { collect: () => Promise.resolve({ ok: true }) }), home: () => undefined, shelter: () => undefined, inactive: () => false, options: { guard: { on: true, radius: 16 } } });
    const home = { x: 0, y: -60, z: 0 };
    ents.set(5n, mob(5n, 'minecraft:zombie', { x: 3, y: -60, z: 0 }));
    expect(pve.shooterNear(home, SHOOTER_HOME)).toBe(false);
    ents.set(6n, mob(6n, 'minecraft:skeleton', { x: 0.5 + SHOOTER_HOME + 1, y: -60, z: 0.5 }));
    expect(pve.shooterNear(home, SHOOTER_HOME)).toBe(false);
    ents.set(7n, mob(7n, 'minecraft:witch', { x: 0.5, y: -60, z: 0.5 - 14 }));
    expect(pve.shooterNear(home, SHOOTER_HOME)).toBe(true);
    pve.dispose();
  });
});
