import type {
  CodexPromptRailIndex,
  CodexPromptRailIndexCommandResult,
  CodexPromptRailIndexRequest,
  CodexPromptRailReveal,
  CodexPromptRailRevealCommandResult,
  CodexPromptRailRevealRequest,
  CodexPromptRailRevealTarget,
} from "../../../shared/codex-prompt-rail-history";
import type { ConversationPromptRailPort } from "./conversation-runtime";

/** The native prompt reads of one Codex conversation manager. */
export interface CodexPromptRailClient {
  readonly loadPromptRailIndex: (
    request: CodexPromptRailIndexRequest,
  ) => Promise<CodexPromptRailIndexCommandResult>;
  readonly revealPromptRail: (
    request: CodexPromptRailRevealRequest,
  ) => Promise<CodexPromptRailRevealCommandResult>;
  /** Hydrates a revealed Turn's native match into the manager's canonical history. */
  readonly preparePromptRailNavigation: (reveal: CodexPromptRailReveal) => Promise<void>;
}

let nextRequestOrdinal = 0;
const makeRequestId = (kind: "index" | "reveal"): string => {
  nextRequestOrdinal += 1;
  return `prompt-rail:${kind}:${Date.now()}:${nextRequestOrdinal}`;
};

/** Missing identities take the Main-owned, request-capped identity-seek path. */
export function resolveCodexPromptRailRevealTarget(
  index: CodexPromptRailIndex,
  turnId: string,
): CodexPromptRailRevealTarget {
  const shell = index.shells.find((candidate) => candidate.turnId === turnId);
  return shell ? { kind: "shell", shell } : { kind: "knownTurn", turnId };
}

/**
 * The prompt rail over one admitted conversation topology. Results must answer this port's own
 * requests for the same Thread, host generation and topology; anything else is stale.
 */
export function createCodexPromptRailPort(input: {
  readonly client: CodexPromptRailClient;
  readonly threadId: string;
  readonly topologyGeneration: number;
}): ConversationPromptRailPort {
  const { client, threadId, topologyGeneration } = input;
  let index: CodexPromptRailIndex | null = null;

  const reveal = async (turnId: string): Promise<CodexPromptRailReveal | null> => {
    const current = index;
    if (!current) return null;
    const requestId = makeRequestId("reveal");
    const result = await client.revealPromptRail({
      requestId,
      threadId,
      hostId: current.hostId,
      generation: current.generation,
      expectedTopologyGeneration: topologyGeneration,
      target: resolveCodexPromptRailRevealTarget(current, turnId),
    });
    if (result.status !== "completed" || result.requestId !== requestId) return null;
    const revealed = result.reveal;
    return result.expectedTopologyGeneration === topologyGeneration &&
      revealed.threadId === threadId &&
      revealed.hostId === current.hostId &&
      revealed.generation === current.generation &&
      revealed.turnId === turnId &&
      revealed.topologyGeneration === topologyGeneration
      ? revealed
      : null;
  };

  return {
    loadIndex: async () => {
      const requestId = makeRequestId("index");
      const result = await client.loadPromptRailIndex({
        requestId,
        threadId,
        expectedTopologyGeneration: topologyGeneration,
      });
      index =
        result.status === "completed" &&
        result.requestId === requestId &&
        result.expectedTopologyGeneration === topologyGeneration &&
        result.index.threadId === threadId
          ? result.index
          : null;
      return index?.shells.map((shell) => ({ turnId: shell.turnId })) ?? null;
    },
    preview: async (turnId) => (await reveal(turnId))?.previews ?? null,
    // Navigation revalidates the native locator before installing its history window.
    install: async (turnId, signal) => {
      const revealed = await reveal(turnId);
      if (!revealed || signal.aborted) return "stale";
      await client.preparePromptRailNavigation(revealed);
      return "applied";
    },
  };
}
