// Web panel step 4 (Track P4, ADR 0115, docs/panel.md "Jobs", docs/queue.md): the panel's side of the job queue
// (tasks/queue.ts) and the standing goals (tasks/goals.ts).
//
//   topic `jobs` (state)   the queue (paused, the running job with its live line, the waiting jobs, the last ended
//                          ones with their end lines, why the next does not start) and the goals (switch, target,
//                          last run, how it shares the body with the queue); refreshed on every queue change,
//                          sampled every SAMPLE_MS while a stream listens (the running line, the goals' runs)
//   GET /api/jobs          the same, for a page that polls (the stream refused or down)
//
// Read-only: every action of the view is a chat command through POST /api/cmd (`!queue add ...`, `!queue move 4 1`,
// `!set autoMilk on`), the same path as the game's chat.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '../../log.ts';
import type { GoalView, StandingGoals } from '../../tasks/goals.ts';
import type { JobQueue, QueueView } from '../../tasks/queue.ts';
import type { HealthRoute } from '../map/routes.ts';
import { PANEL_BUDGETS } from './budgets.ts';
import { JOBS_PATH, JOBS_TOPIC } from './shared.ts';
import type { StreamHub, Topic } from './stream.ts';

/** The topic is sampled this often while a stream listens. */
export const SAMPLE_MS = 1000;
/** After a queue change: the topic is refreshed this much later (an add and its start are one refresh). */
export const REFRESH_MS = 150;
/** Ended jobs the topic carries (the queue keeps HISTORY_KEEP). */
export const TOPIC_ENDED = 10;

/** The `jobs` topic's value. */
export interface JobsSummary {
  /** false: the task has no queue (no walking). */
  on: boolean;
  queue: QueueView | null;
  goals: GoalView[];
  /** The panel runs its commands as this owner (null: the console). */
  me: string | null;
}

export interface JobsSource {
  queue(): JobQueue | undefined;
  goals(): StandingGoals | undefined;
  runAs(): string | null;
}

export interface JobsLiveOptions {
  hub: StreamHub;
  source: JobsSource;
  log?: Logger;
}

export class JobsLive {
  readonly topic: Topic;
  private readonly o: JobsLiveOptions;
  private watched: JobQueue | undefined;
  private off: (() => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  readonly stats = { refreshes: 0 };

  constructor(o: JobsLiveOptions) {
    this.o = o;
    this.topic = o.hub.topic(JOBS_TOPIC, { kind: 'state', read: () => this.summary(), sampleMs: SAMPLE_MS, budget: PANEL_BUDGETS.jobs, deltaBudget: PANEL_BUDGETS.jobsDelta });
    this.watch();
  }

  /** Follow the task's queue (it is made by the afk task's registrations, before the panel; a test may swap it). */
  private watch(): void {
    const q = this.o.source.queue();
    if (q === this.watched) return;
    this.off?.();
    this.watched = q;
    this.off = q?.onChange(() => this.changed());
  }

  changed(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.stats.refreshes++;
      this.topic.refresh();
    }, REFRESH_MS);
    this.timer.unref?.();
  }

  summary(): JobsSummary {
    this.watch();
    const q = this.watched;
    return { on: q !== undefined, queue: q ? q.view(TOPIC_ENDED) : null, goals: this.o.source.goals()?.list() ?? [], me: this.o.source.runAs() };
  }

  route(): HealthRoute {
    return (path: string, req: IncomingMessage, res: ServerResponse): boolean => {
      if (path !== JOBS_PATH) return false;
      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        send(res, 405, { error: 'method not allowed' });
        return true;
      }
      try {
        send(res, 200, this.summary(), method === 'HEAD');
      } catch (e) {
        send(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    };
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.off?.();
    this.off = undefined;
  }
}

function send(res: ServerResponse, status: number, body: unknown, head = false): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(head ? undefined : `${JSON.stringify(body)}\n`);
}
