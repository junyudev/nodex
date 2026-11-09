import { useState, type ReactNode } from "react";
import type { DatabaseViewRenderRow } from "@/lib/database-view-render-model";
import { toast } from "@/components/ui/toast";
import { readableIpcError } from "@/lib/ipc-error-message";
import { startWork } from "@/lib/work-graph-runtime";
import { PageTurnView } from "./page-turn";
export function usePageTurnCardChip({
  row,
  onOpenPage,
}: {
  readonly row: DatabaseViewRenderRow;
  readonly onOpenPage?: (pageId: string, label: string) => void;
}): ReactNode {
  const [starting, setStarting] = useState(false);
  const turn = row.work?.turn;
  if (!turn?.reason || turn.actor.kind === "none") return null;
  const start = () => {
    setStarting(true);
    void startWork({ pageId: row.pageId, again: false })
      .catch((error: unknown) => toast.danger(readableIpcError(error, "Couldn’t start this Page")))
      .finally(() => setStarting(false));
  };
  return (
    <PageTurnView
      turn={turn}
      onStart={start}
      onOpenPage={
        onOpenPage
          ? (pageId) =>
              onOpenPage(pageId, turn.actor.kind === "page" ? (turn.actor.key ?? "Page") : "Page")
          : undefined
      }
      disabled={starting}
    />
  );
}
