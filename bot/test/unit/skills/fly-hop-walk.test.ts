// Track F22 (docs/flight.md "The hop asked from a walk (Track F22)"; decisions/0082 addendum 2): the hop under one roof
// asked from a walk. Two faults of the Realm, each reproduced here and guarded:
//
//   1 the proof goes stale while the body walks on: a decision made standing (learn/standing.ts), the stand itself
//     (tasks/process/stand.ts) on the real process manager, the walk's own process (addedSince), and the question a
//     walking body asks instead of a proof (learn/under.ts scoutHop);
//   2 a hop that is flown ends on a roof short of its touchdown: a burn's end seen late by the loop (glide.ts
//     simulateFlight `endLate`), how late a connection's rockets are seen (rocket.ts RocketLag) and the proof that flies
//     it (glide.ts routeHop `late`).
//
// On synthetic passages (nothing of anybody's world). The last block flies the owner's cave itself, from the private
// fixture, and runs only when F22_CAVE_DIR names it.
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../src/connection/types.ts';
import { damageForCounted } from '../../../src/skills/fall/damage.ts';
import { burnRange } from '../../../src/skills/fly/burn.ts';
import { caveUnderWorld } from '../../../src/skills/fly/corridor/cave-under.ts';
import { HOP_LATE_FREE, HOP_LATE_SIMS, PROOF_SWITCH, routeTakeoffOptions, simulateFlight, type SimDeps } from '../../../src/skills/fly/glide.ts';
import { ENTRY_AIR, ENTRY_SINK_MAX, ENTRY_SOLID, ENTRY_SWITCH } from '../../../src/skills/fly/learn/entry.ts';
import { guideNearest } from '../../../src/skills/fly/learn/guide.ts';
import { decideStanding, STAND_ASKS, STAND_WAIT_TICKS, type StandHold, type StandingDeps } from '../../../src/skills/fly/learn/standing.ts';
import { hopTarget, liveGrid, pickHop, scoutHop, type UnderWorld } from '../../../src/skills/fly/learn/under.ts';
import { LAG_KEEP, LAG_MAX, ROCKET_ADD_WITHIN, RocketHand, RocketLag } from '../../../src/skills/fly/rocket.ts';
import { flatWorld, GLIDE, withBoxes, type BlockBox, type BlockQuery } from '../../../src/skills/input/index.ts';
import { BaseProcess, PRIORITY, ProcessManager, type ProcessKind, type ProcessStatus } from '../../../src/tasks/process/manager.ts';
import { addedSince, StandProcess } from '../../../src/tasks/process/stand.ts';
import type { EntityInfo } from '../../../src/world/types.ts';

const FEET = -60;
const air = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): BlockBox => ({ from: { x: Math.min(x0, x1), y: Math.min(y0, y1), z: Math.min(z0, z1) }, to: { x: Math.max(x0, x1), y: Math.max(y0, y1), z: Math.max(z0, z1) }, solid: false });
const rock = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): BlockBox => ({ ...air(x0, y0, z0, x1, y1, z1), solid: true });
const noPlan = (): never => {
  throw new Error('a line under a roof asks no planner');
};

// ---- fault 1: the proof goes stale while the body walks on ----------------------------------------------------

/**
 * A body on a line, a walker that moves it 0.2 a tick while nothing holds it, and a decision that takes `takes` ticks
 * and answers with the place it was asked from (a proof's start). `fight`: ticks during which another process has the
 * body whatever the hold wants, walking it on.
 */
function rig(o: { takes?: number; fight?: (tick: number) => boolean; never?: boolean } = {}) {
  const body = { x: 0, speed: 0.2 };
  const lines: string[] = [];
  let tick = 0;
  let wanted = false;
  let ended = 0;
  let lost = 0;
  let over = false;
  let had = false;
  let took: string | undefined;
  const fighting = (): boolean => o.fight?.(tick) === true;
  const holds = (): boolean => wanted && !over && !o.never && !fighting();
  const step = (): void => {
    tick++;
    const h = holds();
    if (had && !h && wanted) lost++;
    if (wanted && fighting()) took = 'guard';
    had = h;
    // (held: the walk is paused and the body comes to rest; not held: whatever has it walks it on)
    if (h) body.speed = Math.max(0, body.speed - 0.05);
    else body.speed = 0.2;
    body.x += body.speed;
  };
  const hold: StandHold = {
    get held() {
      return holds();
    },
    get lost() {
      return lost;
    },
    get over() {
      return over;
    },
    end: () => {
      ended++;
      wanted = false;
    },
  };
  const deps: StandingDeps = {
    hold: () => {
      wanted = true;
      had = holds();
      return hold;
    },
    position: () => ({ x: body.x, y: 0, z: 0 }),
    still: () => body.speed === 0,
    waitTicks: (n) => {
      for (let i = 0; i < n; i++) step();
      return Promise.resolve();
    },
    log: (m) => lines.push(m),
    holder: () => (fighting() ? 'guard' : took),
  };
  let asked = 0;
  const decide = async (from: Vec3): Promise<{ from: Vec3 } | undefined> => {
    asked++;
    await deps.waitTicks(o.takes ?? 60);
    return { from };
  };
  return { body, lines, deps, decide, hold, stop: () => (over = true), ticks: () => tick, asked: () => asked, ended: () => ended };
}
const startOf = (a: { from: Vec3 }): Vec3 => a.from;

