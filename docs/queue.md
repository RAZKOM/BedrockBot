# The job queue and the standing goals (Track P4)

The owner lines up work, and the bot runs it one job after another: `!queue add !get kit iron`, `!queue add !goto
home_field`, `!queue add !smelt iron 8`. Each job is a chat command line the bot already understands. It runs as if the
owner had typed it the moment the job before it ended. The **standing goals** are the chores the bot keeps up by
itself (food, milk, rockets, the farm ...). They have one list with their switches, what they keep, their last run,
and how they share the body with the queue.

Decision record: [decisions/0115-job-queue-and-standing-goals.md](decisions/0115-job-queue-and-standing-goals.md).
The panel's Jobs view: [panel.md](panel.md) "Jobs view". Chores and the queue in the process table:
[processes.md](processes.md) "Chores and the queue".

| Path | What |
|---|---|
| `bot/src/tasks/queue.ts` | `JobQueue`: the jobs, the refusals, the start and end rules, the file's data (`QueueData`), `lineState` |
| `bot/src/tasks/goals.ts` | `StandingGoals`, `DEFAULT_GOALS`, `registerGoal` (a chore joins the list with one line) |
| `bot/src/chat/commands-queue.ts` | `!queue`, `!goals`, the wiring on the afk task (the chat, the process manager, the obtain and mend jobs, the file) |
| `bot/src/health/panel/jobs.ts` | the panel's `jobs` topic and `GET /api/jobs` |
| `bot/src/health/panel/client/jobs.ts` | the Jobs view in the browser |
| `bot/test/unit/tasks/queue.test.ts`, `queue-commands.test.ts`, `unit/chat/queue-afk.test.ts`, `unit/health/panel-jobs.test.ts` | the rules on fakes, the real afk registry, the topic and the view |
| `bot/test/e2e/panel-queue.test.ts` | on bds-core through the panel's API: order, failure, pre-emption, restart, night, a goal |

## Commands

| Command | Effect |
|---|---|
| `!queue` / `!queue list` | what runs, what waits, why the next one waits (`next waits: the gap between jobs (3 s)`), the last ended jobs |
| `!queue add <command>` | adds a job at the end (`queue: added #4 !smelt iron 8 (2 of 2)`); the `!` is optional; refused at once when the command cannot be queued (below) |
| `!queue remove <id>` | a waiting job leaves the queue; the running one is stopped (`stopped by !queue remove by Steve`) |
| `!queue move <id> <pos>` | a waiting job moves to place `pos` (1 is next) |
| `!queue clear` / `!queue clear ended` | removes every waiting job / forgets the ended ones |
| `!queue pause` / `!queue resume` | no new job starts / they start again (the running job is not touched) |
| `!queue retry <id>` | an ended job is added again as a new job |
| `!queue onfail next` / `stop` | after a failed job: go on with the next (the default) / pause the queue |
| `!goals` | every standing goal: on or off (its setting), what it keeps, running or not, how it relates to the queue, its last run and end line |

Both are owner commands (`group control` and `info`, `tier more`). `!status` gets a line under the process stack while
the queue holds anything: `queue: running #3 !goto 10 64 -20; waiting #4 !pos`.

## What cannot be queued

A job has to end by itself, and it has to be a command the bot can run with no one there. Refused when it is added,
with the reason:

| Command | Why |
|---|---|
| `!queue`, `!goals` | the queue does not hold its own commands; `!goals` only answers |
| `!stop`, `!pause`, `!resume`, `!<x> stop` | they act on the running work: type them when they are wanted (`!queue pause` pauses the queue) |
| `!quit` | it ends the bot |
| `!follow` | it never ends by itself |
| `!farm` (except `!farm new` and `!farm status`) | it farms until stopped (`!farm new` sets a plot up and ends) |
| `!learn` | it records a flight the owner flies |
| `!test` | the test bench runs its own series |
| `!do`, `!yes`, `!no` | a plan waits for `!yes`: queue the plan's commands themselves |
| `!answer` | it answers a question the bot asked: type it when the question is there (Track P5) |
| an unknown command | `no command !x` |
| over 200 characters, or 32 jobs waiting | the line or the queue is too long |

## How a job runs

- **One at a time, as the owner.** A job's line goes through the chat handler as the first owner (or the console when
  the bot has no owner and `consoleOwner` is on; with neither it is `skipped`). So it does exactly what the typed
  command does, with the same replies.
- **The queue never moves the body.** The process manager decides who has the body as before: the flight (101), the
  flee (100), the blade (90), the defence (85), the night (80), the guard (60). The reflex is not a process and acts
  under all of them. The queue only chooses when to send the next line.
