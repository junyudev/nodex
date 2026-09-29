import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
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
import { createUuidV7 } from "../../../shared/uuid-v7";
import type { AgentBackendSessionChangedEvent } from "../../../shared/agent-backend-api";
import type {
  AgentConversationSnapshot,
  AgentInteractionResponse,
  AgentSessionConfigOption,
  AgentSessionConfigSelectOption,
  AgentSessionModeState,
} from "../../../shared/agent-conversation";
import type { ClaudeAgentInstanceConfig } from "../../../shared/types";
import { MainConfig } from "../../app/MainConfig";
import { claudeHistoryModel, claudeModelOptions, claudeSessionConfigOptions } from "./ClaudeModels";
import { isClaudeEffortLevel, type ClaudeEffortSelection } from "../../../shared/claude-models";
import { ClaudeSdk, type ClaudeToolRequest } from "../../platform/node/ClaudeSdk";
import { ApplicationSettings } from "../../settings/ApplicationSettings";
import { agentRuntimeError, type AgentRuntimeError } from "../AgentRuntimeError";
import type { AgentSessionHandle } from "../AgentSessionHandle";
import {
  beginAgentConversationTurn,
  closeAgentConversation,
  diffAgentConversationSnapshots,
  emptyAgentConversationSnapshot,
  failAgentConversation,
  recoverAgentConversationTurnFailure,
  reduceAgentConversationEvent,
} from "../AgentConversationProjection";
import {
  createClaudeMessageProjection,
  projectClaudeHistory,
} from "./ClaudeConversationProjection";

