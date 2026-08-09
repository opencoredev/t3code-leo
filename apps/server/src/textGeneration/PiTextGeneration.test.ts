// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { PiSettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { makePiTextGeneration } from "./PiTextGeneration.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.optional(Schema.String),
      params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);

const testLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-pi-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

it.layer(testLayer)("PiTextGeneration", (it) => {
  it.effect("generates required text through Pi ACP with model config selection", () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-pi-text-acp-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
      );
      const requestLogPath = NodePath.join(dir, "requests.ndjson");
      const binaryPath = NodePath.join(dir, "pi-acp");
      NodeFS.writeFileSync(
        binaryPath,
        [
          "#!/bin/sh",
          `export T3_ACP_REQUEST_LOG_PATH=${shellSingleQuote(requestLogPath)}`,
          `export T3_ACP_PROMPT_RESPONSE_TEXT=${shellSingleQuote('{"title":"Add Pi ACP support"}')}`,
          `exec ${shellSingleQuote(process.execPath)} ${shellSingleQuote(mockAgentPath)}`,
          "",
        ].join("\n"),
        "utf8",
      );
      NodeFS.chmodSync(binaryPath, 0o755);

      const textGeneration = yield* makePiTextGeneration(decodePiSettings({ binaryPath }));
      const generated = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "support pi through acp",
        modelSelection: createModelSelection(ProviderInstanceId.make("piAgent"), "composer-2"),
      });
      expect(generated.title).toBe("Add Pi ACP support");

      const requests = NodeFS.readFileSync(requestLogPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => decodeRequest(line));
      expect(
        requests.some(
          (request) =>
            request.method === "session/set_config_option" &&
            request.params?.configId === "model" &&
            request.params.value === "composer-2",
        ),
      ).toBe(true);
    }).pipe(Effect.scoped),
  );
});
