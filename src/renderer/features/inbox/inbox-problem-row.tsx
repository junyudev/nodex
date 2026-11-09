import { runWithCleanup } from "@/lib/run-with-cleanup";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { InboxItem } from "../../../shared/inbox";
import { createBoundedOperationId } from "../../../shared/operation-identity";
import { PermissionFullAccessWarningIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { toastFailure } from "@/lib/failure-toast";
import { retryInboxProblem } from "@/lib/inbox-runtime";
import { invalidateInbox } from "./use-inbox";

/** Problems expose one fix and keep their evidence until the operation succeeds. */
export function InboxProblemRow({
  item,
  onOpenGitHubSettings,
  onOpenPage,
}: {
  readonly item: InboxItem;
  readonly onOpenGitHubSettings: () => void;
  readonly onOpenPage: (pageId: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const client = useQueryClient();
  const problem = item.problem;
  if (!problem) return null;
  const fix = problem.fix;
  const act = async () => {
    if (fix === "reconnect") {
      onOpenGitHubSettings();
      return;
    }
    if (fix === "open_card") {
      if (problem.page_id) onOpenPage(problem.page_id);
      return;
    }
    setPending(true);
    await runWithCleanup(
      async () => {
        await retryInboxProblem({
          operationId: createBoundedOperationId("inbox.retry-problem"),
          problemId: problem.id,
        });
        await invalidateInbox(client);
      },
      {
        onError: (cause) => toastFailure("Couldn’t retry", cause),
        cleanup: () => setPending(false),
      },
    );
  };
  return (
    <div data-inbox-page-id={item.pageId} className="flex min-h-9 items-center gap-2 py-1 text-sm">
      <PermissionFullAccessWarningIcon className="size-4 shrink-0 text-warning" />
      <span className="min-w-0 flex-1 truncate text-token-foreground">{problem.summary}</span>
      <NodexButton size="xs" variant="ghost" disabled={pending} onClick={() => void act()}>
        {fix === "reconnect" ? "Reconnect" : fix === "open_card" ? "Open card" : "Retry"}
      </NodexButton>
    </div>
  );
}
