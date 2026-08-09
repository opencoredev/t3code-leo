/**
 * ThreadRetentionReactor - Server-owned retention for settled threads.
 *
 * Scans the thread projection for threads that have been settled longer than
 * `autoDeleteSettledThreadsAfterDays` and dispatches guarded
 * `thread.auto-delete-settled` commands. The decider owns every safety check;
 * this service only proposes candidates.
 *
 * @module ThreadRetentionReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * ThreadRetentionReactorShape - Service API for settled-thread retention.
 */
export interface ThreadRetentionReactorShape {
  /**
   * Scan on startup, on a coarse schedule, and whenever server settings change.
   *
   * The returned effect must be run in a scope so the settings-watch fiber can
   * be finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Enqueue one scan immediately. Intended for tests and for callers that
   * need deterministic retention without waiting for a settings change.
   */
  readonly scanNow: Effect.Effect<void>;

  /**
   * Resolves when the scan queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * ThreadRetentionReactor - Service tag for settled-thread retention.
 */
export class ThreadRetentionReactor extends Context.Service<
  ThreadRetentionReactor,
  ThreadRetentionReactorShape
>()("t3/orchestration/Services/ThreadRetentionReactor") {}
