import { settingsSearchIndex } from "./workbench-settings-search-catalog";
import { FormattedMessage, useIntl } from "@/lib/i18n";
import { createCommandKeymapState } from "../../../shared/command-keybindings";
import { displaySkillDirectory } from "@/features/skills/skill-presentation";
import type { SkillInventoryEntry } from "../../../shared/skill-inventory";
import type { FileSearchScope, FileSearchMatch } from "../../../shared/file-search";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  NodexDialog as Dialog,
  NodexDialogContent as DialogContent,
  NodexDialogTitle as DialogTitle,
} from "@/components/ui/dialog";
import { flushSync } from "react-dom";
import {
  captureCommandPaletteFocus,
  readCommandPaletteSelectionQuery,
  type CommandPaletteFocusSnapshot,
} from "@/lib/command-palette-focus";
import type { WorkspaceTextSearchMatch } from "../../../shared/workspace-text-search";
import {
  type CommandMenuMode,
  type CommandPaletteCommand,
  type CommandPalettePage,
  type CommandPaletteChat,
  type CommandPaletteFile,
  type CommandPaletteText,
} from "@/lib/command-palette";
import {
  buildCommandPaletteCommands,
  executeCommandPaletteShellCommand,
  isCommandPaletteShellCommandId,
  type CommandPaletteShellCommandContext,
  type CommandPaletteShellCommandHandlers,
} from "@/lib/command-palette-commands";
import { configureInteractivePageSearch } from "@/lib/interactive-page-search";
import type { SpaceSwitchCommands } from "@/features/spaces/space-switching";
import type { Project } from "@/lib/types";
import type { RecentPageSession } from "@/lib/use-workbench-profile-preferences";
import { useCommandPaletteTheme } from "./command-palette-theme";
import { CommandPaletteSurface, type CommandPaletteSurfaceHandle } from "./command-palette-surface";

import {
  resolveSettingsCommandTarget,
  resolveVisibleSettingsSections,
  settingsCommandId,
  type SettingsSectionId,
} from "./workbench-settings-sections";

interface CommandPaletteProps {
  skillResults?: readonly SkillInventoryEntry[];
  onOpenSkill?: (skillId: string) => void;
  fileSearchScope?: FileSearchScope | null;
  onOpenFile?: (file: FileSearchMatch, hostId: string) => void;
  onOpenTextMatch?: (match: WorkspaceTextSearchMatch, hostId: string) => void;
  priorityFolders?: readonly string[];
  onOpenSettingsSection?: (section: SettingsSectionId, anchor?: string) => void;
  open: boolean;
  openTriggerTick: number;
  initialMode?: CommandMenuMode;
  initialQuery?: string;
  projects: readonly Project[];
  activeProjectId: string | null;
  recentPageSessions: readonly RecentPageSession[];
  commandContext: Omit<CommandPaletteShellCommandContext, "isMac">;
  commandHandlers: CommandPaletteShellCommandHandlers;
  /** Opens each Space other than this window's. */
  spaceCommands?: SpaceSwitchCommands;
  onOpenChange: (open: boolean) => void;
  onOpenPage: (
    projectId: string | null,
    pageId: string,
    titleSnapshot?: string,
    reveal?: import("@/lib/page-search-reveal").PageSearchReveal,
  ) => void;
  onOpenChat: (
    sessionId: string,
    reveal?: import("@/lib/chat-search-reveal").ChatSearchReveal,
  ) => void;
}

type PaletteItem =
  | CommandPaletteCommand
  | CommandPalettePage
  | CommandPaletteChat
  | CommandPaletteFile
  | CommandPaletteText;

function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");
}

