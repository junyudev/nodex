import type {
  PermissionResult,
  PermissionMode,
  UserDialogRequest,
  UserDialogResult,
  ElicitationRequest,
  ElicitationResult,
  SDKMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as RcMap from "effect/RcMap";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { z } from "zod";
import { isClaudeHistoryPrompt } from "../../../shared/claude-history";
import { createUuidV7 } from "../../../shared/uuid-v7";
import type { AgentBackendSessionChangedEvent } from "../../../shared/agent-backend-api";
import {
  isAgentConversationTaskLive,
  isAgentConversationTaskLiveInSnapshot,
  type AgentConversationSnapshot,
  type AgentConversationTurn,
  type AgentInteractionRequest,
  type AgentInteractionResponse,
  type AgentSessionConfigOption,
  type AgentSessionConfigSelectOption,
  type AgentSessionModeState,
  type AgentBackendCapabilityProfile,
  type AgentPromptImage,
} from "../../../shared/agent-conversation";
import type { ClaudeAgentInstanceConfig } from "../../../shared/types";
import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  nativeSessionCatalogTitle,
  type NativeSessionCatalogPage,
} from "../../../shared/native-session-catalog";
import { isAbsolute } from "node:path";
import { nativeSessionCwdAvailable } from "../../platform/node/NativeSessionCatalogPaths";
import { MainConfig } from "../../app/MainConfig";
import {
  claudeHistoryModel,
  claudeModelOptions,
  claudeSessionConfigOptions,
  validateClaudeSelection,
  normalizeClaudeSelection,
} from "./ClaudeModels";
import {
  claudeModelContext,
  claudeModelWithContext,
  isClaudeEffortLevel,
  type ClaudeModelSelection,
  type ClaudeRuntimeDiagnostics,
  type ClaudeDiscovery,
  type ClaudeResolvedIntelligence,
} from "../../../shared/claude-models";
import {
  ClaudeSdk,
  type ClaudeToolRequest,
  type ClaudeSdkSession,
  type ClaudeLaunchContext,
} from "../../platform/node/ClaudeSdk";
import { ApplicationSettings } from "../../settings/ApplicationSettings";
import { agentRuntimeError, type AgentRuntimeError } from "../AgentRuntimeError";
import type { AgentSessionHandle } from "../AgentSessionHandle";
import {
  applyAgentHistoryFacts,
  agentHistoryFactFromTurn,
  beginAgentConversationTurn,
  closeAgentConversation,
  completeAgentConversationTurn,
  diffAgentConversationSnapshots,
  emptyAgentConversationSnapshot,
  failAgentConversation,
  updateAgentSessionMetadata,
} from "../AgentConversationProjection";
import {
  createClaudeMessageProjection,
  beginClaudeAcceptedInputTurn,
  projectClaudeAcceptedInput,
  projectClaudeHistory,
  prependAgentHistory,
} from "./ClaudeConversationProjection";
import {
  claudeDiscoveryFingerprint,
  discoverClaudeSkills,
  probeClaudeVersion,
} from "../../platform/node/ClaudeDiscovery";
import { claudeEnvironment } from "../../platform/node/ClaudeSdk";
import * as Clock from "effect/Clock";
import { deriveClaudeTurnOutcome } from "./ClaudeEventHelpers";
import type {
  AgentSessionPermissionPolicy,
  NativeAgentExecutionLocation,
} from "../AgentSessionHandle";
import { unknownClaudeIntelligence } from "../../platform/node/ClaudeIntelligence";
import {
  applyCodexWorktreeShellEnvironment,
  type CodexStoredShellEnvironment,
} from "../../codex/codex-worktree-shell-environment";

export interface OpenClaudeSessionInput {
  readonly threadId: string;
  readonly instanceConfigId: string;
  readonly expectedHome?: string;
  readonly workspaceRoot: string;
  readonly workspaceEnvironment?: CodexStoredShellEnvironment | null;
  readonly sessionId?: string;
  readonly everSaved?: boolean;
  readonly executionRecoveryRequired?: boolean;
  readonly permissionPolicy: AgentSessionPermissionPolicy;
  readonly model?: string | null;
  readonly effort?: string | null;
  readonly interactionMode?: "default" | "plan";
  readonly fast?: boolean;
  readonly thinking?: boolean;
  readonly context?: string;
  readonly restoredTurns?: readonly AgentConversationTurn[];
  readonly launchContext?: ClaudeLaunchContext;
  readonly acquireLaunchContext?: (
    workspaceRoot: string,
  ) => Effect.Effect<ClaudeLaunchContext, AgentRuntimeError, Scope.Scope>;
  readonly historyFacts?: Parameters<typeof applyAgentHistoryFacts>[1];
  readonly isUnattended?: Effect.Effect<boolean>;
  readonly readPermissionPolicy?: Effect.Effect<AgentSessionPermissionPolicy, AgentRuntimeError>;
  readonly onBackgroundTasksChanged?: (
    liveTaskIds: readonly string[],
  ) => Effect.Effect<void, AgentRuntimeError>;
  readonly onTurnAdmitted?: (input: {
    readonly sequence: number;
    readonly clientUserMessageId: string;
    readonly text: string;
  }) => Effect.Effect<void, AgentRuntimeError>;
  readonly onTurnSettled?: (input: {
    readonly sequence: number;
    readonly clientUserMessageIds: readonly string[];
    readonly stopReason: string;
    readonly status: "completed" | "cancelled" | "failed";
    readonly error?: string;
    readonly nativeSessionId: string;
    readonly everSaved: boolean;
  }) => Effect.Effect<void, AgentRuntimeError>;
  readonly onSessionIdentityChanged?: (input: {
    readonly previousSessionId: string;
    readonly sessionId: string;
    readonly reason: "reset" | "rollback";
    readonly everSaved?: boolean;
    readonly messageIdMap?: Readonly<Record<string, string>>;
  }) => Effect.Effect<void, AgentRuntimeError>;
}
export class ClaudeSessionManager extends Context.Service<
  ClaudeSessionManager,
  {
    readonly nativeHome: (instanceConfigId: string) => Effect.Effect<string, AgentRuntimeError>;
    readonly nativeCatalog: (input: {
      readonly instanceConfigId: string;
      readonly cursor?: string;
    }) => Effect.Effect<NativeSessionCatalogPage, AgentRuntimeError>;
    readonly nativeSessionInfo: (input: {
      readonly instanceConfigId: string;
      readonly nativeSessionId: string;
      readonly expectedHome: string;
    }) => Effect.Effect<
      SDKSessionInfo & { readonly cwd: string; readonly nativeHome: string },
      AgentRuntimeError
    >;
    readonly models: (
      instanceConfigId: string,
      workspaceRoot: string,
      forceReload?: boolean,
    ) => Effect.Effect<readonly AgentSessionConfigSelectOption[], AgentRuntimeError>;
    readonly discover: (
      instanceConfigId: string,
      location: NativeAgentExecutionLocation,
      forceReload?: boolean,
    ) => Effect.Effect<ClaudeDiscovery, AgentRuntimeError>;
    readonly open: (
      input: OpenClaudeSessionInput,
    ) => Effect.Effect<AgentSessionHandle, AgentRuntimeError>;
    readonly get: (threadId: string) => Effect.Effect<AgentSessionHandle | null>;
    readonly close: (threadId: string) => Effect.Effect<void>;
    readonly observe: (threadId: string) => Effect.Effect<void>;
    readonly unobserve: (threadId: string) => Effect.Effect<void>;
    readonly changes: Stream.Stream<AgentBackendSessionChangedEvent>;
  }
>()("nodex/main/agent-backend/claude/ClaudeSessionManager") {}
const failure = (
  operation: string,
  cause: unknown,
  reason: AgentRuntimeError["reason"] = "request",
) => agentRuntimeError({ operation: `Claude ${operation}`, reason, retryable: false, cause });
const Questions = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(1).max(8192),
        header: z.string().max(256).optional(),
        multiSelect: z.boolean().optional(),
        options: z
          .array(
            z.object({
              label: z.string().min(1).max(1024),
              description: z.string().max(8192).optional(),
            }),
          )
          .max(16),
      }),
    )
    .min(1)
    .max(8),
});
export const liveClaudeBackgroundTaskIds = (
  snapshot: AgentConversationSnapshot,
): readonly string[] =>
  snapshot.liveBackgroundTaskIds ??
  snapshot.tasks?.filter(isAgentConversationTaskLive).map(({ id }) => id) ??
  [];
export const hasLiveClaudeBackground = (snapshot: AgentConversationSnapshot): boolean =>
  liveClaudeBackgroundTaskIds(snapshot).length > 0;

