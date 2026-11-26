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
} from "@nodex/runtime-contracts";
import { expect, it } from "@effect/vitest";
import { NODEX_FAILURE_CODES } from "@nodex/provider-core/failureCause";
import { makeProviderFailure } from "@nodex/provider-core/server/failure";
import * as ExecutionHost from "@nodex/provider-core/server/ExecutionHost";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Environment from "../environment/ServerEnvironment.ts";
import { make } from "./HostBridge.ts";
import type { AgentHostRequest, AgentRuntimeNotification } from "./Interface.ts";

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

it.live("interrupting a host call withdraws its exact request in the same Runtime generation", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<AgentHostRequest>();
    const frames: AgentRuntimeNotification[] = [];
    const bridge = yield* make(
      { home: "/runtime", cwd: "/workspace", providers: {}, host: { tools: [] } },
      (notification) =>
        Effect.gen(function* () {
          frames.push(notification);
          if (notification.type === "host.request") yield* Deferred.succeed(started, notification);
        }),
    );
    const waiting = yield* bridge
      .callTool(
        { ...turn, runtimeId: bridge.runtimeId, runtimeGeneration: bridge.runtimeGeneration },
        "wait_sessions",
        { targets: [{ sessionId: "other" }], timeoutMs: 3_600_000 },
      )
      .pipe(Effect.forkChild);
    const request = yield* Deferred.await(started);
    yield* Fiber.interrupt(waiting);
    expect(frames.filter((frame) => frame.type === "host.cancel")).toEqual([
      {
        type: "host.cancel",
        id: request.id,
        runtimeId: bridge.runtimeId,
        runtimeGeneration: bridge.runtimeGeneration,
      },
    ]);
    // A late host reply no longer has a waiting receiver and cannot resurrect the call.
    yield* bridge.accept({ type: "host.result", id: request.id, success: true, output: {} });
  }).pipe(Effect.provide(identity), Effect.provide(NodeServices.layer)),
);
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
    const cliShell = {
      taskId: "task:test",
      profileHome: "/profile",
      bin: "/profile/cli/bin",
      skill: "/resources/skills/nodex/SKILL.md",
    };
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
        cliShell,
      },
    });
    expect(yield* Fiber.join(pending)).toMatchObject({
      instructions: "Use the admitted Page context.",
      sourceRoots: ["/project/frontend", "/project/backend"],
      cliShell,
      identity: turn,
    });
    expect(yield* bridge.preparedTurn(turn.threadId)).toEqual(request.identity);
  }).pipe(Effect.provide(identity), Effect.provide(NodeServices.layer)),
);

it.live("preserves the Claude Code refusal across Host transport without admitting the Turn", () =>
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
      error: {
        message: "Claude Code is still installing.",
        code: NODEX_FAILURE_CODES.claudeCodeUnavailable,
      },
    });
    const result = yield* Fiber.join(pending);
    if (result._tag !== "Failure") throw new Error("Expected the Host to refuse the Turn");
    expect(makeProviderFailure({ cause: result.failure })).toMatchObject({
      message: "Claude Code is still installing.",
      code: NODEX_FAILURE_CODES.claudeCodeUnavailable,
      retryable: false,
    });
    expect(yield* bridge.preparedTurn(turn.threadId)).toBeUndefined();
  }).pipe(Effect.provide(identity), Effect.provide(NodeServices.layer)),
);

