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
      toast.success("Chat restored");
    } catch {
      toast.danger("Failed to unarchive chat");
    }
  };

  const handle = toast.info("Archived chat", {
    id: `archive-chat-${chatId}`,
    leading: <Archive16Icon className="size-4 shrink-0" />,
    secondaryAction: { label: "View", onClick: viewArchivedChats },
    action: {
      label: "Undo",
      onClick: () => {
        void undo();
      },
    },
  });

  const succeeded = await archived;
  if (!succeeded) {
    handle.close();
    toast.danger("Failed to archive chat");
  }
  return succeeded;
}
