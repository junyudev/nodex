import { useState } from "react";
import type { NewChatStartInTarget } from "@/lib/new-chat-start-in-selector";

type ExecutionDraft = Pick<NewChatStartInTarget, "runInTarget" | "worktreeStartingState">;

const LOCAL_EXECUTION: ExecutionDraft = { runInTarget: "localProject" };

/** Execution choices belong to one Session's selected Project and primary source. */
export function useNewChatExecutionDraft({
  sessionId,
  projectId,
  workspaceRoot,
  onProjectChange,
}: {
  sessionId: string;
  projectId: string | null;
  workspaceRoot: string | null;
  onProjectChange: (projectId: string | null) => void;
}) {
  const scope = JSON.stringify([sessionId, projectId, workspaceRoot]);
  const [draft, setDraft] = useState(() => ({ scope, target: LOCAL_EXECUTION }));
  const target = draft.scope === scope ? draft.target : LOCAL_EXECUTION;

  // Reset before children commit, including source edits and deleted-Project fallback.
  // Remember the new scope so returning to an earlier Project cannot revive its draft.
  if (draft.scope !== scope) setDraft({ scope, target });

  function changeTarget(next: NewChatStartInTarget) {
    setDraft({
      scope,
      target: {
        runInTarget: next.runInTarget,
        worktreeStartingState: next.worktreeStartingState,
      },
    });
  }

  function changeProject(nextProjectId: string | null) {
    if (nextProjectId === projectId) return;
    setDraft({ scope, target: LOCAL_EXECUTION });
    onProjectChange(nextProjectId);
  }

  return { target, changeTarget, changeProject };
}