- **When the next job starts.** Only when the bot is free:
  - no user process and no multi-step job (the obtain job of `!get`, `!mend`);
  - nothing auto in control;
  - and the bot has stayed free for `GAP_MS` (5 s).

  Every 250 ms the queue looks again. The gap is where a chore that is due takes its turn. A chore or the walk home
  that keeps the body longer than `HOLD_MAX_MS` (20 min) is pre-empted by the next job, as a typed command would
  pre-empt it. A fight, a flight, the flee and the night have no limit: the next job waits for them.
- **Not in the game.** While the bot is not spawned, not ready, or dead, the queue waits and says why (`next waits:
  the bot is not in the game, or dead`).

### How "ended" is known

| Kind | What the queue watches | The job's state |
|---|---|---|
| a command that starts processes (`!goto`, `!gather`, `!mine`, `!smelt`, `!milk`, `!rockets`, `!home go`, `!fly` ...) | the user processes added by its dispatch, until none is left and SETTLE_MS (2 s) passed: a command whose steps follow each other (`!fly`'s ground work, then the flight) is one job | the last process's result (events/jobs.ts `outcomeOf`): finished = `done`; failed, or stopped by a death or a disconnect = `failed`; stopped by the owner or by a newer command = `cancelled` |
| a multi-step job (`!get`, `!mend`) | the job object, until its end line (`get iron_chestplate: done in 128 s, 6 steps; paused for 1 night; ...`); its processes come and go between steps | the end line's words (`lineState`) |
| a command that only answers (`!pos`, `!set`, `!wp set`, `!craft`, `!unload` when it says why not ...) | its replies, until 1 s passed with none (START_MS 1.5 s at least; 5 s for a command that usually starts work; 20 s at most) | the reply's words: `usage:`, `cannot`, `no way`, `not found`, `missing`, `failed`, `stopped` ... = `failed`; else `done` |
| removed while it ran | `!queue remove` stopped its work | `cancelled` |
| the 3 h limit | the queue stopped its work | `failed` |

A job's end time is when its work went (not the 2 s settle that confirmed it). Its end line is its last reply (or, for
a process stopped by something else, the reason with the last reply in brackets), clipped to 200 characters. When the
last waiting job ends the queue says how the run went: `queue: all 4 jobs ended: 4 done`.

**Only the job's own lines count** (Track D2, ADR 0115 addendum). The queue runs each job in a command scope of its
own (`chat/scope.ts`; [discord.md](discord.md) "Which lines are a command's own"): its dispatch, the processes it adds
and the replies those say carry it. The watch reads only lines in that scope, so a `!discord status` sent from the
panel while a reply-only `!goto zzqxtest` runs is not the job's end line, and a chore's or another command's words
(`cannot`, `stopped`) neither fail a job nor keep its reply window open. Why: before, the watch read every line the
bot said while a job ran, and a reply-only job could end with another command's reply as its end line and its state
taken from those words. The other end rules are unchanged: 1 s with no reply of its own (START_MS at least, 20 s at
most), the processes and SETTLE_MS, a multi-step job's end line.

### A command typed meanwhile

