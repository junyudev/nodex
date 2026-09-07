import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import type { NodexAgentAccess } from "../../shared/nodex-agent-tools";
import type { SandboxPolicy } from "@nodex/codex-app-server-protocol/v2/SandboxPolicy";

/** Unknown or externally managed sandbox policy cannot authorize application writes. */
export const isNodexAgentTurnReadOnly = (input: {
  readonly planMode: boolean;
  readonly sandboxPolicy: Pick<SandboxPolicy, "type"> | null | undefined;
}): boolean =>
  input.planMode ||
  (input.sandboxPolicy?.type !== "workspaceWrite" &&
    input.sandboxPolicy?.type !== "dangerFullAccess");

export const resolveNodexAgentWriteAccess = (input: {
  readonly authorityScope: FrozenNodexAgentTurnAuthority["scope"] | null;
  readonly hasFrozenAuthority: boolean;
}): NodexAgentAccess["write"] => {
  if (!input.hasFrozenAuthority || input.authorityScope === null) {
    return "unavailable";
  }
  return "granted";
};
