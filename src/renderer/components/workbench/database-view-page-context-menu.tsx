import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";

import {
  ChevronRightIcon,
  MoveToIcon,
  PageMenuCopyIcon,
  PageMenuCopyIdIcon,
  PageMenuCopyLinkIcon,
  PageMenuCopyMarkdownIcon,
  PageMenuCopyTitleIcon,
  PageMenuDeleteIcon,
  PageMenuMoveBottomIcon,
  PageMenuMoveDownIcon,
  PageMenuMoveIcon,
  PageMenuMoveTopIcon,
  PageMenuMoveUpIcon,
  PageMenuOpenInIcon,
  PageMenuOpenNewChatIcon,
  ThreadIcon,
} from "@/components/shared/icons";
import {
  DataSourcePagePropertyContextMenuItems,
  pagePropertyContextMenuHasMatches,
} from "@/components/database/data-source-page-property-context-menu";
import type { DataSourcePagePropertyMenuSource } from "@/components/database/data-source-page-property-menu-source";
import {
  NodexContextMenuContent,
  NodexContextMenuItem,
  NodexContextMenuPortal,
  NodexContextMenuRoot,
  NodexContextMenuSubmenu,
  NodexContextMenuSubmenuTrigger,
  NodexContextMenuTrigger,
} from "@/components/ui/context-menu";
import { NodexDropdown } from "@/components/ui/dropdown";
import { NodexPopover, NodexPopoverAnchor, NodexPopoverContent } from "@/components/ui/popover";
import { toast } from "@/components/ui/toast";
import { NfmSendToThreadMenu } from "@/components/board/editor/nfm-send-to-thread-menu";
import { writeTextToClipboard } from "@/lib/clipboard";
import { loadPageDocumentMaterialization } from "@/lib/page-prompt-context";
import { usePresentedPageTitle } from "@/lib/page-title-projection-context";
import { useDevelopmentFeature } from "@/lib/development-features-context";
import type {
  DatabaseViewPageActionPort,
  DatabaseViewPageTarget,
} from "./database-view-page-actions";
import {
  buildDatabaseViewPageMenuEntries,
  databaseViewPageReorderDirection,
  filterDatabaseViewPageMenuEntries,
  type DatabaseViewPageMenuActionId,
  type DatabaseViewPageMenuEntry,
  type DatabaseViewPageReorderDirection,
} from "./database-view-page-menu-model";
import {
  isDatabaseViewPageCopyActionId,
  resolveDatabaseViewPageCopyRequest,
} from "./database-view-page-copy-model";
import { PageMoveDestinationPicker } from "@/components/library/page-move-destination-picker";

interface ChatPickerState {
  readonly anchorRect: DOMRect;
  readonly open: boolean;
}

const copyWithFeedback = async (
  value: string,
  successMessage: string,
  failureMessage: string,
): Promise<void> => {
  const copied = await writeTextToClipboard(value);
  if (copied) {
    toast.success(successMessage);
    return;
  }
  toast.danger(failureMessage);
};

function DatabaseViewPageMenuActionIcon({
  actionId,
}: {
  readonly actionId: DatabaseViewPageMenuActionId;
}) {
  switch (actionId) {
    case "move-to":
      return <MoveToIcon />;
    case "reorder":
      return <PageMenuMoveIcon />;
    case "reorder-top":
      return <PageMenuMoveTopIcon />;
    case "reorder-up":
      return <PageMenuMoveUpIcon />;
    case "reorder-down":
      return <PageMenuMoveDownIcon />;
    case "reorder-bottom":
      return <PageMenuMoveBottomIcon />;
    case "copy":
      return <PageMenuCopyIcon />;
    case "copy-id":
      return <PageMenuCopyIdIcon />;
    case "copy-deeplink":
      return <PageMenuCopyLinkIcon />;
    case "copy-title":
      return <PageMenuCopyTitleIcon />;
    case "copy-markdown":
      return <PageMenuCopyMarkdownIcon />;
    case "open-in":
      return <PageMenuOpenInIcon />;
    case "open-in-new-chat":
      return <PageMenuOpenNewChatIcon />;
    case "send-to-chat":
      return <ThreadIcon className="icon-xs shrink-0" />;
    case "delete":
      return <PageMenuDeleteIcon />;
  }
}

