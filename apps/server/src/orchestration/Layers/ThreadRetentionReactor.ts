import { CommandId, IsoDateTime, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { ServerSettingsService } from "../../serverSettings.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ThreadRetentionReactor,
  type ThreadRetentionReactorShape,
} from "../Services/ThreadRetentionReactor.ts";

/**
 * One scan never proposes more than this many deletes. Retention is a
 * background chore: a bounded page keeps a first run over a huge backlog from
 * flooding the dispatch queue, and the next scan picks up the remainder.
 */
export const RETENTION_SCAN_PAGE_SIZE = 100;
export const RETENTION_SCAN_INTERVAL = Duration.hours(6);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const RetentionCandidateRow = Schema.Struct({
  threadId: ThreadId,
  settledAt: IsoDateTime,
});

/**
 * Bounded page of settled threads that a scan may propose for deletion.
 *
 * A coarse pre-filter only. Every column here is re-checked by the decider
 * against the authoritative read model; the SQL exists to keep the page small,
 * not to be the safety boundary.
 */
export const makeRetentionCandidateQuery = (sql: SqlClient.SqlClient) =>
  SqlSchema.findAll({
    Request: Schema.Struct({ cutoff: Schema.String }),
    Result: RetentionCandidateRow,
    execute: ({ cutoff }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          settled_at AS "settledAt"
        FROM projection_threads
        WHERE deleted_at IS NULL
          AND archived_at IS NULL
          AND pinned_at IS NULL
          AND snoozed_until IS NULL
          AND settled_override = 'settled'
          AND settled_at IS NOT NULL
          AND settled_at <= ${cutoff}
        ORDER BY settled_at ASC, thread_id ASC
        LIMIT ${RETENTION_SCAN_PAGE_SIZE}
      `,
  });

/** Start of the retention window for one scan: everything settled at or before this is a candidate. */
export const retentionCutoff = (days: number, nowMs: number): IsoDateTime =>
  IsoDateTime.make(DateTime.formatIso(DateTime.makeUnsafe(nowMs - days * MS_PER_DAY)));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const serverSettings = yield* ServerSettingsService;

  const listRetentionCandidates = makeRetentionCandidateQuery(sql);

  const nextCommandId = crypto.randomUUIDv4.pipe(
    Effect.map((uuid) => CommandId.make(`server:retention:${uuid}`)),
  );

  const runScan = Effect.fn("runScan")(function* () {
    const settings = yield* serverSettings.getSettings;
    const days = settings.autoDeleteSettledThreadsAfterDays;
    if (days === null) {
      return;
    }
    // One cutoff for the whole page: every candidate is judged against the
    // same clock, and the decider re-checks the thread against this exact
    // value so a slow scan cannot widen its own window.
    const cutoff = retentionCutoff(days, yield* Clock.currentTimeMillis);
    const candidates = yield* listRetentionCandidates({ cutoff });
    for (const candidate of candidates) {
      const commandId = yield* nextCommandId;
      yield* orchestrationEngine
        .dispatch({
          type: "thread.auto-delete-settled",
          commandId,
          threadId: candidate.threadId,
          settledAt: candidate.settledAt,
          cutoff,
        })
        .pipe(
          // A rejected command is the normal outcome for a thread that moved
          // between scan and dispatch. Retention must never fail the scan
          // over one ineligible candidate.
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logDebug("retention skipped settled thread", {
                  threadId: candidate.threadId,
                  cause: Cause.pretty(cause),
                }),
          ),
        );
    }
  });

  const runScanSafely = () =>
    runScan().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("settled thread retention scan failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const worker = yield* makeDrainableWorker(runScanSafely);

  const start: ThreadRetentionReactorShape["start"] = Effect.fn("start")(function* () {
    // Subscribe before the first scan so a setting flipped during startup is
    // not lost between the snapshot and a lazily started stream.
    const changes = yield* serverSettings.subscribeChanges;
    yield* forkParked(Stream.runForEach(changes, () => worker.enqueue(undefined)));
    // Run immediately, then re-scan on a coarse schedule so a stable setting
    // continues to age threads into eligibility without client activity.
    yield* forkParked(
      worker
        .enqueue(undefined)
        .pipe(Effect.repeat(Schedule.spaced(RETENTION_SCAN_INTERVAL)), Effect.asVoid),
    );
  });

  return {
    start,
    scanNow: worker.enqueue(undefined),
    drain: worker.drain,
  } satisfies ThreadRetentionReactorShape;
});

export const ThreadRetentionReactorLive = Layer.effect(ThreadRetentionReactor, make);
