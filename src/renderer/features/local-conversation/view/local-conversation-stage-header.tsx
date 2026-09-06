import { memo, useCallback, useState } from "react";
import {
  ArchiveIcon,
  EditIcon,
  ProjectActionsIcon,
  SessionPinFilledIcon,
  SessionPinIcon,
  SidePanelSideChatIcon,
  CopyIcon,
} from "@/components/shared/icons";
import {
  NodexDropdownFlyoutSubmenuItem,
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { toast } from "@/components/ui/toast";
import { writeTextToClipboardStrict } from "@/lib/clipboard";
import { buildSessionDeepLink } from "../../../../shared/nodex-deeplink";
import { cn } from "../../../lib/utils";
import type { ThreadStageActions, ThreadStageHeaderModel } from "../thread-stage-types";

interface ThreadStageHeaderProps {
  model: ThreadStageHeaderModel;
  actions: ThreadStageActions;
  onErrorMessage: (message: string | null) => void;
}

const menuIconClassName = "icon-xs shrink-0";

function ThreadStageHeaderComponent({ model, actions, onErrorMessage }: ThreadStageHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const canRenameThread = Boolean(model.threadId && actions.onRequestRenameThread);
  const canArchiveThread = Boolean(model.threadId && actions.onArchiveThread);
  const canTogglePin = Boolean(model.threadId && actions.onToggleThreadPin);
  const hasTopActions = canTogglePin || canRenameThread || canArchiveThread;
  const showThreadActions = Boolean(
    model.threadId || model.cwd || model.showSideChatAction || actions.onCopyConversationMarkdown,
  );

  const handleAction = useCallback(
    async (action: (() => void | Promise<void>) | undefined, fallbackError: string) => {
      if (!action) return;
      onErrorMessage(null);
      try {
        await action();
      } catch (error) {
        onErrorMessage(error instanceof Error ? error.message : fallbackError);
      }
    },
    [onErrorMessage],
  );

  const handleCopyText = useCallback(async (value: string | null, successMessage: string) => {
    if (!value) return;
    try {
      await writeTextToClipboardStrict(value);
      toast.success(successMessage);
    } catch {
      toast.danger("Failed to copy to clipboard");
    }
  }, []);

  return (
    <div
      className={cn(
        "draggable grid w-full min-w-0 grid-cols-[minmax(0,1fr)] items-center gap-x-4 electron:h-toolbar extension:py-row-y",
      )}
    >
      <div className="flex min-w-0 items-center gap-2 truncate text-base electron:font-medium">
        <span
          data-testid="thread-stage-title"
          className="inline-flex max-w-[320px] min-w-[2ch] items-center overflow-hidden text-token-foreground"
        >
          <span className="min-w-0 truncate">{model.title}</span>
        </span>
        <div className="no-drag flex items-center gap-2">
          {showThreadActions ? (
            <NodexDropdownMenu
              open={menuOpen}
              onOpenChange={setMenuOpen}
              align="start"
              sideOffset={1}
              contentWidth="menu"
              motion="none"
              triggerTooltipContent="Task actions"
              triggerButton={
                <button
                  type="button"
                  className={cn(
                    "no-drag inline-flex size-7 items-center justify-center rounded-lg border border-transparent p-1 text-token-text-tertiary outline-hidden",
                    "hover:bg-token-list-hover-background hover:text-token-text-primary focus-visible:ring-token-focus focus-visible:ring-2",
                    menuOpen && "bg-token-list-hover-background text-token-text-primary",
                  )}
                  aria-label="Task actions"
                >
                  <ProjectActionsIcon className="icon-sm" />
                </button>
              }
            >
              {canTogglePin ? (
                <NodexDropdownItem
                  leftSlot={
                    model.pinned ? (
                      <SessionPinFilledIcon className={menuIconClassName} />
                    ) : (
                      <SessionPinIcon className={menuIconClassName} />
                    )
                  }
                  keyboardShortcut={model.shortcuts?.togglePin}
                  onSelect={() =>
                    void handleAction(actions.onToggleThreadPin, "Failed to update task pin")
                  }
                >
                  {model.pinned ? "Unpin" : "Pin"}
                </NodexDropdownItem>
              ) : null}
              {canRenameThread ? (
                <NodexDropdownItem
                  leftSlot={<EditIcon className={menuIconClassName} />}
                  keyboardShortcut={model.shortcuts?.rename}
                  onSelect={() => actions.onRequestRenameThread?.()}
                >
                  Rename
                </NodexDropdownItem>
              ) : null}
              {canArchiveThread ? (
                <NodexDropdownItem
                  leftSlot={<ArchiveIcon className={menuIconClassName} />}
                  keyboardShortcut={model.shortcuts?.archive}
                  onSelect={() =>
                    void handleAction(actions.onArchiveThread, "Failed to archive task")
                  }
                >
                  Archive
                </NodexDropdownItem>
              ) : null}
              {hasTopActions ? <NodexDropdownSeparator /> : null}
              {model.showSideChatAction ? (
                <NodexDropdownItem
                  leftSlot={<SidePanelSideChatIcon className={menuIconClassName} />}
                  keyboardShortcut={model.shortcuts?.openSideTask}
                  onSelect={() =>
                    void handleAction(actions.onOpenSideChat, "Failed to open side task")
                  }
                >
                  Open side task
                </NodexDropdownItem>
              ) : null}
              <NodexDropdownFlyoutSubmenuItem
                label="Copy"
                leftSlot={<CopyIcon className={menuIconClassName} />}
                contentMotion="none"
              >
                <NodexDropdownItem
                  disabled={!model.cwd}
                  leftSlot={<CopyIcon className={menuIconClassName} />}
                  onSelect={() => void handleCopyText(model.cwd, "Working directory copied")}
                >
                  Copy working directory
                </NodexDropdownItem>
                {model.threadId ? (
                  <NodexDropdownItem
                    leftSlot={<CopyIcon className={menuIconClassName} />}
                    onSelect={() => void handleCopyText(model.threadId, "Session ID copied")}
                  >
                    Copy session ID
                  </NodexDropdownItem>
                ) : null}
                {model.sessionId ? (
                  <NodexDropdownItem
                    leftSlot={<CopyIcon className={menuIconClassName} />}
                    onSelect={() =>
                      void handleCopyText(
                        buildSessionDeepLink({ sessionId: model.sessionId as string }),
                        "Deeplink copied",
                      )
                    }
                  >
                    Copy deeplink
                  </NodexDropdownItem>
                ) : null}
                {model.threadId && actions.onCopyConversationMarkdown ? (
                  <NodexDropdownItem
                    leftSlot={<CopyIcon className={menuIconClassName} />}
                    keyboardShortcut={model.shortcuts?.copyConversationMarkdown}
                    onSelect={() => void actions.onCopyConversationMarkdown?.()}
                  >
                    Copy as Markdown
                  </NodexDropdownItem>
                ) : null}
              </NodexDropdownFlyoutSubmenuItem>
            </NodexDropdownMenu>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export const ThreadStageHeader = memo(
  ThreadStageHeaderComponent,
  (left, right) =>
    left.actions === right.actions &&
    left.onErrorMessage === right.onErrorMessage &&
    left.model.title === right.model.title &&
    left.model.projectId === right.model.projectId &&
    left.model.sessionId === right.model.sessionId &&
    left.model.threadId === right.model.threadId &&
    left.model.cwd === right.model.cwd &&
    left.model.pinned === right.model.pinned &&
    left.model.shortcuts === right.model.shortcuts &&
    left.model.showSideChatAction === right.model.showSideChatAction,
);