describe('fly: a flight under a roof is decided standing (Track F22, learn/standing.ts)', () => {
  it('the fault: a decision of 3 s asked from a body another process walks comes for a place 12 blocks behind it', async () => {
    const r = rig();
    // (as the trip did before the track: the decision asked from where the body is, nothing holding it)
    const from = r.deps.position()!;
    const answer = await r.decide(from);
    const moved = Math.abs(r.deps.position()!.x - answer!.from.x);
    expect(moved).toBeCloseTo(12, 5);
    expect(moved).toBeGreaterThan(1);
  });

  it('the rule: the body is held first, comes to rest, and the decision is asked from where it stands then: the answer is fresh', async () => {
    const r = rig();
    const out = await decideStanding(r.deps, 'the flight to the goal', 1, r.decide, startOf);
    expect(out.answer).toBeDefined();
    expect(out).toMatchObject({ asks: 1, stale: 0 });
    // asked from the place the body came to rest at, and the body is still there when the answer comes
    expect(out.answer!.from.x).toBeCloseTo(r.body.x, 9);
    expect(r.body.speed).toBe(0);
    expect(r.lines).toEqual([]);
    expect(r.ended()).toBe(1);
  });

  it('a fight takes the body while the decision runs: the answer is not flown, and the decision is asked once more, standing', async () => {
    // the guard has the body from tick 20 to tick 50 (the first decision runs from about tick 5 to 65)
    const r = rig({ fight: (t) => t >= 20 && t < 50 });
    const out = await decideStanding(r.deps, 'the flight to the goal', 1, r.decide, startOf);
    expect(out).toMatchObject({ asks: 2, stale: 1 });
    expect(out.answer!.from.x).toBeCloseTo(r.body.x, 9);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/^fly: the flight to the goal: the body is \d+\.\d blocks from where the answer was proven \(guard had the body while the decision ran\): not flown from here; asked once more, standing$/);
    expect(r.ended()).toBe(1);
  });

  it('stale a second time in a row: not asked a third time, and the line says what the trip does instead', async () => {
    // the body is taken again and again
    const r = rig({ fight: (t) => t % 40 >= 30 });
    const out = await decideStanding(r.deps, 'the flight to the goal', 1, r.decide, startOf);
    expect(out.answer).toBeUndefined();
    expect(out).toMatchObject({ asks: STAND_ASKS, stale: 2 });
    expect(out.gaveUp).toContain('the second time in a row');
    expect(r.asked()).toBe(2);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[1]).toContain('not asked a third time; the trip walks, and the walk asks again as it gets on');
    expect(r.ended()).toBe(1);
  });

  it('the body is never given to the hold (a fight that goes on): nothing is asked, and the line says who has it', async () => {
    const r = rig({ fight: () => true });
    const out = await decideStanding(r.deps, 'the flight to the goal', 1, r.decide, startOf);
    expect(out).toMatchObject({ asks: 0, stale: 0 });
    expect(out.answer).toBeUndefined();
    expect(r.asked()).toBe(0);
    expect(r.ticks()).toBe(STAND_WAIT_TICKS);
    expect(r.lines[0]).toBe(`fly: the flight to the goal is not decided: guard has the body after ${STAND_WAIT_TICKS} ticks; the trip walks, and the walk asks again as it gets on`);
    expect(r.ended()).toBe(1);
  });

  it('a hold that was stopped (the owner\'s stop) is not waited for; a decision with no answer is no stale answer; an answer with no proven start holds from where the body is', async () => {
    const stopped = rig();
    stopped.stop();
    const a = await decideStanding(stopped.deps, 'the flight', 1, stopped.decide, startOf);
    expect(a).toMatchObject({ asks: 0, gaveUp: 'the stand was stopped' });
    expect(stopped.ticks()).toBe(0);
    const none = rig();
    const b = await decideStanding(none.deps, 'the flight', 1, () => Promise.resolve(undefined), startOf);
    expect(b).toEqual({ asks: 1, stale: 0 });
    expect(none.lines).toEqual([]);
    // (a walk out, a takeoff site: no line begins where the body stood)
    const site = rig({ fight: (t) => t >= 20 && t < 50 });
    const c = await decideStanding(site.deps, 'the flight', 1, site.decide, () => undefined);
    expect(c).toMatchObject({ asks: 1, stale: 0 });
    expect(c.answer).toBeDefined();
  });
});

