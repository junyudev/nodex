import type {
  AgentNativeSessionAuthority,
  AgentThreadAuthority,
} from "@nodex/agent-runtime/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import { toCoreAgentTurnProvenance } from "../core-client/core-agent-execution-authorization";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";

/** The engine's current account of one live execution, read for every call. */
export type AgentRuntimeExecutionProof = AgentThreadAuthority | AgentNativeSessionAuthority;

export interface AgentRuntimeAuthorizedExecution {
  readonly sessionId: string;
  readonly context: NodexAgentTurnContext;
  readonly provenance: ReturnType<typeof toCoreAgentTurnProvenance>;
}

export class AgentRuntimeAuthorityError extends Schema.TaggedError<AgentRuntimeAuthorityError>()(
  "AgentRuntimeAuthorityError",
  { message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

const unavailable = (cause?: unknown) =>
  new AgentRuntimeAuthorityError({
    message: "Agent Runtime content authority is unavailable",
    ...(cause === undefined ? {} : { cause }),
  });

/**
 * Derives Core authority for an execution the engine has just proven live. Main writes nothing:
 * Core validates the Session binding inside every use, and a cancelled Run, closed native
 * connection, or replaced engine process fails the next proof instead of awaiting revocation.
 */
export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const authority = yield* CoreAuthority;
  return Effect.fn("AgentRuntimeAuthority.authorize")(
    function* (proof: AgentRuntimeExecutionProof, routeProjectId: string | null) {
      const snapshot = yield* core.workspace
        .read(
          {
            kind: "agent_runtime_session_binding_by_execution",
            runtime_id: proof.runtimeId,
            runtime_thread_id: proof.rootThreadId,
          },
          undefined,
          routeProjectId,
        )
        .pipe(Effect.provideService(CoreApplicationAgent, null));
      const binding =
        snapshot.value.kind === "agent_runtime_session_binding" ? snapshot.value.binding : null;
      if (!binding) return yield* unavailable();
      const context: NodexAgentTurnContext = {
        threadId: proof.threadId,
        turnId: proof.runId ?? proof.incarnationId,
        rootThreadId: proof.rootThreadId,
        actorProjectId: binding.project_id ?? null,
        libraryId: authority.identity.libraryId,
        storeEpoch: authority.identity.storeEpoch,
        admittedAtMs: proof.admittedAtMs,
        runtime: {
          sessionId: binding.session_id,
          runtimeId: proof.runtimeId,
          turnKind: proof.runId === null ? "native_connection" : "run",
        },
      };
      return {
        sessionId: binding.session_id,
        context,
        provenance: toCoreAgentTurnProvenance(authority.identity.profileId, context),
      } satisfies AgentRuntimeAuthorizedExecution;
    },
    Effect.mapError((cause) =>
      Schema.is(AgentRuntimeAuthorityError)(cause) ? cause : unavailable(cause),
    ),
  );
});
