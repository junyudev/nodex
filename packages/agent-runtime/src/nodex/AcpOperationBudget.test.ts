import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { makeOperations } from "./AcpManagement.ts";
import type { AgentAcpOperation } from "./AcpManagementContract.ts";

const operation = (
  operationId: string,
): Omit<AgentAcpOperation, "runtimeGeneration" | "revision" | "cancellable"> => ({
  operationId,
  kind: "connect",
  configurationRevision: 7,
  phase: "running",
  instanceId: operationId,
  agentId: null,
  result: null,
  error: null,
});

it.effect(
  "bounds active ACP work and releases every cancelled operation before accepting replacements",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeOperations("runtime-one");
      const live = yield* Ref.make(0);
      for (let index = 0; index < 8; index++) {
        const started = yield* Deferred.make<void>();
        const task = Ref.update(live, (value) => value + 1).pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.andThen(Effect.never),
          Effect.ensuring(Ref.update(live, (value) => value - 1)),
        );
        yield* owner.start(operation(String(index)), String(index), task);
        yield* Deferred.await(started);
      }
      expect(yield* owner.active).toBe(8);
      expect(yield* Ref.get(live)).toBe(8);
      expect(
        Exit.isFailure(
          yield* owner.start(operation("overflow"), "overflow", Effect.never).pipe(Effect.exit),
        ),
      ).toBe(true);
      for (let index = 0; index < 8; index++) yield* owner.cancel(String(index));
      expect(yield* owner.active).toBe(0);
      expect(yield* Ref.get(live)).toBe(0);
      for (let index = 8; index < 80; index++) {
        yield* owner.start(operation(String(index)), String(index), Effect.succeed(null));
        yield* TestClock.adjust("1 millis");
      }
      expect(yield* owner.active).toBe(0);
      expect((yield* owner.read("79")).phase).toBe("succeeded");
      expect((yield* owner.read("0").pipe(Effect.flip)).reason).toBe("operation_expired");
    }),
);
