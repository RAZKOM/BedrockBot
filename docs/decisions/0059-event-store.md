# 0059: Event history: a typed registry, one bus, JSONL per day

Date: 2026-11-05. Status: accepted (web panel programme, step 1, Track PB). Details: [../events.md](../events.md).

## Context

The panel is to become the bot's cockpit, and step 5 of the programme (away mode) needs "what did the
bot do in the last 8 hours": fights, deaths, items gained, chests changed, jobs and why they failed,
kicks and reconnects. Notifications and "ask the owner" prompts will hang off the same stream. Before
this, that history existed only as log lines (the panel's 200-line ring) and counters that reset on
restart (`Metrics`, the pve stats, the panel's Combat card).

## Decisions

1. **One owning module, a typed registry.** `bot/src/events/registry.ts` lists every kind with its
   category (the part before the dot), a fixed severity, a one-line doc, a zod schema and a formatter.
   The payload type of `events.emit(kind, data)` is inferred from the schema, so an unregistered kind
   or a wrong payload does not compile. The guide's table, `GET /api/events/kinds` and the guard tests
   are generated from the registry. zod is already a dependency (config, map schema, waypoints); no
   new dependency.
2. **Emitting is one line, and seams first.** Where an observer API already exists (connection
   spawn / close, chat commands, the respawn controller, the mob tracker's hits, container packets,
   inventory changes) a listener in `events/wire.ts` records the event; nothing changes at the source.
   Where none exists, one emit line: the combat skill's fight end and kill, the flee start, and the
   process manager's add / finished / remove (job events for every command, chore episode, home
   return and flight, without touching any process or `skills/fly`).
3. **Diffs instead of reports for items and chests.** No skill reports what it picked up, crafted or
   stored, and adding that to every skill would be dozens of sites. The inventory model is diffed
   after each change; while a storage window is open the delta belongs to that container (one deposit
   and one withdraw per open), otherwise it is batched into `items.changed` per job and per minute.
4. **Severity is per kind, three levels.** alert (look now: death, kick, connection lost for good),
   notable (timeline-worthy: failures, flights, reconnects, low resources), info (routine). Two
   severities for one situation means two kinds. Step 5 notifications start from alert.
5. **Storage: append-only JSONL per UTC day** in `<config dir>/events/<server id>/`, next to the world
   cache and keyed the same way. Asynchronous batched appends (1 s or 256 events), never on the tick;
   ids continue across restarts from the newest stored line; retention by days and total size
   (settings `eventsDays` 14, `eventsMaxMb` 64; today's file is never deleted). A disk error switches
   to memory only with one logged error. A corrupt line is skipped. An in-memory ring of 2000 answers
   recent queries without touching the disk.
6. **Query API in the module, mounted by the panel.** `GET /api/events` (since an id or a time,
   until, kinds or categories, a minimum severity, a limit), `GET /api/events/summary?hours=8` and
   `GET /api/events/kinds`, behind the panel's token; two `use()` lines in `health/panel/index.ts`.
7. **Live: `events.subscribe(listener)`.** Synchronous, in order, errors contained. The panel's push
   transport (Track PA, built in parallel) can publish an `events` topic from it in a few lines; this
   module does not depend on it.
8. **Who did it.** The chat's command listener sets the current actor for the synchronous run of a
   command (cleared by a microtask), so job events record `by`; panel commands are marked with
   `viaPanel` and record source `panel`.
9. **A rate guard.** More than 120 events of one kind in a minute is a bug at the site; the rest of
   that minute is dropped and counted, with one warning, so a loop cannot fill the disk.

## Alternatives rejected

- **SQLite (node:sqlite) or another database.** Indexed queries, but a binary file the owner cannot
  read or grep, and more failure modes on a Mac / Windows move. The
  volumes are small (well under 1 MB a day): a day file read whole is fast enough, and JSONL is easy
  to inspect, back up and trim.
- **Parsing the log.** Free-form text, redacted for the panel, and it changes with every wording fix.
- **Extending `Metrics` counters.** Counts without the when, the why or the position, and they reset
  on restart.
- **An emit in every skill for items** (picked up, crafted, placed, stored). Dozens of sites that rot;
  the inventory diff sees all of them, including ones nobody thought of.
- **One event per stack or per hit.** A mining hour would be thousands of lines; the timeline wants
  one line per job or per minute.
- **Severity chosen per emit.** Callers would drift; filters and notifications need a fixed meaning.

## Consequences

- Adding a kind is one registry entry, one sample in the tests, a regenerated table and one emit line;
  the guard tests fail when any of these is missing or when a kind is registered but never emitted.
- Step 5 reads the summary and the stream; the timeline UI, notifications and prompts plug in without
  changing the store.
- Flight details beyond the job result need hooks in `skills/fly` (left to the flight session).
- `resource.low` is derived from the inventory and the existing settings (`toolWearLimit`,
  `fireworksMin`); refusals inside skills show up as job failure reasons.
