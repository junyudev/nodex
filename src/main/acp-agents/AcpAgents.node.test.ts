import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import { AcpInputSchemas } from "../../shared/schemas/acp-api";
import { make } from "./AcpAgents";
import { AgentRuntimeSupervisor } from "../agent-runtime/AgentRuntimeSupervisor";
import { AgentRuntimeProviderConfiguration } from "../agent-runtime/AgentRuntimeProviderConfiguration";
import {
  ApplicationSettings,
  type ApplicationSettingsSnapshot,
} from "../settings/ApplicationSettings";
import { makeTestApplicationSettings } from "../settings/ApplicationSettings.test-support";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { testLayer } from "../app/MainConfig";

const setup = Effect.gen(function* () {
  const authenticationStarted = yield* Deferred.make<void>();
  const authenticationRelease = yield* Deferred.make<void>();
  const cancellationStarted = yield* Deferred.make<void>();
  const cancellationRelease = yield* Deferred.make<void>();
  const authenticationReadStarted = yield* Deferred.make<void>();
  const authenticationReadRelease = yield* Deferred.make<void>();
  const calls: { method: string; input: Record<string, unknown> }[] = [];
  const state = {
    rejectOperations: false,
    flowId: "flow",
    pauseAuthentication: false,
    pauseCancellation: false,
    pauseAuthenticationRead: false,
    rejectAuthenticationRead: false,
    instanceIds: ["personal", "work"],
    operationPhase: "running",
    authenticationPhase: "waiting",
    connected: true,
    revision: "one",
    generation: "generation-one",
    enabled: true,
    secret: "first-secret",
    coalescedOperation: "",
    failure: null as import("@nodex/agent-runtime/contracts").AgentAcpFailure | null,
  };
  const request = (method: string, input: Record<string, unknown>) =>
    Effect.sync(() => {
      calls.push({ method, input });
      if (method.startsWith("acp.auth."))
        return {
          instanceId: input.instanceId,
          phase: state.authenticationPhase,
          flowId: state.flowId,
          authorizationUrl: null,
          expiresAt: null,
          message: null,
        };
      if (method === "acp.sessions.list")
        return { sessions: [], nextCursor: null, canLoad: true, canResume: false, canDelete: true };
      return {
        operationId: state.coalescedOperation || input.operationId,
        kind: method === "acp.install.start" ? "install" : "connect",
        phase: state.operationPhase,
        instanceId: input.instanceId ?? null,
        agentId: input.agentId ?? null,
        result: null,
        error: state.failure,
      };
    }).pipe(
      Effect.tap(() =>
        state.rejectOperations && ["acp.install.start", "acp.connection.start"].includes(method)
          ? Effect.fail(new Error("Rejected start"))
          : Effect.void,
      ),
      Effect.tap(() =>
        method === "acp.auth.start" && state.pauseAuthentication
          ? Deferred.succeed(authenticationStarted, undefined).pipe(
              Effect.andThen(Deferred.await(authenticationRelease)),
            )
          : Effect.void,
      ),
      Effect.tap(() =>
        method === "acp.auth.cancel" && state.pauseCancellation
          ? Deferred.succeed(cancellationStarted, undefined).pipe(
              Effect.andThen(Deferred.await(cancellationRelease)),
            )
          : Effect.void,
      ),
      Effect.tap(() =>
        method === "acp.auth.read" && state.pauseAuthenticationRead
          ? Deferred.succeed(authenticationReadStarted, undefined).pipe(
              Effect.andThen(Deferred.await(authenticationReadRelease)),
            )
          : Effect.void,
      ),
      Effect.tap(() =>
        method === "acp.auth.read" && state.rejectAuthenticationRead
          ? Effect.fail(new Error("Agent instance was removed"))
          : Effect.void,
      ),
    );
  const process = () => ({ identity: { runtimeGeneration: state.generation }, request });
  const agents = yield* make.pipe(
    Effect.provideService(AgentRuntimeApplication, {
      sessionsForThreads: (threadIds: readonly string[]) =>
        Effect.succeed(
          threadIds
            .filter((id) => id === "root")
            .map((threadId) => ({ sessionId: "chat", threadId })),
        ),
    } as unknown as AgentRuntimeApplication["Service"]),
    Effect.provideService(AgentRuntimeSupervisor, {
      get: () => Effect.sync(process),
      currentConnection: Effect.sync(() => (state.connected ? process() : null)),
      request,
    } as unknown as AgentRuntimeSupervisor["Service"]),
    Effect.provideService(ApplicationSettings, {
      ...makeTestApplicationSettings(),
      acpLaunchConfiguration: () =>
        Effect.succeed({
          instance: {
            id: "personal",
            agentDefinitionId: "qoder",
            enabled: state.enabled,
          },
          environment: { API_KEY: state.secret },
        } as never),
      snapshot: () =>
        Effect.succeed({
          revision: state.revision,
          acpAgents: {
            instances: state.instanceIds.map((id) => ({
              id,
              agentDefinitionId: "qoder",
              enabled: state.enabled,
            })),
          },
        } as ApplicationSettingsSnapshot),
    }),
    Effect.provideService(AgentRuntimeProviderConfiguration, {
      refresh: Effect.succeed({ applied: true, deferredInstanceIds: [] }),
    }),
    Effect.provideService(ProjectWorkspace, {
      getProject: (id: string) =>
        Effect.succeed(
          id === "active"
            ? { lifecycle: "active", primaryWorkspaceRoot: "/canonical/project" }
            : null,
        ),
    } as unknown as ProjectWorkspace["Service"]),
    Effect.provideService(FileSystem.FileSystem, {
      makeDirectory: () => Effect.void,
    } as unknown as FileSystem.FileSystem),
    Effect.provide(testLayer()),
  );
  return {
    agents,
    calls,
    state,
    authenticationStarted,
    authenticationRelease,
    cancellationStarted,
    cancellationRelease,
    authenticationReadStarted,
    authenticationReadRelease,
  };
});
it.effect(
  "resolves public instance and Project identities before sending management requests",
  () =>
    Effect.gen(function* () {
      const { agents, calls } = yield* setup;
      yield* agents["acp.sessions.list"]("window", { instanceId: "personal", projectId: "active" });
      assert.equal(calls[0]?.input.cwd, "/canonical/project");
      assert.notEqual(calls[0]?.input.instanceId, "personal");
      const result = yield* Effect.result(
        agents["acp.sessions.list"]("window", { instanceId: "personal", projectId: "missing" }),
      );
      assert.equal(result._tag, "Failure");
      assert.equal(calls.length, 1);
    }),
);
it.effect(
  "rejects another window's credentials and stale flow input after configuration changes",
  () =>
    Effect.gen(function* () {
      const { agents, calls, state } = yield* setup;
      yield* agents["acp.auth.start"]("owner", { instanceId: "personal" });
      const input = {
        instanceId: "personal",
        flowId: "flow",
        interactionId: "terminal",
        response: { type: "terminal" as const, data: "secret" },
      };
      assert.equal(
        (yield* Effect.result(agents["acp.auth.respond"]("other", input)))._tag,
        "Failure",
      );
      assert.isFalse(calls.some(({ method }) => method === "acp.auth.respond"));
      state.secret = "changed-secret";
      assert.equal(
        (yield* Effect.result(agents["acp.auth.respond"]("owner", input)))._tag,
        "Failure",
      );
      assert.isTrue(calls.some(({ method }) => method === "acp.auth.cancel"));
      assert.isFalse(calls.some(({ method }) => method === "acp.auth.respond"));
    }),
);
it.effect("keeps sign-in active when unrelated application settings change", () =>
  Effect.gen(function* () {
    const { agents, calls, state } = yield* setup;
    yield* agents["acp.auth.start"]("owner", { instanceId: "personal" });
    state.revision = "unrelated-notification-change";
    yield* agents["acp.auth.respond"]("owner", {
      instanceId: "personal",
      flowId: "flow",
      interactionId: "terminal",
      response: { type: "terminal", data: "answer" },
    });
    assert.isTrue(calls.some(({ method }) => method === "acp.auth.respond"));
    assert.isFalse(calls.some(({ method }) => method === "acp.auth.cancel"));
  }),
);
it.effect("reads and cancels a coalesced installation through each window's operation", () =>
  Effect.gen(function* () {
    const { agents, calls, state } = yield* setup;
    const first = yield* agents["acp.install.start"]("first-window", {
      operationId: "first-install",
      agentId: "qoder",
    });
    state.coalescedOperation = String(calls[0]?.input.operationId);
    const second = yield* agents["acp.install.start"]("second-window", {
      operationId: "second-install",
      agentId: "qoder",
    });
    assert.equal(first.operationId, "first-install");
    assert.equal(second.operationId, "second-install");
    yield* agents["acp.operation.read"]("second-window", { operationId: "second-install" });
    yield* agents["acp.operation.cancel"]("second-window", { operationId: "second-install" });
    assert.deepEqual(
      calls.slice(2).map(({ input }) => input.operationId),
      [state.coalescedOperation, state.coalescedOperation],
    );
  }),
);
it.effect("does not replay terminal input across Runtime generations", () =>
  Effect.gen(function* () {
    const { agents, calls, state } = yield* setup;
    yield* agents["acp.auth.start"]("owner", { instanceId: "personal" });
    state.generation = "new";
    assert.equal(
      (yield* Effect.result(
        agents["acp.auth.respond"]("owner", {
          instanceId: "personal",
          flowId: "flow",
          interactionId: "terminal",
          response: { type: "terminal", data: "key" },
        }),
      ))._tag,
      "Failure",
    );
    assert.equal(calls.length, 1);
  }),
);
it.effect("window disposal cancels only owned authentication while installation continues", () =>
  Effect.gen(function* () {
    const { agents, calls } = yield* setup;
    yield* agents["acp.auth.start"]("owner", { instanceId: "personal" });
    yield* agents["acp.install.start"]("owner", { operationId: "install", agentId: "qoder" });
    yield* agents.releaseOwner("owner");
    assert.equal(calls.filter(({ method }) => method === "acp.auth.cancel").length, 1);
    assert.isFalse(calls.some(({ method }) => method === "acp.operation.cancel"));
    assert.equal(
      (yield* Effect.result(agents["acp.operation.read"]("other", { operationId: "install" })))
        ._tag,
      "Failure",
    );
  }),
);
it("rejects caller-injected owners, launch configuration and working directories", () => {
  for (const extra of [
    { ownerId: "other" },
    { cwd: "/attacker" },
    { executable: "sh" },
    { environment: { API_KEY: "key" } },
  ])
    assert.isFalse(
      AcpInputSchemas["acp.connection.start"].safeParse({
        instanceId: "personal",
        operationId: "connect",
        ...extra,
      }).success,
    );
});

