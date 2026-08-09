import { describe, expect, it } from "@effect/vitest";

import { buildPiCapabilitiesFromConfigOptions } from "./PiProvider.ts";

describe("PiProvider", () => {
  it("publishes Pi's advertised thinkingLevel option ids and values", () => {
    expect(
      buildPiCapabilitiesFromConfigOptions([
        {
          id: "thinkingLevel",
          name: "Thinking level",
          category: "model_config",
          type: "select",
          currentValue: "high",
          options: [
            { value: "off", name: "Off" },
            { value: "high", name: "High" },
            { value: "max", name: "Max" },
          ],
        },
      ]),
    ).toEqual({
      optionDescriptors: [
        {
          id: "thinkingLevel",
          label: "Thinking level",
          type: "select",
          currentValue: "high",
          options: [
            { id: "off", label: "Off" },
            { id: "high", label: "High", isDefault: true },
            { id: "max", label: "Max" },
          ],
        },
      ],
    });
  });
});
