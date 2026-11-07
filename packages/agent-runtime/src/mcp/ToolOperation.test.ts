import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@nodex/runtime-contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { make } from "./ToolOperation.ts";

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("test"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "credential:one",
  thread: {
    threadId: ThreadId.make("root"),
    providerSessionId: "provider:one",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
};
const args = { idempotencyKey: "06d6709c-45e7-4b37-8c26-74e9d64c5aa1", task: "Inspect" };
const layer = SqlitePersistence.layerMemory.pipe(Layer.provideMerge(NodeServices.layer));

describe("execution tool admission", () => {
  it.effect(
    "arbitrates concurrent UUID retries across credentials and rejects changed arguments",
    () =>
      Effect.gen(function* () {
        const admit = yield* make;
        const ids = yield* Effect.all(
          Array.from({ length: 8 }, () => admit(scope, "delegate_task", args.idempotencyKey, args)),
          { concurrency: "unbounded" },
        );
        expect(new Set(ids).size).toBe(1);
        const reconnect = { ...scope, requestNamespace: "credential:two", issuedAt: 1000 };
        expect(
          yield* admit(reconnect, "delegate_task", args.idempotencyKey, {
            task: "Inspect",
            idempotencyKey: args.idempotencyKey,
          }),
        ).toBe(ids[0]);
        const collision = yield* admit(scope, "delegate_task", args.idempotencyKey, {
          ...args,
          task: "Different",
        }).pipe(Effect.result);
        expect(Result.isFailure(collision) && collision.failure.code).toBe(
          "idempotency_key_reused",
        );
        expect(yield* admit(scope, "task_cancel", args.idempotencyKey, args)).not.toBe(ids[0]);
        yield* TestClock.adjust("7 days");
        expect(yield* admit(scope, "delegate_task", args.idempotencyKey, args)).not.toBe(ids[0]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect.each(["same", "different"] as const)(
    "renews an addressed expired retry beyond the cleanup batch with %s arguments",
    (payload) =>
      Effect.gen(function* () {
        const admit = yield* make;
        const expired = yield* Effect.forEach(
          Array.from({ length: 300 }, (_, index) => `expired-${index}`),
          (key) => admit(scope, "delegate_task", key, { task: "Original" }),
        );
        yield* TestClock.adjust("7 days");
        const key = "expired-299";
        const renewedArgs = { task: payload === "same" ? "Original" : "Replacement" };
        const renewed = yield* Effect.all(
          Array.from({ length: 8 }, () => admit(scope, "delegate_task", key, renewedArgs)),
          { concurrency: "unbounded" },
        );
        expect(new Set(renewed).size).toBe(1);
        expect(renewed[0]).not.toBe(expired[299]);
        expect(yield* admit(scope, "delegate_task", key, renewedArgs)).toBe(renewed[0]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("retains the first operation after reopening its execution database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const open = (namespace: string) =>
        Effect.scoped(
          Effect.gen(function* () {
            const admit = yield* make;
            return yield* admit(
              { ...scope, requestNamespace: namespace },
              "task_send",
              args.idempotencyKey,
              args,
            );
          }).pipe(Effect.provide(SqlitePersistence.layerFromPath(`${home}/execution.sqlite`))),
        );
      const first = yield* open("before");
      expect(yield* open("after")).toBe(first);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
