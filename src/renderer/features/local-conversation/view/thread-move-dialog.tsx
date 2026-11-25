import { useIntl } from "@/lib/i18n";
import { useEffect, useEffectEvent } from "react";
import { ActivitySpinnerIcon, CheckmarkIcon } from "@/components/shared/icons";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogFrame,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { toastFailure } from "@/lib/failure-toast";
import type { ThreadExecutionLocationOwner } from "@/lib/use-thread-execution-location";

/**
 * What the chat leaves behind when it moves: a live checkout brings its uncommitted changes,
 * a worktree that is gone has nothing left to bring, and a cleaned-up one keeps its saved
 * changes in its snapshot.
 */
export type ThreadMoveSource = "present" | "gone" | "restorable";

/**
 * Confirms moving a chat to the Project folder or a managed worktree, then shows the move's
 * progress until it settles. Every surface that moves a chat asks through this dialog, so the
 * same move always says the same thing. The surface lends its own location owner, so the move
 * it starts here is the one it shows as busy.
 */
export function ThreadMoveDialog({
  location,
  destination,
  source,
  onClose,
}: {
  location: ThreadExecutionLocationOwner;
  /** Null keeps the dialog closed. */
  destination: "local" | "worktree" | null;
  source: ThreadMoveSource;
  onClose: () => void;
}) {
  const intl = useIntl();
  const { operation, busy, blocked, move, completedOperationId } = location;
  const close = useEffectEvent(onClose);
  useEffect(() => {
    if (completedOperationId) close();
  }, [completedOperationId]);
  // Without its worktree the chat only changes where it runs: Nodex calls that working locally.
  const workingLocally = destination === "local" && source !== "present";
  const title = workingLocally
    ? intl.formatMessage({
        id: "conversation.threadMoveDialog.workLocally",
        defaultMessage: "Work locally",
      })
    : destination === "local"
      ? intl.formatMessage({
          id: "conversation.threadMoveDialog.moveToLocal",
          defaultMessage: "Move to local",
        })
      : intl.formatMessage({
          id: "conversation.threadMoveDialog.moveToWorktree",
          defaultMessage: "Move to worktree",
        });
  const description = !workingLocally
    ? intl.formatMessage(
        {
          id: "conversation.threadMoveDialog.moveDescription",
          defaultMessage:
            "Move this chat and its uncommitted changes to {destination, select, local {the Project folder} other {a managed worktree}}.",
        },
        { destination: destination ?? "worktree" },
      )
    : source === "gone"
      ? intl.formatMessage({
          id: "conversation.threadMoveDialog.goneDescription",
          defaultMessage:
            "This chat’s worktree no longer exists. The chat continues in the Project folder; changes that were only in the worktree can’t come along.",
        })
      : intl.formatMessage({
          id: "conversation.threadMoveDialog.restorableDescription",
          defaultMessage:
            "The chat continues in the Project folder. Changes saved when its worktree was cleaned up stay in the worktree’s snapshot and won’t come along. Restore the worktree first to keep them.",
        });
  return (
    <NodexDialog
      open={destination !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <NodexDialogContent size="compact" showCloseButton={false}>
        <NodexDialogFrame>
          <NodexDialogTitle>{title}</NodexDialogTitle>
          <NodexDialogDescription className="pt-3">{description}</NodexDialogDescription>
          {busy ? (
            <div role="status" className="flex flex-col gap-2 pt-4 text-sm">
              {operation?.steps.map((step) => (
                <div key={step.id} className="flex items-center gap-2">
                  {step.status === "running" ? (
                    <ActivitySpinnerIcon className="icon-xs" />
                  ) : step.status === "success" ? (
                    <CheckmarkIcon className="icon-xs" />
                  ) : null}
                  <span>{step.label}</span>
                </div>
              ))}
            </div>
          ) : null}
          <NodexDialogFooter>
            <NodexDialogAction onClick={onClose}>
              {busy
                ? intl.formatMessage({
                    id: "conversation.threadMoveDialog.close",
                    defaultMessage: "Close",
                  })
                : intl.formatMessage({
                    id: "conversation.threadMoveDialog.cancel",
                    defaultMessage: "Cancel",
                  })}
            </NodexDialogAction>
            <NodexDialogAction
              tone="primary"
              disabled={busy || blocked}
              onClick={() => {
                if (!destination) return;
                void move(destination, source === "present" ? "present" : "missing").catch(
                  (cause) =>
                    toastFailure(
                      intl.formatMessage({
                        id: "conversation.threadMoveDialog.moveError",
                        defaultMessage: "Couldn’t move the chat",
                      }),
                      cause,
                    ),
                );
              }}
            >
              {busy
                ? intl.formatMessage({
                    id: "conversation.threadMoveDialog.moving",
                    defaultMessage: "Moving…",
                  })
                : title}
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogFrame>
      </NodexDialogContent>
    </NodexDialog>
  );
}
