import type { OrchestrationV2ProjectedTurnItem, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { isThreadHistoryTurnStart } from "./threadHistoryPaging.ts";

/** The newest prompts an index lists; older prompts appear once their history loads. */
export const THREAD_PROMPT_INDEX_MAX_PROMPTS = 1_000;
/**
 * Raw text bounds. Readers derive the displayed preview after removing the app context
 * reference that can end a prompt, so a prompt keeps room for that whole reference.
 */
export const THREAD_PROMPT_INDEX_PROMPT_CHARACTERS = 1_024;
export const THREAD_PROMPT_INDEX_RESPONSE_CHARACTERS = 256;

/** One Run's opening prompt and its latest reply. */
export interface ThreadPromptIndexEntry {
  readonly runId: string;
  readonly messageId: string;
  readonly prompt: string;
  /** Empty until the Run replies. */
  readonly response: string;
  readonly scheduled: boolean;
}

/** The thread's own Runs, oldest first, without loading their history. */
export interface ThreadPromptIndex {
  readonly prompts: ReadonlyArray<ThreadPromptIndexEntry>;
  /** False when older prompts exceed the index bound. */
  readonly complete: boolean;
}

/** The addressed items whose text completes one index entry. */
export interface ThreadPromptIndexSlot {
  readonly runId: string;
  readonly messageId: string;
  readonly promptItemId: string;
  readonly responseItemId: string | null;
}

type PromptIndexRow = Pick<OrchestrationV2ProjectedTurnItem, "visibility"> & {
  readonly sourceItemId: string;
  readonly item: Pick<OrchestrationV2TurnItem, "type" | "runId"> & {
    readonly inputIntent?: string;
    readonly messageId?: string;
  };
};

/**
 * Selects each local Run's opening prompt and latest reply from a chronological visible
 * timeline. Inherited and run-less history has no Run of this thread to navigate to.
 */
export function selectThreadPromptIndexSlots(rows: ReadonlyArray<PromptIndexRow>): {
  readonly slots: ReadonlyArray<ThreadPromptIndexSlot>;
  readonly complete: boolean;
} {
  const slots: Array<{
    -readonly [Key in keyof ThreadPromptIndexSlot]: ThreadPromptIndexSlot[Key];
  }> = [];
  const slotsByRunId = new Map<string, (typeof slots)[number]>();
  for (const row of rows) {
    const { item } = row;
    if (row.visibility !== "local" || item.runId === null) continue;
    if (item.type === "assistant_message") {
      const slot = slotsByRunId.get(item.runId);
      if (slot) slot.responseItemId = row.sourceItemId;
      continue;
    }
    if (
      !isThreadHistoryTurnStart(item) ||
      item.messageId === undefined ||
      slotsByRunId.has(item.runId)
    )
      continue;
    const slot = {
      runId: item.runId,
      messageId: item.messageId,
      promptItemId: row.sourceItemId,
      responseItemId: null,
    };
    slotsByRunId.set(item.runId, slot);
    slots.push(slot);
  }
  return {
    slots: slots.slice(-THREAD_PROMPT_INDEX_MAX_PROMPTS),
    complete: slots.length <= THREAD_PROMPT_INDEX_MAX_PROMPTS,
  };
}

/** Bounds by code point, so a surrogate pair is never split. */
export function boundThreadPromptText(text: string, characters: number): string {
  return Array.from(text.slice(0, characters * 2))
    .slice(0, characters)
    .join("");
}
