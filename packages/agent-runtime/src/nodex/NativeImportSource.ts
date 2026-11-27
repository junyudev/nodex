import type {
  DynamicToolCallOutputContentItem,
  ThreadItemEntry,
} from "@nodex/codex-app-server-protocol/v2";
import * as Effect from "effect/Effect";
import { omitToolOutputImageData } from "@nodex/runtime-shared/toolOutput";
import { NATIVE_IMPORT_HISTORY_PAGE_BYTES } from "./NativeImportLimits.ts";
import { toolReadImagePath } from "@nodex/runtime-shared/filePreview";
import { field } from "../orchestration-v2/unknownField.ts";
import { createHash } from "node:crypto";

/** Frozen source boundary; copies never acquire the source's native execution identity. */
export interface NativeImportBoundary {
  readonly boundaryItemId: string | null;
  readonly boundaryTurnId: string | null;
  readonly historyMode: "legacy" | "paginated" | "claude" | "antigravity";
  readonly sourceCwd: string;
  readonly sourceRevision: string | null;
}

export function nativeReadPath(item: ThreadItemEntry["item"]): string | undefined {
  if (item.type !== "dynamicToolCall" || item.tool !== "Read") return undefined;
  const value = field(item.arguments, "path") ?? field(item.arguments, "file_path");
  return typeof value === "string" ? value.trim() : undefined;
}

/** Tool images use the same byte limits as live results, separately from the history text budget. */
export function nativeHistoryPageBytes(
  entries: readonly ThreadItemEntry[],
  includeToolImages: boolean,
): number {
  const metadata = includeToolImages
    ? entries
    : entries.map((entry) => {
        const { item } = entry;
        if (item.type === "imageGeneration" && "result" in item)
          return { ...entry, item: { ...item, result: "" } };
        if (item.type === "imageView" && item.path.startsWith("data:image/"))
          return { ...entry, item: { ...item, path: "" } };
        if (item.type === "dynamicToolCall" && toolReadImagePath(nativeReadPath(item)))
          return {
            ...entry,
            item: {
              ...item,
              contentItems: item.contentItems?.map((block) =>
                block.type === "inputImage" && block.imageUrl.startsWith("data:image/")
                  ? { ...block, imageUrl: "" }
                  : block,
              ),
            },
          };
        if (item.type !== "mcpToolCall" || item.result === null) return entry;
        return {
          ...entry,
          item: {
            ...item,
            result: { ...item.result, content: omitToolOutputImageData(item.result.content) },
          },
        };
      });
  return Buffer.byteLength(JSON.stringify(metadata), "utf8");
}

/** A restarted reader can continue only when the captured prefix is unchanged. */
export function frozenNativeImportSource(
  entries: readonly ThreadItemEntry[],
  sourceCwd: string,
  historyMode: "claude" | "antigravity",
) {
  const revision = (prefix: readonly ThreadItemEntry[]) =>
    createHash("sha256").update(JSON.stringify(prefix)).digest("hex");
  const last = entries.at(-1);
  const indices = new Map(entries.map((entry, index) => [entry.item.id, index]));
  let verifiedBoundary: NativeImportBoundary | undefined;
  let end = -1;
  const changed = () =>
    new Error("The source conversation changed while its history was being copied.");
  return {
    capture: () =>
      Effect.succeed({
        boundaryItemId: last?.item.id ?? null,
        boundaryTurnId: last?.turnId ?? null,
        historyMode,
        sourceCwd,
        sourceRevision: revision(entries),
      }),
    page: (boundary: NativeImportBoundary, cursor: string | null) =>
      Effect.try({
        try: () => {
          if (boundary.boundaryItemId === null) return { data: [], nextCursor: null };
          if (boundary !== verifiedBoundary) {
            const index = indices.get(boundary.boundaryItemId);
            if (
              index === undefined ||
              entries[index]?.turnId !== boundary.boundaryTurnId ||
              boundary.sourceRevision !== revision(entries.slice(0, index + 1))
            )
              throw changed();
            end = index;
            verifiedBoundary = boundary;
          }
          const after = cursor === null ? -1 : indices.get(cursor);
          if (after === undefined || after > end) throw changed();
          const start = after + 1;
          const data: ThreadItemEntry[] = [];
          let bytes = 0;
          for (const entry of entries.slice(start, Math.min(start + 25, end + 1))) {
            const size = nativeHistoryPageBytes([entry], true);
            // Give a large image-bearing step its own transaction.
            if (data.length > 0 && bytes + size > NATIVE_IMPORT_HISTORY_PAGE_BYTES) break;
            data.push(entry);
            bytes += size;
          }
          return { data, nextCursor: start + data.length <= end ? data.at(-1)!.item.id : null };
        },
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      }),
    close: Effect.void,
  };
}

export function nativeReadContent(
  text: string | undefined,
  image: { readonly mimeType: string; readonly base64: string } | undefined,
): DynamicToolCallOutputContentItem[] {
  const content: DynamicToolCallOutputContentItem[] = [];
  if (text !== undefined) content.push({ type: "inputText", text });
  if (image !== undefined) {
    content.push({ type: "inputImage", imageUrl: `data:${image.mimeType};base64,${image.base64}` });
  }
  return content;
}
