import {
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

/** The invariant detail of a refused retention command; other failures are test bugs. */
const expectRefusal = (command: OrchestrationCommand, readModel: OrchestrationReadModel) =>
  decideOrchestrationCommand({ command, readModel }).pipe(
    Effect.flip,
    Effect.map((error) => ("detail" in error ? error.detail : String(error))),
  );

const THREAD_ID = ThreadId.make("thread-1");
const CREATED_AT = "2025-12-01T00:00:00.000Z";
const SETTLED_AT = "2025-12-02T00:00:00.000Z";
const CUTOFF = "2025-12-20T00:00:00.000Z";

function makeReadModel(overrides: Partial<OrchestrationThread> = {}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        archivedAt: null,
        settledOverride: "settled",
        settledAt: SETTLED_AT,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
        ...overrides,
      } as OrchestrationThread,
    ],
    updatedAt: CREATED_AT,
  };
}

function makeCommand(settledAt: string = SETTLED_AT): OrchestrationCommand {
  return {
    type: "thread.auto-delete-settled",
    commandId: CommandId.make("cmd-retention"),
    threadId: THREAD_ID,
    settledAt: IsoDateTime.make(settledAt),
    cutoff: IsoDateTime.make(CUTOFF),
  };
}

function makeSession(status: OrchestrationSession["status"]): OrchestrationSession {
  return {
    threadId: THREAD_ID,
    status,
    providerName: "Codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: CREATED_AT,
  };
}

it.layer(NodeServices.layer)("thread.auto-delete-settled decider", (it) => {
  it.effect("deletes a thread settled before the cutoff", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: makeCommand(),
        readModel: makeReadModel(),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.deleted");
      if (events[0]?.type === "thread.deleted") {
        expect(events[0].payload.threadId).toBe(THREAD_ID);
      }
    }),
  );

  it.effect("refuses when the scanned settledAt no longer matches", () =>
    Effect.gen(function* () {
      const detail = yield* expectRefusal(makeCommand("2025-12-01T12:00:00.000Z"), makeReadModel());
      expect(detail).toContain("re-settled after the retention scan");
    }),
  );

  it.effect("refuses when the thread settled after the cutoff", () =>
    Effect.gen(function* () {
      const settledAfterCutoff = "2025-12-25T00:00:00.000Z";
      const detail = yield* expectRefusal(
        makeCommand(settledAfterCutoff),
        makeReadModel({ settledAt: settledAfterCutoff }),
      );
      expect(detail).toContain("settled after the retention cutoff");
    }),
  );

  it.effect("refuses every lifecycle and in-flight-work blocker", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<{
        readonly overrides: Partial<OrchestrationThread>;
        readonly detail: string;
      }> = [
        { overrides: { deletedAt: CREATED_AT }, detail: "is already deleted" },
        { overrides: { settledOverride: "active", settledAt: null }, detail: "is not settled" },
        { overrides: { pinnedAt: CREATED_AT }, detail: "is pinned" },
        { overrides: { snoozedUntil: "2030-01-01T00:00:00.000Z" }, detail: "is snoozed" },
        { overrides: { archivedAt: CREATED_AT }, detail: "is archived" },
        { overrides: { session: makeSession("starting") }, detail: "has an active session" },
        { overrides: { session: makeSession("running") }, detail: "has an active session" },
        {
          overrides: {
            activities: [
              {
                id: EventId.make("activity-1"),
                turnId: null,
                tone: "approval",
                kind: "approval.requested",
                summary: "Approval requested",
                payload: { requestId: "req-1" },
                createdAt: CREATED_AT,
              },
            ] satisfies OrchestrationThread["activities"],
          },
          detail: "has a pending approval or user-input request",
        },
        {
          overrides: {
            messages: [
              {
                id: MessageId.make("message-1"),
                turnId: null,
                role: "user",
                text: "still working",
                streaming: false,
                // The decider's test clock is the epoch, and a queued turn
                // start is only detected inside the adoption grace window.
                createdAt: "1970-01-01T00:00:00.000Z",
                updatedAt: "1970-01-01T00:00:00.000Z",
              },
            ] satisfies OrchestrationThread["messages"],
          },
          detail: "has a queued turn start",
        },
      ];

      for (const testCase of cases) {
        const detail = yield* expectRefusal(makeCommand(), makeReadModel(testCase.overrides));
        expect(detail).toContain(testCase.detail);
      }
    }),
  );
});
