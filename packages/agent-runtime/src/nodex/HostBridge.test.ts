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
import { expect, it } from "@effect/vitest";
import * as ExecutionHost from "@t3tools/provider-core/server/ExecutionHost";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
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
      output: { instructions: "Use the admitted Page context." },
    });
    expect(yield* Fiber.join(pending)).toEqual({ instructions: "Use the admitted Page context." });
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
