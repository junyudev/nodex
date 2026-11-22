import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { AcpInputSchemas } from "../../shared/schemas/acp-api";
import { setupAgentManagement as setup } from "./agent-management.test-support";

it.effect("keeps the exact Agent instance and resolves its Project for management requests", () =>
  Effect.gen(function* () {
    const { agents, calls } = yield* setup;
    yield* agents["acp.sessions.list"]("window", { instanceId: "personal", projectId: "active" });
    assert.equal(calls[0]?.input.cwd, "/canonical/project");
    assert.equal(calls[0]?.input.instanceId, "personal");
    const result = yield* Effect.result(
      agents["acp.sessions.list"]("window", { instanceId: "personal", projectId: "missing" }),
    );
    assert.equal(result._tag, "Failure");
    assert.equal(calls.length, 1);
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
    assert.equal(second.runtimeGeneration, "generation-one");
    assert.isNull(second.configurationRevision);
    assert.equal(second.revision, 4);
    assert.isTrue(second.cancellable);
    yield* agents["acp.operation.read"]("second-window", { operationId: "second-install" });
    yield* agents["acp.operation.cancel"]("second-window", { operationId: "second-install" });
    assert.deepEqual(
      calls.slice(2).map(({ input }) => input.operationId),
      [state.coalescedOperation, state.coalescedOperation],
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

it.effect(
  "announces a completed installation after its window closes without renderer polling",
  () =>
    Effect.gen(function* () {
      const { agents, accounts, calls, state } = yield* setup;
      const changes: void[] = [];
      yield* agents.changes.pipe(
        Stream.runForEach(() => Effect.sync(() => changes.push(undefined))),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* agents["acp.install.start"]("window", { agentId: "qoder", operationId: "install" });
      yield* accounts.releaseOwner("window");
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
