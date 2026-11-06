# 0061: Panel push channel (SSE with deltas), browser modules by type stripping, per-piece budgets

Date: 2026-11-05. Status: accepted (web panel programme, step 1, Track PA; builds on
[0026](0026-lan-control-panel.md), [0037](0037-panel-inventory-and-statuses.md) and
[0039](0039-panel-interactions.md)). Details: [../panel.md](../panel.md) "Live updates", "Push channel",
"Add a topic", "Browser modules", "Budgets", "Measured".

## Context

Until now the page polled `GET /api/state?lite=1` every 2 s. It got a full lite state each time,
about 8 to 20 KB, even when only the clock moved. The page script was one 45 KB string of plain
JavaScript (`client.ts`), inlined into every page load, with the menu model as another string
(`MENU_JS`) evaluated on the server for the tests. The page had a single 160 KB cap.

The programme's next steps need three things:

- **Push.** An event store (Track PB) and later map tiles, a job queue and notifications all need a
  way to tell the page "something happened" without the page asking every 2 s.
- **A client people can work on.** That means typed modules, not one string, with the type checker
  and the linter on them. The no-build rule stays: no bundler, no CDN, nothing from the internet.
- **Budgets that do not fight each other.** One page cap meant a new card and a bigger script
  competed for the same number.

## Decision

### 1. Server-Sent Events, not WebSocket, not faster polling

`GET /api/stream` is an SSE stream behind the same token and cookie as every other route
(`health/panel/stream.ts`, `StreamHub`).

- **SSE over WebSocket.** The traffic is one-way: commands already have `POST /api/cmd` with its rate
  limit, owner check and Origin rule. SSE is plain HTTP, so `checkRequest` covers it unchanged:
  cookie, Bearer, the loopback Host rule. WebSocket would need its own upgrade path, its own auth
  check and a framing implementation. Node has no WebSocket server built in, so it would also mean a
  dependency, or about 300 lines of RFC 6455. `EventSource` reconnects by itself and sends
  `Last-Event-ID`, which is exactly the resume this design needs.
- **SSE over faster polling.** A 500 ms poll would move about 16 KB per poll per tab. The stream moves
  one snapshot, then about 300 bytes a second while idle.
- **Polling stays as the fallback.** It covers a browser without `EventSource`, a stream that is
  refused (503 at the cap, 401), a proxy that buffers (no state within 6 s), and a stream that drops 3
  times. After a fallback the page polls and tries the stream again after 30 s, doubling per failure
  up to 8 min.

### 2. Topics with one sequence, a snapshot then deltas

The hub carries **topics**. A `state` topic holds a value; each change is sent as a **delta** (only the
changed fields or inventory cells), with a **snapshot** on connect. An `event` topic passes each
message through. Every message on every topic takes the next number of one sequence. Its id is
`<boot>.<seq>`, so the browser's `Last-Event-ID` resumes from the 512-message (1 MiB) replay ring. An
id from another boot, or one older than the ring, gets snapshots instead.

The delta format (`client/delta.ts`) is three ops on JSON paths, chosen by the shortest JSON:

- `s`: set a value;
- `d`: delete a key;
- `a`: drop N items from the front of an array and append some (a log or chat ring that scrolled).

One changed inventory cell is one op, and a scrolled 50-line log is one op. The same module runs on
both sides: the server computes a delta once per publish for every client, and the page applies it.
A delta longer than the snapshot is sent as a snapshot.

The state topic is sampled once a second, and only while a stream listens: no client means no work.
A command pushes 250 ms after it runs. Robustness:

- a heartbeat every 5 s on a quiet stream lets the page's 15 s watchdog tell quiet from dead;
- at most 8 streams (503 beyond; the page polls);
- a client whose socket buffer passes 256 KiB is dropped, without holding the others back; it
  reconnects and resumes.

**Hidden tabs** close the stream and poll every 10 s, as before. The alternative was to keep the stream
and throttle it on the server. That would need per-client throttle state, and a background tab would
hold one of the 8 slots. Phones suspend background tabs anyway. Coming back reopens the stream with
the last id.

