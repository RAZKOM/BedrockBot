# Documentation

Every guide, one line each, grouped by what you want to do. New here: start with
[getting-started.md](getting-started.md). The design decisions (ADRs) are listed at the end; that list is made
from the files by `node scripts/docs-index.mjs --write`, and a unit test fails when a guide or a decision is
missing from this page.

## Getting started

- [getting-started.md](getting-started.md): from a fresh clone to the first commands; which servers work; what to do when a step fails
- [commands.md](commands.md): every chat command with what it does
- [ux.md](ux.md): the help, the front-door commands, modes, the welcome and hints
- [runbook.md](runbook.md): every flag, the test servers, the Realm join, operations, the tests
- [versions.md](versions.md): game versions, protocols and transports the bot speaks, and what a mismatch looks like

## Playing

- [early-game.md](early-game.md): a fresh survival world from an empty inventory: the first day, the iron age, nights and mornings
- [get.md](get.md): `!get`, the one front door for work, and the stash step when the inventory fills
- [wood.md](wood.md): finding and felling trees, collecting drops, chests
- [mining.md](mining.md): `!mine`, branch mining, quarries and tunnels
- [farming.md](farming.md): `!farm`: harvest, replant, bone meal
- [food.md](food.md): hunting, cooking and the food chore
- [crafting.md](crafting.md): `!craft`, `!compact` and compaction when a chest is full
- [build.md](build.md): `!build`: boxes, walls, floors, pillars and structure files from the bot's own blocks
- [home.md](home.md): the chests around home, `!unload`, `!bring`, spare shulker boxes
- [inventory.md](inventory.md): how the bot keeps room in its inventory
- [waypoints.md](waypoints.md): waypoints, `!goto <waypoint>` and `!top`
- [explore.md](explore.md): `!explore`, walking the land it has not seen
- [pve.md](pve.md): fighting mobs, guard, follow; never players
- [survival.md](survival.md): eating, armour, tool wear, mending, keeping away from mobs and spawners
- [flight.md](flight.md): elytra flight, rockets, landings and the flight kit
- [nether.md](nether.md): portals, the Nether and the End
- [natural-language.md](natural-language.md): `!do` in plain words through a local model

## The panel and away mode

- [panel.md](panel.md): the LAN control panel: views, the token, the API, the budgets
- [map.md](map.md): the panel's map screen
- [storage.md](storage.md): the panel's storage view: what you have and where
- [queue.md](queue.md): the job queue and the standing goals
- [away.md](away.md): away mode: the timeline, notifications, questions the bot asks you, the Discord webhook
- [events.md](events.md): the event history the timeline and the panel read

## Discord

- [discord.md](discord.md): command the bot and answer its questions from Discord with your own Discord bot
- [away.md](away.md) "Discord": notes to your own Discord webhook

## Inside

- [movement.md](movement.md): the input loop and the bot's Bedrock physics
- [pathfinding.md](pathfinding.md): the planner, goals, path following and the moves it knows
- [coarse.md](coarse.md): the long-range coarse layer every mover shares
- [digging.md](digging.md): break times, tool choice and `dig()`
- [interaction.md](interaction.md): placing blocks; doors, gates, trapdoors, buttons and levers
- [processes.md](processes.md): the process manager and the runtime settings
- [world-model.md](world-model.md): chunks, blocks, entities and inventory from the packets
- [world-cache.md](world-cache.md): the persistent world cache and the debug map
- [flight-envelope.md](flight-envelope.md): what the server allows for the elytra, measured
- [rl.md](rl.md): the reinforcement-learning bridge and environment (frozen)

## Contributing

- [chat-style.md](chat-style.md): read before printing more than one line, adding a colour, a command or a setting
- [testing.md](testing.md): the default unit run, the perf project (`pnpm test:perf`), what CI runs, and the rules that keep the unit run green under load
- [benchmarks.md](benchmarks.md): the common jobs benchmarked on generated ground (one e2e suite, one row a run), the before / after table, how to measure a change
- [../PLAN.md](../PLAN.md): the plan, the verified facts, the phases and the risks
- [../tools/bump-version/playbook.md](../tools/bump-version/playbook.md): moving to a new game version
- [../tools/bump-version/README.md](../tools/bump-version/README.md): the version-bump tooling
- [../packs/truth/README.md](../packs/truth/README.md): the behaviour pack the tests use for ground truth
- [../deploy/README.md](../deploy/README.md): running the bot as a service on a server machine
- [../rl/README.md](../rl/README.md): the Python environment
- [../spikes/README.md](../spikes/README.md): throwaway feasibility experiments
- [../THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md): third-party material and its licences