export interface OpenClaudeSessionInput {
  readonly threadId: string;
  readonly instanceConfigId: string;
  readonly workspaceRoot: string;
  readonly sessionId?: string;
  readonly permissionPolicy: "ask" | "approve-for-me";
  readonly model?: string | null;
  readonly effort?: string | null;
}
export class ClaudeSessionManager extends Context.Service<
  ClaudeSessionManager,
  {
    readonly models: (
      instanceConfigId: string,
      workspaceRoot: string,
    ) => Effect.Effect<readonly AgentSessionConfigSelectOption[], AgentRuntimeError>;
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

const makeSession = Effect.fn("ClaudeSessionManager.session")(function* (
  input: OpenClaudeSessionInput,
  instance: ClaudeAgentInstanceConfig,
  environmentOverrides: Readonly<Record<string, string>>,
) {
  const sdk = yield* ClaudeSdk;
  const config = yield* MainConfig;
  const sessionId = input.sessionId ?? createUuidV7();
  const sdkInput = {
    instance,
    environment: { ...config.environment, ...environmentOverrides },
    cwd: input.workspaceRoot,
    sessionId,
    resume: input.sessionId !== undefined,
  };
  let initial = emptyAgentConversationSnapshot({
    backend: "claude",
    threadId: input.threadId,
    sessionId,
  });
  const history = input.sessionId ? yield* sdk.history(sdkInput) : [];
  if (input.sessionId) initial = projectClaudeHistory(initial, history);
  const restoredModel = input.model ?? claudeHistoryModel(history) ?? "default";
  const restoredEffort = isClaudeEffortLevel(input.effort) ? input.effort : "default";
  const snapshot = yield* SubscriptionRef.make(initial);
  const pending = new Map<
    string,
    {
      readonly request: ClaudeToolRequest;
      readonly completion: Deferred.Deferred<AgentInteractionResponse>;
    }
  >();
  let active = true;
  let sequence = Math.max(0, ...initial.turns.map((turn) => turn.sequence ?? 0));
  let turn: {
    sequence: number;
    completion: Deferred.Deferred<{ stopReason: string }, AgentRuntimeError>;
    cancelled: boolean;
  } | null = null;
  let modes: AgentSessionModeState = {
    currentModeId: "default",
    availableModes: [
      { id: "default", name: "Code", description: null },
      { id: "plan", name: "Plan", description: null },
    ],
  };
  let configOptions: readonly AgentSessionConfigOption[] = [];
  const project = createClaudeMessageProjection();
  const patchRequests = () =>
    SubscriptionRef.update(snapshot, (current) => ({
      ...current,
      revision: current.revision + 1,
      requests: (current.requests ?? []).filter(({ id }) => pending.has(id)),
    }));
  const cancelRequests = Effect.fn("ClaudeSessionManager.cancelRequests")(function* () {
    for (const { completion } of pending.values())
      yield* Deferred.succeed(completion, { decision: "deny" });
    pending.clear();
    yield* patchRequests();
  });
  const canUseTool = Effect.fn("ClaudeSessionManager.canUseTool")(function* (
    request: ClaudeToolRequest,
  ): Effect.fn.Return<PermissionResult, AgentRuntimeError> {
    if (!active || turn === null) return { behavior: "deny", message: "The turn has ended." };
    if (request.name !== "AskUserQuestion" && input.permissionPolicy === "approve-for-me")
      return { behavior: "allow", updatedInput: request.input };
    if (pending.size >= 16) return { behavior: "deny", message: "Too many pending requests." };
    const questions =
      request.name === "AskUserQuestion" ? Questions.safeParse(request.input) : null;
    if (questions && !questions.success)
      return { behavior: "deny", message: "Claude sent an unsupported question format." };
    const id = createUuidV7();
    const completion = yield* Deferred.make<AgentInteractionResponse>();
    pending.set(id, { request, completion });
    yield* SubscriptionRef.update(snapshot, (current) => ({
      ...current,
      revision: current.revision + 1,
      requests: [
        ...(current.requests ?? []),
        {
          id,
          toolName: request.name,
          title: request.title ?? request.name,
          detail: JSON.stringify(request.input, null, 2).slice(0, 32 * 1024),
          questions: questions?.success
            ? questions.data.questions.map((question) => ({
                id: question.question,
                question: question.question,
                multiSelect: question.multiSelect ?? false,
                options: question.options.map((option) => ({
                  label: option.label,
                  description: option.description ?? "",
                })),
              }))
            : [],
        },
      ],
    }));
    const response = yield* Deferred.await(completion).pipe(
      Effect.ensuring(Effect.sync(() => pending.delete(id)).pipe(Effect.andThen(patchRequests()))),
    );
    if (response.decision === "deny")
      return { behavior: "deny", message: "The user declined this request." };
    if (request.name === "AskUserQuestion") {
      if (response.decision !== "answer")
        return { behavior: "deny", message: "Answers are required." };
      return { behavior: "allow", updatedInput: { ...request.input, answers: response.answers } };
    }
    return response.decision === "allow"
      ? { behavior: "allow", updatedInput: request.input }
      : { behavior: "deny", message: "An approval decision is required." };
  });
  const session = yield* sdk.open({
    ...sdkInput,
    ...(restoredModel !== "default" ? { model: restoredModel } : {}),
    ...(restoredEffort !== "default" ? { effort: restoredEffort } : {}),
    permissionMode: "default",
    canUseTool,
  });
  configOptions = claudeSessionConfigOptions(session.models, restoredModel, restoredEffort);
  const selectedValue = (id: string): string => {
    const option = configOptions.find((entry) => entry.id === id);
    return option?.type === "select" ? option.currentValue : "default";
  };
  const selectedEffort = (): ClaudeEffortSelection => {
    const value = selectedValue("effort");
    return isClaudeEffortLevel(value) ? value : "default";
  };
  if (restoredEffort !== selectedEffort()) yield* session.setEffort("default");
  if (session.commands.length)
    yield* SubscriptionRef.update(snapshot, (current) =>
      reduceAgentConversationEvent(current, {
        kind: "session_update",
        turnSequence: null,
        update: {
          kind: "commands",
          key: "commands",
          commands: session.commands.map((command) => ({
            name: command.name,
            description: command.description,
            inputHint: command.argumentHint ?? null,
          })),
        },
      }),
    );
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      active = false;
      yield* cancelRequests();
      if (turn)
        yield* Deferred.fail(
          turn.completion,
          failure("close", new Error("Session closed"), "closing"),
        );
      yield* SubscriptionRef.update(snapshot, closeAgentConversation);
    }),
  );
  const failStream = Effect.fn("ClaudeSessionManager.failStream")(function* (
    error: AgentRuntimeError,
  ) {
    active = false;
    yield* cancelRequests();
    yield* SubscriptionRef.update(snapshot, (current) => failAgentConversation(current, error));
    if (turn) yield* Deferred.fail(turn.completion, error);
    turn = null;
  });
  yield* session.messages.pipe(
    Stream.runForEach((message) =>
      Effect.gen(function* () {
        if (message.session_id !== sessionId)
          return yield* failStream(
            failure(
              "identity",
              new Error("Claude returned a different session identity"),
              "protocol",
            ),
          );
        yield* SubscriptionRef.update(snapshot, (current) =>
          project(current, message, (turn?.sequence ?? sequence) || null),
        );
        if (message.type === "system" && message.subtype === "init") {
          configOptions = claudeSessionConfigOptions(
            session.models,
            message.model,
            message.effort === undefined
              ? selectedEffort()
              : isClaudeEffortLevel(message.effort)
                ? message.effort
                : "default",
          );
        }
        if (message.type !== "result" || !turn) return;
        const completed = turn;
        turn = null;
        yield* cancelRequests();
        const stopReason = completed.cancelled
          ? "cancelled"
          : message.is_error
            ? "error"
            : "end_turn";
        yield* SubscriptionRef.update(snapshot, (current) =>
          reduceAgentConversationEvent(current, {
            kind: "turn_stopped",
            turnSequence: completed.sequence,
            stopReason,
          }),
        );
        if (message.is_error && !completed.cancelled) {
          const error = failure(
            "turn",
            new Error("errors" in message ? message.errors.join("\n") : message.result),
          );
          yield* SubscriptionRef.update(snapshot, (current) =>
            recoverAgentConversationTurnFailure(current, error, "idle"),
          );
          yield* Deferred.fail(completed.completion, error);
          return;
        }
        yield* Deferred.succeed(completed.completion, { stopReason });
      }),
    ),
    Effect.andThen(
      Effect.suspend(() =>
        active
          ? failStream(failure("stream", new Error("Claude Code exited"), "session-lost"))
          : Effect.void,
      ),
    ),
    Effect.catch(failStream),
    Effect.forkScoped,
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
        turn
          ? Effect.fail(failure("busy", new Error("Wait for the current turn to finish")))
          : Effect.void,
      ),
    ),
  );
  const cancel = requireActive.pipe(
    Effect.andThen(
      Effect.suspend(() => {
        if (!turn) return Effect.void;
        turn.cancelled = true;
        const completion = turn.completion;
        return cancelRequests().pipe(
          Effect.andThen(session.interrupt),
          Effect.andThen(Deferred.await(completion)),
          Effect.timeout("5 seconds"),
          Effect.asVoid,
          Effect.catch((cause) =>
            session.terminate.pipe(
              Effect.andThen(failStream(failure("cancel", cause, "session-lost"))),
            ),
          ),
        );
      }),
    ),
  );
  return {
    threadId: input.threadId,
    sessionId,
    snapshot,
    capabilities: {
      prompt: {
        text: true,
        resourceLink: true,
        image: false,
        audio: false,
        embeddedContext: false,
      },
      session: {
        load: true,
        list: false,
        delete: false,
        resume: true,
        unstableFork: false,
        close: true,
        additionalDirectories: false,
      },
      authMethods: [],
    },
    get modes() {
      return modes;
    },
    get configOptions() {
      return configOptions;
    },
    prompt: (text, options) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* requireIdle;
          const completion = yield* Deferred.make<{ stopReason: string }, AgentRuntimeError>();
          const admitted = { sequence: ++sequence, completion, cancelled: false };
          turn = admitted;
          yield* SubscriptionRef.update(snapshot, (current) =>
            beginAgentConversationTurn(
              current,
              admitted.sequence,
              text,
              options?.clientUserMessageId,
            ),
          );
          return yield* restore(
            session
              .send(text, options?.clientUserMessageId)
              .pipe(Effect.tapError(failStream), Effect.andThen(Deferred.await(completion))),
          ).pipe(Effect.onInterrupt(() => cancel.pipe(Effect.catch(() => Effect.void))));
        }),
      ),
    cancel,
    setMode: (id) =>
      Effect.gen(function* () {
        yield* requireIdle;
        if (id !== "default" && id !== "plan")
          return yield* failure("mode", new Error("Unsupported Claude mode"));
        yield* session.setMode(id);
        modes = { ...modes, currentModeId: id };
      }),
    setConfigOption: (id, value) =>
      Effect.gen(function* () {
        yield* requireIdle;
        const option = configOptions.find((entry) => entry.id === id);
        if (
          typeof value !== "string" ||
          option?.type !== "select" ||
          !option.options.some((entry) => "value" in entry && entry.value === value)
        )
          return yield* failure("settings", new Error("Choose an advertised Claude setting"));
        if (id === "effort") {
          const effort = isClaudeEffortLevel(value) ? value : "default";
          yield* session.setEffort(effort);
          configOptions = claudeSessionConfigOptions(
            session.models,
            selectedValue("model"),
            effort,
          );
          return configOptions;
        }
        const next = claudeSessionConfigOptions(session.models, value, selectedEffort());
        const effort = next.find((entry) => entry.id === "effort");
        const nextEffort =
          effort?.type === "select" && isClaudeEffortLevel(effort.currentValue)
            ? effort.currentValue
            : "default";
        yield* session.setModel(
          value === "default" ? undefined : value,
          nextEffort === selectedEffort() ? undefined : nextEffort,
        );
        configOptions = next;
        return configOptions;
      }),
    authenticate: () =>
      Effect.fail(
        failure(
          "authentication",
          new Error("Run claude auth login in your terminal, then reconnect."),
        ),
      ),
    deferInitialPrompt: () => Effect.void,
    takeDeferredInitialPrompt: Effect.succeed(null),
    respond: (id, response) =>
      Effect.gen(function* () {
        yield* requireActive;
        const entry = pending.get(id);
        const request = (yield* SubscriptionRef.get(snapshot)).requests?.find(
          (candidate) => candidate.id === id,
        );
        if (!entry || !request)
          return yield* failure("response", new Error("This request is no longer pending"));
        if (
          response.decision === "answer" &&
          (request.questions.length === 0 ||
            request.questions.some((question) => !response.answers[question.id]?.trim()) ||
            Object.keys(response.answers).some(
              (key) => !request.questions.some((question) => question.id === key),
            ))
        )
          return yield* failure("response", new Error("Answer each question before submitting"));
        if (response.decision === "allow" && request.questions.length)
          return yield* failure("response", new Error("This request requires answers"));
        pending.delete(id);
        yield* Deferred.succeed(entry.completion, response);
        yield* patchRequests();
      }),
  } satisfies AgentSessionHandle;
});

