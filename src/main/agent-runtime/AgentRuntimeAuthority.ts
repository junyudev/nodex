import type { components } from "@nodex/core-protocol";
import type {
  AgentWire,
  OrchestrationV2AppThread,
  OrchestrationV2Run,
} from "@nodex/agent-runtime/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { projectNativeTurnContext } from "../agent-backend/NativeTurnAuthority";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { createOperationId } from "../core-runtime/operation-identity";
import { toCoreAgentTurnProvenance } from "../core-client/core-agent-execution-authorization";

type RuntimeThread = AgentWire<OrchestrationV2AppThread>;
type RuntimeRun = AgentWire<OrchestrationV2Run>;
export type AgentRuntimeRunAuthorityIdentity =
  components["schemas"]["ProjectWorkspaceAgentRuntimeTurnIdentity"];
export type AgentRuntimeNativeSessionAuthorityIdentity =
  components["schemas"]["ProjectWorkspaceAgentRuntimeNativeSessionIdentity"];
export type AgentRuntimeAuthorityIdentity =
  | AgentRuntimeRunAuthorityIdentity
  | AgentRuntimeNativeSessionAuthorityIdentity;
type SessionBinding = components["schemas"]["ProjectWorkspaceAgentRuntimeSessionBinding"];
type NormalizedBinding = Omit<SessionBinding, "project_id"> & {
  readonly project_id: string | null;
};
type TurnProvenance = components["schemas"]["AgentTurnProvenance"];

export interface AgentRuntimeNativeToolCall {
  readonly providerThreadId: string;
  readonly providerTurnId: string | null;
  readonly callId: string;
}

/** A bounded observation from the authenticated engine, never model-authored MCP metadata. */
interface AgentRuntimeAuthorityFrame {
  readonly runtimeId: string;
  readonly leaseId: string;
  readonly threadId: RuntimeThread["id"];
  readonly projectId: string | null;
  readonly rootThreadId: RuntimeThread["lineage"]["rootThreadId"];
  readonly archived: boolean;
  readonly nativeCall?: AgentRuntimeNativeToolCall;
  readonly providerSessionId: string;
  readonly nativeGeneration: number;
}
export interface AgentRuntimeRunAuthorityEvidence extends AgentRuntimeAuthorityFrame {
  readonly runId: RuntimeRun["id"];
  readonly status: RuntimeRun["status"];
}
export interface AgentRuntimeNativeSessionAuthorityEvidence extends AgentRuntimeAuthorityFrame {
  readonly runId: null;
  readonly status: null;
  readonly incarnationId: string;
}
export type AgentRuntimeAuthorityEvidence =
  | AgentRuntimeRunAuthorityEvidence
  | AgentRuntimeNativeSessionAuthorityEvidence;

export interface AgentRuntimeAuthorityObservation {
  readonly identity: AgentRuntimeAuthorityIdentity;
  readonly phase: "prepare" | "capture";
  readonly nativeCall?: AgentRuntimeNativeToolCall;
}

export interface AgentRuntimeAuthorityOptions {
  readonly runtimeId: string;
  /** A supervisor may supply its freshly minted connection identity. */
  readonly leaseId?: string;
  readonly observe: (
    request: AgentRuntimeAuthorityObservation,
  ) => Effect.Effect<AgentRuntimeAuthorityEvidence | null, unknown>;
}

export interface AgentRuntimePreparedAuthority {
  readonly sessionId: string;
  readonly identity: AgentRuntimeAuthorityIdentity;
  readonly context: NodexAgentTurnContext;
  readonly provenance: TurnProvenance;
}