const capabilities: AgentBackendCapabilityProfile = {
  prompt: { text: true, resourceLink: true, image: true, audio: false, embeddedContext: false },
  session: {
    load: true,
    list: false,
    delete: false,
    resume: true,
    unstableFork: true,
    close: true,
    additionalDirectories: true,
  },
  controls: { steer: true, compact: true, rollback: true, fork: true, stopTask: true },
  authMethods: [
    {
      id: "reconnect",
      name: "Reconnect",
      description: "Reconnect using this Claude instance after updating its credentials.",
      kind: "agent",
    },
  ],
};
const MAX_KNOWN_CLIENT_MESSAGE_IDS = 1024;
const inputImageDescriptors = (messageId: string, images: readonly AgentPromptImage[] = []) =>
  images.map((image, index) => ({
    nativeMessageId: messageId,
    index,
    mediaType: image.mediaType,
  }));
const CLAUDE_ACCOUNT_ENVIRONMENT_NAMES = new Set(["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR"]);
/** Worktree setup cannot select a different Claude account; explicit profile values win. */
const claudeLaunchEnvironment = (
  config: Pick<MainConfig["Service"], "environment" | "platform">,
  workspaceEnvironment: CodexStoredShellEnvironment | null | undefined,
  environmentOverrides: Readonly<Record<string, string>>,
) => {
  const environment = applyCodexWorktreeShellEnvironment(
    config.environment,
    workspaceEnvironment,
    config.platform,
  );
  return applyCodexWorktreeShellEnvironment(
    {
      ...Object.fromEntries(
        Object.entries(environment).filter(
          ([name]) => !CLAUDE_ACCOUNT_ENVIRONMENT_NAMES.has(name.toUpperCase()),
        ),
      ),
      ...Object.fromEntries(
        Object.entries(config.environment).filter(([name]) =>
          CLAUDE_ACCOUNT_ENVIRONMENT_NAMES.has(name.toUpperCase()),
        ),
      ),
    },
    { version: 1, set: environmentOverrides, exclude: [] },
    config.platform,
  );
};
const nativePermissionMode = (
  mode: "default" | "plan",
  policy: AgentSessionPermissionPolicy,
): PermissionMode =>
  mode === "plan" ? "plan" : policy === "full-access" ? "bypassPermissions" : "default";

