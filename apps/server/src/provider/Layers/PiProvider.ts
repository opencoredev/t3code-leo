import type {
  ModelCapabilities,
  PiSettings,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import { makePiAcpRuntime, resolvePiAcpBaseModelId } from "../acp/PiAcpSupport.ts";
import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";

const PI_PRESENTATION = {
  displayName: "Pi",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const PI_ACP_DISCOVERY_TIMEOUT_MS = 15_000;

function flattenSelectOptions(
  option: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<{ readonly value: string; readonly name: string }> {
  if (!option || option.type !== "select") return [];
  return option.options.flatMap((entry) =>
    "value" in entry
      ? [{ value: entry.value.trim(), name: entry.name.trim() }]
      : entry.options.map((nested) => ({ value: nested.value.trim(), name: nested.name.trim() })),
  );
}

export function buildPiCapabilitiesFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): ModelCapabilities {
  const thinking = configOptions.find(
    (option) => option.id === "thinkingLevel" && option.type === "select",
  );
  const choices = flattenSelectOptions(thinking);
  return createModelCapabilities({
    optionDescriptors:
      choices.length === 0
        ? []
        : [
            buildSelectOptionDescriptor({
              id: "thinkingLevel",
              label: thinking?.name.trim() || "Thinking level",
              options: choices.map((choice) => ({
                value: choice.value,
                label: choice.name || choice.value,
                isDefault: choice.value === thinking?.currentValue,
              })),
            }),
          ],
  });
}

function modelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): ReadonlyArray<ServerProviderModel> {
  const modelOption = configOptions.find(
    (option) => option.id === "model" && option.type === "select",
  );
  const capabilities = buildPiCapabilitiesFromConfigOptions(configOptions);
  return flattenSelectOptions(modelOption).flatMap((model) => {
    const slug = resolvePiAcpBaseModelId(model.value);
    return slug
      ? [
          {
            slug,
            name: model.name || slug,
            isCustom: false,
            capabilities,
          } satisfies ServerProviderModel,
        ]
      : [];
  });
}

function fallbackModels(settings: PiSettings): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings([], settings.customModels ?? [], EMPTY_CAPABILITIES);
}

export function buildInitialPiProviderSnapshot(
  settings: PiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: fallbackModels(settings),
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Pi ACP availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Pi is disabled in T3 Code settings.",
          },
    });
  });
}

const discoverPi = (settings: PiSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtime = yield* makePiAcpRuntime({
      piSettings: settings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    yield* runtime.start();
    return modelsFromConfigOptions(yield* runtime.getConfigOptions);
  }).pipe(Effect.scoped);

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  settings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallback = fallbackModels(settings);
  if (!settings.enabled) return yield* buildInitialPiProviderSnapshot(settings);

  const command = settings.binaryPath || "pi-acp";
  const versionResult = yield* Effect.gen(function* () {
    const spawn = yield* resolveSpawnCommand(command, ["--version"], { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawn.command, spawn.args, { env: environment, shell: spawn.shell }),
    );
  }).pipe(Effect.timeoutOption(4_000), Effect.result);

  if (Result.isFailure(versionResult)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallback,
      probe: {
        installed: !isCommandMissingCause(versionResult.failure),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(versionResult.failure)
          ? "Pi ACP (`pi-acp`) is not installed or not on PATH."
          : "Failed to execute Pi ACP health check.",
      },
    });
  }
  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallback,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi ACP timed out while running `pi-acp --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallback,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi ACP is installed but failed to run.",
      },
    });
  }

  const discovery = yield* discoverPi(settings, environment).pipe(
    Effect.timeoutOption(PI_ACP_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discovery)) {
    yield* Effect.logWarning("Pi ACP model discovery failed", {
      errorTag: causeErrorTag(discovery.cause),
    });
  }
  const models =
    Exit.isSuccess(discovery) && Option.isSome(discovery.value) ? discovery.value.value : fallback;
  const ready = Exit.isSuccess(discovery) && Option.isSome(discovery.value);
  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: true,
    checkedAt,
    models: models.length > 0 ? models : fallback,
    probe: {
      installed: true,
      version,
      status: ready ? "ready" : "error",
      auth: { status: "unknown" },
      ...(ready ? {} : { message: "Pi ACP startup failed. Check server logs for details." }),
    },
  });
});

export const enrichPiSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap(input.publishSnapshot),
    Effect.catchCause((cause) =>
      Effect.logWarning("Pi version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
