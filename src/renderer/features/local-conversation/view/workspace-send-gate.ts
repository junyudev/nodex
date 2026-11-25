import { getIntl, useIntl } from "@/lib/i18n";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { toastFailure } from "@/lib/failure-toast";
import {
  restoreManagedWorktree,
  threadWorkspaceAvailabilityQuery,
} from "@/lib/managed-worktree-runtime";
import { queryKeys } from "@/lib/query-keys";
import type { ThreadWorkspaceAvailability } from "@/lib/types";
import {
  useThreadExecutionLocation,
  type ThreadExecutionLocationOwner,
} from "@/lib/use-thread-execution-location";
import type { ComposerNoticeAction, ComposerSendGate } from "../thread-stage-types";
import type { ThreadMoveSource } from "./thread-move-dialog";

/** What Nodex knows about the working directory a chat runs in. */
export type WorkspaceCheck =
  | { readonly status: "checking" }
  | { readonly status: "failed" }
  | { readonly status: "checked"; readonly availability: ThreadWorkspaceAvailability };

export interface WorkspaceFixes {
  readonly restore: () => Promise<void>;
  readonly checkAgain: () => Promise<void>;
  /** Continues the chat in its Project folder; null when this chat cannot move. */
  readonly workLocally: (() => void | Promise<void>) | null;
}

/**
 * What a chat's working directory keeps it from sending, said beside the composer with the fix.
 * A native Thread resumes only into a checked worktree, so it waits for the check; Agent
 * execution checks its own location before running, so only a known loss holds an Agent chat.
 * While the chat moves to its Project folder, the notice says so in place of its fixes.
 */
export function workspaceSendGate(
  check: WorkspaceCheck,
  options: { readonly requiresCheck: boolean; readonly moving: boolean },
  fixes: WorkspaceFixes,
  intl = getIntl(),
): ComposerSendGate | null {
  const uncheckable: ComposerSendGate = {
    unsentReason: intl.formatMessage({
      id: "conversation.workspaceSendGate.worktreeCheckFailedReason",
      defaultMessage: "Nodex couldn’t check this chat’s worktree",
    }),
    notice: {
      key: "worktree:unavailable",
      tone: "warning",
      title: intl.formatMessage({
        id: "conversation.workspaceSendGate.worktreeCheckFailed",
        defaultMessage: "Couldn’t check worktree status",
      }),
      actions: [
        {
          label: intl.formatMessage({
            id: "conversation.workspaceSendGate.retry",
            defaultMessage: "Retry",
          }),
          pendingLabel: intl.formatMessage({
            id: "conversation.workspaceSendGate.checking",
            defaultMessage: "Checking…",
          }),
          run: fixes.checkAgain,
        },
      ],
    },
  };
  if (check.status === "checking") {
    return options.requiresCheck
      ? {
          unsentReason: intl.formatMessage({
            id: "conversation.workspaceSendGate.checkingReason",
            defaultMessage: "Still checking this chat’s worktree",
          }),
          notice: null,
        }
      : null;
  }
  if (check.status === "failed") return options.requiresCheck ? uncheckable : null;
  const { availability } = check;
  if (availability.state === "available") return null;
  if (availability.state === "unavailable") return uncheckable;
  if (options.moving)
    return {
      unsentReason: intl.formatMessage({
        id: "conversation.workspaceSendGate.movingReason",
        defaultMessage: "This chat is moving to the Project folder",
      }),
      notice: {
        key: "worktree:moving",
        tone: "progress",
        title: intl.formatMessage({
          id: "conversation.workspaceSendGate.moving",
          defaultMessage: "Moving to the Project folder…",
        }),
      },
    };
  const workLocally: ComposerNoticeAction | null =
    availability.projectCheckout !== null && fixes.workLocally
      ? {
          label: intl.formatMessage({
            id: "conversation.workspaceSendGate.workLocally",
            defaultMessage: "Work locally",
          }),
          run: fixes.workLocally,
        }
      : null;
  if (availability.state === "restorable")
    return {
      unsentReason: workLocally
        ? intl.formatMessage({
            id: "conversation.workspaceSendGate.restoreOrWorkLocallyToSend",
            defaultMessage: "Restore this chat’s worktree or work locally to send",
          })
        : intl.formatMessage({
            id: "conversation.workspaceSendGate.restoreToSend",
            defaultMessage: "Restore this chat’s worktree to send",
          }),
      notice: {
        key: "worktree:restorable",
        tone: "warning",
        title: intl.formatMessage({
          id: "conversation.workspaceSendGate.cleanedUp",
          defaultMessage: "Worktree cleaned up",
        }),
        detail: intl.formatMessage({
          id: "conversation.workspaceSendGate.removedToSaveSpace",
          defaultMessage: "Removed to save disk space",
        }),
        actions: [
          {
            label: intl.formatMessage({
              id: "conversation.workspaceSendGate.restore",
              defaultMessage: "Restore worktree",
            }),
            pendingLabel: intl.formatMessage({
              id: "conversation.workspaceSendGate.restoring",
              defaultMessage: "Restoring…",
            }),
            run: fixes.restore,
          },
          ...(workLocally ? [workLocally] : []),
        ],
      },
    };
  const missing = availability.worktree
    ? intl.formatMessage({
        id: "conversation.workspaceSendGate.worktreeMissing",
        defaultMessage: "This chat’s worktree no longer exists",
      })
    : intl.formatMessage({
        id: "conversation.workspaceSendGate.directoryMissing",
        defaultMessage: "This chat’s working directory no longer exists",
      });
  return {
    unsentReason: missing,
    notice: {
      key: "worktree:gone",
      tone: "danger",
      title: intl.formatMessage({
        id: "conversation.workspaceSendGate.missing",
        defaultMessage: "Working directory missing",
      }),
      detail: missing,
      ...(workLocally ? { actions: [workLocally] } : {}),
    },
  };
}

