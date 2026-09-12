import { CodexConversationPeerRuntime } from "../platform/node/CodexConversationPeerRuntime";
import { CodexPeerClient } from "../platform/node/CodexPeerClient";
import { ScopedCallbackRuntime } from "../app/ScopedCallbackRuntime";
import { readThreadReadStateBroadcast } from "../../shared/codex-thread-read-state-broadcast";
import { codexPeerMethodVersion } from "../../shared/codex-peer-protocol";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { CodexGateway, CodexThreadHostResolver } from "../codex-runtime/CodexGateway";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import {
  threadReadStateIdentityKey,
  readThreadStateIdentity,
  readThreadStateIdentityFromAccount,
  threadReadStateHostKeys,
} from "../codex/thread-read-state-identity";
import {
  makeIdentityReadState,
  IdentityReadStateError,
  type IdentityReadStateService,
} from "./CodexIdentityReadState";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

export interface CodexThreadReadStateUpdate {
  readonly threadId: string;
  readonly hasUnreadTurn: boolean;
}

export class CodexThreadReadStateError extends Data.TaggedError("CodexThreadReadStateError")<{
  readonly operation: "inspect" | "persist" | "project";
  readonly cause: unknown;
}> {}

export class CodexThreadReadState extends Context.Service<
  CodexThreadReadState,
  {
    readonly captureContext: IdentityReadStateService["captureContext"];
    readonly getExecutionHostKeys: IdentityReadStateService["hostKeys"];
    readonly openSession: IdentityReadStateService["open"];
    /** Commits a user-requested read-state transition durable-first. */
    readonly set: (
      input: CodexThreadReadStateUpdate,
    ) => Effect.Effect<boolean, CodexThreadReadStateError>;
    /** Persists a state already committed by the synchronous conversation reducer. */
    readonly persistProjected: (input: CodexThreadReadStateUpdate) => Effect.Effect<void>;
  }
>()("nodex/main/codex-application/CodexThreadReadState") {}

export const make: Effect.Effect<
  CodexThreadReadState["Service"],
  never,
  | CodexApplicationEventHub
  | ConversationEntityMap
  | ProjectWorkspace
  | CodexGateway
  | CodexThreadHostResolver
  | ApplicationSettings
  | CodexConversationPeerRuntime
  | ScopedCallbackRuntime
  | Scope.Scope
