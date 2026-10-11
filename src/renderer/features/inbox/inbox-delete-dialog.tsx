import { useState } from "react";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";

export interface InboxDeleteRequest {
  readonly pageIds: readonly string[];
  /** The message itself, so the user sees exactly what will be erased. */
  readonly preview: string | null;
}

/**
 * Deleting erases, so it is confirmed once and says plainly what cannot be recalled: text
 * that already reached a suggestion runtime or a chat.
 */
export function InboxDeleteDialog({
  request,
  onCancel,
  onConfirm,
}: {
  readonly request: InboxDeleteRequest;
  readonly onCancel: () => void;
  readonly onConfirm: () => Promise<unknown>;
}) {
  const [deleting, setDeleting] = useState(false);
  const count = request.pageIds.length;
  return (
    <NodexDialog
      open
      onOpenChange={(open) => {
        if (!open && !deleting) onCancel();
      }}
    >
      <NodexDialogContent size="narrow" showCloseButton={false}>
        <NodexDialogFrame data-testid="inbox-delete-dialog">
          <NodexDialogHeader>
            <NodexDialogTitle>
              {count > 1 ? `Delete ${count} messages?` : "Delete this message?"}
            </NodexDialogTitle>
          </NodexDialogHeader>
          <NodexDialogBody className="flex flex-col gap-3">
            {request.preview ? (
              <p className="line-clamp-3 border-l-2 border-token-border pl-3 text-sm leading-relaxed whitespace-pre-wrap text-token-foreground/85">
                {request.preview}
              </p>
            ) : null}
            <NodexDialogDescription>
              Nodex erases {count > 1 ? "them" : "it"} with {count > 1 ? "their" : "its"} Page,
              history, and suggestions. This can’t be undone.
            </NodexDialogDescription>
            <p className="text-sm leading-normal text-token-description-foreground">
              Text already sent to a suggestion agent or a chat can’t be recalled. If it held a
              secret, rotate it.
            </p>
          </NodexDialogBody>
          <NodexDialogFooter>
            <NodexDialogAction disabled={deleting} onClick={onCancel}>
              Cancel
            </NodexDialogAction>
            <NodexDialogAction
              tone="danger"
              disabled={deleting}
              onClick={() => {
                setDeleting(true);
                void onConfirm().finally(() => setDeleting(false));
              }}
            >
              Delete
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogFrame>
      </NodexDialogContent>
    </NodexDialog>
  );
}
