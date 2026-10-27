import { createHash } from "node:crypto";
import { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ProjectionVisibleTurnItemRecord } from "../orchestration-v2/ProjectionStore.ts";
import { turnItemText } from "../orchestration-v2/turnItemContent.ts";
import type { HistoryItemReference } from "./HistoryRead.ts";

const encodeItem = Schema.encodeEffect(Schema.toCodecJson(OrchestrationV2TurnItem));

/** Content and provenance come from the same canonical visible record, never caller metadata. */
export const runtimeHistoryContent = Effect.fn("RuntimeHistoryContent.read")(function* (
  record: ProjectionVisibleTurnItemRecord,
  input: { readonly format: "text" | "json"; readonly offset: number; readonly maxChars: number },
) {
  const { item } = record;
  const text =
    input.format === "json" ? JSON.stringify(yield* encodeItem(item)) : (turnItemText(item) ?? "");
  const textOffset = Math.min(input.offset, text.length);
  const end = Math.min(textOffset + input.maxChars, text.length);
  const reference: HistoryItemReference = {
    itemId: record.sourceItemId,
    sourceThreadId: record.sourceThreadId,
    runId: item.runId,
    type: item.type,
    status: item.status,
    visibility: record.visibility,
    updatedAt: DateTime.formatIso(item.updatedAt),
    ...record.metadata,
  };
  return {
    reference,
    itemId: reference.itemId,
    sourceThreadId: reference.sourceThreadId,
    runId: item.runId,
    type: item.type,
    status: item.status,
    updatedAt: DateTime.formatIso(item.updatedAt),
    format: input.format,
    text: text.slice(textOffset, end),
    textOffset,
    totalChars: text.length,
    nextTextOffset: end < text.length ? end : null,
    contentVersion: createHash("sha256").update(text).digest("base64url"),
  };
});
