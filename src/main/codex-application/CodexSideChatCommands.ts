import * as Context from "effect/Context";
import type { CodexTurnPresentationClaim } from "./CodexTurnPresentation";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Clock from "effect/Clock";
import type { ClientRequestParamsByMethod } from "@nodex/effect-codex-app-server/rpc";
import type { ThreadForkParams, ThreadForkResponse } from "@nodex/codex-app-server-protocol/v2";
import { isCodexAgentBackendBinding } from "../../shared/agent-backend";
import type { CodexExecutionProfile } from "../../shared/codex-execution-profile";
import { normalizeCodexServiceTier } from "../../shared/codex-service-tier";
import type {
  CodexCanonicalConversationState,
  CodexSideChatStartInput,
  CodexSideChatStartResult,
  CodexThreadSummary,
} from "../../shared/types";
import {
  createCodexCanonicalHydratedConversationState,
  createCodexCanonicalWorkspacePermissionContext,
  resolveCodexCanonicalHydratedCwd,
} from "../../shared/codex-conversation-state/codex-conversation-state";
import { buildCodexThreadConfig } from "../codex/codex-thread-config";
import { DesktopToolRuntime } from "../host-runtime/DesktopToolRuntime";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import {
  CodexGateway,
  CodexThreadHostResolver,
  codexGatewayGenerationFence,
} from "../codex-runtime/CodexGateway";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import {
  CodexEphemeralThreadRouting,
  type CodexEphemeralThreadRoutingError,
} from "../codex-runtime/CodexEphemeralThreadRouting";
import type { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import {
  CodexTurnCommands,
  type CodexTurnCommandsError,
  type CodexTurnStartOverrides,
} from "./CodexTurnCommands";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { SIDE_CHAT_BOUNDARY_TEXT } from "./CodexSideChatPolicy";
import { SIDE_CHAT_DEVELOPER_INSTRUCTIONS } from "./CodexSideChatPolicy";
import { CodexConversationProjection } from "./CodexConversationProjection";
import { CodexGitProbe } from "./CodexGitProbe";
import { CodexThreadDirectory, type CodexThreadDirectoryEntry } from "./CodexThreadDirectory";
import { materializeCodexDesktopDeveloperInstructions } from "./CodexThreadRequestSettings";
import { ThreadCreationRuntime } from "./ThreadCreationRuntime";

type GatewayThreadForkParams = ClientRequestParamsByMethod["thread/fork"];
type GatewayThreadInjectItemsParams = ClientRequestParamsByMethod["thread/inject_items"];

interface CodexSideChatPlan {
  readonly parentThreadId: string;
  readonly parentGeneration: number | null;
  readonly forkRequest: ThreadForkParams;
  readonly parent: CodexThreadDirectoryEntry;
  readonly parentNavigationPath: string | null;
  readonly startedAt: number;
  readonly instructionModel: string | null;
  readonly initialTurn: {
    readonly prompt: string;
    readonly overrides: CodexTurnStartOverrides;
  } | null;
}

/** Live settings may clear reasoning or service tier without changing the stored profile. */
const canonicalExecutionProfile = (
  state: CodexCanonicalConversationState | null,
  fallback: CodexExecutionProfile | null,
): CodexExecutionProfile | null => {
  if (!state) return fallback;
  const hydration = state.hydrationContext;
  const settings = state.latestThreadSettings ?? hydration?.latestThreadSettings;
  const modelId =
    settings?.model?.trim() ||
    state.latestModel.trim() ||
    hydration?.latestModel.trim() ||
    hydration?.model.trim() ||
    fallback?.modelId;
  if (!modelId) return null;
  const effort = state.latestModel ? state.latestReasoningEffort : hydration?.latestReasoningEffort;
  return {
    modelId,
    reasoningEffort:
      settings?.effort !== undefined
        ? settings.effort
        : effort !== undefined
          ? effort
          : (fallback?.reasoningEffort ?? null),
    serviceTier:
      settings?.serviceTier !== undefined
        ? normalizeCodexServiceTier(settings.serviceTier)
        : (fallback?.serviceTier ?? null),
  };
};

export class CodexSideChatProjectionError extends Data.TaggedError("CodexSideChatProjectionError")<{
  readonly operation: "prepare" | "commit" | "finish" | "inspect" | "discard" | "rollback";
  readonly threadId: string;
  readonly cause: unknown;
}> {}

type CodexSideChatError =
  | CodexRuntimeError
  | CodexEphemeralThreadRoutingError
  | CodexTurnCommandsError
  | CodexSideChatProjectionError;

export interface CodexSideChatCommandsService {
  readonly start: (
    input: CodexSideChatStartInput,
    context?: {
      readonly presentationClaim?: CodexTurnPresentationClaim;
      readonly clientUserMessageId?: string;
    },
  ) => Effect.Effect<CodexSideChatStartResult, CodexSideChatError>;
  readonly discard: (threadId: string) => Effect.Effect<boolean, CodexSideChatError>;
}

export class CodexSideChatCommands extends Context.Service<
  CodexSideChatCommands,
  CodexSideChatCommandsService
>()("nodex/main/codex-application/CodexSideChatCommands") {}

export const make: Effect.Effect<
  CodexSideChatCommandsService,
  never,
  | CodexConversationProjection
  | CodexAppServerCapabilities
  | CodexGitProbe
  | CodexGateway
  | DesktopToolRuntime
  | CodexThreadHostResolver
  | CodexEphemeralThreadRouting
  | CodexThreadDirectory
  | ThreadCreationRuntime
  | CodexTurnCommands
  | ConversationEntityMap
  | ApplicationSettings
> = Effect.gen(function* () {
  const conversations = yield* ConversationEntityMap;
  const capabilities = yield* CodexAppServerCapabilities;
  const gitProbe = yield* CodexGitProbe;
  const gateway = yield* CodexGateway;
  const applicationSettings = yield* ApplicationSettings;
  const desktopTools = yield* DesktopToolRuntime;
  const hostResolver = yield* CodexThreadHostResolver;
  const routing = yield* CodexEphemeralThreadRouting;
  const turns = yield* CodexTurnCommands;
  const directory = yield* CodexThreadDirectory;
  const threadStarts = yield* ThreadCreationRuntime;
  const projection = yield* CodexConversationProjection;

  const prepare = Effect.fn("CodexSideChatCommands.prepare")(function* (
    input: CodexSideChatStartInput,
    context?: {
      readonly presentationClaim?: CodexTurnPresentationClaim;
      readonly clientUserMessageId?: string;
    },
  ): Effect.fn.Return<CodexSideChatPlan, CodexSideChatProjectionError> {
    const parentThreadId = input.parentThreadId.trim();
    if (!parentThreadId) {
      return yield* new CodexSideChatProjectionError({
        operation: "prepare",
        threadId: parentThreadId,
        cause: new Error("Side chat requires a parent Thread"),
      });
    }
    const currentParent = conversations.current(parentThreadId);
    const currentParentSnapshot = currentParent?.readSnapshot() ?? null;
    if (
      currentParent?.readCanonicalState()?.sideConversation === true ||
      currentParentSnapshot?.source?.sideConversation === true
    ) {
      return yield* new CodexSideChatProjectionError({
        operation: "prepare",
        threadId: parentThreadId,
        cause: new Error("Side chats cannot be started from another side chat"),
      });
    }
    const parent = yield* directory.resolve({ threadId: parentThreadId, fidelity: "durable" }).pipe(
      Effect.mapError(
        (cause) =>
          new CodexSideChatProjectionError({
            operation: "prepare",
            threadId: parentThreadId,
            cause,
          }),
      ),
    );
    const residentParent = conversations.current(parentThreadId);
    if (currentParent && residentParent?.generation !== currentParent.generation) {
      return yield* new CodexSideChatProjectionError({
        operation: "prepare",
        threadId: parentThreadId,
        cause: new Error("Side chat parent generation changed while reading context"),
      });
    }
    if (!parent) {
      return yield* new CodexSideChatProjectionError({
        operation: "prepare",
        threadId: parentThreadId,
        cause: new Error(`Parent Thread '${parentThreadId}' was not found`),
      });
    }
    if (!isCodexAgentBackendBinding(parent.durable.backendBinding)) {
      return yield* new CodexSideChatProjectionError({
        operation: "prepare",
        threadId: parentThreadId,
        cause: new Error("Side chats require a native Codex Thread"),
      });
    }
    // A resident canonical document supplies live context even without a presentation.
    const currentSnapshot =
      residentParent?.readSnapshot() ?? parent.snapshot ?? currentParentSnapshot;
    const canonical =
      residentParent?.readCanonicalState() ??
      parent.canonical ??
      currentSnapshot?.canonicalState ??
      null;
    if (
      canonical?.sideConversation === true ||
      currentSnapshot?.source?.sideConversation === true ||
      parent.summary.source?.sideConversation === true
    ) {
      return yield* new CodexSideChatProjectionError({
        operation: "prepare",
        threadId: parentThreadId,
        cause: new Error("Side chats cannot be started from another side chat"),
      });
    }
    const cwd =
      canonical?.cwd?.trim() ||
      canonical?.hydrationContext?.cwd?.trim() ||
      currentSnapshot?.cwd?.trim() ||
      parent.durable.cwd?.trim() ||
      "";
    if (!cwd) {
      return yield* new CodexSideChatProjectionError({
        operation: "prepare",
        threadId: parentThreadId,
        cause: new Error("Side chat requires a parent workspace"),
      });
    }
    const executionProfile = canonicalExecutionProfile(
      canonical,
      currentSnapshot?.executionProfile ?? parent.durable.executionProfile ?? null,
    );
    const runtimeWorkspaceRoots = canonical?.currentPermissions?.runtimeWorkspaceRoots?.length
      ? [...canonical.currentPermissions.runtimeWorkspaceRoots]
      : [cwd];
    const promptInput = input.promptInput
      ? { ...input.promptInput, text: input.prompt?.trim() ?? input.promptInput.text }
      : undefined;
    const hasInitialPrompt = Boolean(
      input.prompt?.trim() ||
      promptInput?.textAttachments?.length ||
      promptInput?.images?.length ||
      promptInput?.mentions?.length ||
      promptInput?.skills?.length ||
      promptInput?.commentAttachments?.length,
    );
    return {
      parentThreadId,
      parentGeneration: residentParent?.generation ?? null,
      parent: { ...parent, canonical, snapshot: currentSnapshot },
      parentNavigationPath: input.parentNavigationPath?.trim() || null,
      startedAt: yield* Clock.currentTimeMillis,
      instructionModel: input.model?.trim() || executionProfile?.modelId || null,
      forkRequest: {
        threadId: parentThreadId,
        path: null,
        cwd,
        runtimeWorkspaceRoots,
        threadSource: "user",
        ephemeral: true,
        excludeTurns: true,
      },
      initialTurn: hasInitialPrompt
        ? {
            prompt: input.prompt?.trim() ?? promptInput?.text ?? "",
            overrides: {
              presentationClaim: context?.presentationClaim,
              clientUserMessageId: context?.clientUserMessageId,
              promptInput,
              model: input.model,
              serviceTier:
                input.serviceTier !== undefined ? input.serviceTier : executionProfile?.serviceTier,
              permissionMode: input.permissionMode,
              reasoningEffort: input.reasoningEffort,
              collaborationMode: input.collaborationMode,
            },
          }
        : null,
    };
  });

  const acceptFork = Effect.fn("CodexSideChatCommands.acceptFork")(function* (
    plan: CodexSideChatPlan,
    response: ThreadForkResponse,
  ): Effect.fn.Return<CodexSideChatStartResult, CodexSideChatProjectionError> {
    const threadId = response.thread.id.trim();
    if (!threadId || threadId !== response.thread.id) {
      return yield* new CodexSideChatProjectionError({
        operation: "commit",
        threadId: plan.parentThreadId,
        cause: new Error("Thread fork did not return a valid Thread id"),
      });
    }
    const parentCwd = plan.forkRequest.cwd ?? plan.parent.durable.cwd ?? "/";
    const cwd =
      resolveCodexCanonicalHydratedCwd({
        requestedCwd: plan.forkRequest.cwd ?? null,
        responseCwd: response.cwd,
        threadCwd: response.thread.cwd,
        fallbackCwd: parentCwd,
      }) ?? parentCwd;
    const fallbackWorkspaceRoots = plan.forkRequest.runtimeWorkspaceRoots?.length
      ? plan.forkRequest.runtimeWorkspaceRoots
      : [cwd];
    const permissions = createCodexCanonicalWorkspacePermissionContext(fallbackWorkspaceRoots);
    const canonical: CodexCanonicalConversationState = {
      ...createCodexCanonicalHydratedConversationState(
        { ...response.thread, turns: [] },
        {
          hostId: plan.parent.durable.executionHostId,
          model: response.model,
          reasoningEffort: response.reasoningEffort,
          cwd,
          approvalPolicy: response.approvalPolicy,
          approvalsReviewer: response.approvalsReviewer,
          sandboxPolicy: response.sandbox,
          activePermissionProfile:
            response.activePermissionProfile ?? permissions.activePermissionProfile,
          runtimeWorkspaceRoots:
            response.runtimeWorkspaceRoots.length > 0
              ? [...response.runtimeWorkspaceRoots]
              : [...permissions.runtimeWorkspaceRoots],
          latestThreadSettings: {
            cwd,
            approvalPolicy: response.approvalPolicy,
            approvalsReviewer: response.approvalsReviewer,
            activePermissionProfile: response.activePermissionProfile,
            sandboxPolicy: response.sandbox,
            model: response.model,
            serviceTier: normalizeCodexServiceTier(response.serviceTier),
            effort: response.reasoningEffort,
            multiAgentMode: response.multiAgentMode,
          },
          pendingRequests: [],
          hasUnreadTurn: false,
        },
      ),
      ephemeral: true,
      sideConversation: true,
      workspaceKind:
        plan.parent.canonical?.workspaceKind ??
        (plan.parent.summary.projectId === null ? "projectless" : "project"),
      workspaceBrowserRoot:
        plan.parent.canonical?.workspaceBrowserRoot ??
        plan.parent.summary.projectlessWorkspaceBrowserRoot ??
        null,
    };
    const summary: CodexThreadSummary = {
      ...plan.parent.summary,
      threadId,
      projectId: canonical.workspaceKind === "projectless" ? null : plan.parent.summary.projectId,
      forkedFromId: plan.parentThreadId,
      source: {
        parentThreadId: plan.parentThreadId,
        sideConversation: true,
        sideConversationParentNavigationPath: plan.parentNavigationPath,
      },
      ephemeral: true,
      threadSource: "user",
      threadName: response.thread.name ?? null,
      threadPreview: response.thread.preview ?? "",
      cwd,
      statusType: "idle",
      statusActiveFlags: [],
      archived: false,
      hasUnreadTurn: false,
      createdAt: response.thread.createdAt * 1_000,
      updatedAt: response.thread.updatedAt * 1_000,
      recencyAt: response.thread.updatedAt * 1_000,
      linkedAt: new Date(plan.startedAt).toISOString(),
    };
    const conversation = yield* projection
      .hydrate({
        threadId,
        summary,
        canonical,
        pagination: {
          olderCursor: null,
          backwardsCursor: null,
          oldestLoadedTurnId: null,
          isLoadingOlder: false,
          hasLoadedOldest: true,
          loadedTurnCount: 0,
          itemsView: "full",
        },
        observedAtMs: yield* Clock.currentTimeMillis,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new CodexSideChatProjectionError({
              operation: "commit",
              threadId,
              cause,
            }),
        ),
      );
    const aggregate = conversations.entity(threadId);
    aggregate.setStreaming(true);
    return { parentThreadId: plan.parentThreadId, threadId, conversation };
  });

  const ignoreCleanupFailure = <A, E>(
    operation: string,
    threadId: string,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<void> =>
    effect.pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logWarning("Side chat cleanup step failed").pipe(
          Effect.annotateLogs({ operation, threadId, cause: String(cause) }),
        ),
      ),
    );

  const cleanup = (capability: CodexAppServerCapabilitySnapshot, threadId: string) =>
    Effect.all(
      [
        ignoreCleanupFailure(
          "unsubscribe",
          threadId,
          gateway.requestOnHost(
            capability.hostId,
            "thread/unsubscribe",
            { threadId },
            codexGatewayGenerationFence(capability),
          ),
        ),
        ignoreCleanupFailure("route-remove", threadId, routing.remove(threadId)),
        ignoreCleanupFailure("projection-rollback", threadId, conversations.retire(threadId)),
      ],
      { concurrency: 1, discard: true },
    );

  const capabilityFailure = (threadId: string, cause: unknown): CodexSideChatProjectionError =>
    new CodexSideChatProjectionError({ operation: "prepare", threadId, cause });

  const ensureCurrent = (plan: CodexSideChatPlan, snapshot: CodexAppServerCapabilitySnapshot) =>
    capabilities.isCurrent(snapshot).pipe(
      Effect.mapError((cause) => capabilityFailure(plan.parentThreadId, cause)),
      Effect.flatMap((current) =>
        current &&
        (plan.parentGeneration === null ||
          conversations.current(plan.parentThreadId)?.generation === plan.parentGeneration)
          ? Effect.void
          : Effect.fail(
              capabilityFailure(
                plan.parentThreadId,
                new Error(
                  current
                    ? "Side chat parent generation changed during fork"
                    : "Side chat host generation changed during fork",
                ),
              ),
            ),
      ),
    );

  const startPrepared = Effect.fn("CodexSideChatCommands.startPrepared")(function* (
    plan: CodexSideChatPlan,
    hostId: string,
    capability: CodexAppServerCapabilitySnapshot,
  ) {
    if (
      !capability.flags.paginatedHistory ||
      !capability.flags.ephemeralFork ||
      !capability.flags.sideConversation
    ) {
      return yield* capabilityFailure(
        plan.parentThreadId,
        new Error("Side chat requires bounded paginated ephemeral-fork support"),
      );
    }
    yield* ensureCurrent(plan, capability);
    const parentInstructions = yield* materializeCodexDesktopDeveloperInstructions(
      {
        hostId,
        cwd: plan.forkRequest.cwd ?? plan.parent.durable.cwd ?? "/",
        requestOptions: codexGatewayGenerationFence(capability),
      },
      applicationSettings,
      gateway,
      gitProbe,
    );
    if (!parentInstructions) {
      return yield* capabilityFailure(plan.parentThreadId, new Error("execution-config-loading"));
    }
    const developerInstructions = parentInstructions.trim()
      ? `${parentInstructions}\n\n${SIDE_CHAT_DEVELOPER_INSTRUCTIONS}`
      : SIDE_CHAT_DEVELOPER_INSTRUCTIONS;
    const desktopToolConfig =
      hostId === gateway.localHostId
        ? yield* desktopTools
            .threadConfig(plan.forkRequest.cwd ?? plan.parent.durable.cwd ?? "/")
            .pipe(Effect.mapError((cause) => capabilityFailure(plan.parentThreadId, cause)))
        : null;
    const config = buildCodexThreadConfig({
      nativeAppTools: capability.nativeAppTools,
      overrides: desktopToolConfig,
    });
    const response = (yield* gateway.requestOnHost(
      hostId,
      "thread/fork",
      {
        ...plan.forkRequest,
        ...(Object.keys(config).length > 0 ? { config } : {}),
        developerInstructions,
      } as GatewayThreadForkParams,
      codexGatewayGenerationFence(capability),
    )) as unknown as ThreadForkResponse;
    const threadId = response.thread.id.trim();
    if (!threadId || threadId !== response.thread.id) {
      return yield* new CodexSideChatProjectionError({
        operation: "commit",
        threadId: plan.parentThreadId,
        cause: new Error("Thread fork did not return a valid thread id"),
      });
    }
    // A returned fork needs compensation even when validation fails before route admission.
    return yield* Effect.acquireUseRelease(
      Effect.succeed(threadId),
      () =>
        Effect.gen(function* () {
          if (response.thread.historyMode !== "paginated" || response.thread.turns.length > 0) {
            return yield* capabilityFailure(
              plan.parentThreadId,
              new Error("Side chat fork returned inline or non-paginated history"),
            );
          }
          yield* ensureCurrent(plan, capability);
          yield* routing.register(threadId, hostId);
          yield* gateway.requestOnHost(
            hostId,
            "thread/inject_items",
            {
              threadId,
              items: [
                {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_text", text: SIDE_CHAT_BOUNDARY_TEXT }],
                },
              ],
            } as GatewayThreadInjectItemsParams,
            codexGatewayGenerationFence(capability),
          );
          yield* ensureCurrent(plan, capability);
          const result = yield* acceptFork(plan, response);
          if (plan.initialTurn) {
            yield* turns.start(
              result.threadId,
              plan.initialTurn.prompt,
              plan.initialTurn.overrides,
            );
          }
          return result;
        }),
      (acceptedThreadId, exit) =>
        Exit.isFailure(exit) ? cleanup(capability, acceptedThreadId) : Effect.void,
    );
  });

  const start: CodexSideChatCommandsService["start"] = (input, context) => {
    return prepare(input, context).pipe(
      Effect.flatMap((plan) =>
        hostResolver.resolve(plan.parentThreadId).pipe(
          Effect.flatMap((hostId) =>
            capabilities.forHost(hostId).pipe(
              Effect.mapError((cause) => capabilityFailure(plan.parentThreadId, cause)),
              Effect.flatMap((capability) =>
                threadStarts.materialize(
                  hostId,
                  capability.generation,
                  startPrepared(plan, hostId, capability),
                  (result) => result.threadId,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  };

  const discard: CodexSideChatCommandsService["discard"] = (rawThreadId) => {
    const threadId = rawThreadId.trim();
    if (!threadId) return Effect.succeed(false);
    return conversations
      .runCommand(
        threadId,
        Effect.sync(() => {
          const aggregate = conversations.current(threadId);
          const canonical = aggregate?.readCanonicalState();
          const source = aggregate?.readSnapshot()?.source;
          if (!(canonical?.sideConversation ?? source?.sideConversation)) return null;
          const parentThreadId =
            canonical?.forkedFromId ?? canonical?.parentThreadId ?? source?.parentThreadId;
          return parentThreadId ? { parentThreadId } : null;
        }).pipe(
          Effect.flatMap((sideChat) => {
            if (!sideChat) return Effect.succeed(false);
            const unsubscribe = routing.resolve(threadId).pipe(
              Effect.flatMap((ephemeralHostId) =>
                ephemeralHostId
                  ? Effect.succeed(ephemeralHostId)
                  : hostResolver.resolve(sideChat.parentThreadId),
              ),
              Effect.flatMap((hostId) =>
                capabilities
                  .forHost(hostId)
                  .pipe(
                    Effect.flatMap((capability) =>
                      gateway.requestOnHost(
                        hostId,
                        "thread/unsubscribe",
                        { threadId },
                        codexGatewayGenerationFence(capability),
                      ),
                    ),
                  ),
              ),
              Effect.catch((cause) =>
                Effect.logWarning("Failed to unsubscribe side chat").pipe(
                  Effect.annotateLogs({ threadId, cause: cause.message }),
                ),
              ),
            );
            return unsubscribe.pipe(
              Effect.onExit(() => routing.remove(threadId)),
              Effect.as(true),
            );
          }),
        ),
      )
      .pipe(
        Effect.tap((discarded) => (discarded ? conversations.retire(threadId) : Effect.void)),
        Effect.withSpan("CodexSideChatCommands.discard", { attributes: { threadId } }),
      );
  };

  return CodexSideChatCommands.of({
    start: (input, context) =>
      start(input, context).pipe(
        Effect.withSpan("CodexSideChatCommands.start", {
          attributes: { parentThreadId: input.parentThreadId },
        }),
      ),
    discard,
  });
});
