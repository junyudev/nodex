import { DEFAULT_CODEX_HOST_ID } from "../../../shared/codex-host";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { composerContextOperations } from "@/features/local-conversation/composer-context-operations";
import { codexComposerSkillsListQueryOptions } from "@/lib/query-options";
import { useSelectedWorkspaceSearchContext } from "@/lib/workbench-ui-scopes";
import type { Dispatch, SetStateAction } from "react";
import { copyConversationMarkdown } from "@/features/local-conversation/copy-conversation-markdown";
import type { useWorkbenchPanelCommandRouter } from "@/lib/use-workbench-panel-command-router";
import type { useWorkbenchPanelOpeners } from "@/lib/use-workbench-panel-openers";
import type { useWorkbenchSessionCommands } from "@/lib/use-workbench-session-commands";
import type { WorkbenchSessionRenderProjection } from "@/lib/workbench-session-presentation";
import type { Project } from "@/lib/types";
import type { RecentPageSession } from "@/lib/use-workbench-profile-preferences";
import type { WorkbenchNavigationDirection } from "../../../shared/window-navigation";
import {
  CREATE_PAGE_COMMAND_ID,
  TOGGLE_BOTTOM_PANEL_COMMAND_ID,
  type WorkbenchCommandInvocation,
} from "../../../shared/workbench-commands";
import type { CommandKeymapState } from "../../../shared/command-keybindings";
import type { CommandMenuMode } from "@/lib/command-palette";
import type {
  CommandPaletteShellCommandContext,
  CommandPaletteShellCommandHandlers,
} from "@/lib/command-palette-commands";
import type { useWorkbenchSidebarController } from "./use-workbench-sidebar-controller";
import { CommandPalette } from "./command-palette";
import { usePageCreateTargetResolution } from "@/lib/page-create-target-registry";
import { isCodexAgentBackendBinding } from "../../../shared/agent-backend";

type ProjectSession = WorkbenchSessionRenderProjection;
type SessionCommands = Pick<
  ReturnType<typeof useWorkbenchSessionCommands>,
  "openAttachedThreadSession" | "requestContentSearchOpen" | "startNewChatInProject"
>;
type PanelCommands = Pick<
  ReturnType<typeof useWorkbenchPanelCommandRouter>,
  "dispatchPanelAction" | "resolveActivePanelCapabilities"
>;
type PanelOpeners = Pick<
  ReturnType<typeof useWorkbenchPanelOpeners>,
  "openPageTab" | "openWorkspaceFileTab"
>;
type SidebarCommands = Pick<
  ReturnType<typeof useWorkbenchSidebarController>,
  "archiveSession" | "openRenameSessionDialog" | "toggleSessionPin"
>;

interface WorkbenchCommandPaletteHostProps {
  readonly open: boolean;
  readonly openRequest: {
    readonly tick: number;
    readonly mode: CommandMenuMode;
    readonly initialQuery: string;
  };
  readonly projects: readonly Project[];
  readonly activeProjectId: string | null;
  readonly activeSession: ProjectSession | null;
  readonly recentPageSessions: readonly RecentPageSession[];
  readonly canNavigateBack: boolean;
  readonly canNavigateForward: boolean;
  readonly canOpenSessionInNewWindow: boolean;
  readonly commandKeymapState?: CommandKeymapState | null;
  readonly sessionCommands: SessionCommands;
  readonly panelCommands: PanelCommands;
  readonly panelOpeners: PanelOpeners;
  readonly sidebarCommands: SidebarCommands;
  readonly setOpen: Dispatch<SetStateAction<boolean>>;
  readonly executeNavigation: (direction: WorkbenchNavigationDirection) => void;
  readonly executeWorkbenchCommand: (invocation: WorkbenchCommandInvocation) => void;
  readonly toggleSidebar: () => void;
  readonly toggleSidePanel: () => void;
  readonly openAutomations: () => void;
  readonly openLibraryFiles: () => void;
  readonly openProcessManager: () => void;
  readonly openSettings: () => void;
  readonly openKeyboardShortcuts: () => void;
  readonly onOpenSessionInNewWindow?: (session: ProjectSession) => Promise<void>;
}

