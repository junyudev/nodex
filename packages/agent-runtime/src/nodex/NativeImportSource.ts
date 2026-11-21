import type { ThreadItemEntry } from "@nodex/codex-app-server-protocol/v2";
import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";

/** Frozen source boundary; copies never acquire the source's native execution identity. */
export interface NativeImportBoundary {
  readonly boundaryItemId: string | null;
  readonly boundaryTurnId: string | null;
  readonly historyMode: "legacy" | "paginated" | "claude" | "antigravity";
  readonly sourceCwd: string;
  readonly sourceRevision: string | null;
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
          const data = entries.slice(start, Math.min(start + 25, end + 1));
          return { data, nextCursor: start + data.length <= end ? data.at(-1)!.item.id : null };
        },
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      }),
    close: Effect.void,
  };
}