function PageActionSubmenu({
  entry,
  onSelect,
}: {
  readonly entry: DatabaseViewPageMenuEntry;
  readonly onSelect: (actionId: DatabaseViewPageMenuActionId) => void;
}) {
  return (
    <NodexContextMenuSubmenu
      trigger={
        <NodexContextMenuSubmenuTrigger
          leftSlot={<DatabaseViewPageMenuActionIcon actionId={entry.id} />}
          rightSlot={<ChevronRightIcon className="icon-xs opacity-75" />}
        >
          {entry.label}
        </NodexContextMenuSubmenuTrigger>
      }
      alignOffset={-4}
      contentClassName="min-w-[220px]"
      renderContent={() => (
        <>
          {entry.children?.map((child) => (
            <NodexContextMenuItem
              key={child.id}
              disabled={child.disabled}
              leftSlot={<DatabaseViewPageMenuActionIcon actionId={child.id} />}
              onSelect={() => onSelect(child.id)}
            >
              {child.label}
            </NodexContextMenuItem>
          ))}
        </>
      )}
    />
  );
}

function ChatPicker({
  state,
  page,
  actionPort,
  onClose,
}: {
  readonly state: ChatPickerState | null;
  readonly page: DatabaseViewPageTarget;
  readonly actionPort: DatabaseViewPageActionPort;
  readonly onClose: () => void;
}) {
  const projectId = page.projectId;
  if (!state || !projectId || !actionPort.sendToChat) return null;

  return (
    <NodexPopover
      open={state.open}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <NodexPopoverAnchor>
        <span
          aria-hidden="true"
          className="pointer-events-none fixed size-px"
          style={{
            left: state.anchorRect.left,
            top: state.anchorRect.bottom,
          }}
        />
      </NodexPopoverAnchor>
      {state.open ? (
        <NodexPopoverContent
          align="start"
          side="bottom"
          sideOffset={6}
          className="w-[330px] max-w-[calc(100vw-24px)] overflow-hidden p-1"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          finalFocus={false}
        >
          <NfmSendToThreadMenu
            projectId={projectId}
            onAccept={async ({ target }) => {
              await actionPort.sendToChat?.({
                projectId,
                pageId: page.pageId,
                ...(page.pageKey ? { pageKey: page.pageKey } : {}),
                titleSnapshot: page.titleSnapshot,
                target,
              });
              onClose();
            }}
            onClose={onClose}
            showModeSelector={false}
          />
        </NodexPopoverContent>
      ) : null}
    </NodexPopover>
  );
}

export interface DatabaseViewPageMenuSession {
  readonly page: DatabaseViewPageTarget;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly propertySource: DataSourcePagePropertyMenuSource;
  readonly groupingPropertyId?: string | null;
  readonly actionPort?: DatabaseViewPageActionPort;
  readonly deleteDisabled?: boolean;
  readonly onReorder: (direction: DatabaseViewPageReorderDirection) => void;
}

const EMPTY_PAGE_ACTION_PORT: DatabaseViewPageActionPort = {};

