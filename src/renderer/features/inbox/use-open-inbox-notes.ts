import { useIntl } from "@/lib/i18n";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { readableIpcError } from "@/lib/ipc-error-message";
import { ensureInboxNotes } from "@/lib/inbox-runtime";
import type { InboxScope } from "../../../shared/inbox";
import { invalidateInbox } from "./use-inbox";

/**
 * Opens this Inbox's Notes Page. Every Inbox has Notes to open; the first visit
 * creates and binds the Page.
 */
export function useOpenInboxNotes(
  scope: InboxScope,
  notesPageId: string | null,
  onOpenPage: (pageId: string) => void,
): () => Promise<void> {
  const intl = useIntl();
  const queryClient = useQueryClient();
  return async () => {
    if (notesPageId) {
      onOpenPage(notesPageId);
      return;
    }
    await ensureInboxNotes({ scope }).then(
      ({ notesPageId: bound }) => onOpenPage(bound),
      (error: unknown) =>
        toast.danger(
          readableIpcError(
            error,
            intl.formatMessage({
              id: "inbox.useOpenInboxNotes.couldNotOpen",
              defaultMessage: "Notes could not be opened",
            }),
          ),
        ),
    );
    // A first open binds the Notes Page; the Inbox learns it without a refetch delay.
    void invalidateInbox(queryClient);
  };
}
