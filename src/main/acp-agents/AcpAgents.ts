import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { createHash } from "node:crypto";
import { join } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { AcpMethod, AcpOperations } from "../../shared/acp-api";
import { agentRuntimeProviderId } from "../../shared/agent-runtime-provider";
import { AgentRuntimeSupervisor } from "../agent-runtime/AgentRuntimeSupervisor";
import { AgentRuntimeProviderConfiguration } from "../agent-runtime/AgentRuntimeProviderConfiguration";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { MainConfig } from "../app/MainConfig";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";

export class AcpAgentsError extends Schema.TaggedError<AcpAgentsError>()("AcpAgentsError", {
  message: Schema.String,
}) {}
type Methods = {
  readonly [Method in AcpMethod]: (
    ownerId: string,
    input: AcpOperations[Method]["input"],
  ) => Effect.Effect<AcpOperations[Method]["output"], unknown>;
};
export class AcpAgents extends Context.Service<
  AcpAgents,
  Methods & {
    readonly releaseOwner: (ownerId: string) => Effect.Effect<void>;
  }
>()("nodex/main/acp-agents/AcpAgents") {}

/** Main resolves Profile and window authority; management never accepts a caller's launch config. */
export const make = Effect.gen(function* () {
  const runtime = yield* AgentRuntimeSupervisor;
  const application = yield* AgentRuntimeApplication;
  const settings = yield* ApplicationSettings;
  const configuration = yield* AgentRuntimeProviderConfiguration;
  const projects = yield* ProjectWorkspace;
  const config = yield* MainConfig;
  const fs = yield* FileSystem.FileSystem;
  const flows = new Map<
    string,
    {
      instanceId: string;
      ownerId: string;
      flowId: string;
      configurationDigest: string;
      generation: string;
    }
  >();
  const operations = new Map<
    string,
    { runtimeId: string; generation: string; instanceId: string | null; settled: boolean }
  >();
  const key = (ownerId: string, id: string) => JSON.stringify([ownerId, id]);
  const instance = Effect.fn("AcpAgents.instance")(function* (id: string, allowDisabled = false) {
    const snapshot = yield* settings.snapshot();
    const configured = snapshot.acpAgents.instances.find((entry) => entry.id === id);
    if (!configured || (!allowDisabled && !configured.enabled))
      return yield* new AcpAgentsError({
        message: "ACP Agent instance is unavailable or disabled.",
      });
    const providerId = agentRuntimeProviderId({
      kind: "acp",
      agentDefinitionId: configured.agentDefinitionId,
      instanceConfigId: configured.id,
    });
    if (!providerId)
      return yield* new AcpAgentsError({ message: "ACP Agent identity is unavailable." });
    return { instanceId: providerId };
  });
  const configurationDigest = Effect.fn("AcpAgents.configurationDigest")(function* (id: string) {
    const launch = yield* settings.acpLaunchConfiguration(id);
    // Only the digest survives in memory; credentials never become public flow metadata.
    return createHash("sha256").update(JSON.stringify(launch)).digest("hex");
  });
  const target = Effect.fn("AcpAgents.target")(function* (input: {
    readonly instanceId: string;
    readonly projectId?: string | null;
  }) {
    const resolved = yield* instance(input.instanceId);
    if (!input.projectId) {
      const cwd = join(config.nodexHome, "tasks");
      yield* fs.makeDirectory(cwd, { recursive: true });
      return { instanceId: resolved.instanceId, cwd };
    }
    const project = yield* projects.getProject(input.projectId);
    if (!project || project.lifecycle !== "active" || !project.primaryWorkspaceRoot)
      return yield* new AcpAgentsError({ message: "Select an active Project with a workspace." });
    return { instanceId: resolved.instanceId, cwd: project.primaryWorkspaceRoot };
  });
  const connection = Effect.fn("AcpAgents.connection")(function* () {
    yield* configuration.refresh;
    return yield* runtime.get();
  });
  const authState = <State extends { readonly instanceId: string }>(
    id: string,
    state: State,
  ): State => ({ ...state, instanceId: id });
  const flowTarget = Effect.fn("AcpAgents.flowTarget")(function* (
    ownerId: string,
    input: { readonly instanceId: string; readonly flowId?: string },
  ) {
    const saved = flows.get(key(ownerId, input.instanceId));
    const current = yield* settings.snapshot();
    const enabled = current.acpAgents.instances.some(
      (entry) => entry.id === input.instanceId && entry.enabled,
    );
    const process = yield* connection();
    const digest = enabled ? yield* configurationDigest(input.instanceId) : null;
    if (
      !saved ||
      !enabled ||
      (input.flowId !== undefined && saved.flowId !== input.flowId) ||
      saved.generation !== process.identity.runtimeGeneration ||
      saved.configurationDigest !== digest
    ) {
      if (saved && saved.generation === process.identity.runtimeGeneration)
        yield* process
          .request("acp.auth.cancel", {
            instanceId: saved.instanceId,
            flowId: saved.flowId,
            ownerId,
          })
          .pipe(Effect.ignore);
      flows.delete(key(ownerId, input.instanceId));
      return yield* new AcpAgentsError({
        message: "This sign-in flow is no longer active. Start sign-in again.",
      });
    }
    return { process, instanceId: saved.instanceId };
  });
  const operationTarget = Effect.fn("AcpAgents.operationTarget")(function* (
    ownerId: string,
    operationId: string,
  ) {
    const saved = operations.get(key(ownerId, operationId));
    const process = yield* runtime.get();
    if (!saved || saved.generation !== process.identity.runtimeGeneration)
      return yield* new AcpAgentsError({
        message: "This Agent operation is no longer active. Try again.",
      });
    return { process, operationId: saved.runtimeId, instanceId: saved.instanceId };
  });
  const operationIdentity = Effect.fn("AcpAgents.operationIdentity")(function* (
    ownerId: string,
    operationId: string,
    instanceId: string | null = null,
  ) {
    const process = yield* connection();
    const operationKey = key(ownerId, operationId);
    if (!operations.has(operationKey) && operations.size >= 256) {
      for (const [entry, operation] of operations) {
        if (operation.settled || operation.generation !== process.identity.runtimeGeneration)
          operations.delete(entry);
      }
      if (operations.size >= 256)
        return yield* new AcpAgentsError({
          message: "Too many Agent operations are active. Wait for an operation to finish.",
        });
    }
    const runtimeId = createHash("sha256").update(operationKey).digest("hex");
    operations.set(operationKey, {
      runtimeId,
      generation: process.identity.runtimeGeneration,
      instanceId,
      settled: false,
    });
    return { process, operationId: runtimeId };
  });
  const presentOperation = (
    ownerId: string,
    operationId: string,
    result: AcpOperations["acp.operation.read"]["output"],
  ) => {
    const saved = operations.get(key(ownerId, operationId));
    if (saved) {
      // Runtime may coalesce concurrent starts from different windows into one operation.
      saved.runtimeId = result.operationId;
      saved.settled = result.phase !== "running";
    }
    return { ...result, operationId, instanceId: saved?.instanceId ?? null };
  };
  const methods: Methods = {
    "acp.registry.search": (_owner, input) => runtime.request("acp.registry.search", input),
    "acp.inspect": (_owner, input) =>
      Effect.gen(function* () {
        const resolved = yield* instance(input.instanceId, true);
        return yield* runtime.request("acp.inspect", { instanceId: resolved.instanceId });
      }),
    "acp.install.start": (ownerId, input) =>
      Effect.gen(function* () {
        const op = yield* operationIdentity(ownerId, input.operationId);
        const result = yield* op.process.request("acp.install.start", {
          ...input,
          operationId: op.operationId,
        });
        return presentOperation(ownerId, input.operationId, result);
      }),
    "acp.registry.uninstall": (_owner, input) =>
      Effect.gen(function* () {
        const snapshot = yield* settings.snapshot();
        if (
          snapshot.acpAgents.instances.some(
            ({ source }) => source.kind === "registry" && source.agentId === input.agentId,
          )
        )
          return yield* new AcpAgentsError({
            message: "Remove Agent instances using this installation before uninstalling it.",
          });
        return yield* runtime.request("acp.registry.uninstall", input);
      }),
    "acp.connection.start": (ownerId, input) =>
      Effect.gen(function* () {
        const resolved = yield* target(input);
        const op = yield* operationIdentity(ownerId, input.operationId, input.instanceId);
        const result = yield* op.process.request("acp.connection.start", {
          ...resolved,
          operationId: op.operationId,
        });
        return presentOperation(ownerId, input.operationId, result);
      }),
    "acp.operation.read": (ownerId, input) =>
      Effect.gen(function* () {
        const op = yield* operationTarget(ownerId, input.operationId);
        const result = yield* op.process.request("acp.operation.read", {
          operationId: op.operationId,
        });
        return presentOperation(ownerId, input.operationId, result);
      }),
    "acp.operation.cancel": (ownerId, input) =>
      Effect.gen(function* () {
        const op = yield* operationTarget(ownerId, input.operationId);
        const result = yield* op.process.request("acp.operation.cancel", {
          operationId: op.operationId,
        });
        return presentOperation(ownerId, input.operationId, result);
      }),
    "acp.auth.start": (ownerId, input) =>
      Effect.gen(function* () {
        const resolved = yield* instance(input.instanceId);
        const digest = yield* configurationDigest(input.instanceId);
        const process = yield* connection();
        const result = yield* process.request("acp.auth.start", {
          ...input,
          instanceId: resolved.instanceId,
          ownerId,
        });
        if (result.flowId)
          flows.set(key(ownerId, input.instanceId), {
            ...resolved,
            configurationDigest: digest,
            ownerId,
            flowId: result.flowId,
            generation: process.identity.runtimeGeneration,
          });
        return authState(input.instanceId, result);
      }),
    "acp.auth.read": (ownerId, input) =>
      Effect.gen(function* () {
        const existing = flows.get(key(ownerId, input.instanceId));
        const resolved = existing
          ? yield* flowTarget(ownerId, input)
          : {
              instanceId: (yield* instance(input.instanceId)).instanceId,
              process: yield* connection(),
            };
        return authState(
          input.instanceId,
          yield* resolved.process.request("acp.auth.read", {
            instanceId: resolved.instanceId,
            ownerId,
          }),
        );
      }),
    "acp.auth.respond": (ownerId, input) =>
      Effect.gen(function* () {
        const resolved = yield* flowTarget(ownerId, input);
        return authState(
          input.instanceId,
          yield* resolved.process.request("acp.auth.respond", {
            ...input,
            instanceId: resolved.instanceId,
            ownerId,
          }),
        );
      }),
    "acp.auth.complete": (ownerId, input) =>
      Effect.gen(function* () {
        const resolved = yield* flowTarget(ownerId, input);
        return authState(
          input.instanceId,
          yield* resolved.process.request("acp.auth.complete", {
            ...input,
            instanceId: resolved.instanceId,
            ownerId,
          }),
        );
      }),
    "acp.auth.cancel": (ownerId, input) =>
      Effect.gen(function* () {
        const resolved = yield* flowTarget(ownerId, input);
        const result = yield* resolved.process.request("acp.auth.cancel", {
          ...input,
          instanceId: resolved.instanceId,
          ownerId,
        });
        flows.delete(key(ownerId, input.instanceId));
        return authState(input.instanceId, result);
      }),
    "acp.auth.logout": (_owner, input) =>
      Effect.gen(function* () {
        const resolved = yield* instance(input.instanceId);
        const process = yield* connection();
        return authState(
          input.instanceId,
          yield* process.request("acp.auth.logout", { instanceId: resolved.instanceId }),
        );
      }),
    "acp.urlAuth.accept": (_owner, input) =>
      Effect.gen(function* () {
        const resolved = yield* instance(input.instanceId);
        return yield* runtime.request("acp.urlAuth.accept", {
          instanceId: resolved.instanceId,
          elicitationId: input.elicitationId,
        });
      }),
    "acp.sessions.list": (_owner, input) =>
      Effect.gen(function* () {
        const resolved = yield* target(input);
        const process = yield* connection();
        return yield* process.request("acp.sessions.list", {
          ...resolved,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        });
      }),
    "acp.sessions.prepareImport": (_owner, input) =>
      Effect.gen(function* () {
        const resolved = yield* target(input);
        const process = yield* connection();
        return yield* process.request("acp.sessions.prepareImport", {
          ...resolved,
          sessionId: input.sessionId,
        });
      }),
    "acp.sessions.import": (_owner, input) =>
      Effect.gen(function* () {
        const resolved = yield* target(input);
        yield* connection();
        return yield* application.importAcp({
          ...resolved,
          projectId: input.projectId ?? null,
          sessionId: input.sessionId,
          requestId: input.requestId,
          acceptedAt: input.acceptedAt,
        });
      }),
    "acp.sessions.delete": (_owner, input) =>
      Effect.gen(function* () {
        const resolved = yield* target(input);
        const process = yield* connection();
        return yield* process.request("acp.sessions.delete", {
          ...resolved,
          sessionId: input.sessionId,
        });
      }),
    "acp.modelProviders.list": (_owner, input) =>
      Effect.gen(function* () {
        const resolved = yield* target(input);
        const process = yield* connection();
        return yield* process.request("acp.modelProviders.list", resolved);
      }),
    "acp.modelProviders.set": (_owner, input) =>
      Effect.gen(function* () {
        const resolved = yield* target(input);
        const process = yield* connection();
        return yield* process.request("acp.modelProviders.set", {
          ...resolved,
          providerId: input.providerId,
          apiType: input.apiType,
          baseUrl: input.baseUrl,
          ...(input.headers === undefined ? {} : { headers: input.headers }),
        });
      }),
    "acp.modelProviders.disable": (_owner, input) =>
      Effect.gen(function* () {
        const resolved = yield* target(input);
        const process = yield* connection();
        return yield* process.request("acp.modelProviders.disable", {
          ...resolved,
          providerId: input.providerId,
        });
      }),
  };
  const releaseOwner = Effect.fn("AcpAgents.releaseOwner")(function* (ownerId: string) {
    const process = yield* runtime.currentConnection;
    const owned = [...flows.entries()].filter(([, flow]) => flow.ownerId === ownerId);
    for (const [entry, flow] of owned) {
      flows.delete(entry);
      if (process && flow.generation === process.identity.runtimeGeneration)
        yield* process
          .request("acp.auth.cancel", { instanceId: flow.instanceId, flowId: flow.flowId, ownerId })
          .pipe(Effect.ignore);
    }
  });
  return AcpAgents.of({ ...methods, releaseOwner });
});
export const live = Layer.effect(AcpAgents, make);