export function DatabaseViewPageContextMenuOverlay({
  menuOpen,
  onMenuOpenChange,
  returnFocusRef,
  page,
  canMoveUp,
  canMoveDown,
  propertySource,
  groupingPropertyId = null,
  actionPort = EMPTY_PAGE_ACTION_PORT,
  deleteDisabled = false,
  onReorder,
}: {
  readonly menuOpen: boolean;
  readonly onMenuOpenChange: (open: boolean) => void;
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
} & DatabaseViewPageMenuSession) {
  const [query, setQuery] = useState("");
  const [chatPicker, setChatPicker] = useState<ChatPickerState | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const redirectedInitialFocusRef = useRef(false);
  const presentedTitle = usePresentedPageTitle(page.pageId, page.titleSnapshot, page.libraryId);
  const showReorder = useDevelopmentFeature("database-page-reorder-menu");
  const presentedPage = { ...page, titleSnapshot: presentedTitle };
  const actions = filterDatabaseViewPageMenuEntries(
    buildDatabaseViewPageMenuEntries({
      hasPageKey: Boolean(page.pageKey),
      canMoveUp,
      canMoveDown,
      showReorder,
      canCopyMarkdown: true,
      canOpenInNewChat: Boolean(page.projectId && actionPort.openInNewChat),
      canSendToChat: Boolean(page.projectId && actionPort.sendToChat),
      canDelete: Boolean(actionPort.deletePage) && !deleteDisabled,
    }),
    query,
  );
  const hasVisibleProperties = pagePropertyContextMenuHasMatches(propertySource.descriptors, query);

  const handleMenuOpenChange = (open: boolean): void => {
    onMenuOpenChange(open);
    redirectedInitialFocusRef.current = false;
    if (open) setChatPicker(null);
    if (!open) setQuery("");
  };

  useEffect(() => {
    if (menuOpen || !chatPicker || chatPicker.open) return;
    const frame = requestAnimationFrame(() => {
      setChatPicker((current) => (current ? { ...current, open: true } : null));
    });
    return () => cancelAnimationFrame(frame);
  }, [chatPicker, menuOpen]);

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      handleMenuOpenChange(false);
      return;
    }
    if (event.key !== "ArrowDown") return;
    const firstItem = contentRef.current?.querySelector<HTMLElement>(
      '[role="menuitem"]:not([data-disabled])',
    );
    if (!firstItem) return;
    event.preventDefault();
    firstItem.focus();
  };

  const selectAction = (actionId: DatabaseViewPageMenuActionId): void => {
    const reorderDirection = databaseViewPageReorderDirection(actionId);
    if (reorderDirection) {
      onReorder(reorderDirection);
      return;
    }

    if (isDatabaseViewPageCopyActionId(actionId)) {
      const request = resolveDatabaseViewPageCopyRequest({
        actionId,
        page,
        presentedTitle,
      });
      if (!request) return;
      if (request.kind === "value") {
        void copyWithFeedback(request.value, request.successMessage, request.failureMessage);
        return;
      }
      void loadPageDocumentMaterialization({
        accessContext: request.accessContext,
        pageId: request.pageId,
      })
        .then((materialized) =>
          copyWithFeedback(materialized.nfm, request.successMessage, request.failureMessage),
        )
        .catch(() => {
          toast.danger(request.failureMessage);
        });
      return;
    }

    const pageChatInput = page.projectId
      ? {
          projectId: page.projectId,
          pageId: page.pageId,
          ...(page.pageKey ? { pageKey: page.pageKey } : {}),
          titleSnapshot: presentedTitle,
        }
      : null;
    if (actionId === "open-in-new-chat" && pageChatInput) {
      void Promise.resolve()
        .then(() => actionPort.openInNewChat?.(pageChatInput))
        .catch(() => {
          toast.danger("Failed to open Page in a new chat");
        });
      return;
    }
    if (actionId === "send-to-chat") {
      const anchorRect = contentRef.current?.getBoundingClientRect();
      if (anchorRect) setChatPicker({ anchorRect, open: false });
      return;
    }
    if (actionId !== "delete" || !actionPort.deletePage) return;
    void Promise.resolve()
      .then(() => actionPort.deletePage?.(presentedPage))
      .catch(() => {
        toast.danger("Failed to delete Page");
      });
  };

  const selectActionAndClose = (actionId: DatabaseViewPageMenuActionId): void => {
    selectAction(actionId);
    handleMenuOpenChange(false);
  };

  const renderAction = (action: DatabaseViewPageMenuEntry, index: number): ReactNode => {
    const separator = action.id === "delete" && index > 0 ? <NodexDropdown.Separator /> : null;
    if (action.id === "move-to") {
      return (
        <NodexContextMenuSubmenu
          key={action.id}
          trigger={
            <NodexContextMenuSubmenuTrigger
              leftSlot={<DatabaseViewPageMenuActionIcon actionId={action.id} />}
              rightSlot={<ChevronRightIcon className="icon-xs opacity-75" />}
            >
              {action.label}
            </NodexContextMenuSubmenuTrigger>
          }
          alignOffset={-4}
          contentClassName="w-[330px] max-w-[calc(100vw-24px)] overflow-hidden p-0"
          renderContent={() => (
            <PageMoveDestinationPicker
              pageId={page.pageId}
              title={presentedTitle}
              onClose={() => handleMenuOpenChange(false)}
            />
          )}
        />
      );
    }
    if (action.children) {
      return (
        <Fragment key={action.id}>
          {separator}
          <PageActionSubmenu entry={action} onSelect={selectActionAndClose} />
        </Fragment>
      );
    }
    return (
      <Fragment key={action.id}>
        {separator}
        <NodexContextMenuItem
          disabled={action.disabled}
          tone={action.id === "delete" ? "danger" : "default"}
          leftSlot={<DatabaseViewPageMenuActionIcon actionId={action.id} />}
          onSelect={() => selectActionAndClose(action.id)}
        >
          {action.label}
        </NodexContextMenuItem>
      </Fragment>
    );
  };

  return (
    <>
      <NodexContextMenuPortal>
        <NodexContextMenuContent
          ref={contentRef}
          finalFocus={returnFocusRef}
          onFocusCapture={(event) => {
            if (redirectedInitialFocusRef.current) return;
            redirectedInitialFocusRef.current = true;
            if (event.target === inputRef.current) return;
            queueMicrotask(() => inputRef.current?.focus());
          }}
          className="w-[265px]"
        >
          <NodexDropdown.SearchInput
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            onKeyDown={handleSearchKeyDown}
            onPointerDown={(event) => event.stopPropagation()}
            placeholder="Search actions and properties…"
            aria-label="Search Page actions and properties"
          />
          {!hasVisibleProperties && actions.length === 0 ? (
            <NodexDropdown.Message compact>No actions found</NodexDropdown.Message>
          ) : null}
          {hasVisibleProperties ? (
            <>
              <NodexDropdown.SectionLabel>Properties</NodexDropdown.SectionLabel>
              <DataSourcePagePropertyContextMenuItems
                source={propertySource}
                groupingPropertyId={groupingPropertyId}
                query={query}
                onContextMenuCommit={() => handleMenuOpenChange(false)}
              />
            </>
          ) : null}
          {hasVisibleProperties && actions.length > 0 ? <NodexDropdown.Separator /> : null}
          {actions.map(renderAction)}
        </NodexContextMenuContent>
      </NodexContextMenuPortal>
      <ChatPicker
        state={chatPicker}
        page={presentedPage}
        actionPort={actionPort}
        onClose={() => setChatPicker(null)}
      />
    </>
  );
}

export function DatabaseViewPageContextMenu({
  children,
  ...session
}: {
  readonly children: ReactElement;
} & DatabaseViewPageMenuSession) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <NodexContextMenuRoot open={menuOpen} onOpenChange={setMenuOpen}>
      <NodexContextMenuTrigger className="contents">{children}</NodexContextMenuTrigger>
      <DatabaseViewPageContextMenuOverlay
        {...session}
        menuOpen={menuOpen}
        onMenuOpenChange={setMenuOpen}
      />
    </NodexContextMenuRoot>
  );
}
