import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2/ThreadItem";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { stripCodexRemarkDirectiveLines } from "../../shared/codex-remark-directives";
import type { CodexTranscriptEntry, CodexUserAttachment } from "../../shared/types";
import {
  CODEX_HISTORY_ITEM_PAGE_SIZE,
  CODEX_HISTORY_TURN_PAGE_SIZE,
  type CodexHistoryPageAdapter,
  type CodexHistoryPageAdapterError,
  type CodexHydratedHistoryItemPage,
  type CodexHydratedHistoryTurnPage,
} from "../codex-application/CodexHistoryPageAdapter";
import {
  type CodexAppServerCapabilitySnapshot,
  type CodexAppServerCapabilities,
} from "../codex-runtime/CodexAppServerCapabilities";

export const AUTOMATION_ARCHIVE_TURN_CAPTURE_LIMIT = 20;
export const AUTOMATION_ARCHIVE_ITEM_CAPTURE_LIMIT = 500;
export const AUTOMATION_ARCHIVE_PROJECTED_BYTE_LIMIT = 8 * 1024 * 1024;
const AUTOMATION_ARCHIVE_PHYSICAL_PAGE_REQUEST_LIMIT = 20;

export interface AutomationArchiveMessages {
  readonly archivedUserMessage: string | null;
  readonly archivedAssistantMessage: string | null;
}

export type AutomationArchiveExcerptTruncationReason =
  | "byte-limit"
  | "item-limit"
  | "pagination-limit"
  | "turn-limit";

/**
 * `satisfied` means both archive fields were found; `exhausted` means the available history was
 * fully inspected. A bounded stop is always represented as `truncated`, never as completeness.
 */
export interface AutomationArchiveExcerpt {
  readonly messages: AutomationArchiveMessages;
  readonly resolution: "exhausted" | "satisfied" | "truncated";
  readonly truncationReason: AutomationArchiveExcerptTruncationReason | null;
  readonly inspectedTurnCount: number;
  readonly inspectedItemCount: number;
  readonly approximateProjectedBytes: number;
}

export class AutomationArchiveExcerptError extends Data.TaggedError(
  "AutomationArchiveExcerptError",
)<{
  readonly threadId: string;
  readonly reason: "capability-unavailable" | "stale-generation" | "unsupported-history";
  readonly cause: unknown;
}> {}

const emptyMessages = (): AutomationArchiveMessages => ({
  archivedUserMessage: null,
  archivedAssistantMessage: null,
});

const normalizeArchiveText = (value: string | null | undefined): string | null => {
  const normalized = stripCodexRemarkDirectiveLines(value);
  return normalized.length > 0 ? normalized : null;
};

const formatArchiveAttachment = (attachment: CodexUserAttachment): string =>
  attachment.type === "image"
    ? `image: ${attachment.source}`
    : `${attachment.sourceKind === "skill" ? "skill" : "mention"}: ${attachment.label} (${attachment.path})`;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const nonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
};

const formatRawArchiveContent = (value: unknown): string | null => {
  const item = asRecord(value);
  if (!item) return null;
  const type = nonEmptyString(item.type);
  if (type === "text") return nonEmptyString(item.text);
  if (type === "image" || type === "localImage" || type === "audio" || type === "localAudio") {
    const source =
      nonEmptyString(item.url) ?? nonEmptyString(item.path) ?? nonEmptyString(item.source);
    return source ? `${type}: ${source}` : null;
  }
  if (type === "skill" || type === "mention") {
    const name = nonEmptyString(item.name);
    const itemPath = nonEmptyString(item.path);
    return name && itemPath ? `${type}: ${name} (${itemPath})` : null;
  }
  return null;
};

const formatArchiveUserMessage = (entry: CodexTranscriptEntry): string | null => {
  const raw = asRecord(entry.rawItem);
  const rawContent = Array.isArray(raw?.content)
    ? raw.content.map(formatRawArchiveContent).filter((line): line is string => line !== null)
    : [];
  if (rawContent.length > 0) return rawContent.join("\n");
  const lines = [
    normalizeArchiveText(entry.markdownText),
    ...(entry.userAttachments ?? []).map(formatArchiveAttachment),
  ].filter((line): line is string => line !== null);
  return lines.length > 0 ? lines.join("\n") : null;
};

export const resolveAutomationArchiveMessagesFromTranscript = (
  transcript: readonly CodexTranscriptEntry[],
): AutomationArchiveMessages => {
  let archivedUserMessage: string | null = null;
  let archivedAssistantMessage: string | null = null;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index];
    if (!entry) continue;
    if (archivedUserMessage === null && entry.kind === "userMessage") {
      archivedUserMessage = formatArchiveUserMessage(entry);
    }
    if (archivedAssistantMessage === null && entry.kind === "assistantMessage") {
      archivedAssistantMessage = normalizeArchiveText(entry.markdownText);
    }
    if (archivedUserMessage !== null && archivedAssistantMessage !== null) break;
  }
  return { archivedUserMessage, archivedAssistantMessage };
};

