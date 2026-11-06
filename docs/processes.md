# Process manager and runtime settings (PLAN.md tasks 7.8 and 7.9)

Everything that moves the bot on the AFK task is a **process**, and one **ProcessManager** gives
control to exactly one of them at a time. The knobs those processes read (guard radius, flee health,
may the planner dig, ...) are **runtime settings** that the owner changes from chat with `!set` and
that survive a restart. Decision record: [decisions/0012-process-manager-and-settings.md](decisions/0012-process-manager-and-settings.md).
Model: Baritone's `PathingControlManager` (every tick the highest-priority process that wants
control gets it).

## Files

| Path | What |
|---|---|
| `bot/src/tasks/process/manager.ts` | `ProcessManager`, the `Process` interface, `BaseProcess`, `PRIORITY`, `formatStack` |
| `bot/src/tasks/process/goto.ts` | `GotoProcess` (`!goto`, `!home go`, the home return), `settingsMover`, the ETA (`navRemaining`, `etaFor`) |
| `bot/src/tasks/process/night.ts` | `NightProcess` around `NightSafety` (tasks/night.ts) |
| `bot/src/tasks/process/gather.ts` | `GatherProcess` and `AfkGather`: `!gather N [x y z]` on the afk task |
| `bot/src/tasks/process/deps.ts` | `CommandDeps`: what every command registration of the afk task receives |
| `bot/src/tasks/pve.ts` | `PveController` and its processes: flee, guard, follow, come, kill |
| `bot/src/tasks/registry.ts` | the afk task: builds the manager, the processes, the settings wiring and the command registration list |
| `bot/src/config/settings.ts` | `RuntimeSettings`, `SETTING_DEFS`, the settings file location and start-up precedence |
| `bot/src/chat/commands.ts` | `!pause`, `!resume` (`registerProcessCommands`), `!set` (`registerSettingsCommands`), the `!status` stack line |
| `bot/src/chat/commands-pve.ts` | `!stop` (with `!follow` `!come` `!guard` `!kill`) |
| `bot/test/unit/process-manager.test.ts`, `afk-processes.test.ts`, `settings.test.ts` | unit tests on fakes |
| `bot/test/e2e/core-process.test.ts`, `core-settings.test.ts`, `core-truth.ts` | e2e on bds-core |
| `docker/compose.core.yml` | `bds-core`, udp/19180, flat, difficulty normal |

## Processes and priorities

| Priority | Process | Kind | Wants control while | Pre-empted (pause) | Resumed |
|---|---|---|---|---|---|
| 101 | `flight` (Track AU, docs/flight.md) | auto | a flight is in the air (from the takeoff to the body standing again): nothing pre-empts a glide; the controller itself lands when the health drops under `fleeHealth`, when the elytra nears `toolWearLimit` + 20 uses, on `!fly stop` / `!land` / `!stop` | never | - |
| 100 | `flee` | auto | health < `fleeHealth` with a hostile within 16, or a creeper within 8 with health < 10 (not while night safety walks to the shelter; a lone melee mob the bot can still take 3 hits from is duelled instead); runs away to 16 blocks first, then home or the shelter when the threat is not in the way, eating once 8 blocks clear; recovery until `fleeHealth` + 6 for up to 60 s (docs/pve.md "Flee v2"); after a flight a cooldown keeps it from starting again at once, except an urgent one: a hard trigger with the threat within 6 blocks (`FLEE_URGENT`), away from home / the shelter and not after a cornered end, bypasses the cooldown | (only a death) | walks again to the same place |
| 85 | `guard` defending in place | auto | a hostile within reach while inside the night shelter or while the health is low | fight cancelled | a new target is picked |
| 80 | `night` | auto | dusk to dawn with a shelter set: walking there, a retreat due, or inside (it holds the bot there) | the retreat is cancelled, not counted as a failed attempt (`waiting`) | the retreat is planned again |
| 60 | `guard` fight | auto | guard on and a hostile within `guardRadius` of home (of the bot while a command runs); not while a kill job exists | fight cancelled (the episode ends) | a new target is picked |
| 40 | `fly` (Track AU; AU2: the sky check before the jump, `fly: no open sky here (roof at y 72, 3 blocks up); walk outside first`) | user | the ground work of a flight: the refill from the fireworks box, the elytra on, the takeoff; the landing's chestplate swap and refill | the ground step is cancelled (the flight itself is the `flight` process above) | the ground step runs again |
| 40 | `goto` `follow` `come` `kill` `gather` | user | until done or stopped | navigator / follower / fight cancelled, gather paused (`GatherWoodTask.pause`) | goto planned again, follow restarted, come re-aimed, kill looks for its next target, gather goes on from find-tree |
| 30 | `food` chore (Track X, docs/food.md) | auto | by day, with no user process, while the food carried is below `foodMin` and a target is in range | the hunt or the cooking is cancelled, the job remembers its progress | continues the job; backs off 10 min after an empty attempt |
| 20 | `home` | auto | requested (after a guard fight with nothing else queued, at dawn, after a respawn) and not yet home | navigator cancelled | planned again |
| - | idle | | nothing wants control: the bot stands; the keepalive nudge runs | | |

