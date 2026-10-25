import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as Exit from "effect/Exit";
import { AcpRegistryOperationError } from "@t3tools/contracts";
import { makeOperations, validateProviderMutation } from "./AcpManagement.ts";
import type { AgentAcpOperation } from "./AcpManagementContract.ts";
import { decodeAgentAcpFailure } from "./AcpFailureContract.ts";

const operation = (
  id: string,
): Omit<AgentAcpOperation, "runtimeGeneration" | "revision" | "cancellable"> => ({
  operationId: id,
  kind: "connect",
  configurationRevision: 7,
  phase: "running",
  instanceId: "agent",
  agentId: null,
  result: null,
  error: null,
});

it.effect(
  "publishes captured provenance and monotonic revisions through progress and completion",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeOperations("runtime-captured");
      const result = yield* Deferred.make<AgentAcpOperation["result"]>();
      const started = yield* owner.start(operation("tracked"), "tracked", Deferred.await(result));
      expect(started).toMatchObject({
        runtimeGeneration: "runtime-captured",
        configurationRevision: 7,
        revision: 1,
        cancellable: true,
        phase: "running",
      });
      yield* owner.progress("tracked", {
        phase: "downloading",
        downloadedBytes: 16,
        totalBytes: 32,
      });
      const progressed = yield* owner.read("tracked");
      expect(progressed.revision).toBe(2);
      expect(progressed.progress?.downloadedBytes).toBe(16);
      expect(yield* owner.start(operation("duplicate"), "tracked", Effect.never)).toEqual(
        progressed,
      );
      yield* Deferred.succeed(result, null);
      yield* TestClock.adjust("1 millis");
      const completed = yield* owner.read("tracked");
      expect(completed).toMatchObject({
        runtimeGeneration: "runtime-captured",
        configurationRevision: 7,
        revision: 3,
        cancellable: false,
        phase: "succeeded",
      });
      yield* owner.progress("tracked", {
        phase: "installing",
        downloadedBytes: 32,
        totalBytes: 32,
      });
      expect(yield* owner.cancel("tracked")).toEqual(completed);
      expect(yield* owner.read("tracked")).toEqual(completed);
    }),
);

it.effect(
  "deduplicates running operations, rejects key reuse, and closes the owned task on cancel",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeOperations("runtime-one");
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
      expect(yield* owner.cancel("one")).toMatchObject({
        phase: "cancelled",
        revision: 2,
        cancellable: false,
      });
      expect(yield* Ref.get(released)).toBe(true);
      expect((yield* owner.start(operation("one"), "same-agent", task)).phase).toBe("cancelled");
    }),
);

it.effect("records completion without retaining credentials from failures", () =>
  Effect.gen(function* () {
    const owner = yield* makeOperations("runtime-one");
    yield* owner.start(
      operation("bad"),
      "opaque-identity",
      Effect.die(new Error("PRIVATE_TOKEN=secret-value")),
    );
    yield* TestClock.adjust("1 millis");
    const failed = yield* owner.read("bad");
    expect(failed.phase).toBe("failed");
    expect(failed.cancellable).toBe(false);
    expect(failed.revision).toBe(2);
    expect(JSON.stringify(failed)).not.toContain("secret-value");
    yield* owner.start(
      { ...operation("good"), kind: "install", instanceId: null, configurationRevision: null },
      "install-agent",
      Effect.succeed({ agentId: "agent", version: "1.0.0", distribution: "npx", prepared: true }),
    );
    yield* TestClock.adjust("1 millis");
    expect(yield* owner.read("good")).toMatchObject({
      runtimeGeneration: "runtime-one",
      configurationRevision: null,
      revision: 2,
      cancellable: false,
    });
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

it.effect(
  "retains typed authentication recovery without publishing nested failures or terminal secrets",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeOperations("runtime-one");
      yield* owner.start(
        operation("auth"),
        "auth",
        Effect.fail(
          new AcpRegistryOperationError({
            reason: "authentication_failed",
            message: "SECRET_ERROR",
            cause: new Error("SECRET_CAUSE"),
            authMethods: [
              {
                id: "env",
                name: "API key",
                type: "env_var",
                description: null,
                envVarNames: ["MODEL_TOKEN"],
                link: "https://example.test/keys",
              },
              {
                id: "terminal",
                name: "Sign in",
                type: "terminal",
                description: null,
                command: "TOKEN=SECRET_COMMAND agent login",
              },
            ],
            authAction: {
              elicitationId: "browser-flow",
              url: "https://example.test/login",
              message: "Sign in",
            },
          }),
        ),
      );
      yield* TestClock.adjust("1 millis");
      const result = yield* owner.read("auth");
      expect(result.error?.reason).toBe("authentication_failed");
      expect(result.error?.authMethods?.[0]).toMatchObject({
        envVarNames: ["MODEL_TOKEN"],
        link: "https://example.test/keys",
      });
      expect(result.error?.authMethods?.[1]?.command).toBeUndefined();
      expect(result.error?.authAction?.elicitationId).toBe("browser-flow");
      expect(JSON.stringify(result)).not.toContain("SECRET_");
      expect(decodeAgentAcpFailure(JSON.parse(JSON.stringify(result.error)))).toEqual(result.error);
    }),
);

it("validates recovery data received across the runtime process boundary", () => {
  const failure = {
    reason: "busy",
    message: "Stop this work first.",
    affectedThreadIds: ["root-thread"],
    cause: "SECRET_CAUSE",
    authMethods: [
      {
        id: "login",
        name: "Sign in",
        description: null,
        type: "terminal",
        command: "SECRET_COMMAND",
      },
    ],
  };
  expect(decodeAgentAcpFailure(failure)).toEqual({
    reason: "busy",
    message: failure.message,
    affectedThreadIds: ["root-thread"],
    authMethods: [{ id: "login", name: "Sign in", description: null, type: "terminal" }],
  });
  expect(decodeAgentAcpFailure({ ...failure, reason: "invented_reason" })).toBeNull();
  expect(decodeAgentAcpFailure({ ...failure, affectedThreadIds: [42] })).toBeNull();
  expect(decodeAgentAcpFailure({ ...failure, authMethods: [{ id: "incomplete" }] })).toBeNull();
  expect(
    decodeAgentAcpFailure({ ...failure, authAction: { url: "https://example.test/login" } }),
  ).toBeNull();
});
