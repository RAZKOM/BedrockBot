# 0102: A starter farm, the farm chore and bread (Track E6)

Date: 2026-11-18. Status: accepted. `!farm new` is a typed command (on); the farm chore that harvests, replants and
bakes by itself (`farmFood`) is off by default, since it digs crops and places seeds. Details and numbers:
[../farming.md](../farming.md) "A starter farm" and [../early-game.md](../early-game.md) "A farm".

## Context

Track E1's first kit run found the hunt running out near home, and E2's and E3's left "a farm" as the last early-game
gap: `!farm` works a field that exists, nothing makes one. On a fresh world with the iron kit and no farm, `!get
bread` answered `no way to get bread yet: it needs wheat, which is not gathered, mined, hunted or crafted from
those`, `!get wheat` and `!farm` ran one round of a field that was not there and said `farm: done, nothing left to
harvest or plant`, and the food chore could only hunt. Over 3 game days left alone the hunt still kept the bot fed
(see the tables in early-game.md): food is not short on day 3 near a fresh spawn, but each hunt takes the animals
near home and nothing grows them back.

## Decision

1. **`!farm new [n]`, under `!farm`.** The name: the field it makes is the field `!farm` works and `!farm stop` /
   `!farm status` cover both, so it is a word of the same command rather than a new one (`!plot`, `!till`), and `new`
   reads as what it does (a new farm) next to `!farm`'s radius and `wait`. n is odd, 3 to 9 (default 9): one water
   source moistens farmland up to 4 cells away, so 9 x 9 round one water cell is the largest plot one bucket waters.
2. **The site (skills/farm/plot.ts, pure).** The nearest n x n of grass or dirt (a path, or farmland already) at one
   height round the anchor (home, else the bot) within 24, with air or a plant a hand clears over every cell and the
   cell over that, a full block under the middle (the water stays a source in a one-deep hole), and a floor under
   every rim cell (the fence line). No plot cell, rim included, within 3 of the anchor (the walk home and the bed stay
   clear), never a built block.
3. **The owner's builds are never touched.** The plot may lie inside `protectRadius` of home only when the base is the
   bot's own: no built block (terrain/classify.ts isBuiltBlock) within protectRadius of home but a bed, a crafting
   table, a furnace (what the bot sets down by home) and the fence of its own farm. Otherwise every plot cell lies more
   than protectRadius + 2 from home, and the start line names the count and the nearest block. Built blocks more than
   8 under home do not count: a surface farm touches no cellar, and large ore veins generate raw copper and raw iron
   blocks, which are "built" kinds.
4. **The work (skills/farm/setup.ts), phases a pause stops and a resume goes on with:** grass broken for seeds round
   the plot (the bot walks there first when more than 24 off; within 24, until a seed for every cell without a crop,
   none left or 150 s); the bucket filled at the nearest still water within 48, else 96, when only an empty one is
   carried, the middle dug and the water poured (with no bucket or water the plot stays dry: crops grow, slower); the
   plants on the soil dug (the hoe refuses a covered cell); each cell tilled with the best hoe carried, on a dry plot
   only as many as there are seeds (bare dry farmland turns back to dirt); the farmer's own loop (`!farm`, following
   the field) plants the farmland; a fence on every free rim cell and a gate in the side facing home; the walk home.
   A missing hoe (stone, else wooden) and the fences and gate come from the obtain job (ADR 0098), the hoe before the
   work and the fences after the planting so a short wood trip does not hold the crops back. The fence wood is a kind
   carried that covers the fence, else the commonest logs round the plot, else the kind carried most, else oak; a try
   that ends short gets one more from the wood then carried, mixed when no one kind covers it (posts of different
   woods join; the obtain job's gather counts logs of any kind, so asking it for more of one kind gets nothing). The
   `farm` waypoint marks the middle; the plot's size is read back off the field. Run again it does what is left (1 s
   on a plot set up).
5. **The farm chore (`farmFood`, off; tasks/process/farm-new.ts, PRIORITY.chore).** By day, with no user process and
   the food chore idle, at the bot's own farm within 64: when 16 crops (or a quarter of the crops) are ripe, or the
   food carried is under `foodMin` and the ripe crops and the wheat carried make a loaf, it harvests and replants (the
   farmer's loop), picks up from the cells beside the middle what fell into the water (the farmer's pickup walks for
   the hole and times out) and plants those seeds, and crafts all the wheat into bread, out of the plot first (inside it every cell round the feet is a
   crop or a fence: no cell for a crafting table). 5 minutes before the next look after a run that got nothing.
6. **The food chore prefers the farm.** While the farm can feed the bot now (`canFeed`: the ripe crops and the wheat
   carried make a loaf, or a farm run going) the food chore starts no hunt; it hunts when the farm has nothing to give.
7. **A farmer fix (skills/farm/farmer.ts).** A stand where nothing got done counts as a failed stand (two and it is
   left): a dry 3 x 3 plot's middle reached every cell, the body stood next to the last one and its planting was
   refused before any click, and the loop chose the same stand for ever (`!farm new` stayed in the plant step; the e2e
   case timed out at 300 s).
8. **The plot job's loops always end or yield.** A place refused before any click (`in_body`) resolves at once, and
   the fence step asked for the same cell for ever without yielding (19 minutes of one core on the test server; the
   test's own timeout could not fire). The bot now steps off the line after such a refusal, leaves a cell refused 3
   times, and caps the step at 3 rounds per line cell. A fence or a gate on the line is never a free cell (an open
   gate has no collision box) and holds the line in the site check (a post is not a full block). The middle cell is
   dug up to 3 times (one timed-out dig left a fresh-world plot dry). A pour that does not show at once is looked at
   again for up to 2 s (one read `rejected` went in a second later, and the end line called a wet plot dry). The chore
   is named `farmchore`: `farm` is `!farm`'s process, which other code finds by name.

## Consequences

- Measured on a flat test world (e2e early-farm, 5 cases): a 5 x 5 by home with the kit given 43 to 50 s, 24 of 24
  tilled and planted, the pond 8 off emptied into the middle, 23 fences and the gate; the chore on that plot all
  ripe: 24 harvested and replanted, 8 bread in 34 s (before the walk-out rule: `craft: no free cell next to the bot
  for a crafting table`, 0 bread); a 3 x 3 with no hoe or fences and 40 planks: the stone hoe 3 s, 15 fences and the
  gate 4 s, 19 s in all; planks 3 from home and protectRadius 12: the plot past 14; no seeds: 40 grass broken gave 8.
- On a fresh world (seed 7, the iron kit, 6 setups) `!farm new` 9 took 270 to 321 s: the hoe 35 to 50 s (a log
  trip for the sticks), 150 s of grass for 14 to 29 seeds, the fence 30 to 35 posts and the gate. There was no still
  water within 96, so a plot made with the kit's empty bucket was dry.
- A farm feeds the early bot late. Dry, nothing was ripe after 3 game days; watered, the first wheat came on day 3
  or 4 and then about a loaf a day (BDS grows crops by day only, as the night is slept through). Deaths and hunger
  were the same with and without it: 0 deaths, lowest hunger 15 to 17. The hunt still feeds the bot in the first
  days, and `farmFood` stays off by default. The tables are in early-game.md "A farm".

Not decided here: an animal pen (optional in the brief, not built), carrots or potatoes, a farm away from home,
bone meal for the first crop, and turning `farmFood` on by default.