export const make = Effect.gen(function* () {
  const settings = yield* ApplicationSettings;
  const sdk = yield* ClaudeSdk;
  const config = yield* MainConfig;
  const ownerScope = yield* Scope.Scope;
  const lanes = yield* RcMap.make({ lookup: (_id: string) => Semaphore.make(1) });
  const discovery = yield* Semaphore.make(2);
  const sessions = new Map<
    string,
    { handle: AgentSessionHandle; scope: Scope.Closeable; instanceId: string }
  >();
  const observed = new Set<string>();
  const opening = new Set<string>();
  const evictions = yield* FiberMap.make<string>();
  const changes = yield* PubSub.sliding<AgentBackendSessionChangedEvent>(256);
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
          if (snapshot.status === "running") return yield* evict(id);
          yield* close(id);
        }),
      ),
    );
  yield* Effect.addFinalizer(() => Effect.forEach([...sessions.keys()], close, { discard: true }));
  return ClaudeSessionManager.of({
    models: (instanceConfigId, workspaceRoot) =>
      discovery.withPermits(1)(
        Effect.scoped(
          Effect.gen(function* () {
            const { instance, environment } = yield* settings
              .claudeLaunchConfiguration(instanceConfigId)
              .pipe(Effect.mapError((cause) => failure("settings", cause)));
            // Initialization discovers the configured CLI's catalog without a prompt or saved session.
            const session = yield* sdk.open({
              instance,
              environment: { ...config.environment, ...environment },
              cwd: workspaceRoot,
              sessionId: createUuidV7(),
              resume: false,
              persistSession: false,
              permissionMode: "default",
              canUseTool: () =>
                Effect.succeed({ behavior: "deny", message: "Model discovery only" }),
            });
            return claudeModelOptions(session.models);
          }),
        ),
      ),
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
            if (snapshot.status !== "failed" && snapshot.status !== "closed")
              return existing.handle;
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
