import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ModelCapabilities } from "@t3tools/contracts";

import {
  applyProviderModelOptionDefaults,
  buildProviderOptionSelectionsFromDescriptors,
  createModelCapabilities,
  createModelSelection,
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
  normalizeCustomModelSlug,
  normalizeModelSlug,
} from "./model.ts";

const codexCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "xhigh", label: "Extra High" },
        { id: "high", label: "High", isDefault: true },
      ],
      currentValue: "high",
    },
    {
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    },
  ],
});

const claudeCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High", isDefault: true },
        { id: "ultrathink", label: "Ultrathink" },
      ],
      currentValue: "high",
      promptInjectedValues: ["ultrathink"],
    },
    {
      id: "contextWindow",
      label: "Context Window",
      type: "select",
      options: [
        { id: "200k", label: "200k" },
        { id: "1m", label: "1M", isDefault: true },
      ],
      currentValue: "1m",
    },
  ],
});

describe("descriptor helpers", () => {
  it("applies selection values to capability descriptors", () => {
    expect(
      getProviderOptionDescriptors({
        caps: claudeCaps,
        selections: [
          { id: "effort", value: "medium" },
          { id: "contextWindow", value: "200k" },
        ],
      }),
    ).toEqual([
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
          { id: "ultrathink", label: "Ultrathink" },
        ],
        currentValue: "medium",
        promptInjectedValues: ["ultrathink"],
      },
      {
        id: "contextWindow",
        label: "Context Window",
        type: "select",
        options: [
          { id: "200k", label: "200k" },
          { id: "1m", label: "1M", isDefault: true },
        ],
        currentValue: "200k",
      },
    ]);
  });

  it("builds wire-format option selections from descriptors", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });

    expect(buildProviderOptionSelectionsFromDescriptors(descriptors)).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
  });

  it("stores option selection arrays in model selections", () => {
    expect(
      createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });
  });

  it("reads typed option selection values", () => {
    const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);

    expect(getProviderOptionStringSelectionValue(selection.options, "reasoningEffort")).toBe(
      "high",
    );
    expect(getProviderOptionStringSelectionValue(selection.options, "fastMode")).toBeUndefined();
    expect(getProviderOptionBooleanSelectionValue(selection.options, "fastMode")).toBe(true);
    expect(
      getProviderOptionBooleanSelectionValue(selection.options, "reasoningEffort"),
    ).toBeUndefined();
    expect(getModelSelectionStringOptionValue(selection, "reasoningEffort")).toBe("high");
    expect(getModelSelectionBooleanOptionValue(selection, "fastMode")).toBe(true);
  });
});

describe("model slug normalization", () => {
  it("preserves exact custom slugs instead of expanding provider aliases", () => {
    const claude = ProviderDriverKind.make("claudeAgent");

    expect(normalizeModelSlug("opus", claude)).toBe("claude-opus-5");
    expect(normalizeCustomModelSlug(" opus ")).toBe("opus");
  });
});

describe("applyProviderModelOptionDefaults", () => {
  const instanceId = ProviderInstanceId.make("codex");
  const descriptors = codexCaps.optionDescriptors ?? [];
  const defaults = { "gpt-5.4": [{ id: "reasoningEffort", value: "xhigh" as const }] };

  it("applies a configured default to an options-free selection", () => {
    const next = applyProviderModelOptionDefaults({
      selection: { instanceId, model: "gpt-5.4" },
      instanceId,
      modelOptionDefaults: defaults,
      descriptors,
    });

    expect(next.options).toEqual([{ id: "reasoningEffort", value: "xhigh" }]);
  });

  it("keeps explicit options and never overwrites them", () => {
    const selection = createModelSelection(instanceId, "gpt-5.4", [
      { id: "reasoningEffort", value: "low" },
    ]);

    expect(
      applyProviderModelOptionDefaults({
        selection,
        instanceId,
        modelOptionDefaults: defaults,
        descriptors,
      }),
    ).toBe(selection);
  });

  it("ignores a default stored for a different model or instance", () => {
    expect(
      applyProviderModelOptionDefaults({
        selection: { instanceId, model: "gpt-5.3-codex" },
        instanceId,
        modelOptionDefaults: defaults,
        descriptors,
      }).options,
    ).toBeUndefined();

    expect(
      applyProviderModelOptionDefaults({
        selection: { instanceId: ProviderInstanceId.make("codex_work"), model: "gpt-5.4" },
        instanceId,
        modelOptionDefaults: defaults,
        descriptors,
      }).options,
    ).toBeUndefined();
  });

  it("drops a stored value the live descriptors no longer advertise", () => {
    expect(
      applyProviderModelOptionDefaults({
        selection: { instanceId, model: "gpt-5.4" },
        instanceId,
        modelOptionDefaults: { "gpt-5.4": [{ id: "reasoningEffort", value: "galaxy" }] },
        descriptors,
      }).options,
    ).toBeUndefined();

    expect(
      applyProviderModelOptionDefaults({
        selection: { instanceId, model: "gpt-5.4" },
        instanceId,
        modelOptionDefaults: defaults,
        descriptors: [],
      }).options,
    ).toBeUndefined();
  });
});