/** A process that wants the body while `want` is set. */
class Rec extends BaseProcess {
  readonly name: string;
  readonly kind: ProcessKind;
  want = true;
  readonly log: string[];
  private readonly prio: number;
  constructor(name: string, kind: ProcessKind, prio: number, log: string[], persistent = false) {
    super();
    this.name = name;
    this.kind = kind;
    this.prio = prio;
    this.log = log;
    this.persistent = persistent;
  }
  get priority(): number {
    return this.prio;
  }
  override wants(): boolean {
    return !this.done && this.want;
  }
  protected run(_t: number, resumed: boolean): void {
    this.log.push(`${this.name}:${resumed ? 'resume' : 'start'}`);
  }
  protected halt(why: 'pause' | 'stop'): void {
    this.log.push(`${this.name}:${why}`);
  }
  status(): ProcessStatus {
    return { line: this.name };
  }
}

describe('fly: the stand (Track F22, tasks/process/stand.ts) on the process manager', () => {
  it('pauses the chore that walked the body, holds it, and gives it back when the decision ends', () => {
    const log: string[] = [];
    const pm = new ProcessManager();
    const chore = pm.add(new Rec('home-chore', 'auto', PRIORITY.chore, log, true));
    expect(pm.active).toBe(chore);
    let still = 0;
    const stand = pm.add(new StandProcess({ label: 'deciding the flight to the goal', still: () => void still++ }));
    expect(pm.active).toBe(stand);
    expect(stand.held).toBe(true);
    expect(still).toBe(1);
    expect(log).toEqual(['home-chore:start', 'home-chore:pause']);
    expect(pm.stack()[0]).toMatchObject({ name: 'stand', state: 'active', line: 'deciding the flight to the goal' });
    // (busy while it stands: the keepalive nudge does not move the body under the decision)
    expect(pm.busy()).toBe(true);
    stand.end();
    expect(stand.over).toBe(true);
    pm.tick();
    expect(pm.active).toBe(chore);
    expect(log).toEqual(['home-chore:start', 'home-chore:pause', 'home-chore:resume']);
    expect(pm.find('stand')).toEqual([]);
  });

  it('an older command\'s walk is paused too; the guard and the flight on foot take the body from the stand (survival first), and it has it back after', () => {
    const log: string[] = [];
    const pm = new ProcessManager();
    const guard = pm.add(new Rec('guard', 'auto', PRIORITY.guard, log, true));
    guard.want = false;
    const old = pm.add(new Rec('goto', 'user', PRIORITY.user, log));
    pm.tick();
    expect(pm.active).toBe(old);
    const stand = pm.add(new StandProcess({ label: 'deciding', still: () => undefined }));
    expect(pm.active).toBe(stand);
    guard.want = true;
    pm.tick();
    expect(pm.active).toBe(guard);
    expect(stand.held).toBe(false);
    expect(stand.lost).toBe(1);
    expect(stand.over).toBe(false);
    guard.want = false;
    pm.tick();
    expect(pm.active).toBe(stand);
    expect(stand.held).toBe(true);
    stand.end();
    pm.tick();
    expect(pm.active).toBe(old);
  });

  it('cannot outlive its decision: after its longest time it is dropped; the owner\'s stop ends it', () => {
    let now = 0;
    const pm = new ProcessManager();
    const stand = pm.add(new StandProcess({ label: 'deciding', still: () => undefined, now: () => now, maxMs: 1000 }));
    now = 999;
    pm.tick();
    expect(pm.active).toBe(stand);
    now = 1001;
    pm.tick();
    expect(pm.active).toBeUndefined();
    expect(stand.over).toBe(true);
    const other = pm.add(new StandProcess({ label: 'deciding', still: () => undefined }));
    pm.stopUser();
    expect(other.over).toBe(true);
    expect(other.held).toBe(false);
  });

  it('for a trip the bot makes by itself it is automatic and low: a command keeps the body, and a pending home return is not dropped', () => {
    const log: string[] = [];
    const pm = new ProcessManager();
    const home = pm.add(new Rec('home', 'auto', PRIORITY.home, log, true));
    home.want = false;
    const stand = pm.add(new StandProcess({ label: 'deciding the flight home', still: () => undefined, auto: true }));
    expect(stand.kind).toBe('auto');
    expect(stand.priority).toBe(PRIORITY.home);
    expect(pm.active).toBe(stand);
    expect(pm.find('home')).toEqual([home]);
    const cmd = pm.add(new Rec('goto', 'user', PRIORITY.user, log));
    expect(pm.active).toBe(cmd);
    expect(stand.held).toBe(false);
    // (a command's stand does drop it, as any command does)
    pm.add(new StandProcess({ label: 'deciding', still: () => undefined }));
    expect(pm.find('home')).toEqual([]);
  });

  it('the walk\'s own process is the one a watched walk follows: with a fight on when the walk is asked for, the process that has the body is the guard', () => {
    const log: string[] = [];
    const pm = new ProcessManager();
    const guard = pm.add(new Rec('guard', 'auto', PRIORITY.guard, log, true));
    expect(pm.active).toBe(guard);
    const before = new Set(pm.userProcesses());
    const walk = pm.add(new Rec('goto', 'user', PRIORITY.user, log));
    // what the watched walk followed before the track: whatever had the body
    expect(pm.active).toBe(guard);
    expect(pm.active).not.toBe(walk);
    // what it follows now
    expect(addedSince(before, pm.userProcesses())).toBe(walk);
    // (nothing added: none; the newest of several)
    expect(addedSince(new Set(pm.userProcesses()), pm.userProcesses())).toBeUndefined();
    const later = pm.add(new Rec('come', 'user', PRIORITY.user, log));
    expect(addedSince(before, pm.userProcesses())).toBe(later);
  });
});

