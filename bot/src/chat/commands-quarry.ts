// `!quarry` and `!tunnel` (wave 11, Track BK; docs/mining.md "Quarry and tunnel", docs/decisions/0053),
// owner-only like every command:
//   !quarry here <w> <d> <depth> [north|south|east|west]   the box in front of the bot (the way it faces,
//                                                          or the direction given): d forward, w wide,
//                                                          from the block under its feet down depth layers
//   !quarry <x1> <y1> <z1> <x2> <y2> <z2>                  any box (inclusive), at most 64 on every side
//   !tunnel <here|north|south|east|west> <length> [<w>x<h>] a straight tunnel from the bot's feet, default 3x3
//   !quarry stop | status, !tunnel stop | status
// Both are user processes (tasks/process/quarry.ts) over skills/mine/quarry.ts: layer by layer (a
// cross-section at a time), a staircase kept in the quarry's wall, the break rules on every cell (inside
// the base too, the owner gave the box, but never built blocks or containers), the stash step when full.
// Registered by the afk task (tasks/registry.ts, one line). Without walking: `quarry needs a task that can walk`.
// Refused at the start: a quarry box farther than 64 blocks or not loaded, a player in or over the box.
// The stair treads are the navigator's kept cells while the job lives (Navigator.keptCells).
import { fmtCell } from '../skills/build/types.ts';
import { entityFeet, isPlayerEntity } from '../skills/combat/hostiles.ts';
import { breakBlocker } from '../skills/nav/actions.ts';
import { cellKey } from '../skills/nav/grid.ts';
import { carriesPickaxe } from '../skills/mine/branch.ts';
import { checkQuarrySite, dirName, parseQuarryArgs, parseTunnelArgs, playerOver, QuarryJob, type QuarryHost, type QuarryKind, type QuarrySpec } from '../skills/mine/quarry.ts';
import { feetFloorOf, minerTunnelWorld, throwawayCount } from '../skills/mine/wire.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import { settingsMover } from '../tasks/process/goto.ts';
import { formatEta } from '../tasks/process/manager.ts';
import { QuarryProcess } from '../tasks/process/quarry.ts';

/** The running quarry / tunnel process by task (tests). */
const current = new WeakMap<object, () => QuarryProcess | undefined>();

export function quarryProcessOf(task: object): QuarryProcess | undefined {
  return current.get(task)?.();
}

/** The end line of a job. */
export function quarryEndLine(job: QuarryJob, state: string): string {
  const climb = job.stats.climb && !job.stats.climb.ok ? `; could not get back up: ${job.stats.climb.why ?? 'failed'}` : '';
  const why = state === 'done' ? '' : `; ${state}${job.lastError ? `: ${job.lastError}` : ''}`;
  const secs = job.stats.startedAt !== undefined ? ((Date.now() - job.stats.startedAt) / 1000).toFixed(0) : '0';
  const items = Object.entries(job.stats.dugBy)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([n, c]) => `${c} ${n}`)
    .join(', ');
  return `${job.summary()}${state === 'done' ? ' done' : ''} in ${secs} s${items ? ` [${items}]` : ''}${job.stats.torches ? `, ${job.stats.torches} torches` : ''}${why}${climb}`;
}

