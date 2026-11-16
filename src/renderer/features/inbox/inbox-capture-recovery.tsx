import { FormattedMessage, useIntl } from "@/lib/i18n";
import { NodexButton } from "@/components/ui/button";
import { inboxDraftLabel, type PendingInboxCapture } from "./inbox-capture-state";

export function InboxCaptureRecovery({
  captures,
  storeEpoch,
  ready,
  onRetry,
  onRecover,
}: {
  readonly captures: readonly PendingInboxCapture[];
  readonly storeEpoch: string | null;
  readonly ready: boolean;
  readonly onRetry: (capture: PendingInboxCapture) => Promise<unknown>;
  readonly onRecover: (capture: PendingInboxCapture) => Promise<unknown>;
}) {
  const intl = useIntl();
  return (
    <>
      {captures.map((pending) => (
        <div
          key={pending.intent.pageId}
          role="status"
          className="mb-2 flex min-w-0 items-center gap-2 px-2 text-sm text-token-description-foreground"
        >
          <details className="min-w-0 flex-1">
            <summary className="cursor-interaction truncate">
              {inboxDraftLabel(pending.draft, intl)}
            </summary>
            <p className="whitespace-pre-wrap">{pending.draft.text}</p>
            <p className="mt-1 text-xs">
              {storeEpoch !== null && pending.intent.storeEpoch !== storeEpoch
                ? intl.formatMessage({
                    id: "inbox.inboxCaptureRecovery.fromBeforeAProfileRestore",
                    defaultMessage:
                      "From before a Profile restore. The original message may already exist.",
                  })
                : (pending.error ??
                  intl.formatMessage({
                    id: "inbox.inboxCaptureRecovery.waitingForInbox",
                    defaultMessage: "Waiting for Inbox",
                  }))}
            </p>
          </details>
          {pending.status === "needs_review" ||
          (storeEpoch !== null && pending.intent.storeEpoch !== storeEpoch) ? (
            <NodexButton size="xs" variant="ghost" onClick={() => void onRecover(pending)}>
              <FormattedMessage id="inbox.inboxCaptureRecovery.recover" defaultMessage="Recover" />
            </NodexButton>
          ) : (
            <NodexButton
              size="xs"
              variant="ghost"
              disabled={!ready}
              onClick={() => void onRetry(pending)}
            >
              <FormattedMessage id="inbox.inboxCaptureRecovery.retry" defaultMessage="Retry" />
            </NodexButton>
          )}
        </div>
      ))}
    </>
  );
}