// ---- the passages -----------------------------------------------------------------------------------------------

/** A straight tunnel 9 wide and 8 high from x 0 to 300 (test/unit/skills/fly-under.test.ts): the live model the columns up to `liveTo`. */
function tunnel(liveTo: number, extra: BlockBox[] = []) {
  const boxes = [rock(-30, FEET, -40, 330, FEET + 59, 40), air(0, FEET, -4, 300, FEET + 7, 4), ...extra];
  const q: BlockQuery = withBoxes(flatWorld(), boxes);
  const cls = (x: number, y: number, z: number): number => (q.solidAt(x, y, z) ? ENTRY_SOLID : ENTRY_AIR);
  const w: UnderWorld = { live: (x, y, z) => (x <= liveTo ? cls(x, y, z) : undefined), cached: cls };
  return { w, o: { burn: burnRange(1), top: FEET + 100 } };
}

/**
 * A passage 7 wide and 7 high with a top: 60 blocks level, a climb of 20 over 100, a top of 10, a fall of 40 over 50 (the
 * roof coming down with the floor), 84 blocks level to the goal. All of it live.
 */
function passage() {
  const boxes: BlockBox[] = [rock(-30, FEET - 60, -40, 400, FEET + 90, 40), air(0, FEET, -3, 60, FEET + 6, 3)];
  let x = 60;
  let y = FEET;
  for (let i = 0; i < 20; i++) {
    y += 1;
    boxes.push(air(x, y, -3, x + 6, y + 6, 3));
    x += 5;
  }
  boxes.push(air(x, y, -3, x + 12, y + 6, 3));
  x += 10;
  for (let i = 0; i < 10; i++) {
    y -= 4;
    boxes.push(air(x, y, -3, x + 6, y + 10, 3));
    x += 5;
  }
  boxes.push(air(x, y, -3, x + 84, y + 6, 3));
  const q: BlockQuery = withBoxes(flatWorld(), boxes);
  const cls = (xx: number, yy: number, zz: number): number => (q.solidAt(xx, yy, zz) ? ENTRY_SOLID : ENTRY_AIR);
  const w: UnderWorld = { live: cls, cached: cls };
  const sim: SimDeps = { world: { solidAt: (xx, yy, zz) => q.solidAt(xx, yy, zz) === true } };
  return { w, sim, goal: { x: x + 80, y, z: 0 }, o: { rockets: 64, burn: burnRange(1), margin: 15, top: FEET + 100, plan: noPlan } };
}
const from: Vec3 = { x: 0.5, y: FEET, z: 0.5 };

