# 0086: A landing looks at hostile mobs, and the elytra flee is a flight (Track M3)

Date: 2026-11-14. Status: accepted; `flyLandMobs` default off, `fleeFly` default off (as before) until both have run
on the Realm. Builds on [0047](0047-flight-landing-v3.md) (the landing search), [0057](0057-flight-manoeuvres.md)
(the brake / elevator landing), [0076](0076-land-by-time.md) (a landing priced in seconds, the alternatives),
[0084](0084-landing-over-what-stands-round-it.md) and [0085](0085-way-down-to-the-landing.md) (the landing flown in
over what stands round it), and [0079](0079-never-die-to-mobs.md) (the reflex, the floors, the elytra flee as
`!fly home`). Details and numbers: [../flight.md](../flight.md) "The landing looks at hostile mobs (Track M3)" and
[../pve.md](../pve.md) "Track M3: the elytra flee as a flight mode". The flee's decisions (9 to 14) are here and not
an addendum to 0079 because they are decisions about the flight: what 0079 said the flee needed from the flight code
(its decisions 22 and 27).

## Context

The owner's goal: the bot never dies to creepers, zombies, skeletons, phantoms and their like, and a trip is flown
from start to finish. The mob guard (0079) covers the ground. Under a flight it is paused, and the flight knew
nothing about entities: the landing search chooses a cell by its walk, the brain flies the brake and the elevator
onto it.

On the Realm (2026-11-14, about 70 night trips) that cost three landings. A flight braked 85 ticks over a cell with
a creeper on it and was blown up 4 ticks after the guard had the body back (7.4 through netherite). Two of 15
landings by the elevator were hit 2 and 4 blocks over the floor (a zombie, a phantom), pushed 0.8 to 1.0 off the
centre, and flew a go-around of 14 to 16 s. Everything else that day was 2.4 a trip at the most, on the walks.

Reproduced on a mob test server with the setting off (no armour, 10 flights a case, the landing a yard the elevator
comes down into): a creeper on the cell or 3 beside it: 19 of 20 flights touched down inside its
blast range, 9 were blown up and 5 died; a zombie on the cell: 8 of 10 hit in the elevator, 13 go-arounds, 28.8 s to
the touchdown against 11.8 with no mob.

What the flight can know: the world's entity tracker and the mob tracker run under a flight as on the ground. The
server sends the entities of the chunks it simulates: hostiles at a landing were first known 61.7 to 79.3 blocks
out. A creeper's lit fuse and a mob's target are known as on the ground.

The elytra flee (`fleeFly`) was `!fly home` typed for the owner after the flight on foot had failed. Tracks M1 and
M2 measured why it did not hold: it needed a home, it landed itself when the health was low (which is when it is
asked), the takeoff waited for a whole trip's planning, and the guard got no answer.

## Decisions

1. **The landing reads the hostiles from the trackers the bot already has** (`landmobs.ts landMobsNear`): hostile
   types only (never a player, a neutral or passive mob, an item), their feet, a creeper's fuse, the target. No new
   packet handling, nothing kept between looks but a creeper's last place.
2. **The search refuses a cell within 12 blocks of a creeper and prices the rest** (`cellPrice`, `LandingDeps.mobs`).
   12 is the blast range (7: beyond it a fuse goes out and an explosion does nothing) and the 5 blocks a creeper
   walks during the shortest elevator. A creeper within the 16 it follows costs 10 s (about the go-around it would
   cause), running out at 24; a melee mob on the cell 6 s, running out at 10 (the fight it starts); a shooter within
   8 4 s, running out at 16; the sum at most 20 s. A price in seconds because the search already ranks in seconds
   (0076): a cell without mobs a few blocks on wins when the walk it adds is shorter than the trouble. Priced cells
   are looked at later by as many seconds, so the probes go to the cells beyond a creeper's sight first. The goal's
   own cell gives way to the cells round it when it is refused or costs 5 s or more.
3. **The chosen cell is asked again every 10 ticks of the flight** (`tasks/process/fly.ts watchLanding`), and searched
   again when a creeper is within 12 of it, or (twice a flight at the most) when hostiles on it cost 5 s or more. A
   flight is planned before the mobs at its landing are known, and they move: the late look is the one that counts.
4. **In the approach and the elevator the brain keeps the touchdown out of a creeper's blast range**
   (`brain.ts mobLook`, `touchdownThreat`): a creeper within 7 of where the feet come down, now or by the touchdown at
   the pace it has closed over the last ticks, moves the landing to ground clear of every creeper known (an
   alternative of the search 20 from them, else the nearest safe ground 20, else 12 from them, within 40 blocks) and
   the body goes round to it on a rocket, twice a flight at the most. Within 1.5 of the floor it lands: a rocket from
   there is flown into the ground, and the guard has the creeper from the touchdown. A forced landing has no
   go-around: its ground is chosen 12 from every creeper and moved while the glide still reaches clear ground.
5. **Only a creeper moves a landing in the last seconds.** Other hostiles follow the body wherever it comes down and
   are the guard's on the ground; a go-around for each would cost more than they do.
6. **The reflex strikes under a flight while the body comes down onto its landing** (`controller.ts touchingDown`:
   within 8 over the landing and no faster than 0.35 a tick, and through the 10 ticks the flight holds the body
   after the touchdown), from 5.5 (eye to box; the server takes a hit to 6.2) and with the blade in the hand when one
   is in the hotbar. The server takes a strike in that state. Not in a flare's run in: a strike knocks the mob along
   the line from the body, which for a body flying in is its own path.
