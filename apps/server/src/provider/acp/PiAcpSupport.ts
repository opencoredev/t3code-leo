import {
  type PiSettings,
  type ProviderOptionSelection,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { getProviderOptionStringSelectionValue, normalizeModelSlug } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const PI_DRIVER_KIND = ProviderDriverKind.make("piAgent");
const PI_MODEL_CONFIG_ID = "model";
const PI_THINKING_CONFIG_ID = "thinkingLevel";

type PiAcpRuntimeSettings = Pick<PiSettings, "binaryPath">;

export interface PiAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly piSettings: PiAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildPiAcpSpawnInput(
  piSettings: PiAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: piSettings?.binaryPath || "pi-acp",
    args: [],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makePiAcpRuntime = (
  input: PiAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildPiAcpSpawnInput(input.piSettings, input.cwd, input.environment),
        authMethodId: "pi-stored-credentials",
        clientCapabilities: {
          elicitation: { form: {} },
        },
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function resolvePiAcpBaseModelId(model: string | null | undefined): string | undefined {
  return normalizeModelSlug(model, PI_DRIVER_KIND) ?? undefined;
}

export function currentPiModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  const currentValue = sessionSetupResult.configOptions?.find(
    (option) => option.id === PI_MODEL_CONFIG_ID && option.type === "select",
  )?.currentValue;
  return typeof currentValue === "string" ? currentValue.trim() || undefined : undefined;
}

interface PiModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntime.AcpSessionRuntime["Service"]["getConfigOptions"];
  readonly setModel: AcpSessionRuntime.AcpSessionRuntime["Service"]["setModel"];
  readonly setConfigOption: AcpSessionRuntime.AcpSessionRuntime["Service"]["setConfigOption"];
}

export function applyPiAcpModelSelection<E>(input: {
  readonly runtime: PiModelSelectionRuntime;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  return Effect.gen(function* () {
    let currentModelId = input.currentModelId;
    if (input.requestedModelId && input.requestedModelId !== currentModelId) {
      yield* input.runtime.setModel(input.requestedModelId).pipe(Effect.mapError(input.mapError));
      currentModelId = input.requestedModelId;
    }

    const requestedThinking = getProviderOptionStringSelectionValue(
      input.selections,
      PI_THINKING_CONFIG_ID,
    );
    if (requestedThinking) {
      const thinking = (yield* input.runtime.getConfigOptions).find(
        (option) => option.id === PI_THINKING_CONFIG_ID && option.type === "select",
      );
      if (thinking && thinking.currentValue !== requestedThinking) {
        yield* input.runtime
          .setConfigOption(PI_THINKING_CONFIG_ID, requestedThinking)
          .pipe(Effect.mapError(input.mapError));
      }
    }
    return currentModelId;
  });
}
