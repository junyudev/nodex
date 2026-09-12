import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type {
  CodexUserInputAutoResolutionChange,
  CodexUserInputAutoResolutionEntry,
} from "../../shared/codex-user-input-auto-resolution";
import type { CodexProtocolRequestId } from "../../shared/types";
import { MAIN_OBSERVATION_EVENT_CAPACITY } from "../runtime-limits";
import { CodexRendererPresentationRegistry } from "./CodexRendererPresentationRegistry";

export const USER_INPUT_FOREGROUND_INACTIVITY = "60 seconds";
export const USER_INPUT_AUTO_RESOLUTION_COUNTDOWN = "90 seconds";
const USER_INPUT_AUTO_RESOLUTION_COUNTDOWN_MS = 90_000;

export type CodexUserInputAutoResolutionResponseKind = "emptyUserInput" | "declineMcpElicitation";

export interface CodexUserInputAutoResolutionRequestOptions {
  readonly responseKind?: CodexUserInputAutoResolutionResponseKind;
  readonly autoResolutionMs?: number;
}

export type CodexUserInputAutoResolutionTimeout = Extract<
  CodexUserInputAutoResolutionChange,
  { readonly type: "timedOut" }
> & {
  readonly connection: { readonly hostId: string; readonly generation: number };
  readonly responseKind: CodexUserInputAutoResolutionResponseKind;
};

type AutoResolutionEvent =
  | Exclude<CodexUserInputAutoResolutionChange, { readonly type: "timedOut" }>
  | CodexUserInputAutoResolutionTimeout;

interface TrackedUserInput {
  readonly entry: CodexUserInputAutoResolutionEntry;
  readonly generation: number;
  readonly connection: { readonly hostId: string; readonly generation: number };
  readonly responseKind: CodexUserInputAutoResolutionResponseKind;
  readonly autoResolutionMs: number | null;
}

export class CodexUserInputAutoResolution extends Context.Service<
  CodexUserInputAutoResolution,
  {
    readonly changes: Stream.Stream<CodexUserInputAutoResolutionChange>;
    readonly timeouts: Stream.Stream<CodexUserInputAutoResolutionTimeout>;
    readonly snapshot: Effect.Effect<CodexUserInputAutoResolutionEntry[]>;
    readonly observeRequest: (
      conversationId: string,
      requestId: CodexProtocolRequestId,
      connection: TrackedUserInput["connection"],
      options?: CodexUserInputAutoResolutionRequestOptions,
    ) => Effect.Effect<void>;
    readonly observeResponse: (
      conversationId: string,
      requestId: CodexProtocolRequestId,
      connection: TrackedUserInput["connection"],
    ) => Effect.Effect<void>;
    readonly observeServerResolution: (
      conversationId: string,
      requestId: CodexProtocolRequestId,
      connection: TrackedUserInput["connection"],
    ) => Effect.Effect<void>;
    readonly reevaluatePresentation: (conversationId: string) => Effect.Effect<void>;
    readonly recordActivity: (conversationId: string) => Effect.Effect<void>;
    readonly snooze: (
      conversationId: string,
      requestId: CodexProtocolRequestId,
    ) => Effect.Effect<boolean>;
    readonly clearConversation: (conversationId: string) => Effect.Effect<void>;
    readonly reconcilePendingRequests: (
      conversationId: string,
      requestIds: readonly CodexProtocolRequestId[],
    ) => Effect.Effect<void>;
    readonly handleDisconnect: (hostId: string, generation?: number) => Effect.Effect<void>;
  }
>()("nodex/main/codex-application/CodexUserInputAutoResolution") {}

type RemovalReason = Extract<
  CodexUserInputAutoResolutionChange,
  { readonly type: "removed" }
>["reason"];

const sameRequestId = (left: CodexProtocolRequestId, right: CodexProtocolRequestId): boolean =>
  typeof left === typeof right && left === right;

export const make: Effect.Effect<
  CodexUserInputAutoResolution["Service"],
  never,
  CodexRendererPresentationRegistry | Scope.Scope
