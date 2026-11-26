import { FormattedMessage, useIntl } from "@/lib/i18n";
import { BranchStatusIcon } from "@/components/shared/icons";
import {
  NodexDialog as Dialog,
  NodexDialogContent as DialogContent,
  NodexDialogFrame as DialogFrame,
  NodexDialogHeader as DialogHeader,
  NodexDialogTitle as DialogTitle,
} from "@/components/ui/dialog";

interface LocalConversationForkFromTurnDialogProps {
  open: boolean;
  isWorktreeThread: boolean;
  canForkIntoWorktree: boolean;
  isSubmitting: boolean;
  showWorktreeOption: boolean;
  onOpenChange: (open: boolean) => void;
  onForkIntoLocal: () => void;
  onForkIntoWorktree: () => void;
}

const choiceClassName =
  "flex w-full cursor-interaction items-center gap-3 rounded-lg px-[var(--padding-row-x)] py-2 text-start text-token-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border enabled:hover:bg-token-list-hover-background disabled:cursor-not-allowed disabled:opacity-50";

function ForkChoice({
  title,
  description,
  disabled,
  onClick,
}: {
  title: string;
  description: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={choiceClassName} disabled={disabled} onClick={onClick}>
      <BranchStatusIcon className="icon-xs shrink-0 opacity-75" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium electron:text-base">{title}</span>
        <span className="text-xs whitespace-normal text-token-description-foreground">
          {description}
        </span>
      </span>
    </button>
  );
}

export function LocalConversationForkFromTurnDialog({
  open,
  isWorktreeThread,
  canForkIntoWorktree,
  isSubmitting,
  showWorktreeOption,
  onOpenChange,
  onForkIntoLocal,
  onForkIntoWorktree,
}: LocalConversationForkFromTurnDialogProps) {
  const intl = useIntl();
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (isSubmitting && !nextOpen) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent size="compact" showCloseButton={false} finalFocus={!isSubmitting}>
        <DialogFrame className="gap-4">
          <DialogHeader>
            <DialogTitle>
              <FormattedMessage
                id="conversation.forkFromTurnDialog.title"
                defaultMessage="Continue in a new chat"
              />
            </DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-1">
            <ForkChoice
              title={
                isWorktreeThread
                  ? intl.formatMessage({
                      id: "conversation.forkFromTurnDialog.useCurrentWorktree",
                      defaultMessage: "Use this worktree",
                    })
                  : intl.formatMessage({
                      id: "conversation.forkFromTurnDialog.useCurrentWorkspace",
                      defaultMessage: "Use this workspace",
                    })
              }
              description={
                isWorktreeThread
                  ? intl.formatMessage({
                      id: "conversation.forkFromTurnDialog.continueInCurrentWorktree",
                      defaultMessage: "Continue from this message in the same worktree",
                    })
                  : intl.formatMessage({
                      id: "conversation.forkFromTurnDialog.continueInLocalChat",
                      defaultMessage: "Continue from this message in a new local chat",
                    })
              }
              disabled={isSubmitting}
              onClick={onForkIntoLocal}
            />
            {showWorktreeOption ? (
              <ForkChoice
                title={intl.formatMessage({
                  id: "conversation.forkFromTurnDialog.useNewWorktree",
                  defaultMessage: "Use a new worktree",
                })}
                description={
                  canForkIntoWorktree
                    ? intl.formatMessage({
                        id: "conversation.forkFromTurnDialog.continueInNewWorktree",
                        defaultMessage: "Continue from this message in a new worktree",
                      })
                    : intl.formatMessage({
                        id: "conversation.forkFromTurnDialog.gitRequired",
                        defaultMessage:
                          "A Git repository is required to continue in a new worktree",
                      })
                }
                disabled={isSubmitting || !canForkIntoWorktree}
                onClick={onForkIntoWorktree}
              />
            ) : null}
          </div>
        </DialogFrame>
      </DialogContent>
    </Dialog>
  );
}
