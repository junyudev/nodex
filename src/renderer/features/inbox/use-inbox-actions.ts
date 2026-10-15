import { useQueryClient } from "@tanstack/react-query";
import type {
  InboxDispatchAction,
  InboxEntryKind,
  InboxEntryState,
  InboxProposal,
  InboxScope,
} from "../../../shared/inbox";
import type { Project } from "../../../shared/types";
import { toast } from "@/components/ui/toast";
import {
  confirmInboxDispatch,
  deleteInboxMessages,
  dispatchInboxEntries,
  editInboxMessage,
  keepInboxEntries,
  requestInboxSuggestion,
  retryInboxDispatch,
  sendInboxMessage,
  setInboxEntryKind,
  setInboxEntryState,
} from "@/lib/inbox-runtime";
import { readableInboxError } from "./inbox-presentation";
import { invalidateInbox } from "./use-inbox";
import { useMoveInboxPagesToProject } from "./use-inbox-move";

export interface InboxActions {
  readonly send: (text: string) => Promise<boolean>;
  /** Rewrites a waiting message from the text the user started with; it is suggested again. */
  readonly edit: (pageId: string, originalText: string, text: string) => Promise<boolean>;
  /** Confirms a suggestion, optionally as edited by the user. */
  readonly confirm: (proposal: InboxProposal, edited?: InboxDispatchAction) => Promise<boolean>;
  /** Authors and confirms a dispatch without a suggestion. */
  readonly dispatch: (pageIds: readonly string[], action: InboxDispatchAction) => Promise<boolean>;
  readonly keep: (pageIds: readonly string[]) => Promise<boolean>;
  /** Erases messages for good; there is no Undo. */
  readonly delete: (pageIds: readonly string[]) => Promise<boolean>;
  readonly setState: (pageIds: readonly string[], state: InboxEntryState) => Promise<boolean>;
  readonly setKind: (pageId: string, kind: InboxEntryKind | null) => Promise<boolean>;
  readonly requestSuggestion: (pageIds: readonly string[]) => Promise<boolean>;
  readonly retryDispatch: (proposalId: string) => Promise<boolean>;
}

const clearedLabel = (outcome: "kept" | "done", count: number): string => {
  if (outcome === "kept") return count > 1 ? `Kept ${count} messages` : "Kept";
  return count > 1 ? `Marked ${count} messages done` : "Marked done";
};

/** Inbox commands with uniform failure reporting and invalidation. New messages go to `scope`. */
export function useInboxActions(projects: readonly Project[], scope: InboxScope): InboxActions {
  const queryClient = useQueryClient();
  const moveToProject = useMoveInboxPagesToProject();

  const run = async (fallback: string, task: () => Promise<unknown>): Promise<boolean> => {
    try {
      await task();
      return true;
    } catch (error) {
      toast.danger(readableInboxError(error, fallback));
      return false;
    } finally {
      void invalidateInbox(queryClient);
    }
  };

  // Clearing the Inbox is reversible for anything that started no work.
  const announceCleared = (outcome: "kept" | "done", pageIds: readonly string[]) =>
    toast.success(clearedLabel(outcome, pageIds.length), {
      action: {
        label: "Undo",
        onClick: () => {
          void setInboxEntryState({ pageIds, state: "open" })
            .catch((error: unknown) =>
              toast.danger(readableInboxError(error, "The message could not be restored")),
            )
            .finally(() => void invalidateInbox(queryClient));
        },
      },
    });

  const announceChat = (action: InboxDispatchAction, proposal: InboxProposal | null) => {
    if (action.type === "new_chat") {
      const project = action.projectId
        ? (projects.find((candidate) => candidate.id === action.projectId)?.name ??
          proposal?.targetProjectName ??
          "its Project")
        : null;
      toast.success(project ? `Starting a chat in ${project}` : "Starting a projectless chat");
    } else if (action.type === "send_to_chat") {
      const title = proposal?.chat?.displayTitle;
      toast.success(title ? `Sending to “${title}”` : "Sending to the chat");
    }
  };

  const requireProject = (projectId: string): Project => {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error("That Project is no longer available");
    return project;
  };

  return {
    send: (text) => run("The message could not be saved", () => sendInboxMessage({ scope, text })),
    edit: (pageId, originalText, text) =>
      run("The message could not be edited", () =>
        editInboxMessage({ pageId, originalText, text }),
      ),
    confirm: (proposal, edited) =>
      run("The suggestion could not be confirmed", async () => {
        const action = edited ?? proposal.action;
        if (action.type === "move_to_project") {
          // The move is the user's own Library relocation; Core then records it as filed.
          await moveToProject(proposal.pageIds, requireProject(action.projectId));
        }
        await confirmInboxDispatch({
          proposalId: proposal.proposalId,
          expectedRevision: proposal.revision,
          ...(edited ? { action: edited } : {}),
        });
        if (action.type === "keep") announceCleared("kept", proposal.pageIds);
        else announceChat(action, proposal);
      }),
    dispatch: (pageIds, action) =>
      run("The message could not be dispatched", async () => {
        if (action.type === "move_to_project") {
          await moveToProject(pageIds, requireProject(action.projectId));
          await dispatchInboxEntries({ pageIds, action });
          return;
        }
        if (action.type === "keep") {
          await keepInboxEntries({ pageIds });
          announceCleared("kept", pageIds);
          return;
        }
        await dispatchInboxEntries({ pageIds, action });
        announceChat(action, null);
      }),
    keep: (pageIds) =>
      run("The message could not be kept", async () => {
        await keepInboxEntries({ pageIds });
        announceCleared("kept", pageIds);
      }),
    delete: (pageIds) =>
      run("The message could not be deleted", async () => {
        await deleteInboxMessages({ pageIds });
        toast.success(pageIds.length > 1 ? `Deleted ${pageIds.length} messages` : "Deleted");
      }),
    setState: (pageIds, state) =>
      run("The message could not be updated", async () => {
        await setInboxEntryState({ pageIds, state });
        if (state === "done") announceCleared("done", pageIds);
      }),
    setKind: (pageId, kind) =>
      run("The message could not be updated", () => setInboxEntryKind({ pageId, kind })),
    requestSuggestion: (pageIds) =>
      run("A new suggestion could not be requested", () => requestInboxSuggestion({ pageIds })),
    retryDispatch: (proposalId) =>
      run("The dispatch could not be retried", () => retryInboxDispatch({ proposalId })),
  };
}
