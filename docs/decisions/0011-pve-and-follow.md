# 0011: PvE and follow: melee only, players refused at the lowest layer, guard as an interrupting episode

Date: 2026-10-29. Status: accepted (PLAN.md tasks 7.4, 7.5 and the command part of 7.6). Server: BDS
1.26.60.6 (`bds-pve`, flat world, difficulty normal, truth pack). Details and numbers:
[../pve.md](../pve.md).

## Decisions

1. **No PvP, enforced in the combat skill, not only in the commands.** `CombatController.fight` and
   `attack` refuse any entity of type `minecraft:player` or with a username (`refused_player`), and
   the per-tick fight loop re-checks before every strike. Every target list in tasks/pve.ts skips
   players too, and `!kill` refuses `player`, selectors and the name of any tracked player with a
   clear reply. A bug in target selection can therefore not hit a player: the packet is never built.

2. **Melee with a held weapon, nothing else.** Attacks are `inventory_transaction`
   `item_use_on_entity` / `attack` plus an `animate` swing, on a 10-tick cadence (the mob's hurt
   invulnerability; Bedrock has no attack cooldown). The best hotbar weapon is selected once per
   fight (sword > axe > anything). No bow, shield, armour or potion handling: they need item use
   timing and inventory management that the Realm goal (survive the night on normal) did not need
   in the measurements (0 to 5 health lost per mob with an iron sword).

3. **The navigator approaches, the controller steers the last 3.5 blocks.** Far away the fight uses
   a `near` goal (radius 2.5) re-planned when the target moved 1.5 blocks; within 3.5 blocks on the
   same level it cancels the navigator and steers yaw/pitch/forward itself every tick, because the
   path follower owns the yaw and Bedrock movement is yaw-relative (facing the target and walking
   along a path cannot both hold). The cost: in melee range the bot does not avoid holes. Accepted
   for now (melee range only; the navigator handles everything farther).

4. **Creepers: run when the fuse is lit, else hit and back off.** With the `ignited` flag set and the
   creeper within 7 blocks, the bot runs straight away and waits until the fuse has been out for 10
   ticks; after each strike on a creeper it backs off for 8 ticks. Measured: killed with 3 hits and
   no explosion damage.

5. **Guard is an episode that interrupts the foreground behaviour and resumes it.** The owner's
   behaviour (idle, follow, come, a goto, kill) is the foreground; a guard fight or a flight is an
   episode that suspends it (follow stopped, goto cancelled with its promise kept open) and resumes
   it when no threat is left in range. `!goto` and `!home go` go through this layer (tasks/registry.ts
   `task.goto`), so a zombie on the way does not turn into a `goto: interrupted` reply. An idle bot
   with a home walks back home after a fight.

6. **The night shelter wins.** While night safety wants the shelter: inside it, guard only defends in
   place (hostiles within reach, no walking); on the way there neither guard nor flee interrupts
   (interrupting would count as a failed retreat, measured in the first flee run). Conversely, while
   a PvE behaviour owns the movement, night safety pauses (`inactive`), so the two never fight over
   the navigator. An explicit `!follow` therefore keeps the bot out of the shelter until `!stop`.

7. **Flee is simple.** Below `fleeHealth` (8) with a hostile within 16: run (sprinting) to the
   shelter, else home, else 12 blocks straight away from the nearest hostile; while the health stays
   low guard only defends in place. The bot does not keep facing the attacker while running (the
   navigator owns the yaw); it faces it again when it stops. No eating yet (PLAN.md 7.7), so health
   only comes back through natural regeneration while food is 18 or more.

8. **Mob state is kept beside the world model, not in it.** `MobTracker` (skills/combat/hostiles.ts)
   keeps health, the creeper fuse, `target_eid`, hurt and death animations per runtime id from its own
   packet subscriptions. `EntityInfo` keeps its shape; the only world-model change is that
   `add_player` positions (feet on the wire) are stored as eye positions like `move_player`'s.

9. **Follow re-plans on target movement, not on a timer**, and after a teleport followed by leaving
   view it goes to where the target was before the jump (a 400-block teleport is not a place to walk
   to), then waits there.
