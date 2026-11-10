import { useOpenSkill } from "@/features/skills/open-skill";
import { useSkillInventory } from "@/features/skills/skill-inventory";
import { isRemoteSpace } from "@/lib/renderer-space";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import { useFirstRunEntry } from "@/features/first-run/first-run-state";
import { useFileReferenceRouter } from "@/lib/file-reference-router";
import { toast } from "@/components/ui/toast";
import {
  useSelectedConversationSkillsReloadControl,
  useSelectedWorkspaceSearchContext,
} from "@/lib/workbench-ui-scopes";
import { useEffect, useEffectEvent, useRef, type Dispatch, type SetStateAction } from "react";
import { flushSync } from "react-dom";
import { keyboardActionMayRun } from "@/lib/keyboard-action-runtime";
import { copySessionConversationMarkdown } from "@/lib/session-conversation-markdown";
import type { useWorkbenchPanelCommandRouter } from "@/lib/use-workbench-panel-command-router";
import type { useWorkbenchPanelOpeners } from "@/lib/use-workbench-panel-openers";
import type { useWorkbenchSessionCommands } from "@/lib/use-workbench-session-commands";
import type { WorkbenchSessionRenderProjection } from "@/lib/workbench-session-presentation";
import type { Project } from "@/lib/types";
import type { RecentPageSession } from "@/lib/use-workbench-profile-preferences";
import type { WorkbenchNavigationDirection } from "../../../shared/window-navigation";
import {
  CAPTURE_TO_INBOX_COMMAND_ID,
  TOGGLE_BOTTOM_PANEL_COMMAND_ID,
  TOGGLE_FULL_VIEW_COMMAND_ID,
  type WorkbenchCommandInvocation,
} from "../../../shared/workbench-commands";
import {
  createCommandKeymapState,
  matchesKeyboardEventToCommand,
  type CommandKeymapState,
} from "../../../shared/command-keybindings";
import type { CommandMenuMode } from "@/lib/command-palette";
import type {
  CommandPaletteShellCommandContext,
  CommandPaletteShellCommandHandlers,
} from "@/lib/command-palette-commands";
import { chatReminderPresetTime } from "@/lib/chat-reminder";
import type { useWorkbenchSidebarController } from "./use-workbench-sidebar-controller";
import { CommandPalette } from "./command-palette";
import {
  hasSessionConversation,
  resolveSessionExecution,
  resolveSessionMarkdownExport,
} from "@/lib/session-execution";

import type { SettingsSectionId } from "./workbench-settings-sections";
import { useWorkspaceFileActiveLineBlame } from "@/features/workspace-files/workspace-file-preferences";
import { useSpaceSwitchCommands } from "@/features/spaces/space-switching";

type ProjectSession = WorkbenchSessionRenderProjection;
type SessionCommands = Pick<
  ReturnType<typeof useWorkbenchSessionCommands>,
  "openProjectSessionById" | "requestContentSearchOpen" | "startNewChatInProject"
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
  | "archiveSession"
  | "openRenameSessionDialog"
  | "setSessionReminder"
  | "toggleSessionPin"
  | "toggleSessionUnread"
>;

interface WorkbenchCommandPaletteHostProps {
  readonly open: boolean;
  readonly openRequest: {
    readonly tick: number;
    readonly mode: CommandMenuMode;
    readonly initialQuery: string | undefined;
  };
  readonly projects: readonly Project[];
  readonly openProjectFolder: () => Promise<void>;
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
  readonly openInbox: () => void;
  /** Creates a Page where the current place's work lives, or null where there is none. */
  readonly newPage: (() => void) | null;
  readonly openLibraryFiles: () => void;
  readonly openProcessManager: () => void;
  readonly openSettings: () => void;
  readonly openSettingsSection?: (section: SettingsSectionId, anchor?: string) => void;
  readonly openKeyboardShortcuts: () => void;
  readonly onOpenSessionInNewWindow?: (session: ProjectSession) => Promise<void>;
}

