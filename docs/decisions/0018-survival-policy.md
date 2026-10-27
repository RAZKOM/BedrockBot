# 0018: Survival policy: flee v2, trip readiness, sleeping

Date: 2026-10-29 (wave 7, Track W). Status: accepted.

## Context

The Realm bot died 6 times on 2026-10-29 (2 arrows, 2 creeper explosions, 1 melee, 1 unknown). The
log showed health stuck at 5.5 for hours (no eating; fixed by the survival kit, decision 0014), a
guard fight locked on an unreachable phantom while a creeper walked up, a fight holding cooked beef
(the sword was in the main inventory), the flight running home *through* the mobs, and phantoms every
night because the bot never sleeps. The rule the owner set: survival of the bot outranks finishing any
command. `!come` may fight or flee on the way, but it must arrive alive.

Targeting, the creeper rules inside a fight and weapon choice are Track V's (skills/combat); this
record covers what the processes decide around fights: when to run, where to, when a trip may start,
and the night.

## Decision

1. **Flee v2** (tasks/pve.ts `FleeProcess`, priority 100). Triggers: health below `fleeHealth` with a
   hostile within 16, or a creeper within 6 with health below 10 (whatever `fleeHealth` says). First
   the navigator's `runAway` goal away from every threat within 24 (to 12, planned as 16 so the leg does
   not stop with the threat on its heels); then the shelter, else home, only when no threat is between
   (each threat's bearing more than 60 degrees off the home bearing, or it is farther than home);
   otherwise running on (`runAway` to nearest + 6, up to 40), checked every 2 s and re-planned when the
   nearest threat gained on the bot (every new goto stops the body a moment; a chasing zombie is almost
   as fast as a sprinting bot). When there is no farther place (an enclosed area) it goes home anyway:
   the planner's mob avoidance (decision 0014) takes the way around. When the planner cannot start (knocked into
   the air) it sprints straight away by hand for 15 ticks; after 4 such tries with a threat within 4 it gives
   up the flight so guard defends in place. While fleeing and 8 clear of every hostile
   it eats below health 10; the kit's automatic eating is held for the flight. **Hysteresis**: after a
   flight the bot keeps away from melee hostiles (one within 12 starts a flight again, not a fight)
   until the health is back to `fleeHealth` + 6, for up to a minute; archers do not count (running from
   a skeleton in a line only gives it targets).
   **Duel instead**: one melee mob alone with health for 3 more of its hits (the last hit taken, else 3) is fought,
   not run from: a zombie chases as fast as a sprinting bot, so running from one only trades hits for
   distance; flights are for crowds, archers at low health and creepers.
2. **Trip readiness** (tasks/process/readiness.ts). A user process that will walk more than 16 blocks
   (come, the start of follow, a goto through `pve.walk`, kill with the nearest target beyond 16)
   first puts on the best armour and eats to a full food bar when food or health is below 14 (status
   `preparing: eating`, reply `... (eating first)`). At night (the sleep window) without a chestplate,
   worn or in the inventory, `!come`, `!follow` and `!kill` are refused with a reply unless the command
   ends with `now`; `now` also makes the night process yield. Walks (`!goto`, `!home go`, `!top`) are
   never refused: going home at night is the safe move.
3. **Far players** (tasks/process/locator.ts). BDS sends players as entities only within about 75
   blocks; the locator bar (`player_location`, `locator_bar`) gives every other player's position.
   `!come` walks to the locator position, then to the tracked player.
4. **Sleeping** (skills/survival/sleep.ts, tasks/process/night.ts). The night process prefers a bed
   (within 8 of the shelter or home, or at the `bed` waypoint) to standing in the shelter: in the sleep
   window it walks next to the bed, clicks it and stays asleep until the server wakes the bot (morning,
   or the whole server asleep: night skipped). Refused because of monsters: it defends in place and
   tries again every 20 s. `!sleep` asks for it once tonight even with auto-sleep off; `!sleep on|off`
   switches auto-sleep. While asleep the reported position is held at the server's sleeping position.

## Consequences

- Fewer deaths in crowds: in the gauntlet e2e (6 zombies, 2 skeletons along an 80-block `!come` at
  midnight, normal difficulty, iron armour) the bot arrives alive; the cost is time (flights of 20 to
  40 blocks while recovering) and arrivals of 1 to 3 minutes instead of 20 s.
- A guard bot with 8 to 14 health runs from a zombie instead of fighting it. That is deliberate (the
  deaths came from fighting on at low health); `fleeHealth` still sets the trigger.
- Sleeping resets the phantom insomnia counter (phantoms spawn only for players who have not slept for
  3 in-game nights), so a bot that sleeps every night meets no phantoms; with the owner asleep too the
  night is skipped (BDS `playerssleepingpercentage` 100 by default: every player in the overworld).
  An awake owner keeps the bot in bed until the morning; the owner can wake it with any urgent
  command (`!come now`).
- Clicking a bed sets the respawn point to it, even when sleeping is refused; the `spawn` waypoint
  follows it.
- The input loop does not model the sleeping pose; the sleep controller holds the reported position
  through `InputLoop.setTickExtras` (one provider at a time: nothing digs in bed). A proper sleeping
  state in the movement model is left to the movement track.
- The combat weaknesses seen in the gauntlet (a fight locked on one zombie while another hits the bot
  for 10 s) belong to Track V; flee v2 and the hysteresis keep the bot alive meanwhile.
