import type { Thread } from "@nodex/codex-app-server-protocol/v2";

export type CodexCatalogAnchors = ReadonlyMap<string, number>;
export const codexCatalogAnchors = (
  threads: readonly Pick<Thread, "id" | "updatedAt">[],
): CodexCatalogAnchors =>
  new Map(
    threads
      .filter((thread) => Number.isFinite(thread.updatedAt))
      .map((thread) => [thread.id, thread.updatedAt]),
  );
export const codexCatalogWatermark = (
  threads: readonly Pick<Thread, "id" | "updatedAt">[],
): number | null => {
  const timestamps = threads.map((thread) => thread.updatedAt).filter(Number.isFinite);
  return timestamps.length === 0 ? null : Math.max(...timestamps);
};
export const codexCatalogCrossesWatermark = (
  threads: readonly Pick<Thread, "id" | "updatedAt">[],
  watermark: number | null,
): boolean =>
  watermark !== null &&
  threads.some((thread) => Number.isFinite(thread.updatedAt) && thread.updatedAt < watermark);
export const codexCatalogOverlaps = (
  threads: readonly Pick<Thread, "id" | "updatedAt">[],
  anchors: CodexCatalogAnchors,
): boolean => threads.some((thread) => anchors.get(thread.id) === thread.updatedAt);

/** Pauses before the next page would cross a window budget; the opaque cursor is retained. */
export const codexCatalogWindowIsSpent = (input: {
  readonly pages: number;
  readonly results: number;
  readonly processedBytes: number;
  readonly elapsedMs: number;
  readonly maxPages: number;
  readonly maxResults: number;
  readonly maxBytes: number;
  readonly maxPageBytes: number;
  readonly pageSize: number;
  readonly deadlineMs: number;
}): boolean =>
  input.pages > 0 &&
  (input.pages >= input.maxPages ||
    input.results > input.maxResults - input.pageSize ||
    input.processedBytes > input.maxBytes - input.maxPageBytes ||
    input.elapsedMs >= input.deadlineMs);