export function CommandPalette({
  open,
  openTriggerTick,
  initialMode = "root",
  initialQuery,
  projects,
  activeProjectId,
  recentPageSessions,
  commandContext,
  commandHandlers,
  skillResults,
  onOpenSkill,
  spaceCommands,
  onOpenChange,
  onOpenPage,
  onOpenChat,
  fileSearchScope = null,
  onOpenFile,
  onOpenTextMatch,
  priorityFolders,
  onOpenSettingsSection,
}: CommandPaletteProps) {
  const intl = useIntl();
  const isMac = isMacPlatform();
  const theme = useCommandPaletteTheme();
  const [mode, setMode] = useState<CommandMenuMode>(initialMode);
  const contextScopeKey = JSON.stringify([fileSearchScope?.hostId, fileSearchScope?.roots]);
  const [workspaceSelection, setWorkspaceSelection] = useState<{
    open: boolean;
    initialMode: CommandMenuMode;
    openTriggerTick: number;
    override: { contextKey: string; scope: FileSearchScope } | null;
  }>({ open, initialMode, openTriggerTick, override: null });
  if (
    workspaceSelection.open !== open ||
    workspaceSelection.initialMode !== initialMode ||
    workspaceSelection.openTriggerTick !== openTriggerTick
  ) {
    if (open) setMode(initialMode);
    setWorkspaceSelection({
      open,
      initialMode,
      openTriggerTick,
      override: open && initialMode !== "text" ? null : workspaceSelection.override,
    });
  }
  const scopeOverride = workspaceSelection.override;
  const workspaceSelectionForContext =
    scopeOverride?.contextKey === contextScopeKey
      ? { kind: "directory" as const, scope: scopeOverride.scope }
      : { kind: "context" as const };
  const surfaceRef = useRef<CommandPaletteSurfaceHandle>(null);
  const focusSnapshot = useRef<CommandPaletteFocusSnapshot | null>(null);
  const lastQuery = useRef("");
  const [openingQuery, setOpeningQuery] = useState(initialQuery ?? "");
  const openingRequestRef = useRef<{ tick: number; query: string | undefined } | null>(null);
  useLayoutEffect(() => {
    if (open) {
      if (focusSnapshot.current === null) {
        focusSnapshot.current = captureCommandPaletteFocus();
      }
      if (
        openingRequestRef.current?.tick === openTriggerTick &&
        openingRequestRef.current.query === initialQuery
      )
        return;
      openingRequestRef.current = { tick: openTriggerTick, query: initialQuery };
      setOpeningQuery(initialQuery ?? readCommandPaletteSelectionQuery() ?? lastQuery.current);
      return;
    }
    openingRequestRef.current = null;
    focusSnapshot.current?.restore();
    focusSnapshot.current = null;
  }, [open, initialQuery, openTriggerTick]);
  const close = () => {
    const snapshot = focusSnapshot.current;
    focusSnapshot.current = null;
    flushSync(() => onOpenChange(false));
    snapshot?.restore();
  };
  const recentPageIds = [...new Set(recentPageSessions.map((session) => session.pageId))];
  useEffect(() => configureInteractivePageSearch(), []);
  const commandKeymapState =
    commandContext.commandKeymapState ?? createCommandKeymapState({}, isMac ? "macOS" : "windows");
  const commands = [
    ...buildCommandPaletteCommands({ ...commandContext, commandKeymapState, isMac }, intl),
    ...(onOpenSettingsSection
      ? resolveVisibleSettingsSections()
          .filter((section) => !section.disabled)
          .map((section): CommandPaletteCommand => ({
            kind: "command",
            id: settingsCommandId(section.id),
            title: intl.formatMessage(section.labelMessage),
            subtitle: "",
            keywords: [
              "settings",
              String(section.labelMessage.defaultMessage),
              ...section.searchMessages,
              ...settingsSearchIndex(section.id, intl).keys(),
            ],
            group: "Settings",
            priority: 700,
          }))
      : []),
    ...(skillResults ?? []).map((skill): CommandPaletteCommand => ({
      kind: "command",
      id: `skill:${skill.id}`,
      title: skill.name,
      subtitle: displaySkillDirectory(skill.directory),
      keywords: ["skills"],
      description: skill.description,
      group: "Skills",
      priority: 100,
    })),
    ...(spaceCommands?.commands ?? []),
  ];

  const handleChangeMode = (nextMode: CommandMenuMode) => {
    setMode(nextMode);
  };

  const handleExecute = (item: PaletteItem, query: string) => {
    if (item.kind === "file") {
      onOpenFile?.(item.file, item.hostId);
      return;
    }
    if (item.kind === "text") {
      if (!item.disabled) onOpenTextMatch?.(item.match, item.hostId);
      return;
    }
    if (item.kind === "page") {
      const args = [item.projectId, item.page.id, item.page.title] as const;
      if (item.reveal) onOpenPage(...args, item.reveal);
      else onOpenPage(...args);
      return;
    }
    if (item.kind === "chat") {
      if (item.reveal) onOpenChat(item.chat.sessionId, item.reveal);
      else onOpenChat(item.chat.sessionId);
      return;
    }
    if (item.disabled) return;
    if (item.id.startsWith("skill:")) {
      onOpenSkill?.(item.id.slice("skill:".length));
      return;
    }
    if (spaceCommands?.execute(item.id)) return;
    if (item.id.startsWith("settings:")) {
      const target = resolveSettingsCommandTarget(item.id, query);
      if (target) onOpenSettingsSection?.(target.sectionId, target.anchor);
      return;
    }
    if (!isCommandPaletteShellCommandId(item.id)) return;
    executeCommandPaletteShellCommand(item.id, commandHandlers);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen, details) => {
        if (!nextOpen && details.reason === "escape" && surfaceRef.current?.isComposing()) {
          details.cancel();
          return;
        }
        if (!nextOpen && surfaceRef.current?.dismissNested()) {
          details.cancel();
          return;
        }
        if (nextOpen) onOpenChange(true);
        else close();
      }}
    >
      <DialogContent
        unstyledContent
        showCloseButton={false}
        overlayClassName="bg-black/[0.1333]"
        initialFocus={false}
        finalFocus={false}
        className="command-menu-dialog top-[max(calc(16px/var(--codex-window-zoom,1)),calc((100vh/var(--codex-window-zoom,1)-var(--command-menu-height))/2))] w-[min(768px,calc(92vw/var(--codex-window-zoom,1)))] max-w-none translate-y-0 border-none bg-transparent p-0 shadow-none [--command-menu-height:calc(min(440px,max(120px,90vh/var(--codex-window-zoom,1)-64px))+64px)]"
      >
        <DialogTitle className="sr-only">
          <FormattedMessage
            id="workbench.commandPalette.title"
            defaultMessage={"Command palette"}
          />
        </DialogTitle>
        <CommandPaletteSurface
          ref={surfaceRef}
          open={open}
          openTriggerTick={openTriggerTick}
          mode={mode}
          initialQuery={openingQuery}
          onQueryChange={(query) => {
            lastQuery.current = query;
          }}
          fileSearchScope={fileSearchScope}
          workspaceSelection={workspaceSelectionForContext}
          onWorkspaceSelectionChange={(selection) =>
            setWorkspaceSelection((current) => ({
              ...current,
              override:
                selection.kind === "context"
                  ? null
                  : { contextKey: contextScopeKey, scope: selection.scope },
            }))
          }
          priorityFolders={priorityFolders}
          commands={[...commands, theme.parentCommand]}
          projects={projects}
          activeProjectId={activeProjectId}
          recentPageIds={recentPageIds}
          onChangeMode={handleChangeMode}
          onRequestClose={close}
          onExecute={handleExecute}
        />
      </DialogContent>
    </Dialog>
  );
}
