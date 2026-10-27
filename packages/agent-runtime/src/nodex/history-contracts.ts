/** Transport-neutral history values shared by Session and task tools. */
export type HistoryView = "messages" | "activity";
export type HistoryOrder = "newest_first" | "oldest_first";
export const HISTORY_CURSOR_MAX_CHARS = 4096;
/** A range retained by the final response budget; owners still verify current content and caller. */
export interface ThreadReadEvidence {
  readonly itemId: string;
  readonly sourceThreadId: string;
  readonly format: "text" | "json";
  readonly contentVersion: string;
  readonly offset: number;
  readonly length: number;
  readonly totalChars: number;
}
export interface HistoryItemMetadata {
  readonly visibility?: "local" | "inherited" | "synthetic";
  readonly title?: string | null;
  readonly updatedAt?: string;
  readonly messageId?: string | null;
  readonly createdBy?: string | null;
  readonly creationSource?: string | null;
  readonly senderThreadId?: string | null;
}
export type HistoryData = { readonly source: string; readonly item: unknown };
export type HistoryContent<Data = HistoryData> = {
  readonly offset: number;
  readonly totalChars: number;
  readonly nextCursor: string | null;
} & (
  | { readonly format: "text"; readonly text: string }
  | { readonly format: "json"; readonly value: Data }
  | { readonly format: "json_fragment"; readonly text: string }
);
export interface HistoryItem<Data = HistoryData> extends HistoryItemMetadata {
  readonly id: string;
  readonly sourceThreadId: string;
  readonly runId: string | null;
  readonly type: string;
  readonly status: string | null;
  readonly content: HistoryContent<Data>;
}
export type History<Data = HistoryData> =
  | {
      readonly availability: "available";
      readonly items: readonly HistoryItem<Data>[];
      readonly page: {
        readonly order: HistoryOrder;
        readonly view: HistoryView;
        readonly limit: number;
        readonly hasMore: boolean;
        /** The requested item is still being located in a source without point lookup. */
        readonly locating?: true;
        readonly nextCursor: string | null;
        readonly tailCursor: string | null;
      };
    }
  | { readonly availability: "empty"; readonly items: readonly [] }
  | { readonly availability: "unavailable"; readonly reason: string; readonly items: readonly [] };
export interface HistoryProgress<Data = HistoryData> {
  readonly availability: "available" | "empty" | "unavailable";
  readonly reason?: "response_budget";
  readonly coverage: "complete" | "recent_window" | "unavailable";
  readonly nextCursor: string | null;
  readonly latestMessage: HistoryItem<Data> | null;
  readonly latestTool: {
    readonly id: string;
    readonly runId: string | null;
    readonly type: string;
    readonly status: string | null;
    readonly name?: string;
  } | null;
}
