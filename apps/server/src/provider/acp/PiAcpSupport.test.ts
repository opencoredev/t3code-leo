import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { buildPiAcpSpawnInput, applyPiAcpModelSelection } from "./PiAcpSupport.ts";

describe("PiAcpSupport", () => {
  it("spawns the external pi-acp executable with the host environment and cwd", () => {
    const environment = {
      HOME: "/home/tester",
      PI_CODING_AGENT_DIR: "/home/tester/.pi/custom",
      OPENAI_API_KEY: "ambient",
    };
    expect(
      buildPiAcpSpawnInput({ binaryPath: "/opt/pi/bin/pi-acp" }, "/workspace", environment),
    ).toEqual({
      command: "/opt/pi/bin/pi-acp",
      args: [],
      cwd: "/workspace",
      env: environment,
    });
  });

  it("applies the advertised model and thinkingLevel config options", async () => {
    const writes: Array<[string, string | boolean]> = [];
    const selected = await Effect.runPromise(
      applyPiAcpModelSelection({
        runtime: {
          getConfigOptions: Effect.succeed([
            {
              id: "thinkingLevel",
              name: "Thinking level",
              category: "model_config",
              type: "select",
              currentValue: "medium",
              options: [
                { value: "medium", name: "Medium" },
                { value: "high", name: "High" },
              ],
            },
          ]),
          setModel: (model) => Effect.sync(() => writes.push(["model", model])).pipe(Effect.asVoid),
          setConfigOption: (id, value) =>
            Effect.sync(() => writes.push([id, value])).pipe(Effect.as({ configOptions: [] })),
        },
        currentModelId: "openai/old",
        requestedModelId: "anthropic/claude-sonnet",
        selections: [{ id: "thinkingLevel", value: "high" }],
        mapError: (error) => error,
      }),
    );

    expect(selected).toBe("anthropic/claude-sonnet");
    expect(writes).toEqual([
      ["model", "anthropic/claude-sonnet"],
      ["thinkingLevel", "high"],
    ]);
  });
});
