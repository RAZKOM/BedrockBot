# 0090: Room in the inventory (Track V1)

Date: 2026-11-15. Status: accepted; one new setting, `dropStone` (decision 6). Builds on
[0014](0014-survival-kit.md) (the keeper's junk and throwaway rules), the stash step of `!get` (docs/get.md "Stash"),
the home unload (docs/home.md "Decision table") and the Supply's carried boxes (docs/home.md "Supply"). It is a new
record: none of those rules change; one more idle chore uses them, the home chore gets one more trigger, and two skills
that fetch an item into a full hotbar use the survival kit's exchange. Details and numbers: [../inventory.md](../inventory.md).

## Context

The owner asked for inventory management, "especially considering it's carrying shulkers at all times. But also
consider early game."

The live bot sat at 36 of 36 for hours: a worn netherite set, a netherite pick, shovel, sword and axe, a bow and 15
arrows, an elytra, 422 loose rockets (seven stacks) beside a fireworks box of 165, five empty shulker boxes, seven kinds
of food, 16 cobblestone and some mob drops. Why each slot stayed taken:

- Loose rockets are always kept (the flight kit). Nothing moved the ones beyond a trip into the fireworks box.
- The home chore unloaded above 8 stacks of unloadable items or with a full box. The bot carried 6 such stacks and its
  empty boxes counted for nothing, so it never unloaded, even standing at home.
- Empty boxes pile up: a fireworks box emptied by refills stops being the fireworks box (it holds no rockets) and the kit
  moves on to the next; the Supply empties carried boxes for food, torches and build blocks and keeps them; `!bring`
  loads whole boxes. Only the unload sends spares back, and it did not run.
- The keeper drops its junk at 36 of 36 only; idle, nothing else acted.

A full inventory picks nothing up: an ore's drop, a fight's loot, the box of a refill or a stash step coming back. And
two skills failed silently with it: the place skill's `selectItem` and the farm's click park a hotbar item in a free
main slot before bringing the wanted one in; with none free they returned `move_failed` and logged nothing (the same
fault the hotbar puller had, fixed in Track T2 follow-up 2).

A new bot fills the same 36 slots with stone, dirt, gravel and mob drops in an hour of mining. In a job the stash step
keeps it under 36 (it drops filler beyond 16 with no chest and no box); idle, nothing did.

## Decisions

1. **A floor of 4 free slots** (`ROOM_FLOOR`), planned on to 6 (`ROOM_TARGET`) once a pass starts. Four: a box step (the
   stash's, the Supply's, a refill's) needs one slot for the box coming back and one for what lies there with it (the
   Supply keeps two free for that: `ENSURE_MIN_FREE`); a fight's sweep and a dig's drop each bring a new kind; and the
   stash step starts below two, so the floor sits above it.
2. **The cheapest step that loses nothing, in a player's order** (`skills/inventory/room.ts planRoom`, pure):
   1. merge split stacks of one item (the same wire NBT): no box, no walk;
   2. drop the keeper's junk (rotten flesh, poisonous potatoes, string, spider eyes): before 36, not at 36;
   3. loose rockets beyond 128 (`ROCKETS_LOOSE`, two stacks; a Realm trip burns 19 to 31) into the fireworks box;
   4. below the floor only, what the unload would put away into a carried box with room: a `bot_loot` box, a box this
      chore filled, an empty unnamed box; never the fireworks box, a box it cannot read, one owed to a chest or a box
      holding anything else; never what a skill takes loose (torches, buckets, bone meal, the crafting table, pearls);
   5. with a crafting table within reach: redstone, lapis and emeralds into blocks when that frees a slot;
   6. stone-like blocks beyond `dropStone` (64) of each kind, dropped.
3. **Where.** Merge and rockets anywhere. Junk, box, compaction and stone away from the home chests: at home (home set,
   at least one container read, `autoUnload` on) the unload stores those, so the chore leaves them to it.
4. **When.** An idle chore (`tasks/process/room.ts RoomChore`, auto, priority 30): no user process (running, paused or
   held), no test series, nothing else in control for 3 s (a flight, a fight, a flee, the night shelter, the home
   return, a home job) and the inventory unchanged for as long (a pile of drops still being picked up), the kit, the
   stash and the logistics idle, no skill running, no hostile within 12 blocks, and at home no unload due. A command pre-empts it at once (priority 40 over 30) and its skill is cancelled; it never
   starts while an owner's trip or command exists, so it never delays one.
5. **The home chore unloads below the floor too** (`unloadWanted`): fewer than 4 free with anything to unload, a spare
   empty box included, as well as the old bars (more than 8 stacks, a full box). The spares go back to the chest of
   spares, all but the stash step's one, as before.
6. **`dropStone` (default 64)**: the one rule that drops something a player might keep. It is what the stash step already
   does in a job (there keeping 16); idle it keeps more, never drops what a `!get` of the last hour was getting, never
   at home, and says so in chat. 0 turns it off. No setting for the rest: merging, the junk the keeper drops anyway,
   rockets into their own box and loot into a carried box lose nothing (`stashShulker` off stops the box step).
7. **The owner sees what matters.** One `inventory: ...` log line per step and one per pass. At most one chat line per 10
   minutes, only for loot boxed or stone dropped. With the room short and no step left, one line asks (a chest at home,
   an empty box, `!set dropStone`), at most once an hour for the same reason.
8. **The bot does not craft and place a chest** of its own when it has a home and no chest. It cannot tell a build or a
   path from open ground, and a chest placed in the owner's base is worse than a line asking for one.
9. **The two silent faults use the kit's exchange.** The survival kit registers its `exchange` under the inventory model
   (`container/exchange.ts`); the place skill and the farm click, with no free main slot, swap the wanted item with the
   hotbar item they would have parked (the same choice: no durability first, the selected slot last, never a wanted
   item). With no exchange, or one refused, they say why in the log, once a minute an item and reason.
10. **Not known, left:** items the owner gave in the last minutes. The bot cannot tell a gift from a pickup; the rules
    above drop only junk and, with `dropStone`, stone beyond 64 of a kind.
11. **Spare boxes go back on their own** (follow-up after the first deploy: at home the live bot freed 5 slots by its
    room pass and kept its five empty boxes, because 5 free and 6 stacks meet neither unload bar; the owner's
    complaint was the boxes). With nothing to unload, the home chore runs a `spares` job whenever it is idle at home
    with `autoUnload` on, whatever the free slots: the empty unnamed boxes beyond the stash step's one go into the
    chest of spares (a read chest holding an empty box or labelled for boxes, with a free slot), nothing else moves.
    It reuses the unload's deposit trip (`planUnload(..., { spares: true })`, `HomeLogistics.returnSpares`). A job
    that moved no box or left one waits 10 minutes. With no chest of spares, or only full ones, the boxes stay and the
    chore says so once in the log and chat (again only after a chest with room was known in between): a box put into
    some other chest would mix the spares with the stock, and the owner may not want them there.
12. **A merge needs the same wire NBT, and a named box is the owner's** (Track V1c, found by the test presets of
    Track T3). The deposits picked the first partial stack of the same name and metadata, so rockets of another
    flight (or explosions) were sent onto it and refused with error 55; three refusals ended the rocket step with 0
    moved. Every partial-stack choice in the chest skill (deposit, depositSlots, take), the Supply's slot count and the
    refill's room now use the merge step's `stackKey` through `stacksOnto`: the same key first, else an empty slot,
    else a stack whose wire item is not known (the old rule). The loot step took any empty box, a box named by the
    owner for something else included; an empty box with a custom name other than `keepBoxName` is never a candidate.
    On the Realm the box and rocket steps then failed with `the box is not in the hotbar` (the box in the main
    inventory, the hotbar full) and a box set down once did not open. The kit's move into the hotbar now uses its
    `exchange` and returns why it failed; a box that does not open is clicked once more and the block over its lid is
    logged. The lid rule was measured on BDS (open under plants, shut under any collision box) and is the box cell's
    rule plus no snow layer or fire. Not reproduced on BDS: on bds-home a full hotbar brought the box in every time, so
    the Realm cause is left to the next run's reason line.

