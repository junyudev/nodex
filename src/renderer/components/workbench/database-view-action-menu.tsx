import { defineMessages, useIntl } from "@/lib/i18n";
import { useId, type ComponentType } from "react";

import {
  CheckmarkIcon,
  ChevronRightIcon,
  PageMenuCopyLinkIcon,
  BoardIcon,
  DeleteIcon,
  EditIcon,
} from "@/components/shared/icons";
import { NativeMenuIcon } from "@/components/shared/icons/native-menu-icon";
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

const displayModeMessages = defineMessages({
  icon_and_text: {
    id: "database.databaseViewActionMenu.textAndIcon",
    defaultMessage: "Text and icon",
  },
  text_only: { id: "database.databaseViewActionMenu.textOnly", defaultMessage: "Text only" },
  icon_only: { id: "database.databaseViewActionMenu.iconOnly", defaultMessage: "Icon only" },
} satisfies Record<DatabaseViewTabDisplayMode, { id: string; defaultMessage: string }>);

const DISPLAY_MODES: readonly DatabaseViewTabDisplayMode[] = [
  "icon_and_text",
  "text_only",
  "icon_only",
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
  const intl = useIntl();
  const ViewIcon = session.viewIcon;
  const lastViewReasonId = useId();
  return (
    <NodexContextMenuPortal>
      <NodexContextMenuContent
        aria-label={intl.formatMessage(
          {
            id: "database.databaseViewActionMenu.actionsForView",
            defaultMessage: "Actions for {name}",
          },
          { name: session.viewName },
        )}
        className="w-[220px] min-w-[180px] max-w-[calc(100vw-24px)]"
        collisionPadding={12}
        sideOffset={2}
      >
        <NodexContextMenuItem
          disabled={session.busy}
          leftSlot={<BoardIcon />}
          onSelect={() => invokeAfterClose(onMenuOpenChange, session.onOpenSource)}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span>
              {intl.formatMessage({
                id: "database.databaseViewActionMenu.source",
                defaultMessage: "Source",
                description: "Data Source associated with the View",
              })}
            </span>
            <span className="min-w-0 truncate text-token-description-foreground">
              {session.dataSourceName}
            </span>
          </span>
        </NodexContextMenuItem>

        <NodexDropdown.Separator paddingClassName="py-1" />
        <NodexContextMenuItem
          disabled={session.busy}
          leftSlot={<PageMenuCopyLinkIcon />}
          onSelect={() => invokeAfterClose(onMenuOpenChange, session.onCopyLink)}
        >
          {intl.formatMessage({
            id: "database.databaseViewActionMenu.copyViewLink",
            defaultMessage: "Copy link to view",
          })}
        </NodexContextMenuItem>

        <NodexDropdown.Separator paddingClassName="py-1" />
        <NodexContextMenuItem
          disabled={session.busy}
          leftSlot={<EditIcon />}
          onSelect={() => invokeAfterClose(onMenuOpenChange, session.onRename)}
        >
          {intl.formatMessage({
            id: "database.databaseViewActionMenu.rename",
            defaultMessage: "Rename",
          })}
        </NodexContextMenuItem>
        <NodexContextMenuSubmenu
          disabled={session.busy}
          trigger={
            <NodexContextMenuSubmenuTrigger
              leftSlot={<SlidersHorizontal />}
              rightSlot={<ChevronRightIcon className="size-4" />}
            >
              {intl.formatMessage({
                id: "database.databaseViewActionMenu.displayAs",
                defaultMessage: "Display as",
              })}
            </NodexContextMenuSubmenuTrigger>
          }
          contentClassName="w-[220px]"
          renderContent={() => (
            <>
              {DISPLAY_MODES.map((mode) => (
                <NodexContextMenuItem
                  key={mode}
                  rightSlot={
                    session.displayMode === mode ? <CheckmarkIcon className="size-4" /> : null
                  }
                  onSelect={() => {
                    session.onDisplayModeChange(mode);
                    onMenuOpenChange(false);
                  }}
                >
                  {intl.formatMessage(displayModeMessages[mode])}
                </NodexContextMenuItem>
              ))}
              <NodexDropdown.Separator paddingClassName="py-1" />
              <div className="px-2 py-1 text-xs leading-4 text-token-description-foreground">
                {intl.formatMessage({
                  id: "database.databaseViewActionMenu.onlyAppliesToYou",
                  defaultMessage: "Only applies to you",
                })}
              </div>
            </>
          )}
        />
        <NodexContextMenuItem
          disabled={session.busy}
          leftSlot={<ViewIcon />}
          onSelect={() => invokeAfterClose(onMenuOpenChange, session.onEdit)}
        >
          {intl.formatMessage({
            id: "database.databaseViewActionMenu.editView",
            defaultMessage: "Edit view",
          })}
        </NodexContextMenuItem>
        <NodexContextMenuItem
          disabled={session.busy}
          leftSlot={<NativeMenuIcon iconKey="duplicate" />}
          onSelect={() => invokeAfterClose(onMenuOpenChange, session.onDuplicate)}
        >
          {intl.formatMessage({
            id: "database.databaseViewActionMenu.duplicateView",
            defaultMessage: "Duplicate view",
          })}
        </NodexContextMenuItem>
        <NodexDropdown.Separator paddingClassName="py-1" />
        <NodexContextMenuItem
          tone="danger"
          disabled={session.busy || !session.canDelete}
          aria-describedby={!session.canDelete ? lastViewReasonId : undefined}
          leftSlot={<DeleteIcon />}
          onSelect={() => {
            onMenuOpenChange(false);
            queueMicrotask(session.onRequestDelete);
          }}
        >
          {intl.formatMessage({
            id: "database.databaseViewActionMenu.deleteView",
            defaultMessage: "Delete view",
          })}
        </NodexContextMenuItem>
        {!session.canDelete ? (
          <div
            id={lastViewReasonId}
            className="px-2 pb-1 text-xs text-token-description-foreground"
          >
            {intl.formatMessage({
              id: "database.databaseViewActionMenu.lastViewRequired",
              defaultMessage: "Keep at least one view",
            })}
          </div>
        ) : null}
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
  const intl = useIntl();
  return (
    <NodexDialog open onOpenChange={(open) => !open && onClose()}>
      <NodexDialogContent size="compact" showCloseButton={false}>
        <NodexDialogFrame>
          <NodexDialogHeader>
            <NodexDialogTitle>
              {intl.formatMessage(
                {
                  id: "database.databaseViewActionMenu.confirmDelete",
                  defaultMessage: "Delete {name}?",
                },
                { name: viewName },
              )}
            </NodexDialogTitle>
            <NodexDialogDescription>
              {intl.formatMessage({
                id: "database.databaseViewActionMenu.deleteViewDescription",
                defaultMessage:
                  "This deletes the View only. Its pages and data source stay intact.",
              })}
            </NodexDialogDescription>
          </NodexDialogHeader>
          <NodexDialogFooter>
            <NodexDialogAction disabled={busy} onClick={onClose}>
              {intl.formatMessage({
                id: "database.databaseViewActionMenu.cancel",
                defaultMessage: "Cancel",
              })}
            </NodexDialogAction>
            <NodexDialogAction tone="danger" disabled={busy} onClick={() => void onConfirm()}>
              {busy
                ? intl.formatMessage({
                    id: "database.databaseViewActionMenu.deleting",
                    defaultMessage: "Deleting…",
                  })
                : intl.formatMessage({
                    id: "database.databaseViewActionMenu.deleteView",
                    defaultMessage: "Delete view",
                  })}
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogFrame>
      </NodexDialogContent>
    </NodexDialog>
  );
}
