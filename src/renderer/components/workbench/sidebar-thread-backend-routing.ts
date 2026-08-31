import { isCodexAgentBackendBinding } from "../../../shared/agent-backend";
import type { CodexSidebarThreadItem } from "../../../shared/types";

export type SidebarThreadMutationAuthority =
  | { readonly kind: "codex"; readonly threadId: string }
  | { readonly kind: "workspace"; readonly sessionId: string }
  | { readonly kind: "unavailable" };

/** Routes each durable Thread mutation to the backend that owns its identity. */
export function resolveSidebarThreadMutationAuthority(
  item: Pick<CodexSidebarThreadItem, "backendBinding" | "sessionId" | "threadId">,
): SidebarThreadMutationAuthority {
  if (isCodexAgentBackendBinding(item.backendBinding)) {
    return { kind: "codex", threadId: item.threadId };
  }
  if (item.sessionId) return { kind: "workspace", sessionId: item.sessionId };
  return { kind: "unavailable" };
}
