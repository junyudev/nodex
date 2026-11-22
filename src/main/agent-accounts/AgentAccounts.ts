import { antigravityAgent } from "../../shared/agents/antigravity";
import { agentProfilesFor } from "../../shared/agents/profiles";
import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type {
  AgentAccountBackend,
  AgentAccountOperations,
  AgentAccountState,
} from "../../shared/agent-accounts-api";
import { AgentManagementError } from "../agent-runtime/AgentManagementFailure";
import { makeOperationCompletionObserver } from "../agent-runtime/AgentOperationCompletion";
import { AgentRuntimeProviderConfiguration } from "../agent-runtime/AgentRuntimeProviderConfiguration";
import { AgentRuntimeSupervisor } from "../agent-runtime/AgentRuntimeSupervisor";
import { ApplicationSettings } from "../settings/ApplicationSettings";

type Methods = {
  readonly [Action in keyof AgentAccountOperations]: (
    ownerId: string,
    input: AgentAccountOperations[Action]["input"],
  ) => Effect.Effect<AgentAccountOperations[Action]["output"], unknown>;
};
export class AgentAccounts extends Context.Service<
  AgentAccounts,
  Methods & {
    readonly changes: Stream.Stream<void>;
    readonly releaseOwner: (ownerId: string) => Effect.Effect<void>;
  }
>()("nodex/main/agent-accounts/AgentAccounts") {}

const expired = () =>
  new AgentManagementError({
    reason: "operation_expired",
    message: "This sign-in flow is no longer active. Start sign-in again.",
  });
const key = (ownerId: string, backend: AgentAccountBackend) =>
  JSON.stringify([ownerId, backend.driver, backend.instanceId]);
const present = (backend: AgentAccountBackend, state: AgentAccountState): AgentAccountState => ({
  ...state,
  instanceId: backend.instanceId,
});

