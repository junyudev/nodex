import type {
  Event,
  Message,
  PermissionRequest,
  PermissionRuleset,
  QuestionRequest,
  ToolPart,
} from "@opencode-ai/sdk/v2";
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
import type { AgentBackendSessionChangedEvent } from "../../../shared/agent-backend-api";
import type { AgentModelCatalog } from "../../../shared/agent-model-catalog";
import type {
  AgentConversationSnapshot,
  AgentConversationTurn,
  AgentInteractionRequest,
  AgentSessionMetadata,
} from "../../../shared/agent-conversation";
import { boundAgentToolOutput } from "../../../shared/agent-tool-output";
import { createUuidV7 } from "../../../shared/uuid-v7";
import { MainConfig } from "../../app/MainConfig";
import {
  applyCodexWorktreeShellEnvironment,
  type CodexStoredShellEnvironment,
} from "../../codex/codex-worktree-shell-environment";
import { ApplicationSettings } from "../../settings/ApplicationSettings";
import {
  OpenCodeSdk,
  type OpenCodeConnection,
  type OpenCodeInventory,
  type OpenCodeLaunchInput,
} from "../../platform/node/OpenCodeSdk";
import { AgentRuntimeError, agentRuntimeError } from "../AgentRuntimeError";
import type { AgentSessionHandle, AgentSessionPermissionPolicy } from "../AgentSessionHandle";
import {
  applyAgentHistoryFacts,
  beginAgentConversationTurn,
  closeAgentConversation,
  completeAgentConversationTurn,
  diffAgentConversationSnapshots,
  emptyAgentConversationSnapshot,
  failAgentConversation,
  reduceAgentConversationEvent,
  updateAgentSessionMetadata,
} from "../AgentConversationProjection";
import {
  openCodeCatalog,
  openCodeConfigOptions,
  openCodeConnectedModels,
  openCodeDefaultModel,
  openCodeModes,
  splitOpenCodeModel,
  type OpenCodeSelection,
} from "./OpenCodeModels";
import {
  openCodeMessageUsage,
  openCodePartUpdate,
  prependOpenCodeHistory,
  projectOpenCodeHistory,
} from "./OpenCodeConversationProjection";

export interface OpenCodeLaunchContext {
  readonly systemPromptAppend?: string;
  readonly servers?: Readonly<
    Record<
      string,
      {
        readonly command: string;
        readonly args?: readonly string[];
        readonly environment?: Readonly<Record<string, string>>;
      }
    >
  >;
}
export interface OpenOpenCodeSessionInput {
  readonly threadId: string;
  readonly instanceConfigId: string;
  readonly workspaceRoot: string;
  readonly permissionPolicy: AgentSessionPermissionPolicy;
  readonly resumeSessionId?: string;
  readonly expectedHome?: string;
  readonly model?: string | null;
  readonly configOptions?: readonly { readonly id: string; readonly value: string | boolean }[];
  readonly modeId?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly workspaceEnvironment?: CodexStoredShellEnvironment | null;
  readonly nativeMcp?: OpenCodeLaunchContext;
  readonly acquireLaunchContext?: (
    workspaceRoot: string,
  ) => Effect.Effect<OpenCodeLaunchContext, AgentRuntimeError, Scope.Scope>;
  readonly restoredTurns?: readonly AgentConversationTurn[];
  readonly historyFacts?: Parameters<typeof applyAgentHistoryFacts>[1];
  readonly onTurnAdmitted?: (input: {
    readonly sequence: number;
    readonly clientUserMessageId: string;
    readonly text: string;
  }) => Effect.Effect<void, AgentRuntimeError>;
  readonly onTurnCompleted?: (input: {
    readonly clientUserMessageId: string;
  }) => Effect.Effect<void, AgentRuntimeError>;
  readonly onBackgroundTasksChanged?: (
    liveTaskIds: readonly string[],
  ) => Effect.Effect<void, AgentRuntimeError>;
  readonly onTurnSettled?: (input: {
    readonly sequence: number;
    readonly clientUserMessageIds: readonly string[];
    readonly stopReason: string;
    readonly status: "completed" | "cancelled" | "failed";
    readonly error?: string;
    readonly nativeSessionId: string;
    readonly everSaved: boolean;
  }) => Effect.Effect<void, AgentRuntimeError>;
}
export class OpenCodeSessionManager extends Context.Service<
  OpenCodeSessionManager,
  {
    readonly nativeHome: (instanceConfigId: string) => Effect.Effect<string, AgentRuntimeError>;
    readonly open: (
      input: OpenOpenCodeSessionInput,
    ) => Effect.Effect<AgentSessionHandle, AgentRuntimeError>;
    readonly discover: (input: {
      readonly instanceConfigId: string;
      readonly workspaceRoot: string;
      readonly workspaceEnvironment?: CodexStoredShellEnvironment | null;
      readonly forceReload?: boolean;
    }) => Effect.Effect<AgentModelCatalog, AgentRuntimeError>;
    readonly get: (threadId: string) => Effect.Effect<AgentSessionHandle | null>;
    readonly close: (threadId: string) => Effect.Effect<void>;
    readonly observe: (threadId: string) => Effect.Effect<void>;
    readonly unobserve: (threadId: string) => Effect.Effect<void>;
    readonly changes: Stream.Stream<AgentBackendSessionChangedEvent>;
  }
>()("nodex/main/agent-backend/opencode/OpenCodeSessionManager") {}

const failure = (
  operation: string,
  message: string,
  reason: AgentRuntimeError["reason"] = "request",
) =>
  new AgentRuntimeError({ message, operation: `opencode.${operation}`, reason, retryable: false });
