import * as Context from "effect/Context";
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
  CodexCanonicalHydratedPermissionContext,
  CodexSideChatStartInput,
  CodexSideChatStartResult,
  CodexThreadSummary,
} from "../../shared/types";
import {
  createCodexCanonicalHydratedConversationState,
  createCodexCanonicalWorkspacePermissionContext,
  resolveCodexCanonicalHydratedCwd,
} from "../../shared/codex-conversation-state/codex-conversation-state";
import { buildCodexThreadConfigOverrides } from "../codex/codex-thread-capabilities";
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
import { CodexThreadDirectory, type CodexThreadDirectoryEntry } from "./CodexThreadDirectory";
import { requireExactThreadStartProfile } from "./codex-thread-start-profile";
import { ThreadCreationRuntime } from "./ThreadCreationRuntime";

type GatewayThreadForkParams = ClientRequestParamsByMethod["thread/fork"];
type GatewayThreadInjectItemsParams = ClientRequestParamsByMethod["thread/inject_items"];

interface CodexSideChatPlan {
  readonly parentThreadId: string;
  readonly forkRequest: ThreadForkParams;
  readonly parent: CodexThreadDirectoryEntry;
  readonly parentNavigationPath: string | null;
  readonly startedAt: number;
  readonly executionProfile: CodexExecutionProfile | null;
  readonly initialTurn: {
    readonly prompt: string;
    readonly overrides: CodexTurnStartOverrides;
  } | null;
}

const forkSandboxMode = (
  policy: CodexCanonicalHydratedPermissionContext["sandboxPolicy"],
): ThreadForkParams["sandbox"] => {
  if (policy.type === "dangerFullAccess") return "danger-full-access";
  if (policy.type === "readOnly") return "read-only";
  if (policy.type === "workspaceWrite") return "workspace-write";
  return null;
};

const forkPermissionOverrides = (
  context: CodexCanonicalHydratedPermissionContext | null,
): Pick<
  ThreadForkParams,
  "approvalPolicy" | "approvalsReviewer" | "permissions" | "runtimeWorkspaceRoots" | "sandbox"
