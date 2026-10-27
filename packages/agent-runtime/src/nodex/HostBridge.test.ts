import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as ExecutionHost from "@t3tools/provider-core/server/ExecutionHost";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Environment from "../environment/ServerEnvironment.ts";
import { make } from "./HostBridge.ts";
import type { AgentHostRequest } from "./Interface.ts";

const turn: ExecutionHost.HostTurnIdentity = {
  projectId: ProjectId.make("project:test"),
  threadId: ThreadId.make("thread:test"),
  runId: RunId.make("run:test"),
  attemptId: RunAttemptId.make("attempt:test"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: ProviderSessionId.make("session:test"),
  providerThreadId: ProviderThreadId.make("provider-thread:test"),
  nativeGeneration: 2,
  nativeThreadRef: null,
  cwd: "/workspace",
};
const identity = Layer.succeed(Environment.ServerEnvironmentIdentity, {
  getEnvironmentId: Effect.succeed(EnvironmentId.make("runtime:test")),
});

it.live(
  "waits for exact native registration, distinguishes reused call IDs and retires the incarnation",
  () =>
    Effect.gen(function* () {
      const bridge = yield* make(
        { home: "/runtime", cwd: "/workspace", providers: {} },
        () => Effect.void,
      );
      const nativeScope = yield* Scope.make();
      yield* bridge
        .registerNativeSession({
          credentialId: "credential:test",
          providerSessionId: turn.providerSessionId,
          nativeGeneration: turn.nativeGeneration,
        })
        .pipe(Effect.provideService(Scope.Scope, nativeScope));
      const call = {
        threadId: turn.threadId,
        providerSessionId: turn.providerSessionId,
        nativeGeneration: turn.nativeGeneration,
        nativeCallId: "reused",
        nativeThreadId: "child",
        nativeTurnId: "turn:a",
      };
      const waiting = yield* bridge.awaitNativeCallById(call).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* bridge.captureNativeToolCall({
        identity: turn,
        nativeCallId: call.nativeCallId,
        nativeThreadId: call.nativeThreadId,
        nativeTurnId: call.nativeTurnId,
      });
      expect((yield* Fiber.join(waiting))?.runId).toBe(turn.runId);
      const next = { ...turn, runId: RunId.make("run:next") };
      yield* bridge.captureNativeToolCall({
        identity: next,
        nativeCallId: call.nativeCallId,
        nativeThreadId: call.nativeThreadId,
        nativeTurnId: "turn:b",
      });
      expect((yield* bridge.resolveNativeCallById(call))?.runId).toBe(turn.runId);
      expect(
        (yield* bridge.resolveNativeCallById({ ...call, nativeTurnId: "turn:b" }))?.runId,
      ).toBe(next.runId);
      const { nativeTurnId: _turnId, ...ambiguous } = call;
      expect(yield* bridge.resolveNativeCallById(ambiguous)).toBeUndefined();
      const retired = yield* bridge
        .awaitNativeCallById({ ...call, nativeCallId: "never-registered" })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Scope.close(nativeScope, Exit.void);
      expect(yield* Fiber.join(retired)).toBeUndefined();
      expect(yield* bridge.resolveNativeCallById(call)).toBeUndefined();
    }).pipe(Effect.provide(identity), Effect.provide(NodeServices.layer)),
);

it.live("awaits the host, forwards exact identity and admits only the accepted Turn", () =>
  Effect.gen(function* () {
    const emitted = yield* Deferred.make<AgentHostRequest>();
    const bridge = yield* make(
      { home: "/runtime", cwd: "/workspace", providers: {}, host: { tools: [] } },
      (notification) =>
        notification.type === "host.request"
          ? Deferred.succeed(emitted, notification).pipe(Effect.asVoid)
          : Effect.void,
    );
    const pending = yield* bridge.prepareTurn(turn).pipe(Effect.forkChild);
    const request = yield* Deferred.await(emitted);
    expect(request.operation).toBe("turn.prepare");
    expect(request.identity).toMatchObject({ ...turn, runtimeId: "runtime:test" });
    expect(request.identity.runtimeGeneration).toBeTruthy();
    expect(yield* bridge.preparedTurn(turn.threadId)).toBeUndefined();
    expect(
      yield* bridge.accept({ type: "host.result", id: "unrelated", success: true, output: {} }),
    ).toBe(false);
    yield* bridge.accept({
      type: "host.result",
      id: request.id,
      success: true,
      output: {
        instructions: "Use the admitted Page context.",
        sourceRoots: ["/project/frontend", "/project/backend"],
      },
    });
    expect(yield* Fiber.join(pending)).toMatchObject({
      instructions: "Use the admitted Page context.",
      sourceRoots: ["/project/frontend", "/project/backend"],
      identity: turn,
    });
    expect(yield* bridge.preparedTurn(turn.threadId)).toEqual(request.identity);
  }).pipe(Effect.provide(identity), Effect.provide(NodeServices.layer)),
);

it.live("keeps a refused host Turn out of the admitted registry", () =>
  Effect.gen(function* () {
    const emitted = yield* Deferred.make<AgentHostRequest>();
    const bridge = yield* make(
      { home: "/runtime", cwd: "/workspace", providers: {}, host: { tools: [] } },
      (notification) =>
        notification.type === "host.request"
          ? Deferred.succeed(emitted, notification).pipe(Effect.asVoid)
          : Effect.void,
    );
    const pending = yield* bridge.prepareTurn(turn).pipe(Effect.result, Effect.forkChild);
    const request = yield* Deferred.await(emitted);
    yield* bridge.accept({
      type: "host.result",
      id: request.id,
      success: false,
      error: { message: "Core refused this actor." },
    });
    const result = yield* Fiber.join(pending);
    expect(result._tag).toBe("Failure");
    expect(yield* bridge.preparedTurn(turn.threadId)).toBeUndefined();
  }).pipe(Effect.provide(identity), Effect.provide(NodeServices.layer)),
);

it.live("borrows provider credentials without minting foreground tool authority", () =>
  Effect.gen(function* () {
    const emitted = yield* Deferred.make<AgentHostRequest>();
    const bridge = yield* make(
      { home: "/runtime", cwd: "/workspace", providers: {}, host: { tools: [] } },
      (notification) =>
        notification.type === "host.request"
          ? Deferred.succeed(emitted, notification).pipe(Effect.asVoid)
          : Effect.void,
    );
    const pending = yield* bridge
      .readProviderAuth({
        providerInstanceId: turn.providerInstanceId,
        refresh: true,
        previousAccountId: "account",
      })
      .pipe(Effect.forkChild);
    const request = yield* Deferred.await(emitted);
    expect(request.operation).toBe("provider.auth");
    if (request.operation !== "provider.auth") return assert.fail("expected provider auth request");
    expect(request.identity).toEqual({
      runtimeId: bridge.runtimeId,
      runtimeGeneration: bridge.runtimeGeneration,
      providerInstanceId: turn.providerInstanceId,
    });
    expect(request.previousAccountId).toBe("account");
    yield* bridge.accept({
      type: "host.result",
      id: request.id,
      success: true,
      output: {
        kind: "chatgpt",
        accessToken: "fixture-token",
        accountId: "account",
        planType: null,
      },
    });
    expect(yield* Fiber.join(pending)).toEqual({
      kind: "chatgpt",
      accessToken: "fixture-token",
      accountId: "account",
      planType: null,
    });
    expect(yield* bridge.preparedTurn(turn.threadId)).toBeUndefined();
  }).pipe(Effect.provide(identity), Effect.provide(NodeServices.layer)),
);
