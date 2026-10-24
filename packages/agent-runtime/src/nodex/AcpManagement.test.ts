import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as Exit from "effect/Exit";
import { makeOperations, validateProviderMutation } from "./AcpManagement.ts";
import type { AgentAcpOperation } from "./AcpManagementContract.ts";

const operation = (id: string): AgentAcpOperation => ({
  operationId: id,
  kind: "connect",
  phase: "running",
  instanceId: "agent",
  agentId: null,
  result: null,
  error: null,
});

it.effect(
  "deduplicates running operations, rejects key reuse, and closes the owned task on cancel",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeOperations;
      const started = yield* Deferred.make<void>();
      const released = yield* Ref.make(false);
      const task = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Ref.set(released, true)),
      );
      expect((yield* owner.start(operation("one"), "same-agent", task)).phase).toBe("running");
      yield* Deferred.await(started);
      expect((yield* owner.start(operation("two"), "same-agent", task)).operationId).toBe("one");
      expect(
        Exit.isFailure(
          yield* owner.start(operation("one"), "different-agent", task).pipe(Effect.exit),
        ),
      ).toBe(true);
      expect((yield* owner.cancel("one")).phase).toBe("cancelled");
      expect(yield* Ref.get(released)).toBe(true);
      expect((yield* owner.start(operation("one"), "same-agent", task)).phase).toBe("cancelled");
    }),
);

it.effect("records completion without retaining credentials from failures", () =>
  Effect.gen(function* () {
    const owner = yield* makeOperations;
    yield* owner.start(
      operation("bad"),
      "opaque-identity",
      Effect.die(new Error("PRIVATE_TOKEN=secret-value")),
    );
    yield* TestClock.adjust("1 millis");
    const failed = yield* owner.read("bad");
    expect(failed.phase).toBe("failed");
    expect(JSON.stringify(failed)).not.toContain("secret-value");
    yield* owner.start(
      { ...operation("good"), kind: "install" },
      "install-agent",
      Effect.succeed({ agentId: "agent", version: "1.0.0", distribution: "npx", prepared: true }),
    );
    yield* TestClock.adjust("1 millis");
    expect((yield* owner.read("good")).result).toEqual({
      agentId: "agent",
      version: "1.0.0",
      distribution: "npx",
      prepared: true,
    });
  }),
);

it.effect("enforces required providers and advertised API types before any write", () =>
  Effect.gen(function* () {
    const providers = [
      { providerId: "required", supported: ["openai"], required: true, current: null },
    ];
    expect(
      Exit.isFailure(
        yield* validateProviderMutation(providers, { providerId: "required" }, true).pipe(
          Effect.exit,
        ),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        yield* validateProviderMutation(
          providers,
          { providerId: "required", apiType: "anthropic" },
          false,
        ).pipe(Effect.exit),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        yield* validateProviderMutation(
          providers,
          { providerId: "missing", apiType: "openai" },
          false,
        ).pipe(Effect.exit),
      ),
    ).toBe(true);
    yield* validateProviderMutation(
      providers,
      { providerId: "required", apiType: "openai" },
      false,
    );
  }),
);
