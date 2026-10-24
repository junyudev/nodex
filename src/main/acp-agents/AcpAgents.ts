import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { createHash } from "node:crypto";
import { join } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type { AcpFailure, AcpMethod, AcpOperations } from "../../shared/acp-api";
import type { AgentAcpFailure } from "@nodex/agent-runtime/contracts";
import { agentRuntimeProviderId } from "../../shared/agent-runtime-provider";
import { AgentRuntimeSupervisor } from "../agent-runtime/AgentRuntimeSupervisor";
import { AgentRuntimeProviderConfiguration } from "../agent-runtime/AgentRuntimeProviderConfiguration";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { MainConfig } from "../app/MainConfig";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";

export class AcpAgentsError extends Schema.TaggedError<AcpAgentsError>()("AcpAgentsError", {
  message: Schema.String,
  reason: Schema.optional(
    Schema.Literals(["disabled", "operation_expired", "invalid_request", "busy"]),
  ),
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
    readonly changes: Stream.Stream<void>;
    readonly releaseOwner: (ownerId: string) => Effect.Effect<void>;
    readonly presentFailure: (failure: AgentAcpFailure) => Effect.Effect<AcpFailure>;
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
  const changes = yield* Effect.acquireRelease(PubSub.sliding<void>(1), PubSub.shutdown);
  const observationSignals = yield* Effect.acquireRelease(PubSub.sliding<void>(1), PubSub.shutdown);
  const changed = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
  type Observation = {
    readonly key: string;
    readonly slot?: string;
    readonly generation: string;
    readonly phase: string;
    readonly read: Effect.Effect<{ readonly phase: string }, unknown>;
    readonly settled?: () => void;
  };
  // Operation admission is capped at 256; authentication has one slot per configured instance.
  const observations = new Map<string, Observation>();
  const observed = new Set<string>();
  const observeCompletion = (input: Observation) =>
    Effect.gen(function* () {
      if (observed.has(input.key)) return;
      const slot = input.slot ?? input.key;
      if (observations.get(slot)?.key === input.key) return;
      observations.set(slot, input);
      yield* PubSub.publish(observationSignals, undefined);
    });
  const pollObservation = Effect.fn("AcpAgents.pollObservation")(function* (
    slot: string,
    observation: Observation,
  ) {
    const process = yield* runtime.currentConnection;
    if (process?.identity.runtimeGeneration !== observation.generation) {
      if (observations.get(slot) === observation) observations.delete(slot);
      return;
    }
    const result = yield* Effect.result(
      ["running", "starting", "waiting", "verifying"].includes(observation.phase)
        ? observation.read
        : Effect.succeed({ phase: observation.phase }),
    );
    if (observations.get(slot) !== observation) return;
    const current = yield* runtime.currentConnection;
    if (
      current?.identity.runtimeGeneration !== observation.generation ||
      result._tag === "Failure"
    ) {
      observations.delete(slot);
      return;
    }
    if (["running", "starting", "waiting", "verifying"].includes(result.success.phase)) return;
    observations.delete(slot);
    observation.settled?.();
    if (observed.size >= 256) observed.delete(observed.values().next().value!);
    observed.add(observation.key);
    if (result.success.phase === "succeeded") yield* changed;
  });
  const observationSubscription = yield* PubSub.subscribe(observationSignals);
  yield* Stream.fromSubscription(observationSubscription).pipe(
    Stream.runForEach(() =>
      Effect.gen(function* () {
        while (observations.size > 0) {
          yield* Effect.sleep("500 millis");
          yield* Effect.forEach(
            [...observations],
            ([slot, observation]) => pollObservation(slot, observation),
            { concurrency: 8, discard: true },
          );
        }
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
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
  const pendingAuthentication = new Map<string, Set<{ released: boolean }>>();
  const operations = new Map<
    string,
    {
      runtimeId: string;
      generation: string;
      instanceId: string | null;
      settled: boolean;
      requestIdentity: string;
      pending: number;
      accepted: boolean;
    }
  >();
  const key = (ownerId: string, id: string) => JSON.stringify([ownerId, id]);
  const instance = Effect.fn("AcpAgents.instance")(function* (id: string, allowDisabled = false) {
    const snapshot = yield* settings.snapshot();
    const configured = snapshot.acpAgents.instances.find((entry) => entry.id === id);
    if (!configured || (!allowDisabled && !configured.enabled))
      return yield* new AcpAgentsError({
        message: "ACP Agent instance is unavailable or disabled.",
        reason: "disabled",
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
    if (saved && input.flowId !== undefined && saved.flowId !== input.flowId)
      return yield* new AcpAgentsError({
        message: "This sign-in flow is no longer active. Start sign-in again.",
        reason: "operation_expired",
      });
    const current = yield* settings.snapshot();
    const enabled = current.acpAgents.instances.some(
      (entry) => entry.id === input.instanceId && entry.enabled,
    );
    const process = yield* connection();
    const digest = enabled ? yield* configurationDigest(input.instanceId) : null;
    if (
      !saved ||
      !enabled ||
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
        reason: "operation_expired",
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
        reason: "operation_expired",
      });
    return { process, operationId: saved.runtimeId, instanceId: saved.instanceId };
  });
  const operationIdentity = Effect.fn("AcpAgents.operationIdentity")(function* (
    ownerId: string,
    operationId: string,
    requestIdentity: string,
    instanceId: string | null = null,
  ) {
    const process = yield* connection();
    const operationKey = key(ownerId, operationId);
    const existing = operations.get(operationKey);
    if (existing?.generation === process.identity.runtimeGeneration) {
      if (existing.requestIdentity !== requestIdentity)
        return yield* new AcpAgentsError({
          reason: "invalid_request",
          message: "This operation ID belongs to another Agent request.",
        });
      existing.pending += 1;
      return { process, operationId: existing.runtimeId, record: existing, operationKey };
    }
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
    const record = {
      runtimeId,
      generation: process.identity.runtimeGeneration,
      instanceId,
      settled: false,
      requestIdentity,
      pending: 1,
      accepted: false,
    };
    operations.set(operationKey, record);
    return { process, operationId: runtimeId, record, operationKey };
  });
  const finishOperationStart = (operation: {
    record: { pending: number; accepted: boolean };
    operationKey: string;
  }) =>
    Effect.sync(() => {
      operation.record.pending -= 1;
      if (
        !operation.record.accepted &&
        operation.record.pending === 0 &&
        operations.get(operation.operationKey) === operation.record
      )
        operations.delete(operation.operationKey);
    });
  const presentFailure = (failure: AgentAcpFailure) =>
    application.sessionsForThreads(failure.affectedThreadIds ?? []).pipe(
      Effect.map((affectedSessions) => ({
        ...failure,
        ...(affectedSessions.length ? { affectedSessions } : {}),
      })),
      Effect.catch(() => Effect.succeed(failure)),
    );
  const presentOperation = Effect.fn("AcpAgents.presentOperation")(function* (
    ownerId: string,
    operationId: string,
    result: AcpOperations["acp.operation.read"]["output"],
  ) {
    const saved = operations.get(key(ownerId, operationId));
    if (saved) {
      // Runtime may coalesce concurrent starts from different windows into one operation.
      saved.runtimeId = result.operationId;
      saved.accepted = true;
      saved.settled = result.phase !== "running";
    }
    const process = yield* runtime.currentConnection;
    if (saved && process?.identity.runtimeGeneration === saved.generation)
      yield* observeCompletion({
        key: `operation:${saved.generation}:${result.operationId}`,
        generation: saved.generation,
        phase: result.phase,
        read: process.request("acp.operation.read", { operationId: result.operationId }),
        settled: () => {
          for (const operation of operations.values())
            if (
              operation.generation === saved.generation &&
              operation.runtimeId === result.operationId
            )
              operation.settled = true;
        },
      });
    return {
      ...result,
      operationId,
      instanceId: saved?.instanceId ?? null,
      error: result.error ? yield* presentFailure(result.error) : null,
    };
  });
  const methods: Methods = {
    "acp.install.preview": (_owner, input) => runtime.request("acp.install.preview", input),
    "acp.registry.search": (_owner, input) => runtime.request("acp.registry.search", input),
    "acp.inspect": (_owner, input) =>
      Effect.gen(function* () {
        const resolved = yield* instance(input.instanceId, true);
        return yield* runtime.request("acp.inspect", { instanceId: resolved.instanceId });
      }),
    "acp.install.start": (ownerId, input) =>
      Effect.gen(function* () {
        const op = yield* operationIdentity(
          ownerId,
          input.operationId,
          JSON.stringify([
            "install",
            input.agentId,
            input.distribution ?? "auto",
            input.expectedInstallationId ?? null,
          ]),
        );
        return yield* op.process
          .request("acp.install.start", { ...input, operationId: op.operationId })
          .pipe(
            Effect.flatMap((result) => presentOperation(ownerId, input.operationId, result)),
            Effect.ensuring(finishOperationStart(op)),
          );
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
      }).pipe(Effect.tap(() => changed)),
    "acp.connection.start": (ownerId, input) =>
      Effect.gen(function* () {
        const resolved = yield* target(input);
        const op = yield* operationIdentity(
          ownerId,
          input.operationId,
          JSON.stringify(["connect", resolved.instanceId, resolved.cwd]),
          input.instanceId,
        );
        return yield* op.process
          .request("acp.connection.start", { ...resolved, operationId: op.operationId })
          .pipe(
            Effect.flatMap((result) => presentOperation(ownerId, input.operationId, result)),
            Effect.ensuring(finishOperationStart(op)),
          );
      }),
    "acp.operation.read": (ownerId, input) =>
      Effect.gen(function* () {
        const op = yield* operationTarget(ownerId, input.operationId);
        const result = yield* op.process.request("acp.operation.read", {
          operationId: op.operationId,
        });
        return yield* presentOperation(ownerId, input.operationId, result);
      }),
    "acp.operation.cancel": (ownerId, input) =>
      Effect.gen(function* () {
        const op = yield* operationTarget(ownerId, input.operationId);
        const result = yield* op.process.request("acp.operation.cancel", {
          operationId: op.operationId,
        });
        return yield* presentOperation(ownerId, input.operationId, result);
      }),
    "acp.auth.start": (ownerId, input) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const pending = { released: false };
          const owned = pendingAuthentication.get(ownerId) ?? new Set();
          owned.add(pending);
          pendingAuthentication.set(ownerId, owned);
          return pending;
        }),
        (pending) =>
          Effect.gen(function* () {
            const resolved = yield* instance(input.instanceId);
            const digest = yield* configurationDigest(input.instanceId);
            const process = yield* connection();
            const result = yield* process.request("acp.auth.start", {
              ...input,
              instanceId: resolved.instanceId,
              ownerId,
            });
            if (pending.released) {
              if (result.flowId)
                yield* process
                  .request("acp.auth.cancel", {
                    instanceId: resolved.instanceId,
                    ownerId,
                    flowId: result.flowId,
                  })
                  .pipe(Effect.ignore);
              return yield* new AcpAgentsError({
                reason: "operation_expired",
                message: "This sign-in flow is no longer active. Start sign-in again.",
              });
            }
            if (result.flowId)
              flows.set(key(ownerId, input.instanceId), {
                ...resolved,
                configurationDigest: digest,
                ownerId,
                flowId: result.flowId,
                generation: process.identity.runtimeGeneration,
              });
            if (result.flowId)
              yield* observeCompletion({
                key: `auth:${process.identity.runtimeGeneration}:${resolved.instanceId}:${result.flowId}`,
                slot: `auth:${resolved.instanceId}`,
                generation: process.identity.runtimeGeneration,
                phase: result.phase,
                read: Effect.gen(function* () {
                  const saved = flows.get(key(ownerId, input.instanceId));
                  if (!saved || saved.flowId !== result.flowId) return { phase: "cancelled" };
                  return yield* process.request("acp.auth.read", {
                    instanceId: resolved.instanceId,
                    ownerId,
                  });
                }),
              });
            return authState(input.instanceId, result);
          }),
        (pending) =>
          Effect.sync(() => {
            const owned = pendingAuthentication.get(ownerId);
            owned?.delete(pending);
            if (owned?.size === 0) pendingAuthentication.delete(ownerId);
          }),
      ),
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
      }).pipe(Effect.tap(() => changed)),
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
      }).pipe(Effect.tap(() => changed)),
    "acp.modelProviders.disable": (_owner, input) =>
      Effect.gen(function* () {
        const resolved = yield* target(input);
        const process = yield* connection();
        return yield* process.request("acp.modelProviders.disable", {
          ...resolved,
          providerId: input.providerId,
        });
      }).pipe(Effect.tap(() => changed)),
  };
  const releaseOwner = Effect.fn("AcpAgents.releaseOwner")(function* (ownerId: string) {
    for (const pending of pendingAuthentication.get(ownerId) ?? []) pending.released = true;
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
  return AcpAgents.of({
    ...methods,
    releaseOwner,
    presentFailure,
    changes: Stream.fromPubSub(changes),
  });
});
export const live = Layer.effect(AcpAgents, make);