### Repository layout

```
package.json        pnpm workspace root: bds:*, bot:afk, bot:realm, bot:check, config:init, update:check, test, test:perf, lint
bot/src/index.ts    the command line: --task afk|echo|gather|rl, --target bds|realm (runbook "Bot")
bot/src/config/     the config file, settings, config:init, the command line's flags (cli-options.ts, shared with bot:check)
bot/src/doctor/     pnpm bot:check, the first-run check
bot/src/connection/ the client, the version gate, reconnects, the Realm options, the health endpoint
bot/src/chat/       chat parsing, the owners, the commands
bot/src/world/      blocks, chunks, entities, inventory, the world cache
bot/src/skills/     physics, pathfinding, digging, placing, combat, survival, flight, farming, mining
bot/src/tasks/      the AFK task, its processes and chores, the queue
bot/src/health/     the panel, the debug map, notes and Discord
bot/src/events/     the event history
bot/src/nl/         !do: plain words to a checked plan of commands
bot/test/unit/      the unit suite (vitest project "unit"; pnpm test, also in CI)
bot/test/perf/      wall-clock bounds (vitest project "perf"; pnpm test:perf, an idle machine only)
bot/test/e2e/       against the local servers in Docker (BDS_E2E=1)
docker/             one compose file per test server; data/ is git-ignored
scripts/            bds.mjs (the test servers), docs-index.mjs, deploy and test helpers
packs/truth/        the test behaviour pack
patches/            pnpm patches for minecraft-data, bedrock-protocol and nethernet
fixtures/           recorded packet captures per game version
tools/              the version-bump playbook, the physics spike
deploy/             service units for a server machine
.github/workflows/  CI: lint, the unit tests, the docs index, the doctor without a config (testing.md "CI")
rl/                 the Python Gymnasium environment
```

## Media