/** Resolves saved instances and binds every answer to the initiating window and Runtime. */
export const make = Effect.gen(function* () {
  const runtime = yield* AgentRuntimeSupervisor;
  const settings = yield* ApplicationSettings;
  const configuration = yield* AgentRuntimeProviderConfiguration;
  const changes = yield* Effect.acquireRelease(PubSub.sliding<void>(1), PubSub.shutdown);
  const observeCompletion = yield* makeOperationCompletionObserver;
  const resolve = Effect.fn("AgentAccounts.resolve")(function* (backend: AgentAccountBackend) {
    const snapshot = yield* settings.snapshot();
    const { driver, instanceId } = backend;
    const profiles =
      driver === "acpRegistry"
        ? snapshot.acpAgents.instances
        : driver === "antigravity"
          ? agentProfilesFor(snapshot.agentProfiles, antigravityAgent.driver)
          : [];
    if (!profiles.some((entry) => entry.id === instanceId && entry.enabled))
      return yield* new AgentManagementError({
        message: "This Agent profile is unavailable or disabled.",
        reason: "disabled",
      });
    return instanceId;
  });
  const configurationDigest = Effect.fn("AgentAccounts.configurationDigest")(function* (
    backend: AgentAccountBackend,
  ) {
    const launch = yield* backend.driver === "acpRegistry"
      ? settings.acpLaunchConfiguration(backend.instanceId)
      : settings.agentProfileLaunchConfiguration(antigravityAgent.driver, backend.instanceId);
    // Compare launch inputs including secrets without retaining them in flow metadata.
    return createHash("sha256").update(JSON.stringify(launch)).digest("hex");
  });
  const connection = Effect.fn("AgentAccounts.connection")(function* () {
    yield* configuration.refresh;
    return yield* runtime.get();
  });
  type Connection = Effect.Success<ReturnType<typeof connection>>;
  type Flow = {
    instanceId: string;
    ownerId: string;
    flowId: string;
    digest: string;
    generation: string;
  };
  const flows = new Map<string, Flow>();
  const pendingStarts = new Map<string, Set<{ released: boolean }>>();
  const releaseFlow = (flowKey: string, flow: Flow | undefined) => {
    if (flow && flows.get(flowKey) === flow) flows.delete(flowKey);
  };
  const cancel = (process: Connection, { instanceId, ownerId, flowId }: Flow) =>
    process.request("providers.auth.cancel", { instanceId, ownerId, flowId }).pipe(Effect.ignore);
  const current = (process: Connection) =>
    runtime.currentConnection.pipe(
      Effect.map(
        (active) => active?.identity.runtimeGeneration === process.identity.runtimeGeneration,
      ),
    );
  const refreshAccount = (process: Connection, instanceId: string, discoverIfEmpty = false) =>
    Effect.gen(function* () {
      if (!(yield* current(process))) return;
      const providers = yield* process
        .request("providers.read", {
          instanceIds: [instanceId],
          refresh: true,
        })
        .pipe(Effect.orElseSucceed(() => []));
      // Sign-in normally loads models during verification. Recheck only a verified, empty catalog.
      if (
        discoverIfEmpty &&
        providers.some(
          (provider) =>
            provider.instanceId === instanceId &&
            provider.auth.status === "authenticated" &&
            provider.models.length === 0,
        )
      )
        yield* process.request("providers.models.refresh", { instanceId }).pipe(Effect.ignore);
      yield* PubSub.publish(changes, undefined);
    }).pipe(Effect.asVoid);
  const flowTarget = Effect.fn("AgentAccounts.flowTarget")(function* (
    ownerId: string,
    input: { readonly backend: AgentAccountBackend; readonly flowId?: string },
  ) {
    const flowKey = key(ownerId, input.backend);
    const flow = flows.get(flowKey);
    if (!flow || (input.flowId !== undefined && flow.flowId !== input.flowId))
      return yield* expired();
    const resolved = yield* Effect.result(
      resolve(input.backend).pipe(Effect.andThen(configurationDigest(input.backend))),
    );
    const process = yield* runtime.currentConnection;
    // A replaced flow owns the slot now, even when the old reply had the same public target.
    if (flows.get(flowKey) !== flow) return yield* expired();
    if (process?.identity.runtimeGeneration === flow.generation) {
      if (resolved._tag === "Success" && resolved.success === flow.digest) return { process, flow };
      yield* cancel(process, flow);
    }
    releaseFlow(flowKey, flow);
    return yield* expired();
  });

  const methods: Methods = {
    start: (ownerId, { backend, ...input }) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const pending = { released: false };
          const owned = pendingStarts.get(ownerId) ?? new Set();
          owned.add(pending);
          pendingStarts.set(ownerId, owned);
          return pending;
        }),
        (pending) =>
          Effect.gen(function* () {
            const instanceId = yield* resolve(backend);
            const digest = yield* configurationDigest(backend);
            const process = yield* connection();
            if (pending.released) return yield* expired();
            const generation = process.identity.runtimeGeneration;
            const result = yield* process.request("providers.auth.start", {
              ...input,
              instanceId,
              ownerId,
            });
            if (!(yield* current(process))) return yield* expired();
            const flowKey = key(ownerId, backend);
            const previous = flows.get(flowKey);
            const { flowId } = result;
            if (!flowId) {
              releaseFlow(flowKey, previous);
              if (pending.released) return yield* expired();
              return present(backend, result);
            }
            const flow =
              previous?.flowId === flowId && previous.generation === generation
                ? previous
                : { instanceId, digest, ownerId, flowId, generation };
            if (pending.released) {
              yield* cancel(process, flow);
              return yield* expired();
            }
            if (result.cancellable) flows.set(flowKey, flow);
            else releaseFlow(flowKey, previous);
            yield* observeCompletion({
              key: JSON.stringify([generation, instanceId, flowId]),
              slot: instanceId,
              generation,
              phase: result.phase,
              onSucceeded: refreshAccount(process, instanceId, backend.driver === "antigravity"),
              read: Effect.gen(function* () {
                if (flows.get(flowKey) !== flow) return { phase: "cancelled" };
                return yield* process.request("providers.auth.read", { instanceId, ownerId });
              }),
              released: () => releaseFlow(flowKey, flow),
            });
            return present(backend, result);
          }),
        (pending) =>
          Effect.sync(() => {
            const owned = pendingStarts.get(ownerId);
            owned?.delete(pending);
            if (owned?.size === 0) pendingStarts.delete(ownerId);
          }),
      ),
    read: (ownerId, { backend }) =>
      Effect.gen(function* () {
        const owned = flows.has(key(ownerId, backend));
        const resolved = owned ? yield* flowTarget(ownerId, { backend }) : null;
        const instanceId = resolved?.flow.instanceId ?? (yield* resolve(backend));
        // ACP reads methods on explicit setup. Antigravity's passive Account row never starts an idle Runtime.
        const process =
          resolved?.process ??
          (yield* backend.driver === "acpRegistry" ? connection() : runtime.currentConnection);
        if (!process) return null;
        const result = yield* process.request("providers.auth.read", { instanceId, ownerId });
        if (!(yield* current(process))) return yield* expired();
        return present(backend, result);
      }),
    respond: (ownerId, { backend, ...input }) =>
      Effect.gen(function* () {
        const { process, flow } = yield* flowTarget(ownerId, { backend, flowId: input.flowId });
        const result = yield* process.request("providers.auth.respond", {
          ...input,
          instanceId: flow.instanceId,
          ownerId,
        });
        if (!(yield* current(process))) return yield* expired();
        return present(backend, result);
      }),
    complete: (ownerId, { backend, ...input }) =>
      Effect.gen(function* () {
        const { process, flow } = yield* flowTarget(ownerId, { backend, flowId: input.flowId });
        const result = yield* process.request("providers.auth.complete", {
          ...input,
          instanceId: flow.instanceId,
          ownerId,
        });
        if (!(yield* current(process))) return yield* expired();
        return present(backend, result);
      }),
    cancel: (ownerId, { backend, flowId }) =>
      Effect.gen(function* () {
        const { process, flow } = yield* flowTarget(ownerId, { backend, flowId });
        const result = yield* process.request("providers.auth.cancel", {
          instanceId: flow.instanceId,
          ownerId,
          flowId,
        });
        releaseFlow(key(ownerId, backend), flow);
        if (!(yield* current(process))) return yield* expired();
        return present(backend, result);
      }),
    logout: (_ownerId, { backend }) =>
      Effect.gen(function* () {
        const instanceId = yield* resolve(backend);
        const process = yield* connection();
        const result = yield* process.request("providers.auth.logout", { instanceId });
        if (!(yield* current(process))) return yield* expired();
        yield* refreshAccount(process, instanceId);
        return present(backend, result);
      }),
  };
  const releaseOwner = Effect.fn("AgentAccounts.releaseOwner")(function* (ownerId: string) {
    for (const pending of pendingStarts.get(ownerId) ?? []) pending.released = true;
    const owned = [...flows.entries()].filter(([, flow]) => flow.ownerId === ownerId);
    for (const [entry, flow] of owned) releaseFlow(entry, flow);
    const process = yield* runtime.currentConnection;
    if (!process) return;
    yield* Effect.forEach(
      owned,
      ([, flow]) =>
        flow.generation === process.identity.runtimeGeneration
          ? cancel(process, flow)
          : Effect.void,
      { discard: true },
    );
  });
  return AgentAccounts.of({ ...methods, releaseOwner, changes: Stream.fromPubSub(changes) });
});
export const live = Layer.effect(AgentAccounts, make);
