// A new trip while a flight is in the air (`!goto`, `!come`, `!fly` mid-flight; docs/flight.md "A new trip in
// the air"): the flight is taken over and retargeted there instead of landing first, the trip that started
// it ends `replaced` (its walk never runs), and the new trip does the ground work after the landing. The
// brain flies a retargeted trip to the new goal (offline, stepBody), with the cruise raised for it.
import { describe, expect, it } from 'vitest';
import { RuntimeSettings } from '../../../src/config/settings.ts';
import { FlightBrain } from '../../../src/skills/fly/brain.ts';
import type { FlightController, FlightReport } from '../../../src/skills/fly/controller.ts';
import type { FlightKitOps } from '../../../src/skills/fly/kitops.ts';
import { cruiseHeight, onTarget, type LandingTarget } from '../../../src/skills/fly/plan.ts';
import { flatWorld, GLIDE, IDLE_COMMAND, initialBody, stepBody } from '../../../src/skills/input/index.ts';
import { FlyProcess, type FlyDeps, type FlyTarget } from '../../../src/tasks/process/fly.ts';
import { ProcessManager } from '../../../src/tasks/process/manager.ts';

const FEET = -60;

/** A controller in the air: `flight` resolves when the test lands it; retarget refused while `refuse` is set. */
function fakeController() {
  let land!: (r: FlightReport) => void;
  const flight = new Promise<FlightReport>((r) => (land = r));
  const c = {
    active: true,
    refuse: false,
    landed: 0,
    targets: [] as { target: LandingTarget; cruiseY: number | undefined }[],
    get flight() {
      return c.active ? flight : undefined;
    },
    retarget(target: LandingTarget, o: { cruiseY?: number } = {}) {
      if (c.refuse) return false;
      c.targets.push({ target, cruiseY: o.cruiseY });
      return true;
    },
    landNow() {
      c.landed++;
    },
    status: () => ({ active: c.active, phase: 'cruise', distance: 200, rockets: 1, goArounds: 0, ticks: 100 }),
    land(ok = true) {
      c.active = false;
      land({ ok, ...(ok ? {} : { reason: 'landed_off' }) } as FlightReport);
    },
  };
  return c;
}

function deps(c: ReturnType<typeof fakeController>, said: string[]): FlyDeps {
  const kitOps = {
    wearChestplate: () => Promise.resolve({ ok: true }),
    refillFromBox: () => Promise.resolve({ ok: true, taken: 0 }),
  } as unknown as FlightKitOps;
  return {
    controller: c as unknown as FlightController,
    kitOps,
    inventory: { slots: [], selected: 0 } as unknown as FlyDeps['inventory'],
    memory: () => ({}),
    settings: new RuntimeSettings(),
    position: () => ({ x: 0, y: 40, z: 0 }),
    skyTop: () => FEET - 1,
    cell: () => false,
    say: (m) => said.push(m),
    waitTicks: () => Promise.resolve(),
  };
}

const target = (x: number, z: number, label: string): FlyTarget => ({ x: x + 0.5, z: z + 0.5, top: FEET, half: 1, label });

describe('a new trip in the air takes the flight over', () => {
  it('the old trip ends replaced without landing; the new one retargets the flight (cruise raised) and does the ground work after the landing', async () => {
    const c = fakeController();
    const said: string[] = [];
    const pm = new ProcessManager();
    const old = new FlyProcess(target(0, 300, 'A'), deps(c, said));
    expect(old.adopt()).toBe(true); // stands in for a flight the old trip started itself
    pm.add(old);
    const next = new FlyProcess(target(400, 0, 'B'), deps(c, said));
    old.handOver();
    expect(next.adopt(120)).toBe(true);
    pm.add(next); // replaces the old trip by name
    const r0 = await old.result;
    expect(r0.reason).toBe('replaced');
    expect(c.landed).toBe(0);
    expect(next.retargeted).toBe(true);
    expect(c.targets.map((x) => [(x.target as FlyTarget).label, x.cruiseY])).toEqual([
      ['A', undefined],
      ['B', 120],
    ]);
    c.land(true);
    for (let i = 0; i < 5; i++) pm.tick();
    const r = await next.result;
    expect(r.ok).toBe(true);
    expect(r.target.label).toBe('B');
  });

  it('a retarget the brain refuses (the touchdown is near): the flight lands where it was going; `retargeted` false tells the trip to start again from the ground', async () => {
    const c = fakeController();
    c.refuse = true;
    const pm = new ProcessManager();
    const p = new FlyProcess(target(400, 0, 'B'), deps(c, []));
    expect(p.adopt()).toBe(true);
    pm.add(p);
    expect(p.retargeted).toBe(false);
    c.land(true);
    for (let i = 0; i < 5; i++) pm.tick();
    expect((await p.result).ok).toBe(true);
  });

  it('nothing in the air: no flight to adopt', () => {
    const c = fakeController();
    c.active = false;
    const p = new FlyProcess(target(400, 0, 'B'), deps(c, []));
    expect(p.adopt()).toBe(false);
    expect(p.phase).toBe('prepare');
  });

  it('a stop that is not a handover still lands the flight', async () => {
    const c = fakeController();
    const pm = new ProcessManager();
    const p = new FlyProcess(target(0, 300, 'A'), deps(c, []));
    p.adopt();
    pm.add(p);
    pm.stopUser();
    expect((await p.result).reason).toBe('interrupted');
    expect(c.landed).toBe(1);
  });
});

describe('the brain flies a trip retargeted in the air', () => {
  it('300 north, then in the cruise 500 east with a higher cruise: lands on the new target', () => {
    const w = flatWorld();
    const skyTop = () => FEET - 1;
    const start = { x: 0.5, y: FEET, z: 0.5 };
    const a: LandingTarget = { x: 0.5, z: 300.5, top: FEET, half: 1 };
    const b: LandingTarget = { x: 500.5, z: 150.5, top: FEET, half: 1 };
    const brain = new FlightBrain(a, { cruiseY: cruiseHeight(start, a, skyTop, {}).y, groundAt: () => FEET, skyTop, obstacle: (x, y, z) => w.solidAt(x, y, z) === true, seed: 5 });
    let body = initialBody(start, true);
    let cmd = { ...IDLE_COMMAND };
    let lastFire = -100;
    let retargetedAt: number | undefined;
    for (let t = 1; t < 12000; t++) {
      const fb = { pos: body.pos, vel: body.vel, onGround: body.onGround, gliding: body.gliding ?? false, boostTicks: body.boostTicks ?? 0 };
      if (retargetedAt === undefined && brain.phase === 'cruise' && body.pos.z > 100) {
        expect(brain.retarget(b, fb, { cruiseY: cruiseHeight(body.pos, b, skyTop, {}).y })).toBe(true);
        retargetedAt = t;
      }
      const out = brain.step({ tick: t, body: fb, yaw: cmd.yaw, pitch: cmd.pitch, rockets: 64, canFire: t - lastFire >= 4, health: 20, elytraLeft: 400 });
      const c = out.control;
      cmd = { ...cmd, yaw: c.yaw, pitch: c.pitch, jump: c.jump, glide: c.glide };
      if (c.fire) lastFire = t;
      body = stepBody(body, { ...cmd, ...(c.fire ? { boostStart: GLIDE.boostTicks } : {}) }, w).state;
      if (out.end) {
        expect(retargetedAt).toBeDefined();
        expect(out.end.ok).toBe(true);
        expect(onTarget(b, body.pos)).toBe(true);
        return;
      }
    }
    throw new Error(`the flight never ended (${brain.phase})`);
  });
});