Screenshots of the panel in a test world (headless browser; the item cells show the panel's drawn glyphs):
[map](media/panel-map.webp), [inventory and status](media/panel-cards.webp), [storage](media/panel-storage.webp),
[jobs](media/panel-jobs.webp), [away](media/panel-away.webp); on a phone: [map](media/phone-map.webp),
[inventory](media/phone-cards.webp), [jobs](media/phone-jobs.webp), [away](media/phone-away.webp); the map while
the bot works a field: [map-farm.webp](media/map-farm.webp).

## Decisions

One line each, by number; the file holds the context, the decision and its consequences.

<!-- decisions:start (made by scripts/docs-index.mjs --write) -->
- [0003](decisions/0003-physics.md): Physics engine for player movement
- [0004](decisions/0004-protocol-pin.md): bedrock-protocol pin for the Realm join
- [0005](decisions/0005-pathfinding.md): Pathfinding, path following and the Bedrock rules they depend on
- [0006](decisions/0006-wood-skills.md): Wood skills: serialisation by pre-emption, re-path instead of pillar-up, predicted stack moves
- [0007](decisions/0007-config.md): config file outside the repository
- [0008](decisions/0008-rl-bridge.md): RL reset and bridge
- [0009](decisions/0009-navigation-v2.md): Navigation v2 (tick costs, surface preference, segments, world-changing moves)
- [0010](decisions/0010-placing-and-using-blocks.md): Placing and using blocks: one click packet, server-verified results, predicted pillars
- [0011](decisions/0011-pve-and-follow.md): PvE and follow: melee only, players refused at the lowest layer, guard as an interrupting episode
- [0012](decisions/0012-process-manager-and-settings.md): one process manager with fixed priorities; runtime settings read live and persisted next to the config
- [0013](decisions/0013-goals-blacklist-waypoints.md): Goal types, a failure blacklist and per-server waypoints
- [0014](decisions/0014-survival-kit.md): Survival kit: server-completed eating, armour and drops through item stack requests, avoidance as cost
- [0015](decisions/0015-world-cache.md): Persistent world cache: 2-bit cells per chunk in region files, stand-ins for the planner, corrections as block updates
- [0016](decisions/0016-farming-and-mining.md): Farming and legit mining: skills on the existing stack, an exposure rule instead of x-ray
- [0017](decisions/0017-combat-that-keeps-the-bot-alive.md): Combat that keeps the bot alive: reachable targets, creepers first, hit and run, weapon pull
- [0018](decisions/0018-survival-policy.md): Survival policy: flee v2, trip readiness, sleeping
- [0019](decisions/0019-food-gathering.md): Food gathering: hunt passive mobs as a process, cook over item stack requests, an automatic chore below user commands
- [0020](decisions/0020-natural-language-front-end.md): Natural-language front end: a local model picks commands, the chat runs them
- [0021](decisions/0021-farm-mine-processes-ore-memory-forests.md): Farming and mining as processes, persisted ore memory, remembered forests, plantings that do not race pickups
- [0022](decisions/0022-stairs-and-partial-blocks.md): Stairs and partial blocks
- [0023](decisions/0023-planner-worker.md): The planner in a worker thread
- [0024](decisions/0024-block-registry-from-bds-palette.md): Block registry from a BDS palette dump
- [0025](decisions/0025-get-front-door-and-stash.md): `!get` as the one front door, and a stash step when the inventory fills
- [0026](decisions/0026-lan-control-panel.md): LAN control panel
- [0027](decisions/0027-food-v2-herds-pens-breeding.md): Food v2: herd marks beside the world cache, pens by flood fill, breeding over the mob click
- [0028](decisions/0028-home-logistics.md): Home logistics: chest memory, a decision table for unloading, spare shulker boxes
- [0029](decisions/0029-combat-v3-retargeting-crowd-shield.md): Combat v3: re-targeting within reach, the crowd rule, a shield in the offhand
- [0030](decisions/0030-explore-and-branch-mining.md): Exploring by information gain, and branch mining as the miner's fallback
- [0031](decisions/0031-wave-9-small-fixes.md): Wave 9 small fixes (Track AK)
- [0032](decisions/0032-movement-variety.md): Movement variety: swimming, ladders and vines, parkour gaps, edge sneaking
- [0033](decisions/0033-builder.md): The builder: planned steps on a simulated world, scaffolds, a user process
- [0034](decisions/0034-ux-tiers-help-modes.md): Command tiers, short and deep help, modes, welcome, hints (Track AM)
- [0035](decisions/0035-home-walking-distance.md): Home containers by walking distance, an unreachable memory, a read cap per scan
- [0036](decisions/0036-guard-path-reachable-targets.md): Guard fights only path-reachable mobs, holds back during walks, gives up fast
- [0037](decisions/0037-panel-inventory-and-statuses.md): Control panel: graphical inventory, status blocks, responsive layout
- [0038](decisions/0038-mining-v3-tunnels-veins-batches.md): Mining v3: direct tunnels and shafts, veins as groups, produce on the floor, several kinds in one trip
- [0039](decisions/0039-panel-interactions.md): Control panel: interactive (context menus, map actions, settings, palette)
- [0040](decisions/0040-bring.md): `!bring`: stored items to the owner, `!get` stays the maker
- [0041](decisions/0041-dimensions-portals-nether-safety.md): Dimension changes, portal travel and Nether safety
- [0042](decisions/0042-elytra-flight.md): Elytra flight: a model-predictive landing on a vanilla glide model
- [0043](decisions/0043-baritone-port.md): Port Baritone's planner rules under LGPL-3.0 (wave 11, Tracks BA, BB, BC, BE, BD)
- [0044](decisions/0044-boxing.md): Boxing at the chests, the owner's `bot_loot` boxes, packing priority (wave 11, Track AV)
- [0045](decisions/0045-crafting-and-compaction.md): Crafting through the normal screens, and compaction as its first use
- [0046](decisions/0046-item-icons.md): Control panel: real Minecraft item icons, read from an npm package
- [0047](decisions/0047-flight-landing-v3.md): Flight landing v3: land only where a walk is confirmed, never in water, under overhangs
- [0048](decisions/0048-trapdoor-moves.md): Trapdoors as vertical passages (hatches over ladder shafts)
- [0049](decisions/0049-long-falls-and-clutch.md): Long falls within a health budget, and the water bucket clutch
- [0050](decisions/0050-chat-style.md): Chat colour, framed multi-line blocks and optional /me, /say, /tellraw routes
- [0051](decisions/0051-temporary-scaffold.md): Temporary scaffold: pillar-up felling and pickups that may dig and place
- [0052](decisions/0052-shulker-aware-jobs.md): Shulker-aware jobs: one supply layer, bring extract, build refill, crop reserve (wave 12, Track BJ)
- [0053](decisions/0053-quarry-and-tunnel.md): `!quarry` and `!tunnel` on the builder's clear
- [0054](decisions/0054-glide-down-and-ledge-takeoff.md): Glide down when the walk has no way on; take off by stepping off a ledge
- [0055](decisions/0055-terrain-safe-cruise.md): Terrain-safe cruise, dive descent, takeoff sites and the walk re-check
- [0056](decisions/0056-flight-envelope.md): The flight envelope measured, and the model fixed to it
- [0057](decisions/0057-flight-manoeuvres.md): The manoeuvre library and the brake / elevator landing
- [0058](decisions/0058-flight-planner.md): The kinodynamic flight planner (routes through the voxel grid)
- [0059](decisions/0059-event-store.md): Event history: a typed registry, one bus, JSONL per day
- [0060](decisions/0060-surface-layer.md): World cache: a surface layer per column, block colours from the game art, a 2D map painted like the game's
- [0061](decisions/0061-panel-push-and-modules.md): Panel push channel (SSE with deltas), browser modules by type stripping, per-piece budgets
- [0062](decisions/0062-map-screen.md): The map-first panel screen: one painting module, map tiles on the push channel, actions as visible commands
- [0064](decisions/0064-route-landings-and-takeoffs.md): Route landings and takeoffs (the planner in the flight)
- [0065](decisions/0065-storage-database.md): Storage as a database: one pure index over what the bot knows, a ranked search, a pushed summary, actions as visible commands
- [0066](decisions/0066-coarse-layer.md): The coarse layer (long-range planning over the world cache)
- [0067](decisions/0067-long-range-flight.md): Long-range flight (flight v2, Track F4)
- [0068](decisions/0068-real-cave-benchmark.md): The real-cave benchmark and no flight from water (flight v2, Track F5a)
- [0069](decisions/0069-cave-flight.md): Cave flight (flight v2, Track F5b)
- [0070](decisions/0070-water-travel.md): Water travel (planning under water, within the air)
- [0071](decisions/0071-tight-cave-flight.md): Tight cave flight (flight v2, Track F6)
- [0072](decisions/0072-reachability.md): Reachability (`!goto` says unreachable only when it is, and why)
- [0073](decisions/0073-tight-passages.md): Tracking in tight passages (flight v2, Track F7)
- [0074](decisions/0074-cave-entry.md): Cave entry from above (flight v2, Track F8)
- [0075](decisions/0075-test-harness.md): The server as a test bench (op detection, commands from the bot, recovery, repeated runs)
- [0076](decisions/0076-land-by-time.md): Land by time, not by precision (flight v2, Track L1)
- [0077](decisions/0077-cave-exit.md): Taking off from inside a cave: first out, then to the goal, as one proven plan (flight v2, Track F9a)
- [0078](decisions/0078-learned-exits.md): A recorded flight as the way out of a cave (flight v2, Track F9b; learned paths as guides, part 1)
- [0079](decisions/0079-never-die-to-mobs.md): Never die to common mobs (Track M1)
- [0080](decisions/0080-learned-entries.md): A recorded flight as the way into a cave (flight v2, Track F9c; learned paths as guides, part 2)
- [0081](decisions/0081-drawn-lines.md): A line drawn from the flood as the way out of a cave (flight v2, Track F9d)
- [0082](decisions/0082-drawn-entries-and-hops.md): Longer drawn lines, a drawn way in, and flights under one roof (flight v2, Track F9e)
- [0083](decisions/0083-open-air-kit-burn.md): The open-air flight plans with the burn of the rockets at hand (flight v2, Track F10)
- [0084](decisions/0084-landing-over-what-stands-round-it.md): A flight comes down on the landing it chose (flight v2, Track F11)
- [0085](decisions/0085-way-down-to-the-landing.md): A landing lies under the sky and has a way down to it (flight v2, Track F14)
- [0086](decisions/0086-landing-looks-at-mobs.md): A landing looks at hostile mobs, and the elytra flee is a flight (Track M3)
- [0087](decisions/0087-takeoff-from-a-floor-the-walk-reaches.md): A takeoff from a floor the walk reaches (Track F15)
- [0088](decisions/0088-a-walk-keeps-to-its-way.md): A walk keeps to its way (Track W2 way)
- [0089](decisions/0089-worker-threads-without-wasm-code-gc.md): Worker threads without V8's wasm code GC (Track I1)
- [0090](decisions/0090-room-in-the-inventory.md): Room in the inventory (Track V1)
- [0091](decisions/0091-windows-beside-the-walk.md): Windows beside the walk (Track F17)
- [0092](decisions/0092-packets-the-bot-cannot-read.md): Packets the bot cannot read (Track P1)
- [0093](decisions/0093-protocol-bumps-keep-the-block-data.md): Protocol bumps keep the block data (Track U1)
- [0094](decisions/0094-one-block-data-key.md): One block data key, minecraft-data 3.119.0 (Track U2)
- [0095](decisions/0095-one-build-two-protocols.md): One build, two protocols (Track U2)
- [0096](decisions/0096-milk-on-hand.md): Milk on hand (Track K1)
- [0097](decisions/0097-rockets-on-hand.md): Rockets on hand (Track R9)
- [0098](decisions/0098-day-one-from-nothing.md): Day one from nothing (Track E1)
- [0099](decisions/0099-iron-age.md): The iron age from the stone kit (Track E2)
- [0100](decisions/0100-shaft-furnace-bed.md): A mob in the shaft, the furnace wait, a bed (Track E3)
- [0101](decisions/0101-wear-and-setbacks.md): The obtain job through wear and setbacks (Track E4)
- [0102](decisions/0102-starter-farm.md): A starter farm, the farm chore and bread (Track E6)
- [0103](decisions/0103-early-chain-other-ground.md): The early chain on other ground (Track E5)
- [0104](decisions/0104-dusk-shell-blocks-creeper-end-line.md): A job at dusk, the shell's blocks, a creeper in reach, the end line (Track E7)
- [0105](decisions/0105-starter-farm-water-seeds.md): Water and seeds for the starter farm (Track E8)
- [0107](decisions/0107-a-flight-never-outlasts-its-elytra.md): A flight never outlasts its elytra (Track F20)
- [0108](decisions/0108-an-elytra-on-hand.md): An elytra on hand (Track K4)
- [0110](decisions/0110-mending.md): Mending what the bot uses (Track K5)
- [0111](decisions/0111-way-home-and-morning.md): The way home from the mine, and the morning after a night (Track E9)
- [0112](decisions/0112-early-leftovers.md): The night shell's open sides, the cook's fuel, sheep for the bed, a step lost to flights (Track E10)
- [0115](decisions/0115-job-queue-and-standing-goals.md): The job queue and the standing goals (Track P4, panel programme step 4)
- [0116](decisions/0116-away-mode.md): Away mode: the timeline, notifications, asking the owner (Track P5, panel programme step 5)
- [0117](decisions/0117-early-leftovers-round-two.md): A gather after a stopped pause, the cooker's timeout, the walk out in the morning (Track E11)
- [0118](decisions/0118-discord-bot.md): A Discord bot: commands from Discord, replies, notes and question buttons (Track D1)
- [0119](decisions/0119-mine-dangers.md): The mine's dangers: a lone archer and a witch fought for the work, a creeper under the feet (Track E12)
- [0120](decisions/0120-two-archers-at-the-work.md): Two archers at the work: wall in until they are gone; one archer list (Track E13)
- [0121](decisions/0121-renewing-an-elytra-at-an-anvil.md): Renewing an elytra at an anvil: membranes first, the cost checked before paying (Track K7)
- [0122](decisions/0122-tests-without-the-wall-clock.md): The unit run without the wall clock: a work clock for the planners, a perf project, CI (Track REL3)
- [0124](decisions/0124-block-states.md): Block states: the builder places every block as the build says (Track B1)
- [0125](decisions/0125-java-files-and-bill.md): Java structure files, a bill of materials, and a fetch that crafts and smelts (Track B2)
- [0126](decisions/0126-fire-escape-and-held-witch.md): A fire escape that reaches its cell, a witch held for the work, a body dug out of a block (Track M11)
- [0127](decisions/0127-benchmark-fixes.md): A benchmark of the common jobs, and what it fixed: near walks bounded, a blocked staircase goes round (Track EF1)
- [0128](decisions/0128-builder-at-full-size.md): The builder at full size: sections, tall builds, resume, speed (Track B3)
- [0129](decisions/0129-builds-from-shulker-boxes.md): Large builds fed from shulker boxes (Track B4)
- [0130](decisions/0130-build-replies-that-fit.md): Build replies that fit the chat (Track B5)
- [0132](decisions/0132-map-art-builds.md): Map art builds (Track B7)
<!-- decisions:end -->
