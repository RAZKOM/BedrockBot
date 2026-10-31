# 0048: Trapdoors as vertical passages (hatches over ladder shafts)

Date: 2026-10-30. Status: accepted (Phase 7, wave 11, Track BG).
Details: [../pathfinding.md](../pathfinding.md) "Nodes and moves" (the hatch rows), "Trapdoors", "Known gaps".

## Context

Bases hide their ladder shafts under trapdoors: a hatch in the floor, a ladder under it, a room below. The
planner treated every trapdoor as a wall or a partial floor, so a goal in such a room was unreachable (or
reached by digging), and a bot in the room could not get out. The owner's farm has one.

## Decisions

1. **A trapdoor is a vertical passage when the body fits past its panel.** `NavGrid.hatch(x, y, z)` takes
   the real geometry: an open trapdoor is one full-height panel at most 0.25 thick (`isPanel`), and the 0.6
   body needs 0.62 of free width beside the panel and beside a ladder's box in the cells around the hatch.
   Open and fits: clear. Closed, wooden and fits once opened: a toggle, like a door (`allowOpen`, cost `door`
   10, `noAction` respected). Iron trapdoors (no hand use), too-tight gaps and anything else: blocked. Both
   halves, every facing. An open panel's cell is passable (never a floor), so the climb and fall moves can
   pass it; standing is still decided by the floor below.
