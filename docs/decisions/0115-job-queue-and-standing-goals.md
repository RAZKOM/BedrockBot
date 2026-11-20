# 0115: The job queue and the standing goals (Track P4, panel programme step 4)

Date: 2026-11-20. Status: accepted. No new setting: the queue is used only when the owner adds a job, and its
failure policy is kept in the queue's file (`!queue onfail`). The standing goals change no chore. They list the
chores' existing settings and record their runs. Guide: [../queue.md](../queue.md); the view:
[../panel.md](../panel.md) "Jobs view"; the body's sharing: [../processes.md](../processes.md) "Chores and the queue".

## Context

The owner can give one command at a time. Work that takes an evening (a kit, a smelt, a trip, a refill) needs
someone to type the next command when the last one ends. The chores (food, milk, rockets, the farm, the shell's
blocks, the unload, breeding) each have their own setting, scattered across the settings card, with no one place
that says what they keep, when they last ran, or whether they are waiting for the owner's work. Step 4 of the panel
programme asks for both: a queue of jobs and a list of standing goals, with a Jobs view.

## Decision

1. **A job is a chat command line (`tasks/queue.ts` `JobQueue`).**
   - It is run through the chat handler as the first owner, so it does what the typed command does.
   - Nothing new can be done through the queue that a typed line cannot do.
   - The queue never moves the body. The process manager's priorities stay as they are: the flight, the flee, the
     blade, the defence, the night, the guard and the reflex under them.
   - Rejected: a job type per skill (a second way into every skill, and every new command needing a queue adapter).
2. **One job at a time; the next starts when the bot has been free for 5 s.** Free means:
   - no user process and no obtain or mend job;
   - nothing auto in control;
   - spawned, ready and alive.

   The gap is where a due chore takes its turn. A chore or the walk home that holds the body for 20 min is
   pre-empted, as a typed command pre-empts it. Safety processes are waited for with no limit.
3. **How "ended" is known, by kind.**
   - The user processes the dispatch added: gone for 2 s, so that a command's own next step is the same job. The
     state is the last process's result (`outcomeOf`).
   - The obtain or mend job: until its end line.
   - A command that only answers: its reply, then 1 s of quiet, its state from the words (`lineState`).
   - Every refusal is given when the job is added, with its reason. These are the commands that never end by
     themselves (`!follow`, `!farm`), act on the running work (`!stop`, `!pause`, `!resume`), end the bot (`!quit`),
     need the owner (`!learn`, `!do`/`!yes`/`!no`), or run their own series (`!test`).
4. **A typed command pre-empts.** A command the owner types that does work (`Chat.handle(line, typed)`; the panel's
   `POST /api/cmd` counts) pauses the queue and says so. The running job is left to the process manager (replaced
   when the command has the same name, stacked otherwise) and watched to its end, its end line frozen at the typing.
   Nothing resumes the queue but `!queue resume`.
   - Rejected: auto-resume after the typed command ends. The owner took the bot for a reason the queue cannot know.
5. **The night is not a failure.** The night process pauses a walking job like any process does, and the queue waits
   for the job. A `!get` job with `jobDusk` waits out the night inside the job and ends `done` with `paused for 1
   night`. No new job starts while it waits.
6. **The failure policy: `next` by default, `stop` on request.** `next` suits a list of unrelated chores. `stop`
   suits a chain where each step needs the last.
7. **The restart: the running job is not run again.** It may have half done its work (half a trip, items moved, a
   furnace loaded), and running it again could repeat a take or a craft. It ends `cancelled` with the reason and
   `!queue retry <id>` in the line. The waiting jobs, the pause and the policy are kept (`<config dir>/queue/<server>.json`
   or `BEDROCKBOT_QUEUE_DIR`, written atomically).
8. **Standing goals (`tasks/goals.ts`).**
   - One list of the chores with their setting, target, last run (from `onControl`, and a sweep for the hand-backs
     that emit no event) and their relation to the queue: running, queue waits, waits for the queue, idle, off.
   - A chore joins with one line: `registerGoal(d.task, {id, label, setting, process, target, last})`.
   - The switches are the settings path (`!set <setting> on|off`).
   - Chores and jobs share the body by the existing rule: a chore wants it only with no user process. So a chore runs
     between jobs, in the gap, and the queue waits for it.
9. **The panel's Jobs view and `jobs` topic (`health/panel/jobs.ts`, `client/jobs.ts`).**
   - A fourth view. Every control sends a command line through `/api/cmd`.
   - "Add to queue" sits beside the map sheet's Send, the storage view's Bring and the Bring picker.
   - The topic has budgets of its own: a snapshot 24 000 (worst case 20 216) and a delta 2 000 (worst case 480).

## Evidence

On bds-core through the panel's API (`test/e2e/panel-queue.test.ts`, three runs of six cases; numbers in
[../queue.md](../queue.md) "Measured"):

- four jobs ran in order, with a gap of 5.4 to 7.9 s;
- a failed walk was followed by the next job, and with `onfail stop` the queue paused;
- a typed `!goto` paused the queue and replaced the queued walk;
- a restart ended the running walk `cancelled`, the bot did not walk on, and the next job ran;
- a queued `!get iron_chestplate` with `jobDusk` waited out the night at the shelter, with its follower waiting, and
  both ended after dawn;
- the milk chore, switched on through the panel, ran between two jobs.

## Consequences

- A command that fails with none of the failure words reads as `done` (the reply-only kind). The processes' results
  and the obtain job's end line decide where they exist.
- A multi-step job of another track that drops its processes between steps for over 2 s must register a
  `JobHolder` in `chat/commands-queue.ts`, else the queue ends it early.
- The `html` budget rose to 152 500 (151 208 measured on its base, 151 922 with Track E9's `jobMorning` row) and the `modules` total holds (195 255 of 200 000).
