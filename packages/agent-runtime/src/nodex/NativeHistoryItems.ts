import type {
  ThreadItemEntry,
  ThreadItemsListResponse,
  ThreadTurnsListResponse,
} from "@nodex/codex-app-server-protocol/v2";

/** Normalize the producer's two persisted history formats without reading rollout files. */
export const nativeHistoryItems = (
  page: ThreadItemsListResponse | ThreadTurnsListResponse,
  mode: "legacy" | "paginated",
): ThreadItemEntry[] =>
  mode === "legacy"
    ? (page as ThreadTurnsListResponse).data.flatMap((turn) =>
        turn.items.map((item) => ({
          turnId: turn.id,
          item,
          startedAtMs: turn.startedAt === null ? null : turn.startedAt * 1000,
          completedAtMs: turn.completedAt === null ? null : turn.completedAt * 1000,
        })),
      )
    : (page as ThreadItemsListResponse).data;