export class AgentRuntimeAuthorityError extends Schema.TaggedError<AgentRuntimeAuthorityError>()(
  "AgentRuntimeAuthorityError",
  { operation: Schema.String, message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

const unavailable = (operation: string, cause?: unknown) =>
  new AgentRuntimeAuthorityError({
    operation,
    message: "Agent Runtime content authority is unavailable",
    ...(cause === undefined ? {} : { cause }),
  });

const sameFrame = (left: AgentRuntimeAuthorityEvidence, right: AgentRuntimeAuthorityEvidence) => {
  if (
    !(
      left.runtimeId === right.runtimeId &&
      left.leaseId === right.leaseId &&
      left.threadId === right.threadId &&
      left.runId === right.runId &&
      left.providerSessionId === right.providerSessionId &&
      left.nativeGeneration === right.nativeGeneration &&
      left.rootThreadId === right.rootThreadId
    )
  )
    return false;
  if (left.runId !== null) return true;
  return right.runId === null && left.incarnationId === right.incarnationId;
};

const sameCall = (
  left: AgentRuntimeNativeToolCall | undefined,
  right: AgentRuntimeNativeToolCall,
) => {
  if (!left) return false;
  return (
    left.providerThreadId === right.providerThreadId &&
    left.providerTurnId === right.providerTurnId &&
    left.callId === right.callId
  );
};

const isRevokedRun = (status: RuntimeRun["status"]) =>
  status === "cancelled" || status === "interrupted" || status === "rolled_back";

const validIdentity = (value: string) =>
  value.length > 0 && value.trim() === value && value.length <= 512;

/** One connection scope owns credentials; every capture re-observes engine and Core truth. */
export const make = Effect.fn("AgentRuntimeAuthority.make")(function* (
  options: AgentRuntimeAuthorityOptions,
) {
  const core = yield* CoreModules;
  const authority = yield* CoreAuthority;
  const leaseId = options.leaseId ?? createOperationId("agent-runtime.lease");
  const lifetime = yield* Ref.make<"open" | "closing" | "closed">("open");
  const leaseGate = yield* Semaphore.make(1);
  if (!validIdentity(options.runtimeId) || !validIdentity(leaseId))
    return yield* unavailable("open");

  const host = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    operation.pipe(Effect.provideService(CoreApplicationAgent, null));

  const identityOf = (evidence: AgentRuntimeAuthorityEvidence): AgentRuntimeAuthorityIdentity => {
    const common = {
      runtime_id: options.runtimeId,
      thread_id: evidence.threadId,
      lease_id: leaseId,
    };
    return evidence.runId === null
      ? {
          ...common,
          provider_session_id: evidence.providerSessionId,
          native_generation: evidence.nativeGeneration,
          incarnation_id: evidence.incarnationId,
        }
      : { ...common, run_id: evidence.runId };
  };
  const sameIdentity = (
    left: AgentRuntimeAuthorityIdentity,
    right: AgentRuntimeAuthorityIdentity,
  ) => {
    if (
      left.runtime_id !== right.runtime_id ||
      left.thread_id !== right.thread_id ||
      left.lease_id !== right.lease_id
    )
      return false;
    if ("run_id" in left) return "run_id" in right && left.run_id === right.run_id;
    return (
      !("run_id" in right) &&
      left.provider_session_id === right.provider_session_id &&
      left.native_generation === right.native_generation &&
      left.incarnation_id === right.incarnation_id
    );
  };

  const verify = Effect.fn("AgentRuntimeAuthority.verify")(function* (
    evidence: AgentRuntimeAuthorityEvidence,
    phase: "prepare" | "capture",
    nativeCall?: AgentRuntimeNativeToolCall,
  ) {
    if ((yield* Ref.get(lifetime)) !== "open") return yield* unavailable(phase);
    if (
      evidence.runtimeId !== options.runtimeId ||
      evidence.leaseId !== leaseId ||
      !validIdentity(evidence.threadId) ||
      !validIdentity(evidence.providerSessionId) ||
      !Number.isInteger(evidence.nativeGeneration) ||
      evidence.nativeGeneration <= 0 ||
      (evidence.runId !== null
        ? !validIdentity(evidence.runId)
        : !validIdentity(evidence.incarnationId)) ||
      !validIdentity(evidence.rootThreadId)
    )
      return yield* unavailable(phase);
    const observed = yield* options
      .observe({ identity: identityOf(evidence), phase, ...(nativeCall ? { nativeCall } : {}) })
      .pipe(Effect.mapError((cause) => unavailable(phase, cause)));
    if (
      !observed ||
      !sameFrame(observed, evidence) ||
      (observed.status !== null && isRevokedRun(observed.status))
    )
      return yield* unavailable(phase);
    if (phase === "capture" && (!nativeCall || !sameCall(observed.nativeCall, nativeCall)))
      return yield* unavailable(phase);
    return observed;
  });

  const bindingFor = Effect.fn("AgentRuntimeAuthority.bindingFor")(function* (
    evidence: AgentRuntimeAuthorityEvidence,
    sessionHint?: string,
  ) {
    const snapshot = yield* host(
      core.workspace.read(
        {
          kind: "agent_runtime_session_binding_by_execution",
          runtime_id: options.runtimeId,
          runtime_thread_id: evidence.rootThreadId,
        },
        undefined,
        evidence.projectId,
      ),
    );
    if (snapshot.value.kind !== "agent_runtime_session_binding")
      return yield* unavailable("binding");
    const binding = snapshot.value.binding;
    if (
      !binding ||
      binding.runtime_id !== options.runtimeId ||
      binding.runtime_thread_id !== evidence.rootThreadId ||
      (sessionHint !== undefined && sessionHint !== binding.session_id)
    )
      return yield* unavailable("binding");
    return { ...binding, project_id: binding.project_id ?? null } satisfies NormalizedBinding;
  });

  const readContext = Effect.fn("AgentRuntimeAuthority.readContext")(function* (
    identity: AgentRuntimeAuthorityIdentity,
    projectId: string | null,
  ) {
    const snapshot = yield* host(
      core.workspace.read(
        {
          ...("run_id" in identity
            ? ({ kind: "agent_runtime_turn_authority", identity } as const)
            : ({ kind: "agent_runtime_native_session_authority", identity } as const)),
        },
        undefined,
        projectId,
      ),
    );
    if (
      snapshot.value.kind !== "agent_runtime_turn_authority" &&
      snapshot.value.kind !== "agent_runtime_native_session_authority"
    )
      return yield* unavailable("read");
    if (!snapshot.value.resolution.persisted) return null;
    const context = projectNativeTurnContext(snapshot.value.resolution);
    if (
      !context ||
      context.libraryId !== authority.identity.libraryId ||
      context.storeEpoch !== authority.identity.storeEpoch
    )
      return yield* unavailable("read");
    return context;
  });

  const revokeOwned = Effect.fn("AgentRuntimeAuthority.revoke")(
    function* (identity: AgentRuntimeAuthorityIdentity) {
      if (identity.runtime_id !== options.runtimeId || identity.lease_id !== leaseId)
        return yield* unavailable("revoke");
      yield* host(
        core.workspace.apply({
          operationId: createOperationId("agent-runtime.revoke-turn"),
          intent:
            "run_id" in identity
              ? { kind: "revoke_agent_runtime_turn_authority", identity }
              : { kind: "revoke_agent_runtime_native_session_authority", identity },
        }),
      );
    },
    Effect.mapError((cause) =>
      Schema.is(AgentRuntimeAuthorityError)(cause) ? cause : unavailable("revoke", cause),
    ),
  );

  const admit = Effect.fn("AgentRuntimeAuthority.admit")(
    function* (input: {
      readonly evidence: AgentRuntimeAuthorityEvidence;
      readonly sessionId?: string;
      readonly parent?: AgentRuntimeRunAuthorityIdentity;
    }) {
      const current = yield* verify(input.evidence, "prepare");
      const binding = yield* bindingFor(current, input.sessionId);
      const identity = identityOf(current);
      // Session actors arrive through tool calls. Reuse their durable admission rather
      // than writing a receipt and invalidation for every content query.
      let context = "run_id" in identity ? null : yield* readContext(identity, binding.project_id);
      if (context === null) {
        yield* host(
          core.workspace.apply(
            {
              operationId: createOperationId("agent-runtime.admit-turn"),
              intent:
                "run_id" in identity
                  ? {
                      kind: "admit_agent_runtime_turn_authority",
                      session_id: binding.session_id,
                      identity,
                      native_source: {
                        provider_session_id: current.providerSessionId,
                        native_generation: current.nativeGeneration,
                      },
                      ...(input.parent ? { parent: input.parent } : {}),
                    }
                  : {
                      kind: "admit_agent_runtime_native_session_authority",
                      session_id: binding.session_id,
                      identity,
                    },
            },
            undefined,
            binding.project_id,
          ),
        );
        context = yield* readContext(identity, binding.project_id);
      }
      if (!context) return yield* unavailable("admit");
      yield* verify(current, "prepare").pipe(Effect.tapError(() => revokeOwned(identity)));
      return {
        sessionId: binding.session_id,
        identity,
        context,
        provenance: toCoreAgentTurnProvenance(authority.identity.profileId, context),
      } satisfies AgentRuntimePreparedAuthority;
    },
    (operation) => leaseGate.withPermit(operation),
    Effect.mapError((cause) =>
      Schema.is(AgentRuntimeAuthorityError)(cause) ? cause : unavailable("prepare", cause),
    ),
  );
  const prepareTurn = (input: {
    readonly evidence: AgentRuntimeRunAuthorityEvidence;
    readonly sessionId?: string;
    readonly parent?: AgentRuntimeRunAuthorityIdentity;
  }) => admit(input);
  const prepareNativeSession = (input: {
    readonly evidence: AgentRuntimeNativeSessionAuthorityEvidence;
    readonly sessionId?: string;
  }) => admit(input);

  const capture = Effect.fn("AgentRuntimeAuthority.capture")(
    function* (input: {
      readonly evidence: AgentRuntimeAuthorityEvidence;
      readonly identity: AgentRuntimeAuthorityIdentity;
      readonly nativeCall: AgentRuntimeNativeToolCall;
    }) {
      if (!sameIdentity(input.identity, identityOf(input.evidence)))
        return yield* unavailable("capture");
      const observed = yield* verify(input.evidence, "capture", input.nativeCall);
      const binding = yield* bindingFor(observed);
      const context = yield* readContext(input.identity, binding.project_id);
      if (!context) return yield* unavailable("capture");
      yield* verify(observed, "capture", input.nativeCall);
      return {
        sessionId: binding.session_id,
        identity: input.identity,
        context,
        provenance: toCoreAgentTurnProvenance(authority.identity.profileId, context),
      } satisfies AgentRuntimePreparedAuthority;
    },
    (operation) => leaseGate.withPermit(operation),
    Effect.mapError((cause) =>
      Schema.is(AgentRuntimeAuthorityError)(cause) ? cause : unavailable("capture", cause),
    ),
  );

  const close = Effect.gen(function* () {
    if ((yield* Ref.get(lifetime)) === "closed") return;
    yield* Ref.set(lifetime, "closing");
    yield* host(
      core.workspace.apply({
        operationId: createOperationId("agent-runtime.revoke-lease"),
        intent: {
          kind: "revoke_agent_runtime_authorities",
          runtime_id: options.runtimeId,
          lease_id: leaseId,
        },
      }),
    );
    yield* Ref.set(lifetime, "closed");
  }).pipe(
    (operation) => leaseGate.withPermit(operation),
    Effect.uninterruptible,
    Effect.mapError((cause) =>
      Schema.is(AgentRuntimeAuthorityError)(cause) ? cause : unavailable("close", cause),
    ),
  );
  yield* Effect.addFinalizer(() => close.pipe(Effect.orDie));
  const revoke = (identity: AgentRuntimeAuthorityIdentity) =>
    leaseGate.withPermit(revokeOwned(identity));
  const revokeNativeSource = (source: {
    readonly providerSessionId: string;
    readonly nativeGeneration: number;
  }) =>
    leaseGate.withPermit(
      host(
        core.workspace.apply({
          operationId: createOperationId("agent-runtime.revoke-native-source"),
          intent: {
            kind: "revoke_agent_runtime_native_source_authorities",
            runtime_id: options.runtimeId,
            lease_id: leaseId,
            native_source: {
              provider_session_id: source.providerSessionId,
              native_generation: source.nativeGeneration,
            },
          },
        }),
      ).pipe(Effect.asVoid),
    );
  const readAdmissions = (after?: string) =>
    host(
      core.workspace.read({
        kind: "agent_runtime_admission_window",
        runtime_id: options.runtimeId,
        lease_id: leaseId,
        window: { first: 200, ...(after ? { after } : {}) },
      }),
    ).pipe(
      Effect.flatMap((snapshot) =>
        snapshot.value.kind === "agent_runtime_admission_window"
          ? Effect.succeed(snapshot.value.admissions)
          : Effect.fail(unavailable("admissions")),
      ),
    );
  return {
    runtimeId: options.runtimeId,
    leaseId,
    prepareTurn,
    prepareNativeSession,
    capture,
    revoke,
    revokeNativeSource,
    readAdmissions,
    close,
  };
});

export class AgentRuntimeAuthority extends Context.Service<
  AgentRuntimeAuthority,
  Effect.Success<ReturnType<typeof make>>
>()("nodex/main/agent-runtime/AgentRuntimeAuthority") {}

export const layer = (options: AgentRuntimeAuthorityOptions) =>
  Layer.effect(AgentRuntimeAuthority, make(options));