it.effect("maps asynchronous busy failures to existing Nodex conversations", () =>
  Effect.gen(function* () {
    const { agents, state } = yield* setup;
    yield* agents["acp.connection.start"]("window", {
      instanceId: "personal",
      operationId: "probe",
    });
    state.failure = {
      reason: "busy",
      message: "Stop active work first.",
      affectedThreadIds: ["root"],
    };
    const operation = yield* agents["acp.operation.read"]("window", { operationId: "probe" });
    assert.deepEqual(operation.error, {
      ...state.failure,
      affectedSessions: [{ sessionId: "chat", threadId: "root" }],
    });
  }),
);

it.effect("cancels authentication that returns after its window closes", () =>
  Effect.gen(function* () {
    const { agents, calls, state, authenticationStarted, authenticationRelease } = yield* setup;
    state.pauseAuthentication = true;
    const starting = yield* Effect.forkChild(
      Effect.result(agents["acp.auth.start"]("owner", { instanceId: "personal" })),
    );
    yield* Deferred.await(authenticationStarted);
    yield* agents.releaseOwner("owner");
    yield* Deferred.succeed(authenticationRelease, undefined);
    assert.equal((yield* Fiber.join(starting))._tag, "Failure");
    assert.deepEqual(
      calls
        .filter(({ method }) => method === "acp.auth.cancel")
        .map(({ input }) => ({ ownerId: input.ownerId, flowId: input.flowId })),
      [{ ownerId: "owner", flowId: "flow" }],
    );
    yield* agents.releaseOwner("owner");
    assert.equal(calls.filter(({ method }) => method === "acp.auth.cancel").length, 1);
  }),
);