export function WorkbenchCommandPaletteHost({
  open,
  openRequest,
  projects,
  openProjectFolder,
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
  openInbox,
  newPage,
  openLibraryFiles,
  openProcessManager,
  openSettings,
  openSettingsSection,
  openKeyboardShortcuts,
  onOpenSessionInNewWindow,
}: WorkbenchCommandPaletteHostProps) {
  const workspaceSearchContext = useSelectedWorkspaceSearchContext();
  const fileRouter = useFileReferenceRouter();
  const openSkill = useOpenSkill();
  const skillContext = {
    hostId: activeSession?.thread?.executionHostId ?? "local",
    projectId: activeSession ? activeSession.projectId : activeProjectId,
  };
  const searchSkills = !isRemoteSpace() && skillContext.hostId === "local";
  const inventory = useSkillInventory(skillContext, open && searchSkills);
  const skillResults =
    searchSkills && inventory.data?.status === "ok"
      ? inventory.data.value.locations.flatMap((location) => location.skills)
      : [];
  const skillsReloadControl = useSelectedConversationSkillsReloadControl();
  const { runSetupAgain } = useFirstRunEntry();
  const spaceCommands = useSpaceSwitchCommands();
  const openingFolder = useRef(false);
  const openFolder = async () => {
    if (openingFolder.current) return;
    openingFolder.current = true;
    await runWithCleanup(
      async () => {
        await openProjectFolder();
      },
      {
        onError: (cause) => {
          toast.danger(cause instanceof Error ? cause.message : "Couldn’t open folder");
        },
        cleanup: () => {
          openingFolder.current = false;
        },
      },
    );
  };
  const handleFolderShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (
      !keyboardActionMayRun(event, {
        runWithEditableFocus: true,
        runInsideLocalSurface: true,
        runInsideTerminal: false,
        allowRepeat: false,
      })
    )
      return;
    const keymap =
      commandKeymapState ??
      createCommandKeymapState(
        {},
        navigator.platform.toUpperCase().includes("MAC") ? "macOS" : "windows",
      );
    if (!matchesKeyboardEventToCommand(event, keymap, "openFolder")) return;
    event.preventDefault();
    flushSync(() => setOpen(false));
    void openFolder();
  });
  useEffect(() => {
    window.addEventListener("keydown", handleFolderShortcut);
    return () => window.removeEventListener("keydown", handleFolderShortcut);
  }, []);
  const panelCapabilities = panelCommands.resolveActivePanelCapabilities("right");
  const activeLineBlame = useWorkspaceFileActiveLineBlame();
  const commandContext: Omit<CommandPaletteShellCommandContext, "isMac"> = {
    canReloadSkills: skillsReloadControl !== null,
    canSearchFiles: true,
    canSearchText: true,
    canGoBack: canNavigateBack,
    canGoForward: canNavigateForward,
    canStartNewChat: true,
    canStartNewChatInProject: Boolean(activeProjectId),
    canCreatePage: newPage !== null,
    hasActiveSession: Boolean(activeSession),
    activeSessionPinned: activeSession?.pinned ?? false,
    activeSessionCanManage: activeSession?.canManage ?? true,
    activeSessionUnread: activeSession?.unread ?? false,
    activeSessionReminded: Boolean(activeSession?.remindAt),
    hasAttachedThread: hasSessionConversation(activeSession),
    canExportConversationMarkdown: activeSession
      ? resolveSessionMarkdownExport(resolveSessionExecution(activeSession)) !== null
      : false,
    panelActionAvailability: Object.fromEntries(
      Object.entries(panelCapabilities.actions).map(([kind, capability]) => [
        kind,
        capability.available,
      ]),
    ) as CommandPaletteShellCommandContext["panelActionAvailability"],
    canOpenSessionInNewWindow,
    commandKeymapState,
    gitBlameEnabled: activeLineBlame.enabled,
  };
  const remindThread = (presetId: Parameters<typeof chatReminderPresetTime>[0]) => {
    if (!activeSession) return;
    void sidebarCommands.setSessionReminder(
      activeSession,
      chatReminderPresetTime(presetId, new Date()),
    );
  };

  const commandHandlers: CommandPaletteShellCommandHandlers = {
    openFolder: () => {
      void openFolder();
    },
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
    captureToInbox: () => {
      executeWorkbenchCommand({
        commandId: CAPTURE_TO_INBOX_COMMAND_ID,
        source: "command_palette",
      });
    },
    newPage: () => newPage?.(),
    renameThread: () => {
      if (!activeSession) return;
      sidebarCommands.openRenameSessionDialog(activeSession);
    },
    archiveThread: () => {
      if (!activeSession) return;
      void sidebarCommands.archiveSession(activeSession);
    },
    copyConversationMarkdown: () => {
      if (!activeSession) return;
      void copySessionConversationMarkdown(activeSession, activeSession.displayTitle);
    },
    toggleThreadPin: () => {
      if (!activeSession) return;
      void sidebarCommands.toggleSessionPin(activeSession);
    },
    toggleThreadUnread: () => {
      if (!activeSession) return;
      void sidebarCommands.toggleSessionUnread(activeSession);
    },
    remindThreadInOneHour: () => remindThread("in-1-hour"),
    remindThreadInThreeHours: () => remindThread("in-3-hours"),
    remindThreadInTheMorning: () => remindThread("next-morning"),
    remindThreadNextWeek: () => remindThread("next-week"),
    clearThreadReminder: () => {
      if (!activeSession) return;
      void sidebarCommands.setSessionReminder(activeSession, null);
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
    toggleFullView: () => {
      executeWorkbenchCommand({
        commandId: TOGGLE_FULL_VIEW_COMMAND_ID,
        source: "command_palette",
      });
    },
    toggleGitBlame: activeLineBlame.toggle,
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
      if (!skillsReloadControl) return;
      void skillsReloadControl.reload().catch((error: unknown) => {
        toast.danger(error instanceof Error ? error.message : "Could not reload skills");
      });
    },
    manageTasks: openAutomations,
    openInbox,
    openLibraryFiles,
    openProcessManager,
    settings: openSettings,
    showKeyboardShortcuts: openKeyboardShortcuts,
    runSetupAgain: () => void runSetupAgain(),
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
      fileSearchScope={workspaceSearchContext}
      onOpenFile={(file, hostId) => {
        void fileRouter
          .open(
            { path: file.fsPath },
            {
              hostId,
              title: file.label,
              kind: file.kind,
              workspaceRoot: file.root,
              mode: "preview",
            },
          )
          .then((opened) => {
            if (!opened) toast.danger("Couldn’t open file");
          })
          .catch((cause: unknown) =>
            toast.danger(cause instanceof Error ? cause.message : "Couldn’t open file"),
          );
      }}
      onOpenTextMatch={(match, hostId) => {
        void fileRouter
          .open(
            { path: match.path, line: match.line, column: match.column },
            {
              hostId,
              workspaceRoot: match.root,
              mode: "preview",
            },
          )
          .then((opened) => {
            if (!opened) toast.danger("Couldn’t open file");
          })
          .catch((cause: unknown) =>
            toast.danger(cause instanceof Error ? cause.message : "Couldn’t open file"),
          );
      }}
      onOpenSettingsSection={openSettingsSection}
      skillResults={skillResults}
      onOpenSkill={(skillId) => {
        void openSkill({ ...skillContext, skillId, destination: "palette" }).then((opened) => {
          if (!opened) toast.danger("This skill is no longer here");
        });
      }}
      commandContext={commandContext}
      commandHandlers={commandHandlers}
      spaceCommands={spaceCommands}
      onOpenChange={setOpen}
      onOpenPage={(projectId, pageId, titleSnapshot) => {
        void panelOpeners.openPageTab(projectId, pageId, titleSnapshot);
      }}
      onOpenChat={(sessionId) => {
        void Promise.resolve(sessionCommands.openProjectSessionById(sessionId)).catch(
          (cause: unknown) => {
            toast.danger(cause instanceof Error ? cause.message : "Couldn’t open chat");
          },
        );
      }}
    />
  );
}
