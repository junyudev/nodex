import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import { make as makeAcpAgents } from "./AcpAgents";
import { make as makeAgentAccounts } from "../agent-accounts/AgentAccounts";
import { AgentRuntimeSupervisor } from "../agent-runtime/AgentRuntimeSupervisor";
import { AgentRuntimeProviderConfiguration } from "../agent-runtime/AgentRuntimeProviderConfiguration";
import {
  ApplicationSettings,
  type ApplicationSettingsSnapshot,
} from "../settings/ApplicationSettings";
import { makeTestApplicationSettings } from "../settings/ApplicationSettings.test-support";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { testLayer } from "../app/MainConfig";

export const setupAgentManagement = Effect.gen(function* () {
  const authenticationStarted = yield* Deferred.make<void>();
  const authenticationRelease = yield* Deferred.make<void>();
  const cancellationStarted = yield* Deferred.make<void>();
  const cancellationRelease = yield* Deferred.make<void>();
  const authenticationReadStarted = yield* Deferred.make<void>();
  const authenticationReadRelease = yield* Deferred.make<void>();
  const calls: { method: string; input: Record<string, unknown> }[] = [];
  const operationConfigurations = new Map<unknown, number | null>();
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
    starts: 0,
    providers: [] as unknown[],
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
      if (method.startsWith("providers.auth."))
        return {
          instanceId: input.instanceId,
          runtimeGeneration: state.generation,
          configurationRevision: 7,
          revision: 4,
          cancellable: ["starting", "waiting", "verifying"].includes(state.authenticationPhase),
          phase: state.authenticationPhase,
          flowId: state.flowId,
          authorizationUrl: null,
          expiresAt: null,
          message: null,
        };
      if (method === "providers.read") return state.providers;
      if (method === "acp.sessions.list")
        return { sessions: [], nextCursor: null, canLoad: true, canResume: false, canDelete: true };
      const operationId = state.coalescedOperation || input.operationId;
      if (method === "acp.install.start") operationConfigurations.set(operationId, null);
      if (method === "acp.connection.start") operationConfigurations.set(operationId, 7);
      return {
        operationId,
        runtimeGeneration: state.generation,
        configurationRevision: operationConfigurations.get(operationId) ?? null,
        revision: 4,
        cancellable: state.operationPhase === "running",
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
        method === "providers.auth.start" && state.pauseAuthentication
          ? Deferred.succeed(authenticationStarted, undefined).pipe(
              Effect.andThen(Deferred.await(authenticationRelease)),
            )
          : Effect.void,
      ),
      Effect.tap(() =>
        method === "providers.auth.cancel" && state.pauseCancellation
          ? Deferred.succeed(cancellationStarted, undefined).pipe(
              Effect.andThen(Deferred.await(cancellationRelease)),
            )
          : Effect.void,
      ),
      Effect.tap(() =>
        method === "providers.auth.read" && state.pauseAuthenticationRead
          ? Deferred.succeed(authenticationReadStarted, undefined).pipe(
              Effect.andThen(Deferred.await(authenticationReadRelease)),
            )
          : Effect.void,
      ),
      Effect.tap(() =>
        method === "providers.auth.read" && state.rejectAuthenticationRead
          ? Effect.fail(new Error("Agent instance was removed"))
          : Effect.void,
      ),
    );
  const process = () => ({ identity: { runtimeGeneration: state.generation }, request });
  const services = yield* Effect.all({ agents: makeAcpAgents, accounts: makeAgentAccounts }).pipe(
    Effect.provideService(AgentRuntimeApplication, {
      sessionsForThreads: (threadIds: readonly string[]) =>
        Effect.succeed(
          threadIds
            .filter((id) => id === "root")
            .map((threadId) => ({ sessionId: "chat", threadId })),
        ),
    } as unknown as AgentRuntimeApplication["Service"]),
    Effect.provideService(AgentRuntimeSupervisor, {
      get: () =>
        Effect.sync(() => {
          state.starts += 1;
          state.connected = true;
          return process();
        }),
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
      antigravityLaunchConfiguration: () => Effect.succeed({ apiKey: state.secret } as never),
      snapshot: () =>
        Effect.succeed({
          revision: state.revision,
          antigravityAgents: {
            instances: [{ id: "personal", enabled: state.enabled }],
          },
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
    ...services,
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
