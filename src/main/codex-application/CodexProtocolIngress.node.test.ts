import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { MainShutdown, layer as mainShutdownLive } from "../app/MainShutdown";
import { CodexApplicationRequestInbox } from "../codex-runtime/CodexApplicationRequestInbox";
import { CodexApplicationProtocol } from "./CodexApplicationProtocol";
import { CodexProtocolIngress, live, runBoundedCausalIngress } from "./CodexProtocolIngress";
import { ThreadCreationRuntime } from "./ThreadCreationRuntime";

it.effect("preserves FIFO within a causal key while another key progresses", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const otherCompleted = yield* Deferred.make<void>();
    const observed: string[] = [];
    const run = yield* runBoundedCausalIngress({
      source: Stream.make(
        { key: "thread-a", label: "a1" },
        { key: "thread-a", label: "a2" },
        { key: "thread-b", label: "b1" },
      ),
      key: ({ key }) => key,
      dispatch: ({ label }) => {
        if (label === "a1") {
          return Effect.sync(() => observed.push("a1:start")).pipe(
            Effect.andThen(Deferred.succeed(firstStarted, undefined)),
            Effect.andThen(Deferred.await(releaseFirst)),
            Effect.andThen(Effect.sync(() => observed.push("a1:end"))),
            Effect.asVoid,
          );
        }
        if (label === "b1") {
          return Effect.sync(() => observed.push("b1")).pipe(
            Effect.andThen(Deferred.succeed(otherCompleted, undefined)),
            Effect.asVoid,
          );
        }
        return Effect.sync(() => observed.push(label));
      },
      capacity: 3,
    }).pipe(Effect.forkChild);

    yield* Deferred.await(firstStarted);
    yield* Deferred.await(otherCompleted);
    assert.deepEqual(observed, ["a1:start", "b1"]);
    yield* Deferred.succeed(releaseFirst, undefined);
    yield* Fiber.join(run);
    assert.deepEqual(observed, ["a1:start", "b1", "a1:end", "a2"]);
  }),
);

it.effect("turns an unexpected canonical ingress exit into runtime-fatal health", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const shutdownContext = yield* Layer.buildWithScope(mainShutdownLive, scope);
    const shutdown = Context.get(shutdownContext, MainShutdown);
    const protocol = CodexApplicationProtocol.of({
      interpret: () => Effect.void,
      observe: () => Effect.void,
      beginResume: () => false,
      hasResume: () => false,
      releaseResume: () => Effect.void,
      discardResume: () => Effect.void,
      clearConversationBuffer: () => Effect.void,
      releaseThreadStart: () => Effect.void,
    });
    const inbox = CodexApplicationRequestInbox.of({
      occurrences: Stream.die("canonical ingress defect"),
    } as unknown as CodexApplicationRequestInbox["Service"]);
    const threadStarts = ThreadCreationRuntime.of({
      materialize: (_hostId, _generation, operation) => operation,
      defer: () => false,
      releases: Stream.never,
      termination: Effect.never,
      clear: () => undefined,
    });
    const context = yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(CodexApplicationProtocol, protocol),
            Layer.succeed(CodexApplicationRequestInbox, inbox),
            Layer.succeed(ThreadCreationRuntime, threadStarts),
            Layer.succeed(MainShutdown, shutdown),
          ),
        ),
      ),
      scope,
    );
    const ingress = Context.get(context, CodexProtocolIngress);

    const shutdownReason = yield* shutdown.awaitRequest;
    assert.strictEqual(shutdownReason._tag, "RuntimeFatal");
    if (shutdownReason._tag === "RuntimeFatal") {
      assert.strictEqual(shutdownReason.subsystem, "codex-protocol-ingress");
      assert.isDefined(shutdownReason.cause);
    }
    const health = yield* SubscriptionRef.get(ingress.health);
    assert.strictEqual(health._tag, "Failed");
    yield* Scope.close(scope, Exit.void);
  }),
);
