import { CodexManualCompactions } from "../../shared/codex-manual-compactions";
import type { ConversationStreamRole } from "../../shared/codex-conversation-stream";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { CodexGateway, CodexThreadHostResolver } from "../codex-runtime/CodexGateway";
import type { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import {
  CodexMainConversationManagers,
  type MainConversationManager,
  type MainConversationManagerError,
} from "./CodexMainConversationManagers";
import {
  CodexMainConversationResume,
  type MainConversationResumeError,
} from "./CodexMainConversationResume";
import { CodexMainConversationSettings } from "./CodexMainConversationSettings";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import type { ConversationEntityState } from "./internal/ConversationEntityState";

export type CodexContextCompactionSource = "automatic" | "manual";

export class CodexManualCompactionClosedError extends Schema.TaggedError<CodexManualCompactionClosedError>()(
  "CodexManualCompactionClosedError",
  { threadId: Schema.String },
) {}

export class CodexManualCompactionOwnerError extends Schema.TaggedError<CodexManualCompactionOwnerError>()(
  "CodexManualCompactionOwnerError",
  { threadId: Schema.String, cause: Schema.Defect() },
) {}

export type CodexManualCompactionError =
  | CodexRuntimeError
  | MainConversationManagerError
  | MainConversationResumeError
  | CodexManualCompactionOwnerError
  | CodexManualCompactionClosedError;

export class CodexManualCompactionRuntime extends Context.Service<
  CodexManualCompactionRuntime,
  {
    readonly start: (threadId: string) => Effect.Effect<void, CodexManualCompactionError>;
    readonly startAsOwner: (
      hostId: string,
      threadId: string,
    ) => Effect.Effect<void, CodexManualCompactionError>;
    /** Synchronous projection seam used by the still-pure canonical reducer. */
    readonly consumeSource: (threadId: string) => CodexContextCompactionSource;
    readonly clear: (threadId: string) => void;
  }
>()("nodex/main/codex-application/CodexManualCompactionRuntime") {}

interface OwnerLifetime {
  readonly manager: MainConversationManager;
  readonly generation: number;
  readonly entity: ConversationEntityState;
  readonly role: ConversationStreamRole;
}

interface PendingCompaction {
  readonly lifetime: OwnerLifetime;
  readonly reset: Disposable;
  readonly disposed: Disposable;
}

const missingOwner = (error: unknown): boolean => {
  const visited = new Set<unknown>();
  while (error instanceof Error && !visited.has(error)) {
    visited.add(error);
    if (error.message.includes("no-client-found")) return true;
    error = error.cause;
  }
  return false;
};

/** Compaction runs at the stream owner and keeps pending markers inside that owner's lifetime. */
export const live = Layer.effect(
  CodexManualCompactionRuntime,
  Effect.gen(function* () {
    const gateway = yield* CodexGateway;
    const hosts = yield* CodexThreadHostResolver;
    const managers = yield* CodexMainConversationManagers;
    const settings = yield* CodexMainConversationSettings;
    const resume = yield* CodexMainConversationResume;
    const entities = yield* ConversationEntityMap;
    const pending = new CodexManualCompactions();
    const entries = new Map<string, PendingCompaction>();
    let accepting = true;
    const fail = (threadId: string, cause: unknown) =>
      new CodexManualCompactionOwnerError({ threadId, cause });

    const clear = (threadId: string) => {
      const entry = entries.get(threadId);
      entries.delete(threadId);
      pending.clear(threadId);
      entry?.reset[Symbol.dispose]();
      entry?.disposed[Symbol.dispose]();
    };
    const retired = entities.subscribeRetired((threadId, generation) => {
      if (entries.get(threadId)?.lifetime.entity.generation === generation) clear(threadId);
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        accepting = false;
        retired[Symbol.dispose]();
        for (const threadId of [...entries.keys()]) clear(threadId);
      }),
    );

    const assertCurrent = (threadId: string, lifetime: OwnerLifetime) => {
      lifetime.manager.assertCurrent(lifetime.generation);
      if (
        entities.current(threadId) !== lifetime.entity ||
        lifetime.manager.stream.getRole(threadId) !== lifetime.role ||
        lifetime.entity.readCanonicalState()?.hostId !== lifetime.manager.hostId
      )
        throw new Error("Conversation owner changed during compaction");
    };
    const isCurrent = (threadId: string, lifetime: OwnerLifetime) => {
      try {
        assertCurrent(threadId, lifetime);
        return true;
      } catch {
        return false;
      }
    };
    const check = (threadId: string, lifetime: OwnerLifetime) =>
      Effect.try({
        try: () => assertCurrent(threadId, lifetime),
        catch: (cause) => fail(threadId, cause),
      });
    const capture = Effect.fn("CodexManualCompactionRuntime.capture")(function* (
      hostId: string,
      threadId: string,
    ) {
      if (!accepting) return yield* new CodexManualCompactionClosedError({ threadId });
      const manager = yield* managers.get(hostId);
      const entity = entities.current(threadId);
      const role = manager.stream.getRole(threadId);
      if (!entity || !role)
        return yield* fail(threadId, new Error("Conversation has no compaction owner"));
      const lifetime = { manager, generation: manager.generation, entity, role };
      yield* check(threadId, lifetime);
      return lifetime;
    });
    const awaitSettings = Effect.fn("CodexManualCompactionRuntime.awaitSettings")(function* (
      threadId: string,
      lifetime: OwnerLifetime,
    ) {
      yield* settings
        .awaitCurrent(lifetime.manager.hostId, threadId)
        .pipe(
          Effect.catch((cause) =>
            lifetime.manager.stream.getRole(threadId)?.role === "follower" && missingOwner(cause)
              ? Effect.void
              : Effect.fail(cause),
          ),
        );
      // Settings may finish at a different owner; route the action using that current role.
      const current = { ...lifetime, role: lifetime.manager.stream.getRole(threadId) };
      if (!current.role)
        return yield* fail(threadId, new Error("Conversation has no compaction owner"));
      const admitted = { ...current, role: current.role };
      yield* check(threadId, admitted);
      return admitted;
    });
    const execute = Effect.fn("CodexManualCompactionRuntime.execute")(function* (
      threadId: string,
      lifetime: OwnerLifetime,
    ) {
      if (lifetime.role.role !== "owner")
        return yield* fail(threadId, new Error("Compaction requires the current stream owner"));
      let admitted: PendingCompaction | undefined;
      return yield* Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.try({
          try: () => {
            assertCurrent(threadId, lifetime);
            const previous = entries.get(threadId);
            if (previous && !isCurrent(threadId, previous.lifetime)) clear(threadId);
            admitted = entries.get(threadId);
            if (!admitted) {
              admitted = {
                lifetime,
                reset: lifetime.manager.onConnectionReset(() => clear(threadId)),
                disposed: lifetime.manager.onDispose(() => clear(threadId)),
              };
              entries.set(threadId, admitted);
            }
            pending.register(threadId);
            lifetime.entity.admitManualCompaction({ observedAtMs: now });
          },
          catch: (cause) => fail(threadId, cause),
        });
        yield* gateway.requestOnHost(
          lifetime.manager.hostId,
          "thread/compact/start",
          { threadId },
          {
            expectedHostId: lifetime.manager.hostId,
            expectedGeneration: lifetime.generation,
          },
        );
        yield* check(threadId, lifetime);
      }).pipe(
        Effect.onExit((exit) => {
          if (Exit.isSuccess(exit) || !admitted) return Effect.void;
          const entry = admitted;
          return Clock.currentTimeMillis.pipe(
            Effect.map((now) => {
              if (entries.get(threadId) !== entry) return;
              if (!isCurrent(threadId, lifetime)) {
                clear(threadId);
                return;
              }
              if (!pending.remove(threadId)) return;
              clear(threadId);
              lifetime.entity.rollbackManualCompaction({ observedAtMs: now });
            }),
          );
        }),
      );
    });
    const startAsOwner = Effect.fn("CodexManualCompactionRuntime.startAsOwner")(function* (
      hostId: string,
      threadId: string,
    ) {
      const lifetime = yield* capture(hostId, threadId);
      const current = yield* awaitSettings(threadId, lifetime);
      yield* execute(threadId, current);
    });
    const start = Effect.fn("CodexManualCompactionRuntime.start")(function* (threadId: string) {
      if (!accepting) return yield* new CodexManualCompactionClosedError({ threadId });
      const hostId = yield* hosts.resolve(threadId);
      const captured = yield* capture(hostId, threadId);
      const lifetime = yield* awaitSettings(threadId, captured);
      if (lifetime.role.role === "owner") return yield* execute(threadId, lifetime);
      const ownerClientId = lifetime.role.ownerClientId;
      const response = yield* Effect.tryPromise({
        try: async () => {
          const result = await lifetime.manager.coordination.requestThreadFollower({
            hostId,
            targetClientId: ownerClientId,
            request: {
              method: "thread-follower-compact-thread",
              params: { conversationId: threadId },
            },
          });
          if (result.resultType !== "success")
            throw new Error(result.resultType === "error" ? result.error : "no-client-found");
        },
        catch: (cause) => fail(threadId, cause),
      }).pipe(Effect.result);
      yield* check(threadId, lifetime);
      if (response._tag === "Success") return;
      if (!missingOwner(response.failure)) return yield* Effect.fail(response.failure);
      yield* Effect.sync(() => {
        lifetime.manager.stream.removeConversation(threadId);
        lifetime.entity.setResumeState("needs_resume");
        lifetime.entity.setStreaming(false);
      });
      const resumed = yield* resume.resume(threadId);
      yield* Effect.try({
        try: () => lifetime.manager.assertCurrent(lifetime.generation),
        catch: (cause) => fail(threadId, cause),
      });
      if (resumed.status !== "ready")
        return yield* fail(threadId, new Error(`Conversation is not ready: ${resumed.reason}`));
      yield* startAsOwner(hostId, threadId);
    });

    return CodexManualCompactionRuntime.of({
      start,
      startAsOwner,
      consumeSource: (threadId) => {
        const entry = entries.get(threadId);
        if (!entry || !isCurrent(threadId, entry.lifetime)) {
          clear(threadId);
          return "automatic";
        }
        const source = pending.consumeSource(threadId);
        if (!pending.hasPending(threadId)) clear(threadId);
        return source;
      },
      clear,
    });
  }),
);
