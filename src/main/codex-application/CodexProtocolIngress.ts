import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { MainShutdown } from "../app/MainShutdown";
import { CodexApplicationRequestInbox } from "../codex-runtime/CodexApplicationRequestInbox";
import { CodexApplicationProtocol } from "./CodexApplicationProtocol";
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

    const occurrences = inbox.occurrences.pipe(
      Stream.mapEffect(
        (occurrence) =>
          occurrence.kind === "request"
            ? protocol.interpret(occurrence)
            : protocol.observe(occurrence),
        { concurrency: MAX_CONCURRENT_CONVERSATIONS, unordered: true },
      ),
      Stream.runDrain,
    );
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
