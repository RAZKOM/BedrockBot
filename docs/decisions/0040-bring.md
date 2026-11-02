# 0040: `!bring`: stored items to the owner, `!get` stays the maker

Date: 2026-10-30. Status: accepted (PLAN.md Phase 7 wave 10, Track AS; follows 0025 and 0028).
Server: BDS 1.26.60.6 (`bds-home`). Details and numbers: [../home.md](../home.md) "Bring",
[../get.md](../get.md) "`!get` or `!bring`".

## Context

The owner asked for a retrieve command that brings items to the player instead of unloading at home,
or some way to tell fetching already stored items apart from gathering new resources, with either one
ending at the player or at home. Since wave 9 the bot knows what the chests at home hold
(0028) but had no way to take anything back out; `!get` makes new things and must never take from
chests (0034's rule).

## Decisions

1. **Two verbs, not a flag.** `!get` makes new things and ends where the job ends (home: `!unload`);
   `!bring <item> [n] [to <player>|home]` takes stored things and ends at the player. `!get` stays
   chest-free; when the chests already hold n of the item its first reply says so and names `!bring`
   (setting `getSuggestsBring`, on), and it still makes new ones.
2. **The chest memory plans, the chest corrects it.** Carried items count first; the rest comes from
   the nearest chests by the memory's counts; before every chest trip the plan is made again from the
   memory as the last trip left it (a chest that held less only sends the bot on). The memory follows
   every take at once, so `!stock` is right before the next scan.
3. **Shulker boxes are a last resort, taken whole.** The chest record now remembers what full boxes
   hold (`inBoxes`, from the NBT `Items` seen at every read). A box is taken out only when the loose
   stacks are not enough, and both replies say so. No box is opened at home (placing, opening and
   breaking one costs about 5 s and a free cell; not required now).
4. **The delivery is `!come`'s walk**: the tracked player, else the locator bar, trip readiness first,
   within 2 blocks. The items stay carried (handing over is `!drop`). Home, the console, or a player
   who is not online: the bot carries them home and says why.
5. **One user process, two phases** (`BringProcess`): a pre-emption reruns the current phase; the
   withdrawal takes only what is still missing, the walk restarts from where the bot stands.

## Consequences

- `!bring` joins the front door (13 commands; `!help` still fits in 4 messages with a short phrase).
- The NL plan gets a `bring` step; "get me coal" stays `get`.
- Measured on bds-home: 64 torches (40 + 30 from two chests 10 blocks apart) to a player 30 blocks away
  in 13.6 to 13.7 s; 3 stacks the same way in 13.6 to 13.7 s.
- Open: taking the items out of a box (instead of the whole box); handing over by dropping toward the
  player; a `!bring` from chests away from home (only `homeChestRadius` is planned from).
