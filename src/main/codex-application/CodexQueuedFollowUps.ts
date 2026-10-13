import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import type { QueuedSubmission } from "@nodex/codex-app-server-protocol/v2";
import {
  discardCodexAcceptedServerQueueSubmission,
  equalCodexQueueValue,
  normalizeCodexNativeQueuedSubmission,
} from "../../shared/codex-native-queued-submission";
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
import { prepareUntrustedAppInput } from "../../shared/codex-untrusted-app-input";
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
import { CodexGateway, CodexThreadHostResolver } from "../codex-runtime/CodexGateway";
import { CodexAppServerCapabilities } from "../codex-runtime/CodexAppServerCapabilities";
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
  readonly untrustedAppMessage?: import("../../shared/codex-untrusted-app-input").CodexUntrustedAppMessage;
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
    readonly recordAcceptedSend: (
      input: Pick<QueuedMessageLockIdentity, "conversationId" | "messageId">,
    ) => void;
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
    readonly removeAsOwner: (
      hostId: string,
      threadId: string,
      messageId: string,
    ) => Effect.Effect<boolean, CodexQueuedFollowUpsError>;
    readonly clearAsOwner: (
      hostId: string,
      threadId: string,
    ) => Effect.Effect<boolean, CodexQueuedFollowUpsError>;
    readonly reconcileAcceptedAsOwner: (
      hostId: string,
      threadId: string,
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
  const gateway = yield* CodexGateway;
  const capabilities = yield* CodexAppServerCapabilities;
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
  const captureOwner = (hostId: string, threadId: string, manager: MainConversationManager) => {
    const generation = manager.generation;
    const entity = entities.current(threadId);
    const owner = manager.stream.getRole(threadId);
    const assertOwner = () => {
      manager.assertCurrent(generation);
      if (
        !entity ||
        entities.current(threadId) !== entity ||
        entity.readCanonicalState()?.hostId !== hostId ||
        owner?.role !== "owner" ||
        manager.stream.getRole(threadId) !== owner
      )
        throw new Error("Conversation queue owner changed");
    };
    return { generation, entity, assertOwner };
  };
  const getCoordinator = (
    threadId: string,
    selected?: { hostId: string; manager: MainConversationManager },
  ) =>
    Effect.gen(function* () {
      const hostId = selected?.hostId ?? (yield* hosts.resolve(threadId));
      const manager = selected?.manager ?? (yield* managers.get(hostId));
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
        captureOwnerWrite: (id) => {
          const owner = captureOwner(hostId, id, manager);
          let disposed = false;
          return {
            assertCurrent: () => {
              if (disposed) throw new Error("Conversation queue write retired");
              owner.assertOwner();
            },
            [Symbol.dispose]() {
              disposed = true;
            },
          };
        },
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
      let selected: { hostId: string; manager: MainConversationManager } | undefined;
      if (owner) {
        const hostId = yield* hosts.resolve(threadId);
        selected = { hostId, manager: yield* managers.get(hostId) };
      }
      const captured = selected ? captureOwner(selected.hostId, threadId, selected.manager) : null;
      if (captured) yield* Effect.try(captured.assertOwner);
      const coordinator = yield* getCoordinator(threadId, selected);
      yield* Effect.tryPromise(() => coordinator.loadMessages(threadId));
      if (captured) yield* Effect.try(captured.assertOwner);
      const previous = yield* Effect.tryPromise(() =>
        owner
          ? coordinator.acceptFromFollower(
              threadId,
              recipe(coordinator.readMessages(threadId) ?? []),
            )
          : coordinator.update(threadId, recipe),
      );
      if (captured) yield* Effect.try(captured.assertOwner);
      return previous;
    }).pipe(Effect.mapError((cause) => queueError("project", threadId, cause)));
  type QueueOwner = ReturnType<typeof captureOwner> & {
    hostId: string;
    threadId: string;
    manager: MainConversationManager;
  };
  const nativeQueueFor = Effect.fn("CodexQueuedFollowUps.nativeQueueFor")(function* (
    owner: QueueOwner,
  ) {
    const { hostId, threadId, generation, assertOwner } = owner;
    yield* Effect.try(assertOwner);
    const snapshot = yield* capabilities.forHost(hostId);
    yield* Effect.try(assertOwner);
    if (snapshot.hostId !== hostId || snapshot.generation !== generation)
      return yield* queueError(
        "remove",
        threadId,
        new Error("Conversation queue capability changed"),
      );
    if (!snapshot.flags.threadQueue || owner.entity?.readCanonicalState()?.ephemeral === true)
      return null;
    const assertNative = Effect.fn("CodexQueuedFollowUps.assertNativeOwner")(function* () {
      yield* Effect.try(assertOwner);
      if (!(yield* capabilities.isCurrent(snapshot)))
        return yield* queueError(
          "remove",
          threadId,
          new Error("Conversation queue connection changed"),
        );
      yield* Effect.try(assertOwner);
    });
    const remove = Effect.fn("CodexQueuedFollowUps.removeNative")(function* (id: string) {
      yield* assertNative();
      const response = yield* gateway.requestOnHost(
        hostId,
        "thread/queue/delete",
        { threadId, queuedSubmissionId: id },
        { expectedHostId: hostId, expectedGeneration: generation },
      );
      yield* assertNative();
      return response.deleted;
    });
    const read = Effect.fn("CodexQueuedFollowUps.readNative")(function* () {
      const items: QueuedSubmission[] = [];
      const cursors = new Set<string>();
      let cursor: string | null = null;
      for (;;) {
        yield* assertNative();
        const page: ClientRequestResponsesByMethod["thread/queue/list"] =
          yield* gateway.requestOnHost(
            hostId,
            "thread/queue/list",
            { threadId, cursor },
            { expectedHostId: hostId, expectedGeneration: generation },
          );
        yield* assertNative();
        items.push(...page.data.map(normalizeCodexNativeQueuedSubmission));
        if (page.nextCursor == null) return items;
        if (cursors.has(page.nextCursor))
          return yield* queueError(
            "resolve-after-fresh-start",
            threadId,
            new Error("Conversation queue cursor did not advance"),
          );
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
    });
    return { read, remove };
  });
  const applyOwnerControl = Effect.fn("CodexQueuedFollowUps.applyOwnerControl")(function* (
    owner: QueueOwner & { messageId?: string },
  ) {
    const { hostId, threadId, messageId, manager, assertOwner } = owner;
    yield* Effect.try(assertOwner);
    const coordinator = yield* getCoordinator(threadId, { hostId, manager });
    yield* Effect.tryPromise(() => coordinator.loadMessages(threadId));
    yield* Effect.try(assertOwner);
    const local = coordinator.readMessages(threadId) ?? [];
    const capturedLocal = new Map(local.map((message) => [message.id, structuredClone(message)]));
    const matchesCapture = (message: CodexQueuedMessage) => {
      const captured = capturedLocal.get(message.id);
      return captured !== undefined && isDeepStrictEqual(message, captured);
    };
    const isLocalRemoval = messageId !== undefined && local.some((item) => item.id === messageId);
    const mutateLocal = Effect.fn("CodexQueuedFollowUps.mutateOwnerDocument")(function* () {
      const previous = yield* Effect.tryPromise(() =>
        coordinator.updateAsOwner(threadId, (messages) => {
          assertOwner();
          return messages.filter((item) => {
            if (messageId !== undefined && item.id !== messageId) return true;
            return !matchesCapture(item);
          });
        }),
      );
      yield* Effect.try(assertOwner);
      return (
        messageId === undefined ||
        previous.some((item) => item.id === messageId && matchesCapture(item))
      );
    });
    if (isLocalRemoval) return yield* mutateLocal();
    const native = yield* nativeQueueFor(owner);
    if (!native) return messageId === undefined ? yield* mutateLocal() : false;
    if (messageId !== undefined) return yield* native.remove(messageId);
    const items = yield* native.read();
    for (const id of new Set(items.map((item) => item.id))) yield* native.remove(id);
    return yield* mutateLocal();
  });
  const ownerControl = Effect.fn("CodexQueuedFollowUps.ownerControl")(
    function* (hostId: string, threadId: string, messageId?: string) {
      const manager = yield* managers.get(hostId);
      const owner = { ...captureOwner(hostId, threadId, manager), hostId, threadId, manager };
      yield* Effect.try(owner.assertOwner);
      return yield* entities.runCommand(threadId, applyOwnerControl({ ...owner, messageId }));
    },
    (effect, _hostId, threadId, messageId) =>
      effect.pipe(
        Effect.mapError((cause) =>
          queueError(
            messageId === undefined ? "resolve-after-fresh-start" : "remove",
            threadId,
            cause,
          ),
        ),
      ),
  );
  const reconcileAcceptedInCurrentLane = Effect.fn(
    "CodexQueuedFollowUps.reconcileAcceptedInCurrentLane",
  )(function* (owner: QueueOwner) {
    const { entity, threadId, assertOwner } = owner;
    yield* Effect.try(assertOwner);
    const receipts = entity?.readCanonicalState()?.unconfirmedServerQueueMessages ?? [];
    if (!receipts.length || !entity) return;
    const native = yield* nativeQueueFor(owner);
    if (!native) return;
    let items = yield* native.read();
    for (const receipt of receipts) {
      yield* Effect.try(assertOwner);
      if (
        !entity
          .readCanonicalState()
          ?.unconfirmedServerQueueMessages?.some((current) =>
            equalCodexQueueValue(current, receipt),
          )
      )
        continue;
      const current = items.find((item) => item.id === receipt.id);
      if (equalCodexQueueValue(current, receipt)) {
        const deleted = yield* native.remove(receipt.id);
        if (!deleted) {
          items = yield* native.read();
          if (items.some((item) => equalCodexQueueValue(item, receipt)))
            return yield* queueError(
              "resolve-after-fresh-start",
              threadId,
              new Error("Accepted message remains in the native queue"),
            );
        } else items = items.filter((item) => !equalCodexQueueValue(item, receipt));
      }
      yield* Effect.try(() => {
        assertOwner();
        entity.mutateCanonicalState(
          (draft) => discardCodexAcceptedServerQueueSubmission(draft, receipt),
          Date.now(),
        );
      });
    }
  });
  const reconcileAcceptedAsOwner = Effect.fn("CodexQueuedFollowUps.reconcileAcceptedAsOwner")(
    function* (hostId: string, threadId: string) {
      if (!entities.current(threadId)?.readCanonicalState()?.unconfirmedServerQueueMessages?.length)
        return;
      const manager = yield* managers.get(hostId);
      const owner = { ...captureOwner(hostId, threadId, manager), hostId, threadId, manager };
      yield* Effect.try(owner.assertOwner);
      yield* entities.runCommand(threadId, reconcileAcceptedInCurrentLane(owner));
    },
    (effect, _hostId, threadId) =>
      effect.pipe(
        Effect.mapError((cause) => queueError("resolve-after-fresh-start", threadId, cause)),
      ),
  );
  const prepareMessage = (input: CodexQueuedFollowUpEnqueueInput) =>
    Effect.gen(function* () {
      const id = randomUUID();
      const hostId = yield* hosts.resolve(input.threadId);
      const prompt = yield* assets.retainCaptured(
        input.threadId,
        id,
        input.promptInput ?? { text: input.prompt },
      );
      const sourceMessage = input.untrustedAppMessage ?? prompt.untrustedAppMessage;
      const untrustedAppMessage = sourceMessage
        ? { ...sourceMessage, text: input.prompt }
        : undefined;
      yield* Effect.try(() =>
        prepareUntrustedAppInput(
          input.prompt,
          {
            untrustedAppMessage,
            mcpAppModelContextAttachments: prompt.mcpAppModelContextAttachments,
          },
          `untrusted_input_${id}`,
        ),
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
          ...(untrustedAppMessage
            ? { untrustedAppMessage: structuredClone(untrustedAppMessage) }
            : {}),
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
    recordAcceptedSend: (input) => sendLocks.recordAccepted(input),
    readMessageState,
    writeMessageState,
    prepareMessage,
    acceptFromFollower: (threadId, incoming) =>
      update(threadId, () => incoming, true).pipe(Effect.asVoid),
    removeAsOwner: (hostId, threadId, messageId) => ownerControl(hostId, threadId, messageId),
    clearAsOwner: (hostId, threadId) => ownerControl(hostId, threadId, undefined),
    reconcileAcceptedAsOwner,
    acceptTerminalOutcomeInCurrentLane: ({ threadId, interrupted }) =>
      Effect.gen(function* () {
        if (!interrupted) {
          yield* Effect.gen(function* () {
            const hostId = yield* hosts.resolve(threadId);
            const manager = yield* managers.get(hostId);
            if (manager.stream.getRole(threadId)?.role !== "owner") return;
            const owner = { ...captureOwner(hostId, threadId, manager), hostId, threadId, manager };
            yield* reconcileAcceptedInCurrentLane(owner);
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                "Accepted queued input could not be removed after completion",
                error,
              ),
            ),
          );
          return;
        }
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
