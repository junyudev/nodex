import type { AcpConversationImportResult } from "../../shared/acp-api";
import { createHash } from "node:crypto";
import { NATIVE_THREAD_IMPORT_OPERATION_PREFIX } from "@nodex/agent-runtime/contracts";
import type { NativeSessionWorkspace } from "../agent-backend/NativeSessionWorkspace";
import type { components } from "@nodex/core-protocol";
import type {
  AgentCommand,
  AgentHistoryPage,
  AgentRuntimeIdentity,
  AgentRuntimeMethod,
  AgentRuntimeOperations,
  AgentSnapshot,
  AgentTurnItem,
} from "@nodex/agent-runtime/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as RcMap from "effect/RcMap";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import { stableStringifyBlockPropertyJson } from "../../shared/block-property-mutations";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CoreModules } from "../core-runtime/CoreModules";
import { createOperationId, createStableOperationId } from "../core-runtime/operation-identity";
import { ProjectRuntimeLifecycleRuntime } from "../host-runtime/ProjectRuntimeLifecycleRuntime";
import type { ProjectWorkspaceApplyInput } from "../core-client/types";
import { CoreModuleResponseError } from "../core-client/core-client";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import type { CodexTurnPresentation } from "../codex-application/CodexTurnPresentation";
import type {
  AgentChatWorktreeConsumer,
  AgentChatWorktreeSource,
} from "../codex-application/AgentChatWorktrees";
import { resolveAgentRuntimeAgentConfig } from "../../shared/agent-runtime-agent-config";
import { generateSessionTitle } from "./AgentRuntimeSessionTitle";
import { splitCodexPromptAgentConfigLines } from "../../shared/codex-prompt-preparation";
import { appendAgentAppContext, hasAgentAppContext } from "../../shared/agent-prompt";
import type {
  ProjectSessionArchiveCommandInput,
  ProjectSessionDeleteCommandInput,
  ProjectSessionRenameCommandInput,
  ProjectSessionPinnedCommandInput,
} from "../../shared/workspace-catalog-commands";

import type {
  AgentRuntimeMessage,
  AgentRuntimeLaunch,
  AgentRuntimeLaunchResult,
  AgentRuntimeSessionTarget,
  AgentRuntimeConversation,
  AgentRuntimeControlInput,
} from "../../shared/agent-runtime-api";
export type {
  AgentRuntimeMessage,
  AgentRuntimeLaunch,
  AgentRuntimeSessionTarget,
  AgentRuntimeConversation,
} from "../../shared/agent-runtime-api";
import { agentExecutionThreadId } from "../../shared/agent-runtime-api";
import { agentRuntimeProviderId } from "../../shared/agent-runtime-provider";
import { agentRuntimeAgentSwitchRefusal } from "../../shared/agent-runtime-agent-switch";
import { agentRuntimeImageInputUnavailableReason } from "../../shared/agent-runtime-image-input";
import type {
  NativeConversationImportInput,
  NativeConversationImportOutcome,
} from "../../shared/native-session-catalog";
import {
  agentRuntimeForkSource,
  agentRuntimeMergeableRun,
} from "../../shared/agent-runtime-fork-merge";

type Binding = components["schemas"]["ProjectWorkspaceAgentRuntimeSessionBinding"];
type CleanupWindow = Extract<
  import("../core-client/types").ProjectWorkspaceReadSnapshot["value"],
  { readonly kind: "agent_runtime_execution_cleanup_window" }
>["cleanups"];
type Cleanup = CleanupWindow["items"][number];
type CreateThread = Extract<AgentCommand, { readonly type: "thread.create" }>;
type DispatchMessage = Extract<AgentCommand, { readonly type: "message.dispatch" }>;
type Respond = Extract<AgentCommand, { readonly type: "runtime-request.respond" }>;
type ProjectWorkspaceBindingInput = {
  readonly binding: Omit<Binding, "bound_at">;
  readonly operation: ProjectWorkspaceApplyInput;
};

/** Requests on this value remain bound to the physical connection that supplied identity. */
export interface AgentRuntimeApplicationConnection {
  readonly identity: AgentRuntimeIdentity;
  readonly subscribeNotifications?: import("../platform/node/AgentRuntimeProcess").AgentRuntimeProcessConnection["subscribeNotifications"];
  readonly request: <M extends AgentRuntimeMethod>(
    method: M,
    input: AgentRuntimeOperations[M]["input"],
  ) => Effect.Effect<AgentRuntimeOperations[M]["output"], unknown>;
}

export interface AgentRuntimeApplicationOptions {
  readonly connect: Effect.Effect<AgentRuntimeApplicationConnection, unknown>;
  /** Transient cleanup may use a live generation but must never start a cold Runtime. */
  readonly currentConnection: Effect.Effect<AgentRuntimeApplicationConnection | null, unknown>;
  /** Canonical history home from the exact physical Codex configuration used by this lease. */
  readonly nativeImportSourceHome?: (
    connection: AgentRuntimeApplicationConnection,
    input: Pick<NativeConversationImportInput, "backendKind" | "instanceConfigId">,
  ) => Effect.Effect<string, unknown>;
  /** Lets product-only draft deletion leave an unused Profile runtime cold. */
  readonly runtimeExists?: Effect.Effect<boolean, unknown>;
  /** Serves the last live provider catalog while execution is stopped. */
  readonly providerCatalog?: {
    readonly lastKnown: Effect.Effect<AgentRuntimeOperations["providers.read"]["output"] | null>;
    readonly saved: Effect.Effect<AgentRuntimeOperations["providers.read"]["output"] | null>;
    readonly record: (
      providers: AgentRuntimeOperations["providers.read"]["output"],
    ) => Effect.Effect<void>;
  };
  /**
   * Runs `effect` only while execution already runs, holding it until the effect settles; null
   * when it is stopped. It never starts execution.
   */
  readonly whileRunning?: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A | null, E | unknown, R>;
  /** Acquired before mutation admission; lifecycle delivery spans physical runtime generations. */
  readonly subscribeExecutionChanges?: Effect.Effect<
    Stream.Stream<void, unknown>,
    unknown,
    Scope.Scope
  >;
  readonly withWriter?: <A, E, R>(
    operation: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, unknown, R>;
  /** Explicit Profile-owned execution workspace; Core keeps its Project scope null. */
  readonly projectless: {
    readonly engineProjectId: string;
    readonly workspaceRoot: string;
    readonly ensureWorkspaceRoot: Effect.Effect<void, unknown>;
  };
  readonly prepareWorkspace?: NativeSessionWorkspace["Service"]["prepare"];
  readonly presentation?: CodexTurnPresentation["Service"];
  /** Desktop resources an archived or deleted Session's Agents held, such as Browser pages. */
  readonly releaseDesktopSession?: (sessionId: string) => Effect.Effect<void>;
  readonly reconcileWorkspace?: NativeSessionWorkspace["Service"]["reconcile"];
  /**
   * State the user left in a Thread's interactive responses that the Agent has not seen. It
   * travels as app data with the next message that starts a Run, once per change.
   */
  readonly interactiveState?: {
    readonly unsent: (
      threadId: string,
    ) => Effect.Effect<{ readonly key: string; readonly parts: readonly unknown[] } | undefined>;
    readonly sent: (threadId: string, key: string) => Effect.Effect<void>;
  };
  readonly prepareImages?: (
    images: NonNullable<AgentRuntimeMessage["images"]>,
  ) => Effect.Effect<
    readonly import("../../shared/agent-conversation").AgentPromptImage[],
    unknown
  >;
}

export class AgentRuntimeApplicationError extends Schema.TaggedError<AgentRuntimeApplicationError>()(
  "AgentRuntimeApplicationError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
    committedOperationId: Schema.optionalKey(Schema.String),
    /** This attempt failed admission validation before any product or execution mutation. */
    admissionRejected: Schema.optionalKey(Schema.Literal(true)),
  },
) {}

