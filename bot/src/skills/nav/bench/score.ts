// Track R1 (docs/pathfinding.md "Reachability (Track R1)"; decisions/0072-reachability.md): the reachability
// bench's scoring: one record per pair (the oracle's verdict, the navigator's run), the cause-class agreement, and
// the per-class tables.
import type { Vec3 } from '../../../world/types.ts';
import type { Verdict } from './oracle.ts';

/** What the closed loop reports of one run (test/unit/skills/reach-sim.ts PairRun, the fields scored here). */
export interface RunSummary {
  ok: boolean;
  reason?: string;
  note?: string;
  why?: string;
  cause?: string;
  reply: string;
  ticks: number;
  wallMs: number;
  damage: number;
  died: boolean;
  dug: number;
  doors: number;
  placed: number;
  endDist: number;
}

export interface PairRecord {
  cls: string;
  seed: number;
  pair: number;
  tag: string;
  start: Vec3;
  goal: Vec3;
  dist: number;
  oracle: Omit<Verdict, 'path'>;
  run: RunSummary;
  /** The unreachable reply's cause class matches the oracle's (undefined when the run arrived or the oracle reaches it). */
  agree?: boolean;
}

/**
 * The navigator's cause class (SkillResult `cause`, nav/reach.ts) against the oracle's: 'world' for (a), 'rule:<name>'
 * for (b) naming one of the rules the oracle found, any 'rule:' when the oracle needs several together.
 */
export function causeAgrees(o: Omit<Verdict, 'path'>, run: RunSummary): boolean | undefined {
  if (run.ok || o.verdict === 'reachable') return undefined;
  const c = run.cause;
  if (!c) return false;
  if (o.verdict === 'world') return c === 'world';
  if (!c.startsWith('rule:')) return false;
  const named = c.slice(5).split('+');
  return o.rules.length === 0 || named.some((n) => (o.rules as readonly string[]).includes(n));
}

const pct = (a: number[], q: number): number => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};

/** The per-class tables (markdown). */
export function scoreTables(recs: readonly PairRecord[]): string {
  const classes = [...new Set(recs.map((r) => r.cls))];
  const rows: string[] = [];
  rows.push('| class | pairs | oracle reachable (plain / dig or fall) | rule (b) | world (a) | arrived | arrived of reachable | FALSE UNREACHABLE | nav arrived, oracle not | cause agrees | deaths | damage p50 / p90 / max | ticks p50 / p90 | wall s p50 / p90 |');
  rows.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  const line = (name: string, rs: readonly PairRecord[]): void => {
    const reach = rs.filter((r) => r.oracle.verdict === 'reachable');
    const plain = reach.filter((r) => r.oracle.plain).length;
    const rule = rs.filter((r) => r.oracle.verdict === 'rule').length;
    const world = rs.filter((r) => r.oracle.verdict === 'world').length;
    const arrived = rs.filter((r) => r.run.ok).length;
    const arrivedReach = reach.filter((r) => r.run.ok).length;
    const falseU = reach.filter((r) => !r.run.ok).length;
    const navOnly = rs.filter((r) => r.run.ok && r.oracle.verdict !== 'reachable').length;
    const causes = rs.filter((r) => r.agree !== undefined);
    const agree = causes.filter((r) => r.agree).length;
    const deaths = rs.filter((r) => r.run.died).length;
    const dmg = rs.map((r) => r.run.damage);
    const ticks = rs.filter((r) => r.run.ok).map((r) => r.run.ticks);
    const wall = rs.map((r) => r.run.wallMs / 1000);
    const pc = (n: number, d: number): string => (d ? `${n} (${((100 * n) / d).toFixed(1)} %)` : `${n}`);
    rows.push(
      `| ${name} | ${rs.length} | ${reach.length} (${plain} / ${reach.length - plain}) | ${rule} | ${world} | ${arrived} | ${pc(arrivedReach, reach.length)} | **${pc(falseU, reach.length)}** | ${navOnly} | ${causes.length ? pc(agree, causes.length) : '-'} | ${deaths} | ${pct(dmg, 0.5)} / ${pct(dmg, 0.9)} / ${Math.max(0, ...dmg)} | ${pct(ticks, 0.5)} / ${pct(ticks, 0.9)} | ${pct(wall, 0.5).toFixed(1)} / ${pct(wall, 0.9).toFixed(1)} |`,
    );
  };
  for (const c of classes) line(c, recs.filter((r) => r.cls === c));
  line('**all**', recs);
  return rows.join('\n');
}