User processes **stack**: a new command pre-empts the running one, which resumes when the new one
ends (`!come` while following: come, then follow again). A new command with the same name replaces
the old one (`!goto` while walking somewhere else; the old promise ends `interrupted`). Any new
command drops a pending home return (the owner moved the bot on purpose).

The keepalive nudge (tasks/afk.ts) is not a process: it runs while no process moves the bot (no
active process, or the night process holding the bot inside the shelter).

### Pre-emption matrix

Row: the process in control. Column: a process that starts wanting control.

| running \ arriving | flee | guard in place | night | guard fight | new command | home return |
|---|---|---|---|---|---|---|
| **flee** | - | waits | waits | waits | waits (queued) | waits |
| **guard in place** | pre-empts | - | waits | - | waits | waits |
| **night** (going / sheltered) | pre-empts (not while going) | pre-empts | - | not wanted (on the way: no fight; inside: in place only) | waits until dawn | waits |
| **guard fight** | pre-empts (the fight is dropped; a kill job is stopped) | - | pre-empts | - | waits | waits |
| **command** (goto, follow, come, kill, gather) | pre-empts | pre-empts | pre-empts | pre-empts (not a kill job) | stacks on top (same name: replaces) | not requested (guard), else waits |
| **home return** | pre-empts | pre-empts | pre-empts | pre-empts | drops it | replaces it |
| **idle** | starts | starts | starts | starts | starts | starts |

### Commands

| Command | Effect |
|---|---|
| `!pause` | holds every user process (the active one stops where it is); guard, flee and night keep running. `paused: walking to 10 -60 3 (!resume to continue)`. Commands given while paused wait too. |
| `!resume` | releases them; the newest continues. `resumed: walking to 10 -60 3` |
| `!stop` | stops every user process (the active one and those it pre-empted) and a pending home return; guard stays on, night keeps running. `stopped (was walking to 10 -60 3, 31 blocks left); guarding r=16` |
| `!status` | the status line (with `behaviour ...`) and a second line with the stack: `processes: [active] walking to 10 -60 3, 31 blocks left, eta 6 s; [paused] gather 3/8 logs (paused, 1 trees), eta 40 s`; `[held]` while `!pause` holds them; `processes: idle` |
| `!gather N [x y z]` / `!gather stop` / `!gather` | gather N logs (into the chest at x y z, else the `--chest`, else keep them) as a user process |

Other rules:

- **Death**: every process is paused while the bot is dead and until the chunks around the respawn
  point are in (`settling`); follow, come, kill, goto, a home return and the current fight / flight
  are dropped at the death, a gather survives it (paused, resumed, the death is counted). The
  after-respawn hook then requests the home return (unless night safety wants the shelter).
- **Kill**: guard does not fight while a kill job exists (the kill job fights already); a flight
  stops the kill job; `!kill` ends a running guard fight.
- **Guard radius centre**: home while no command runs, the bot itself while a command runs or when
  no home is set.
