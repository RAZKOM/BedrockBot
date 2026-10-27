# 0027: Food v2: herd marks beside the world cache, pens by flood fill, breeding over the mob click

Date: 2026-10-30. Status: accepted (Track AF, wave 8). Server: BDS 1.26.60.6 (`bds-food`, flat world,
difficulty easy, truth pack). Details and numbers: [../food.md](../food.md) "Herd memory", "Pens",
"Breeding", "Measured (food v2)". Builds on [0019](0019-food-gathering.md).

## Context

Food gathering (0019) stopped at 48 blocks from the bot, killed animals without ever replacing them
(`foodLeave` was the only brake), and could not tell the owner's farm animals from wild ones, so the
Realm bot runs with `autoFood` off. The owner wants the bot to feed itself without emptying the farm,
and the farm to grow back.

## Decisions

1. **Herd marks are a sidecar of the world cache, not block marks.** Block marks live in the chunk
   summaries and are rebuilt from the blocks whenever a column loads (the ore memory had to carry its
   `seen` flag across that rebuild, 0021); an animal is not a block and moves. One mark kind, one per
   16-block cell and dimension (mean position, adults and babies per kind, wild and penned, time),
   stored as `herds.json` beside the region files and written with the cache's flush
   (`WorldCache.herds`, four small lines in cache.ts, one optional field on `CachedTerrain`). Without a
   cache the same store lives in memory. Marks are rewritten from the entity tracker once a second and
   dropped when the bot is within 32 blocks and the tracker shows the cell empty for 2.5 s (the
   tracker keeps cows to about 80 blocks, measured).

2. **Remembered herds extend the hunt, not replace it.** The tracker within 48 blocks first (as in
   0019); only when that is exhausted does the job walk to the nearest mark within 200 blocks that
   offers more than the leave rule allows, at most 4 walks per job, with the normal walk (so guard,
   flee and night pre-empt it as for every user process, and the resume walks on). Stale marks near the
   bot (cell empty in the tracker) are not followed. The food chore may start on a mark too.

3. **A pen is "enclosed by fences within 12 blocks", decided by a flood fill on the mob's level.**
   Fences, walls and fence gates (open or closed) and anything 1.5 high or two blocks high are walls;
   at least one fence, wall or gate must be on the rim; unloaded blocks mean "not a pen". The rule the
   owner can predict: animals inside fences are never hunted, except in the `chorePen` pen or with
   `!food n pen`, and never below 2 adults of a kind per pen; babies never. The leave rule counts wild
   animals only. Results are memoized per interior cell for 10 s (one fill per pen, at most 625 cells).

4. **Breeding is the attack packet with `action_type: 'interact'`.** Verified on BDS 1.26.60.6: with
   the food selected, an `item_use_on_entity` / `interact` transaction (plus the client's
   `mouse_over_entity` hover) takes one item and sets the `inlove` actor flag within 2 to 3 ticks; the
   calf appears 3.1 to 3.4 s after the second parent is fed. Fed parents are remembered for the vanilla
   5-minute cooldown (not fed again, spared by the hunt). `!breed [type] [n]` is a user process.

5. **The breeding chore is a second chore at priority 30, after the food chore.** On with `autoBreed`
   (default off) and a `chorePen` (a new text setting: `x y z` or `none`); it does nothing while the
   food chore runs; once per 10 minutes it walks to the pen and feeds pairs of a kind with fewer than 8
   adults there when the bot carries the food.

6. **Gates are closed.** Hunting or breeding inside a pen with the planner's `closeDoors` was not
   enough (a walk that ends just inside the gate does not close it, and an already open gate is never
   closed), and cows walked out of the open gate in the e2e. The hunter and the breeder close the pen's
   open gates within reach after walking in, and walk out through the nearest gate and close it after
   the work.

7. **A text setting kind.** `chorePen` needed a value that is neither a number nor a switch; settings.ts
   gained a `text` kind with its own parser (validated, persisted like the others).

## Consequences

- The Realm bot can run `autoFood` on near the owner's farm: the farm animals are inside fences. Food
  runs reach herds up to 200 blocks away that the bot has passed.
- With `autoBreed` and `chorePen` set and wheat (or the kind's food) carried, the pen refills to 8
  adults of a kind, and the food chore may take the pen down to 2 adults: a sustainable loop.
- `!food 6` in the 0019 e2e had to become `!food 6 pen` (its cows are in a pen); the auto-trigger test
  sets the pen as `chorePen`.
- Open: odd pen shapes (sloped fences, pens larger than 25 x 25, barns without fences) read as no pen;
  only cows were bred in the tests; marks are per bot.

## Rejected

- **Herd marks as block marks inside the chunk summaries**: rebuilt on every load, so they would need
  the same carry-over the ore memory needed, for data that is not about blocks at all.
- **Leaving pens to `foodLeave`**: the owner cannot predict which 2 animals within 48 blocks survive.
- **Detecting pens from the cache's 2-bit classes**: a fence and a stone block are both `solid`; the
  fill needs the real block (fence, gate, height), and animals near the bot are in loaded chunks anyway.
- **Breeding as part of the food chore**: different trigger (a pen and its food, not hunger), different
  period, and it must not delay eating; a separate process at the same priority stays simple.