> => {
  if (!context) return {};
  return {
    approvalPolicy: context.approvalPolicy,
    approvalsReviewer: context.approvalsReviewer,
    runtimeWorkspaceRoots: [...context.runtimeWorkspaceRoots],
    ...(context.activePermissionProfile
      ? { permissions: context.activePermissionProfile.id }
      : { sandbox: forkSandboxMode(context.sandboxPolicy) }),
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
  | CodexGateway
  | CodexThreadHostResolver
  | CodexEphemeralThreadRouting
  | CodexThreadDirectory
  | ThreadCreationRuntime
  | CodexTurnCommands
  | ConversationEntityMap
> = Effect.gen(function* () {
  const conversations = yield* ConversationEntityMap;
  const capabilities = yield* CodexAppServerCapabilities;
  const gateway = yield* CodexGateway;
  const hostResolver = yield* CodexThreadHostResolver;
  const routing = yield* CodexEphemeralThreadRouting;
  const turns = yield* CodexTurnCommands;
  const directory = yield* CodexThreadDirectory;
  const threadStarts = yield* ThreadCreationRuntime;
  const projection = yield* CodexConversationProjection;

  const prepare = Effect.fn("CodexSideChatCommands.prepare")(function* (
    input: CodexSideChatStartInput,
  ): Effect.fn.Return<CodexSideChatPlan, CodexSideChatProjectionError> {
    const parentThreadId = input.parentThreadId.trim();
    if (!parentThreadId) {
      return yield* new CodexSideChatProjectionError({
        operation: "prepare",
        threadId: parentThreadId,
        cause: new Error("Side chat requires a parent Thread"),
      });
    }
    const currentParentSnapshot = conversations.current(parentThreadId)?.readSnapshot() ?? null;
    if (currentParentSnapshot?.source?.sideConversation === true) {
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
    // Durable identity is sufficient to fork. A resident bounded projection may refine
    // live execution overrides, but its absence never implies complete or missing history.
    const currentSnapshot = parent.snapshot ?? currentParentSnapshot;
    if (
      currentSnapshot?.source?.sideConversation === true ||
      parent.summary.source?.sideConversation === true
    ) {
      return yield* new CodexSideChatProjectionError({
        operation: "prepare",
        threadId: parentThreadId,
        cause: new Error("Side chats cannot be started from another side chat"),
      });
    }
    const cwd = currentSnapshot?.cwd?.trim() || parent.durable.cwd?.trim() || "";
    if (!cwd) {
      return yield* new CodexSideChatProjectionError({
        operation: "prepare",
        threadId: parentThreadId,
        cause: new Error("Side chat requires a parent workspace"),
      });
    }
    const executionProfile = currentSnapshot?.executionProfile ?? parent.durable.executionProfile;
    const requestedExecutionProfile = executionProfile
      ? {
          ...executionProfile,
          modelId: input.model ?? executionProfile.modelId,
          reasoningEffort: input.reasoningEffort ?? executionProfile.reasoningEffort,
          serviceTier:
            input.serviceTier !== undefined
              ? normalizeCodexServiceTier(input.serviceTier)
              : executionProfile.serviceTier,
        }
      : null;
    const permissions =
      (parent.canonical ?? currentSnapshot?.canonicalState)?.sidecar.hydrationContext
        ?.currentPermissions ?? null;
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
      parent,
      parentNavigationPath: input.parentNavigationPath?.trim() || null,
      startedAt: yield* Clock.currentTimeMillis,
      executionProfile: requestedExecutionProfile,
      forkRequest: {
        threadId: parentThreadId,
        path: null,
        cwd,
        threadSource: "user",
        ...forkPermissionOverrides(permissions),
        config: {
          ...((input.reasoningEffort ?? executionProfile?.reasoningEffort)
            ? {
                model_reasoning_effort: input.reasoningEffort ?? executionProfile?.reasoningEffort,
              }
            : {}),
          ...buildCodexThreadConfigOverrides(),
        },
        developerInstructions: SIDE_CHAT_DEVELOPER_INSTRUCTIONS,
        ephemeral: true,
        excludeTurns: true,
        ...((input.model ?? executionProfile?.modelId)
          ? { model: input.model ?? executionProfile?.modelId }
          : {}),
        ...(executionProfile
          ? {
              serviceTier:
                input.serviceTier !== undefined ? input.serviceTier : executionProfile.serviceTier,
            }
          : {}),
      },
      initialTurn: hasInitialPrompt
        ? {
            prompt: input.prompt?.trim() ?? promptInput?.text ?? "",
            overrides: {
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
    const canonical = createCodexCanonicalHydratedConversationState(
      { ...response.thread, turns: [] },
      {
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
    );
    const summary: CodexThreadSummary = {
      ...plan.parent.summary,
      threadId,
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
        current
          ? Effect.void
          : Effect.fail(
              capabilityFailure(
                plan.parentThreadId,
                new Error("Side chat host generation changed during fork"),
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
    const response = (yield* gateway.requestOnHost(
      hostId,
      "thread/fork",
      plan.forkRequest as GatewayThreadForkParams,
      codexGatewayGenerationFence(capability),
    )) as unknown as ThreadForkResponse;
    if (response.thread.historyMode !== "paginated" || response.thread.turns.length > 0) {
      return yield* capabilityFailure(
        plan.parentThreadId,
        new Error("Side chat fork returned inline or non-paginated history"),
      );
    }
    yield* ensureCurrent(plan, capability);
    const threadId = response.thread.id.trim();
    if (!threadId || threadId !== response.thread.id) {
      return yield* new CodexSideChatProjectionError({
        operation: "commit",
        threadId: plan.parentThreadId,
        cause: new Error("Thread fork did not return a valid thread id"),
      });
    }
    yield* Effect.try({
      try: () => requireExactThreadStartProfile(response, plan.executionProfile),
      catch: (cause) => new CodexSideChatProjectionError({ operation: "commit", threadId, cause }),
    }).pipe(Effect.tapError(() => cleanup(capability, threadId)));
    return yield* Effect.acquireUseRelease(
      routing.register(threadId, hostId).pipe(Effect.as({ hostId, threadId })),
      () =>
        gateway
          .requestOnHost(
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
          )
          .pipe(
            Effect.andThen(ensureCurrent(plan, capability)),
            Effect.andThen(acceptFork(plan, response)),
            Effect.tap((result) =>
              plan.initialTurn
                ? turns
                    .start(result.threadId, plan.initialTurn.prompt, plan.initialTurn.overrides)
                    .pipe(Effect.asVoid)
                : Effect.void,
            ),
          ),
      (lease, exit) => (Exit.isFailure(exit) ? cleanup(capability, lease.threadId) : Effect.void),
    );
  });

  const start: CodexSideChatCommandsService["start"] = (input) => {
    return prepare(input).pipe(
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
          const source = conversations.current(threadId)?.readSnapshot()?.source;
          return source?.sideConversation === true && source.parentThreadId
            ? { parentThreadId: source.parentThreadId }
            : null;
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
    start: (input) =>
      start(input).pipe(
        Effect.withSpan("CodexSideChatCommands.start", {
          attributes: { parentThreadId: input.parentThreadId },
        }),
      ),
    discard,
  });
});
