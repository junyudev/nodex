import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import { DEFAULT_CODEX_HOST_ID } from "../../shared/codex-host";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexOwnerNotificationDrainRuntime } from "./CodexOwnerNotificationDrainRuntime";
import { CodexRendererConversationRegistry } from "./CodexRendererConversationRegistry";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

export const DEFAULT_RENDERER_OWNER_RETENTION = "1 hour";
export const DEFAULT_RENDERER_OWNER_MAX_RETAINED = 4;
export const DEFAULT_RENDERER_OWNER_MAX_RETAINED_APPROXIMATE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_RENDERER_OWNER_RETRY = "15 seconds";

export type CodexRendererOwnerCleanupReason =
  | "inactive-owner-retention"
  | "inactive-owner-retained-limit"
  | "inactive-owner-retained-byte-limit"
  | "inactive-owner-retry";

export class CodexRendererOwnerRetentionError extends Data.TaggedError(
  "CodexRendererOwnerRetentionError",
)<{ readonly cause: unknown }> {}

interface TrackedCandidate {
  readonly candidateSince: number;
  readonly generation: number;
}

export interface CodexRendererOwnerRetentionOptions {
  readonly retention?: Duration.Input;
  readonly maxRetained?: number;
  readonly maxRetainedApproximateBytes?: number;
  readonly retry?: Duration.Input;
}

export interface CodexRendererOwnerRetentionCandidate {
  readonly conversationId: string;
  readonly candidateSince: number;
  readonly generation: number;
  readonly approximateBytes: number;
}

export interface CodexRendererOwnerRetentionOverflow {
  readonly conversationId: string;
  readonly generation: number;
  readonly reason: Extract<
    CodexRendererOwnerCleanupReason,
    "inactive-owner-retained-limit" | "inactive-owner-retained-byte-limit"
  >;
}

const retainedBytes = (value: number): number => {
  if (!Number.isFinite(value) || value < 0) return Number.MAX_SAFE_INTEGER;
  return Math.floor(value);
};

/** Oldest-first pressure policy shared by production cleanup and its boundary tests. */
export function selectCodexRendererOwnerRetentionOverflow(input: {
  readonly candidates: readonly CodexRendererOwnerRetentionCandidate[];
  readonly maxRetained: number;
  readonly maxRetainedApproximateBytes: number;
}): readonly CodexRendererOwnerRetentionOverflow[] {
  const ordered = [...input.candidates].sort((left, right) => {
    const since = left.candidateSince - right.candidateSince;
    return since !== 0 ? since : left.conversationId.localeCompare(right.conversationId);
  });
  const countLimit = Math.max(0, Math.floor(input.maxRetained));
  const byteLimit = retainedBytes(input.maxRetainedApproximateBytes);
  let retainedCount = ordered.length;
  let retainedApproximateBytes = ordered.reduce(
    (total, candidate) =>
      Math.min(Number.MAX_SAFE_INTEGER, total + retainedBytes(candidate.approximateBytes)),
    0,
  );
  const overflow: CodexRendererOwnerRetentionOverflow[] = [];

  for (const candidate of ordered) {
    const countExceeded = retainedCount > countLimit;
    const bytesExceeded = retainedApproximateBytes > byteLimit;
    if (!countExceeded && !bytesExceeded) break;
    overflow.push({
      conversationId: candidate.conversationId,
      generation: candidate.generation,
      reason: countExceeded
        ? "inactive-owner-retained-limit"
        : "inactive-owner-retained-byte-limit",
    });
    retainedCount -= 1;
    retainedApproximateBytes = Math.max(
      0,
      retainedApproximateBytes - retainedBytes(candidate.approximateBytes),
    );
  }
  return overflow;
}

export class CodexRendererOwnerRetention extends Context.Service<
  CodexRendererOwnerRetention,
  {
    readonly trackedConversationIds: Effect.Effect<readonly string[]>;
    readonly reconcile: (conversationId: string) => Effect.Effect<void>;
    readonly recheckAfter: (conversationId: string, delay: Duration.Input) => Effect.Effect<void>;
    readonly clear: (conversationId: string) => Effect.Effect<void>;
  }
>()("nodex/main/codex-application/CodexRendererOwnerRetention") {}

export const make = (
  options: CodexRendererOwnerRetentionOptions = {},
): Effect.Effect<
  CodexRendererOwnerRetention["Service"],
  never,
  | CodexApplicationEventHub
  | CodexGateway
  | CodexOwnerNotificationDrainRuntime
  | CodexRendererConversationRegistry
  | ConversationEntityMap
  | Scope.Scope
