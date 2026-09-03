import type { ThreadItem, Turn } from "@nodex/codex-app-server-protocol/v2";
import type { CodexConversationHistoryMutation } from "./codex-conversation-history-page";
import type { CodexHistoryTurnItemsPagination } from "./codex-conversation-state/codex-history-topology";
import type { CodexThreadHistoryFeatureUnavailable } from "./codex-thread-history-features";

export const CODEX_PROMPT_RAIL_PAGE_SIZE = 100;
export const CODEX_PROMPT_RAIL_MAX_PAGES = 10;
export const CODEX_PROMPT_RAIL_MAX_SHELLS =
  CODEX_PROMPT_RAIL_PAGE_SIZE * CODEX_PROMPT_RAIL_MAX_PAGES;
export const CODEX_PROMPT_RAIL_MAX_INDEX_BYTES = 512 * 1024;
export const CODEX_PROMPT_RAIL_STALE_MS = 30_000;
export const CODEX_PROMPT_RAIL_LOAD_DEADLINE_MS = 30_000;
export const CODEX_PROMPT_RAIL_PREVIEW_CODE_POINTS = 240;

/** Validates the renderer-provided locator before it can become an app-server page limit. */
export const isValidCodexPromptRailDescendingOffset = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value < CODEX_PROMPT_RAIL_PAGE_SIZE;

/** An ephemeral locator. It deliberately contains no Turn items or render state. */
export interface CodexPromptRailTurnShell {
  readonly turnId: string;
  readonly pageBackwardsCursor: string | null;
  readonly descendingOffset: number;
}

export interface CodexPromptRailIndex {
  readonly threadId: string;
  readonly hostId: string;
  readonly generation: number;
  readonly shells: readonly CodexPromptRailTurnShell[];
  readonly complete: boolean;
  readonly truncatedBy: "byte-budget" | "page-budget" | null;
  readonly approximateBytes: number;
  readonly loadedAtMs: number;
}

export interface CodexPromptRailPreview {
  readonly itemId: string;
  readonly promptPreview: string;
  readonly responsePreview: string;
  readonly isHeartbeat: boolean;
}

export interface CodexPromptRailReveal {
  readonly threadId: string;
  readonly hostId: string;
  readonly generation: number;
  readonly turnId: string;
  readonly topologyGeneration: number;
  readonly previews: readonly CodexPromptRailPreview[];
  /** One bounded Main-authored island mutation; raw Turns never cross into renderer state. */
  readonly mutation: CodexConversationHistoryMutation;
}

/** A renderer request identity is scoped to one renderer and lives only for one IPC call. */
export interface CodexPromptRailIndexRequest {
  readonly requestId: string;
  readonly threadId: string;
  readonly expectedTopologyGeneration: number;
  readonly force?: boolean;
}

export type CodexPromptRailRevealTarget =
  | {
      readonly kind: "shell";
      readonly shell: CodexPromptRailTurnShell;
    }
  | {
      /** Explicit identities may live beyond the bounded shell index. */
      readonly kind: "knownTurn";
      readonly turnId: string;
    };

export interface CodexPromptRailRevealRequest {
  readonly requestId: string;
  readonly threadId: string;
  readonly hostId: string;
  readonly generation: number;
  readonly expectedTopologyGeneration: number;
  readonly target: CodexPromptRailRevealTarget;
}

export type CodexPromptRailIndexCommandResult =
  | {
      readonly status: "completed";
      readonly requestId: string;
      readonly expectedTopologyGeneration: number;
      readonly index: CodexPromptRailIndex;
    }
  | {
      readonly status: "cancelled";
      readonly requestId: string;
    }
  | {
      readonly status: "unavailable";
      readonly requestId: string;
      readonly availability: CodexThreadHistoryFeatureUnavailable;
    };

export type CodexPromptRailRevealCommandResult =
  | {
      readonly status: "completed";
      readonly requestId: string;
      readonly expectedTopologyGeneration: number;
      readonly reveal: CodexPromptRailReveal;
    }
  | {
      readonly status: "cancelled";
      readonly requestId: string;
    }
  | {
      readonly status: "unavailable";
      readonly requestId: string;
      readonly availability: CodexThreadHistoryFeatureUnavailable;
    };

type CodexPromptRailUserContent = Extract<ThreadItem, { readonly type: "userMessage" }>["content"];

const textFromInput = (content: CodexPromptRailUserContent): string =>
  content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");

/** Truncates by Unicode code point so surrogate pairs are never split. */
export function truncateCodexPromptRailPreview(
  value: string,
  maximumCodePoints = CODEX_PROMPT_RAIL_PREVIEW_CODE_POINTS,
): string {
  const codePoints = Array.from(value.trim());
  if (codePoints.length <= maximumCodePoints) return codePoints.join("");
  if (maximumCodePoints <= 0) return "";
  if (maximumCodePoints === 1) return "…";
  return `${codePoints.slice(0, maximumCodePoints - 1).join("")}…`;
}

const promptItemsWithOpening = (
  turn: Turn,
  pagination: CodexHistoryTurnItemsPagination,
): readonly ThreadItem[] => {
  const openingId = pagination.openingUserMessageId;
  const openingContent = pagination.oldestUserInput;
  if (!openingId || !openingContent || turn.items.some((item) => item.id === openingId)) {
    return turn.items;
  }
  return [
    {
      type: "userMessage",
      id: openingId,
      clientId: null,
      content: [...openingContent],
    },
    ...turn.items,
  ];
};

export function buildCodexPromptRailPreviews(input: {
  readonly turn: Turn;
  readonly pagination: CodexHistoryTurnItemsPagination;
  readonly maximumCodePoints?: number;
}): readonly CodexPromptRailPreview[] {
  const maximumCodePoints = input.maximumCodePoints ?? CODEX_PROMPT_RAIL_PREVIEW_CODE_POINTS;
  const previews: Array<{
    itemId: string;
    promptPreview: string;
    responsePreview: string;
    isHeartbeat: boolean;
  }> = [];
  for (const item of promptItemsWithOpening(input.turn, input.pagination)) {
    if (item.type === "userMessage") {
      const prompt = textFromInput(item.content);
      previews.push({
        itemId: item.id,
        promptPreview: truncateCodexPromptRailPreview(prompt, maximumCodePoints),
        responsePreview: "",
        isHeartbeat: prompt.includes("Sent by scheduled task"),
      });
      continue;
    }
    if (item.type !== "agentMessage") continue;
    const latest = previews.at(-1);
    if (!latest) continue;
    latest.responsePreview = truncateCodexPromptRailPreview(item.text, maximumCodePoints);
  }
  return previews;
}
