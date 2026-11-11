import { useCallback, useMemo, useState } from "react";
import type { MotionValue } from "motion/react";
import { useResolvedReducedMotion } from "./use-reduced-motion";
import { useConversationSubset } from "@/features/local-conversation";
import {
  buildThreadSummaryPanelBrowserRows,
  type ThreadSummaryPanelWorkbenchBrowserSource,
} from "@/features/local-conversation/projection/thread-summary-panel-browser-row-model";
import {
  buildThreadSummaryPanelSessionSideChatRows,
  buildThreadSummaryPanelSideChatRow,
} from "@/features/local-conversation/projection/thread-summary-panel-side-chat-row-model";
import { buildThreadSummaryPanelAutomationRow } from "@/features/local-conversation/projection/thread-summary-panel-automation-model";
import { runtimeSideChatSessionIdFromTabId } from "../../shared/side-chat-tab";
import { useAgentRuntimeActivities } from "./agent-runtime-session-activity";
import { useSessionSideChats } from "./use-session-side-chats";
import { useRemoteHostedPipSummaryControl } from "@/features/local-conversation/view/use-remote-hosted-pip-summary-control";
import type { ThreadStageActions } from "@/features/local-conversation";
import type {
  ThreadSummaryPanelAuxiliaryRow,
  ThreadSummaryPanelBrowserRow,
  ThreadSummaryPanelAutomationOpenInput,
  ThreadSummaryPanelAutomationRow,
} from "@/features/local-conversation/thread-stage-types";
import {
  readBrowserConfigFavicon,
  readBrowserConfigTitle,
  readBrowserConfigUrl,
} from "@/features/browser-sidebar/browser-sidebar-tab-config";
import {
  makeBrowserSidebarConversationScopeKey,
  requireWorkbenchBrowserTabProjectionId,
} from "../../shared/browser-sidebar";
import { useBrowserSidebarRendererState } from "@/features/browser-sidebar/browser-sidebar-renderer-state-store";
import type { Automation, PanelId, WorkbenchTabProjection } from "./types";
import type { SideChatPanelTab } from "./workbench-panel-tab-model";
import { resolveLeafIdForPanelTab } from "./workbench-panel-placement";
import { resolveWorkbenchPanelSlotLeafId } from "./workbench-panel-slot-key";
import {
  useCodexAnimatedContentShift,
  type ThreadSummaryPanelLayoutMode,
} from "./codex-panel-motion";
import type { WorkbenchSessionRenderProjection } from "./workbench-session-presentation";
import type { WorkbenchEphemeralPanelState } from "./workbench-ephemeral-panel-state";
import { buildAutomationsPath } from "@/lib/workbench-automations-routes";
import { buildProcessOutputTargetFromSummaryRow } from "./workbench-process-output-target";
import { sessionExecutionThreadId } from "./session-execution";

export interface WorkbenchThreadSummaryCommands {
  readonly selectPanelTab: (panelId: PanelId, tabId: string, leafId?: string) => Promise<void>;
  readonly setPanelCollapsed: (panelId: PanelId, collapsed: boolean) => Promise<unknown>;
  readonly openAutomationSidePanel: (input: ThreadSummaryPanelAutomationOpenInput) => Promise<void>;
  readonly openAutomations: (path: string) => void;
  readonly openProcessOutput: (
    target: ReturnType<typeof buildProcessOutputTargetFromSummaryRow>,
  ) => Promise<boolean>;
  readonly openProcessManager: () => void;
  readonly presentBrowserTab: (browserTabId: string) => Promise<void>;
  /** Reveals a side chat's tab in the active Session, reopening it when it is closed. */
  readonly openSessionSideChat: (sideChatSessionId: string) => Promise<void>;
}

interface WorkbenchThreadSummaryInput {
  readonly activeSession: WorkbenchSessionRenderProjection | null;
  readonly windowSessionId: string;
  readonly layoutMode: ThreadSummaryPanelLayoutMode;
  readonly mainContentWidth: MotionValue<number>;
  readonly rightPanelFullWidth: boolean;
  readonly pinnedOpen: boolean;
  readonly sideChatTabs: readonly SideChatPanelTab[];
  readonly previewTabsByPanel: WorkbenchEphemeralPanelState["previewTabsByPanel"];
  readonly clockAutomations: readonly Automation[];
  readonly commands: WorkbenchThreadSummaryCommands;
}