const permissions = (policy: AgentSessionPermissionPolicy): PermissionRuleset =>
  policy === "full-access"
    ? [{ permission: "*", pattern: "*", action: "allow" }]
    : [
        { permission: "*", pattern: "*", action: "ask" },
        ...(["read", "glob", "grep", "list", "lsp", "skill", "todowrite", "todoread"] as const).map(
          (permission) => ({ permission, pattern: "*", action: "allow" as const }),
        ),
        { permission: "read", pattern: "*.env", action: "ask" },
        { permission: "read", pattern: "*.env.*", action: "ask" },
      ];
const capabilities: AgentSessionHandle["capabilities"] = {
  controls: { compact: true, fork: true },
  prompt: { text: true, resourceLink: true, image: true, audio: false, embeddedContext: false },
  session: {
    load: true,
    list: false,
    delete: false,
    resume: true,
    unstableFork: true,
    close: true,
    additionalDirectories: false,
  },
  authMethods: [],
};
const permissionRequest = (request: PermissionRequest): AgentInteractionRequest => ({
  id: request.id,
  toolName: request.permission,
  title: request.permission,
  detail: request.patterns.join("\n"),
  toolUseId: request.tool?.callID,
  constraints: { allowForSession: false, suppressAlwaysAllowRule: true },
  questions: [],
});
const questionRequest = (request: QuestionRequest): AgentInteractionRequest => ({
  id: request.id,
  toolName: "question",
  title: "Question",
  detail: "",
  toolUseId: request.tool?.callID,
  questions: request.questions.map((question, index) => ({
    id: String(index),
    question: question.question,
    header: question.header,
    multiSelect: question.multiple ?? false,
    options: question.options,
  })),
});
const questionAnswers = (value: string, multiple: boolean): string[] => {
  if (!multiple) return [value];
  try {
    const answers: unknown = JSON.parse(value);
    if (Array.isArray(answers) && answers.every((answer) => typeof answer === "string"))
      return answers;
  } catch {
    /* The renderer also accepts a single freeform answer. */
  }
  return [value];
};