const formatProtocolUserMessage = (
  item: Extract<ThreadItem, { readonly type: "userMessage" }>,
): string | null => {
  const lines = item.content.flatMap((entry): string[] => {
    switch (entry.type) {
      case "text": {
        const text = nonEmptyString(entry.text);
        return text ? [text] : [];
      }
      case "image":
      case "audio":
        return [`${entry.type}: ${entry.url}`];
      case "localImage":
      case "localAudio":
        return [`${entry.type}: ${entry.path}`];
      case "skill":
      case "mention":
        return [`${entry.type}: ${entry.name} (${entry.path})`];
    }
  });
  return lines.length > 0 ? lines.join("\n") : null;
};

const mergeNewestProtocolMessages = (
  current: AutomationArchiveMessages,
  items: readonly ThreadItem[],
): AutomationArchiveMessages => {
  let archivedUserMessage = current.archivedUserMessage;
  let archivedAssistantMessage = current.archivedAssistantMessage;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) continue;
    if (archivedUserMessage === null && item.type === "userMessage") {
      archivedUserMessage = formatProtocolUserMessage(item);
    }
    if (archivedAssistantMessage === null && item.type === "agentMessage") {
      archivedAssistantMessage = normalizeArchiveText(item.text);
    }
    if (archivedUserMessage !== null && archivedAssistantMessage !== null) break;
  }
  return { archivedUserMessage, archivedAssistantMessage };
};

export const hasCompleteAutomationArchiveExchange = (
  messages: AutomationArchiveMessages,
): boolean => messages.archivedUserMessage !== null && messages.archivedAssistantMessage !== null;

const excerpt = (input: {
  readonly messages: AutomationArchiveMessages;
  readonly resolution: AutomationArchiveExcerpt["resolution"];
  readonly truncationReason?: AutomationArchiveExcerptTruncationReason | null;
  readonly inspectedTurnCount: number;
  readonly inspectedItemCount: number;
  readonly approximateProjectedBytes: number;
}): AutomationArchiveExcerpt => ({
  messages: input.messages,
  resolution: input.resolution,
  truncationReason: input.truncationReason ?? null,
  inspectedTurnCount: input.inspectedTurnCount,
  inspectedItemCount: input.inspectedItemCount,
  approximateProjectedBytes: input.approximateProjectedBytes,
});

/**
 * Reads only the newest bounded excerpt needed by the Automation inbox. Turn shells and physical
 * item pages remain separate, so a giant Turn cannot turn this fallback into a full-history read.
 */
