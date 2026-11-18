# 0098: Day one from nothing (Track E1)

Date: 2026-11-17. Status: accepted. `!craft` chains and `!get <craftable>` / `!get kit` are on (commands); the night
shell (`nightShell`) ships off. Details and numbers: [../early-game.md](../early-game.md).

## Context

An owner who starts the bot on a fresh survival world with an empty inventory types what a player would: a crafting
table, a wooden then a stone pickaxe, a sword, food, a shelter for the night. Measured on a fresh normal-difficulty
world (BDS 1.26.60.6), the commands as they were:

- `!get crafting_table` (and every crafted item): `get: I do not know how to get crafting_table`.
- `!craft crafting_table` with logs only: `craft: no oak_planks for crafting_table (need 4, have 0)`; the owner had to
  craft planks, then the table, then sticks, then the pickaxe, one command each.
- `!craft wooden_pickaxe` with a table, planks and sticks carried, by the trees it had just felled: `craft: made no
  wooden_pickaxe (no_table)`, the log `no free cell next to the bot for a crafting table`. Every cell round the feet was
  leaf litter or leaves; the crafter used the shulker box's spot rule (a lid needs air over the box).
- `!craft stone_pickaxe`: `craft: no stone_tool_materials for stone_pickaxe (need 3, have 0)`, a recipe tag the owner
  cannot type or get.
- `!craft white_bed`: `no recipe`; the item is `bed` on Bedrock.
- The night: the shelter an owner can set is a point on the ground. In the open the bot was shot by skeletons and
  died (an empty bot and a bot with the stone kit alike).

## Decision

1. **Craft chains (`skills/craft/chain.ts`).** `planChain` takes from what is carried and crafts what is short from
   recipes over it, depth 5: planks from logs, sticks from planks, a crafting table when a 3 x 3 recipe needs one and
   none is carried or near (counted once, not consumed). A tag cell (any planks, any stone tool material) tries the
   carried kinds first, then a default (`oak_planks`, `cobblestone`). What cannot be crafted is named as the raw item.
2. **`!craft` runs the chain in the same process.** The start line says what is crafted first, the end line what was;
   a refusal names the raw material and says when `!get` would get it all (`craft: no cobblestone for stone_pickaxe (3
   cobblestone missing; it would craft 1 crafting_table, 4 stick first; !get stone_pickaxe gets it all)`).
3. **`!get <craftable>` and `!get kit` (`skills/items/obtain.ts`, `chat/commands-kit.ts`).** An item the catalog does
   not know but a recipe makes is an obtain job: the planner names the next command from the inventory (`!gather n` for
   the logs of every target in one trip, `!mine stone n` for cobblestone, `!kill sheep n` for wool, `!food n`,
   `!craft item n`), a block no carried tool harvests gets its pickaxe first (stone: wooden; iron ore: stone), and the
   job runs that command as the owner, waits for its process to end and asks again. It ends when everything is carried,
   when a step gets nothing (with that command's reply), on `!get stop`, or when the owner types a command that moves the
   bot. Food is the soft target: with some food carried a step that finds no more animals ends the job as done, with the
   count. What has no rule (iron ingots: smelting) is refused with the reason. `!get kit` is a crafting table, a stone
   sword, pickaxe and axe, 16 cobblestone kept, 6 food.
4. **A table goes where a table fits (`skills/craft/table-spot.ts`).** The ring round the feet; empty, or a cover a
   hand clears at once (leaf litter, a flower, a tuft: dug first); a full solid, not built top under it; no lid rule.
5. **`<colour>_bed` names the bed item** in `!craft` and `!get`.
6. **The night shell (`nightShell`, off).** Inside the shelter after dusk, under the open sky (nothing but air or a tree's
   leaves and logs in the 24 cells over the head: a canopy is no roof) and with throwaway blocks for every open cell, the bot walls itself in with Track M1's shell
   (`skills/survival/seal.ts`, 10 blocks on open ground: the 8 round the feet and the head, the roof and its support;
   never the dig-in); a cover in its cells (leaf litter, a flower) is dug first. At dawn, before the walk home, it digs one side open: the side farthest from the hostiles, only
   cells it placed. The rest stands; the next night it places the open side again, and its own roof does not count as a
   roof. Two tries a night; a new shelter forgets the old shell. With a hostile within 16 at dawn the shell stays
   shut until none is, at most 1800 ticks (`NIGHT_SHELL_DAWN_WAIT`: the sun up, the undead burning); opened at 23000
   with a skeleton near, a bot was shot from 20 to 6 at the open side.

## Consequences

- From an empty inventory `!get kit` took 124 to 213 s on a fresh world in 13 of 13 runs (one log trip, 7 to 9
  steps), `!get stone_pickaxe` 42 to 46 s on a test patch; the owner types one command instead of eleven.
- The chain only uses grid recipes the server sent; furnace recipes (smelting) are not chained, so nothing made of iron
  is reachable from `!get` yet.
- The table may now go on a cleared litter or flower cell; the crafter digs it (the cover drops as an item).
- The shell changes the shelter cell's surroundings for good (8 blocks stand after dawn). It is off by default because it
  places blocks round the body and was measured in one forest only. There, off: a death in each of 4 nights; closed: 7
  nights, no death, no damage by night in 6 (a spider bit through the corners in one); numbers in the doc.
- Not covered: a bed placed and slept in, iron, armour, a furnace and cooked food, a farm; the order these come in is
  the doc's "Still missing".
