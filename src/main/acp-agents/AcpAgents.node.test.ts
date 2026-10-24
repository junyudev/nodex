import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
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
  const calls: { method: string; input: Record<string, unknown> }[] = [];
  const state = { revision: "one", generation: "generation-one", enabled: true };
  const request = (method: string, input: Record<string, unknown>) =>
    Effect.sync(() => {
      calls.push({ method, input });
      if (method.startsWith("acp.auth."))
        return {
          instanceId: input.instanceId,
          phase: "waiting",
          flowId: "flow",
          authorizationUrl: null,
          expiresAt: null,
          message: null,
        };
      if (method === "acp.sessions.list")
        return { sessions: [], nextCursor: null, canLoad: true, canResume: false, canDelete: true };
      return {
        operationId: input.operationId,
        kind: method === "acp.install.start" ? "install" : "connect",
        phase: "running",
        instanceId: input.instanceId ?? null,
        agentId: input.agentId ?? null,
        result: null,
        error: null,
      };
    });
  const process = () => ({ identity: { runtimeGeneration: state.generation }, request });
  const agents = yield* make.pipe(
    Effect.provideService(AgentRuntimeApplication, {} as AgentRuntimeApplication["Service"]),
    Effect.provideService(AgentRuntimeSupervisor, {
      get: () => Effect.sync(process),
      currentConnection: Effect.sync(process),
      request,
    } as unknown as AgentRuntimeSupervisor["Service"]),
    Effect.provideService(ApplicationSettings, {
      ...makeTestApplicationSettings(),
      snapshot: () =>
        Effect.succeed({
          revision: state.revision,
          acpAgents: {
            instances: [{ id: "personal", agentDefinitionId: "qoder", enabled: state.enabled }],
          },
        } as ApplicationSettingsSnapshot),
    }),
    Effect.provideService(AgentRuntimeProviderConfiguration, { refresh: Effect.void }),
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
  return { agents, calls, state };
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
      state.revision = "changed";
      assert.equal(
        (yield* Effect.result(agents["acp.auth.respond"]("owner", input)))._tag,
        "Failure",
      );
      assert.isTrue(calls.some(({ method }) => method === "acp.auth.cancel"));
      assert.isFalse(calls.some(({ method }) => method === "acp.auth.respond"));
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
