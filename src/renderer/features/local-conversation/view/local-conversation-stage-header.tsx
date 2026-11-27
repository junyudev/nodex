import { presentSessionTitle } from "@/lib/session-title-presentation";
import { FormattedMessage, getIntl, useIntl } from "@/lib/i18n";
import { QueuedRunStatus } from "./queued-run-label";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import { toastFailure } from "@/lib/failure-toast";
import { Fragment, memo, useCallback, useRef, useState, type ReactNode } from "react";
import {
  ChatActionsIcon,
  SlashStatusIcon,
  ChatIcon,
  MoveToLeftPaneIcon,
  MoveToRightPaneIcon,
  SidePanelSideChatIcon,
} from "@/components/shared/icons";
import { NativeMenuIcon } from "@/components/shared/icons/native-menu-icon";
import {
  NodexDropdownFlyoutSubmenuItem,
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSeparator,
  NodexDropdownSummarySubmenuItem,
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
import {
  buildChatActionGroups,
  SESSION_CONTEXT_MENU_ACTION_IDS as actionIds,
} from "@/components/workbench/session-context-menu-model";
import type { NativeContextMenuItem } from "../../../../shared/native-context-menu";
import { useNodexReferenceRouter } from "@/lib/nodex-reference-router";
import { canShowNativeContextMenu } from "@/lib/native-context-menu";
import { useResolvedCommandKeymapState } from "@/lib/use-command-keymap-state";
import { formatCommandShortcutLabel } from "../../../../shared/command-keybindings";
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
  const router = useNodexReferenceRouter();
  const keymap = useResolvedCommandKeymapState();
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
  const opensSubagents = provider?.controls?.subagents === true;
  const canOpenNativeTasks = Boolean(
    model.threadId &&
    (provider?.controls?.nativeTaskDetails || opensSubagents) &&
    actions.onOpenSubagentsPanel,
  );
  const hasRuntimeActions = canOpenNativeTasks || Boolean(provider?.diagnostics);

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

  const [identity, newWork, organization, copy, windows, archive] = buildChatActionGroups({
    canRename: canRenameThread,
    pinned: canTogglePin ? model.pinned === true : undefined,
    canSnooze: canSetSnooze,
    snoozedUntil: model.snoozedUntil,
    now: menuOpenedAt,
    forkDestinations: canForkThread
      ? (model.forkDestinations ??
        sessionForkDestinations({ isWorktree: false, canCreateWorktree: false }))
      : [],
    newSideChat:
      model.showSideChatAction && actions.onOpenSideChat
        ? {
            id: "new-side-chat",
            commandId: "openSideChat",
            label: intl.formatMessage({
              id: "conversation.stageHeader.newSideChat",
              defaultMessage: "New side chat",
            }),
          }
        : undefined,
    clearContext: canClearContext
      ? {
          id: "clear-context",
          label: intl.formatMessage({
            id: "conversation.stageHeader.clearContext",
            defaultMessage: "Clear context",
          }),
          iconKey: "trash",
        }
      : undefined,
    canCopyWorkingDirectory: Boolean(model.cwd),
    canCopySessionId: Boolean(model.threadId),
    canCopyLink: Boolean(model.sessionId),
    canCopyMarkdown: Boolean(model.threadId && actions.onCopyConversationMarkdown),
    canOpenInNewWindow: Boolean(router && model.sessionId && canShowNativeContextMenu()),
    canArchive: canArchiveThread,
  });

  const forkThread = (target: "local" | "newWorktree") => {
    if (forkInFlight.current) return;
    forkInFlight.current = true;
    setForking(true);
    void handleAction(
      () =>
        runWithCleanup(
          async () => {
            await actions.onForkThread?.(target);
          },
          {
            cleanup: () => {
              forkInFlight.current = false;
              setForking(false);
            },
          },
        ),
      intl.formatMessage({
        id: "conversation.stageHeader.forkFailed",
        defaultMessage: "Couldn’t fork the conversation",
      }),
    );
  };
  const handlers: Record<string, () => void> = {
    [actionIds.rename]: () => actions.onRequestRenameThread?.(),
    [actionIds.togglePin]: () =>
      void handleAction(
        actions.onToggleThreadPin,
        model.pinned
          ? intl.formatMessage({
              id: "conversation.stageHeader.unpinFailed",
              defaultMessage: "Couldn’t unpin the chat",
            })
          : intl.formatMessage({
              id: "conversation.stageHeader.pinFailed",
              defaultMessage: "Couldn’t pin the chat",
            }),
      ),
    [actionIds.wake]: () =>
      void handleAction(
        () => actions.onSetThreadSnooze?.(null),
        intl.formatMessage({
          id: "conversation.stageHeader.wakeFailed",
          defaultMessage: "Couldn’t wake the chat",
        }),
      ),
    [actionIds.fork]: () => forkThread("local"),
    [actionIds.forkInNewWorktree]: () => forkThread("newWorktree"),
    [actionIds.copyWorkingDirectory]: () =>
      void handleCopyText(
        model.cwd,
        intl.formatMessage({
          id: "conversation.stageHeader.workingDirectoryCopied",
          defaultMessage: "Working directory copied",
        }),
      ),
    [actionIds.copySessionId]: () =>
      void handleCopyText(
        model.threadId,
        intl.formatMessage({
          id: "conversation.stageHeader.sessionIdCopied",
          defaultMessage: "Session ID copied",
        }),
      ),
    [actionIds.copyDeeplink]: () =>
      void handleCopyText(
        model.sessionId ? buildSessionDeepLink({ sessionId: model.sessionId }) : null,
        intl.formatMessage({
          id: "conversation.stageHeader.deeplinkCopied",
          defaultMessage: "Link copied",
        }),
      ),
    [actionIds.copyConversationMarkdown]: () => void actions.onCopyConversationMarkdown?.(),
    [actionIds.openInNewWindow]: () =>
      void handleAction(
        async () => {
          if (!router || !model.sessionId) return;
          const outcome = await router.open(
            { kind: "session", sessionId: model.sessionId },
            {
              source: { surface: "conversation", sessionId: model.sessionId },
              gesture: { kind: "menu", action: "new-window" },
            },
          );
          if (outcome === "failed")
            throw new Error(
              intl.formatMessage({
                id: "conversation.stageHeader.openInNewWindowFailed",
                defaultMessage: "Could not open chat in a new window",
              }),
            );
        },
        intl.formatMessage({
          id: "conversation.stageHeader.openInNewWindowFailed",
          defaultMessage: "Could not open chat in a new window",
        }),
      ),
    [actionIds.archive]: () =>
      void handleAction(
        actions.onArchiveThread,
        intl.formatMessage({
          id: "conversation.stageHeader.archiveFailed",
          defaultMessage: "Couldn’t archive the chat",
        }),
      ),
    "new-side-chat": () =>
      void handleAction(
        actions.onOpenSideChat,
        intl.formatMessage({
          id: "conversation.stageHeader.sideChatFailed",
          defaultMessage: "Couldn’t open a side chat",
        }),
      ),
    "clear-context": () =>
      void handleAction(
        actions.onClearContext,
        intl.formatMessage({
          id: "conversation.stageHeader.clearContextFailed",
          defaultMessage: "Couldn’t clear the context",
        }),
      ),
  };
  const renderItem = (item: NativeContextMenuItem, index: number): ReactNode => {
    if (item.type === "separator") return <NodexDropdownSeparator key={item.id ?? index} />;
    const leftSlot =
      item.id === "new-side-chat" ? (
        <SidePanelSideChatIcon className={menuIconClassName} />
      ) : item.iconKey ? (
        <NativeMenuIcon iconKey={item.iconKey} />
      ) : undefined;
    const shortcut = item.commandId
      ? formatCommandShortcutLabel(keymap, item.commandId)
      : undefined;
    if (item.type === "submenu") {
      if (item.id === "session.snooze") {
        return (
          <NodexDropdownSummarySubmenuItem
            key={item.id}
            ariaLabel={item.label}
            label={item.label}
            leftSlot={leftSlot}
            value={shortcut}
          >
            {model.snoozedUntil ? item.submenu.slice(0, 3).map(renderItem) : null}
            <SnoozeMenuItems
              now={menuOpenedAt}
              onChoose={snoozeChat}
              onCustom={customSnooze.request}
            />
          </NodexDropdownSummarySubmenuItem>
        );
      }
      return (
        <NodexDropdownFlyoutSubmenuItem
          key={item.id}
          label={item.label}
          leftSlot={leftSlot}
          contentMotion="none"
        >
          {item.submenu.map(renderItem)}
        </NodexDropdownFlyoutSubmenuItem>
      );
    }
    return (
      <NodexDropdownItem
        key={item.id}
        disabled={
          item.enabled === false ||
          (forking && (item.id === actionIds.fork || item.id === actionIds.forkInNewWorktree))
        }
        leftSlot={leftSlot}
        keyboardShortcut={shortcut}
        tone={item.id === "clear-context" ? "danger" : undefined}
        onSelect={handlers[item.id]}
      >
        {item.label}
      </NodexDropdownItem>
    );
  };
  const actionGroups = [identity, newWork, organization, copy, windows].filter(
    (group) => group.length,
  );
  const showThreadActions =
    actionGroups.length > 0 || archive.length > 0 || hasRuntimeActions || Boolean(paneMove);

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
      {actionGroups.map((group, index) => (
        <Fragment key={group[0]?.id}>
          {index > 0 ? <NodexDropdownSeparator /> : null}
          {group.map(renderItem)}
        </Fragment>
      ))}
      {paneMove ? (
        <>
          {actionGroups.length > 0 ? <NodexDropdownSeparator /> : null}
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
      {hasRuntimeActions && (actionGroups.length > 0 || paneMove) ? (
        <NodexDropdownSeparator />
      ) : null}
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
      {archive.length > 0 ? (
        <>
          {actionGroups.length > 0 || paneMove || hasRuntimeActions ? (
            <NodexDropdownSeparator />
          ) : null}
          {archive.map(renderItem)}
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
    left.model.snoozedUntil === right.model.snoozedUntil &&
    left.model.forkDestinations === right.model.forkDestinations &&
    left.model.showSideChatAction === right.model.showSideChatAction,
);