export function WorkbenchCommandPaletteHost({
  open,
  openRequest,
  projects,
  activeProjectId,
  activeSession,
  recentPageSessions,
  canNavigateBack,
  canNavigateForward,
  canOpenSessionInNewWindow,
  commandKeymapState,
  sessionCommands,
  panelCommands,
  panelOpeners,
  sidebarCommands,
  setOpen,
  executeNavigation,
  executeWorkbenchCommand,
  toggleSidebar,
  toggleSidePanel,
  openAutomations,
  openLibraryFiles,
  openProcessManager,
  openSettings,
  openKeyboardShortcuts,
  onOpenSessionInNewWindow,
}: WorkbenchCommandPaletteHostProps) {
  const queryClient = useQueryClient();
  const workspaceSearchContext = useSelectedWorkspaceSearchContext();
  const pageCreateTargetResolution = usePageCreateTargetResolution(activeProjectId);
  const panelCapabilities = panelCommands.resolveActivePanelCapabilities("right");
  const commandContext: Omit<CommandPaletteShellCommandContext, "isMac" | "showMockCommands"> = {
    canReloadSkills: workspaceSearchContext !== null,
    canSearchFiles:
      workspaceSearchContext?.hostId === DEFAULT_CODEX_HOST_ID &&
      workspaceSearchContext.roots.length > 0,
    canGoBack: canNavigateBack,
    canGoForward: canNavigateForward,
    canStartNewChat: true,
    canStartNewChatInProject: Boolean(activeProjectId),
    pageCreateUnavailableReason:
      pageCreateTargetResolution.status === "unavailable"
        ? pageCreateTargetResolution.reason
        : null,
    hasActiveSession: Boolean(activeSession),
    activeSessionPinned: activeSession?.pinned ?? false,
    hasAttachedThread: Boolean(activeSession?.thread),
    canExportConversationMarkdown: activeSession?.thread
      ? isCodexAgentBackendBinding(activeSession.thread.backendBinding)
      : false,
    panelActionAvailability: Object.fromEntries(
      Object.entries(panelCapabilities.actions).map(([kind, capability]) => [
        kind,
        capability.available,
      ]),
    ) as CommandPaletteShellCommandContext["panelActionAvailability"],
    canOpenSessionInNewWindow,
    commandKeymapState,
  };
  const commandHandlers: CommandPaletteShellCommandHandlers = {
    navigateBack: () => {
      void executeNavigation("back");
    },
    navigateForward: () => {
      void executeNavigation("forward");
    },
    newThread: () => {
      void sessionCommands.startNewChatInProject(activeProjectId);
    },
    newThreadInProject: () => {
      void sessionCommands.startNewChatInProject(activeProjectId);
    },
    createPage: () => {
      executeWorkbenchCommand({
        commandId: CREATE_PAGE_COMMAND_ID,
        source: "command_palette",
      });
    },
    renameThread: () => {
      if (!activeSession) return;
      sidebarCommands.openRenameSessionDialog(activeSession);
    },
    archiveThread: () => {
      if (!activeSession) return;
      void sidebarCommands.archiveSession(activeSession);
    },
    copyConversationMarkdown: () => {
      if (
        !activeSession?.thread ||
        !isCodexAgentBackendBinding(activeSession.thread.backendBinding)
      )
        return;
      void copyConversationMarkdown({
        conversationId: activeSession.thread.threadId,
        executionHostId: activeSession.thread.executionHostId,
        parentConversationId: activeSession.thread.parentThreadId ?? null,
        title: activeSession.displayTitle,
      });
    },
    toggleThreadPin: () => {
      if (!activeSession) return;
      void sidebarCommands.toggleSessionPin(activeSession);
    },
    openThreadInNewWindow: () => {
      if (!activeSession) return;
      void onOpenSessionInNewWindow?.(activeSession);
    },
    toggleSidebar,
    toggleSidePanel,
    toggleBottomPanel: () => {
      executeWorkbenchCommand({
        commandId: TOGGLE_BOTTOM_PANEL_COMMAND_ID,
        source: "command_palette",
      });
    },
    toggleFileTreePanel: () => {
      void panelCommands.dispatchPanelAction("files", { panelId: "right" });
    },
    openBrowserTab: () => {
      void panelCommands.dispatchPanelAction("browser", { panelId: "right" });
    },
    openReviewTab: () => {
      void panelCommands.dispatchPanelAction("review", { panelId: "right" });
    },
    toggleTerminal: () => {
      void panelCommands.dispatchPanelAction("terminal", {
        panelId: "bottom",
        terminalBehavior: "focus_or_create",
      });
    },
    openDbViewTab: () => {
      void panelCommands.dispatchPanelAction("db_view", { panelId: "right" });
    },
    openSideChat: () => {
      void panelCommands.dispatchPanelAction("side_chat", { panelId: "right" });
    },
    findInThread: () => {
      setOpen(false);
      sessionCommands.requestContentSearchOpen("command_palette");
    },
    forceReloadSkills: () => {
      if (!workspaceSearchContext) return;
      const { hostId, skillRoots } = workspaceSearchContext;
      const options = codexComposerSkillsListQueryOptions(skillRoots, hostId);
      void composerContextOperations
        .reloadSkills(hostId, skillRoots)
        .then((skills) => queryClient.setQueryData(options.queryKey, skills))
        .catch((error: unknown) => {
          toast.danger(error instanceof Error ? error.message : "Could not reload skills");
        });
    },
    manageTasks: openAutomations,
    openLibraryFiles,
    openProcessManager,
    settings: openSettings,
    showKeyboardShortcuts: openKeyboardShortcuts,
  };

  return (
    <CommandPalette
      open={open}
      openTriggerTick={openRequest.tick}
      initialMode={openRequest.mode}
      initialQuery={openRequest.initialQuery}
      projects={projects}
      activeProjectId={activeProjectId}
      recentPageSessions={recentPageSessions}
      fileSearchScope={
        workspaceSearchContext?.hostId === DEFAULT_CODEX_HOST_ID ? workspaceSearchContext : null
      }
      onOpenFile={(file) => {
        void panelOpeners.openWorkspaceFileTab({
          path: file.fsPath,
          title: file.label,
          workspaceRoot: file.root,
          panelId: "right",
          mode: "preview",
        });
      }}
      commandContext={commandContext}
      commandHandlers={commandHandlers}
      onOpenChange={setOpen}
      onOpenPage={(projectId, pageId, titleSnapshot) => {
        void panelOpeners.openPageTab(projectId, pageId, titleSnapshot);
      }}
      onOpenThread={sessionCommands.openAttachedThreadSession}
    />
  );
}
