import { presentSessionTitle } from "@/lib/session-title-presentation";
import { FormattedMessage, getIntl, useIntl } from "@/lib/i18n";
import { QueuedRunStatus } from "./queued-run-label";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import { toastFailure } from "@/lib/failure-toast";
import { memo, useCallback, useRef, useState } from "react";
import {
  ArchiveIcon,
  ChatActionsIcon,
  ClearContextIcon,
  ClockIcon,
  EditIcon,
  SessionPinFilledIcon,
  SessionPinIcon,
  SidePanelSideChatIcon,
  CopyIcon,
  SlashStatusIcon,
  ChatIcon,
  ForkIcon,
  MoveToLeftPaneIcon,
  MoveToRightPaneIcon,
} from "@/components/shared/icons";
import { NativeMenuIcon } from "@/components/shared/icons/native-menu-icon";
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
  CONVERSATION_HEADER_CONTROL_CLASS,
  TOOLBAR_BUTTON_BASE_CLASS,
  TOOLBAR_BUTTON_GHOST_CLASS,
} from "@/lib/workbench-toolbar-control-styles";
import { buildSessionDeepLink } from "@/lib/page-deeplink";
import type {
  ConversationProviderPresentation,
  ThreadStageActions,
  ThreadStageHeaderModel,
} from "../thread-stage-types";
import { useOpenNativeRuntimeDiagnostics } from "@/components/shared/agent-runtime/native-runtime-diagnostics";
import { sessionForkDestinations } from "@/lib/session-fork";
import { describeChatSnooze } from "@/lib/chat-snooze";
import {
  preloadCustomSnoozeForm,
  SnoozeMenuItems,
  useCustomSnoozeHandoff,
} from "@/components/shared/snooze-menu";
import { SubagentAvatar } from "./shared/subagent-avatar";
import { useThreadStageHeaderSlot } from "./thread-stage-header-slot";

interface ThreadStageHeaderProps {
  model: ThreadStageHeaderModel;
  actions: ThreadStageActions;
  provider?: ConversationProviderPresentation;
}

const menuIconClassName = "icon-xs shrink-0";
/** A full-view Chat tab keeps its actions visible, sized like the tab's close button. */
const CHAT_TAB_ACTIONS_TRIGGER_CLASS =
  "no-drag flex size-5 shrink-0 cursor-interaction items-center justify-center rounded-md p-0.5 text-tertiary hover:bg-(--color-background-primary-ghost-hover) hover:text-(--color-text) focus-visible:bg-(--color-background-primary-ghost-hover) data-[state=open]:bg-(--color-background-primary-ghost-hover) data-[state=open]:text-(--color-text)";