7. **With nothing hostile known near the landing nothing changes**: the search is not given the hook, the brain's
   look returns before it keeps anything, no strike is sent. Guarded by tests that fly the same trips with the look
   absent and with an empty list.
8. **One setting, `flyLandMobs`, default off**, until it has flown on the Realm (a go-around over a landing is new
   behaviour near terrain).
9. **The elytra flee is a flight mode with an entry point that answers** (`commands-fly.ts flee`, `fleeReady`,
   `cancelFlee`; `PveController.fleeFlight`): whether a takeoff was made, whether the body stands again, where, with
   what near it. A flee that made no takeoff answers at once and the other floors go on.
10. **The takeoff is a player's: jump, wings, a rocket**, along the first heading within 90 degrees of the way away
    from the hostiles whose simulated climb is clear, else straight up the open column, else any clear heading; from
    the ground and from rest (a body in a walk's jump or a knockback is waited for, a second at the most). It needs
    3 loose rockets and 8 blocks of open column over the body. Under a roof there is no flee.
11. **It flies to safe ground, not only home**: home when that lies 48 to 400 blocks away, on no hostile's side of the
    body (each more than 60 degrees off its bearing) and with nothing hostile known within 24 of it, else 96 blocks
    away from the hostiles. The ground is found from the air by the landing search
    with the look of decisions 2 to 6, whatever `flyLandMobs` says. So the takeoff waits for no search.
12. **It never lands for low health, places no block, and holds the body from the ask to the end of the flight** (a
    process over the flight on foot and under the flight in the air). A walk home that waits its turn is dropped
    when the flee is asked.
13. **With `fleeFly` on and a takeoff possible the flee comes before the flight on foot when there is no blade in the
    hotbar**, and against an archer or a witch in sight from 14 health down; with a blade from 6 health down, and as
    before once running has failed or the health is critical. Where it cannot go, the floors as they were.
14. **`fleeFly` stays off by default** until it has run on the Realm.

## Rejected

- **Holding a few blocks up until a creeper has left.** A glide cannot hover: the elevator sinks 0.149 a tick at the
  least. What holds height is a go-around, which is what decision 4 flies, to another landing.
- **Coming down beside a creeper and striking first.** A fist does not keep a creeper off (2 strikes from 3.9, lit,
  4.1 damage), a body within 3 blocks lights the fuse, and in the elevator the body cannot run from it.
- **A go-around back onto the same cell.** The creeper that was there follows the body within 16 blocks; the landing
  is moved outside that.
- **Handing the body back at the touchdown tick instead of 10 ticks later.** The 10 ticks are there because the
  server may still lift the body (a touchdown it did not see); the reflex needs no hand-back to strike.
- **A strike at every hostile in reach during the whole flight.** At speed it hits nothing and knocks mobs into the
  body's path; decision 6 keeps it to the seconds in which the body is nearly still.
- **The flee as `!fly home` with fixes.** It would still need a home, plan a whole trip before moving, and say
  nothing to the guard.
- **Taking off with fewer than 3 rockets, or gliding off a ledge without any.** Not tried; a flee that runs out of
  rockets over mobs is worse than the flight on foot.

## Consequences

- **Landings** (a mob test server, no armour, the brake and the elevator into a yard, 10 flights a case and side;
  the tables in [../flight.md](../flight.md)): a creeper on the cell or 3 beside it: 19 of 20 touchdowns inside its
  blast range, 9 flights blown up and 5 deaths without the look; with it 0 of 20 inside 24 blocks, no damage, 0.4 to
  0.7 s more (the landing moved 20 to 24 blocks by the trip's look, no go-around). A creeper that appears 4 blocks
  from the landing in the approach: 10 of 10 blown up without; with the look the brain went round to a moved landing
  every time, 0 of 10 inside the blast range, no damage, 19 s and a rocket or two more. A zombie on the cell: 8 of
  10 hit in the elevator and 13 go-arounds without (28.8 s to the touchdown); with the look none hit, no go-around,
  11.4 s. A skeleton 10 off and a phantom overhead: not changed. No mob: the same flights.
- **Offline** (the brain on the physics engine with scripted hostiles, 10 seeds a row, open ground and a yard): the
  same picture; without a mob every tick is the same.
- **The elytra flee** (the gauntlet's cells where a bare-handed bot died, an elytra and rockets in every kit, the
  flee off and on alternating): bare-handed 51 deaths in 90 runs without and 1 with (two zombies, an armed one, in a
  run where the flee was not asked); the live kit 0 in 10 either way. 88 flees asked (87 bare-handed, 1 in the live
  kit), none refused, none ended in a landing among mobs.
- **The cost**: the look reads the tracked entities once a tick of the approach: 64 microseconds with 200 entities
  on the test host under the live bot's CPU policy. A search with hostiles near probes cells where it used to take
  the goal at once (about 160 ms on the test server).
- **Nothing else changed**: the landing flight suites pass as on main with the setting off and on (the one known red
  with `flyWayDown` on); the mob suites pass.
- **Not covered**: a landing that is no cell (the end of a learned or drawn entry, a hop, a route landing flown by the
  route tracker) has no look in its last seconds; shooters move no landing; a flee needs open sky and 3 rockets, and
  under a roof the floors are what they were; neither setting has run on the Realm.
- **Open**: a glide off a ledge as a flee without rockets; the brain's look for the other landing kinds; the flee's
  takeoff from water (it refuses).