const pluginBridge = Effect.fn(function* () {
  const requests: AgentHostRequest[] = [];
  let wake: Deferred.Deferred<void> | null = null;
  const bridge = yield* make(
    {
      home: "/runtime",
      cwd: "/workspace",
      providers: {},
      host: { tools: [], sessionPlugins: true },
    },
    (notification) => {
      if (notification.type !== "host.request") return Effect.void;
      requests.push(notification);
      return wake ? Deferred.succeed(wake, undefined).pipe(Effect.asVoid) : Effect.void;
    },
  );
  /** Waits for the next request of an operation the bridge sends to the Host. */
  const next = Effect.fn(function* (operation: AgentHostRequest["operation"]) {
    while (true) {
      const arrival = yield* Deferred.make<void>();
      wake = arrival;
      const found = requests.find((request) => request.operation === operation);
      if (found) {
        requests.splice(requests.indexOf(found), 1);
        return found;
      }
      yield* Deferred.await(arrival);
    }
  });
  const answer = (request: AgentHostRequest, output: unknown) =>
    bridge.accept({ type: "host.result", id: request.id, success: true, output });
  const refuse = (request: AgentHostRequest, message: string) =>
    bridge.accept({ type: "host.result", id: request.id, success: false, error: { message } });
  return { bridge, next, answer, refuse };
});

it.live("reports a Codex Session's plugin preparation error and closes the failed attachment", () =>
  Effect.gen(function* () {
    const { bridge, next, answer, refuse } = yield* pluginBridge();
    const pending = yield* Effect.scoped(
      bridge.openPlugins!({ backend: "codex", threadId: turn.threadId, projectId: null }),
    ).pipe(Effect.result, Effect.forkChild);
    const message = "Could not read the installed plugins.";
    yield* refuse(yield* next("plugins.open"), message);
    yield* answer(yield* next("plugins.close"), {});
    expect(yield* Fiber.join(pending)).toMatchObject({
      _tag: "Failure",
      failure: { operation: "plugins.open", message },
    });
  }).pipe(Effect.provide(identity), Effect.provide(NodeServices.layer)),
);

it.live("starts other Agents without plugins when the Host cannot prepare them", () =>
  Effect.gen(function* () {
    const { bridge, next, answer, refuse } = yield* pluginBridge();
    const scope = yield* Scope.make();
    const opening = yield* bridge.openPlugins!({
      backend: "claude",
      threadId: turn.threadId,
      projectId: turn.projectId,
    }).pipe(Scope.provide(scope), Effect.forkChild);
    yield* refuse(yield* next("plugins.open"), "Could not prepare the Session’s plugin Skills.");
    const attachment = yield* Fiber.join(opening);
    expect(attachment.plugins).toBeNull();
    const checking = yield* attachment.revision.pipe(Effect.forkChild);
    yield* refuse(yield* next("plugins.revision"), "The Host is unavailable.");
    expect(yield* Fiber.join(checking)).toBeNull();
    const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
    yield* answer(yield* next("plugins.close"), {});
    yield* Fiber.join(closing);
  }).pipe(Effect.provide(identity), Effect.provide(NodeServices.layer)),
);

it.live("keeps the delivered plugins when the Host cannot answer a revision check", () =>
  Effect.gen(function* () {
    const { bridge, next, answer, refuse } = yield* pluginBridge();
    const scope = yield* Scope.make();
    const opening = yield* bridge.openPlugins!({
      backend: "claude",
      threadId: turn.threadId,
      projectId: turn.projectId,
    }).pipe(Scope.provide(scope), Effect.forkChild);
    yield* answer(yield* next("plugins.open"), {
      plugins: {
        revision: "revision-a",
        skillsRoot: null,
        skills: [],
        mcpServers: [],
        pluginIds: [],
        codexDisabledPluginIds: [],
      },
    });
    const attachment = yield* Fiber.join(opening);
    const current = yield* attachment.revision.pipe(Effect.forkChild);
    yield* answer(yield* next("plugins.revision"), { revision: "revision-b" });
    expect(yield* Fiber.join(current)).toBe("revision-b");
    const unanswered = yield* attachment.revision.pipe(Effect.forkChild);
    yield* refuse(yield* next("plugins.revision"), "The Host is unavailable.");
    expect(yield* Fiber.join(unanswered)).toBe("revision-a");
    const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
    yield* answer(yield* next("plugins.close"), {});
    yield* Fiber.join(closing);
  }).pipe(Effect.provide(identity), Effect.provide(NodeServices.layer)),
);
