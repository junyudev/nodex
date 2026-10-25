import { act, fireEvent, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
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
    workspaceScope,
    onWorkspaceScopeChange,
  }: {
    workspaceScope: FileSearchScope | null;
    onWorkspaceScopeChange: (scope: FileSearchScope) => void;
  }) => (
    <>
      <output aria-label="Search scope">{JSON.stringify(workspaceScope)}</output>
      <button onClick={() => onWorkspaceScopeChange(chosenScope)}>Choose search folder</button>
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
  toggleFileTreePanel: ignore,
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
  },
  canOpenSessionInNewWindow: true,
};

test.each([
  { label: "Project context", scope: { hostId: "local", roots: ["/project", "/second"] } },
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
  },
);