A command the owner types that does work (in the game or the panel) **pauses the queue** and says so: `queue: paused:
!goto was typed; #6 !goto 30 64 30 is left to it; !queue resume goes on with #7 !pos`. Typed means from a chat line
(the panel's `POST /api/cmd` counts); a job's own steps and a plan's dispatch are not typed. The running job is left
to the process manager: a `!goto` replaces a queued `!goto` (the job ends `cancelled`, `!goto was typed (last:
walking to ...)`), and a different command stacks over it, so the job goes on after it and is watched to its end.
Commands that only answer or switch never pause it: `!status`, `!pos`, `!help`, `!inv`, `!stock`, `!set`, `!wp`,
`!shelter`, `!queue`, `!goals`, `!guard`, `!pause`, `!resume` and the others in `QUEUE_REPLY_ONLY`. `!home` pauses
it only with `go`, `!chests` only with `scan`. `!quit` does not pause it: the restart has its own rule (below).
Nothing resumes the queue by itself: `!queue resume`.

### The night

The night rule is a process (80) like any other: a job that is walking when the night process takes the body is
paused by the manager and goes on at dawn; the queue sees a job that is still running and waits. A `!get` job with
`jobDusk` on ends its step at dusk, waits out the night where the bot shelters and goes on at dawn
([early-game.md](early-game.md) "Dusk"). Its end line says `paused for 1 night`, and the job is `done`: a night is not
a failure. No new job starts during the night while that job waits. A short job queued behind it waits too.

### A failed job

`onfail next` (the default): the next job runs. `onfail stop`: the queue pauses, `queue: paused: #4 !craft
diamond_sword failed (craft: no oak_log ...); !queue resume goes on`. The choice is kept in the queue's file.

**Asking the owner (`askOwner`, off by default; Track P5, ADR 0116, [away.md](away.md) "Ask the owner").** With
`askOwner` on, a failed job asks instead of acting at once: `ask #2: job #4 !craft diamond_sword failed (...): retry it,
go on with the next, or pause the queue? !answer 2 retry|next|stop (!yes retry, !no next); in 2 min 0 s: next`.

- The queue holds while it asks (`next waits: the owner is asked about #4 (retry, next or stop)`).
- `retry` adds the job again first in line, as the one who answered.
- `next` goes on.
- `stop` pauses the queue.
- Unanswered after `askWaitS` (120 s; 10 to 1800), the `onfail` rule decides, so a question nobody answers ends as the
  queue did without it, only later.
- With `onfail stop` the pause is made and saved when the job fails. A restart while the question waits leaves the
  queue paused, as without the question. An answer of retry or next takes that pause back.
- Only `failed` jobs ask. `skipped` (no owner) and jobs ended by a restart do not.
- `!answer`, and `!yes` / `!no` when they answer a question, do not pause the queue. They are not work typed.

Measured on bds-core (n3, `askWaitS` 10): the question was in the away block 0.0 s after the failure; after
`!answer <id> next` the next job started 5.3 s later (the 5 s gap); left alone, the next job started 15.3 to 15.4 s after the
failure; with `onfail stop` the queue was still paused after the wait (`#9 failed (unanswered: the onfail rule)`).

### The file and a restart

The queue is kept in `<config dir>/queue/<server>.json` (the server as for the waypoints), or `BEDROCKBOT_QUEUE_DIR`
when it is set. With `--no-config` and no `BEDROCKBOT_QUEUE_DIR` it is kept in memory only. It is written atomically
(a temporary file, then a rename) on each change, and the log names it (`queue: kept in ... (1 waiting, not paused)`).

At the next start, a job that was running is **not run again**: it may have half done its work (half a trip, items
taken out of a chest, a furnace loaded). It is ended `cancelled`, `stopped by a restart (started 3 s before); not
run again (!queue retry 1 puts it back)`, and the queue goes on by its `onfail` rule. The waiting jobs, the pause and
the `onfail` choice are kept as they were.

## Standing goals

Each standing goal is a chore that already exists (a process at `PRIORITY.chore`, 30). The list does not change what
any chore does: it reads their settings and records their runs from the process manager's control changes.

| Goal | Setting | Process | What it keeps |
|---|---|---|---|
| `food` | `autoFood` | `food` | at least `foodMin` hunger points carried |
| `milk` | `autoMilk` | `milk` | `milkKeep` milk buckets |
| `rockets` | `autoRockets` | `rockets` | `fireworksKeep` rockets |
| `elytra` | `autoElytra` | `elytra` | a better elytra on under 100 uses over the worn limit |
| `farm` | `farmFood` | `farmchore` | harvest at a quarter ripe, or a loaf when food is short |
| `shell` | `shellBlocks` | `blockschore` | the night shell's 10 blocks |
| `unload` | `autoUnload` | `home-chore` | unloads at home past 8 stacks to unload, a full box, or under 4 free slots |
| `breed` | `autoBreed` | `breed` | the pen at `chorePen` |
| `mend` | `autoMend` | `mend` | a Mending piece over 75 % of its uses, at most 32 items an hour (Track K6, registered with `registerGoal` in `chat/commands-mend.ts`) |

A goal is switched with its setting (`!set autoMilk on`; the panel's switch sends that line). Its relation to the
queue is one of:

- `running`: the chore has the body now;
- `queue waits`: it has the body and a job waits for it;
- `waits for the queue`: it is on and a job runs;
- `idle`: it is on and nothing runs;
- `off`.

A run is open while the chore has the body. It closes when another process takes it, or when the chore gives it back
to idle. Not every hand-back emits a control event, so the queue's 250 ms poll closes it too. The last end line is the
chore's own record (milk: `milk: 1 milk bucket carried (1 from a cow); ...`).

### How chores and jobs share the body

- A job is a user process (40) and every chore wants the body only with no user process, so **no chore runs while a
  job's work runs**.
- Between two jobs the queue waits until the bot has been free for 5 s. A chore that is due starts in that gap (they
  look every second or so), and the queue then waits for it to end.
- So a chore runs between jobs, never during one, and a long queue does not starve the chores.
- A chore that holds the body for 20 min is pre-empted by the next job.

Measured on bds-core (below, n = 3): the milk chore started 0.0 to 0.3 s after a queued walk home ended and ran 1.6
to 3.0 s. The next job started 6.8 to 8.3 s after the chore ended.

### Add a goal (one line)

A chore joins the list with one call where it registers its commands (the mending chore does, in
`chat/commands-mend.ts`):

```ts
registerGoal(task, { id: 'mend', label: 'mending', setting: 'autoMend', process: chore.name, target: () => `a Mending piece at or under 75 % of its uses; at most 32 items an hour` });
```

`id` is unique (a second call with the same id replaces it, a default included). `process` is the chore's process name
(its runs are recorded from it); `last(chore)` may return its end line. The panel's Jobs view and `!goals` show it at
once.

## Measured

bds-core (a flat world, protocol 1.26.60, the panel's API, a Windows dev machine), `test/e2e/panel-queue.test.ts`.
Three runs, 6 of 6 cases each (2026-11-20):

| Case | What was measured (n = 3) |
|---|---|
| order | four jobs (`!goto`, `!wp set`, `!goto`, `!pos`) `done` in order, each with its end line (`arrived at ...`, `waypoint p4q set to ...`, `pos ...`). The gap from a job's end to the next start was 7.7 to 7.9 s after a walk (the 2 s settle, then the 5 s gap) and 5.4 to 5.5 s after an answer. 36.5 to 36.7 s for all four |
| failure | a walk to a cell sealed in bedrock `failed` in 2.3 to 2.5 s (`goto: stopped short (6.1 blocks from the goal's cell ...)`), then a `!craft` with no materials `failed`, then `!pos` `done`. With `onfail stop` the failure paused the queue (`#8 failed`), the next job waited 8 s, and after `!queue resume` it ran (13.3 to 13.4 s after the failure) |
| preempt | a `!goto` typed in the panel during a queued walk: the queue paused and said so; the queued walk ended `cancelled` (`!goto was typed (last: walking to ...)`); the typed walk arrived 3.2 to 3.3 s later; the next job waited 8 s and ran after `!queue resume` |
| restart | `!quit` during a queued walk, the CLI started again on the same queue file. Back online 3.4 to 3.8 s after `!quit`. The walk was `cancelled` (`stopped by a restart (started 3 s before); not run again (!queue retry 12 puts it back)`), the bot did not walk on, and the next job ran 4.8 to 5.1 s after the panel answered |
| night | `!get iron_chestplate` queued with `jobDusk` on and a shelter 6 off. Dusk came after the first ore: `paused for the night at step 1 (mine iron_ore 8: 1 of 8), at the shelter ...`, 9.5 to 10.1 s after the add. Through the night the job stayed `running`, the second job waited and the queue was not paused. At dawn the job went on and ended `done` 108 to 111 s after the clock was set to dawn (`done in 127 to 131 s, 6 steps; paused for 1 night; ...`); the second job ran 7.8 s after it |
| goal | `!set autoMilk on` from the panel, a cow by home, an empty bucket. A queued walk home ended, and the milk chore started 0.0 to 0.3 s after the walk's end and ran 1.6 to 3.0 s. The second job started 6.8 to 8.3 s after the chore ended; 1 milk bucket carried |

`GET /api/jobs` (the `jobs` snapshot) was 2 436 bytes with 4 ended jobs and 8 goals.

## Known limits

- The reply-only state is read from the words (`lineState`). A command whose failure reply uses none of the failure
  words reads as `done`. The processes' results and the obtain job's end line are not words, and they decide where
  they exist.
- A command typed while a job runs freezes the job's end line: from then on, the replies are the typed command's.
- A chore due in the gap may start up to 1 s late and then has the body to its end. A chore that never ends holds the
  queue for 20 min.
- Only `get` and `mend` are known as multi-step jobs. Another track's job that drops its processes between steps for
  over 2 s would end early in the queue's view. It is registered as a `JobHolder` in `chat/commands-queue.ts`.
- With `--no-config` the queue lives only as long as the process, unless `BEDROCKBOT_QUEUE_DIR` is set.
- A death during a queued walk stops the walk as `interrupted`, not with the process manager's `death` reason (Track
  P5's e2e: 3 of 3). The queue notes a death on its poll while a job runs, and a job whose process ended `stopped`
  after one fails: `the bot died during it (interrupted (last: walking to ...))`, so `onfail stop` and `askOwner`
  act on it. A typed command still makes the job `cancelled`, a death or not.
