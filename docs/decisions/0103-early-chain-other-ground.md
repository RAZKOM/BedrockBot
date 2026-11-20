# 0103: The early chain on other ground (Track E5)

Date: 2026-11-18. Status: accepted. Every change is on. None loosens a survival rule: one keeps the bot from digging
the base, one stops it counting coal it may not dig, and three fix replies that stopped a job for nothing. There is
no new setting. Details and numbers are in [../early-game.md](../early-game.md) "Other ground".

## Context

Tracks E1 to E4 measured the early chain on one forest world: `!get kit`, `!get kit iron`, `!get bed` and the night
after. Track E5 ran the same chain on five fresh worlds of other kinds: plains, desert, snowy taiga, mountains and a
river bank. Each run had a fresh world. Five faults stopped the chain before the world did:

- **The iron kit dug the base.** The owner sets home where the stone kit ended, and `!get kit iron` starts with
  `!mine iron_ore 33`.
  - With no iron known, the miner branch mines. The staircase started at the bot's feet, inside `protectRadius` (48)
    of home.
  - The branch host passed no break rules (`{}`), so the staircase dug the base's ground. Every ore it exposed inside
    the base was then refused by the miner (`protected_area`).
  - On fresh plains and desert worlds: 0 of 33 iron in the step's 10 minutes, with 306 and 313 ores refused and the
    walk re-planning round after round.
  - The job then ran into dusk at the open shelter and the bot died to arrows (plains: during the step; desert: in
    the night after).
  - The staircase's hole by the shelter also left cells of the night shell with no floor.
- **Spruce logs carried, planks not found.** On a snowy taiga the stone kit gathered 6 spruce logs, then asked for
  logs again: `get kit: stopped after 161 s, 2 steps: !gather 4 got nothing (gather done: 6/4 logs)`. The iron kit
  and the bed did the same.
  - The craft chain tries six kinds for a tag cell (`#planks`), in this order: the carried kinds (no planks yet), the
    default (oak), then the server's kinds in the server's order.
  - The server knows twelve kinds of planks, and spruce was not among the first six. The chain found no planks it
    could make and named oak logs as missing.
- **Coal inside the base was planned as fuel.** The fuel rule (ADR 0099) picks coal when a coal ore is known within
  24 and a carried pickaxe harvests it.
  - With home set and the bot by the furnace, the coal it saw was inside the base, so the miner refused all of it.
  - On the mountain world, `!get iron_ingot 9` with 9 raw iron and 2 logs went like this:
    - The job mined 1 coal past the base.
    - The smelt of 9 timed out at 8.
    - The job mined 9 more iron ore and a second coal, and smelted again: 7 steps in 366 to 368 s.
  - On the first mountain run, the coal step of the iron kit refused 816 ores and stopped at health 0.7 in a cave.
- **The job's own table was refused in a pit.** The stone kit's mine step ends at the bottom of the pit it dug, and
  the job's table stands in a notch of it.
  - The crafter looks for a table within 4.5 that it can see. "See" means a clear line from the eye to the face it
    would click.
  - The table the crafter had just set down there failed that line. `!craft stone_pickaxe 1 got nothing (no_table)`
    stopped the kit at 98 s on the mountain.
  - In the e2e pit, a second table was set down and also refused.
- **`!gather N` was read as "N more".** With no chest, the gather ends once N logs are carried. The job asked for
  the logs it was short, though.
  - With 2 logs carried and 2 more needed, `!gather 2` ended at once: `!get chest 2: stopped after 1 s ... !gather 2
    got nothing (gather done: 2/2 logs)`.
  - The same happened in the iron kit's table step on the mountain (`gather done: 2/1 logs`).

## Decision

1. **Branch mining starts outside the base (`skills/mine/branch.ts` `leaveBase`, `baseExits`).**
   - The branch host now passes the navigator's own break rules (the base round home included) and the protected
     area.
   - A run that would start within `protectRadius` of home first walks out of the base. It uses the normal nav, with
     a 2-minute limit.
   - The target is a standable surface cell at `protectRadius` + 3 from home. The bot tries the line from home
     through itself first, then 45 degrees either way: three tries at most.
   - The staircase starts there and points away from home.
   - If no cell is reached, the run is skipped and says so: `branch mining iron_ore: inside the base (protectRadius
     48 round home) and no way out of it found`. If a pre-emption (a flee) cuts the walk, the step is retried.
   - Nothing changes outside the base, nor with no home set.
2. **A tag cell tries the kinds a recipe makes from what is carried (`skills/craft/chain.ts` `tagCandidates`).**
   After the carried kinds and before the default, the chain tries each kind whose recipe takes an item carried
   (spruce planks with spruce logs carried), most of that item first. If nothing carried makes one, the order is as
   before.
3. **The miner says why a candidate went (`skills/mine/miner.ts` `goneWhy`).**
   - The composite walk's rescan log names the reason a target dropped out. Examples: the prune's own skip reason
     such as `protected_area`, `air there now`, `not among the 64 nearest`, unreachable, blacklisted, unloaded.
   - It is a log line only. It is how the base refusals above were found.
4. **The fuel rule counts coal outside the base only (`chat/commands-kit.ts` `coalNearOutsideBase`).**
   - A coal ore inside the navigator's protected area does not count as coal near. The test uses the same sphere the
     break rule refuses.
   - The rule then falls through to planks from the logs carried, then logs.
   - With no home set, it is as before.
5. **The job's own table is used where it stands (`skills/craft/crafter.ts` `ownTableInReach`).**
   - If no table within reach can be seen, the crafter uses a table it set down itself (`ownTables`) within
     `TABLE_REACH`, and logs `craft: our table at x y z has no clear line to its face: used as it stands`.
   - The server opened that table when it was clicked right after it was placed, so the line test only refused a
     table already known to work.
   - A table someone else set down still needs the line.
6. **The job asks `!gather` for the total (`skills/items/obtain.ts` `gatherCommand`).**
   - The obtain job's gather command is the logs carried (any wood the gather counts) plus the logs needed, for both
     the log step and the fuel rule's log step.
   - The step list shows that total: `gather 4` with 2 carried gets 2.
   - `!gather` itself is unchanged.

Decisions 4 and 6 are in their own functions in files Track E6 changes too.

## Consequences

- The iron kit's mine step mines outside the base. The walk out costs a few seconds to a minute.
- If the base's edge is water or a cliff on all three tried lines, branch mining is skipped (and said in chat). Before
  this change, the base was dug instead.
- The base's ground is no longer dug by a branch run, so the night shell at a shelter by home stands on the ground
  that was there.
- Kinds other than spruce benefit the same way: any wood the server lists late, and any tag with more than six
  members.
- A smelt by home burns planks where coal sits inside the base. That takes more fuel items (a plank smelts 1.5 items,
  a coal 8), but the base is never mined for coal.
- A table the bot set down behind a corner is clicked without a line. If the server refuses the click, the crafter's
  usual `open_failed` follows.
- Not changed: the protected area itself, the miner's refusals, the obtain job's steps, `!gather` and `!craft` typed
  by an owner.
