import type { ProviderInstanceId } from "@t3tools/contracts";

export interface FavoriteModelRef {
  readonly provider: ProviderInstanceId;
  readonly model: string;
}

/** Returns the next eligible favorite in persisted favorite order. */
export function resolveNextFavoriteModel(input: {
  readonly favorites: ReadonlyArray<FavoriteModelRef>;
  readonly current: FavoriteModelRef;
  readonly isEligible: (favorite: FavoriteModelRef) => boolean;
}): FavoriteModelRef | null {
  const eligible = input.favorites.filter(input.isEligible);
  if (eligible.length === 0) return null;

  const currentIndex = eligible.findIndex(
    (favorite) =>
      favorite.provider === input.current.provider && favorite.model === input.current.model,
  );
  return eligible[(currentIndex + 1) % eligible.length] ?? null;
}
