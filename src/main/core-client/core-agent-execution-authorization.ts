import type { components } from "@nodex/core-protocol";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";

export const toCoreAgentTurnProvenance = (profileId: string, context: NodexAgentTurnContext) =>
  ({
    profile_id: profileId,
    authority: {
      thread_id: context.threadId,
      turn_id: context.turnId,
      root_thread_id: context.rootThreadId,
      actor_project_id: context.actorProjectId,
      library_id: context.libraryId,
      store_epoch: context.storeEpoch,
      ...(context.runtime
        ? {
            runtime: {
              session_id: context.runtime.sessionId,
              runtime_id: context.runtime.runtimeId,
              turn_kind: context.runtime.turnKind,
            },
          }
        : {}),
    },
  }) as const;

export const toCoreAgentExecutionAuthorization = (
  profileId: string,
  context: NodexAgentTurnContext,
  callId: string,
): components["schemas"]["AgentExecutionAuthorization"] => ({
  provenance: toCoreAgentTurnProvenance(profileId, context),
  call_id: callId,
});
