# 0130: Build replies that fit the chat (Track B5)

Date: 2026-11-23. Status: accepted. No new setting. Details: [../build.md](../build.md) "Replies that fit the chat
(Track B5)"; the chat's rate limit and queue are in [../chat-style.md](../chat-style.md) and `bot/src/chat/chat.ts`; the
bill is [0125](0125-java-files-and-bill.md).

## Context

`!build materials` for a structure file of 9 573 blocks in 125 kinds said 67 lines (about 13 900 bytes): the materials
line, the bill a line per 250 bytes, the unknown blocks a line each. The chat sends at most 8 replies in 10 s and keeps
16 lines waiting for 60 s; a reply past that is dropped (`chat rate limit, queue full, dropping`). Every line was dropped
on a live server and nothing was said. The same could happen with a fetch refused for what cannot be got (a list of
every item with its reason), the plan line's and the end line's refusal and skip lists, `!build status` and `!build
files`.

## Decision

1. **The budget.** A `!build` reply is at most 3 lines of at most 250 bytes each (`REPLY_LINES`, `LINE_BYTES` in
   `skills/build/reply.ts`). Two 250-byte lines never join on the wire (the join limit is 480 bytes), so each line takes
   one of the 8 slots: 3 leave 5 for everything else, and 8 build commands typed in one go (24 lines) still fit the 8
   sent and the 16 waiting. The chat's own limits are unchanged.
2. **Whole when it fits, else a summary first.** A reply whose whole text wraps into 3 lines is said as before (small
   builds and the e2e strings are unchanged). Otherwise a summary: the totals (`9573 blocks, 125 kinds: 127 have (30 at
   home), 3273 to make or !get, 6173 cannot get (smooth_quartz 2297, ..., +103 more)`), the biggest items (`most: ...,
   +110 more`), then the bill's steps, each step in full, or its biggest entry and `+N more`, or `N kinds`, whatever fits,
   with the refused and unknown counts. Every list that leaves something out says `+N more`, and a summary ends with
   `(all: !build more)`.
3. **The full text stays reachable.** The controller keeps the full text of the last reply of each topic (materials,
   refused, fetch, files, plan, status, end, stop, resume), wrapped at 210 bytes so a page note fits. `!build more [page]`
   pages through the last one, 3 lines a page, the last line ending `(page p of P: !build more p+1)`; `!build materials
   <build> more [page]` and `!build files more [page]` page through those directly. The full text is also logged once
   as INFO lines (`build: <title>: the full text, N lines`, then `build: [i/N] ...`; the same text again is not logged
   again) and served by the panel at `GET /api/build` (`{ texts: [{ topic, title, lines, at }] }`, the newest first).
   There is no panel card: the JSON route only.
4. **Each fact once in the full text.** The full materials text names a bill entry nothing has or makes only in the
   cannot step, that step gives each reason once for all the items it covers, and the unknown blocks are grouped by
   their reason. The house above went from 67 lines to 27 (9 pages).

## Consequences

- No build reply can fill the chat queue: the guard test (`bot/test/unit/build-replies.test.ts`) builds a 125-kind
  fixture with every bill section full and checks every `!build` reply against the budget in lines and bytes, and
  sends 8 commands through the real chat sender with fake timers: no line dropped.
- The plan and end lines' refusal list says `+N more` instead of `...`; an end line over 250 bytes goes on in a second
  line.
- Not done: a panel card for the texts; the unknown-blocks refusal (`build: hut: 102 blocks have no Bedrock block: ...,
  11 more kinds`) is one line as before, pointing at `!build materials`.