describe('fly: what a walking body asks instead of a proof (Track F22, learn/under.ts scoutHop)', () => {
  const goal = { x: 296, y: FEET, z: 0 };

  it('a hop may be there: the whole way in the live model, or a floor to end a piece on; nothing is simulated', () => {
    const whole = tunnel(400);
    const a = scoutHop(whole.w, from, goal, whole.o);
    expect(a.may).toBe(true);
    expect(a.why).toMatch(/^\d+ lines? to prove$/);
    const piece = tunnel(150);
    expect(scoutHop(piece.w, from, goal, piece.o).may).toBe(true);
  });

  it('no hop may be there: no way, a line too short to fly, no head room over the start, no live model: the walk does not stop', () => {
    const shut = tunnel(400, [rock(120, FEET, -4, 122, FEET + 7, 4)]);
    const a = scoutHop(shut.w, from, goal, shut.o);
    expect(a).toMatchObject({ may: false });
    expect(a.why).toContain('no way under the roof');
    const t = tunnel(400);
    // 40 blocks from the goal: a crafted rocket's least line is 65
    const b = scoutHop(t.w, { x: 256.5, y: FEET, z: 0.5 }, goal, t.o);
    expect(b.may).toBe(false);
    expect(b.why).toContain('too short to fly');
    // a block two over the start's floor: a jump needs three of air to take a glide
    const low = tunnel(400, [rock(0, FEET + 2, 0, 0, FEET + 7, 0)]);
    const c = scoutHop(low.w, from, goal, low.o);
    expect(c.may).toBe(false);
    expect(c.why).toContain('of air over the start');
    const cold = tunnel(-1000);
    const d = scoutHop(cold.w, from, goal, cold.o);
    expect(d.may).toBe(false);
    expect(d.why).toContain('the live model ends 0 cells along a way of');
  });
});

// ---- fault 2: a burn's end seen late -------------------------------------------------------------------------------

describe('fly: how late a connection\'s rockets are seen (Track F22, rocket.ts RocketLag)', () => {
  it('none measured: a local server\'s lag; the usual add lag and one; one slow packet in forty does not set it; at most LAG_MAX', () => {
    const lag = new RocketLag();
    expect(lag.late).toBe(GLIDE.boostEndLag);
    expect(lag.usual).toBeUndefined();
    // a local server: the entity 1 tick after the use (2 at times)
    for (const n of [1, 1, 2, 1, 1, 1, 2, 1, 1, 1]) lag.note(n);
    expect(lag.usual).toBe(2);
    expect(lag.late).toBe(3);
    // one entity 6 ticks late among them (the Realm's log has one): the longest is said, the lag is not set by it
    for (let i = 0; i < 29; i++) lag.note(1);
    lag.note(6);
    expect(lag.count).toBe(LAG_KEEP);
    expect(lag.worst).toBe(6);
    expect(lag.usual).toBe(1);
    expect(lag.late).toBe(GLIDE.boostEndLag);
    // a connection a round trip of 4 ticks away
    const far = new RocketLag();
    for (let i = 0; i < 20; i++) far.note(i % 2 ? 5 : 4);
    expect(far.late).toBe(6);
    const worse = new RocketLag();
    for (let i = 0; i < 20; i++) worse.note(30);
    expect(worse.late).toBe(LAG_MAX);
    // only the last LAG_KEEP count
    for (let i = 0; i < LAG_KEEP; i++) far.note(1);
    expect(far.late).toBe(GLIDE.boostEndLag);
  });

  it('the rocket hand measures it: the ticks from a use to its entity, also for one written off that came after all, and from the use to the removal', () => {
    const state = { pos: { x: 0, y: 100, z: 0 } };
    let add: ((e: EntityInfo) => void) | undefined;
    let remove: ((e: EntityInfo) => void) | undefined;
    const ends: (number | undefined)[] = [];
    const slots = [{ name: 'firework_rocket', count: 64, networkId: 1000, flight: 1 }, ...Array.from({ length: 35 }, () => null)];
    const lag = new RocketLag();
    const h = new RocketHand({
      loop: { state, boost: () => undefined, endBoost: (ago?: number) => void ends.push(ago) },
      queue: () => undefined,
      inventory: { slots, selected: 0, rawItem: () => undefined } as never,
      hotbar: { select: () => true, rawItem: () => undefined },
      entities: { onAdd: (fn) => ((add = fn), () => undefined), onRemove: (fn) => ((remove = fn), () => undefined) },
      lag,
    });
    let now = 0;
    h.attach(() => now);
    const at = (t: number): void => {
      now = t;
      h.tick(t);
    };
    const rocket = (id: bigint): EntityInfo => ({ type: 'minecraft:fireworks_rocket', pos: { ...state.pos }, uniqueId: id }) as unknown as EntityInfo;
    at(10);
    h.fire(0, { ...state.pos }, 10);
    at(12);
    add!(rocket(1n));
    at(38);
    remove!(rocket(1n));
    expect(h.adds).toEqual([2]);
    expect(h.lasted).toEqual([28]);
    expect(ends).toEqual([undefined]);
    // a use whose entity comes a tick after it was written off: that rocket did fire, and its lag is counted
    at(50);
    h.fire(0, { ...state.pos }, 50);
    at(50 + ROCKET_ADD_WITHIN + 1);
    expect(h.wasted).toBe(1);
    add!(rocket(2n));
    expect(h.late).toBe(1);
    expect(h.adds).toEqual([2, ROCKET_ADD_WITHIN + 1]);
    expect(lag.count).toBe(2);
    expect(lag.worst).toBe(ROCKET_ADD_WITHIN + 1);
    // a new flight: its own list, the bot's record kept
    h.reset();
    expect(h.adds).toEqual([]);
    expect(h.lasted).toEqual([]);
    expect(lag.count).toBe(2);
  });
});

