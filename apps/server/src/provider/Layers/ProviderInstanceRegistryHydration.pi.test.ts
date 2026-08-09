import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const decodeSettings = Schema.decodeSync(ServerSettings);

describe("Pi provider hydration", () => {
  it("hydrates the built-in Pi slot by default", () => {
    const config = deriveProviderInstanceConfigMap(decodeSettings({}));
    expect(config[ProviderInstanceId.make("piAgent")]).toEqual({
      driver: "piAgent",
      config: { enabled: true, binaryPath: "pi-acp", customModels: [] },
    });
  });

  it("hydrates an explicit Pi instance", () => {
    const config = deriveProviderInstanceConfigMap(
      decodeSettings({
        providerInstances: {
          pi_work: {
            driver: "piAgent",
            displayName: "Pi Work",
            config: { binaryPath: "/opt/pi/bin/pi-acp" },
          },
        },
      }),
    );
    expect(config[ProviderInstanceId.make("pi_work")]).toEqual({
      driver: "piAgent",
      displayName: "Pi Work",
      config: { binaryPath: "/opt/pi/bin/pi-acp" },
    });
  });
});
