# 0012: one process manager with fixed priorities; runtime settings read live and persisted next to the config

Date: 2026-10-29. Status: accepted (PLAN.md tasks 7.8 and 7.9, Track Q). Server: BDS 1.26.60.6
(`bds-core`, flat world, difficulty normal, truth pack). Details and numbers:
[../processes.md](../processes.md).

## Decisions

1. **One active process, chosen every tick by priority (Baritone's model).** Every behaviour that
   moves the bot is a `Process` with `wants()`, `start / pause / resume / release / stop`, `tick()` and
   `status()`. The manager gives control to the highest-priority process that wants it and pauses
   (never stops) the one it replaces. This replaces the ad hoc cooperation of wave 5
   (`PveController.ownsMovement()` as night safety's `inactive`, the AFK task's `busy`, the
   foreground / episode split inside pve.ts) with one rule set that later tracks can join.

2. **Fixed priorities: flee 100 > guard in place 85 > night 80 > guard fight 60 > user commands 40 >
   home return 20.** Guard has a state-dependent priority: defending in place (inside the shelter or at
   low health) does not leave the shelter, so it may pre-empt the night process; a normal guard fight
   may not (on the way to the shelter the bot does not stop for fights, as before). A change from wave
   5: night now outranks the owner's commands, so a `!follow` at night waits until dawn instead of
   keeping the bot outside (the Realm goal is surviving the night on normal).

3. **User commands stack; same name replaces.** A new command pre-empts the running one, which
   resumes when the new one ends; `!stop` ends all of them. A new command drops a pending home return
   (the owner moved the bot on purpose). `!pause` holds only user processes: guard, flee and night keep
   protecting the bot.

4. **Pre-emption cancels the skill, keeps the intent.** Processes carry a token bumped on every
   pause / stop; async results with an old token are ignored, so a goto cancelled by a guard fight does
   not report `interrupted` to the owner. Resume re-plans (goto), restarts (follow), re-aims (come) or
   continues the state machine from find-tree (gather). A paused guard fight is dropped and re-picked.

5. **Death and settling are manager-wide.** While dead or until the chunks around the respawn point
   are in, nothing runs. At a death the user processes are dropped except gather (as `--task gather`
   resumes after a death); the after-respawn hook requests the home return process.

6. **Night safety keeps its state machine.** NightSafety (tasks/night.ts) still owns the clock, the
   attempt budget, the retry delay and dawn; in process-manager mode it only walks while its process
   has control (`canMove`), a pre-emption cancels a retreat without counting it as failed, and the dawn
   walk home goes through the home return. Standalone use (unit tests) is unchanged.

7. **Runtime settings: one typed registry, read through a getter.** `SETTING_DEFS` holds every key
   with default, bounds and description (including placeholders for later tracks). Processes call
   `settings.get(key)` whenever they need a value; walking goes through `settingsMover`, which merges
   `allowBreak`, `allowPlace`, `closeDoors` and `sprint` into every goto. Precedence: default <
   settings.json < config.json < CLI at start-up (start-up values are not written), `!set` afterwards
   (written). The file lives next to config.json (`--settings`, `BEDROCKBOT_SETTINGS` override),
   never inside the repository; with `--no-config` and no explicit file, settings are in memory.

8. **Task-creation errors are one line, exit 2.** index.ts catches what `TaskDefinition.create`
   throws (`--guard 1`) and prints `error: <message>`.

9. **One registration point for chat commands.** The afk task builds one `CommandDeps` and calls a
   list of registrations; other tracks add one import and one list entry. The settings reach the task
   through `TaskContext.values.$settings` because base.ts/context.ts were not part of this track; a
   later cleanup can add a typed `ctx.settings`.

## Rejected

- **A priority queue of requests without `wants()` polling**: guard, flee and night are conditions
  over the world, not requests; polling them every tick is cheap (one entity scan) and keeps them
  stateless.
- **Stopping a pre-empted process and letting the owner re-issue it**: the e2e gather run shows the
  value of resuming (the half-felled tree is finished after the fight).
- **Settings in config.json written back by the bot**: config.json is hand-edited with comments; a
  separate machine-written settings.json keeps both readable.
