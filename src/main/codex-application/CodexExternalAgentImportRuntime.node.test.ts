import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { CodexEndpointEvent } from "../codex-runtime/CodexEventHub";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { make } from "./CodexExternalAgentImportRuntime";

const notification = (
  method: "externalAgentConfig/import/progress" | "externalAgentConfig/import/completed",
  importId: string,
  hostId = "local",
): CodexEndpointEvent => ({
  kind: "notification",
  generation: 1,
  hostId,
  value: { protocol: "generated", method, params: { importId, itemTypeResults: [] } },
});

const makeGateway = (
  events: Stream.Stream<CodexEndpointEvent>,
  request: () => Effect.Effect<{ readonly importId: string }>,
): CodexGateway["Service"] =>
  CodexGateway.of({
    localHostId: "local",
    events,
    requestLocal: ((_method: string, _params: unknown) =>
      request()) as CodexGateway["Service"]["requestLocal"],
  } as CodexGateway["Service"]);

it.effect("buffers completion that arrives before the import response", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<CodexEndpointEvent>();
    const runtime = yield* make().pipe(
      Effect.provideService(
        CodexGateway,
        makeGateway(Stream.fromPubSub(events), () =>
          PubSub.publish(
            events,
            notification("externalAgentConfig/import/completed", "remote", "ssh"),
          ).pipe(
            Effect.andThen(
              PubSub.publish(
                events,
                notification("externalAgentConfig/import/progress", "import-1"),
              ),
            ),
            Effect.andThen(
              PubSub.publish(
                events,
                notification("externalAgentConfig/import/completed", "import-1"),
              ),
            ),
            Effect.as({ importId: "import-1" }),
          ),
        ),
      ),
    );

    const completed = yield* runtime.run([]);
    assert.strictEqual(completed.importId, "import-1");
  }),
);

it.effect("serializes import admission so pre-response notifications cannot cross-talk", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<CodexEndpointEvent>();
    const firstRequested = yield* Deferred.make<void>();
    const secondRequested = yield* Deferred.make<void>();
    let requestCount = 0;
    const runtime = yield* make().pipe(
      Effect.provideService(
        CodexGateway,
        makeGateway(Stream.fromPubSub(events), () => {
          requestCount += 1;
          return Deferred.succeed(
            requestCount === 1 ? firstRequested : secondRequested,
            undefined,
          ).pipe(Effect.as({ importId: `import-${requestCount}` }));
        }),
      ),
    );
    const first = yield* Effect.forkChild(runtime.run([]));
    yield* Deferred.await(firstRequested);
    const second = yield* Effect.forkChild(runtime.run([]));
    yield* Effect.yieldNow;
    assert.strictEqual(requestCount, 1);

    yield* PubSub.publish(events, notification("externalAgentConfig/import/completed", "import-1"));
    yield* Fiber.join(first);
    yield* Deferred.await(secondRequested);
    assert.strictEqual(requestCount, 2);
    yield* PubSub.publish(events, notification("externalAgentConfig/import/completed", "import-2"));
    yield* Fiber.join(second);
  }),
);

it.effect("uses the Effect clock for the sole completion deadline", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<CodexEndpointEvent>();
    const runtime = yield* make({ timeout: "2 seconds" }).pipe(
      Effect.provideService(
        CodexGateway,
        makeGateway(Stream.fromPubSub(events), () =>
          Effect.succeed({ importId: "import-timeout" }),
        ),
      ),
    );
    const timedOut = yield* Effect.forkChild(runtime.run([]).pipe(Effect.flip));
    yield* TestClock.adjust("1999 millis");
    yield* TestClock.adjust("1 millis");
    const error = yield* Fiber.join(timedOut);
    assert.strictEqual(error.reason, "timeout");
    assert.strictEqual(error.message, "Timed out waiting for Claude Code import to finish");
  }),
);

it.effect("interrupts an active import when the Main Scope closes", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const events = yield* PubSub.unbounded<CodexEndpointEvent>();
    const requested = yield* Deferred.make<void>();
    const runtime = yield* make().pipe(
      Effect.provideService(
        CodexGateway,
        makeGateway(Stream.fromPubSub(events), () =>
          Deferred.succeed(requested, undefined).pipe(Effect.as({ importId: "import-closing" })),
        ),
      ),
      Effect.provideService(Scope.Scope, scope),
    );
    const closed = yield* Effect.forkChild(runtime.run([]).pipe(Effect.flip));
    yield* Deferred.await(requested);
    yield* Scope.close(scope, Exit.void);
    assert.strictEqual((yield* Fiber.join(closed)).reason, "runtime-closed");
  }),
);