// ---- a third fault, found on the replica: a touchdown that counted a fall ------------------------------------------

/**
 * A passage 7 wide and 7 high: 80 blocks level, a fall of 35 over 35 (the roof coming down with the floor), 8 blocks
 * level with the goal 4 blocks into them: the line falls a block a tick right down to its touchdown.
 */
function chute() {
  const boxes: BlockBox[] = [rock(-30, FEET - 80, -40, 400, FEET + 90, 40), air(0, FEET, -3, 80, FEET + 6, 3)];
  let x = 80;
  let y = FEET;
  for (let i = 0; i < 7; i++) {
    y -= 5;
    boxes.push(air(x, y, -3, x + 6, y + 11, 3));
    x += 5;
  }
  boxes.push(air(x, y, -3, x + 8, y + 6, 3));
  const q: BlockQuery = withBoxes(flatWorld(), boxes);
  const cls = (xx: number, yy: number, zz: number): number => (q.solidAt(xx, yy, zz) ? ENTRY_SOLID : ENTRY_AIR);
  const w: UnderWorld = { live: cls, cached: cls };
  const sim: SimDeps = { world: { solidAt: (xx, yy, zz) => q.solidAt(xx, yy, zz) === true } };
  return { w, sim, goal: { x: x + 4, y, z: 0 }, o: { rockets: 64, burn: burnRange(1), margin: 15, top: FEET + 100, plan: noPlan } };
}

