# 0029: Combat v3: re-targeting within reach, the crowd rule, a shield in the offhand

Date: 2026-10-30. Status: accepted (Track AH, wave 9). Server: BDS 1.26.60.6 (`bds-pve`, flat world,
difficulty normal, truth pack). Details and numbers: [../pve.md](../pve.md) "Re-targeting within
reach", "Crowd rule", "Shield". Builds on [0017](0017-combat-that-keeps-the-bot-alive.md) and
[0018](0018-survival-policy.md).

## Context

A fight (guard, `!kill`) stayed on the target it started with until that target died or the fight
gave up. Track W's gauntlet saw a guard fight locked on one zombie while a second zombie landed 10
hits in 13 s. The owner asked why the bot does not always target whatever is within its reach
instead of risking being hit, since a hostile mob within reach is presumably targeting the bot. Two more
gaps: nothing made the bot leave a crowd it was losing before its health hit `fleeHealth`, and a
shield, Bedrock's main defence against skeletons, was ignored.

## Decisions

1. **The target is re-picked within reach on every strike cycle.** Among the threats within reach
   (eye to box 3.2): a mob that hit us in the last 10 s first, then a creeper, then the nearest; the
   current target keeps a 0.3-block bonus. A target that leaves reach while another threat is in reach
   is dropped at once, no chase. After a kill the next threat within reach is fought in the same
   fight, and a fight switched away from its requested target goes back to it when nothing is in
   reach (the caller still gets "its" target in `FightResult`, plus `retargets` and `kills`). Not while
   the target is a creeper (hit and run leaves reach on purpose).

2. **Three refinements, all from measurements.** (a) BDS says who hit us: the attacker's
   `entity_event arm_swing` arrives in the same batch as our hurt; `MobTracker` uses it before its old
   guesses (nearest mob targeting us, ...), which named the wrong zombie whenever two took turns.
   (b) Every mob that hit us in the last 10 s ranks the same, and a target our own strike knocked out
   of reach is kept until the next strike cycle: with "the very last attacker" and "out of reach at
   once" literally, two zombies beside the bot made it switch on every knockback and take 13 hits
   against 5 for the old single target. (c) A new target within reach is faced at once instead of 40
   degrees per tick (BDS does not check the view direction of attacks strictly). With these, with two
   zombies beside the bot re-targeting is still slightly worse than the single target (14 hits
   against 9 over 10 runs each: knockback keeps both off either way, and focusing kills one sooner),
   and when the bot is sent at a mob 8 blocks away with another one behind it (Track W's case) it
   took fewer hits (1 against 6 over 10 runs each; pve.md table). We keep the rule because the second
   case is the one that hurt on the Realm; the first is the cost.

3. **Crowd rule: 3 or more melee threats within 4 blocks and health below 12 end the fight `crowded`,
   and that is a flee trigger** (`targeting.crowded` / `crowdThreat`; `wantsFlee` is true for the
   crowd; one line in `PveController.fleeReason`). While a fight runs the fight decides, so the
   outcome is visible; the flee trigger counts the crowd when no fight runs or within 5 ticks of a
   `crowded` end. A fight that starts within 3 s of a `crowded` end (flee was on cooldown or cornered)
   does not apply the rule: the bot defends rather than ending fights in a loop. 12 sits between
   `fleeHealth` (8) and the recovery target (14); melee only, because running from archers in a line
   only gives them targets (0018).

4. **A shield goes to the offhand, and is raised by sneaking.** The offhand move is one
   `item_stack_request` `place` from the hotbar / inventory slot to `{ container_id: 'offhand' }`,
   slot 1, with the inventory screen open (without it: status 50), done only when no fight runs and
   the offhand is empty. Raising it needs nothing but sneaking (the server stamps the item's
   `blocking_tick` and blocks frontal hits: a zombie did 0 instead of 3 per hit, 4 durability each;
   an arrow 5). In a fight it is up while an archer's shot is due and the bot is not striking (never
   on a strike tick or within reach of a melee target), and for 10 ticks after a creeper's fuse
   lights, backing off facing it. A skeleton's draw is invisible to a client (no flag, no metadata),
   so the shot is predicted: every 61 ticks from its last `bow` sound, or from its `target_eid`, up
   14 ticks before and 8 after, plus any fresh arrow flying at the bot.

## Consequences

- Fights now end `crowded` (new outcome; not ignored afterwards) and may kill more than one mob;
  callers that count kills by `FightResult.ok` still count the requested target only.
- Raised, the shield is total against a zombie in front (0 damage against 21 in 8 s); in skeleton
  duels the predicted window caught 12 of 48 arrows (arrows that hurt: 36 with the shield, 48
  without, over 25 duels each); creeper duels with it: 9 of 9 killed, 0 explosion damage.
- The shield is never used outside fights (walking, fleeing, idle), covers the front only, and
  sneaking slows the approach while it is up. The 61-tick period is measured for skeletons on normal;
  other archers and difficulties may differ (strays and bogged share the AI; pillagers use a
  crossbow sound, also matched).
- Re-targeting costs a little when the mobs are all next to the bot; its value is the fight on a
  target out of reach while another mob is in reach. The crowd rule did not reduce damage in the
  measured setting (3 zombies, iron armour, health 11: mean 5.2 per run with it, 5.3 without over 18 runs each, no
  deaths; the bot runs at that health anyway): it is in as specified, behind a switch, and needs a
  Realm night or an unarmoured measurement before anyone relies on it. `FightOptions.retarget: false` /
  `combat.retarget = false` restore the old single target, `combat.crowdRule = false` disables the
  crowd rule on both sides (both used by the e2e comparisons).
- Truth pack: `stance` and `blocklog` (packs/truth/src/shield.ts) give tests the server's view of
  sneaking, the offhand and blocked hits.