const makeSession = Effect.fn("OpenCodeSessionManager.makeSession")(function* (
  input: OpenOpenCodeSessionInput,
  connection: OpenCodeConnection,
  inventory: OpenCodeInventory,
  launch: OpenCodeLaunchContext,
) {
  const scope = yield* Scope.Scope;
  const controls = yield* Semaphore.make(1);
  const sessionId =
    input.resumeSessionId ??
    (yield* connection.createSession(permissions(input.permissionPolicy))).id;
  if (input.resumeSessionId) {
    const session = yield* connection.session(sessionId);
    if (session.directory !== input.workspaceRoot)
      return yield* Effect.fail(
        failure("resume", "This native session belongs to another workspace", "authorization"),
      );
    yield* connection.setPermissions(sessionId, permissions(input.permissionPolicy));
  }
  let policy = input.permissionPolicy;
  let selection: OpenCodeSelection = {
    model: input.model ?? openCodeDefaultModel(inventory) ?? "",
    variant: "",
    agent: openCodeModes(inventory, input.modeId)?.currentModeId ?? "",
  };
  for (const option of input.configOptions ?? []) {
    if (option.id === "variant" && typeof option.value === "string")
      selection = { ...selection, variant: option.value };
    if (option.id === "model" && typeof option.value === "string")
      selection = { ...selection, model: option.value };
    if (option.id === "agent" && typeof option.value === "string")
      selection = { ...selection, agent: option.value };
  }
  const selectedNativeModel = () =>
    openCodeConnectedModels(inventory).find(
      (candidate) => `${candidate.providerID}/${candidate.id}` === selection.model,
    );
  const validateSelection = Effect.suspend(() => {
    if (!splitOpenCodeModel(selection.model))
      return Effect.fail(failure("model", "Choose a configured OpenCode model", "capability"));
    const native = selectedNativeModel();
    if (!native)
      return Effect.fail(
        failure(
          "model",
          `The configured OpenCode providers do not expose ${selection.model}`,
          "capability",
        ),
      );
    if (selection.variant && !Object.hasOwn(native.variants ?? {}, selection.variant))
      return Effect.fail(
        failure(
          "variant",
          `OpenCode does not advertise variant ${selection.variant} for ${selection.model}`,
          "capability",
        ),
      );
    if (
      selection.agent &&
      !openCodeModes(inventory)?.availableModes.some((mode) => mode.id === selection.agent)
    )
      return Effect.fail(
        failure("agent", `OpenCode does not advertise agent ${selection.agent}`, "capability"),
      );
    return Effect.void;
  });
  const readHistory = Effect.fn("OpenCodeSessionManager.readHistory")(function* (page: {
    readonly before?: string;
    readonly limit: number;
  }) {
    const loaded = yield* connection.history(sessionId, page);
    const first = loaded.messages[0]?.info;
    if (
      first?.role !== "assistant" ||
      loaded.messages.some((message) => message.info.id === first.parentID)
    )
      return loaded;
    const parent = yield* connection.message(sessionId, first.parentID).pipe(
      Effect.catchIf(
        (error) => error.reason === "resource-not-found",
        () => Effect.succeed(null),
      ),
    );
    return parent?.info.role === "user"
      ? { ...loaded, messages: [parent, ...loaded.messages] }
      : loaded;
  });
  const historyPage = yield* readHistory({ limit: 200 });
  const nativeHistory = historyPage.messages;
  let initial = applyAgentHistoryFacts(
    projectOpenCodeHistory(
      emptyAgentConversationSnapshot({ backend: "opencode", threadId: input.threadId, sessionId }),
      nativeHistory,
      selectedNativeModel()?.limit.context ?? 0,
    ),
    input.historyFacts ?? [],
  );
  initial = {
    ...initial,
    history: {
      hasOlder: historyPage.hasMore,
      oldestSequence: initial.turns[0]?.sequence ?? null,
      ...(historyPage.cursor ? { cursor: historyPage.cursor } : {}),
      windowSize: 512,
    },
  };
  const snapshot = yield* SubscriptionRef.make(initial);
  const metadata = (): Omit<AgentSessionMetadata, "revision"> => ({
    capabilities,
    configOptions: openCodeConfigOptions(inventory, selection),
    modes: openCodeModes(inventory, selection.agent),
    effectiveSelection: {
      model: selection.model || null,
      effort: selection.variant || null,
      permissionMode: policy,
    },
    commands: inventory.commands.map((command) => ({
      name: command.name,
      description: command.description ?? "",
      inputHint: null,
    })),
  });
  const publishMetadata = SubscriptionRef.update(snapshot, (present) =>
    updateAgentSessionMetadata(present, metadata()),
  );
  yield* publishMetadata;
  const messageTurns = new Map<string, { sequence: number; role: Message["role"] }>();
  for (const message of nativeHistory) {
    const nativeId = message.info.role === "user" ? message.info.id : message.info.parentID;
    const turn = initial.turns.find((turn) => turn.nativeUserMessageId === nativeId);
    if (turn?.sequence !== null && turn?.sequence !== undefined)
      messageTurns.set(message.info.id, { sequence: turn.sequence, role: message.info.role });
  }
  const related = new Set<string>([sessionId]);
  const foreign = new Set<string>();
  const requests = new Map<string, PermissionRequest | QuestionRequest>();
  const busyDescendants = new Set<string>();
  const pendingDescendants = new Set<string>();
  const runningTasks = new Set<string>();
  let unadmittedNativeTurn = false;
  let backgroundRevision = 0;
  let publishedBackground = "";
  let nextSequence = Math.max(0, ...initial.turns.map((turn) => turn.sequence ?? 0));
  let cancellationInFlight = false;
  let runtimeError: AgentRuntimeError | null = null;
  let active: {
    readonly sequence: number;
    readonly clientId: string;
    readonly nativeId: string;
    readonly completion: Deferred.Deferred<{ stopReason: string }, AgentRuntimeError>;
    admitted: boolean;
    seen: boolean;
    idle: boolean;
    cancelled: boolean;
    settling: boolean;
  } | null = null;
  const publishRequests = SubscriptionRef.update(snapshot, (present) => ({
    ...present,
    requests: [...requests.values()].map((request) =>
      "permission" in request ? permissionRequest(request) : questionRequest(request),
    ),
    revision: present.revision + 1,
  }));
  const isRelated = Effect.fn("OpenCodeSessionManager.related")(function* (id: string) {
    if (related.has(id)) return true;
    if (foreign.has(id)) return false;
    let cursor = id;
    const ancestors = [id];
    for (let depth = 0; depth < 32; depth += 1) {
      const session = yield* connection.session(cursor).pipe(
        Effect.catchIf(
          (error) => error.reason === "resource-not-found",
          () => Effect.succeed(null),
        ),
      );
      if (!session) break;
      if (!session.parentID) break;
      if (related.has(session.parentID)) {
        for (const ancestor of ancestors) related.add(ancestor);
        for (const known of related) {
          if (related.size <= 256) break;
          if (known === sessionId || busyDescendants.has(known) || pendingDescendants.has(known))
            continue;
          related.delete(known);
        }
        return true;
      }
      if (ancestors.includes(session.parentID)) break;
      if (depth === 31) {
        unadmittedNativeTurn = true;
        yield* publishBackground;
        return yield* failure("background-tasks", "OpenCode's native session ancestry is too deep");
      }
      cursor = session.parentID;
      ancestors.push(cursor);
    }
    foreign.add(id);
    if (foreign.size > 256) foreign.delete(foreign.values().next().value!);
    return false;
  });
  // Native MCP does not identify the calling session. Revoke foreground claims before
  // related task execution, including work resumed without a host-admitted prompt.
  const publishBackground = Effect.gen(function* () {
    const ids = [...new Set([...busyDescendants, ...pendingDescendants, ...runningTasks])];
    if (unadmittedNativeTurn) ids.push(`native-turn:${sessionId}`);
    const key = ids.sort().join("\n");
    if (key === publishedBackground) return;
    yield* input.onBackgroundTasksChanged?.(ids) ?? Effect.void;
    publishedBackground = key;
  });
  const addBackground = Effect.fn("OpenCodeSessionManager.addBackground")(function* (
    target: Set<string>,
    id: string,
  ) {
    if (target.has(id)) return;
    if (busyDescendants.size + pendingDescendants.size + runningTasks.size >= 128) {
      unadmittedNativeTurn = true;
      yield* publishBackground;
      return yield* failure("background-tasks", "OpenCode has too many active native tasks");
    }
    target.add(id);
    backgroundRevision += 1;
    yield* publishBackground;
  });
  const refreshBackground = Effect.fn("OpenCodeSessionManager.refreshBackground")(function* () {
    const revision = backgroundRevision;
    const statuses = yield* connection.sessionStatuses;
    // Do not remove a status that changed while the HTTP snapshot was in flight.
    if (revision === backgroundRevision) {
      const rootStatus = statuses[sessionId];
      unadmittedNativeTurn = !active && rootStatus !== undefined && rootStatus.type !== "idle";
      for (const id of busyDescendants) {
        if (statuses[id]?.type === "busy" || statuses[id]?.type === "retry") continue;
        busyDescendants.delete(id);
      }
    }
    for (const [id, status] of Object.entries(statuses)) {
      if (id === sessionId || status.type === "idle" || !(yield* isRelated(id))) continue;
      pendingDescendants.delete(id);
      yield* addBackground(busyDescendants, id);
    }
    yield* publishBackground;
  });
  const observeTask = Effect.fn("OpenCodeSessionManager.observeTask")(function* (part: ToolPart) {
    if (part.tool !== "task" || !(yield* isRelated(part.sessionID))) return;
    const id = `task:${part.sessionID}:${part.callID}`;
    if (part.state.status === "pending" || part.state.status === "running") {
      yield* addBackground(runningTasks, id);
      return;
    }
    // Background tool completion precedes child completion. Its native session must
    // stay blocked until verified idle/deletion, even when the foreground turn ends.
    const metadata = part.state.metadata;
    const childId = metadata?.sessionId;
    if (
      metadata?.background === true &&
      typeof childId === "string" &&
      childId !== sessionId &&
      !busyDescendants.has(childId) &&
      (yield* isRelated(childId))
    )
      yield* addBackground(pendingDescendants, childId);
    if (runningTasks.delete(id)) backgroundRevision += 1;
    yield* publishBackground;
  });
  const settle = Effect.fn("OpenCodeSessionManager.settle")(function* (
    error: AgentRuntimeError | undefined,
  ) {
    const turn = active;
    if (!turn || turn.settling) return;
    turn.settling = true;
    requests.clear();
    const cancelled = turn.cancelled || error?.reason === "closing";
    const status = cancelled ? "cancelled" : error ? "failed" : "completed";
    const stopReason = cancelled ? "cancelled" : error ? "error" : "end_turn";
    yield* SubscriptionRef.update(snapshot, (present) =>
      completeAgentConversationTurn(present, turn.sequence, {
        status,
        stopReason,
        error: status === "failed" ? (error?.message ?? null) : null,
        ...(error ? { authenticationRequired: error.reason === "authentication-required" } : {}),
      }),
    );
    const persisted = yield* (
      input.onTurnSettled?.({
        sequence: turn.sequence,
        clientUserMessageIds: [turn.clientId],
        stopReason,
        status,
        ...(error ? { error: error.message } : {}),
        nativeSessionId: sessionId,
        everSaved: true,
      }) ?? Effect.void
    ).pipe(Effect.exit);
    const revoked = yield* (
      input.onTurnCompleted?.({ clientUserMessageId: turn.clientId }) ?? Effect.void
    ).pipe(Effect.exit);
    if (active === turn) active = null;
    if (Exit.isFailure(persisted) || Exit.isFailure(revoked)) {
      yield* Deferred.fail(
        turn.completion,
        failure("persist-turn", "The turn finished but its durable outcome could not be saved"),
      );
      return;
    }
    if (error) {
      yield* Deferred.fail(turn.completion, error);
      return;
    }
    yield* Deferred.succeed(turn.completion, { stopReason });
  }, Effect.uninterruptible);
  const observeRequest = Effect.fn("OpenCodeSessionManager.request")(function* (
    request: PermissionRequest | QuestionRequest,
  ) {
    if (!(yield* isRelated(request.sessionID))) return;
    if ("permission" in request && policy === "full-access") {
      yield* connection.replyPermission(request.id, "once");
      return;
    }
    requests.set(request.id, request);
    yield* publishRequests;
  });
  const receive = Effect.fn("OpenCodeSessionManager.receive")(function* (event: Event) {
    if (event.type === "session.created") {
      const child = event.properties.info;
      if (child.id === sessionId || !(yield* isRelated(child.id))) return;
      yield* addBackground(pendingDescendants, child.id);
      return;
    }
    if (event.type === "session.deleted") {
      const id = event.properties.info.id;
      if (id === sessionId || !related.has(id)) return;
      busyDescendants.delete(id);
      pendingDescendants.delete(id);
      for (const task of runningTasks) {
        if (task.startsWith(`task:${id}:`)) runningTasks.delete(task);
      }
      related.delete(id);
      backgroundRevision += 1;
      yield* publishBackground;
      return;
    }
    if (event.type === "session.compacted") {
      if (event.properties.sessionID !== sessionId) return;
      yield* SubscriptionRef.update(snapshot, (present) =>
        reduceAgentConversationEvent(present, {
          kind: "session_update",
          turnSequence: active?.sequence ?? present.turns.at(-1)?.sequence ?? null,
          update: {
            kind: "compaction",
            key: `compaction:${event.id}`,
            compactionId: event.id,
            status: "completed",
            summary: "",
            error: null,
          },
        }),
      );
      return;
    }
    if (event.type === "permission.asked" || event.type === "question.asked") {
      yield* observeRequest(event.properties);
      return;
    }
    if (
      event.type === "permission.replied" ||
      event.type === "question.replied" ||
      event.type === "question.rejected"
    ) {
      if (requests.delete(event.properties.requestID)) yield* publishRequests;
      return;
    }
    if (event.type === "session.error") {
      if (event.properties.sessionID !== sessionId) return;
      const native = event.properties.error;
      const message =
        native && "data" in native && "message" in native.data
          ? String(native.data.message)
          : "OpenCode could not complete the turn";
      yield* settle(
        failure(
          "turn",
          message,
          native?.name === "ProviderAuthError" ? "authentication-required" : "request",
        ),
      );
      return;
    }
    if (event.type === "session.status" || event.type === "session.idle") {
      const id = event.properties.sessionID;
      const busy = event.type === "session.status" && event.properties.status.type !== "idle";
      if (id !== sessionId) {
        if (!(yield* isRelated(id))) return;
        pendingDescendants.delete(id);
        if (busy) yield* addBackground(busyDescendants, id);
        else busyDescendants.delete(id);
        backgroundRevision += 1;
        yield* publishBackground;
        return;
      }
      if (!busy) unadmittedNativeTurn = false;
      else if (!active) unadmittedNativeTurn = true;
      backgroundRevision += 1;
      yield* publishBackground;
      if (!active) return;
      if (busy) {
        active.seen = true;
        active.idle = false;
        return;
      }
      if (!active.seen) return;
      active.idle = true;
      if (active.admitted && active.seen) yield* settle(undefined);
      return;
    }
    if (event.type === "message.updated") {
      const message = event.properties.info;
      if (!(yield* isRelated(message.sessionID))) return;
      if (
        message.sessionID === sessionId &&
        message.role === "user" &&
        message.id !== active?.nativeId &&
        !messageTurns.has(message.id)
      ) {
        unadmittedNativeTurn = true;
        backgroundRevision += 1;
        yield* publishBackground;
      }
      let turnSequence =
        message.role === "user"
          ? messageTurns.get(message.id)?.sequence
          : messageTurns.get(message.parentID)?.sequence;
      if (message.sessionID !== sessionId) turnSequence = active?.sequence;
      if (turnSequence === undefined) return;
      messageTurns.set(message.id, { sequence: turnSequence, role: message.role });
      if (messageTurns.size > 2048) messageTurns.delete(messageTurns.keys().next().value!);
      if (active?.sequence === turnSequence) active.seen = true;
      if (
        message.role === "assistant" &&
        message.error?.name === "MessageAbortedError" &&
        active?.sequence === turnSequence
      )
        active.cancelled = true;
      const update = openCodeMessageUsage(message, selectedNativeModel()?.limit.context ?? 0);
      if (update)
        yield* SubscriptionRef.update(snapshot, (present) =>
          reduceAgentConversationEvent(present, { kind: "session_update", turnSequence, update }),
        );
      if (
        message.role === "assistant" &&
        message.error &&
        message.error.name !== "MessageAbortedError" &&
        message.sessionID === sessionId
      ) {
        const detail =
          "message" in message.error.data ? String(message.error.data.message) : message.error.name;
        yield* settle(
          failure(
            "turn",
            detail,
            message.error.name === "ProviderAuthError" ? "authentication-required" : "request",
          ),
        );
      }
      return;
    }
    if (event.type === "message.part.updated") {
      const part = event.properties.part;
      if (part.type === "tool") yield* observeTask(part);
      const message = messageTurns.get(part.messageID);
      if (!message || message.role === "user") return;
      const update = openCodePartUpdate(
        part,
        part.sessionID === sessionId ? undefined : { taskId: part.sessionID },
      );
      if (update)
        yield* SubscriptionRef.update(snapshot, (present) =>
          reduceAgentConversationEvent(present, {
            kind: "session_update",
            turnSequence: message.sequence,
            update,
          }),
        );
      return;
    }
    if (event.type === "message.part.delta") {
      const part = event.properties;
      const message = messageTurns.get(part.messageID);
      if (!message || message.role === "user" || part.field !== "text") return;
      yield* SubscriptionRef.update(snapshot, (present) => {
        const old = present.turns
          .find((turn) => turn.sequence === message.sequence)
          ?.updates.find((update) => update.key === `opencode:${part.partID}`);
        const role = old?.kind === "message" ? old.role : "agent";
        return reduceAgentConversationEvent(present, {
          kind: "session_update",
          turnSequence: message.sequence,
          append: true,
          update: {
            kind: "message",
            key: `opencode:${part.partID}`,
            messageId: part.messageID,
            text: part.delta,
            role,
            ...(part.sessionID === sessionId ? {} : { actor: { taskId: part.sessionID } }),
          },
        });
      });
    }
  });
  const runtimeFailure = Effect.fn("OpenCodeSessionManager.runtimeFailure")(function* (
    error: AgentRuntimeError,
  ) {
    runtimeError = error;
    yield* settle(error);
    yield* SubscriptionRef.update(snapshot, (present) => failAgentConversation(present, error));
  });
  yield* connection.events.pipe(
    Stream.runForEach(receive),
    Effect.catch((error) => runtimeFailure(error)),
    Effect.forkIn(scope),
  );
  yield* connection.termination.pipe(
    Effect.catch((error) => runtimeFailure(error)),
    Effect.forkIn(scope),
  );
  yield* connection.ready;
  yield* refreshBackground();
  const [pendingPermissions, pendingQuestions] = yield* Effect.all(
    [connection.pendingPermissions, connection.pendingQuestions],
    { concurrency: 2 },
  );
  for (const request of [...pendingPermissions, ...pendingQuestions])
    yield* observeRequest(request);
  const requireIdle = Effect.suspend(() =>
    runtimeError
      ? Effect.fail(failure("control", runtimeError.message, "closing"))
      : active || cancellationInFlight
        ? Effect.fail(failure("control", "Wait for the current turn to finish", "authorization"))
        : SubscriptionRef.get(snapshot).pipe(
            Effect.flatMap((present) =>
              present.status === "closed" || present.status === "failed"
                ? Effect.fail(failure("control", "The OpenCode runtime is closed", "closing"))
                : Effect.void,
            ),
          ),
  );
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const turn = active;
      if (turn) yield* settle(failure("close", "The OpenCode runtime was closed", "closing"));
      busyDescendants.clear();
      pendingDescendants.clear();
      runningTasks.clear();
      unadmittedNativeTurn = false;
      yield* publishBackground;
      yield* SubscriptionRef.update(snapshot, closeAgentConversation);
    }).pipe(Effect.orDie),
  );
  const setOption = (id: string, value: string | boolean) =>
    controls.withPermits(1)(
      Effect.gen(function* () {
        yield* requireIdle;
        if (typeof value !== "string" || !["model", "variant", "agent"].includes(id))
          return yield* Effect.fail(
            failure("config", `Unsupported OpenCode option ${id}`, "capability"),
          );
        const previous = selection;
        selection =
          id === "model"
            ? { ...selection, model: value, variant: "" }
            : { ...selection, [id]: value };
        yield* validateSelection.pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              selection = previous;
            }),
          ),
        );
        yield* publishMetadata;
        return openCodeConfigOptions(inventory, selection);
      }),
    );
  const handle: AgentSessionHandle = {
    threadId: input.threadId,
    get sessionId() {
      return sessionId;
    },
    capabilities,
    get modes() {
      return openCodeModes(inventory, selection.agent);
    },
    get configOptions() {
      return openCodeConfigOptions(inventory, selection);
    },
    snapshot,
    prompt: (text, options) =>
      Effect.gen(function* () {
        const completion = yield* controls.withPermits(1)(
          Effect.gen(function* () {
            yield* requireIdle;
            yield* refreshBackground();
            yield* validateSelection;
            if (options?.images?.length && !selectedNativeModel()?.capabilities.input.image)
              return yield* Effect.fail(
                failure(
                  "prompt",
                  "The selected OpenCode model does not support images",
                  "capability",
                ),
              );
            const sequence = nextSequence + 1;
            const clientId = options?.clientUserMessageId ?? createUuidV7();
            const nativeId = yield* connection.nextMessageId;
            const completion = yield* Deferred.make<{ stopReason: string }, AgentRuntimeError>();
            yield* (
              input.onTurnAdmitted?.({ sequence, clientUserMessageId: clientId, text }) ??
                Effect.void
            );
            nextSequence = sequence;
            active = {
              sequence,
              clientId,
              nativeId,
              completion,
              admitted: false,
              seen: false,
              idle: false,
              cancelled: false,
              settling: false,
            };
            messageTurns.set(nativeId, { sequence, role: "user" });
            yield* SubscriptionRef.update(snapshot, (present) => {
              const started = beginAgentConversationTurn(present, sequence, text, clientId);
              return {
                ...started,
                turns: started.turns.map((turn) =>
                  turn.sequence === sequence ? { ...turn, nativeUserMessageId: nativeId } : turn,
                ),
              };
            });
            yield* connection
              .prompt({
                sessionId,
                messageId: nativeId,
                text,
                ...(() => {
                  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/u.exec(text.trim());
                  return match && inventory.commands.some((command) => command.name === match[1])
                    ? { command: { name: match[1]!, arguments: match[2] ?? "" } }
                    : {};
                })(),
                model: splitOpenCodeModel(selection.model)!,
                ...(selection.variant ? { variant: selection.variant } : {}),
                ...(selection.agent ? { agent: selection.agent } : {}),
                ...(launch.systemPromptAppend ? { system: launch.systemPromptAppend } : {}),
                ...(options?.images ? { images: options.images } : {}),
              })
              .pipe(
                Effect.catch((error) =>
                  active?.completion === completion ? settle(error) : Effect.void,
                ),
              );
            if (active?.completion === completion) {
              active.admitted = true;
              if (active.idle && active.seen) yield* settle(undefined);
            }
            return completion;
          }),
        );
        return yield* Deferred.await(completion);
      }),
    cancel: Effect.gen(function* () {
      if (!active || cancellationInFlight) return;
      const turn = active;
      cancellationInFlight = true;
      turn.cancelled = true;
      try {
        const children = yield* connection.children(sessionId);
        yield* Effect.forEach(children, (child) => connection.abort(child.id), {
          concurrency: 4,
          discard: true,
        });
        yield* connection.abort(sessionId);
        if (active === turn) yield* settle(undefined);
      } finally {
        cancellationInFlight = false;
      }
    }),
    setPermissionPolicy: (next) =>
      controls.withPermits(1)(
        connection.setPermissions(sessionId, permissions(next)).pipe(
          Effect.andThen(
            Effect.sync(() => {
              policy = next;
            }),
          ),
          Effect.andThen(
            Effect.gen(function* () {
              if (next !== "full-access") return;
              for (const request of requests.values()) {
                if (!("permission" in request)) continue;
                yield* connection.replyPermission(request.id, "once");
                requests.delete(request.id);
              }
              yield* publishRequests;
            }),
          ),
          Effect.andThen(publishMetadata),
        ),
      ),
    setMode: (id) => setOption("agent", id).pipe(Effect.asVoid),
    setConfigOption: setOption,
    respond: (requestId, response) =>
      Effect.gen(function* () {
        const request = requests.get(requestId);
        if (!request)
          return yield* Effect.fail(
            failure("respond", "This OpenCode request is no longer pending", "resource-not-found"),
          );
        if ("permission" in request) {
          if (response.decision !== "allow" && response.decision !== "deny")
            return yield* Effect.fail(
              failure("respond", "OpenCode supports approving this request once", "capability"),
            );
          yield* connection.replyPermission(
            requestId,
            response.decision === "allow" ? "once" : "reject",
          );
        } else if (response.decision === "answer") {
          const answers: string[][] = [];
          for (const [index, question] of request.questions.entries()) {
            const value = response.answers[String(index)];
            if (!value?.trim())
              return yield* failure(
                "respond",
                "Answer every OpenCode question before submitting",
                "authorization",
              );
            const selected = questionAnswers(value, question.multiple ?? false);
            if (
              !selected.length ||
              (question.custom === false &&
                selected.some(
                  (answer) => !question.options.some((option) => option.label === answer),
                ))
            )
              return yield* failure(
                "respond",
                "Choose one of the advertised OpenCode answers",
                "authorization",
              );
            answers.push(selected);
          }
          yield* connection.replyQuestion(requestId, answers);
        } else if (response.decision === "deny") {
          yield* connection.rejectQuestion(requestId);
        } else {
          return yield* Effect.fail(
            failure("respond", "Answer or dismiss this OpenCode question", "capability"),
          );
        }
        requests.delete(requestId);
        yield* publishRequests;
      }),
    loadHistory: (page) =>
      controls.withPermits(1)(
        Effect.gen(function* () {
          yield* requireIdle;
          const present = yield* SubscriptionRef.get(snapshot);
          const before = page?.before ?? present.history?.cursor;
          if (!before || !present.history?.hasOlder || present.history.windowFull)
            return { messages: [], before: null, hasMore: false };
          const limit = Math.min(200, Math.max(1, page?.limit ?? 200));
          const loaded = yield* readHistory({ before, limit });
          const messages = loaded.messages;
          const older = applyAgentHistoryFacts(
            projectOpenCodeHistory(
              emptyAgentConversationSnapshot({
                backend: "opencode",
                threadId: input.threadId,
                sessionId,
              }),
              messages,
            ),
            input.historyFacts ?? [],
          );
          const cursor = loaded.cursor;
          yield* SubscriptionRef.update(snapshot, (current) =>
            prependOpenCodeHistory(current, older, loaded.hasMore, cursor ?? undefined),
          );
          return { messages: [], before: cursor, hasMore: loaded.hasMore };
        }),
      ),
    readHistoryImage: (nativeMessageId, index) =>
      Effect.gen(function* () {
        const message = yield* connection.message(sessionId, nativeMessageId);
        const part = message.parts.filter(
          (part) => part.type === "file" && part.mime.startsWith("image/"),
        )[index];
        if (!part || part.type !== "file")
          return yield* Effect.fail(
            failure("image", "This native image is unavailable", "resource-not-found"),
          );
        const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)$/u.exec(
          part.url,
        );
        if (!match)
          return yield* Effect.fail(
            failure("image", "The native image is not stored as an embedded image", "capability"),
          );
        return {
          mediaType: match[1] as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
          data: match[2]!,
        };
      }),
    readHistoryToolOutput: (nativeMessageId, toolUseId) =>
      Effect.gen(function* () {
        const message = yield* connection.message(sessionId, nativeMessageId);
        const part = message.parts.find(
          (part) => part.type === "tool" && part.callID === toolUseId,
        );
        if (!part || part.type !== "tool" || part.state.status !== "completed")
          return yield* Effect.fail(
            failure("tool-output", "This native tool output is unavailable", "resource-not-found"),
          );
        return boundAgentToolOutput(part.state.output);
      }),
    forkAt: (nativeMessageId) =>
      controls.withPermits(1)(
        requireIdle.pipe(
          Effect.andThen(connection.fork(sessionId, nativeMessageId)),
          Effect.map((forked) => ({ sessionId: forked.id })),
        ),
      ),
    compact: controls.withPermits(1)(
      requireIdle.pipe(
        Effect.andThen(validateSelection),
        Effect.andThen(
          Effect.suspend(() => connection.compact(sessionId, splitOpenCodeModel(selection.model)!)),
        ),
      ),
    ),
  };
  return handle;
});

