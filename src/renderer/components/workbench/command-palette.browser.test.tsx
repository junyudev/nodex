import { act, waitFor } from "@testing-library/react";
import { renderWithAppMaitai as render } from "@/test/app-maitai";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { FuzzyFileSearchSessionUpdateParams } from "@nodex/codex-app-server-protocol";
import type { FileSearchEvent, FileSearchScope } from "../../../shared/file-search";
import type {
  WorkspaceTextSearchEvent,
  WorkspaceTextSearchRequest,
} from "../../../shared/workspace-text-search";
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
import { installWindowApi } from "@/test/browser-globals";
import { clearPersistedAtomStoreForTests } from "@/lib/persisted-atom-store";
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
  },
  canOpenSessionInNewWindow: true,
};

function PaletteFixture({ fileSearchScope }: { readonly fileSearchScope?: FileSearchScope }) {
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
        fileSearchScope={fileSearchScope}
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

async function openPalette(fileSearchScope?: FileSearchScope) {
  const view = render(<PaletteFixture fileSearchScope={fileSearchScope} />);
  const trigger = view.getByRole("button", { name: "Open command menu" });
  await act(async () => userEvent.click(trigger));
  const dialog = await view.findByRole("dialog", { name: "Command palette" });
  const input = view.getByRole("combobox", { name: "Command palette search" });
  if (!(input instanceof HTMLInputElement)) throw new Error("Expected the palette search input");
  await waitFor(() => expect(document.activeElement).toBe(input));
  return { view, dialog, input, trigger, surface: paletteSurface(dialog) };
}

function installWorkspaceSearchTransport() {
  const originalBridge = Object.getOwnPropertyDescriptor(window, "api");
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const values = new Map<string, unknown>();
  const searches: WorkspaceTextSearchRequest[] = [];
  const fileSearches: FuzzyFileSearchSessionUpdateParams[] = [];
  let revision = 0;
  const emit = (channel: string, event: unknown) => {
    for (const listener of listeners.get(channel) ?? []) listener(event);
  };
  clearPersistedAtomStoreForTests();
  installWindowApi({
    invoke: async (channel: string, ...args: unknown[]) => {
      if (channel === "persisted-atom:sync-request")
        return { revision, values: Object.fromEntries(values) };
      if (channel === "persisted-atom:update") {
        const mutation = args[0] as { key: string; value: unknown; mutationId: string };
        values.set(mutation.key, mutation.value);
        const event = { ...mutation, revision: ++revision, originRendererId: "palette-layout" };
        emit("persisted-atom:updated", event);
        return event;
      }
      if (channel === "workspace-text-search:start") {
        searches.push(args[0] as WorkspaceTextSearchRequest);
        return;
      }
      if (channel === "file-search:update") {
        fileSearches.push(args[0] as FuzzyFileSearchSessionUpdateParams);
        return;
      }
      if (channel === "workspace-text-search:stop" || channel.startsWith("file-search:")) return;
      throw new Error(`Unsupported workspace search fixture request: ${channel}`);
    },
    on: (channel: string, listener: (event: unknown) => void) => {
      const subscribers = listeners.get(channel) ?? new Set();
      subscribers.add(listener);
      listeners.set(channel, subscribers);
      return () => subscribers.delete(listener);
    },
  });
  return {
    searches,
    fileSearches,
    emitText: (event: WorkspaceTextSearchEvent) => emit("workspace-text-search:event", event),
    emitFiles: (event: FileSearchEvent) => emit("file-search:event", event),
    restore: () => {
      clearPersistedAtomStoreForTests();
      if (originalBridge) Object.defineProperty(window, "api", originalBridge);
      else Reflect.deleteProperty(window, "api");
    },
  };
}

function expectColor(actual: string, expected: string) {
  const actualPixels = pixels(actual);
  const expectedPixels = pixels(expected);
  for (const channel of [0, 1, 2, 3])
    expect(
      Math.abs(actualPixels[channel]! - expectedPixels[channel]!),
      `${actual} must match ${expected}`,
    ).toBeLessThanOrEqual(2);
}

function expectThemeColor(actual: string, token: `--${string}`) {
  expectColor(actual, readRendererThemeColor(token));
}

function expectSecondaryColor(actual: string) {
  const customSecondary = getComputedStyle(document.documentElement)
    .getPropertyValue("--app-color-text-secondary")
    .trim();
  const expected = customSecondary
    ? readRendererThemeColor("--app-color-text-secondary")
    : `color-mix(in srgb, ${readRendererThemeColor("--app-color-text-foreground")} 65%, transparent)`;
  expectColor(actual, expected);
}

test.each(["light", "dark"] as const)(
  "keeps %s Files and Text controls on one desktop row with long folders and recalled masks",
  async (theme) => {
    await page.viewport(1280, 800);
    applyRendererThemeForTest(theme);
    const transport = installWorkspaceSearchTransport();
    const root = "/workspace/a-very-long-folder-name-that-exceeds-the-search-toolbar-label-budget";
    let view: Awaited<ReturnType<typeof openPalette>>["view"] | undefined;
    try {
      const opened = await openPalette({ hostId: "local", roots: [root] });
      view = opened.view;
      const { input, surface } = opened;
      const inputOffset = input.getBoundingClientRect().top - surface.getBoundingClientRect().top;
      expect(surface.getBoundingClientRect().width).toBeCloseTo(768, 0);
      const assertControlRow = () => {
        const surfaceRect = surface.getBoundingClientRect();
        const tabs = view!.getByRole("tablist", { name: "Search scope" }).getBoundingClientRect();
        const toolbar = view!.getByRole("toolbar", { name: "Search options" });
        const controls = toolbar.querySelectorAll<HTMLElement>("button, input");
        expect(controls.length).toBeGreaterThan(0);
        for (const control of controls) {
          const rect = control.getBoundingClientRect();
          expect(Math.abs(rect.top + rect.height / 2 - (tabs.top + tabs.height / 2))).toBeLessThan(
            1,
          );
          expect(rect.left).toBeGreaterThanOrEqual(surfaceRect.left);
          expect(rect.right).toBeLessThanOrEqual(surfaceRect.right);
          expect(rect.width).toBeGreaterThan(0);
        }
        expect(input.getBoundingClientRect().top - surfaceRect.top).toBeCloseTo(inputOffset, 0);
        expect(surface.scrollWidth).toBeLessThanOrEqual(surface.clientWidth);
        expect(toolbar.scrollWidth).toBeLessThanOrEqual(toolbar.clientWidth);
      };

      await act(async () => userEvent.click(view!.getByRole("tab", { name: "Files" })));
      assertControlRow();
      const filesFolder = view.getByRole("button", { name: "Search folder" });
      const label = view.getByText(`Folder: ${root.split("/").at(-1)}`);
      expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
      expectThemeColor(getComputedStyle(filesFolder).color, "--color-text-tertiary");

      const fileName =
        "needle-file-with-a-very-long-name-that-needs-ellipsis-and-keeps-the-directory-visible.ts";
      const directory =
        "deeply-nested-directory/another-long-directory/one-more-directory/project-source/nested-components";
      await act(async () => userEvent.type(input, "needle"));
      await waitFor(() => expect(transport.fileSearches.at(-1)?.query).toBe("needle"));
      const fileRequest = transport.fileSearches.at(-1)!;
      await act(async () => {
        transport.emitFiles({
          method: "fuzzyFileSearch/sessionUpdated",
          params: {
            ...fileRequest,
            files: [
              {
                root,
                path: `${directory}/${fileName}`,
                file_name: fileName,
                match_type: "file",
                score: 10,
                indices: null,
              },
            ],
          },
        });
        transport.emitFiles({
          method: "fuzzyFileSearch/sessionCompleted",
          params: { sessionId: fileRequest.sessionId },
        });
      });
      const fileRow = await view.findByRole("option", { name: new RegExp(fileName) });
      const directoryLabel = view.getByText(directory);
      const titleGroup = directoryLabel.previousElementSibling;
      const fileContent = directoryLabel.parentElement;
      const titleLabel = titleGroup?.querySelector("span");
      if (!(titleGroup instanceof HTMLElement) || !fileContent || !titleLabel)
        throw new Error("Expected the file result's filename and directory");
      const fileContentRect = fileContent.getBoundingClientRect();
      const titleRect = titleGroup.getBoundingClientRect();
      const directoryRect = directoryLabel.getBoundingClientRect();
      expect(titleRect.width).toBeGreaterThan(0);
      expect(titleRect.width).toBeLessThanOrEqual(fileContentRect.width * 0.6 + 1);
      expect(titleLabel.scrollWidth).toBeGreaterThan(titleLabel.clientWidth);
      expect(directoryLabel.scrollWidth).toBeGreaterThan(directoryLabel.clientWidth);
      expect(directoryRect.left).toBeGreaterThanOrEqual(titleRect.right);
      expect(directoryRect.width).toBeGreaterThan(0);
      expect(directoryRect.right).toBeLessThanOrEqual(fileContentRect.right + 1);
      expect(fileRow.scrollWidth).toBeLessThanOrEqual(fileRow.clientWidth);
      expectThemeColor(getComputedStyle(directoryLabel).color, "--color-text-tertiary");
      assertControlRow();
      await act(async () => userEvent.clear(input));

      await act(async () => userEvent.click(view!.getByRole("tab", { name: "Text" })));
      const mask = view.getByRole("textbox", { name: "File types" });
      assertControlRow();
      expectThemeColor(getComputedStyle(mask).borderTopColor, "--color-border-primary-outline");
      await act(async () => {
        await userEvent.type(mask, "*.ts");
        await userEvent.keyboard("{Enter}");
      });
      await view.findByRole("button", { name: "Previous file types" });
      assertControlRow();
      expect(document.activeElement).toBe(input);

      await act(async () => {
        await userEvent.clear(mask);
        await userEvent.type(mask, "*.tsx");
        await userEvent.keyboard("{Enter}");
      });
      const previousMasks = view.getByRole("button", { name: "Previous file types" });
      expectThemeColor(getComputedStyle(previousMasks).color, "--color-text-tertiary");
      await act(async () => userEvent.click(previousMasks));
      const savedMask = await view.findByRole("menuitem", { name: "*.ts" });
      await act(async () => userEvent.click(savedMask));
      await waitFor(() => expect((mask as HTMLInputElement).value).toBe("*.ts"));
      await waitFor(() => expect(document.activeElement).toBe(mask));
      assertControlRow();

      const folder = view.getByRole("button", { name: "Search folder" });
      expectThemeColor(getComputedStyle(folder).color, "--color-text-tertiary");
      await act(async () => userEvent.hover(folder));
      expectThemeColor(getComputedStyle(folder).color, "--color-text-tertiary");
      expectThemeColor(
        getComputedStyle(folder).backgroundColor,
        "--color-background-primary-ghost-hover",
      );
      await act(async () => userEvent.click(folder));
      const chooseFolder = await view.findByRole("menuitem", { name: "Choose folder" });
      await act(async () => userEvent.hover(chooseFolder));
      expectThemeColor(getComputedStyle(folder).color, "--color-text-tertiary");
      expectThemeColor(
        getComputedStyle(folder).backgroundColor,
        "--color-background-primary-ghost-hover",
      );
      await act(async () => userEvent.keyboard("{Escape}"));
      await waitFor(() => expect(view!.queryByRole("menu")).toBeNull());
      await act(async () => userEvent.click(view!.getByRole("tab", { name: "Files" })));
      assertControlRow();
      await act(async () => userEvent.click(view!.getByRole("tab", { name: "Text" })));
      assertControlRow();
      expect((view.getByRole("textbox", { name: "File types" }) as HTMLInputElement).value).toBe(
        "*.ts",
      );

      await act(async () => userEvent.type(input, "needle"));
      await waitFor(() => expect(transport.searches.at(-1)?.query).toBe("needle"));
      const request = transport.searches.at(-1)!;
      await act(async () => {
        transport.emitText({
          requestId: request.requestId,
          type: "match",
          match: {
            path: `${root}/result.ts`,
            root,
            relativePath: "result.ts",
            line: 7,
            column: 1,
            preview: "needle in source",
            matchRanges: [{ start: 0, end: 6 }],
          },
        });
        transport.emitText({ requestId: request.requestId, type: "done", limited: false });
      });
      const location = await view.findByText("result.ts");
      expectSecondaryColor(getComputedStyle(location).color);
      assertControlRow();

      // This leaves just over 700px of surface content, at the desktop layout boundary.
      await act(async () => page.viewport(770, 800));
      await waitFor(() => expect(surface.getBoundingClientRect().width).toBeCloseTo(708.4, 0));
      assertControlRow();

      await act(async () => page.viewport(560, 800));
      await waitFor(() => expect(surface.getBoundingClientRect().width).toBeCloseTo(515.2, 0));
      const narrowSurface = surface.getBoundingClientRect();
      const narrowToolbar = view.getByRole("toolbar", { name: "Search options" });
      const narrowControls = Array.from(
        narrowToolbar.querySelectorAll<HTMLElement>("button, input"),
        (control) => control.getBoundingClientRect(),
      );
      const narrowInput = input.getBoundingClientRect();
      expect(narrowSurface.left).toBeGreaterThanOrEqual(0);
      expect(narrowSurface.right).toBeLessThanOrEqual(560);
      expect(narrowInput.top - narrowSurface.top).toBeGreaterThan(inputOffset);
      for (const rect of narrowControls) {
        expect(rect.width).toBeGreaterThan(0);
        expect(rect.left).toBeGreaterThanOrEqual(narrowSurface.left);
        expect(rect.right).toBeLessThanOrEqual(narrowSurface.right);
        expect(rect.bottom).toBeLessThanOrEqual(narrowInput.top);
      }
      expect(surface.scrollWidth).toBeLessThanOrEqual(surface.clientWidth);
      expect(narrowToolbar.scrollWidth).toBeLessThanOrEqual(narrowToolbar.clientWidth);
      expect((view.getByRole("textbox", { name: "File types" }) as HTMLInputElement).value).toBe(
        "*.ts",
      );
      await act(async () => page.viewport(1280, 800));
      assertControlRow();
    } finally {
      await act(async () => view?.unmount());
      transport.restore();
    }
  },
);

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

test("Escape dismisses a hovered folder hint before the palette while search retains focus", async () => {
  const transport = installWorkspaceSearchTransport();
  let view: Awaited<ReturnType<typeof openPalette>>["view"] | undefined;
  try {
    const opened = await openPalette({ hostId: "local", roots: ["/workspace"] });
    view = opened.view;
    const { input, trigger } = opened;
    await act(async () => userEvent.click(view!.getByRole("tab", { name: "Files" })));
    await waitFor(() => expect(document.activeElement).toBe(input));
    const folder = view.getByRole("button", { name: "Search folder" });
    await act(async () => userEvent.hover(folder));
    await view.findByRole("tooltip", { name: "/workspace" });
    expect(document.activeElement).toBe(input);

    await act(async () => userEvent.keyboard("{Escape}"));
    await waitFor(() => expect(view!.queryByRole("tooltip")).toBeNull());
    expect(view.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    expect(document.activeElement).toBe(input);

    await act(async () => userEvent.keyboard("{Escape}"));
    await waitFor(() => expect(view!.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  } finally {
    view?.unmount();
    transport.restore();
  }
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
    expect(view.queryByRole("textbox", { name: "File types" })).toBeNull();
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