const makeSession = Effect.fn("ClaudeSessionManager.session")(function* (
  input: OpenClaudeSessionInput,
  instance: ClaudeAgentInstanceConfig,
  environmentOverrides: Readonly<Record<string, string>>,
) {
  const sdk = yield* ClaudeSdk;
  const config = yield* MainConfig;
  const ownerScope = yield* Scope.Scope;
  const controls = yield* Semaphore.make(1);
  let sessionId = input.sessionId ?? createUuidV7();
  let everSaved = Boolean(input.sessionId && input.everSaved !== false);
  const executionInput = (location: NativeAgentExecutionLocation) => ({
    instance,
    environment: claudeLaunchEnvironment(
      config,
      location.workspaceEnvironment,
      environmentOverrides,
    ),
    cwd: location.workspaceRoot,
    ...(input.launchContext ? { launchContext: input.launchContext } : {}),
  });
  let baseInput = executionInput(input);
  const nativeInput = () => ({ ...baseInput, sessionId, resume: everSaved });
  // A crash can precede Core's first saved-turn observation; native metadata owns existence.
  if (input.sessionId && !everSaved) everSaved = yield* sdk.hasSession(nativeInput());
  let initial = emptyAgentConversationSnapshot({
    backend: "claude",
    threadId: input.threadId,
    sessionId,
  });
  const historyPage = everSaved
    ? yield* sdk.historyPage(nativeInput())
    : { messages: [], before: null, hasMore: false };
  const history = historyPage.messages;
  if (everSaved) initial = projectClaudeHistory(initial, history);
  const restoredFacts =
    input.historyFacts ??
    (input.restoredTurns ?? []).flatMap((turn) => {
      const fact = agentHistoryFactFromTurn(turn);
      return fact ? [fact] : [];
    });
  initial = applyAgentHistoryFacts(initial, restoredFacts);
  // Recent turn identities belong to the Thread owner, including turns removed by a native reset
  // or rollback. Core remains the durable authority for identities beyond this bounded window.
  const knownClientMessageIds = new Set<string>();
  const rememberClientMessageId = (id: string) => {
    knownClientMessageIds.delete(id);
    knownClientMessageIds.add(id);
    if (knownClientMessageIds.size > MAX_KNOWN_CLIENT_MESSAGE_IDS)
      knownClientMessageIds.delete(knownClientMessageIds.values().next().value!);
  };
  const rememberHistoryTurnIds = (turns: readonly AgentConversationTurn[]) => {
    for (const entry of turns.slice(-MAX_KNOWN_CLIENT_MESSAGE_IDS))
      if (entry.clientUserMessageId) rememberClientMessageId(entry.clientUserMessageId);
  };
  const rememberNativeHistoryIds = (messages: readonly SessionMessage[]) => {
    for (const entry of messages.slice(-MAX_KNOWN_CLIENT_MESSAGE_IDS))
      if (isClaudeHistoryPrompt(entry)) rememberClientMessageId(entry.uuid);
  };
  for (const fact of restoredFacts.slice(-MAX_KNOWN_CLIENT_MESSAGE_IDS))
    rememberClientMessageId(fact.clientUserMessageId);
  rememberHistoryTurnIds(input.restoredTurns ?? []);
  rememberNativeHistoryIds(history);
  rememberHistoryTurnIds(initial.turns);
  initial = {
    ...initial,
    history: {
      hasOlder: historyPage.hasMore || Boolean(initial.history?.hasOlder),
      oldestSequence: initial.turns[0]?.sequence ?? null,
      ...(initial.history?.hasOlder
        ? { cursor: initial.history.cursor }
        : historyPage.before
          ? { cursor: historyPage.before }
          : {}),
    },
  };
  let requested: ClaudeModelSelection = {
    model: input.model ?? "default",
    effort: isClaudeEffortLevel(input.effort) ? input.effort : "default",
    ...(input.fast !== undefined ? { fast: input.fast } : {}),
    ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
    ...(input.context ? { context: input.context } : {}),
  };
  let effective: ClaudeResolvedIntelligence & { permissionMode?: string } = {
    ...unknownClaudeIntelligence(),
    model: claudeHistoryModel(history) ?? null,
    effort: null,
  };
  let requestedMode: "default" | "plan" = input.interactionMode ?? "default";
  let modes: AgentSessionModeState = {
    currentModeId: requestedMode,
    availableModes: [
      { id: "default", name: "Code", description: null },
      { id: "plan", name: "Plan", description: null },
    ],
  };
  let policy = input.permissionPolicy;
  let observedVersion: string | null = null;
  let observedCapabilities: readonly string[] = [];
  let healthError: string | null = null;
  let commands: NonNullable<AgentConversationSnapshot["metadata"]>["commands"] = [];
  const queuedSteers = new Map<
    string,
    { readonly text: string; readonly images?: readonly AgentPromptImage[] }
  >();
  let configOptions: readonly AgentSessionConfigOption[] = [];
  let runtime: ClaudeSdkSession | null = null;
  let runtimeScope: Scope.Closeable | null = null;
  let runtimeSuspended = input.executionRecoveryRequired === true;
  let executionHandoff = false;
  let executionRecoveryRequired = input.executionRecoveryRequired === true;
  let generation = 0;
  let active = true;
  let sequence = Math.max(0, ...initial.turns.map((entry) => entry.sequence ?? 0));
  let turn: {
    sequence: number;
    /** Native consumption echoes cannot replace the foreground authority admitted by Main. */
    readonly authorityTurnId: string;
    completion: Deferred.Deferred<{ stopReason: string }, AgentRuntimeError>;
    cancelled: boolean;
    messageIds: Set<string>;
    authenticationFailure: string | null;
    sent: boolean;
  } | null = null;
  const snapshot = yield* SubscriptionRef.make(initial);
  const pending = new Map<
    string,
    { request: AgentInteractionRequest; completion: Deferred.Deferred<AgentInteractionResponse> }
  >();
  const publishMetadata = () =>
    Effect.sync(() => {
      configOptions = claudeSessionConfigOptions(
        runtime?.models ?? [],
        effective,
        instance.customModels,
      );
    }).pipe(
      Effect.andThen(
        SubscriptionRef.update(snapshot, (current) =>
          updateAgentSessionMetadata(current, {
            configOptions,
            modes,
            capabilities,
            requestedSelection: requested,
            requestedMode,
            effectiveSelection: effective,
            permissionMode:
              policy === "full-access"
                ? "full-access"
                : policy === "approve-for-me"
                  ? "guardian-approvals"
                  : "auto",
            commands,
            ...(current.metadata?.diagnostics ? { diagnostics: current.metadata.diagnostics } : {}),
          }),
        ),
      ),
    );
  const patchRequests = () =>
    SubscriptionRef.update(snapshot, (current) => ({
      ...current,
      revision: current.revision + 1,
      requests: (current.requests ?? []).filter(({ id }) => pending.has(id)),
    }));
  const cancelRequests = Effect.fn("ClaudeSessionManager.cancelRequests")(function* (
    foregroundOnly = false,
  ) {
    for (const [id, { request, completion }] of pending) {
      if (foregroundOnly && (request.actor?.agentId || request.actor?.taskId)) continue;
      yield* Deferred.succeed(completion, { decision: "deny" });
      pending.delete(id);
    }
    yield* patchRequests();
  });
  const awaitInteraction = Effect.fn("ClaudeSessionManager.awaitInteraction")(function* (
    request: Omit<AgentInteractionRequest, "id">,
  ) {
    if (!active || pending.size >= 16) return { decision: "deny" } as const;
    const id = createUuidV7();
    const completion = yield* Deferred.make<AgentInteractionResponse>();
    const entry = { ...request, id };
    pending.set(id, { request: entry, completion });
    yield* SubscriptionRef.update(snapshot, (current) => ({
      ...current,
      revision: current.revision + 1,
      requests: [...(current.requests ?? []), entry],
    }));
    return yield* Deferred.await(completion).pipe(
      Effect.ensuring(Effect.sync(() => pending.delete(id)).pipe(Effect.andThen(patchRequests()))),
    );
  });
  const canUseTool = Effect.fn("ClaudeSessionManager.canUseTool")(function* (
    request: ClaudeToolRequest,
  ): Effect.fn.Return<PermissionResult, AgentRuntimeError> {
    if (!active) return { behavior: "deny", message: "The session has closed." };
    if (input.isUnattended && (yield* input.isUnattended))
      return { behavior: "deny", message: "This execution cannot wait for user input." };
    const currentPolicy = input.readPermissionPolicy ? yield* input.readPermissionPolicy : policy;
    if (
      request.name !== "AskUserQuestion" &&
      (currentPolicy === "approve-for-me" || currentPolicy === "full-access") &&
      !request.defaultToNo
    )
      return { behavior: "allow", updatedInput: request.input };
    const questions =
      request.name === "AskUserQuestion" ? Questions.safeParse(request.input) : null;
    if (questions && !questions.success)
      return { behavior: "deny", message: "Claude sent an unsupported question format." };
    const allowForSession =
      !request.suppressAlwaysAllowRule && Boolean(request.suggestions?.length);
    const response = yield* awaitInteraction({
      toolName: request.name,
      title: request.title ?? request.name,
      detail: JSON.stringify(request.input, null, 2).slice(0, 32 * 1024),
      toolUseId: request.toolUseId,
      ...(request.agentId ? { actor: { agentId: request.agentId } } : {}),
      ...(request.blockedPath ? { blockedPath: request.blockedPath } : {}),
      ...(request.decisionReason ? { decisionReason: request.decisionReason } : {}),
      ...(request.mcpServer ? { mcpServer: request.mcpServer } : {}),
      ...(request.displayName ? { displayName: request.displayName } : {}),
      ...(request.description ? { description: request.description } : {}),
      constraints: {
        defaultToNo: request.defaultToNo ?? false,
        suppressAlwaysAllowRule: request.suppressAlwaysAllowRule ?? false,
        allowForSession,
      },
      questions: questions?.success
        ? questions.data.questions.map((question) => ({
            id: question.question,
            question: question.question,
            ...(question.header ? { header: question.header } : {}),
            multiSelect: question.multiSelect ?? false,
            options: question.options.map((option) => ({
              label: option.label,
              description: option.description ?? "",
            })),
          }))
        : [],
    });
    if (request.name === "AskUserQuestion")
      return response.decision === "answer"
        ? { behavior: "allow", updatedInput: { ...request.input, answers: response.answers } }
        : { behavior: "deny", message: "Answers are required." };
    if (response.decision === "allow") return { behavior: "allow", updatedInput: request.input };
    if (response.decision === "allow-for-session" && allowForSession)
      return {
        behavior: "allow",
        updatedInput: request.input,
        updatedPermissions: request.suggestions!.map((suggestion) => ({
          ...suggestion,
          destination: "session",
        })),
      };
    return { behavior: "deny", message: "The user declined this request." };
  });
  const onUserDialog = Effect.fn("ClaudeSessionManager.dialog")(function* (
    request: UserDialogRequest,
  ): Effect.fn.Return<UserDialogResult, AgentRuntimeError> {
    if (input.isUnattended && (yield* input.isUnattended)) return { behavior: "cancelled" };
    if (request.dialogKind !== "resume_return") return { behavior: "cancelled" };
    const response = yield* awaitInteraction({
      kind: "dialog",
      toolName: "Claude",
      title: "Resume conversation",
      detail: "",
      ...(request.toolUseID ? { toolUseId: request.toolUseID } : {}),
      questions: [],
      dialog: { kind: request.dialogKind, payload: request.payload },
    });
    return response.decision === "dialog" &&
      ["compact", "continue", "never"].includes(String(response.result))
      ? { behavior: "completed", result: response.result }
      : { behavior: "cancelled" };
  });
  const onElicitation = Effect.fn("ClaudeSessionManager.elicitation")(function* (
    request: ElicitationRequest,
  ): Effect.fn.Return<ElicitationResult, AgentRuntimeError> {
    if (input.isUnattended && (yield* input.isUnattended)) return { action: "cancel" };
    const response = yield* awaitInteraction({
      kind: "elicitation",
      toolName: request.serverName,
      title: request.title ?? request.serverName,
      detail: request.message,
      questions: [],
      elicitation: {
        mode: request.mode ?? "form",
        message: request.message,
        ...(request.requestedSchema ? { requestedSchema: request.requestedSchema } : {}),
        ...(request.url ? { url: request.url } : {}),
        ...(request.elicitationId ? { elicitationId: request.elicitationId } : {}),
      },
    });
    if (response.decision !== "elicitation") return { action: "cancel" };
    const content = z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
      .safeParse(response.content);
    return { action: response.action, ...(content.success ? { content: content.data } : {}) };
  });
  const settle = Effect.fn("ClaudeSessionManager.settle")(function* (
    outcome: {
      status: "completed" | "failed" | "cancelled";
      stopReason: string;
      error: string | null;
      authenticationRequired?: boolean;
    },
    fatalError?: AgentRuntimeError,
  ) {
    if (!turn) return;
    const completed = turn;
    if (!everSaved && completed.sent)
      everSaved = yield* sdk.hasSession(nativeInput()).pipe(
        Effect.timeout("2 seconds"),
        Effect.catch((error) =>
          Effect.sync(() => {
            healthError = error.message;
            return false;
          }),
        ),
      );
    yield* cancelRequests(true);
    const completedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    yield* SubscriptionRef.update(snapshot, (current) => {
      const settled = completeAgentConversationTurn(current, completed.sequence, outcome);
      const next = fatalError ? failAgentConversation(settled, fatalError) : settled;
      return {
        ...next,
        requests: [...pending.values()].map(({ request }) => request),
        turns: next.turns.map((entry) =>
          entry.sequence === completed.sequence ? { ...entry, completedAt } : entry,
        ),
      };
    });
    yield* (
      input.onTurnSettled?.({
        sequence: completed.sequence,
        clientUserMessageIds: [...new Set([completed.authorityTurnId, ...completed.messageIds])],
        stopReason: outcome.stopReason,
        status: outcome.status,
        ...(outcome.error ? { error: outcome.error } : {}),
        nativeSessionId: sessionId,
        everSaved,
      }) ?? Effect.void
    ).pipe(Effect.tapError((error) => Deferred.fail(completed.completion, error)));
    turn = null;
    if (outcome.status === "failed") {
      yield* Deferred.fail(
        completed.completion,
        failure("turn", new Error(outcome.error ?? "Claude turn failed")),
      );
      return;
    }
    yield* Deferred.succeed(completed.completion, { stopReason: outcome.stopReason });
  });
  const failStream = Effect.fn("ClaudeSessionManager.failStream")(function* (
    error: AgentRuntimeError,
  ) {
    if (!active) return;
    active = false;
    healthError = error.message;
    queuedSteers.clear();
    yield* runtime?.terminate ?? Effect.void;
    yield* cancelRequests();
    const failedScope = runtimeScope;
    runtimeScope = null;
    yield* settle({ status: "failed", stopReason: "error", error: error.message }, error).pipe(
      Effect.ensuring(failedScope ? Scope.close(failedScope, Exit.void) : Effect.void),
    );
    yield* SubscriptionRef.update(snapshot, (current) => ({
      ...failAgentConversation(current, error),
      sessionId,
    }));
  });
  const startRuntime: () => Effect.Effect<void, AgentRuntimeError> = Effect.fn(
    "ClaudeSessionManager.startRuntime",
  )(function* () {
    generation += 1;
    const ownGeneration = generation;
    runtimeSuspended = true;
    if (runtimeScope) yield* Scope.close(runtimeScope, Exit.void);
    const scope = yield* Scope.fork(ownerScope);
    runtimeScope = scope;
    if (input.readPermissionPolicy) policy = yield* input.readPermissionPolicy;
    const launchContext = input.acquireLaunchContext
      ? yield* input.acquireLaunchContext(baseInput.cwd).pipe(Scope.provide(scope))
      : input.launchContext;
    yield* (
      input.onBackgroundTasksChanged?.(
        liveClaudeBackgroundTaskIds(yield* SubscriptionRef.get(snapshot)),
      ) ?? Effect.void
    );
    runtime = yield* sdk
      .open({
        ...nativeInput(),
        ...(launchContext ? { launchContext } : {}),
        ...(requested.model !== "default"
          ? {
              model: claudeModelWithContext(requested.model, requested.context),
            }
          : {}),
        ...(requested.effort !== "default" ? { effort: requested.effort } : {}),
        ...(requested.fast !== undefined ? { fast: requested.fast } : {}),
        ...(requested.thinking !== undefined ? { thinking: requested.thinking } : {}),
        permissionMode: nativePermissionMode(requestedMode, policy),
        canUseTool,
        onUserDialog,
        onElicitation,
      })
      .pipe(Scope.provide(scope));
    runtimeSuspended = false;
    effective = {
      ...runtime.intelligence,
      permissionMode: nativePermissionMode(requestedMode, policy),
    };
    if (requested.context !== undefined) {
      if (requested.model === "default" && !effective.model)
        return yield* failure(
          "intelligence",
          new Error("Claude has not reported the inherited model."),
        );
      const invalid = validateClaudeSelection(
        { model: requested.model, effort: "default", context: requested.context },
        runtime.models,
        instance.customModels,
        effective.model ?? undefined,
      );
      if (invalid) return yield* failure("intelligence", new Error(invalid));
      if (requested.model === "default") {
        yield* runtime.setIntelligence(requested);
        effective = { ...effective, ...(yield* runtime.inspectIntelligence) };
      }
      if (claudeModelContext(effective.model) !== requested.context)
        return yield* failure(
          "intelligence",
          new Error("Claude did not apply the requested context window."),
        );
    }
    configOptions = claudeSessionConfigOptions(runtime.models, effective, instance.customModels);
    const options = claudeModelOptions(
      runtime.models,
      requested.model === "default" ? (effective.model ?? undefined) : requested.model,
      instance.customModels,
    );
    const selected = options.find(
      ({ value }) => value === (requested.model === "default" ? effective.model : requested.model),
    );
    if (requested.fast === true && !selected?.fastMode)
      return yield* failure(
        "intelligence",
        new Error("This Claude model does not advertise fast mode."),
      );
    if (requested.thinking === false && selected?.disableThinking === false) {
      requested = { ...requested, thinking: undefined };
      yield* runtime.setIntelligence(requested);
      effective = { ...effective, ...(yield* runtime.inspectIntelligence) };
    }
    const normalized = normalizeClaudeSelection(
      requested,
      runtime.models,
      instance.customModels,
      effective,
    );
    if (normalized !== requested) {
      yield* runtime.setIntelligence(normalized);
      requested = normalized;
      effective = { ...effective, ...(yield* runtime.inspectIntelligence) };
    }
    if (requested.effort !== "default" && !selected?.reasoningEfforts?.includes(requested.effort)) {
      requested = { ...requested, effort: "default" };
      return yield* startRuntime();
    }

    commands = runtime.commands.map((command) => ({
      name: command.name,
      description: command.description,
      inputHint: command.argumentHint ?? null,
    }));
    yield* publishMetadata();
    const project = createClaudeMessageProjection();
    let lastResultIndex: number | null = null;
    yield* runtime.messages.pipe(
      Stream.runForEach((message: SDKMessage) =>
        Effect.gen(function* () {
          if (!active || generation !== ownGeneration) return;
          if (message.type === "conversation_reset") {
            const nextId = message.new_conversation_id;
            if (!nextId || (message.session_id !== sessionId && message.session_id !== nextId))
              return yield* failStream(
                failure("identity", new Error("Invalid Claude conversation reset"), "protocol"),
              );
            yield* settle({ status: "cancelled", stopReason: "cancelled", error: null });
            yield* cancelRequests();
            queuedSteers.clear();
            yield* (
              input.onSessionIdentityChanged?.({
                previousSessionId: sessionId,
                sessionId: nextId,
                reason: "reset",
                everSaved: false,
              }) ?? Effect.void
            );
            sessionId = nextId;
            everSaved = false;
            sequence = 0;
            yield* SubscriptionRef.update(snapshot, (current) => project(current, message, null));
            return;
          }
          if (message.session_id !== sessionId)
            return yield* failStream(
              failure(
                "identity",
                new Error("Claude returned a different session identity"),
                "protocol",
              ),
            );
          if (
            message.type === "result" &&
            typeof message.result_index === "number" &&
            Number.isInteger(message.result_index)
          ) {
            if (lastResultIndex !== null && message.result_index > lastResultIndex + 1) {
              yield* SubscriptionRef.update(snapshot, (current) =>
                current.metadata
                  ? updateAgentSessionMetadata(current, {
                      ...current.metadata,
                      diagnostics: [
                        ...(current.metadata.diagnostics ?? []).slice(-15),
                        {
                          severity: "warning",
                          code: "native-result-gap",
                          message:
                            "Claude skipped a result update. Reconnect if the conversation appears incomplete.",
                        },
                      ],
                    })
                  : current,
              );
            }
            lastResultIndex = Math.max(
              lastResultIndex ?? message.result_index,
              message.result_index,
            );
          }
          if (message.type === "result" && turn) {
            const ids =
              message.user_message_uuids ??
              (message.user_message_uuid ? [message.user_message_uuid] : []);
            if (ids.length && !ids.some((uuid) => turn!.messageIds.has(uuid))) return;
            if (
              (!ids.length && !turn.sent) ||
              (message.num_turns === 0 && Boolean(message.resume_reason))
            )
              return;
          }
          yield* SubscriptionRef.updateEffect(snapshot, (current) =>
            Effect.gen(function* () {
              const next = project(current, message, (turn?.sequence ?? sequence) || null);
              const before = liveClaudeBackgroundTaskIds(current);
              const after = liveClaudeBackgroundTaskIds(next);
              if (before.length !== after.length || before.some((id) => !after.includes(id)))
                yield* input.onBackgroundTasksChanged?.(after) ?? Effect.void;
              return next;
            }),
          );
          if (message.type === "assistant" && message.error === "authentication_failed" && turn)
            turn.authenticationFailure =
              "Claude authentication failed. Update this instance's credentials or sign in using its configured directory.";
          if (message.type === "system" && message.subtype === "init") {
            effective = {
              ...effective,
              model: message.model,
              effort: message.effort === undefined ? effective.effort : message.effort,
              permissionMode: message.permissionMode,
            };
            observedVersion = message.claude_code_version;
            observedCapabilities = message.capabilities ?? [];
            modes = { ...modes, currentModeId: message.permissionMode };
            yield* publishMetadata();
          }
          if ("fast_mode_state" in message && message.fast_mode_state) {
            effective = { ...effective, fast: message.fast_mode_state === "on" };
            yield* publishMetadata();
          }
          if (message.type === "system" && message.subtype === "status" && message.permissionMode) {
            effective = { ...effective, permissionMode: message.permissionMode };
            modes = { ...modes, currentModeId: message.permissionMode };
            yield* publishMetadata();
          }
          if (message.type === "system" && message.subtype === "commands_changed") {
            commands = message.commands.map((command) => ({
              name: command.name,
              description: command.description,
              inputHint: command.argumentHint ?? null,
            }));
            yield* publishMetadata();
          }
          if (message.type !== "result" || !turn) return;
          const consumed =
            message.user_message_uuids ??
            (message.user_message_uuid ? [message.user_message_uuid] : [...turn.messageIds]);
          const consumedImageIds = consumed.filter(
            (uuid) => queuedSteers.get(uuid)?.images?.length,
          );
          const completedSequence = turn.sequence;
          for (const uuid of consumed) queuedSteers.delete(uuid);
          turn.messageIds = new Set(consumed.filter((uuid) => turn!.messageIds.has(uuid)));

          const outcome = deriveClaudeTurnOutcome(message, {
            cancelled: turn.cancelled,
            authenticationFailure: turn.authenticationFailure,
          });
          healthError = outcome.authenticationRequired ? outcome.error : null;
          yield* settle(outcome);
          if (consumedImageIds.length) {
            const historyInput = nativeInput();
            yield* sdk.historyPage(historyInput).pipe(
              Effect.catch(() => Effect.succeed({ messages: [] })),
              Effect.flatMap((page) =>
                SubscriptionRef.update(snapshot, (current) =>
                  current.sessionId !== historyInput.sessionId || current.status === "closed"
                    ? current
                    : page.messages
                        .filter(
                          (entry) =>
                            consumedImageIds.includes(entry.uuid) && isClaudeHistoryPrompt(entry),
                        )
                        .reduce(
                          (next, entry) =>
                            project(
                              next,
                              { ...entry, isReplay: true } as SDKMessage,
                              completedSequence,
                            ),
                          current,
                        ),
                ),
              ),
              Effect.forkIn(scope),
            );
          }
          if (!queuedSteers.size) return;
          const queuedIds = [...queuedSteers.keys()];
          const nextUuid = queuedIds[0]!;
          const text = [...queuedSteers.values()]
            .map((entry) => entry.text || (entry.images?.length ? "[Image]" : ""))
            .join("\n");
          const completion = yield* Deferred.make<{ stopReason: string }, AgentRuntimeError>();
          turn = {
            sequence: ++sequence,
            authorityTurnId: nextUuid,
            completion,
            cancelled: false,
            messageIds: new Set(queuedIds),
            authenticationFailure: null,
            sent: true,
          };
          yield* refreshPermissionPolicy();
          yield* (
            input.onTurnAdmitted?.({ sequence, clientUserMessageId: nextUuid, text }) ?? Effect.void
          );
          yield* SubscriptionRef.update(snapshot, (current) =>
            beginClaudeAcceptedInputTurn(
              current,
              sequence,
              queuedIds.map((uuid) => {
                const queued = queuedSteers.get(uuid)!;
                return {
                  messageId: uuid,
                  text: queued.text,
                  images: inputImageDescriptors(uuid, queued.images),
                };
              }),
            ),
          );
        }),
      ),
      Effect.andThen(
        Effect.suspend(() =>
          active && generation === ownGeneration
            ? failStream(failure("stream", new Error("Claude Code exited"), "session-lost"))
            : Effect.void,
        ),
      ),
      Effect.catch((error) => (generation === ownGeneration ? failStream(error) : Effect.void)),
      Effect.forkIn(scope),
    );
  });
  if (executionRecoveryRequired) yield* publishMetadata();
  else yield* startRuntime();
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      active = false;
      generation += 1;
      yield* cancelRequests();
      if (turn)
        yield* settle({ status: "cancelled", stopReason: "cancelled", error: null }).pipe(
          Effect.catch(() => Effect.void),
        );
      yield* SubscriptionRef.update(snapshot, closeAgentConversation);
    }),
  );
  const requireActive = Effect.suspend(() =>
    active
      ? Effect.void
      : Effect.fail(
          failure(
            "session",
            new Error("Reopen this session to reconnect to Claude Code"),
            "session-lost",
          ),
        ),
  );
  const requireIdle = requireActive.pipe(
    Effect.andThen(
      Effect.suspend(() =>
        turn || queuedSteers.size
          ? Effect.fail(failure("busy", new Error("Wait for the current turn to finish")))
          : Effect.void,
      ),
    ),
  );
  const requireInputAdmission = Effect.suspend(() =>
    executionHandoff || runtimeSuspended || executionRecoveryRequired
      ? Effect.fail(
          failure(
            "execution.handoff",
            new Error(
              executionRecoveryRequired
                ? "Recover this task's execution location before continuing"
                : "Wait for this task's execution handoff to finish",
            ),
          ),
        )
      : Effect.void,
  );
  const requireRuntime = Effect.suspend(() =>
    runtime
      ? Effect.succeed(runtime)
      : Effect.fail(
          failure(
            "execution.recovery",
            new Error("Recover this task's execution location before continuing"),
          ),
        ),
  );
  const requireNewMessageId = (messageId: string) =>
    knownClientMessageIds.has(messageId) ||
    turn?.messageIds.has(messageId) ||
    queuedSteers.has(messageId)
      ? Effect.fail(failure("input", new Error("This message was already submitted")))
      : Effect.void;
  const requireNoBackground = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(snapshot);
    if (hasLiveClaudeBackground(current) || pending.size)
      return yield* failure(
        "busy",
        new Error("Stop background tasks before restarting this Claude session"),
      );
  });
  const applyPermissionPolicy = Effect.fn("ClaudeSessionManager.permissionPolicy")(function* (
    next: AgentSessionPermissionPolicy,
  ) {
    yield* requireActive;
    const mode = nativePermissionMode(requestedMode, next);
    if (policy === next && effective.permissionMode === mode) return;
    yield* requireInputAdmission;
    yield* (yield* requireRuntime).setMode(mode);
    policy = next;
    effective = { ...effective, permissionMode: mode };
    yield* publishMetadata();
  });
  const refreshPermissionPolicy = Effect.fn("ClaudeSessionManager.refreshPermissionPolicy")(
    function* () {
      if (!input.readPermissionPolicy) return;
      yield* applyPermissionPolicy(yield* input.readPermissionPolicy);
    },
    Effect.tapError(failStream),
  );
  const cancel = requireActive.pipe(
    Effect.andThen(
      Effect.suspend(() => {
        if (!turn) return Effect.void;
        turn.cancelled = true;
        const completion = turn.completion;
        return cancelRequests(true).pipe(
          Effect.andThen(requireRuntime.pipe(Effect.flatMap((current) => current.interrupt))),
          Effect.tap((receipt) =>
            receipt?.still_queued?.length
              ? SubscriptionRef.update(snapshot, (current) => ({
                  ...current,
                  revision: current.revision + 1,
                  metadata: current.metadata
                    ? {
                        ...current.metadata,
                        revision: current.metadata.revision + 1,
                        diagnostics: [
                          {
                            severity: "warning" as const,
                            code: "queued-prompts-survive-stop",
                            message:
                              "Claude still has queued input. It can run after this turn stops.",
                          },
                        ],
                      }
                    : undefined,
                }))
              : Effect.void,
          ),
          Effect.andThen(Deferred.await(completion)),
          Effect.timeout("5 seconds"),
          Effect.asVoid,
          Effect.catch((cause) => failStream(failure("cancel", cause, "session-lost"))),
        );
      }),
    ),
  );
  const setIntelligence = (choice: ClaudeModelSelection) =>
    controls.withPermits(1)(
      Effect.gen(function* () {
        yield* requireInputAdmission;
        yield* requireIdle;
        const runtime = yield* requireRuntime;
        const targetModel = claudeModelOptions(
          runtime.models,
          undefined,
          instance.customModels,
        ).find(({ value }) => value === choice.model);
        const selection = normalizeClaudeSelection(
          {
            ...choice,
            ...(choice.model !== requested.model &&
            choice.thinking === false &&
            !targetModel?.disableThinking
              ? { thinking: undefined }
              : {}),
            ...(choice.model !== requested.model && choice.fast === true && !targetModel?.fastMode
              ? { fast: false }
              : {}),
          },
          runtime.models,
          instance.customModels,
          effective,
        );
        const restart =
          (requested.model !== "default" && selection.model === "default") ||
          (requested.effort !== "default" && selection.effort === "default") ||
          (requested.model === "default" &&
            requested.context !== undefined &&
            selection.context === undefined);
        const invalid =
          restart && selection.model === "default"
            ? null
            : validateClaudeSelection(
                selection,
                runtime.models,
                instance.customModels,
                requested.model === "default" ? (effective.model ?? undefined) : requested.model,
              );
        if (invalid) return yield* failure("intelligence", new Error(invalid));
        if (restart) {
          yield* requireNoBackground;
          const previous = requested;
          requested = selection;
          yield* startRuntime().pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                requested = previous;
              }),
            ),
            Effect.tapError(failStream),
          );
        } else {
          yield* runtime.setIntelligence(selection);
          effective = { ...effective, ...(yield* runtime.inspectIntelligence) };
          if (
            selection.context !== undefined &&
            claudeModelContext(effective.model) !== selection.context
          ) {
            const error = failure(
              "intelligence",
              new Error("Claude did not apply the requested context window."),
            );
            yield* publishMetadata();
            yield* failStream(error);
            return yield* error;
          }
          requested = selection;
        }
        yield* publishMetadata();
        return configOptions;
      }),
    );
  const suspendRuntime = Effect.gen(function* () {
    generation += 1;
    if (runtimeScope) yield* Scope.close(runtimeScope, Exit.void);
    runtimeScope = null;
    runtimeSuspended = true;
  });
  const suspendExecution = controls.withPermits(1)(
    Effect.gen(function* () {
      if (!executionHandoff)
        return yield* failure(
          "execution.handoff",
          new Error("Suspend native execution only during a handoff"),
        );
      yield* requireIdle;
      yield* requireNoBackground;
      yield* suspendRuntime;
    }),
  );
  const withExecutionHandoff = <A, E, R>(
    use: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | AgentRuntimeError, R> =>
    Effect.acquireUseRelease(
      controls.withPermits(1)(
        Effect.gen(function* () {
          yield* requireActive;
          if (executionHandoff)
            return yield* failure(
              "execution.handoff",
              new Error("A native execution handoff is already active."),
            );
          executionHandoff = true;
        }),
      ),
      () => use,
      () =>
        controls
          .withPermits(1)(
            Effect.suspend(() =>
              active && runtimeSuspended && !executionRecoveryRequired
                ? startRuntime().pipe(Effect.tapError(failStream))
                : Effect.void,
            ),
          )
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                executionHandoff = false;
              }),
            ),
          ),
    );
  const withExecutionLocation = <A, E, R>(
    location: import("../AgentSessionHandle").NativeAgentExecutionLocation,
    use: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | AgentRuntimeError, R> =>
    controls.withPermits(1)(
      Effect.gen(function* () {
        yield* requireIdle;
        yield* requireNoBackground;
        if (!isAbsolute(location.workspaceRoot))
          return yield* failure(
            "execution.location",
            new Error("A native working directory must be absolute."),
          );
        const source = baseInput;
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.sync(() => {
            baseInput = executionInput(location);
          }).pipe(
            Effect.andThen(
              restore(
                startRuntime().pipe(
                  Effect.andThen(use),
                  Effect.tap(() => requireActive),
                ),
              ),
            ),
            Effect.onExit((exit) =>
              Exit.isFailure(exit)
                ? Effect.sync(() => {
                    baseInput = source;
                  }).pipe(
                    Effect.andThen(Effect.suspend(() => (active ? startRuntime() : Effect.void))),
                    Effect.tapError(failStream),
                  )
                : Effect.void,
            ),
          ),
        ).pipe(
          Effect.ensuring(
            Effect.suspend(() => (active && executionHandoff ? suspendRuntime : Effect.void)),
          ),
        );
      }),
    );
  const prompt = (
    text: string,
    options?: {
      readonly clientUserMessageId?: string;
      readonly images?: readonly AgentPromptImage[];
    },
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const admitted = yield* controls.withPermits(1)(
          Effect.gen(function* () {
            yield* requireInputAdmission;
            yield* requireIdle;
            const runtime = yield* requireRuntime;
            const messageId = options?.clientUserMessageId ?? createUuidV7();
            yield* requireNewMessageId(messageId);
            yield* refreshPermissionPolicy();
            const completion = yield* Deferred.make<{ stopReason: string }, AgentRuntimeError>();
            const next = {
              sequence: sequence + 1,
              authorityTurnId: messageId,
              completion,
              cancelled: false,
              messageIds: new Set([messageId]),
              authenticationFailure: null as string | null,
              sent: false,
            };
            turn = next;
            rememberClientMessageId(messageId);
            yield* (
              input.onTurnAdmitted?.({
                sequence: next.sequence,
                clientUserMessageId: messageId,
                text,
              }) ?? Effect.void
            ).pipe(
              Effect.tapError(() =>
                Effect.sync(() => {
                  turn = null;
                }),
              ),
              Effect.tapError(failStream),
            );
            sequence = next.sequence;
            const createdAt = new Date(yield* Clock.currentTimeMillis).toISOString();
            yield* SubscriptionRef.update(snapshot, (current) => {
              const next = beginAgentConversationTurn(current, sequence, text, messageId);
              return {
                ...next,
                turns: next.turns.map((entry) =>
                  entry.sequence === sequence ? { ...entry, createdAt } : entry,
                ),
              };
            });
            next.sent = true;
            yield* runtime
              .send(text, messageId, sessionId, undefined, options?.images)
              .pipe(Effect.tapError(failStream));
            return next;
          }),
        );
        return yield* restore(Deferred.await(admitted.completion)).pipe(
          Effect.onInterrupt(() => cancel.pipe(Effect.catch(() => Effect.void))),
        );
      }),
    );
  const handle = {
    threadId: input.threadId,
    get sessionId() {
      return sessionId;
    },
    snapshot,
    capabilities,
    get modes() {
      return modes;
    },
    get configOptions() {
      return configOptions;
    },
    prompt,
    cancel,
    suspendExecution,
    withExecutionHandoff,
    setExecutionRecoveryRequired: (required: boolean) =>
      controls.withPermits(1)(
        Effect.gen(function* () {
          executionRecoveryRequired = required;
          if (required && !executionHandoff && !turn) yield* suspendRuntime;
        }),
      ),
    setIntelligence: (selection: ClaudeModelSelection) =>
      setIntelligence(selection).pipe(Effect.asVoid),
    withExecutionLocation,
    setPermissionPolicy: (next: AgentSessionPermissionPolicy) =>
      controls.withPermits(1)(applyPermissionPolicy(next)),
    setMode: (id: string) =>
      controls.withPermits(1)(
        Effect.gen(function* () {
          yield* requireInputAdmission;
          yield* requireIdle;
          const runtime = yield* requireRuntime;
          if (id !== "default" && id !== "plan")
            return yield* failure("mode", new Error("Unsupported Claude mode"));
          if (input.readPermissionPolicy) policy = yield* input.readPermissionPolicy;
          yield* runtime.setMode(nativePermissionMode(id, policy));
          requestedMode = id;
          modes = { ...modes, currentModeId: id };
          effective = { ...effective, permissionMode: nativePermissionMode(id, policy) };
          yield* publishMetadata();
        }),
      ),
    setConfigOption: (id: string, value: string | boolean) => {
      if (
        typeof value !== "string" ||
        (id !== "model" && id !== "effort") ||
        (id === "effort" && value !== "default" && value !== "off" && !isClaudeEffortLevel(value))
      )
        return Effect.fail(failure("settings", new Error("Choose an advertised Claude setting")));
      const next =
        id === "model"
          ? { ...requested, model: value }
          : value === "off"
            ? { ...requested, thinking: false }
            : {
                ...requested,
                effort: isClaudeEffortLevel(value) ? value : ("default" as const),
                ...(isClaudeEffortLevel(value) ? { thinking: true } : {}),
              };
      if (
        id === "model" &&
        validateClaudeSelection(next, runtime?.models ?? [], instance.customModels, requested.model)
      )
        return setIntelligence({ model: value, effort: "default" });
      return setIntelligence(next);
    },
    steer: (
      text: string,
      options?: {
        readonly clientUserMessageId?: string;
        readonly images?: readonly AgentPromptImage[];
      },
    ) =>
      controls.withPermits(1)(
        Effect.gen(function* () {
          yield* requireInputAdmission;
          yield* requireActive;
          const runtime = yield* requireRuntime;
          if (!turn) return yield* failure("steer", new Error("Start a turn before steering it"));
          const queuedBytes = [...queuedSteers.values()].reduce(
            (size, entry) =>
              size +
              entry.text.length +
              (entry.images ?? []).reduce((bytes, image) => bytes + image.data.length, 0),
            0,
          );
          const incomingBytes =
            text.length +
            (options?.images ?? []).reduce((bytes, image) => bytes + image.data.length, 0);
          if (
            turn.messageIds.size >= 16 ||
            text.length > 128 * 1024 ||
            queuedBytes + incomingBytes > 32 * 1024 * 1024
          )
            return yield* failure("steer", new Error("Too much queued input"), "pressure");
          const uuid = options?.clientUserMessageId ?? createUuidV7();
          yield* requireNewMessageId(uuid);
          yield* refreshPermissionPolicy();
          rememberClientMessageId(uuid);
          turn.messageIds.add(uuid);
          queuedSteers.set(uuid, { text, ...(options?.images ? { images: options.images } : {}) });
          yield* SubscriptionRef.update(snapshot, (current) =>
            projectClaudeAcceptedInput(current, turn!.sequence, {
              messageId: uuid,
              text,
              images: inputImageDescriptors(uuid, options?.images),
            }),
          );
          yield* runtime
            .send(text, uuid, sessionId, "now", options?.images)
            .pipe(Effect.tapError(failStream));
        }),
      ),
    stopTask: (taskId: string) =>
      Effect.gen(function* () {
        yield* requireActive;
        const current = yield* SubscriptionRef.get(snapshot);
        const task = current.tasks?.find(({ id }) => id === taskId);
        if (!task || !isAgentConversationTaskLiveInSnapshot(task, current))
          return yield* failure("stop task", new Error("This task is no longer running"));
        yield* (yield* requireRuntime).stopTask(taskId);
      }),
    loadHistory: (page?: { readonly before?: string; readonly limit?: number }) =>
      controls.withPermits(1)(
        Effect.gen(function* () {
          yield* requireIdle;
          const current = yield* SubscriptionRef.get(snapshot);
          const before = page?.before ?? current.history?.cursor;
          if (!before || !current.history?.hasOlder || current.history.windowFull)
            return { messages: [], before: null, hasMore: false };
          const loaded = yield* sdk.historyPage(nativeInput(), {
            before,
            ...(page?.limit ? { limit: page.limit } : {}),
          });
          const older = applyAgentHistoryFacts(
            projectClaudeHistory(
              {
                ...emptyAgentConversationSnapshot({
                  backend: "claude",
                  threadId: input.threadId,
                  sessionId,
                }),
                history: { hasOlder: false, oldestSequence: null, windowSize: 512 },
              },
              loaded.messages,
            ),
            restoredFacts,
          );
          rememberNativeHistoryIds(loaded.messages);
          rememberHistoryTurnIds(older.turns);
          yield* SubscriptionRef.update(snapshot, (present) =>
            prependAgentHistory(present, older, {
              hasOlder: loaded.hasMore,
              ...(loaded.before ? { cursor: loaded.before } : {}),
            }),
          );
          return loaded;
        }),
      ),
    readHistoryImage: (nativeMessageId: string, index: number) =>
      requireActive.pipe(Effect.andThen(sdk.historyImage(nativeInput(), nativeMessageId, index))),
    readHistoryToolOutput: (nativeMessageId: string, toolUseId: string) =>
      requireActive.pipe(
        Effect.andThen(sdk.historyToolOutput(nativeInput(), nativeMessageId, toolUseId)),
      ),
    forkAt: (nativeMessageId: string) =>
      controls.withPermits(1)(
        requireInputAdmission.pipe(
          Effect.andThen(requireIdle),
          Effect.andThen(sdk.fork(nativeInput(), nativeMessageId)),
        ),
      ),
    rollback: (numTurns: number) =>
      controls.withPermits(1)(
        Effect.gen(function* () {
          yield* requireInputAdmission;
          yield* requireIdle;
          yield* requireNoBackground;
          if (!Number.isInteger(numTurns) || numTurns < 1)
            return yield* failure("rollback", new Error("Choose a positive number of turns"));
          const page = yield* sdk.historyPage(nativeInput(), { all: true });
          const boundaries = page.messages
            .map((entry, index) => ({ entry, index }))
            .filter(({ entry }) => isClaudeHistoryPrompt(entry));
          rememberNativeHistoryIds(page.messages);
          const remove = boundaries.at(-numTurns);
          if (!remove)
            return yield* failure("rollback", new Error("There are fewer turns than requested"));
          if (remove === boundaries[0]) {
            const nextId = createUuidV7();
            yield* (
              input.onSessionIdentityChanged?.({
                previousSessionId: sessionId,
                sessionId: nextId,
                reason: "rollback",
                everSaved: false,
                messageIdMap: {},
              }) ?? Effect.void
            );
            sessionId = nextId;
            everSaved = false;
            sequence = 0;
            yield* SubscriptionRef.update(snapshot, (current) => ({
              ...emptyAgentConversationSnapshot({
                backend: "claude",
                threadId: input.threadId,
                sessionId,
              }),
              revision: current.revision + 1,
              metadata: current.metadata,
            }));
            yield* startRuntime().pipe(Effect.tapError(failStream));
            return;
          }
          const forked = yield* sdk.fork(nativeInput(), page.messages[remove.index - 1]!.uuid);
          yield* (
            input.onSessionIdentityChanged?.({
              previousSessionId: sessionId,
              sessionId: forked.sessionId,
              reason: "rollback",
              everSaved: true,
              ...(forked.messageIdMap ? { messageIdMap: forked.messageIdMap } : {}),
            }) ?? Effect.void
          );
          sessionId = forked.sessionId;
          everSaved = true;
          const retained = yield* sdk.history(nativeInput()).pipe(Effect.tapError(failStream));
          const previous = yield* SubscriptionRef.get(snapshot);
          const retainedFacts = previous.turns.flatMap((entry) => {
            const nativeId = entry.nativeUserMessageId ?? entry.clientUserMessageId;
            const remapped = nativeId ? forked.messageIdMap?.[nativeId] : undefined;
            const fact = remapped ? agentHistoryFactFromTurn(entry) : null;
            return fact ? [{ ...fact, nativeUserMessageId: remapped }] : [];
          });
          const rebuilt = applyAgentHistoryFacts(
            projectClaudeHistory(
              emptyAgentConversationSnapshot({
                backend: "claude",
                threadId: input.threadId,
                sessionId,
              }),
              retained,
            ),
            retainedFacts,
          );
          rememberHistoryTurnIds(rebuilt.turns);
          yield* SubscriptionRef.update(snapshot, (current) => ({
            ...rebuilt,
            revision: current.revision + 1,
            metadata: current.metadata,
          }));
          sequence = Math.max(0, ...rebuilt.turns.map((entry) => entry.sequence ?? 0));
          yield* startRuntime().pipe(Effect.tapError(failStream));
        }),
      ),
    compact: Effect.suspend(() => prompt("/compact")).pipe(Effect.asVoid),
    inspectRuntime: Effect.suspend(() =>
      active && !runtimeSuspended && runtime
        ? runtime.inspectRuntime
        : Effect.succeed(
            runtime?.diagnostics ?? {
              health: {
                status: "unknown",
                executable: null,
                version: null,
                account: null,
                error: null,
              },
              mcpServers: [],
              agents: [],
              capabilities: [],
            },
          ),
    ).pipe(
      Effect.map((diagnostics): ClaudeRuntimeDiagnostics => ({
        ...diagnostics,
        capabilities: observedCapabilities,
        health: {
          ...diagnostics.health,
          version: observedVersion ?? diagnostics.health.version,
          status: healthError ? "error" : runtime && effective.model ? "ready" : "unknown",
          error: healthError,
        },
      })),
    ),
    respond: (id: string, response: AgentInteractionResponse) =>
      Effect.gen(function* () {
        yield* requireActive;
        const entry = pending.get(id);
        if (!entry)
          return yield* failure("response", new Error("This request is no longer pending"));
        const request = entry.request;
        if (
          response.decision === "answer" &&
          (request.questions.length === 0 ||
            request.questions.some((question) => !response.answers[question.id]?.trim()) ||
            Object.keys(response.answers).some(
              (key) => !request.questions.some((question) => question.id === key),
            ))
        )
          return yield* failure("response", new Error("Answer each question before submitting"));
        if (
          (response.decision === "allow" || response.decision === "allow-for-session") &&
          request.questions.length
        )
          return yield* failure("response", new Error("This request requires answers"));
        if (response.decision === "allow-for-session" && !request.constraints?.allowForSession)
          return yield* failure(
            "response",
            new Error("This request does not allow a session rule"),
          );
        if (
          (response.decision === "dialog" && request.kind !== "dialog") ||
          (response.decision === "elicitation" && request.kind !== "elicitation")
        )
          return yield* failure(
            "response",
            new Error("This response does not match the pending request"),
          );
        yield* Deferred.succeed(entry.completion, response);
        pending.delete(id);
        yield* patchRequests();
      }),
  } satisfies AgentSessionHandle;
  return handle;
});
export const make = Effect.gen(function* () {
  const settings = yield* ApplicationSettings;
  const sdk = yield* ClaudeSdk;
  const config = yield* MainConfig;
  const ownerScope = yield* Scope.Scope;
  const lanes = yield* RcMap.make({ lookup: (_id: string) => Semaphore.make(1) });
  const discovery = yield* Semaphore.make(2);
  const catalogCache = new Map<string, { expires: number; value: ClaudeDiscovery }>();
  const sessions = new Map<
    string,
    { handle: AgentSessionHandle; scope: Scope.Closeable; instanceId: string }
  >();
  const observed = new Set<string>();
  const opening = new Set<string>();
  const evictions = yield* FiberMap.make<string>();
  const changes = yield* PubSub.sliding<AgentBackendSessionChangedEvent>(256);
  const nativeScope = Effect.fn("ClaudeSessionManager.nativeScope")(function* (
    instanceConfigId: string,
  ) {
    const launch = yield* settings
      .claudeLaunchConfiguration(instanceConfigId)
      .pipe(Effect.mapError((cause) => failure("settings", cause)));
    const input = {
      instance: launch.instance,
      environment: { ...config.environment, ...launch.environment },
    };
    const nativeHome = yield* sdk.nativeHome(input);
    return { input, nativeHome };
  });
  const nativeHome = (instanceConfigId: string) =>
    nativeScope(instanceConfigId).pipe(Effect.map((scope) => scope.nativeHome));
  const nativeCatalog = Effect.fn("ClaudeSessionManager.nativeCatalog")(function* (input: {
    readonly instanceConfigId: string;
    readonly cursor?: string;
  }) {
    const scope = yield* nativeScope(input.instanceConfigId);
    const offset = yield* Effect.try({
      try: () => {
        if (!input.cursor) return 0;
        const cursor = z
          .object({
            home: z.string(),
            instance: z.string(),
            offset: z.number().int().min(0).max(100_000),
          })
          .strict()
          .parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")));
        if (cursor.home !== scope.nativeHome || cursor.instance !== input.instanceConfigId)
          throw new Error("The Claude profile changed. Refresh the session list.");
        return cursor.offset;
      },
      catch: (cause) => failure("catalog cursor", cause),
    });
    const sessions = yield* sdk.listSessions(scope.input, offset);
    if ((yield* nativeHome(input.instanceConfigId)) !== scope.nativeHome)
      return yield* failure(
        "catalog",
        new Error("The Claude profile changed. Refresh the session list."),
      );
    const candidates = yield* Effect.forEach(
      sessions.slice(0, 50),
      (session) =>
        Effect.gen(function* () {
          if (
            !session.cwd ||
            !Number.isSafeInteger(session.lastModified) ||
            session.lastModified < 0
          )
            return null;
          const available = yield* Effect.tryPromise({
            try: () => nativeSessionCwdAvailable(session.cwd!),
            catch: (cause) => failure("catalog working directory", cause),
          });
          if (!available) return null;
          return {
            nativeSessionId: session.sessionId,
            title: nativeSessionCatalogTitle(
              session.customTitle || session.summary,
              "Claude conversation",
            ),
            cwd: session.cwd,
            updatedAt: session.lastModified,
          };
        }),
      { concurrency: 4 },
    );
    return {
      nativeHome: scope.nativeHome,
      entries: candidates.filter((candidate) => candidate !== null),
      nextCursor:
        sessions.length > 50
          ? Buffer.from(
              JSON.stringify({
                home: scope.nativeHome,
                instance: input.instanceConfigId,
                offset: offset + 50,
              }),
            ).toString("base64url")
          : null,
    } satisfies NativeSessionCatalogPage;
  });
  const nativeSessionInfo = Effect.fn("ClaudeSessionManager.nativeSessionInfo")(function* (input: {
    readonly instanceConfigId: string;
    readonly nativeSessionId: string;
    readonly expectedHome: string;
  }) {
    const scope = yield* nativeScope(input.instanceConfigId);
    if (scope.nativeHome !== input.expectedHome)
      return yield* failure(
        "attachment",
        new Error("The Claude profile changed. Refresh the session list."),
      );
    const info = yield* sdk.sessionInfo(scope.input, input.nativeSessionId);
    if (!info || info.sessionId !== input.nativeSessionId || !info.cwd || !isAbsolute(info.cwd))
      return yield* failure(
        "attachment",
        new Error("This native conversation is no longer available."),
        "resource-not-found",
      );
    const cwd = info.cwd;
    const available = yield* Effect.tryPromise({
      try: () => nativeSessionCwdAvailable(cwd),
      catch: (cause) => failure("working directory", cause),
    });
    if (!available)
      return yield* failure(
        "working directory",
        new Error("The native working directory is unavailable."),
      );
    if ((yield* nativeHome(input.instanceConfigId)) !== scope.nativeHome)
      return yield* failure(
        "attachment",
        new Error("The Claude profile changed. Refresh the session list."),
      );
    return { ...info, cwd, nativeHome: scope.nativeHome };
  });
  const exclusive = <A, E, R>(id: string, action: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const lane = yield* RcMap.get(lanes, id);
        return yield* lane.withPermits(1)(action);
      }),
    );
  const close = (id: string) =>
    exclusive(
      id,
      Effect.suspend(() => {
        const owned = sessions.get(id);
        if (!owned) return Effect.void;
        sessions.delete(id);
        return Scope.close(owned.scope, Exit.void);
      }),
    );
  const evict = (id: string): Effect.Effect<void> =>
    Effect.sleep("2 minutes").pipe(
      Effect.andThen(
        Effect.gen(function* () {
          if (observed.has(id)) return;
          const owned = sessions.get(id);
          if (!owned) return;
          const snapshot = yield* SubscriptionRef.get(owned.handle.snapshot);
          if (
            snapshot.status === "running" ||
            hasLiveClaudeBackground(snapshot) ||
            (snapshot.requests?.length ?? 0) > 0
          )
            return yield* evict(id);
          yield* close(id);
        }),
      ),
    );
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...sessions.keys()], close, { discard: true, concurrency: 4 }),
  );
  const discover = (
    instanceConfigId: string,
    location: NativeAgentExecutionLocation,
    forceReload = false,
  ) =>
    Effect.gen(function* () {
      const { workspaceRoot, workspaceEnvironment } = location;
      const { instance, environment } = yield* settings
        .claudeLaunchConfiguration(instanceConfigId)
        .pipe(Effect.mapError((cause) => failure("settings", cause)));
      const launchEnvironment = claudeLaunchEnvironment(config, workspaceEnvironment, environment);
      const key = claudeDiscoveryFingerprint(instance, launchEnvironment, workspaceRoot);
      return yield* exclusive(
        `discovery:${key}`,
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (forceReload) catalogCache.delete(key);
          const cached = catalogCache.get(key);
          if (cached && cached.expires > now) return cached.value;
          const value = yield* discovery.withPermits(1)(
            Effect.scoped(
              Effect.gen(function* () {
                const session = yield* sdk.open({
                  instance,
                  environment: launchEnvironment,
                  cwd: workspaceRoot,
                  sessionId: createUuidV7(),
                  resume: false,
                  persistSession: false,
                  purpose: "discovery",
                  permissionMode: "dontAsk",
                  canUseTool: () =>
                    Effect.succeed({ behavior: "deny", message: "Discovery cannot run tools" }),
                });
                const nativeEnvironment = claudeEnvironment(launchEnvironment, instance);
                const configuration = yield* sdk.configuration({
                  instance,
                  environment: launchEnvironment,
                  cwd: workspaceRoot,
                });
                const skills = yield* discoverClaudeSkills(
                  nativeEnvironment,
                  workspaceRoot,
                  session.commands,
                  configuration.skillOverrides,
                );
                const version = yield* probeClaudeVersion(
                  session.diagnostics.health.executable,
                  nativeEnvironment,
                  workspaceRoot,
                );
                return {
                  models: claudeModelOptions(session.models, undefined, instance.customModels),
                  intelligence: session.intelligence,
                  commands: session.commands,
                  skills,
                  health: { ...session.diagnostics.health, version },
                  revision: key,
                } satisfies ClaudeDiscovery;
              }),
            ),
          );
          if (catalogCache.size >= 64) {
            const oldest = catalogCache.keys().next().value;
            if (oldest) catalogCache.delete(oldest);
          }
          catalogCache.set(key, { expires: now + 60_000, value });
          return value;
        }),
      );
    });
  return ClaudeSessionManager.of({
    nativeHome,
    nativeCatalog,
    nativeSessionInfo,
    models: (instanceConfigId, workspaceRoot, forceReload) =>
      discover(instanceConfigId, { workspaceRoot }, forceReload).pipe(
        Effect.map(({ models }) => models),
      ),
    discover,
    open: (input) =>
      exclusive(
        input.threadId,
        Effect.gen(function* () {
          const existing = sessions.get(input.threadId);
          if (existing) {
            if (
              existing.instanceId !== input.instanceConfigId ||
              (input.sessionId !== undefined && existing.handle.sessionId !== input.sessionId)
            )
              return yield* failure(
                "binding",
                new Error("Thread already uses another Claude instance"),
                "authorization",
              );
            const snapshot = yield* SubscriptionRef.get(existing.handle.snapshot);
            if (snapshot.status !== "failed" && snapshot.status !== "closed") {
              yield* existing.handle.setPermissionPolicy?.(input.permissionPolicy) ?? Effect.void;
              return existing.handle;
            }
            sessions.delete(input.threadId);
            yield* Scope.close(existing.scope, Exit.void);
          }
          yield* Effect.acquireRelease(
            Effect.suspend(() => {
              if (sessions.size + opening.size >= 32)
                return Effect.fail(
                  failure(
                    "capacity",
                    new Error("Close another Claude task before opening this one"),
                    "pressure",
                  ),
                );
              opening.add(input.threadId);
              return Effect.void;
            }),
            () =>
              Effect.sync(() => {
                opening.delete(input.threadId);
              }),
          );
          const { instance, environment } = yield* settings
            .claudeLaunchConfiguration(input.instanceConfigId)
            .pipe(Effect.mapError((cause) => failure("settings", cause)));
          if (
            input.expectedHome &&
            (yield* sdk.nativeHome({
              instance,
              environment: { ...config.environment, ...environment },
            })) !== input.expectedHome
          )
            return yield* failure(
              "binding",
              new Error(
                "The Claude profile changed. Restore this conversation's original profile.",
              ),
              "authorization",
            );
          const scope = yield* Effect.acquireRelease(Scope.fork(ownerScope), (owned) =>
            sessions.get(input.threadId)?.scope === owned
              ? Effect.void
              : Scope.close(owned, Exit.void),
          );
          const handle = yield* makeSession(input, instance, environment).pipe(
            Effect.provideService(ClaudeSdk, sdk),
            Effect.provideService(MainConfig, config),
            Scope.provide(scope),
          );
          yield* SubscriptionRef.changes(handle.snapshot).pipe(
            Stream.mapAccum(
              () => null as AgentConversationSnapshot | null,
              (previous, current) => {
                const delta = previous ? diffAgentConversationSnapshots(previous, current) : null;
                return [current, delta ? [{ threadId: input.threadId, delta }] : []] as const;
              },
            ),
            Stream.runForEach((event) => PubSub.publish(changes, event).pipe(Effect.asVoid)),
            Effect.forkIn(scope),
          );
          sessions.set(input.threadId, { handle, scope, instanceId: instance.id });
          if (!observed.has(input.threadId))
            yield* FiberMap.run(evictions, input.threadId, evict(input.threadId));
          return handle;
        }),
      ),
    get: (id) => Effect.sync(() => sessions.get(id)?.handle ?? null),
    close,
    observe: (id) =>
      Effect.sync(() => observed.add(id)).pipe(
        Effect.andThen(FiberMap.remove(evictions, id)),
        Effect.asVoid,
      ),
    unobserve: (id) =>
      Effect.sync(() => observed.delete(id)).pipe(
        Effect.andThen(FiberMap.run(evictions, id, evict(id))),
        Effect.asVoid,
      ),
    changes: Stream.fromPubSub(changes),
  });
});
export const live = Layer.effect(ClaudeSessionManager, make);
