import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";

type CoreAuthorityResolution = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { readonly kind: "turn_authority" }
>["resolution"];

export const projectNativeTurnContext = (
  resolution: CoreAuthorityResolution,
): NodexAgentTurnContext | null => {
  if (!resolution.persisted || !resolution.authority || resolution.admitted_at_ms == null)
    return null;
  const authority = resolution.authority;
  return {
    threadId: authority.thread_id,
    turnId: authority.turn_id,
    rootThreadId: authority.root_thread_id,
    actorProjectId: authority.actor_project_id ?? null,
    libraryId: authority.library_id,
    storeEpoch: authority.store_epoch,
    admittedAtMs: resolution.admitted_at_ms,
  };
};