Other modules add topics (`panel.hub.topic(...)`) and routes (`panel.use(route)`) without touching the
panel's files. The recipe and reviewer checklist are in docs/panel.md "Add a topic".

The panel carries a second topic of its own, `events`: every bot event from the event bus
([0059](0059-event-store.md)) as it is recorded, with its display text. It subscribes while the panel
serves and unsubscribes in `stop()`. A late page reads `GET /api/events` once, then follows the topic.
The page shows no events yet; that is programme step 5.

### 3. Browser modules: TypeScript files, type-stripped once at startup

The client is real TypeScript under `health/panel/client/`:

- one module per card or concern (`inventory.ts`, `cards.ts`, `map.ts`, `transport.ts`, ...);
- `main.ts` wires them;
- `boot.ts` is the only file that reads browser globals; every other module gets them through
  `start(env)`, so the tests run them on a fake DOM;
- `shared.ts` holds the constants and wire types the server and the page share. Its only imports
  are `export type ... from`, which stripping erases.

At startup `assets.ts` reads these files and strips their types with Node's own
`module.stripTypeScriptTypes`, which adds no dependency and no build step. It keeps the results in
memory and serves them as native ES modules:

- the URL is `/ui/<hash>/client/main.ts`; the hash covers every module, so a new bot is a new URL
  and a browser never mixes versions;
- relative imports resolve under that prefix, exactly as in the source tree;
- headers are `text/javascript` and `cache-control: private, max-age=31536000, immutable` with an
  ETag;
- gzip when the browser accepts it;
- the page carries one `<script type="module">` and a `<link rel="modulepreload">` per module, so
  the browser fetches them in parallel.

Loading refuses anything a browser would trip over:

- an import outside the set (a server module, a Node built-in);
- an inline `import { type X }`, which strips to `import {} from`;
- a dynamic `import()`;
- a module over its budget.

A types-only file (`client/page.ts`) is not served at all.

The client type-checks without the DOM lib, through small interfaces of its own (`client/dom.ts`).
The server imports only the pure modules (`delta.ts`, `menu.ts`). `health/panel/menu.ts` re-exports
`client/menu.ts`, so `MENU_JS` and its `new Function` evaluation are gone. Guard tests
(`panel-modules.test.ts`) pin all of this.

Rejected:

- **a bundler (esbuild) at build or start time**: it is a dependency and a build step for about
  90 KB;
- **plain `.js` files with JSDoc types**: weaker checking, and two styles in one repo;
- **keeping the string**: no types, no lint, and a 45 KB inline script on every load.

### 4. Budgets per piece

`health/panel/budgets.ts` has one budget per piece: the HTML, each module, all modules, a snapshot
and a delta. A new card raises the piece it lives in. The budgets are enforced three ways:

- the worst-case unit fixture (`panel-budgets.test.ts`; `PANEL_MEASURE=1` prints every number);
- the e2e on bds-core (`panel-stream.test.ts`);
- at run time: a module over its budget refuses to load, and a snapshot or delta over its budget
  logs a warning once.

## Consequences

- An idle visible tab costs about 315 bytes/s. It used to cost an 8 to 20 KB poll every 2 s.
  A command's effect reaches the page in about 50 to 270 ms instead of up to 2 s.
- The page HTML is 96 KB live (108 KB worst case) instead of 140 to 150 KB. The 94 KB of modules
  (32 KB gzip) are fetched once per bot version, then come from the browser cache.
- A card is one module plus one line in `main.ts`. A pushed topic is one `hub.topic` call on the
  server and one `page.listen` call in a card.
- The polling path stays and is tested, so a browser or proxy without SSE loses nothing.
- Node 24's `stripTypeScriptTypes` is still marked experimental. Its warning is swallowed for that
  one call. If the API changes, `assets.ts` is the only place to fix, and the unit tests fail loudly
  at load.