describe('fly: a hop\'s touchdown and the fall the server counts (Track F22, learn/entry.ts ENTRY_SINK_MAX, glide.ts SimResult.fall)', () => {
  const flown = async (c: ReturnType<typeof chute>, h: NonNullable<Awaited<ReturnType<typeof pickHop>>['hop']>, burn: number) => {
    const g = h.drawn.guide;
    const sim = await simulateFlight(c.sim, from, hopTarget(h.drawn, h.cell), { cruiseY: from.y + 24, margin: 15, goArounds: 0, takeoffYaw: g.yaw, route: { grid: liveGrid(c.w), plan: noPlan }, routeTakeoff: routeTakeoffOptions(h.route, true) }, { rockets: 64, yaw: g.yaw, maxTicks: 900, burn, endLag: GLIDE.boostEndLag });
    const e = sim.end!.landedAt;
    return { fall: sim.fall ?? 0, hurt: damageForCounted(sim.fall ?? 0), beside: Math.hypot(e.x - h.cell.x - 0.5, e.z - h.cell.z - 0.5), ok: sim.end!.ok };
  };

  it('the fault: a line that falls a block a tick down to its touchdown is flown at a sink over 0.5 all the way, and a touchdown that comes before a slower tick counts the whole fall: a death the old proof did not see', async () => {
    const c = chute();
    ENTRY_SWITCH.sink = false;
    PROOF_SWITCH.fall = false;
    try {
      // as before the track: proven
      const old = await pickHop(c.w, c.sim, from, c.goal, 'the goal', c.o);
      expect(old.hop, old.said).toBeDefined();
      // ... and one of its own burns lands with the fall counted (it stands by the touchdown all the same)
      const f = await flown(c, old.hop!, 21);
      expect(f.ok).toBe(true);
      expect(f.beside).toBeLessThanOrEqual(2);
      expect(f.fall).toBeGreaterThan(30);
      expect(f.hurt).toBeGreaterThanOrEqual(20);
      // the proof that looks at the counted fall refuses the line, and says why
      PROOF_SWITCH.fall = true;
      const strict = await pickHop(c.w, c.sim, from, c.goal, 'the goal', c.o);
      expect(strict.tried.join(' | ')).toMatch(/comes down with a fall of 3\d blocks counted \(its sink was over 0\.5 a tick all the way down to the touchdown: \d+ damage\) at a burn of 21 ticks: refused/);
    } finally {
      ENTRY_SWITCH.sink = true;
      PROOF_SWITCH.fall = true;
    }
  }, 240_000);

  it('the rule: on a hop\'s last blocks a body that sinks faster than ENTRY_SINK_MAX looks no farther down than level: every burn lands free, by its touchdown, and the hop is proven', async () => {
    expect(ENTRY_SINK_MAX).toBeLessThan(-GLIDE.fallResetVy);
    const c = chute();
    const pick = await pickHop(c.w, c.sim, from, c.goal, 'the goal', c.o);
    expect(pick.hop, pick.said).toBeDefined();
    for (let burn = 19; burn <= 31; burn++) {
      const f = await flown(c, pick.hop!, burn);
      expect(f.ok, `burn ${burn}`).toBe(true);
      expect(f.hurt, `burn ${burn}: a fall of ${f.fall.toFixed(1)} counted`).toBe(0);
      expect(f.beside, `burn ${burn}`).toBeLessThanOrEqual(2);
    }
  }, 240_000);
});

describe('fly: a burn\'s end seen late, in the simulation and in a hop\'s proof (Track F22, glide.ts)', () => {
  it('the loop\'s body flies on boosted for the ticks the removal is behind, and the brain steers that body: the same burns end elsewhere', async () => {
    const p = passage();
    const pick = await pickHop(p.w, p.sim, from, p.goal, 'the goal', p.o);
    const h = pick.hop!;
    expect(h, pick.said).toBeDefined();
    const g = h.drawn.guide;
    const fly = async (late: number) => {
      let off = 0;
      const sim = await simulateFlight(p.sim, from, hopTarget(h.drawn, h.cell), { cruiseY: from.y + 24, margin: 15, goArounds: 0, takeoffYaw: g.yaw, route: { grid: liveGrid(p.w), plan: noPlan }, routeTakeoff: routeTakeoffOptions(h.route, true) }, {
        rockets: 64,
        yaw: g.yaw,
        maxTicks: 900,
        burn: (r) => [31, 24, 31][Math.min(2, r)]!,
        endLate: () => late,
        until: (_b, body) => {
          if (body.gliding) off = Math.max(off, guideNearest(g, body.pos).dist);
          return false;
        },
      });
      const e = sim.end!.landedAt;
      return { sim, off, from: Math.hypot(e.x - h.cell.x - 0.5, e.z - h.cell.z - 0.5) };
    };
    const near = await fly(2);
    const far = await fly(14);
    // seen 2 ticks late (a local server): standing by the touchdown
    expect(near.sim.end!.ok).toBe(true);
    expect(near.from).toBeLessThanOrEqual(2);
    // seen 14 ticks late: the body is not where the looks were chosen for; it comes down beside the touchdown
    expect(far.from).toBeGreaterThan(2);
    expect(far.sim.stats.rockets).toBe(near.sim.stats.rockets);
  }, 120_000);

  it('the proof flies it: at a local server\'s lag the hop is proven with HOP_LATE_SIMS flights more; at a lag it is lost with, refused with a line that says so; with none given, as before', async () => {
    const p = passage();
    const plain = await pickHop(p.w, p.sim, from, p.goal, 'the goal', p.o);
    expect(plain.hop, plain.said).toBeDefined();
    expect(plain.said).not.toContain('ticks late');
    // (the lag a local server shows: nothing more is flown)
    expect(HOP_LATE_FREE).toBe(3);
    const local = await pickHop(p.w, p.sim, from, p.goal, 'the goal', { ...p.o, late: HOP_LATE_FREE });
    expect(local.sims).toBe(plain.sims);
    const four = await pickHop(p.w, p.sim, from, p.goal, 'the goal', { ...p.o, late: 4 });
    expect(four.hop, four.said).toBeDefined();
    expect(four.sims).toBe(plain.sims + HOP_LATE_SIMS);
    const late = await pickHop(p.w, p.sim, from, p.goal, 'the goal', { ...p.o, late: 14 });
    expect(late.hop, late.said).toBeUndefined();
    expect(late.said).toContain("clear at every burn and mix with a burn's end seen 2 ticks late; with it seen 14 ticks late, as this connection's rockets are, and burns of ");
    expect(late.said).toContain('-> no hop');
  }, 240_000);
});