13. **A drop stays dropped** (Track V1 follow-up 3). On the Realm the stone step dropped 434 cobblestone three times in
    12 s: the bot stood still, the stacks lay at its feet, and the server handed them back once their pickup delay
    (about 2 s) ran out; a fight's `collect r=8` walks to the bot's own throwaways too. Bedrock picks items up on the
    server side when the player's box touches them, so the bot cannot refuse a pickup it stands in. Two rules
    (`skills/inventory/thrown.ts`): every drop request of the keeper (`!drop`, the junk and stone steps, the stash
    step's filler, the junk at 36 of 36) is announced first, and an item actor of that item spawned at the body within
    2 s is the throw; every collect skips those runtime ids for 5 minutes (an item's despawn time). By entity id, so a
    zombie's rotten flesh next to the bot's own is still picked up. And the junk and stone steps throw towards a
    direction with no block within 3 cells at the feet and the head, looking a little up, and walk at least 4 blocks
    away from what landed within 3 (`throwAway`). The keeper's own junk drop at 36 of 36 does not move the body (it runs
    during jobs; the collector rule still holds there).
14. **The box is followed by what it is, not by its slot** (Track V1 follow-up 3). Same session: the plain box in slot
    18 was brought into hotbar 2 by an exchange whose victim was the fireworks box (the only hotbar slot to give), the
    right box was placed, and the step judged it `placed another box than the one wanted`. The place check compared
    each other box's slot and name before and after the place; any move of another box in between (the fireworks box
    now in 18, a resync after the lost packet that renumbers the slots, a keeper move) read as a wrong placement. Now
    the check is a census of the boxes carried by identity (name, custom name, contents; never the stack id, which a
    resync renumbers), wherever they lie: every other box must still be carried, and the wanted one gone or still
    there (its slot update not in yet). A real wrong placement says which box went (`gone from the inventory:
    red_shulker_box 1 -> 0`). The exact Realm event between the exchange and the check is not known (the log has no
    line for it); the next one is named in the reason.

