import { act, waitFor } from "@testing-library/react";
import { renderWithAppMaitai as render } from "@/test/app-maitai";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { CommandPaletteThread } from "@/lib/command-palette";
import type {
  CommandPaletteShellCommandContext,
  CommandPaletteShellCommandHandlers,
} from "@/lib/command-palette-commands";
import {
  applyRendererThemeForTest,
  installRendererThemeFixture,
  readRendererThemeColor,
} from "@/test/renderer-theme";
import { CommandPalette } from "./command-palette";
import "@/globals.css";

// Keep the real dialog, command catalog, search projection, and keyboard owner.
// The desktop chat transport supplies deterministic content for this browser boundary.
const fixture = vi.hoisted(() => ({
  threads: Array.from({ length: 30 }, (_, index): CommandPaletteThread => ({
    kind: "thread",
    id: `thread-${index}`,
    threadId: `thread-${index}`,
    sessionId: null,
    projectId: null,
    projectName: null,
    title: `Review command search ${index}`,
    preview: "",
    cwd: null,
    gitBranch: null,
    projectless: true,
    pinned: false,
    pinnedOrder: null,
    statusType: "idle",
    statusActiveFlags: [],
    createdAt: 1,
    updatedAt: index + 1,
    inActiveProject: false,
  })),
}));

vi.mock("@/lib/command-palette-chat-search", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/command-palette-chat-search")>()),
  useCommandPaletteThreadItems: () => ({ threads: fixture.threads, loading: false }),
  useCommandPaletteThreadSearch: ({ query }: { query: string }) => ({
    query,
    results: [],
    loading: false,
    error: null,
  }),
}));

installRendererThemeFixture();
afterEach(async () => page.viewport(1280, 800));

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

function PaletteFixture() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div
        role="textbox"
        aria-label="Draft editor"
        contentEditable
        suppressContentEditableWarning
        onKeyDown={(event) => {
          if (!event.ctrlKey || event.key !== "k") return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        <span>First paragraph</span>
        <br />
        <span>Second paragraph</span>
      </div>
      <button type="button" onClick={() => setOpen(true)}>
        Open command menu
      </button>
      <CommandPalette
        open={open}
        openTriggerTick={0}
        projects={[]}
        activeProjectId={null}
        recentPageSessions={[]}
        commandContext={commandContext}
        commandHandlers={commandHandlers}
        onOpenChange={setOpen}
        onOpenPage={ignore}
        onOpenThread={ignore}
      />
    </>
  );
}

function pixels(color: string): readonly number[] {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Expected Chromium canvas color resolution");
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  return Array.from(context.getImageData(0, 0, 1, 1).data);
}

function paletteSurface(dialog: HTMLElement): HTMLElement {
  const surface = dialog.querySelector<HTMLElement>("[data-command-palette-surface]");
  if (!surface) throw new Error("Expected the command menu surface");
  return surface;
}

async function openPalette() {
  const view = render(<PaletteFixture />);
  const trigger = view.getByRole("button", { name: "Open command menu" });
  await act(async () => userEvent.click(trigger));
  const dialog = await view.findByRole("dialog", { name: "Command palette" });
  const input = view.getByRole("combobox", { name: "Command palette search" });
  if (!(input instanceof HTMLInputElement)) throw new Error("Expected the palette search input");
  await waitFor(() => expect(document.activeElement).toBe(input));
  return { view, dialog, input, trigger, surface: paletteSurface(dialog) };
}

test.each(["light", "dark"] as const)(
  "keeps the %s glass surface stable while query and scope change",
  async (theme) => {
    await page.viewport(1280, 800);
    applyRendererThemeForTest(theme);
    const { view, dialog, input, surface } = await openPalette();
    const style = getComputedStyle(surface);
    const fill = pixels(style.backgroundColor);
    const pigment = pixels(readRendererThemeColor("--color-surface"));
    expect(CSS.supports("backdrop-filter", "blur(1px)")).toBe(true);
    expect(style.backdropFilter).toMatch(/blur\([1-9][\d.]*px\)/);
    expect(fill[3]).toBeGreaterThan(0);
    expect(fill[3]).toBeLessThan(255);
    for (const channel of [0, 1, 2]) {
      expect(Math.abs(fill[channel]! - pigment[channel]!)).toBeLessThanOrEqual(2);
    }
    // A transparent ancestor is required for the root's backdrop to sample the app.
    expect(pixels(getComputedStyle(dialog).backgroundColor)[3]).toBe(0);

    const bounds = surface.getBoundingClientRect();
    await act(async () => userEvent.type(input, "review"));
    await waitFor(() => expect(input.value).toBe("review"));
    expect(surface.getBoundingClientRect().height).toBe(bounds.height);

    await act(async () => userEvent.keyboard("{Tab}"));
    await waitFor(() => expect(input.placeholder).toBe("Search actions"));
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("review");
    expect(surface.getBoundingClientRect().height).toBe(bounds.height);
    expect(surface.getBoundingClientRect().top).toBe(bounds.top);

    await act(async () => userEvent.keyboard("{Shift>}{Tab}{/Shift}"));
    await waitFor(() => expect(input.placeholder).toBe("Search Nodex"));
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("review");

    await act(async () => {
      input.select();
      await userEvent.keyboard("unfindable-result");
    });
    await waitFor(() => expect(view.queryAllByRole("option")).toHaveLength(0));
    expect(surface.getBoundingClientRect().height).toBe(bounds.height);
  },
);

