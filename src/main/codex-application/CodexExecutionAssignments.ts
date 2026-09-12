import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { ConfigReadResponse } from "@nodex/codex-app-server-protocol/v2/ConfigReadResponse";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { release } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  applyCodexDefaultModeRequestUserInput,
  applyCodexGuardianV2Experiment,
  CODEX_EXECUTION_STATSIG_SDK_KEY,
  emptyCodexExecutionAssignmentValues,
  filterCodexExecutionFeaturesForAppServer,
  isCodexExecutionAssignmentValues,
  parseCodexExecutionInstructionOverrides,
  projectCodexExecutionFeaturesToThreadConfig,
  projectCodexExecutionMemoryPromptsToThreadConfig,
  type CodexExecutionAssignmentIdentity,
  type CodexExecutionAssignmentsPublication,
  type CodexExecutionAssignmentsSnapshot,
  type CodexExecutionInstructionOverrides,
  type CodexReadyExecutionAssignments,
  type CodexExecutionStatsigBootstrap,
  type CodexExecutionStatsigUser,
} from "../../shared/codex-execution-assignments";
import type { CodexGitSettings, CodexPersonality } from "../../shared/types";
import { resolveChatGptBaseUrl } from "../codex/chatgpt-base-url";
import { readThreadStateIdentity } from "../codex/thread-read-state-identity";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { ElectronApp } from "../platform/electron/ElectronApp";
import { MainConfig } from "../app/MainConfig";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { ChatGptDesktop } from "./ChatGptDesktop";
import { parseCodexPersonality } from "./CodexPersonality";

export interface CurrentExecutionIdentity {
  readonly principal: { readonly userId: string; readonly accountId: string } | null;
  readonly authMethod: string | null;
  readonly unauthenticatedStableId: string | null;
}

export interface CodexExecutionThreadDefaults extends CodexReadyExecutionAssignments {
  /** Version-filtered defaults projected into the app-server thread config namespace. */
  readonly config: Readonly<Record<string, unknown>>;
}

export interface CodexExecutionThreadSettings extends CodexExecutionThreadDefaults {
  readonly defaultPersonality: CodexPersonality;
  readonly gitSettings: CodexGitSettings;
  readonly instructionOverrides: CodexExecutionInstructionOverrides | null;
  readonly includeProseDetailLevelInstructions: boolean;
  readonly automaticTitleCheckpoints: boolean;
  readonly writingBlocks: boolean;
  readonly presentationOutlines: boolean;
}

const STATSIG_STATE_FILE = "statsig-state.json";
const STATSIG_STABLE_ID_KEY = "statsig-stable-id";
const TEST_EXECUTION_ASSIGNMENTS_ENV = "NODEX_TEST_CODEX_EXECUTION_ASSIGNMENTS";
type CodexTestExecutionAssignments = {
  readonly permissionRefresh: boolean;
  readonly threadQueue: boolean;
};

const isChatGptAuthMethod = (value: string | null): boolean =>
  value === "chatgpt" || value === "chatgptAuthTokens";

const systemName = (platform: string): string => {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  return platform;
};

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

const asNullableString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const readTestExecutionAssignments = (
  environment: Readonly<Record<string, string>>,
): CodexTestExecutionAssignments | null => {
  if (environment.NODE_ENV !== "test") return null;
  const encoded = environment[TEST_EXECUTION_ASSIGNMENTS_ENV];
  if (!encoded) return null;
  try {
    const value = asRecord(JSON.parse(encoded));
    if (!value) return null;
    const permissionRefresh = value.permissionRefresh;
    const threadQueue = value.threadQueue;
    if (typeof permissionRefresh !== "boolean" || typeof threadQueue !== "boolean") return null;
    return { permissionRefresh, threadQueue };
  } catch {
    return null;
  }
};

const samePublicationIdentity = (
  left: CodexExecutionAssignmentIdentity,
  right: CodexExecutionAssignmentIdentity,
): boolean =>
  left.userId === right.userId &&
  left.accountId === right.accountId &&
  left.authMethod === right.authMethod &&
  left.stableId === right.stableId;

const payloadMatchesPublicationIdentity = (
  publication: CodexExecutionAssignmentsPublication,
): boolean => {
  if (typeof publication.payload !== "string") return true;
  try {
    const payload = asRecord(JSON.parse(publication.payload));
    const user = asRecord(payload?.user);
    if (!user) return false;
    const customIds = asRecord(user.customIDs);
    const custom = asRecord(user.custom);
    return (
      asNullableString(user.userID) === publication.userId &&
      asNullableString(customIds?.account_id) === publication.accountId &&
      asNullableString(custom?.auth_method) === publication.authMethod &&
      asNullableString(customIds?.stableID) === publication.stableId
    );
  } catch {
    return false;
  }
};

