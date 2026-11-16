import { FormattedMessage, getIntl, useIntl } from "@/lib/i18n";
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
  const intl = useIntl();
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
          toast.success(
            getIntl().formatMessage(
              {
                id: "workbench.projectArchiveChatsDialog.archived",
                defaultMessage: "Archived {count, plural, one {# chat} other {# chats}}",
              },
              { count: succeededCount },
            ),
          );
        } else if (succeededCount > 0) {
          toast.danger(
            getIntl().formatMessage(
              {
                id: "workbench.projectArchiveChatsDialog.partiallyArchived",
                defaultMessage:
                  "Archived {count, plural, one {# chat} other {# chats}} in {project}; {failed} failed",
              },
              { count: succeededCount, project: projectName, failed: failedCount },
            ),
          );
        } else {
          toast.danger(
            getIntl().formatMessage(
              {
                id: "workbench.projectArchiveChatsDialog.archiveFailed",
                defaultMessage: "Failed to archive active chats in {project}",
              },
              { project: projectName },
            ),
          );
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
            <NodexDialogTitle>
              <FormattedMessage
                id="workbench.projectArchiveChatsDialog.archiveTitle"
                defaultMessage={"Archive {count, plural, one {# chat} other {# chats}}?"}
                values={{ count: items.length }}
              />
            </NodexDialogTitle>
            <NodexDialogDescription>
              <FormattedMessage
                id="workbench.projectArchiveChatsDialog.description"
                defaultMessage={
                  "This will archive the chats in {project}. You can find them later in your archived chats"
                }
                values={{ project: projectName }}
              />
            </NodexDialogDescription>
          </NodexDialogHeader>
          <NodexDialogFooter>
            <NodexDialogAction type="button" disabled={archiving} onClick={() => setOpen(false)}>
              <FormattedMessage
                id="workbench.projectArchiveChatsDialog.cancel"
                defaultMessage={"Cancel"}
              />
            </NodexDialogAction>
            <NodexDialogAction tone="danger" type="submit" disabled={archiving}>
              {archiving
                ? intl.formatMessage({
                    id: "workbench.projectArchiveChatsDialog.archiving",
                    defaultMessage: "Archiving…",
                  })
                : intl.formatMessage({
                    id: "workbench.projectArchiveChatsDialog.archiveAll",
                    defaultMessage: "Archive all",
                  })}
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogForm>
      </NodexDialogContent>
    </NodexDialog>
  );
}
