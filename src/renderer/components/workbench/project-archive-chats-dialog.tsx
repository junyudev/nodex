import { runWithCleanup } from "@/lib/run-with-cleanup";
import { useState, type FormEvent } from "react";
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
import { toast } from "@/components/ui/toast";
import type { CodexSidebarThreadItem } from "@/lib/types";

const ARCHIVE_BATCH_SIZE = 8;

export async function runProjectThreadBatches<Item, Result>(
  items: readonly Item[],
  run: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = [];
  for (let index = 0; index < items.length; index += ARCHIVE_BATCH_SIZE) {
    const batch = items.slice(index, index + ARCHIVE_BATCH_SIZE);
    results.push(...(await Promise.all(batch.map(run))));
  }
  return results;
}

function chatCountLabel(count: number): string {
  return count === 1 ? `${count} chat` : `${count} chats`;
}

export function ProjectArchiveChatsDialog({
  open,
  projectName,
  items,
  onOpenChange,
  onArchiveItem,
  onArchived,
}: {
  open: boolean;
  projectName: string;
  items: readonly CodexSidebarThreadItem[];
  onOpenChange: (open: boolean) => void;
  onArchiveItem: (item: CodexSidebarThreadItem) => Promise<boolean>;
  onArchived?: () => Promise<unknown> | void;
}) {
  const [archiving, setArchiving] = useState(false);

  const setOpen = (nextOpen: boolean) => {
    if (archiving) return;
    onOpenChange(nextOpen);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (archiving || items.length === 0) return;

    setArchiving(true);
    return runWithCleanup(
      async () => {
        const results = await runProjectThreadBatches(items, async (item) => {
          try {
            return await onArchiveItem(item);
          } catch {
            return false;
          }
        });
        await onArchived?.();
        const succeededCount = results.filter(Boolean).length;
        const failedCount = results.length - succeededCount;
        if (succeededCount > 0 && failedCount === 0) {
          toast.success(`Archived ${chatCountLabel(succeededCount)}`);
        } else if (succeededCount > 0) {
          toast.danger(
            `Archived ${chatCountLabel(succeededCount)} in ${projectName}; ${failedCount} failed`,
          );
        } else {
          toast.danger(`Failed to archive active chats in ${projectName}`);
        }
        onOpenChange(false);
      },
      {
        cleanup: () => {
          setArchiving(false);
        },
      },
    );
  };

  return (
    <NodexDialog
      open={open}
      disablePointerDismissal={archiving}
      onOpenChange={(nextOpen, details) => {
        if (!nextOpen && archiving) {
          details.cancel();
          return;
        }
        setOpen(nextOpen);
      }}
    >
      <NodexDialogContent size="compact">
        <NodexDialogForm onSubmit={(event) => void submit(event)}>
          <NodexDialogHeader>
            <NodexDialogTitle>Archive {chatCountLabel(items.length)}?</NodexDialogTitle>
            <NodexDialogDescription>
              This will archive the chats in {projectName}. You can find them later in your archived
              chats
            </NodexDialogDescription>
          </NodexDialogHeader>
          <NodexDialogFooter>
            <NodexDialogAction type="button" disabled={archiving} onClick={() => setOpen(false)}>
              Cancel
            </NodexDialogAction>
            <NodexDialogAction tone="danger" type="submit" disabled={archiving}>
              {archiving ? "Archiving…" : "Archive all"}
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogForm>
      </NodexDialogContent>
    </NodexDialog>
  );
}
