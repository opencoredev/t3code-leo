import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import { DRIVER_OPTION_BY_VALUE, DRIVER_OPTIONS } from "./providerDriverMeta";

describe("providerDriverMeta", () => {
  it("offers Pi as an addable provider with its annotated settings schema", () => {
    const pi = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("piAgent")];
    expect(DRIVER_OPTIONS).toContain(pi);
    expect(pi).toEqual(
      expect.objectContaining({
        value: "piAgent",
        label: "Pi",
        badgeLabel: "Early Access",
      }),
    );
    expect(pi?.settingsSchema.fields).toHaveProperty("binaryPath");
  });
});
