// Track BI (docs/pathfinding.md "Long falls"): why a goto that ended `unreachable` did not take a long fall.
// One more plan (in-thread, to the end) with the damage budget lifted: when it finds the goal over a drop
// deeper than maxDrop, the note names the drop, its damage and why the live policy refused it (health and
// the margin, burning, a hostile near, health unknown, or long falls switched off).
import type { NavGoal } from '../nav/goals.ts';
import type { Navigator, NavGotoOptions } from '../nav/navigator.ts';
import type { FallGuard } from './clutch.ts';
import { fallPolicy, type FallPolicy } from './policy.ts';

const hp = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export function explainFallRefusal(nav: Pick<Navigator, 'fallPolicy' | 'plan' | 'grid'>, guard: Pick<FallGuard, 'policy' | 'settings' | 'damageOf'>, goal: NavGoal, opts?: NavGotoOptions): string | undefined {
  const live = guard.policy();
  const st = guard.settings();
  const base: FallPolicy =
    live ??
    fallPolicy({ enabled: true, health: 20, healthKnown: true, absorption: 0, margin: st.fallMargin, epf: 0, burning: false, hostileDistance: Infinity, bucket: false, clutchOn: false, waterWorks: true, clutchMax: st.clutchMaxDrop })!;
  const loose: FallPolicy = { ...base, hpBudget: 1000, clutch: false };
  delete loose.blocked;
  const saved = nav.fallPolicy;
  nav.fallPolicy = () => loose;
  let res;
  try {
    res = nav.plan(goal, undefined, opts);
  } finally {
    nav.fallPolicy = saved;
  }
  if (res?.status !== 'found') return undefined;
  let worst: { h: number; dmg: number } | undefined;
  for (let i = 1; i < res.path.length; i++) {
    const a = res.path[i - 1]!;
    const b = res.path[i]!;
    const h = a.feet - b.feet;
    if (b.move !== 'drop' || h <= 3 + 1e-6) continue;
    const landing = nav.grid.cls(b.x, b.feet > b.y + 1e-6 ? b.y : b.y - 1, b.z)?.name;
    const dmg = guard.damageOf(h, landing);
    if (!worst || dmg > worst.dmg) worst = { h, dmg };
  }
  if (!worst) return undefined;
  const what = `the way down is a ${hp(+worst.h.toFixed(1))}-block drop (${hp(+worst.dmg.toFixed(1))} HP)`;
  if (!live) return `${what}; long falls are off (!set longFalls on)`;
  if (live.blocked) return `${what}, refused: ${live.blocked}`;
  if (worst.dmg > live.hpBudget) return `${what}, refused: it would leave ${hp(+(live.hpBudget + st.fallMargin - worst.dmg).toFixed(1))} HP, the margin is ${st.fallMargin}`;
  return undefined;
}
