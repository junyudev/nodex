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
  CodexUserInputAutoResolutionConversation,
  CodexUserInputAutoResolutionTarget,
} from "../../shared/codex-user-input-auto-resolution";
import { codexUserInputConversationKey } from "../../shared/codex-user-input-auto-resolution";
import type { CodexProtocolRequestId } from "../../shared/types";
import { MAIN_OBSERVATION_EVENT_CAPACITY } from "../runtime-limits";
import { CodexRendererPresentationRegistry } from "./CodexRendererPresentationRegistry";

export const USER_INPUT_FOREGROUND_INACTIVITY = "60 seconds";
export const USER_INPUT_AUTO_RESOLUTION_COUNTDOWN = "90 seconds";
const USER_INPUT_AUTO_RESOLUTION_COUNTDOWN_MS = 90_000;

export type CodexUserInputAutoResolutionResponseKind =
  | "emptyUserInput"
  | "declineMcpElicitation"
  | "runtimeUserInput";

export interface CodexUserInputAutoResolutionRequestOptions {
  readonly hostId?: string;
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
    readonly reevaluatePresentation: (
      conversation: CodexUserInputAutoResolutionConversation,
    ) => Effect.Effect<void>;
    readonly recordActivity: (
      conversation: CodexUserInputAutoResolutionConversation,
    ) => Effect.Effect<void>;
    readonly snooze: (target: CodexUserInputAutoResolutionTarget) => Effect.Effect<boolean>;
    readonly clearConversation: (
      conversation: CodexUserInputAutoResolutionConversation,
    ) => Effect.Effect<void>;
    readonly reconcilePendingRequests: (
      conversation: CodexUserInputAutoResolutionConversation,
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
  const current = (conversation: CodexUserInputAutoResolutionConversation) =>
    Ref.get(state).pipe(
      Effect.map((entries) =>
        Option.getOrUndefined(HashMap.get(entries, codexUserInputConversationKey(conversation))),
      ),
    );
  const isCurrent = (tracked: TrackedUserInput) =>
    current(tracked.entry).pipe(
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
            HashMap.remove(entries, codexUserInputConversationKey(tracked.entry)),
          );
          const event: CodexUserInputAutoResolutionTimeout = {
            type: "timedOut",
            connection: tracked.connection,
            hostId: tracked.entry.hostId,
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
              HashMap.set(entries, codexUserInputConversationKey(scheduled.entry), scheduled),
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
      yield* Ref.update(state, (entries) =>
        HashMap.set(entries, codexUserInputConversationKey(next.entry), next),
      );
      if (publishChange) yield* publish({ type: "updated", entry: next.entry });
      yield* FiberMap.run(
        timers,
        codexUserInputConversationKey(next.entry),
        phase === "foreground" ? foregroundTimer(next) : countdown(next, countdownMs),
        { startImmediately: true },
      );
    });