const readStoredStableId = (statePath: string): string | null => {
  if (!existsSync(statePath)) return null;
  try {
    const record = asRecord(JSON.parse(readFileSync(statePath, "utf8")));
    const value = record?.[STATSIG_STABLE_ID_KEY];
    return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
  } catch {
    return null;
  }
};

const writeStoredStableId = (statePath: string, stableId: string): void => {
  const parent = dirname(statePath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  let current: Record<string, unknown> = {};
  if (existsSync(statePath)) {
    try {
      current = { ...(asRecord(JSON.parse(readFileSync(statePath, "utf8"))) ?? {}) };
    } catch {
      current = {};
    }
  }
  current[STATSIG_STABLE_ID_KEY] = stableId;
  const temporaryPath = join(parent, `.${basename(statePath)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(handle, JSON.stringify(current, null, 2), "utf8");
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  try {
    renameSync(temporaryPath, statePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
};

const readOrCreateStableId = (userDataPath: string): string => {
  const statePath = join(userDataPath, STATSIG_STATE_FILE);
  const stored = readStoredStableId(statePath);
  if (stored) return stored;
  const stableId = randomUUID();
  writeStoredStableId(statePath, stableId);
  return stableId;
};

export const codexExecutionAssignmentsTestHelpers = {
  readOrCreateStableId,
  statsigStateFile: STATSIG_STATE_FILE,
  statsigStableIdKey: STATSIG_STABLE_ID_KEY,
} as const;

const readBootstrapUser = (payload: string): CodexExecutionStatsigUser | null => {
  try {
    const parsed = asRecord(JSON.parse(payload));
    const user = asRecord(parsed?.user);
    return user ? (user as CodexExecutionStatsigUser) : null;
  } catch {
    return null;
  }
};

export function matchesExecutionAssignmentsIdentity(
  publication: CodexExecutionAssignmentIdentity,
  current: CurrentExecutionIdentity,
): boolean {
  if (current.principal) {
    return (
      publication.userId === current.principal.userId &&
      publication.accountId === current.principal.accountId
    );
  }
  if (current.authMethod === null) {
    return (
      current.unauthenticatedStableId !== null &&
      publication.userId === null &&
      publication.accountId === null &&
      publication.authMethod === null &&
      publication.stableId === current.unauthenticatedStableId
    );
  }
  if (isChatGptAuthMethod(current.authMethod)) return false;
  return publication.accountId === null && publication.authMethod === current.authMethod;
}

export function readPermissionRefreshFromPublication(
  publication: CodexExecutionAssignmentsPublication | null,
  current: CurrentExecutionIdentity,
): boolean | null {
  if (!publication || !matchesExecutionAssignmentsIdentity(publication, current)) return null;
  if (publication.payload === undefined) return null;
  if (publication.payload === null) return false;
  if (!payloadMatchesPublicationIdentity(publication)) return null;
  return typeof publication.executionValues?.permissionRefresh === "boolean"
    ? publication.executionValues.permissionRefresh
    : null;
}

export function readThreadQueueFromPublication(
  publication: CodexExecutionAssignmentsPublication | null,
  current: CurrentExecutionIdentity,
): boolean | null {
  if (!publication || !matchesExecutionAssignmentsIdentity(publication, current)) return null;
  if (publication.payload === undefined) return null;
  if (publication.payload === null) return false;
  if (!payloadMatchesPublicationIdentity(publication)) return null;
  return typeof publication.executionValues?.threadQueue === "boolean"
    ? publication.executionValues.threadQueue
    : null;
}

export function readReadyExecutionAssignmentsFromPublication(
  publication: CodexExecutionAssignmentsPublication | null,
  current: CurrentExecutionIdentity,
  appServerVersion?: string | null,
): CodexReadyExecutionAssignments | null {
  if (!publication || !matchesExecutionAssignmentsIdentity(publication, current)) return null;
  if (publication.payload === undefined) return null;
  const identity: CodexExecutionAssignmentIdentity = {
    userId: publication.userId,
    accountId: publication.accountId,
    authMethod: publication.authMethod,
    stableId: publication.stableId,
  };
  if (publication.payload === null) {
    return {
      identity,
      values: emptyCodexExecutionAssignmentValues(),
      defaultEnableFeatures: {},
    };
  }
  if (publication.sdkKey !== CODEX_EXECUTION_STATSIG_SDK_KEY) return null;
  if (!payloadMatchesPublicationIdentity(publication)) return null;
  if (!isCodexExecutionAssignmentValues(publication.executionValues)) return null;
  const publishedDefaults = asRecord(publication.defaultEnableFeatures);
  if (!publishedDefaults) return null;
  const defaultEnableFeatures =
    filterCodexExecutionFeaturesForAppServer(
      applyCodexGuardianV2Experiment(
        publishedDefaults,
        publication.executionValues.guardianV2Experiment,
        appServerVersion,
      ),
      appServerVersion,
    ) ?? {};
  return {
    identity,
    values: publication.executionValues,
    defaultEnableFeatures,
  };
}

export class CodexExecutionAssignments extends Context.Service<
  CodexExecutionAssignments,
  {
    readonly snapshot: SubscriptionRef.SubscriptionRef<CodexExecutionAssignmentsSnapshot>;
    readonly read: Effect.Effect<CodexExecutionAssignmentsSnapshot>;
    readonly readExecutionAssignments: (
      appServerVersion?: string | null,
    ) => Effect.Effect<CodexReadyExecutionAssignments | null>;
    readonly readThreadDefaults: (
      appServerVersion?: string | null,
    ) => Effect.Effect<CodexExecutionThreadDefaults | null>;
    readonly readThreadSettings: (input: {
      readonly appServerVersion?: string | null;
      readonly model?: string | null;
      readonly includeDeveloperInstructions: boolean;
      readonly allowMemoryPromptOverrides?: boolean;
    }) => Effect.Effect<CodexExecutionThreadSettings | null>;
    readonly bootstrap: Effect.Effect<CodexExecutionStatsigBootstrap>;
    readonly publish: (publication: CodexExecutionAssignmentsPublication) => Effect.Effect<void>;
  }
>()("nodex/main/codex-application/CodexExecutionAssignments") {}

export const live: Layer.Layer<
  CodexExecutionAssignments,
  never,
  ApplicationSettings | ChatGptDesktop | CodexGateway | ElectronApp | MainConfig
> = Layer.effect(
  CodexExecutionAssignments,
  Effect.gen(function* () {
    const chatgpt = yield* ChatGptDesktop;
    const gateway = yield* CodexGateway;
    const electron = yield* ElectronApp;
    const config = yield* MainConfig;
    const testExecutionAssignments = readTestExecutionAssignments(config.environment);
    const applicationSettings = yield* ApplicationSettings;
    const userDataPath = yield* electron.userDataPath;
    const stableId = yield* Effect.sync(() => readOrCreateStableId(userDataPath));
    const appSessionId = randomUUID();
    const locale = yield* electron.locale;
    const platformName = systemName(config.platform);
    const systemVersion = release();
    const publications = yield* SubscriptionRef.make<
      readonly CodexExecutionAssignmentsPublication[]
    >([]);
    const snapshot = yield* SubscriptionRef.make<CodexExecutionAssignmentsSnapshot>({
      permissionRefresh: testExecutionAssignments?.permissionRefresh ?? null,
      threadQueue: testExecutionAssignments?.threadQueue ?? null,
    });
    const identityEpoch = yield* Ref.make(0);

    const readAuth = chatgpt.authStatus(true, false).pipe(Effect.orElseSucceed(() => null));
    const readCurrentIdentity = Effect.gen(function* () {
      const status = yield* readAuth;
      const authMethod = status && typeof status.authMethod === "string" ? status.authMethod : null;
      const identity = status ? readThreadStateIdentity(status) : null;
      return {
        principal:
          identity?.kind === "chatgpt"
            ? { userId: identity.userId, accountId: identity.accountId }
            : null,
        authMethod,
        unauthenticatedStableId:
          authMethod === null && status?.requiresOpenaiAuth === false ? stableId : null,
      } satisfies CurrentExecutionIdentity;
    });

    const computeSnapshot = Effect.gen(function* () {
      if (testExecutionAssignments) return testExecutionAssignments;
      const epoch = yield* Ref.get(identityEpoch);
      const [published, current] = yield* Effect.all([
        SubscriptionRef.get(publications),
        readCurrentIdentity,
      ]);
      if ((yield* Ref.get(identityEpoch)) !== epoch)
        return { permissionRefresh: null, threadQueue: null };
      const matching = published.find((candidate) =>
        matchesExecutionAssignmentsIdentity(candidate, current),
      );
      return {
        permissionRefresh: readPermissionRefreshFromPublication(matching ?? null, current),
        threadQueue: readThreadQueueFromPublication(matching ?? null, current),
      } satisfies CodexExecutionAssignmentsSnapshot;
    });
    const readExecutionAssignments = (appServerVersion?: string | null) =>
      Effect.gen(function* () {
        const epoch = yield* Ref.get(identityEpoch);
        if (testExecutionAssignments) {
          const current = yield* readCurrentIdentity;
          if ((yield* Ref.get(identityEpoch)) !== epoch) return null;
          return {
            identity: {
              userId: current.principal?.userId ?? null,
              accountId: current.principal?.accountId ?? null,
              authMethod: current.authMethod,
              stableId,
            },
            values: {
              ...emptyCodexExecutionAssignmentValues(),
              permissionRefresh: testExecutionAssignments.permissionRefresh,
              threadQueue: testExecutionAssignments.threadQueue,
            },
            defaultEnableFeatures: {},
          } satisfies CodexReadyExecutionAssignments;
        }
        const [published, current] = yield* Effect.all([
          SubscriptionRef.get(publications),
          readCurrentIdentity,
        ]);
        if ((yield* Ref.get(identityEpoch)) !== epoch) return null;
        const matching = published.find((candidate) =>
          matchesExecutionAssignmentsIdentity(candidate, current),
        );
        const ready = readReadyExecutionAssignmentsFromPublication(
          matching ?? null,
          current,
          appServerVersion,
        );
        return (yield* Ref.get(identityEpoch)) === epoch ? ready : null;
      });
    const readThreadDefaults = (appServerVersion?: string | null) =>
      Effect.gen(function* () {
        const [assignments, settings] = yield* Effect.all([
          readExecutionAssignments(appServerVersion),
          applicationSettings.snapshot().pipe(Effect.orElseSucceed(() => null)),
        ]);
        if (!assignments || !settings) return null;
        const defaultEnableFeatures =
          applyCodexDefaultModeRequestUserInput(
            assignments.defaultEnableFeatures,
            settings.developer.defaultModeRequestUserInput,
          ) ?? {};
        return {
          ...assignments,
          defaultEnableFeatures,
          config: projectCodexExecutionFeaturesToThreadConfig(defaultEnableFeatures),
        } satisfies CodexExecutionThreadDefaults;
      });
    const readThreadSettings = (input: {
      readonly appServerVersion?: string | null;
      readonly model?: string | null;
      readonly includeDeveloperInstructions: boolean;
      readonly allowMemoryPromptOverrides?: boolean;
    }) =>
      Effect.gen(function* () {
        const [assignments, settings] = yield* Effect.all([
          readExecutionAssignments(input.appServerVersion),
          applicationSettings.snapshot().pipe(Effect.orElseSucceed(() => null)),
        ]);
        if (!assignments || !settings) return null;
        const defaultEnableFeatures =
          applyCodexDefaultModeRequestUserInput(
            assignments.defaultEnableFeatures,
            settings.developer.defaultModeRequestUserInput,
          ) ?? {};
        const instructionOverrides = input.model
          ? parseCodexExecutionInstructionOverrides(
              assignments.values.instructions[input.model] ?? {},
            )
          : null;
        const config = {
          ...projectCodexExecutionFeaturesToThreadConfig(defaultEnableFeatures),
          ...(input.allowMemoryPromptOverrides === true
            ? projectCodexExecutionMemoryPromptsToThreadConfig(instructionOverrides)
            : {}),
        };
        const writingBlocks = defaultEnableFeatures.writing_blocks === true;
        const includeProseDetailLevelInstructions =
          settings.developer.detailLevel === "STEPS_PROSE";
        return {
          ...assignments,
          defaultEnableFeatures,
          config,
          defaultPersonality:
            parseCodexPersonality(assignments.values.personality.default_personality) ?? "friendly",
          gitSettings: settings.git,
          instructionOverrides,
          includeProseDetailLevelInstructions,
          automaticTitleCheckpoints:
            input.includeDeveloperInstructions && assignments.values.automaticTitles,
          writingBlocks,
          presentationOutlines:
            input.includeDeveloperInstructions &&
            writingBlocks &&
            includeProseDetailLevelInstructions &&
            (assignments.values.presentationOutlinesTargeting ||
              assignments.values.presentationOutlines.enabled === true),
        } satisfies CodexExecutionThreadSettings;
      });
    const refreshSnapshot = computeSnapshot.pipe(
      Effect.flatMap((next) =>
        SubscriptionRef.modify(snapshot, (current) => [
          undefined,
          current.permissionRefresh === next.permissionRefresh &&
          current.threadQueue === next.threadQueue
            ? current
            : next,
        ]),
      ),
    );

    const retireIdentity = Ref.update(identityEpoch, (value) => value + 1).pipe(
      Effect.andThen(SubscriptionRef.set(snapshot, { permissionRefresh: null, threadQueue: null })),
    );
    yield* gateway.events.pipe(
      Stream.filter(
        (event) =>
          event.kind === "notification" &&
          event.hostId === gateway.localHostId &&
          event.value.method === "account/updated",
      ),
      Stream.runForEach(() => retireIdentity),
      Effect.forkScoped,
    );

    const buildFallbackUser = Effect.gen(function* () {
      const current = yield* readCurrentIdentity;
      const user: CodexExecutionStatsigUser = {
        ...(current.principal ? { userID: current.principal.userId } : {}),
        locale,
        appVersion: config.appVersion,
        customIDs: {
          stableID: stableId,
          ...(current.principal ? { account_id: current.principal.accountId } : {}),
        },
        custom: {
          auth_status: current.authMethod === null ? "logged_out" : "logged_in",
          ...(current.authMethod ? { auth_method: current.authMethod } : {}),
          ...(current.principal ? { account_id: current.principal.accountId } : {}),
          brand_name: "chatgpt",
          systemName: platformName,
          systemVersion,
          codex_window_type: "electron",
          codex_build_flavor: "prod",
          codex_app_session_id: appSessionId,
        },
      };
      if (
        !current.principal &&
        current.authMethod !== null &&
        !isChatGptAuthMethod(current.authMethod)
      )
        return { ...user, userID: `ua-${stableId}` } satisfies CodexExecutionStatsigUser;
      return user;
    });

    const readBootstrapPayload = Effect.gen(function* () {
      const status = yield* readAuth;
      const authMethod = status && typeof status.authMethod === "string" ? status.authMethod : null;
      if (!isChatGptAuthMethod(authMethod)) return null;
      const configResponse = yield* gateway.requestLocal("config/read", { includeLayers: false });
      const response = yield* chatgpt
        .request({
          action: "load execution settings",
          baseUrl: resolveChatGptBaseUrl(configResponse as ConfigReadResponse),
          path: "/wham/statsig/bootstrap",
          method: "POST",
          refreshOn401: true,
          headers: {
            "Content-Type": "application/json",
            "X-OpenAI-Attach-Auth": "1",
            "X-OpenAI-Attach-Integrity-State": "1",
            "OAI-Language": locale,
          },
          body: JSON.stringify({
            app_session_id: appSessionId,
            app_version: config.appVersion,
            brand_name: "chatgpt",
            build_flavor: "prod",
            locale,
            stable_id: stableId,
            system_name: platformName,
            system_version: systemVersion,
            window_type: "electron",
          }),
        })
        .pipe(Effect.timeoutOption(5_000));
      if (Option.isNone(response)) return null;
      if (!response.value.ok) return null;
      const decoded = yield* Effect.tryPromise(() => response.value.json()).pipe(
        Effect.orElseSucceed(() => null),
      );
      const record = asRecord(decoded);
      return typeof record?.statsigPayload === "string" ? record.statsigPayload : null;
    }).pipe(Effect.orElseSucceed(() => null));

    const bootstrap = Effect.gen(function* () {
      const [statsigPayload, fallbackUser] = yield* Effect.all([
        readBootstrapPayload,
        buildFallbackUser,
      ]);
      const payloadUser = statsigPayload ? readBootstrapUser(statsigPayload) : null;
      return {
        sdkKey: CODEX_EXECUTION_STATSIG_SDK_KEY,
        statsigPayload,
        user: payloadUser ?? fallbackUser,
      } satisfies CodexExecutionStatsigBootstrap;
    });

    return CodexExecutionAssignments.of({
      snapshot,
      read: computeSnapshot,
      readExecutionAssignments,
      readThreadDefaults,
      readThreadSettings,
      bootstrap,
      publish: (next) =>
        SubscriptionRef.update(publications, (current) => [
          next,
          ...current.filter((candidate) => !samePublicationIdentity(candidate, next)),
        ]).pipe(Effect.andThen(refreshSnapshot)),
    });
  }),
);
