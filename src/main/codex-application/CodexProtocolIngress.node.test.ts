import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { MainShutdown, layer as mainShutdownLive } from "../app/MainShutdown";
import { CodexApplicationRequestInbox } from "../codex-runtime/CodexApplicationRequestInbox";
import { CodexApplicationProtocol } from "./CodexApplicationProtocol";
import { CodexProtocolIngress, live } from "./CodexProtocolIngress";
import { ThreadCreationRuntime } from "./ThreadCreationRuntime";

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
