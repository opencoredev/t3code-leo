import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";

import { resolveNextFavoriteModel } from "./favoriteModelCycle";

const a = ProviderInstanceId.make("codex-default");
const b = ProviderInstanceId.make("piAgent-default");
const favorites = [
  { provider: a, model: "one" },
  { provider: b, model: "two" },
  { provider: a, model: "three" },
] as const;

describe("resolveNextFavoriteModel", () => {
  it("cycles in persisted order and wraps", () => {
    const isEligible = () => true;
    expect(resolveNextFavoriteModel({ favorites, current: favorites[0], isEligible })).toEqual(
      favorites[1],
    );
    expect(resolveNextFavoriteModel({ favorites, current: favorites[2], isEligible })).toEqual(
      favorites[0],
    );
  });

  it("starts at the first favorite when the current model is not a favorite", () => {
    expect(
      resolveNextFavoriteModel({
        favorites,
        current: { provider: a, model: "other" },
        isEligible: () => true,
      }),
    ).toEqual(favorites[0]);
  });

  it("skips ineligible favorites and returns null when none remain", () => {
    expect(
      resolveNextFavoriteModel({
        favorites,
        current: favorites[0],
        isEligible: (favorite) => favorite.provider === a,
      }),
    ).toEqual(favorites[2]);
    expect(
      resolveNextFavoriteModel({ favorites, current: favorites[0], isEligible: () => false }),
    ).toBeNull();
  });
});
