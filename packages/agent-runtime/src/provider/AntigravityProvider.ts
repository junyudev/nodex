import { resolveProviderProbeTimeoutMs } from "@nodex/provider-core/server/snapshotProbe";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ProviderDriverKind,
  type AntigravitySettings,
  type ProviderSetupError,
  type RuntimeMode,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
  type ServerProviderUsageLimits,
} from "@nodex/runtime-contracts";
import { createModelCapabilities } from "@nodex/runtime-shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberHandle from "effect/FiberHandle";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import type * as AcpSessionRuntime from "@nodex/provider-acp/server/AcpSessionRuntime";
import { parseSessionModeState } from "@nodex/provider-acp/server/runtimeModel";
import { acpProviderOptionDescriptors } from "@nodex/provider-acp/server/sessionConfig";
import {
  DeferringFailedCheck,
  makeManagedServerProvider,
} from "@nodex/provider-core/server/managedProvider";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
} from "@nodex/provider-core/server/maintenanceResolver";
import {
  buildServerProvider,
  isCommandMissingCause,
  type ServerProviderDraft,
} from "@nodex/provider-core/server/snapshotProbe";
import { resolveUsageLimitsAfterProbe } from "@nodex/provider-core/server/usageLimits";

import { antigravityThinkingConfig } from "./acp/AntigravityAcpSupport.ts";
import type { AntigravityStoredSignIn } from "./antigravityStoredSignIn.ts";

const MAX_WORKSPACE_SNAPSHOTS = 32;
const HEALTH_CHECK_TIMEOUT_MS = 90_000;
const SIGN_IN_MESSAGE = "Sign in with Google to use Antigravity.";
const AUTH_UNCHECKED_MESSAGE =
  "Antigravity is installed. Google account access is not checked yet.";
type SessionSetupResult = Pick<
  AcpSessionRuntime.AcpSessionRuntimeStartResult["sessionSetupResult"],
  "configOptions" | "models"
>;

type ThinkingConfig = NonNullable<ReturnType<typeof antigravityThinkingConfig>>;

/** Thinking options each model reported when selected; `null` means it has none. */
export type AntigravityThinkingLevels = ReadonlyMap<string, ThinkingConfig | null>;

function modelCapabilities(config: ThinkingConfig | null | undefined, supportsImages: boolean) {
  const descriptor = config
    ? acpProviderOptionDescriptors({ configOptions: [config], modeState: undefined })[0]
    : undefined;
  return createModelCapabilities({
    inputModalities: supportsImages ? ["text", "image"] : ["text"],
    optionDescriptors: descriptor?.type === "select" ? [{ ...descriptor, role: "reasoning" }] : [],
  });
}

export function buildAntigravityModelsFromSession(
  setup: SessionSetupResult,
  thinkingLevels: AntigravityThinkingLevels = new Map(),
  supportsImages = true,
): ReadonlyArray<ServerProviderModel> {
  const config = setup.configOptions?.find(
    (option) => option.id === "model" || option.category === "model",
  );
  const currentValue =
    config?.type === "select" ? config.currentValue : setup.models?.currentModelId;
  const entries =
    config?.type === "select"
      ? config.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options))
      : config === undefined
        ? (setup.models?.availableModels.map((model) => ({
            value: model.modelId,
            name: model.name,
          })) ?? [])
        : [];
  const currentThinking = antigravityThinkingConfig(setup.configOptions);
  const seen = new Set<string>();
  // The agent can list two IDs under one name; label the later ones so the picker tells them apart.
  const names = new Set<string>();
  return entries.flatMap((entry): ServerProviderModel[] => {
    if (!entry.value.trim() || seen.has(entry.value)) return [];
    seen.add(entry.value);
    const baseName = entry.name.trim() ? entry.name : entry.value;
    const name = names.has(baseName) ? `${baseName} (${entry.value})` : baseName;
    names.add(baseName);
    const observed =
      entry.value === currentValue ? (currentThinking ?? null) : thinkingLevels.get(entry.value);
    return [
      {
        slug: entry.value,
        name,
        isCustom: false,
        ...(entry.value === currentValue
          ? { isDefault: true, aliases: [ANTIGRAVITY_DEFAULT_MODEL] }
          : {}),
        capabilities: modelCapabilities(observed, supportsImages),
      },
    ];
  });
}

function nativeCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const seen = new Set<string>();
  return commands.flatMap((command): ServerProviderSlashCommand[] => {
    if (!command.name.trim() || seen.has(command.name)) return [];
    seen.add(command.name);
    const description = command.description.trim();
    const hint = command.input?.hint.trim();
    return [
      {
        name: command.name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
      },
    ];
  });
}

function isMissingInstallation(error: EffectAcpErrors.AcpError | ProviderSetupError): boolean {
  if (error._tag === "AcpSpawnError") {
    return (
      isCommandMissingCause(error.cause) ||
      (Predicate.isObject(error.cause) && error.cause.code === "ENOENT")
    );
  }
  return (
    error._tag === "ProviderSetupError" &&
    error.operation === "resolve" &&
    /not installed|missing|incomplete|changed on disk|does not publish/i.test(error.detail)
  );
}

interface AntigravityProviderState {
  readonly draft: ServerProviderDraft;
  readonly authRevision: number;
  readonly accountRevision: number;
}

interface AntigravityProviderOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly stampIdentity: (snapshot: ServerProviderDraft) => Effect.Effect<ServerProvider>;
  readonly probe: Effect.Effect<
    EffectAcpSchema.InitializeResponse,
    EffectAcpErrors.AcpError | ProviderSetupError
  >;
  readonly supportsTextGeneration: Effect.Effect<boolean>;
  readonly probeUsage?: (fileBacked: boolean) => Effect.Effect<ServerProviderUsageLimits>;
  readonly readPrivateSignIn?: Effect.Effect<AntigravityStoredSignIn>;
  readonly maintenanceCapabilities?: ProviderMaintenanceCapabilities;
  readonly auth?: { readonly type: string; readonly label: string };
  /**
   * This computer's sign-in, read with every check because agy in a terminal can sign in or out
   * at any time. Absent for a profile that keeps its own sign-in.
   */
  readonly storedSignIn?: Effect.Effect<AntigravityStoredSignIn>;
  /**
   * Loads the account's models after it is found signed in outside a Nodex sign-in, superseding a
   * load still running for an earlier sign-in.
   */
  readonly loadCatalog?: Effect.Effect<void>;
}

const RUNTIME_MODES_WITHOUT_AUTO = ["approval-required", "full-access"] as const;

/** Auto is offered only where the session advertises agy's own Auto; elsewhere it runs Supervised. */
function antigravityRuntimeModes(
  sessionSetupResult: AcpSessionRuntime.AcpSessionRuntimeStartResult["sessionSetupResult"],
): ReadonlyArray<RuntimeMode> {
  return parseSessionModeState(sessionSetupResult)?.availableModes.some(
    (mode) => mode.id === "auto",
  )
    ? ["approval-required", "auto", "full-access"]
    : RUNTIME_MODES_WITHOUT_AUTO;
}

