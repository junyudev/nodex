import type { CodexCanonicalTurnState } from "./types";

export interface CodexSubagentInteractionReference {
  readonly parentTurnKey: string;
  readonly canInteract: boolean;
}

/** Activity reports execution; only an explicit collaborative spawn grants messaging. */
export function advanceCodexSubagentInteraction(
  previous: CodexSubagentInteractionReference | undefined,
  parentTurnKey: string,
  source: "activity" | "spawn" | "collaboration",
): boolean {
  if (source === "spawn") return true;
  if (source === "activity" && previous?.parentTurnKey !== parentTurnKey) return false;
  return previous?.canInteract === true;
}

/** Reads resident parent history only. Missing history or metadata is never a grant. */
export function collectCodexSubagentInteractionReferences(
  turns: readonly Pick<CodexCanonicalTurnState, "turnId" | "items">[],
): ReadonlyMap<string, CodexSubagentInteractionReference> {
  const references = new Map<string, CodexSubagentInteractionReference>();
  turns.forEach((turn, index) => {
    const parentTurnKey = turn.turnId ?? `turn-index-${index}`;
    for (const item of turn.items) {
      if (item.type === "subAgentActivity") {
        if (item.kind === "interacted" && !references.has(item.agentThreadId)) continue;
        references.set(item.agentThreadId, {
          parentTurnKey,
          canInteract: advanceCodexSubagentInteraction(
            references.get(item.agentThreadId),
            parentTurnKey,
            "activity",
          ),
        });
        continue;
      }
      if (item.type !== "collabAgentToolCall") continue;
      for (const threadId of item.receiverThreadIds) {
        references.set(threadId, {
          parentTurnKey,
          canInteract: advanceCodexSubagentInteraction(
            references.get(threadId),
            parentTurnKey,
            item.tool === "spawnAgent" ? "spawn" : "collaboration",
          ),
        });
      }
    }
  });
  return references;
}