export interface WorkbenchThreadSummaryModel {
  readonly mounted: boolean;
  readonly open: boolean;
  readonly hideImmediately: boolean;
  readonly contentShift: MotionValue<number>;
  readonly mode: "hidden" | "popover" | "pinned";
  readonly popoverOpen: boolean;
  readonly setPopoverOpen: (open: boolean) => void;
  readonly sideChatRows: ThreadSummaryPanelAuxiliaryRow[];
  /** Reads older side chats once every listed one is shown. */
  readonly onLoadMoreSideChats: (() => void) | null;
  readonly browserRows: ThreadSummaryPanelBrowserRow[];
  readonly clockAutomation: ThreadSummaryPanelAutomationRow | null;
  readonly summaryComputerUsePip: ReturnType<
    typeof useRemoteHostedPipSummaryControl
  >["summaryComputerUsePip"];
  readonly onToggleSummaryComputerUsePip: ReturnType<
    typeof useRemoteHostedPipSummaryControl
  >["onToggleSummaryComputerUsePip"];
  readonly onOpenSideChatRow: NonNullable<ThreadStageActions["onOpenSummarySideChatRow"]>;
  readonly onOpenBrowserRow: NonNullable<ThreadStageActions["onOpenSummaryBrowserRow"]>;
  readonly onOpenAutomation: NonNullable<ThreadStageActions["onOpenSummaryAutomation"]>;
  readonly onOpenProcessManager: NonNullable<ThreadStageActions["onOpenProcessManager"]>;
  readonly onOpenBackgroundTerminalOutput: NonNullable<
    ThreadStageActions["onOpenBackgroundTerminalOutput"]
  >;
  readonly headerActions: Pick<ThreadStageActions, "onOpenSummaryAutomation">;
}

/**
 * Owns the renderer-lifetime Thread Summary projection and its external
 * Browser-use subscription. It does not own Session, panel, automation, or
 * process state; row intents cross those Seams through commands.
 */