  const remove = (
    conversation: CodexUserInputAutoResolutionConversation,
    requestId: CodexProtocolRequestId,
    reason: RemovalReason,
    connection?: TrackedUserInput["connection"],
  ) =>
    mutations.withPermits(1)(
      Effect.gen(function* () {
        const tracked = yield* current(conversation);
        if (!tracked || !sameRequestId(tracked.entry.requestId, requestId)) return false;
        if (
          connection &&
          (tracked.connection.hostId !== connection.hostId ||
            tracked.connection.generation !== connection.generation)
        )
          return false;
        yield* FiberMap.remove(timers, codexUserInputConversationKey(conversation));
        yield* Ref.update(state, (entries) =>
          HashMap.remove(entries, codexUserInputConversationKey(conversation)),
        );
        yield* publish({ type: "removed", ...conversation, requestId, reason });
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
              hostId: tracked.entry.hostId,
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
              hostId: change.hostId,
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
          const conversation = { hostId: options.hostId ?? connection.hostId, conversationId };
          const previous = yield* current(conversation);
          if (
            previous &&
            sameRequestId(previous.entry.requestId, requestId) &&
            previous.connection.hostId === connection.hostId &&
            previous.connection.generation === connection.generation
          )
            return;
          if (previous) {
            yield* FiberMap.remove(timers, codexUserInputConversationKey(conversation));
            yield* publish({
              type: "removed",
              ...conversation,
              requestId: previous.entry.requestId,
              reason: "replaced",
            });
          }
          const tracked: TrackedUserInput = {
            connection,
            entry: { ...conversation, requestId, phase: { type: "waitingForInactivity" } },
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
            rendererConversations.isPresentedInForeground(
              conversation.conversationId,
              conversation.hostId,
            )
              ? "foreground"
              : "background",
            true,
          );
        }),
      ),
    observeResponse: (conversationId, requestId, connection) =>
      remove(
        { hostId: connection.hostId, conversationId },
        requestId,
        "responded",
        connection,
      ).pipe(Effect.asVoid),
    observeServerResolution: (conversationId, requestId, connection) =>
      remove({ hostId: connection.hostId, conversationId }, requestId, "resolved", connection).pipe(
        Effect.asVoid,
      ),
    reevaluatePresentation: (conversation) =>
      mutations.withPermits(1)(
        Effect.gen(function* () {
          const tracked = yield* current(conversation);
          if (!tracked || tracked.entry.phase.type === "snoozed") return;
          if (
            rendererConversations.isPresentedInForeground(
              conversation.conversationId,
              conversation.hostId,
            )
          ) {
            yield* schedule(tracked, "foreground", true);
            return;
          }
          if (tracked.entry.phase.type === "waitingForInactivity") {
            yield* schedule(tracked, "background", true);
          }
        }),
      ),
    recordActivity: (conversation) =>
      mutations.withPermits(1)(
        Effect.gen(function* () {
          const tracked = yield* current(conversation);
          if (!tracked || tracked.entry.phase.type !== "waitingForInactivity") return;
          if (
            !rendererConversations.isPresentedInForeground(
              conversation.conversationId,
              conversation.hostId,
            )
          )
            return;
          yield* schedule(tracked, "foreground", false);
        }),
      ),
    snooze: (conversation) =>
      mutations.withPermits(1)(
        Effect.gen(function* () {
          const tracked = yield* current(conversation);
          if (!tracked || !sameRequestId(tracked.entry.requestId, conversation.requestId))
            return false;
          yield* FiberMap.remove(timers, codexUserInputConversationKey(conversation));
          if (tracked.autoResolutionMs !== null) {
            yield* schedule(tracked, "background", true, tracked.autoResolutionMs);
            return true;
          }
          const snoozed: TrackedUserInput = {
            ...tracked,
            generation: tracked.generation + 1,
            entry: { ...tracked.entry, phase: { type: "snoozed" } },
          };
          yield* Ref.update(state, (entries) =>
            HashMap.set(entries, codexUserInputConversationKey(conversation), snoozed),
          );
          yield* publish({ type: "updated", entry: snoozed.entry });
          return true;
        }),
      ),
    clearConversation: (conversation) =>
      mutations.withPermits(1)(
        Effect.gen(function* () {
          const tracked = yield* current(conversation);
          if (!tracked) return;
          yield* FiberMap.remove(timers, codexUserInputConversationKey(conversation));
          yield* Ref.update(state, (entries) =>
            HashMap.remove(entries, codexUserInputConversationKey(conversation)),
          );
          yield* publish({
            type: "removed",
            ...conversation,
            requestId: tracked.entry.requestId,
            reason: "disposed",
          });
        }),
      ),
    reconcilePendingRequests: (conversation, requestIds) =>
      mutations.withPermits(1)(
        Effect.gen(function* () {
          const tracked = yield* current(conversation);
          if (!tracked) return;
          if (requestIds.some((requestId) => sameRequestId(requestId, tracked.entry.requestId))) {
            return;
          }
          yield* FiberMap.remove(timers, codexUserInputConversationKey(conversation));
          yield* Ref.update(state, (entries) =>
            HashMap.remove(entries, codexUserInputConversationKey(conversation)),
          );
          yield* publish({
            type: "removed",
            ...conversation,
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
            const conversation = tracked.entry;
            const { requestId } = tracked.entry;
            yield* FiberMap.remove(timers, codexUserInputConversationKey(conversation));
            yield* Ref.update(state, (current) =>
              HashMap.remove(current, codexUserInputConversationKey(conversation)),
            );
            yield* publish({
              type: "removed",
              hostId: conversation.hostId,
              conversationId: conversation.conversationId,
              requestId,
              reason: "disconnected",
            });
          }
        }),
      ),
  });
});
