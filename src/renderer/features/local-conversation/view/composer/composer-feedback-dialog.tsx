import { useIntl } from "@/lib/i18n";
import { useState, type FormEvent } from "react";
import type { FeedbackUploadParams } from "@nodex/codex-app-server-protocol/v2";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogForm,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { NodexCheckbox } from "@/components/ui/settings";
import { toast } from "@/components/ui/toast";
import { runWithCleanup } from "@/lib/run-with-cleanup";

/** Sends feedback about this chat, with its logs unless the person leaves them out. */
export function ComposerFeedbackDialog({
  open,
  threadId,
  uploadFeedback,
  onOpenChange,
}: {
  open: boolean;
  threadId: string | null;
  uploadFeedback: (params: FeedbackUploadParams) => Promise<void>;
  onOpenChange: (open: boolean) => void;
}) {
  const intl = useIntl();
  const [reason, setReason] = useState("");
  const [includeLogs, setIncludeLogs] = useState(true);
  const [sending, setSending] = useState(false);
  const trimmedReason = reason.trim();

  const close = () => {
    onOpenChange(false);
    setReason("");
    setIncludeLogs(true);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!trimmedReason || sending) return;
    setSending(true);
    await runWithCleanup(
      async () => {
        await uploadFeedback({
          classification: "feedback",
          reason: trimmedReason,
          threadId,
          includeLogs,
        });
        toast.success(
          intl.formatMessage({
            id: "conversation.composerFeedbackDialog.sent",
            defaultMessage: "Feedback sent",
          }),
        );
        close();
      },
      {
        onError: (error: unknown) => {
          toast.danger(
            error instanceof Error
              ? error.message
              : intl.formatMessage({
                  id: "conversation.composerFeedbackDialog.failed",
                  defaultMessage: "Couldn’t send feedback",
                }),
          );
        },
        cleanup: () => setSending(false),
      },
    );
  };

  return (
    <NodexDialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <NodexDialogContent size="default">
        <NodexDialogForm onSubmit={(event) => void submit(event)}>
          <NodexDialogHeader>
            <NodexDialogTitle>
              {intl.formatMessage({
                id: "conversation.composerFeedbackDialog.title",
                defaultMessage: "Send feedback",
              })}
            </NodexDialogTitle>
            <NodexDialogDescription>
              {intl.formatMessage({
                id: "conversation.composerFeedbackDialog.description",
                defaultMessage: "Tell us what happened in this chat or what you expected instead.",
              })}
            </NodexDialogDescription>
          </NodexDialogHeader>
          <NodexDialogBody className="gap-3">
            <textarea
              autoFocus
              aria-label={intl.formatMessage({
                id: "conversation.composerFeedbackDialog.reason",
                defaultMessage: "Feedback",
              })}
              className="min-h-28 resize-y rounded-lg border border-token-border bg-token-main-surface-primary px-3 py-2 text-sm outline-none placeholder:text-token-text-tertiary focus-visible:ring-1 focus-visible:ring-token-focus-border"
              value={reason}
              placeholder={intl.formatMessage({
                id: "conversation.composerFeedbackDialog.placeholder",
                defaultMessage: "What should we know?",
              })}
              onChange={(event) => setReason(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <label className="flex items-center gap-2 text-sm text-token-text-secondary">
              <NodexCheckbox checked={includeLogs} onCheckedChange={setIncludeLogs} />
              {intl.formatMessage({
                id: "conversation.composerFeedbackDialog.includeLogs",
                defaultMessage: "Include logs",
              })}
            </label>
          </NodexDialogBody>
          <NodexDialogFooter>
            <NodexDialogAction onClick={close}>
              {intl.formatMessage({
                id: "conversation.composerFeedbackDialog.cancel",
                defaultMessage: "Cancel",
              })}
            </NodexDialogAction>
            <NodexDialogAction type="submit" tone="primary" disabled={!trimmedReason || sending}>
              {intl.formatMessage({
                id: "conversation.composerFeedbackDialog.send",
                defaultMessage: "Send",
              })}
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogForm>
      </NodexDialogContent>
    </NodexDialog>
  );
}