export const make = Effect.gen(function* () {
  const settings = yield* ApplicationSettings;
  const sdk = yield* OpenCodeSdk;
  const config = yield* MainConfig;
  const ownerScope = yield* Scope.Scope;
  const changes = yield* PubSub.sliding<AgentBackendSessionChangedEvent>(256);
  const entries = new Map<
    string,
    {
      readonly handle: AgentSessionHandle;
      readonly scope: Scope.Scope;
      readonly instanceId: string;
      readonly cwd: string;
      readonly profileDirectory: string;
    }
  >();
  const observed = new Set<string>();
  const evictions = yield* FiberMap.make<string>();
  const lanes = yield* RcMap.make({ lookup: () => Semaphore.make(1) });
  const exclusive = <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) =>
    Effect.scoped(RcMap.get(lanes, id).pipe(Effect.flatMap((lane) => lane.withPermits(1)(effect))));
  const launchInput = Effect.fn("OpenCodeSessionManager.launchInput")(function* (
    instanceId: string,
    cwd: string,
    environment?: Readonly<Record<string, string>>,
    workspaceEnvironment?: CodexStoredShellEnvironment | null,
  ) {
    const launch = yield* settings.openCodeLaunchConfiguration(instanceId).pipe(
      Effect.mapError((cause) =>
        agentRuntimeError({
          operation: "opencode.settings",
          reason: "initialize",
          retryable: false,
          cause,
        }),
      ),
    );
    if (!launch.instance.enabled)
      return yield* Effect.fail(
        failure("settings", "This OpenCode instance is disabled", "authorization"),
      );
    const base = applyCodexWorktreeShellEnvironment(
      { ...config.environment, ...environment },
      workspaceEnvironment,
      config.platform,
    );
    return {
      binaryPath: launch.instance.binaryPath,
      serverUrl: launch.instance.serverUrl,
      cwd,
      profileDirectory: launch.profileDirectory,
      environment: { ...base, ...launch.environment },
      ...(launch.environment.OPENCODE_SERVER_PASSWORD
        ? { serverPassword: launch.environment.OPENCODE_SERVER_PASSWORD }
        : {}),
      ...(launch.environment.OPENCODE_SERVER_USERNAME
        ? { serverUsername: launch.environment.OPENCODE_SERVER_USERNAME }
        : {}),
    } satisfies OpenCodeLaunchInput;
  });
  const discovery = yield* RcMap.make({
    lookup: (key: string) => sdk.open(JSON.parse(key) as OpenCodeLaunchInput),
    capacity: 32,
    idleTimeToLive: "30 seconds",
  });
  const closeOwned = Effect.fn("OpenCodeSessionManager.closeOwned")(function* (id: string) {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    yield* Scope.close(entry.scope, Exit.void);
  });
  const evict = (id: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* Effect.sleep("2 minutes");
      if (observed.has(id)) return;
      const entry = entries.get(id);
      if (!entry) return;
      const present = yield* SubscriptionRef.get(entry.handle.snapshot);
      if (present.status === "running" || present.requests?.length) {
        yield* evict(id);
        return;
      }
      yield* exclusive(id, closeOwned(id));
    });
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...entries.keys()], closeOwned, { discard: true, concurrency: 4 }),
  );
  return OpenCodeSessionManager.of({
    nativeHome: (instanceId) =>
      settings.openCodeLaunchConfiguration(instanceId).pipe(
        Effect.map((launch) => launch.instance.serverUrl ?? launch.profileDirectory),
        Effect.mapError((cause) =>
          agentRuntimeError({
            operation: "opencode.settings",
            reason: "initialize",
            retryable: false,
            cause,
          }),
        ),
      ),
    discover: (input) =>
      Effect.scoped(
        Effect.gen(function* () {
          const launch = yield* launchInput(
            input.instanceConfigId,
            input.workspaceRoot,
            undefined,
            input.workspaceEnvironment,
          );
          const key = JSON.stringify(launch);
          if (input.forceReload) yield* RcMap.invalidate(discovery, key);
          const connection = yield* RcMap.get(discovery, key).pipe(
            Effect.catchTag("ExceededCapacityError", () =>
              Effect.fail(
                failure(
                  "discover",
                  "Too many OpenCode catalogs are active. Try again shortly",
                  "pressure",
                ),
              ),
            ),
          );
          const inventory = yield* connection.inventory;
          return openCodeCatalog(input.instanceConfigId, inventory);
        }),
      ).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            binding: { kind: "opencode", instanceConfigId: input.instanceConfigId },
            models: [],
            configOptions: [],
            modes: null,
            health: {
              status:
                error.reason === "authentication-required"
                  ? "authentication-required"
                  : "unavailable",
              error: error.message,
            },
            defaultModel: null,
          } satisfies AgentModelCatalog),
        ),
      ),
    open: (input) =>
      exclusive(
        input.threadId,
        Effect.gen(function* () {
          const launch = yield* launchInput(
            input.instanceConfigId,
            input.workspaceRoot,
            input.environment,
            input.workspaceEnvironment,
          );
          const nativeHome = launch.serverUrl ?? launch.profileDirectory;
          if (input.expectedHome && input.expectedHome !== nativeHome)
            return yield* Effect.fail(
              failure(
                "open",
                "The configured native OpenCode owner changed; restore the original profile or server to resume this thread",
                "authorization",
              ),
            );
          const existing = entries.get(input.threadId);
          if (existing) {
            if (
              existing.instanceId !== input.instanceConfigId ||
              existing.cwd !== input.workspaceRoot ||
              existing.profileDirectory !== nativeHome ||
              (input.resumeSessionId && input.resumeSessionId !== existing.handle.sessionId)
            )
              return yield* Effect.fail(
                failure(
                  "open",
                  "The thread is already attached to another OpenCode runtime",
                  "authorization",
                ),
              );
            const present = yield* SubscriptionRef.get(existing.handle.snapshot);
            if (present.status !== "failed" && present.status !== "closed") {
              yield* existing.handle.setPermissionPolicy?.(input.permissionPolicy) ?? Effect.void;
              return existing.handle;
            }
            yield* closeOwned(input.threadId);
          }
          if (entries.size >= 32)
            return yield* Effect.fail(
              failure("open", "Too many OpenCode sessions are open", "pressure"),
            );
          const scope = yield* Effect.acquireRelease(Scope.fork(ownerScope), (scope) =>
            entries.get(input.threadId)?.scope === scope
              ? Effect.void
              : Scope.close(scope, Exit.void),
          );
          const context = yield* Scope.provide(
            input.acquireLaunchContext?.(input.workspaceRoot) ??
              Effect.succeed(input.nativeMcp ?? {}),
            scope,
          );
          const nativeMcp = context.servers
            ? Object.fromEntries(
                Object.entries(context.servers).map(([name, server]) => [
                  name,
                  {
                    type: "local" as const,
                    command: [server.command, ...(server.args ?? [])],
                    ...(server.environment ? { environment: { ...server.environment } } : {}),
                  },
                ]),
              )
            : undefined;
          const connection = yield* Scope.provide(
            sdk.open({ ...launch, ...(nativeMcp ? { nativeMcp } : {}) }),
            scope,
          );
          const inventory = yield* connection.inventory;
          const handle = yield* Scope.provide(
            makeSession(input, connection, inventory, context),
            scope,
          );
          yield* SubscriptionRef.changes(handle.snapshot).pipe(
            Stream.mapAccum(
              () => null as AgentConversationSnapshot | null,
              (previous, next) => {
                const delta = previous ? diffAgentConversationSnapshots(previous, next) : null;
                return [next, delta ? [{ threadId: input.threadId, delta }] : []] as const;
              },
            ),
            Stream.runForEach((event) => PubSub.publish(changes, event).pipe(Effect.asVoid)),
            Effect.forkIn(scope),
          );
          entries.set(input.threadId, {
            handle,
            scope,
            instanceId: input.instanceConfigId,
            cwd: input.workspaceRoot,
            profileDirectory: nativeHome,
          });
          if (!observed.has(input.threadId))
            yield* FiberMap.run(evictions, input.threadId, evict(input.threadId));
          return handle;
        }),
      ),
    get: (id) => Effect.sync(() => entries.get(id)?.handle ?? null),
    close: (id) => exclusive(id, closeOwned(id)),
    observe: (id) =>
      Effect.gen(function* () {
        observed.add(id);
        yield* FiberMap.remove(evictions, id);
      }),
    unobserve: (id) =>
      Effect.gen(function* () {
        observed.delete(id);
        if (entries.has(id)) yield* FiberMap.run(evictions, id, evict(id));
      }),
    changes: Stream.fromPubSub(changes),
  });
});
export const live = Layer.effect(OpenCodeSessionManager, make);