## Consequences

Measured on bds-home, the inventories set by truth (docs/inventory.md "Measured" has the table):

- The live inventory idle away from home: 0 free -> 8 in each of 5 runs, the pass 4.0 to 5.1 s: three merges and 294
  rockets into the fireworks box (128 loose stay), nothing dropped or boxed besides, every item counted.
- An early-game inventory: from 0 to 2 free (the keeper's drop at 36 of 36) to 10 in each of 5 runs: a merge and 434
  cobblestone dropped, 64 kept; 8 more stacks given, 2 -> 10 again; nothing of worth lost.
- At home the same live inventory unloads at 0 free (7 stacks, under the old bar of 8) and 4 spare boxes go back.
- At home with 5 free (the live bot after its first pass) the spares job puts 4 boxes into the chest of spares and
  nothing else, 5 -> 9 free in 7 to 8 s, 5 of 5 (main e372ee3d: nothing in 60 s); with no chest of spares the boxes
  stay and one line says why.
- A placement or a farm click with 36 of 36 and the item in the main inventory works (the kit's exchange); before it
  failed with nothing in the log.
- A box step sets a box down next to the bot (not on a ledge, beside water or lava, or under sand or gravel: the flight
  kit's `unsafeBoxCell`) and picks it up again; no step with a hostile near.
- A drop stays dropped (decision 13; bds-home, the early preset, one run each): 434 cobblestone dropped once, 60 s idle
  with no drop again and 10 free throughout, then a fight whose collect took the zombie's 2 rotten flesh and left the 7
  thrown stacks. Main's code in the same run: the fight's collect took the 434 cobblestone back and the chore dropped
  twice more; the idle part held on BDS on main too (the Realm's pickup at the feet was not reproduced).
- The box followed through an exchange (decision 14): the Realm's hotbar on bds-home, the plain box exchanged with the
  fireworks box and filled, 165 rockets kept; also on main (not reproduced on BDS; the unit test moves another box
  during the place and fails on main).
- Not done: no chest is crafted; owner gifts are not known; the panel shows no room state; no run on the Realm.
