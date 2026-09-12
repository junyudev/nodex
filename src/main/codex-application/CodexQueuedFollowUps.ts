import { randomUUID } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { CodexTurnPresentationTicket } from "../../shared/nodex-app-tools/turn-presentation";
import type {
  CodexCollaborationModeKind,
  CodexPromptInput,
  CodexPermissionMode,
  CodexQueuedFollowUp,
  CodexQueuedFollowUpPause,
  CodexServiceTier,
} from "../../shared/types";
import { CODEX_INTERRUPTED_STEER_REASON } from "../../shared/codex-queued-follow-up-state";
import {
  QueuedMessageLocks,
  type QueuedMessageLockIdentity,
} from "../../shared/codex-queued-message-locks";
import { QueuedMessageCoordinator } from "../../shared/codex-queued-message-coordinator";
import {
  parseCodexQueuedMessageState,
  type CodexQueuedMessage,
  type CodexQueuedMessageState,
} from "../../shared/codex-queued-message";
import type { CodexPermissionSelection } from "../../shared/codex-permission-selection";
import { CoreModules } from "../core-runtime/CoreModules";
import { createOperationId } from "../core-runtime/operation-identity";
import { ScopedCallbackRuntime } from "../app/ScopedCallbackRuntime";
import { CodexThreadHostResolver } from "../codex-runtime/CodexGateway";
import {
  CodexMainConversationManagers,
  type MainConversationManager,
} from "./CodexMainConversationManagers";
import { CodexInputAssets } from "./CodexInputAssets";
import { CodexTurnPresentation } from "./CodexTurnPresentation";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
type QueueOperation =
  | "read"
  | "enqueue"
  | "remove"
  | "replace"
  | "reorder"
  | "resume"
  | "resolve-after-fresh-start"
  | "terminal"
  | "send"
  | "project";
