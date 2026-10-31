# 0049: Long falls within a health budget, and the water bucket clutch

Date: 2026-10-30. Status: accepted (Phase 7, wave 11, Track BI). Details: [../pathfinding.md](../pathfinding.md)
"Long falls", [../movement.md](../movement.md) "Falls and the water bucket clutch".

## Context

The owner: "When it gets stuck on top of a mountain for example, it determines its end goal unreachable.
This is kind of silly considering it has 3 options: A. Fall and survive, B: glide down with elytra, or C:
Water bucket clutch which we haven't implemented. A general water bucket clutch feature if it detects
it's falling or even fall on purpose to clutch would be awesome. It just has to know about water
loggable blocks." The planner's drop stopped at 3 blocks (no damage); every deeper edge was a wall.
Baritone's `MovementFall` / `dynamicFallCost` were left out of the port (0043) on purpose: Java's numbers.
B (the elytra glide down) went to another track (BF, the flight rewrite) and is not part of this one.

## Decisions

1. **The damage model is measured, not assumed.** On BDS 1.26.60.6 (truth:hurtlog, walking off pillars
   and teleports): damage = ceil(counted x landing - 3), where the counted distance is the drop up to the
   tick before the landing tick (12 blocks: 8, not 9; 20 blocks: 16, not 17); landing factors on the
   distance (hay 0.2, honey 0.5, beds 0.5, water / slime / powder snow 0); armour points do nothing,
   Feather Falling (3 per level, boots) and Protection (1 per level, every piece) reduce by 4 % per point,
   capped at 80 %, fractional. Enchantments are read from the item NBT, absorption from the attributes.
2. **The planner may drop deeper when it can afford it.** A fall policy, read live before every plan and
   crossing to the worker as a plain object, lets the drop scan go on to 48 blocks: a harmless landing, or
   damage within health + absorption - `fallMargin` (8). A water bucket never makes a drop beyond that budget
   plannable (review B1): a clutch can fail, so it only saves HP, never a life. Costs prefer walking around
   when it is not much longer: the drop's ticks + `irreversibleDrop` + 40 ticks per HP (a 12-block fall is
   about 90 blocks of walking); a drop the FallGuard will clutch (more than half the budget, a bucket, a
   landing that takes a clutch) costs 40 ticks + a quarter of the HP cost instead, a tie going to the plain
   drop. Off while the health is unknown, the bot burns or a hostile is within 16 blocks; never in the End
   (`maxDrop` 1), never onto slime or a bed, never into water (yet), never through a ladder or vine. Every
   tick the body stands before a planned long drop the navigator asks the live policy again (`dropCheck`):
   health, hostiles, the bucket and the landing may have changed; refused, it stops and re-plans without that drop for 200 ticks. Until a damaging landing's health packet arrives (at most 40 ticks), its predicted damage counts against the budget, so a second chained drop is not taken on the stale health (review M1).
3. **The clutch is one reactive controller, also for planned drops.** The `FallGuard` simulates the rest
   of every fall with the movement model; when the landing matters (review B4: it would kill, leave less
   than the margin, or cost more than half of what is above it; never in creative, in the base or in a fight
   only when it would kill) and a water bucket is in the hotbar, it selects it, looks down and clicks the
   landing block's top face on the first tick the block is within 6.5 of the eye (BDS: 7.19), queued before
   that tick's movement, then picks the water up with the empty bucket once the body is down (within reach,
   the follower held still, at most 100 ticks: review H1). Nothing is armed while a ladder, vine, cobweb,
   scaffolding, a honey wall or Slow Falling slows the fall (review B3). The planner's clutch drop is just a
   priced drop: the same controller flies it. Measured: 0 damage from 15 (planned, health 20), 20, 30 and 50
   blocks and onto a bottom slab, the bucket back, no water left (each twice); scripted clicks 1 to 3 ticks
   before the landing all work, 4 ticks ahead is out of reach.
4. **The waterloggable table decides where water can go.** Measured: a full block that takes no water
   gets a source above it (it breaks the fall); waterloggable blocks take the water inside (layer 1) and
   only a bottom slab then has the feet inside the water (it breaks the fall; a top slab, stairs, fences,
   leaves, panes, grates do not: full damage); chests, trapdoors and signs use the click. The clutch
   therefore targets a full non-waterloggable non-interactive block with air above, or a bottom slab, and
   refuses (with the reason) everything else. Never in the Nether; a landing that does no damage is never
   clutched; the water is always picked up again (6 tries), and no clutch drop is planned inside home's
   `protectRadius`.
5. **A refused fall is explained.** A goto that ends `unreachable` plans once more with the budget lifted;
   (in-thread, capped at 25 ms / 15 000 nodes; not when the blacklist refused the goal); when that finds
   the goal over a long drop, the result carries a `note`: "the way down is a 12-block drop (8 HP), refused:
   it would leave 4 HP, the margin is 8".
6. **Our own code.** Nothing is ported from Baritone (its numbers are Java's); the planner change in
   `astar.ts` is one call after the plain drop scan, the worker gained one option (`falls`) and the
   navigator four hooks (`fallPolicy`, `holdPlans`, `pauseFollow`, `dropCheck`), so the merge with the
   trapdoor (BG) and flight (BF) tracks stays small.

## Consequences

- Settings: `longFalls` (on), `fallMargin` (8), `clutch` (on), `clutchMaxDrop` (40).
- The bot takes fall damage on purpose when walking around is much longer, never more than the budget;
  with a water bucket in the hotbar the bigger of those falls are clutched (and so are falls it did not
  plan that matter: a knock off a ledge, a broken block). Small falls keep their damage and the bucket
  stays put; in a fight the weapon stays in hand unless the fall would kill.
- The navigator holds its re-plans while a clutch's water is still there (16 ticks after the pickup): a
  plan from inside the flow found no move and failed the goto.
- Open: long drops into water (the follower's swim move holds forward through the fall), clicking a
  side face when the landing block takes the water inside, a bucket in the main inventory (it must be in
  the hotbar), cobwebs / scaffolding / beds as landings (unreliable or bouncing: counted as full damage or
  refused), the elytra glide down (Track BF).
