# 0010: Placing and using blocks: one click packet, server-verified results, predicted pillars

Date: 2026-10-29. Status: accepted (PLAN.md task 7.3, Track O). Server: BDS 1.26.60.6 (`bds-act`,
flat world, truth pack). Details and numbers: [../interaction.md](../interaction.md).

## Decisions

1. **One packet for both: `inventory_transaction` item_use / click_block.** Placing and using are the
   same client action (a click on a face of a block); the server decides by the clicked block and
   the held item. The chest skill already proved the shape; probes showed what BDS checks (the
   clicked block's runtime id, the target cell against the bodies, the click range, a current held
   item) and what it ignores (view, `player_pos`, click point, trigger type, prediction flag). The
   `player_auth_input` transaction field and `player_action` start/stop_item_use_on are not used: not
   needed, and they add ordering questions.

2. **A result is the server's block update, never the click.** `place()` and `useBlock()` resolve
   on the `update_block` that shows the change (new block at `p`; changed open/pressed bit at the
   state holder). The server answers a refused click with the same update burst carrying the OLD
   state, which gives an explicit `rejected` within 2 ticks instead of a timeout. Callers get ticks
   and distances with every result.

3. **Refuse locally what the server would refuse silently.** Reach (eye to the clicked block's min
   corner, 7.19 measured; own reach 5 to the closest point), the body cell, occupied targets,
   interactive supports (a click on a door would open it), iron doors, open/closed on buttons and
   levers: all answered before any packet. The e2e suites count the click packets to hold this.

4. **Pillar-up lives in `place()`, not in the navigator.** "Place into the cell my feet are in" is
   only meaningful as a jump-and-place, and its timing depends on what was sent (the click must
   follow an input with the feet above the cell). The skill presses jump itself when standing, or
   just waits for the clearance when the caller is already jumping. The movement model predicts the
   block from the click on (a wrapper around `loop.world`), so the landing does not depend on the
   round trip; a refusal removes the prediction.

5. **Items are fetched with the inventory screen open.** BDS 1.26.60 refuses item stack requests
   between player inventory slots without an open inventory window (status 49/50). The placer opens
   it with `interact open_inventory` around the single move and closes it after, rather than keeping
   a window open (which would break the chest skill's "a stale window is closed first" rule).

6. **Door shapes are measured and published, not wired.** minecraft-data's door collision box is
   wrong for every state but one, so the nav grid never passes a door cell. The real geometry was
   measured with the bot's body (truth:pos stop positions) and is exposed as
   `skills/interact/shapes.ts`; plugging it into `terrain/shapes.ts` and the planner is the
   navigation track's change (skills/nav and skills/terrain are being rewritten in parallel). Until
   then the "goto through a door" e2e is an `it.fails` that flips when the fix lands; gates (no box
   when open) already work.
