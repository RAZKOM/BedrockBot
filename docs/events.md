# Event history (`bot/src/events`)

Web panel programme, step 1 (foundation), Track PB. Decision record:
[decisions/0059-event-store.md](decisions/0059-event-store.md). Read this before you add an event or
emit one.

The bot records what it does as typed events: connections and kicks, deaths, fights and kills,
flights from danger, jobs (started, finished, failed with the reason, stopped and by whom), items
gained and lost, chests filled and emptied, the home return, low resources and the owner's commands.
They survive restarts (JSONL files next to the world cache), the panel serves them
(`GET /api/events`, `GET /api/events/summary`), and `events.subscribe()` gives them live. Step 5
(away mode: the timeline, notifications, "ask the owner") is built on this stream; this step has no
UI.

## Where the files are

| What | Where |
|---|---|
| the files | `<config dir>/events/<server id>/YYYY-MM-DD.jsonl` (UTC days), next to `<config dir>/cache/<server id>/`; default `%LOCALAPPDATA%\bedrockbot\events\` or `~/.bedrockbot/events/` |
| another root | env `BEDROCKBOT_EVENTS_DIR` (the e2e uses a temporary directory) |
| memory only | env `BEDROCKBOT_EVENTS=0`, or `--no-config` without `BEDROCKBOT_EVENTS_DIR` (tests, like the runtime settings) |
| retention | `!set eventsDays 14` (1..365) and `!set eventsMaxMb 64` (1..4096), group `system` |

On start the log says `events: <dir> (continuing after id 1234)` or
`events: in memory only (...)`. The server id is the world cache's (`serverIdFor`), so a Realm and a
local BDS never share a history.

## Kinds

Generated from the registry (`bot/src/events/registry.ts` `eventTable()`); a unit test fails when
this table and the registry differ and prints the new table. `?` = optional field.

<!-- events:kinds -->
| kind | severity | fields | when |
|---|---|---|---|
| `connection.connected` | info | `server` `version` | first spawn of this run |
| `connection.reconnected` | notable | `server` `offlineS` | spawned again after a lost connection |
| `connection.disconnected` | notable | `reason` `kind` `sessionS` `retryInS?` | the session ended and a reconnect is scheduled (kicks have their own kind) |
| `connection.kicked` | alert | `reason` `message?` `willReconnect` | the server sent a disconnect packet |
| `connection.lost` | alert | `reason` `kind` | the session ended for good: a version mismatch, retries used up, reconnect off (the bot leaving on purpose is not recorded) |
| `life.died` | alert | `n` `cause` `messages?` `at?` | the bot died (cause from death_info when the server sent one) |
| `life.respawned` | info | `at` | back alive after a death |
| `combat.fight` | info | `mob` `outcome` `ticks` `attacks` `landed` `damageTaken` `kills` | one fight ended: the damage summary (attacks, hits landed, damage taken, kills) |
| `combat.kill` | info | `mob` | a mob the bot fought died |
| `combat.flee` | notable | `why` `from` `health` | a flight started (low health, a creeper, recovering) |
| `combat.damage` | info | `hits` `damage` `by` `periodS` | damage taken, batched: one event per minute with hits (and before a death) |
| `job.started` | info | `job` `kind` `line` `by?` | a process that ends (a command, a chore episode, the home return) was added |
| `job.finished` | info | `job` `result` `durationS` | a job ended by itself with a good result |
| `job.failed` | notable | `job` `reason` `durationS` | a job ended by itself without its goal, with the reason |
| `job.stopped` | info | `job` `reason` `durationS` `by?` | a job was stopped before it ended (!stop, replaced, a death), and by whom when a command did it |
| `items.changed` | info | `gained` `lost` `jobs` `periodS` | what the inventory gained and lost outside chests, batched: at the end of each job and once a minute |
| `container.deposit` | info | `at` `block?` `items` | items put into a chest, barrel or shulker box (one event per open) |
| `container.withdraw` | info | `at` `block?` `items` | items taken out of a chest, barrel or shulker box (one event per open) |
| `home.arrived` | info | `durationS` | the home return (after a fight, at dawn, after a respawn) arrived |
| `resource.low` | notable | `resource` `left` `detail` | carried food, a tool class or rockets (with an elytra) ran low; once until it recovers |
| `command.received` | info | `command` `text` `source` `sender` | an owner command ran (from the game chat, the server console or the panel) |
<!-- /events:kinds -->

## Severity rules

The severity belongs to the kind (fixed in the registry, copied into every stored line), never to a
single emit:

- **alert**: the owner should look now, also when away: the bot died, was kicked, lost the connection
  for good. Step 5 notifications start here. Keep this list short.
- **notable**: worth a line in the away timeline even when nothing is wrong yet: a job failed, a
  flight from danger, a reconnect, a resource ran low.
- **info**: routine: jobs starting and finishing, fights, kills, items, chests, commands.

When one situation needs two severities, it is two kinds (`connection.disconnected` notable with a
reconnect scheduled, `connection.lost` alert without).

## Emitting

One line at the seam, nothing else moves:

```ts
import { events } from '../../events/bus.ts';
events.emit('combat.kill', { mob: bareType(f.tg.type) }); // decision 0059
```

- The kind must be registered and the payload must fit: both are compile errors otherwise (the
  payload type is inferred from the zod schema).
- `emit` never throws and never waits: the event gets the next id, goes into the ring (2000 events),
  to the subscribers and into the store's write queue. A payload that does not fit its schema at run
  time (an `as` cast, a `NaN`) is kept and logged once per kind; the unit tests run the bus strict.
- Prefer a listener on an existing observer API over an emit line (see "Seams"): `wire.ts` holds
  those. Never emit from a per-tick path without an edge (state changed) or a batch.
- More than 120 of one kind in a minute is a bug at the site: the rest of that minute is dropped and
  counted (`events.stats.dropped`), with one warning.
- Payload strings are capped at 400 characters by the schemas; clip long reasons (`wire.ts` clips at
  200). Positions are block or 0.1-block precision. No tokens, no secrets: the files are plain text
  on the owner's machine.

## Adding a kind

1. An entry in `EVENT_KINDS` (`registry.ts`): `category` = the part before the dot (one of
   `CATEGORIES`; add a category only for a new area), a `severity` by the rules above, a one-line
   `doc`, a zod `schema` (an object; optional fields with `.optional()`), a `format` that makes one
   readable line.
2. A sample payload in `test/unit/events/registry.test.ts` `SAMPLES` (the test does not compile
   without one).
3. Run the unit tests: the guide test fails and prints the new table; paste it between the
   `events:kinds` markers above.
4. One emit line at the seam (or a listener in `wire.ts`). The guard test fails for a registered kind
   that nothing emits.
5. Never rename or remove a kind that shipped: old lines keep their name (`formatEvent` shows the bare
   name for a kind it no longer knows). Add a new kind instead.

## Batching

Anything that happens per stack, per hit or per tick is batched; the rule is one event per job or per
minute, never per item:

- `items.changed`: the inventory model (slots 0..35, the offhand, the armour) is diffed after every
  change (one microtask later); deltas collect into gained / lost per item name and are written at
  the end of every job (any `job.finished` / `failed` / `stopped`) and once a minute when something
  changed. `jobs` names the jobs that ran in the period. After a spawn, the first 3 s of inventory
  packets only set the baseline (a reconnect is not "gained everything"). A death without
  keepInventory shows as `lost`. Shulker box contents count as the box.
- `container.deposit` / `container.withdraw`: while a storage window (window type `container`:
  chest, trapped chest, barrel, shulker box, ender chest) is open, the deltas belong to it; one
  deposit and one withdraw (when non-empty) at `container_close`, with the position and the block
  name. Crafting tables and furnaces are not storage: what they consume or make is in `items.changed`.
- `combat.damage`: every own health drop (`MobTracker.onHit`) adds to hits / damage / `by` (the
  guessed attacker's type, else the cause, else `unknown`); written once a minute with hits, and
  before a `life.died`.
- `resource.low`: edge-triggered (once per crossing, again only after it recovered), checked a second
  after inventory changes.

## Seams

Where each kind comes from. Listeners in `wire.ts` (wired once in `index.ts`):

| Seam | Kinds |
|---|---|
| `Connection.onSpawn` / `onClose` | `connection.*`: first spawn = connected, later spawns = reconnected (with the offline time); a close with `kind: 'kick'` = kicked; no reconnect = lost; a reconnect scheduled after a spawned session = disconnected; failed attempts while offline and the bot's own close (`!quit`, a signal, `--duration`) are not recorded |
| `Chat.onLine` + `Chat.onCommand` (`run`) | `command.received` (source `panel` inside `viaPanel`, `console` for the server console, else `chat`) |
| `RespawnController.onEvent` | `life.died` one second after the death (the server may send `death_info` with the cause just after; a respawn records it at once), `life.respawned` |
| `MobTracker.onHit` | `combat.damage` |
| `container_open` / `container_close` packets + `Inventory.onChange` | `container.*`, `items.changed` (`items.ts`) |
| `Inventory.onChange` | `resource.low` (`resources.ts`) |

One-line emits at the site:

| Site | Kinds |
|---|---|
| `skills/combat/combat.ts` `finish()` / `endTarget()` | `combat.fight` (every fight: guard, `!kill`, hunting), `combat.kill` |
| `tasks/pve.ts` FleeProcess start | `combat.flee` |
| `tasks/process/manager.ts` `add` / `finished` / `remove` -> `events/jobs.ts` | `job.*`, `home.arrived` |
| `health/panel/index.ts` `run()` | wraps `chat.handle` in `viaPanel` (source `panel`) |

### Jobs

A job is any process that ends: the owner's commands, a chore's episode (unload, tidy, food),
the home return, a flight (`!fly`: the process level; nothing in `skills/fly` emits). The persistent
auto processes (flee, guard, night, surface, fire, the chore watchers) are registered once and never
end; they are not jobs. The outcome comes from the process's `result` promise (`jobs.ts`
`outcomeOf`):

| result | event |
|---|---|
| `{ok: true, reason?}` | `job.finished`, result = reason or `ok`, plus up to 4 numbers (`killed 3, want 3`) |
| `{ok: false, reason}` | `job.failed` (reason `interrupted` / `stopped` / `replaced` / `cancelled`: `job.stopped`) |
| a state string | `done`, `finished`, `complete`, `arrived`, `ok`, `full` -> finished; `stopped`, `interrupted`, ... -> stopped; anything else (`failed`, `none_left`, `no_pickaxe`, `low_health`) -> failed with it as the reason |
| `{state, reason}` (a build) | as the state, the reason appended |
| no result promise | `job.finished` `done` when the manager drops it |

A process removed by the manager (`!stop`, replaced by a newer command of the same name, dropped at a
death, the bot exiting) is `job.stopped` with the manager's reason (`stopped`, `replaced`, `death`,
`dropped`, `dispose`). A home return that finishes also records `home.arrived`.

### Who did it

An owner command runs synchronously inside `Chat.handle`; the command listener sets the actor
(`actor.ts`) before the handler runs and a microtask clears it. A job started or stopped while it is
set records `by` (`!kill zombie` from the panel: `job.started ... by: console`; `!stop` in chat:
`job.stopped ... by: Steve`). Work a command starts later (after an asynchronous plan) has no `by`;
the `command.received` just before it says who asked.

## Query API

Behind the panel's token like `/api/state` (docs/panel.md "Auth"); mounted on the panel server.

| Request | Answer |
|---|---|
| `GET /api/events?since=&until=&kinds=&min=&limit=` | `{"events":[{"id":12,"ts":1762300000000,"kind":"job.failed","sev":"notable","data":{...},"text":"mine failed: no_pickaxe (3 min 5 s)"}],"more":false,"next":12}` |
| `GET /api/events/summary?hours=8` | counts per kind and severity, items gained / lost / net per item, chest deposits / withdrawals, combat totals, every job with its result, deaths, the notable and alert lines (at most 50) |
| `GET /api/events/kinds` | the registry: kind, category, severity, doc, fields |

- `since`: an id (exclusive) or wall-clock ms (`ts >= since`); values from 1e12 on are ms. Page
  forward with `since=<next>`.
- `until`: the same split, inclusive.
- `kinds`: comma list of kinds or categories (`kinds=job,combat.kill`); an unknown one is a 400.
- `min`: `info`, `notable` or `alert`.
- `limit`: 1..5000, default 200. With `since`, the oldest `limit` after it; without, the newest
  `limit`. Always returned oldest first; `more: true` when the limit cut something off.
- `hours` (summary): > 0, at most 744; default 8. The summary reads at most 5000 events
  (`truncated: true` beyond).
- `skipped`: lines that could not be parsed while answering (a crash can cut the last line).

Examples (token as a bearer header or the panel cookie):

```sh
curl -H "authorization: Bearer $TOKEN" "http://127.0.0.1:9466/api/events?min=notable&limit=50"
curl -H "authorization: Bearer $TOKEN" "http://127.0.0.1:9466/api/events?since=$(( $(date +%s) * 1000 - 8*3600*1000 ))&kinds=job"
curl -H "authorization: Bearer $TOKEN" "http://127.0.0.1:9466/api/events/summary?hours=8"
```

Answers come from the ring when it covers the window (it holds every event after its oldest one),
else from the files plus the events not written yet.

## Live subscription

```ts
import { events, formatEvent } from '../../events/index.ts';
const off = events.subscribe((e) => send({ ...e, text: formatEvent(e) })); // every new event, in order
```

The listener runs synchronously inside `emit` (keep it cheap; a throw is caught and logged once).
The panel's push channel (decision 0061, docs/panel.md "Add a topic") is wired this way:
`health/panel/index.ts` registers the `events` topic on its StreamHub and subscribes to the bus, so
every new event goes to every page that streams the topic, with its display text:

```ts
const eventsTopic = hub.topic(EVENTS_TOPIC, { kind: 'event', budget: PANEL_BUDGETS.event });
unsubs.push(events.subscribe((e) => eventsTopic.publish({ ...e, text: formatEvent(e) })));
```

A page joins it with `page.listen('events', fn)` (`GET /api/stream?topics=state,events`). A page that
connects late asks `GET /api/events?since=<last id it has>` once and then follows the topic; ids
increase across restarts, so a gap shows.

## Storage

- One line per event: `{"id":12,"ts":1762300000000,"kind":"job.failed","sev":"notable","data":{...}}`.
  The display text is not stored (formatters can improve; old lines read with the new ones).
- Writes are asynchronous and batched: every second, or at once from 256 waiting. `emit` never waits
  for the disk. On exit the batches (items, damage, a pending death) are written first, then the
  store flushes (`index.ts` `finish`). A hard kill loses at most the last second.
- Ids: on open the newest file's last good line gives the id to continue from (only the last 256 KB
  are read).
- Retention: at the start, hourly and when the UTC day changes. Files older than `eventsDays` go,
  then the oldest until the total is under `eventsMaxMb`; today's file is never deleted.
- A disk error (cannot create the directory, a failed append) switches the store to memory only for
  the rest of the run with one logged error (`events: writing ... failed (...); keeping events in
  memory only from now on`); the ring and the API keep working.
- A corrupt line (a cut-off write, a hand edit) is skipped and counted (`skipped`), never fatal.

Size: a busy hour (mining, two fights, a few chests, a dozen commands) is about 100 events of
200 to 400 bytes, so a day is well under 1 MB; the 64 MB default holds weeks.

## Reviewer checklist

- [ ] New kind: registry entry (category = prefix, severity by the rules, doc, schema, format), a
      sample in `SAMPLES`, the table regenerated here, an emitter (the guard test checks all four).
- [ ] Emit is one line at a seam (or a listener in `wire.ts`); no logic moved into or out of the
      event module; no emit per tick, per stack or per hit (batch or edge).
- [ ] Severity: alert only for "look now"; a failure is notable; routine is info.
- [ ] Payload: no tokens or secrets, strings clipped, numbers finite, positions rounded.
- [ ] No `as` cast around `events.emit` (the types are the guard that the kind exists).
- [ ] Nothing in `skills/fly/*` emits (flight is recorded at the process level).
- [ ] A new setting for this module is in `SETTING_GROUPS` (`chat/help.ts`).

## Tests

- Unit (`bot/test/unit/events/`): the registry guards (table == registry, category = prefix, every
  kind has a sample that validates and formats, every kind is emitted somewhere, every emit names a
  registered kind, compile-time errors for an unknown kind or a wrong payload), the bus (strict
  schema check, rate guard, ids, subscribe), the store (restart continuity, retention by days and by
  size, a corrupt line skipped, a disk error degrading to memory only, paging), jobs (outcomes,
  `by`, persistent processes ignored, home arrival), the item tally and containers, the resource
  watch, the seams in `wire.ts`, the routes and the summary.
- E2E `bot/test/e2e/pve-events.test.ts` on bds-pve: a CLI bot (`--walk`, a panel port in 9920..9929,
  `BEDROCKBOT_EVENTS_DIR` temporary) kills a zombie from the panel, takes damage, dies; `/api/events`
  and the summary show the commands, the job start and finish, the fight, the kill, the damage and
  the death; `!quit`, a new process on the same directory, and the old events are still served after
  the new `connection.connected`.

```sh
BDS_E2E=1 EVENTS_E2E_PORT=9920 pnpm --filter bot exec vitest run --project e2e pve-events
```

## Not yet

- The timeline UI, notifications and "ask the owner" prompts (step 5) read this stream.
- Flight details (rockets used, go-arounds) are in the `job.finished` / `job.failed` of `fly` only as
  the result's numbers; richer flight events need hooks in `skills/fly` (another session's area).
- `resource.low` is derived from the inventory; a skill that refuses for lack of something
  (`eat: no food`, `no rockets in the hotbar`) records it as the job's failure reason.
