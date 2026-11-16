import { useIntl } from "@/lib/i18n";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogForm,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";

export interface QueuedFollowUpSendDialogProps {
  open: boolean;
  queuedMessageCount: number;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onClearQueue: () => void;
  onSendMessage: () => void;
}

export function QueuedFollowUpSendDialog({
  open,
  queuedMessageCount,
  pending,
  onOpenChange,
  onClearQueue,
  onSendMessage,
}: QueuedFollowUpSendDialogProps) {
  const intl = useIntl();

  return (
    <NodexDialog open={open} onOpenChange={onOpenChange}>
      <NodexDialogContent size="compact">
        <NodexDialogForm
          onSubmit={(event) => {
            event.preventDefault();
            if (pending) return;
            onSendMessage();
          }}
        >
          <NodexDialogHeader>
            <NodexDialogTitle>
              {intl.formatMessage({
                id: "conversation.queuedFollowUpSendDialog.title",
                defaultMessage: "Send message?",
              })}
            </NodexDialogTitle>
            <NodexDialogDescription>
              {intl.formatMessage(
                {
                  id: "conversation.queuedFollowUpSendDialog.description",
                  defaultMessage:
                    "You are about to send a message. Do you want to clear the {count, plural, one {{count} message} other {{count} messages}} previously queued?",
                },
                { count: queuedMessageCount },
              )}
            </NodexDialogDescription>
          </NodexDialogHeader>
          <NodexDialogFooter>
            <NodexDialogAction autoFocus tone="danger" disabled={pending} onClick={onClearQueue}>
              {intl.formatMessage({
                id: "conversation.queuedFollowUpSendDialog.clearQueue",
                defaultMessage: "Clear queue",
              })}
            </NodexDialogAction>
            <NodexDialogAction tone="primary" type="submit" disabled={pending}>
              {intl.formatMessage({
                id: "conversation.queuedFollowUpSendDialog.send",
                defaultMessage: "Send message",
              })}
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogForm>
      </NodexDialogContent>
    </NodexDialog>
  );
}
