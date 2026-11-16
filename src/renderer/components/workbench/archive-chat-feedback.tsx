import { getIntl } from "@/lib/i18n";
import { Archive16Icon } from "@/components/shared/icons";
import { toast } from "@/components/ui/toast";

export interface ArchiveChatFeedbackInput {
  /** The chat's identity; archiving it again replaces its toast. */
  readonly chatId: string;
  /** Archives the chat and reports whether it landed. A rejection counts as a failure. */
  readonly archive: () => Promise<boolean>;
  /** Reverses the archive and returns the chat to where the person left it. */
  readonly restore: () => Promise<void>;
  readonly viewArchivedChats: () => void;
}

/**
 * Archives a chat with its toast: it appears with the gesture, and Undo waits for the archive to
 * land before reversing it, so a quick Undo can never lose the race with the archive it undoes.
 */
export async function archiveChatWithFeedback({
  chatId,
  archive,
  restore,
  viewArchivedChats,
}: ArchiveChatFeedbackInput): Promise<boolean> {
  const archived = archive().catch(() => false);

  const undo = async () => {
    if (!(await archived)) return;
    try {
      await restore();
      toast.success(
        getIntl().formatMessage({
          id: "workbench.archiveChatFeedback.restored",
          defaultMessage: "Chat restored",
        }),
      );
    } catch {
      toast.danger(
        getIntl().formatMessage({
          id: "workbench.archiveChatFeedback.restoreFailed",
          defaultMessage: "Failed to unarchive chat",
        }),
      );
    }
  };

  const handle = toast.info(
    getIntl().formatMessage({
      id: "workbench.archiveChatFeedback.archived",
      defaultMessage: "Archived chat",
    }),
    {
      id: `archive-chat-${chatId}`,
      leading: <Archive16Icon className="size-4 shrink-0" />,
      secondaryAction: {
        label: getIntl().formatMessage({
          id: "workbench.archiveChatFeedback.view",
          defaultMessage: "View",
        }),
        onClick: viewArchivedChats,
      },
      action: {
        label: getIntl().formatMessage({
          id: "workbench.archiveChatFeedback.undo",
          defaultMessage: "Undo",
        }),
        onClick: () => {
          void undo();
        },
      },
    },
  );

  const succeeded = await archived;
  if (!succeeded) {
    handle.close();
    toast.danger(
      getIntl().formatMessage({
        id: "workbench.archiveChatFeedback.archiveFailed",
        defaultMessage: "Failed to archive chat",
      }),
    );
  }
  return succeeded;
}