// ---- the owner's cave (the private fixture; F22_CAVE_DIR) --------------------------------------------------------

const caveDir = process.env.F22_CAVE_DIR;
describe.skipIf(!caveDir)('fly: the Realm\'s lost hop on the fixture (Track F22; F22_CAVE_DIR=<the fixture of 2026-11-20 or later>)', () => {
  it('from cave_end with the whole way live: flown with a burn\'s end seen 6 ticks late some flights end on a roof by the line\'s top, seen 2 late none; the proof with the lag refuses the line', async () => {
    const cu = caveUnderWorld(40, caveDir)!;
    const c0 = cu.cellOf('cave_end');
    const start = { x: c0.x + 0.5, y: c0.y, z: c0.z + 0.5 };
    const goal = cu.cellOf('cave_start');
    cu.stand(start);
    const burn = burnRange(1);
    const o = { rockets: 64, burn, margin: 15, top: Math.min(319, Math.max(start.y, goal.y) + 64), plan: noPlan };
    const pick = await pickHop(cu.w, cu.liveSim, start, goal, 'cave_start', o);
    const h = pick.hop!;
    expect(h, pick.said).toBeDefined();
    expect(h.piece).toBeUndefined();
    const g = h.drawn.guide;
    const series = async (late: number) => {
      let seed = 1;
      const rnd = (): number => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      const roofs: number[] = [];
      let stood = 0;
      for (let k = 0; k < 30; k++) {
        const of: number[] = [];
        let at = 0;
        const sim = await simulateFlight(cu.liveSim, start, hopTarget(h.drawn, h.cell), { cruiseY: start.y + 24, margin: 15, goArounds: 0, takeoffYaw: g.yaw, route: { grid: liveGrid(cu.w), plan: noPlan }, routeTakeoff: routeTakeoffOptions(h.route, true) }, {
          rockets: 64,
          yaw: g.yaw,
          maxTicks: 200 + 1.5 * h.route.ticks,
          burn: (r) => (of[r] ??= burn.min + Math.floor(rnd() * 13)),
          endLate: () => late,
          until: (_b, body) => {
            if (body.gliding) at = guideNearest(g, body.pos).at;
            return false;
          },
        });
        const e = sim.end?.landedAt;
        if (e && Math.hypot(e.x - h.cell.x - 0.5, e.z - h.cell.z - 0.5) <= 2 && !sim.hard) stood++;
        else if (sim.end && !sim.end.ok && sim.end.reason === 'roof') roofs.push(at);
      }
      return { stood, roofs };
    };
    const local = await series(2);
    expect(local).toEqual({ stood: 30, roofs: [] });
    const far = await series(6);
    expect(far.roofs.length).toBeGreaterThanOrEqual(2);
    // (the Realm's flight was lost 282 to 286 blocks along this line: the top, where it falls away into the pit)
    for (const at of far.roofs) expect(at / h.length).toBeGreaterThan(0.45);
    for (const at of far.roofs) expect(at / h.length).toBeLessThan(0.7);
    const proven = await pickHop(cu.w, cu.liveSim, start, goal, 'cave_start', { ...o, late: 4 });
    expect(proven.hop, proven.said).toBeDefined();
    const refused = await pickHop(cu.w, cu.liveSim, start, goal, 'cave_start', { ...o, late: 6 });
    expect(refused.hop).toBeUndefined();
    expect(refused.said).toContain('with it seen 6 ticks late');
  }, 600_000);
});