const failure = (operation: string, message: string, cause?: unknown) =>
  new AgentRuntimeApplicationError({
    operation,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
const importRefusal = (message: string) =>
  new AgentRuntimeApplicationError({
    operation: "import",
    message,
    admissionRejected: true,
  });
const AGENT_OPERATION_FAILED = "Agent operation could not be completed";
const NATIVE_IMPORT_LAUNCH_PREFIX = NATIVE_THREAD_IMPORT_OPERATION_PREFIX;

/**
 * Why an Agent operation failed. A failure from beneath this Module carries a generic message
 * and the runtime's own reason, such as a timeout or unreadable output, as its cause.
 */
export const agentRuntimeFailureReason = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  return error.message === AGENT_OPERATION_FAILED &&
    error.cause instanceof Error &&
    error.cause.message
    ? error.cause.message
    : error.message;
};
const validId = (value: string) =>
  value.length > 0 && value.trim() === value && value.length <= 512;
const hash = (value: unknown) =>
  createHash("sha256")
    .update(stableStringifyBlockPropertyJson(JSON.parse(JSON.stringify(value))))
    .digest("hex");
const commandId = (kind: string, identity: unknown) => `nodex:${kind}:${hash(identity)}`;
const launchThreadId = (launchId: string, sessionId: string) =>
  agentExecutionThreadId(hash({ launchId, sessionId }));
const nativeImportIdentity = (input: NativeConversationImportInput) => ({
  backendKind: input.backendKind,
  instanceConfigId: input.instanceConfigId,
  requestId: input.requestId,
  nativeSessionId: input.nativeSessionId,
  expectedHome: input.expectedHome,
  projectId: input.projectId,
  cwd: input.cwd,
});
const nativeImportBinding = (input: NativeConversationImportInput, runtimeId: string) => ({
  session_id: input.requestId,
  project_id: input.projectId,
  runtime_id: runtimeId,
  runtime_thread_id: agentExecutionThreadId(hash({ import: nativeImportIdentity(input) })),
  launch_request_id: `${NATIVE_IMPORT_LAUNCH_PREFIX}${input.requestId}`,
});
const messageAgentConfigs = (message: AgentRuntimeMessage) =>
  message.agentConfigs ?? splitCodexPromptAgentConfigLines(message.text).agentConfigs;
const hasImageInputs = (message: AgentRuntimeMessage) =>
  (message.images?.length ?? 0) > 0 ||
  message.attachments?.some((attachment) => attachment.type === "image") === true;
/** A fork reads as its source conversation; an untitled source gets a neutral name. */
export const forkTitle = (sourceTitle: string | null) => {
  const trimmed = sourceTitle?.trim() ?? "";
  return trimmed ? `Fork of ${trimmed}`.slice(0, 120) : "Forked chat";
};

/** Product Session semantics cross one execution owner; this Module stores no runtime state. */
export const make = Effect.fn("AgentRuntimeApplication.make")(function* (
  options: AgentRuntimeApplicationOptions,
) {
  const core = yield* CoreModules;
  const lifecycle = yield* ProjectRuntimeLifecycleRuntime;
  const workspace = yield* ProjectWorkspace;
  const sessionLanes = yield* RcMap.make({ lookup: (_sessionId: string) => Semaphore.make(1) });
  const ownerScope = yield* Effect.scope;
  if (!validId(options.projectless.engineProjectId) || !options.projectless.workspaceRoot.trim())
    return yield* failure("configuration", "A projectless execution workspace is required");
  const host = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    operation.pipe(Effect.provideService(CoreApplicationAgent, null));
  const owned = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        Schema.is(AgentRuntimeApplicationError)(cause)
          ? cause
          : failure(operation, AGENT_OPERATION_FAILED, cause),
      ),
    );
  const ownedWrite = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
    owned(operation, options.withWriter ? options.withWriter(effect) : effect);
  /** Reads providers from a running process, holding it meanwhile; a whole catalog is kept. */
  const liveCatalog = (input: AgentRuntimeOperations["providers.read"]["input"]) =>
    Effect.gen(function* () {
      if (!options.whileRunning) return null;
      const live = yield* options.whileRunning(
        Effect.gen(function* () {
          const connection = yield* options.connect;
          return yield* connection.request("providers.read", input);
        }),
      );
      if (live && !input.instanceIds && options.providerCatalog)
        yield* options.providerCatalog.record(live);
      return live;
    });
  const withSessionLane = <A, E, R>(
    sessionId: string,
    use: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.scoped(
      Effect.gen(function* () {
        const lane = yield* RcMap.get(sessionLanes, sessionId);
        return yield* lane.withPermit(use);
      }),
    );
  const assertSessionLifecycleAvailable = Effect.fn(
    "AgentRuntimeApplication.assertSessionLifecycleAvailable",
  )(function* (sessionId: string, operation: string) {
    if (!validId(sessionId)) return yield* failure("session", "Session identity is invalid");
    yield* authorizeSession(sessionId);
    const found = yield* host(
      core.workspace.read({ kind: "agent_runtime_session_binding", session_id: sessionId }),
    );
    if (found.value.kind !== "agent_runtime_session_binding")
      return yield* failure("session", "Session execution metadata is unavailable");
    if (!found.value.binding) return;
    const connection = yield* options.connect;
    if (found.value.binding.runtime_id !== connection.identity.runtimeId)
      return yield* failure("session", "Session belongs to another runtime");
    const thread = yield* connection.request("thread.read", {
      threadId: found.value.binding.runtime_thread_id,
    });
    if (!thread?.executionHandoff) return;
    // A failed history capture has no executing native conversation to protect. Its own
    // Runtime deletion serializes with capture and releases the import seal.
    if (
      operation === "delete-session" &&
      found.value.binding.launch_request_id.startsWith(NATIVE_IMPORT_LAUNCH_PREFIX) &&
      thread.historyOrigin === "native_import" &&
      thread.executionHandoff.operationId.startsWith(NATIVE_IMPORT_LAUNCH_PREFIX) &&
      thread.activeProviderThreadId === null
    )
      return;
    return yield* failure("session", "The Session workspace requires handoff recovery");
  });
  const withSessionLifecycle = <A, E, R>(
    operation: string,
    sessionId: string,
    use: Effect.Effect<A, E, R>,
  ) =>
    withSessionLane(
      sessionId,
      ownedWrite(
        operation,
        assertSessionLifecycleAvailable(sessionId, operation).pipe(Effect.andThen(use)),
      ),
    );
  const afterCommit = <A, E, R>(
    operationId: string,
    operation: string,
    effect: Effect.Effect<A, E, R>,
  ) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new AgentRuntimeApplicationError({
            operation,
            message: "Session change committed; execution settlement may be retried",
            committedOperationId: operationId,
            cause,
          }),
      ),
    );
  const engineProjectId = (projectId: string | null) =>
    projectId ?? options.projectless.engineProjectId;

  const matchesBinding = (
    binding: Binding | null | undefined,
    expected: Pick<
      Binding,
      "session_id" | "project_id" | "runtime_id" | "runtime_thread_id" | "launch_request_id"
    >,
  ) =>
    binding !== null &&
    binding !== undefined &&
    binding.session_id === expected.session_id &&
    binding.runtime_id === expected.runtime_id &&
    binding.runtime_thread_id === expected.runtime_thread_id &&
    binding.launch_request_id === expected.launch_request_id;

  /** An uncertain Core reply needs durable proof; metadata alone never admits execution. */
  const bindExecution = Effect.fn("AgentRuntimeApplication.bindExecution")(function* (
    input: ProjectWorkspaceBindingInput,
  ) {
    const applied = yield* core.workspace
      .apply(input.operation, undefined, input.binding.project_id ?? null)
      .pipe(Effect.result);
    if (applied._tag === "Success") return;
    const proof = yield* host(
      core.workspace.read({
        kind: "agent_runtime_session_binding_by_execution",
        runtime_id: input.binding.runtime_id,
        runtime_thread_id: input.binding.runtime_thread_id,
      }),
    );
    if (
      proof.value.kind === "agent_runtime_session_binding" &&
      matchesBinding(proof.value.binding, input.binding)
    )
      return;
    return yield* Effect.fail(applied.failure);
  });

  const authorizeSession = Effect.fn("AgentRuntimeApplication.authorizeSession")(function* (
    sessionId: string,
  ) {
    const provenance = yield* CoreApplicationAgent;
    if (!provenance) return;
    const projectId = provenance.authority.actor_project_id ?? null;
    // Core checks the live execution credential and actual Session before engine access.
    yield* core.workspace.read(
      { kind: "agent_session", provenance, session_id: sessionId },
      undefined,
      projectId,
    );
    yield* validateCaller();
  });

  const validateCaller = Effect.fn("AgentRuntimeApplication.validateCaller")(function* () {
    const provenance = yield* CoreApplicationAgent;
    if (!provenance) return;
    const result = yield* core.workspace.read(
      { kind: "agent_authority", provenance },
      undefined,
      provenance.authority.actor_project_id ?? null,
    );
    if (result.value.kind !== "agent_authority" || !result.value.resolution.authority)
      return yield* failure("caller", "The Agent connection is no longer available");
  });

  const projectScope = Effect.fn("AgentRuntimeApplication.projectScope")(function* (
    projectId: string | null,
    requireActive: boolean,
    requireWorkspace = requireActive,
  ) {
    if (projectId === null)
      return {
        id: options.projectless.engineProjectId,
        title: "Tasks",
        workspaceRoot: options.projectless.workspaceRoot,
        sourceRoots: [options.projectless.workspaceRoot],
      };
    const result = yield* host(
      core.workspace.read({ kind: "project", project_id: projectId }, undefined, projectId),
    );
    if (
      result.value.kind !== "project" ||
      (requireActive && result.value.project.lifecycle !== "active")
    )
      return yield* failure("project", "Choose an active Project to run this task");
    const project = result.value.project;
    if (requireWorkspace && !project.primary_workspace_root)
      return yield* failure("project", "This Project has no execution workspace");
    return {
      id: project.id,
      title: project.name,
      workspaceRoot: project.primary_workspace_root ?? "",
      sourceRoots: project.sources.map((source) => source.root),
    };
  });

  const upsertProject = Effect.fn("AgentRuntimeApplication.upsertProject")(function* (
    connection: AgentRuntimeApplicationConnection,
    scope: { readonly id: string; readonly title: string; readonly workspaceRoot: string },
  ) {
    if (scope.id === options.projectless.engineProjectId)
      yield* options.projectless.ensureWorkspaceRoot;
    yield* connection.request("project.upsert", {
      id: scope.id,
      title: scope.title,
      workspaceRoot: scope.workspaceRoot,
    });
  });

  const lookupDestinationBinding = Effect.fn("AgentRuntimeApplication.lookupDestinationBinding")(
    function* (sessionId: string) {
      const result = yield* host(
        core.workspace.read({ kind: "agent_runtime_session_binding", session_id: sessionId }),
      ).pipe(
        Effect.catch((error) =>
          // Creation precedes the product Session record. Only an exact missing-record
          // response admits creation; uncertain reads must not start engine mutations.
          error.cause instanceof CoreModuleResponseError &&
          error.cause.coreError.code === "not_found"
            ? Effect.succeed(null)
            : Effect.fail(error),
        ),
      );
      if (result === null) return null;
      if (result.value.kind !== "agent_runtime_session_binding")
        return yield* failure("session", "Session execution binding is unavailable");
      return result.value.binding ?? null;
    },
  );

  const readBinding = Effect.fn("AgentRuntimeApplication.readBinding")(function* (
    connection: AgentRuntimeApplicationConnection,
    sessionId: string,
    requireActive: boolean,
  ) {
    if (!validId(sessionId)) return yield* failure("session", "Session identity is invalid");
    yield* authorizeSession(sessionId);
    const result = yield* host(
      core.workspace.read({ kind: "agent_runtime_session_binding", session_id: sessionId }),
    );
    if (
      result.value.kind !== "agent_runtime_session_binding" ||
      !result.value.binding ||
      result.value.binding.runtime_id !== connection.identity.runtimeId
    )
      return yield* failure("session", "Session execution is unavailable in this runtime");
    const binding = result.value.binding;
    const projectId = binding.project_id ?? null;
    if (!requireActive) {
      yield* projectScope(projectId, false);
      return binding;
    }
    yield* lifecycle.runExclusive(
      projectId,
      Effect.gen(function* () {
        // Existing Threads own their execution directory independently of Project placement.
        yield* projectScope(projectId, true, false);
        const session = yield* host(
          core.workspace.read({ kind: "session", session_id: sessionId }, undefined, projectId),
        );
        if (session.value.kind !== "session" || session.value.session.archived)
          return yield* failure("session", "Archived tasks cannot start execution");
      }),
    );
    return binding;
  });

  /**
   * Core owns Session placement and archive. The engine keeps them only as execution gates
   * (working Project, and no wakes for archived chats); this repairs both from Core without
   * opening a transcript, wherever a Session is touched and after every Core change.
   */
  const reconcileExecution = Effect.fn("AgentRuntimeApplication.reconcileExecution")(function* (
    connection: AgentRuntimeApplicationConnection,
    initial: Binding,
    fence = false,
  ) {
    let binding = initial;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const thread = yield* connection.request("thread.read", {
        threadId: binding.runtime_thread_id,
      });
      if (
        !thread ||
        thread.id !== binding.runtime_thread_id ||
        thread.lineage.rootThreadId !== thread.id ||
        thread.deletedAt !== null
      )
        return yield* failure("placement", "Session execution is unavailable");
      const projectId = binding.project_id ?? null;
      const session = yield* host(
        core.workspace.read(
          { kind: "session", session_id: binding.session_id },
          undefined,
          projectId,
        ),
      );
      if (session.value.kind !== "session")
        return yield* failure("placement", "Session metadata is unavailable");
      const archived = session.value.session.archived;
      const moved = thread.projectId !== engineProjectId(projectId);
      if (moved || (thread.archivedAt !== null) !== archived) {
        const repair = Effect.gen(function* () {
          yield* validateCaller();
          if (moved) {
            const scope = yield* projectScope(projectId, false);
            yield* upsertProject(connection, scope);
            yield* dispatch(connection, {
              type: "thread.metadata.update",
              threadId: thread.id,
              projectId: scope.id,
              commandId: createOperationId("agent-runtime.placement"),
            });
          }
          if ((thread.archivedAt !== null) !== archived)
            yield* dispatch(connection, {
              type: archived ? "thread.archive" : "thread.unarchive",
              threadId: thread.id,
              commandId: createOperationId("agent-runtime.archive"),
            });
        });
        yield* fence && options.withWriter ? options.withWriter(repair) : repair;
      }
      const current = yield* readBinding(connection, binding.session_id, false);
      if ((current.project_id ?? null) === projectId) return current;
      binding = current;
    }
    return yield* failure(
      "placement",
      "Session placement changed while execution was being reconciled",
    );
  });

  const reconcileProject = Effect.fn("AgentRuntimeApplication.reconcileProject")(function* (
    connection: AgentRuntimeApplicationConnection,
    projectId: string,
    fence = false,
  ) {
    // Engine roots discover moved-out Sessions; Core's current placement discovers moved-in Sessions.
    let cursor: string | undefined;
    do {
      const page = yield* connection.request("project.roots", {
        projectId,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const threadId of page.threadIds) {
        const found = yield* host(
          core.workspace.read({
            kind: "agent_runtime_session_binding_by_execution",
            runtime_id: connection.identity.runtimeId,
            runtime_thread_id: threadId,
          }),
        );
        if (found.value.kind === "agent_runtime_session_binding" && found.value.binding)
          yield* reconcileExecution(connection, found.value.binding, fence);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    let after: string | undefined;
    do {
      const page = yield* host(
        core.workspace.read({
          kind: "agent_runtime_session_binding_window",
          runtime_id: connection.identity.runtimeId,
          project_id: projectId,
          window: { first: 200, ...(after === undefined ? {} : { after }) },
        }),
      );
      if (page.value.kind !== "agent_runtime_session_binding_window")
        return yield* failure("placement", "Session placement metadata is unavailable");
      for (const binding of page.value.bindings.items)
        yield* reconcileExecution(connection, binding, fence);
      after = page.value.bindings.next_cursor ?? undefined;
    } while (after !== undefined);
  });

  /**
   * A bound Session whose launch stopped before its root Thread existed. The binding is the
   * durable intent, so the Thread is created from product metadata the first time it is used.
   */
  const ensureRootThread = Effect.fn("AgentRuntimeApplication.ensureRootThread")(function* (
    connection: AgentRuntimeApplicationConnection,
    binding: Binding,
  ) {
    const existing = yield* connection.request("thread.read", {
      threadId: binding.runtime_thread_id,
    });
    if (existing) return existing;
    if (binding.launch_request_id.startsWith(NATIVE_IMPORT_LAUNCH_PREFIX))
      return yield* failure("import", "This import was interrupted. Retry it from Conversations.");
    const projectId = binding.project_id ?? null;
    const scope = yield* projectScope(projectId, false);
    const session = yield* host(
      core.workspace.read(
        { kind: "session", session_id: binding.session_id },
        undefined,
        projectId,
      ),
    );
    const title =
      session.value.kind === "session" ? session.value.session.display_title.trim() : "";
    const providers = yield* connection.request("providers.read", {});
    const provider =
      providers.find((entry) => entry.instanceId === "codex" && entry.enabled) ??
      providers.find((entry) => entry.enabled);
    const model =
      provider?.models.find((entry) => entry.isDefault)?.slug ?? provider?.models[0]?.slug;
    if (!provider || !model)
      return yield* failure("thread", "No Agent model is available to open this conversation");
    yield* upsertProject(connection, scope);
    yield* dispatch(connection, {
      type: "thread.create",
      commandId: commandId("launch-thread", {
        launchId: binding.launch_request_id,
        sessionId: binding.session_id,
      }),
      threadId: binding.runtime_thread_id,
      projectId: scope.id,
      title: title || "New chat",
      modelSelection: { instanceId: provider.instanceId, model },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: scope.workspaceRoot,
      createdBy: "user",
      creationSource: "web",
    });
    return yield* connection.request("thread.read", { threadId: binding.runtime_thread_id });
  });

  const load = Effect.fn("AgentRuntimeApplication.load")(function* (
    connection: AgentRuntimeApplicationConnection,
    target: AgentRuntimeSessionTarget,
    requireActive = false,
  ) {
    const binding = yield* readBinding(connection, target.sessionId, requireActive);
    const threadId = target.threadId ?? binding.runtime_thread_id;
    if (!validId(threadId)) return yield* failure("thread", "Thread identity is invalid");
    if (threadId === binding.runtime_thread_id) yield* ensureRootThread(connection, binding);
    const snapshot = yield* connection.request("thread.snapshot", { threadId });
    const thread = snapshot.projection.thread;
    if (
      thread.id !== threadId ||
      thread.lineage.rootThreadId !== binding.runtime_thread_id ||
      thread.deletedAt !== null ||
      (requireActive && thread.archivedAt !== null)
    )
      return yield* failure("thread", "Thread does not belong to this Session");
    return { binding, threadId, snapshot };
  });
  const targetInfo = Effect.fn("AgentRuntimeApplication.targetInfo")(function* (
    connection: AgentRuntimeApplicationConnection,
    target: AgentRuntimeSessionTarget,
    requireActive = false,
  ) {
    let binding = yield* readBinding(connection, target.sessionId, requireActive);
    const threadId = target.threadId ?? binding.runtime_thread_id;
    let thread =
      threadId === binding.runtime_thread_id
        ? yield* ensureRootThread(connection, binding)
        : yield* connection.request("thread.read", { threadId });
    const isRoot = threadId === binding.runtime_thread_id;
    if (
      !thread ||
      thread.id !== threadId ||
      thread.lineage.rootThreadId !== binding.runtime_thread_id ||
      thread.deletedAt !== null ||
      (requireActive && !isRoot && thread.archivedAt !== null)
    )
      return yield* failure("thread", "Thread does not belong to this Session");
    // Core has just confirmed the Session active; a stale engine gate is repaired, not obeyed.
    const stale = (current: NonNullable<typeof thread>) =>
      current.projectId !== engineProjectId(binding.project_id ?? null) ||
      (isRoot && current.archivedAt !== null);
    if (requireActive && stale(thread)) {
      yield* reconcileExecution(connection, binding);
      binding = yield* readBinding(connection, target.sessionId, true);
      thread = yield* connection.request("thread.read", { threadId });
      if (!thread || stale(thread))
        return yield* failure(
          "placement",
          "Session placement changed while execution was being reconciled",
        );
    }
    return { binding, threadId, thread };
  });
  const dispatch = (connection: AgentRuntimeApplicationConnection, command: AgentCommand) =>
    connection.request("command.dispatch", command);
  const prepareMessageInput = Effect.fn("AgentRuntimeApplication.prepareMessageInput")(function* (
    connection: AgentRuntimeApplicationConnection,
    message: AgentRuntimeMessage,
    modelSelection: CreateThread["modelSelection"],
    interactionMode: CreateThread["interactionMode"],
    retainsImages = false,
  ) {
    const configs = messageAgentConfigs(message);
    const requiresImageSupport = retainsImages || hasImageInputs(message);
    if (configs.length === 0 && !requiresImageSupport) return { message, hasConfig: false };
    const providers = yield* connection.request(
      "providers.read",
      configs.length > 0
        ? {}
        : {
            instanceIds: [(message.modelSelection ?? modelSelection).instanceId],
          },
    );
    const prepared =
      configs.length === 0
        ? { message, hasConfig: false }
        : yield* Effect.try(() =>
            resolveAgentRuntimeAgentConfig({
              message,
              modelSelection: message.modelSelection ?? modelSelection,
              interactionMode: message.interactionMode ?? interactionMode,
              providers,
            }),
          );
    if (requiresImageSupport) {
      const selected = prepared.message.modelSelection ?? modelSelection;
      const provider = providers.find((provider) => provider.instanceId === selected.instanceId);
      const model = provider?.models.find((model) => model.slug === selected.model);
      const reason = agentRuntimeImageInputUnavailableReason(model);
      if (reason)
        return yield* new AgentRuntimeApplicationError({
          operation: "images",
          message: reason,
          admissionRejected: true,
        });
    }
    return prepared;
  });
  const prepareMessage = Effect.fn("AgentRuntimeApplication.prepareMessage")(function* (
    connection: AgentRuntimeApplicationConnection,
    threadId: string,
    message: AgentRuntimeMessage,
  ) {
    if (!message.images?.length) return message;
    if (!options.prepareImages) return yield* failure("images", "Image preparation is unavailable");
    const images = yield* options.prepareImages(message.images);
    const attachments = [...(message.attachments ?? [])];
    for (const [index, image] of images.entries()) {
      // One attachment per request keeps transport frames bounded independently of total image input.
      const persisted = yield* connection.request("attachments.persist", {
        threadId,
        messageId: message.messageId,
        attachments: [
          {
            type: "image",
            name: message.images[index]?.caption?.slice(0, 255) || `Image ${index + 1}`,
            mimeType: image.mediaType,
            sizeBytes: Buffer.from(image.data, "base64").byteLength,
            dataUrl: `data:${image.mediaType};base64,${image.data}`,
          },
        ],
      });
      attachments.push(...persisted.attachments);
    }
    return { ...message, attachments };
  });
  const messageCommand = (
    threadId: string,
    message: AgentRuntimeMessage,
    deliveryIntent: DispatchMessage["deliveryIntent"] = "auto",
    agent = false,
    queueAfterActive = false,
  ): DispatchMessage => ({
    type: "message.dispatch",
    commandId: commandId("message", { threadId, messageId: message.messageId }),
    threadId,
    messageId: message.messageId,
    text: message.text,
    attachments: message.attachments ?? [],
    ...(message.context === undefined ? {} : { context: message.context }),
    ...(message.modelSelection === undefined ? {} : { modelSelection: message.modelSelection }),
    ...(message.interactionMode === undefined ? {} : { interactionMode: message.interactionMode }),
    createdBy: agent ? "agent" : "user",
    creationSource: agent ? "mcp" : "web",
    ...(queueAfterActive ? {} : { deliveryIntent }),
    dispatchMode: { type: queueAfterActive ? "queue_after_active" : "start_immediately" },
  });
  const assertMessage = (message: AgentRuntimeMessage) =>
    validId(message.messageId) &&
    (message.text.trim().length > 0 ||
      (message.attachments?.length ?? 0) > 0 ||
      (message.images?.length ?? 0) > 0)
      ? Effect.void
      : Effect.fail(failure("message", "A message or attachment is required"));
  const conversation = ({
    binding,
    threadId,
    snapshot,
  }: {
    binding: Binding;
    threadId: string;
    snapshot: AgentSnapshot;
  }): AgentRuntimeConversation => ({
    sessionId: binding.session_id,
    projectId: binding.project_id ?? null,
    threadId,
    snapshot,
  });

  /** Workspace inputs a deferred preparation needs again when the user retries it. */
  type DeferredPreparation = {
    readonly sessionId: string;
    readonly projectId: string | null;
    readonly title: string;
    readonly prompt: string;
    readonly sourceCwd: string;
    readonly sourceRoots: readonly string[];
    readonly worktreeStartingState?: AgentRuntimeLaunch["worktreeStartingState"];
    readonly localEnvironmentConfigPath?: string | null;
  };
  const preparations = new Map<string, DeferredPreparation>();
  /** Preparations with a live owner in this Main process. */
  const preparing = new Set<string>();
  const preparationKey = (threadId: string, runId: string) => JSON.stringify([threadId, runId]);
  const preparationFailure = (message: string) => {
    // The engine stores trimmed text of at most 4,096 characters; a tool can report more.
    const text = Array.from(message.trim()).slice(0, 4_096).join("").trim();
    return {
      class: "validation_error" as const,
      message: text || "The worktree could not be prepared",
      code: null,
      retryable: true,
    };
  };

  /**
   * Creates a launch's managed worktree while its Run waits as `preparing`. The Run starts only
   * after the Thread records the new location; a failure leaves a retryable failed Run.
   */
  const prepareDeferredWorkspace = (
    connection: AgentRuntimeApplicationConnection,
    threadId: string,
    runId: string,
    attempt: string,
  ) =>
    Effect.gen(function* () {
      preparing.add(preparationKey(threadId, runId));
      const input = preparations.get(preparationKey(threadId, runId));
      if (!input || !options.prepareWorkspace)
        return yield* failure("workspace", "Worktree preparation is unavailable");
      const prepare = options.prepareWorkspace;
      yield* dispatch(connection, {
        type: "prepared-run.progress",
        commandId: commandId("preparation-progress", { threadId, runId, attempt }),
        threadId,
        runId,
        phase: "worktree",
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* prepare({
            projectId: input.projectId,
            targetId: input.sessionId,
            title: input.title,
            prompt: input.prompt,
            sourceCwd: input.sourceCwd,
            sourceRoots: input.sourceRoots,
            runInTarget: "newWorktree",
            ...(input.worktreeStartingState
              ? { worktreeStartingState: input.worktreeStartingState }
              : {}),
            localEnvironmentConfigPath: input.localEnvironmentConfigPath ?? null,
            operationId: createStableOperationId("agent-runtime.workspace", 0, {
              threadId,
              runId,
              attempt,
            }),
          });
          yield* dispatch(connection, {
            type: "thread.metadata.update",
            commandId: commandId("preparation-location", { threadId, runId, attempt }),
            threadId,
            worktreePath: lease.location.cwd,
          });
          // The Thread owns the directory from here; a later failure must never remove it.
          yield* lease.attach(threadId);
        }),
      );
      yield* dispatch(connection, {
        type: "prepared-run.release",
        commandId: commandId("preparation-release", { threadId, runId, attempt }),
        threadId,
        runId,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        dispatch(connection, {
          type: "prepared-run.fail",
          commandId: commandId("preparation-failure", { threadId, runId, attempt }),
          threadId,
          runId,
          failure: preparationFailure(
            Cause.squash(cause) instanceof Error
              ? (Cause.squash(cause) as Error).message
              : "The worktree could not be prepared",
          ),
        }).pipe(
          Effect.catchCause((recordCause) =>
            Effect.logWarning("Worktree preparation failure could not be recorded").pipe(
              Effect.annotateLogs({ threadId, runId, cause: Cause.pretty(recordCause) }),
            ),
          ),
        ),
      ),
      Effect.ensuring(Effect.sync(() => preparing.delete(preparationKey(threadId, runId)))),
    );

  const launch = Effect.fn("AgentRuntimeApplication.launch")(function* (input: AgentRuntimeLaunch) {
    const provenance = yield* CoreApplicationAgent;

    if (
      !validId(input.launchId) ||
      !validId(input.sessionId) ||
      !Number.isSafeInteger(input.acceptedAt) ||
      input.acceptedAt < 0 ||
      !input.title.trim()
    )
      return yield* failure("launch", "Launch identity and title are required");
    yield* assertMessage(input.message);
    const connection = yield* options.connect;
    const threadId = launchThreadId(input.launchId, input.sessionId);
    const binding = {
      session_id: input.sessionId,
      project_id: input.projectId,
      runtime_id: connection.identity.runtimeId,
      runtime_thread_id: threadId,
      launch_request_id: input.launchId,
    };
    yield* validateCaller();
    const previousBinding = yield* lookupDestinationBinding(input.sessionId);
    if (previousBinding && !matchesBinding(previousBinding, binding))
      return yield* new AgentRuntimeApplicationError({
        operation: "launch",
        message: "Session is already bound to another launch request",
        admissionRejected: true,
      });
    const projectId = previousBinding ? (previousBinding.project_id ?? null) : input.projectId;
    if (input.runInTarget === "newWorktree" && !options.prepareWorkspace)
      return yield* failure("workspace", "Worktree preparation is unavailable");
    // Invalid input is refused before any product or execution state exists.
    const prepared = yield* prepareMessageInput(
      connection,
      input.message,
      input.modelSelection,
      input.interactionMode,
    );
    yield* assertMessage(prepared.message);
    // Core admits the product Session first. It rejects an unbindable Session before any
    // execution or workspace effect exists, and the binding names the deterministic Thread
    // that every later step creates idempotently.
    const scope = yield* lifecycle.runExclusive(
      projectId,
      Effect.gen(function* () {
        const scope = yield* projectScope(projectId, true);
        if (previousBinding) {
          yield* authorizeSession(input.sessionId);
          return scope;
        }
        if (input.sourceRoot !== undefined && !scope.sourceRoots.includes(input.sourceRoot))
          return yield* failure("workspace", "Choose a configured Project source workspace");
        yield* bindExecution({
          binding,
          operation: {
            operationId: createStableOperationId("agent-runtime.launch", input.acceptedAt, {
              launchId: input.launchId,
            }),
            intent: {
              kind: "create_agent_runtime_session",
              ...binding,
              title: input.title.trim(),
              initial_page_ids: [...new Set(input.initialPageIds ?? [])],
            },
          },
        });
        return scope;
      }),
    );
    // No Project lifecycle permit crosses an engine request that can await host admission.
    const existing = yield* connection.request("thread.read", { threadId });
    if (existing)
      yield* reconcileExecution(connection, yield* readBinding(connection, input.sessionId, true));
    if (
      existing &&
      (existing.lineage.rootThreadId !== threadId ||
        existing.deletedAt !== null ||
        (!previousBinding && existing.activeRunId !== null))
    )
      return yield* failure("launch", "Launch metadata does not match this Session");
    const sourceCwd = input.sourceRoot ?? scope.workspaceRoot;
    const deferWorktree = !existing && input.runInTarget === "newWorktree";
    // A checkout or projectless workspace is ready immediately; a managed worktree is prepared
    // after the Run is durable, so the prompt survives and the user sees progress.
    const lease =
      !existing && !deferWorktree && options.prepareWorkspace
        ? yield* options.prepareWorkspace({
            projectId,
            targetId: input.sessionId,
            title: input.title.trim(),
            prompt: prepared.message.text,
            sourceCwd,
            sourceRoots: scope.sourceRoots,
            runInTarget: "localProject",
            operationId: createStableOperationId("agent-runtime.workspace", input.acceptedAt, {
              launchId: input.launchId,
            }),
          })
        : null;
    const cwd = existing?.worktreePath ?? lease?.location.cwd ?? input.worktreePath ?? sourceCwd;
    yield* upsertProject(connection, scope);
    if (lease) yield* lease.retain;
    if (!existing)
      yield* dispatch(connection, {
        type: "thread.create",
        commandId: commandId("launch-thread", {
          launchId: input.launchId,
          sessionId: input.sessionId,
        }),
        threadId,
        projectId: scope.id,
        title: input.title.trim(),
        modelSelection: prepared.message.modelSelection ?? input.modelSelection,
        runtimeMode: "full-access",
        interactionMode: prepared.message.interactionMode ?? input.interactionMode,
        branch: input.branch ?? null,
        worktreePath: cwd,
        createdBy: provenance ? "agent" : "user",
        creationSource: provenance ? "mcp" : "web",
      });
    const current = yield* targetInfo(connection, { sessionId: input.sessionId, threadId }, true);
    if (lease) yield* lease.attach(threadId);
    else if (existing && options.reconcileWorkspace)
      yield* options.reconcileWorkspace({ cwd, threadId });
    yield* (
      options.presentation?.admitRuntimeMessage(
        input.presentationTicket,
        { kind: "session", sessionId: input.sessionId, launchId: input.launchId },
        threadId,
        input.message.messageId,
      ) ?? Effect.void
    );
    const message = yield* prepareMessage(connection, threadId, prepared.message);
    const command = messageCommand(threadId, message, undefined, provenance !== null);
    const firstLaunch = !existing && !previousBinding;
    yield* dispatch(
      connection,
      deferWorktree
        ? {
            ...command,
            dispatchMode: {
              type: "defer_start",
              workspaceStrategy: {
                type: "worktree",
                baseRef:
                  input.worktreeStartingState?.type === "branch"
                    ? input.worktreeStartingState.branchName
                    : "HEAD",
              },
            },
          }
        : command,
    );
    if (deferWorktree) {
      const outcome = yield* connection.request("run.outcome", {
        threadId,
        messageId: message.messageId,
      });
      if (outcome?.status === "preparing") {
        preparations.set(preparationKey(threadId, outcome.runId), {
          sessionId: input.sessionId,
          projectId,
          title: input.title.trim(),
          prompt: prepared.message.text,
          sourceCwd,
          sourceRoots: scope.sourceRoots,
          ...(input.worktreeStartingState
            ? { worktreeStartingState: input.worktreeStartingState }
            : {}),
          localEnvironmentConfigPath: input.runInEnvironmentPath ?? null,
        });
        yield* prepareDeferredWorkspace(connection, threadId, outcome.runId, "1").pipe(
          Effect.forkIn(ownerScope),
        );
      }
    }
    // An Agent names the chats it starts; a person's opening prompt is titled once.
    if (firstLaunch && !provenance)
      yield* titleSession(connection, {
        sessionId: input.sessionId,
        projectId: current.binding.project_id ?? null,
        provisionalTitle: input.title.trim(),
        prompt: prepared.message.text,
        cwd: sourceCwd,
        modelSelection: prepared.message.modelSelection ?? input.modelSelection,
      });
    return { sessionId: input.sessionId, projectId: current.binding.project_id ?? null, threadId };
  });

  /** Core owns the title; a generated one replaces only the provisional title it came from. */
  const titleSession = (
    connection: AgentRuntimeApplicationConnection,
    input: {
      readonly sessionId: string;
      readonly projectId: string | null;
      readonly provisionalTitle: string;
      readonly prompt: string;
      readonly cwd: string;
      readonly modelSelection: AgentRuntimeLaunch["modelSelection"];
    },
  ) =>
    generateSessionTitle(connection, input).pipe(
      Effect.flatMap((title) =>
        title === null || title === input.provisionalTitle
          ? Effect.void
          : host(
              core.workspace.apply(
                {
                  operationId: createOperationId("agent-runtime.session-title"),
                  intent: {
                    kind: "mutate_session",
                    session_id: input.sessionId,
                    intent: {
                      kind: "set_fallback_title",
                      title,
                      replaces: input.provisionalTitle,
                    },
                  },
                },
                undefined,
                input.projectId,
              ),
            ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Automatic chat title generation failed").pipe(
          Effect.annotateLogs({ sessionId: input.sessionId, cause: Cause.pretty(cause) }),
        ),
      ),
      Effect.forkIn(ownerScope),
      Effect.asVoid,
    );

  /** Retries a failed workspace preparation, or starts the Run in the source checkout. */
  const retryPreparation = Effect.fn("AgentRuntimeApplication.retryPreparation")(function* (
    input: import("../../shared/agent-runtime-api").AgentRuntimePreparationRetryInput,
  ) {
    if (!validId(input.runId) || !validId(input.requestId))
      return yield* failure("workspace", "Run and request identities are required");
    const connection = yield* options.connect;
    const loaded = yield* targetInfo(connection, input, true);
    const key = preparationKey(loaded.threadId, input.runId);
    if (!input.workLocally && !preparations.has(key)) {
      // The original choices did not survive an application restart: start a fresh worktree
      // from the source checkout's current branch.
      const scope = yield* projectScope(loaded.binding.project_id ?? null, true);
      preparations.set(key, {
        sessionId: input.sessionId,
        projectId: loaded.binding.project_id ?? null,
        title: loaded.thread.title,
        prompt: loaded.thread.title,
        sourceCwd: scope.workspaceRoot,
        sourceRoots: scope.sourceRoots,
      });
    }
    yield* dispatch(connection, {
      type: "prepared-run.retry",
      commandId: commandId("preparation-retry", { requestId: input.requestId }),
      threadId: loaded.threadId,
      runId: input.runId,
    });
    if (input.workLocally) {
      preparations.delete(key);
      yield* dispatch(connection, {
        type: "prepared-run.release",
        commandId: commandId("preparation-local", { requestId: input.requestId }),
        threadId: loaded.threadId,
        runId: input.runId,
      });
      return { retried: true as const };
    }
    yield* prepareDeferredWorkspace(connection, loaded.threadId, input.runId, input.requestId).pipe(
      Effect.forkIn(ownerScope),
    );
    return { retried: true as const };
  });

  /**
   * A preparation interrupted by an application restart has no live owner. Its Run fails with a
   * readable reason so the user can retry instead of waiting on a preparation that never ends.
   */
  /**
   * After the engine starts, brings every live root in line with Core: placement and archive
   * changes made while it was unavailable, and worktree preparations a restart interrupted.
   * Cost follows live work, never retained history.
   */
  const reconcileLiveExecutions = Effect.fn("AgentRuntimeApplication.reconcileLiveExecutions")(
    function* () {
      const connection = yield* options.connect;
      let cursor: string | undefined;
      do {
        const page = yield* connection.request("execution.activity", {
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const root of page.items) {
          const found = yield* host(
            core.workspace.read({
              kind: "agent_runtime_session_binding_by_execution",
              runtime_id: connection.identity.runtimeId,
              runtime_thread_id: root.rootThreadId,
            }),
          );
          if (found.value.kind === "agent_runtime_session_binding" && found.value.binding)
            yield* host(reconcileExecution(connection, found.value.binding)).pipe(
              Effect.ignoreCause,
            );
          if (!root.activeRunId) continue;
          if (preparing.has(preparationKey(root.rootThreadId, root.activeRunId))) continue;
          const authority = yield* connection.request("thread.authority", {
            threadId: root.rootThreadId,
            runId: root.activeRunId,
          });
          if (authority?.status !== "preparing") continue;
          yield* dispatch(connection, {
            type: "prepared-run.fail",
            commandId: commandId("preparation-interrupted", {
              threadId: root.rootThreadId,
              runId: root.activeRunId,
              generation: connection.identity.runtimeGeneration,
            }),
            threadId: root.rootThreadId,
            runId: root.activeRunId,
            failure: preparationFailure(
              "Worktree preparation was interrupted when Nodex restarted. Retry to create it again.",
            ),
          }).pipe(Effect.ignoreCause);
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
    },
  );

  /** Imported copies are indexed by source identity, independently of a retry request. */
  const findNativeImports = Effect.fn("AgentRuntimeApplication.findNativeImports")(
    function* (input: {
      readonly backendKind: "codex" | "claude";
      readonly sourceHome: string;
      readonly nativeThreadIds: readonly string[];
    }) {
      if (input.nativeThreadIds.length === 0) return [];
      yield* validateCaller();
      const running = yield* options.currentConnection;
      if (!running && options.runtimeExists && !(yield* options.runtimeExists)) return [];
      const connection = running ?? (yield* options.connect);
      const result = yield* connection.request("native-imports.find", {
        ...input,
        nativeThreadIds: [...input.nativeThreadIds],
      });
      const copies: Array<{
        nativeSessionId: string;
        importedSessionId: string;
        importedThreadId: string;
      }> = [];
      for (const entry of result.imports) {
        const owner = yield* host(
          core.workspace.read({
            kind: "agent_runtime_session_binding_by_execution",
            runtime_id: connection.identity.runtimeId,
            runtime_thread_id: entry.threadId,
          }),
        );
        if (owner.value.kind !== "agent_runtime_session_binding" || !owner.value.binding) continue;
        copies.push({
          nativeSessionId: entry.sourceNativeThreadId,
          importedSessionId: owner.value.binding.session_id,
          importedThreadId: entry.threadId,
        });
      }
      return copies;
    },
  );

  /** ACP attaches its native execution identity; Core admits the same Session binding contract. */
  const importAcp = Effect.fn("AgentRuntimeApplication.importAcp")(function* (input: {
    readonly instanceId: string;
    readonly projectId: string | null;
    readonly sessionId: string;
    readonly requestId: string;
    readonly acceptedAt: number;
    readonly cwd: string;
  }): Effect.fn.Return<AcpConversationImportResult, unknown> {
    yield* validateCaller();
    if (
      !validId(input.requestId) ||
      input.sessionId.length === 0 ||
      input.sessionId.length > 1024 ||
      !Number.isSafeInteger(input.acceptedAt) ||
      input.acceptedAt < 0
    )
      return yield* failure("import", "Conversation import identity is invalid");
    const connection = yield* options.connect;
    const prepared = yield* connection.request("acp.sessions.prepareImport", {
      instanceId: input.instanceId,
      cwd: input.cwd,
      sessionId: input.sessionId,
    });
    const existing = yield* host(
      core.workspace.read({
        kind: "agent_runtime_session_binding_by_execution",
        runtime_id: connection.identity.runtimeId,
        runtime_thread_id: prepared.threadId,
      }),
    );
    if (existing.value.kind !== "agent_runtime_session_binding")
      return yield* failure("import", "Session execution metadata is unavailable");
    if (existing.value.binding && prepared.imported) {
      yield* authorizeSession(existing.value.binding.session_id);
      return {
        sessionId: existing.value.binding.session_id,
        threadId: prepared.threadId,
        projectId: existing.value.binding.project_id ?? null,
      };
    }
    const sessionId = existing.value.binding?.session_id ?? input.requestId;
    const identity = {
      instanceId: input.instanceId,
      sourceFingerprint: prepared.sourceFingerprint,
      nativeSessionId: input.sessionId,
      cwd: prepared.cwd,
    };
    const binding = existing.value.binding ?? {
      session_id: sessionId,
      project_id: input.projectId,
      runtime_id: connection.identity.runtimeId,
      runtime_thread_id: prepared.threadId,
      launch_request_id: `nodex:acp-import:${input.requestId}`,
    };
    const previous = yield* lookupDestinationBinding(sessionId);
    if (previous && !matchesBinding(previous, binding))
      return yield* failure(
        "import",
        "This import request already belongs to another conversation",
      );
    const providers = yield* connection.request("providers.read", {});
    const provider = providers.find(
      (entry) => entry.instanceId === input.instanceId && entry.enabled,
    );
    const model =
      provider?.models.find((entry) => entry.isDefault)?.slug ?? provider?.models[0]?.slug;
    if (!provider || !model)
      return yield* importRefusal(
        "This Agent has no available model. Check Agent settings, then try again.",
      );
    const scope = yield* lifecycle.runExclusive(
      binding.project_id ?? null,
      Effect.gen(function* () {
        const project = yield* projectScope(binding.project_id ?? null, true, false);
        if (previous) {
          yield* authorizeSession(sessionId);
          return { ...project, workspaceRoot: project.workspaceRoot || prepared.cwd };
        }
        yield* bindExecution({
          binding,
          operation: {
            operationId: createStableOperationId("agent-runtime.import-acp", input.acceptedAt, {
              ...identity,
              sessionId,
            }),
            intent: {
              kind: "create_agent_runtime_session",
              ...binding,
              title: prepared.title.trim() || "Imported conversation",
              initial_page_ids: [],
            },
          },
        });
        return { ...project, workspaceRoot: project.workspaceRoot || prepared.cwd };
      }),
    );
    yield* upsertProject(connection, scope);
    yield* connection.request("acp.sessions.import", {
      instanceId: input.instanceId,
      sourceFingerprint: prepared.sourceFingerprint,
      cwd: prepared.cwd,
      commandId: commandId("import-acp", { ...identity, threadId: prepared.threadId }),
      threadId: prepared.threadId,
      projectId: scope.id,
      title: prepared.title,
      sessionId: input.sessionId,
      model,
    });
    return { sessionId, threadId: prepared.threadId, projectId: binding.project_id ?? null };
  });

  /** A lost success reply can be recovered after the source or its account is removed. */
  const completedNativeImport = Effect.fn("AgentRuntimeApplication.completedNativeImport")(
    function* (input: NativeConversationImportInput) {
      yield* validateCaller();
      const previous = yield* lookupDestinationBinding(input.requestId);
      if (!previous) return null;
      yield* authorizeSession(input.requestId);
      const connection = yield* options.connect;
      const expected = nativeImportBinding(input, connection.identity.runtimeId);
      if (!matchesBinding(previous, expected))
        return yield* failure(
          "import",
          "This import request already belongs to another conversation",
        );
      const thread = yield* connection.request("thread.read", {
        threadId: expected.runtime_thread_id,
      });
      if (!thread || thread.historyOrigin !== "native_import" || thread.executionHandoff)
        return null;
      const receipt = yield* connection.request("command.receipt", {
        commandId: commandId("import-native", nativeImportIdentity(input)),
        threadId: expected.runtime_thread_id,
      });
      if (receipt?.status !== "accepted") return null;
      const target = yield* targetInfo(
        connection,
        {
          sessionId: input.requestId,
          threadId: expected.runtime_thread_id,
        },
        true,
      );
      return {
        sessionId: input.requestId,
        threadId: target.threadId,
        projectId: target.binding.project_id ?? null,
      };
    },
  );

  /** Copies visible history into an independent Session without starting a model Run. */
  const importNative = Effect.fn("AgentRuntimeApplication.importNative")(function* (
    input: NativeConversationImportInput & {
      readonly title: string;
      readonly model: string | null;
    },
    onBindingAttempt: () => void = () => {},
  ) {
    if (
      !validId(input.requestId) ||
      !validId(input.nativeSessionId) ||
      !Number.isSafeInteger(input.acceptedAt) ||
      input.acceptedAt < 0 ||
      !input.title.trim() ||
      !input.cwd.trim()
    )
      return yield* failure("import", "Import identity, title and working directory are required");
    const connection = yield* options.connect;
    const sessionId = input.requestId;
    // The complete request is part of the binding, so a reused request cannot import another
    // source or silently change the destination while recovering a partial operation.
    const importIdentity = nativeImportIdentity(input);
    const binding = nativeImportBinding(input, connection.identity.runtimeId);
    const threadId = binding.runtime_thread_id;
    yield* validateCaller();
    const previous = yield* lookupDestinationBinding(sessionId);
    if (previous && !matchesBinding(previous, binding))
      return yield* failure(
        "import",
        "This import request already belongs to another conversation",
      );
    if (!options.nativeImportSourceHome)
      return yield* importRefusal("Conversation import is unavailable in this Profile.");
    const sourceHome = yield* options.nativeImportSourceHome(connection, input);
    if (sourceHome !== input.expectedHome)
      return yield* importRefusal(
        "This conversation comes from a different history folder than Nodex now uses. Refresh and try again.",
      );
    const providers = yield* connection.request("providers.read", {});
    const providerId =
      input.backendKind === "codex"
        ? agentRuntimeProviderId({ kind: "codex" })
        : input.instanceConfigId
          ? agentRuntimeProviderId({ kind: "claude", instanceConfigId: input.instanceConfigId })
          : null;
    const provider = providers.find((entry) => entry.instanceId === providerId && entry.enabled);
    const model =
      provider?.models.find((entry) => entry.slug === input.model)?.slug ??
      provider?.models.find((entry) => entry.isDefault)?.slug ??
      provider?.models[0]?.slug;
    if (!provider || !model)
      return yield* importRefusal(
        "This Agent has no available model. Check Agent settings, then try again.",
      );
    const scope = yield* lifecycle.runExclusive(
      input.projectId,
      Effect.gen(function* () {
        const project = yield* projectScope(input.projectId, true, false).pipe(
          Effect.catch((cause) => {
            if (
              Schema.is(AgentRuntimeApplicationError)(cause) &&
              cause.operation === "project" &&
              cause.cause === undefined
            )
              return Effect.fail(importRefusal(cause.message));
            if (
              cause.cause instanceof CoreModuleResponseError &&
              cause.cause.coreError.code === "not_found"
            )
              return Effect.fail(importRefusal(cause.cause.coreError.message));
            return Effect.fail(cause);
          }),
        );
        const scope = { ...project, workspaceRoot: project.workspaceRoot || input.cwd };
        if (previous) {
          yield* authorizeSession(sessionId);
          return scope;
        }
        onBindingAttempt();
        yield* bindExecution({
          binding,
          operation: {
            operationId: createStableOperationId(
              "agent-runtime.import-native",
              input.acceptedAt,
              importIdentity,
            ),
            intent: {
              kind: "create_agent_runtime_session",
              ...binding,
              title: input.title.trim(),
              initial_page_ids: [],
            },
          },
        });
        return scope;
      }),
    );
    yield* upsertProject(connection, scope);
    yield* connection.request("thread.import-native", {
      commandId: commandId("import-native", importIdentity),
      threadId,
      projectId: scope.id,
      title: input.title.trim(),
      backendKind: input.backendKind,
      sourceHome: sourceHome,
      sourceNativeThreadId: input.nativeSessionId,
      modelSelection: { instanceId: provider.instanceId, model },
      cwd: input.cwd,
    });
    yield* targetInfo(connection, { sessionId, threadId }, true);
    return { sessionId, threadId, projectId: input.projectId };
  });

  /** One request lane covers the no-binding proof, source validation and admission. */
  const submitNativeImport = Effect.fn("AgentRuntimeApplication.submitNativeImport")(function* (
    input: NativeConversationImportInput,
    prepare: Effect.Effect<{ readonly title: string; readonly model: string | null }, unknown>,
  ): Effect.fn.Return<NativeConversationImportOutcome, unknown> {
    yield* validateCaller();
    const previous = yield* lookupDestinationBinding(input.requestId);
    const completed = yield* completedNativeImport(input);
    if (completed) return { kind: "imported", ...completed };
    let bindingAttempted = false;
    return yield* Effect.gen(function* () {
      const source = yield* prepare;
      const result = yield* importNative(
        { ...input, title: source.title, model: source.model },
        () => {
          bindingAttempted = true;
        },
      );
      return { kind: "imported" as const, ...result };
    }).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          if (
            previous ||
            bindingAttempted ||
            !Schema.is(AgentRuntimeApplicationError)(cause) ||
            !cause.admissionRejected
          )
            return yield* Effect.fail(cause);
          // Recheck inside the same lane; a binding from any competing product operation wins.
          if (yield* lookupDestinationBinding(input.requestId)) return yield* Effect.fail(cause);
          return { kind: "not_admitted" as const, message: cause.message };
        }),
      ),
    );
  });

  const fork = Effect.fn("AgentRuntimeApplication.fork")(function* (
    input: import("../../shared/agent-runtime-api").AgentRuntimeForkInput,
  ) {
    if (
      !validId(input.sessionId) ||
      !validId(input.requestId) ||
      !Number.isSafeInteger(input.acceptedAt) ||
      input.acceptedAt < 0 ||
      (input.sourceRunId !== undefined && !validId(input.sourceRunId)) ||
      input.sessionId === input.source.sessionId
    )
      return yield* failure(
        "fork",
        "A distinct destination Session and stable fork identity are required",
      );
    const connection = yield* options.connect;
    const source = yield* targetInfo(connection, input.source, true);
    const provenance = yield* CoreApplicationAgent;

    const projectId = source.binding.project_id ?? null;
    const threadId = agentExecutionThreadId(
      hash({ forkRequestId: input.requestId, sessionId: input.sessionId }),
    );
    const sourceTitle = yield* host(
      core.workspace.read(
        { kind: "session", session_id: input.source.sessionId },
        undefined,
        projectId,
      ),
    ).pipe(
      Effect.map((read) =>
        read.value.kind === "session" ? read.value.session.display_title : null,
      ),
      Effect.orElseSucceed(() => null),
    );
    const title = forkTitle(sourceTitle);
    const binding = {
      session_id: input.sessionId,
      project_id: projectId,
      runtime_id: connection.identity.runtimeId,
      runtime_thread_id: threadId,
      launch_request_id: input.requestId,
    };
    yield* validateCaller();
    const previous = yield* lookupDestinationBinding(input.sessionId);
    if (previous && !matchesBinding(previous, binding))
      return yield* failure("fork", "Session is already bound to another fork request");
    if (input.environment === "worktree" && !options.prepareWorkspace)
      return yield* failure("workspace", "Worktree preparation is unavailable");
    const existing = yield* connection.request("thread.read", { threadId });
    const sourceRunId = existing
      ? null
      : yield* connection.request("thread.fork-source", {
          threadId: source.threadId,
          ...(input.sourceRunId === undefined ? {} : { runId: input.sourceRunId }),
        });
    if (!existing && sourceRunId === null)
      return yield* failure("fork", "This chat has no finished Run to fork from");
    // The product Session is admitted before any Thread or worktree exists.
    const scope = yield* lifecycle.runExclusive(
      projectId,
      Effect.gen(function* () {
        const scope = yield* projectScope(projectId, true, false);
        if (previous) return scope;
        yield* bindExecution({
          binding,
          operation: {
            operationId: createStableOperationId("agent-runtime.fork", input.acceptedAt, {
              requestId: input.requestId,
            }),
            intent: {
              kind: "create_agent_runtime_session",
              ...binding,
              title,
              initial_page_ids: [],
            },
          },
        });
        return scope;
      }),
    );
    if (sourceRunId !== null)
      yield* dispatch(connection, {
        type: "thread.fork",
        commandId: commandId("fork-thread", {
          requestId: input.requestId,
          sessionId: input.sessionId,
        }),
        sourceThreadId: source.threadId,
        targetThreadId: threadId,
        sourcePoint: { type: "run", runId: sourceRunId },
        rootPolicy: "independent_root",
        title,
        createdBy: provenance ? "agent" : "user",
        creationSource: provenance ? "mcp" : "web",
      });
    // A worktree fork still sharing its source directory never finished relocating, including
    // a retry after the process stopped between the fork and the location update.
    const forked = existing ?? (yield* connection.request("thread.read", { threadId }));
    const sourceDirectory = source.thread.worktreePath ?? scope.workspaceRoot;
    if (
      input.environment === "worktree" &&
      options.prepareWorkspace &&
      (forked?.worktreePath ?? sourceDirectory) === sourceDirectory
    ) {
      const prepare = options.prepareWorkspace;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* prepare({
            projectId,
            targetId: input.sessionId,
            title,
            prompt: title,
            sourceCwd: sourceDirectory,
            sourceRoots: scope.sourceRoots,
            runInTarget: "newWorktree",
            localEnvironmentConfigPath: input.runInEnvironmentPath ?? null,
            operationId: createStableOperationId("agent-runtime.fork-workspace", input.acceptedAt, {
              requestId: input.requestId,
            }),
          });
          yield* dispatch(connection, {
            type: "thread.metadata.update",
            commandId: commandId("fork-workspace", { requestId: input.requestId }),
            threadId,
            worktreePath: lease.location.cwd,
            branch: null,
          });
          yield* lease.attach(threadId);
        }),
      );
    }
    yield* targetInfo(connection, { sessionId: input.sessionId, threadId }, true);
    return {
      sourceSessionId: input.source.sessionId,
      sessionId: input.sessionId,
      projectId,
      threadId,
    };
  });

  /**
   * Brings a fork's newest finished Run back into the chat it was forked from. That chat's next
   * message carries the fork's work since it branched; nothing runs until a person sends it.
   */
  const mergeBack = Effect.fn("AgentRuntimeApplication.mergeBack")(function* (
    input: import("../../shared/agent-runtime-api").AgentRuntimeMergeBackInput,
  ) {
    if (!validId(input.requestId)) return yield* failure("merge", "Request identity is required");
    const connection = yield* options.connect;
    const fork = yield* targetInfo(connection, input, true);
    const sourceThreadId = agentRuntimeForkSource(fork.thread);
    if (sourceThreadId === null) return yield* failure("merge", "This chat is not a fork");
    const source = yield* connection.request("thread.read", { threadId: sourceThreadId });
    const owner = source
      ? yield* host(
          core.workspace.read({
            kind: "agent_runtime_session_binding_by_execution",
            runtime_id: connection.identity.runtimeId,
            runtime_thread_id: source.lineage.rootThreadId,
          }),
        )
      : null;
    const binding =
      owner?.value.kind === "agent_runtime_session_binding" ? owner.value.binding : null;
    if (!source || source.deletedAt !== null || !binding)
      return yield* failure("merge", "The chat this fork came from is no longer available");
    const target = yield* targetInfo(
      connection,
      { sessionId: binding.session_id, threadId: source.id },
      true,
    );
    // The merged work joins the next message, which must start its own Run.
    if (target.thread.activeRunId !== null)
      return yield* failure(
        "merge",
        "Wait for the reply in the chat this fork came from to finish, then merge.",
      );
    const control = yield* connection.request("thread.control", { threadId: fork.threadId });
    const run = agentRuntimeMergeableRun(control.projection.runs);
    if (!run) return yield* failure("merge", "Finish a reply in this fork before merging it back.");
    const agent = (yield* CoreApplicationAgent) !== null;
    yield* dispatch(connection, {
      type: "thread.merge_back",
      commandId: commandId("merge-back", { threadId: fork.threadId, requestId: input.requestId }),
      sourceThreadId: fork.threadId,
      targetThreadId: source.id,
      sourcePoint: { type: "run", runId: run.id },
      createdBy: agent ? "agent" : "user",
      creationSource: agent ? "mcp" : "web",
    });
    return {
      sessionId: binding.session_id,
      projectId: binding.project_id ?? null,
      threadId: source.id,
    } satisfies AgentRuntimeLaunchResult;
  });

  const message = Effect.fn("AgentRuntimeApplication.message")(function* (
    input: AgentRuntimeSessionTarget & {
      readonly message: AgentRuntimeMessage;
      readonly intent?: DispatchMessage["deliveryIntent"];
      readonly presentationTicket?: import("../../shared/nodex-app-tools/turn-presentation").CodexTurnPresentationTicket;
    },
    queueAfterActive = false,
  ) {
    yield* assertMessage(input.message);
    const connection = yield* options.connect;
    const loaded = yield* targetInfo(connection, input, true);
    // A message that continues the chat on another Agent needs a conversation it can hand over.
    const requested = input.message.modelSelection;
    if (requested && requested.instanceId !== loaded.thread.modelSelection.instanceId) {
      const control = yield* connection.request("thread.control", { threadId: loaded.threadId });
      const refusal = agentRuntimeAgentSwitchRefusal(control.projection);
      if (refusal) return yield* failure("message", refusal);
    }
    const prepared = yield* prepareMessageInput(
      connection,
      input.message,
      loaded.thread.modelSelection,
      loaded.thread.interactionMode,
    );
    yield* assertMessage(prepared.message);
    yield* (
      options.presentation?.admitRuntimeMessage(
        input.presentationTicket,
        { kind: "thread", threadId: loaded.threadId },
        loaded.threadId,
        input.message.messageId,
      ) ?? Effect.void
    );
    const agent = (yield* CoreApplicationAgent) !== null;
    // Only a person's message that starts a Run carries the state they left; a message with app
    // data of its own already speaks for the response it came from.
    const interactive =
      options.interactiveState &&
      !agent &&
      !queueAfterActive &&
      !prepared.hasConfig &&
      (input.intent ?? "auto") === "auto" &&
      loaded.thread.activeRunId === null &&
      !hasAgentAppContext(prepared.message)
        ? yield* options.interactiveState.unsent(loaded.threadId)
        : undefined;
    const outgoing = interactive
      ? appendAgentAppContext(prepared.message, interactive.parts, "Interactive response state")
      : prepared.message;
    const result = yield* dispatch(
      connection,
      messageCommand(
        loaded.threadId,
        yield* prepareMessage(connection, loaded.threadId, outgoing),
        input.intent,
        agent,
        queueAfterActive || prepared.hasConfig,
      ),
    );
    if (interactive) yield* options.interactiveState!.sent(loaded.threadId, interactive.key);
    return result;
  });

  const stop = Effect.fn("AgentRuntimeApplication.stop")(function* (
    input: AgentRuntimeSessionTarget & { readonly runId: string },
  ) {
    const connection = yield* options.connect;
    yield* authorizeSession(input.sessionId);
    const loaded = yield* targetInfo(connection, input);
    if (!validId(input.runId)) return yield* failure("stop", "Run identity is required");
    if (loaded.thread.activeRunId !== input.runId) return { stopped: false };
    yield* dispatch(connection, {
      type: "run.interrupt",
      commandId: commandId("stop", { threadId: loaded.threadId, runId: input.runId }),
      threadId: loaded.threadId,
      runId: input.runId,
      holdQueue: true,
    });
    return { stopped: true };
  });

  const respond = Effect.fn("AgentRuntimeApplication.respond")(function* (
    input: AgentRuntimeSessionTarget &
      Pick<Respond, "requestId" | "decision" | "answers" | "attachmentsByQuestionId"> & {
        readonly runId: string | null;
      },
  ) {
    const connection = yield* options.connect;
    if (!validId(input.requestId) || (input.runId !== null && !validId(input.runId)))
      return yield* failure("respond", "Request identity is required");
    const loaded = yield* targetInfo(connection, input, true);
    const snapshot = yield* connection.request("thread.control", { threadId: loaded.threadId });
    const request = snapshot.projection.runtimeRequests.find(
      (request) => request.id === input.requestId,
    );
    const node = snapshot.projection.nodes.find((node) => node.id === request?.nodeId);
    if (
      !request ||
      (request.kind !== "user_input" && request.kind !== "mcp-elicitation") ||
      request.status !== "pending" ||
      node?.runId !== input.runId ||
      (input.runId === null && request.responseCapability.type !== "live")
    )
      return yield* failure(
        "respond",
        "This request is no longer pending for its original execution source",
      );
    if (request.responseCapability.type === "not_resumable")
      return yield* failure("respond", request.responseCapability.reason);
    const { decision, answers, attachmentsByQuestionId } = input;
    return yield* dispatch(connection, {
      type: "runtime-request.respond",
      commandId: commandId("response", { threadId: loaded.threadId, requestId: input.requestId }),
      threadId: loaded.threadId,
      requestId: input.requestId,
      ...(decision === undefined ? {} : { decision }),
      ...(answers === undefined ? {} : { answers }),
      ...(attachmentsByQuestionId === undefined ? {} : { attachmentsByQuestionId }),
    });
  });

  const setModes = Effect.fn("AgentRuntimeApplication.setModes")(function* (
    input: AgentRuntimeSessionTarget & {
      readonly requestId: string;
      readonly interactionMode?: CreateThread["interactionMode"];
    },
  ) {
    if (!validId(input.requestId) || input.interactionMode === undefined)
      return yield* failure("mode", "An execution mode and request identity are required");
    const connection = yield* options.connect;
    const loaded = yield* targetInfo(connection, input, true);
    if (input.interactionMode !== undefined)
      yield* dispatch(connection, {
        type: "thread.interaction-mode.set",
        commandId: commandId("interaction-mode", {
          threadId: loaded.threadId,
          requestId: input.requestId,
        }),
        threadId: loaded.threadId,
        interactionMode: input.interactionMode,
      });
    return { changed: true };
  });

  const readCleanups = Effect.fn("AgentRuntimeApplication.readCleanups")(function* (
    connection: AgentRuntimeApplicationConnection,
    after: string | null,
  ) {
    const response = yield* host(
      core.workspace.read({
        kind: "agent_runtime_execution_cleanup_window",
        runtime_id: connection.identity.runtimeId,
        window: { after, first: 200 },
      }),
    );
    if (response.value.kind !== "agent_runtime_execution_cleanup_window")
      return yield* failure("cleanup", "Session execution cleanup is unavailable");
    return response.value.cleanups;
  });
  const queue = Effect.fn("AgentRuntimeApplication.queue")(function* (
    input: import("../../shared/agent-runtime-api").AgentRuntimeQueueInput,
  ) {
    if (!validId(input.requestId)) return yield* failure("queue", "Request identity is invalid");
    if (
      input.action === "reorder" &&
      (input.orderedRunIds.length === 0 ||
        input.orderedRunIds.length > 128 ||
        new Set(input.orderedRunIds).size !== input.orderedRunIds.length ||
        input.orderedRunIds.some((id) => !validId(id)))
    )
      return yield* failure("queue", "Queue order is invalid");
    if ("runId" in input && input.runId !== undefined && !validId(input.runId))
      return yield* failure("queue", "Run identity is invalid");
    if (input.action === "steer" && !validId(input.targetRunId))
      return yield* failure("queue", "Target Run identity is invalid");
    const connection = yield* options.connect;
    const loaded = yield* targetInfo(connection, input, true);
    const identity = {
      requestId: input.requestId,
      threadId: loaded.threadId,
      action: input.action,
    };
    const base = { threadId: loaded.threadId, commandId: commandId("queue", identity) };
    switch (input.action) {
      case "resume":
        return yield* dispatch(connection, {
          ...base,
          type: "queue.resume",
          ...(input.runId === undefined ? {} : { runId: input.runId }),
        });
      case "cancel":
        return yield* dispatch(connection, {
          ...base,
          type: "queued-run.cancel",
          runId: input.runId,
        });
      case "steer":
        return yield* dispatch(connection, {
          ...base,
          type: "queued-message.promote-to-steer",
          queuedRunId: input.runId,
          targetRunId: input.targetRunId,
        });
      case "edit": {
        yield* assertMessage(input.message);
        // An omitted attachment replacement retains the queued message's images.
        // Only a model/config change needs this bounded preview for admission.
        const retained =
          input.message.attachments === undefined &&
          !input.message.images?.length &&
          (input.message.modelSelection !== undefined ||
            messageAgentConfigs(input.message).length > 0)
            ? yield* connection.request("thread.queued-preview", {
                threadId: loaded.threadId,
                runId: input.runId,
              })
            : null;
        const retainsImages = (retained?.images.length ?? 0) > 0;
        const imageEdit = retainsImages || hasImageInputs(input.message);
        const queued = imageEdit
          ? (yield* connection.request("thread.control", {
              threadId: loaded.threadId,
              runId: input.runId,
            })).projection.runs.find((run) => run.id === input.runId && run.status === "queued")
          : undefined;
        if (imageEdit && !queued)
          return yield* failure("queue", "The queued Run is no longer available for editing");
        const prepared = yield* prepareMessageInput(
          connection,
          input.message,
          queued?.modelSelection ?? loaded.thread.modelSelection,
          queued?.interactionMode ?? loaded.thread.interactionMode,
          retainsImages,
        );
        yield* assertMessage(prepared.message);
        const message = yield* prepareMessage(connection, loaded.threadId, prepared.message);
        const result = yield* dispatch(connection, {
          ...base,
          type: "queued-run.edit",
          runId: input.runId,
          text: message.text,
          ...(message.attachments ? { attachments: message.attachments } : {}),
          ...(message.context ? { context: message.context } : {}),
          ...(message.modelSelection ? { modelSelection: message.modelSelection } : {}),
          ...(message.interactionMode ? { interactionMode: message.interactionMode } : {}),
        });
        if (input.presentationTicket && options.presentation) {
          const outcome = yield* connection.request("run.outcome", {
            threadId: loaded.threadId,
            messageId: input.message.messageId,
          });
          if (outcome?.runId === input.runId && outcome.status === "queued")
            yield* options.presentation.replaceQueuedRuntimeMessage(
              input.presentationTicket,
              loaded.threadId,
              input.message.messageId,
              input.requestId,
            );
        }
        return result;
      }
      case "reorder": {
        let sequence = 0;
        for (let index = input.orderedRunIds.length - 1; index >= 0; index -= 1) {
          const result = yield* dispatch(connection, {
            threadId: loaded.threadId,
            type: "queued-run.reorder",
            commandId: commandId("queue-order", { ...identity, index }),
            runId: input.orderedRunIds[index]!,
            beforeRunId: input.orderedRunIds[index + 1] ?? input.beforeRunId ?? null,
          });
          sequence = result.sequence;
        }
        return { sequence };
      }
    }
  });
  const rollback = Effect.fn("AgentRuntimeApplication.rollback")(function* (
    input: import("../../shared/agent-runtime-api").AgentRuntimeRollbackInput,
  ) {
    if (!validId(input.requestId) || !validId(input.runId))
      return yield* failure("rollback", "Rollback identity is invalid");
    if (!options.subscribeExecutionChanges)
      return yield* failure("rollback", "Execution observation is unavailable");
    const connection = yield* options.connect;
    const loaded = yield* targetInfo(connection, input, true);
    const changes = yield* options.subscribeExecutionChanges;
    const accepted = yield* connection.request("thread.rollback", {
      threadId: loaded.threadId,
      requestId: input.requestId,
      runId: input.runId,
    });
    const result = yield* Stream.succeed(undefined).pipe(
      Stream.concat(changes),
      Stream.mapEffect(() =>
        Effect.gen(function* () {
          const current = yield* options.connect;
          const target = yield* targetInfo(current, input, true);
          const control = yield* current.request("thread.control", { threadId: target.threadId });
          if (control.projection.thread.rollbackFailure?.requestId === accepted.commandId)
            return yield* failure("rollback", control.projection.thread.rollbackFailure.message);
          const outcome = yield* current.request("run.outcome", {
            threadId: target.threadId,
            messageId: accepted.userMessageId,
          });
          if (outcome && outcome.runId !== input.runId)
            return yield* failure("rollback", "Rollback execution identity changed");
          return outcome?.status === "rolled_back";
        }),
      ),
      Stream.filter((settled) => settled),
      Stream.runHead,
      Effect.timeout("1 minute"),
    );
    if (Option.isNone(result))
      return yield* failure("rollback", "Rollback observation ended before settlement");
    return { rolledBack: true as const };
  });
  const settleCleanup = Effect.fn("AgentRuntimeApplication.settleCleanup")(function* (
    connection: AgentRuntimeApplicationConnection,
    cleanup: Cleanup,
  ) {
    if (cleanup.runtime_id !== connection.identity.runtimeId)
      return yield* failure("cleanup", "Execution cleanup belongs to another runtime");
    const thread = yield* connection.request("thread.read", {
      threadId: cleanup.runtime_thread_id,
    });
    if (thread?.deletedAt === null)
      yield* dispatch(connection, {
        type: "thread.delete",
        threadId: cleanup.runtime_thread_id,
        commandId: commandId("delete-session", {
          cleanupId: cleanup.cleanup_id,
          threadId: cleanup.runtime_thread_id,
        }),
      });
    const settled = yield* connection.request("thread.read", {
      threadId: cleanup.runtime_thread_id,
    });
    if (settled?.deletedAt === null)
      return yield* failure("cleanup", "Execution deletion has not committed");
    yield* host(
      core.workspace.apply({
        operationId: createOperationId("agent-runtime.cleanup-ack"),
        intent: {
          kind: "acknowledge_agent_runtime_execution_cleanup",
          cleanup_id: cleanup.cleanup_id,
          runtime_id: cleanup.runtime_id,
          runtime_thread_id: cleanup.runtime_thread_id,
        },
      }),
    );
  });
  /** A live Thread and the Session bound to its root, read without touching execution. */
  const readBoundThread = Effect.fn("AgentRuntimeApplication.readBoundThread")(function* (
    threadId: string,
  ) {
    if (options.runtimeExists && !(yield* options.runtimeExists)) return null;
    const connection = yield* options.connect;
    const thread = yield* connection.request("thread.read", { threadId });
    if (!thread || thread.deletedAt) return null;
    const binding = yield* host(
      core.workspace.read({
        kind: "agent_runtime_session_binding_by_execution",
        runtime_id: connection.identity.runtimeId,
        runtime_thread_id: thread.lineage.rootThreadId,
      }),
    );
    if (binding.value.kind !== "agent_runtime_session_binding" || !binding.value.binding)
      return null;
    return { connection, thread, sessionId: binding.value.binding.session_id };
  });
  /** A Thread of a bound Session; an archived one is still readable but never executes. */
  const boundThread = Effect.fn("AgentRuntimeApplication.boundThread")(function* (
    threadId: string,
    allowArchived: boolean,
  ) {
    const bound = yield* readBoundThread(threadId);
    if (!bound || (!allowArchived && bound.thread.archivedAt)) return null;
    yield* targetInfo(bound.connection, { sessionId: bound.sessionId, threadId });
    return bound;
  });
  const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  /** Agent chats as owners of managed worktrees, described like native Threads. */
  const worktreeChats: AgentChatWorktreeSource = {
    consumers: (owners) =>
      owned(
        "worktree-consumers",
        Effect.forEach(
          owners,
          (owner) =>
            Effect.gen(function* () {
              const bound = yield* readBoundThread(owner.ownerThreadId);
              if (!bound) return [];
              const session = yield* workspace.getProjectSession(bound.sessionId);
              if (!session) return [];
              const { thread } = bound;
              const working =
                thread.activeRunId !== null || (thread.pendingBackgroundTasks?.length ?? 0) > 0;
              return [
                {
                  threadId: thread.id,
                  projectId: session.projectId,
                  sessionId: session.id,
                  executionHostId: owner.hostId,
                  cwd: thread.worktreePath,
                  managedWorktreePath: owner.worktreeGitRoot,
                  runtimeWorkspaceRoots: [],
                  archived: session.archived,
                  pinnedOrder: session.pinnedOrder,
                  statusType: working ? "active" : "idle",
                  statusActiveFlags: [],
                  // Native Threads count in seconds.
                  createdAt: seconds(thread.createdAt),
                  updatedAt: Math.max(seconds(thread.updatedAt), seconds(session.updatedAt)),
                  linkedAt: session.createdAt,
                  title: session.displayTitle,
                } satisfies AgentChatWorktreeConsumer,
              ];
            }),
          { concurrency: 4 },
        ).pipe(Effect.map((consumers) => consumers.flat())),
      ),
    location: (threadId) =>
      owned(
        "worktree-location",
        Effect.gen(function* () {
          const bound = yield* readBoundThread(threadId);
          if (!bound?.thread.worktreePath) return null;
          const session = yield* workspace.getProjectSession(bound.sessionId);
          if (!session) return null;
          return { threadId, projectId: session.projectId, cwd: bound.thread.worktreePath };
        }),
      ),
    archive: (threadId) =>
      Effect.gen(function* () {
        const bound = yield* owned("worktree-archive", readBoundThread(threadId));
        if (!bound) return;
        yield* withSessionLifecycle(
          "archive-session",
          bound.sessionId,
          archiveSession(
            {
              operationId: createOperationId("agent-runtime.worktree-archive"),
              payload: { sessionId: bound.sessionId },
            },
            true,
          ),
        );
      }),
  };
  const cleanupDeletedSessions = Effect.fn("AgentRuntimeApplication.cleanupDeletedSessions")(
    function* () {
      if (yield* CoreApplicationAgent)
        return yield* failure("cleanup", "Execution cleanup requires the Desktop Host");
      const connection = yield* options.connect;
      let after: string | null = null;
      let completed = 0;
      do {
        const window: CleanupWindow = yield* readCleanups(connection, after);
        for (const cleanup of window.items) {
          yield* settleCleanup(connection, cleanup);
          completed += 1;
        }
        after = window.next_cursor ?? null;
      } while (after !== null);
      return { completed };
    },
  );
  const archiveSession = Effect.fn("AgentRuntimeApplication.archiveSession")(function* (
    command: ProjectSessionArchiveCommandInput,
    archived: boolean,
  ) {
    const result = yield* archived
      ? workspace.archiveProjectSession(command)
      : workspace.unarchiveProjectSession(command);
    if (archived && result.value.archived)
      yield* options.releaseDesktopSession?.(result.value.id) ?? Effect.void;
    if (!result.value.executionRef || result.value.archived !== archived) return result;
    yield* afterCommit(
      command.operationId,
      "archive-session",
      Effect.gen(function* () {
        const connection = yield* options.connect;
        yield* host(
          reconcileExecution(connection, yield* readBinding(connection, result.value.id, false)),
        );
      }),
    );
    return result;
  });
  const deleteSession = Effect.fn("AgentRuntimeApplication.deleteSession")(function* (
    command: ProjectSessionDeleteCommandInput,
  ) {
    const result = yield* workspace.deleteProjectSession(command);
    yield* options.releaseDesktopSession?.(command.payload.sessionId) ?? Effect.void;
    if (!options.runtimeExists || (yield* options.runtimeExists))
      yield* afterCommit(command.operationId, "delete-session", host(cleanupDeletedSessions()));
    return result;
  });

  return {
    clearPredictions: (threadId?: string) =>
      owned(
        "prediction-clear",
        Effect.gen(function* () {
          const connection = yield* options.currentConnection;
          if (!connection) return;
          yield* connection.request(
            "native.prediction.clear",
            threadId === undefined ? {} : { threadId },
          );
        }),
      ),
    nativeThread: (threadId: string) => owned("native-thread", boundThread(threadId, false)),
    worktreeChats,
    /** The Codex thread and workspace an Agent chat's reply visualizations are read from. */
    visualizationSource: (threadId: string) =>
      owned(
        "visualization-source",
        Effect.gen(function* () {
          const bound = yield* boundThread(threadId, true);
          if (!bound?.thread.activeProviderThreadId) return null;
          const snapshot = yield* bound.connection.request("thread.control", { threadId });
          const native = snapshot.projection.providerThreads.find(
            (provider) => provider.id === bound.thread.activeProviderThreadId,
          )?.nativeThreadRef;
          if (native?.driver !== "codex" || !native.nativeId) return null;
          return { nativeThreadId: native.nativeId, cwd: bound.thread.worktreePath };
        }),
      ),
    withExecutionLocationWriter: <A, E, R>(sessionId: string, use: Effect.Effect<A, E, R>) =>
      withSessionLane(sessionId, ownedWrite("execution-handoff", use)),
    generateStructured: (
      input: import("../../shared/agent-runtime-api").AgentRuntimeStructuredGenerationInput,
    ) =>
      ownedWrite(
        "structured-generation",
        options.connect.pipe(
          Effect.flatMap((connection) => connection.request("text.generate-structured", input)),
        ),
      ),
    sessionsForThreads: (threadIds: readonly string[]) =>
      owned(
        "resolve-thread-sessions",
        Effect.gen(function* () {
          const connection = yield* options.currentConnection;
          if (!connection) return [];
          const bindings = yield* Effect.forEach(
            [...new Set(threadIds)].slice(0, 128),
            (threadId) =>
              Effect.gen(function* () {
                const reply = yield* host(
                  core.workspace.read({
                    kind: "agent_runtime_session_binding_by_execution",
                    runtime_id: connection.identity.runtimeId,
                    runtime_thread_id: threadId,
                  }),
                );
                if (reply.value.kind !== "agent_runtime_session_binding" || !reply.value.binding)
                  return null;
                return { sessionId: reply.value.binding.session_id, threadId };
              }),
          );
          return bindings.filter((binding) => binding !== null);
        }),
      ),
    resolveSession: (sessionId: string) =>
      owned(
        "resolve",
        Effect.gen(function* () {
          const connection = yield* options.connect;
          const binding = yield* readBinding(connection, sessionId, false);
          return {
            sessionId: binding.session_id,
            projectId: binding.project_id ?? null,
            runtimeId: binding.runtime_id,
            rootThreadId: binding.runtime_thread_id,
            engineProjectId: engineProjectId(binding.project_id ?? null),
          };
        }),
      ),
    resolveTarget: (target: AgentRuntimeSessionTarget) =>
      owned(
        "resolve-target",
        Effect.gen(function* () {
          const connection = yield* options.connect;
          const loaded = yield* targetInfo(connection, target);
          return {
            sessionId: loaded.binding.session_id,
            projectId: loaded.binding.project_id ?? null,
            runtimeId: loaded.binding.runtime_id,
            rootThreadId: loaded.binding.runtime_thread_id,
            threadId: loaded.threadId,
          };
        }),
      ),
    launch: (input: AgentRuntimeLaunch) => ownedWrite("launch", launch(input).pipe(Effect.scoped)),
    importAcp: (input: Parameters<typeof importAcp>[0]) =>
      withSessionLane(
        `acp:${input.instanceId}:${input.sessionId}:${input.cwd}`,
        ownedWrite("import-acp", importAcp(input).pipe(Effect.scoped)),
      ),
    findNativeImports: (input: Parameters<typeof findNativeImports>[0]) =>
      owned("import.find", findNativeImports(input)),
    submitNativeImport: (
      input: NativeConversationImportInput,
      prepare: Parameters<typeof submitNativeImport>[1],
    ) =>
      withSessionLane(
        input.requestId,
        ownedWrite("import", submitNativeImport(input, prepare).pipe(Effect.scoped)),
      ),
    renameSession: (command: ProjectSessionRenameCommandInput) =>
      ownedWrite("rename-session", workspace.renameProjectSession(command)),
    archiveSession: (command: ProjectSessionArchiveCommandInput) =>
      withSessionLifecycle(
        "archive-session",
        command.payload.sessionId,
        archiveSession(command, true),
      ),
    unarchiveSession: (command: ProjectSessionArchiveCommandInput) =>
      withSessionLifecycle(
        "unarchive-session",
        command.payload.sessionId,
        archiveSession(command, false),
      ),
    deleteSession: (command: ProjectSessionDeleteCommandInput) =>
      withSessionLifecycle("delete-session", command.payload.sessionId, deleteSession(command)),
    setPinnedSession: (command: ProjectSessionPinnedCommandInput) =>
      ownedWrite("pin-session", workspace.setProjectSessionPinned(command)),
    moveSession: (input: {
      readonly operationId: string;
      readonly sessionId: string;
      readonly projectId: string | null;
    }) =>
      withSessionLifecycle(
        "move-session",
        input.sessionId,
        Effect.gen(function* () {
          if (
            !validId(input.operationId) ||
            !validId(input.sessionId) ||
            (input.projectId !== null && !validId(input.projectId))
          )
            return yield* failure("move-session", "Session and Project identities are required");
          yield* authorizeSession(input.sessionId);
          yield* projectScope(input.projectId, false);
          yield* core.workspace.apply({
            operationId: input.operationId,
            intent: {
              kind: "move_session",
              session_id: input.sessionId,
              project_id: input.projectId,
            },
          });
          if (options.runtimeExists && !(yield* options.runtimeExists))
            return { sessionId: input.sessionId, projectId: input.projectId };
          yield* afterCommit(
            input.operationId,
            "move-session",
            Effect.gen(function* () {
              const proof = yield* host(
                core.workspace.read({
                  kind: "agent_runtime_session_binding",
                  session_id: input.sessionId,
                }),
              );
              if (proof.value.kind !== "agent_runtime_session_binding" || !proof.value.binding)
                return;
              const connection = yield* options.connect;
              if (proof.value.binding.runtime_id !== connection.identity.runtimeId)
                return yield* failure("placement", "Session belongs to another runtime");
              yield* reconcileExecution(connection, proof.value.binding);
            }),
          );
          return { sessionId: input.sessionId, projectId: input.projectId };
        }),
      ),
    cleanupDeletedSessions: ownedWrite("cleanup", cleanupDeletedSessions()),
    closeProjectExecution: (projectId: string) =>
      ownedWrite(
        "close-project",
        Effect.gen(function* () {
          if (!validId(projectId))
            return yield* failure("close-project", "A Project identity is required");
          yield* validateCaller();
          yield* projectScope(projectId, false);
          if (options.runtimeExists && !(yield* options.runtimeExists))
            return { closedBindings: 0 };
          const connection = yield* options.connect;
          yield* validateCaller();
          yield* reconcileProject(connection, projectId);
          return yield* connection.request("project.close", { projectId });
        }),
      ),
    fork: (input: Parameters<typeof fork>[0]) =>
      ownedWrite("fork", fork(input).pipe(Effect.scoped)),
    read: (target: AgentRuntimeSessionTarget) =>
      owned(
        "read",
        options.connect.pipe(
          Effect.flatMap((connection) => load(connection, target)),
          Effect.map(conversation),
        ),
      ),
    control: (target: AgentRuntimeControlInput) =>
      owned(
        "control",
        Effect.gen(function* () {
          if (target.runId !== undefined && !validId(target.runId))
            return yield* failure("control", "Run identity is invalid");
          const connection = yield* options.connect;
          const loaded = yield* targetInfo(connection, target);
          const snapshot = yield* connection.request("thread.control", {
            threadId: loaded.threadId,
            ...(target.runId === undefined ? {} : { runId: target.runId }),
          });
          return {
            sessionId: loaded.binding.session_id,
            projectId: loaded.binding.project_id ?? null,
            threadId: loaded.threadId,
            snapshot,
          };
        }),
      ),
    inspect: (target: AgentRuntimeSessionTarget) =>
      owned(
        "inspect",
        options.connect.pipe(
          Effect.flatMap((connection) => targetInfo(connection, target)),
          Effect.map(({ binding, threadId, thread }) => ({
            sessionId: binding.session_id,
            projectId: binding.project_id ?? null,
            runtimeId: binding.runtime_id,
            rootThreadId: binding.runtime_thread_id,
            threadId,
            thread,
          })),
        ),
      ),
    projectActivity: (projectId: string) =>
      owned(
        "project-activity",
        Effect.gen(function* () {
          if (!validId(projectId)) return yield* failure("project", "Project identity is invalid");
          yield* validateCaller();
          yield* projectScope(projectId, false);
          if (options.runtimeExists && !(yield* options.runtimeExists))
            return { snapshotSequence: 0, run: null, runtimeRequest: null, nativeBackground: null };
          const connection = yield* options.connect;
          yield* reconcileProject(connection, projectId, true);
          return yield* connection.request("project.activity", { projectId });
        }),
      ),
    readQueuePage: (input: AgentRuntimeSessionTarget & { readonly cursor?: string }) =>
      owned(
        "queue-read",
        Effect.gen(function* () {
          const connection = yield* options.connect;
          const loaded = yield* targetInfo(connection, input);
          return yield* connection.request("thread.queue", {
            threadId: loaded.threadId,
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          });
        }),
      ),
    readQueuedPreview: (input: AgentRuntimeSessionTarget & { readonly runId: string }) =>
      owned(
        "queued-preview",
        Effect.gen(function* () {
          if (!validId(input.runId))
            return yield* failure("queued-preview", "Run identity is invalid");
          const connection = yield* options.connect;
          const loaded = yield* targetInfo(connection, input);
          return yield* connection.request("thread.queued-preview", {
            threadId: loaded.threadId,
            runId: input.runId,
          });
        }),
      ),
    readRunMessage: (input: AgentRuntimeSessionTarget & { readonly runId: string }) =>
      owned(
        "run-message",
        Effect.gen(function* () {
          if (!validId(input.runId))
            return yield* failure("run-message", "Run identity is invalid");
          const connection = yield* options.connect;
          const loaded = yield* targetInfo(connection, input);
          return yield* connection.request("thread.run-message", {
            threadId: loaded.threadId,
            runId: input.runId,
          });
        }),
      ),
    runOutcome: (input: AgentRuntimeSessionTarget & { readonly messageId: string }) =>
      owned(
        "run-outcome",
        Effect.gen(function* () {
          if (!validId(input.messageId))
            return yield* failure("run-outcome", "Message identity is invalid");
          const connection = yield* options.connect;
          const loaded = yield* targetInfo(connection, input);
          return yield* connection.request("run.outcome", {
            threadId: loaded.threadId,
            messageId: input.messageId,
          });
        }),
      ),
    message: (input: Parameters<typeof message>[0]) => ownedWrite("message", message(input)),
    mergeBack: (input: Parameters<typeof mergeBack>[0]) =>
      ownedWrite("merge-back", mergeBack(input)),
    /** Read before retrying a durable handoff: archive and execution failure do not erase admission. */
    messageAdmission: (input: {
      readonly sessionId: string;
      readonly messageId: string;
      readonly expectedExecutionRef?: { readonly runtimeId: string; readonly threadId: string };
      readonly launchId?: string;
    }) =>
      owned(
        "message-admission",
        Effect.gen(function* () {
          if (
            !validId(input.sessionId) ||
            !validId(input.messageId) ||
            (input.launchId !== undefined && !validId(input.launchId))
          )
            return yield* failure(
              "message-admission",
              "Session and message identities are required",
            );
          yield* authorizeSession(input.sessionId);
          const binding = yield* lookupDestinationBinding(input.sessionId);
          const runtimeId = input.expectedExecutionRef?.runtimeId ?? binding?.runtime_id;
          const threadId =
            input.expectedExecutionRef?.threadId ??
            (input.launchId
              ? launchThreadId(input.launchId, input.sessionId)
              : binding?.runtime_thread_id);
          if (!runtimeId || !threadId) return null;
          const connection = yield* options.connect;
          if (runtimeId !== connection.identity.runtimeId)
            return yield* failure(
              "message-admission",
              "Session belongs to another execution owner",
            );
          let identity = commandId("message", { threadId, messageId: input.messageId });
          let receipt = yield* connection.request("command.receipt", {
            commandId: identity,
            threadId,
          });
          if (!receipt && input.launchId) {
            const launchIdentity = commandId("launch-thread", {
              launchId: input.launchId,
              sessionId: input.sessionId,
            });
            const launchReceipt = yield* connection.request("command.receipt", {
              commandId: launchIdentity,
              threadId,
            });
            // A refused Thread prevents submission. An accepted Thread proves nothing about its message.
            if (launchReceipt?.status === "rejected") {
              receipt = launchReceipt;
              identity = launchIdentity;
            }
          }
          return receipt
            ? {
                ...receipt,
                runtimeId,
                threadId,
                messageId: input.messageId,
                commandId: identity,
              }
            : null;
        }),
      ),
    queueMessage: (input: Parameters<typeof message>[0]) =>
      ownedWrite("queue-message", message(input, true)),
    queue: (input: Parameters<typeof queue>[0]) => ownedWrite("queue", queue(input)),
    rollback: (input: Parameters<typeof rollback>[0]) =>
      ownedWrite("rollback", rollback(input).pipe(Effect.scoped)),
    stopTask: (input: import("../../shared/agent-runtime-api").AgentRuntimeTaskStopInput) =>
      ownedWrite(
        "stop-task",
        Effect.gen(function* () {
          if (![input.requestId, input.runId, input.taskId].every(validId))
            return yield* failure("stop-task", "Task identity is invalid");
          const connection = yield* options.connect;
          const loaded = yield* targetInfo(connection, input, true);
          return yield* dispatch(connection, {
            type: "subagent.stop",
            commandId: commandId("stop-task", {
              requestId: input.requestId,
              threadId: loaded.threadId,
            }),
            threadId: loaded.threadId,
            runId: input.runId,
            subagentId: input.taskId,
          });
        }),
      ),
    stop: (input: Parameters<typeof stop>[0]) => ownedWrite("stop", stop(input)),
    retryPreparation: (input: Parameters<typeof retryPreparation>[0]) =>
      ownedWrite("retry-preparation", retryPreparation(input)),
    reconcileLiveExecutions: () => owned("reconcile-live", reconcileLiveExecutions()),
    respond: (input: Parameters<typeof respond>[0]) => ownedWrite("respond", respond(input)),
    setModes: (input: Parameters<typeof setModes>[0]) => ownedWrite("mode", setModes(input)),
    compact: (input: import("../../shared/agent-runtime-api").AgentRuntimeCompactInput) =>
      ownedWrite(
        "compact",
        Effect.gen(function* () {
          if (!validId(input.requestId))
            return yield* failure("compact", "Request identity is invalid");
          const connection = yield* options.connect;
          const loaded = yield* targetInfo(connection, input, true);
          return yield* connection.request("thread.compact", {
            threadId: loaded.threadId,
            requestId: input.requestId,
          });
        }),
      ),
    catalog: (input: AgentRuntimeOperations["providers.read"]["input"] = {}) =>
      owned(
        "catalog",
        Effect.gen(function* () {
          const named = input.instanceIds;
          const known =
            input.refresh || !options.providerCatalog
              ? null
              : yield* options.providerCatalog.lastKnown;
          if (known)
            return named ? known.filter((provider) => named.includes(provider.instanceId)) : known;
          const connection = yield* options.connect;
          const providers = yield* connection.request("providers.read", input);
          // Only a whole catalog stands in for the process while it is stopped.
          if (options.providerCatalog && !named) yield* options.providerCatalog.record(providers);
          return providers;
        }),
      ),
    /** Signs the named Agents out of the sign-in their own CLI keeps; answers their new state. */
    logoutProviders: (instanceIds: readonly string[]) =>
      owned(
        "logout",
        Effect.gen(function* () {
          const connection = yield* options.connect;
          return yield* connection.request("providers.logout", { instanceIds });
        }),
      ),
    /**
     * The catalog Nodex already knows, without starting execution: a running process answers
     * live (and the answer is kept), a stopped one is represented by the kept catalog, and null
     * means nothing current is known yet.
     */
    knownCatalog: () =>
      owned(
        "catalog",
        Effect.gen(function* () {
          const live = yield* liveCatalog({});
          if (live) return live;
          return options.providerCatalog ? yield* options.providerCatalog.saved : null;
        }),
      ),
    /** A provider read only while execution already runs; null when it is stopped. */
    catalogWhileRunning: (input: AgentRuntimeOperations["providers.read"]["input"]) =>
      owned("catalog", liveCatalog(input)),
    history: (
      input: AgentRuntimeSessionTarget &
        Omit<AgentRuntimeOperations["thread.history"]["input"], "threadId">,
    ): Effect.Effect<AgentHistoryPage, AgentRuntimeApplicationError> =>
      owned(
        "history",
        Effect.gen(function* () {
          const connection = yield* options.connect;
          const loaded = yield* targetInfo(connection, input);
          return yield* connection.request("thread.history", {
            threadId: loaded.threadId,
            cursor: input.cursor,
            ...(input.throughEntryId === undefined ? {} : { throughEntryId: input.throughEntryId }),
            ...(input.conversationOnly === undefined
              ? {}
              : { conversationOnly: input.conversationOnly }),
          });
        }),
      ),
    overview: (
      input: AgentRuntimeSessionTarget &
        Omit<AgentRuntimeOperations["tasks.overview"]["input"], "threadId">,
    ) =>
      owned(
        "overview",
        Effect.gen(function* () {
          const connection = yield* options.connect;
          const loaded = yield* targetInfo(connection, input);
          return yield* connection.request("tasks.overview", {
            threadId: loaded.threadId,
            ...(input.activeCursor === undefined ? {} : { activeCursor: input.activeCursor }),
            ...(input.terminalCursor === undefined ? {} : { terminalCursor: input.terminalCursor }),
          });
        }),
      ),
    attachment: (
      input: AgentRuntimeSessionTarget & {
        readonly itemId: string;
        readonly attachmentId: string;
        readonly sourceThreadId?: string;
      },
    ) =>
      owned(
        "attachment",
        Effect.gen(function* () {
          if (
            !validId(input.itemId) ||
            !validId(input.attachmentId) ||
            (input.sourceThreadId !== undefined && !validId(input.sourceThreadId))
          )
            return yield* failure("attachment", "Attachment identity is invalid");
          const connection = yield* options.connect;
          const loaded = yield* targetInfo(connection, input);
          return yield* connection.request("thread.attachment", {
            threadId: loaded.threadId,
            itemId: input.itemId,
            attachmentId: input.attachmentId,
            ...(input.sourceThreadId === undefined ? {} : { sourceThreadId: input.sourceThreadId }),
          });
        }),
      ),
    item: (
      input: AgentRuntimeSessionTarget & {
        readonly itemId: string;
        readonly sourceThreadId?: string;
        readonly full?: true;
      },
    ): Effect.Effect<AgentTurnItem | null, AgentRuntimeApplicationError> =>
      owned(
        "item",
        Effect.gen(function* () {
          const connection = yield* options.connect;
          if (
            !validId(input.itemId) ||
            (input.sourceThreadId !== undefined && !validId(input.sourceThreadId))
          )
            return yield* failure("item", "Item identity is invalid");
          const loaded = yield* targetInfo(connection, input);
          return yield* connection.request(input.full ? "thread.item.full" : "thread.item", {
            threadId: loaded.threadId,
            itemId: input.itemId,
            ...(input.sourceThreadId === undefined ? {} : { sourceThreadId: input.sourceThreadId }),
          });
        }),
      ),
  };
});

export class AgentRuntimeApplication extends Context.Service<
  AgentRuntimeApplication,
  Effect.Success<ReturnType<typeof make>>
>()("nodex/main/agent-runtime/AgentRuntimeApplication") {}
export const layer = (options: AgentRuntimeApplicationOptions) =>
  Layer.effect(AgentRuntimeApplication, make(options));
