import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { MainShutdown } from "../app/MainShutdown";
import {
  CodexApplicationRequestInbox,
  type CodexApplicationProtocolOccurrence,
} from "../codex-runtime/CodexApplicationRequestInbox";
import { CodexApplicationProtocol } from "./CodexApplicationProtocol";
import { isCodexOneShotServerRequestMethod } from "./CodexOneShotServerRequests";
import { ThreadCreationRuntime } from "./ThreadCreationRuntime";

const MAX_CONCURRENT_CONVERSATIONS = 64;

export type CodexProtocolIngressHealth =
  | { readonly _tag: "Starting" }
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Failed"; readonly cause: Cause.Cause<unknown> }
  | { readonly _tag: "Stopped" };

export class CodexProtocolIngress extends Context.Service<
  CodexProtocolIngress,
  {
    readonly health: SubscriptionRef.SubscriptionRef<CodexProtocolIngressHealth>;
  }
>()("nodex/main/codex-application/CodexProtocolIngress") {}

const interruptedOnly = (cause: Cause.Cause<unknown>): boolean => Cause.hasInterruptsOnly(cause);

type CausalIngressMessage<A> =
  | { readonly _tag: "Enqueue"; readonly key: string; readonly value: A }
  | { readonly _tag: "Completed"; readonly key: string; readonly exit: Exit.Exit<void> }
  | { readonly _tag: "SourceEnded" };

interface CausalIngressLane<A> {
  readonly pending: A[];
}

/**
 * Drains one ordered source with bounded residency. Work for different keys may overlap, while one
 * key is dispatched strictly in source order. The permit remains charged until processing ends, so
 * this stage cannot move an unbounded backlog out of the upstream Inbox and into private queues.
 */
export const runBoundedCausalIngress = <A, E, R>(input: {
  readonly source: Stream.Stream<A, E, R>;
  readonly key: (value: A) => string;
  readonly dispatch: (value: A) => Effect.Effect<void>;
  readonly capacity: number;
}): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    const messages = yield* Queue.unbounded<CausalIngressMessage<A>>();
    const permits = yield* Semaphore.make(Math.max(1, Math.floor(input.capacity)));
    const lanes = new Map<string, CausalIngressLane<A>>();
    let sourceEnded = false;

    const launch = (key: string, value: A) =>
      input.dispatch(value).pipe(
        Effect.exit,
        Effect.flatMap((exit) => Queue.offer(messages, { _tag: "Completed", key, exit })),
        Effect.asVoid,
        Effect.forkChild,
      );

    const scheduler = Effect.gen(function* () {
      while (true) {
        const message = yield* Queue.take(messages);
        if (message._tag === "Enqueue") {
          const lane = lanes.get(message.key);
          if (lane) {
            lane.pending.push(message.value);
          } else {
            lanes.set(message.key, { pending: [] });
            yield* launch(message.key, message.value);
          }
          continue;
        }
        if (message._tag === "SourceEnded") {
          sourceEnded = true;
          if (lanes.size === 0) return;
          continue;
        }

        yield* permits.release(1);
        if (Exit.isFailure(message.exit)) return yield* Effect.failCause(message.exit.cause);
        const lane = lanes.get(message.key);
        const next = lane?.pending.shift();
        if (next !== undefined) {
          yield* launch(message.key, next);
          continue;
        }
        lanes.delete(message.key);
        if (sourceEnded && lanes.size === 0) return;
      }
    });

    const producer = input.source.pipe(
      Stream.runForEach((value) =>
        permits
          .take(1)
          .pipe(
            Effect.andThen(
              Queue.offer(messages, { _tag: "Enqueue", key: input.key(value), value }),
            ),
            Effect.asVoid,
          ),
      ),
      Effect.andThen(Queue.offer(messages, { _tag: "SourceEnded" })),
      Effect.andThen(Effect.never),
    );

    return yield* Effect.raceFirst(scheduler, producer);
  });

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const occurrenceThreadId = (occurrence: CodexApplicationProtocolOccurrence): string | null => {
  const params = record(occurrence.params);
  if (!params) return null;
  const direct =
    typeof params.threadId === "string"
      ? params.threadId
      : typeof params.conversationId === "string"
        ? params.conversationId
        : null;
  if (direct?.trim()) return direct.trim();
  const thread = record(params.thread);
  return typeof thread?.id === "string" && thread.id.trim() ? thread.id.trim() : null;
};

export const codexProtocolOccurrenceCausalKey = (
  occurrence: CodexApplicationProtocolOccurrence,
): string => {
  const generation = `${occurrence.hostId}\u0000${occurrence.generation}`;
  if (
    occurrence.kind === "request" &&
    (occurrence.method === "inbox-items-create" ||
      isCodexOneShotServerRequestMethod(occurrence.method))
  ) {
    return `${generation}\u0000independent\u0000${occurrence.occurrenceToken}`;
  }
  const threadId = occurrenceThreadId(occurrence);
  return threadId ? `${generation}\u0000thread\u0000${threadId}` : `${generation}\u0000global`;
};

export const live: Layer.Layer<
  CodexProtocolIngress,
  never,
  CodexApplicationProtocol | CodexApplicationRequestInbox | ThreadCreationRuntime | MainShutdown
> = Layer.effect(
  CodexProtocolIngress,
  Effect.gen(function* () {
    const protocol = yield* CodexApplicationProtocol;
    const inbox = yield* CodexApplicationRequestInbox;
    const threadStarts = yield* ThreadCreationRuntime;
    const shutdown = yield* MainShutdown;
    const health = yield* SubscriptionRef.make<CodexProtocolIngressHealth>({ _tag: "Starting" });

    const occurrences = runBoundedCausalIngress({
      source: inbox.occurrences,
      key: codexProtocolOccurrenceCausalKey,
      dispatch: (occurrence) =>
        occurrence.kind === "request"
          ? protocol.interpret(occurrence)
          : protocol.observe(occurrence),
      capacity: MAX_CONCURRENT_CONVERSATIONS,
    });
    const releases = threadStarts.releases.pipe(
      Stream.runForEach((release) => protocol.releaseThreadStart(release)),
    );
    const actor = Effect.raceFirst(
      threadStarts.termination,
      Effect.raceFirst(occurrences, releases),
    ).pipe(
      Effect.flatMap(() => Effect.die("Codex protocol ingress ended unexpectedly")),
      Effect.onExit((exit) => {
        if (Exit.isFailure(exit) && !interruptedOnly(exit.cause)) {
          return SubscriptionRef.set(health, { _tag: "Failed", cause: exit.cause }).pipe(
            Effect.andThen(
              shutdown.request({
                _tag: "RuntimeFatal",
                subsystem: "codex-protocol-ingress",
                cause: exit.cause,
              }),
            ),
            Effect.asVoid,
          );
        }
        return SubscriptionRef.set(health, { _tag: "Stopped" });
      }),
    );

    yield* SubscriptionRef.set(health, { _tag: "Ready" });
    yield* Effect.forkScoped(actor, { startImmediately: true });
    return CodexProtocolIngress.of({ health });
  }),
);
