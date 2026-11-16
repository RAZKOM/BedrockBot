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

## Consequences

Measured on bds-home, the inventories set by truth (docs/inventory.md "Measured" has the table):

- The live inventory idle away from home: 0 free -> 8 in each of 5 runs, the pass 4.0 to 5.1 s: three merges and 294
  rockets into the fireworks box (128 loose stay), nothing dropped or boxed besides, every item counted.
- An early-game inventory: from 0 to 2 free (the keeper's drop at 36 of 36) to 10 in each of 5 runs: a merge and 434
  cobblestone dropped, 64 kept; 8 more stacks given, 2 -> 10 again; nothing of worth lost.
- At home the same live inventory unloads at 0 free (7 stacks, under the old bar of 8) and 4 spare boxes go back.
- A placement or a farm click with 36 of 36 and the item in the main inventory works (the kit's exchange); before it
  failed with nothing in the log.
- A box step sets a box down next to the bot (not on a ledge, beside water or lava, or under sand or gravel: the flight
  kit's `unsafeBoxCell`) and picks it up again; no step with a hostile near.
- Not done: no chest is crafted; owner gifts are not known; the panel shows no room state; no run on the Realm.
