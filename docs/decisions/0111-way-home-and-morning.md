# 0111: The way home from the mine, and the morning after a night (Track E9)

Date: 2026-11-20. Status: accepted. One navigator rule with no switch of its own (a walk whose body is shut in
digs out: it removes a refusal and follows the owner's `digWay`). One setting (`jobMorning`, default off). No fight rule
is new or changed; no survival rule is loosened. Details and numbers: [../early-game.md](../early-game.md) "The way
home and the morning after", [../pathfinding.md](../pathfinding.md) "Shut in".

## Context

Track E7 (ADR 0104) made a `!get` job wait out the night. Its runs on three fresh worlds left three things:

- **The walk home from the mine was refused at once.** `furnace: the walk home failed (unreachable)` ended the iron
  kit in 2 runs, and the night rule's walk to its shelter failed 3 of 3 from the same place in one run.
- **The first minutes of the day were unprotected.** 2 of 6 bots died there after `dawn: going on`.
- **No iron kit finished** within a run.

## Decision

1. **A walk whose body is shut in digs out (`digOutShutIn`, `skills/nav/navigator.ts`; `DIG_OUT_MAX_BLOCKS`,
   `skills/nav/digway.ts`).**
   - *The cause.* The miner's walks dig and place: one digs straight down a one-wide shaft to an ore under its feet
     and pillars back up, another drops 2 and 3 blocks down its own cut. The walks that follow are other callers'
     (the night rule, the furnace step) and plan as every goto does: no place moves, a dig way of 12 natural blocks.
     7 refusals from the runs, asked again offline on each run's own world: the plain search ended after 1 to 29
     nodes (in three of them the start had no move at all), the dig way's after 400 to 2 700; both exhaustive, none
     touching unloaded world. The way out existed in every one: a stair of 13 to 61 dug blocks.
   - *The rule.* When a goto's last level ends in an exhaustive `none` that touched no unloaded world, hit no limit
     and is not Track W2's "trapped in water", the dig way plans once more with 128 blocks for that goto. Natural
     terrain only, no slow block, the break rules (never in the base, never beside a liquid or under a gravity
     block), no place moves, no fall that hurts before the last level: the dig way's own rules. With `digWay` off, or
     for a goto that digs anyway, nothing changes.
   - *Why there.* The pocket is the miner's doing, but the walks refused are anyone's: the night rule, the furnace,
     the bed, a death's walk back, an owner's `!home go`. A rule in the miner (wait for `returnUp`) would cover the
     job's next step only, and not a step ended at dusk. The navigator already knows when a search was exhaustive.
   - *Why digging, not a pillar.* In a shaft open to the sky a pillar is shorter (7 blocks against 15 dug), and the
     miner pillars. But a goto places no blocks unless the owner's `allowPlace` says so, the pillar eats the blocks
     the night shell needs, and digging gives blocks. So the budget of the rule the owner already allowed is what
     grows.
   - *Why 128.* A stair takes about 2 blocks a level; 128 covers 64 levels, the ore levels to the surface. The
     deepest refusal measured needed 61 from 34 under the surface.
   - *The timeout.* A goto's timeout is a budget of ticks without getting a block nearer the goal; a stair gains a
     block every two or three digs. The first walk home that dug out on a fresh world ended `timeout` after 36
     blocks of its stair (the caller's budget: 1 500 ticks for 75 blocks). Once a goto is shut in, a dug block
     counts as progress.
2. **A refused walk says why (`walkFailWords`, `skills/nav/reach.ts`).** The furnace step, the bed step and the night
   rule ask the navigator's "why" searches (`explain`) and put the cause in their line: a rule by name, `budget` for
   a search that ran out (a limit, not a closed world), `world` when nothing gets there.
3. **The morning after (`jobMorning`, default off; `chat/kit-morning.ts`, `NightSafety.hold`).**
   - *Measured first.* The night rule's dawn is 23000, and nothing burns then: six undead summoned on an open plain
     took their first fire damage between 23446 and 23640; four were gone by 39 of the day, one walked into a cave,
     one never caught fire. Just before dawn the bots had 2 to 18 hostiles within 32 blocks of the shelter and 0 to 7
     within 16 (18 mornings on three worlds). A job that went on at once walked through them or into the next crowd: one found 7 zombies and 3
     skeletons at full health at its mine 30 s after dawn and died there.
   - *The rule.* A job that waited out a night goes on once the sun is up (23460), the undead it burns are gone (600
     ticks later: 60 of the day) and no live hostile is within 16 blocks; or 3000 ticks after the night rule's dawn
     (2000 of the day), with what was still near said in the line. The bound also runs on the wall clock (a server
     whose clock stands still). Until then the night rule keeps the bot in its shelter: the dawn (a night shell's
     opening, the walk home) waits and the night process keeps the body, so nothing else walks it off.
   - *Why a wait and nothing more.* The brief of the track: no new fight rules. The choices were to go at once with
     the fight rules as they are (what was measured: deaths in the first minutes), to wait for a tick, or to wait
     for a clear way. The tick alone leaves what does not burn standing at the shell's door (a creeper, a witch, a
     husk, a zombie under a tree); a clear way alone would go at 23000 when nothing happens to be within 16, as two
     of the bots that died did. So both, with a bound: a mob that is still near after 150 s is not leaving by itself.
   - *What the existing rules do with a witch,* since she is no night mob: with guard on and a blade she is the
     first target within 12; with guard off, as a job runs, only the reflex within reach, the potion side step and
     the flight under 8 health answer her. A job's step yields to a flight or a guard fight and takes the body back
     after; no step looks before it walks. The rule holds for a witch within 16 up to its bound; past it she is the
     fight rules' again.
   - *A night shell's own dawn wait* (shut while a hostile is within 16, 90 s at most) is not added to the rule's:
     a dawn held 90 s or longer has waited for it, and the shell opens at once (`HELD_DAWN_MS`).
   - *Why off.* It was measured with the night shell on, and the night shell is off by default: without a shell
     the rule holds the bot in an open shelter while a hostile is within 16, which no run here looked at.
4. **What ended the kits, where it was the job's (`chat/commands-kit.ts`).** A craft step that made nothing for
   `no_table`, `open_failed` or `request_failed` is tried again, twice a job at most, at home when the place is the
   fault. A mine step that stopped `health low` is waited out (health 14, 180 s at most, twice a job) and caps
   nothing. The step limit is 40 (was 24) and a step the job cut at dusk does not count. These remove ends of a
   job that left the bot alive with its work undone; none digs, places or fights.

## Consequences

- **The walk home.** On a fresh plains world the furnace step's walk home by day got there 0 of 3 times before
  (`furnace: the walk home failed (unreachable)`) and 3 of 3 after; the night rule's walk at dusk from where the mine
  step ended was refused 5 of 5 times before and 0 of 5 after (inside the shelter 36 to 61 s after dusk). In a desert
  no walk started shut in (1 of 1 and 2 of 2 home). A walk that is shut in costs pickaxe uses and
  about a second a block; a caller's timeout sized for a walk no longer ends it in the middle of the stair (a dug
  block is progress). A pit inside the base, one walled with built blocks, or one deeper than 128 blocks of stair
  stays `unreachable`, and says which.
