import { CommandId, ThreadId, TurnId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrphanedSessionRecovery,
  type OrphanedSessionRecoveryShape,
} from "../Services/OrphanedSessionRecovery.ts";

/** One boot cannot have stranded more sessions than a user has threads open. */
export const ORPHANED_SESSION_SCAN_LIMIT = 200;

const OrphanedSessionRow = Schema.Struct({
  threadId: ThreadId,
  activeTurnId: Schema.NullOr(TurnId),
});

/**
 * Sessions the previous process left in a live state. Every one is stale: a
 * provider session cannot outlive the server that spawned it.
 */
export const makeOrphanedSessionQuery = (sql: SqlClient.SqlClient) =>
  SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: OrphanedSessionRow,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          active_turn_id AS "activeTurnId"
        FROM projection_thread_sessions
        WHERE status IN ('starting', 'running')
        ORDER BY updated_at ASC
        LIMIT ${ORPHANED_SESSION_SCAN_LIMIT}
      `,
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;

  const listOrphanedSessions = makeOrphanedSessionQuery(sql);
  const nextCommandId = crypto.randomUUIDv4.pipe(
    Effect.map((uuid) => CommandId.make(`server:session-recovery:${uuid}`)),
  );

  const runRecovery = Effect.fn("runRecovery")(function* () {
    // A projection read that fails must not stop the server from booting.
    const orphans = yield* listOrphanedSessions({}).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("orchestration.session.recovery.scan-failed", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as([] as ReadonlyArray<typeof OrphanedSessionRow.Type>)),
      ),
    );
    if (orphans.length === 0) {
      return;
    }

    for (const orphan of orphans) {
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      // Interrupt first so the turn settles, then stop so the session leaves
      // its live state. A thread with neither is stuck reading "Working".
      if (orphan.activeTurnId !== null) {
        yield* orchestrationEngine
          .dispatch({
            type: "thread.turn.interrupt",
            commandId: yield* nextCommandId,
            threadId: orphan.threadId,
            turnId: orphan.activeTurnId,
            createdAt,
          })
          .pipe(Effect.catchCause((cause) => logSkip("interrupt", orphan.threadId, cause)));
      }
      yield* orchestrationEngine
        .dispatch({
          type: "thread.session.stop",
          commandId: yield* nextCommandId,
          threadId: orphan.threadId,
          createdAt,
        })
        .pipe(Effect.catchCause((cause) => logSkip("stop", orphan.threadId, cause)));
    }

    yield* Effect.logInfo("orchestration.session.recovery.complete", {
      recoveredCount: orphans.length,
    });
  });

  // Recovery is a courtesy pass over stale state: nothing it hits is worth
  // refusing to boot over.
  const recover: OrphanedSessionRecoveryShape["recover"] = () =>
    runRecovery().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("orchestration.session.recovery.failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    );

  return { recover } satisfies OrphanedSessionRecoveryShape;
});

/**
 * A thread that moved on since the crash rejects these commands. That is the
 * normal outcome for a stale candidate, never a reason to fail startup.
 */
const logSkip = (
  step: string,
  threadId: ThreadId,
  cause: Cause.Cause<unknown>,
): Effect.Effect<void> =>
  // Shutdown still wins; everything else is an expected stale candidate.
  Cause.hasInterruptsOnly(cause)
    ? Effect.interrupt
    : Effect.logDebug("orchestration.session.recovery.skipped", {
        step,
        threadId,
        cause: Cause.pretty(cause),
      });

export const OrphanedSessionRecoveryLive = Layer.effect(OrphanedSessionRecovery, make);