export function useWorkbenchThreadSummary({
  activeSession,
  windowSessionId,
  layoutMode,
  mainContentWidth,
  rightPanelFullWidth,
  pinnedOpen,
  sideChatTabs,
  previewTabsByPanel,
  clockAutomations,
  commands,
}: WorkbenchThreadSummaryInput): WorkbenchThreadSummaryModel {
  const conversationThreadId = sessionExecutionThreadId(activeSession);
  const available = conversationThreadId !== null;
  const reducedMotion = useResolvedReducedMotion();
  const contentShift = useCodexAnimatedContentShift({
    mainContentWidth,
    pinnedOpen: available && pinnedOpen,
    reducedMotion,
    resetKey: conversationThreadId,
    fullWidth: rightPanelFullWidth,
  });
  // The pinned summary lives in the chat pane; content filling the Scene hides that pane, and the
  // summary then opens over the content from its control.
  const mounted = available && !rightPanelFullWidth;
  const open = mounted && layoutMode !== "overlay" && pinnedOpen;
  const mode = !available
    ? "hidden"
    : rightPanelFullWidth || layoutMode === "overlay"
      ? "popover"
      : "pinned";
  const [popoverOpen, setPopoverOpen] = useState(false);

  if (mode !== "popover" && popoverOpen) setPopoverOpen(false);

  const browserRuntime = useBrowserSidebarRendererState();

  const sideChatThreadIds = useMemo(
    () => sideChatTabs.flatMap((tab) => (tab.threadId ? [tab.threadId] : [])),
    [sideChatTabs],
  );
  const sideChatConversationsById = useConversationSubset(sideChatThreadIds);
  const runtimeActivities = useAgentRuntimeActivities();
  const {
    sideChats: listedSideChats,
    hasMore: moreSideChats,
    loadMore: loadMoreSideChats,
  } = useSessionSideChats(conversationThreadId ? activeSession!.id : null);
  const sideChatRows = useMemo<ThreadSummaryPanelAuxiliaryRow[]>(
    () => [
      ...buildThreadSummaryPanelSessionSideChatRows({
        open: (activeSession?.tabs ?? []).flatMap((tab) =>
          tab.kind === "side_chat"
            ? [
                {
                  sessionId: tab.config.sessionId,
                  title: tab.title,
                  panelId: tab.panelId,
                  leafId: resolveLeafIdForPanelTab(activeSession!, tab.panelId, tab.id),
                },
              ]
            : [],
        ),
        listed: listedSideChats,
        listComplete: !moreSideChats,
        isResponding: (sessionId) => runtimeActivities.has(sessionId),
      }),
      ...sideChatTabs.map((tab) =>
        buildThreadSummaryPanelSideChatRow(
          tab,
          tab.threadId ? sideChatConversationsById[tab.threadId] : null,
        ),
      ),
    ],
    [
      activeSession,
      listedSideChats,
      moreSideChats,
      runtimeActivities,
      sideChatConversationsById,
      sideChatTabs,
    ],
  );
  const browserRows = useMemo<ThreadSummaryPanelBrowserRow[]>(() => {
    if (!activeSession) return [];
    const activeBrowserUseTabId =
      browserRuntime.browserUseState.activeBrowserTabIdsByConversationScope[
        makeBrowserSidebarConversationScopeKey({
          browserConversationId: activeSession.id,
          browserViewScopeId: windowSessionId,
        })
      ] ?? null;
    const toSource = (
      tab: Extract<WorkbenchTabProjection, { kind: "browser" }>,
      leafId: string | null,
    ): ThreadSummaryPanelWorkbenchBrowserSource => ({
      browserTabId: requireWorkbenchBrowserTabProjectionId(tab),
      workbenchTabId: tab.id,
      tabTitle: tab.title,
      configTitle: readBrowserConfigTitle(tab),
      url: readBrowserConfigUrl(tab),
      faviconUrl: readBrowserConfigFavicon(tab),
      panelId: tab.panelId,
      leafId,
    });
    const durableBrowserTabs = activeSession.tabs.filter(
      (tab): tab is Extract<WorkbenchTabProjection, { kind: "browser" }> => tab.kind === "browser",
    );
    const browserPreviewTabs = Object.entries(previewTabsByPanel)
      .filter(([, tab]) => tab.sessionId === activeSession.id && tab.kind === "browser")
      .map(([key, tab]) =>
        toSource(
          tab as Extract<WorkbenchTabProjection, { kind: "browser" }>,
          resolveWorkbenchPanelSlotLeafId(key, activeSession.id, tab.panelId),
        ),
      );
    const scopedRuntimeTabs = browserRuntime.browserUseState.tabs.filter(
      (tab) =>
        tab.browserConversationId === activeSession.id &&
        tab.browserViewScopeId === windowSessionId,
    );
    const scopedSnapshots = browserRuntime.state.tabs.filter(
      (tab) =>
        tab.browserConversationId === activeSession.id &&
        tab.browserViewScopeId === windowSessionId,
    );
    return buildThreadSummaryPanelBrowserRows({
      rightTabs: durableBrowserTabs
        .filter((tab) => tab.panelId === "right")
        .map((tab) => toSource(tab, resolveLeafIdForPanelTab(activeSession, tab.panelId, tab.id))),
      bottomTabs: durableBrowserTabs
        .filter((tab) => tab.panelId === "bottom")
        .map((tab) => toSource(tab, resolveLeafIdForPanelTab(activeSession, tab.panelId, tab.id))),
      pendingTabs: browserPreviewTabs,
      runtimeTabs: scopedRuntimeTabs,
      snapshots: scopedSnapshots,
      activeBrowserUseTabId,
    });
  }, [activeSession, browserRuntime, previewTabsByPanel, windowSessionId]);
  const clockAutomation = useMemo<ThreadSummaryPanelAutomationRow | null>(
    () =>
      buildThreadSummaryPanelAutomationRow({
        automations: clockAutomations,
        sessionId: activeSession?.id ?? null,
      }),
    [activeSession?.id, clockAutomations],
  );
  // PiP activity and visibility use the execution root for both Runtime and native Sessions.
  const pip = useRemoteHostedPipSummaryControl(conversationThreadId);
  const onOpenSideChatRow = useCallback<
    NonNullable<ThreadStageActions["onOpenSummarySideChatRow"]>
  >(
    async ({ rowId, panelId, leafId }) => {
      if (!activeSession) return;
      const sideChatSessionId = runtimeSideChatSessionIdFromTabId(rowId);
      if (sideChatSessionId) {
        await commands.openSessionSideChat(sideChatSessionId);
        return;
      }
      if (!panelId) return;
      await commands.setPanelCollapsed(panelId, false);
      await commands.selectPanelTab(panelId, rowId, leafId ?? undefined);
    },
    [activeSession, commands],
  );
  const onOpenBrowserRow = useCallback<NonNullable<ThreadStageActions["onOpenSummaryBrowserRow"]>>(
    async ({ browserTabId }) => {
      if (!activeSession) return;
      await commands.presentBrowserTab(browserTabId);
    },
    [activeSession, commands],
  );
  const onOpenAutomation = useCallback<NonNullable<ThreadStageActions["onOpenSummaryAutomation"]>>(
    (input) => {
      if (input.mode === "suggested-create" || input.mode === "suggested-update") {
        void commands.openAutomationSidePanel(input);
        return;
      }
      if (!input.automationId) return;
      commands.openAutomations(
        buildAutomationsPath({
          automationId: input.automationId,
        }),
      );
    },
    [commands],
  );
  const onOpenProcessManager = useCallback(() => {
    commands.openProcessManager();
  }, [commands]);
  const onOpenBackgroundTerminalOutput = useCallback<
    NonNullable<ThreadStageActions["onOpenBackgroundTerminalOutput"]>
  >(
    async (row) => {
      if (!conversationThreadId) return;
      await commands.openProcessOutput(
        buildProcessOutputTargetFromSummaryRow(conversationThreadId, row),
      );
    },
    [conversationThreadId, commands],
  );
  const headerActions = useMemo<WorkbenchThreadSummaryModel["headerActions"]>(
    () => ({
      onOpenSummaryAutomation: onOpenAutomation,
    }),
    [onOpenAutomation],
  );

  return {
    mounted,
    open,
    hideImmediately: layoutMode === "overlay" && popoverOpen,
    contentShift,
    mode,
    popoverOpen,
    setPopoverOpen,
    sideChatRows,
    onLoadMoreSideChats: moreSideChats ? loadMoreSideChats : null,
    browserRows,
    clockAutomation,
    summaryComputerUsePip: pip.summaryComputerUsePip,
    onToggleSummaryComputerUsePip: pip.onToggleSummaryComputerUsePip,
    onOpenSideChatRow,
    onOpenBrowserRow,
    onOpenAutomation,
    onOpenProcessManager,
    onOpenBackgroundTerminalOutput,
    headerActions,
  };
}