/** Where a missing location stands for a move: nothing to bring, or a snapshot left behind. */
function moveSource(check: WorkspaceCheck): ThreadMoveSource {
  if (check.status !== "checked") return "present";
  const { state } = check.availability;
  return state === "gone" || state === "restorable" ? state : "present";
}

/** Restores a cleaned-up worktree in place and reports the outcome. */
async function restoreWorkspace(
  threadId: string,
  owner: {
    readonly settle: (availability: ThreadWorkspaceAvailability) => void;
    readonly recheck: () => Promise<void>;
  },
): Promise<void> {
  try {
    const result = await restoreManagedWorktree(threadId);
    owner.settle(result.availability);
    toast.success(
      getIntl().formatMessage({
        id: "conversation.workspaceSendGate.restored",
        defaultMessage: "Worktree restored",
      }),
    );
  } catch (cause) {
    toastFailure(
      getIntl().formatMessage({
        id: "conversation.workspaceSendGate.restoreFailed",
        defaultMessage: "Couldn’t restore the worktree",
      }),
      cause,
    );
    await owner.recheck();
  }
}

/**
 * Checks the chat's working directory and offers its fixes when it holds sending. Working
 * locally from a cleaned-up worktree leaves its snapshot behind, so that asks first through
 * the move dialog the caller renders from `confirmation`.
 */
export function useWorkspaceSendGate(
  threadId: string | null,
  options: {
    /** The chat has a working directory on this computer to check. */
    readonly inspect: boolean;
    readonly requiresCheck: boolean;
    /** The chat's execution owner can move it to its Project folder. */
    readonly canMove: boolean;
  },
): {
  readonly gate: ComposerSendGate | null;
  readonly source: ThreadMoveSource;
  /** The owner of the move the gate starts, lent to the confirmation dialog. */
  readonly location: ThreadExecutionLocationOwner;
  readonly confirmation: { readonly open: boolean; readonly close: () => void };
} {
  const intl = useIntl();
  const { inspect, requiresCheck, canMove } = options;
  const queryClient = useQueryClient();
  const location = useThreadExecutionLocation(threadId ?? "");
  const [confirming, setConfirming] = useState(false);
  const queryKey = queryKeys.threadExecution.workspace(threadId ?? "");
  const { data, isError, refetch } = useQuery({
    ...threadWorkspaceAvailabilityQuery(threadId ?? ""),
    enabled: inspect && Boolean(threadId),
  });
  const check: WorkspaceCheck = data
    ? { status: "checked", availability: data }
    : isError
      ? { status: "failed" }
      : { status: "checking" };
  const source = moveSource(check);
  const gate =
    inspect && threadId
      ? workspaceSendGate(
          check,
          { requiresCheck, moving: location.busy },
          {
            checkAgain: async () => {
              await refetch();
            },
            workLocally: canMove
              ? source === "restorable"
                ? () => setConfirming(true)
                : async () => await location.move("local", "missing")
              : null,
            restore: async () =>
              await restoreWorkspace(threadId, {
                settle: (availability) => queryClient.setQueryData(queryKey, availability),
                recheck: async () => {
                  await refetch();
                },
              }),
          },
          intl,
        )
      : null;
  return {
    gate,
    source,
    location,
    confirmation: { open: confirming, close: () => setConfirming(false) },
  };
}