function ThreadStageHeaderComponent({ model, actions, provider }: ThreadStageHeaderProps) {
  const intl = useIntl();
  const { variant, paneMove } = useThreadStageHeaderSlot();
  const [menuOpen, setMenuOpen] = useState(false);
  // Reminder presets are relative to when the menu opens.
  const [menuOpenedAt, setMenuOpenedAt] = useState(() => new Date());
  const handleMenuOpenChange = useCallback((open: boolean) => {
    if (open) {
      setMenuOpenedAt(new Date());
      void preloadCustomSnoozeForm();
    }
    setMenuOpen(open);
  }, []);
  const [forking, setForking] = useState(false);
  const forkInFlight = useRef(false);
  const pendingModal = useRef<(() => void) | null>(null);
  const canRenameThread = Boolean(model.threadId && actions.onRequestRenameThread);
  const canArchiveThread = Boolean(model.threadId && actions.onArchiveThread);
  const canTogglePin = Boolean(model.threadId && actions.onToggleThreadPin);
  const canSetSnooze = Boolean(model.threadId && actions.onSetThreadSnooze);
  const canForkThread = Boolean(model.threadId && actions.onForkThread);
  const canClearContext = Boolean(model.threadId && actions.onClearContext);
  const hasNewWorkActions = canForkThread || canClearContext || model.showSideChatAction;
  const opensSubagents = provider?.controls?.subagents === true;
  const canOpenNativeTasks = Boolean(
    model.threadId &&
    (provider?.controls?.nativeTaskDetails || opensSubagents) &&
    actions.onOpenSubagentsPanel,
  );
  // Groups follow the shared chat-actions order: identity, new work, copy, window, runtime, Archive.
  const hasIdentityActions = canRenameThread || canTogglePin || canSetSnooze;
  const hasRuntimeActions = canOpenNativeTasks || Boolean(provider?.diagnostics);
  const showThreadActions = Boolean(
    model.threadId || model.cwd || model.showSideChatAction || actions.onCopyConversationMarkdown,
  );

  const handleAction = useCallback(
    async (action: (() => void | Promise<void>) | undefined, failureTitle: string) => {
      if (!action) return;
      try {
        await action();
      } catch (error) {
        toastFailure(failureTitle, error);
      }
    },
    [],
  );
  const snoozeChat = (snoozedUntil: string) =>
    void handleAction(
      () => actions.onSetThreadSnooze?.(snoozedUntil),
      getIntl().formatMessage({
        id: "conversation.stageHeader.snoozeFailed",
        defaultMessage: "Couldn’t snooze the chat",
      }),
    );
  const customSnooze = useCustomSnoozeHandoff(snoozeChat);

  const handleCopyText = useCallback(async (value: string | null, successMessage: string) => {
    if (!value) return;
    try {
      await writeTextToClipboardStrict(value);
      toast.success(successMessage);
    } catch {
      toast.danger(
        getIntl().formatMessage({
          id: "conversation.stageHeader.copyFailed",
          defaultMessage: "Failed to copy to clipboard",
        }),
      );
    }
  }, []);

  const actionsMenu = showThreadActions ? (
    <NodexDropdownMenu
      open={menuOpen}
      onOpenChange={handleMenuOpenChange}
      finalFocus={() => {
        if (customSnooze.handOff()) return true;
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
      triggerTooltipContent={intl.formatMessage({
        id: "conversation.stageHeader.actions",
        defaultMessage: "Chat actions",
      })}
      triggerButton={
        <button
          type="button"
          data-state={menuOpen ? "open" : "closed"}
          className={
            variant === "chat-tab"
              ? CHAT_TAB_ACTIONS_TRIGGER_CLASS
              : cn(
                  TOOLBAR_BUTTON_BASE_CLASS,
                  TOOLBAR_BUTTON_GHOST_CLASS,
                  CONVERSATION_HEADER_CONTROL_CLASS,
                  "shrink-0",
                )
          }
          aria-label={intl.formatMessage({
            id: "conversation.stageHeader.actions",
            defaultMessage: "Chat actions",
          })}
        >
          <ChatActionsIcon className={variant === "chat-tab" ? "icon-2xs" : undefined} />
        </button>
      }
    >
      {canRenameThread ? (
        <NodexDropdownItem
          leftSlot={<EditIcon className={menuIconClassName} />}
          keyboardShortcut={model.shortcuts?.rename}
          onSelect={() => actions.onRequestRenameThread?.()}
        >
          <FormattedMessage id="conversation.stageHeader.rename" defaultMessage="Rename" />
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
            void handleAction(
              actions.onToggleThreadPin,
              model.pinned
                ? getIntl().formatMessage({
                    id: "conversation.stageHeader.unpinFailed",
                    defaultMessage: "Couldn’t unpin the chat",
                  })
                : getIntl().formatMessage({
                    id: "conversation.stageHeader.pinFailed",
                    defaultMessage: "Couldn’t pin the chat",
                  }),
            )
          }
        >
          {model.pinned
            ? intl.formatMessage({ id: "conversation.stageHeader.unpin", defaultMessage: "Unpin" })
            : intl.formatMessage({ id: "conversation.stageHeader.pin", defaultMessage: "Pin" })}
        </NodexDropdownItem>
      ) : null}
      {canSetSnooze ? (
        <NodexDropdownFlyoutSubmenuItem
          label={intl.formatMessage({
            id: "conversation.stageHeader.snooze",
            defaultMessage: "Snooze",
          })}
          leftSlot={<ClockIcon className={menuIconClassName} />}
          contentMotion="none"
        >
          {/* Like every Snooze menu: when it returns and Wake first, then the choices. */}
          {model.snoozedUntil ? (
            <>
              <NodexDropdownItem disabled>
                {describeChatSnooze(model.snoozedUntil, menuOpenedAt, intl.locale)}
              </NodexDropdownItem>
              <NodexDropdownItem
                onSelect={() =>
                  void handleAction(
                    () => actions.onSetThreadSnooze?.(null),
                    getIntl().formatMessage({
                      id: "conversation.stageHeader.wakeFailed",
                      defaultMessage: "Couldn’t wake the chat",
                    }),
                  )
                }
              >
                <FormattedMessage id="conversation.stageHeader.wake" defaultMessage="Wake" />
              </NodexDropdownItem>
              <NodexDropdownSeparator />
            </>
          ) : null}
          <SnoozeMenuItems
            now={menuOpenedAt}
            onChoose={snoozeChat}
            onCustom={customSnooze.request}
          />
        </NodexDropdownFlyoutSubmenuItem>
      ) : null}
      {hasIdentityActions && hasNewWorkActions ? <NodexDropdownSeparator /> : null}
      {model.showSideChatAction ? (
        <NodexDropdownItem
          leftSlot={<SidePanelSideChatIcon className={menuIconClassName} />}
          keyboardShortcut={model.shortcuts?.openSideTask}
          onSelect={() =>
            void handleAction(
              actions.onOpenSideChat,
              getIntl().formatMessage({
                id: "conversation.stageHeader.sideChatFailed",
                defaultMessage: "Couldn’t open a side chat",
              }),
            )
          }
        >
          <FormattedMessage
            id="conversation.stageHeader.newSideChat"
            defaultMessage="New side chat"
          />
        </NodexDropdownItem>
      ) : null}
      {canForkThread ? (
        <NodexDropdownFlyoutSubmenuItem
          label={intl.formatMessage({
            id: "conversation.stageHeader.fork",
            defaultMessage: "Fork",
          })}
          leftSlot={<ForkIcon className={menuIconClassName} />}
          contentMotion="none"
        >
          {(
            model.forkDestinations ??
            sessionForkDestinations({ isWorktree: false, canCreateWorktree: false })
          ).map((destination) => (
            <NodexDropdownItem
              key={destination.target}
              leftSlot={
                <NativeMenuIcon iconKey={destination.iconKey} className={menuIconClassName} />
              }
              disabled={forking}
              onSelect={() => {
                if (forkInFlight.current) return;
                forkInFlight.current = true;
                setForking(true);
                void handleAction(
                  async () => {
                    await runWithCleanup(
                      async () => {
                        await actions.onForkThread?.(destination.target);
                      },
                      {
                        cleanup: () => {
                          forkInFlight.current = false;
                          setForking(false);
                        },
                      },
                    );
                  },
                  getIntl().formatMessage({
                    id: "conversation.stageHeader.forkFailed",
                    defaultMessage: "Couldn’t fork the conversation",
                  }),
                );
              }}
            >
              {destination.label}
            </NodexDropdownItem>
          ))}
        </NodexDropdownFlyoutSubmenuItem>
      ) : null}
      {canClearContext ? (
        <NodexDropdownItem
          leftSlot={<ClearContextIcon className={menuIconClassName} />}
          onSelect={() =>
            void handleAction(
              actions.onClearContext,
              getIntl().formatMessage({
                id: "conversation.stageHeader.clearContextFailed",
                defaultMessage: "Couldn’t clear the context",
              }),
            )
          }
        >
          <FormattedMessage
            id="conversation.stageHeader.clearContext"
            defaultMessage="Clear context"
          />
        </NodexDropdownItem>
      ) : null}
      {hasIdentityActions || hasNewWorkActions ? <NodexDropdownSeparator /> : null}
      <NodexDropdownFlyoutSubmenuItem
        label={intl.formatMessage({ id: "conversation.stageHeader.copy", defaultMessage: "Copy" })}
        leftSlot={<CopyIcon className={menuIconClassName} />}
        contentMotion="none"
      >
        <NodexDropdownItem
          disabled={!model.cwd}
          leftSlot={<CopyIcon className={menuIconClassName} />}
          onSelect={() =>
            void handleCopyText(
              model.cwd,
              getIntl().formatMessage({
                id: "conversation.stageHeader.workingDirectoryCopied",
                defaultMessage: "Working directory copied",
              }),
            )
          }
        >
          <FormattedMessage
            id="conversation.stageHeader.copyWorkingDirectory"
            defaultMessage="Copy working directory"
          />
        </NodexDropdownItem>
        {model.threadId ? (
          <NodexDropdownItem
            leftSlot={<CopyIcon className={menuIconClassName} />}
            onSelect={() =>
              void handleCopyText(
                model.threadId,
                getIntl().formatMessage({
                  id: "conversation.stageHeader.sessionIdCopied",
                  defaultMessage: "Session ID copied",
                }),
              )
            }
          >
            <FormattedMessage
              id="conversation.stageHeader.copySessionId"
              defaultMessage="Copy session ID"
            />
          </NodexDropdownItem>
        ) : null}
        {model.sessionId ? (
          <NodexDropdownItem
            leftSlot={<CopyIcon className={menuIconClassName} />}
            onSelect={() =>
              void handleCopyText(
                buildSessionDeepLink({ sessionId: model.sessionId as string }),
                getIntl().formatMessage({
                  id: "conversation.stageHeader.deeplinkCopied",
                  defaultMessage: "Deeplink copied",
                }),
              )
            }
          >
            <FormattedMessage
              id="conversation.stageHeader.copyDeeplink"
              defaultMessage="Copy deeplink"
            />
          </NodexDropdownItem>
        ) : null}
        {model.threadId && actions.onCopyConversationMarkdown ? (
          <NodexDropdownItem
            leftSlot={<CopyIcon className={menuIconClassName} />}
            keyboardShortcut={model.shortcuts?.copyConversationMarkdown}
            onSelect={() => void actions.onCopyConversationMarkdown?.()}
          >
            <FormattedMessage
              id="conversation.stageHeader.copyMarkdown"
              defaultMessage="Copy as Markdown"
            />
          </NodexDropdownItem>
        ) : null}
      </NodexDropdownFlyoutSubmenuItem>
      {paneMove ? (
        <>
          <NodexDropdownSeparator />
          <NodexDropdownItem
            leftSlot={
              paneMove.side === "left" ? (
                <MoveToLeftPaneIcon className={menuIconClassName} />
              ) : (
                <MoveToRightPaneIcon className={menuIconClassName} />
              )
            }
            onSelect={paneMove.onSelect}
          >
            {paneMove.side === "left"
              ? intl.formatMessage({
                  id: "conversation.stageHeader.moveLeft",
                  defaultMessage: "Move to left pane",
                })
              : intl.formatMessage({
                  id: "conversation.stageHeader.moveRight",
                  defaultMessage: "Move to right pane",
                })}
          </NodexDropdownItem>
        </>
      ) : null}
      {hasRuntimeActions ? <NodexDropdownSeparator /> : null}
      {canOpenNativeTasks ? (
        <NodexDropdownItem
          leftSlot={<ChatIcon className={menuIconClassName} />}
          onSelect={() => {
            pendingModal.current = () => {
              void handleAction(
                actions.onOpenSubagentsPanel,
                opensSubagents
                  ? getIntl().formatMessage({
                      id: "conversation.stageHeader.subagentsFailed",
                      defaultMessage: "Couldn’t open subagents",
                    })
                  : getIntl().formatMessage({
                      id: "conversation.stageHeader.tasksFailed",
                      defaultMessage: "Couldn’t open tasks",
                    }),
              );
            };
          }}
        >
          {opensSubagents
            ? intl.formatMessage({
                id: "conversation.stageHeader.subagents",
                defaultMessage: "Subagents",
              })
            : intl.formatMessage({ id: "conversation.stageHeader.tasks", defaultMessage: "Tasks" })}
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
              void handleAction(
                actions.onArchiveThread,
                getIntl().formatMessage({
                  id: "conversation.stageHeader.archiveFailed",
                  defaultMessage: "Couldn’t archive the chat",
                }),
              )
            }
          >
            <FormattedMessage id="conversation.stageHeader.archive" defaultMessage="Archive" />
          </NodexDropdownItem>
        </>
      ) : null}
    </NodexDropdownMenu>
  ) : null;

  const queueLabel = provider?.admissionQueue ? (
    <QueuedRunStatus queue={provider.admissionQueue} />
  ) : null;
  if (variant === "chat-tab")
    return (
      <>
        {queueLabel}
        {actionsMenu}
      </>
    );

  return (
    <div className="flex w-full min-w-0 items-center gap-2 electron:h-toolbar extension:py-row-y">
      <span
        data-testid="thread-stage-title"
        className="inline-flex min-w-[2ch] flex-1 items-center overflow-hidden px-1.75 font-sans text-sm leading-5 text-token-foreground electron:font-[510]"
      >
        <span className="min-w-0 truncate">{presentSessionTitle(model.title, intl)}</span>
        {model.threadId && model.subagentName ? (
          <span className="ms-1 inline-flex min-w-0 max-w-1/2 shrink-0 items-center gap-1 font-medium">
            <SubagentAvatar seed={model.threadId} className="icon-2xs" />
            <span className="truncate">{model.subagentName}</span>
          </span>
        ) : null}
      </span>
      {queueLabel}
      {actionsMenu}
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
      <FormattedMessage id="conversation.stageHeader.status" defaultMessage="Status" />
    </NodexDropdownItem>
  );
}

export const ThreadStageHeader = memo(
  ThreadStageHeaderComponent,
  (left, right) =>
    left.actions === right.actions &&
    left.provider === right.provider &&
    left.model.title === right.model.title &&
    left.model.projectId === right.model.projectId &&
    left.model.sessionId === right.model.sessionId &&
    left.model.threadId === right.model.threadId &&
    left.model.subagentName === right.model.subagentName &&
    left.model.cwd === right.model.cwd &&
    left.model.pinned === right.model.pinned &&
    left.model.shortcuts === right.model.shortcuts &&
    left.model.showSideChatAction === right.model.showSideChatAction,
);