> =>
  Effect.gen(function* () {
    const conversations = yield* ConversationEntityMap;
    const events = yield* CodexApplicationEventHub;
    const gateway = yield* CodexGateway;
    const ownerNotificationDrain = yield* CodexOwnerNotificationDrainRuntime;
    const rendererConversations = yield* CodexRendererConversationRegistry;
    const retention = options.retention ?? DEFAULT_RENDERER_OWNER_RETENTION;
    const retry = options.retry ?? DEFAULT_RENDERER_OWNER_RETRY;
    const maxRetained = Math.max(
      0,
      Math.floor(options.maxRetained ?? DEFAULT_RENDERER_OWNER_MAX_RETAINED),
    );
    const maxRetainedApproximateBytes = retainedBytes(
      options.maxRetainedApproximateBytes ?? DEFAULT_RENDERER_OWNER_MAX_RETAINED_APPROXIMATE_BYTES,
    );
    const candidates = yield* Ref.make(HashMap.empty<string, TrackedCandidate>());
    const nextGeneration = yield* Ref.make(0);
    const timers = yield* FiberMap.make<string, void>();
    const rechecks = yield* FiberMap.make<string, void>();
    const cleanups = yield* FiberMap.make<string, void>();
    const mutations = yield* Semaphore.make(1);

    const current = (conversationId: string) =>
      Ref.get(candidates).pipe(
        Effect.map((state) => Option.getOrUndefined(HashMap.get(state, conversationId))),
      );
    const isCandidate = (conversationId: string): boolean => {
      const detached = rendererConversations.hasDetachedOwner(conversationId);
      if (!rendererConversations.hasOwner(conversationId) && !detached) return false;
      if (rendererConversations.hasFollowersOrPendingReconnect(conversationId)) return false;
      if (rendererConversations.hasActiveView(conversationId)) return false;

      const aggregate = conversations.current(conversationId);
      const conversation = aggregate?.read().acceptedReplica?.conversation;
      if (!aggregate || !conversation) return false;
      if (!detached && aggregate.readStreamRole() !== "owner") return false;
      if (
        conversation.resumeState !== "resumed" &&
        !(detached && conversation.resumeState === "needs_resume")
      ) {
        return false;
      }
      if (conversation.statusType === "active" || conversation.statusActiveFlags.length > 0) {
        return false;
      }
      if (conversation.turns.some((turn) => turn.status === "inProgress")) return false;
      return aggregate.readServerRequests().length === 0;
    };
    const isCurrent = (conversationId: string, generation: number) =>
      current(conversationId).pipe(
        Effect.map(
          (candidate) => candidate?.generation === generation && isCandidate(conversationId),
        ),
      );
    const removeCurrent = (conversationId: string, generation: number) =>
      Ref.update(candidates, (state) => {
        const candidate = Option.getOrUndefined(HashMap.get(state, conversationId));
        return candidate?.generation === generation ? HashMap.remove(state, conversationId) : state;
      });
    const cleanupKey = (conversationId: string, generation: number) =>
      `${conversationId}\0${generation}`;
    const unsubscribe = (conversationId: string) =>
      gateway
        .requestForThread(conversationId, "thread/unsubscribe", { threadId: conversationId })
        .pipe(
          Effect.asVoid,
          Effect.mapError((cause) => new CodexRendererOwnerRetentionError({ cause })),
        );
    const commitCleanup = (conversationId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!isCandidate(conversationId)) return;
        const aggregate = conversations.current(conversationId);
        const ownerClientId = rendererConversations.clearConversation(conversationId);
        ownerNotificationDrain.release(conversationId);
        if (aggregate) {
          aggregate.setStreamRole(null);
        }
        if (ownerClientId) {
          events.publish({
            kind: "hostMessage",
            value: {
              type: "threadOwnerUnavailable",
              hostId: DEFAULT_CODEX_HOST_ID,
              ownerClientId,
              conversationIds: [conversationId],
            },
          });
        }
        // No active view, follower, reconnect, request, or live Turn remains. Core and app-server
        // retain durable identity; closing the entity generation is what actually releases the
        // transcript object graph instead of keeping a passive full-history replica indefinitely.
        yield* conversations.retire(conversationId);
      });

    const startTimer = (
      conversationId: string,
      generation: number,
      delay: Duration.Input,
      reason: CodexRendererOwnerCleanupReason,
    ): Effect.Effect<void> =>
      FiberMap.run(
        timers,
        conversationId,
        Effect.sleep(delay).pipe(
          Effect.andThen(Effect.suspend(() => startCleanup(conversationId, generation, reason))),
        ),
        { startImmediately: true },
      ).pipe(Effect.asVoid);

    const startCleanup = (
      conversationId: string,
      generation: number,
      reason: CodexRendererOwnerCleanupReason,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!(yield* isCurrent(conversationId, generation))) return;
        const key = cleanupKey(conversationId, generation);
        if (yield* FiberMap.has(cleanups, key)) return;
        yield* FiberMap.run(
          cleanups,
          key,
          unsubscribe(conversationId).pipe(
            Effect.flatMap(() =>
              isCurrent(conversationId, generation).pipe(
                Effect.flatMap((stillCurrent) =>
                  stillCurrent
                    ? commitCleanup(conversationId).pipe(
                        Effect.andThen(removeCurrent(conversationId, generation)),
                      )
                    : Effect.void,
                ),
              ),
            ),
            Effect.catch((error) =>
              isCurrent(conversationId, generation).pipe(
                Effect.flatMap((stillCurrent) =>
                  stillCurrent
                    ? Effect.logWarning("Failed to unsubscribe inactive renderer owner").pipe(
                        Effect.annotateLogs({
                          cause: String(error.cause),
                          conversationId,
                          reason,
                        }),
                        Effect.andThen(
                          startTimer(conversationId, generation, retry, "inactive-owner-retry"),
                        ),
                      )
                    : Effect.void,
                ),
              ),
            ),
          ),
          { startImmediately: true },
        );
      });

    const reconcile = (conversationId: string) =>
      mutations.withPermits(1)(
        Effect.gen(function* () {
          if (!isCandidate(conversationId)) {
            yield* Ref.update(candidates, (state) => HashMap.remove(state, conversationId));
            yield* FiberMap.remove(timers, conversationId);
            return;
          }

          const now = yield* Clock.currentTimeMillis;
          let candidate = yield* current(conversationId);
          if (!candidate) {
            const generation = yield* Ref.updateAndGet(nextGeneration, (value) => value + 1);
            candidate = { candidateSince: now, generation };
            yield* Ref.update(candidates, (state) =>
              HashMap.set(state, conversationId, candidate as TrackedCandidate),
            );
          }

          const activeCleanup = yield* FiberMap.has(
            cleanups,
            cleanupKey(conversationId, candidate.generation),
          );
          if (!activeCleanup && !(yield* FiberMap.has(timers, conversationId))) {
            const elapsed = Math.max(0, now - candidate.candidateSince);
            yield* startTimer(
              conversationId,
              candidate.generation,
              Math.max(0, Duration.toMillis(retention) - elapsed),
              "inactive-owner-retention",
            );
          }

          const tracked = [...HashMap.entries(yield* Ref.get(candidates))].map(
            ([id, trackedCandidate]) => ({
              conversationId: id,
              candidateSince: trackedCandidate.candidateSince,
              generation: trackedCandidate.generation,
              approximateBytes:
                conversations.current(id)?.readHistoryTopology().residency.approximateBytes ?? 0,
            }),
          );
          for (const overflow of selectCodexRendererOwnerRetentionOverflow({
            candidates: tracked,
            maxRetained,
            maxRetainedApproximateBytes,
          })) {
            yield* FiberMap.remove(timers, overflow.conversationId);
            yield* startCleanup(overflow.conversationId, overflow.generation, overflow.reason);
          }
        }),
      );

    return CodexRendererOwnerRetention.of({
      trackedConversationIds: Ref.get(candidates).pipe(
        Effect.map((state) => [...HashMap.keys(state)].sort()),
      ),
      reconcile,
      recheckAfter: (conversationId, delay) =>
        FiberMap.run(
          rechecks,
          conversationId,
          Effect.sleep(delay).pipe(Effect.andThen(Effect.suspend(() => reconcile(conversationId)))),
          { startImmediately: true },
        ).pipe(Effect.asVoid),
      clear: (conversationId) =>
        mutations.withPermits(1)(
          Effect.gen(function* () {
            yield* Ref.update(candidates, (state) => HashMap.remove(state, conversationId));
            yield* FiberMap.remove(timers, conversationId);
            yield* FiberMap.remove(rechecks, conversationId);
          }),
        ),
    });
  });