> = Effect.gen(function* () {
  const conversations = yield* ConversationEntityMap;
  const events = yield* CodexApplicationEventHub;
  const workspace = yield* ProjectWorkspace;
  const gateway = yield* CodexGateway;
  const hostResolver = yield* CodexThreadHostResolver;
  const settings = yield* ApplicationSettings;
  const endpoints = yield* CodexConversationPeerRuntime;
  const callbacks = yield* ScopedCallbackRuntime;
  const peer = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new CodexPeerClient(endpoints.getEndpoint, () => {
          callbacks.fork(Effect.logWarning("Thread read-state peer disconnected"));
        }),
    ),
    (client) => Effect.sync(() => client.dispose()),
  );
  const project = ({
    threadId,
    hasUnreadTurn,
  }: import("../../shared/codex-thread-read-state").ThreadReadStateChange) =>
    Effect.gen(function* () {
      // Workspace membership is a UI projection; authenticated membership is stored separately.
      const thread = yield* workspace.getThread(threadId);
      if (thread && !(thread.archived && hasUnreadTurn))
        yield* workspace.setThreadUnread(threadId, hasUnreadTurn);
      conversations.current(threadId)?.setHasUnreadTurn(hasUnreadTurn);
    });
  const mapError = (operation: string) => (cause: unknown) =>
    new IdentityReadStateError({ operation, cause });
  const readIdentity = Effect.gen(function* () {
    const account = yield* gateway
      .requestLocal("account/read", { refreshToken: false })
      .pipe(Effect.orElseSucceed(() => null));
    const storageIdentity = readThreadStateIdentityFromAccount(account);
    if (storageIdentity) return storageIdentity;

    // account/read intentionally omits ChatGPT account/user IDs. Keep the token-bearing
    // compatibility request only for the stable claims needed to isolate ChatGPT read state.
    const status = yield* gateway.requestLocal("getAuthStatus", {
      includeToken: true,
      refreshToken: false,
    });
    return readThreadStateIdentity(status);
  }).pipe(Effect.mapError(mapError("identity")));
  const owner = yield* makeIdentityReadState({
    readIdentity,
    hostKeys: settings.snapshot().pipe(
      Effect.map((snapshot) => threadReadStateHostKeys(snapshot.executionHosts.sshHosts)),
      Effect.mapError(mapError("hosts")),
    ),
    read: (key) =>
      workspace.readIdentityThreadReadState(key).pipe(Effect.mapError(mapError("read"))),
    write: (key, host, thread, unread) =>
      workspace
        .setIdentityThreadUnread(key, host, thread, unread)
        .pipe(Effect.mapError(mapError("write"))),
    clear: (key) =>
      workspace.clearIdentityThreadReadState(key).pipe(Effect.mapError(mapError("clear"))),
    select: (key, hosts) =>
      workspace.selectThreadReadStateIdentity(key, hosts).pipe(Effect.mapError(mapError("select"))),
    project: (change) => project(change).pipe(Effect.mapError(mapError("project"))),
    accepted: (change) =>
      Effect.sync(() => {
        callbacks.fork(
          Effect.tryPromise(() =>
            peer.waitUntilInitialized({ timeoutMs: 5000 }).then(() =>
              peer.sendBroadcast("thread-read-state-changed", {
                hostId: change.hostId,
                conversationId: change.threadId,
                hasUnreadTurn: change.hasUnreadTurn,
                context: change.context,
              }),
            ),
          ).pipe(Effect.catch(() => Effect.logWarning("Could not broadcast Thread read state"))),
        );
      }),
  });
  peer.addBroadcastHandler("thread-read-state-changed", (message) => {
    if (message.version !== codexPeerMethodVersion(message.method)) return;
    const change = readThreadReadStateBroadcast(message.params);
    if (change)
      callbacks.fork(
        owner
          .acceptBroadcast(change)
          .pipe(Effect.catch(() => Effect.logWarning("Could not accept Thread read state"))),
      );
  });
  // Main's per-host read-state binding retains the identity context for its whole session.
  const bindings = new Map<
    string,
    {
      captured: NonNullable<Effect.Success<ReturnType<IdentityReadStateService["captureContext"]>>>;
      session: import("./CodexIdentityReadState").IdentityReadStateSession;
    }
  >();
  const bindingLock = yield* Semaphore.make(1);
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      for (const binding of bindings.values()) yield* binding.session.unsubscribe;
      bindings.clear();
    }),
  );
  const bindingForHost = (hostId: string) =>
    bindingLock.withPermit(
      Effect.gen(function* () {
        const previous = bindings.get(hostId);
        if (previous && (yield* previous.captured.isCurrent)) return previous;
        if (previous) {
          bindings.delete(hostId);
          yield* previous.session.unsubscribe;
        }
        const captured = yield* owner.captureContext(hostId);
        if (!captured) return null;
        const opened = yield* owner.open((event) =>
          Effect.sync(() => {
            if (event.type === "retired" && bindings.get(hostId)?.captured === captured)
              bindings.delete(hostId);
          }),
        );
        if (opened.status !== "ready") return null;
        if (!(yield* captured.isCurrent)) {
          yield* opened.session.unsubscribe;
          return null;
        }
        const binding = { captured, session: opened.session };
        bindings.set(hostId, binding);
        return binding;
      }),
    );
  const set = (input: CodexThreadReadStateUpdate) =>
    Effect.gen(function* () {
      const hostId = yield* hostResolver.resolve(input.threadId);
      const binding = yield* bindingForHost(hostId);
      if (!binding || !(yield* binding.captured.isCurrent)) return false;
      const stored = yield* workspace.readIdentityThreadReadState(
        threadReadStateIdentityKey(binding.captured.context.identity),
      );
      const before =
        stored[binding.captured.context.executionHostKey]?.includes(input.threadId) ?? false;
      if (!(yield* binding.captured.isCurrent)) return false;
      const result = yield* binding.session.set({ hostId, ...input });
      return result.status === "ok" && before !== input.hasUnreadTurn;
    }).pipe(
      Effect.mapError((cause) => new CodexThreadReadStateError({ operation: "persist", cause })),
    );
  const readState: CodexThreadReadState["Service"] = {
    captureContext: owner.captureContext,
    getExecutionHostKeys: owner.hostKeys,
    openSession: owner.open,
    set,
    persistProjected: (input) =>
      set(input).pipe(
        Effect.asVoid,
        Effect.catch((error) =>
          Effect.logWarning("Could not persist Thread read state").pipe(
            Effect.annotateLogs({ operation: error.operation }),
          ),
        ),
      ),
  };
  yield* gateway.events.pipe(
    Stream.mapEffect((event) => {
      if (event.kind === "connection") {
        // A transport session does not change the authenticated unread-state namespace.
        return event.value.hostId === gateway.localHostId && event.value.kind === "ready"
          ? owner.refresh.pipe(Effect.catch(() => owner.retire("unavailable")))
          : Effect.void;
      }
      if (event.hostId !== gateway.localHostId || event.value.method !== "account/updated")
        return Effect.void;
      return (
        event.value.params !== null &&
        typeof event.value.params === "object" &&
        "authMode" in event.value.params &&
        event.value.params.authMode === null
          ? owner.logout
          : owner.refresh
      ).pipe(Effect.catch(() => owner.retire("unavailable")));
    }),
    Stream.runDrain,
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* events.events.pipe(
    Stream.filter((event) => event.kind === "conversationReadStateCommitted"),
    Stream.mapEffect((event) => readState.persistProjected(event.value)),
    Stream.runDrain,
    Effect.forkScoped({ startImmediately: true }),
  );
  return readState;
});
