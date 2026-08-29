import type { ComponentType } from "react";

import {
  CheckmarkIcon,
  ChevronRightIcon,
  CopyIcon,
  DatabaseIcon,
  DeleteIcon,
  EditIcon,
  LinkToolbarCopyIcon,
} from "@/components/shared/icons";
import { SlidersHorizontal } from "@/components/shared/icons/generic-icons";
import {
  NodexContextMenuContent,
  NodexContextMenuItem,
  NodexContextMenuPortal,
  NodexContextMenuSubmenu,
  NodexContextMenuSubmenuTrigger,
} from "@/components/ui/context-menu";
import { NodexDropdown } from "@/components/ui/dropdown";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import type { DatabaseViewTabDisplayMode } from "@/lib/use-workbench-profile-preferences";

export interface DatabaseViewActionMenuSession {
  readonly viewId: string;
  readonly viewName: string;
  readonly viewIcon: ComponentType<{ className?: string }>;
  readonly dataSourceName: string;
  readonly displayMode: DatabaseViewTabDisplayMode;
  readonly busy: boolean;
  readonly canDelete: boolean;
  readonly onRename: () => void | Promise<void>;
  readonly onEdit: () => void | Promise<void>;
  readonly onOpenSource: () => void | Promise<void>;
  readonly onCopyLink: () => void | Promise<void>;
  readonly onDuplicate: () => void | Promise<void>;
  readonly onRequestDelete: () => void;
  readonly onDisplayModeChange: (mode: DatabaseViewTabDisplayMode) => void;
}

const DISPLAY_MODES: readonly {
  readonly mode: DatabaseViewTabDisplayMode;
  readonly label: string;
}[] = [
  { mode: "icon_and_text", label: "Text and icon" },
  { mode: "text_only", label: "Text only" },
  { mode: "icon_only", label: "Icon only" },
];

const invokeAfterClose = (
  onMenuOpenChange: (open: boolean) => void,
  action: () => void | Promise<void>,
): void => {
  onMenuOpenChange(false);
  queueMicrotask(() => void action());
};

export function DatabaseViewActionMenuOverlay({
  session,
  onMenuOpenChange,
}: {
  readonly session: DatabaseViewActionMenuSession;
  readonly onMenuOpenChange: (open: boolean) => void;
}) {
  const ViewIcon = session.viewIcon;
  return (
    <NodexContextMenuPortal>
      <NodexContextMenuContent
        aria-label={`Actions for ${session.viewName}`}
        className="w-[220px] min-w-[180px] max-w-[calc(100vw-24px)]"
        collisionPadding={12}
        sideOffset={2}
      >
        <NodexContextMenuItem
          disabled={session.busy}
          leftSlot={<EditIcon />}
          onSelect={() => invokeAfterClose(onMenuOpenChange, session.onRename)}
        >
          Rename
        </NodexContextMenuItem>
        <NodexContextMenuSubmenu
          disabled={session.busy}
          trigger={
            <NodexContextMenuSubmenuTrigger
              leftSlot={<SlidersHorizontal />}
              rightSlot={<ChevronRightIcon className="size-4" />}
            >
              Display as
            </NodexContextMenuSubmenuTrigger>
          }
          contentClassName="w-[220px]"
          renderContent={() => (
            <>
              {DISPLAY_MODES.map((entry) => (
                <NodexContextMenuItem
                  key={entry.mode}
                  rightSlot={
                    session.displayMode === entry.mode ? <CheckmarkIcon className="size-4" /> : null
                  }
                  onSelect={() => {
                    session.onDisplayModeChange(entry.mode);
                    onMenuOpenChange(false);
                  }}
                >
                  {entry.label}
                </NodexContextMenuItem>
              ))}
              <NodexDropdown.Separator paddingClassName="py-1" />
              <div className="px-2 py-1 text-xs leading-4 text-token-description-foreground">
                Only applies to you
              </div>
            </>
          )}
        />
        <NodexContextMenuItem
          disabled={session.busy}
          leftSlot={<ViewIcon />}
          onSelect={() => invokeAfterClose(onMenuOpenChange, session.onEdit)}
        >
          Edit view
        </NodexContextMenuItem>
        <NodexContextMenuItem
          disabled={session.busy}
          leftSlot={<DatabaseIcon />}
          rightSlot={<ChevronRightIcon className="size-4" />}
          onSelect={() => invokeAfterClose(onMenuOpenChange, session.onOpenSource)}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span>Source</span>
            <span className="min-w-0 truncate text-token-description-foreground">
              {session.dataSourceName}
            </span>
          </span>
        </NodexContextMenuItem>

        <NodexDropdown.Separator paddingClassName="py-1" />
        <NodexContextMenuItem
          disabled={session.busy}
          leftSlot={<LinkToolbarCopyIcon />}
          onSelect={() => invokeAfterClose(onMenuOpenChange, session.onCopyLink)}
        >
          Copy link to view
        </NodexContextMenuItem>

        <NodexDropdown.Separator paddingClassName="py-1" />
        <NodexContextMenuItem
          disabled={session.busy}
          leftSlot={<CopyIcon />}
          onSelect={() => invokeAfterClose(onMenuOpenChange, session.onDuplicate)}
        >
          Duplicate view
        </NodexContextMenuItem>
        <NodexContextMenuItem
          disabled={session.busy || !session.canDelete}
          leftSlot={<DeleteIcon />}
          onSelect={() => {
            onMenuOpenChange(false);
            queueMicrotask(session.onRequestDelete);
          }}
        >
          Delete view
        </NodexContextMenuItem>
      </NodexContextMenuContent>
    </NodexContextMenuPortal>
  );
}

export function DatabaseViewDeleteConfirmationDialog({
  viewName,
  busy,
  onClose,
  onConfirm,
}: {
  readonly viewName: string;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void | Promise<void>;
}) {
  return (
    <NodexDialog open onOpenChange={(open) => !open && onClose()}>
      <NodexDialogContent size="compact" showCloseButton={false}>
        <NodexDialogFrame>
          <NodexDialogHeader>
            <NodexDialogTitle>Delete {viewName}?</NodexDialogTitle>
            <NodexDialogDescription>
              This deletes the View only. Its pages and data source stay intact.
            </NodexDialogDescription>
          </NodexDialogHeader>
          <NodexDialogFooter>
            <NodexDialogAction disabled={busy} onClick={onClose}>
              Cancel
            </NodexDialogAction>
            <NodexDialogAction tone="danger" disabled={busy} onClick={() => void onConfirm()}>
              {busy ? "Deleting…" : "Delete view"}
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogFrame>
      </NodexDialogContent>
    </NodexDialog>
  );
}