export const makeAntigravityProvider = Effect.fn("makeAntigravityProvider")(function* (
  settings: AntigravitySettings,
  options: AntigravityProviderOptions,
) {
  const usesCredentials =
    options.auth?.type === "gemini-api-key" || options.auth?.type === "agent-platform";
  const signInMessage = usesCredentials
    ? `Connect with ${options.auth.label} to use Antigravity and load models.`
    : SIGN_IN_MESSAGE;
  const authUncheckedMessage = usesCredentials
    ? `Antigravity is installed. Connect with ${options.auth.label} to load models.`
    : AUTH_UNCHECKED_MESSAGE;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const initialDraft = {
    ...buildServerProvider({
      presentation: {
        displayName: "Antigravity",
        showInteractionModeToggle: false,
        supportedRuntimeModes: RUNTIME_MODES_WITHOUT_AUTO,
      },
      enabled: settings.enabled,
      checkedAt,
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown", ...(options.auth ? { type: options.auth.type } : {}) },
        message: settings.enabled
          ? "Checking Antigravity availability."
          : "Antigravity is disabled in Nodex settings.",
      },
    }),
    installationSource: settings.binaryPath
      ? { kind: "external" }
      : { kind: "managed", id: "antigravity" },
    setup: { canAuthenticate: true, canInstall: true },
    supportsConversationRollback: true,
    supportsTextGeneration: false,
    workspaceSnapshots: [],
  } satisfies ServerProviderDraft;
  const metadata = yield* SubscriptionRef.make<AntigravityProviderState>({
    draft: initialDraft,
    authRevision: 0,
    accountRevision: 0,
  });
  // Preserve disk-discovered skills when callbacks replace workspace commands; the registry will not rescan them.
  const discoveredSkills = new Map<string, ServerProvider["skills"]>();
  const thinkingLevels = new Map<string, ThinkingConfig | null>();
  const observeThinkingLevels = (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  ) => {
    const model = configOptions?.find(
      (option) => option.id === "model" || option.category === "model",
    );
    if (model?.type === "select" && model.currentValue) {
      thinkingLevels.set(model.currentValue, antigravityThinkingConfig(configOptions) ?? null);
    }
  };
  const getSnapshot = SubscriptionRef.get(metadata).pipe(
    Effect.flatMap((state) => options.stampIdentity(state.draft)),
  );

  const usageRead = yield* FiberHandle.make<void>();
  const usageFlight = yield* Semaphore.make(1);
  let accountEmail: string | undefined;
  // The stored sign-in checks last loaded models for. agy opens Google by itself for a
  // sign-in it cannot use, so checks only try to load models once for each stored sign-in.
  let catalogSignIn: string | undefined;
  // Addresses tell accounts apart when both sign-ins report one; otherwise only the sign-in can.
  const sharedAccountChanged = (
    signIn: Extract<AntigravityStoredSignIn, { status: "signed-in" }>,
  ) =>
    accountEmail !== undefined && signIn.email !== undefined
      ? accountEmail !== signIn.email
      : catalogSignIn !== undefined && catalogSignIn !== signIn.key;
  const withEmail = (auth: ServerProviderDraft["auth"]): ServerProviderDraft["auth"] =>
    accountEmail ? { ...auth, email: accountEmail } : auth;
  const scope = yield* Effect.scope;

  const clearAccountMetadata = Effect.fn("AntigravityProvider.clearAccountMetadata")(function* () {
    accountEmail = undefined;
    if (!settings.enabled) return;
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(
      metadata,
      (state) =>
        ({
          authRevision: state.authRevision + 1,
          accountRevision: state.accountRevision + 1,
          draft: {
            ...state.draft,
            auth: {
              status: "unauthenticated",
              ...(usesCredentials ? options.auth : {}),
            },
            status: "warning",
            message: signInMessage,
            checkedAt: updatedAt,
            models: [],
            slashCommands: [],
            skills: [],
            workspaceSnapshots: [],
            supportedRuntimeModes: RUNTIME_MODES_WITHOUT_AUTO,
            supportsTextGeneration: false,
            usageLimits: undefined,
          },
        }) satisfies AntigravityProviderState,
    );
    yield* FiberHandle.clear(usageRead);
    discoveredSkills.clear();
    thinkingLevels.clear();
  });

  const checkProvider = Effect.fn("checkAntigravityProvider")(function* () {
    if (!settings.enabled) return yield* getSnapshot;
    if (options.storedSignIn) {
      const signIn = yield* options.storedSignIn;
      const { auth } = (yield* SubscriptionRef.get(metadata)).draft;
      if (signIn.status === "signed-out") {
        catalogSignIn = undefined;
        if (auth.status !== "unauthenticated") yield* clearAccountMetadata();
      } else if (signIn.status === "signed-in") {
        const changed = sharedAccountChanged(signIn);
        if (changed) yield* clearAccountMetadata();
        accountEmail = signIn.email;
        if (!changed && auth.status === "authenticated" && auth.email !== signIn.email) {
          yield* SubscriptionRef.update(metadata, (state) => ({
            ...state,
            draft: { ...state.draft, auth: withEmail(state.draft.auth) },
          }));
        }
        const key = signIn.key;
        if (changed || (auth.status !== "authenticated" && key !== catalogSignIn)) {
          catalogSignIn = key;
          yield* Effect.forkIn(options.loadCatalog ?? Effect.void, scope);
        }
      }
    }
    const before = yield* SubscriptionRef.get(metadata);
    const timeoutMs = resolveProviderProbeTimeoutMs(
      "antigravity",
      HEALTH_CHECK_TIMEOUT_MS,
      options.environment,
    );
    const result = yield* options.probe.pipe(Effect.timeoutOption(timeoutMs), Effect.result);
    const initialized =
      Result.isSuccess(result) && Option.isSome(result.success) ? result.success.value : undefined;
    const version = initialized?.agentInfo?.version;
    const failure = Result.isFailure(result) ? result.failure : undefined;
    const missingInstallation = failure !== undefined && isMissingInstallation(failure);
    const errorMessage =
      initialized !== undefined
        ? undefined
        : failure?._tag === "ProviderSetupError"
          ? failure.detail.trim() || "Antigravity could not complete its local health check."
          : missingInstallation
            ? "Antigravity ACP runtime is not installed or its executable could not be found."
            : failure
              ? "Antigravity could not complete its local health check."
              : `Antigravity did not respond to its local health check within ${timeoutMs / 1_000} seconds.`;
    const supportsTextGeneration =
      initialized !== undefined ? yield* options.supportsTextGeneration : false;
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    const applyCheck = (state: AntigravityProviderState) => {
      if (state.authRevision !== before.authRevision) return state;
      const { message: _previousMessage, issue: _previousIssue, ...draft } = state.draft;
      const authenticated = draft.auth.status === "authenticated";
      const message =
        errorMessage ??
        (authenticated
          ? undefined
          : draft.auth.status === "unauthenticated"
            ? signInMessage
            : authUncheckedMessage);
      return {
        ...state,
        draft: {
          ...draft,
          installed: !missingInstallation,
          // Lightweight custom-launcher probes lack versions; preserve the real handshake's version.
          version: version === "unknown" ? draft.version : version || draft.version,
          status: errorMessage ? "error" : authenticated ? "ready" : "warning",
          ...(initialized === undefined && failure === undefined
            ? { issue: "unresponsive" as const }
            : {}),
          checkedAt: updatedAt,
          usageLimits: missingInstallation ? undefined : draft.usageLimits,
          ...(missingInstallation
            ? {
                models: [],
                slashCommands: [],
                skills: [],
                workspaceSnapshots: [],
                supportsTextGeneration: false,
              }
            : {}),
          ...(initialized !== undefined
            ? {
                supportsTextGeneration:
                  supportsTextGeneration && draft.auth.status !== "unauthenticated",
              }
            : {}),
          ...(message ? { message } : {}),
        },
      } satisfies AntigravityProviderState;
    };
    const deferFailure = errorMessage !== undefined && (yield* DeferringFailedCheck);
    const next = yield* SubscriptionRef.modifySome(metadata, (state) => {
      const checked = applyCheck(state);
      const stored = deferFailure && state.draft.status === "ready" ? state : checked;
      return [checked, stored === state ? Option.none() : Option.some(stored)];
    });
    return yield* options.stampIdentity(next.draft);
  });

  const maintenanceCapabilities =
    options.maintenanceCapabilities ??
    makeManualOnlyProviderMaintenanceCapabilities({
      provider: ProviderDriverKind.make("antigravity"),
      packageName: null,
    });
  const managed = yield* makeManagedServerProvider({
    resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
    getSettings: Effect.succeed(settings),
    streamSettings: Stream.empty,
    haveSettingsChanged: () => false,
    initialSnapshot: () => getSnapshot,
    checkProvider: checkProvider(),
    deferFailedPeriodicChecks: true,
    enrichmentOwnsUsageLimits: true,
    enrichSnapshot: ({ publishSnapshot }) =>
      SubscriptionRef.changes(metadata).pipe(
        Stream.runForEach(() => getSnapshot.pipe(Effect.flatMap(publishSnapshot))),
      ),
  });
  const readUsage = Effect.gen(function* () {
    if (!settings.enabled || !options.probeUsage) return;
    const { draft, accountRevision } = yield* SubscriptionRef.get(metadata);
    if (draft.status !== "ready" || draft.auth.status !== "authenticated") return;
    const signIn = yield* (
      options.storedSignIn ?? options.readPrivateSignIn ?? Effect.succeed(undefined)
    );
    if (options.storedSignIn && (signIn?.status !== "signed-in" || sharedAccountChanged(signIn)))
      return;
    if (options.readPrivateSignIn && !usesCredentials && signIn?.status !== "signed-in") return;
    if ((yield* SubscriptionRef.get(metadata)).accountRevision !== accountRevision) return;
    const probed = yield* options.probeUsage(
      signIn?.status === "signed-in" && signIn.fileBacked === true,
    );
    yield* SubscriptionRef.update(metadata, (state) =>
      state.accountRevision !== accountRevision
        ? state
        : {
            ...state,
            draft: {
              ...state.draft,
              usageLimits: resolveUsageLimitsAfterProbe({
                published: state.draft.usageLimits,
                probed,
              }),
            },
          },
    );
  });
  // The instance owns the single flight, so sign-out and instance disposal can interrupt it.
  const refreshUsage = usageFlight
    .withPermit(
      Effect.gen(function* () {
        const running = yield* FiberHandle.get(usageRead);
        return Option.isSome(running)
          ? running.value
          : yield* FiberHandle.run(usageRead, readUsage, { startImmediately: false });
      }),
    )
    .pipe(Effect.flatMap(Fiber.await), Effect.asVoid);

  const onSessionStarted = Effect.fn("AntigravityProvider.onSessionStarted")(function* (
    started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
    cwd?: string,
  ) {
    if (!settings.enabled) return;
    observeThinkingLevels(started.sessionSetupResult.configOptions);
    const before = yield* SubscriptionRef.get(metadata);
    const privateSignIn =
      before.draft.auth.status !== "authenticated"
        ? yield* options.readPrivateSignIn ?? Effect.succeed(undefined)
        : undefined;
    const supportsTextGeneration = yield* options.supportsTextGeneration;
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(metadata, (state) => {
      if (
        state.authRevision !== before.authRevision &&
        state.draft.auth.status === "unauthenticated"
      ) {
        return state;
      }
      if (privateSignIn?.status === "signed-in") accountEmail = privateSignIn.email;
      const { message: _previousMessage, ...draft } = state.draft;
      const workspaces = draft.workspaceSnapshots ?? [];
      const workspace = cwd ? workspaces.find((entry) => entry.cwd === cwd) : undefined;
      return {
        ...state,
        authRevision: state.authRevision + 1,
        draft: {
          ...draft,
          installed: true,
          status: "ready",
          version: started.initializeResult.agentInfo?.version || draft.version,
          auth: withEmail({
            status: "authenticated",
            type: options.auth?.type ?? "oauth-personal",
            label: options.auth?.label ?? "Google account",
          }),
          checkedAt: updatedAt,
          models: buildAntigravityModelsFromSession(
            started.sessionSetupResult,
            thinkingLevels,
            started.initializeResult.agentCapabilities?.promptCapabilities?.image === true,
          ),
          supportedRuntimeModes: antigravityRuntimeModes(started.sessionSetupResult),
          supportsTextGeneration,
          ...(cwd
            ? {
                workspaceSnapshots: [
                  ...workspaces.filter((entry) => entry.cwd !== cwd),
                  {
                    cwd,
                    checkedAt: updatedAt,
                    slashCommands: workspace?.slashCommands ?? draft.slashCommands,
                    skills: workspace?.skills ?? discoveredSkills.get(cwd) ?? [],
                  },
                ].slice(-MAX_WORKSPACE_SNAPSHOTS),
              }
            : {}),
        },
      } satisfies AntigravityProviderState;
    });
  });

  const onConfigOptionsUpdated = Effect.fn("AntigravityProvider.onConfigOptionsUpdated")(function* (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  ) {
    observeThinkingLevels(configOptions);
    yield* SubscriptionRef.update(metadata, (state) => {
      if (state.draft.auth.status !== "authenticated") return state;
      const supportsImages =
        state.draft.models[0]?.capabilities?.inputModalities?.includes("image") === true;
      const models = buildAntigravityModelsFromSession(
        { configOptions },
        thinkingLevels,
        supportsImages,
      );
      return { ...state, draft: { ...state.draft, models } };
    });
  });

  const onAvailableCommands = Effect.fn("AntigravityProvider.onAvailableCommands")(function* (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
    cwd?: string,
  ) {
    if (!settings.enabled) return;
    const slashCommands = nativeCommands(commands);
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(metadata, (state) => {
      if (state.draft.auth.status === "unauthenticated") return state;
      return {
        ...state,
        draft: {
          ...state.draft,
          slashCommands,
          ...(cwd
            ? {
                workspaceSnapshots: [
                  ...(state.draft.workspaceSnapshots ?? []).filter((entry) => entry.cwd !== cwd),
                  {
                    cwd,
                    checkedAt: updatedAt,
                    slashCommands,
                    skills:
                      state.draft.workspaceSnapshots?.find((entry) => entry.cwd === cwd)?.skills ??
                      discoveredSkills.get(cwd) ??
                      [],
                  },
                ].slice(-MAX_WORKSPACE_SNAPSHOTS),
              }
            : {}),
        },
      };
    });
  });

  const snapshotForCwd = Effect.fn("AntigravityProvider.snapshotForCwd")(function* (
    cwd: string,
    skills?: ServerProvider["skills"],
  ) {
    if (skills) {
      discoveredSkills.set(cwd, skills);
      yield* SubscriptionRef.update(metadata, (state) =>
        state.draft.workspaceSnapshots?.some((entry) => entry.cwd === cwd)
          ? {
              ...state,
              draft: {
                ...state.draft,
                workspaceSnapshots: state.draft.workspaceSnapshots.map((entry) =>
                  entry.cwd === cwd ? { ...entry, skills } : entry,
                ),
              },
            }
          : state,
      );
    }
    const snapshot = yield* getSnapshot;
    const workspace = snapshot.workspaceSnapshots?.find((entry) => entry.cwd === cwd);
    const resolvedSkills = skills ?? workspace?.skills ?? discoveredSkills.get(cwd) ?? [];
    return workspace
      ? { ...snapshot, slashCommands: workspace.slashCommands, skills: resolvedSkills }
      : { ...snapshot, skills: resolvedSkills };
  });

  return {
    snapshot: { ...managed, getSnapshot },
    onSessionStarted,
    onConfigOptionsUpdated,
    onAvailableCommands,
    refreshUsage,
    onSignedIn: clearAccountMetadata().pipe(
      Effect.andThen(
        Effect.gen(function* () {
          if (!options.storedSignIn) return;
          const signIn = yield* options.storedSignIn;
          if (signIn.status === "signed-in") {
            accountEmail = signIn.email;
            catalogSignIn = signIn.key;
          }
        }),
      ),
    ),
    onSignedOut: clearAccountMetadata(),
    onAuthRequired: clearAccountMetadata(),
    snapshotForCwd,
  };
});