export function registerQuarryCommands(d: CommandDeps): void {
  const { processes, mobility: mob, skills, world } = d;
  if (!processes || !mob || !skills || !world) {
    for (const name of ['quarry', 'tunnel']) d.chat.register({ name, help: '(needs walking)', run: ({ reply }) => reply(d.needsWalking(name)) });
    return;
  }
  const log = d.log;
  const mover = settingsMover(skills, d.settings);
  const nav = skills.nav;
  const players = () => [...world.entities.values()].filter(isPlayerEntity).map(entityFeet);
  const host: QuarryHost = {
    blockAt: (p) => world.blockAt(p),
    // the box was given by the owner: no protected area, every other break rule (built blocks, containers, liquids, gravity, the floor under the feet)
    breakRule: (q) => breakBlocker(nav.grid, q.x, q.y, q.z, {}, feetFloorOf(mob.loop.state.pos)),
    players,
    keepCells: (cells, on) => {
      for (const c of cells) {
        const k = cellKey(c.x, c.y, c.z);
        if (on) nav.keptCells.add(k);
        else nav.keptCells.delete(k);
      }
    },
    position: () => mob.position(),
    onGround: () => mob.loop.state.onGround,
    goto: (g, o) => mover.goto(g, o),
    place: (p, o) => skills.place(p, o),
    dig: (p) => skills.dig(p),
    collect: (r, t, take) => skills.collect(r, t, take ? { filter: (i) => take(i.name) } : {}),
    waitTicks: (n) => mob.loop.waitTicks(n),
    inventory: world.inventory,
    slots: () => world.inventory.slots,
    throwawayMin: () => d.settings.get('throwawayMin'),
    cancel: () => skills.cancel(),
    // the climb back up at the end: the miner's rules (the protected area included: it digs outside the box)
    tunnelWorld: minerTunnelWorld({ skills, world }),
    throwaways: () => throwawayCount(world.inventory.slots),
    log,
  };

  let proc: QuarryProcess | undefined;
  const live = (): QuarryProcess | undefined => (proc && !proc.done ? proc : undefined);
  current.set(d.task, live);

  const start = (spec: QuarrySpec, reply: (m: string) => void): void => {
    if (!carriesPickaxe(world.inventory.slots)) return reply(`${spec.kind} needs a pickaxe`);
    if (spec.kind === 'quarry') {
      const why = checkQuarrySite(spec.box, spec.start, (p) => world.blockAt(p));
      if (why) return reply(`quarry: ${why}`);
      const pl = playerOver(spec.box, players());
      if (pl) return reply(`quarry: a player is in or over the box (at ${fmtCell({ x: Math.floor(pl.x), y: Math.floor(pl.y), z: Math.floor(pl.z) })}); step off it first`);
    }
    const old = live();
    if (old) processes.stop(old, 'replaced');
    const job = new QuarryJob(spec, host);
    const p = new QuarryProcess(job, () => d.settings.get('quarryKeepStone'));
    proc = processes.add(p);
    void p.result.then((s) => {
      if (s !== 'stopped') reply(quarryEndLine(job, s));
    });
    const b = spec.box;
    const stairs = spec.keep.length ? `, stairs from ${fmtCell(spec.keep[0]!)}` : '';
    const facing = spec.dir ? ` going ${dirName(spec.dir)}` : '';
    reply(`${spec.label}${facing}: ${fmtCell(b.min)} to ${fmtCell(b.max)}, ${spec.slices.length} ${spec.kind === 'quarry' ? 'layers' : 'blocks'}${stairs}${processes.paused ? ' (held: !resume)' : ''}`);
  };

  const command = (kind: QuarryKind) => ({ reply, args }: { reply: (m: string) => void; args: string[] }) => {
    const a = (args[0] ?? '').toLowerCase();
    const mine = (): QuarryProcess | undefined => {
      const p = live();
      return p?.job.spec.kind === kind ? p : undefined;
    };
    if (a === 'stop' && args.length === 1) {
      const p = mine();
      if (!p) return reply(`not running a ${kind}`);
      processes.stop(p, 'stopped');
      return reply(`stopped; ${p.job.summary()}`);
    }
    if (a === 'status' && args.length === 1) {
      const p = mine();
      if (!p) return reply(`not running a ${kind}`);
      const st = p.status();
      const eta = formatEta(st.etaS);
      return reply(`${st.line}${eta ? `, eta ${eta}` : ''}`);
    }
    const pos = mob.position();
    if (!pos) return reply(`${kind}: not ready yet`);
    const feet = { x: Math.floor(pos.x), y: Math.floor(pos.y + 1e-3), z: Math.floor(pos.z) };
    const r = kind === 'quarry' ? parseQuarryArgs(args, feet, world.self.yaw) : parseTunnelArgs(args, feet, world.self.yaw);
    if ('error' in r) return reply(r.error);
    start(r.spec, reply);
  };

  d.chat.register({
    name: 'quarry',
    group: 'work',
    example: '!quarry here 8 8 4',
    help: `here <w> <d> <depth> [direction] | <x1> <y1> <z1> <x2> <y2> <z2> | stop | status (dig out a box layer by layer for its stone, leaving a staircase out)`,
    run: command('quarry'),
  });
  d.chat.register({
    name: 'tunnel',
    group: 'work',
    example: '!tunnel here 20',
    help: `<here|north|south|east|west> <length> [<w>x<h>] | stop | status (a straight tunnel, default 3x3, torches every 8 when carried)`,
    run: command('tunnel'),
  });
  log.info('quarry: !quarry and !tunnel ready');
}