export const readBoundedAutomationArchiveExcerpt = Effect.fn(
  "AutomationArchiveExcerpt.readBoundedAutomationArchiveExcerpt",
)(function* (
  historyPages: CodexHistoryPageAdapter["Service"],
  capabilities: CodexAppServerCapabilities["Service"],
  threadId: string,
  initialMessages: AutomationArchiveMessages = emptyMessages(),
): Effect.fn.Return<
  AutomationArchiveExcerpt,
  CodexHistoryPageAdapterError | AutomationArchiveExcerptError
> {
  let messages = { ...initialMessages };
  let turnCursor: string | null = null;
  let inspectedTurnCount = 0;
  let inspectedItemCount = 0;
  let approximateProjectedBytes = 0;
  let turnPageRequestCount = 0;
  let itemPageRequestCount = 0;

  if (hasCompleteAutomationArchiveExchange(messages)) {
    return excerpt({
      messages,
      resolution: "satisfied",
      inspectedTurnCount,
      inspectedItemCount,
      approximateProjectedBytes,
    });
  }

  const capability: CodexAppServerCapabilitySnapshot = yield* capabilities.forThread(threadId).pipe(
    Effect.mapError(
      (cause) =>
        new AutomationArchiveExcerptError({
          threadId,
          reason: "capability-unavailable",
          cause,
        }),
    ),
  );
  if (!capability.flags.paginatedHistory) {
    return yield* new AutomationArchiveExcerptError({
      threadId,
      reason: "unsupported-history",
      cause: new Error("The current app-server generation does not support bounded history"),
    });
  }

  const assertCurrent = capabilities.isCurrent(capability).pipe(
    Effect.mapError(
      (cause) =>
        new AutomationArchiveExcerptError({
          threadId,
          reason: "stale-generation",
          cause,
        }),
    ),
    Effect.flatMap((current) =>
      current
        ? Effect.void
        : Effect.fail(
            new AutomationArchiveExcerptError({
              threadId,
              reason: "stale-generation",
              cause: new Error("Codex app-server generation changed during archive excerpt read"),
            }),
          ),
    ),
  );
  const fenced = <A, E>(
    operation: () => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | AutomationArchiveExcerptError> =>
    assertCurrent.pipe(
      Effect.andThen(Effect.suspend(operation)),
      Effect.tap(() => assertCurrent),
    );

  const finish = (
    resolution: AutomationArchiveExcerpt["resolution"],
    truncationReason: AutomationArchiveExcerptTruncationReason | null = null,
  ) =>
    excerpt({
      messages,
      resolution,
      truncationReason,
      inspectedTurnCount,
      inspectedItemCount,
      approximateProjectedBytes,
    });

  while (
    inspectedTurnCount < AUTOMATION_ARCHIVE_TURN_CAPTURE_LIMIT &&
    turnPageRequestCount < AUTOMATION_ARCHIVE_PHYSICAL_PAGE_REQUEST_LIMIT
  ) {
    const remainingTurns = AUTOMATION_ARCHIVE_TURN_CAPTURE_LIMIT - inspectedTurnCount;
    const shellPage: CodexHydratedHistoryTurnPage = yield* fenced(() =>
      historyPages.loadTurnPage({
        capability,
        threadId,
        cursor: turnCursor,
        initialItemsCursor: null,
        limit: Math.min(CODEX_HISTORY_TURN_PAGE_SIZE, remainingTurns),
        itemBudget: 0,
        byteBudget: 0,
        purpose: "export",
      }),
    );
    turnPageRequestCount += 1;

    const serverTurnOverflow = shellPage.turns.length > remainingTurns;
    const turns = serverTurnOverflow ? shellPage.turns.slice(-remainingTurns) : shellPage.turns;
    for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
      const turn = turns[turnIndex];
      if (!turn) continue;
      inspectedTurnCount += 1;
      let itemCursor: string | null = null;
      let turnItemsExhausted = false;

      while (
        inspectedItemCount < AUTOMATION_ARCHIVE_ITEM_CAPTURE_LIMIT &&
        approximateProjectedBytes < AUTOMATION_ARCHIVE_PROJECTED_BYTE_LIMIT &&
        itemPageRequestCount < AUTOMATION_ARCHIVE_PHYSICAL_PAGE_REQUEST_LIMIT
      ) {
        const remainingItems = AUTOMATION_ARCHIVE_ITEM_CAPTURE_LIMIT - inspectedItemCount;
        const remainingBytes = AUTOMATION_ARCHIVE_PROJECTED_BYTE_LIMIT - approximateProjectedBytes;
        const pageResult: Result.Result<
          CodexHydratedHistoryItemPage,
          CodexHistoryPageAdapterError | AutomationArchiveExcerptError
        > = yield* Effect.result(
          fenced(() =>
            historyPages.loadTurnItemsPage({
              capability,
              threadId,
              turnId: turn.id,
              cursor: itemCursor,
              limit: Math.min(CODEX_HISTORY_ITEM_PAGE_SIZE, remainingItems),
              sortDirection: "desc",
              purpose: "export",
              byteBudget: remainingBytes,
            }),
          ),
        );
        itemPageRequestCount += 1;
        if (Result.isFailure(pageResult)) {
          if (pageResult.failure.reason === "item-byte-limit") {
            return finish("truncated", "byte-limit");
          }
          return yield* pageResult.failure;
        }

        const page: CodexHydratedHistoryItemPage = pageResult.success;
        const serverItemOverflow = page.items.length > remainingItems;
        const items = serverItemOverflow ? page.items.slice(-remainingItems) : page.items;
        inspectedItemCount += items.length;
        approximateProjectedBytes += page.approximateBytes;
        messages = mergeNewestProtocolMessages(messages, items);
        if (hasCompleteAutomationArchiveExchange(messages)) return finish("satisfied");
        if (serverItemOverflow) return finish("truncated", "item-limit");
        if (page.nextCursor === null) {
          turnItemsExhausted = true;
          break;
        }
        itemCursor = page.nextCursor;
      }

      if (!turnItemsExhausted) {
        if (inspectedItemCount >= AUTOMATION_ARCHIVE_ITEM_CAPTURE_LIMIT) {
          return finish("truncated", "item-limit");
        }
        if (approximateProjectedBytes >= AUTOMATION_ARCHIVE_PROJECTED_BYTE_LIMIT) {
          return finish("truncated", "byte-limit");
        }
        return finish("truncated", "pagination-limit");
      }

      const hasOlderTurns = turnIndex > 0 || shellPage.nextCursor !== null || serverTurnOverflow;
      if (inspectedTurnCount >= AUTOMATION_ARCHIVE_TURN_CAPTURE_LIMIT && hasOlderTurns) {
        return finish("truncated", "turn-limit");
      }
      if (inspectedItemCount >= AUTOMATION_ARCHIVE_ITEM_CAPTURE_LIMIT && hasOlderTurns) {
        return finish("truncated", "item-limit");
      }
      if (approximateProjectedBytes >= AUTOMATION_ARCHIVE_PROJECTED_BYTE_LIMIT && hasOlderTurns) {
        return finish("truncated", "byte-limit");
      }
      if (itemPageRequestCount >= AUTOMATION_ARCHIVE_PHYSICAL_PAGE_REQUEST_LIMIT && hasOlderTurns) {
        return finish("truncated", "pagination-limit");
      }
    }

    if (serverTurnOverflow) return finish("truncated", "turn-limit");
    if (shellPage.nextCursor === null) return finish("exhausted");
    turnCursor = shellPage.nextCursor;
  }

  return finish(
    "truncated",
    inspectedTurnCount >= AUTOMATION_ARCHIVE_TURN_CAPTURE_LIMIT ? "turn-limit" : "pagination-limit",
  );
});