> = Effect.gen(function* () {
  const rendererConversations = yield* CodexRendererPresentationRegistry;
  const state = yield* Ref.make(HashMap.empty<string, TrackedUserInput>());
  const changes = yield* PubSub.sliding<AutoResolutionEvent>(MAIN_OBSERVATION_EVENT_CAPACITY);
  const timers = yield* FiberMap.make<string, void>();
  const mutations = yield* Semaphore.make(1);
  yield* Effect.addFinalizer(() => PubSub.shutdown(changes));

  const publish = (change: AutoResolutionEvent) =>
    PubSub.publish(changes, change).pipe(Effect.asVoid);
  const current = (conversationId: string) =>
    Ref.get(state).pipe(
      Effect.map((entries) => Option.getOrUndefined(HashMap.get(entries, conversationId))),
    );
  const isCurrent = (tracked: TrackedUserInput) =>
    current(tracked.entry.conversationId).pipe(
      Effect.map(
        (candidate) =>
          candidate?.generation === tracked.generation &&
          candidate.connection.hostId === tracked.connection.hostId &&
          candidate.connection.generation === tracked.connection.generation &&
          sameRequestId(candidate.entry.requestId, tracked.entry.requestId),
      ),
    );

  const timeout = (tracked: TrackedUserInput) =>
    mutations
      .withPermits(1)(
        Effect.gen(function* () {
          if (!(yield* isCurrent(tracked))) return;
          yield* Ref.update(state, (entries) =>
            HashMap.remove(entries, tracked.entry.conversationId),
          );
          const event: CodexUserInputAutoResolutionTimeout = {
            type: "timedOut",
            connection: tracked.connection,
            conversationId: tracked.entry.conversationId,
            requestId: tracked.entry.requestId,
            responseKind: tracked.responseKind,
          };
          yield* publish(event);
        }),
      )
      .pipe(Effect.asVoid);

  const countdown = (
    tracked: TrackedUserInput,
    timeoutMs = USER_INPUT_AUTO_RESOLUTION_COUNTDOWN_MS,
  ) => Effect.sleep(timeoutMs).pipe(Effect.andThen(timeout(tracked)));
  const foregroundTimer = (tracked: TrackedUserInput) =>
    Effect.sleep(USER_INPUT_FOREGROUND_INACTIVITY).pipe(
      Effect.andThen(
        mutations.withPermits(1)(
          Effect.gen(function* () {
            if (!(yield* isCurrent(tracked))) return false;
            const now = yield* Clock.currentTimeMillis;
            const scheduled: TrackedUserInput = {
              ...tracked,
              entry: {
                ...tracked.entry,
                phase: {
                  type: "scheduled",
                  deadlineMs: now + USER_INPUT_AUTO_RESOLUTION_COUNTDOWN_MS,
                },
              },
            };
            yield* Ref.update(state, (entries) =>
              HashMap.set(entries, scheduled.entry.conversationId, scheduled),
            );
            yield* publish({ type: "updated", entry: scheduled.entry });
            return true;
          }),
        ),
      ),
      Effect.flatMap((continueCountdown) => (continueCountdown ? countdown(tracked) : Effect.void)),
    );

  const schedule = (
    tracked: TrackedUserInput,
    phase: "foreground" | "background",
    publishChange: boolean,
    countdownMs = USER_INPUT_AUTO_RESOLUTION_COUNTDOWN_MS,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const next: TrackedUserInput = {
        ...tracked,
        generation: tracked.generation + 1,
        entry: {
          ...tracked.entry,
          phase:
            phase === "foreground"
              ? { type: "waitingForInactivity" }
              : {
                  type: "scheduled",
                  deadlineMs: now + countdownMs,
                },
        },
      };
      yield* Ref.update(state, (entries) => HashMap.set(entries, next.entry.conversationId, next));
      if (publishChange) yield* publish({ type: "updated", entry: next.entry });
      yield* FiberMap.run(
        timers,
        next.entry.conversationId,
        phase === "foreground" ? foregroundTimer(next) : countdown(next, countdownMs),
        { startImmediately: true },
      );
    });

  const remove = (
    conversationId: string,
    requestId: CodexProtocolRequestId,
    reason: RemovalReason,
    connection?: TrackedUserInput["connection"],
  ) =>
    mutations.withPermits(1)(
      Effect.gen(function* () {
        const tracked = yield* current(conversationId);
        if (!tracked || !sameRequestId(tracked.entry.requestId, requestId)) return false;
        if (
          connection &&
          (tracked.connection.hostId !== connection.hostId ||
            tracked.connection.generation !== connection.generation)
        )
          return false;
        yield* FiberMap.remove(timers, conversationId);
        yield* Ref.update(state, (entries) => HashMap.remove(entries, conversationId));
        yield* publish({ type: "removed", conversationId, requestId, reason });
        return true;
      }),
    );

  const clearAll = (reason: Extract<RemovalReason, "disconnected" | "disposed">) =>
    mutations.withPermits(1)(
      Effect.gen(function* () {
        const entries = [...HashMap.values(yield* Ref.get(state))];
        yield* FiberMap.clear(timers);
        yield* Ref.set(state, HashMap.empty());
        yield* Effect.forEach(
          entries,
          (tracked) =>
            publish({
              type: "removed",
              conversationId: tracked.entry.conversationId,
              requestId: tracked.entry.requestId,
              reason,
            }),
          { discard: true },
        );
      }),
    );

  yield* Effect.addFinalizer(() => clearAll("disposed"));

  const changeStream = Stream.fromPubSub(changes);
  return CodexUserInputAutoResolution.of({
    changes: changeStream.pipe(
      Stream.map((change): CodexUserInputAutoResolutionChange =>
        change.type === "timedOut"
          ? {
              type: "timedOut",
              conversationId: change.conversationId,
              requestId: change.requestId,
            }
          : change,
      ),
    ),
    timeouts: changeStream.pipe(
      Stream.filter(
        (change): change is CodexUserInputAutoResolutionTimeout => change.type === "timedOut",
      ),
    ),
    snapshot: Ref.get(state).pipe(
      Effect.map((entries) =>
        [...HashMap.values(entries)]
          .map((tracked) => tracked.entry)
          .sort((left, right) => left.conversationId.localeCompare(right.conversationId)),
      ),
    ),
    observeRequest: (conversationId, requestId, connection, options = {}) =>
      mutations.withPermits(1)(
        Effect.gen(function* () {
          const previous = yield* current(conversationId);
          if (
            previous &&
            sameRequestId(previous.entry.requestId, requestId) &&
            previous.connection.hostId === connection.hostId &&
            previous.connection.generation === connection.generation
          )
            return;
          if (previous) {
            yield* FiberMap.remove(timers, conversationId);
            yield* publish({
              type: "removed",
              conversationId,
              requestId: previous.entry.requestId,
              reason: "replaced",
            });
          }
          const tracked: TrackedUserInput = {
            connection,
            entry: { conversationId, requestId, phase: { type: "waitingForInactivity" } },
            generation: previous?.generation ?? 0,
            responseKind: options.responseKind ?? "emptyUserInput",
            autoResolutionMs: options.autoResolutionMs ?? null,
          };
          if (tracked.autoResolutionMs !== null) {
            yield* schedule(tracked, "background", true, tracked.autoResolutionMs);
            return;
          }
          yield* schedule(
            tracked,
            rendererConversations.isPresentedInForeground(conversationId)
              ? "foreground"
              : "background",
            true,
          );
        }),
      ),
    observeResponse: (conversationId, requestId, connection) =>
      remove(conversationId, requestId, "responded", connection).pipe(Effect.asVoid),
    observeServerResolution: (conversationId, requestId, connection) =>
      remove(conversationId, requestId, "resolved", connection).pipe(Effect.asVoid),
    reevaluatePresentation: (conversationId) =>
      mutations.withPermits(1)(
        Effect.gen(function* () {
          const tracked = yield* current(conversationId);
          if (!tracked || tracked.entry.phase.type === "snoozed") return;
          if (rendererConversations.isPresentedInForeground(conversationId)) {
            yield* schedule(tracked, "foreground", true);
            return;
          }
          if (tracked.entry.phase.type === "waitingForInactivity") {
            yield* schedule(tracked, "background", true);
          }
        }),
      ),
    recordActivity: (conversationId) =>
      mutations.withPermits(1)(
        Effect.gen(function* () {
          const tracked = yield* current(conversationId);
          if (!tracked || tracked.entry.phase.type !== "waitingForInactivity") return;
          if (!rendererConversations.isPresentedInForeground(conversationId)) return;
          yield* schedule(tracked, "foreground", false);
        }),
      ),
    snooze: (conversationId, requestId) =>
      mutations.withPermits(1)(
        Effect.gen(function* () {
          const tracked = yield* current(conversationId);
          if (!tracked || !sameRequestId(tracked.entry.requestId, requestId)) return false;
          yield* FiberMap.remove(timers, conversationId);
          if (tracked.autoResolutionMs !== null) {
            yield* schedule(tracked, "background", true, tracked.autoResolutionMs);
            return true;
          }
          const snoozed: TrackedUserInput = {
            ...tracked,
            generation: tracked.generation + 1,
            entry: { ...tracked.entry, phase: { type: "snoozed" } },
          };
          yield* Ref.update(state, (entries) => HashMap.set(entries, conversationId, snoozed));
          yield* publish({ type: "updated", entry: snoozed.entry });
          return true;
        }),
      ),
    clearConversation: (conversationId) =>
      mutations.withPermits(1)(
        Effect.gen(function* () {
          const tracked = yield* current(conversationId);
          if (!tracked) return;
          yield* FiberMap.remove(timers, conversationId);
          yield* Ref.update(state, (entries) => HashMap.remove(entries, conversationId));
          yield* publish({
            type: "removed",
            conversationId,
            requestId: tracked.entry.requestId,
            reason: "disposed",
          });
        }),
      ),
    reconcilePendingRequests: (conversationId, requestIds) =>
      mutations.withPermits(1)(
        Effect.gen(function* () {
          const tracked = yield* current(conversationId);
          if (!tracked) return;
          if (requestIds.some((requestId) => sameRequestId(requestId, tracked.entry.requestId))) {
            return;
          }
          yield* FiberMap.remove(timers, conversationId);
          yield* Ref.update(state, (entries) => HashMap.remove(entries, conversationId));
          yield* publish({
            type: "removed",
            conversationId,
            requestId: tracked.entry.requestId,
            reason: "disposed",
          });
        }),
      ),
    handleDisconnect: (hostId, generation) =>
      mutations.withPermit(
        Effect.gen(function* () {
          const entries = [...HashMap.values(yield* Ref.get(state))];
          for (const tracked of entries) {
            if (
              tracked.connection.hostId !== hostId ||
              (generation !== undefined && tracked.connection.generation !== generation)
            )
              continue;
            const { conversationId, requestId } = tracked.entry;
            yield* FiberMap.remove(timers, conversationId);
            yield* Ref.update(state, (current) => HashMap.remove(current, conversationId));
            yield* publish({ type: "removed", conversationId, requestId, reason: "disconnected" });
          }
        }),
      ),
  });
});