export class CodexQueuedFollowUpsError extends Schema.TaggedError<CodexQueuedFollowUpsError>()(
  "CodexQueuedFollowUpsError",
  {
    operation: Schema.Literals([
      "read",
      "enqueue",
      "remove",
      "replace",
      "reorder",
      "resume",
      "resolve-after-fresh-start",
      "terminal",
      "send",
      "project",
    ]),
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface CodexQueuedFollowUpEnqueueInput {
  readonly presentationTicket?: CodexTurnPresentationTicket;
  readonly threadId: string;
  readonly prompt: string;
  readonly collaborationMode?: CodexCollaborationModeKind | null;
  readonly serviceTier?: CodexServiceTier;
  readonly pause?: CodexQueuedFollowUpPause | null;
  readonly promptInput?: CodexPromptInput;
  readonly summary?: CodexQueuedFollowUp["summary"];
  readonly permissionMode?: CodexPermissionMode;
  readonly workspaceRoots?: readonly string[];
  readonly permissionSelection?: CodexPermissionSelection;
  readonly permissionProfileId?: string;
  readonly usePermissionSelection?: boolean;
  readonly shouldSendPermissionOverrides?: boolean;
}

export class CodexQueuedFollowUps extends Context.Service<
  CodexQueuedFollowUps,
  {
    readonly readHead: (threadId: string) => CodexQueuedMessage | null | undefined;
    readonly acquireSendLock: (input: QueuedMessageLockIdentity) => boolean;
    readonly releaseSendLock: (input: QueuedMessageLockIdentity & { sent: boolean }) => void;
    readonly readMessageState: Effect.Effect<CodexQueuedMessageState, CodexQueuedFollowUpsError>;
    readonly writeMessageState: (
      state: CodexQueuedMessageState,
    ) => Effect.Effect<void, CodexQueuedFollowUpsError>;
    readonly prepareMessage: (
      input: CodexQueuedFollowUpEnqueueInput,
    ) => Effect.Effect<CodexQueuedMessage, CodexQueuedFollowUpsError>;
    readonly acceptFromFollower: (
      threadId: string,
      messages: readonly CodexQueuedMessage[],
    ) => Effect.Effect<void, CodexQueuedFollowUpsError>;
    /** Called only while the notification consequence already owns the Thread lane. */
    readonly acceptTerminalOutcomeInCurrentLane: (input: {
      readonly threadId: string;
      readonly interrupted: boolean;
    }) => Effect.Effect<void, CodexQueuedFollowUpsError>;
  }
>()("nodex/main/codex-application/CodexQueuedFollowUps") {}

const queueError = (operation: QueueOperation, threadId: string, cause: unknown) =>
  cause instanceof CodexQueuedFollowUpsError
    ? cause
    : new CodexQueuedFollowUpsError({ operation, threadId, cause });

export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const callbacks = yield* ScopedCallbackRuntime;
  const hosts = yield* CodexThreadHostResolver;
  const managers = yield* CodexMainConversationManagers;
  const assets = yield* CodexInputAssets;
  const presentation = yield* CodexTurnPresentation;
  const events = yield* CodexApplicationEventHub;
  const entities = yield* ConversationEntityMap;
  const writeLock = yield* Semaphore.make(1);
  const coordinators = new Map<
    MainConversationManager,
    QueuedMessageCoordinator<CodexQueuedMessage>
  >();
  let loaded: CodexQueuedMessageState | undefined;
  const readMessageState = core.workspace.read({ kind: "queued_message_state" }).pipe(
    Effect.flatMap((snapshot) =>
      Effect.try(() => {
        if (snapshot.value.kind !== "queued_message_state")
          throw new Error("Wrong queue document response");
        loaded = parseCodexQueuedMessageState(snapshot.value.state);
        return loaded;
      }),
    ),
    Effect.mapError((cause) => queueError("read", "", cause)),
  );
  const persist = (state: CodexQueuedMessageState) =>
    Effect.gen(function* () {
      const validated = yield* Effect.try(() => parseCodexQueuedMessageState(state));
      yield* core.workspace.apply({
        operationId: createOperationId("queued-messages"),
        intent: {
          kind: "set_queued_message_state",
          state: Object.fromEntries(
            Object.entries(validated).map(([id, messages]) => [id, [...messages]]),
          ),
        },
      });
      loaded = validated;
      events.publish({ kind: "queuedMessageStateChanged", value: null });
    }).pipe(Effect.mapError((cause) => queueError("project", "", cause)));
  const writeMessageState = (state: CodexQueuedMessageState) =>
    writeLock.withPermit(persist(state));
  const getCoordinator = (threadId: string) =>
    Effect.gen(function* () {
      const hostId = yield* hosts.resolve(threadId);
      const manager = yield* managers.get(hostId);
      const existing = coordinators.get(manager);
      if (existing) return existing;
      const coordinator = new QueuedMessageCoordinator<CodexQueuedMessage>({
        storage: {
          read: () => ({ isLoading: loaded === undefined, value: loaded }),
          load: () => callbacks.runPromise(readMessageState),
          update: (recipe) =>
            callbacks.runPromise(
              writeLock.withPermit(
                Effect.gen(function* () {
                  const state = yield* readMessageState;
                  yield* persist(recipe(state));
                }),
              ),
            ),
        },
        role: (id) => manager.stream.getRole(id),
        validate: (messages) => {
          parseCodexQueuedMessageState({ [threadId]: messages });
        },
        requestFollower: async (id, state, ownerClientId) => {
          manager.assertCurrent();
          const response = await manager.coordination.requestThreadFollower({
            hostId,
            request: {
              method: "thread-follower-set-queued-follow-ups-state",
              params: { conversationId: id, state },
            },
            targetClientId: ownerClientId,
          });
          manager.assertCurrent();
          if (response.resultType === "error") throw new Error(response.error);
        },
        broadcast: (id, messages) => {
          manager.assertCurrent();
          return manager.coordination.threadQueuedFollowUpsChanged({
            hostId,
            conversationId: id,
            messages,
          });
        },
        changed: () => {},
        // Ordinary Main managers coordinate storage but do not automatically execute queued input.
        wake: () => {},
        error: (operation, cause) => {
          callbacks.fork(
            Effect.logWarning("Queued message update failed").pipe(
              Effect.annotateLogs({ operation, cause }),
            ),
          );
        },
      });
      const broadcast = manager.subscribeQueuedMessages((event) => {
        const value = event.params;
        if (!value || typeof value !== "object" || Reflect.get(value, "hostId") !== hostId) return;
        const id: unknown = Reflect.get(value, "conversationId");
        if (typeof id !== "string") return;
        try {
          const state = parseCodexQueuedMessageState({ [id]: Reflect.get(value, "messages") });
          coordinator.receiveBroadcast(event.sourceClientId, id, state[id]!);
        } catch (cause) {
          callbacks.fork(
            Effect.logWarning("Invalid queue broadcast").pipe(Effect.annotateLogs({ cause })),
          );
        }
      });
      manager.onDispose(() => {
        broadcast[Symbol.dispose]();
        coordinator[Symbol.dispose]();
        coordinators.delete(manager);
      });
      coordinators.set(manager, coordinator);
      return coordinator;
    }).pipe(Effect.mapError((cause) => queueError("read", threadId, cause)));
  const update = (
    threadId: string,
    recipe: (messages: readonly CodexQueuedMessage[]) => readonly CodexQueuedMessage[],
    owner = false,
  ) =>
    Effect.gen(function* () {
      const coordinator = yield* getCoordinator(threadId);
      yield* Effect.tryPromise(() => coordinator.loadMessages(threadId));
      return yield* Effect.tryPromise(() =>
        owner
          ? coordinator.acceptFromFollower(
              threadId,
              recipe(coordinator.readMessages(threadId) ?? []),
            )
          : coordinator.update(threadId, recipe),
      );
    }).pipe(Effect.mapError((cause) => queueError("project", threadId, cause)));
  const prepareMessage = (input: CodexQueuedFollowUpEnqueueInput) =>
    Effect.gen(function* () {
      const id = randomUUID();
      const hostId = yield* hosts.resolve(input.threadId);
      const prompt = yield* assets.retainCaptured(
        input.threadId,
        id,
        input.promptInput ?? { text: input.prompt },
      );
      const { text: _text, images, textAttachments, ...context } = prompt;
      const canonical = entities.current(input.threadId)?.readCanonicalState();
      const cwd = canonical?.cwd ?? "/";
      const selectedModel =
        canonical?.latestCollaborationMode?.settings.model ?? canonical?.latestModel ?? null;
      const collaborationMode =
        input.collaborationMode && selectedModel
          ? {
              mode: input.collaborationMode,
              settings: {
                model: selectedModel,
                reasoning_effort: canonical?.latestReasoningEffort ?? null,
                developer_instructions: null,
              },
            }
          : null;
      const message: CodexQueuedMessage = {
        id,
        cwd,
        createdAt: Date.now(),
        context: {
          ...context,
          prompt: input.prompt,
          workspaceRoots: input.workspaceRoots ? [...input.workspaceRoots] : [cwd],
          fileAttachments: [...(prompt.fileAttachments ?? [])],
          addedFiles: [...(prompt.addedFiles ?? [])],
          commentAttachments: [...(prompt.commentAttachments ?? [])],
          imageAttachments: [...(images ?? [])],
          ...(textAttachments ? { pastedTextAttachments: textAttachments } : {}),
        },
        submissionOptions: {
          executionHostId: hostId,
          collaborationMode,
          serviceTier: input.serviceTier,
          summary: input.summary,
          agentMode: input.permissionMode,
          permissionSelection: input.permissionSelection,
          permissionProfileId: input.permissionProfileId,
          usePermissionSelection: input.usePermissionSelection,
          shouldSendPermissionOverrides:
            input.shouldSendPermissionOverrides ?? input.permissionMode !== undefined,
        },
        ...(input.pause ? { pausedReason: input.pause.reason } : {}),
      };
      if (input.presentationTicket) {
        const claim = yield* presentation.claim(
          input.presentationTicket,
          { kind: "thread", threadId: input.threadId },
          id,
        );
        presentation.retainQueued(claim);
      }
      return message;
    }).pipe(Effect.mapError((cause) => queueError("enqueue", input.threadId, cause)));
  yield* events.events.pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => {
        if (event.kind === "queuedMessageStateChanged")
          for (const coordinator of coordinators.values()) coordinator.storageChanged();
      }),
    ),
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const coordinator of coordinators.values()) coordinator[Symbol.dispose]();
      coordinators.clear();
    }),
  );
  const sendLocks = new QueuedMessageLocks();
  return CodexQueuedFollowUps.of({
    readHead: (threadId) => {
      for (const [manager, coordinator] of coordinators)
        if (manager.stream.getRole(threadId))
          return coordinator.readMessages(threadId)?.[0] ?? null;
      return loaded === undefined ? undefined : (loaded[threadId]?.[0] ?? null);
    },
    acquireSendLock: (input) => sendLocks.tryAcquire(input),
    releaseSendLock: (input) => sendLocks.release(input),
    readMessageState,
    writeMessageState,
    prepareMessage,
    acceptFromFollower: (threadId, incoming) =>
      update(threadId, () => incoming, true).pipe(Effect.asVoid),
    acceptTerminalOutcomeInCurrentLane: ({ threadId, interrupted }) =>
      Effect.gen(function* () {
        if (!interrupted) return;
        const manager = yield* managers.get(yield* hosts.resolve(threadId));
        if (manager.stream.getRole(threadId)?.role === "follower") return;
        yield* update(threadId, (messages) =>
          messages.map((message) => ({
            ...message,
            pausedReason: message.pausedReason ?? CODEX_INTERRUPTED_STEER_REASON,
          })),
        );
      }).pipe(Effect.mapError((cause) => queueError("terminal", threadId, cause))),
  });
});
