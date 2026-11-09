import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { NodexButton } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/components/ui/toast";
import { retryInboxDispatch } from "@/lib/inbox-runtime";
import { readableIpcError } from "@/lib/ipc-error-message";
import { queryKeys } from "@/lib/query-keys";
import { projectSessionStartQueryOptions } from "@/lib/query-options";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import type { ProjectSessionStart } from "../../../shared/types";

/** What a chat its Inbox decision started says until it runs, read from Core for any reader. */
export function sessionStartPresentation(start: ProjectSessionStart): {
  readonly title: string;
  readonly description: string;
} {
  if (start.state === "starting")
    return { title: "Starting this chat", description: "It opens here once its Agent runs." };
  if (start.state === "uncertain")
    return {
      title: "This chat may have started",
      description:
        start.failureMessage ?? "Its conversation appears here once its Agent confirms it.",
    };
  return {
    title: "This chat couldn’t start",
    description: [
      start.failureMessage ?? "The chat could not be started.",
      start.retryable ? null : "Review its message in the Inbox to decide again.",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

/** A chat an Inbox decision has not started yet; null for every other unstarted chat. */
export function useSessionStart(sessionId: string, unstarted: boolean): ProjectSessionStart | null {
  return (
    useQuery({ ...projectSessionStartQueryOptions(sessionId), enabled: unstarted }).data ?? null
  );
}

export function SessionStartNotice({
  sessionId,
  start,
}: {
  readonly sessionId: string;
  readonly start: ProjectSessionStart;
}) {
  const queryClient = useQueryClient();
  const [retrying, setRetrying] = useState(false);
  const { title, description } = sessionStartPresentation(start);
  const retry = () => {
    setRetrying(true);
    void runWithCleanup(
      async () => {
        await retryInboxDispatch({ proposalId: start.proposalId });
      },
      {
        onError: (error) => {
          toast.danger(readableIpcError(error, "The chat could not be started again"));
        },
        cleanup: () => {
          setRetrying(false);
          void queryClient.invalidateQueries({
            queryKey: queryKeys.projectSessions.start(sessionId),
          });
        },
      },
    );
  };
  return (
    <EmptyState
      className="h-full"
      width="wide"
      title={title}
      description={description}
      actions={
        start.state === "failed" && start.retryable ? (
          <NodexButton size="sm" variant="secondary" disabled={retrying} onClick={retry}>
            {retrying ? "Retrying…" : "Retry"}
          </NodexButton>
        ) : undefined
      }
    />
  );
}
