import { memo, useCallback, useRef, useState } from "react";
import {
  ArchiveIcon,
  ChatActionsIcon,
  EditIcon,
  SessionPinFilledIcon,
  SessionPinIcon,
  SidePanelSideChatIcon,
  CopyIcon,
  SlashModelIcon,
  SlashStatusIcon,
  ProjectTaskIcon,
  ForkIcon,
} from "@/components/shared/icons";
import {
  NodexDropdownFlyoutSubmenuItem,
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { toast } from "@/components/ui/toast";
import { writeTextToClipboardStrict } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import {
  TOOLBAR_BUTTON_BASE_CLASS,
  TOOLBAR_BUTTON_GHOST_CLASS,
} from "@/lib/workbench-toolbar-control-styles";
import { buildSessionDeepLink } from "../../../../shared/nodex-deeplink";
import type {
  ConversationProviderPresentation,
  ThreadStageActions,
  ThreadStageHeaderModel,
} from "../thread-stage-types";
import { useOpenNativeRuntimeDiagnostics } from "@/components/shared/agent-runtime/native-runtime-diagnostics";
import { sessionForkDestinations } from "@/lib/session-fork";

interface ThreadStageHeaderProps {
  model: ThreadStageHeaderModel;
  actions: ThreadStageActions;
  onErrorMessage: (message: string | null) => void;
  provider?: ConversationProviderPresentation;
}

const menuIconClassName = "icon-xs shrink-0";

function ThreadStageHeaderComponent({
  model,
  actions,
  onErrorMessage,
  provider,
}: ThreadStageHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [generatingTitle, setGeneratingTitle] = useState(false);
  const [forking, setForking] = useState(false);
  const forkInFlight = useRef(false);
  const pendingModal = useRef<(() => void) | null>(null);
  const canRenameThread = Boolean(model.threadId && actions.onRequestRenameThread);
  const canArchiveThread = Boolean(model.threadId && actions.onArchiveThread);
  const canTogglePin = Boolean(model.threadId && actions.onToggleThreadPin);
  const canGenerateTitle = Boolean(model.threadId && provider?.generateTitle);
  const canForkThread = Boolean(model.threadId && actions.onForkThread);
  const hasNewWorkActions = canForkThread || model.showSideChatAction;
  const opensSubagents = provider?.controls?.subagents === true;
  const canOpenNativeTasks = Boolean(
    model.threadId &&
    (provider?.controls?.nativeTaskDetails || opensSubagents) &&
    actions.onOpenSubagentsPanel,
  );
  // Groups follow the shared chat-actions order: identity, new work, copy, runtime, Archive.
  const hasIdentityActions = canRenameThread || canGenerateTitle || canTogglePin;
  const hasRuntimeActions = canOpenNativeTasks || Boolean(provider?.diagnostics);
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

  const generateTitle = async () => {
    if (!provider?.generateTitle || generatingTitle) return;
    setGeneratingTitle(true);
    await handleAction(async () => {
      const title = await provider.generateTitle?.();
      if (!title) throw new Error("Could not generate a title");
    }, "Could not generate a title");
    setGeneratingTitle(false);
  };

  return (
    <div className="flex w-full min-w-0 items-center gap-2 electron:h-toolbar extension:py-row-y">
      <span
        data-testid="thread-stage-title"
        className="inline-flex min-w-[2ch] flex-1 items-center overflow-hidden font-sans text-base leading-6 text-token-foreground electron:font-medium"
      >
        <span className="min-w-0 truncate">{model.title}</span>
      </span>
      {showThreadActions ? (
        <NodexDropdownMenu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          finalFocus={() => {
            if (!pendingModal.current) return true;
            const showDiagnostics = pendingModal.current;
            pendingModal.current = null;
            showDiagnostics();
            return false;
          }}
          align="start"
          sideOffset={2}
          contentWidth="menu"
          motion="none"
          triggerTooltipContent="Chat actions"
          triggerButton={
            <button
              type="button"
              data-state={menuOpen ? "open" : "closed"}
              className={cn(TOOLBAR_BUTTON_BASE_CLASS, TOOLBAR_BUTTON_GHOST_CLASS, "shrink-0")}
              aria-label="Chat actions"
            >
              <ChatActionsIcon />
            </button>
          }
        >
          {canRenameThread ? (
            <NodexDropdownItem
              leftSlot={<EditIcon className={menuIconClassName} />}
              keyboardShortcut={model.shortcuts?.rename}
              onSelect={() => actions.onRequestRenameThread?.()}
            >
              Rename
            </NodexDropdownItem>
          ) : null}
          {canGenerateTitle ? (
            <NodexDropdownItem
              leftSlot={<SlashModelIcon className={menuIconClassName} />}
              disabled={generatingTitle}
              onSelect={() => void generateTitle()}
            >
              {generatingTitle ? "Generating title…" : "Generate title"}
            </NodexDropdownItem>
          ) : null}
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
          {hasIdentityActions && hasNewWorkActions ? <NodexDropdownSeparator /> : null}
          {model.showSideChatAction ? (
            <NodexDropdownItem
              leftSlot={<SidePanelSideChatIcon className={menuIconClassName} />}
              keyboardShortcut={model.shortcuts?.openSideTask}
              onSelect={() => void handleAction(actions.onOpenSideChat, "Failed to open side chat")}
            >
              New side chat
            </NodexDropdownItem>
          ) : null}
          {canForkThread ? (
            <NodexDropdownFlyoutSubmenuItem
              label="Fork"
              leftSlot={<ForkIcon className={menuIconClassName} />}
              contentMotion="none"
            >
              {(
                model.forkDestinations ??
                sessionForkDestinations({ isWorktree: false, canCreateWorktree: false })
              ).map((destination) => (
                <NodexDropdownItem
                  key={destination.target}
                  disabled={forking}
                  onSelect={() => {
                    if (forkInFlight.current) return;
                    forkInFlight.current = true;
                    setForking(true);
                    void handleAction(async () => {
                      try {
                        await actions.onForkThread?.(destination.target);
                      } finally {
                        forkInFlight.current = false;
                        setForking(false);
                      }
                    }, "Failed to fork chat");
                  }}
                >
                  {destination.label}
                </NodexDropdownItem>
              ))}
            </NodexDropdownFlyoutSubmenuItem>
          ) : null}
          {hasIdentityActions || hasNewWorkActions ? <NodexDropdownSeparator /> : null}
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
          {hasRuntimeActions ? <NodexDropdownSeparator /> : null}
          {canOpenNativeTasks ? (
            <NodexDropdownItem
              leftSlot={<ProjectTaskIcon className={menuIconClassName} />}
              onSelect={() => {
                pendingModal.current = () => {
                  void handleAction(
                    actions.onOpenSubagentsPanel,
                    opensSubagents ? "Could not open subagents" : "Could not open tasks",
                  );
                };
              }}
            >
              {opensSubagents ? "Subagents" : "Tasks"}
            </NodexDropdownItem>
          ) : null}
          {provider?.diagnostics ? (
            <NativeStatusMenuItem
              read={provider.diagnostics}
              onSelect={(show) => {
                pendingModal.current = show;
              }}
            />
          ) : null}
          {canArchiveThread ? (
            <>
              <NodexDropdownSeparator />
              <NodexDropdownItem
                leftSlot={<ArchiveIcon className={menuIconClassName} />}
                keyboardShortcut={model.shortcuts?.archive}
                onSelect={() =>
                  void handleAction(actions.onArchiveThread, "Failed to archive task")
                }
              >
                Archive
              </NodexDropdownItem>
            </>
          ) : null}
        </NodexDropdownMenu>
      ) : null}
    </div>
  );
}

function NativeStatusMenuItem({
  read,
  onSelect,
}: {
  readonly read: NonNullable<ConversationProviderPresentation["diagnostics"]>;
  readonly onSelect: (show: () => void) => void;
}) {
  const showDiagnostics = useOpenNativeRuntimeDiagnostics(read);
  return (
    <NodexDropdownItem
      leftSlot={<SlashStatusIcon className={menuIconClassName} />}
      onSelect={() => onSelect(showDiagnostics)}
    >
      Status
    </NodexDropdownItem>
  );
}

export const ThreadStageHeader = memo(
  ThreadStageHeaderComponent,
  (left, right) =>
    left.actions === right.actions &&
    left.provider === right.provider &&
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