2. **Moves (additive in `astar.ts`).** Down: from a node beside the hatch onto the ladder under it (a climb
   node), or, without a ladder, a drop to a floor within `maxDrop` or into water up to 16 below (the swim
   entry). The hatch may be in the walking layer or in the floor layer under it. Up: a climb that reaches a
   hatch toggles it from below and climbs on, then `climbOut` beside the column (never out through the
   panel's side). `moves.trapdoor` switches them off; the planner worker gets the flag through `moves`.
3. **Execution.** The navigator clicks the trapdoor before the move (the use action re-checks `open` in the
   world model, times out and re-plans like a door). `closeTrapdoors` (setting, **default true**) closes it
   behind the body once the body is in another column or its head is below the hatch, within 4.5 blocks;
   not after a drop into water. Default on because a hatch left open is a fall hole for the owner and the
   bot and lets mobs into the room below; it is the same rule as doors (closed behind since Track O). Pending
   closes survive a re-plan. The follower holds sneak on ladders, keeps 0.08 off a panel while climbing, and
   drops into the tightest case (panel opposite the ladder: 0.63 of room, the body within 0.0125 of the
   middle) only after aligning on the floor with single-tick forward pulses, then walking straight in.
4. **Not done: horizontal trapdoor toggling.** A trapdoor standing upright in a corridor stays a wall or an
   open panel. The doorway code path would need a second geometry model for a rare layout.

## Measured (bds-move, BDS 1.26.60.6)

- An open trapdoor is **not climbable** on BDS, even over a ladder: a hatch in the roof layer with the ladder
  ending under it can be gone down, never up (the planner says `none`; the e2e asserts it). The owner's farm
  layout is like this if its ladder stops under the roof block.
- A horizontal collision while the feet are just inside a ladder cell makes the **server** climb (v.y 0.2);
  the local model does not: pressing into the panel while dropping in gave a 0.89 correction. Dropping in,
  the body is therefore aimed at the gap's middle with no press.
- **A fractional move vector is corrected** by BDS (0.8 forward: corrections of 0.7 to 0.8); only whole
  inputs are used, so the fine alignment uses whole one-tick pulses (0.216 blocks to rest on default ground)
  with a chosen yaw.
- e2e `nav-trapdoor` (2 runs): closed hatch down and up with the panel opposite the ladder and on its side,
  an open top-half hatch down and up with no action, the roof-layer hatch down (no plan up), a ladderless
  hatch over a pool (fall of 8): all ok, 0 corrections, 99 to 133 ticks each.

## Realm findings (BG2)

Date: 2026-10-31. On the owner's Realm (YourRealm, farm hatch at 40 135 60) the hatch was opened from the
platform, but the close from the ladder was `rejected`, the goto counted a failure and retreated, and the hatch
stayed open; going up, two pillars failed with `no_headroom` and the click from below was `rejected`.

- **Layout** (the Realm world cache, 2-bit classes x 35..47, z 55..65, y 128..137): a platform with feet
  135, the trapdoor in its walking layer, a wall block west of it, the ladder column under it from 131 up into
  the floor layer 134, a room x 41..42, z 57..60, feet 131, 3 high (ceiling 134), closed except for the
  shaft. So it is case B (down and up), not the down-only roof-layer case.
- **Cause 1: sneaking with an item in the hand.** BDS (and the Realm) treat a sneaking click with a non-empty
  hand as an item use: the trapdoor does not toggle and the server sends the old state back (`update_block`
  restores: our `rejected`). Measured on bds-move from the top rung: empty hand opens sneaking or not; a
  netherite pickaxe, a sword, cobblestone and a red shulker box are rejected sneaking (2 restores each) and open
  standing. Track BG's e2e bot had an empty hand; the navigator holds sneak on ladders, so every click from the
  ladder failed on the Realm (the bot holds a tool or blocks). The open from the platform worked (no sneak).
  Fix: `UseSkill` releases sneak from the look ticks to the tick after the click when the hand is not empty and
  the input loop holds sneak, then presses it again; the navigator leaves sneak to a running use / close. The
  body slides at most about 0.15 on the ladder meanwhile. (Chest opens use another code path: same rule, not
  changed here.)
- **Cause 2: a failed close was a goto failure** (failure count, retreat to the last safe node, re-plan).
  Now a failed close is clicked once more, then the hatch stays open with a log line and `closeFailed` in the
  report; the walk goes on.
- **Cause 3: closes lost on a re-plan.** A re-plan scheduled the pending close only when the new path did not
  pass the hatch cell, and a close due at the new path's first node never ran (legs check from the second node).
  The Realm descent had 12 plans and no close attempt; on BDS a 0.014 correction re-plan mid-climb dropped it.
  Now the close is scheduled after the last node whose body is in the hatch cell, and a close due at a leg's
  first node runs first.
- **Cause 4: pillars the executor refuses.** The planner allowed a pillar with only the cell 2 above the feet
  free; `PlaceSkill` also wants the cell 3 above (the jump's head room) and refused with `no_headroom` in the
  3-high room. The plain pillar now needs both cells free, and the pillar + dig variant refuses a block over the
  dug cell. Why the Realm plan preferred the pillars over the ladder is not reproduced on the replica (the
  planner always took the ladder there, with stone or planks, closed or open hatch, a pickaxe, an axe and blocks
  carried); with the rule the 3-high room has no pillar plan at all.
- **A drop-in correction (follower).** Dropping into the tight gap (panel opposite the ladder) with speed left
  along the free axis, the body passed the column centre; the climb controller turned 180 degrees (30 per tick,
  no input) and the body hit the far side of the shaft, where the server climbs: a 0.72 correction, every time,
  on the second descent from where the climb had ended. The controller now backs up to a centre behind it.
- **Measured: no climbing out of a roof-layer hatch.** Holding jump (and forward towards each exit) from the top
  rung under an open trapdoor in the floor layer: the feet peak at -53.45 for an exit floor at -53, for all 4
  facings and both halves. Case A stays down only.
- e2e `nav-hatch-realm` (the farm replica: 3 items x 2 panel sides x down and up twice): 2 runs, 48 of 48 gotos
  ok, 0 corrections, use 1 / close 1 / place 0 / dig 0 each; 80 to 93 ticks, except the first climb with the
  panel opposite the ladder in run 2 (136 to 138 ticks, 1 stuck recovered). Regressions: `nav-trapdoor` and
  `nav-ladder` all ok with 0 corrections.
