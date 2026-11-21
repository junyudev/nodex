import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { setupAgentManagement as setup } from "../acp-agents/agent-management.test-support";
import { agentRuntimeProviderId } from "../../shared/agent-runtime-provider";

const personal = { kind: "acp", instanceConfigId: "personal" } as const;
const antigravity = { kind: "antigravity", instanceConfigId: "personal" } as const;

it.effect(
  "rejects another window's credentials and stale flow input after configuration changes",
  () =>
    Effect.gen(function* () {
      const { accounts, calls, state } = yield* setup;
      const authentication = yield* accounts.start("owner", { backend: personal });
      assert.equal(authentication.instanceId, "personal");
      assert.equal(authentication.runtimeGeneration, "generation-one");
      assert.equal(authentication.configurationRevision, 7);
      assert.equal(authentication.revision, 4);
      assert.isTrue(authentication.cancellable);
      const input = {
        backend: personal,
        flowId: "flow",
        interactionId: "terminal",
        response: { type: "terminal" as const, data: "secret" },
      };
      assert.equal((yield* Effect.result(accounts.respond("other", input)))._tag, "Failure");
      assert.isFalse(calls.some(({ method }) => method === "providers.auth.respond"));
      state.secret = "changed-secret";
      assert.equal((yield* Effect.result(accounts.respond("owner", input)))._tag, "Failure");
      assert.isTrue(calls.some(({ method }) => method === "providers.auth.cancel"));
      assert.isFalse(calls.some(({ method }) => method === "providers.auth.respond"));
    }),
);
it.effect("keeps sign-in active when unrelated application settings change", () =>
  Effect.gen(function* () {
    const { accounts, calls, state } = yield* setup;
    yield* accounts.start("owner", { backend: personal });
    state.revision = "unrelated-notification-change";
    yield* accounts.respond("owner", {
      backend: personal,
      flowId: "flow",
      interactionId: "terminal",
      response: { type: "terminal", data: "answer" },
    });
    assert.isTrue(calls.some(({ method }) => method === "providers.auth.respond"));
    assert.isFalse(calls.some(({ method }) => method === "providers.auth.cancel"));
  }),
);
it.effect("does not replay terminal input across Runtime generations", () =>
  Effect.gen(function* () {
    const { accounts, calls, state } = yield* setup;
    yield* accounts.start("owner", { backend: personal });
    state.generation = "new";
    assert.equal(
      (yield* Effect.result(
        accounts.respond("owner", {
          backend: personal,
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
    const { agents, accounts, calls } = yield* setup;
    yield* accounts.start("owner", { backend: personal });
    yield* agents["acp.install.start"]("owner", { operationId: "install", agentId: "qoder" });
    yield* accounts.releaseOwner("owner");
    assert.equal(calls.filter(({ method }) => method === "providers.auth.cancel").length, 1);
    assert.isFalse(calls.some(({ method }) => method === "acp.operation.cancel"));
    assert.equal(
      (yield* Effect.result(agents["acp.operation.read"]("other", { operationId: "install" })))
        ._tag,
      "Failure",
    );
  }),
);
it.effect("cancels authentication that returns after its window closes", () =>
  Effect.gen(function* () {
    const { accounts, calls, state, authenticationStarted, authenticationRelease } = yield* setup;
    state.pauseAuthentication = true;
    const starting = yield* Effect.forkChild(
      Effect.result(accounts.start("owner", { backend: personal })),
    );
    yield* Deferred.await(authenticationStarted);
    yield* accounts.releaseOwner("owner");
    yield* Deferred.succeed(authenticationRelease, undefined);
    assert.equal((yield* Fiber.join(starting))._tag, "Failure");
    assert.deepEqual(
      calls
        .filter(({ method }) => method === "providers.auth.cancel")
        .map(({ input }) => ({ ownerId: input.ownerId, flowId: input.flowId })),
      [{ ownerId: "owner", flowId: "flow" }],
    );
    yield* accounts.releaseOwner("owner");
    assert.equal(calls.filter(({ method }) => method === "providers.auth.cancel").length, 1);
  }),
);

it.effect("announces authentication completion without an observing settings modal", () =>
  Effect.gen(function* () {
    const { accounts, state } = yield* setup;
    let changes = 0;
    yield* accounts.changes.pipe(
      Stream.runForEach(() =>
        Effect.sync(() => {
          changes += 1;
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* accounts.start("window", { backend: personal });
    state.authenticationPhase = "succeeded";
    yield* TestClock.adjust("500 millis");
    assert.equal(changes, 1);
    yield* TestClock.adjust("1 second");
    assert.equal(changes, 1);
  }),
);

it.effect("rejects delayed responses to an older sign-in without cancelling the current flow", () =>
  Effect.gen(function* () {
    const { accounts, calls, state } = yield* setup;
    state.flowId = "flow-a";
    yield* accounts.start("window", { backend: personal });
    state.flowId = "flow-b";
    yield* accounts.start("window", { backend: personal });
    const stale = { backend: personal, flowId: "flow-a" };
    for (const operation of [
      accounts.respond("window", {
        ...stale,
        interactionId: "terminal",
        response: { type: "terminal", data: "old" },
      }),
      accounts.complete("window", {
        ...stale,
        callbackUrl: "https://callback.example.test/return",
      }),
      accounts.cancel("window", stale),
    ]) {
      const result = yield* Effect.result(operation);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure")
        assert.propertyVal(result.failure, "reason", "operation_expired");
    }
    assert.equal(calls.filter(({ method }) => method === "providers.auth.cancel").length, 0);
    yield* accounts.respond("window", {
      backend: personal,
      flowId: "flow-b",
      interactionId: "terminal",
      response: { type: "terminal", data: "current" },
    });
    assert.equal(calls.filter(({ method }) => method === "providers.auth.respond").length, 1);
    assert.equal(calls.at(-1)?.input.flowId, "flow-b");
  }),
);

it.effect.each(["cancel", "configuration-change"] as const)(
  "preserves a new sign-in when the previous flow's %s cancellation returns late",
  (reason) =>
    Effect.gen(function* () {
      const { accounts, calls, state, cancellationStarted, cancellationRelease } = yield* setup;
      state.flowId = "flow-a";
      yield* accounts.start("window", { backend: personal });
      state.pauseCancellation = true;
      if (reason === "configuration-change") state.secret = "new-secret";
      const cancelling = yield* Effect.forkChild(
        Effect.result(
          reason === "cancel"
            ? accounts.cancel("window", {
                backend: personal,
                flowId: "flow-a",
              })
            : accounts.respond("window", {
                backend: personal,
                flowId: "flow-a",
                interactionId: "terminal",
                response: { type: "terminal", data: "old" },
              }),
        ),
      );
      yield* Deferred.await(cancellationStarted);
      state.flowId = "flow-b";
      yield* accounts.start("window", { backend: personal });
      yield* Deferred.succeed(cancellationRelease, undefined);
      assert.equal(
        (yield* Fiber.join(cancelling))._tag,
        reason === "cancel" ? "Success" : "Failure",
      );
      yield* accounts.respond("window", {
        backend: personal,
        flowId: "flow-b",
        interactionId: "terminal",
        response: { type: "terminal", data: "current" },
      });
      assert.deepEqual(
        calls
          .filter(({ method }) => method === "providers.auth.cancel")
          .map(({ input }) => input.flowId),
        ["flow-a"],
      );
      assert.equal(calls.at(-1)?.method, "providers.auth.respond");
      assert.equal(calls.at(-1)?.input.flowId, "flow-b");
    }),
);

it.effect("does not retain completed sign-ins after repeatedly removing their instances", () =>
  Effect.gen(function* () {
    const { accounts, calls, state } = yield* setup;
    for (let index = 0; index < 100; index += 1) {
      const instanceId = `instance-${index}`;
      state.instanceIds = [instanceId];
      state.flowId = `flow-${index}`;
      state.authenticationPhase = index % 2 === 0 ? "succeeded" : "failed";
      yield* accounts.start("window", { backend: { kind: "acp", instanceConfigId: instanceId } });
      state.instanceIds = [];
    }
    yield* accounts.releaseOwner("window");
    assert.equal(calls.filter(({ method }) => method === "providers.auth.cancel").length, 0);
  }),
);

it.effect.each(["succeeded", "failed", "cancelled", "removed", "generation"])(
  "releases an observed sign-in after it becomes %s",
  (outcome) =>
    Effect.gen(function* () {
      const { accounts, calls, state } = yield* setup;
      yield* accounts.start("window", { backend: personal });
      if (outcome === "removed") {
        state.instanceIds = [];
        state.rejectAuthenticationRead = true;
      } else if (outcome === "generation") state.generation = "replacement";
      else state.authenticationPhase = outcome;
      yield* TestClock.adjust("500 millis");
      if (["succeeded", "failed", "cancelled"].includes(outcome)) {
        state.secret = "changed-after-completion";
        const current = yield* accounts.read("window", { backend: personal });
        assert.equal(current?.phase, outcome);
      }
      state.generation = "generation-one";
      yield* accounts.releaseOwner("window");
      assert.equal(calls.filter(({ method }) => method === "providers.auth.cancel").length, 0);
    }),
);

it.effect("keeps a new sign-in when the previous observer returns a late terminal state", () =>
  Effect.gen(function* () {
    const { accounts, calls, state, authenticationReadStarted, authenticationReadRelease } =
      yield* setup;
    state.flowId = "flow-a";
    yield* accounts.start("window", { backend: personal });
    state.pauseAuthenticationRead = true;
    state.authenticationPhase = "succeeded";
    const ticking = yield* Effect.forkChild(TestClock.adjust("500 millis"));
    yield* Deferred.await(authenticationReadStarted);
    state.flowId = "flow-b";
    state.authenticationPhase = "waiting";
    yield* accounts.start("window", { backend: personal });
    yield* Deferred.succeed(authenticationReadRelease, undefined);
    yield* Fiber.join(ticking);
    yield* accounts.respond("window", {
      backend: personal,
      flowId: "flow-b",
      interactionId: "terminal",
      response: { type: "terminal", data: "current" },
    });
    assert.equal(calls.at(-1)?.method, "providers.auth.respond");
    assert.equal(calls.at(-1)?.input.flowId, "flow-b");
  }),
);

it.effect("Antigravity reads stay passive and sign-out refreshes only the saved profile", () =>
  Effect.gen(function* () {
    const { accounts, calls, state } = yield* setup;
    state.connected = false;
    assert.isNull(yield* accounts.read("window", { backend: antigravity }));
    assert.equal(state.starts, 0);
    assert.deepEqual(calls, []);
    const providerId = agentRuntimeProviderId(antigravity);
    state.authenticationPhase = "idle";
    yield* accounts.logout("window", { backend: antigravity });
    assert.deepEqual(calls, [
      { method: "providers.auth.logout", input: { instanceId: providerId } },
      { method: "providers.read", input: { instanceIds: [providerId], refresh: true } },
    ]);
  }),
);

it.effect("Antigravity credentials cannot cross a Runtime replacement", () =>
  Effect.gen(function* () {
    const { accounts, calls, state } = yield* setup;
    yield* accounts.start("window", { backend: antigravity });
    assert.equal(calls[0]?.input.instanceId, agentRuntimeProviderId(antigravity));
    state.generation = "replacement";
    assert.isTrue(
      yield* accounts
        .respond("window", {
          backend: antigravity,
          flowId: "flow",
          interactionId: "code",
          response: { type: "credentials", values: { code: "fake-code" } },
        })
        .pipe(Effect.isFailure),
    );
    assert.deepEqual(
      calls.map(({ method }) => method),
      ["providers.auth.start"],
    );
    assert.equal(state.starts, 1);
  }),
);

it.effect("refreshes missing Antigravity models after verification, not on passive reads", () =>
  Effect.gen(function* () {
    const { accounts, calls, state } = yield* setup;
    const instanceId = agentRuntimeProviderId(antigravity);
    state.providers = [{ instanceId, auth: { status: "authenticated" }, models: [] }];
    yield* accounts.start("window", { backend: antigravity });
    state.authenticationPhase = "succeeded";
    yield* TestClock.adjust("500 millis");
    assert.deepEqual(calls.slice(2), [
      { method: "providers.read", input: { instanceIds: [instanceId], refresh: true } },
      { method: "providers.models.refresh", input: { instanceId } },
    ]);
  }),
);
