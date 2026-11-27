import { FormattedMessage, useIntl } from "@/lib/i18n";
import {
  NodexDialog,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import type { InboxScope } from "../../../shared/inbox";
import {
  InboxCaptureCard,
  inboxDestinationLabel,
  type InboxCaptureDestination,
  type InboxCaptureSent,
} from "./inbox-capture-card";

export interface InboxQuickCaptureRequest {
  readonly destination: InboxCaptureDestination;
  /** Text selected where the capture began, added to the message. */
  readonly seed: string | null;
  readonly origin?: HTMLElement | null;
}

/**
 * Writes one message to an Inbox from wherever the user is, without leaving it. It is that
 * Inbox's own composer: the same draft, images and title, saved and sent the same way.
 */
export function InboxQuickCapture({
  request,
  windowSessionId,
  onClose,
  onOpenInbox,
}: {
  readonly request: InboxQuickCaptureRequest;
  readonly windowSessionId: string;
  readonly onClose: () => void;
  readonly onOpenInbox: (scope: InboxScope) => void;
}) {
  const intl = useIntl();
  const { destination, seed } = request;
  const label = inboxDestinationLabel(destination, intl);
  const confirm = (sent: InboxCaptureSent) => {
    onClose();
    toast.success(
      sent.start === null
        ? intl.formatMessage(
            { id: "inbox.inboxQuickCapture.sentToValue", defaultMessage: "Sent to {value1}" },
            { value1: label },
          )
        : destination.project
          ? intl.formatMessage(
              {
                id: "inbox.inboxQuickCapture.startingIn",
                defaultMessage: "Starting a chat in {project}",
              },
              { project: destination.project.name },
            )
          : intl.formatMessage({
              id: "inbox.inboxQuickCapture.nodexIsStartingIt",
              defaultMessage: "Sent — Nodex is starting it",
            }),
      {
        id: "inbox-quick-capture-sent",
        action: {
          label: intl.formatMessage({ id: "inbox.inboxQuickCapture.open", defaultMessage: "Open" }),
          onClick: () => onOpenInbox(destination.scope),
        },
      },
    );
  };

  return (
    <NodexDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <NodexDialogContent
        unstyledContent
        showCloseButton={false}
        overlayClassName="bg-black/[0.1333]"
        initialFocus={false}
        finalFocus={() => (request.origin?.isConnected ? request.origin : false)}
        className="top-[max(16px,18vh)] w-[min(640px,92vw)] translate-y-0 bg-transparent p-0"
      >
        <NodexDialogTitle className="sr-only">
          <FormattedMessage id="inbox.inboxQuickCapture.captureTo" defaultMessage="Capture to" />{" "}
          {label}
        </NodexDialogTitle>
        <NodexDialogDescription className="sr-only">
          {intl.formatMessage(
            {
              id: "inbox.inboxQuickCapture.captureDescription",
              defaultMessage: "Write a message to {target}. Nodex names it unless you add a title.",
            },
            { target: label },
          )}
        </NodexDialogDescription>
        <InboxCaptureCard
          destination={destination}
          windowSessionId={windowSessionId}
          seed={seed}
          focusToken={1}
          onSent={confirm}
        />
      </NodexDialogContent>
    </NodexDialog>
  );
}