- **The morning.** Fresh worlds, n6 a side, the night shell on: deaths from dawn to 2400 of the day 1 of 6 without
  the rule (2 of 6 in Track E7's runs) and 0 of 6 with it; 0 in 12 mornings with it in all. The job went on in
  every one. The rule does not change what the walk back out meets: the lowest health in the two minutes after the
  job went on was 0, 20, 20, 20, 10, 20 without and 20, 20, 1, 15, 7.2, 20 with it. It costs 54 to 90 s where the
  morning clears and 150 s where it does not, which on plains and in a desert was every morning (a zombie at the
  shell, a creeper, a witch, husks).
- **The iron kit.** 0 of 6 jobs ended `done` on the trees as they were; 2 of 6 had every iron piece on, in the third
  game day. With the job's rules as they are, one more run a world: 2 of 3 `done` (plains and a river bank, 33 to
  34 minutes, two nights, no death), the desert has no iron within the rules.
- **Still open, worst first:** what does not burn at the shelter's door when the wait's bound runs out; no iron in
  a desert with home at the spawn (the base covers the ore, the branch mine is refused under sand); the walk back
  out through what stands in shade; the cooker's timeout (once in 4); the night shell's open side at a river bank (closed by Track E10's supports, ADR 0112, which these runs
  came before);
  the crafter making no room for its table; a pit inside the base.
- **Not proven:** `jobMorning` without the night shell; the craft tried again at home on a fresh world, and the
  wait for health anywhere but unit tests; pits deeper than 34 under the surface live; anything on the Realm.