- **Night**: while unreachable or given up (docs/runbook.md "Night safety") the night process does
  not want control, so guard and the owner's commands run.

### ETA

`goto`, `come`, `home`, `flee` and the night retreat: the remaining length of the navigator's plan
from the bot (`navRemaining`: the polyline from the bot through the nodes not yet passed, plus the
octile distance from a partial plan's last node to the goal) divided by the speed measured in this
goto (distance / ticks of the navigator's report, once it ran 40 ticks; before that the steady
sprint or walk speed, 1/3.564 or 1/4.633 blocks per tick), at 20 ticks per second. `gather`: logs
left times the time per log so far (paused time excluded). The navigator has no public accessor for
its plan yet; `navRemaining` reads its `active` record read-only (an open issue for the nav track).

## Settings

| Key | Default | Bounds | Read by |
|---|---|---|---|
| `allowBreak` | off | on/off | every walk (`settingsMover`: planner dig-through moves) |
| `allowPlace` | off | on/off | every walk (pillar-up with throwaway blocks) |
| `closeDoors` | off | on/off | every walk (close doors and gates behind) |
| `sprint` | on | on/off | every walk; follow (off = never sprint) |
| `guardRadius` | 16 | 2..64 blocks | guard (also `!guard <radius>`, `--guard <radius>`) |
| `fleeHealth` | 8 | 0..20 | flee, guard in place (also `--flee-health`) |
| `nudgeInterval` | 240 | 0..86400 s | keepalive nudge; a change nudges once now, then on the new cadence (also `--nudge-interval`) |
| `eventsDays` | 14 | 1..365 days | event history: days of files kept (docs/events.md "Storage"; decision 0059) |
| `eventsMaxMb` | 64 | 1..4096 MB | event history: total size cap, the oldest days go first, today's file stays |
| `followDistance` | 3 | 1..16 blocks | follow (stop distance; a change restarts a running follow) |
| `avoidMobRadius` | 4 | 0..32 blocks | placeholder (Track R/S planner cost) |
| `avoidSpawnerRadius` | 8 | 0..64 blocks | placeholder (Track R/S) |
| `toolWearLimit` | 10 | 0..2000 uses | placeholder (Track S) |
| `mendAt` | 10 | % | a Mending tool, weapon, armour piece or elytra at or under this share of its durability is set aside, not used until it breaks; `!mend` (docs/survival.md "Mending"); 0 = off |
| `throwawayMin` | 16 | 0..2304 blocks | placeholder (Track S) |
| `useBoneMeal` | on | on/off | placeholder (Track U) |
| `mineTunnelLen` | 32 | 1..256 blocks | placeholder (mining) |
| `mineSeenOnly` | false | boolean | mining: only ore the bot has seen an open face of; off (the owner's choice for their own Realm) lets `!mine` tunnel to any known ore (docs/mining.md) |
| `protectRadius` | 48 | number | the base: nothing is dug or broken by a walk, a `!mine` approach or a sight-line dig within this distance of home (0 = off). Built blocks (planks, bricks, stairs, slabs, glass, doors, wool, concrete, bookshelves, tables, ...: `isBuiltBlock` in terrain/classify.ts) are never dug anywhere. 2026-10-30: `!mine` dug through the owner's house |
| `digPenalty` | 60 | number | ticks added per block a route digs through, on top of the break time: a walk of about 13 extra blocks beats one dug block, so a reachable spot is walked to and digging is for the far or the enclosed |
| `guardReach` | 24 | number | guard (Track AO): a hostile not within reach is fought only when a probe plan (4000 nodes, 300 ms, no digging) reaches a cell within 1.5 blocks of it in at most this many path blocks; no path = ignored 30 s with the reason (`!status` shows them); 0 = the old terrain rule |
| `autoFly` | on | boolean | flight (Track AU, docs/flight.md): `!come` / `!goto` fly with the elytra instead of walking over `flyMin` blocks when the kit is ready |
| `flyMin` | 200 | number | flight: the distance from which they fly |
| `flyClearance` | 12 | number | flight: the cruise clears every known column under the line by this |
| `flyCruise` | 25 | number | flight: no longer used since Track AU2 (the cruise height is what the glide down needs, capped by `flyMaxClimb`); kept so older settings files load |
| `flyGoArounds` | 4 | number | flight: approaches flown again after a miss, then the nearest safe ground |
| `fireworksMin` | 16 | number | flight: fewer rockets in the hotbar -> refill from the fireworks box; the low-supply line when the box is empty too |
| `flyTakeoffRun` | 12 | number | flight (Track AU2, docs/flight.md "Takeoff and roofs"): the sky over the start and this many blocks along the heading must be free up to the cruise height (unknown = a roof), else `!fly` refuses and goto / come walk to open sky first |
| `flyRetryBlocks` | 32 | number | flight (Track AU2): goto / come walking out from under a roof try the takeoff again every this many blocks |
| `flyMaxClimb` | 120 | number | flight (Track AU2, "Rocket economy"): the climb's cap above the start; a longer glide is topped up on the way |
| `flyMargin` | 15 | number | flight (Track AU2): the cruise fires only when the glide ahead would reach the approach entry with less than this to spare (less for short glides) |
| `flyLandSearch` | 48 | number | flight (Track AU2, "Fly, then walk"): goto / come land on the nearest landable cell within this many blocks of the goal and walk the rest |
| `flyLandProbes` | 16 | number | flight (Track BF, docs/flight.md "Landing v3"): walking plans tried from landing cells near the goal (6000 nodes, 400 ms each) before landing on unconfirmed dry ground |
| `flyHoldS` | 30 | number (s) | flight (Track BF): a flight whose goal's ground is not loaded (or has no confirmed landing yet) circles high near it this long, then lands on the nearest dry ground and tries to walk |
| `flyHeadroom` | 4 | number | flight (Track BF): a cell under a roof is landable when the roof is at least this high over the feet and a corridor leads in from the open side (the approach is simulated) |
| `flyOverhangDepth` | 10 | number | flight (Track BF): an overhang landing flies at most this many blocks under the roof (0 = never under a roof) |
| `flySneakLand` | on | boolean | flight (Track BF): sneak through the touchdown and the settle; released when the flight ends |
| `flyLedgeTakeoff` | on | boolean | flight (Track BH, docs/flight.md "Ledge takeoff"): step off a platform edge (sneak to the rim, release, glide as the fall begins) when the jump takeoff is refused or the start is a small platform |
| `flyVerticalTakeoff` | on | boolean | flight (docs/flight.md "Vertical takeoff"): straight up the open column over the bot when the jump takeoff is refused on every heading, then the climb from above |
| `glideDown` | on | boolean | flight (Track BH, "Glide down"): a goto / come that ends unreachable with the goal far below glides down when a simulated glide from a ledge lands near it (rockets optional), then walks |
| `glideDownMinDrop` | 10 | number | flight (Track BH): the glide down only for a goal at least this far below the feet |
| `glideDownMinDistance` | 16 | number | flight (Track BH): the glide down only for a goal at least this far away horizontally |
| `guardWhileWalking` | near | text | guard while a user process walks (Track AO): `reach` fights only mobs within reach, `near` adds melee mobs, creepers and archers aiming at the bot within 6 path blocks, `all` the old behaviour |
| `mineBranchY` | auto | text | branch mining (Track AI): `auto` picks the ore's best level (coal 40, iron 16, copper 48, gold -16, redstone -58, lapis 0, diamond -58, emerald 232 in mountains), a number overrides |
| `exploreRadius` | 128 | number | `!explore` without a radius: the area walked around home (16..1024) |
| `plannerThreads` | 1 | 0..1 threads | every walk: 1 plans paths in a worker thread (bigger budgets, the tick never waits for the planner), 0 on the main thread (docs/pathfinding.md "Compute", decision 0023) |
| `stashChest` | none | `x y z` / none | the stash step of `!get` and the jobs: the chest a full inventory is emptied into; none = the job chest, a carried shulker box, then dropping junk (docs/get.md) |
| `stashShulker` | on | on/off | the stash step: place a carried shulker box, fill it, break it and pick it up when the inventory is full (docs/get.md) |
| `autoBreed` | off | on/off | the breeding chore: breed the animals of `chorePen` every 10 min while it holds fewer than 8 adults of a kind (docs/food.md) |
| `chorePen` | none | `x y z` / none | the breeding chore and the food chore: a block inside the fenced pen whose animals they may use; none = no pen (docs/food.md) |

`!set` lists every value (`settings: allowBreak off, ...`, split into lines of at most 240
characters), `!set <key>` shows one (`guardRadius 16 (2..64 blocks, default 16): guard: fight hostiles
within this radius of home`), `!set <key> <value>` validates, applies at once and writes the file
(`guardRadius = 8 (was 16)`; errors: `guardRadius must be a whole number 2..64, got "1"`),
`!set <key> default` goes back to the default and removes the key from the file. Keys are
case-insensitive; booleans take on/off, true/false, yes/no, 1/0. Processes call
`settings.get(key)` every time they need a value, never a copy, so a change applies on the next
tick (a walk that runs keeps the planner flags it started with; the next leg uses the new ones).

**Precedence**: at start-up default < settings.json < config.json (`"settings": { ... }`,
`nudgeInterval`, `tasks.afk.guard` radius, `tasks.afk.fleeHealth`) < command line (`--set key=value`
repeatable, `--guard <radius>`, `--flee-health`, `--nudge-interval`). Start-up values are not written
to the file. After start `!set` (and `!guard <radius>`) wins and is written, so it survives a restart
unless a flag or config.json overrides it again.

**File**: `--settings <file>` > env `BEDROCKBOT_SETTINGS` > `settings.json` next to the config file
(`%LOCALAPPDATA%\bedrockbot\settings.json` on Windows by default). With `--no-config` and neither of
the first two the settings live in memory only (tests, the soak). A `--settings` path inside the
repository is refused (exit 2); a config file inside the repository gives a warning and no
persistence. The file is JSON written atomically (temp file + rename); keys starting with `$` and
unknown keys are kept; an unknown key or a value out of bounds is logged and ignored; invalid JSON is
an error (exit 2).

Adding a setting: one entry in `SETTING_DEFS` (config/settings.ts) and `deps.settings.get('key')` where
it is read; `!set`, the file, `--set` and config.json pick it up.

## Adding commands and processes (other tracks)

The afk task builds one `CommandDeps` (tasks/process/deps.ts: chat, task, conn, metrics, mobility,
skills, world, processes, settings, pve, log, isOwner, selfName, position, parseBlock, fmtBlock,
needsWalking) and calls every registration in the list marked "command registrations" in
tasks/registry.ts. A track adds one import and one entry:

```ts
import { registerNavCommands } from '../chat/commands-nav.ts';
// ...
const registrations = [registerPveCommandsFor, registerProcessCommands, registerSettingsCommands, registerAfkGather,
  registerNavCommands, // Track R
];
```

A behaviour that moves the bot is a process: extend `BaseProcess` (run(token, resumed), halt(why),
status(), optionally behaviour()), check `t === this.token` in async callbacks, call `this.finish()`
when done, and `deps.processes.add(p)`. Use `settingsMover(skills, deps.settings)` (or
`deps.pve.mover`) for walking so the planner settings apply. Without walking `deps.processes` is
undefined: reply `deps.needsWalking('cmd')`.

## Tests

```sh
pnpm --filter bot exec vitest run --project unit process-manager afk-processes settings   # unit, fakes only
node scripts/bds.mjs --profile core up && node scripts/bds.mjs --profile core pack
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e core --silent=false             # core-process + core-settings (~2 min)
```

Env: `CORE_BDS_HOST` (127.0.0.1), `CORE_BDS_PORT` (19180), `CORE_BDS_CONTAINER` (bds-core),
`CORE_VERBOSE=1` (the bot's log). Every run uses its own random 256-block cell from x, z = 16384,
random truth request ids and a per-run summon tag; mobs are removed and the area cleared at the end;
the CLI runs use a temporary log dir and settings file (deleted afterwards).

- `core-process`: two trees (truth:tree), `!gather 8`, a zombie summoned 7 blocks from the bot after
  the first log: the stack is `guard:active gather:paused`, then the gather resumes and finishes with
  8 logs (truth:inv); a 40-block `!goto` with `!status` (stack line and ETA, compared with the real
  arrival); a second `!goto` with `!pause` (still for 2 s), `!status` (`[held]`), `!resume` (moving
  again), `!stop` (the `!stop` reply names the walk; the walk itself stays quiet); flee: a guard fight against an immune, slowed,
  weakened zombie, health set to 5: `fleeing` and home, health 20: the fight resumes and kills it once
  its resistance ends.
- `core-settings`: `--guard 1` exits 2 with one stderr line; `!set guardRadius 8` leaves a zombie 12
  blocks from home alone for 5 s, `!set guardRadius 16` makes the bot fight it; CLI run 1 with
  `--settings <tmp>` takes `!set guardRadius 8` (written to the file) and quits, CLI run 2 with the same
  file answers `!set guardRadius` with 8, ignores a zombie at 12 blocks and fights one at 5.

## Measured on bds-core (2026-10-29, BDS 1.26.60.6, normal difficulty)

From the two gate runs (`core` suites, 6/6 green each, 108 s per run) plus the earlier runs:

| What | Result |
|---|---|
| Guard pre-empts a gather (zombie 7 blocks from the bot after 4 of 8 logs) | `fighting zombie` 61 to 122 ms after the summon; stack `guard:active gather:paused`; zombie dead after 3.2 to 4.0 s; gather resumed 3.3 to 12.2 s after the summon (the fight's drop pickup runs up to 10 s first); done with 8 logs (truth:inv) after 13.7 to 23.4 s in total, 0 corrections |
| `!goto` 40 blocks, `!status` 1.7 to 1.8 s after the command | `[active] walking to ..., 31-32 blocks left, eta 6 s`; arrived 6.5 s after the `!status` (chat round trip included) |
| `!pause` / `!resume` / `!stop` during a goto | 0.00 blocks moved in 2 s while held (`[held]` in the stack); 12.0 to 12.3 blocks in the 2 s after `!resume`; 0.00 blocks in 2 s after `!stop`, 34 blocks short of the goal; only the `stopped (was walking to ...)` reply, no `goto:` line (an interrupted walk stays quiet, like `!come`) |
| Flee pre-empts a guard fight (health set to 5 mid-fight) | `fleeing` 229 to 247 ms later, stack `flee:active guard:paused`; home 12 blocks away after 2.9 to 3.0 s; with health 20 again the fight restarted after 124 to 184 ms; 0 damage taken |
| `!set guardRadius 8` live | a zombie 12 blocks from home left alone for 5 s; `!set guardRadius 16` -> fighting 230 to 276 ms after the console command |
| Restart of the bot process | `!set` answered in 230 to 354 ms and written to settings.json; the second process read 8, ignored a zombie at 12 blocks for 5 s and fought one at 5 blocks 506 to 537 ms after the summon |
| `--guard 1` | exit 2, stderr exactly `error: guard radius must be 2..64, got 1` |

Regression on bds-core with the manager in place (hard-respawn, hard-night, pve-combat, pve-follow:
11 passed, 1 skipped (`HARD_EASY`), 232 s): guard fight 0.3 s after the summon, home after 6.2 s;
flee 0.8 s, shelter after 3.4 s; follow max 3.04 blocks; `!come` 4.1 s; night shelter after 3.0 s,
home 4.4 s after sunrise; respawn and home after 6.1 / 4.5 s.

## Known limits

- The night process holds the owner's commands until dawn once a shelter is set (`!follow` at night
  waits); `!shelter clear` releases them.
- A paused guard fight is dropped, not resumed: guard picks its target again when it gets control.
- The ETA reads the navigator's internal plan (no public accessor); the gather ETA assumes a constant
  rate.
- `nudgeInterval` patches `AfkTask.nudgeIntervalMs` (afk.ts has no setter); the change takes effect with
  one immediate nudge.
- The tasks still get the settings through `TaskContext.values.$settings` (base.ts has no field yet).
