// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { makePiAdapter } from "./PiAdapter.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockPiWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "pi-acp");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  await NodeFSP.writeFile(
    wrapperPath,
    `#!/bin/sh\n${envExports}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"\n`,
    "utf8",
  );
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-pi-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(testLayer)("PiAdapterLive", (it) => {
  it.effect("runs a standard ACP session with model selection and streaming", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-mock-thread");
      const binaryPath = yield* Effect.promise(() => makeMockPiWrapper());
      const adapter = yield* makePiAdapter(decodePiSettings({ binaryPath })).pipe(Effect.orDie);
      const completed = yield* Deferred.make<void>();
      const eventTypes: Array<string> = [];
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => eventTypes.push(event.type)).pipe(
          Effect.andThen(
            event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("piAgent"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("piAgent"),
          model: "composer-2",
        },
      });
      assert.strictEqual(session.provider, "piAgent");
      assert.strictEqual(session.model, "composer-2");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({ threadId, input: "hello pi", attachments: [] });
      yield* Deferred.await(completed);
      assert.includeMembers(eventTypes, [
        "session.started",
        "thread.started",
        "turn.started",
        "content.delta",
        "turn.completed",
      ]);

      yield* Fiber.interrupt(eventFiber);
      yield* adapter.stopSession(threadId);

      const resumed = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("piAgent"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: session.resumeCursor,
      });
      assert.deepStrictEqual(resumed.resumeCursor, session.resumeCursor);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("returns provider-advertised permission option ids", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-permission-option-id");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-acp-permission-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const binaryPath = yield* Effect.promise(() =>
        makeMockPiWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_ALLOW_ONCE_OPTION_ID: "pi-advertised-option-id",
        }),
      );
      const adapter = yield* makePiAdapter(decodePiSettings({ binaryPath })).pipe(Effect.orDie);
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(String(event.requestId)),
              "accept",
            )
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("piAgent"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "use a tool", attachments: [] });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(
        requests.some(
          (entry) =>
            !("method" in entry) &&
            typeof entry.result === "object" &&
            entry.result !== null &&
            "outcome" in entry.result &&
            typeof entry.result.outcome === "object" &&
            entry.result.outcome !== null &&
            "optionId" in entry.result.outcome &&
            entry.result.outcome.optionId === "pi-advertised-option-id",
        ),
      );
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );
});