it.effect(
  "announces a completed installation after its window closes without renderer polling",
  () =>
    Effect.gen(function* () {
      const { agents, calls, state } = yield* setup;
      const changes: void[] = [];
      yield* agents.changes.pipe(
        Stream.runForEach(() => Effect.sync(() => changes.push(undefined))),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* agents["acp.install.start"]("window", { agentId: "qoder", operationId: "install" });
      yield* agents.releaseOwner("window");
      state.operationPhase = "succeeded";
      yield* TestClock.adjust("500 millis");
      assert.equal(changes.length, 1);
      assert.equal(calls.filter(({ method }) => method === "acp.operation.read").length, 1);
      yield* agents["acp.operation.read"]("window", { operationId: "install" });
      yield* TestClock.adjust("1 second");
      assert.equal(changes.length, 1);
    }),
);
it.effect(
  "does not announce failed, cancelled or obsolete-generation operations as completed",
  () =>
    Effect.gen(function* () {
      for (const outcome of ["failed", "cancelled", "generation", "disconnected"]) {
        const { agents, calls, state } = yield* setup;
        const changes: void[] = [];
        yield* agents.changes.pipe(
          Stream.runForEach(() => Effect.sync(() => changes.push(undefined))),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* agents["acp.install.start"]("window", { agentId: "qoder", operationId: "install" });
        if (outcome === "generation") state.generation = "replacement";
        else if (outcome === "disconnected") state.connected = false;
        else state.operationPhase = outcome;
        yield* TestClock.adjust("1 second");
        assert.equal(changes.length, 0);
        assert.equal(
          calls.filter(({ method }) => method === "acp.operation.read").length,
          ["generation", "disconnected"].includes(outcome) ? 0 : 1,
        );
      }
    }),
);
it.effect("announces authentication completion without an observing settings modal", () =>
  Effect.gen(function* () {
    const { agents, state } = yield* setup;
    let changes = 0;
    yield* agents.changes.pipe(
      Stream.runForEach(() =>
        Effect.sync(() => {
          changes += 1;
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* agents["acp.auth.start"]("window", { instanceId: "personal" });
    state.authenticationPhase = "succeeded";
    yield* TestClock.adjust("500 millis");
    assert.equal(changes, 1);
    yield* TestClock.adjust("1 second");
    assert.equal(changes, 1);
  }),
);

it.effect("rejects delayed responses to an older sign-in without cancelling the current flow", () =>
  Effect.gen(function* () {
    const { agents, calls, state } = yield* setup;
    state.flowId = "flow-a";
    yield* agents["acp.auth.start"]("window", { instanceId: "personal" });
    state.flowId = "flow-b";
    yield* agents["acp.auth.start"]("window", { instanceId: "personal" });
    const stale = { instanceId: "personal", flowId: "flow-a" };
    for (const operation of [
      agents["acp.auth.respond"]("window", {
        ...stale,
        interactionId: "terminal",
        response: { type: "terminal", data: "old" },
      }),
      agents["acp.auth.complete"]("window", {
        ...stale,
        callbackUrl: "https://callback.example.test/return",
      }),
      agents["acp.auth.cancel"]("window", stale),
    ]) {
      const result = yield* Effect.result(operation);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure")
        assert.propertyVal(result.failure, "reason", "operation_expired");
    }
    assert.equal(calls.filter(({ method }) => method === "acp.auth.cancel").length, 0);
    yield* agents["acp.auth.respond"]("window", {
      instanceId: "personal",
      flowId: "flow-b",
      interactionId: "terminal",
      response: { type: "terminal", data: "current" },
    });
    assert.equal(calls.filter(({ method }) => method === "acp.auth.respond").length, 1);
    assert.equal(calls.at(-1)?.input.flowId, "flow-b");
  }),
);

it.effect.each(["cancel", "configuration-change"] as const)(
  "preserves a new sign-in when the previous flow's %s cancellation returns late",
  (reason) =>
    Effect.gen(function* () {
      const { agents, calls, state, cancellationStarted, cancellationRelease } = yield* setup;
      state.flowId = "flow-a";
      yield* agents["acp.auth.start"]("window", { instanceId: "personal" });
      state.pauseCancellation = true;
      if (reason === "configuration-change") state.secret = "new-secret";
      const cancelling = yield* Effect.forkChild(
        Effect.result(
          reason === "cancel"
            ? agents["acp.auth.cancel"]("window", {
                instanceId: "personal",
                flowId: "flow-a",
              })
            : agents["acp.auth.respond"]("window", {
                instanceId: "personal",
                flowId: "flow-a",
                interactionId: "terminal",
                response: { type: "terminal", data: "old" },
              }),
        ),
      );
      yield* Deferred.await(cancellationStarted);
      state.flowId = "flow-b";
      yield* agents["acp.auth.start"]("window", { instanceId: "personal" });
      yield* Deferred.succeed(cancellationRelease, undefined);
      assert.equal(
        (yield* Fiber.join(cancelling))._tag,
        reason === "cancel" ? "Success" : "Failure",
      );
      yield* agents["acp.auth.respond"]("window", {
        instanceId: "personal",
        flowId: "flow-b",
        interactionId: "terminal",
        response: { type: "terminal", data: "current" },
      });
      assert.deepEqual(
        calls
          .filter(({ method }) => method === "acp.auth.cancel")
          .map(({ input }) => input.flowId),
        ["flow-a"],
      );
      assert.equal(calls.at(-1)?.method, "acp.auth.respond");
      assert.equal(calls.at(-1)?.input.flowId, "flow-b");
    }),
);

it.effect("does not retain completed sign-ins after repeatedly removing their instances", () =>
  Effect.gen(function* () {
    const { agents, calls, state } = yield* setup;
    for (let index = 0; index < 100; index += 1) {
      const instanceId = `instance-${index}`;
      state.instanceIds = [instanceId];
      state.flowId = `flow-${index}`;
      state.authenticationPhase = index % 2 === 0 ? "succeeded" : "failed";
      yield* agents["acp.auth.start"]("window", { instanceId });
      state.instanceIds = [];
    }
    yield* agents.releaseOwner("window");
    assert.equal(calls.filter(({ method }) => method === "acp.auth.cancel").length, 0);
  }),
);

it.effect.each(["succeeded", "failed", "cancelled", "removed", "generation"])(
  "releases an observed sign-in after it becomes %s",
  (outcome) =>
    Effect.gen(function* () {
      const { agents, calls, state } = yield* setup;
      yield* agents["acp.auth.start"]("window", { instanceId: "personal" });
      if (outcome === "removed") {
        state.instanceIds = [];
        state.rejectAuthenticationRead = true;
      } else if (outcome === "generation") state.generation = "replacement";
      else state.authenticationPhase = outcome;
      yield* TestClock.adjust("500 millis");
      if (["succeeded", "failed", "cancelled"].includes(outcome)) {
        state.secret = "changed-after-completion";
        const current = yield* agents["acp.auth.read"]("window", { instanceId: "personal" });
        assert.equal(current.phase, outcome);
      }
      state.generation = "generation-one";
      yield* agents.releaseOwner("window");
      assert.equal(calls.filter(({ method }) => method === "acp.auth.cancel").length, 0);
    }),
);

it.effect("keeps a new sign-in when the previous observer returns a late terminal state", () =>
  Effect.gen(function* () {
    const { agents, calls, state, authenticationReadStarted, authenticationReadRelease } =
      yield* setup;
    state.flowId = "flow-a";
    yield* agents["acp.auth.start"]("window", { instanceId: "personal" });
    state.pauseAuthenticationRead = true;
    state.authenticationPhase = "succeeded";
    const ticking = yield* Effect.forkChild(TestClock.adjust("500 millis"));
    yield* Deferred.await(authenticationReadStarted);
    state.flowId = "flow-b";
    state.authenticationPhase = "waiting";
    yield* agents["acp.auth.start"]("window", { instanceId: "personal" });
    yield* Deferred.succeed(authenticationReadRelease, undefined);
    yield* Fiber.join(ticking);
    yield* agents["acp.auth.respond"]("window", {
      instanceId: "personal",
      flowId: "flow-b",
      interactionId: "terminal",
      response: { type: "terminal", data: "current" },
    });
    assert.equal(calls.at(-1)?.method, "acp.auth.respond");
    assert.equal(calls.at(-1)?.input.flowId, "flow-b");
  }),
);

it.effect("keeps the accepted operation's identity when a conflicting request reuses its ID", () =>
  Effect.gen(function* () {
    const { agents, calls, state } = yield* setup;
    state.operationPhase = "succeeded";
    yield* agents["acp.connection.start"]("window", {
      instanceId: "personal",
      operationId: "probe",
    });
    const conflict = yield* Effect.result(
      agents["acp.connection.start"]("window", { instanceId: "work", operationId: "probe" }),
    );
    assert.equal(conflict._tag, "Failure");
    assert.equal(calls.filter(({ method }) => method === "acp.connection.start").length, 1);
    const read = yield* agents["acp.operation.read"]("window", { operationId: "probe" });
    const cancel = yield* agents["acp.operation.cancel"]("window", { operationId: "probe" });
    assert.equal(read.instanceId, "personal");
    assert.equal(cancel.instanceId, "personal");
    assert.equal(read.phase, "succeeded");
    assert.equal(cancel.phase, "succeeded");
    assert.equal(calls.at(-1)?.input.operationId, calls[0]?.input.operationId);
  }),
);
it.effect("releases a rejected start's operation reservation", () =>
  Effect.gen(function* () {
    const { agents, state } = yield* setup;
    state.rejectOperations = true;
    assert.equal(
      (yield* Effect.result(
        agents["acp.connection.start"]("window", { instanceId: "personal", operationId: "probe" }),
      ))._tag,
      "Failure",
    );
    state.rejectOperations = false;
    const accepted = yield* agents["acp.connection.start"]("window", {
      instanceId: "work",
      operationId: "probe",
    });
    assert.equal(accepted.instanceId, "work");
  }),
);
