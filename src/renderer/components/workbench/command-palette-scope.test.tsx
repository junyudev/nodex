import { act, fireEvent, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import {
  commandPaletteWorkspaceScope,
  type CommandPaletteWorkspaceSelection,
} from "@/lib/command-palette-workspace-selection";
import type { FileSearchScope } from "../../../shared/file-search";
import type { CommandMenuMode } from "@/lib/command-palette";
import type {
  CommandPaletteShellCommandContext,
  CommandPaletteShellCommandHandlers,
} from "@/lib/command-palette-commands";
import { renderWithAppMaitai as render } from "@/test/app-maitai";
import { CommandPalette } from "./command-palette";

const chosenScope = vi.hoisted(() => ({ hostId: "remote:chosen", roots: ["/chosen/folder"] }));
vi.mock("@/lib/command-palette-chat-search", () => ({
  useCommandPaletteThreadItems: () => ({ threads: [], loading: false }),
}));
vi.mock("@/lib/interactive-page-search", () => ({
  configureInteractivePageSearch: () => () => undefined,
}));
// Exercise dialog mount lifetime and its state owner; folder selection is the Surface's typed port.
vi.mock("./command-palette-surface", () => ({
  CommandPaletteSurface: ({
    fileSearchScope,
    workspaceSelection,
    onWorkspaceSelectionChange,
  }: {
    fileSearchScope: FileSearchScope | null;
    workspaceSelection: CommandPaletteWorkspaceSelection;
    onWorkspaceSelectionChange: (selection: CommandPaletteWorkspaceSelection) => void;
  }) => (
    <>
      <output aria-label="Search scope">
        {JSON.stringify(commandPaletteWorkspaceScope(workspaceSelection, fileSearchScope))}
      </output>
      <output aria-label="Search selection">{workspaceSelection.kind}</output>
      <button onClick={() => onWorkspaceSelectionChange({ kind: "directory", scope: chosenScope })}>
        Choose search folder
      </button>
      <button
        onClick={() =>
          fileSearchScope &&
          onWorkspaceSelectionChange({ kind: "directory", scope: fileSearchScope })
        }
      >
        Choose current directory
      </button>
      <button onClick={() => onWorkspaceSelectionChange({ kind: "context" })}>
        Use Project context
      </button>
    </>
  ),
}));

const ignore = () => undefined;
const commandHandlers: CommandPaletteShellCommandHandlers = {
  navigateBack: ignore,
  navigateForward: ignore,
  newThread: ignore,
  newThreadInProject: ignore,
  openFolder: ignore,
  createPage: ignore,
  renameThread: ignore,
  archiveThread: ignore,
  copyConversationMarkdown: ignore,
  toggleThreadPin: ignore,
  openThreadInNewWindow: ignore,
  toggleSidebar: ignore,
  toggleSidePanel: ignore,
  toggleBottomPanel: ignore,
  toggleFullView: ignore,
  toggleFileTreePanel: ignore,
  toggleGitBlame: ignore,
  openBrowserTab: ignore,
  openReviewTab: ignore,
  toggleTerminal: ignore,
  openDbViewTab: ignore,
  openSideChat: ignore,
  findInThread: ignore,
  forceReloadSkills: ignore,
  manageTasks: ignore,
  openInbox: ignore,
  openLibraryFiles: ignore,
  openProcessManager: ignore,
  settings: ignore,
  showKeyboardShortcuts: ignore,
};
const commandContext: Omit<CommandPaletteShellCommandContext, "isMac" | "showMockCommands"> = {
  canGoBack: true,
  canGoForward: true,
  canStartNewChat: true,
  canStartNewChatInProject: true,
  pageCreateUnavailableReason: null,
  hasActiveSession: true,
  activeSessionPinned: false,
  hasAttachedThread: true,
  canExportConversationMarkdown: true,
  panelActionAvailability: {
    db_view: true,
    page_stage: true,
    canvas_stage: true,
    terminal: true,
    browser: true,
    review: true,
    files: true,
    side_chat: true,
    new_page: true,
  },
  canOpenSessionInNewWindow: true,
};

test.each([
  { label: "Project context", scope: { hostId: "local", roots: ["/project", "/second"] } },
  { label: "single-root Project context", scope: { hostId: "local", roots: ["/project"] } },
  { label: "no Project context", scope: null },
])(
  "retains Text folder selection across close and isolates contexts with $label",
  async ({ scope }) => {
    const content = (
      open: boolean,
      mode: CommandMenuMode,
      tick: number,
      context: FileSearchScope | null = scope,
    ) => (
      <CommandPalette
        open={open}
        openTriggerTick={tick}
        initialMode={mode}
        fileSearchScope={context}
        projects={[]}
        activeProjectId={null}
        recentPageSessions={[]}
        commandContext={commandContext}
        commandHandlers={commandHandlers}
        onOpenChange={ignore}
        onOpenPage={ignore}
        onOpenThread={ignore}
      />
    );
    const view = render(content(true, "text", 1));
    const readScope = () => JSON.parse(view.getByLabelText("Search scope").textContent ?? "null");
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Choose search folder" }));
      await Promise.resolve();
    });
    expect(readScope()).toEqual(chosenScope);
    view.rerender(content(false, "text", 1));
    await waitFor(() => expect(view.queryByLabelText("Search scope")).toBeNull());
    view.rerender(content(true, "text", 2));
    await waitFor(() => expect(readScope()).toEqual(chosenScope));

    const otherContext = { hostId: "other-host", roots: ["/other-project"] };
    view.rerender(content(true, "text", 3, otherContext));
    await waitFor(() => expect(readScope()).toEqual(otherContext));
    view.rerender(content(true, "text", 4));
    await waitFor(() => expect(readScope()).toEqual(chosenScope));

    view.rerender(content(false, "text", 4));
    await waitFor(() => expect(view.queryByLabelText("Search scope")).toBeNull());
    view.rerender(content(true, "root", 5));
    await waitFor(() => expect(readScope()).toEqual(scope));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Choose search folder" }));
      await Promise.resolve();
    });
    expect(readScope()).toEqual(chosenScope);
    view.rerender(content(false, "root", 5));
    await waitFor(() => expect(view.queryByLabelText("Search scope")).toBeNull());
    view.rerender(content(true, "files", 6));
    await waitFor(() => expect(readScope()).toEqual(scope));
    if (!scope) return;
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Choose current directory" }));
      await Promise.resolve();
    });
    expect(readScope()).toEqual(scope);
    expect(view.getByLabelText("Search selection").textContent).toBe("directory");
    view.rerender(content(false, "files", 6));
    await waitFor(() => expect(view.queryByLabelText("Search scope")).toBeNull());
    view.rerender(content(true, "text", 7));
    await waitFor(() =>
      expect(view.getByLabelText("Search selection").textContent).toBe("directory"),
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Use Project context" }));
      await Promise.resolve();
    });
    expect(readScope()).toEqual(scope);
    expect(view.getByLabelText("Search selection").textContent).toBe("context");
    view.rerender(content(false, "text", 7));
    await waitFor(() => expect(view.queryByLabelText("Search scope")).toBeNull());
    view.rerender(content(true, "text", 8));
    await waitFor(() =>
      expect(view.getByLabelText("Search selection").textContent).toBe("context"),
    );
  },
);