test("keeps consecutive scope navigation in the tablist until F6 returns to search", async () => {
  const { view, input } = await openPalette();
  await act(async () => {
    await userEvent.type(input, "review");
    await userEvent.keyboard("{F6}");
  });
  expect(document.activeElement).toBe(view.getByRole("tab", { name: "All" }));

  for (const scope of ["Actions", "Chats"]) {
    await act(async () => userEvent.keyboard("{ArrowRight}"));
    const tab = view.getByRole("tab", { name: scope });
    await waitFor(() => expect(tab.getAttribute("aria-selected")).toBe("true"));
    expect(document.activeElement).toBe(tab);
    expect(input.value).toBe("review");
  }

  await act(async () => userEvent.keyboard("{F6}"));
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(input.placeholder).toBe("Search chats");
  expect(input.value).toBe("review");
});

test("captures the live editor selection at the open edge and restores it after Escape", async () => {
  const view = render(<PaletteFixture />);
  const editor = view.getByRole("textbox", { name: "Draft editor" });
  const first = editor.firstElementChild?.firstChild;
  const last = editor.lastElementChild?.firstChild;
  const selection = document.getSelection();
  if (!first || !last || !selection) throw new Error("Expected a selectable editor fixture");
  await act(async () => {
    editor.focus();
    selection.setBaseAndExtent(last, 6, first, 2);
    await userEvent.keyboard("{Control>}k{/Control}");
  });
  await view.findByRole("dialog", { name: "Command palette" });
  const search = view.getByRole("combobox", { name: "Command palette search" });
  await waitFor(() => expect(document.activeElement).toBe(search));
  await act(async () => {
    selection.removeAllRanges();
    await userEvent.keyboard("{Escape}");
  });
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(editor);
  expect(selection.anchorNode).toBe(last);
  expect(selection.anchorOffset).toBe(6);
  expect(selection.focusNode).toBe(first);
  expect(selection.focusOffset).toBe(2);
});

test("contains long results in a small viewport and returns focus after dismissal", async () => {
  await page.viewport(390, 360);
  const { view, input, trigger, surface } = await openPalette();
  await act(async () => {
    await userEvent.keyboard("{Tab}{Tab}");
  });
  await waitFor(() => expect(input.placeholder).toBe("Search chats"));
  const list = view.getByRole("listbox");
  await waitFor(() => expect(list.scrollHeight).toBeGreaterThan(list.clientHeight));
  const bounds = surface.getBoundingClientRect();
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
  expect(list.getBoundingClientRect().bottom).toBeLessThanOrEqual(bounds.bottom);
  expect(surface.scrollWidth).toBeLessThanOrEqual(surface.clientWidth);

  await act(async () => userEvent.keyboard("{End}"));
  await waitFor(() => expect(list.scrollTop).toBeGreaterThan(0));
  expect(document.activeElement).toBe(input);
  await act(async () => userEvent.keyboard("{Escape}"));
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test("Theme drill-in clears search, dismisses one level, and applies the shared appearance preference", async () => {
  const { view, input } = await openPalette();
  await act(async () => userEvent.type(input, "theme"));
  await act(async () => userEvent.click(view.getByRole("option", { name: /^Theme /u })));
  await waitFor(() => expect(input.placeholder).toBe("Search themes"));
  expect(input.value).toBe("");
  expect(view.queryByRole("tablist")).toBeNull();
  expect(
    view.getByRole("button", { name: "Back to command menu" }).getBoundingClientRect().top,
  ).toBeGreaterThanOrEqual(input.getBoundingClientRect().bottom);
  expect(view.getByRole("group", { name: "Color themes" })).toBeTruthy();
  await act(async () => userEvent.keyboard("{Escape}"));
  await waitFor(() => expect(view.getByRole("tab", { name: "All" })).toBeTruthy());
  expect(view.getByRole("dialog")).toBeTruthy();
  expect(document.activeElement).toBe(input);
  await act(async () => userEvent.type(input, "theme"));
  await act(async () => userEvent.click(view.getByRole("option", { name: /^Theme /u })));
  await act(async () =>
    userEvent.click(view.getByRole("option", { name: /^Switch to (light|dark) theme$/u })),
  );
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
});

test("fits the physical viewport under window zoom and keeps its search controls visible", async () => {
  await page.viewport(560, 480);
  document.documentElement.style.setProperty("--codex-window-zoom", "1.25");
  document.body.style.zoom = "1.25";
  document.body.style.width = "calc(100vw / 1.25)";
  try {
    const { view, surface, input } = await openPalette();
    await act(async () => userEvent.click(view.getByRole("tab", { name: "Text" })));
    const bounds = surface.getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(input.getBoundingClientRect().bottom).toBeLessThan(bounds.bottom);
    expect(
      view.getByRole("button", { name: "Search folder" }).getBoundingClientRect().bottom,
    ).toBeLessThan(bounds.bottom);
  } finally {
    document.documentElement.style.removeProperty("--codex-window-zoom");
    document.body.style.removeProperty("zoom");
    document.body.style.removeProperty("width");
  }
});

test("reopens with the last broad query selected for replacement", async () => {
  const { view, input, trigger } = await openPalette();
  await act(async () => userEvent.type(input, "review"));
  await act(async () => userEvent.keyboard("{Escape}"));
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  await act(async () => userEvent.click(trigger));
  const reopened = view.getByRole("combobox", {
    name: "Command palette search",
  }) as HTMLInputElement;
  await waitFor(() => expect(reopened.value).toBe("review"));
  await waitFor(() => expect([reopened.selectionStart, reopened.selectionEnd]).toEqual([0, 6]));
});
